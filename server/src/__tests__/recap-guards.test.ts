import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * recap.ts 가드 — 결정 중복 판정(sameDecision) 임계, 근거 검증 게이트가 결정 0건이면 호출되지 않음,
 * 다음 회의 제안 검증(과거 날짜·시각 형식·null 시각), 짧은 통화가 전부 자동 기록과 겹치면 recap 생략.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  process.env.OPENAI_MODEL_RECAP = 'gpt-4o';
  process.env.RECAP_VERIFY = 'on';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { sameDecision, normalizeDecision, runRecapForMeeting, ackDecision, editDecision, withdrawDecision } from '../recap.js';
import { register, createMeeting, joinMeeting, insertRecap } from './helpers/fixtures.js';
import { queueJson, resetOpenAiMock, captured, systemPrompt } from './helpers/openaiMock.js';

const app = createApp();
beforeEach(() => resetOpenAiMock());

async function setup(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const member = await register(app, `${prefix}_member`);
  const m = await createMeeting(app, host, `${prefix} 회의`);
  await joinMeeting(app, member, m.code);
  return { host, member, code: m.code, meetingId: m.id };
}
const say = (meetingId: number, uid: number, text: string) => db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(meetingId, uid, text);
const recapRow = (id: number) => db.prepare('SELECT summary, decisions, next_meeting, source FROM meeting_recaps WHERE id = ?').get(id) as { summary: string; decisions: string; next_meeting: string | null; source: string };
/** 직전 recap 의 call_ended_at 을 뒤로 물려 같은 초에 넣은 메시지가 창 밖으로 밀리지 않게 */
const backdate = (meetingId: number) => db.prepare("UPDATE meeting_recaps SET call_ended_at = datetime('now', '-1 minute') WHERE meeting_id = ?").run(meetingId);
const todayKst = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 864e5).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);

describe('sameDecision — 이중 기입 판정 임계', () => {
  it('정규화 후 동일·포함이면 같고, 화자 프리픽스·종결어미·따옴표는 무시', () => {
    expect(normalizeDecision('kim: "방열판 두께 3mm로 확정했습니다."')).toBe('방열판두께3mm로확정');
    expect(sameDecision('kim: 야간조 인원 유지', '야간조 인원 유지함')).toBe(true);
    expect(sameDecision('방열판 두께 3mm로 확정', '방열판 두께 3mm로 확정했습니다')).toBe(true);
    expect(sameDecision('', '야간조')).toBe(false);
    expect(sameDecision('결정했다', '결정했습니다')).toBe(false); // 둘 다 정규화하면 빈 문자열
  }, 20_000);

  it('바이그램 자카드 — 8자 이상은 0.6 경계, 8자 미만은 0.75 경계, 짧은 쪽 길이로 판정', () => {
    expect(sameDecision('abcdefghijklmn', 'abcdefghijxxxx')).toBe(true); // 9/15 = 0.6 정확히
    expect(sameDecision('abcdefghijklmnop', 'abcdefghijxxxxxx')).toBe(false); // 9/17 < 0.6
    expect(sameDecision('abcdefgh', 'abcdefgxyz')).toBe(true); // min 8 → 0.6 기준, 6/10
    expect(sameDecision('abcdefg', 'abcdyzcdefg')).toBe(false); // min 7 → 0.75 기준, 6/9 = 0.67 (포함 관계 아님)
    expect(sameDecision('abcdefg', 'abcdefx')).toBe(false); // 5/7 = 0.71 < 0.75
    expect(sameDecision('abcdefgh', 'abcdefgx')).toBe(true); // 6/8 = 0.75 (8자 → 0.6 기준)
  }, 20_000);

  it('수치가 다르면 바이그램이 아무리 겹쳐도 다른 결정, 한쪽만 수치가 있으면 바이그램으로', () => {
    expect(sameDecision('방열판 두께 3mm로 확정', '방열판 두께 5mm로 확정')).toBe(false);
    expect(sameDecision('검사 온도 65도로 상향', '검사 온도 65도로 상향, 다음 배치부터')).toBe(true);
    expect(sameDecision('방열판 두께 3mm로 확정', '방열판 두께 mm로 확정')).toBe(true);
    expect(sameDecision('점검 주기 2.5일', '점검 주기 2.7일')).toBe(false);
  }, 20_000);
});

describe('근거 검증 게이트 · 다음 회의 검증', () => {
  it('결정이 0건이면 검증 호출 없이 통과, 결정이 있으면 검증기가 false 로 찍은 것만 빠진다', async () => {
    const s = await setup('vg1');
    say(s.meetingId, s.host.id, '오늘은 특별한 결정 없이 진행 상황만 공유했어요');
    say(s.meetingId, s.member.id, '네 확인했습니다');
    queueJson({ summary: '진행 상황 공유', decisions: [], actions: [], next_meeting: null });
    const id = await runRecapForMeeting(s.code, [s.host.id]);
    expect(id).not.toBeNull();
    expect(captured).toHaveLength(1); // 추출 1회뿐 — 검증·관련성 호출 없음
    expect(JSON.parse(recapRow(id!).decisions)).toEqual([]);

    resetOpenAiMock();
    backdate(s.meetingId);
    say(s.meetingId, s.host.id, '검사 온도는 65도로 올리죠');
    say(s.meetingId, s.member.id, '네 그렇게 하죠');
    queueJson({ summary: '온도 상향', decisions: [{ text: '검사 온도 65도로 상향', why: '편차', alternatives: [] }, { text: '야간조 인원 감축', why: '', alternatives: [] }], actions: [], next_meeting: null });
    queueJson({ grounded: [true, false] });
    queueJson({ critical_decisions: [], critical_users: [] });
    const id2 = await runRecapForMeeting(s.code, [s.host.id]);
    expect(captured).toHaveLength(3);
    expect(captured[1].model).toBe('gpt-4o-mini');
    expect(captured[1].temperature).toBe(0);
    expect(systemPrompt(captured[1])).toContain('회의 기록 검증기');
    expect(JSON.parse(recapRow(id2!).decisions)).toEqual(['검사 온도 65도로 상향']);
  }, 20_000);

  it('next_meeting — 과거 날짜·형식 오류 시각·잘못된 날짜 형식은 버리고, null 시각·오늘 날짜는 통과, 제목 80자', async () => {
    const s = await setup('nm1');
    const run = async (nm: unknown) => {
      resetOpenAiMock();
      backdate(s.meetingId);
      say(s.meetingId, s.host.id, `다음 주 월요일에 다시 보죠 ${Math.random()}`);
      say(s.meetingId, s.member.id, '네');
      queueJson({ summary: '추후 논의', decisions: [], actions: [], next_meeting: nm });
      const id = await runRecapForMeeting(s.code, [s.host.id]);
      return recapRow(id!).next_meeting;
    };
    expect(await run({ title: '후속', date: plusDays(-1), time: '10:00' })).toBeNull(); // 어제
    expect(await run({ title: '후속', date: plusDays(3), time: '24:00' })).toBeNull();
    expect(await run({ title: '후속', date: plusDays(3), time: '9:30' })).toBeNull();
    expect(await run({ title: '후속', date: plusDays(3), time: '09:60' })).toBeNull();
    expect(await run({ title: '후속', date: '2099-1-1', time: '09:30' })).toBeNull();
    expect(await run({ title: '후속', date: plusDays(3) + 'T', time: '09:30' })).toBeNull();
    expect(await run('2099-01-01')).toBeNull(); // 객체가 아님
    expect(JSON.parse((await run({ title: '  ' + 'x'.repeat(100), date: todayKst(), time: null }))!)).toEqual({ title: 'x'.repeat(80), date: todayKst(), time: null });
    expect(JSON.parse((await run({ date: plusDays(3), time: '23:59' }))!)).toEqual({ title: '다음 회의', date: plusDays(3), time: '23:59' });
  }, 20_000);

  it('짧은 통화(발언 1건)가 전부 자동 기록과 겹치면 recap 을 만들지 않고 자동 기록 id 를 돌려준다', async () => {
    const s = await setup('sd1');
    db.prepare("UPDATE meetings SET call_started_at = datetime('now', '-5 minutes') WHERE id = ?").run(s.meetingId);
    const autoId = insertRecap(s.meetingId, ['검사 온도 65도로 상향하기로 결정'], { source: 'auto', summary: '' });
    say(s.meetingId, s.host.id, '검사 온도 65도로 상향하기로 결정했습니다');
    const before = (db.prepare('SELECT COUNT(*) AS n FROM meeting_recaps WHERE meeting_id = ?').get(s.meetingId) as { n: number }).n;
    const id = await runRecapForMeeting(s.code, [s.host.id]);
    expect(id).toBe(autoId);
    expect(captured).toHaveLength(0); // 발언 1건은 AI 를 안 태운다
    expect((db.prepare('SELECT COUNT(*) AS n FROM meeting_recaps WHERE meeting_id = ?').get(s.meetingId) as { n: number }).n).toBe(before);
    expect((db.prepare('SELECT call_started_at FROM meetings WHERE id = ?').get(s.meetingId) as { call_started_at: string | null }).call_started_at).toBeNull(); // 세션 소비
    // 겹치지 않는 한 마디는 "짧은 통화" 요약으로 남는다
    db.prepare("UPDATE meetings SET call_started_at = datetime('now', '-1 minutes') WHERE id = ?").run(s.meetingId);
    db.prepare("UPDATE messages SET created_at = datetime('now', '-30 minutes') WHERE meeting_id = ?").run(s.meetingId); // 첫 발언은 이번 세션 창 밖
    say(s.meetingId, s.member.id, '지그 교체는 제가 내일까지 할게요');
    const id2 = await runRecapForMeeting(s.code, [s.member.id]);
    expect(id2).not.toBe(autoId);
    const row = recapRow(id2!);
    expect(row.source).toBe('rule');
    expect(row.summary).toBe('짧은 통화 — sd1_member: "지그 교체는 제가 내일까지 할게요"');
  }, 20_000);

  it('ackDecision·editDecision·withdrawDecision — 범위 밖 idx·없는 recap 거부, 서명 형식 검증(40,000자 미만·png dataURL)', async () => {
    const s = await setup('ak1');
    const recapId = insertRecap(s.meetingId, ['A', 'B']);
    expect(ackDecision(999999, 0, s.host.id)).toBe(false);
    expect(ackDecision(recapId, -1, s.host.id)).toBe(false);
    expect(ackDecision(recapId, 2, s.host.id)).toBe(false);
    expect(ackDecision(recapId, 1, s.host.id)).toBe(true);
    const sig = 'data:image/png;base64,' + 'A'.repeat(100);
    expect(ackDecision(recapId, 1, s.host.id, '  노트  ', sig)).toBe(true); // 멱등 + 노트·서명 추가
    expect(db.prepare('SELECT note, signature FROM decision_acks WHERE recap_id = ? AND decision_idx = 1 AND user_id = ?').get(recapId, s.host.id)).toEqual({ note: '노트', signature: sig });
    expect(ackDecision(recapId, 0, s.member.id, '', 'data:image/jpeg;base64,AAAA')).toBe(true);
    expect(db.prepare('SELECT note, signature FROM decision_acks WHERE recap_id = ? AND decision_idx = 0 AND user_id = ?').get(recapId, s.member.id)).toEqual({ note: null, signature: null });
    expect(ackDecision(recapId, 0, s.member.id, null, 'data:image/png;base64,' + 'B'.repeat(40_000))).toBe(true);
    expect(db.prepare('SELECT signature FROM decision_acks WHERE recap_id = ? AND decision_idx = 0 AND user_id = ?').get(recapId, s.member.id)).toEqual({ signature: null });
    expect(ackDecision(recapId, 0, s.member.id, null, 'data:image/png;base64,' + 'B'.repeat(40_000 - 22 - 1))).toBe(true);
    expect((db.prepare('SELECT signature FROM decision_acks WHERE recap_id = ? AND decision_idx = 0 AND user_id = ?').get(recapId, s.member.id) as { signature: string }).signature).toHaveLength(39_999);
    expect(db.prepare('SELECT COUNT(*) AS n FROM decision_acks WHERE recap_id = ?').get(recapId)).toEqual({ n: 2 });
    expect(editDecision(999999, 0, s.host.id, { decision: 'x', reason: 'r' })).toEqual({ ok: false, error: '존재하지 않는 결정입니다' });
    expect(editDecision(recapId, 2, s.host.id, { decision: 'x', reason: 'r' })).toEqual({ ok: false, error: '존재하지 않는 결정입니다' });
    expect(editDecision(recapId, -1, s.host.id, { decision: 'x', reason: 'r' }).ok).toBe(false);
    expect(withdrawDecision(999999, 0, s.host.id, 'r')).toEqual({ ok: false, error: '존재하지 않는 결정입니다' });
    expect(withdrawDecision(recapId, 2, s.host.id, 'r').ok).toBe(false);
    expect(withdrawDecision(recapId, 1, s.host.id, '   ')).toEqual({ ok: false, error: '철회 사유를 적어주세요' });
    expect(withdrawDecision(recapId, 1, s.host.id, ' ' + 'r'.repeat(400)).ok).toBe(true);
    const st = JSON.parse((db.prepare('SELECT decision_state FROM meeting_recaps WHERE id = ?').get(recapId) as { decision_state: string }).decision_state) as ({ reason: string; by: string } | null)[];
    expect(st[0]).toBeNull();
    expect(st[1]!.reason).toHaveLength(300);
    expect(st[1]!.by).toBe('ak1_host');
    // 정정 문장·배경도 300자 절단, 서명 스냅샷 없이도 OK
    const long = editDecision(recapId, 0, s.host.id, { decision: 'd'.repeat(400), why: 'w'.repeat(400), reason: 'r' });
    expect(long.ok).toBe(true);
    const rec = db.prepare('SELECT decisions, whys FROM meeting_recaps WHERE id = ?').get(recapId) as { decisions: string; whys: string };
    expect((JSON.parse(rec.decisions) as string[])[0]).toHaveLength(300);
    expect((JSON.parse(rec.whys) as string[])[0]).toHaveLength(300);
  }, 20_000);
});
