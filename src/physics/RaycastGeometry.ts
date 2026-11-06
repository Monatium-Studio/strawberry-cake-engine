import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CENTER, MeshBVH } from 'three-mesh-bvh';

/**
 * 보이는 형상 레이캐스트: 렌더 메시 그대로 (three-mesh-bvh).
 *
 * 이동 충돌체(박스·볼록 껍질)는 걷기용이라 틈을 덮는다. 보이는 면에 정확히 맞아야 하는 질의(시야, 클릭 지점, 맞은 자리 연출,
 * 땅 높이)는 이 형상을 쓴다. Rapier 월드와 따로 있어서 캐릭터 컨트롤러·내비 이동 질의는 이 형상을 보지 않는다.
 *   정적 묶음(StaticRaycastSet): 레벨의 움직이지 않는 메시를 월드 좌표로 합친 BVH 하나 (종류별: solid, pass)
 *   동적 뿌리(addRoot): 소품·스크립트가 움직이거나 끄고 켜는 노드. 메시마다 로컬 BVH(같은 지오메트리는 한 번)를 두고
 *     질의할 때의 matrixWorld·visible을 그대로 쓴다 (문·해치가 돌아간 그대로 맞는다)
 * 분류(어느 메시가 solid / pass / 무시인지)는 게임 쪽 규칙(RaycastClassifier)이 정한다.
 */

/**
 * solid: 레이를 막는다.
 * pass: 보이지만 기본으로는 막지 않는 얇은 면(유리·잎·천 등). 지나간 면을 모아 돌려주고, 원하면 막게 할 수 있다
 */
export type RaycastKind = 'solid' | 'pass';

export interface RaycastClass {
  kind: RaycastKind;
  /** 맞았을 때 소유자로 돌려줄 값 (표면 태그 등). 동적 뿌리는 뿌리의 owner가 우선 */
  tag?: unknown;
}

/** 메시 → 분류. null이면 레이가 보지 않는다 */
export type RaycastClassifier = (mesh: THREE.Mesh) => RaycastClass | null;

/** 기본 분류: 보이는 메시는 전부 solid (외곽선 헐·스킨·인스턴스 메시는 makeRaycastRoot·정적 묶음이 거른다) */
export const solidClassifier: RaycastClassifier = (m) => (m.userData.isOutline ? null : { kind: 'solid' });

export interface SurfaceHit {
  point: THREE.Vector3;
  /** 쏜 쪽을 보는 면 노멀 (양면 메시라 뒷면에 맞아도 쏜 쪽으로 뒤집는다) */
  normal: THREE.Vector3;
  distance: number;
  kind: RaycastKind;
  /** 면의 뒤쪽에 맞았다 (닫힌 덩어리에서 빠져나가는 면: 두께 재기) */
  back: boolean;
  object: THREE.Mesh;
  owner: unknown;
  /** 동적 뿌리의 대표 콜라이더 (탈것이면 차체 콜라이더 하나). 필터에 쓴다 */
  collider: RAPIER.Collider | null;
  root: RaycastRoot | null;
}

export interface RaycastRoot {
  readonly root: THREE.Object3D;
  readonly owner: unknown;
  readonly collider: RAPIER.Collider | null;
  readonly items: { mesh: THREE.Mesh; kind: RaycastKind; tag: unknown }[];
  /** 뿌리 로컬 경계 구 (부풀림 포함) */
  readonly sphere: THREE.Sphere;
}

export interface RaycastBuildStats {
  meshes: number;
  tris: number;
  /** pass 면 삼각형 */
  passTris: number;
  dynamicMeshes: number;
  ms: number;
  /** BVH + 합친 지오메트리 바이트 (JS 힙) */
  bytes: number;
}

const _ray = new THREE.Ray();
const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _hitTmp = new THREE.Vector3();

/** 메시와 조상이 전부 보이는가 */
export function visibleInWorld(o: THREE.Object3D | null): boolean {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

function bvhBytes(b: MeshBVH): number {
  const x = b as unknown as { _roots?: ArrayBuffer[]; _indirectBuffer?: ArrayBufferLike | { byteLength: number } };
  let n = 0;
  for (const r of x._roots ?? []) n += r.byteLength;
  n += x._indirectBuffer?.byteLength ?? 0;
  return n;
}

/** 같은 지오메트리는 BVH 하나 (indirect: 렌더 지오메트리의 인덱스 순서를 건드리지 않는다) */
const meshBVH = new WeakMap<THREE.BufferGeometry, MeshBVH>();
function bvhOf(g: THREE.BufferGeometry): MeshBVH {
  let b = meshBVH.get(g);
  if (!b) {
    b = new MeshBVH(g, { indirect: true, strategy: CENTER });
    meshBVH.set(g, b);
  }
  return b;
}

/** 정적 묶음의 한 종류: 월드 좌표로 합친 지오메트리 + BVH. 정점 → 원래 메시 (보이는지 검사) */
interface Part {
  bvh: MeshBVH;
  meshes: THREE.Mesh[];
  tags: unknown[];
  /** 메시마다 첫 정점 번호 (오름차순) */
  starts: Uint32Array;
}

function meshOfVertex(p: Part, v: number): number {
  let lo = 0;
  let hi = p.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.starts[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

type Hit = { distance: number; point: THREE.Vector3; face?: { a: number; normal: THREE.Vector3 } | null };

/**
 * 레벨 하나의 정적 레이캐스트 형상. 만든 뒤 matrixWorld가 바뀌면(레벨 루트를 옮김) 레이를 만든 때의 좌표로 옮겨서 찾는다.
 * 숨긴 메시(visible=false, 조상 포함)는 맞지 않는다.
 */
export class StaticRaycastSet {
  solid: Part | null = null;
  pass: Part | null = null;
  readonly roots: RaycastRoot[] = [];
  readonly stats: RaycastBuildStats = { meshes: 0, tris: 0, passTris: 0, dynamicMeshes: 0, ms: 0, bytes: 0 };
  /** 만든 때 루트의 matrixWorld */
  private readonly baked = new THREE.Matrix4();
  private readonly toBaked = new THREE.Matrix4();
  private readonly fromBaked = new THREE.Matrix4();
  private readonly seen = new THREE.Matrix4();
  private moved = false;

  constructor(
    readonly name: string,
    readonly root: THREE.Object3D,
  ) {
    root.updateMatrixWorld(true);
    this.baked.copy(root.matrixWorld);
    this.seen.copy(root.matrixWorld);
  }

  /**
   * items(월드 좌표로 고정할 메시)를 종류별로 합쳐 BVH를 만든다. tick이 있으면 메시 몇 개마다 기다린다 (로딩 프레임 예산)
   */
  async build(items: { mesh: THREE.Mesh; cls: RaycastClass }[], tick?: () => Promise<void>): Promise<void> {
    const t0 = performance.now();
    let waited = 0;
    const wait = async () => {
      if (!tick) return;
      const w = performance.now();
      await tick();
      waited += performance.now() - w;
    };
    for (const kind of ['solid', 'pass'] as const) {
      const list = items.filter((x) => x.cls.kind === kind);
      if (!list.length) continue;
      let nv = 0;
      let ni = 0;
      for (const { mesh } of list) {
        const g = mesh.geometry;
        const pos = g.getAttribute('position');
        nv += pos.count;
        ni += g.index ? g.index.count : pos.count;
      }
      if (ni < 3) continue;
      const positions = new Float32Array(nv * 3);
      const index = new Uint32Array(ni);
      const starts = new Uint32Array(list.length);
      let vo = 0;
      let io = 0;
      for (let k = 0; k < list.length; k++) {
        const mesh = list[k].mesh;
        mesh.updateWorldMatrix(true, false);
        const g = mesh.geometry;
        const pos = g.getAttribute('position');
        starts[k] = vo;
        for (let i = 0; i < pos.count; i++) {
          _v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          positions[(vo + i) * 3] = _v.x;
          positions[(vo + i) * 3 + 1] = _v.y;
          positions[(vo + i) * 3 + 2] = _v.z;
        }
        if (g.index) for (let i = 0; i < g.index.count; i++) index[io++] = vo + g.index.getX(i);
        else for (let i = 0; i < pos.count; i++) index[io++] = vo + i;
        vo += pos.count;
        if (k % 48 === 47) await wait();
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      const bvh = new MeshBVH(geo, { strategy: CENTER });
      this[kind] = { bvh, meshes: list.map((x) => x.mesh), tags: list.map((x) => x.cls.tag), starts };
      this.stats.meshes += list.length;
      if (kind === 'solid') this.stats.tris += ni / 3;
      else this.stats.passTris += ni / 3;
      this.stats.bytes += positions.byteLength + index.byteLength + bvhBytes(bvh);
      await wait();
    }
    this.stats.ms = performance.now() - t0 - waited;
  }

  /** 월드 레이를 만든 때의 좌표로 (루트가 그대로면 그대로) */
  private local(origin: THREE.Vector3, dir: THREE.Vector3, out: THREE.Ray): THREE.Ray {
    const mw = this.root.matrixWorld;
    if (!mw.equals(this.seen)) {
      this.seen.copy(mw);
      this.moved = !mw.equals(this.baked);
      if (this.moved) {
        // 지금 월드 = mw · baked⁻¹ · (만든 때 월드)
        this.fromBaked.copy(mw).multiply(_m.copy(this.baked).invert());
        this.toBaked.copy(this.fromBaked).invert();
      }
    }
    out.origin.copy(origin);
    out.direction.copy(dir);
    if (this.moved) out.applyMatrix4(this.toBaked);
    return out;
  }

  private toWorld(h: Hit, part: Part, idx: number, origin: THREE.Vector3, dir: THREE.Vector3, kind: RaycastKind): SurfaceHit {
    const point = h.point.clone();
    const normal = h.face ? h.face.normal.clone() : dir.clone().negate();
    if (this.moved) {
      point.applyMatrix4(this.fromBaked);
      normal.transformDirection(this.fromBaked);
    }
    const back = normal.dot(dir) > 0;
    if (back) normal.negate();
    return { point, normal, distance: point.distanceTo(origin), kind, back, object: part.meshes[idx], owner: part.tags[idx], collider: null, root: null };
  }

  /** 가장 가까운 보이는 면 */
  first(kind: RaycastKind, origin: THREE.Vector3, dir: THREE.Vector3, far: number): SurfaceHit | null {
    const part = this[kind];
    if (!part) return null;
    const ray = this.local(origin, dir, _ray);
    const h = part.bvh.raycastFirst(ray, THREE.DoubleSide, 0, far) as Hit | null;
    if (!h || !h.face) return null;
    const idx = meshOfVertex(part, h.face.a);
    if (visibleInWorld(part.meshes[idx])) return this.toWorld(h, part, idx, origin, dir, kind);
    // 숨긴 메시에 먼저 맞았다: 전부 모아 보이는 첫 면
    const all = (part.bvh.raycast(ray, THREE.DoubleSide, 0, far) as Hit[]).sort((a, b) => a.distance - b.distance);
    for (const x of all) {
      if (!x.face) continue;
      const i = meshOfVertex(part, x.face.a);
      if (visibleInWorld(part.meshes[i])) return this.toWorld(x, part, i, origin, dir, kind);
    }
    return null;
  }

  /** far 안의 보이는 면 전부 (pass 면) */
  all(kind: RaycastKind, origin: THREE.Vector3, dir: THREE.Vector3, far: number, out: SurfaceHit[]): void {
    const part = this[kind];
    if (!part) return;
    const ray = this.local(origin, dir, _ray);
    for (const x of part.bvh.raycast(ray, THREE.DoubleSide, 0, far) as Hit[]) {
      if (!x.face) continue;
      const i = meshOfVertex(part, x.face.a);
      if (visibleInWorld(part.meshes[i])) out.push(this.toWorld(x, part, i, origin, dir, kind));
    }
  }
}

/** 동적 뿌리를 만든다 (메시 목록은 만들 때 한 번 정한다: 나중에 붙인 자식(올라탄 캐릭터 등)은 들어가지 않는다) */
export function makeRaycastRoot(root: THREE.Object3D, classify: RaycastClassifier = solidClassifier, opts: { owner?: unknown; collider?: RAPIER.Collider | null } = {}): RaycastRoot | null {
  root.updateMatrixWorld(true);
  const items: RaycastRoot['items'] = [];
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  _inv.copy(root.matrixWorld).invert();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    const cls = classify(m);
    if (!cls) return;
    const g = m.geometry;
    if (!g?.getAttribute('position') || g.getAttribute('position').count < 3) return;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingSphere) g.computeBoundingSphere();
    tmp.copy(g.boundingBox!).applyMatrix4(_m.multiplyMatrices(_inv, m.matrixWorld));
    box.union(tmp);
    items.push({ mesh: m, kind: cls.kind, tag: cls.tag });
  });
  if (!items.length) return null;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  // 문·해치·회전부가 움직여도 들어오게 부풀린다
  sphere.radius = sphere.radius * 1.3 + 0.5;
  return { root, owner: opts.owner, collider: opts.collider ?? null, items, sphere };
}

function rayHitsSphere(origin: THREE.Vector3, dir: THREE.Vector3, far: number, s: THREE.Sphere): boolean {
  _v.copy(s.center).sub(origin);
  const t = _v.dot(dir);
  if (t < -s.radius || t > far + s.radius) return false;
  return _v.lengthSq() - t * t <= s.radius * s.radius;
}

/** 동적 뿌리에서 가장 가까운 면(kind), 또는 allOut이 있으면 그 종류의 면 전부 */
export function castRoot(r: RaycastRoot, origin: THREE.Vector3, dir: THREE.Vector3, far: number, kind: RaycastKind, allOut: SurfaceHit[] | null): SurfaceHit | null {
  if (!visibleInWorld(r.root)) return null;
  _sphere.copy(r.sphere).applyMatrix4(r.root.matrixWorld);
  if (!rayHitsSphere(origin, dir, far, _sphere)) return null;
  let best: SurfaceHit | null = null;
  for (const it of r.items) {
    if (it.kind !== kind) continue;
    const m = it.mesh;
    if (!visibleInWorld(m)) continue;
    _sphere.copy(m.geometry.boundingSphere!).applyMatrix4(m.matrixWorld);
    if (!rayHitsSphere(origin, dir, best ? best.distance : far, _sphere)) continue;
    _inv.copy(m.matrixWorld).invert();
    _ray.origin.copy(origin);
    _ray.direction.copy(dir);
    _ray.applyMatrix4(_inv);
    const bvh = bvhOf(m.geometry);
    const hits = allOut ? (bvh.raycast(_ray, THREE.DoubleSide) as Hit[]) : [bvh.raycastFirst(_ray, THREE.DoubleSide) as Hit | null];
    for (const h of hits) {
      if (!h) continue;
      _hitTmp.copy(h.point).applyMatrix4(m.matrixWorld);
      const d = _hitTmp.distanceTo(origin);
      if (d > far || (!allOut && best && d >= best.distance)) continue;
      const normal = h.face ? h.face.normal.clone().transformDirection(m.matrixWorld) : dir.clone().negate();
      const back = normal.dot(dir) > 0;
      if (back) normal.negate();
      const hit: SurfaceHit = { point: _hitTmp.clone(), normal, distance: d, kind, back, object: m, owner: r.owner !== undefined ? r.owner : it.tag, collider: r.collider, root: r };
      if (allOut) allOut.push(hit);
      else best = hit;
    }
  }
  return best;
}

/**
 * 보이는 형상 등록부. Physics.visual로 하나 있다. 레벨은 붙을 때 정적 묶음을, 움직이는 물체는 만들어질 때 뿌리를 넣는다.
 */
export class RaycastGeometry {
  readonly statics = new Set<StaticRaycastSet>();
  readonly roots = new Map<THREE.Object3D, RaycastRoot>();
  /** 질의 수 (측정) */
  queries = 0;

  addStatic(s: StaticRaycastSet): void {
    this.statics.add(s);
    for (const r of s.roots) this.roots.set(r.root, r);
  }

  removeStatic(s: StaticRaycastSet): void {
    this.statics.delete(s);
    for (const r of s.roots) if (this.roots.get(r.root) === r) this.roots.delete(r.root);
  }

  addRoot(r: RaycastRoot): void {
    this.roots.set(r.root, r);
  }

  removeRoot(root: THREE.Object3D): void {
    this.roots.delete(root);
  }

  get size(): number {
    return this.statics.size + this.roots.size;
  }

  /**
   * 가장 가까운 solid 면 (far 안). skip이 true를 돌려주는 뿌리는 건너뛴다 (쏘는 쪽 자신이 올라탄 물체 등).
   * passOut이 있으면 far 안의 pass 면을 전부 모은다 (solid보다 가까운 것만, 정렬 안 함)
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, far: number, skip?: (r: RaycastRoot) => boolean, passOut?: SurfaceHit[]): SurfaceHit | null {
    this.queries++;
    let best: SurfaceHit | null = null;
    let reach = far;
    for (const s of this.statics) {
      const h = s.first('solid', origin, dir, reach);
      if (h && h.distance <= reach) {
        best = h;
        reach = h.distance;
      }
    }
    for (const r of this.roots.values()) {
      if (skip?.(r)) continue;
      const h = castRoot(r, origin, dir, reach, 'solid', null);
      if (h && h.distance <= reach) {
        best = h;
        reach = h.distance;
      }
    }
    if (passOut) {
      for (const s of this.statics) s.all('pass', origin, dir, reach, passOut);
      for (const r of this.roots.values()) if (!skip?.(r)) castRoot(r, origin, dir, reach, 'pass', passOut);
    }
    return best;
  }
}
