import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../store';

let socket: Socket | null = null;

/** 인증 토큰을 실어 소켓 연결 (lazy singleton) */
export function getSocket(): Socket {
  const token = useAuthStore.getState().token;
  // active = 연결 중이거나 자동 재연결 예정 — 연결 수립 전에 여러 컴포넌트가
  // 동시에 불러도 같은 소켓을 공유 (기존엔 connecting 중인 소켓을 끊어버렸음)
  if (socket?.active) return socket;
  socket?.disconnect();
  socket = io('/', { auth: { token } });
  if (import.meta.env.DEV) (window as unknown as { __socket?: Socket }).__socket = socket;
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

/** Socket.IO emit을 Promise(ack)로 감싸기 */
export function request<T = unknown>(sock: Socket, event: string, data?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    sock.emit(event, data ?? {}, (res: T & { error?: string }) => {
      if (res && typeof res === 'object' && 'error' in res && res.error) {
        reject(new Error(res.error));
      } else {
        resolve(res);
      }
    });
  });
}
