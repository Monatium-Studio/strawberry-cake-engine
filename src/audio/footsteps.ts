import * as THREE from 'three';
import type { AudioEngine } from './Audio';
import { Character } from '../character/Character';
import type { RaycastGeometry } from '../physics/RaycastGeometry';

/**
 * 캐릭터 발소리.
 * - 박자: 캐릭터 걷기 위상이 발 딛는 자리(π/2 + kπ)를 지날 때 Character.stepListeners가 부른다. 걷기 위상은 애니메이션 예산이
 *   캐릭터를 갱신하는 주기에 따라 움직이므로 발소리도 그 주기에 맞춰 난다. 여기서 따로 캐릭터를 돌지 않는다.
 * - 걸음새: 달리기(속도 2.2 m/s 넘음·달리는 자세), 웅크려 걷기(웅크린 자세), 걷기. 크기·피치가 다르고, 달리면 extra 큐를 가끔 더한다.
 * - 바닥: 발밑을 보이는 형상(physics.visual BVH)으로 아래로 쏴서, 맞은 메시의 노드 속성(step·surface, 조상까지)과
 *   머티리얼 이름으로 표면을 고른다. 캐릭터마다 1.5 m 움직이거나 3초가 지나야 다시 쏜다. 보이는 형상이 없는 장면은
 *   월드의 넓은 바닥 메시를 three Raycaster로 쏜다 (초당 4번까지).
 * - 예산: cutoff 밖은 내지 않는다. 최근 1.2초 안에 디딘 캐릭터를 0.25초마다 거리순으로 세워 가까운 budget명만 낸다.
 *   초당 재생 수도 budget × 3으로 막는다.
 * - 큐 이름은 게임이 정한다 (cueOf): 기본은 `step_<surface>`, extra는 없음.
 *
 *   const steps = new CharacterFootsteps(audio, (out) => out.copy(camera.position), { visual: physics.visual, world: engine.world });
 *   steps.hook();               // Character 발 디딤을 듣는다
 *   engine.add({ update: (dt) => steps.update(dt) });
 */

export type StepSurface = 'asphalt' | 'concrete' | 'dirt' | 'grass' | 'metal' | 'wood' | 'water';
export type Gait = 'walk' | 'run' | 'crouch';
export const STEP_SURFACES: StepSurface[] = ['asphalt', 'concrete', 'dirt', 'grass', 'metal', 'wood', 'water'];

/** 바닥 머티리얼 이름 → 발소리 표면 */
const BY_NAME: [RegExp, StepSurface][] = [
  [/water|puddle|pond|river|lake|ocean/, 'water'],
  [/asphalt|tarmac|road|street|highway/, 'asphalt'],
  [/concrete|pave|stone|marble|tile|brick|slab|curb/, 'concrete'],
  [/grass|turf|lawn|hedge|meadow|moss|crop|wheat|leaf|foliage/, 'grass'],
  [/dirt|soil|mud|earth|sand|gravel|rubble|ash|field|track|trail|clay/, 'dirt'],
  [/metal|steel|iron|grate|grating|hull|plate|tread|catwalk|rail/, 'metal'],
  [/wood|plank|plywood|timber|board|crate|pallet|deck|parquet/, 'wood'],
];
/** 보이는 형상 표면 태그({ surface }, level/visual.ts) → 발소리 표면 (이름으로 못 정할 때) */
const BY_TAG: Record<string, StepSurface> = { concrete: 'concrete', dirt: 'dirt', metal: 'metal', wood: 'wood', water: 'water', glass: 'concrete', cloth: 'wood' };

export function stepSurfaceFromName(name: string): StepSurface | null {
  const n = name.toLowerCase();
  for (const [re, s] of BY_NAME) if (re.test(n)) return s;
  return null;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const _o = new THREE.Vector3();
const _p = new THREE.Vector3();
const _box = new THREE.Box3();

/** 맞은 메시의 발소리 표면: 노드 커스텀 속성 step(발소리 전용) → surface를 조상까지 찾고, 없으면 머티리얼 이름 → 표면 태그 */
function surfaceOfMesh(obj: THREE.Object3D, owner: unknown): StepSurface {
  for (let x: THREE.Object3D | null = obj, i = 0; x && i < 8; x = x.parent, i++) {
    const u = x.userData ?? {};
    if (typeof u.step === 'string' && (STEP_SURFACES as string[]).includes(u.step)) return u.step as StepSurface;
    if (typeof u.surface === 'string' && u.surface) return stepSurfaceFromName(u.surface) ?? BY_TAG[u.surface] ?? 'concrete';
  }
  const mesh = obj as THREE.Mesh;
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const byName = mat?.name ? stepSurfaceFromName(mat.name) : null;
  if (byName) return byName;
  const tag = (owner as { surface?: string } | null)?.surface;
  return (tag && BY_TAG[tag]) || 'concrete';
}

/** 노드나 조상(8단계까지)에 발소리 표면 속성 step이 있는가 */
function stepTagged(obj: THREE.Object3D): boolean {
  for (let x: THREE.Object3D | null = obj, i = 0; x && i < 8; x = x.parent, i++) {
    const st = x.userData?.step;
    if (typeof st === 'string' && (STEP_SURFACES as string[]).includes(st)) return true;
  }
  return false;
}

/** 발밑 표면: 보이는 형상(레벨 BVH)을 아래로 쏜다. 형상이 없거나 아무것도 안 맞으면 null */
export function probeSurface(visual: RaycastGeometry | null, p: THREE.Vector3): StepSurface | null {
  if (!visual?.size) return null;
  const hit = visual.raycast(_o.set(p.x, p.y + 0.6, p.z), DOWN, 1.8);
  return hit ? surfaceOfMesh(hit.object, hit.owner) : null;
}

/**
 * 보이는 형상이 없는 장면의 바닥: 월드에서 바닥 이름 머티리얼을 쓰거나 조상에 step 속성이 있는 넓은(가로 4 m 넘는) 메시만 모아
 * three Raycaster로 아래로 쏜다. 모음은 10초마다(월드가 바뀌면 바로) 다시 만들고, 쏘기는 초당 4번까지 (넘으면 null)
 */
class GroundFallback {
  private list: THREE.Mesh[] = [];
  private world: THREE.Object3D | null = null;
  private at = -99;
  private sec = -99;
  private used = 0;
  private readonly ray = new THREE.Raycaster();
  probe(world: THREE.Object3D | null, p: THREE.Vector3, now: number): StepSurface | null {
    if (!world) return null;
    if (now - this.sec >= 1) {
      this.sec = now;
      this.used = 0;
    }
    if (this.used >= 4) return null;
    this.used++;
    if (world !== this.world || now - this.at > 10) this.collect(world, now);
    if (!this.list.length) return null;
    this.ray.set(_o.set(p.x, p.y + 0.8, p.z), DOWN);
    this.ray.far = 2.2;
    const hit = this.ray.intersectObjects(this.list, false)[0];
    return hit ? surfaceOfMesh(hit.object, null) : null;
  }
  private collect(world: THREE.Object3D, now: number): void {
    this.world = world;
    this.at = now;
    this.list = [];
    world.updateMatrixWorld();
    world.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.isOutline || (m as THREE.SkinnedMesh).isSkinnedMesh || (m as THREE.InstancedMesh).isInstancedMesh) return;
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      // 바닥 이름 머티리얼, 또는 조상 노드의 step 속성 (정점 색으로 합친 묶음은 머티리얼 이름이 첫 메시 것이라 바닥을 못 알아본다)
      if (!stepTagged(m) && (!mat?.name || !stepSurfaceFromName(mat.name))) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      _box.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
      if (_box.max.x - _box.min.x < 4 && _box.max.z - _box.min.z < 4) return;
      this.list.push(m);
    });
  }
}

/** 걸음새: 자세 이름과 걷기 속도로 */
export function gaitOf(ch: Character): Gait {
  const pose = ch.poseName;
  if (/crouch|cower|sneak|kneel/.test(pose)) return 'crouch';
  if (ch.walkSpeed > 2.2 || /run|sprint/.test(pose)) return 'run';
  return 'walk';
}

/** 걸음새별 크기·피치·extra 큐 확률 (파일은 걷기 기준) */
export const GAIT: Record<Gait, { vol: number; rate: number; extra: number }> = {
  walk: { vol: 0.75, rate: 1, extra: 0 },
  run: { vol: 1.1, rate: 1.06, extra: 0.45 },
  crouch: { vol: 0.38, rate: 0.94, extra: 0 },
};

export interface FootstepOptions {
  /** 보이는 형상 (physics.visual). 없으면 world 바닥 메시로 */
  visual?: RaycastGeometry | null;
  /** 보이는 형상이 없을 때 바닥 메시를 찾을 월드 (engine.world) */
  world?: THREE.Object3D | null;
  /** 표면·걸음새 → 큐 이름 (null이면 내지 않는다). 기본 `step_<surface>` */
  cueOf?: (surface: StepSurface, gait: Gait) => string | null;
  /** 달릴 때 가끔 더하는 큐 (장비 짤랑임 등). 없으면 내지 않는다 */
  extraCue?: string | null;
}

interface Probe {
  x: number;
  z: number;
  t: number;
  s: StepSurface;
}

export class CharacterFootsteps {
  /** 동시에 발소리를 내는 캐릭터 수 (가까운 순) */
  budget = 6;
  /** 이보다 먼 캐릭터는 내지 않는다 (m). 끝 25 %에서 서서히 줄인다 */
  cutoff = 30;
  enabled = true;
  /** 0 ~ 1: 듣는 쪽(사용자 캐릭터)이 움직이는 정도. 움직이는 동안 다른 발소리를 25 %까지 줄인다 */
  listenerMoving = 0;
  visual: RaycastGeometry | null;
  world: THREE.Object3D | null;
  readonly stats = {
    steps: 0,
    played: 0,
    far: 0,
    /** 가까운 순 예산 밖이라 거른 수 */
    overBudget: 0,
    rate: 0,
    probes: 0,
    /** 보이는 형상이 없어 바닥 메시로 판정한 수 */
    fallback: 0,
    extra: 0,
    bySurface: {} as Record<string, number>,
    byGait: {} as Record<string, number>,
    /** 지금 순위 문턱 (m, 예산이 넉넉하면 null) */
    threshold: null as number | null,
    /** 최근 1.2초 안에 디딘 캐릭터 수 */
    stepping: 0,
    /** 발소리 처리에 쓴 시간 합 (ms) */
    ms: 0,
  };
  private readonly ground = new GroundFallback();
  private readonly recent = new Map<Character, { d2: number; t: number }>();
  private threshold2 = Infinity;
  private rankT = 0;
  private readonly probes = new WeakMap<Character, Probe>();
  private readonly window: number[] = [];
  private readonly ear = new THREE.Vector3();
  private readonly cueOf: (surface: StepSurface, gait: Gait) => string | null;
  private readonly extraCue: string | null;
  private readonly hookFn = (ch: Character): void => this.onStep(ch);

  constructor(
    private readonly a: AudioEngine,
    /** 듣는 자리 (보통 카메라 위치) */
    private readonly listenerOf: (out: THREE.Vector3) => THREE.Vector3,
    opts: FootstepOptions = {},
  ) {
    this.visual = opts.visual ?? null;
    this.world = opts.world ?? null;
    this.cueOf = opts.cueOf ?? ((s) => `step_${s}`);
    this.extraCue = opts.extraCue ?? null;
  }

  /** Character 발 디딤 이벤트에 건다 */
  hook(): void {
    Character.stepListeners.add(this.hookFn);
  }

  /** 떼고 기록을 비운다 (장면을 걷을 때: 지난 판의 캐릭터를 붙잡지 않게) */
  reset(): void {
    Character.stepListeners.delete(this.hookFn);
    this.recent.clear();
    this.threshold2 = Infinity;
  }

  private now(): number {
    return this.a.ctx.currentTime || performance.now() / 1000;
  }

  /** 캐릭터 발밑 표면 (1.5 m 움직이거나 3초가 지나야 다시 쏜다) */
  surfaceAt(ch: Character, pos: THREE.Vector3): StepSurface {
    const pr = this.probes.get(ch);
    const t = performance.now() / 1000;
    if (pr && Math.abs(pr.x - pos.x) + Math.abs(pr.z - pos.z) < 1.5 && t - pr.t < 3) return pr.s;
    this.stats.probes++;
    const s = this.probe(pos, t) ?? pr?.s ?? 'concrete';
    this.probes.set(ch, { x: pos.x, z: pos.z, t, s });
    return s;
  }

  /** 아무 자리의 발밑 표면 (사용자 캐릭터 발소리 등). 결과를 기억해 두지 않는다 */
  surfaceUnder(feet: THREE.Vector3): StepSurface {
    this.stats.probes++;
    return this.probe(_p.copy(feet), performance.now() / 1000) ?? 'concrete';
  }

  /** 발 하나 (Character.stepListeners) */
  onStep(ch: Character): void {
    if (!this.enabled) return;
    const t0 = performance.now();
    this.stats.steps++;
    try {
      const p = ch.root.getWorldPosition(_p);
      const ear = this.listenerOf(this.ear);
      const d2 = p.distanceToSquared(ear);
      const now = this.now();
      const cutoff = this.cutoff;
      if (d2 > cutoff * cutoff) {
        this.stats.far++;
        return;
      }
      this.recent.set(ch, { d2, t: now });
      if (d2 > this.threshold2) {
        this.stats.overBudget++;
        return;
      }
      // 초당 재생 수 상한 (순위 문턱을 다시 잡기 전, 무리가 한꺼번에 나타날 때)
      while (this.window.length && now - this.window[0] > 1) this.window.shift();
      if (this.window.length >= this.budget * 3) {
        this.stats.rate++;
        return;
      }
      const gait = gaitOf(ch);
      const g = GAIT[gait];
      const surface = this.surfaceAt(ch, p);
      const cue = this.cueOf(surface, gait);
      if (!cue) return;
      this.window.push(now);
      const d = Math.sqrt(d2);
      const edge = 1 - THREE.MathUtils.smoothstep(d, cutoff * 0.75, cutoff);
      const vol = g.vol * edge * (1 - 0.25 * this.listenerMoving);
      p.y += 0.05;
      this.a.play(cue, { position: p, volume: vol, rate: g.rate });
      this.stats.played++;
      this.stats.bySurface[surface] = (this.stats.bySurface[surface] ?? 0) + 1;
      this.stats.byGait[gait] = (this.stats.byGait[gait] ?? 0) + 1;
      if (this.extraCue && g.extra && Math.random() < g.extra) {
        this.a.play(this.extraCue, { position: p, volume: vol * 0.8, delay: 0.02 + Math.random() * 0.03 });
        this.stats.extra++;
      }
    } finally {
      this.stats.ms += performance.now() - t0;
    }
  }

  /** 매 프레임: 0.25초마다 거리 순위 문턱 */
  update(dt: number): void {
    const now = this.now();
    this.rankT -= dt;
    if (this.rankT > 0) return;
    this.rankT = 0.25;
    const ds: number[] = [];
    for (const [n, r] of this.recent) {
      if (now - r.t > 1.2 || !n.root.visible) this.recent.delete(n);
      else ds.push(r.d2);
    }
    this.stats.stepping = ds.length;
    if (ds.length <= this.budget) {
      this.threshold2 = Infinity;
      this.stats.threshold = null;
    } else {
      ds.sort((x, y) => x - y);
      this.threshold2 = ds[this.budget - 1] + 1e-3;
      this.stats.threshold = +Math.sqrt(this.threshold2).toFixed(1);
    }
  }

  /** 보이는 형상 → (없으면) 바닥 메시 대체 판정 */
  private probe(p: THREE.Vector3, t: number): StepSurface | null {
    if (this.visual?.size) return probeSurface(this.visual, p);
    this.stats.fallback++;
    return this.ground.probe(this.world, p, t);
  }
}
