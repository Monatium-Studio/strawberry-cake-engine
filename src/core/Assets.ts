import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadModel, type LoadedModel } from '../render/loader';

/**
 * glb 에셋 캐시. 같은 경로는 한 번만 읽고, instance()로 복제본을 만든다(스키닝 포함).
 * 파일이 아직 없으면(에셋 제작 중) null을 돌려준다. 호출 쪽에서 대체 모델을 쓴다.
 */
export class Assets {
  private readonly cache = new Map<string, Promise<LoadedModel | null>>();
  /** 모델을 읽을 기준 주소 (끝에 / ) */
  constructor(readonly baseUrl = '/models/') {}
  /** 걷었다 (dispose): 이후의 읽기는 끝나지 않는다 */
  protected disposed = false;

  /** path: 모델 기준 경로(baseUrl, 기본 /models/) 아래 (예: "props/crate.glb") */
  load(path: string): Promise<LoadedModel | null> {
    if (this.disposed) return new Promise(() => {});
    let p = this.cache.get(path);
    if (!p) {
      p = loadModel(`${this.baseUrl}${path}`).catch((e) => {
        console.warn(`[assets] ${path} 없음 또는 읽기 실패, 대체 모델 사용`, e?.message ?? e);
        return null;
      });
      this.cache.set(path, p);
    }
    return this.gate(p);
  }

  /** 걷은 뒤에 끝난 읽기는 결과를 넘기지 않는다 (버린 화면의 로딩이 이어지지 않게) */
  protected gate<T>(p: Promise<T>): Promise<T> {
    return p.then((v) => (this.disposed ? new Promise<T>(() => {}) : v));
  }

  /**
   * 캐시를 버린다 (같은 페이지에서 화면을 바꿀 때: 화면마다 Assets를 새로 만든다). GPU 자원은 엔진의 정리(gpuSweep)가 놓는다.
   * 이후의 읽기와 아직 끝나지 않은 읽기는 끝나지 않는다
   */
  dispose(): void {
    this.disposed = true;
    this.cache.clear();
  }

  async instance(path: string): Promise<{ root: THREE.Object3D; animations: THREE.AnimationClip[] } | null> {
    const tpl = await this.load(path);
    if (!tpl) return null;
    const root = skeletonClone(tpl.root);
    shareSkeletons(root);
    return { root, animations: tpl.animations };
  }
}

/**
 * 같은 뼈를 쓰는 스킨 메시들이 Skeleton 하나를 같이 쓰게 한다. 바꾼 메시 수를 돌려준다.
 * GLTFLoader와 SkeletonUtils.clone은 스킨 메시(외곽선 헐 포함)마다 Skeleton을 따로 만든다. three는 Skeleton마다 프레임당
 * 뼈 행렬을 다시 계산하고 뼈 텍스처를 올리므로, 캐릭터 하나(팔·몸·머리·머리카락 + 외곽선, 7~10개)가 그만큼 되풀이했다.
 * 뼈 배열이 같고 역바인드 행렬이 같을 때만 묶는다 (메시마다 bindMatrix는 그대로라 모양은 같다). docs/ENGINE.md 성능 규칙
 */
export function shareSkeletons(root: THREE.Object3D): number {
  const kept: THREE.Skeleton[] = [];
  let merged = 0;
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const sk = mesh.skeleton;
    if (kept.includes(sk)) return;
    const same = kept.find((k) => sameSkeleton(k, sk));
    if (same) {
      mesh.skeleton = same;
      merged++;
    } else kept.push(sk);
  });
  return merged;
}

function sameSkeleton(a: THREE.Skeleton, b: THREE.Skeleton): boolean {
  if (a.bones.length !== b.bones.length || a.boneInverses.length !== b.boneInverses.length) return false;
  for (let i = 0; i < a.bones.length; i++) if (a.bones[i] !== b.bones[i]) return false;
  for (let i = 0; i < a.boneInverses.length; i++) if (!a.boneInverses[i].equals(b.boneInverses[i])) return false;
  return true;
}

/** 이름(또는 userData 키)으로 노드를 찾는다 */
export function findNode(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  return root.getObjectByName(name) ?? undefined;
}

/** 조상까지 거슬러 올라가며 userData 값 찾기 */
export function inheritedUserData(obj: THREE.Object3D, key: string): unknown {
  let o: THREE.Object3D | null = obj;
  while (o) {
    if (o.userData && key in o.userData) return o.userData[key];
    o = o.parent;
  }
  return undefined;
}

/** "x,y,z" 문자열 커스텀 속성을 Vector3로 */
export function vec3Prop(root: THREE.Object3D, key: string, fallback: THREE.Vector3): THREE.Vector3 {
  let found: string | undefined;
  root.traverse((o) => {
    if (!found && typeof o.userData[key] === 'string') found = o.userData[key];
  });
  if (!found) return fallback.clone();
  const [x, y, z] = found.split(',').map(Number);
  return new THREE.Vector3(x, y, z);
}
