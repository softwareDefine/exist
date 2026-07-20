import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { invalidateBrief } from './agent.js';
import { emitToUser, notifyUser } from './notify.js';
import { getRoomSize, getRoomPeers } from './sfu.js';
import { isMember } from './orgs.js';
import { byPositionDesc } from './positions.js';
import { listRecaps, listDecisions, ackDecision, markNextMeetingRegistered } from './recap.js';
import { listChannels, ensureDefaultChannel, resolveChannel, cleanChannelName } from './channels.js';
import { generateAgenda } from './steward.js';
import filesRouter, { deleteMeetingFiles } from './files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_THUMB = 5 * 1024 * 1024;

const router = Router();
router.use(requireAuth);
// 공동편집 파일시스템 — /:code/files (files.ts, mergeParams)
router.use('/:code/files', filesRouter);

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
  except?: Set<string>,
): { starts_at: string; ends_at: string | null }[] {
  if (!startsAt) return [];
  const base = new Date(startsAt);
  if (isNaN(base.getTime())) return [];
  const ymdOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (recur === 'none') {
    if (except && except.has(ymdOf(base))) return [];
    return [{ starts_at: startsAt, ends_at: endsAt }];
  }

  const dur = endsAt ? new Date(endsAt).getTime() - base.getTime() : 0;
  const horizon = new Date(now.getTime() + 90 * 24 * 3600_000);
  const until = recurUntil ? new Date(recurUntil + 'T23:59:59') : null;
  const end = until && until < horizon ? until : horizon;
  const lower = new Date(now.getTime() - 31 * 24 * 3600_000);

  const out: { starts_at: string; ends_at: string | null }[] = [];
  let cur = new Date(base);
  for (let guard = 0; guard < 500 && cur <= end; guard++) {
    if (cur >= lower && !(except && except.has(ymdOf(cur)))) {
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

/** meetings.recur_except (JSON 배열 텍스트) → 제외 날짜 Set */
function parseExcept(raw: unknown): Set<string> {
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))
      : new Set();
  } catch {
    return new Set();
  }
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

/** 통합 메시지함 — 스코프(조직/개인) 내 내가 참여한 그룹들의 채팅 최근·안읽음 */
router.get('/inbox', (req: AuthedRequest, res) => {
  const me = req.userId!;
  const orgParam = req.query.org;
  let orgFilter = '';
  const orgArgs: number[] = [];
  if (orgParam === 'personal') {
    orgFilter = ' AND m.org_id IS NULL';
  } else if (orgParam != null && orgParam !== '') {
    const orgId = Number(orgParam);
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, me)) return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    orgFilter = ' AND m.org_id = ?';
    orgArgs.push(orgId);
  }
  const rows = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.thumbnail,
         lm.text AS lastText, lm.created_at AS lastTs,
         (SELECT COUNT(*) FROM messages msg
            WHERE msg.meeting_id = m.id
              AND msg.id > COALESCE((SELECT last_read FROM chat_reads WHERE user_id = ? AND meeting_id = m.id), 0)
         ) AS unread
       FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.user_id = ?
       LEFT JOIN (
         SELECT meeting_id, text, created_at FROM messages
         WHERE id IN (SELECT MAX(id) FROM messages GROUP BY meeting_id)
       ) lm ON lm.meeting_id = m.id
       WHERE 1 = 1 ${orgFilter}
       ORDER BY COALESCE(lm.created_at, '') DESC, m.id DESC`,
    )
    .all(me, me, ...orgArgs);
  res.json(rows);
});

/** 그룹 채팅 읽음 처리 — last_read = 그룹 최신 메시지 id */
router.post('/:code/messages/read', (req: AuthedRequest, res) => {
  const me = req.userId!;
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 그룹이에요' });
  const last = db
    .prepare('SELECT MAX(id) AS mx FROM messages WHERE meeting_id = ?')
    .get(meeting.id) as { mx: number | null };
  db.prepare(
    `INSERT INTO chat_reads (user_id, meeting_id, last_read) VALUES (?, ?, ?)
     ON CONFLICT(user_id, meeting_id) DO UPDATE SET last_read = excluded.last_read`,
  ).run(me, meeting.id, last.mx ?? 0);
  res.json({ ok: true });
});

/** 일정용 — 예정/반복 회의를 occurrence 단위로 펼쳐 반환 (달력·nowbar용)
 *  ?org=<id>|personal 로 필터 (recent와 동일 규칙) */
router.get('/schedule', (req: AuthedRequest, res) => {
  const orgParam = req.query.org;
  // 조직 필터 (회의/이벤트 공용)
  let orgFilter = '';
  const orgArgs: number[] = [];
  if (orgParam === 'personal') {
    orgFilter = ' AND m.org_id IS NULL';
  } else if (orgParam != null && orgParam !== '') {
    const orgId = Number(orgParam);
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, req.userId!)) {
      return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    }
    orgFilter = ' AND m.org_id = ?';
    orgArgs.push(orgId);
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.org_id, m.thumbnail, m.starts_at, m.ends_at, m.recur, m.recur_until, m.recur_except
       FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE mp.user_id = ? AND m.starts_at IS NOT NULL${orgFilter}`,
    )
    .all(req.userId!, ...orgArgs) as {
    id: number;
    code: string;
    title: string;
    org_id: number | null;
    thumbnail: string | null;
    starts_at: string | null;
    ends_at: string | null;
    recur: Recur;
    recur_until: string | null;
    recur_except: string | null;
  }[];

  const now = new Date();
  const out: unknown[] = [];
  for (const m of rows) {
    const occ = expandOccurrences(
      m.starts_at,
      m.ends_at,
      cleanRecur(m.recur),
      m.recur_until,
      now,
      parseExcept(m.recur_except),
    );
    for (const o of occ) {
      out.push({
        id: m.id,
        occId: `${m.id}@${o.starts_at}`,
        code: m.code,
        title: m.title,
        meetingTitle: m.title,
        thumbnail: m.thumbnail,
        starts_at: o.starts_at,
        ends_at: o.ends_at,
        recur: m.recur,
      });
    }
  }

  // 회의 안에서 추가한 일정 이벤트(통화 등, 시간 있는 것)도 일정에 포함
  const events = db
    .prepare(
      `SELECT e.id AS eid, e.title AS etitle, e.date, e.time, e.end_time,
              m.id AS mid, m.code, m.title AS mtitle, m.thumbnail
       FROM meeting_events e
       JOIN meetings m ON m.id = e.meeting_id
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE mp.user_id = ? AND e.time IS NOT NULL${orgFilter}`,
    )
    .all(req.userId!, ...orgArgs) as {
    eid: number;
    etitle: string;
    date: string;
    time: string;
    end_time: string | null;
    mid: number;
    code: string;
    mtitle: string;
    thumbnail: string | null;
  }[];
  const lower = now.getTime() - 31 * 24 * 3600_000;
  const upper = now.getTime() + 90 * 24 * 3600_000;
  for (const e of events) {
    const startsAt = `${e.date}T${e.time}`;
    const ts = new Date(startsAt).getTime();
    if (isNaN(ts) || ts < lower || ts > upper) continue;
    out.push({
      id: e.mid,
      occId: `ev${e.eid}`,
      code: e.code,
      title: e.etitle, // 이벤트 제목 (회의 썸네일로 어느 회의인지 표시)
      meetingTitle: e.mtitle, // 그룹명(회의 이름) — nowbar 그룹 구성용
      thumbnail: e.thumbnail,
      starts_at: startsAt,
      ends_at: e.end_time ? `${e.date}T${e.end_time}` : null,
      recur: 'none',
      kind: 'event',
    });
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
      `SELECT m.id, m.code, m.title, m.starts_at, m.ends_at, m.recur, m.recur_until, m.recur_except, m.host_id, m.org_id, m.thumbnail, m.settings,
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
        recur: string | null;
        recur_until: string | null;
        recur_except: string | null;
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
    recur: meeting.recur ?? 'none',
    recur_until: meeting.recur_until,
    recur_except: [...parseExcept(meeting.recur_except)],
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
    callPeers: getRoomPeers(meeting.code),
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
  db.prepare('DELETE FROM meeting_events WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM meeting_recaps WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM chat_reads WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM chat_channels WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM call_transcripts WHERE meeting_id = ?').run(meeting.id);
  deleteMeetingFiles(meeting.id, String(req.params.code).toUpperCase());
  try {
    db.prepare('DELETE FROM todos WHERE meeting_id = ?').run(meeting.id);
  } catch {
    /* todos에 meeting_id 컬럼이 없으면 무시 */
  }
  db.prepare('DELETE FROM meetings WHERE id = ?').run(meeting.id);
  res.json({ ok: true });
});

/** 반복 회의의 특정 회차(날짜) 삭제/복원 — 호스트만.
 *  body: { date: 'YYYY-MM-DD', restore?: boolean } */
router.post('/:code/occurrences/exclude', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id, recur, recur_except FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number; recur: string | null; recur_except: string | null }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  if (meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '호스트만 회차를 삭제할 수 있어요' });
  }
  const date = cleanDate(req.body?.date);
  if (!date) return res.status(400).json({ error: '날짜를 확인하세요' });
  const set = parseExcept(meeting.recur_except);
  if (req.body?.restore) set.delete(date);
  else set.add(date);
  db.prepare('UPDATE meetings SET recur_except = ? WHERE id = ?').run(
    JSON.stringify([...set]),
    meeting.id,
  );
  res.json({ ok: true, recur_except: [...set] });
});

/** 회의 일정 이벤트 목록 (참가자 공유) */
router.get('/:code/events', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const rows = db
    .prepare(
      `SELECT e.id, e.title, e.date, e.time, e.end_time, e.is_call, u.username AS author, e.created_by
       FROM meeting_events e JOIN users u ON u.id = e.created_by
       WHERE e.meeting_id = ? ORDER BY e.date, COALESCE(e.time, '99:99')`,
    )
    .all(meeting.id);
  res.json(rows);
});

/** 회의 일정 이벤트 추가 */
router.post('/:code/events', (req: AuthedRequest, res) => {
  const { title, date, time, end_time, is_call } = req.body ?? {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '일정 제목을 입력하세요' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ error: '날짜를 확인하세요' });
  }
  const code = String(req.params.code ?? '').toUpperCase();
  const meeting = db
    .prepare('SELECT id, title FROM meetings WHERE code = ?')
    .get(code) as { id: number; title: string } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const hhmm = (v: unknown) => (v && /^\d{2}:\d{2}$/.test(String(v)) ? String(v) : null);
  const t = hhmm(time);
  const tEnd = t ? hhmm(end_time) : null; // 시작이 있어야 종료 의미 있음
  if (t && tEnd && tEnd <= t) {
    return res.status(400).json({ error: '종료 시간이 시작보다 빨라요' });
  }
  const isCall = is_call ? 1 : 0;
  const cleanTitle = String(title).trim().slice(0, 80);
  const info = db
    .prepare(
      'INSERT INTO meeting_events (meeting_id, title, date, time, end_time, is_call, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(meeting.id, cleanTitle, String(date), t, tEnd, isCall, req.userId);

  // 회의 참가자 전원(작성자 제외)에게 일정 알림 — 회의 썸네일과 함께
  const me = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId) as
    | { username: string }
    | undefined;
  const others = db
    .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND user_id != ?')
    .all(meeting.id, req.userId) as { user_id: number }[];
  const md = String(date).slice(5).replace('-', '/'); // MM/DD
  const timeStr = t ? (tEnd ? `${t}~${tEnd}` : t) : '';
  const when = timeStr ? `${md} ${timeStr}` : md;
  for (const p of others) {
    notifyUser(p.user_id, {
      from: me?.username ?? meeting.title,
      text: `'${meeting.title}'에 ${isCall ? '통화' : '일정'} 추가 — ${cleanTitle} (${when})`,
      meetingCode: code,
    });
  }

  res.json({ id: info.lastInsertRowid, title, date, time: t, end_time: tEnd, is_call: isCall });
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

/** 회의 일정 이벤트 수정 (작성자 또는 호스트) */
router.patch('/:code/events/:eventId', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const ev = db
    .prepare('SELECT created_by, title, date, time, end_time, is_call FROM meeting_events WHERE id = ? AND meeting_id = ?')
    .get(req.params.eventId, meeting.id) as
    | { created_by: number; title: string; date: string; time: string | null; end_time: string | null; is_call: number }
    | undefined;
  if (!ev) return res.status(404).json({ error: '존재하지 않는 일정입니다' });
  if (ev.created_by !== req.userId && meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '작성자나 호스트만 수정할 수 있어요' });
  }

  const { title, date, time, end_time, is_call } = req.body ?? {};
  const hhmm = (v: unknown) => (v && /^\d{2}:\d{2}$/.test(String(v)) ? String(v) : null);
  const newTitle = title !== undefined ? String(title).trim().slice(0, 80) : ev.title;
  if (!newTitle) return res.status(400).json({ error: '일정 제목을 입력하세요' });
  const newDate =
    date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : ev.date;
  const t = time !== undefined ? hhmm(time) : ev.time;
  const tEnd = t ? (end_time !== undefined ? hhmm(end_time) : ev.end_time) : null;
  if (t && tEnd && tEnd <= t) {
    return res.status(400).json({ error: '종료 시간이 시작보다 빨라요' });
  }
  const isCall = is_call !== undefined ? (is_call ? 1 : 0) : ev.is_call;

  db.prepare(
    'UPDATE meeting_events SET title = ?, date = ?, time = ?, end_time = ?, is_call = ? WHERE id = ?',
  ).run(newTitle, newDate, t, tEnd, t ? isCall : 0, req.params.eventId);
  res.json({ id: Number(req.params.eventId), title: newTitle, date: newDate, time: t, end_time: tEnd, is_call: t ? isCall : 0 });
});

/** P1 — 통화 종료 후 AI가 뽑은 결정·할 일 목록 (참가자만) */
router.get('/:code/recaps', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const isParticipant = db
    .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
    .get(meeting.id, req.userId);
  if (!isParticipant) return res.status(403).json({ error: '회의 참가자만 볼 수 있어요' });
  res.json(listRecaps(meeting.id));
});

/** recap의 다음 회의 제안을 등록됨으로 표시 — 클라가 events POST 성공 후 호출 (참가자만) */
router.post('/:code/recaps/:recapId/next-registered', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const isParticipant = db
    .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
    .get(meeting.id, req.userId);
  if (!isParticipant) return res.status(403).json({ error: '회의 참가자만 쓸 수 있어요' });
  if (!markNextMeetingRegistered(Number(req.params.recapId), meeting.id)) {
    return res.status(404).json({ error: '다음 회의 제안이 없는 정리예요' });
  }
  res.json({ ok: true });
});

/** 결정 원장 — 이 그룹의 모든 recap 결정 시간순 (참가자만) */
router.get('/:code/decisions', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(listDecisions(r.meeting.id));
});

/** 결정 수신 확인 — 회람 사인. recap이 이 회의 것인지 검증 후 기록 */
router.post('/:code/decisions/ack', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const recapId = Number(req.body?.recapId);
  const idx = Number(req.body?.idx);
  if (!Number.isInteger(recapId) || !Number.isInteger(idx)) {
    return res.status(400).json({ error: '잘못된 요청입니다' });
  }
  const owns = db
    .prepare('SELECT 1 FROM meeting_recaps WHERE id = ? AND meeting_id = ?')
    .get(recapId, r.meeting.id);
  if (!owns) return res.status(404).json({ error: '존재하지 않는 결정입니다' });
  if (!ackDecision(recapId, idx, req.userId!)) {
    return res.status(404).json({ error: '존재하지 않는 결정입니다' });
  }
  res.json({ ok: true });
});

/** 다음 회의 아젠다 제안 — AI 총무가 미결 기록에서 안건 초안 (참가자만, 10분 캐시) */
router.get('/:code/agenda', async (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const channelId = resolveChannel(r.meeting.id, undefined, req.userId!);
  res.json(await generateAgenda(r.meeting.id, channelId ?? 0));
});

/** 회의 채팅 히스토리 (채널당 최근 100개) — ?channel=ID, 없으면 기본 채널 */
router.get('/:code/messages', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });

  const channelId = resolveChannel(meeting.id, req.query.channel, req.userId!);
  if (channelId == null) return res.status(404).json({ error: '존재하지 않는 채널이에요' });

  const rows = db
    .prepare(
      `SELECT u.username AS "from", u.avatar, m.text, m.file, m.channel_id, m.created_at FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.meeting_id = ? AND (m.channel_id = ? OR m.channel_id IS NULL)
       ORDER BY m.id DESC LIMIT 100`,
    )
    .all(meeting.id, channelId) as {
    from: string;
    avatar: string | null;
    text: string;
    file: string | null;
    channel_id: number | null;
    created_at: string;
  }[];

  res.json(
    rows.reverse().map((r) => ({
      from: r.from,
      avatar: r.avatar,
      text: r.text,
      file: r.file ? JSON.parse(r.file) : undefined,
      channelId: r.channel_id ?? channelId,
      ts: new Date(r.created_at + 'Z').getTime(),
    })),
  );
});

// ── 채팅 채널 — 그룹 안에 여러 채널 (기본 "일반" 자동 생성) ──

/** 참가자 검증 헬퍼 — 채널 라우트 공용 */
type ParticipantCheck =
  | { ok: false; status: 403 | 404; error: string }
  | { ok: true; meeting: { id: number; host_id: number } };

function meetingForParticipant(code: unknown, userId: number): ParticipantCheck {
  const meeting = db
    .prepare('SELECT id, host_id FROM meetings WHERE code = ?')
    .get(String(code ?? '').toUpperCase()) as { id: number; host_id: number } | undefined;
  if (!meeting) return { ok: false, status: 404, error: '존재하지 않는 회의입니다' };
  const isParticipant = db
    .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
    .get(meeting.id, userId);
  if (!isParticipant) return { ok: false, status: 403, error: '회의 참가자만 쓸 수 있어요' };
  return { ok: true, meeting };
}

/** 채널 목록 */
router.get('/:code/channels', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(listChannels(r.meeting.id, req.userId!));
});

/** 채널 생성 — 참가자 누구나 */
router.post('/:code/channels', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const name = cleanChannelName(req.body?.name);
  if (!name) return res.status(400).json({ error: '채널 이름을 입력하세요' });
  ensureDefaultChannel(r.meeting.id, req.userId!);
  const dup = db
    .prepare('SELECT 1 FROM chat_channels WHERE meeting_id = ? AND name = ?')
    .get(r.meeting.id, name);
  if (dup) return res.status(409).json({ error: '이미 있는 채널 이름이에요' });
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM chat_channels WHERE meeting_id = ?').get(r.meeting.id) as {
      n: number;
    }
  ).n;
  if (count >= 20) return res.status(400).json({ error: '채널은 그룹당 20개까지예요' });
  const info = db
    .prepare('INSERT INTO chat_channels (meeting_id, name, created_by) VALUES (?, ?, ?)')
    .run(r.meeting.id, name, req.userId!);
  res.json({ id: info.lastInsertRowid, name, isDefault: false });
});

/** 채널 이름 변경 — 호스트나 만든 사람 */
router.patch('/:code/channels/:channelId', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const ch = db
    .prepare('SELECT id, created_by FROM chat_channels WHERE id = ? AND meeting_id = ?')
    .get(req.params.channelId, r.meeting.id) as { id: number; created_by: number } | undefined;
  if (!ch) return res.status(404).json({ error: '존재하지 않는 채널이에요' });
  if (ch.created_by !== req.userId && r.meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '호스트나 만든 사람만 바꿀 수 있어요' });
  }
  const name = cleanChannelName(req.body?.name);
  if (!name) return res.status(400).json({ error: '채널 이름을 입력하세요' });
  db.prepare('UPDATE chat_channels SET name = ? WHERE id = ?').run(name, ch.id);
  res.json({ id: ch.id, name });
});

/** 채널 삭제 — 호스트만, 기본 채널은 불가. 채널 메시지도 함께 삭제 */
router.delete('/:code/channels/:channelId', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  if (r.meeting.host_id !== req.userId) {
    return res.status(403).json({ error: '호스트만 채널을 삭제할 수 있어요' });
  }
  const defaultId = ensureDefaultChannel(r.meeting.id, req.userId!);
  const id = Number(req.params.channelId);
  if (id === defaultId) return res.status(400).json({ error: '기본 채널은 삭제할 수 없어요' });
  const ch = db
    .prepare('SELECT id FROM chat_channels WHERE id = ? AND meeting_id = ?')
    .get(id, r.meeting.id);
  if (!ch) return res.status(404).json({ error: '존재하지 않는 채널이에요' });
  db.prepare('DELETE FROM messages WHERE channel_id = ?').run(id);
  db.prepare('DELETE FROM chat_channels WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;
