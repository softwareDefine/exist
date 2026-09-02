import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * recap.ts AI 경로 생존 변이 사냥 2 (9/2 뮤테이션 최종 라운드) —
 * 근거 검증 제외 로그, aiRecap now/calendar 페이로드 형식, next_meeting null 게이트,
 * hasDateHint 간격·ISO 경계, inferCritical 인덱스 필터의 관측 가능 효과(criticals 미기록),
 * 24시간 폴백 창 문자열, 통화 문서 창 좁히기, 재료 병합 정렬, 공백 응답 폴백.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  process.env.OPENAI_MODEL_RECAP = 'gpt-4o';
  process.env.RECAP_VERIFY = 'on';
  process.env.RECAP_GRACE_MS = '60';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { extractRecap, runRecapForMeeting } from '../recap.js';
import { register, createMeeting, joinMeeting } from './helpers/fixtures.js';
import { captured, queueJson, setNextResponses, resetOpenAiMock, userPayload, flush } from './helpers/openaiMock.js';

const app = createApp();
beforeEach(() => resetOpenAiMock());

const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const ago = (min: number) => iso(Date.now() - min * 60_000);
const plusDays = (n: number) => new Date(Date.now() + n * 864e5).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);

async function setup(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const member = await register(app, `${prefix}_member`);
  const m = await createMeeting(app, host, `${prefix} 그룹`);
  await joinMeeting(app, member, m.code);
  return { host, member, code: m.code, meetingId: m.id };
}
const sayAt = (meetingId: number, uid: number, text: string, min = 0) =>
  db.prepare('INSERT INTO messages (meeting_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(meetingId, uid, text, ago(min));
const recapRow = (id: number) =>
  db.prepare('SELECT decisions, criticals, files FROM meeting_recaps WHERE id = ?').get(id) as {
    decisions: string;
    criticals: string | null;
    files: string | null;
  };
const twoMsgs = [{ from: 'a', text: '재료 공유' }, { from: 'b', text: '네 확인했어요' }];

describe('verifyDecisionsGrounded — 제외 로그', () => {
  it('제외된 결정을 40자 절단 원문과 함께 정확히 로그, 제외 없으면 침묵', async () => {
    const log = vi.spyOn(console, 'log');
    try {
      const d0 = '첫 결정 ' + '가'.repeat(50);
      const d1 = '둘째 결정 ' + '나'.repeat(50);
      queueJson({ summary: '요약', decisions: [d0, d1, '셋째 결정 유지'], actions: [], next_meeting: null });
      queueJson({ grounded: [false, false, true] });
      const r = await extractRecap(twoMsgs, ['a', 'b']);
      expect(r.decisions).toEqual(['셋째 결정 유지']);
      const calls = log.mock.calls.filter((c) => String(c[0]).includes('근거 검증'));
      expect(calls).toEqual([
        [`[recap] 근거 검증에서 제외된 결정 2건: "${d0.slice(0, 40)}", "${d1.slice(0, 40)}"`],
      ]);

      log.mockClear();
      queueJson({ summary: '요약', decisions: ['전부 유지되는 결정'], actions: [], next_meeting: null });
      queueJson({ grounded: [true] });
      await extractRecap(twoMsgs, ['a', 'b']);
      expect(log.mock.calls.filter((c) => String(c[0]).includes('근거 검증'))).toEqual([]);
    } finally {
      log.mockRestore();
    }
  }, 20_000);
});

describe('aiRecap — now·calendar 페이로드 형식', () => {
  it('now 는 KST 분 단위 + (요일), calendar 는 14일치 "날짜 (요일)"', async () => {
    const seoulNow = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
    const seoulDate = (ms: number) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const before = seoulNow();
    const beforeDate = seoulDate(Date.now());
    queueJson({ summary: '요약 한 줄', decisions: [], actions: [], next_meeting: null });
    await extractRecap(twoMsgs, ['a', 'b']);
    const after = seoulNow();
    const afterDate = seoulDate(Date.now());

    const p = userPayload<{ now: string; calendar: string[] }>(captured[0]);
    expect(p.now).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \([월화수목금토일]\)$/);
    expect([before, after]).toContain(p.now.slice(0, 16)); // KST 기준 시각과 일치
    expect(p.calendar).toHaveLength(14);
    for (const c of p.calendar) expect(c).toMatch(/^\d{4}-\d{2}-\d{2} \([월화수목금토일]\)$/);
    expect([beforeDate, afterDate]).toContain(p.calendar[0].slice(0, 10)); // 오늘부터 시작
  }, 20_000);
});

describe('next_meeting 게이트 — null 제안', () => {
  it('날짜 단서가 있어도 제안이 null 이면 조용히 null (형식 검증에 끌려들지 않는다)', async () => {
    queueJson({ summary: '요약', decisions: [], actions: [], next_meeting: null });
    const r = await extractRecap(
      [{ from: 'a', text: '내일 다시 이야기하죠' }, { from: 'b', text: '네 좋습니다' }],
      ['a', 'b'],
    );
    expect(r.source).toBe('ai'); // nm null 에서 크래시(→규칙 폴백)하면 변이
    expect(r.nextMeeting).toBeNull();
  }, 20_000);
});

describe('hasDateHint — 간격·형식 경계 보강', () => {
  it('월/일 사이 공백, 두 자리 월 ISO, 일+비한글 후행을 수용한다', async () => {
    const hint = async (text: string) => {
      resetOpenAiMock();
      queueJson({ summary: '다음 일정 논의', decisions: [], actions: [], next_meeting: { title: '후속', date: plusDays(3), time: '10:00' } });
      const r = await extractRecap([{ from: 'a', text }, { from: 'b', text: '네 좋습니다' }], ['a', 'b']);
      return r.nextMeeting !== null;
    };
    for (const t of [
      '3 월 15일부터 다시 모입시다', // 월 앞 공백 (\s?월 — \S 변이 방어, 뒤에 "부터"라 단독 일 대안도 안 걸림)
      '3월 15 일에 이어서 하죠', // 일 앞 공백 (\s?일 — \S 변이 방어)
      '2026-12-03 어떠세요', // 두 자리 월 ISO (\d{1,2} 축소 변이 방어)
      '20일 10:00으로 확정하죠', // 일 뒤 비한글(공백) — 부정 문자클래스 변이 방어
    ]) {
      expect(await hint(t), t).toBe(true);
    }
  }, 20_000);
});

describe('inferCritical — 인덱스 필터의 관측 가능한 효과', () => {
  it('범위 밖·비정수뿐이면 criticals 를 기록하지 않는다', async () => {
    const s = await setup('rv5');
    sayAt(s.meetingId, s.host.id, '검사 기준을 바꿉시다', 2);
    sayAt(s.meetingId, s.member.id, '네 그렇게 하죠', 1);
    queueJson({
      summary: '기준 변경',
      decisions: [
        { text: '기준 변경 확정', why: '', alternatives: [] },
        { text: '자료 공유', why: '', alternatives: [] },
      ],
      actions: [],
      next_meeting: null,
    });
    queueJson({ grounded: [true, true] });
    // 7(범위 밖)·-1(음수)·1.5(비정수)·2(길이 경계) — 전부 걸러져야 한다
    queueJson({ critical_decisions: [7, -1, 1.5, 2], critical_users: [] });
    const id = await runRecapForMeeting(s.code, [s.host.id]);
    expect(id).not.toBeNull();
    expect(JSON.parse(recapRow(id!).decisions)).toEqual(['기준 변경 확정', '자료 공유']);
    expect(recapRow(id!).criticals).toBeNull(); // 하나라도 살아남으면 [false,false]가 기록된다
    await flush();
  }, 20_000);
});

describe('runRecapForMeeting — 요약 창·재료 경계', () => {
  it('첫 recap 의 24시간 폴백 창 — 밖은 제외, 경계 직후는 포함', async () => {
    const s = await setup('rv6');
    const floor = Date.now() - 24 * 3600_000;
    // 경계 20분 뒤 — floor 와 같은 UTC 날짜가 되도록 보정 ("T"/" " 문자열 변이가 날짜 경계를 뭉개는 걸 잡는다)
    let tail = floor + 20 * 60_000;
    if (new Date(tail).getUTCDate() !== new Date(floor).getUTCDate()) tail = floor + 5000;
    const at = (t: number, text: string) =>
      db.prepare('INSERT INTO messages (meeting_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(s.meetingId, s.host.id, text, iso(t));
    at(floor - 3600_000, '창 밖 옛 발언');
    at(tail, '경계 직후 발언');
    at(Date.now() - 10 * 60_000, '최근 발언');

    queueJson({ summary: '요약 한 줄', decisions: [], actions: [], next_meeting: null });
    const id = await runRecapForMeeting(s.code, [s.host.id], { trigger: 'manual' });
    expect(id).not.toBeNull();
    expect(userPayload<{ chat: string[] }>(captured[0]).chat).toEqual([
      'rv6_host: 경계 직후 발언',
      'rv6_host: 최근 발언',
    ]);
    await flush();
  }, 20_000);

  it('통화 시작이 지난 recap 보다 오래되면 문서 창은 recap 이후로 좁힌다', async () => {
    const s = await setup('rv7');
    db.prepare(
      `INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, alts, actions, attendees, source, created_at, call_ended_at)
       VALUES (?, '이전 정리', '["이전 결정"]', '[""]', '[[]]', '[]', '[]', 'ai', ?, ?)`,
    ).run(s.meetingId, ago(30), ago(30));
    db.prepare('UPDATE meetings SET call_started_at = ? WHERE id = ?').run(ago(60), s.meetingId);
    const mkFile = (name: string) =>
      db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by) VALUES (?, ?, 'doc', ?)").run(s.meetingId, name, s.host.id).lastInsertRowid as number;
    const fOld = mkFile('오래된 문서');
    const fNew = mkFile('최근 문서');
    const act = (fid: number, min: number) =>
      db.prepare('INSERT INTO file_activity (meeting_id, file_id, ts) VALUES (?, ?, ?)').run(s.meetingId, fid, ago(min));
    act(fOld, 45); // 통화 시작(60분 전) 이후지만 지난 recap(30분 전) 이전 — 제외
    act(fNew, 10);
    sayAt(s.meetingId, s.host.id, '2호기 점검 먼저 하기로 결정합니다', 20);
    sayAt(s.meetingId, s.member.id, '네 확정입니다', 10);

    const id = await runRecapForMeeting(s.code, [s.host.id]); // 큐 없음 → 규칙 폴백
    expect(id).not.toBeNull();
    expect(JSON.parse(recapRow(id!).files!)).toEqual([{ id: fNew, name: '최근 문서', type: 'doc' }]);
    await flush();
  }, 20_000);

  it('재료 병합 — 시간 역순 채팅은 재정렬, 동시각 채팅·전사는 채팅 먼저', async () => {
    const s = await setup('rv8');
    const tTie = ago(30);
    const tNew = ago(10);
    // 채팅은 id 순으로 읽힌다 — 최신을 먼저 넣어 "시간 역순 입력"을 만든다
    db.prepare('INSERT INTO messages (meeting_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(s.meetingId, s.host.id, '나중 발언', tNew);
    db.prepare('INSERT INTO messages (meeting_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(s.meetingId, s.host.id, '먼저 발언', tTie);
    db.prepare("INSERT INTO call_transcripts (meeting_id, user_id, text, source, created_at) VALUES (?, ?, ?, 'whisper', ?)").run(s.meetingId, s.host.id, '동시각 전사', tTie);

    queueJson({ summary: '요약 한 줄', decisions: [], actions: [], next_meeting: null });
    const id = await runRecapForMeeting(s.code, [s.host.id], { trigger: 'manual' });
    expect(id).not.toBeNull();
    expect(userPayload<{ chat: string[] }>(captured[0]).chat).toEqual([
      'rv8_host: 먼저 발언',
      'rv8_host: 동시각 전사',
      'rv8_host: 나중 발언',
    ]);
    await flush();
  }, 20_000);
});

describe('aiRecap — 공백 응답 방어', () => {
  it('공백뿐인 응답은 empty AI response 로 즉시 폴백 (trim 변이 방어)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setNextResponses('   ');
      const r = await extractRecap(twoMsgs, ['a', 'b']);
      expect(r.source).toBe('rule');
      const calls = err.mock.calls.filter((c) => String(c[0]).includes('OpenAI 실패'));
      expect(calls).toHaveLength(1);
      expect((calls[0][1] as Error).message).toBe('empty AI response');
    } finally {
      err.mockRestore();
    }
  }, 20_000);
});
