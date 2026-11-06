#!/usr/bin/env node
// 모델 스크린샷: Vite 서버를 이 프로세스 안에서 임의 포트로 띄우고, 시스템 Chrome(헤드리스)으로 뷰어를 찍는다.
// 여러 에이전트가 동시에 실행해도 서로 포트가 겹치지 않는다.
//
// 사용법:
//   npm run shot -- examples/example_crate.glb                   # 2x2 시트 (front,34,side,back)
//   npm run shot -- examples/example_crate.glb --views side,34,top,forward
//   npm run shot -- characters/hero.glb --focus head --views front,34
//   npm run shot -- examples/example_crate.glb --mode single --view 34
//   옵션: --out <png 경로>  --size 1600x1200
// 결과: PNG 경로와 모델 통계(JSON)를 출력. 렌더 오류나 콘솔 에러가 있으면 종료 코드 1.

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const model = args.find((a) => !a.startsWith('--') && !isOptValue(a));
function isOptValue(a) {
  const i = args.indexOf(a);
  return i > 0 && args[i - 1].startsWith('--');
}
function opt(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
if (!model) {
  console.error('사용법: npm run shot -- <public/models 기준 경로.glb> [--views a,b,c,d] [--focus 노드] [--mode sheet|single] [--view 34] [--out png] [--size WxH]');
  process.exit(2);
}

const mode = opt('mode', 'sheet');
const [w, h] = opt('size', '1600x1200').split('x').map(Number);
const q = new URLSearchParams({ model, mode, shot: '1' });
for (const k of ['views', 'focus', 'fov', 'view', 'floor', 'morph', 'anim', 't']) {
  const v = opt(k);
  if (v) q.set(k, v);
}
const slug = model.replace(/\.glb$/, '').replace(/[\/]/g, '__');
const suffix = [mode !== 'sheet' ? mode : '', opt('morph') ? 'm-' + opt('morph').replace(/[:,.]/g, '_') : '', opt('anim') ? 'a-' + opt('anim') + '-' + (opt('t') ?? '0') : '', opt('focus') ?? ''].filter(Boolean).join('-');
const out = resolve(opt('out', join(root, 'shots', `${slug}${suffix ? '-' + suffix : ''}.png`)));
mkdirSync(dirname(out), { recursive: true });

const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 0, strictPort: false, host: '127.0.0.1' } });
await server.listen();
const base = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.config.server.port}/`;

let code = 0;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(`${base}viewer.html?${q}`);
  await page.waitForFunction(() => window.__ready === true || !!window.__error, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__error);
  await page.screenshot({ path: out });
  const stats = await page.evaluate(() => window.__stats);
  console.log(out);
  if (stats) console.log(JSON.stringify(stats));
  if (err) { console.error('렌더 오류:', err); code = 1; }
  const real = errors.filter((e) => !/favicon/.test(e));
  if (real.length) { console.error('콘솔 에러:\n' + real.join('\n')); code = 1; }
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);
