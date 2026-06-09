import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { invalidateBrief } from './agent.js';
import { emitToUser, notifyUser } from './notify.js';
import { getRoomSize } from './sfu.js';
import { isMember } from './orgs.js';
import { byPositionDesc } from './positions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_THUMB = 5 * 1024 * 1024;

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

type Recur = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly';
const RECURS: Recur[] = ['none', 'daily', 'weekly', 'biweekly', 'monthly'];
function cleanRecur(v: unknown): Recur {
  return RECURS.includes(v as Recur) ? (v as Recur) : 'none';
}
function cleanDate(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

const pad = (n: number) => String(n).padStart(2, '0');
function toLocalISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function stepDate(d: Date, recur: Recur): Date {
  const n = new Date(d);
  if (recur === 'daily') n.setDate(n.getDate() + 1);
  else if (recur === 'weekly') n.setDate(n.getDate() + 7);
  else if (recur === 'biweekly') n.setDate(n.getDate() + 14);
  else if (recur === 'monthly') n.setMonth(n.getMonth() + 1);
  return n;
}

/** 반복 회의를 달력에 표시할 개별 occurrence(시작/종료)들로 펼친다.
 *  창: [now-31일, min(recur_until, now+90일)], 최대 120개 */
function expandOccurrences(
  startsAt: string | null,
  endsAt: string | null,
  recur: Recur,
  recurUntil: string | null,
  now: Date,
): { starts_at: string; ends_at: string | null }[] {
  if (!startsAt) return [];
  const base = new Date(startsAt);
  if (isNaN(base.getTime())) return [];
  if (recur === 'none') return [{ starts_at: startsAt, ends_at: endsAt }];

  const dur = endsAt ? new Date(endsAt).getTime() - base.getTime() : 0;
  const horizon = new Date(now.getTime() + 90 * 24 * 3600_000);
  const until = recurUntil ? new Date(recurUntil + 'T23:59:59') : null;
  const end = until && until < horizon ? until : horizon;
  const lower = new Date(now.getTime() - 31 * 24 * 3600_000);

  const out: { starts_at: string; ends_at: string | null }[] = [];
  let cur = new Date(base);
  for (let guard = 0; guard < 500 && cur <= end; guard++) {
    if (cur >= lower) {
      out.push({
        starts_at: toLocalISO(cur),
        ends_at: dur ? toLocalISO(new Date(cur.getTime() + dur)) : null,
      });
      if (out.length >= 120) break;
    }
    cur = stepDate(cur, recur);
  }
  return out;
}

router.post('/', (req: AuthedRequest, res) => {
  const { title, starts_at, ends_at } = req.body ?? {};
  if (!title) return res.status(400).json({ error: '회의 이름을 입력하세요' });
  const recur = cleanRecur(req.body?.recur);
  const recurUntil = recur === 'none' ? null : cleanDate(req.body?.recur_until);

  // org_id가 주어지면 해당 조직의 active 멤버만 회의를 만들 수 있다 (null = 개인 회의)
  const orgId = req.body?.org_id != null ? Number(req.body.org_id) : null;
  if (orgId != null) {
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, req.userId!)) {
      return res.status(403).json({ error: '이 조직의 멤버만 회의를 만들 수 있어요' });
    }
  }

  let code = generateCode();
  while (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code)) code = generateCode();

  const info = db
    .prepare(
      'INSERT INTO meetings (code, title, host_id, org_id, starts_at, ends_at, recur, recur_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(code, title, req.userId, orgId, starts_at ?? null, ends_at ?? null, recur, recurUntil);
  const meetingId = info.lastInsertRowid as number;
  db.prepare('INSERT INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)').run(
    meetingId,
    req.userId,
  );

  // 초대한 사람들 바로 참가자로 추가 + 알림
  const invited: string[] = [];
  const list = Array.isArray(req.body?.invite) ? req.body.invite : [];
  const me = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId) as
    | { username: string }
    | undefined;
  for (const raw of list.slice(0, 30)) {
    const uname = String(raw ?? '').trim();
    if (!uname) continue;
    const u = db.prepare('SELECT id, username FROM users WHERE username = ?').get(uname) as
      | { id: number; username: string }
      | undefined;
    if (!u || u.id === req.userId) continue;
    // 조직 회의는 그 조직의 active 멤버만 초대 가능
    if (orgId != null && !isMember(orgId, u.id)) continue;
    db.prepare(
      'INSERT OR IGNORE INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)',
    ).run(meetingId, u.id);
    invited.push(u.username);
    emitToUser(u.id, 'meeting:invited', { code, title });
    notifyUser(u.id, {
      from: me?.username ?? '누군가',
      text: `'${title}' 회의에 초대했어요. (코드 ${code})`,
      meetingCode: code,
    });
  }

  res.json({ id: meetingId, code, title, org_id: orgId, invited });
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

/** 사용자 검색 — 회의에 초대할 사람 찾기 (username 부분일치, 본인 제외)
 *  ?org=<id> 가 주어지면 그 조직의 active 멤버만 검색 (개인 회의는 전체 사용자) */
router.get('/users/search', (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json([]);

  const orgParam = req.query.org;
  let rows: { username: string; avatar: string | null }[];

  if (orgParam != null && orgParam !== '' && orgParam !== 'personal') {
    const orgId = Number(orgParam);
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, req.userId!)) {
      return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    }
    rows = db
      .prepare(
        `SELECT u.username, u.avatar FROM users u
         JOIN organization_members om ON om.user_id = u.id
         WHERE om.org_id = ? AND om.status = 'active' AND u.id != ? AND u.username LIKE ?
         ORDER BY CASE WHEN u.username = ? THEN 0 WHEN u.username LIKE ? THEN 1 ELSE 2 END, u.username
         LIMIT 8`,
      )
      .all(orgId, req.userId, `%${q}%`, q, `${q}%`) as typeof rows;
  } else {
    rows = db
      .prepare(
        `SELECT username, avatar FROM users
         WHERE username LIKE ? AND id != ?
         ORDER BY CASE WHEN username = ? THEN 0 WHEN username LIKE ? THEN 1 ELSE 2 END, username
         LIMIT 8`,
      )
      .all(`%${q}%`, req.userId, q, `${q}%`) as typeof rows;
  }
  res.json(rows);
});

/** 최근 회의 목록 — 조직 컨텍스트로 필터
 *  ?org=<id>  : 그 조직의 회의   ?org=personal : 개인(조직 없는) 회의   생략: 전부 */
router.get('/recent', (req: AuthedRequest, res) => {
  const orgParam = req.query.org;
  let where = 'mp.user_id = ?';
  const params: (number | string)[] = [req.userId!];

  if (orgParam === 'personal') {
    where += ' AND m.org_id IS NULL';
  } else if (orgParam != null && orgParam !== '') {
    const orgId = Number(orgParam);
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, req.userId!)) {
      return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    }
    where += ' AND m.org_id = ?';
    params.push(orgId);
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.org_id, m.thumbnail, m.starts_at, m.ends_at, mp.joined_at FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE ${where} ORDER BY mp.joined_at DESC LIMIT 7`,
    )
    .all(...params);
  res.json(rows);
});

/** 일정용 — 예정/반복 회의를 occurrence 단위로 펼쳐 반환 (달력·nowbar용)
 *  ?org=<id>|personal 로 필터 (recent와 동일 규칙) */
router.get('/schedule', (req: AuthedRequest, res) => {
  const orgParam = req.query.org;
  let where = 'mp.user_id = ? AND m.starts_at IS NOT NULL';
  const params: (number | string)[] = [req.userId!];

  if (orgParam === 'personal') {
    where += ' AND m.org_id IS NULL';
  } else if (orgParam != null && orgParam !== '') {
    const orgId = Number(orgParam);
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, req.userId!)) {
      return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    }
    where += ' AND m.org_id = ?';
    params.push(orgId);
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.org_id, m.thumbnail, m.starts_at, m.ends_at, m.recur, m.recur_until
       FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE ${where}`,
    )
    .all(...params) as {
    id: number;
    code: string;
    title: string;
    org_id: number | null;
    thumbnail: string | null;
    starts_at: string | null;
    ends_at: string | null;
    recur: Recur;
    recur_until: string | null;
  }[];

  const now = new Date();
  const out: unknown[] = [];
  for (const m of rows) {
    const occ = expandOccurrences(m.starts_at, m.ends_at, cleanRecur(m.recur), m.recur_until, now);
    for (const o of occ) {
      out.push({
        id: m.id,
        occId: `${m.id}@${o.starts_at}`,
        code: m.code,
        title: m.title,
        thumbnail: m.thumbnail,
        starts_at: o.starts_at,
        ends_at: o.ends_at,
        recur: m.recur,
      });
    }
  }
  out.sort(
    (a, b) =>
      new Date((a as { starts_at: string }).starts_at).getTime() -
      new Date((b as { starts_at: string }).starts_at).getTime(),
  );
  res.json(out);
});

/** 회의 상세 (허브 탭용) — 제목/일정/호스트/현재 통화 인원 */
router.get('/:code', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.starts_at, m.ends_at, m.host_id, m.org_id, m.thumbnail, m.settings,
              m.period_start, m.period_end, u.username AS host, o.name AS org_name
       FROM meetings m JOIN users u ON u.id = m.host_id
       LEFT JOIN organizations o ON o.id = m.org_id
       WHERE m.code = ?`,
    )
    .get(String(req.params.code ?? '').toUpperCase()) as
    | {
        id: number;
        code: string;
        title: string;
        starts_at: string | null;
        ends_at: string | null;
        host_id: number;
        org_id: number | null;
        thumbnail: string | null;
        settings: string | null;
        period_start: string | null;
        period_end: string | null;
        host: string;
        org_name: string | null;
      }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });

  // 조직 회의면 그 조직 기준 직급·부서를 함께 (개인 회의면 null)
  const participants = db
    .prepare(
      `SELECT u.username, u.avatar, om.role, om.position, om.department
       FROM meeting_participants mp
       JOIN users u ON u.id = mp.user_id
       LEFT JOIN organization_members om
         ON om.user_id = u.id AND om.org_id = ? AND om.status = 'active'
       WHERE mp.meeting_id = ? ORDER BY mp.joined_at`,
    )
    .all(meeting.org_id, meeting.id) as {
    username: string;
    avatar: string | null;
    role: string | null;
    position: string | null;
    department: string | null;
  }[];

  // 조직 회의는 부서→직급순 정렬
  if (meeting.org_id != null) {
    participants.sort((a, b) => {
      const dep = (a.department ?? 'zzz').localeCompare(b.department ?? 'zzz', 'ko');
      if (dep !== 0) return dep;
      return byPositionDesc(a, b);
    });
  }

  res.json({
    id: meeting.id,
    code: meeting.code,
    title: meeting.title,
    starts_at: meeting.starts_at,
    ends_at: meeting.ends_at,
    host: meeting.host,
    isHost: meeting.host_id === req.userId,
    orgId: meeting.org_id,
    orgName: meeting.org_name,
    thumbnail: meeting.thumbnail,
    settings: meeting.settings ? JSON.parse(meeting.settings) : { locked: false, guestEdit: true, muteOnJoin: false },
    period:
      meeting.period_start || meeting.period_end
        ? { start: meeting.period_start, end: meeting.period_end }
        : null,
    online: getRoomSize(meeting.code),
    participants: participants.map((p) => ({
      username: p.username,
      avatar: p.avatar,
      role: p.role,
      position: p.position,
      department: p.department,
      isHost: p.username === meeting.host,
    })),
  });
});

/** 회의 설정/권한 변경 (호스트만) */
router.patch('/:code/settings', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '회의를 찾을 수 없어요' });
  if (meeting.host_id !== req.userId) return res.status(403).json({ error: '호스트만 변경할 수 있어요' });
  const { locked, guestEdit, muteOnJoin } = req.body ?? {};
  const settings = { locked: !!locked, guestEdit: guestEdit !== false, muteOnJoin: !!muteOnJoin };
  db.prepare('UPDATE meetings SET settings = ? WHERE id = ?').run(JSON.stringify(settings), meeting.id);
  res.json({ settings });
});

/** 프로젝트 기간 설정 (호스트만) — start/end는 'YYYY-MM-DD' 또는 null(없음) */
router.patch('/:code/period', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '회의를 찾을 수 없어요' });
  if (meeting.host_id !== req.userId) return res.status(403).json({ error: '호스트만 변경할 수 있어요' });
  const clean = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  const start = clean(req.body?.start);
  const end = clean(req.body?.end);
  db.prepare('UPDATE meetings SET period_start = ?, period_end = ? WHERE id = ?').run(
    start,
    end,
    meeting.id,
  );
  res.json({ period: start || end ? { start, end } : null });
});

/** 참가자 강퇴 (호스트만) */
router.delete('/:code/participants/:username', (req: AuthedRequest, res) => {
  const code = String(req.params.code ?? '').toUpperCase();
  const meeting = db
    .prepare('SELECT id, host_id, title FROM meetings WHERE code = ?')
    .get(code) as { id: number; host_id: number; title: string } | undefined;
  if (!meeting) return res.status(404).json({ error: '회의를 찾을 수 없어요' });
  if (meeting.host_id !== req.userId) return res.status(403).json({ error: '호스트만 강퇴할 수 있어요' });
  const target = db
    .prepare('SELECT id, username FROM users WHERE username = ?')
    .get(String(req.params.username)) as { id: number; username: string } | undefined;
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없어요' });
  if (target.id === meeting.host_id) return res.status(400).json({ error: '호스트는 강퇴할 수 없어요' });
  db.prepare('DELETE FROM meeting_participants WHERE meeting_id = ? AND user_id = ?').run(
    meeting.id,
    target.id,
  );
  emitToUser(target.id, 'meeting:kicked', { code, title: meeting.title });
  notifyUser(target.id, {
    from: meeting.title,
    text: '회의에서 내보내졌어요.',
    meetingCode: code,
  });
  res.json({ ok: true });
});

/** 호스트 위임 (현재 호스트만) */
router.patch('/:code/host', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '회의를 찾을 수 없어요' });
  if (meeting.host_id !== req.userId) return res.status(403).json({ error: '호스트만 위임할 수 있어요' });
  const target = db
    .prepare('SELECT id FROM users WHERE username = ?')
    .get(String(req.body?.username)) as { id: number } | undefined;
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없어요' });
  db.prepare('UPDATE meetings SET host_id = ? WHERE id = ?').run(target.id, meeting.id);
  res.json({ ok: true });
});

/** 회의 수정 (호스트만) — 제목/시작/종료 */
router.patch('/:code', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  if (meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '호스트만 수정할 수 있어요' });
  }
  const { title, starts_at, ends_at } = req.body ?? {};
  if (title !== undefined && !String(title).trim()) {
    return res.status(400).json({ error: '회의 이름을 입력하세요' });
  }
  if (req.body?.recur !== undefined) {
    // 반복 정보까지 함께 갱신 (일정 잡기/수정)
    const recur = cleanRecur(req.body.recur);
    const recurUntil = recur === 'none' ? null : cleanDate(req.body.recur_until);
    db.prepare(
      `UPDATE meetings SET
         title = COALESCE(?, title), starts_at = ?, ends_at = ?, recur = ?, recur_until = ?
       WHERE id = ?`,
    ).run(title ?? null, starts_at ?? null, ends_at ?? null, recur, recurUntil, meeting.id);
  } else {
    db.prepare(
      `UPDATE meetings SET
         title = COALESCE(?, title), starts_at = ?, ends_at = ?
       WHERE id = ?`,
    ).run(title ?? null, starts_at ?? null, ends_at ?? null, meeting.id);
  }
  res.json({ ok: true });
});

/** 회의 사진(썸네일) 업로드 (호스트만) — 이미지 raw body, 최대 5MB */
router.post('/:code/thumbnail', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  if (meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '호스트만 사진을 바꿀 수 있어요' });
  }
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.startsWith('image/')) {
    return res.status(400).json({ error: '이미지 파일만 올릴 수 있어요' });
  }
  const ext = ct.split('/')[1]?.replace(/[^\w]/g, '').slice(0, 5) || 'png';
  const filename = `mthumb-${crypto.randomUUID()}.${ext}`;
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_THUMB) {
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
    db.prepare('UPDATE meetings SET thumbnail = ? WHERE id = ?').run(url, meeting.id);
    res.json({ thumbnail: url });
  });
});

/** 회의 삭제 (호스트만) — 참가 기록/채팅도 함께 */
router.delete('/:code', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  if (meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '호스트만 삭제할 수 있어요' });
  }
  db.prepare('DELETE FROM messages WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM meeting_participants WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM meetings WHERE id = ?').run(meeting.id);
  res.json({ ok: true });
});

/** 회의 일정 이벤트 목록 (참가자 공유) */
router.get('/:code/events', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const rows = db
    .prepare(
      `SELECT e.id, e.title, e.date, e.time, u.username AS author, e.created_by
       FROM meeting_events e JOIN users u ON u.id = e.created_by
       WHERE e.meeting_id = ? ORDER BY e.date, COALESCE(e.time, '99:99')`,
    )
    .all(meeting.id);
  res.json(rows);
});

/** 회의 일정 이벤트 추가 */
router.post('/:code/events', (req: AuthedRequest, res) => {
  const { title, date, time } = req.body ?? {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '일정 제목을 입력하세요' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ error: '날짜를 확인하세요' });
  }
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const t = time && /^\d{2}:\d{2}$/.test(String(time)) ? String(time) : null;
  const info = db
    .prepare(
      'INSERT INTO meeting_events (meeting_id, title, date, time, created_by) VALUES (?, ?, ?, ?, ?)',
    )
    .run(meeting.id, String(title).trim().slice(0, 80), String(date), t, req.userId);
  res.json({ id: info.lastInsertRowid, title, date, time: t });
});

/** 회의 일정 이벤트 삭제 (작성자 또는 호스트) */
router.delete('/:code/events/:eventId', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const ev = db
    .prepare('SELECT created_by FROM meeting_events WHERE id = ? AND meeting_id = ?')
    .get(req.params.eventId, meeting.id) as { created_by: number } | undefined;
  if (!ev) return res.json({ ok: true });
  if (ev.created_by !== req.userId && meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '작성자나 호스트만 삭제할 수 있어요' });
  }
  db.prepare('DELETE FROM meeting_events WHERE id = ?').run(req.params.eventId);
  res.json({ ok: true });
});

/** 회의 채팅 히스토리 (최근 100개) */
router.get('/:code/messages', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });

  const rows = db
    .prepare(
      `SELECT u.username AS "from", u.avatar, m.text, m.file, m.created_at FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.meeting_id = ? ORDER BY m.id DESC LIMIT 100`,
    )
    .all(meeting.id) as {
    from: string;
    avatar: string | null;
    text: string;
    file: string | null;
    created_at: string;
  }[];

  res.json(
    rows.reverse().map((r) => ({
      from: r.from,
      avatar: r.avatar,
      text: r.text,
      file: r.file ? JSON.parse(r.file) : undefined,
      ts: new Date(r.created_at + 'Z').getTime(),
    })),
  );
});

export default router;
