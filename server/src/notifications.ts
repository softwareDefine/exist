import { Router } from 'express';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';

const router = Router();
router.use(requireAuth);

/** 내 알림 목록(최근 50) + 안읽음 수 */
router.get('/', (req: AuthedRequest, res) => {
  const items = db
    .prepare(
      `SELECT id, from_name AS "from", text, kind, read, created_at
       FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
    )
    .all(req.userId) as {
    id: number;
    from: string;
    text: string;
    kind: string | null;
    read: number;
    created_at: string;
  }[];
  const unread = (
    db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0')
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
      ts: new Date(n.created_at + 'Z').getTime(),
    })),
  });
});

/** 전체 읽음 처리 */
router.post('/read', (req: AuthedRequest, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(req.userId);
  res.json({ ok: true });
});

/** 전체 삭제(비우기) */
router.delete('/', (req: AuthedRequest, res) => {
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(req.userId);
  res.json({ ok: true });
});

export default router;
