import { registerStrings } from '../../src';

/** 예제 화면 문자열 (ko · en). 엔진 공용 문자열(설정 메뉴 등)은 src/i18n/strings.ts */
registerStrings({
  'demo.title': { ko: '딸기 케이크 엔진 · 기본 예제', en: 'Strawberry Cake Engine · Basic' },
  'demo.hint': { ko: '땅을 클릭하면 캡슐이 내비메시를 따라 걸어갑니다', en: 'Click the ground and the capsule walks there on the navmesh' },
  'demo.keys': { ko: 'Esc 메뉴 · N 내비메시 보기', en: 'Esc Menu · N Toggle navmesh' },
  'demo.baking': { ko: '내비메시 굽는 중…', en: 'Baking the navmesh…' },
  'demo.state': { ko: '상태: {state}', en: 'State: {state}' },
  'demo.state.idle': { ko: '대기', en: 'idle' },
  'demo.state.moving': { ko: '이동 중', en: 'moving' },
  'demo.state.arrived': { ko: '도착', en: 'arrived' },
  'demo.state.failed': { ko: '길 없음', en: 'no path' },
  'demo.menu.navmesh': { ko: '내비메시 보기 켜기·끄기', en: 'Toggle navmesh view' },
});
