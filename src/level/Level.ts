import * as THREE from 'three';
import type { RaycastGeometry, StaticRaycastSet } from '../physics/RaycastGeometry';
import type { Engine, System } from '../core/Engine';
import { RAPIER } from '../physics/Physics';
import { freezeStatic, setStaticActive } from '../render/staticMatrices';
import { forwardOf, num, str, vec3, yawOf } from './props';

/** 빈 오브젝트 마커 (SPAWN_, NPC_, WP_, MARK_, PROP_, FX_) */
export interface Marker {
  /** 노드 이름 전체 (예: NPC_guide) */
  name: string;
  /** 접두사 뒤 (예: guide) */
  id: string;
  object: THREE.Object3D;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** 월드 정면 (Blender -Y) */
  forward: THREE.Vector3;
  /** 카메라식 yaw (정면을 바라볼 때, props.yawOf) */
  yaw: number;
  props: Record<string, unknown>;
}

/** CAM_<shot>_<nn> 한 점 */
export interface CamKey {
  index: number;
  position: THREE.Vector3;
  /** 카메라 회전 (three.js 카메라 기준: -Z가 시선) */
  quaternion: THREE.Quaternion;
  t: number;
  fov: number | null;
  look: THREE.Vector3 | null;
  props: Record<string, unknown>;
}

export interface CamRailData {
  shot: string;
  keys: CamKey[];
}

export interface LevelEnv {
  sky: THREE.Color | null;
  fog: [number, number] | null;
  /** 빛이 오는 방향 */
  sun: THREE.Vector3 | null;
  ambient: number | null;
  music: string | null;
  /** 확장: 카메라 근·원 평면 (아주 큰 장면) */
  near: number | null;
  far: number | null;
  /** 카메라를 따라 옮길 원경 노드 이름 (별하늘: 회전 없이 위치만) */
  skyNode: string | null;
  /** 확장 조명: 주광 색·세기, 반구광 하늘·땅 색, 시간대 이름 */
  sunColor: THREE.Color | null;
  sunIntensity: number | null;
  hemiSky: THREE.Color | null;
  hemiGround: THREE.Color | null;
  timeOfDay: string | null;
}

/** 엔진 기본 조명 (Engine.ts와 같은 값). 레벨이 바꾸지 않으면 이 값으로 되돌린다 */
const DEFAULT_LIGHT = { sun: 0xfff4e0, sunIntensity: 2.4, hemiSky: 0xeaf4ff, hemiGround: 0x8a8070, ambient: 1.5 };

/** 트리거 볼륨: 메시의 로컬 경계 상자 + 월드 행렬 (회전·축척 반영) */
export class TriggerVolume {
  inside = false;
  enters = 0;
  readonly box: THREE.Box3;
  readonly inverse = new THREE.Matrix4();
  readonly center = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(
    readonly id: string,
    readonly object: THREE.Object3D,
    box: THREE.Box3,
    matrixWorld: THREE.Matrix4,
    readonly props: Record<string, unknown>,
  ) {
    this.box = box.clone();
    this.inverse.copy(matrixWorld).invert();
    this.box.getCenter(this.center).applyMatrix4(matrixWorld);
  }

  contains(p: THREE.Vector3, margin = 0): boolean {
    this.tmp.copy(p).applyMatrix4(this.inverse);
    const b = this.box;
    return (
      this.tmp.x >= b.min.x - margin && this.tmp.x <= b.max.x + margin &&
      this.tmp.y >= b.min.y - margin && this.tmp.y <= b.max.y + margin &&
      this.tmp.z >= b.min.z - margin && this.tmp.z <= b.max.z + margin
    );
  }
}

/** DOOR_: 스크립트가 열고 닫는 문 (키네마틱 바디) */
export class Door {
  /** 0 = 닫힘, 1 = 열림 */
  open = 0;
  target = 0;
  speed = 1.6;
  private readonly home = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private waiters: (() => void)[] = [];

  constructor(
    readonly id: string,
    readonly mesh: THREE.Object3D,
    readonly body: RAPIER.RigidBody | null,
    readonly move: THREE.Vector3,
  ) {
    mesh.getWorldPosition(this.home);
  }

  setTarget(v: number): Promise<void> {
    this.target = v;
    if (this.open === v) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  /** 문짝이 있나 (치운 문은 false). setSolid로 바꾼다 */
  private solid = true;
  /** 레벨이 붙어 있나 (Level.attach/detach가 setLive로). 읽은 직후는 떨어진 채 */
  private live = false;

  /**
   * 문 몸체는 문짝이 있고(solid) 레벨이 붙어 있을 때만 켠다. 문 충돌체는 레벨 충돌체 목록(colliders) 밖이라, 이렇게 하지 않으면
   * 뗀 레벨의 문이 물리 세계에 그대로 남아 같은 자리를 새로 읽은 레벨의 열린 문간에 보이지 않는 벽으로 선다
   */
  setLive(on: boolean): void {
    this.live = on;
    this.applyBody();
  }

  /** 문짝을 치운다(false) / 되돌린다(true). 몸체를 직접 끄지 말고 이것으로 (레벨을 다시 붙일 때 되살아나지 않게) */
  setSolid(on: boolean): void {
    this.solid = on;
    this.applyBody();
  }

  private applyBody(): void {
    const b = this.body;
    if (!b) return;
    const on = this.solid && this.live;
    // 켤 때는 지금 열림 값 자리로 바로 옮긴다 (꺼져 있는 동안 set()한 열림도 반영)
    if (on && !b.isEnabled()) {
      const k = this.open * this.open * (3 - 2 * this.open);
      b.setTranslation({ x: this.move.x * k, y: this.move.y * k, z: this.move.z * k }, true);
    }
    b.setEnabled(on);
  }

  fixedUpdate(dt: number): void {
    if (this.open === this.target) return;
    const d = this.target - this.open;
    const step = this.speed * dt;
    this.open = Math.abs(d) <= step ? this.target : this.open + Math.sign(d) * step;
    const k = this.open * this.open * (3 - 2 * this.open);
    this.body?.setNextKinematicTranslation({ x: this.move.x * k, y: this.move.y * k, z: this.move.z * k });
    this.tmp.copy(this.home).addScaledVector(this.move, k);
    if (this.mesh.parent) this.mesh.parent.worldToLocal(this.tmp);
    this.mesh.position.copy(this.tmp);
    if (this.open === this.target) {
      const w = this.waiters;
      this.waiters = [];
      w.forEach((r) => r());
    }
  }
}

/**
 * 불러온 레벨 하나. 장면 전환(바깥 ↔ 실내 등)을 위해 붙이고 떼기(attach/detach)를 지원한다.
 * 만든 쪽: LevelLoader.buildLevel (glb든 코드로 만든 그레이박스든 같은 노드 규칙으로 읽는다)
 */
export class Level implements System {
  /** 지금 월드에 붙어 있는 레벨들 (attach/detach가 관리: 충돌체의 레벨을 찾을 때) */
  static readonly attachedLevels = new Set<Level>();
  readonly spawns = new Map<string, Marker>();
  readonly triggers = new Map<string, TriggerVolume>();
  readonly npcs: Marker[] = [];
  readonly waypoints = new Map<string, Marker>();
  readonly marks = new Map<string, Marker>();
  readonly props: Marker[] = [];
  /** 확장: LIGHT_<id> 노드 (켜고 끄는 등. glTF 조명이면 자식에 THREE.Light가 있다) */
  readonly lights = new Map<string, THREE.Object3D>();
  /** 확장: FX_<id> 마커 (연출 지점) */
  readonly fx: Marker[] = [];
  readonly doors = new Map<string, Door>();
  readonly rails = new Map<string, CamRailData>();
  readonly colliders: RAPIER.Collider[] = [];
  /** 충돌체 핸들 → 만든 노드와 종류 (mesh: 보이는 메시 트라이메시, col: COL_, box: collider="box", prop: 소품 트라이메시). 점검 도구용 */
  readonly colliderSource = new Map<number, { node: THREE.Object3D; kind: 'mesh' | 'col' | 'box' | 'prop' }>();
  /** 보이는 형상 (렌더 메시 BVH, level/visual.ts). 붙을 때 physics.visual에 넣고 뗄 때 뺀다 */
  visual: { set: StaticRaycastSet; registry: RaycastGeometry } | null = null;
  /** 캐릭터처럼 코드가 만드는 물체 (월드 좌표, 레벨과 함께 붙고 떨어진다) */
  readonly dynamic = new THREE.Group();
  /** 노드 이름 → 오브젝트 (findNode 빠른 길) */
  readonly nodes = new Map<string, THREE.Object3D>();
  readonly bounds = new THREE.Sphere();
  mixer: THREE.AnimationMixer | null = null;
  attached = false;
  /** 그레이박스 대체 레벨이면 true */
  placeholder = false;
  /** drift 속성(m/s, "x,y,z")이 있는 노드: 천천히 움직이는 배경 */
  readonly drifters: { object: THREE.Object3D; velocity: THREE.Vector3 }[] = [];
  /** spin 속성(도/s, "x,y,z")이 있는 노드: 도는 장식 */
  readonly spinners: { object: THREE.Object3D; rate: THREE.Vector3 }[] = [];
  /** 상태 노드 (state 속성: 'intact' / 'damaged' 등) */
  readonly stateNodes: THREE.Object3D[] = [];
  /** 지금 상태 (setState) */
  state = '';
  /** 레벨이 붙어 있는 동안 매 프레임 부를 함수 (연출 시스템) */
  readonly updaters: ((dt: number) => void)[] = [];

  constructor(
    readonly id: string,
    readonly root: THREE.Object3D,
    readonly env: LevelEnv,
    readonly source: string,
  ) {
    this.dynamic.name = `${id}_dynamic`;
  }

  /** 월드에 붙이고 환경(하늘, 안개, 주광, 반구광, 카메라 평면)을 적용한다 */
  private camera: THREE.Camera | null = null;
  private sky: { node: THREE.Object3D; base: THREE.Vector3; anchor: THREE.Vector3 } | null = null;

  attach(engine: Engine): void {
    if (this.attached) return;
    this.attached = true;
    Level.attachedLevels.add(this);
    this.camera = engine.camera;
    if (this.env.skyNode && !this.sky) {
      const node = this.node(this.env.skyNode);
      if (node) {
        // 원경 기준점: 노드의 처음 자리. 카메라가 움직인 만큼 같이 옮긴다
        this.sky = { node, base: node.position.clone(), anchor: node.getWorldPosition(new THREE.Vector3()) };
      }
    }
    engine.world.add(this.root);
    engine.world.add(this.dynamic);
    this.freezeStatic();
    for (const c of this.colliders) c.setEnabled(true);
    for (const d of this.doors.values()) d.setLive(true);
    this.visual?.registry.addStatic(this.visual.set);
    this.applyEnv(engine);
  }

  detach(engine: Engine): void {
    if (!this.attached) return;
    this.attached = false;
    Level.attachedLevels.delete(this);
    engine.world.remove(this.root);
    engine.world.remove(this.dynamic);
    setStaticActive(this.root, false);
    for (const c of this.colliders) c.setEnabled(false);
    for (const d of this.doors.values()) d.setLive(false);
    this.visual?.registry.removeStatic(this.visual.set);
  }

  /**
   * 움직이지 않는 노드의 행렬을 얼린다 (처음 붙을 때 한 번, render/staticMatrices.ts, docs/ENGINE.md '정적 행렬').
   * 움직이는 노드: 문·drift·spin·원경(skyNode)·glb 애니메이션 대상·MOVING_PROPS 속성 노드.
   * 그 밖에 코드가 옮기는 노드는 옮기기 전에 unfreeze(node)를 부른다 (빠뜨려도 점검이 찾아 푼다: 빌드는 몇 프레임 안, 개발 서버는 그 프레임에 경고).
   */
  private freezeStatic(): void {
    const moving = new Set<THREE.Object3D>();
    for (const d of this.doors.values()) moving.add(d.mesh);
    for (const d of this.drifters) moving.add(d.object);
    for (const s of this.spinners) moving.add(s.object);
    if (this.sky) moving.add(this.sky.node);
    freezeStatic(this.root, (o) => moving.has(o) || movesByProps(o), this.id);
  }

  applyEnv(engine: Engine): void {
    const e = this.env;
    const sky = e.sky ?? new THREE.Color(0x9cc3e0);
    engine.renderer.setClearColor(sky);
    engine.world.fog = e.fog ? new THREE.Fog(sky, e.fog[0], e.fog[1]) : null;
    if (e.sun) {
      engine.sun.position.copy(e.sun).normalize().multiplyScalar(60);
      engine.sun.target.position.set(0, 0, 0);
    }
    engine.sun.color.set(e.sunColor ?? DEFAULT_LIGHT.sun);
    engine.sun.intensity = e.sunIntensity ?? DEFAULT_LIGHT.sunIntensity;
    engine.world.traverse((o) => {
      const h = o as THREE.HemisphereLight;
      if (!h.isHemisphereLight) return;
      h.intensity = e.ambient ?? DEFAULT_LIGHT.ambient;
      h.color.set(e.hemiSky ?? DEFAULT_LIGHT.hemiSky);
      h.groundColor.set(e.hemiGround ?? DEFAULT_LIGHT.hemiGround);
    });
    const cam = engine.camera;
    const far = e.far ?? Math.max(600, this.bounds.radius * 2.5 + this.bounds.center.length());
    const near = e.near ?? 0.03;
    if (cam.far !== far || cam.near !== near) {
      cam.far = far;
      cam.near = near;
      cam.updateProjectionMatrix();
    }
  }

  spawn(id = 'start'): { position: THREE.Vector3; yaw: number } | null {
    const m = this.spawns.get(id);
    return m ? { position: m.position.clone(), yaw: m.yaw } : null;
  }

  /** WP 접두사로 경로점 목록 (이름순): path("course_mv") → WP_course_mv_01, _02 … */
  path(prefix: string): THREE.Vector3[] {
    return [...this.waypoints.values()]
      .filter((w) => w.id === prefix || w.id.startsWith(`${prefix}_`))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((w) => w.position.clone());
  }

  /** 여러 후보 이름 중 처음 있는 카메라 레일 (대소문자 무시, 정확히 같은 이름 → 포함하는 이름 순) */
  findRail(candidates: string[]): CamRailData | null {
    const all = [...this.rails.values()];
    for (const c of candidates) {
      const hit = all.find((r) => r.shot.toLowerCase() === c.toLowerCase());
      if (hit) return hit;
    }
    for (const c of candidates) {
      const hit = all.find((r) => r.shot.toLowerCase().includes(c.toLowerCase()));
      if (hit) return hit;
    }
    return null;
  }

  /** 접두사로 시작하는 레일 전부 (이름순): intro → intro_a, intro_b … */
  railsWithPrefix(prefix: string): CamRailData[] {
    const p = prefix.toLowerCase();
    return [...this.rails.values()]
      .filter((r) => r.shot.toLowerCase() === p || r.shot.toLowerCase().startsWith(`${p}_`))
      .sort((a, b) => a.shot.localeCompare(b.shot, undefined, { numeric: true }));
  }

  /** 상태 바꾸기: state 속성이 이 이름인 노드만 보인다 (예: 'damaged') */
  setState(name: string): void {
    this.state = name;
    for (const o of this.stateNodes) o.visible = String(o.userData.state) === name;
  }

  /** 아무 노드나 이름으로 (대소문자 무시 대체 검색 포함) */
  node(name: string): THREE.Object3D | null {
    const n = this.nodes.get(name);
    if (n) return n;
    const low = name.toLowerCase();
    for (const [k, v] of this.nodes) if (k.toLowerCase() === low) return v;
    return null;
  }

  fixedUpdate(dt: number): void {
    if (!this.attached) return;
    for (const d of this.doors.values()) d.fixedUpdate(dt);
  }

  update(dt: number): void {
    if (!this.attached) return;
    this.mixer?.update(dt);
    for (const d of this.drifters) d.object.position.addScaledVector(d.velocity, dt);
    for (const s of this.spinners) {
      s.object.rotation.x += s.rate.x * dt * (Math.PI / 180);
      s.object.rotation.y += s.rate.y * dt * (Math.PI / 180);
      s.object.rotation.z += s.rate.z * dt * (Math.PI / 180);
    }
    for (const u of this.updaters) u(dt);
    if (this.sky && this.camera) {
      const cam = this.camera.getWorldPosition(new THREE.Vector3());
      const offset = cam.sub(this.sky.anchor);
      if (this.sky.node.parent) {
        const inv = new THREE.Matrix3().setFromMatrix4(this.sky.node.parent.matrixWorld).invert();
        offset.applyMatrix3(inv);
      }
      this.sky.node.position.copy(this.sky.base).add(offset);
    }
  }
}

/**
 * 이 커스텀 속성(Blender)이 있는 노드는 코드가 움직인다: 얼리지 않는다 (Level.freezeStatic).
 * 게임이 새 움직임 속성을 만들면 여기에 더한다 (MOVING_PROPS.push('myProp')).
 */
export const MOVING_PROPS: string[] = [
  'dynamic', 'move', 'rotAxis', 'drift', 'spin',
  // 연출이 움직이는 노드에 흔히 쓰는 속성: 떨어짐, 쓸기(탐조등), 넘기기, 경첩, 문, 켜고 끄기, 깜빡임, 미끄러짐
  'fall', 'sweep', 'flipDeg', 'hinge', 'gate', 'toggle', 'flicker', 'alignYaw', 'slide',
];

function movesByProps(o: THREE.Object3D): boolean {
  const u = o.userData;
  for (const k of MOVING_PROPS) if (u[k] !== undefined) return true;
  return false;
}

/** 빈 오브젝트 → Marker */
export function toMarker(o: THREE.Object3D, id: string): Marker {
  o.updateWorldMatrix(true, false);
  const forward = forwardOf(o);
  return {
    name: o.name,
    id,
    object: o,
    position: o.getWorldPosition(new THREE.Vector3()),
    quaternion: o.getWorldQuaternion(new THREE.Quaternion()),
    forward,
    yaw: yawOf(forward),
    props: { ...o.userData },
  };
}

/** 루트·씬 userData에서 환경 속성 읽기 */
export function readEnv(...sources: (Record<string, unknown> | undefined)[]): LevelEnv {
  const env: LevelEnv = {
    sky: null, fog: null, sun: null, ambient: null, music: null, near: null, far: null, skyNode: null,
    sunColor: null, sunIntensity: null, hemiSky: null, hemiGround: null, timeOfDay: null,
  };
  const col = (v: unknown): THREE.Color | null => {
    const t = String(v).trim().replace(/^0x/i, '#');
    try {
      return new THREE.Color(/^[0-9a-f]{6}$/i.test(t) ? `#${t}` : t);
    } catch {
      return null;
    }
  };
  for (const s of sources) {
    if (!s) continue;
    const has = (k: string) => s[k] !== undefined && s[k] !== null && s[k] !== '';
    if (has('sky') && !env.sky) {
      const v = String(s.sky).trim().replace(/^0x/i, '#');
      try {
        env.sky = new THREE.Color(/^[0-9a-f]{6}$/i.test(v) ? `#${v}` : v);
      } catch {
        // 무시
      }
    }
    if (has('fog') && !env.fog) {
      const p = String(s.fog).split(/[,\s]+/).map(Number);
      if (p.length >= 2 && p.every(Number.isFinite)) env.fog = [p[0], p[1]];
    }
    if (has('sun') && !env.sun) env.sun = vec3(s, 'sun');
    if (has('ambient') && env.ambient === null) env.ambient = num(s, 'ambient', 1.5);
    if (has('music') && !env.music) env.music = str(s, 'music') ?? null;
    if (has('near') && env.near === null) env.near = num(s, 'near', 0.03);
    if (has('far') && env.far === null) env.far = num(s, 'far', 600);
    if (has('camNear') && env.near === null) env.near = num(s, 'camNear', 0.03);
    if (has('camFar') && env.far === null) env.far = num(s, 'camFar', 600);
    if (has('skyNode') && !env.skyNode) env.skyNode = str(s, 'skyNode') ?? null;
    if (has('sunColor') && !env.sunColor) env.sunColor = col(s.sunColor);
    if (has('sunIntensity') && env.sunIntensity === null) env.sunIntensity = num(s, 'sunIntensity', DEFAULT_LIGHT.sunIntensity);
    if (has('hemiSky') && !env.hemiSky) env.hemiSky = col(s.hemiSky);
    if (has('hemiGround') && !env.hemiGround) env.hemiGround = col(s.hemiGround);
    if (has('timeOfDay') && !env.timeOfDay) env.timeOfDay = str(s, 'timeOfDay') ?? null;
  }
  return env;
}
