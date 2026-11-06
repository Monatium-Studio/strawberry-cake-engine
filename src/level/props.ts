import * as THREE from 'three';

/**
 * 레벨 노드 커스텀 속성(glTF extras → userData) 읽기 도우미.
 * Blender 커스텀 속성은 숫자·문자열로 들어온다. "x,y,z" 같은 목록은 문자열이다.
 */

export function str(o: THREE.Object3D | Record<string, unknown>, key: string): string | undefined {
  const ud = (o as THREE.Object3D).isObject3D ? (o as THREE.Object3D).userData : (o as Record<string, unknown>);
  const v = ud?.[key];
  if (v === undefined || v === null) return undefined;
  return String(v);
}

export function num(o: THREE.Object3D | Record<string, unknown>, key: string, fallback: number): number {
  const s = str(o, key);
  if (s === undefined || s === '') return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

/** 0, "0", false, "false", "no", "off"이면 false */
export function bool(o: THREE.Object3D | Record<string, unknown>, key: string, fallback: boolean): boolean {
  const s = str(o, key);
  if (s === undefined) return fallback;
  return !['0', 'false', 'no', 'off', ''].includes(s.trim().toLowerCase());
}

/** "x,y,z" → Vector3. 없거나 잘못되면 null */
export function vec3(o: THREE.Object3D | Record<string, unknown>, key: string): THREE.Vector3 | null {
  const s = str(o, key);
  if (!s) return null;
  const p = s.split(/[,\s]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return null;
  return new THREE.Vector3(p[0], p[1], p[2]);
}

/** "a,b" → [a, b] */
export function pair(o: THREE.Object3D | Record<string, unknown>, key: string): [number, number] | null {
  const s = str(o, key);
  if (!s) return null;
  const p = s.split(/[,\s]+/).filter(Boolean).map(Number);
  if (p.length < 2 || p.some((n) => !Number.isFinite(n))) return null;
  return [p[0], p[1]];
}

/** "#rrggbb", "rrggbb", "0xrrggbb", 숫자 → Color */
export function color(o: THREE.Object3D | Record<string, unknown>, key: string): THREE.Color | null {
  const s = str(o, key);
  if (!s) return null;
  const t = s.trim().replace(/^0x/i, '#');
  try {
    if (/^#?[0-9a-f]{6}$/i.test(t)) return new THREE.Color(t.startsWith('#') ? t : `#${t}`);
    if (/^\d+$/.test(t)) return new THREE.Color(Number(t));
    return new THREE.Color(t);
  } catch {
    return null;
  }
}

/**
 * 이름 접두사로 노드 종류와 id를 나눈다.
 * GLTFLoader는 같은 이름에 `_1` 같은 접미사를 붙일 수 있다. 점(.)은 노드 이름 규칙에서 금지다.
 */
export const PREFIXES = ['COL', 'SPAWN', 'TRIG', 'NPC', 'WP', 'MARK', 'PROP', 'DOOR', 'CAM', 'LOOK', 'LIGHT', 'FX'] as const;
export type NodeKind = (typeof PREFIXES)[number];

export function classify(name: string): { kind: NodeKind; id: string } | null {
  const m = /^([A-Z]+)_(.+)$/.exec(name);
  if (!m) return null;
  const kind = m[1] as NodeKind;
  if (!PREFIXES.includes(kind)) return null;
  return { kind, id: m[2] };
}

/** CAM_<shot>_<nn>, LOOK_<shot>_<nn> → { shot, index } */
export function railKey(id: string): { shot: string; index: number } | null {
  const m = /^(.+?)_(\d+)$/.exec(id);
  if (!m) return null;
  return { shot: m[1], index: Number(m[2]) };
}

/** 빈 오브젝트의 정면: Blender -Y = three.js 로컬 +Z (glTF 내보내기 축 변환) */
export function forwardOf(o: THREE.Object3D, out = new THREE.Vector3()): THREE.Vector3 {
  o.updateWorldMatrix(true, false);
  const q = o.getWorldQuaternion(new THREE.Quaternion());
  return out.set(0, 0, 1).applyQuaternion(q).normalize();
}

/** 정면 벡터를 카메라식 yaw로 (yaw=0이면 -Z를 본다) */
export function yawOf(forward: THREE.Vector3): number {
  return Math.atan2(-forward.x, -forward.z);
}

/** 카메라식 yaw를 정면 벡터로 */
export function forwardFromYaw(yaw: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}
