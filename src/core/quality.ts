/**
 * 그래픽 품질 (설정 「그래픽」): 렌더 배율 단계와 「자동」 조절.
 *
 * - 높음: 지금까지의 화면. 1배 화면에서도 1.5배로 그려 가는 선이 자글거리지 않게 한다 (config.ts MIN_PIXEL_RATIO)
 * - 중간: 기기 픽셀비 그대로, 1.5배까지 (1배 화면은 슈퍼샘플링 없이)
 * - 낮음: 기기 픽셀비의 3/4, 0.75~1배
 * - 자동(기본): 높음에서 시작해 GPU가 버거울 때만 한 단계씩 내린다. CPU가 병목이면(많은 캐릭터 계산 등) 배율을 내려도 빨라지지 않으니
 *   내리지 않는다. 여유가 오래 이어지면 다시 올리고, 올렸다가 바로 느려진 단계로는 그 판에서 다시 올리지 않는다
 *   (프레임 조사: 1.5배 + MSAA가 보통 사양 GPU의 60 Hz 한계에 걸려 있었다)
 */
export type GraphicsQuality = 'auto' | 'high' | 'medium' | 'low';
export const GRAPHICS_QUALITIES: GraphicsQuality[] = ['auto', 'high', 'medium', 'low'];
/** 0 높음 · 1 중간 · 2 낮음 */
export type QualityLevel = 0 | 1 | 2;
export const LEVEL_NAMES: Exclude<GraphicsQuality, 'auto'>[] = ['high', 'medium', 'low'];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function levelOf(q: GraphicsQuality, auto: QualityLevel): QualityLevel {
  return q === 'auto' ? auto : (LEVEL_NAMES.indexOf(q) as QualityLevel);
}

/** 단계별 렌더 배율 (설정의 renderScale을 곱하기 전) */
export function pixelRatioFor(level: QualityLevel, dpr: number, minRatio: number, maxRatio: number): number {
  if (level === 0) return clamp(dpr, minRatio, maxRatio);
  if (level === 1) return clamp(dpr, 1, Math.min(1.5, maxRatio));
  return clamp(dpr * 0.75, 0.75, 1);
}

/** 판단 창 (ms): 이만큼 모아 평균으로 본다 */
const WINDOW = 3000;
/** 이보다 긴 프레임 간격(평균)이면 느리다: 54 fps 밑 (60 Hz에서 열 프레임에 하나꼴로 놓친다) */
const SLOW_MS = 18.5;
/** 프레임 일(JS·그리기 명령)이 간격의 이 비율보다 작으면 GPU를 기다린 것이다 */
const GPU_SHARE = 0.6;
/** 다시 올리려면 넉넉한 창이 이만큼 이어져야 한다 */
const GOOD_WINDOWS = 5;

export class AutoQuality {
  level: QualityLevel = 0;
  /** 이 판에서 올라갈 수 있는 가장 높은 단계 (올렸다가 바로 느려지면 막는다) */
  private ceiling = 0;
  private frames = 0;
  private wall = 0;
  private work = 0;
  private good = 0;
  private win = 0;
  private upWin = -99;
  /** 마지막 판단 (점검용) */
  last: { interval: number; work: number; level: QualityLevel } | null = null;
  /** 마지막 긴 작업(50 ms+) 끝 시각: 이 창 안에 있으면 그 창은 버린다 (로딩·GC로 늘어난 간격을 GPU 탓으로 보지 않게. 크롬만 알려 준다) */
  private longTaskEnd = -1;
  private winStart = -1;

  constructor() {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.longTaskEnd = Math.max(this.longTaskEnd, e.startTime + e.duration);
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      // longtask를 모르는 브라우저: 조작 중에만 재는 것(Engine.qualityGate)으로 거른다
    }
  }

  /** 지금 창을 버린다 (재지 않는 동안: 로딩·연출·일시정지) */
  skip(): void {
    this.frames = 0;
    this.wall = 0;
    this.work = 0;
    this.winStart = -1;
  }

  /** 프레임 하나 (간격·일 ms). 단계가 바뀌면 true */
  sample(intervalMs: number, workMs: number): boolean {
    // 탭 전환·로딩으로 멈춘 프레임은 세지 않는다
    if (!(intervalMs > 0) || intervalMs > 250) return false;
    const now = performance.now();
    if (this.winStart < 0) this.winStart = now;
    this.frames++;
    this.wall += intervalMs;
    this.work += workMs;
    if (this.wall < WINDOW) return false;
    const iv = this.wall / this.frames;
    const wk = this.work / this.frames;
    const disturbed = this.longTaskEnd >= this.winStart;
    this.skip();
    if (disturbed) return false;
    this.win++;
    this.last = { interval: +iv.toFixed(2), work: +wk.toFixed(2), level: this.level };
    const slow = iv > SLOW_MS;
    if (slow && wk < iv * GPU_SHARE && this.level < 2) {
      if (this.win - this.upWin <= 2) this.ceiling = this.level + 1;
      this.level = (this.level + 1) as QualityLevel;
      this.good = 0;
      return true;
    }
    this.good = !slow && wk < iv * 0.5 ? this.good + 1 : 0;
    if (this.good >= GOOD_WINDOWS && this.level > this.ceiling) {
      this.level = (this.level - 1) as QualityLevel;
      this.good = 0;
      this.upWin = this.win;
      return true;
    }
    return false;
  }
}
