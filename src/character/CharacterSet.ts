import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import type { Physics } from '../physics/Physics';
import type { Level } from '../level/Level';
import { str } from '../level/props';
import { animBudget } from './animBudget';
import { MeshGround, RapierGround, type GroundProbe } from './ground';
import { Character, type CharacterOptions } from './Character';

const _c = new THREE.Vector3();

/**
 * 레벨의 NPC_<id> 마커에서 캐릭터를 만들고 갱신한다.
 * 마커 커스텀 속성: model(인물 glb), fallback(없을 때 쓸 glb), pose(기본 자세), look('camera' | 캐릭터 id | 'none'), name(표시 이름),
 *   path(경로점 접두사: pathOf로 읽는다)
 * 모델 대체 순서: model → fallback → CharacterSetOptions.defaultModel → 캡슐 (placeholderCharacter)
 */
export interface CharacterSetOptions {
  /** 마커에 모델이 없거나 못 읽었을 때 쓸 glb (모델 기준 경로) */
  defaultModel?: string;
  /** 캐릭터마다 넘길 옵션 (높이·반지름 등) */
  character?: Omit<CharacterOptions, 'name' | 'pose'>;
}

/** 세트: 충돌체 없이 읽은 장면 (loadLevel physics:false). 이 캐릭터들은 땅 붙이기가 기본으로 켜진다 (보이는 메시 BVH) */
const isSet = (level: Level) => level.colliders.length === 0;
/** ?charground=0: 세트 캐릭터도 땅에 붙이지 않는다 (경로점 높이 그대로. 전후 비교용) */
const SET_GROUND = typeof location === 'undefined' || new URLSearchParams(location.search).get('charground') !== '0';

export class CharacterSet {
  readonly all = new Map<string, Character>();
  private readonly levelOf = new Map<Character, Level>();
  /** 카메라 눈 위치 (look: 'camera') */
  cameraEye: () => THREE.Vector3 = () => new THREE.Vector3();
  /** 로드된 모델 경로 (보고용) */
  readonly sources = new Map<string, string>();
  /** 레벨마다 땅 질의 (character/ground.ts) */
  private readonly grounds = new WeakMap<Level, GroundProbe>();
  private readonly paths = new Map<string, string>();

  constructor(
    private readonly assets: Assets,
    private readonly physics: Physics | null,
    private readonly opts: CharacterSetOptions = {},
  ) {}

  private async loadModel(paths: (string | null | undefined)[]): Promise<{ model: THREE.Object3D | null; used: string }> {
    const want = [...paths, this.opts.defaultModel].filter((x): x is string => !!x);
    for (const path of want) {
      const inst = await this.assets.instance(path);
      if (inst) return { model: inst.root, used: path };
    }
    return { model: null, used: 'placeholder' };
  }

  /**
   * 레벨의 NPC_ 마커 전부 (onEach로 진행 표시). tick을 주면 인물마다 부른다 (프레임 예산 안에서 나눠 만들기).
   * 같은 id가 다른 레벨에 또 있어도 된다: 찾을 때는 붙어 있는 레벨을 먼저 본다.
   */
  async spawnFromLevel(level: Level, onEach?: (done: number, total: number) => void, tick?: () => Promise<void>): Promise<void> {
    const total = level.npcs.length;
    let done = 0;
    // 세트(충돌체 없이 읽은 장면)는 캐릭터를 땅에 붙인다: 인물·경로점 아래 땅 메시의 BVH를 미리 만든다
    const ground = SET_GROUND && isSet(level) ? await this.prepareGround(level, tick) : null;
    for (const mk of level.npcs) {
      await tick?.();
      const { model, used } = await this.loadModel([str(mk.object, 'model'), str(mk.object, 'fallback')]);
      const ch = new Character(mk.id, model, this.physics, {
        ...this.opts.character,
        name: str(mk.object, 'name') ?? mk.id,
        pose: str(mk.object, 'pose') ?? 'idle',
      });
      level.dynamic.add(ch.root);
      ch.groundSpace = level.dynamic;
      ch.ground = ground;
      ch.place(mk.position, mk.yaw);
      this.all.set(mk.id, ch);
      this.levelOf.set(ch, level);
      this.sources.set(mk.id, used);
      ch.collider?.setEnabled(level.attached);
      onEach?.(++done, total);
    }
    // 시선 대상 연결 (다른 캐릭터를 볼 수 있으니 전부 만든 뒤, 같은 레벨 안에서 찾는다)
    for (const mk of level.npcs) {
      const ch = this.inLevel(level, mk.id);
      if (!ch) continue;
      const look = str(mk.object, 'look') ?? 'none';
      const other = look !== 'none' && look !== 'camera' ? this.inLevel(level, look) : null;
      if (other) ch.look = () => other.eyeWorld(new THREE.Vector3());
      else this.setLook(ch, look);
      const path = str(mk.object, 'path');
      if (path) this.paths.set(mk.id, path);
    }
  }

  /** 레벨 마커 없이 캐릭터 하나. models: 차례로 시도할 glb (없으면 기본 모델, 그것도 없으면 캡슐) */
  async spawn(level: Level, id: string, models: string[], pos: THREE.Vector3, yaw: number, opts: CharacterOptions = {}): Promise<Character> {
    const { model, used } = await this.loadModel(models);
    const ch = new Character(id, model, this.physics, { ...this.opts.character, ...opts, name: opts.name ?? id, pose: opts.pose ?? 'idle' });
    level.dynamic.add(ch.root);
    ch.groundSpace = level.dynamic;
    ch.ground = SET_GROUND && isSet(level) ? this.groundOf(level) : null;
    ch.place(pos, yaw);
    this.all.set(id, ch);
    this.levelOf.set(ch, level);
    this.sources.set(id, used);
    ch.collider?.setEnabled(level.attached);
    return ch;
  }

  /** 이미 만든 캐릭터를 레벨에 넣는다 (코드로 만든 모델 등) */
  add(level: Level, ch: Character): Character {
    level.dynamic.add(ch.root);
    ch.groundSpace = level.dynamic;
    this.all.set(ch.id, ch);
    this.levelOf.set(ch, level);
    this.sources.set(ch.id, 'external');
    ch.collider?.setEnabled(level.attached);
    return ch;
  }

  /**
   * 레벨의 땅 질의 (character/ground.ts, 레벨마다 하나). 충돌체가 있는 레벨은 고정 충돌체 레이(Rapier), 세트는 보이는 메시 BVH.
   * 충돌체가 있는 레벨의 캐릭터를 땅에 붙이려면 followGround(ch)
   */
  groundOf(level: Level): GroundProbe {
    let g = this.grounds.get(level);
    if (!g) {
      g = isSet(level) || !this.physics ? new MeshGround(level.root, { skyNode: level.env.skyNode }) : new RapierGround(this.physics);
      this.grounds.set(level, g);
    }
    return g;
  }

  /**
   * 캐릭터를 그 레벨 땅에 붙인다 (on=false면 끈다: 경로점 높이를 그대로). 걷는 동안과 서 있는 자세의 place()에만 쓰고,
   * 탈것에 태우면(root 부모가 레벨 dynamic이 아니면) 쉰다. 세트 캐릭터는 처음부터 켜져 있다
   */
  followGround(ch: Character, on = true): void {
    const level = this.levelOf.get(ch);
    ch.ground = on && level ? this.groundOf(level) : null;
    ch.groundSpace = level?.dynamic ?? null;
  }

  /** 세트의 땅: 인물 마커·경로점·표시점 아래 메시의 BVH를 미리 (tick마다 하나) */
  private async prepareGround(level: Level, tick?: () => Promise<void>): Promise<GroundProbe> {
    const g = this.groundOf(level);
    if (g instanceof MeshGround) {
      const pts = [...level.npcs, ...level.waypoints.values(), ...level.marks.values()].map((m) => m.position);
      await g.prepare(pts, tick);
    }
    return g;
  }

  /** 마커의 path 속성 (경로점 접두사, level.path(prefix)로 점을 얻는다) */
  pathOf(id: string): string | null {
    return this.paths.get(id) ?? null;
  }

  setLook(ch: Character, look: string | null): void {
    if (!look || look === 'none') ch.look = null;
    else if (look === 'camera') ch.look = () => this.cameraEye();
    else {
      const other = this.get(look);
      ch.look = other ? () => other.eyeWorld(new THREE.Vector3()) : null;
    }
  }

  /**
   * id로 찾기 (대소문자 무시, 접두사 일치 허용: 'guide' → 'guide_01').
   * 붙어 있는 레벨의 보이는 캐릭터 → 붙어 있는 레벨 → 전체 순으로 찾는다 (같은 id가 여러 세트에 있을 때)
   */
  get(id: string): Character | null {
    const low = id.toLowerCase();
    const match = (n: Character, prefix: boolean) => (prefix ? n.id.toLowerCase().startsWith(low) : n.id.toLowerCase() === low);
    const tiers: ((n: Character, l: Level) => boolean)[] = [(n, l) => l.attached && n.root.visible, (_n, l) => l.attached];
    for (const ok of tiers) {
      for (const prefix of [false, true]) {
        for (const [n, l] of this.levelOf) if (ok(n, l) && match(n, prefix)) return n;
      }
    }
    const n = this.all.get(id);
    if (n) return n;
    for (const [k, v] of this.all) if (k.toLowerCase() === low) return v;
    for (const [k, v] of this.all) if (k.toLowerCase().startsWith(low)) return v;
    return null;
  }

  /** 한 레벨 안에서 id로 (정확히 → 접두사) */
  inLevel(level: Level, id: string): Character | null {
    const low = id.replace(/^NPC_/, '').toLowerCase();
    let pre: Character | null = null;
    for (const [n, l] of this.levelOf) {
      if (l !== level) continue;
      const k = n.id.toLowerCase();
      if (k === low) return n;
      if (!pre && k.startsWith(low)) pre = n;
    }
    return pre;
  }

  /** 모든 레벨의 캐릭터 (all은 id마다 마지막에 읽은 것만 든다: 같은 id가 여러 레벨에 있어도 전부) */
  every(): Character[] {
    return [...new Set([...this.levelOf.keys(), ...this.all.values()])];
  }

  /** 레벨의 캐릭터 전부 */
  ofLevel(level: Level): Character[] {
    return [...this.levelOf].filter(([, l]) => l === level).map(([n]) => n);
  }

  /** 레벨을 버릴 때: 그 레벨의 캐릭터를 지운다 (충돌체 포함) */
  removeLevel(level: Level): void {
    this.grounds.delete(level);
    for (const [n, l] of [...this.levelOf]) {
      if (l !== level) continue;
      this.levelOf.delete(n);
      if (this.all.get(n.id) === n) this.all.delete(n.id);
      n.dispose();
    }
  }

  /** 레벨 장면 전환 때 충돌체를 켜고 끈다 */
  syncColliders(): void {
    for (const [ch, level] of this.levelOf) ch.collider?.setEnabled(level.attached && ch.root.visible);
  }

  /** 지점에 가장 가까운 캐릭터 (조건 함수로 거르기) */
  nearest(p: THREE.Vector3, filter: (id: string, n: Character) => boolean = () => true): Character | null {
    let best: Character | null = null;
    let bd = Infinity;
    for (const [id, n] of this.all) {
      if (!filter(id, n) || !n.root.visible) continue;
      const level = this.levelOf.get(n);
      if (level && !level.attached) continue;
      const d = n.root.position.distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  /** 매 렌더 프레임. 걷기(자리)는 매 프레임, 얼굴·자세는 애니메이션 예산으로 (character/animBudget.ts) */
  update(dt: number, camera: THREE.Camera): void {
    if (!animBudget.enabled) {
      // 예산을 끈 단순 규칙 (?animbudget=0): 30 m 밖 캐릭터는 무작위로 반을 건너뛰고 2배 dt로
      const t0 = performance.now();
      let n = 0;
      let skip = 0;
      for (const [ch, level] of this.levelOf) {
        if (!level.attached || !ch.root.visible) continue;
        const far = ch.root.position.distanceToSquared(camera.position) > 30 * 30;
        if (far && Math.random() < 0.5) {
          skip++;
          continue;
        }
        n++;
        ch.update(far ? dt * 2 : dt);
      }
      animBudget.account(this, 'characters', performance.now() - t0, n, skip);
      return;
    }
    const plan = animBudget.plan<Character>(this, 'characters', camera, dt);
    for (const [ch, level] of this.levelOf) {
      if (!level.attached || !ch.root.visible) continue;
      ch.move(dt);
      _c.setFromMatrixPosition(ch.root.matrixWorld);
      // 화면 판정 구: 키의 0.6배 높이, 반지름은 키에 비례 (최소 1 m)
      _c.y += 0.6 * ch.height;
      plan.add(ch, ch, _c, Math.max(1, ch.height * 0.9), ch.talking);
    }
    plan.run((ch, step) => ch.animate(step));
  }
}
