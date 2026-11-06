import * as THREE from 'three';
import type { CamKey, CamRailData } from '../level/Level';

/**
 * 카메라 레일: CAM_<shot>_<nn> 점들을 카트멀롬으로 잇는다.
 * - 위치: 키 시각 t에 맞춘 구간별 카트멀롬 (끝점은 복제)
 * - 시선: LOOK_ 점이 있으면 그 점들도 같은 방식으로 보간해 바라본다. 없으면 키 회전을 구면 보간
 * - FOV: 키 사이를 부드럽게 (fov가 없는 키는 앞 키 값을 이어 쓴다)
 * - ease: 첫 구간은 천천히 출발, 마지막 구간은 천천히 멈춘다 (속도 연속은 보장하지 않는 가벼운 근사)
 */
export interface CamPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
}

const tmpM = new THREE.Matrix4();
/** 이보다 먼 시선 점이 있는 구간은 방향으로 보간한다 (m) */
const FAR_LOOK = 60;
const UP = new THREE.Vector3(0, 1, 0);

function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function crV(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(cr(a.x, b.x, c.x, d.x, t), cr(a.y, b.y, c.y, d.y, t), cr(a.z, b.z, c.z, d.z, t));
}

export function lookQuat(from: THREE.Vector3, to: THREE.Vector3, out = new THREE.Quaternion(), up = UP): THREE.Quaternion {
  // 카메라: -Z가 시선
  tmpM.lookAt(from, to, up);
  return out.setFromRotationMatrix(tmpM);
}

export class CameraRail {
  readonly keys: CamKey[];
  readonly duration: number;
  readonly hasLook: boolean;
  easeIn = true;
  easeOut = true;
  /** fov가 하나도 없을 때 */
  defaultFov = 50;

  constructor(
    readonly name: string,
    keys: CamKey[],
  ) {
    this.keys = [...keys].sort((a, b) => a.t - b.t);
    if (!this.keys.length) throw new Error(`rail ${name}: 키 없음`);
    const t0 = this.keys[0].t;
    for (const k of this.keys) k.t -= t0;
    this.duration = this.keys[this.keys.length - 1].t;
    this.hasLook = this.keys.some((k) => k.look);
    // 시선 점이 없는 키는 키 방향으로 10 m 앞 점을 만든다 (시선 보간이 끊기지 않게)
    if (this.hasLook) {
      for (const k of this.keys) {
        if (!k.look) k.look = new THREE.Vector3(0, 0, -10).applyQuaternion(k.quaternion).add(k.position);
      }
    }
    let lastFov: number | null = null;
    for (const k of this.keys) {
      if (k.fov !== null) lastFov = k.fov;
      else if (lastFov !== null) k.fov = lastFov;
    }
    const firstFov = this.keys.find((k) => k.fov !== null)?.fov ?? null;
    for (const k of this.keys) if (k.fov === null) k.fov = firstFov;
  }

  static from(data: CamRailData): CameraRail {
    return new CameraRail(
      data.shot,
      data.keys.map((k) => ({ ...k, position: k.position.clone(), quaternion: k.quaternion.clone(), look: k.look?.clone() ?? null })),
    );
  }

  /** 코드로 만드는 레일: [시각, 위치, 시선 점, fov] */
  static build(name: string, pts: [number, THREE.Vector3, THREE.Vector3, number?][]): CameraRail {
    return new CameraRail(
      name,
      pts.map(([t, p, l, fov], i) => ({
        index: i,
        t,
        position: p.clone(),
        look: l.clone(),
        quaternion: lookQuat(p, l),
        fov: fov ?? null,
        props: {},
      })),
    );
  }

  /** time(초)의 자세 */
  sample(time: number, out: CamPose): CamPose {
    const ks = this.keys;
    const n = ks.length;
    if (n === 1 || time <= 0) return this.at(0, 0, out);
    if (time >= this.duration) return this.at(n - 2, 1, out);
    let i = 0;
    while (i < n - 2 && time > ks[i + 1].t) i++;
    const span = Math.max(1e-4, ks[i + 1].t - ks[i].t);
    let u = (time - ks[i].t) / span;
    if (i === 0 && this.easeIn && n > 1) u = n === 2 && this.easeOut ? u * u * (3 - 2 * u) : easeInQuad(u);
    else if (i === n - 2 && this.easeOut) u = easeOutQuad(u);
    return this.at(i, u, out);
  }

  private at(i: number, u: number, out: CamPose): CamPose {
    const ks = this.keys;
    const n = ks.length;
    if (n === 1) {
      out.position.copy(ks[0].position);
      out.quaternion.copy(ks[0].quaternion);
      out.fov = ks[0].fov ?? this.defaultFov;
      return out;
    }
    const a = ks[Math.max(0, i - 1)];
    const b = ks[i];
    const c = ks[Math.min(n - 1, i + 1)];
    const d = ks[Math.min(n - 1, i + 2)];
    crV(a.position, b.position, c.position, d.position, u, out.position);
    if (this.hasLook) {
      // 시선 점이 가까우면 점을 보간하고(그 점을 계속 바라본다), 하나라도 멀면(하늘의 달, 원경의 산) 방향을 보간한다.
      // 먼 점을 카트멀롬으로 이으면 접선이 커져 시선이 반대쪽으로 튄다 (예: 가까운 얼굴 → 하늘의 달)
      const far = [a, b, c, d].some((k) => k.look!.distanceToSquared(k.position) > FAR_LOOK * FAR_LOOK);
      if (!far) {
        const look = crV(a.look!, b.look!, c.look!, d.look!, u, new THREE.Vector3());
        lookQuat(out.position, look, out.quaternion);
      } else {
        const dir = (k: CamKey) => k.look!.clone().sub(k.position).normalize();
        const s = u * u * (3 - 2 * u);
        const v = dir(b).lerp(dir(c), s).normalize();
        lookQuat(out.position, out.position.clone().add(v), out.quaternion);
      }
    } else {
      const s = u * u * (3 - 2 * u);
      out.quaternion.slerpQuaternions(b.quaternion, c.quaternion, s);
    }
    const s = u * u * (3 - 2 * u);
    out.fov = THREE.MathUtils.lerp(b.fov ?? this.defaultFov, c.fov ?? this.defaultFov, s);
    return out;
  }
}

const easeInQuad = (u: number) => {
  // 출발: 속도 0 → 구간 끝에서 선형 속도와 비슷하게
  return u * u * (2 - u) * 0.5 + u * 0.5 * u;
};
const easeOutQuad = (u: number) => 1 - easeInQuad(1 - u);

export function newPose(): CamPose {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 50 };
}
