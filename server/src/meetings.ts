import { Router } from 'express';
import crypto from 'node:crypto';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { invalidateBrief } from './agent.js';
import { getRoomSize } from './sfu.js';
import { isMember } from './orgs.js';
import { byPositionDesc } from './positions.js';

const router = Router();
router.use(requireAuth);

// 모든 변경 요청 후 AI 브리핑 캐시 무효화
router.use((req: AuthedRequest, _res, next) => {
  if (req.method !== 'GET') invalidateBrief(req.userId!);
  next();
});

/** 6자리 회의 코드 생성 (예: "X4K9PQ") */
function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

router.post('/', (req: AuthedRequest, res) => {
  const { title, starts_at, ends_at } = req.body ?? {};
  if (!title) return res.status(400).json({ error: '회의 이름을 입력하세요' });

  // org_id가 주어지면 해당 조직의 active 멤버만 회의를 만들 수 있다 (null = 개인 회의)
  const orgId = req.body?.org_id != null ? Number(req.body.org_id) : null;
  if (orgId != null) {
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, req.userId!)) {
      return res.status(403).json({ error: '이 조직의 멤버만 회의를 만들 수 있어요' });
    }
  }

  let code = generateCode();
  while (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code)) code = generateCode();

  const info = db
    .prepare(
      'INSERT INTO meetings (code, title, host_id, org_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(code, title, req.userId, orgId, starts_at ?? null, ends_at ?? null);
  db.prepare('INSERT INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)').run(
    info.lastInsertRowid,
    req.userId,
  );
  res.json({ id: info.lastInsertRowid, code, title, org_id: orgId });
});

/** 코드로 회의 참여 */
router.post('/join', (req: AuthedRequest, res) => {
  const { code } = req.body ?? {};
  const meeting = db.prepare('SELECT * FROM meetings WHERE code = ?').get((code ?? '').toUpperCase()) as
    | { id: number; code: string; title: string }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의 코드입니다' });

  db.prepare(
    'INSERT OR IGNORE INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)',
  ).run(meeting.id, req.userId);
  res.json({ id: meeting.id, code: meeting.code, title: meeting.title });
});

/** 최근 회의 목록 — 조직 컨텍스트로 필터
 *  ?org=<id>  : 그 조직의 회의   ?org=personal : 개인(조직 없는) 회의   생략: 전부 */
router.get('/recent', (req: AuthedRequest, res) => {
  const orgParam = req.query.org;
  let where = 'mp.user_id = ?';
  const params: (number | string)[] = [req.userId!];

  if (orgParam === 'personal') {
    where += ' AND m.org_id IS NULL';
  } else if (orgParam != null && orgParam !== '') {
    const orgId = Number(orgParam);
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, req.userId!)) {
      return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    }
    where += ' AND m.org_id = ?';
    params.push(orgId);
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.org_id, m.starts_at, m.ends_at, mp.joined_at FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE ${where} ORDER BY mp.joined_at DESC LIMIT 7`,
    )
    .all(...params);
  res.json(rows);
});

/** 회의 상세 (허브 탭용) — 제목/일정/호스트/현재 통화 인원 */
router.get('/:code', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.starts_at, m.ends_at, m.host_id, m.org_id,
              u.username AS host, o.name AS org_name
       FROM meetings m JOIN users u ON u.id = m.host_id
       LEFT JOIN organizations o ON o.id = m.org_id
       WHERE m.code = ?`,
    )
    .get(String(req.params.code ?? '').toUpperCase()) as
    | {
        id: number;
        code: string;
        title: string;
        starts_at: string | null;
        ends_at: string | null;
        host_id: number;
        org_id: number | null;
        host: string;
        org_name: string | null;
      }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });

  // 조직 회의면 그 조직 기준 직급·부서를 함께 (개인 회의면 null)
  const participants = db
    .prepare(
      `SELECT u.username, u.avatar, om.role, om.position, om.department
       FROM meeting_participants mp
       JOIN users u ON u.id = mp.user_id
       LEFT JOIN organization_members om
         ON om.user_id = u.id AND om.org_id = ? AND om.status = 'active'
       WHERE mp.meeting_id = ? ORDER BY mp.joined_at`,
    )
    .all(meeting.org_id, meeting.id) as {
    username: string;
    avatar: string | null;
    role: string | null;
    position: string | null;
    department: string | null;
  }[];

  // 조직 회의는 부서→직급순 정렬
  if (meeting.org_id != null) {
    participants.sort((a, b) => {
      const dep = (a.department ?? 'zzz').localeCompare(b.department ?? 'zzz', 'ko');
      if (dep !== 0) return dep;
      return byPositionDesc(a, b);
    });
  }

  res.json({
    id: meeting.id,
    code: meeting.code,
    title: meeting.title,
    starts_at: meeting.starts_at,
    ends_at: meeting.ends_at,
    host: meeting.host,
    isHost: meeting.host_id === req.userId,
    orgId: meeting.org_id,
    orgName: meeting.org_name,
    online: getRoomSize(meeting.code),
    participants: participants.map((p) => ({
      username: p.username,
      avatar: p.avatar,
      role: p.role,
      position: p.position,
      department: p.department,
    })),
  });
});

/** 회의 수정 (호스트만) — 제목/시작/종료 */
router.patch('/:code', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  if (meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '호스트만 수정할 수 있어요' });
  }
  const { title, starts_at, ends_at } = req.body ?? {};
  if (title !== undefined && !String(title).trim()) {
    return res.status(400).json({ error: '회의 이름을 입력하세요' });
  }
  db.prepare(
    `UPDATE meetings SET
       title = COALESCE(?, title),
       starts_at = ?,
       ends_at = ?
     WHERE id = ?`,
  ).run(title ?? null, starts_at ?? null, ends_at ?? null, meeting.id);
  res.json({ ok: true });
});

/** 회의 삭제 (호스트만) — 참가 기록/채팅도 함께 */
router.delete('/:code', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  if (meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '호스트만 삭제할 수 있어요' });
  }
  db.prepare('DELETE FROM messages WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM meeting_participants WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM meetings WHERE id = ?').run(meeting.id);
  res.json({ ok: true });
});

/** 회의 채팅 히스토리 (최근 100개) */
router.get('/:code/messages', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });

  const rows = db
    .prepare(
      `SELECT u.username AS "from", m.text, m.created_at FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.meeting_id = ? ORDER BY m.id DESC LIMIT 100`,
    )
    .all(meeting.id) as { from: string; text: string; created_at: string }[];

  res.json(
    rows.reverse().map((r) => ({ from: r.from, text: r.text, ts: new Date(r.created_at + 'Z').getTime() })),
  );
});

export default router;
