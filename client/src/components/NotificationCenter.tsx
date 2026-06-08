import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../lib/socket';
import { BellIcon } from './Icons';

interface Notification {
  id: number;
  from: string;
  text: string;
  kind: string | null;
  read: boolean;
  ts: number;
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 알림함 — nowbar 종 아이콘. 영속 알림 목록 + 안읽음 카운트 + 실시간 수신 */
export default function NotificationCenter() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 초기 로드
  useEffect(() => {
    void api<{ unread: number; items: Notification[] }>('/api/notifications')
      .then((d) => {
        setItems(d.items);
        setUnread(d.unread);
      })
      .catch(() => {});
  }, []);

  // 실시간 수신 — 목록 맨 위에 추가, 안읽음 +1
  useEffect(() => {
    const socket = getSocket();
    function onNotify(n: Notification & { created_at?: string }) {
      // id가 없는(영속 안 된) 레거시 푸시는 무시 — 알림함은 DB 기반만
      if (typeof n.id !== 'number') return;
      // 실시간 푸시는 created_at(ISO), API 로드는 ts(ms) — 통일
      const ts = typeof n.ts === 'number' ? n.ts : n.created_at ? Date.parse(n.created_at) : Date.now();
      setItems((prev) =>
        prev.some((x) => x.id === n.id) ? prev : [{ ...n, ts, read: false }, ...prev],
      );
      setUnread((u) => u + 1);
    }
    socket.on('agent:notify', onNotify);
    return () => {
      socket.off('agent:notify', onNotify);
    };
  }, []);

  // 바깥 클릭 닫기
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    // 열 때 읽음 처리
    if (next && unread > 0) {
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnread(0);
      await api('/api/notifications/read', { method: 'POST' }).catch(() => {});
    }
  }

  async function clearAll() {
    setItems([]);
    setUnread(0);
    await api('/api/notifications', { method: 'DELETE' }).catch(() => {});
  }

  return (
    <div className="notif-center" ref={ref}>
      <button className="notif-bell" onClick={toggle} title="알림">
        <BellIcon size={20} />
        {unread > 0 && <span className="notif-count">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            <span>알림</span>
            {items.length > 0 && (
              <button className="notif-clear" onClick={clearAll}>
                모두 지우기
              </button>
            )}
          </div>
          <div className="notif-list">
            {items.length === 0 ? (
              <div className="notif-empty">새 알림이 없어요</div>
            ) : (
              items.map((n) => (
                <div key={n.id} className={`notif-item${n.read ? '' : ' unread'}`}>
                  <div className="notif-item-top">
                    <span className="notif-from">{n.from}</span>
                    <span className="notif-time">{relTime(n.ts)}</span>
                  </div>
                  <div className="notif-text">{n.text}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
