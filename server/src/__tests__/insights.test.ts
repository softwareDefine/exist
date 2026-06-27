import { describe, it, expect } from 'vitest';
import { esgFromCommutes, ruleBasedInsights, type OrgMetrics } from '../insights.js';

/** 건강한 기본 팀 지표 — 테스트마다 일부만 override */
function metrics(over: Partial<OrgMetrics> = {}): OrgMetrics {
  return {
    orgName: 'T',
    periodDays: 14,
    memberCount: 5,
    meetingCount: 3,
    todos: { total: 10, done: 7, overdue: 0, completionRate: 70 },
    calls: { count: 4, totalMinutes: 120 },
    activity: { calls: 4, messages: 100 },
    participation: [],
    quietMembers: [],
    esg: esgFromCommutes(20),
    trends: { activityTrend: 'flat', msgRecent: 50, msgPrev: 50, callRecent: 2, callPrev: 2 },
    signals: { soonDue: 0, nightRatio: 5, topShare: 30, callMinPerMember: 24 },
    ...over,
  };
}

describe('esgFromCommutes (INS-07)', () => {
  it('통근 대체 0이면 절감도 0', () => {
    expect(esgFromCommutes(0)).toEqual({
      replacedCommutes: 0,
      savedKm: 0,
      savedCo2Kg: 0,
      savedHours: 0,
    });
  });

  it('공신력 계수대로 환산한다 (10 person-day)', () => {
    const e = esgFromCommutes(10);
    expect(e.savedKm).toBe(173); // 10 × 17.3km
    expect(e.savedCo2Kg).toBe(21.7); // 173km × 125.2g/km ÷ 1000
    expect(e.savedHours).toBe(12.2); // 10 × 73min ÷ 60
  });

  it('절감량은 통근 대체 수에 비례(단조 증가)', () => {
    expect(esgFromCommutes(20).savedKm).toBeGreaterThan(esgFromCommutes(10).savedKm);
  });
});

describe('ruleBasedInsights — 예측/추세 (INS-04·05·06)', () => {
  it('건강한 팀은 번아웃·지연 모두 낮음', () => {
    const r = ruleBasedInsights(metrics());
    expect(r.burnoutRisk.level).toBe('낮음');
    expect(r.delayRisk.level).toBe('낮음');
  });

  it('마감 지난 할 일이 있으면 지연 위험 높음 + 리스크 표기', () => {
    const r = ruleBasedInsights(
      metrics({ todos: { total: 10, done: 3, overdue: 4, completionRate: 30 } }),
    );
    expect(r.delayRisk.level).toBe('높음');
    expect(r.risks.join(' ')).toContain('마감 지난');
  });

  it('야간 메시지 비율이 높으면 번아웃 위험 높음', () => {
    const r = ruleBasedInsights(
      metrics({ signals: { soonDue: 0, nightRatio: 35, topShare: 30, callMinPerMember: 24 } }),
    );
    expect(r.burnoutRisk.level).toBe('높음');
  });

  it('활동 추세 up이면 trend 문구가 증가를 나타낸다', () => {
    const r = ruleBasedInsights(
      metrics({
        trends: { activityTrend: 'up', msgRecent: 80, msgPrev: 20, callRecent: 3, callPrev: 1 },
      }),
    );
    expect(r.trend).toContain('늘었');
  });

  it('조용한 멤버가 있으면 리스크에 포함', () => {
    const r = ruleBasedInsights(metrics({ quietMembers: ['a', 'b'] }));
    expect(r.risks.join(' ')).toContain('활동 없는');
  });
});
