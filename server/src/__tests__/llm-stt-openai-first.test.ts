import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { EventEmitter } from 'node:events';

/*
 * stt.ts — 둘 다 있고 STT_PREFER=openai(기본)일 때: OpenAI 우선, 실패 시 로컬 whisper 폴백.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.WHISPER_URL = 'http://whisper.test';
  process.env.STT_PREFER = 'openai';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: EE } = await import('node:events');
  return {
    ...orig,
    spawn: () => {
      const p = new EE() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      p.stdout = new EE();
      p.stderr = new EE();
      setImmediate(() => {
        p.stdout.emit('data', Buffer.from('RIFF-fake-wav'));
        p.emit('close', 0);
      });
      return p;
    },
  };
});

import db from '../db.js';
import { transcribeMeetingAudio } from '../stt.js';
import { setNextTranscriptions, transcribeCalls, resetOpenAiMock } from './helpers/openaiMock.js';

const STT_DIR = path.join(process.env.DATA_DIR!, 'stt-chunks');
const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: '로컬 폴백 전사' }) }));
vi.stubGlobal('fetch', fetchMock);

let seq = 0;
function setupMeeting() {
  seq++;
  const uid = db.prepare("INSERT INTO users (username, pw_hash, pw_salt) VALUES (?, 'x', 'x')").run(`stof_u${seq}`).lastInsertRowid as number;
  const mid = db.prepare('INSERT INTO meetings (code, title, host_id) VALUES (?, ?, ?)').run(`STOF${seq}`, '전사', uid).lastInsertRowid as number;
  const dir = path.join(STT_DIR, String(mid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}-1700000000000.webm`), Buffer.alloc(1500, 1));
  return mid;
}
function texts(mid: number) {
  return (db.prepare('SELECT text FROM call_transcripts WHERE meeting_id = ? ORDER BY id').all(mid) as { text: string }[]).map((r) => r.text);
}

beforeEach(() => {
  resetOpenAiMock();
  fetchMock.mockClear();
});

describe('STT_PREFER=openai + WHISPER_URL', () => {
  it('OpenAI 성공이면 로컬은 호출하지 않는다', async () => {
    const mid = setupMeeting();
    setNextTranscriptions('OpenAI 전사');
    expect(await transcribeMeetingAudio(mid)).toBe(1);
    expect(texts(mid)).toEqual(['OpenAI 전사']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OpenAI 실패 → 로컬 whisper 폴백', async () => {
    const mid = setupMeeting();
    setNextTranscriptions(new Error('ECONNRESET'));
    expect(await transcribeMeetingAudio(mid)).toBe(1);
    expect(texts(mid)).toEqual(['로컬 폴백 전사']);
    expect(transcribeCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('http://whisper.test/inference');
  });
});
