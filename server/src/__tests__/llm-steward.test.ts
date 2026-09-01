import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * steward.ts의 AI 경로 — @AI 답변(찌꺼기 누출 정리·근거 페이로드), DM 질의, 안건 생성·정산·보류 깨우기,
 * 결정 감지 판정, 사후 누락 감지, 이력 그룹핑. OpenAI 클라이언트는 모의.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  delete process.env.OPENAI_MODEL_JUDGE;
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { ensureDefaultChannel } from '../channels.js';
import {
  handleAgentQuery,
  answerDmQuery,
  generateAgenda,
  generateDecisionHistory,
  maybeSuggestDecision,
  settleAgendaAfterRecap,
  wakeWaitingAgendas,
  setAgendaStatus,
  resolveAgendaItem,
  verifyIncompatible,
  ensureAgentUser,
  DECISION_AUTO_PREFIX,
} from '../steward.js';
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
  const m = await request(app)
    .post('/api/meetings')
    .set('Authorization', `Bearer ${host.token}`)
    .send({ title: `${prefix} 그룹` });
  const code = m.body.code as string;
  await request(app).post('/api/meetings/join').set('Authorization', `Bearer ${member.token}`).send({ code });
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
  const hostId = userId(`${prefix}_host`);
  const memberId = userId(`${prefix}_member`);
  const channelId = ensureDefaultChannel(meetingId, hostId);
  return { host, member, code, meetingId, hostId, memberId, channelId, title: `${prefix} 그룹` };
}
function say(meetingId: number, uid: number, text: string, channelId?: number) {
  db.prepare('INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)').run(
    meetingId, uid, text, channelId ?? null);
}
function insertRecap(meetingId: number, decisions: string[], whys: string[] = [], attendees: string[] = [], createdAt?: string) {
  return db
    .prepare(
      `INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, alts, actions, attendees, source, created_at, call_ended_at)
       VALUES (?, ?, ?, ?, ?, '[]', ?, 'ai', COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`,
    )
    .run(meetingId, decisions[0] ?? '요약', JSON.stringify(decisions), JSON.stringify(decisions.map((_, i) => whys[i] ?? '')),
      JSON.stringify(decisions.map(() => [])), JSON.stringify(attendees), createdAt ?? null, createdAt ?? null).lastInsertRowid as number;
}
function makeIo() {
  const emitted: { room: string; ev: string; payload: { text?: string; channelId?: number } }[] = [];
  const io = {
    to: (room: string) => ({
      emit: (ev: string, payload: unknown) => emitted.push({ room, ev, payload: payload as { text?: string } }),
    }),
  };
  return { io, emitted, messages: () => emitted.filter((e) => e.ev === 'chat:message') };
}
function notiTexts(uid: number): string[] {
  return (db.prepare('SELECT text FROM notifications WHERE user_id = ? ORDER BY id').all(uid) as { text: string }[]).map((n) => n.text);
}

beforeEach(() => resetOpenAiMock());

describe('@AI 답변 (aiAnswer)', () => {
  it('answer 문자열 안에 새어든 추론 찌꺼기를 잘라내고, 근거 페이로드에 원장·정리·할 일·일정·대화·안건·인수인계를 싣는다', async () => {
    const s = await setupMeeting('ls1');
    insertRecap(s.meetingId, ['방열판 검사 온도 65도로 상향'], ['60도에서 편차가 컸음'], ['ls1_host']);
    db.prepare('INSERT INTO todos (user_id, meeting_id, title) VALUES (?, ?, ?)').run(s.hostId, s.meetingId, '체크리스트 갱신');
    db.prepare("INSERT INTO meeting_events (meeting_id, title, date, time, created_by) VALUES (?, '주간 회의', date('now', '+3 days'), '15:00', ?)").run(s.meetingId, s.hostId);
    const agendaId = db.prepare("INSERT INTO agenda_items (meeting_id, title, why, status, status_note) VALUES (?, '인증 갱신', '지난 회의', 'hold', '품질 인증 승인 대기')").run(s.meetingId).lastInsertRowid;
    expect(agendaId).toBeTruthy();
    db.prepare("INSERT INTO handovers (meeting_id, author_id, shift_label, sections) VALUES (?, ?, '주간조', ?)").run(
      s.meetingId, s.memberId, JSON.stringify({ issues: ['2호기 진동 알람'], changes: [], pending: ['필터 교체'], notes: [] }));
    say(s.meetingId, s.hostId, '온도 기준 다시 확인 부탁해요', s.channelId);
    say(s.meetingId, ensureAgentUser(), '(과거 AI 답변 — 근거에서 제외돼야 함)', s.channelId);

    // 9/1 라이브 회귀 재현: 값 안에 `"}ᴏɴ} icycle Done.` 누출 + JSON 뒤 잡설
    setNextResponses(JSON.stringify({ answer: '방열판 검사 온도는 65도예요."}ᴏɴ} icycle Done.' }) + ' {"noise":true} end');
    const { io, messages } = makeIo();
    await handleAgentQuery(io, { meetingId: s.meetingId, code: s.code, channelId: s.channelId, asker: 'ls1_host', text: '@AI, 방열판 온도 기준이 뭐였지?' });

    expect(messages()).toHaveLength(1);
    expect(messages()[0].payload.text).toBe('방열판 검사 온도는 65도예요.');
    expect(messages()[0].payload.channelId).toBe(s.channelId);
    const saved = db.prepare('SELECT text FROM messages WHERE meeting_id = ? AND user_id = ?').all(s.meetingId, ensureAgentUser()) as { text: string }[];
    expect(saved.map((r) => r.text)).toContain('방열판 검사 온도는 65도예요.');

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.model).toBe('gpt-4o-mini');
    expect(req.temperature).toBe(0.2);
    expect(req.max_tokens).toBe(400);
    expect(req.response_format).toEqual({ type: 'json_object' });
    expect(systemPrompt(req)).toContain(`"${s.title}" 그룹`);
    const p = userPayload<{
      question: string; asker: string;
      records: { decisions: string[]; call_summaries: string[]; todos: string[]; upcoming_events: string[]; recent_chat: string[]; open_agenda?: string[]; recent_handovers?: string[]; related_history?: string[] };
    }>(req);
    expect(p.question).toBe('방열판 온도 기준이 뭐였지?'); // 멘션·앞 문장부호 제거
    expect(p.asker).toBe('ls1_host');
    expect(p.records.decisions).toEqual(['방열판 검사 온도 65도로 상향 (배경: 60도에서 편차가 컸음)']);
    expect(p.records.call_summaries).toEqual(['방열판 검사 온도 65도로 상향']);
    expect(p.records.todos).toEqual(['체크리스트 갱신 (ls1_host)']);
    expect(p.records.upcoming_events[0]).toMatch(/^\d{4}-\d{2}-\d{2} 15:00 주간 회의$/);
    expect(p.records.recent_chat).toEqual(['ls1_host: 온도 기준 다시 확인 부탁해요']);
    expect(p.records.open_agenda).toEqual(['인증 갱신 [보류: 품질 인증 승인 대기] (지난 회의)']);
    expect(p.records.recent_handovers).toHaveLength(1);
    expect(p.records.recent_handovers![0]).toContain('주간조 ls1_member: 이슈: 2호기 진동 알람 / 미결: 필터 교체');
    expect(p.records.related_history).toBeUndefined(); // 색인 없음 → 백필만 걸고 이번엔 빈 결과
  });

  it('모델 실패·빈 answer는 규칙 폴백 (원장 나열), 예외는 호출자에 안 새어 나간다', async () => {
    const s = await setupMeeting('ls2');
    insertRecap(s.meetingId, ['데모 시나리오는 오송 라인 점검으로 확정']);
    const { io, messages } = makeIo();
    setNextResponses(new Error('429 rate limit'));
    await handleAgentQuery(io, { meetingId: s.meetingId, code: s.code, channelId: s.channelId, asker: 'ls2_host', text: '@AI 뭐 결정했지?' });
    expect(messages()[0].payload.text).toContain('최근 결정이에요');
    expect(messages()[0].payload.text).toContain('오송 라인');

    queueJson({ answer: '   ' });
    await handleAgentQuery(io, { meetingId: s.meetingId, code: s.code, channelId: s.channelId, asker: 'ls2_host', text: '@AI' });
    expect(messages()).toHaveLength(2);
    expect(messages()[1].payload.text).toContain('가장 최근 통화 정리예요'); // 빈 질문 → "지금 상황 요약해줘"
  });

  it('RAG 색인이 있으면 질문 의미로 찾은 과거 기록을 related_history로 주입', async () => {
    const s = await setupMeeting('ls3');
    setEmbedder(keywordEmbedder(['방열판', '온도', '휴가']));
    const recapId = insertRecap(s.meetingId, ['방열판 검사 온도 65도로 상향', '여름 휴가 일정은 7월 말']);
    indexRecap(s.meetingId, recapId, { summary: '기준 상향 회의', decisions: ['방열판 검사 온도 65도로 상향', '여름 휴가 일정은 7월 말'], date: '2026-08-01' });
    await waitFor(() => (db.prepare('SELECT COUNT(*) c FROM rag_chunks WHERE meeting_id = ?').get(s.meetingId) as { c: number }).c >= 3);

    queueJson({ answer: '65도예요.' });
    const { io, messages } = makeIo();
    await handleAgentQuery(io, { meetingId: s.meetingId, code: s.code, channelId: s.channelId, asker: 'ls3_host', text: '@AI 방열판 온도' });
    expect(messages()[0].payload.text).toBe('65도예요.');
    const related = userPayload<{ records: { related_history?: string[] } }>(captured[0]).records.related_history!;
    expect(related).toHaveLength(1); // 휴가 결정은 코사인 0 → 임계(0.25) 미달
    expect(related[0]).toBe('[결정 2026-08-01] 방열판 검사 온도 65도로 상향');
  });

  it('DM 1:1 질의 — 스코프 내 그룹의 결정을 [그룹명] 접두로 싣고, 실패 시 규칙 폴백', async () => {
    const s = await setupMeeting('ls4');
    insertRecap(s.meetingId, ['출시일 9월 말 확정'], ['QA 일정']);
    queueJson({ answer: '9월 말이에요.' });
    const a = await answerDmQuery(null, s.hostId, '출시일 언제였지?');
    expect(a).toBe('9월 말이에요.');
    const p = userPayload<{ asker: string; records: { decisions: string[]; recent_chat: string[] } }>(captured[0]);
    expect(p.asker).toBe('ls4_host');
    expect(p.records.decisions).toEqual([`[${s.title}] 출시일 9월 말 확정 (배경: QA 일정)`]);
    expect(p.records.recent_chat).toEqual([]); // 1:1은 그룹 대화를 근거로 안 씀
    expect(systemPrompt(captured[0])).toContain('"개인 워크스페이스" 그룹');

    setNextResponses(new Error('boom'));
    const b = await answerDmQuery(null, s.hostId, '출시일 결정?');
    expect(b).toContain('최근 결정이에요');
  });
});

describe('안건 (aiAgenda · 정산 · 보류 깨우기)', () => {
  it('AI 안건 — 내부 키 이름 누출 제거, 이월 안건 상단 배치, 영속 + id 부착, 10분 캐시', async () => {
    const s = await setupMeeting('ls5');
    db.prepare('INSERT INTO todos (user_id, meeting_id, title) VALUES (?, ?, ?)').run(s.hostId, s.meetingId, '체크리스트 갱신');
    db.prepare("INSERT INTO agenda_items (meeting_id, title, why, rounds) VALUES (?, '지난 이월 안건', '지난 통화 미결', 2)").run(s.meetingId);
    queueJson({
      items: [
        { title: '체크리스트 갱신 진행 상황 (undone_todos)', why: 'undone_todos 미완료' },
        { title: '', why: '빈 제목은 버림' },
        { title: '검사 기준 재검토', why: 'recent_chat에서 언급' },
      ],
    });
    const r = await generateAgenda(s.meetingId, s.channelId);
    expect(r.source).toBe('ai');
    expect(r.items[0]).toMatchObject({ title: '지난 이월 안건', why: '2회째 안건 — 아직 결론 없음', rounds: 2 });
    expect(r.items[0].id).toBeTypeOf('number');
    expect(r.items[1]).toMatchObject({ title: '체크리스트 갱신 진행 상황', why: '미완료' });
    expect(r.items[2].title).toBe('검사 기준 재검토');
    expect(r.items[2].why).not.toContain('recent_chat');
    expect(r.items.every((it) => typeof it.id === 'number')).toBe(true);
    const persisted = db.prepare('SELECT title FROM agenda_items WHERE meeting_id = ? AND resolved = 0 ORDER BY id').all(s.meetingId) as { title: string }[];
    expect(persisted.map((p) => p.title)).toEqual(['지난 이월 안건', '체크리스트 갱신 진행 상황', '검사 기준 재검토']);

    const p = userPayload<{ undone_todos: string[]; carryover_titles: string[] }>(captured[0]);
    expect(p.undone_todos).toEqual(['체크리스트 갱신 (ls5_host)']);
    expect(p.carryover_titles).toEqual(['지난 이월 안건']);
    expect(systemPrompt(captured[0])).toContain('carryover_titles');
    expect(captured[0].temperature).toBe(0.3);

    const again = await generateAgenda(s.meetingId, s.channelId);
    expect(again.generatedAt).toBe(r.generatedAt); // 캐시
    expect(captured).toHaveLength(1);
  });

  it('AI가 빈 items·items 아님을 돌려주면 규칙 폴백 (미완료 할 일 기반)', async () => {
    const s = await setupMeeting('ls6');
    db.prepare('INSERT INTO todos (user_id, meeting_id, title) VALUES (?, ?, ?)').run(s.memberId, s.meetingId, '자재 발주');
    queueJson({ items: [] });
    const r = await generateAgenda(s.meetingId, s.channelId);
    expect(r.source).toBe('rule');
    expect(r.items[0].title).toContain('자재 발주');
    expect(r.items[0].id).toBeUndefined(); // 규칙 안건은 미영속
  });

  it('유사한 과거 종결 안건이 있으면 closedBefore로 선제 안내 (임계 0.5)', async () => {
    const s = await setupMeeting('ls7');
    setEmbedder(keywordEmbedder(['야간조', '인원', '감축']));
    const closedId = db.prepare("INSERT INTO agenda_items (meeting_id, title, why) VALUES (?, '야간조 인원 감축', '비용')").run(s.meetingId).lastInsertRowid as number;
    expect(resolveAgendaItem(s.meetingId, closedId, '안전팀 반대', s.hostId)).toBe(true);
    await waitFor(() => (db.prepare("SELECT COUNT(*) c FROM rag_chunks WHERE meeting_id = ? AND kind = 'agenda'").get(s.meetingId) as { c: number }).c === 1);

    queueJson({ items: [{ title: '야간조 인원 감축 재검토', why: '최근 대화' }, { title: '휴가 일정 조율', why: '채팅' }] });
    const r = await generateAgenda(s.meetingId, s.channelId);
    const hit = r.items.find((it) => it.title === '야간조 인원 감축 재검토')!;
    expect(hit.closedBefore).toMatch(/^\d{2}\/\d{2} 종결: 야간조 인원 감축 — 종결 사유: 안전팀 반대$/);
    expect(hit.closedBeforeId).toBe(closedId);
    expect(r.items.find((it) => it.title === '휴가 일정 조율')!.closedBefore).toBeNull();
  });

  it('recap 후 정산 — AI가 지목한 (안건 id, 결정 idx)만 검증 후 종결, 나머지는 rounds+1 이월', async () => {
    const s = await setupMeeting('ls8');
    const a = db.prepare("INSERT INTO agenda_items (meeting_id, title) VALUES (?, '검사 온도 기준 확정')").run(s.meetingId).lastInsertRowid as number;
    const b = db.prepare("INSERT INTO agenda_items (meeting_id, title) VALUES (?, '야간조 편성')").run(s.meetingId).lastInsertRowid as number;
    const recapId = insertRecap(s.meetingId, ['검사 온도 65도로 상향']);
    queueJson({ resolved: [{ id: a, decision_idx: 0 }, { id: 99999, decision_idx: 0 }, { id: b, decision_idx: 5 }] });
    await settleAgendaAfterRecap(s.meetingId, { summary: '기준 상향', decisionRefs: [{ text: '검사 온도 65도로 상향', recapId, idx: 0 }] }, recapId);

    const rows = db.prepare('SELECT id, resolved, rounds, resolved_recap_id, resolved_decision_idx FROM agenda_items WHERE meeting_id = ? ORDER BY id').all(s.meetingId) as
      { id: number; resolved: number; rounds: number; resolved_recap_id: number | null; resolved_decision_idx: number | null }[];
    expect(rows).toEqual([
      { id: a, resolved: 1, rounds: 1, resolved_recap_id: recapId, resolved_decision_idx: 0 },
      { id: b, resolved: 0, rounds: 2, resolved_recap_id: null, resolved_decision_idx: null },
    ]);
    const events = db.prepare('SELECT agenda_id, kind, detail FROM agenda_events WHERE meeting_id = ? ORDER BY id').all(s.meetingId) as { agenda_id: number; kind: string; detail: string | null }[];
    expect(events).toEqual([
      { agenda_id: a, kind: 'resolved', detail: '검사 온도 65도로 상향' },
      { agenda_id: b, kind: 'carried', detail: null },
    ]);
    const p = userPayload<{ agenda_items: { id: number; title: string }[]; meeting_decisions: string[] }>(captured[0]);
    expect(p.agenda_items).toEqual([{ id: a, title: '검사 온도 기준 확정' }, { id: b, title: '야간조 편성' }]);
    expect(p.meeting_decisions).toEqual(['검사 온도 65도로 상향']);

    // 구형 응답(resolved_ids) 호환 — 결정 링크 없이 종결만
    queueJson({ resolved_ids: [b] });
    await settleAgendaAfterRecap(s.meetingId, { summary: '편성 확정', decisionRefs: [{ text: '야간조 3인 편성', recapId, idx: 0 }] }, recapId);
    const bRow = db.prepare('SELECT resolved, resolved_recap_id FROM agenda_items WHERE id = ?').get(b) as { resolved: number; resolved_recap_id: number | null };
    expect(bRow).toEqual({ resolved: 1, resolved_recap_id: null });

    // AI 실패 → 보수적으로 전부 이월
    const c = db.prepare("INSERT INTO agenda_items (meeting_id, title) VALUES (?, '남는 안건')").run(s.meetingId).lastInsertRowid as number;
    setNextResponses(new Error('down'));
    await settleAgendaAfterRecap(s.meetingId, { summary: 'x', decisionRefs: [{ text: '남는 안건 종결', recapId, idx: 0 }] }, recapId);
    expect((db.prepare('SELECT resolved, rounds FROM agenda_items WHERE id = ?').get(c) as { resolved: number; rounds: number })).toEqual({ resolved: 0, rounds: 2 });
  });

  it('보류 깨우기 — 대기 조건과 회의 요약이 임베딩으로 닿으면 호스트·상태 지정자에게 알림 + wake 이벤트 (recap당 1회)', async () => {
    const s = await setupMeeting('ls9');
    setEmbedder(keywordEmbedder(['인증', '승인', '발주']));
    const w = db.prepare("INSERT INTO agenda_items (meeting_id, title) VALUES (?, '인증 갱신')").run(s.meetingId).lastInsertRowid as number;
    expect(setAgendaStatus(s.meetingId, w, 'hold', s.memberId, '품질 인증 승인 대기')).toBe(true);
    const other = db.prepare("INSERT INTO agenda_items (meeting_id, title, status, status_note) VALUES (?, '자재 발주', 'waiting_dept', '구매팀 발주 대기')").run(s.meetingId).lastInsertRowid as number;
    const recapId = insertRecap(s.meetingId, ['인증서는 다음 주 발급']);

    await wakeWaitingAgendas(s.meetingId, [{ text: '인증서는 다음 주 발급', recapId, idx: 0 }], recapId, '품질 인증 최종 승인 완료');
    const wakes = db.prepare("SELECT agenda_id, recap_id, detail FROM agenda_events WHERE kind = 'wake' AND meeting_id = ?").all(s.meetingId) as { agenda_id: number; recap_id: number; detail: string }[];
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agenda_id: w, recap_id: recapId });
    expect(wakes[0].detail).toContain('기다리던 조건과 관련된 회의 내용 감지');
    expect(db.prepare("SELECT COUNT(*) c FROM agenda_events WHERE kind = 'wake' AND agenda_id = ?").get(other)).toEqual({ c: 0 });
    for (const uid of [s.hostId, s.memberId]) {
      const t = notiTexts(uid).find((x) => x.includes('다시 올려볼까요'))!;
      expect(t).toContain("보류 안건 '인증 갱신'");
    }
    // 같은 recap으로 다시 → 중복 없음
    await wakeWaitingAgendas(s.meetingId, [{ text: '인증서는 다음 주 발급', recapId, idx: 0 }], recapId, '품질 인증 최종 승인 완료');
    expect(db.prepare("SELECT COUNT(*) c FROM agenda_events WHERE kind = 'wake' AND meeting_id = ?").get(s.meetingId)).toEqual({ c: 1 });
  });
});

describe('결정 이력 그룹핑 (aiGroupHistory)', () => {
  it('AI는 인덱스만 돌려주고 서버가 검증 — 범위 밖·중복 제거, 누락 결정은 단독 토픽으로 회수', async () => {
    const s = await setupMeeting('ls10');
    insertRecap(s.meetingId, ['출시일 8월 말'], [], [], '2026-06-01 09:00:00');
    insertRecap(s.meetingId, ['로고 파란색 확정'], [], [], '2026-06-10 09:00:00');
    insertRecap(s.meetingId, ['출시일 9월 말로 연기'], [], [], '2026-07-01 09:00:00');
    queueJson({ topics: [{ title: '출시일', indexes: [0, 2, 7, 0, 'x'] }, { title: '빈 토픽', indexes: [] }] });
    const h = await generateDecisionHistory(s.meetingId);
    expect(h.source).toBe('ai');
    expect(h.topics.map((t) => t.title)).toEqual(['출시일', '로고 파란색 확정']);
    expect(h.topics[0].entries.map((e) => e.decision)).toEqual(['출시일 8월 말', '출시일 9월 말로 연기']);
    expect(userPayload<{ decisions: { i: number; text: string; date: string }[] }>(captured[0]).decisions).toEqual([
      { i: 0, text: '출시일 8월 말', date: '2026-06-01' },
      { i: 1, text: '로고 파란색 확정', date: '2026-06-10' },
      { i: 2, text: '출시일 9월 말로 연기', date: '2026-07-01' },
    ]);

    const s2 = await setupMeeting('ls10b');
    insertRecap(s2.meetingId, ['A'], [], [], '2026-06-01 09:00:00');
    insertRecap(s2.meetingId, ['B'], [], [], '2026-06-02 09:00:00');
    setNextResponses('{"topics": "not an array"}');
    const h2 = await generateDecisionHistory(s2.meetingId);
    expect(h2.source).toBe('rule');
    expect(h2.topics).toEqual([{ title: '전체 이력', entries: expect.any(Array) }]);
  });
});

describe('채팅 결정 감지 · 사후 누락 감지', () => {
  it('record 판정 → 자동 기록(source auto) + 원장 안내 + 발언자 외 참가자 알림', async () => {
    const s = await setupMeeting('ls11');
    say(s.meetingId, s.memberId, 'QA 일정 때문에 8월은 어렵겠어요', s.channelId);
    const text = '그럼 출시일은 9월 말로 확정했습니다';
    say(s.meetingId, s.hostId, text, s.channelId);
    queueJson({ verdict: 'record', decision: '출시일 9월 말 확정', why: 'QA 일정' });
    const { io, messages } = makeIo();
    maybeSuggestDecision(io, { meetingId: s.meetingId, code: s.code, channelId: s.channelId, from: 'ls11_host', text });
    await waitFor(() => messages().length > 0);

    const auto = db.prepare("SELECT id, decisions, whys, attendees FROM meeting_recaps WHERE meeting_id = ? AND source = 'auto'").get(s.meetingId) as { id: number; decisions: string; whys: string; attendees: string };
    expect(JSON.parse(auto.decisions)).toEqual(['출시일 9월 말 확정']);
    expect(JSON.parse(auto.whys)).toEqual(['QA 일정']);
    expect(JSON.parse(auto.attendees)).toEqual(['ls11_host']);
    expect(messages()[0].payload.text).toBe(`${DECISION_AUTO_PREFIX}"출시일 9월 말 확정" (배경: QA 일정) — 잘못 기록됐다면 취소할 수 있어요 #R${auto.id}`);
    expect(notiTexts(s.memberId).some((t) => t.includes('결정이 원장에 기록됐어요'))).toBe(true);
    expect(notiTexts(s.hostId).some((t) => t.includes('결정이 원장에 기록됐어요'))).toBe(false);

    const p = userPayload<{ recent_chat: string[]; flagged_message: string }>(captured[0]);
    expect(p.flagged_message).toBe(`ls11_host: ${text}`);
    expect(p.recent_chat).toEqual(['ls11_member: QA 일정 때문에 8월은 어렵겠어요', `ls11_host: ${text}`]);
    expect(captured[0].temperature).toBe(0);
    expect(captured[0].max_tokens).toBe(300);

    // 2분 쿨다운 — 같은 회의의 다음 결정 발언은 판정 호출 없음
    maybeSuggestDecision(io, { meetingId: s.meetingId, code: s.code, channelId: s.channelId, from: 'ls11_host', text: '로고는 파란색으로 결정했습니다' });
    await flush();
    expect(captured).toHaveLength(1);
  });

  it('ignore 판정은 침묵, 판정 실패는 suggest 폴백, @AI 멘션은 감지 대상 아님', async () => {
    const s = await setupMeeting('ls12');
    const { io, messages } = makeIo();
    queueJson({ verdict: 'ignore', decision: '', why: '' });
    maybeSuggestDecision(io, { meetingId: s.meetingId, code: s.code, channelId: s.channelId, from: 'ls12_host', text: '만약 우리가 A안으로 결정했다면 어땠을까' });
    await waitFor(() => captured.length === 1);
    await flush();
    expect(messages()).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) c FROM meeting_recaps WHERE meeting_id = ?").get(s.meetingId)).toEqual({ c: 0 });

    const s2 = await setupMeeting('ls12b');
    setNextResponses(new Error('timeout'));
    maybeSuggestDecision(io, { meetingId: s2.meetingId, code: s2.code, channelId: s2.channelId, from: 'ls12b_host', text: '납기는 금요일로 확정했어요' });
    await waitFor(() => messages().length > 0);
    expect(messages()[0].payload.text).toBe('💡 결정 후보: "납기는 금요일로 확정했어요" — ls12b_host님의 발언을 결정 원장에 기록할까요?');

    const s3 = await setupMeeting('ls12c');
    maybeSuggestDecision(io, { meetingId: s3.meetingId, code: s3.code, channelId: s3.channelId, from: 'ls12c_host', text: '@AI 우리 뭐 확정했지?' });
    await flush();
    expect(captured).toHaveLength(2);
  });

  it('사후 누락 감지 — 옛 기준 발언을 원장과 대조, 인용 실재 + 결정 실재 + 2차 양립 검증(gpt-4o) 후에만 끼어든다', async () => {
    const s = await setupMeeting('ls13');
    const decision = '방열판 검사 온도 기준 65도로 상향';
    insertRecap(s.meetingId, [decision]);
    const { io, messages } = makeIo();
    const text = '내일부터 검사 온도 60도로 맞추면 되죠?';
    queueJson({ found: true, message_part: '검사 온도 60도로 맞추면', decision });
    queueJson({ compatible: false });
    maybeSuggestDecision(io, { meetingId: s.meetingId, code: s.code, channelId: s.channelId, from: 'ls13_member', text });
    await waitFor(() => messages().length > 0);
    expect(messages()[0].payload.text).toBe(`⚠️ 방금 말씀이 기록과 어긋날 수 있어요 — 원장 결정: "${decision}" · 말씀: "검사 온도 60도로 맞추면". 기준이 바뀌었는지 확인해 주세요.`);
    expect(captured).toHaveLength(2);
    expect(userPayload<{ decisions: string[]; message: string }>(captured[0])).toEqual({ decisions: [decision], message: `ls13_member: ${text}` });
    expect(captured[1].model).toBe('gpt-4o');
    expect(captured[1].temperature).toBe(0);
    expect(captured[1].max_tokens).toBe(60);
    expect(userPayload(captured[1])).toEqual({ 문장A: decision, 문장B: '검사 온도 60도로 맞추면' });

    // 결정 원문이 원장과 다르면(모델이 다듬음) 끼어들지 않는다 — 2차 검증 호출도 없음
    const s2 = await setupMeeting('ls13b');
    insertRecap(s2.meetingId, [decision]);
    queueJson({ found: true, message_part: '검사 온도 60도', decision: '검사 온도 65도' });
    maybeSuggestDecision(io, { meetingId: s2.meetingId, code: s2.code, channelId: s2.channelId, from: 'ls13b_member', text });
    await waitFor(() => captured.length === 3);
    await flush();
    expect(messages()).toHaveLength(1);

    // 2차 검증이 "양립 가능"이면 침묵
    const s3 = await setupMeeting('ls13c');
    insertRecap(s3.meetingId, [decision]);
    queueJson({ found: true, message_part: '검사 온도 60도로', decision });
    queueJson({ compatible: true });
    maybeSuggestDecision(io, { meetingId: s3.meetingId, code: s3.code, channelId: s3.channelId, from: 'ls13c_member', text });
    await waitFor(() => captured.length === 5);
    await flush();
    expect(messages()).toHaveLength(1);
  });

  it('verifyIncompatible — compatible:false일 때만 true, 파싱 불가는 예외', async () => {
    queueJson({ compatible: false });
    expect(await verifyIncompatible('A는 65도', 'A는 60도')).toBe(true);
    queueJson({ compatible: true });
    expect(await verifyIncompatible('A가 진행', 'A에 참석')).toBe(false);
    setNextResponses('판단 불가');
    await expect(verifyIncompatible('x', 'y')).rejects.toThrow();
  });
});
