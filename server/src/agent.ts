import { Router } from 'express';
import OpenAI from 'openai';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { getRoomSize } from './sfu.js';

/*
 * exist AI agent — 사용자의 일정·투두 상태(목표 vs 현재)를 분석해
 * nowbar에 띄울 한 줄 브리핑 + 보여줄 카드를 결정한다.
 *
 * OPENAI_API_KEY가 있으면 OpenAI API, 없으면 규칙 기반 폴백.
 * (모델: OPENAI_MODEL, 기본 gpt-4o-mini)
 */

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

interface TodoRow {
  title: string;
  done: number;
  due_at: string | null;
}

interface MeetingRow {
  code: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  /** 지금 통화 중인 인원 (라이브) */
  in_call: number;
}

interface UserContext {
  now: Date;
  todos: TodoRow[];
  meetings: MeetingRow[];
}

export function getUserContext(userId: number): UserContext {
  const todos = db
    .prepare('SELECT title, done, due_at FROM todos WHERE user_id = ?')
    .all(userId) as TodoRow[];
  const meetings = (
    db
      .prepare(
        `SELECT m.code, m.title, m.starts_at, m.ends_at FROM meetings m
         JOIN meeting_participants mp ON mp.meeting_id = m.id
         WHERE mp.user_id = ?`,
      )
      .all(userId) as Omit<MeetingRow, 'in_call'>[]
  ).map((m) => ({ ...m, in_call: getRoomSize(m.code) }));
  return { now: new Date(), todos, meetings };
}

function minutesUntil(iso: string, now: Date): number {
  return Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
}

/** 규칙 기반 폴백 — API 키 없이도 의미 있는 브리핑 */
function ruleBasedBrief(ctx: UserContext): string {
  const { now, todos, meetings } = ctx;
  const undone = todos.filter((t) => !t.done);

  // 0순위 — 내 회의에서 지금 통화가 열려 있으면 알려준다
  const live = meetings
    .filter((m) => m.in_call > 0)
    .sort((a, b) => b.in_call - a.in_call)[0];
  if (live) {
    return `지금 "${live.title}"에서 ${live.in_call}명이 통화 중이에요`;
  }

  const ongoing = meetings.find(
    (m) =>
      m.starts_at &&
      m.ends_at &&
      new Date(m.starts_at) <= now &&
      now < new Date(m.ends_at),
  );
  if (ongoing) {
    return undone.length > 0
      ? `회의 진행 중 — 미완료 할 일 ${undone.length}개가 기다리고 있어요`
      : `회의 진행 중 — 할 일은 모두 완료된 상태예요`;
  }

  const upcoming = meetings
    .filter((m) => m.starts_at && new Date(m.starts_at) > now)
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime())[0];
  if (upcoming) {
    const min = minutesUntil(upcoming.starts_at!, now);
    if (min <= 60) {
      return undone.length > 0
        ? `"${upcoming.title}" ${min}분 전 — 미완료 할 일 ${undone.length}개 점검하세요`
        : `"${upcoming.title}" ${min}분 전 — 준비 완료 상태예요`;
    }
  }

  if (undone.length > 0) return `예정된 회의 없음 — 할 일 ${undone.length}개에 집중할 시간이에요`;
  return '오늘 할 일과 회의가 모두 정리됐어요';
}

export type CardId = 0 | 1 | 2; // 0=일정 1=할 일 2=진행 타임라인

/** 규칙 기반 카드 결정 — API 키 없거나 AI 실패 시 폴백 */
function ruleBasedDecision(ctx: UserContext): { card: CardId; reason: string } {
  const { now, todos, meetings } = ctx;
  const t = now.getTime();

  const ongoing = meetings.find(
    (m) => m.starts_at && m.ends_at && new Date(m.starts_at) <= now && now < new Date(m.ends_at),
  );
  if (ongoing) return { card: 2, reason: '회의가 진행 중이에요' };

  const pending = todos.filter((td) => !td.done);
  const dueSoon = pending.filter(
    (td) => td.due_at && new Date(td.due_at).getTime() <= t + 24 * 3600_000,
  );

  const upcoming = meetings
    .filter((m) => m.starts_at && new Date(m.starts_at).getTime() > t)
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime())[0];
  if (upcoming && minutesUntil(upcoming.starts_at!, now) <= 30) {
    return { card: 0, reason: '곧 시작하는 회의가 있어요' };
  }
  if (dueSoon.length > 0) return { card: 1, reason: '마감이 가까운 할 일이 있어요' };

  const todayUpcoming = meetings.some(
    (m) =>
      m.starts_at &&
      new Date(m.starts_at).getTime() > t &&
      new Date(m.starts_at).toDateString() === now.toDateString(),
  );
  if (todayUpcoming) return { card: 0, reason: '오늘 예정된 회의가 있어요' };
  if (pending.length > 0) return { card: 1, reason: '할 일이 남아 있어요' };
  return { card: 0, reason: '다가오는 일정을 보여드려요' };
}

/** 진행 중 회의가 없으면 card 2(타임라인)는 의미 없으니 보정 */
function hasOngoing(ctx: UserContext): boolean {
  const { now, meetings } = ctx;
  return meetings.some(
    (m) => m.starts_at && m.ends_at && new Date(m.starts_at) <= now && now < new Date(m.ends_at),
  );
}

/** 응답에서 첫 JSON 객체만 추출 (코드펜스·잡설 방어) */
function extractJson(raw: string): unknown {
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) throw new Error('no json');
  return JSON.parse(raw.slice(s, e + 1));
}

interface Decision {
  brief: string;
  card: CardId;
  reason: string;
}

/** OpenAI API 기반 — 브리핑 + 지금 보여줄 nowbar 카드를 함께 결정 */
async function aiDecision(ctx: UserContext): Promise<Decision> {
  const payload = {
    current_time: ctx.now.toISOString(),
    todos: ctx.todos.map((t) => ({ title: t.title, done: !!t.done, due_at: t.due_at })),
    meetings: ctx.meetings.map((m) => ({
      title: m.title,
      starts_at: m.starts_at,
      ends_at: m.ends_at,
      now_in_call: m.in_call, // 지금 통화 중인 인원 — 0이 아니면 가장 시급한 정보
    })),
  };

  const system =
    '너는 재택근무 플랫폼 exist의 AI 비서로, 상단 상태바(nowbar)를 관리한다. ' +
    'nowbar에는 카드 3개가 있고, 사용자의 일정·할 일 데이터를 보고 지금 가장 유용한 카드 하나를 고른다.\n' +
    '카드: 0 = 일정(다가오는·예정된 회의), 1 = 할 일(미완료 todo), 2 = 진행 타임라인(지금 진행 중인 회의의 진행도).\n' +
    '판단 기준: 지금 통화 중이거나 진행 중인 회의가 있으면 2. 곧 시작하는 회의가 임박하면 0. ' +
    '마감이 급한 할 일이 있으면 1. 그 외엔 사용자에게 가장 도움 되는 것. ' +
    '진행 중인 회의가 없으면 절대 2를 고르지 않는다.\n' +
    '응답은 오직 JSON 한 개. 형식: {"brief": string, "card": 0|1|2, "reason": string}. ' +
    'brief는 nowbar 한 줄 브리핑(한국어 50자 이내, 가장 시급한 것 하나, 인사말·이모지 없이). ' +
    'reason은 그 카드를 고른 이유(한국어 20자 이내). 데이터에 없는 수치·사실은 만들지 않는다.';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.3,
    max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '';
  if (!raw) throw new Error('empty AI response');

  const parsed = extractJson(raw) as { brief?: unknown; card?: unknown; reason?: unknown };
  const brief = String(parsed.brief ?? '').trim();
  let card = Number(parsed.card) as CardId;
  if (![0, 1, 2].includes(card)) card = 0;
  // 진행 중 회의 없는데 2를 골랐으면 룰 기반으로 보정
  if (card === 2 && !hasOngoing(ctx)) card = ruleBasedDecision(ctx).card;
  const reason = String(parsed.reason ?? '').trim() || ruleBasedDecision(ctx).reason;
  if (!brief) throw new Error('empty brief');
  return { brief, card, reason };
}

interface BriefResult {
  text: string;
  source: string;
  card: CardId;
  reason: string;
}

// 사용자별 브리핑 캐시 (2분 — 단 라이브 통화 인원이 바뀌면 즉시 무효)
const briefCache = new Map<number, BriefResult & { at: number; liveSig: string }>();
const CACHE_MS = 2 * 60 * 1000;

export async function generateBrief(userId: number): Promise<BriefResult> {
  const ctx = getUserContext(userId);
  const liveSig = ctx.meetings.map((m) => `${m.code}:${m.in_call}`).join(',');

  const cached = briefCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_MS && cached.liveSig === liveSig) {
    return { text: cached.text, source: cached.source, card: cached.card, reason: cached.reason };
  }

  let result: BriefResult;
  if (openai) {
    try {
      const d = await aiDecision(ctx);
      result = { text: d.brief, source: 'ai', card: d.card, reason: d.reason };
    } catch (err) {
      console.error('[agent] OpenAI API 실패, 규칙 기반 폴백:', err);
      const dec = ruleBasedDecision(ctx);
      result = { text: ruleBasedBrief(ctx), source: 'rule', card: dec.card, reason: dec.reason };
    }
  } else {
    const dec = ruleBasedDecision(ctx);
    result = { text: ruleBasedBrief(ctx), source: 'rule', card: dec.card, reason: dec.reason };
  }

  briefCache.set(userId, { ...result, at: Date.now(), liveSig });
  return result;
}

/** 투두/회의 변경 시 캐시 무효화용 */
export function invalidateBrief(userId: number) {
  briefCache.delete(userId);
}

const router = Router();
router.use(requireAuth);

router.get('/brief', async (req: AuthedRequest, res) => {
  const brief = await generateBrief(req.userId!);
  res.json(brief);
});

/** 개인 대시보드 요약 — 참여 회의·미완료 할 일·다음 일정·라이브 통화 */
router.get('/overview', (req: AuthedRequest, res) => {
  const ctx = getUserContext(req.userId!);
  const now = ctx.now.getTime();
  const undone = ctx.todos.filter((t) => !t.done);
  const overdue = undone.filter((t) => t.due_at && new Date(t.due_at).getTime() < now);
  const next = ctx.meetings
    .filter((m) => m.starts_at && new Date(m.starts_at).getTime() > now)
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime())[0];
  const u = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.userId!) as
    | { avatar?: string }
    | undefined;
  res.json({
    avatar: u?.avatar ?? '🐧',
    meetingCount: ctx.meetings.length,
    todoUndone: undone.length,
    todoOverdue: overdue.length,
    liveCalls: ctx.meetings
      .filter((m) => m.in_call > 0)
      .map((m) => ({ title: m.title, code: m.code, inCall: m.in_call })),
    recentMeetings: ctx.meetings
      .slice(0, 8)
      .map((m) => ({ title: m.title, code: m.code, inCall: m.in_call })),
    nextMeeting: next ? { title: next.title, code: next.code, startsAt: next.starts_at } : null,
  });
});

export default router;
