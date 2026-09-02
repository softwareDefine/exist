import { describe, it, expect } from 'vitest';

/*
 * recap.ts 생존 변이 사냥 (9/2 뮤테이션 재실행 기준) — AI 없이 도는 경로:
 * ruleBasedRecap 상한·오탐 방지, normalizeDecision 정규식 경계, editDecision/withdrawDecision
 * 에러 문구·이력, listDecisions 필드·limit, getRecapSource 창 재구성, markNextMeetingRegistered,
 * runDecisionReminders(24h 1회), sweepDecisionAckAutoReminders(집계·간격·문구).
 */
import { createApp } from '../app.js';
import db from '../db.js';
import {
  ruleBasedRecap,
  normalizeDecision,
  sameDecision,
  listDecisions,
  listDecisionRevisions,
  getRecapSource,
  markNextMeetingRegistered,
  runDecisionReminders,
  sweepDecisionAckAutoReminders,
  editDecision,
  withdrawDecision,
  ackDecision,
} from '../recap.js';
import { ensureAgentUser } from '../steward.js';
import { register, createMeeting, joinMeeting, insertRecap, notifications } from './helpers/fixtures.js';

const app = createApp();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace('T', ' ').slice(0, 19);
const sayAt = (meetingId: number, uid: number, text: string, min: number) =>
  db.prepare('INSERT INTO messages (meeting_id, user_id, text, created_at) VALUES (?, ?, ?, ?)').run(meetingId, uid, text, ago(min));
const trAt = (meetingId: number, uid: number, text: string, source: string, min: number) =>
  db.prepare('INSERT INTO call_transcripts (meeting_id, user_id, text, source, created_at) VALUES (?, ?, ?, ?, ?)').run(meetingId, uid, text, source, ago(min));
const msg = (from: string, text: string) => ({ from, text });

describe('ruleBasedRecap — 규칙 폴백 경계', () => {
  it('결정 5개 상한·트림·부정/완료 오탐 방지', () => {
    const P = ['kim', 'lee'];
    const six = ruleBasedRecap([1, 2, 3, 4, 5, 6].map((n) => msg('kim', `  ${n}안으로 확정합니다  `)), P);
    expect(six.decisions).toHaveLength(5);
    expect(six.decisions[0]).toBe('kim: 1안으로 확정합니다'); // 트림된 원문 + 화자 프리픽스
    expect(six.summary).toBe('1안으로 확정합니다');
    expect(six.whys).toEqual(['', '', '', '', '']);
    expect(six.alts).toEqual([[], [], [], [], []]);
    expect(six.actions).toEqual([]);
    expect(six.nextMeeting).toBeNull();
    expect(six.source).toBe('rule');

    // 부정·유보 — "못 " 뒤 공백 포함 케이스가 핵심 (못\s 변이 방어)
    const neg = ruleBasedRecap(
      [
        msg('kim', '아직 결정 안 났어요'),
        msg('kim', '거기까지는 못 갔지만 A안으로 확정합니다'),
        msg('kim', '확정은 다음에 하죠'),
      ],
      P,
    );
    expect(neg.decisions).toEqual([]);
    expect(neg.summary).toBe('메시지 3건 논의 (뚜렷한 결정 없음)');

    // 완료 보고는 할 일이 아니다 (까지 신호가 있어도)
    const done = ruleBasedRecap([msg('kim', '보고서 정리는 어제까지 다 했습니다')], P);
    expect(done.actions).toEqual([]);
    expect(done.decisions).toEqual([]);
    expect(done.summary).toBe('메시지 1건 논의 (뚜렷한 결정 없음)');
  });

  it('담당자 매칭 — @참여자·"제가+게요/겠습니다"만, 할 일 5개 상한·120자 절단', () => {
    const P = ['kim', 'lee'];
    const acts = ruleBasedRecap(
      [
        msg('kim', '자재 발주는 제가 처리하겠습니다'),
        msg('lee', '@kim 리허설 준비까지 부탁해요'),
        msg('lee', '@ghost 안내문 전달 부탁해요'),
        msg('kim', '제가 맡은 검사 기록도 내일까지 부탁해요'), // 제가 있어도 게요/겠습니다 없음 → null
      ],
      P,
    );
    expect(acts.actions).toEqual([
      { assignee: 'kim', title: '자재 발주는 제가 처리하겠습니다' },
      { assignee: 'kim', title: '@kim 리허설 준비까지 부탁해요' },
      { assignee: null, title: '@ghost 안내문 전달 부탁해요' },
      { assignee: null, title: '제가 맡은 검사 기록도 내일까지 부탁해요' },
    ]);

    const many = ruleBasedRecap([1, 2, 3, 4, 5, 6].map((n) => msg('lee', `${n}번 항목 정리 부탁해요`)), P);
    expect(many.actions).toHaveLength(5);

    const longAct = ruleBasedRecap([msg('kim', '나'.repeat(115) + ' 정리 부탁해요')], P);
    expect(longAct.actions[0].title).toHaveLength(120);
  });

  it('요약 — 첫 결정에서 화자 프리픽스 제거 + 80자, 결정 문장은 120자 절단', () => {
    const long = '가'.repeat(130) + ' 확정합니다';
    const r = ruleBasedRecap([msg('kim', long)], ['kim']);
    expect(r.decisions[0]).toBe('kim: ' + '가'.repeat(120));
    expect(r.summary).toBe('가'.repeat(80));
  });
});

describe('normalizeDecision · sameDecision — 정규식 경계 보강', () => {
  it('프리픽스는 문장 시작에서만 · 공백 0개 허용 · 뒤 문자를 먹지 않음 · 꼬리 문장부호 전부 제거', () => {
    expect(normalizeDecision(':x: 온도 65도로 상향')).toBe(':x:온도65도로상향'); // 시작이 콜론이면 프리픽스 아님
    expect(normalizeDecision('kim:방열판 3mm 확정')).toBe('방열판3mm확정'); // 콜론 뒤 공백 없어도 벗긴다
    expect(normalizeDecision('점검 강화!!!')).toBe('점검강화'); // !!! 전부
    expect(normalizeDecision('버전 3.5 채택!!')).toBe('버전3.5채택'); // 중간의 소수점은 남는다
    expect(normalizeDecision('야간 점검 하기로 함')).toBe('야간점검');
    expect(normalizeDecision('출하 기준 강화하기로 했음')).toBe('출하기준강화');
    expect(normalizeDecision('2호기 정비로 결정했다')).toBe('2호기정비');
    expect(normalizeDecision('전 라인에 공지한다')).toBe('전라인에공지');
  });

  it('포함 관계 — 앞쪽이 뒤쪽을 포함해도 같은 결정', () => {
    expect(sameDecision('방열판 두께 3mm로 확정 후 전 라인 공지', '방열판 두께 3mm로 확정')).toBe(true);
  });
});

describe('editDecision · withdrawDecision — 이력·서명·에러 문구', () => {
  it('배경만 정정=서명 유지, 문장 정정=스냅샷 후 초기화+리마인드 삭제, 철회 이력·#id 편집자', async () => {
    const host = await register(app, 'rs1_host');
    const member = await register(app, 'rs1_member');
    const m = await createMeeting(app, host, 'rs1 그룹');
    await joinMeeting(app, member, m.code);
    const recapId = insertRecap(m.id, ['원래 문장', '둘째'], { whys: ['원래 배경', ''] });
    ackDecision(recapId, 0, member.id, '현장 확인');
    db.prepare('INSERT INTO decision_remind_sent (recap_id, user_id) VALUES (?, ?)').run(recapId, member.id);

    expect(editDecision(recapId, 0, host.id, { reason: '  ' })).toEqual({ ok: false, error: '정정 사유를 적어주세요' });
    expect(editDecision(recapId, 0, host.id, { decision: '  ', reason: 'r' })).toEqual({ ok: false, error: '결정 문장은 비울 수 없어요' });
    expect(editDecision(recapId, 0, host.id, { decision: '원래 문장', why: '원래 배경', reason: 'r' })).toEqual({ ok: false, error: '바뀐 내용이 없어요' });

    // 배경만 — 서명 유지
    expect(editDecision(recapId, 0, host.id, { why: ' 새 배경 ', reason: ' 배경 보강 ' })).toEqual({ ok: true, acksReset: false, prevDecision: '원래 문장' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM decision_acks WHERE recap_id = ?').get(recapId) as { n: number }).n).toBe(1);
    expect(JSON.parse((db.prepare('SELECT whys FROM meeting_recaps WHERE id = ?').get(recapId) as { whys: string }).whys)).toEqual(['새 배경', '']);

    // 문장 — 서명 초기화 + 리마인드 기록 삭제
    expect(editDecision(recapId, 0, host.id, { decision: '고친 문장', reason: '오기 수정' })).toEqual({ ok: true, acksReset: true, prevDecision: '원래 문장' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM decision_acks WHERE recap_id = ?').get(recapId) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM decision_remind_sent WHERE recap_id = ?').get(recapId) as { n: number }).n).toBe(0);

    const revs = listDecisionRevisions(recapId, 0);
    expect(revs).toHaveLength(2);
    expect(revs[0]).toMatchObject({
      kind: 'edit', prevDecision: '원래 문장', prevWhy: '원래 배경', newDecision: '원래 문장', newWhy: '새 배경',
      reason: '배경 보강', editor: 'rs1_host', prevAcks: ['rs1_member'],
    });
    expect(revs[0].ts).toEqual(expect.any(Number));
    expect(revs[1]).toMatchObject({ kind: 'edit', prevDecision: '원래 문장', newDecision: '고친 문장', prevAcks: ['rs1_member'] });

    // 철회 — 편집자 username 기록, 사유는 이력에도 300자 절단, 재철회·철회 후 정정 거부
    expect(withdrawDecision(recapId, 1, member.id, 'x'.repeat(400))).toEqual({ ok: true });
    const state = JSON.parse(
      (db.prepare('SELECT decision_state FROM meeting_recaps WHERE id = ?').get(recapId) as { decision_state: string }).decision_state,
    ) as ({ by: string; reason: string } | null)[];
    expect(state[1]!.by).toBe('rs1_member');
    const wrev = listDecisionRevisions(recapId, 1);
    expect(wrev).toHaveLength(1);
    expect(wrev[0].kind).toBe('withdraw');
    expect(wrev[0].prevDecision).toBe('둘째');
    expect(wrev[0].reason).toHaveLength(300);
    expect(withdrawDecision(recapId, 1, host.id, '또')).toEqual({ ok: false, error: '이미 철회된 결정이에요' });
    expect(editDecision(recapId, 1, host.id, { decision: 'x', reason: 'r' })).toEqual({ ok: false, error: '철회된 결정은 정정할 수 없어요' });
  }, 20_000);
});

describe('listDecisions — 원장 전개', () => {
  it('확인(노트·서명)·todo·개정 문서 역링크·철회·정정 수·limit', async () => {
    const host = await register(app, 'rs2_host');
    const member = await register(app, 'rs2_member');
    const m = await createMeeting(app, host, 'rs2 그룹');
    await joinMeeting(app, member, m.code);
    // 9일 전 — runDecisionReminders 의 7일 창 밖에 둬서 다른 테스트를 오염시키지 않는다
    const atA = ago(9 * 24 * 60);
    const atB = ago(9 * 24 * 60 - 30);
    const rA = insertRecap(m.id, ['첫 결정', '철회될 결정'], { whys: ['배경', ''], attendees: ['rs2_host'], createdAt: atA });
    db.prepare('UPDATE meeting_recaps SET alts = ?, criticals = ? WHERE id = ?').run('[["대안 — 기각"],[]]', '[true,false]', rA);
    const sig = 'data:image/png;base64,' + 'A'.repeat(50);
    ackDecision(rA, 0, member.id, '노트', sig);
    db.prepare('INSERT INTO todos (user_id, meeting_id, title, recap_id, done) VALUES (?, ?, ?, ?, 1)').run(member.id, m.id, '후속 작업', rA);
    const fid = db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by) VALUES (?, '개정 문서', 'doc', ?)").run(m.id, host.id).lastInsertRowid as number;
    db.prepare('INSERT INTO file_rev_snapshots (file_id, rev, basis_recap_id, basis_decision_idx) VALUES (?, 2, ?, 0)').run(fid, rA);
    const gone = db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by, deleted_at) VALUES (?, '삭제된 문서', 'doc', ?, datetime('now'))").run(m.id, host.id).lastInsertRowid as number;
    db.prepare('INSERT INTO file_rev_snapshots (file_id, rev, basis_recap_id, basis_decision_idx) VALUES (?, 1, ?, 0)').run(gone, rA);
    expect(editDecision(rA, 0, host.id, { why: '보강', reason: 'r' }).ok).toBe(true);
    expect(withdrawDecision(rA, 1, host.id, '방향 변경').ok).toBe(true);
    const rB = insertRecap(m.id, ['둘째 결정'], { createdAt: atB });

    const all = listDecisions(m.id);
    expect(all.map((e) => [e.recapId, e.idx])).toEqual([[rB, 0], [rA, 0], [rA, 1]]);
    expect(all[1]).toMatchObject({
      decision: '첫 결정', why: '보강', alts: ['대안 — 기각'], critical: true, attendees: ['rs2_host'],
      revisions: 1, withdrawn: null,
      acks: [{ username: 'rs2_member', note: '노트', signature: sig, ts: expect.any(Number) }],
      todos: [{ title: '후속 작업', done: 1 }],
      revisedFiles: [{ id: fid, rev: 2, name: '개정 문서' }],
    });
    expect(all[1].ts).toBe(Date.parse(atA.replace(' ', 'T') + 'Z'));
    expect(all[2].withdrawn).toMatchObject({ reason: '방향 변경', by: 'rs2_host' });
    expect(all[2].critical).toBe(false);
    expect(all[2].revisedFiles).toEqual([]);
    expect(listDecisions(m.id, 2).map((e) => [e.recapId, e.idx])).toEqual([[rB, 0], [rA, 0]]);
  }, 20_000);
});

describe('getRecapSource — 회의 원문 창 재구성', () => {
  it('직전 recap ~ 이 recap 창, whisper 우선, 시간순, 수동/자동/없음은 null', async () => {
    const host = await register(app, 'rs3_host');
    const m = await createMeeting(app, host, 'rs3 그룹');
    const agentId = ensureAgentUser();
    const r1 = insertRecap(m.id, ['옛 결정'], { createdAt: ago(180) });
    const r2 = insertRecap(m.id, ['새 결정'], { createdAt: ago(0) });
    sayAt(m.id, host.id, '옛 발언', 240); // r1 창 (r1 종료 -24h ~ r1 종료)
    sayAt(m.id, host.id, '한 시간 전 채팅', 60);
    sayAt(m.id, agentId, 'AI 답변은 원문이 아니다', 50);
    trAt(m.id, host.id, 'W-첫', 'whisper', 40);
    trAt(m.id, host.id, 'L-라이브', 'live', 30); // whisper 있으면 제외
    trAt(m.id, host.id, 'W-둘', 'whisper', 10);

    const src2 = getRecapSource(m.id, r2)!;
    expect(src2.items.map((i) => [i.from, i.text, i.kind])).toEqual([
      ['rs3_host', '한 시간 전 채팅', 'chat'],
      ['rs3_host', 'W-첫', 'voice'],
      ['rs3_host', 'W-둘', 'voice'],
    ]);
    expect(src2.items[0].ts).toBeLessThan(src2.items[1].ts);

    const src1 = getRecapSource(m.id, r1)!;
    expect(src1.items.map((i) => i.text)).toEqual(['옛 발언']);

    // whisper 가 없으면 live 전사 사용
    const m2 = await createMeeting(app, host, 'rs3 라이브만');
    const r3 = insertRecap(m2.id, [], { createdAt: ago(0) });
    trAt(m2.id, host.id, '라이브 전사만', 'live', 5);
    expect(getRecapSource(m2.id, r3)!.items.map((i) => [i.text, i.kind])).toEqual([['라이브 전사만', 'voice']]);

    // 수동·자동·없음·다른 회의 → null
    const manual = insertRecap(m.id, [], { source: 'manual' });
    const auto = insertRecap(m.id, [], { source: 'auto' });
    expect(getRecapSource(m.id, manual)).toBeNull();
    expect(getRecapSource(m.id, auto)).toBeNull();
    expect(getRecapSource(m.id, 999999)).toBeNull();
    expect(getRecapSource(m2.id, r2)).toBeNull();
  }, 20_000);
});

describe('markNextMeetingRegistered', () => {
  it('제안이 있어야 하고 회의가 일치해야 true, registered 플래그만 추가', async () => {
    const host = await register(app, 'rs4_host');
    const m = await createMeeting(app, host, 'rs4 그룹');
    const recapId = insertRecap(m.id, []);
    expect(markNextMeetingRegistered(recapId, m.id)).toBe(false); // 제안 없음
    db.prepare('UPDATE meeting_recaps SET next_meeting = ? WHERE id = ?').run(JSON.stringify({ title: '후속', date: '2099-01-02', time: null }), recapId);
    expect(markNextMeetingRegistered(recapId, 999999)).toBe(false); // 다른 회의
    expect(markNextMeetingRegistered(recapId, m.id)).toBe(true);
    expect(JSON.parse((db.prepare('SELECT next_meeting FROM meeting_recaps WHERE id = ?').get(recapId) as { next_meeting: string }).next_meeting)).toEqual({
      title: '후속', date: '2099-01-02', time: null, registered: true,
    });
  }, 20_000);
});

describe('runDecisionReminders — 24시간 뒤 1회 조름', () => {
  it('미확인자에게만·정확한 문구·중복 발송 없음·창(24h~7d)·빈 결정 제외', async () => {
    const host = await register(app, 'rs5_host');
    const a = await register(app, 'rs5_a');
    const b = await register(app, 'rs5_b');
    const m = await createMeeting(app, host, 'rs5 그룹');
    await joinMeeting(app, a, m.code);
    await joinMeeting(app, b, m.code);
    const recapId = insertRecap(m.id, ['결정 A', '결정 B'], { createdAt: ago(25 * 60) });
    ackDecision(recapId, 0, a.id); // 하나라도 확인한 사람은 제외
    insertRecap(m.id, ['방금 결정']); // 24시간 미만 — 대상 아님
    insertRecap(m.id, ['너무 옛 결정'], { createdAt: ago(8 * 24 * 60) }); // 7일 초과
    insertRecap(m.id, [], { createdAt: ago(25 * 60) }); // 빈 결정

    expect(runDecisionReminders()).toBe(1); // b 만 — 발신자(호스트)는 리마인드 대상 아님 (9/3 결함 #10b)
    const text = '"rs5 그룹"의 결정 2건이 아직 확인을 기다려요 — 결정 탭에서 서명해 주세요';
    expect(notifications(host.id)).toEqual([]);
    expect(notifications(b.id)).toEqual([{ from_name: 'exist AI', text, kind: 'recap', meeting_code: m.code }]);
    expect(notifications(a.id)).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM decision_remind_sent WHERE recap_id = ?').get(recapId) as { n: number }).n).toBe(1);
    expect(runDecisionReminders()).toBe(0); // 1회만
    expect(notifications(b.id)).toHaveLength(1);
  }, 20_000);
});

describe('sweepDecisionAckAutoReminders — 자동 에스컬레이션', () => {
  it('사용자당 1건 집계·시간/일 표기·호스트 보고·재발송 간격·전부 확인 시 침묵', async () => {
    process.env.ACK_AUTOREMIND_HOURS = '1';
    try {
      const host = await register(app, 'rs6_host');
      const a = await register(app, 'rs6_a');
      const b = await register(app, 'rs6_b');
      const m = await createMeeting(app, host, 'rs6 그룹');
      await joinMeeting(app, a, m.code);
      await joinMeeting(app, b, m.code);
      const recapId = insertRecap(m.id, ['D-하나', 'D-둘'], { createdAt: ago(90) });
      ackDecision(recapId, 0, a.id);
      ackDecision(recapId, 1, a.id);
      const done = insertRecap(m.id, ['다 확인한 결정'], { createdAt: ago(90) });
      for (const u of [host, a, b]) ackDecision(done, 0, u.id);

      sweepDecisionAckAutoReminders();
      const pendingText = "'D-하나' 외 1건이 확인 대기예요 (최장 1시간째) — 'rs6 그룹' 기록 탭에서 확인해 주세요";
      expect(notifications(b.id).map((n) => n.text)).toEqual([pendingText]);
      expect(notifications(b.id)[0]).toMatchObject({ from_name: 'exist AI', kind: 'recap', meeting_code: m.code });
      // 발신자(호스트)는 미확인이어도 리마인드 대상이 아니다 — 현황 보고만 받는다 (9/3 결함 #10b)
      expect(notifications(host.id).map((n) => n.text)).toEqual([
        "미확인 결정 2건에 자동 리마인드를 보냈어요 ('rs6 그룹') — 대상: rs6_b",
      ]);
      expect(notifications(a.id)).toEqual([]);
      expect((db.prepare('SELECT COUNT(*) AS n FROM decision_ack_autoremind WHERE recap_id = ?').get(recapId) as { n: number }).n).toBe(2);

      // 간격이 지나기 전 재실행은 침묵
      sweepDecisionAckAutoReminders();
      expect(notifications(b.id)).toHaveLength(1);
      expect(notifications(host.id)).toHaveLength(1);

      // 일 단위 표기 + 대상 5명 초과 로스터 + 1건짜리 문구
      const big = await createMeeting(app, host, 'rs6 큰그룹');
      const members = [] as { id: number }[];
      for (let i = 1; i <= 6; i++) {
        const u = await register(app, `rs6_m${i}`);
        await joinMeeting(app, u, big.code);
        members.push(u);
      }
      insertRecap(big.id, ['D-셋'], { createdAt: ago(50 * 60) });
      sweepDecisionAckAutoReminders();
      const dayText = "'D-셋' 결정이 2일째 확인 대기예요 — 확인 부탁해요 ('rs6 큰그룹')";
      expect(notifications(members[0].id).map((n) => n.text)).toEqual([dayText]);
      const hostTexts = notifications(host.id).map((n) => n.text);
      expect(hostTexts).not.toContain(dayText); // 발신자(호스트)는 조름 대상 아님
      expect(hostTexts).toContain(
        "미확인 결정 1건에 자동 리마인드를 보냈어요 ('rs6 큰그룹') — 대상: rs6_m1, rs6_m2, rs6_m3, rs6_m4, rs6_m5 외 1명",
      );
    } finally {
      delete process.env.ACK_AUTOREMIND_HOURS;
    }
  }, 30_000);
});
