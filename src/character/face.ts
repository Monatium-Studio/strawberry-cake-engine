import type * as THREE from 'three';

/**
 * 얼굴 모프 제어.
 * - 얼굴 노드(`<이름>_face`)의 자식 메시 전부(본체 + UNLIT 하이라이트)에 같은 값을 넣는다.
 * - 교정 키 규칙: `blink_`로 시작하는 모든 키 `blink_<X>` = blink × <X>. 인물마다 추가한 표정도 같다.
 * - 입 모양: 말하는 동안 입을 여닫는다. 입만 여는 모프(talk, mouth_open, open, aa)가 있으면 그걸 쓰고,
 *   없으면 기본 표정 중 입이 열리는 surprised(+ smile 조금)로 근사한다.
 * - 눈동자 시선 모프(look_L/look_R/look_up/look_down)가 있으면 시선 추적에 쓴다 (없어도 된다).
 */
export class FaceRig {
  readonly meshes: THREE.Mesh[] = [];
  readonly keys = new Set<string>();
  /** 지금 표정 가중치 (blink·입 제외) */
  readonly current: Record<string, number> = {};
  /** 목표 표정 가중치 */
  readonly target: Record<string, number> = {};
  /** 0~1, 눈 감김 */
  blink = 0;
  /** 0~1, 입 벌림 (말하기) */
  mouth = 0;
  /** -1~1 좌우(+ = 인물 왼쪽), 상하(+ = 위) */
  gaze = { x: 0, y: 0 };
  /** 표정 전환 속도 (초당 가중치 변화) */
  rate = 4;
  readonly mouthKey: string | null;
  private readonly mouthMix: [string, number][];
  readonly hasGaze: boolean;

  constructor(root: THREE.Object3D) {
    root.traverse((o) => {
      if (!o.name.endsWith('_face')) return;
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) {
          this.meshes.push(m);
          for (const k of Object.keys(m.morphTargetDictionary)) this.keys.add(k);
        }
      });
    });
    this.mouthKey = ['talk', 'mouth_open', 'open', 'aa'].find((k) => this.keys.has(k)) ?? null;
    this.mouthMix = this.mouthKey
      ? [[this.mouthKey, 1]]
      : this.keys.has('surprised')
        ? [['surprised', 0.3], ['smile', 0.08]]
        : [];
    this.hasGaze = ['look_L', 'look_R'].every((k) => this.keys.has(k));
  }

  get ok(): boolean {
    return this.meshes.length > 0;
  }

  /** 표정 키 (blink·교정 키·입·시선 제외) */
  expressions(): string[] {
    return [...this.keys].filter((k) => k !== 'blink' && !k.startsWith('blink_') && k !== this.mouthKey && !k.startsWith('look_'));
  }

  /** 표정 지정: name 하나를 weight로, 나머지는 0으로. 'neutral'이면 모두 0 */
  setExpression(name: string, weight = 1): void {
    for (const k of this.expressions()) this.target[k] = 0;
    if (name !== 'neutral' && this.keys.has(name)) this.target[name] = weight;
    else if (name !== 'neutral') console.warn(`[character] 표정 없음: ${name}`);
  }

  /** 여러 표정을 섞어 지정 */
  setMix(w: Record<string, number>): void {
    for (const k of this.expressions()) this.target[k] = w[k] ?? 0;
  }

  update(dt: number): void {
    if (!this.ok) return;
    const step = this.rate * dt;
    for (const k of this.expressions()) {
      const t = this.target[k] ?? 0;
      const c = this.current[k] ?? 0;
      this.current[k] = Math.abs(t - c) <= step ? t : c + Math.sign(t - c) * step;
    }
    // 최종 가중치: 표정 + 입 근사 (입 근사는 표정 위에 더한다)
    const w: Record<string, number> = { ...this.current };
    for (const [k, a] of this.mouthMix) w[k] = Math.min(1, (w[k] ?? 0) + this.mouth * a);
    w.blink = this.blink;
    if (this.hasGaze) {
      w.look_L = Math.max(0, this.gaze.x);
      w.look_R = Math.max(0, -this.gaze.x);
      w.look_up = Math.max(0, this.gaze.y);
      w.look_down = Math.max(0, -this.gaze.y);
    }
    for (const m of this.meshes) {
      const dict = m.morphTargetDictionary!;
      const inf = m.morphTargetInfluences!;
      for (const key in dict) {
        // 규칙: blink_<X> = blink × <X>
        inf[dict[key]] = key.startsWith('blink_') ? this.blink * (w[key.slice(6)] ?? 0) : (w[key] ?? 0);
      }
    }
  }
}
