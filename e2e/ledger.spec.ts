import { test, expect } from './lib/fixtures';
import { twoPartyMeeting, api } from './lib/api';
import { seedRecap } from './lib/db';
import { openHub, hubTab, drawSignature } from './lib/app';

/* Scenario 3 — decision lifecycle in the hub 기록 tab + live home dashboard cards. */
test('decision lifecycle: ack, signature, 정정, 철회, history, live home cards', async ({ sessionFor }) => {
  const m = await twoPartyMeeting('ledger');
  const D_PLAIN = '주간 정기 회의를 화요일 10시로 옮긴다';
  const D_CRIT = '방열판 두께를 3mm로 변경한다';
  const D_WD = '검사 설비 온도 세팅을 65도로 올린다';
  const D_PROBE = '작업 지시서 양식을 v2로 교체한다';
  const recapId = seedRecap({
    meetingId: m.meetingId,
    summary: 'E2E 시드 회의록 — 결정 4건',
    decisions: [D_PLAIN, D_CRIT, D_WD, D_PROBE],
    whys: ['월요일 출근 직후는 라인 점검과 겹침', '진동 시험에서 2mm 균열', '수율 개선 실험', null],
    criticals: [false, true, false, false],
    attendees: [m.a.username, m.b.username],
  });

  const A = await sessionFor(m.a); // host — can 정정/철회
  const B = await sessionFor(m.b);

  await test.step('B at home sees all three in 지금 처리할 것', async () => {
    await B.page.goto('/');
    const inbox = B.page.locator('.pd-inbox');
    await expect(inbox.locator('.pd-act-row', { hasText: D_PLAIN })).toBeVisible();
    await expect(inbox.locator('.pd-act-row', { hasText: D_CRIT })).toBeVisible();
    await expect(inbox.locator('.pd-act-row', { hasText: D_WD })).toBeVisible();
  });

  const ledger = A.page.locator('.ledger-item');
  await test.step('A opens 기록 — four ledger rows', async () => {
    await openHub(A.page, m.code);
    await hubTab(A.page, '기록').click();
    await expect(ledger).toHaveCount(4);
  });

  await test.step('plain decision: one-click 확인', async () => {
    const row = ledger.filter({ hasText: D_PLAIN });
    await row.getByRole('button', { name: '확인', exact: true }).click();
    await expect(row.locator('.ledger-ack.done')).toHaveText(/확인함/);
  });

  await test.step('critical decision: 확인 → signature canvas → drawn signature accepted', async () => {
    const row = ledger.filter({ hasText: D_CRIT });
    await expect(row.locator('.ledger-critical')).toBeVisible();
    await row.getByRole('button', { name: '확인', exact: true }).click();
    const modal = A.page.locator('.cf-signmodal', { hasText: '결정 확인 서명' });
    await expect(modal).toBeVisible();
    const confirm = modal.locator('button.ho-publish');
    await expect(confirm).toBeDisabled(); // nothing drawn yet
    await drawSignature(A.page, modal.locator('canvas.ho-sign-canvas'));
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(modal).toBeHidden();
    await expect(row.locator('.ledger-ack.done')).toHaveText(/확인함/);
    await expect(row.locator('img[alt$="서명"]').first()).toBeVisible();
  });

  await test.step('B home: 지금 처리할 것 → 확인 from home, 최근 결정 updates live when A acks', async () => {
    // Nothing reloaded on B: the ledger:changed socket push must move the cards.
    const inbox = B.page.locator('.pd-inbox');
    const rowWd = inbox.locator('.pd-act-row', { hasText: D_WD });
    await rowWd.locator('.pd-ack-btn').click();
    await expect(rowWd).toBeHidden();
    const recent = B.page.locator('.pd-recent .pd-act-row', { hasText: D_WD });
    await expect(recent).toBeVisible();
    await expect(recent.locator('.pd-act-sub')).toContainText('팀 확인 1/2');
    // A acks the same decision in the hub → B's card goes to 2/2 without a reload.
    await ledger.filter({ hasText: D_WD }).getByRole('button', { name: '확인', exact: true }).click();
    await expect(recent.locator('.pd-act-sub')).toContainText('팀 확인 2/2', { timeout: 20_000 });
  });

  await test.step('정정 requires a reason; then revision chip + history', async () => {
    const row = ledger.filter({ hasText: D_PLAIN });
    await row.getByRole('button', { name: '정정', exact: true }).click();
    const modal = A.page.locator('.cf-signmodal', { hasText: '결정 정정' });
    await expect(modal).toBeVisible();
    await modal.locator('textarea').fill('주간 정기 회의를 화요일 10시 30분으로 옮긴다');
    await modal.getByRole('button', { name: '정정하기' }).click();
    await expect(A.page.getByText('정정 사유를 적어주세요')).toBeVisible();
    await expect(modal).toBeVisible(); // still open
    await modal.locator('input[placeholder^="예: 회의에서"]').fill('회의 원문 확인 — 10시 30분이 맞음');
    await modal.getByRole('button', { name: '정정하기' }).click();
    await expect(modal).toBeHidden();
    const edited = ledger.filter({ hasText: '10시 30분' });
    await expect(edited).toHaveCount(1);
    await expect(edited.getByTitle('정정 이력 보기')).toHaveText(/정정 1회/);
    await edited.getByTitle('정정 이력 보기').click();
    await expect(edited.locator('.ledger-revision').first()).toContainText('정정');
    await expect(edited.locator('.ledger-revision').first()).toContainText('10시 30분이 맞음');
    // Sentence changed → my earlier one-click ack became an old-version signature.
    await expect(edited.locator('.ledger-revision', { hasText: '구버전 서명' }).first()).toBeVisible();
  });

  await test.step('철회 keeps the row with reason, stops asking for acks', async () => {
    const row = ledger.filter({ hasText: D_WD });
    await row.getByRole('button', { name: '철회', exact: true }).click();
    const modal = A.page.locator('.cf-signmodal', { hasText: '결정 철회' });
    await modal.getByRole('button', { name: '철회하기' }).click();
    await expect(A.page.getByText('철회 사유를 적어주세요')).toBeVisible();
    await modal.locator('input[placeholder^="예: 안전팀"]').fill('안전팀 검토 결과 적용 보류');
    await modal.getByRole('button', { name: '철회하기' }).click();
    await expect(modal).toBeHidden();
    await expect(row).toHaveClass(/withdrawn/);
    await expect(row).toContainText('철회');
    await expect(row).toContainText('안전팀 검토 결과 적용 보류');
    await expect(row.getByRole('button', { name: '확인', exact: true })).toHaveCount(0);
  });

  await test.step('B home inbox reflects the 정정 (re-ack) live', async () => {
    const inbox = B.page.locator('.pd-inbox');
    await expect(inbox.locator('.pd-act-row', { hasText: '10시 30분' })).toBeVisible({ timeout: 20_000 });
  });

  await test.step('probe (non-failing): does a withdrawn, never-acked decision leave 지금 처리할 것?', async () => {
    // GET /api/agent/pending-decisions does not consult decision_state — suspected bug. Record only.
    await api(`/api/meetings/${m.code}/decisions/${recapId}/3/withdraw`, { body: { reason: '양식 v2 배포 취소' }, token: m.a.token });
    await expect(ledger.filter({ hasText: D_PROBE })).toHaveClass(/withdrawn/, { timeout: 15_000 });
    await B.page.waitForTimeout(1_500); // give ledger:changed → reload a moment
    const pending = await api<{ items: { decision: string }[] }>('/api/agent/pending-decisions', { token: m.b.token });
    const apiStillPending = pending.items.some((i) => i.decision === D_PROBE);
    const uiStillPending = await B.page.locator('.pd-inbox .pd-act-row', { hasText: D_PROBE }).isVisible();
    test.info().annotations.push({
      type: 'bug-probe',
      description: `withdrawn decision still in 지금 처리할 것 — API: ${apiStillPending}, home UI: ${uiStillPending}`,
    });
    console.log(`[bug-probe] withdrawn decision still pending — API: ${apiStillPending}, home UI: ${uiStillPending}`);
  });
});
