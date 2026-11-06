import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadModel, modelStats, type ModelStats } from '../render/loader';
import { CheekRig } from '../character/cheeks';

/**
 * 모델 뷰어
 *   /                                  갤러리 (왼쪽 목록 + 검색, 마우스로 회전). 목록에서 고르면 페이지 이동 없이 그 자리에서 바꾼다
 *                                      (주소는 history로 ?model=…에 맞춰 두어 새로고침·뒤로 가기·링크 공유가 된다)
 *   /?model=examples/example_crate.glb 한 모델 보기 (public/models 기준)
 *   &mode=sheet&views=front,34,side,back   2x2 시트 (스크린샷용)
 *   &focus=head                        특정 노드에 맞춰 화면 잡기
 *   &morph=smile:1  &anim=클립&t=초     표정·포즈 지정 (시트 모드)
 *   &shot=1                            사이드바 숨김
 *   &cheek=puff:1,squash:0.8,pullL:0.034;0;0.01,pullR:…,pull:…   볼 리그 상태 (시트 모드, 잡기는 x 바깥;y 위;z 앞 m)
 *   단일 보기에서 볼 리그가 있으면 오른쪽 아래에 볼 조작판 (P 부풀리기, S 눌림, L·R·B 잡아 늘이기, 스페이스 놓기, H 흔들기, J 달리기)
 * 검색: / 또는 Ctrl·Cmd+K로 검색칸, 띄어 쓴 낱말이 모두 경로에 들어 있는 모델만 남긴다. ↑↓로 고르고 Enter로 열기, Esc로 지우기.
 *        목록에 초점이 있을 때 ↑↓로 바로 앞뒤 모델을 연다.
 * 페이지 설정 (viewer.html의 <body> 속성): data-home="/" data-home-label="▶ 예제로" (돌아갈 링크, 없으면 숨김)
 * 모델 경로는 import.meta.env.BASE_URL 기준 models/, 목록은 __models.json (vite.config.ts의 modelsIndex)
 */

declare global {
  interface Window {
    __ready?: boolean;
    __error?: string;
    __stats?: ModelStats;
  }
}

type Vec3 = [number, number, number];
const VIEW_DIRS: Record<string, Vec3> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  side: [1, 0, 0],
  left: [1, 0, 0],
  right: [-1, 0, 0],
  top: [0, 1, 0.0001],
  bottom: [0, -1, 0.0001],
  '34': [1, 0.35, 1],
  '34r': [-1, 0.35, 1],
  '34b': [-1, 0.35, -1],
  forward: [0, 0, -1],
  low: [0.6, -0.25, 1],
};

/** 보기 방향: 이름(VIEW_DIRS) 또는 'x_y_z' 숫자 셋 (예: 0.5_-0.2_1 = 오른쪽 아래 앞에서). 각도별 점검용 */
function viewDir(v: string): Vec3 | undefined {
  if (VIEW_DIRS[v]) return VIEW_DIRS[v];
  const m = v.split('_').map(Number);
  return m.length === 3 && m.every(Number.isFinite) && m.some((x) => x !== 0) ? (m as Vec3) : undefined;
}

const BASE = import.meta.env.BASE_URL;
const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'single';
const focusName = params.get('focus');
const isShot = params.get('shot') === '1';
if (isShot) document.body.classList.add('shot');

const app = document.getElementById('app')!;
const home = document.body.dataset.home;
app.innerHTML =
  '<nav id="side"><h1>모델 뷰어</h1><div id="search"><input id="q" type="search" placeholder="검색 ( / )" autocomplete="off" spellcheck="false"><span id="count"></span></div>' +
  '<div id="list" tabindex="0">불러오는 중…</div></nav><div id="stage"><div id="hud"></div></div>';
if (home) {
  const a = document.createElement('a');
  a.href = home;
  a.className = 'to-game';
  a.textContent = document.body.dataset.homeLabel ?? '▶ 돌아가기';
  document.querySelector('#side h1')!.after(a);
}
const stage = document.getElementById('stage')!;
const hud = document.getElementById('hud')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(isShot ? 1 : Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x7f8794);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8078, 1.6));
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 200);
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(-1.2, 2.0, 1.5); // 카메라 기준 왼쪽 위 앞
camera.add(key);
key.target.position.set(0, 0, -1);
camera.add(key.target);
const rim = new THREE.DirectionalLight(0xdfe8ff, 0.9);
rim.position.set(1.5, 1.0, -2.0);
camera.add(rim);
rim.target.position.set(0, 0, -1);
camera.add(rim.target);
scene.add(camera);

// 바닥 원판 (y=0) + 1m 격자
const floor = new THREE.Group();
const disc = new THREE.Mesh(
  new THREE.CircleGeometry(1.2, 48).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x6d7480 }),
);
disc.position.y = -0.001;
floor.add(disc);
const grid = new THREE.GridHelper(2.4, 24, 0x5a606b, 0x666d78);
grid.position.y = 0;
floor.add(grid);
scene.add(floor);

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function fitCamera(box: THREE.Box3, dir: Vec3, aspect: number, fov = 30) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.05);
  const vFov = THREE.MathUtils.degToRad(fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const dist = radius / Math.sin(Math.min(vFov, hFov) / 2) * 1.02;
  const d = new THREE.Vector3(...dir).normalize();
  camera.fov = fov;
  camera.aspect = aspect;
  camera.near = Math.max(0.005, dist / 100);
  camera.far = dist * 10;
  camera.position.copy(center).addScaledVector(d, dist);
  camera.up.set(0, 1, 0);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return center;
}

function boxOf(obj: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (o.userData.isOutline) return;
    if ((o as THREE.Mesh).isMesh) box.expandByObject(o, true);
  });
  if (box.isEmpty()) box.setFromCenterAndSize(obj.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0.1, 0.1, 0.1));
  return box;
}

/** 특정 클립의 첫 프레임(또는 t초) 포즈를 적용 */
function applyPose(root: THREE.Object3D, animations: THREE.AnimationClip[], name: string | null, t = 0) {
  if (!name) return;
  const clip = animations.find((a) => a.name === name);
  if (!clip) throw new Error(`애니메이션 "${name}" 없음. 있는 것: ${animations.map((a) => a.name).join(', ') || '(없음)'}`);
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.setTime(t);
  root.updateMatrixWorld(true);
}

function statsText(path: string, s: ModelStats) {
  return [
    path,
    `tris ${s.triangles.toLocaleString()}  meshes ${s.meshes}  mats ${s.materials}  bones ${s.bones}`,
    `size(m) x${s.size[0]} y${s.size[1]} z${s.size[2]}  min y ${s.min[1]}`,
    s.animations.length ? `anims ${s.animations.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- 목록 + 검색

interface ModelFile {
  path: string;
  mtime: number;
}
/** 목록 항목 (보이는 순서) */
let items: { path: string; a: HTMLAnchorElement; h: HTMLElement }[] = [];
let cursor = -1; // 검색 중 ↑↓로 고른 항목 (보이는 것 중)
const SEARCH_KEY = 'sce-viewer.q';

const store = {
  get(k: string): string {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 저장 못 해도 된다 */
    }
  },
};

async function buildList(current: string | null) {
  const list = document.getElementById('list')!;
  try {
    const res = await fetch(`${BASE}__models.json`, { cache: 'no-store' });
    const files: ModelFile[] = await res.json();
    const groups = new Map<string, ModelFile[]>();
    for (const f of files) {
      const g = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(f);
    }
    list.innerHTML = '';
    items = [];
    for (const [g, fs] of [...groups].sort()) {
      const h = document.createElement('h2');
      h.textContent = g;
      list.appendChild(h);
      for (const f of fs) {
        const a = document.createElement('a');
        a.href = `?model=${encodeURIComponent(f.path)}`;
        a.textContent = f.path.slice(f.path.lastIndexOf('/') + 1).replace(/\.glb$/, '');
        a.title = f.path;
        a.addEventListener('click', (e) => {
          // 새 탭·창으로 여는 클릭은 브라우저에 맡긴다
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          void openModel(f.path, { push: true });
        });
        list.appendChild(a);
        items.push({ path: f.path, a, h });
      }
    }
    if (!files.length) list.textContent = 'models 아래에 .glb가 아직 없습니다.';
    markCurrent(current);
    applyFilter();
  } catch (e) {
    list.textContent = String(e);
  }
}

function markCurrent(path: string | null): void {
  for (const it of items) it.a.classList.toggle('on', it.path === path);
  const on = items.find((it) => it.path === path);
  on?.a.scrollIntoView({ block: 'nearest' });
}

function visibleItems() {
  return items.filter((it) => !it.a.hidden);
}

function applyFilter(): void {
  const q = (document.getElementById('q') as HTMLInputElement).value;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shownGroups = new Set<HTMLElement>();
  for (const it of items) {
    const p = it.path.toLowerCase();
    const show = words.every((w) => p.includes(w));
    it.a.hidden = !show;
    if (show) shownGroups.add(it.h);
  }
  for (const it of items) it.h.hidden = !shownGroups.has(it.h);
  const n = visibleItems().length;
  document.getElementById('count')!.textContent = words.length ? `${n} / ${items.length}` : `${items.length}`;
  setCursor(words.length && n ? 0 : -1);
}

function setCursor(i: number): void {
  const vis = visibleItems();
  for (const it of items) it.a.classList.remove('cur');
  cursor = vis.length ? Math.max(-1, Math.min(i, vis.length - 1)) : -1;
  if (cursor >= 0) {
    vis[cursor].a.classList.add('cur');
    vis[cursor].a.scrollIntoView({ block: 'nearest' });
  }
}

function setupSearch(): void {
  const q = document.getElementById('q') as HTMLInputElement;
  q.value = store.get(SEARCH_KEY);
  q.addEventListener('input', () => {
    store.set(SEARCH_KEY, q.value);
    applyFilter();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(cursor + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = visibleItems()[Math.max(0, cursor)];
      if (it) void openModel(it.path, { push: true });
    } else if (e.key === 'Escape') {
      if (q.value) {
        q.value = '';
        store.set(SEARCH_KEY, '');
        applyFilter();
      } else q.blur();
    }
  });
  // 목록에 초점: ↑↓로 앞뒤 모델 바로 열기
  const list = document.getElementById('list')!;
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const vis = visibleItems();
    const i = vis.findIndex((it) => it.path === currentPath);
    const next = vis[Math.max(0, Math.min(vis.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next && next.path !== currentPath) void openModel(next.path, { push: true });
  });
  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    if (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      q.focus();
      q.select();
    }
  });
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

// ---------------------------------------------------------------- 모델 열기

let currentPath: string | null = null;
/** 지금 보이는 모델 (다음 모델로 바꿀 때 걷는다) */
let shown: { root: THREE.Object3D; dispose(): void } | null = null;
let openSeq = 0;
let controls: OrbitControls | null = null;
let tick: ((dt: number) => void) | null = null;
let readyAfterFrame = false;

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints) m.geometry?.dispose();
  });
}

/** 모델 하나를 불러와 장면에 놓는다 (모프·볼·포즈 주소 인자 적용) */
async function loadInto(path: string, urlParams: URLSearchParams) {
  const url = `${BASE}models/${path}?v=${Date.now()}`;
  const { root, animations } = await loadModel(url);
  const stats = modelStats(root, animations);

  // 표정(모프)과 포즈(애니메이션 프레임) 지정: ?morph=smile:1,blink:0.5  ?anim=이름&t=초
  const morphParam = urlParams.get('morph');
  if (morphParam) {
    const wanted = morphParam.split(',').map((kv) => kv.split(':')) as [string, string][];
    const found = new Set<string>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.morphTargetDictionary || !m.morphTargetInfluences) return;
      for (const [name, v] of wanted) {
        const i = m.morphTargetDictionary[name];
        if (i !== undefined) {
          m.morphTargetInfluences[i] = Number(v ?? 1);
          found.add(name);
        }
      }
    });
    const missing = wanted.map(([n]) => n).filter((n) => !found.has(n));
    if (missing.length) throw new Error(`모프 타깃 없음: ${missing.join(', ')}`);
  }
  // 볼 리그 (cheek_L·cheek_R 본): ?cheek=puff:1,squash:1,pullL:x;y;z,pullR:…,pull:… (시트 모드 점검용)
  const cheeks = CheekRig.from(root);
  if (cheeks) cheeks.update(1 / 60);
  const cheekParam = urlParams.get('cheek');
  if (cheekParam) {
    if (!cheeks) throw new Error('볼 리그 없음 (cheek_L·cheek_R 본이 없다)');
    let pulled = false;
    for (const kv of cheekParam.split(',')) {
      const [k, v = '1'] = kv.split(':');
      if (k === 'pullL' || k === 'pullR' || k === 'pull') {
        const [x, y, z] = v.split(';').map(Number);
        cheeks.pull(k === 'pull' ? 'both' : k === 'pullL' ? 'L' : 'R', { x: x || 0, y: y || 0, z: z || 0 });
        pulled = true;
      }
    }
    if (pulled) for (let i = 0; i < 90; i++) cheeks.update(1 / 60);
    const st: { puff?: number; squash?: number } = {};
    for (const kv of cheekParam.split(',')) {
      const [k, v = '1'] = kv.split(':');
      if (k === 'puff') st.puff = Number(v);
      if (k === 'squash') st.squash = Number(v);
    }
    cheeks.set(st);
    root.updateMatrixWorld(true);
  }
  return { root, animations, stats, cheeks };
}

/** 시트 모드 (스크린샷용, 주소로만 쓴다) */
async function sheet(path: string) {
  const { root, animations, stats } = await loadInto(path, params);
  scene.add(root);
  window.__stats = stats;
  const animName = params.get('anim');
  if (animName) {
    const clip = animations.find((a) => a.name === animName);
    if (!clip) throw new Error(`애니메이션 "${animName}" 없음. 있는 것: ${animations.map((a) => a.name).join(', ')}`);
    const poseMixer = new THREE.AnimationMixer(root);
    poseMixer.clipAction(clip).play();
    poseMixer.setTime(Number(params.get('t') ?? 0));
    root.updateMatrixWorld(true);
  }
  let target: THREE.Object3D = root;
  if (focusName) {
    const f = root.getObjectByName(focusName);
    if (!f) throw new Error(`focus 노드 "${focusName}"를 찾지 못함. 노드: ${stats.nodes.join(', ')}`);
    target = f;
  }
  const box = boxOf(target);
  const views = (params.get('views') ?? 'front,34,side,back').split(',').slice(0, 4);
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const cols = views.length > 1 ? 2 : 1;
  const rows = views.length > 2 ? 2 : 1;
  const cw = Math.floor(w / cols);
  const ch = Math.floor(h / rows);
  renderer.setScissorTest(true);
  // 원점이 손잡이인 소품처럼 y<0으로 내려가는 모델은 바닥 원판이 가리므로 자동으로 숨김. ?floor=0/1로 강제
  const floorParam = params.get('floor');
  floor.visible = floorParam ? floorParam === '1' : !focusName && stats.min[1] > -0.02;
  views.forEach((v, i) => {
    const dir = viewDir(v);
    if (!dir) throw new Error(`알 수 없는 view "${v}". 가능: ${Object.keys(VIEW_DIRS).join(', ')} 또는 x_y_z`);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cw;
    const y = h - (row + 1) * ch; // GL 좌표는 아래에서 위
    renderer.setViewport(x, y, cw, ch);
    renderer.setScissor(x, y, cw, ch);
    fitCamera(box, dir, cw / ch);
    renderer.render(scene, camera);
    const label = document.createElement('div');
    label.className = 'label';
    label.style.left = `${x + 8}px`;
    label.style.top = `${row * ch + ch - 22}px`;
    label.textContent = v;
    stage.appendChild(label);
  });
  hud.textContent = statsText(path, stats) + (focusName ? `\nfocus: ${focusName}` : '');
  window.__ready = true;
}

/**
 * 단일 보기에서 모델을 바꾼다. 페이지를 다시 읽지 않는다 (렌더러·카메라 조작·목록·검색은 그대로).
 * push: 주소를 history에 쌓는다 (뒤로 가기로 앞 모델). 첫 열기와 뒤로 가기는 쌓지 않는다.
 * 첫 열기만 주소의 morph·cheek·anim·view·focus 인자를 쓴다.
 */
async function openModel(path: string | null, { push = false, first = false } = {}): Promise<void> {
  const seq = ++openSeq;
  window.__ready = false;
  if (push && path !== currentPath) {
    const u = new URL(location.href);
    u.search = path ? `?model=${encodeURIComponent(path)}` : '';
    history.pushState({ model: path }, '', u);
  }
  currentPath = path;
  markCurrent(path);
  document.title = path ? `${path.slice(path.lastIndexOf('/') + 1).replace(/\.glb$/, '')} · 모델 뷰어` : '모델 뷰어';
  if (!path) {
    shown?.dispose();
    shown = null;
    tick = null;
    hud.textContent = '왼쪽에서 모델을 고르세요.';
    window.__ready = true;
    return;
  }
  hud.textContent = `${path}\n불러오는 중…`;
  let loaded;
  try {
    loaded = await loadInto(path, first ? params : new URLSearchParams());
  } catch (e) {
    if (seq !== openSeq) return;
    hud.textContent = `오류: ${e}`;
    window.__error = String((e as Error)?.stack ?? e);
    return;
  }
  if (seq !== openSeq) {
    // 그 사이 다른 모델을 골랐다
    disposeTree(loaded.root);
    return;
  }
  shown?.dispose();
  const { root, animations, stats, cheeks } = loaded;
  scene.add(root);
  window.__stats = stats;
  window.__error = undefined;

  let target: THREE.Object3D = root;
  if (first && focusName) target = root.getObjectByName(focusName) ?? root;
  const dir = viewDir((first && params.get('view')) || '34') ?? VIEW_DIRS['34'];
  floor.visible = stats.min[1] > -0.02;
  const center = fitCamera(boxOf(target), dir, camera.aspect);
  controls!.target.copy(center);
  controls!.update();
  hud.textContent = statsText(path, stats);

  const mixer = animations.length ? new THREE.AnimationMixer(root) : null;
  const clipName = first ? params.get('anim') : null;
  if (mixer) {
    const clip = (clipName && animations.find((a) => a.name === clipName)) || animations[0];
    mixer.clipAction(clip).play();
  }
  const ac = new AbortController();
  const cheekPanel = cheeks ? cheekControls(cheeks, root, ac.signal) : null;
  tick = (dt) => {
    mixer?.update(dt);
    cheekPanel?.update(dt);
  };
  readyAfterFrame = true;
  shown = {
    root,
    dispose() {
      ac.abort();
      mixer?.stopAllAction();
      scene.remove(root);
      disposeTree(root);
    },
  };
}

async function main() {
  resize();
  const start = params.get('model');
  if (mode === 'sheet' && start) {
    await sheet(start);
    return;
  }
  if (!isShot) {
    setupSearch();
    void buildList(start);
  }
  controls = new OrbitControls(camera, renderer.domElement);
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    tick?.(dt);
    controls!.update();
    renderer.render(scene, camera);
    if (readyAfterFrame) {
      readyAfterFrame = false;
      window.__ready = true; // 새 모델이 한 번 그려진 뒤
    }
  });
  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(location.search).get('model');
    if (p !== currentPath) void openModel(p);
  });
  await openModel(start, { first: true });
}

/**
 * 볼 리그 조작판 (단일 보기). 흔들기·달리기는 모델 뿌리를 위아래로 움직여 머리 가속도로 볼이 출렁이는지 본다
 */
function cheekControls(cheeks: CheekRig, root: THREE.Object3D, signal: AbortSignal): { update(dt: number): void } {
  const base = root.position.clone();
  let puffOn = false;
  let run = false;
  let shakeT = -1;
  let t = 0;
  const panel = document.createElement('div');
  panel.id = 'cheeks';
  panel.innerHTML = '<b>볼 리그</b>';
  stage.appendChild(panel);
  signal.addEventListener('abort', () => panel.remove());
  const btn = (label: string, key: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = `${label} (${key})`;
    b.onclick = () => {
      fn();
      sync();
    };
    panel.appendChild(b);
    return b;
  };
  const togglePull = (side: 'L' | 'R' | 'both'): void => {
    const on = side === 'both' ? cheeks.pulled('L') && cheeks.pulled('R') : cheeks.pulled(side);
    if (on) cheeks.release(side === 'both' ? undefined : side);
    else cheeks.pull(side, { x: 0.034, y: -0.004, z: 0.012 });
  };
  const bPuff = btn('부풀리기', 'P', () => cheeks.puff((puffOn = !puffOn) ? 1 : 0));
  btn('눌림', 'S', () => cheeks.squash(1));
  const bL = btn('왼볼 늘리기', 'L', () => togglePull('L'));
  const bR = btn('오른볼 늘리기', 'R', () => togglePull('R'));
  const bB = btn('양볼 늘리기', 'B', () => togglePull('both'));
  btn('놓기', 'Space', () => cheeks.release());
  btn('흔들기', 'H', () => (shakeT = 0));
  const bRun = btn('달리기', 'J', () => (run = !run));
  const sync = (): void => {
    bPuff.classList.toggle('on', puffOn);
    bL.classList.toggle('on', cheeks.pulled('L'));
    bR.classList.toggle('on', cheeks.pulled('R'));
    bB.classList.toggle('on', cheeks.pulled('L') && cheeks.pulled('R'));
    bRun.classList.toggle('on', run);
  };
  const keys: Record<string, () => void> = {
    KeyP: () => cheeks.puff((puffOn = !puffOn) ? 1 : 0),
    KeyS: () => cheeks.squash(1),
    KeyL: () => togglePull('L'),
    KeyR: () => togglePull('R'),
    KeyB: () => togglePull('both'),
    Space: () => cheeks.release(),
    KeyH: () => (shakeT = 0),
    KeyJ: () => (run = !run),
  };
  window.addEventListener('keydown', (e) => {
    const f = keys[e.code];
    if (!f || e.repeat || isTyping(e)) return;
    e.preventDefault();
    f();
    sync();
  }, { signal });
  return {
    update(dt: number): void {
      t += dt;
      let y = 0;
      if (run) y += Math.abs(Math.sin(t * Math.PI * 2.6)) * 0.035;
      if (shakeT >= 0) {
        shakeT += dt;
        // 뛰어올랐다 떨어져 착지: 0.45초 포물선 + 착지 순간 눌림
        const T = 0.45;
        if (shakeT < T) y += 4 * 0.12 * (shakeT / T) * (1 - shakeT / T);
        else {
          shakeT = -1;
          cheeks.squash(0.9);
        }
      }
      root.position.set(base.x, base.y + y, base.z);
      root.updateMatrixWorld(true);
      cheeks.update(dt);
    },
  };
}

main().catch((e) => {
  console.error(e);
  window.__error = String(e?.stack ?? e);
  hud.textContent = `오류: ${e}`;
});
