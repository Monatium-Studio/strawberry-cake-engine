import type RAPIER_NS from '@dimforge/rapier3d-compat';
import {
  ACTOR_STRIDE,
  BODY_STRIDE,
  CLS_GHOSTABLE,
  CLS_SKIP,
  COL_STRIDE,
  HIT_STRIDE,
  MOVE_STRIDE,
  RES_STRIDE,
  type ControllerParams,
  type GravityParams,
  type MirrorSnap,
  type ShapeData,
} from './protocol';

type R = typeof RAPIER_NS;

interface Actor {
  x: number;
  y: number;
  z: number;
  vy: number;
  grounded: boolean;
  firstStep: number;
  col: RAPIER_NS.Collider | null;
  /** 지난 이동 뒤 몸 방향 (이 묶음에서 아직 움직이지 않았으면 null: 메인 회전 그대로) */
  yaw: number | null;
}

/**
 * 워커 쪽 거울 월드 (protocol.ts). 메인이 보낸 스냅샷으로 몸·콜라이더를 맞추고, 스텝마다 이동을 메인과 같은 순서·같은 식으로 계산한다:
 * 스텝 j의 이동 주체는 모두 스텝 j 처음 자리에서 서로를 보고(메인도 다음 키네마틱 자리가 다음 world.step에야 반영된다), 이동 뒤 자리는 다음 스텝에 놓인다.
 */
export class MirrorCore {
  readonly world: RAPIER_NS.World;
  private readonly ctl: RAPIER_NS.KinematicCharacterController;
  private readonly bodies = new Map<number, RAPIER_NS.RigidBody>();
  private readonly cols = new Map<number, RAPIER_NS.Collider>();
  /** 거울 콜라이더 handle → 메인 handle (점검) */
  private readonly mainOf = new Map<number, number>();
  /** 주체마다 마지막 묶음 끝 상태 (다음 묶음이 메인 상태 없이 이을 때) */
  private readonly carry = new Map<number, Actor>();
  /** 거울 콜라이더 handle → 분류 (CLS_*): 메인 moveFilter 대신 쓰는 술어 */
  private readonly cls = new Map<number, number>();
  private readonly solidFilter = (c: RAPIER_NS.Collider) => this.cls.get(c.handle) !== CLS_SKIP;
  private readonly ghostFilter = (c: RAPIER_NS.Collider) => {
    const k = this.cls.get(c.handle);
    return k !== CLS_SKIP && k !== CLS_GHOSTABLE;
  };
  /** 점검: 이동마다 닿은 콜라이더를 돌려준다 */
  debugHits = false;
  private readonly v = { x: 0, y: 0, z: 0 };
  private readonly q = { x: 0, y: 0, z: 0, w: 1 };

  constructor(
    private readonly R: R,
    controller: ControllerParams,
    private readonly gravity: GravityParams,
    timestep: number,
    private readonly queryFlags: number,
    private readonly queryGroups: number,
  ) {
    this.world = new R.World({ x: 0, y: 0, z: 0 });
    this.world.timestep = timestep;
    const c = (this.ctl = this.world.createCharacterController(controller.offset));
    c.setUp(controller.up);
    c.setMaxSlopeClimbAngle(controller.maxSlopeClimbAngle);
    c.setMinSlopeSlideAngle(controller.minSlopeSlideAngle);
    if (controller.autostep) c.enableAutostep(controller.autostep.maxHeight, controller.autostep.minWidth, controller.autostep.includeDynamic);
    else c.disableAutostep();
    if (controller.snapToGround !== null) c.enableSnapToGround(controller.snapToGround);
    else c.disableSnapToGround();
    c.setSlideEnabled(controller.slide);
    c.setNormalNudgeFactor(controller.normalNudgeFactor);
    // 거울에는 밀 몸이 없다 (동적 몸은 메인 자세를 받기만 한다)
    c.setApplyImpulsesToDynamicBodies(false);
  }

  get counts(): { bodies: number; colliders: number } {
    return { bodies: this.bodies.size, colliders: this.cols.size };
  }

  private shapeOf(s: ShapeData): RAPIER_NS.Shape {
    const R = this.R;
    const a = s.a;
    switch (s.t) {
      case R.ShapeType.Ball:
        return new R.Ball(a[0]);
      case R.ShapeType.Cuboid:
        return new R.Cuboid(a[0], a[1], a[2]);
      case R.ShapeType.RoundCuboid:
        return new R.RoundCuboid(a[0], a[1], a[2], a[3]);
      case R.ShapeType.Capsule:
        return new R.Capsule(a[0], a[1]);
      case R.ShapeType.Cylinder:
        return new R.Cylinder(a[0], a[1]);
      case R.ShapeType.Cone:
        return new R.Cone(a[0], a[1]);
      case R.ShapeType.Segment:
        return new R.Segment({ x: a[0], y: a[1], z: a[2] }, { x: a[3], y: a[4], z: a[5] });
      case R.ShapeType.Triangle:
        return new R.Triangle({ x: a[0], y: a[1], z: a[2] }, { x: a[3], y: a[4], z: a[5] }, { x: a[6], y: a[7], z: a[8] });
      case R.ShapeType.TriMesh:
        return new R.TriMesh(s.v!, s.i!, s.f);
      case R.ShapeType.ConvexPolyhedron:
        return new R.ConvexPolyhedron(s.v!, s.i ?? null);
      default:
        throw new Error(`mirror: unsupported shape type ${s.t}`);
    }
  }

  /** 스냅샷 하나를 거울에 반영한다 */
  applySnap(s: MirrorSnap): void {
    const R = this.R;
    const w = this.world;
    for (const h of s.collidersGone) {
      const c = this.cols.get(h);
      if (!c) continue;
      this.cols.delete(h);
      this.carry.delete(h);
      this.cls.delete(c.handle);
      this.mainOf.delete(c.handle);
      if (c.isValid()) w.removeCollider(c, false);
    }
    for (const h of s.bodiesGone) {
      const b = this.bodies.get(h);
      if (!b) continue;
      this.bodies.delete(h);
      // 붙은 콜라이더는 Rapier가 같이 지운다 (메인도 collidersGone에 넣어 보낸다)
      w.removeRigidBody(b);
    }
    const B = s.bodies;
    for (let i = 0; i < B.length; i += BODY_STRIDE) {
      const h = B[i];
      // 거울의 동적 몸은 동적 그대로 둔다 (자동 계단 오르기가 동적 몸을 빼는 것까지 같게). 속도 적분 기반 키네마틱은 자세 기반으로
      let type = B[i + 1] as RAPIER_NS.RigidBodyType;
      if (type === R.RigidBodyType.KinematicVelocityBased) type = R.RigidBodyType.KinematicPositionBased;
      const enabled = B[i + 2] !== 0;
      const jump = B[i + 3] !== 0;
      this.v.x = B[i + 4];
      this.v.y = B[i + 5];
      this.v.z = B[i + 6];
      this.q.x = B[i + 7];
      this.q.y = B[i + 8];
      this.q.z = B[i + 9];
      this.q.w = B[i + 10];
      let b = this.bodies.get(h);
      if (!b) {
        b = w.createRigidBody(new R.RigidBodyDesc(type).setTranslation(this.v.x, this.v.y, this.v.z).setRotation(this.q).setEnabled(enabled).setCanSleep(false));
        this.bodies.set(h, b);
        continue;
      }
      if (b.bodyType() !== type) b.setBodyType(type, false);
      if (b.isEnabled() !== enabled) b.setEnabled(enabled);
      this.placeBody(b, this.v, this.q, jump);
    }
    for (const [h, sd] of s.shapes) {
      const c = this.cols.get(h);
      if (c) c.setShape(this.shapeOf(sd));
    }
    const C = s.colliders;
    let shapeIdx = 0;
    const shapes = s.shapes;
    for (let i = 0; i < C.length; i += COL_STRIDE) {
      const h = C[i];
      const parent = C[i + 1];
      const density = C[i + 6];
      this.v.x = C[i + 7];
      this.v.y = C[i + 8];
      this.v.z = C[i + 9];
      this.q.x = C[i + 10];
      this.q.y = C[i + 11];
      this.q.z = C[i + 12];
      this.q.w = C[i + 13];
      let c = this.cols.get(h);
      if (!c) {
        let sd: ShapeData | null = null;
        // 모양은 같은 순서로 온다 (대개 바로 그 자리)
        if (shapeIdx < shapes.length && shapes[shapeIdx][0] === h) sd = shapes[shapeIdx++][1];
        else sd = shapes.find((x) => x[0] === h)?.[1] ?? null;
        if (!sd) throw new Error(`mirror: collider ${h} without shape`);
        const desc = new R.ColliderDesc(this.shapeOf(sd));
        desc.setTranslation(this.v.x, this.v.y, this.v.z).setRotation(this.q);
        // 거울에서는 접촉을 만들지 않는다 (질의만 한다: 동적 몸이 바닥에 밀려 움직이지 않게)
        desc.setActiveCollisionTypes(0 as RAPIER_NS.ActiveCollisionTypes);
        // 밀도는 메인과 같게: 키네마틱 몸의 무게 중심이 velocity_at_point(움직이는 발판)에 들어간다
        desc.setDensity(density);
        const pb = parent >= 0 ? this.bodies.get(parent) : undefined;
        if (parent >= 0 && !pb) throw new Error(`mirror: collider ${h} parent ${parent} missing`);
        c = w.createCollider(desc, pb);
        this.cols.set(h, c);
        this.mainOf.set(c.handle, h);
      } else if (parent >= 0) {
        c.setTranslationWrtParent(this.v);
        c.setRotationWrtParent(this.q);
      } else {
        c.setTranslation(this.v);
        c.setRotation(this.q);
      }
      const enabled = C[i + 2] !== 0;
      if (c.isEnabled() !== enabled) c.setEnabled(enabled);
      const sensor = C[i + 3] !== 0;
      if (c.isSensor() !== sensor) c.setSensor(sensor);
      const groups = C[i + 4];
      if (c.collisionGroups() !== groups) c.setCollisionGroups(groups);
      if (c.density() !== density) c.setDensity(density);
      this.cls.set(c.handle, C[i + 5]);
    }
  }

  /**
   * 메인 자세로 놓는다. 키네마틱 몸은 다음 자세로만 (거울 step이 메인 world.step과 같은 선·각속도를 낸다), jump면 바로 옮긴 뒤 다음 자세도 같게(속도 0).
   * 동적 몸은 바로 옮기고 멈춘다 (컨트롤러는 동적 몸의 속도를 보지 않는다. 거울에서는 접촉이 없어 제자리에 있다)
   */
  private placeBody(b: RAPIER_NS.RigidBody, t: RAPIER_NS.Vector, q: RAPIER_NS.Rotation, jump: boolean): void {
    if (b.isKinematic()) {
      if (jump) {
        b.setTranslation(t, false);
        b.setRotation(q, false);
      }
      b.setNextKinematicTranslation(t);
      b.setNextKinematicRotation(q);
      return;
    }
    b.setTranslation(t, false);
    b.setRotation(q, false);
    if (b.isDynamic()) {
      b.setLinvel(ZERO, false);
      b.setAngvel(ZERO, false);
    }
  }

  /** 워커가 움직이는 주체: 다음 키네마틱 자세로 (yaw가 있으면 몸 회전도: 메인 쪽 몸 동기화와 같은 식) */
  private placeActor(b: RAPIER_NS.RigidBody, a: Actor): void {
    this.v.x = a.x;
    this.v.y = a.y;
    this.v.z = a.z;
    if (!b.isKinematic()) {
      b.setTranslation(this.v, false);
      return;
    }
    b.setNextKinematicTranslation(this.v);
    if (a.yaw !== null) {
      const h = (a.yaw + Math.PI) / 2;
      this.q.x = 0;
      this.q.y = Math.sin(h);
      this.q.z = 0;
      this.q.w = Math.cos(h);
      b.setNextKinematicRotation(this.q);
    }
  }

  /**
   * 한 묶음: 스텝마다 스냅샷 → 주체 자세 → 거울 step(자세 반영·BVH 갱신) → 그 스텝 이동들.
   * 결과는 이동 순서대로 RES_STRIDE씩. 동적 몸에 닿은 이동 수(dyn)와 거울에 없는 주체 수(missing)도 센다
   */
  runBatch(steps: { snap: MirrorSnap; moves: Float64Array }[], actorsData: Float64Array): { res: Float64Array; dyn: number; missing: number; hits?: Float64Array } {
    const actors = new Map<number, Actor>();
    for (let i = 0; i < actorsData.length; i += ACTOR_STRIDE) {
      const key = actorsData[i];
      const col = this.cols.get(key) ?? null;
      let a: Actor;
      if (Number.isNaN(actorsData[i + 1])) {
        // 앞 묶음이 메인에 아직 놓이지 않았다: 이 워커가 그 묶음 끝에 남긴 상태에서 잇는다
        const prev = this.carry.get(key);
        if (!prev) continue;
        a = { ...prev, firstStep: actorsData[i + 6], col };
      } else a = { x: actorsData[i + 1], y: actorsData[i + 2], z: actorsData[i + 3], vy: actorsData[i + 4], grounded: actorsData[i + 5] !== 0, firstStep: actorsData[i + 6], col, yaw: null };
      actors.set(key, a);
    }
    let total = 0;
    for (const st of steps) total += st.moves.length / MOVE_STRIDE;
    const res = new Float64Array(total * RES_STRIDE);
    const hits = this.debugHits ? new Float64Array(total * HIT_STRIDE).fill(-1) : undefined;
    let ri = 0;
    let dyn = 0;
    let missing = 0;
    const g = this.gravity;
    const flags = this.queryFlags as RAPIER_NS.QueryFilterFlags;
    const desired = { x: 0, y: 0, z: 0 };
    const mv = { x: 0, y: 0, z: 0 };
    let step = 0;
    for (const st of steps) {
      this.applySnap(st.snap);
      // 이 스텝부터 워커가 움직이는 주체: 메인 자세(한 프레임 늦음) 대신 워커가 계산한 자리에 둔다 (콜라이더는 스텝마다 다시 찾는다: 이 묶음에서 막 생겼을 수 있다)
      for (const [key, a] of actors) {
        if (step < a.firstStep) continue;
        if (!a.col || !a.col.isValid()) a.col = this.cols.get(key) ?? null;
        const b = a.col?.parent() ?? null;
        if (b) this.placeActor(b, a);
      }
      this.world.step();
      const M = st.moves;
      for (let i = 0; i < M.length; i += MOVE_STRIDE) {
        const key = M[i];
        const explicit = !Number.isNaN(M[i + 7]);
        const a = actors.get(key);
        const col = a?.col ?? this.cols.get(key) ?? null;
        if (!col || !col.isValid() || (!explicit && !a)) {
          missing++;
          res.fill(NaN, ri, ri + RES_STRIDE);
          ri += RES_STRIDE;
          continue;
        }
        const dt = M[i + 5];
        desired.x = M[i + 1];
        desired.z = M[i + 2];
        let vy = 0;
        if (explicit) desired.y = M[i + 10];
        else {
          const ac = a!;
          vy = ac.grounded ? g.ground : Math.max(g.min, ac.vy - g.g * dt);
          ac.vy = vy;
          desired.y = vy * dt;
        }
        this.ctl.computeColliderMovement(col, desired, flags, this.queryGroups, M[i + 4] ? this.ghostFilter : this.solidFilter);
        this.ctl.computedMovement(mv as RAPIER_NS.Vector);
        clampFlat(mv, M[i + 3]);
        const grounded = this.ctl.computedGrounded();
        const nc = this.ctl.numComputedCollisions();
        let touch = 0;
        for (let k = nc - 1; k >= 0; k--) {
          const hit = this.ctl.computedCollision(k);
          if (hit?.collider?.parent()?.isDynamic()) {
            dyn++;
            touch = 1;
            break;
          }
        }
        if (hits) {
          const o = (ri / RES_STRIDE) * HIT_STRIDE;
          for (let k = 0; k < Math.min(nc, 3); k++) {
            const hc = this.ctl.computedCollision(k)?.collider;
            hits[o + k] = hc ? (this.mainOf.get(hc.handle) ?? -2) : -3;
          }
          const t = col.translation();
          hits[o + 3] = t.x;
          hits[o + 4] = t.y;
          hits[o + 5] = t.z;
          const f = nc ? this.ctl.computedCollision(0)?.collider?.translation() : null;
          if (f) (hits[o + 6] = f.x), (hits[o + 7] = f.y), (hits[o + 8] = f.z);
        }
        if (!explicit) {
          const ac = a!;
          ac.grounded = grounded;
          ac.x += mv.x;
          ac.y += mv.y;
          ac.z += mv.z;
          ac.yaw = M[i + 6];
        }
        res[ri] = mv.x;
        res[ri + 1] = mv.y;
        res[ri + 2] = mv.z;
        res[ri + 3] = grounded ? 1 : 0;
        res[ri + 4] = vy;
        res[ri + 5] = touch;
        ri += RES_STRIDE;
      }
      step++;
    }
    for (const [key, a] of actors) this.carry.set(key, a);
    return { res, dyn, missing, hits };
  }
}

const ZERO = { x: 0, y: 0, z: 0 };

/** 수평 속도를 max로 자른다 (메인 쪽 이동 계산과 같은 식이어야 한다) */
export function clampFlat(v: { x: number; z: number }, max: number): void {
  const h = Math.hypot(v.x, v.z);
  if (h <= max || h < 1e-9) return;
  const k = max / h;
  v.x *= k;
  v.z *= k;
}
