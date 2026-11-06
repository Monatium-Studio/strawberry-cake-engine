import * as THREE from 'three';
import type { RAPIER } from '../physics/Physics';
import { castRoot } from '../physics/RaycastGeometry';
import { Level } from '../level/Level';

/**
 * 넘기·오르기(vault·mantle) 금지 규칙. 내비 넘기 링크 굽기(nav/traverse.ts)와, 게임이 직접 조작하는 캐릭터의 넘기 판정이
 * 같은 규칙을 쓸 수 있다.
 *
 *   - 넘을 수 없는 얇은 메시: 보이는 메시의 머티리얼·노드 이름이 climbRules.noClimbMesh(기본: wire·barb·razor·concertina 낱말)에
 *     맞는 것. 이런 메시는 충돌체가 실제 형상보다 넓은 상자로 잡혀 충돌체만 보면 넘을 수 있어 보인다. 그 삼각형이 덮는 0.5 m 칸을 막는다
 *   - 노드 속성 `climb=0` (자식에게 상속): 그 노드에서 나온 충돌체를 넘지 않는다
 *   - 넘기 막이 부피 (addTraverseBlocker, 게임 코드가 단다): 특정 구역 밖으로 넘어 나가지 않게 할 때.
 *     방향(toward)을 주면 그쪽으로 넘는 것만 막는다 (돌아오는 넘기는 된다). 막이를 보는 판정만 막힌다 (corridorBlocked의 withBlockers)
 */

export const climbRules: {
  /** 넘을 수 없는 얇은 메시 이름 규칙 (머티리얼·노드 이름). null이면 끈다. 레벨을 처음 볼 때 읽으므로 그 전에 바꾼다 */
  noClimbMesh: RegExp | null;
} = {
  noClimbMesh: /(^|[_\s-])(wire|barb|barbed|razor|concertina)([_\s-]|$|\d)/i,
};

const CELL = 0.5;

export interface ClimbInfo {
  /** 넘을 수 없는 얇은 메시가 지나는 칸 (x, z 0.5 m 격자) → [ymin, ymax] */
  readonly cells: Map<number, [number, number]>;
  /** 넘지 않는 충돌체 (핸들) */
  readonly noClimb: Set<number>;
  /** 넘지 않는 충돌체의 경계 상자 (링크 굽기) */
  readonly boxes: THREE.Box3[];
  /** 넘을 수 없는 얇은 메시의 삼각형 수 (점검) */
  thinTris: number;
  /** 넘기 막이 부피. dir이 있으면 그 수평 방향으로 넘는 것만 막는다 */
  readonly blockers: { box: THREE.Box3; dir: THREE.Vector3 | null; tag: string }[];
}

const key = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);
const cache = new WeakMap<Level, ClimbInfo>();

/** 이 노드(조상 포함)가 넘기·오르기 금지인가 (climb=0) */
export function noClimbNode(o: THREE.Object3D | null, stop: THREE.Object3D | null = null): boolean {
  for (let x = o; x; x = x.parent) {
    const v = x.userData?.climb;
    if (v === 0 || v === '0' || v === false || v === 'false') return true;
    if (x === stop) break;
  }
  return false;
}

function isThinNoClimb(m: THREE.Mesh): boolean {
  const re = climbRules.noClimbMesh;
  if (!re) return false;
  if (re.test(m.name)) return true;
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  return mats.some((x) => !!x && re.test(x.name ?? ''));
}

/** 레벨의 넘기 금지 정보 (처음 부를 때 만든다) */
export function climbInfo(level: Level): ClimbInfo {
  let info = cache.get(level);
  if (info) return info;
  info = { cells: new Map(), noClimb: new Set(), boxes: [], thinTris: 0, blockers: [] };
  cache.set(level, info);
  level.root.updateMatrixWorld(true);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  level.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.isOutline || !isThinNoClimb(m)) return;
    const pos = m.geometry.getAttribute('position');
    if (!pos) return;
    const idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const ia = idx ? idx.getX(i) : i;
      const ib = idx ? idx.getX(i + 1) : i + 1;
      const ic = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos, ib).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(pos, ic).applyMatrix4(m.matrixWorld);
      const x0 = Math.floor(Math.min(a.x, b.x, c.x) / CELL);
      const x1 = Math.floor(Math.max(a.x, b.x, c.x) / CELL);
      const z0 = Math.floor(Math.min(a.z, b.z, c.z) / CELL);
      const z1 = Math.floor(Math.max(a.z, b.z, c.z) / CELL);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 64) continue; // 아주 큰 삼각형(그물 판 한 장)은 칸으로 펴지 않는다: 그런 판은 높아서 넘을 일이 없다
      const y0 = Math.min(a.y, b.y, c.y);
      const y1 = Math.max(a.y, b.y, c.y);
      info!.thinTris++;
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = key(cx, cz);
          const r = info!.cells.get(k);
          if (r) {
            r[0] = Math.min(r[0], y0);
            r[1] = Math.max(r[1], y1);
          } else info!.cells.set(k, [y0, y1]);
        }
      }
    }
  });
  for (const col of level.colliders) {
    const src = level.colliderSource.get(col.handle);
    if (!src || !noClimbNode(src.node, level.root)) continue;
    info.noClimb.add(col.handle);
    info.boxes.push(colliderBox(col));
  }
  return info;
}

/** 충돌체 경계 상자 (월드) */
export function colliderBox(c: RAPIER.Collider, out = new THREE.Box3()): THREE.Box3 {
  out.makeEmpty();
  const t = c.translation();
  const r = c.rotation();
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const v = new THREE.Vector3();
  const verts = c.vertices?.();
  if (verts && verts.length) {
    for (let i = 0; i < verts.length; i += 3) out.expandByPoint(v.set(verts[i], verts[i + 1], verts[i + 2]).applyQuaternion(q).add(t as THREE.Vector3Like));
    return out;
  }
  const h = c.halfExtents?.();
  if (h) {
    for (let i = 0; i < 8; i++) out.expandByPoint(v.set(i & 1 ? h.x : -h.x, i & 2 ? h.y : -h.y, i & 4 ? h.z : -h.z).applyQuaternion(q).add(t as THREE.Vector3Like));
    return out;
  }
  const rad = c.radius?.() ?? 0.5;
  return out.setFromCenterAndSize(new THREE.Vector3(t.x, t.y, t.z), new THREE.Vector3(rad * 2, rad * 2, rad * 2));
}

const _p = new THREE.Vector3();
const _box = new THREE.Box3();
const _seg = new THREE.Box3();

/**
 * 넘기 막이 부피를 레벨에 단다. toward(수평 방향)를 주면 그쪽으로 넘는 것만 막는다.
 * 같은 tag가 이미 있으면 바꾼다 (다시 시작하기에서 여러 번 불러도 하나)
 */
export function addTraverseBlocker(level: Level, box: THREE.Box3, opts: { toward?: THREE.Vector3 | null; tag?: string } = {}): void {
  const list = climbInfo(level).blockers;
  const tag = opts.tag ?? '';
  const dir = opts.toward ? opts.toward.clone().setY(0).normalize() : null;
  const at = tag ? list.findIndex((x) => x.tag === tag) : -1;
  const e = { box: box.clone(), dir, tag };
  if (at >= 0) list[at] = e;
  else list.push(e);
}

/** 넘기 막이 부피를 뗀다: tag가 prefix로 시작하는 것 */
export function clearTraverseBlockers(level: Level, prefix = ''): void {
  const list = climbInfo(level).blockers;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].tag.startsWith(prefix)) list.splice(i, 1);
}

/**
 * a → b 통로(수평 폭 ±half, 높이 y0~y1)가 넘을 수 없는 얇은 메시 칸이나 넘지 않는 충돌체에 닿나.
 * 넘기·오르기 판정마다 한 번 (칸은 0.25 m 간격 표본, 상자는 통로 경계 상자와 겹침). withBlockers면 넘기 막이 부피도 본다
 */
export function corridorBlocked(info: ClimbInfo, a: THREE.Vector3, b: THREE.Vector3, y0: number, y1: number, half = 0.3, withBlockers = false): boolean {
  if (info.cells.size) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const nx = len > 1e-6 ? -dz / len : 0;
    const nz = len > 1e-6 ? dx / len : 0;
    const steps = Math.max(1, Math.ceil(len / 0.25));
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      for (const s of [-half, 0, half]) {
        _p.set(a.x + dx * f + nx * s, 0, a.z + dz * f + nz * s);
        const r = info.cells.get(key(Math.floor(_p.x / CELL), Math.floor(_p.z / CELL)));
        if (r && r[1] > y0 && r[0] < y1) return true;
      }
    }
  }
  if (info.boxes.length || (withBlockers && info.blockers.length)) {
    _seg.makeEmpty().expandByPoint(_p.set(a.x, y0, a.z)).expandByPoint(_p.set(b.x, y1, b.z)).expandByScalar(half);
    for (const bx of info.boxes) if (_box.copy(bx).intersectsBox(_seg)) return true;
    if (withBlockers) {
      for (const pb of info.blockers) {
        if (pb.dir && (b.x - a.x) * pb.dir.x + (b.z - a.z) * pb.dir.z <= 0) continue;
        if (_box.copy(pb.box).intersectsBox(_seg)) return true;
      }
    }
  }
  return false;
}

/** 레벨 충돌체 핸들 집합 (colliderSource에 없이 레벨 충돌체 목록에 넣은 것: 게임 코드가 레벨에 붙인 상자 등). 수가 바뀌면 다시 */
const levelSets = new WeakMap<Level, { n: number; set: Set<number> }>();

/** 붙어 있는 레벨 중 이 충돌체를 만든 레벨 */
export function levelOfCollider(c: RAPIER.Collider): Level | null {
  for (const l of Level.attachedLevels) {
    if (l.colliderSource.has(c.handle)) return l;
    let e = levelSets.get(l);
    if (!e || e.n !== l.colliders.length) {
      e = { n: l.colliders.length, set: new Set(l.colliders.map((x) => x.handle)) };
      levelSets.set(l, e);
    }
    if (e.set.has(c.handle)) return l;
  }
  return null;
}

/** 이 자리를 덮는 붙은 레벨 (경계 구 안, 없으면 첫 레벨) */
export function levelAt(p: THREE.Vector3): Level | null {
  let first: Level | null = null;
  for (const l of Level.attachedLevels) {
    if (l.placeholder && first) continue;
    first ??= l;
    if (l.bounds.radius > 0 && l.bounds.containsPoint(p)) return l;
  }
  return first;
}

/**
 * 보이는 단단한 면 (레벨 보이는 형상: 정적 묶음 + 소품 뿌리). 레벨이 붙지 않았어도 된다 (굽기 중).
 * 보이는 형상이 없는 레벨이면 undefined (판정할 수 없음)
 */
export function visibleSolidHit(level: Level, origin: THREE.Vector3, dir: THREE.Vector3, far: number): { point: THREE.Vector3; distance: number } | null | undefined {
  const b = level.visual;
  if (!b) return undefined;
  let best: { point: THREE.Vector3; distance: number } | null = b.set.first('solid', origin, dir, far);
  for (const r of b.set.roots) {
    const h = castRoot(r, origin, dir, best ? best.distance : far, 'solid', null);
    if (h && (!best || h.distance < best.distance)) best = h;
  }
  return best;
}

const _vo = new THREE.Vector3();
const _vd = new THREE.Vector3(0, -1, 0);

/**
 * 넘으려는 장애물이 보이나 (투명 벽·맵 경계 막이는 안 넘는다). feet: 발, dir: 넘는 방향(수평 단위), face: 발에서 충돌체 면까지,
 * depth: 충돌체 두께(오르기는 Infinity), top: 윗면 높이. 직접 조작하는 캐릭터의 판정과 링크 굽기가 같이 쓸 수 있다.
 * 면 앞에서 수평으로(높이 셋 × 옆 셋) 쏴 면 0.3 m 안에 보이는 면이 있거나, 윗면 위에서 아래로(두께 안 넷) 쏴 윗면 0.25 m 안에
 * 닿으면 보인다. 가로대 울타리(가로대 사이로 수평 레이가 빠지고, 보이는 윗 가로대가 충돌체보다 얇다)도 보이게 여러 점을 본다.
 * 보이는 형상이 없는 레벨은 판정할 수 없어 true
 */
export function obstacleVisible(level: Level, feet: THREE.Vector3, dir: THREE.Vector3, face: number, depth: number, top: number): boolean {
  if (!level.visual) return true;
  const rx = -dir.z;
  const rz = dir.x;
  const rise = top - feet.y;
  for (const h of [Math.max(0.25, Math.min(rise - 0.1, 0.5)), 0.3, rise - 0.08]) {
    if (h < 0.15) continue;
    for (const o of [0, -0.2, 0.2]) {
      const hit = visibleSolidHit(level, _vo.set(feet.x + rx * o, feet.y + h, feet.z + rz * o), dir, face + 0.35);
      if (hit === undefined) return true;
      if (hit && hit.distance <= face + 0.3) return true;
    }
  }
  const d = Number.isFinite(depth) ? THREE.MathUtils.clamp(depth, 0.06, 0.9) : 0.3;
  for (const s of [0.1, 0.03, d * 0.5, d - 0.03]) {
    const k = face + s;
    const hit = visibleSolidHit(level, _vo.set(feet.x + dir.x * k, top + 0.45, feet.z + dir.z * k), _vd, 0.75);
    if (hit && hit.point.y >= top - 0.25) return true;
  }
  return false;
}
