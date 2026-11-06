/**
 * 물리 거울 워커 규약 (recorder.ts ↔ core.ts / mirror.worker.ts).
 *
 * 메인 Rapier 월드의 바뀐 것(몸·콜라이더 생성·제거·자세·켜짐·모양·그룹)을 고정 스텝마다 스냅샷으로 모아 워커에 보내면,
 * 워커는 같은 모양의 거울 월드를 유지하고 그 위에서 캐릭터 컨트롤러 이동(computeColliderMovement)을 대신 계산한다.
 * 거울은 한 가지 이동 질의(캐릭터 이동: 그룹 queryGroups + 소유자로 거르는 술어)만 섬긴다. 술어는 콜라이더 분류(CLS_*)로 바꿔 보낸다:
 * 메인과 똑같이 그룹 + 술어로 거른다 (Rapier 컨트롤러의 발판 마찰 검사는 그룹 대신 술어만 보는 판이 있어 그룹으로 흉내 내면 어긋났다).
 */

/** 콜라이더 분류 (소유자로 정한다): 0 보통, 1 이동 질의가 늘 지나감, 2 겹쳐 지나가기 질의만 지나감 */
export const CLS_SOLID = 0;
export const CLS_SKIP = 1;
export const CLS_GHOSTABLE = 2;

/**
 * 몸 상태: handle, type(RigidBodyType), enabled, jump, tx, ty, tz, qx, qy, qz, qw.
 * 키네마틱 몸은 거울에서도 다음 자세로만 옮겨 거울 step이 메인과 같은 속도를 낸다 (컨트롤러가 닿은 키네마틱 몸의 velocity_at_point로
 * 캐릭터를 실어 나른다: 움직이는 발판). jump: 메인이 setTranslation·setRotation으로 바로 옮겼다 (속도 없이 옮긴다)
 */
export const BODY_STRIDE = 11;
/** 콜라이더 상태: handle, parent(-1 없음), enabled, sensor, groups, cls, density, tx, ty, tz, qx, qy, qz, qw (부모가 있으면 부모 기준) */
export const COL_STRIDE = 14;
/**
 * 이동 요청: key(이동 콜라이더 handle), dx, dz, vCap, ghost, dt, yaw(이동 뒤 몸 방향, 다음 스텝 몸 회전), ex, ey, ez, edy
 * (e*: 점검 모드의 정해 준 출발·수직 이동, 아니면 NaN)
 */
export const MOVE_STRIDE = 11;
/** 이동 주체 처음 상태: key, x, y, z, vy, grounded, firstStep */
export const ACTOR_STRIDE = 7;
/** 점검(debugHits): 이동마다 닿은 콜라이더 메인 handle 3개 (없으면 -1), 움직인 콜라이더 자리, 첫 닿은 콜라이더 자리 */
export const HIT_STRIDE = 9;
/** 결과: mvx, mvy, mvz, grounded, vy, dynTouch(동적 몸에 닿음: 메인이 밀기 충격을 다시 준다) (계산 못 했으면 NaN) */
export const RES_STRIDE = 6;

export interface ShapeData {
  /** RAPIER.ShapeType */
  t: number;
  /** 숫자 인자 (반지름·반높이·반크기 등) */
  a: number[];
  v?: Float32Array;
  i?: Uint32Array | null;
  /** TriMesh 플래그 */
  f?: number;
}

export interface MirrorSnap {
  bodiesGone: number[];
  collidersGone: number[];
  /** 만들거나 바꿀 몸 (BODY_STRIDE씩) */
  bodies: number[];
  /** 새로 만들거나 모양이 바뀐 콜라이더의 모양 */
  shapes: [number, ShapeData][];
  /** 만들거나 바꿀 콜라이더 (COL_STRIDE씩) */
  colliders: number[];
}

export interface ControllerParams {
  offset: number;
  up: { x: number; y: number; z: number };
  maxSlopeClimbAngle: number;
  minSlopeSlideAngle: number;
  autostep: { maxHeight: number; minWidth: number; includeDynamic: boolean } | null;
  snapToGround: number | null;
  slide: boolean;
  normalNudgeFactor: number;
}

/** 중력 적분 (메인 캐릭터 이동과 같은 식): 땅에 있으면 vy = ground, 아니면 max(min, vy - g·dt) */
export interface GravityParams {
  ground: number;
  g: number;
  min: number;
}

export type ToWorker =
  | { type: 'init'; controller: ControllerParams; gravity: GravityParams; timestep: number; queryFlags: number; queryGroups: number; debugHits?: boolean }
  | { type: 'batch'; id: number; steps: { snap: MirrorSnap; moves: Float64Array }[]; actors: Float64Array };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'result'; id: number; res: Float64Array; ms: number; dyn: number; missing: number; hits?: Float64Array }
  | { type: 'error'; id?: number; error: string };
