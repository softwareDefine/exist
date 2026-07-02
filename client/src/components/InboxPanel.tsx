import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api';
import MeetingThumb from './MeetingThumb';

/*
 * 통합 메시지함 — 스코프(조직/개인) 내 참여 그룹들의 채팅을 최근순으로 모아,
 * 안읽음 뱃지와 최근 메시지 미리보기를 보여준다. 클릭하면 채팅 탭을 열고 읽음 처리.
 */

interface InboxItem {
  id: number;
  code: string;
  title: string;
  thumbnail: string | null;
  lastText: string | null;
  lastTs: string | null;
  unread: number;
}

export default function InboxPanel({ scope }: { scope: number | 'personal' }) {
  const [items, setItems] = useState<InboxItem[]>([]);

  useEffect(() => {
    let alive = true;
    api<InboxItem[]>(`/api/meetings/inbox?org=${scope}`)
      .then((d) => alive && setItems(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [scope]);

  function open(it: InboxItem) {
    window.dispatchEvent(
      new CustomEvent('exist:open-meeting', {
        detail: { code: it.code, title: it.title, tab: 'chat' },
      }),
    );
    void api(`/api/meetings/${it.code}/messages/read`, { method: 'POST' }).catch(() => {});
    setItems((prev) => prev.map((x) => (x.code === it.code ? { ...x, unread: 0 } : x)));
  }

  if (items.length === 0) {
    return <div style={empty}>아직 그룹 채팅이 없어요</div>;
  }

  return (
    <div style={list}>
      {items.map((it) => (
        <button key={it.id} style={row} onClick={() => open(it)}>
          <MeetingThumb id={it.id} title={it.title} thumbnail={it.thumbnail} className="inbox-thumb" />
          <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
            <div style={rowTitle}>{it.title}</div>
            <div style={rowSub}>{it.lastText ?? '아직 메시지가 없어요'}</div>
          </div>
          {it.unread > 0 && <span style={badge}>{it.unread > 99 ? '99+' : it.unread}</span>}
        </button>
      ))}
    </div>
  );
}

const list: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 };
const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 8px',
  background: 'none',
  border: 'none',
  borderRadius: 10,
  cursor: 'pointer',
  width: '100%',
};
const rowTitle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--text)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const rowSub: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--text-sub)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  marginTop: 2,
};
const badge: CSSProperties = {
  minWidth: 18,
  height: 18,
  padding: '0 5px',
  borderRadius: 9,
  background: '#ff5b5b',
  color: '#fff',
  fontSize: 11,
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};
const empty: CSSProperties = { fontSize: 13, color: 'var(--text-sub)', padding: '8px 2px' };
