/**
 * 진척 감시 (watchdog): 캐릭터가 가려는 목표에 실제로 다가가고 있는지, 목표를 오락가락하지 않는지 본다.
 * AI 상태 기계가 데드락·라이브락에 걸려도 빠져나오게 한다.
 *
 * nav/unstick.ts는 '0.9초에 0.25 m도 못 감'(몸이 막힘)만 본다. 그 사이 조금이라도 움직이면 단계가 처음으로 돌아가서,
 * 밀려났다 돌아오기(개인 공간·겹쳐 지나가기·옆으로 밀기가 서로 되돌림), 모퉁이 앞 왕복, 목표 둘을 번갈아 고르기 같은
 * 라이브락은 끝나지 않는다. 연출 이동(walkTo)이 끝나지 않으면 그 약속을 기다리는 스크립트도 멈춘다.
 *
 * 0.5초마다 (자리, 목표까지 수평 거리)를 고리 버퍼에 쌓는다.
 *  - 정체(stall): 같은 목표로 움직이는 동안 STALL_WINDOW초(두 번째부터 ESC_WINDOW초) 동안 목표에 STALL_GAIN m도 다가가지 못했다
 *    → 단계를 밟아 푼다: ① 같은 목표로 경로 다시 찾기 ② 옆으로 비키기·내비메시 위로 되돌리기 ③ 그 목표를 N초 동안 나쁨으로 적고
 *    다른 자리 고르기 ④ 목표·행동을 내려놓기 (연출 이동은 그 자리에서 끝, 따르기는 잠깐 쉼 등: 게임 쪽이 정한다)
 *  - 오락가락(oscillate): 목표가 OSC_WINDOW초 안에 두 번 넘게 예전 자리로 돌아갔는데(A→B→A) 몸은 거의 그대로다
 *    → 지금 목표에 COMMIT초 붙든다 (히스테리시스: 그동안 가까운 새 목표·자리 다시 고르기를 받지 않는다)
 * 순간이동은 하지 않는다 (보이는 자리에서 옮기면 눈속임이 된다. unstick.ts의 선택 단계만 '아무도 안 볼 때' 옮긴다).
 * 문턱값은 출발점이다: 게임마다 재서 고친다.
 */

export type WatchdogVerdict = 'repath' | 'nudge' | 'avoid' | 'abandon' | 'commit';

/** 점검용 합계 (모든 캐릭터). escape=false면 감지만 하고 풀지 않는다 (전후 비교: 게임 쪽 이동 코드가 이 값을 본다) */
export const watchdogStats = {
  escape: true,
  /** 정체 감지 (단계 하나 = 한 번) */
  stall: 0,
  /** 오락가락 감지 */
  oscillate: 0,
  stage1: 0,
  stage2: 0,
  stage3: 0,
  stage4: 0,
  /** 연출 이동(walkTo)이 기한을 넘겨 그 자리에서 끝남 */
  scriptLate: 0,
  /** 연출 이동이 수평으로는 닿았는데 예전 판정(3D 0.3 m: 목표점 높이가 발과 다름)으로는 끝나지 않았을 것 (감지만 모드에서 셈) */
  scriptYMiss: 0,
  /** 단계별 누가 (게임이 정한 이름 → 횟수) */
  who: {} as Record<string, number>,
};

export function resetWatchdogStats(): void {
  for (const k of ['stall', 'oscillate', 'stage1', 'stage2', 'stage3', 'stage4', 'scriptLate', 'scriptYMiss'] as const) watchdogStats[k] = 0;
  watchdogStats.who = {};
}

const SAMPLE = 0.5;
/** 처음 정체 판정 창 (초) */
const STALL_WINDOW = 6;
/** 단계를 하나 밟은 뒤 다음 판정 창 */
const ESC_WINDOW = 4;
/** 창 동안 목표에 이만큼은 다가가야 진척 */
const STALL_GAIN = 0.75;
/** 목표에 이만큼 가까우면 정체로 보지 않는다 (도착 근처의 비비적거림은 이동 코드가 끝낸다) */
const NEAR_GOAL = 0.35;
/** 목표가 이만큼 바뀌면 새 목표 (창을 비운다) */
const GOAL_MOVE = 1.2;
/** 감지가 이만큼 없으면 단계를 처음으로 */
const CALM = 12;
const OSC_WINDOW = 10;
const OSC_SAME = 1.0;
const OSC_NET = 2.5;
const COMMIT = 4;

const RING = Math.ceil(STALL_WINDOW / SAMPLE) + 1;

export class Watchdog {
  /** 지금까지 밟은 단계 (0 = 없음, 4 = 내려놓음) */
  stage = 0;
  /** 이때까지 지금 목표에 붙든다 (오락가락 히스테리시스). 명령·연출이 오면 release */
  commitUntil = -1;
  private readonly t = new Float64Array(RING);
  private readonly gd = new Float32Array(RING);
  private n = 0;
  private head = 0;
  private acc = 0;
  private gx = Number.NaN;
  private gz = 0;
  private lastHit = -99;
  private window = STALL_WINDOW;
  /** 최근 목표들 (오락가락): 자리와 그때 몸의 자리 */
  private readonly goals: { x: number; z: number; t: number; px: number; pz: number }[] = [];

  /** 명령·연출·되돌리기: 처음부터 */
  release(): void {
    this.stage = 0;
    this.commitUntil = -1;
    this.n = 0;
    this.goals.length = 0;
    this.gx = Number.NaN;
    this.window = STALL_WINDOW;
  }

  /** 지금 붙든 목표 곁(r m 안)의 새 목표를 받지 않아야 하나 */
  holds(now: number, cur: { x: number; z: number }, next: { x: number; z: number }, r = 6): boolean {
    return now < this.commitUntil && Math.hypot(next.x - cur.x, next.z - cur.z) < r;
  }

  /**
   * 고정 스텝마다. paused: 지금은 판정하지 않는다 (넘는 중·링크 앞에서 기다림·비켜 서기·옆으로 밀기·기절).
   * 판정이 나면 그 단계를 돌려준다
   */
  tick(dt: number, now: number, px: number, pz: number, goalX: number, goalZ: number, moving: boolean, paused: boolean): WatchdogVerdict | null {
    this.acc += dt;
    if (this.acc < SAMPLE) return null;
    this.acc = 0;
    if (now - this.lastHit > CALM && this.stage) {
      this.stage = 0;
      this.window = STALL_WINDOW;
    }
    if (!moving || paused) {
      this.n = 0;
      return null;
    }
    // 목표 바뀜: 정체 창을 비우고, 오락가락 기록에 넣는다
    if (Number.isNaN(this.gx) || Math.hypot(goalX - this.gx, goalZ - this.gz) > GOAL_MOVE) {
      this.gx = goalX;
      this.gz = goalZ;
      this.n = 0;
      this.goals.push({ x: goalX, z: goalZ, t: now, px, pz });
      while (this.goals.length > 10 || (this.goals.length && now - this.goals[0].t > OSC_WINDOW)) this.goals.shift();
      if (this.oscillating(now, px, pz)) {
        this.goals.length = 0;
        this.lastHit = now;
        this.commitUntil = now + COMMIT;
        watchdogStats.oscillate++;
        return 'commit';
      }
    }
    const d = Math.hypot(goalX - px, goalZ - pz);
    this.t[this.head] = now;
    this.gd[this.head] = d;
    this.head = (this.head + 1) % RING;
    this.n = Math.min(RING, this.n + 1);
    // 창: 가장 오래된 표본이 window초 전 것이 될 때까지
    const need = Math.round(this.window / SAMPLE) + 1;
    if (this.n < need) return null;
    const first = (this.head - need + RING) % RING;
    let best = Infinity;
    for (let k = 0; k < need; k++) best = Math.min(best, this.gd[(first + k) % RING]);
    const gain = this.gd[first] - best;
    if (gain >= STALL_GAIN || d < NEAR_GOAL) return null;
    // 정체: 다음 단계
    this.n = 0;
    this.lastHit = now;
    this.window = ESC_WINDOW;
    this.stage = Math.min(4, this.stage + 1);
    watchdogStats.stall++;
    return this.stage === 1 ? 'repath' : this.stage === 2 ? 'nudge' : this.stage === 3 ? 'avoid' : 'abandon';
  }

  /** 가장 새 목표가 OSC_SAME m 안의 예전 목표(바로 앞 것 말고)로 돌아간 횟수가 둘 넘고, 그동안 몸은 OSC_NET m 안 */
  private oscillating(now: number, px: number, pz: number): boolean {
    const g = this.goals;
    if (g.length < 4) return false;
    let back = 0;
    for (let i = 2; i < g.length; i++) {
      for (let j = 0; j < i - 1; j++) {
        if (Math.hypot(g[i].x - g[j].x, g[i].z - g[j].z) < OSC_SAME) {
          back++;
          break;
        }
      }
    }
    if (back < 2) return false;
    const o = g[0];
    void now;
    return Math.hypot(px - o.px, pz - o.pz) < OSC_NET;
  }
}

/** 단계 기록 (점검): who는 게임이 정한 이름 */
export function noteEscape(stage: number, who: string): void {
  if (stage === 1) watchdogStats.stage1++;
  else if (stage === 2) watchdogStats.stage2++;
  else if (stage === 3) watchdogStats.stage3++;
  else if (stage >= 4) watchdogStats.stage4++;
  const k = `${who}#${stage}`;
  watchdogStats.who[k] = (watchdogStats.who[k] ?? 0) + 1;
}
