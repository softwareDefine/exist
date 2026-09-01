import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { esgFromCommutes, ruleBasedInsights, type OrgMetrics } from '../insights.js';
import { createApp } from '../app.js';
import db from '../db.js';

// 이 파일은 규칙 기반 경로만 검증 — 셸에 OPENAI_API_KEY가 있어도 AI 경로로 새지 않게
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = '';
});

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

const healthySignals = { soonDue: 0, nightRatio: 5, topShare: 30, callMinPerMember: 24 };

describe('esgFromCommutes (INS-07)', () => {
  it('통근 대체 0이면 절감도 0', () => {
    expect(esgFromCommutes(0)).toEqual({
      replacedCommutes: 0,
      savedKm: 0,
      savedCo2Kg: 0,
      savedHours: 0,
    });
    // 1 person-day = 왕복 17.3km · 2.2kg · 1.2시간
    expect(esgFromCommutes(1)).toEqual({
      replacedCommutes: 1,
      savedKm: 17.3,
      savedCo2Kg: 2.2,
      savedHours: 1.2,
    });
  });

  it('공신력 계수대로 환산한다 (10 person-day)', () => {
    expect(esgFromCommutes(10)).toEqual({
      replacedCommutes: 10,
      savedKm: 173, // 10 × 17.3km
      savedCo2Kg: 21.7, // 173km × 125.2g/km ÷ 1000
      savedHours: 12.2, // 10 × 73min ÷ 60
    });
    expect(esgFromCommutes(100)).toEqual({
      replacedCommutes: 100,
      savedKm: 1730,
      savedCo2Kg: 216.6,
      savedHours: 121.7,
    });
  });

  it('절감량은 통근 대체 수에 비례(단조 증가)', () => {
    const a = esgFromCommutes(10);
    const b = esgFromCommutes(20);
    expect(b.savedKm).toBeGreaterThan(a.savedKm);
    expect(b.savedCo2Kg).toBeGreaterThan(a.savedCo2Kg);
    expect(b.savedHours).toBeGreaterThan(a.savedHours);
    // 소수 첫째 자리 반올림 — 3 person-day: 51.9km / 6.49788→6.5kg / 3.65→3.7h
    expect(esgFromCommutes(3)).toEqual({
      replacedCommutes: 3,
      savedKm: 51.9,
      savedCo2Kg: 6.5,
      savedHours: 3.7,
    });
  });
});

describe('ruleBasedInsights — 예측/추세 (INS-04·05·06)', () => {
  it('건강한 팀은 번아웃·지연 모두 낮음', () => {
    const r = ruleBasedInsights(metrics());
    expect(r.burnoutRisk.level).toBe('낮음');
    expect(r.delayRisk.level).toBe('낮음');
    expect(r).toEqual({
      summary: '최근 14일 동안 회의 3개, 할 일 완료율 70%(7/10), 통화 4회 진행됐습니다.',
      trend: '최근 활동이 이전과 비슷하게 유지되고 있습니다',
      burnoutRisk: { level: '낮음', reason: '과부하 신호 낮음' },
      delayRisk: { level: '낮음', reason: '지연 신호 낮음' },
      risks: [],
      recommendations: [],
    });
  });

  it('마감 지난 할 일이 있으면 지연 위험 높음 + 리스크 표기', () => {
    const r = ruleBasedInsights(
      metrics({ todos: { total: 10, done: 3, overdue: 4, completionRate: 30 } }),
    );
    expect(r.delayRisk.level).toBe('높음');
    expect(r.risks.join(' ')).toContain('마감 지난');
    expect(r.delayRisk).toEqual({ level: '높음', reason: '마감 지난 할 일 4건' });
    expect(r.risks).toEqual(['할 일 완료율 30%로 낮음', '마감 지난 미완료 할 일 4건']);
    expect(r.recommendations).toEqual(['마감 지난 할 일부터 점검하세요']);
    expect(r.summary).toContain('완료율 30%(3/10)');
  });

  it('완료율 40% 미만이면 overdue 없어도 지연 높음 — 할 일이 0건이면 리스크 없음', () => {
    const low = ruleBasedInsights(
      metrics({ todos: { total: 10, done: 3, overdue: 0, completionRate: 30 } }),
    );
    expect(low.delayRisk).toEqual({ level: '높음', reason: '완료율 30%' });
    expect(low.risks).toEqual(['할 일 완료율 30%로 낮음']);
    expect(low.recommendations).toEqual([]);
    const none = ruleBasedInsights(
      metrics({ todos: { total: 0, done: 0, overdue: 0, completionRate: 0 } }),
    );
    expect(none.delayRisk).toEqual({ level: '낮음', reason: '지연 신호 낮음' });
    expect(none.risks).toEqual([]);
  });

  it('야간 메시지 비율이 높으면 번아웃 위험 높음', () => {
    const r = ruleBasedInsights(
      metrics({ signals: { ...healthySignals, nightRatio: 35 } }),
    );
    expect(r.burnoutRisk.level).toBe('높음');
    expect(r.burnoutRisk).toEqual({ level: '높음', reason: '야간 활동 35%' });
    expect(r.delayRisk.level).toBe('낮음'); // 번아웃 신호는 지연 판정에 섞이지 않는다
    // 경계값 — 15% 이상은 보통, 15% 미만은 낮음
    expect(ruleBasedInsights(metrics({ signals: { ...healthySignals, nightRatio: 15 } })).burnoutRisk).toEqual({
      level: '보통',
      reason: '야간 활동 15%',
    });
    expect(ruleBasedInsights(metrics({ signals: { ...healthySignals, nightRatio: 14 } })).burnoutRisk.level).toBe('낮음');
  });

  it('참여 편중·인당 통화시간도 번아웃 신호 — 사유는 야간 > 편중 > 통화 순', () => {
    expect(ruleBasedInsights(metrics({ signals: { ...healthySignals, topShare: 75 } })).burnoutRisk).toEqual({
      level: '높음',
      reason: '특정 멤버 편중 75%',
    });
    expect(ruleBasedInsights(metrics({ signals: { ...healthySignals, topShare: 60 } })).burnoutRisk).toEqual({
      level: '보통',
      reason: '특정 멤버 편중 60%',
    });
    expect(ruleBasedInsights(metrics({ signals: { ...healthySignals, callMinPerMember: 150 } })).burnoutRisk).toEqual({
      level: '높음',
      reason: '인당 통화 150분',
    });
    expect(ruleBasedInsights(metrics({ signals: { ...healthySignals, callMinPerMember: 100 } })).burnoutRisk).toEqual({
      level: '보통',
      reason: '인당 통화 100분',
    });
    // 여러 신호가 겹치면 야간 사유가 우선
    expect(
      ruleBasedInsights(metrics({ signals: { ...healthySignals, nightRatio: 20, topShare: 80 } })).burnoutRisk,
    ).toEqual({ level: '높음', reason: '야간 활동 20%' });
  });

  it('활동 추세 up이면 trend 문구가 증가를 나타낸다', () => {
    const r = ruleBasedInsights(
      metrics({
        trends: { activityTrend: 'up', msgRecent: 80, msgPrev: 20, callRecent: 3, callPrev: 1 },
      }),
    );
    expect(r.trend).toContain('늘었');
    expect(r.trend).toBe('최근 7일 활동이 이전보다 늘었습니다');
    expect(r.delayRisk.level).toBe('낮음');
    // down 이면 감소 문구 + 지연 위험이 보통으로 올라간다
    const down = ruleBasedInsights(
      metrics({
        trends: { activityTrend: 'down', msgRecent: 10, msgPrev: 60, callRecent: 0, callPrev: 3 },
      }),
    );
    expect(down.trend).toBe('최근 7일 활동이 이전보다 줄었습니다');
    expect(down.delayRisk.level).toBe('보통');
    // 임박 마감이 있으면 지연 보통 + 사유에 건수
    expect(ruleBasedInsights(metrics({ signals: { ...healthySignals, soonDue: 2 } })).delayRisk).toEqual({
      level: '보통',
      reason: '임박 마감 2건',
    });
  });

  it('조용한 멤버가 있으면 리스크에 포함', () => {
    const r = ruleBasedInsights(metrics({ quietMembers: ['a', 'b'] }));
    expect(r.risks.join(' ')).toContain('활동 없는');
    expect(r.risks).toEqual(['최근 14일 활동 없는 멤버 2명']);
    expect(r.recommendations).toEqual(['참여 저조 멤버와 진행상황 동기화 필요']);
    // 회의는 있는데 메시지가 0이면 비동기 소통 권고가 추가된다
    const silent = ruleBasedInsights(
      metrics({ quietMembers: ['a'], activity: { calls: 4, messages: 0 } }),
    );
    expect(silent.recommendations).toEqual([
      '참여 저조 멤버와 진행상황 동기화 필요',
      '비동기 소통(채팅/문서) 활용을 늘려보세요',
    ]);
    expect(ruleBasedInsights(metrics({ meetingCount: 0, activity: { calls: 0, messages: 0 } })).recommendations).toEqual([]);
  });
});

/*
 * GET /api/insights/:orgId — 집계(collectOrgMetrics)를 시드 데이터로 검증.
 * 메시지·할 일·통화·참가 기록을 심어 두고 응답의 숫자가 정확히 맞는지 본다 (규칙 기반, API 키 없음).
 */
describe('GET /api/insights/:orgId — 시드 데이터 집계 (INS-01·02·03)', () => {
  const app = createApp();
  let owner = '';
  let ownerId = 0;
  let m1Id = 0;
  let orgId = 0;
  let meetingCode = '';

  async function register(username: string) {
    const r = await request(app).post('/api/auth/register').send({ username, password: 'password123' });
    return { token: r.body.token as string, id: r.body.user.id as number };
  }
  const auth = (t: string) => `Bearer ${t}`;
  /** 오늘 기준 n일 뒤 YYYY-MM-DD (로컬) */
  function day(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  beforeAll(async () => {
    const o = await register('ins_owner');
    const m1 = await register('ins_m1');
    const m2 = await register('ins_m2'); // 활동 없는 멤버
    owner = o.token;
    ownerId = o.id;
    m1Id = m1.id;
    const org = await request(app).post('/api/orgs').set('Authorization', auth(owner)).send({ name: '인사이트 조직' });
    orgId = org.body.id;
    for (const u of [m1, m2]) {
      await request(app).post('/api/orgs/join').set('Authorization', auth(u.token)).send({ joinCode: org.body.joinCode });
      await request(app).post(`/api/orgs/${orgId}/members/${u.id}/approve`).set('Authorization', auth(owner)).send({});
    }
    const meeting = await request(app)
      .post('/api/meetings')
      .set('Authorization', auth(owner))
      .send({ title: '인사이트 회의', org_id: orgId });
    meetingCode = meeting.body.code;
    const meetingId = meeting.body.id as number;
    await request(app).post('/api/meetings/join').set('Authorization', auth(m1.token)).send({ code: meetingCode });

    // 메시지 — 최근 7일: owner 3(그중 1건 KST 야간 = UTC 15시) + m1 1, 이전 7일: owner 1
    const msg = db.prepare(
      `INSERT INTO messages (meeting_id, user_id, text, created_at) VALUES (?, ?, ?, date('now', ?) || ?)`,
    );
    msg.run(meetingId, ownerId, '낮1', '-2 days', ' 03:00:00'); // KST 12시
    msg.run(meetingId, ownerId, '낮2', '-2 days', ' 04:00:00');
    msg.run(meetingId, ownerId, '밤', '-2 days', ' 15:00:00'); // KST 00시 → 야간
    msg.run(meetingId, m1Id, '낮3', '-2 days', ' 05:00:00');
    msg.run(meetingId, ownerId, '옛날', '-10 days', ' 03:00:00'); // 이전 7일 구간

    // 할 일 — 완료 1 / 마감 지남 1 / 3일 내 임박 1 / 마감 없음 1
    const todo = db.prepare('INSERT INTO todos (user_id, title, done, due_at, meeting_id) VALUES (?, ?, ?, ?, ?)');
    todo.run(ownerId, '끝난 일', 1, null, meetingId);
    todo.run(ownerId, '지난 일', 0, new Date(Date.now() - 86_400_000).toISOString(), meetingId);
    todo.run(m1Id, '임박한 일', 0, new Date(Date.now() + 2 * 86_400_000).toISOString(), meetingId);
    todo.run(m1Id, '기한 없음', 0, null, meetingId);

    // 통화 일정 — 90분짜리 1건
    const ev = await request(app)
      .post(`/api/meetings/${meetingCode}/events`)
      .set('Authorization', auth(owner))
      .send({ title: '주간 통화', date: day(1), time: '10:00', end_time: '11:30', is_call: true });
    expect(ev.status).toBe(200);
  });

  it('metrics가 시드 데이터와 정확히 일치하고 insights는 규칙 기반', async () => {
    const r = await request(app).get(`/api/insights/${orgId}?fresh=1`).set('Authorization', auth(owner));
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('rule');
    expect(r.body.metrics).toEqual({
      orgName: '인사이트 조직',
      periodDays: 14,
      memberCount: 3,
      meetingCount: 1,
      todos: { total: 4, done: 1, overdue: 1, completionRate: 25 },
      calls: { count: 1, totalMinutes: 90 },
      activity: { calls: 1, messages: 5 },
      participation: [
        { username: 'ins_owner', messages: 4 },
        { username: 'ins_m1', messages: 1 },
      ],
      quietMembers: ['ins_m2'],
      // 회의 참가 (멤버, 날짜) 고유 수 = owner·m1 오늘 → 2 person-day
      esg: { replacedCommutes: 2, savedKm: 34.6, savedCo2Kg: 4.3, savedHours: 2.4 },
      trends: { activityTrend: 'up', msgRecent: 4, msgPrev: 1, callRecent: 1, callPrev: 0 },
      // 야간 1/5=20%, 상위 1인 4/5=80%, 통화 90분/3명=30분, 임박(3일 내 미완료) = 지난 일 + 임박한 일
      signals: { soonDue: 2, nightRatio: 20, topShare: 80, callMinPerMember: 30 },
    });
    expect(r.body.insights).toEqual({
      summary: '최근 14일 동안 회의 1개, 할 일 완료율 25%(1/4), 통화 1회 진행됐습니다.',
      trend: '최근 7일 활동이 이전보다 늘었습니다',
      burnoutRisk: { level: '높음', reason: '야간 활동 20%' },
      delayRisk: { level: '높음', reason: '마감 지난 할 일 1건' },
      risks: ['할 일 완료율 25%로 낮음', '마감 지난 미완료 할 일 1건', '최근 14일 활동 없는 멤버 1명'],
      recommendations: ['마감 지난 할 일부터 점검하세요', '참여 저조 멤버와 진행상황 동기화 필요'],
    });
  });

  it('5분 캐시 — fresh 없이는 새 활동이 반영되지 않고, fresh=1이면 즉시 재계산', async () => {
    const before = await request(app).get(`/api/insights/${orgId}?fresh=1`).set('Authorization', auth(owner));
    expect(before.body.metrics.activity.messages).toBe(5);
    db.prepare(`INSERT INTO messages (meeting_id, user_id, text, created_at) VALUES (?, ?, ?, date('now', '-1 days') || ' 03:00:00')`).run(
      (db.prepare('SELECT id FROM meetings WHERE code = ?').get(meetingCode) as { id: number }).id,
      m1Id,
      '추가',
    );
    const cached = await request(app).get(`/api/insights/${orgId}`).set('Authorization', auth(owner));
    expect(cached.status).toBe(200);
    expect(cached.body.metrics.activity.messages).toBe(5); // 캐시 그대로
    const fresh = await request(app).get(`/api/insights/${orgId}?fresh=1`).set('Authorization', auth(owner));
    expect(fresh.body.metrics.activity.messages).toBe(6);
    expect(fresh.body.metrics.participation).toEqual([
      { username: 'ins_owner', messages: 4 },
      { username: 'ins_m1', messages: 2 },
    ]);
    expect(fresh.body.metrics.signals.topShare).toBe(67); // 4/6
    expect(fresh.body.metrics.signals.nightRatio).toBe(17); // 1/6
  });

  it('멤버 검사 — 일반 멤버도 조회 가능, 비멤버 403, 잘못된 id 400', async () => {
    const m1 = await request(app).post('/api/auth/login').send({ username: 'ins_m1', password: 'password123' });
    const ok = await request(app).get(`/api/insights/${orgId}`).set('Authorization', auth(m1.body.token));
    expect(ok.status).toBe(200);
    expect(ok.body.metrics.orgName).toBe('인사이트 조직');
    const stranger = await register('ins_stranger');
    const deny = await request(app).get(`/api/insights/${orgId}`).set('Authorization', auth(stranger.token));
    expect(deny.status).toBe(403);
    expect(deny.body).toEqual({ error: '조직 멤버가 아닙니다' });
    const bad = await request(app).get('/api/insights/abc').set('Authorization', auth(owner));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: '잘못된 조직' });
  });
});
