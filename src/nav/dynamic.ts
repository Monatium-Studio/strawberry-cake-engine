import * as THREE from 'three';
import type { Obstacle } from '@recast-navigation/core';
import { RAPIER, type Physics } from '../physics/Physics';
import { isEnabledCached, isFixedCached, isSensorCached, stampOf } from '../physics/colliderWatch';
import type { Level } from '../level/Level';
import type { NavWorld } from './NavWorld';

/**
 * 움직이는 것·나중에 생긴 것을 내비메시에 반영한다. Assassin's Creed Syndicate 방식:
 *  - 세워 둔 움직이는 물체(MovingObstacle: 수레·기계·잔해 등 강체): 1초 넘게 멈춰 있으면 몸 발자국(돌린 상자)을 타일 캐시 장애물로 깎는다.
 *    다시 움직이면 뺀다.
 *  - 스스로 길을 찾는 물체(navWait가 null이 아님)는 서 있거나 기어갈 때도 깎는다: 기다리는 중(navWait: 길 비키기·도착·경로 없음)이거나
 *    1.5 m/s 아래로 0.5초 (깎인 뒤에는 2.2 m/s 넘어야 '달림'으로 보고 뺀다). 기어가는 동안은 1 m·8° 넘게 바뀌었을 때만 다시 깎는다.
 *    (섰다 기었다 하는 큰 물체가 깎이지 않으면 걷는 이들이 그 자리로 길을 잡고 계속 부딪힌다)
 *    깎기·빼기는 고정 스텝마다 몇 개씩만 요청하고(대기 요청 64개 한도 안), 타일 다시 만들기는 NavWorld.update가 스텝마다
 *    몇 타일씩 나눠 한다. 장애물 하나가 건드리는 타일은 8개까지라 넘으면 긴 쪽으로 쪼갠다.
 *  - 달리는 물체: 내비메시를 건드리지 않고 조향 회피(steer)로 피한다 (걷는 이가 그 앞을 가로지르지 않게 진행 방향 옆으로).
 *  - 게임 코드가 나중에 세운 고정 충돌체(상자·바리케이드: physics.addStaticBox 등, 레벨 충돌체가 아닌 것): 생기면 깎고 없어지면 뺀다.
 * 움직이는 물체는 ctx.movers()에서 읽는다. 게임 코드가 직접 넣은 nav.addObjectObstacle(물체 루트)는 그대로 두고 건너뛴다.
 */

/** 돌린 상자 발자국 (월드): yaw는 Detour 타일 캐시 상자 장애물 각도 규약 (NavWorld.addBoxObstacle) */
export interface Footprint {
  center: THREE.Vector3;
  half: THREE.Vector3;
  yaw: number;
}

/** 강체로 움직이는 큰 물체 (수레·기계·탈것 등). 게임 쪽 객체가 이 모양을 갖추면 된다 */
export interface MovingObstacle {
  readonly root: THREE.Object3D;
  readonly body: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[];
  /** 앞뒤 속력 (m/s, 부호 있음). 몰라도 되면 0 */
  readonly speed: number;
  /** 스스로 길을 찾는다: null·없음이면 아님, true면 기다리거나 기어가는 중 */
  readonly navWait?: boolean | null;
  /**
   * 길을 비켜 주는 상대 묶음 이름: steer(…, who)의 who가 이 값이면 그 걷는 이는 이 물체를 조향으로 피하지 않는다
   * (물체가 서서 기다리고 깎이므로, 옆으로 비키다 제자리걸음하지 않게)
   */
  readonly yieldsTo?: string | null;
}

export interface NavObstaclesContext {
  physics(): Physics;
  /** 지금 있는 움직이는 물체 */
  movers(): Iterable<MovingObstacle>;
  /** 붙은 레벨과 그 내비 */
  navs(): Iterable<[Level, NavWorld]>;
  /** 모든 레벨 (레벨 충돌체를 '나중에 세운 충돌체'에서 빼려고) */
  levels(): Iterable<Level>;
}

/** 점검 */
export interface NavObstacleStats {
  /** 지금 깎여 있는 물체·충돌체 / 장애물 조각 수 */
  cut: number;
  pieces: number;
  /** 누적: 넣기·빼기 요청, 쪼갠 장애물, 요청이 막혀 미룬 수 */
  adds: number;
  removes: number;
  splits: number;
  deferred: number;
  /** 달리는 물체 (조향 회피 대상) */
  moving: number;
  /** 조향 회피가 걸음을 바꾼 스텝 수 */
  steers: number;
  /** 나중에 세운 고정 충돌체 */
  runtime: number;
}

interface Cut {
  nav: NavWorld;
  obstacles: Obstacle[];
  at: Footprint;
}

interface Tracked {
  key: object;
  /** 지금 발자국을 재는 함수 */
  footprint(): Footprint | null;
  /** 움직이는 중인가 (깎지 않는다) */
  moving(): boolean;
  stillT: number;
  /** 다시 움직였다 멈춘 뒤 다시 깎기까지 기다린다 (멈췄다 섰다 하는 운전에 타일을 매번 만들지 않게) */
  holdUntil: number;
  /** 스스로 길을 찾는 물체 (서 있거나 기어갈 때 깎기): 깎기까지 멈춘 시간·다시 움직인 뒤 기다림·다시 깎는 이동 (없으면 기본값) */
  ai?: boolean;
  cut: Cut | null;
  /** 요청 대기 중 */
  queued: boolean;
  alive: boolean;
}

const STILL_TIME = 1.0;
const RECUT_HOLD = 2.0;
/** 스스로 길을 찾는 물체: 이 아래면 '기어감'(깎는다), 깎인 뒤에는 SLOW_OFF 넘어야 뺀다. 깎기까지·다시 기다림·다시 깎는 이동 */
const SLOW_ON = 1.5;
const SLOW_OFF = 2.2;
const AI_STILL = 0.5;
const AI_HOLD = 1.0;
const AI_MOVE = 1.0;
const AI_TURN = 0.14;
/** 고정 스텝마다 타일 캐시에 넣을 요청 수, 아직 반영 안 된 요청 상한 (Detour MAX_REQUESTS 64) */
const REQ_PER_STEP = 4;
const MAX_INFLIGHT = 48;
const MAX_TOUCHED = 8;
/** 발자국으로 볼 높이: 바닥에서 이만큼 위까지의 충돌체 점 (키 위로 튀어나온 부분은 빼낸다) */
const BODY_H = 1.5;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _x = new THREE.Vector3();

/** 점들(월드)의 yaw 틀 경계 상자 → 발자국. 바닥(가장 낮은 점)에서 BODY_H 위까지만 */
function boxOfPoints(pts: number[], yaw: number): Footprint | null {
  if (pts.length < 9) return null;
  let ymin = Infinity;
  for (let i = 1; i < pts.length; i += 3) ymin = Math.min(ymin, pts[i]);
  const top = ymin + BODY_H;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  let y1 = ymin;
  for (let i = 0; i < pts.length; i += 3) {
    const y = pts[i + 1];
    if (y > top) {
      // 위쪽 점은 발자국(xz)에 넣지 않지만 높이는 top까지 센다: 땅에 0.35 m 묻힌 1.4 m 담은 윗모서리가 다 빠져
      // 상자가 땅속에만 남아 아무것도 깎지 못했다
      y1 = Math.max(y1, top);
      continue;
    }
    // 월드 → yaw 틀 (NavWorld 문 상자와 같은 규약: 로컬 x축이 (cos, -sin))
    const x = pts[i];
    const z = pts[i + 2];
    const lx = x * c - z * s;
    const lz = x * s + z * c;
    x0 = Math.min(x0, lx);
    x1 = Math.max(x1, lx);
    z0 = Math.min(z0, lz);
    z1 = Math.max(z1, lz);
    y1 = Math.max(y1, y);
  }
  if (!Number.isFinite(x0) || x1 - x0 < 0.05 || z1 - z0 < 0.05) return null;
  const lcx = (x0 + x1) / 2;
  const lcz = (z0 + z1) / 2;
  // yaw 틀 → 월드 (역회전)
  const cx = lcx * c + lcz * s;
  const cz = -lcx * s + lcz * c;
  const h = Math.max(0.3, y1 - ymin);
  return { center: new THREE.Vector3(cx, ymin - 0.3 + (h + 0.3) / 2, cz), half: new THREE.Vector3((x1 - x0) / 2, (h + 0.3) / 2, (z1 - z0) / 2), yaw };
}

/** 쿼터니언 → Detour 상자 각도 (로컬 x축의 수평 방향) */
export function yawOf(q: THREE.Quaternion): number {
  _x.set(1, 0, 0).applyQuaternion(q);
  return Math.atan2(-_x.z, _x.x);
}

/** 충돌체들의 발자국 (몸 껍질·상자 등). yaw를 안 주면 첫 충돌체 바디의 방향 */
export function colliderFootprint(cols: Iterable<RAPIER.Collider>, yaw?: number): Footprint | null {
  const pts: number[] = [];
  let y = yaw;
  for (const col of cols) {
    if (!col.isEnabled?.() || col.isSensor()) continue;
    const t = col.translation();
    const r = col.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    if (y === undefined) y = yawOf(_q);
    const push = (x: number, yy: number, z: number) => {
      _v.set(x, yy, z).applyQuaternion(_q);
      pts.push(_v.x + t.x, _v.y + t.y, _v.z + t.z);
    };
    const type = col.shapeType();
    if (type === RAPIER.ShapeType.Cuboid) {
      const h = col.halfExtents();
      if (h) for (let i = 0; i < 8; i++) push(i & 1 ? h.x : -h.x, i & 2 ? h.y : -h.y, i & 4 ? h.z : -h.z);
    } else if (type === RAPIER.ShapeType.ConvexPolyhedron || type === RAPIER.ShapeType.TriMesh) {
      const vs = col.vertices();
      if (vs) for (let i = 0; i < vs.length; i += 3) push(vs[i], vs[i + 1], vs[i + 2]);
    } else if (type === RAPIER.ShapeType.Ball || type === RAPIER.ShapeType.Capsule || type === RAPIER.ShapeType.Cylinder) {
      const rr = col.radius();
      const hh = type === RAPIER.ShapeType.Ball ? rr : (col.halfHeight?.() ?? 0) + (type === RAPIER.ShapeType.Capsule ? rr : 0);
      for (let i = 0; i < 8; i++) push(i & 1 ? rr : -rr, i & 2 ? hh : -hh, i & 4 ? rr : -rr);
    }
  }
  return y === undefined ? null : boxOfPoints(pts, y);
}

/**
 * colliderFootprint를 입력이 그대로면 다시 계산하지 않는다 (서 있는 물체·나중에 세운 충돌체를 고정 스텝마다 다시 재지 않게: 충돌체마다 Wasm 6번, 볼록 껍질은 꼭짓점 복사).
 * 입력: yaw, 충돌체 목록, 충돌체·부모 몸의 변경 도장(physics/colliderWatch.ts: 자세·모양·켜짐·센서 setter), 고정이 아닌 부모 몸이면 그 자세
 * (world.step이 setter 없이 바꾼다). 모두 같으면 Rapier가 돌려줄 값도 같아 계산 결과가 같다. 돌려주는 발자국은 늘 새 객체다
 */
export class FootprintCache {
  private key: number[] = [];
  private f: Footprint | null = null;
  private has = false;

  get(cols: readonly RAPIER.Collider[], yaw?: number): Footprint | null {
    const k: number[] = [yaw ?? NaN, cols.length];
    let last: RAPIER.RigidBody | null = null;
    for (const c of cols) {
      k.push(c.handle, stampOf(c));
      const b = c.parent();
      // 한 물체의 충돌체는 보통 한 몸에 붙어 있다: 몸 자세는 몸이 바뀔 때만 읽는다 (순서는 늘 같아 키가 같은 뜻이다)
      if (b && b !== last && !isFixedCached(b)) {
        last = b;
        const t = b.translation();
        const r = b.rotation();
        k.push(t.x, t.y, t.z, r.x, r.y, r.z, r.w);
      }
    }
    if (!this.has || !sameKey(k, this.key)) {
      this.f = colliderFootprint(cols, yaw);
      this.key = k;
      this.has = true;
    }
    const f = this.f;
    return f && { center: f.center.clone(), half: f.half.clone(), yaw: f.yaw };
  }
}

function sameKey(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  // NaN(yaw 없음)끼리는 같다
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(a[i] !== a[i] && b[i] !== b[i])) return false;
  return true;
}

/** Object3D 메시들의 발자국 (메시 경계 상자 모서리, 외곽선 메시 제외). yaw는 오브젝트 방향 */
export function objectFootprint(o: THREE.Object3D): Footprint | null {
  o.updateWorldMatrix(true, true);
  const yaw = yawOf(o.getWorldQuaternion(_q));
  const pts: number[] = [];
  const b = new THREE.Box3();
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh || m.userData.isOutline || !m.visible) return;
    const g = m.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    b.copy(g.boundingBox!);
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(m.matrixWorld);
      pts.push(_v.x, _v.y, _v.z);
    }
  });
  return boxOfPoints(pts, yaw);
}

/** 발자국을 긴 쪽으로 n조각 */
function splitFootprint(f: Footprint, n: number): Footprint[] {
  const longX = f.half.x >= f.half.z;
  const out: Footprint[] = [];
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  for (let i = 0; i < n; i++) {
    const k = -1 + (2 * i + 1) / n;
    const lx = longX ? f.half.x * k : 0;
    const lz = longX ? 0 : f.half.z * k;
    out.push({
      center: new THREE.Vector3(f.center.x + lx * c + lz * s, f.center.y, f.center.z - lx * s + lz * c),
      half: new THREE.Vector3(longX ? f.half.x / n + 0.05 : f.half.x, f.half.y, longX ? f.half.z : f.half.z / n + 0.05),
      yaw: f.yaw,
    });
  }
  return out;
}

function moved(a: Footprint, b: Footprint, dist = 0.25, turn = 0.07): boolean {
  let dy = Math.abs(a.yaw - b.yaw) % (Math.PI * 2);
  if (dy > Math.PI) dy = Math.PI * 2 - dy;
  return Math.hypot(a.center.x - b.center.x, a.center.z - b.center.z) > dist || Math.abs(a.center.y - b.center.y) > 0.3 || dy > turn;
}

export class NavObstacles {
  readonly stats: NavObstacleStats = { cut: 0, pieces: 0, adds: 0, removes: 0, splits: 0, deferred: 0, moving: 0, steers: 0, runtime: 0 };
  /** 끄면 아무것도 깎지 않는다 (?navobs=0, 전후 비교) */
  enabled = true;
  private readonly tracked = new Map<object, Tracked>();
  /** 대기열: 넣기(t)·빼기(cut) */
  private readonly queue: ({ kind: 'add'; t: Tracked } | { kind: 'remove'; cut: Cut })[] = [];
  /** 내비마다 아직 반영 안 된 요청 수 */
  private readonly inflight = new Map<NavWorld, number>();
  private time = 0;
  private colliderCount = -1;
  private scanT = 0;
  /** 조향 회피: 이번 스텝의 달리는 물체 발자국과 속도. yieldsTo: 이 묶음의 걷는 이에게 길을 비켜 준다 (steer에서 건너뜀) */
  private readonly movers: { f: Footprint; vel: THREE.Vector3; yieldsTo: string | null }[] = [];

  constructor(private readonly ctx: NavObstaclesContext) {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('navobs') === '0') this.enabled = false;
  }

  /** 고정 스텝마다: 움직이는 물체를 따라가고 요청 몇 개를 넣고, 붙은 내비를 update() */
  fixedUpdate(dt: number): void {
    this.time += dt;
    const navs = [...this.ctx.navs()];
    if (this.enabled && navs.length) {
      this.trackMovers(dt);
      this.scanT -= dt;
      if (this.scanT <= 0) {
        this.scanT = 1;
        this.scanRuntime();
      }
      for (const t of this.tracked.values()) this.step(t, dt);
      this.pump(navs);
    }
    for (const [, nav] of navs) {
      const pending = nav.update();
      if (!pending) this.inflight.set(nav, 0);
    }
  }

  // ------------------------------------------------------------------ 움직이는 물체

  private trackMovers(dt: number): void {
    this.movers.length = 0;
    const seen = new Set<object>();
    for (const v of this.ctx.movers()) {
      seen.add(v);
      let t = this.tracked.get(v);
      if (!t) {
        const fc = new FootprintCache();
        t = {
          key: v,
          footprint: () => fc.get(v.colliders, yawOf(_q.copy(v.root.getWorldQuaternion(new THREE.Quaternion())))),
          moving: () => {
            if (!v.body.isEnabled() || !v.root.visible) return true; // 숨은 물체는 깎지 않는다
            const lv = v.body.linvel();
            const av = v.body.angvel();
            // 스스로 길을 찾는 물체: 기다리거나 기어가면(1.5 m/s 아래) 서 있는 것으로 본다. 깎였거나 깎는 중이면 2.2 m/s 넘어야 달린다 (깜빡이지 않게)
            if (v.navWait != null) {
              const tr = this.tracked.get(v);
              const sp = Math.max(Math.abs(v.speed), Math.hypot(lv.x, lv.z));
              return sp > (v.navWait || tr?.cut || tr?.queued ? SLOW_OFF : SLOW_ON);
            }
            return Math.abs(v.speed) > 0.3 || lv.x * lv.x + lv.z * lv.z > 0.09 || Math.abs(av.y) > 0.15;
          },
          stillT: 0,
          holdUntil: 0,
          cut: null,
          queued: false,
          alive: true,
        };
        this.tracked.set(v, t);
      }
      t.alive = true;
      t.ai = v.navWait != null;
      // 게임 코드가 이 물체를 직접 장애물로 넣었으면 (nav.addObjectObstacle(v.root)) 건너뛴다
      const manual = [...this.ctx.navs()].some(([, n]) => n.hasObjectObstacle(v.root));
      if (manual) {
        t.stillT = 0;
        if (t.cut) this.unCut(t);
        continue;
      }
      if (t.moving() && v.body.isEnabled() && v.root.visible) {
        const f = t.footprint();
        const lv = v.body.linvel();
        if (f && Math.hypot(lv.x, lv.z) > 0.5) this.movers.push({ f, vel: new THREE.Vector3(lv.x, 0, lv.z), yieldsTo: v.navWait != null ? (v.yieldsTo ?? null) : null });
      }
    }
    for (const [k, t] of this.tracked) {
      if (k instanceof Object && 'colliders' in k && !seen.has(k)) {
        // 사라진 물체
        if (t.cut) this.unCut(t);
        this.tracked.delete(k);
      }
    }
    this.stats.moving = this.movers.length;
    void dt;
  }

  /** 한 대: 멈춘 지 1초면 깎고, 움직이거나 자리가 바뀌면 뺀다 */
  private step(t: Tracked, dt: number): void {
    if (!t.alive) {
      if (t.cut) this.unCut(t);
      return;
    }
    const ai = !!t.ai;
    if (t.moving()) {
      if (t.stillT > 0 || t.cut) t.holdUntil = this.time + (ai ? AI_HOLD : RECUT_HOLD);
      t.stillT = 0;
      if (t.cut) this.unCut(t);
      return;
    }
    t.stillT += dt;
    if (t.stillT < (ai ? AI_STILL : STILL_TIME) || this.time < t.holdUntil || t.queued) return;
    if (t.cut) {
      // 멈춘 채 밀렸다(굴러 섬, 받힘): 0.25 m·4° 넘게 바뀌었으면 다시. 기어가는 물체는 1 m·8°마다
      const f = t.footprint();
      if (f && (ai ? moved(f, t.cut.at, AI_MOVE, AI_TURN) : moved(f, t.cut.at))) this.unCut(t);
      else return;
    }
    t.queued = true;
    this.queue.push({ kind: 'add', t });
  }

  private unCut(t: Tracked): void {
    const c = t.cut;
    t.cut = null;
    if (c) this.queue.push({ kind: 'remove', cut: c });
  }

  // ------------------------------------------------------------------ 나중에 세운 고정 충돌체

  private scanRuntime(): void {
    const world = this.ctx.physics().world;
    const n = world.colliders.len();
    if (n === this.colliderCount) {
      // 수가 같아도 없어진 것은 따로 본다 (같은 스텝에 하나 빠지고 하나 생김: 드묾)
      for (const t of this.tracked.values()) {
        if (!(t.key instanceof RuntimeKey)) continue;
        const c = world.colliders.contains(t.key.handle) ? world.getCollider(t.key.handle) : null;
        if (!c || !isEnabledCached(c)) t.alive = false;
      }
      return;
    }
    this.colliderCount = n;
    const levelCols = new Set<number>();
    for (const l of this.ctx.levels()) for (const c of l.colliders) levelCols.add(c.handle);
    for (const [l] of this.ctx.navs()) for (const c of l.colliders) levelCols.add(c.handle);
    const live = new Set<number>();
    // 켜짐·센서·고정 몸은 바뀔 때까지 Wasm에 다시 묻지 않는다 (physics/colliderWatch.ts: 수가 바뀔 때마다 모든 충돌체를 훑는다)
    world.colliders.forEach((c) => {
      if (isSensorCached(c) || !isEnabledCached(c) || levelCols.has(c.handle)) return;
      const b = c.parent();
      if (b && !isFixedCached(b)) return;
      if (this.ctx.physics().ownerOf(c) !== undefined) return;
      live.add(c.handle);
      const known = this.runtimeKeys.get(c.handle);
      if (known) {
        // 꺼졌다 다시 켜진 충돌체 (같은 수 훑기가 죽은 것으로 적어 둔 것): 다시 깎는다
        const t = this.tracked.get(known);
        if (t) t.alive = true;
        return;
      }
      const key = new RuntimeKey(c.handle);
      this.runtimeKeys.set(c.handle, key);
      const col = c;
      const cols = [col];
      const fc = new FootprintCache();
      const f0 = fc.get(cols);
      // 발목 아래 판(0.25 m 아래)은 걸어서 넘는다: 깎지 않는다
      if (!f0 || f0.half.y * 2 - 0.3 < 0.25) return;
      this.tracked.set(key, {
        key,
        footprint: () => (world.colliders.contains(key.handle) ? fc.get(cols) : null),
        moving: () => false,
        stillT: STILL_TIME,
        holdUntil: 0,
        cut: null,
        queued: false,
        alive: true,
      });
    });
    for (const [h, key] of this.runtimeKeys) {
      if (live.has(h)) continue;
      this.runtimeKeys.delete(h);
      const t = this.tracked.get(key);
      if (t) {
        t.alive = false;
        if (t.cut) this.unCut(t);
        this.tracked.delete(key);
      }
    }
    this.stats.runtime = this.runtimeKeys.size;
  }

  private readonly runtimeKeys = new Map<number, RuntimeKey>();

  /**
   * 나중에 세운 충돌체를 다음 고정 스텝에 다시 훑는다 (충돌체를 켜고 껐을 때, 레벨이 붙었을 때).
   * 충돌체 수만 보는 훑기는 켜고 끔이나 같은 수의 넣고 빼기를 놓친다
   */
  rescan(): void {
    this.colliderCount = -1;
    this.scanT = 0;
  }

  // ------------------------------------------------------------------ 요청 넣기 (시간 나누기)

  private pump(navs: [Level, NavWorld][]): void {
    let budget = REQ_PER_STEP;
    let guard = this.queue.length;
    while (budget > 0 && this.queue.length && guard-- > 0) {
      const job = this.queue.shift()!;
      if (job.kind === 'remove') {
        const c = job.cut;
        if (c.nav.isDisposed) continue;
        if ((this.inflight.get(c.nav) ?? 0) + c.obstacles.length > MAX_INFLIGHT) {
          this.queue.push(job);
          this.stats.deferred++;
          continue;
        }
        for (const o of c.obstacles) c.nav.removeObstacle(o);
        this.inflight.set(c.nav, (this.inflight.get(c.nav) ?? 0) + c.obstacles.length);
        this.stats.removes++;
        budget -= c.obstacles.length;
        continue;
      }
      const t = job.t;
      t.queued = false;
      if (!t.alive || t.cut || t.moving()) continue;
      const f = t.footprint();
      if (!f) continue;
      const nav = navs.find(([, n]) => n.contains(f.center))?.[1];
      if (!nav) continue;
      const pieces = this.pieces(nav, f);
      if ((this.inflight.get(nav) ?? 0) + pieces.length > MAX_INFLIGHT) {
        t.queued = true;
        this.queue.push(job);
        this.stats.deferred++;
        continue;
      }
      const obstacles: Obstacle[] = [];
      for (const p of pieces) {
        const o = nav.addBoxObstacle(p.center, p.half, p.yaw);
        if (o) obstacles.push(o);
      }
      if (!obstacles.length) {
        // 요청 큐가 찼다: 다음에
        t.queued = true;
        this.queue.push(job);
        this.stats.deferred++;
        break;
      }
      t.cut = { nav, obstacles, at: f };
      this.inflight.set(nav, (this.inflight.get(nav) ?? 0) + obstacles.length);
      this.stats.adds++;
      budget -= obstacles.length;
    }
    let cut = 0;
    let pieces = 0;
    for (const t of this.tracked.values()) {
      if (!t.cut) continue;
      cut++;
      pieces += t.cut.obstacles.length;
    }
    this.stats.cut = cut;
    this.stats.pieces = pieces;
  }

  /** 건드리는 타일이 8개를 넘지 않게 쪼갠다 (DT_MAX_TOUCHED_TILES: 넘는 타일은 조용히 안 깎인다) */
  private pieces(nav: NavWorld, f: Footprint): Footprint[] {
    for (let n = 1; n <= 6; n++) {
      const parts = n === 1 ? [f] : splitFootprint(f, n);
      if (parts.every((p) => nav.touchedTiles(p.center, p.half, p.yaw) <= MAX_TOUCHED)) {
        if (n > 1) this.stats.splits++;
        return parts;
      }
    }
    this.stats.splits++;
    return splitFootprint(f, 6);
  }

  // ------------------------------------------------------------------ 조향 회피 (달리는 물체)

  /**
   * 걷는 캐릭터의 이번 스텝 이동(desired, m)을 달리는 물체 앞에서 비킨다. 1.2초 앞까지 물체와 내가 겹칠 것 같으면 물체 진행 방향의
   * 옆(지금 내가 있는 쪽)으로 돌린다. 내비메시는 건드리지 않는다. who: 걷는 이의 묶음 이름 (MovingObstacle.yieldsTo). 바꿨으면 true
   */
  steer(pos: THREE.Vector3, desired: THREE.Vector3, dt: number, radius = 0.22, who: string | null = null): boolean {
    if (!this.movers.length || dt <= 0) return false;
    let changed = false;
    const vx = desired.x / dt;
    const vz = desired.z / dt;
    for (const m of this.movers) {
      // 길을 비켜 주는 물체는 그 묶음 앞에서 서고, 기다리면 깎인다: 걷는 이가 옆으로 비켜 서며 제자리걸음하지 않게 조향으로 피하지 않는다
      if (m.yieldsTo && who === m.yieldsTo) continue;
      const f = m.f;
      if (Math.abs(pos.y - (f.center.y - f.half.y + 0.3)) > 2) continue;
      const c = Math.cos(f.yaw);
      const s = Math.sin(f.yaw);
      const hx = f.half.x + radius + 0.45;
      const hz = f.half.z + radius + 0.45;
      // 내 상대 속도 (물체 기준)
      const rvx = vx - m.vel.x;
      const rvz = vz - m.vel.z;
      let hitT = -1;
      for (let t = 0; t <= 1.2; t += 0.15) {
        const px = pos.x + rvx * t - f.center.x;
        const pz = pos.z + rvz * t - f.center.z;
        const lx = px * c - pz * s;
        const lz = px * s + pz * c;
        if (Math.abs(lx) < hx && Math.abs(lz) < hz) {
          hitT = t;
          break;
        }
      }
      if (hitT < 0) continue;
      // 진행 방향의 옆으로: 물체 속도에 수직, 지금 내가 있는 쪽
      const sp = Math.hypot(m.vel.x, m.vel.z);
      if (sp < 1e-3) continue;
      const ux = m.vel.x / sp;
      const uz = m.vel.z / sp;
      const ox = pos.x - f.center.x;
      const oz = pos.z - f.center.z;
      const side = ox * -uz + oz * ux >= 0 ? 1 : -1;
      const nx = -uz * side;
      const nz = ux * side;
      const want = Math.max(Math.hypot(vx, vz), 2.2) * (hitT < 0.5 ? 1.2 : 0.9);
      // 물체 쪽으로 가는 성분을 지우고 옆으로. 물체 앞에서 마주 보고 걸어오면 앞으로 가는 성분도 지운다 (옆으로만 비킨다)
      const along = vx * ux + vz * uz;
      const toward = Math.min(0, vx * nx + vz * nz);
      const ahead = ox * ux + oz * uz > 0;
      const keepAlong = along > 0 ? along * 0.5 : ahead ? along : 0;
      desired.x = (vx - nx * toward - ux * keepAlong + nx * want) * dt;
      desired.z = (vz - nz * toward - uz * keepAlong + nz * want) * dt;
      changed = true;
    }
    if (changed) this.stats.steers++;
    return changed;
  }

  /** 레벨을 뗄 때: 그 내비의 장애물 기록을 버린다 (내비가 같이 버려지면) */
  forget(nav: NavWorld): void {
    for (const t of this.tracked.values()) if (t.cut?.nav === nav) t.cut = null;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const j = this.queue[i];
      if (j.kind === 'remove' && j.cut.nav === nav) this.queue.splice(i, 1);
    }
    this.inflight.delete(nav);
  }

  snapshot(): Record<string, unknown> {
    return { ...this.stats, queue: this.queue.length, tracked: this.tracked.size };
  }
}

/** 나중에 세운 고정 충돌체의 키 (핸들) */
class RuntimeKey {
  constructor(readonly handle: number) {}
}
