import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * handover.ts의 AI 경로 — 초안(4섹션) 생성, 부족분 점검, 복명복창 모순 대조(2단 판정).
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  delete process.env.OPENAI_MODEL_JUDGE;
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { draftHandover, reviewHandover, publishHandover, ackHandover, listHandovers } from '../handover.js';
import { indexRecap } from '../rag.js';
import {
  captured,
  queueJson,
  setNextResponses,
  resetOpenAiMock,
  userPayload,
  systemPrompt,
  setEmbedder,
  keywordEmbedder,
  waitFor,
  flush,
} from './helpers/openaiMock.js';

const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string; user: { id: number } };
}
function userId(username: string): number {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
}
async function setupMeeting(prefix: string) {
  const host = await registerUser(`${prefix}_host`);
  const member = await registerUser(`${prefix}_member`);
  const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${host.token}`).send({ title: `${prefix} 조` });
  const code = m.body.code as string;
  await request(app).post('/api/meetings/join').set('Authorization', `Bearer ${member.token}`).send({ code });
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
  return { host, member, code, meetingId, hostId: userId(`${prefix}_host`), memberId: userId(`${prefix}_member`) };
}
function say(meetingId: number, uid: number, text: string) {
  db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(meetingId, uid, text);
}
function insertRecap(meetingId: number, decisions: string[]) {
  return db
    .prepare(`INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, actions, attendees, source) VALUES (?, ?, ?, ?, '[]', '[]', 'ai')`)
    .run(meetingId, decisions[0], JSON.stringify(decisions), JSON.stringify(decisions.map(() => ''))).lastInsertRowid as number;
}
function ackRow(handoverId: number, uid: number) {
  return db.prepare('SELECT note, echo_check, echo_reason FROM handover_acks WHERE handover_id = ? AND user_id = ?').get(handoverId, uid) as
    { note: string | null; echo_check: string | null; echo_reason: string | null } | undefined;
}
function notiTexts(uid: number): string[] {
  return (db.prepare('SELECT text FROM notifications WHERE user_id = ? ORDER BY id').all(uid) as { text: string }[]).map((n) => n.text);
}

beforeEach(() => resetOpenAiMock());

describe('draftHandover — AI 초안', () => {
  it('이번 조 재료(채팅·결정·미완료 할 일)를 넘기고, 응답은 섹션별 6개·160자로 위생 처리', async () => {
    const s = await setupMeeting('lh1');
    say(s.meetingId, s.hostId, '2호기 진동 알람 또 떴어요');
    say(s.meetingId, s.memberId, '베어링 교체 요청 넣었습니다');
    insertRecap(s.meetingId, ['검사 온도 65도로 상향']);
    db.prepare('INSERT INTO todos (user_id, meeting_id, title) VALUES (?, ?, ?)').run(s.memberId, s.meetingId, '필터 교체');
    setNextResponses(
      JSON.stringify({
        issues: ['1', '2', '3', '4', '5', '6', '7'].map((n) => `이상 ${n}`),
        changes: '문자열이면 무시',
        pending: ['필터 교체 (lh1_member)', 42, '', null],
        notes: ['x'.repeat(300)],
      }) + '\n```',
    );
    const r = await draftHandover(s.meetingId);
    expect(r.source).toBe('ai');
    expect(r.sections.issues).toHaveLength(6);
    expect(r.sections.changes).toEqual([]);
    expect(r.sections.pending).toEqual(['필터 교체 (lh1_member)', '42']);
    expect(r.sections.notes[0]).toHaveLength(160);

    const req = captured[0];
    expect(req.model).toBe('gpt-4o-mini');
    expect(req.temperature).toBe(0.2);
    expect(req.max_tokens).toBe(500);
    expect(req.response_format).toEqual({ type: 'json_object' });
    const p = userPayload<{ chat: string[]; decisions: string[]; undone_todos: string[]; past_records?: string[] }>(req);
    expect(p.chat).toEqual(['lh1_host: 2호기 진동 알람 또 떴어요', 'lh1_member: 베어링 교체 요청 넣었습니다']);
    expect(p.decisions).toEqual(['검사 온도 65도로 상향']);
    expect(p.undone_todos).toEqual(['필터 교체 (lh1_member)']);
    expect(p.past_records).toBeUndefined();
    expect(systemPrompt(req)).toContain('past_records는 과거 관련 기록');
  });

  it('RAG에 관련 과거 기록이 있으면 past_records로 함께 넘긴다', async () => {
    const s = await setupMeeting('lh2');
    setEmbedder(keywordEmbedder(['2호기', '진동']));
    const recapId = insertRecap(s.meetingId, ['2호기 진동 원인은 베어링 마모 — 교체 주기 3개월로']);
    indexRecap(s.meetingId, recapId, { summary: '', decisions: ['2호기 진동 원인은 베어링 마모 — 교체 주기 3개월로'], date: '2026-06-01' });
    await waitFor(() => (db.prepare('SELECT COUNT(*) c FROM rag_chunks WHERE meeting_id = ?').get(s.meetingId) as { c: number }).c === 1);
    say(s.meetingId, s.hostId, '2호기 진동 알람 또 떴어요');
    queueJson({ issues: ['2호기 진동 알람'], changes: [], pending: [], notes: ['(과거 기록) 베어링 교체 주기 3개월'] });
    const r = await draftHandover(s.meetingId);
    expect(r.sections.notes).toEqual(['(과거 기록) 베어링 교체 주기 3개월']);
    expect(userPayload<{ past_records: string[] }>(captured[0]).past_records).toEqual([
      '[결정 2026-06-01] 2호기 진동 원인은 베어링 마모 — 교체 주기 3개월로',
    ]);
  });

  it('AI 실패 → 규칙 폴백(변경=결정, 미결=열린 할 일), 재료가 없으면 호출 없이 규칙', async () => {
    const s = await setupMeeting('lh3');
    insertRecap(s.meetingId, ['야간조 2인 편성']);
    db.prepare('INSERT INTO todos (user_id, meeting_id, title) VALUES (?, ?, ?)').run(s.hostId, s.meetingId, '자재 발주');
    setNextResponses(new Error('500'));
    const r = await draftHandover(s.meetingId);
    expect(r).toEqual({ source: 'rule', sections: { issues: [], changes: ['야간조 2인 편성'], pending: ['자재 발주 (lh3_host)'], notes: [] } });

    const empty = await setupMeeting('lh3b');
    const r2 = await draftHandover(empty.meetingId);
    expect(r2.source).toBe('rule');
    expect(captured).toHaveLength(1);
  });
});

describe('reviewHandover — 부족분 점검', () => {
  it('AI 제안은 섹션 검증(모르는 섹션→notes)·빈 텍스트 제거·5개 캡, 초안은 위생 처리해 넘긴다', async () => {
    const s = await setupMeeting('lh4');
    say(s.meetingId, s.hostId, '3호기 압력 게이지 흔들려요');
    queueJson({
      suggestions: [
        { section: 'issues', text: '3호기 압력 게이지 불안정' },
        { section: 'foo', text: '섹션 모름' },
        { section: 'pending', text: '' },
        ...[1, 2, 3, 4].map((n) => ({ section: 'notes', text: `추가 ${n}` })),
      ],
    });
    const r = await reviewHandover(s.meetingId, { issues: ['  이슈 A  '], changes: 'x', pending: [], notes: [] });
    expect(r.source).toBe('ai');
    expect(r.suggestions).toHaveLength(5);
    expect(r.suggestions[0]).toEqual({ section: 'issues', text: '3호기 압력 게이지 불안정' });
    expect(r.suggestions[1]).toEqual({ section: 'notes', text: '섹션 모름' });
    const p = userPayload<{ draft: unknown; chat: string[] }>(captured[0]);
    expect(p.draft).toEqual({ issues: ['이슈 A'], changes: [], pending: [], notes: [] });
    expect(p.chat).toEqual(['lh4_host: 3호기 압력 게이지 흔들려요']);
    expect(captured[0].max_tokens).toBe(400);
  });

  it('AI 실패 → 규칙: 초안에 없는 미완료 할 일·결정만 제안', async () => {
    const s = await setupMeeting('lh5');
    insertRecap(s.meetingId, ['검사 온도 65도로 상향']);
    db.prepare('INSERT INTO todos (user_id, meeting_id, title) VALUES (?, ?, ?)').run(s.memberId, s.meetingId, '필터 교체');
    setNextResponses(new Error('down'));
    const r = await reviewHandover(s.meetingId, { changes: ['검사 온도 65도로 상향 적용'] });
    expect(r).toEqual({ source: 'rule', suggestions: [{ section: 'pending', text: '필터 교체 (lh5_member)' }] });
  });
});

describe('복명복창 대조 (echoCheck) — 서명 노트 vs 원본', () => {
  const sections = { issues: [], changes: ['일요일 저녁 8시 브리핑 진행'], pending: ['필터 교체'], notes: [] };

  it('모순 후보(인용 실재) + 2차 "동시에 참일 수 없음" → mismatch 저장 + 작성자·수신자 알림', async () => {
    const s = await setupMeeting('lh6');
    const id = publishHandover(s.meetingId, s.code, s.hostId, '주간조', sections, 'manual');
    const note = '브리핑은 월요일 저녁 8시로 이해했어요';
    queueJson({ contradictions: [{ receiver_said: '브리핑은 월요일 저녁 8시', original_says: '일요일 저녁 8시 브리핑 진행' }] });
    setNextResponses('{"compatible": false} — 요일이 다릅니다 {끝}'); // 2차 판정 뒤 잡설도 파싱
    expect(ackHandover(id, s.meetingId, s.memberId, note)).toBe(true);
    await waitFor(() => ackRow(id, s.memberId)?.echo_check != null);
    expect(ackRow(id, s.memberId)).toEqual({
      note,
      echo_check: 'mismatch',
      echo_reason: '"브리핑은 월요일 저녁 8시" ↔ 원본: 일요일 저녁 8시 브리핑 진행',
    });
    for (const uid of [s.hostId, s.memberId]) {
      expect(notiTexts(uid).some((t) => t.startsWith('[주간조] 인수인계 이해가 어긋난 것 같아요') && t.includes('lh6_member'))).toBe(true);
    }
    expect(captured).toHaveLength(2);
    expect(captured[0].model).toBe('gpt-4o'); // 모순 판정은 상위 모델 고정
    expect(captured[0].temperature).toBe(0);
    expect(captured[0].max_tokens).toBe(300);
    expect(userPayload(captured[0])).toEqual({ original: sections, receiver_understanding: note });
    expect(captured[1].max_tokens).toBe(60);
    expect(userPayload(captured[1])).toEqual({ 문장A: '일요일 저녁 8시 브리핑 진행', 문장B: '브리핑은 월요일 저녁 8시' });
    const listed = listHandovers(s.meetingId)[0];
    expect(listed.acks[0]).toMatchObject({ username: 'lh6_member', note, echoCheck: 'mismatch' });
  });

  it('노트에 없는 인용·"누락"류 사유는 서버가 폐기 → 2차 호출 없이 ok', async () => {
    const s = await setupMeeting('lh7');
    const id = publishHandover(s.meetingId, s.code, s.hostId, '', sections, 'manual');
    queueJson({
      contradictions: [
        { receiver_said: '브리핑은 화요일', original_says: '일요일 저녁 8시' }, // 노트에 없는 문장
        { receiver_said: '필터 교체는 제가 할게요', original_says: '브리핑 언급 누락' }, // 누락은 모순이 아님
      ],
    });
    ackHandover(id, s.meetingId, s.memberId, '필터 교체는 제가 할게요');
    await waitFor(() => ackRow(id, s.memberId)?.echo_check != null);
    expect(ackRow(id, s.memberId)).toMatchObject({ echo_check: 'ok', echo_reason: null });
    expect(captured).toHaveLength(1);
    expect(notiTexts(s.hostId).some((t) => t.includes('어긋난'))).toBe(false);
  });

  it('2차 판정이 "양립 가능"이거나 파싱 불가면 쌍 폐기 → ok', async () => {
    const s = await setupMeeting('lh8');
    const id = publishHandover(s.meetingId, s.code, s.hostId, '', sections, 'manual');
    const note = '브리핑에 참석하겠습니다';
    queueJson({ contradictions: [{ receiver_said: '브리핑에 참석하겠습니다', original_says: '브리핑 진행' }] });
    queueJson({ compatible: true });
    ackHandover(id, s.meetingId, s.memberId, note);
    await waitFor(() => ackRow(id, s.memberId)?.echo_check != null);
    expect(ackRow(id, s.memberId)!.echo_check).toBe('ok');

    // 노트 갱신 → 대조 재시작 (echo_check 초기화 후 다시 판정)
    queueJson({ contradictions: [{ receiver_said: '브리핑은 월요일', original_says: '일요일 브리핑' }] });
    setNextResponses('모르겠습니다');
    ackHandover(id, s.meetingId, s.memberId, '브리핑은 월요일');
    await waitFor(() => ackRow(id, s.memberId)?.echo_check != null);
    expect(ackRow(id, s.memberId)).toMatchObject({ note: '브리핑은 월요일', echo_check: 'ok' });
  });

  it('1차 응답이 JSON이 아니면 대조는 조용히 실패 — 서명은 유지되고 echo_check는 비어 있다', async () => {
    const s = await setupMeeting('lh9');
    const id = publishHandover(s.meetingId, s.code, s.hostId, '', sections, 'manual');
    setNextResponses('판단할 수 없습니다');
    expect(ackHandover(id, s.meetingId, s.memberId, '필터 교체 이어받겠습니다')).toBe(true);
    await waitFor(() => captured.length === 1);
    await flush();
    expect(ackRow(id, s.memberId)).toEqual({ note: '필터 교체 이어받겠습니다', echo_check: null, echo_reason: null });
    // 노트 없는 서명은 대조 자체를 하지 않는다
    expect(ackHandover(id, s.meetingId, s.hostId)).toBe(true);
    await flush();
    expect(captured).toHaveLength(1);
  });
});
