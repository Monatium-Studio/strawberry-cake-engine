import * as THREE from 'three';

/**
 * 그리기 때마다 셰이더 프로그램을 다시 고르지 않게 머티리얼을 나눈다 (모델을 읽을 때 한 번, 보이는 결과는 같다).
 *
 * three는 머티리얼 하나가 '프로그램 갈래'가 다른 메시들(스키닝·모프·정점색 성분 수 등)에 같이 쓰이면
 * 그릴 때마다 갈래가 바뀐 것으로 보고 getProgram(파라미터 객체 + 캐시 키 문자열)을 다시 돈다.
 * 투명 + 양면 머티리얼은 뒷면·앞면 두 번 그리며 그때마다 needsUpdate를 올려 두 번 다시 고른다.
 * 캐릭터 수십 명이면 프레임마다 수십~수백 번이고, 만든 객체가 GC 끊김이 된다 (성능 조사).
 *
 *  1) 갈래가 둘 이상인 머티리얼은 갈래마다 복제본을 쓴다 (예: 얼굴 메시(모프, 스키닝 없음)가 몸(스키닝)의 머티리얼을 같이 씀)
 *  2) 투명 + 양면 머티리얼은 뒷면·앞면 머티리얼 두 개로 나누고 같은 삼각형 범위를 두 그룹으로 그린다.
 *     three의 두 번 그리기(뒷면 → 앞면, 한 물체 안에서 잇달아)와 순서가 같다: 투명 정렬은 같은 물체 안에서 그룹 순서를 지킨다.
 */
export function splitProgramVariants(root: THREE.Object3D): void {
  splitShared(root);
  splitDoubleSidedTransparent(root);
}

/** 머티리얼의 프로그램 갈래를 가르는 메시 쪽 조건 (WebGLRenderer.setProgram의 needsProgramChange 항목) */
function signature(mesh: THREE.Mesh): string {
  const g = mesh.geometry;
  const morph = g.morphAttributes;
  const color = g.attributes.color as THREE.BufferAttribute | undefined;
  return [
    (mesh as THREE.SkinnedMesh).isSkinnedMesh ? 1 : 0,
    (mesh as THREE.InstancedMesh).isInstancedMesh ? 1 : 0,
    morph.position?.length ?? 0,
    morph.normal ? 1 : 0,
    morph.color ? 1 : 0,
    color ? color.itemSize : 0,
    g.attributes.tangent ? 1 : 0,
  ].join('');
}

/** 머티리얼 복제 (인스턴스에 붙인 셰이더 고침까지) */
export function cloneMaterial(m: THREE.Material): THREE.Material {
  const c = m.clone();
  // clone()은 인스턴스에 붙인 셰이더 고침을 옮기지 않는다
  if (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile')) c.onBeforeCompile = m.onBeforeCompile;
  if (Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey')) c.customProgramCacheKey = m.customProgramCacheKey;
  c.userData = { ...m.userData };
  return c;
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !m.userData.isOutline) out.push(m);
  });
  return out;
}

function splitShared(root: THREE.Object3D): void {
  const meshes = meshesOf(root);
  /** 머티리얼 → 처음 본 갈래 */
  const first = new Map<THREE.Material, string>();
  /** 머티리얼 + 갈래 → 복제본 */
  const clones = new Map<string, THREE.Material>();
  for (const mesh of meshes) {
    const sig = signature(mesh);
    const swap = (m: THREE.Material): THREE.Material => {
      const f = first.get(m);
      if (f === undefined) {
        first.set(m, sig);
        return m;
      }
      if (f === sig) return m;
      const key = `${m.uuid}|${sig}`;
      let c = clones.get(key);
      if (!c) {
        c = cloneMaterial(m);
        clones.set(key, c);
      }
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  }
}

const sideCache = new WeakMap<THREE.Material, [THREE.Material, THREE.Material]>();

function sides(m: THREE.Material): [THREE.Material, THREE.Material] {
  let s = sideCache.get(m);
  if (!s) {
    const back = cloneMaterial(m);
    back.side = THREE.BackSide;
    const front = cloneMaterial(m);
    front.side = THREE.FrontSide;
    s = [back, front];
    sideCache.set(m, s);
  }
  return s;
}

const twoPass = (m: THREE.Material) => m.transparent === true && m.side === THREE.DoubleSide && m.forceSinglePass === false;

/** 등(light_*)은 게임 코드가 단일 머티리얼을 복제해 밝기를 바꿀 수 있다: 건드리지 않는다 */
function underLamp(o: THREE.Object3D): boolean {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (/^light_/.test(x.name)) return true;
  return false;
}

function splitDoubleSidedTransparent(root: THREE.Object3D): void {
  for (const mesh of meshesOf(root)) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!mats.some(twoPass) || underLamp(mesh)) continue;
    const g = mesh.geometry;
    const count = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
    const src = g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 0 }];
    const outMats = mats.slice();
    const groups: { start: number; count: number; materialIndex: number }[] = [];
    for (const gr of src) {
      const m = mats[gr.materialIndex ?? 0];
      if (!m || !twoPass(m)) {
        groups.push({ start: gr.start, count: gr.count, materialIndex: gr.materialIndex ?? 0 });
        continue;
      }
      const [back, front] = sides(m);
      let bi = outMats.indexOf(back);
      if (bi < 0) bi = outMats.push(back) - 1;
      let fi = outMats.indexOf(front);
      if (fi < 0) fi = outMats.push(front) - 1;
      groups.push({ start: gr.start, count: gr.count, materialIndex: bi }, { start: gr.start, count: gr.count, materialIndex: fi });
    }
    // 그룹은 지오메트리에 있다: 다른 메시가 같은 지오메트리를 써도 바뀌지 않게 속성을 공유하는 얕은 복사본에 단다
    const ng = new THREE.BufferGeometry();
    ng.name = g.name;
    ng.index = g.index;
    for (const [k, a] of Object.entries(g.attributes)) ng.setAttribute(k, a);
    for (const [k, list] of Object.entries(g.morphAttributes)) ng.morphAttributes[k] = list;
    ng.morphTargetsRelative = g.morphTargetsRelative;
    ng.drawRange = { ...g.drawRange };
    ng.userData = g.userData;
    ng.boundingBox = g.boundingBox;
    ng.boundingSphere = g.boundingSphere;
    for (const gr of groups) ng.addGroup(gr.start, gr.count, gr.materialIndex);
    mesh.geometry = ng;
    mesh.material = outMats;
  }
}
