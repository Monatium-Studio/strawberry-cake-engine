import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadModel, modelStats, type ModelStats } from '../render/loader';

/**
 * 모델 뷰어
 *   /                                  갤러리 (왼쪽 목록, 마우스로 회전)
 *   /?model=examples/example_crate.glb 한 모델 보기 (public/models 기준)
 *   &mode=sheet&views=front,34,side,back   2x2 시트 (스크린샷용)
 *   &focus=head                        특정 노드에 맞춰 화면 잡기
 *   &morph=smile:1  &anim=클립&t=초     표정·포즈 지정 (시트 모드)
 *   &shot=1                            사이드바 숨김
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

const params = new URLSearchParams(location.search);
const modelPath = params.get('model');
const mode = params.get('mode') ?? 'single';
const focusName = params.get('focus');
const isShot = params.get('shot') === '1';
if (isShot) document.body.classList.add('shot');

const app = document.getElementById('app')!;
app.innerHTML = `<nav id="side"><h1>모델 뷰어</h1><a href="/" class="to-game">▶ 예제로</a><div id="list">불러오는 중…</div></nav><div id="stage"><div id="hud"></div></div>`;
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

async function buildList() {
  const list = document.getElementById('list')!;
  try {
    const res = await fetch('/__models.json');
    const files: { path: string; mtime: number }[] = await res.json();
    const groups = new Map<string, typeof files>();
    for (const f of files) {
      const g = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(f);
    }
    list.innerHTML = '';
    for (const [g, fs] of [...groups].sort()) {
      const h = document.createElement('h2');
      h.textContent = g;
      list.appendChild(h);
      for (const f of fs) {
        const a = document.createElement('a');
        a.href = `?model=${encodeURIComponent(f.path)}`;
        a.textContent = f.path.slice(f.path.lastIndexOf('/') + 1).replace(/\.glb$/, '');
        if (f.path === modelPath) a.className = 'on';
        list.appendChild(a);
      }
    }
    if (!files.length) list.textContent = 'public/models 아래에 .glb가 아직 없습니다.';
  } catch (e) {
    list.textContent = String(e);
  }
}

async function main() {
  resize();
  if (!isShot) buildList();
  if (!modelPath) {
    hud.textContent = '왼쪽에서 모델을 고르세요.';
    renderer.render(scene, camera);
    window.__ready = true;
    return;
  }

  const url = `/models/${modelPath}?v=${Date.now()}`;
  const { root, animations } = await loadModel(url);
  scene.add(root);
  const stats = modelStats(root, animations);
  window.__stats = stats;

  // 표정(모프)과 포즈(애니메이션 프레임) 지정: ?morph=smile:1,blink:0.5  ?anim=이름&t=초
  const morphParam = params.get('morph');
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
  const animName = params.get('anim');
  let poseMixer: THREE.AnimationMixer | null = null;
  if (animName && mode !== 'single') {
    const clip = animations.find((a) => a.name === animName);
    if (!clip) throw new Error(`애니메이션 "${animName}" 없음. 있는 것: ${animations.map((a) => a.name).join(', ')}`);
    poseMixer = new THREE.AnimationMixer(root);
    poseMixer.clipAction(clip).play();
    poseMixer.setTime(Number(params.get('t') ?? 0));
    root.updateMatrixWorld(true);
  }
  void poseMixer;

  let target: THREE.Object3D = root;
  if (focusName) {
    const f = root.getObjectByName(focusName);
    if (!f) throw new Error(`focus 노드 "${focusName}"를 찾지 못함. 노드: ${stats.nodes.join(', ')}`);
    target = f;
  }
  const box = boxOf(target);

  if (mode === 'sheet') {
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
      const dir = VIEW_DIRS[v];
      if (!dir) throw new Error(`알 수 없는 view "${v}". 가능: ${Object.keys(VIEW_DIRS).join(', ')}`);
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
    hud.textContent = statsText(modelPath, stats) + (focusName ? `\nfocus: ${focusName}` : '');
    window.__ready = true;
    return;
  }

  // 단일 보기 (마우스 회전)
  const dir = VIEW_DIRS[params.get('view') ?? '34'] ?? VIEW_DIRS['34'];
  const center = fitCamera(box, dir, camera.aspect);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.update();
  hud.textContent = statsText(modelPath, stats);
  const mixer = animations.length ? new THREE.AnimationMixer(root) : null;
  const clipName = params.get('anim');
  if (mixer) {
    const clip = (clipName && animations.find((a) => a.name === clipName)) || animations[0];
    mixer.clipAction(clip).play();
  }
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    mixer?.update(clock.getDelta());
    controls.update();
    renderer.render(scene, camera);
    window.__ready = true;
  });
}

main().catch((e) => {
  console.error(e);
  window.__error = String(e?.stack ?? e);
  hud.textContent = `오류: ${e}`;
});
