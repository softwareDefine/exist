import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';
import { stepEventDate, eventOccurrenceOnOrAfter } from '../meetings.js';
import { register, auth, createMeeting, joinMeeting, notifications, type User } from './helpers/fixtures.js';

/*
 * 회의 일정 이벤트 — POST/GET/PATCH /:code/events, 수신확인(ack),
 * /schedule 의 이벤트 occurrence 전개(여러 날·반복·창 경계·120개 상한),
 * stepEventDate / eventOccurrenceOnOrAfter 단위 검증.
 */
const app = createApp();

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const iso = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const D = (n: number) => ymd(addDays(new Date(), n));

async function setup(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const member = await register(app, `${prefix}_member`);
  const m = await createMeeting(app, host, `${prefix} 그룹`);
  await joinMeeting(app, member, m.code);
  return { host, member, m };
}
const post = (code: string, u: User, body: Record<string, unknown>) =>
  request(app).post(`/api/meetings/${code}/events`).set(auth(u)).send(body);

describe('일정 추가 (POST /:code/events) — 검증·정제·알림', () => {
  it('제목/날짜 검증, 같은 날 종료<=시작 400, 여러 날은 이른 종료 허용, is_call은 시각 필수', async () => {
    const { host, m } = await setup('ev1');
    expect((await post(m.code, host, { date: D(1) })).body).toEqual({ error: '일정 제목을 입력하세요' });
    expect((await post(m.code, host, { title: '  ', date: D(1) })).status).toBe(400);
    expect((await post(m.code, host, { title: 'x', date: '2026/10/01' })).body).toEqual({ error: '날짜를 확인하세요' });
    expect((await post(m.code, host, { title: 'x' })).status).toBe(400);
    expect((await post('NOPE11', host, { title: 'x', date: D(1) })).body).toEqual({ error: '존재하지 않는 회의입니다' });
    expect((await post(m.code, host, { title: 'x', date: D(1), time: '11:00', end_time: '10:00' })).body).toEqual({
      error: '종료 시간이 시작보다 빨라요',
    });
    expect((await post(m.code, host, { title: 'x', date: D(1), time: '11:00', end_time: '11:00' })).status).toBe(400); // 같은 시각도 불가
    // 여러 날이면 다음 날 이른 시각 정상
    const multi = await post(m.code, host, { title: '합숙', date: D(1), end_date: D(2), time: '11:00', end_time: '09:00' });
    expect(multi.status).toBe(200);
    // end_date == date 는 무효 (뒤여야 함)
    const sameEnd = await post(m.code, host, { title: 'x', date: D(1), end_date: D(1), time: '10:00' });
    expect(db.prepare('SELECT end_date FROM meeting_events WHERE id = ?').get(sameEnd.body.id)).toEqual({ end_date: null });
    // is_call — 시각 없으면 0, 있으면 1
    const callNoTime = await post(m.code, host, { title: '통화?', date: D(1), is_call: true });
    expect(callNoTime.body.is_call).toBe(0);
    const callTimed = await post(m.code, host, { title: '통화', date: D(1), time: '10:00', is_call: true });
    expect(callTimed.body.is_call).toBe(1);
    expect(db.prepare('SELECT is_call FROM meeting_events WHERE id = ?').get(callTimed.body.id)).toEqual({ is_call: 1 });
  }, 20_000);

  it('필드 정제 — 제목 80자, people 참가자만·중복 제거, memo 500·공백은 null, remind 허용값만, 색·반복 검증', async () => {
    const { host, member, m } = await setup('ev2');
    const outsider = await register(app, 'ev2_out');
    const r = await post(m.code, host, {
      title: ' 가'.repeat(60), // trim 후 119자 → 80자
      date: D(1),
      time: '9:00', // 형식 불일치 → null
      people: [member.id, member.id, outsider.id, 'x', 3.5],
      memo: '  나'.repeat(300),
      remind: 7, // 허용값 아님 → null
      recur: 'yearly', // 무효 → null
      recur_until: D(30),
      color: '#ABCdef99', // 형식 불일치 → null
    });
    expect(r.status).toBe(200);
    const row = db
      .prepare('SELECT title, time, people, memo, remind, recur, recur_until, color FROM meeting_events WHERE id = ?')
      .get(r.body.id) as Record<string, unknown>;
    expect((row.title as string).length).toBe(80);
    expect(row.time).toBeNull();
    expect(JSON.parse(row.people as string)).toEqual([member.id]);
    expect((row.memo as string).length).toBe(500);
    expect(row.remind).toBeNull();
    expect(row.recur).toBeNull();
    expect(row.recur_until).toBeNull(); // recur 없으면 until 도 없음
    expect(row.color).toBeNull();

    const ok = await post(m.code, host, { title: '정상', date: D(1), time: '10:00', end_time: '11:30', remind: 0, recur: 'weekly', recur_until: D(30), color: '#AbCdEf', memo: '   ' });
    const row2 = db
      .prepare('SELECT time, end_time, memo, remind, recur, recur_until, color FROM meeting_events WHERE id = ?')
      .get(ok.body.id) as Record<string, unknown>;
    expect(row2).toEqual({ time: '10:00', end_time: '11:30', memo: null, remind: 0, recur: 'weekly', recur_until: D(30), color: '#abcdef' });
  }, 20_000);

  it('알림 — 관련자는 "콕 집힌" 문구, 나머지는 일정 추가 문구, 작성자 제외, MM/DD·시간대 포맷', async () => {
    const { host, member, m } = await setup('ev3');
    const third = await register(app, 'ev3_third');
    await joinMeeting(app, third, m.code);
    const date = D(1);
    const md = date.slice(5).replace('-', '/');
    const r = await post(m.code, host, { title: '설비 점검', date, time: '10:00', end_time: '11:00', people: [member.id] });
    expect(r.status).toBe(200);
    expect(notifications(member.id).at(-1)).toEqual({
      from_name: 'ev3_host',
      text: `'설비 점검' 일정의 관련자로 지정됐어요 (${md} 10:00~11:00) — ev3 그룹`,
      kind: null,
      meeting_code: m.code,
    });
    expect(notifications(third.id).at(-1)).toEqual({
      from_name: 'ev3_host',
      text: `'ev3 그룹'에 일정 추가 — 설비 점검 (${md} 10:00~11:00)`,
      kind: null,
      meeting_code: m.code,
    });
    expect(notifications(host.id)).toHaveLength(0);
    // 시각 없으면 날짜만, 통화 일정은 "통화 추가"
    await post(m.code, host, { title: '종일 행사', date });
    expect(notifications(third.id).at(-1)!.text).toBe(`'ev3 그룹'에 일정 추가 — 종일 행사 (${md})`);
    await post(m.code, host, { title: '싱크', date, time: '14:00', is_call: true });
    expect(notifications(third.id).at(-1)!.text).toBe(`'ev3 그룹'에 통화 추가 — 싱크 (${md} 14:00)`);
  }, 20_000);
});

describe('일정 목록·수신확인 (GET /:code/events, POST ack)', () => {
  it('날짜→시각(없으면 마지막) 정렬, people 이름 해석(유령 제외·손상 []), acks 명단, ack 멱등·404', async () => {
    const { host, member, m } = await setup('ev4');
    const e1 = (await post(m.code, host, { title: '늦은 날', date: D(2), time: '10:00' })).body.id as number;
    const e2 = (await post(m.code, host, { title: '종일', date: D(1) })).body.id as number;
    const e3 = (await post(m.code, host, { title: '아침', date: D(1), time: '09:00', people: [member.id] })).body.id as number;
    // 유령 관련자 + 손상 people 행
    db.prepare('UPDATE meeting_events SET people = ? WHERE id = ?').run(JSON.stringify([member.id, 999999]), e1);
    db.prepare('UPDATE meeting_events SET people = ? WHERE id = ?').run('{{bad', e2);

    expect((await request(app).post(`/api/meetings/${m.code}/events/${e3}/ack`).set(auth(member)).send({})).body).toEqual({ ok: true });
    expect((await request(app).post(`/api/meetings/${m.code}/events/${e3}/ack`).set(auth(member)).send({})).body).toEqual({ ok: true }); // 멱등
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_acks WHERE event_id = ?').get(e3)).toEqual({ n: 1 });
    const nf = await request(app).post(`/api/meetings/${m.code}/events/999999/ack`).set(auth(member)).send({});
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: '존재하지 않는 일정이에요' });

    const list = await request(app).get(`/api/meetings/${m.code}/events`).set(auth(member));
    expect(list.status).toBe(200);
    const rows = list.body as { id: number; title: string; author: string; people: { id: number; username: string }[]; acks: string[] }[];
    expect(rows.map((r) => r.id)).toEqual([e3, e2, e1]); // 날짜 오름차순, 같은 날은 시각(없으면 99:99) 순
    expect(rows[0].author).toBe('ev4_host');
    expect(rows[0].people.map((p) => p.username)).toEqual(['ev4_member']);
    expect(rows[0].acks).toEqual(['ev4_member']);
    expect(rows[1].people).toEqual([]); // 손상 people
    expect(rows[2].people.map((p) => p.id)).toEqual([member.id]); // 유령 id 제외
    expect((await request(app).get('/api/meetings/NOPE12/events').set(auth(member))).body).toEqual({ error: '존재하지 않는 회의입니다' });
  }, 20_000);
});

describe('일정 수정 (PATCH /:code/events/:eventId)', () => {
  it('부분 수정 — 안 준 필드는 유지, 무효 날짜는 기존 유지, 빈 제목 400, 시각 검증', async () => {
    const { host, m } = await setup('ev5');
    const id = (await post(m.code, host, { title: '원래', date: D(1), time: '10:00', end_time: '11:00', memo: '메모', remind: 30, recur: 'weekly', recur_until: D(30), color: '#112233', is_call: true })).body.id as number;
    const patch = (body: Record<string, unknown>) => request(app).patch(`/api/meetings/${m.code}/events/${id}`).set(auth(host)).send(body);

    expect((await patch({ title: '   ' })).body).toEqual({ error: '일정 제목을 입력하세요' });
    expect((await patch({ time: '12:00', end_time: '11:00' })).body).toEqual({ error: '종료 시간이 시작보다 빨라요' });

    // 제목만 바꾸면 나머지 유지
    const r1 = await patch({ title: ' 바뀐 제목 ' });
    expect(r1.body).toEqual({ id, title: '바뀐 제목', date: D(1), time: '10:00', end_time: '11:00', is_call: 1 });
    let row = db.prepare('SELECT title, date, time, end_time, memo, remind, recur, recur_until, color, is_call FROM meeting_events WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toEqual({ title: '바뀐 제목', date: D(1), time: '10:00', end_time: '11:00', memo: '메모', remind: 30, recur: 'weekly', recur_until: D(30), color: '#112233', is_call: 1 });

    // 무효 날짜 → 기존 유지, recur 해제 → until 함께 삭제, 시각 제거 → 종료도 제거·통화 해제
    const r2 = await patch({ date: 'bad-date', recur: null, time: null, memo: null, remind: null, color: 'red' });
    expect(r2.body).toEqual({ id, title: '바뀐 제목', date: D(1), time: null, end_time: null, is_call: 0 });
    row = db.prepare('SELECT date, time, end_time, memo, remind, recur, recur_until, color, is_call FROM meeting_events WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toEqual({ date: D(1), time: null, end_time: null, memo: null, remind: null, recur: null, recur_until: null, color: null, is_call: 0 });
    expect((await request(app).patch(`/api/meetings/${m.code}/events/999999`).set(auth(host)).send({ title: 'x' })).body).toEqual({ error: '존재하지 않는 일정입니다' });
  }, 20_000);

  it('새로 지정된 관련자에게만 알림 — 기존 관련자·본인 제외', async () => {
    const { host, member, m } = await setup('ev6');
    const third = await register(app, 'ev6_third');
    await joinMeeting(app, third, m.code);
    const id = (await post(m.code, host, { title: '회람', date: D(1), time: '10:00', people: [member.id] })).body.id as number;
    const before = notifications(member.id).length;
    const md = D(1).slice(5).replace('-', '/');
    const r = await request(app)
      .patch(`/api/meetings/${m.code}/events/${id}`)
      .set(auth(host))
      .send({ people: [member.id, third.id, host.id] });
    expect(r.status).toBe(200);
    expect(notifications(member.id)).toHaveLength(before); // 기존 관련자 재알림 없음
    expect(notifications(host.id)).toHaveLength(0); // 본인 제외
    expect(notifications(third.id).at(-1)).toEqual({
      from_name: 'ev6_host',
      text: `'회람' 일정의 관련자로 지정됐어요 (${md} 10:00)`,
      kind: null,
      meeting_code: m.code,
    });
  }, 20_000);
});

describe('/schedule 의 이벤트 전개 — 여러 날·반복 경계·창 밖 제외·120개 상한', () => {
  it('여러 날 시각 일정은 종료일+종료시각, 종료시각 없으면 23:59, until 당일 포함, 창 밖 제외', async () => {
    const host = await register(app, 'ev7_host');
    const m = await createMeeting(app, host, 'ev7');
    const timed = (await post(m.code, host, { title: '합숙', date: D(1), end_date: D(3), time: '10:00', end_time: '14:00' })).body.id as number;
    const noEnd = (await post(m.code, host, { title: '공사', date: D(1), end_date: D(2), time: '09:00' })).body.id as number;
    const untilEv = (await post(m.code, host, { title: '반복', date: D(1), recur: 'daily', recur_until: D(2) })).body.id as number;
    const past = (await post(m.code, host, { title: '옛날', date: D(-40) })).body.id as number;
    const far = (await post(m.code, host, { title: '먼 미래', date: D(95) })).body.id as number;

    const r = await request(app).get('/api/meetings/schedule').set(auth(host));
    expect(r.status).toBe(200);
    const rows = r.body as { occId: string; starts_at: string; ends_at: string | null; allDay?: boolean; kind?: string }[];
    const of = (id: number) => rows.filter((x) => x.occId.startsWith(`ev${id}@`));

    expect(of(timed)).toEqual([
      expect.objectContaining({ starts_at: `${D(1)}T10:00`, ends_at: `${D(3)}T14:00`, allDay: false, kind: 'event' }),
    ]);
    expect(of(noEnd)).toEqual([expect.objectContaining({ starts_at: `${D(1)}T09:00`, ends_at: `${D(2)}T23:59` })]);
    expect(of(untilEv).map((x) => x.starts_at)).toEqual([`${D(1)}T00:00`, `${D(2)}T00:00`]); // until 당일 포함
    expect(of(past)).toEqual([]); // 31일 전 창 밖
    expect(of(far)).toEqual([]); // 90일 후 창 밖
  }, 20_000);

  it('daily 반복 회의는 창 [now-31d, now+90d] 안에서 최대 120개', async () => {
    const host = await register(app, 'ev8_host');
    const start = addDays(new Date(), -32);
    start.setHours(9, 0, 0, 0);
    await createMeeting(app, host, '오래된 매일 회의', { starts_at: iso(start), recur: 'daily' });
    const r = await request(app).get('/api/meetings/schedule').set(auth(host));
    const mine = (r.body as { occId: string; kind?: string }[]).filter((x) => !x.kind);
    expect(mine).toHaveLength(120);
  }, 20_000);
});

describe('stepEventDate / eventOccurrenceOnOrAfter 단위 검증', () => {
  it('간격 — daily +1, weekly +7, biweekly +14, monthly +1개월', () => {
    const base = new Date('2026-03-10T00:00:00');
    expect(ymd(stepEventDate(base, 'daily'))).toBe('2026-03-11');
    expect(ymd(stepEventDate(base, 'weekly'))).toBe('2026-03-17');
    expect(ymd(stepEventDate(base, 'biweekly'))).toBe('2026-03-24');
    expect(ymd(stepEventDate(base, 'monthly'))).toBe('2026-04-10');
  });

  it('occurrence 탐색 — 같은 날 포함, until 당일 포함·초과 시 null, 잘못된 앵커 null', () => {
    expect(eventOccurrenceOnOrAfter('2026-01-05', 'weekly', null, '2026-01-05')).toBe('2026-01-05'); // y >= fromYmd 경계
    expect(eventOccurrenceOnOrAfter('2026-01-05', 'weekly', null, '2026-01-06')).toBe('2026-01-12');
    expect(eventOccurrenceOnOrAfter('2026-01-05', 'biweekly', null, '2026-01-06')).toBe('2026-01-19');
    expect(eventOccurrenceOnOrAfter('2026-01-31', 'monthly', null, '2026-02-01')).not.toBeNull();
    expect(eventOccurrenceOnOrAfter('2026-01-05', 'daily', '2026-01-07', '2026-01-07')).toBe('2026-01-07'); // until 당일
    expect(eventOccurrenceOnOrAfter('2026-01-05', 'daily', '2026-01-07', '2026-01-08')).toBeNull(); // until 초과
    expect(eventOccurrenceOnOrAfter('bad-date', 'daily', null, '2026-01-01')).toBeNull();
  });
});
