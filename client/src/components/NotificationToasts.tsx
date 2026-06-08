import { useEffect, useState } from 'react';
import { getSocket } from '../lib/socket';
import { useOrgStore } from '../orgStore';

interface Toast {
  id: number;
  from: string;
  text: string;
}

interface NotifyPayload {
  from: string;
  text: string;
  kind?: 'org-approved' | 'org-request';
}

let nextId = 1;

/** AI agent 푸시 알림 — 디자인의 알림 카드 (좌상단) */
export default function NotificationToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const socket = getSocket();
    function onNotify({ from, text, kind }: NotifyPayload) {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, from, text }]);
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 12_000);
      // 조직 가입/승인 알림이면 조직 목록·대기수 갱신
      if (kind === 'org-approved' || kind === 'org-request') {
        void useOrgStore.getState().load();
      }
    }
    socket.on('agent:notify', onNotify);
    return () => {
      socket.off('agent:notify', onNotify);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className="toast-card">
          <div className="toast-avatar">🤖</div>
          <div>
            <div className="toast-from">{t.from}</div>
            <div className="toast-text">{t.text}</div>
          </div>
          <button
            className="toast-close"
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
