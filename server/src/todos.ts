import { Router } from 'express';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req: AuthedRequest, res) => {
  const rows = db
    .prepare('SELECT id, title, done, due_at FROM todos WHERE user_id = ? ORDER BY created_at')
    .all(req.userId);
  res.json(rows);
});

router.post('/', (req: AuthedRequest, res) => {
  const { title, due_at } = req.body ?? {};
  if (!title) return res.status(400).json({ error: '내용을 입력하세요' });
  const info = db
    .prepare('INSERT INTO todos (user_id, title, due_at) VALUES (?, ?, ?)')
    .run(req.userId, title, due_at ?? null);
  res.json({ id: info.lastInsertRowid, title, done: 0, due_at: due_at ?? null });
});

router.patch('/:id', (req: AuthedRequest, res) => {
  const { done, title } = req.body ?? {};
  const todo = db
    .prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!todo) return res.status(404).json({ error: '없는 투두입니다' });

  if (done !== undefined) {
    db.prepare('UPDATE todos SET done = ? WHERE id = ?').run(done ? 1 : 0, req.params.id);
  }
  if (title !== undefined) {
    db.prepare('UPDATE todos SET title = ? WHERE id = ?').run(title, req.params.id);
  }
  res.json({ ok: true });
});

router.delete('/:id', (req: AuthedRequest, res) => {
  db.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

export default router;
