import type { Engine } from './Engine';
import { endSession } from './session';

/**
 * 화면 흐름 (메뉴 ↔ 레벨, 처음부터). 모두 같은 페이지에서 일어난다: 주소는 history.replaceState로만 바꾸고
 * location.href·reload로 문서를 다시 읽지 않는다. 새 문서는 사용자 제스처가 없어 AudioContext가 잠긴 채 시작하므로
 * 메뉴 곡·메뉴 소리가 클릭할 때까지 나지 않는다.
 *
 *   const flow = new ScreenFlow(engine);
 *   flow.register('menu', async (ctx) => { ...; return () => { ...걷기 } });
 *   flow.register('level', async (ctx) => { const id = ctx.params.get('id'); ... });
 *   await flow.go('menu');
 *
 * 화면을 바꿀 때: 떠나는 화면의 걷기(leave) → endSession()(모듈 상태·창 이벤트) → engine.reset()(시스템·장면·GPU 자원) → 다음 화면.
 * 덮개: 바꾸는 동안 body에 'leaving' 클래스를 단다 (게임 CSS가 검은 막을 띄운다). 다음 화면이 준비되면 걷는다.
 */
export interface ScreenContext {
  engine: Engine;
  params: URLSearchParams;
  flow: ScreenFlow;
}

/** 화면 시작 함수. 걷기 함수를 돌려줄 수 있다 (다음 화면으로 넘어가기 전에 부른다) */
export type Screen = (ctx: ScreenContext) => Promise<(() => void | Promise<void>) | void>;

/** 주소에 남길 플래그 (디버그·음소거·언어 같은 것). 화면을 바꿔도 이어 간다 */
const KEEP_FLAGS = ['nodebug', 'nosound', 'lang'];

export class ScreenFlow {
  private readonly screens = new Map<string, Screen>();
  private leave: (() => void | Promise<void>) | null = null;
  private busy: Promise<void> = Promise.resolve();
  /** 지금 화면 이름 */
  current: string | null = null;
  /** 이 페이지의 첫 화면인가 (go가 처음 불릴 때만 참): 페이지를 연 첫 화면에서만 도는 연출(로고 등)에 쓴다 */
  private first = true;
  /** 화면 오류 (점검 스크립트가 읽는다) */
  onError: (e: unknown) => void = (e) => {
    console.error(e);
    (window as unknown as { __error?: string }).__error = String((e as Error)?.stack ?? e);
  };

  constructor(
    readonly engine: Engine,
    readonly keepFlags: readonly string[] = KEEP_FLAGS,
  ) {}

  register(name: string, screen: Screen): this {
    this.screens.set(name, screen);
    return this;
  }

  /** 이 페이지의 첫 화면인가 (한 번만 참) */
  firstScreen(): boolean {
    const f = this.first;
    this.first = false;
    return f;
  }

  /** 화면을 바꾼다. 앞 화면 걷기가 끝난 뒤 다음 화면을 연다 (겹쳐 부르면 차례로) */
  go(name: string, params: Record<string, string> | URLSearchParams = {}): Promise<void> {
    const run = async () => {
      const screen = this.screens.get(name);
      if (!screen) throw new Error(`ScreenFlow: 화면 ${name} 없음`);
      const q = new URLSearchParams();
      const from = new URLSearchParams(location.search);
      for (const k of this.keepFlags) {
        const v = from.get(k);
        if (v) q.set(k, v);
      }
      const given = params instanceof URLSearchParams ? params : new URLSearchParams(params);
      for (const [k, v] of given) q.set(k, v);
      document.body.classList.add('leaving');
      try {
        if (this.leave) {
          const l = this.leave;
          this.leave = null;
          await l();
        }
        if (this.current !== null) {
          endSession();
          this.engine.reset();
        }
        if (document.pointerLockElement) document.exitPointerLock();
        q.set('screen', name);
        history.replaceState(null, '', `${location.pathname}?${q.toString()}`);
        this.current = name;
        const leave = await screen({ engine: this.engine, params: q, flow: this });
        this.leave = leave ?? null;
      } catch (e) {
        this.onError(e);
      } finally {
        document.body.classList.remove('leaving');
      }
    };
    this.busy = this.busy.then(run, run);
    return this.busy;
  }
}
