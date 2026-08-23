import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface User {
  id: number;
  username: string;
  avatar?: string;
  /** 표시 이름 (실명 등) — 없으면 아이디로 표시 */
  name?: string | null;
}

interface AuthState {
  token: string | null;
  user: User | null;
  setAuth: (token: string, user: User) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => {
        set({ token, user });
        // 계정 전환 시 이전 계정으로 인증된 소켓을 반드시 끊는다 — 소켓 인증은 연결 시점
        // 토큰이라, 안 끊으면 채팅·자막이 이전 계정 이름으로 나간다 (8/23 실사용 버그).
        // 동적 import: socket.ts가 이 스토어를 물고 있어 정적이면 순환 참조
        void import('./lib/socket').then((m) => m.disconnectSocket());
      },
      logout: () => {
        set({ token: null, user: null });
        void import('./lib/socket').then((m) => m.disconnectSocket());
      },
    }),
    { name: 'exist-auth' },
  ),
);
