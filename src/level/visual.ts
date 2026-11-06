import * as THREE from 'three';
import { StaticRaycastSet, makeRaycastRoot, type RaycastClass, type RaycastClassifier } from '../physics/RaycastGeometry';
import type { Physics, RAPIER } from '../physics/Physics';

/**
 * 레벨의 보이는 형상(레이캐스트 BVH) 규칙. 엔진 쪽 구조는 physics/RaycastGeometry.ts.
 *
 * 보이는 메시가 그대로 레이를 막는다. collider=0 장식도 막는다. COL_·collider="box"·레벨 트라이메시·소품 트라이메시는
 * 이동 전용(physics.setVisualProxy)이 되어 보이는 형상 레이가 건너뛴다.
 *   무시: 아웃라인 헐, UNLIT_ 발광(불, 조명판, 화면), 반투명(철망, 빛기둥, 아지랑이), 연기·구름·안개,
 *         데칼(이름 끝 _fine: 데칼·글자·가는 선), 마커 아래, skyNode, DOOR_(문은 자기 트라이메시)
 *   pass: 머티리얼 이름에 glass/window(유리), 또는 잎 낱말(foliage·leaf·hedge·bush·…). 땅 낱말(field·ground·floor·terrain·…)이
 *         같이 든 머티리얼은 solid
 *   직접 정하기: 노드 커스텀 속성 ray = 0(무시) | pass | 1(solid). 위 규칙보다 우선, 자식에게 상속
 * 정적 묶음: 소문자 이름 노드. 대문자 접두사 노드(STAGE_ 등)와 hidden·on·state·drift·spin을 가진 노드, PROP_ 소품은
 * 스크립트가 끄거나 옮길 수 있어 동적 뿌리(그때의 visible·matrixWorld를 본다)로 둔다.
 * 맞은 메시의 소유자 태그는 { surface } (머티리얼 이름으로 고른 표면 종류, 노드 속성 surface가 우선): 발소리·맞은 자리 연출이 쓴다.
 */

export type SurfaceKind = 'concrete' | 'metal' | 'wood' | 'dirt' | 'glass' | 'water' | 'cloth';

const GLASS = /glass|window/i;
/** 연기·구름 같은 불투명 연출 머티리얼 (UNLIT이 아니어도 레이가 지나간다) */
const EFFECT = /(^|_)(smoke|cloud|haze|fog|mist|steam|vapor|beam|halo|spill|plume|atmo|portal|vortex|rift|fire|flame)(_|$|\d)/i;
/** 잎 머티리얼 (낱말 단위). 땅 머티리얼(grass, meadow, turf)과 건초·초가는 넣지 않는다 */
export const FOLIAGE = /(^|_)(foliage|leaf|leaves|hedge|hedgerow|bush|shrub|pine|needles?|flower|petal|vine|ivy|reed|reeds|fern|moss|wheat|crop|forest|canopy_leaf|net|camo|camonet)(_|$|\d)/i;
/** 땅 낱말이 든 머티리얼은 잎 낱말이 같이 있어도 땅이다 (밀밭·꽃밭 지형 칸). 잎으로 하려면 노드 속성 ray=pass */
const GROUND = /(^|_)(field|ground|floor|terrain|lawn|meadow|turf|soil|plain)(_|$|\d)/i;

const OFF = ['0', 'false', 'no', 'off', 'none', 'skip'];

/** fine 종류(아웃라인 없음): 데칼·글자·발광·가는 선 */
const FINE = /_fine(_\d+)?$/;
/** 마커·트리거·충돌·문: 보이는 형상이 아니다 */
const MARKER = /^(COL|TRIG|SPAWN|NPC|WP|MARK|CAM|LOOK|FX|DOOR|SKY)(_|$)/;
/** 스크립트가 이름으로 찾아 끄고 켜거나 옮기는 노드 (대문자 접두사) */
const SCRIPTED = /^[A-Z][A-Z0-9]*(_|$)/;

const SURFACE: [RegExp, SurfaceKind][] = [
  [/glass|window/, 'glass'],
  [/water|puddle/, 'water'],
  [/wood|plank|timber|trunk|bark|log|crate|cardboard|paper|bench|pallet/, 'wood'],
  [/sand|soil|dirt|mud|earth|turf|grass|hedge|leaf|foliage|rubble|ash|gravel|field|crop|wheat/, 'dirt'],
  [/cloth|canvas|tarp|tent|banner|flag|seat|fabric|mattress|blanket|pillow|cushion|rug|carpet|curtain/, 'cloth'],
  [/metal|steel|iron|galv|rebar|girder|rail|barrel|pipe|tank|dish|cable|wire|gold|chrome|shell|hull|engine|tyre|tire/, 'metal'],
];

export function surfaceFromMaterial(name: string): SurfaceKind {
  const n = name.toLowerCase();
  for (const [re, s] of SURFACE) if (re.test(n)) return s;
  return 'concrete';
}

function inherited(o: THREE.Object3D, key: string, stop: THREE.Object3D | null): unknown {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) {
    if (x.userData && x.userData[key] !== undefined && x.userData[key] !== null && x.userData[key] !== '') return x.userData[key];
    if (x === stop) break;
  }
  return undefined;
}

const tags = new Map<string, { surface: string }>();
function tag(surface: string): { surface: string } {
  let t = tags.get(surface);
  if (!t) tags.set(surface, (t = { surface }));
  return t;
}

/** 메시 하나의 분류 (기본 규칙). stop: 상속 속성을 찾을 때 멈출 조상 (레벨 루트·모델 루트) */
export function classifyVisualMesh(mesh: THREE.Mesh, stop: THREE.Object3D | null = null): RaycastClass | null {
  if (mesh.userData.isOutline) return null;
  const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean) as THREE.Material[];
  const mat = mats[0];
  const name = mat?.name ?? '';
  const surf = inherited(mesh, 'surface', stop);
  const surface = typeof surf === 'string' && surf ? surf : surfaceFromMaterial(name);
  const over = inherited(mesh, 'ray', stop);
  if (over !== undefined) {
    const s = String(over).trim().toLowerCase();
    if (OFF.includes(s)) return null;
    if (s === 'pass') return { kind: 'pass', tag: tag(surface) };
    return { kind: 'solid', tag: tag(surface) };
  }
  if (!mat) return null;
  if (mats.every((m) => GLASS.test(m.name))) return { kind: 'pass', tag: tag('glass') };
  if (mats.every((m) => m.name.startsWith('UNLIT_') || (m as THREE.MeshBasicMaterial).isMeshBasicMaterial)) return null;
  if (mats.every((m) => m.transparent && m.opacity < 0.9)) return null;
  if (EFFECT.test(name)) return null;
  if (FINE.test(mesh.name) || (mesh.parent && FINE.test(mesh.parent.name))) return null;
  if (mats.every((m) => {
    const n = m.name.replace(/__vc$/, '');
    return FOLIAGE.test(n) && !GROUND.test(n);
  })) return { kind: 'pass', tag: tag(surface) };
  return { kind: 'solid', tag: tag(surface) };
}

/** 통째로 등록하는 모델(소품·움직이는 물체)의 분류 (COL_ 충돌 메시 제외) */
export function modelClassifier(root: THREE.Object3D, base: (m: THREE.Mesh, stop: THREE.Object3D | null) => RaycastClass | null = classifyVisualMesh): RaycastClassifier {
  return (mesh) => {
    for (let x: THREE.Object3D | null = mesh; x && x !== root.parent; x = x.parent) if (/^COL_/.test(x.name)) return null;
    return base(mesh, root);
  };
}

/** 이 노드부터 아래는 스크립트가 끄고 켜거나 옮길 수 있다 */
function isLive(o: THREE.Object3D): boolean {
  const u = o.userData ?? {};
  return SCRIPTED.test(o.name) || u.hidden !== undefined || u.on !== undefined || u.state !== undefined || u.drift !== undefined || u.spin !== undefined || u.dynamic !== undefined;
}

/**
 * 레벨의 보이는 형상을 만든다 (소품을 붙인 뒤에 부른다). 정적 메시는 월드 좌표로 합친 BVH, 살아 있는 노드·소품은 동적 뿌리.
 * 돌려준 묶음은 레벨이 붙을 때 physics.visual.addStatic으로 들어간다.
 */
export async function buildLevelVisual(
  id: string,
  root: THREE.Object3D,
  opts: { skyNode?: string | null; tick?: () => Promise<void>; classify?: (m: THREE.Mesh, stop: THREE.Object3D | null) => RaycastClass | null } = {},
): Promise<StaticRaycastSet> {
  const base = opts.classify ?? classifyVisualMesh;
  const set = new StaticRaycastSet(id, root);
  const items: { mesh: THREE.Mesh; cls: RaycastClass }[] = [];
  const live: THREE.Object3D[] = [];
  const visit = (o: THREE.Object3D) => {
    if (o !== root) {
      if (MARKER.test(o.name) || (opts.skyNode && o.name === opts.skyNode)) return;
      if (/^PROP_/.test(o.name) || isLive(o)) {
        live.push(o);
        return;
      }
    }
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as unknown as THREE.SkinnedMesh).isSkinnedMesh && !(m as unknown as THREE.InstancedMesh).isInstancedMesh) {
      const cls = base(m, root);
      if (cls && m.geometry?.getAttribute('position')) items.push({ mesh: m, cls });
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  await set.build(items, opts.tick);
  const classify: RaycastClassifier = (mesh) => {
    for (let x: THREE.Object3D | null = mesh; x && x !== root; x = x.parent) if (MARKER.test(x.name) && !/^PROP_/.test(x.name)) return null;
    return base(mesh, root);
  };
  for (const o of live) {
    const r = makeRaycastRoot(o, classify);
    if (r) {
      set.roots.push(r);
      set.stats.dynamicMeshes += r.items.length;
    }
  }
  return set;
}

/** 레벨 형상이 대신하는 이동 충돌체를 보이는 형상 레이에서 뺀다. 형상이 비었으면 그대로 둔다(false) */
export function proxyLevelColliders(physics: Physics, set: StaticRaycastSet, colliders: RAPIER.Collider[]): boolean {
  if (!set.stats.tris && !set.stats.passTris && !set.roots.length) return false;
  for (const c of colliders) physics.setVisualProxy(c);
  return true;
}

/**
 * 모델 하나(움직이는 물체 등)를 보이는 형상 뿌리로 등록한다. proxies: 이 모델의 이동 충돌체(보이는 형상 레이에서 뺀다).
 * 보이는 메시가 없으면 등록하지 않고 충돌체를 그대로 둔다. 돌려준 함수로 해제한다
 */
export function registerVisualModel(
  physics: Physics,
  root: THREE.Object3D,
  opts: { owner?: unknown; collider?: RAPIER.Collider | null; proxies?: RAPIER.Collider[]; classify?: RaycastClassifier } = {},
): (() => void) | null {
  const r = makeRaycastRoot(root, opts.classify ?? modelClassifier(root), { owner: opts.owner, collider: opts.collider ?? null });
  if (!r) return null;
  physics.visual.addRoot(r);
  for (const c of opts.proxies ?? []) physics.setVisualProxy(c);
  return () => {
    physics.visual.removeRoot(root);
    for (const c of opts.proxies ?? []) physics.setVisualProxy(c, false);
  };
}
