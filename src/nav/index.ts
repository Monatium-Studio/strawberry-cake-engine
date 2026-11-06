import * as THREE from 'three';
import { init as initRecast, Raw, type OffMeshConnectionParams } from '@recast-navigation/core';
import type { RAPIER } from '../physics/Physics';
import type { Level } from '../level/Level';
import { Slicer } from '../level/loading';
import './agent';
import { TileRasterizer, assembleTileCache, bakeGrid, type BakeConfig, type BakeGrid, type BakeReply, type BakeRequest, type SolidPrism } from './generate';
import { levelGeometry, levelSeeds, navArea } from './geometry';
import { TriGrid, boundarySamples, findDropLinks, type DropLinkOptions } from './links';
import { NavWorld, type NavStats } from './NavWorld';
import { findTraverseLinks, type TraverseLinkOptions } from './traverse';
import { onSessionEnd } from '../core/session';

/**
 * 내비게이션 (Recast/Detour WASM, `recast-navigation` 0.44, MIT).
 *
 *   const nav = await buildNav(level);                 // 레벨 정적 충돌체로 내비메시 (로딩 화면 안에서)
 *   nav.findPath(from, to)                              // Vector3[] | null
 *   nav.closestPoint(p) / nav.randomPointNear(p, r) / nav.raycast(a, b) / nav.isReachable(a, b)
 *   const ag = nav.createAgent(pos, { speed: 3 });     // 경로 따라가기 + 비키기 (agent.ts)
 *   ag.moveTo(goal); const v = ag.update(dt, pos);
 *   nav.update()                                       // 고정 스텝마다: 문·장애물 반영
 *
 * 기본 에이전트 치수(DEFAULT_AGENT): 반지름 0.22, 키 1.2, 턱 0.28, 경사 46°. 다른 체격이면 buildNav 옵션으로 준다.
 */

export { NavWorld } from './NavWorld';
export type { NavStats, NavRaycastHit, NavPathOptions } from './NavWorld';
export { NavAgent } from './agent';
export type { NavAgentOptions, NavAgentMode, NavAgentState } from './agent';
export type { DropLinkOptions } from './links';
export type { TraverseLinkOptions, TraverseLinkStats } from './traverse';
export type { TraverseLinkRec } from './NavWorld';
export { NavDebug } from './debug';
export type { DebugPath } from './debug';
export { NavObstacles, FootprintCache, colliderFootprint, objectFootprint } from './dynamic';
export type { Footprint, MovingObstacle, NavObstaclesContext, NavObstacleStats } from './dynamic';
export { TRAVERSE, findTraverseLinks } from './traverse';
export type { TraverseConfig } from './traverse';
export { levelGeometry, levelSeeds, navArea, NAV_MARKER_PREFIXES, NAV_SEED_EXCLUDE } from './geometry';
export type { NavGeometry, NavSeed } from './geometry';
export { Unstick, unstickStats, resetUnstickStats } from './unstick';
export type { UnstickAction, UnstickWorld } from './unstick';
export { Watchdog, watchdogStats, resetWatchdogStats, noteEscape } from './watchdog';
export type { WatchdogVerdict } from './watchdog';
export {
  climbRules,
  climbInfo,
  noClimbNode,
  addTraverseBlocker,
  clearTraverseBlockers,
  corridorBlocked,
  levelOfCollider,
  levelAt,
  visibleSolidHit,
  obstacleVisible,
  colliderBox,
} from './climb';
export type { ClimbInfo } from './climb';

/** 기본 에이전트 체격 (m, 도): 작은 사람 크기 */
export const DEFAULT_AGENT = { radius: 0.22, height: 1.2, climb: 0.28, slope: 46 } as const;

export interface NavLink {
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** 기본 true */
  bidirectional?: boolean;
  /** 끝점 스냅 반지름 (기본 0.4) */
  radius?: number;
}

export interface NavBuildOptions {
  /** 복셀 가로 (m). 기본 0.11 (반지름 0.22 = 2칸) */
  cs?: number;
  /** 복셀 높이 (m). 기본 0.04 (턱 0.28 = 7칸) */
  ch?: number;
  radius?: number;
  height?: number;
  climb?: number;
  slope?: number;
  /** 타일 한 변 (복셀). 기본 64 (≈7 m) */
  tileSize?: number;
  /** 굽는 영역: 마커 경계 + margin (m). 기본 30 */
  margin?: number;
  /** 굽는 영역을 직접 (레벨 루트 navBounds="x0,z0,x1,z1"도 된다) */
  bounds?: THREE.Box3 | null;
  maxObstacles?: number;
  /** 오프메시 링크 (사다리처럼 걸어서 이어지지 않는 두 점) */
  links?: NavLink[];
  /** DOOR_를 장애물로 따라가기 (기본 true) */
  doors?: boolean;
  /** 마커 없는 섬을 뺀다 (기본 true) */
  prune?: boolean;
  /** 낮은 턱(0.3~1.2 m)에서 뛰어내리는 한 방향 링크를 자동으로 (기본 true) */
  dropLinks?: boolean | DropLinkOptions;
  /** 넘기·오르기 링크를 자동으로 (기본 true, nav/traverse.ts). 넘기 동작이 없는 게임은 false */
  traverse?: boolean | TraverseLinkOptions;
  /** 레벨 밖에서 더 넣을 정적 충돌체 */
  extraColliders?: RAPIER.Collider[];
  /** 메인 스레드 일의 프레임 예산 (기본 12 ms 단위로 양보). null이면 양보 없이 한 번에 */
  slicer?: Slicer | null;
  /** 층 굽기 워커 수 (기본: 코어 수 - 2, 1~4). 0이면 메인 스레드에서 나눠 굽는다 */
  workers?: number;
  onProgress?: (f: number) => void;
}

let ready: Promise<void> | null = null;

/**
 * WASM 초기화 (한 번). 로딩 화면 초반에 미리 불러도 된다.
 * WASM 모듈(약 1 MB, base64 내장)은 따로 나눈 청크로 처음 쓸 때 읽는다. 여기서 직접 동적 import하는 것은
 * Vite가 시작할 때 이 의존성을 미리 묶게 하려는 것이다 (core 안의 동적 import만 있으면 첫 실행에 'Outdated Optimize Dep'로 깨진다).
 */
export function initNav(): Promise<void> {
  ready ??= import('@recast-navigation/wasm').then((m) => initRecast(m.default));
  return ready;
}

/** 레벨 → NavWorld. 같은 레벨을 다시 부르면 새로 굽는다 (캐시는 navFor) */
export async function buildNav(level: Level, opts: NavBuildOptions = {}): Promise<NavWorld> {
  const wall0 = performance.now();
  await initNav();
  const heap0 = NavWorld.heapBytes();
  const slicer = opts.slicer === undefined ? new Slicer(12) : opts.slicer;
  const yieldFn = slicer ? () => slicer.tick() : undefined;
  const cs = opts.cs ?? 0.11;
  const ch = opts.ch ?? 0.04;
  const radius = opts.radius ?? DEFAULT_AGENT.radius;
  let mainMs = 0;

  const tg = performance.now();
  const geom = levelGeometry(level, opts.extraColliders);
  if (!geom.triangles) throw new Error(`[nav] ${level.id}: 정적 충돌체가 없다 (physics:false 레벨?)`);
  const seeds = levelSeeds(level);
  const area = navArea(level, geom, levelSeeds(level, true), opts.margin ?? 30, opts.bounds);
  const geometryMs = performance.now() - tg;
  mainMs += geometryMs;
  if (yieldFn) await yieldFn();

  // 아주 큰 레벨: 층 수가 내비메시 타일 한도(2^14)를 넘지 않게 타일을 키운다
  let tileSize = opts.tileSize ?? 64;
  const size = area.getSize(new THREE.Vector3());
  while (Math.ceil(size.x / (tileSize * cs)) * Math.ceil(size.z / (tileSize * cs)) * 3 > 16384 && tileSize < 256) tileSize *= 2;
  const pad = 0.5;
  const config: BakeConfig = {
    bmin: [area.min.x, area.min.y - pad, area.min.z],
    bmax: [area.max.x, area.max.y + pad, area.max.z],
    cs,
    ch,
    radius,
    height: opts.height ?? DEFAULT_AGENT.height,
    climb: opts.climb ?? DEFAULT_AGENT.climb,
    slope: opts.slope ?? DEFAULT_AGENT.slope,
    tileSize,
  };
  const grid = bakeGrid(config);

  // 1) 층 굽기: 워커 여럿에 타일을 나눠 맡긴다 (안 되면 메인에서 나눠서)
  const tr = performance.now();
  let raster: RasterResult | null = null;
  const nWorkers = opts.workers ?? defaultWorkers();
  if (nWorkers > 0 && typeof Worker !== 'undefined') {
    try {
      raster = await rasterizeParallel(geom.positions, geom.indices, geom.solids, config, grid, nWorkers, (f) => opts.onProgress?.(0.8 * f));
    } catch (e) {
      console.warn('[nav] 워커 굽기 실패 → 메인 스레드에서 굽는다', e);
    }
  }
  if (!raster) {
    raster = await rasterizeMain(geom.positions, geom.indices, geom.solids, config, grid, yieldFn, (f) => opts.onProgress?.(0.8 * f));
    mainMs += raster.cpuMs;
  }
  const rasterWall = performance.now() - tr;

  // 2) 타일 캐시·내비메시 (메인)
  const links: OffMeshConnectionParams[] = (opts.links ?? []).map((l, i) => ({
    startPosition: { x: l.a.x, y: l.a.y, z: l.a.z },
    endPosition: { x: l.b.x, y: l.b.y, z: l.b.z },
    radius: l.radius ?? 0.4,
    bidirectional: l.bidirectional ?? true,
    area: 0,
    flags: 1,
    userId: 1000 + i,
  }));
  const asm = await assembleTileCache(config, grid, raster.blobs, {
    maxObstacles: opts.maxObstacles ?? 256,
    links,
    yieldFn,
    onProgress: (f) => opts.onProgress?.(0.8 + 0.18 * f),
  });
  mainMs += asm.meshMs;

  const stats: NavStats = {
    level: level.id,
    triangles: geom.triangles,
    colliders: geom.colliders,
    area: { min: area.min.toArray() as [number, number, number], max: area.max.toArray() as [number, number, number] },
    cs,
    ch,
    tileSize,
    tiles: [grid.tilesX, grid.tilesZ],
    layers: asm.layers,
    polys: 0,
    islands: 0,
    keptIslands: 0,
    prunedPolys: 0,
    workers: raster.workers,
    bytes: { compressed: asm.compressedBytes, navMesh: 0, heapGrowth: 0, heap: 0, workerHeap: raster.heap ?? 0 },
    links: 0,
    timing: { geometry: geometryMs, rasterize: raster.cpuMs, rasterizeWall: rasterWall, workerInit: raster.initMs, mesh: asm.meshMs, prune: 0, links: 0, work: 0, main: 0, wall: 0 },
  };
  const nav = new NavWorld({
    level,
    navMesh: asm.navMesh,
    tileCache: asm.tileCache,
    seeds,
    stats,
    agentRadius: radius,
    prune: opts.prune !== false,
    datas: [...asm.datas, ...asm.owned],
    links,
    orig: config.bmin,
    tileWorld: tileSize * cs,
  });
  if (opts.doors !== false) {
    nav.trackDoors();
    const t = performance.now();
    nav.flush();
    stats.timing.mesh += performance.now() - t;
    mainMs += performance.now() - t;
  }
  stats.timing.prune = nav.labelIslands();
  mainMs += stats.timing.prune;
  // 뛰어내리기 링크 (낮은 턱으로 갈라진 섬을 잇는다). 경계 변 표본·삼각형 격자는 넘기 링크와 같이 쓴다
  const shared: { samples?: ReturnType<typeof boundarySamples>; grid?: TriGrid } = {};
  if (opts.dropLinks !== false || opts.traverse !== false) {
    const t = performance.now();
    shared.samples = boundarySamples(nav);
    shared.grid = new TriGrid(geom);
    stats.timing.links += performance.now() - t;
    mainMs += performance.now() - t;
  }
  if (opts.dropLinks !== false) {
    const t = performance.now();
    const drops = findDropLinks(nav, geom, config.climb, typeof opts.dropLinks === 'object' ? opts.dropLinks : {}, shared);
    nav.addLinks(drops);
    stats.links = drops.length;
    stats.timing.links += performance.now() - t;
    mainMs += performance.now() - t;
  }
  // 넘기·오르기 링크 (얇은 장애물 너머·턱 위로: 게임 쪽 이동 코드가 넘기 동작으로 지나간다, NavWorld.traverseAt)
  if (opts.traverse !== false) {
    const t = performance.now();
    const to = typeof opts.traverse === 'object' ? opts.traverse : {};
    // 몸 키는 굽기 키를 따른다 (따로 주지 않았으면)
    const spec = { height: config.height, ...to.spec };
    const tr = await findTraverseLinks(nav, geom, level, { ...to, spec }, { ...shared, yieldFn });
    const ta = performance.now();
    nav.addTraverseLinks(tr.links);
    const ms = tr.stats.ms + (performance.now() - ta);
    void t;
    stats.traverse = { ...tr.stats, ms, addMs: performance.now() - ta };
    stats.timing.links += ms;
    mainMs += ms;
  }
  // 내비메시 타일 데이터 크기
  let bytes = 0;
  for (let i = 0; i < asm.navMesh.getMaxTiles(); i++) {
    const tile = asm.navMesh.getTile(i);
    if (tile.header()) bytes += tile.dataSize();
  }
  stats.bytes.navMesh = bytes;
  stats.bytes.heap = NavWorld.heapBytes();
  stats.bytes.heapGrowth = stats.bytes.heap - heap0;
  stats.timing.work = stats.timing.geometry + stats.timing.rasterize + stats.timing.mesh + stats.timing.prune + stats.timing.links;
  stats.timing.main = mainMs;
  stats.timing.wall = performance.now() - wall0;
  opts.onProgress?.(1);
  return nav;
}

// ---------------------------------------------------------------------- 층 굽기 (워커 / 메인)

interface RasterResult {
  blobs: Uint8Array[];
  /** 굽기 CPU 시간 합 (ms) */
  cpuMs: number;
  /** 워커 WASM 준비 (가장 늦은 것, ms) */
  initMs: number;
  workers: number;
  /** 워커 WASM 힙 (가장 큰 것, 바이트) */
  heap?: number;
}

function defaultWorkers(): number {
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(4, hc - 2));
}

/** 워커 풀: 굽기가 끝나고 15초 동안 안 쓰면 닫는다 (워커마다 WASM 힙이 있다) */
let pool: Worker[] = [];
let poolTimer: ReturnType<typeof setTimeout> | null = null;
let reqId = 1;

function getWorkers(n: number): Worker[] {
  if (poolTimer) clearTimeout(poolTimer);
  poolTimer = null;
  while (pool.length < n) pool.push(new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' }));
  return pool.slice(0, n);
}

function releaseWorkers(): void {
  if (poolTimer) clearTimeout(poolTimer);
  poolTimer = setTimeout(() => {
    for (const w of pool) w.terminate();
    pool = [];
    poolTimer = null;
  }, 15000);
}

async function rasterizeParallel(positions: Float32Array, indices: Uint32Array, solids: SolidPrism[], config: BakeConfig, grid: BakeGrid, n: number, onProgress?: (f: number) => void): Promise<RasterResult> {
  const total = grid.tilesX * grid.tilesZ;
  n = Math.max(1, Math.min(n, total));
  const lists: number[][] = Array.from({ length: n }, () => []);
  // 줄무늬로 나눈다 (빈 곳·붐비는 곳이 한 워커에 몰리지 않게)
  for (let i = 0; i < total; i++) lists[i % n].push(i % grid.tilesX, Math.floor(i / grid.tilesX));
  const workers = getWorkers(n);
  let done = 0;
  try {
    const replies = await Promise.all(
      workers.map(
        (w, k) =>
          new Promise<BakeReply>((resolve, reject) => {
            const id = reqId++;
            const onMsg = (e: MessageEvent<BakeReply>) => {
              if (e.data.id !== id) return;
              w.removeEventListener('message', onMsg);
              w.removeEventListener('error', onErr);
              if (e.data.error) reject(new Error(e.data.error));
              else {
                onProgress?.(++done / n);
                resolve(e.data);
              }
            };
            const onErr = (e: ErrorEvent) => {
              w.removeEventListener('message', onMsg);
              w.removeEventListener('error', onErr);
              reject(new Error(e.message || '워커 오류'));
            };
            w.addEventListener('message', onMsg);
            w.addEventListener('error', onErr);
            const req: BakeRequest = { id, positions, indices, solids, config, tiles: Int32Array.from(lists[k]) };
            w.postMessage(req);
          }),
      ),
    );
    const blobs: Uint8Array[] = [];
    let cpu = 0;
    let init = 0;
    let heap = 0;
    for (const r of replies) {
      blobs.push(...(r.blobs ?? []));
      cpu += r.ms ?? 0;
      init = Math.max(init, r.initMs ?? 0);
      heap = Math.max(heap, r.heap ?? 0);
    }
    return { blobs, cpuMs: cpu, initMs: init, workers: n, heap };
  } catch (e) {
    // 고장 난 워커는 버린다
    for (const w of pool) w.terminate();
    pool = [];
    throw e;
  } finally {
    releaseWorkers();
  }
}

async function rasterizeMain(positions: Float32Array, indices: Uint32Array, solids: SolidPrism[], config: BakeConfig, grid: BakeGrid, yieldFn?: () => Promise<void> | void, onProgress?: (f: number) => void): Promise<RasterResult> {
  const r = new TileRasterizer(positions, indices, config, solids);
  const blobs: Uint8Array[] = [];
  let cpu = 0;
  const total = grid.tilesX * grid.tilesZ;
  let k = 0;
  for (let y = 0; y < grid.tilesZ; y++) {
    for (let x = 0; x < grid.tilesX; x++) {
      const s = performance.now();
      blobs.push(...r.rasterize(x, y));
      cpu += performance.now() - s;
      k++;
      if (yieldFn) {
        onProgress?.(k / total);
        await yieldFn();
      }
    }
  }
  r.destroy();
  return { blobs, cpuMs: cpu, initMs: 0, workers: 0 };
}

// ---------------------------------------------------------------------- 레벨별 캐시와 로딩 훅

const cache = new WeakMap<Level, Promise<NavWorld>>();
const settled = new WeakMap<Level, NavWorld>();
/** 살아 있는 NavWorld (updateAttachedNavs) */
const live = new Set<NavWorld>();
// 판이 끝나면 내비(Recast WASM 힙)를 놓는다 (같은 페이지에서 다음 판이 레벨을 새로 읽는다)
onSessionEnd(() => {
  for (const n of live) n.dispose();
  live.clear();
  // Recast(emscripten) 래퍼 캐시: 포인터마다 만든 JS 객체(dtLink·dtPoly·dtMeshTile …)를 클래스의 __cache__에 영영 둔다 (destroy한 것만 뺀다).
  // 내비를 다 버렸으니 비운다: 같은 페이지에서 판마다 수만 개씩 쌓였다. 캐시는 포인터 → 래퍼일 뿐이라 필요하면 다시 만든다
  const mod = (Raw as unknown as { Module?: Record<string, unknown> }).Module;
  if (mod) {
    for (const k of Object.keys(mod)) {
      const cache = (mod[k] as { __cache__?: Record<string, unknown> } | null)?.__cache__;
      if (cache && typeof cache === 'object') for (const p of Object.keys(cache)) delete cache[p];
    }
  }
});

/** 붙은 레벨의 내비마다 update() (문·장애물 반영). 게임 시스템이 자기 내비를 직접 부르면 필요 없다. 두 번 불러도 된다 */
export function updateAttachedNavs(): void {
  for (const n of live) {
    if (n.isDisposed) live.delete(n);
    else if (n.level.attached) n.update();
  }
}

/** 이 레벨의 NavWorld (처음 부르면 굽는다. 같은 Promise를 돌려준다) */
export function navFor(level: Level, opts?: NavBuildOptions): Promise<NavWorld> {
  let p = cache.get(level);
  if (!p) {
    p = buildNav(level, opts);
    cache.set(level, p);
    p.then((nav) => {
      live.add(nav);
      settled.set(level, nav);
      console.info(`[nav] ${level.id}: ${fmtStats(nav.stats)}`);
    }, (e) => console.warn(`[nav] ${level.id} 굽기 실패`, e));
  }
  return p;
}

/** 이미 구워졌으면 바로 (아니면 null). 게임 시스템이 매 프레임 물어볼 때 */
export function navNow(level: Level | null | undefined): NavWorld | null {
  if (!level) return null;
  const n = settled.get(level);
  if (n && !n.isDisposed) return n;
  return null;
}

/** 레벨을 버릴 때 (WASM 메모리 해제) */
export async function disposeNav(level: Level): Promise<void> {
  const p = cache.get(level);
  cache.delete(level);
  settled.delete(level);
  if (p) (await p.catch(() => null))?.dispose();
}

/**
 * 로딩 화면 훅: 로딩 표시(level/loading.ts LoadTracker)에 '경로 계산' 항목으로 굽는다.
 *   await prepareNav(tracker, level);   // loadLevel 뒤
 */
export function prepareNav(
  loader: { track<T>(id: string, label: string, weight: number, p: Promise<T>): Promise<T>; partial?: (id: string, f: number) => void },
  level: Level,
  label = 'navigation',
  opts: NavBuildOptions = {},
): Promise<NavWorld> {
  const id = `nav_${level.id}`;
  return loader.track(id, label, 1, navFor(level, { ...opts, onProgress: (f) => loader.partial?.(id, f) }));
}

export function fmtStats(s: NavStats): string {
  const kb = (b: number) => `${(b / 1024).toFixed(0)}KB`;
  const t = s.timing;
  const f = (x: number) => x.toFixed(0);
  return `${s.triangles} tris, 타일 ${s.tiles[0]}x${s.tiles[1]} (층 ${s.layers}), 폴리곤 ${s.polys} (섬 ${s.islands}, 유지 ${s.keptIslands}, 뺌 ${s.prunedPolys}), `
    + `벽시계 ${f(t.wall)}ms (층 ${f(t.rasterizeWall)}${s.workers ? ` · 워커 ${s.workers}개 CPU ${f(t.rasterize)} · 준비 ${f(t.workerInit)}` : ''} · 메시 ${f(t.mesh)} · 섬 ${f(t.prune)} · 링크 ${s.links}개 ${f(t.links)}`
    + `${s.traverse ? ` · 넘기 ${s.traverse.vault}·오르기 ${s.traverse.mantle}${s.traverse.manual ? `·마커 ${s.traverse.manual}` : ''} ${f(s.traverse.ms)}` : ''}), 메인 스레드 ${f(t.main)}ms, `
    + `메모리 압축 ${kb(s.bytes.compressed)} · 내비메시 ${kb(s.bytes.navMesh)}`;
}
