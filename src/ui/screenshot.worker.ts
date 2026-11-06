/**
 * 스크린샷 PNG 인코딩 워커 (Screenshot.ts). 게임 중에는 메인 스레드에 유휴 시간이 없어서 canvas.toBlob의 PNG 인코딩이
 * 한꺼번에 메인 스레드에서 돌아 0.3~0.9초 멈췄다. 비트맵을 넘겨받아 여기서 인코딩한다.
 */

export interface ShotEncodeRequest {
  id: number;
  bitmap: ImageBitmap;
}

export type ShotEncodeReply = { id: number; blob: Blob } | { id: number; error: string };

const post = (r: ShotEncodeReply) => (self as unknown as Worker).postMessage(r);

self.onmessage = async (e: MessageEvent<ShotEncodeRequest>) => {
  const { id, bitmap } = e.data;
  try {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = c.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    post({ id, blob: await c.convertToBlob({ type: 'image/png' }) });
  } catch (err) {
    post({ id, error: String(err) });
  }
};
