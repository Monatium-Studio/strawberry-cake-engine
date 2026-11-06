/** 엔진 전역 상수와 사용자 설정 */
import type { GraphicsQuality } from './quality';

/**
 * 최소 렌더링 크기(CSS px). 창이 이보다 작으면 캔버스는 이 크기를 유지하고 페이지에 스크롤바가 생긴다.
 * 0이면 제한 없음. 게임마다 `new Engine(el, { minWidth, minHeight })`로 바꾼다.
 */
export const MIN_RENDER_WIDTH = 0;
export const MIN_RENDER_HEIGHT = 0;

export const MAX_PIXEL_RATIO = 2;
/** 저해상도(1배) 화면에서도 1.5배로 그려 가는 선·작은 장식이 자글거리지 않게 한다 (슈퍼샘플링) */
export const MIN_PIXEL_RATIO = 1.5;
/** 물리·게임 로직 고정 스텝 */
export const FIXED_DT = 1 / 60;
/** 탭 전환 등으로 프레임이 크게 밀렸을 때 따라잡기 상한 */
export const MAX_FRAME_DT = 0.25;
/**
 * 한 렌더 프레임에 몰아 도는 고정 스텝 상한(배속 1 기준). 느린 프레임 뒤 밀린 스텝을 한꺼번에 돌리면
 * 그 프레임이 더 느려져 끊김이 커지는 악순환이 생긴다. 넘친 몫은 버리고 게임 시간을 늦춘다.
 */
export const MAX_FIXED_STEPS = 4;

export interface Settings {
  /** 라디안 / 마우스 px */
  mouseSensitivity: number;
  invertY: boolean;
  /** 월드 카메라 세로 FOV(도). 16:9에서 68° ≈ 가로 100° */
  worldFov: number;
  /** 겹침 층(overlay 씬: 1인칭 손에 든 물건, 3D UI 등) 세로 FOV(도) */
  overlayFov: number;
  /** 1 = 기기 픽셀비, 0.5 = 절반 해상도 */
  renderScale: number;
  /** 그래픽 품질 (quality.ts). 기본 자동 */
  graphics: GraphicsQuality;
  /** 음량 (0~1). 버스: 전체, 음악, 효과음, UI, 음성 */
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  uiVolume: number;
  voiceVolume: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mouseSensitivity: 0.0022,
  invertY: false,
  worldFov: 68,
  overlayFov: 58,
  renderScale: 1,
  graphics: 'auto',
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  uiVolume: 0.7,
  voiceVolume: 1,
};

/** localStorage 열쇠. 게임마다 configureSettings({ storageKey })로 바꾼다 */
let storageKey = 'strawberry-cake.settings';

/** 설정 저장 열쇠를 바꾼다 (Engine을 만들기 전에 부른다) */
export function configureSettings(opts: { storageKey?: string }): void {
  if (opts.storageKey) storageKey = opts.storageKey;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // 저장소를 못 쓰는 환경(사생활 모드 등)에서는 기본값
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(s));
  } catch {
    // 무시
  }
}
