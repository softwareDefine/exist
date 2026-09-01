import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import request from 'supertest';
import { io as ioc, type Socket } from 'socket.io-client';
import db from '../db.js';

/* 스트리밍 자막(stt:live-*) 소켓 경로 — OpenAI Realtime 을 흉내 내는 로컬 WS 서버를 두고
 * 클라 소켓 → sfu → stt-live → 업스트림 WS → voice:caption 방송까지 끝에서 끝으로 확인.
 * stt-live.ts / stt.ts / steward.ts 가 import 시점에 OPENAI_API_KEY 를 읽으므로
 * env 를 먼저 잡고 서버 모듈을 동적 import 한다 (다른 테스트 파일과는 워커가 분리됨). */

let wss: WebSocketServer;
const upstream = new EventEmitter(); // 'msg' {sock, e} · 'open' sock · 'close' sock
let upstreamSockets: WebSocket[] = [];
let server: http.Server;
let url = '';
const opened: Socket[] = [];
let closeIo: () => Promise<void>;

function waitUpstream(type: string, ms = 2000): Promise<any> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { upstream.off('msg', h); rej(new Error(`timeout waiting upstream '${type}'`)); }, ms);
    const h = ({ e }: { e: any }) => { if (e.type !== type) return; clearTimeout(t); upstream.off('msg', h); res(e); };
    upstream.on('msg', h);
  });
}
function onceEv<T = any>(em: EventEmitter, ev: string, ms = 2000): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting '${ev}'`)), ms);
    em.once(ev, (p: T) => { clearTimeout(t); res(p); });
  });
}
function waitFor<T = any>(s: Socket, ev: string, pred: (p: T) => boolean = () => true, ms = 2000): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout waiting '${ev}'`)); }, ms);
    const h = (p: T) => { if (!pred(p)) return; clearTimeout(t); s.off(ev, h); res(p); };
    s.on(ev, h);
  });
}
function silence(s: Socket, ev: string, ms = 250): Promise<void> {
  return new Promise((res, rej) => {
    const h = (p: unknown) => { clearTimeout(t); s.off(ev, h); rej(new Error(`unexpected '${ev}': ${JSON.stringify(p)}`)); };
    const t = setTimeout(() => { s.off(ev, h); res(); }, ms);
    s.on(ev, h);
  });
}
const ack = <T = any>(s: Socket, ev: string, payload: unknown = {}) => s.timeout(2000).emitWithAck(ev, payload) as Promise<T>;
function connect(token: string): Promise<Socket> {
  const s = ioc(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  opened.push(s);
  return new Promise((res, rej) => {
    s.once('connect', () => res(s));
    s.once('connect_error', rej);
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: ReturnType<typeof import('../app.js').createApp>;
let host: { token: string; id: number };
let guest: { token: string; id: number };
let code = '';
let hs: Socket;
let gs: Socket;

beforeAll(async () => {
  // 1) 업스트림 흉내 — session.update 에 session.updated, commit 에 completed 로 응답
  wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (sock) => {
    upstreamSockets.push(sock);
    upstream.emit('open', sock);
    sock.on('message', (raw) => {
      const e = JSON.parse(raw.toString());
      upstream.emit('msg', { sock, e });
      if (e.type === 'session.update') sock.send(JSON.stringify({ type: 'session.updated', session: e.session }));
      if (e.type === 'input_audio_buffer.commit') {
        sock.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: '검사 설비 온도 세팅은 오늘 중으로 조정하겠습니다.' }));
      }
    });
    sock.on('close', () => upstream.emit('close', sock));
  });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  process.env.OPENAI_REALTIME_URL = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/realtime`;
  process.env.OPENAI_API_KEY = 'sk-test';

  // 2) env 가 잡힌 뒤에 서버 모듈 로드
  const { createApp } = await import('../app.js');
  const { attachRealtime } = await import('../realtime.js');
  const { startMediasoup } = await import('../sfu.js');
  const { getIo } = await import('../notify.js');
  const { liveSttEnabled } = await import('../stt-live.js');
  expect(liveSttEnabled).toBe(true);
  app = createApp();
  server = http.createServer(app);
  attachRealtime(app, server);
  closeIo = () => new Promise<void>((r) => getIo()!.close(() => r()));
  await startMediasoup();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const reg = async (username: string) => {
    const r = await request(app).post('/api/auth/register').send({ username, password: 'password123' });
    return { token: r.body.token as string, id: r.body.user.id as number };
  };
  host = await reg('live_host');
  guest = await reg('live_guest');
  const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${host.token}`).send({ title: '라이브 자막' });
  code = m.body.code as string;
  await request(app).post('/api/meetings/join').set('Authorization', `Bearer ${guest.token}`).send({ code });
  hs = await connect(host.token);
  gs = await connect(guest.token);
  await ack(hs, 'room:join', { code });
  await ack(gs, 'room:join', { code });
}, 20_000);

afterAll(async () => {
  for (const s of opened) s.disconnect();
  const { cancelScheduledRecap } = await import('../recap.js');
  cancelScheduledRecap(code);
  await closeIo();
  delete process.env.OPENAI_API_KEY;
  wss.close();
});

describe('stt:live-* 소켓 경로 (OpenAI Realtime 모의 서버)', () => {
  it('live-start → 업스트림 세션 수립(session.update 에 모델·언어) → 클라에 stt:live-status ready', async () => {
    const openP = onceEv<WebSocket>(upstream, 'open');
    const sessUpd = waitUpstream('session.update');
    const status = waitFor<any>(hs, 'stt:live-status');
    expect(await ack(hs, 'stt:live-start')).toEqual({ ok: true });
    await openP;
    const upd = await sessUpd;
    expect(upd.session.type).toBe('transcription');
    expect(upd.session.audio.input.transcription.language).toBe('ko');
    expect(upd.session.audio.input.transcription.model).toBeTruthy();
    expect(await status).toEqual({ state: 'ready' });
  });

  it('live-audio Buffer → base64 input_audio_buffer.append 로 전달 (ArrayBuffer 도 동일)', async () => {
    const a1 = waitUpstream('input_audio_buffer.append');
    hs.emit('stt:live-audio', Buffer.alloc(4800, 7));
    const e1 = await a1;
    expect(Buffer.from(e1.audio, 'base64')).toEqual(Buffer.alloc(4800, 7));
    const a2 = waitUpstream('input_audio_buffer.append');
    hs.emit('stt:live-audio', new Uint8Array([1, 2, 3, 4]).buffer);
    expect(Buffer.from((await a2).audio, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('델타 없는 commit 은 보내지 않는다 (빈 버퍼 오류 방지)', async () => {
    let commits = 0;
    const h = ({ e }: { e: any }) => { if (e.type === 'input_audio_buffer.commit') commits++; };
    upstream.on('msg', h);
    hs.emit('stt:live-commit');
    await wait(150);
    upstream.off('msg', h);
    expect(commits).toBe(0);
  });

  it('업스트림 델타 → 방 전원에게 interim voice:caption(source live); commit → completed 가 확정 자막 + call_transcripts', async () => {
    const up = upstreamSockets.at(-1)!;
    const toHost = waitFor<any>(hs, 'voice:caption', (c) => c.interim === true);
    const toGuest = waitFor<any>(gs, 'voice:caption', (c) => c.interim === true);
    up.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: '검사 설비' }));
    const [h, g] = await Promise.all([toHost, toGuest]);
    expect(h).toMatchObject({ peerId: hs.id, username: 'live_host', text: '검사 설비', interim: true, source: 'live' });
    expect(g.text).toBe('검사 설비');

    const commit = waitUpstream('input_audio_buffer.commit');
    const finalH = waitFor<any>(hs, 'voice:caption', (c) => c.interim === false);
    const finalG = waitFor<any>(gs, 'voice:caption', (c) => c.interim === false);
    hs.emit('stt:live-commit');
    await commit;
    const f = await finalH;
    await finalG;
    expect(f).toMatchObject({ username: 'live_host', text: '검사 설비 온도 세팅은 오늘 중으로 조정하겠습니다.', interim: false, source: 'live' });
    const rows = db
      .prepare('SELECT user_id, text, source FROM call_transcripts WHERE meeting_id = (SELECT id FROM meetings WHERE code = ?)')
      .all(code) as { user_id: number; text: string; source: string }[];
    expect(rows).toEqual([{ user_id: host.id, text: '검사 설비 온도 세팅은 오늘 중으로 조정하겠습니다.', source: 'whisper' }]);
  });

  it('live-stop 은 업스트림 소켓을 닫는다 · 이후 오디오는 무시', async () => {
    const up = upstreamSockets.at(-1)!;
    const closed = onceEv<WebSocket>(upstream, 'close');
    hs.emit('stt:live-stop');
    expect(await closed).toBe(up);
    let appends = 0;
    const h = ({ e }: { e: any }) => { if (e.type === 'input_audio_buffer.append') appends++; };
    upstream.on('msg', h);
    hs.emit('stt:live-audio', Buffer.alloc(100, 1));
    await wait(120);
    upstream.off('msg', h);
    expect(appends).toBe(0);
  });

  it('업스트림 error 는 stt:live-status error 로 전달되고 세션이 닫힌다 (빈 버퍼 commit 오류는 무시)', async () => {
    const openP = onceEv<WebSocket>(upstream, 'open');
    const ready = waitFor<any>(hs, 'stt:live-status', (s) => s.state === 'ready');
    expect(await ack(hs, 'stt:live-start')).toEqual({ ok: true });
    const up = await openP;
    await ready;
    // 무해한 오류 — 세션 유지
    const quiet = silence(hs, 'stt:live-status');
    up.send(JSON.stringify({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer too small' } }));
    await quiet;
    const err = waitFor<any>(hs, 'stt:live-status', (s) => s.state === 'error');
    const closed = onceEv<WebSocket>(upstream, 'close');
    up.send(JSON.stringify({ type: 'error', error: { message: 'boom' } }));
    expect(await err).toEqual({ state: 'error', reason: 'boom' });
    expect(await closed).toBe(up);
  });

  it('live-start 재호출은 기존 세션을 닫고 새로 연다 · 소켓 끊김 시 업스트림도 닫힌다', async () => {
    const open1 = onceEv<WebSocket>(upstream, 'open');
    expect(await ack(gs, 'stt:live-start')).toEqual({ ok: true });
    const up1 = await open1;
    await waitFor<any>(gs, 'stt:live-status', (s) => s.state === 'ready');
    const closed1 = onceEv<WebSocket>(upstream, 'close');
    const open2 = onceEv<WebSocket>(upstream, 'open');
    expect(await ack(gs, 'stt:live-start')).toEqual({ ok: true });
    expect(await closed1).toBe(up1);
    const up2 = await open2;
    await waitFor<any>(gs, 'stt:live-status', (s) => s.state === 'ready');
    // 열린 구간(델타)이 있는 채로 끊기면 누적 델타가 기록으로 남고 업스트림이 닫힌다
    const cap = waitFor<any>(hs, 'voice:caption', (c) => c.username === 'live_guest' && c.interim === true);
    up2.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: '방열판 두께 3mm' }));
    await cap;
    const closed2 = onceEv<WebSocket>(upstream, 'close');
    const gsId = gs.id; // 클라 disconnect() 는 socket.id 를 지운다
    const left = waitFor<any>(hs, 'peer:left', (p) => p.peerId === gsId);
    gs.disconnect();
    expect(await closed2).toBe(up2);
    await left;
    const rows = db
      .prepare('SELECT text FROM call_transcripts WHERE user_id = ? ORDER BY id')
      .all(guest.id) as { text: string }[];
    expect(rows.map((r) => r.text)).toEqual(['방열판 두께 3mm']);
  });
});
