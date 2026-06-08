import type { Server } from 'socket.io';
import db from './db.js';

/*
 * 특정 사용자에게 알림 — DB에 영속 저장(알림함) + 접속 중이면 실시간 푸시(토스트).
 * io는 index.ts에서 주입. 오프라인 사용자도 로그인하면 알림함에서 확인 가능.
 */
let io: Server | null = null;

export function initNotifier(server: Server) {
  io = server;
}

export interface NotifyPayload {
  from: string;
  text: string;
  /** 클라가 받아 후처리(예: 조직 목록 새로고침)하도록 하는 신호 */
  kind?: 'org-approved' | 'org-request';
}

/** userId에게 알림 — DB 저장 후 접속 소켓에 푸시(저장된 id·시각 포함) */
export function notifyUser(userId: number, payload: NotifyPayload) {
  const info = db
    .prepare('INSERT INTO notifications (user_id, from_name, text, kind) VALUES (?, ?, ?, ?)')
    .run(userId, payload.from, payload.text, payload.kind ?? null);

  if (!io) return;
  const full = {
    id: info.lastInsertRowid as number,
    from: payload.from,
    text: payload.text,
    kind: payload.kind,
    created_at: new Date().toISOString(),
  };
  for (const s of io.sockets.sockets.values()) {
    if (s.data.userId === userId) s.emit('agent:notify', full);
  }
}
