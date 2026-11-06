import * as THREE from 'three';
import { patchLogDepth } from './logDepth';

/**
 * 화면 굴절 (충격파 고리·열 아지랑이). 효과가 살아 있는 프레임에만 돈다.
 *
 * world를 그린 직후(깊이를 지우기 전)
 *   1) 효과들이 덮을 화면 조각(감싼 사각형)만 프레임 텍스처로 한 번 복사하고 (copyTexSubImage2D, 같은 좌표)
 *   2) 효과마다 그 자리에 카메라를 보는 사각형을 world 깊이로 가려 가며 그린다: 복사한 화면을 고리·아지랑이만큼 비켜 읽는다.
 * 비용: 굴절이 도는 프레임은 렌더 패스가 끊기고 다중 표본 화면을 풀어 복사하므로 GPU가 작은 고리도 약 1 ms, 화면을 덮는 고리는
 * 약 3 ms 더 든다. 드문 큰 효과(폭발·충격파·엔진 후류)에만 쓴다.
 * 비킴이 0인 곳은 같은 픽셀을 그대로 다시 쓰므로 사각형 테두리가 보이지 않는다. 툰 외곽선은 world에 그려진 그대로 굴절된다.
 * 효과가 없으면 Engine은 live만 보고 지나간다 (전체 화면 패스·매 프레임 할당 없음). 텍스처는 처음 쓸 때 그리기 버퍼 크기로 만들고 창 크기가 바뀌면 다시 만든다.
 *
 *   engine.warp.add(origin, { radius: 8, time: 0.3, ring: 0.008, haze: 1.6, hazeTime: 0.9, hazeStrength: 0.003 })
 * 세기는 화면 높이 비율이다 (굴절은 거리와 상관없이 같은 각도로 비킨다: 멀리 있는 고리도 같은 픽셀만큼).
 * ?warp=0이면 끈다 (측정·비교).
 */
export interface WarpOptions {
  /** 충격파 고리가 퍼지는 반경 (m) */
  radius: number;
  /** 고리가 다 퍼지는 시간 (s) */
  time: number;
  /** 고리 굴절 (화면 높이 비율, 처음 세기. 퍼지며 약해진다) */
  ring: number;
  /** 열 아지랑이 반경 (m). 0이면 없음 */
  haze?: number;
  /** 아지랑이 시간 (s) */
  hazeTime?: number;
  /** 아지랑이 굴절 (화면 높이 비율) */
  hazeStrength?: number;
  /** 아지랑이가 오르는 속도 (m/s) */
  rise?: number;
}

/** 동시에 굴절하는 효과 수 (넘으면 우선순위가 낮은 것을 바꾸거나 버린다) */
const MAX = 4;
const ENABLED = typeof location === 'undefined' || new URLSearchParams(location.search).get('warp') !== '0';

const VERT = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// 고리: 앞쪽은 바깥으로, 뒤쪽은 안으로 비켜 읽는 얇은 볼록렌즈 띠 (홀함수 x(1-x²)², 최댓값 1로 맞춤) + 아주 옅은 밝기 띠.
// 아지랑이: 위로 흐르는 사인 물결 두 겹, 위로 긴 타원 안에서만
const FRAG = /* glsl */ `
uniform sampler2D tFrame;
uniform vec2 uInvSize;
uniform float uRing;
uniform float uRingW;
uniform float uRingPx;
uniform float uRim;
uniform float uHazeR;
uniform float uHazePx;
uniform float uRise;
uniform float uTime;
varying vec2 vLocal;
void main() {
  float r = length(vLocal);
  if (r >= 1.0) discard;
  vec2 n = r > 1e-4 ? vLocal / r : vec2(0.0);
  float x = (r - uRing) / uRingW;
  float band = clamp(1.0 - x * x, 0.0, 1.0);
  float ring = x * band * band * 3.49;
  vec2 off = n * (ring * uRingPx);
  if (uHazePx > 0.0) {
    vec2 q = vec2(vLocal.x, (vLocal.y - uRise) * 0.6) / uHazeR;
    float h = 1.0 - smoothstep(0.35, 1.0, length(q));
    vec2 p = vLocal / uHazeR * 6.0;
    p.y -= uTime * 2.2;
    off += vec2(sin(p.y * 4.3 + uTime * 11.0) + 0.6 * sin(p.x * 3.1 - p.y * 2.3),
                cos(p.x * 3.7 + uTime * 9.0) + 0.6 * sin(p.y * 2.9 + p.x * 1.7)) * (0.5 * uHazePx * h);
  }
  vec4 c = texture2D(tFrame, (gl_FragCoord.xy - off) * uInvSize);
  gl_FragColor = vec4(c.rgb * (1.0 + uRim * ring), 1.0);
}
`;

interface Slot {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  pos: THREE.Vector3;
  t: number;
  radius: number;
  time: number;
  ring: number;
  haze: number;
  hazeTime: number;
  hazeStrength: number;
  rise: number;
  /** 우선순위 (넣는 쪽이 정한다: 세기 / 거리). 수명이 지나며 줄어든 값으로 견준다 */
  prio: number;
  /** 복사할 화면 조각 (그리기 버퍼 픽셀) */
  x: number;
  y: number;
  w: number;
  h: number;
}

export class ScreenWarp {
  /** 살아 있는 효과 수 (0이면 Engine이 render를 부르지 않는다) */
  live = 0;
  readonly enabled = ENABLED;
  /** 측정용: 그린 프레임 수, 그린 효과 수, 복사한 픽셀 수 (누적) */
  readonly stats = { frames: 0, draws: 0, copiedPx: 0 };

  private readonly scene = new THREE.Scene();
  private readonly slots: Slot[] = [];
  private tex: THREE.FramebufferTexture | null = null;
  private readonly size = new THREE.Vector2();
  private readonly invSize = new THREE.Vector2();
  private readonly tmp = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    const geo = new THREE.PlaneGeometry(2, 2);
    for (let i = 0; i < MAX; i++) {
      const mat = patchLogDepth(
        new THREE.ShaderMaterial({
          name: 'screen_warp',
          vertexShader: VERT,
          fragmentShader: FRAG,
          uniforms: {
            tFrame: { value: null },
            uInvSize: { value: this.invSize },
            uRing: { value: 0 },
            uRingW: { value: 0.1 },
            uRingPx: { value: 0 },
            uRim: { value: 0 },
            uHazeR: { value: 0.3 },
            uHazePx: { value: 0 },
            uRise: { value: 0 },
            uTime: { value: 0 },
          },
          // 뒤에서부터 그리게 투명 목록에 넣지만 섞지는 않는다 (복사한 화면을 그대로 덮어쓴다)
          transparent: true,
          blending: THREE.NoBlending,
          depthTest: true,
          depthWrite: false,
          toneMapped: false,
          fog: false,
        }),
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'screen_warp';
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 1000;
      const slot: Slot = { mesh, mat, pos: new THREE.Vector3(), t: 0, radius: 1, time: 1, ring: 0, haze: 0, hazeTime: 0, hazeStrength: 0, rise: 0, prio: 0, x: 0, y: 0, w: 0, h: 0 };
      this.slots.push(slot);
      this.scene.add(mesh);
    }
    // 셰이더를 미리 컴파일한다 (첫 포격에 끊기지 않게)
    if (ENABLED) {
      this.slots[0].mesh.visible = true;
      void renderer.compileAsync(this.scene, camera).finally(() => (this.slots[0].mesh.visible = false));
    }
  }

  /**
   * 효과 하나 (할당 없음). priority: 자리가 다 찼을 때 견줄 값 (남은 수명 비율을 곱한 값이 가장 낮은 것을 바꾸고, 새것이 더 낮으면 버린다).
   * scale: 반경·아지랑이 크기 배율
   */
  add(pos: THREE.Vector3, o: WarpOptions, priority = 1, scale = 1): void {
    if (!ENABLED) return;
    let s: Slot | null = null;
    for (const x of this.slots) if (x.t <= 0) s = x;
    if (!s) {
      let low = Infinity;
      for (const x of this.slots) {
        const left = 1 - x.t / Math.max(x.time, x.hazeTime, 1e-3);
        const p = x.prio * Math.max(0, left);
        if (p < low) {
          low = p;
          s = x;
        }
      }
      if (!s || low > priority) return;
    }
    s.pos.copy(pos);
    s.t = 1e-4;
    s.prio = priority;
    s.radius = o.radius * scale;
    s.time = o.time;
    s.ring = o.ring;
    s.haze = (o.haze ?? 0) * scale;
    s.hazeTime = o.hazeTime ?? 0;
    s.hazeStrength = o.hazeStrength ?? 0;
    s.rise = (o.rise ?? 0.6) * Math.min(1, scale);
    this.count();
  }

  /** 시간 (Engine.frame, 효과가 없으면 바로 끝) */
  update(dt: number): void {
    if (this.live === 0) return;
    for (const s of this.slots) {
      if (s.t <= 0) continue;
      s.t += dt;
      if (s.t >= Math.max(s.time, s.hazeTime)) {
        s.t = 0;
        s.mesh.visible = false;
      }
    }
    this.count();
  }

  clear(): void {
    for (const s of this.slots) {
      s.t = 0;
      s.mesh.visible = false;
    }
    this.live = 0;
  }

  private count(): void {
    let n = 0;
    for (const s of this.slots) if (s.t > 0) n++;
    this.live = n;
  }

  /** world를 그린 직후, 깊이를 지우기 전 (Engine.render) */
  render(): void {
    const r = this.renderer;
    const cam = this.camera;
    r.getDrawingBufferSize(this.size);
    const W = this.size.x;
    const H = this.size.y;
    if (!this.tex || this.tex.image.width !== W || this.tex.image.height !== H) {
      this.tex?.dispose();
      this.tex = new THREE.FramebufferTexture(W, H);
      this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
      r.initTexture(this.tex);
      for (const s of this.slots) s.mat.uniforms.tFrame.value = this.tex;
    }
    this.invSize.set(1 / W, 1 / H);
    const P = cam.projectionMatrix.elements;
    const quat = cam.getWorldQuaternion(this.quat);
    let any = false;
    for (const s of this.slots) {
      s.mesh.visible = false;
      if (s.t <= 0) continue;
      // 고리: 처음에 빠르게 퍼지고 느려진다. 세기는 퍼질수록 약해진다. 아지랑이는 잠깐 피어올랐다 사라진다
      const u = Math.min(1, s.t / s.time);
      const front = 1 - (1 - u) ** 2.4;
      const ringK = u < 1 ? (1 - u) ** 1.3 : 0;
      const hu = s.hazeTime > 0 ? Math.min(1, s.t / s.hazeTime) : 1;
      const hazeK = hu < 1 ? Math.min(1, hu / 0.06) * (1 - hu) ** 1.5 : 0;
      const ringR = s.radius * front;
      const ringW = s.radius * (0.05 + 0.1 * u);
      // 사각형 반경: 고리 바깥 끝과 아지랑이 중 큰 것
      const S = Math.max(ringK > 0 ? ringR + ringW * 1.2 : 0, hazeK > 0 ? s.haze * 1.15 + s.rise * s.t : 0);
      if (S <= 0) continue;
      const v = this.tmp.copy(s.pos).applyMatrix4(cam.matrixWorldInverse);
      const depth = -v.z;
      if (depth <= cam.near * 2) continue;
      v.applyMatrix4(cam.projectionMatrix);
      const cx = (v.x * 0.5 + 0.5) * W;
      const cy = (v.y * 0.5 + 0.5) * H;
      // 미터 → 픽셀 (사각형 반경 S 한 단위가 몇 픽셀인가)
      const pxPerM = (P[5] * H * 0.5) / depth;
      const scalePx = S * pxPerM;
      // 몇 픽셀짜리 고리는 보이지 않는데 복사·패스 나눔 비용은 같다
      if (scalePx < 24) continue;
      // 굴절 픽셀: 화면 높이 비율. 고리 띠 폭의 절반을 넘지 않게 (띠보다 멀리 비켜 읽으면 접혀 보인다)
      const ringPx = Math.min(s.ring * H * ringK, ringW * pxPerM * 0.45);
      const hazePx = s.hazeStrength * H * hazeK;
      const margin = Math.ceil(ringPx + hazePx * 1.2 + 2);
      const x0 = Math.max(0, Math.floor(cx - scalePx - margin));
      const y0 = Math.max(0, Math.floor(cy - scalePx - margin));
      const x1 = Math.min(W, Math.ceil(cx + scalePx + margin));
      const y1 = Math.min(H, Math.ceil(cy + scalePx + margin));
      if (x1 <= x0 || y1 <= y0) continue;
      s.x = x0;
      s.y = y0;
      s.w = x1 - x0;
      s.h = y1 - y0;
      const un = s.mat.uniforms;
      un.uRing.value = ringR / S;
      un.uRingW.value = ringW / S;
      un.uRingPx.value = ringPx;
      un.uRim.value = 0.07 * ringK;
      un.uHazeR.value = Math.max(1e-3, s.haze / S);
      un.uHazePx.value = hazePx;
      un.uRise.value = (s.rise * s.t) / S;
      un.uTime.value = s.t;
      s.mesh.position.copy(s.pos);
      s.mesh.quaternion.copy(quat);
      s.mesh.scale.setScalar(S);
      s.mesh.visible = true;
      any = true;
    }
    if (!any) return;
    this.stats.frames++;
    // 복사는 프레임에 한 번 (효과들을 감싼 사각형): 복사마다 렌더 패스가 끊기고 다중 표본 화면을 푸는 고정 비용이 든다 (아래 측정)
    let x0 = W;
    let y0 = H;
    let x1 = 0;
    let y1 = 0;
    for (const s of this.slots) {
      if (!s.mesh.visible) continue;
      x0 = Math.min(x0, s.x);
      y0 = Math.min(y0, s.y);
      x1 = Math.max(x1, s.x + s.w);
      y1 = Math.max(y1, s.y + s.h);
      this.stats.draws++;
    }
    const gl = r.getContext();
    const tex = r.properties.get(this.tex) as { __webglTexture?: WebGLTexture };
    if (!tex.__webglTexture) return;
    r.state.bindTexture(gl.TEXTURE_2D, tex.__webglTexture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x0, y0, x1 - x0, y1 - y0);
    r.state.unbindTexture();
    this.stats.copiedPx += (x1 - x0) * (y1 - y0);
    r.render(this.scene, cam);
  }
}
