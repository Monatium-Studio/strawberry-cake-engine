import * as THREE from 'three';
import { setOutlineViewport } from '../render/toon';
import { sweepGpu } from './gpu';
import { setSceneMatrixUpdate } from '../render/hiddenMatrices';
import { checkFrozen, clearStaticActive, cullSectors, restoreSectors } from '../render/staticMatrices';
import { AutoQuality, LEVEL_NAMES, levelOf, pixelRatioFor, type QualityLevel } from './quality';
import { ScreenWarp } from '../render/warp';
import {
  FIXED_DT,
  MAX_FIXED_STEPS,
  MAX_FRAME_DT,
  MAX_PIXEL_RATIO,
  MIN_PIXEL_RATIO,
  MIN_RENDER_HEIGHT,
  MIN_RENDER_WIDTH,
  loadSettings,
  type Settings,
} from './config';

/** 렌더 품질 스위치 (측정·비교용 URL: ?logdepth=1, ?minratio=1) */
const QUALITY = (() => {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const mr = Number(q.get('minratio'));
  // 로그 깊이 버퍼는 기본 끔: 레티나(2배)에서 큰 장면이 105 → 64 fps로 떨어졌다(이른 깊이 검사가 꺼짐). 겹친 면은 깊이 바이어스와 모델 수정으로 막는다
  return { logDepth: q.get('logdepth') === '1', minRatio: Number.isFinite(mr) && mr > 0 ? mr : MIN_PIXEL_RATIO };
})();

/** 엔진에 붙는 시스템. fixedUpdate는 고정 스텝(물리·로직), update는 매 렌더 프레임(카메라·연출). */
export interface System {
  fixedUpdate?(dt: number): void;
  /** alpha: 마지막 고정 스텝 이후 경과 비율(0~1), 보간용 */
  update?(dt: number, alpha: number): void;
}

export interface EngineOptions {
  /** 최소 렌더링 크기(CSS px). 창이 더 작으면 container가 이 크기를 유지하고 페이지가 스크롤된다. 0이면 제한 없음 */
  minWidth?: number;
  minHeight?: number;
  /** 지울 때의 배경색 */
  clearColor?: THREE.ColorRepresentation;
}

/**
 * 렌더 구조
 *   1) world 씬 + camera          : 레벨, 캐릭터, 소품
 *   1b) 화면 굴절 (warp.ts)       : 충격파 고리·아지랑이가 살아 있을 때만, world 깊이로 가려 가며
 *   2) depth clear
 *   3) overlay 씬 + overlayCamera : 벽에 묻히지 않는 3D 층 (1인칭 손에 든 물건, 3D UI 등. 별도 FOV). 빈 씬이면 그리지 않는다
 *   4) DOM overlay                : HUD·메뉴
 *
 * 크기: container는 CSS로 최소 크기(EngineOptions.minWidth/minHeight)를 가진다. 창이 작으면 페이지가 스크롤된다.
 * 캔버스는 항상 container를 꽉 채운다.
 */
export class Engine {
  readonly container: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly world = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly overlayScene = new THREE.Scene();
  readonly overlayCamera: THREE.PerspectiveCamera;
  readonly overlay: HTMLDivElement;
  /** 월드 주광. 겹침 층(overlay) 조명 방향도 이걸 따라간다 */
  readonly sun: THREE.DirectionalLight;
  readonly settings: Settings;
  /** 화면 굴절 (충격파·아지랑이). 효과가 없으면 비용이 없다 */
  readonly warp: ScreenWarp;

  width = 0;
  height = 0;
  /** 시간 배율. 1 = 정상, 0.1 = 슬로모션 (연출 확인·디버그용) */
  timeScale = 1;
  /** true면 fixedUpdate를 멈춘다 (일시정지). 렌더는 계속 */
  paused = false;
  /** 고정 스텝이 한 번 이상 돈 프레임 끝에 호출 (입력 엣지 소비 등) */
  onAfterFixed: (() => void) | null = null;

  private systems: System[] = [];
  private acc = 0;
  private last = -1;
  private running = false;
  /** afterNextRender로 걸어 둔 일회성 콜백 (스크린샷) */
  private renderTaps: ((canvas: HTMLCanvasElement) => void)[] = [];
  private readonly overlayKey: THREE.DirectionalLight;
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();
  private fpsFrames = 0;
  private fpsTime = 0;
  /** 그래픽 「자동」 조절 (quality.ts) */
  readonly autoQuality = new AutoQuality();
  /** 「자동」이 재도 되는 때 (게임이 정한다: 보통 사용자가 조작 중일 때만. 로딩·연출·일시정지는 재지 않는다). 없으면 재지 않는다 */
  qualityGate: (() => boolean) | null = null;
  /** 지금 쓰는 품질 단계 (0 높음 · 1 중간 · 2 낮음) */
  get qualityLevel(): QualityLevel {
    return levelOf(this.settings.graphics, this.autoQuality.level);
  }
  get qualityName(): string {
    return LEVEL_NAMES[this.qualityLevel];
  }
  fps = 0;
  /** 처음 상태 (reset이 되돌린다: 레벨·장면이 바꾼 조명·카메라·렌더러 값) */
  private readonly base: {
    clear: THREE.Color;
    clearAlpha: number;
    sun: { color: THREE.Color; intensity: number; position: THREE.Vector3; target: THREE.Vector3 };
    hemi: { light: THREE.HemisphereLight; color: THREE.Color; ground: THREE.Color; intensity: number }[];
    overlayKey: { color: THREE.Color; intensity: number };
    camera: { near: number; far: number; layers: number };
    overlayCam: { near: number; far: number };
    toneMapping: THREE.ToneMapping;
    exposure: number;
    shadows: boolean;
    clipping: boolean;
  };

  constructor(container: HTMLElement, opts: EngineOptions = {}) {
    this.container = container;
    this.settings = loadSettings();
    // 최소 렌더링 크기: 창이 더 작으면 container가 이 크기를 유지하고 페이지가 스크롤된다
    const minW = opts.minWidth ?? MIN_RENDER_WIDTH;
    const minH = opts.minHeight ?? MIN_RENDER_HEIGHT;
    if (minW > 0) container.style.minWidth = `${minW}px`;
    if (minH > 0) container.style.minHeight = `${minH}px`;

    // 로그 깊이 버퍼(?logdepth=1)일 때 직접 짠 ShaderMaterial은 engine/logDepth.ts의 patchLogDepth로 같은 깊이를 쓴다
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: QUALITY.logDepth });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(opts.clearColor ?? 0x9cc3e0);
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    container.appendChild(this.overlay);

    this.camera = new THREE.PerspectiveCamera(this.settings.worldFov, 16 / 9, 0.03, 600);
    this.camera.rotation.order = 'YXZ';
    this.world.add(this.camera);

    this.overlayCamera = new THREE.PerspectiveCamera(this.settings.overlayFov, 16 / 9, 0.005, 10);
    this.warp = new ScreenWarp(this.renderer, this.camera);

    // 월드 조명 (레벨이 바꿀 수 있음)
    this.world.add(new THREE.HemisphereLight(0xeaf4ff, 0x8a8070, 1.5));
    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    this.sun.position.set(-30, 60, 25);
    this.world.add(this.sun);
    this.world.add(this.sun.target);

    // 겹침 층 조명: 매 프레임 월드 주광 방향을 카메라 공간으로 옮겨 맞춘다
    this.overlayScene.add(new THREE.HemisphereLight(0xeaf4ff, 0x8a8070, 1.5));
    this.overlayKey = new THREE.DirectionalLight(0xfff4e0, 2.2);
    this.overlayScene.add(this.overlayKey);
    this.overlayScene.add(this.overlayKey.target);

    const hemi = [...this.world.children, ...this.overlayScene.children].filter((o): o is THREE.HemisphereLight => (o as THREE.HemisphereLight).isHemisphereLight);
    this.base = {
      clear: this.renderer.getClearColor(new THREE.Color()),
      clearAlpha: this.renderer.getClearAlpha(),
      sun: { color: this.sun.color.clone(), intensity: this.sun.intensity, position: this.sun.position.clone(), target: this.sun.target.position.clone() },
      hemi: hemi.map((light) => ({ light, color: light.color.clone(), ground: light.groundColor.clone(), intensity: light.intensity })),
      overlayKey: { color: this.overlayKey.color.clone(), intensity: this.overlayKey.intensity },
      camera: { near: this.camera.near, far: this.camera.far, layers: this.camera.layers.mask },
      overlayCam: { near: this.overlayCamera.near, far: this.overlayCamera.far },
      toneMapping: this.renderer.toneMapping,
      exposure: this.renderer.toneMappingExposure,
      shadows: this.renderer.shadowMap.enabled,
      clipping: this.renderer.localClippingEnabled,
    };

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  add<T extends System>(system: T): T {
    this.systems.push(system);
    return system;
  }

  remove(system: System): void {
    this.systems = this.systems.filter((s) => s !== system);
  }

  /**
   * 장면을 통째로 비운다 (같은 페이지에서 화면을 바꿀 때: 페이지를 새로 읽지 않는다, core/flow.ts).
   * 시스템을 모두 떼고, 월드·겹침 씬에서 카메라와 기본 조명만 남기고, 레벨·장면이 바꾼 조명·안개·카메라·렌더러 값을
   * 처음 상태로 되돌린다 (새로 연 페이지와 같게). 렌더 루프와 캔버스(포인터 락)는 그대로다.
   */
  reset(): void {
    this.systems = [];
    this.onAfterFixed = null;
    this.qualityGate = null;
    this.acc = 0;
    const keepWorld = new Set<THREE.Object3D>([this.camera, this.sun, this.sun.target]);
    for (const o of [...this.world.children]) {
      if (keepWorld.has(o) || (o as THREE.HemisphereLight).isHemisphereLight) continue;
      this.world.remove(o);
    }
    for (const o of [...this.camera.children]) this.camera.remove(o);
    for (const o of [...this.overlayScene.children]) {
      if ((o as THREE.Light).isLight || o === this.overlayKey.target) continue;
      this.overlayScene.remove(o);
    }
    this.world.fog = null;
    this.world.background = null;
    this.world.environment = null;
    this.world.overrideMaterial = null;
    this.paused = false;
    this.timeScale = 1;
    this.warp.clear();
    clearStaticActive();
    const b = this.base;
    this.renderer.setClearColor(b.clear, b.clearAlpha);
    this.renderer.toneMapping = b.toneMapping;
    this.renderer.toneMappingExposure = b.exposure;
    this.renderer.shadowMap.enabled = b.shadows;
    this.renderer.localClippingEnabled = b.clipping;
    this.sun.color.copy(b.sun.color);
    this.sun.intensity = b.sun.intensity;
    this.sun.position.copy(b.sun.position);
    this.sun.target.position.copy(b.sun.target);
    this.sun.visible = true;
    for (const h of b.hemi) {
      h.light.color.copy(h.color);
      h.light.groundColor.copy(h.ground);
      h.light.intensity = h.intensity;
      h.light.visible = true;
    }
    this.overlayKey.color.copy(b.overlayKey.color);
    this.overlayKey.intensity = b.overlayKey.intensity;
    this.camera.near = b.camera.near;
    this.camera.far = b.camera.far;
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.set(0, 0, 0);
    this.camera.layers.mask = b.camera.layers;
    this.overlayCamera.near = b.overlayCam.near;
    this.overlayCamera.far = b.overlayCam.far;
    this.overlayScene.visible = true;
    this.world.visible = true;
    this.applySettings();
    // 앞 화면이 GPU에 올린 형상·재질·텍스처를 놓는다 (gpu.ts: 다음 화면이 다시 쓰는 것은 three가 다시 올린다)
    this.renderer.renderLists.dispose();
    const freed = sweepGpu();
    const mem = this.renderer.info.memory;
    console.info(`[engine] 장면 비움: GPU 자원 ${freed}개를 놓음 (geo ${mem.geometries}, tex ${mem.textures}, programs ${this.renderer.info.programs?.length ?? 0})`);
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    const ratio = pixelRatioFor(this.qualityLevel, window.devicePixelRatio || 1, QUALITY.minRatio, MAX_PIXEL_RATIO) * this.settings.renderScale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    setOutlineViewport(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y);
    for (const cam of [this.camera, this.overlayCamera]) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
  }

  applySettings(): void {
    this.camera.fov = this.settings.worldFov;
    this.overlayCamera.fov = this.settings.overlayFov;
    this.resize();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  /**
   * 다음 렌더 직후(같은 프레임) fn을 한 번 부른다. preserveDrawingBuffer 없이도 이때는 캔버스 내용이 살아 있어
   * drawImage·readPixels로 그 프레임을 읽을 수 있다 (스크린샷). 렌더 루프가 멈춰 있으면 지금 한 번 그리고 부른다.
   * 걸어 둔 것이 없는 프레임의 비용은 길이 검사 하나다.
   */
  afterNextRender(fn: (canvas: HTMLCanvasElement) => void): void {
    if (!this.running) {
      this.render();
      fn(this.renderer.domElement);
      return;
    }
    this.renderTaps.push(fn);
  }

  private frame(timeMs: number): void {
    const work0 = performance.now();
    const interval = this.last < 0 ? 0 : timeMs - this.last;
    if (this.last < 0) this.last = timeMs;
    const frameDt = Math.min((timeMs - this.last) / 1000, MAX_FRAME_DT) * this.timeScale;
    let dt = frameDt;
    this.last = timeMs;

    let steps = 0;
    if (!this.paused) {
      this.acc += dt;
      // 배속(점검 스크립트의 timeScale 3 등)만큼은 상한을 늘려 배속 진행은 그대로 둔다
      const cap = MAX_FIXED_STEPS * Math.max(1, Math.ceil(this.timeScale));
      while (this.acc >= FIXED_DT && steps < cap) {
        for (const s of this.systems) s.fixedUpdate?.(FIXED_DT);
        this.acc -= FIXED_DT;
        steps++;
      }
      if (this.acc >= FIXED_DT) {
        // 버린 몫은 프레임 dt에서도 뺀다: 스크립트 시계·대기·애니메이션(update)이 물리·로직(fixedUpdate)보다 앞서 가면
        // 시간 맞춘 연출·대기 시간 제한이 어긋난다. 둘이 같이 느려진다 (MAX_FRAME_DT로 잘릴 때와 같다)
        const dropped = this.acc - (this.acc % FIXED_DT);
        this.acc -= dropped;
        dt = Math.max(0, dt - dropped);
      }
    }
    if (steps > 0) this.onAfterFixed?.();
    const alpha = this.paused ? 1 : this.acc / FIXED_DT;
    for (const s of this.systems) s.update?.(dt, alpha);
    this.warp.update(dt);
    this.render();
    if (this.renderTaps.length) {
      const taps = this.renderTaps;
      this.renderTaps = [];
      for (const fn of taps) {
        try {
          fn(this.renderer.domElement);
        } catch (e) {
          console.error(e);
        }
      }
    }

    // 그래픽 「자동」: GPU가 버거우면 배율을 한 단계 내린다 (quality.ts)
    if (this.settings.graphics !== 'auto' || this.paused || document.hidden || !(this.qualityGate?.() ?? false)) this.autoQuality.skip();
    else if (this.autoQuality.sample(interval, performance.now() - work0)) {
      console.info(`[quality] 자동 → ${this.qualityName} (간격 ${this.autoQuality.last?.interval} ms, 일 ${this.autoQuality.last?.work} ms)`);
      this.resize();
    }

    this.fpsFrames++;
    this.fpsTime += frameDt;
    if (this.fpsTime >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsTime);
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
  }

  render(): void {
    const r = this.renderer;
    r.clear();
    // 얼린 레벨 노드가 바뀌었으면 풀고, 화면 밖 구역은 이번 렌더 동안 숨긴다 (staticMatrices.ts)
    checkFrozen();
    cullSectors(this.camera);
    setSceneMatrixUpdate(true);
    try {
      r.render(this.world, this.camera);
    } finally {
      setSceneMatrixUpdate(false);
      restoreSectors();
    }
    // 충격파·아지랑이: 살아 있는 효과가 있을 때만 (world 깊이가 남아 있을 때)
    if (this.warp.live) this.warp.render();

    // 주광 방향(빛이 오는 쪽)을 카메라 공간으로
    this.tmpV.copy(this.sun.position).sub(this.sun.target.position).normalize();
    this.camera.getWorldQuaternion(this.tmpQ).invert();
    this.tmpV.applyQuaternion(this.tmpQ);
    this.overlayKey.position.copy(this.tmpV).multiplyScalar(5);
    this.overlayKey.target.position.set(0, 0, 0);

    // 겹침 층: 조명 말고 그릴 것이 있을 때만
    if (!this.overlayScene.visible || !this.overlayScene.children.some((o) => !(o as THREE.Light).isLight && o !== this.overlayKey.target)) return;
    r.clearDepth();
    r.render(this.overlayScene, this.overlayCamera);
  }
}
