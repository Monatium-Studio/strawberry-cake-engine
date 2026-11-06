import * as THREE from 'three';
import { CENTER, MeshBVH } from 'three-mesh-bvh';
import { visibleInWorld } from '../physics/RaycastGeometry';
import { RAPIER, type Physics } from '../physics/Physics';
import { classifyVisualMesh } from '../level/visual';

/**
 * 캐릭터 발밑 땅 높이 질의 (Character.ground). 걷는 캐릭터와 place()가 발을 땅에 붙일 때 쓴다 (Character.ts '땅 붙이기').
 *   충돌체가 있는 레벨: RapierGround. 고정 충돌체(바디 없는 레벨 충돌체·고정 바디)만, 센서 제외. 캐릭터 컨트롤러가 딛는 면과 같다
 *   세트(physics:false로 읽은 보기만 하는 장면): MeshGround. 보이는 solid 메시(level/visual.ts 분류 규칙)에
 *     메시마다 BVH(three-mesh-bvh, indirect: 렌더 지오메트리 인덱스를 건드리지 않는다)
 * 둘 다 아래로 쏘는 레이 한 발이다. 캐릭터·든 소품·코드가 만든 물체(레벨 dynamic 묶음)는 레벨 루트 밖이라 맞지 않는다.
 * 계단: 계단 충돌체를 단 코를 잇는 경사판 하나로 만들면 디딤판보다 0~단 높이만큼 위다. 기운 충돌체에 닿으면
 *   그 자리 보이는 면(physics.visual의 정적 묶음)에서 평평한 디딤판을 한 번 더 찾아 그 높이를 쓴다 (RapierGround). 턱 모서리를 넘는
 *   모양은 Character가 표본 사이에서 잡는다 (Character '땅 붙이기').
 */
export interface GroundProbe {
  /** (x, z)에서 top 높이부터 bottom까지 아래로 처음 닿는 면의 높이. 없으면 NaN. 만들지 않는다(할당 없음) */
  height(x: number, z: number, top: number, bottom: number): number;
  /** 질의 수 (측정) */
  queries: number;
}

/** 이보다 기운 충돌체 면(법선 y가 작은 면: 약 10°)이면 그 밑 보이는 디딤판을 찾는다 */
const RAMP_NY = 0.985;
/** 디딤판으로 치는 보이는 면 (법선 y, 약 14° 안) */
const TREAD_NY = 0.97;
/** 경사판 위·아래로 이만큼(m) 안의 디딤판 (경사판은 단 코를 잇거나 단 코와 안쪽 모서리 가운데를 지난다: 단 높이 0.22 m 안) */
const TREAD_UP = 0.25;
const TREAD_DOWN = 0.3;
const _o = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
/** 보이는 형상의 움직이는 뿌리(PROP_·문·움직이는 물체)는 보지 않는다: 디딤판은 레벨 정적 묶음(StaticRaycastSet)에만 */
const statics = (): boolean => true;

/** 충돌체가 있는 레벨: 고정 충돌체에 아래로 레이 (Rapier). 계단 경사판 위면 보이는 디딤판 */
export class RapierGround implements GroundProbe {
  queries = 0;
  /** 경사판 밑 디딤판을 찾은 수 (측정) */
  treads = 0;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(private readonly physics: Physics) {}

  height(x: number, z: number, top: number, bottom: number): number {
    const len = top - bottom;
    if (!(len > 0)) return NaN;
    this.queries++;
    const o = this.ray.origin;
    o.x = x;
    o.y = top;
    o.z = z;
    // solid=false: 속이 찬 COL_ 상자 안에서 쏘면 상자 위가 아니라 빠져나가는 면(바닥 쪽)
    const hit = this.physics.world.castRayAndGetNormal(this.ray, len, false, RAPIER.QueryFilterFlags.ONLY_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    if (!hit) return NaN;
    const h = top - hit.timeOfImpact;
    const ny = hit.normal.y;
    if (ny < RAMP_NY && ny > 0.3 && this.physics.visual.size) {
      // 기운 충돌체 (계단 경사판): 그 자리의 보이는 평평한 면. 없으면(진짜 비탈·잔해) 충돌체 그대로
      const up = Math.min(TREAD_UP, top - h);
      const v = this.physics.visual.raycast(_o.set(x, h + up, z), DOWN, up + TREAD_DOWN, statics);
      if (v && v.normal.y > TREAD_NY) {
        this.treads++;
        return v.point.y;
      }
    }
    return h;
  }
}

/** 컨트롤러로 걷는 캐릭터의 보이는 발: 몸(컨트롤러 발)보다 아래·위로 이만큼(m)까지만 옮긴다 (경사판이 단 코를 지나면 아래로 단 높이, 코와 안쪽 모서리 가운데면 위로 반) */
const FEET_DOWN = 0.3;
const FEET_UP = 0.12;
/** 발밑이 몸과 이만큼(m) 안에 있는 평평한 곳에서는 FLAT_SKIP 움직일 때마다 한 번 잰다 */
const FEET_FLAT = 0.01;
const FLAT_SKIP = 0.12;

/**
 * Rapier 캐릭터 컨트롤러로 걷는 캐릭터의 보이는 발 높이. 컨트롤러 캡슐은 계단 경사판 위를 지나거나(디딤판보다 0~단 높이 위),
 * 단마다 상자인 계단에서는 둥근 밑이 단 코에 얹혀 디딤판보다 뜬다 (계단실을 오르는 무리에서 최대 15 cm, 평균 7 cm).
 * 발밑 땅(RapierGround: 경사판이면 그 자리 디딤판)으로 보이는 모델만 옮기고, 가는 쪽 0.06초 앞(0.1 m까지)이 다른 높이(단 모서리)면 두 높이
 * 가운데로 (모서리를 둘로 나눠 넘는다). 0.05초로 섞어 튀지 않게 한다. 몸(충돌 캡슐 자리)은 그대로다.
 * 레이: 계단에서 움직이면 프레임마다 Rapier 2 (경사판이면 BVH 2 더), 발밑이 몸과 같은 평평한 곳에서는 FLAT_SKIP마다 1
 */
export class TreadFeet {
  private off = 0;
  /** 마지막으로 발밑이 몸과 같던 평평한 자리: FLAT_SKIP 안이고 몸 높이가 그대로면 다시 재지 않는다 */
  private flatX = NaN;
  private flatY = NaN;
  private flatZ = NaN;
  private readonly ground: RapierGround;

  constructor(physics: Physics) {
    this.ground = new RapierGround(physics);
  }

  /** p: 컨트롤러 발 (월드), (vx, vz): 수평 속도, grounded: 컨트롤러가 땅에 섰다. 보이는 발 높이를 돌려준다 */
  feet(p: THREE.Vector3, vx: number, vz: number, grounded: boolean, dt: number): number {
    let target = 0;
    // 같은 평평한 자리면 (몸 높이도 그대로: 캡슐이 다음 단에 얹혀 오르면 다시 잰다) 재지 않는다
    if (grounded && !(Math.hypot(p.x - this.flatX, p.z - this.flatZ) < FLAT_SKIP && Math.abs(p.y - this.flatY) < FEET_FLAT)) {
      const g = this.ground;
      const t0 = g.treads;
      const h0 = g.height(p.x, p.z, p.y + 0.3, p.y - 0.45);
      if (h0 === h0) {
        let h = h0;
        // 앞을 보는 거리: 0.06초 갈 거리 (최대 0.1 m). 느리게 돌아서는 참에서 다음 단을 미리 반만큼 밟지 않게
        const sp = Math.hypot(vx, vz);
        const look = Math.min(0.1, sp * 0.06);
        if (look > 0.02) {
          const h1 = g.height(p.x + (vx / sp) * look, p.z + (vz / sp) * look, p.y + 0.4, p.y - 0.45);
          if (h1 === h1 && Math.abs(h1 - h0) > 0.04) h = (h0 + h1) / 2;
        }
        target = Math.max(-FEET_DOWN, Math.min(FEET_UP, h - p.y));
        if (Math.abs(h0 - p.y) < FEET_FLAT && h === h0 && g.treads === t0) {
          this.flatX = p.x;
          this.flatY = p.y;
          this.flatZ = p.z;
        }
      }
    }
    this.off += (target - this.off) * Math.min(1, dt * 20);
    if (Math.abs(this.off) < 1e-4) this.off = 0;
    return p.y + this.off;
  }

  /** 넘기처럼 몸을 직접 움직이는 동안: 옮김을 바로 없앤다 */
  reset(): void {
    this.off = 0;
  }
}

/** 마커·트리거·문·하늘: 땅이 아니다 (level/visual.ts와 같은 이름 규칙) */
const MARKER = /^(COL|TRIG|SPAWN|NPC|WP|MARK|CAM|LOOK|FX|DOOR|SKY)(_|$)/;
/** 스크립트가 끄고 켜거나 옮길 수 있는 노드 (대문자 접두사, 상태 속성): 질의 때의 matrixWorld·경계를 본다 */
const SCRIPTED = /^[A-Z][A-Z0-9]*(_|$)/;
function isLive(o: THREE.Object3D): boolean {
  const u = o.userData ?? {};
  return SCRIPTED.test(o.name) || u.hidden !== undefined || u.on !== undefined || u.state !== undefined || u.drift !== undefined || u.spin !== undefined || u.dynamic !== undefined;
}

/** 같은 지오메트리는 BVH 하나 */
const bvhCache = new WeakMap<THREE.BufferGeometry, MeshBVH>();
function bvhOf(g: THREE.BufferGeometry): MeshBVH {
  let b = bvhCache.get(g);
  if (!b) {
    b = new MeshBVH(g, { indirect: true, strategy: CENTER });
    bvhCache.set(g, b);
  }
  return b;
}

const _ray = new THREE.Ray();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _s = new THREE.Sphere();
const _box = new THREE.Box3();

/**
 * 세트의 땅: 보이는 solid 메시마다 월드 경계 상자로 거르고, 걸린 메시만 BVH 레이 (메시 로컬로 옮겨서).
 * 경계 거르기는 메시 수만큼(보통 수십~수백 개) 숫자 비교뿐이고, BVH는 처음 질의할 때 만든다(prepare로 미리).
 * 살아 있는 노드(STAGE_·PROP_·hidden·drift…) 아래 메시는 질의 때의 matrixWorld·보임으로 본다.
 */
export class MeshGround implements GroundProbe {
  queries = 0;
  /** 후보 메시 수, BVH를 만든 메시 수·삼각형 수·걸린 시간(ms, 합·가장 긴 한 번) */
  readonly stats = { meshes: 0, bvh: 0, tris: 0, ms: 0, maxMs: 0 };
  private readonly meshes: THREE.Mesh[] = [];
  private readonly live: boolean[] = [];
  /** 정적 메시의 월드 경계 (minX, minY, minZ, maxX, maxY, maxZ) */
  private box: Float32Array = new Float32Array(0);
  /** 정적 메시의 월드 → 로컬 */
  private readonly inv: (THREE.Matrix4 | null)[] = [];

  constructor(root: THREE.Object3D, opts: { skyNode?: string | null } = {}) {
    root.updateMatrixWorld(true);
    const visit = (o: THREE.Object3D, live: boolean) => {
      if (o !== root && (MARKER.test(o.name) || (opts.skyNode && o.name === opts.skyNode))) return;
      const lv = live || (o !== root && (/^PROP_/.test(o.name) || isLive(o)));
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m as unknown as THREE.SkinnedMesh).isSkinnedMesh && !(m as unknown as THREE.InstancedMesh).isInstancedMesh && m.geometry?.getAttribute('position')) {
        const cls = classifyVisualMesh(m, root);
        if (cls?.kind === 'solid') {
          this.meshes.push(m);
          this.live.push(lv);
        }
      }
      for (const c of o.children) visit(c, lv);
    };
    visit(root, false);
    const n = this.meshes.length;
    this.box = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const m = this.meshes[i];
      const g = m.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (!g.boundingSphere) g.computeBoundingSphere();
      if (this.live[i]) {
        this.inv.push(null);
        continue;
      }
      _box.copy(g.boundingBox!).applyMatrix4(m.matrixWorld);
      this.box.set([_box.min.x, _box.min.y, _box.min.z, _box.max.x, _box.max.y, _box.max.z], i * 6);
      this.inv.push(m.matrixWorld.clone().invert());
    }
    this.stats.meshes = n;
  }

  /** points 아래에 걸리는 메시의 BVH를 미리 만든다 (세트를 읽을 때, 메시마다 tick) */
  async prepare(points: THREE.Vector3[], tick?: () => Promise<void>): Promise<void> {
    for (let i = 0; i < this.meshes.length; i++) {
      if (bvhCache.has(this.meshes[i].geometry)) continue;
      if (!points.some((p) => this.covers(i, p.x, p.z, p.y + 2, p.y - 3))) continue;
      this.build(i);
      await tick?.();
    }
  }

  private build(i: number): MeshBVH {
    const g = this.meshes[i].geometry;
    const have = bvhCache.get(g);
    if (have) return have;
    const t0 = performance.now();
    const b = bvhOf(g);
    const ms = performance.now() - t0;
    this.stats.ms += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    this.stats.bvh++;
    this.stats.tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    return b;
  }

  /** 메시 i의 경계가 (x, z)의 [bottom, top] 구간에 걸리는가 */
  private covers(i: number, x: number, z: number, top: number, bottom: number): boolean {
    if (!this.live[i]) {
      const b = this.box;
      const k = i * 6;
      return x >= b[k] && x <= b[k + 3] && z >= b[k + 2] && z <= b[k + 5] && b[k + 4] >= bottom && b[k + 1] <= top;
    }
    const m = this.meshes[i];
    _s.copy(m.geometry.boundingSphere!).applyMatrix4(m.matrixWorld);
    const dx = x - _s.center.x;
    const dz = z - _s.center.z;
    return dx * dx + dz * dz <= _s.radius * _s.radius && _s.center.y + _s.radius >= bottom && _s.center.y - _s.radius <= top;
  }

  height(x: number, z: number, top: number, bottom: number): number {
    if (!(top > bottom)) return NaN;
    this.queries++;
    let best = -Infinity;
    for (let i = 0; i < this.meshes.length; i++) {
      // 이미 찾은 면보다 높은 곳이 없으면 건너뛴다 (맨 위 면)
      if (!this.covers(i, x, z, top, best > bottom ? best : bottom)) continue;
      const m = this.meshes[i];
      if (!visibleInWorld(m)) continue;
      const inv = this.inv[i] ?? _inv.copy(m.matrixWorld).invert();
      _a.set(x, top, z).applyMatrix4(inv);
      _b.set(x, bottom, z).applyMatrix4(inv).sub(_a);
      const len = _b.length();
      if (len < 1e-6) continue;
      _ray.origin.copy(_a);
      _ray.direction.copy(_b).divideScalar(len);
      const hit = this.build(i).raycastFirst(_ray, THREE.DoubleSide, 0, len);
      if (!hit) continue;
      const e = m.matrixWorld.elements;
      const p = hit.point;
      const wy = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
      if (wy > best) best = wy;
    }
    return best > -Infinity ? best : NaN;
  }
}
