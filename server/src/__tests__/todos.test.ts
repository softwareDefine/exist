import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';
import { runTodoReminders } from '../todos.js';

/*
 * todos.ts — 개인/회의 할 일 CRUD, 다중 담당자, 마감일, 조직 스코프 목록, recap 태생 할 일 삭제 시 원장 정정,
 * 권한 게이트(담당자·작성자·호스트·조직 관리자만), 마감 리마인드(runTodoReminders).
 */
const app = createApp();
const U: Record<string, { id: number; token: string }> = {};
const auth = (n: string) => ({ Authorization: `Bearer ${U[n].token}` });
let orgId = 0;
let orgCode = '';
let orgMeetingId = 0;
let personalCode = '';

async function reg(name: string) {
  const r = await request(app).post('/api/auth/register').send({ username: name, password: 'password123' });
  U[name] = { id: r.body.user.id, token: r.body.token };
}
const notis = (uid: number) =>
  (db.prepare("SELECT from_name, text, meeting_code FROM notifications WHERE user_id = ? AND kind = 'todo' ORDER BY id").all(uid) as { from_name: string; text: string; meeting_code: string | null }[]);

beforeAll(async () => {
  for (const n of ['td_owner', 'td_m1', 'td_m2', 'td_m3', 'td_out']) await reg(n);
  const org = await request(app).post('/api/orgs').set(auth('td_owner')).send({ name: '할일 조직' });
  orgId = org.body.id;
  const om = await request(app).post('/api/meetings').set(auth('td_owner')).send({ title: '조직 그룹', org_id: orgId });
  expect(om.status).toBe(200);
  orgCode = om.body.code;
  orgMeetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(orgCode) as { id: number }).id;
  const pm = await request(app).post('/api/meetings').set(auth('td_owner')).send({ title: '개인 그룹' });
  personalCode = pm.body.code;
  for (const n of ['td_m1', 'td_m2', 'td_m3']) {
    await request(app).post('/api/meetings/join').set(auth(n)).send({ code: orgCode });
    await request(app).post('/api/meetings/join').set(auth(n)).send({ code: personalCode });
  }
});

describe('생성·목록', () => {
  it('개인 할 일 — 빈 제목 400, 생성 응답, 내 목록·personal 스코프에 뜨고 org 스코프엔 안 뜸', async () => {
    expect((await request(app).post('/api/todos').set(auth('td_m1')).send({ title: '   ' })).status).toBe(400);
    const r = await request(app).post('/api/todos').set(auth('td_m1')).send({ title: ' 장갑 사기 ', due_at: '2099-01-01' });
    expect(r.body).toEqual({ id: expect.any(Number), title: '장갑 사기', done: 0, due_at: '2099-01-01', assignees: [] });
    const all = await request(app).get('/api/todos').set(auth('td_m1'));
    expect(all.body).toEqual([{ id: r.body.id, title: '장갑 사기', done: 0, due_at: '2099-01-01', recap_id: null, meeting_code: null, meeting_title: null }]);
    expect((await request(app).get('/api/todos?org=personal').set(auth('td_m1'))).body.map((t: { id: number }) => t.id)).toEqual([r.body.id]);
    expect((await request(app).get(`/api/todos?org=${orgId}`).set(auth('td_m1'))).body).toEqual([]);
  });

  it('회의 할 일 — 담당자 미지정이면 작성자, 지정하면 참가자만 반영 + 새 담당자에게만 알림, 목록엔 프로필 포함', async () => {
    const mine = await request(app).post('/api/todos').set(auth('td_m1')).send({ title: '설비 점검', meeting: orgCode.toLowerCase() });
    expect(mine.body.assignees).toEqual(['td_m1']);
    expect(notis(U.td_m1.id)).toEqual([]); // 본인 배정은 알림 없음

    const shared = await request(app).post('/api/todos').set(auth('td_m1')).send({ title: 'MSDS 갱신', meeting: orgCode, assignees: ['td_m2', 'ghost', 'td_out', 'td_m2', ' td_m3 '] });
    expect(shared.body.assignees).toEqual(['td_m2', 'td_m3']);
    expect(notis(U.td_m2.id)).toEqual([{ from_name: 'td_m1', text: "'MSDS 갱신' 할 일 담당자로 지정했어요 ('조직 그룹')", meeting_code: orgCode }]);

    const list = await request(app).get(`/api/todos?meeting=${orgCode}`).set(auth('td_m3'));
    expect(list.body.map((t: { title: string }) => t.title)).toEqual(['설비 점검', 'MSDS 갱신']);
    expect(list.body[1]).toMatchObject({ author: 'td_m1', assignees: ['td_m2', 'td_m3'], assigneeProfiles: [{ username: 'td_m2', name: null, avatar: '🐧' }, { username: 'td_m3', name: null, avatar: '🐧' }] });
    expect((await request(app).get('/api/todos?meeting=NOPE').set(auth('td_m3'))).body).toEqual([]);

    // 담당자 기준 홈 목록 + org 스코프 — m2에겐 MSDS만, org 스코프로도 보임, personal 스코프엔 없음
    const home = await request(app).get('/api/todos').set(auth('td_m2'));
    expect(home.body).toEqual([{ id: shared.body.id, title: 'MSDS 갱신', done: 0, due_at: null, recap_id: null, meeting_code: orgCode, meeting_title: '조직 그룹' }]);
    expect((await request(app).get(`/api/todos?org=${orgId}`).set(auth('td_m2'))).body).toHaveLength(1);
    expect((await request(app).get('/api/todos?org=personal').set(auth('td_m2'))).body).toEqual([]);
    // 없는 회의 코드로 만들면 개인 할 일
    const orphan = await request(app).post('/api/todos').set(auth('td_m1')).send({ title: '떠돌이', meeting: 'ZZZZZZ' });
    expect(orphan.body.assignees).toEqual([]);
  });
});

describe('수정·권한', () => {
  let todoId = 0;
  beforeAll(async () => {
    const r = await request(app).post('/api/todos').set(auth('td_m1')).send({ title: '안전 교육', meeting: orgCode, assignees: ['td_m2'] });
    todoId = r.body.id;
  });

  it('없는 id 404, 관련 없는 참가자·외부인 403, 담당자·작성자·호스트는 OK', async () => {
    expect((await request(app).patch('/api/todos/999999').set(auth('td_m1')).send({ done: true })).status).toBe(404);
    expect((await request(app).patch(`/api/todos/${todoId}`).set(auth('td_m3')).send({ title: 'x' })).status).toBe(403);
    expect((await request(app).patch(`/api/todos/${todoId}`).set(auth('td_out')).send({ title: 'x' })).status).toBe(403);
    expect((await request(app).patch(`/api/todos/${todoId}`).set(auth('td_m2')).send({})).status).toBe(200);
    expect((await request(app).patch(`/api/todos/${todoId}`).set(auth('td_m1')).send({})).status).toBe(200);
    expect((await request(app).patch(`/api/todos/${todoId}`).set(auth('td_owner')).send({})).status).toBe(200);
  });

  it('완료 = 보고 — 작성자·호스트에게 알림(본인·중복 제외), 이미 완료면 재알림 없음', async () => {
    const before = notis(U.td_m1.id).length;
    await request(app).patch(`/api/todos/${todoId}`).set(auth('td_m2')).send({ done: true });
    expect(notis(U.td_m1.id).slice(before)).toEqual([{ from_name: 'td_m2', text: "'안전 교육' 할 일을 완료했어요 ('조직 그룹')", meeting_code: orgCode }]);
    expect(notis(U.td_owner.id)).toEqual([{ from_name: 'td_m2', text: "'안전 교육' 할 일을 완료했어요 ('조직 그룹')", meeting_code: orgCode }]);
    await request(app).patch(`/api/todos/${todoId}`).set(auth('td_m2')).send({ done: 1 });
    expect(notis(U.td_owner.id)).toHaveLength(1);
    expect(db.prepare('SELECT done FROM todos WHERE id = ?').get(todoId)).toEqual({ done: 1 });
    await request(app).patch(`/api/todos/${todoId}`).set(auth('td_m2')).send({ done: false });
    expect(db.prepare('SELECT done FROM todos WHERE id = ?').get(todoId)).toEqual({ done: 0 });
    // 작성자 본인이 완료 → 호스트만
    const own = await request(app).post('/api/todos').set(auth('td_m1')).send({ title: '내가 끝냄', meeting: orgCode });
    await request(app).patch(`/api/todos/${own.body.id}`).set(auth('td_m1')).send({ done: true });
    expect(notis(U.td_owner.id)).toHaveLength(2);
    expect(notis(U.td_m1.id).slice(before)).toHaveLength(1);
  });

  it('제목·마감일 검증, 마감 변경 시 리마인드 플래그 리셋, 담당자 교체는 추가된 사람만 알림', async () => {
    const H = auth('td_m1');
    expect((await request(app).patch(`/api/todos/${todoId}`).set(H).send({ title: '  ' })).status).toBe(400);
    expect((await request(app).patch(`/api/todos/${todoId}`).set(H).send({ title: 42 })).status).toBe(400);
    expect((await request(app).patch(`/api/todos/${todoId}`).set(H).send({ due_at: '내일' })).status).toBe(400);
    db.prepare('UPDATE todos SET reminded_soon = 1, reminded_overdue = 1 WHERE id = ?').run(todoId);
    const ok = await request(app).patch(`/api/todos/${todoId}`).set(H).send({ title: '안전 교육(개정)', due_at: '2099-03-04T09:00:00' });
    expect(ok.body).toEqual({ ok: true });
    expect(db.prepare('SELECT title, due_at, reminded_soon, reminded_overdue FROM todos WHERE id = ?').get(todoId)).toEqual({ title: '안전 교육(개정)', due_at: '2099-03-04', reminded_soon: 0, reminded_overdue: 0 });
    await request(app).patch(`/api/todos/${todoId}`).set(H).send({ due_at: '' });
    expect(db.prepare('SELECT due_at FROM todos WHERE id = ?').get(todoId)).toEqual({ due_at: null });

    const m3Before = notis(U.td_m3.id).length;
    const m2Before = notis(U.td_m2.id).length;
    const sw = await request(app).patch(`/api/todos/${todoId}`).set(H).send({ assignees: ['td_m3'] });
    expect(sw.body).toEqual({ ok: true, assignees: ['td_m3'] });
    expect(notis(U.td_m3.id).slice(m3Before)).toEqual([{ from_name: 'td_m1', text: "'안전 교육(개정)' 할 일 담당자로 지정했어요 ('조직 그룹')", meeting_code: orgCode }]);
    expect(notis(U.td_m2.id)).toHaveLength(m2Before);
    // 이제 m2는 관련자가 아니다 → 403, m3는 OK. 개인 할 일에 assignees를 줘도 무시
    expect((await request(app).patch(`/api/todos/${todoId}`).set(auth('td_m2')).send({})).status).toBe(403);
    expect((await request(app).patch(`/api/todos/${todoId}`).set(auth('td_m3')).send({ assignees: ['td_m3'] })).body).toEqual({ ok: true, assignees: ['td_m3'] });
    const personal = await request(app).post('/api/todos').set(auth('td_m2')).send({ title: '개인' });
    expect((await request(app).patch(`/api/todos/${personal.body.id}`).set(auth('td_m2')).send({ assignees: ['td_m1'] })).body).toEqual({ ok: true });
    expect((await request(app).patch(`/api/todos/${personal.body.id}`).set(auth('td_m1')).send({ done: true })).status).toBe(403);
  });
});

describe('삭제', () => {
  it('없는 id는 ok, 관련 없으면 403, 담당자 삭제 OK, recap 태생 할 일은 원장 actions에서도 걷어낸다', async () => {
    expect((await request(app).delete('/api/todos/999999').set(auth('td_m1'))).body).toEqual({ ok: true });
    const t = await request(app).post('/api/todos').set(auth('td_m1')).send({ title: '지울 것', meeting: orgCode, assignees: ['td_m2'] });
    expect((await request(app).delete(`/api/todos/${t.body.id}`).set(auth('td_m3'))).status).toBe(403);
    expect((await request(app).delete(`/api/todos/${t.body.id}`).set(auth('td_m2'))).body).toEqual({ ok: true });
    expect(db.prepare('SELECT COUNT(*) AS c FROM todo_assignees WHERE todo_id = ?').get(t.body.id)).toEqual({ c: 0 });

    const actions = [{ assignee: 'td_m1', title: '검사 기준서 개정' }, { assignee: null, title: '남는 항목' }];
    const recapId = db
      .prepare("INSERT INTO meeting_recaps (meeting_id, summary, decisions, actions) VALUES (?, '요약', '[]', ?)")
      .run(orgMeetingId, JSON.stringify(actions)).lastInsertRowid as number;
    const auto = db
      .prepare('INSERT INTO todos (user_id, title, meeting_id, recap_id) VALUES (?, ?, ?, ?)')
      .run(U.td_owner.id, '검사 기준서 개정', orgMeetingId, recapId).lastInsertRowid;
    await request(app).delete(`/api/todos/${auto}`).set(auth('td_owner'));
    expect(JSON.parse((db.prepare('SELECT actions FROM meeting_recaps WHERE id = ?').get(recapId) as { actions: string }).actions)).toEqual([{ assignee: null, title: '남는 항목' }]);
    // 원장 actions가 손상돼도 삭제 자체는 된다
    db.prepare("UPDATE meeting_recaps SET actions = 'broken' WHERE id = ?").run(recapId);
    const auto2 = db.prepare('INSERT INTO todos (user_id, title, meeting_id, recap_id) VALUES (?, ?, ?, ?)').run(U.td_owner.id, '남는 항목', orgMeetingId, recapId).lastInsertRowid;
    expect((await request(app).delete(`/api/todos/${auto2}`).set(auth('td_owner'))).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM todos WHERE id = ?').get(auto2)).toBeUndefined();
  });
});

describe('runTodoReminders', () => {
  it('오늘·내일 임박 1회 + 지남 1회, 회의 할 일은 담당자 전원, 두 번째 실행은 0', async () => {
    const now = new Date(2030, 5, 15, 10, 0, 0); // 2030-06-15 (로컬)
    const mk = (uid: number, title: string, due: string | null, extra: { meeting?: number; done?: number } = {}) =>
      db.prepare('INSERT INTO todos (user_id, title, due_at, meeting_id, done) VALUES (?, ?, ?, ?, ?)').run(uid, title, due, extra.meeting ?? null, extra.done ?? 0).lastInsertRowid as number;
    const today = mk(U.td_out.id, '오늘 마감', '2030-06-15');
    const tomorrow = mk(U.td_out.id, '내일 마감', '2030-06-16T23:00');
    const overdue = mk(U.td_out.id, '지난 마감', '2030-06-14');
    mk(U.td_out.id, '먼 마감', '2030-07-01');
    mk(U.td_out.id, '끝난 것', '2030-06-14', { done: 1 });
    mk(U.td_out.id, '마감 없음', null);
    const team = mk(U.td_m1.id, '팀 할 일', '2030-06-15', { meeting: orgMeetingId });
    db.prepare('INSERT INTO todo_assignees (todo_id, user_id) VALUES (?, ?), (?, ?)').run(team, U.td_m2.id, team, U.td_m3.id);

    const m2Before = notis(U.td_m2.id).length;
    expect(runTodoReminders(now)).toBe(5);
    expect(notis(U.td_out.id)).toEqual([
      { from_name: 'exist AI', text: "'오늘 마감' 할 일 마감이 오늘이에요", meeting_code: null },
      { from_name: 'exist AI', text: "'내일 마감' 할 일 마감이 내일이에요", meeting_code: null },
      { from_name: 'exist AI', text: "'지난 마감' 할 일 마감(6/14)이 지났어요 — 확인 부탁해요", meeting_code: null },
    ]);
    expect(notis(U.td_m2.id).slice(m2Before)).toEqual([{ from_name: 'exist AI', text: "'팀 할 일' 할 일 마감이 오늘이에요 ('조직 그룹')", meeting_code: orgCode }]);
    expect(notis(U.td_m1.id).filter((n) => n.text.includes('팀 할 일'))).toEqual([]); // 작성자는 담당자가 아니면 대상 아님
    expect(db.prepare('SELECT reminded_soon, reminded_overdue FROM todos WHERE id = ?').get(today)).toEqual({ reminded_soon: 1, reminded_overdue: 0 });
    expect(db.prepare('SELECT reminded_soon, reminded_overdue FROM todos WHERE id = ?').get(overdue)).toEqual({ reminded_soon: 0, reminded_overdue: 1 });
    expect(runTodoReminders(now)).toBe(0);
    // 임박 알림을 받은 할 일이 지나면 지남 알림은 따로 1회 (오늘·내일 마감 + 팀 할 일 담당자 2명)
    expect(runTodoReminders(new Date(2030, 5, 17))).toBe(4);
    expect(db.prepare('SELECT reminded_overdue FROM todos WHERE id = ?').get(tomorrow)).toEqual({ reminded_overdue: 1 });
    expect(runTodoReminders(new Date(2030, 5, 17))).toBe(0);
  });
});
