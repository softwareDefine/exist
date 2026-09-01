import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

/*
 * steward.ts 가드레일 — 보류 깨우기 임계(WAKE_MIN 0.42) 경계, 안건 제목 중복 방지,
 * 아젠다·이력 캐시 TTL(10분)과 무효화(invalidateAgenda) 경로.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { ensureDefaultChannel } from '../channels.js';
import { wakeWaitingAgendas, generateAgenda, generateDecisionHistory, invalidateAgenda, setAgendaStatus, resolveAgendaItem } from '../steward.js';
import { register, auth, createMeeting, joinMeeting, insertRecap, notifications } from './helpers/fixtures.js';
import { queueJson, resetOpenAiMock, captured, setEmbedder } from './helpers/openaiMock.js';

const app = createApp();
beforeEach(() => resetOpenAiMock());
afterEach(() => vi.restoreAllMocks());

async function setup(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const member = await register(app, `${prefix}_member`);
  const m = await createMeeting(app, host, `${prefix} 그룹`);
  await joinMeeting(app, member, m.code);
  const channelId = ensureDefaultChannel(m.id, host.id);
  return { host, member, code: m.code, meetingId: m.id, channelId };
}
const wakes = (meetingId: number) => (db.prepare("SELECT agenda_id FROM agenda_events WHERE kind = 'wake' AND meeting_id = ?").all(meetingId) as { agenda_id: number }[]).map((r) => r.agenda_id);

/** 텍스트 → 단위 벡터. 안건 텍스트는 [1,0], 후보는 코사인이 정확히 score 가 되게 [score, √(1-score²)] */
function scoredEmbedder(score: number) {
  return (text: string): number[] => (text.includes('WAIT') ? [1, 0] : [score, Math.sqrt(1 - score * score)]);
}

describe('보류 깨우기 임계 (WAKE_MIN = 0.42)', () => {
  it('코사인 0.41 은 침묵, 0.43 은 깨운다 — 알림은 호스트 + 마지막 상태 지정자', async () => {
    const s = await setup('wk1');
    const item = db.prepare("INSERT INTO agenda_items (meeting_id, title) VALUES (?, 'WAIT 인증 갱신')").run(s.meetingId).lastInsertRowid as number;
    expect(setAgendaStatus(s.meetingId, item, 'waiting_approval', s.member.id, '품질 인증 승인 대기')).toBe(true);
    const recapId = insertRecap(s.meetingId, ['인증 승인 완료']);

    setEmbedder(scoredEmbedder(0.41));
    await wakeWaitingAgendas(s.meetingId, [{ text: '인증 승인 완료', recapId, idx: 0 }], recapId);
    expect(wakes(s.meetingId)).toEqual([]);
    expect(notifications(s.host.id).some((n) => n.text.includes('다시 올려볼까요'))).toBe(false);

    setEmbedder(scoredEmbedder(0.43));
    await wakeWaitingAgendas(s.meetingId, [{ text: '인증 승인 완료', recapId, idx: 0 }], recapId);
    expect(wakes(s.meetingId)).toEqual([item]);
    const expected = `승인 대기 안건 'WAIT 인증 갱신'이 기다리던 것과 관련된 내용이 올라왔어요: '인증 승인 완료' — 다시 올려볼까요? ('wk1 그룹')`;
    expect(notifications(s.host.id).filter((n) => n.text === expected)).toHaveLength(1);
    expect(notifications(s.member.id).filter((n) => n.text === expected)).toHaveLength(1);
    expect(notifications(s.host.id).at(-1)).toMatchObject({ from_name: 'exist AI', kind: 'recap', meeting_code: s.code.toUpperCase() });
    // 후보가 하나도 없거나(빈 배열·빈 요약) 대기 안건이 없으면 임베딩 호출 자체가 없다
    const before = captured.length;
    await wakeWaitingAgendas(s.meetingId, [], recapId, '   ');
    const other = await setup('wk1b');
    await wakeWaitingAgendas(other.meetingId, [{ text: 'x', recapId, idx: 0 }], recapId);
    expect(captured.length).toBe(before);
    expect(wakes(other.meetingId)).toEqual([]);
  }, 20_000);

  it('여러 후보 중 최고 점수 하나만, 요약도 후보가 되고 recap 당 1회', async () => {
    const s = await setup('wk2');
    const item = db.prepare("INSERT INTO agenda_items (meeting_id, title, status, status_note) VALUES (?, 'WAIT 자재 발주', 'hold', '구매팀 발주 대기')").run(s.meetingId).lastInsertRowid as number;
    const recapId = insertRecap(s.meetingId, ['무관한 결정']);
    setEmbedder((text) => (text.includes('WAIT') ? [1, 0] : text.includes('발주 완료') ? [0.9, Math.sqrt(1 - 0.81)] : [0.1, Math.sqrt(1 - 0.01)]));
    await wakeWaitingAgendas(s.meetingId, [{ text: '무관한 결정', recapId, idx: 0 }], recapId, '구매팀 발주 완료 보고');
    const ev = db.prepare("SELECT detail, recap_id FROM agenda_events WHERE kind = 'wake' AND agenda_id = ?").all(item) as { detail: string; recap_id: number }[];
    expect(ev).toEqual([{ detail: `기다리던 조건과 관련된 회의 내용 감지 — '구매팀 발주 완료 보고'`, recap_id: recapId }]);
    expect(notifications(s.host.id).at(-1)!.text).toContain("보류 안건 'WAIT 자재 발주'");
    await wakeWaitingAgendas(s.meetingId, [{ text: '무관한 결정', recapId, idx: 0 }], recapId, '구매팀 발주 완료 보고');
    expect(wakes(s.meetingId)).toEqual([item]);
    // 종결된 안건은 대상이 아니다
    expect(resolveAgendaItem(s.meetingId, item, '완료', s.host.id)).toBe(true);
    const recap2 = insertRecap(s.meetingId, ['또 발주 완료']);
    await wakeWaitingAgendas(s.meetingId, [{ text: '발주 완료', recapId: recap2, idx: 0 }], recap2);
    expect(wakes(s.meetingId)).toEqual([item]);
  }, 20_000);
});

describe('안건 영속 — 제목 중복 방지 · 생성 이벤트', () => {
  it('이미 추적 중인 미결 안건과 정규화(공백·대소문자) 제목이 같으면 다시 넣지 않고, 같은 응답 안 중복도 한 번만', async () => {
    const s = await setup('dd1');
    const existing = db.prepare("INSERT INTO agenda_items (meeting_id, title, why) VALUES (?, '  방열판   두께 재검토 ', '지난 회의')").run(s.meetingId).lastInsertRowid as number;
    db.prepare("INSERT INTO agenda_items (meeting_id, title, resolved) VALUES (?, '종결된 안건', 1)").run(s.meetingId);
    queueJson({ items: [
      { title: '방열판 두께 재검토', why: '이월' },
      { title: '야간조 인원 조정', why: '미완료 할 일' },
      { title: '야간조  인원 조정', why: '중복' },
      { title: '종결된 안건', why: '예전에 닫힘 — 새로 추적 시작' },
    ] });
    const a = await generateAgenda(s.meetingId, s.channelId);
    expect(a.source).toBe('ai');
    const rows = db.prepare('SELECT id, title, why, resolved FROM agenda_items WHERE meeting_id = ? ORDER BY id').all(s.meetingId) as { id: number; title: string; why: string; resolved: number }[];
    expect(rows.map((r) => [r.title, r.resolved])).toEqual([
      ['  방열판   두께 재검토 ', 0],
      ['종결된 안건', 1],
      ['야간조 인원 조정', 0],
      ['종결된 안건', 0], // 종결된 것과 같은 제목은 새 미결 안건으로 다시 추적
    ]);
    expect(rows[2].why).toBe('미완료 할 일');
    const created = db.prepare("SELECT agenda_id, detail FROM agenda_events WHERE meeting_id = ? AND kind = 'created' ORDER BY id").all(s.meetingId) as { agenda_id: number; detail: string }[];
    expect(created).toEqual([
      { agenda_id: rows[2].id, detail: '미완료 할 일' },
      { agenda_id: rows[3].id, detail: '예전에 닫힘 — 새로 추적 시작' },
    ]);
    // 응답 안건에는 이월 안건이 맨 위, 이월과 같은 제목의 신규는 제거, 영속 id 부착(같은 제목은 같은 id)
    expect(a.items[0]).toMatchObject({ title: '  방열판   두께 재검토 ', why: '지난 회의', rounds: 1, id: existing });
    expect(a.items.map((it) => it.title)).toEqual(['  방열판   두께 재검토 ', '야간조 인원 조정', '야간조  인원 조정', '종결된 안건']);
    expect(a.items.map((it) => it.id)).toEqual([existing, rows[2].id, rows[2].id, rows[3].id]);
  }, 20_000);

  it('제목·근거 길이 상한 (120 · 80 · 이벤트 120)', async () => {
    const s = await setup('dd2');
    queueJson({ items: [{ title: '가'.repeat(60), why: '나'.repeat(40) }] }); // aiAgenda 가 60/40 으로 먼저 자른다
    await generateAgenda(s.meetingId, s.channelId);
    const row = db.prepare('SELECT title, why FROM agenda_items WHERE meeting_id = ?').get(s.meetingId) as { title: string; why: string };
    expect(row.title).toHaveLength(60);
    expect(row.why).toHaveLength(40);
  }, 20_000);
});

describe('아젠다·이력 캐시 — 10분 TTL 과 무효화', () => {
  it('정확히 10분이 지나면 재생성, 9분 59초는 캐시; invalidateAgenda 는 즉시 버린다', async () => {
    const s = await setup('ca1');
    insertRecap(s.meetingId, ['결정 1'], { createdAt: '2026-08-01 10:00:00' });
    insertRecap(s.meetingId, ['결정 2'], { createdAt: '2026-08-02 10:00:00' });
    const T = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T);
    queueJson({ items: [{ title: '안건 A', why: 'x' }] });
    queueJson({ topics: [{ title: '온도 기준', indexes: [0, 1] }] });
    const a1 = await generateAgenda(s.meetingId, s.channelId);
    const h1 = await generateDecisionHistory(s.meetingId);
    expect(a1.generatedAt).toBe(T);
    expect(h1.generatedAt).toBe(T);
    expect(h1.source).toBe('ai');
    expect(captured).toHaveLength(2);

    nowSpy.mockReturnValue(T + 10 * 60_000 - 1);
    expect(await generateAgenda(s.meetingId, s.channelId)).toBe(a1);
    expect(await generateDecisionHistory(s.meetingId)).toBe(h1);
    expect(captured).toHaveLength(2);

    nowSpy.mockReturnValue(T + 10 * 60_000);
    queueJson({ items: [{ title: '안건 B', why: 'y' }] });
    queueJson({ topics: [{ title: '재그룹', indexes: [0, 1] }] });
    const a2 = await generateAgenda(s.meetingId, s.channelId);
    const h2 = await generateDecisionHistory(s.meetingId);
    expect(a2).not.toBe(a1);
    expect(a2.generatedAt).toBe(T + 10 * 60_000);
    expect(h2.topics[0].title).toBe('재그룹');
    expect(captured).toHaveLength(4);

    // 캐시 안에서 무효화 → 즉시 재생성
    invalidateAgenda(s.meetingId);
    queueJson({ items: [{ title: '안건 C', why: 'z' }] });
    queueJson({ topics: [{ title: '세 번째', indexes: [1, 0] }] });
    expect((await generateAgenda(s.meetingId, s.channelId)).items.some((it) => it.title === '안건 C')).toBe(true);
    expect((await generateDecisionHistory(s.meetingId)).topics[0].title).toBe('세 번째');
    expect(captured).toHaveLength(6);
    // 다른 회의는 영향 없음 (캐시 키는 회의 id)
    const other = await setup('ca1b');
    queueJson({ items: [{ title: '다른 회의 안건', why: 'q' }] });
    expect((await generateAgenda(other.meetingId, other.channelId)).items[0].title).toBe('다른 회의 안건');
    expect(await generateAgenda(s.meetingId, s.channelId)).toBe(await generateAgenda(s.meetingId, s.channelId));
  }, 20_000);

  it('결정 정정·철회·수동 기록·안건 상태 변경·종결 라우트가 캐시를 버린다', async () => {
    const s = await setup('ca2');
    const recapId = insertRecap(s.meetingId, ['결정 1', '결정 2']);
    const agenda = () => request(app).get(`/api/meetings/${s.code}/agenda`).set(auth(s.host));
    const history = () => request(app).get(`/api/meetings/${s.code}/decisions/history`).set(auth(s.host));
    const warm = async () => {
      queueJson({ items: [{ title: `안건 ${captured.length}`, why: 'w' }] });
      queueJson({ topics: [{ title: `토픽 ${captured.length}`, indexes: [0, 1] }] });
      expect((await agenda()).status).toBe(200);
      expect((await history()).status).toBe(200);
      const n = captured.length;
      await agenda();
      await history();
      expect(captured.length).toBe(n); // 캐시 확인
      return n;
    };
    let n = await warm();
    expect((await request(app).patch(`/api/meetings/${s.code}/decisions/${recapId}/0`).set(auth(s.host)).send({ why: '배경', reason: 'r' })).status).toBe(200);
    queueJson({ items: [{ title: 'a', why: 'w' }] });
    queueJson({ topics: [{ title: 't', indexes: [0, 1] }] });
    await agenda();
    await history();
    expect(captured.length).toBe(n + 2);
    n = await warm();
    expect((await request(app).post(`/api/meetings/${s.code}/decisions/${recapId}/1/withdraw`).set(auth(s.host)).send({ reason: 'r' })).status).toBe(200);
    queueJson({ items: [{ title: 'b', why: 'w' }] });
    await agenda();
    expect(captured.length).toBe(n + 1);
    n = await warm();
    expect((await request(app).post(`/api/meetings/${s.code}/decisions/manual`).set(auth(s.member)).send({ text: '수동' })).status).toBe(200);
    queueJson({ items: [{ title: 'c', why: 'w' }] });
    await agenda();
    expect(captured.length).toBe(n + 1);
    n = await warm();
    const itemId = (db.prepare("SELECT id FROM agenda_items WHERE meeting_id = ? AND resolved = 0 ORDER BY id LIMIT 1").get(s.meetingId) as { id: number }).id;
    expect((await request(app).post(`/api/meetings/${s.code}/agenda/${itemId}/status`).set(auth(s.member)).send({ status: 'hold', note: '대기' })).status).toBe(200);
    queueJson({ items: [{ title: 'd', why: 'w' }] });
    const afterStatus = await agenda();
    expect(captured.length).toBe(n + 1);
    expect(afterStatus.body.items.find((it: { id: number }) => it.id === itemId)).toMatchObject({ status: 'hold', statusNote: '대기' });
    expect((await request(app).post(`/api/meetings/${s.code}/agenda/${itemId}/status`).set(auth(s.member)).send({ status: 'bogus' })).body).toEqual({ error: '상태를 바꿀 수 없어요 (종결됐거나 잘못된 상태)' });
    n = captured.length;
    expect((await request(app).post(`/api/meetings/${s.code}/agenda/${itemId}/resolve`).set(auth(s.member)).send({ note: '닫음' })).body).toEqual({ ok: true });
    expect((await request(app).post(`/api/meetings/${s.code}/agenda/${itemId}/resolve`).set(auth(s.member)).send({})).body).toEqual({ error: '이미 종결됐거나 없는 안건이에요' });
    queueJson({ items: [{ title: 'e', why: 'w' }] });
    const afterResolve = await agenda();
    expect(captured.length).toBe(n + 1);
    expect(afterResolve.body.items.some((it: { id: number }) => it.id === itemId)).toBe(false);
  }, 20_000);
});
