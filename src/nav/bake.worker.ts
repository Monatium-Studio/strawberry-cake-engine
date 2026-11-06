import Recast from '@recast-navigation/wasm';
import { Raw, init } from '@recast-navigation/core';
import { TileRasterizer, type BakeReply, type BakeRequest } from './generate';

/**
 * 내비 타일 굽기 워커. 메인이 타일을 나눠 보내면 압축 층 바이트를 돌려준다 (index.ts의 rasterizeParallel).
 * WASM은 워커마다 따로 읽는다 (약 1 MB, 첫 요청 때).
 */

let ready: Promise<number> | null = null;

self.onmessage = async (e: MessageEvent<BakeRequest>) => {
  const req = e.data;
  try {
    const t0 = performance.now();
    ready ??= init(Recast).then(() => performance.now() - t0);
    const initMs = await ready;
    const s = performance.now();
    const r = new TileRasterizer(req.positions, req.indices, req.config, req.solids);
    const blobs: Uint8Array[] = [];
    for (let i = 0; i < req.tiles.length; i += 2) blobs.push(...r.rasterize(req.tiles[i], req.tiles[i + 1]));
    r.destroy();
    const reply: BakeReply = { id: req.id, blobs, ms: performance.now() - s, initMs, heap: (Raw.Module?.HEAPU8?.length as number | undefined) ?? 0 };
    (self as unknown as Worker).postMessage(reply, blobs.map((b) => b.buffer as ArrayBuffer));
  } catch (err) {
    const reply: BakeReply = { id: req.id, error: String((err as Error)?.stack ?? err) };
    (self as unknown as Worker).postMessage(reply);
  }
};
