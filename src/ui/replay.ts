/**
 * CSS 애니메이션 클래스를 처음부터 다시 건다: 이번 프레임에 떼고 다음 프레임에 붙인다.
 * `void el.offsetWidth`로 다시 걸면 그 자리에서 문서 전체 레이아웃을 강제로 계산한다.
 * 단계가 바뀌는 순간에는 다른 DOM 변경과 겹쳐 30~80 ms가 걸렸다 (프레임 조사). 한 프레임 늦게 붙는 것은 눈에 띄지 않는다.
 * ok가 있으면 붙이기 직전에 확인한다 (그 사이에 꺼졌으면 붙이지 않는다).
 */
const pending = new WeakMap<HTMLElement, Map<string, number>>();

export function replayClass(el: HTMLElement, cls: string, ok?: () => boolean): void {
  el.classList.remove(cls);
  let m = pending.get(el);
  if (!m) pending.set(el, (m = new Map()));
  const prev = m.get(cls);
  if (prev) cancelAnimationFrame(prev);
  const map = m;
  map.set(
    cls,
    requestAnimationFrame(() => {
      map.delete(cls);
      if (!ok || ok()) el.classList.add(cls);
    }),
  );
}

/** 걸어 둔 다시 걸기를 취소한다 (클래스는 떼어진 채로 둔다) */
export function cancelReplay(el: HTMLElement, cls: string): void {
  const m = pending.get(el);
  const id = m?.get(cls);
  if (id) cancelAnimationFrame(id);
  m?.delete(cls);
}
