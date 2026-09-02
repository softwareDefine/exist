import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';
import { register, auth, createMeeting, joinMeeting, createOrg, joinOrg } from './helpers/fixtures.js';

/*
 * meetings.ts 목록·상세 — GET /recent, GET /inbox, POST /:code/messages/read,
 * GET /:code (허브 상세), GET /:code/messages. 스윕 전용이던 응답 본문을 실제 검증.
 */
const app = createApp();

const say = (meetingId: number, uid: number, text: string, file?: string) =>
  db.prepare('INSERT INTO messages (meeting_id, user_id, text, file) VALUES (?, ?, ?, ?)').run(meetingId, uid, text, file ?? null)
    .lastInsertRowid as number;

describe('최근 회의 (GET /api/meetings/recent)', () => {
  it('스코프 필터 — 미지정=전부, org=personal, org=<id>, org= 빈 문자열은 전부', async () => {
    const me = await register(app, 'mld1_me');
    const org = await createOrg(app, me, 'mld1 조직');
    const mOrg = await createMeeting(app, me, '조직 그룹', { org_id: org.id });
    const mP1 = await createMeeting(app, me, '개인1');
    const mP2 = await createMeeting(app, me, '개인2');

    const codes = (r: request.Response) => (r.body as { code: string }[]).map((x) => x.code).sort();
    const all = await request(app).get('/api/meetings/recent').set(auth(me));
    expect(all.status).toBe(200);
    expect(codes(all)).toEqual([mOrg.code, mP1.code, mP2.code].sort());
    expect(codes(await request(app).get('/api/meetings/recent?org=personal').set(auth(me)))).toEqual([mP1.code, mP2.code].sort());
    expect(codes(await request(app).get(`/api/meetings/recent?org=${org.id}`).set(auth(me)))).toEqual([mOrg.code]);
    expect(codes(await request(app).get('/api/meetings/recent?org=').set(auth(me)))).toEqual([mOrg.code, mP1.code, mP2.code].sort());
    const row = (all.body as Record<string, unknown>[]).find((x) => x.code === mP1.code)!;
    expect(row).toMatchObject({ id: mP1.id, code: mP1.code, title: '개인1', org_id: null, thumbnail: null, starts_at: null, ends_at: null });
    expect(row.joined_at).toEqual(expect.any(String));
  }, 20_000);

  it('최근 7개까지만', async () => {
    const me = await register(app, 'mld2_me');
    for (let i = 0; i < 8; i++) await createMeeting(app, me, `그룹 ${i}`);
    expect((await request(app).get('/api/meetings/recent').set(auth(me))).body).toHaveLength(7);
  }, 20_000);
});

describe('통합 메시지함 (GET /api/meetings/inbox) + 읽음 처리', () => {
  it('안읽음 = 남이 보낸 last_read 이후 메시지 수, lastText, 읽음 처리 후 0, 스코프 필터', async () => {
    const a = await register(app, 'mld3_a');
    const b = await register(app, 'mld3_b');
    const org = await createOrg(app, a, 'mld3 조직');
    const p = await createMeeting(app, a, '개인 채팅방');
    const q = await createMeeting(app, a, '조직 채팅방', { org_id: org.id });
    await joinMeeting(app, b, p.code);
    say(p.id, b.id, 'm1');
    say(p.id, a.id, 'm2'); // 내 메시지 — 안읽음 카운트 제외
    say(p.id, b.id, 'm3');

    const inbox = await request(app).get('/api/meetings/inbox').set(auth(a));
    expect(inbox.status).toBe(200);
    const rowP = (inbox.body as Record<string, unknown>[]).find((r) => r.code === p.code)!;
    const rowQ = (inbox.body as Record<string, unknown>[]).find((r) => r.code === q.code)!;
    expect(rowP).toMatchObject({ id: p.id, title: '개인 채팅방', unread: 2, lastText: 'm3' });
    expect(rowQ).toMatchObject({ unread: 0, lastText: null });
    expect((inbox.body as { code: string }[])[0].code).toBe(p.code); // 메시지 있는 방이 먼저

    // 스코프
    expect(((await request(app).get('/api/meetings/inbox?org=personal').set(auth(a))).body as { code: string }[]).map((r) => r.code)).toEqual([p.code]);
    expect(((await request(app).get(`/api/meetings/inbox?org=${org.id}`).set(auth(a))).body as { code: string }[]).map((r) => r.code)).toEqual([q.code]);

    // 읽음 처리 — last_read = 최신 메시지 id
    expect((await request(app).post(`/api/meetings/${p.code.toLowerCase()}/messages/read`).set(auth(a))).body).toEqual({ ok: true });
    const lastId = (db.prepare('SELECT MAX(id) AS mx FROM messages WHERE meeting_id = ?').get(p.id) as { mx: number }).mx;
    expect(db.prepare('SELECT last_read FROM chat_reads WHERE user_id = ? AND meeting_id = ?').get(a.id, p.id)).toEqual({ last_read: lastId });
    const after = await request(app).get('/api/meetings/inbox').set(auth(a));
    expect((after.body as Record<string, unknown>[]).find((r) => r.code === p.code)).toMatchObject({ unread: 0 });
    // 그 뒤 새 메시지 1건 → 1
    say(p.id, b.id, 'm4');
    const after2 = await request(app).get('/api/meetings/inbox').set(auth(a));
    expect((after2.body as Record<string, unknown>[]).find((r) => r.code === p.code)).toMatchObject({ unread: 1, lastText: 'm4' });

    const nf = await request(app).post('/api/meetings/NOPE03/messages/read').set(auth(a));
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: '존재하지 않는 그룹이에요' });
  }, 20_000);
});

describe('회의 상세 (GET /api/meetings/:code)', () => {
  it('조직 그룹 — isHost·canManage·myTier·orgName·부서 정렬·기본 settings', async () => {
    const h = await register(app, 'mld4_h');
    const m = await register(app, 'mld4_m');
    const org = await createOrg(app, h, 'mld4 조직');
    await joinOrg(app, org, h, m, { position: '사원', department: 'A팀' });
    db.prepare('UPDATE organization_members SET tier = ? WHERE org_id = ? AND user_id = ?').run('field', org.id, m.id);
    const g = await createMeeting(app, h, 'mld4 그룹', { org_id: org.id });
    await joinMeeting(app, m, g.code);

    const asMember = await request(app).get(`/api/meetings/${g.code.toLowerCase()}`).set(auth(m));
    expect(asMember.status).toBe(200);
    expect(asMember.body).toMatchObject({
      id: g.id,
      code: g.code,
      title: 'mld4 그룹',
      recur: 'none',
      recur_until: null,
      recur_except: [],
      host: 'mld4_h',
      isHost: false,
      canManage: false,
      orgId: org.id,
      orgName: 'mld4 조직',
      myTier: 'field',
      thumbnail: null,
      settings: { locked: false, guestEdit: true, muteOnJoin: false },
      period: null,
      online: 0,
    });
    expect(asMember.body.callPeers).toEqual([]);
    // 부서 정렬 — 부서 없는(zzz) 호스트가 뒤로
    expect((asMember.body.participants as Record<string, unknown>[]).map((p) => p.username)).toEqual(['mld4_m', 'mld4_h']);
    const mAvatar = (db.prepare('SELECT avatar FROM users WHERE id = ?').get(m.id) as { avatar: string | null }).avatar;
    expect(asMember.body.participants[0]).toEqual({
      userId: m.id,
      username: 'mld4_m',
      avatar: mAvatar,
      role: 'member',
      position: '사원',
      department: 'A팀',
      isHost: false,
    });
    expect(asMember.body.participants[1]).toMatchObject({ username: 'mld4_h', isHost: true });

    const asHost = await request(app).get(`/api/meetings/${g.code}`).set(auth(h));
    expect(asHost.body).toMatchObject({ isHost: true, canManage: true, myTier: null });

    const nf = await request(app).get('/api/meetings/NOPE04').set(auth(h));
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: '존재하지 않는 회의입니다' });
  }, 20_000);

  it('개인 그룹 — 조직 필드 null·참여순 정렬, 저장된/손상된 settings, period 왕복', async () => {
    const h = await register(app, 'mld5_h');
    const m = await register(app, 'mld5_m');
    const g = await createMeeting(app, h, 'mld5 개인그룹');
    await joinMeeting(app, m, g.code);

    const r = await request(app).get(`/api/meetings/${g.code}`).set(auth(m));
    expect(r.body).toMatchObject({ orgId: null, orgName: null, myTier: null, isHost: false });
    expect((r.body.participants as { username: string; role: string | null }[]).map((p) => p.username)).toEqual(['mld5_h', 'mld5_m']);
    expect(r.body.participants[0].role).toBeNull();

    // settings 왕복 + 손상 시 기본값
    expect((await request(app).patch(`/api/meetings/${g.code}/settings`).set(auth(h)).send({ locked: true, muteOnJoin: true })).status).toBe(200);
    expect((await request(app).get(`/api/meetings/${g.code}`).set(auth(h))).body.settings).toEqual({ locked: true, guestEdit: true, muteOnJoin: true });
    db.prepare('UPDATE meetings SET settings = ? WHERE id = ?').run('}{corrupt', g.id);
    expect((await request(app).get(`/api/meetings/${g.code}`).set(auth(h))).body.settings).toEqual({ locked: false, guestEdit: true, muteOnJoin: false });

    // period — 한쪽만 있어도 객체, 검증 실패 값은 null
    expect((await request(app).patch(`/api/meetings/${g.code}/period`).set(auth(h)).send({ start: '2026-10-01', end: 'oops' })).body).toEqual({
      period: { start: '2026-10-01', end: null },
    });
    expect((await request(app).get(`/api/meetings/${g.code}`).set(auth(h))).body.period).toEqual({ start: '2026-10-01', end: null });
    expect((await request(app).patch(`/api/meetings/${g.code}/period`).set(auth(h)).send({})).body).toEqual({ period: null });
    expect((await request(app).get(`/api/meetings/${g.code}`).set(auth(h))).body.period).toBeNull();
  }, 20_000);
});

describe('채팅 히스토리 (GET /api/meetings/:code/messages)', () => {
  it('안읽음 경계(last_read 초과 + 남의 것만), file JSON 파싱(손상 행 생존), 채널 404', async () => {
    const a = await register(app, 'mld6_a');
    const b = await register(app, 'mld6_b');
    const g = await createMeeting(app, a, 'mld6');
    await joinMeeting(app, b, g.code);
    const m1 = say(g.id, b.id, 'm1');
    say(g.id, a.id, 'm2'); // 내 메시지
    say(g.id, b.id, 'm3');
    say(g.id, b.id, 'm4', JSON.stringify({ name: 'a.txt', url: '/f/a.txt' }));
    say(g.id, b.id, 'm5', '{{corrupt');
    db.prepare(
      `INSERT INTO chat_reads (user_id, meeting_id, last_read) VALUES (?, ?, ?)
       ON CONFLICT(user_id, meeting_id) DO UPDATE SET last_read = excluded.last_read`,
    ).run(a.id, g.id, m1);

    const r = await request(app).get(`/api/meetings/${g.code}/messages`).set(auth(a));
    expect(r.status).toBe(200);
    const rows = r.body as { id: number; from: string; text: string; channelId: number; ts: number; unread?: boolean; file?: unknown }[];
    expect(rows.map((x) => x.text)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']); // 오래된 것부터
    const defaultId = (
      (await request(app).get(`/api/meetings/${g.code}/channels`).set(auth(a))).body as { id: number; isDefault: boolean }[]
    ).find((c) => c.isDefault)!.id;
    const bAvatar = (db.prepare('SELECT avatar FROM users WHERE id = ?').get(b.id) as { avatar: string | null }).avatar;
    expect(rows[0]).toEqual({ id: m1, from: 'mld6_b', avatar: bAvatar, text: 'm1', channelId: defaultId, ts: expect.any(Number) });
    expect(rows[0].unread).toBeUndefined(); // id == last_read → 읽음
    expect(rows[1].unread).toBeUndefined(); // 내 메시지
    expect(rows[2].unread).toBe(true);
    expect(rows[3].file).toEqual({ name: 'a.txt', url: '/f/a.txt' });
    expect(rows[4].file).toBeUndefined(); // 손상 행이 전체를 죽이지 않는다
    expect(Math.abs(rows[0].ts - Date.now())).toBeLessThan(60_000); // created_at+'Z' UTC 해석

    const badCh = await request(app).get(`/api/meetings/${g.code}/messages?channel=999999`).set(auth(a));
    expect(badCh.status).toBe(404);
    expect(badCh.body).toEqual({ error: '존재하지 않는 채널이에요' });
    expect((await request(app).get('/api/meetings/NOPE05/messages').set(auth(a))).body).toEqual({ error: '존재하지 않는 회의입니다' });
  }, 20_000);
});
