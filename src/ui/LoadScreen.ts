import { t } from '../i18n';
import loadscreenCss from './loadscreen.css?inline';
import { adoptStyle } from './uiRoot';

adoptStyle('sce-load', loadscreenCss);

/**
 * 로딩 화면. 바탕 위에 옅은 그레인, 가운데 아래 제목·안내 글 한 줄, 맨 아래 가는 진행선.
 *   const load = new LoadScreen(uiContainer(), () => tracker.progress());
 *   load.open({ title: 'Level 1', tip: '...' }); await work; await load.close();
 * 깜빡임 막기: open() 뒤 SHOW_DELAY 안에 close()되면 뜨지 않는다. 한 번 뜨면 MIN_SHOWN 동안은 머문다.
 * 닫히면 FADE 동안 걷혀 바탕(보통 검은 화면)이 되고, 다음 화면이 페이드 인으로 받는다. 클릭 대기 없음.
 * 시간은 실제 시간(performance.now)으로 잰다: 읽는 동안 게임 시계가 멈춰 있어도 된다.
 * progress: 0~1 진행 (LoadTracker.progress 등). 열 때의 값을 0으로 본다 (앞 화면의 일까지 누적하는 진행값도 된다)
 */
export interface LoadScreenText {
  /** 제목 (장면 이름 등) */
  title?: string;
  /** 안내 한 줄 */
  tip?: string;
}

const SHOW_DELAY = 250;
const MIN_SHOWN = 800;
const FADE = 350;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LoadScreen {
  readonly root: HTMLDivElement;
  private readonly bar: HTMLElement;
  private readonly textEl: HTMLDivElement;
  /** open() 시각 (performance.now). 닫혀 있으면 null */
  private openedAt: number | null = null;
  /** 실제로 보인 시각 */
  private shownAt: number | null = null;
  private p0 = 0;
  private shown = 0;
  private raf = 0;
  private closing: Promise<void> | null = null;
  /** 점검용: 지금까지 실제로 보인 횟수 */
  count = 0;

  constructor(
    parent: HTMLElement,
    private readonly progress: () => number,
  ) {
    this.root = document.createElement('div');
    // 닫혀 있는 동안은 display:none (.idle): 투명하게만 숨기면 무한 애니메이션이 매 프레임 화면을 다시 그린다
    this.root.className = 'sce-load idle';
    this.root.setAttribute('role', 'status');
    this.root.innerHTML = '<div class="sl-grain"></div><div class="sl-text"></div><div class="sl-line"><b></b></div>';
    this.bar = this.root.querySelector('.sl-line b') as HTMLElement;
    this.textEl = this.root.querySelector('.sl-text') as HTMLDivElement;
    parent.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.openedAt !== null;
  }

  open(text: LoadScreenText = {}): void {
    if (this.openedAt !== null) return;
    this.closing = null;
    this.openedAt = performance.now();
    this.shownAt = null;
    this.p0 = this.progress();
    this.shown = 0;
    this.bar.style.transform = 'scaleX(0)';
    const title = text.title ?? t('common.loading');
    this.textEl.innerHTML = `<b>${esc(title)}</b>${text.tip ? `<small>${esc(text.tip)}</small>` : ''}`;
    this.root.classList.remove('idle', 'on');
    const tick = () => {
      if (this.openedAt === null) return;
      const now = performance.now();
      if (this.shownAt === null && now - this.openedAt >= SHOW_DELAY) {
        this.shownAt = now;
        this.count++;
        this.root.classList.add('on');
      }
      const p = Math.max(0, Math.min(1, (this.progress() - this.p0) / Math.max(1e-6, 1 - this.p0)));
      // 진행선은 줄어들지 않고 부드럽게 따라간다
      this.shown += (Math.max(this.shown, p) - this.shown) * 0.2;
      this.bar.style.transform = `scaleX(${this.shown.toFixed(4)})`;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** 닫는다. 보였으면 최소 시간만큼 머문 뒤 걷힌다. 다 걷히면 resolve */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.openedAt === null) return Promise.resolve();
    this.closing = (async () => {
      if (this.shownAt !== null) {
        const left = MIN_SHOWN - (performance.now() - this.shownAt);
        this.bar.style.transform = 'scaleX(1)';
        if (left > 0) await sleep(left);
        this.root.classList.remove('on');
        await sleep(FADE);
      }
      cancelAnimationFrame(this.raf);
      this.openedAt = null;
      this.shownAt = null;
      this.root.classList.add('idle');
    })();
    return this.closing;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.root.remove();
  }
}
