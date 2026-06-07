import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { getRoomSize } from './sfu.js';

/*
 * exist AI agent — 사용자의 일정·투두 상태(목표 vs 현재)를 분석해
 * nowbar에 띄울 한 줄 브리핑을 생성한다.
 *
 * ANTHROPIC_API_KEY가 있으면 Claude API, 없으면 규칙 기반 폴백.
 */

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

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

/** Claude API 기반 브리핑 */
async function aiBrief(ctx: UserContext): Promise<string> {
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

  const response = await anthropic!.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system:
      '너는 재택근무 플랫폼 exist의 AI 비서다. 사용자의 일정과 할 일 데이터를 보고 ' +
      'nowbar(상단 상태바)에 띄울 브리핑을 정확히 한 줄, 한국어로 생성한다. ' +
      '규칙: 50자 이내. 주어진 데이터에 없는 수치·사실을 만들지 않는다. ' +
      '가장 시급한 것(임박한 회의, 미완료 할 일) 하나에 집중한다. 인사말·이모지 없이 본문만.',
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('empty AI response');
  return text;
}

// 사용자별 브리핑 캐시 (2분 — 단 라이브 통화 인원이 바뀌면 즉시 무효)
const briefCache = new Map<number, { text: string; source: string; at: number; liveSig: string }>();
const CACHE_MS = 2 * 60 * 1000;

export async function generateBrief(userId: number): Promise<{ text: string; source: string }> {
  const ctx = getUserContext(userId);
  const liveSig = ctx.meetings.map((m) => `${m.code}:${m.in_call}`).join(',');

  const cached = briefCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_MS && cached.liveSig === liveSig) {
    return { text: cached.text, source: cached.source };
  }
  let text: string;
  let source: string;
  if (anthropic) {
    try {
      text = await aiBrief(ctx);
      source = 'ai';
    } catch (err) {
      console.error('[agent] Claude API 실패, 규칙 기반 폴백:', err);
      text = ruleBasedBrief(ctx);
      source = 'rule';
    }
  } else {
    text = ruleBasedBrief(ctx);
    source = 'rule';
  }

  briefCache.set(userId, { text, source, at: Date.now(), liveSig });
  return { text, source };
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

export default router;
