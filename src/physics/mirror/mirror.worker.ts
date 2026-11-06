import RAPIER from '@dimforge/rapier3d-compat';
import { MirrorCore } from './core';
import type { FromWorker, ToWorker } from './protocol';

/** 물리 거울 워커 (protocol.ts): 거울 월드를 유지하고 캐릭터 컨트롤러 이동을 묶음으로 계산한다 */

let core: MirrorCore | null = null;
const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const init = RAPIER.init();

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    await init;
    if (msg.type === 'init') {
      core = new MirrorCore(RAPIER, msg.controller, msg.gravity, msg.timestep, msg.queryFlags, msg.queryGroups);
      core.debugHits = !!msg.debugHits;
      post({ type: 'ready' });
      return;
    }
    if (!core) throw new Error('mirror: batch before init');
    const t0 = performance.now();
    const { res, dyn, missing, hits } = core.runBatch(msg.steps, msg.actors);
    post({ type: 'result', id: msg.id, res, ms: performance.now() - t0, dyn, missing, hits }, hits ? [res.buffer, hits.buffer] : [res.buffer]);
  } catch (err) {
    post({ type: 'error', id: msg.type === 'batch' ? msg.id : undefined, error: String((err as Error)?.stack ?? err) });
  }
};
