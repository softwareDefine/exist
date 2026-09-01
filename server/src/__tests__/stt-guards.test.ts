import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

/*
 * stt.ts 가드 — 청크 시작 시각순 정렬(알파벳순과 다른 경우·NaN 키), 5MB 상한(413), 1000바이트 경계,
 * ts·ext 검증, 라이브 청크 전사의 voice:caption 방송.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  delete process.env.WHISPER_URL;
  delete process.env.STT_PREFER;
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { initNotifier } from '../notify.js';
import { transcribeMeetingAudio, toDbTime } from '../stt.js';
import { register, auth, createMeeting, fakeIo } from './helpers/fixtures.js';
import { setNextTranscriptions, transcribeCalls, resetOpenAiMock, waitFor } from './helpers/openaiMock.js';

const app = createApp();
const STT_DIR = path.join(process.env.DATA_DIR!, 'stt-chunks');
beforeEach(() => resetOpenAiMock());

async function setup(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const m = await createMeeting(app, host, `${prefix} 회의`);
  return { host, code: m.code, meetingId: m.id };
}
function writeChunk(meetingId: number, name: string) {
  const dir = path.join(STT_DIR, String(meetingId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(1500, 1));
}
const transcripts = (meetingId: number) =>
  db.prepare('SELECT text, created_at, user_id FROM call_transcripts WHERE meeting_id = ? ORDER BY id').all(meetingId) as { text: string; created_at: string; user_id: number }[];
const upload = (code: string, token: string, query: string, body: Buffer) =>
  request(app).post(`/api/meetings/${code}/stt/audio${query}`).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').send(body);

describe('transcribeMeetingAudio — 청크 순서', () => {
  it('알파벳순(999 > 1000)이 아니라 숫자 시작 시각순으로 전사·저장한다', async () => {
    const s = await setup('so1');
    const u = s.host.id;
    writeChunk(s.meetingId, `${u}-1000.webm`);
    writeChunk(s.meetingId, `${u}-20000.mp4`);
    writeChunk(s.meetingId, `${u}-999.webm`);
    setNextTranscriptions('첫 번째 발언입니다', '두 번째 발언입니다', '세 번째 발언입니다');
    expect(await transcribeMeetingAudio(s.meetingId)).toBe(3);
    expect(transcribeCalls.map((c) => path.basename(c.path!))).toEqual([`${u}-999.webm`, `${u}-1000.webm`, `${u}-20000.mp4`]);
    expect(transcripts(s.meetingId)).toEqual([
      { text: '첫 번째 발언입니다', created_at: toDbTime(999), user_id: u },
      { text: '두 번째 발언입니다', created_at: toDbTime(1000), user_id: u },
      { text: '세 번째 발언입니다', created_at: toDbTime(20000), user_id: u },
    ]);
    expect(fs.existsSync(path.join(STT_DIR, String(s.meetingId)))).toBe(false);
  }, 20_000);

  it('파일명 형식이 깨진 청크(NaN 키)는 전사돼도 저장하지 않고 지운다, 정상 청크는 그대로 저장', async () => {
    const s = await setup('so2');
    const u = s.host.id;
    writeChunk(s.meetingId, 'garbage.webm');
    writeChunk(s.meetingId, `${u}-5000.webm`);
    writeChunk(s.meetingId, `notanumber-6000.webm`);
    setNextTranscriptions('전사 1', '전사 2', '전사 3');
    expect(await transcribeMeetingAudio(s.meetingId)).toBe(1);
    expect(transcribeCalls).toHaveLength(3);
    expect(transcripts(s.meetingId)).toEqual([{ text: expect.any(String), created_at: toDbTime(5000), user_id: u }]);
    expect(fs.existsSync(path.join(STT_DIR, String(s.meetingId)))).toBe(false);
    // 2000자 절단, 확장자가 아닌 파일은 무시
    writeChunk(s.meetingId, `${u}-7000.ogg`);
    fs.writeFileSync(path.join(STT_DIR, String(s.meetingId), `${u}-8000.txt`), 'x');
    setNextTranscriptions('  ' + '가'.repeat(2500) + '  ');
    expect(await transcribeMeetingAudio(s.meetingId)).toBe(1);
    expect(transcribeCalls).toHaveLength(4);
    expect(transcripts(s.meetingId).at(-1)!.text).toHaveLength(2000);
  }, 20_000);
});

describe('POST /:code/stt/audio — 입력 검증·상한', () => {
  it('ts 는 양수 유한값, ext 는 webm/mp4/ogg/m4a 만, 1000바이트 미만은 skipped, JSON 본문 400', async () => {
    const s = await setup('sv1');
    for (const q of ['?ts=0', '?ts=-5', '?ts=abc', '?ts=Infinity']) {
      const r = await upload(s.code, s.host.token, q, Buffer.alloc(2000, 1));
      expect(r.status, q).toBe(400);
      expect(r.body, q).toEqual({ error: 'ts(청크 시작 시각)가 필요해요' });
    }
    const dir = path.join(STT_DIR, String(s.meetingId));
    expect((await upload(s.code, s.host.token, '?ts=1000&ext=m4a', Buffer.alloc(1000, 1))).body).toEqual({ ok: true, live: false }); // 정확히 1000 은 저장
    expect((await upload(s.code, s.host.token, '?ts=2000&ext=ogg', Buffer.alloc(1500, 1))).body).toEqual({ ok: true, live: false });
    expect((await upload(s.code, s.host.token, '?ts=3000&ext=exe', Buffer.alloc(1500, 1))).body).toEqual({ ok: true, live: false });
    expect((await upload(s.code, s.host.token, '?ts=4000', Buffer.alloc(999, 1))).body).toEqual({ ok: true, skipped: true });
    expect(fs.readdirSync(dir).sort()).toEqual([`${s.host.id}-1000.m4a`, `${s.host.id}-2000.ogg`, `${s.host.id}-3000.webm`]);
    expect(fs.statSync(path.join(dir, `${s.host.id}-1000.m4a`)).size).toBe(1000);
    const json = await request(app).post(`/api/meetings/${s.code}/stt/audio?ts=5000`).set(auth(s.host)).send({ audio: 'nope' });
    expect(json.status).toBe(400);
    expect(json.body).toEqual({ error: '오디오 본문을 바이너리로 보내주세요' });
    expect(fs.readdirSync(dir)).toHaveLength(3);
  }, 20_000);

  it('5MB 초과 청크는 413 이고 저장되지 않는다', async () => {
    const s = await setup('sv2');
    const r = await upload(s.code, s.host.token, '?ts=1000', Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ error: '오디오 청크가 너무 커요' });
    expect(fs.existsSync(path.join(STT_DIR, String(s.meetingId)))).toBe(false);
    const exact = await upload(s.code, s.host.token, '?ts=2000', Buffer.alloc(5 * 1024 * 1024, 1));
    expect(exact.body).toEqual({ ok: true, live: false });
    expect(fs.statSync(path.join(STT_DIR, String(s.meetingId), `${s.host.id}-2000.webm`)).size).toBe(5 * 1024 * 1024);
  }, 30_000);
});

describe('라이브 청크 전사 — voice:caption 방송', () => {
  it('전사 결과를 room:CODE 에 {username, text, ts, source: whisper} 로 방송하고 기록·삭제, 상투구는 방송 없이 삭제', async () => {
    const s = await setup('lv1');
    const io = fakeIo([s.host.id]);
    initNotifier(io.io as never);
    const ts = Date.now() - 3000;
    setNextTranscriptions('  라이브 자막 한 줄  ');
    const r = await upload(s.code, s.host.token, `?ts=${ts}&live=1`, Buffer.alloc(2000, 1));
    expect(r.body).toEqual({ ok: true, live: true });
    await waitFor(() => io.rooms.length > 0);
    expect(io.rooms).toEqual([{ room: `room:${s.code}`, event: 'voice:caption', payload: { username: 'lv1_host', text: '라이브 자막 한 줄', ts: expect.any(Number), source: 'whisper' } }]);
    expect(transcripts(s.meetingId)).toEqual([{ text: '라이브 자막 한 줄', created_at: toDbTime(ts), user_id: s.host.id }]);
    await waitFor(() => !fs.existsSync(path.join(STT_DIR, String(s.meetingId), `${s.host.id}-${ts}.webm`)));
    expect(fs.existsSync(path.join(STT_DIR, String(s.meetingId), `${s.host.id}-${ts}.webm`))).toBe(false);
    // 상투구 — 방송·기록 없이 파일만 삭제
    setNextTranscriptions('시청해 주셔서 감사합니다');
    await upload(s.code, s.host.token, `?ts=${ts + 1}&live=1`, Buffer.alloc(2000, 1));
    await waitFor(() => !fs.existsSync(path.join(STT_DIR, String(s.meetingId), `${s.host.id}-${ts + 1}.webm`)));
    expect(io.rooms).toHaveLength(1);
    expect(transcripts(s.meetingId)).toHaveLength(1);
    // live 가 아니면 전사하지 않고 보관
    await upload(s.code, s.host.token, `?ts=${ts + 2}&live=0`, Buffer.alloc(2000, 1));
    await new Promise((res) => setTimeout(res, 50));
    expect(fs.existsSync(path.join(STT_DIR, String(s.meetingId), `${s.host.id}-${ts + 2}.webm`))).toBe(true);
    expect(transcribeCalls).toHaveLength(2);
  }, 20_000);
});
