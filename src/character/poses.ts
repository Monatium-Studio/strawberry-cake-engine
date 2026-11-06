/**
 * 캐릭터 자세와 제스처 (본 회전 키프레임). 회전은 레스트 포즈 위에 더하는 본 로컬 오일러(도, XYZ).
 *
 * 기본 리그 규약 (휴머노이드, 이 표의 값이 맞는 리그):
 *   - 본 이름: hips, spine, chest, neck, head, shoulder_L/R, upperarm_L/R, forearm_L/R, hand_L/R,
 *     손가락 thumb_01/02_L/R, f1_01/02 (검지), f2_01/02 (중지), f3_01/02 (약지·새끼), thigh_L/R, shin_L/R, foot_L/R,
 *     장식 ear_L/R, hair_tail_01/02 (없으면 건너뛴다). 소켓: socket_hand_L/R, socket_eye
 *   - 레스트는 A 포즈 (위팔이 수평 아래 40°), 캐릭터는 +Z를 본다 (+X = 캐릭터 왼쪽)
 *   - 축: +X 숙임·굽힘·앞으로 들기, head +Y 왼쪽으로 돌림, upperarm_L +Z / upperarm_R -Z 옆으로 들기, shin -X 무릎 굽힘, 손가락 +X 말기
 *
 * 다른 리그는 자기 표를 registerPoses / registerGestures / registerPoseOsc로 더하거나 덮어쓰고,
 * 본 이름이 다르면 registerControlledBones로 Character가 다룰 본을 알린다. 아래 기본 표는 예제다.
 */
import * as THREE from 'three';

export type Euler3 = [number, number, number];
export type Pose = Record<string, Euler3>;

/** 손가락 말기: 0 = 폄, 1 = 주먹 */
export function fingers(side: 'L' | 'R', curl: number, opts: { index?: number; thumb?: number } = {}): Pose {
  const p: Pose = {};
  const ix = opts.index ?? curl;
  p[`f1_01_${side}`] = [70 * ix, 0, 0];
  p[`f1_02_${side}`] = [80 * ix, 0, 0];
  for (const f of ['f2', 'f3']) {
    p[`${f}_01_${side}`] = [70 * curl, 0, 0];
    p[`${f}_02_${side}`] = [80 * curl, 0, 0];
  }
  const th = opts.thumb ?? curl;
  p[`thumb_01_${side}`] = [25 * th, 0, 0];
  p[`thumb_02_${side}`] = [40 * th, 0, 0];
  return p;
}

/** 자세 여럿을 합친다 (뒤의 것이 이긴다) */
export const mergePoses = (...ps: Pose[]): Pose => Object.assign({}, ...ps);
const merge = mergePoses;

/** 왼쪽 본 → 오른쪽 본 (Y·Z 회전 부호 반전) */
export function mirrorPose(p: Pose): Pose {
  const out: Pose = {};
  for (const [k, [x, y, z]] of Object.entries(p)) {
    if (k.endsWith('_L')) out[`${k.slice(0, -2)}_R`] = [x, -y, -z];
  }
  return out;
}

/**
 * 팔 방향으로 자세 만들기 (캐릭터 공간: +X 캐릭터 왼쪽, +Y 위, +Z 앞).
 * dir: 위팔이 향할 방향, bend: 아래팔이 접힐 쪽(팔꿈치 굽힘 면), elbow: 팔꿈치 굽힘(도), hand: 손목(+ 손바닥 쪽)
 * 레스트 A 포즈의 위팔 축(수평 아래 40°, 본 +Z = 앞)에서 목표 축으로 가는 본 로컬 회전을 오일러로 바꾼다.
 */
const REST_ARM = {
  L: new THREE.Matrix4().makeBasis(new THREE.Vector3(-0.64, -0.769, 0), new THREE.Vector3(0.769, -0.64, 0), new THREE.Vector3(0, 0, 1)),
  R: new THREE.Matrix4().makeBasis(new THREE.Vector3(-0.64, 0.769, 0), new THREE.Vector3(-0.769, -0.64, 0), new THREE.Vector3(0, 0, 1)),
};
export function arm(side: 'L' | 'R', dir: [number, number, number], bend: [number, number, number] = [0, 0, 1], elbow = 0, hand = 0, twistHand = 0): Pose {
  const y = new THREE.Vector3(...dir).normalize();
  let z = new THREE.Vector3(...bend);
  z.addScaledVector(y, -z.dot(y));
  if (z.lengthSq() < 1e-6) z = new THREE.Vector3(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  const target = new THREE.Matrix4().makeBasis(x, y, z);
  const q = new THREE.Matrix4().copy(REST_ARM[side]).transpose().multiply(target);
  const e = new THREE.Euler().setFromRotationMatrix(q, 'XYZ');
  const d = (r: number) => Math.round(((r * 180) / Math.PI) * 10) / 10;
  return { [`upperarm_${side}`]: [d(e.x), d(e.y), d(e.z)], [`forearm_${side}`]: [elbow, 0, 0], [`hand_${side}`]: [hand, twistHand, 0] };
}
/** 두 팔 대칭 (dir·bend는 왼팔 기준, 오른팔은 X를 뒤집는다) */
export const arms = (dir: [number, number, number], bend: [number, number, number], elbow: number, hand = 0): Pose =>
  merge(arm('L', dir, bend, elbow, hand), arm('R', [-dir[0], dir[1], dir[2]], [-bend[0], bend[1], bend[2]], elbow, hand));

const armsDownL: Pose = { upperarm_L: [4, 0, -34], forearm_L: [14, 0, 0], hand_L: [6, 0, 0] };
const relaxed = merge(armsDownL, mirrorPose(armsDownL), fingers('L', 0.3), fingers('R', 0.3));
const loose = merge(fingers('L', 0.3), fingers('R', 0.3));
const open = merge(fingers('L', 0.05), fingers('R', 0.05));
const fist = merge(fingers('L', 0.8), fingers('R', 0.8));
const pointR = fingers('R', 0.9, { index: 0, thumb: 0.6 });
/** 의자·벤치에 앉음 (seatZ가 있으면 그 위) */
const seated = (hip = 0.3): Pose => ({ _hipY: [hip, 0, 0], _seat: [0.07, 0, 0], thigh_L: [88, 0, 5], shin_L: [-84, 0, 0], foot_L: [8, 0, 0], thigh_R: [88, 0, -5], shin_R: [-84, 0, 0], foot_R: [8, 0, 0] });
/** 달리는 중간 (오른발 앞, 뒷발 굽힘) */
const strideRun: Pose = { thigh_R: [46, 0, 0], shin_R: [-38, 0, 0], foot_R: [6, 0, 0], thigh_L: [-26, 0, 0], shin_L: [-72, 0, 0], foot_L: [-14, 0, 0] };
const crossed = merge(
  arm('L', [0.42, -0.72, 0.55], [-1, 0.12, 0.25], 118, 6),
  arm('R', [-0.45, -0.66, 0.6], [1, 0.3, 0.3], 112, 6),
  merge(fingers('L', 0.5), fingers('R', 0.5)),
);
const onHips = merge(arm('L', [0.82, -0.42, -0.3], [-0.6, -0.5, 0.4], 96, -20), arm('R', [-0.82, -0.42, -0.3], [0.6, -0.5, 0.4], 96, -20), merge(fingers('L', 0.2), fingers('R', 0.2)));

/**
 * 특수 키
 *   `_hipY`: [엉덩이 높이(m), 0, 0]. 앉는 자세처럼 몸 전체를 내린다 (레스트 엉덩이 높이와의 차이만큼). 0.35 m 넘는 선 자세는
 *     _hipY 대신 낮은 발바닥을 땅에 둔다 (Character '발바닥 붙이기')
 *   `_seat`: [앉을 자리(seatZ) 위 엉덩이 높이 m]
 *   `_root`: [몸 전체 회전 도] (눕기·엎드리기·공중), `_rootPos`: [몸 전체 이동 m]
 *   `_holdR` / `_holdL`: [x, y, z] 손에 든 소품의 쥐는 점을 둘 자리. 발밑 캐릭터 공간(m, +X 캐릭터 왼쪽, +Y 위, +Z 앞).
 *   `_holdRrot` / `_holdLrot`: [아래로 숙임, 왼쪽으로 돌림, 굴림] (도). 0이면 소품 앞이 정면, 엄지(+Y)가 위 (hold.ts holdQuat).
 *     그 손에 소품을 들고 있으면 팔을 IK로 이 자리에 맞춘다 (Character.updateHands). 들고 있지 않으면 무시한다.
 * 기본 치수(이 표의 _hipY 값): 엉덩이 0.35, 무릎 0.19, 발목 0.06, 어깨 0.69, 눈 0.90 m인 작은 체형. 다른 체형은 표를 덮어쓴다.
 */
export const POSES: Record<string, Pose> = {
  /** 레스트 포즈 그대로 (확인용) */
  rest: {},
  /** 팔을 내리고 편히 선 자세 */
  idle: relaxed,
  /** 차렷 */
  attention: merge(
    { upperarm_L: [2, 0, -38], forearm_L: [4, 0, 0], hand_L: [0, 0, 0] },
    mirrorPose({ upperarm_L: [2, 0, -38], forearm_L: [4, 0, 0], hand_L: [0, 0, 0] }),
    fingers('L', 0.55, { thumb: 0.3 }),
    fingers('R', 0.55, { thumb: 0.3 }),
    { chest: [-2, 0, 0], head: [-2, 0, 0] },
  ),
  /** 손을 등 뒤로 모음 */
  hands_behind: merge(
    { upperarm_L: [-22, 18, -30], forearm_L: [38, 0, 0], hand_L: [0, 0, 0] },
    mirrorPose({ upperarm_L: [-22, 18, -30], forearm_L: [38, 0, 0], hand_L: [0, 0, 0] }),
    fingers('L', 0.4),
    fingers('R', 0.4),
    { chest: [-3, 0, 0] },
  ),
  /** 팔짱 */
  cross_arms: merge(crossed, { chest: [-3, 0, 0], head: [-4, 0, 0] }),
  /** 등을 기대고 선 자세 (팔짱) */
  lean: merge(crossed, { spine: [-5, 0, 3], chest: [-5, 0, 0], head: [2, 0, -4], thigh_L: [6, 0, 4], shin_L: [-8, 0, 0], thigh_R: [-4, 0, -2] }),
  /** 허리에 손 */
  hands_hips: merge(onHips, { chest: [-4, 0, 0] }),
  /** 콘솔·책상 조작 (두 손을 앞으로, 고개를 숙임) */
  console: merge(
    { upperarm_L: [46, -12, -18], forearm_L: [52, 0, 0], hand_L: [-24, 0, 0] },
    { upperarm_R: [46, 12, 18], forearm_R: [52, 0, 0], hand_R: [-24, 0, 0] },
    fingers('L', 0.15),
    fingers('R', 0.15),
    { spine: [6, 0, 0], chest: [6, 0, 0], head: [14, 0, 0] },
  ),
  /** 달리기 (팔을 굽힘. 이동 중에는 다리를 걷기 흔들기로 바꾼다) */
  run: merge(
    { upperarm_L: [6, 0, -30], forearm_L: [84, 0, 0], hand_L: [0, 0, 0] },
    { upperarm_R: [6, 0, 30], forearm_R: [84, 0, 0], hand_R: [0, 0, 0] },
    fingers('L', 0.7),
    fingers('R', 0.7),
    { spine: [8, 0, 0], chest: [6, 0, 0], head: [-6, 0, 0] },
    strideRun,
  ),
  /** 벽에 기대 바닥에 앉음 (무릎 세움, 팔은 무릎 위) */
  sit_wall: merge(
    { _hipY: [0.13, 0, 0], hips: [-8, 0, 0], thigh_L: [72, 0, 6], shin_L: [-118, 0, 0], foot_L: [30, 0, 0], thigh_R: [70, 0, -6], shin_R: [-112, 0, 0], foot_R: [28, 0, 0] },
    { upperarm_L: [40, 0, -14], forearm_L: [30, 0, 0], upperarm_R: [40, 0, 14], forearm_R: [30, 0, 0] },
    fingers('L', 0.35),
    fingers('R', 0.35),
    { spine: [8, 0, 0], chest: [4, 0, 0], head: [10, 0, 0] },
  ),
  /** 의자·벤치에 앉음 (seatZ가 있으면 그 위) */
  sit: merge(
    { _hipY: [0.3, 0, 0], _seat: [0.07, 0, 0], thigh_L: [86, 0, 4], shin_L: [-88, 0, 0], thigh_R: [86, 0, -4], shin_R: [-88, 0, 0] },
    { upperarm_L: [24, 0, -26], forearm_L: [40, 0, 0], upperarm_R: [24, 0, 26], forearm_R: [40, 0, 0] },
    fingers('L', 0.35),
    fingers('R', 0.35),
    { spine: [4, 0, 0], head: [6, 0, 0] },
  ),
  /** 지쳐 앉음 (seatZ), 어깨 처짐, 팔은 허벅지 위 */
  sit_tired: merge(
    seated(0.3),
    arms([0.25, -0.75, 0.6], [0, 0, 1], 34, 8),
    loose,
    { shoulder_L: [0, 0, -6], shoulder_R: [0, 0, 6], spine: [12, 0, 0], chest: [10, 0, 0], neck: [4, 0, 0], head: [12, 0, 0] },
  ),
  /** 한쪽 무릎 꿇기 (오른 무릎 땅, 왼발 앞), 손은 허벅지 */
  kneel: merge(
    { _hipY: [0.215, 0, 0], thigh_L: [92, 0, 6], shin_L: [-92, 0, 0], foot_L: [2, 0, 0], thigh_R: [4, 0, -4], shin_R: [-96, 0, 0], foot_R: [-40, 0, 0] },
    arm('L', [0.3, -0.55, 0.78], [0, 0, 1], 30, 10),
    arm('R', [-0.35, -0.85, 0.35], [0, 0, 1], 36, 10),
    loose,
    { spine: [6, 0, 0], chest: [4, 0, 0], head: [10, 0, 0] },
  ),
  /** 누워 잠 (몸 전체를 눕힌다: 머리가 정면 쪽) */
  lie_sleep: merge(
    { _root: [90, 180, 0], _rootPos: [0, 0.1, -0.6] },
    arm('L', [0.35, -0.9, 0.2], [0, 0, 1], 40, 0),
    arm('R', [-0.4, -0.9, -0.05], [0, 0, 1], 10, 0),
    loose,
    { thigh_L: [6, 0, 4], shin_L: [-12, 0, 0], thigh_R: [2, 0, -3], foot_L: [-30, 0, 0], foot_R: [-30, 0, 0], head: [-4, 30, 0] },
  ),
  /** 상자를 두 팔로 안고 섬 (오른손 = 상자 오른쪽 옆면, 왼손은 왼쪽 옆면(grip_support)을 받친다) */
  carry_box: merge(
    { _holdR: [-0.155, 0.45, 0.21], _holdRrot: [0, 0, 0] },
    arms([0.42, -0.45, 0.78], [-1, 0.15, 0.2], 66, 8),
    merge(fingers('L', 0.2), fingers('R', 0.2)),
    { spine: [-4, 0, 0], chest: [-6, 0, 0], head: [6, 0, 0] },
  ),
  /** 고개·상체를 젖혀 하늘을 봄 */
  look_up: merge(relaxed, { spine: [-3, 0, 0], chest: [-6, 0, 0], neck: [-12, 0, 0], head: [-30, 0, 0] }),
  /** 두리번거림 (고개 좌우는 POSE_OSC) */
  look_around: merge(relaxed, { chest: [-2, 0, 0], head: [-6, 0, 0] }),
  /** 먼 곳을 바라봄, 손을 눈썹에 얹음 */
  look_far: merge(relaxed, arm('R', [-0.55, 0.3, 0.78], [0.8, 0.6, 0], 128, -24), fingers('R', 0.05), { chest: [-4, 0, 0], neck: [-4, 0, 0], head: [-12, 0, 0] }),
  /** 먼 곳을 가리킴 */
  point_far: merge(relaxed, arm('R', [-0.22, 0.28, 1], [0, 1, 0], 4, -6), pointR, { chest: [-2, -8, 0], head: [-6, -6, 0] }),
  /** 하늘을 가리킴 */
  point_up: merge(relaxed, arm('R', [-0.5, 0.86, 0.32], [0, 0, 1], 4, -10), pointR, { chest: [-8, 0, 0], neck: [-8, 0, 0], head: [-22, 0, 0] }),
  /** 가슴 앞 박수 (팔은 POSE_OSC) */
  clap: merge(arms([0.38, -0.5, 0.78], [-1, 0.5, 0.3], 82, 0), { hand_L: [0, -30, 0], hand_R: [0, 30, 0] }, open, { head: [-4, 0, 0] }),
  /** 두 팔 번쩍 (환호) */
  cheer: merge(arms([0.78, 0.78, 0.2], [0, 1, 0], 18), fist, { chest: [-6, 0, 0], head: [-14, 0, 0] }),
  /** 한 손 흔들기 (POSE_OSC) */
  wave: merge(relaxed, arm('R', [-0.88, 0.32, 0.2], [0, 1, 0.2], 80, 0), fingers('R', 0.05), { head: [0, -6, 4] }),
  /** 마주 보고 이야기, 한 손 제스처 (POSE_OSC) */
  chat: merge(relaxed, arm('R', [-0.3, -0.85, 0.4], [0.3, 1, 0.4], 82, -10, 30), fingers('R', 0.15), { head: [-2, 0, 4] }),
  /** 배를 잡고 웃음 (POSE_OSC) */
  laugh: merge(arms([0.42, -0.85, 0.3], [-1, 0.2, 0.6], 96, 10), loose, { spine: [12, 0, 0], chest: [4, 0, 0], head: [-18, 0, 6] }),
  /** 몸을 웅크림 (두 팔로 머리를 가림) */
  cower: merge(
    { _hipY: [0.28, 0, 0], thigh_L: [44, 0, 8], shin_L: [-56, 0, 0], foot_L: [12, 0, 0], thigh_R: [40, 0, -8], shin_R: [-52, 0, 0], foot_R: [12, 0, 0] },
    arms([0.4, 0.1, 0.9], [-0.5, 1, 0], 124),
    merge(fingers('L', 0.6), fingers('R', 0.6)),
    { shoulder_L: [0, 0, 8], shoulder_R: [0, 0, -8], spine: [20, 0, 0], chest: [14, 0, 0], head: [6, 0, 0] },
  ),
  /** 두 손으로 입을 가림 */
  cover_mouth: merge(arms([0.32, -0.62, 0.72], [-0.4, 1, 0.2], 132, -20), open, { chest: [-4, 0, 0], neck: [-6, 0, 0], head: [-14, 0, 0] }),
};

/** 자세가 기본 자세인 동안 계속 흔드는 본 (손 흔들기, 박수, 두리번거림). phase는 라디안 */
export interface Osc {
  bone: string;
  axis: 0 | 1 | 2;
  amp: number;
  hz: number;
  phase?: number;
}
export const POSE_OSC: Record<string, Osc[]> = {
  look_around: [{ bone: 'head', axis: 1, amp: 34, hz: 0.28 }, { bone: 'chest', axis: 1, amp: 8, hz: 0.28 }],
  wave: [{ bone: 'forearm_R', axis: 2, amp: 24, hz: 1.8 }, { bone: 'hand_R', axis: 2, amp: 12, hz: 1.8, phase: 0.5 }],
  clap: [
    { bone: 'upperarm_L', axis: 1, amp: 9, hz: 3.0 },
    { bone: 'upperarm_R', axis: 1, amp: -9, hz: 3.0 },
  ],
  cheer: [
    { bone: 'upperarm_L', axis: 2, amp: 8, hz: 1.3 },
    { bone: 'upperarm_R', axis: 2, amp: -8, hz: 1.3, phase: 1.2 },
  ],
  chat: [{ bone: 'forearm_R', axis: 0, amp: 10, hz: 0.9 }, { bone: 'head', axis: 0, amp: 3, hz: 0.7 }],
  laugh: [{ bone: 'chest', axis: 0, amp: 5, hz: 3.2 }, { bone: 'head', axis: 0, amp: 4, hz: 3.2, phase: 0.4 }],
  cower: [{ bone: 'chest', axis: 1, amp: 2, hz: 5 }],
};

/** 제스처: 기본 자세 위에 in → hold → out으로 섞는 본 회전 (osc는 hold 동안 흔드는 본) */
export interface Gesture {
  pose: Pose;
  in: number;
  hold: number;
  out: number;
  osc?: { bone: string; axis: 0 | 1 | 2; amp: number; hz: number }[];
}

export const GESTURES: Record<string, Gesture> = {
  /** 가리키기 (오른팔 앞으로) */
  point: {
    pose: merge({ upperarm_R: [72, 12, 28], forearm_R: [8, 0, 0], hand_R: [-6, 0, 0] }, fingers('R', 0.9, { index: 0, thumb: 0.6 }), { chest: [0, -8, 0] }),
    in: 0.35,
    hold: 1.2,
    out: 0.5,
  },
  /** 손짓 (이리 와) */
  beckon: {
    pose: merge({ upperarm_R: [34, 20, 22], forearm_R: [96, 0, 0], hand_R: [20, 0, 0] }, fingers('R', 0.25, { thumb: 0.2 })),
    in: 0.3,
    hold: 1.2,
    out: 0.4,
    osc: [
      { bone: 'hand_R', axis: 0, amp: 32, hz: 2.4 },
      { bone: 'f1_01_R', axis: 0, amp: 30, hz: 2.4 },
      { bone: 'f2_01_R', axis: 0, amp: 30, hz: 2.4 },
      { bone: 'f3_01_R', axis: 0, amp: 30, hz: 2.4 },
    ],
  },
  /** 팔짱 끼기 (잠깐) */
  cross_arms: { pose: POSES.cross_arms, in: 0.45, hold: 2.0, out: 0.5 },
  /** 고개 끄덕임 */
  nod: { pose: { head: [14, 0, 0], neck: [4, 0, 0] }, in: 0.16, hold: 0.06, out: 0.24 },
  /** 고개 젓기 */
  shake: { pose: {}, in: 0.1, hold: 0.9, out: 0.15, osc: [{ bone: 'head', axis: 1, amp: 14, hz: 2.6 }] },
  /** 어깨 으쓱 */
  shrug: {
    pose: merge(
      { shoulder_L: [0, 0, 10], shoulder_R: [0, 0, -10], upperarm_L: [10, -10, -20], upperarm_R: [10, 10, 20], forearm_L: [50, 0, 0], forearm_R: [50, 0, 0] },
      fingers('L', 0.1),
      fingers('R', 0.1),
      { head: [0, 0, 8] },
    ),
    in: 0.25,
    hold: 0.5,
    out: 0.35,
  },
  /** 박수 */
  clap: {
    pose: merge(
      { upperarm_L: [52, -30, -24], forearm_L: [92, 0, 0], hand_L: [0, -30, 0] },
      { upperarm_R: [52, 30, 24], forearm_R: [92, 0, 0], hand_R: [0, 30, 0] },
      fingers('L', 0.05),
      fingers('R', 0.05),
    ),
    in: 0.25,
    hold: 1.1,
    out: 0.35,
    osc: [
      { bone: 'upperarm_L', axis: 1, amp: 9, hz: 3.2 },
      { bone: 'upperarm_R', axis: 1, amp: -9, hz: 3.2 },
    ],
  },
  /** 손 흔들기 (인사) */
  wave_hand: {
    pose: merge(arm('R', [-0.88, 0.32, 0.2], [0, 1, 0.2], 80, 0), fingers('R', 0.05)),
    in: 0.3,
    hold: 1.6,
    out: 0.45,
    osc: [{ bone: 'forearm_R', axis: 2, amp: 24, hz: 1.8 }],
  },
  /** 손사래: 두 손을 앞으로 내밀어 젓는다 */
  wave_off: {
    pose: merge(arms([0.3, 0.05, 0.95], [0, 1, 0], 70, -20), open, { spine: [-6, 0, 0], chest: [-8, 0, 0], head: [-6, 0, 0] }),
    in: 0.18,
    hold: 1.4,
    out: 0.4,
    osc: [
      { bone: 'forearm_L', axis: 2, amp: 26, hz: 3.4 },
      { bone: 'forearm_R', axis: 2, amp: -26, hz: 3.4 },
    ],
  },
  /** 움찔 (부딪혔을 때 등) */
  flinch: { pose: { chest: [-10, 0, 6], head: [-8, 0, -6], spine: [-4, 0, 0] }, in: 0.06, hold: 0.08, out: 0.4 },
};

/** Character가 다루는 본 (모델에 없는 본은 건너뛴다) */
export const CONTROLLED_BONES: string[] = [
  'hips', 'spine', 'chest', 'neck', 'head', 'ear_L', 'ear_R',
  'shoulder_L', 'upperarm_L', 'forearm_L', 'hand_L', 'thumb_01_L', 'thumb_02_L', 'f1_01_L', 'f1_02_L', 'f2_01_L', 'f2_02_L', 'f3_01_L', 'f3_02_L',
  'shoulder_R', 'upperarm_R', 'forearm_R', 'hand_R', 'thumb_01_R', 'thumb_02_R', 'f1_01_R', 'f1_02_R', 'f2_01_R', 'f2_02_R', 'f3_01_R', 'f3_02_R',
  'thigh_L', 'shin_L', 'foot_L', 'thigh_R', 'shin_R', 'foot_R',
  'hair_tail_01', 'hair_tail_02',
];

/** 자세를 더하거나 덮어쓴다 (게임의 리그·체형에 맞춘 표). 이미 만든 Character에도 다음 setPose부터 들어간다 */
export function registerPoses(poses: Record<string, Pose>): void {
  Object.assign(POSES, poses);
}

/** 제스처를 더하거나 덮어쓴다 */
export function registerGestures(gestures: Record<string, Gesture>): void {
  Object.assign(GESTURES, gestures);
}

/** 자세의 반복 움직임을 더하거나 덮어쓴다 */
export function registerPoseOsc(osc: Record<string, Osc[]>): void {
  Object.assign(POSE_OSC, osc);
}

/** Character가 다룰 본 이름을 더한다 (이후에 만드는 Character부터) */
export function registerControlledBones(names: string[]): void {
  for (const n of names) if (!CONTROLLED_BONES.includes(n)) CONTROLLED_BONES.push(n);
}
