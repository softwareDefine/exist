import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';
import { ensureAgentUser } from '../steward.js';
import { register, auth, createMeeting, joinMeeting, type User } from './helpers/fixtures.js';

/*
 * AI 겹침 시간 제안 (GET /:code/schedule/suggest) — 평일 10~17시 1시간 슬롯.
 * 주말 스킵, 겹침 경계(b.s < e && s < b.e), 종료 없는 일정 +60분, 종일/여러 날/반복 차단,
 * 관련자 지정 일정의 본인 한정, AI 계정 제외, 정렬(전원 가능 → 빠른 시간).
 */
const app = createApp();

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 라우트와 동일 규칙 — 내일부터 7일 중 평일만 (항상 5일) */
function windowDays(): string[] {
  const days: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) continue;
    days.push(ymd(d));
  }
  return days;
}
const isWeekday = (s: string) => {
  const wd = new Date(s + 'T00:00:00').getDay();
  return wd !== 0 && wd !== 6;
};

async function pair(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const member = await register(app, `${prefix}_member`);
  const m = await createMeeting(app, host, `${prefix} 그룹`);
  await joinMeeting(app, member, m.code);
  return { host, member, m };
}
const suggest = (code: string, u: User) => request(app).get(`/api/meetings/${code}/schedule/suggest`).set(auth(u));
const addEvent = (code: string, u: User, body: Record<string, unknown>) =>
  request(app).post(`/api/meetings/${code}/events`).set(auth(u)).send({ title: '일정', ...body });

describe('schedule/suggest', () => {
  it('일정 없으면 첫 평일 10·11·12시 전원 가능, AI 계정은 참가자여도 제외', async () => {
    const { host, member, m } = await pair('sg1');
    void member;
    db.prepare('INSERT OR IGNORE INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)').run(m.id, ensureAgentUser());
    const days = windowDays();
    const r = await suggest(m.code, host);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      total: 2, // AI 제외
      slots: [
        { date: days[0], time: '10:00', free: 2, busy: [] },
        { date: days[0], time: '11:00', free: 2, busy: [] },
        { date: days[0], time: '12:00', free: 2, busy: [] },
      ],
    });
  }, 20_000);

  it('주말은 후보에서 빠진다 — 모든 평일이 바빠도 주말로 도망가지 않는다', async () => {
    const { host, member, m } = await pair('sg2');
    const days = windowDays();
    // time 없음 = 종일 차단, 관련자 지정으로 member 만 (지정 없으면 그룹 전원이 바쁜 것으로 본다)
    for (const d of days) await addEvent(m.code, member, { title: '종일 출장', date: d, people: [member.id] });
    const r = await suggest(m.code, host);
    expect(r.body.slots).toEqual([
      { date: days[0], time: '10:00', free: 1, busy: ['sg2_member'] },
      { date: days[0], time: '11:00', free: 1, busy: ['sg2_member'] },
      { date: days[0], time: '12:00', free: 1, busy: ['sg2_member'] },
    ]);
    for (const s of r.body.slots as { date: string }[]) expect(isWeekday(s.date)).toBe(true);
  }, 20_000);

  it('10~17시 중 16시만 비면 16:00이 1순위 — 슬롯은 16시까지 존재한다', async () => {
    const { host, member, m } = await pair('sg3');
    const days = windowDays();
    await addEvent(m.code, member, { date: days[0], time: '10:00', end_time: '16:00' });
    const r = await suggest(m.code, host);
    expect(r.body.slots).toEqual([
      { date: days[0], time: '16:00', free: 2, busy: [] },
      { date: days[1], time: '10:00', free: 2, busy: [] },
      { date: days[1], time: '11:00', free: 2, busy: [] },
    ]);
  }, 20_000);

  it('겹침 경계 — 11~12시 일정은 10시·12시 슬롯을 막지 않는다', async () => {
    const { host, member, m } = await pair('sg4');
    const days = windowDays();
    await addEvent(m.code, member, { date: days[0], time: '11:00', end_time: '12:00' });
    const r = await suggest(m.code, host);
    expect(r.body.slots).toEqual([
      { date: days[0], time: '10:00', free: 2, busy: [] },
      { date: days[0], time: '12:00', free: 2, busy: [] },
      { date: days[0], time: '13:00', free: 2, busy: [] },
    ]);
  }, 20_000);

  it('종료 없는 일정은 60분으로 본다 — 10시 일정이면 11시는 가능', async () => {
    const { host, member, m } = await pair('sg5');
    const days = windowDays();
    await addEvent(m.code, member, { date: days[0], time: '10:00' });
    const r = await suggest(m.code, host);
    expect(r.body.slots).toEqual([
      { date: days[0], time: '11:00', free: 2, busy: [] },
      { date: days[0], time: '12:00', free: 2, busy: [] },
      { date: days[0], time: '13:00', free: 2, busy: [] },
    ]);
  }, 20_000);

  it('종일·여러 날 일정은 그 날 전체 차단 — 첫 전원 가능 슬롯이 4번째 평일로 밀린다', async () => {
    const { host, member, m } = await pair('sg6');
    const days = windowDays();
    await addEvent(m.code, member, { title: '휴가', date: days[0] }); // 종일
    await addEvent(m.code, host, { title: '출장', date: days[1], end_date: days[2] }); // 여러 날
    const r = await suggest(m.code, host);
    expect(r.body.slots).toEqual([
      { date: days[3], time: '10:00', free: 2, busy: [] },
      { date: days[3], time: '11:00', free: 2, busy: [] },
      { date: days[3], time: '12:00', free: 2, busy: [] },
    ]);
  }, 20_000);

  it('반복 일정은 창 안 occurrence 전부 차단 — daily(until 둘째 평일)면 셋째 평일부터', async () => {
    const { host, member, m } = await pair('sg7');
    const days = windowDays();
    // daily 반복이 주말을 건너 days[1]까지 — 종일이라 그 날 전체 차단
    await addEvent(m.code, member, { title: '반복 점검', date: days[0], recur: 'daily', recur_until: days[1] });
    const r = await suggest(m.code, host);
    expect(r.body.slots).toEqual([
      { date: days[2], time: '10:00', free: 2, busy: [] },
      { date: days[2], time: '11:00', free: 2, busy: [] },
      { date: days[2], time: '12:00', free: 2, busy: [] },
    ]);
  }, 20_000);

  it('관련자 지정 일정은 그 사람만 바쁘다', async () => {
    const { host, member, m } = await pair('sg8');
    const days = windowDays();
    for (const d of days) await addEvent(m.code, member, { title: '호스트만', date: d, people: [host.id] });
    const r = await suggest(m.code, member);
    expect(r.body.total).toBe(2);
    expect(r.body.slots[0]).toEqual({ date: days[0], time: '10:00', free: 1, busy: ['sg8_host'] });
  }, 20_000);

  it('비참가자는 403 — 정확한 본문', async () => {
    const { m } = await pair('sg9');
    const outsider = await register(app, 'sg9_out');
    const denied = await suggest(m.code, outsider);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: '회의 참가자만 쓸 수 있어요' });
    expect((await suggest('NOPE09', outsider)).body).toEqual({ error: '존재하지 않는 회의입니다' });
  }, 20_000);
});
