import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { TLSocketRoom } from '@tldraw/sync-core';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import db from './db.js';

/*
 * tldraw 작업공간 동시편집 백엔드.
 * /sync?roomId=ws-<id>&token=<세션토큰> 으로 WebSocket 연결.
 * 룸 스냅샷은 server/rooms/<roomId>.json 에 디바운스 저장.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOMS_DIR = path.join(__dirname, '..', 'rooms');
fs.mkdirSync(ROOMS_DIR, { recursive: true });

interface RoomEntry {
  room: TLSocketRoom;
  saveTimer: NodeJS.Timeout | null;
}

const rooms = new Map<string, RoomEntry>();

function snapshotPath(roomId: string): string {
  return path.join(ROOMS_DIR, `${roomId.replace(/[^\w-]/g, '_')}.json`);
}

function getOrCreateRoom(roomId: string): RoomEntry {
  let entry = rooms.get(roomId);
  if (entry) return entry;

  let initialSnapshot;
  const file = snapshotPath(roomId);
  if (fs.existsSync(file)) {
    try {
      initialSnapshot = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      console.error(`[sync] 스냅샷 파싱 실패, 새로 시작: ${roomId}`);
    }
  }

  const room = new TLSocketRoom({
    initialSnapshot,
    onDataChange() {
      // 2초 디바운스 저장
      const e = rooms.get(roomId);
      if (!e) return;
      if (e.saveTimer) clearTimeout(e.saveTimer);
      e.saveTimer = setTimeout(() => {
        fs.writeFileSync(file, JSON.stringify(room.getCurrentSnapshot()));
      }, 2000);
    },
  });

  entry = { room, saveTimer: null };
  rooms.set(roomId, entry);
  console.log(`[sync] room opened: ${roomId}`);
  return entry;
}

function validateToken(token: string | null): boolean {
  if (!token) return false;
  return !!db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
}

export function attachSync(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (!url.pathname.startsWith('/sync')) return; // Socket.IO 등 다른 경로는 무시

    const roomId = url.searchParams.get('roomId');
    const token = url.searchParams.get('token');
    if (!roomId || !validateToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const { room } = getOrCreateRoom(roomId);
      room.handleSocketConnect({
        sessionId: crypto.randomUUID(),
        socket: ws,
      });
    });
  });

  // 종료 시 모든 룸 스냅샷 강제 저장
  process.on('SIGINT', () => {
    for (const [roomId, entry] of rooms) {
      try {
        fs.writeFileSync(
          snapshotPath(roomId),
          JSON.stringify(entry.room.getCurrentSnapshot()),
        );
      } catch {
        /* best effort */
      }
    }
    process.exit(0);
  });
}
