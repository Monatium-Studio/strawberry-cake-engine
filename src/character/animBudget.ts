import * as THREE from 'three';

/**
 * 캐릭터 애니메이션 갱신 예산 (Unreal Animation Budget Allocator 기본값을 따른다).
 *
 * 여러 곳(CharacterSet, 게임이 따로 돌리는 캐릭터 무리)의 자세 갱신(Character.animate: 자세 섞기·팔 IK·얼굴)을
 * 프레임당 ms 예산 하나로 묶는다. 갱신하는 쪽(자리)마다 이번 프레임의 후보를 모아 run()으로 넘기면 예산이 고른 것만 갱신하고,
 * 나머지는 미룬 시간(dt)을 모아 다음에 한 번에 넘긴다 (자세 전환은 같은 때 끝난다).
 *
 * - 매 프레임 (예산과 상관없이): 처음 나타난 캐릭터, 화면 안 15 m 안, 화면 안 바쁜(engaged) 25 m 안 → 가까운 자세가 끊기지 않는다
 * - 나머지는 중요도(화면 안, 가까움, 바쁨) 순으로 예산이 남는 만큼. 거리에 따라 2~4프레임에 한 번을 기본으로 하고,
 *   예산이 모자라면 더 미룬다. 화면 안이면 아무리 밀려도 10프레임에 한 번은 (MaxTickRate 10)
 * - 화면 밖은 프레임당 4개까지만 (MaxTickedOffscreen 4), 오래 기다린 것부터 (라운드 로빈)
 * - 비용은 항목마다 EMA로 잰다 (처음은 그 자리의 평균). 예산 판단은 '지금까지 쓴 ms + 이 항목 예상 ms ≤ 예산'
 * - 프레임 경계: 자리(site)가 이번 프레임에 두 번째로 부르면 새 프레임이다 (자리마다 프레임에 한 번 부른다)
 *
 * URL `?animbudget=<ms>` (기본 1.0), `?animbudget=0`이면 끈다(각 자리의 단순 규칙: 예를 들어 30 m 밖 무작위 반).
 * 점검: `animBudget.stats()` · `.resetStats()`
 */

/** 화면 안 이 거리(m) 안은 매 프레임 */
const NEAR = 15;
/** 바쁘면(engaged: 대화·상호작용 중) 화면 안 이 거리까지 매 프레임 */
const ENGAGED_NEAR = 25;
/** 가장 덜 중요한 화면 안 캐릭터도 이 프레임마다 한 번은 */
const MAX_INTERVAL = 10;
/** 화면 밖은 프레임당 이만큼만 */
const MAX_OFFSCREEN = 4;
/** 화면 밖 기본 간격 (프레임) */
const OFFSCREEN_INTERVAL = 4;
/** 통계 창 (프레임) */
const WINDOW = 600;

interface Slot {
  /** 미룬 시간 (s) */
  lag: number;
  /** 마지막 갱신 뒤 지난 프레임 */
  since: number;
  /** 갱신 비용 EMA (ms) */
  cost: number;
  /** 마지막으로 후보에 든 프레임 (그 사이 빠졌으면 처음 나타난 것으로 본다) */
  seen: number;
  /** 갱신 횟수 */
  n: number;
}

interface Entry<T> {
  item: T;
  key: object;
  x: number;
  y: number;
  z: number;
  r: number;
  engaged: boolean;
  force: boolean;
  rest: boolean;
  // 분류 (run에서 채움)
  slot: Slot | null;
  vis: boolean;
  dist: number;
  sig: number;
  base: number;
  must: boolean;
  done: boolean;
}

/** 거리·화면 구분별 갱신 간격 통계 */
type Tier = 'near' | 'mid' | 'far' | 'off';

export interface AnimBudgetStats {
  enabled: boolean;
  budgetMs: number;
  frames: number;
  /** 프레임당 애니메이션 갱신에 쓴 ms */
  ms: { avg: number; p50: number; p95: number; max: number };
  /** 프레임당 평균: 갱신 수, 그중 반드시 갱신, 미룬 수, 화면 밖 갱신 */
  perFrame: { updates: number; must: number; deferred: number; offscreen: number };
  /** 갱신 사이 평균 간격 (프레임): 화면 안 15 m 안 · 15~40 m · 40 m 밖 · 화면 밖 */
  gap: Record<Tier, number>;
  /** 화면 안 15 m 안인데 이번 프레임에 갱신하지 않은 경우 (0이어야 한다) */
  nearStale: number;
  bySite: Record<string, { updates: number; deferred: number; ms: number }>;
}

const now = (): number => performance.now();

function readParam(): number {
  try {
    const v = new URLSearchParams(location.search).get('animbudget');
    if (v === null || v === '') return 1.0;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 1.0;
  } catch {
    return 1.0;
  }
}

const _sphere = new THREE.Sphere();
const _m = new THREE.Matrix4();
const _cam = new THREE.Vector3();

export class AnimBudget {
  /** 프레임당 예산 (ms) */
  budgetMs: number;
  /** false면 각 자리가 예전 규칙으로 돈다 (비교용) */
  enabled: boolean;

  private frame = 0;
  private readonly sitesThisFrame = new Set<object>();
  private readonly slots = new WeakMap<object, Slot>();
  private readonly plans = new WeakMap<object, AnimPlan<unknown>>();
  private readonly frustum = new THREE.Frustum();
  private frustumCam: THREE.Camera | null = null;
  private frustumFrame = -1;
  readonly camPos = new THREE.Vector3();

  // 이번 프레임
  private spent = 0;
  private upd = 0;
  private must = 0;
  private deferred = 0;
  private offUpd = 0;

  // 통계
  private readonly hist = new Float32Array(WINDOW);
  private histN = 0;
  private frames = 0;
  private sum = { upd: 0, must: 0, deferred: 0, off: 0, ms: 0 };
  private maxMs = 0;
  private readonly gapSum: Record<Tier, number> = { near: 0, mid: 0, far: 0, off: 0 };
  private readonly gapN: Record<Tier, number> = { near: 0, mid: 0, far: 0, off: 0 };
  private nearStale = 0;
  private readonly siteStats = new Map<string, { updates: number; deferred: number; ms: number }>();

  constructor(budgetMs = readParam()) {
    this.budgetMs = budgetMs > 0 ? budgetMs : 1.0;
    this.enabled = budgetMs > 0;
  }

  /** 자리(site)의 이번 프레임 계획. 자리마다 프레임에 한 번 부른다 */
  plan<T>(site: object, name: string, camera: THREE.Camera, dt: number): AnimPlan<T> {
    this.enter(site);
    let p = this.plans.get(site) as AnimPlan<T> | undefined;
    if (!p) {
      p = new AnimPlan<T>(this, name);
      this.plans.set(site, p as AnimPlan<unknown>);
    }
    this.view(camera);
    p.reset(dt);
    return p;
  }

  /** 예산을 끈 예전 규칙의 자리가 쓴 시간·갱신 수를 통계에 넣는다 */
  account(site: object, name: string, ms: number, updates: number, deferred: number): void {
    this.enter(site);
    this.spent += ms;
    this.upd += updates;
    this.deferred += deferred;
    this.site(name, ms, updates, deferred);
  }

  /** 자리가 이번 프레임에 두 번째로 오면 새 프레임 */
  private enter(site: object): void {
    if (this.sitesThisFrame.has(site)) this.endFrame();
    this.sitesThisFrame.add(site);
  }

  private endFrame(): void {
    this.sitesThisFrame.clear();
    this.hist[this.histN % WINDOW] = this.spent;
    this.histN++;
    this.frames++;
    this.sum.ms += this.spent;
    this.sum.upd += this.upd;
    this.sum.must += this.must;
    this.sum.deferred += this.deferred;
    this.sum.off += this.offUpd;
    this.maxMs = Math.max(this.maxMs, this.spent);
    this.spent = this.upd = this.must = this.deferred = this.offUpd = 0;
    this.frame++;
  }

  private view(camera: THREE.Camera): void {
    if (this.frustumCam === camera && this.frustumFrame === this.frame) return;
    this.frustumCam = camera;
    this.frustumFrame = this.frame;
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    camera.getWorldPosition(this.camPos);
  }

  /** @internal */
  slotOf(key: object, seed: number): Slot {
    let s = this.slots.get(key);
    if (!s) {
      s = { lag: 0, since: 0, cost: seed, seen: -9, n: 0 };
      this.slots.set(key, s);
    }
    return s;
  }

  /** @internal 이번 프레임 번호 */
  get frameNo(): number {
    return this.frame;
  }

  /** @internal */
  inView(x: number, y: number, z: number, r: number): boolean {
    _sphere.center.set(x, y, z);
    _sphere.radius = r;
    return this.frustum.intersectsSphere(_sphere);
  }

  /** @internal 이번 프레임에 남은 예산으로 est(ms)를 감당하나 */
  affords(est: number): boolean {
    return this.spent + est <= this.budgetMs;
  }

  /** @internal */
  offscreenFull(): boolean {
    return this.offUpd >= MAX_OFFSCREEN;
  }

  /** @internal 갱신 한 번 기록 */
  note(ms: number, must: boolean, vis: boolean, dist: number, gap: number): void {
    this.spent += ms;
    this.upd++;
    if (must) this.must++;
    if (!vis) this.offUpd++;
    const tier: Tier = !vis ? 'off' : dist < NEAR ? 'near' : dist < 40 ? 'mid' : 'far';
    this.gapSum[tier] += gap;
    this.gapN[tier]++;
  }

  /** @internal */
  noteDeferred(n: number, nearStale: number): void {
    this.deferred += n;
    this.nearStale += nearStale;
  }

  /** @internal */
  site(name: string, ms: number, updates: number, deferred: number): void {
    let s = this.siteStats.get(name);
    if (!s) {
      s = { updates: 0, deferred: 0, ms: 0 };
      this.siteStats.set(name, s);
    }
    s.updates += updates;
    s.deferred += deferred;
    s.ms += ms;
  }

  stats(): AnimBudgetStats {
    const n = Math.max(1, this.frames);
    const k = Math.min(this.histN, WINDOW);
    const arr = Array.from(this.hist.subarray(0, k)).sort((a, b) => a - b);
    const q = (p: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
    const r3 = (v: number) => Number(v.toFixed(3));
    const gap = {} as Record<Tier, number>;
    for (const t of ['near', 'mid', 'far', 'off'] as Tier[]) gap[t] = this.gapN[t] ? Number((this.gapSum[t] / this.gapN[t]).toFixed(2)) : 0;
    const bySite: AnimBudgetStats['bySite'] = {};
    for (const [name, s] of this.siteStats) bySite[name] = { updates: r3(s.updates / n), deferred: r3(s.deferred / n), ms: r3(s.ms / n) };
    return {
      enabled: this.enabled,
      budgetMs: this.budgetMs,
      frames: this.frames,
      ms: { avg: r3(this.sum.ms / n), p50: r3(q(0.5)), p95: r3(q(0.95)), max: r3(this.maxMs) },
      perFrame: { updates: r3(this.sum.upd / n), must: r3(this.sum.must / n), deferred: r3(this.sum.deferred / n), offscreen: r3(this.sum.off / n) },
      gap,
      nearStale: this.nearStale,
      bySite,
    };
  }

  resetStats(): void {
    this.histN = 0;
    this.frames = 0;
    this.sum = { upd: 0, must: 0, deferred: 0, off: 0, ms: 0 };
    this.maxMs = 0;
    for (const t of ['near', 'mid', 'far', 'off'] as Tier[]) this.gapSum[t] = this.gapN[t] = 0;
    this.nearStale = 0;
    this.siteStats.clear();
  }
}

/** 한 자리의 이번 프레임 후보 (항목 객체는 다시 쓴다) */
export class AnimPlan<T> {
  private readonly entries: Entry<T>[] = [];
  private count = 0;
  private dt = 0;
  /** 이 자리의 갱신 비용 평균 (새 항목의 첫 예상값) */
  private avgCost = 0.05;
  private readonly order: Entry<T>[] = [];

  constructor(
    private readonly b: AnimBudget,
    readonly name: string,
  ) {}

  /** @internal */
  reset(dt: number): void {
    this.count = 0;
    this.dt = dt;
  }

  /**
   * 후보 하나. center: 경계 구 중심(월드), engaged: 바쁨(대화·상호작용 중), force: 이번 프레임에 꼭(자세를 바로 잡아야 함),
   * rest: 쓰러져 누운 것처럼 거의 움직이지 않음(간격 두 배)
   */
  add(item: T, key: object, center: THREE.Vector3, radius: number, engaged = false, force = false, rest = false): void {
    let e = this.entries[this.count];
    if (!e) {
      e = { item, key, x: 0, y: 0, z: 0, r: 0, engaged, force, rest, slot: null, vis: false, dist: 0, sig: 0, base: 1, must: false, done: false };
      this.entries.push(e);
    }
    e.item = item;
    e.key = key;
    e.x = center.x;
    e.y = center.y;
    e.z = center.z;
    e.r = radius;
    e.engaged = engaged;
    e.force = force;
    e.rest = rest;
    this.count++;
  }

  /** 고른 것은 update(항목, 미룬 시간 합), 미룬 것은 skipped(항목) (자리만 놓기 등) */
  run(update: (item: T, dt: number) => void, skipped?: (item: T) => void): void {
    const b = this.b;
    const frame = b.frameNo;
    const cam = _cam.copy(b.camPos);
    const order = this.order;
    order.length = 0;
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i];
      const s = b.slotOf(e.key, this.avgCost);
      // 지난 프레임에 후보가 아니었다 (처음 나타남·숨었다 다시 나옴): 바로 그 자세로
      if (s.seen !== frame - 1 && s.seen !== frame) {
        e.force = true;
        s.lag = 0;
      }
      s.seen = frame;
      s.lag += this.dt;
      e.slot = s;
      e.done = false;
      e.vis = b.inView(e.x, e.y, e.z, e.r);
      e.dist = Math.hypot(e.x - cam.x, e.y - cam.y, e.z - cam.z);
      // 중요도: 화면 안 > 밖, 가까울수록, 바쁘면 더
      e.sig = (e.vis ? 1 : 0.15) * (e.engaged ? 1.6 : 1) * (e.rest ? 0.5 : 1) / (1 + e.dist / 15);
      // 기본 간격: 화면 안은 거리로 (20 m 안 1, 40 m 안 2, 70 m 안 3, 그 밖 4), 바쁘면 줄이고, 누워 있으면 늘린다
      let base = e.vis ? (e.dist < 20 ? 1 : e.dist < 40 ? 2 : e.dist < 70 ? 3 : 4) : OFFSCREEN_INTERVAL;
      if (e.engaged && e.vis) base = Math.max(1, base - 1);
      if (e.rest) base = Math.min(MAX_INTERVAL, base * 2);
      e.base = base;
      e.must = e.force || (e.vis && (e.dist < NEAR || (e.engaged && e.dist < ENGAGED_NEAR)));
      if (e.must) this.exec(e, update);
      else if (s.since + 1 >= base) order.push(e);
    }
    // 때가 된 것: 오래 기다렸고 중요한 것부터, 예산이 남는 만큼 (화면 밖은 프레임당 4개)
    order.sort((a, c) => c.sig * (c.slot!.since + 1) / c.base - a.sig * (a.slot!.since + 1) / a.base);
    for (const e of order) {
      const s = e.slot!;
      if (!e.vis) {
        // 화면 밖은 프레임당 4개 (앞 자리가 다 써도 20프레임 넘게 밀린 것은 한 번: 자리끼리 굶지 않게)
        if (b.offscreenFull() && s.since + 1 < MAX_INTERVAL * 2) continue;
        if (!b.affords(s.cost) && s.since + 1 < MAX_INTERVAL) continue;
      } else if (!b.affords(s.cost) && s.since + 1 < MAX_INTERVAL) continue;
      this.exec(e, update);
    }
    let deferred = 0;
    let stale = 0;
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i];
      if (e.done) continue;
      e.slot!.since++;
      deferred++;
      if (e.vis && e.dist < NEAR) stale++;
      skipped?.(e.item);
    }
    b.noteDeferred(deferred, stale);
    b.site(this.name, 0, 0, deferred);
  }

  private exec(e: Entry<T>, update: (item: T, dt: number) => void): void {
    const s = e.slot!;
    const t0 = now();
    update(e.item, s.lag);
    const ms = now() - t0;
    s.cost = s.n ? s.cost * 0.85 + ms * 0.15 : Math.max(ms, this.avgCost * 0.5);
    this.avgCost = this.avgCost * 0.95 + ms * 0.05;
    s.n++;
    this.b.note(ms, e.must, e.vis, e.dist, s.since + 1);
    this.b.site(this.name, ms, 1, 0);
    s.lag = 0;
    s.since = 0;
    e.done = true;
  }
}

/** 엔진 전체가 쓰는 하나 */
export const animBudget = new AnimBudget();
