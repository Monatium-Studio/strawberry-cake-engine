/**
 * strawberry-cake-engine 공개 API.
 * 모듈별로도 가져올 수 있다: import { Engine } from 'strawberry-cake-engine/core/Engine'
 */

// core: 엔진 루프·설정·입력·에셋·화면 흐름·판 수명
export * from './core/Engine';
export * from './core/config';
export * from './core/quality';
export * from './core/gpu';
export * from './core/Input';
export * from './core/Assets';
export * from './core/session';
export * from './core/flow';

// render: 툰 셰이딩·glb 로딩·굽기·행렬 얼리기
export * from './render/toon';
export * from './render/loader';
export * from './render/variants';
export * from './render/bake';
export * from './render/rigidMerge';
export * from './render/staticMatrices';
export * from './render/hiddenMatrices';
export * from './render/logDepth';
export * from './render/warp';

// physics: Rapier 래퍼·보이는 형상 레이캐스트·변경 도장·물리 거울 워커
export * from './physics/Physics';
export * from './physics/RaycastGeometry';
export * from './physics/colliderWatch';
export { MirrorClient, controllerParams, type MirrorResult } from './physics/mirror/client';
export { MirrorRecorder } from './physics/mirror/recorder';
export { CLS_SOLID, CLS_SKIP, CLS_GHOSTABLE, type ControllerParams, type GravityParams, type MirrorSnap } from './physics/mirror/protocol';

// audio: WebAudio 엔진·음악 감독·발소리
export * from './audio/Audio';
export * from './audio/music';
export * from './audio/footsteps';

// level: glb 레벨 로더와 노드 규칙
export * from './level/Level';
export * from './level/LevelLoader';
export * from './level/loading';
export * from './level/lights';
export { str, num, bool, vec3, pair, color, PREFIXES, classify, railKey, forwardOf, yawOf, forwardFromYaw, type NodeKind } from './level/props';
export * from './level/visual';

// character: 리그 캐릭터 컨트롤러
export * from './character/Character';
export * from './character/CharacterSet';
export * from './character/animBudget';
export * from './character/face';
export * from './character/ground';
export * from './character/hold';
export * from './character/poses';

// nav: 내비메시 굽기·장애물·에이전트
export * from './nav/index';

// cinematic: 카메라 레일·연출 카메라·컷 실행기·입자
export * from './cinematic/CameraRail';
export * from './cinematic/CameraDirector';
export * from './cinematic/ShotRunner';
export * from './cinematic/particles';

// ui: 닫힌 섀도 루트·스크린샷·글꼴·로딩 화면·설정 메뉴
export * from './ui/uiRoot';
export * from './ui/replay';
export * from './ui/Screenshot';
export * from './ui/fontStacks';
export * from './ui/fonts';
export * from './ui/LoadScreen';
export * from './ui/SettingsMenu';

// intro: 로고 카드 인트로 (첫 카드는 언제나 Produced by MONATIUM STUDIO · Powered by STRAWBERRY CAKE ENGINE)
export { Intro, type IntroCard, type IntroLayer, type IntroOptions, type IntroPhase } from './intro/Intro';

// i18n
export * from './i18n/index';
export { LanguageSelect } from './i18n/LanguageSelect';
export { UI_STRINGS } from './i18n/strings';
