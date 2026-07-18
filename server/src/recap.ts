import OpenAI from 'openai';
import db from './db.js';
import { notifyUser } from './notify.js';
import { invalidateBrief } from './agent.js';

/*
 * exist P1 — 회의 통화가 끝나면 그 회의의 채팅에서 결정·할 일을 추출해
 * 참석자/불참자에게 배달한다. "회의에 없던 사람에게 결정이 흘러가는 것"이 목적.
 *
 * 흐름: sfu의 통화 방이 비워짐 → scheduleRecap(유예 후 실행, 재입장 시 취소)
 *       → runRecapForMeeting: 채팅 수집 → AI 추출(폴백: 규칙) → 저장
 *       → 담당자 매칭된 할 일 자동 생성 → 참석/불참 구분해 알림 라우팅.
 * OPENAI_API_KEY 없거나 실패 시 규칙 기반 폴백 (agent.ts와 동일 패턴).
 */

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
/** 방이 비워진 뒤 이만큼 기다렸다 요약 — 새로고침·재입장이면 취소 (데모 땐 env로 줄임) */
const GRACE_MS = Number(process.env.RECAP_GRACE_MS ?? 30_000);
/** 요약할 최소 메시지 수 — 미만이면 조용히 스킵 */
const MIN_MESSAGES = 2;

export interface RecapAction {
  assignee: string | null; // 참여자 username 또는 null
  title: string;
}

export interface RecapResult {
  summary: string;
  decisions: string[];
  actions: RecapAction[];
  source: 'ai' | 'rule';
}

interface ChatMsg {
  from: string;
  text: string;
}

/** 규칙 기반 폴백 — 키워드로 결정/할 일 후보를 추린다 (API 키 없이도 동작) */
export function ruleBasedRecap(msgs: ChatMsg[], participants: string[]): RecapResult {
  const decisions: string[] = [];
  const actions: RecapAction[] = [];
  const names = new Set(participants);

  for (const m of msgs) {
    const text = m.text.trim();
    if (!text) continue;
    if (/(하기로|결정|확정|합의|정했)/.test(text) && decisions.length < 5) {
      decisions.push(`${m.from}: ${text.slice(0, 120)}`);
      continue;
    }
    // 할 일 신호: 마감·요청 표현 + "~게요/~겠습니다"류 자기 약속 어미
    if (/(까지|해주세요|해 주세요|부탁|겠습니다|[가-힣]게요|담당)/.test(text) && actions.length < 5) {
      // @이름 멘션이 참여자와 일치하면 담당자로, "제가/내가 ...게요"면 화자 본인
      const mention = text.match(/@([\w가-힣.-]+)/);
      let assignee: string | null = null;
      if (mention && names.has(mention[1])) assignee = mention[1];
      else if (/(제가|내가)/.test(text) && /(게요|겠습니다)/.test(text)) assignee = m.from;
      actions.push({ assignee, title: text.slice(0, 120) });
    }
  }

  const summary =
    decisions.length > 0
      ? decisions[0].replace(/^[^:]+: /, '').slice(0, 80)
      : `메시지 ${msgs.length}건 논의 (뚜렷한 결정 없음)`;
  return { summary, decisions, actions, source: 'rule' };
}

/** OpenAI 기반 추출 — 결정·할 일·요약을 JSON으로 */
async function aiRecap(msgs: ChatMsg[], participants: string[]): Promise<RecapResult> {
  const system =
    '너는 분산 근무 플랫폼 exist의 AI 운영자다. 회의 채팅 로그에서 팀이 합의한 결정과 할 일을 추출한다. ' +
    '이 결과는 회의에 참석하지 못한 팀원에게 그대로 전달되므로, 로그에 없는 사실·수치를 만들지 않는다.\n' +
    '응답은 오직 JSON 한 개. 형식: {"summary": string, "decisions": string[], "actions": [{"assignee": string|null, "title": string}]}.\n' +
    'summary는 논의 핵심 한 줄(한국어 80자 이내). decisions는 실제로 합의·확정된 것만(최대 5개, 없으면 빈 배열). ' +
    'actions는 구체적인 할 일(최대 5개). assignee는 반드시 participants 목록의 username 중 하나이거나, 로그로 담당자를 특정할 수 없으면 null.';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 600,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({
          participants,
          chat: msgs.map((m) => `${m.from}: ${m.text}`),
        }),
      },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '';
  if (!raw) throw new Error('empty AI response');
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e < s) throw new Error('no json');
  const parsed = JSON.parse(raw.slice(s, e + 1)) as {
    summary?: unknown;
    decisions?: unknown;
    actions?: unknown;
  };

  const names = new Set(participants);
  const summary = String(parsed.summary ?? '').trim().slice(0, 160);
  if (!summary) throw new Error('empty summary');
  const decisions = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
    .map((d) => String(d).trim())
    .filter(Boolean)
    .slice(0, 5);
  const actions: RecapAction[] = (Array.isArray(parsed.actions) ? parsed.actions : [])
    .map((a) => {
      const o = a as { assignee?: unknown; title?: unknown };
      const assignee = typeof o.assignee === 'string' && names.has(o.assignee) ? o.assignee : null;
      return { assignee, title: String(o.title ?? '').trim().slice(0, 160) };
    })
    .filter((a) => a.title)
    .slice(0, 5);
  return { summary, decisions, actions, source: 'ai' };
}

/** 추출 (AI → 실패 시 규칙 폴백) */
export async function extractRecap(msgs: ChatMsg[], participants: string[]): Promise<RecapResult> {
  if (openai) {
    try {
      return await aiRecap(msgs, participants);
    } catch (err) {
      console.error('[recap] OpenAI 실패, 규칙 기반 폴백:', err);
    }
  }
  return ruleBasedRecap(msgs, participants);
}

export interface RecapRow {
  id: number;
  summary: string;
  decisions: string[];
  actions: RecapAction[];
  attendees: string[];
  source: string;
  ts: number;
}

/** 회의의 recap 목록 (최신순) — API·클라 표시용 */
export function listRecaps(meetingId: number, limit = 20): RecapRow[] {
  const rows = db
    .prepare(
      `SELECT id, summary, decisions, actions, attendees, source, created_at
       FROM meeting_recaps WHERE meeting_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(meetingId, limit) as {
    id: number;
    summary: string;
    decisions: string;
    actions: string;
    attendees: string;
    source: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    summary: r.summary,
    decisions: JSON.parse(r.decisions),
    actions: JSON.parse(r.actions),
    attendees: JSON.parse(r.attendees),
    source: r.source,
    ts: new Date(r.created_at + 'Z').getTime(),
  }));
}

/**
 * P1 본체 — 통화가 끝난 회의의 채팅을 요약해 저장하고 라우팅한다.
 * @param code 회의 코드
 * @param sessionUserIds 이번 통화에 실제로 들어왔던 userId들
 * @returns 저장된 recap id, 스킵 시 null
 */
export async function runRecapForMeeting(
  code: string,
  sessionUserIds: number[],
): Promise<number | null> {
  const meeting = db
    .prepare('SELECT id, code, title FROM meetings WHERE code = ?')
    .get(code.toUpperCase()) as { id: number; code: string; title: string } | undefined;
  if (!meeting) return null;

  // 요약 창: 마지막 recap 이후 ~ 지금. 첫 recap이면 최근 24시간.
  const last = db
    .prepare('SELECT MAX(call_ended_at) AS t FROM meeting_recaps WHERE meeting_id = ?')
    .get(meeting.id) as { t: string | null };
  const since = last.t ?? new Date(Date.now() - 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);

  // 채팅 + 통화 음성 전사를 시간순으로 합쳐서 요약 재료로 쓴다
  const chatMsgs = db
    .prepare(
      `SELECT u.username AS "from", m.text, m.created_at AS at FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.meeting_id = ? AND m.created_at > ? AND m.text != ''
       ORDER BY m.id ASC LIMIT 200`,
    )
    .all(meeting.id, since) as (ChatMsg & { at: string })[];
  const voiceMsgs = db
    .prepare(
      `SELECT u.username AS "from", t.text, t.created_at AS at FROM call_transcripts t
       JOIN users u ON u.id = t.user_id
       WHERE t.meeting_id = ? AND t.created_at > ?
       ORDER BY t.id ASC LIMIT 300`,
    )
    .all(meeting.id, since) as (ChatMsg & { at: string })[];
  // 화자명은 순수 username 유지 — ruleBasedRecap의 담당자 매칭("제가 …게요")이 깨지지 않도록
  const msgs: ChatMsg[] = [...chatMsgs, ...voiceMsgs]
    .sort((a, b) => (a.at < b.at ? -1 : 1))
    .map((m) => ({ from: m.from, text: m.text }));
  if (msgs.length < MIN_MESSAGES) return null;

  // 회의 등록 참가자 전원 (배달 대상) — 참석/불참은 sessionUserIds로 구분
  const members = db
    .prepare(
      `SELECT u.id, u.username FROM meeting_participants mp
       JOIN users u ON u.id = mp.user_id WHERE mp.meeting_id = ?`,
    )
    .all(meeting.id) as { id: number; username: string }[];
  if (members.length === 0) return null;

  const recap = await extractRecap(
    msgs,
    members.map((m) => m.username),
  );

  const inCall = new Set(sessionUserIds);
  const attendees = members.filter((m) => inCall.has(m.id)).map((m) => m.username);

  const info = db
    .prepare(
      `INSERT INTO meeting_recaps (meeting_id, summary, decisions, actions, attendees, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meeting.id,
      recap.summary,
      JSON.stringify(recap.decisions),
      JSON.stringify(recap.actions),
      JSON.stringify(attendees),
      recap.source,
    );
  const recapId = info.lastInsertRowid as number;

  // 담당자가 특정된 할 일은 그 사람의 회의 할 일로 자동 생성
  const byName = new Map(members.map((m) => [m.username, m.id]));
  const assignedCount = new Map<number, number>();
  for (const a of recap.actions) {
    if (!a.assignee) continue;
    const uid = byName.get(a.assignee);
    if (!uid) continue;
    db.prepare('INSERT INTO todos (user_id, meeting_id, title) VALUES (?, ?, ?)').run(
      uid,
      meeting.id,
      a.title.slice(0, 200),
    );
    assignedCount.set(uid, (assignedCount.get(uid) ?? 0) + 1);
  }

  // 라우팅 — 참석자에겐 요약, 불참자에겐 "못 들어간 회의의 결정" (P1의 핵심)
  const stats = [
    recap.decisions.length > 0 ? `결정 ${recap.decisions.length}` : null,
    recap.actions.length > 0 ? `할 일 ${recap.actions.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  for (const m of members) {
    const mine = assignedCount.get(m.id);
    const mineSuffix = mine ? ` — 내 할 일 ${mine}개 배정됨` : '';
    const text = inCall.has(m.id)
      ? `"${meeting.title}" 통화 정리: ${recap.summary}${stats ? ` (${stats})` : ''}${mineSuffix}`
      : `놓친 "${meeting.title}" 통화의 결정이 도착했어요: ${recap.summary}${stats ? ` (${stats})` : ''}${mineSuffix}`;
    notifyUser(m.id, { from: 'exist AI', text, kind: 'recap', meetingCode: meeting.code });
    invalidateBrief(m.id);
  }

  console.log(
    `[recap] ${meeting.code} 요약 저장 (${recap.source}) — 결정 ${recap.decisions.length}, 할 일 ${recap.actions.length}, 배달 ${members.length}명`,
  );
  return recapId;
}

export interface LedgerEntry {
  recapId: number;
  decision: string;
  attendees: string[];
  ts: number;
}

/** 결정 원장 — 이 그룹의 모든 recap 결정을 시간순(최신 먼저)으로 편다.
 *  "결정이 사람이 아니라 조직에 남는다"의 데이터 뷰. AI 질의응답의 근거로도 사용. */
export function listDecisions(meetingId: number, limit = 100): LedgerEntry[] {
  const rows = db
    .prepare(
      `SELECT id, decisions, attendees, created_at FROM meeting_recaps
       WHERE meeting_id = ? ORDER BY id DESC LIMIT 50`,
    )
    .all(meetingId) as { id: number; decisions: string; attendees: string; created_at: string }[];
  const out: LedgerEntry[] = [];
  for (const r of rows) {
    const ts = new Date(r.created_at + 'Z').getTime();
    const attendees = JSON.parse(r.attendees) as string[];
    for (const d of JSON.parse(r.decisions) as string[]) {
      out.push({ recapId: r.id, decision: d, attendees, ts });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ── 통화 종료 유예 스케줄러 — 방이 비워지면 GRACE_MS 후 실행, 재입장 시 취소 ──
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleRecap(code: string, sessionUserIds: number[]) {
  const key = code.toUpperCase();
  cancelScheduledRecap(key);
  const timer = setTimeout(() => {
    pending.delete(key);
    runRecapForMeeting(key, sessionUserIds).catch((err) =>
      console.error('[recap] 실행 실패:', err),
    );
  }, GRACE_MS);
  pending.set(key, timer);
}

/** 통화 방이 다시 생기면(재입장) 예약된 요약 취소 — 세션이 이어진 것으로 본다 */
export function cancelScheduledRecap(code: string) {
  const key = code.toUpperCase();
  const t = pending.get(key);
  if (t) {
    clearTimeout(t);
    pending.delete(key);
  }
}
