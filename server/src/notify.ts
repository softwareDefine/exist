import type { Server } from 'socket.io';

/*
 * 특정 사용자에게 실시간 푸시(토스트) — Socket.IO io를 index.ts에서 주입받아
 * 라우터(orgs 등)에서 import해 쓴다. 오프라인이면 조용히 무시(MVP).
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

/** userId의 모든 접속 소켓에 푸시 */
export function notifyUser(userId: number, payload: NotifyPayload) {
  if (!io) return;
  for (const s of io.sockets.sockets.values()) {
    if (s.data.userId === userId) s.emit('agent:notify', payload);
  }
}
