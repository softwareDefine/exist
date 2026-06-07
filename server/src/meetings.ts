import { Router } from 'express';
import crypto from 'node:crypto';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { invalidateBrief } from './agent.js';
import { getRoomSize } from './sfu.js';

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

/** 회의 상세 (허브 탭용) — 제목/일정/호스트/현재 통화 인원 */
router.get('/:code', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.starts_at, m.ends_at, m.host_id, u.username AS host
       FROM meetings m JOIN users u ON u.id = m.host_id WHERE m.code = ?`,
    )
    .get(String(req.params.code ?? '').toUpperCase()) as
    | {
        id: number;
        code: string;
        title: string;
        starts_at: string | null;
        ends_at: string | null;
        host_id: number;
        host: string;
      }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });

  const participants = db
    .prepare(
      `SELECT u.username FROM meeting_participants mp
       JOIN users u ON u.id = mp.user_id WHERE mp.meeting_id = ? ORDER BY mp.joined_at`,
    )
    .all(meeting.id) as { username: string }[];

  res.json({
    id: meeting.id,
    code: meeting.code,
    title: meeting.title,
    starts_at: meeting.starts_at,
    ends_at: meeting.ends_at,
    host: meeting.host,
    isHost: meeting.host_id === req.userId,
    online: getRoomSize(meeting.code),
    participants: participants.map((p) => p.username),
  });
});

export default router;
