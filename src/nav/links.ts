import * as THREE from 'three';
import type { OffMeshConnectionParams } from '@recast-navigation/core';
import type { NavGeometry } from './geometry';
import type { NavWorld } from './NavWorld';

/**
 * 자동 '뛰어내리기' 링크: 낮은 턱(오르지는 못하지만 내려갈 수는 있는 0.3~1.2 m 단)으로 갈라진 섬을 한 방향으로 잇는다.
 * 예) 0.6 m 상자 충돌체로 만든 언덕 위에서 시작한 캐릭터가 내려와야 할 때.
 *
 * 1) 유지하는 섬의 경계 변을 1 m 간격으로 짚고, 바깥으로 0.8 m 나간 자리 아래에서 다른 섬의 바닥을 찾는다
 * 2) 턱 위 0.5 m 높이에서 착지점까지 수평, 착지점 위 수직 선분이 레벨 형상에 막히지 않아야 한다 (난간·벽 너머 제외)
 * 3) 섬 쌍마다 4 m 넘게 떨어진 것만 남긴다 (쌍마다 24개, 모두 400개까지)
 * 링크는 한 방향(위 → 아래)이다. Detour 경로는 방향을 지키고, isReachable(섬 비교)은 근사로 양쪽을 같은 섬으로 본다.
 */

export interface DropLinkOptions {
  /** 뛰어내릴 수 있는 최대 높이 (m). 기본 1.2 */
  maxDrop?: number;
  /** 바깥으로 짚는 거리 (m). 기본 반지름×2 + 0.35 */
  reach?: number;
  /** 같은 섬 쌍 안에서 링크 사이 최소 거리 (m). 기본 4 */
  spacing?: number;
  /** 섬 쌍마다 최대 개수. 기본 24 */
  maxPerPair?: number;
  /** 전체 최대. 기본 400 */
  maxTotal?: number;
}

/** 형상 삼각형 2D 격자 (선분 막힘 검사용. 넘기·오르기 링크도 쓴다: nav/traverse.ts) */
export class TriGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly size = 2;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly e1 = new THREE.Vector3();
  private readonly e2 = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly t = new THREE.Vector3();
  private readonly q = new THREE.Vector3();
  private stamp = 0;
  private readonly seen: Int32Array;

  constructor(private readonly g: NavGeometry) {
    const P = g.positions;
    const I = g.indices;
    this.seen = new Int32Array(I.length / 3);
    for (let t = 0; t < I.length; t += 3) {
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const i = I[t + k] * 3;
        x0 = Math.min(x0, P[i]);
        x1 = Math.max(x1, P[i]);
        z0 = Math.min(z0, P[i + 2]);
        z1 = Math.max(z1, P[i + 2]);
      }
      const cx0 = Math.floor(x0 / this.size);
      const cx1 = Math.floor(x1 / this.size);
      const cz0 = Math.floor(z0 / this.size);
      const cz1 = Math.floor(z1 / this.size);
      // 아주 큰 삼각형(바닥 한 장)도 칸마다 넣는다. 칸이 너무 많으면(>4096) 건너뛴다: 바닥판은 막힘 검사에 필요 없다
      if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 4096) continue;
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const key = cx * 73856093 ^ cz * 19349663;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(t / 3);
        }
      }
    }
  }

  /** 선분 p0→p1이 어떤 삼각형에 막히나 */
  blocked(p0: THREE.Vector3, p1: THREE.Vector3): boolean {
    const s = this.size;
    const cx0 = Math.floor(Math.min(p0.x, p1.x) / s);
    const cx1 = Math.floor(Math.max(p0.x, p1.x) / s);
    const cz0 = Math.floor(Math.min(p0.z, p1.z) / s);
    const cz1 = Math.floor(Math.max(p0.z, p1.z) / s);
    this.stamp++;
    const dir = this.q.copy(p1).sub(p0);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const list = this.cells.get(cx * 73856093 ^ cz * 19349663);
        if (!list) continue;
        for (const tri of list) {
          if (this.seen[tri] === this.stamp) continue;
          this.seen[tri] = this.stamp;
          if (this.hit(tri, p0, dir)) return true;
        }
      }
    }
    return false;
  }

  /** 선분 p0→p1이 처음 닿는 삼각형의 비율 t (0~1). 안 닿으면 -1 */
  firstHit(p0: THREE.Vector3, p1: THREE.Vector3): number {
    const s = this.size;
    const cx0 = Math.floor(Math.min(p0.x, p1.x) / s);
    const cx1 = Math.floor(Math.max(p0.x, p1.x) / s);
    const cz0 = Math.floor(Math.min(p0.z, p1.z) / s);
    const cz1 = Math.floor(Math.max(p0.z, p1.z) / s);
    this.stamp++;
    const dir = this.q.copy(p1).sub(p0);
    let best = -1;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const list = this.cells.get(cx * 73856093 ^ cz * 19349663);
        if (!list) continue;
        for (const tri of list) {
          if (this.seen[tri] === this.stamp) continue;
          this.seen[tri] = this.stamp;
          if (this.hit(tri, p0, dir) && (best < 0 || this.lastT < best)) best = this.lastT;
        }
      }
    }
    return best;
  }

  /** 마지막 hit()의 t */
  private lastT = 0;

  /** Möller–Trumbore, 0 < t < 1 */
  private hit(tri: number, o: THREE.Vector3, d: THREE.Vector3): boolean {
    const P = this.g.positions;
    const I = this.g.indices;
    const ia = I[tri * 3] * 3;
    const ib = I[tri * 3 + 1] * 3;
    const ic = I[tri * 3 + 2] * 3;
    this.a.set(P[ia], P[ia + 1], P[ia + 2]);
    this.b.set(P[ib], P[ib + 1], P[ib + 2]);
    this.c.set(P[ic], P[ic + 1], P[ic + 2]);
    this.e1.subVectors(this.b, this.a);
    this.e2.subVectors(this.c, this.a);
    this.p.crossVectors(d, this.e2);
    const det = this.e1.dot(this.p);
    if (Math.abs(det) < 1e-9) return false;
    const inv = 1 / det;
    this.t.subVectors(o, this.a);
    const u = this.t.dot(this.p) * inv;
    if (u < 0 || u > 1) return false;
    this.t.cross(this.e1);
    const v = d.dot(this.t) * inv;
    if (v < 0 || u + v > 1) return false;
    const tt = this.e2.dot(this.t) * inv;
    this.lastT = tt;
    return tt > 1e-4 && tt < 1 - 1e-4;
  }
}

/** 남은 섬(가지치기 뒤)의 경계 변 표본: 변마다 1 m 간격, 바깥 법선. 뛰어내리기·넘기 링크가 같이 쓴다 (WASM 호출을 한 번만) */
export interface EdgeSample {
  p: THREE.Vector3;
  n: THREE.Vector3;
  island: number;
}

export function boundarySamples(nav: NavWorld): EdgeSample[] {
  const nm = nav.navMesh;
  const out: EdgeSample[] = [];
  const max = nm.getMaxTiles();
  for (let ti = 0; ti < max; ti++) {
    const tile = nm.getTile(ti);
    const h = tile.header();
    if (!h) continue;
    const base = nm.getPolyRefBase(tile);
    // 꼭짓점은 경계 변이 있는 폴리곤 것만 읽는다 (WASM 호출 하나하나가 비싸다)
    const vcache = new Map<number, [number, number, number]>();
    const vert = (i: number): [number, number, number] => {
      let v = vcache.get(i);
      if (!v) vcache.set(i, (v = [tile.verts(i * 3), tile.verts(i * 3 + 1), tile.verts(i * 3 + 2)]));
      return v;
    };
    for (let j = 0; j < h.polyCount(); j++) {
      const poly = tile.polys(j);
      if (poly.getType() === 1 || poly.flags() === 0) continue;
      const nv = poly.vertCount();
      const neis: number[] = [];
      let edge = false;
      for (let k = 0; k < nv; k++) {
        const x = poly.neis(k);
        neis.push(x);
        if (x === 0) edge = true;
      }
      if (!edge) continue;
      const from = nav.islandOf(base + j);
      if (!nav.isKeptIsland(from)) continue;
      const idx: number[] = [];
      let cx = 0;
      let cz = 0;
      for (let k = 0; k < nv; k++) {
        const v = poly.verts(k);
        idx.push(v);
        cx += vert(v)[0];
        cz += vert(v)[2];
      }
      cx /= nv;
      cz /= nv;
      for (let k = 0; k < nv; k++) {
        if (neis[k] !== 0) continue; // 경계 변만 (타일 이음은 외부 링크 비트)
        const a = vert(idx[k]);
        const b = vert(idx[(k + 1) % nv]);
        const ex = b[0] - a[0];
        const ez = b[2] - a[2];
        const len = Math.hypot(ex, ez);
        if (len < 0.3) continue;
        const n = new THREE.Vector3(ez / len, 0, -ex / len);
        const mx = (a[0] + b[0]) / 2;
        const mz = (a[2] + b[2]) / 2;
        if (n.x * (mx - cx) + n.z * (mz - cz) < 0) n.negate();
        const steps = Math.max(1, Math.floor(len / 1.0));
        for (let s = 0; s < steps; s++) {
          const f = (s + 0.5) / steps;
          out.push({ p: new THREE.Vector3(a[0] + ex * f, a[1] + (b[1] - a[1]) * f, a[2] + ez * f), n, island: from });
        }
      }
    }
  }
  return out;
}

/** 뛰어내리기 링크 후보를 찾는다 (NavWorld.addLinks로 넣는다). samples·grid를 주면 다시 만들지 않는다 */
export function findDropLinks(nav: NavWorld, geom: NavGeometry, climb: number, opts: DropLinkOptions = {}, shared: { samples?: EdgeSample[]; grid?: TriGrid } = {}): OffMeshConnectionParams[] {
  const maxDrop = opts.maxDrop ?? 1.2;
  const reach = opts.reach ?? nav.agentRadius * 2 + 0.35;
  const spacing = opts.spacing ?? 4;
  const maxPerPair = opts.maxPerPair ?? 24;
  const maxTotal = opts.maxTotal ?? 400;
  const minDrop = climb + 0.06;
  const grid = shared.grid ?? new TriGrid(geom);
  const samples = shared.samples ?? boundarySamples(nav);
  const out: OffMeshConnectionParams[] = [];
  const pairs = new Map<string, THREE.Vector3[]>();
  const q = new THREE.Vector3();
  const up0 = new THREE.Vector3();
  const up1 = new THREE.Vector3();
  const down = new THREE.Vector3();
  for (const { p, n, island: from } of samples) {
    if (out.length >= maxTotal) break;
    q.copy(p).addScaledVector(n, reach);
    const land = nav.query.findNearestPoly({ x: q.x, y: p.y - (minDrop + maxDrop) / 2, z: q.z }, { halfExtents: { x: 0.35, y: (maxDrop - minDrop) / 2 + 0.05, z: 0.35 }, filter: nav.filter });
    if (!land.success || !land.nearestRef) continue;
    const L = land.nearestPoint;
    const drop = p.y - L.y;
    if (drop < minDrop || drop > maxDrop) continue;
    const to = nav.islandOf(land.nearestRef);
    if (to === from || to < 0) continue;
    // 막힘: 턱 위 0.5 m에서 착지점 위까지, 착지점 위에서 바닥 바로 위까지
    up0.set(p.x, p.y + 0.5, p.z);
    up1.set(L.x, p.y + 0.5, L.z);
    down.set(L.x, L.y + 0.12, L.z);
    if (grid.blocked(up0, up1) || grid.blocked(up1, down)) continue;
    const key = `${from}>${to}`;
    const list = pairs.get(key) ?? [];
    if (list.length >= maxPerPair || list.some((o) => o.distanceTo(p) < spacing)) continue;
    list.push(p.clone());
    pairs.set(key, list);
    // 시작점은 턱 안쪽으로 조금 (폴리곤 위), 끝점은 착지점
    out.push({
      startPosition: { x: p.x - n.x * 0.1, y: p.y, z: p.z - n.z * 0.1 },
      endPosition: { x: L.x, y: L.y, z: L.z },
      radius: nav.agentRadius,
      bidirectional: false,
      area: 0,
      flags: 1,
      userId: 2000 + out.length,
    });
  }
  return out;
}
