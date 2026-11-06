#!/usr/bin/env node
// 예제 점검: Vite 서버를 이 프로세스 안에서 임의 포트(hmr 끔)로 띄우고, 시스템 Chrome(헤드리스)으로 examples/basic을 연다.
//   npm run examplecheck [-- --out shots/examplecheck]
// 1) 준비(내비메시 굽기 끝)를 기다려 스크린샷
// 2) 땅의 한 점을 진짜 마우스로 누르고 캡슐이 도착할 때까지 기다린다 (자리 전후를 찍는다)
// 3) 설정 메뉴(Esc)를 열어 스크린샷, 언어를 en으로 바꿔 글자가 바뀌는지 본다
// 콘솔 오류·페이지 오류가 있거나 캡슐이 움직이지 않으면 종료 코드 1. 서버와 브라우저는 끝에 닫는다.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const outDir = resolve(outArg >= 0 ? args[outArg + 1] : join(root, 'shots', 'examplecheck'));
mkdirSync(outDir, { recursive: true });

const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false } });
await server.listen();
const base = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.config.server.port}/`;

let code = 0;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  const t0 = Date.now();
  await page.goto(`${base}examples/basic/`);
  // 인트로 (엔진 첫 카드): 다 그려진 장면을 찍고 끝날 때까지 기다린다
  await page.waitForFunction(() => !!window.__intro || !!window.__error, null, { timeout: 20000 });
  await page.evaluate(() => window.__intro?.waitFor('credits', 2600));
  await page.screenshot({ path: join(outDir, '0-intro.png') });
  await page.waitForFunction(() => !window.__intro || !!window.__error, null, { timeout: 20000 });
  await page.waitForFunction(() => window.__demo?.ready === true || !!window.__error, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__error);
  if (err) throw new Error(`예제 오류: ${err}`);
  console.log(`준비: ${Date.now() - t0} ms, 내비 ${JSON.stringify(await page.evaluate(() => {
    const s = window.__demo.navStats();
    return { tiles: s.tiles, polys: s.polys, islands: s.keptIslands, pruned: s.prunedPolys, workers: s.workers };
  }))}`);
  const shot1 = join(outDir, '1-ready.png');
  await page.screenshot({ path: shot1 });

  const before = await page.evaluate(() => window.__demo.character());
  const goal = { x: -1, z: 6 };
  const pt = await page.evaluate(([x, z]) => window.__demo.clickWorld(x, z), [goal.x, goal.z]);
  if (!pt) throw new Error('목표 자리가 화면 밖');
  await page.mouse.click(pt.x, pt.y);
  const state0 = await page.evaluate(() => window.__demo.agent());
  await page.waitForFunction(() => ['arrived', 'failed'].includes(window.__demo.agent()), null, { timeout: 20000 });
  const after = await page.evaluate(() => window.__demo.character());
  const state1 = await page.evaluate(() => window.__demo.agent());
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  const miss = Math.hypot(after.x - goal.x, after.z - goal.z);
  console.log(`클릭: 화면 (${pt.x.toFixed(0)}, ${pt.y.toFixed(0)}) → 월드 (${goal.x}, 0, ${goal.z}), 상태 ${state0} → ${state1}`);
  console.log(`캡슐 전: ${JSON.stringify(before)}`);
  console.log(`캡슐 후: ${JSON.stringify(after)}`);
  console.log(`움직인 거리 ${moved.toFixed(2)} m, 목표까지 남은 거리 ${miss.toFixed(2)} m`);
  if (moved < 1 || state1 !== 'arrived') {
    console.error('캡슐이 목표까지 걷지 않았다');
    code = 1;
  }
  const shot2 = join(outDir, '2-arrived.png');
  await page.screenshot({ path: shot2 });
  // 내비메시 보기 (N)
  await page.keyboard.press('KeyN');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const shot2b = join(outDir, '2b-navmesh.png');
  await page.screenshot({ path: shot2b });
  await page.keyboard.press('KeyN');

  // 설정 메뉴 + 언어 바꾸기 (닫힌 섀도 루트: window.__ui로 들어간다)
  await page.keyboard.press('Escape');
  const ko = await page.evaluate(() => window.__ui.querySelector('.demo-hud b')?.textContent ?? '');
  await page.evaluate(() => {
    const ui = window.__ui;
    ui.querySelector('.sce-menu button[data-a="settings"]').click();
    const sel = ui.querySelector('.sce-menu select[data-x="lang"]');
    sel.value = 'en';
    sel.dispatchEvent(new Event('change'));
  });
  const en = await page.evaluate(() => window.__ui.querySelector('.demo-hud b')?.textContent ?? '');
  const menuOpen = await page.evaluate(() => !window.__ui.querySelector('.sce-menu').hidden);
  const shot3 = join(outDir, '3-settings-en.png');
  await page.screenshot({ path: shot3 });
  console.log(`설정 메뉴 열림: ${menuOpen}, 제목 ko "${ko}" → en "${en}"`);
  if (!menuOpen || ko === en) {
    console.error('설정 메뉴 또는 언어 바꾸기가 동작하지 않았다');
    code = 1;
  }
  // 다음 실행을 위해 언어를 되돌린다 (localStorage)
  await page.evaluate(() => localStorage.removeItem('sce-example.lang'));

  console.log(`스크린샷: ${shot1}\n           ${shot2}\n           ${shot2b}\n           ${shot3}`);
  console.log(`콘솔 오류: ${errors.length}개`);
  if (errors.length) {
    console.error(errors.join('\n'));
    code = 1;
  }
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);
