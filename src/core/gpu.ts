import * as THREE from 'three';

/**
 * GPU 자원 장부. 렌더러가 GPU에 올린 형상·재질·텍스처·렌더 타깃을 모두 기억했다가 sweepGpu()에서 한꺼번에 놓는다.
 * 게임은 같은 페이지에서 화면(메뉴 ↔ 레벨)을 오간다(페이지를 새로 읽지 않는다: core/flow.ts). 한 화면이 올린 것을 다음 화면 전에
 * 놓지 않으면, dispose 없이 버려진 자원(모듈 캐시, 준비만 하고 쓰지 않은 레벨, 버린 장면)이 판마다 GPU에 쌓인다.
 *
 * 알아내는 법: three는 자원을 처음 올릴 때 그 자원에 'dispose' 듣기를 걸고(WebGLGeometries·WebGLTextures·WebGLRenderer.getProgram),
 * dispose되면 뗀다. EventDispatcher의 addEventListener·removeEventListener를 감싸 그 순간을 적는다.
 * 놓은 자원을 다시 쓰면 three가 다시 올린다 (형상·텍스처는 다시 업로드, 재질은 다시 컴파일): 모듈 캐시의 공유 재질도 안전하다.
 */

type Res = THREE.EventDispatcher<object> & { dispose(): void };

const live = new Set<Res>();

function isGpu(o: unknown): o is Res {
  const x = o as { isBufferGeometry?: boolean; isMaterial?: boolean; isTexture?: boolean; isRenderTarget?: boolean };
  return !!(x.isBufferGeometry || x.isMaterial || x.isTexture || x.isRenderTarget);
}

const proto = THREE.EventDispatcher.prototype as unknown as {
  addEventListener(type: string, fn: unknown): void;
  removeEventListener(type: string, fn: unknown): void;
  hasEventListener(type: string, fn: unknown): boolean;
  __gpuLedger?: boolean;
  _listeners?: Record<string, unknown[]>;
};

if (!proto.__gpuLedger) {
  proto.__gpuLedger = true;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  proto.addEventListener = function (this: typeof proto, type: string, fn: unknown) {
    add.call(this, type, fn);
    if (type === 'dispose' && isGpu(this)) live.add(this as unknown as Res);
  };
  proto.removeEventListener = function (this: typeof proto, type: string, fn: unknown) {
    remove.call(this, type, fn);
    if (type === 'dispose' && isGpu(this) && !(this as typeof proto)._listeners?.dispose?.length) live.delete(this as unknown as Res);
  };
}

/** 지금 GPU에 올라 있는 자원 수 (점검용) */
export function gpuLive(): number {
  return live.size;
}

/**
 * 장부의 자원을 모두 놓는다 (화면을 바꿀 때: Engine.reset 뒤). keep에 든 것은 남긴다.
 * 다음 화면이 다시 쓰는 것은 three가 다시 올린다. 놓은 수를 돌려준다
 */
export function sweepGpu(keep: ReadonlySet<unknown> = new Set()): number {
  let n = 0;
  for (const r of [...live]) {
    if (keep.has(r)) continue;
    live.delete(r);
    try {
      r.dispose();
      n++;
    } catch (e) {
      console.warn('[gpu] dispose 실패', e);
    }
  }
  return n;
}
