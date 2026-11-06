import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyDepthBias, applyOutlines, toToon } from './toon';
import { splitProgramVariants } from './variants';

const gltfLoader = new GLTFLoader();

export interface LoadedModel {
  root: THREE.Object3D;
  gltf: GLTF;
  animations: THREE.AnimationClip[];
}

/** .glb를 읽어 툰 머티리얼로 바꾸고 아웃라인을 붙인다. 게임과 뷰어가 같은 경로를 쓴다. */
export async function loadModel(url: string, opts: { outlines?: boolean } = {}): Promise<LoadedModel> {
  const gltf = await gltfLoader.loadAsync(url);
  const root = gltf.scene;
  // COL_ 노드는 충돌 전용이라 그리지 않는다 (외곽선도 없음). 레벨은 LevelLoader가, 소품 물리는 메시 자리를 그대로 읽는다
  hideColliders(root);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toToon) : toToon(mesh.material);
    applyDepthBias(mesh);
  });
  // 레벨 glb는 먼 외곽선이 자글거리지 않게 level 모드 (가늘어지면 스며 사라짐)
  const level = /\/levels\//.test(url);
  if (opts.outlines !== false) applyOutlines(root, undefined, { mode: level ? 'level' : 'crisp' });
  // 프로그램 갈래 나누기 (variants.ts). 레벨은 연출 코드가 머티리얼을 직접 만지는 곳이 많아 그대로 둔다
  if (!level) splitProgramVariants(root);
  return { root, gltf, animations: gltf.animations };
}

/** 이름이 COL_로 시작하는 노드(충돌 전용)를 숨기고 외곽선을 막는다. 숨긴 수를 돌려준다 */
export function hideColliders(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (!/^COL_/.test(o.name)) return;
    o.visible = false;
    o.userData.noOutline = 1;
    n++;
  });
  return n;
}

export interface ModelStats {
  triangles: number;
  meshes: number;
  materials: number;
  size: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  bones: number;
  animations: string[];
  nodes: string[];
}

/** 아웃라인 헐은 빼고 센 통계 */
export function modelStats(root: THREE.Object3D, animations: THREE.AnimationClip[] = []): ModelStats {
  let triangles = 0;
  let meshes = 0;
  let bones = 0;
  const materials = new Set<string>();
  const nodes: string[] = [];
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.userData.isOutline) return;
    // 충돌 전용 메시(hideColliders)는 그리지 않으므로 세지 않는다
    for (let p: THREE.Object3D | null = o; p && p !== root.parent; p = p.parent) if (/^COL_/.test(p.name)) return;
    if ((o as THREE.Bone).isBone) bones++;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      meshes++;
      const g = mesh.geometry;
      triangles += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => materials.add(m.uuid));
      box.expandByObject(mesh, true);
    } else if (o !== root && o.name) {
      nodes.push(o.name);
    }
  });
  const size = box.getSize(new THREE.Vector3());
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return {
    triangles: Math.round(triangles),
    meshes,
    materials: materials.size,
    size: [r(size.x), r(size.y), r(size.z)],
    min: [r(box.min.x), r(box.min.y), r(box.min.z)],
    max: [r(box.max.x), r(box.max.y), r(box.max.z)],
    bones,
    animations: animations.map((a) => a.name),
    nodes,
  };
}
