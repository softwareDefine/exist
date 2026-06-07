import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import db from './db.js';

export interface AuthedRequest extends Request {
  userId?: number;
  username?: string;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** Bearer 토큰 검사 미들웨어 */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });

  const row = db
    .prepare(
      `SELECT s.user_id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(token) as { user_id: number; username: string } | undefined;
  if (!row) return res.status(401).json({ error: '유효하지 않은 세션입니다' });

  req.userId = row.user_id;
  req.username = row.username;
  next();
}

const router = Router();

router.post('/register', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: '이미 존재하는 아이디입니다' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare('INSERT INTO users (username, pw_hash, pw_salt) VALUES (?, ?, ?)')
    .run(username, hashPassword(password, salt), salt);

  const token = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, info.lastInsertRowid);
  res.json({ token, user: { id: info.lastInsertRowid, username } });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | { id: number; username: string; pw_hash: string; pw_salt: string }
    | undefined;
  if (!user || hashPassword(password ?? '', user.pw_salt) !== user.pw_hash) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다' });
  }
  const token = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  res.json({ token, user: { id: user.id, username: user.username } });
});

router.post('/logout', requireAuth, (req: AuthedRequest, res) => {
  const token = req.headers.authorization!.replace(/^Bearer /, '');
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

export default router;
