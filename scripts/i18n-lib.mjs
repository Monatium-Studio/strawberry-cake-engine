// i18n 점검·채우기 공용: TS 파일을 oxc(rolldown/utils, vite 8에 딸려 온다)로 읽어 대사 객체와 한글 문자열을 찾는다.
// 경로는 프로젝트 뿌리(지금 작업 폴더)의 i18n.config.json으로 정한다 (없으면 기본값):
//   { "src": "src", "lines": "src", "catalog": "src/i18n/catalog", "skip": ["src/dev/"], "skipFiles": [], "ignoreFile": "scripts/i18n-ignore.json" }
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'rolldown/utils';

export const ROOT = process.cwd();
const cfgPath = join(ROOT, 'i18n.config.json');
/** 설정 (i18n.config.json) */
export const CONFIG = {
  src: 'src',
  lines: 'src',
  catalog: 'src/i18n/catalog',
  skip: [],
  skipFiles: [],
  ignoreFile: 'scripts/i18n-ignore.json',
  ...(existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}),
};
export const HANGUL = /[ㄱ-ㆎ가-힣]/;
export const LETTER = /[\p{L}]/u;

export function parseFile(file) {
  const src = readFileSync(file, 'utf8');
  const r = parseSync(file, src, { lang: 'ts' });
  return { src, program: r.program, comments: r.comments ?? [], errors: r.errors ?? [] };
}

/** 리터럴 값 (문자열, 식 없는 템플릿, 문자열 + 문자열). 아니면 undefined */
export function literal(node) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map((q) => q.value.cooked).join('');
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const a = literal(node.left);
    const b = literal(node.right);
    return a !== undefined && b !== undefined ? a + b : undefined;
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') return literal(node.expression);
  return undefined;
}

export function propName(p) {
  if (!p || (p.type !== 'Property' && p.type !== 'ObjectProperty')) return undefined;
  const k = p.key;
  if (!k) return undefined;
  if (k.type === 'Identifier') return k.name;
  if (k.type === 'Literal') return String(k.value);
  return undefined;
}

export function getProp(obj, name) {
  return obj.properties?.find((p) => propName(p) === name);
}

/** 깊이 우선 순회. fn(node, parent, ancestors) */
export function walk(node, fn, parent = null, anc = []) {
  if (!node || typeof node.type !== 'string') return;
  if (fn(node, parent, anc) === false) return;
  anc.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walk(c, fn, node, anc);
    } else if (v && typeof v.type === 'string') walk(v, fn, node, anc);
  }
  anc.pop();
}

/** 대사 객체: speaker와 text(문자열)가 있는 객체 리터럴 */
export function isLineObject(n) {
  return n?.type === 'ObjectExpression' && getProp(n, 'speaker') && literal(getProp(n, 'text')?.value) !== undefined;
}

/**
 * 대사 파일에서 대사 객체를 id와 함께 꺼낸다.
 * id: 객체의 id 속성, 없으면 `<배열을 담은 속성 키>_<nn>`
 */
export function linesOf(file) {
  const { src, program } = parseFile(file);
  const out = [];
  walk(program, (n, parent, anc) => {
    if (!isLineObject(n)) return;
    let id = literal(getProp(n, 'id')?.value);
    if (!id && parent?.type === 'ArrayExpression') {
      const holder = anc[anc.length - 2];
      const key = propName(holder);
      if (key) id = `${key}_${String(parent.elements.indexOf(n) + 1).padStart(2, '0')}`;
    }
    const v = (k) => literal(getProp(n, k)?.value);
    out.push({ id: id ?? `@${n.start}`, node: n, speaker: v('speaker'), text: v('text'), en: v('en'), ja: v('ja') });
    return false;
  });
  return { src, lines: out };
}

/** 번역이 필요한 문장인지 (글자가 하나라도 있으면). '......' 같은 줄은 빼고 센다 */
export const needsText = (s) => !!s && LETTER.test(s.replace(/\{[^}]*\}/g, ''));

export function listTs(dir, filter = () => true) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listTs(p, filter));
    else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name) && filter(p)) out.push(p);
  }
  return out.sort();
}

export const rel = (p) => relative(ROOT, p);
export const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** 카탈로그(CONFIG.catalog 아래 *.ts의 기본 내보내기 객체)와 UI 사전(ko 값)을 읽는다 */
export function loadCatalog() {
  const exact = new Map();
  const patterns = [];
  const ignore = new Set();
  const conflicts = [];
  const dir = join(ROOT, CONFIG.catalog);
  for (const file of existsSync(dir) ? listTs(dir) : []) {
    const { program } = parseFile(file);
    // export const IGNORE = ['…']: 화면에 나오지 않는 한글 문자열 (데이터, 디버그 표시)
    walk(program, (n) => {
      if (n.type !== 'VariableDeclarator' || n.id?.name !== 'IGNORE' || n.init?.type !== 'ArrayExpression') return;
      for (const el of n.init.elements) {
        const v = literal(el);
        if (v !== undefined) ignore.add(norm(v));
      }
      return false;
    });
    walk(program, (n) => {
      if (n.type !== 'ObjectExpression') return;
      // 값이 { en, ja } 객체인 속성들을 모은다
      const props = n.properties.filter((p) => p.value?.type === 'ObjectExpression' && (getProp(p.value, 'en') || getProp(p.value, 'ja')));
      if (!props.length) return;
      for (const p of props) {
        const key = propName(p);
        if (!key) continue;
        const e = { en: literal(getProp(p.value, 'en')?.value), ja: literal(getProp(p.value, 'ja')?.value), file: rel(file) };
        const k = norm(key);
        const prev = exact.get(k);
        if (prev && (prev.en !== e.en || prev.ja !== e.ja)) conflicts.push({ key: k, a: prev, b: e });
        if (/\{\d\}/.test(k)) {
          const re = new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\d\\\}/g, '[\\s\\S]+?')}$`);
          patterns.push({ key: k, re, e });
        }
        exact.set(k, e);
      }
      return false;
    });
  }
  // UI 사전 (UI_STRINGS와 registerStrings({...}) 호출): ko 값은 다룬 것으로 본다
  const ui = new Map();
  for (const file of listTs(join(ROOT, CONFIG.src))) {
    const src = readFileSync(file, 'utf8');
    if (!/registerStrings|UI_STRINGS/.test(src)) continue;
    const { program } = parseFile(file);
    walk(program, (n) => {
      if (n.type !== 'ObjectExpression') return;
      const ko = literal(getProp(n, 'ko')?.value);
      if (ko !== undefined) ui.set(norm(ko), { en: literal(getProp(n, 'en')?.value), ja: literal(getProp(n, 'ja')?.value) });
    });
  }
  return { exact, patterns, ui, ignore, conflicts };
}

/** 원문이 카탈로그·UI 사전에 있는지. 있으면 { en, ja } */
export function lookup(cat, key) {
  const k = norm(key);
  return cat.exact.get(k) ?? cat.ui.get(k) ?? cat.patterns.find((p) => p.re.test(k))?.e;
}

/** JS 문자열 리터럴로 (작은따옴표, 안에 '가 있고 "가 없으면 큰따옴표) */
export function quote(s) {
  const body = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  if (s.includes("'") && !s.includes('"')) return `"${body}"`;
  return `'${body.replace(/'/g, "\\'")}'`;
}
