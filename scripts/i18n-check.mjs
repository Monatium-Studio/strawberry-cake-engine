#!/usr/bin/env node
// 다국어 점검 (docs/I18N.md). 경로는 i18n.config.json (scripts/i18n-lib.mjs)
//   node scripts/i18n-check.mjs                 대사 파일별 en·ja 수, 화면 문구 카탈로그 적용률
//   node scripts/i18n-check.mjs --missing       빠진 대사(id·한국어)와 카탈로그에 없는 화면 문구 목록
//   node scripts/i18n-check.mjs --dump <file>   그 대사 파일에서 en·ja가 빠진 줄을 JSON으로 (i18n-fill.mjs 입력 틀)
//   node scripts/i18n-check.mjs --screen <path> 그 경로(파일·폴더 앞부분)의 화면 문구 중 카탈로그에 없는 것을 JSON 틀로
// 화면 문구 = CONFIG.src 아래 .ts의 한글 문자열 리터럴 (대사 객체, 콘솔·오류 메시지, 데이터 속성, 무시 목록 제외).
// 무시: 같은 줄이나 바로 윗줄 주석에 `i18n-ignore`, 카탈로그 파일의 `export const IGNORE = [...]`, CONFIG.ignoreFile.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG, HANGUL, ROOT, getProp, isLineObject, linesOf, listTs, literal, loadCatalog, lookup, needsText, norm, parseFile, propName, rel, walk,
} from './i18n-lib.mjs';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const arg = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

// ------------------------------------------------------------------ 대사
const lineFiles = listTs(join(ROOT, CONFIG.lines), (p) => /\.lines(\.placeholder)?\.ts$/.test(p));

if (arg('--dump')) {
  const file = join(ROOT, arg('--dump'));
  const { lines } = linesOf(file);
  const out = {};
  for (const l of lines) {
    if (!needsText(l.text)) continue;
    if (l.en && l.ja) continue;
    out[l.id] = { speaker: l.speaker, ko: l.text, ...(l.en ? { en_existing: l.en } : { en: '' }), ja: l.ja ?? '' };
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

const rows = [];
const missingLines = [];
const dupIds = [];
for (const f of lineFiles) {
  const { lines } = linesOf(f);
  const seen = new Set();
  let total = 0;
  let en = 0;
  let ja = 0;
  for (const l of lines) {
    if (!needsText(l.text)) continue;
    if (seen.has(l.id)) dupIds.push(`${rel(f)}: ${l.id}`);
    seen.add(l.id);
    total++;
    if (l.en) en++;
    if (l.ja) ja++;
    if (!l.en || !l.ja) missingLines.push({ file: rel(f), id: l.id, miss: [!l.en && 'en', !l.ja && 'ja'].filter(Boolean).join('+'), text: l.text });
  }
  rows.push({ file: rel(f).replace(`${CONFIG.lines}/`, ''), total, en, ja });
}

// ------------------------------------------------------------------ 화면 문구
// 개발 도구·디버그 표시·셰이더 (사용자 화면에 나오지 않는다): CONFIG.skip(폴더 앞부분), CONFIG.skipFiles
const SKIP_DIRS = [`${CONFIG.catalog}/`, ...CONFIG.skip];
const SKIP_FILES = CONFIG.skipFiles;
const SKIP_PROPS = new Set(['speaker', 'expr', 'gesture', 'npc', 'cls', 'pose', 'anim', 'id']);
const ignoreFile = join(ROOT, CONFIG.ignoreFile);
const IGNORE = new Set(existsSync(ignoreFile) ? JSON.parse(readFileSync(ignoreFile, 'utf8')).map(norm) : []);
const cat = loadCatalog();

const screenFiles = listTs(join(ROOT, CONFIG.src), (p) => {
  const r = rel(p);
  return !SKIP_DIRS.some((d) => r.startsWith(d)) && !SKIP_FILES.includes(r);
});

const screen = []; // { file, line, key, en, ja }
for (const f of screenFiles) {
  const src = readFileSync(f, 'utf8');
  if (!HANGUL.test(src)) continue;
  const { program, comments } = parseFile(f);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const ignoredLines = new Set();
  for (const c of comments) {
    if (!/i18n-ignore/.test(src.slice(c.start, c.end))) continue;
    const ln = lineOf(c.start);
    ignoredLines.add(ln);
    ignoredLines.add(ln + 1);
  }
  walk(program, (n, parent) => {
    if (isLineObject(n)) return false;
    if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'TSLiteralType') return false;
    if (n.type === 'TSTypeAliasDeclaration' || n.type === 'TSInterfaceDeclaration') return false;
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (c?.type === 'MemberExpression' && c.object?.type === 'Identifier' && c.object.name === 'console') return false;
    }
    if (n.type === 'NewExpression' && n.callee?.type === 'Identifier' && /Error$/.test(n.callee.name)) return false;
    if ((n.type === 'Property' || n.type === 'ObjectProperty') && SKIP_PROPS.has(propName(n))) return false;
    let key;
    if (n.type === 'Literal' && typeof n.value === 'string') {
      if ((parent?.type === 'Property' || parent?.type === 'ObjectProperty') && parent.key === n) return;
      key = n.value;
    } else if (n.type === 'TemplateLiteral') {
      key = n.quasis.map((q, i) => q.value.cooked + (i < n.expressions.length ? `{${i}}` : '')).join('');
      // 템플릿 안의 식(문자열 리터럴 포함)도 따로 본다
    } else return;
    if (!HANGUL.test(key)) return;
    // 셰이더 소스 (한글은 GLSL 주석)
    if (/\bvoid main\s*\(|gl_FragColor|gl_Position|\buniform\s+\w+\s+\w+;/.test(key)) return;
    const ln = lineOf(n.start);
    if (ignoredLines.has(ln)) return;
    const k = norm(key);
    if (IGNORE.has(k) || cat.ignore.has(k)) return;
    const hit = lookup(cat, k);
    screen.push({ file: rel(f), line: ln, key: k, en: !!hit?.en, ja: !!hit?.ja });
  });
}

if (arg('--screen')) {
  const prefix = arg('--screen');
  const out = {};
  for (const s of screen) if (s.file.startsWith(prefix) && !(s.en && s.ja)) out[s.key] = { en: '', ja: '', at: `${s.file}:${s.line}` };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

// ------------------------------------------------------------------ 보고
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

console.log('\n대사 (*.lines.ts, 글자가 있는 줄)');
console.log(`${pad('파일', 32)}${padl('ko', 6)}${padl('en', 6)}${padl('ja', 6)}`);
const sum = { total: 0, en: 0, ja: 0 };
for (const r of rows) {
  console.log(`${pad(r.file, 32)}${padl(r.total, 6)}${padl(r.en, 6)}${padl(r.ja, 6)}`);
  sum.total += r.total;
  sum.en += r.en;
  sum.ja += r.ja;
}
console.log(`${pad('합계', 32)}${padl(sum.total, 6)}${padl(sum.en, 6)}${padl(sum.ja, 6)}   en ${pct(sum.en, sum.total)} · ja ${pct(sum.ja, sum.total)}`);

const byFile = new Map();
for (const s of screen) {
  const r = byFile.get(s.file) ?? { total: 0, en: 0, ja: 0 };
  r.total++;
  if (s.en) r.en++;
  if (s.ja) r.ja++;
  byFile.set(s.file, r);
}
const st = { total: screen.length, en: screen.filter((s) => s.en).length, ja: screen.filter((s) => s.ja).length };
console.log(`\n화면 문구 (${CONFIG.src}의 한글 문자열 → 카탈로그·UI 사전)`);
if (flag('--files') || flag('--missing')) {
  for (const [f, r] of [...byFile].sort((a, b) => b[1].total - b[1].ja - (a[1].total - a[1].ja))) {
    if (r.ja === r.total && !flag('--files')) continue;
    console.log(`${pad(f.replace(`${CONFIG.src}/`, ''), 44)}${padl(r.total, 5)}${padl(r.en, 5)}${padl(r.ja, 5)}`);
  }
}
console.log(`${pad('합계', 44)}${padl(st.total, 5)}${padl(st.en, 5)}${padl(st.ja, 5)}   en ${pct(st.en, st.total)} · ja ${pct(st.ja, st.total)}`);
console.log(`카탈로그 항목 ${cat.exact.size} · UI 사전 ${cat.ui.size}`);

if (dupIds.length) console.log(`\n겹치는 대사 id: ${dupIds.join(', ')}`);
if (cat.conflicts.length) {
  console.log(`\n카탈로그끼리 번역이 다른 원문 ${cat.conflicts.length}개 (나중에 읽힌 파일이 이긴다)`);
  for (const c of cat.conflicts) console.log(`  ${c.key}\n    ${c.a.file}: ${c.a.en} / ${c.a.ja}\n    ${c.b.file}: ${c.b.en} / ${c.b.ja}`);
}

if (flag('--missing')) {
  if (missingLines.length) {
    console.log(`\n빠진 대사 ${missingLines.length}줄`);
    for (const m of missingLines) console.log(`  ${m.file} ${m.id} [${m.miss}] ${m.text}`);
  }
  const ms = screen.filter((s) => !s.en || !s.ja);
  if (ms.length) {
    console.log(`\n카탈로그에 없는 화면 문구 ${ms.length}개`);
    for (const s of ms) console.log(`  ${s.file}:${s.line} [${!s.en ? 'en+' : ''}ja] ${s.key}`);
  }
}

if (flag('--strict') && (missingLines.length || screen.some((s) => !s.ja))) process.exit(1);
