import * as THREE from 'three';
import type { Engine, System } from '../core/Engine';
import { CameraRail, lookQuat, newPose, type CamPose } from './CameraRail';

/**
 * 연출 카메라 (카메라 덮어쓰기). 엔진 시스템 순서의 맨 끝에 붙어 게임 카메라(조작 중인 카메라)가 정한 자세를 덮어쓴다.
 *   play(rail)        레일 재생 (끝나면 resolve, 마지막 자세 유지)
 *   track(fn)         매 프레임 함수로 자세를 정한다 (움직이는 대상 따라가기)
 *   hold(pose)        고정
 *   blendToGameplay(s) 지금 자세 → 게임 카메라(gameplayPose)로 섞고 연출을 끝낸다
 * 연출이 아닐 때도 shake(화면 흔들림)·rumble(바닥 진동)·staggerKick(기울임)을 더한다.
 * 시간은 update의 dt(일시정지면 paused()로 0)로 흐른다.
 *
 *   const cine = engine.add(new CameraDirector(engine, (out) => myCamera.pose(out)));
 *   await cine.play(CameraRail.from(level.rails.get('intro')!));
 *   await cine.blendToGameplay(0.8);
 */
type Mode =
  | { kind: 'none' }
  | { kind: 'rail'; rail: CameraRail; t: number; speed: number; resolve: (() => void) | null }
  | { kind: 'track'; fn: (t: number, out: CamPose) => void; t: number }
  | { kind: 'hold' }
  | { kind: 'blend'; from: CamPose; t: number; dur: number; resolve: (() => void) | null };

const tmpE = new THREE.Euler();
const tmpQ = new THREE.Quaternion();

/** 게임 카메라 자세를 out에 적는다 (흔들림 없이). 없으면 연출을 시작한 순간의 엔진 카메라 */
export type GameplayPose = (out: CamPose) => CamPose;

export class CameraDirector implements System {
  /** true면 카메라를 덮어쓴다 */
  active = false;
  readonly pose: CamPose = newPose();
  private mode: Mode = { kind: 'none' };
  private time = 0;
  private appliedFov = -1;
  /** 0~1 흔들림 세기 (지수 감쇠) */
  private shakeAmp = 0;
  private shakeDecay = 2.5;
  /** 계속 흔들리는 바닥값 (진동) */
  rumble = 0;
  /** 카메라를 기울이는 비틀거림 (라디안 roll) */
  private stagger = 0;
  private staggerVel = 0;
  paused: () => boolean = () => false;
  /** 연출을 시작한 순간의 엔진 카메라 (gameplayPose가 없을 때 돌아갈 자리) */
  private readonly startPose: CamPose = newPose();

  constructor(
    private readonly engine: Engine,
    private readonly gameplayPose: GameplayPose | null = null,
  ) {}

  /** 연출 시작: 카메라를 넘겨받는다 */
  begin(pose?: CamPose): void {
    this.activate();
    if (pose) this.setPose(pose);
    else {
      this.pose.position.copy(this.engine.camera.position);
      this.pose.quaternion.copy(this.engine.camera.quaternion);
      this.pose.fov = this.engine.camera.fov;
    }
    this.mode = { kind: 'hold' };
  }

  /** 연출을 끝내고 게임 카메라로 바로 돌아간다 */
  end(): void {
    this.active = false;
    this.mode = { kind: 'none' };
    // 그사이 레벨이 바뀌며 가까운 평면을 새로 정했으면(Level.applyEnv) 그 값을 둔다
    if (this.savedNear !== null && this.engine.camera.near === this.boostedNear) {
      this.engine.camera.near = this.savedNear;
      this.engine.camera.updateProjectionMatrix();
    }
    this.savedNear = null;
    this.restoreFov();
  }

  private savedNear: number | null = null;
  private boostedNear = -1;

  /**
   * 연출 카메라를 켠다. 연출 카메라는 벽에 붙지 않으니 가까운 평면을 밀어 먼 곳의 깊이 정밀도를 올린다
   * (멀리 있는 평면 장식·창문이 깜빡이며 자글거리지 않게). end()에서 되돌린다.
   */
  private activate(): void {
    if (!this.active && this.savedNear === null) {
      const cam = this.engine.camera;
      this.startPose.position.copy(cam.position);
      this.startPose.quaternion.copy(cam.quaternion);
      this.startPose.fov = cam.fov;
      this.savedNear = cam.near;
      this.boostedNear = Math.max(this.savedNear, 0.1);
      cam.near = this.boostedNear;
      cam.updateProjectionMatrix();
    }
    this.active = true;
  }

  private restoreFov(): void {
    const cam = this.engine.camera;
    cam.fov = this.engine.settings.worldFov;
    cam.updateProjectionMatrix();
    this.appliedFov = -1;
  }

  setPose(p: CamPose): void {
    this.pose.position.copy(p.position);
    this.pose.quaternion.copy(p.quaternion);
    this.pose.fov = p.fov;
  }

  hold(p?: CamPose): void {
    this.activate();
    if (p) this.setPose(p);
    this.mode = { kind: 'hold' };
  }

  look(from: THREE.Vector3, to: THREE.Vector3, fov: number): void {
    this.activate();
    this.pose.position.copy(from);
    lookQuat(from, to, this.pose.quaternion);
    this.pose.fov = fov;
    this.mode = { kind: 'hold' };
  }

  /** 레일 재생. speed < 1이면 느리게. 끝나면 resolve */
  play(rail: CameraRail, opts: { speed?: number; from?: number } = {}): Promise<void> {
    this.activate();
    const prev = this.mode;
    if (prev.kind === 'rail' || prev.kind === 'blend') prev.resolve?.();
    return new Promise((resolve) => {
      this.mode = { kind: 'rail', rail, t: opts.from ?? 0, speed: opts.speed ?? 1, resolve };
      rail.sample(opts.from ?? 0, this.pose);
    });
  }

  track(fn: (t: number, out: CamPose) => void): void {
    this.activate();
    const prev = this.mode;
    if (prev.kind === 'rail' || prev.kind === 'blend') prev.resolve?.();
    this.mode = { kind: 'track', fn, t: 0 };
    fn(0, this.pose);
  }

  /** 연출 시계 (초): update dt의 합. 일시정지 동안 멈춘다 */
  get clock(): number {
    return this.time;
  }

  /** 지금 레일의 시각 (레일이 아니면 -1) */
  get railTime(): number {
    return this.mode.kind === 'rail' ? this.mode.t : -1;
  }

  /** 지금 레일의 재생 속도 */
  setSpeed(speed: number): void {
    if (this.mode.kind === 'rail') this.mode.speed = speed;
  }

  /** 지금 레일이 끝까지 가게 둔 채 남은 시간 */
  get remaining(): number {
    const m = this.mode;
    return m.kind === 'rail' ? Math.max(0, (m.rail.duration - m.t) / m.speed) : 0;
  }

  /** 게임 카메라 자세 (흔들림 없이) */
  gameplay(out: CamPose): CamPose {
    if (this.gameplayPose) return this.gameplayPose(out);
    out.position.copy(this.startPose.position);
    out.quaternion.copy(this.startPose.quaternion);
    out.fov = this.engine.settings.worldFov;
    return out;
  }

  /** 지금 자세에서 게임 카메라로 sec 동안 섞고 연출을 끝낸다 */
  blendToGameplay(sec: number): Promise<void> {
    const from = newPose();
    from.position.copy(this.pose.position);
    from.quaternion.copy(this.pose.quaternion);
    from.fov = this.pose.fov;
    const prev = this.mode;
    if (prev.kind === 'rail' || prev.kind === 'blend') prev.resolve?.();
    return new Promise((resolve) => {
      this.mode = { kind: 'blend', from, t: 0, dur: Math.max(0.01, sec), resolve };
    });
  }

  /** 화면 흔들림 (amp 0~1, 큰 충격은 1) */
  shake(amp: number, decay = 2.5): void {
    this.shakeAmp = Math.min(1.5, Math.max(this.shakeAmp, amp));
    this.shakeDecay = decay;
  }

  /** 비틀거림: 카메라를 옆으로 기울였다가 돌아온다 */
  staggerKick(roll: number): void {
    this.staggerVel += roll * 9;
  }

  update(dt: number): void {
    if (this.paused()) dt = 0;
    this.time += dt;
    const cam = this.engine.camera;
    const m = this.mode;
    if (m.kind === 'rail') {
      m.t += dt * m.speed;
      m.rail.sample(m.t, this.pose);
      if (m.t >= m.rail.duration && m.resolve) {
        const r = m.resolve;
        m.resolve = null;
        r();
      }
    } else if (m.kind === 'track') {
      m.t += dt;
      m.fn(m.t, this.pose);
    } else if (m.kind === 'blend') {
      m.t += dt;
      const k = Math.min(1, m.t / m.dur);
      const s = k * k * (3 - 2 * k);
      const target = this.gameplay(newPose());
      this.pose.position.lerpVectors(m.from.position, target.position, s);
      this.pose.quaternion.slerpQuaternions(m.from.quaternion, target.quaternion, s);
      this.pose.fov = THREE.MathUtils.lerp(m.from.fov, target.fov, s);
      if (k >= 1) {
        const r = m.resolve;
        this.end();
        r?.();
      }
    }

    if (this.active) {
      cam.position.copy(this.pose.position);
      cam.quaternion.copy(this.pose.quaternion);
      if (Math.abs(this.pose.fov - this.appliedFov) > 1e-3) {
        cam.fov = this.pose.fov;
        cam.updateProjectionMatrix();
        this.appliedFov = this.pose.fov;
      }
    }

    // 흔들림 (부드러운 잡음: 서로 다른 주파수의 사인 합)
    this.shakeAmp *= Math.exp(-this.shakeDecay * dt);
    if (this.shakeAmp < 0.002) this.shakeAmp = 0;
    const a = Math.max(this.shakeAmp, this.rumble);
    const t = this.time;
    // 비틀거림 (스프링)
    this.staggerVel += (-this.stagger * 60 - this.staggerVel * 7) * dt;
    this.stagger += this.staggerVel * dt;
    if (a > 0 || Math.abs(this.stagger) > 1e-4) {
      const n = (f: number, ph: number) => Math.sin(t * f + ph) * 0.6 + Math.sin(t * f * 2.17 + ph * 1.7) * 0.4;
      const pos = 0.035 * a;
      const rot = 0.022 * a;
      tmpQ.setFromEuler(tmpE.set(n(31, 0.3) * rot, n(27, 1.1) * rot, n(23, 2.3) * rot * 1.4 + this.stagger, 'XYZ'));
      cam.quaternion.multiply(tmpQ);
      cam.position.x += n(29, 0.7) * pos;
      cam.position.y += n(33, 1.9) * pos;
      cam.position.z += n(25, 2.9) * pos;
    }
  }
}
