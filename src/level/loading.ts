import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyDepthBias, applyOutlines, prepareOutlines, toToon } from '../render/toon';
import { splitProgramVariants } from '../render/variants';
import type { LoadedModel } from '../render/loader';
import { Assets } from '../core/Assets';
import type { Engine } from '../core/Engine';

/**
 * 연출·메뉴가 도는 동안 끊김 없이 불러오기 위한 도구.
 * - Slicer: 한 번에 budget ms까지만 일하고 다음 프레임으로 넘긴다
 * - SlicedAssets: Assets와 같은 캐시·인터페이스지만 툰 변환·아웃라인 헐 생성을 메시 단위로 나눠 한다
 *   (아웃라인 헐의 정점 병합이 무거워서, 한 번에 하면 인물 하나에 수십 ms가 막힌다)
 * - LoadTracker: 로딩 진행률 (로딩 화면 표시용)
 */

const nextFrame = () =>
  new Promise<void>((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      // 렌더가 끝난 뒤에 일하도록 한 번 더 미룬다
      setTimeout(resolve, 0);
    };
    requestAnimationFrame(go);
    setTimeout(go, 50); // 탭이 가려져 rAF가 멈춰도 로딩은 계속
  });

export class Slicer {
  private start = performance.now();
  constructor(public budgetMs = 5) {}

  /** 예산을 넘겼으면 다음 프레임까지 양보한다 */
  async tick(): Promise<void> {
    if (performance.now() - this.start < this.budgetMs) return;
    await nextFrame();
    this.start = performance.now();
  }

  async yieldNow(): Promise<void> {
    await nextFrame();
    this.start = performance.now();
  }
}

/** 하나의 공유 슬라이서: 동시에 도는 로딩 작업들이 같은 예산을 나눠 쓴다 */
export const loadSlicer = new Slicer(5);

const gltfLoader = new GLTFLoader();

/** loadModel과 같은 결과를 메시 단위로 나눠 만든다 */
export async function loadModelSliced(url: string, slicer: Slicer = loadSlicer): Promise<LoadedModel> {
  const gltf = await gltfLoader.loadAsync(url);
  await slicer.tick();
  const root = gltf.scene;
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) meshes.push(m);
  });
  for (const mesh of meshes) {
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toToon) : toToon(mesh.material);
    applyDepthBias(mesh);
  }
  await slicer.tick();
  const tick = () => slicer.tick();
  for (const mesh of meshes) {
    // 자식 메시는 따로 처리하므로 잠시 떼어 두고 이 메시에만 헐을 붙인다 (조상 속성 상속은 그대로)
    const kids = mesh.children.filter((c) => (c as THREE.Mesh).isMesh);
    for (const k of kids) mesh.remove(k);
    // 헐 지오메트리(정점 병합·노멀)는 큰 메시 하나도 예산 안에서 나눠 만든다
    await prepareOutlines(mesh, tick);
    applyOutlines(mesh, undefined, { mode: 'level' });
    for (const k of kids) mesh.add(k);
    await slicer.tick();
  }
  // 프로그램 갈래 나누기 (render/variants.ts, loadModel과 같다). 레벨은 그대로
  if (!/\/levels\//.test(url)) splitProgramVariants(root);
  return { root, gltf, animations: gltf.animations };
}

/**
 * Assets와 같은 인터페이스(load, instance). 게임이 하나 만들어 모든 시스템에 넘기면 모델 로딩이 자동으로 나눠진다.
 */
export class SlicedAssets extends Assets {
  private readonly sliced = new Map<string, Promise<LoadedModel | null>>();
  /** 읽기를 시작한 경로 (진행률 표시용) */
  readonly requested = new Set<string>();
  readonly loaded = new Set<string>();

  override load(path: string): Promise<LoadedModel | null> {
    if (this.disposed) return new Promise(() => {});
    let p = this.sliced.get(path);
    if (!p) {
      this.requested.add(path);
      p = loadModelSliced(`/models/${path}`)
        .then((m) => {
          this.loaded.add(path);
          return m;
        })
        .catch((e) => {
          console.warn(`[assets] ${path} 없음 또는 읽기 실패, 대체 모델 사용`, e?.message ?? e);
          this.loaded.add(path);
          return null;
        });
      this.sliced.set(path, p);
    }
    return this.gate(p);
  }

  override dispose(): void {
    super.dispose();
    this.sliced.clear();
    this.requested.clear();
    this.loaded.clear();
  }
}

/** 로딩 진행률: 이름 붙은 작업들의 가중치 합 */
export class LoadTracker {
  private readonly tasks = new Map<string, { weight: number; done: number; label: string }>();
  current = '';
  onChange: (() => void) | null = null;

  /** 걷었다 (화면을 걷을 때): 그 뒤에 끝나는 작업은 결과를 넘기지 않는다 */
  private dead = false;

  /** 작업을 등록하고 끝나면 완료 처리한다. 걷은 뒤에는 끝나지 않는 약속을 돌려준다 (버린 화면의 로딩이 이어지지 않게) */
  track<T>(name: string, label: string, weight: number, p: Promise<T>): Promise<T> {
    if (this.dead) {
      p.catch(() => {});
      return new Promise<T>(() => {});
    }
    this.tasks.set(name, { weight, done: 0, label });
    this.current = label;
    this.onChange?.();
    return p
      .finally(() => {
        const t = this.tasks.get(name);
        if (t) t.done = 1;
        const pending = [...this.tasks.values()].find((x) => x.done < 1);
        this.current = pending?.label ?? '';
        this.onChange?.();
      })
      .then(
        (v) => (this.dead ? new Promise<T>(() => {}) : v),
        (e) => (this.dead ? new Promise<T>(() => {}) : Promise.reject(e)),
      );
  }

  /** 화면을 걷을 때: 이후의 작업은 끝나지 않는다 */
  dispose(): void {
    this.dead = true;
    this.tasks.clear();
    this.onChange = null;
  }

  /** 진행 중인 작업의 부분 진행 (0~1) */
  partial(name: string, f: number): void {
    const t = this.tasks.get(name);
    if (t) t.done = Math.max(t.done, Math.min(0.99, f));
    this.onChange?.();
  }

  get progress(): number {
    let w = 0;
    let d = 0;
    for (const t of this.tasks.values()) {
      w += t.weight;
      d += t.weight * t.done;
    }
    return w > 0 ? d / w : 0;
  }

  get done(): boolean {
    return [...this.tasks.values()].every((t) => t.done >= 1);
  }
}

/**
 * 셰이더를 미리 컴파일한다 (KHR_parallel_shader_compile가 있으면 메인 스레드를 막지 않는다).
 * fog가 다른 장면은 프로그램이 달라지므로, 그 장면이 쓸 fog로 잠깐 바꿔서 컴파일한다.
 */
export async function precompile(engine: Engine, object: THREE.Object3D, fog: THREE.Fog | null | undefined): Promise<void> {
  const world = engine.world;
  const prevFog = world.fog;
  if (fog !== undefined) world.fog = fog;
  let p: Promise<unknown>;
  try {
    p = engine.renderer.compileAsync(object, engine.camera, world);
  } finally {
    world.fog = prevFog;
  }
  await p;
}

/**
 * 물체들을 지금 월드 조명(exclude 안의 조명은 빼고)과 주어진 fog로 미리 컴파일한다.
 * 장면(레벨)이 아직 월드에 붙지 않았어도, 붙었을 때와 같은 셰이더 프로그램을 만든다.
 * 물체 몇 개씩(걸린 시간에 맞춰) 나눠서 컴파일하고 프레임 예산(loadSlicer)을 넘기면 다음 프레임으로 넘긴다: 큰 레벨은 재질·물체마다
 * 프로그램 매개변수를 만드는 일만 수십 ms라, 연출이 도는 동안 다음 레벨을 미리 읽을 때 화면이 끊겼다. 물체는 옮기지 않는다
 */
export async function precompileObjects(
  engine: Engine,
  objects: THREE.Object3D[],
  opts: { fog?: THREE.Fog | null; exclude?: THREE.Object3D[]; scene?: THREE.Scene; camera?: THREE.Camera; budget?: number } = {},
): Promise<void> {
  const src = opts.scene ?? engine.world;
  // 화면이 검은 로딩 중에는 크게 잘라 빨리 끝낸다 (budget ms). 기본은 함께 도는 로딩과 같은 예산
  const slicer = opts.budget ? new Slicer(opts.budget) : loadSlicer;
  // 조명과 안개만 든 장면 (compile의 targetScene): 월드 조명(뺄 것과 물체 자신은 건너뛴다) + 물체 안의 보이는 조명.
  // 붙어 있는 세트(수천 노드)를 통째로 훑지 않게 뺄 묶음은 내려가지 않는다
  const tmp = new THREE.Scene();
  tmp.fog = opts.fog === undefined ? src.fog : opts.fog;
  const skip = new Set<THREE.Object3D>([...(opts.exclude ?? []), ...objects]);
  // 뿌리(장면·레벨)는 지금 숨겨 있어도(연출 동안 숨긴 장면) 그릴 때는 보이니 센다. 그 아래는 보이는 것만 (그릴 때와 같게)
  const lights = (o: THREE.Object3D, all: boolean, top = false) => {
    if (!top && !o.visible) return;
    if ((o as THREE.Light).isLight) tmp.add(o.clone(false));
    for (const c of o.children) if (all || !skip.has(c)) lights(c, all);
  };
  lights(src, false, true);
  for (const root of objects) lights(root, true, true);
  const list: THREE.Object3D[] = [];
  for (const root of objects) {
    root.traverse((o) => {
      const x = o as THREE.Mesh & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
      if (x.isMesh || x.isPoints || x.isLine || x.isSprite) list.push(o);
    });
  }
  const camera = opts.camera ?? engine.camera;
  const r = engine.renderer;
  const mats = new Set<THREE.Material>();
  // 묶음 크기는 걸린 시간으로 맞춘다 (물체마다 프로그램 키를 만드는 데 0.1~0.4 ms: 한 묶음이 예산의 절반 남짓)
  let n = 1;
  for (let i = 0; i < list.length; ) {
    const batch = list.slice(i, i + n);
    i += batch.length;
    // compile은 scene.traverse로 재질을 모으고 targetScene에서 조명을 센다: 물체를 옮기지 않고 이 묶음만 보여 준다
    const view = { traverse: (fn: (o: THREE.Object3D) => void) => batch.forEach(fn), traverseVisible: () => {} } as unknown as THREE.Object3D;
    const before = r.info.programs?.length ?? 0;
    const t0 = performance.now();
    for (const m of r.compile(view, camera, tmp)) mats.add(m);
    const dt = performance.now() - t0;
    // 새 프로그램이 생겼으면 링크가 끝날 때까지 다음 묶음을 미룬다: GPU 쪽 컴파일이 한꺼번에 쌓이면 앞 화면의 프레임이 밀린다
    const fresh = (r.info.programs?.slice(before) ?? []) as unknown as ProgramLike[];
    const w0 = performance.now();
    while (fresh.some((pr) => !pr.isReady()) && performance.now() - w0 < 2000) await new Promise((res) => setTimeout(res, 4));
    const want = slicer.budgetMs * 0.6;
    // 새 프로그램(셰이더 원문 만들기)이 든 물체는 하나에 몇 ms라 넘치면 하나씩으로 돌아간다
    n = dt > want ? 1 : dt < want * 0.4 ? Math.min(1024, n * 2) : n;
    await slicer.tick();
  }
  // 링크가 끝나기를 기다린다 (KHR_parallel_shader_compile: 메인 스레드를 막지 않고 묻는다. 없으면 바로 준비됨)
  const progs = new Set<ProgramLike>();
  for (const m of mats) {
    const mp = r.properties.get(m) as { programs?: Map<string, ProgramLike>; currentProgram?: ProgramLike };
    for (const pr of mp.programs?.values() ?? []) progs.add(pr);
    if (mp.currentProgram) progs.add(mp.currentProgram);
  }
  const t0 = performance.now();
  while ([...progs].some((pr) => !pr.isReady()) && performance.now() - t0 < 20000) await new Promise((res) => setTimeout(res, 16));
  // 처음 쓸 때 하는 일(오류 로그 확인, 유니폼·속성 위치 찾기)도 미리 나눠서 한다: 첫 화면에서 프로그램마다 동기 호출로 막히던 것
  for (const pr of progs) {
    if (warmed.has(pr)) continue;
    warmed.add(pr);
    pr.getUniforms();
    pr.getAttributes();
    await slicer.tick();
  }
}

interface ProgramLike {
  isReady(): boolean;
  getUniforms(): unknown;
  getAttributes(): unknown;
}
const warmed = new WeakSet<ProgramLike>();
