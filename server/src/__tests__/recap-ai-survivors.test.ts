import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * recap.ts AI 경로 생존 변이 사냥 — 날짜 근거 게이트(hasDateHint)의 표현별 수용,
 * aiRecap 파싱 상한, inferCritical 인덱스 검증·직무 페이로드, runRecapForMeeting의
 * 세션 창·화자 정렬·문서 발췌·일정 연결·알림 문구, scheduleRecap/runFieldRecap 방송.
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
import {
  extractRecap,
  runRecapForMeeting,
  scheduleRecap,
  cancelScheduledRecap,
  runFieldRecap,
} from '../recap.js';
import { ensureAgentUser } from '../steward.js';
import { writeYdoc } from '../ydoc.js';
import { initNotifier } from '../notify.js';
import { register, createMeeting, joinMeeting, notifications, fakeIo, type User } from './helpers/fixtures.js';
import { captured, queueJson, resetOpenAiMock, userPayload, systemPrompt, waitFor, flush } from './helpers/openaiMock.js';

const app = createApp();
beforeEach(() => resetOpenAiMock());

const pad = (n: number) => String(n).padStart(2, '0');
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace('T', ' ').slice(0, 19);
const plusDays = (n: number) => new Date(Date.now() + n * 864e5).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
const todayKst = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

async function setup(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const member = await register(app, `${prefix}_member`);
  const m = await createMeeting(app, host, `${prefix} 그룹`);
  await joinMeeting(app, member, m.code);
  return { host, member, code: m.code, meetingId: m.id };
}
const sayAt = (meetingId: number, uid: number, text: string, min = 0) =>
  db.prepare('INSERT INTO messages (meeting_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(meetingId, uid, text, ago(min));
const trAt = (meetingId: number, uid: number, text: string, source: string, min = 0) =>
  db.prepare('INSERT INTO call_transcripts (meeting_id, user_id, text, source, created_at) VALUES (?, ?, ?, ?, ?)').run(meetingId, uid, text, source, ago(min));
const recapRow = (id: number) =>
  db.prepare('SELECT summary, decisions, actions, next_meeting, source, origin, event_id, files, criticals, call_ended_at FROM meeting_recaps WHERE id = ?').get(id) as {
    summary: string; decisions: string; actions: string; next_meeting: string | null; source: string;
    origin: string | null; event_id: number | null; files: string | null; criticals: string | null; call_ended_at: string;
  };
const backdate = (meetingId: number) =>
  db.prepare("UPDATE meeting_recaps SET call_ended_at = datetime('now', '-1 minute') WHERE meeting_id = ?").run(meetingId);

describe('hasDateHint — 다음 회의 날짜 근거 게이트', () => {
  it('원문의 날짜 표현별로 제안을 수용하고, 단서가 없으면 창작 날짜를 버린다', async () => {
    const future = plusDays(3);
    const hint = async (text: string) => {
      resetOpenAiMock();
      queueJson({ summary: '다음 일정 논의', decisions: [], actions: [], next_meeting: { title: '후속', date: future, time: '10:00' } });
      const r = await extractRecap([{ from: 'a', text }, { from: 'b', text: '네 좋습니다' }], ['a', 'b']);
      return r.nextMeeting !== null;
    };
    const accepted = [
      '다음 주에 정리합시다', '다음주에 정리합시다',
      '담 주에 이어서 하죠', '담주에 이어서 하죠',
      '이번 주 안에 다시 모입시다', '이번주 안에 다시 모입시다',
      '차주 회의로 넘기죠', '주말에 몰아서 보시죠',
      '내일 다시 이야기하죠', '모레 결과 봅시다',
      '수요일이 좋겠어요',
      '3월 15일부터 다시 모입시다', '3월15일부터 다시 모입시다',
      '2026-9-3 어떠세요',
      '15일에 다시 모이죠', '10일께 뵙죠', '20일쯤 가능하세요',
      '25일까지 정리하고 그날 회의하죠', '28일로 잡죠', '다음 정기 점검은 11일',
    ];
    for (const t of accepted) expect(await hint(t), t).toBe(true);
    for (const t of ['조만간 다시 잡죠', '나중에 일정 잡읍시다']) expect(await hint(t), t).toBe(false);
  }, 30_000);
});

describe('aiRecap — 파싱 상한·형식 방어·검증기 요청', () => {
  it('요약 160·결정 5개/200자·배경 160·대안 3개/120자·할 일 5개/160자, 빈 항목 스킵', async () => {
    queueJson({
      summary: '  ' + 'S'.repeat(200),
      decisions: [
        { text: 'D'.repeat(250), why: '  ' + 'W'.repeat(200), alternatives: ['A'.repeat(150), ' b ', 'c', 'd', 'e'] },
        '   ',
        { text: '   ' },
        ' 문자열 결정 ',
        { text: ' 네번째 ', why: 42, alternatives: 'not-array' },
        { text: '여섯째는 잘린다' }, // slice(0, 5) 밖
      ],
      actions: [
        { assignee: 'a', title: '  첫 할 일  ' },
        { assignee: 42, title: 'T'.repeat(200) },
        { assignee: 'ghost', title: '유령 담당' },
        { title: '   ' },
        { assignee: null, title: '넷' },
        { assignee: 'b', title: '다섯' },
        { assignee: 'b', title: '여섯' },
      ],
      next_meeting: null,
    });
    queueJson({ grounded: [true, true, true] });
    const r = await extractRecap([{ from: 'a', text: '내용 공유' }, { from: 'b', text: '네' }], ['a', 'b']);
    expect(r.source).toBe('ai');
    expect(r.summary).toBe('S'.repeat(160));
    expect(r.decisions).toEqual(['D'.repeat(200), '문자열 결정', '네번째']);
    expect(r.whys).toEqual(['W'.repeat(160), '', '42']);
    expect(r.alts).toEqual([['A'.repeat(120), 'b', 'c'], [], []]);
    expect(r.actions).toEqual([
      { assignee: 'a', title: '첫 할 일' },
      { assignee: null, title: 'T'.repeat(160) },
      { assignee: null, title: '유령 담당' },
      { assignee: null, title: '넷' },
      { assignee: 'b', title: '다섯' },
    ]);
    // 추출 시스템 프롬프트 — 각 규칙 문단이 실제로 담겨 나간다 (프롬프트 문자열 변이 방어)
    const sys = systemPrompt(captured[0]);
    for (const frag of [
      '너는 분산 근무 플랫폼 exist의 AI 운영자다',
      '이 결과는 회의에 참석하지 못한 팀원에게 그대로 전달되므로',
      '응답은 오직 JSON 한 개',
      'summary는 논의 핵심 한 줄',
      'decisions[].why는 그 결정의 배경·근거 한 줄',
      'decisions[].alternatives는 그 결정에 이르며 검토됐지만 채택되지 않은 다른 안',
      'actions는 구체적인 할 일(최대 5개)',
      'next_meeting은 다음 회의 시각이 로그에서 명시적으로 제안·합의된 경우에만',
      '상대 표현(내일, 수요일, 다음 주 금요일)',
      '할 일의 기한("화요일까지 정리")은 회의 날짜가 아니다',
      '"다음 회의에서 보시죠"처럼 날짜 없는 언급',
      '제조 현장 발화는 "결정했다"라고 말하지 않고',
      '적용 시점("다음 배치부터", "내일 주간조부터")',
      '"아직 결정 안 됐다", "확인하고 다시 얘기하자"는 결정이 아니고',
      '예시 1 — 기준 변경 + 기각안',
      '예시 2 — 유보 발언은 결정이 아니다',
      '예시 3 — 완료 보고는 결정이 아니다',
      '방열판 검사 온도 60도는 편차가 커요',
      '검토만 했고 확정되지 않음',
      '이미 한 일의 보고 — 새 결정 없음',
    ]) {
      expect(sys, frag).toContain(frag);
    }
    // 검증기 — 파싱된 3건이 "화자: 발언" 원문과 함께 넘어간다
    expect(captured).toHaveLength(2);
    const verify = captured[1];
    expect(systemPrompt(verify)).toContain('너는 회의 기록 검증기다');
    expect(systemPrompt(verify)).toContain('원문에서는 검토·제안·유보');
    const vp = userPayload<{ chat: string[]; decisions: string[] }>(verify);
    expect(vp.chat).toEqual(['a: 내용 공유', 'b: 네']);
    expect(vp.decisions).toHaveLength(3);
  }, 20_000);

  it('검증 플래그는 false만 탈락 — true가 아닌 잡값("y")은 유지', async () => {
    queueJson({ summary: '요약', decisions: ['하나 결정', '둘 결정'], actions: [], next_meeting: null });
    queueJson({ grounded: [true, 'y'] });
    const r = await extractRecap([{ from: 'a', text: '하나와 둘' }, { from: 'b', text: '네' }], ['a', 'b']);
    expect(r.decisions).toEqual(['하나 결정', '둘 결정']);
  }, 20_000);
});

describe('inferCritical — 관련성 추론 방어', () => {
  it('정수·범위 밖 인덱스는 버리고, 직무 없는 멤버는 빈 문자열로, 모르는 username은 무시', async () => {
    const s = await setup('rai1');
    sayAt(s.meetingId, s.host.id, '검사 기준을 바꿉시다', 2);
    sayAt(s.meetingId, s.member.id, '네 그렇게 하죠', 1);
    queueJson({
      summary: '기준 변경',
      decisions: [
        { text: '현장 검사 기준 변경', why: '', alternatives: [] },
        { text: '자료 공유', why: '', alternatives: [] },
      ],
      actions: [],
      next_meeting: null,
    });
    queueJson({ grounded: [true, true] });
    queueJson({ critical_decisions: [0, 1.5, -1, 7], critical_users: ['ghost', 'rai1_member'] });
    const id = await runRecapForMeeting(s.code, [s.host.id]);
    expect(JSON.parse(recapRow(id!).criticals!)).toEqual([true, false]);
    // 관련자(member)만 🔴 프리픽스
    expect(notifications(s.member.id).at(-1)!.text.startsWith('🔴 작업 전 확인 필수 — 놓친')).toBe(true);
    expect(notifications(s.host.id).at(-1)!.text.startsWith('🔴')).toBe(false);
    const critReq = captured[2];
    expect(critReq.model).toBe('gpt-4o-mini');
    for (const frag of [
      '너는 exist의 AI 총무다',
      'critical_decisions: 현장의 작업 방식·기준·수치·설비 조건·안전을 직접 바꾸는 결정의 인덱스',
      '일정 잡기·자료 공유 같은 운영성 결정은 제외',
      'critical_users: 그 결정이 작업 기준을 바꾸는 참가자 username',
      '응답은 오직 JSON: {"critical_decisions": number[], "critical_users": [username]}',
    ]) {
      expect(systemPrompt(critReq), frag).toContain(frag);
    }
    const mp = userPayload<{ decisions: string[]; members: { username: string; position: string; department: string }[] }>(critReq);
    expect(mp.decisions).toEqual(['0: 현장 검사 기준 변경', '1: 자료 공유']);
    expect(mp.members).toEqual(
      expect.arrayContaining([{ username: 'rai1_member', position: '', department: '' }]),
    );
    await flush();
  }, 20_000);
});

describe('runRecapForMeeting — 세션 창·재료 구성', () => {
  it('통화 시작 10분 전 패딩·AI/멘션 메시지 제외·whisper 우선·시간순 병합·문서 발췌·일정 연결', async () => {
    const s = await setup('rai2');
    db.prepare('UPDATE meetings SET call_started_at = ? WHERE id = ?').run(ago(30), s.meetingId);
    sayAt(s.meetingId, s.host.id, '창 밖 옛 발언', 50); // 패딩(-40분) 밖
    sayAt(s.meetingId, s.host.id, '통화 전 맥락', 35);
    sayAt(s.meetingId, s.host.id, '본 논의', 10);
    sayAt(s.meetingId, ensureAgentUser(), 'AI 잡음', 9); // AI 자신 제외
    sayAt(s.meetingId, s.member.id, '@AI', 8); // 멘션만 — 제외
    trAt(s.meetingId, s.host.id, 'W-첫', 'whisper', 20);
    trAt(s.meetingId, s.host.id, 'L-라이브', 'live', 15); // whisper 있으면 제외
    trAt(s.meetingId, s.member.id, 'W-둘', 'whisper', 5);

    // 이 회의에서 다룬 문서 — Yjs 룸 본문 발췌는 앞 3개, files 컬럼엔 전부
    writeYdoc('rai2-room1', (doc) => {
      doc.getMap('files').set('a', { name: 'main.md' });
      doc.getText('file:a').insert(0, '방열판  관리\n기준 65도');
    });
    writeYdoc('rai2-room2', (doc) => {
      doc.getMap('files').set('a', { name: 'b.txt' });
      doc.getText('file:a').insert(0, '이차 문서 본문');
    });
    writeYdoc('rai2-room3', (doc) => {
      doc.getMap('files').set('a', { name: 'c.txt' });
      doc.getText('file:a').insert(0, '삼차 본문');
    });
    const mkFile = (name: string, type: string, room: string | null) =>
      db.prepare('INSERT INTO collab_files (meeting_id, name, type, room, created_by) VALUES (?, ?, ?, ?, ?)').run(s.meetingId, name, type, room, s.host.id).lastInsertRowid as number;
    const f1 = mkFile('문서1', 'code', 'rai2-room1');
    const f2 = mkFile('문서2', 'code', 'rai2-room2');
    const f3 = mkFile('문서3', 'code', 'rai2-room3');
    const f4 = mkFile('업로드.pdf', 'file', null); // 본문 없음 — docs 제외, files 포함
    const f5 = mkFile('통화 전 문서', 'code', 'rai2-room1');
    const act = (fid: number, min: number) =>
      db.prepare('INSERT INTO file_activity (meeting_id, file_id, ts) VALUES (?, ?, ?)').run(s.meetingId, fid, ago(min));
    for (const f of [f1, f2, f3, f4]) act(f, 5);
    act(f5, 120); // 통화 시작 전 열람 — 제외

    // 오늘 일정 — 현재 시각에 가장 가까운 이벤트로 연결
    const nowHm = new Date().toLocaleTimeString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 5);
    const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
    const fmt = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
    const farMin = toMin(nowHm) < 720 ? toMin(nowHm) + 350 : toMin(nowHm) - 350;
    const mkEvent = (date: string, time: string | null) =>
      db.prepare('INSERT INTO meeting_events (meeting_id, title, date, time, created_by) VALUES (?, ?, ?, ?, ?)').run(s.meetingId, '이벤트', date, time, s.host.id).lastInsertRowid as number;
    const nearId = mkEvent(todayKst(), nowHm);
    mkEvent(todayKst(), fmt(farMin));
    mkEvent(plusDays(1), nowHm); // 다른 날짜 — 후보 아님

    queueJson({
      summary: '요약 한 줄',
      decisions: [{ text: '결정 하나', why: '', alternatives: [] }],
      actions: [{ assignee: 'rai2_member', title: '액션 하나' }],
      next_meeting: null,
    });
    queueJson({ grounded: [true] });
    queueJson({ critical_decisions: [], critical_users: [] });
    const id = await runRecapForMeeting(s.code, [s.host.id]);
    expect(id).not.toBeNull();

    const payload = userPayload<{ chat: string[]; docs?: string }>(captured[0]);
    expect(payload.chat).toEqual([
      'rai2_host: 통화 전 맥락',
      'rai2_host: W-첫',
      'rai2_host: 본 논의',
      'rai2_member: W-둘',
    ]);
    expect(payload.docs).toBe(
      '[문서1] main.md 방열판 관리 기준 65도\n[문서2] b.txt 이차 문서 본문\n[문서3] c.txt 삼차 본문',
    );

    const row = recapRow(id!);
    expect(row.event_id).toBe(nearId);
    expect(row.origin).toBeNull();
    expect((JSON.parse(row.files!) as { id: number }[]).map((f) => f.id)).toEqual([f1, f2, f3, f4]);
    expect(JSON.parse(row.files!)[0]).toEqual({ id: f1, name: '문서1', type: 'code' });

    // 알림 — 참석/불참 문구 + 통계 + 할 일 배정 suffix
    expect(notifications(s.host.id).at(-1)!.text).toBe('"rai2 그룹" 통화 정리: 요약 한 줄 (결정 1 · 할 일 1)');
    expect(notifications(s.member.id).at(-1)!.text).toBe(
      '놓친 "rai2 그룹" 통화의 결정이 도착했어요: 요약 한 줄 (결정 1 · 할 일 1) — 내 할 일 1개 배정됨',
    );
    await flush();
  }, 20_000);

  it('시간 없는 이벤트는 12시간 취급 — 시간 있는 이벤트가 이긴다', async () => {
    const s = await setup('rai3');
    const nowHm = new Date().toLocaleTimeString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 5);
    const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
    const fmt = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
    const timedMin = toMin(nowHm) < 720 ? toMin(nowHm) + 350 : toMin(nowHm) - 350;
    db.prepare('INSERT INTO meeting_events (meeting_id, title, date, time, created_by) VALUES (?, ?, ?, NULL, ?)').run(s.meetingId, '시간 없음', todayKst(), s.host.id);
    const timedId = db.prepare('INSERT INTO meeting_events (meeting_id, title, date, time, created_by) VALUES (?, ?, ?, ?, ?)').run(s.meetingId, '6시간 거리', todayKst(), fmt(timedMin), s.host.id).lastInsertRowid as number;
    sayAt(s.meetingId, s.host.id, '2호기 점검 먼저 하기로 결정합니다', 2);
    sayAt(s.meetingId, s.member.id, '네 확정입니다', 1);
    const id = await runRecapForMeeting(s.code, [s.host.id]); // 큐 없음 → 규칙 폴백
    expect(recapRow(id!).source).toBe('rule');
    expect(recapRow(id!).event_id).toBe(timedId);
    await flush();
  }, 20_000);

  it('통계 문구 — 결정·할 일 0건은 괄호 없음, 수동은 "기록"·세션 미소비, 다음 회의 제안 통계, 미지 코드·참가자 0명', async () => {
    const s = await setup('rai5');
    db.prepare('UPDATE meetings SET call_started_at = ? WHERE id = ?').run(ago(5), s.meetingId);
    sayAt(s.meetingId, s.host.id, '그냥 근황 공유였어요', 3);
    sayAt(s.meetingId, s.member.id, '네 잘 들었어요', 2);
    const id1 = await runRecapForMeeting(s.code, [s.host.id], { trigger: 'manual' }); // 큐 없음 → 규칙
    const row1 = recapRow(id1!);
    expect(row1.source).toBe('rule');
    expect(row1.event_id).toBeNull();
    expect(notifications(s.host.id).at(-1)!.text).toBe('"rai5 그룹" 기록 정리: 메시지 2건 논의 (뚜렷한 결정 없음)');
    // 수동 정리는 통화 세션을 소비하지 않는다
    expect((db.prepare('SELECT call_started_at AS t FROM meetings WHERE id = ?').get(s.meetingId) as { t: string | null }).t).not.toBeNull();

    // 다음 회의 제안만 있는 통계 + 통화 트리거는 세션 소비
    backdate(s.meetingId);
    sayAt(s.meetingId, s.host.id, '내일 오전에 이어서 하죠', 0);
    sayAt(s.meetingId, s.member.id, '네 좋습니다', 0);
    queueJson({ summary: '내일 이어서', decisions: [], actions: [], next_meeting: { title: '후속', date: plusDays(1), time: null } });
    const id2 = await runRecapForMeeting(s.code, [s.host.id, s.member.id]);
    expect(JSON.parse(recapRow(id2!).next_meeting!)).toEqual({ title: '후속', date: plusDays(1), time: null });
    expect(notifications(s.host.id).at(-1)!.text).toBe('"rai5 그룹" 통화 정리: 내일 이어서 (다음 회의 제안)');
    expect(notifications(s.member.id).at(-1)!.text).toBe('"rai5 그룹" 통화 정리: 내일 이어서 (다음 회의 제안)');
    expect((db.prepare('SELECT call_started_at AS t FROM meetings WHERE id = ?').get(s.meetingId) as { t: string | null }).t).toBeNull();

    // 미지의 코드 · 참가자 0명 → null
    expect(await runRecapForMeeting('ZZZZ99', [1])).toBeNull();
    backdate(s.meetingId);
    sayAt(s.meetingId, s.host.id, '한 마디 더', 0);
    db.prepare('DELETE FROM meeting_participants WHERE meeting_id = ?').run(s.meetingId);
    expect(await runRecapForMeeting(s.code, [])).toBeNull();
    await flush();
  }, 20_000);
});

describe('scheduleRecap · cancelScheduledRecap · runFieldRecap — 상태 방송', () => {
  it('유예 후 실행(generating→skipped/done)·재입장 취소(cleared)·현장 녹음 즉시 정리', async () => {
    const s = await setup('rai6');
    const io = fakeIo([s.host.id, s.member.id]);
    initNotifier(io.io as never);
    const states = (uid: number) => io.of(uid, 'recap:status').map((e) => (e.payload as { state: string }).state);

    // 재료 없음 — generating 후 skipped (소문자 코드도 동작)
    scheduleRecap(s.code.toLowerCase(), [s.host.id]);
    expect(states(s.host.id)).toEqual(['generating']);
    await waitFor(() => states(s.host.id).length >= 2, 3000);
    expect(states(s.host.id)).toEqual(['generating', 'skipped']);
    expect(states(s.member.id)).toEqual(['generating', 'skipped']);
    expect(io.of(s.host.id, 'recap:status').at(-1)!.payload).toEqual({ code: s.code, state: 'skipped' });

    // 재입장 — cleared, recap 은 만들어지지 않는다
    scheduleRecap(s.code, [s.host.id]);
    cancelScheduledRecap(s.code.toLowerCase());
    expect(states(s.host.id)).toEqual(['generating', 'skipped', 'generating', 'cleared']);
    await new Promise((r) => setTimeout(r, 150));
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM meeting_recaps WHERE meeting_id = ?').get(s.meetingId) as { n: number }).n;
    expect(count()).toBe(0);

    // 대화 있음 — done + recap 생성 (규칙 폴백)
    sayAt(s.meetingId, s.host.id, '2호기 점검 먼저 하기로 결정합니다', 2);
    sayAt(s.meetingId, s.member.id, '네 확정입니다', 1);
    scheduleRecap(s.code, [s.host.id]);
    await waitFor(() => count() >= 1 && states(s.host.id).at(-1) === 'done', 3000);
    expect(states(s.host.id).at(-1)).toBe('done');

    // 현장 녹음 — 전사 1건이면 "짧은 현장 녹음" 요약 + origin field
    const s2 = await setup('rai7');
    const io2 = fakeIo([s2.host.id, s2.member.id]);
    initNotifier(io2.io as never);
    trAt(s2.meetingId, s2.host.id, '금형 온도 점검부터 합시다', 'live', 1);
    const fid = await runFieldRecap(s2.code.toLowerCase(), [s2.host.id]);
    expect(fid).not.toBeNull();
    const row = recapRow(fid!);
    expect(row.origin).toBe('field');
    expect(row.source).toBe('rule');
    expect(row.summary).toBe('짧은 현장 녹음 — rai7_host: "금형 온도 점검부터 합시다"');
    expect(io2.of(s2.host.id, 'recap:status').map((e) => (e.payload as { state: string }).state)).toEqual(['generating', 'done']);
    await flush();
  }, 20_000);
});
