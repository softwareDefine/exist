import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * recap.ts의 AI 경로 — OpenAI 클라이언트를 모의해 프롬프트·파싱·검증 게이트 회귀를 잡는다.
 * (기존 recap.test.ts는 키 없는 규칙 폴백만 검증)
 * 결정 추출은 gpt-5.4-mini(추론 모델), 검증·관련성은 gpt-4o-mini — 세대별 샘플링 파라미터도 함께 단언.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  process.env.OPENAI_MODEL_RECAP = 'gpt-5.4-mini';
  process.env.RECAP_VERIFY = 'on';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import { runRecapForMeeting, sameDecision } from '../recap.js';
import db from '../db.js';
import {
  captured,
  queueJson,
  setNextResponses,
  resetOpenAiMock,
  userPayload,
  systemPrompt,
  flush,
} from './helpers/openaiMock.js';

const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string; user: { id: number } };
}
function userId(username: string): number {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
}

async function setupMeeting(prefix: string) {
  const host = await registerUser(`${prefix}_host`);
  const member = await registerUser(`${prefix}_member`);
  const m = await request(app)
    .post('/api/meetings')
    .set('Authorization', `Bearer ${host.token}`)
    .send({ title: `${prefix} 회의` });
  const code = m.body.code as string;
  await request(app).post('/api/meetings/join').set('Authorization', `Bearer ${member.token}`).send({ code });
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
  return { host, member, code, meetingId, hostId: userId(`${prefix}_host`), memberId: userId(`${prefix}_member`) };
}
function say(meetingId: number, username: string, text: string) {
  db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(meetingId, userId(username), text);
}
function recapRow(id: number) {
  return db
    .prepare('SELECT summary, decisions, whys, alts, actions, next_meeting, source, criticals FROM meeting_recaps WHERE id = ?')
    .get(id) as {
    summary: string; decisions: string; whys: string; alts: string; actions: string;
    next_meeting: string | null; source: string; criticals: string | null;
  };
}
function notiTexts(uid: number): string[] {
  return (db.prepare('SELECT text FROM notifications WHERE user_id = ? ORDER BY id').all(uid) as { text: string }[]).map((n) => n.text);
}

beforeEach(() => resetOpenAiMock());

describe('AI recap — 추출 · 파싱 · 샘플링', () => {
  it('뒤에 잡설이 붙은 JSON도 파싱, why 없으면 "", participants 밖 assignee는 null, 🔴 관련성 라우팅', async () => {
    const s = await setupMeeting('lr1');
    say(s.meetingId, 'lr1_host', '방열판 검사 온도 60도는 편차가 커요. 65도로 올리죠.');
    say(s.meetingId, 'lr1_member', '70도는요?');
    say(s.meetingId, 'lr1_host', '70은 설비 한계라 안 되고요. 65로 가고 다음 배치부터 적용합시다.');

    setNextResponses(
      // ① 추출 — gpt-5.4-mini가 JSON 뒤에 흘린 찌꺼기 재현
      JSON.stringify({
        summary: '방열판 검사 온도 기준 65도로 상향',
        decisions: [
          { text: '방열판 검사 온도 기준 60도→65도, 다음 배치부터 적용', why: '60도 기준에서 편차가 컸음', alternatives: ['70도 — 설비 한계로 기각'] },
          { text: '야간조 점검 주기 유지', why: '', alternatives: [] },
        ],
        actions: [
          { assignee: 'lr1_member', title: '검사 체크리스트 65도로 갱신' },
          { assignee: 'ghost_user', title: '전 라인 공지' },
        ],
        next_meeting: null,
      }) + ' icycle to ensure JSON valid? {"x":1} Done.',
    );
    queueJson({ grounded: [true, true] }); // ② 근거 검증
    queueJson({ critical_decisions: [0], critical_users: ['lr1_member'] }); // ③ 관련성

    const recapId = await runRecapForMeeting(s.code, [s.hostId]);
    expect(recapId).not.toBeNull();
    const row = recapRow(recapId!);
    expect(row.source).toBe('ai');
    expect(row.summary).toBe('방열판 검사 온도 기준 65도로 상향');
    expect(JSON.parse(row.decisions)).toEqual([
      '방열판 검사 온도 기준 60도→65도, 다음 배치부터 적용',
      '야간조 점검 주기 유지',
    ]);
    expect(JSON.parse(row.whys)).toEqual(['60도 기준에서 편차가 컸음', '']);
    expect(JSON.parse(row.alts)).toEqual([['70도 — 설비 한계로 기각'], []]);
    expect(JSON.parse(row.actions)).toEqual([
      { assignee: 'lr1_member', title: '검사 체크리스트 65도로 갱신' },
      { assignee: null, title: '전 라인 공지' },
    ]);
    expect(JSON.parse(row.criticals!)).toEqual([true, false]);

    // 담당자 특정된 할 일만 자동 생성 (ghost_user 것은 없음)
    const todos = db.prepare('SELECT user_id, title FROM todos WHERE recap_id = ?').all(recapId) as { user_id: number; title: string }[];
    expect(todos).toEqual([{ user_id: s.memberId, title: '검사 체크리스트 65도로 갱신' }]);

    // 라우팅 — 불참한 member에게 🔴 + 놓친 통화 + 할 일 배정, host는 일반 톤
    const mem = notiTexts(s.memberId).find((t) => t.includes('결정이 도착'))!;
    expect(mem.startsWith('🔴 작업 전 확인 필수 — 놓친')).toBe(true);
    expect(mem).toContain('내 할 일 1개 배정됨');
    const host = notiTexts(s.hostId).find((t) => t.includes('통화 정리'))!;
    expect(host.startsWith('🔴')).toBe(false);

    // 요청 단언 — ① 추론 모델: max_completion_tokens + reasoning_effort('low'), temperature 없음
    expect(captured).toHaveLength(3);
    const extract = captured[0];
    expect(extract.model).toBe('gpt-5.4-mini');
    expect(extract.max_completion_tokens).toBe(2800);
    expect(extract.reasoning_effort).toBe('low');
    expect(extract.temperature).toBeUndefined();
    expect(extract.max_tokens).toBeUndefined();
    expect(extract.response_format).toEqual({ type: 'json_object' });
    const payload = userPayload<{ participants: string[]; chat: string[]; calendar: string[]; now: string }>(extract);
    expect(payload.participants.sort()).toEqual(['lr1_host', 'lr1_member']);
    expect(payload.chat[0]).toBe('lr1_host: 방열판 검사 온도 60도는 편차가 커요. 65도로 올리죠.');
    expect(payload.calendar).toHaveLength(14);
    expect(payload.calendar[0]).toMatch(/^\d{4}-\d{2}-\d{2} \([월화수목금토일]\)$/);
    expect(systemPrompt(extract)).toContain('추측 금지');
    expect(systemPrompt(extract)).toContain('예시 2 — 유보 발언은 결정이 아니다');
    // ② 검증기: 4o 계열은 temperature + max_tokens, 결정 목록을 그대로 넘긴다
    const verify = captured[1];
    expect(verify.model).toBe('gpt-4o-mini');
    expect(verify.temperature).toBe(0);
    expect(verify.max_tokens).toBe(200);
    expect(verify.max_completion_tokens).toBeUndefined();
    expect(userPayload<{ decisions: string[]; chat: string[] }>(verify).decisions).toHaveLength(2);
    // ③ 관련성: 멤버 직무 정보를 넘긴다
    const crit = userPayload<{ decisions: string[]; members: { username: string }[] }>(captured[2]);
    expect(crit.decisions[0]).toMatch(/^0: /);
    expect(crit.members.map((m) => m.username).sort()).toEqual(['lr1_host', 'lr1_member']);
  });

  it('근거 검증 게이트 — false인 결정은 배경·대안과 함께 원장에서 빠진다', async () => {
    const s = await setupMeeting('lr2');
    say(s.meetingId, 'lr2_host', '출시일은 9월 말로 확정합니다');
    say(s.meetingId, 'lr2_member', '네 알겠습니다');
    queueJson({
      summary: '출시일 확정',
      decisions: [
        { text: '출시일 9월 말 확정', why: '', alternatives: [] },
        { text: '마케팅 예산 2배 증액', why: '창작된 배경', alternatives: ['현행 유지 — 기각'] },
      ],
      actions: [],
      next_meeting: null,
    });
    queueJson({ grounded: [true, false] });
    const id = await runRecapForMeeting(s.code, [s.hostId]);
    const row = recapRow(id!);
    expect(JSON.parse(row.decisions)).toEqual(['출시일 9월 말 확정']);
    expect(JSON.parse(row.whys)).toEqual(['']);
    expect(JSON.parse(row.alts)).toEqual([[]]);
    // 관련성 추론은 큐가 비어 실패 → 일반 톤 (criticals 미설정), recap 자체는 살아 있다
    expect(row.criticals).toBeNull();
  });

  it('검증기 응답 길이 불일치·API 실패는 "전부 유지" (검증기 때문에 결정을 잃지 않는다)', async () => {
    const s = await setupMeeting('lr3');
    say(s.meetingId, 'lr3_host', 'A안으로 결정했습니다');
    say(s.meetingId, 'lr3_member', 'B는 보류하고요');
    queueJson({ summary: 'A안 결정', decisions: ['A안 채택', 'B안 보류'], actions: [], next_meeting: null });
    queueJson({ grounded: [false] }); // 길이 불일치 → 무시
    const id = await runRecapForMeeting(s.code, [s.hostId]);
    expect(JSON.parse(recapRow(id!).decisions)).toEqual(['A안 채택', 'B안 보류']); // 구 형식(string[])도 수용

    const s2 = await setupMeeting('lr3b');
    say(s2.meetingId, 'lr3b_host', 'C안으로 확정');
    say(s2.meetingId, 'lr3b_member', '네');
    queueJson({ summary: 'C안', decisions: [{ text: 'C안 확정', why: '', alternatives: [] }], actions: [], next_meeting: null });
    setNextResponses(new Error('503 overloaded')); // 검증기 죽음
    const id2 = await runRecapForMeeting(s2.code, [s2.hostId]);
    expect(JSON.parse(recapRow(id2!).decisions)).toEqual(['C안 확정']);
  });

  it('next_meeting — 원문에 날짜 단서가 있을 때만, calendar에서 고른 날짜를 제안으로 저장', async () => {
    const s = await setupMeeting('lr4');
    say(s.meetingId, 'lr4_host', '그럼 다음 회의는 수요일 오후 3시에 하죠');
    say(s.meetingId, 'lr4_member', '좋아요');
    setNextResponses((req) => {
      // 모델처럼 calendar 목록에서 "(수)" 날짜를 고른다
      const cal = userPayload<{ calendar: string[] }>(req).calendar;
      const wed = cal.find((d) => d.includes('(수)'))!;
      return JSON.stringify({
        summary: '다음 회의 일정 합의',
        decisions: [],
        actions: [],
        next_meeting: { title: '주간 회의', date: wed.slice(0, 10), time: '15:00' },
      });
    });
    const id = await runRecapForMeeting(s.code, [s.hostId]);
    const nm = JSON.parse(recapRow(id!).next_meeting!) as { title: string; date: string; time: string };
    expect(nm.title).toBe('주간 회의');
    expect(nm.time).toBe('15:00');
    expect(nm.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const todayKst = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
    expect(nm.date >= todayKst).toBe(true);
    expect(new Date(nm.date + 'T00:00:00Z').getUTCDay()).toBe(3); // 달력 날짜의 요일 — 머신 TZ(CI=UTC)와 무관하게
    // 알림 통계에 "다음 회의 제안"
    expect(notiTexts(s.memberId).some((t) => t.includes('다음 회의 제안'))).toBe(true);
  });

  it('next_meeting — 날짜 단서 없는 원문에 모델이 날짜를 창작하면 버린다 / 과거 날짜·형식 오류도 버린다', async () => {
    const s = await setupMeeting('lr5');
    say(s.meetingId, 'lr5_host', '다음 회의에서 다시 보시죠');
    say(s.meetingId, 'lr5_member', '네 조만간 잡아요');
    queueJson({ summary: '추후 논의', decisions: [], actions: [], next_meeting: { title: '후속', date: '2099-01-01', time: '10:00' } });
    const id = await runRecapForMeeting(s.code, [s.hostId]);
    expect(recapRow(id!).next_meeting).toBeNull();

    const s2 = await setupMeeting('lr5b');
    say(s2.meetingId, 'lr5b_host', '내일 다시 모이죠');
    say(s2.meetingId, 'lr5b_member', '네');
    queueJson({ summary: '내일 재회의', decisions: [], actions: [], next_meeting: { title: '재회의', date: '2020-01-01', time: '25:99' } });
    const id2 = await runRecapForMeeting(s2.code, [s2.hostId]);
    expect(recapRow(id2!).next_meeting).toBeNull();
  });

  it('빈 응답·JSON 아님·summary 없음 → 규칙 폴백 (호출자에 예외 없음, 찌꺼기가 원장에 안 남음)', async () => {
    for (const [prefix, raw] of [
      ['lr6a', ''],
      ['lr6b', '죄송해요, 요약할 수 없어요.'],
      ['lr6c', '{"decisions": [{"text": "유령 결정"}]}'],
    ] as const) {
      const s = await setupMeeting(prefix);
      say(s.meetingId, `${prefix}_host`, '점검 일정은 화요일로 확정합니다');
      say(s.meetingId, `${prefix}_member`, '체크리스트는 제가 정리할게요');
      setNextResponses(raw);
      const id = await runRecapForMeeting(s.code, [s.hostId]);
      expect(id).not.toBeNull();
      const row = recapRow(id!);
      expect(row.source).toBe('rule');
      expect(row.decisions).not.toContain('유령');
      expect(JSON.parse(row.decisions)[0]).toContain('확정');
    }
  });

  it('실시간 자동 기록과 같은 결정은 recap에서 빼고 배경·critical을 자동 기록 줄에 역주입', async () => {
    const s = await setupMeeting('lr7');
    const text = '방열판 검사 온도를 65도로 올리기로 했습니다';
    // 같은 세션에서 감지 AI가 먼저 적어둔 자동 기록
    const auto = db
      .prepare(
        `INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, actions, attendees, source)
         VALUES (?, ?, ?, '[""]', '[]', '["lr7_host"]', 'auto')`,
      )
      .run(s.meetingId, text.slice(0, 80), JSON.stringify([text])).lastInsertRowid as number;
    say(s.meetingId, 'lr7_host', text);
    say(s.meetingId, 'lr7_member', '네, 그리고 체크리스트는 제가 갱신할게요');
    expect(sameDecision(text, text)).toBe(true);

    queueJson({
      summary: '검사 온도 65도 상향',
      decisions: [{ text, why: '60도에서 편차가 컸음', alternatives: ['70도 — 설비 한계'] }],
      actions: [{ assignee: 'lr7_member', title: '체크리스트 갱신' }],
      next_meeting: null,
    });
    queueJson({ grounded: [true] });
    queueJson({ critical_decisions: [0], critical_users: [] }); // 인덱스 0 = dropped(자동 기록) 쪽
    const id = await runRecapForMeeting(s.code, [s.hostId]);
    const row = recapRow(id!);
    expect(JSON.parse(row.decisions)).toEqual([]); // 중복은 recap에서 제외
    expect(JSON.parse(row.actions)).toHaveLength(1); // 할 일은 남는다
    const autoRow = recapRow(auto);
    expect(JSON.parse(autoRow.whys)).toEqual(['60도에서 편차가 컸음']);
    expect(JSON.parse(autoRow.alts)).toEqual([['70도 — 설비 한계']]);
    expect(JSON.parse(autoRow.criticals!)).toEqual([true]);
  });

  it('현장 녹음(trigger field) — 단일 마이크 안내가 docs로 들어가고 origin=field로 저장', async () => {
    const s = await setupMeeting('lr8');
    db.prepare('INSERT INTO call_transcripts (meeting_id, user_id, text, source) VALUES (?, ?, ?, ?)').run(
      s.meetingId, s.hostId, '오늘 야간조는 2호기 점검 먼저 하기로 합시다', 'whisper');
    db.prepare('INSERT INTO call_transcripts (meeting_id, user_id, text, source) VALUES (?, ?, ?, ?)').run(
      s.meetingId, s.hostId, '김반장이 자재 발주 확인할게요', 'whisper');
    queueJson({
      summary: '야간조 2호기 점검 우선',
      decisions: [{ text: '야간조 2호기 점검 우선 진행', why: '', alternatives: [] }],
      actions: [{ assignee: 'lr8_host', title: '자재 발주 확인' }],
      next_meeting: null,
    });
    queueJson({ grounded: [true] });
    const id = await runRecapForMeeting(s.code, [s.hostId], { trigger: 'field' });
    const origin = (db.prepare('SELECT origin FROM meeting_recaps WHERE id = ?').get(id) as { origin: string }).origin;
    expect(origin).toBe('field');
    const payload = userPayload<{ docs?: string; chat: string[] }>(captured[0]);
    expect(payload.docs).toContain('단일 마이크');
    expect(payload.chat).toHaveLength(2);
    expect(systemPrompt(captured[0])).toContain('docs는 이 회의 중 참가자들이 열람한 문서의 발췌');
    await flush();
  });
});
