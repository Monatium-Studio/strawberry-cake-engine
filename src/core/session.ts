/**
 * 한 판의 수명 (화면 하나 = 메뉴에서 들어가 메뉴로 나오거나 '처음부터'로 다시 시작할 때까지).
 * 페이지를 옮기거나 새로고침하지 않고 같은 페이지에서 화면을 바꾸면(core/flow.ts) 오디오가 끊기지 않는다.
 * 그래서 한 페이지에서 레벨이 여러 번 돈다. 모듈 수준 상태(스크립트의 상태 객체, 레벨·준비 캐시, 한 번만 거는 훅, 창 이벤트)는
 * 판이 끝날 때 처음으로 되돌린다.
 *
 *   const S = sessionState(() => ({ level: null, hooked: false }));   // 판이 끝나면 init()으로 되돌린다
 *   onSessionEnd(() => cache.clear());                                // 그 밖의 정리
 *   window.addEventListener('keydown', fn, { signal: sessionSignal() }); // 판이 끝나면 떨어진다
 *   const ep = sessionEpoch(); await load(); if (ep !== sessionEpoch()) return;  // 끝난 판의 늦은 비동기 결과는 버린다
 *
 * 화면 흐름(ScreenFlow)이 화면을 걷을 때 endSession()을 부른다.
 */

const resets: (() => void)[] = [];
let epoch = 0;
let ctl = new AbortController();

/** 판이 끝날 때 부를 정리 (모듈을 처음 읽을 때 건다) */
export function onSessionEnd(fn: () => void): void {
  resets.push(fn);
}

/** 판마다 새로 시작하는 모듈 상태. 판이 끝나면 같은 객체를 init()의 값으로 되돌린다 (참조는 그대로) */
export function sessionState<T extends object>(init: () => T): T {
  const s = init();
  onSessionEnd(() => {
    for (const k of Object.keys(s)) delete (s as Record<string, unknown>)[k];
    Object.assign(s, init());
  });
  return s;
}

/** 이번 판의 창·문서 이벤트를 묶는 신호: addEventListener(…, { signal: sessionSignal() }) */
export function sessionSignal(): AbortSignal {
  return ctl.signal;
}

/** 판 번호 (판이 끝날 때마다 오른다): 늦게 끝난 비동기 작업이 다음 판에 끼어들지 않게 */
export function sessionEpoch(): number {
  return epoch;
}

/** 판을 끝낸다: 이벤트를 떼고 모듈 상태를 되돌린다 */
export function endSession(): void {
  epoch++;
  ctl.abort();
  ctl = new AbortController();
  for (const fn of resets) {
    try {
      fn();
    } catch (e) {
      console.error('[session] 정리 실패', e);
    }
  }
}
