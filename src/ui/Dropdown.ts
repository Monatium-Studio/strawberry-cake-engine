import dropdownCss from './dropdown.css?inline';
import { adoptStyle } from './uiRoot';

adoptStyle('dropdown', dropdownCss);
/** 섀도 루트 밖 페이지(개발 도구 등)에서는 칸이 문서에 붙을 때 스타일도 문서에 붙인다 (체크박스·라디오도 쓴다) */
const docSheets = new Set<string>();
export function adoptForDocument(el: Element, css: string): void {
  if (docSheets.has(css) || el.getRootNode() !== document) return;
  docSheets.add(css);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
const styleDocument = (el: Element) => adoptForDocument(el, dropdownCss);

/**
 * 드롭다운: 네이티브 <select> 대신 쓰는 엔진 UI 고르기 칸 (SettingsMenu의 언어·그래픽, 게임 화면 공용).
 * 모양은 설정 메뉴 그대로다 (dropdown.css, 색은 ui.css의 --ui-accent). 화면은 dropdownHtml()로 칸을 그리고 Dropdown.upgrade()로 살리거나, Dropdown.create()로 만든다.
 *
 * - 값: 칸은 <button role="combobox" name value>라 예전 select처럼 el.name·el.value를 읽는다. 고르면 value를 바꾸고
 *   'input'·'change'(버블)를 낸다: 예전 select에 걸던 change 리스너·위임 리스너가 그대로 돈다. 코드로 value를 바꾸면 이벤트는 없다.
 * - 마우스: 누르면 펼치고, 항목을 누르면 고른다. 밖을 누르거나 Esc면 바꾸지 않고 닫는다. hover가 강조를 옮긴다.
 * - 키보드 (닫힘): Enter·Space·↑↓ 펼치기, ←→ 앞뒤 값 (설정 줄의 밀대처럼), Home·End 처음·끝 값, 글자 첫 자로 찾기.
 *   (펼침): ↑↓ 옮기기, Home·End·PageUp·PageDown, Enter·Space 고르기, Esc 취소, Tab 닫기, 글자 첫 자로 찾기.
 *   펼친 동안 키는 칸이 먹는다 (전파를 막는다): 메뉴·게임의 ↑↓·W/S·Enter·Esc가 같이 돌지 않는다. 창 캡처 단계에서 Esc를 받는 메뉴
 *   (SettingsMenu)는 dropdownOpen()을 보고 비킨다. 닫힌 칸의 Esc·Tab은 그대로 메뉴로 간다 (뒤로·다음 칸).
 * - 소리: 엔진은 메뉴 소리를 내지 않는다. 키보드로 옮기기·고르기·취소하면 'menusound' 이벤트(detail {cue: ui_move·ui_select·ui_back, volume},
 *   버블·composed)를 올린다: 게임이 오버레이에서 듣고 자기 소리를 낸다 (마우스 hover·클릭은 칸·항목이 <button>이라 게임의 단추 소리 고리가 받는다).
 * - 펼친 목록은 가까운 오버레이(Engine.overlay, .overlay), 없으면 UI 상자(섀도 루트 맨 위 요소)·body 아래에 fixed로 띄운다:
 *   스크롤 상자·overflow:hidden·backdrop-filter 상자에 잘리지 않는다. 아래가 모자라면 위로 펼치고, 화면 너비에 맞춰 줄인다 (폰 너비).
 * - ARIA: combobox(aria-expanded·aria-controls·aria-activedescendant) / listbox / option(aria-selected·aria-disabled).
 * 게임패드: 엔진 메뉴가 게임패드를 받지 않아 칸도 받지 않는다.
 */

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface DropdownSpec {
  options: DropdownOption[];
  value: string;
  /** el.name (위임 change 리스너가 고른다) */
  name?: string;
  disabled?: boolean;
  /** 더할 class (자리별 크기 등) */
  cls?: string;
  /** 더할 속성 (data-x, title, aria-label 등) */
  attrs?: Record<string, string>;
}

/** 'menusound' 이벤트의 detail */
export interface MenuSoundDetail {
  cue: 'ui_move' | 'ui_select' | 'ui_back';
  volume: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const VOLUME: Record<MenuSoundDetail['cue'], number> = { ui_move: 0.4, ui_select: 0.6, ui_back: 0.6 };
const instances = new WeakMap<HTMLElement, Dropdown>();
let openNow: Dropdown | null = null;
let seq = 0;

/** 키보드로 옮기기·고르기·취소한 소리를 'menusound' 이벤트로 올린다 (게임이 듣는다. 체크박스·라디오도 쓴다) */
export function menuSound(el: Element, cue: MenuSoundDetail['cue']): void {
  el.dispatchEvent(new CustomEvent<MenuSoundDetail>('menusound', { bubbles: true, composed: true, detail: { cue, volume: VOLUME[cue] } }));
}

/** 지금 펼친 드롭다운이 있다 (창 캡처 단계에서 Esc를 받는 메뉴가 비킨다) */
export function dropdownOpen(): boolean {
  return !!openNow;
}

/** 칸 마크업 (innerHTML로 그리는 화면용). 그린 뒤 Dropdown.upgrade(부모)로 살린다 */
export function dropdownHtml(spec: DropdownSpec): string {
  const cur = spec.options.find((o) => o.value === spec.value) ?? spec.options[0];
  const attrs = Object.entries(spec.attrs ?? {})
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
  return `<button type="button" class="dd${spec.cls ? ` ${spec.cls}` : ''}" role="combobox" aria-haspopup="listbox" aria-expanded="false"${spec.name ? ` name="${esc(spec.name)}"` : ''} value="${esc(cur?.value ?? '')}" data-dd="${esc(JSON.stringify(spec.options))}"${spec.disabled ? ' disabled' : ''}${attrs}><span class="dd-value">${esc(cur?.label ?? '')}</span><i class="dd-caret" aria-hidden="true"></i></button>`;
}

export class Dropdown {
  /** 칸 (role=combobox 단추). name·value·disabled·focus()는 여기서 */
  readonly el: HTMLButtonElement;
  /** 고를 때 (change 이벤트와 같이) */
  onChange: ((value: string) => void) | null = null;
  private opts: DropdownOption[] = [];
  private panel: HTMLDivElement | null = null;
  private active = -1;
  private typed = '';
  private typedAt = 0;
  private spaceDown = false;
  private outsideAt = -1e9;
  private outsideTarget: Node | null = null;
  private watch: MutationObserver | null = null;
  private readonly id = `dd${++seq}`;
  private readonly offDoc: (() => void)[] = [];

  /** 마크업으로 그린 칸들을 살린다 (이미 산 칸은 그대로) */
  static upgrade(root: ParentNode): Dropdown[] {
    return [...root.querySelectorAll<HTMLButtonElement>('button.dd')].map((el) => instances.get(el) ?? new Dropdown(el));
  }

  /** 새 칸을 만든다 (DOM에 붙이는 건 부르는 쪽) */
  static create(spec: DropdownSpec): Dropdown {
    const t = document.createElement('template');
    t.innerHTML = dropdownHtml(spec);
    return new Dropdown(t.content.firstElementChild as HTMLButtonElement);
  }

  /** 칸 요소의 드롭다운 */
  static of(el: Element | null | undefined): Dropdown | undefined {
    return el ? instances.get(el as HTMLElement) : undefined;
  }

  constructor(el: HTMLButtonElement) {
    this.el = el;
    instances.set(el, this);
    try {
      this.opts = JSON.parse(el.dataset.dd || '[]') as DropdownOption[];
    } catch {
      this.opts = [];
    }
    el.removeAttribute('data-dd');
    queueMicrotask(() => styleDocument(el));
    el.addEventListener('click', (e) => {
      // 키보드 Space는 keydown에서 펼쳤다 (단추가 keyup에 내는 click은 버린다)
      if (this.spaceDown) return;
      e.stopPropagation();
      if (this.isOpen) this.close(false);
      // 펼친 동안 칸을 감싼 <label>의 글자를 눌러 닫았으면, 그 클릭이 label을 거쳐 다시 펼치지 않게
      else if (!(performance.now() - this.outsideAt < 600 && this.outsideTarget && this.el.closest('label')?.contains(this.outsideTarget))) this.open();
      this.outsideTarget = null;
    });
    el.addEventListener('keydown', (e) => this.onKey(e));
    el.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        setTimeout(() => (this.spaceDown = false));
      }
    });
    el.addEventListener('blur', () => {
      this.spaceDown = false;
      this.close(false);
    });
  }

  get value(): string {
    return this.el.value;
  }

  /** 값을 바꾼다 (이벤트 없음) */
  set value(v: string) {
    const o = this.opts.find((x) => x.value === v);
    if (!o) return;
    this.el.value = o.value;
    (this.el.querySelector('.dd-value') as HTMLElement).textContent = o.label;
    if (this.panel) this.paint();
  }

  get options(): readonly DropdownOption[] {
    return this.opts;
  }

  /** 항목을 바꾼다 (모드에 따라 맵 목록 등). 값이 없어졌으면 value 또는 첫 항목 */
  setOptions(options: DropdownOption[], value = this.value): void {
    this.opts = options.slice();
    const keep = this.opts.find((o) => o.value === value) ?? this.opts[0];
    this.el.value = keep?.value ?? '';
    (this.el.querySelector('.dd-value') as HTMLElement).textContent = keep?.label ?? '';
    if (this.panel) {
      this.build();
      this.active = this.index(this.value);
      this.paint();
      this.place();
    }
  }

  get disabled(): boolean {
    return this.el.disabled;
  }

  set disabled(v: boolean) {
    if (v) this.close(false);
    this.el.disabled = v;
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  // ------------------------------------------------------------------ 펼치기·닫기

  open(): void {
    if (this.panel || this.el.disabled || !this.opts.length) return;
    if (openNow && openNow !== this) openNow.close(false);
    openNow = this;
    styleDocument(this.el);
    // 사파리는 단추를 눌러도 포커스를 주지 않는다: 펼친 뒤 키보드가 칸으로 오게
    if ((this.el.getRootNode() as Document | ShadowRoot).activeElement !== this.el) this.el.focus({ preventScroll: true });
    const panel = document.createElement('div');
    panel.className = 'dd-panel';
    panel.id = `${this.id}-list`;
    panel.setAttribute('role', 'listbox');
    const name = this.el.getAttribute('aria-label') ?? this.el.closest('label')?.querySelector('span')?.textContent;
    if (name) panel.setAttribute('aria-label', name);
    // 펼친 목록은 칸의 글자 크기·강조색을 따라간다 (자리마다 다른 크기)
    const cs = getComputedStyle(this.el);
    panel.style.setProperty('--dd-font', cs.fontSize);
    const accent = cs.getPropertyValue('--dd-accent').trim();
    if (accent) panel.style.setProperty('--dd-accent', accent);
    // 칸을 누른 채 목록으로 끌지 않아도 포커스는 칸에 둔다 (항목을 눌러도 칸이 blur 되지 않게)
    panel.addEventListener('pointerdown', (e) => e.preventDefault());
    panel.addEventListener('mousedown', (e) => e.preventDefault());
    panel.addEventListener('pointermove', (e) => {
      const i = this.optIndex(e.target);
      if (i >= 0 && i !== this.active && !this.opts[i].disabled) {
        this.active = i;
        this.paint(false);
      }
    });
    panel.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = this.optIndex(e.target);
      if (i < 0 || this.opts[i].disabled) return;
      this.active = i;
      this.close(true);
    });
    this.panel = panel;
    this.build();
    this.layer().appendChild(panel);
    this.active = this.index(this.value);
    this.el.setAttribute('aria-expanded', 'true');
    this.el.setAttribute('aria-controls', panel.id);
    this.paint();
    this.place();
    // 밖을 누르면 닫는다 (섀도 루트 안: 루트에서 듣는다. 문서에 건 리스너는 대상이 호스트로 바뀐다)
    const root = this.el.getRootNode() as Document | ShadowRoot;
    const outside = (e: Event) => {
      const path = e.composedPath();
      if (path.includes(this.el) || path.includes(panel)) return;
      this.outsideAt = performance.now();
      this.outsideTarget = path[0] instanceof Node ? path[0] : null;
      this.close(false);
    };
    const reflow = (e: Event) => {
      if (e.target instanceof Node && panel.contains(e.target)) return;
      this.place();
    };
    root.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', reflow, true);
    root.addEventListener('scroll', reflow, true);
    window.addEventListener('resize', reflow);
    const blur = () => this.close(false);
    window.addEventListener('blur', blur);
    this.offDoc.push(
      () => root.removeEventListener('pointerdown', outside, true),
      () => window.removeEventListener('scroll', reflow, true),
      () => root.removeEventListener('scroll', reflow, true),
      () => window.removeEventListener('resize', reflow),
      () => window.removeEventListener('blur', blur),
    );
    // 칸이 사라지거나 숨으면 (화면을 다시 그림·메뉴를 닫음) 목록도 닫는다
    this.watch = new MutationObserver(() => {
      if (!this.el.isConnected || !this.el.getClientRects().length) this.close(false);
    });
    this.watch.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
  }

  /** 닫는다. commit: 강조한 항목을 고른다 (바뀌면 input·change). 소리는 부르는 쪽 (마우스는 메뉴 소리 고리가 클릭에 낸다) */
  close(commit: boolean): void {
    const panel = this.panel;
    if (!panel) return;
    this.panel = null;
    if (openNow === this) openNow = null;
    this.watch?.disconnect();
    this.watch = null;
    for (const off of this.offDoc.splice(0)) off();
    panel.remove();
    this.el.setAttribute('aria-expanded', 'false');
    this.el.removeAttribute('aria-controls');
    this.el.removeAttribute('aria-activedescendant');
    if (commit) this.pick(this.active);
  }

  // ------------------------------------------------------------------ 키보드

  private onKey(e: KeyboardEvent): void {
    if (this.el.disabled) return;
    const k = e.code;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (this.panel) {
      if (k === 'ArrowDown' && e.altKey) this.close(true);
      else if (k === 'ArrowUp' && e.altKey) this.close(true);
      else if (k === 'ArrowDown') this.move(1);
      else if (k === 'ArrowUp') this.move(-1);
      else if (k === 'Home') this.moveTo(this.edge(1));
      else if (k === 'End') this.moveTo(this.edge(-1));
      else if (k === 'PageDown') this.move(8);
      else if (k === 'PageUp') this.move(-8);
      else if (k === 'Enter' || k === 'NumpadEnter' || k === 'Space') {
        if (k === 'Space') this.spaceDown = true;
        this.sound('ui_select');
        this.close(true);
      } else if (k === 'Escape') {
        this.close(false);
        this.sound('ui_back');
      } else if (k === 'Tab') {
        this.close(false);
        handled = false;
      } else if (!mod && e.key.length === 1) {
        const i = this.find(e.key);
        if (i >= 0) this.moveTo(i);
      } else if (mod || e.altKey) handled = false;
      // 펼친 동안은 다른 키도 메뉴·게임으로 보내지 않는다 (Ctrl·⌘ 조합 = 브라우저·앱 단축키만 그대로)
    } else if (k === 'Enter' || k === 'NumpadEnter' || k === 'Space' || k === 'ArrowDown' || k === 'ArrowUp') {
      if (k === 'Space') this.spaceDown = true;
      if (mod) handled = false;
      else {
        this.open();
        this.sound('ui_select');
      }
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      if (mod || e.altKey) handled = false;
      else this.step(k === 'ArrowRight' ? 1 : -1);
    } else if (k === 'Home' || k === 'End') this.pickSound(this.edge(k === 'Home' ? 1 : -1));
    else if (!mod && !e.altKey && e.key.length === 1 && e.key !== ' ') {
      const i = this.find(e.key);
      if (i >= 0) this.pickSound(i);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** 닫힌 칸 ←→: 앞뒤 값 (끝에서 멈춘다) */
  private step(dir: 1 | -1): void {
    let i = this.index(this.value);
    for (;;) {
      i += dir;
      if (i < 0 || i >= this.opts.length) return;
      if (!this.opts[i].disabled) break;
    }
    this.pickSound(i);
  }

  private pickSound(i: number): void {
    if (i < 0 || this.opts[i]?.value === this.value) return;
    this.sound('ui_move');
    this.pick(i);
  }

  private move(d: number): void {
    const n = this.opts.length;
    let i = this.active < 0 ? (d > 0 ? -1 : n) : this.active;
    let to = this.active;
    const steps = Math.abs(d);
    const dir = d > 0 ? 1 : -1;
    for (let s = 0; s < steps; s++) {
      let j = i + dir;
      while (j >= 0 && j < n && this.opts[j].disabled) j += dir;
      if (j < 0 || j >= n) break;
      i = to = j;
    }
    this.moveTo(to);
  }

  private moveTo(i: number): void {
    if (i < 0 || i === this.active) return;
    this.active = i;
    this.paint();
    this.sound('ui_move');
  }

  /** 첫(1)·끝(-1) 고를 수 있는 항목 */
  private edge(dir: 1 | -1): number {
    const n = this.opts.length;
    for (let s = 0; s < n; s++) {
      const i = dir > 0 ? s : n - 1 - s;
      if (!this.opts[i].disabled) return i;
    }
    return -1;
  }

  /** 글자로 찾기: 0.6초 안에 이어 치면 이어 붙여 찾고, 같은 글자를 거듭 치면 그 글자로 시작하는 다음 항목 */
  private find(ch: string): number {
    const now = performance.now();
    const c = ch.toLocaleLowerCase();
    this.typed = now - this.typedAt < 600 ? this.typed + c : c;
    this.typedAt = now;
    const same = [...this.typed].every((x) => x === c);
    const q = same ? c : this.typed;
    const n = this.opts.length;
    const from = this.panel ? this.active : this.index(this.value);
    const start = same ? from + 1 : Math.max(0, from);
    for (let s = 0; s < n; s++) {
      const i = (start + s + n) % n;
      const o = this.opts[i];
      if (!o.disabled && o.label.toLocaleLowerCase().startsWith(q)) return i;
    }
    return -1;
  }

  // ------------------------------------------------------------------ 고르기·그리기

  private pick(i: number): void {
    const o = this.opts[i];
    if (!o || o.disabled || o.value === this.value) return;
    this.value = o.value;
    this.el.dispatchEvent(new Event('input', { bubbles: true }));
    this.el.dispatchEvent(new Event('change', { bubbles: true }));
    this.onChange?.(o.value);
  }

  private sound(cue: MenuSoundDetail['cue']): void {
    menuSound(this.el, cue);
  }

  private index(v: string): number {
    return this.opts.findIndex((o) => o.value === v);
  }

  private optIndex(t: EventTarget | null): number {
    const b = (t as HTMLElement | null)?.closest?.('.dd-opt') as HTMLElement | null;
    return b ? Number(b.dataset.i) : -1;
  }

  private build(): void {
    const p = this.panel!;
    p.innerHTML = this.opts
      .map(
        (o, i) =>
          `<button type="button" tabindex="-1" class="dd-opt" role="option" id="${this.id}-${i}" data-i="${i}" aria-selected="${o.value === this.value}"${o.disabled ? ' aria-disabled="true"' : ''}>${esc(o.label)}</button>`,
      )
      .join('');
  }

  private paint(scroll = true): void {
    const p = this.panel;
    if (!p) return;
    p.querySelectorAll<HTMLElement>('.dd-opt').forEach((b, i) => {
      b.classList.toggle('on', i === this.active);
      b.setAttribute('aria-selected', String(this.opts[i]?.value === this.value));
    });
    const cur = p.querySelector<HTMLElement>(`#${this.id}-${this.active}`);
    if (cur) {
      this.el.setAttribute('aria-activedescendant', cur.id);
      if (scroll) {
        const top = cur.offsetTop;
        if (top < p.scrollTop) p.scrollTop = top - 5;
        else if (top + cur.offsetHeight > p.scrollTop + p.clientHeight) p.scrollTop = top + cur.offsetHeight - p.clientHeight + 5;
      }
    } else this.el.removeAttribute('aria-activedescendant');
  }

  /** 칸 바로 아래 (모자라면 위), 화면 안으로 */
  private place(): void {
    const p = this.panel;
    if (!p) return;
    const r = this.el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 8;
    const GAP = 4;
    p.style.maxHeight = '';
    p.style.minWidth = `${Math.min(r.width, vw - 2 * M)}px`;
    p.style.maxWidth = `${vw - 2 * M}px`;
    p.style.left = '0px';
    p.style.top = '0px';
    const w = p.offsetWidth;
    const h = p.scrollHeight + (p.offsetHeight - p.clientHeight);
    const below = vh - r.bottom - GAP - M;
    const above = r.top - GAP - M;
    const up = h > below && above > below;
    const room = Math.max(80, up ? above : below);
    const ph = Math.min(h, room);
    p.style.maxHeight = `${room}px`;
    p.classList.toggle('dd-up', up);
    p.style.top = `${Math.round(up ? r.top - GAP - ph : r.bottom + GAP)}px`;
    // 왼쪽 끝을 칸에 맞추고, 오른쪽이 모자라면 오른쪽 끝을 칸에 맞춘다 (화면 오른쪽 판의 칸)
    const left = r.left + w <= vw - M ? r.left : Math.min(r.right, vw - M) - w;
    p.style.left = `${Math.round(Math.max(M, left))}px`;
  }

  /** 목록을 띄울 자리: 가까운 오버레이, 없으면 UI 상자(섀도 루트 맨 위 요소: div#game, lang이 붙어 일본어 글꼴 규칙이 닿는다)·body */
  private layer(): ParentNode {
    const ov = this.el.closest('.overlay');
    if (ov) return ov;
    if (!(this.el.getRootNode() instanceof ShadowRoot)) return document.body;
    let top: HTMLElement = this.el;
    while (top.parentElement) top = top.parentElement;
    return top;
  }
}
