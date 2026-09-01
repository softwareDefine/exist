import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { EventEmitter } from 'node:events';

/*
 * stt.ts — 온프레미스 whisper.cpp 우선 모드(WHISPER_URL + STT_PREFER=local).
 * ffmpeg(spawn)와 fetch를 모의해 로컬 성공 / 로컬 HTTP 실패 → OpenAI 폴백 / ffmpeg 실패 → OpenAI 폴백을 검증.
 */
const state = vi.hoisted(() => ({ ffmpegExit: 0 }));
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.WHISPER_URL = 'http://whisper.test/';
  process.env.STT_PREFER = 'local';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: EE } = await import('node:events');
  return {
    ...orig,
    spawn: (cmd: string, args: string[]) => {
      const p = new EE() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; spawnArgs: string[] };
      p.stdout = new EE();
      p.stderr = new EE();
      p.spawnArgs = [cmd, ...args];
      setImmediate(() => {
        if (state.ffmpegExit === 0) p.stdout.emit('data', Buffer.from('RIFF-fake-wav-16k'));
        else p.stderr.emit('data', Buffer.from('Invalid data found'));
        p.emit('close', state.ffmpegExit);
      });
      return p;
    },
  };
});

import db from '../db.js';
import { transcribeMeetingAudio } from '../stt.js';
import { setNextTranscriptions, transcribeCalls, resetOpenAiMock } from './helpers/openaiMock.js';

const STT_DIR = path.join(process.env.DATA_DIR!, 'stt-chunks');
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function localOk(text: string) {
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ text }) }));
}
function localFail(status = 500) {
  fetchMock.mockImplementation(async () => ({ ok: false, status, json: async () => ({}) }));
}

let seq = 0;
function setupMeeting() {
  seq++;
  const uid = db.prepare("INSERT INTO users (username, pw_hash, pw_salt) VALUES (?, 'x', 'x')").run(`stl_u${seq}`).lastInsertRowid as number;
  const mid = db.prepare('INSERT INTO meetings (code, title, host_id) VALUES (?, ?, ?)').run(`STLOC${seq}`, '로컬 전사', uid).lastInsertRowid as number;
  const dir = path.join(STT_DIR, String(mid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uid}-1700000000000.webm`), Buffer.alloc(1500, 1));
  return { uid, mid };
}
function texts(mid: number) {
  return (db.prepare('SELECT text FROM call_transcripts WHERE meeting_id = ? ORDER BY id').all(mid) as { text: string }[]).map((r) => r.text);
}

beforeEach(() => {
  resetOpenAiMock();
  fetchMock.mockReset();
  state.ffmpegExit = 0;
});

describe('STT_PREFER=local — 음성이 외부로 나가지 않는 경로', () => {
  it('로컬 whisper 성공 → OpenAI 호출 없음, /inference에 wav·language·prompt multipart', async () => {
    const { mid } = setupMeeting();
    localOk('로컬 전사 결과입니다');
    expect(await transcribeMeetingAudio(mid)).toBe(1);
    expect(texts(mid)).toEqual(['로컬 전사 결과입니다']);
    expect(transcribeCalls).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: FormData; signal: AbortSignal }];
    expect(url).toBe('http://whisper.test/inference'); // 끝 슬래시 정리
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('language')).toBe('ko');
    expect(init.body.get('response_format')).toBe('json');
    expect(String(init.body.get('prompt'))).toMatch(/^회의 용어: /);
    expect((init.body.get('file') as Blob).size).toBeGreaterThan(0);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('로컬 HTTP 실패 → OpenAI 폴백', async () => {
    const { mid } = setupMeeting();
    localFail(503);
    setNextTranscriptions('OpenAI 폴백 전사');
    expect(await transcribeMeetingAudio(mid)).toBe(1);
    expect(texts(mid)).toEqual(['OpenAI 폴백 전사']);
    expect(transcribeCalls).toHaveLength(1);
  });

  it('ffmpeg 변환 실패(컨테이너에 ffmpeg 없음 등) → OpenAI 폴백, fetch는 호출되지 않는다', async () => {
    const { mid } = setupMeeting();
    state.ffmpegExit = 1;
    setNextTranscriptions('ffmpeg 없이 OpenAI로');
    expect(await transcribeMeetingAudio(mid)).toBe(1);
    expect(texts(mid)).toEqual(['ffmpeg 없이 OpenAI로']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('로컬도 OpenAI도 실패하면 청크를 버리고 0 (recap은 Web Speech 기록으로 진행)', async () => {
    const { mid } = setupMeeting();
    localFail();
    setNextTranscriptions(new Error('quota'));
    expect(await transcribeMeetingAudio(mid)).toBe(0);
    expect(texts(mid)).toEqual([]);
    expect(fs.existsSync(path.join(STT_DIR, String(mid)))).toBe(false);
  });
});
