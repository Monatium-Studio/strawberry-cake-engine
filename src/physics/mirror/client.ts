import RAPIER from '@dimforge/rapier3d-compat';
import type { ControllerParams, FromWorker, GravityParams, MirrorSnap, ToWorker } from './protocol';

/** 메인 컨트롤러 설정을 그대로 읽어 워커 거울 컨트롤러에 옮길 값 */
export function controllerParams(c: RAPIER.KinematicCharacterController): ControllerParams {
  const up = c.up();
  return {
    offset: c.offset(),
    up: { x: up.x, y: up.y, z: up.z },
    maxSlopeClimbAngle: c.maxSlopeClimbAngle(),
    minSlopeSlideAngle: c.minSlopeSlideAngle(),
    autostep: c.autostepEnabled() ? { maxHeight: c.autostepMaxHeight() ?? 0, minWidth: c.autostepMinWidth() ?? 0, includeDynamic: !!c.autostepIncludesDynamicBodies() } : null,
    snapToGround: c.snapToGroundEnabled() ? (c.snapToGroundDistance() ?? 0) : null,
    slide: c.slideEnabled(),
    normalNudgeFactor: c.normalNudgeFactor(),
  };
}

export type MirrorResult = Extract<FromWorker, { type: 'result' }>;

/**
 * 물리 거울 워커 하나 (mirror.worker.ts). 띄우고 init을 보낸 뒤 'ready'를 받으면 ready.
 * 실패(워커 오류·init 실패·묶음 오류)는 onFail로 한 번 알린다. 그 뒤로는 보내지 않는다.
 */
export class MirrorClient {
  private worker: Worker | null = null;
  ready = false;
  failed: string | null = null;
  onReady: (() => void) | null = null;
  onResult: ((r: MirrorResult) => void) | null = null;
  onFail: ((why: string) => void) | null = null;

  constructor(init: { controller: ControllerParams; gravity: GravityParams; timestep: number; queryFlags: number; queryGroups: number; debugHits?: boolean }) {
    try {
      const w = new Worker(new URL('./mirror.worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'ready') {
          this.ready = true;
          this.onReady?.();
        } else if (m.type === 'result') this.onResult?.(m);
        else this.fail(m.error);
      };
      w.onerror = (e) => this.fail(e.message || 'mirror worker error');
      w.onmessageerror = () => this.fail('mirror worker message error');
      const msg: ToWorker = { type: 'init', ...init };
      w.postMessage(msg);
    } catch (e) {
      this.fail(String((e as Error)?.message ?? e));
    }
  }

  private fail(why: string): void {
    if (this.failed) return;
    this.failed = why;
    this.ready = false;
    this.worker?.terminate();
    this.worker = null;
    this.onFail?.(why);
  }

  send(id: number, steps: { snap: MirrorSnap; moves: Float64Array }[], actors: Float64Array): boolean {
    if (!this.worker || !this.ready) return false;
    const msg: ToWorker = { type: 'batch', id, steps, actors };
    try {
      this.worker.postMessage(msg, [...steps.map((s) => s.moves.buffer), actors.buffer]);
      return true;
    } catch (e) {
      this.fail(String((e as Error)?.message ?? e));
      return false;
    }
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.onReady = this.onResult = null;
    this.onFail = null;
  }
}
