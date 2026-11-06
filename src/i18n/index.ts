/**
 * 다국어 (ko · en · ja). 사용법과 규칙: docs/I18N.md
 *
 * - 언어: localStorage에 저장한다(열쇠는 configureI18n으로 바꾼다). ?lang=ko|en|ja는 저장하지 않고 이번 세션만 바꾼다 (점검·스크린샷용).
 *   저장된 값이 없으면 기본 언어(기본 'ko')로 돌고, 게임이 첫 실행 언어 선택 화면(LanguageSelect)을 띄울 수 있다.
 * - 대체 순서: 지금 언어 → en → ko.
 * - 자리표시: `{name}`은 vars로 바꾸고, `{key:<Action>}`은 그대로 둔다 (화면 쪽이 <kbd>로 그린다).
 *
 * 문자열은 세 갈래로 찾는다.
 *   t(key, vars)      UI 문자열 사전 (registerStrings로 등록한 키)
 *   lineText(line)    대사 한 줄의 { text(ko), en, ja } 필드
 *   tx(ko, en?)       한국어 원문 → 번역 카탈로그 (registerCatalog). 게임 스크립트가 한국어로 넘기는
 *                     안내·화면 문구를 표시하는 쪽(HUD 등)이 번역한다
 */
import { UI_STRINGS } from './strings';
import i18nCss from './i18n.css?inline';
import { JA_SANS, UI_SANS } from '../ui/fontStacks';
import { adoptStyle, setUiLang } from '../ui/uiRoot';

adoptStyle('i18n', i18nCss);

export type Lang = 'ko' | 'en' | 'ja';
/** 쓰는 언어 (게임이 configureI18n({ languages })로 줄일 수 있다: 선택 화면·설정 메뉴가 이 목록을 보인다) */
export const LANGS: Lang[] = ['ko', 'en', 'ja'];
/** 언어 이름 (각 언어 자신의 표기) */
export const LANG_NAMES: Record<Lang, string> = { ko: '한국어', en: 'English', ja: '日本語' };

/** 세 언어 문자열. en·ja가 없으면 대체 순서를 따른다 */
export interface Tr {
  ko: string;
  en?: string;
  ja?: string;
}

let storageKey = 'strawberry-cake:lang';
/** 언어가 바뀔 때 window에 내는 이벤트 이름 (detail: Lang) */
export const LANG_EVENT = 'sce:lang';

const isLang = (v: unknown): v is Lang => v === 'ko' || v === 'en' || v === 'ja';

function readSaved(): Lang | null {
  try {
    const v = localStorage.getItem(storageKey);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

function readUrl(): Lang | null {
  try {
    const v = new URLSearchParams(location.search).get('lang');
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

let fallbackLang: Lang = 'ko';
let current: Lang = readUrl() ?? readSaved() ?? fallbackLang;
const listeners = new Set<(l: Lang) => void>();

function applyDocLang(l: Lang): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = l;
  document.documentElement.dataset.lang = l;
  // UI(닫힌 섀도 루트)의 화면 상자에도: i18n.css의 :lang() 규칙과 글꼴 대체가 문서와 같은 언어를 본다
  setUiLang(l);
}
applyDocLang(current);

/**
 * 저장 열쇠와 기본 언어를 정한다 (게임 시작 전에 한 번). 저장된 값·?lang=이 없을 때만 기본 언어로 바꾼다
 */
export function configureI18n(opts: { storageKey?: string; defaultLang?: Lang; languages?: Lang[] }): void {
  if (opts.storageKey) storageKey = opts.storageKey;
  if (opts.languages?.length) LANGS.splice(0, LANGS.length, ...opts.languages.filter(isLang));
  if (opts.defaultLang && isLang(opts.defaultLang)) fallbackLang = opts.defaultLang;
  const l = readUrl() ?? readSaved() ?? fallbackLang;
  if (l !== current) {
    current = l;
    applyDocLang(l);
  }
}

/** 지금 언어 */
export function getLang(): Lang {
  return current;
}

/**
 * 언어를 바꾼다. 기본은 저장까지 한다 (save:false면 이번 세션만).
 * 바뀌면 onLangChange 구독자와 window LANG_EVENT 이벤트(detail: Lang)에 알린다.
 */
export function setLang(l: Lang, opts: { save?: boolean } = {}): void {
  if (!isLang(l)) return;
  if (opts.save !== false) {
    try {
      localStorage.setItem(storageKey, l);
    } catch {
      /* 저장 불가 (사생활 보호 모드 등): 이번 세션만 */
    }
  }
  if (l === current) return;
  current = l;
  applyDocLang(l);
  for (const fn of [...listeners]) {
    try {
      fn(l);
    } catch (e) {
      console.error(e);
    }
  }
  window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: l }));
}

/** 언어가 정해졌는지 (저장값 또는 ?lang=). false면 첫 실행 언어 선택 화면을 띄운다 */
export function languageChosen(): boolean {
  return readUrl() !== null || readSaved() !== null;
}

/** 브라우저 언어로 짐작한 언어 (선택 화면의 처음 포커스) */
export function guessLang(): Lang {
  const langs = typeof navigator !== 'undefined' ? [...(navigator.languages ?? []), navigator.language] : [];
  for (const raw of langs) {
    const p = (raw ?? '').toLowerCase().slice(0, 2);
    if (isLang(p)) return p;
  }
  return 'en';
}

/** 언어가 바뀔 때마다 (해제 함수 반환) */
export function onLangChange(fn: (l: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 캔버스(fillText)용 글꼴 목록. 일본어면 일본어 글꼴을 앞에 둔다 (한국어 글꼴로 가나·한자를 그리지 않게).
 * 예: g.font = `800 26px ${fontFamily()}`
 */
export function fontFamily(lang: Lang = current): string {
  return lang === 'ja' ? JA_SANS : UI_SANS;
}

// ================================================================== 고르기·자리표시

/** 세 언어 중 지금 언어 (대체 순서: 지금 → en → ko) */
export function pick(tr: Tr, lang: Lang = current): string {
  const v = lang === 'ja' ? tr.ja : lang === 'en' ? tr.en : tr.ko;
  return v || tr.en || tr.ko;
}

/**
 * 대사 한 줄({ text: 한국어, en, ja })의 지금 언어 문장.
 * 그 언어 필드가 없으면 카탈로그(tx)에서 찾고(실행 중에 만든 줄), 그래도 없으면 en → ko
 */
export function lineText(l: { text: string; en?: string; ja?: string }, lang: Lang = current): string {
  if (lang === 'ko') return l.text;
  const own = lang === 'ja' ? l.ja : l.en;
  if (own) return own;
  if (lang === current) {
    const c = tx(l.text);
    if (c !== l.text) return c;
  }
  return l.en || l.text;
}

/** `{name}` 자리표시를 vars로 바꾼다. `{key:<Action>}`과 vars에 없는 이름은 그대로 둔다 */
export function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

// ================================================================== UI 문자열 사전

const dict = new Map<string, Tr>();
const missingKeys = new Set<string>();
/** UI 사전의 한국어 → 항목 (tx가 카탈로그 다음으로 찾는다. 자리표시 없는 것만) */
const dictByKo = new Map<string, Tr>();

/** UI 문자열 등록. 키는 'area.name' 꼴 (예: 'menu.resume'). 같은 키를 다시 등록하면 덮어쓴다 */
export function registerStrings(d: Record<string, Tr>): void {
  for (const [k, v] of Object.entries(d)) {
    dict.set(k, v);
    if (!/\{[A-Za-z0-9_]+\}/.test(v.ko)) dictByKo.set(v.ko.replace(/\s+/g, ' ').trim(), v);
  }
}

/** UI 문자열. 없는 키는 키 그대로 돌려주고 콘솔에 한 번 알린다 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const e = dict.get(key);
  if (!e) {
    if (!missingKeys.has(key)) {
      missingKeys.add(key);
      console.warn(`[i18n] 없는 키: ${key}`);
    }
    return fill(key, vars);
  }
  return fill(pick(e), vars);
}

/** 키가 등록돼 있는지 */
export function hasKey(key: string): boolean {
  return dict.has(key);
}

/**
 * root 아래 [data-i18n="키"] 요소의 글자를 지금 언어로 채운다.
 * [data-i18n-attr="속성:키;속성:키"]는 속성 값(title, aria-label, placeholder …)을 채운다. 언어가 바뀌면 다시 부르면 된다
 */
export function localize(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-attr]').forEach((el) => {
    for (const pair of el.dataset.i18nAttr!.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
}

// ================================================================== 원문 카탈로그 (한국어 원문 → en·ja)

export interface CatalogEntry {
  en?: string;
  ja?: string;
}

const exact = new Map<string, CatalogEntry>();
const patterns: { re: RegExp; entry: CatalogEntry; weight: number }[] = [];
const HANGUL = /[ㄱ-ㆎ가-힣]/;
const misses = new Set<string>();

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 카탈로그 등록. 키는 화면에 넘어오는 한국어 원문 그대로 (공백은 한 칸으로 맞춰 비교한다).
 * 바뀌는 부분은 `{0}`, `{1}` …로 쓴다 (예: '남은 시간 {0}초'). 잡힌 값이 한국어면 그것도 카탈로그에서 찾는다
 */
export function registerCatalog(c: Record<string, CatalogEntry>): void {
  for (const [k, v] of Object.entries(c)) {
    const key = norm(k);
    if (/\{\d\}/.test(key)) {
      const src = escRe(key).replace(/\\\{(\d)\\\}/g, '(?<g$1>[\\s\\S]+?)');
      // 글자가 많은(덜 일반적인) 패턴부터 맞춰 본다: 파일 순서와 상관없이 구체적인 것이 이긴다
      const weight = key.replace(/\{\d\}/g, '').length;
      patterns.push({ re: new RegExp(`^${src}$`), entry: v, weight });
      patterns.sort((x, y) => y.weight - x.weight);
    } else exact.set(key, v);
  }
}

function fromEntry(e: CatalogEntry): string | undefined {
  return (current === 'ja' ? e.ja : e.en) || e.en;
}

/**
 * 한국어 원문을 지금 언어로. ko면 그대로. 카탈로그에 없으면 en(넘겨 줬으면) → 원문 순으로 대체한다.
 * 여러 줄이면 줄마다 찾는다. 한글이 없는 문자열(이미 영어·숫자)은 그대로 둔다
 */
export function tx(ko: string, en?: string): string;
export function tx(ko: string | null | undefined, en?: string): string | null | undefined;
export function tx(ko: string | null | undefined, en?: string): string | null | undefined {
  if (!ko || current === 'ko') return ko;
  if (!HANGUL.test(ko)) return ko;
  const key = norm(ko);
  const hit = exact.get(key);
  if (hit) {
    const v = fromEntry(hit);
    if (v) return v;
  }
  const ui = dictByKo.get(key);
  if (ui) return pick(ui);
  for (const p of patterns) {
    const m = p.re.exec(key);
    if (!m) continue;
    const v = fromEntry(p.entry);
    if (!v) continue;
    return v.replace(/\{(\d)\}/g, (_s, n: string) => {
      const g = m.groups?.[`g${n}`] ?? '';
      return HANGUL.test(g) ? tx(g) : g;
    });
  }
  if (ko.includes('\n')) {
    const parts = ko.split('\n');
    if (parts.length > 1) return parts.map((s) => tx(s)).join('\n');
  }
  if (en) return en;
  if (!misses.has(key)) {
    misses.add(key);
    if (import.meta.env?.DEV) console.debug(`[i18n] 카탈로그에 없음: ${key}`);
  }
  return ko;
}

/** 카탈로그에서 못 찾은 원문 (점검용) */
export function catalogMisses(): string[] {
  return [...misses];
}

/**
 * 한국어 본문과 영어 부제를 함께 쓰는 화면(정보 카드, 배너 등)용.
 * ko: 본문 한국어 + 부제 영어 / en: 본문 영어, 부제 없음 / ja: 본문 일본어 + 부제 영어
 */
export function dual(ko: string, en?: string): { main: string; sub: string } {
  if (current === 'ko') return { main: ko, sub: en ?? '' };
  const main = tx(ko, en);
  if (current === 'en') return { main, sub: '' };
  // 부제는 원래 영어 부제가 있던 화면에만 (레이아웃을 한국어판과 같게)
  return { main, sub: en && en !== main ? en : '' };
}

// 게임의 카탈로그 파일은 각자 Record<한국어, {en, ja}>를 내보내고 registerCatalog로 등록한다. 예:
//   const CATALOGS = import.meta.glob<{ default: Record<string, CatalogEntry> }>('./catalog/*.ts', { eager: true });
//   for (const mod of Object.values(CATALOGS)) if (mod?.default) registerCatalog(mod.default);
registerStrings(UI_STRINGS);

declare global {
  interface Window {
    __i18n?: { getLang: typeof getLang; setLang: typeof setLang; misses: typeof catalogMisses; t: typeof t; tx: typeof tx };
  }
}
if (typeof window !== 'undefined') window.__i18n = { getLang, setLang, misses: catalogMisses, t, tx };
