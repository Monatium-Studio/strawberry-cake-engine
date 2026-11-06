#!/usr/bin/env node
// 대사 파일에 en·ja를 채운다 (docs/I18N.md).
//   node scripts/i18n-fill.mjs <lines.ts> <translations.json> [--force-en] [--dry]
// translations.json: { "<줄 id>": { "en"?: "...", "ja"?: "..." } }  (i18n-check.mjs --dump의 출력 틀을 채운 것)
// - ja: 있으면 값을 바꾸고, 없으면 en 속성 뒤(en이 없으면 text 뒤)에 넣는다.
// - en: 없을 때만 넣는다. 이미 있는 영어는 --force-en일 때만 바꾼다 (확정된 영어를 지키려고).
// - 파일의 나머지 글자(서식, 주석, 다른 속성)는 건드리지 않는다.
import { readFileSync, writeFileSync } from 'node:fs';
import { getProp, linesOf, quote } from './i18n-lib.mjs';

const [file, jsonPath, ...rest] = process.argv.slice(2);
if (!file || !jsonPath) {
  console.error('사용법: node scripts/i18n-fill.mjs <lines.ts> <translations.json> [--force-en] [--dry]');
  process.exit(2);
}
const forceEn = rest.includes('--force-en');
const dry = rest.includes('--dry');
const tr = JSON.parse(readFileSync(jsonPath, 'utf8'));
const { src, lines } = linesOf(file);
const byId = new Map(lines.map((l) => [l.id, l]));

/** [위치, 지울 길이, 넣을 글자] */
const edits = [];
let nEn = 0;
let nJa = 0;
const unknown = [];
for (const [id, t] of Object.entries(tr)) {
  const l = byId.get(id);
  if (!l) {
    unknown.push(id);
    continue;
  }
  const n = l.node;
  const textP = getProp(n, 'text');
  const enP = getProp(n, 'en');
  const jaP = getProp(n, 'ja');
  const en = typeof t.en === 'string' && t.en.trim() ? t.en : null;
  const ja = typeof t.ja === 'string' && t.ja.trim() ? t.ja : null;
  let after = enP ?? textP;
  let insert = '';
  if (en) {
    if (enP && forceEn) {
      edits.push([enP.value.start, enP.value.end - enP.value.start, quote(en)]);
      nEn++;
    } else if (!enP) {
      insert += `, en: ${quote(en)}`;
      after = textP;
      nEn++;
    }
  }
  if (ja) {
    if (jaP) edits.push([jaP.value.start, jaP.value.end - jaP.value.start, quote(ja)]);
    else insert += `, ja: ${quote(ja)}`;
    nJa++;
  }
  if (insert) edits.push([after.end, 0, insert]);
}

edits.sort((a, b) => b[0] - a[0]);
let out = src;
for (const [pos, del, ins] of edits) out = out.slice(0, pos) + ins + out.slice(pos + del);
if (!dry) writeFileSync(file, out);
console.log(`${file}: en ${nEn}줄, ja ${nJa}줄${dry ? ' (dry run)' : ''}`);
if (unknown.length) console.log(`파일에 없는 id ${unknown.length}개: ${unknown.join(', ')}`);
