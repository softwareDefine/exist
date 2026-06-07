import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../store';

let socket: Socket | null = null;

/** 인증 토큰을 실어 소켓 연결 (lazy singleton) */
export function getSocket(): Socket {
  const token = useAuthStore.getState().token;
  if (socket?.connected) return socket;
  socket?.disconnect();
  socket = io('/', { auth: { token } });
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
