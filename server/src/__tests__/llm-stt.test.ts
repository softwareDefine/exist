import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

/*
 * stt.ts — 자막 즉석 교정(correctCaption)·프롬프트 에코/상투구 필터·통화 후 일괄 전사·라이브 청크 전사.
 * OpenAI 전용 구성(WHISPER_URL 없음). 로컬 whisper 우선/폴백 경로는 llm-stt-local.test.ts.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  delete process.env.WHISPER_URL;
  delete process.env.STT_PREFER;
  delete process.env.OPENAI_STT_MODEL;
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { correctCaption, isPromptEcho, JUNK, biasPrompt, transcribeMeetingAudio, toDbTime } from '../stt.js';
import {
  captured,
  setNextResponses,
  setNextTranscriptions,
  transcribeCalls,
  resetOpenAiMock,
  systemPrompt,
  waitFor,
} from './helpers/openaiMock.js';

const app = createApp();
const STT_DIR = path.join(process.env.DATA_DIR!, 'stt-chunks');

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string; user: { id: number } };
}
async function setupMeeting(prefix: string, title = `${prefix} 회의`) {
  const host = await registerUser(`${prefix}_host`);
  const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${host.token}`).send({ title });
  const code = m.body.code as string;
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
  const hostId = (db.prepare('SELECT id FROM users WHERE username = ?').get(`${prefix}_host`) as { id: number }).id;
  return { host, code, meetingId, hostId, title };
}
function writeChunk(meetingId: number, userId: number, ts: number, ext = 'webm') {
  const dir = path.join(STT_DIR, String(meetingId));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${userId}-${ts}.${ext}`);
  fs.writeFileSync(file, Buffer.alloc(1500, 1));
  return file;
}
function transcripts(meetingId: number) {
  return db
    .prepare('SELECT text, source, created_at, user_id FROM call_transcripts WHERE meeting_id = ? ORDER BY id')
    .all(meetingId) as { text: string; source: string; created_at: string; user_id: number }[];
}

beforeEach(() => resetOpenAiMock());

describe('correctCaption — 자막 한 줄 교정', () => {
  it('6자 미만은 호출 없이 null, 교정본은 용어집(기본+그룹+회의명) 프롬프트로 8초 타임아웃 호출', async () => {
    const s = await setupMeeting('st1', '완제라인 주간 회의');
    db.prepare('INSERT INTO meeting_glossary (meeting_id, term, added_by) VALUES (?, ?, ?)').run(s.meetingId, '완제라인B', s.hostId);
    expect(await correctCaption('네네', s.title, s.meetingId)).toBeNull();
    expect(captured).toHaveLength(0);

    setNextResponses('방열판 검사 온도 65도로 올립니다');
    const fixed = await correctCaption('방열판 검사 온도 육십오도로 올립니다', s.title, s.meetingId);
    expect(fixed).toBe('방열판 검사 온도 65도로 올립니다');
    const req = captured[0];
    expect(req.model).toBe('gpt-4o-mini');
    expect(req.temperature).toBe(0);
    expect(req.max_tokens).toBe(300);
    expect(req.response_format).toBeUndefined(); // 자막 한 줄 — JSON 모드 아님
    expect(req.options).toEqual({ timeout: 8000 });
    const sys = systemPrompt(req);
    expect(sys).toContain('자주 나오는 용어: 완제라인B, 방열판'); // 그룹 용어집이 기본 용어집보다 앞
    expect(sys).toContain('GMP');
    expect(sys).toContain('완제라인 주간 회의');
    expect(req.messages.find((m) => m.role === 'user')!.content).toBe('방열판 검사 온도 육십오도로 올립니다');
  });

  it('원문과 같으면 null, 길이가 0.5~2배를 벗어나면(창작) null, API 실패도 null', async () => {
    const text = '오늘 야간조 인수인계는 여덟 시에 합니다';
    setNextResponses(text);
    expect(await correctCaption(text)).toBeNull();
    setNextResponses('여덟 시');
    expect(await correctCaption(text)).toBeNull();
    setNextResponses(text + ' 그리고 추가로 설명하자면 인수인계 노트는 4섹션으로 작성하고 서명까지 받아야 합니다');
    expect(await correctCaption(text)).toBeNull();
    setNextResponses(new Error('timeout'));
    expect(await correctCaption(text)).toBeNull();
    setNextResponses('오늘 야간조 인수인계는 8시에 합니다');
    expect(await correctCaption(text)).toBe('오늘 야간조 인수인계는 8시에 합니다');
  });
});

describe('무음 청크 방어 — JUNK · isPromptEcho', () => {
  it('유튜브 상투구·추임새만 있는 출력은 JUNK', () => {
    expect(JUNK.test('시청해 주셔서 감사합니다')).toBe(true);
    expect(JUNK.test('구독과 좋아요 부탁드립니다')).toBe(true);
    expect(JUNK.test('음...')).toBe(true);
    expect(JUNK.test('음, 그건 내일 확인할게요')).toBe(false);
  });
  it('프롬프트 에코 — "회의 용어:" 시작, 한글 없는 짧은 출력, 어절 절반 이상이 용어집', () => {
    const prompt = '회의 용어: 방열판, 완제라인, 인수인계, GMP';
    expect(isPromptEcho('회의 용어: 방열판, 완제라인', prompt)).toBe(true);
    expect(isPromptEcho('signal you', prompt)).toBe(true);
    expect(isPromptEcho('방열판 완제라인 검사', prompt)).toBe(true); // 2/3 ≥ 0.5
    expect(isPromptEcho('방열판 온도를 65도로 올리기로 했습니다', prompt)).toBe(false); // 1/5
    expect(isPromptEcho('방열판 온도', prompt)).toBe(false); // 어절 3개 미만은 비율 판정 안 함
  });
  it('biasPrompt — 그룹 용어집 + 기본 용어집을 "회의 용어:" 접두로', async () => {
    const s = await setupMeeting('st2');
    db.prepare('INSERT INTO meeting_glossary (meeting_id, term, added_by) VALUES (?, ?, ?)').run(s.meetingId, '오송라인', s.hostId);
    const p = biasPrompt(s.meetingId);
    expect(p.startsWith('회의 용어: 오송라인, 방열판')).toBe(true);
    expect(p).toContain('SOP');
  });
});

describe('transcribeMeetingAudio — 통화 후 일괄 전사 (OpenAI)', () => {
  it('청크를 시작 시각순으로 전사, 상투구·프롬프트 에코는 버리고, 파일은 정리한다', async () => {
    const s = await setupMeeting('st3');
    db.prepare('INSERT INTO meeting_glossary (meeting_id, term, added_by) VALUES (?, ?, ?)').run(s.meetingId, '오송라인', s.hostId);
    // 일부러 역순으로 써서 정렬 확인
    writeChunk(s.meetingId, s.hostId, 1_700_000_060_000);
    writeChunk(s.meetingId, s.hostId, 1_700_000_000_000);
    writeChunk(s.meetingId, s.hostId, 1_700_000_030_000, 'mp4');
    fs.writeFileSync(path.join(STT_DIR, String(s.meetingId), 'note.txt'), 'ignored');
    setNextTranscriptions(
      '점검 일정은 화요일로 확정합니다',
      '시청해 주셔서 감사합니다',
      '회의 용어: 오송라인, 방열판',
    );
    const saved = await transcribeMeetingAudio(s.meetingId);
    expect(saved).toBe(1);
    expect(transcripts(s.meetingId)).toEqual([
      { text: '점검 일정은 화요일로 확정합니다', source: 'whisper', created_at: toDbTime(1_700_000_000_000), user_id: s.hostId },
    ]);
    expect(transcribeCalls.map((c) => path.basename(c.path!))).toEqual([
      `${s.hostId}-1700000000000.webm`,
      `${s.hostId}-1700000030000.mp4`,
      `${s.hostId}-1700000060000.webm`,
    ]);
    expect(transcribeCalls[0]).toMatchObject({ model: 'gpt-4o-mini-transcribe', language: 'ko' });
    expect(transcribeCalls[0].prompt!.startsWith('회의 용어: 오송라인, ')).toBe(true);
    // 오디오 청크는 전부 지워지고(txt는 남아 디렉터리 유지) 다음 회의에 섞이지 않는다
    expect(fs.readdirSync(path.join(STT_DIR, String(s.meetingId)))).toEqual(['note.txt']);
  });

  it('전사 실패한 청크는 건너뛰고 지운다 (recap은 계속), 청크 없으면 0', async () => {
    const s = await setupMeeting('st4');
    writeChunk(s.meetingId, s.hostId, 1_700_000_000_000);
    writeChunk(s.meetingId, s.hostId, 1_700_000_030_000);
    setNextTranscriptions(new Error('500'), '두 번째 청크는 성공');
    expect(await transcribeMeetingAudio(s.meetingId)).toBe(1);
    expect(transcripts(s.meetingId).map((t) => t.text)).toEqual(['두 번째 청크는 성공']);
    expect(fs.existsSync(path.join(STT_DIR, String(s.meetingId)))).toBe(false); // 비었으니 디렉터리까지 제거
    expect(await transcribeMeetingAudio(s.meetingId)).toBe(0);
  });
});

describe('POST /api/meetings/:code/stt/audio?live=1 — 라이브 청크 전사', () => {
  it('저장 직후 전사해 call_transcripts(whisper)에 넣고 청크를 지운다', async () => {
    const s = await setupMeeting('st5');
    const ts = Date.now() - 5000;
    setNextTranscriptions('라이브 자막 한 줄입니다');
    const r = await request(app)
      .post(`/api/meetings/${s.code}/stt/audio?ts=${ts}&live=1`)
      .set('Authorization', `Bearer ${s.host.token}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(2000, 7));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, live: true });
    await waitFor(() => transcripts(s.meetingId).length > 0);
    expect(transcripts(s.meetingId)[0]).toMatchObject({ text: '라이브 자막 한 줄입니다', source: 'whisper', created_at: toDbTime(ts) });
    await waitFor(() => !fs.existsSync(path.join(STT_DIR, String(s.meetingId), `${s.hostId}-${ts}.webm`)));
    expect(fs.existsSync(path.join(STT_DIR, String(s.meetingId), `${s.hostId}-${ts}.webm`))).toBe(false);
  });

  it('빈 조각은 skipped, ts 없으면 400, 참가자 아니면 403', async () => {
    const s = await setupMeeting('st6');
    const tiny = await request(app)
      .post(`/api/meetings/${s.code}/stt/audio?ts=${Date.now()}`)
      .set('Authorization', `Bearer ${s.host.token}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(10, 1));
    expect(tiny.body).toEqual({ ok: true, skipped: true });
    const noTs = await request(app)
      .post(`/api/meetings/${s.code}/stt/audio`)
      .set('Authorization', `Bearer ${s.host.token}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(2000, 1));
    expect(noTs.status).toBe(400);
    const stranger = await registerUser('st6_stranger');
    const no = await request(app)
      .post(`/api/meetings/${s.code}/stt/audio?ts=${Date.now()}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(2000, 1));
    expect(no.status).toBe(403);
    expect(transcribeCalls).toHaveLength(0);
  });
});
