import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { RaycastGeometry, type RaycastRoot, type SurfaceHit } from './RaycastGeometry';
import { FIXED_DT } from '../core/config';
import { MirrorRecorder } from './mirror/recorder';

export { RAPIER };

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  collider: RAPIER.Collider;
}

/**
 * 보이는 형상 레이 결과. Rapier 콜라이더(판정 부피, 문, 등록 안 된 충돌체)나 보이는 형상(레벨·소품 렌더 메시)에 맞는다.
 * 보이는 형상에 맞으면 collider는 null(동적 뿌리는 대표 콜라이더)이고 owner는 분류 태그 또는 등록한 소유자다.
 */
export interface VisualHit {
  point: THREE.Vector3;
  /** 쏜 쪽을 보는 면 노멀 */
  normal: THREE.Vector3;
  distance: number;
  collider: RAPIER.Collider | null;
  /** physics.ownerOf(collider) 또는 보이는 형상의 소유자·분류 태그 */
  owner: unknown;
  /** 맞은 렌더 메시 (보이는 형상일 때) */
  object: THREE.Object3D | null;
  /** pass 면 (유리·잎 등: pass: 'block'일 때만 결과가 된다) */
  pass: boolean;
  /** 면의 뒤쪽 (닫힌 덩어리에서 빠져나가는 면) */
  back?: boolean;
}

export interface VisualRayOptions {
  excludeCollider?: RAPIER.Collider;
  excludeBody?: RAPIER.RigidBody;
  /** Rapier 콜라이더 필터. 대표 콜라이더가 있는 동적 뿌리에도 같은 필터를 건다 */
  filter?: (c: RAPIER.Collider) => boolean;
  /** 'pass'(기본): pass 면을 지나간다(passed에 모음). 'block': pass 면에도 멈춘다 */
  pass?: 'pass' | 'block';
  /** 지나간 pass 면 (가까운 순, 들어가는 면·나오는 면 모두) */
  passed?: VisualHit[];
}

/**
 * pass 면 목록(가까운 순)에서 from~reach 사이 닫힌 덩어리 속을 지난 길이 (m). 앞면 = 들어감, 뒷면 = 나감. 겹친 덩어리는 한 번만.
 * (예: 잎 덤불 두께로 시야를 얼마나 가리는지 잴 때). from: 이만큼 가까운 면은 세지 않는다
 */
export function passDepth(hits: readonly VisualHit[], reach: number, from = 0): number {
  let inside = 0;
  let start = 0;
  let depth = 0;
  const add = (a: number, b: number) => {
    const lo = Math.max(a, from);
    if (b > lo) depth += b - lo;
  };
  for (const h of hits) {
    if (h.distance > reach) break;
    if (!h.back) {
      if (inside++ === 0) start = h.distance;
    } else if (inside > 0) {
      if (--inside === 0) add(start, h.distance);
    } else add(0, h.distance); // 덩어리 속에서 시작했다
  }
  if (inside > 0) add(start, reach);
  return depth;
}

/** Rapier 월드 래퍼. 정적 레벨 충돌체, 레이캐스트, 콜라이더 ↔ 게임 오브젝트 연결, 보이는 형상 레이캐스트. */
export class Physics {
  readonly world: RAPIER.World;
  /** 콜라이더 핸들 → 게임 쪽 소유자 (캐릭터, 소품 등) */
  private readonly owners = new Map<number, unknown>();
  /** 보이는 형상 (렌더 메시, BVH). visualRaycast·lineOfSight가 쓴다. 이동 질의는 보지 않는다 */
  readonly visual = new RaycastGeometry();
  /** 보이는 형상 레이에게는 렌더 메시가 대신하는 이동 전용 충돌체 (COL_ 박스, 레벨 트라이메시, 소품) */
  private readonly visualProxies = new Set<number>();
  /**
   * 물리 거울 기록기 (physics/mirror): 워커가 같은 모양의 월드로 이동 질의를 대신 하도록 바뀐 것을 모은다.
   * create({ mirror })로 만든 월드에만 있다 (없으면 감싼 메서드도 기록하지 않는다)
   */
  readonly mirror: MirrorRecorder | null = null;
  /** world.step 바로 앞에 부를 것 (예: 워커 이동 결과를 다음 키네마틱 자세로 놓는 자리) */
  readonly beforeStep: (() => void)[] = [];

  /** mirror: 이 월드의 변경을 기록한다 (queryGroups: 거울이 섬길 이동 질의 그룹) */
  static async create(opts: { mirror?: { queryGroups: number } } = {}): Promise<Physics> {
    await RAPIER.init();
    return new Physics(opts.mirror ?? null);
  }

  private constructor(mirror: { queryGroups: number } | null) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
    if (mirror) this.mirror = new MirrorRecorder(this.world, mirror.queryGroups, (h) => this.owners.get(h));
  }

  step(): void {
    for (let i = 0; i < this.beforeStep.length; i++) this.beforeStep[i]();
    this.world.step();
  }

  setOwner(collider: RAPIER.Collider, owner: unknown): void {
    this.owners.set(collider.handle, owner);
    this.mirror?.ownerChanged(collider.handle);
  }

  ownerOf<T = unknown>(collider: RAPIER.Collider | null | undefined): T | undefined {
    if (!collider) return undefined;
    return this.owners.get(collider.handle) as T | undefined;
  }

  /** 이 콜라이더는 이동 전용: 보이는 형상 레이(visualRaycast)는 건너뛰고 렌더 메시를 대신 본다 */
  setVisualProxy(collider: RAPIER.Collider, on = true): void {
    if (on) this.visualProxies.add(collider.handle);
    else this.visualProxies.delete(collider.handle);
  }

  isVisualProxy(collider: RAPIER.Collider): boolean {
    return this.visualProxies.has(collider.handle);
  }

  /** 회전 가능한 정적 박스 (center, halfExtents는 m) */
  addStaticBox(center: THREE.Vector3, halfExtents: THREE.Vector3, rotation?: THREE.Quaternion): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z).setTranslation(
      center.x,
      center.y,
      center.z,
    );
    if (rotation) desc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
    return this.world.createCollider(desc);
  }

  /** 메시의 월드 변환을 반영한 삼각형 메시 충돌체 (레벨 지형용) */
  addStaticMesh(mesh: THREE.Mesh): RAPIER.Collider {
    mesh.updateWorldMatrix(true, false);
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const verts = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      verts.set([v.x, v.y, v.z], i * 3);
    }
    const indices = g.index
      ? new Uint32Array(g.index.array)
      : Uint32Array.from({ length: pos.count }, (_, i) => i);
    return this.world.createCollider(RAPIER.ColliderDesc.trimesh(verts, indices));
  }

  /** root 아래 메시를 전부 정적 충돌체로. userData.collider === false 이거나 아웃라인 헐이면 건너뜀 */
  addStaticFromObject(root: THREE.Object3D): RAPIER.Collider[] {
    const out: RAPIER.Collider[] = [];
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.isOutline || m.userData.collider === false) return;
      out.push(this.addStaticMesh(m));
    });
    return out;
  }

  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    opts: { excludeCollider?: RAPIER.Collider; excludeBody?: RAPIER.RigidBody; filter?: (c: RAPIER.Collider) => boolean } = {},
  ): RayHit | null {
    const d = dir.clone().normalize();
    const ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: d.x, y: d.y, z: d.z });
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDist,
      true,
      undefined,
      undefined,
      opts.excludeCollider,
      opts.excludeBody,
      opts.filter,
    );
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return {
      point: origin.clone().addScaledVector(d, t),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: t,
      collider: hit.collider,
    };
  }

  /**
   * 보이는 형상 레이: 렌더 메시(physics.visual) + Rapier 콜라이더 중 이동 전용(setVisualProxy)이 아닌 것
   * (판정 부피, 문, 직접 만든 충돌체). 클릭 지점 찾기, 시야, 맞은 자리 연출 등이 쓴다.
   * pass 면(유리·잎 등)은 opts.pass에 따라 지나가거나(passed에 모음) 멈춘다.
   */
  visualRaycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, opts: VisualRayOptions = {}): VisualHit | null {
    const d = dir.clone().normalize();
    const proxies = this.visualProxies;
    const f = opts.filter;
    const ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: d.x, y: d.y, z: d.z });
    const r = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, undefined, opts.excludeCollider, opts.excludeBody, (c) => !proxies.has(c.handle) && (!f || f(c)));
    let best: VisualHit | null = null;
    if (r) {
      const t = r.timeOfImpact;
      const normal = new THREE.Vector3(r.normal.x, r.normal.y, r.normal.z);
      if (normal.dot(d) > 0) normal.negate();
      best = { point: origin.clone().addScaledVector(d, t), normal, distance: t, collider: r.collider, owner: this.ownerOf(r.collider), object: null, pass: false };
    }
    if (!this.visual.size) return best;
    const skip = (root: RaycastRoot): boolean => {
      const c = root.collider;
      if (!c) return false;
      if (opts.excludeCollider && c.handle === opts.excludeCollider.handle) return true;
      const b = c.parent();
      if (opts.excludeBody && b && b.handle === opts.excludeBody.handle) return true;
      return !!f && !f(c);
    };
    const block = opts.pass === 'block';
    const passes: SurfaceHit[] | undefined = block || opts.passed ? [] : undefined;
    const v = this.visual.raycast(origin, d, best ? best.distance : maxDist, skip, passes);
    if (v && (!best || v.distance < best.distance)) best = { point: v.point, normal: v.normal, distance: v.distance, collider: v.collider, owner: v.owner, object: v.object, pass: false };
    if (passes?.length) {
      const reach = best ? best.distance : maxDist;
      const near = passes.filter((g) => g.distance < reach).sort((a, b) => a.distance - b.distance);
      // 삼각형 모서리에서 같은 면이 두 번 나온다
      const uniq = near.filter((g, i) => i === 0 || g.distance - near[i - 1].distance > 0.002 || g.back !== near[i - 1].back);
      if (block && uniq.length) {
        const g = uniq[0];
        return { point: g.point, normal: g.normal, distance: g.distance, collider: g.collider, owner: g.owner, object: g.object, pass: true, back: g.back };
      }
      if (opts.passed) for (const g of uniq) opts.passed.push({ point: g.point, normal: g.normal, distance: g.distance, collider: g.collider, owner: g.owner, object: g.object, pass: true, back: g.back });
    }
    return best;
  }

  /**
   * 시야: from에서 to까지 보이는 형상·콜라이더에 막히지 않는가 (pass 면은 막지 않는다).
   * reaches(hit)가 true면 그 맞은 것이 목표다(예: 목표 캐릭터의 콜라이더). margin: 목표 앞 이만큼은 막혀도 보인다고 친다.
   * occlusion을 주면 보일 때 그 사이 pass 덩어리 속을 지난 길이(m, passDepth)를 depth에 적는다. occlusion.near: 눈에서 이만큼 안은 세지 않는다
   */
  lineOfSight(
    from: THREE.Vector3,
    to: THREE.Vector3,
    opts: Omit<VisualRayOptions, 'pass' | 'passed'> & { reaches?: (hit: VisualHit) => boolean; margin?: number; occlusion?: { depth: number; near?: number } } = {},
  ): boolean {
    const d = to.clone().sub(from);
    const len = d.length();
    if (opts.occlusion) opts.occlusion.depth = 0;
    if (len < 0.05) return true;
    const passed: VisualHit[] | undefined = opts.occlusion ? [] : undefined;
    const hit = this.visualRaycast(from, d, len, { ...opts, pass: 'pass', passed });
    const seen = !hit || hit.distance > len - (opts.margin ?? 0.3) || !!opts.reaches?.(hit);
    if (seen && passed?.length && opts.occlusion) opts.occlusion.depth = passDepth(passed, hit ? Math.min(hit.distance, len) : len, opts.occlusion.near ?? 0);
    return seen;
  }
}
