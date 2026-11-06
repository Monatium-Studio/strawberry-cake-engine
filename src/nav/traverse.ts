import * as THREE from 'three';
import type { Level } from '../level/Level';
import { climbInfo, corridorBlocked, obstacleVisible } from './climb';
import type { NavGeometry } from './geometry';
import { TriGrid, boundarySamples, type EdgeSample } from './links';
import { MANTLE_COST, VAULT_COST, type NavWorld, type TraverseLinkRec } from './NavWorld';

/**
 * 넘기·오르기 치수 (m). 기본값은 키 1.2 m·반지름 0.22 m 캐릭터에 맞춘 것이다 (가슴·어깨 높이까지 넘기, 팔을 뻗은 손 높이까지 오르기).
 * 다른 체격이면 굽기 전에 바꾸거나(TRAVERSE.mantleMax = …) buildNav의 traverse 옵션에 spec을 준다.
 */
export interface TraverseConfig {
  /** 링크의 최소 높이: 걸어 오를 수 있는 턱(climb) 위면 전부 (점프하지 않는 캐릭터) */
  minHeight: number;
  /** 오르기 최대 높이 (발 기준 윗면) */
  mantleMax: number;
  /** 넘기로 보는 장애물 두께 상한 */
  vaultDepth: number;
  /** 몸 키 (윗면 위로 몸이 지나갈 틈·머리 위 틈) */
  height: number;
}

export const TRAVERSE: TraverseConfig = { minHeight: 0.34, mantleMax: 1.5, vaultDepth: 0.9, height: 1.2 };

/**
 * 자동 넘기·오르기 링크 (굽기 때 한 번, 내비와 같이 캐시된다).
 * 치수는 TraverseConfig (기본 TRAVERSE). 점프하지 않는 캐릭터를 생각해 최소 높이는 오르기 턱 바로 위(minHeight 0.34 m)다.
 *
 * 1) 남은 섬(가지치기에서 살아남은, 사람이 다니는 내비)의 경계 변을 1 m 간격으로 짚고, 발 위 0.36 m에서 바깥으로
 *    0.75 m 선분이 레벨 형상에 닿는지 본다 (장애물이 바로 앞에 있나: 낭떠러지·빈 경계는 여기서 끝). 면 너머가
 *    오르기 높이보다 높으면(건물 벽) 끝
 * 2) 면 너머 0.2 m씩 내비 폴리곤을 찾는다. 처음 찾은 것이
 *      - 발보다 minHeight~mantleMax 높으면 오르기 후보 (윗면)
 *      - 발 높이 ±0.6 m(반대편이 1.6 m까지 낮아도 됨)면 넘기 후보 (반대편 바닥)
 * 3) 형상 검사 (삼각형 격자 선분): 넘기는 장애물 윗면 높이(이분 탐색)·두께(vaultDepth 안)·윗면 위로 몸이 지나갈 틈,
 *    오르기는 면이 가까운가·가장자리가 윗면 높이에 있나·머리 위 틈. 넘을 수 없는 얇은 메시·climb=0 통로(nav/climb.ts),
 *    보이는 장애물(레벨 보이는 형상)
 * 4) 걸어서 둘러 가는 길이 링크 길이 × 길 비용 배율(넘기 3·오르기 4, NavWorld) 안이면 만들지 않는다 (Detour가 고를 일이 없는 링크)
 * 5) 같은 종류 링크끼리 1.6 m 넘게 떨어진 것만 (양방향이라 반대쪽에서 찾은 같은 링크도 거른다)
 * 손으로 놓기: 빈 오브젝트 NAVLINK_<id>_a / NAVLINK_<id>_b (a 쪽 속성 kind = vault | mantle, 오르기는 a가 아래).
 */

export interface TraverseLinkOptions {
  /** 링크 사이 최소 거리 (m). 기본 1.6 */
  spacing?: number;
  /** 전체 상한. 기본 400 */
  maxTotal?: number;
  /** 치수 (기본 TRAVERSE) */
  spec?: Partial<TraverseConfig>;
  /** 넘기 막이 부피(addTraverseBlocker)도 본다. 기본 false */
  blockers?: boolean;
}

export interface TraverseLinkStats {
  vault: number;
  mantle: number;
  manual: number;
  samples: number;
  candidates: number;
  pathChecks: number;
  ms: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

export async function findTraverseLinks(
  nav: NavWorld,
  geom: NavGeometry,
  level: Level,
  opts: TraverseLinkOptions = {},
  shared: { samples?: EdgeSample[]; grid?: TriGrid; yieldFn?: () => Promise<void> | void } = {},
): Promise<{ links: TraverseLinkRec[]; stats: TraverseLinkStats }> {
  const t0 = performance.now();
  const sp: TraverseConfig = { ...TRAVERSE, ...opts.spec };
  const withBlockers = !!opts.blockers;
  const spacing = opts.spacing ?? 1.6;
  const maxTotal = opts.maxTotal ?? 400;
  const tg0 = performance.now();
  const grid = shared.grid ?? new TriGrid(geom);
  const samples = shared.samples ?? boundarySamples(nav);
  const tg1 = performance.now();
  const info = climbInfo(level);
  const tg2 = performance.now();
  const stats: TraverseLinkStats = { vault: 0, mantle: 0, manual: 0, samples: 0, candidates: 0, pathChecks: 0, ms: 0 };
  const out: TraverseLinkRec[] = [];
  const prof = { pre: 0, probe: 0, check: 0, path: 0, grid: tg1 - tg0, climb: tg2 - tg1, thinTris: info.thinTris, cells: info.cells.size };
  const near = new Map<number, TraverseLinkRec[]>();
  const nkey = (x: number, z: number) => (Math.floor(x / 2) + 32768) * 65536 + (Math.floor(z / 2) + 32768);
  /** 이미 링크가 있는 자리 (경계 표본 p 둘레 r m: 비싼 검사 전에 거른다) */
  const taken = (x: number, z: number, y: number, r: number): boolean => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const o of near.get(nkey(x + dx * 2, z + dz * 2)) ?? []) {
          if (Math.abs(o.a.y - y) > 1.6 && Math.abs(o.b.y - y) > 1.6) continue;
          if (Math.min(Math.hypot(o.a.x - x, o.a.z - z), Math.hypot(o.b.x - x, o.b.z - z)) < r) return true;
        }
      }
    }
    return false;
  };
  const crowded = (r: TraverseLinkRec): boolean => {
    const mx = (r.a.x + r.b.x) / 2;
    const mz = (r.a.z + r.b.z) / 2;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const o of near.get(nkey(mx + dx * 2, mz + dz * 2)) ?? []) {
          if (o.kind !== r.kind) continue;
          if (Math.abs((o.a.y + o.b.y) / 2 - (r.a.y + r.b.y) / 2) > 1) continue;
          if (Math.hypot((o.a.x + o.b.x) / 2 - mx, (o.a.z + o.b.z) / 2 - mz) < spacing) return true;
        }
      }
    }
    return false;
  };
  const add = (r: TraverseLinkRec) => {
    out.push(r);
    const k = nkey((r.a.x + r.b.x) / 2, (r.a.z + r.b.z) / 2);
    let l = near.get(k);
    if (!l) near.set(k, (l = []));
    l.push(r);
    if (r.manual) stats.manual++;
    else stats[r.kind]++;
  };

  // 손으로 놓은 링크
  for (const [name, o] of level.nodes) {
    const m = /^NAVLINK_(.+)_a$/.exec(name);
    if (!m) continue;
    const ob = level.nodes.get(`NAVLINK_${m[1]}_b`);
    if (!ob) continue;
    const a = nav.closestPoint(o.getWorldPosition(new THREE.Vector3()), 1);
    const b = nav.closestPoint(ob.getWorldPosition(new THREE.Vector3()), 1);
    if (!a || !b) {
      console.warn(`[nav] ${name}: 내비 위가 아니다`);
      continue;
    }
    const kind = String(o.userData.kind ?? 'vault') === 'mantle' ? 'mantle' : 'vault';
    const top = kind === 'mantle' ? b.y : obstacleTop(grid, a, b, sp.mantleMax) ?? Math.max(a.y, b.y) + 0.8;
    const face = faceDistance(grid, a, b, Math.min(top, a.y + 0.36));
    add({ id: 0, kind, a, b, top, faceA: face ?? 0.25, depth: kind === 'mantle' ? Infinity : Math.max(0.1, a.distanceTo(b) - 0.5), manual: true, blockedUntil: 0, busyUntil: 0 });
  }

  const q = new THREE.Vector3();
  // 로딩 화면이 멈추지 않게 10 ms마다 양보한다 (굽기 slicer). 쓴 시간(ms)은 양보한 시간을 뺀 것
  let slice = performance.now();
  let yielded = 0;
  for (const { p, n } of samples) {
    if (out.length >= maxTotal) break;
    if (shared.yieldFn && performance.now() - slice > 10) {
      const y0 = performance.now();
      await shared.yieldFn();
      slice = performance.now();
      yielded += slice - y0;
    }
    stats.samples++;
    const tf0 = performance.now();
    if (taken(p.x, p.z, p.y, spacing * 0.75)) {
      prof.pre += performance.now() - tf0;
      continue;
    }
    // 1) 바로 앞에 장애물이 있나 (발 위 0.36 m, 0.75 m 안)
    _a.set(p.x, p.y + 0.36, p.z);
    _b.set(p.x + n.x * 0.75, p.y + 0.36, p.z + n.z * 0.75);
    const th = grid.firstHit(_a, _b);
    if (th < 0 || th * 0.75 > 0.7) {
      prof.pre += performance.now() - tf0;
      continue;
    }
    const faceD = th * 0.75;
    // 면 바로 너머가 오르기 높이보다 높은 벽이면 끝 (건물 벽 대부분이 여기서 빠진다)
    _a.y = _b.y = p.y + sp.mantleMax + 0.05;
    _b.set(p.x + n.x * (faceD + 0.3), _b.y, p.z + n.z * (faceD + 0.3));
    const tall = grid.blocked(_a, _b);
    prof.pre += performance.now() - tf0;
    if (tall) continue;
    // 2) 면 너머 내비 폴리곤
    const tp0 = performance.now();
    let cand: { L: THREE.Vector3; kind: 'vault' | 'mantle' } | null = null;
    for (let d = faceD + 0.25; d <= faceD + sp.vaultDepth + 0.75; d += 0.2) {
      q.set(p.x + n.x * d, p.y + 0.4, p.z + n.z * d);
      const r = nav.query.findNearestPoly(q, { halfExtents: { x: 0.15, y: 1.25, z: 0.15 }, filter: nav.filter });
      if (!r.success || !r.nearestRef) continue;
      const L = r.nearestPoint;
      if (Math.hypot(L.x - q.x, L.z - q.z) > 0.2) continue;
      if (!nav.isKeptIsland(nav.islandOf(r.nearestRef))) continue;
      const dy = L.y - p.y;
      if (dy >= sp.minHeight && dy <= sp.mantleMax + 0.02) cand = { L: new THREE.Vector3(L.x, L.y, L.z), kind: 'mantle' };
      else if (dy <= 0.6 && dy >= -1.6) cand = { L: new THREE.Vector3(L.x, L.y, L.z), kind: 'vault' };
      break;
    }
    prof.probe += performance.now() - tp0;
    if (!cand) continue;
    stats.candidates++;
    const tc0 = performance.now();
    const a = new THREE.Vector3(p.x - n.x * 0.06, p.y, p.z - n.z * 0.06);
    const rec = cand.kind === 'vault' ? checkVault(grid, a, cand.L, n, sp) : checkMantle(grid, a, cand.L, n, sp);
    if (!rec) continue;
    if (crowded(rec)) continue;
    if (corridorBlocked(info, rec.a, rec.b, Math.min(rec.a.y, rec.b.y) + 0.05, rec.top + 0.6, 0.28, withBlockers)) continue;
    if (!visibleObstacle(level, rec, n)) continue;
    prof.check += performance.now() - tc0;
    // 4) 둘러 가는 길이 짧으면 링크가 필요 없다
    stats.pathChecks++;
    const tq0 = performance.now();
    const walk = nav.pathLength(rec.a, rec.b);
    prof.path += performance.now() - tq0;
    // Detour가 이 링크를 고를 수 있을 때만 (걷기 길이가 링크 길이 × 비용 배율보다 길 때)
    const direct = Math.hypot(rec.b.x - rec.a.x, rec.b.z - rec.a.z);
    if (walk < Math.max(direct + 1.5, direct * (rec.kind === 'vault' ? VAULT_COST : MANTLE_COST) - 0.3)) continue;
    add(rec);
    if (out.length >= maxTotal) break;
  }
  stats.ms = performance.now() - t0 - yielded;
  (stats as unknown as { prof: typeof prof }).prof = prof;
  return { links: out, stats };
}

/** a에서 b(수평)로 갈 때 처음 닿는 면까지 거리 (높이 y). 없으면 null */
function faceDistance(grid: TriGrid, a: THREE.Vector3, b: THREE.Vector3, y: number): number | null {
  const D = Math.hypot(b.x - a.x, b.z - a.z);
  const t = grid.firstHit(_c.set(a.x, y, a.z), _d.set(b.x, y, b.z));
  return t < 0 ? null : t * D;
}

/** a → b 사이 장애물 윗면 (a 발 기준 0.36 m에서 막히고, 위로 올라가며 트이는 높이를 이분 탐색). 너무 높으면 null */
function obstacleTop(grid: TriGrid, a: THREE.Vector3, b: THREE.Vector3, maxH: number): number | null {
  const seg = (h: number) => grid.blocked(_c.set(a.x, a.y + h, a.z), _d.set(b.x, a.y + h, b.z));
  let lo = 0.36;
  let hi = maxH + 0.05;
  if (!seg(lo) || seg(hi)) return null;
  for (let i = 0; i < 8; i++) {
    const m = (lo + hi) / 2;
    if (seg(m)) lo = m;
    else hi = m;
  }
  return a.y + hi;
}

/** 수직 선분 (x, z)에서 y0 → y1이 막히나 */
function vertBlocked(grid: TriGrid, p: THREE.Vector3, y0: number, y1: number): boolean {
  return grid.blocked(_c.set(p.x, y0, p.z), _d.set(p.x, y1, p.z));
}

function horzBlocked(grid: TriGrid, a: THREE.Vector3, b: THREE.Vector3, y: number): boolean {
  return grid.blocked(_c.set(a.x, y, a.z), _d.set(b.x, y, b.z));
}

/** 넘기: 얇은 장애물 위로 몸이 지나갈 수 있나 */
function checkVault(grid: TriGrid, a: THREE.Vector3, L: THREE.Vector3, n: THREE.Vector3, sp: TraverseConfig): TraverseLinkRec | null {
  const top = obstacleTop(grid, a, L, sp.mantleMax);
  if (top === null) return null;
  const h = top - a.y;
  if (h < sp.minHeight || h > sp.mantleMax) return null;
  if (L.y > top - 0.3 || L.y < top - 1.6) return null;
  const D = Math.hypot(L.x - a.x, L.z - a.z);
  const y = Math.max(a.y, L.y) + Math.min(0.3, top - Math.max(a.y, L.y) - 0.05);
  const t1 = grid.firstHit(_c.set(a.x, y, a.z), _d.set(L.x, y, L.z));
  const t2 = grid.firstHit(_c.set(L.x, y, L.z), _d.set(a.x, y, a.z));
  if (t1 < 0 || t2 < 0) return null;
  const depth = D * (1 - t1 - t2);
  if (depth <= 0.02 || depth > sp.vaultDepth) return null;
  // 윗면 위로 몸(발 +0.08 ~ 키 − 0.05 m)이 지나갈 틈
  for (const dy of [0.08, sp.height * 0.5, sp.height - 0.05]) if (horzBlocked(grid, a, L, top + dy)) return null;
  if (vertBlocked(grid, a, a.y + 0.3, top + sp.height) || vertBlocked(grid, L, L.y + 0.3, top + sp.height)) return null;
  void n;
  return { id: 0, kind: 'vault', a: a.clone(), b: L.clone(), top, faceA: t1 * D, depth, manual: false, blockedUntil: 0, busyUntil: 0 };
}

/** 오르기: 면이 가깝고 가장자리가 윗면 높이에 있고 머리 위가 트였나 */
function checkMantle(grid: TriGrid, a: THREE.Vector3, L: THREE.Vector3, n: THREE.Vector3, sp: TraverseConfig): TraverseLinkRec | null {
  const h = L.y - a.y;
  if (h < sp.minHeight || h > sp.mantleMax) return null;
  const D = Math.hypot(L.x - a.x, L.z - a.z);
  const face = faceDistance(grid, a, L, a.y + Math.min(0.3, h - 0.05));
  if (face === null || face > 0.7) return null;
  if (horzBlocked(grid, a, L, L.y + 0.06)) return null; // 가장자리 위가 트였다
  if (!horzBlocked(grid, a, L, L.y - 0.12)) return null; // 가장자리가 윗면 높이에 있다 (경사·계단이 아니다)
  for (const dy of [sp.height * 0.5, sp.height - 0.05]) if (horzBlocked(grid, a, L, L.y + dy)) return null;
  if (vertBlocked(grid, a, a.y + 0.3, L.y + sp.height) || vertBlocked(grid, L, L.y + 0.05, L.y + sp.height - 0.05)) return null;
  void n;
  return { id: 0, kind: 'mantle', a: a.clone(), b: L.clone(), top: L.y, faceA: face, depth: Infinity, manual: false, blockedUntil: 0, busyUntil: 0 };
}

/** 장애물이 보이는가 (투명 벽·맵 경계 막이를 넘지 않게). 보이는 형상이 없는 레벨이면 그렇다고 본다 */
function visibleObstacle(level: Level, r: TraverseLinkRec, n: THREE.Vector3): boolean {
  return obstacleVisible(level, r.a, n, r.faceA, r.depth, r.top);
}
