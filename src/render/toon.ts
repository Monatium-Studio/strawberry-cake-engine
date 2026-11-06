import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 공용 렌더 스타일: 셀 셰이딩 + 인버티드 헐 아웃라인.
 *
 * 규칙 (Blender 쪽에서 지키는 명명 규칙, docs/ASSETS.md 참고)
 * - 머티리얼 이름이 `UNLIT_`로 시작하면 조명 없는 MeshBasicMaterial (눈 하이라이트, 화면, 발광부)
 * - 오브젝트 커스텀 속성 `noOutline` = 1 이면 아웃라인 생략 (자식에게 상속)
 * - 오브젝트 커스텀 속성 `outline` = 숫자(m) 이면 아웃라인 두께 지정 (자식에게 상속)
 * - 머티리얼 커스텀 속성 `lineColor` = "#rrggbb" 이면 그 색으로 아웃라인, 없으면 바탕색을 어둡게 한 색
 */

export const DEFAULT_OUTLINE = 0.006; // m

const TONES = [0.5, 0.78, 1.0]; // 그림자, 중간, 밝음

let gradient: THREE.DataTexture | null = null;
export function toonGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  const data = new Uint8Array(TONES.length * 4);
  TONES.forEach((t, i) => {
    const v = Math.round(t * 255);
    data.set([v, v, v, 255], i * 4);
  });
  gradient = new THREE.DataTexture(data, TONES.length, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

const toonCache = new WeakMap<THREE.Material, THREE.Material>();

/**
 * 겹친 면 깊이 다툼(z-fighting) 방지. 기본 면 바로 위에 붙인 얇은 장식(도로 선, 바닥 무늬, 표지, 유리, 얼굴 이목구비)은
 * 멀어지면 깊이 정밀도가 모자라 기본 면과 번갈아 보인다(2026-11-02 사용자 지적). 그런 메시는 깊이를 몇 단계 앞으로 당겨
 * 늘 이기게 한다. polygonOffset은 깊이 버퍼 단위라 거리와 상관없이 듣는다.
 *   *_fine, *decal*, *stencil*, *_face → 강하게 / *_detail → 약하게
 */
/** 원본 머티리얼 → (치우침 → 복제). 원본에 약하게 묶는다: 같은 페이지에서 다음 판이 새로 읽은 머티리얼의 복제가 쌓이지 않게 */
const biasCache = new WeakMap<THREE.Material, Map<string, THREE.Material>>();
export function depthBiasFor(name: string): [number, number] | null {
  const n = name.toLowerCase();
  if (/(_fine|_face)(\.\d+)?$|decal|stencil/.test(n)) return [-1, -4];
  if (/_detail(\.\d+)?$/.test(n)) return [-0.5, -2];
  return null;
}
export function applyDepthBias(mesh: THREE.Mesh): void {
  const bias = depthBiasFor(mesh.name);
  if (!bias) return;
  const one = (m: THREE.Material): THREE.Material => {
    if (m.polygonOffset || m.transparent) return m;
    const key = `${bias[0]}|${bias[1]}`;
    let byBias = biasCache.get(m);
    if (!byBias) biasCache.set(m, (byBias = new Map()));
    let c = byBias.get(key);
    if (!c) {
      c = m.clone();
      c.polygonOffset = true;
      c.polygonOffsetFactor = bias[0];
      c.polygonOffsetUnits = bias[1];
      c.userData = { ...m.userData };
      // 로그 깊이 버퍼에서는 셰이더가 gl_FragDepth를 써서 polygonOffset이 듣지 않는다: 같은 방향으로 조금 당긴다
      const eps = (bias[1] === -4 ? 6e-6 : 3e-6).toExponential(1);
      c.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <logdepthbuf_fragment>',
          `#include <logdepthbuf_fragment>\n#ifdef USE_LOGDEPTHBUF\ngl_FragDepth -= ${eps};\n#endif`,
        );
      };
      c.customProgramCacheKey = () => `depth-bias-${eps}`;
      byBias.set(key, c);
    }
    return c;
  };
  mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
}

/** glTF에서 읽은 PBR 머티리얼을 툰/언릿 머티리얼로 바꾼다. 같은 원본은 같은 결과를 공유한다. */
export function toToon(src: THREE.Material): THREE.Material {
  const cached = toonCache.get(src);
  if (cached) return cached;
  if (src instanceof THREE.MeshToonMaterial || src instanceof THREE.MeshBasicMaterial) return src;

  const s = src as THREE.MeshStandardMaterial;
  const common = {
    name: s.name,
    color: s.color ? s.color.clone() : new THREE.Color(1, 1, 1),
    map: s.map ?? null,
    transparent: s.transparent,
    opacity: s.opacity,
    alphaTest: s.alphaTest,
    side: s.side,
    vertexColors: s.vertexColors,
  };

  let out: THREE.Material;
  if (s.name.startsWith('UNLIT_')) {
    const basic = new THREE.MeshBasicMaterial(common);
    // 언릿은 발광색이 있으면 그 색을 그대로 쓴다
    if (s.emissive && (s.emissive.r + s.emissive.g + s.emissive.b) > 0) basic.color.copy(s.emissive);
    out = basic;
  } else {
    out = new THREE.MeshToonMaterial({
      ...common,
      gradientMap: toonGradient(),
      emissive: s.emissive ? s.emissive.clone() : new THREE.Color(0, 0, 0),
      emissiveMap: s.emissiveMap ?? null,
      emissiveIntensity: s.emissiveIntensity ?? 1,
      normalMap: s.normalMap ?? null,
    });
  }
  out.userData = { ...s.userData };
  toonCache.set(src, out);
  return out;
}

const codeMatCache = new Map<string, THREE.MeshToonMaterial>();
/** 텍스처가 있는 것은 텍스처에 약하게 묶는다 (화면마다 새로 만드는 텍스처의 머티리얼이 쌓이지 않게) */
const codeMapCache = new WeakMap<THREE.Texture, Map<string, THREE.MeshToonMaterial>>();

/** 코드로 만드는 메시(그레이박스 레벨, 대체 모델)용 툰 머티리얼. 같은 색은 공유. */
export function toonMaterial(color: THREE.ColorRepresentation, opts: { map?: THREE.Texture; emissive?: THREE.ColorRepresentation } = {}): THREE.MeshToonMaterial {
  const key = `${new THREE.Color(color).getHexString()}|${opts.emissive ?? ''}`;
  let cache = codeMatCache;
  if (opts.map) {
    let c = codeMapCache.get(opts.map);
    if (!c) codeMapCache.set(opts.map, (c = new Map()));
    cache = c;
  }
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshToonMaterial({
      color,
      gradientMap: toonGradient(),
      map: opts.map ?? null,
      emissive: opts.emissive ?? 0x000000,
    });
    cache.set(key, m);
  }
  return m;
}

// ---------------------------------------------------------------- outlines

const outlineMatCache = new Map<string, THREE.MeshBasicMaterial>();
const smoothGeoCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

function lineColorFor(mat: THREE.Material): THREE.Color {
  const hex = (mat.userData as { lineColor?: string }).lineColor;
  if (typeof hex === 'string') return new THREE.Color(hex);
  const base = (mat as THREE.MeshToonMaterial).color?.clone() ?? new THREE.Color(0.3, 0.3, 0.3);
  // 바탕색을 어둡고 약간 붉은 쪽으로: 트릭컬풍 컬러 라인
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 0.9 + 0.1), Math.max(0.06, hsl.l * 0.28));
}

/**
 * 외곽선 화면 크기 보정 (모든 외곽선 머티리얼이 공유).
 * 멀리 있는 물체의 외곽선이 1픽셀보다 가늘어지면 점선처럼 끊겨 움직일 때 자글거린다. 그래서
 *   - 화면에서 uMinPx(장치 픽셀)보다 가늘면 그 굵기까지 늘리고
 *   - 원래 굵기가 아주 가늘면(아주 멀면) 선 색을 바탕색으로 스며들게 해서 점이 반짝이지 않게 한다.
 * 엔진이 그리기 버퍼 높이를 setOutlineViewport로 알려 준다.
 */
export const outlineView = { uViewH: { value: 720 }, uMinPx: { value: 1.0 } };
/**
 * 외곽선 모드별 굵기 규칙.
 *  - crisp(인물·소품): 1픽셀보다 가늘면 1픽셀로 늘리고, 0.12~0.4픽셀에서 바탕색으로 스민다
 *  - level(레벨 지형·건물): 늘리지 않고 1.3픽셀보다 가늘어지면 바탕색으로 스며 0.55픽셀에서 사라진다.
 *    먼 건물의 창문 격자에 1픽셀 선이 촘촘히 깔리면 움직일 때 반짝이며 자글거린다 (2026-11-02 사용자 지적)
 */
const OUTLINE_MODES = {
  crisp: { uMinPx: outlineView.uMinPx, uFade: { value: new THREE.Vector2(0.12, 0.4) } },
  level: { uMinPx: { value: 0 }, uFade: { value: new THREE.Vector2(0.55, 1.3) } },
} as const;
export type OutlineMode = keyof typeof OUTLINE_MODES;

export function setOutlineViewport(drawingBufferHeight: number): void {
  outlineView.uViewH.value = Math.max(1, drawingBufferHeight);
}

function outlineMaterial(color: THREE.Color, thickness: number, skinned: boolean, base: THREE.Color, mode: OutlineMode = 'crisp'): THREE.MeshBasicMaterial {
  const key = `${color.getHexString()}|${base.getHexString()}|${thickness.toFixed(5)}|${skinned ? 1 : 0}|${mode}`;
  let m = outlineMatCache.get(key);
  if (m) return m;
  m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  m.name = 'OUTLINE';
  const uniforms = { uOutline: { value: thickness }, uBase: { value: base.clone() } };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = uniforms.uOutline;
    shader.uniforms.uBase = uniforms.uBase;
    shader.uniforms.uViewH = outlineView.uViewH;
    shader.uniforms.uMinPx = OUTLINE_MODES[mode].uMinPx;
    shader.uniforms.uFade = OUTLINE_MODES[mode].uFade;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 uBase;\nvarying float vOlFade;\nvoid main() {')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( mix( uBase, diffuse, vOlFade ), opacity );');
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float uOutline;\nuniform float uViewH;\nuniform float uMinPx;\nuniform vec2 uFade;\nvarying float vOlFade;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `
        #if defined( USE_ENVMAP ) || defined( USE_SKINNING )
          vec3 olN = objectNormal;
        #else
          vec3 olN = normal;
        #endif
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        vec3 olViewN = normalize( normalMatrix * olN );
        // 이 거리에서 외곽선 굵기가 화면에서 몇 픽셀인지 (원근 투영)
        float olPx = uOutline * projectionMatrix[1][1] * 0.5 * uViewH / max( -mvPosition.z, 1e-3 );
        vOlFade = smoothstep( uFade.x, uFade.y, olPx );
        mvPosition.xyz += olViewN * uOutline * max( 1.0, uMinPx / max( olPx, 1e-4 ) );
        gl_Position = projectionMatrix * mvPosition;
        `,
      );
  };
  m.customProgramCacheKey = () => 'sce-outline-2';
  // 합치기(bake.ts)가 읽는다: 같은 굵기·모드의 외곽선은 정점 색 외곽선 하나로 합칠 수 있다
  m.userData.outline = { thickness, skinned, mode, base: base.clone() };
  outlineMatCache.set(key, m);
  return m;
}

export interface OutlineInfo {
  thickness: number;
  skinned: boolean;
  mode: OutlineMode;
  base: THREE.Color;
}

/** 외곽선 머티리얼의 굵기·모드·바탕색 (외곽선이 아니면 null) */
export function outlineInfo(m: THREE.Material): OutlineInfo | null {
  const o = m.userData.outline as OutlineInfo | undefined;
  return o && o.base instanceof THREE.Color ? o : null;
}

const outlineVcCache = new Map<string, THREE.MeshBasicMaterial>();

/**
 * 정점 색 외곽선: 선 색(olLine)과 바탕색(olBase)을 정점 속성으로 받는다. 색만 다른 외곽선 여러 개를 메시 하나로 그린다(bake.ts).
 * 셰이더 식은 outlineMaterial과 같다 (mix(바탕색, 선 색, 굵기 페이드)).
 * perVertex: 굵기도 정점 속성(olThick)으로 받는다 (굵기가 다른 외곽선까지 하나로: rigidMerge.ts. thickness는 쓰지 않는다)
 */
export function outlineMaterialVC(thickness: number, skinned: boolean, mode: OutlineMode, perVertex = false): THREE.MeshBasicMaterial {
  const key = `${perVertex ? 'pv' : thickness.toFixed(5)}|${skinned ? 1 : 0}|${mode}`;
  let m = outlineVcCache.get(key);
  if (m) return m;
  m = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide });
  m.name = 'OUTLINE';
  const uOutline = { value: thickness };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = uOutline;
    shader.uniforms.uViewH = outlineView.uViewH;
    shader.uniforms.uMinPx = OUTLINE_MODES[mode].uMinPx;
    shader.uniforms.uFade = OUTLINE_MODES[mode].uFade;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'varying vec3 vOlBase;\nvarying vec3 vOlLine;\nvarying float vOlFade;\nvoid main() {')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( mix( vOlBase, vOlLine, vOlFade ), opacity );');
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        (perVertex ? 'attribute float olThick;\n' : 'uniform float uOutline;\n') +
          'attribute vec3 olLine;\nattribute vec3 olBase;\nvarying vec3 vOlBase;\nvarying vec3 vOlLine;\nuniform float uViewH;\nuniform float uMinPx;\nuniform vec2 uFade;\nvarying float vOlFade;\nvoid main() {\n  vOlBase = olBase;\n  vOlLine = olLine;' +
          (perVertex ? '\n  float uOutline = olThick;' : ''),
      )
      .replace(
        '#include <project_vertex>',
        `
        #if defined( USE_ENVMAP ) || defined( USE_SKINNING )
          vec3 olN = objectNormal;
        #else
          vec3 olN = normal;
        #endif
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        vec3 olViewN = normalize( normalMatrix * olN );
        float olPx = uOutline * projectionMatrix[1][1] * 0.5 * uViewH / max( -mvPosition.z, 1e-3 );
        vOlFade = smoothstep( uFade.x, uFade.y, olPx );
        mvPosition.xyz += olViewN * uOutline * max( 1.0, uMinPx / max( olPx, 1e-4 ) );
        gl_Position = projectionMatrix * mvPosition;
        `,
      );
  };
  m.customProgramCacheKey = () => (perVertex ? 'sce-outline-vc-pv-1' : 'sce-outline-vc-1');
  m.userData.outlineVC = { thickness, skinned, mode, perVertex };
  outlineVcCache.set(key, m);
  return m;
}

/** 하드 엣지 지오메트리(박스 등)에서도 헐이 갈라지지 않도록 위치 기준으로 병합한 매끈한 노멀을 만든다. */
function smoothGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const cached = smoothGeoCache.get(g);
  if (cached) return cached;
  const tmp = new THREE.BufferGeometry();
  tmp.setAttribute('position', g.getAttribute('position').clone());
  for (const name of ['skinIndex', 'skinWeight']) {
    const a = g.getAttribute(name);
    if (a) tmp.setAttribute(name, a.clone());
  }
  if (g.index) tmp.setIndex(g.index.clone());
  // 표정용 셰이프 키(모프 타깃)도 헐이 따라가도록 복사
  if (g.morphAttributes.position) {
    tmp.morphAttributes.position = g.morphAttributes.position.map((a) => a.clone());
    tmp.morphTargetsRelative = g.morphTargetsRelative;
  }
  const merged = mergeVertices(tmp, 1e-4);
  merged.computeVertexNormals();
  merged.groups = g.groups.map((gr) => ({ ...gr }));
  smoothGeoCache.set(g, merged);
  return merged;
}

function inherited<T>(obj: THREE.Object3D, key: string): T | undefined {
  let o: THREE.Object3D | null = obj;
  while (o) {
    if (o.userData && key in o.userData) return o.userData[key] as T;
    o = o.parent;
  }
  return undefined;
}

/**
 * smoothGeometry와 같은 결과(위치 병합 mergeVertices(1e-4) + 매끈한 노멀)를 나눠서 만든다. 큰 레벨 메시 하나를 한 번에 하면
 * 100 ms 넘게 막혀서, 연출이 도는 동안 다음 레벨을 미리 읽을 때 화면이 끊겼다. tick은 정점·삼각형 수천 개마다 부른다
 * (level/loading.ts의 Slicer: 프레임 예산을 넘겼으면 다음 프레임까지 양보). 결과는 smoothGeometry와 같은 캐시에 둔다
 */
export async function smoothGeometryAsync(g: THREE.BufferGeometry, tick: () => Promise<void>): Promise<THREE.BufferGeometry> {
  const cached = smoothGeoCache.get(g);
  if (cached) return cached;
  const STEP = 500;
  // smoothGeometry의 tmp와 같은 속성 (위치, 스킨, 위치 모프)
  const names = ['position', 'skinIndex', 'skinWeight'].filter((n) => !!g.getAttribute(n));
  const attrs = names.map((n) => g.getAttribute(n).clone() as THREE.BufferAttribute);
  const morphs = g.morphAttributes.position?.map((a) => a.clone() as THREE.BufferAttribute) ?? null;
  const index = g.index;
  const count = index ? index.count : attrs[0].count;
  await tick();
  // mergeVertices: 속성 값을 소수 넷째 자리로 잘라 해시
  const tolerance = Math.max(1e-4, Number.EPSILON);
  const mul = Math.pow(10, Math.log10(1 / tolerance));
  const add = tolerance * 0.5 * mul;
  const get = ['getX', 'getY', 'getZ', 'getW'] as const;
  const set = ['setX', 'setY', 'setZ', 'setW'] as const;
  const out = attrs.map((a) => new THREE.BufferAttribute(new (a.array.constructor as new (n: number) => THREE.TypedArray)(a.count * a.itemSize), a.itemSize, a.normalized));
  const outMorph = morphs?.map((a) => new THREE.BufferAttribute(new (a.array.constructor as new (n: number) => THREE.TypedArray)(a.count * a.itemSize), a.itemSize, a.normalized)) ?? null;
  const hashToIndex = new Map<string, number>();
  const newIndex = new Uint32Array(count);
  let next = 0;
  for (let i = 0; i < count; i++) {
    if (i % STEP === STEP - 1) await tick();
    const v = index ? index.getX(i) : i;
    let hash = '';
    for (const a of attrs) for (let k = 0; k < a.itemSize; k++) hash += `${~~(a[get[k]](v) * mul + add)},`;
    const have = hashToIndex.get(hash);
    if (have !== undefined) {
      newIndex[i] = have;
      continue;
    }
    for (let j = 0; j < attrs.length; j++) {
      const a = attrs[j];
      for (let k = 0; k < a.itemSize; k++) {
        out[j][set[k]](next, a[get[k]](v));
        // 위치 모프는 위치(0번)를 따라간다
        if (j === 0 && morphs && outMorph) for (let mi = 0; mi < morphs.length; mi++) outMorph[mi][set[k]](next, morphs[mi][get[k]](v));
      }
    }
    hashToIndex.set(hash, next);
    newIndex[i] = next++;
  }
  const merged = new THREE.BufferGeometry();
  attrs.forEach((a, j) => merged.setAttribute(names[j], new THREE.BufferAttribute(out[j].array.slice(0, next * a.itemSize), a.itemSize, a.normalized)));
  if (morphs && outMorph) {
    merged.morphAttributes.position = outMorph.map((a) => new THREE.BufferAttribute(a.array.slice(0, next * a.itemSize), a.itemSize, a.normalized));
    merged.morphTargetsRelative = g.morphTargetsRelative;
  }
  merged.setIndex(next - 1 >= 65535 ? new THREE.Uint32BufferAttribute(newIndex, 1) : new THREE.Uint16BufferAttribute(newIndex, 1));
  await tick();
  // computeVertexNormals (면적 가중) + normalizeNormals
  const pos = merged.getAttribute('position');
  const nrm = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
  merged.setAttribute('normal', nrm);
  const idx = merged.index!;
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const n = nrm.array as Float32Array;
  for (let i = 0; i < idx.count; i += 3) {
    if (i % (STEP * 3) === 0 && i > 0) await tick();
    const a = idx.getX(i);
    const b = idx.getX(i + 1);
    const c = idx.getX(i + 2);
    pA.fromBufferAttribute(pos, a);
    pB.fromBufferAttribute(pos, b);
    pC.fromBufferAttribute(pos, c);
    cb.subVectors(pC, pB);
    ab.subVectors(pA, pB);
    cb.cross(ab);
    for (const v of [a, b, c]) {
      n[v * 3] += cb.x;
      n[v * 3 + 1] += cb.y;
      n[v * 3 + 2] += cb.z;
    }
  }
  for (let i = 0; i < pos.count; i++) {
    if (i % (STEP * 8) === STEP * 8 - 1) await tick();
    const x = n[i * 3];
    const y = n[i * 3 + 1];
    const z = n[i * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    n[i * 3] = x / len;
    n[i * 3 + 1] = y / len;
    n[i * 3 + 2] = z / len;
  }
  merged.groups = g.groups.map((gr) => ({ ...gr }));
  // 나눠 하는 동안 다른 쪽이 먼저 만들었으면 그것을 쓴다 (같은 지오메트리에 헐 둘이 다른 지오메트리를 갖지 않게)
  const raced = smoothGeoCache.get(g);
  if (raced) return raced;
  smoothGeoCache.set(g, merged);
  return merged;
}

/** 아웃라인 헐을 붙일 메시와 두께 (applyOutlines·prepareOutlines 공용) */
function outlineTargets(root: THREE.Object3D, defaultThickness: number): { mesh: THREE.Mesh; thickness: number; mats: THREE.Material[] }[] {
  const out: { mesh: THREE.Mesh; thickness: number; mats: THREE.Material[] }[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.isOutline) return;
    if (Number(inherited(mesh, 'noOutline') ?? 0) === 1) return;
    const thickness = Number(inherited(mesh, 'outline') ?? defaultThickness);
    if (!(thickness > 0)) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.every((m) => m.name.startsWith('UNLIT_') || m.transparent)) return;
    out.push({ mesh, thickness, mats });
  });
  return out;
}

/** applyOutlines가 쓸 매끈한 헐 지오메트리를 프레임 예산 안에서 나눠 미리 만든다 (그 뒤 applyOutlines는 캐시를 쓴다) */
export async function prepareOutlines(root: THREE.Object3D, tick: () => Promise<void>, defaultThickness = DEFAULT_OUTLINE): Promise<void> {
  for (const t of outlineTargets(root, defaultThickness)) await smoothGeometryAsync(t.mesh.geometry, tick);
}

/** root 아래 모든 메시에 아웃라인 헐을 붙인다. 이미 붙은 헐은 건너뛴다. */
export function applyOutlines(root: THREE.Object3D, defaultThickness = DEFAULT_OUTLINE, opts: { mode?: OutlineMode } = {}): void {
  const mode = opts.mode ?? 'crisp';
  for (const { mesh, thickness, mats } of outlineTargets(root, defaultThickness)) {
    const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh === true;
    const geo = smoothGeometry(mesh.geometry);
    const olMats = mats.map((m) => outlineMaterial(lineColorFor(m), thickness, skinned, (m as THREE.MeshToonMaterial).color ?? lineColorFor(m), mode));
    const material = Array.isArray(mesh.material) ? olMats : olMats[0];

    let hull: THREE.Mesh;
    if (skinned) {
      const sm = mesh as THREE.SkinnedMesh;
      const sh = new THREE.SkinnedMesh(geo, material);
      sh.bind(sm.skeleton, sm.bindMatrix);
      sh.bindMode = sm.bindMode;
      hull = sh;
    } else {
      hull = new THREE.Mesh(geo, material);
    }
    if (mesh.morphTargetInfluences) {
      // 같은 배열을 공유해서 원본 표정이 바뀌면 헐도 같이 바뀐다
      hull.morphTargetInfluences = mesh.morphTargetInfluences;
      hull.morphTargetDictionary = mesh.morphTargetDictionary;
    }
    hull.name = `${mesh.name}__outline`;
    hull.userData.isOutline = true;
    hull.raycast = () => {};
    hull.castShadow = false;
    hull.receiveShadow = false;
    hull.frustumCulled = mesh.frustumCulled;
    mesh.add(hull);
  }
}
