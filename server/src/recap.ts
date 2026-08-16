import OpenAI from 'openai';
import db from './db.js';
import { notifyUser, emitToUser } from './notify.js';
import { invalidateBrief } from './agent.js';
import { invalidateAgenda, ensureAgentUser, settleAgendaAfterRecap } from './steward.js';
import { transcribeMeetingAudio } from './stt.js';
import { extractFileText } from './fileai.js';

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
// 회의 후 원음 재전사 (stt.ts) — recap 재료의 품질을 Web Speech 위로 끌어올린다
/** 방이 비워진 뒤 이만큼 기다렸다 요약 — 새로고침·재입장이면 취소 (데모 땐 env로 줄임) */
const GRACE_MS = Number(process.env.RECAP_GRACE_MS ?? 30_000);
/** 요약할 최소 메시지 수 — 미만이면 조용히 스킵 */
const MIN_MESSAGES = 2;

export interface RecapAction {
  assignee: string | null; // 참여자 username 또는 null
  title: string;
}

/** 로그에서 명시적으로 합의된 다음 회의 시각 — AI 제안일 뿐, 등록은 사람이 버튼으로 확정 */
export interface NextMeeting {
  title: string;
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM
  registered?: boolean; // 일정으로 등록 완료 (RecapPanel 버튼)
}

export interface RecapResult {
  summary: string;
  decisions: string[];
  /** 결정별 배경 한 줄 (decisions와 인덱스 정렬, 로그에 근거 없으면 '') —
   *  실무자 인터뷰 반영: "결정 내용은 남는데 왜 그렇게 됐는지는 유실된다" */
  whys: string[];
  /** 결정별 검토된 대안 ("대안 — 기각 사유" 한 줄씩, decisions와 인덱스 정렬) —
   *  실무자 인터뷰 반영: 기각된 대안의 기록이 없어 나중에 같은 검토를 처음부터 반복한다 */
  alts: string[][];
  actions: RecapAction[];
  nextMeeting: NextMeeting | null;
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
    // 부정·유보 표현 오탐 방지 — "아직 결정 안 됐어요", "확정은 다음에"가 결정으로 박히면
    // API 장애 폴백이 가짜 결정을 원장에 넣는다 (불참자 배달까지 이어지는 최악 경로)
    const negated = /(아직|보류|다음에|나중에|미정|않|안\s|안됐|안 됐|못\s|못했|없)/.test(text);
    if (!negated && /(하기로|결정|확정|합의|정했)/.test(text) && decisions.length < 5) {
      decisions.push(`${m.from}: ${text.slice(0, 120)}`);
      continue;
    }
    // 할 일 신호: 마감·요청 표현 + "~게요/~겠습니다"류 자기 약속 어미
    const done = /(했어요|했습니다|끝냈|완료했)/.test(text); // 완료 보고는 할 일이 아니다
    if (!done && /(까지|해주세요|해 주세요|부탁|겠습니다|[가-힣]게요|담당)/.test(text) && actions.length < 5) {
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
  // 규칙 기반은 날짜 해석이 위험해서(오해석 → 엉뚱한 일정) 다음 회의 제안은 AI 경로에서만.
  // 배경 추론도 AI 경로에서만 — 규칙으로 "왜"를 짚으면 오염 위험
  // 대안 추출도 AI 경로에서만 — 규칙으로 "기각된 안"을 짚으면 오염 위험
  return { summary, decisions, whys: decisions.map(() => ''), alts: decisions.map(() => []), actions, nextMeeting: null, source: 'rule' };
}

/** 결정 문장 정규화 — 화자 프리픽스·따옴표·공백 제거 + 종결어미 절단 (이중 기입 비교용) */
export function normalizeDecision(s: string): string {
  return s
    .replace(/^[^:]{1,14}:\s*/, '') // 규칙 폴백의 "화자: " 프리픽스
    .replace(/["'“”‘’()[\]]/g, '')
    .replace(/\s+/g, '')
    .replace(
      /(하기로결정했(다|습니다|어요)|하기로했(다|습니다|어요|음)|하기로함|하기로한다|하기로합니다|로결정했(다|습니다)|결정했(다|습니다)|했(다|습니다)|한다|합니다)[.!~…]*$/,
      '',
    )
    .replace(/[.!?~…]+$/g, '');
}

/** 같은 결정인가 — 정규화 후 동일·포함이거나 2글자 조각(bigram) 자카드 ≥ 0.6.
 *  기준 미달이면 무조건 다른 결정으로 판정 (중복 2줄이 남는 게 다른 결정을 지우는 것보다 낫다) */
export function sameDecision(a: string, b: string): boolean {
  const na = normalizeDecision(a);
  const nb = normalizeDecision(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const grams = (s: string) => {
    const g = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const ga = grams(na);
  const gb = grams(nb);
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  const union = ga.size + gb.size - inter;
  return union > 0 && inter / union >= 0.6;
}

/** OpenAI 기반 추출 — 결정·할 일·요약을 JSON으로 */
async function aiRecap(
  msgs: ChatMsg[],
  participants: string[],
  docContext?: string,
): Promise<RecapResult> {
  const system =
    '너는 분산 근무 플랫폼 exist의 AI 운영자다. 회의 채팅 로그에서 팀이 합의한 결정과 할 일을 추출한다. ' +
    '이 결과는 회의에 참석하지 못한 팀원에게 그대로 전달되므로, 로그에 없는 사실·수치를 만들지 않는다.\n' +
    '응답은 오직 JSON 한 개. 형식: {"summary": string, "decisions": [{"text": string, "why": string, "alternatives": string[]}], "actions": [{"assignee": string|null, "title": string}], "next_meeting": {"title": string, "date": "YYYY-MM-DD", "time": "HH:MM"|null} | null}.\n' +
    'summary는 논의 핵심 한 줄(한국어 80자 이내). decisions는 실제로 합의·확정된 것만(최대 5개, 없으면 빈 배열). ' +
    'decisions[].why는 그 결정의 배경·근거 한 줄(한국어 60자 이내) — 로그에서 언급된 이유만 담고, 로그에 근거가 없으면 반드시 빈 문자열 "" (추측 금지). ' +
    'decisions[].alternatives는 그 결정에 이르며 검토됐지만 채택되지 않은 다른 안 — "대안 내용 — 기각·보류 사유" 형식 한 줄씩(각 80자 이내, 최대 3개). 로그에서 실제로 언급된 대안만, 없으면 빈 배열 (추측 금지). ' +
    'actions는 구체적인 할 일(최대 5개). assignee는 반드시 participants 목록의 username 중 하나이거나, 로그로 담당자를 특정할 수 없으면 null.\n' +
    'next_meeting은 다음 회의 시각이 로그에서 명시적으로 제안·합의된 경우에만 채운다. ' +
    '상대 표현(내일, 수요일, 다음 주 금요일)은 요일을 직접 계산하지 말고 반드시 calendar 목록에서 해당 요일의 가장 가까운 날짜를 찾아 쓴다. ' +
    '할 일의 기한("화요일까지 정리")은 회의 날짜가 아니다 — 회의 자체를 그 날짜에 하자고 말한 경우가 아니면 그 날짜를 next_meeting에 재사용하지 않는다. ' +
    '"다음 회의에서 보시죠"처럼 날짜 없는 언급, 날짜를 특정할 수 없는 표현("조만간", "나중에"), 언급 자체가 없으면 반드시 null — 추측 금지. 시각 언급이 없으면 time만 null.' +
    (docContext
      ? '\ndocs는 이 회의 중 참가자들이 열람한 문서의 발췌다 — 용어의 올바른 표기와 논의 맥락을 파악하는 참고자료로만 쓴다. 결정·할 일·요약은 반드시 chat 로그에서만 추출한다 (문서에만 있는 내용을 결정으로 만들지 않는다).'
      : '');

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
          // 상대 날짜("수요일") 해석 기준 — 모델이 요일 산수를 틀리므로 2주치 달력을 주고 찾게 한다
          now: `${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16)} (${new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'short' })})`,
          calendar: Array.from({ length: 14 }, (_, i) => {
            const d = new Date(Date.now() + i * 86_400_000);
            return `${d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })} (${d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'short' })})`;
          }),
          participants,
          chat: msgs.map((m) => `${m.from}: ${m.text}`),
          ...(docContext ? { docs: docContext } : {}),
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
    next_meeting?: unknown;
  };

  const names = new Set(participants);
  const summary = String(parsed.summary ?? '').trim().slice(0, 160);
  if (!summary) throw new Error('empty summary');
  // 결정 파싱 — 새 형식({text, why, alternatives})과 구 형식(string) 모두 수용 (모델이 형식을 놓칠 수 있음)
  const decisions: string[] = [];
  const whys: string[] = [];
  const alts: string[][] = [];
  for (const d of (Array.isArray(parsed.decisions) ? parsed.decisions : []).slice(0, 5)) {
    if (d && typeof d === 'object') {
      const o = d as { text?: unknown; why?: unknown; alternatives?: unknown };
      const text = String(o.text ?? '').trim();
      if (!text) continue;
      decisions.push(text.slice(0, 200));
      whys.push(String(o.why ?? '').trim().slice(0, 160));
      alts.push(
        (Array.isArray(o.alternatives) ? o.alternatives : [])
          .map((a) => String(a).trim().slice(0, 120))
          .filter(Boolean)
          .slice(0, 3),
      );
    } else {
      const text = String(d).trim();
      if (!text) continue;
      decisions.push(text.slice(0, 200));
      whys.push('');
      alts.push([]);
    }
  }
  const actions: RecapAction[] = (Array.isArray(parsed.actions) ? parsed.actions : [])
    .map((a) => {
      const o = a as { assignee?: unknown; title?: unknown };
      const assignee = typeof o.assignee === 'string' && names.has(o.assignee) ? o.assignee : null;
      return { assignee, title: String(o.title ?? '').trim().slice(0, 160) };
    })
    .filter((a) => a.title)
    .slice(0, 5);

  // 다음 회의 제안 — 형식 검증 + 과거 날짜 거부 + 날짜 근거 게이트 (틀린 제안이 일정으로 박히는 게 최악이라 보수적으로)
  // 근거 게이트: 원문에 날짜 표현이 하나도 없으면 AI가 어떤 날짜를 내놓든 버린다 —
  // "다음 회의에서 보시죠"만 듣고 프롬프트를 뚫고 날짜를 창작하는 사례가 실측됨 (8/15)
  let nextMeeting: NextMeeting | null = null;
  const nm = parsed.next_meeting as { title?: unknown; date?: unknown; time?: unknown } | null;
  const hasDateHint = msgs.some((m) =>
    /내일|모레|글피|다음\s?주|담\s?주|차주|이번\s?주|주말|[월화수목금토일]요일|\d{1,2}\s?월\s?\d{1,2}\s?일|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}일(?=[^가-힣]|$|에|께|쯤|까지|로)/.test(
      m.text,
    ),
  );
  if (nm && typeof nm === 'object' && hasDateHint) {
    const date = String(nm.date ?? '');
    const time = nm.time == null ? null : String(nm.time);
    const todayKst = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      (time === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) &&
      date >= todayKst
    ) {
      nextMeeting = { title: String(nm.title ?? '').trim().slice(0, 80) || '다음 회의', date, time };
    }
  }
  return { summary, decisions, whys, alts, actions, nextMeeting, source: 'ai' };
}

/** 관련성 추론 — ①작업 기준을 직접 바꾸는 🔴 결정(인덱스) ②그 영향을 받는 참가자.
 *  실패·불확실 시 빈 집합 = 일반 톤 (오탐이 미탐보다 나쁘다) */
async function inferCritical(
  decisions: string[],
  members: { id: number; username: string; position: string | null; department: string | null }[],
): Promise<{ userIds: Set<number>; decisionIdx: Set<number> }> {
  const empty = { userIds: new Set<number>(), decisionIdx: new Set<number>() };
  if (!openai || decisions.length === 0) return empty;
  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      max_tokens: 250,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            '너는 exist의 AI 총무다. 회의 결정 목록을 보고 두 가지를 고른다.\n' +
            '1) critical_decisions: 현장의 작업 방식·기준·수치·설비 조건·안전을 직접 바꾸는 결정의 인덱스(0부터). 일정 잡기·자료 공유 같은 운영성 결정은 제외.\n' +
            '2) critical_users: 그 결정이 작업 기준을 바꾸는 참가자 username (직무 정보가 없거나 판단이 안 서면 빈 배열).\n' +
            '응답은 오직 JSON: {"critical_decisions": number[], "critical_users": [username]}',
        },
        {
          role: 'user',
          content: JSON.stringify({
            decisions: decisions.map((d, i) => `${i}: ${d}`),
            members: members.map((m) => ({
              username: m.username,
              position: m.position ?? '',
              department: m.department ?? '',
            })),
          }),
        },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      critical_decisions?: unknown;
      critical_users?: unknown;
    };
    const names = new Set(
      (Array.isArray(parsed.critical_users) ? parsed.critical_users : []).map((n) => String(n)),
    );
    const idx = new Set(
      (Array.isArray(parsed.critical_decisions) ? parsed.critical_decisions : [])
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < decisions.length),
    );
    return {
      userIds: new Set(members.filter((m) => names.has(m.username)).map((m) => m.id)),
      decisionIdx: idx,
    };
  } catch (err) {
    console.error('[recap] 관련성 추론 실패 — 일반 톤 폴백:', err);
    return empty;
  }
}

/** 추출 (AI → 실패 시 규칙 폴백) */
export async function extractRecap(
  msgs: ChatMsg[],
  participants: string[],
  docContext?: string,
): Promise<RecapResult> {
  if (openai) {
    try {
      return await aiRecap(msgs, participants, docContext);
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
  /** 결정별 배경 (decisions와 인덱스 정렬, 없으면 '') */
  whys: string[];
  /** 결정별 검토된 대안 (없으면 빈 배열) */
  alts: string[][];
  actions: RecapAction[];
  attendees: string[];
  nextMeeting: NextMeeting | null;
  source: string;
  ts: number;
  /** 이 기록이 열린 일정 이벤트 — 즉석 회의면 null */
  eventId: number | null;
  /** 이 회의(요약 창) 동안 열람·편집된 문서들 — 회의↔공동편집 다리 */
  files: { id: number; name: string; type: string }[];
}

/** whys 컬럼 파싱 — 구 데이터(null)는 decisions 길이만큼 빈 문자열로 */
function parseWhys(raw: string | null, count: number): string[] {
  let whys: string[] = [];
  try {
    whys = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    whys = [];
  }
  return Array.from({ length: count }, (_, i) => String(whys[i] ?? ''));
}

/** alts 컬럼 파싱 — 구 데이터(null)는 decisions 길이만큼 빈 배열로 */
function parseAlts(raw: string | null, count: number): string[][] {
  let alts: string[][] = [];
  try {
    alts = raw ? (JSON.parse(raw) as string[][]) : [];
  } catch {
    alts = [];
  }
  return Array.from({ length: count }, (_, i) =>
    Array.isArray(alts[i]) ? alts[i].map(String) : [],
  );
}

/** 회의의 recap 목록 (최신순) — API·클라 표시용 */
export function listRecaps(meetingId: number, limit = 20): RecapRow[] {
  const rows = db
    .prepare(
      `SELECT id, summary, decisions, whys, alts, actions, attendees, next_meeting, source, created_at, event_id, files
       FROM meeting_recaps WHERE meeting_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(meetingId, limit) as {
    id: number;
    summary: string;
    decisions: string;
    whys: string | null;
    alts: string | null;
    actions: string;
    attendees: string;
    next_meeting: string | null;
    source: string;
    created_at: string;
    event_id: number | null;
    files: string | null;
  }[];
  return rows.map((r) => {
    const decisions = JSON.parse(r.decisions) as string[];
    return {
      id: r.id,
      summary: r.summary,
      decisions,
      whys: parseWhys(r.whys, decisions.length),
      alts: parseAlts(r.alts, decisions.length),
      actions: JSON.parse(r.actions),
      attendees: JSON.parse(r.attendees),
      nextMeeting: r.next_meeting ? (JSON.parse(r.next_meeting) as NextMeeting) : null,
      source: r.source,
      ts: new Date(r.created_at + 'Z').getTime(),
      eventId: r.event_id ?? null,
      files: r.files ? (JSON.parse(r.files) as { id: number; name: string; type: string }[]) : [],
    };
  });
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
  opts: { trigger?: 'call' | 'manual' } = {},
): Promise<number | null> {
  const trigger = opts.trigger ?? 'call';
  const meeting = db
    .prepare('SELECT id, code, title, org_id FROM meetings WHERE code = ?')
    .get(code.toUpperCase()) as
    | { id: number; code: string; title: string; org_id: number | null }
    | undefined;
  if (!meeting) return null;

  // 요약 창: 마지막 recap 이후 ~ 지금. 첫 recap이면 최근 24시간.
  // 1건짜리 수동/자동 기록(source manual·auto)은 요약이 아니므로 창 기준에서 제외 —
  // 안 그러면 채팅 도중 자동 기록 하나가 창을 당겨 그 앞 메시지들이 요약에서 증발한다
  const last = db
    .prepare(
      `SELECT MAX(call_ended_at) AS t FROM meeting_recaps
       WHERE meeting_id = ? AND source NOT IN ('manual', 'auto')`,
    )
    .get(meeting.id) as { t: string | null };
  const since = last.t ?? new Date(Date.now() - 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  // 통화 트리거면 요약 재료 창을 통화 세션으로 좁힌다 — 회의 사이 며칠치 잡담이
  // 통화 전사와 섞여 엉뚱한 결론이 나오는 것 방지. 통화 직전 맥락 공유까지는 재료로
  // 인정 (시작 10분 전부터). 수동 "지금 정리하기"는 기존 창(지난 정리 이후) 유지
  const callStart =
    trigger === 'call'
      ? ((
          db.prepare('SELECT call_started_at AS t FROM meetings WHERE id = ?').get(meeting.id) as
            | { t: string | null }
            | undefined
        )?.t ?? undefined)
      : undefined;
  const sessionSince = (() => {
    if (!callStart) return since;
    const padded = new Date(new Date(callStart.replace(' ', 'T') + 'Z').getTime() - 10 * 60_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    return padded > since ? padded : since;
  })();

  // 통화 원음 청크가 쌓여 있으면 먼저 whisper 재전사 — 아래 voiceMsgs가 whisper 행을 우선 쓴다.
  // 실패해도 Web Speech 기록으로 폴백되므로 recap 자체는 계속 간다
  if (trigger === 'call') {
    try {
      await transcribeMeetingAudio(meeting.id);
    } catch (e) {
      console.error('[recap] whisper 전사 실패 — Web Speech 기록으로 진행:', e);
    }
  }

  // 채팅 + 통화 음성 전사를 시간순으로 합쳐서 요약 재료로 쓴다.
  // AI 자신의 메시지는 제외 — 과거 AI 답변("내용이 부족…")을 다시 먹고 그대로 요약하는 자기 오염 방지
  const agentId = ensureAgentUser();
  const chatMsgs = (
    db
      .prepare(
        `SELECT u.username AS "from", m.text, m.created_at AS at FROM messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.meeting_id = ? AND m.user_id != ? AND m.created_at > ? AND m.text != ''
         ORDER BY m.id DESC LIMIT 200`,
      )
      .all(meeting.id, agentId, sessionSince) as (ChatMsg & { at: string })[]
  ) // 상한 초과 시 옛 것을 버린다(DESC→reverse) — ASC면 회의 결론부가 잘린다
    .reverse()
    // "@AI"처럼 멘션만 있고 내용이 없는 메시지도 재료가 아님
    .filter((m) => m.text.replace(/@[\w가-힣.-]+/g, '').trim().length > 0);
  // whisper 재전사(고품질)가 있으면 그것만, 없으면 Web Speech(live) 기록 —
  // 둘을 합치면 같은 발화가 두 번 들어가 요약·결정 추출이 왜곡된다
  const whisperMsgs = db
    .prepare(
      `SELECT u.username AS "from", t.text, t.created_at AS at FROM call_transcripts t
       JOIN users u ON u.id = t.user_id
       WHERE t.meeting_id = ? AND t.created_at > ? AND t.source = 'whisper'
       ORDER BY t.id DESC LIMIT 300`,
    )
    .all(meeting.id, sessionSince)
    .reverse() as (ChatMsg & { at: string })[];
  const voiceMsgs =
    whisperMsgs.length > 0
      ? whisperMsgs
      : (db
          .prepare(
            `SELECT u.username AS "from", t.text, t.created_at AS at FROM call_transcripts t
             JOIN users u ON u.id = t.user_id
             WHERE t.meeting_id = ? AND t.created_at > ? AND t.source != 'whisper'
             ORDER BY t.id DESC LIMIT 300`,
          )
          .all(meeting.id, sessionSince)
          .reverse() as (ChatMsg & { at: string })[]);
  // 화자명은 순수 username 유지 — ruleBasedRecap의 담당자 매칭("제가 …게요")이 깨지지 않도록
  const msgs: ChatMsg[] = [...chatMsgs, ...voiceMsgs]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((m) => ({ from: m.from, text: m.text }));
  if (msgs.length === 0) return null; // 아무 대화가 없던 통화만 스킵 — 한 마디라도 있으면 기록은 남긴다

  // 회의 등록 참가자 전원 (배달 대상) — 직급·부서는 조직 멤버십에서 (개인 회의면 null)
  const members = db
    .prepare(
      `SELECT u.id, u.username, om.position, om.department FROM meeting_participants mp
       JOIN users u ON u.id = mp.user_id
       LEFT JOIN organization_members om
         ON om.user_id = u.id AND om.org_id = ? AND om.status = 'active'
       WHERE mp.meeting_id = ?`,
    )
    .all(meeting.org_id, meeting.id) as { id: number; username: string; position: string | null; department: string | null }[];
  if (members.length === 0) return null;

  // 이 요약 창 동안 열람·편집된 문서 — "이 회의에서 다룬 문서" (회의↔공동편집 다리).
  // 통화 트리거면 창을 통화 시작 시각으로 좁힌다 — 회의 사이에 열어본 파일이
  // "이 회의에서 다룬" 것으로 섞이지 않게 (요약 재료 창(since)과 별개 기준)
  const fileSince = callStart && callStart > since ? callStart : since;
  const touchedFiles = db
    .prepare(
      `SELECT DISTINCT fa.file_id AS id, f.name, f.type FROM file_activity fa
       JOIN collab_files f ON f.id = fa.file_id
       WHERE fa.meeting_id = ? AND fa.ts > ? AND f.deleted_at IS NULL
       ORDER BY fa.file_id LIMIT 12`,
    )
    .all(meeting.id, fileSince) as { id: number; name: string; type: string }[];

  // 다룬 문서 발췌를 AI 참고자료로 — 회사 용어의 올바른 표기·논의 맥락 (Whispree의 Visual Context 발상).
  // 추출은 chat에서만 하도록 프롬프트로 격리 — 문서 내용이 결정으로 둔갑하지 않게
  const docContext =
    touchedFiles.length > 0
      ? touchedFiles
          .slice(0, 3)
          .map((f) => {
            const text = extractFileText(f.id);
            return text ? `[${f.name}] ${text.replace(/\s+/g, ' ').slice(0, 400)}` : null;
          })
          .filter(Boolean)
          .join('\n')
      : '';

  // 짧은 통화(재료가 MIN_MESSAGES 미만) — AI를 태우면 한두 마디로 환각 위험이라
  // 규칙 추출 + 발언 원문을 요약으로 남긴다. "나눈 말이 기록에서 증발하면 안 된다" (8/15 실사용 지적)
  const recap =
    msgs.length < MIN_MESSAGES
      ? (() => {
          const r = ruleBasedRecap(
            msgs,
            members.map((m) => m.username),
          );
          const said = msgs.map((m) => `${m.from}: "${m.text.trim()}"`).join(' · ');
          return { ...r, summary: `짧은 통화 — ${said}`.slice(0, 160) };
        })()
      : await extractRecap(
          msgs,
          members.map((m) => m.username),
          docContext || undefined,
        );

  // ── 실시간 감지(자동 기록)와의 이중 기입 방지 ──
  // 같은 세션에서 감지 AI가 이미 원장에 적은 결정을 recap이 또 적으면 같은 결정이 2줄 생긴다.
  // 세션 창 안의 source='auto' 기록과만 비교(다른 회의의 A→B→A 역사는 창 밖 = 비교 대상 아님),
  // 겹치면 recap 쪽에서 뺀다 — 먼저 적힌 자동 기록이 원장에 남고(받은 확인 유지),
  // recap이 뽑은 배경·critical은 아래에서 그 줄에 역주입한다. 애매하면 안 뺀다.
  const droppedDups: { autoId: number; text: string; why: string; alts: string[] }[] = [];
  if (recap.decisions.length > 0) {
    const autoRows = db
      .prepare(
        `SELECT id, decisions FROM meeting_recaps
         WHERE meeting_id = ? AND source = 'auto' AND created_at > ?`,
      )
      .all(meeting.id, sessionSince) as { id: number; decisions: string }[];
    const autos = autoRows
      .map((r) => {
        try {
          return { id: r.id, text: (JSON.parse(r.decisions) as string[])[0] ?? '' };
        } catch {
          return { id: r.id, text: '' };
        }
      })
      .filter((a) => a.text);
    if (autos.length > 0) {
      const kept: { d: string; w: string; a: string[] }[] = [];
      for (let i = 0; i < recap.decisions.length; i++) {
        const hit = autos.find((a) => sameDecision(a.text, recap.decisions[i]));
        if (hit)
          droppedDups.push({
            autoId: hit.id,
            text: recap.decisions[i],
            why: recap.whys[i] ?? '',
            alts: recap.alts[i] ?? [],
          });
        else kept.push({ d: recap.decisions[i], w: recap.whys[i] ?? '', a: recap.alts[i] ?? [] });
      }
      if (droppedDups.length > 0) {
        recap.decisions = kept.map((k) => k.d);
        recap.whys = kept.map((k) => k.w);
        recap.alts = kept.map((k) => k.a);
        console.log(`[recap] 자동 기록과 중복 ${droppedDups.length}건 — recap에서 제외, 메타 역주입`);
      }
    }
  }

  // 짧은 통화의 발언이 전부 자동 기록으로 이미 원장에 있으면 recap 자체를 만들지 않는다 —
  // 남는 정보가 없는데 회의 기록 리스트에 같은 문장이 2줄(자동 기록 + "짧은 통화") 생기는 것 방지.
  // 이 세션의 기록은 자동 기록 줄이 대표한다 (아직 남은 결정·할 일이 있으면 정상 생성)
  if (
    msgs.length < MIN_MESSAGES &&
    droppedDups.length > 0 &&
    recap.decisions.length === 0 &&
    recap.actions.length === 0
  ) {
    console.log('[recap] 짧은 통화 — 발언 전부가 자동 기록에 있음, recap 생략');
    if (trigger === 'call')
      db.prepare('UPDATE meetings SET call_started_at = NULL WHERE id = ?').run(meeting.id); // 세션 소비
    return droppedDups[0].autoId; // 이 세션의 기록 = 자동 기록 (status는 done으로)
  }

  const inCall = new Set(sessionUserIds);
  const attendees = members.filter((m) => inCall.has(m.id)).map((m) => m.username);

  // 이 기록이 어느 일정(이벤트)의 회의였는지 — 오늘 날짜의 이벤트 중 현재 시각에 가장 가까운 것.
  // 일정→기록 점프의 연결고리 (없으면 null — 즉석 회의)
  const todayKst = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const nowHm = new Date().toLocaleTimeString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 5);
  const todayEvents = db
    .prepare('SELECT id, time FROM meeting_events WHERE meeting_id = ? AND date = ?')
    .all(meeting.id, todayKst) as { id: number; time: string | null }[];
  const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const eventId =
    todayEvents
      .map((e) => ({ id: e.id, diff: e.time ? Math.abs(toMin(e.time) - toMin(nowHm)) : 12 * 60 }))
      .sort((a, b) => a.diff - b.diff)[0]?.id ?? null;

  if (trigger === 'call')
    db.prepare('UPDATE meetings SET call_started_at = NULL WHERE id = ?').run(meeting.id); // 세션 소비

  const info = db
    .prepare(
      `INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, alts, actions, attendees, next_meeting, source, event_id, files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meeting.id,
      recap.summary,
      JSON.stringify(recap.decisions),
      JSON.stringify(recap.whys),
      JSON.stringify(recap.alts),
      JSON.stringify(recap.actions),
      JSON.stringify(attendees),
      recap.nextMeeting ? JSON.stringify(recap.nextMeeting) : null,
      recap.source,
      eventId,
      touchedFiles.length > 0 ? JSON.stringify(touchedFiles) : null,
    );
  const recapId = info.lastInsertRowid as number;

  // 담당자가 특정된 할 일은 그 사람의 회의 할 일로 자동 생성
  const byName = new Map(members.map((m) => [m.username, m.id]));
  const assignedCount = new Map<number, number>();
  for (const a of recap.actions) {
    if (!a.assignee) continue;
    const uid = byName.get(a.assignee);
    if (!uid) continue;
    const todoInfo = db
      .prepare('INSERT INTO todos (user_id, meeting_id, title, recap_id) VALUES (?, ?, ?, ?)')
      .run(uid, meeting.id, a.title.slice(0, 200), recapId);
    db.prepare('INSERT OR IGNORE INTO todo_assignees (todo_id, user_id) VALUES (?, ?)').run(
      todoInfo.lastInsertRowid,
      uid,
    );
    assignedCount.set(uid, (assignedCount.get(uid) ?? 0) + 1);
  }

  // 라우팅 — 참석자에겐 요약, 불참자에겐 "못 들어간 회의의 결정" (P1의 핵심)
  const stats = [
    recap.decisions.length > 0 ? `결정 ${recap.decisions.length}` : null,
    recap.actions.length > 0 ? `할 일 ${recap.actions.length}` : null,
    recap.nextMeeting ? '다음 회의 제안' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // 관련성 라우팅 — 결정이 작업 방식을 바꾸는 사람에게는 "작업 전 확인 필수" 등급으로 (알림 피로 방지의 역설계:
  // 전원에게 같은 톤으로 뿌리면 중요한 것도 묻힌다. 직무·부서로 영향 범위를 추론해 톤을 가른다)
  // 이중 기입으로 뺀 결정도 판정 대상에 포함 — 인덱스 N 이후가 dropped (자동 기록 쪽에 역주입)
  const crit = await inferCritical(
    [...recap.decisions, ...droppedDups.map((d) => d.text)],
    members,
  );
  const critical = crit.userIds;
  // 🔴 결정 인덱스는 원장에 저장 — critical 결정은 확인 시 손 서명을 요구 (중요도에 비례한 마찰)
  if (crit.decisionIdx.size > 0) {
    db.prepare('UPDATE meeting_recaps SET criticals = ? WHERE id = ?').run(
      JSON.stringify(recap.decisions.map((_, i) => crit.decisionIdx.has(i))),
      recapId,
    );
  }
  // 이중 기입으로 뺀 결정의 배경·대안·critical을 자동 기록 줄에 역주입 — 메타가 유실되지 않게
  for (let j = 0; j < droppedDups.length; j++) {
    const d = droppedDups[j];
    try {
      if (d.why)
        db.prepare(
          `UPDATE meeting_recaps SET whys = ? WHERE id = ? AND (whys IS NULL OR whys = '[]' OR whys = '[""]')`,
        ).run(JSON.stringify([d.why]), d.autoId);
      if (d.alts.length > 0)
        db.prepare(
          `UPDATE meeting_recaps SET alts = ? WHERE id = ? AND (alts IS NULL OR alts = '[[]]')`,
        ).run(JSON.stringify([d.alts]), d.autoId);
      if (crit.decisionIdx.has(recap.decisions.length + j))
        db.prepare('UPDATE meeting_recaps SET criticals = ? WHERE id = ?').run(
          JSON.stringify([true]),
          d.autoId,
        );
    } catch {
      /* 역주입 실패해도 recap 자체는 유효 */
    }
  }

  const what = trigger === 'manual' ? '기록' : '통화';
  for (const m of members) {
    const mine = assignedCount.get(m.id);
    const mineSuffix = mine ? ` — 내 할 일 ${mine}개 배정됨` : '';
    const prefix = critical.has(m.id) ? '🔴 작업 전 확인 필수 — ' : '';
    const text = inCall.has(m.id)
      ? `${prefix}"${meeting.title}" ${what} 정리: ${recap.summary}${stats ? ` (${stats})` : ''}${mineSuffix}`
      : `${prefix}놓친 "${meeting.title}" ${what}의 결정이 도착했어요: ${recap.summary}${stats ? ` (${stats})` : ''}${mineSuffix}`;
    notifyUser(m.id, { from: 'exist AI', text, kind: 'recap', meetingCode: meeting.code });
    invalidateBrief(m.id);
  }

  // 새 recap이 생겼으니 아젠다는 다시 만들어야 함 (10분 캐시가 구재료를 물지 않게)
  invalidateAgenda(meeting.id);
  // 이월 안건 정산 — 이번 회의에서 결론 난 안건은 종결, 못 낸 안건은 rounds+1로 다음 안건에 재상정
  void settleAgendaAfterRecap(meeting.id, {
    summary: recap.summary,
    // 이중 기입으로 뺀 결정도 포함 — 그 결정으로 결론 난 안건도 정산돼야 한다
    decisions: [...recap.decisions, ...droppedDups.map((d) => d.text)],
  }).catch((err) => console.error('[recap] 안건 정산 실패:', err));

  console.log(
    `[recap] ${meeting.code} 요약 저장 (${recap.source}) — 결정 ${recap.decisions.length}, 할 일 ${recap.actions.length}, 배달 ${members.length}명`,
  );
  return recapId;
}

export interface LedgerEntry {
  recapId: number;
  /** recap 안에서의 결정 순번 — 수신 확인의 키 (recapId + idx) */
  idx: number;
  decision: string;
  /** 결정 배경 한 줄 — 없으면 '' */
  why: string;
  /** 검토됐지만 채택되지 않은 대안 ("대안 — 기각 사유") — 없으면 빈 배열 */
  alts: string[];
  /** 🔴 작업 전 확인 필수 — 확인 시 손 서명 요구 (중요도에 비례한 마찰) */
  critical: boolean;
  attendees: string[];
  ts: number;
  /** 수신 확인한 사람들 (회람 사인) — note = 현장 피드백, signature = 손 서명 PNG */
  acks: { username: string; ts: number; note: string | null; signature: string | null }[];
  /** 이 recap에서 파생된 할 일 — 결정이 실행됐는지 추적 (P1 체인의 실행 단계) */
  todos: { title: string; done: number }[];
  /** 이 결정을 근거로 발행된 문서 개정들 — 결정→문서 다리 (없으면 빈 배열) */
  revisedFiles: { id: number; rev: number; name: string }[];
}

/** 결정 원장 — 이 그룹의 모든 recap 결정을 시간순(최신 먼저)으로 편다.
 *  "결정이 사람이 아니라 조직에 남는다"의 데이터 뷰. AI 질의응답의 근거로도 사용. */
export function listDecisions(meetingId: number, limit = 100): LedgerEntry[] {
  const rows = db
    .prepare(
      `SELECT id, decisions, whys, alts, criticals, attendees, created_at FROM meeting_recaps
       WHERE meeting_id = ? ORDER BY id DESC LIMIT 50`,
    )
    .all(meetingId) as { id: number; decisions: string; whys: string | null; alts: string | null; criticals: string | null; attendees: string; created_at: string }[];
  const ackStmt = db.prepare(
    `SELECT a.decision_idx, u.username, a.created_at, a.note, a.signature FROM decision_acks a
     JOIN users u ON u.id = a.user_id WHERE a.recap_id = ? ORDER BY a.id`,
  );
  const todoStmt = db.prepare('SELECT title, done FROM todos WHERE recap_id = ? ORDER BY id');
  // 이 결정을 근거로 발행된 개정들 — 결정→문서 역링크 (삭제된 파일 제외)
  const revStmt = db.prepare(
    `SELECT s.file_id AS id, s.rev, f.name FROM file_rev_snapshots s
     JOIN collab_files f ON f.id = s.file_id
     WHERE s.basis_recap_id = ? AND s.basis_decision_idx = ? AND f.deleted_at IS NULL
     ORDER BY s.id DESC LIMIT 5`,
  );
  const out: LedgerEntry[] = [];
  for (const r of rows) {
    const ts = new Date(r.created_at + 'Z').getTime();
    const attendees = JSON.parse(r.attendees) as string[];
    const ackRows = ackStmt.all(r.id) as {
      decision_idx: number;
      username: string;
      created_at: string;
      note: string | null;
      signature: string | null;
    }[];
    const decisions = JSON.parse(r.decisions) as string[];
    const recapTodos = todoStmt.all(r.id) as { title: string; done: number }[];
    const whys = parseWhys(r.whys, decisions.length);
    const altsAll = parseAlts(r.alts, decisions.length);
    let criticals: boolean[] = [];
    try {
      criticals = r.criticals ? (JSON.parse(r.criticals) as boolean[]) : [];
    } catch {
      criticals = [];
    }
    for (let idx = 0; idx < decisions.length; idx++) {
      out.push({
        recapId: r.id,
        idx,
        decision: decisions[idx],
        why: whys[idx],
        alts: altsAll[idx],
        critical: criticals[idx] === true,
        attendees,
        ts,
        acks: ackRows
          .filter((a) => a.decision_idx === idx)
          .map((a) => ({
            username: a.username,
            ts: new Date(a.created_at + 'Z').getTime(),
            note: a.note ?? null,
            signature: a.signature ?? null,
          })),
        todos: recapTodos,
        revisedFiles: revStmt.all(r.id, idx) as { id: number; rev: number; name: string }[],
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 회의 원문 — 이 recap의 재료가 된 발언 전부 (채팅+음성 전사, 시간순).
 *  창 재구성: 직전 실제 recap의 call_ended_at ~ 이 recap의 call_ended_at (생성 때와 같은 기준).
 *  1건짜리 수동/자동 기록은 원문 창 개념이 없어 null */
export function getRecapSource(
  meetingId: number,
  recapId: number,
): { items: { from: string; text: string; ts: number; kind: 'chat' | 'voice' }[] } | null {
  const cur = db
    .prepare('SELECT call_ended_at, source FROM meeting_recaps WHERE id = ? AND meeting_id = ?')
    .get(recapId, meetingId) as { call_ended_at: string; source: string } | undefined;
  if (!cur || cur.source === 'manual' || cur.source === 'auto') return null;
  const prev = db
    .prepare(
      `SELECT MAX(call_ended_at) AS t FROM meeting_recaps
       WHERE meeting_id = ? AND call_ended_at < ? AND source NOT IN ('manual', 'auto')`,
    )
    .get(meetingId, cur.call_ended_at) as { t: string | null };
  const since =
    prev.t ??
    new Date(new Date(cur.call_ended_at + 'Z').getTime() - 24 * 3600_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
  const agentId = ensureAgentUser();
  const chat = db
    .prepare(
      `SELECT u.username AS "from", m.text, m.created_at AS at FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.meeting_id = ? AND m.user_id != ? AND m.text != ''
         AND m.created_at > ? AND m.created_at <= ?
       ORDER BY m.id ASC LIMIT 500`,
    )
    .all(meetingId, agentId, since, cur.call_ended_at) as { from: string; text: string; at: string }[];
  // whisper 재전사가 있으면 그것만 (runRecapForMeeting과 동일한 이유 — 중복 발화 방지)
  const voiceWhisper = db
    .prepare(
      `SELECT u.username AS "from", t.text, t.created_at AS at FROM call_transcripts t
       JOIN users u ON u.id = t.user_id
       WHERE t.meeting_id = ? AND t.created_at > ? AND t.created_at <= ? AND t.source = 'whisper'
       ORDER BY t.id ASC LIMIT 800`,
    )
    .all(meetingId, since, cur.call_ended_at) as { from: string; text: string; at: string }[];
  const voice =
    voiceWhisper.length > 0
      ? voiceWhisper
      : (db
          .prepare(
            `SELECT u.username AS "from", t.text, t.created_at AS at FROM call_transcripts t
             JOIN users u ON u.id = t.user_id
             WHERE t.meeting_id = ? AND t.created_at > ? AND t.created_at <= ? AND t.source != 'whisper'
             ORDER BY t.id ASC LIMIT 800`,
          )
          .all(meetingId, since, cur.call_ended_at) as { from: string; text: string; at: string }[]);
  const items = [
    ...chat.map((m) => ({ from: m.from, text: m.text, ts: new Date(m.at + 'Z').getTime(), kind: 'chat' as const })),
    ...voice.map((m) => ({ from: m.from, text: m.text, ts: new Date(m.at + 'Z').getTime(), kind: 'voice' as const })),
  ].sort((a, b) => a.ts - b.ts);
  return { items };
}

/** 다음 회의 제안을 "등록됨"으로 표시 — 실제 일정 등록은 클라가 기존 events API로 하고,
 *  이 플래그는 RecapPanel 버튼 상태(중복 등록 방지)용. 참가자 검증은 라우트에서 */
export function markNextMeetingRegistered(recapId: number, meetingId: number): boolean {
  const row = db
    .prepare('SELECT next_meeting FROM meeting_recaps WHERE id = ? AND meeting_id = ?')
    .get(recapId, meetingId) as { next_meeting: string | null } | undefined;
  if (!row?.next_meeting) return false;
  const nm = JSON.parse(row.next_meeting) as NextMeeting;
  nm.registered = true;
  db.prepare('UPDATE meeting_recaps SET next_meeting = ? WHERE id = ?').run(
    JSON.stringify(nm),
    recapId,
  );
  return true;
}

/** 결정 수신 확인 — 참가자 검증은 라우트에서. 중복 확인은 무시(idempotent).
 *  note = 현장 피드백 한 줄(선택) — 이미 확인한 뒤에도 노트만 추가/갱신 가능 */
export function ackDecision(
  recapId: number,
  decisionIdx: number,
  userId: number,
  note?: string | null,
  signature?: string,
): boolean {
  const recap = db.prepare('SELECT decisions FROM meeting_recaps WHERE id = ?').get(recapId) as
    | { decisions: string }
    | undefined;
  if (!recap) return false;
  const count = (JSON.parse(recap.decisions) as string[]).length;
  if (decisionIdx < 0 || decisionIdx >= count) return false;
  db.prepare(
    'INSERT OR IGNORE INTO decision_acks (recap_id, decision_idx, user_id) VALUES (?, ?, ?)',
  ).run(recapId, decisionIdx, userId);
  if (note != null && note.trim()) {
    db.prepare(
      'UPDATE decision_acks SET note = ? WHERE recap_id = ? AND decision_idx = ? AND user_id = ?',
    ).run(note.trim().slice(0, 120), recapId, decisionIdx, userId);
  }
  // 손 서명 (🔴 결정) — 종이 회람판의 디지털화
  if (
    typeof signature === 'string' &&
    signature.startsWith('data:image/png;base64,') &&
    signature.length < 40_000
  ) {
    db.prepare(
      'UPDATE decision_acks SET signature = ? WHERE recap_id = ? AND decision_idx = ? AND user_id = ?',
    ).run(signature, recapId, decisionIdx, userId);
  }
  return true;
}

/* ── 미확인자 자동 리마인드 — 현장 요구 반영 ("미확인자 알림"·"누가 봤는지 불명확") ──
 * recap 생성 후 DECISION_REMIND_MS(기본 24시간) 지나도 원장에 서명이 하나도 없는 참가자에게
 * 1회만 보챈다. 하나라도 확인한 사람은 원장을 본 것이므로 제외. */
const DECISION_REMIND_MS = Number(process.env.DECISION_REMIND_MS ?? 24 * 3600_000);

export function runDecisionReminders(): number {
  const now = Date.now();
  const fmt = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  const rows = db
    .prepare(
      `SELECT r.id, r.meeting_id, r.decisions, m.title, m.code FROM meeting_recaps r
       JOIN meetings m ON m.id = r.meeting_id
       WHERE r.created_at <= ? AND r.created_at >= ? AND r.decisions != '[]'`,
    )
    .all(fmt(now - DECISION_REMIND_MS), fmt(now - 7 * 24 * 3600_000)) as {
    id: number;
    meeting_id: number;
    decisions: string;
    title: string;
    code: string;
  }[];
  const agentId = ensureAgentUser();
  let sent = 0;
  for (const r of rows) {
    const count = (JSON.parse(r.decisions) as string[]).length;
    if (!count) continue;
    const participants = db
      .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?')
      .all(r.meeting_id) as { user_id: number }[];
    const acked = new Set(
      (
        db.prepare('SELECT DISTINCT user_id FROM decision_acks WHERE recap_id = ?').all(r.id) as {
          user_id: number;
        }[]
      ).map((a) => a.user_id),
    );
    for (const p of participants) {
      if (p.user_id === agentId || acked.has(p.user_id)) continue;
      const dup = db
        .prepare('SELECT 1 FROM decision_remind_sent WHERE recap_id = ? AND user_id = ?')
        .get(r.id, p.user_id);
      if (dup) continue;
      db.prepare('INSERT INTO decision_remind_sent (recap_id, user_id) VALUES (?, ?)').run(
        r.id,
        p.user_id,
      );
      notifyUser(p.user_id, {
        from: 'exist AI',
        text: `"${r.title}"의 결정 ${count}건이 아직 확인을 기다려요 — 결정 탭에서 서명해 주세요`,
        kind: 'recap',
        meetingCode: r.code,
      });
      sent++;
    }
  }
  if (sent) console.log(`[recap] 미확인 리마인드 ${sent}건 발송`);
  return sent;
}

// ── 통화 종료 유예 스케줄러 — 방이 비워지면 GRACE_MS 후 실행, 재입장 시 취소 ──
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** recap 진행 상태 방송 — 통화 끝~정리 완료 사이 "정리 중" 스피너용 (참가자 전원) */
function emitRecapStatus(code: string, state: 'generating' | 'done' | 'cleared' | 'skipped') {
  try {
    const m = db.prepare('SELECT id FROM meetings WHERE code = ?').get(code.toUpperCase()) as
      | { id: number }
      | undefined;
    if (!m) return;
    const rows = db
      .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?')
      .all(m.id) as { user_id: number }[];
    for (const r of rows) emitToUser(r.user_id, 'recap:status', { code: code.toUpperCase(), state });
  } catch {
    /* 방송 실패는 치명적이지 않음 */
  }
}

/* 통화 시작 시각 — "다룬 문서"·요약 재료의 창을 통화 세션으로 좁히는 기준.
 * 없으면(수동 정리 등) 기존대로 "지난 recap 이후" 창을 쓴다.
 * 재입장(유예 취소)은 시작 시각을 유지 — 같은 세션으로 본다.
 * DB(meetings.call_started_at)에 두는 이유: 통화 중 서버가 재시작돼도 세션 창이 살아야 한다 */
export function markCallStarted(code: string) {
  db.prepare(
    `UPDATE meetings SET call_started_at = COALESCE(call_started_at, datetime('now'))
     WHERE code = ?`,
  ).run(code.toUpperCase());
}

export function scheduleRecap(code: string, sessionUserIds: number[]) {
  const key = code.toUpperCase();
  cancelScheduledRecap(key);
  // 통화가 끝난 순간부터 "정리 중" — 유예(재입장 대기) 시간도 사용자에겐 정리 중으로 보이는 게 맞다
  emitRecapStatus(key, 'generating');
  const timer = setTimeout(() => {
    pending.delete(key);
    runRecapForMeeting(key, sessionUserIds)
      .then((recapId) =>
        // null = 재료 부족 등으로 생성 안 함 — 이유 없이 스피너만 사라지면
        // 사용자에겐 "정리가 고장났다"로 보인다 (실사용 문의 3회). skipped로 알린다
        emitRecapStatus(key, recapId == null ? 'skipped' : 'done'),
      )
      .catch((err) => {
        console.error('[recap] 실행 실패:', err);
        emitRecapStatus(key, 'done');
      });
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
    emitRecapStatus(key, 'cleared'); // 재입장 — 정리 중 스피너 내림
  }
}
