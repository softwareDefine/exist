import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import db from '../db.js';

/* 스트리밍 자막(stt-live.ts) — OpenAI Realtime을 흉내 내는 로컬 WS 서버로
 * 세션 수립 → 오디오 전달 → commit → 델타/확정 → call_transcripts 기록까지 확인.
 * 모듈이 import 시점에 env를 읽으므로 env를 먼저 잡고 동적 import 한다. */

let wss: WebSocketServer;
const received: { type: string; audioBytes?: number }[] = [];
let lastSock: WebSocket | null = null;

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (sock) => {
    lastSock = sock;
    sock.send(JSON.stringify({ type: 'session.created', session: {} }));
    sock.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as { type: string; audio?: string; session?: unknown };
      received.push({ type: e.type, audioBytes: e.audio ? Buffer.from(e.audio, 'base64').length : undefined });
      if (e.type === 'session.update') sock.send(JSON.stringify({ type: 'session.updated', session: e.session }));
      if (e.type === 'input_audio_buffer.commit') {
        sock.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: '검사 설비 온도 세팅은 오늘 중으로 조정하겠습니다.' }));
      }
    });
  });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const port = (wss.address() as AddressInfo).port;
  process.env.OPENAI_REALTIME_URL = `ws://127.0.0.1:${port}/realtime`;
  process.env.OPENAI_API_KEY = 'sk-test';
});

afterAll(() => {
  delete process.env.OPENAI_API_KEY;
  wss.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('스트리밍 자막 세션', () => {
  it('세션 수립 → PCM 전달 → 델타 interim → commit 확정본이 call_transcripts에 기록된다', async () => {
    const { openLiveStt, liveSttEnabled } = await import('../stt-live.js');
    expect(liveSttEnabled).toBe(true);
    // 회의 하나
    db.prepare("INSERT INTO users (username, pw_hash, pw_salt) VALUES ('live_u', 'x', 'y')").run();
    const userId = (db.prepare("SELECT id FROM users WHERE username = 'live_u'").get() as { id: number }).id;
    db.prepare("INSERT INTO meetings (code, title, host_id) VALUES ('LIVE01', 'live', ?)").run(userId);
    const meetingId = (db.prepare("SELECT id FROM meetings WHERE code = 'LIVE01'").get() as { id: number }).id;

    const statuses: string[] = [];
    const s = openLiveStt({
      meetingId,
      meetingCode: 'LIVE01',
      userId,
      username: 'live_u',
      peerId: 'sock1',
      onStatus: (st) => statuses.push(st.state),
    });
    expect(s).not.toBeNull();
    // 연결 전 도착한 오디오는 보류됐다가 ready 후 전달
    s!.push(Buffer.alloc(4800, 1));
    await wait(150);
    expect(s!.state).toBe('ready');
    expect(statuses).toEqual(['ready']);
    s!.push(Buffer.alloc(4800, 2));
    await wait(50);
    const appends = received.filter((r) => r.type === 'input_audio_buffer.append');
    expect(appends.length).toBe(2);
    expect(appends[0].audioBytes).toBe(4800);
    // 델타가 없는 상태의 commit은 보내지 않는다(빈 버퍼 오류 방지)
    s!.commit();
    await wait(30);
    expect(received.some((r) => r.type === 'input_audio_buffer.commit')).toBe(false);
    // 서버가 델타를 흘리면 구간이 열리고, 그 다음 commit은 전달된다
    lastSock!.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: '검사 설비' }));
    await wait(30);
    s!.commit();
    await wait(80);
    expect(received.some((r) => r.type === 'input_audio_buffer.commit')).toBe(true);
    const rows = db
      .prepare('SELECT text, source FROM call_transcripts WHERE meeting_id = ? AND user_id = ?')
      .all(meetingId, userId) as { text: string; source: string }[];
    expect(rows).toEqual([{ text: '검사 설비 온도 세팅은 오늘 중으로 조정하겠습니다.', source: 'whisper' }]);
    // 세션 설정에 모델·언어·용어집 프롬프트가 실렸는지
    const upd = received.find((r) => r.type === 'session.update');
    expect(upd).toBeTruthy();
    s!.close();
    expect(s!.state).toBe('closed');
  });

  it('닫힐 때 열린 구간의 누적 델타를 기록으로 남긴다 (프롬프트 에코·잡음은 버림)', async () => {
    const { openLiveStt } = await import('../stt-live.js');
    const userId = (db.prepare("SELECT id FROM users WHERE username = 'live_u'").get() as { id: number }).id;
    const meetingId = (db.prepare("SELECT id FROM meetings WHERE code = 'LIVE01'").get() as { id: number }).id;
    const s = openLiveStt({ meetingId, meetingCode: 'LIVE01', userId, username: 'live_u', peerId: 'sock2', onStatus: () => {} })!;
    await wait(150);
    lastSock!.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: '방열판 ' }));
    lastSock!.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: '두께는 3mm로 갑니다' }));
    await wait(50);
    s.close();
    const rows = db
      .prepare('SELECT text FROM call_transcripts WHERE meeting_id = ? ORDER BY id')
      .all(meetingId) as { text: string }[];
    expect(rows.map((r) => r.text)).toContain('방열판 두께는 3mm로 갑니다');

    // 잡음: "회의 용어:" 로 시작하는 프롬프트 에코는 기록하지 않는다
    const before = rows.length;
    const s2 = openLiveStt({ meetingId, meetingCode: 'LIVE01', userId, username: 'live_u', peerId: 'sock3', onStatus: () => {} })!;
    await wait(150);
    lastSock!.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: '회의 용어: 방열판, 검사 설비' }));
    await wait(50);
    s2.close();
    const after = (db.prepare('SELECT COUNT(*) AS n FROM call_transcripts WHERE meeting_id = ?').get(meetingId) as { n: number }).n;
    expect(after).toBe(before);
  });
});
