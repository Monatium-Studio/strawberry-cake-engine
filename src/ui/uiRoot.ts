import baseCss from './ui.css?inline';
import { JA_SANS, UI_MONO, UI_SANS, onFontsChange } from './fontStacks';

/**
 * UI 뿌리: 문서의 #game(호스트)에 닫힌 섀도 루트를 달고, 게임이 만드는 DOM(WebGL 캔버스, HUD, 메뉴, 로딩 화면,
 * 개발 도구, 스크린샷 표시)을 전부 그 안의 div#game(uiContainer) 아래에 둔다.
 *
 * 왜: 번역기·다크 리더·광고 차단·암호 관리자·맞춤법 검사 같은 브라우저 확장은 문서 전체를 MutationObserver로 지켜보며
 * 노드를 고치거나 다시 칠한다. HUD는 매 프레임 DOM을 바꾸므로 그 콜백이 게임의 메인 스레드에서 돌고 UI를 바꿀 수도 있다.
 * 섀도 트리 안의 변경은 문서에 건 옵저버에 전달되지 않고, 닫힌 루트는 element.shadowRoot로도 보이지 않는다.
 *
 * - 스타일: UI CSS는 문서 <head>가 아니라 이 루트의 adoptedStyleSheets에 붙는다 (adoptStyle). 붙는 순서는 adoptStyle을 부른
 *   순서(모듈 평가 순서, 실행 중에 만드는 스타일은 만든 때)다. 맨 앞은 ui.css.
 *   페이지 자체(html·body 배경·여백·스크롤, 호스트 상자, body.leaving 덮개)와 @font-face(웹 글꼴)는 문서에 남는다:
 *   섀도 루트 안의 @font-face는 브라우저마다 믿을 수 없다. 문서의 글꼴은 섀도 트리에서도 쓰인다.
 * - 글꼴: fontStacks.ts의 목록을 CSS 변수 --ui-sans·--ui-mono·--ui-ja로 내린다 (setUiFonts로 바꾸면 다시 쓴다).
 * - 언어: 문서 <html lang>을 안쪽 div#game의 lang에도 적는다 (setUiLang). 일본어 글꼴 규칙(i18n.css)은 :lang()으로 고른다.
 * - 이벤트: 창·문서에 건 리스너는 섀도 안 요소에서 온 이벤트의 target을 호스트로 받는다. 진짜 요소가 필요하면
 *   e.composedPath()[0]. 포커스·포인터 락은 문서가 아니라 이 루트의 activeElement·pointerLockElement로 본다.
 * - 점검 스크립트(scripts/uiDom.mjs)는 window.__ui(이 루트)로 들어온다. 확장의 콘텐츠 스크립트는 따로 떨어진 JS 세계에서 돌아
 *   페이지의 전역 변수를 보지 못한다.
 */

declare global {
  interface Window {
    /** UI 섀도 루트 (점검 스크립트용) */
    __ui?: ShadowRoot;
  }
}

const sheets: CSSStyleSheet[] = [];
const adopted = new Set<string>();
let root: ShadowRoot | null = null;
let container: HTMLDivElement | null = null;
let lang = '';
let options: UiRootOptions = {};

export interface UiRootOptions {
  /** 호스트 요소 id (기본 'game'). 없으면 body 끝에 만든다 */
  hostId?: string;
  /** 최소 렌더링 크기 (CSS px). 창이 더 작으면 호스트가 이 크기를 지키고 페이지가 스크롤된다 (Engine에도 같은 값을 준다) */
  minWidth?: number;
  minHeight?: number;
  /** true면 닫힌 루트 대신 열린 루트 (디버깅용) */
  open?: boolean;
}

/** UI 뿌리 설정 (처음 uiRoot·uiContainer를 부르기 전에) */
export function configureUiRoot(opts: UiRootOptions): void {
  if (root) console.warn('[ui] configureUiRoot: 루트가 이미 있다. 다음 페이지부터 반영된다');
  options = { ...options, ...opts };
}

/** UI 스타일을 붙인다 (같은 id는 한 번만). 루트가 아직 없으면 모아 두었다가 만들 때 한꺼번에 붙인다 */
export function adoptStyle(id: string, css: string): void {
  if (adopted.has(id)) return;
  adopted.add(id);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  sheets.push(sheet);
  if (root) root.adoptedStyleSheets = [...sheets];
}
adoptStyle('ui', baseCss);

/** 글꼴 변수 (fontStacks.ts). 목록이 바뀌면 같은 시트를 다시 쓴다 */
const fontSheet = new CSSStyleSheet();
function writeFonts(): void {
  fontSheet.replaceSync(`:host { --ui-sans: ${UI_SANS}; --ui-mono: ${UI_MONO}; --ui-ja: ${JA_SANS}; }`);
}
writeFonts();
sheets.unshift(fontSheet);
onFontsChange(writeFonts);

function mount(): void {
  if (root) return;
  const id = options.hostId ?? 'game';
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement('div');
    host.id = id;
    document.body.appendChild(host);
  }
  // 창이 최소 렌더링 크기보다 작으면 이 크기를 지키고 페이지가 스크롤된다 (안쪽은 Engine이 같은 값)
  if (options.minWidth) host.style.minWidth = `${options.minWidth}px`;
  if (options.minHeight) host.style.minHeight = `${options.minHeight}px`;
  root = host.attachShadow({ mode: options.open ? 'open' : 'closed' });
  root.adoptedStyleSheets = [...sheets];
  container = document.createElement('div');
  container.id = 'game';
  if (lang) container.lang = lang;
  root.appendChild(container);
  window.__ui = root;
}

/** UI 섀도 루트 (처음 부를 때 만든다). querySelector·activeElement·pointerLockElement는 여기서 */
export function uiRoot(): ShadowRoot {
  mount();
  return root!;
}

/** 화면 상자 (섀도 루트 안의 div#game): Engine에 넘긴다. 캔버스·오버레이가 이 아래에 붙는다 */
export function uiContainer(): HTMLDivElement {
  mount();
  return container!;
}

/** 지금 포커스를 가진 UI 요소 (document.activeElement는 섀도 안을 가리키면 호스트를 돌려준다) */
export function uiActiveElement(): Element | null {
  return root?.activeElement ?? null;
}

/** 문서 언어를 UI 상자에도 적는다 (i18n이 부른다) */
export function setUiLang(l: string): void {
  lang = l;
  if (container) container.lang = l;
}
