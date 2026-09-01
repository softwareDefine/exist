import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';
import { canManageMeeting, isOrgManager, isOrgMember, type GroupAction } from '../perm.js';

/*
 * perm.ts — 그룹(회의) 관리 권한 매트릭스.
 * 호스트 / 조직 owner·admin / 커스텀 역할(부서 스코프 중간관리자) / 일반 멤버 / 외부인 × 액션.
 * canManageMeeting은 meeting 객체({host_id, org_id})만 받으므로 조직·역할 행만 있으면 된다.
 */
const app = createApp();

const ALL_ACTIONS: GroupAction[] = [
  'group:lock', 'group:settings', 'group:edit-info', 'group:edit-period', 'group:schedule',
  'group:kick', 'group:transfer', 'group:delete', 'group:channels', 'group:files', 'group:recap',
];

const U: Record<string, { id: number; token: string }> = {};
let orgId = 0;
let roleId = 0;

async function reg(name: string) {
  const r = await request(app).post('/api/auth/register').send({ username: name, password: 'password123' });
  U[name] = { id: r.body.user.id, token: r.body.token };
}
const auth = (name: string) => ({ Authorization: `Bearer ${U[name].token}` });
function setMember(name: string, patch: { department?: string | null; role_id?: number | null; role?: string; status?: string }) {
  for (const [k, v] of Object.entries(patch)) {
    db.prepare(`UPDATE organization_members SET ${k} = ? WHERE org_id = ? AND user_id = ?`).run(v, orgId, U[name].id);
  }
}

beforeAll(async () => {
  for (const n of ['pm_owner', 'pm_admin', 'pm_mgr', 'pm_host', 'pm_member', 'pm_pending', 'pm_outsider', 'pm_farhost']) await reg(n);
  const org = await request(app).post('/api/orgs').set(auth('pm_owner')).send({ name: '퍼미션 조직' });
  orgId = org.body.id;
  const joinCode = org.body.joinCode as string;
  for (const n of ['pm_admin', 'pm_mgr', 'pm_host', 'pm_member', 'pm_pending', 'pm_farhost']) {
    await request(app).post('/api/orgs/join').set(auth(n)).send({ joinCode });
  }
  for (const [n, department] of [['pm_admin', '경영'], ['pm_mgr', '생산1팀'], ['pm_host', '생산1팀'], ['pm_member', '생산1팀'], ['pm_farhost', '생산2팀']]) {
    const ap = await request(app).post(`/api/orgs/${orgId}/members/${U[n].id}/approve`).set(auth('pm_owner')).send({ department });
    expect(ap.status).toBe(200);
  }
  setMember('pm_admin', { role: 'admin' });
  const role = await request(app).post(`/api/orgs/${orgId}/roles`).set(auth('pm_owner')).send({ name: '조장', perms: ['group:files', 'group:recap', 'member:approve'] });
  roleId = role.body.id;
  const assign = await request(app).patch(`/api/orgs/${orgId}/members/${U.pm_mgr.id}`).set(auth('pm_owner')).send({ roleId });
  expect(assign.status).toBe(200);
});

const orgMeeting = () => ({ host_id: U.pm_host.id, org_id: orgId });

describe('isOrgManager / isOrgMember', () => {
  it('owner·admin(active)만 관리자, org 없음·pending·일반 멤버·외부인은 아님', () => {
    expect(isOrgManager(orgId, U.pm_owner.id)).toBe(true);
    expect(isOrgManager(orgId, U.pm_admin.id)).toBe(true);
    expect(isOrgManager(orgId, U.pm_member.id)).toBe(false);
    expect(isOrgManager(orgId, U.pm_outsider.id)).toBe(false);
    expect(isOrgManager(null, U.pm_owner.id)).toBe(false);
    expect(isOrgManager(undefined, U.pm_owner.id)).toBe(false);
    setMember('pm_admin', { status: 'pending' });
    expect(isOrgManager(orgId, U.pm_admin.id)).toBe(false);
    setMember('pm_admin', { status: 'active' });

    expect(isOrgMember(orgId, U.pm_member.id)).toBe(true);
    expect(isOrgMember(orgId, U.pm_pending.id)).toBe(false);
    expect(isOrgMember(orgId, U.pm_outsider.id)).toBe(false);
  });
});

describe('canManageMeeting — 조직 그룹', () => {
  it('호스트·owner·admin은 모든 액션 OK, 일반 멤버·대기자·외부인은 전부 거부', () => {
    for (const a of [undefined, ...ALL_ACTIONS]) {
      expect(canManageMeeting(orgMeeting(), U.pm_host.id, a)).toBe(true);
      expect(canManageMeeting(orgMeeting(), U.pm_owner.id, a)).toBe(true);
      expect(canManageMeeting(orgMeeting(), U.pm_admin.id, a)).toBe(true);
      expect(canManageMeeting(orgMeeting(), U.pm_member.id, a)).toBe(false);
      expect(canManageMeeting(orgMeeting(), U.pm_pending.id, a)).toBe(false);
      expect(canManageMeeting(orgMeeting(), U.pm_outsider.id, a)).toBe(false);
    }
  });

  it('커스텀 역할(부서 스코프) — 가진 액션만, 호스트가 같은 부서 active일 때만. action 없이 부르면 group:* 하나라도 있으면 OK', () => {
    const m = orgMeeting();
    expect(canManageMeeting(m, U.pm_mgr.id, 'group:files')).toBe(true);
    expect(canManageMeeting(m, U.pm_mgr.id, 'group:recap')).toBe(true);
    expect(canManageMeeting(m, U.pm_mgr.id)).toBe(true);
    for (const a of ALL_ACTIONS.filter((x) => x !== 'group:files' && x !== 'group:recap')) {
      expect(canManageMeeting(m, U.pm_mgr.id, a)).toBe(false);
    }
    // 다른 부서 호스트 / 조직 밖 호스트 / pending 호스트
    expect(canManageMeeting({ host_id: U.pm_farhost.id, org_id: orgId }, U.pm_mgr.id, 'group:files')).toBe(false);
    expect(canManageMeeting({ host_id: U.pm_outsider.id, org_id: orgId }, U.pm_mgr.id, 'group:files')).toBe(false);
    setMember('pm_host', { status: 'pending' });
    expect(canManageMeeting(m, U.pm_mgr.id, 'group:files')).toBe(false);
    setMember('pm_host', { status: 'active' });
  });

  it('중간관리자 자격 결손 — 부서 없음 · 역할 없음 · 역할 삭제됨(dangling) · 본인 pending → 거부', () => {
    const m = orgMeeting();
    setMember('pm_mgr', { department: null });
    expect(canManageMeeting(m, U.pm_mgr.id, 'group:files')).toBe(false);
    setMember('pm_mgr', { department: '생산1팀' });

    setMember('pm_mgr', { role_id: null });
    expect(canManageMeeting(m, U.pm_mgr.id, 'group:files')).toBe(false);
    db.pragma('foreign_keys = OFF'); // 삭제된 역할을 가리키는 dangling role_id 재현
    try {
      setMember('pm_mgr', { role_id: 999_999 });
      expect(canManageMeeting(m, U.pm_mgr.id, 'group:files')).toBe(false);
      setMember('pm_mgr', { role_id: roleId });
    } finally {
      db.pragma('foreign_keys = ON');
    }

    setMember('pm_mgr', { status: 'pending' });
    expect(canManageMeeting(m, U.pm_mgr.id, 'group:files')).toBe(false);
    setMember('pm_mgr', { status: 'active' });
    expect(canManageMeeting(m, U.pm_mgr.id, 'group:files')).toBe(true);
  });

  it('perms 내용 — 구 와일드카드 group:manage는 모든 액션 통과, group:* 없는 역할은 action 없이도 거부, 손상 JSON은 거부', () => {
    const m = orgMeeting();
    const legacy = db.prepare("INSERT INTO org_roles (org_id, name, perms) VALUES (?, '구역할', ?)").run(orgId, JSON.stringify(['group:manage'])).lastInsertRowid as number;
    setMember('pm_mgr', { role_id: legacy });
    for (const a of ALL_ACTIONS) expect(canManageMeeting(m, U.pm_mgr.id, a)).toBe(true);
    expect(canManageMeeting(m, U.pm_mgr.id)).toBe(true);

    const hrOnly = db.prepare("INSERT INTO org_roles (org_id, name, perms) VALUES (?, '인사', ?)").run(orgId, JSON.stringify(['member:approve'])).lastInsertRowid as number;
    setMember('pm_mgr', { role_id: hrOnly });
    expect(canManageMeeting(m, U.pm_mgr.id)).toBe(false);
    expect(canManageMeeting(m, U.pm_mgr.id, 'group:files')).toBe(false);

    const broken = db.prepare("INSERT INTO org_roles (org_id, name, perms) VALUES (?, '손상', 'not json')").run(orgId).lastInsertRowid as number;
    setMember('pm_mgr', { role_id: broken });
    expect(canManageMeeting(m, U.pm_mgr.id, 'group:files')).toBe(false);
    setMember('pm_mgr', { role_id: roleId });
  });
});

describe('canManageMeeting — 개인 그룹(org_id 없음)', () => {
  it('호스트만 — 조직 관리자·중간관리자도 거부', () => {
    for (const org_id of [null, undefined]) {
      const m = { host_id: U.pm_host.id, org_id };
      expect(canManageMeeting(m, U.pm_host.id, 'group:delete')).toBe(true);
      expect(canManageMeeting(m, U.pm_owner.id, 'group:delete')).toBe(false);
      expect(canManageMeeting(m, U.pm_admin.id)).toBe(false);
      expect(canManageMeeting(m, U.pm_mgr.id, 'group:files')).toBe(false);
    }
  });
});
