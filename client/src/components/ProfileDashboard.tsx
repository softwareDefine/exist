import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';

/*
 * 개인 프로필 대시보드 — 회의를 선택하지 않은 빈 작업공간에 표시.
 * 참여 회의·미완료 할 일·다음 일정·라이브 통화를 요약한다.
 */

interface Overview {
  meetingCount: number;
  todoUndone: number;
  todoOverdue: number;
  liveCalls: { title: string; code: string; inCall: number }[];
  nextMeeting: { title: string; code: string; startsAt: string | null } | null;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '늦은 시간이네요';
  if (h < 12) return '좋은 아침이에요';
  if (h < 18) return '좋은 오후예요';
  return '오늘 하루도 수고했어요';
}

export default function ProfileDashboard() {
  const user = useAuthStore((s) => s.user);
  const [ov, setOv] = useState<Overview | null>(null);

  useEffect(() => {
    let alive = true;
    api<Overview>('/api/agent/overview')
      .then((d) => alive && setOv(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const live = ov?.liveCalls[0];

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 26 }}>
          <div style={avatar}>{user?.avatar ?? '🐧'}</div>
          <div>
            <div style={{ fontSize: 14, color: '#999' }}>{greeting()}</div>
            <div style={{ fontSize: 23, fontWeight: 700, color: '#1a1a1a' }}>
              {user?.username ?? '게스트'}님 👋
            </div>
          </div>
        </div>

        {live && (
          <div style={liveBox}>
            🔴 지금 <b>{live.title}</b>에서 {live.inCall}명 통화 중
          </div>
        )}

        <div style={grid}>
          <div style={stat}>
            <div style={statNum}>{ov?.meetingCount ?? '–'}</div>
            <div style={statLabel}>참여 중인 회의</div>
          </div>
          <div style={stat}>
            <div style={{ ...statNum, color: ov?.todoOverdue ? '#e5484d' : '#21C818' }}>
              {ov?.todoUndone ?? '–'}
            </div>
            <div style={statLabel}>
              미완료 할 일{ov?.todoOverdue ? ` · 마감지남 ${ov.todoOverdue}` : ''}
            </div>
          </div>
          <div style={stat}>
            <div style={{ ...statNum, fontSize: ov?.nextMeeting ? 16 : 28 }}>
              {ov?.nextMeeting ? ov.nextMeeting.title : '없음'}
            </div>
            <div style={statLabel}>다음 일정</div>
          </div>
        </div>

        <div style={{ marginTop: 24, fontSize: 13, color: '#aaa' }}>
          ← 왼쪽에서 회의를 선택하거나 <b style={{ color: '#21C818' }}>＋</b> 로 새 회의를 만들어보세요
        </div>
      </div>
    </div>
  );
}

const wrap: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  padding: 24,
};
const card: CSSProperties = {
  width: 560,
  maxWidth: '100%',
  background: '#fff',
  border: '1px solid #eee',
  borderRadius: 18,
  padding: 32,
  boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
};
const avatar: CSSProperties = {
  width: 60,
  height: 60,
  borderRadius: 16,
  background: '#f2f3f5',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 34,
  flexShrink: 0,
};
const liveBox: CSSProperties = {
  background: 'rgba(229,72,77,0.08)',
  color: '#c0392b',
  borderRadius: 10,
  padding: '10px 14px',
  fontSize: 14,
  marginBottom: 18,
};
const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 12,
};
const stat: CSSProperties = {
  background: '#fafafa',
  borderRadius: 12,
  padding: '18px 14px',
  textAlign: 'center',
};
const statNum: CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  color: '#21C818',
  marginBottom: 4,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const statLabel: CSSProperties = { fontSize: 12, color: '#888' };
