import { Router } from 'express';
import OpenAI from 'openai';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { isMember } from './orgs.js';

/*
 * exist 팀 인사이트 — 조직의 협업 데이터(회의·할 일·통화·채팅)를 집계하고
 * AI가 팀 상태를 진단(요약·리스크·추천)한다.
 * OPENAI_API_KEY 있으면 OpenAI, 없으면 규칙 기반 폴백. (agent.ts와 동일 패턴)
 * GET /api/insights/:orgId  — 해당 조직의 active 멤버만.
 */

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const PERIOD_DAYS = 14;
// ESG 환산 계수 (공신력 출처 — 임의 수치 아님):
//  - 왕복 통근 17.3km·73분: 2024년 통신3사 모바일 데이터 기반 직장인 출퇴근 평균(이투데이/국민일보)
//  - 승용차 125.2g CO₂/km: 환경부·국립환경과학원 2020년 승용 평균 실배출량
const COMMUTE_ROUND_KM = 17.3;
const COMMUTE_ROUND_MIN = 73;
const CAR_CO2_G_PER_KM = 125.2;

interface OrgMetrics {
  orgName: string;
  periodDays: number;
  memberCount: number;
  meetingCount: number;
  todos: { total: number; done: number; overdue: number; completionRate: number };
  calls: { count: number; totalMinutes: number };
  activity: { calls: number; messages: number };
  participation: { username: string; messages: number }[];
  quietMembers: string[];
  esg: {
    replacedCommutes: number; // 원격근무 person-day 추정(통근 대체 횟수)
    savedKm: number;
    savedCo2Kg: number;
    savedHours: number;
  };
}

function collectOrgMetrics(orgId: number): OrgMetrics | null {
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId) as
    | { name: string }
    | undefined;
  if (!org) return null;

  const since = new Date(Date.now() - PERIOD_DAYS * 86_400_000).toISOString();
  const sinceDate = since.slice(0, 10);

  const meetings = db.prepare('SELECT id FROM meetings WHERE org_id = ?').all(orgId) as {
    id: number;
  }[];
  const mids = meetings.map((m) => m.id);
  const ph = mids.map(() => '?').join(',');

  const members = db
    .prepare(
      `SELECT u.username FROM organization_members om
       JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ? AND om.status = 'active'`,
    )
    .all(orgId) as { username: string }[];

  // 할 일 진척 (조직 회의에 속한 todo)
  const todoRows = mids.length
    ? (db
        .prepare(`SELECT done, due_at FROM todos WHERE meeting_id IN (${ph})`)
        .all(...mids) as { done: number; due_at: string | null }[])
    : [];
  const total = todoRows.length;
  const done = todoRows.filter((t) => t.done).length;
  const now = Date.now();
  const overdue = todoRows.filter(
    (t) => !t.done && t.due_at && new Date(t.due_at).getTime() < now,
  ).length;

  // 통화 이벤트 (기간 내) — 횟수·총 시간(분)
  const callRows = mids.length
    ? (db
        .prepare(
          `SELECT time, end_time FROM meeting_events
           WHERE meeting_id IN (${ph}) AND is_call = 1 AND date >= ?`,
        )
        .all(...mids, sinceDate) as { time: string | null; end_time: string | null }[])
    : [];
  let totalMinutes = 0;
  for (const c of callRows) {
    if (c.time && c.end_time) {
      const [sh, sm] = c.time.split(':').map(Number);
      const [eh, em] = c.end_time.split(':').map(Number);
      const d = eh * 60 + em - (sh * 60 + sm);
      if (d > 0) totalMinutes += d;
    }
  }

  // 채팅 활동 + 멤버별 참여 분포 (기간 내)
  const msgRows = mids.length
    ? (db
        .prepare(
          `SELECT u.username AS username, COUNT(*) AS cnt FROM messages msg
           JOIN users u ON u.id = msg.user_id
           WHERE msg.meeting_id IN (${ph}) AND msg.created_at >= ?
           GROUP BY msg.user_id`,
        )
        .all(...mids, since) as { username: string; cnt: number }[])
    : [];
  const messages = msgRows.reduce((s, r) => s + r.cnt, 0);
  const active = new Set(msgRows.map((r) => r.username));
  const quietMembers = members.map((m) => m.username).filter((u) => !active.has(u));

  // ESG: 원격근무 person-day 추정 = 회의에 참여한 (멤버, 날짜) 고유 수
  // (exist로 원격 회의한 날 = 출근 1회 대체로 가정 — SKT 사회적 가치 환산 방법론)
  const replaced = mids.length
    ? (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM (
               SELECT DISTINCT mp.user_id, date(mp.joined_at) AS d
               FROM meeting_participants mp
               WHERE mp.meeting_id IN (${ph}) AND mp.joined_at >= ?
             )`,
          )
          .get(...mids, since) as { n: number }
      ).n
    : 0;
  const savedKm = Math.round(replaced * COMMUTE_ROUND_KM * 10) / 10;
  const savedCo2Kg = Math.round(((savedKm * CAR_CO2_G_PER_KM) / 1000) * 10) / 10;
  const savedHours = Math.round(((replaced * COMMUTE_ROUND_MIN) / 60) * 10) / 10;

  return {
    orgName: org.name,
    periodDays: PERIOD_DAYS,
    memberCount: members.length,
    meetingCount: mids.length,
    todos: {
      total,
      done,
      overdue,
      completionRate: total ? Math.round((done / total) * 100) : 0,
    },
    calls: { count: callRows.length, totalMinutes },
    activity: { calls: callRows.length, messages },
    participation: msgRows
      .map((r) => ({ username: r.username, messages: r.cnt }))
      .sort((a, b) => b.messages - a.messages),
    quietMembers,
    esg: { replacedCommutes: replaced, savedKm, savedCo2Kg, savedHours },
  };
}

interface Insights {
  summary: string;
  risks: string[];
  recommendations: string[];
}

/** 규칙 기반 폴백 — API 키 없거나 AI 실패 시 */
function ruleBasedInsights(m: OrgMetrics): Insights {
  const risks: string[] = [];
  const recs: string[] = [];

  if (m.todos.total > 0 && m.todos.completionRate < 50)
    risks.push(`할 일 완료율 ${m.todos.completionRate}%로 낮음`);
  if (m.todos.overdue > 0) risks.push(`마감 지난 미완료 할 일 ${m.todos.overdue}건`);
  if (m.quietMembers.length > 0)
    risks.push(`최근 ${m.periodDays}일 활동 없는 멤버 ${m.quietMembers.length}명`);

  if (m.todos.overdue > 0) recs.push('마감 지난 할 일부터 점검하세요');
  if (m.quietMembers.length > 0) recs.push('참여 저조 멤버와 진행상황 동기화 필요');
  if (m.meetingCount > 0 && m.activity.messages === 0)
    recs.push('비동기 소통(채팅/문서) 활용을 늘려보세요');

  const summary =
    `최근 ${m.periodDays}일 동안 회의 ${m.meetingCount}개, 할 일 완료율 ` +
    `${m.todos.completionRate}%(${m.todos.done}/${m.todos.total}), 통화 ${m.calls.count}회 진행됐습니다.`;
  return { summary, risks, recommendations: recs };
}

async function aiInsights(m: OrgMetrics): Promise<Insights> {
  const system =
    '너는 재택근무 플랫폼 exist의 팀 분석 AI다. 조직의 협업 데이터 집계치를 보고 팀 상태를 진단한다.\n' +
    '응답은 오직 JSON 하나. 형식: {"summary": string, "risks": string[], "recommendations": string[]}.\n' +
    'summary: 팀 상태 2~3문장 요약(한국어). risks: 데이터에서 드러난 리스크(각 40자 이내, 최대 4개, 없으면 빈 배열). ' +
    'recommendations: 실행 가능한 제안(각 40자 이내, 최대 3개).\n' +
    '반드시 주어진 수치에 근거하고, 데이터에 없는 사실·수치는 지어내지 않는다.';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.3,
    max_tokens: 500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(m) },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '';
  if (!raw) throw new Error('empty AI response');
  const parsed = JSON.parse(raw) as Partial<Insights>;
  const fallback = ruleBasedInsights(m);
  return {
    summary: String(parsed.summary ?? '').trim() || fallback.summary,
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).slice(0, 4) : [],
    recommendations: Array.isArray(parsed.recommendations)
      ? parsed.recommendations.map(String).slice(0, 3)
      : [],
  };
}

// 조직별 캐시 (5분) — OpenAI 호출 비용/지연 절감
const cache = new Map<number, { at: number; payload: unknown }>();
const CACHE_MS = 5 * 60 * 1000;

const router = Router();
router.use(requireAuth);

router.get('/:orgId', async (req: AuthedRequest, res) => {
  const orgId = Number(req.params.orgId);
  if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직' });
  if (!isMember(orgId, req.userId!))
    return res.status(403).json({ error: '조직 멤버가 아닙니다' });

  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.at < CACHE_MS) return res.json(cached.payload);

  const metrics = collectOrgMetrics(orgId);
  if (!metrics) return res.status(404).json({ error: '조직을 찾을 수 없습니다' });

  let insights: Insights;
  let source = 'rule';
  if (openai) {
    try {
      insights = await aiInsights(metrics);
      source = 'ai';
    } catch (e) {
      console.error('[insights] OpenAI 실패, 규칙 기반 폴백:', e);
      insights = ruleBasedInsights(metrics);
    }
  } else {
    insights = ruleBasedInsights(metrics);
  }

  const payload = { metrics, insights, source };
  cache.set(orgId, { at: Date.now(), payload });
  res.json(payload);
});

export default router;
