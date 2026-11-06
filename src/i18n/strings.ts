import type { Tr } from './index';

/**
 * 엔진 UI 문자열 사전 (t(key)). 키는 '영역.이름'. 게임 대사·게임 문구는 여기 두지 않는다
 * (대사: *.lines.ts의 en·ja 필드, 게임 문구: registerCatalog). 게임 UI 문자열은 그 파일에서 registerStrings({...})로 등록한다.
 */
export const UI_STRINGS: Record<string, Tr> = {
  // ---------------------------------------------------------------- 공통
  'common.loading': { ko: '불러오는 중…', en: 'Loading…', ja: '読み込み中…' },
  'common.clickToStart': { ko: '클릭해서 시작', en: 'Click to start', ja: 'クリックしてスタート' },
  'common.click': { ko: '클릭', en: 'Click', ja: 'クリック' },
  'common.back': { ko: '돌아가기', en: 'Back', ja: '戻る' },
  'common.sec': { ko: '{n}초', en: '{n}s', ja: '{n}秒' },

  // ---------------------------------------------------------------- 인트로 (intro/Intro)
  'intro.hint': { ko: '클릭 또는 아무 키: 넘기기 · Esc: 모두 건너뛰기', en: 'Click or any key: next · Esc: skip all', ja: 'クリックまたは任意のキー：次へ · Esc：すべてスキップ' },

  // ---------------------------------------------------------------- 언어
  'lang.title': { ko: '언어 선택', en: 'Select Language', ja: '言語選択' },
  'lang.hint': { ko: '설정에서 언제든 바꿀 수 있습니다', en: 'You can change this anytime in Settings', ja: '設定からいつでも変更できます' },
  'lang.setting': { ko: '언어', en: 'Language', ja: '言語' },

  // ---------------------------------------------------------------- 일시정지·설정 (SettingsMenu)
  'menu.title': { ko: '일시정지', en: 'Paused', ja: 'ポーズ' },
  'menu.resume': { ko: '계속하기', en: 'Resume', ja: '再開' },
  'menu.settings': { ko: '설정', en: 'Settings', ja: '設定' },
  'menu.foot': { ko: 'Esc 일시정지 · 클릭하면 계속', en: 'Esc Pause · Click to resume', ja: 'Esc ポーズ · クリックで再開' },
  'settings.mouseSensitivity': { ko: '마우스 감도', en: 'Mouse Sensitivity', ja: 'マウス感度' },
  'settings.invertY': { ko: '상하 반전', en: 'Invert Y', ja: '上下反転' },
  'settings.fov': { ko: '시야각', en: 'Field of View', ja: '視野角' },
  'settings.volMaster': { ko: '음량 · 전체', en: 'Volume · Master', ja: '音量 · 全体' },
  'settings.volMusic': { ko: '음량 · 음악', en: 'Volume · Music', ja: '音量 · 音楽' },
  'settings.volSfx': { ko: '음량 · 효과음', en: 'Volume · Effects', ja: '音量 · 効果音' },
  'settings.volVoice': { ko: '음량 · 음성', en: 'Volume · Voice', ja: '音量 · ボイス' },
  'settings.graphics': { ko: '그래픽', en: 'Graphics', ja: 'グラフィック' },
  'graphics.auto': { ko: '자동', en: 'Auto', ja: '自動' },
  'graphics.high': { ko: '높음', en: 'High', ja: '高' },
  'graphics.medium': { ko: '중간', en: 'Medium', ja: '中' },
  'graphics.low': { ko: '낮음', en: 'Low', ja: '低' },
};
