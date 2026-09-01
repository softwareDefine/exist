import { test, expect } from './lib/fixtures';
import { twoPartyMeeting, registerUser, joinMeeting } from './lib/api';
import { enterCall, inboundAudioPackets, toggleLock, closeCallMenus } from './lib/app';

/* Scenario 1 — two-party WebRTC call through the real mediasoup SFU. */
test('two-party call: tiles, mic toggle, real media, lock, kick, leave', async ({ sessionFor }) => {
  const m = await twoPartyMeeting('call');
  const A = await sessionFor(m.a);
  const B = await sessionFor(m.b);

  await test.step('both enter and see two tiles', async () => {
    await enterCall(A.page, m.code);
    await enterCall(B.page, m.code);
    for (const p of [A.page, B.page]) {
      await expect(p.locator('.mv-peers-btn')).toHaveText(/참가자 2명/);
      await expect(p.locator('.video-tile')).toHaveCount(2);
    }
  });

  await test.step('mic toggle reflects in the control bar', async () => {
    const mic = B.page.locator('button.main[title="마이크"]');
    await expect(mic).not.toHaveClass(/\boff\b/);
    await mic.click();
    await expect(mic).toHaveClass(/\boff\b/);
    // Remote side shows the muted icon on B's tile.
    await expect(A.page.locator('.tile-off-ic[title="마이크 꺼짐"]').first()).toBeVisible();
    await mic.click();
    await expect(mic).not.toHaveClass(/\boff\b/);
  });

  await test.step('B receives real audio packets from A (inbound-rtp)', async () => {
    await expect
      .poll(() => inboundAudioPackets(B.page), { timeout: 30_000, message: 'inbound audio packets on B' })
      .toBeGreaterThan(0);
  });

  await test.step('host lock blocks a re-join, unlock allows it', async () => {
    await toggleLock(A.page);
    await expect(A.page.locator('.meeting-locked')).toBeVisible();
    await expect(B.page.locator('.meeting-locked')).toBeVisible();

    // B leaves → A's tile count drops → B tries to come back while locked.
    await B.page.getByTitle('나가기').click();
    await expect(B.page).toHaveURL(/\/$/);
    await expect(A.page.locator('.mv-peers-btn')).toHaveText(/참가자 1명/);
    await expect(A.page.locator('.video-tile')).toHaveCount(1);

    await B.page.goto(`/meeting/${m.code}`);
    await B.page.getByRole('button', { name: '입장하기' }).click();
    await expect(B.page.getByText(/호스트가 회의를 잠갔습니다/)).toBeVisible({ timeout: 20_000 });

    // Unlock, then B gets in again.
    await toggleLock(A.page);
    await expect(A.page.locator('.meeting-locked')).toHaveCount(0);
    await enterCall(B.page, m.code);
    await expect(A.page.locator('.mv-peers-btn')).toHaveText(/참가자 2명/);
  });

  await test.step('a third user is also refused while locked', async () => {
    const c = await registerUser('callc');
    await joinMeeting(c, m.code);
    const C = await sessionFor(c);
    await toggleLock(A.page);
    await expect(A.page.locator('.meeting-locked')).toBeVisible();
    await C.page.goto(`/meeting/${m.code}`);
    await C.page.getByRole('button', { name: '입장하기' }).click();
    await expect(C.page.getByText(/호스트가 회의를 잠갔습니다/)).toBeVisible({ timeout: 20_000 });
    // (context is closed by the fixture after coverage is flushed)
  });

  await test.step('host kicks B → B sees the notice, A sees the tile go', async () => {
    await A.page.locator('.mv-peers-btn').click();
    await A.page.locator('.ppl-menu .ppl-act.danger').first().click();
    await closeCallMenus(A.page);
    await expect(B.page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(B.page.locator('.dash-message')).toHaveText(/호스트가 회의에서 내보냈습니다/);
    await expect(A.page.locator('.mv-peers-btn')).toHaveText(/참가자 1명/);
    await expect(A.page.locator('.video-tile')).toHaveCount(1);
  });

  await test.step('host leaves', async () => {
    await A.page.getByTitle('나가기').click();
    await expect(A.page).toHaveURL(/\/$/);
  });
});
