import type { Settings } from '../core/config';
import { saveSettings } from '../core/config';
import type { Engine } from '../core/Engine';
import { GRAPHICS_QUALITIES, type GraphicsQuality } from '../core/quality';
import { LANG_NAMES, LANGS, getLang, setLang, t, type Lang } from '../i18n';
import { Checkbox, checkboxHtml } from './Choice';
import { Dropdown, dropdownHtml, dropdownOpen } from './Dropdown';
import menuCss from './menu.css?inline';
import { adoptStyle } from './uiRoot';

adoptStyle('sce-menu', menuCss);

/**
 * 일시정지·설정 메뉴. 보통 사용자가 Esc로 포인터 락을 풀면 연다.
 *   계속하기 · (게임이 더한 항목들) · 설정
 *   설정: 엔진 설정만 다룬다. 언어, 마우스 감도, 상하 반전, 시야각, 그래픽 품질, 음량(전체·음악·효과음·음성).
 *   engine.settings에 바로 반영하고 저장한다. 어느 줄을 보일지 MenuOptions.settings로 고른다.
 * 메뉴를 고르는 클릭은 사용자 제스처라 그 안에서 포인터 락을 다시 잡을 수 있다 (actions.requestLock).
 */
export type SettingKey = 'lang' | 'mouseSensitivity' | 'invertY' | 'fov' | 'graphics' | 'volume';
export const ALL_SETTINGS: readonly SettingKey[] = ['lang', 'mouseSensitivity', 'invertY', 'fov', 'graphics', 'volume'];

export interface MenuItem {
  /** 항목 id (click 콜백에 넘긴다) */
  id: string;
  /** 표시 글자 (함수면 열 때마다 다시 읽는다: 언어 변경) */
  label: string | (() => string);
  /** 고르면 메뉴를 닫고 부른다 */
  run: () => void;
}

export interface MenuActions {
  /** 계속하기 (락을 다시 잡는 건 requestLock이 있으면 메뉴가 한다) */
  resume: () => void;
  /** 클릭 안에서 포인터 락을 다시 잡는다 (없으면 잡지 않는다) */
  requestLock?: () => void;
  /** 음량을 바꿀 때 (버스, 0~1): AudioEngine.setVolume에 잇는다 */
  setVolume?: (bus: 'master' | 'music' | 'sfx' | 'voice', v: number) => void;
  /** 계속하기와 설정 사이에 넣을 항목 (처음부터, 메뉴로 등) */
  items?: MenuItem[];
  /** 머리말 (게임·장면 이름) */
  heading?: () => string;
}

export interface MenuOptions {
  /** 설정 화면에 보일 줄 (기본 전부) */
  settings?: readonly SettingKey[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class SettingsMenu {
  readonly root: HTMLDivElement;
  private open = false;
  private view: 'main' | 'settings' = 'main';
  private onKey: ((e: KeyboardEvent) => void) | null = null;
  /** 설정만 열었다 (메뉴 화면 등): 돌아가기·Esc로 닫고 이걸 부른다 */
  private settingsOnly: (() => void) | null = null;
  private readonly rows: readonly SettingKey[];

  constructor(
    parent: HTMLElement,
    private readonly engine: Engine,
    readonly actions: MenuActions,
    opts: MenuOptions = {},
  ) {
    this.rows = opts.settings ?? ALL_SETTINGS;
    this.root = document.createElement('div');
    this.root.className = 'sce-menu';
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** 설정 화면만 연다. 돌아가기·Esc로 닫으면 onClose */
  showSettings(onClose: () => void): void {
    this.show();
    this.settingsOnly = onClose;
    this.view = 'settings';
    this.render();
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.view = 'main';
    this.settingsOnly = null;
    this.render();
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add('on'));
    this.onKey = (e) => {
      // 펼친 드롭다운의 Esc는 드롭다운만 닫는다 (Dropdown.ts가 받는다)
      if (e.code === 'Escape' && this.view === 'settings' && !dropdownOpen()) {
        e.preventDefault();
        this.back();
      }
    };
    window.addEventListener('keydown', this.onKey, true);
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('on');
    this.root.hidden = true;
    if (this.onKey) window.removeEventListener('keydown', this.onKey, true);
    this.onKey = null;
  }

  /** 메뉴를 떼고 키 리스너를 푼다 */
  dispose(): void {
    this.hide();
    this.root.remove();
  }

  private render(): void {
    const a = this.actions;
    const head = a.heading?.() ?? '';
    if (this.view === 'settings') {
      this.root.innerHTML = `<div class="sm-panel"><div class="sm-head"><span>${esc(head || t('menu.title'))}</span><b>${esc(t('menu.settings'))}</b></div><div class="sm-settings">${this.settingsHtml()}</div><div class="sm-items"><button type="button" data-a="back">${esc(t('common.back'))}<kbd>Esc</kbd></button></div></div>`;
    } else {
      const items: [string, string][] = [['resume', t('menu.resume')]];
      for (const it of a.items ?? []) items.push([`item:${it.id}`, typeof it.label === 'function' ? it.label() : it.label]);
      items.push(['settings', t('menu.settings')]);
      this.root.innerHTML = `<div class="sm-panel">
        <div class="sm-head"><span>${esc(head)}</span><b>${esc(t('menu.title'))}</b></div>
        <div class="sm-items">${items.map(([k, label], i) => `<button type="button" data-a="${esc(k)}"${i === 0 ? ' class="primary"' : ''}>${esc(label)}${i === 0 ? `<kbd>${esc(t('common.click'))}</kbd>` : ''}</button>`).join('')}</div>
        <div class="sm-foot">${esc(t('menu.foot'))}</div></div>`;
    }
    this.root.querySelectorAll('button[data-a]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.act((b as HTMLElement).dataset.a!);
      }),
    );
    this.bindSettings();
  }

  private act(k: string): void {
    const a = this.actions;
    if (k.startsWith('item:')) {
      const it = a.items?.find((x) => x.id === k.slice(5));
      this.hide();
      it?.run();
      return;
    }
    switch (k) {
      case 'resume':
        a.requestLock?.();
        this.hide();
        a.resume();
        break;
      case 'settings':
        this.view = 'settings';
        this.render();
        break;
      case 'back':
        this.back();
        break;
    }
  }

  private back(): void {
    const close = this.settingsOnly;
    if (close) {
      this.settingsOnly = null;
      this.hide();
      close();
      return;
    }
    this.view = 'main';
    this.render();
  }

  private settingsHtml(): string {
    const s = this.engine.settings;
    const has = (k: SettingKey) => this.rows.includes(k);
    const range = (key: string, label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string) =>
      `<label class="sm-row"><span>${esc(label)}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${value}"><em>${fmt(value)}</em></label>`;
    const pct = (v: number) => `${Math.round(v * 100)}`;
    const out: string[] = [];
    // 언어 (src/i18n): 바꾸면 메뉴는 바로 다시 그린다. 다른 UI는 onLangChange로 따라온다
    if (has('lang')) out.push(`<label class="sm-row"><span>${esc(t('lang.setting'))}</span>${dropdownHtml({ options: LANGS.map((l) => ({ value: l, label: LANG_NAMES[l] })), value: getLang(), attrs: { 'data-x': 'lang' } })}<em></em></label>`);
    if (has('mouseSensitivity')) out.push(range('mouseSensitivity', t('settings.mouseSensitivity'), 0.0006, 0.006, 0.0001, s.mouseSensitivity, (v) => (v / 0.0022).toFixed(2)));
    if (has('invertY')) out.push(`<label class="sm-row"><span>${esc(t('settings.invertY'))}</span>${checkboxHtml({ checked: s.invertY, attrs: { 'data-k': 'invertY' } })}<em></em></label>`);
    if (has('fov')) out.push(range('worldFov', t('settings.fov'), 40, 100, 1, s.worldFov, (v) => `${v}°`));
    // 그래픽 품질 (core/quality.ts): 자동이면 오른쪽에 지금 단계
    if (has('graphics')) out.push(`<label class="sm-row"><span>${esc(t('settings.graphics'))}</span>${dropdownHtml({ options: GRAPHICS_QUALITIES.map((q) => ({ value: q, label: t(`graphics.${q}`) })), value: s.graphics, attrs: { 'data-x': 'graphics' } })}<em>${s.graphics === 'auto' ? esc(t(`graphics.${this.engine.qualityName}`)) : ''}</em></label>`);
    if (has('volume')) {
      out.push(range('masterVolume', t('settings.volMaster'), 0, 1, 0.05, s.masterVolume, pct));
      out.push(range('musicVolume', t('settings.volMusic'), 0, 1, 0.05, s.musicVolume, pct));
      out.push(range('sfxVolume', t('settings.volSfx'), 0, 1, 0.05, s.sfxVolume, pct));
      out.push(range('voiceVolume', t('settings.volVoice'), 0, 1, 0.05, s.voiceVolume, pct));
    }
    return out.join('');
  }

  private bindSettings(): void {
    const s = this.engine.settings as Settings & Record<string, unknown>;
    // 언어·그래픽 칸(Dropdown)과 상하 반전(Checkbox): el.value·el.checked와 change·input은 예전 <select>·<input>과 같다
    Dropdown.upgrade(this.root);
    Checkbox.upgrade(this.root);
    const lang = this.root.querySelector('.dd[data-x="lang"]') as HTMLButtonElement | null;
    lang?.addEventListener('change', () => {
      setLang(lang.value as Lang);
      this.render();
      (this.root.querySelector('.dd[data-x="lang"]') as HTMLButtonElement | null)?.focus();
    });
    const gfx = this.root.querySelector('.dd[data-x="graphics"]') as HTMLButtonElement | null;
    gfx?.addEventListener('change', () => {
      s.graphics = gfx.value as GraphicsQuality;
      this.engine.applySettings();
      saveSettings(this.engine.settings);
      const em = gfx.parentElement?.querySelector('em');
      if (em) em.textContent = s.graphics === 'auto' ? t(`graphics.${this.engine.qualityName}`) : '';
    });
    this.root.querySelectorAll('input[data-k], .ck[data-k]').forEach((el) => {
      const inp = el as HTMLInputElement;
      const box = inp.getAttribute('role') === 'checkbox';
      inp.addEventListener('input', () => {
        const k = inp.dataset.k!;
        if (box) s[k] = inp.checked;
        else s[k] = Number(inp.value);
        const em = inp.parentElement?.querySelector('em');
        if (em && !box) {
          const v = Number(inp.value);
          em.textContent = k === 'mouseSensitivity' ? (v / 0.0022).toFixed(2) : k === 'worldFov' ? `${v}°` : `${Math.round(v * 100)}`;
        }
        if (k === 'worldFov') this.engine.applySettings();
        const bus = ({ masterVolume: 'master', musicVolume: 'music', sfxVolume: 'sfx', voiceVolume: 'voice' } as const)[k as 'masterVolume'];
        if (bus) this.actions.setVolume?.(bus, Number(inp.value));
        saveSettings(this.engine.settings);
      });
    });
  }
}
