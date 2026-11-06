import type { Engine } from '../core/Engine';
import { registerStrings, t } from '../i18n';
import screenshotCss from './screenshot.css?inline';
import type { ShotEncodeReply, ShotEncodeRequest } from './screenshot.worker';
import { adoptStyle } from './uiRoot';

adoptStyle('screenshot', screenshotCss);

/**
 * 스크린샷: Ctrl+Alt+Shift+P (맥 ⌘⌥⇧P). 지금 보이는 화면 그대로(3D + HUD·자막·메뉴 같은 DOM 층) PNG로 내려받는다.
 *
 * - 3D: Engine.afterNextRender로 렌더 바로 뒤(같은 프레임)에 WebGL 캔버스를 2D 캔버스로 옮긴다.
 *   preserveDrawingBuffer는 켜지 않는다.
 * - DOM: modern-screenshot(MIT)이 #game을 SVG foreignObject로 그린다. 처음 찍을 때 불러온다.
 *   WebGL 캔버스는 복제에서 빼고 같은 자리에 찍은 프레임 <img>를 넣는다. 캔버스의 CSS filter·불투명도를 옮기므로
 *   캔버스 흐림 연출, 일시정지 화면의 backdrop-filter, mix-blend-mode 층이 화면과 같게 섞인다.
 *   DOM 복제는 그 프레임의 마이크로태스크 안에서 끝나므로 3D와 HUD가 같은 순간이다.
 *   보이지 않는 층(display:none, opacity 0)은 복제하지 않는다.
 * - 크기: 캔버스 실제 픽셀(devicePixelRatio·렌더 배율), 최소 1280×720.
 * - 섬광은 복제가 끝난 뒤, 토스트는 내려받은 뒤에 띄우고 다음 스크린샷에서도 뺀다 (.shot-ui). 찍는 중과 직후 0.5초는 다시 눌러도 무시한다.
 * - PNG 인코딩은 워커에서 한다 (메인 스레드 멈춤은 DOM 복제 수십 ms).
 * - 평소 프레임 비용 없음: 키를 누를 때만 일한다.
 */

registerStrings({
  'shot.saved': { ko: '스크린샷 저장됨', en: 'Screenshot saved', ja: 'スクリーンショットを保存しました' },
  'shot.failed': { ko: '스크린샷을 저장하지 못했습니다', en: 'Screenshot failed', ja: 'スクリーンショットを保存できませんでした' },
});

const MIN_W = 1280;
const MIN_H = 720;
const COOLDOWN_MS = 500;
/** 3D 캔버스에서 찍은 프레임 <img>로 옮길 CSS (나머지 배치는 offset 상자로) */
const CANVAS_LOOK = ['filter', 'opacity', 'visibility', 'transform', 'transform-origin', 'mix-blend-mode', 'z-index', 'clip-path', 'image-rendering'];

type Lib = typeof import('modern-screenshot');
let lib: Promise<Lib> | null = null;
const loadLib = (): Promise<Lib> => (lib ??= import('modern-screenshot'));

/** 맥이면 ⌘, 아니면 Ctrl (navigator.userAgentData.platform → navigator.platform) */
export function isMacPlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform || nav.platform || '';
  return /mac|iphone|ipad|ipod/i.test(p);
}

/** Ctrl+Alt+Shift+P (맥 ⌘⌥⇧P). 맥에서 Option은 e.key를 바꾸므로 e.code로 본다 */
export function isScreenshotCombo(e: KeyboardEvent): boolean {
  return e.code === 'KeyP' && e.shiftKey && e.altKey && (isMacPlatform() ? e.metaKey : e.ctrlKey);
}

export interface ShotResult {
  name: string;
  width: number;
  height: number;
  /** 키를 누른 뒤 찍힌 순간(그 프레임 렌더)까지 */
  atMs: number;
  /** 키를 누른 뒤 파일이 나올 때까지 */
  ms: number;
  /** DOM 층을 못 그려 3D만 담았는지 */
  frameOnly: boolean;
}

declare global {
  interface Window {
    /** 점검용: __screenshot.take(), __screenshot.last */
    __screenshot?: { take: () => Promise<ShotResult | null>; last: ShotResult | null };
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 파일 이름 앞부분 (installScreenshot의 prefix) */
let filePrefix = 'screenshot';

/** <prefix>_20260101-142530.png (지역 시각) */
function fileName(d: Date): string {
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${filePrefix.replace(/\s+/g, '_')}_${stamp}.png`;
}

function canvasBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
}

/**
 * PNG 인코더. 게임 중에는 메인 스레드에 유휴 시간이 없어 canvas.toBlob이 인코딩을 메인 스레드에서 한꺼번에 처리하며
 * 0.3~0.9초 멈췄다. 워커(OffscreenCanvas.convertToBlob)로 넘기고, 워커를 못 쓰면 toBlob으로 돌아간다. 찍을 때마다 만들고 닫는다
 */
class PngEncoder {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();

  constructor() {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return;
    try {
      this.worker = new Worker(new URL('./screenshot.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<ShotEncodeReply>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if ('blob' in e.data) p.resolve(e.data.blob);
        else p.reject(new Error(e.data.error));
      };
      this.worker.onerror = () => this.fail(new Error('encoder worker failed'));
    } catch {
      this.worker = null;
    }
  }

  async encode(c: HTMLCanvasElement): Promise<Blob> {
    const w = this.worker;
    if (w) {
      try {
        const bitmap = await createImageBitmap(c);
        return await new Promise<Blob>((resolve, reject) => {
          const id = ++this.seq;
          this.pending.set(id, { resolve, reject });
          w.postMessage({ id, bitmap } satisfies ShotEncodeRequest, [bitmap]);
        });
      } catch (e) {
        console.warn('[screenshot] 워커 인코딩 실패, toBlob으로', e);
      }
    }
    return canvasBlob(c);
  }

  close(): void {
    this.fail(new Error('encoder closed'));
    this.worker?.terminate();
    this.worker = null;
  }

  private fail(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}

function blobDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/** 내려받기 링크는 게임 UI 안(parent: 섀도 루트의 화면 상자)에 잠깐 붙였다 뗀다: 문서 본문은 건드리지 않는다 */
function download(blob: Blob, name: string, parent: HTMLElement): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  a.className = 'shot-ui';
  parent.appendChild(a);
  a.click();
  a.remove();
  // 바로 풀면 내려받기가 끊기는 브라우저가 있다
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

interface CanvasLook {
  left: number;
  top: number;
  width: number;
  height: number;
  css: [string, string][];
}

function readLook(c: HTMLCanvasElement): CanvasLook | null {
  const cs = getComputedStyle(c);
  if (cs.display === 'none') return null;
  return { left: c.offsetLeft, top: c.offsetTop, width: c.offsetWidth, height: c.offsetHeight, css: CANVAS_LOOK.map((p) => [p, cs.getPropertyValue(p)]) };
}

class Screenshot {
  private busy = false;
  private readyAt = 0;
  private swallowKeyUp = false;
  last: ShotResult | null = null;

  constructor(private readonly engine: Engine) {
    // 캡처 단계에서 가장 먼저 받아 다른 바인딩(연출 넘기기, 메뉴, 게임 조작)에 닿지 않게 한다. 포인터 락·일시정지는 건드리지 않는다
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!isScreenshotCombo(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.swallowKeyUp = true;
    if (e.repeat) return;
    void this.take();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code !== 'KeyP' || !this.swallowKeyUp) return;
    this.swallowKeyUp = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  /** 한 장 찍어 내려받는다. 찍는 중이거나 직후면 null */
  async take(): Promise<ShotResult | null> {
    const t0 = performance.now();
    if (this.busy || t0 < this.readyAt) return null;
    this.busy = true;
    const name = fileName(new Date());
    try {
      const { blob, width, height, frameOnly, at } = await this.capture();
      download(blob, name, this.engine.container);
      this.last = { name, width, height, atMs: Math.round(at - t0), ms: Math.round(performance.now() - t0), frameOnly };
      this.toast(t('shot.saved'), name);
      return this.last;
    } catch (e) {
      console.error('[screenshot]', e);
      this.toast(t('shot.failed'), '', true);
      return null;
    } finally {
      this.busy = false;
      this.readyAt = performance.now() + COOLDOWN_MS;
    }
  }

  private async capture(): Promise<{ blob: Blob; width: number; height: number; frameOnly: boolean; at: number }> {
    const ms = await loadLib().catch((e) => {
      lib = null;
      throw e;
    });
    const root = this.engine.container;
    const gl = this.engine.renderer.domElement;
    const box = root.getBoundingClientRect();
    const cssW = Math.max(1, box.width);
    const cssH = Math.max(1, box.height);
    // 캔버스 실제 픽셀 크기 (DPR·렌더 배율), 최소 1280×720
    const scale = Math.max(gl.width / cssW, MIN_W / cssW, MIN_H / cssH);

    const frame = document.createElement('canvas');
    let look: CanvasLook | null = null;
    let at = 0;
    let frameUrl: Promise<string> | null = null;
    const keep = (n: Node): boolean => {
      if (n === gl) return false;
      if (!(n instanceof Element)) return true;
      if (n.classList.contains('shot-ui')) return false;
      // 보이지 않는 층은 복제하지 않는다 (opacity는 자식까지 덮으니 통째로 뺀다)
      const cs = getComputedStyle(n);
      return cs.display !== 'none' && cs.opacity !== '0';
    };
    const context = await ms.createContext(root, {
      width: cssW,
      height: cssH,
      scale,
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#000',
      filter: keep,
      timeout: 8000,
      features: { restoreScrollPosition: true },
      // 복제가 끝나면(화면이 정해졌으니 섬광을 띄워도 된다) 3D 캔버스 자리에 찍은 프레임을 넣는다 (같은 순서·같은 CSS)
      onCloneNode: async (clone) => {
        this.flash();
        if (!look || !frameUrl || !(clone instanceof HTMLElement)) return;
        const before = gl.parentNode === root ? (clone.childNodes[clonedIndex(gl, keep)] ?? null) : clone.firstChild;
        const img = clone.ownerDocument.createElement('img');
        const s = img.style;
        s.position = 'absolute';
        s.left = `${look.left}px`;
        s.top = `${look.top}px`;
        s.width = `${look.width}px`;
        s.height = `${look.height}px`;
        s.display = 'block';
        s.margin = '0';
        s.maxWidth = 'none';
        for (const [p, v] of look.css) if (v) s.setProperty(p, v);
        clone.insertBefore(img, before);
        img.src = await frameUrl;
      },
    });

    const png = new PngEncoder();
    try {
      // 렌더 바로 뒤에 3D를 옮기고 같은 자리에서 DOM 복제를 시작한다 (복제는 이 프레임의 마이크로태스크에서 끝난다)
      let cancelled = false;
      const rendered = await new Promise<{ dom: Promise<HTMLCanvasElement> }>((resolve, reject) => {
        const timer = setTimeout(() => {
          cancelled = true;
          reject(new Error('no frame rendered'));
        }, 3000);
        this.engine.afterNextRender((src) => {
          if (cancelled) return;
          clearTimeout(timer);
          at = performance.now();
          frame.width = src.width;
          frame.height = src.height;
          frame.getContext('2d')?.drawImage(src, 0, 0);
          look = readLook(src);
          frameUrl = look ? png.encode(frame).then(blobDataUrl) : null;
          frameUrl?.catch(() => undefined); // 실패는 onCloneNode가 받는다
          resolve({ dom: ms.domToCanvas(context) });
        });
      });
      let out: HTMLCanvasElement;
      let frameOnly = false;
      try {
        out = await rendered.dom;
      } catch (e) {
        // DOM 층을 못 그리면 3D만이라도 남긴다
        console.warn('[screenshot] DOM 층을 그리지 못해 3D만 저장한다', e);
        out = frame;
        frameOnly = true;
      }
      return { blob: await png.encode(out), width: out.width, height: out.height, frameOnly, at };
    } finally {
      ms.destroyContext(context);
      png.close();
    }
  }

  private flash(): void {
    const el = document.createElement('div');
    el.className = 'shot-ui shot-flash';
    this.engine.container.appendChild(el);
    setTimeout(() => el.remove(), 400);
  }

  private toast(text: string, sub: string, fail = false): void {
    for (const old of this.engine.container.querySelectorAll('.shot-toast')) old.remove();
    const el = document.createElement('div');
    el.className = `shot-ui shot-toast${fail ? ' fail' : ''}`;
    el.textContent = text;
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      el.appendChild(s);
    }
    this.engine.container.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }
}

/** 복제본에서 node가 들어갈 자리: 앞 형제 중 복제되는 것(주석·style·script·filter로 빠진 것 제외)의 수 */
function clonedIndex(node: Node, keep: (n: Node) => boolean): number {
  let i = 0;
  for (let n = node.parentNode?.firstChild ?? null; n && n !== node; n = n.nextSibling) {
    if (n.nodeType === Node.COMMENT_NODE) continue;
    if (n instanceof HTMLStyleElement || n instanceof HTMLScriptElement) continue;
    if (keep(n)) i++;
  }
  return i;
}

let installed: Screenshot | null = null;

/**
 * 스크린샷 단축키를 건다. 다른 keydown 처리보다 먼저 받도록 엔진을 만든 직후에 부른다.
 * prefix: 내려받는 파일 이름 앞부분 (게임 이름 등)
 */
export function installScreenshot(engine: Engine, opts: { prefix?: string } = {}): void {
  if (opts.prefix) filePrefix = opts.prefix;
  if (installed) return;
  installed = new Screenshot(engine);
  const shot = installed;
  window.__screenshot = {
    take: () => shot.take(),
    get last() {
      return shot.last;
    },
  };
}
