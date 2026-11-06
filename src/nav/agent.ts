import * as THREE from 'three';
import { NavWorld } from './NavWorld';

/**
 * 경로 따라가기 + 서로 비키기 (DetourCrowd 대신 가벼운 조향기).
 *
 * 물리로 움직이는 캐릭터(Rapier 캐릭터 컨트롤러)는 위치의 주인이 캐릭터다. 그래서 기본은 'steer' 모드:
 *   agent.moveTo(goal)                           // 경로를 찾는다 (못 가면 false, 가장 가까운 곳까지 감)
 *   const v = agent.update(dt, character.position) // 원하는 수평 속도 (m/s)
 *   controller.computeColliderMovement(collider, { x: v.x * dt, y: vy * dt, z: v.z * dt })
 * 'drive' 모드는 물리 없이 에이전트가 내비메시 위를 스스로 걷는다 (연출용 인물, 점검).
 *
 * - 매끄럽게: 다음 꼭짓점 대신 경로 위 lookAhead m 앞을 본다 (그 사이가 내비 레이로 트여 있을 때만)
 * - 비키기: 같은 NavWorld의 다른 에이전트와 겹치면 밀어내고, 마주 오면 오른쪽으로 비켜 선다.
 *   좁은 통로에서 정면으로 붙거나 서로 막혀 진척이 없으면 id가 큰 쪽이 잠깐 물러선다 (교착 풀기)
 * - 다시 찾기: 목표가 움직였거나, 경로에서 벗어났거나, 막혔거나(진척 없음), 문·장애물이 바뀌었을 때(nav.version)
 */

export type NavAgentMode = 'steer' | 'drive';
export type NavAgentState = 'idle' | 'moving' | 'arrived' | 'failed';

export interface NavAgentOptions {
  /** 몸 반지름 (서로 비키기, m). 기본 0.25 */
  radius?: number;
  /** 최고 속도 (m/s). 기본 3.3 (빠른 걸음) */
  speed?: number;
  /** 가속 (m/s²). 기본 14 */
  accel?: number;
  /** 도착 판정 (수평 m). 기본 0.3 */
  arriveDist?: number;
  /** 끝에서 늦추기 시작하는 거리 (m). 기본 0.8 */
  slowDist?: number;
  /** 경로 위 앞보기 (m). 기본 0.9 */
  lookAhead?: number;
  /** 비키기 세기 (0이면 끔). 기본 1 */
  separation?: number;
  /** 목표가 이만큼(m) 넘게 바뀌면 다시 찾는다. 기본 0.6 */
  repathDist?: number;
  /** 경로에서 이만큼(m) 벗어나면 다시 찾는다. 기본 1.2 */
  offPathDist?: number;
  mode?: NavAgentMode;
  /** 디버그 표시 이름·색 */
  label?: string;
  color?: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _sep = new THREE.Vector3();
let nextId = 1;

export class NavAgent {
  readonly id = nextId++;
  readonly position = new THREE.Vector3();
  /** 원하는 속도 (steer) / 실제 속도 (drive). 수평, m/s */
  readonly velocity = new THREE.Vector3();
  /** 마지막 목표 (요청한 자리) */
  readonly target = new THREE.Vector3();
  /** 지금 경로 꼭짓점 (시작 스냅점 … 끝) */
  path: THREE.Vector3[] = [];
  /** 지금 향하는 꼭짓점 번호 */
  corner = 1;
  /** 경로 위에서 실제로 조향하는 점 (앞보기) */
  readonly steer = new THREE.Vector3();
  state: NavAgentState = 'idle';
  /** 끝점이 목표에 못 미친다 (가장 가까운 곳까지 가는 경로) */
  partial = false;
  /** 막혀서 다시 찾은 횟수 (진척이 생기면 0) */
  stuck = 0;
  radius: number;
  speed: number;
  accel: number;
  arriveDist: number;
  slowDist: number;
  lookAhead: number;
  separation: number;
  repathDist: number;
  offPathDist: number;
  mode: NavAgentMode;
  label: string;
  color: number;
  /** 점검용 */
  readonly stats = { repaths: 0, failed: 0, lastFail: '' as '' | 'nopath' | 'stuck' };

  private version = -1;
  /** 좁은 길에서 마주쳤을 때 비켜 주는 남은 시간 (id가 큰 쪽이 물러선다) */
  private yieldT = 0;
  /** 다른 에이전트에 막혀 기다린 횟수 (진척이 생기면 0) */
  private blocked = 0;
  private sinceSteer = 99;
  private sinceRepath = 99;
  private progressT = 0;
  private readonly progressFrom = new THREE.Vector3();
  private disposed = false;

  constructor(
    readonly nav: NavWorld,
    pos: THREE.Vector3,
    opts: NavAgentOptions = {},
  ) {
    this.position.copy(pos);
    this.radius = opts.radius ?? 0.25;
    this.speed = opts.speed ?? 3.3;
    this.accel = opts.accel ?? 14;
    this.arriveDist = opts.arriveDist ?? 0.3;
    this.slowDist = opts.slowDist ?? 0.8;
    this.lookAhead = opts.lookAhead ?? 0.9;
    this.separation = opts.separation ?? 1;
    this.repathDist = opts.repathDist ?? 0.6;
    this.offPathDist = opts.offPathDist ?? 1.2;
    this.mode = opts.mode ?? 'steer';
    this.label = opts.label ?? `agent${this.id}`;
    this.color = opts.color ?? 0x31d3ff;
    if (this.mode === 'drive') nav.closestPoint(pos, 1.5, this.position);
    nav.agents.add(this);
  }

  /**
   * 목표로 경로를 찾는다. 못 가는 곳이면 가장 가까운 곳까지 가는 경로를 쓰고 false (partial=true).
   * 내비 밖이면 경로 없이 'failed'.
   */
  moveTo(target: THREE.Vector3, speed?: number): boolean {
    if (speed !== undefined) this.speed = speed;
    if (this.state === 'moving' && this.path.length && this.target.distanceToSquared(target) < this.repathDist * this.repathDist) {
      this.target.copy(target);
      return !this.partial;
    }
    this.target.copy(target);
    return this.repath();
  }

  /** 멈춘다 (경로 버림) */
  stop(): void {
    this.state = 'idle';
    this.path = [];
    this.velocity.set(0, 0, 0);
  }

  /** 위치를 바로 옮긴다 (순간이동·체크포인트). 경로는 다시 찾는다 */
  teleport(p: THREE.Vector3): void {
    this.position.copy(p);
    this.velocity.set(0, 0, 0);
    if (this.state === 'moving') this.repath();
  }

  /** 남은 경로 길이 (m) */
  get remaining(): number {
    if (this.state !== 'moving' || !this.path.length) return 0;
    let d = flat(this.position, this.path[this.corner] ?? this.target);
    for (let i = this.corner + 1; i < this.path.length; i++) d += this.path[i].distanceTo(this.path[i - 1]);
    return d;
  }

  /** 다음 꼭짓점 (없으면 null) */
  get nextCorner(): THREE.Vector3 | null {
    return this.path[this.corner] ?? null;
  }

  private repath(): boolean {
    this.stats.repaths++;
    this.sinceRepath = 0;
    this.version = this.nav.version;
    let path = this.nav.findPath(this.position, this.target);
    this.partial = false;
    if (!path) {
      path = this.nav.findPath(this.position, this.target, { partial: true, endExtents: new THREE.Vector3(4, 4, 4) });
      this.partial = true;
    }
    if (!path || path.length < 2) {
      // 이미 그 자리거나 내비 밖
      const near = !!path && path.length === 1;
      this.path = path ?? [];
      this.corner = 1;
      this.state = near ? 'arrived' : 'failed';
      if (!near) {
        this.stats.failed++;
        this.stats.lastFail = 'nopath';
      }
      return near && !this.partial;
    }
    this.path = path;
    this.corner = 1;
    this.state = 'moving';
    this.sinceSteer = 99;
    this.progressT = 0;
    this.progressFrom.copy(this.position);
    return !this.partial;
  }

  /**
   * 한 스텝. steer 모드면 pos(소유자가 옮긴 실제 위치)를 넘긴다.
   * @returns 원하는 수평 속도 (m/s, this.velocity와 같은 객체)
   */
  update(dt: number, pos?: THREE.Vector3): THREE.Vector3 {
    if (this.disposed) return this.velocity.set(0, 0, 0);
    if (pos && this.mode === 'steer') this.position.copy(pos);
    const want = _d.set(0, 0, 0);
    if (this.state === 'moving') {
      if (this.nav.version !== this.version) this.repath();
      if (this.state === 'moving') this.follow(dt, want);
    }
    // 서로 비키기 (서 있을 때도 겹치면 조금)
    if (this.separation > 0) {
      this.separate(want, this.state === 'moving' ? 1 : 0.5);
    }
    // 가속 한계
    _v.copy(want).sub(this.velocity).setY(0);
    const maxDv = this.accel * dt;
    if (_v.lengthSq() > maxDv * maxDv) _v.setLength(maxDv);
    this.velocity.add(_v).setY(0);
    if (this.state !== 'moving' && want.lengthSq() < 1e-6 && this.velocity.lengthSq() < 0.01) this.velocity.set(0, 0, 0);
    if (this.mode === 'drive' && this.velocity.lengthSq() > 1e-8) {
      const c = this.state === 'moving' ? this.path[this.corner] : undefined;
      if (c && c.y < this.position.y - 0.3 && flat(this.position, c) < 1.6 && this.nav.raycast(this.position, c).hit) {
        // 뛰어내리기 링크: 메시를 벗어나 착지점으로 곧장 (물리가 없으니 직접 옮긴다)
        const d = this.position.distanceTo(c);
        const step = Math.max(this.speed, 2) * dt;
        if (d <= step) this.position.copy(c);
        else this.position.lerp(c, step / d);
      } else {
        _w.copy(this.position).addScaledVector(this.velocity, dt);
        const moved = this.nav.moveAlong(this.position, _w, _v);
        if (moved) this.position.copy(moved);
      }
    }
    return this.velocity;
  }

  private follow(dt: number, want: THREE.Vector3): void {
    const path = this.path;
    // 꼭짓점 넘기기
    while (this.corner < path.length - 1 && flat(this.position, path[this.corner]) < Math.max(0.35, this.arriveDist) && Math.abs(path[this.corner].y - this.position.y) < 1.2) {
      this.corner++;
      this.sinceSteer = 99;
    }
    const end = path[path.length - 1];
    const toEnd = flat(this.position, end);
    if (this.corner >= path.length - 1 && toEnd < this.arriveDist) {
      this.state = 'arrived';
      this.stuck = 0;
      return;
    }
    // 같은 자리로 모인 경우: 이미 선 동료가 목표를 차지했으면 그 곁에서 멈춘다 (목표 둘레에서 계속 비비지 않게)
    if (this.corner >= path.length - 1 && toEnd < this.radius * 2 + 2) {
      for (const o of this.nav.agents) {
        if (o === this || o.state === 'moving') continue;
        if (flat(o.position, end) < toEnd && flat(o.position, this.position) < this.radius + o.radius + 0.6) {
          this.state = 'arrived';
          this.stuck = 0;
          return;
        }
      }
    }
    // 마주친 상대에게 길을 내주는 중: 경로 반대로 조금 물러선다 (막힘 계산도 멈춘다)
    if (this.yieldT > 0) {
      this.yieldT -= dt;
      const back = _v.copy(path[this.corner - 1]).sub(path[this.corner]).setY(0);
      if (back.lengthSq() > 1e-6) want.copy(back.normalize()).multiplyScalar(this.speed * 0.35);
      this.progressT = 0;
      this.progressFrom.copy(this.position);
      return;
    }
    // 경로에서 벗어남
    const a = path[this.corner - 1];
    const b = path[this.corner];
    if (segDist(this.position, a, b) > this.offPathDist) {
      this.repath();
      if (this.state !== 'moving') return;
    }
    // 진척 감시 (1.2초에 0.25 m도 못 가면 막힘 → 다시 찾기, 세 번이면 실패)
    this.progressT += dt;
    if (this.progressT > 1.2) {
      if (flat(this.position, this.progressFrom) < 0.25) {
        // 다른 에이전트에 막힌 것이면 (네 번까지) 실패로 세지 않고 id가 큰 쪽이 물러선다
        const blocker = this.nearestAgent(this.radius * 2 + 0.5);
        if (blocker && this.blocked < 4) {
          this.blocked++;
          if (this.id > blocker.id) this.yieldT = 0.9;
          this.progressT = 0;
          this.progressFrom.copy(this.position);
          return;
        }
        this.stuck++;
        if (this.stuck >= 3) {
          this.state = 'failed';
          this.stats.failed++;
          this.stats.lastFail = 'stuck';
          return;
        }
        this.repath();
        if (this.state !== 'moving') return;
      } else {
        this.stuck = 0;
        this.blocked = 0;
      }
      this.progressT = 0;
      this.progressFrom.copy(this.position);
    }
    // 조향점: 10 Hz로 앞보기 점을 다시 고른다 (트여 있으면 앞, 아니면 다음 꼭짓점)
    this.sinceSteer += dt;
    this.sinceRepath += dt;
    if (this.sinceSteer >= 0.1) {
      this.sinceSteer = 0;
      this.pickSteer();
    }
    const dir = _v.copy(this.steer).sub(this.position).setY(0);
    const dist = dir.length();
    if (dist < 1e-4) return;
    let sp = this.speed;
    const rem = this.corner >= path.length - 1 ? toEnd : this.remaining;
    if (rem < this.slowDist) sp *= Math.max(0.25, rem / this.slowDist);
    want.copy(dir).multiplyScalar(sp / dist);
  }

  private pickSteer(): void {
    const path = this.path;
    // 지금 위치를 지금 구간에 투영한 뒤 lookAhead만큼 경로를 따라간다
    const a = path[this.corner - 1];
    const b = path[this.corner];
    const k = projT(this.position, a, b);
    let i = this.corner;
    let left = this.lookAhead;
    const p = _w.copy(a).lerp(b, k);
    let seg = p.distanceTo(b);
    while (left > seg && i < path.length - 1) {
      left -= seg;
      p.copy(path[i]);
      i++;
      seg = p.distanceTo(path[i]);
    }
    if (left <= seg && seg > 1e-5) p.lerp(path[i], left / seg);
    else p.copy(path[i]);
    // 조향점까지 트여 있어야 한다. 아니면 다음 꼭짓점, 그것도 가려졌으면(밀려서 모서리 뒤로) 경로를 다시 찾는다
    if (this.clear(p)) this.steer.copy(p);
    else if (this.clear(path[this.corner])) this.steer.copy(path[this.corner]);
    else if (this.sinceRepath > 0.5) {
      this.repath();
      if (this.state === 'moving') this.steer.copy(this.path[this.corner]);
    } else this.steer.copy(path[this.corner]);
  }

  /** 지금 자리에서 q까지 걸어서 일직선으로 트였나 (경계 위 꼭짓점은 끝 0.25 m 안 막힘을 봐준다) */
  private clear(q: THREE.Vector3): boolean {
    const h = this.nav.raycast(this.position, q);
    if (!h.hit) return true;
    return h.t > 0.97 || Math.hypot(h.point.x - q.x, h.point.z - q.z) < 0.25;
  }

  private nearestAgent(range: number): NavAgent | null {
    let best: NavAgent | null = null;
    let bd = range * range;
    for (const o of this.nav.agents) {
      if (o === this || Math.abs(o.position.y - this.position.y) > 1.2) continue;
      const dx = o.position.x - this.position.x;
      const dz = o.position.z - this.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) {
        bd = d2;
        best = o;
      }
    }
    return best;
  }

  private separate(want: THREE.Vector3, gain: number): void {
    const sep = _sep.set(0, 0, 0);
    let n = 0;
    for (const o of this.nav.agents) {
      if (o === this) continue;
      const dx = this.position.x - o.position.x;
      const dz = this.position.z - o.position.z;
      if (Math.abs(this.position.y - o.position.y) > 1.2) continue;
      const range = this.radius + o.radius + 0.35;
      const d2 = dx * dx + dz * dz;
      if (d2 >= range * range) continue;
      const d = Math.sqrt(d2);
      const push = (range - d) / range;
      if (d < 1e-4) {
        // 같은 자리: id로 갈라진다
        sep.x += this.id < o.id ? push : -push;
        continue;
      }
      sep.x += (dx / d) * push;
      sep.z += (dz / d) * push;
      // 마주 오면(서로 향함) 오른쪽으로 비켜 선다
      if (this.state === 'moving' && want.lengthSq() > 1e-4) {
        const ox = o.velocity.x;
        const oz = o.velocity.z;
        const head = -(dx * want.x + dz * want.z) / (d * want.length());
        const oncoming = ox * want.x + oz * want.z < 0;
        if (head > 0.7 && oncoming) {
          const l = want.length();
          sep.x += (-want.z / l) * push * 0.6;
          sep.z += (want.x / l) * push * 0.6;
          // 정면으로 붙었으면 id가 큰 쪽이 잠깐 물러선다 (좁은 통로 교착 풀기)
          if (this.id > o.id && d < this.radius + o.radius + 0.15) this.yieldT = Math.max(this.yieldT, 0.7);
        }
      }
      n++;
    }
    if (!n && sep.lengthSq() === 0) return;
    sep.multiplyScalar(this.separation * gain * Math.max(1.2, this.speed));
    // 밀려서 내비 밖(벽·낭떠러지)으로 나가지 않게: 미는 힘만 막힌 면을 따라 미끄러뜨린다
    // (경로를 따르는 힘은 그대로: 뛰어내리기 링크처럼 경계로 가야 하는 길을 막지 않는다)
    _w.copy(this.position).addScaledVector(sep, 0.35);
    const hit = this.nav.raycast(this.position, _w);
    if (hit.hit && hit.normal.lengthSq() > 0.5) {
      const into = sep.dot(hit.normal);
      if (into < 0) sep.addScaledVector(hit.normal, -into);
    }
    want.add(sep);
    const max = Math.max(this.speed, 0.6) * 1.15;
    if (want.lengthSq() > max * max) want.setLength(max);
  }

  dispose(): void {
    this.disposed = true;
    this.nav.agents.delete(this);
  }
}

function flat(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function projT(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const l2 = abx * abx + abz * abz;
  if (l2 < 1e-8) return 1;
  return Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2));
}

function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const t = projT(p, a, b);
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  return Math.hypot(p.x - x, p.z - z);
}

NavWorld.agentFactory = (nav, pos, opts) => new NavAgent(nav, pos, opts);
