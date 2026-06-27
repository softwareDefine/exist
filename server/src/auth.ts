import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 아바타 이미지는 워크스페이스와 같은 업로드 디렉토리에 저장 (서빙도 그쪽 재사용)
const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_AVATAR = 5 * 1024 * 1024;

export interface AuthedRequest extends Request {
  userId?: number;
  username?: string;
}

export function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** 복구 코드 생성 — "XXXX-XXXX-XXXX-XXXX" (혼동 문자 제외) */
export function generateRecoveryCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () =>
    Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `${group()}-${group()}-${group()}-${group()}`;
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
  const recoveryCode = generateRecoveryCode();
  const recoverySalt = crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare(
      'INSERT INTO users (username, pw_hash, pw_salt, recovery_hash, recovery_salt) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      username,
      hashPassword(password, salt),
      salt,
      hashPassword(recoveryCode, recoverySalt),
      recoverySalt,
    );

  const token = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, info.lastInsertRowid);
  // recoveryCode는 이 응답에서 단 한 번만 노출 — 서버는 해시만 보관
  res.json({ token, user: { id: info.lastInsertRowid, username }, recoveryCode });
});

/** 비밀번호 재설정 — 아이디 + 복구 코드 검증 후 새 비밀번호 + 새 복구 코드 발급 */
router.post('/reset', (req, res) => {
  const { username, recoveryCode, newPassword } = req.body ?? {};
  const key = `reset:${req.ip}:${username ?? ''}`;
  if (rateLimited(key)) {
    return res.status(429).json({ error: '시도가 너무 많습니다. 15분 뒤에 다시 해보세요' });
  }
  if (!username || !recoveryCode || !newPassword) {
    return res.status(400).json({ error: '모든 항목을 입력하세요' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | {
        id: number;
        recovery_hash: string | null;
        recovery_salt: string | null;
      }
    | undefined;
  if (!user || !user.recovery_hash || !user.recovery_salt) {
    return res.status(401).json({ error: '아이디 또는 복구 코드가 올바르지 않습니다' });
  }
  const normalized = String(recoveryCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const grouped = normalized.match(/.{1,4}/g)?.join('-') ?? '';
  if (hashPassword(grouped, user.recovery_salt) !== user.recovery_hash) {
    return res.status(401).json({ error: '아이디 또는 복구 코드가 올바르지 않습니다' });
  }

  // 새 비밀번호 + 새 복구 코드 (기존 코드는 1회용)
  const salt = crypto.randomBytes(16).toString('hex');
  const newCode = generateRecoveryCode();
  const newRecoverySalt = crypto.randomBytes(16).toString('hex');
  db.prepare(
    'UPDATE users SET pw_hash = ?, pw_salt = ?, recovery_hash = ?, recovery_salt = ? WHERE id = ?',
  ).run(
    hashPassword(newPassword, salt),
    salt,
    hashPassword(newCode, newRecoverySalt),
    newRecoverySalt,
    user.id,
  );
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // 기존 세션 전부 무효화
  attempts.delete(key);

  const token = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  res.json({ token, user: { id: user.id, username }, recoveryCode: newCode });
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

/** 내 정보 */
router.get('/me', requireAuth, (req: AuthedRequest, res) => {
  const me = db
    .prepare('SELECT id, username, avatar FROM users WHERE id = ?')
    .get(req.userId) as { id: number; username: string; avatar: string };
  res.json(me);
});

/** 프로필 수정 — 아바타 이모지 */
router.patch('/me', requireAuth, (req: AuthedRequest, res) => {
  const { avatar } = req.body ?? {};
  if (typeof avatar !== 'string' || avatar.length === 0 || avatar.length > 8) {
    return res.status(400).json({ error: '올바르지 않은 아바타입니다' });
  }
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.userId);
  res.json({ ok: true });
});

/** 프로필 사진 업로드 — 이미지 raw body, 저장 후 avatar에 URL 설정 (최대 5MB) */
router.post('/avatar', requireAuth, (req: AuthedRequest, res) => {
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.startsWith('image/')) {
    return res.status(400).json({ error: '이미지 파일만 올릴 수 있어요' });
  }
  const ext = ct.split('/')[1]?.replace(/[^\w]/g, '').slice(0, 5) || 'png';
  const filename = `avatar-${crypto.randomUUID()}.${ext}`;
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_AVATAR) {
      res.status(413).json({ error: '사진이 너무 커요 (최대 5MB)' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    if (size === 0) return res.status(400).json({ error: '빈 파일이에요' });
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.concat(chunks));
    const url = `/api/workspaces/uploads/${filename}`;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, req.userId);
    res.json({ avatar: url });
  });
});

/** 비밀번호 변경 — 현재 비밀번호 확인 후 */
router.post('/password', requireAuth, (req: AuthedRequest, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: '모든 항목을 입력하세요' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: '새 비밀번호는 8자 이상이어야 합니다' });
  }
  const user = db.prepare('SELECT pw_hash, pw_salt FROM users WHERE id = ?').get(req.userId) as {
    pw_hash: string;
    pw_salt: string;
  };
  if (hashPassword(currentPassword, user.pw_salt) !== user.pw_hash) {
    return res.status(401).json({ error: '현재 비밀번호가 올바르지 않습니다' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').run(
    hashPassword(newPassword, salt),
    salt,
    req.userId,
  );
  // 현재 세션 외 전부 무효화
  const token = req.headers.authorization!.replace(/^Bearer /, '');
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.userId, token);
  res.json({ ok: true });
});

export default router;
