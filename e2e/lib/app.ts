import { expect, type Locator, type Page } from '@playwright/test';

/** /meeting/:code → pre-join modal → 입장하기 → live call UI. */
export async function enterCall(page: Page, code: string) {
  await page.goto(`/meeting/${code}`);
  await page.getByRole('button', { name: '입장하기' }).click();
  await expect(page.getByTitle('나가기')).toBeVisible({ timeout: 30_000 });
}

/** Home → sidebar "그룹 코드" + 참여 → hub tab for that group. */
export async function openHub(page: Page, code: string) {
  if (!page.url().endsWith('/') || !(await page.getByPlaceholder('그룹 코드').isVisible().catch(() => false))) {
    await page.goto('/');
  }
  await page.getByPlaceholder('그룹 코드').fill(code);
  await page.getByRole('button', { name: '참여', exact: true }).click();
  await expect(page.locator('.hub-tabs').last()).toBeVisible();
}

export function hubTab(page: Page, label: '대시보드' | '일정' | '통화' | '채팅' | '공동편집' | '기록' | '설정') {
  return page.locator('.hub-tab', { hasText: label }).last();
}

/** The call's dropdown menus (통화 설정 / 참가자) stay open behind a fixed full-screen backdrop
 *  until it is clicked — Escape does nothing. Click its top-left corner to dismiss. */
export async function closeCallMenus(page: Page, root: Locator | Page = page) {
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };
  const menus = root.locator('.dev-menu');
  for (let i = 0; i < 6; i++) {
    // Dispatch the click straight on the backdrop element(s) — their on-screen geometry varies
    // (the participants popup's backdrop is clipped by a transformed ancestor).
    await page.evaluate(() => {
      document
        .querySelectorAll<HTMLElement>('div[style*="position: fixed"][style*="inset: 0"]')
        .forEach((el) => el.click());
      // React's onMouseLeave rides the native mouseout — fire it on the hover wrapper directly,
      // headless boundary events after a kick re-render are not reliable.
      document.querySelectorAll<HTMLElement>('.ppl-wrap').forEach((el) => {
        el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      });
    });
    // The participants menu also shows while hovered (200 ms leave debounce) — wiggle the mouse
    // in the middle of the stage so a real mouseleave fires even after a layout change.
    await page.mouse.move(vp.width / 2, vp.height / 2, { steps: 4 });
    await page.mouse.move(vp.width / 2 + 60, vp.height / 2 + 40, { steps: 4 });
    try {
      await expect(menus).toHaveCount(0, { timeout: 1_500 });
      return;
    } catch {
      /* retry */
    }
  }
  await expect(menus).toHaveCount(0);
}

/** Host: 통화 설정 → 회의 잠금 toggle, then dismiss the menu. */
export async function toggleLock(page: Page, root: Locator | Page = page) {
  await root.getByTitle('통화 설정').click();
  await root.getByRole('button', { name: /회의 잠금/ }).click();
  await closeCallMenus(page, root);
}

/** Draw a squiggle on a SignPad canvas with the mouse (pointer events). */
export async function drawSignature(page: Page, canvas: Locator) {
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('sign canvas has no box');
  const x0 = box.x + box.width * 0.2;
  const y0 = box.y + box.height * 0.5;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(x0 + (box.width * 0.6 * i) / 12, y0 + Math.sin(i) * box.height * 0.25, { steps: 3 });
  }
  await page.mouse.up();
}

/** Max inbound-rtp audio packetsReceived over all RTCPeerConnections on the page. */
export function inboundAudioPackets(page: Page) {
  return page.evaluate(async () => {
    const pcs = ((window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []).filter(
      (pc) => pc.connectionState !== 'closed',
    );
    let max = 0;
    for (const pc of pcs) {
      const stats = await pc.getStats();
      stats.forEach((s) => {
        const r = s as unknown as { type: string; kind?: string; mediaType?: string; packetsReceived?: number };
        if (r.type === 'inbound-rtp' && (r.kind ?? r.mediaType) === 'audio') {
          max = Math.max(max, r.packetsReceived ?? 0);
        }
      });
    }
    return max;
  });
}

export function noHorizontalScroll(page: Page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, inner: window.innerWidth };
  });
}

export const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVR42mP8z8BQz0AEYBxVSF+FAAAB9wP9U6xWQwAAAABJRU5ErkJggg==',
  'base64',
);
