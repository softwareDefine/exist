import { test, expect } from './lib/fixtures';
import { twoPartyMeeting } from './lib/api';
import { openHub, hubTab, drawSignature, tinyPng } from './lib/app';

/* Scenario 4 — 공동편집: Yjs doc sync across two browsers, 회람(열람 서명), image → chat → lightbox. */
test('files: doc co-editing, 회람 signature, image share and lightbox', async ({ sessionFor }) => {
  const m = await twoPartyMeeting('files');
  const A = await sessionFor(m.a);
  const B = await sessionFor(m.b);
  const DOC = `E2E 문서 ${Date.now().toString(36)}`;
  const TEXT = '방열판 두께는 3mm로 확정합니다 — Yjs 실시간 공동편집';

  await test.step('A creates a doc and types into tiptap', async () => {
    await openHub(A.page, m.code);
    await hubTab(A.page, '공동편집').click();
    await A.page.getByRole('button', { name: '새로 만들기' }).click();
    await A.page.locator('.cf-type-menu button', { hasText: '문서' }).first().click();
    const name = A.page.locator('input.cf-name-input');
    await name.fill(DOC);
    await name.press('Enter');
    const editor = A.page.locator('.ProseMirror').first();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(A.page.locator('.code-doc-status')).toHaveText(/실시간 연결됨/, { timeout: 20_000 });
    await editor.click();
    await A.page.keyboard.type(TEXT);
    await expect(editor).toContainText('3mm로 확정');
  });

  await test.step('B opens the same doc and sees the text (Yjs over /yjs)', async () => {
    await openHub(B.page, m.code);
    await hubTab(B.page, '공동편집').click();
    await B.page.locator('.cf-entry', { hasText: DOC }).first().dblclick();
    const editorB = B.page.locator('.ProseMirror').first();
    await expect(editorB).toBeVisible({ timeout: 30_000 });
    await expect(editorB).toContainText('3mm로 확정', { timeout: 20_000 });
  });

  await test.step('A requests 열람 서명 on the doc', async () => {
    // Back to the explorer, select the entry, open the 관리 fold in the detail sidebar.
    await A.page.getByTitle('파일 목록으로').click();
    const entry = A.page.locator('.cf-entry', { hasText: DOC }).first();
    await entry.click();
    await A.page.locator('.cf-manage button.cf-ack-fold').click();
    await A.page.getByRole('button', { name: '열람 서명 요청' }).click();
    await expect(A.page.getByText('열람 서명을 요청했어요')).toBeVisible();
    await expect(A.page.locator('.cf-ack .cf-ack-head b')).toHaveText('0/2');
  });

  await test.step('B reads and signs; A sees 확인 현황 1/2', async () => {
    // Back to the list (which re-fetches, so the entry now carries ack_required) and reopen.
    await B.page.getByTitle('파일 목록으로').click();
    await B.page.locator('.cf-entry', { hasText: DOC }).first().dblclick();
    await expect(B.page.locator('.cf-ackbar')).toContainText('열람 확인이 필요해요');
    await B.page.locator('.cf-ackbar').getByRole('button', { name: '서명하기' }).click();
    const modal = B.page.locator('.cf-signmodal', { hasText: '열람 확인 서명' });
    await expect(modal).toBeVisible();
    await drawSignature(B.page, modal.locator('canvas.ho-sign-canvas'));
    await modal.locator('button.ho-publish').click();
    await expect(B.page.locator('.cf-ackbar.done')).toContainText('열람 확인 서명 완료');
    // NOTE: POST /files/:id/ack only notifies the author — there is no files:changed push — so the
    // 회람 현황 in A's detail sidebar is not live. Re-selecting the entry refetches it.
    await A.page.locator('.cf-entry-home').first().click();
    await A.page.locator('.cf-entry', { hasText: DOC }).first().click();
    await expect(A.page.locator('.cf-ack .cf-ack-head b')).toHaveText('1/2', { timeout: 20_000 });
  });

  const IMG = `e2e-photo-${Date.now().toString(36)}.png`;
  await test.step('A uploads an image and shares it to the chat channel', async () => {
    await A.page.locator('input[type="file"][multiple]').setInputFiles({ name: IMG, mimeType: 'image/png', buffer: tinyPng });
    const img = A.page.locator('.cf-entry', { hasText: IMG }).first();
    await expect(img).toBeVisible({ timeout: 20_000 });
    await img.click();
    await A.page.getByRole('button', { name: /^공유/ }).first().click();
    const share = A.page.locator('.cf-share-modal');
    await expect(share).toBeVisible();
    await share.locator('.cf-share-body button').first().click();
    await share.getByRole('button', { name: /^보내기/ }).click();
    await expect(A.page.getByText(/공유했어요/)).toBeVisible();
  });

  await test.step('clicking the image in chat opens the .img-viewer lightbox', async () => {
    await hubTab(A.page, '채팅').click();
    const thumb = A.page.locator('.chat-file-img').last();
    await expect(thumb).toBeVisible({ timeout: 20_000 });
    await thumb.click();
    const viewer = A.page.locator('.img-viewer');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.img-viewer-name')).toHaveText(IMG);
    await viewer.locator('.img-viewer-close').click();
    await expect(viewer).toHaveCount(0);
  });
});
