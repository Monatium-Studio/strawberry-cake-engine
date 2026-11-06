import * as THREE from 'three';
import type { Level } from './Level';
import { bool, color, num, str } from './props';

/**
 * 레벨의 LIGHT_<id> 노드를 묶음(group 속성, 없으면 id 앞부분)으로 켜고 끈다.
 * 노드 커스텀 속성 (docs/LEVELS.md)
 *   emissiveToggle=1  메시의 발광(언릿이면 색)을 켜고 끈다
 *   on=0|1            처음 상태
 *   blink=<초>        켜져 있는 동안 깜빡임 주기 (docs/LEVELS.md)
 *   color="#rrggbb"   켜졌을 때 색
 * glTF 조명(THREE.Light)이 들어 있으면 세기를 켜고 끈다.
 * 조명을 새로 만들지 않는다 (조명 수가 바뀌면 셰이더 재컴파일로 끊긴다).
 */
interface Lamp {
  id: string;
  group: string;
  node: THREE.Object3D;
  on: boolean;
  blink: number;
  color: THREE.Color;
  mats: { mat: THREE.Material; base: THREE.Color; kind: 'basic' | 'emissive' }[];
  lights: { light: THREE.Light; base: number }[];
  /** 메시 발광이 아닌 단순 표시 노드: 켜짐 = 보임 */
  visibility: boolean;
}

export class LightGroups {
  readonly lamps: Lamp[] = [];
  private t = 0;
  /** 그룹별 밝기 배율 (깜빡임 연출: 0~1) */
  readonly dim = new Map<string, number>();

  /** filter: 묶을 LIGHT_ 노드만 (몸체가 함께 움직이는 등은 빼고 따로 다룬다) */
  constructor(level: Level, filter?: (id: string, node: THREE.Object3D) => boolean) {
    for (const [id, node] of level.lights) {
      if (filter && !filter(id, node)) continue;
      const group = str(node, 'group') ?? id.replace(/_\d+$/, '');
      const c = color(node, 'color') ?? new THREE.Color(0xff4a3a);
      const toggle = bool(node, 'emissiveToggle', false);
      const lamp: Lamp = { id, group, node, on: bool(node, 'on', !toggle), blink: num(node, 'blink', 0), color: c, mats: [], lights: [], visibility: false };
      const seen = new Set<THREE.Material>();
      node.traverse((o) => {
        const l = o as THREE.Light;
        if (l.isLight) lamp.lights.push({ light: l, base: l.intensity || 2 });
        const m = o as THREE.Mesh;
        if (!m.isMesh || m.userData.isOutline) return;
        // 같은 머티리얼을 다른 노드와 나누지 않게 복제
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        const cloned = mats.map((mt) => {
          if (seen.has(mt)) return mt;
          const cm = mt.clone();
          seen.add(cm);
          const basic = (cm as THREE.MeshBasicMaterial).isMeshBasicMaterial;
          lamp.mats.push({ mat: cm, base: basic ? (cm as THREE.MeshBasicMaterial).color.clone() : ((cm as THREE.MeshToonMaterial).emissive?.clone() ?? new THREE.Color(0)), kind: basic ? 'basic' : 'emissive' });
          return cm;
        });
        m.material = Array.isArray(m.material) ? cloned : cloned[0];
      });
      // 발광 메시는 꺼지면 숨긴다 (꺼진 모습은 아래의 어두운 렌즈 메시가 보여 준다: docs/LEVELS.md)
      lamp.visibility = !lamp.lights.length;
      this.lamps.push(lamp);
    }
    this.apply(0);
  }

  set(group: string, on: boolean): void {
    for (const l of this.lamps) if (l.group === group || l.id.startsWith(group)) l.on = on;
  }

  has(group: string): boolean {
    return this.lamps.some((l) => l.group === group || l.id.startsWith(group));
  }

  update(dt: number): void {
    this.t += dt;
    this.apply(this.t);
  }

  private apply(t: number): void {
    for (const l of this.lamps) {
      const dim = this.dim.get(l.group) ?? 1;
      const blink = l.blink > 0 ? 0.25 + 0.75 * (0.5 + 0.5 * Math.sin((t * Math.PI * 2) / l.blink)) : 1;
      const k = l.on ? blink * dim : 0;
      if (l.visibility) l.node.visible = l.on;
      for (const m of l.mats) {
        if (m.kind === 'basic') {
          const mb = m.mat as THREE.MeshBasicMaterial;
          if (l.on) mb.color.copy(l.color).multiplyScalar(0.25 + 0.75 * k);
          else mb.color.copy(m.base);
        } else {
          const mt = m.mat as THREE.MeshToonMaterial;
          if (mt.emissive) mt.emissive.copy(l.color).multiplyScalar(k * 1.4);
        }
      }
      for (const x of l.lights) x.light.intensity = x.base * k;
    }
  }
}
