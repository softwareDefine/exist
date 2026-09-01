import OpenAI from 'openai';
import db from './db.js';
import { samplingFor, parseLlmJson, cleanAnswer } from './llm.js';
import { listDecisions, listRecaps } from './recap.js';

/*
 * exist AI 총무 — 그룹 채팅에서 @AI 를 멘션하면 그 그룹의 기록
 * (결정 원장·통화 정리·할 일·최근 대화)을 근거로 답한다.
 * 원칙: 기록에 있는 것만 답하고, 없으면 없다고 말한다 (환각 방어).
 * OPENAI_API_KEY 없거나 실패 시 규칙 폴백 (최근 결정 나열).
 */

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
// RAG 검색·색인 — steward→rag→fileai 방향 의존 (역방향 없음, 순환 안전)
import {
  searchRag,
  searchRagAcross,
  indexRecap,
  indexAgendaResolution,
  findSimilarClosedAgenda,
} from './rag.js';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export const AGENT_NAME = 'exist AI';
/** @AI, @ai, @총무 멘션 감지 — 문장 처음이나 공백 뒤의 독립 토큰만 (이메일 주소 오탐 방지).
 *  "@AI, 알려줘"처럼 바로 문장부호가 붙는 경우도 허용 */
export const AGENT_MENTION = /(^|\s)@(ai|총무)(?=[\s,.!?~:;]|$)/i;

/** AI 아바타 — 클라이언트 Avatar가 이 값을 별(SparklesIcon)로 렌더 */
export const AGENT_AVATAR = '✦';

/** 시스템 유저(exist AI) 확보 — 채팅 메시지의 발신자로 쓴다 (로그인 불가 더미 해시) */
export function ensureAgentUser(): number {
  const existing = db.prepare('SELECT id, avatar FROM users WHERE username = ?').get(AGENT_NAME) as
    | { id: number; avatar: string | null }
    | undefined;
  if (existing) {
    if (existing.avatar !== AGENT_AVATAR)
      db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(AGENT_AVATAR, existing.id);
    return existing.id;
  }
  const info = db
    .prepare("INSERT INTO users (username, pw_hash, pw_salt, avatar) VALUES (?, 'x', 'x', ?)")
    .run(AGENT_NAME, AGENT_AVATAR);
  return info.lastInsertRowid as number;
}

interface AgentContext {
  meetingTitle: string;
  decisions: { decision: string; ts: number }[];
  recaps: { summary: string; ts: number }[];
  todos: { title: string; done: number; author: string }[];
  events: { title: string; date: string; time: string | null }[];
  chat: { from: string; text: string }[];
  /** 미해결 안건 — 상태(대기 조건)까지. "보류 안건 뭐 있어?" 류 (9/1 추가) */
  agenda: { title: string; status: string | null; note: string | null; why: string | null }[];
  /** 최근 인수인계 — 교대 라벨·작성자·이슈/변경/미결 요약 (9/1 추가) */
  handovers: { label: string; author: string; at: string; lines: string[] }[];
}

function gatherContext(meetingId: number, channelId: number): AgentContext {
  const meeting = db.prepare('SELECT title FROM meetings WHERE id = ?').get(meetingId) as {
    title: string;
  };
  // 배경(why)·검토된 대안까지 근거에 포함 — "왜 이렇게 됐어?" "그때 뭐 검토했었지?" 역질문에 답할 수 있게
  const decisions = listDecisions(meetingId, 30).map((d) => {
    const extra = [
      d.why ? `배경: ${d.why}` : null,
      d.alts.length ? `검토된 대안: ${d.alts.join(' / ')}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return { decision: extra ? `${d.decision} (${extra})` : d.decision, ts: d.ts };
  });
  const recaps = listRecaps(meetingId, 5).map((r) => ({ summary: r.summary, ts: r.ts }));
  const todos = db
    .prepare(
      `SELECT t.title, t.done, u.username AS author FROM todos t
       JOIN users u ON u.id = t.user_id WHERE t.meeting_id = ? ORDER BY t.id DESC LIMIT 20`,
    )
    .all(meetingId) as { title: string; done: number; author: string }[];
  // AI 자신의 메시지는 근거에서 제외 — 과거 AI 답변을 다시 먹고 반복하는 자기 오염 방지
  const chat = db
    .prepare(
      `SELECT u.username AS "from", m.text, m.created_at AS at, m.id FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.meeting_id = ? AND m.user_id != ? AND (m.channel_id = ? OR m.channel_id IS NULL) AND m.text != ''
       ORDER BY m.id DESC LIMIT 30`,
    )
    .all(meetingId, ensureAgentUser(), channelId) as { from: string; text: string; at: string; id: number }[];
  // 최근 통화 음성 전사 — 최근 24시간 창 (창 없이 긁으면 지난주 통화가 "최근 대화"로 섞인다)
  const voice = db
    .prepare(
      `SELECT u.username AS "from", t.text, t.created_at AS at, t.id FROM call_transcripts t
       JOIN users u ON u.id = t.user_id
       WHERE t.meeting_id = ? AND t.created_at > datetime('now','-24 hours')
       ORDER BY t.id DESC LIMIT 30`,
    )
    .all(meetingId) as { from: string; text: string; at: string; id: number }[];
  // 시간순 병합 — voice 뭉치를 앞에 붙이면 대화 순서가 역전된다 (동률은 id 보조키)
  const mergedChat = [...voice, ...chat]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id))
    .map(({ from, text }) => ({ from, text }));
  // 다가오는 일정 — "다음 회의 언제야?" 류 질문의 근거 (반복 일정 전개는 생략, 기준일 이후만)
  const events = db
    .prepare(
      `SELECT title, date, time FROM meeting_events
       WHERE meeting_id = ? AND date >= date('now', 'localtime')
       ORDER BY date, COALESCE(time, '99') LIMIT 5`,
    )
    .all(meetingId) as { title: string; date: string; time: string | null }[];
  // 미해결 안건 — 대기 조건(status_note)이 있으면 "무엇을 기다리는지"가 답의 핵심
  const agenda = db
    .prepare(
      `SELECT title, status, status_note AS note, why FROM agenda_items
       WHERE meeting_id = ? AND resolved = 0 ORDER BY id DESC LIMIT 10`,
    )
    .all(meetingId) as { title: string; status: string | null; note: string | null; why: string | null }[];
  // 최근 인수인계 2건 — sections JSON을 줄로 펼친다 (교대 조직에서 "지난 조 뭐 남겼어?" 근거)
  const handovers = (
    db
      .prepare(
        `SELECT h.shift_label AS label, h.sections, h.created_at AS at, u.username AS author
         FROM handovers h JOIN users u ON u.id = h.author_id
         WHERE h.meeting_id = ? ORDER BY h.id DESC LIMIT 2`,
      )
      .all(meetingId) as { label: string | null; sections: string; at: string; author: string }[]
  ).map((h) => {
    let sec: Record<string, unknown> = {};
    try {
      sec = JSON.parse(h.sections) as Record<string, unknown>;
    } catch {
      /* 손상된 행은 빈 인수인계로 */
    }
    const names: Record<string, string> = { issues: '이슈', changes: '변경', pending: '미결', notes: '메모' };
    const lines = Object.entries(names).flatMap(([k, ko]) =>
      (Array.isArray(sec[k]) ? (sec[k] as unknown[]) : []).slice(0, 6).map((x) => `${ko}: ${String(x)}`),
    );
    return { label: h.label || '', author: h.author, at: h.at, lines };
  });
  return { meetingTitle: meeting.title, decisions, recaps, todos, events, chat: mergedChat, agenda, handovers };
}

/** 규칙 폴백 — 질문 키워드에 따라 기록을 그대로 보여준다.
 *  못 알아들은 질문도 무시하지 않고 "그 질문엔 기록이 없다"고 밝힌 뒤 아는 걸 보여준다 */
export function ruleBasedAnswer(question: string, ctx: AgentContext): string {
  const q = question.toLowerCase();
  if (/(결정|정했|확정|왜)/.test(q) && ctx.decisions.length > 0) {
    const lines = ctx.decisions.slice(0, 3).map((d) => `· ${d.decision}`);
    return `이 그룹의 최근 결정이에요:\n${lines.join('\n')}`;
  }
  if (/(할 ?일|해야|남은|todo)/i.test(q) && ctx.todos.length > 0) {
    const undone = ctx.todos.filter((t) => !t.done).slice(0, 5);
    if (undone.length > 0) {
      return `미완료 할 일 ${undone.length}개예요:\n${undone.map((t) => `· ${t.title} (${t.author})`).join('\n')}`;
    }
  }
  if (/(일정|스케줄|언제|약속|회의 ?시간)/.test(q) && ctx.events.length > 0) {
    const lines = ctx.events.slice(0, 3).map((e) => `· ${e.date}${e.time ? ` ${e.time}` : ''} ${e.title}`);
    return `다가오는 일정이에요:\n${lines.join('\n')}`;
  }
  if (/(정리|요약|무슨 ?일|상황)/.test(q) && ctx.recaps.length > 0) {
    return `가장 최근 통화 정리예요: ${ctx.recaps[0].summary}`;
  }
  if (/(안건|보류|대기 ?중)/.test(q) && ctx.agenda.length > 0) {
    const lines = ctx.agenda.slice(0, 5).map((a) => `· ${a.title}${a.note ? ` — ${a.note}` : ''}`);
    return `미해결 안건이에요:\n${lines.join('\n')}`;
  }
  if (/(인수인계|지난 ?조|전 ?조|교대)/.test(q) && ctx.handovers.length > 0) {
    const h = ctx.handovers[0];
    return `가장 최근 인수인계(${h.author}${h.label ? `, ${h.label}` : ''})예요:\n${h.lines.slice(0, 6).map((l) => `· ${l}`).join('\n') || '(내용 없음)'}`;
  }
  // 어느 키워드에도 안 걸림 — 질문을 무시한 것처럼 보이지 않게 한계를 밝힌다
  const known: string[] = [];
  if (ctx.decisions.length > 0) known.push(`결정 ${ctx.decisions.length}건`);
  if (ctx.todos.filter((t) => !t.done).length > 0)
    known.push(`미완료 할 일 ${ctx.todos.filter((t) => !t.done).length}개`);
  if (ctx.events.length > 0) known.push(`다가오는 일정 ${ctx.events.length}건`);
  if (known.length === 0 && ctx.recaps.length === 0) {
    return (
      '아직 기록이 쌓이기 전이라 답해드릴 근거가 없어요. ' +
      '통화나 채팅이 시작되면 제가 결정·할 일·일정으로 정리해두고, 그때부터 뭐든 물어보시면 찾아드릴게요.'
    );
  }
  const cut = question.length > 40 ? `${question.slice(0, 40)}…` : question;
  return (
    `"${cut}"에 딱 맞는 기록은 못 찾았어요. 지금 쌓인 기록: ${known.join(' · ') || '통화 정리'} — ` +
    '"결정", "할 일", "일정", "요약"처럼 물어보면 바로 보여드려요.'
  );
}

async function aiAnswer(
  question: string,
  asker: string,
  ctx: AgentContext,
  related?: string[],
): Promise<string> {
  const system =
    `너는 분산 근무 플랫폼 exist의 AI 총무다. "${ctx.meetingTitle}" 그룹에 상주하며 팀의 기록을 관리한다. ` +
    '아래 제공되는 그룹 기록(결정 원장·통화 정리·할 일·최근 대화·관련 과거 기록)에 근거해서만 답한다. ' +
    '기록에 없는 내용은 추측하지 말되, "기록에 없다"처럼 딱딱하게 끊지 말고 ' +
    '"그 내용은 아직 기록에 없어요 — 회의나 채팅에서 다뤄지면 제가 정리해둘게요"처럼 부드러운 해요체로 밝히고, ' +
    '대신 관련해서 아는 기록이나 다음 행동을 한 줄 안내한다. 수치·사실을 만들지 않는다.\n' +
    '답변은 한국어 해요체로 간결하게(300자 이내), 필요하면 근거가 된 결정·대화를 짧게 인용한다. ' +
    '응답은 오직 JSON: {"answer": string}';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    ...samplingFor(OPENAI_MODEL, 0.2, 400),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({
          question,
          asker,
          records: {
            decisions: ctx.decisions.map((d) => d.decision),
            call_summaries: ctx.recaps.map((r) => r.summary),
            todos: ctx.todos.map((t) => `${t.title} (${t.author}${t.done ? ', 완료' : ''})`),
            upcoming_events: ctx.events.map((e) => `${e.date}${e.time ? ` ${e.time}` : ''} ${e.title}`),
            recent_chat: ctx.chat.map((c) => `${c.from}: ${c.text}`),
            ...(ctx.agenda.length
              ? {
                  open_agenda: ctx.agenda.map(
                    (a) =>
                      `${a.title}${a.status ? ` [${{ waiting_dept: '타부서 대기', waiting_approval: '승인 대기', hold: '보류' }[a.status] ?? a.status}${a.note ? `: ${a.note}` : ''}]` : ''}${a.why ? ` (${a.why})` : ''}`,
                  ),
                }
              : {}),
            ...(ctx.handovers.length
              ? {
                  recent_handovers: ctx.handovers.map(
                    (h) => `${h.at.slice(0, 16)} ${h.label ? `${h.label} ` : ''}${h.author}: ${h.lines.join(' / ') || '(내용 없음)'}`,
                  ),
                }
              : {}),
            // RAG — 질문 의미로 찾아온 과거 기록 (최근 창 밖 원장·문서까지)
            ...(related && related.length > 0 ? { related_history: related } : {}),
          },
        }),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = parseLlmJson(raw) as {
    answer?: unknown;
  };
  const answer = cleanAnswer(String(parsed.answer ?? ''));
  if (!answer) throw new Error('empty answer');
  return answer.slice(0, 1000);
}

/* ── DM 1:1 질의 — 통합 메시지에서 exist AI에게 직접 묻기 ──
 * 근거 = 그 스코프(개인/조직)에서 내가 참가한 그룹들의 결정(+배경)·통화 정리·내 할 일.
 * 그룹 채팅 @AI가 공개 역질문이라면, 이건 조용히 묻는 1:1 — 심리적 안전의 사적 채널 */
export async function answerDmQuery(
  orgId: number | null,
  userId: number,
  question: string,
): Promise<string> {
  const scopeSql = orgId == null ? 'm.org_id IS NULL' : 'm.org_id = ?';
  const scopeArgs = orgId == null ? [] : [orgId];
  const meetings = db
    .prepare(
      `SELECT m.id, m.title FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE ${scopeSql} AND mp.user_id = ? ORDER BY m.id DESC LIMIT 10`,
    )
    .all(...scopeArgs, userId) as { id: number; title: string }[];

  const decisions: { decision: string; ts: number }[] = [];
  const recaps: { summary: string; ts: number }[] = [];
  for (const m of meetings) {
    for (const d of listDecisions(m.id, 10)) {
      decisions.push({
        decision: `[${m.title}] ${d.decision}${d.why ? ` (배경: ${d.why})` : ''}`,
        ts: d.ts,
      });
    }
    for (const r of listRecaps(m.id, 2)) recaps.push({ summary: `[${m.title}] ${r.summary}`, ts: r.ts });
  }
  decisions.sort((a, b) => b.ts - a.ts);
  recaps.sort((a, b) => b.ts - a.ts);

  const todos = db
    .prepare(
      `SELECT t.title, t.done, u.username AS author FROM todos t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN meetings m ON m.id = t.meeting_id
       WHERE t.user_id = ? AND (${orgId == null ? 'm.id IS NULL OR m.org_id IS NULL' : 'm.org_id = ?'})
       ORDER BY t.id DESC LIMIT 20`,
    )
    .all(userId, ...scopeArgs) as { title: string; done: number; author: string }[];

  // 스코프 내 그룹들의 다가오는 일정 — "다음 회의 언제야?" 근거
  const events = meetings.length
    ? (db
        .prepare(
          `SELECT e.title, e.date, e.time FROM meeting_events e
           WHERE e.meeting_id IN (${meetings.map(() => '?').join(',')})
             AND e.date >= date('now', 'localtime')
           ORDER BY e.date, COALESCE(e.time, '99') LIMIT 5`,
        )
        .all(...meetings.map((m) => m.id)) as { title: string; date: string; time: string | null }[])
    : [];

  const ctx: AgentContext = {
    meetingTitle: orgId == null ? '개인 워크스페이스' : '조직 워크스페이스',
    decisions: decisions.slice(0, 30),
    recaps: recaps.slice(0, 8),
    todos,
    events,
    chat: [],
    agenda: [],
    handovers: [], // 1:1 질의는 그룹 대화를 근거로 안 씀 — 스코프 전체 기록만
  };

  if (openai) {
    try {
      const me = db.prepare('SELECT username, name FROM users WHERE id = ?').get(userId) as
        | { username: string; name: string | null }
        | undefined;
      // RAG — 스코프 내 그룹 전체에서 의미 검색 (최근 창 밖 원장·문서·종결 안건까지)
      const titleOf = new Map(meetings.map((m) => [m.id, m.title]));
      const related = await searchRagAcross(
        meetings.map((m) => m.id),
        question,
      ).catch(() => []);
      return await aiAnswer(
        question,
        me?.name || me?.username || '사용자',
        ctx,
        related.map((r) => `[${titleOf.get(r.meetingId) ?? '그룹'}] ${r.text}`),
      );
    } catch (err) {
      console.error('[steward] DM AI 실패, 규칙 폴백:', err);
    }
  }
  return ruleBasedAnswer(question, ctx);
}

/* ── 다음 회의 아젠다 제안 — 회의 "전"에도 총무가 일한다 ──
 * 재료: 최근 recap 요약/결정, 미완료 할 일, 최근 채팅.
 * AI 실패·키 없음 → 규칙 폴백 (미완료 할 일 상위). 10분 캐시. */

export interface AgendaItem {
  title: string;
  why: string; // 근거 한 줄 ("지난 통화 미결" / "미완료 할 일" 등)
  /** 안건으로 올라간 회의 횟수 — 2 이상이면 이월 안건 (클라가 "N회째" 배지) */
  rounds?: number;
  /** agenda_items.id — 있으면 수동 종결 가능 (규칙 폴백 안건은 미영속이라 없음) */
  id?: number;
  /** 멈춤 상태 — waiting_dept(타부서 대기)·waiting_approval(승인 대기)·hold(보류)·null */
  status?: string | null;
  /** 대기 조건 — "무엇을 기다리며 멈췄나" (보류 깨우기 매칭 재료, 칩 툴팁 표시) */
  statusNote?: string | null;
  /** 유사한 과거 종결 안건 — "이거 예전에 이런 사유로 접었던 건이에요" ("M/D 종결: 사유") */
  closedBefore?: string | null;
  /** 그 과거 종결 안건의 id — 생애 타임라인 입구 */
  closedBeforeId?: number | null;
}

export interface Agenda {
  items: AgendaItem[];
  source: 'ai' | 'rule';
  generatedAt: number;
}

const agendaCache = new Map<number, Agenda>();
const AGENDA_CACHE_MS = 10 * 60 * 1000;

/* ── 이월 안건 — 결론 못 낸 안건을 영속 추적 (agenda_items 테이블) ──
 * 안건 생성 시 AI 안건을 저장해두고, recap이 생길 때마다 정산:
 * 이번 회의에서 결론(결정)에 이른 안건은 resolved, 나머지는 rounds+1로 이월.
 * 효과: 미결 안건이 최근 대화 창(30개)을 벗어나도 다음 안건에 계속 올라온다. */

const CARRYOVER_MAX = 3; // 안건 상단에 끼워 넣는 이월 안건 수 (신규 안건 자리도 남긴다)
const normTitle = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

interface CarryoverRow {
  id: number;
  title: string;
  why: string;
  rounds: number;
  status: string | null;
  status_note: string | null;
}

function listCarryover(meetingId: number): CarryoverRow[] {
  return db
    .prepare(
      `SELECT id, title, why, rounds, status, status_note FROM agenda_items
       WHERE meeting_id = ? AND resolved = 0 ORDER BY rounds DESC, id ASC LIMIT ?`,
    )
    .all(meetingId, CARRYOVER_MAX) as CarryoverRow[];
}

/** 안건 생애 이벤트 기록 — 실패해도 본 동작엔 영향 없음 (로그는 부가물) */
export function addAgendaEvent(
  meetingId: number,
  agendaId: number,
  kind: string,
  detail?: string | null,
  actorId?: number | null,
  recapId?: number | null,
): void {
  try {
    db.prepare(
      `INSERT INTO agenda_events (agenda_id, meeting_id, kind, detail, actor_id, recap_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(agendaId, meetingId, kind, detail?.slice(0, 300) ?? null, actorId ?? null, recapId ?? null);
  } catch {
    /* 이벤트 유실은 치명적이지 않음 */
  }
}

/** AI가 새로 제안한 안건을 저장 — 이미 추적 중인 미결 안건과 같은 제목이면 스킵 */
function persistNewAgendaItems(meetingId: number, items: AgendaItem[]) {
  const known = new Set(
    (
      db
        .prepare('SELECT title FROM agenda_items WHERE meeting_id = ? AND resolved = 0')
        .all(meetingId) as { title: string }[]
    ).map((r) => normTitle(r.title)),
  );
  const ins = db.prepare('INSERT INTO agenda_items (meeting_id, title, why) VALUES (?, ?, ?)');
  for (const it of items) {
    if (known.has(normTitle(it.title))) continue;
    const info = ins.run(meetingId, it.title.slice(0, 120), it.why.slice(0, 80));
    addAgendaEvent(meetingId, info.lastInsertRowid as number, 'created', it.why.slice(0, 120));
    known.add(normTitle(it.title));
  }
}

/** recap 생성 직후 호출 — 미결 안건 정산.
 *  결론에 이른 안건은 AI가 인덱스로만 지목(환각 방어), 나머지는 rounds+1로 이월.
 *  AI 없거나 실패하면 보수적으로 전부 이월 (틀린 종결이 미결 유실보다 나쁘다).
 *  decisionRefs: 이번 회의 결정들의 원장 좌표(recapId+idx — dedup으로 auto 행에 남은 결정 포함).
 *  매칭되면 안건에 명시 링크(resolved_recap_id/idx) 저장 — 타임라인의 "이런 이유로 결정했고" 근거 */
export async function settleAgendaAfterRecap(
  meetingId: number,
  recap: { summary: string; decisionRefs: { text: string; recapId: number; idx: number }[] },
  currentRecapId?: number | null,
): Promise<void> {
  const open = db
    .prepare('SELECT id, title FROM agenda_items WHERE meeting_id = ? AND resolved = 0')
    .all(meetingId) as { id: number; title: string }[];
  if (open.length === 0) return;

  // {안건 id → 결정 인덱스} — AI가 어떤 결정이 어떤 안건을 닫았는지까지 지목
  const resolvedMap = new Map<number, number>();
  if (openai && recap.decisionRefs.length > 0) {
    try {
      const system =
        '너는 exist의 AI 총무다. 회의 안건 목록과 방금 끝난 회의의 결정을 비교해, 이번 회의에서 결론(결정)에 이른 안건을 고른다.\n' +
        '확실히 대응되는 것만 고른다 — 애매하면 고르지 않는다 (미결로 남기는 쪽이 안전).\n' +
        '응답은 오직 JSON: {"resolved": [{"id": 안건id, "decision_idx": 그 안건을 종결시킨 결정의 배열 인덱스}]} (없으면 빈 배열)';
      const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        ...samplingFor(OPENAI_MODEL, 0, 300),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: JSON.stringify({
              agenda_items: open.map((o) => ({ id: o.id, title: o.title })),
              meeting_summary: recap.summary,
              meeting_decisions: recap.decisionRefs.map((d) => d.text),
            }),
          },
        ],
      });
      const raw = response.choices[0]?.message?.content ?? '';
      const parsed = parseLlmJson(raw) as {
        resolved?: unknown;
        resolved_ids?: unknown; // 구형 응답 호환
      };
      const valid = new Set(open.map((o) => o.id));
      if (Array.isArray(parsed.resolved)) {
        for (const r of parsed.resolved as { id?: unknown; decision_idx?: unknown }[]) {
          const id = Number(r?.id);
          const di = Number(r?.decision_idx);
          if (valid.has(id) && Number.isInteger(di) && di >= 0 && di < recap.decisionRefs.length)
            resolvedMap.set(id, di);
        }
      } else if (Array.isArray(parsed.resolved_ids)) {
        for (const n of parsed.resolved_ids.map(Number))
          if (valid.has(n)) resolvedMap.set(n, -1); // 결정 특정 실패 — 종결만
      }
    } catch (err) {
      console.error('[steward] 안건 정산 AI 실패 — 전부 이월:', err);
    }
  }

  const resolve = db.prepare(
    `UPDATE agenda_items SET resolved = 1, resolved_recap_id = ?, resolved_decision_idx = ?,
       updated_at = datetime('now') WHERE id = ?`,
  );
  for (const [id, di] of resolvedMap) {
    const ref = di >= 0 ? recap.decisionRefs[di] : null;
    resolve.run(ref?.recapId ?? null, ref?.idx ?? null, id);
    addAgendaEvent(
      meetingId,
      id,
      'resolved',
      ref ? ref.text.slice(0, 200) : '회의 결정으로 종결',
      null,
      ref?.recapId ?? currentRecapId ?? null,
    );
  }
  // 남은 미결은 이월 — "회의가 지나갔지만 결론 없음"도 생애 이벤트로 남긴다
  const remaining = open.filter((o) => !resolvedMap.has(o.id));
  db.prepare(
    `UPDATE agenda_items SET rounds = rounds + 1, updated_at = datetime('now')
     WHERE meeting_id = ? AND resolved = 0`,
  ).run(meetingId);
  for (const o of remaining)
    addAgendaEvent(meetingId, o.id, 'carried', null, null, currentRecapId ?? null);
  if (resolvedMap.size > 0 || open.length > 0)
    console.log(
      `[steward] 안건 정산 — 종결 ${resolvedMap.size}, 이월 ${open.length - resolvedMap.size}`,
    );
  // 보류 깨우기 — 이번 결정·요약이 대기 중 안건의 조건을 충족시켰는지 (비동기·실패 무해)
  void wakeWaitingAgendas(meetingId, recap.decisionRefs, currentRecapId, recap.summary).catch(
    () => {},
  );
}

/** 규칙 폴백 — 미완료 할 일과 최근 결정 후속을 안건으로 */
function ruleBasedAgenda(ctx: AgentContext): AgendaItem[] {
  const items: AgendaItem[] = [];
  for (const t of ctx.todos.filter((t) => !t.done).slice(0, 3)) {
    items.push({ title: `"${t.title}" 진행 상황 공유`, why: `${t.author}의 미완료 할 일` });
  }
  if (items.length < 2 && ctx.decisions[0]) {
    items.push({
      title: `지난 결정 후속 점검 — ${ctx.decisions[0].decision.slice(0, 40)}`,
      why: '가장 최근 결정',
    });
  }
  return items.slice(0, 4);
}

async function aiAgenda(ctx: AgentContext, carryTitles: string[] = []): Promise<AgendaItem[]> {
  const system =
    `너는 분산 근무 플랫폼 exist의 AI 총무다. "${ctx.meetingTitle}" 그룹의 다음 회의 안건 초안을 만든다. ` +
    '아래 기록(통화 정리·결정·미완료 할 일·최근 대화)에서 아직 끝나지 않았거나 다음에 논의하기로 한 것만 골라 ' +
    '안건 2~4개를 제안한다. 기록에 없는 내용은 만들지 않는다.\n' +
    (carryTitles.length
      ? 'carryover_titles는 이미 안건으로 확정된 이월 안건 — 같은 내용을 다시 제안하지 않는다.\n'
      : '') +
    '각 안건: title(한국어 30자 이내, 명사형), why(근거 한 줄 20자 이내 — 어떤 기록에서 나왔는지).\n' +
    '응답은 오직 JSON: {"items": [{"title": string, "why": string}]}';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    ...samplingFor(OPENAI_MODEL, 0.3, 400),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({
          call_summaries: ctx.recaps.map((r) => r.summary),
          decisions: ctx.decisions.map((d) => d.decision),
          undone_todos: ctx.todos.filter((t) => !t.done).map((t) => `${t.title} (${t.author})`),
          recent_chat: ctx.chat.slice(-20).map((c) => `${c.from}: ${c.text}`),
          ...(carryTitles.length ? { carryover_titles: carryTitles } : {}),
        }),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = parseLlmJson(raw) as {
    items?: unknown;
  };
  if (!Array.isArray(parsed.items)) throw new Error('no items');
  // 프롬프트 재료의 내부 키 이름(undone_todos 등)이 답변에 새어 나오는 것 차단
  const stripKeys = (s: string) =>
    s
      .replace(/\s*\(?\b(undone_todos|call_summaries|recent_chat|carryover_titles|decisions)\b\)?/g, '')
      .replace(/\(\s*\)/g, '')
      .trim();
  const items = parsed.items
    .map((it) => ({
      title: stripKeys(String((it as AgendaItem).title ?? '')).slice(0, 60),
      why: stripKeys(String((it as AgendaItem).why ?? '')).slice(0, 40),
    }))
    .filter((it) => it.title)
    .slice(0, 4);
  if (items.length === 0) throw new Error('empty agenda');
  return items;
}

/** recap 생성 등 기록이 갱신되면 아젠다·이력 캐시를 버림 — 10분 캐시가 구버전 재료를 물고 있지 않게 */
export function invalidateAgenda(meetingId: number) {
  agendaCache.delete(meetingId);
  historyCache.delete(meetingId);
}

/* ── 변경 이력 뷰 — 같은 주제 결정의 변천 추적 (현직자 요구: "변경사항 이력 관리") ──
 * 저장 구조는 그대로 두고 조회 시점에 원장을 주제별 타임라인으로 묶는다.
 * 환각 방어: AI는 텍스트를 생성하지 않고 기존 결정의 인덱스만 반환 — 서버가 검증 후 원문 매핑.
 * AI 실패·키 없음 → 규칙 폴백(전체를 시간순 단일 타임라인으로). */

export interface HistoryEntry {
  recapId: number;
  idx: number;
  decision: string;
  why: string;
  ts: number;
}

export interface HistoryTopic {
  title: string;
  entries: HistoryEntry[]; // 시간순 오름차순 — 마지막이 현재 유효한 결정
}

export interface DecisionHistory {
  topics: HistoryTopic[];
  source: 'ai' | 'rule';
  generatedAt: number;
}

const historyCache = new Map<number, DecisionHistory>();
const HISTORY_CACHE_MS = 10 * 60_000;

async function aiGroupHistory(entries: HistoryEntry[]): Promise<HistoryTopic[]> {
  const system =
    '너는 분산 근무 플랫폼 exist의 AI 총무다. 팀의 결정 목록을 "같은 주제"끼리 묶어 변천 이력으로 정리한다.\n' +
    '입력은 결정 배열(i = 배열 인덱스, text, date). 출력은 오직 JSON: {"topics": [{"title": string, "indexes": number[]}]}.\n' +
    '규칙: 모든 인덱스는 정확히 한 topic에만 속한다. 같은 안건이 시간에 따라 바뀐 것(예: 출시일 변경, 방안 교체)을 한 topic으로 묶는 게 목적이다. ' +
    '관련 없는 단독 결정은 자기 혼자 topic이 된다. title은 주제를 나타내는 한국어 한 줄(20자 이내) — 입력에 없는 사실을 만들지 않는다. ' +
    'indexes는 입력의 i 값만 사용한다.';
  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    ...samplingFor(OPENAI_MODEL, 0.1, 600),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({
          decisions: entries.map((e, i) => ({
            i,
            text: e.decision,
            date: new Date(e.ts).toISOString().slice(0, 10),
          })),
        }),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = parseLlmJson(raw) as {
    topics?: unknown;
  };
  if (!Array.isArray(parsed.topics)) throw new Error('no topics');

  // 인덱스 검증 — 범위 밖·중복은 버리고, 누락된 결정은 "기타" 토픽으로 회수 (결정이 사라지면 안 됨)
  const used = new Set<number>();
  const topics: HistoryTopic[] = [];
  for (const t of parsed.topics as { title?: unknown; indexes?: unknown }[]) {
    const idxs = (Array.isArray(t.indexes) ? t.indexes : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n < entries.length && !used.has(n));
    if (idxs.length === 0) continue;
    idxs.forEach((n) => used.add(n));
    const es = idxs.map((n) => entries[n]).sort((a, b) => a.ts - b.ts);
    topics.push({ title: String(t.title ?? '').trim().slice(0, 40) || es[es.length - 1].decision.slice(0, 30), entries: es });
  }
  const missing = entries.filter((_, i) => !used.has(i));
  for (const e of missing) topics.push({ title: e.decision.slice(0, 30), entries: [e] });
  if (topics.length === 0) throw new Error('empty topics');
  // 최신 활동 순으로 정렬 (마지막 항목 ts 기준)
  topics.sort((a, b) => b.entries[b.entries.length - 1].ts - a.entries[a.entries.length - 1].ts);
  return topics;
}

export async function generateDecisionHistory(meetingId: number): Promise<DecisionHistory> {
  const cached = historyCache.get(meetingId);
  if (cached && Date.now() - cached.generatedAt < HISTORY_CACHE_MS) return cached;

  const entries: HistoryEntry[] = listDecisions(meetingId, 100)
    .map((d) => ({ recapId: d.recapId, idx: d.idx, decision: d.decision, why: d.why, ts: d.ts }))
    .sort((a, b) => a.ts - b.ts); // 시간순 오름차순 — id 순서와 시간이 어긋난 데이터도 안전

  let result: DecisionHistory;
  if (entries.length === 0) {
    result = { topics: [], source: 'rule', generatedAt: Date.now() };
  } else if (openai && entries.length > 1) {
    try {
      result = { topics: await aiGroupHistory(entries), source: 'ai', generatedAt: Date.now() };
    } catch (err) {
      console.error('[steward] 이력 그룹핑 AI 실패, 규칙 폴백:', err);
      result = { topics: [{ title: '전체 이력', entries }], source: 'rule', generatedAt: Date.now() };
    }
  } else {
    result = { topics: [{ title: '전체 이력', entries }], source: 'rule', generatedAt: Date.now() };
  }
  historyCache.set(meetingId, result);
  return result;
}

export async function generateAgenda(meetingId: number, channelId: number): Promise<Agenda> {
  const cached = agendaCache.get(meetingId);
  if (cached && Date.now() - cached.generatedAt < AGENDA_CACHE_MS) return cached;

  const ctx = gatherContext(meetingId, channelId);
  const carry = listCarryover(meetingId);
  let result: Agenda;
  if (openai) {
    try {
      const fresh = await aiAgenda(ctx, carry.map((c) => c.title));
      persistNewAgendaItems(meetingId, fresh); // 새 안건도 추적 시작 — 다음 recap에서 정산 대상
      result = { items: fresh, source: 'ai', generatedAt: Date.now() };
    } catch (err) {
      console.error('[steward] 아젠다 AI 실패, 규칙 폴백:', err);
      result = { items: ruleBasedAgenda(ctx), source: 'rule', generatedAt: Date.now() };
    }
  } else {
    result = { items: ruleBasedAgenda(ctx), source: 'rule', generatedAt: Date.now() };
  }
  // 이월 안건을 맨 위에 — 결론 못 낸 것부터 다시 상정. AI 신규 안건과 제목 중복은 신규 쪽을 버림
  const carrySet = new Set(carry.map((c) => normTitle(c.title)));
  result.items = [
    ...carry.map((c) => ({
      title: c.title,
      why: c.rounds >= 2 ? `${c.rounds}회째 안건 — 아직 결론 없음` : c.why,
      rounds: c.rounds,
      status: c.status,
      statusNote: c.status_note,
    })),
    ...result.items.filter((it) => !carrySet.has(normTitle(it.title))),
  ].slice(0, 5);
  // 영속된 안건에 id 부착 — 수동 종결(보류 안건 닫기)의 대상 식별자
  const idByTitle = new Map(
    (
      db
        .prepare('SELECT id, title FROM agenda_items WHERE meeting_id = ? AND resolved = 0')
        .all(meetingId) as { id: number; title: string }[]
    ).map((r) => [normTitle(r.title), r.id]),
  );
  result.items = result.items.map((it) => ({ ...it, id: idByTitle.get(normTitle(it.title)) }));
  // 유사한 과거 종결 안건 표시 — "예전에 이런 사유로 접었던 건" 선제 안내 (재검토 반복 방지).
  // RAG 실패 시 표시만 생략 — 안건 생성 자체는 영향 없음
  try {
    const closed = await findSimilarClosedAgenda(
      meetingId,
      result.items.map((it) => it.title),
    );
    result.items = result.items.map((it, i) => ({
      ...it,
      closedBefore: closed[i]?.text ?? null,
      closedBeforeId: closed[i]?.agendaId ?? null,
    }));
  } catch {
    /* 표시 생략 */
  }
  agendaCache.set(meetingId, result);
  return result;
}

/** 안건 수동 종결 — "다음에 보시죠"로 보류된 안건이 영원히 이월되는 것을 사람이 끊는 장치.
 *  AI 정산(settleAgendaAfterRecap)과 달리 결정 대응 없이도 닫는다.
 *  사유(선택)는 기록으로 남고 RAG 색인 — "검토했음/채택 안 함/이유"의 마지막 정리 (박형우 8/19) */
export function resolveAgendaItem(
  meetingId: number,
  itemId: number,
  note?: string | null,
  actorId?: number,
): boolean {
  const item = db
    .prepare('SELECT title FROM agenda_items WHERE id = ? AND meeting_id = ? AND resolved = 0')
    .get(itemId, meetingId) as { title: string } | undefined;
  if (!item) return false;
  const cleanNote = note?.trim().slice(0, 200) || null;
  const r = db
    .prepare(
      `UPDATE agenda_items SET resolved = 1, resolved_note = ?, updated_at = datetime('now')
       WHERE id = ? AND meeting_id = ? AND resolved = 0`,
    )
    .run(cleanNote, itemId, meetingId);
  if (r.changes > 0) {
    invalidateAgenda(meetingId); // 10분 캐시가 닫은 안건을 되살리지 않게
    indexAgendaResolution(meetingId, itemId, item.title, cleanNote);
    addAgendaEvent(meetingId, itemId, 'closed', cleanNote, actorId ?? null);
  }
  return r.changes > 0;
}

const AGENDA_STATUSES = ['waiting_dept', 'waiting_approval', 'hold'] as const;

/** 안건 멈춤 상태 — "지금 뭘 기다리고 있는지"의 가시화 (진행/완료 이분법 탈피, 박형우 8/19).
 *  null = 상태 없음(일반 미결) */
export function setAgendaStatus(
  meetingId: number,
  itemId: number,
  status: string | null,
  actorId?: number,
  note?: string | null,
): boolean {
  if (status !== null && !AGENDA_STATUSES.includes(status as (typeof AGENDA_STATUSES)[number]))
    return false;
  // 대기 조건("무엇을 기다리나") — 상태 해제 시 함께 비움. 보류 깨우기 매칭의 재료
  const cleanNote = status === null ? null : (note?.trim().slice(0, 120) || null);
  const r = db
    .prepare(
      `UPDATE agenda_items SET status = ?, status_note = ?, updated_at = datetime('now')
       WHERE id = ? AND meeting_id = ? AND resolved = 0`,
    )
    .run(status, cleanNote, itemId, meetingId);
  if (r.changes > 0) {
    invalidateAgenda(meetingId);
    addAgendaEvent(
      meetingId,
      itemId,
      'status',
      (status ?? 'none') + (cleanNote ? ` — ${cleanNote}` : ''),
      actorId ?? null,
    );
  }
  return r.changes > 0;
}

/* ── 보류 깨우기 — "기다리던 조건이 충족된 걸 아무도 모른다" 대응.
 * 새 recap의 결정들과 대기 중 안건(제목+대기 조건)을 임베딩 매칭해, 걸리면
 * 호스트·상태 지정자에게 "다시 올려볼까요" 알림 + 생애 타임라인에 감지 기록.
 * 확신 없으면 침묵(임계 0.42) — 잘못 깨우는 것보다 안 깨우는 게 낫다 */
const WAKE_MIN = 0.42;

export async function wakeWaitingAgendas(
  meetingId: number,
  decisionRefs: { text: string; recapId: number; idx: number }[],
  currentRecapId?: number | null,
  summary?: string | null,
): Promise<void> {
  // 매칭 후보 = 결정문들 + 회의 요약 — 결정문은 좁게 적혀 조건과 안 닿는 경우가 많다
  // (실측: "인증서는 다음 주 발급" 0.33 vs 요약 "품질 인증 최종 승인" 0.65)
  const candidates: { text: string; recapId: number | null }[] = decisionRefs.map((d) => ({
    text: d.text,
    recapId: d.recapId,
  }));
  if (summary?.trim()) candidates.push({ text: summary.trim(), recapId: currentRecapId ?? null });
  if (candidates.length === 0) return;
  const waiting = db
    .prepare(
      `SELECT id, title, status, status_note FROM agenda_items
       WHERE meeting_id = ? AND resolved = 0 AND status IS NOT NULL`,
    )
    .all(meetingId) as { id: number; title: string; status: string; status_note: string | null }[];
  if (waiting.length === 0) return;
  const { embedTexts } = await import('./rag.js'); // rag가 이 모듈을 물고 있어 동적 import (순환 회피)
  const itemTexts = waiting.map((w) => `${w.title}${w.status_note ? ` — ${w.status_note}` : ''}`);
  const vecs = await embedTexts([...itemTexts, ...candidates.map((c) => c.text)]);
  if (!vecs) return;
  const cos = (a: number[], b: number[]) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d > 0 ? dot / d : 0;
  };
  const meeting = db.prepare('SELECT code, title, host_id FROM meetings WHERE id = ?').get(meetingId) as
    | { code: string; title: string; host_id: number }
    | undefined;
  if (!meeting) return;
  const { notifyUser } = await import('./notify.js'); // 이 모듈의 기존 관례 (순환 회피)
  for (let i = 0; i < waiting.length; i++) {
    let best = -1;
    let bestScore = 0;
    for (let j = 0; j < candidates.length; j++) {
      const s = cos(vecs[i], vecs[waiting.length + j]);
      if (s > bestScore) {
        bestScore = s;
        best = j;
      }
    }
    if (best < 0 || bestScore < WAKE_MIN) continue;
    const w = waiting[i];
    const cand = candidates[best];
    const evRecapId = cand.recapId ?? currentRecapId ?? null;
    // recap당 1회 — 같은 정산에서 중복 감지 방지
    const dup = db
      .prepare(
        `SELECT 1 FROM agenda_events WHERE agenda_id = ? AND kind = 'wake' AND recap_id IS ?`,
      )
      .get(w.id, evRecapId);
    if (dup) continue;
    addAgendaEvent(
      meetingId,
      w.id,
      'wake',
      `기다리던 조건과 관련된 회의 내용 감지 — '${cand.text.slice(0, 120)}'`,
      null,
      evRecapId,
    );
    // 알림 대상 — 호스트 + 마지막으로 상태를 지정한 사람 (같으면 1명)
    const setter = db
      .prepare(
        `SELECT actor_id FROM agenda_events WHERE agenda_id = ? AND kind = 'status' AND actor_id IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(w.id) as { actor_id: number } | undefined;
    const targets = new Set<number>([meeting.host_id]);
    if (setter?.actor_id) targets.add(setter.actor_id);
    const statusKo =
      w.status === 'hold' ? '보류' : w.status === 'waiting_dept' ? '타부서 대기' : '승인 대기';
    for (const uid of targets) {
      notifyUser(uid, {
        from: 'exist AI',
        text: `${statusKo} 안건 '${w.title.slice(0, 40)}'이 기다리던 것과 관련된 내용이 올라왔어요: '${cand.text.slice(0, 60)}' — 다시 올려볼까요? ('${meeting.title}')`,
        kind: 'recap',
        meetingCode: meeting.code.toUpperCase(),
      });
    }
    console.log(`[steward] 보류 깨우기 — 안건 ${w.id} ← 결정 매칭 (score ${bestScore.toFixed(2)})`);
  }
}

/** io 최소 인터페이스 — 테스트에서 스텁 주입용 */
interface Broadcaster {
  to(room: string): { emit(event: string, payload: unknown): void };
}

/* ── 채팅 결정 감지 — 부르지 않아도 일하는 총무 ──
 * "~하기로 했다/확정/합의" 패턴이 걸리면 AI가 앞뒤 대화 문맥으로 판정한다:
 *   record  = 실제 합의가 명확 → 원장에 자동 기록 (사람에겐 취소라는 사후 거부권)
 *   suggest = 결정 같지만 확신 부족 → 기록할지 물어봄 (기존 동작)
 *   ignore  = 농담·가정·인용 → 침묵
 * AI 없거나 실패하면 suggest 폴백 — 자동 기록은 확신 있을 때만 (원장에 가짜가 섞이면 신뢰가 죽는다).
 * 과잉 개입 방지: 회의당 2분 쿨다운. */
export const DECISION_RX = /(하기로 (했|함|결정)|확정(했|입니다|이에요)|합의(했|됐)|결정(했|됐))/;
const DECISION_SUGGEST_PREFIX = '💡 결정 후보: ';
export const DECISION_AUTO_PREFIX = '🧾 결정 원장에 기록했어요: ';
const decisionCooldown = new Map<number, number>();
const DECISION_COOLDOWN_MS = 2 * 60 * 1000;

function postAgentChat(io: Broadcaster, meetingId: number, code: string, channelId: number, text: string) {
  db.prepare('INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)').run(
    meetingId,
    ensureAgentUser(),
    text,
    channelId,
  );
  io.to(`chat:${code.toUpperCase()}`).emit('chat:message', {
    code: code.toUpperCase(),
    from: AGENT_NAME,
    avatar: AGENT_AVATAR,
    text,
    channelId,
    ts: Date.now(),
  });
}

interface DecisionVerdict {
  verdict: 'record' | 'suggest' | 'ignore';
  decision: string;
  why: string;
}

/** 감지된 발언을 최근 대화 문맥과 함께 AI에 판정시킨다 — 정규식 오탐(농담·가정·인용) 걸러내기 */
async function judgeDecisionCandidate(
  meetingId: number,
  channelId: number,
  from: string,
  text: string,
): Promise<DecisionVerdict> {
  const recent = db
    .prepare(
      `SELECT u.username AS "from", m.text FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.meeting_id = ? AND m.user_id != ? AND (m.channel_id = ? OR m.channel_id IS NULL) AND m.text != ''
       ORDER BY m.id DESC LIMIT 12`,
    )
    .all(meetingId, ensureAgentUser(), channelId)
    .reverse() as { from: string; text: string }[];

  const system =
    '너는 분산 근무 플랫폼 exist의 AI 총무다. 팀 채팅에서 결정 패턴이 감지된 발언이 "팀이 실제로 합의·확정한 결정"인지 판정한다.\n' +
    '판정 기준:\n' +
    '- "record": 발언 자체가 확정 선언일 때 — "~하기로 결정했습니다/하기로 했습니다/확정합니다"처럼 완료형으로 선언하고, 문맥상 농담·가정·인용이 아니면 record. ' +
    '조직에서는 결정권자 한 명의 확정 선언도 결정이다 — 다른 참여자의 동의 발화를 요구하지 말 것.\n' +
    '- "suggest": 아직 제안·질문 단계("~할까요?", "~하는 게 어때요?")이거나, 확정인지 논의 중인지 문맥상 갈릴 때.\n' +
    '- "ignore": 농담·가정("만약 ~라면")·과거 회상·남의 말 인용·타 조직 이야기일 때.\n' +
    'decision은 원장 기록용 문장(발언 의미 그대로, 한국어 200자 이내, record/suggest일 때만). ' +
    'why는 문맥에 언급된 그 결정의 배경·이유 한 줄(60자 이내) — 문맥에 근거가 없으면 반드시 빈 문자열 "" (추측 금지).\n' +
    '응답은 오직 JSON: {"verdict": "record"|"suggest"|"ignore", "decision": string, "why": string}';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    ...samplingFor(OPENAI_MODEL, 0, 300),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({
          recent_chat: recent.map((c) => `${c.from}: ${c.text}`),
          flagged_message: `${from}: ${text}`,
        }),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = parseLlmJson(raw) as Partial<DecisionVerdict>;
  const verdict = parsed.verdict === 'record' || parsed.verdict === 'ignore' ? parsed.verdict : 'suggest';
  return {
    verdict,
    decision: String(parsed.decision ?? '').trim().slice(0, 200),
    why: String(parsed.why ?? '').trim().slice(0, 60),
  };
}

/** 확정 판정된 결정을 원장(1건짜리 recap, source='auto')에 기록하고 참가자에게 알린다 */
async function recordAutoDecision(
  args: { meetingId: number; code: string; from: string },
  d: { decision: string; why: string },
): Promise<number> {
  const info = db
    .prepare(
      `INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, actions, attendees, source)
       VALUES (?, ?, ?, ?, ?, ?, 'auto')`,
    )
    .run(
      args.meetingId,
      d.decision.slice(0, 80),
      JSON.stringify([d.decision]),
      JSON.stringify([d.why]),
      JSON.stringify([]),
      JSON.stringify([args.from]),
    );
  // RAG 색인 — 자동 기록도 의미 검색 대상 (dedup 후 원장의 대표 줄이 되는 경우가 많다)
  indexRecap(args.meetingId, info.lastInsertRowid as number, {
    summary: '',
    decisions: [d.decision],
    whys: [d.why],
    date: new Date().toISOString().slice(0, 10),
  });
  invalidateAgenda(args.meetingId);
  // 발언자 제외 참가자에게 알림 — 정적 import는 agent→sfu→steward 순환이라 동적 로드
  const { notifyUser } = await import('./notify.js');
  const { invalidateBrief } = await import('./agent.js');
  const speaker = db.prepare('SELECT id FROM users WHERE username = ?').get(args.from) as
    | { id: number }
    | undefined;
  const others = db
    .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND user_id != ?')
    .all(args.meetingId, speaker?.id ?? -1) as { user_id: number }[];
  for (const p of others) {
    notifyUser(p.user_id, {
      from: AGENT_NAME,
      text: `결정이 원장에 기록됐어요 — ${d.decision.slice(0, 60)}`,
      kind: 'recap',
      meetingCode: args.code.toUpperCase(),
    });
    invalidateBrief(p.user_id);
  }
  return info.lastInsertRowid as number;
}

export function maybeSuggestDecision(
  io: Broadcaster,
  args: { meetingId: number; code: string; channelId: number; from: string; text: string },
): void {
  if (AGENT_MENTION.test(args.text)) return; // @AI 질의는 답변 흐름이 따로 처리
  if (!DECISION_RX.test(args.text)) {
    maybeFlagStale(io, args); // 결정 선언이 아니면 — 옛 기준 언급인지 감시 (사후 누락 감지)
    return;
  }
  const last = decisionCooldown.get(args.meetingId) ?? 0;
  if (Date.now() - last < DECISION_COOLDOWN_MS) return;
  decisionCooldown.set(args.meetingId, Date.now());
  void handleDecisionCandidate(io, args).catch((err) =>
    console.error('[steward] 결정 감지 처리 실패:', err),
  );
}

/* ── 사후 누락 감지 — 대화에서 "이미 바뀐 기준"이 언급되면 AI가 끼어든다.
 * 전달이 새어나간 최후의 방어선: 야간조가 옛 기준으로 말하는 순간 원장이 반박한다.
 * 게이트(수치·기준 어휘) + 3분 쿨다운 + 2차 양립 검증으로 오탐·비용 통제 */
const staleCooldown = new Map<number, number>();
const STALE_COOLDOWN_MS = 3 * 60 * 1000;
const STALE_GATE = /(\d|기준|온도|사양|버전|일정|시각|납기|수량|부품|설정|파라미터|주기|업체)/;

function maybeFlagStale(
  io: Broadcaster,
  args: { meetingId: number; code: string; channelId: number; from: string; text: string },
): void {
  if (!openai) return;
  if (!STALE_GATE.test(args.text)) return;
  const last = staleCooldown.get(args.meetingId) ?? 0;
  if (Date.now() - last < STALE_COOLDOWN_MS) return;
  staleCooldown.set(args.meetingId, Date.now());
  void flagStaleCheck(io, args).catch((err) => console.error('[steward] 누락 감지 실패:', err));
}

/** 두 진술이 동시에 참일 수 있는가 — 모순 후보의 2차 검증 (복명복창과 같은 판별) */
export async function verifyIncompatible(a: string, b: string): Promise<boolean> {
  const v = await openai!.chat.completions.create({
    model: process.env.OPENAI_MODEL_JUDGE || 'gpt-4o',
    ...samplingFor(process.env.OPENAI_MODEL_JUDGE || 'gpt-4o', 0, 60),
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '두 문장이 논리적으로 동시에 참일 수 있는지 판단한다. 같은 속성(수치·요일·시각·업체·담당·기준)에 다른 값을 말할 때만 동시에 참일 수 없다. 응답은 오직 JSON: {"compatible": true|false}',
      },
      { role: 'user', content: JSON.stringify({ 문장A: a, 문장B: b }) },
    ],
  });
  const raw = v.choices[0]?.message?.content ?? '';
  const parsed = parseLlmJson(raw) as {
    compatible?: unknown;
  };
  return parsed.compatible === false;
}

async function flagStaleCheck(
  io: Broadcaster,
  args: { meetingId: number; code: string; channelId: number; from: string; text: string },
): Promise<void> {
  const recent = listDecisions(args.meetingId, 30).filter(
    (d) => Date.now() - d.ts < 14 * 86_400_000,
  );
  if (!recent.length) return;
  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    ...samplingFor(OPENAI_MODEL, 0, 200),
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '너는 exist의 AI 총무다. 팀원의 발언이 최근 결정과 모순되는 값(수치·요일·업체·기준)을 말하는지 본다.\n' +
          '모순일 때만: {"found": true, "message_part": 발언에서 모순된 부분 인용, "decision": 해당 결정 원문}\n' +
          '아니면 {"found": false}. 결정을 언급 안 하거나 무관한 잡담이면 무조건 false. 응답은 오직 JSON.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          decisions: recent.map((d) => d.decision),
          message: `${args.from}: ${args.text}`,
        }),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = parseLlmJson(raw) as {
    found?: unknown;
    message_part?: unknown;
    decision?: unknown;
  };
  if (parsed.found !== true) return;
  const part = String(parsed.message_part ?? '').trim();
  const decision = String(parsed.decision ?? '').trim();
  // 인용 실재 + 결정 실재 + 2차 양립 검증 — 3중 필터 후에만 끼어든다 (AI가 자주 틀리면 신뢰가 죽는다)
  if (!part || !decision) return;
  if (!args.text.replace(/\s+/g, '').includes(part.replace(/\s+/g, '').slice(0, 8))) return;
  if (!recent.some((d) => d.decision === decision)) return;
  if (!(await verifyIncompatible(decision, part))) return;
  postAgentChat(
    io,
    args.meetingId,
    args.code,
    args.channelId,
    `⚠️ 방금 말씀이 기록과 어긋날 수 있어요 — 원장 결정: "${decision.slice(0, 80)}" · 말씀: "${part.slice(0, 60)}". 기준이 바뀌었는지 확인해 주세요.`,
  );
}

async function handleDecisionCandidate(
  io: Broadcaster,
  args: { meetingId: number; code: string; channelId: number; from: string; text: string },
): Promise<void> {
  let judged: DecisionVerdict | null = null;
  if (openai) {
    try {
      judged = await judgeDecisionCandidate(args.meetingId, args.channelId, args.from, args.text);
    } catch (err) {
      console.error('[steward] 결정 판정 실패, 제안 폴백:', err); // 판정 불가 = 확신 없음 → suggest
    }
  }
  if (judged?.verdict === 'ignore') return;

  if (judged?.verdict === 'record' && judged.decision) {
    const id = await recordAutoDecision(args, judged);
    const whyPart = judged.why ? ` (배경: ${judged.why})` : '';
    postAgentChat(
      io,
      args.meetingId,
      args.code,
      args.channelId,
      `${DECISION_AUTO_PREFIX}"${judged.decision}"${whyPart} — 잘못 기록됐다면 취소할 수 있어요 #R${id}`,
    );
    return;
  }

  const quoted = (judged?.decision || args.text.trim()).slice(0, 160);
  postAgentChat(
    io,
    args.meetingId,
    args.code,
    args.channelId,
    `${DECISION_SUGGEST_PREFIX}"${quoted}" — ${args.from}님의 발언을 결정 원장에 기록할까요?`,
  );
}

/**
 * @AI 멘션 처리 — 기록 기반 답변을 만들어 그 채널에 exist AI 명의로 게시.
 * chat:send에서 비동기로 호출 (사용자 메시지 브로드캐스트를 막지 않음).
 */
export async function handleAgentQuery(
  io: Broadcaster,
  args: { meetingId: number; code: string; channelId: number; asker: string; text: string },
): Promise<void> {
  // 답 준비 중 표시 — 질문 직후의 침묵 방지 (답이 오면 chat:message가 표시를 대체)
  io.to(`chat:${args.code.toUpperCase()}`).emit('chat:ai-thinking', {
    code: args.code.toUpperCase(),
    channelId: args.channelId,
  });
  const ctx = gatherContext(args.meetingId, args.channelId);
  // 멘션 제거 후 앞에 남는 문장부호 정리 ("@AI, 알려줘" → "알려줘")
  const question =
    args.text.replace(AGENT_MENTION, '').replace(/^[\s,.!?~:;]+/, '').trim() || '지금 상황 요약해줘';

  let answer: string;
  if (openai) {
    try {
      // RAG — 최근 창(30건) 밖의 오래된 원장·문서를 질문 의미로 검색해 근거에 추가
      const related = await searchRag(args.meetingId, question).catch(() => []);
      answer = await aiAnswer(
        question,
        args.asker,
        ctx,
        related.map((r) => r.text),
      );
    } catch (err) {
      console.error('[steward] AI 실패, 규칙 폴백:', err);
      answer = ruleBasedAnswer(question, ctx);
    }
  } else {
    answer = ruleBasedAnswer(question, ctx);
  }

  const agentId = ensureAgentUser();
  db.prepare(
    'INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)',
  ).run(args.meetingId, agentId, answer, args.channelId);
  io.to(`chat:${args.code.toUpperCase()}`).emit('chat:message', {
    code: args.code.toUpperCase(),
    from: AGENT_NAME,
    avatar: AGENT_AVATAR,
    text: answer,
    channelId: args.channelId,
    ts: Date.now(),
  });
}
