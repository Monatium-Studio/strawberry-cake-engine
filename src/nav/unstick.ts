import * as THREE from 'three';
import type { NavWorld } from './NavWorld';

/**
 * 막힘 단계 탈출. 내비 에이전트를 따라 물리로 걷는 캐릭터의 이동 코드가 '0.9초에 0.25 m도 못 감'을 볼 때마다 부른다.
 *
 *   ① 다시 찾기: 같은 목표로 경로를 새로 (밀려서 모서리 뒤로 갔을 때)
 *   ② 옆으로 밀기: 0.45초 동안 막힌 방향의 옆(내비 레이로 트인 쪽)으로 비켜 걷고, 내비메시 밖으로 밀려났으면 가장 가까운
 *      걷는 자리 쪽으로 (Detour Crowd의 '자리 다시 잡기'). 끝나면 경로를 다시 찾는다
 *   ③ 실패 지점 기억: 그 목표를 nav.markBad(goal, 20초, self)로 적고 이동을 그만둔다. 새 목표는 게임 쪽 판단이 고른다
 *      (그 자리를 다시 목표로 받지 않으려면 nav.isBad(p, self)로 거른다)
 *   ④ 순간이동 (선택): ③을 겪은 자리(0.7 m 안, 15초 안)에서 또 막히면 몸이 끼인 것이다. UnstickWorld.observed를 준 경우에만,
 *      지금 자리도 갈 자리도 아무도 못 볼 때 경로 앞(1.5 m 넘게 떨어진 다음 경로점, 없으면 목표)으로 옮긴다 (L4D: 아무도 보지 않을 때만).
 *      보이는 자리에서 캐릭터를 옮기면 눈속임으로 보이므로 observed를 주지 않으면 이 단계는 없다
 * 진척이 생기면(0.9초에 0.25 m 넘게) 단계는 처음으로 돌아간다. 목표가 바뀌어도 처음부터.
 */

export type UnstickAction =
  | { kind: 'replan'; route: THREE.Vector3[] }
  | { kind: 'nudge' }
  | { kind: 'giveup' }
  | { kind: 'teleport'; to: THREE.Vector3 };

/** 점검: 단계별 발동 수 (모든 캐릭터 합) */
export const unstickStats = { stuck: 0, replan: 0, nudge: 0, markBad: 0, teleport: 0, teleportSeen: 0 };


export function resetUnstickStats(): void {
  for (const k of Object.keys(unstickStats) as (keyof typeof unstickStats)[]) unstickStats[k] = 0;
}

/** 막힌 캐릭터가 세계에 묻는 것 */
export interface UnstickWorld {
  readonly time: number;
  findPath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] | null;
  nav(): NavWorld | null;
  /** 누군가(보통 카메라)가 이 자리(서 있는 몸)를 볼 수 있나. 없으면 ④ 순간이동을 하지 않는다 */
  observed?(p: THREE.Vector3): boolean;
}

const NUDGE_TIME = 0.45;
const NUDGE_SPEED = 1.6;
const BAD_TTL = 20;
const WEDGE_R = 0.7;
const WEDGE_TIME = 15;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class Unstick {
  /** 이번 목표에서 지난 단계 (0 = 막힌 적 없음) */
  stage = 0;
  /** 옆으로 밀기 남은 시간과 방향 (수평 단위) */
  nudgeT = 0;
  readonly nudgeDir = new THREE.Vector3();
  /** ③을 겪은 자리 (같은 자리에서 또 막히면 ④) */
  private readonly wedges: { p: THREE.Vector3; t: number }[] = [];
  private readonly target = new THREE.Vector3(Number.NaN, 0, 0);

  /** 새 목표 (goTo): 0.5 m 넘게 바뀌면 처음부터 */
  retarget(goal: THREE.Vector3): void {
    if (Number.isNaN(this.target.x) || this.target.distanceToSquared(goal) > 0.25) {
      this.target.copy(goal);
      this.stage = 0;
      this.nudgeT = 0;
    }
  }

  /** 진척이 생겼다 */
  progress(): void {
    this.stage = 0;
  }

  /** 밀기 중이면 이번 스텝 옆 이동량(m)을 desired에 더한다 */
  push(dt: number, desired: THREE.Vector3): boolean {
    if (this.nudgeT <= 0) return false;
    this.nudgeT -= dt;
    desired.x = this.nudgeDir.x * NUDGE_SPEED * dt;
    desired.z = this.nudgeDir.z * NUDGE_SPEED * dt;
    return true;
  }

  /**
   * 막혔다 (0.9초에 0.25 m도 못 감). pos: 발, goal: 목표, next: 다음 경로점, self: 실패 지점 기억의 주인
   */
  stuck(pos: THREE.Vector3, goal: THREE.Vector3, next: THREE.Vector3, route: THREE.Vector3[], self: object, w: UnstickWorld): UnstickAction {
    unstickStats.stuck++;
    const nav = w.nav();
    const now = w.time;
    for (let i = this.wedges.length - 1; i >= 0; i--) if (now - this.wedges[i].t > WEDGE_TIME) this.wedges.splice(i, 1);
    // ④ 같은 자리에서 포기한 적이 있다: 끼인 몸
    const wedged = this.wedges.some((x) => x.p.distanceToSquared(pos) < WEDGE_R * WEDGE_R);
    if (wedged && nav && w.observed) {
      const to = this.ahead(pos, goal, route, nav);
      if (to) {
        if (!w.observed(pos) && !w.observed(to)) {
          unstickStats.teleport++;
          this.wedges.length = 0;
          this.stage = 0;
          return { kind: 'teleport', to };
        }
        unstickStats.teleportSeen++;
      }
    }
    // ① 다시 찾기
    if (this.stage === 0) {
      this.stage = 1;
      const again = w.findPath(pos, goal);
      if (again && again.length) {
        unstickStats.replan++;
        return { kind: 'replan', route: again };
      }
      // 경로가 없다: 바로 ③
      this.stage = 2;
    }
    // ② 옆으로 밀기 (내비메시 밖이면 안으로)
    if (this.stage === 1) {
      this.stage = 2;
      if (this.aimNudge(pos, next, nav)) {
        unstickStats.nudge++;
        this.nudgeT = NUDGE_TIME;
        return { kind: 'nudge' };
      }
    }
    // ③ 실패 지점 기억 → 그만두고 새로 고르게
    this.stage = 3;
    unstickStats.markBad++;
    nav?.markBad(goal, BAD_TTL, self);
    this.wedges.push({ p: pos.clone(), t: now });
    if (this.wedges.length > 4) this.wedges.shift();
    return { kind: 'giveup' };
  }

  /** 진척 감시(nav/watchdog.ts) ② 단계: 지금 옆으로 비키거나 내비메시 위로 되돌아간다. 비킬 데가 없으면 false */
  nudgeNow(pos: THREE.Vector3, next: THREE.Vector3, nav: NavWorld | null): boolean {
    if (!this.aimNudge(pos, next, nav)) return false;
    unstickStats.nudge++;
    this.nudgeT = NUDGE_TIME;
    return true;
  }

  /** 옆으로 비킬 방향: 막힌 방향(다음 경로점 쪽)의 좌우 중 내비 레이가 더 트인 쪽. 내비 밖이면 가장 가까운 걷는 자리 쪽 */
  private aimNudge(pos: THREE.Vector3, next: THREE.Vector3, nav: NavWorld | null): boolean {
    const fwd = _a.copy(next).sub(pos).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    fwd.normalize();
    if (!nav) {
      const s = Math.random() < 0.5 ? 1 : -1;
      this.nudgeDir.set(-fwd.z * s, 0, fwd.x * s);
      return true;
    }
    const on = nav.closestPoint(pos, 1.5, _b);
    if (on && Math.hypot(on.x - pos.x, on.z - pos.z) > 0.12) {
      // 침식 경계 밖(벽 쪽)으로 밀려났다: 메시 안으로
      this.nudgeDir.set(on.x - pos.x, 0, on.z - pos.z).normalize();
      return true;
    }
    let best = -1;
    let bestSide = 1;
    for (const s of [1, -1]) {
      // 옆 + 조금 앞으로 (모서리를 돌아가게)
      const dx = -fwd.z * s * 0.9 + fwd.x * 0.35;
      const dz = fwd.x * s * 0.9 + fwd.z * 0.35;
      const h = nav.raycast(pos, _b.set(pos.x + dx, pos.y, pos.z + dz));
      const t = h.hit ? h.t : 1;
      if (t > best + 0.05 || (Math.abs(t - best) <= 0.05 && Math.random() < 0.5)) {
        best = t;
        bestSide = s;
      }
    }
    if (best < 0.25) return false;
    this.nudgeDir.set(-fwd.z * bestSide * 0.9 + fwd.x * 0.35, 0, fwd.x * bestSide * 0.9 + fwd.z * 0.35).normalize();
    return true;
  }

  /** 순간이동 자리: 1.5 m 넘게 앞인 다음 경로점 (없으면 목표), 내비메시 위 */
  private ahead(pos: THREE.Vector3, goal: THREE.Vector3, route: THREE.Vector3[], nav: NavWorld): THREE.Vector3 | null {
    let p: THREE.Vector3 | null = null;
    for (const r of route) {
      if (Math.hypot(r.x - pos.x, r.z - pos.z) > 1.5) {
        p = r;
        break;
      }
    }
    p ??= goal;
    const c = nav.closestPoint(p, 1.5);
    if (!c || Math.hypot(c.x - pos.x, c.z - pos.z) < 0.6) return null;
    if (!nav.isReachable(pos, c) && nav.islandAt(pos) >= 0) return null;
    return c.setY(c.y + 0.02);
  }
}
