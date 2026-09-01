import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import * as Y from 'yjs';

/*
 * fileai.ts — 개정 발행 후처리: 직전 스냅샷과 새 본문을 비교한 "바뀐 점" AI 요약 → 회람 알림 문구 · 개정 연혁 RAG 색인.
 * 실패·"변경 없음"은 요약 없이 기존 문구로 알림 (본 동작 우선).
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { afterRevise, extractFileText } from '../fileai.js';
import { writeYdoc } from '../ydoc.js';
import { captured, setNextResponses, resetOpenAiMock, systemPrompt, waitFor } from './helpers/openaiMock.js';

const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string; user: { id: number } };
}
function userId(username: string): number {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
}
async function setup(prefix: string, body: string) {
  const host = await registerUser(`${prefix}_host`);
  const member = await registerUser(`${prefix}_member`);
  const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${host.token}`).send({ title: `${prefix} 그룹` });
  const code = m.body.code as string;
  await request(app).post('/api/meetings/join').set('Authorization', `Bearer ${member.token}`).send({ code });
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
  const hostId = userId(`${prefix}_host`);
  const fileId = db
    .prepare("INSERT INTO collab_files (meeting_id, name, type, created_by, ack_required, rev) VALUES (?, '절차서', 'doc', ?, 1, 1)")
    .run(meetingId, hostId).lastInsertRowid as number;
  const room = `file-${fileId}`;
  db.prepare('UPDATE collab_files SET room = ? WHERE id = ?').run(room, fileId);
  setBody(room, body);
  return { code, meetingId, hostId, memberId: userId(`${prefix}_member`), fileId, room };
}
function setBody(room: string, body: string) {
  writeYdoc(room, (doc) => {
    doc.getMap('docs').set('main', { name: '절차서' });
    doc.getXmlFragment('doc:main').insert(0, [new Y.XmlText(body)]);
  });
}
function snapshot(fileId: number, rev: number) {
  return db.prepare('SELECT text, note, basis_note FROM file_rev_snapshots WHERE file_id = ? AND rev = ?').get(fileId, rev) as
    { text: string | null; note: string | null; basis_note: string | null } | undefined;
}
function notiTexts(uid: number): string[] {
  return (db.prepare("SELECT text FROM notifications WHERE user_id = ? AND kind = 'file-ack' ORDER BY id").all(uid) as { text: string }[]).map((n) => n.text);
}

beforeEach(() => resetOpenAiMock());

describe('afterRevise — 개정 요약 AI', () => {
  it('직전 스냅샷과 새 본문을 비교 요청(10초 캡), 응답은 3줄·줄머리 기호 제거·60자 캡 → 알림 문구 + 스냅샷 note + 연혁 색인', async () => {
    const s = await setup('lf1', '검사 온도 65도로 상향, 다음 배치부터 적용');
    expect(extractFileText(s.fileId)).toBe('절차서\n검사 온도 65도로 상향, 다음 배치부터 적용');
    db.prepare("INSERT INTO file_rev_snapshots (file_id, rev, text) VALUES (?, 1, ?)").run(s.fileId, '절차서\n검사 온도 60도 유지');
    setNextResponses('- 검사 온도 60도→65도\n• 적용 시점 "다음 배치부터" 추가\n3) 담당 표기 변경\n4. 네 번째 줄은 잘린다');
    afterRevise({
      meetingId: s.meetingId, meetingCode: s.code, actorId: s.hostId, actorName: 'lf1_host',
      fileId: s.fileId, fileName: '절차서', rev: 2, ackRequired: true, basisNote: '검사 기준 변경 결정 반영',
    });
    // ① 스냅샷은 동기 저장
    expect(snapshot(s.fileId, 2)).toMatchObject({ text: '절차서\n검사 온도 65도로 상향, 다음 배치부터 적용', basis_note: '검사 기준 변경 결정 반영' });
    // ②③ 요약·알림은 비동기
    await waitFor(() => notiTexts(s.memberId).length > 0);
    expect(notiTexts(s.memberId)).toEqual([
      '『절차서』 개정 v2 발행 — 바뀐 점: 검사 온도 60도→65도 · 적용 시점 "다음 배치부터" 추가 · 담당 표기 변경 — 다시 열람 서명이 필요해요',
    ]);
    expect(notiTexts(s.hostId)).toEqual([]); // 발행자 본인 제외
    expect(snapshot(s.fileId, 2)!.note).toBe('검사 온도 60도→65도\n적용 시점 "다음 배치부터" 추가\n담당 표기 변경');

    const req = captured[0];
    expect(req.model).toBe('gpt-4o-mini');
    expect(req.temperature).toBe(0);
    expect(req.max_tokens).toBe(200);
    expect(req.options).toEqual({ timeout: 10_000 });
    expect(req.response_format).toBeUndefined();
    expect(systemPrompt(req)).toContain('"변경 없음"만 출력');
    const user = req.messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('[파일] 절차서');
    expect(user).toContain('[이전 본문]\n절차서\n검사 온도 60도 유지');
    expect(user).toContain('[새 본문]\n절차서\n검사 온도 65도로 상향, 다음 배치부터 적용');

    // 개정 연혁 RAG 색인 — rev별 청크 (ref_id = fileId*100000+rev)
    await waitFor(() => (db.prepare("SELECT COUNT(*) c FROM rag_chunks WHERE kind = 'filerev' AND ref_id = ?").get(s.fileId * 100_000 + 2) as { c: number }).c === 1);
    const chunk = db.prepare("SELECT text FROM rag_chunks WHERE kind = 'filerev' AND ref_id = ?").get(s.fileId * 100_000 + 2) as { text: string };
    expect(chunk.text).toMatch(/^\[문서 "절차서" 개정 v2 \d{4}-\d{2}-\d{2}\] 바뀐 점: 검사 온도 60도→65도 · 적용 시점 "다음 배치부터" 추가 · 담당 표기 변경 \/ 개정 사유: 검사 기준 변경 결정 반영$/);
  });

  it('"변경 없음"·API 실패·첫 개정(직전 스냅샷 없음)은 요약 없이 기존 문구로 알림', async () => {
    const s = await setup('lf2', '본문 v2');
    db.prepare("INSERT INTO file_rev_snapshots (file_id, rev, text) VALUES (?, 1, ?)").run(s.fileId, '본문 v1');
    setNextResponses('변경 없음');
    afterRevise({ meetingId: s.meetingId, meetingCode: s.code, actorId: s.hostId, actorName: 'lf2_host', fileId: s.fileId, fileName: '절차서', rev: 2, ackRequired: true });
    await waitFor(() => notiTexts(s.memberId).length === 1);
    expect(notiTexts(s.memberId)[0]).toBe('"절차서" 문서의 개정 v2이 발행됐어요 — 다시 열람 서명이 필요해요');
    expect(snapshot(s.fileId, 2)!.note).toBeNull();

    setBody(s.room, '본문 v3');
    setNextResponses(new Error('timeout'));
    afterRevise({ meetingId: s.meetingId, meetingCode: s.code, actorId: s.hostId, actorName: 'lf2_host', fileId: s.fileId, fileName: '절차서', rev: 3, ackRequired: true });
    await waitFor(() => notiTexts(s.memberId).length === 2);
    expect(notiTexts(s.memberId)[1]).toBe('"절차서" 문서의 개정 v3이 발행됐어요 — 다시 열람 서명이 필요해요');
    expect(captured).toHaveLength(2);

    // 첫 개정 — 비교 대상이 없어 AI 호출 없음 / 회람 문서가 아니면 알림도 없음
    const t = await setup('lf2b', '새 문서');
    afterRevise({ meetingId: t.meetingId, meetingCode: t.code, actorId: t.hostId, actorName: 'lf2b_host', fileId: t.fileId, fileName: '절차서', rev: 1, ackRequired: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).toHaveLength(2);
    expect(notiTexts(t.memberId)).toEqual([]);
    expect(snapshot(t.fileId, 1)!.text).toBe('절차서\n새 문서');
  });
});
