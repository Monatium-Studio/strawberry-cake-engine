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
