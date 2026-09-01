import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';

/*
 * 조직 그룹 거버넌스 — OG-01 ~ OG-07
 * 그룹 생성 권한제 (owner/admin 또는 group:create 역할) + 관리자 전체 그룹 조회.
 */

const app = createApp();

let owner = '';
let plain = ''; // 아무 권한 없는 일반 멤버
let mid = ''; // group:create 역할을 받을 중간관리자
let ownerId = 0;
let plainId = 0;
let midId = 0;
let orgId = 0;

async function register(username: string) {
  const r = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'password123' });
  return { token: r.body.token as string, id: r.body.user.id as number };
}

const auth = (t: string) => `Bearer ${t}`;
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/; // 회의 코드 — 혼동 문자 제외 6자

const meetingRow = (title: string) =>
  db.prepare('SELECT id, code, host_id, org_id FROM meetings WHERE title = ?').get(title) as
    | { id: number; code: string; host_id: number; org_id: number | null }
    | undefined;
const participantIds = (meetingId: number) =>
  (db.prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ? ORDER BY user_id').all(meetingId) as { user_id: number }[]).map((r) => r.user_id);
const auditRows = () =>
  db.prepare('SELECT action, actor_id, target_id, text FROM org_audit WHERE org_id = ? ORDER BY id').all(orgId) as {
    action: string;
    actor_id: number;
    target_id: number | null;
    text: string;
  }[];
const notifsOf = (userId: number) =>
  db.prepare('SELECT from_name, text, kind FROM notifications WHERE user_id = ? ORDER BY id').all(userId) as {
    from_name: string;
    text: string;
    kind: string | null;
  }[];

beforeAll(async () => {
  const o = await register('og_owner');
  owner = o.token;
  ownerId = o.id;
  const p = await register('og_plain');
  plain = p.token;
  plainId = p.id;
  const m = await register('og_mid');
  mid = m.token;
  midId = m.id;

  // 조직 생성 + 두 명 가입/승인
  const org = await request(app)
    .post('/api/orgs')
    .set('Authorization', auth(owner))
    .send({ name: '거버넌스 테스트 조직' });
  orgId = org.body.id;
  const joinCode = org.body.joinCode as string;
  for (const [t, id] of [
    [plain, plainId],
    [mid, midId],
  ] as const) {
    await request(app)
      .post('/api/orgs/join')
      .set('Authorization', auth(t))
      .send({ joinCode });
    await request(app)
      .post(`/api/orgs/${orgId}/members/${id}/approve`)
      .set('Authorization', auth(owner))
      .send({});
  }
});

describe('조직 그룹 생성 권한제', () => {
  it('OG-01 아무 권한 없는 멤버는 조직 그룹 생성 불가 (403)', async () => {
    const r = await request(app)
      .post('/api/meetings')
      .set('Authorization', auth(plain))
      .send({ title: '몰래 만든 그룹', org_id: orgId });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: '조직에 그룹을 만들 권한이 없어요 — 관리자에게 요청하세요' });
    expect(meetingRow('몰래 만든 그룹')).toBeUndefined();
    // 조직 멤버조차 아니면 문구가 다르다 (멤버십 검사가 권한 검사보다 앞)
    const stranger = await register('og_stranger');
    const s = await request(app)
      .post('/api/meetings')
      .set('Authorization', auth(stranger.token))
      .send({ title: '외부인 그룹', org_id: orgId });
    expect(s.status).toBe(403);
    expect(s.body).toEqual({ error: '이 조직의 멤버만 회의를 만들 수 있어요' });
    expect((await request(app).post('/api/meetings').set('Authorization', auth(plain)).send({ title: 'x', org_id: 'abc' })).status).toBe(400);
  });

  it('OG-02 개인 그룹(org_id 없음)은 누구나 생성 가능', async () => {
    const r = await request(app)
      .post('/api/meetings')
      .set('Authorization', auth(plain))
      .send({ title: '개인 그룹' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      id: expect.any(Number),
      code: expect.stringMatching(CODE_RE),
      title: '개인 그룹',
      org_id: null,
      invited: [],
    });
    const row = meetingRow('개인 그룹')!;
    expect(row).toEqual({ id: r.body.id, code: r.body.code, host_id: plainId, org_id: null });
    expect(participantIds(row.id)).toEqual([plainId]); // 만든 사람은 자동 참가
  });

  it('OG-03 owner는 조직 그룹 생성 가능', async () => {
    const r = await request(app)
      .post('/api/meetings')
      .set('Authorization', auth(owner))
      .send({ title: '운영 그룹', org_id: orgId });
    expect(r.status).toBe(200);
    expect(r.body.org_id).toBe(orgId);
    expect(r.body).toMatchObject({ title: '운영 그룹', code: expect.stringMatching(CODE_RE), invited: [] });
    expect(meetingRow('운영 그룹')).toEqual({ id: r.body.id, code: r.body.code, host_id: ownerId, org_id: orgId });
    expect(participantIds(r.body.id)).toEqual([ownerId]);
  });

  it('OG-04 group:create 역할을 받으면 생성 가능해진다', async () => {
    // 역할 부여 전 — 중간관리자도 아직은 403
    const before = await request(app)
      .post('/api/meetings')
      .set('Authorization', auth(mid))
      .send({ title: '너무 이른 그룹', org_id: orgId });
    expect(before.status).toBe(403);

    const role = await request(app)
      .post(`/api/orgs/${orgId}/roles`)
      .set('Authorization', auth(owner))
      .send({ name: '그룹장', perms: ['group:create', 'not:a-perm'] });
    expect(role.status).toBe(200);
    expect(role.body).toEqual({ id: expect.any(Number), name: '그룹장', perms: ['group:create'] }); // 모르는 권한은 걸러짐
    // 역할 생성은 소유자만 — 일반 멤버 403
    expect(
      (await request(app).post(`/api/orgs/${orgId}/roles`).set('Authorization', auth(plain)).send({ name: 'x', perms: ['group:create'] })).status,
    ).toBe(403);

    const assign = await request(app)
      .patch(`/api/orgs/${orgId}/members/${midId}`)
      .set('Authorization', auth(owner))
      .send({ roleId: role.body.id });
    expect(assign.status).toBe(200);
    expect(assign.body).toEqual({ ok: true });
    expect(
      db.prepare('SELECT role, role_id FROM organization_members WHERE org_id = ? AND user_id = ?').get(orgId, midId),
    ).toEqual({ role: 'member', role_id: role.body.id });
    // 감사 로그 2건 + 당사자 알림 1건 (어떤 권한이 생겼는지까지)
    expect(auditRows().slice(-2)).toEqual([
      { action: 'role.create', actor_id: ownerId, target_id: null, text: '역할 "그룹장" 생성 (group:create)' },
      { action: 'member.assign_role', actor_id: ownerId, target_id: midId, text: 'og_mid님에게 역할 "그룹장" 부여' },
    ]);
    expect(notifsOf(midId).slice(-1)).toEqual([
      { from_name: '거버넌스 테스트 조직', text: '"그룹장" 역할을 받았어요 — 부서 안에서 그룹 생성 권한이 생겼어요', kind: 'org-role' },
    ]);

    const r = await request(app)
      .post('/api/meetings')
      .set('Authorization', auth(mid))
      .send({ title: '중간관리자 그룹', org_id: orgId });
    expect(r.status).toBe(200);
    expect(meetingRow('중간관리자 그룹')).toEqual({ id: r.body.id, code: r.body.code, host_id: midId, org_id: orgId });
    expect(meetingRow('너무 이른 그룹')).toBeUndefined();
  });

  it('OG-05 조직 목록의 canCreateGroup이 권한을 반영한다', async () => {
    const forPlain = await request(app).get('/api/orgs').set('Authorization', auth(plain));
    expect(forPlain.body.find((o: { id: number }) => o.id === orgId).canCreateGroup).toBe(false);
    const forMid = await request(app).get('/api/orgs').set('Authorization', auth(mid));
    expect(forMid.body.find((o: { id: number }) => o.id === orgId).canCreateGroup).toBe(true);
    // 역할 보유자는 여전히 관리자가 아니다 — pendingCount 는 관리자에게만 노출
    expect(forMid.body.find((o: { id: number }) => o.id === orgId)).toEqual({
      id: orgId,
      name: '거버넌스 테스트 조직',
      joinCode: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
      role: 'member',
      isManager: false,
      myTier: null,
      canCreateGroup: true,
      memberCount: 3,
      pendingCount: 0,
    });
    const forOwner = await request(app).get('/api/orgs').set('Authorization', auth(owner));
    expect(forOwner.body.find((o: { id: number }) => o.id === orgId)).toMatchObject({
      role: 'owner',
      isManager: true,
      canCreateGroup: true,
      memberCount: 3,
    });
    // 역할을 해제하면 다시 false
    await request(app).patch(`/api/orgs/${orgId}/members/${midId}`).set('Authorization', auth(owner)).send({ roleId: null });
    const after = await request(app).get('/api/orgs').set('Authorization', auth(mid));
    expect(after.body.find((o: { id: number }) => o.id === orgId).canCreateGroup).toBe(false);
    expect(notifsOf(midId).slice(-1)[0]).toEqual({
      from_name: '거버넌스 테스트 조직',
      text: '역할이 해제됐어요 — 일반 멤버로 돌아갑니다',
      kind: 'org-role',
    });
    expect((await request(app).post('/api/meetings').set('Authorization', auth(mid)).send({ title: '해제 후', org_id: orgId })).status).toBe(403);
  });
});

describe('관리자 전체 그룹 조회', () => {
  it('OG-06 관리자는 참가 안 한 그룹까지 전부 본다', async () => {
    const r = await request(app)
      .get(`/api/orgs/${orgId}/groups`)
      .set('Authorization', auth(owner));
    expect(r.status).toBe(200);
    const titles = r.body.map((g: { title: string }) => g.title);
    expect(titles).toContain('운영 그룹');
    expect(titles).toContain('중간관리자 그룹'); // owner가 참가하지 않은 그룹
    expect(titles).not.toContain('개인 그룹'); // org_id 없는 개인 그룹은 조직 목록에 안 섞인다
    expect(r.body).toHaveLength(2);
    const midGroup = r.body.find((g: { title: string }) => g.title === '중간관리자 그룹');
    expect(midGroup.joined).toBe(false);
    expect(midGroup.host).toBe('og_mid');
    expect(midGroup).toEqual({
      id: meetingRow('중간관리자 그룹')!.id,
      code: meetingRow('중간관리자 그룹')!.code,
      title: '중간관리자 그룹',
      thumbnail: null,
      host: 'og_mid',
      hostDept: null,
      participantCount: 1,
      joined: false,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    });
    const own = r.body.find((g: { title: string }) => g.title === '운영 그룹');
    expect(own).toMatchObject({ host: 'og_owner', joined: true, participantCount: 1 });
    // 참가자가 늘면 participantCount 반영
    await request(app).post('/api/meetings/join').set('Authorization', auth(plain)).send({ code: own.code });
    const again = await request(app).get(`/api/orgs/${orgId}/groups`).set('Authorization', auth(owner));
    expect(again.body.find((g: { title: string }) => g.title === '운영 그룹').participantCount).toBe(2);
  });

  it('OG-07 일반 멤버는 전체 그룹 조회 불가 (403)', async () => {
    const r = await request(app)
      .get(`/api/orgs/${orgId}/groups`)
      .set('Authorization', auth(plain));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: '전체 그룹은 관리자만 볼 수 있어요' });
    // group:create 역할이 있어도 조회는 관리자 전용
    expect((await request(app).get(`/api/orgs/${orgId}/groups`).set('Authorization', auth(mid))).status).toBe(403);
    // admin 으로 승격하면 볼 수 있다
    const promote = await request(app).patch(`/api/orgs/${orgId}/members/${plainId}`).set('Authorization', auth(owner)).send({ role: 'admin' });
    expect(promote.status).toBe(200);
    const asAdmin = await request(app).get(`/api/orgs/${orgId}/groups`).set('Authorization', auth(plain));
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body).toHaveLength(2);
    expect(auditRows().slice(-1)).toEqual([
      { action: 'member.set_role', actor_id: ownerId, target_id: plainId, text: 'og_plain님을 관리자로 지정' },
    ]);
  });
});
