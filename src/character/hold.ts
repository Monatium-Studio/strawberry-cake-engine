import * as THREE from 'three';

/**
 * 캐릭터가 손에 든 소품과 팔 IK.
 *   - 소품은 손 소켓(socket_hand_R / socket_hand_L)에 붙는다. 소켓 축: -Z 손가락, +Y 엄지. 소품 glb의 원점(파지점)이
 *     그대로 소켓에 온다. grip 노드가 있는 소품은 grip이 소켓에 온다.
 *   - 자세가 그 손의 '쥔 자리'(_holdR / _holdL)를 정하면 팔을 IK로 그 자리에 맞춘다 (발밑 기준 캐릭터 공간).
 *   - 두 손 소품(grip_support가 있는 소품: 긴 막대, 상자 등)은 빈 왼손을 grip_support에 IK로 맞춘다.
 *   - 내려놓기(drop): 소품을 손에서 떼어 월드에 두고, 손 자리 → 목표 자리로 부드럽게 옮긴다. 손은 닿을 때까지 소품을 따라가고
 *     닿은 뒤 놓는다(무게를 줄인다).
 */
export type HandSlot = 'R' | 'L';

export interface ArmChain {
  /** 어깨 (닿지 않을 때 팔 뿌리를 목표 쪽으로 조금 내민다) */
  shoulder?: THREE.Object3D;
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
  socket: THREE.Object3D;
}

export interface HoldOptions {
  /** 소품 안에서 손이 쥐는 점 (소품 지역 좌표). 없으면 grip 노드, 그것도 없으면 원점 */
  grip?: THREE.Vector3;
  /** 소켓 안에서 소품을 돌리는 각 (도, XYZ) */
  rot?: THREE.Euler;
  /** 두 손 소품의 받침손 (grip_support). 기본: 소품에 grip_support가 있으면 */
  support?: boolean;
  /** 받침손(왼손 소켓) 방향: 소품 공간 회전. 기본 SUPPORT_ROT_L (긴 소품 아래를 받침: 손바닥이 위). 상자 옆면은 단위 회전 */
  supportRot?: THREE.Quaternion;
}

export interface DropOptions {
  /** 손 자리 → 목표까지 걸리는 시간 (초) */
  duration?: number;
  /** 닿은 뒤 손을 떼는 시간 (초) */
  release?: number;
  /** 닿는 순간 (소리) */
  onLand?: (pos: THREE.Vector3) => void;
}

export interface Held {
  slot: HandSlot;
  /** 소켓에 붙는 묶음 (원점 = 쥐는 점). 내려놓을 때 이 묶음이 월드로 간다 */
  wrapper: THREE.Object3D;
  /** 소품 glb 루트 */
  model: THREE.Object3D;
  /** 받침손 자리 (grip_support) */
  support: THREE.Object3D | null;
  /** 받침손 방향 (소품 공간) */
  supportRot: THREE.Quaternion;
  state: 'held' | 'dropping' | 'released';
  /** 내려놓기 진행 */
  t: number;
  dur: number;
  release: number;
  /** 손 무게 (닿은 뒤 0으로) */
  hand: number;
  /** 내려놓을 월드 자리·회전 */
  readonly target: { pos: THREE.Vector3; quat: THREE.Quaternion };
  /** 바닥에 닿는 순간 (효과음) */
  onLand?: (pos: THREE.Vector3) => void;
  resolve?: () => void;
}

/** 소품을 묶음으로 싸서 쥐는 점을 원점으로 */
export function wrapProp(slot: HandSlot, model: THREE.Object3D, opts: HoldOptions = {}): Held {
  const wrapper = new THREE.Group();
  wrapper.name = `held_${slot}_${model.name || 'prop'}`;
  model.position.set(0, 0, 0);
  model.quaternion.identity();
  model.scale.setScalar(1);
  if (opts.rot) model.quaternion.setFromEuler(opts.rot);
  model.updateMatrixWorld(true);
  let grip = opts.grip?.clone() ?? null;
  if (!grip) {
    const g = model.getObjectByName('grip');
    if (g) {
      // 모델 공간 위치 (모델 회전 전)
      model.quaternion.identity();
      model.updateMatrixWorld(true);
      grip = model.worldToLocal(g.getWorldPosition(new THREE.Vector3()));
      if (opts.rot) model.quaternion.setFromEuler(opts.rot);
    }
  }
  if (grip) model.position.copy(grip.applyQuaternion(model.quaternion)).negate();
  wrapper.add(model);
  const supportNode = opts.support === false ? null : (model.getObjectByName('grip_support') ?? null);
  return {
    slot,
    wrapper,
    model,
    support: supportNode,
    supportRot: opts.supportRot?.clone() ?? SUPPORT_ROT_L.clone(),
    state: 'held',
    t: 0,
    dur: 0.5,
    release: 0.3,
    hand: 1,
    target: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
  };
}

/**
 * 쥔 자리 회전: [아래로 숙임, 왼쪽으로 돌림, 굴림] (도). 0이면 소품의 앞이 캐릭터 정면, 엄지(+Y)가 위.
 * 소품 앞은 -Z라 캐릭터 정면(+Z)을 보도록 Y로 180° 돌린 것이 기준이다.
 */
export function holdQuat(rot: [number, number, number] | undefined, out = new THREE.Quaternion()): THREE.Quaternion {
  const d = Math.PI / 180;
  const r = rot ?? [0, 0, 0];
  out.setFromEuler(_e.set(r[0] * d, r[1] * d, r[2] * d, 'YXZ'));
  return out.multiply(FLIP);
}
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const _e = new THREE.Euler();

/** 받침손(왼손)이 두 손 소품의 받침 자리를 쥐는 방향: 손바닥(+X)이 위, 엄지(+Y)가 소품 앞쪽, 손가락이 오른쪽으로 감싼다 */
export const SUPPORT_ROT_L = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0.35, 0.94, 0).normalize(),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0.35, 0.94, 0).normalize().cross(new THREE.Vector3(0, 0, -1)),
  ),
);

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();

const _dp = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _ds = new THREE.Vector3();

/*
 * 월드 위치·회전·크기를 matrixWorld에서 바로 읽는다 (getWorldPosition 등과 같은 값).
 * getWorld*는 부를 때마다 부모 사슬을 루트까지 다시 계산한다(팔 IK 한 번에 수십 번: 캐릭터가 많으면 프레임의 몇 %).
 * solveArm은 들어올 때 팔 사슬의 matrixWorld가 최신이고(Character.updateHands가 맞춘다), 본을 돌릴 때마다 그 아래를 다시 계산하므로 늘 최신이다.
 */
function wPos(o: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  return out.setFromMatrixPosition(o.matrixWorld);
}
function wQuat(o: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  o.matrixWorld.decompose(_dp, out, _ds);
  return out;
}
function wScale(o: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  o.matrixWorld.decompose(_dp, _dq, out);
  return out;
}

/** 본의 월드 회전을 delta만큼 돌린다 */
function rotateWorld(bone: THREE.Object3D, delta: THREE.Quaternion): void {
  const qw = wQuat(bone, _q1);
  const qp = bone.parent ? wQuat(bone.parent, _q2).invert() : _q2.identity();
  bone.quaternion.copy(qp.multiply(delta.multiply(qw)));
  bone.updateMatrixWorld(true);
}

/**
 * 두 관절 팔 IK: 손 소켓이 goalPos(월드)에 오도록 위팔·아래팔을 돌린다. goalQuat가 있으면 손(소켓) 회전도 맞춘다(orient 비율).
 * pole: 팔꿈치가 향할 월드 방향. weight: 원래(FK) 자세와 섞는 비율. 닿지 않으면 팔을 쭉 뻗어 목표 쪽을 가리킨다.
 * 부르기 전에 팔 사슬(어깨·위팔부터 손 소켓까지)의 matrixWorld가 최신이어야 한다 (Character.updateHands). 끝나면 팔 아래가 최신이다.
 */
export function solveArm(ch: ArmChain, goalPos: THREE.Vector3, goalQuat: THREE.Quaternion | null, pole: THREE.Vector3, weight: number, orient = 1): void {
  if (weight <= 0.001) return;
  const { upper, lower, hand, socket, shoulder } = ch;
  const q0s = shoulder?.quaternion.clone();
  const q0u = upper.quaternion.clone();
  const q0l = lower.quaternion.clone();
  const q0h = hand.quaternion.clone();
  const sockInv = socket.quaternion.clone().invert();
  const qHgoal = goalQuat ? goalQuat.clone().multiply(sockInv) : null;
  const sockOff = socket.position.clone().multiply(wScale(hand, _v1));
  // 손 회전을 예상해서 손목 목표를 잡는다 (방향을 다 맞추지 않으면 한 번 더)
  const passes = qHgoal && orient >= 0.999 ? 1 : 2;
  for (let pass = 0; pass < passes; pass++) {
    const qH = wQuat(hand, new THREE.Quaternion());
    if (qHgoal) qH.slerp(qHgoal, orient);
    const W = goalPos.clone().sub(sockOff.clone().applyQuaternion(qH));
    if (pass === 0 && shoulder) reachShoulder(shoulder, upper, lower, hand, W);
    const A = wPos(upper, new THREE.Vector3());
    const B = wPos(lower, new THREE.Vector3());
    const C = wPos(hand, new THREE.Vector3());
    const a = A.distanceTo(B);
    const b = B.distanceTo(C);
    const AW = W.clone().sub(A);
    let d = AW.length();
    if (a < 1e-5 || b < 1e-5 || d < 1e-5) return;
    const n = AW.divideScalar(d);
    d = THREE.MathUtils.clamp(d, Math.abs(a - b) + 1e-4, a + b - 1e-4);
    const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const p = pole.clone().addScaledVector(n, -pole.dot(n));
    if (p.lengthSq() < 1e-8) p.copy(B).sub(A).addScaledVector(n, -B.clone().sub(A).dot(n));
    p.normalize();
    const E = A.clone().addScaledVector(n, a * cosA).addScaledVector(p, a * sinA);
    const Wc = A.clone().addScaledVector(n, d);
    rotateWorld(upper, _q3.setFromUnitVectors(B.clone().sub(A).normalize(), E.sub(A).normalize()));
    const B2 = wPos(lower, _v2);
    const C2 = wPos(hand, _v3);
    rotateWorld(lower, _q3.setFromUnitVectors(C2.sub(B2).normalize(), Wc.sub(B2).normalize()));
  }
  if (qHgoal) {
    const now = wQuat(hand, new THREE.Quaternion());
    now.slerp(qHgoal, orient);
    const qp = wQuat(hand.parent!, new THREE.Quaternion()).invert();
    hand.quaternion.copy(qp.multiply(now));
  }
  if (weight < 0.999) {
    if (shoulder && q0s) shoulder.quaternion.copy(q0s.slerp(shoulder.quaternion, weight));
    upper.quaternion.copy(q0u.slerp(upper.quaternion, weight));
    lower.quaternion.copy(q0l.slerp(lower.quaternion, weight));
    hand.quaternion.copy(q0h.slerp(hand.quaternion, weight));
  }
  (shoulder ?? upper).updateMatrixWorld(true);
}

/** 어깨를 앞으로 내미는 최대 각 (팔이 짧은 체형은 무릎 꿇고 바닥에 손이 겨우 닿는다) */
const SHOULDER_MAX = (38 * Math.PI) / 180;

/** 손목 목표가 팔 길이 밖이면 어깨를 그쪽으로 돌려 팔 뿌리를 내민다 (최대 SHOULDER_MAX, 모자란 만큼만) */
function reachShoulder(shoulder: THREE.Object3D, upper: THREE.Object3D, lower: THREE.Object3D, hand: THREE.Object3D, W: THREE.Vector3): void {
  const S = wPos(shoulder, new THREE.Vector3());
  const A = wPos(upper, new THREE.Vector3());
  const reach = (A.distanceTo(wPos(lower, _v2)) + wPos(lower, _v2).distanceTo(wPos(hand, _v3))) * 0.98;
  if (A.distanceTo(W) <= reach) return;
  const sa = A.clone().sub(S);
  const sw = W.clone().sub(S);
  const full = sa.angleTo(sw);
  if (full < 1e-4) return;
  const axis = new THREE.Vector3().crossVectors(sa, sw).normalize();
  const maxA = Math.min(full, SHOULDER_MAX);
  // 모자란 만큼만 (이분 탐색)
  let lo = 0;
  let hi = 1;
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    p.copy(sa).applyQuaternion(q.setFromAxisAngle(axis, maxA * mid)).add(S);
    if (p.distanceTo(W) > reach) lo = mid;
    else hi = mid;
  }
  rotateWorld(shoulder, q.setFromAxisAngle(axis, maxA * hi));
}

/** 0→1 부드럽게 (양 끝 기울기 0) */
export function smoother(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}
