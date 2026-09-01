import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * insights.ts의 AI 경로 — GET /api/insights/:orgId. 집계치는 서버가 만들고 AI는 진단 JSON만.
 * 응답 뒤 잡설(추론 모델 찌꺼기)이 붙어도 파싱되고, 배열은 3개 캡, 실패는 규칙 폴백.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import { captured, setNextResponses, resetOpenAiMock, userPayload } from './helpers/openaiMock.js';

const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string; user: { id: number } };
}

beforeEach(() => resetOpenAiMock());

describe('GET /api/insights/:orgId — AI 진단', () => {
  it('집계치를 통째로 넘기고, 잡설 붙은 JSON도 파싱, risks는 3개 캡, 빈 필드는 규칙값으로 보강', async () => {
    const u = await registerUser('li1_owner');
    const org = await request(app).post('/api/orgs').set('Authorization', `Bearer ${u.token}`).send({ name: '런타임' });
    expect(org.status).toBe(200);
    setNextResponses(
      JSON.stringify({
        summary: '아직 기록이 쌓이는 중이에요.',
        trend: '',
        burnoutRisk: { level: '낮음', reason: '야간 메시지 없음' },
        delayRisk: null,
        risks: ['r1', 'r2', 'r3', 'r4'],
        recommendations: ['첫 회의를 잡아보세요'],
      }) + '\n(설명) 위 JSON이 최종 답입니다. {끝}',
    );
    const r = await request(app).get(`/api/insights/${org.body.id}`).set('Authorization', `Bearer ${u.token}`);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('ai');
    expect(r.body.insights.summary).toBe('아직 기록이 쌓이는 중이에요.');
    expect(r.body.insights.trend).toBeTruthy(); // 빈 trend → 규칙 문장
    expect(r.body.insights.burnoutRisk).toEqual({ level: '낮음', reason: '야간 메시지 없음' });
    expect(r.body.insights.delayRisk.level).toBeTruthy(); // null → 규칙값
    expect(r.body.insights.risks).toEqual(['r1', 'r2', 'r3']);
    expect(r.body.metrics.orgName).toBe('런타임');

    expect(captured[0].temperature).toBe(0.3);
    expect(captured[0].max_tokens).toBe(700);
    expect(captured[0].response_format).toEqual({ type: 'json_object' });
    const p = userPayload<{ orgName: string; memberCount: number; signals: unknown; trends: unknown }>(captured[0]);
    expect(p.orgName).toBe('런타임');
    expect(p.memberCount).toBe(1);
    expect(p.signals).toBeDefined();
    expect(p.trends).toBeDefined();

    // 5분 캐시 — 같은 요청은 AI를 다시 부르지 않는다; fresh=1이면 재계산 (실패 → 규칙 폴백)
    await request(app).get(`/api/insights/${org.body.id}`).set('Authorization', `Bearer ${u.token}`);
    expect(captured).toHaveLength(1);
    setNextResponses(new Error('quota'));
    const r2 = await request(app).get(`/api/insights/${org.body.id}?fresh=1`).set('Authorization', `Bearer ${u.token}`);
    expect(r2.body.source).toBe('rule');
    expect(r2.body.insights.burnoutRisk.level).toBe('낮음');
  });
});
