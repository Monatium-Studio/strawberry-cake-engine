import * as THREE from 'three';
import { outlineInfo, outlineMaterialVC } from './toon';
import { cloneMaterial } from './variants';

/**
 * 움직이지 않는 메시를 합친다 (그리기 호출 줄이기, 보이는 결과는 같다).
 *
 * 성능 조사: 큰 장면 한 프레임 그리기 호출 1,060개 가운데 인물이 든 소품이 460개(소품 하나에 메시·외곽선 36개),
 * 부품 많은 탈것 한 대가 190개였다. 모델은 이미 머티리얼마다 한 메시지만, 색만 다른 툰 머티리얼이 열 몇 개씩이다.
 *
 * 규칙
 *  - 움직이는 노드(keep이 참: 바퀴·회전부·문·손잡이처럼 코드가 이름으로 찾거나 돌리는 노드)는 그대로 둔다.
 *    그 노드(또는 루트) 아래 '정적 메시'를 가장 가까운 움직이는 조상 공간으로 옮겨 합친다.
 *  - 정적 메시: 스키닝·모프·인스턴싱이 아니고, 머티리얼이 하나이며 불투명하고, 보이고, 자식이 외곽선 헐뿐이며, keep이 아닌 메시.
 *  - 색만 다른 머티리얼은 하나로: 머티리얼 색을 흰색으로 두고 정점 색에 원래 색(원래 정점 색이 있으면 곱)을 넣는다.
 *    툰 셰이딩은 diffuse × 정점 색이라 결과가 같다. 색 말고 다른 값(발광·맵·깊이 바이어스·종류)이 다르면 따로 합친다.
 *  - 외곽선 헐은 원본과 같은 자리에서 외곽선끼리 합친다. 색만 다르면 정점 색 외곽선(toon.outlineMaterialVC) 하나로.
 *  - 메시가 아닌 노드(빈 오브젝트·묶음)는 남긴다: 이름으로 찾는 자리(socket_*, seat_* 등)가 그대로다.
 *  - 거울 변환(행렬식 < 0)으로 놓인 메시는 삼각형 감김을 뒤집어 앞면이 같게 한다.
 *  - 투명 머티리얼은 그리는 순서가 결과를 바꾸므로 합치지 않는다.
 *  - 레이캐스트 형상 분류(physics/RaycastGeometry.ts의 classifier)가 메시·머티리얼 이름으로 가를 수 있는 것(_fine 장식, 연출 머티리얼, 잎)은
 *    따로 합치고 이름을 잇는다.
 *  - 같은 구조(같은 원본 지오메트리·같은 상대 행렬·같은 색)를 다시 합칠 때는 합친 지오메트리를 다시 쓴다 (cacheKey).
 *  - 정점 색으로 합친 메시는 userData.bakedVC: 색을 바꾸는 연출(그을림 등)은 머티리얼 색 대신 정점 색을 바꾼다 (charGeometry).
 */
export interface BakeOptions {
  /** 그대로 둘 노드 (움직이거나 코드가 이름으로 찾는 메시) */
  keep?: (o: THREE.Object3D) => boolean;
  /** 같은 모델의 다른 복제본과 합친 지오메트리를 나눠 쓴다 (모델 경로 등) */
  cacheKey?: string;
}

export interface BakeStats {
  before: number;
  after: number;
}

interface Item {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  material: THREE.Material;
  /** 이 조각의 색 (머티리얼 색, 외곽선은 선 색) */
  color: THREE.Color;
  /** 외곽선 바탕색 */
  base: THREE.Color | null;
  /** 원래 정점 색을 곱한다 (vertexColors 머티리얼) */
  useVc: boolean;
}

interface Bucket {
  group: THREE.Object3D;
  outline: boolean;
  fine: boolean;
  /** 대표 메시 (그리기 속성: renderOrder, frustumCulled) */
  first: THREE.Mesh;
  items: Item[];
}

const geoCache = new Map<string, THREE.BufferGeometry>();
const vcMatCache = new Map<string, THREE.Material>();

const FINE = /_fine(_\d+)?$/;
const EFFECT = /(^|_)(smoke|cloud|haze|fog|mist|steam|vapor|beam|halo|spill|plume|atmo|portal|vortex|rift|fire|flame)(_|$|\d)/i;
/** 잎 머티리얼: 잎과 잎 아닌 것을 한 메시로 합치면 이름으로 가르는 분류(레이캐스트 형상 등)가 둘을 가르지 못한다 */
const SOFT = /(^|_)(foliage|leaf|leaves|hedge|hedgerow|bush|shrub|pine|needles?|flower|petal|vine|ivy|reed|reeds|fern|moss|wheat|crop|forest|canopy_leaf|net|camo|camonet)(_|$|\d)/i;

function attrSig(g: THREE.BufferGeometry, dropColor: boolean): string {
  return (
    Object.keys(g.attributes)
      .filter((k) => !(dropColor && k === 'color'))
      .sort()
      .map((k) => `${k}${(g.attributes[k] as THREE.BufferAttribute).itemSize}`)
      .join(',') + (g.index ? '|i' : '|n')
  );
}

export type AnyMat = THREE.Material & {
  color?: THREE.Color;
  map?: THREE.Texture | null;
  gradientMap?: THREE.Texture | null;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  emissiveMap?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  fog?: boolean;
  wireframe?: boolean;
  flatShading?: boolean;
};

/** 색 말고 셰이더·그리기 상태를 가르는 값 (ignoreVc: 정점 색 사용 여부는 빼고 본다. 합친 쪽이 모두 정점 색을 쓸 때) */
export function classKey(m: AnyMat, ignoreVc = false): string {
  return [
    m.type,
    m.map?.uuid ?? '',
    m.gradientMap?.uuid ?? '',
    m.emissive?.getHexString() ?? '',
    m.emissiveIntensity ?? '',
    m.emissiveMap?.uuid ?? '',
    m.normalMap?.uuid ?? '',
    m.side,
    m.opacity,
    m.alphaTest,
    m.depthWrite ? 1 : 0,
    m.depthTest ? 1 : 0,
    m.depthFunc,
    m.polygonOffset ? `${m.polygonOffsetFactor},${m.polygonOffsetUnits}` : '',
    m.customProgramCacheKey(),
    m.toneMapped ? 1 : 0,
    m.fog ? 1 : 0,
    ignoreVc ? '' : m.vertexColors ? 1 : 0,
    m.blending,
    m.colorWrite ? 1 : 0,
    m.wireframe ? 1 : 0,
    m.flatShading ? 1 : 0,
    m.stencilWrite ? 1 : 0,
    EFFECT.test(m.name) ? 'fx' : '',
    SOFT.test(m.name) ? 'soft' : '',
  ].join('|');
}

/** 합칠 수 있는 평범한 메시 (스키닝·모프·인스턴싱·여러 머티리얼·부분 그리기 아님) */
export function plainMesh(m: THREE.Mesh): boolean {
  if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || (m as THREE.InstancedMesh).isInstancedMesh) return false;
  if (Array.isArray(m.material) || !m.material) return false;
  const g = m.geometry;
  if (!g || !g.attributes.position || Object.keys(g.morphAttributes).length) return false;
  if (g.drawRange.start !== 0 || (g.drawRange.count !== Infinity && g.drawRange.count < (g.index ? g.index.count : g.attributes.position.count))) return false;
  return true;
}

/** 메시가 아닌 모든 것을 남기고, 정적 메시를 합친다 */
export function bakeStatic(root: THREE.Object3D, opts: BakeOptions = {}): BakeStats {
  const keep = opts.keep ?? (() => false);
  const buckets = new Map<string, Bucket>();
  let before = 0;
  const removed: THREE.Mesh[] = [];

  /** 정적 메시인가 (외곽선 헐은 원본과 함께) */
  const mergeable = (m: THREE.Mesh): boolean => {
    if (m.userData.isOutline || !plainMesh(m) || keep(m) || !m.visible) return false;
    const mat = m.material as AnyMat;
    if (mat.transparent || !mat.visible || !mat.color) return false;
    const col = m.geometry.attributes.color as THREE.BufferAttribute | undefined;
    // 정점 색 머티리얼인데 정점 색이 없거나 알파가 있으면 그대로 둔다
    if (mat.vertexColors && (!col || col.itemSize !== 3)) return false;
    for (const c of m.children) {
      const h = c as THREE.Mesh;
      if (!h.userData.isOutline || !plainMesh(h) || h.children.length || !h.visible) return false;
      if (h.position.lengthSq() > 0 || h.quaternion.w !== 1 || h.scale.x !== 1 || h.scale.y !== 1 || h.scale.z !== 1) return false;
      if (!outlineInfo(h.material as THREE.Material)) return false;
    }
    return true;
  };

  const add = (group: THREE.Object3D, mesh: THREE.Mesh, matrix: THREE.Matrix4, owner: THREE.Mesh): void => {
    const mat = mesh.material as AnyMat;
    const outline = !!mesh.userData.isOutline;
    const fine = FINE.test(owner.name) || (!!owner.parent && FINE.test(owner.parent.name));
    let key: string;
    let item: Item;
    if (outline) {
      const o = outlineInfo(mat)!;
      key = `${group.id}|O|${o.thickness.toFixed(5)}|${o.mode}|${attrSig(mesh.geometry, true)}|${mesh.renderOrder}|${mesh.frustumCulled ? 1 : 0}`;
      item = { mesh, geo: mesh.geometry, matrix, material: mat, color: mat.color!.clone(), base: o.base.clone(), useVc: false };
    } else {
      // 원래 정점 색을 쓰는 머티리얼은 같은 머티리얼끼리만 (그을림 보간이 색 × 정점 색 순서라 정점 색으로 옮기면 달라진다)
      const cls = mat.vertexColors ? `vc:${mat.uuid}` : classKey(mat);
      key = `${group.id}|B|${cls}|${attrSig(mesh.geometry, !mat.vertexColors)}|${fine ? 'f' : ''}|${mesh.renderOrder}|${mesh.frustumCulled ? 1 : 0}`;
      item = { mesh, geo: mesh.geometry, matrix, material: mat, color: mat.color!.clone(), base: null, useVc: !!mat.vertexColors };
    }
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { group, outline, fine, first: mesh, items: [] }));
    b.items.push(item);
  };

  /** group: 가장 가까운 남길 조상, rel: group 공간 → 지금 노드의 부모 공간 */
  const walk = (o: THREE.Object3D, group: THREE.Object3D, rel: THREE.Matrix4): void => {
    for (const c of o.children.slice()) {
      const m = c as THREE.Mesh;
      if (m.isMesh) before++;
      if (m.isMesh && m.userData.isOutline) continue;
      c.updateMatrix();
      const local = new THREE.Matrix4().multiplyMatrices(rel, c.matrix);
      if (m.isMesh && mergeable(m)) {
        add(group, m, local, m);
        for (const h of m.children) {
          before++;
          add(group, h as THREE.Mesh, local, m);
        }
        removed.push(m);
        continue;
      }
      // 남기는 노드(움직이는 노드, 합칠 수 없는 메시, 숨은 노드)는 새 기준이 된다. 그냥 묶음은 행렬을 쌓아 내려간다
      const anchor = keep(c) || m.isMesh || !c.visible;
      if (anchor) walk(c, c, new THREE.Matrix4());
      else walk(c, group, local);
    }
  };
  walk(root, root, new THREE.Matrix4());

  // 합칠 수 있는 메시는 모두 묶음 쪽으로 옮긴다 (원본과 외곽선 헐이 따로 남거나 빠지지 않게)
  let after = 0;
  for (const b of buckets.values()) {
    const mats = new Set(b.items.map((x) => x.material));
    const vc = mats.size > 1;
    let mesh: THREE.Mesh;
    if (b.items.length === 1) {
      const it = b.items[0];
      mesh = new THREE.Mesh(it.geo, it.material);
      mesh.matrix.copy(it.matrix);
      mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    } else {
      const sig = opts.cacheKey
        ? `${opts.cacheKey}|${b.group.name}|${vc ? 1 : 0}|${b.items.map((x) => `${x.geo.uuid}:${x.color.getHexString()}:${x.base?.getHexString() ?? ''}:${x.matrix.elements.map((e) => e.toFixed(5)).join(',')}`).join(';')}`
        : null;
      let geo = sig ? geoCache.get(sig) : undefined;
      if (!geo) {
        geo = mergeItems(b.items, vc ? (b.outline ? 'outline' : 'color') : null);
        if (sig) geoCache.set(sig, geo);
      }
      const first = b.items[0].material;
      let material: THREE.Material = first;
      if (vc && b.outline) {
        const o = outlineInfo(first)!;
        material = outlineMaterialVC(o.thickness, false, o.mode);
      } else if (vc) material = vcMaterial(first as AnyMat);
      mesh = new THREE.Mesh(geo, material);
      if (vc && !b.outline) mesh.userData.bakedVC = true;
    }
    after++;
    // 움직이지 않는다: 행렬을 한 번만 (부모가 움직이면 matrixWorld는 그대로 따라간다)
    mesh.matrixAutoUpdate = false;
    mesh.name = `${b.group.name || 'root'}__baked${b.outline ? '_outline' : ''}${b.fine ? '_fine' : ''}`;
    mesh.renderOrder = b.first.renderOrder;
    mesh.frustumCulled = b.first.frustumCulled;
    mesh.castShadow = b.first.castShadow;
    mesh.receiveShadow = b.first.receiveShadow;
    mesh.userData.baked = true;
    if (b.outline) {
      mesh.userData.isOutline = true;
      mesh.raycast = () => {};
    }
    b.group.add(mesh);
  }
  // 옮긴 원본을 뗀다 (외곽선 헐은 원본의 자식이라 같이 떨어진다)
  for (const m of removed) m.removeFromParent();
  let unmerged = before;
  for (const b of buckets.values()) unmerged -= b.items.length;
  return { before, after: after + unmerged };
}

/** 색을 정점 색으로 받는 같은 종류의 머티리얼 (색은 흰색) */
function vcMaterial(m: AnyMat): THREE.Material {
  const key = classKey(m);
  let c = vcMatCache.get(key);
  if (!c) {
    c = cloneMaterial(m);
    (c as AnyMat).color!.setRGB(1, 1, 1);
    c.vertexColors = true;
    c.name = `${m.name}__vc`;
    vcMatCache.set(key, c);
  }
  return c;
}

/** 같은 자리 성분을 Float32로 (정규화·인터리브 풀기) */
export function floatAttr(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const n = a.count;
  const s = a.itemSize;
  const out = new Float32Array(n * s);
  for (let i = 0; i < n; i++) {
    out[i * s] = a.getX(i);
    if (s > 1) out[i * s + 1] = a.getY(i);
    if (s > 2) out[i * s + 2] = a.getZ(i);
    if (s > 3) out[i * s + 3] = a.getW(i);
  }
  return out;
}

const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();

/** mode color: color 속성 = 머티리얼 색(× 원래 정점 색). outline: olLine·olBase 속성 */
function mergeItems(items: Item[], mode: 'color' | 'outline' | null): THREE.BufferGeometry {
  const names = Object.keys(items[0].geo.attributes).filter((k) => !(mode && k === 'color'));
  const indexed = !!items[0].geo.index;
  let verts = 0;
  let idx = 0;
  for (const it of items) {
    verts += it.geo.attributes.position.count;
    if (indexed) idx += it.geo.index!.count;
  }
  const arrays: Record<string, { data: Float32Array; size: number }> = {};
  for (const k of names) {
    const s = (items[0].geo.attributes[k] as THREE.BufferAttribute).itemSize;
    arrays[k] = { data: new Float32Array(verts * s), size: s };
  }
  if (mode === 'color') arrays.color = { data: new Float32Array(verts * 3), size: 3 };
  if (mode === 'outline') {
    arrays.olLine = { data: new Float32Array(verts * 3), size: 3 };
    arrays.olBase = { data: new Float32Array(verts * 3), size: 3 };
  }
  const all = Object.keys(arrays);
  const index = indexed ? (verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx)) : null;
  let vo = 0;
  let io = 0;
  for (const it of items) {
    const g = it.geo;
    const n = g.attributes.position.count;
    const flip = it.matrix.determinant() < 0;
    _n.getNormalMatrix(it.matrix);
    for (const k of names) {
      const a = arrays[k];
      const src = floatAttr(g.attributes[k] as THREE.BufferAttribute);
      if (k === 'position') {
        for (let i = 0; i < n; i++) _v.fromArray(src, i * 3).applyMatrix4(it.matrix).toArray(a.data, (vo + i) * 3);
      } else if (k === 'normal') {
        for (let i = 0; i < n; i++) _v.fromArray(src, i * 3).applyNormalMatrix(_n).toArray(a.data, (vo + i) * 3);
      } else if (k === 'tangent') {
        for (let i = 0; i < n; i++) {
          _v.fromArray(src, i * 4).transformDirection(it.matrix);
          a.data[(vo + i) * 4] = _v.x;
          a.data[(vo + i) * 4 + 1] = _v.y;
          a.data[(vo + i) * 4 + 2] = _v.z;
          a.data[(vo + i) * 4 + 3] = src[i * 4 + 3] * (flip ? -1 : 1);
        }
      } else a.data.set(src, vo * a.size);
    }
    if (mode === 'color') {
      const out = arrays.color.data;
      const srcC = it.useVc ? floatAttr(g.attributes.color as THREE.BufferAttribute) : null;
      const c = it.color;
      for (let i = 0; i < n; i++) {
        const o = (vo + i) * 3;
        out[o] = c.r * (srcC ? srcC[i * 3] : 1);
        out[o + 1] = c.g * (srcC ? srcC[i * 3 + 1] : 1);
        out[o + 2] = c.b * (srcC ? srcC[i * 3 + 2] : 1);
      }
    } else if (mode === 'outline') {
      const line = arrays.olLine.data;
      const base = arrays.olBase.data;
      for (let i = 0; i < n; i++) {
        it.color.toArray(line, (vo + i) * 3);
        it.base!.toArray(base, (vo + i) * 3);
      }
    }
    if (index) {
      const gi = g.index!;
      const c = gi.count;
      for (let i = 0; i < c; i += 3) {
        const a = gi.getX(i) + vo;
        const b = gi.getX(i + 1) + vo;
        const d = gi.getX(i + 2) + vo;
        index[io + i] = a;
        index[io + i + 1] = flip ? d : b;
        index[io + i + 2] = flip ? b : d;
      }
      io += c;
    } else if (flip) {
      // 색인 없는 삼각형: 둘째·셋째 꼭짓점을 바꾼다
      for (const k of all) {
        const a = arrays[k];
        const s = a.size;
        for (let t = vo; t + 2 < vo + n; t += 3) {
          for (let j = 0; j < s; j++) {
            const x = a.data[(t + 1) * s + j];
            a.data[(t + 1) * s + j] = a.data[(t + 2) * s + j];
            a.data[(t + 2) * s + j] = x;
          }
        }
      }
    }
    vo += n;
  }
  const out = new THREE.BufferGeometry();
  for (const k of all) out.setAttribute(k, new THREE.BufferAttribute(arrays[k].data, arrays[k].size));
  if (index) out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

const charCache = new Map<string, THREE.BufferGeometry>();

/**
 * 캐시를 비운다. 열쇠에 원본 형상·머티리얼의 uuid가 들어가 한 번 읽은 템플릿 안에서만 다시 쓰인다: 같은 페이지에서 화면을 바꾸면
 * (core/session.ts 판 끝) 다음 판은 새로 읽은 템플릿이라 옛 항목은 다시 쓰이지 않고 합친 형상만 붙잡는다
 */
export function clearBakeCaches(): void {
  geoCache.clear();
  vcMatCache.clear();
  charCache.clear();
}

/**
 * 격파 그을림 (wreck.ts): 정점 색으로 합친 메시는 머티리얼 색이 흰색이라, 원래처럼 '각 부품 색 → 그을린 색' 보간을 정점 색에 한다.
 * 같은 지오메트리·같은 값이면 나눠 쓴다
 */
export function charGeometry(geo: THREE.BufferGeometry, to: THREE.Color, k: number): THREE.BufferGeometry {
  const key = `${geo.uuid}|${to.getHexString()}|${k}`;
  let g = charCache.get(key);
  if (!g) {
    g = new THREE.BufferGeometry();
    for (const [n, a] of Object.entries(geo.attributes)) g.setAttribute(n, a);
    g.index = geo.index;
    g.boundingBox = geo.boundingBox;
    g.boundingSphere = geo.boundingSphere;
    const src = geo.attributes.color as THREE.BufferAttribute;
    const out = new Float32Array(src.count * 3);
    for (let i = 0; i < src.count; i++) {
      out[i * 3] = THREE.MathUtils.lerp(src.getX(i), to.r, k);
      out[i * 3 + 1] = THREE.MathUtils.lerp(src.getY(i), to.g, k);
      out[i * 3 + 2] = THREE.MathUtils.lerp(src.getZ(i), to.b, k);
    }
    g.setAttribute('color', new THREE.BufferAttribute(out, 3));
    charCache.set(key, g);
  }
  return g;
}
