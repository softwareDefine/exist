import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * agent.ts의 AI 경로 — nowbar 브리핑(사실 문장 선택 + 카드 보정), 놓친 것 헤드라인, 오늘 브리핑.
 * 원칙: 서버가 만든 "사실 문장"만 넘기고, 모델이 규칙을 어기면(진행 중 회의 없는데 카드 2) 서버가 보정한다.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { generateBrief, getCatchup, getDailyBrief, invalidateBrief } from '../agent.js';
import { captured, queueJson, setNextResponses, resetOpenAiMock, userPayload, systemPrompt } from './helpers/openaiMock.js';

const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string; user: { id: number } };
}
function userId(username: string): number {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
}
async function setupUser(prefix: string) {
  const host = await registerUser(`${prefix}_host`);
  const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${host.token}`).send({ title: `${prefix} 그룹` });
  const code = m.body.code as string;
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
  const uid = userId(`${prefix}_host`);
  return { host, code, meetingId, uid };
}

beforeEach(() => resetOpenAiMock());

describe('generateBrief — nowbar 한 줄 + 카드', () => {
  it('사실 문장만 넘기고, 진행 중 회의가 없는데 카드 2를 고르면 규칙 카드로 보정 (2분 캐시)', async () => {
    const s = await setupUser('la1');
    db.prepare('INSERT INTO todos (user_id, title) VALUES (?, ?)').run(s.uid, '데모 영상 콘티');
    queueJson({ brief: '미완료 할 일 1개부터 정리해요', card: 2, reason: '진행 중' });
    const r = await generateBrief(s.uid);
    expect(r).toEqual({ text: '미완료 할 일 1개부터 정리해요', source: 'ai', card: 1, reason: '진행 중' });
    const req = captured[0];
    expect(req.temperature).toBe(0.3);
    expect(req.max_tokens).toBe(300);
    expect(userPayload<{ facts: string[] }>(req).facts).toEqual(['예정된 회의가 없다', '미완료 할 일이 1개 있다']);
    expect(systemPrompt(req)).toContain('"진행 중" 사실이 없으면 절대 2를 고르지 않는다');
    expect(await generateBrief(s.uid)).toEqual(r); // 캐시
    expect(captured).toHaveLength(1);
  });

  it('카드 값이 이상하면 0, brief가 비면 규칙 폴백, 빈 응답도 폴백', async () => {
    const s = await setupUser('la2');
    queueJson({ brief: '오늘은 정리된 하루예요', card: 9 });
    const r = await generateBrief(s.uid);
    expect(r).toMatchObject({ source: 'ai', card: 0, reason: '다가오는 일정을 보여드려요' }); // reason 비면 규칙 이유
    invalidateBrief(s.uid);
    queueJson({ brief: '', card: 1, reason: 'x' });
    expect(await generateBrief(s.uid)).toEqual({ text: '오늘 할 일과 회의가 모두 정리됐어요', source: 'rule', card: 0, reason: '다가오는 일정을 보여드려요' });
    invalidateBrief(s.uid);
    setNextResponses('');
    expect((await generateBrief(s.uid)).source).toBe('rule');
  });
});

describe('getCatchup — 놓친 것 헤드라인', () => {
  it('항목은 서버가 계산하고 AI는 헤드라인 한 줄만; 실패하면 규칙 헤드라인', async () => {
    const s = await setupUser('la3');
    db.prepare(`INSERT INTO meeting_recaps (meeting_id, summary, decisions, actions, attendees, source) VALUES (?, '오송 라인 점검 확정', '["점검 확정"]', '[]', '["someone_else"]', 'ai')`).run(s.meetingId);
    queueJson({ headline: '놓친 통화 정리부터 확인해요' });
    const c = await getCatchup(s.uid);
    expect(c.source).toBe('ai');
    expect(c.headline).toBe('놓친 통화 정리부터 확인해요');
    expect(c.items[0]).toMatchObject({ type: 'recap', text: '놓친 통화 정리 — 오송 라인 점검 확정 (결정 1건)' });
    expect(userPayload<string[]>(captured[0])).toEqual(['놓친 통화 정리 — 오송 라인 점검 확정 (결정 1건)']);
    expect(captured[0].max_tokens).toBe(120);

    setNextResponses('헤드라인을 만들 수 없어요');
    const c2 = await getCatchup(s.uid);
    expect(c2.source).toBe('rule');
    expect(c2.headline).toBe('자리 비운 사이 놓친 통화 1건 있어요');

    queueJson({ headline: '' });
    expect((await getCatchup(s.uid)).source).toBe('rule');
  });

  it('놓친 게 없으면 AI를 부르지 않는다', async () => {
    const s = await setupUser('la4');
    const c = await getCatchup(s.uid);
    expect(c.items).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });
});

describe('getDailyBrief — 오늘 브리핑 문단', () => {
  it('사실 문장을 다듬은 text를 쓰고 5분 캐시, 빈 text·실패는 규칙 문단', async () => {
    const s = await setupUser('la5');
    db.prepare("INSERT INTO todos (user_id, title, due_at) VALUES (?, ?, datetime('now', '+2 hours'))").run(s.uid, '기획심사 서류');
    queueJson({ text: '오늘 예정된 일정은 없어요. 마감이 가장 가까운 "기획심사 서류"부터 처리해요.' });
    const d = await getDailyBrief(s.uid);
    expect(d).toEqual({ text: '오늘 예정된 일정은 없어요. 마감이 가장 가까운 "기획심사 서류"부터 처리해요.', source: 'ai' });
    const facts = userPayload<{ facts: string[] }>(captured[0]).facts;
    expect(facts).toEqual(['오늘 예정된 일정은 없다', '할 일 중 마감이 가장 가까운 것은 "기획심사 서류"이다']);
    expect(await getDailyBrief(s.uid)).toEqual(d);
    expect(captured).toHaveLength(1);

    invalidateBrief(s.uid);
    queueJson({ text: '   ' });
    const d2 = await getDailyBrief(s.uid);
    expect(d2.source).toBe('rule');
    expect(d2.text).toContain('기획심사 서류');
    invalidateBrief(s.uid);
    setNextResponses(new Error('502'));
    expect((await getDailyBrief(s.uid)).source).toBe('rule');
  });
});
