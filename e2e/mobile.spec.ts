import { devices } from '@playwright/test';
import { test, expect } from './lib/fixtures';
import { twoPartyMeeting } from './lib/api';
import { noHorizontalScroll } from './lib/app';

/* Scenario 5 — Pixel 5 smoke: single-column home, no horizontal scroll, pre-join modal usable. */
const { defaultBrowserType: _ignored, ...pixel5 } = devices['Pixel 5'];

test('mobile smoke (Pixel 5)', async ({ sessionFor }) => {
  const m = await twoPartyMeeting('mob');
  const S = await sessionFor(m.b, { ...pixel5, permissions: ['microphone', 'camera'] });
  const { page } = S;

  await test.step('home renders single column without horizontal scroll', async () => {
    await page.goto('/');
    await expect(page.locator('.dashboard')).toBeVisible();
    const dims = await noHorizontalScroll(page);
    expect(dims.scrollWidth, JSON.stringify(dims)).toBeLessThanOrEqual(dims.clientWidth);
    // Phone shell = narrow icon rail (~64px) + ONE content column. Nothing may poke past the
    // viewport, and the 320px desktop sidebar (with its 그룹 코드 form) must be gone.
    const layout = await page.locator('.dashboard').evaluate((el) => {
      const vw = window.innerWidth;
      const kids = [...el.children]
        .map((c) => c.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      return { vw, kids: kids.map((r) => ({ l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) })) };
    });
    expect(layout.kids.length, JSON.stringify(layout)).toBeGreaterThan(0);
    for (const k of layout.kids) expect(k.r, JSON.stringify(layout)).toBeLessThanOrEqual(layout.vw + 1);
    const columns = layout.kids.filter((k) => k.w > 100 && k.w < layout.vw - 20); // side-by-side blocks
    expect(columns.length, `expected a single content column: ${JSON.stringify(layout)}`).toBeLessThanOrEqual(1);
    await expect(page.getByPlaceholder('그룹 코드')).toBeHidden();
    await expect(page.locator('.pd-inbox')).toBeVisible();
  });

  await test.step('pre-join modal fits and is usable', async () => {
    await page.goto(`/meeting/${m.code}`);
    const join = page.getByRole('button', { name: '입장하기' });
    await expect(join).toBeVisible();
    const box = await join.boundingBox();
    const vp = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1);
    // Mic/cam toggles on the preview respond to taps.
    const micPill = page.locator('.pv-main').first();
    await micPill.tap();
    await expect(micPill).toHaveAttribute('title', /켜기/);
    await micPill.tap();
    await expect(micPill).toHaveAttribute('title', /끄기/);
    await join.tap();
    await expect(page.locator('.mv-peers-btn')).toHaveText(/참가자 1명/, { timeout: 30_000 });
    const dims = await noHorizontalScroll(page);
    expect(dims.scrollWidth, JSON.stringify(dims)).toBeLessThanOrEqual(dims.clientWidth);
  });
});
