import * as THREE from 'three';

/**
 * 움직이지 않는 물체의 행렬 얼리기 (레벨·세트 glb, 성능 조사).
 * three는 렌더마다 모든 Object3D의 matrix(위치·회전·축척 → 행렬)와 matrixWorld(부모 × matrix)를 다시 곱한다.
 * 큰 레벨에서는 물체 4.4천 개가 매 프레임 그랬다.
 *
 * freezeStatic(root, dynamic)이 root 아래를 나눈다.
 *  - 움직이는 노드(dynamic(o)가 true, unfreeze·markDynamic, userData.dynamic, 뼈·스킨 메시·카메라, 코드가 matrix를 직접
 *    쓰는 노드(matrixAutoUpdate=false, bakeStatic이 합친 메시는 빼고), 자기 updateMatrixWorld를 가진 노드)와 그 아래 전체는 그대로 둔다.
 *  - 움직이는 노드가 하나도 없는 가장 큰 묶음(얼린 묶음)은 matrix·matrixWorld를 한 번 계산해 둔다. 묶음 뿌리의
 *    updateMatrixWorld·updateWorldMatrix(인스턴스 함수)가 부모 matrixWorld가 바뀌었을 때만 묶음 전체를 다시 곱하고, 아니면
 *    아래로 내려가지 않는다: 장면 갱신이 묶음을 통째로 건너뛴다.
 *    matrixAutoUpdate·matrixWorldAutoUpdate 플래그는 건드리지 않는다. three r170에서 matrixWorldAutoUpdate = false는 자기
 *    곱하기만 건너뛰고 자식은 force로 그대로 돈다(Object3D.updateMatrixWorld). 플래그를 그대로 두면 묶음 안 노드를 복제해도
 *    (clone은 플래그를 베낀다) 멀쩡하고, 묶음 안 노드의 getWorldPosition·updateMatrixWorld(true)는 그때 값으로 다시 계산한다.
 *  - 움직이는 노드를 품은 노드(root 자신 포함)는 그대로 두고 그 아래를 다시 나눈다.
 * 얼린 노드를 읽는 것(matrixWorld, getWorldPosition, 레이캐스트)은 그대로 맞다.
 *
 * 안전망: checkFrozen()(Engine.render가 그리기 전에 부른다)이 얼린 노드의 position·quaternion·scale·자식 수를 얼릴 때 값과
 * 비교한다(개발 서버는 매 프레임 전부, 빌드는 레벨마다 프레임당 CHECK_BUDGET개씩 돌아가며). 바뀐 노드는 그 자리에서 움직이는
 * 노드로 바꾸고(새로 붙은 자식도) 그 묶음만 다시 나눈다. 개발 서버는 '[static] …'으로 경고한다: 그 노드를 움직임 규칙에
 * 더하거나 움직이기 전에 unfreeze(node)를 부를 것 (찾기 전까지는 그 노드가 화면에서 멈춰 있다).
 *
 * 화면 거르기: 얼린 묶음 가운데 그릴 것이 있는 묶음(구역)은 월드 경계 구를 하나 둔다. cullSectors(camera)가 화면 밖 구역을
 * 렌더 동안만 숨겨(visible = false) three가 그 아래를 돌지 않게 하고, restoreSectors()가 바로 되돌린다.
 * 조명·InstancedMesh·frustumCulled=false 메시를 품은 묶음은 거르지 않는다.
 */

/** 이 노드와 그 아래 전체는 움직인다 (얼리지 않는다) */
export type DynamicTest = (o: THREE.Object3D) => boolean;

const pinned = new WeakSet<THREE.Object3D>();
const DEV = import.meta.env.DEV;
const own = Object.prototype.hasOwnProperty;
/** 한 노드 스냅숏: 위치 3, 회전 4, 축척 3, 자식 수 1 */
const SNAP = 11;
const SECTOR_MARGIN = 1;
const MIN_SECTOR_NODES = 3;
const CHECK_BUDGET = 1024;

function builtinDynamic(o: THREE.Object3D): boolean {
  return (
    pinned.has(o) ||
    // 코드가 matrix를 직접 쓰는 노드 (render/bake.ts가 합친 메시는 행렬이 고정이라 얼린다)
    (!o.matrixAutoUpdate && !o.userData.baked) ||
    !o.matrixWorldAutoUpdate ||
    !!o.userData.dynamic ||
    (o as THREE.Bone).isBone === true ||
    (o as THREE.SkinnedMesh).isSkinnedMesh === true ||
    (o as THREE.Camera).isCamera === true ||
    own.call(o, 'updateMatrixWorld') ||
    own.call(o, 'updateWorldMatrix')
  );
}

/** 얼린 묶음 하나 */
class FrozenGroup {
  readonly nodes: THREE.Object3D[] = [];
  snap = new Float64Array(0);
  private pos: THREE.Vector3[] = [];
  private quat: THREE.Quaternion[] = [];
  private scl: THREE.Vector3[] = [];
  private kids: THREE.Object3D[][] = [];
  /** 마지막으로 맞춘 부모 matrixWorld */
  readonly parentSnap = new Float64Array(16).fill(NaN);
  /** 화면 거르기 구 (월드). null이면 거르지 않는다 */
  sphere: THREE.Sphere | null = null;
  private local: THREE.Sphere | null = null;

  constructor(
    readonly set: StaticSet,
    readonly root: THREE.Object3D,
  ) {}

  freeze(): void {
    const r = this.root;
    r.updateWorldMatrix(true, true);
    let cullable = true;
    let renderables = 0;
    const box = new THREE.Box3();
    const inv = new THREE.Matrix4().copy(r.matrixWorld).invert();
    const m = new THREE.Matrix4();
    const s = new THREE.Sphere();
    r.traverse((o) => {
      this.nodes.push(o);
      this.set.owner.set(o, this);
      nodeSet.set(o, this.set);
      if (!cullable) return;
      const mesh = o as THREE.Mesh;
      if ((o as THREE.Light).isLight || (mesh as unknown as THREE.InstancedMesh).isInstancedMesh || (o as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) {
        cullable = false;
        return;
      }
      if (mesh.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) {
        if (!o.frustumCulled) {
          cullable = false;
          return;
        }
        const g = mesh.geometry as THREE.BufferGeometry | undefined;
        if ((o as THREE.Sprite).isSprite || !g) {
          s.set(new THREE.Vector3(), 1);
        } else {
          if (!g.boundingSphere) g.computeBoundingSphere();
          if (!g.boundingSphere || !Number.isFinite(g.boundingSphere.radius)) {
            cullable = false;
            return;
          }
          s.copy(g.boundingSphere);
        }
        // 묶음 뿌리 공간으로 (부모가 움직여도 다시 계산하지 않게)
        s.applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld));
        box.expandByPoint(s.center.clone().addScalar(s.radius));
        box.expandByPoint(s.center.clone().addScalar(-s.radius));
        renderables++;
      }
    });
    this.snap = new Float64Array(this.nodes.length * SNAP);
    this.capture();
    this.parentSnap.set(r.parent ? r.parent.matrixWorld.elements : IDENTITY);
    if (cullable && renderables > 0 && this.nodes.length >= MIN_SECTOR_NODES) {
      const l = box.getBoundingSphere(new THREE.Sphere());
      l.radius += SECTOR_MARGIN;
      const w = l.clone().applyMatrix4(r.matrixWorld);
      if (Number.isFinite(w.radius) && Number.isFinite(w.center.x + w.center.y + w.center.z)) {
        this.local = l;
        this.sphere = w;
      }
    }
    const self = this;
    r.updateMatrixWorld = function (): void {
      self.sync();
    };
    r.updateWorldMatrix = function (this: THREE.Object3D, updateParents: boolean): void {
      if (updateParents && this.parent) this.parent.updateWorldMatrix(true, false);
      self.sync();
    };
  }

  /** 지금 값을 스냅숏으로. 점검이 노드 종류(Mesh·Group …)마다 다른 모양의 객체를 읽지 않게 벡터·배열을 따로 모아 둔다 */
  capture(): void {
    const n = this.nodes;
    const s = this.snap;
    this.pos = n.map((o) => o.position);
    this.quat = n.map((o) => o.quaternion);
    this.scl = n.map((o) => o.scale);
    this.kids = n.map((o) => o.children);
    for (let i = 0, k = 0; i < n.length; i++, k += SNAP) {
      const o = n[i];
      const p = o.position;
      const q = o.quaternion;
      const c = o.scale;
      s[k] = p.x;
      s[k + 1] = p.y;
      s[k + 2] = p.z;
      s[k + 3] = q.x;
      s[k + 4] = q.y;
      s[k + 5] = q.z;
      s[k + 6] = q.w;
      s[k + 7] = c.x;
      s[k + 8] = c.y;
      s[k + 9] = c.z;
      s[k + 10] = o.children.length;
    }
  }

  /** 부모 matrixWorld가 바뀌었으면 묶음 전체의 matrixWorld를 다시 곱한다 */
  sync(): void {
    const r = this.root;
    const e = r.parent ? r.parent.matrixWorld.elements : IDENTITY;
    const s = this.parentSnap;
    let same = !r.matrixWorldNeedsUpdate;
    for (let i = 0; same && i < 16; i++) same = e[i] === s[i];
    if (same) return;
    s.set(e);
    refresh(r);
    if (this.local && this.sphere) this.sphere.copy(this.local).applyMatrix4(r.matrixWorld);
  }

  /** [from, to) 가운데 얼린 뒤 바뀐 노드의 번호 (없으면 -1) */
  changed(from: number, to: number): number {
    const s = this.snap;
    const P = this.pos;
    const Q = this.quat;
    const C = this.scl;
    const K = this.kids;
    for (let i = from, k = from * SNAP; i < to; i++, k += SNAP) {
      const p = P[i];
      const q = Q[i];
      const c = C[i];
      if (
        p.x !== s[k] || p.y !== s[k + 1] || p.z !== s[k + 2] ||
        q.x !== s[k + 3] || q.y !== s[k + 4] || q.z !== s[k + 5] || q.w !== s[k + 6] ||
        c.x !== s[k + 7] || c.y !== s[k + 8] || c.z !== s[k + 9] ||
        K[i].length !== s[k + 10]
      ) return i;
    }
    return -1;
  }

  thaw(): void {
    const r = this.root;
    delete (r as Partial<THREE.Object3D>).updateMatrixWorld;
    delete (r as Partial<THREE.Object3D>).updateWorldMatrix;
    for (const o of this.nodes) {
      if (this.set.owner.get(o) !== this) continue;
      this.set.owner.delete(o);
      nodeSet.delete(o);
    }
    r.matrixWorldNeedsUpdate = true;
  }
}

const IDENTITY = new THREE.Matrix4().elements;

function refresh(o: THREE.Object3D): void {
  if (o.matrixAutoUpdate) o.updateMatrix();
  if (o.parent) o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix);
  else o.matrixWorld.copy(o.matrix);
  // updateMatrix가 켠 표시를 끈다 (켜 두면 sync가 매 프레임 다시 곱한다)
  o.matrixWorldNeedsUpdate = false;
  const ch = o.children;
  for (let i = 0; i < ch.length; i++) refresh(ch[i]);
}

/** freezeStatic이 만든 묶음들 (레벨 하나) */
export class StaticSet {
  groups: FrozenGroup[] = [];
  /** 얼린 노드 → 그 묶음 */
  readonly owner = new Map<THREE.Object3D, FrozenGroup>();
  /** 화면 거르기 구역 */
  sectors: FrozenGroup[] = [];
  active = false;

  constructor(
    readonly root: THREE.Object3D,
    readonly label: string,
    private readonly dynamic: DynamicTest,
  ) {}

  isDynamic(o: THREE.Object3D): boolean {
    return builtinDynamic(o) || this.dynamic(o);
  }

  /** o 아래를 나눈다 (o는 얼려 있지 않아야 한다) */
  partition(o: THREE.Object3D): void {
    const moving = new Set<THREE.Object3D>();
    // 아래에 움직이는 노드가 있으면 true
    const scan = (x: THREE.Object3D): boolean => {
      if (this.isDynamic(x)) {
        moving.add(x);
        return true;
      }
      let any = false;
      for (const c of x.children) if (scan(c)) any = true;
      if (any) moving.add(x);
      return any;
    };
    scan(o);
    // 뿌리(레벨 루트)는 얼리지 않는다: 코드가 세트 전체를 옮겨도 아래 묶음이 부모 행렬로 따라간다
    moving.add(this.root);
    const walk = (x: THREE.Object3D): void => {
      if (!moving.has(x)) {
        const g = new FrozenGroup(this, x);
        g.freeze();
        this.groups.push(g);
        return;
      }
      if (x !== this.root && this.isDynamic(x)) return;
      for (const c of x.children) walk(c);
    };
    walk(o);
    this.sectors = this.groups.filter((g) => g.sphere);
  }

  /** 노드가 움직이게 되면: 그 노드(와 아래)를 움직이는 노드로 두고 속한 묶음을 다시 나눈다 */
  unfreeze(o: THREE.Object3D, extra: THREE.Object3D[] = []): void {
    pinned.add(o);
    for (const x of extra) pinned.add(x);
    const g = this.owner.get(o);
    if (!g) return;
    g.thaw();
    this.groups = this.groups.filter((x) => x !== g);
    this.partition(g.root);
  }

  private cursorGroup = 0;
  private cursorNode = 0;

  /** 노드를 budget개까지 이어서 본다 (지난번 멈춘 곳부터). 남은 예산을 돌려준다 */
  check(budget: number): number {
    let left = budget;
    let visited = 0;
    while (left > 0 && visited < this.groups.length) {
      if (this.cursorGroup >= this.groups.length) {
        this.cursorGroup = 0;
        this.cursorNode = 0;
      }
      const g = this.groups[this.cursorGroup];
      const end = Math.min(g.nodes.length, this.cursorNode + left);
      const j = g.changed(this.cursorNode, end);
      if (j >= 0) {
        this.onChanged(g, j);
        // 묶음 목록이 바뀌었다: 처음부터
        this.cursorGroup = 0;
        this.cursorNode = 0;
        visited = 0;
        continue;
      }
      left -= end - this.cursorNode;
      if (end >= g.nodes.length) {
        this.cursorGroup++;
        this.cursorNode = 0;
        visited++;
      } else this.cursorNode = end;
    }
    return left;
  }

  private onChanged(g: FrozenGroup, j: number): void {
    const o = g.nodes[j];
    const k = j * SNAP;
    const p = o.position;
    const q = o.quaternion;
    const c = o.scale;
    const s = g.snap;
    const moved =
      p.x !== s[k] || p.y !== s[k + 1] || p.z !== s[k + 2] || q.x !== s[k + 3] || q.y !== s[k + 4] || q.z !== s[k + 5] ||
      q.w !== s[k + 6] || c.x !== s[k + 7] || c.y !== s[k + 8] || c.z !== s[k + 9];
    // 새로 붙은 자식은 코드가 붙인 것이라 움직인다고 본다 (빠진 자식은 다시 나누기만)
    const added = o.children.filter((x) => this.owner.get(x) !== g);
    if (DEV) {
      const what = moved ? '위치·회전·축척이 바뀜' : added.length ? `자식이 붙음 (${added.map((x) => x.name || x.type).join(', ')})` : '자식이 빠짐';
      console.warn(`[static] ${this.label}: 얼린 노드 ${pathOf(o, this.root) || '(뿌리)'}의 ${what} → 다시 나눔 (움직이는 규칙에 더하거나 먼저 unfreeze)`);
    }
    if (moved) pinned.add(o);
    for (const x of added) pinned.add(x);
    g.thaw();
    this.groups.splice(this.groups.indexOf(g), 1);
    this.partition(g.root);
  }

  stats(): { groups: number; nodes: number; sectors: number } {
    return { groups: this.groups.length, nodes: this.owner.size, sectors: this.sectors.length };
  }
}

function pathOf(o: THREE.Object3D, root: THREE.Object3D): string {
  const parts: string[] = [];
  for (let x: THREE.Object3D | null = o; x && x !== root; x = x.parent) parts.push(x.name || x.type);
  return parts.reverse().join('/');
}

// 버린 레벨이 남지 않게 약한 참조로 (붙은 레벨만 active에 든다: Level.detach가 뺀다)
const sets = new WeakMap<THREE.Object3D, StaticSet>();
/** 얼린 노드 → 그 레벨의 StaticSet */
const nodeSet = new WeakMap<THREE.Object3D, StaticSet>();
const active = new Set<StaticSet>();
let enabled = typeof location === 'undefined' || new URLSearchParams(location.search).get('staticmatrix') !== '0';
let sectorsOn = typeof location === 'undefined' || new URLSearchParams(location.search).get('sectors') !== '0';

/**
 * root 아래 움직이지 않는 묶음을 얼린다 (root 자신은 얼리지 않는다). 이미 얼렸으면 그 StaticSet을 돌려준다.
 * active(기본 true): 매 프레임 점검·화면 거르기에 넣는다. 장면에서 뗄 때 setStaticActive(root, false).
 */
export function freezeStatic(root: THREE.Object3D, dynamic: DynamicTest = () => false, label = root.name): StaticSet | null {
  if (!enabled) return null;
  let s = sets.get(root);
  if (!s) {
    s = new StaticSet(root, label, dynamic);
    sets.set(root, s);
    s.partition(root);
  }
  setStaticActive(root, true);
  return s;
}

/** 장면을 통째로 비울 때 (Engine.reset): 매 프레임 점검·화면 거르기에서 모든 레벨을 뺀다 */
export function clearStaticActive(): void {
  for (const s of active) s.active = false;
  active.clear();
  restoreSectors();
}

export function setStaticActive(root: THREE.Object3D, on: boolean): void {
  const s = sets.get(root);
  if (!s) return;
  s.active = on;
  if (on) active.add(s);
  else active.delete(s);
}

/**
 * 코드가 움직이기 전에 부른다: o(와 그 아래)를 앞으로 계속 움직이는 노드로 둔다. 얼려 있지 않거나 얼리기 전이어도 된다
 * (얼리기 전이면 freezeStatic이 o를 건너뛴다). 조상을 따로 풀 필요는 없다.
 */
export function unfreeze(o: THREE.Object3D): void {
  pinned.add(o);
  nodeSet.get(o)?.unfreeze(o);
}

/** 얼리기 전에 표시만: freezeStatic이 이 노드와 그 아래를 건너뛴다 */
export function markDynamic(o: THREE.Object3D): void {
  pinned.add(o);
}

/**
 * 얼린 노드가 바뀌었는지 (Engine.render가 그리기 전에). 빌드는 레벨마다 프레임당 CHECK_BUDGET개씩 돌아가며 본다
 * (4.2천 개면 5프레임에 한 바퀴, 프레임당 약 15 µs). 개발 서버는 매 프레임 전부 본다 (빠뜨린 규칙을 바로 경고).
 */
export function checkFrozen(): void {
  for (const s of active) s.check(DEV ? Infinity : CHECK_BUDGET);
}

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const culled: THREE.Object3D[] = [];

/** 화면 밖 구역을 이번 렌더 동안 숨긴다 (restoreSectors와 짝) */
export function cullSectors(camera: THREE.Camera): void {
  if (!sectorsOn || active.size === 0) return;
  camera.updateWorldMatrix(true, false);
  _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_pv);
  for (const s of active) {
    const sec = s.sectors;
    for (let i = 0; i < sec.length; i++) {
      const g = sec[i];
      if (g.root.visible && !_frustum.intersectsSphere(g.sphere!)) {
        g.root.visible = false;
        culled.push(g.root);
      }
    }
  }
}

let lastCulled = 0;

export function restoreSectors(): void {
  lastCulled = culled.length;
  for (let i = 0; i < culled.length; i++) culled[i].visible = true;
  culled.length = 0;
}

/** 점검·전후 비교 (개발 서버 콘솔: __static) */
export const staticDebug = {
  get enabled(): boolean {
    return enabled;
  },
  set enabled(v: boolean) {
    enabled = v;
  },
  get sectors(): boolean {
    return sectorsOn;
  },
  set sectors(v: boolean) {
    sectorsOn = v;
  },
  /** checkFrozen·cullSectors 한 번에 드는 시간 (µs, n번 평균) */
  bench(camera: THREE.Camera, n = 500): { checkUs: number; cullUs: number } {
    let t = performance.now();
    for (let i = 0; i < n; i++) checkFrozen();
    const checkUs = ((performance.now() - t) / n) * 1000;
    t = performance.now();
    for (let i = 0; i < n; i++) {
      cullSectors(camera);
      restoreSectors();
    }
    return { checkUs: +checkUs.toFixed(2), cullUs: +(((performance.now() - t) / n) * 1000).toFixed(2) };
  },
  /** 붙은 레벨마다 지금 위치·회전·축척으로 matrixWorld를 처음부터 다시 곱해 실제 값과 비교 (어긋난 노드 수와 이름) */
  verify(): { checked: number; bad: number; names: string[] } {
    let checked = 0;
    let bad = 0;
    const names: string[] = [];
    const walk = (o: THREE.Object3D, parentWorld: THREE.Matrix4): void => {
      const local = o.matrixAutoUpdate ? new THREE.Matrix4().compose(o.position, o.quaternion, o.scale) : o.matrix;
      const w = new THREE.Matrix4().multiplyMatrices(parentWorld, local);
      checked++;
      let err = 0;
      for (let i = 0; i < 16; i++) err = Math.max(err, Math.abs(w.elements[i] - o.matrixWorld.elements[i]) / (1 + Math.abs(w.elements[i])));
      if (err > 1e-4) {
        bad++;
        if (names.length < 8) names.push(o.name || o.type);
      }
      for (const c of o.children) walk(c, w);
    };
    for (const st of active) for (const c of st.root.children) walk(c, st.root.matrixWorld);
    return { checked, bad, names };
  },
  /** 지난 렌더에서 숨긴 구역 수 */
  get culled(): number {
    return lastCulled;
  },
  stats(): Record<string, { groups: number; nodes: number; sectors: number; active: boolean }> {
    const out: Record<string, { groups: number; nodes: number; sectors: number; active: boolean }> = {};
    for (const s of active) out[s.label] = { ...s.stats(), active: s.active };
    return out;
  },
};
if (typeof window !== 'undefined') (window as unknown as { __static?: typeof staticDebug }).__static = staticDebug;
