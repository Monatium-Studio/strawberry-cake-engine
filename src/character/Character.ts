import * as THREE from 'three';
import { applyOutlines, toonMaterial } from '../render/toon';
import { cullHiddenMatrices } from '../render/hiddenMatrices';
import { RAPIER, type Physics } from '../physics/Physics';
import { FaceRig } from './face';
import type { GroundProbe } from './ground';
import { holdQuat, solveArm, smoother, wrapProp, type ArmChain, type DropOptions, type HandSlot, type Held, type HoldOptions } from './hold';
import { CONTROLLED_BONES, GESTURES, POSE_OSC, POSES, type Gesture, type Pose } from './poses';

/**
 * 리깅된 캐릭터 컨트롤러 (휴머노이드 glb, 본 규약은 poses.ts).
 * 층: 레스트 포즈 × (기본 자세 ↔ 제스처 섞기) × 절차 움직임(숨쉬기, 시선, 걷기, 말할 때 고개)
 * 얼굴: 표정 전환(교정 키 규칙), 무작위 깜빡임, 말할 때 입 (FaceRig)
 * 이동: 경로점을 따라 미끄러지듯 걷는다 (다리·팔 흔들기, 디딤발 붙이기, 땅 붙이기). 내비 에이전트가 낸 경로를 walk()에 넘기면 된다
 * 다른 몸(카메라 컨트롤러 등)이 지나가지 못하게 키네마틱 캡슐을 갖는다 (collider: false면 없음).
 * 손에 든 소품: hold(slot, 소품) → 손 소켓에 붙고, 자세의 쥔 자리(_holdR/_holdL)와 두 손 소품의 받침손을 팔 IK로 맞춘다.
 * drop(slot, 자리, 회전)은 손에서 떼어 바닥 목표로 옮겨 놓는다 (hold.ts).
 *
 * 모델 glTF extras (리그 루트 등, 커스텀 속성):
 *   charHeight·charRadius  충돌 캡슐 위 끝 높이·반지름 (m). 없으면 CharacterOptions 또는 기본 1.7 / 0.3
 *   holdFwd                쥔 자리를 앞(+Z)으로 더 내미는 거리 (m, 몸이 두꺼운 체형)
 *   steadyArm              "L" | "R" | "LR": 걸을 때 흔들지 않고 손 소켓의 긴 소품을 곧게 세우는 팔
 *   strideScale            걷기 보폭 배율 (긴 옷 등)
 */
export type LookTarget = THREE.Object3D | THREE.Vector3 | (() => THREE.Vector3 | null) | null;

const DEG = Math.PI / 180;
const tmpE = new THREE.Euler();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpQ3 = new THREE.Quaternion();
const noop = (): void => {};
const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
/** 충돌 캡슐 위 끝 (m) 기본값: 모델 extras charHeight도 옵션도 없을 때 */
export const DEFAULT_CHAR_HEIGHT = 1.7;
/** 충돌 캡슐 반지름 (m) 기본값 */
export const DEFAULT_CHAR_RADIUS = 0.3;
/** 충돌 캡슐 아래 끝 (발밑에서 띄움, m) */
const CAPSULE_FOOT = 0.02;
/**
 * 땅 붙이기 (Character.ground): 걷는 동안 이만큼(m) 앞을 표본으로 찍고 그 사이는 직선으로 잇는다 (턱·계단이 떨리지 않고, 질의는 0.25 m에 한 번)
 */
const GROUND_STEP = 0.25;
/** 땅 레이 창: 발(또는 경로 높이) 위 GROUND_UP에서 아래 GROUND_DOWN까지. 하늘이 아니라 발 바로 위에서 쏘아 지붕·위층·탁자를 잡지 않는다 */
const GROUND_UP = 0.75;
const GROUND_DOWN = 1.5;
/** 이보다 가파른 경로 구간(높이/수평)은 사다리·승강으로 보고 경로점 높이를 그대로 따른다 */
const GROUND_STEEP = 1.5;
/**
 * 걸으며 오를 수 있는 높이: 표본 하나에 턱 GROUND_RISE + 표본 거리 × GROUND_SLOPE (0.25 m면 0.35 m: 계단·연석·비탈).
 * 이보다 높은 면(경로가 지나가는 낮은 담·상자 위)에는 올라서지 않고 그 아래 땅을 따른다
 */
const GROUND_RISE = 0.12;
const GROUND_SLOPE = 0.9;
/** 표본이 가까워도(촘촘한 표본·경로점) 단 하나(0.22 m + 여유)는 오른다 */
const GROUND_RISE_MIN = 0.3;
/** place(): 이 안(m)에 딛은 면이 있으면 이미 땅 위에 선 것으로 본다 */
const GROUND_KEEP = 0.15;
/**
 * 계단·턱·비탈: 표본 둘의 높이 차가 GROUND_EDGE를 넘으면 그 표본을 버리고 GROUND_FINE 앞을 다시 찍고, 그 뒤 GROUND_FINE_KEEP
 * 표본 동안 촘촘히 찍는다. 단 하나를 넘는 오르내림이 표본 하나(0.1 m) 안에서 끝나 발 길이 안에 단 모서리가 있을 때만 두 높이
 * 사이에 있다 (예전에는 0.25 m 표본 사이를 곧게 이어 단 위에서 뜨고, 디딤판 0.23 m 계단은 단 둘을 한 직선으로 이어 묻혔다)
 */
const GROUND_EDGE = 0.04;
const GROUND_FINE = 0.1;
const GROUND_FINE_KEEP = 4;

interface BoneSlot {
  bone: THREE.Object3D;
  rest: THREE.Quaternion;
  /** 기본 자세 회전 (자세 전환 중에는 이전 → 새 자세를 섞는다) */
  base: THREE.Quaternion;
  from: THREE.Quaternion;
  to: THREE.Quaternion;
}

function poseQuat(p: Pose | undefined, bone: string, out: THREE.Quaternion): THREE.Quaternion {
  const e = p?.[bone];
  if (!e) return out.identity();
  return out.setFromEuler(tmpE.set(e[0] * DEG, e[1] * DEG, e[2] * DEG, 'XYZ'));
}

const LEG_BONES = new Set(['thigh_L', 'shin_L', 'foot_L', 'thigh_R', 'shin_R', 'foot_R']);

export interface CharacterOptions {
  /** 표시 이름 (자막 화자 등) */
  name?: string;
  /** 처음 자세 (POSES 이름) */
  pose?: string;
  /** false면 충돌 캡슐을 만들지 않는다 */
  collider?: boolean;
  /** 충돌 캡슐 위 끝 높이·반지름 (m). 모델 extras charHeight·charRadius가 우선 */
  height?: number;
  radius?: number;
}

export class Character {
  /**
   * 발이 땅에 닿을 때 (걷기 위상이 π/2 + kπ를 지날 때, 다리가 가장 벌어지고 몸이 가장 낮다). 발소리(audio/footsteps.ts)가 건다.
   * 여럿이 들으려면 Character.stepListeners에 더한다
   */
  static onStep: ((ch: Character) => void) | null = null;
  /** 발 디딤을 듣는 것 (onStep 말고 더) */
  static readonly stepListeners = new Set<(ch: Character) => void>();
  readonly root = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly face: FaceRig;
  readonly bones = new Map<string, BoneSlot>();
  /** 게임이 붙이는 자유 데이터 (진영, 역할 등) */
  readonly data: Record<string, unknown> = {};
  /** 표시 이름 (자막 화자 등) */
  name: string;
  poseName = 'idle';
  look: LookTarget = null;
  /** 시선 추적 최대 각 */
  lookLimit = { yaw: 75 * DEG, up: 25 * DEG, down: 30 * DEG };
  talking = false;
  /** 다른 몸이 겹쳐 지나가도 되는가 (게임의 캐릭터 컨트롤러 필터가 읽는다) */
  passable = true;
  readonly body: RAPIER.RigidBody | null = null;
  readonly collider: RAPIER.Collider | null = null;

  private poseT = 1;
  private poseDur = 0.4;
  private gesture: { g: Gesture; t: number; resolve: () => void } | null = null;
  private time = Math.random() * 10;
  private blinkTimer = 1 + Math.random() * 3;
  private blinkT = -1;
  private doubleBlink = false;
  private earTimer = 3 + Math.random() * 6;
  private earT = -1;
  private lookYaw = 0;
  private lookPitch = 0;
  private talkPhase = 0;
  private talkEnv = 0;
  private path: THREE.Vector3[] = [];
  private moveResolve: (() => void) | null = null;
  /**
   * 땅 높이 질의 (character/ground.ts). 있으면 걷는 동안과 place()(서 있는 자세일 때) 발을 그 땅에 붙인다. 없으면 경로점 높이.
   * CharacterSet이 레벨마다 켠다 (followGround)
   */
  ground: GroundProbe | null = null;
  /** 땅에 붙일 때 root의 부모 (월드 좌표 묶음 = 레벨 dynamic). 다른 부모(움직이는 탈것·수레)에 붙어 있으면 붙이지 않는다 */
  groundSpace: THREE.Object3D | null = null;
  /** 지금 걷는 경로 구간: 목표·출발점·수평 길이 (참조 높이 = 경로점 높이를 수평 진행으로 보간) */
  private segTarget: THREE.Vector3 | null = null;
  private readonly segFrom = new THREE.Vector3();
  private segLen = 0;
  /** 사다리처럼 가파른 구간 (경로점 높이를 따른다) */
  private segSteep = false;
  /** 땅 표본 구간 A → B (수평 GROUND_STEP m 앞). 발 높이는 그 사이 직선 */
  private gAx = 0;
  private gAz = 0;
  private gAy = 0;
  private gBx = 0;
  private gBz = 0;
  private gBy = 0;
  /** 촘촘히(GROUND_FINE) 찍을 남은 표본 수 (높이가 바뀌는 곳: 계단·턱·비탈) */
  private gFine = 0;
  /** 걷기 위상 (라디안). 게임이 여럿의 위상을 맞춰 발을 맞출 수 있다 */
  walkPhase = 0;
  private walkAmt = 0;
  private turnTarget: number | null = null;
  private turnResolve: (() => void) | null = null;
  walkSpeed = 1.25;
  private readonly headLocal = new THREE.Vector3(0, 0.82, 0.04);
  /** 레스트 엉덩이 높이 (앉는 자세의 기준) */
  private restHipY = 0.45;
  /**
   * 걷는 동안 디딤발 붙이기: 모델 아래에서 발목 본까지의 사슬 (왼발·오른발)과 선 자세의 발목 높이 (모델 공간).
   * 걷기 흔들기로 다리가 앞뒤로 벌어지면 엉덩이를 그만큼 내려 낮은 발(디딤발)을 땅에 둔다. 몸을 |cos|로 올리기만 하면
   * 다리가 모일 때(한 발로 설 때) 두 발이 다 떠서 달리는 인물이 땅에서 몇 cm 떠 보였다
   */
  private footChains: THREE.Object3D[][] = [];
  /** 발마다 발바닥 점 (발목 본 공간: 앞꿈치·뒤꿈치, 바인드 메시에서) */
  private soles: THREE.Vector3[][] = [];
  private restFootY = 0;
  /**
   * 선 자세의 발바닥 붙이기 무게 (0~1, 자세 전환 때 섞는다): 엉덩이 높이(_hipY)가 0.35 m 넘는 선 자세는
   * _hipY 대신 낮은 발바닥을 땅에 둔다 (자세 표의 _hipY가 모델의 바인드 엉덩이보다 높으면 몇 cm 뜬다).
   * 무릎 꿇기·쪼그리기·앉기·눕기는 _hipY 그대로
   */
  private plantFrom = 0;
  private plantTo = 0;
  private plantNow = 0;
  /** 붙이기가 _hipY에서 바꾼 몸 높이 (m): 쥔 자리(손 IK)도 같이 옮긴다 */
  private plantDelta = 0;
  /**
   * 자세의 쥔 자리(_holdR/_holdL)를 앞(+Z)으로 더 내미는 거리 (m). 모델 glTF extras `holdFwd`(리그 루트)에서 읽고 기본 0.
   * 공용 자세는 평평한 가슴 기준이라, 몸이 두껍거나 옷이 부푼 인물은 소품을 가슴에 붙인 자세에서 아래팔이 몸을 스친다.
   * 그 인물만 쥔 자리를 조금 앞으로 뺀다.
   */
  private holdFwd = 0;
  /**
   * 충돌 캡슐 위 끝 높이·반지름 (m). 모델 glTF extras `charHeight`·`charRadius`(리그 루트)에서 읽고, 없으면 옵션, 그것도 없으면
   * DEFAULT_CHAR_HEIGHT·DEFAULT_CHAR_RADIUS. 가운데 점(centerPoint)·애니메이션 예산의 화면 판정 구도 이 높이를 따른다.
   */
  readonly height: number = DEFAULT_CHAR_HEIGHT;
  readonly radius: number = DEFAULT_CHAR_RADIUS;
  /**
   * 걸을 때 흔들지 않는 팔 (모델 extras `steadyArm`: "L", "R", "LR"). 손 소켓에 박힌 긴 소품(지팡이 등)을 세워 든 팔은
   * 걷기 흔들기를 빼고, 몸 기울기만큼 손목을 돌려 소품을 곧게 세운다.
   */
  private readonly steadyArm: Record<HandSlot, boolean> = { L: false, R: false };
  /** 세워 든 소품 노드 (steadyArm 손 소켓의 자식, 첫 번째) */
  private readonly steadyProp: Partial<Record<HandSlot, THREE.Object3D>> = {};
  /** 걷기 보폭 배율 (모델 extras `strideScale`, 기본 1). 바닥까지 끌리는 옷은 다리를 덜 벌린다 */
  private strideScale = 1;
  /** 자세의 몸 내림 (m): 전환할 때 보간 */
  private hipFrom = 0;
  private hipTo = 0;
  private hipNow = 0;
  /** 앉을 자리 높이 (m, 마커 seatZ). 앉는 자세(_seat 키)는 엉덩이를 이 높이 + _seat에 둔다 */
  seatZ: number | null = null;
  /** 자세의 몸 전체 회전·이동 (_root, _rootPos: 눕기·엎드리기·공중): 전환할 때 보간 */
  private readonly rootFrom = new THREE.Quaternion();
  private readonly rootTo = new THREE.Quaternion();
  private readonly rootNow = new THREE.Quaternion();
  private readonly rootPosFrom = new THREE.Vector3();
  private readonly rootPosTo = new THREE.Vector3();
  private readonly rootPosNow = new THREE.Vector3();
  /** 이동 속도에 따른 다리 흔들기 배율 (달리기) */
  private strideAmp = 1;
  /** 손에 든 소품 */
  private readonly held: Partial<Record<HandSlot, Held>> = {};
  /** 내려놓는 중이거나 막 놓은 소품 (손을 떼는 동안) */
  private readonly drops: Held[] = [];
  /** 팔 사슬 (IK, 처음 쓸 때 찾는다) */
  private chains: Partial<Record<HandSlot, ArmChain>> | null = null;
  /** 자세가 정한 손의 쥔 자리 (발밑 캐릭터 공간). w = 무게 (자세 전환 때 섞는다) */
  private readonly frames: Record<HandSlot, { from: HoldFrame; to: HoldFrame; now: HoldFrame }> = { R: newFrames(), L: newFrames() };
  /** 받침손 무게 (두 손 소품을 들고 있는 동안) */
  supportWeight = 1;
  /** 지금 제스처가 그 팔을 움직이는 비율 (쥔 자리 IK를 그만큼 푼다) */
  private readonly gestureArm: Record<HandSlot, number> = { R: 0, L: 0 };

  constructor(
    readonly id: string,
    model: THREE.Object3D | null,
    private readonly physics: Physics | null,
    opts: CharacterOptions = {},
  ) {
    this.name = opts.name ?? id;
    this.root.name = `char_${id}`;
    // 숨은 캐릭터(아직 나오지 않은 인물·장면 밖 인물)는 렌더 행렬 갱신을 건너뛴다 (render/hiddenMatrices.ts)
    cullHiddenMatrices(this.root);
    this.model = model ?? placeholderCharacter();
    this.root.add(this.model);
    this.face = new FaceRig(this.model);
    for (const name of CONTROLLED_BONES) {
      const bone = this.model.getObjectByName(name);
      if (!bone) continue;
      // 이 본의 회전은 Character가 매 프레임 쿼터니언으로 쓴다: three가 쓸 때마다 rotation 오일러를 다시 계산하지 않게 한다
      // (캐릭터 30명 × 본 45개면 프레임의 3%). bone.rotation은 읽지 않는다 (rotation에 쓰면 그대로 쿼터니언에 반영된다)
      bone.quaternion._onChange(noop);
      this.bones.set(name, {
        bone,
        rest: bone.quaternion.clone(),
        base: new THREE.Quaternion(),
        from: new THREE.Quaternion(),
        to: new THREE.Quaternion(),
      });
    }
    // 머리 위치 (시선 기준점)
    this.model.updateMatrixWorld(true);
    const hips = this.model.getObjectByName('hips');
    if (hips) this.restHipY = this.root.worldToLocal(hips.getWorldPosition(new THREE.Vector3())).y;
    this.findFootChains();
    const eye = this.model.getObjectByName('socket_eye') ?? this.model.getObjectByName('head');
    if (eye) this.headLocal.copy(this.root.worldToLocal(eye.getWorldPosition(new THREE.Vector3())));
    let height = opts.height ?? (model ? DEFAULT_CHAR_HEIGHT : PLACEHOLDER_HEIGHT);
    let radius = opts.radius ?? (model ? DEFAULT_CHAR_RADIUS : 0.2);
    this.model.traverse((o) => {
      const u = o.userData;
      if (!u) return;
      const v = u.holdFwd;
      if (typeof v === 'number' && this.holdFwd === 0) this.holdFwd = v;
      if (typeof u.charHeight === 'number' && u.charHeight > 0.3) height = u.charHeight;
      if (typeof u.charRadius === 'number' && u.charRadius > 0.05) radius = u.charRadius;
      if (typeof u.strideScale === 'number' && u.strideScale > 0) this.strideScale = u.strideScale;
      if (typeof u.steadyArm === 'string') for (const side of ['L', 'R'] as HandSlot[]) if (u.steadyArm.includes(side)) this.steadyArm[side] = true;
    });
    (this as { height: number }).height = height;
    (this as { radius: number }).radius = radius;
    for (const side of ['L', 'R'] as HandSlot[]) {
      const sock = this.steadyArm[side] ? this.model.getObjectByName(`socket_hand_${side}`) : null;
      const prop = sock?.children.find((c) => !(c as THREE.Bone).isBone);
      if (prop) this.steadyProp[side] = prop;
    }
    this.setPose(opts.pose ?? 'idle', 0);
    this.applyPose(1);

    if (physics && opts.collider !== false) {
      const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      // 발밑 2 cm부터 height까지
      const half = Math.max(0.05, (this.height - CAPSULE_FOOT) / 2 - this.radius);
      const col = physics.world.createCollider(
        RAPIER.ColliderDesc.capsule(half, this.radius).setTranslation(0, CAPSULE_FOOT + this.radius + half, 0),
        body,
      );
      physics.setOwner(col, this);
      (this as { body: RAPIER.RigidBody }).body = body;
      (this as { collider: RAPIER.Collider }).collider = col;
    }
  }

  /** 눈 위치 (월드): 카메라·다른 캐릭터가 이 캐릭터를 바라볼 때 */
  eyeWorld(out = new THREE.Vector3()): THREE.Vector3 {
    const eye = this.model.getObjectByName('socket_eye');
    if (eye) return eye.getWorldPosition(out);
    return this.root.localToWorld(out.copy(this.headLocal));
  }

  /** 몸 가운데 점 (월드, 키의 0.53배 높이): 시야·표시 기준점 */
  centerPoint(out = new THREE.Vector3()): THREE.Vector3 {
    return this.root.localToWorld(out.set(0, 0.53 * this.height, 0));
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
    this.collider?.setEnabled(v);
  }

  /**
   * 위치·정면(yaw: 카메라식 규칙, 0이면 -Z를 봄)을 즉시. 땅 붙이기(ground)가 켜져 있고 서 있는 자세면 pos 바로 아래·위 땅에 놓는다
   * (pos.y 위 GROUND_UP ~ 아래 GROUND_DOWN에 땅이 없으면 pos 그대로: 공중에서 떨어지는 인물, 땅 밖 자리)
   */
  place(pos: THREE.Vector3, yaw: number): void {
    this.root.position.copy(pos);
    if (this.onFoot()) {
      const g = this.ground!;
      let gy = g.height(pos.x, pos.z, pos.y + GROUND_UP, pos.y - GROUND_DOWN);
      // 발보다 높은 면이 잡혔어도 발 바로 둘레(±GROUND_KEEP)에 딛은 면이 있으면 그 면: 소품(탁자·상자)과 겹쳐 선 인물을 그 위로 올리지 않는다
      if (gy > pos.y + GROUND_KEEP) {
        const low = g.height(pos.x, pos.z, pos.y + GROUND_KEEP, pos.y - GROUND_KEEP);
        if (low === low) gy = low;
      }
      if (gy === gy) this.root.position.y = gy;
    }
    this.segTarget = null;
    // 모델 정면 +Z → 카메라식 yaw 규칙으로
    this.root.rotation.set(0, yaw + Math.PI, 0);
    this.syncBody();
  }

  /** 땅에 붙일 수 있나: 땅 질의가 있고, 레벨 묶음(월드 좌표)에 붙어 있다 (탈것·수레에 태운 캐릭터는 아니다) */
  private groundActive(): boolean {
    return !!this.ground && !!this.groundSpace && this.root.parent === this.groundSpace;
  }

  /** place()에서 땅에 붙일 자세인가: 앉기(seatZ·_seat)·눕기(_root)는 놓인 자리 그대로 */
  private onFoot(): boolean {
    if (!this.groundActive() || this.seatZ !== null) return false;
    const p = POSES[this.poseName];
    return !p?._seat && !p?._root;
  }

  get yaw(): number {
    return this.root.rotation.y - Math.PI;
  }

  private syncBody(): void {
    if (!this.body) return;
    const p = this.root.position;
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
  }

  // ------------------------------------------------------------------ 자세·제스처

  setPose(name: string, sec = 0.45): void {
    if (!POSES[name]) {
      console.warn(`[character] 자세 없음: ${name}`);
      return;
    }
    const p = POSES[name];
    for (const [bn, s] of this.bones) {
      s.from.copy(s.base);
      poseQuat(p, bn, s.to);
      if (sec <= 0) s.base.copy(s.to);
    }
    this.poseName = name;
    this.hipFrom = this.hipNow;
    this.plantFrom = this.plantNow;
    this.plantTo = p._hipY && p._hipY[0] >= 0.35 && !p._seat && !p._root && !p._rootPos ? 1 : 0;
    if (sec <= 0) this.plantNow = this.plantTo;
    const hip = p._seat && this.seatZ !== null ? this.seatZ + p._seat[0] : p._hipY ? p._hipY[0] : null;
    this.hipTo = hip !== null ? hip - this.restHipY : 0;
    if (sec <= 0) this.hipNow = this.hipTo;
    this.rootFrom.copy(this.rootNow);
    const r = p._root;
    if (r) this.rootTo.setFromEuler(tmpE.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ'));
    else this.rootTo.identity();
    this.rootPosFrom.copy(this.rootPosNow);
    this.rootPosTo.set(...(p._rootPos ?? [0, 0, 0]));
    if (sec <= 0) {
      this.rootNow.copy(this.rootTo);
      this.rootPosNow.copy(this.rootPosTo);
    }
    for (const slot of ['R', 'L'] as HandSlot[]) {
      const f = this.frames[slot];
      copyFrame(f.from, f.now);
      const at = p[`_hold${slot}`];
      if (at) {
        f.to.p.set(at[0], at[1], at[2] + this.holdFwd);
        holdQuat(p[`_hold${slot}rot`], f.to.q);
        f.to.w = 1;
      } else {
        // 쥔 자리가 없는 자세: 자리는 그대로 두고 무게만 뺀다
        f.to.p.copy(f.now.p);
        f.to.q.copy(f.now.q);
        f.to.w = 0;
      }
      if (sec <= 0) copyFrame(f.now, f.to);
    }
    this.poseT = sec <= 0 ? 1 : 0;
    this.poseDur = Math.max(0.01, sec);
  }

  /** 제스처 하나 (끝나면 resolve). 진행 중인 제스처는 끊는다 */
  gestureNow(name: string): Promise<void> {
    const g = GESTURES[name];
    if (!g) {
      console.warn(`[character] 제스처 없음: ${name}`);
      return Promise.resolve();
    }
    this.gesture?.resolve();
    return new Promise((resolve) => (this.gesture = { g, t: 0, resolve }));
  }

  // ------------------------------------------------------------------ 이동

  /** 소품을 소켓(socket_hand_R 등)에 붙인다. 소켓이 없으면 손 본, 그것도 없으면 루트 */
  attach(obj: THREE.Object3D, socket = 'socket_hand_R'): void {
    const s = this.model.getObjectByName(socket) ?? this.model.getObjectByName(socket.replace('socket_', '')) ?? this.root;
    s.add(obj);
  }

  /**
   * 경로를 따라 걷는다(speed가 2 m/s를 넘으면 달리듯 크게 흔든다). 끝나면 resolve.
   * stride: 보폭 배율을 직접 정한다 (기본은 속도에서. 작게 주면 같은 속도에 발을 더 자주 놀리는 종종걸음)
   */
  walk(points: THREE.Vector3[], speed = this.walkSpeed, stride?: number): Promise<void> {
    this.moveResolve?.();
    this.path = points.map((p) => p.clone());
    this.segTarget = null;
    this.walkSpeed = speed;
    // 보폭: 걸음·달리기는 속도에 비례해 1~1.9배. 5 m/s 넘는 질주는 보폭을 더 늘린다(6 m/s에 2.3배): 박자가 지나치게
    // 빨라지지 않게. 발이 미끄러지지 않는 조건(발이 땅을 미는 속도 = 이동 속도)은 박자가 속도/보폭에 비례해 그대로다 (아래 walkPhase)
    this.strideAmp = stride ?? (speed > 5 ? 1.9 + (speed - 5) * 0.4 : THREE.MathUtils.clamp(speed / 1.4, 1, 1.9));
    if (!this.path.length) return Promise.resolve();
    return new Promise((r) => (this.moveResolve = r));
  }

  /** 제자리에서 돌아선다 (yaw: 카메라식 규칙) */
  turnTo(yaw: number): Promise<void> {
    this.turnResolve?.();
    this.turnTarget = yaw;
    return new Promise((r) => (this.turnResolve = r));
  }

  /** 점을 바라보도록 돌아선다 */
  turnToward(p: THREE.Vector3): Promise<void> {
    const d = tmpV.copy(p).sub(this.root.position);
    return this.turnTo(Math.atan2(-d.x, -d.z));
  }

  // ------------------------------------------------------------------ 갱신

  update(dt: number): void {
    this.move(dt);
    this.animate(dt);
  }

  /** 경로 따라 걷기·돌아서기 (자리만: 싸다). 애니메이션 예산이 자세를 미룬 프레임에도 매 프레임 부른다 (CharacterSet) */
  move(dt: number): void {
    this.updateMove(dt);
  }

  /** 얼굴·자세 (본 회전, 팔 IK). dt는 미룬 시간 합이어도 된다 */
  animate(dt: number): void {
    this.time += dt;
    this.updateFace(dt);
    this.applyPose(dt);
  }

  private updateMove(dt: number): void {
    let moving = false;
    if (this.path.length) {
      const target = this.path[0];
      const p = this.root.position;
      // 땅 붙이기: 수평 이동(속도·걸음 박자)은 그대로 두고 높이만 땅에서 (경로점 사이를 곧게 이으면 볼록한 능선을 뚫고 지나간다)
      const ground = this.groundActive();
      if (!ground) this.segTarget = null;
      else if (this.segTarget !== target) this.beginSegment(target);
      const onGround = ground && !this.segSteep;
      tmpV.set(target.x - p.x, 0, target.z - p.z);
      const d = tmpV.length();
      const step = this.walkSpeed * dt;
      if (d <= step) {
        p.x = target.x;
        p.z = target.z;
        p.y = onGround ? this.groundAtTarget(target, p.y) : target.y;
        this.segTarget = null;
        this.path.shift();
        if (!this.path.length) {
          this.moveResolve?.();
          this.moveResolve = null;
        }
      } else {
        tmpV.multiplyScalar(step / d);
        p.add(tmpV);
        if (onGround) p.y = this.followGround(target);
        else p.y += (target.y - p.y) * Math.min(1, dt * 6);
        moving = true;
        this.turnTarget = Math.atan2(-(target.x - p.x), -(target.z - p.z));
      }
      this.syncBody();
    }
    if (this.turnTarget !== null) {
      let cur = this.yaw;
      let diff = this.turnTarget - cur;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const rate = (moving ? 5 : 3.2) * dt;
      if (Math.abs(diff) <= rate) {
        cur = this.turnTarget;
        if (!moving) {
          this.turnTarget = null;
          this.turnResolve?.();
          this.turnResolve = null;
        }
      } else cur += Math.sign(diff) * rate;
      this.root.rotation.y = cur + Math.PI;
    }
    this.walkAmt += ((moving ? 1 : 0) - this.walkAmt) * Math.min(1, dt * 8);
    if (moving) {
      const k0 = Math.floor(this.walkPhase / Math.PI - 0.5);
      this.walkPhase += (dt * this.walkSpeed * 5.2) / this.strideAmp;
      if (Math.floor(this.walkPhase / Math.PI - 0.5) !== k0) {
        Character.onStep?.(this);
        for (const fn of Character.stepListeners) fn(this);
      }
    }
  }

  // ------------------------------------------------------------------ 땅 붙이기 (ground)
  // 경로 구간마다 참조 높이(경로점 높이를 수평 진행으로 보간)를 두고, GROUND_STEP 앞마다 그 둘레에서 땅을 한 번 찾는다.
  // 발 높이는 지난 표본 A와 다음 표본 B 사이 직선: 레이는 0.25 m 걸을 때 한 번 (1.35 m/s면 초당 5.4번), 프레임마다 만들지 않는다.

  private beginSegment(target: THREE.Vector3): void {
    const p = this.root.position;
    this.segTarget = target;
    this.segFrom.copy(p);
    this.segLen = Math.hypot(target.x - p.x, target.z - p.z);
    this.segSteep = Math.abs(target.y - p.y) > GROUND_STEEP * this.segLen + 0.3;
    // 표본 구간을 지금 자리에서 비워 둔다: 첫 프레임에 followGround가 B를 찍는다 (A = 지금 발 높이라 끊기지 않는다)
    this.gAx = this.gBx = p.x;
    this.gAz = this.gBz = p.z;
    this.gAy = this.gBy = p.y;
  }

  private followGround(target: THREE.Vector3): number {
    const p = this.root.position;
    let t = this.chordT(p.x, p.z);
    if (t >= 1) {
      // 지난 표본(B)에서 목표 쪽으로 다음 표본 (이번 프레임에 간 거리보다 짧지 않게)
      const ax = (this.gAx = this.gBx);
      const az = (this.gAz = this.gBz);
      this.gAy = this.gBy;
      const fine = this.gFine > 0;
      this.nextSample(target, ax, az, fine ? GROUND_FINE : GROUND_STEP);
      if (Math.abs(this.gBy - this.gAy) > GROUND_EDGE) {
        // 높이가 바뀐다: 성긴 표본이었으면 촘촘히 다시 (단 모서리를 0.1 m 안에서 넘는다)
        if (!fine) this.nextSample(target, ax, az, GROUND_FINE);
        this.gFine = GROUND_FINE_KEEP;
      } else if (this.gFine > 0) this.gFine--;
      t = this.chordT(p.x, p.z);
    }
    return this.gAy + (this.gBy - this.gAy) * Math.min(1, Math.max(0, t));
  }

  /** A(ax, az)에서 목표 쪽 (지금 자리 + step) 앞에 표본 B를 찍는다 */
  private nextSample(target: THREE.Vector3, ax: number, az: number, step: number): void {
    const p = this.root.position;
    const dx = target.x - ax;
    const dz = target.z - az;
    const dist = Math.hypot(dx, dz);
    const ahead = Math.hypot(p.x - ax, p.z - az) + step;
    if (dist <= ahead) {
      this.gBx = target.x;
      this.gBz = target.z;
    } else {
      this.gBx = ax + (dx * ahead) / dist;
      this.gBz = az + (dz * ahead) / dist;
    }
    this.gBy = this.sampleGround(this.gBx, this.gBz, this.gAy, Math.hypot(this.gBx - ax, this.gBz - az));
  }

  /** 지금 표본 구간 A → B에서 (x, z)의 진행 (0~1, 넘으면 다음 표본) */
  private chordT(x: number, z: number): number {
    const bx = this.gBx - this.gAx;
    const bz = this.gBz - this.gAz;
    const l2 = bx * bx + bz * bz;
    if (l2 < 1e-8) return 1;
    return ((x - this.gAx) * bx + (z - this.gAz) * bz) / l2;
  }

  /** 경로점에 닿았을 때의 발 높이 (그 점이 지금 표본 B면 그 값) */
  private groundAtTarget(target: THREE.Vector3, feet: number): number {
    if (this.gBx === target.x && this.gBz === target.z) return this.gBy;
    return this.sampleGround(target.x, target.z, feet, Math.hypot(target.x - this.gBx, target.z - this.gBz));
  }

  /**
   * (x, z)의 땅 높이: 경로 참조 높이와 발 높이를 둘러싼 창(위 GROUND_UP, 아래 GROUND_DOWN)에서 맨 위 면.
   * 발·경로보다 한 걸음(dist m)에 오를 수 있는 높이를 넘는 면이면 그 높이 아래에서 한 번 더 (낮은 담을 지나가는 길은 그 밑 땅). 없으면 경로 높이
   */
  private sampleGround(x: number, z: number, feet: number, dist: number): number {
    const ref = this.refHeight(x, z);
    const base = Math.max(ref, feet);
    const low = Math.min(ref, feet) - GROUND_DOWN;
    const reach = base + Math.max(GROUND_RISE_MIN, GROUND_RISE + GROUND_SLOPE * dist);
    let gy = this.ground!.height(x, z, base + GROUND_UP, low);
    if (gy > reach) gy = this.ground!.height(x, z, reach, low);
    return gy === gy ? gy : ref;
  }

  /** 경로 구간의 참조 높이: 출발 높이 → 경로점 높이를 수평 진행으로 */
  private refHeight(x: number, z: number): number {
    const tg = this.segTarget!;
    if (this.segLen < 1e-4) return tg.y;
    const k = 1 - Math.hypot(tg.x - x, tg.z - z) / this.segLen;
    return this.segFrom.y + (tg.y - this.segFrom.y) * Math.min(1, Math.max(0, k));
  }

  private updateFace(dt: number): void {
    const f = this.face;
    // 깜빡임: 2~5초마다, 가끔 두 번
    if (this.blinkT < 0) {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blinkT = 0;
        this.blinkTimer = this.doubleBlink ? 0.12 : 1.8 + Math.random() * 3.6;
        this.doubleBlink = !this.doubleBlink && Math.random() < 0.18;
      }
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const t = this.blinkT;
      f.blink = t < 0.06 ? t / 0.06 : t < 0.1 ? 1 : Math.max(0, 1 - (t - 0.1) / 0.1);
      if (t > 0.2) {
        this.blinkT = -1;
        f.blink = 0;
      }
    }
    // 입: 음절처럼 여닫기 (느린 엔벨로프 × 빠른 진동)
    this.talkEnv += ((this.talking ? 1 : 0) - this.talkEnv) * Math.min(1, dt * 12);
    if (this.talkEnv > 0.01) {
      this.talkPhase += dt * (8.5 + Math.sin(this.time * 1.7) * 2.5);
      const syl = Math.max(0, Math.sin(this.talkPhase * Math.PI));
      const gate = 0.55 + 0.45 * Math.sin(this.time * 3.1 + Math.sin(this.time * 1.3) * 2);
      f.mouth = this.talkEnv * syl * (0.35 + 0.65 * Math.max(0, gate));
    } else f.mouth = 0;
    // 눈동자 시선 (모프가 있을 때만)
    if (f.hasGaze) {
      f.gaze.x = THREE.MathUtils.clamp(this.lookYaw / (40 * DEG), -1, 1) * 0.6;
      f.gaze.y = THREE.MathUtils.clamp(this.lookPitch / (25 * DEG), -1, 1) * 0.6;
    }
    f.update(dt);
  }

  private lookTargetWorld(): THREE.Vector3 | null {
    const l = this.look;
    if (!l) return null;
    if (typeof l === 'function') return l();
    if ((l as THREE.Object3D).isObject3D) return (l as THREE.Object3D).getWorldPosition(new THREE.Vector3());
    return l as THREE.Vector3;
  }

  private applyPose(dt: number): void {
    // 기본 자세 전환
    if (this.poseT < 1) {
      this.poseT = Math.min(1, this.poseT + dt / this.poseDur);
      const k = this.poseT * this.poseT * (3 - 2 * this.poseT);
      for (const s of this.bones.values()) s.base.slerpQuaternions(s.from, s.to, k);
      this.hipNow = THREE.MathUtils.lerp(this.hipFrom, this.hipTo, k);
      this.plantNow = THREE.MathUtils.lerp(this.plantFrom, this.plantTo, k);
      this.rootNow.slerpQuaternions(this.rootFrom, this.rootTo, k);
      this.rootPosNow.lerpVectors(this.rootPosFrom, this.rootPosTo, k);
      for (const slot of ['R', 'L'] as HandSlot[]) {
        const f = this.frames[slot];
        // 쥔 자리가 생기거나 없어질 때는 자리를 바로 그쪽으로 (무게만 섞는다)
        const fromP = f.from.w > 0.001 ? f.from : f.to;
        const toP = f.to.w > 0.001 ? f.to : f.from;
        f.now.p.lerpVectors(fromP.p, toP.p, k);
        f.now.q.slerpQuaternions(fromP.q, toP.q, k);
        f.now.w = THREE.MathUtils.lerp(f.from.w, f.to.w, k);
      }
    }
    // 제스처 가중치
    let gw = 0;
    const g = this.gesture;
    if (g) {
      g.t += dt;
      const { in: ti, hold, out } = g.g;
      if (g.t < ti) gw = g.t / ti;
      else if (g.t < ti + hold) gw = 1;
      else if (g.t < ti + hold + out) gw = 1 - (g.t - ti - hold) / out;
      else {
        gw = 0;
        this.gesture = null;
        g.resolve();
      }
      gw = gw * gw * (3 - 2 * gw);
    }
    // 제스처가 움직이는 팔은 쥔 자리 IK를 그만큼 풀어 준다 (든 소품을 제스처로 들어 보일 때)
    for (const side of ['R', 'L'] as HandSlot[]) this.gestureArm[side] = g && (g.g.pose[`upperarm_${side}`] || g.g.pose[`forearm_${side}`]) ? gw : 0;
    // 시선
    let wantYaw = 0;
    let wantPitch = 0;
    const tw = this.lookTargetWorld();
    if (tw) {
      // 루트의 월드 행렬만 (updateMatrixWorld()는 캐릭터 아래 100여 개를 매 프레임 다시 계산한다)
      this.root.updateWorldMatrix(true, false);
      const local = this.root.worldToLocal(tmpV.copy(tw)).sub(this.headLocal);
      const yaw = Math.atan2(local.x, local.z);
      const pitch = Math.atan2(local.y, Math.hypot(local.x, local.z));
      if (Math.abs(yaw) < 120 * DEG) {
        wantYaw = THREE.MathUtils.clamp(yaw, -this.lookLimit.yaw, this.lookLimit.yaw);
        wantPitch = THREE.MathUtils.clamp(pitch, -this.lookLimit.down, this.lookLimit.up);
      }
    }
    const lk = 1 - Math.exp(-5 * dt);
    this.lookYaw += (wantYaw - this.lookYaw) * lk;
    this.lookPitch += (wantPitch - this.lookPitch) * lk;

    // 귀 쫑긋 (가끔, ear_L/R 본이 있는 모델)
    let ear = 0;
    if (this.earT < 0) {
      this.earTimer -= dt;
      if (this.earTimer <= 0) {
        this.earT = 0;
        this.earTimer = 4 + Math.random() * 8;
      }
    } else {
      this.earT += dt;
      ear = Math.sin(Math.min(1, this.earT / 0.35) * Math.PI) * 9;
      if (this.earT > 0.35) this.earT = -1;
    }

    const t = this.time;
    const breath = Math.sin(t * 1.9);
    const w = this.walkAmt;
    const swing = Math.sin(this.walkPhase);
    const sa = this.strideAmp;
    const talkNod = this.talkEnv * (Math.sin(t * 2.3) * 2.2 + Math.sin(t * 5.1) * 1.0);
    const posc = POSE_OSC[this.poseName];
    const pk = this.poseT * this.poseT * (3 - 2 * this.poseT);

    for (const [name, s] of this.bones) {
      const q = tmpQ.copy(s.base);
      // 이동 중에는 자세의 다리 각을 풀고 걷기 흔들기로 바꾼다 (달리기 자세의 보폭이 겹치지 않게)
      if (w > 0.01 && LEG_BONES.has(name)) q.slerp(tmpQ2.identity(), w);
      // 자세 자체의 반복 움직임 (손 흔들기, 박수, 두리번거림)
      if (posc) {
        for (const o of posc) {
          if (o.bone !== name) continue;
          const a = Math.sin(t * o.hz * Math.PI * 2 + (o.phase ?? 0)) * o.amp * DEG * pk;
          tmpE.set(o.axis === 0 ? a : 0, o.axis === 1 ? a : 0, o.axis === 2 ? a : 0);
          q.multiply(tmpQ2.setFromEuler(tmpE));
        }
      }
      if (g && gw > 0) {
        const gq = g.g.pose[name] ? poseQuat(g.g.pose, name, tmpQ2) : tmpQ2.copy(s.base);
        q.slerp(gq, gw);
        if (g.g.osc) {
          for (const o of g.g.osc) {
            if (o.bone !== name) continue;
            const a = Math.sin(g.t * o.hz * Math.PI * 2) * o.amp * DEG * gw;
            tmpE.set(o.axis === 0 ? a : 0, o.axis === 1 ? a : 0, o.axis === 2 ? a : 0);
            q.multiply(tmpQ2.setFromEuler(tmpE));
          }
        }
      }
      // 절차 움직임 (본 로컬 오일러, 도)
      let x = 0;
      let y = 0;
      let z = 0;
      switch (name) {
        case 'spine':
          x = breath * 0.6;
          y = this.lookYaw * 0.08 / DEG;
          break;
        case 'chest':
          x = breath * 1.1 - w * 3;
          y = this.lookYaw * 0.17 / DEG + swing * 4 * w;
          break;
        case 'neck':
          x = -this.lookPitch * 0.35 / DEG + breath * -0.4;
          y = this.lookYaw * 0.3 / DEG;
          break;
        case 'head':
          x = -this.lookPitch * 0.65 / DEG + talkNod;
          y = this.lookYaw * 0.45 / DEG;
          break;
        case 'shoulder_L':
        case 'shoulder_R':
          z = breath * 0.8 * (name.endsWith('L') ? 1 : -1);
          break;
        case 'upperarm_L':
          if (!this.steadyArm.L) x = -swing * 16 * w * sa;
          break;
        case 'upperarm_R':
          if (!this.steadyArm.R) x = swing * 16 * w * sa;
          break;
        case 'thigh_L':
          x = swing * 24 * w * sa * this.strideScale;
          break;
        case 'thigh_R':
          x = -swing * 24 * w * sa * this.strideScale;
          break;
        case 'shin_L':
          x = -Math.max(0, -swing) * 34 * w * sa * this.strideScale;
          break;
        case 'shin_R':
          x = -Math.max(0, swing) * 34 * w * sa * this.strideScale;
          break;
        case 'ear_L':
        case 'ear_R':
          x = ear + breath * 0.8;
          break;
        case 'hair_tail_01':
          x = Math.sin(t * 1.3) * 2 - w * 8;
          z = Math.sin(t * 0.9 + 1) * 2 + swing * 3 * w;
          break;
      }
      if (x || y || z) q.multiply(tmpQ2.setFromEuler(tmpE.set(x * DEG, y * DEG, z * DEG, 'XYZ')));
      // 한 번에 써 넣는다 (bone.quaternion을 바꿀 때마다 three가 rotation 오일러를 다시 계산한다: copy·multiply면 두 번)
      s.bone.quaternion.copy(tmpQ3.copy(s.rest).multiply(q));
    }
    // 걸을 때 디딤발 붙이기 + 앉는 자세의 몸 내림 + 자세의 몸 전체 회전·이동 (눕기, 엎드리기, 공중)
    this.model.quaternion.copy(this.rootNow);
    this.model.position.copy(this.rootPosNow);
    // 붙이기 무게: 선 자세면 자세 무게, 아니면 걷기 비율 (걸을 때 디딤발)
    const pw = this.plantNow + (1 - this.plantNow) * w;
    const body =
      this.footChains.length === 2
        ? this.hipNow * (1 - this.plantNow) + (pw > 0.01 ? this.plantDrop(pw) : 0)
        : this.hipNow + Math.abs(Math.cos(this.walkPhase)) * 0.025 * w * sa * this.strideScale;
    this.plantDelta = body - this.hipNow;
    this.model.position.y += body;
    if (w > 0.01) this.uprightProps(w);
    this.updateHands(dt);
  }

  /**
   * 발목 본(foot_L·foot_R)까지의 사슬, 발바닥 점, 선 자세(바인드)의 발바닥 높이 (모델 공간). 발바닥 점은 그 발 본에 실린(무게 0.5 넘게)
   * 메시 정점 중 가장 낮은 높이 1.5 cm 안의 맨 앞(앞꿈치)·맨 뒤(뒤꿈치) 둘: 정강이가 기울어 발끝이 내려가도 발바닥으로 잰다.
   * 발 정점이 없으면 발목 자체. 사슬이 없으면 예전 몸 오르내림
   */
  private findFootChains(): void {
    const chains: THREE.Object3D[][] = [];
    const soles: THREE.Vector3[][] = [];
    for (const name of ['foot_L', 'foot_R']) {
      const foot = this.model.getObjectByName(name);
      if (!foot) return;
      const chain: THREE.Object3D[] = [];
      let o: THREE.Object3D | null = foot;
      while (o && o !== this.model) {
        chain.unshift(o);
        o = o.parent;
      }
      if (o !== this.model) return;
      chains.push(chain);
      soles.push(this.solePoints(foot, chain));
    }
    this.footChains = chains;
    this.soles = soles;
    this.restFootY = Math.min(this.soleY(0), this.soleY(1));
  }

  /** 발 본에 실린 정점에서 앞꿈치·뒤꿈치 (발 본 공간) */
  private solePoints(foot: THREE.Object3D, chain: THREE.Object3D[]): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    this.model.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || !sm.skeleton) return;
      const bi = sm.skeleton.bones.indexOf(foot as THREE.Bone);
      if (bi < 0) return;
      const pos = sm.geometry.attributes.position;
      const si = sm.geometry.attributes.skinIndex;
      const sw = sm.geometry.attributes.skinWeight;
      if (!pos || !si || !sw) return;
      const inv = sm.skeleton.boneInverses[bi];
      for (let i = 0; i < pos.count; i++) {
        let wgt = 0;
        for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) wgt += sw.getComponent(i, k);
        if (wgt < 0.5) continue;
        pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(sm.bindMatrix).applyMatrix4(inv));
      }
    });
    if (!pts.length) return [new THREE.Vector3()];
    // 바인드 자세의 모델 공간 높이로 가장 낮은 띠, 그 안에서 모델 앞(+Z)·뒤 끝
    const m = this.chainMatrix(chain);
    const world = pts.map((p) => p.clone().applyMatrix4(m));
    const minY = Math.min(...world.map((p) => p.y));
    let front = -1;
    let back = -1;
    for (let i = 0; i < world.length; i++) {
      if (world[i].y > minY + 0.015) continue;
      if (front < 0 || world[i].z > world[front].z) front = i;
      if (back < 0 || world[i].z < world[back].z) back = i;
    }
    return front === back ? [pts[front]] : [pts[front], pts[back]];
  }

  /** 사슬 끝(발목)의 모델 공간 행렬: 사슬마다 지금 위치·회전으로 다시 짠다 (발 두 개 × 본 대여섯, 걷는 캐릭터만) */
  private chainMatrix(chain: THREE.Object3D[]): THREE.Matrix4 {
    tmpM.identity();
    for (const o of chain) {
      tmpM2.compose(o.position, o.quaternion, o.scale);
      tmpM.multiply(tmpM2);
    }
    return tmpM;
  }

  /** 발 i의 발바닥 가장 낮은 높이 (모델 공간) */
  private soleY(i: number): number {
    const m = this.chainMatrix(this.footChains[i]);
    let y = Infinity;
    for (const p of this.soles[i]) y = Math.min(y, tmpV.copy(p).applyMatrix4(m).y);
    return y;
  }

  /**
   * 걷는 동안 몸 높이 (m, 루트 공간): 두 발 중 낮은 발바닥(디딤발)을 선 자세의 발바닥 높이에 둔다. 다리가 벌어지면 내려가고 모이면
   * 선 높이로 돌아온다 (늘 한 발은 땅에). w = 붙이기 무게 (선 자세·걷기 비율). 발목 사슬이 없는 모델(자리표시 인물)은 부르지 않는다 (단순 몸 오르내림)
   */
  private plantDrop(w: number): number {
    const low = Math.min(this.soleY(0), this.soleY(1));
    // 모델 공간 → 루트 공간 (모델 크기). 디딤발이 선 자세보다 높으면 내리고, 낮으면(무릎을 편 채 뒤로 젖힌 발 등) 올린다
    return (this.restFootY - low) * this.model.scale.y * w;
  }

  /**
   * 세워 든 소품(steadyArm)을 걷는 동안 곧게: 걷기 몸 기울기(가슴 숙임, 비틀기, 숨)만큼 손을 돌려 소품의 자루(로컬 +Y)를
   * 수직으로 되돌린다. w = 걷기 비율 (서 있을 때는 자세가 정한 각도 그대로)
   */
  private uprightProps(w: number): void {
    for (const side of ['L', 'R'] as HandSlot[]) {
      const prop = this.steadyProp[side];
      const hand = prop ? this.bones.get(`hand_${side}`)?.bone : undefined;
      if (!prop || !hand?.parent) continue;
      prop.updateWorldMatrix(true, false);
      const e = prop.matrixWorld.elements;
      const axis = tmpV.set(e[4], e[5], e[6]).normalize();
      // 소품 자루 → 위로 돌리는 월드 회전 (w만큼), 손 본의 부모 공간으로 옮겨 손에 건다
      const fix = tmpQ.setFromUnitVectors(axis, UP).slerp(tmpQ2.identity(), 1 - w);
      hand.parent.getWorldQuaternion(tmpQ2);
      const handWorld = tmpQ3.copy(tmpQ2).multiply(hand.quaternion);
      handWorld.premultiply(fix);
      hand.quaternion.copy(tmpQ2.invert().multiply(handWorld));
    }
  }

  // ------------------------------------------------------------------ 손에 든 소품

  /** 그 손에 든 소품 (없으면 null) */
  heldIn(slot: HandSlot): Held | null {
    return this.held[slot] ?? null;
  }

  /** 소품을 손 소켓(socket_hand_R/L)에 쥔다. 그 손에 든 것은 치운다. 소품 묶음(쥐는 점이 원점)을 돌려준다 */
  hold(slot: HandSlot, obj: THREE.Object3D, opts: HoldOptions = {}): Held {
    this.unhold(slot);
    const h = wrapProp(slot, obj, opts);
    const socket = this.model.getObjectByName(`socket_hand_${slot}`) ?? this.model.getObjectByName(`hand_${slot}`) ?? this.root;
    socket.add(h.wrapper);
    this.held[slot] = h;
    return h;
  }

  /** 든 소품을 치운다 (떨어뜨리지 않고 없앤다) */
  unhold(slot: HandSlot): void {
    const h = this.held[slot];
    if (!h) return;
    h.wrapper.removeFromParent();
    delete this.held[slot];
  }

  /**
   * 든 소품을 내려놓는다: 손에서 떼어 월드(캐릭터가 붙은 묶음)에 두고, 손 자리에서 목표 자리·회전으로 duration 동안 옮긴다.
   * 손은 닿을 때까지 소품을 따라가고, 닿은 뒤 release 동안 놓는다. 닿으면 resolve (onLand도 그때)
   */
  drop(slot: HandSlot, pos: THREE.Vector3, quat: THREE.Quaternion, opts: DropOptions = {}): Promise<void> {
    const h = this.held[slot];
    if (!h) return Promise.resolve();
    delete this.held[slot];
    this.root.updateMatrixWorld(true);
    (this.root.parent ?? this.root).attach(h.wrapper);
    h.state = 'dropping';
    h.t = -1;
    h.dur = Math.max(0.05, opts.duration ?? 0.5);
    h.release = Math.max(0.05, opts.release ?? 0.3);
    h.hand = 1;
    h.target.pos.copy(pos);
    h.target.quat.copy(quat);
    h.onLand = opts.onLand;
    this.drops.push(h);
    return new Promise((r) => (h.resolve = r));
  }

  /** 내려놓는 중인 소품 하나를 거둔다 (상태를 되돌려 다시 쥘 때). 묶음은 월드에서 떼고, 닿는 순간(onLand)은 오지 않는다 */
  cancelDrop(h: Held): void {
    const i = this.drops.indexOf(h);
    if (i >= 0) this.drops.splice(i, 1);
    h.wrapper.removeFromParent();
  }

  /** 내려놓는 중인 소품을 바로 목표에 둔다 (컷이 바뀌어 캐릭터가 숨을 때). 소리는 내지 않는다 */
  finishDrops(): void {
    for (const h of this.drops) {
      if (h.state === 'dropping') {
        h.wrapper.position.copy(h.target.pos);
        h.wrapper.quaternion.copy(h.target.quat);
        h.state = 'released';
        h.resolve?.();
      }
      h.hand = 0;
    }
    this.drops.length = 0;
  }

  private armChains(): Partial<Record<HandSlot, ArmChain>> {
    if (this.chains) return this.chains;
    this.chains = {};
    for (const side of ['R', 'L'] as HandSlot[]) {
      const f = (n: string) => this.model.getObjectByName(`${n}_${side}`);
      const upper = f('upperarm');
      const lower = f('forearm');
      const hand = f('hand');
      const socket = f('socket_hand');
      const shoulder = f('shoulder');
      if (upper && lower && hand && socket) this.chains[side] = { shoulder: shoulder ?? undefined, upper, lower, hand, socket };
    }
    return this.chains;
  }

  /** 손이 소품을 쥘 자리 (월드): 자세의 쥔 자리와 FK 손 소켓을 무게로 섞는다 */
  private handFrame(slot: HandSlot, outP: THREE.Vector3, outQ: THREE.Quaternion): void {
    const ch = this.armChains()[slot];
    const f = this.frames[slot].now;
    if (ch) {
      ch.socket.getWorldPosition(outP);
      ch.socket.getWorldQuaternion(outQ);
    } else {
      this.root.getWorldPosition(outP);
      this.root.getWorldQuaternion(outQ);
    }
    if (f.w > 0.001) {
      const p = this.root.localToWorld(tmpV.copy(f.p));
      const q = this.root.getWorldQuaternion(tmpQ).multiply(f.q);
      outP.lerp(p, f.w);
      outQ.slerp(q, f.w);
    }
  }

  private pole(slot: HandSlot): THREE.Vector3 {
    return new THREE.Vector3(slot === 'R' ? -0.55 : 0.55, -1, -0.35).applyQuaternion(this.root.getWorldQuaternion(tmpQ));
  }

  /** 손 IK: 쥔 자리 → 내려놓는 소품 → 받침손 */
  private updateHands(dt: number): void {
    if (!this.held.R && !this.held.L && !this.drops.length) return;
    const chains = this.armChains();
    if (!chains.R && !chains.L) return;
    // 팔 사슬만 최신으로 (solveArm은 matrixWorld를 바로 읽는다): 몸통까지 부모 사슬 + 두 팔 아래(든 소품 포함).
    // 캐릭터 전체(다리·머리·소품 100여 개)를 강제로 다시 계산하지 않는다. 값은 같다
    for (const slot of ['R', 'L'] as HandSlot[]) {
      const ch = chains[slot];
      if (!ch) continue;
      const top = ch.shoulder ?? ch.upper;
      top.parent?.updateWorldMatrix(true, false);
      top.updateMatrixWorld(true);
    }
    // 1. 든 소품: 자세의 쥔 자리로 손을 옮긴다 (소품은 소켓의 자식이라 따라온다)
    for (const slot of ['R', 'L'] as HandSlot[]) {
      const h = this.held[slot];
      const ch = chains[slot];
      const f = this.frames[slot].now;
      const fw = f.w * (1 - this.gestureArm[slot]);
      if (!h || !ch || fw <= 0.001) continue;
      const p = this.root.localToWorld(new THREE.Vector3().copy(f.p).setY(f.p.y + this.plantDelta));
      const q = this.root.getWorldQuaternion(new THREE.Quaternion()).multiply(f.q);
      solveArm(ch, p, q, this.pole(slot), fw);
    }
    // 2. 내려놓는 소품: 손 자리 → 목표. 손은 소품을 따라간다
    const hp = new THREE.Vector3();
    const hq = new THREE.Quaternion();
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const h = this.drops[i];
      const ch = chains[h.slot];
      const w = h.wrapper;
      if (h.state === 'dropping') {
        this.handFrame(h.slot, hp, hq);
        if (h.t < 0) {
          // 출발: 손 자리와 소품의 차이를 기억해 두고 줄여 간다 (끊김 없이)
          h.t = 0;
          w.userData.offP = w.position.clone().sub(hp);
          w.userData.offQ = hq.clone().invert().multiply(w.quaternion);
        } else h.t += dt;
        const k = smoother(h.t / h.dur);
        const offP = w.userData.offP as THREE.Vector3;
        const offQ = w.userData.offQ as THREE.Quaternion;
        hp.addScaledVector(offP, 1 - k);
        hq.multiply(tmpQ.identity().slerp(offQ, 1 - k));
        // 수평은 먼저, 높이는 나중에 맞춰 마지막에 위에서 살짝 내려앉는다
        const kh = smoother(Math.min(1, (h.t / h.dur) * 1.25));
        w.position.set(
          THREE.MathUtils.lerp(hp.x, h.target.pos.x, kh),
          THREE.MathUtils.lerp(hp.y, h.target.pos.y, k),
          THREE.MathUtils.lerp(hp.z, h.target.pos.z, kh),
        );
        w.quaternion.slerpQuaternions(hq, h.target.quat, k);
        if (h.t >= h.dur) {
          w.position.copy(h.target.pos);
          w.quaternion.copy(h.target.quat);
          h.state = 'released';
          h.onLand?.(h.target.pos.clone());
          h.resolve?.();
        }
        w.updateMatrixWorld(true);
      } else {
        h.hand = Math.max(0, h.hand - dt / h.release);
        if (h.hand <= 0) {
          this.drops.splice(i, 1);
          continue;
        }
      }
      if (ch) {
        const wt = h.state === 'dropping' ? 1 : smoother(h.hand);
        solveArm(ch, w.getWorldPosition(hp), w.getWorldQuaternion(hq), this.pole(h.slot), wt);
      }
    }
    // 3. 받침손: 오른손의 두 손 소품 받침 자리(grip_support)에 빈 왼손을
    const chL = chains.L;
    if (chL && !this.held.L) {
      let h: Held | null = this.held.R && this.held.R.support ? this.held.R : null;
      // 왼팔 제스처 동안은 받침손을 놓는다 (쥔 자리 IK와 같게)
      let wt = this.supportWeight * (1 - this.gestureArm.L);
      if (!h) {
        h = this.drops.find((d) => d.slot === 'R' && d.support) ?? null;
        wt = h ? (h.state === 'dropping' ? 1 : smoother(h.hand)) : 0;
      }
      if (h?.support && wt > 0.001) {
        // getWorld*가 부모 사슬을 다시 계산한다 (소품 전체를 강제로 다시 계산할 필요는 없다)
        const p = h.support.getWorldPosition(new THREE.Vector3());
        const q = h.model.getWorldQuaternion(new THREE.Quaternion()).multiply(h.supportRot);
        solveArm(chL, p, q, this.pole('L'), wt, 0.75);
      }
    }
  }

  dispose(): void {
    if (this.body && this.physics) this.physics.world.removeRigidBody(this.body);
    this.root.removeFromParent();
  }
}

interface HoldFrame {
  p: THREE.Vector3;
  q: THREE.Quaternion;
  w: number;
}
const newFrame = (): HoldFrame => ({ p: new THREE.Vector3(), q: new THREE.Quaternion(), w: 0 });
const newFrames = () => ({ from: newFrame(), to: newFrame(), now: newFrame() });
function copyFrame(out: HoldFrame, src: HoldFrame): void {
  out.p.copy(src.p);
  out.q.copy(src.q);
  out.w = src.w;
}

/** 대체 인물(placeholderCharacter)의 키 (m) */
const PLACEHOLDER_HEIGHT = 1.14;

/** 모델이 없을 때의 대체 인물 (캡슐 + 머리, 키 약 1.1 m) */
export function placeholderCharacter(color = 0x8a96a0): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'placeholder_character';
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.32, 6, 12), toonMaterial(color));
  body.position.y = 0.38;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), toonMaterial(0xf2d6c4));
  head.position.y = 0.88;
  head.name = 'head';
  g.add(head);
  const eye = new THREE.Object3D();
  eye.name = 'socket_eye';
  eye.position.set(0, 0.88, 0.16);
  g.add(eye);
  applyOutlines(g);
  return g;
}
