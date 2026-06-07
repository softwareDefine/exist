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

const SESSION_TTL_DAYS = 30;

/** Bearer 토큰 검사 미들웨어 (30일 만료) */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });

  const row = db
    .prepare(
      `SELECT s.user_id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.created_at > datetime('now', '-${SESSION_TTL_DAYS} days')`,
    )
    .get(token) as { user_id: number; username: string } | undefined;
  if (!row) return res.status(401).json({ error: '세션이 만료됐습니다. 다시 로그인하세요' });

  req.userId = row.user_id;
  req.username = row.username;
  next();
}

const router = Router();

// ── 로그인 무차별 대입 방지: IP+아이디당 15분에 10회 ──
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

router.post('/register', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' });
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: '아이디는 영문·숫자·_ 3~20자입니다' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });
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
  const key = `${req.ip}:${username ?? ''}`;
  if (rateLimited(key)) {
    return res.status(429).json({ error: '시도가 너무 많습니다. 15분 뒤에 다시 해보세요' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | { id: number; username: string; pw_hash: string; pw_salt: string }
    | undefined;
  if (!user || hashPassword(password ?? '', user.pw_salt) !== user.pw_hash) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다' });
  }
  attempts.delete(key); // 성공 시 카운터 리셋
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
