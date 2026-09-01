import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';

/*
 * 일정(meeting_events) 종합 시나리오 — EV-01 ~ EV-24
 * 생성 검증 / 필드 정리(관련자·메모·알림·반복·색·기간) / 부분 수정 / 권한 /
 * 알림 라우팅 / 수신확인 / nowbar 일정 전개(반복·멀티데이) / AI 시간 제안까지 일정 기능 전부를 커버한다.
 */

const app = createApp();

let host = ''; // 호스트 토큰
let member = ''; // 참가자 토큰
let outsider = ''; // 비참가자 토큰
let hostId = 0;
let memberId = 0;
let code = ''; // 테스트 회의 코드
let meetingId = 0;

async function register(username: string) {
  const r = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'password123' });
  return { token: r.body.token as string, id: r.body.user.id as number };
}

const auth = (t: string) => `Bearer ${t}`;

async function createEvent(token: string, body: Record<string, unknown>, mcode = code) {
  return request(app)
    .post(`/api/meetings/${mcode}/events`)
    .set('Authorization', auth(token))
    .send(body);
}

interface EventOut {
  id: number;
  title: string;
  date: string;
  time: string | null;
  end_time: string | null;
  end_date: string | null;
  is_call: number;
  memo: string | null;
  remind: number | null;
  recur: string | null;
  recur_until: string | null;
  color: string | null;
  people: { id: number; username: string; name: string | null }[];
  acks: string[];
  author: string;
  created_by: number;
}

async function listEvents(token = host) {
  const r = await request(app)
    .get(`/api/meetings/${code}/events`)
    .set('Authorization', auth(token));
  return r.body as EventOut[];
}

interface Occ {
  id: number;
  occId: string;
  code: string;
  title: string;
  meetingTitle: string;
  thumbnail: string | null;
  starts_at: string;
  ends_at: string | null;
  recur: string;
  kind?: string;
  allDay?: boolean;
}

async function schedule(token = host) {
  const r = await request(app).get('/api/meetings/schedule?org=personal').set('Authorization', auth(token));
  return r.body as Occ[];
}

/** 오늘 기준 n일 뒤 YYYY-MM-DD (KST 로컬) */
function day(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** 알림 문구용 MM/DD */
const md = (ymd: string) => ymd.slice(5).replace('-', '/');

const eventCount = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM meeting_events WHERE meeting_id = ?').get(meetingId) as { n: number }).n;
const eventRow = (id: number) =>
  db.prepare('SELECT title, date, time, end_time, end_date, is_call, people, memo, remind, recur, recur_until, color, created_by FROM meeting_events WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
const notifsOf = (userId: number) =>
  db.prepare('SELECT from_name, text, kind, meeting_code FROM notifications WHERE user_id = ? ORDER BY id').all(userId) as {
    from_name: string;
    text: string;
    kind: string | null;
    meeting_code: string | null;
  }[];
const ackCount = (eventId: number) =>
  (db.prepare('SELECT COUNT(*) AS n FROM event_acks WHERE event_id = ?').get(eventId) as { n: number }).n;

beforeAll(async () => {
  const h = await register('ev_host');
  const m = await register('ev_member');
  const o = await register('ev_outsider');
  host = h.token;
  member = m.token;
  outsider = o.token;
  hostId = h.id;
  memberId = m.id;
  const meeting = await request(app)
    .post('/api/meetings')
    .set('Authorization', auth(host))
    .send({ title: '일정 테스트 회의' });
  code = meeting.body.code;
  meetingId = meeting.body.id;
  await request(app).post('/api/meetings/join').set('Authorization', auth(member)).send({ code });
});

describe('일정 생성 검증 (EV-01~05)', () => {
  it('EV-01 제목 없으면 400', async () => {
    const before = eventCount();
    const r = await createEvent(host, { date: day(1) });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: '일정 제목을 입력하세요' });
    expect((await createEvent(host, { title: '   ', date: day(1) })).status).toBe(400); // 공백만도 없는 것
    expect(eventCount()).toBe(before);
    expect(notifsOf(memberId)).toHaveLength(0); // 실패한 생성은 알림도 없다
  });

  it('EV-02 날짜 형식 오류 400', async () => {
    const before = eventCount();
    const r = await createEvent(host, { title: 'x', date: '2026/07/30' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: '날짜를 확인하세요' });
    expect((await createEvent(host, { title: 'x' })).status).toBe(400); // 날짜 누락
    expect((await createEvent(host, { title: 'x', date: day(1) }, 'NOPE00')).status).toBe(404); // 없는 회의
    expect(eventCount()).toBe(before);
  });

  it('EV-03 같은 날 종료<시작 400', async () => {
    const before = eventCount();
    const r = await createEvent(host, {
      title: 'x',
      date: day(1),
      time: '10:00',
      end_time: '09:00',
    });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: '종료 시간이 시작보다 빨라요' });
    expect((await createEvent(host, { title: 'x', date: day(1), time: '10:00', end_time: '10:00' })).status).toBe(400); // 같은 시각도 불가
    expect(eventCount()).toBe(before);
  });

  it('EV-04 여러 날이면 다음 날 이른 시각도 정상 (밤샘 워크숍)', async () => {
    const r = await createEvent(host, {
      title: '밤샘',
      date: day(1),
      time: '22:00',
      end_time: '08:00',
      end_date: day(2),
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: expect.any(Number), title: '밤샘', date: day(1), time: '22:00', end_time: '08:00', is_call: 0 });
    const ev = (await listEvents()).find((e) => e.title === '밤샘')!;
    expect(ev.end_date).toBe(day(2));
    expect(ev.end_time).toBe('08:00');
    expect(ev).toEqual({
      id: r.body.id,
      title: '밤샘',
      date: day(1),
      time: '22:00',
      end_time: '08:00',
      end_date: day(2),
      is_call: 0,
      memo: null,
      people: [],
      remind: null,
      recur: null,
      recur_until: null,
      color: null,
      author: 'ev_host',
      created_by: hostId,
      acks: [],
    });
    // 참가자(작성자 제외)에게 회의 썸네일이 붙는 알림 1건 — 호스트 자신에겐 없음
    expect(notifsOf(memberId)).toEqual([
      { from_name: 'ev_host', text: `'일정 테스트 회의'에 일정 추가 — 밤샘 (${md(day(1))} 22:00~08:00)`, kind: null, meeting_code: code },
    ]);
    expect(notifsOf(hostId)).toHaveLength(0);
    // 참가자도 같은 목록을 본다
    expect((await listEvents(member)).map((e) => e.id)).toEqual([r.body.id]);
  });

  it('EV-05 종료일이 시작일과 같거나 이전이면 무시(null) → 시간 검사 적용', async () => {
    const bad = await createEvent(host, {
      title: 'x',
      date: day(1),
      time: '10:00',
      end_time: '09:00',
      end_date: day(1), // 같은 날 = 무시
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: '종료 시간이 시작보다 빨라요' });
    expect((await createEvent(host, { title: 'x', date: day(2), time: '10:00', end_time: '09:00', end_date: day(1) })).status).toBe(400); // 이전 날도 무시
    // 종료일이 앞서지만 시간이 정상이면 저장되되 end_date 는 null
    const ok = await createEvent(host, { title: '종료일무시', date: day(2), time: '10:00', end_time: '11:00', end_date: day(1) });
    expect(ok.status).toBe(200);
    expect(eventRow(ok.body.id)).toMatchObject({ end_date: null, time: '10:00', end_time: '11:00' });
  });
});

describe('일정 필드 정리 (EV-06~10)', () => {
  it('EV-06 메모 trim + 500자 제한', async () => {
    const raw = '  긴 메모  '.padEnd(600, '가');
    await createEvent(host, { title: '메모테스트', date: day(3), memo: raw });
    const ev = (await listEvents()).find((e) => e.title === '메모테스트')!;
    expect(ev.memo!.startsWith('긴 메모')).toBe(true);
    expect(ev.memo!.length).toBeLessThanOrEqual(500);
    expect(ev.memo).toBe(raw.trim().slice(0, 500));
    expect(ev.memo).toHaveLength(500);
    // 빈 메모는 null, 제목도 80자로 잘린다
    const t = await createEvent(host, { title: '제'.repeat(100), date: day(3), memo: '   ' });
    expect(eventRow(t.body.id)).toMatchObject({ memo: null, title: '제'.repeat(80) });
  });

  it('EV-07 관련자 — 참가자 아닌 id는 걸러지고 중복 제거', async () => {
    const r = await createEvent(host, {
      title: '관련자테스트',
      date: day(3),
      people: [memberId, memberId, 99999, 'abc'],
    });
    const ev = (await listEvents()).find((e) => e.title === '관련자테스트')!;
    expect(ev.people.map((p) => p.username)).toEqual(['ev_member']);
    expect(ev.people).toEqual([{ id: memberId, username: 'ev_member', name: null }]);
    expect(eventRow(r.body.id)!.people).toBe(JSON.stringify([memberId]));
    // 관련자로 지정된 사람에겐 "콕 집은" 문구로 간다
    expect(notifsOf(memberId).slice(-1)[0]).toEqual({
      from_name: 'ev_host',
      text: `'관련자테스트' 일정의 관련자로 지정됐어요 (${md(day(3))}) — 일정 테스트 회의`,
      kind: null,
      meeting_code: code,
    });
    // 배열이 아니면 빈 목록
    const none = await createEvent(host, { title: '관련자없음', date: day(3), people: 'ev_member' });
    expect(eventRow(none.body.id)!.people).toBe('[]');
  });

  it('EV-08 알림 시점 — 허용값 외는 기본(null), 0=없음 저장', async () => {
    await createEvent(host, { title: '알림A', date: day(3), time: '10:00', remind: 999 });
    await createEvent(host, { title: '알림B', date: day(3), time: '11:00', remind: 0 });
    await createEvent(host, { title: '알림C', date: day(3), time: '12:00', remind: 60 });
    await createEvent(host, { title: '알림D', date: day(3), time: '13:00', remind: '1440' }); // 문자열 숫자도 허용
    const evs = await listEvents();
    expect(evs.find((e) => e.title === '알림A')!.remind).toBeNull();
    expect(evs.find((e) => e.title === '알림B')!.remind).toBe(0);
    expect(evs.find((e) => e.title === '알림C')!.remind).toBe(60);
    expect(evs.find((e) => e.title === '알림D')!.remind).toBe(1440);
    // 시간 정렬 — 같은 날은 시각순, 종일(time null)은 그 날 맨 뒤
    const sameDay = evs.filter((e) => e.date === day(3)).map((e) => e.time);
    expect(sameDay.filter((t) => t !== null)).toEqual([...sameDay.filter((t) => t !== null)].sort());
    expect(sameDay.indexOf(null)).toBeGreaterThan(sameDay.lastIndexOf('13:00'));
  });

  it('EV-09 반복 — 잘못된 주기는 null, weekly+종료일 저장', async () => {
    await createEvent(host, { title: '반복X', date: day(3), recur: 'hourly', recur_until: day(30) });
    await createEvent(host, { title: '반복W', date: day(3), recur: 'weekly', recur_until: day(30) });
    await createEvent(host, { title: '반복U', date: day(3), recur: 'monthly', recur_until: '2026/12/31' });
    const evs = await listEvents();
    const x = evs.find((e) => e.title === '반복X')!;
    expect(x.recur).toBeNull();
    expect(x.recur_until).toBeNull(); // 주기가 무효면 종료일도 버린다
    const w = evs.find((e) => e.title === '반복W')!;
    expect(w.recur).toBe('weekly');
    expect(w.recur_until).toBe(day(30));
    const u = evs.find((e) => e.title === '반복U')!;
    expect(u.recur).toBe('monthly');
    expect(u.recur_until).toBeNull(); // 형식 틀린 종료일은 무기한
  });

  it('EV-10 색 — #rrggbb만 허용(소문자 정규화), 이상값은 null', async () => {
    await createEvent(host, { title: '색OK', date: day(3), color: '#8E4EF7' });
    await createEvent(host, { title: '색BAD', date: day(3), color: 'purple' });
    await createEvent(host, { title: '색SHORT', date: day(3), color: '#fff' });
    const evs = await listEvents();
    expect(evs.find((e) => e.title === '색OK')!.color).toBe('#8e4ef7');
    expect(evs.find((e) => e.title === '색BAD')!.color).toBeNull();
    expect(evs.find((e) => e.title === '색SHORT')!.color).toBeNull();
    expect(eventRow(evs.find((e) => e.title === '색OK')!.id)!.color).toBe('#8e4ef7');
  });
});

describe('일정 수정·권한 (EV-11~16, EV-22)', () => {
  let evId = 0;

  beforeAll(async () => {
    const r = await createEvent(host, {
      title: '수정대상',
      date: day(5),
      time: '14:00',
      end_time: '15:00',
      memo: '원본 메모',
      people: [memberId],
      remind: 30,
      recur: 'weekly',
      recur_until: day(40),
      color: '#e5484d',
    });
    evId = r.body.id;
  });

  it('EV-11 제목만 수정해도 나머지 필드 전부 유지', async () => {
    const notifBefore = notifsOf(memberId).length;
    const r = await request(app)
      .patch(`/api/meetings/${code}/events/${evId}`)
      .set('Authorization', auth(host))
      .send({ title: '수정대상2' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: evId, title: '수정대상2', date: day(5), time: '14:00', end_time: '15:00', is_call: 0 });
    const ev = (await listEvents()).find((e) => e.id === evId)!;
    expect(ev.memo).toBe('원본 메모');
    expect(ev.people).toHaveLength(1);
    expect(ev.remind).toBe(30);
    expect(ev.recur).toBe('weekly');
    expect(ev.color).toBe('#e5484d');
    expect(ev).toMatchObject({
      title: '수정대상2',
      date: day(5),
      time: '14:00',
      end_time: '15:00',
      end_date: null,
      recur_until: day(40),
      people: [{ id: memberId, username: 'ev_member', name: null }],
      author: 'ev_host',
    });
    expect(notifsOf(memberId)).toHaveLength(notifBefore); // 관련자 변동 없음 → 알림 없음
    // 제목을 비우는 수정은 400 (기존 제목 유지)
    const empty = await request(app).patch(`/api/meetings/${code}/events/${evId}`).set('Authorization', auth(host)).send({ title: '  ' });
    expect(empty.status).toBe(400);
    expect(eventRow(evId)!.title).toBe('수정대상2');
  });

  it('EV-12 명시적으로 비우기 — memo·people·color', async () => {
    await request(app)
      .patch(`/api/meetings/${code}/events/${evId}`)
      .set('Authorization', auth(host))
      .send({ memo: '', people: [], color: null });
    const ev = (await listEvents()).find((e) => e.id === evId)!;
    expect(ev.memo).toBeNull();
    expect(ev.people).toHaveLength(0);
    expect(ev.color).toBeNull();
    expect(eventRow(evId)).toMatchObject({ memo: null, people: '[]', color: null, remind: 30, recur: 'weekly' });
  });

  it('EV-13 반복 해제하면 종료일도 함께 제거', async () => {
    await request(app)
      .patch(`/api/meetings/${code}/events/${evId}`)
      .set('Authorization', auth(host))
      .send({ recur: null });
    const ev = (await listEvents()).find((e) => e.id === evId)!;
    expect(ev.recur).toBeNull();
    expect(ev.recur_until).toBeNull();
    // 다시 반복을 켜면 종료일은 새로 줘야 한다 (이전 값이 되살아나지 않음)
    await request(app).patch(`/api/meetings/${code}/events/${evId}`).set('Authorization', auth(host)).send({ recur: 'daily' });
    expect(eventRow(evId)).toMatchObject({ recur: 'daily', recur_until: null });
    await request(app).patch(`/api/meetings/${code}/events/${evId}`).set('Authorization', auth(host)).send({ recur: null });
    expect(eventRow(evId)).toMatchObject({ recur: null, recur_until: null });
  });

  it('EV-14 참가자여도 남의 일정은 수정 불가 (작성자·호스트만)', async () => {
    const r = await request(app)
      .patch(`/api/meetings/${code}/events/${evId}`)
      .set('Authorization', auth(member))
      .send({ title: '멋대로' });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: '작성자·호스트·조직 관리자만 수정할 수 있어요' });
    expect(eventRow(evId)!.title).toBe('수정대상2');
    // 비참가자도 403, 없는 일정은 404
    expect((await request(app).patch(`/api/meetings/${code}/events/${evId}`).set('Authorization', auth(outsider)).send({ title: 'x' })).status).toBe(403);
    const missing = await request(app).patch(`/api/meetings/${code}/events/999999`).set('Authorization', auth(host)).send({ title: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: '존재하지 않는 일정입니다' });
  });

  it('EV-15 참가자가 만든 일정은 호스트가 수정 가능', async () => {
    const mine = await createEvent(member, { title: '멤버일정', date: day(6) });
    const r = await request(app)
      .patch(`/api/meetings/${code}/events/${mine.body.id}`)
      .set('Authorization', auth(host))
      .send({ title: '호스트가 고침' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: mine.body.id, title: '호스트가 고침', date: day(6), time: null, end_time: null, is_call: 0 });
    // 작성자는 그대로 참가자 — 작성자 본인도 여전히 수정 가능
    expect(eventRow(mine.body.id)).toMatchObject({ title: '호스트가 고침', created_by: memberId });
    const own = await request(app).patch(`/api/meetings/${code}/events/${mine.body.id}`).set('Authorization', auth(member)).send({ memo: '내가 고침' });
    expect(own.status).toBe(200);
    expect(eventRow(mine.body.id)!.memo).toBe('내가 고침');
    // 멤버 일정 생성은 호스트에게 알림이 간다 (from = 작성자)
    expect(notifsOf(hostId).slice(-1)[0]).toEqual({
      from_name: 'ev_member',
      text: `'일정 테스트 회의'에 일정 추가 — 멤버일정 (${md(day(6))})`,
      kind: null,
      meeting_code: code,
    });
  });

  it('EV-16 수정으로 새로 지정된 관련자에게 알림', async () => {
    const before = notifsOf(memberId).length;
    await request(app)
      .patch(`/api/meetings/${code}/events/${evId}`)
      .set('Authorization', auth(host))
      .send({ people: [memberId] });
    const notif = await request(app)
      .get('/api/notifications')
      .set('Authorization', auth(member));
    const texts = (notif.body.items ?? notif.body).map((n: { text: string }) => n.text);
    expect(texts.some((t: string) => t.includes('관련자로 지정됐어요'))).toBe(true);
    expect(notifsOf(memberId)).toHaveLength(before + 1);
    expect(notifsOf(memberId).slice(-1)[0]).toEqual({
      from_name: 'ev_host',
      text: `'수정대상2' 일정의 관련자로 지정됐어요 (${md(day(5))} 14:00~15:00)`,
      kind: null,
      meeting_code: code,
    });
    expect(notif.body.items[0]).toMatchObject({
      from: 'ev_host',
      read: false,
      meeting: { id: meetingId, code, title: '일정 테스트 회의', thumbnail: null },
    });
    // 같은 관련자를 다시 보내도 중복 알림 없음 (멱등)
    await request(app).patch(`/api/meetings/${code}/events/${evId}`).set('Authorization', auth(host)).send({ people: [memberId], title: '수정대상3' });
    expect(notifsOf(memberId)).toHaveLength(before + 1);
    // 작성자 자신을 관련자로 넣어도 자기에게는 알림 없음
    const hostBefore = notifsOf(hostId).length;
    await request(app).patch(`/api/meetings/${code}/events/${evId}`).set('Authorization', auth(host)).send({ people: [memberId, hostId] });
    expect(notifsOf(hostId)).toHaveLength(hostBefore);
    expect(eventRow(evId)!.people).toBe(JSON.stringify([memberId, hostId]));
  });

  it('EV-22 통화 일정은 시각이 있어야 한다 — time 을 지우면 is_call 도 0', async () => {
    const call = await createEvent(host, { title: '통화일정', date: day(8), time: '09:00', end_time: '09:30', is_call: true });
    expect(call.body).toMatchObject({ is_call: 1, time: '09:00', end_time: '09:30' });
    expect(notifsOf(memberId).slice(-1)[0].text).toBe(`'일정 테스트 회의'에 통화 추가 — 통화일정 (${md(day(8))} 09:00~09:30)`);
    // 생성도 같은 규칙 — 시각 없는 통화 플래그는 무시 (PATCH 와 불일치하던 것을 9/1 정리)
    const noTime = await createEvent(host, { title: '종일통화?', date: day(8), is_call: true });
    expect(noTime.body.is_call).toBe(0);
    expect(eventRow(noTime.body.id)!.is_call).toBe(0);
    expect(notifsOf(memberId).slice(-1)[0].text).toBe(`'일정 테스트 회의'에 일정 추가 — 종일통화? (${md(day(8))})`);
    const r = await request(app).patch(`/api/meetings/${code}/events/${call.body.id}`).set('Authorization', auth(host)).send({ time: null });
    expect(r.body).toEqual({ id: call.body.id, title: '통화일정', date: day(8), time: null, end_time: null, is_call: 0 });
    expect(eventRow(call.body.id)).toMatchObject({ time: null, end_time: null, is_call: 0 });
  });
});

describe('일정 삭제·수신확인 (EV-17, EV-23)', () => {
  it('EV-23 수신확인 — 참가자만, 멱등, 목록에 서명자 노출', async () => {
    const ev = await createEvent(host, { title: '확인대상', date: day(9) });
    const ok = await request(app).post(`/api/meetings/${code}/events/${ev.body.id}/ack`).set('Authorization', auth(member));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect((await listEvents()).find((e) => e.id === ev.body.id)!.acks).toEqual(['ev_member']);
    // 두 번 눌러도 1건
    await request(app).post(`/api/meetings/${code}/events/${ev.body.id}/ack`).set('Authorization', auth(member));
    expect(ackCount(ev.body.id)).toBe(1);
    await request(app).post(`/api/meetings/${code}/events/${ev.body.id}/ack`).set('Authorization', auth(host));
    // 같은 초에 찍힌 서명은 created_at 정렬이 동률이라 집합으로 비교
    expect([...(await listEvents(member)).find((e) => e.id === ev.body.id)!.acks].sort()).toEqual(['ev_host', 'ev_member']);
    // 비참가자 403, 없는 일정 404, 없는 회의 404
    const deny = await request(app).post(`/api/meetings/${code}/events/${ev.body.id}/ack`).set('Authorization', auth(outsider));
    expect(deny.status).toBe(403);
    expect(deny.body).toEqual({ error: '회의 참가자만 쓸 수 있어요' });
    const missing = await request(app).post(`/api/meetings/${code}/events/999999/ack`).set('Authorization', auth(host));
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: '존재하지 않는 일정이에요' });
    expect((await request(app).post(`/api/meetings/NOPE00/events/${ev.body.id}/ack`).set('Authorization', auth(host))).status).toBe(404);
    expect(ackCount(ev.body.id)).toBe(2);
  });

  it('EV-17 작성자·호스트 외 삭제 불가, 호스트는 남의 것도 삭제', async () => {
    const mine = await createEvent(member, { title: '삭제대상', date: day(7) });
    await request(app).post(`/api/meetings/${code}/events/${mine.body.id}/ack`).set('Authorization', auth(host));
    expect(ackCount(mine.body.id)).toBe(1);
    const deny = await request(app)
      .delete(`/api/meetings/${code}/events/${mine.body.id}`)
      .set('Authorization', auth(outsider));
    expect(deny.status).toBe(403);
    expect(deny.body).toEqual({ error: '작성자·호스트·조직 관리자만 삭제할 수 있어요' });
    expect(eventRow(mine.body.id)).toBeDefined();
    const ok = await request(app)
      .delete(`/api/meetings/${code}/events/${mine.body.id}`)
      .set('Authorization', auth(host));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    const evs = await listEvents();
    expect(evs.find((e) => e.title === '삭제대상')).toBeUndefined();
    expect(eventRow(mine.body.id)).toBeUndefined();
    expect(ackCount(mine.body.id)).toBe(0); // 수신확인도 같이 정리
    // 이미 지운 일정을 다시 지워도 200 (멱등)
    expect((await request(app).delete(`/api/meetings/${code}/events/${mine.body.id}`).set('Authorization', auth(host))).body).toEqual({ ok: true });
    // 작성자 본인은 자기 일정을 지울 수 있다
    const own = await createEvent(member, { title: '내가지움', date: day(7) });
    expect((await request(app).delete(`/api/meetings/${code}/events/${own.body.id}`).set('Authorization', auth(member))).status).toBe(200);
    expect(eventRow(own.body.id)).toBeUndefined();
  });
});

describe('nowbar 일정 전개 (EV-18~21)', () => {
  it('EV-18 매주 반복은 종료일까지 occurrence로 전개', async () => {
    const created = await createEvent(host, {
      title: '전개-매주',
      date: day(1),
      time: '09:00',
      recur: 'weekly',
      recur_until: day(22),
    });
    const all = await schedule();
    const occ = all.filter((x) => x.title === '전개-매주');
    expect(occ.length).toBe(4); // day+1, +8, +15, +22
    expect(occ[0].starts_at).toBe(`${day(1)}T09:00`);
    expect(occ).toEqual(
      [1, 8, 15, 22].map((n) => ({
        id: meetingId,
        occId: `ev${created.body.id}@${day(n)}`,
        code,
        title: '전개-매주',
        meetingTitle: '일정 테스트 회의',
        thumbnail: null,
        starts_at: `${day(n)}T09:00`,
        ends_at: null, // 종료 시각 없음
        recur: 'weekly',
        kind: 'event',
        allDay: false,
      })),
    );
    // 전체 목록은 시작 시각 오름차순
    const times = all.map((x) => x.starts_at);
    expect(times).toEqual([...times].sort());
    // 참가자도 같은 회차를 본다 / 비참가자에겐 없다
    expect((await schedule(member)).filter((x) => x.title === '전개-매주')).toHaveLength(4);
    expect((await schedule(outsider)).filter((x) => x.title === '전개-매주')).toHaveLength(0);
  });

  it('EV-19 멀티데이 일정의 ends_at은 종료일+종료시각', async () => {
    const created = await createEvent(host, {
      title: '전개-기간',
      date: day(2),
      time: '13:00',
      end_time: '10:00',
      end_date: day(4),
    });
    const occ = (await schedule()).find((x) => x.title === '전개-기간')!;
    expect(occ.ends_at).toBe(`${day(4)}T10:00`);
    expect(occ).toMatchObject({
      occId: `ev${created.body.id}@${day(2)}`,
      starts_at: `${day(2)}T13:00`,
      recur: 'none',
      allDay: false,
    });
    // 종료 시각 없는 멀티데이는 종료일 23:59 까지
    await createEvent(host, { title: '전개-기간2', date: day(2), time: '13:00', end_date: day(3) });
    expect((await schedule()).find((x) => x.title === '전개-기간2')!.ends_at).toBe(`${day(3)}T23:59`);
  });

  it('EV-20 통합 — 매주 반복 + 2박3일 조합도 회차마다 같은 기간', async () => {
    await createEvent(host, {
      title: '전개-복합',
      date: day(3),
      time: '10:00',
      end_time: '17:00',
      end_date: day(5),
      recur: 'weekly',
      recur_until: day(17),
    });
    const occ = (await schedule()).filter((x) => x.title === '전개-복합');
    expect(occ.length).toBe(3); // day+3, +10, +17
    expect(occ.map((o) => o.starts_at)).toEqual([3, 10, 17].map((n) => `${day(n)}T10:00`));
    expect(occ.map((o) => o.ends_at)).toEqual([5, 12, 19].map((n) => `${day(n)}T17:00`));
    // 각 회차의 종료는 시작 +2일
    for (const o of occ) {
      const s = new Date(o.starts_at);
      const e = new Date(o.ends_at!);
      expect(Math.round((e.getTime() - s.getTime()) / 86_400_000)).toBe(2);
    }
    expect(occ.every((o) => o.recur === 'weekly' && o.allDay === false)).toBe(true);
  });

  it('EV-21 종일 일정(time 없음)도 /schedule에 allDay로 나온다', async () => {
    const created = await createEvent(host, { title: '전개-종일', date: day(2) });
    const occ = (await schedule()).find((x) => x.title === '전개-종일')!;
    expect(occ).toBeDefined();
    expect(occ.allDay).toBe(true);
    expect(occ.starts_at).toBe(`${day(2)}T00:00`);
    // 종일은 ends_at을 비워 nowbar "진행 중" 판정에 안 걸림
    expect(occ.ends_at).toBeNull();
    expect(occ).toMatchObject({ occId: `ev${created.body.id}@${day(2)}`, recur: 'none', kind: 'event' });
    // 종일 + 여러 날도 ends_at 은 null (allDay 플래그로만 표시)
    await createEvent(host, { title: '전개-종일기간', date: day(2), end_date: day(4) });
    expect((await schedule()).find((x) => x.title === '전개-종일기간')).toMatchObject({ allDay: true, ends_at: null });
  });
});

describe('AI 겹침 시간 제안 (EV-24)', () => {
  let sHost = '';
  let sMember = '';
  let sMemberId = 0;
  let sCode = '';
  /** 내일부터 7일 중 평일 (서버와 같은 규칙) */
  const weekdays: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    weekdays.push(day(i));
  }
  const suggest = (token: string, mcode = sCode) =>
    request(app).get(`/api/meetings/${mcode}/schedule/suggest`).set('Authorization', auth(token));

  beforeAll(async () => {
    // 다른 테스트의 일정이 섞이지 않게 새 사람·새 회의
    const h = await register('ev_sug_host');
    const m = await register('ev_sug_member');
    sHost = h.token;
    sMember = m.token;
    sMemberId = m.id;
    const meeting = await request(app).post('/api/meetings').set('Authorization', auth(sHost)).send({ title: '제안 회의' });
    sCode = meeting.body.code;
    await request(app).post('/api/meetings/join').set('Authorization', auth(sMember)).send({ code: sCode });
  });

  it('일정이 없으면 첫 평일 10·11·12시가 전원 가능 슬롯', async () => {
    const r = await suggest(sHost);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      total: 2,
      slots: ['10:00', '11:00', '12:00'].map((time) => ({ date: weekdays[0], time, free: 2, busy: [] })),
    });
    expect(weekdays.length).toBe(5);
  });

  it('종일 일정은 그 날 전체 차단, 관련자 지정 일정은 그 사람만 바쁨', async () => {
    await createEvent(sHost, { title: '워크숍', date: weekdays[0] }, sCode); // 전원 종일
    const afterAllDay = await suggest(sMember);
    expect(afterAllDay.body.slots).toEqual(
      ['10:00', '11:00', '12:00'].map((time) => ({ date: weekdays[1], time, free: 2, busy: [] })),
    );
    // 관련자 = 멤버만: 10:00~11:30 → 10시·11시 슬롯에서 멤버만 빠진다
    await createEvent(sHost, { title: '멤버 면담', date: weekdays[1], time: '10:00', end_time: '11:30', people: [sMemberId] }, sCode);
    const r = await suggest(sHost);
    expect(r.body.total).toBe(2);
    expect(r.body.slots).toEqual(
      ['12:00', '13:00', '14:00'].map((time) => ({ date: weekdays[1], time, free: 2, busy: [] })),
    );
    // 참가자가 늘면 total 도 는다 — 새 참가자는 아무 일정도 없으니 같은 슬롯이 유지
    const third = await register('ev_sug_third');
    await request(app).post('/api/meetings/join').set('Authorization', auth(third.token)).send({ code: sCode });
    const r3 = await suggest(third.token);
    expect(r3.body.total).toBe(3);
    expect(r3.body.slots[0]).toEqual({ date: weekdays[1], time: '12:00', free: 3, busy: [] });
  });

  it('참가자만 조회 가능 — 비참가자 403, 없는 회의 404', async () => {
    const deny = await suggest(outsider);
    expect(deny.status).toBe(403);
    expect(deny.body).toEqual({ error: '회의 참가자만 쓸 수 있어요' });
    const missing = await suggest(sHost, 'NOPE00');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: '존재하지 않는 회의입니다' });
  });
});
