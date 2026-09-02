import { describe, it, expect, vi } from 'vitest';

/*
 * recap.ts 생존 변이 사냥 2 (9/2 뮤테이션 최종 라운드) — AI 없이 도는 경로:
 * sameDecision 수치 정규식 경계, runDecisionReminders 발송 로그,
 * sweepDecisionAckAutoReminders 간격 미도달·전원 확인 침묵·간격 후 재발송.
 */
import { createApp } from '../app.js';
import db from '../db.js';
import {
  sameDecision,
  runDecisionReminders,
  sweepDecisionAckAutoReminders,
  ackDecision,
} from '../recap.js';
import { register, createMeeting, joinMeeting, insertRecap, notifications } from './helpers/fixtures.js';

const app = createApp();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace('T', ' ').slice(0, 19);
/** 리마인드 계열 알림만 추출 — 다른 종류(참여 알림 등)와 분리해 단언 */
const remindTexts = (uid: number) =>
  notifications(uid).map((n) => n.text).filter((t) => /확인 대기|자동 리마인드/.test(t));

describe('sameDecision — 수치 토큰화 경계', () => {
  it('여러 자리 정수·소수점 둘째 자리까지 하나의 수치 토큰이다', () => {
    // 포함 관계 아님 + 수치 동일 → 바이그램으로 같은 결정.
    // \d+ 가 \d 로 변이되면 "325"가 "3,2,5"로 갈라져 수치 게이트가 다른 결정으로 오판한다
    expect(sameDecision('방열판 325mm로 교체 진행 확정', '방열판 325mm 교체로 진행 확정')).toBe(true);
    // \.\d+ 가 \.\d 나 \.\D+ 로 변이되면 "3.25"가 "3.2,5"/"3,25"로 갈라진다
    expect(sameDecision('기준 온도 3.25도로 상향 진행 확정', '기준 온도 3.25도 상향으로 진행 확정')).toBe(true);
    // 실제로 다른 수치는 다른 결정 (게이트 자체는 살아 있다)
    expect(sameDecision('방열판 325mm로 교체 진행 확정', '방열판 320mm 교체로 진행 확정')).toBe(false);
  });

  it('한쪽에만 수치가 있으면 수치 게이트를 건너뛴다 (?? [] 폴백)', () => {
    // 수치 없는 쪽의 match 가 null → 빈 배열이어야 게이트가 스킵된다
    // ("Stryker was here" 폴백이면 조인이 달라져 무조건 다른 결정이 된다)
    expect(sameDecision('방열판 교체 진행 건 확정', '방열판 교체 진행 5건 확정')).toBe(true);
  });

  it('포함 관계는 바이그램 비율이 낮아도 같은 결정', () => {
    expect(sameDecision('방열판 교체 후 전 라인 공지 및 보고서 작성 진행', '방열판 교체')).toBe(true);
  });
});

describe('runDecisionReminders — 발송 로그', () => {
  it('발송 건수를 정확한 문구로 남기고, 0건이면 침묵', async () => {
    const log = vi.spyOn(console, 'log');
    try {
      const host = await register(app, 'rv1_host');
      const a = await register(app, 'rv1_a');
      const m = await createMeeting(app, host, 'rv1 그룹');
      await joinMeeting(app, a, m.code);
      insertRecap(m.id, ['확인할 결정'], { createdAt: ago(25 * 60) });

      expect(runDecisionReminders()).toBe(1); // a 만 — 발신자(호스트)는 리마인드 대상 아님 (9/3 결함 #10b)
      const calls = log.mock.calls.filter((c) => String(c[0]).includes('미확인 리마인드'));
      expect(calls).toEqual([['[recap] 미확인 리마인드 1건 발송']]);

      log.mockClear();
      expect(runDecisionReminders()).toBe(0); // 1회만 — 재실행은 로그도 없다
      expect(log.mock.calls.filter((c) => String(c[0]).includes('미확인 리마인드'))).toEqual([]);
    } finally {
      log.mockRestore();
    }
  }, 20_000);
});

describe('sweepDecisionAckAutoReminders — 간격·집계 경계', () => {
  it('간격 미도달 recap 은 건드리지 않는다 (알림·발송 기록 모두 없음)', async () => {
    process.env.ACK_AUTOREMIND_HOURS = '1';
    try {
      const host = await register(app, 'rv2_host');
      const a = await register(app, 'rv2_a');
      const m = await createMeeting(app, host, 'rv2 그룹');
      await joinMeeting(app, a, m.code);
      insertRecap(m.id, ['갓 만든 결정']); // 지금 생성 — 1시간 간격 미도달

      sweepDecisionAckAutoReminders();
      expect(remindTexts(a.id)).toEqual([]);
      expect(remindTexts(host.id)).toEqual([]);
      expect(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM decision_ack_autoremind ar
               JOIN meeting_recaps r ON r.id = ar.recap_id WHERE r.meeting_id = ?`,
            )
            .get(m.id) as { n: number }
        ).n,
      ).toBe(0);
    } finally {
      delete process.env.ACK_AUTOREMIND_HOURS;
    }
  }, 20_000);

  it('전원 확인한 그룹은 호스트 현황 보고도 나가지 않는다', async () => {
    process.env.ACK_AUTOREMIND_HOURS = '1';
    try {
      const host = await register(app, 'rv3_host');
      const a = await register(app, 'rv3_a');
      const m = await createMeeting(app, host, 'rv3 그룹');
      await joinMeeting(app, a, m.code);
      const recapId = insertRecap(m.id, ['다 확인한 결정'], { createdAt: ago(90) });
      ackDecision(recapId, 0, host.id);
      ackDecision(recapId, 0, a.id);

      sweepDecisionAckAutoReminders();
      expect(remindTexts(host.id)).toEqual([]); // "미확인 결정 0건" 보고가 나가면 변이
      expect(remindTexts(a.id)).toEqual([]);
    } finally {
      delete process.env.ACK_AUTOREMIND_HOURS;
    }
  }, 20_000);

  it('마지막 자동 발송에서 간격이 다시 지나면 재발송한다', async () => {
    process.env.ACK_AUTOREMIND_HOURS = '1';
    try {
      const host = await register(app, 'rv4_host');
      const a = await register(app, 'rv4_a');
      const m = await createMeeting(app, host, 'rv4 그룹');
      await joinMeeting(app, a, m.code);
      const recapId = insertRecap(m.id, ['재촉 결정'], { createdAt: ago(90) });

      sweepDecisionAckAutoReminders();
      const text = "'재촉 결정' 결정이 1시간째 확인 대기예요 — 확인 부탁해요 ('rv4 그룹')";
      expect(remindTexts(a.id).filter((t) => t === text)).toEqual([text]);

      // 간격(1시간)이 지난 것으로 발송 기록을 되돌리면 → 다시 보챈다
      db.prepare("UPDATE decision_ack_autoremind SET sent_at = datetime('now', '-2 hours') WHERE recap_id = ?").run(recapId);
      sweepDecisionAckAutoReminders();
      expect(remindTexts(a.id).filter((t) => t === text)).toEqual([text, text]);
    } finally {
      delete process.env.ACK_AUTOREMIND_HOURS;
    }
  }, 20_000);
});
