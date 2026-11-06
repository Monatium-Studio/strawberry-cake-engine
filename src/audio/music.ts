import type { AudioEngine } from './Audio';

/**
 * 음악 큐표 한 줄: 게임 스크립트가 내는 music.cue(<큐>) → 곡(AudioEngine.music의 이름)과 장면 음량.
 *
 *   track  곡 이름. 빠지면 곡은 그대로 두고 음량만 바꾸는 큐. null이면 음악을 내린다
 *   level  장면 음량 (곡 볼륨에 곱한다, 0~1). track이 있는 큐는 기본 1
 *   fade   크로스페이드·음량 이동 시간(초). 기본: 곡이 바뀌면 2.5, 음량만이면 1.5
 *
 * 규칙
 *   - 같은 곡을 가리키는 큐가 이어지면(장면을 넘어도) 곡은 끊기거나 처음부터 다시 시작하지 않고 음량만 옮긴다
 *   - 큐가 가리키는 곡이 아직 없으면 흐르던 곡을 내리고 조용히 둔다(개발 중 한 번 경고). 다른 곡으로 대신하지 않는다
 *   - 곡 하나를 여러 큐가 함께 쓰면 track만 같게 둔다 (한 곡을 음량으로 나눠 쓰기)
 *
 *   const CUES: Record<string, MusicCue> = {
 *     explore: { track: 'calm', level: 0.6 },
 *     explore_tense: { track: 'calm', level: 0.9 },   // 같은 곡, 음량만
 *     quiet: { level: 0.3 },                           // 지금 곡의 음량만
 *     battle: { track: 'battle' },
 *     silence: { track: null, fade: 3 },
 *   };
 */
export interface MusicCue {
  track?: string | null;
  level?: number;
  fade?: number;
}

/** 감독 기록 한 줄 (점검용) */
export interface MusicLogEntry {
  t: number;
  cue: string | null;
  /** 푼 곡 (null = 정지) */
  track?: string | null;
  level?: number;
  fade?: number;
  levelOnly?: boolean;
  /** 큐가 가리키는 곡이 엔진 music 표에 없다 */
  missing?: boolean;
  note?: string;
}

/** 대사 덕킹: 대사가 나오는 동안 음악을 이만큼으로 (−4.4 dB) */
const DIP = 0.6;
const DIP_ATTACK = 0.35;
const DIP_RELEASE = 1.2;
/** 대사 사이 짧은 틈에는 올리지 않는다 (초) */
const DIP_HOLD = 0.6;

/**
 * 음악 감독: cue(<큐>)를 큐표(MusicCue)로 풀어 엔진의 음악 데크를 다룬다. 음악을 트는 곳을 여기 하나로 모은다.
 *   - 곡이 같으면 이어 가고 음량만 옮긴다. 다르면 크로스페이드. 큐표에 없거나 곡 파일이 없는 큐는 흐르던 곡을 내린다
 *   - 장면 이음(enterSection): 메뉴 곡처럼 장면 밖의 곡이 남아 있으면 내린다. 끊는 자리(brk)는 앞 장면의 곡을 줄여 끈다
 *   - 대사 덕킹: 대사가 나오는 동안(watchSpeech) 음악 전체를 DIP로
 *   - 하드 컷(hardCut): 대본상 의도된 끊김만
 */
export class MusicDirector {
  readonly log: MusicLogEntry[] = [];
  private readonly warned = new Set<string>();
  private speechTimer = 0;
  private dipped = false;
  private quietSince = 0;
  /** 지금 곡의 큐 음량 (음량을 잠깐 낮췄다 되돌릴 때: scale) */
  private baseLevel = 1;

  /**
   * cues: 큐표. outsideTracks: 장면 밖에서만 쓰는 곡(메뉴 곡 등). enterSection이 남아 있으면 내린다
   */
  constructor(
    private readonly engine: AudioEngine,
    readonly cues: Record<string, MusicCue>,
    private readonly outsideTracks: readonly string[] = [],
  ) {}

  /** 음악 큐 (null = 내린다) */
  cue(name: string | null, fade?: number): void {
    const e = this.engine;
    if (name === null) {
      this.note({ cue: null, track: null, fade: fade ?? 1.5 });
      e.stopMusic(fade ?? 1.5, 'cue null');
      return;
    }
    const c = this.cues[name];
    if (!c) {
      this.warn(name, `음악 큐 ${name}: 큐표에 없다. 흐르던 곡을 내린다`);
      this.note({ cue: name, missing: true, note: '큐표에 없음' });
      e.stopMusic(2, `unknown cue ${name}`);
      return;
    }
    if (c.track === undefined) {
      // 음량만: 지금 곡이 있을 때만
      const level = c.level ?? 1;
      this.baseLevel = level;
      this.note({ cue: name, levelOnly: true, level, fade: c.fade ?? 1.5, note: e.currentMusic ?? '곡 없음' });
      e.setMusicLevel(level, c.fade ?? 1.5);
      return;
    }
    if (c.track === null) {
      this.note({ cue: name, track: null, fade: c.fade ?? 1.5 });
      e.stopMusic(c.fade ?? 1.5, `cue ${name}`);
      return;
    }
    const level = c.level ?? 1;
    if (!e.music[c.track]) {
      this.warn(c.track, `음악 큐 ${name}: 곡 ${c.track}이 엔진 music 표에 아직 없다. 흐르던 곡을 내리고 조용히 둔다`);
      this.note({ cue: name, track: c.track, missing: true, level });
      e.stopMusic(2, `missing ${c.track}`);
      return;
    }
    const same = e.currentMusic === c.track;
    const f = fade ?? c.fade ?? (same ? 1.5 : 2.5);
    this.baseLevel = level;
    this.note({ cue: name, track: c.track, level, fade: f, note: same ? '이어 감' : undefined });
    e.playMusic(c.track, f, level);
  }

  /** 지금 곡의 음량을 큐 음량의 k배로 잠깐 옮긴다 (k = 1이면 큐 음량으로 되돌린다) */
  scale(k: number, time = 1.5): void {
    this.note({ cue: null, levelOnly: true, level: this.baseLevel * k, fade: time, note: `×${k}` });
    this.engine.setMusicLevel(this.baseLevel * k, time);
  }

  /** 대본상 의도된 하드 컷 */
  hardCut(why: string, fade = 0.02): void {
    this.note({ cue: null, track: null, fade, note: `hard:${why}` });
    this.engine.stopMusic(fade, `hard:${why}`);
  }

  /** 페이드로 내린다 (장면의 끝) */
  stop(fade: number, why: string): void {
    this.note({ cue: null, track: null, fade, note: why });
    this.engine.stopMusic(fade, why);
  }

  /**
   * 장면이 시작될 때 (보통 검은 화면에서).
   * 장면 밖 곡(outsideTracks)이 남아 있으면 내린다. brk면(끊는 자리, 음악 없는 장면) 앞 장면의 곡을 2.5초에 줄여 끈다.
   * 아니면 이어 간다(다음 큐가 정한다)
   */
  enterSection(brk: boolean): void {
    const cur = this.engine.currentMusic;
    if (!cur) return;
    if (this.outsideTracks.includes(cur)) this.stop(1.5, 'outside track off');
    else if (brk) this.stop(2.5, 'section break');
  }

  /** 대사 덕킹을 멈추고 음악을 제 크기로 (장면을 걷을 때: 걷은 장면을 붙잡지 않게) */
  unwatchSpeech(): void {
    window.clearInterval(this.speechTimer);
    this.speechTimer = 0;
    this.quietSince = 0;
    if (this.dipped) this.engine.setMusicDip(1, DIP_RELEASE);
    this.dipped = false;
  }

  /** 대사 덕킹: speaking()이 참인 동안 음악을 낮춘다 (100 ms마다 본다) */
  watchSpeech(speaking: () => boolean): void {
    window.clearInterval(this.speechTimer);
    this.speechTimer = window.setInterval(() => {
      const on = speaking();
      const now = performance.now();
      if (on) this.quietSince = 0;
      else if (!this.quietSince) this.quietSince = now;
      if (on && !this.dipped) {
        this.dipped = true;
        this.engine.setMusicDip(DIP, DIP_ATTACK);
      } else if (!on && this.dipped && now - this.quietSince > DIP_HOLD * 1000) {
        this.dipped = false;
        this.engine.setMusicDip(1, DIP_RELEASE);
      }
    }, 100);
  }

  private note(e: Omit<MusicLogEntry, 't'>): void {
    this.log.push({ t: performance.now(), ...e });
    if (this.log.length > 2000) this.log.splice(0, 1000);
  }

  private warn(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    if (import.meta.env?.DEV) console.warn(`[music] ${msg}`);
  }
}
