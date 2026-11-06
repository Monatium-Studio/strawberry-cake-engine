import RAPIER from '@dimforge/rapier3d-compat';
import { type MirrorSnap, type ShapeData } from './protocol';

/**
 * 메인 월드 변경 기록 (물리 거울 워커, protocol.ts).
 * Rapier World·RigidBody·Collider 프로토타입의 생성·제거·변경 메서드를 한 번 감싸, 기록기가 붙은 월드의 바뀐 몸·콜라이더 handle만 모은다.
 * snapshot()은 그 순간의 상태를 Wasm에서 읽어 보낸다 (바뀐 것만, 동적 몸은 늘). 기록기가 없는 월드는 감싼 메서드가 WeakMap 조회 한 번만 더 한다.
 */

type AnyFn = (...a: never[]) => unknown;
const byColliders = new WeakMap<object, MirrorRecorder>();
let installed = false;

function wrap<T extends object>(proto: T, name: string, make: (orig: AnyFn) => AnyFn): void {
  const p = proto as Record<string, AnyFn>;
  const orig = p[name];
  if (typeof orig !== 'function') throw new Error(`mirror: Rapier has no ${name}`);
  p[name] = make(orig);
}

interface WorldLike {
  colliders: object;
}
interface OwnedLike {
  colliderSet: object;
  handle: number;
}

function install(): void {
  if (installed) return;
  installed = true;
  const W = RAPIER.World.prototype;
  wrap(W, 'createRigidBody', (orig) =>
    function (this: WorldLike, desc: RAPIER.RigidBodyDesc) {
      const b = (orig as (d: RAPIER.RigidBodyDesc) => RAPIER.RigidBody).call(this, desc);
      byColliders.get(this.colliders)?.bodyNew(b.handle, desc.status);
      return b;
    } as AnyFn,
  );
  wrap(W, 'createCollider', (orig) =>
    function (this: WorldLike, desc: RAPIER.ColliderDesc, parent?: RAPIER.RigidBody) {
      const c = (orig as (d: RAPIER.ColliderDesc, p?: RAPIER.RigidBody) => RAPIER.Collider).call(this, desc, parent);
      byColliders.get(this.colliders)?.colliderNew(c.handle, desc.shape);
      return c;
    } as AnyFn,
  );
  wrap(W, 'removeCollider', (orig) =>
    function (this: WorldLike, c: RAPIER.Collider, wake: boolean) {
      byColliders.get(this.colliders)?.colliderGone(c.handle);
      return (orig as (c: RAPIER.Collider, w: boolean) => void).call(this, c, wake);
    } as AnyFn,
  );
  wrap(W, 'removeRigidBody', (orig) =>
    function (this: WorldLike, b: RAPIER.RigidBody) {
      const r = byColliders.get(this.colliders);
      if (r) {
        for (let i = 0, n = b.numColliders(); i < n; i++) r.colliderGone(b.collider(i).handle);
        r.bodyGone(b.handle);
      }
      return (orig as (b: RAPIER.RigidBody) => void).call(this, b);
    } as AnyFn,
  );
  wrap(W, 'step', (orig) =>
    function (this: WorldLike, ...a: unknown[]) {
      const out = (orig as (...x: unknown[]) => void).apply(this, a);
      byColliders.get(this.colliders)?.stepped();
      return out;
    } as AnyFn,
  );
  wrap(W, 'free', (orig) =>
    function (this: WorldLike) {
      byColliders.get(this.colliders)?.detach();
      return (orig as () => void).call(this);
    } as AnyFn,
  );
  const B = RAPIER.RigidBody.prototype;
  const bodyNow = (name: string) =>
    wrap(B, name, (orig) =>
      function (this: OwnedLike, ...a: unknown[]) {
        const out = (orig as (...x: unknown[]) => unknown).apply(this, a);
        byColliders.get(this.colliderSet)?.bodyNow(this.handle);
        return out;
      } as AnyFn,
    );
  for (const n of ['setEnabled']) bodyNow(n);
  for (const n of ['setTranslation', 'setRotation'])
    wrap(B, n, (orig) =>
      function (this: OwnedLike, ...a: unknown[]) {
        const out = (orig as (...x: unknown[]) => unknown).apply(this, a);
        byColliders.get(this.colliderSet)?.bodyJump(this.handle);
        return out;
      } as AnyFn,
    );
  wrap(B, 'setBodyType', (orig) =>
    function (this: OwnedLike, ...a: unknown[]) {
      const out = (orig as (...x: unknown[]) => unknown).apply(this, a);
      byColliders.get(this.colliderSet)?.bodyTyped(this.handle, (this as unknown as RAPIER.RigidBody).bodyType());
      return out;
    } as AnyFn,
  );
  for (const n of ['setNextKinematicTranslation', 'setNextKinematicRotation'])
    wrap(B, n, (orig) =>
      function (this: OwnedLike, ...a: unknown[]) {
        const out = (orig as (...x: unknown[]) => unknown).apply(this, a);
        byColliders.get(this.colliderSet)?.bodyNext(this.handle);
        return out;
      } as AnyFn,
    );
  const C = RAPIER.Collider.prototype;
  for (const n of ['setTranslation', 'setRotation', 'setTranslationWrtParent', 'setRotationWrtParent', 'setEnabled', 'setSensor', 'setCollisionGroups'])
    wrap(C, n, (orig) =>
      function (this: OwnedLike, ...a: unknown[]) {
        const out = (orig as (...x: unknown[]) => unknown).apply(this, a);
        byColliders.get(this.colliderSet)?.colliderDirty(this.handle);
        return out;
      } as AnyFn,
    );
  for (const n of ['setShape', 'setHalfExtents', 'setRadius', 'setHalfHeight', 'setRoundRadius'])
    wrap(C, n, (orig) =>
      function (this: OwnedLike, ...a: unknown[]) {
        const out = (orig as (...x: unknown[]) => unknown).apply(this, a);
        byColliders.get(this.colliderSet)?.shapeDirty(this.handle);
        return out;
      } as AnyFn,
    );
}

/** Rapier 모양 → 보낼 수 있는 자료 */
export function shapeData(s: RAPIER.Shape): ShapeData {
  const T = RAPIER.ShapeType;
  switch (s.type) {
    case T.Ball:
      return { t: s.type, a: [(s as RAPIER.Ball).radius] };
    case T.Cuboid: {
      const h = (s as RAPIER.Cuboid).halfExtents;
      return { t: s.type, a: [h.x, h.y, h.z] };
    }
    case T.RoundCuboid: {
      const r = s as RAPIER.RoundCuboid;
      return { t: s.type, a: [r.halfExtents.x, r.halfExtents.y, r.halfExtents.z, r.borderRadius] };
    }
    case T.Capsule:
    case T.Cylinder:
    case T.Cone: {
      const c = s as RAPIER.Capsule;
      return { t: s.type, a: [c.halfHeight, c.radius] };
    }
    case T.Segment: {
      const g = s as RAPIER.Segment;
      return { t: s.type, a: [g.a.x, g.a.y, g.a.z, g.b.x, g.b.y, g.b.z] };
    }
    case T.Triangle: {
      const g = s as RAPIER.Triangle;
      return { t: s.type, a: [g.a.x, g.a.y, g.a.z, g.b.x, g.b.y, g.b.z, g.c.x, g.c.y, g.c.z] };
    }
    case T.TriMesh: {
      const m = s as RAPIER.TriMesh;
      return { t: s.type, a: [], v: m.vertices, i: m.indices, f: m.flags };
    }
    case T.ConvexPolyhedron: {
      const m = s as RAPIER.ConvexPolyhedron;
      return { t: s.type, a: [], v: m.vertices, i: m.indices ?? null };
    }
    default:
      throw new Error(`mirror: unsupported shape type ${s.type}`);
  }
}

export class MirrorRecorder {
  private readonly bodiesNew = new Set<number>();
  private readonly bodiesGone = new Set<number>();
  private readonly bodiesNow = new Set<number>();
  private readonly bodiesNext = new Set<number>();
  private readonly bodiesJump = new Set<number>();
  private readonly dynamic = new Set<number>();
  private readonly colsNew = new Map<number, RAPIER.Shape | null>();
  private readonly colsGone = new Set<number>();
  private readonly colsDirty = new Set<number>();
  private readonly shapesDirty = new Set<number>();
  private alive = true;
  /** true인 동안은 기록하지 않는다 (quiet: 메인이 잠깐 옮겼다 되돌리는 몸) */
  private muted = false;
  /** 콜라이더 분류 (protocol CLS_*): 게임이 소유자로 정한다. 바꾸면 reclassify() */
  classify: ((c: RAPIER.Collider, owner: unknown) => number) | null = null;

  /**
   * queryGroups: 거울이 섬기는 이동 질의 그룹 (워커 질의가 쓴다)
   * ownerOf: 콜라이더 handle → 게임 소유자 (Physics.ownerOf)
   */
  constructor(
    readonly world: RAPIER.World,
    readonly queryGroups: number,
    private readonly ownerOf: (handle: number) => unknown,
  ) {
    install();
    byColliders.set((world as unknown as WorldLike).colliders, this);
    // 이미 있는 것 (기록기를 늦게 붙였을 때)
    world.forEachRigidBody((b) => this.bodyNew(b.handle, b.bodyType()));
    world.forEachCollider((c) => this.colliderNew(c.handle, null));
  }

  get attached(): boolean {
    return this.alive;
  }

  detach(): void {
    if (!this.alive) return;
    this.alive = false;
    byColliders.delete((this.world as unknown as WorldLike).colliders);
  }

  /** fn 동안의 몸·콜라이더 변경을 기록하지 않는다 (fn이 끝나면 처음 상태로 되돌려 놓는 일만) */
  quiet<T>(fn: () => T): T {
    const was = this.muted;
    this.muted = true;
    try {
      return fn();
    } finally {
      this.muted = was;
    }
  }

  bodyNew(h: number, type: RAPIER.RigidBodyType): void {
    this.bodiesNew.add(h);
    if (type === RAPIER.RigidBodyType.Dynamic) this.dynamic.add(h);
  }

  bodyGone(h: number): void {
    this.dynamic.delete(h);
    this.bodiesNow.delete(h);
    this.bodiesNext.delete(h);
    this.bodiesJump.delete(h);
    if (this.bodiesNew.delete(h)) return;
    this.bodiesGone.add(h);
  }

  bodyNow(h: number): void {
    if (this.muted) return;
    this.bodiesNow.add(h);
  }

  bodyJump(h: number): void {
    if (this.muted) return;
    this.bodiesNow.add(h);
    this.bodiesJump.add(h);
  }

  bodyNext(h: number): void {
    this.bodiesNext.add(h);
  }

  bodyTyped(h: number, type: RAPIER.RigidBodyType): void {
    this.bodiesNow.add(h);
    if (type === RAPIER.RigidBodyType.Dynamic) this.dynamic.add(h);
    else this.dynamic.delete(h);
  }

  /** world.step 뒤: 다음 키네마틱 자세가 지금 자세가 됐다 */
  stepped(): void {
    for (const h of this.bodiesNext) this.bodiesNow.add(h);
    this.bodiesNext.clear();
  }

  colliderNew(h: number, shape: RAPIER.Shape | null): void {
    this.colsNew.set(h, shape);
  }

  colliderGone(h: number): void {
    this.colsDirty.delete(h);
    this.shapesDirty.delete(h);
    if (this.colsNew.delete(h)) return;
    this.colsGone.add(h);
  }

  colliderDirty(h: number): void {
    this.colsDirty.add(h);
  }

  shapeDirty(h: number): void {
    this.colsDirty.add(h);
    this.shapesDirty.add(h);
  }

  /** 소유자가 바뀐 콜라이더 (Physics.setOwner): 분류를 다시 보낸다 */
  ownerChanged(h: number): void {
    if (!this.colsNew.has(h)) this.colsDirty.add(h);
  }

  /** 분류 함수를 바꿨다: 모든 콜라이더를 다시 보낸다 */
  reclassify(): void {
    this.world.forEachCollider((c) => {
      if (!this.colsNew.has(c.handle)) this.colsDirty.add(c.handle);
    });
  }

  private clsOf(c: RAPIER.Collider): number {
    return this.classify ? this.classify(c, this.ownerOf(c.handle)) : 0;
  }

  /** 지금까지 바뀐 것을 지금 상태로 읽어 낸다 (기록은 비운다) */
  snapshot(): MirrorSnap {
    const w = this.world;
    const snap: MirrorSnap = { bodiesGone: [...this.bodiesGone], collidersGone: [...this.colsGone], bodies: [], shapes: [], colliders: [] };
    this.bodiesGone.clear();
    this.colsGone.clear();
    const B = snap.bodies;
    const readBody = (h: number) => {
      const b = w.getRigidBody(h);
      if (!b) return;
      const t = b.translation();
      const q = b.rotation();
      B.push(h, b.bodyType(), b.isEnabled() ? 1 : 0, this.bodiesJump.has(h) ? 1 : 0, t.x, t.y, t.z, q.x, q.y, q.z, q.w);
    };
    // 새 몸 먼저 (콜라이더가 부모를 찾는다), 그다음 바뀐 몸·동적 몸
    for (const h of this.bodiesNew) readBody(h);
    for (const h of this.bodiesNow) if (!this.bodiesNew.has(h)) readBody(h);
    for (const h of this.dynamic) if (!this.bodiesNew.has(h) && !this.bodiesNow.has(h)) readBody(h);
    this.bodiesNew.clear();
    this.bodiesNow.clear();
    this.bodiesJump.clear();
    const C = snap.colliders;
    const readCol = (h: number, shape: RAPIER.Shape | null | undefined) => {
      const c = w.getCollider(h);
      if (!c) return;
      const p = c.parent();
      if (shape !== undefined) snap.shapes.push([h, shapeData(shape ?? c.shape)]);
      const t = p ? c.translationWrtParent() : c.translation();
      const q = p ? c.rotationWrtParent() : c.rotation();
      if (!t || !q) return;
      C.push(h, p ? p.handle : -1, c.isEnabled() ? 1 : 0, c.isSensor() ? 1 : 0, c.collisionGroups(), this.clsOf(c), c.density(), t.x, t.y, t.z, q.x, q.y, q.z, q.w);
    };
    for (const [h, shape] of this.colsNew) readCol(h, shape);
    for (const h of this.colsDirty) if (!this.colsNew.has(h)) readCol(h, this.shapesDirty.has(h) ? null : undefined);
    this.colsNew.clear();
    this.colsDirty.clear();
    this.shapesDirty.clear();
    return snap;
  }
}
