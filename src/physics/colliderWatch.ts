import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Change stamps for Rapier colliders and bodies, so that values read from Wasm can be cached until something changes them.
 *
 * Every collider setter (pose, shape, enabled, sensor, groups) and every body setter that a collider's state depends on
 * (translation, rotation, enabled, body type) gives the object a new stamp from one global counter. stampOf(collider) is the
 * newer of the collider's and its parent body's stamps: 0 means never changed since the hooks were installed. The flag caches
 * below use a second stamp that only enabled, sensor, groups and body type setters move (a hitbox moving every step does
 * not make its isSensor stale).
 *  - setTranslationWrtParent / setRotationWrtParent with the same value as the last call (e.g. code that re-writes the
 *    colliders of a rotating part every step) do not change the stamp. Any other setter on that collider forgets the last values.
 *  - Some setters reach what Rapier reports only at the next world.step or propagateModifiedBodyPositionsToColliders (a
 *    body's setEnabled reaches its colliders' isEnabled(); a body pose or a wrt-parent pose reaches the colliders' world
 *    pose): every changed object gets a new stamp again right after that call too.
 * A dynamic or kinematic body's pose also changes in world.step without any setter: callers that depend on it must compare
 * the pose themselves. Removed colliders are not tracked (callers check that the collider is still in the world).
 */

let seq = 0;
/** any change (pose, shape, flags) */
const stamps = new WeakMap<object, number>();
/** changes that can change isSensor / isEnabled / isFixed (enabled, sensor, groups, body enabled, body type) */
const flagStamps = new WeakMap<object, number>();
const lastT = new WeakMap<object, [number, number, number]>();
const lastR = new WeakMap<object, [number, number, number, number]>();
/** colliders and bodies changed since the last world.step / propagateModifiedBodyPositionsToColliders (true: a flag change) */
const pending = new Map<object, boolean>();
let installed = false;

type AnyFn = (...a: unknown[]) => unknown;

function bump(o: object, flag: boolean): void {
  stamps.set(o, ++seq);
  if (flag) flagStamps.set(o, seq);
  if (flag || !pending.has(o)) pending.set(o, flag || !!pending.get(o));
}

function wrap(proto: object, name: string, before: (self: object, a: unknown[]) => void): void {
  const p = proto as Record<string, AnyFn>;
  const orig = p[name];
  if (typeof orig !== 'function') return;
  p[name] = function (this: object, ...a: unknown[]) {
    before(this, a);
    return orig.apply(this, a);
  };
}

function install(): void {
  if (installed) return;
  installed = true;
  const C = RAPIER.Collider.prototype;
  const setter = (flag: boolean) => (self: object) => {
    lastT.delete(self);
    lastR.delete(self);
    bump(self, flag);
  };
  for (const n of ['setTranslation', 'setRotation', 'setShape', 'setHalfExtents', 'setRadius', 'setHalfHeight', 'setRoundRadius', 'setContactSkin']) wrap(C, n, setter(false));
  for (const n of ['setEnabled', 'setSensor', 'setCollisionGroups']) wrap(C, n, setter(true));
  wrap(C, 'setTranslationWrtParent', (self, a) => {
    const v = a[0] as { x: number; y: number; z: number };
    const l = lastT.get(self);
    if (l && l[0] === v.x && l[1] === v.y && l[2] === v.z) return;
    lastT.set(self, [v.x, v.y, v.z]);
    bump(self, false);
  });
  wrap(C, 'setRotationWrtParent', (self, a) => {
    const v = a[0] as { x: number; y: number; z: number; w: number };
    const l = lastR.get(self);
    if (l && l[0] === v.x && l[1] === v.y && l[2] === v.z && l[3] === v.w) return;
    lastR.set(self, [v.x, v.y, v.z, v.w]);
    bump(self, false);
  });
  const B = RAPIER.RigidBody.prototype;
  for (const n of ['setTranslation', 'setRotation']) wrap(B, n, (self) => bump(self, false));
  for (const n of ['setBodyType', 'setEnabled']) wrap(B, n, (self) => bump(self, true));
  const W = RAPIER.World.prototype as unknown as Record<string, AnyFn>;
  for (const n of ['step', 'propagateModifiedBodyPositionsToColliders']) {
    const orig = W[n];
    W[n] = function (this: object, ...a: unknown[]) {
      const out = orig.apply(this, a);
      if (pending.size) {
        const list = [...pending];
        pending.clear();
        for (const [o, flag] of list) {
          stamps.set(o, ++seq);
          if (flag) flagStamps.set(o, seq);
        }
      }
      return out;
    };
  }
}

/** change stamp of a collider (or its parent body): equal stamps mean no setter touched it in between */
export function stampOf(c: RAPIER.Collider): number {
  install();
  const s = stamps.get(c) ?? 0;
  const b = c.parent();
  return b ? Math.max(s, stamps.get(b) ?? 0) : s;
}

/** like stampOf, but only for changes that can change isSensor, isEnabled or the parent's isFixed */
function flagStampOf(c: RAPIER.Collider): number {
  install();
  const s = flagStamps.get(c) ?? 0;
  const b = c.parent();
  return b ? Math.max(s, flagStamps.get(b) ?? 0) : s;
}

function bodyFlagStampOf(b: RAPIER.RigidBody): number {
  install();
  return flagStamps.get(b) ?? 0;
}

interface Flags {
  stamp: number;
  sensor: boolean;
  enabled: boolean;
}
const flags = new WeakMap<object, Flags>();

function flagsOf(c: RAPIER.Collider): Flags {
  const st = flagStampOf(c);
  let f = flags.get(c);
  if (!f || f.stamp !== st) {
    f = { stamp: st, sensor: c.isSensor(), enabled: c.isEnabled() };
    flags.set(c, f);
  }
  return f;
}

/** collider.isSensor() without asking Wasm again until the collider changes */
export function isSensorCached(c: RAPIER.Collider): boolean {
  return flagsOf(c).sensor;
}

/** collider.isEnabled() without asking Wasm again until the collider or its body changes */
export function isEnabledCached(c: RAPIER.Collider): boolean {
  return flagsOf(c).enabled;
}

const fixed = new WeakMap<object, { stamp: number; fixed: boolean }>();

/** body.isFixed() without asking Wasm again until the body changes type */
export function isFixedCached(b: RAPIER.RigidBody): boolean {
  const st = bodyFlagStampOf(b);
  let f = fixed.get(b);
  if (!f || f.stamp !== st) {
    f = { stamp: st, fixed: b.isFixed() };
    fixed.set(b, f);
  }
  return f.fixed;
}
