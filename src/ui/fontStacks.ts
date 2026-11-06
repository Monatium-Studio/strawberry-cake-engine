/**
 * UI 글꼴 목록 (CSS 변수·캔버스 fillText·인라인 스타일용).
 *
 * 기본은 시스템 글꼴만 쓴다. 게임이 웹 글꼴(예: Pretendard, SIL OFL 1.1)을 묶어 배포하려면 그 CSS를 불러오고 setUiFonts로 앞에 둔다:
 *
 *   import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
 *   setUiFonts({ sansFaces: ["'Pretendard Variable'"], faces: { ko: ['Pretendard Variable'], en: ['Pretendard Variable'] } });
 *
 * 시스템 글꼴만 적어 두면 윈도우에서 한글이 굴림·굴림체로 찍히고 글자 폭이 달라 레이아웃이 깨질 수 있다. 한글 UI는 웹 글꼴을 권한다.
 * - 고정폭 목록: 라틴 고정폭 글꼴(ui-monospace·Menlo·Consolas)을 앞에 두고, 한글은 generic monospace로 떨어지기 전에 본문 글꼴이 받는다.
 * - 일본어: 일본어 글꼴 목록(Hiragino·Yu Gothic·Meiryo)을 쓴다 (i18n.css가 :lang(ja)로 고른다).
 */
const SYSTEM_SANS = "system-ui, -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', 'Segoe UI', sans-serif";
const SYSTEM_JA = "system-ui, -apple-system, 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', Meiryo, 'Noto Sans JP', sans-serif";

/** 한국어·영어 본문 */
export let UI_SANS = SYSTEM_SANS;
/** 숫자·코드풍 글자 (라틴은 고정폭, 한글은 본문 글꼴) */
export let UI_MONO = `ui-monospace, Menlo, Consolas, ${SYSTEM_SANS}, monospace`;
/** 일본어 본문 */
export let JA_SANS = SYSTEM_JA;
/** 언어별로 미리 받아 둘 웹 글꼴 이름 (@font-face font-family). 비어 있으면 받을 것이 없다 (fonts.ts uiFontsReady) */
export let FONT_FACES: Record<string, string[]> = {};

type FontListener = () => void;
const listeners: FontListener[] = [];

/** 글꼴 목록이 바뀌면 부른다 (uiRoot가 CSS 변수를 다시 쓴다) */
export function onFontsChange(fn: FontListener): void {
  listeners.push(fn);
}

export interface UiFontOptions {
  /** 본문 목록 앞에 둘 글꼴 (CSS 표기, 따옴표 포함) */
  sansFaces?: string[];
  /** 일본어 목록 앞에 둘 글꼴 */
  jaFaces?: string[];
  /** 언어 → 미리 받아 둘 @font-face 이름 */
  faces?: Record<string, string[]>;
}

/** 웹 글꼴을 시스템 글꼴 앞에 둔다 */
export function setUiFonts(opts: UiFontOptions): void {
  const sans = opts.sansFaces?.length ? `${opts.sansFaces.join(', ')}, ${SYSTEM_SANS}` : SYSTEM_SANS;
  UI_SANS = sans;
  UI_MONO = `ui-monospace, Menlo, Consolas, ${opts.sansFaces?.length ? opts.sansFaces.join(', ') + ', ' : ''}monospace`;
  JA_SANS = opts.jaFaces?.length ? `${opts.jaFaces.join(', ')}, ${SYSTEM_JA}` : SYSTEM_JA;
  FONT_FACES = opts.faces ?? {};
  for (const fn of listeners) fn();
}
