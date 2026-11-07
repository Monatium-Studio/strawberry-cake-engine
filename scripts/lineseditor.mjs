#!/usr/bin/env node
// 대사집 편집기: 게임 대사 파일(*.lines.ts)을 브라우저에서 고친다.
//   npm run lines                     → http://127.0.0.1:5180/
//   --port <n>                        다른 포트
//   --root <dir>                      프로젝트 뿌리 (기본: 지금 작업 폴더)
//   --src <dir>                       대사 파일을 찾을 폴더 (기본 src, 아래 폴더까지 *.lines.ts)
//   --speakers <file>                 화자 표 파일: `id: { who: '이름' ... }` 줄에서 화자 id → 자막 이름 (없으면 id 그대로)
//   --docs <dir>                      대본 폴더(*.md). 고친 문장이 거기에 정확히 한 번 나오면 그 대본도 같이 고친다
//   --order a,b,c                     파일 이름(확장자 빼고) 늘어놓을 순서
// 같은 값을 프로젝트 뿌리의 lines.config.json({ "src", "speakers", "docs", "order", "port" })에 둘 수도 있다 (인자가 우선).
// 대사는 { speaker: '...', text: '한국어', en: '...', ja: '...' } 꼴 객체 리터럴이다.
// 저장은 문자열 리터럴 자리만 바꿔 쓴다(다른 코드·주석·줄 바꿈은 그대로).
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(opt('--root', process.cwd()));
const cfgPath = join(root, 'lines.config.json');
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
const port = Number(opt('--port', cfg.port ?? 5180));
const SRC = join(root, opt('--src', cfg.src ?? 'src'));
const SPEAKERS = opt('--speakers', cfg.speakers) ? join(root, opt('--speakers', cfg.speakers)) : null;
const DOCS = opt('--docs', cfg.docs) ? join(root, opt('--docs', cfg.docs)) : null;
const ORDER = String(opt('--order', (cfg.order ?? []).join(',')) || '').split(',').filter(Boolean);
const FIELDS = ['text', 'en', 'ja'];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.lines.ts')) out.push(p);
  }
  return out;
}

function lineFiles() {
  return walk(SRC).sort(order);
}

// 주어진 순서(--order)로 늘어놓고, 나머지는 이름순
function order(a, b) {
  const base = (f) => f.split('/').pop().replace('.lines.ts', '');
  const ia = ORDER.indexOf(base(a));
  const ib = ORDER.indexOf(base(b));
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
}

/** 화자 id → 자막 이름 (화자 표 파일의 `id: { who: '이름'` 줄) */
function speakerNames() {
  if (!SPEAKERS || !existsSync(SPEAKERS)) return {};
  const src = readFileSync(SPEAKERS, 'utf8');
  const map = {};
  for (const m of src.matchAll(/^\s*([A-Za-z_][\w]*):\s*\{\s*who:\s*'([^']*)'/gm)) map[m[1]] = m[2];
  return map;
}

// ---------------------------------------------------------------- 문자열 리터럴
function decode(raw) {
  const q = raw[0];
  const body = raw.slice(1, -1);
  let s = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      s += c;
      continue;
    }
    const n = body[++i];
    if (n === 'n') s += '\n';
    else if (n === 't') s += '\t';
    else if (n === 'r') s += '\r';
    else if (n === '0') s += '\0';
    else if (n === 'u') {
      if (body[i + 1] === '{') {
        const e = body.indexOf('}', i);
        s += String.fromCodePoint(parseInt(body.slice(i + 2, e), 16));
        i = e;
      } else {
        s += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
        i += 4;
      }
    } else if (n === 'x') {
      s += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (n === '\n') {
      // 줄 이음
    } else s += n;
  }
  void q;
  return s;
}

function encode(value, quote) {
  let s = value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  if (quote === '`') s = s.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  else s = s.split(quote).join('\\' + quote);
  return quote + s + quote;
}

// ---------------------------------------------------------------- 훑기
/**
 * 파일을 훑어 { speaker, text, ... } 객체(대사)를 찾는다. 문자열·주석을 건너뛰고 괄호를 따라간다.
 * 대사마다 자리(묶음 이름), 화자, text/en/ja 리터럴의 시작·끝 자리를 돌려준다.
 */
function scan(src) {
  const stack = [];
  const lines = [];
  let i = 0;
  const n = src.length;
  const labelBefore = (pos) => {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (src[j] === ':') {
      j--;
      while (j >= 0 && /\s/.test(src[j])) j--;
      if (src[j] === "'" || src[j] === '"') {
        const q = src[j];
        const e = j;
        j--;
        while (j >= 0 && src[j] !== q) j--;
        return src.slice(j + 1, e);
      }
      const e = j + 1;
      while (j >= 0 && /[\w$]/.test(src[j])) j--;
      return src.slice(j + 1, e);
    }
    if (src[j] === '=') {
      const m = /(?:const|let|var)\s+([\w$]+)\s*(?::[^=]*)?$/.exec(src.slice(Math.max(0, j - 200), j));
      return m ? m[1] : '';
    }
    return '';
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      let dynamic = false;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i += 2;
        else if (c === '`' && src[i] === '$' && src[i + 1] === '{') {
          dynamic = true;
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
        } else i++;
      }
      i++;
      const end = i;
      const top = stack[stack.length - 1];
      if (top && top.ch === '{') {
        const key = labelBefore(start);
        if (key && !(key in top.props)) top.props[key] = { raw: src.slice(start, end), start, end, quote: c, dynamic };
      }
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push({ ch: c, start: i, label: labelBefore(i), props: {} });
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      const top = stack.pop();
      if (top && top.ch === '{' && top.props.speaker && top.props.text) {
        const path = stack.map((s) => s.label).filter((s) => s && s !== 'RAW');
        lines.push({ start: top.start, path, props: top.props });
      }
      i++;
      continue;
    }
    i++;
  }
  lines.sort((a, b) => a.start - b.start);
  return lines;
}

function view(file, names) {
  const src = readFileSync(file, 'utf8');
  return scan(src).map((l, idx) => {
    const fields = {};
    for (const k of FIELDS) {
      const p = l.props[k];
      if (p) fields[k] = { value: p.dynamic ? p.raw.slice(1, -1) : decode(p.raw), editable: !p.dynamic, quote: p.quote };
    }
    const sp = decode(l.props.speaker.raw);
    const extra = {};
    for (const [k, p] of Object.entries(l.props)) if (!['speaker', ...FIELDS].includes(k)) extra[k] = p.dynamic ? p.raw : decode(p.raw);
    return { idx, group: l.path.slice(-2).join(' › '), speaker: sp, who: names[sp] ?? sp, fields, extra };
  });
}

// ---------------------------------------------------------------- 대본 맞추기
function docFiles() {
  const dir = DOCS;
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

function syncDocs(pairs) {
  const files = docFiles();
  const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
  const out = [];
  for (const { old, value } of pairs) {
    if (!old || old === value) continue;
    let hits = 0;
    let where = null;
    for (const [f, s] of texts) {
      const c = s.split(old).length - 1;
      hits += c;
      if (c) where = f;
    }
    if (hits === 1) {
      texts.set(where, texts.get(where).replace(old, value));
      out.push({ old, ok: true, file: relative(root, where) });
    } else out.push({ old, ok: false, hits });
  }
  for (const [f, s] of texts) if (s !== readFileSync(f, 'utf8')) writeFileSync(f, s);
  return out;
}

// ---------------------------------------------------------------- 저장
function save(edits) {
  const byFile = new Map();
  const allowed = new Set(lineFiles().map((f) => relative(root, f)));
  const results = [];
  for (const e of edits) {
    if (!allowed.has(e.file) || !FIELDS.includes(e.key)) {
      results.push({ ...e, ok: false, why: '고칠 수 없는 자리' });
      continue;
    }
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  const docPairs = [];
  for (const [rel, list] of byFile) {
    const file = join(root, rel);
    let src = readFileSync(file, 'utf8');
    const lines = scan(src);
    const reps = [];
    for (const e of list) {
      const l = lines[e.idx];
      const p = l?.props[e.key];
      if (!p || p.dynamic) {
        results.push({ ...e, ok: false, why: '그 자리를 찾지 못함 (파일이 바뀌었다: 새로 불러오기)' });
        continue;
      }
      const cur = decode(p.raw);
      if (cur !== e.old) {
        results.push({ ...e, ok: false, why: '다른 곳에서 먼저 바뀌었다 (새로 불러오기)' });
        continue;
      }
      reps.push({ start: p.start, end: p.end, raw: encode(e.value, p.quote) });
      results.push({ ...e, ok: true });
      docPairs.push({ old: e.old, value: e.value });
    }
    reps.sort((a, b) => b.start - a.start);
    for (const r of reps) src = src.slice(0, r.start) + r.raw + src.slice(r.end);
    if (reps.length) writeFileSync(file, src);
  }
  const docs = syncDocs(docPairs);
  return { results, docs };
}

// ---------------------------------------------------------------- 서버
const page = readFileSync(join(here, 'lineseditor.html'), 'utf8');
// 화자 고르기·영어·일본어 체크박스는 게임 UI의 드롭다운·체크박스(src/ui/Dropdown.ts, Choice.ts)를 그대로 쓴다.
// 그 모듈(TS·?inline CSS)은 이 저장소의 Vite가 미들웨어로 바꿔 준다 (HMR 없음, 페이지는 위의 HTML 그대로)
const { createServer: createVite } = await import('vite');
const vite = await createVite({ root: join(here, '..'), configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false } });

const server = createServer((req, res) => {
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return send(200, page, 'text/html; charset=utf-8');
  if (req.method === 'GET' && req.url === '/api/lines') {
    try {
      const names = speakerNames();
      const files = lineFiles().map((f) => ({ file: relative(root, f), name: f.split('/').pop().replace('.lines.ts', '').replace('.ts', ''), lines: view(f, names) }));
      return send(200, { files });
    } catch (e) {
      return send(500, { error: String(e) });
    }
  }
  if (req.method === 'POST' && req.url === '/api/save') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        const { edits } = JSON.parse(body);
        const r = save(edits ?? []);
        console.log(`[lines] 저장 ${r.results.filter((x) => x.ok).length}건, 대본 ${r.docs.filter((x) => x.ok).length}건`);
        send(200, r);
      } catch (e) {
        send(500, { error: String(e) });
      }
    });
    return;
  }
  vite.middlewares(req, res, () => send(404, { error: 'not found' }));
});

process.on('SIGINT', () => vite.close().then(() => process.exit(0)));
server.listen(port, '127.0.0.1', () => {
  console.log(`[lines] 대사집 편집기: http://127.0.0.1:${port}/  (${relative(process.cwd(), root) || '.'})`);
});

export { scan, decode, encode };
