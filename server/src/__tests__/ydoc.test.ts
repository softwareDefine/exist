import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import db from '../db.js';
import { initNotifier } from '../notify.js';
import {
  attachYjs,
  logFileActivity,
  setOnDocSaved,
  ydocExists,
  ydocSize,
  copyYdoc,
  readYdocSnapshot,
  roomPresence,
  writeYdoc,
  deleteYdoc,
} from '../ydoc.js';

/* Yjs 공동편집 백엔드 — 진짜 ws 클라이언트로 y-websocket 호환 프로토콜(sync step1/2·update·awareness)을
 * 직접 말해 업그레이드 인증 · 룸 격리 · 동기화 · 프레즌스 · 디바운스 저장(.bin) · 회의↔문서 다리를 확인한다. */

const YDOCS_DIR = path.join(process.env.DATA_DIR!, 'ydocs');
const binPath = (room: string) => path.join(YDOCS_DIR, `${room.replace(/[^\w-]/g, '_')}.bin`);

/** 최소 y-websocket 클라이언트 */
class Client {
  doc = new Y.Doc();
  awareness = new awarenessProtocol.Awareness(this.doc);
  ws: WebSocket;
  synced = false;
  opened = false;
  closed = false;
  errors: Error[] = [];
  awarenessMsgs = 0;

  constructor(url: string) {
    this.awareness.setLocalState(null);
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('error', (e) => this.errors.push(e));
    this.ws.on('close', () => (this.closed = true));
    this.ws.on('open', () => {
      this.opened = true;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.ws.send(encoding.toUint8Array(enc));
    });
    this.ws.on('message', (data) => {
      const bytes = new Uint8Array(data as ArrayBuffer);
      const dec = decoding.createDecoder(bytes);
      const enc = encoding.createEncoder();
      const type = decoding.readVarUint(dec);
      if (type === 0) {
        encoding.writeVarUint(enc, 0);
        const sub = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
        if (sub === syncProtocol.messageYjsSyncStep2) this.synced = true;
        if (encoding.length(enc) > 1) this.ws.send(encoding.toUint8Array(enc));
      } else if (type === 1) {
        this.awarenessMsgs++;
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
      }
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, update);
      this.ws.send(encoding.toUint8Array(enc));
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== 'local') return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 1);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, added.concat(updated, removed)));
      this.ws.send(encoding.toUint8Array(enc));
    });
  }
  text() {
    return this.doc.getText('t').toString();
  }
  close() {
    this.ws.close();
  }
}

const server = http.createServer();
const rawSockets = new Set<import('node:net').Socket>();
server.on('connection', (s) => {
  rawSockets.add(s);
  s.on('close', () => rawSockets.delete(s));
});
let base = '';
let token = '';
let userId = 0;
let meetingId = 0;
let fileId = 0;
let fileRoom = '';
const clients: Client[] = [];
const emitted: { userId: number; event: string; payload: unknown }[] = [];
const savedRooms: string[] = [];

function connect(room: string, tok: string | null = token): Client {
  const q = tok === null ? '' : `?token=${encodeURIComponent(tok)}`;
  const c = new Client(`${base}/yjs/${encodeURIComponent(room)}${q}`);
  clients.push(c);
  return c;
}
const until = (pred: () => boolean, ms = 3000) => vi.waitFor(() => expect(pred()).toBe(true), { timeout: ms, interval: 15 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  attachYjs(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

  userId = db.prepare("INSERT INTO users (username, pw_hash, pw_salt) VALUES ('yj_user', 'x', 'x')").run().lastInsertRowid as number;
  token = 'yj-session-token';
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  meetingId = db.prepare("INSERT INTO meetings (code, title, host_id) VALUES ('YJROOM', 'Yjs 회의', ?)").run(userId).lastInsertRowid as number;
  db.prepare('INSERT INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)').run(meetingId, userId);
  fileId = db
    .prepare("INSERT INTO collab_files (meeting_id, name, type, room, created_by) VALUES (?, '설계.md', 'doc', 'pending', ?)")
    .run(meetingId, userId).lastInsertRowid as number;
  fileRoom = `file-${fileId}`;
  db.prepare('UPDATE collab_files SET room = ? WHERE id = ?').run(fileRoom, fileId);

  // emitToUser 가 실제 socket.io 없이도 관측되게 — 소켓 맵 모양만 흉내
  const fakeIo = {
    sockets: {
      sockets: new Map([
        ['s1', { data: { userId }, emit: (event: string, payload: unknown) => emitted.push({ userId, event, payload }) }],
      ]),
    },
  };
  initNotifier(fakeIo as never);
  setOnDocSaved((room) => savedRooms.push(room));
});

afterAll(async () => {
  for (const c of clients) c.ws.terminate();
  for (const room of [fileRoom, 'other', 'seeded', 'corrupt', 'pingroom', 'delroom']) deleteYdoc(room);
  for (const s of rawSockets) s.destroy(); // 업그레이드된(또는 응답 없이 매달린) 소켓은 server.close 가 기다리지 않게
  await new Promise<void>((r) => server.close(() => r()));
});

describe('업그레이드 인증', () => {
  it('토큰 없음 · 잘못된 토큰 → 401', async () => {
    const a = connect('roomA', null);
    const b = connect('roomA', 'not-a-token');
    await until(() => a.closed && b.closed);
    expect(a.opened).toBe(false);
    expect(a.errors[0]?.message).toMatch(/401/);
    expect(b.errors[0]?.message).toMatch(/401/);
  });

  it('룸 이름이 비면 소켓을 끊는다', async () => {
    const c = connect('');
    await until(() => c.closed);
    expect(c.opened).toBe(false);
    expect(c.errors.length).toBeGreaterThan(0);
  });

  it('/yjs/ 밖의 경로는 건드리지 않는다 (socket.io 등 다른 핸들러 몫)', async () => {
    const ws = new WebSocket(`${base}/socket.io/?token=${token}`);
    let opened = false;
    ws.on('open', () => (opened = true));
    ws.on('error', () => {});
    await sleep(250);
    expect(opened).toBe(false);
    expect(ws.readyState).toBe(WebSocket.CONNECTING);
    ws.terminate();
  });
});

describe('동기화 · 룸 격리 · 프레즌스', () => {
  let a: Client;
  let b: Client;
  let other: Client;

  it('첫 접속은 서버 step1 ↔ 클라 step2 로 맞물리고, 파일 룸 열람이 file_activity 에 남는다', async () => {
    a = connect(fileRoom);
    await until(() => a.synced);
    expect(a.text()).toBe('');
    const acts = db.prepare('SELECT file_id FROM file_activity WHERE meeting_id = ?').all(meetingId) as { file_id: number }[];
    expect(acts).toEqual([{ file_id: fileId }]);
    expect(console.log).toHaveBeenCalledWith(`[yjs] doc opened: ${fileRoom}`);
  });

  it('A 의 편집이 늦게 들어온 B 에 전달되고, B 의 편집이 A 로 돌아온다 · 다른 룸은 조용', async () => {
    a.doc.getText('t').insert(0, '방열판 두께 ');
    b = connect(fileRoom);
    other = connect('other');
    await until(() => b.synced && other.synced);
    await until(() => b.text() === '방열판 두께 ');
    b.doc.getText('t').insert(b.text().length, '3mm');
    await until(() => a.text() === '방열판 두께 3mm');
    expect(other.text()).toBe('');
    // 3분 스로틀 — 같은 룸의 추가 메시지는 activity 를 더 쌓지 않는다
    expect((db.prepare('SELECT COUNT(*) AS n FROM file_activity').get() as { n: number }).n).toBe(1);
  });

  it('awareness: A 의 사용자 상태가 B 에 도착하고 roomPresence · files:presence 핑(300ms 디바운스)에 반영', async () => {
    a.awareness.setLocalState({ user: { name: 'A', color: '#f00' } });
    await until(() => [...b.awareness.getStates().values()].some((s) => (s as { user?: { name: string } }).user?.name === 'A'));
    expect(roomPresence(fileRoom)).toEqual([{ name: 'A', color: '#f00' }]);
    expect(roomPresence('other')).toEqual([]);
    expect(roomPresence('never-opened')).toEqual([]);
    await until(() => emitted.some((e) => e.event === 'files:presence'));
    expect(emitted.find((e) => e.event === 'files:presence')).toEqual({ userId, event: 'files:presence', payload: { code: 'YJROOM' } });
    // 커서 이동(updated)만으로는 핑이 늘지 않는다
    const before = emitted.length;
    a.awareness.setLocalState({ user: { name: 'A', color: '#f00' }, cursor: 3 });
    await sleep(400);
    expect(emitted.length).toBe(before);
  });

  it('늦게 들어온 클라이언트는 현재 awareness 상태를 바로 받는다', async () => {
    const late = connect(fileRoom);
    await until(() => late.synced && late.awarenessMsgs > 0);
    expect([...late.awareness.getStates().values()].some((s) => (s as { user?: { name: string } }).user?.name === 'A')).toBe(true);
    late.close();
    await until(() => late.closed);
  });

  it('깨진 sync 메시지는 로그만 남기고 연결은 유지된다', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    a.ws.send(new Uint8Array([0, 9]));
    a.ws.send(new Uint8Array([7]));
    await until(() => err.mock.calls.some((c) => c[0] === '[yjs] message error'));
    a.doc.getText('t').insert(0, '>');
    await until(() => b.text().startsWith('>'));
    err.mockRestore();
  });

  it('접속 종료 시 그 클라이언트의 awareness 가 제거된다', async () => {
    b.awareness.setLocalState({ user: { name: 'B' } });
    await until(() => roomPresence(fileRoom).some((p) => p.name === 'B'));
    b.close();
    await until(() => b.closed && !roomPresence(fileRoom).some((p) => p.name === 'B'));
    expect(roomPresence(fileRoom)).toEqual([{ name: 'A', color: '#f00' }]);
  });

  it('1.5초 디바운스 저장 — .bin 파일 · collab_files.updated_at · onDocSaved 훅', async () => {
    await until(() => fs.existsSync(binPath(fileRoom)), 4000);
    await until(() => savedRooms.includes(fileRoom), 2000);
    const row = db.prepare('SELECT updated_at FROM collab_files WHERE id = ?').get(fileId) as { updated_at: string | null };
    expect(row.updated_at).toBeTruthy();
    const snap = readYdocSnapshot(fileRoom)!;
    expect(snap.getText('t').toString()).toBe('>방열판 두께 3mm');
    expect(ydocExists(fileRoom)).toBe(true);
    expect(ydocSize(fileRoom)!).toBeGreaterThan(0);
  });

  it('25초 ping 에 pong 이 없으면 끊는다', async () => {
    const realSetInterval = globalThis.setInterval;
    const cbs: (() => void)[] = [];
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 25000) {
        cbs.push(fn);
        return { ref() {}, unref() {}, hasRef: () => true, refresh() {} } as unknown as NodeJS.Timeout;
      }
      return realSetInterval(fn, ms, ...rest);
    }) as typeof setInterval);
    const p = connect('pingroom');
    await until(() => p.synced && cbs.length === 1);
    spy.mockRestore();
    cbs[0](); // alive → false, ping 전송
    cbs[0](); // pong 이 아직 안 왔으니 끊김
    await until(() => p.closed);
  });
});

describe('영속 상태 유틸', () => {
  it('writeYdoc 으로 심은 상태를 새 접속이 그대로 받는다 (디스크 로드)', async () => {
    writeYdoc('seeded', (doc) => doc.getText('t').insert(0, 'seed'));
    expect(ydocExists('seeded')).toBe(true);
    expect(ydocSize('seeded')).toBe(fs.statSync(binPath('seeded')).size);
    expect(readYdocSnapshot('seeded')!.getText('t').toString()).toBe('seed');
    const c = connect('seeded');
    await until(() => c.synced && c.text() === 'seed');
    expect(ydocSize('seeded')!).toBeGreaterThan(0); // 열린 문서는 메모리 상태 크기
  });

  it('깨진 .bin 은 버리고 빈 문서로 시작한다', async () => {
    fs.writeFileSync(binPath('corrupt'), Buffer.from([0x05, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x01, 0x02]));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = connect('corrupt');
    await until(() => c.synced);
    expect(c.text()).toBe('');
    expect(err).toHaveBeenCalledWith('[yjs] 상태 파싱 실패, 새로 시작: corrupt');
    err.mockRestore();
    expect(readYdocSnapshot('corrupt')!.getText('t').toString()).toBe('');
  });

  it('copyYdoc — 열린 문서는 메모리에서, 닫힌 문서는 .bin 복사, 없으면 무시', () => {
    copyYdoc('seeded', 'copy-open');
    expect(readYdocSnapshot('copy-open')!.getText('t').toString()).toBe('seed');
    copyYdoc('copy-open', 'copy-file');
    expect(fs.readFileSync(binPath('copy-file'))).toEqual(fs.readFileSync(binPath('copy-open')));
    copyYdoc('never-existed', 'copy-none');
    expect(fs.existsSync(binPath('copy-none'))).toBe(false);
    expect(ydocExists('never-existed')).toBe(false);
    expect(ydocSize('never-existed')).toBeNull();
    expect(readYdocSnapshot('never-existed')).toBeNull();
    // 이름 정규화 — 경로 문자는 _ 로
    writeYdoc('a/b c', () => {});
    expect(fs.existsSync(path.join(YDOCS_DIR, 'a_b_c.bin'))).toBe(true);
    deleteYdoc('copy-open');
    deleteYdoc('copy-file');
    deleteYdoc('a/b c');
    expect(fs.existsSync(binPath('copy-open'))).toBe(false);
  });

  it('deleteYdoc — 접속을 끊고 메모리·.bin 을 지운다, 없는 룸은 무시', async () => {
    const c = connect('delroom');
    await until(() => c.synced);
    c.doc.getText('t').insert(0, 'x');
    await until(() => fs.existsSync(binPath('delroom')), 4000);
    deleteYdoc('delroom');
    await until(() => c.closed);
    expect(fs.existsSync(binPath('delroom'))).toBe(false);
    expect(ydocExists('delroom')).toBe(false);
    expect(roomPresence('delroom')).toEqual([]);
    expect(() => deleteYdoc('delroom')).not.toThrow();
  });
});

describe('logFileActivity', () => {
  it('file-N 룸만, 존재하는 파일만, 룸당 3분 스로틀', () => {
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM file_activity').get() as { n: number }).n;
    const before = count();
    logFileActivity('chat-1');
    logFileActivity('file-abc');
    logFileActivity('file-999999');
    expect(count()).toBe(before);
    const f2 = db
      .prepare("INSERT INTO collab_files (meeting_id, name, type, room, created_by) VALUES (?, '두번째', 'doc', 'file-x', ?)")
      .run(meetingId, userId).lastInsertRowid as number;
    logFileActivity(`file-${f2}`);
    logFileActivity(`file-${f2}`);
    expect(count()).toBe(before + 1);
    // 삭제된 파일은 기록하지 않는다
    const f3 = db
      .prepare("INSERT INTO collab_files (meeting_id, name, type, room, created_by, deleted_at) VALUES (?, '지움', 'doc', 'file-y', ?, datetime('now'))")
      .run(meetingId, userId).lastInsertRowid as number;
    logFileActivity(`file-${f3}`);
    expect(count()).toBe(before + 1);
  });
});
