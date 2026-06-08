import { Router } from 'express';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';

const router = Router();
router.use(requireAuth);

interface Row {
  id: number;
  from: string;
  text: string;
  kind: string | null;
  read: number;
  cleared: number;
  created_at: string;
}

/** 내 알림 목록 + 안읽음 수.
 *  기본: 치우지 않은 알림만.  ?all=1: 지난(치운) 알림까지 전부 */
router.get('/', (req: AuthedRequest, res) => {
  const all = req.query.all === '1';
  const items = db
    .prepare(
      `SELECT id, from_name AS "from", text, kind, read, cleared, created_at
       FROM notifications
       WHERE user_id = ?${all ? '' : ' AND cleared = 0'}
       ORDER BY id DESC LIMIT 50`,
    )
    .all(req.userId) as Row[];
  // 안읽음은 항상 "치우지 않은 것" 기준
  const unread = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0 AND cleared = 0",
      )
      .get(req.userId) as { n: number }
  ).n;
  res.json({
    unread,
    items: items.map((n) => ({
      id: n.id,
      from: n.from,
      text: n.text,
      kind: n.kind,
      read: !!n.read,
      cleared: !!n.cleared,
      ts: new Date(n.created_at + 'Z').getTime(),
    })),
  });
});

/** 전체 읽음 처리 */
router.post('/read', (req: AuthedRequest, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(req.userId);
  res.json({ ok: true });
});

/** 치우기(보관) — 목록에서 내리되 지난 알림에는 남김 */
router.post('/clear', (req: AuthedRequest, res) => {
  db.prepare('UPDATE notifications SET cleared = 1, read = 1 WHERE user_id = ? AND cleared = 0').run(
    req.userId,
  );
  res.json({ ok: true });
});

/** 완전 삭제 — 지난 알림까지 영구 비우기 */
router.delete('/', (req: AuthedRequest, res) => {
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(req.userId);
  res.json({ ok: true });
});

export default router;
