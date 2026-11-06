import * as THREE from 'three';
import { patchLogDepth } from '../render/logDepth';

/**
 * 가벼운 입자 (THREE.Points 한 번 그리기). 연기 꼬리, 불꽃, 파편 반짝임에 쓴다.
 * 입자마다 위치·속도·수명·크기·색. 풀이 차면 가장 오래된 것부터 다시 쓴다.
 * 조명을 쓰지 않는다 (조명 수가 바뀌면 셰이더가 다시 컴파일되어 끊기기 때문).
 */
export class Particles {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly grow: Float32Array;
  private readonly size0: Float32Array;
  private readonly drag: Float32Array;
  private next = 0;
  gravity = 0;

  constructor(
    readonly capacity: number,
    opts: { additive?: boolean; sizeScale?: number; soft?: boolean } = {},
  ) {
    const n = capacity;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.grow = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.drag = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: opts.sizeScale ?? 600 } },
      vertexShader: `
        attribute float size; attribute float alpha; attribute vec3 color;
        varying float vA; varying vec3 vC;
        uniform float uScale;
        void main() {
          vA = alpha; vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = alpha > 0.0 ? size * uScale / max(0.1, -mv.z) : 0.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA; varying vec3 vC;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d) * 2.0;
          float a = ${opts.soft === false ? 'step(r, 1.0)' : 'smoothstep(1.0, 0.0, r)'} * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vC, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    patchLogDepth(mat);
    mat.name = 'UNLIT_particles';
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.userData.noOutline = 1;
    this.points.userData.collider = 0;
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, o: { life: number; size: number; grow?: number; color: THREE.ColorRepresentation; drag?: number }): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    const c = new THREE.Color(o.color);
    this.col.set([c.r, c.g, c.b], i * 3);
    this.life[i] = o.life;
    this.maxLife[i] = o.life;
    this.size0[i] = o.size;
    this.size[i] = o.size;
    this.grow[i] = o.grow ?? 0;
    this.drag[i] = o.drag ?? 0;
    this.alpha[i] = 1;
  }

  /** 한 점에서 퍼지는 덩어리 */
  burst(p: THREE.Vector3, n: number, speed: number, o: { life: number; size: number; grow?: number; color: THREE.ColorRepresentation; drag?: number; up?: number }): void {
    const v = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(speed * (0.35 + Math.random() * 0.65));
      v.y += o.up ?? 0;
      this.emit(p, v, { ...o, life: o.life * (0.6 + Math.random() * 0.6) });
    }
  }

  clear(): void {
    this.alpha.fill(0);
    this.life.fill(0);
    (this.points.geometry.getAttribute('alpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    let any = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) {
          this.alpha[i] = 0;
          any = true;
        }
        continue;
      }
      any = true;
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      const j = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[j] *= dr;
      this.vel[j + 1] = this.vel[j + 1] * dr - this.gravity * dt;
      this.vel[j + 2] *= dr;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      this.size[i] = this.size0[i] * (1 + this.grow[i] * (1 - k));
      this.alpha[i] = k < 0.3 ? k / 0.3 : 1;
    }
    if (!any) return;
    const g = this.points.geometry;
    for (const n of ['position', 'color', 'size', 'alpha']) (g.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** 둥근 빛 스프라이트 (섬광, 배기염) */
export function glowSprite(color: THREE.ColorRepresentation, scale: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  const m = new THREE.SpriteMaterial({ map: t, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  m.name = 'UNLIT_glow';
  const s = new THREE.Sprite(m);
  s.scale.setScalar(scale);
  return s;
}
