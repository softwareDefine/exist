import { Router } from 'express';
import crypto from 'node:crypto';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';

/*
 * 조직(organization) — 회사·팀 단위.
 * 누구나 조직을 만들 수 있고(생성자=owner), 가입은 가입코드로 신청 → 관리자 승인제.
 * 회의는 조직에 소속될 수도(조직 회의), 소속되지 않을 수도(개인 회의) 있다.
 */

const router = Router();
router.use(requireAuth);

/** 가입코드 — "XXXX-XXXX" (혼동 문자 제외) */
function generateJoinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () =>
    Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `${group()}-${group()}`;
}

interface Membership {
  role: 'owner' | 'admin' | 'member';
  status: 'pending' | 'active';
}

function getMembership(orgId: number, userId: number): Membership | undefined {
  return db
    .prepare('SELECT role, status FROM organization_members WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId) as Membership | undefined;
}

/** active 멤버인가 */
function isMember(orgId: number, userId: number): boolean {
  const m = getMembership(orgId, userId);
  return !!m && m.status === 'active';
}

/** 승인·관리 권한(owner/admin)인가 */
function isManager(orgId: number, userId: number): boolean {
  const m = getMembership(orgId, userId);
  return !!m && m.status === 'active' && (m.role === 'owner' || m.role === 'admin');
}

/** 내가 속한(active) 조직 목록 — 멤버 수, 내 역할, (관리자면) 대기 신청 수 포함 */
router.get('/', (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT o.id, o.name, o.join_code, o.owner_id, om.role,
              (SELECT COUNT(*) FROM organization_members m2
               WHERE m2.org_id = o.id AND m2.status = 'active') AS member_count,
              (SELECT COUNT(*) FROM organization_members m3
               WHERE m3.org_id = o.id AND m3.status = 'pending') AS pending_count
       FROM organizations o
       JOIN organization_members om ON om.org_id = o.id
       WHERE om.user_id = ? AND om.status = 'active'
       ORDER BY o.created_at`,
    )
    .all(req.userId) as {
    id: number;
    name: string;
    join_code: string;
    owner_id: number;
    role: string;
    member_count: number;
    pending_count: number;
  }[];

  res.json(
    rows.map((o) => ({
      id: o.id,
      name: o.name,
      joinCode: o.join_code,
      role: o.role,
      isManager: o.role === 'owner' || o.role === 'admin',
      memberCount: o.member_count,
      // 관리자에게만 대기 신청 수 노출
      pendingCount: o.role === 'owner' || o.role === 'admin' ? o.pending_count : 0,
    })),
  );
});

/** 내가 가입 신청해둔(pending) 조직 — "승인 대기 중" 표시용 */
router.get('/pending', (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT o.id, o.name FROM organizations o
       JOIN organization_members om ON om.org_id = o.id
       WHERE om.user_id = ? AND om.status = 'pending' ORDER BY o.created_at`,
    )
    .all(req.userId) as { id: number; name: string }[];
  res.json(rows);
});

/** 조직 생성 — 생성자는 owner(active) */
router.post('/', (req: AuthedRequest, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: '조직 이름을 입력하세요' });
  if (name.length > 40) return res.status(400).json({ error: '조직 이름은 40자 이내로 입력하세요' });

  let joinCode = generateJoinCode();
  while (db.prepare('SELECT id FROM organizations WHERE join_code = ?').get(joinCode)) {
    joinCode = generateJoinCode();
  }

  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO organizations (name, join_code, owner_id) VALUES (?, ?, ?)')
      .run(name, joinCode, req.userId);
    db.prepare(
      `INSERT INTO organization_members (org_id, user_id, role, status)
       VALUES (?, ?, 'owner', 'active')`,
    ).run(info.lastInsertRowid, req.userId);
    return info.lastInsertRowid as number;
  });
  const id = tx();
  res.json({ id, name, joinCode, role: 'owner', isManager: true, memberCount: 1, pendingCount: 0 });
});

/** 가입 신청 — 가입코드로 pending 등록 */
router.post('/join', (req: AuthedRequest, res) => {
  const raw = String(req.body?.joinCode ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 8) return res.status(400).json({ error: '가입코드를 확인하세요' });
  const joinCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;

  const org = db
    .prepare('SELECT id, name FROM organizations WHERE join_code = ?')
    .get(joinCode) as { id: number; name: string } | undefined;
  if (!org) return res.status(404).json({ error: '존재하지 않는 가입코드입니다' });

  const existing = getMembership(org.id, req.userId!);
  if (existing?.status === 'active') {
    return res.status(409).json({ error: '이미 이 조직의 멤버예요' });
  }
  if (existing?.status === 'pending') {
    return res.status(409).json({ error: '이미 가입 신청을 보냈어요 — 승인을 기다려주세요' });
  }

  db.prepare(
    `INSERT INTO organization_members (org_id, user_id, role, status)
     VALUES (?, ?, 'member', 'pending')`,
  ).run(org.id, req.userId);
  res.json({ ok: true, orgName: org.name, status: 'pending' });
});

/** 조직 상세 — 멤버 목록(+대기 목록은 관리자만), 내 역할 */
router.get('/:id', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  if (!isMember(orgId, req.userId!)) {
    return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
  }
  const org = db
    .prepare('SELECT id, name, join_code, owner_id FROM organizations WHERE id = ?')
    .get(orgId) as { id: number; name: string; join_code: string; owner_id: number } | undefined;
  if (!org) return res.status(404).json({ error: '존재하지 않는 조직입니다' });

  const manager = isManager(orgId, req.userId!);

  const members = db
    .prepare(
      `SELECT u.id AS user_id, u.username, u.avatar, om.role, om.status, om.created_at
       FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ? AND om.status = 'active'
       ORDER BY CASE om.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, om.created_at`,
    )
    .all(orgId) as {
    user_id: number;
    username: string;
    avatar: string;
    role: string;
    status: string;
    created_at: string;
  }[];

  // 대기 신청은 관리자에게만
  const pending = manager
    ? (db
        .prepare(
          `SELECT u.id AS user_id, u.username, u.avatar, om.created_at
           FROM organization_members om JOIN users u ON u.id = om.user_id
           WHERE om.org_id = ? AND om.status = 'pending' ORDER BY om.created_at`,
        )
        .all(orgId) as { user_id: number; username: string; avatar: string; created_at: string }[])
    : [];

  res.json({
    id: org.id,
    name: org.name,
    joinCode: manager ? org.join_code : undefined,
    ownerId: org.owner_id,
    myRole: getMembership(orgId, req.userId!)!.role,
    isManager: manager,
    members: members.map((m) => ({
      userId: m.user_id,
      username: m.username,
      avatar: m.avatar,
      role: m.role,
    })),
    pending: pending.map((p) => ({ userId: p.user_id, username: p.username, avatar: p.avatar })),
  });
});

/** 가입 승인 (관리자) */
router.post('/:id/members/:userId/approve', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  if (!isManager(orgId, req.userId!)) {
    return res.status(403).json({ error: '승인 권한이 없어요' });
  }
  const m = getMembership(orgId, targetId);
  if (!m || m.status !== 'pending') {
    return res.status(404).json({ error: '대기 중인 신청이 아니에요' });
  }
  db.prepare(
    `UPDATE organization_members SET status = 'active' WHERE org_id = ? AND user_id = ?`,
  ).run(orgId, targetId);
  res.json({ ok: true });
});

/** 가입 거절 / 멤버 제거 (관리자) — owner는 제거 불가 */
router.delete('/:id/members/:userId', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  if (!isManager(orgId, req.userId!)) {
    return res.status(403).json({ error: '권한이 없어요' });
  }
  const m = getMembership(orgId, targetId);
  if (!m) return res.status(404).json({ error: '대상을 찾을 수 없어요' });
  if (m.role === 'owner') return res.status(400).json({ error: '소유자는 제거할 수 없어요' });
  db.prepare('DELETE FROM organization_members WHERE org_id = ? AND user_id = ?').run(
    orgId,
    targetId,
  );
  res.json({ ok: true });
});

/** 역할 변경 — 멤버↔관리자 (owner만) */
router.patch('/:id/members/:userId', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const role = String(req.body?.role ?? '');
  if (!['admin', 'member'].includes(role)) {
    return res.status(400).json({ error: '역할은 admin 또는 member여야 해요' });
  }
  const me = getMembership(orgId, req.userId!);
  if (!me || me.status !== 'active' || me.role !== 'owner') {
    return res.status(403).json({ error: '소유자만 역할을 바꿀 수 있어요' });
  }
  const m = getMembership(orgId, targetId);
  if (!m || m.status !== 'active') return res.status(404).json({ error: '활성 멤버가 아니에요' });
  if (m.role === 'owner') return res.status(400).json({ error: '소유자 역할은 바꿀 수 없어요' });
  db.prepare('UPDATE organization_members SET role = ? WHERE org_id = ? AND user_id = ?').run(
    role,
    orgId,
    targetId,
  );
  res.json({ ok: true });
});

export { isMember };
export default router;
