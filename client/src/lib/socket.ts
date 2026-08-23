import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../store';

let socket: Socket | null = null;

/** 인증 토큰을 실어 소켓 연결 (lazy singleton).
 *  auth는 콜백 — 재연결 때마다 현재 토큰으로 재인증 (고정 객체면 소켓 생성 시점 계정으로 박제됨).
 *  계정 전환 시에는 store가 disconnectSocket()을 불러 강제로 새 연결을 만든다 —
 *  안 그러면 이전 계정으로 인증된 소켓이 살아남아 채팅·자막이 옛 계정 이름으로 나간다 */
export function getSocket(): Socket {
  // active = 연결 중이거나 자동 재연결 예정 — 연결 수립 전에 여러 컴포넌트가
  // 동시에 불러도 같은 소켓을 공유 (기존엔 connecting 중인 소켓을 끊어버렸음)
  if (socket?.active) return socket;
  socket?.disconnect();
  socket = io('/', {
    auth: (cb) => cb({ token: useAuthStore.getState().token }),
  });
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
