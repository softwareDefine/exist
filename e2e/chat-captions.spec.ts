import { test, expect } from './lib/fixtures';
import { twoPartyMeeting, createMeeting, joinMeeting, registerUser, api } from './lib/api';
import { enterCall, openHub, hubTab } from './lib/app';

/* Scenario 2 — chat, @AI, live captions (stubbed OpenAI Realtime), chunk upload, 1:1 DM regression. */
test('captions & chat during a call', async ({ sessionFor }) => {
  const m = await twoPartyMeeting('chat');
  // A second group with the same two people — the hub for it stays mounted in A's dashboard,
  // which is exactly the setup where 1:1 채팅 used to open two DM windows (1243d96).
  const m2 = await createMeeting(m.a, 'E2E chat second group');
  await joinMeeting(m.b, m2.code);

  const A = await sessionFor(m.a);
  const B = await sessionFor(m.b);

  await test.step('A joins from the hub (embedded call), B from /meeting', async () => {
    await openHub(A.page, m2.code);
    await openHub(A.page, m.code);
    await hubTab(A.page, '통화').click();
    await A.page.locator('.hub-call').getByRole('button', { name: '입장하기' }).click();
    await expect(A.page.locator('.hub-call').getByTitle('나가기')).toBeVisible({ timeout: 30_000 });
    await enterCall(B.page, m.code);
    await expect(A.page.locator('.hub-call .mv-peers-btn')).toHaveText(/참가자 2명/);
  });

  await test.step('B sends chat from the call panel, A sees it', async () => {
    await B.page.getByTitle('채팅').click();
    const input = B.page.locator('.chat-panel .chat-input input');
    await input.fill('안녕하세요 — B의 통화 채팅');
    await input.press('Enter');
    await expect(B.page.locator('.chat-panel .chat-bubble', { hasText: 'B의 통화 채팅' })).toBeVisible();

    await A.page.locator('.hub-call').getByTitle('채팅').click();
    await expect(A.page.locator('.hub-call .chat-panel .chat-bubble', { hasText: 'B의 통화 채팅' })).toBeVisible();
  });

  await test.step('@AI shows the thinking indicator, then a rule-based reply', async () => {
    const input = B.page.locator('.chat-panel .chat-input input');
    await input.fill('@AI 이번 회의 결정 사항 알려줘');
    await input.press('Enter');
    await expect(B.page.locator('.chat-panel .chat-typing')).toBeVisible({ timeout: 20_000 });
    await expect(A.page.locator('.hub-call .chat-panel .chat-typing')).toBeVisible({ timeout: 20_000 });
    // Reply lands (from the AI user) on both sides and the typing bubble goes away.
    await expect(B.page.locator('.chat-panel .chat-typing')).toBeHidden({ timeout: 45_000 });
    // `has`/`hasNot` inner locators are re-rooted at the outer element — keep them page-rooted.
    const aiOn = (root: import('@playwright/test').Locator, page: import('@playwright/test').Page) =>
      root
        .locator('.chat-msg')
        .filter({ hasNot: page.locator('.chat-typing') })
        .filter({ has: page.locator('.chat-from', { hasText: /exist AI/i }) });
    await expect(aiOn(B.page.locator('.chat-panel'), B.page).last()).toBeVisible();
    await expect(aiOn(B.page.locator('.chat-panel'), B.page).last().locator('.chat-bubble')).not.toHaveText(/^\s*$/);
    await expect(aiOn(A.page.locator('.hub-call .chat-panel'), A.page).last()).toBeVisible({ timeout: 15_000 });
  });

  await test.step('live caption (source: live) renders for both participants', async () => {
    await expect(A.page.locator('.call-caption', { hasText: '검사 설비' }).first()).toBeVisible({ timeout: 45_000 });
    await expect(B.page.locator('.call-caption', { hasText: '검사 설비' }).first()).toBeVisible({ timeout: 45_000 });
  });

  await test.step('live session refused → client falls back to chunk upload POST /stt/audio → 200', async () => {
    // While the live stream is up the client deliberately skips chunk uploads. Mark this meeting
    // so the stub refuses NEW live sessions (glossary terms ride in the session prompt), then let a
    // third participant join: stt:live-status error → fallback → MediaRecorder chunks → POST.
    await api(`/api/meetings/${m.code}/glossary`, { body: { term: 'E2E_REFUSE_LIVE' }, token: m.a.token });
    const c = await registerUser('chatc');
    await joinMeeting(c, m.code);
    const C = await sessionFor(c);
    const upload = C.page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/meetings\/[^/]+\/stt\/audio/.test(r.url()),
      { timeout: 60_000 },
    );
    await enterCall(C.page, m.code);
    const res = await upload;
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  await test.step('participant panel "1:1 채팅" opens exactly one DM window', async () => {
    await A.page.locator('.hub-call .mv-peers-btn').click();
    await A.page.locator('.hub-call .ppl-menu .ppl-act[title="1:1 채팅"]').first().click();
    await expect(A.page.locator('.dm-window')).toHaveCount(1);
    await expect(A.page.locator('.dm-window')).toContainText(m.b.username);
  });
});
