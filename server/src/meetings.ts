import { Router } from 'express';
import crypto from 'node:crypto';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { invalidateBrief } from './agent.js';

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

  let code = generateCode();
  while (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code)) code = generateCode();

  const info = db
    .prepare('INSERT INTO meetings (code, title, host_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)')
    .run(code, title, req.userId, starts_at ?? null, ends_at ?? null);
  db.prepare('INSERT INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)').run(
    info.lastInsertRowid,
    req.userId,
  );
  res.json({ id: info.lastInsertRowid, code, title });
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

/** 최근 회의 목록 */
router.get('/recent', (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.starts_at, m.ends_at, mp.joined_at FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE mp.user_id = ? ORDER BY mp.joined_at DESC LIMIT 7`,
    )
    .all(req.userId);
  res.json(rows);
});

export default router;
