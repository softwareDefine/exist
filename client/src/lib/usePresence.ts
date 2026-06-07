import { useEffect, useState } from 'react';
import { api } from '../api';
import { getSocket } from './socket';

/** 접속 중인 사용자명 집합 — 소켓 푸시 + 30초 폴링 보강 */
export function usePresence(): Set<string> {
  const [users, setUsers] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const d = await api<{ users: string[] }>('/api/presence');
        if (alive) setUsers(new Set(d.users));
      } catch {
        /* 무시 */
      }
    }
    void load();
    const t = setInterval(load, 30_000);

    const socket = getSocket();
    function onUpdate({ users }: { users: string[] }) {
      setUsers(new Set(users));
    }
    socket.on('presence:update', onUpdate);
    return () => {
      alive = false;
      clearInterval(t);
      socket.off('presence:update', onUpdate);
    };
  }, []);

  return users;
}
