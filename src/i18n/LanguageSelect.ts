import { LANG_NAMES, LANGS, guessLang, setLang, type Lang } from './index';
import languageSelectCss from './languageSelect.css?inline';
import { adoptStyle, uiActiveElement } from '../ui/uiRoot';

adoptStyle('languageSelect', languageSelectCss);

/**
 * 첫 실행 언어 선택 화면 (저장된 언어가 없을 때 첫 화면 앞에 띄운다: if (!languageChosen()) await new LanguageSelect(el).choose()).
 * - 언어마다 버튼 (LANGS 순서). 클릭 한 번이나 Enter로 바로 정한다 (확인 단계 없음).
 * - 키보드: ↑↓·←→·Tab으로 고르고 Enter·Space로 정한다. 숫자 키는 바로 정한다.
 * - 이 클릭·키 입력이 오디오 잠금 해제 제스처도 겸한다 (오디오 엔진은 window의 첫 입력에서 깨어난다).
 * - 처음 포커스는 브라우저 언어로 짐작한 언어.
 */
const PROMPTS: Record<Lang, string> = { ko: '언어를 선택하세요', en: 'Select your language', ja: '言語を選択してください' };
const SUBS: Record<Lang, string> = { ko: 'KOREAN', en: 'ENGLISH', ja: 'JAPANESE' };

export class LanguageSelect {
  readonly root: HTMLDivElement;
  private onKey: ((e: KeyboardEvent) => void) | null = null;

  constructor(private readonly parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'lang-select';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Language / 언어 / 言語');
  }

  /** 화면을 띄우고 고른 언어로 resolve한다 (저장까지 한다) */
  choose(): Promise<Lang> {
    const first = guessLang();
    this.root.innerHTML = `
      <div class="ls-panel">
        <div class="ls-head">
          <span class="ls-k">LANGUAGE</span>
          <div class="ls-prompts">${LANGS.map((l) => `<p lang="${l}">${PROMPTS[l]}</p>`).join('')}</div>
        </div>
        <div class="ls-items" role="listbox">
          ${LANGS.map((l, i) => `<button type="button" role="option" data-lang="${l}" lang="${l}"><b>${LANG_NAMES[l]}</b><small>${SUBS[l]}</small><kbd>${i + 1}</kbd></button>`).join('')}
        </div>
        <div class="ls-foot">
          <span lang="ko">설정에서 언제든 바꿀 수 있습니다</span>
          <span lang="en">You can change this anytime in Settings</span>
          <span lang="ja">設定からいつでも変更できます</span>
        </div>
      </div>`;
    this.parent.appendChild(this.root);
    const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('button[data-lang]')];
    const focus = (i: number) => buttons[(i + buttons.length) % buttons.length].focus({ preventScroll: true });
    requestAnimationFrame(() => {
      this.root.classList.add('on');
      focus(LANGS.indexOf(first));
    });
    return new Promise((resolve) => {
      let done = false;
      const pick = (l: Lang) => {
        if (done) return;
        done = true;
        setLang(l);
        if (this.onKey) window.removeEventListener('keydown', this.onKey, true);
        this.onKey = null;
        const btn = buttons[LANGS.indexOf(l)];
        btn.classList.add('picked');
        this.root.classList.add('leaving');
        this.root.classList.remove('on');
        setTimeout(() => this.root.remove(), 420);
        resolve(l);
      };
      buttons.forEach((b) => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          pick(b.dataset.lang as Lang);
        });
        b.addEventListener('pointerenter', () => b.focus({ preventScroll: true }));
      });
      this.onKey = (e: KeyboardEvent) => {
        const cur = buttons.indexOf(uiActiveElement() as HTMLButtonElement);
        let handled = true;
        if (e.code === 'ArrowDown' || e.code === 'ArrowRight') focus(cur + 1);
        else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') focus(cur - 1);
        else if (e.code === 'Tab') focus(cur + (e.shiftKey ? -1 : 1));
        else if (e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') pick(LANGS[cur >= 0 ? cur : LANGS.indexOf(first)]);
        else if (/^(Digit|Numpad)[1-3]$/.test(e.code)) pick(LANGS[Number(e.code.slice(-1)) - 1]);
        else handled = false;
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
      };
      window.addEventListener('keydown', this.onKey, true);
    });
  }
}
