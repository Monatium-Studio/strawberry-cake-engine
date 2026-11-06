import * as THREE from 'three';
import { Detour } from '@recast-navigation/core';
import type { NavWorld } from './NavWorld';

/**
 * 내비 디버그 표시: 내비메시(섬별 색, 가지친 섬은 어두운 빨강), 경계선, 장애물(문·움직이는 물체), 에이전트 경로.
 *   const dbg = new NavDebug(); engine.world.add(dbg.root); dbg.setNav(nav); 매 프레임 dbg.update()
 * extraPaths로 게임 쪽 경로(직접 움직이는 캐릭터의 목표 경로 등)를 같이 그릴 수 있다.
 */

export interface DebugPath {
  points: THREE.Vector3[];
  color: number;
}

const LIFT = 0.04;

export class NavDebug {
  readonly root = new THREE.Group();
  private nav: NavWorld | null = null;
  private version = -1;
  private surface: THREE.Mesh | null = null;
  private edges: THREE.LineSegments | null = null;
  private readonly lines: THREE.LineSegments;
  private readonly lineGeo = new THREE.BufferGeometry();
  private linePos = new Float32Array(3 * 2 * 4096);
  private lineCol = new Float32Array(3 * 2 * 4096);
  /** 경로는 굵은 띠 (1px 선은 위에서 보면 안 보인다) */
  private readonly ribbons: THREE.Mesh;
  private readonly ribGeo = new THREE.BufferGeometry();
  private ribPos = new Float32Array(3 * 6 * 4096);
  private ribCol = new Float32Array(3 * 6 * 4096);
  /** 띠 폭 (m) */
  ribbonWidth = 0.14;
  /** 바깥에서 더 그릴 선 (게임 쪽 목표 경로 등) */
  extraPaths: (() => DebugPath[]) | null = null;
  /** 가지친 섬도 (어두운 빨강으로) 그린다 */
  showPruned = true;
  /** 섬마다 뚜렷이 다른 색 (연결 점검용, ?islands=1) */
  distinctIslands = false;

  constructor() {
    this.root.name = 'nav_debug';
    this.root.renderOrder = 10;
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(this.lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 12;
    this.root.add(this.lines);
    this.ribGeo.setAttribute('position', new THREE.BufferAttribute(this.ribPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.ribGeo.setAttribute('color', new THREE.BufferAttribute(this.ribCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.ribbons = new THREE.Mesh(this.ribGeo, new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide, fog: false }));
    this.ribbons.frustumCulled = false;
    this.ribbons.renderOrder = 13;
    this.root.add(this.ribbons);
  }

  get visible(): boolean {
    return this.root.visible;
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  setNav(nav: NavWorld | null): void {
    if (nav === this.nav) return;
    this.nav = nav;
    this.version = -1;
    this.clearSurface();
  }

  get current(): NavWorld | null {
    return this.nav;
  }

  private clearSurface(): void {
    for (const o of [this.surface, this.edges]) {
      if (!o) continue;
      this.root.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.surface = null;
    this.edges = null;
  }

  /** 내비메시 폴리곤 → 메시 + 경계선 */
  private rebuildSurface(nav: NavWorld): void {
    this.clearSurface();
    const nm = nav.navMesh;
    const pos: number[] = [];
    const col: number[] = [];
    const epos: number[] = [];
    const ecol: number[] = [];
    const c = new THREE.Color();
    const max = nm.getMaxTiles();
    const vtmp: number[] = [];
    for (let ti = 0; ti < max; ti++) {
      const tile = nm.getTile(ti);
      const h = tile.header();
      if (!h) continue;
      const vc = h.vertCount();
      const verts = new Float32Array(vc * 3);
      for (let i = 0; i < vc * 3; i++) verts[i] = tile.verts(i);
      const base = nm.getPolyRefBase(tile);
      const pc = h.polyCount();
      for (let j = 0; j < pc; j++) {
        const poly = tile.polys(j);
        if (poly.getType() === 1) continue; // 오프메시 링크
        const isl = nav.islandOf(base + j);
        const kept = nav.isKeptIsland(isl) && poly.flags() !== 0;
        if (!kept && !this.showPruned) continue;
        // 유지하는 섬: 청록~파랑 (섬마다 조금씩), 가지친 섬: 어두운 빨강
        if (kept) c.setHSL(this.distinctIslands ? (isl * 0.618034) % 1 : 0.42 + ((isl * 0.161) % 1) * 0.2, 0.85, 0.5);
        else c.setRGB(0.55, 0.08, 0.1);
        const n = poly.vertCount();
        vtmp.length = 0;
        for (let k = 0; k < n; k++) vtmp.push(poly.verts(k));
        for (let k = 1; k < n - 1; k++) {
          for (const vi of [vtmp[0], vtmp[k], vtmp[k + 1]]) {
            pos.push(verts[vi * 3], verts[vi * 3 + 1] + LIFT, verts[vi * 3 + 2]);
            col.push(c.r, c.g, c.b);
          }
        }
        for (let k = 0; k < n; k++) {
          const nei = poly.neis(k);
          const a = vtmp[k];
          const b = vtmp[(k + 1) % n];
          const boundary = nei === 0;
          // 타일 경계(외부 링크)와 내부 변은 흐리게, 진짜 경계(벽·낭떠러지)는 진하게
          const e = boundary ? (kept ? [0.02, 0.12, 0.1] : [0.35, 0.02, 0.04]) : [c.r * 0.75, c.g * 0.75, c.b * 0.75];
          if (!boundary && (nei & Detour.DT_EXT_LINK) === 0 && nei - 1 < j) continue; // 내부 변은 한 번만
          epos.push(verts[a * 3], verts[a * 3 + 1] + LIFT * 1.5, verts[a * 3 + 2], verts[b * 3], verts[b * 3 + 1] + LIFT * 1.5, verts[b * 3 + 2]);
          ecol.push(...e, ...e);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.surface = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, fog: false }),
    );
    this.surface.renderOrder = 10;
    this.surface.frustumCulled = false;
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(epos, 3));
    eg.setAttribute('color', new THREE.Float32BufferAttribute(ecol, 3));
    this.edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, fog: false }));
    this.edges.renderOrder = 11;
    this.edges.frustumCulled = false;
    this.root.add(this.surface, this.edges);
  }

  /** 매 프레임 (보일 때만 일한다) */
  update(): void {
    const nav = this.nav;
    if (!this.root.visible || !nav || nav.isDisposed) return;
    if (nav.version !== this.version) {
      this.version = nav.version;
      this.rebuildSurface(nav);
    }
    let n = 0;
    const cap = this.linePos.length / 6;
    const c = new THREE.Color();
    const seg = (a: THREE.Vector3 | { x: number; y: number; z: number }, b: THREE.Vector3 | { x: number; y: number; z: number }, color: number, lift = 0.12) => {
      if (n >= cap) return;
      c.setHex(color);
      this.linePos.set([a.x, a.y + lift, a.z, b.x, b.y + lift, b.z], n * 6);
      this.lineCol.set([c.r, c.g, c.b, c.r, c.g, c.b], n * 6);
      n++;
    };
    let nr = 0;
    const rcap = this.ribPos.length / 18;
    const rib = (a: THREE.Vector3, b: THREE.Vector3, color: number, lift = 0.12) => {
      if (nr >= rcap) return;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz);
      if (l < 1e-4) return;
      const w = this.ribbonWidth / 2;
      const nx = (-dz / l) * w;
      const nz = (dx / l) * w;
      c.setHex(color);
      const ay = a.y + lift;
      const by = b.y + lift;
      this.ribPos.set([a.x + nx, ay, a.z + nz, a.x - nx, ay, a.z - nz, b.x + nx, by, b.z + nz, b.x + nx, by, b.z + nz, a.x - nx, ay, a.z - nz, b.x - nx, by, b.z - nz], nr * 18);
      for (let k = 0; k < 6; k++) this.ribCol.set([c.r, c.g, c.b], nr * 18 + k * 3);
      nr++;
    };
    const cross = (p: THREE.Vector3, color: number, s = 0.15) => {
      seg({ x: p.x - s, y: p.y, z: p.z }, { x: p.x + s, y: p.y, z: p.z }, color);
      seg({ x: p.x, y: p.y, z: p.z - s }, { x: p.x, y: p.y, z: p.z + s }, color);
    };
    // 장애물 (문·움직이는 물체): 주황 상자 / 원
    for (const o of nav.tileCache.obstacles.values()) {
      if (o.type === 'box') {
        const { position: p, halfExtents: h, angle } = o;
        const cs = Math.cos(angle);
        const sn = Math.sin(angle);
        const corner = (sx: number, sz: number, y: number) => ({ x: p.x + sx * h.x * cs + sz * h.z * sn, y, z: p.z - sx * h.x * sn + sz * h.z * cs });
        const y0 = p.y - h.y;
        const y1 = p.y + h.y;
        const quad = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        for (let i = 0; i < 4; i++) {
          const [ax, az] = quad[i];
          const [bx, bz] = quad[(i + 1) % 4];
          seg(corner(ax, az, y0), corner(bx, bz, y0), 0xff9a1f, 0);
          seg(corner(ax, az, y1), corner(bx, bz, y1), 0xff9a1f, 0);
          seg(corner(ax, az, y0), corner(ax, az, y1), 0xff9a1f, 0);
        }
      } else {
        const p = o.position;
        for (let i = 0; i < 12; i++) {
          const a0 = (i / 12) * Math.PI * 2;
          const a1 = ((i + 1) / 12) * Math.PI * 2;
          seg({ x: p.x + Math.cos(a0) * o.radius, y: p.y, z: p.z + Math.sin(a0) * o.radius }, { x: p.x + Math.cos(a1) * o.radius, y: p.y, z: p.z + Math.sin(a1) * o.radius }, 0xff9a1f, 0.05);
        }
      }
    }
    // 오프메시 링크 (뛰어내리기 등): 노란 호, 끝에 화살촉
    const A = new THREE.Vector3();
    const B = new THREE.Vector3();
    for (const l of nav.links) {
      const s0 = l.startPosition;
      const e0 = l.endPosition;
      const top = Math.max(s0.y, e0.y) + 0.35;
      for (let i = 0; i < 6; i++) {
        const t0 = i / 6;
        const t1 = (i + 1) / 6;
        const arc = (t: number, out: THREE.Vector3) => out.set(s0.x + (e0.x - s0.x) * t, (1 - t) * (1 - t) * s0.y + 2 * (1 - t) * t * top + t * t * e0.y, s0.z + (e0.z - s0.z) * t);
        rib(arc(t0, A), arc(t1, B), 0xffd23a, 0.05);
      }
      cross(B.set(e0.x, e0.y, e0.z), 0xffd23a, 0.12);
    }
    // 에이전트: 경로, 조향점, 속도
    for (const ag of nav.agents) {
      const path = ag.path;
      if (ag.state === 'moving' && path.length > 1) {
        rib(ag.position, path[ag.corner] ?? ag.target, ag.color);
        for (let i = ag.corner; i < path.length - 1; i++) rib(path[i], path[i + 1], ag.color);
        cross(ag.steer, 0xffffff, 0.1);
      }
      cross(ag.position, ag.state === 'failed' ? 0xff3030 : ag.partial ? 0xffd030 : ag.color, 0.25);
      const v = ag.velocity;
      if (v.lengthSq() > 1e-4) seg(ag.position, { x: ag.position.x + v.x * 0.4, y: ag.position.y, z: ag.position.z + v.z * 0.4 }, 0xffffff, 0.3);
    }
    for (const p of this.extraPaths?.() ?? []) {
      for (let i = 0; i < p.points.length - 1; i++) rib(p.points[i], p.points[i + 1], p.color, 0.2);
    }
    this.ribGeo.setDrawRange(0, nr * 6);
    (this.ribGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.ribGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.lineGeo.setDrawRange(0, n * 2);
    (this.lineGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.lineGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.clearSurface();
    this.lineGeo.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.ribGeo.dispose();
    (this.ribbons.material as THREE.Material).dispose();
    this.root.removeFromParent();
  }
}

/** 화면 왼쪽 아래 작은 글 (내비 통계) */
export function navLabel(parent: HTMLElement): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;left:8px;bottom:8px;max-width:60%;font:11px/1.35 ui-monospace,Menlo,monospace;color:#d8fff4;background:rgba(0,20,18,.62);padding:4px 7px;border-radius:4px;pointer-events:none;z-index:50;white-space:pre-wrap';
  parent.appendChild(el);
  return el;
}
