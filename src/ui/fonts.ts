/**
 * UI 웹 글꼴 미리 받기. 웹 글꼴은 게임이 setUiFonts(fontStacks.ts)로 정한다. 정하지 않았으면 할 일이 없다.
 *
 * 캔버스(fillText)는 글꼴이 다 받아지기 전에 그리면 대체 글꼴로 굳어 버린다: 첫 화면 앞과 레벨 조립 앞에서
 * 지금 언어의 글꼴 조각을 전부 받아 둔다 (uiFontsReady). 첫 화면은 오래 기다리지 않는다(시한, 클릭 대기 없음).
 * 서브셋 글꼴(unicode-range로 나뉜 @font-face)은 화면에 나온 글자의 조각만 받는다 (font-display: swap).
 */
import { getLang, onLangChange } from '../i18n';
import { FONT_FACES } from './fontStacks';

const loading = new Map<string, Promise<void>>();

/** 한 글꼴 이름의 조각(@font-face)을 전부 받는다 */
function loadFamily(family: string): Promise<void> {
  const done = loading.get(family);
  if (done) return done;
  const faces: FontFace[] = [];
  document.fonts.forEach((f) => {
    if (f.family.replace(/^["']|["']$/g, '') === family) faces.push(f);
  });
  // 스타일이 아직 안 붙었으면 (@font-face가 안 보이면) 라틴·한글 몇 자만 받아 둔다. 다음 호출에서 다시 전부 찾는다
  if (!faces.length) return document.fonts.load(`16px "${family}"`, 'Aa 0123 가나다').then(() => undefined, () => undefined);
  const p = Promise.all(faces.map((f) => f.load().catch(() => undefined))).then(() => undefined);
  loading.set(family, p);
  return p;
}

/**
 * 지금 언어의 UI 글꼴을 다 받을 때까지 (maxMs가 있으면 그 시한까지만 기다린다. 못 받은 글꼴은 swap으로 나중에 바뀐다).
 * 받기 실패(오프라인 등)도 그냥 넘어간다: 시스템 글꼴로 그린다.
 */
export function uiFontsReady(maxMs = Infinity): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const families = FONT_FACES[getLang()] ?? [];
  if (!families.length) return Promise.resolve();
  const all = Promise.all(families.map(loadFamily)).then(() => undefined);
  if (!Number.isFinite(maxMs)) return all;
  return Promise.race([all, new Promise<void>((r) => setTimeout(r, maxMs))]);
}

// 언어를 바꾸면 그 언어 글꼴을 미리 받는다
onLangChange(() => void uiFontsReady());
