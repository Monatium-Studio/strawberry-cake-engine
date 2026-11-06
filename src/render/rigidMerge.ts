import * as THREE from 'three';
import { classKey, floatAttr, plainMesh, type AnyMat } from './bake';
import { outlineInfo, outlineMaterialVC, type OutlineMode } from './toon';
import { cloneMaterial } from './variants';

/**
 * 움직이는 부품이 많은 모델(탈것·기계)을 머티리얼 종류마다 메시 하나로 그린다 (그리기 호출 줄이기, 보이는 결과와 움직임은 같다).
 *
 * bakeStatic(bake.ts)은 움직이는 노드마다 정적 메시를 합쳐서, 바퀴·궤도·회전부·해치 부품이 많은 모델은
 * 노드마다 몸·외곽선 메시가 남았다 (한 대가 그리기 108번). 여기서는 그 메시를 모두 '뼈 하나에 가중치 1'인 스킨 메시로 합친다.
 *  - 뼈 = 원래 그 메시를 움직이던 노드 (bakeStatic이 남긴 노드: 바퀴, 회전부, 해치, 문 …). 코드는 지금처럼 노드를 돌리고 옮긴다.
 *    정점은 그 노드 공간으로 미리 옮겨 두고(역바인드 = 단위 행렬), 셰이더가 뼈 행렬(노드 matrixWorld)로 놓는다.
 *  - 뼈대(Skeleton)는 모델 하나에 하나: 몸·외곽선·유리 메시가 같이 쓰니 프레임당 한 번만 뼈 행렬을 계산하고 올린다
 *    (화면에서 걸러진 모델은 갱신하지 않는다).
 *  - 노드나 그 조상이 숨으면(visible = false: 떼어 낸 부품 등) 그 뼈의 정점을 카메라 먼 곳 아래로 접어 보이지 않게 한다.
 *  - 원본 메시는 그대로 두고 그리기 층만 SOURCE_LAYER로 옮긴다: 레이캐스트 형상(RaycastGeometry), 파편 표본, 그을림처럼
 *    원본 메시를 읽는 코드가 그대로 돈다. 처음부터 숨어 있던 노드(잔해 부품 등)는 합치지 않는다 (보일 때 따로 그린다).
 *  - 색만 다른 툰 머티리얼은 흰 머티리얼 + 정점 색으로, 외곽선은 모드마다 정점 색·정점 굵기 외곽선(스키닝 갈래) 하나로,
 *    유리(투명 + 뒷면·앞면 두 그룹)는 같은 머티리얼끼리 그룹 둘짜리 메시 하나로.
 *  - 스킨 갈래는 머티리얼을 따로 복제한다 (스킨 없는 메시와 머티리얼을 같이 쓰면 그릴 때마다 프로그램을 다시 고른다: variants.ts).
 *  - 화면 거르기는 모델 경계 구 하나 (옵션 sphere). 부품이 모델 밖으로 날아가는 동안(파편이 날아가는 연출 등)은 setCulled(false).
 */

/** 원본 메시를 옮겨 두는 그리기 층 (카메라는 이 층을 보지 않는다) */
export const SOURCE_LAYER = 30;

export interface RigidMergeOptions {
  /** 이 노드와 그 아래는 합치지 않는다 (코드가 머티리얼을 바꾸는 등) */
  skip?: (o: THREE.Object3D) => boolean;
  /** 같은 모델의 다른 복제본과 합친 지오메트리를 나눠 쓴다 (모델 경로 등) */
  cacheKey?: string;
  /** 따로 묶을 메시: 같은 값끼리만 합치고 머티리얼은 이 모델 몫으로 복제한다 (등처럼 코드가 밝기를 바꿀 때). 결과의 tagged */
  tag?: (m: THREE.Mesh) => string | null;
  /** 머티리얼 색 대신 정점 색으로 넣을 색 (코드가 머티리얼 색을 바꿔 둔 메시: 등의 원래 색) */
  colorOf?: (m: THREE.Mesh) => THREE.Color | null;
  /** root 공간 경계 구 (화면 거르기). 없으면 합친 원본의 경계 구를 1.3배 + 0.5 m로 부풀린다 (회전부가 돌고 문이 열려도 들어오게) */
  sphere?: THREE.Sphere;
}

export interface RigidMerge {
  readonly meshes: THREE.SkinnedMesh[];
  readonly skeleton: THREE.Skeleton;
  /** 합친 원본 메시 (그리기 층만 옮김) */
  readonly sources: THREE.Mesh[];
  /** 합치기 전 그리던 메시 수, 합친 뒤 (남은 것 포함) */
  readonly before: number;
  readonly after: number;
  /** tag로 따로 묶은 메시: 값, 합친 메시, 그 머티리얼(이 모델 몫), 합친 원본 */
  readonly tagged: { tag: string; mesh: THREE.SkinnedMesh; material: THREE.Material; sources: THREE.Mesh[] }[];
  setCulled(on: boolean): void;
}

interface Item {
  geo: THREE.BufferGeometry;
  /** 원본 지오메트리 → 뼈 공간 */
  matrix: THREE.Matrix4;
  bone: number;
  /** 몸: 색(× 원래 정점 색), 외곽선: 선 색 */
  color: THREE.Color;
  useVc: boolean;
  /** 단색 외곽선의 바탕색 */
  base: THREE.Color | null;
  /** 정점 색 외곽선 (olLine·olBase 속성이 있다) */
  vcOutline: boolean;
  /** 외곽선 굵기 */
  thick: number;
}

type Kind = 'body' | 'outline' | 'glass';

interface Bucket {
  kind: Kind;
  key: string;
  first: THREE.Mesh;
  uv: boolean;
  outline?: { mode: OutlineMode };
  /** 유리: 그룹마다 머티리얼 (뒷면, 앞면) */
  groupMats?: THREE.Material[];
  /** 따로 묶은 값 (tag) */
  tag?: string;
  items: Item[];
  sources: THREE.Mesh[];
}

const geoCache = new Map<string, THREE.BufferGeometry>();
const matCache = new Map<string, THREE.Material>();

/** 캐시를 비운다 (열쇠에 원본 uuid: 판이 끝나면 다시 쓰이지 않는다. render/bake.ts clearBakeCaches와 같다) */
export function clearRigidMergeCaches(): void {
  geoCache.clear();
  matCache.clear();
}

/** 숨은 뼈: 아주 작게 접어 카메라 먼 곳(600 m) 밖 아래로 */
const HIDDEN = new THREE.Matrix4().makeScale(1e-4, 1e-4, 1e-4).setPosition(0, -1e6, 0);

function needsUv(m: AnyMat & Record<string, unknown>): boolean {
  return !!(m.map || m.alphaMap || m.emissiveMap || m.bumpMap || m.aoMap || m.lightMap || m.displacementMap || m.specularMap);
}

/** 스킨 갈래로 쓸 몸 머티리얼: 색은 흰색, 정점 색을 받는다 (색만 다른 것끼리 하나) */
function bodyMaterial(src: AnyMat): THREE.Material {
  const key = `B|${classKey(src, true)}`;
  let m = matCache.get(key);
  if (!m) {
    m = cloneMaterial(src);
    (m as AnyMat).color!.setRGB(1, 1, 1);
    m.vertexColors = true;
    m.name = `${src.name}__rigid`;
    matCache.set(key, m);
  }
  return m;
}

/** 스킨 갈래로 쓸 유리 머티리얼 (원본 하나마다 복제 하나) */
function glassMaterial(src: THREE.Material): THREE.Material {
  const key = `G|${src.uuid}`;
  let m = matCache.get(key);
  if (!m) {
    m = cloneMaterial(src);
    m.name = `${src.name}__rigid`;
    matCache.set(key, m);
  }
  return m;
}

/** bakeStatic이 만든 메시와 외곽선 헐은 부모에 붙어만 있다 (코드가 따로 움직이지 않는다) */
function isStatic(o: THREE.Object3D): boolean {
  return (o as THREE.Mesh).isMesh === true && (o.userData.baked === true || o.userData.isOutline === true);
}

/** root 아래 보이는 메시를 뼈 하나짜리 스킨 메시로 합친다. 합칠 것이 없으면 null */
export function rigidMerge(root: THREE.Object3D, opts: RigidMergeOptions): RigidMerge | null {
  root.updateMatrixWorld(true);
  const bones: THREE.Object3D[] = [];
  const boneIndex = new Map<THREE.Object3D, number>();
  const buckets = new Map<string, Bucket>();
  const sources: THREE.Mesh[] = [];
  let before = 0;

  const anchor = (m: THREE.Mesh): { bone: number; matrix: THREE.Matrix4 } => {
    const matrix = new THREE.Matrix4();
    let o: THREE.Object3D = m;
    while (o !== root && o.parent && isStatic(o)) {
      matrix.premultiply(o.matrix);
      o = o.parent;
    }
    let bone = boneIndex.get(o);
    if (bone === undefined) {
      bone = bones.length;
      bones.push(o);
      boneIndex.set(o, bone);
    }
    return { bone, matrix };
  };

  /** mesh가 들어갈 묶음 (검사를 마친 뒤 부른다) */
  const bucket = (key: string, kind: Kind, mesh: THREE.Mesh, uv: boolean): Bucket => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { kind, key, first: mesh, uv, items: [], sources: [] }));
    b.sources.push(mesh);
    return b;
  };

  const tryBody = (m: THREE.Mesh): boolean => {
    if (!plainMesh(m)) return false;
    const mat = m.material as AnyMat & Record<string, unknown>;
    if (mat.transparent || !mat.visible || !mat.color || mat.normalMap) return false;
    const g = m.geometry;
    if (!g.attributes.normal) return false;
    const col = g.attributes.color as THREE.BufferAttribute | undefined;
    if (mat.vertexColors && (!col || col.itemSize !== 3)) return false;
    const uv = needsUv(mat);
    if (uv && !g.attributes.uv) return false;
    const a = anchor(m);
    const tag = opts.tag?.(m) ?? null;
    const b = bucket(`${tag ? `T:${tag}|` : ''}B|${classKey(mat, true)}|${uv ? 1 : 0}|${m.renderOrder}`, 'body', m, uv);
    if (tag) b.tag = tag;
    b.items.push({ geo: g, matrix: a.matrix, bone: a.bone, color: (opts.colorOf?.(m) ?? mat.color).clone(), useVc: !!mat.vertexColors, base: null, vcOutline: false, thick: 0 });
    return true;
  };

  const tryOutline = (m: THREE.Mesh): boolean => {
    if (!plainMesh(m)) return false;
    const mat = m.material as THREE.MeshBasicMaterial;
    const g = m.geometry;
    if (!g.attributes.normal || !mat.visible) return false;
    const info = outlineInfo(mat);
    const vc = mat.userData.outlineVC as { thickness: number; skinned: boolean; mode: OutlineMode } | undefined;
    let o: { thickness: number; mode: OutlineMode };
    let item: Omit<Item, 'bone' | 'matrix'>;
    if (info && !info.skinned) {
      o = info;
      item = { geo: g, color: mat.color.clone(), useVc: false, base: info.base.clone(), vcOutline: false, thick: info.thickness };
    } else if (vc && !vc.skinned && g.attributes.olLine && g.attributes.olBase && !g.attributes.olThick) {
      o = vc;
      item = { geo: g, color: new THREE.Color(1, 1, 1), useVc: false, base: null, vcOutline: true, thick: vc.thickness };
    } else return false;
    const a = anchor(m);
    // 굵기는 정점 속성(olThick)이라 굵기가 달라도 모드가 같으면 하나
    const b = bucket(`O|${o.mode}|${m.renderOrder}`, 'outline', m, false);
    b.outline = { mode: o.mode };
    b.items.push({ ...item, bone: a.bone, matrix: a.matrix });
    return true;
  };

  /** 유리: 투명 머티리얼 그룹이 모두 전체 범위를 그린다 (variants.ts의 뒷면·앞면 나누기) */
  const tryGlass = (m: THREE.Mesh): boolean => {
    if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || (m as THREE.InstancedMesh).isInstancedMesh || !Array.isArray(m.material)) return false;
    const g = m.geometry;
    if (!g.attributes.position || !g.attributes.normal || Object.keys(g.morphAttributes).length || !g.groups.length) return false;
    const count = g.index ? g.index.count : g.attributes.position.count;
    const mats: THREE.Material[] = [];
    let uv = false;
    for (const gr of g.groups) {
      const mm = m.material[gr.materialIndex ?? 0] as AnyMat & Record<string, unknown>;
      if (!mm || gr.start !== 0 || gr.count < count || !mm.transparent || !mm.visible || mm.vertexColors || mm.normalMap) return false;
      if (needsUv(mm)) uv = true;
      mats.push(mm);
    }
    if (uv && !g.attributes.uv) return false;
    const a = anchor(m);
    const b = bucket(`G|${mats.map((x) => x.uuid).join(',')}|${uv ? 1 : 0}|${m.renderOrder}`, 'glass', m, uv);
    b.groupMats = mats;
    b.items.push({ geo: g, matrix: a.matrix, bone: a.bone, color: new THREE.Color(1, 1, 1), useVc: false, base: null, vcOutline: false, thick: 0 });
    return true;
  };

  const walk = (o: THREE.Object3D): void => {
    // 처음부터 숨은 노드(잔해 부품, 충돌 메시)와 건너뛸 노드는 그대로 둔다
    if (!o.visible || (opts.skip && opts.skip(o))) return;
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      before += Array.isArray(m.material) ? Math.max(1, m.geometry.groups.length) : 1;
      if (m.layers.mask === 1) {
        const ok = m.userData.isOutline ? tryOutline(m) : Array.isArray(m.material) ? tryGlass(m) : tryBody(m);
        if (ok) sources.push(m);
      }
    }
    for (const c of o.children) walk(c);
  };
  for (const c of root.children) walk(c);
  if (!sources.length) return null;

  const skeleton = new THREE.Skeleton(bones as THREE.Bone[], bones.map(() => new THREE.Matrix4()));
  // 뼈 행렬 = 노드 matrixWorld (역바인드는 단위 행렬). 노드나 조상이 숨었으면 접는다
  skeleton.update = function (this: THREE.Skeleton): void {
    const out = this.boneMatrices;
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      let shown = true;
      for (let x: THREE.Object3D | null = b; x; x = x.parent) {
        if (!x.visible) {
          shown = false;
          break;
        }
        if (x === root) break;
      }
      (shown ? b.matrixWorld : HIDDEN).toArray(out, i * 16);
    }
    if (this.boneTexture) this.boneTexture.needsUpdate = true;
  };

  const meshes: THREE.SkinnedMesh[] = [];
  const tagged: RigidMerge['tagged'] = [];
  let sphere = opts.sphere?.clone();
  if (!sphere) {
    const all = new THREE.Box3();
    const tmp = new THREE.Box3();
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const mm = new THREE.Matrix4();
    for (const s of sources) {
      if (!s.geometry.boundingBox) s.geometry.computeBoundingBox();
      all.union(tmp.copy(s.geometry.boundingBox!).applyMatrix4(mm.multiplyMatrices(inv, s.matrixWorld)));
    }
    sphere = all.getBoundingSphere(new THREE.Sphere());
    sphere.radius = sphere.radius * 1.3 + 0.5;
  }
  const box = sphere.getBoundingBox(new THREE.Box3());
  for (const b of buckets.values()) {
    const sig = opts.cacheKey
      ? `${opts.cacheKey}|${b.key}|${b.items.map((x) => `${x.geo.uuid}:${x.bone}:${x.thick}:${x.color.getHexString()}:${x.base?.getHexString() ?? ''}:${x.matrix.elements.map((e) => e.toFixed(5)).join(',')}`).join(';')}`
      : null;
    let geo = sig ? geoCache.get(sig) : undefined;
    if (!geo) {
      geo = mergeItems(b.items, b.kind, b.uv);
      if (b.kind === 'glass') {
        const n = geo.index!.count;
        b.groupMats!.forEach((_, i) => geo!.addGroup(0, n, i));
      }
      if (sig) geoCache.set(sig, geo);
    }
    let material: THREE.Material | THREE.Material[];
    if (b.kind === 'outline') material = outlineMaterialVC(0, true, b.outline!.mode, true);
    else if (b.kind === 'glass') material = b.groupMats!.map(glassMaterial);
    else if (b.tag) {
      // 이 모델 몫 (코드가 밝기를 바꾼다)
      material = cloneMaterial(b.first.material as THREE.Material);
      (material as AnyMat).color!.setRGB(1, 1, 1);
      material.vertexColors = true;
      material.name = `${(b.first.material as THREE.Material).name}__rigid_${b.tag}`;
    } else material = bodyMaterial(b.first.material as AnyMat);
    const mesh = new THREE.SkinnedMesh(geo, material);
    mesh.bind(skeleton, new THREE.Matrix4());
    mesh.name = `${root.name || 'model'}__rigid_${b.kind}`;
    mesh.boundingSphere = sphere;
    mesh.boundingBox = box;
    mesh.renderOrder = b.first.renderOrder;
    mesh.castShadow = b.first.castShadow;
    mesh.receiveShadow = b.first.receiveShadow;
    mesh.userData.rigid = true;
    mesh.raycast = () => {};
    if (b.kind === 'outline') mesh.userData.isOutline = true;
    // 격파 그을림(wreck.ts)은 정점 색을 바꾼다 (charGeometry: 스킨 속성도 그대로 나눠 쓴다)
    if (b.kind === 'body') mesh.userData.bakedVC = true;
    root.add(mesh);
    meshes.push(mesh);
    if (b.tag) tagged.push({ tag: b.tag, mesh, material: material as THREE.Material, sources: b.sources });
  }
  for (const s of sources) s.layers.set(SOURCE_LAYER);
  return {
    meshes,
    skeleton,
    sources,
    tagged,
    before,
    after: before - sources.reduce((n, s) => n + (Array.isArray(s.material) ? Math.max(1, s.geometry.groups.length) : 1), 0) + meshes.reduce((n, m) => n + (Array.isArray(m.material) ? m.material.length : 1), 0),
    setCulled(on: boolean): void {
      for (const m of meshes) m.frustumCulled = on;
    },
  };
}

const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();

/** 뼈 공간으로 옮긴 위치·법선(·uv) + 색(몸) 또는 olLine·olBase(외곽선) + 뼈 번호·가중치 */
function mergeItems(items: Item[], kind: Kind, uv: boolean): THREE.BufferGeometry {
  let verts = 0;
  let idx = 0;
  for (const it of items) {
    const n = it.geo.attributes.position.count;
    verts += n;
    idx += it.geo.index ? it.geo.index.count : n;
  }
  const pos = new Float32Array(verts * 3);
  const nor = new Float32Array(verts * 3);
  const uvs = uv ? new Float32Array(verts * 2) : null;
  const col = kind === 'body' ? new Float32Array(verts * 3) : null;
  const olLine = kind === 'outline' ? new Float32Array(verts * 3) : null;
  const olBase = kind === 'outline' ? new Float32Array(verts * 3) : null;
  const olThick = kind === 'outline' ? new Float32Array(verts) : null;
  const skinIndex = new Uint16Array(verts * 4);
  const skinWeight = new Uint8Array(verts * 4);
  const index = verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  let vo = 0;
  let io = 0;
  for (const it of items) {
    const g = it.geo;
    const n = g.attributes.position.count;
    const flip = it.matrix.determinant() < 0;
    _n.getNormalMatrix(it.matrix);
    const p = floatAttr(g.attributes.position as THREE.BufferAttribute);
    const nn = floatAttr(g.attributes.normal as THREE.BufferAttribute);
    for (let i = 0; i < n; i++) {
      _v.fromArray(p, i * 3).applyMatrix4(it.matrix).toArray(pos, (vo + i) * 3);
      _v.fromArray(nn, i * 3).applyNormalMatrix(_n).toArray(nor, (vo + i) * 3);
      skinIndex[(vo + i) * 4] = it.bone;
      skinWeight[(vo + i) * 4] = 255;
    }
    if (uvs) uvs.set(floatAttr(g.attributes.uv as THREE.BufferAttribute).subarray(0, n * 2), vo * 2);
    if (col) {
      const src = it.useVc ? floatAttr(g.attributes.color as THREE.BufferAttribute) : null;
      const c = it.color;
      for (let i = 0; i < n; i++) {
        const o = (vo + i) * 3;
        col[o] = c.r * (src ? src[i * 3] : 1);
        col[o + 1] = c.g * (src ? src[i * 3 + 1] : 1);
        col[o + 2] = c.b * (src ? src[i * 3 + 2] : 1);
      }
    }
    if (olThick) olThick.fill(it.thick, vo, vo + n);
    if (olLine && olBase) {
      if (it.vcOutline) {
        olLine.set(floatAttr(g.attributes.olLine as THREE.BufferAttribute).subarray(0, n * 3), vo * 3);
        olBase.set(floatAttr(g.attributes.olBase as THREE.BufferAttribute).subarray(0, n * 3), vo * 3);
      } else {
        for (let i = 0; i < n; i++) {
          it.color.toArray(olLine, (vo + i) * 3);
          it.base!.toArray(olBase, (vo + i) * 3);
        }
      }
    }
    const gi = g.index;
    const c = gi ? gi.count : n;
    for (let i = 0; i < c; i += 3) {
      const a = (gi ? gi.getX(i) : i) + vo;
      const b = (gi ? gi.getX(i + 1) : i + 1) + vo;
      const d = (gi ? gi.getX(i + 2) : i + 2) + vo;
      index[io + i] = a;
      index[io + i + 1] = flip ? d : b;
      index[io + i + 2] = flip ? b : d;
    }
    io += c;
    vo += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uvs) out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (olLine && olBase) {
    out.setAttribute('olLine', new THREE.BufferAttribute(olLine, 3));
    out.setAttribute('olBase', new THREE.BufferAttribute(olBase, 3));
  }
  if (olThick) out.setAttribute('olThick', new THREE.BufferAttribute(olThick, 1));
  out.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  out.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4, true));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}
