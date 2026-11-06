/**
 * 점검 스크립트용 UI 찾기. UI는 닫힌 섀도 루트 안에 있다 (src/ui/uiRoot.ts): Playwright 선택자(page.click,
 * waitForSelector, locator)와 document.querySelector가 닿지 않는다. 페이지 안에서는 window.__ui(그 루트)로 찾는다.
 *   페이지 함수 안:  (window.__ui ?? document).querySelector(sel)
 *   노드 쪽:        await uiClick(page, sel) · await waitUi(page, sel, { timeout })
 * 요소 핸들을 남기지 않는다 (좌표와 참·거짓만 주고받는다: 누수 측정을 흐리지 않게).
 */

/** sel이 보일 때까지 (waitForSelector의 visible과 같다: 상자가 비어 있지 않고 visibility:hidden이 아니다) */
export async function waitUi(page, sel, { timeout = 30000 } = {}) {
  const h = await page.waitForFunction(
    (q) => {
      const el = (window.__ui ?? document).querySelector(q);
      if (!el) return false;
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    },
    sel,
    { timeout },
  );
  await h.dispose();
}

/**
 * sel 가운데를 진짜 마우스로 누른다 (page.click처럼: 보일 때까지 기다리고, 화면 안으로 굴리고, 미끄러지는 중이면 멈출 때까지 본다)
 */
export async function uiClick(page, sel, { timeout = 30000 } = {}) {
  await waitUi(page, sel, { timeout });
  const t0 = Date.now();
  let r = null;
  for (;;) {
    const n = await page.evaluate((q) => {
      const el = (window.__ui ?? document).querySelector(q);
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, sel);
    if (n && r && Math.abs(n.x - r.x) < 0.5 && Math.abs(n.y - r.y) < 0.5) break;
    if (Date.now() - t0 > timeout) throw new Error(`클릭할 것이 없다: ${sel}`);
    r = n;
    await new Promise((res) => setTimeout(res, 60));
  }
  await page.mouse.click(r.x, r.y);
}
