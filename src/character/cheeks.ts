import * as THREE from 'three';

/**
 * 볼 리그 (볼따구): 캐릭터 키트가 만든 `cheek_L`·`cheek_R` 본(head의 자식)을 스프링으로 움직인다. docs/CHARACTER_KIT.md 8장
 *
 * - 출렁임: 볼마다 질량-스프링-감쇠. head 본의 월드 가속도를 거꾸로 받아(관성) 달리기·착지·충격에 볼이 늦게 따라오며 흔들린다.
 * - 부풀리기 `puff(amount)`: 목표 0~1을 주면 그쪽으로 부드럽게 (예: 차기 힘 모으는 동안 1, 놓으면 0). 놓으면 살짝 튕긴다.
 * - 눌림 `squash(amount)`: 한 번 눌렀다가 튕기며 돌아온다 (차기 순간, 착지). 볼이 아래로 처지면 저절로 조금 눌린다.
 * - 잡아 늘이기 `pull(side, vec)` / `release(side?)`: 볼을 잡아 그 자리로 끌어당긴다. 놓으면 출렁이며 돌아온다.
 * - 충격 `impulse(vec)`: 볼에 속도를 준다 (월드 방향, 1 = 센 충격).
 *
 * 본 공간: 본 위치는 부모(head) 공간이다. 키트 규약으로 head 로컬 축은 X = 캐릭터 왼쪽, Y = 위, Z = 앞이다.
 * cheek 본의 로컬 +Y는 볼 바깥 법선, +Z는 위다. 본 머리(늘이기 중심)가 볼 표면에서 머리 안쪽으로 4.5 cm(머리 크기 배) 들어가
 * 있어서 본을 늘리면 볼이 바깥으로 부푼다.
 *
 * 수치 안정: 한 프레임 dt는 maxDt(0.1초)까지만 쓰고, 1/120초 이하 조각으로 나눠 암시적 오일러로 푼다(어떤 강성에서도 발산하지
 * 않는다). 가속도는 maxAccel로 자르고, 순간 이동(한 프레임에 teleport m 넘게)은 흔들림 없이 새 자리에서 다시 시작한다.
 */

export type CheekSide = 'L' | 'R';

export interface CheekRigOptions {
  /** 출렁임 스프링 강성 (1/s²). 클수록 빠르게 떨린다 */
  stiffness?: number;
  /** 출렁임 감쇠 (1/s). 작을수록 오래 흔들린다 */
  damping?: number;
  /** head 가속도(m/s²)를 볼 가속도로 옮기는 비율. 0이면 머리 움직임에 반응하지 않는다 */
  inertia?: number;
  /** 출렁임 변위 한계 (m, 머리 크기 배) */
  maxJiggle?: number;
  /** 잡아 늘이기 한계 (m, 머리 크기 배): 바깥으로. 안쪽·위아래·앞뒤는 이 값의 일부 */
  maxPull?: number;
  /** 잡고 있는 동안 스프링 강성 (1/s²) */
  pullStiffness?: number;
  /** 부풀리기 1일 때 본 배율 증가 (바깥 법선 Y, 가로 X, 세로 Z) */
  puffScale?: [number, number, number];
  /** 눌림 1일 때 본 배율 변화 (가로 X, 바깥 Y, 세로 Z): 세로로 눌리고 옆으로 퍼진다 */
  squashScale?: [number, number, number];
  /** 부풀리기·눌림 스프링 강성·감쇠 */
  shapeStiffness?: number;
  shapeDamping?: number;
  /** 가속도 상한 (m/s²) */
  maxAccel?: number;
  /** 한 프레임 dt 상한 (초) */
  maxDt?: number;
  /** 이보다 크게 한 프레임에 움직이면 순간 이동으로 본다 (m) */
  teleport?: number;
}

const DEFAULTS: Required<CheekRigOptions> = {
  stiffness: 240,
  damping: 7,
  inertia: 0.12,
  maxJiggle: 0.010,
  maxPull: 0.034,
  pullStiffness: 700,
  puffScale: [0.45, 0.26, 0.18],
  squashScale: [0.22, 0.10, -0.30],
  shapeStiffness: 260,
  shapeDamping: 9,
  maxAccel: 120,
  maxDt: 0.1,
  teleport: 1.0,
};

/** 키트 기본 머리(턱~정수리 0.45 m)의 두 볼 본 사이 거리. 한계 값은 이 비율로 늘고 준다 */
const REF_SPAN = 0.238;
const SUBSTEP = 1 / 120;

interface Cheek {
  bone: THREE.Bone;
  side: CheekSide;
  restPos: THREE.Vector3;
  restScale: THREE.Vector3;
  /** 바깥 방향 부호 (head 로컬 X): L = +1, R = -1 */
  out: number;
  /** 변위·속도 (head 로컬, m) */
  x: THREE.Vector3;
  v: THREE.Vector3;
  /** 잡은 자리 (head 로컬), null이면 놓음 */
  pull: THREE.Vector3 | null;
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpM3 = new THREE.Matrix3();

/** 스칼라 스프링 상태 (부풀리기·눌림) */
interface Shape {
  x: number;
  v: number;
  target: number;
}

export class CheekRig {
  readonly opts: Required<CheekRigOptions>;
  readonly cheeks: Cheek[];
  /** 머리 크기 배율 (볼 본 사이 거리 / 키트 기본) */
  readonly size: number;
  /** false면 update가 본을 쉬는 자세로 두고 아무것도 하지 않는다 */
  enabled = true;
  private readonly head: THREE.Object3D;
  private readonly puffS: Shape = { x: 0, v: 0, target: 0 };
  private readonly squashS: Shape = { x: 0, v: 0, target: 0 };
  private readonly prevPos = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private readonly acc = new THREE.Vector3();
  private primed = 0;

  /** 모델에 cheek_L·cheek_R 본이 있으면 볼 리그를 만든다. 없으면 null */
  static from(model: THREE.Object3D, opts: CheekRigOptions = {}): CheekRig | null {
    const l = model.getObjectByName('cheek_L') as THREE.Bone | undefined;
    const r = model.getObjectByName('cheek_R') as THREE.Bone | undefined;
    if (!l || !r || !l.parent) return null;
    return new CheekRig(l, r, opts);
  }

  constructor(left: THREE.Bone, right: THREE.Bone, opts: CheekRigOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.head = left.parent!;
    const mk = (bone: THREE.Bone, side: CheekSide): Cheek => ({
      bone,
      side,
      restPos: bone.position.clone(),
      restScale: bone.scale.clone(),
      out: Math.sign(bone.position.x) || (side === 'L' ? 1 : -1),
      x: new THREE.Vector3(),
      v: new THREE.Vector3(),
      pull: null,
    });
    this.cheeks = [mk(left, 'L'), mk(right, 'R')];
    this.size = Math.max(0.2, left.position.distanceTo(right.position) / REF_SPAN);
  }

  /** 부풀리기 목표 (0~1). 0으로 되돌리면 살짝 튕기며 가라앉는다 */
  puff(amount: number): void {
    this.puffS.target = THREE.MathUtils.clamp(amount, 0, 1.2);
  }

  /** 눌림 (0~1): 한 번 눌렀다가 튕기며 돌아온다. 이미 더 눌려 있으면 그대로 */
  squash(amount: number): void {
    const a = THREE.MathUtils.clamp(amount, 0, 1.2);
    if (this.squashS.x < a) this.squashS.x = a;
    this.squashS.v = Math.min(this.squashS.v, 0);
  }

  /**
   * 볼을 잡아 끈다. vec는 m(머리 크기 1 기준, 크기 배율을 곱한다): x = 얼굴 바깥쪽(양쪽 모두 +가 바깥), y = 위, z = 앞.
   * 한계를 넘으면 부드럽게 잘린다. side 'both'면 두 볼을 대칭으로
   */
  pull(side: CheekSide | 'both', vec: { x: number; y: number; z: number }): void {
    for (const c of this.cheeks) {
      if (side !== 'both' && c.side !== side) continue;
      const p = c.pull ?? (c.pull = new THREE.Vector3());
      p.set(vec.x * c.out, vec.y, vec.z).multiplyScalar(this.size);
      this.limitPull(p, c.out);
    }
  }

  /** 잡은 볼을 놓는다 (side를 빼면 둘 다). 출렁이며 제자리로 돌아온다 */
  release(side?: CheekSide): void {
    for (const c of this.cheeks) if (!side || c.side === side) c.pull = null;
  }

  /** 지금 잡혀 있는가 */
  pulled(side: CheekSide): boolean {
    return this.cheeks.some((c) => c.side === side && c.pull !== null);
  }

  /** 볼에 속도 충격 (월드 방향, 크기 1 = 센 충격: 약 0.35 m/s × 머리 크기) */
  impulse(vec: THREE.Vector3 | { x: number; y: number; z: number }): void {
    this.worldToHead(tmpV.set(vec.x, vec.y, vec.z));
    tmpV.multiplyScalar(0.35 * this.size);
    for (const c of this.cheeks) c.v.add(tmpV);
  }

  /** 흔들림·잡기·부풀리기·눌림을 모두 없애고 쉬는 자세로 */
  reset(): void {
    for (const c of this.cheeks) {
      c.x.set(0, 0, 0);
      c.v.set(0, 0, 0);
      c.pull = null;
    }
    for (const s of [this.puffS, this.squashS]) {
      s.x = s.v = s.target = 0;
    }
    this.primed = 0;
    this.apply();
  }

  /**
   * 점검·연출용: 부풀림·눌림을 그 값에 바로 놓는다 (스프링 속도 0). 잡기는 pull() 뒤 몇 프레임 update로 자리 잡는다.
   * 다음 update부터는 다시 스프링을 따른다 (부풀림 목표도 같은 값이 된다)
   */
  set(state: { puff?: number; squash?: number }): void {
    if (state.puff !== undefined) {
      this.puffS.x = this.puffS.target = state.puff;
      this.puffS.v = 0;
    }
    if (state.squash !== undefined) {
      this.squashS.x = state.squash;
      this.squashS.v = 0;
    }
    this.apply();
  }

  /** 지금 상태 (디버그·점검): 부풀림, 눌림, 볼별 변위(m, head 로컬) */
  state(): { puff: number; squash: number; offset: Record<CheekSide, THREE.Vector3> } {
    return {
      puff: this.puffS.x,
      squash: this.squashS.x,
      offset: { L: this.cheeks[0].x.clone(), R: this.cheeks[1].x.clone() },
    };
  }

  /** 매 프레임. head 본의 월드 행렬(직전 렌더 값)로 가속도를 잰다 */
  update(dt: number): void {
    if (!this.enabled) return;
    if (!(dt > 0)) return;
    const o = this.opts;
    dt = Math.min(dt, o.maxDt);
    this.measure(dt);
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    const lim = o.maxJiggle * this.size;
    for (let i = 0; i < n; i++) {
      for (const c of this.cheeks) {
        // 관성: 머리가 가속하면 볼은 반대로 밀린다. 잡고 있으면 그 자리로 강하게 당긴다
        const k = c.pull ? o.pullStiffness : o.stiffness;
        const damp = c.pull ? 2 * Math.sqrt(o.pullStiffness) * 0.7 : o.damping;
        const target = c.pull ?? tmpV2.set(0, 0, 0);
        tmpV.copy(this.acc).multiplyScalar(-o.inertia * this.size);
        // 암시적 오일러: v' = (v + h(-k(x - T) + f)) / (1 + h c + h² k), x' = x + h v'
        const den = 1 + h * damp + h * h * k;
        c.v.x = (c.v.x + h * (-k * (c.x.x - target.x) + tmpV.x)) / den;
        c.v.y = (c.v.y + h * (-k * (c.x.y - target.y) + tmpV.y)) / den;
        c.v.z = (c.v.z + h * (-k * (c.x.z - target.z) + tmpV.z)) / den;
        c.x.addScaledVector(c.v, h);
        if (!c.pull) {
          // 출렁임 한계: 넘으면 바깥 성분을 자르고 속도도 그만큼 뺀다
          const len = c.x.length();
          if (len > lim) {
            c.x.multiplyScalar(lim / len);
            const vr = c.v.dot(c.x) / (lim || 1);
            if (vr > 0) c.v.addScaledVector(c.x, -vr / (lim || 1));
          }
        } else {
          this.limitPull(c.x, c.out);
        }
      }
      // 처지면(아래 변위) 저절로 조금 눌린다: 착지
      const sag = Math.max(0, -(this.cheeks[0].x.y + this.cheeks[1].x.y) * 0.5) / (lim || 1);
      this.stepShape(this.puffS, this.puffS.target, h);
      this.stepShape(this.squashS, Math.min(1, sag * 0.6), h);
    }
    this.apply();
  }

  private stepShape(s: Shape, target: number, h: number): void {
    const k = this.opts.shapeStiffness;
    const c = this.opts.shapeDamping;
    s.v = (s.v + h * -k * (s.x - target)) / (1 + h * c + h * h * k);
    s.x = THREE.MathUtils.clamp(s.x + h * s.v, -0.4, 1.3);
  }

  /** 잡기 한계: 바깥 maxPull, 안쪽 30%, 위아래 50%, 앞 80%, 뒤 20% (타원체 안으로 당긴다) */
  private limitPull(p: THREE.Vector3, out: number): void {
    const m = this.opts.maxPull * this.size;
    const ox = p.x * out;
    const ax = ox >= 0 ? m : m * 0.3;
    const ay = m * 0.5;
    const az = p.z >= 0 ? m * 0.8 : m * 0.2;
    const r = Math.hypot(ox / ax, p.y / ay, p.z / az);
    if (r > 1) p.multiplyScalar(1 / r);
  }

  /** head 원점의 월드 가속도 (head 로컬 축으로), 낮은 통과 */
  private measure(dt: number): void {
    const head = this.head;
    tmpV.setFromMatrixPosition(head.matrixWorld);
    if (this.primed === 0 || tmpV.distanceTo(this.prevPos) > this.opts.teleport) {
      this.prevPos.copy(tmpV);
      this.prevVel.set(0, 0, 0);
      this.acc.set(0, 0, 0);
      this.primed = 1;
      return;
    }
    tmpV2.copy(tmpV).sub(this.prevPos).divideScalar(dt);
    this.prevPos.copy(tmpV);
    if (this.primed === 1) {
      this.prevVel.copy(tmpV2);
      this.primed = 2;
      return;
    }
    const a = tmpV.copy(tmpV2).sub(this.prevVel).divideScalar(dt);
    this.prevVel.copy(tmpV2);
    const L = a.length();
    if (L > this.opts.maxAccel) a.multiplyScalar(this.opts.maxAccel / L);
    this.worldToHead(a);
    // 한 프레임 튀는 값(측정 잡음)을 조금 누른다
    this.acc.lerp(a, Math.min(1, dt * 40));
  }

  /** 월드 방향 벡터 → head 로컬 (모델 배율 포함) */
  private worldToHead(v: THREE.Vector3): THREE.Vector3 {
    tmpM.copy(this.head.matrixWorld).invert();
    return v.applyMatrix3(tmpM3.setFromMatrix4(tmpM));
  }

  /** 상태 → 본 위치·배율 */
  private apply(): void {
    const o = this.opts;
    const p = Math.max(-0.3, this.puffS.x);
    const q = this.squashS.x;
    // 본 로컬: X = 가로, Y = 바깥 법선, Z = 위
    const sx = 1 + p * o.puffScale[1] + q * o.squashScale[0];
    const sy = 1 + p * o.puffScale[0] + q * o.squashScale[1];
    const sz = 1 + p * o.puffScale[2] + q * o.squashScale[2];
    for (const c of this.cheeks) {
      c.bone.position.copy(c.restPos).add(c.x);
      c.bone.scale.set(c.restScale.x * sx, c.restScale.y * sy, c.restScale.z * sz);
    }
  }
}
