import type * as THREE from 'three';
import type { Level } from '../level/Level';
import { CameraRail, type CamPose } from './CameraRail';
import type { CameraDirector } from './CameraDirector';

/**
 * 컷 묶음 실행기: 컷(Shot) 목록을 차례로 찍는다. 컷마다 카메라(레일·추적·고정)와 시작 훅, 길이를 정한다.
 *   const runner = new ShotRunner(cine);
 *   await runner.run([
 *     { name: 'wide', rail: level.findRail(['intro_wide']) },
 *     { name: 'close', track: (t, out) => follow(hero, out), duration: 2.5, onStart: () => hero.gesture('wave') },
 *   ], { skip: () => hold.fired });
 *   await cine.blendToGameplay(0.8);
 * - 레일 컷은 레일 길이만큼(duration을 주면 그만큼, speed로 맞춘다), 추적·고정 컷은 duration만큼.
 * - skip()이 참이 되면 지금 컷을 끝내고 다음 컷으로 넘어간다 (skipAll이면 남은 컷을 모두 건너뛴다).
 * - cancel()은 기다리던 컷을 끝내고 run을 CancelledShots로 거부한다 (화면을 걷을 때).
 * 시간은 CameraDirector.clock(엔진 update dt의 합)으로 흐른다: 일시정지하면 컷도 멈춘다. CameraDirector를 engine.add로 붙여 둔다.
 */
export interface Shot {
  name: string;
  /** 카메라 레일 (Level.rails의 데이터 또는 CameraRail) */
  rail?: CameraRail | import('../level/Level').CamRailData | null;
  /** 매 프레임 자세를 정하는 함수 */
  track?: (t: number, out: CamPose) => void;
  /** 고정 자세 */
  hold?: CamPose;
  /** 고정 자세 대신 from → to를 바라본다 */
  look?: { from: THREE.Vector3; to: THREE.Vector3; fov?: number };
  /** 컷 길이(초). 레일이면 기본은 레일 길이, 아니면 기본 2초 */
  duration?: number;
  /** 컷이 시작될 때 */
  onStart?: () => void;
  /** 컷이 끝날 때 (건너뛰어도) */
  onEnd?: () => void;
}

export class CancelledShots extends Error {
  constructor() {
    super('shots cancelled');
  }
}

export class ShotRunner {
  private cancelled = false;
  private wake: (() => void) | null = null;
  /** 지금 찍는 컷 이름 (점검용) */
  current: string | null = null;

  constructor(private readonly cine: CameraDirector) {}

  /** 레벨의 레일 이름들로 컷을 만든다 (findRail 규칙: 정확히 같은 이름 → 포함하는 이름) */
  static fromLevel(level: Level, names: string[]): Shot[] {
    const out: Shot[] = [];
    for (const n of names) {
      const r = level.findRail([n]);
      if (r) out.push({ name: n, rail: r });
      else console.warn(`[shots] 레일 ${n} 없음`);
    }
    return out;
  }

  async run(shots: Shot[], opts: { skip?: () => boolean; skipAll?: () => boolean } = {}): Promise<void> {
    this.cancelled = false;
    for (const shot of shots) {
      if (this.cancelled) throw new CancelledShots();
      if (opts.skipAll?.()) break;
      this.current = shot.name;
      shot.onStart?.();
      const dur = this.start(shot);
      await this.wait(dur, opts.skip);
      shot.onEnd?.();
      if (this.cancelled) throw new CancelledShots();
    }
    this.current = null;
  }

  /** 기다리던 컷을 끝내고 run을 거부한다 */
  cancel(): void {
    this.cancelled = true;
    this.wake?.();
  }

  private start(shot: Shot): number {
    const c = this.cine;
    if (shot.rail) {
      const rail = shot.rail instanceof CameraRail ? shot.rail : CameraRail.from(shot.rail);
      const speed = shot.duration && rail.duration > 0 ? rail.duration / shot.duration : 1;
      void c.play(rail, { speed });
      return shot.duration ?? rail.duration;
    }
    if (shot.track) c.track(shot.track);
    else if (shot.look) c.look(shot.look.from, shot.look.to, shot.look.fov ?? c.pose.fov);
    else c.hold(shot.hold);
    return shot.duration ?? 2;
  }

  /** 연출 시계(CameraDirector.clock)로 sec초 (skip이 참이면 바로 끝) */
  private wait(sec: number, skip?: () => boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const end = this.cine.clock + sec;
      let raf = 0;
      const done = () => {
        cancelAnimationFrame(raf);
        this.wake = null;
        resolve();
      };
      this.wake = done;
      const tick = () => {
        if (this.cine.clock >= end || this.cancelled || skip?.()) return done();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
  }
}
