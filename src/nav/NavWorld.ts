import * as THREE from 'three';
import {
  Detour,
  NavMeshQuery,
  QueryFilter,
  Raw,
  statusDetail,
  type NavMesh,
  type Obstacle,
  type OffMeshConnectionParams,
  type TileCache,
} from '@recast-navigation/core';
import type { Door, Level } from '../level/Level';
import type { NavAgent, NavAgentOptions } from './agent';
import { POLY_WALK } from './generate';
import type { NavSeed } from './geometry';
import { objectFootprint } from './dynamic';

/**
 * 한 레벨의 내비게이션 (Recast/Detour 타일 캐시). 만든 쪽: `buildNav(level)` (index.ts).
 *
 * - 좌표는 three.js 월드(m). 결과 벡터는 새로 만들어 돌려준다(`out`을 주면 거기에 쓴다).
 * - 끊긴 섬(벽·지붕·상자 위처럼 마커가 하나도 없는 조각)은 가지치기해서 질의에서 뺀다(플래그 0).
 * - 문(`DOOR_`)은 닫혀 있으면 상자 장애물이다. 문이 움직이면 그 타일만 다시 만든다(`update()`에서).
 * - 장애물 변경은 `update()`에서 반영한다. 고정 스텝마다 부르면 가장 빠르고, 안 불러도 질의할 때 50 ms에 한 번 스스로 부른다.
 */

export interface NavStats {
  level: string;
  /** 입력 삼각형·충돌체 */
  triangles: number;
  colliders: { trimesh: number; box: number; other: number; skipped: number };
  /** 굽는 영역 (m) */
  area: { min: [number, number, number]; max: [number, number, number] };
  cs: number;
  ch: number;
  tileSize: number;
  tiles: [number, number];
  layers: number;
  polys: number;
  islands: number;
  keptIslands: number;
  prunedPolys: number;
  /** 바이트: 타일 캐시 압축 층, 내비메시 타일 데이터, WASM 힙 증가, 굽기 워커 WASM 힙 (가장 큰 것) */
  bytes: { compressed: number; navMesh: number; heapGrowth: number; heap: number; workerHeap?: number };
  /** 층 굽기 워커 수 (0 = 메인 스레드) */
  workers: number;
  /** 자동 뛰어내리기 링크 수 */
  links: number;
  /** 넘기·오르기 링크 (nav/traverse.ts): 종류별 수, 살펴본 경계 표본·후보, 굽기 시간 (ms) */
  traverse?: { vault: number; mantle: number; manual: number; samples: number; candidates: number; pathChecks: number; ms: number; addMs?: number };
  /**
   * ms: 형상 읽기, 층 굽기 CPU 합(워커 합산)·벽시계, 워커 WASM 준비, 메시 만들기, 섬 표시·가지치기,
   * CPU 합계, 메인 스레드가 쓴 시간, 처음부터 끝까지 벽시계
   */
  timing: { geometry: number; rasterize: number; rasterizeWall: number; workerInit: number; mesh: number; prune: number; links: number; work: number; main: number; wall: number };
}

export interface NavRaycastHit {
  /** 중간에 걸을 수 없는 경계에 막혔는가 */
  hit: boolean;
  /** 0~1 (막힌 지점 비율, 안 막히면 1) */
  t: number;
  /** 막힌 지점(또는 끝점) */
  point: THREE.Vector3;
  /** 막힌 경계의 법선 (수평) */
  normal: THREE.Vector3;
}

/**
 * 넘기·오르기 링크 (nav/traverse.ts가 굽는다). 캐릭터가 경로에서 a → b(양방향이면 b → a도)를 만나면
 * 게임 쪽 이동 코드가 넘기·오르기 동작으로 곡선을 따라 넘는다 (traverseAt으로 찾는다)
 */
export interface TraverseLinkRec {
  id: number;
  kind: 'vault' | 'mantle';
  /** 양 끝 (내비 위 발 자리). 오르기는 a가 아래, b가 위 */
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** 장애물 윗면 높이 (월드 y) */
  top: number;
  /** a에서 장애물 가까운 면까지 수평 거리 (m) */
  faceA: number;
  /** 장애물 두께 (넘기). 오르기는 Infinity */
  depth: number;
  /** 손으로 놓은 링크 (NAVLINK_ 마커) */
  manual: boolean;
  /** 막혀서 쉬는 동안 (게임 시계, 초: 게임 쪽 이동 코드가 쓴다) */
  blockedUntil: number;
  /** 지금 넘는 캐릭터가 있다 (게임 시계까지) */
  busyUntil: number;
  /**
   * 이동 캡슐로 쓸어 보니 고정 충돌체에 막힌 링크 (NavWorld.killTraverse): 내비에서 끈다(오프메시 폴리곤 플래그 0, 길 찾기가 고르지 않는다).
   * 굽기 입력에 없는 충돌체(스크립트가 더한 충돌 상자 등)가 내릴 자리를 막으면 생긴다
   */
  dead?: boolean;
}

/** 오프메시 링크 영역: 넘기·오르기 (Detour 길 비용 배율) */
export const AREA_VAULT = 1;
export const AREA_MANTLE = 2;
/**
 * 넘기·오르기를 걷기보다 비싸게: 링크 길이(1~1.6 m) × 배율. 넘기 0.5~0.7초는 달리기 2.5~3 m쯤이라 둘러 가는 길이
 * 약 2.5 m(오르기 3.5 m) 넘게 길 때만 넘는다 (자리 고르기가 넘기를 남발하지 않게)
 */
export const VAULT_COST = 3;
export const MANTLE_COST = 4;

export interface NavPathOptions {
  /** 끝점에 못 가면 가장 가까운 곳까지의 경로 (기본 false: null) */
  partial?: boolean;
  /** 끝점 스냅 범위 (반 크기 m, 기본 TARGET_EXTENTS: 수평 3·수직 4) */
  endExtents?: { x: number; y: number; z: number };
}

/** 닫힘·열림을 따라가는 문 장애물 */
interface DoorTrack {
  door: Door;
  /** 닫힘 자리 상자 (월드, 문 축 기준) */
  center: THREE.Vector3;
  half: THREE.Vector3;
  yaw: number;
  /** 지금 장애물이 놓인 열림 값 (NaN = 없음) */
  at: number;
  obstacle: Obstacle | null;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
/** 출발점·에이전트 자리 스냅 (발밑 폴리곤) */
const DEFAULT_EXTENTS = { x: 1.5, y: 2.5, z: 1.5 };
/**
 * 목표 스냅 (findPath 끝점): 상자·턱·컨테이너 위에 선 사용자 캐릭터 자리도 옆 바닥으로 잡는다. 그 위는 가지친 섬이라
 * 걷기 필터로는 폴리곤이 없고, 둘레 바닥은 상자 반 폭 + 침식 0.22 m만큼 옆, 높이 차만큼 아래다 (2 m 상자: 1.2 m 옆·2 m 아래).
 * Detour 기본 반 크기는 1 m (recast-navigation-js defaultQueryHalfExtents)라 이런 자리를 못 잡았다.
 */
export const TARGET_EXTENTS = { x: 3, y: 4, z: 3 };
const smooth = (k: number) => k * k * (3 - 2 * k);

export class NavWorld {
  readonly query: NavMeshQuery;
  /** 길찾기 필터 (걷기 플래그만) */
  readonly filter: QueryFilter;
  /** 가지치기 전 전체 (섬 표시용) */
  private readonly anyFilter: QueryFilter;
  /** 장애물·문 변경으로 타일이 바뀔 때마다 오른다 (에이전트가 경로를 다시 찾는다) */
  version = 0;
  /** 등록된 에이전트 (서로 비키기, 디버그 표시) */
  readonly agents = new Set<NavAgent>();
  /** 폴리곤 참조 → 섬 번호 */
  private island = new Map<number, number>();
  /** 시드가 있는 섬 */
  private keptIslands = new Set<number>();
  private readonly doors: DoorTrack[] = [];
  private readonly obstacles = new Set<Obstacle>();
  /** addObjectObstacle로 넣은 장애물 → 오브젝트 */
  private readonly manual = new Map<Obstacle, THREE.Object3D>();
  /** 장애물 → 놓인 상자 (뺄 때 다시 표시할 타일) */
  private readonly obstacleAt = new Map<Obstacle, { center: THREE.Vector3; half: THREE.Vector3; yaw: number }>();
  /** 바뀐 타일만 다시 표시: 문이 바뀌었으면 전체, 아니면 dirtyTiles만. tileRecs: 처음 깎기 전 폴리곤, liveRefs: 지금 폴리곤 참조 */
  private fullRelabel = false;
  private readonly dirtyTiles = new Set<string>();
  private readonly tileRecs = new Map<string, PolyRec[]>();
  private readonly liveRefs = new Map<string, number[]>();
  /** 실패 지점 기억 (markBad): 막혀서 포기한 목표 자리 */
  readonly bad: { p: THREE.Vector3; until: number; by: object | null; r: number }[] = [];
  private pending = false;
  private lastAuto = 0;
  private disposed = false;
  /** 섬 다시 표시가 필요하다 (타일이 바뀜) */
  private relabel = false;
  /** createAgent 구현 (agent.ts가 넣는다: 순환 import 방지) */
  static agentFactory: ((nav: NavWorld, pos: THREE.Vector3, opts?: NavAgentOptions) => NavAgent) | null = null;

  readonly level: Level;
  readonly navMesh: NavMesh;
  readonly tileCache: TileCache;
  readonly seeds: NavSeed[];
  readonly stats: NavStats;
  readonly agentRadius: number;
  /** 오프메시 링크 (타일을 다시 만들 때 붙는 목록. addLinks로 더한다) */
  readonly links: OffMeshConnectionParams[];
  private readonly prune: boolean;
  /** 타일 캐시 압축 데이터 (dispose 때 푼다) */
  private readonly datas: { destroy(): void }[];
  /** 타일 격자 원점과 한 칸 크기 (m) */
  private readonly orig: [number, number, number];
  private readonly tileWorld: number;

  constructor(init: {
    level: Level;
    navMesh: NavMesh;
    tileCache: TileCache;
    seeds: NavSeed[];
    stats: NavStats;
    agentRadius: number;
    prune: boolean;
    datas: { destroy(): void }[];
    links: OffMeshConnectionParams[];
    orig: [number, number, number];
    tileWorld: number;
  }) {
    this.level = init.level;
    this.navMesh = init.navMesh;
    const navMesh = init.navMesh;
    this.tileCache = init.tileCache;
    this.seeds = init.seeds;
    this.stats = init.stats;
    this.agentRadius = init.agentRadius;
    this.prune = init.prune;
    this.datas = init.datas;
    this.links = init.links;
    this.orig = init.orig;
    this.tileWorld = init.tileWorld;
    this.query = new NavMeshQuery(navMesh, { maxNodes: 8192 });
    // 질의가 스스로 만든 기본 필터는 아래에서 우리 필터로 바꾸므로 푼다
    Raw.destroy(this.query.defaultFilter.raw);
    this.filter = new QueryFilter();
    this.filter.includeFlags = POLY_WALK;
    this.filter.excludeFlags = 0;
    this.anyFilter = new QueryFilter();
    this.anyFilter.includeFlags = 0xffff;
    this.filter.setAreaCost(AREA_VAULT, VAULT_COST);
    this.filter.setAreaCost(AREA_MANTLE, MANTLE_COST);
    this.query.defaultFilter = this.filter;
    this.query.defaultQueryHalfExtents = { ...DEFAULT_EXTENTS };
  }

  // ------------------------------------------------------------------ 질의

  /** 가장 가까운 걷는 자리 (없으면 null). maxDist: 수평 거리 (수직은 2.5 m까지) */
  closestPoint(p: THREE.Vector3, maxDist = 1.5, out = new THREE.Vector3()): THREE.Vector3 | null {
    const n = this.nearest(p, { x: maxDist, y: 2.5, z: maxDist });
    return n ? out.set(n.point.x, n.point.y, n.point.z) : null;
  }

  /** 경로 (꼭짓점 목록: 시작 스냅점 … 끝점). 못 가면 null (partial이면 가장 가까운 곳까지) */
  findPath(from: THREE.Vector3, to: THREE.Vector3, opts: NavPathOptions = {}): THREE.Vector3[] | null {
    const s = this.nearest(from);
    const e = this.nearest(to, opts.endExtents ?? TARGET_EXTENTS);
    if (!s) return null;
    if (!e) {
      if (!opts.partial) return null;
    } else if (!opts.partial && !this.sameIsland(s.ref, e.ref)) return null;
    const endRef = e?.ref ?? s.ref;
    const endPos = e?.point ?? s.point;
    const fp = this.query.findPath(s.ref, endRef, s.point, endPos, { maxPathPolys: 1024 });
    try {
      if (!fp.success || fp.polys.size === 0) return null;
      const last = fp.polys.get(fp.polys.size - 1);
      let end = endPos;
      if (last !== endRef || !e) {
        if (!opts.partial) return null;
        const c = this.query.closestPointOnPoly(last, to);
        if (!c.success) return null;
        end = c.closestPoint;
      }
      const sp = this.query.findStraightPath(s.point, end, fp.polys, { maxStraightPathPoints: 256 });
      const out: THREE.Vector3[] = [];
      for (let i = 0; i < sp.straightPathCount; i++) {
        out.push(new THREE.Vector3(sp.straightPath.get(i * 3), sp.straightPath.get(i * 3 + 1), sp.straightPath.get(i * 3 + 2)));
      }
      sp.straightPath.destroy();
      sp.straightPathFlags.destroy();
      sp.straightPathRefs.destroy();
      return out.length ? out : null;
    } finally {
      fp.polys.destroy();
    }
  }

  /** p에서 radius(m) 안의 걷는 자리 하나 (같은 섬). 없으면 null */
  randomPointNear(p: THREE.Vector3, radius: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const s = this.nearest(p);
    if (!s) return null;
    for (let i = 0; i < 10; i++) {
      const r = this.query.findRandomPointAroundCircle(s.point, radius, { startRef: s.ref });
      if (!r.success) return null;
      const q = r.randomPoint;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      if (dx * dx + dz * dz <= radius * radius || i === 9) {
        if (dx * dx + dz * dz > radius * radius) return null;
        return out.set(q.x, q.y, q.z);
      }
    }
    return null;
  }

  /**
   * 걸어서 일직선으로 갈 수 있나 (내비메시 위 2D 레이: 벽·낭떠러지·문에 막히면 hit).
   * 높이는 보지 않는다 (경사·계단은 걸을 수 있으면 통과).
   */
  raycast(from: THREE.Vector3, to: THREE.Vector3): NavRaycastHit {
    const s = this.nearest(from);
    if (!s) return { hit: true, t: 0, point: from.clone(), normal: new THREE.Vector3() };
    const r = this.query.raycast(s.ref, s.point, to);
    const t = r.success ? Math.min(1, r.t) : 0;
    const hit = !r.success || r.t < 1;
    const sp = _a.set(s.point.x, s.point.y, s.point.z);
    const point = new THREE.Vector3().lerpVectors(sp, to, t);
    if (hit) {
      // 막힌 자리 높이: 그 자리 폴리곤 높이 (없으면 시작 높이)
      const c = this.nearest(point, { x: 0.3, y: 2.5, z: 0.3 });
      if (c) point.y = c.point.y;
    }
    return { hit, t, point, normal: new THREE.Vector3(r.hitNormal.x, 0, r.hitNormal.z) };
  }

  /** a에서 b로 걸어갈 수 있나 (같은 섬인가: 장애물·문 반영. 경로 탐색 없이 O(1)) */
  isReachable(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const s = this.nearest(a);
    const e = this.nearest(b);
    return !!s && !!e && this.sameIsland(s.ref, e.ref);
  }

  /** 점이 있는 섬 번호 (-1 = 내비 밖) */
  islandAt(p: THREE.Vector3): number {
    const n = this.nearest(p, DEFAULT_EXTENTS, this.anyFilter);
    return n ? (this.island.get(n.ref) ?? -1) : -1;
  }

  /** 경로 길이 (m). 못 가면 Infinity */
  pathLength(from: THREE.Vector3, to: THREE.Vector3): number {
    const p = this.findPath(from, to);
    if (!p) return Infinity;
    let d = 0;
    for (let i = 1; i < p.length; i++) d += p[i].distanceTo(p[i - 1]);
    return d;
  }

  /**
   * 내비메시 위에서 from → to로 미끄러지며 옮긴다 (벽에 닿으면 따라 미끄러짐). 결과 높이는 바닥 폴리곤 높이.
   * 스스로 움직이는 에이전트(drive 모드)가 쓴다.
   */
  moveAlong(from: THREE.Vector3, to: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 | null {
    const s = this.nearest(from);
    if (!s) return null;
    const r = this.query.moveAlongSurface(s.ref, s.point, to);
    if (!r.success) return null;
    out.set(r.resultPosition.x, r.resultPosition.y, r.resultPosition.z);
    const ref = r.visited.length ? r.visited[r.visited.length - 1] : s.ref;
    const h = this.query.getPolyHeight(ref, out);
    if (h.success) out.y = h.height;
    return out;
  }

  /** 길찾기 에이전트 (agent.ts). 위치는 소유자가 매 스텝 넘겨주거나(steer) 에이전트가 스스로 옮긴다(drive) */
  createAgent(pos: THREE.Vector3, opts?: NavAgentOptions): NavAgent {
    if (!NavWorld.agentFactory) throw new Error('[nav] agent.ts가 로드되지 않음');
    return NavWorld.agentFactory(this, pos, opts);
  }

  // ------------------------------------------------------------------ 실패 지점 기억

  /**
   * 막혀서 포기한 자리를 ttl초 동안 '나쁨'으로 적는다 (F.E.A.R.의 작업 기억: 실패한 행동을 다음 계획에서 피한다).
   * by: 적은 주체 (그 주체의 길 찾기는 이 자리를 목표로 받지 않게 할 수 있다: isBad(p, by)). 시계는 performance.now()
   */
  markBad(p: THREE.Vector3, ttl = 20, by: object | null = null, radius = 1.2): void {
    const now = performance.now() / 1000;
    this.pruneBad(now);
    // 같은 자리·같은 주체면 늘리기만
    for (const b of this.bad) {
      if (b.by === by && b.p.distanceToSquared(p) < 0.25) {
        b.until = Math.max(b.until, now + ttl);
        b.r = Math.max(b.r, radius);
        return;
      }
    }
    if (this.bad.length >= 64) this.bad.shift();
    this.bad.push({ p: p.clone(), until: now + ttl, by, r: radius });
  }

  /** 나쁜 자리인가. by를 주면 그 주체가 적은 것만, 안 주면 누구 것이든 */
  isBad(p: THREE.Vector3, by?: object | null): boolean {
    if (!this.bad.length) return false;
    const now = performance.now() / 1000;
    for (const b of this.bad) {
      if (b.until < now || (by !== undefined && b.by !== by)) continue;
      const dx = b.p.x - p.x;
      const dz = b.p.z - p.z;
      if (dx * dx + dz * dz < b.r * b.r && Math.abs(b.p.y - p.y) < 1.5) return true;
    }
    return false;
  }

  private pruneBad(now: number): void {
    for (let i = this.bad.length - 1; i >= 0; i--) if (this.bad[i].until < now) this.bad.splice(i, 1);
  }

  // ------------------------------------------------------------------ 장애물

  /** 상자 장애물 (center: 월드 중심, half: 반 크기, yaw: Y축 회전 라디안). 에이전트 반지름만큼 자동으로 키운다 */
  addBoxObstacle(center: THREE.Vector3, half: THREE.Vector3, yaw = 0): Obstacle | null {
    const r = this.agentRadius;
    const res = Math.abs(yaw) < 1e-4
      ? this.tileCache.addBoxObstacle({ x: center.x, y: center.y, z: center.z }, { x: half.x + r, y: half.y, z: half.z + r }, 0)
      : this.tileCache.addBoxObstacle({ x: center.x, y: center.y, z: center.z }, { x: half.x + r, y: half.y, z: half.z + r }, yaw);
    if (!res.success || !res.obstacle) {
      console.warn('[nav] 장애물 추가 실패 (maxObstacles 또는 요청 큐)', res.status);
      return null;
    }
    this.obstacles.add(res.obstacle);
    this.touch(res.obstacle, center, half, yaw);
    this.pending = true;
    return res.obstacle;
  }

  /** 원기둥 장애물 (pos: 바닥 중심). 에이전트 반지름만큼 자동으로 키운다 */
  addCylinderObstacle(pos: THREE.Vector3, radius: number, height: number): Obstacle | null {
    const res = this.tileCache.addCylinderObstacle({ x: pos.x, y: pos.y - 0.3, z: pos.z }, radius + this.agentRadius, height + 0.3);
    if (!res.success || !res.obstacle) {
      console.warn('[nav] 장애물 추가 실패', res.status);
      return null;
    }
    this.obstacles.add(res.obstacle);
    this.touch(res.obstacle, new THREE.Vector3(pos.x, pos.y + height / 2 - 0.15, pos.z), new THREE.Vector3(radius, height / 2 + 0.15, radius), 0);
    this.pending = true;
    return res.obstacle;
  }

  removeObstacle(o: Obstacle | null | undefined): void {
    if (!o || !this.obstacles.has(o)) return;
    this.tileCache.removeObstacle(o);
    this.obstacles.delete(o);
    this.manual.delete(o);
    const at = this.obstacleAt.get(o);
    this.obstacleAt.delete(o);
    if (at) this.touch(null, at.center, at.half, at.yaw);
    else this.fullRelabel = true;
    this.pending = true;
  }

  // ------------------------------------------------------------------ 바뀐 타일만 다시 표시

  /**
   * 장애물이 건드리는 타일을 '다시 표시할 타일'로 적는다. 처음 적는 타일은 지금(깎이기 전) 폴리곤을 기록해 둔다:
   * 장애물은 깎기만 하므로 다시 만든 폴리곤은 원래 폴리곤 안에 들고, 그 원래 폴리곤의 섬·가지치기를 물려받는다.
   * 문은 막힌 방을 이어 줄 수 있어 전체를 다시 표시한다 (syncDoors가 fullRelabel을 켠다).
   * 범위는 타일 캐시가 다시 만드는 타일을 모두 덮어야 한다: Detour(dtTileCache::getObstacleBounds)는 돌린 상자를 방향과 상관없이
   * 가운데 ± 1.41 × max(반폭 + 에이전트 반지름)의 정사각형으로 보고 그와 겹치는 타일을 다시 만든다(원기둥은 반지름 + 에이전트 반지름).
   * 돌린 상자의 외접 상자만 적으면 그 밖에서 다시 만든 타일의 폴리곤이 섬 표시 없이(-1) 남는다(큰 장애물 하나가
   * 섰다 가면 둘레 걷는 자리의 17~47%). 그 위에서는 isReachable·findPath가 모두 실패해 에이전트가 길을 못 잡는다
   */
  private touch(o: Obstacle | null, center: THREE.Vector3, half: THREE.Vector3, yaw: number): void {
    if (o) this.obstacleAt.set(o, { center: center.clone(), half: half.clone(), yaw });
    if (this.fullRelabel) return;
    const ex = 1.42 * Math.max(half.x + this.agentRadius, half.z + this.agentRadius) + 0.2;
    const ez = ex;
    const tw = this.tileWorld;
    const tx0 = Math.floor((center.x - ex - this.orig[0]) / tw);
    const tx1 = Math.floor((center.x + ex - this.orig[0]) / tw);
    const ty0 = Math.floor((center.z - ez - this.orig[2]) / tw);
    const ty1 = Math.floor((center.z + ez - this.orig[2]) / tw);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${tx},${ty}`;
        if (!this.tileRecs.has(key)) this.tileRecs.set(key, this.recordTile(tx, ty));
        this.dirtyTiles.add(key);
      }
    }
  }

  /** 타일 (tx, ty)의 모든 층 폴리곤: xz 꼭짓점, 평균 높이, 섬, 살렸나(플래그) */
  private recordTile(tx: number, ty: number): PolyRec[] {
    const out: PolyRec[] = [];
    const nm = this.navMesh;
    for (let layer = 0; layer < 32; layer++) {
      const tile = nm.getTileAt(tx, ty, layer);
      if (!tile) break;
      const h = tile.header();
      if (!h) continue;
      const base = nm.getPolyRefBase(tile);
      for (let j = 0; j < h.polyCount(); j++) {
        const poly = tile.polys(j);
        const n = poly.vertCount();
        const xz = new Float32Array(n * 2);
        let y = 0;
        for (let k = 0; k < n; k++) {
          const vi = poly.verts(k) * 3;
          xz[k * 2] = tile.verts(vi);
          xz[k * 2 + 1] = tile.verts(vi + 2);
          y += tile.verts(vi + 1);
        }
        const ref = base + j;
        out.push({ ref, xz, y: y / n, island: this.island.get(ref) ?? -1, kept: poly.flags() !== 0 });
      }
    }
    return out;
  }

  /** 적어 둔 타일만 다시 표시: 새 폴리곤 가운데가 든 원래 폴리곤의 섬·플래그 (없으면 가장 가까운 것). @returns ms */
  private relabelTiles(): number {
    const t0 = performance.now();
    const nm = this.navMesh;
    for (const key of this.dirtyTiles) {
      const recs = this.tileRecs.get(key);
      const [tx, ty] = key.split(',').map(Number);
      if (!recs) continue;
      for (const old of this.liveRefs.get(key) ?? recs.map((x) => x.ref)) this.island.delete(old);
      const live: number[] = [];
      for (let layer = 0; layer < 32; layer++) {
        const tile = nm.getTileAt(tx, ty, layer);
        if (!tile) break;
        const h = tile.header();
        if (!h) continue;
        const base = nm.getPolyRefBase(tile);
        for (let j = 0; j < h.polyCount(); j++) {
          const poly = tile.polys(j);
          const n = poly.vertCount();
          let cx = 0;
          let cy = 0;
          let cz = 0;
          for (let k = 0; k < n; k++) {
            const vi = poly.verts(k) * 3;
            cx += tile.verts(vi);
            cy += tile.verts(vi + 1);
            cz += tile.verts(vi + 2);
          }
          cx /= n;
          cy /= n;
          cz /= n;
          let best: PolyRec | null = null;
          let bd = Infinity;
          for (const r of recs) {
            const dy = Math.abs(r.y - cy);
            if (dy > 1.5) continue;
            if (dy < 1.2 && inPoly(r.xz, cx, cz)) {
              best = r;
              break;
            }
            // 가장 가까운 꼭짓점 평균 (안에 든 것이 없을 때)
            let ax = 0;
            let az = 0;
            const m = r.xz.length / 2;
            for (let k = 0; k < m; k++) {
              ax += r.xz[k * 2];
              az += r.xz[k * 2 + 1];
            }
            const d = (ax / m - cx) ** 2 + (az / m - cz) ** 2 + dy * dy;
            if (d < bd) {
              bd = d;
              best = r;
            }
          }
          const ref = base + j;
          live.push(ref);
          if (!best) continue;
          this.island.set(ref, best.island);
          const want = best.kept || !this.prune ? POLY_WALK : 0;
          if (poly.flags() !== want) nm.setPolyFlags(ref, want);
        }
      }
      this.liveRefs.set(key, live);
    }
    this.dirtyTiles.clear();
    return performance.now() - t0;
  }

  /**
   * 이 Object3D를 장애물로 (세워 둔 큰 물체·잔해. 움직이면 removeObstacle 후 다시 부른다). 오브젝트 방향으로 돌린 상자,
   * 바닥에서 1.5 m 위까지의 메시만 (키 위로 튀어나온 부분은 빼낸다). 이렇게 넣은 오브젝트는 자동 장애물(nav/dynamic.ts)이 건너뛴다
   */
  addObjectObstacle(o: THREE.Object3D): Obstacle | null {
    const f = objectFootprint(o);
    if (!f) return null;
    const ob = this.addBoxObstacle(f.center, f.half, f.yaw);
    if (ob) this.manual.set(ob, o);
    return ob;
  }

  /** 게임 코드가 addObjectObstacle로 넣은 오브젝트인가 */
  hasObjectObstacle(o: THREE.Object3D): boolean {
    for (const x of this.manual.values()) if (x === o) return true;
    return false;
  }

  /** 이 자리가 굽는 영역 안인가 (수평) */
  contains(p: THREE.Vector3): boolean {
    const a = this.stats.area;
    return p.x >= a.min[0] && p.x <= a.max[0] && p.z >= a.min[2] && p.z <= a.max[2];
  }

  /**
   * 돌린 상자(에이전트 반지름만큼 키운 것)가 건드리는 타일 층 수 (Detour dtTileCache::getTilesInRange와 같은 규칙: 수평 범위의 타일 중
   * 높이가 겹치는 층). 8개(DT_MAX_TOUCHED_TILES)를 넘으면 나머지 타일은 깎이지 않는다
   */
  touchedTiles(center: THREE.Vector3, half: THREE.Vector3, yaw = 0): number {
    const r = this.agentRadius;
    const hx = half.x + r;
    const hz = half.z + r;
    const c = Math.abs(Math.cos(yaw));
    const s = Math.abs(Math.sin(yaw));
    const ex = hx * c + hz * s;
    const ez = hx * s + hz * c;
    const tw = this.tileWorld;
    const tx0 = Math.floor((center.x - ex - this.orig[0]) / tw);
    const tx1 = Math.floor((center.x + ex - this.orig[0]) / tw);
    const ty0 = Math.floor((center.z - ez - this.orig[2]) / tw);
    const ty1 = Math.floor((center.z + ez - this.orig[2]) / tw);
    const y0 = center.y - half.y;
    const y1 = center.y + half.y;
    let n = 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        for (let layer = 0; layer < 32; layer++) {
          const t = this.navMesh.getTileAt(tx, ty, layer);
          if (!t) break;
          const h = t.header();
          if (!h) continue;
          if (h.bmax(1) >= y0 && h.bmin(1) <= y1) n++;
        }
      }
    }
    return n;
  }

  get obstacleCount(): number {
    return this.obstacles.size;
  }

  /** 레벨의 DOOR_를 따라간다 (buildNav가 부른다) */
  trackDoors(): void {
    for (const door of this.level.doors.values()) {
      const t = makeDoorTrack(door);
      if (t) this.doors.push(t);
    }
    this.syncDoors(true);
  }

  private syncDoors(force = false): void {
    for (const d of this.doors) {
      const open = d.door.open;
      const settled = open === d.door.target;
      // 열림 반 넘게 바뀌었거나, 멈춘 자리가 놓인 자리와 다르면 옮긴다
      if (!force && !(Math.abs(open - d.at) >= 0.5 || (settled && open !== d.at))) continue;
      if (d.obstacle) this.removeObstacle(d.obstacle);
      d.obstacle = null;
      d.at = open;
      // 문은 방을 이어 준다: 섬 전체를 다시 표시
      this.fullRelabel = true;
      const k = smooth(open);
      const c = _b.copy(d.center).addScaledVector(d.door.move, k);
      // 들어 올리는 문: 바닥 위로 걷는 높이만큼 떴으면 막지 않는다 (장애물 높이 판정에 맡김)
      d.obstacle = this.addBoxObstacle(c, d.half, d.yaw);
    }
  }

  /**
   * 고정 스텝마다: 문을 따라가고, 쌓인 장애물 변경으로 타일을 다시 만든다(한 번에 maxTiles개까지).
   * 다 끝나면 섬을 다시 표시하고 version을 올린다.
   */
  update(maxTiles = 8, maxMs = 2): boolean {
    if (this.disposed) return false;
    if (this.doors.length) this.syncDoors();
    if (!this.pending) return false;
    // tileCache.update 한 번 = 쌓인 요청 처리 + 타일 하나 다시 만들기. 타일 수와 시간(ms)으로 나눈다
    const t0 = performance.now();
    for (let i = 0; i < maxTiles; i++) {
      const r = this.tileCache.update(this.navMesh);
      this.relabel = true;
      this.tileRebuilds++;
      if (r.upToDate) {
        this.pending = false;
        break;
      }
      if (performance.now() - t0 > maxMs) break;
    }
    this.updateMs += performance.now() - t0;
    if (!this.pending && this.relabel) {
      this.relabel = false;
      // 움직이는 물체·충돌체 장애물만 바뀌었으면 그 타일만 (전체 섬 표시는 큰 레벨에서 5~8 ms라 한 프레임을 튀게 한다)
      this.updateMs += this.fullRelabel || !this.dirtyTiles.size ? this.labelIslands() : this.relabelTiles();
      // 다시 만든 타일의 오프메시 폴리곤은 플래그가 돌아온다: 끈 링크는 다시 끈다
      this.applyDeadLinks();
      this.version++;
    }
    return this.pending;
  }

  /** 점검: 장애물·문으로 다시 만든 타일 수, 그 일에 쓴 시간 (ms, 섬 다시 표시 포함) */
  tileRebuilds = 0;
  updateMs = 0;

  /** 대기 중인 장애물 변경을 지금 다 반영한다 (로딩 중에) */
  flush(): void {
    this.update(1e6);
  }

  // ------------------------------------------------------------------ 링크

  /** 오프메시 링크를 더한다 (뛰어내리기·사다리). 시작점이 있는 타일을 다시 만들고 섬을 다시 표시한다 */
  addLinks(links: OffMeshConnectionParams[]): void {
    if (!links.length) return;
    const tiles = new Set<string>();
    for (const l of links) {
      this.links.push(l);
      const tx = Math.floor((l.startPosition.x - this.orig[0]) / this.tileWorld);
      const ty = Math.floor((l.startPosition.z - this.orig[2]) / this.tileWorld);
      tiles.add(`${tx},${ty}`);
    }
    for (const k of tiles) {
      const [tx, ty] = k.split(',').map(Number);
      this.tileCache.buildNavMeshTilesAt(tx, ty, this.navMesh);
    }
    this.labelIslands();
    this.applyDeadLinks();
    this.version++;
  }

  /** 끈 넘기·오르기 링크 id (killTraverse) */
  private readonly deadLinks = new Set<number>();

  /**
   * 넘기·오르기 링크를 끈다: 캐릭터 이동 캡슐로 쓸어 본 길이 고정 충돌체에 막혔다 (굽기 입력에 없는 충돌체가 내릴 자리를 막는 등).
   * 그 오프메시 폴리곤의 플래그를 0으로 두어 길 찾기가 고르지 않게 한다. 타일을 다시 만들어도 끈 채로 둔다.
   * 끄지 않으면 캐릭터가 그 링크 앞에서 막히고, 다시 같은 링크로 길을 잡아 같은 자리에서 맴돈다
   */
  killTraverse(r: TraverseLinkRec): void {
    if (r.dead) return;
    r.dead = true;
    this.deadLinks.add(r.id);
    this.applyDeadLinks();
    this.version++;
  }

  private applyDeadLinks(): void {
    if (!this.deadLinks.size) return;
    const nm = this.navMesh;
    const max = nm.getMaxTiles();
    for (let ti = 0; ti < max; ti++) {
      const tile = nm.getTile(ti);
      const h = tile.header();
      if (!h) continue;
      const n = h.offMeshConCount();
      if (!n) continue;
      const base = nm.getPolyRefBase(tile);
      for (let i = 0; i < n; i++) {
        const con = tile.offMeshCons(i);
        if (!this.deadLinks.has(con.userId())) continue;
        const ref = base + con.poly();
        if (tile.polys(con.poly()).flags() !== 0) nm.setPolyFlags(ref, 0);
      }
    }
  }

  // ------------------------------------------------------------------ 넘기·오르기 링크

  /** 넘기·오르기 링크 (addTraverseLinks) */
  readonly traverse: TraverseLinkRec[] = [];
  /** 링크 끝 격자 (1 m 칸 → 링크) */
  private readonly travGrid = new Map<number, TraverseLinkRec[]>();

  private travKey(x: number, z: number): number {
    return (Math.floor(x) + 32768) * 65536 + (Math.floor(z) + 32768);
  }

  /** 넘기·오르기 링크를 더한다 (양방향 오프메시 링크, 영역 AREA_VAULT/AREA_MANTLE로 길 비용을 올린다) */
  addTraverseLinks(recs: TraverseLinkRec[]): void {
    if (!recs.length) return;
    const params: OffMeshConnectionParams[] = [];
    for (const r of recs) {
      r.id = 3000 + this.traverse.length;
      this.traverse.push(r);
      for (const p of [r.a, r.b]) {
        const k = this.travKey(p.x, p.z);
        let l = this.travGrid.get(k);
        if (!l) this.travGrid.set(k, (l = []));
        l.push(r);
      }
      params.push({
        startPosition: { x: r.a.x, y: r.a.y, z: r.a.z },
        endPosition: { x: r.b.x, y: r.b.y, z: r.b.z },
        radius: 0.3,
        bidirectional: true,
        area: r.kind === 'vault' ? AREA_VAULT : AREA_MANTLE,
        flags: POLY_WALK,
        userId: r.id,
      });
    }
    this.addLinks(params);
  }

  /**
   * 경로의 두 점 from → to가 넘기·오르기 링크인가 (끝이 tolFrom·tolTo m 안). reverse: 링크를 b → a로 쓴다.
   * 캐릭터가 경로점을 따라갈 때 부른다 (Detour 경로는 링크 시작점과 끝점을 연달아 준다)
   */
  traverseAt(from: THREE.Vector3, to: THREE.Vector3, tolFrom = 0.45, tolTo = 0.45): { link: TraverseLinkRec; reverse: boolean } | null {
    if (!this.traverse.length) return null;
    const cx = Math.floor(from.x);
    const cz = Math.floor(from.z);
    let best: { link: TraverseLinkRec; reverse: boolean } | null = null;
    let bd = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const l = this.travGrid.get((cx + dx + 32768) * 65536 + (cz + dz + 32768));
        if (!l) continue;
        for (const r of l) {
          for (const rev of [false, true]) {
            const a = rev ? r.b : r.a;
            const b = rev ? r.a : r.b;
            const da = Math.hypot(a.x - from.x, a.z - from.z);
            if (da > tolFrom || Math.abs(a.y - from.y) > 0.7) continue;
            const db = Math.hypot(b.x - to.x, b.z - to.z);
            if (db > tolTo || Math.abs(b.y - to.y) > 0.7) continue;
            if (da + db < bd) {
              bd = da + db;
              best = { link: r, reverse: rev };
            }
          }
        }
      }
    }
    return best;
  }

  /** 링크 끝 가까이 (p에서 r m 안의 끝) */
  traverseNear(p: THREE.Vector3, r = 1): TraverseLinkRec[] {
    const out: TraverseLinkRec[] = [];
    const n = Math.ceil(r);
    const cx = Math.floor(p.x);
    const cz = Math.floor(p.z);
    for (let dx = -n; dx <= n; dx++) {
      for (let dz = -n; dz <= n; dz++) {
        for (const l of this.travGrid.get((cx + dx + 32768) * 65536 + (cz + dz + 32768)) ?? []) {
          if (out.includes(l)) continue;
          if (Math.min(Math.hypot(l.a.x - p.x, l.a.z - p.z), Math.hypot(l.b.x - p.x, l.b.z - p.z)) <= r) out.push(l);
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 넘기 판정이 묻는 것 (직접 조작하는 캐릭터의 넘기 판정)

  /** 사람이 다니는 내비(걷기 필터) 위 가장 가까운 자리 */
  nearestWalk(p: THREE.Vector3, ext: { x: number; y: number; z: number }): { ref: number; point: { x: number; y: number; z: number } } | null {
    return this.nearest(p, ext);
  }

  /** 가지친 섬까지 포함한 가장 가까운 폴리곤 */
  nearestAny(p: THREE.Vector3, ext: { x: number; y: number; z: number }): { ref: number; point: { x: number; y: number; z: number }; island: number; kept: boolean } | null {
    const n = this.nearest(p, ext, this.anyFilter);
    if (!n) return null;
    const island = this.island.get(n.ref) ?? -1;
    return { ...n, island, kept: this.isKeptIsland(island) };
  }

  private shapeCache = new Map<number, { polys: number; box: THREE.Box3; edges: { p: THREE.Vector3; n: THREE.Vector3 }[] } | null>();
  private shapeVersion = -1;

  /** 섬 하나의 폴리곤 수·경계 상자·경계 변 표본(0.8 m 간격, 바깥 법선). 41개 넘는 섬은 표본을 만들지 않는다 */
  islandShape(id: number): { polys: number; box: THREE.Box3; edges: { p: THREE.Vector3; n: THREE.Vector3 }[] } | null {
    if (this.shapeVersion !== this.version) {
      this.shapeCache.clear();
      this.shapeVersion = this.version;
    }
    if (this.shapeCache.has(id)) return this.shapeCache.get(id)!;
    const refs: number[] = [];
    for (const [ref, isl] of this.island) if (isl === id) refs.push(ref);
    const box = new THREE.Box3();
    const edges: { p: THREE.Vector3; n: THREE.Vector3 }[] = [];
    let out: { polys: number; box: THREE.Box3; edges: { p: THREE.Vector3; n: THREE.Vector3 }[] } | null = { polys: refs.length, box, edges };
    if (refs.length <= 40) {
      for (const ref of refs) {
        const tp = this.navMesh.getTileAndPolyByRef(ref);
        if (!tp.success) continue;
        const tile = tp.tile;
        const poly = tp.poly;
        if (poly.getType() === 1) continue;
        const nv = poly.vertCount();
        const vs: THREE.Vector3[] = [];
        for (let k = 0; k < nv; k++) {
          const vi = poly.verts(k) * 3;
          vs.push(new THREE.Vector3(tile.verts(vi), tile.verts(vi + 1), tile.verts(vi + 2)));
        }
        const c = vs.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(nv);
        for (const v of vs) box.expandByPoint(v);
        for (let k = 0; k < nv; k++) {
          if (poly.neis(k) !== 0) continue;
          const a = vs[k];
          const b = vs[(k + 1) % nv];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          if (len < 0.05) continue;
          const n = new THREE.Vector3((b.z - a.z) / len, 0, -(b.x - a.x) / len);
          if (n.x * ((a.x + b.x) / 2 - c.x) + n.z * ((a.z + b.z) / 2 - c.z) < 0) n.negate();
          const steps = Math.max(1, Math.round(len / 0.8));
          for (let i = 0; i < steps; i++) edges.push({ p: new THREE.Vector3().lerpVectors(a, b, (i + 0.5) / steps), n });
        }
      }
    } else out = { polys: refs.length, box: box.makeEmpty(), edges };
    this.shapeCache.set(id, out);
    return out;
  }

  // ------------------------------------------------------------------ 섬

  /**
   * 폴리곤 연결로 섬을 나누고, 시드(마커)가 하나도 없는 섬은 플래그 0으로 뺀다.
   * @returns 걸린 시간 (ms)
   */
  labelIslands(): number {
    const t0 = performance.now();
    const nm = this.navMesh;
    const NULL = Detour.DT_NULL_LINK;
    const refs: number[] = [];
    const index = new Map<number, number>();
    const adj: number[][] = [];
    const max = nm.getMaxTiles();
    for (let ti = 0; ti < max; ti++) {
      const tile = nm.getTile(ti);
      const h = tile.header();
      if (!h) continue;
      const base = nm.getPolyRefBase(tile);
      const pc = h.polyCount();
      for (let j = 0; j < pc; j++) {
        const ref = base + j;
        const poly = tile.polys(j);
        if (poly.flags() !== POLY_WALK) nm.setPolyFlags(ref, POLY_WALK);
        const nb: number[] = [];
        for (let l = poly.firstLink(); l !== NULL; ) {
          const link = tile.links(l);
          const r = link.ref();
          if (r) nb.push(r);
          l = link.next();
        }
        index.set(ref, refs.length);
        refs.push(ref);
        adj.push(nb);
      }
    }
    // 무방향 연결 요소 (오프메시 링크는 한 방향이라 양쪽을 합친다: isReachable은 근사, findPath는 방향을 지킨다)
    const parent = new Int32Array(refs.length);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (let i = 0; i < refs.length; i++) {
      for (const r of adj[i]) {
        const j = index.get(r);
        if (j === undefined) continue;
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
    const label = new Int32Array(refs.length);
    const remap = new Map<number, number>();
    for (let i = 0; i < refs.length; i++) {
      const root = find(i);
      let id = remap.get(root);
      if (id === undefined) remap.set(root, (id = remap.size));
      label[i] = id;
    }
    const n = remap.size;
    const island = new Map<number, number>();
    for (let i = 0; i < refs.length; i++) island.set(refs[i], label[i]);
    this.island = island;
    // 시드 섬: 마커 바로 아래(마커보다 0.6 m 넘게 높은 곳으로는 붙지 않는다: 벽·지붕 위 제외)
    const kept = new Set<number>();
    for (const s of this.seeds) {
      const q = this.query.findNearestPoly(s.position, { halfExtents: { x: 1.0, y: 1.8, z: 1.0 }, filter: this.anyFilter });
      if (!q.success || !q.nearestRef) continue;
      if (q.nearestPoint.y > s.position.y + 0.6) continue;
      const id = island.get(q.nearestRef);
      if (id !== undefined) kept.add(id);
    }
    this.keptIslands = kept;
    let pruned = 0;
    if (this.prune && kept.size) {
      for (let i = 0; i < refs.length; i++) {
        if (kept.has(label[i])) continue;
        nm.setPolyFlags(refs[i], 0);
        pruned++;
      }
    }
    this.stats.polys = refs.length;
    this.stats.islands = n;
    this.stats.keptIslands = kept.size;
    this.stats.prunedPolys = pruned;
    // 전체를 다시 표시했으니 부분 표시용 기록은 버린다
    this.fullRelabel = false;
    this.dirtyTiles.clear();
    this.tileRecs.clear();
    this.liveRefs.clear();
    this.fullRelabels++;
    return performance.now() - t0;
  }

  /** 점검: 전체 섬 다시 표시 횟수 */
  fullRelabels = 0;

  /** 섬 번호 (디버그 색) */
  islandOf(ref: number): number {
    return this.island.get(ref) ?? -1;
  }

  isKeptIsland(id: number): boolean {
    return !this.prune || !this.keptIslands.size || this.keptIslands.has(id);
  }

  private sameIsland(a: number, b: number): boolean {
    const ia = this.island.get(a);
    return ia !== undefined && ia === this.island.get(b);
  }

  /** 가장 가까운 폴리곤 (걷기 필터) */
  nearest(p: THREE.Vector3, ext: { x: number; y: number; z: number } = DEFAULT_EXTENTS, filter = this.filter): { ref: number; point: { x: number; y: number; z: number } } | null {
    // 아무도 update()를 안 불러도 문이 움직이면 질의 때 반영한다 (50 ms에 한 번)
    if (this.doors.length || this.pending) {
      const t = performance.now();
      if (t - this.lastAuto > 50) {
        this.lastAuto = t;
        this.update();
      }
    }
    const r = this.query.findNearestPoly(p, { halfExtents: ext, filter });
    if (!r.success || !r.nearestRef) return null;
    return { ref: r.nearestRef, point: r.nearestPoint };
  }

  /** WASM 힙 크기 (바이트) */
  static heapBytes(): number {
    return (Raw.Module?.HEAPU8?.length as number | undefined) ?? 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const a of [...this.agents]) a.dispose();
    this.query.destroy();
    this.tileCache.destroy();
    this.navMesh.destroy();
    for (const d of this.datas) d.destroy();
    Raw.destroy(this.filter.raw);
    Raw.destroy(this.anyFilter.raw);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

/** DOOR_ 메시 → 닫힘 자리 상자 (문 축 기준 OBB) */
function makeDoorTrack(door: Door): DoorTrack | null {
  const o = door.mesh;
  o.updateWorldMatrix(true, true);
  const q = o.getWorldQuaternion(new THREE.Quaternion());
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const yaw = Math.atan2(-fwd.z, fwd.x);
  // 문 축(yaw만) 공간에서 경계 상자
  const toLocal = new THREE.Matrix4().makeRotationY(-yaw);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh || m.userData.isOutline) return;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).applyMatrix4(toLocal);
      box.expandByPoint(v);
    }
  });
  if (box.isEmpty()) return null;
  const k = smooth(door.open);
  const centerLocal = box.getCenter(new THREE.Vector3());
  const center = centerLocal.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw)).addScaledVector(door.move, -k);
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  // 바닥 높이를 덮도록 아래로 0.3 m
  center.y -= 0.15;
  half.y += 0.15;
  return { door, center, half, yaw, at: Number.NaN, obstacle: null };
}

/** 부분 다시 표시용 폴리곤 기록 */
interface PolyRec {
  ref: number;
  xz: Float32Array;
  y: number;
  island: number;
  kept: boolean;
}

/** xz 다각형 안인가 (볼록·오목 모두: 교차 수) */
function inPoly(xz: Float32Array, x: number, z: number): boolean {
  let inside = false;
  const n = xz.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = xz[i * 2];
    const zi = xz[i * 2 + 1];
    const xj = xz[j * 2];
    const zj = xz[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** 상태 코드에 부분 결과 표시가 있나 */
export function isPartial(status: number): boolean {
  return !!statusDetail(status, Detour.DT_PARTIAL_RESULT);
}
