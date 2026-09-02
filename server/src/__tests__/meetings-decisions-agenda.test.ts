import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';
import { register, auth, createMeeting, joinMeeting, insertRecap, notifications, type User } from './helpers/fixtures.js';

/*
 * 결정·안건·용어집 — POST decisions/manual 의 기록·알림, 자동 기록 취소(발언자/관리자/소스 검증),
 * recap 원문·다음 회의 등록, 용어집 CRUD, 안건 멈춤 상태·종결·생애 타임라인, 현장 녹음 세션.
 */
const app = createApp();

async function setup(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const member = await register(app, `${prefix}_member`);
  const third = await register(app, `${prefix}_third`);
  const m = await createMeeting(app, host, `${prefix} 그룹`);
  await joinMeeting(app, member, m.code);
  await joinMeeting(app, third, m.code);
  return { host, member, third, m };
}

describe('채팅 결정 수동 기록 (POST /:code/decisions/manual)', () => {
  it('recap 행(수동·요약 80자·결정 200자·참석자=기록자) + 나머지 참가자 알림(60자)', async () => {
    const { host, member, third, m } = await setup('da1');
    expect((await request(app).post(`/api/meetings/${m.code}/decisions/manual`).set(auth(member)).send({ text: '  ' })).body).toEqual({
      error: '기록할 내용이 없어요',
    });
    const long = '결'.repeat(210);
    const r = await request(app).post(`/api/meetings/${m.code}/decisions/manual`).set(auth(member)).send({ text: ` ${long} ` });
    expect(r.status).toBe(200);
    const row = db
      .prepare('SELECT meeting_id, summary, decisions, actions, attendees, source FROM meeting_recaps WHERE id = ?')
      .get(r.body.id) as Record<string, string | number>;
    expect(row.meeting_id).toBe(m.id);
    expect(row.source).toBe('manual');
    expect(row.summary).toBe('결'.repeat(80));
    expect(JSON.parse(row.decisions as string)).toEqual(['결'.repeat(200)]);
    expect(JSON.parse(row.actions as string)).toEqual([]);
    expect(JSON.parse(row.attendees as string)).toEqual(['da1_member']);
    const expected = {
      from_name: 'exist AI',
      text: `결정이 원장에 기록됐어요 — ${'결'.repeat(60)}`,
      kind: 'recap',
      meeting_code: m.code,
    };
    expect(notifications(host.id).at(-1)).toEqual(expected);
    expect(notifications(third.id).at(-1)).toEqual(expected);
    expect(notifications(member.id).some((n) => n.text.includes('원장에 기록'))).toBe(false); // 기록자 제외
  }, 20_000);
});

describe('자동 기록 취소 (DELETE /:code/decisions/auto/:recapId)', () => {
  it('발언자 본인 또는 호스트만, auto 소스만, 서명·리마인드 기록까지 삭제', async () => {
    const { host, member, third, m } = await setup('da2');
    const say = (uid: number) => db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(m.id, uid, '65도로 올립시다');
    const del = (u: User, id: number | string) => request(app).delete(`/api/meetings/${m.code}/decisions/auto/${id}`).set(auth(u));

    const auto1 = insertRecap(m.id, ['자동 결정 1'], { source: 'auto' });
    say(member.id);
    // 발언 없는 제3자 — 403
    const denied = await del(third, auto1);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: '자동 기록 취소는 발언자 본인이나 호스트·관리자만 할 수 있어요' });
    // 발언자 본인 — 허용
    expect((await del(member, auto1)).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM meeting_recaps WHERE id = ?').get(auto1)).toBeUndefined();

    // 호스트 — 서명·리마인드 기록도 함께 삭제
    const auto2 = insertRecap(m.id, ['자동 결정 2'], { source: 'auto' });
    db.prepare('INSERT INTO decision_acks (recap_id, decision_idx, user_id) VALUES (?, 0, ?)').run(auto2, member.id);
    db.prepare('INSERT INTO decision_remind_sent (recap_id, user_id) VALUES (?, ?)').run(auto2, member.id);
    expect((await del(host, auto2)).body).toEqual({ ok: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM decision_acks WHERE recap_id = ?').get(auto2)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM decision_remind_sent WHERE recap_id = ?').get(auto2)).toEqual({ n: 0 });

    // ai 소스는 취소 불가, 없는 기록 404
    const ai = insertRecap(m.id, ['정리된 결정'], { source: 'ai' });
    const notAuto = await del(host, ai);
    expect(notAuto.status).toBe(403);
    expect(notAuto.body).toEqual({ error: 'AI가 자동 기록한 결정만 취소할 수 있어요' });
    const gone = await del(host, 999999);
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ error: '이미 취소됐거나 없는 기록이에요' });
  }, 20_000);
});

describe('recap 원문·다음 회의 등록', () => {
  it('수동·자동 recap 은 원문 404, ai recap 은 그 창의 채팅이 원문으로', async () => {
    const { host, member, m } = await setup('da3');
    const manual = insertRecap(m.id, ['수동'], { source: 'manual' });
    const nf = await request(app).get(`/api/meetings/${m.code}/recaps/${manual}/source`).set(auth(host));
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: '원문이 없는 기록이에요 (1건짜리 수동·자동 기록)' });

    db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(m.id, member.id, '방열판 두께 확정');
    const future = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').slice(0, 19);
    const ai = insertRecap(m.id, ['방열판 결정'], { source: 'ai', createdAt: future });
    const src = await request(app).get(`/api/meetings/${m.code}/recaps/${ai}/source`).set(auth(host));
    expect(src.status).toBe(200);
    expect(src.body.items).toEqual([
      expect.objectContaining({ from: 'da3_member', text: '방열판 두께 확정', kind: 'chat' }),
    ]);
  }, 20_000);

  it('다음 회의 제안 등록 표시 — 제안 없으면 404, 있으면 registered:true 저장', async () => {
    const { host, m } = await setup('da4');
    const plain = insertRecap(m.id, ['결정']);
    const nf = await request(app).post(`/api/meetings/${m.code}/recaps/${plain}/next-registered`).set(auth(host));
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: '다음 회의 제안이 없는 정리예요' });

    const withNext = insertRecap(m.id, ['결정']);
    db.prepare('UPDATE meeting_recaps SET next_meeting = ? WHERE id = ?').run(JSON.stringify({ date: '2026-10-01', time: '10:00' }), withNext);
    expect((await request(app).post(`/api/meetings/${m.code}/recaps/${withNext}/next-registered`).set(auth(host))).body).toEqual({ ok: true });
    const saved = JSON.parse(
      (db.prepare('SELECT next_meeting FROM meeting_recaps WHERE id = ?').get(withNext) as { next_meeting: string }).next_meeting,
    );
    expect(saved).toEqual({ date: '2026-10-01', time: '10:00', registered: true });
  }, 20_000);
});

describe('그룹 용어집 (glossary)', () => {
  it('trim·40자, 2자 미만 400, 중복 무시, 최신순 목록, 삭제는 그 그룹 것만', async () => {
    const { host, member, m } = await setup('da5');
    const other = await createMeeting(app, host, 'da5 다른 그룹');
    const post = (term: unknown) => request(app).post(`/api/meetings/${m.code}/glossary`).set(auth(member)).send({ term });

    expect((await post('a')).body).toEqual({ error: '용어는 2자 이상이어야 해요' });
    expect((await post('  ')).status).toBe(400);
    expect((await post('  코어템  ')).body).toEqual({ ok: true, term: '코어템' });
    expect((await post('코어템')).body).toEqual({ ok: true, term: '코어템' }); // 중복 — 멱등
    expect((await post('용'.repeat(50))).body).toEqual({ ok: true, term: '용'.repeat(40) });

    const list = await request(app).get(`/api/meetings/${m.code}/glossary`).set(auth(host));
    expect(list.status).toBe(200);
    const terms = list.body.terms as { id: number; term: string; added_by: string }[];
    expect(terms.map((t) => t.term)).toEqual(['용'.repeat(40), '코어템']); // 최신순
    expect(terms[1].added_by).toBe('da5_member');

    // 다른 그룹 코드로는 지워지지 않는다
    const target = terms[1].id;
    expect((await request(app).delete(`/api/meetings/${other.code}/glossary/${target}`).set(auth(host))).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM meeting_glossary WHERE id = ?').get(target)).toBeTruthy();
    expect((await request(app).delete(`/api/meetings/${m.code}/glossary/${target}`).set(auth(host))).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM meeting_glossary WHERE id = ?').get(target)).toBeUndefined();
  }, 20_000);
});

describe('안건 멈춤 상태·종결·생애 타임라인', () => {
  const insertItem = (meetingId: number, title: string, extra: Record<string, unknown> = {}) =>
    db
      .prepare(
        `INSERT INTO agenda_items (meeting_id, title, why, rounds, resolved, resolved_note, resolved_recap_id, resolved_decision_idx, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meetingId,
        title,
        (extra.why as string) ?? '재논의 근거',
        (extra.rounds as number) ?? 2,
        (extra.resolved as number) ?? 0,
        (extra.resolved_note as string) ?? null,
        (extra.resolved_recap_id as number) ?? null,
        (extra.resolved_decision_idx as number) ?? null,
        (extra.status as string) ?? null,
      ).lastInsertRowid as number;

  it('상태 — 허용값만, note 는 120자 trim, 해제는 note 도 비움, 이벤트 로그 기록', async () => {
    const { host, member, m } = await setup('da6');
    void host;
    const item = insertItem(m.id, '설비 교체');
    const set = (body: Record<string, unknown>, itemId: number | string = item) =>
      request(app).post(`/api/meetings/${m.code}/agenda/${itemId}/status`).set(auth(member)).send(body);

    expect((await set({ status: 'x' }, 0)).body).toEqual({ error: '잘못된 안건이에요' });
    expect((await set({ status: 'partying' })).body).toEqual({ error: '상태를 바꿀 수 없어요 (종결됐거나 잘못된 상태)' });
    expect((await set({ status: 'waiting_dept', note: '  자재팀 회신 대기  ' })).body).toEqual({ ok: true });
    expect(db.prepare('SELECT status, status_note FROM agenda_items WHERE id = ?').get(item)).toEqual({
      status: 'waiting_dept',
      status_note: '자재팀 회신 대기',
    });
    expect(db.prepare("SELECT detail FROM agenda_events WHERE agenda_id = ? AND kind = 'status' ORDER BY id DESC LIMIT 1").get(item)).toEqual({
      detail: 'waiting_dept — 자재팀 회신 대기',
    });
    // 해제 — 빈 문자열도 null 취급, note 함께 삭제
    expect((await set({ status: '', note: '남으면 안 됨' })).body).toEqual({ ok: true });
    expect(db.prepare('SELECT status, status_note FROM agenda_items WHERE id = ?').get(item)).toEqual({ status: null, status_note: null });
  }, 20_000);

  it('종결 — 한 번만, 사유 저장, 종결된 안건은 상태 변경 불가', async () => {
    const { member, m } = await setup('da7');
    const item = insertItem(m.id, '야간 인력');
    const r = await request(app).post(`/api/meetings/${m.code}/agenda/${item}/resolve`).set(auth(member)).send({ note: ' 증원으로 종결 ' });
    expect(r.body).toEqual({ ok: true });
    expect(db.prepare('SELECT resolved, resolved_note FROM agenda_items WHERE id = ?').get(item)).toEqual({
      resolved: 1,
      resolved_note: '증원으로 종결',
    });
    const again = await request(app).post(`/api/meetings/${m.code}/agenda/${item}/resolve`).set(auth(member)).send({});
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: '이미 종결됐거나 없는 안건이에요' });
    expect((await request(app).post(`/api/meetings/${m.code}/agenda/-1/resolve`).set(auth(member)).send({})).body).toEqual({ error: '잘못된 안건이에요' });
    expect(
      (await request(app).post(`/api/meetings/${m.code}/agenda/${item}/status`).set(auth(member)).send({ status: 'hold' })).status,
    ).toBe(400);
  }, 20_000);

  it('타임라인 — 이벤트 없는 옛 안건은 created/closed 합성, 결정 링크와 파생 할 일 동반', async () => {
    const { host, member, m } = await setup('da8');
    // ① 이벤트 없는 미결 안건 → created 합성 (detail = why)
    const bare = insertItem(m.id, '맨 안건', { why: '지난주 이월' });
    const t1 = await request(app).get(`/api/meetings/${m.code}/agenda/${bare}/timeline`).set(auth(member));
    expect(t1.status).toBe(200);
    expect(t1.body.item).toEqual({ id: bare, title: '맨 안건', why: '지난주 이월', rounds: 2, status: null, resolved: false, resolvedNote: null });
    expect(t1.body.events).toEqual([expect.objectContaining({ kind: 'created', detail: '지난주 이월', actor: null })]);
    expect(t1.body.decision).toBeNull();
    expect(t1.body.todos).toEqual([]);

    // ② DB 직접 종결(이벤트 로그 없음) + 결정 링크(idx 1) + 파생 할 일 → closed 합성·역링크
    const recap = insertRecap(m.id, ['결정 A', '결정 B']);
    db.prepare('INSERT INTO todos (user_id, title, done, meeting_id, recap_id) VALUES (?, ?, 1, ?, ?)').run(host.id, '후속 작업', m.id, recap);
    const legacy = insertItem(m.id, '옛 안건', { resolved: 1, resolved_note: '옛 사유', resolved_recap_id: recap, resolved_decision_idx: 1 });
    const t2 = await request(app).get(`/api/meetings/${m.code}/agenda/${legacy}/timeline`).set(auth(member));
    expect(t2.body.item).toMatchObject({ resolved: true, resolvedNote: '옛 사유' });
    expect((t2.body.events as { kind: string }[]).map((e) => e.kind)).toEqual(['created', 'closed']);
    expect(t2.body.events[1]).toMatchObject({ detail: '옛 사유', recap_id: recap });
    expect(t2.body.decision).toEqual({ recapId: recap, idx: 1, text: '결정 B' });
    expect(t2.body.todos).toEqual([{ title: '후속 작업', done: 1 }]);

    // ③ 라우트로 종결하면 closed 이벤트가 실제 기록 — 합성 안 함, actor 표시
    const live = insertItem(m.id, '살아있는 안건');
    await request(app).post(`/api/meetings/${m.code}/agenda/${live}/resolve`).set(auth(member)).send({ note: '결론' });
    const t3 = await request(app).get(`/api/meetings/${m.code}/agenda/${live}/timeline`).set(auth(host));
    const closed = (t3.body.events as { kind: string; actor: string | null }[]).filter((e) => e.kind === 'closed');
    expect(closed).toEqual([expect.objectContaining({ actor: 'da8_member' })]);

    const nf = await request(app).get(`/api/meetings/${m.code}/agenda/999999/timeline`).set(auth(member));
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: '없는 안건이에요' });
  }, 20_000);
});

describe('현장 녹음 세션·RAG 재색인', () => {
  it('start 가 call_started_at 을 열고(소문자 코드 허용) 비참가자는 403, finish·reindex 는 ok', async () => {
    const { host, member, m } = await setup('da9');
    const outsider = await register(app, 'da9_out');
    expect(db.prepare('SELECT call_started_at FROM meetings WHERE id = ?').get(m.id)).toEqual({ call_started_at: null });
    const denied = await request(app).post(`/api/meetings/${m.code}/field-recording/start`).set(auth(outsider));
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: '회의 참가자만 쓸 수 있어요' });

    expect((await request(app).post(`/api/meetings/${m.code.toLowerCase()}/field-recording/start`).set(auth(member))).body).toEqual({ ok: true });
    const started = (db.prepare('SELECT call_started_at FROM meetings WHERE id = ?').get(m.id) as { call_started_at: string | null })
      .call_started_at;
    expect(started).toEqual(expect.any(String));

    const deniedFin = await request(app).post(`/api/meetings/${m.code}/field-recording/finish`).set(auth(outsider));
    expect(deniedFin.status).toBe(403);
    expect(deniedFin.body).toEqual({ error: '회의 참가자만 쓸 수 있어요' });
    expect((await request(app).post(`/api/meetings/${m.code}/field-recording/finish`).set(auth(member))).body).toEqual({ ok: true });

    expect((await request(app).post(`/api/meetings/${m.code}/rag/reindex`).set(auth(host))).body).toEqual({ ok: true });
    expect((await request(app).post(`/api/meetings/${m.code}/rag/reindex`).set(auth(outsider))).status).toBe(403);
  }, 20_000);
});
