import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as ioc, type Socket } from 'socket.io-client';
import { createApp } from '../app.js';
import { attachRealtime } from '../realtime.js';
import { startMediasoup, getRoomSize, getRoomPeers } from '../sfu.js';
import { cancelScheduledRecap } from '../recap.js';
import { getIo, isViewingDm } from '../notify.js';
import db from '../db.js';

/* 실시간 계층 통합 테스트 — 진짜 Socket.IO 서버(+mediasoup 라우터)에 socket.io-client 로 붙어
 * 소켓 인증 · room:join/leave · 자막 방송 · 채팅 · 호스트 권한 게이트 · presence 를 확인한다.
 * OPENAI_API_KEY 가 없는 환경이므로 스트리밍 자막(stt:live-*)은 unavailable 경로만 본다
 * (키 있는 경로는 realtime-live.test.ts). */

const app = createApp();
const server = http.createServer(app);
let url = '';
const opened: Socket[] = [];

/* ── 헬퍼 ── */
function mk(token: string | undefined): Socket {
  const s = ioc(url, { auth: token ? { token } : {}, autoConnect: false, transports: ['websocket'], reconnection: false });
  opened.push(s);
  return s;
}
function open(s: Socket, ms = 2000): Promise<Socket> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('connect timeout')), ms);
    s.once('connect', () => { clearTimeout(t); res(s); });
    s.once('connect_error', (e) => { clearTimeout(t); rej(e); });
    s.connect();
  });
}
async function connect(token: string) {
  return open(mk(token));
}
function waitFor<T = any>(s: Socket, ev: string, pred: (p: T) => boolean = () => true, ms = 2000): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout waiting '${ev}'`)); }, ms);
    const h = (p: T) => { if (!pred(p)) return; clearTimeout(t); s.off(ev, h); res(p); };
    s.on(ev, h);
  });
}
/** ms 동안 해당 이벤트가 오지 않아야 통과 */
function silence(s: Socket, ev: string, ms = 250): Promise<void> {
  return new Promise((res, rej) => {
    const h = (p: unknown) => { clearTimeout(t); s.off(ev, h); rej(new Error(`unexpected '${ev}': ${JSON.stringify(p)}`)); };
    const t = setTimeout(() => { s.off(ev, h); res(); }, ms);
    s.on(ev, h);
  });
}
const ack = <T = any>(s: Socket, ev: string, payload: unknown = {}) => s.timeout(2000).emitWithAck(ev, payload) as Promise<T>;
const disconnected = (s: Socket, ms = 2000) => new Promise<void>((res, rej) => {
  if (s.disconnected) return res();
  const t = setTimeout(() => rej(new Error('disconnect timeout')), ms);
  s.once('disconnect', () => { clearTimeout(t); res(); });
});

async function register(username: string) {
  const r = await request(app).post('/api/auth/register').send({ username, password: 'password123' });
  expect(r.status).toBe(200);
  return { token: r.body.token as string, id: r.body.user.id as number, username };
}
async function createMeeting(token: string, title: string) {
  const r = await request(app).post('/api/meetings').set('Authorization', `Bearer ${token}`).send({ title });
  expect(r.status).toBe(200);
  return r.body.code as string;
}
async function joinMeeting(token: string, code: string) {
  const r = await request(app).post('/api/meetings/join').set('Authorization', `Bearer ${token}`).send({ code });
  expect(r.status).toBe(200);
}
const meetingId = (code: string) => (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;

/* ── 픽스처: host·guest·late 는 회의 A, outsider 는 회의 B ── */
let host: Awaited<ReturnType<typeof register>>;
let guest: typeof host;
let late: typeof host;
let outsider: typeof host;
let A = '';
let B = '';
let hs: Socket; // host socket (room A)
let gs: Socket; // guest socket (room A)
let os: Socket; // outsider socket (room B)

beforeAll(async () => {
  attachRealtime(app, server);
  await startMediasoup();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  host = await register('rt_host');
  guest = await register('rt_guest');
  late = await register('rt_late');
  outsider = await register('rt_outsider');
  A = await createMeeting(host.token, '실시간 A');
  B = await createMeeting(outsider.token, '실시간 B');
  await joinMeeting(guest.token, A);
  await joinMeeting(late.token, A);
}, 20_000);

afterAll(async () => {
  for (const s of opened) s.disconnect();
  cancelScheduledRecap(A);
  cancelScheduledRecap(B);
  await new Promise<void>((r) => getIo()!.close(() => r()));
});

describe('소켓 인증 · presence', () => {
  it('토큰 없음/무효 토큰은 connect_error(unauthorized)', async () => {
    await expect(open(mk(undefined))).rejects.toThrow('unauthorized');
    await expect(open(mk('not-a-real-token'))).rejects.toThrow('unauthorized');
  });

  it('유효 토큰 → 접속 + presence:update 에 내 아이디 · /api/presence 에도 반영', async () => {
    hs = mk(host.token);
    const presence = waitFor<{ users: string[] }>(hs, 'presence:update', (p) => p.users.includes('rt_host'));
    await open(hs);
    expect((await presence).users).toContain('rt_host');
    const r = await request(app).get('/api/presence');
    expect(r.body.users).toContain('rt_host');
  });

  it('dm:viewing 신고가 isViewingDm 에 반영된다', async () => {
    expect(isViewingDm(host.id, guest.id)).toBe(false);
    hs.emit('dm:viewing', { peerId: guest.id });
    await ack(hs, 'chat:join', { code: A }); // 순서 보장용 왕복
    expect(isViewingDm(host.id, guest.id)).toBe(true);
    hs.emit('dm:viewing', { peerId: null });
    await ack(hs, 'chat:join', { code: A });
    expect(isViewingDm(host.id, guest.id)).toBe(false);
  });
});

describe('room:join / peer 방송 / 다른 방 격리', () => {
  it('호스트 입장 — rtpCapabilities·peers·isHost 를 ack 로 받는다', async () => {
    const res = await ack(hs, 'room:join', { code: A });
    expect(res.error).toBeUndefined();
    expect(Array.isArray(res.rtpCapabilities.codecs)).toBe(true);
    expect(res.rtpCapabilities.codecs.length).toBeGreaterThan(0);
    expect(res.producers).toEqual([]);
    expect(res.peers).toEqual([{ peerId: hs.id, username: 'rt_host' }]);
    expect(res.isHost).toBe(true);
    expect(res.locked).toBe(false);
    expect(getRoomSize(A)).toBe(1);
    // 방이 생기면 통화 시작 시각이 찍힌다 (markCallStarted)
    const m = db.prepare('SELECT call_started_at FROM meetings WHERE code = ?').get(A) as { call_started_at: string | null };
    expect(m.call_started_at).toBeTruthy();
  });

  it('게스트 입장 — 기존 참가자에게 peer:joined, 참가자 홈에 call:presence, 다른 방은 조용', async () => {
    os = await connect(outsider.token);
    const resB = await ack(os, 'room:join', { code: B });
    expect(resB.isHost).toBe(true);

    gs = await connect(guest.token);
    const joined = waitFor<{ peerId: string; username: string }>(hs, 'peer:joined');
    const presence = waitFor<{ code: string; peers: string[] }>(hs, 'call:presence', (p) => p.peers.length === 2);
    const quiet = silence(os, 'peer:joined');
    const res = await ack(gs, 'room:join', { code: A });
    expect(res.isHost).toBe(false);
    expect(res.peers.map((p: { username: string }) => p.username).sort()).toEqual(['rt_guest', 'rt_host']);
    expect(await joined).toEqual({ peerId: gs.id, username: 'rt_guest' });
    expect((await presence).peers.sort()).toEqual(['rt_guest', 'rt_host']);
    await quiet;
    expect(getRoomSize(A)).toBe(2);
    expect(getRoomPeers(A).sort()).toEqual(['rt_guest', 'rt_host']);
    expect(getRoomSize(B)).toBe(1);
  });

  it('방에 없는 소켓의 시그널링 요청은 전부 거절된다', async () => {
    const lurker = await connect(late.token);
    expect(await ack(lurker, 'transport:create', { direction: 'send' })).toEqual({ error: '방에 입장하지 않았습니다' });
    expect(await ack(lurker, 'produce', {})).toEqual({ error: '방에 입장하지 않았습니다' });
    expect(await ack(lurker, 'consume', {})).toEqual({ error: '방에 입장하지 않았습니다' });
    expect(await ack(lurker, 'room:lock', { locked: true })).toEqual({ error: '방에 입장하지 않았습니다' });
    expect(await ack(lurker, 'room:kick', { peerId: 'x' })).toEqual({ error: '방에 입장하지 않았습니다' });
    expect(await ack(lurker, 'room:mute-all')).toEqual({ error: '방에 입장하지 않았습니다' });
    expect(await ack(lurker, 'stt:live-start')).toEqual({ error: '방에 입장하지 않았습니다' });
    expect(await ack(lurker, 'transport:connect', { transportId: 'x', dtlsParameters: {} })).toEqual({ error: 'transport 없음' });
    expect(await ack(lurker, 'producer:pause', { producerId: 'x' })).toEqual({ error: 'producer 없음' });
    expect(await ack(lurker, 'producer:resume', { producerId: 'x' })).toEqual({ error: 'producer 없음' });
    expect(await ack(lurker, 'producer:close', { producerId: 'x' })).toEqual({ error: 'producer 없음' });
    expect(await ack(lurker, 'consumer:resume', { consumerId: 'x' })).toEqual({ error: 'consumer 없음' });
    // 방에 없으면 자막/퇴장 이벤트는 무시(예외 없음) — 뒤이은 왕복이 정상이면 살아 있는 것
    lurker.emit('voice:transcript', { text: '이건 저장되면 안 됨' });
    lurker.emit('voice:interim', { text: 'x' });
    lurker.emit('stt:live-audio', Buffer.alloc(10));
    lurker.emit('stt:live-commit');
    lurker.emit('stt:live-stop');
    lurker.emit('room:leave');
    expect(await ack(lurker, 'chat:join', { code: A })).toEqual({ ok: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM call_transcripts WHERE user_id = ?').get(late.id) as { n: number }).n).toBe(0);
    lurker.disconnect();
  });

  it('입장한 피어는 WebRTC transport 를 만들 수 있다 (mediasoup 실제 라우터)', async () => {
    const t = await ack(hs, 'transport:create', { direction: 'send' });
    expect(t.error).toBeUndefined();
    expect(typeof t.id).toBe('string');
    expect(t.iceParameters.usernameFragment).toBeTruthy();
    expect(t.iceCandidates.length).toBeGreaterThan(0);
    expect(t.dtlsParameters.fingerprints.length).toBeGreaterThan(0);
    // 없는 producer 는 consume 불가
    const c = await ack(hs, 'consume', { transportId: t.id, producerId: 'nope', rtpCapabilities: { codecs: [], headerExtensions: [] } });
    expect(c.error).toMatch(/consume 불가/);
    const p = await ack(hs, 'produce', { transportId: 'nope', kind: 'audio', rtpParameters: {} });
    expect(p).toEqual({ error: 'transport 없음' });
  });
});

describe('자막 방송 (voice:transcript / voice:interim)', () => {
  it('확정 전사 — call_transcripts 저장 + 본인 포함 방 전원에게 voice:caption, 다른 방은 못 받는다', async () => {
    const toHost = waitFor<any>(hs, 'voice:caption');
    const toSelf = waitFor<any>(gs, 'voice:caption');
    const quiet = silence(os, 'voice:caption');
    gs.emit('voice:transcript', { text: '  방열판 두께는 3mm로 갑니다  ' });
    const [h, g] = await Promise.all([toHost, toSelf]);
    for (const c of [h, g]) {
      expect(c.peerId).toBe(gs.id);
      expect(c.username).toBe('rt_guest');
      expect(c.text).toBe('방열판 두께는 3mm로 갑니다');
      expect(c.interim).toBeUndefined();
      expect(typeof c.ts).toBe('number');
    }
    await quiet;
    const rows = db.prepare('SELECT user_id, text FROM call_transcripts WHERE meeting_id = ?').all(meetingId(A)) as { user_id: number; text: string }[];
    expect(rows).toEqual([{ user_id: guest.id, text: '방열판 두께는 3mm로 갑니다' }]);
  });

  it('빈 문자열은 무시, 500자 초과는 잘라서 저장', async () => {
    const quiet = silence(hs, 'voice:caption');
    gs.emit('voice:transcript', { text: '   ' });
    gs.emit('voice:transcript', {});
    await quiet;
    const cap = waitFor<any>(hs, 'voice:caption');
    gs.emit('voice:transcript', { text: 'a'.repeat(700) });
    expect((await cap).text.length).toBe(500);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM call_transcripts WHERE meeting_id = ?').get(meetingId(A)) as { n: number }).n;
    expect(n).toBe(2);
  });

  it('중간 전사 — interim:true 로 방송만 하고 저장하지 않는다', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM call_transcripts').get() as { n: number }).n;
    const cap = waitFor<any>(hs, 'voice:caption');
    gs.emit('voice:interim', { text: '검사 설비 온도' });
    const c = await cap;
    expect(c).toMatchObject({ peerId: gs.id, username: 'rt_guest', text: '검사 설비 온도', interim: true });
    const after = (db.prepare('SELECT COUNT(*) AS n FROM call_transcripts').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('스트리밍 자막은 키가 없으면 unavailable', async () => {
    expect(await ack(gs, 'stt:live-start')).toEqual({ error: 'unavailable' });
  });
});

describe('채팅 (chat:join / chat:send)', () => {
  it('없는 회의 코드는 chat:join 거절', async () => {
    expect(await ack(gs, 'chat:join', { code: 'ZZZZZZ' })).toEqual({ error: '존재하지 않는 회의입니다' });
  });

  it('메시지 저장 + chat:CODE 룸 방송 (다른 방 구독자는 못 받음)', async () => {
    expect(await ack(hs, 'chat:join', { code: A })).toEqual({ ok: true });
    expect(await ack(gs, 'chat:join', { code: A.toLowerCase() })).toEqual({ ok: true }); // 소문자도 대문자 룸으로
    expect(await ack(os, 'chat:join', { code: B })).toEqual({ ok: true });
    const toHost = waitFor<any>(hs, 'chat:message');
    const toSelf = waitFor<any>(gs, 'chat:message');
    const quiet = silence(os, 'chat:message');
    gs.emit('chat:send', { code: A, text: '오늘 TBM 정리합니다' });
    const [h, g] = await Promise.all([toHost, toSelf]);
    expect(h).toMatchObject({ code: A, from: 'rt_guest', text: '오늘 TBM 정리합니다' });
    expect(typeof h.channelId).toBe('number');
    expect(g.text).toBe(h.text);
    await quiet;
    const row = db.prepare('SELECT user_id, text, channel_id FROM messages WHERE meeting_id = ? ORDER BY id DESC LIMIT 1').get(meetingId(A)) as any;
    expect(row).toMatchObject({ user_id: guest.id, text: '오늘 TBM 정리합니다', channel_id: h.channelId });
  });

  it('빈 메시지·없는 코드는 무시, 외부 URL 파일은 떼고 서버 업로드 경로만 붙인다', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    const quiet = silence(hs, 'chat:message');
    gs.emit('chat:send', { code: A, text: '   ' });
    gs.emit('chat:send', { code: 'ZZZZZZ', text: 'x' });
    gs.emit('chat:send', { text: 'x' });
    // 외부 URL 파일 + 빈 텍스트 → 파일이 걸러지면 빈 메시지를 남기지 않는다
    gs.emit('chat:send', { code: A, text: '', file: { name: '외부', url: 'https://evil.example/x', size: 1 } });
    await quiet;
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(before);
    const m1 = waitFor<any>(hs, 'chat:message');
    gs.emit('chat:send', { code: A, text: '본문 있음', file: { name: '외부', url: 'https://evil.example/x', size: 1 } });
    const got = await m1;
    expect(got.text).toBe('본문 있음');
    expect(got.file).toBeUndefined();
    const m2 = waitFor<any>(hs, 'chat:message');
    gs.emit('chat:send', { code: A, text: '도면', file: { name: 'a.pdf', url: '/uploads/a.pdf', size: 10 } });
    expect((await m2).file).toEqual({ name: 'a.pdf', url: '/uploads/a.pdf', size: 10 });
  });

  it('@아이디 멘션은 채팅 화면을 안 보는 참가자에게 agent:notify(kind=chat) 로 전달', async () => {
    const noti = waitFor<any>(hs, 'agent:notify', (n) => n.kind === 'chat');
    gs.emit('chat:send', { code: A, text: '@rt_host 설비 점검 결과 확인 부탁' });
    const n = await noti;
    expect(n.from).toBe('rt_guest');
    expect(n.text).toContain('멘션');
    expect(n.meeting?.code).toBe(A);
    // 보고 있다고 신고하면(chat:viewing) 같은 멘션도 알림이 안 온다
    hs.emit('chat:viewing', { code: A });
    await ack(hs, 'chat:join', { code: A });
    const quiet = silence(hs, 'agent:notify');
    gs.emit('chat:send', { code: A, text: '@rt_host 한 번 더' });
    await quiet;
    hs.emit('chat:viewing', { code: null });
  });

  it('@AI 멘션 — 키 없이도 규칙 폴백으로 총무가 답한다 (ai-thinking → chat:message)', async () => {
    const thinking = waitFor<any>(hs, 'chat:ai-thinking');
    const answer = waitFor<any>(hs, 'chat:message', (m) => m.from === 'exist AI', 4000);
    gs.emit('chat:send', { code: A, text: '@AI 지금까지 결정된 거 정리해줘' });
    expect((await thinking).code).toBe(A);
    const a = await answer;
    expect(a.text.length).toBeGreaterThan(0);
    expect(a.code).toBe(A);
  });
});

describe('호스트 권한 게이트 (lock / mute-all / kick)', () => {
  it('room:lock — 게스트는 거절, 호스트는 방 전원에게 room:locked, 잠긴 방은 입장 거절', async () => {
    expect(await ack(gs, 'room:lock', { locked: true })).toEqual({ error: '잠금 권한이 없습니다' });
    const l1 = waitFor<any>(gs, 'room:locked');
    expect(await ack(hs, 'room:lock', { locked: true })).toEqual({ ok: true });
    expect(await l1).toEqual({ locked: true });

    const ls = await connect(late.token);
    const rej = await ack(ls, 'room:join', { code: A });
    expect(rej.error).toMatch(/잠갔/);
    expect(getRoomSize(A)).toBe(2);
    // 잠금 거절된 소켓은 방 상태가 없으니 이후 요청도 "미입장"
    expect(await ack(ls, 'room:mute-all')).toEqual({ error: '방에 입장하지 않았습니다' });

    const l2 = waitFor<any>(gs, 'room:locked');
    expect(await ack(hs, 'room:lock', { locked: false })).toEqual({ ok: true });
    expect(await l2).toEqual({ locked: false });
    const joined = waitFor<any>(hs, 'peer:joined');
    const ok = await ack(ls, 'room:join', { code: A });
    expect(ok.error).toBeUndefined();
    expect(ok.peers.length).toBe(3);
    expect((await joined).username).toBe('rt_late');
    // 클라 disconnect() 는 socket.id 를 지우므로 비교용 id 는 미리 잡아둔다
    const lsId = ls.id;
    const left = waitFor<any>(hs, 'peer:left', (p) => p.peerId === lsId);
    ls.disconnect();
    await left;
    expect(getRoomSize(A)).toBe(2);
  });

  it('room:mute-all — 게스트 거절, 호스트 요청은 본인 제외 전원에게 room:muted-by-host', async () => {
    expect(await ack(gs, 'room:mute-all')).toEqual({ error: '전체 음소거 권한이 없습니다' });
    const toGuest = waitFor<any>(gs, 'room:muted-by-host');
    const notSelf = silence(hs, 'room:muted-by-host');
    expect(await ack(hs, 'room:mute-all')).toEqual({ ok: true });
    expect(await toGuest).toEqual({ by: 'rt_host' });
    await notSelf;
  });

  it('room:kick — 게스트 거절, 호스트 강퇴 시 대상은 room:kicked+끊김, 나머지는 peer:left, 재입장 차단', async () => {
    const ls = await connect(late.token);
    const joined = waitFor<any>(hs, 'peer:joined', (p) => p.username === 'rt_late');
    await ack(ls, 'room:join', { code: A });
    const lsId = ls.id;
    expect((await joined).peerId).toBe(lsId);
    expect(getRoomSize(A)).toBe(3);

    expect(await ack(gs, 'room:kick', { peerId: lsId })).toEqual({ error: '강퇴 권한이 없습니다' });
    expect(await ack(hs, 'room:kick', { peerId: 'ghost' })).toEqual({ error: '대상이 없습니다' });

    const kicked = waitFor(ls, 'room:kicked');
    const leftH = waitFor<any>(hs, 'peer:left', (p) => p.peerId === lsId);
    const leftG = waitFor<any>(gs, 'peer:left', (p) => p.peerId === lsId);
    expect(await ack(hs, 'room:kick', { peerId: lsId })).toEqual({ ok: true });
    await kicked;
    await disconnected(ls);
    await Promise.all([leftH, leftG]);
    expect(getRoomSize(A)).toBe(2);

    // 방이 살아 있는 동안 같은 사용자는 다시 못 들어온다
    const ls2 = await connect(late.token);
    const again = await ack(ls2, 'room:join', { code: A });
    expect(again.error).toMatch(/내보낸/);
    expect(getRoomSize(A)).toBe(2);
    ls2.disconnect();
  });
});

describe('파일 열람 presence', () => {
  it('file:viewing → 참가자 소켓에 files:presence, 끊기면 다시 핑', async () => {
    const ping = waitFor<any>(hs, 'files:presence');
    gs.emit('file:viewing', { code: A, fileId: null });
    expect(await ping).toEqual({ code: A });
    // 비참가자(outsider)의 신고는 무시
    const quiet = silence(hs, 'files:presence');
    os.emit('file:viewing', { code: A, fileId: 1 });
    os.emit('file:viewing', { code: 'ZZZZZZ' });
    await quiet;
  });
});

describe('퇴장 · 끊김 · 방 종료', () => {
  it('room:leave — 소켓은 유지한 채 방만 나가고 peer:left, 이후 전사는 무시', async () => {
    const left = waitFor<any>(hs, 'peer:left');
    const presence = waitFor<any>(hs, 'call:presence', (p) => p.code === A && p.peers.length === 1);
    gs.emit('room:leave');
    expect(await left).toEqual({ peerId: gs.id });
    expect((await presence).peers).toEqual(['rt_host']);
    expect(getRoomSize(A)).toBe(1);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM call_transcripts').get() as { n: number }).n;
    const quiet = silence(hs, 'voice:caption');
    gs.emit('voice:transcript', { text: '방 나간 뒤 발언' });
    await quiet;
    expect((db.prepare('SELECT COUNT(*) AS n FROM call_transcripts').get() as { n: number }).n).toBe(before);
    expect(gs.connected).toBe(true);
  });

  it('마지막 사람이 끊기면 방이 닫히고 recap 유예가 걸린다(recap:status generating) · presence 갱신 · last_seen_at 기록', async () => {
    const status = waitFor<any>(gs, 'recap:status', (s) => s.code === A);
    const presence = waitFor<{ users: string[] }>(gs, 'presence:update', (p) => !p.users.includes('rt_host'));
    const disc = disconnected(hs);
    hs.disconnect();
    await disc;
    expect(await status).toEqual({ code: A, state: 'generating' });
    expect(getRoomSize(A)).toBe(0);
    await presence;
    const u = db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(host.id) as { last_seen_at: string | null };
    expect(u.last_seen_at).toBeTruthy();
  });

  it('유예 중 재입장하면 예약이 취소된다(recap:status cleared) — 같은 세션으로 이어붙임', async () => {
    const cleared = waitFor<any>(gs, 'recap:status', (s) => s.code === A && s.state === 'cleared');
    const res = await ack(gs, 'room:join', { code: A });
    expect(res.error).toBeUndefined();
    await cleared;
    expect(getRoomSize(A)).toBe(1);
    // 강퇴 목록은 방이 닫힐 때 초기화 — late 가 다시 들어올 수 있다
    const ls = await connect(late.token);
    const ok = await ack(ls, 'room:join', { code: A });
    expect(ok.error).toBeUndefined();
    const lsId = ls.id;
    const left = waitFor<any>(gs, 'peer:left', (p) => p.peerId === lsId);
    ls.disconnect();
    await left;
    expect(getRoomSize(A)).toBe(1);
  });
});
