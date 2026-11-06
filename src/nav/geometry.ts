import * as THREE from 'three';
import { RAPIER } from '../physics/Physics';
import type { Level } from '../level/Level';

/**
 * 레벨 → 내비 입력 삼각형.
 *
 * 레벨의 정적 충돌체(`Level.colliders`)를 그대로 읽는다. 그래서 LevelLoader의 충돌 규칙
 * (일반 메시 = 트라이메시, `COL_` = 충돌 전용, `collider=0` = 장식, `collider="box"` = 상자, PROP_ 소품 충돌체)을
 * 따로 흉내 내지 않고 물리와 똑같은 바닥·벽을 본다. `DOOR_`는 키네마틱 바디라 여기에 들어오지 않고
 * NavWorld가 장애물(닫힘/열림)로 따로 다룬다.
 */

/**
 * 속이 찬 기둥 (윗면 수평·옆면 수직인 볼록 충돌체: 상자, 상자꼴 COL_). Recast는 면만 굽기 때문에
 * 키보다 높은 상자 속 바닥이 '걸을 수 있는 방'이 된다 (두 단으로 쌓은 상자 등). 굽기 때 그 속을 지운다.
 */
export interface NavSolid {
  /** 볼록 껍질 xz (x0, z0, x1, z1, …) */
  xz: number[];
  ymin: number;
  ymax: number;
}

export interface NavGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  /** 속이 찬 기둥 (속 지우기) */
  solids: NavSolid[];
  /** 삼각형 수 */
  triangles: number;
  /** 입력 충돌체 수 (형상별) */
  colliders: { trimesh: number; box: number; other: number; skipped: number };
  /** 전체 형상 경계 */
  bounds: THREE.Box3;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** 2D 볼록 껍질 (단조 사슬). 입력 [x, z][] → 반시계 순서 */
function hull2d(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-9) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-9) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * 삼각형들(월드)이 '윗면 수평·옆면 수직'인 닫힌 볼록 기둥이면 NavSolid. 아니면 null.
 * 경사로(쐐기)·건물(오목)·기울어진 상자는 빠진다.
 */
function solidOf(pos: number[], idx: number[], vStart: number, iStart: number): NavSolid | null {
  const nv = pos.length / 3 - vStart;
  const nt = (idx.length - iStart) / 3;
  if (nv < 4 || nv > 64 || nt < 4) return null;
  let ymin = Infinity;
  let ymax = -Infinity;
  const pts: [number, number][] = [];
  for (let i = vStart; i < pos.length / 3; i++) {
    ymin = Math.min(ymin, pos[i * 3 + 1]);
    ymax = Math.max(ymax, pos[i * 3 + 1]);
    pts.push([pos[i * 3], pos[i * 3 + 2]]);
  }
  if (ymax - ymin < 0.3) return null;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const v = new THREE.Vector3();
  let hasTop = false;
  for (let t = iStart; t < idx.length; t += 3) {
    a.fromArray(pos, idx[t] * 3);
    b.fromArray(pos, idx[t + 1] * 3);
    c.fromArray(pos, idx[t + 2] * 3);
    n.subVectors(b, a).cross(v.subVectors(c, a));
    const len = n.length();
    if (len < 1e-8) continue;
    n.divideScalar(len);
    const ny = Math.abs(n.y);
    if (ny > 0.995) {
      if (Math.abs(a.y - ymax) < 0.02) hasTop = true;
      continue;
    }
    if (ny > 0.02) return null; // 경사면
    // 볼록: 모든 점이 이 옆면의 한쪽에
    let pos0 = 0;
    let neg = 0;
    for (let i = vStart; i < pos.length / 3; i++) {
      const d = (pos[i * 3] - a.x) * n.x + (pos[i * 3 + 2] - a.z) * n.z;
      if (d > 0.01) pos0++;
      else if (d < -0.01) neg++;
      if (pos0 && neg) return null;
    }
  }
  if (!hasTop) return null;
  const h = hull2d(pts);
  if (h.length < 3) return null;
  return { xz: h.flat(), ymin, ymax };
}

/** 충돌체 하나를 월드 삼각형으로 (트라이메시·상자·볼록 다면체) */
function colliderTriangles(c: RAPIER.Collider, outPos: number[], outIdx: number[]): 'trimesh' | 'box' | 'other' | null {
  const t = c.translation();
  const r = c.rotation();
  _q.set(r.x, r.y, r.z, r.w);
  const identity = t.x === 0 && t.y === 0 && t.z === 0 && r.x === 0 && r.y === 0 && r.z === 0;
  const base = outPos.length / 3;
  const push = (x: number, y: number, z: number) => {
    if (identity) outPos.push(x, y, z);
    else {
      _v.set(x, y, z).applyQuaternion(_q);
      outPos.push(_v.x + t.x, _v.y + t.y, _v.z + t.z);
    }
  };
  const type = c.shapeType();
  if (type === RAPIER.ShapeType.TriMesh || type === RAPIER.ShapeType.ConvexPolyhedron) {
    const verts = c.vertices();
    const idx = c.indices();
    if (!verts || !idx || idx.length < 3) return null;
    for (let i = 0; i < verts.length; i += 3) push(verts[i], verts[i + 1], verts[i + 2]);
    for (let i = 0; i < idx.length; i++) outIdx.push(base + idx[i]);
    return type === RAPIER.ShapeType.TriMesh ? 'trimesh' : 'other';
  }
  if (type === RAPIER.ShapeType.Cuboid) {
    const h = c.halfExtents();
    if (!h) return null;
    for (let i = 0; i < 8; i++) push(i & 1 ? h.x : -h.x, i & 2 ? h.y : -h.y, i & 4 ? h.z : -h.z);
    // 바깥을 보는 12개 삼각형 (Recast는 방향과 관계없이 경사로만 걷기 판정)
    const F = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5];
    for (const k of F) outIdx.push(base + k);
    return 'box';
  }
  return null;
}

/** 레벨 정적 충돌체 → 삼각형 수프 (extra: 레벨 밖에서 더 넣을 충돌체) */
export function levelGeometry(level: Level, extra: Iterable<RAPIER.Collider> = []): NavGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const solids: NavSolid[] = [];
  const count = { trimesh: 0, box: 0, other: 0, skipped: 0 };
  for (const c of [...level.colliders, ...extra]) {
    if (c.isSensor()) {
      count.skipped++;
      continue;
    }
    const v0 = pos.length / 3;
    const i0 = idx.length;
    const k = colliderTriangles(c, pos, idx);
    if (k) {
      count[k]++;
      const sd = solidOf(pos, idx, v0, i0);
      if (sd) solids.push(sd);
    } else count.skipped++;
  }
  const positions = new Float32Array(pos);
  const bounds = new THREE.Box3();
  for (let i = 0; i < positions.length; i += 3) {
    bounds.expandByPoint(_v.set(positions[i], positions[i + 1], positions[i + 2]));
  }
  return { positions, indices: new Uint32Array(idx), solids, triangles: idx.length / 3, colliders: count, bounds };
}

/**
 * 흐름 마커 접두사: 이 마커들의 경계 + 여유가 내비 영역이 된다. 시드(가지치기)로도 쓴다.
 * 게임이 자기 마커 접두사를 더할 수 있다 (NAV_MARKER_PREFIXES.push('MYMARK_'))
 */
export const NAV_MARKER_PREFIXES: string[] = ['SPAWN_', 'WP_', 'MARK_', 'NPC_', 'TRIG_'];
/**
 * 영역에는 들지만 시드(가지치기)에서는 빠지는 접두사: 바닥이 아닐 수 있는 마커 (선반 위 물건, 의자에 앉은 인물 등).
 * NPC_는 앉은 인물일 수 있어 기본으로 뺀다
 */
export const NAV_SEED_EXCLUDE: string[] = ['NPC_'];

export interface NavSeed {
  name: string;
  position: THREE.Vector3;
}

/**
 * 레벨 마커 (TRIG_는 상자 바닥 가운데). area=true면 영역용 전부, 아니면 가지치기 시드용:
 * NAV_SEED_EXCLUDE 접두사(바닥이 아닐 수 있는 마커)는 시드에서 뺀다.
 */
export function levelSeeds(level: Level, area = false): NavSeed[] {
  const out: NavSeed[] = [];
  level.root.updateMatrixWorld(true);
  for (const [name, o] of level.nodes) {
    const pre = NAV_MARKER_PREFIXES.find((p) => name.startsWith(p));
    if (!pre) continue;
    if (!area && NAV_SEED_EXCLUDE.includes(pre)) continue;
    if (pre === 'TRIG_') {
      const t = level.triggers.get(name.slice(5));
      if (!t) continue;
      // 트리거 상자 바닥 가운데 (회전 반영: 로컬 상자의 바닥 중심을 월드로)
      const b = t.box;
      const local = new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
      out.push({ name, position: local.applyMatrix4(t.object.matrixWorld) });
      continue;
    }
    // 공중 마커는 시드에서 빠진다 (스냅 높이 제한에서 걸러짐)
    out.push({ name, position: o.getWorldPosition(new THREE.Vector3()) });
  }
  return out;
}

/**
 * 내비 영역: 형상 경계 ∩ (마커 경계 + margin). 먼 배경(스카이라인 건물, 큰 지면)을 굽지 않게 한다.
 * 레벨 루트 속성 `navBounds="x0,z0,x1,z1"`(three.js 좌표)이 있으면 그것을 쓴다.
 */
export function navArea(level: Level, geom: NavGeometry, seeds: NavSeed[], margin: number, override?: THREE.Box3 | null): THREE.Box3 {
  const out = geom.bounds.clone();
  if (out.isEmpty()) return out;
  let area: THREE.Box3 | null = override?.clone() ?? null;
  if (!area) {
    const nb = String(level.root.userData.navBounds ?? '').split(/[,\s]+/).filter(Boolean).map(Number);
    if (nb.length === 4 && nb.every(Number.isFinite)) {
      area = new THREE.Box3(new THREE.Vector3(Math.min(nb[0], nb[2]), -Infinity, Math.min(nb[1], nb[3])), new THREE.Vector3(Math.max(nb[0], nb[2]), Infinity, Math.max(nb[1], nb[3])));
    }
  }
  // 영역은 사람이 서는 마커로만 (MARK_·WP_는 먼 원경·연출 지점일 때가 있다: 그 자리는 시드로만 쓴다)
  const core = seeds.filter((s) => !/^(MARK_|WP_)/.test(s.name));
  if (!area && core.length) {
    area = new THREE.Box3();
    for (const s of core) area.expandByPoint(s.position);
    area.expandByVector(new THREE.Vector3(margin, 0, margin));
    area.min.y = -Infinity;
    area.max.y = Infinity;
  }
  if (area) {
    out.min.x = Math.max(out.min.x, area.min.x);
    out.min.z = Math.max(out.min.z, area.min.z);
    out.max.x = Math.min(out.max.x, area.max.x);
    out.max.z = Math.min(out.max.z, area.max.z);
    if (out.min.x >= out.max.x || out.min.z >= out.max.z) return geom.bounds.clone();
  }
  return out;
}
