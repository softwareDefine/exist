import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * RECAP_VERIFY=off — 근거 자기검증 게이트를 끄면 검증 호출이 사라지고 추출 결과가 그대로 원장에 들어간다.
 * (llm-recap.test.ts 는 on 경로. 게이트 조건 `!RECAP_VERIFY` 가 뮤테이션에서 살아남아 별도 파일로 고정)
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  process.env.OPENAI_MODEL_RECAP = 'gpt-4o';
  process.env.RECAP_VERIFY = 'off';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { runRecapForMeeting } from '../recap.js';
import { register, createMeeting, joinMeeting } from './helpers/fixtures.js';
import { queueJson, resetOpenAiMock, captured, systemPrompt } from './helpers/openaiMock.js';

const app = createApp();
beforeEach(() => resetOpenAiMock());

describe('RECAP_VERIFY=off', () => {
  it('검증 호출 없이 추출 결정 전부 저장 — 호출은 추출 1 + 관련성 1 뿐', async () => {
    const host = await register(app, 'vo_host');
    const member = await register(app, 'vo_member');
    const m = await createMeeting(app, host, 'vo 회의');
    await joinMeeting(app, member, m.code);
    db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(m.id, host.id, '검사 온도는 65도로 올리죠');
    db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(m.id, member.id, '네 그렇게 하죠');
    queueJson({ summary: '온도 상향', decisions: [{ text: '검사 온도 65도로 상향', why: '', alternatives: [] }, { text: '근거 없는 결정', why: '', alternatives: [] }], actions: [], next_meeting: null });
    queueJson({ critical_decisions: [], critical_users: [] });
    const id = await runRecapForMeeting(m.code, [host.id]);
    expect(id).not.toBeNull();
    expect(captured).toHaveLength(2);
    expect(captured.some((c) => systemPrompt(c).includes('회의 기록 검증기'))).toBe(false);
    expect(captured[1].model).toBe('gpt-4o-mini');
    const row = db.prepare('SELECT decisions, source FROM meeting_recaps WHERE id = ?').get(id) as { decisions: string; source: string };
    expect(JSON.parse(row.decisions)).toEqual(['검사 온도 65도로 상향', '근거 없는 결정']);
    expect(row.source).toBe('ai');
  }, 20_000);
});
