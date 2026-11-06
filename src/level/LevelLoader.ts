import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import type { Engine } from '../core/Engine';
import { RAPIER, type Physics } from '../physics/Physics';
import type { RaycastClass } from '../physics/RaycastGeometry';
import { bakeStatic, clearBakeCaches } from '../render/bake';
import { markDynamic } from '../render/staticMatrices';
import { buildLevelVisual, proxyLevelColliders } from './visual';
import { Door, Level, TriggerVolume, readEnv, toMarker, type CamKey } from './Level';
import { loadModelSliced, loadSlicer, type Slicer } from './loading';
import { bool, classify, num, railKey, str, vec3 } from './props';
import { onSessionEnd } from '../core/session';

// 판이 끝나면 굽기 캐시를 비운다 (열쇠가 이번 판 템플릿의 uuid라 다음 판에는 쓰이지 않고 합친 형상만 붙잡는다)
onSessionEnd(clearBakeCaches);

/**
 * 레벨 glb 로더. 노드 이름 규칙은 docs/LEVELS.md.
 *   (일반 메시)  정적 트라이메시 충돌체. collider=0이면 장식. 확장: collider="box"면 경계 상자 충돌체(그레이박스용)
 *   COL_         렌더하지 않고 충돌체만
 *   SPAWN_, NPC_, WP_, MARK_, PROP_  빈 오브젝트 마커 (-Y 정면 = three.js 로컬 +Z)
 *   TRIG_        트리거 볼륨 (메시 경계 상자, 회전·축척 반영). 렌더하지 않는다
 *   DOOR_        키네마틱 문. move="x,y,z"(three.js 기준)만큼 열린다
 *   CAM_<shot>_<nn>, LOOK_<shot>_<nn>  카메라 레일 (t, fov)
 *   루트 속성    sky, fog, sun, ambient, music (+ 확장 near, far)
 *   확장         LIGHT_<id>(켜고 끄는 등, 조명 또는 발광 메시), FX_<id>(연출 지점 마커), hidden=1(처음에 숨김),
 *                camNear/camFar(= near/far)
 *   확장         drift="x,y,z"(m/s): 그 노드를 천천히 움직인다 (배경). spin="x,y,z"(도/s): 돌린다.
 *                glb 애니메이션은 전부 반복 재생
 *   보이는 형상  보이는 메시가 보이는 형상 레이를 막는다 (collider=0 장식 포함, UNLIT·반투명·데칼 제외, 유리·잎은 pass).
 *                충돌체는 이동 전용 (level/visual.ts)
 * glb가 없으면 fallback()이 만든 그레이박스를 같은 규칙으로 읽는다.
 */

/** ?coltrimesh=1: COL_을 예전처럼 속 빈 트라이메시로 (전후 비교용) */
const COL_TRIMESH = typeof location !== 'undefined' && new URLSearchParams(location.search).get('coltrimesh') === '1';

export interface LevelContext {
  engine: Engine;
  physics: Physics;
  assets: Assets;
}

export interface LevelOptions {
  id: string;
  /** 모델 기준 경로(Assets.baseUrl) 아래 (예: levels/yard.glb) */
  path: string;
  /** glb가 없을 때 쓸 그레이박스 (같은 노드 규칙) */
  fallback?: () => THREE.Object3D;
  /** false면 충돌체를 만들지 않는다 (보기만 하는 장면) */
  physics?: boolean;
  /** 보이는 형상 분류 (없으면 level/visual.ts 기본 규칙). false면 보이는 형상을 만들지 않는다 */
  visual?: ((m: THREE.Mesh, stop: THREE.Object3D | null) => RaycastClass | null) | false;
  onProgress?: (f: number) => void;
  slicer?: Slicer;
}

export async function loadLevel(ctx: LevelContext, opts: LevelOptions): Promise<Level> {
  const slicer = opts.slicer ?? loadSlicer;
  let root: THREE.Object3D | null = null;
  let animations: THREE.AnimationClip[] = [];
  let sceneExtras: Record<string, unknown> | undefined;
  let source = opts.path;
  try {
    const url = `${ctx.assets.baseUrl}${opts.path}`;
    const res = await fetch(url, { method: 'HEAD' });
    const type = res.headers.get('content-type') ?? '';
    // 개발 서버는 없는 파일에 index.html을 돌려준다
    if (res.ok && !type.includes('text/html')) {
      const m = await loadModelSliced(url, slicer);
      root = m.root;
      animations = m.animations;
      sceneExtras = m.gltf.scene.userData;
    }
  } catch (e) {
    console.warn(`[level] ${opts.path} 읽기 실패`, e);
  }
  let placeholder = false;
  if (!root) {
    if (!opts.fallback) throw new Error(`level ${opts.path} 없음`);
    console.info(`[level] ${opts.path} 없음 → 그레이박스 (${opts.id})`);
    root = opts.fallback();
    sceneExtras = root.userData;
    source = `greybox:${opts.id}`;
    placeholder = true;
  }
  opts.onProgress?.(0.3);
  await slicer.tick();
  const level = await buildLevel(ctx, root, { ...opts, slicer }, sceneExtras);
  level.placeholder = placeholder;
  (level as { source: string }).source = source;
  if (animations.length) {
    level.mixer = new THREE.AnimationMixer(root);
    for (const clip of animations) {
      level.mixer.clipAction(clip).play();
      // 애니메이션이 움직이는 노드는 얼리지 않는다 (Level.freezeStatic)
      for (const t of clip.tracks) {
        const name = THREE.PropertyBinding.parseTrackName(t.name).nodeName;
        const o = name ? root.getObjectByName(name) : undefined;
        if (o) markDynamic(o);
      }
    }
  }
  opts.onProgress?.(1);
  return level;
}

/** 이미 있는 오브젝트 트리를 레벨 규칙으로 읽는다 */
export async function buildLevel(
  ctx: LevelContext,
  root: THREE.Object3D,
  opts: LevelOptions,
  sceneExtras?: Record<string, unknown>,
): Promise<Level> {
  const slicer = opts.slicer ?? loadSlicer;
  const usePhysics = opts.physics !== false;
  root.updateMatrixWorld(true);

  // 루트 속성: 씬 extras → 루트 → 최상위 자식 순으로 찾는다
  const env = readEnv(sceneExtras, root.userData, ...root.children.map((c) => c.userData));
  const level = new Level(opts.id, root, env, opts.path);

  const camNodes: { shot: string; index: number; object: THREE.Object3D }[] = [];
  const lookNodes = new Map<string, THREE.Vector3>();
  const solid: THREE.Mesh[] = [];
  const boxes: THREE.Mesh[] = [];
  const colMeshes = new Set<THREE.Mesh>();

  // 위에서 아래로: 접두사 노드의 자식은 그 노드에 속한다
  const visit = (o: THREE.Object3D, owner: string | null, noCollide: boolean) => {
    if (o.name) level.nodes.set(o.name, o);
    // hidden=1 또는 on=0(LIGHT_ 제외): 처음에는 숨긴다 (연출이 켠다. 예: state 노드의 'damaged' 모습)
    const cls0 = classify(o.name);
    if (bool(o, 'hidden', false) || (cls0?.kind !== 'LIGHT' && o.userData.on !== undefined && !bool(o, 'on', true))) o.visible = false;
    if (o.userData.state !== undefined && cls0?.kind !== 'FX') level.stateNodes.push(o);
    const c = classify(o.name);
    let nextOwner = owner;
    let nc = noCollide || o.userData.collider === 0 || o.userData.collider === false || o.userData.collider === '0';
    if (c && !owner) {
      switch (c.kind) {
        case 'COL': {
          o.visible = false;
          o.traverse((x) => {
            if ((x as THREE.Mesh).isMesh && !x.userData.isOutline) {
              solid.push(x as THREE.Mesh);
              colMeshes.add(x as THREE.Mesh);
            }
          });
          return;
        }
        case 'TRIG': {
          o.visible = false;
          const box = localBounds(o);
          level.triggers.set(c.id, new TriggerVolume(c.id, o, box, o.matrixWorld, { ...o.userData }));
          return;
        }
        case 'DOOR': {
          const move = vec3(o, 'move') ?? new THREE.Vector3(0, 2, 0);
          let body: RAPIER.RigidBody | null = null;
          if (usePhysics) {
            body = ctx.physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
            // 붙기 전에는 꺼 둔다 (아래 '새로 만든 충돌체'): 배경에서 읽는 동안 지금 레벨에 보이지 않는 문이 서지 않게
            body.setEnabled(false);
            o.traverse((x) => {
              const m = x as THREE.Mesh;
              if (!m.isMesh || m.userData.isOutline) return;
              const { verts, indices } = worldTrimesh(m);
              ctx.physics.world.createCollider(RAPIER.ColliderDesc.trimesh(verts, indices), body!);
            });
          }
          level.doors.set(c.id, new Door(c.id, o, body, move));
          return;
        }
        case 'CAM': {
          const k = railKey(c.id);
          if (k) camNodes.push({ ...k, object: o });
          return;
        }
        case 'LOOK': {
          const k = railKey(c.id);
          if (k) lookNodes.set(`${k.shot}#${k.index}`, o.getWorldPosition(new THREE.Vector3()));
          return;
        }
        case 'SPAWN':
          level.spawns.set(c.id, toMarker(o, c.id));
          nextOwner = c.kind;
          break;
        case 'NPC':
          level.npcs.push(toMarker(o, c.id));
          nextOwner = c.kind;
          break;
        case 'WP':
          level.waypoints.set(c.id, toMarker(o, c.id));
          nextOwner = c.kind;
          break;
        case 'MARK':
          level.marks.set(c.id, toMarker(o, c.id));
          nextOwner = c.kind;
          break;
        case 'PROP':
          level.props.push(toMarker(o, c.id));
          nextOwner = c.kind;
          break;
        case 'LIGHT':
          level.lights.set(c.id, o);
          break;
        case 'FX':
          level.fx.push(toMarker(o, c.id));
          nextOwner = c.kind;
          break;
      }
    }
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !mesh.userData.isOutline && !nextOwner && !nc) {
      (str(mesh, 'collider') === 'box' ? boxes : solid).push(mesh);
    }
    const drift = vec3(o, 'drift');
    if (drift) level.drifters.push({ object: o, velocity: drift });
    const spin = vec3(o, 'spin');
    if (spin) level.spinners.push({ object: o, rate: spin });
    // 마커 아래 메시(미리보기용)는 충돌하지 않는다
    if (nextOwner && nextOwner !== owner) nc = true;
    for (const ch of [...o.children]) visit(ch, nextOwner === 'COL' ? 'COL' : null, nc);
  };
  visit(root, null, false);

  // 카메라 레일
  const byShot = new Map<string, typeof camNodes>();
  for (const n of camNodes) {
    if (!byShot.has(n.shot)) byShot.set(n.shot, []);
    byShot.get(n.shot)!.push(n);
  }
  for (const [shot, nodes] of byShot) {
    nodes.sort((a, b) => a.index - b.index);
    const keys: CamKey[] = nodes.map((n, i) => {
      const o = n.object;
      o.updateWorldMatrix(true, false);
      const q = o.getWorldQuaternion(new THREE.Quaternion());
      const cam = o as THREE.PerspectiveCamera;
      let fov: number | null = null;
      if (cam.isPerspectiveCamera) fov = cam.fov;
      else {
        // 빈 오브젝트의 -Y(Blender) = 로컬 +Z가 시선 → 카메라(-Z 시선)로 돌린다
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
        // Blender 카메라 오브젝트는 glTF에서 자식 카메라 노드로 나온다
        const child = o.children.find((x) => (x as THREE.PerspectiveCamera).isPerspectiveCamera) as THREE.PerspectiveCamera | undefined;
        if (child) {
          q.copy(child.getWorldQuaternion(new THREE.Quaternion()));
          fov = child.fov;
        }
      }
      const fp = num(o, 'fov', NaN);
      if (Number.isFinite(fp)) fov = fp;
      return {
        index: n.index,
        position: o.getWorldPosition(new THREE.Vector3()),
        quaternion: q,
        t: num(o, 't', i * 2),
        fov,
        look: lookNodes.get(`${shot}#${n.index}`)?.clone() ?? null,
        props: { ...o.userData },
      };
    });
    level.rails.set(shot, { shot, keys });
  }

  // 충돌체: 프레임 예산 안에서 나눠 만든다
  if (usePhysics) {
    let i = 0;
    const total = solid.length + boxes.length;
    for (const m of solid) {
      const { verts, indices } = worldTrimesh(m);
      if (indices.length >= 3) {
        // COL_은 덩어리마다 속이 찬 형상(상자 → 회전 상자, 볼록 → 볼록 껍질)으로. 속 빈 트라이메시는 캡슐이 면 너머로
        // 반쯤 들어가면 안쪽에 갇힌다
        const descs = colMeshes.has(m) && !COL_TRIMESH ? solidColliders(m, verts, indices) : [RAPIER.ColliderDesc.trimesh(verts, indices)];
        for (const d of descs) {
          const col = born(ctx.physics.world.createCollider(d));
          level.colliders.push(col);
          level.colliderSource.set(col.handle, { node: m, kind: colMeshes.has(m) ? 'col' : 'mesh' });
        }
      }
      if (++i % 4 === 0) opts.onProgress?.(0.3 + 0.5 * (i / total));
      await slicer.tick();
    }
    for (const m of boxes) {
      const col = boxCollider(ctx.physics, m);
      if (col) {
        born(col);
        level.colliders.push(col);
        level.colliderSource.set(col.handle, { node: m, kind: 'box' });
      }
      const surface = str(m, 'surface');
      if (col && surface) ctx.physics.setOwner(col, { surface });
      if (++i % 16 === 0) await slicer.tick();
    }
  }

  // 소품
  for (const mk of level.props) {
    const mp = str(mk.object, 'model');
    if (!mp) continue;
    const inst = await ctx.assets.instance(mp);
    if (!inst) continue;
    mk.object.add(inst.root);
    if (usePhysics && bool(mk.object, 'collider', true)) {
      mk.object.updateMatrixWorld(true);
      inst.root.traverse((x) => {
        const m = x as THREE.Mesh;
        if (!m.isMesh || m.userData.isOutline) return;
        const { verts, indices } = worldTrimesh(m);
        if (indices.length < 3) return;
        const col = born(ctx.physics.world.createCollider(RAPIER.ColliderDesc.trimesh(verts, indices)));
        level.colliders.push(col);
        level.colliderSource.set(col.handle, { node: m, kind: 'prop' });
      });
    }
    await slicer.tick();
  }

  // bake=1 묶음 (움직이지 않고 머티리얼 색만 다른 배경 메시가 많은 묶음: 원경 숲·건물 무리 등). 색을 정점 색으로 옮겨
  // 묶음마다 메시 하나 + 외곽선 하나로 합친다 (render/bake.ts). 코드가 이름으로 찾는 노드가 없는 묶음에만 켠다
  const bakeZones: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o !== root && bool(o, 'bake', false)) bakeZones.push(o);
  });
  for (const z of bakeZones) bakeStatic(z);

  // 보이는 형상: 보이는 메시(collider=0 장식·소품 포함)를 시야·클릭·땅 높이 질의가 본다. 위 충돌체는 이동 전용이 된다 (level/visual.ts)
  if (usePhysics && opts.visual !== false) {
    const set = await buildLevelVisual(opts.id, root, { skyNode: env.skyNode, tick: () => slicer.tick(), classify: opts.visual || undefined });
    if (proxyLevelColliders(ctx.physics, set, level.colliders)) level.visual = { set, registry: ctx.physics.visual };
    await slicer.tick();
  }

  // 경계 (카메라 원평면 계산용)
  const box = new THREE.Box3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !m.userData.isOutline && m.visible && !(o as THREE.Points).isPoints) box.expandByObject(m, false);
  });
  if (!box.isEmpty()) box.getBoundingSphere(level.bounds);

  // 새로 만든 충돌체는 장면이 붙을 때 켠다 (만들 때부터 꺼 두었다: born. 여기서는 빠진 것까지 한 번 더)
  for (const c of level.colliders) c.setEnabled(false);
  for (const d of level.doors.values()) d.setLive(false);
  return level;
}

/**
 * 레벨 충돌체는 만든 그 순간 끈다 (붙을 때 Level.attach가 켠다). 읽기는 프레임을 나눠(slicer) 몇 초 걸리고, 배경에서 다음 레벨을
 * 읽는 동안 켜진 충돌체가 있으면 지금 레벨에 보이지 않는 벽으로 선다
 */
function born(c: RAPIER.Collider): RAPIER.Collider {
  c.setEnabled(false);
  return c;
}

/** 오브젝트 로컬 공간에서 자기 메시들의 경계 상자 (아웃라인 헐 제외) */
function localBounds(o: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  o.updateWorldMatrix(true, true);
  const inv = o.matrixWorld.clone().invert();
  const tmp = new THREE.Box3();
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh || m.userData.isOutline) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    tmp.copy(m.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    box.union(tmp);
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  return box;
}

function worldTrimesh(mesh: THREE.Mesh): { verts: Float32Array; indices: Uint32Array } {
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const verts = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    verts[i * 3] = v.x;
    verts[i * 3 + 1] = v.y;
    verts[i * 3 + 2] = v.z;
  }
  const indices = g.index ? new Uint32Array(g.index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
  return { verts, indices };
}

/**
 * 충돌 전용 메시(COL_) → 속이 찬 충돌체들. 붙어 있는 덩어리마다: 메시 로컬 축에 맞는 상자(꼭짓점 8개가 경계 상자 모서리)면
 * 회전 상자, 볼록하면 볼록 껍질, 아니면 그 덩어리만 트라이메시. verts·indices는 월드 좌표 (worldTrimesh)
 */
function solidColliders(mesh: THREE.Mesh, verts: Float32Array, indices: Uint32Array): RAPIER.ColliderDesc[] {
  const n = verts.length / 3;
  // 같은 자리 꼭짓점 묶기 (면마다 나뉜 법선 때문에 상자도 꼭짓점이 24개)
  const weld = new Int32Array(n);
  const key = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(verts[i * 3] * 1e4)},${Math.round(verts[i * 3 + 1] * 1e4)},${Math.round(verts[i * 3 + 2] * 1e4)}`;
    let w = key.get(k);
    if (w === undefined) key.set(k, (w = i));
    weld[i] = w;
  }
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(weld[indices[t]]);
    for (let k = 1; k < 3; k++) {
      const b = find(weld[indices[t + k]]);
      if (a !== b) parent[b] = a;
    }
  }
  const comps = new Map<number, number[]>();
  for (let t = 0; t < indices.length; t += 3) {
    const r = find(weld[indices[t]]);
    let l = comps.get(r);
    if (!l) comps.set(r, (l = []));
    l.push(t);
  }
  mesh.updateWorldMatrix(true, false);
  const inv = mesh.matrixWorld.clone().invert();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  mesh.matrixWorld.decompose(pos, quat, scl);
  const out: RAPIER.ColliderDesc[] = [];
  const v = new THREE.Vector3();
  for (const tris of comps.values()) {
    const ids = [...new Set(tris.flatMap((t) => [weld[indices[t]], weld[indices[t + 1]], weld[indices[t + 2]]]))];
    // 상자: 메시 로컬 좌표에서 꼭짓점 8개가 모두 경계 상자 모서리
    const local = ids.map((i) => v.set(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]).applyMatrix4(inv).clone());
    const lb = new THREE.Box3().setFromPoints(local);
    const ls = lb.getSize(new THREE.Vector3());
    const eps = 1e-3;
    const corner = (p: THREE.Vector3) =>
      (Math.abs(p.x - lb.min.x) < eps || Math.abs(p.x - lb.max.x) < eps) &&
      (Math.abs(p.y - lb.min.y) < eps || Math.abs(p.y - lb.max.y) < eps) &&
      (Math.abs(p.z - lb.min.z) < eps || Math.abs(p.z - lb.max.z) < eps);
    if (ids.length === 8 && ls.x > eps && ls.y > eps && ls.z > eps && local.every(corner)) {
      const half = ls.multiply(scl).multiplyScalar(0.5);
      const c = lb.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
      out.push(RAPIER.ColliderDesc.cuboid(Math.abs(half.x), Math.abs(half.y), Math.abs(half.z)).setTranslation(c.x, c.y, c.z).setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }));
      continue;
    }
    // 볼록: 모든 꼭짓점이 모든 면 평면의 한쪽에 있다
    const pts = new Float32Array(ids.length * 3);
    ids.forEach((i, k) => pts.set([verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]], k * 3));
    if (ids.length <= 256 && isConvex(verts, indices, tris, ids)) {
      const d = RAPIER.ColliderDesc.convexHull(pts);
      if (d) {
        out.push(d);
        continue;
      }
    }
    const idx = new Uint32Array(tris.length * 3);
    tris.forEach((t, k) => idx.set([indices[t], indices[t + 1], indices[t + 2]], k * 3));
    out.push(RAPIER.ColliderDesc.trimesh(verts, idx));
  }
  return out;
}

function isConvex(verts: Float32Array, indices: Uint32Array, tris: number[], ids: number[]): boolean {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (const t of tris) {
    a.fromArray(verts, indices[t] * 3);
    b.fromArray(verts, indices[t + 1] * 3);
    c.fromArray(verts, indices[t + 2] * 3);
    nrm.subVectors(b, a).cross(p.subVectors(c, a));
    const l = nrm.length();
    if (l < 1e-9) continue;
    nrm.divideScalar(l);
    let pos = false;
    let neg = false;
    for (const i of ids) {
      const d = p.fromArray(verts, i * 3).sub(a).dot(nrm);
      if (d > 2e-3) pos = true;
      else if (d < -2e-3) neg = true;
      if (pos && neg) return false;
    }
  }
  return true;
}

/** 메시 로컬 경계 상자 → 회전된 정적 박스 */
function boxCollider(physics: Physics, mesh: THREE.Mesh): RAPIER.Collider | null {
  mesh.updateWorldMatrix(true, false);
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const b = mesh.geometry.boundingBox!;
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  mesh.matrixWorld.decompose(pos, quat, scl);
  const size = b.getSize(new THREE.Vector3()).multiply(scl).multiplyScalar(0.5);
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) return null;
  const center = b.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
  return physics.addStaticBox(center, new THREE.Vector3(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)), quat);
}
