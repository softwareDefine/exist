import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as ioc, type Socket } from 'socket.io-client';
import { createApp } from '../app.js';
import { attachRealtime } from '../realtime.js';
import { getIo } from '../notify.js';
import db from '../db.js';

/* 출근 브리핑 — 마지막 접속(last_seen_at)에서 4시간+ 지나 돌아온 사용자에게 2.5초 뒤
 * 밀린 미확인 결정·인수인계를 한 번에 알린다. 타임스탬프를 과거로 심어 실제 타이머로 확인. */

const app = createApp();
const server = http.createServer(app);
let url = '';
const opened: Socket[] = [];

function connect(token: string): Promise<Socket> {
  const s = ioc(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  opened.push(s);
  return new Promise((res, rej) => {
    s.once('connect', () => res(s));
    s.once('connect_error', rej);
  });
}
function waitFor<T = any>(s: Socket, ev: string, pred: (p: T) => boolean = () => true, ms = 4000): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout waiting '${ev}'`)); }, ms);
    const h = (p: T) => { if (!pred(p)) return; clearTimeout(t); s.off(ev, h); res(p); };
    s.on(ev, h);
  });
}
function silence(s: Socket, ev: string, ms: number): Promise<void> {
  return new Promise((res, rej) => {
    const h = (p: unknown) => { clearTimeout(t); s.off(ev, h); rej(new Error(`unexpected '${ev}': ${JSON.stringify(p)}`)); };
    const t = setTimeout(() => { s.off(ev, h); res(); }, ms);
    s.on(ev, h);
  });
}
async function register(username: string) {
  const r = await request(app).post('/api/auth/register').send({ username, password: 'password123' });
  expect(r.status).toBe(200);
  return { token: r.body.token as string, id: r.body.user.id as number };
}
const awayFor = (userId: number, hours: number) =>
  db.prepare(`UPDATE users SET last_seen_at = datetime('now', ?) WHERE id = ?`).run(`-${hours} hours`, userId);

let worker: Awaited<ReturnType<typeof register>>; // 밀린 게 있는 교대 복귀자
let author: typeof worker; // 인수인계 작성자 — 오래 비웠지만 밀린 게 없음
let fresh: typeof worker; // 처음 접속(last_seen_at NULL)
let meetingId = 0;
let code = '';

beforeAll(async () => {
  attachRealtime(app, server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  worker = await register('brief_worker');
  author = await register('brief_author');
  fresh = await register('brief_fresh');
  const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${worker.token}`).send({ title: '야간조' });
  code = m.body.code as string;
  meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;

  // 결정 3건 중 1건 서명 → 미확인 2건 / 구형(JSON 아님) recap 과 결정 없는 recap 은 건너뜀 / 4일 전 recap 은 창 밖
  const recap = db
    .prepare("INSERT INTO meeting_recaps (meeting_id, summary, decisions) VALUES (?, '요약', ?)")
    .run(meetingId, JSON.stringify(['A', 'B', 'C'])).lastInsertRowid as number;
  db.prepare('INSERT INTO decision_acks (recap_id, decision_idx, user_id) VALUES (?, 0, ?)').run(recap, worker.id);
  db.prepare("INSERT INTO meeting_recaps (meeting_id, summary, decisions) VALUES (?, '구형', 'not-json')").run(meetingId);
  db.prepare("INSERT INTO meeting_recaps (meeting_id, summary, decisions) VALUES (?, '빈', '[]')").run(meetingId);
  db.prepare("INSERT INTO meeting_recaps (meeting_id, summary, decisions, created_at) VALUES (?, '옛날', '[\"Z\"]', datetime('now', '-4 days'))").run(meetingId);
  // 다른 사람이 쓴 인수인계 1건 미서명 + 내가 쓴 건 제외 + 이미 서명한 건 제외
  db.prepare("INSERT INTO handovers (meeting_id, author_id, sections) VALUES (?, ?, '{}')").run(meetingId, author.id);
  db.prepare("INSERT INTO handovers (meeting_id, author_id, sections) VALUES (?, ?, '{}')").run(meetingId, worker.id);
  const acked = db.prepare("INSERT INTO handovers (meeting_id, author_id, sections) VALUES (?, ?, '{}')").run(meetingId, author.id).lastInsertRowid;
  db.prepare('INSERT INTO handover_acks (handover_id, user_id) VALUES (?, ?)').run(acked, worker.id);
  awayFor(worker.id, 5);
  awayFor(author.id, 6);
}, 20_000);

afterAll(async () => {
  for (const s of opened) s.disconnect();
  await new Promise<void>((r) => getIo()!.close(() => r()));
});

describe('출근 브리핑 (4시간+ 부재 복귀)', () => {
  it('밀린 결정·인수인계가 있으면 2.5초 뒤 agent:notify(kind=recap) 한 번 · 없는 사람은 조용', async () => {
    const ws = await connect(worker.token);
    const as = await connect(author.token);
    const fs = await connect(fresh.token);
    const brief = waitFor<any>(ws, 'agent:notify', (n) => /출근 브리핑/.test(n.text));
    const [n] = await Promise.all([brief, silence(as, 'agent:notify', 2900), silence(fs, 'agent:notify', 2900)]);
    expect(n.kind).toBe('recap');
    expect(n.from).toBe('exist AI');
    expect(n.text).toBe('출근 브리핑 — 자리 비운 사이 미확인 결정 2건 · 인수인계 1건이 기다리고 있어요. 작업 전에 확인해 주세요.');
    const rows = db.prepare("SELECT text FROM notifications WHERE user_id = ? AND text LIKE '출근 브리핑%'").all(worker.id);
    expect(rows.length).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id IN (?, ?) AND text LIKE '출근 브리핑%'").get(author.id, fresh.id)).toEqual({ n: 0 });
  }, 10_000);

  it('4시간 안에 다시 들어오면(재접속) 브리핑을 반복하지 않는다', async () => {
    awayFor(worker.id, 7); // 부재 조건은 다시 충족시켜도 welcomedAt 가드에 걸린다
    const ws2 = await connect(worker.token);
    await silence(ws2, 'agent:notify', 2900);
    expect((db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND text LIKE '출근 브리핑%'").get(worker.id) as { n: number }).n).toBe(1);
  }, 10_000);
});

describe('탭 가시성 · 미리보기 열람 정리', () => {
  it('presence:visible 신호를 받고, file:viewing 중이던 소켓이 끊기면 참가자에게 files:presence 를 다시 핑한다', async () => {
    const viewer = await connect(worker.token);
    const watcher = await connect(worker.token); // 같은 사용자의 다른 탭 — 핑 수신자
    viewer.emit('presence:visible', { visible: false });
    viewer.emit('presence:visible', {});
    const ping1 = waitFor<any>(watcher, 'files:presence');
    viewer.emit('file:viewing', { code, fileId: 7 });
    expect(await ping1).toEqual({ code });
    const ping2 = waitFor<any>(watcher, 'files:presence');
    viewer.disconnect();
    expect(await ping2).toEqual({ code });
  });
});
