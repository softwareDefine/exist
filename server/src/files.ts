import { Router } from 'express';
import db from './db.js';
import type { AuthedRequest } from './auth.js';
import { ydocExists, deleteYdoc } from './ydoc.js';

/*
 * 공동편집 파일시스템 — 그룹 안에서 코드/문서/시트/발표 파일을 여러 개 만들고 폴더로 정리.
 * 각 파일은 Yjs 룸 하나(file-{id}). 그룹당 하나였던 레거시 문서(code-CODE 등)는
 * .bin이 존재하면 첫 조회 때 파일로 자동 흡수된다 (기존 내용 보존).
 * meetings 라우터에 /:code/files 로 마운트 (mergeParams).
 */

export type FileType = 'folder' | 'code' | 'doc' | 'sheet' | 'slide';
const FILE_TYPES: FileType[] = ['folder', 'code', 'doc', 'sheet', 'slide'];
const MAX_FILES = 100;
const MAX_DEPTH = 5;

interface FileRow {
  id: number;
  parent_id: number | null;
  name: string;
  type: FileType;
  room: string | null;
  created_by: number;
}

/** 레거시 흡수 — 그룹당 1개였던 시절의 문서(.bin 존재)를 파일로 등록 */
const LEGACY: { name: string; type: FileType; prefix: string }[] = [
  { name: '코드', type: 'code', prefix: 'code-' },
  { name: '문서', type: 'doc', prefix: 'doc-' },
  { name: '시트', type: 'sheet', prefix: 'sheet-' },
  { name: '발표', type: 'slide', prefix: 'slide-' },
];

export function ensureLegacyFiles(meetingId: number, meetingCode: string, userId: number) {
  const has = db
    .prepare('SELECT 1 FROM collab_files WHERE meeting_id = ? LIMIT 1')
    .get(meetingId);
  if (has) return;
  for (const l of LEGACY) {
    const room = `${l.prefix}${meetingCode.toUpperCase()}`;
    if (!ydocExists(room)) continue;
    db.prepare(
      'INSERT INTO collab_files (meeting_id, parent_id, name, type, room, created_by) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(meetingId, l.name, l.type, room, userId);
  }
}

/** 회의 삭제 시 파일·Yjs 상태 정리 (meetings.ts DELETE에서 호출) */
export function deleteMeetingFiles(meetingId: number, meetingCode: string) {
  const rows = db
    .prepare('SELECT room FROM collab_files WHERE meeting_id = ? AND room IS NOT NULL')
    .all(meetingId) as { room: string }[];
  for (const r of rows) deleteYdoc(r.room);
  // 레거시 룸도 정리 (파일로 흡수 안 된 상태로 남았을 수 있음)
  for (const l of LEGACY) deleteYdoc(`${l.prefix}${meetingCode.toUpperCase()}`);
  deleteYdoc(`mt-${meetingCode.toUpperCase()}`); // 캔버스
  db.prepare('DELETE FROM collab_files WHERE meeting_id = ?').run(meetingId);
}

function cleanName(v: unknown): string | null {
  const name = String(v ?? '')
    .trim()
    .replace(/[/\\]/g, '')
    .slice(0, 60);
  return name.length >= 1 ? name : null;
}

function depthOf(meetingId: number, parentId: number | null): number {
  let depth = 0;
  let cur = parentId;
  while (cur != null && depth <= MAX_DEPTH) {
    const row = db
      .prepare('SELECT parent_id FROM collab_files WHERE id = ? AND meeting_id = ?')
      .get(cur, meetingId) as { parent_id: number | null } | undefined;
    if (!row) return -1; // 다른 회의의 폴더거나 없음
    depth++;
    cur = row.parent_id;
  }
  return depth;
}

interface MeetingRef {
  id: number;
  code: string;
  host_id: number;
}

/** 참가자 검증 (meetings.ts와 동일 패턴 — 순환 import 방지 위해 자체 보유) */
function checkParticipant(
  code: unknown,
  userId: number,
): { ok: false; status: 403 | 404; error: string } | { ok: true; meeting: MeetingRef } {
  const meeting = db
    .prepare('SELECT id, code, host_id FROM meetings WHERE code = ?')
    .get(String(code ?? '').toUpperCase()) as MeetingRef | undefined;
  if (!meeting) return { ok: false, status: 404, error: '존재하지 않는 회의입니다' };
  const isParticipant = db
    .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
    .get(meeting.id, userId);
  if (!isParticipant) return { ok: false, status: 403, error: '회의 참가자만 쓸 수 있어요' };
  return { ok: true, meeting };
}

const router = Router({ mergeParams: true });

/** 파일 목록 (평면 배열 — 클라가 parent_id로 트리 구성) */
router.get('/', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  ensureLegacyFiles(r.meeting.id, r.meeting.code, req.userId!);
  const rows = db
    .prepare(
      `SELECT f.id, f.parent_id, f.name, f.type, f.room, u.username AS author
       FROM collab_files f JOIN users u ON u.id = f.created_by
       WHERE f.meeting_id = ? ORDER BY f.type = 'folder' DESC, f.name`,
    )
    .all(r.meeting.id);
  res.json(rows);
});

/** 파일/폴더 생성 — 참가자 누구나 */
router.post('/', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: '이름을 입력하세요' });
  const type = req.body?.type as FileType;
  if (!FILE_TYPES.includes(type)) return res.status(400).json({ error: '잘못된 종류예요' });

  const parentId = req.body?.parent_id != null ? Number(req.body.parent_id) : null;
  if (parentId != null) {
    const parent = db
      .prepare('SELECT type FROM collab_files WHERE id = ? AND meeting_id = ?')
      .get(parentId, r.meeting.id) as { type: string } | undefined;
    if (!parent || parent.type !== 'folder')
      return res.status(400).json({ error: '폴더 안에만 만들 수 있어요' });
    const depth = depthOf(r.meeting.id, parentId);
    if (depth < 0 || depth >= MAX_DEPTH)
      return res.status(400).json({ error: `폴더는 ${MAX_DEPTH}단계까지예요` });
  }

  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM collab_files WHERE meeting_id = ?').get(r.meeting.id) as {
      n: number;
    }
  ).n;
  if (count >= MAX_FILES) return res.status(400).json({ error: `파일은 그룹당 ${MAX_FILES}개까지예요` });

  const dup = db
    .prepare(
      'SELECT 1 FROM collab_files WHERE meeting_id = ? AND name = ? AND parent_id IS ?',
    )
    .get(r.meeting.id, name, parentId);
  if (dup) return res.status(409).json({ error: '같은 위치에 같은 이름이 있어요' });

  ensureLegacyFiles(r.meeting.id, r.meeting.code, req.userId!);
  const info = db
    .prepare(
      'INSERT INTO collab_files (meeting_id, parent_id, name, type, created_by) VALUES (?, ?, ?, ?, ?)',
    )
    .run(r.meeting.id, parentId, name, type, req.userId!);
  const id = info.lastInsertRowid as number;
  let room: string | null = null;
  if (type !== 'folder') {
    room = `file-${id}`;
    db.prepare('UPDATE collab_files SET room = ? WHERE id = ?').run(room, id);
  }
  res.json({ id, parent_id: parentId, name, type, room });
});

/** 이름 변경 — 호스트나 만든 사람 */
router.patch('/:fileId', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const f = db
    .prepare('SELECT id, parent_id, created_by FROM collab_files WHERE id = ? AND meeting_id = ?')
    .get(req.params.fileId, r.meeting.id) as FileRow | undefined;
  if (!f) return res.status(404).json({ error: '존재하지 않는 파일이에요' });
  if (f.created_by !== req.userId && r.meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '호스트나 만든 사람만 바꿀 수 있어요' });
  }
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: '이름을 입력하세요' });
  const dup = db
    .prepare(
      'SELECT 1 FROM collab_files WHERE meeting_id = ? AND name = ? AND parent_id IS ? AND id != ?',
    )
    .get(r.meeting.id, name, f.parent_id, f.id);
  if (dup) return res.status(409).json({ error: '같은 위치에 같은 이름이 있어요' });
  db.prepare('UPDATE collab_files SET name = ? WHERE id = ?').run(name, f.id);
  res.json({ id: f.id, name });
});

/** 삭제 — 호스트나 만든 사람. 폴더는 하위까지 재귀 삭제, Yjs 상태도 제거 */
router.delete('/:fileId', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const f = db
    .prepare('SELECT id, created_by FROM collab_files WHERE id = ? AND meeting_id = ?')
    .get(req.params.fileId, r.meeting.id) as FileRow | undefined;
  if (!f) return res.status(404).json({ error: '존재하지 않는 파일이에요' });
  if (f.created_by !== req.userId && r.meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '호스트나 만든 사람만 삭제할 수 있어요' });
  }

  // 재귀 수집 (BFS) 후 일괄 삭제
  const toDelete: number[] = [f.id];
  const queue = [f.id];
  while (queue.length) {
    const cur = queue.shift()!;
    const children = db
      .prepare('SELECT id FROM collab_files WHERE parent_id = ?')
      .all(cur) as { id: number }[];
    for (const c of children) {
      toDelete.push(c.id);
      queue.push(c.id);
    }
  }
  const ph = toDelete.map(() => '?').join(',');
  const rooms = db
    .prepare(`SELECT room FROM collab_files WHERE id IN (${ph}) AND room IS NOT NULL`)
    .all(...toDelete) as { room: string }[];
  for (const row of rooms) deleteYdoc(row.room);
  db.prepare(`DELETE FROM collab_files WHERE id IN (${ph})`).run(...toDelete);
  res.json({ ok: true, deleted: toDelete.length });
});

export default router;
