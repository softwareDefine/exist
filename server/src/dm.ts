import { Router } from 'express';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { isMember } from './orgs.js';
import { emitToUser } from './notify.js';

/*
 * 조직별 1:1 다이렉트 메시지(DM).
 * 같은 조직의 active 멤버끼리만 대화할 수 있고, 대화방은 조직(org_id) 단위로 분리된다.
 * 실시간 전달은 emitToUser('dm:message') — 보내는 사람의 다른 탭도 함께 동기화.
 */

const router = Router();
router.use(requireAuth);

/** path의 orgId를 검증하고 내가 active 멤버인지 확인. 아니면 res 응답 후 null 반환 */
function requireOrgMember(req: AuthedRequest, res: import('express').Response): number | null {
  const orgId = Number(req.params.orgId);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ error: '잘못된 조직입니다' });
    return null;
  }
  if (!isMember(orgId, req.userId!)) {
    res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    return null;
  }
  return orgId;
}

/** 대화 목록 — 조직의 다른 active 멤버 전원 + (있으면) 마지막 메시지·안읽음 수.
 *  메시지가 오간 상대는 최근순으로, 나머지는 이름순으로 정렬. */
router.get('/:orgId/threads', (req: AuthedRequest, res) => {
  const orgId = requireOrgMember(req, res);
  if (orgId == null) return;
  const me = req.userId!;

  const members = db
    .prepare(
      `SELECT u.id AS user_id, u.username, u.avatar, om.position, om.department
       FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ? AND om.status = 'active' AND u.id != ?`,
    )
    .all(orgId, me) as {
    user_id: number;
    username: string;
    avatar: string | null;
    position: string | null;
    department: string | null;
  }[];

  // 상대별 마지막 메시지 id
  const lastIds = db
    .prepare(
      `SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS partner, MAX(id) AS last_id
       FROM dm_messages
       WHERE org_id = ? AND (from_id = ? OR to_id = ?)
       GROUP BY partner`,
    )
    .all(me, orgId, me, me) as { partner: number; last_id: number }[];

  const lastById = new Map<number, { text: string; ts: number; fromId: number }>();
  for (const { partner, last_id } of lastIds) {
    const m = db
      .prepare('SELECT text, from_id, created_at FROM dm_messages WHERE id = ?')
      .get(last_id) as { text: string; from_id: number; created_at: string } | undefined;
    if (m) {
      lastById.set(partner, {
        text: m.text,
        ts: new Date(m.created_at + 'Z').getTime(),
        fromId: m.from_id,
      });
    }
  }

  // 상대별 안읽음(나에게 온, 안읽은) 수
  const unreadRows = db
    .prepare(
      `SELECT from_id AS partner, COUNT(*) AS n
       FROM dm_messages
       WHERE org_id = ? AND to_id = ? AND read = 0
       GROUP BY from_id`,
    )
    .all(orgId, me) as { partner: number; n: number }[];
  const unreadById = new Map(unreadRows.map((r) => [r.partner, r.n]));

  const threads = members.map((m) => {
    const last = lastById.get(m.user_id);
    return {
      userId: m.user_id,
      username: m.username,
      avatar: m.avatar,
      position: m.position,
      department: m.department,
      lastText: last?.text ?? null,
      lastTs: last?.ts ?? null,
      lastMine: last ? last.fromId === me : false,
      unread: unreadById.get(m.user_id) ?? 0,
    };
  });

  // 대화 있는 상대 먼저(최근순), 없는 상대는 이름순
  threads.sort((a, b) => {
    if (a.lastTs && b.lastTs) return b.lastTs - a.lastTs;
    if (a.lastTs) return -1;
    if (b.lastTs) return 1;
    return a.username.localeCompare(b.username, 'ko');
  });

  res.json(threads);
});

/** 조직 전체 DM 안읽음 수 — 대시보드 배지용 */
router.get('/:orgId/unread', (req: AuthedRequest, res) => {
  const orgId = requireOrgMember(req, res);
  if (orgId == null) return;
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE org_id = ? AND to_id = ? AND read = 0')
    .get(orgId, req.userId!) as { n: number };
  res.json({ unread: row.n });
});

/** 특정 상대와의 대화 히스토리(최근 200개) — 가져오면서 그 상대가 보낸 메시지는 읽음 처리 */
router.get('/:orgId/with/:userId', (req: AuthedRequest, res) => {
  const orgId = requireOrgMember(req, res);
  if (orgId == null) return;
  const me = req.userId!;
  const peer = Number(req.params.userId);
  if (!Number.isInteger(peer)) return res.status(400).json({ error: '잘못된 상대입니다' });
  if (!isMember(orgId, peer)) return res.status(404).json({ error: '상대를 찾을 수 없어요' });

  const rows = db
    .prepare(
      `SELECT m.id, m.from_id, m.to_id, m.text, m.created_at, u.username, u.avatar
       FROM dm_messages m JOIN users u ON u.id = m.from_id
       WHERE m.org_id = ?
         AND ((m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?))
       ORDER BY m.id DESC LIMIT 200`,
    )
    .all(orgId, me, peer, peer, me) as {
    id: number;
    from_id: number;
    to_id: number;
    text: string;
    created_at: string;
    username: string;
    avatar: string | null;
  }[];

  // 상대가 보낸 메시지 읽음 처리
  db.prepare(
    'UPDATE dm_messages SET read = 1 WHERE org_id = ? AND from_id = ? AND to_id = ? AND read = 0',
  ).run(orgId, peer, me);

  res.json(
    rows.reverse().map((r) => ({
      id: r.id,
      fromId: r.from_id,
      from: r.username,
      avatar: r.avatar,
      mine: r.from_id === me,
      text: r.text,
      ts: new Date(r.created_at + 'Z').getTime(),
    })),
  );
});

/** 특정 상대가 보낸 메시지를 읽음 처리 — 대화창이 열려 있을 때 실시간 수신분 정리용 */
router.post('/:orgId/with/:userId/read', (req: AuthedRequest, res) => {
  const orgId = requireOrgMember(req, res);
  if (orgId == null) return;
  const peer = Number(req.params.userId);
  if (!Number.isInteger(peer)) return res.status(400).json({ error: '잘못된 상대입니다' });
  db.prepare(
    'UPDATE dm_messages SET read = 1 WHERE org_id = ? AND from_id = ? AND to_id = ? AND read = 0',
  ).run(orgId, peer, req.userId!);
  res.json({ ok: true });
});

/** 메시지 전송 — 저장 후 받는 사람·보낸 사람 모든 소켓에 dm:message 푸시 */
router.post('/:orgId/with/:userId', (req: AuthedRequest, res) => {
  const orgId = requireOrgMember(req, res);
  if (orgId == null) return;
  const me = req.userId!;
  const peer = Number(req.params.userId);
  if (!Number.isInteger(peer) || peer === me) {
    return res.status(400).json({ error: '잘못된 상대입니다' });
  }
  if (!isMember(orgId, peer)) return res.status(404).json({ error: '상대를 찾을 수 없어요' });

  const text = String(req.body?.text ?? '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: '메시지를 입력하세요' });

  const info = db
    .prepare('INSERT INTO dm_messages (org_id, from_id, to_id, text) VALUES (?, ?, ?, ?)')
    .run(orgId, me, peer, text);
  const id = info.lastInsertRowid as number;
  const ts = Date.now();
  const myAvatar = (
    db.prepare('SELECT avatar FROM users WHERE id = ?').get(me) as { avatar: string | null }
  )?.avatar;

  const payload = {
    id,
    orgId,
    fromId: me,
    toId: peer,
    from: req.username,
    avatar: myAvatar ?? null,
    text,
    ts,
  };
  // 받는 사람 + 보낸 사람의 다른 탭 모두 동기화
  emitToUser(peer, 'dm:message', payload);
  emitToUser(me, 'dm:message', payload);

  res.json(payload);
});

export default router;
