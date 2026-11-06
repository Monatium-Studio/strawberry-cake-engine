import { t } from '../i18n';
import { adoptStyle } from '../ui/uiRoot';
import introCss from './intro.css?inline';
import { creditsCard } from './credits';

adoptStyle('sce-intro', introCss);

/**
 * 게임 인트로: 로고 카드를 차례로 보여 주고 타이틀로 넘어간다.
 *
 * 첫 카드는 언제나 엔진의 「Produced by MONATIUM STUDIO · Powered by STRAWBERRY CAKE ENGINE」이다 (빼거나 순서를 바꿀 수 없다).
 * 게임은 그 뒤에 자기 카드(퍼블리셔·위원회 같은 로고)를 붙인다.
 *
 *   const intro = new Intro(uiContainer(), { cards: [committeeCard], onCue: (cue) => audio.sting(cue) });
 *   await intro.play();   // 타이틀로 넘어가는 페이드까지 끝나면 돌아온다
 *
 * - 카드 = 무대(stage) 좌표계의 레이어 이미지들. 레이어는 <img>로 불러 준비 단계(검은 화면)에서 지금 화면 크기의 canvas로 미리 그린다.
 *   조명 필터가 든 SVG는 처음 그릴 때 메인 스레드에서 수백 ms가 걸려, 미리 그려 두지 않으면 카드 첫머리가 끊긴다.
 * - 애니메이션은 레이어의 transform/opacity만 바꾼다 (합성기에서 돌아 메인 스레드가 로딩으로 바빠도 끊기지 않는다).
 *   레이어 요소의 클래스는 `L L-<레이어 id>`, 카드는 `sce-intro-card sce-intro-card--<카드 id>`, 보이는 동안 `is-active`.
 *   카드 CSS는 IntroCard.css로 넘기면 UI 루트에 붙는다.
 * - 클릭이나 아무 키: 지금 카드를 넘긴다. Esc: 전부 건너뛴다. Ctrl·Cmd·Alt 조합과 F1~F12는 건드리지 않는다.
 * - prefers-reduced-motion이면 움직임 없이 페이드만 한다.
 * 설계: docs/INTRO.md
 */

/** 무대 좌표의 레이어 하나 */
export interface IntroLayer {
  /** CSS 클래스 L-<id>로 쓰인다 */
  id: string;
  /** 이미지 주소 (SVG 권장) */
  url: string;
  /** [x, y, 너비, 높이] (무대 좌표) */
  box: [number, number, number, number];
  /** 회전·확대 기준점 (무대 좌표) */
  origin: [number, number];
}

export interface IntroCard {
  /** 카드 id: CSS 클래스 sce-intro-card--<id>, onCue·phase 이름. 'title'·'loading'·'done'은 쓸 수 없다 */
  id: string;
  /** 화면 낭독기용 이름 */
  label: string;
  /** 무대 크기 [너비, 높이]. 무대는 화면 가운데에 비율을 지켜 놓인다 */
  stage: [number, number];
  layers: IntroLayer[];
  /** 앞쪽에 겹쳐 지나가는 광택 띠의 마스크 (무대 크기 이미지). 띠 움직임은 카드 CSS의 .sce-intro-sheen__band에 준다 */
  sheen?: string;
  /** 머무는 시간 (기본 3000 ms) */
  holdMs?: number;
  /** 무대 높이 CSS (기본 'min(60cqh, 34cqw)') */
  height?: string;
  /** 이 카드의 CSS (UI 루트에 한 번 붙는다) */
  css?: string;
}

export type IntroPhase = 'loading' | string | 'title' | 'done';

export interface IntroOptions {
  /** 엔진 첫 카드 뒤에 붙일 게임 카드 */
  cards?: IntroCard[];
  /** 카드가 나타날 때(카드 id)와 타이틀로 넘어갈 때('title') 호출된다. 로고 스팅·BGM 연결 지점 */
  onCue?: (cue: string) => void;
  /** 지정하지 않으면 prefers-reduced-motion을 따른다 */
  reducedMotion?: boolean;
}

declare global {
  interface Window {
    /** 점검용 */
    __intro?: Intro;
  }
}

/** 카드 퇴장(페이드아웃), 카드 사이 검은 화면, 타이틀로 넘어가는 페이드 */
const LEAVE_MS = 520;
const LEAVE_FAST_MS = 260;
const GAP_MS = 260;
const OUTRO_MS = 700;
/** 레이어 이미지 준비를 기다리는 최대 시간 */
const PREPARE_TIMEOUT_MS = 2500;
/** 키 반복·연타로 카드가 한꺼번에 넘어가지 않게 */
const SKIP_DEBOUNCE_MS = 180;

const RESERVED = new Set(['loading', 'title', 'done']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pct = (v: number) => `${+(v * 100).toFixed(4)}%`;

function img(src: string, cls: string): HTMLImageElement {
  const el = new Image();
  el.className = cls;
  el.alt = '';
  el.decoding = 'async';
  el.draggable = false;
  el.src = src;
  return el;
}

/** 무대 좌표의 상자를 %로 배치하고, 기준점을 transform-origin으로 */
function place(el: HTMLElement, def: IntroLayer, [sw, sh]: [number, number]): void {
  const [x, y, w, h] = def.box;
  el.style.left = pct(x / sw);
  el.style.top = pct(y / sh);
  el.style.width = pct(w / sw);
  el.style.height = pct(h / sh);
  el.style.transformOrigin = `${pct((def.origin[0] - x) / w)} ${pct((def.origin[1] - y) / h)}`;
}

/** 레이어를 지금 화면 크기의 비트맵(canvas)으로 미리 그린다 */
function rasterize(im: HTMLImageElement): HTMLCanvasElement | HTMLImageElement {
  const r = im.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(r.width * dpr);
  const h = Math.round(r.height * dpr);
  if (w < 1 || h < 1 || w * h > 16e6) return im;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return im;
  try {
    ctx.drawImage(im, 0, 0, w, h);
  } catch {
    return im;
  }
  c.className = im.className;
  c.style.cssText = im.style.cssText;
  c.setAttribute('aria-hidden', 'true');
  return c;
}

function sheen(mask: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sce-intro-sheen';
  const url = `url("${mask}")`;
  el.style.setProperty('mask-image', url);
  el.style.setProperty('-webkit-mask-image', url);
  const band = document.createElement('div');
  band.className = 'sce-intro-sheen__band';
  el.append(band);
  return el;
}

/** 카드 DOM을 만들고 모든 이미지가 디코드된 뒤 비트맵으로 바꾼다 */
async function buildCard(el: HTMLElement, card: IntroCard): Promise<void> {
  const stage = document.createElement('div');
  stage.className = 'sce-intro-stage';
  stage.style.aspectRatio = `${card.stage[0]} / ${card.stage[1]}`;
  if (card.height) stage.style.height = card.height;
  const images: HTMLImageElement[] = [];
  for (const def of card.layers) {
    const im = img(def.url, `L L-${def.id}`);
    place(im, def, card.stage);
    stage.append(im);
    images.push(im);
  }
  if (card.sheen) stage.append(sheen(card.sheen));
  el.append(stage);
  await Promise.all(images.map((im) => im.decode().catch(() => {})));
  for (const im of images) {
    im.replaceWith(rasterize(im));
    await sleep(0); // 로딩 작업이 끼어들 틈
  }
}

export class Intro {
  readonly root: HTMLDivElement;
  phase: IntroPhase = 'loading';
  private readonly cards: { def: IntroCard; el: HTMLElement }[];
  private readonly order: string[];
  private readonly onCue: (cue: string) => void;
  private interrupt: (() => void) | null = null;
  private queuedSkip = false;
  private skipAllFlag = false;
  private lastSkip = -Infinity;
  private waiters: { phase: IntroPhase; ms: number; resolve: () => void }[] = [];
  private phaseStart = performance.now();

  constructor(parent: HTMLElement, opts: IntroOptions = {}) {
    this.onCue = opts.onCue ?? (() => {});
    const reduced = opts.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
    const credits = creditsCard();
    const defs = [credits, ...(opts.cards ?? []).filter((c) => c.id !== credits.id)];
    for (const c of defs) {
      if (RESERVED.has(c.id)) throw new Error(`[intro] 카드 id로 쓸 수 없다: ${c.id}`);
      if (c.css) adoptStyle(`sce-intro-card-${c.id}`, c.css);
    }
    this.order = ['loading', ...defs.map((c) => c.id), 'title', 'done'];

    this.root = document.createElement('div');
    this.root.className = 'sce-intro' + (reduced ? ' sce-intro--reduced' : '');
    this.cards = defs.map((def) => {
      const el = document.createElement('section');
      el.className = `sce-intro-card sce-intro-card--${def.id}`;
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', def.label);
      this.root.append(el);
      return { def, el };
    });
    const hint = document.createElement('div');
    hint.className = 'sce-intro-hint';
    hint.textContent = t('intro.hint');
    this.root.append(hint);
    parent.append(this.root);
    window.__intro = this;
  }

  /** 카드 id 목록 (엔진 첫 카드 포함, 재생 순서) */
  get cardIds(): string[] {
    return this.cards.map((c) => c.def.id);
  }

  /** 인트로 전체를 재생한다. 타이틀로 넘어가는 페이드까지 끝나면 resolve */
  async play(): Promise<void> {
    window.addEventListener('keydown', this.onKey, true);
    this.root.addEventListener('pointerdown', this.onPointer);
    try {
      const prepared = Promise.all(this.cards.map(({ def, el }) => buildCard(el, def).catch((e) => console.warn('[intro]', e))));
      if ((await this.hold(PREPARE_TIMEOUT_MS, prepared)) === 'skip') this.queuedSkip = true;

      for (const { def, el } of this.cards) {
        if (this.skipAllFlag) break;
        if (this.queuedSkip) {
          // 전환 중에 들어온 입력은 다음 카드를 넘긴다
          this.queuedSkip = false;
          continue;
        }
        el.classList.add('is-active');
        this.setPhase(def.id);
        this.onCue(def.id);
        const why = await this.hold(def.holdMs ?? 3000);
        const fast = why === 'skip' || this.skipAllFlag;
        el.classList.add('is-leaving');
        if (fast) el.classList.add('is-fast');
        await sleep(fast ? LEAVE_FAST_MS : LEAVE_MS);
        el.classList.remove('is-active');
        el.hidden = true;
        if (!this.skipAllFlag) await sleep(GAP_MS);
      }

      this.setPhase('title');
      this.onCue('title');
      this.root.classList.add('is-out');
      await sleep(OUTRO_MS);
    } finally {
      this.destroy();
    }
  }

  /** 지금 카드를 넘긴다 (전환 중이면 다음 카드를 넘긴다) */
  skip(): void {
    const now = performance.now();
    if (now - this.lastSkip < SKIP_DEBOUNCE_MS || this.phase === 'title' || this.phase === 'done') return;
    this.lastSkip = now;
    if (this.interrupt) this.interrupt();
    else this.queuedSkip = true;
  }

  /** 남은 인트로를 모두 건너뛰고 타이틀로 */
  skipAll(): void {
    if (this.phase === 'title' || this.phase === 'done') return;
    this.skipAllFlag = true;
    this.interrupt?.();
  }

  /** 점검용: phase에 들어간 뒤 ms가 지나면 resolve (이미 지났으면 바로) */
  waitFor(phase: IntroPhase, ms = 0): Promise<void> {
    if (this.order.indexOf(this.phase) > this.order.indexOf(phase)) return Promise.resolve();
    return new Promise((resolve) => {
      if (this.phase === phase) setTimeout(resolve, Math.max(0, ms - (performance.now() - this.phaseStart)));
      else this.waiters.push({ phase, ms, resolve });
    });
  }

  private setPhase(p: IntroPhase): void {
    this.phase = p;
    this.phaseStart = performance.now();
    this.root.dataset.phase = p;
    this.waiters = this.waiters.filter((w) => {
      if (w.phase === p) setTimeout(w.resolve, w.ms);
      else if (this.order.indexOf(w.phase) < this.order.indexOf(p)) w.resolve();
      else return true;
      return false;
    });
  }

  /** ms가 지나거나, until이 끝나거나, 입력으로 넘기면 resolve */
  private hold(ms: number, until?: Promise<unknown>): Promise<'time' | 'until' | 'skip'> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (why: 'time' | 'until' | 'skip') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.interrupt = null;
        resolve(why);
      };
      const timer = setTimeout(() => finish('time'), ms);
      until?.then(
        () => finish('until'),
        () => finish('until'),
      );
      this.interrupt = () => finish('skip');
    });
  }

  private readonly onKey = (e: KeyboardEvent) => {
    // 시스템 단축키(새로고침, 개발자 도구, 앱 전환)는 건드리지 않는다
    if (e.ctrlKey || e.metaKey || e.altKey || /^F\d{1,2}$/.test(e.key)) return;
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
    if ([' ', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
    }
    e.stopPropagation();
    if (e.repeat) return;
    if (e.key === 'Escape') this.skipAll();
    else this.skip();
  };

  private readonly onPointer = (e: PointerEvent) => {
    e.preventDefault();
    this.skip();
  };

  private destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.root.removeEventListener('pointerdown', this.onPointer);
    this.root.remove();
    this.setPhase('done');
    if (window.__intro === this) delete window.__intro;
  }
}
