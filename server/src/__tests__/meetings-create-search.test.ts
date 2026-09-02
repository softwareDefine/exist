import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';
import { initNotifier } from '../notify.js';
import { register, auth, createMeeting, joinMeeting, createOrg, joinOrg, notifications, fakeIo } from './helpers/fixtures.js';

/*
 * meetings.ts 생성·참여·사용자 검색 — POST /, POST /join, GET /users/search.
 * 스윕으로만 실행되던 라우트를 응답 본문·DB 상태까지 검증한다 (mutation 대응).
 */
const app = createApp();

describe('회의 생성 (POST /api/meetings)', () => {
  it('제목 필수·trim, 문자열 아닌 일시는 null, 잘못된 recur는 none, 코드 형식, 생성자 참가자 등록', async () => {
    const u = await register(app, 'mcs1_host');
    expect((await request(app).post('/api/meetings').set(auth(u)).send({})).status).toBe(400);
    expect((await request(app).post('/api/meetings').set(auth(u)).send({ title: '   ' })).body).toEqual({ error: '회의 이름을 입력하세요' });
    expect((await request(app).post('/api/meetings').set(auth(u)).send({ title: 42 })).status).toBe(400);

    const r = await request(app)
      .post('/api/meetings')
      .set(auth(u))
      .send({ title: '  주간회의  ', starts_at: 123, ends_at: { x: 1 }, recur: 'yearly', recur_until: '2026-12-31' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      id: expect.any(Number),
      code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/), // I·O·0·1 없는 32자 알파벳
      title: '주간회의',
      org_id: null,
      invited: [],
    });
    const row = db
      .prepare('SELECT title, starts_at, ends_at, recur, recur_until, host_id FROM meetings WHERE id = ?')
      .get(r.body.id) as Record<string, unknown>;
    expect(row).toEqual({ title: '주간회의', starts_at: null, ends_at: null, recur: 'none', recur_until: null, host_id: u.id });
    expect(db.prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?').get(r.body.id, u.id)).toBeTruthy();
    // 문자열 일시는 그대로 저장 + recur_until은 recur 있어야 저장
    const r2 = await request(app)
      .post('/api/meetings')
      .set(auth(u))
      .send({ title: '반복', starts_at: '2026-10-01T10:00', ends_at: '2026-10-01T11:00', recur: 'weekly', recur_until: '2026-12-31' });
    expect(db.prepare('SELECT starts_at, ends_at, recur, recur_until FROM meetings WHERE id = ?').get(r2.body.id)).toEqual({
      starts_at: '2026-10-01T10:00',
      ends_at: '2026-10-01T11:00',
      recur: 'weekly',
      recur_until: '2026-12-31',
    });
  }, 20_000);

  it('생성 시 초대 — 초대자 즉시 참가자 추가 + 알림·소켓, 빈값/유령/본인은 스킵', async () => {
    const host = await register(app, 'mcs2_host');
    const invitee = await register(app, 'mcs2_a');
    const io = fakeIo([host.id, invitee.id]);
    initNotifier(io.io as never);
    const r = await request(app)
      .post('/api/meetings')
      .set(auth(host))
      .send({ title: '초대 회의', invite: [' mcs2_a ', '', 'mcs2_ghost', 42, 'mcs2_host'] });
    expect(r.status).toBe(200);
    expect(r.body.invited).toEqual(['mcs2_a']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_participants WHERE meeting_id = ?').get(r.body.id)).toEqual({ n: 2 });
    expect(db.prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?').get(r.body.id, invitee.id)).toBeTruthy();
    expect(notifications(invitee.id).at(-1)).toEqual({
      from_name: 'mcs2_host',
      text: `'초대 회의' 회의에 초대했어요. (코드 ${r.body.code})`,
      kind: null,
      meeting_code: r.body.code,
    });
    expect(io.of(invitee.id, 'meeting:invited').map((e) => e.payload)).toEqual([{ code: r.body.code, title: '초대 회의' }]);
    expect(io.of(invitee.id, 'inbox:changed')).toHaveLength(1);
    expect(io.of(host.id, 'inbox:changed')).toHaveLength(1); // 생성자 본인의 목록 갱신 신호
    expect(notifications(host.id)).toHaveLength(0); // 본인 초대 알림 없음
  }, 20_000);

  it('조직 회의 초대는 그 조직 active 멤버만 — 비멤버는 조용히 스킵', async () => {
    const owner = await register(app, 'mcs3_owner');
    const inOrg = await register(app, 'mcs3_in');
    const outOrg = await register(app, 'mcs3_out');
    const org = await createOrg(app, owner, 'mcs3 조직');
    await joinOrg(app, org, owner, inOrg);
    const r = await request(app)
      .post('/api/meetings')
      .set(auth(owner))
      .send({ title: '조직 회의', org_id: org.id, invite: ['mcs3_in', 'mcs3_out'] });
    expect(r.status).toBe(200);
    expect(r.body.org_id).toBe(org.id);
    expect(r.body.invited).toEqual(['mcs3_in']);
    expect(db.prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?').get(r.body.id, outOrg.id)).toBeUndefined();
    expect(notifications(outOrg.id)).toHaveLength(0);
  }, 20_000);
});

describe('회의 참여 (POST /api/meetings/join)', () => {
  it('없는 코드 404, 소문자 코드 허용, 재참여 멱등, 잠금은 새 사람만 차단, 손상 settings는 잠금 없음', async () => {
    const host = await register(app, 'mcs4_host');
    const member = await register(app, 'mcs4_member');
    const late = await register(app, 'mcs4_late');
    const late2 = await register(app, 'mcs4_late2');
    const m = await createMeeting(app, host, 'mcs4 그룹');

    expect((await request(app).post('/api/meetings/join').set(auth(member)).send({ code: 'NOPE99' })).status).toBe(404);
    expect((await request(app).post('/api/meetings/join').set(auth(member)).send({})).body).toEqual({ error: '존재하지 않는 회의 코드입니다' });

    const io = fakeIo([host.id, member.id, late.id]);
    initNotifier(io.io as never);
    const j = await request(app).post('/api/meetings/join').set(auth(member)).send({ code: m.code.toLowerCase() });
    expect(j.status).toBe(200);
    expect(j.body).toEqual({ id: m.id, code: m.code, title: 'mcs4 그룹' });
    expect(io.of(member.id, 'inbox:changed')).toHaveLength(1);
    // 재참여 — 멱등, inbox:changed 재발신 없음
    expect((await request(app).post('/api/meetings/join').set(auth(member)).send({ code: m.code })).status).toBe(200);
    expect(io.of(member.id, 'inbox:changed')).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_participants WHERE meeting_id = ? AND user_id = ?').get(m.id, member.id)).toEqual({ n: 1 });

    // 입장 잠금 — 새 사람 403, 기존 참가자는 재입장 허용
    expect((await request(app).patch(`/api/meetings/${m.code}/settings`).set(auth(host)).send({ locked: true })).status).toBe(200);
    const blocked = await request(app).post('/api/meetings/join').set(auth(late)).send({ code: m.code });
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({ error: '입장이 잠긴 그룹이에요 — 호스트에게 요청하세요' });
    expect(db.prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?').get(m.id, late.id)).toBeUndefined();
    expect((await request(app).post('/api/meetings/join').set(auth(member)).send({ code: m.code })).status).toBe(200);

    // 손상 settings — 잠금 없음으로 취급하고 입장 허용
    db.prepare('UPDATE meetings SET settings = ? WHERE id = ?').run('broken{', m.id);
    expect((await request(app).post('/api/meetings/join').set(auth(late2)).send({ code: m.code })).status).toBe(200);
    expect(db.prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?').get(m.id, late2.id)).toBeTruthy();
  }, 20_000);
});

describe('사용자 검색 (GET /api/meetings/users/search)', () => {
  it('빈 q는 [], 정확일치→접두→부분 순서, 본인 제외, 최대 8명', async () => {
    const me = await register(app, 'mcs5_me');
    const zq1 = await register(app, 'zq1');
    await register(app, 'zq1a');
    await register(app, 'azq1');
    expect((await request(app).get('/api/meetings/users/search').set(auth(me))).body).toEqual([]);
    expect((await request(app).get('/api/meetings/users/search?q=%20').set(auth(me))).body).toEqual([]);
    const r = await request(app).get('/api/meetings/users/search?q=zq1').set(auth(me));
    expect(r.status).toBe(200);
    expect((r.body as { username: string; avatar: string | null }[]).map((u) => u.username)).toEqual(['zq1', 'zq1a', 'azq1']);
    const zqAvatar = (db.prepare('SELECT avatar FROM users WHERE id = ?').get(zq1.id) as { avatar: string | null }).avatar;
    expect(r.body[0]).toEqual({ username: 'zq1', avatar: zqAvatar });
    // 본인 제외
    const rSelf = await request(app).get('/api/meetings/users/search?q=zq1').set(auth(zq1));
    expect((rSelf.body as { username: string }[]).map((u) => u.username)).toEqual(['zq1a', 'azq1']);
    // 최대 8
    for (let i = 0; i < 9; i++) await register(app, `lm8x${i}`);
    expect((await request(app).get('/api/meetings/users/search?q=lm8x').set(auth(me))).body).toHaveLength(8);
  }, 30_000);

  it('?org= 는 그 조직 active 멤버만, pending 제외 — org=personal·미지정은 전체', async () => {
    const owner = await register(app, 'mcs6_owner');
    const inOrg = await register(app, 'og5in');
    const pend = await register(app, 'og5pend');
    await register(app, 'og5out');
    const org = await createOrg(app, owner, 'mcs6 조직');
    await joinOrg(app, org, owner, inOrg);
    // 가입 신청만 (pending)
    expect((await request(app).post('/api/orgs/join').set(auth(pend)).send({ joinCode: org.joinCode })).status).toBe(200);

    const inR = await request(app).get(`/api/meetings/users/search?q=og5&org=${org.id}`).set(auth(owner));
    expect((inR.body as { username: string }[]).map((u) => u.username)).toEqual(['og5in']);
    const allR = await request(app).get('/api/meetings/users/search?q=og5').set(auth(owner));
    expect((allR.body as { username: string }[]).map((u) => u.username)).toEqual(['og5in', 'og5out', 'og5pend']);
    const perR = await request(app).get('/api/meetings/users/search?q=og5&org=personal').set(auth(owner));
    expect((perR.body as { username: string }[]).map((u) => u.username)).toEqual(['og5in', 'og5out', 'og5pend']);
  }, 20_000);
});

describe('참여용 헬퍼', () => {
  it('joinMeeting 픽스처가 실제 참가자 행을 만든다 (다른 테스트 전제 확인)', async () => {
    const host = await register(app, 'mcs7_host');
    const member = await register(app, 'mcs7_member');
    const m = await createMeeting(app, host, 'mcs7');
    await joinMeeting(app, member, m.code);
    expect(db.prepare('SELECT COUNT(*) AS n FROM meeting_participants WHERE meeting_id = ?').get(m.id)).toEqual({ n: 2 });
  }, 20_000);
});
