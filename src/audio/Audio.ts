import type * as THREE from 'three';

/**
 * WebAudio 오디오 엔진 (게임과 무관한 범용 부분).
 *
 * 그래프: voice(source → gain → [panner]) → bus(sfx·ui·voice·music) → duck → master → destination
 *                                     ↘ reverbSend → convolver → reverbReturn → sfx
 *        음악 데크(<audio> → 데크 게인 = 곡 볼륨 × 장면 음량) → musicDip(대사 덕킹) → bus.music
 * - 버스 볼륨은 사용자 설정, duck은 연출(정적·덕킹)용 런타임 게인이다.
 * - 브라우저는 사용자 입력 전 AudioContext를 멈춰 둔다. unlock()을 첫 클릭·키 입력에서 부른다(autoUnlock).
 * - 효과음은 AudioBuffer로 미리 디코드한다(그룹 단위). 음악은 길어서 <audio> 스트리밍 + MediaElementSource로 튼다.
 * - 형식: Ogg Opus를 디코드할 수 있으면 .ogg, 아니면 .m4a(AAC, Safari 대비). 실패하면 다른 형식으로 한 번 더 시도한다.
 */

export type Bus = 'music' | 'sfx' | 'ui' | 'voice';
export const BUSES: Bus[] = ['music', 'sfx', 'ui', 'voice'];

export interface SoundDef {
  /** public/audio 기준 경로(확장자 없음). 여러 개면 변형으로 무작위 선택 */
  files: string[];
  bus?: Bus;
  /** 기본 게인(선형) */
  volume?: number;
  /** 무작위 피치 ± 반음 */
  pitchVar?: number;
  /** 무작위 볼륨 ± dB */
  volVar?: number;
  /** 이 큐의 동시 재생 수. 넘으면 가장 오래된 것을 끊는다 */
  maxVoices?: number;
  /** 같은 큐를 이 간격(초)보다 빨리 다시 부르면 건너뛴다 */
  minInterval?: number;
  /** 3D 위치음 */
  spatial?: boolean;
  refDistance?: number;
  rolloff?: number;
  maxDistance?: number;
  loop?: boolean;
  /** 실내 잔향 보내기 양 (0~1) */
  reverb?: number;
  /** 미리 불러오기 묶음 (기본 'core') */
  group?: string;
}

export interface MusicDef {
  file: string;
  volume?: number;
  /** 곡 끝에서 처음으로 넘어갈 때 겹치는 시간(초). 0이면 반복하지 않는다 */
  loopXfade?: number;
}

export interface PlayOptions {
  position?: { x: number; y: number; z: number };
  volume?: number;
  /** 재생 속도 배율 (피치 변형에 곱해진다) */
  rate?: number;
  delay?: number;
  /** 0부터. 지정하지 않으면 무작위 */
  variant?: number;
  offset?: number;
  loop?: boolean;
  fadeIn?: number;
  /** 무작위 변형을 끈다 (청취 페이지) */
  exact?: boolean;
}

export interface Voice {
  readonly cue: string;
  readonly file: string;
  readonly started: number;
  ended: boolean;
  stop(fade?: number): void;
  setVolume(v: number, ramp?: number): void;
  /** 3D 위치음의 자리를 옮긴다 (움직이는 소리원: 달리는 요정 날개의 함성 등). ramp초에 걸쳐 (기본 0.1). 2D 소리면 아무것도 안 한다 */
  setPosition(p: { x: number; y: number; z: number }, ramp?: number): void;
}

export interface AudioStats {
  state: AudioContextState | 'none';
  unlocked: boolean;
  unlockedBy: string | null;
  format: 'ogg' | 'm4a';
  buffers: number;
  failed: string[];
  requested: number;
  played: number;
  skipped: { locked: number; missing: number; interval: number; badPos: number };
  active: number;
  /** 만든 노드 사슬 수 / 풀에서 다시 쓴 횟수 */
  chains: number;
  pooled: number;
  byCue: Record<string, number>;
  log: string[];
}

interface VoiceImpl extends Voice {
  source: AudioBufferSourceNode;
  chain: Chain;
}

/** 재사용하는 노드 사슬: gain → [panner] → 버스, (panner|gain) → send → 잔향 */
interface Chain {
  key: string;
  gain: GainNode;
  panner: PannerNode | null;
  send: GainNode;
}

interface Deck {
  name: string;
  el: HTMLAudioElement;
  node: MediaElementAudioSourceNode;
  gain: GainNode;
  def: MusicDef;
  xfading: boolean;
  /** 장면 음량 (곡 볼륨에 곱한다) */
  level: number;
  /** 곡 끝 반복 이음으로 시작한 데크 */
  loop: boolean;
  /** 페이드아웃 뒤 데크를 버리는 타이머 */
  dropTimer: number;
  /** 이 곡 동안 건 요소 이벤트 (데크를 버릴 때 뗀다: 요소는 다시 쓴다) */
  events: AbortController;
}

/** 음악 상태 (점검용) */
export interface MusicState {
  decks: { name: string; file: string; pos: number; dur: number | null; gain: number; level: number; xfading: boolean; paused: boolean; loop: boolean }[];
  dip: number;
  duck: number;
}

const MAX_VOICES = 64;

const dbToGain = (db: number) => Math.pow(10, db / 20);

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly bus: Record<Bus, GainNode>;
  readonly duck: Record<Bus, GainNode>;
  /** 음악 데크 → 이 노드 → 음악 버스. 대사 덕킹(setMusicDip) */
  readonly musicDip: GainNode;
  /** 효과음 큐 정의 (청취 페이지가 덮어써서 시험할 수 있다) */
  readonly sounds: Record<string, SoundDef>;
  readonly music: Record<string, MusicDef>;
  /** 큐별 볼륨 배율 (청취 페이지에서 고른 값, localStorage) */
  overrides: Record<string, number> = {};
  format: 'ogg' | 'm4a';
  unlocked = false;
  /** unlock 직후 호출 (깨어나기 전에 기다리던 소리·음악 처리) */
  onUnlock: (() => void) | null = null;

  private readonly base: string;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, Promise<AudioBuffer | null>>();
  private readonly voices: VoiceImpl[] = [];
  private readonly pool = new Map<string, Chain[]>();
  private readonly lastPlay = new Map<string, number>();
  private readonly reverbIn: GainNode;
  private readonly reverbOut: GainNode;
  private readonly convolver: ConvolverNode;
  private decks: Deck[] = [];
  /**
   * 버린 데크의 오디오 요소와 소스 노드 (다음 곡이 다시 쓴다). Chrome은 MediaElementAudioSourceNode와 그 요소를 AudioContext가 살아 있는
   * 동안 놓지 않는다: 곡마다 새로 만들면 같은 페이지에서 화면을 오갈 때마다 요소·이벤트가 쌓였다
   */
  private readonly spareDecks: { el: HTMLAudioElement; node: MediaElementAudioSourceNode }[] = [];
  /** 줄여 끈 곡의 자리 (곡 이름 → 끈 순간의 위치·시각). 곧 같은 곡을 다시 부르면 처음이 아니라 그동안 흐른 자리부터 잇는다 */
  private readonly stopped = new Map<string, { pos: number; at: number }>();
  /** 이 시간(초) 안에 같은 곡을 다시 부르면 이어서 튼다 (단계를 건너뛰거나 되돌아가도 곡이 처음부터 다시 시작하지 않게) */
  musicResumeWithin = 45;
  private musicTimer = 0;
  private hiddenSuspended = false;
  private readonly st: AudioStats;

  constructor(opts: { base: string; sounds: Record<string, SoundDef>; music?: Record<string, MusicDef>; volumes?: Partial<Record<Bus | 'master', number>> }) {
    this.base = opts.base.endsWith('/') ? opts.base : opts.base + '/';
    this.sounds = opts.sounds;
    this.music = opts.music ?? {};
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.format = AudioEngine.pickFormat();

    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.bus = {} as Record<Bus, GainNode>;
    this.duck = {} as Record<Bus, GainNode>;
    for (const b of BUSES) {
      const g = this.ctx.createGain();
      const d = this.ctx.createGain();
      g.connect(d).connect(this.master);
      this.bus[b] = g;
      this.duck[b] = d;
    }
    this.musicDip = this.ctx.createGain();
    this.musicDip.connect(this.bus.music);
    const v = opts.volumes ?? {};
    this.setVolume('master', v.master ?? 1);
    for (const b of BUSES) this.setVolume(b, v[b] ?? 1);

    // 잔향: 지수 감쇠 노이즈 IR. 기본은 꺼져 있다(실외). setRoom()으로 켠다
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(1.3, 2.6);
    this.reverbIn = this.ctx.createGain();
    this.reverbOut = this.ctx.createGain();
    this.reverbIn.gain.value = 0;
    this.reverbIn.connect(this.convolver).connect(this.reverbOut).connect(this.bus.sfx);

    this.st = {
      state: this.ctx.state,
      unlocked: false,
      unlockedBy: null,
      format: this.format,
      buffers: 0,
      failed: [],
      requested: 0,
      played: 0,
      skipped: { locked: 0, missing: 0, interval: 0, badPos: 0 },
      active: 0,
      chains: 0,
      pooled: 0,
      byCue: {},
      log: [],
    };
    this.ctx.addEventListener('statechange', () => this.log(`context ${this.ctx.state}`));
    document.addEventListener('visibilitychange', this.onVisibility);
    this.log(`created (${this.ctx.state}, ${this.ctx.sampleRate} Hz, ${this.format})`);
  }

  static pickFormat(): 'ogg' | 'm4a' {
    try {
      const a = document.createElement('audio');
      if (a.canPlayType('audio/ogg; codecs="opus"')) return 'ogg';
    } catch {
      // 무시
    }
    return 'm4a';
  }

  log(msg: string): void {
    const line = `${(performance.now() / 1000).toFixed(2)} ${msg}`;
    this.st.log.push(line);
    if (this.st.log.length > 80) this.st.log.shift();
  }

  // ── 잠금 해제 ──────────────────────────────────────────────────────
  /** 사용자 입력(클릭·키)에서 부른다. 이미 깨어 있으면 바로 true */
  async unlock(by = 'manual'): Promise<boolean> {
    if (this.ctx.state === 'running') {
      if (!this.unlocked) this.markUnlocked(by);
      return true;
    }
    try {
      await this.ctx.resume();
    } catch (e) {
      this.log(`resume failed: ${String(e)}`);
    }
    // resume() 프로미스가 끝나도 상태 갱신이 한 틱 늦을 때가 있다
    const ok = (this.ctx.state as AudioContextState) === 'running';
    if (ok && !this.unlocked) this.markUnlocked(by);
    return ok;
  }

  private markUnlocked(by: string): void {
    this.unlocked = true;
    this.st.unlocked = true;
    this.st.unlockedBy = by;
    this.log(`unlocked by ${by}`);
    for (const d of this.decks) void d.el.play().catch(() => {});
    this.onUnlock?.();
  }

  /** 문서의 첫 pointerdown·keydown·touchend에서 unlock (캡처 단계라 다른 핸들러가 전파를 막아도 받는다) */
  autoUnlock(target: Window = window): void {
    const handler = (e: Event) => {
      // Esc는 브라우저가 사용자 활성화로 치지 않는다
      if (e instanceof KeyboardEvent && (e.key === 'Escape' || e.repeat)) return;
      void this.unlock(e.type).then((ok) => {
        if (ok) for (const t of types) target.removeEventListener(t, handler, true);
      });
    };
    const types = ['pointerdown', 'keydown', 'touchend', 'mousedown'];
    for (const t of types) target.addEventListener(t, handler, true);
  }

  private readonly onVisibility = () => {
    if (document.hidden) {
      if (this.ctx.state === 'running') {
        this.hiddenSuspended = true;
        void this.ctx.suspend();
        for (const d of this.decks) d.el.pause();
        this.log('hidden: suspended');
      }
    } else if (this.hiddenSuspended) {
      this.hiddenSuspended = false;
      void this.ctx.resume();
      for (const d of this.decks) void d.el.play().catch(() => {});
      this.log('visible: resumed');
    }
  };

  // ── 볼륨 ───────────────────────────────────────────────────────────
  setVolume(bus: Bus | 'master', v: number, ramp = 0.05): void {
    const node = bus === 'master' ? this.master : this.bus[bus];
    const t = this.ctx.currentTime;
    node.gain.cancelScheduledValues(t);
    node.gain.setTargetAtTime(Math.max(0, v), t, ramp / 3);
  }

  /** 연출용 덕킹: 버스를 level(0~1)로 time초 동안 옮긴다 */
  setDuck(bus: Bus | 'all', level: number, time = 0.3): void {
    const t = this.ctx.currentTime;
    for (const b of bus === 'all' ? BUSES : [bus]) {
      const g = this.duck[b].gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(Math.max(0, level), t + Math.max(0.005, time));
    }
  }

  /** 실내 잔향: wet 0이면 끔 */
  setRoom(wet: number, decay?: number): void {
    if (decay) this.convolver.buffer = this.makeImpulse(decay, 2.6);
    this.reverbIn.gain.setTargetAtTime(Math.max(0, wet), this.ctx.currentTime, 0.1);
    this.log(`room wet=${wet}${decay ? ` decay=${decay}` : ''}`);
  }

  private makeImpulse(seconds: number, k: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(seconds * rate);
    const buf = this.ctx.createBuffer(2, n, rate);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // 초기 반사 몇 개 + 지수 감쇠 확산
        d[i] = rnd() * Math.pow(1 - t, k) * (i < rate * 0.004 ? 0.2 : 1);
      }
    }
    return buf;
  }

  // ── 불러오기 ───────────────────────────────────────────────────────
  url(file: string, fmt = this.format): string {
    return `${this.base}${file}.${fmt}`;
  }

  /** 그룹(또는 큐 목록)의 버퍼를 불러온다 */
  async preload(group: string | string[] = 'core'): Promise<void> {
    const cues = Array.isArray(group) ? group : Object.keys(this.sounds).filter((k) => (this.sounds[k].group ?? 'core') === group);
    const files = new Set<string>();
    for (const c of cues) for (const f of this.sounds[c]?.files ?? []) files.add(f);
    const t0 = performance.now();
    await Promise.all([...files].map((f) => this.loadFile(f)));
    this.log(`preload ${Array.isArray(group) ? `${group.length} cues` : group}: ${files.size} files ${Math.round(performance.now() - t0)} ms`);
  }

  loadFile(file: string): Promise<AudioBuffer | null> {
    const have = this.buffers.get(file);
    if (have) return Promise.resolve(have);
    let p = this.loading.get(file);
    if (!p) {
      p = this.fetchDecode(file);
      this.loading.set(file, p);
    }
    return p;
  }

  private async fetchDecode(file: string): Promise<AudioBuffer | null> {
    const order: ('ogg' | 'm4a')[] = this.format === 'ogg' ? ['ogg', 'm4a'] : ['m4a', 'ogg'];
    for (const fmt of order) {
      try {
        const res = await fetch(this.url(file, fmt));
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(data);
        this.buffers.set(file, buf);
        this.st.buffers = this.buffers.size;
        if (fmt !== this.format) {
          this.log(`${this.format} decode failed → ${fmt}`);
          this.format = fmt;
          this.st.format = fmt;
        }
        return buf;
      } catch (e) {
        if (fmt === order[1]) {
          this.st.failed.push(`${file}: ${String(e)}`);
          this.log(`load failed ${file}: ${String(e)}`);
        }
      }
    }
    return null;
  }

  has(file: string): boolean {
    return this.buffers.has(file);
  }

  // ── 재생 ───────────────────────────────────────────────────────────
  /** 효과음 큐 재생. 잠겨 있거나 버퍼가 없으면 null (요청 수는 통계에 남는다) */
  play(cue: string, opts: PlayOptions = {}): Voice | null {
    const def = this.sounds[cue];
    this.st.requested++;
    this.st.byCue[cue] = (this.st.byCue[cue] ?? 0) + 1;
    const pos = opts.position;
    if (pos && !(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))) {
      // NaN 위치를 패너에 넣으면 AudioParam이 예외를 던져 부른 이벤트 처리기까지 멈춘다. 소리 하나를 버리고, 개발 중에는 큐 이름을 남긴다
      this.st.skipped.badPos++;
      if (import.meta.env.DEV) console.error(`[audio] ${cue}: non-finite position (${pos.x}, ${pos.y}, ${pos.z})\n${new Error().stack ?? ''}`);
      return null;
    }
    if (!def || !def.files.length) {
      this.st.skipped.missing++;
      return null;
    }
    const now = this.ctx.currentTime;
    if (def.minInterval) {
      const last = this.lastPlay.get(cue) ?? -Infinity;
      if (now - last < def.minInterval) {
        this.st.skipped.interval++;
        return null;
      }
    }
    this.lastPlay.set(cue, now);
    if (this.ctx.state !== 'running') {
      this.st.skipped.locked++;
      return null;
    }
    const idx = opts.variant !== undefined ? opts.variant % def.files.length : Math.floor(Math.random() * def.files.length);
    const file = def.files[idx];
    const buf = this.buffers.get(file);
    if (!buf) {
      // 아직 안 불러왔으면 불러 두고 이번은 건너뛴다
      void this.loadFile(file);
      this.st.skipped.missing++;
      return null;
    }
    this.limit(cue, def.maxVoices ?? 8);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const loop = opts.loop ?? def.loop ?? false;
    src.loop = loop;
    const pv = opts.exact ? 0 : def.pitchVar ?? 0;
    const semis = pv ? (Math.random() * 2 - 1) * pv : 0;
    src.playbackRate.value = Math.pow(2, semis / 12) * (opts.rate ?? 1);

    const spatial = !!(def.spatial && opts.position);
    const chain = this.acquire(def.bus ?? 'sfx', spatial);
    const { gain, panner, send } = chain;
    const vv = opts.exact ? 0 : def.volVar ?? 0;
    const level = (def.volume ?? 1) * (this.overrides[cue] ?? 1) * (opts.volume ?? 1) * (vv ? dbToGain((Math.random() * 2 - 1) * vv) : 1);
    const when = now + (opts.delay ?? 0);
    gain.gain.cancelScheduledValues(0);
    if (opts.fadeIn) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(level, when + opts.fadeIn);
    } else gain.gain.setValueAtTime(level, now);
    src.connect(gain);

    if (panner && opts.position) {
      panner.refDistance = def.refDistance ?? 2;
      panner.rolloffFactor = def.rolloff ?? 1;
      panner.maxDistance = def.maxDistance ?? 200;
      const p = opts.position;
      if (panner.positionX) {
        panner.positionX.value = p.x;
        panner.positionY.value = p.y;
        panner.positionZ.value = p.z;
      } else panner.setPosition(p.x, p.y, p.z);
    }
    send.gain.value = def.reverb ?? 0;

    const v: VoiceImpl = {
      cue,
      file,
      started: when,
      ended: false,
      source: src,
      chain,
      stop: (fade = 0.03) => {
        if (v.ended) return;
        const t = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + Math.max(0.005, fade));
        try {
          src.stop(t + Math.max(0.005, fade) + 0.01);
        } catch {
          // 이미 멈춤
        }
      },
      setPosition: (p, ramp = 0.1) => {
        if (v.ended || !spatial || !panner || !(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) return;
        const t = this.ctx.currentTime;
        if (panner.positionX) {
          for (const [ap, val] of [[panner.positionX, p.x], [panner.positionY, p.y], [panner.positionZ, p.z]] as const) {
            ap.cancelScheduledValues(t);
            ap.setValueAtTime(ap.value, t);
            ap.linearRampToValueAtTime(val, t + Math.max(0.005, ramp));
          }
        } else panner.setPosition(p.x, p.y, p.z);
      },
      setVolume: (x, ramp = 0.1) => {
        const t = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(x * (def.volume ?? 1) * (this.overrides[cue] ?? 1), t + Math.max(0.005, ramp));
      },
    };
    src.onended = () => {
      v.ended = true;
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
      src.disconnect();
      this.release(chain);
      this.st.active = this.voices.length;
    };
    src.start(when, opts.offset ?? 0);
    this.voices.push(v);
    this.st.played++;
    this.st.active = this.voices.length;
    return v;
  }

  /** 노드 사슬 풀: 버스·3D 여부별로 끝난 사슬을 다시 쓴다 (소스 노드는 WebAudio 규칙상 일회용) */
  private acquire(bus: Bus, spatial: boolean): Chain {
    const key = `${bus}|${spatial ? 3 : 2}`;
    const c = this.pool.get(key)?.pop();
    if (c) {
      this.st.pooled++;
      return c;
    }
    const gain = this.ctx.createGain();
    let panner: PannerNode | null = null;
    if (spatial) {
      panner = this.ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      gain.connect(panner);
    }
    const out = panner ?? gain;
    out.connect(this.bus[bus]);
    const send = this.ctx.createGain();
    send.gain.value = 0;
    if (bus === 'sfx') out.connect(send).connect(this.reverbIn);
    this.st.chains++;
    return { key, gain, panner, send };
  }

  private release(c: Chain): void {
    c.gain.gain.cancelScheduledValues(0);
    c.gain.gain.value = 0;
    c.send.gain.value = 0;
    let list = this.pool.get(c.key);
    if (!list) this.pool.set(c.key, (list = []));
    if (list.length < 32) list.push(c);
    else {
      c.gain.disconnect();
      c.panner?.disconnect();
      c.send.disconnect();
    }
  }

  /** 큐별·전체 동시 재생 제한: 넘치면 가장 오래된 목소리를 짧게 끊는다 */
  private limit(cue: string, max: number): void {
    const same = this.voices.filter((v) => v.cue === cue && !v.ended);
    if (same.length >= max) same[0].stop(0.02);
    if (this.voices.length >= MAX_VOICES) this.voices.find((v) => !v.ended && !v.source.loop)?.stop(0.02);
  }

  stopCue(cue: string, fade = 0.1): void {
    for (const v of this.voices) if (v.cue === cue) v.stop(fade);
  }

  stopAll(fade = 0.05, bus?: Bus): void {
    for (const v of [...this.voices]) if (!bus || (this.sounds[v.cue]?.bus ?? 'sfx') === bus) v.stop(fade);
  }

  // ── 리스너 ─────────────────────────────────────────────────────────
  private readonly _m = new Float32Array(16);
  /** 카메라 월드 행렬로 리스너 위치·방향을 맞춘다 (매 렌더 프레임) */
  updateListener(camera: THREE.Object3D): void {
    // 잠긴(첫 클릭 전 사파리 등)·멈춘 컨텍스트에 AudioParam을 매 프레임 쓰면 메인 스레드를 크게 먹는다 (프레임 조사: 50초 중 32%).
    // 들리지 않으니 건너뛰고, 풀린 뒤 첫 프레임에 맞춘다
    if (this.ctx.state !== 'running') return;
    const l = this.ctx.listener;
    const e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const ux = e[4], uy = e[5], uz = e[6];
    if (l.positionX) {
      l.positionX.value = px;
      l.positionY.value = py;
      l.positionZ.value = pz;
      l.forwardX.value = fx;
      l.forwardY.value = fy;
      l.forwardZ.value = fz;
      l.upX.value = ux;
      l.upY.value = uy;
      l.upZ.value = uz;
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // ── 음악 ───────────────────────────────────────────────────────────
  /**
   * 음악 큐 재생. 이미 같은 곡이면 그대로 두고 장면 음량(level)만 옮긴다(처음부터 다시 틀지 않는다).
   * 같은 곡이 페이드아웃 중이면 그 데크를 되살린다. 아니면 이전 곡과 fade초 크로스페이드.
   * 줄여 끈 지 musicResumeWithin초가 안 된 곡은 처음이 아니라 끈 자리 + 그동안 흐른 시간부터 튼다(조용히 흐르고 있던 것처럼)
   */
  playMusic(name: string, fade = 2, level = 1): void {
    const def = this.music[name];
    if (!def) {
      this.log(`music missing ${name}`);
      return;
    }
    const cur = this.decks.find((d) => !d.xfading);
    if (cur?.name === name) {
      this.setMusicLevel(level, fade);
      return;
    }
    // 같은 곡이 줄어드는 중 (반복 이음의 꼬리는 빼고, 가장 최근 것): 그 자리에서 다시 올린다
    const back = [...this.decks].reverse().find((d) => d.xfading && d.name === name && !this.isLoopTail(d));
    for (const d of this.decks) if (d !== back) this.fadeOutDeck(d, fade);
    if (back) this.reviveDeck(back, fade, level);
    else {
      const st = this.stopped.get(name);
      const away = st ? (performance.now() - st.at) / 1000 : Infinity;
      this.startDeck(name, def, fade, level, false, away < this.musicResumeWithin ? st!.pos + away : 0);
    }
    if (!this.musicTimer) this.musicTimer = window.setInterval(() => this.tickMusic(), 200);
  }

  /** 모든 곡을 fade초에 걸쳐 내린다. why는 기록용 (대본의 하드 컷은 'hard:…') */
  stopMusic(fade = 2, why = ''): void {
    if (why) this.log(`music stop ${fade}s ${why}`);
    for (const d of this.decks) this.fadeOutDeck(d, fade);
  }

  /** 지금 곡의 장면 음량을 time초에 걸쳐 옮긴다 (곡 볼륨에 곱한다) */
  setMusicLevel(level: number, time = 1.5): void {
    const d = this.decks.find((x) => !x.xfading);
    if (!d) return;
    d.level = Math.max(0, level);
    this.rampDeck(d, (d.def.volume ?? 1) * d.level, time);
  }

  /** 대사 덕킹: 음악 전체를 level(0~1)로 time초에 걸쳐 */
  setMusicDip(level: number, time = 0.4): void {
    const g = this.musicDip.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(Math.max(0, level), t, Math.max(0.01, time) / 3);
  }

  get currentMusic(): string | null {
    return this.decks.find((d) => !d.xfading)?.name ?? null;
  }

  /** 점검용 음악 상태 */
  musicState(): MusicState {
    return {
      decks: this.decks.map((d) => ({
        name: d.name,
        file: d.def.file,
        pos: d.el.currentTime,
        dur: Number.isFinite(d.el.duration) ? d.el.duration : null,
        gain: d.gain.gain.value,
        level: d.level,
        xfading: d.xfading,
        paused: d.el.paused,
        loop: d.loop,
      })),
      dip: this.musicDip.gain.value,
      duck: this.duck.music.gain.value,
    };
  }

  private startDeck(name: string, def: MusicDef, fade: number, level = 1, loop = false, offset = 0): Deck {
    // 버린 데크의 요소·소스 노드가 있으면 다시 쓴다 (spareDecks)
    const spare = this.spareDecks.pop();
    const el = spare?.el ?? new Audio();
    const events = new AbortController();
    const signal = events.signal;
    el.preload = 'auto';
    el.src = this.url(def.file, this.format);
    if (offset > 0) {
      // 이어 틀기: 길이를 알게 되면 그 자리로 (곡보다 길면 감아 돈다. 끝의 반복 이음 구간이면 tickMusic이 처음과 겹친다)
      el.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(el.duration) && el.duration > 1) el.currentTime = offset % el.duration;
      }, { once: true, signal });
      this.stopped.delete(name);
    }
    const node = spare?.node ?? this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime((def.volume ?? 1) * level, t + Math.max(0.01, fade));
    node.connect(gain).connect(this.musicDip);
    const deck: Deck = { name, el, node, gain, def, xfading: false, level, loop, dropTimer: 0, events };
    el.addEventListener('error', () => {
      if (el.src.endsWith('.ogg')) el.src = this.url(def.file, 'm4a');
    }, { signal });
    el.addEventListener('ended', () => this.dropDeck(deck), { signal });
    this.decks.push(deck);
    void el.play().catch(() => this.log(`music ${name} waiting for unlock`));
    this.log(`music ${name}${loop ? ' (loop)' : offset > 0 ? ` (resume ${offset.toFixed(1)}s)` : ''}`);
    return deck;
  }

  private rampDeck(d: Deck, to: number, time: number): void {
    const t = this.ctx.currentTime;
    const g = d.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(Math.max(0, to), t + Math.max(0.01, time));
  }

  private fadeOutDeck(d: Deck, fade: number): void {
    if (d.xfading) return;
    d.xfading = true;
    this.rampDeck(d, 0, fade);
    d.dropTimer = window.setTimeout(() => this.dropDeck(d), fade * 1000 + 100);
  }

  /** 페이드아웃 중인 데크를 지금 자리에서 다시 올린다 */
  private reviveDeck(d: Deck, fade: number, level: number): void {
    window.clearTimeout(d.dropTimer);
    d.dropTimer = 0;
    d.xfading = false;
    d.level = level;
    this.rampDeck(d, (d.def.volume ?? 1) * level, fade);
    this.log(`music ${d.name} revived`);
  }

  /** 곡 끝 반복 이음에서 줄어드는 앞 데크 (뒤에 같은 곡의 반복 데크가 있다) */
  private isLoopTail(d: Deck): boolean {
    const i = this.decks.indexOf(d);
    return this.decks.slice(i + 1).some((x) => x.name === d.name && x.loop);
  }

  private dropDeck(d: Deck): void {
    if (!this.decks.includes(d)) return;
    window.clearTimeout(d.dropTimer);
    // 같은 곡의 다른 데크(반복 이음)가 없으면 끈 자리를 기억한다
    if (!this.decks.some((x) => x !== d && x.name === d.name)) this.stopped.set(d.name, { pos: d.el.currentTime, at: performance.now() });
    d.events.abort();
    d.el.pause();
    d.node.disconnect();
    d.gain.disconnect();
    this.decks = this.decks.filter((x) => x !== d);
    // 요소는 비워서(받아 둔 곡 데이터를 놓는다) 다음 곡이 다시 쓴다
    d.el.removeAttribute('src');
    d.el.load();
    this.spareDecks.push({ el: d.el, node: d.node });
  }

  private tickMusic(): void {
    for (const d of [...this.decks]) {
      const x = d.def.loopXfade ?? 0;
      if (d.xfading || !x || !isFinite(d.el.duration) || d.el.paused) continue;
      const left = d.el.duration - d.el.currentTime;
      if (left <= x + 0.25) {
        // 곡 끝: 처음부터 새 데크를 겹쳐 튼다 (장면 음량은 이어받는다). 앞 데크는 곡이 끝나기 전에 0이 되게 남은 시간 안에 내린다
        // (예전에는 x초에 내려서, 200 ms 간격으로 늦게 본 만큼 곡이 먼저 끝나 -16 dB 언저리에서 뚝 끊겼다)
        this.fadeOutDeck(d, Math.max(0.05, Math.min(x, left - 0.12)));
        this.startDeck(d.name, d.def, Math.min(1, x / 2), d.level, true);
      }
    }
  }

  // ── 통계 ───────────────────────────────────────────────────────────
  stats(): AudioStats {
    this.st.state = this.ctx.state;
    this.st.active = this.voices.length;
    return JSON.parse(JSON.stringify(this.st)) as AudioStats;
  }

  resetStats(): void {
    this.st.requested = this.st.played = 0;
    this.st.skipped = { locked: 0, missing: 0, interval: 0, badPos: 0 };
    this.st.byCue = {};
  }
}
