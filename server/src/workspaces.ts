import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const router = Router();

/** 에셋 서빙 — <img src>는 Authorization 헤더가 없으므로 인증 제외 (UUID 파일명으로 보호) */
router.get('/uploads/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const file = path.join(UPLOAD_DIR, safe);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

router.use(requireAuth);

router.get('/', (_req: AuthedRequest, res) => {
  // MVP: 로그인한 모든 사용자가 모든 작업공간 공유 (팀 단위 분리는 추후)
  const rows = db
    .prepare('SELECT id, name, created_by, created_at FROM workspaces ORDER BY id')
    .all();
  res.json(rows);
});

router.post('/', (req: AuthedRequest, res) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: '작업공간 이름을 입력하세요' });
  const info = db
    .prepare('INSERT INTO workspaces (name, created_by) VALUES (?, ?)')
    .run(name, req.userId);
  res.json({ id: info.lastInsertRowid, name });
});

/** tldraw 캔버스 에셋(이미지 등) 업로드 — 최대 20MB */
const MAX_UPLOAD = 20 * 1024 * 1024;

router.post('/uploads', (req: AuthedRequest, res) => {
  const id = crypto.randomUUID();
  const ext = (req.query.name as string | undefined)?.split('.').pop()?.replace(/[^\w]/g, '') ?? 'bin';
  const filename = `${id}.${ext}`;
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_UPLOAD) {
      res.status(413).json({ error: '파일이 너무 큽니다 (최대 20MB)' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.concat(chunks));
    res.json({ url: `/api/workspaces/uploads/${filename}` });
  });
});

/** 작업공간 이름 변경 */
router.patch('/:id', (req: AuthedRequest, res) => {
  const { name } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: '이름을 입력하세요' });
  const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) return res.status(404).json({ error: '없는 작업공간입니다' });
  db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  res.json({ ok: true });
});

/** 작업공간 삭제 (캔버스 스냅샷은 보존 — 복구 여지) */
router.delete('/:id', (req: AuthedRequest, res) => {
  const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) return res.status(404).json({ error: '없는 작업공간입니다' });
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
