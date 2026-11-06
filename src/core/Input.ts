/** 키보드·마우스 입력. 포인터 락 상태에서 마우스 이동을 시점 회전으로 쓴다. */

/** 기본 액션 이름. 게임은 자기 액션 표를 `new Input(el, { bindings })`로 준다 */
export type DefaultAction =
  | 'forward' | 'back' | 'left' | 'right'
  | 'jump' | 'crouch' | 'sprint'
  | 'primary' | 'secondary' | 'interact'
  | 'next' | 'prev';

/** 키 코드(KeyboardEvent.code) 또는 Mouse0/1/2, WheelUp/WheelDown */
export const DEFAULT_BINDINGS: Record<DefaultAction, string[]> = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  jump: ['Space'],
  crouch: ['KeyC', 'ControlLeft'],
  sprint: ['ShiftLeft'],
  primary: ['Mouse0'],
  secondary: ['Mouse2'],
  interact: ['KeyF'],
  next: ['WheelDown'],
  prev: ['WheelUp'],
};

export interface InputOptions<A extends string> {
  /** 액션 → 키 코드 목록. 없으면 DEFAULT_BINDINGS */
  bindings?: Record<A, string[]>;
  /** 조작 중(포인터 락)에 페이지를 떠나려 하면 확인을 묻는다 (기본 true) */
  confirmLeave?: boolean;
}

/** 조작 중에 브라우저 기본 동작(스크롤 등)을 막을 키 */
const BLOCK_DEFAULT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'ControlLeft', 'KeyC']);
const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
const CTRL_CODES = new Set(['ControlLeft', 'ControlRight']);
const SHIFT_CODES = new Set(['ShiftLeft', 'ShiftRight']);
/**
 * Ctrl은 앱 단축키 조합(스크린샷 Ctrl+Alt+Shift+P)의 첫 키일 수 있다. 게임 조작(앉기 등)으로 넘기기 전에 이만큼 기다린다.
 * 그 사이 Alt·Meta가 오면 조합이라 넘기지 않고, 아니면 실제로 누른 때로 거슬러 넘긴다
 */
const CTRL_WAIT_MS = 120;

/** Ctrl·Alt·Meta 중 둘 이상: 앱 단축키 조합 (게임 조작이 아니다) */
const isAppChord = (e: KeyboardEvent) => Number(e.ctrlKey) + Number(e.altKey) + Number(e.metaKey) >= 2;

export class Input<A extends string = DefaultAction> {
  readonly bindings: Record<A, string[]>;
  locked = false;
  /** 포인터 락 없이도 조작을 받을지 (자동 테스트·디버그용) */
  allowUnlocked = false;
  /**
   * true면 게임 조작을 막는다 (연출 중). isDown/wasPressed가 false를 돌려주고 시점도 받지 않는다.
   * 키의 실제 눌림 상태는 계속 기록하므로, 풀었을 때 누르고 있던 키는 그대로 이어진다.
   */
  blocked = false;
  /** true면 시점만 받고 나머지 조작(이동 등)은 막는다 (연출 중 제한된 조작) */
  lookOnly = false;
  onLockChange: ((locked: boolean) => void) | null = null;

  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  /** 키를 누른 때 (performance.now 기준). heldFor용 */
  private readonly downAt = new Map<string, number>();
  /** 기다리는 동안 놓은 Ctrl: 엣지와 함께 다음 endFrame까지 눌린 것으로 친다 */
  private readonly pulse = new Set<string>();
  /** 실제로 눌려 있는 수식 키 (락·차단과 상관없이) */
  private readonly heldMods = new Set<string>();
  /** 게임 조작으로 넘기기를 기다리는 Ctrl (until이 지나면 읽을 때 넘긴다: 그 전에 들어온 키를 먼저 본다) */
  private ctrlWait: { code: string; at: number; until: number } | null = null;
  /** 앱 단축키 조합에 쓰인 Ctrl: 수식 키를 모두 놓을 때까지 게임 조작으로 받지 않는다 */
  private ctrlSwallowed = false;
  private lookX = 0;
  private lookY = 0;
  /** 창·문서·캔버스 이벤트를 한꺼번에 뗀다 (dispose) */
  private readonly ac = new AbortController();

  constructor(private readonly target: HTMLElement, opts: InputOptions<A> = {}) {
    this.bindings = structuredClone(opts.bindings ?? (DEFAULT_BINDINGS as unknown as Record<A, string[]>));
    const confirmLeave = opts.confirmLeave ?? true;
    // 이미 잡혀 있는 락 (메뉴 클릭에서 잡은 락을 같은 페이지의 다음 화면이 이어받는다)
    this.locked = this.lockedHere();
    const signal = this.ac.signal;

    window.addEventListener('keydown', (e) => {
      if (MODIFIER_CODES.has(e.code)) this.heldMods.add(e.code);
      if (!this.locked && !this.allowUnlocked) return;
      // 조작 중에는 Ctrl 계열 브라우저 단축키를 모두 막는다: Ctrl을 조작 키로 쓰면 Ctrl+R(새로고침)·Ctrl+F·Ctrl+S·Ctrl+D·Ctrl+P 등이
      // 조작 중에 터진다. 앱 단축키(스크린샷)는 자기 리스너가 그대로 받는다.
      // 브라우저가 페이지에 넘기지 않는 Ctrl+W·T·N·Tab은 막을 수 없다: 키보드 잠금(전체 화면)과 나가기 확인(beforeunload)이 대신 지킨다
      if (e.ctrlKey && !e.metaKey) e.preventDefault();
      // Ctrl/⌘/Alt 중 둘 이상이 눌린 조합은 앱 단축키(스크린샷 Ctrl+Alt+Shift+P 등)다: 게임 조작으로 받지 않고,
      // 조합을 누르는 동안 먼저 눌린 수식 키(Shift 등)도 놓는다. 기다리던 Ctrl은 버린다
      if (isAppChord(e)) {
        this.swallowChord();
        return;
      }
      if (BLOCK_DEFAULT.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      if (CTRL_CODES.has(e.code)) {
        this.waitCtrl(e.code, e.timeStamp);
        return;
      }
      // Shift가 Ctrl과 함께 오면 Alt가 이어 올 수 있으니 더 기다린다 (Ctrl → Shift → Alt 순서)
      if (this.ctrlWait && SHIFT_CODES.has(e.code)) this.ctrlWait.until = performance.now() + CTRL_WAIT_MS;
      this.press(e.code);
    }, { signal });
    window.addEventListener('keyup', (e) => {
      if (this.ctrlWait?.code === e.code) this.flushCtrl(true);
      this.release(e.code);
      this.heldMods.delete(e.code);
      if (this.heldMods.size === 0) this.ctrlSwallowed = false;
    }, { signal });
    window.addEventListener('blur', () => {
      this.clearKeys();
      this.heldMods.clear();
      this.ctrlSwallowed = false;
    }, { signal });

    target.addEventListener('mousedown', (e) => {
      if (!this.locked && !this.allowUnlocked) return;
      e.preventDefault();
      this.press(`Mouse${e.button}`);
    }, { signal });
    window.addEventListener('mouseup', (e) => this.release(`Mouse${e.button}`), { signal });
    target.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    }, { signal });

    // 스크롤바가 있어도 조작 중에는 휠이 페이지를 굴리지 않게
    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.locked) return;
        e.preventDefault();
        const code = e.deltaY > 0 ? 'WheelDown' : 'WheelUp';
        this.pressed.add(code);
      },
      { passive: false, signal },
    );

    document.addEventListener('pointerlockchange', () => {
      this.locked = this.lockedHere();
      if (!this.locked) this.clearKeys();
      this.keyboardLock(this.locked);
      this.onLockChange?.(this.locked);
    }, { signal });
    this.keyboardLock(this.locked);

    // 조작 중(포인터 락)에 페이지를 떠나려 하면 확인을 묻는다: 막을 수 없는 Ctrl+W(Ctrl 조작 키 + W 이동 = 탭 닫기) 등.
    // Esc로 락을 푼 뒤의 새로고침·닫기는 묻지 않는다
    window.addEventListener('beforeunload', (e) => {
      if (!this.locked || !confirmLeave) return;
      e.preventDefault();
      e.returnValue = '';
    }, { signal });
  }

  /**
   * 포인터 락이 target에 걸려 있는지. target이 섀도 트리 안(UI는 닫힌 섀도 루트, src/ui/uiRoot.ts)이면
   * document.pointerLockElement는 호스트를 돌려주므로 target이 든 트리(문서 또는 섀도 루트)의 pointerLockElement로 본다
   */
  private lockedHere(): boolean {
    const tree = this.target.getRootNode() as Document | ShadowRoot;
    return (tree.pointerLockElement ?? null) === this.target;
  }

  /**
   * 키보드 잠금 (Chromium 계열, 전체 화면에서만 효력): 브라우저가 가로채는 Ctrl+W·T·N·Tab 등도 게임이 받는다.
   * 지원하지 않거나 전체 화면이 아니면 아무 일도 없다
   */
  private keyboardLock(on: boolean): void {
    const kb = (navigator as Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void } }).keyboard;
    try {
      if (on) void kb?.lock?.()?.catch(() => {});
      else kb?.unlock?.();
    } catch {
      /* 지원하지 않음 */
    }
  }

  /**
   * 창·문서·캔버스 이벤트를 모두 뗀다 (같은 페이지에서 화면을 바꿀 때: 화면마다 Input을 새로 만든다).
   * 포인터 락은 그대로 둔다 (다음 화면의 Input이 이어받는다)
   */
  dispose(): void {
    this.ac.abort();
    this.onLockChange = null;
    this.clearKeys();
    this.heldMods.clear();
    this.pressed.clear();
  }

  get active(): boolean {
    return !this.blocked && (this.locked || this.allowUnlocked);
  }

  requestLock(): void {
    const el = this.target as HTMLElement & { requestPointerLock(opts?: { unadjustedMovement?: boolean }): Promise<void> | void };
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => el.requestPointerLock());
      }
    } catch {
      el.requestPointerLock();
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(action: A): boolean {
    this.settleCtrl();
    if (this.blocked || this.lookOnly) return false;
    return this.bindings[action].some((c) => this.down.has(c) || this.pulse.has(c));
  }

  /** action 키를 누르고 있은 시간(초), 안 눌렸으면 0. 늦게 넘긴 Ctrl도 실제로 누른 때부터 센다 */
  heldFor(action: A): number {
    this.settleCtrl();
    if (this.blocked || this.lookOnly) return 0;
    let at = Infinity;
    for (const c of this.bindings[action]) if (this.down.has(c)) at = Math.min(at, this.downAt.get(c) ?? at);
    return at === Infinity ? 0 : Math.max(0, (performance.now() - at) / 1000);
  }

  /** 마지막 endFrame 이후 눌렸는지 (엣지) */
  wasPressed(action: A): boolean {
    this.settleCtrl();
    if (this.blocked || this.lookOnly) return false;
    return this.bindings[action].some((c) => this.pressed.has(c));
  }

  /**
   * 이 누름(엣지)을 다 썼다: 다음 endFrame 전에 고정 스텝 시스템이 같은 누름을 또 받지 않게 지운다 (누르고 있음은 그대로).
   * 렌더 프레임(update)에서 누름을 받아 처리했을 때 부른다. 고정 스텝이 없는 프레임(120 Hz 화면 등)에서는 엣지가
   * 다음 프레임의 고정 스텝까지 남아, 예를 들어 F로 시작한 상호작용을 다른 고정 스텝 시스템이 같은 F로 되돌린다
   */
  consumePress(action: A): void {
    for (const c of this.bindings[action]) this.pressed.delete(c);
  }

  /** 누적된 마우스 이동(px)을 꺼내고 0으로 */
  consumeLook(): { dx: number; dy: number } {
    const r = { dx: this.lookX, dy: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return r;
  }

  /** 고정 스텝이 한 번 이상 돈 뒤에 호출: 엣지 입력을 비운다 */
  endFrame(): void {
    this.pressed.clear();
    this.pulse.clear();
  }

  /** 테스트·스크립트 연출용 가상 입력 */
  simulate(code: string, isDown: boolean): void {
    if (isDown) this.press(code);
    else this.release(code);
  }

  /** 눌린 수식 키를 놓은 것으로 친다 (다시 누를 때까지) */
  releaseModifiers(): void {
    for (const c of MODIFIER_CODES) {
      this.down.delete(c);
      this.pressed.delete(c);
      this.pulse.delete(c);
      this.downAt.delete(c);
    }
  }

  /** 앱 단축키 조합: 기다리던 Ctrl을 버리고, 수식 키를 모두 놓을 때까지 Ctrl을 게임 조작으로 받지 않는다 */
  private swallowChord(): void {
    this.cancelCtrl();
    this.ctrlSwallowed = true;
    this.releaseModifiers();
  }

  private waitCtrl(code: string, at: number): void {
    if (this.ctrlSwallowed || this.down.has(code)) return;
    this.ctrlWait = { code, at, until: performance.now() + CTRL_WAIT_MS };
  }

  /** 기다림이 끝난 Ctrl을 넘긴다 (조작을 읽을 때마다) */
  private settleCtrl(): void {
    if (this.ctrlWait && performance.now() >= this.ctrlWait.until) this.flushCtrl(false);
  }

  /** 기다리던 Ctrl을 게임 조작으로 넘긴다. tapped면 이미 놓았으니 엣지 + 한 프레임만 */
  private flushCtrl(tapped: boolean): void {
    const w = this.ctrlWait;
    if (!w) return;
    this.cancelCtrl();
    if (tapped) {
      this.pressed.add(w.code);
      this.pulse.add(w.code);
    } else {
      this.press(w.code, w.at);
    }
  }

  private cancelCtrl(): void {
    this.ctrlWait = null;
  }

  private clearKeys(): void {
    this.cancelCtrl();
    this.down.clear();
    this.downAt.clear();
    this.pulse.clear();
  }

  private press(code: string, at = performance.now()): void {
    if (!this.down.has(code)) {
      this.pressed.add(code);
      this.downAt.set(code, at);
    }
    this.down.add(code);
  }

  private release(code: string): void {
    this.down.delete(code);
    this.downAt.delete(code);
  }
}
