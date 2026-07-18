import OpenAI from 'openai';
import db from './db.js';
import { listDecisions, listRecaps } from './recap.js';

/*
 * exist AI 총무 — 그룹 채팅에서 @AI 를 멘션하면 그 그룹의 기록
 * (결정 원장·통화 정리·할 일·최근 대화)을 근거로 답한다.
 * 원칙: 기록에 있는 것만 답하고, 없으면 없다고 말한다 (환각 방어).
 * OPENAI_API_KEY 없거나 실패 시 규칙 폴백 (최근 결정 나열).
 */

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export const AGENT_NAME = 'exist AI';
/** @AI, @ai, @총무 멘션 감지 — 문장 처음이나 공백 뒤의 독립 토큰만 (이메일 주소 오탐 방지) */
export const AGENT_MENTION = /(^|\s)@(ai|총무)(?=\s|$)/i;

/** 시스템 유저(exist AI) 확보 — 채팅 메시지의 발신자로 쓴다 (로그인 불가 더미 해시) */
export function ensureAgentUser(): number {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(AGENT_NAME) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const info = db
    .prepare("INSERT INTO users (username, pw_hash, pw_salt, avatar) VALUES (?, 'x', 'x', '🤖')")
    .run(AGENT_NAME);
  return info.lastInsertRowid as number;
}

interface AgentContext {
  meetingTitle: string;
  decisions: { decision: string; ts: number }[];
  recaps: { summary: string; ts: number }[];
  todos: { title: string; done: number; author: string }[];
  chat: { from: string; text: string }[];
}

function gatherContext(meetingId: number, channelId: number): AgentContext {
  const meeting = db.prepare('SELECT title FROM meetings WHERE id = ?').get(meetingId) as {
    title: string;
  };
  const decisions = listDecisions(meetingId, 30).map((d) => ({ decision: d.decision, ts: d.ts }));
  const recaps = listRecaps(meetingId, 5).map((r) => ({ summary: r.summary, ts: r.ts }));
  const todos = db
    .prepare(
      `SELECT t.title, t.done, u.username AS author FROM todos t
       JOIN users u ON u.id = t.user_id WHERE t.meeting_id = ? ORDER BY t.id DESC LIMIT 20`,
    )
    .all(meetingId) as { title: string; done: number; author: string }[];
  const chat = db
    .prepare(
      `SELECT u.username AS "from", m.text FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.meeting_id = ? AND (m.channel_id = ? OR m.channel_id IS NULL) AND m.text != ''
       ORDER BY m.id DESC LIMIT 30`,
    )
    .all(meetingId, channelId)
    .reverse() as { from: string; text: string }[];
  // 최근 통화 음성 전사도 근거에 포함
  const voice = db
    .prepare(
      `SELECT u.username AS "from", t.text FROM call_transcripts t
       JOIN users u ON u.id = t.user_id
       WHERE t.meeting_id = ? ORDER BY t.id DESC LIMIT 30`,
    )
    .all(meetingId)
    .reverse() as { from: string; text: string }[];
  return { meetingTitle: meeting.title, decisions, recaps, todos, chat: [...voice, ...chat] };
}

/** 규칙 폴백 — 질문 키워드에 따라 기록을 그대로 보여준다 */
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
  if (ctx.recaps.length > 0) {
    return `가장 최근 통화 정리예요: ${ctx.recaps[0].summary}`;
  }
  return '아직 이 그룹에 쌓인 결정·통화 기록이 없어서 답할 근거가 없어요.';
}

async function aiAnswer(question: string, asker: string, ctx: AgentContext): Promise<string> {
  const system =
    `너는 분산 근무 플랫폼 exist의 AI 총무다. "${ctx.meetingTitle}" 그룹에 상주하며 팀의 기록을 관리한다. ` +
    '아래 제공되는 그룹 기록(결정 원장·통화 정리·할 일·최근 대화)에 근거해서만 답한다. ' +
    '기록에 없는 내용은 추측하지 말고 "기록에 없다"고 답한다. 수치·사실을 만들지 않는다.\n' +
    '답변은 한국어로 간결하게(300자 이내), 필요하면 근거가 된 결정·대화를 짧게 인용한다. ' +
    '응답은 오직 JSON: {"answer": string}';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 400,
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
            recent_chat: ctx.chat.map((c) => `${c.from}: ${c.text}`),
          },
        }),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
    answer?: unknown;
  };
  const answer = String(parsed.answer ?? '').trim();
  if (!answer) throw new Error('empty answer');
  return answer.slice(0, 1000);
}

/** io 최소 인터페이스 — 테스트에서 스텁 주입용 */
interface Broadcaster {
  to(room: string): { emit(event: string, payload: unknown): void };
}

/**
 * @AI 멘션 처리 — 기록 기반 답변을 만들어 그 채널에 exist AI 명의로 게시.
 * chat:send에서 비동기로 호출 (사용자 메시지 브로드캐스트를 막지 않음).
 */
export async function handleAgentQuery(
  io: Broadcaster,
  args: { meetingId: number; code: string; channelId: number; asker: string; text: string },
): Promise<void> {
  const ctx = gatherContext(args.meetingId, args.channelId);
  const question = args.text.replace(AGENT_MENTION, '').trim() || '지금 상황 요약해줘';

  let answer: string;
  if (openai) {
    try {
      answer = await aiAnswer(question, args.asker, ctx);
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
    avatar: '🤖',
    text: answer,
    channelId: args.channelId,
    ts: Date.now(),
  });
}
