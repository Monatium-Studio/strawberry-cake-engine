import choiceCss from './choice.css?inline';
import { adoptForDocument, menuSound } from './Dropdown';
import { adoptStyle } from './uiRoot';

adoptStyle('choice', choiceCss);

/**
 * 체크박스·라디오 묶음: 네이티브 <input type="checkbox|radio"> 대신 쓰는 엔진 UI 칸 (드롭다운 ui/Dropdown.ts와 한 식구).
 * 모양은 설정 메뉴 그대로다 (choice.css, 색은 ui.css의 --ui-accent). 화면은 checkboxHtml()·radioGroupHtml()로 그리고 Checkbox.upgrade()·RadioGroup.upgrade()로 살린다.
 *
 * - 값: 칸은 <button role="checkbox|radio" name value aria-checked>이고, 살릴 때 el.checked를 단다: 예전 input처럼 el.name·el.value·el.checked를 읽고,
 *   바뀌면 'input'·'change'(버블)를 낸다. 예전 리스너·위임 리스너가 그대로 돈다. 코드로 checked를 바꾸면 이벤트는 없다.
 * - 마우스: 칸이나 칸을 감싼 <label>을 누르면 바뀐다 (칸은 <button>: 게임의 단추 hover·클릭 소리 고리가 받는다).
 * - 키보드: Space·Enter로 바꾼다 (칸이 먹는다: 메뉴·게임의 Enter로 새지 않는다). 키보드로 바꾸면 'menusound' ui_select.
 *   라디오 묶음은 탭 한 칸(고른 항목), ←→↑↓로 옮기며 고르고 Home·End (ui_move).
 * - ARIA: role=checkbox / radiogroup / radio, aria-checked, aria-disabled(disabled).
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const attrsOf = (a: Record<string, string> = {}) =>
  Object.entries(a)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');

/** el.checked를 aria-checked에 잇는다 (예전 input처럼 읽고 쓴다: 쓰면 이벤트 없음) */
function defineChecked(el: HTMLButtonElement): void {
  Object.defineProperty(el, 'checked', {
    configurable: true,
    get: () => el.getAttribute('aria-checked') === 'true',
    set: (v: boolean) => el.setAttribute('aria-checked', String(!!v)),
  });
}

function fire(el: HTMLElement): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export interface CheckboxSpec {
  checked: boolean;
  name?: string;
  disabled?: boolean;
  cls?: string;
  /** data-k, title, aria-label 등 */
  attrs?: Record<string, string>;
}

/** 체크박스 마크업 (innerHTML로 그리는 화면용). 그린 뒤 Checkbox.upgrade(부모) */
export function checkboxHtml(spec: CheckboxSpec): string {
  return `<button type="button" class="ck${spec.cls ? ` ${spec.cls}` : ''}" role="checkbox" aria-checked="${!!spec.checked}"${spec.name ? ` name="${esc(spec.name)}"` : ''}${spec.disabled ? ' disabled' : ''}${attrsOf(spec.attrs)}></button>`;
}

type Checkable = HTMLButtonElement & { checked: boolean };
const boxes = new WeakMap<HTMLElement, Checkbox>();

export class Checkbox {
  readonly el: Checkable;
  onChange: ((checked: boolean) => void) | null = null;

  static upgrade(root: ParentNode): Checkbox[] {
    return [...root.querySelectorAll<HTMLButtonElement>('button.ck')].map((el) => boxes.get(el) ?? new Checkbox(el));
  }

  static create(spec: CheckboxSpec): Checkbox {
    const t = document.createElement('template');
    t.innerHTML = checkboxHtml(spec);
    return new Checkbox(t.content.firstElementChild as HTMLButtonElement);
  }

  static of(el: Element | null | undefined): Checkbox | undefined {
    return el ? boxes.get(el as HTMLElement) : undefined;
  }

  constructor(el: HTMLButtonElement) {
    defineChecked(el);
    this.el = el as Checkable;
    boxes.set(el, this);
    queueMicrotask(() => adoptForDocument(el, choiceCss));
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    el.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || el.disabled) return;
      menuSound(el, 'ui_select');
      this.toggle();
    });
    // 단추는 Space를 keyup에서 누른다: keydown에서 이미 바꿨다
    el.addEventListener('keyup', (e) => e.code === 'Space' && e.preventDefault());
  }

  get checked(): boolean {
    return this.el.checked;
  }

  set checked(v: boolean) {
    this.el.checked = v;
  }

  private toggle(): void {
    if (this.el.disabled) return;
    this.el.checked = !this.el.checked;
    fire(this.el);
    this.onChange?.(this.el.checked);
  }
}

// ------------------------------------------------------------------ 라디오 묶음

export interface RadioGroupSpec {
  name: string;
  options: { value: string; label: string; disabled?: boolean }[];
  value: string;
  disabled?: boolean;
  cls?: string;
  /** 묶음(role=radiogroup)에 더할 속성 (aria-label 등) */
  attrs?: Record<string, string>;
}

/** 라디오 묶음 마크업. 그린 뒤 RadioGroup.upgrade(부모) */
export function radioGroupHtml(spec: RadioGroupSpec): string {
  const cur = spec.options.some((o) => o.value === spec.value) ? spec.value : spec.options.find((o) => !o.disabled)?.value;
  const items = spec.options
    .map((o) => {
      const on = o.value === cur;
      return `<label class="rg-item"><button type="button" class="rd" role="radio" name="${esc(spec.name)}" value="${esc(o.value)}" aria-checked="${on}" tabindex="${on ? 0 : -1}"${o.disabled || spec.disabled ? ' disabled' : ''}></button><span>${esc(o.label)}</span></label>`;
    })
    .join('');
  return `<div class="rg${spec.cls ? ` ${spec.cls}` : ''}" role="radiogroup" data-name="${esc(spec.name)}"${spec.disabled ? ' aria-disabled="true"' : ''}${attrsOf(spec.attrs)}>${items}</div>`;
}

const groups = new WeakMap<HTMLElement, RadioGroup>();

export class RadioGroup {
  readonly el: HTMLElement;
  onChange: ((value: string) => void) | null = null;

  static upgrade(root: ParentNode): RadioGroup[] {
    return [...root.querySelectorAll<HTMLElement>('[role="radiogroup"].rg')].map((el) => groups.get(el) ?? new RadioGroup(el));
  }

  static of(el: Element | null | undefined): RadioGroup | undefined {
    return el ? groups.get(el as HTMLElement) : undefined;
  }

  constructor(el: HTMLElement) {
    this.el = el;
    groups.set(el, this);
    queueMicrotask(() => adoptForDocument(el, choiceCss));
    for (const r of this.radios()) defineChecked(r);
    el.addEventListener('click', (e) => {
      const r = (e.target as HTMLElement).closest('.rd') as HTMLButtonElement | null;
      if (!r || !el.contains(r)) return;
      e.stopPropagation();
      this.select(r, true);
    });
    el.addEventListener('keydown', (e) => {
      const rs = this.radios().filter((r) => !r.disabled);
      const i = rs.indexOf(e.target as HTMLButtonElement);
      if (i < 0) return;
      let to = -1;
      if (e.code === 'ArrowRight' || e.code === 'ArrowDown') to = (i + 1) % rs.length;
      else if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') to = (i - 1 + rs.length) % rs.length;
      else if (e.code === 'Home') to = 0;
      else if (e.code === 'End') to = rs.length - 1;
      else if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) {
          menuSound(rs[i], 'ui_select');
          this.select(rs[i], true);
        }
        return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
      if (to !== i) {
        menuSound(rs[to], 'ui_move');
        rs[to].focus();
        this.select(rs[to], true);
      }
    });
    el.addEventListener('keyup', (e) => e.code === 'Space' && e.preventDefault());
  }

  private radios(): HTMLButtonElement[] {
    return [...this.el.querySelectorAll<HTMLButtonElement>('.rd')];
  }

  get name(): string {
    return this.el.dataset.name ?? '';
  }

  get value(): string {
    return this.radios().find((r) => r.getAttribute('aria-checked') === 'true')?.value ?? '';
  }

  /** 값을 바꾼다 (이벤트 없음) */
  set value(v: string) {
    const r = this.radios().find((x) => x.value === v);
    if (r) this.select(r, false);
  }

  private select(r: HTMLButtonElement, user: boolean): void {
    if (r.disabled) return;
    const was = this.value;
    for (const x of this.radios()) {
      const on = x === r;
      x.setAttribute('aria-checked', String(on));
      x.tabIndex = on ? 0 : -1;
    }
    if (user && r.value !== was) {
      fire(r);
      this.onChange?.(r.value);
    }
  }
}
