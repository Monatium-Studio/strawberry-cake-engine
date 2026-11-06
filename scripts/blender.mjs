#!/usr/bin/env node
// Blender 모델 스크립트 실행기: npm run model -- art/blender/examples/example_crate.py [-- 추가 인자]
// 백그라운드(-b), 공장 초기 설정(--factory-startup)으로 실행하고 파이썬 예외 시 종료 코드 1.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.BLENDER,
  '/Applications/Blender.app/Contents/MacOS/Blender',
  'blender',
].filter(Boolean);
const blender = candidates.find((c) => c === 'blender' || existsSync(c));

const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error('사용법: npm run model -- <art/blender/... .py> [-- 스크립트 인자]');
  process.exit(2);
}
const extra = rest[0] === '--' ? rest.slice(1) : rest;
const r = spawnSync(
  blender,
  ['-b', '--factory-startup', '--python-exit-code', '1', '-P', resolve(root, script), '--', ...extra],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, PROJECT_ROOT: root } },
);
// Blender의 시작 배너와 잡음을 줄이고 스크립트 출력과 오류만 보여준다
const noise = /^(Blender \d|Read prefs|Warning: Unable to open|Color management|.*\bfra:|Read blend|Blender quit|$)/;
const lines = (r.stdout + '\n' + r.stderr).split('\n').filter((l) => !noise.test(l));
console.log(lines.join('\n'));
process.exit(r.status ?? 1);
