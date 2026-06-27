import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';

/*
 * 개인 프로필 대시보드 — '홈' 탭(회의 미선택)에서 작업공간을 꽉 채워 표시.
 * 참여 회의·미완료 할 일·마감 지난 할 일·다음 일정·라이브 통화를 요약한다.
 */

interface Overview {
  avatar: string;
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
  const nextStr = ov?.nextMeeting?.startsAt
    ? new Date(ov.nextMeeting.startsAt).toLocaleString('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <div style={wrap}>
      <div style={header}>
        <div style={avatarBox}>{ov?.avatar ?? user?.avatar ?? '🐧'}</div>
        <div>
          <div style={{ fontSize: 15, color: '#999' }}>{greeting()}</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#1a1a1a' }}>
            {user?.username ?? '게스트'}님 👋
          </div>
        </div>
      </div>

      {live && (
        <div style={liveBox}>
          🔴 지금 <b>{live.title}</b>에서 {live.inCall}명 통화 중 — 왼쪽 회의에서 참여하세요
        </div>
      )}

      <div style={grid}>
        <div style={statCard}>
          <div style={statNum}>{ov?.meetingCount ?? '–'}</div>
          <div style={statLabel}>참여 중인 회의</div>
        </div>
        <div style={statCard}>
          <div style={{ ...statNum, color: '#21C818' }}>{ov?.todoUndone ?? '–'}</div>
          <div style={statLabel}>미완료 할 일</div>
        </div>
        <div style={statCard}>
          <div style={{ ...statNum, color: ov?.todoOverdue ? '#e5484d' : '#cfcfcf' }}>
            {ov?.todoOverdue ?? '–'}
          </div>
          <div style={statLabel}>마감 지난 할 일</div>
        </div>
        <div style={statCard}>
          <div style={{ ...statNum, fontSize: nextStr ? 18 : 26 }}>
            {ov?.nextMeeting ? ov.nextMeeting.title : '없음'}
          </div>
          <div style={statLabel}>{nextStr ? `다음 일정 · ${nextStr}` : '다음 일정'}</div>
        </div>
      </div>

      <div style={hint}>
        ← 왼쪽에서 회의를 선택하거나 <b style={{ color: '#21C818' }}>＋</b> 로 새 회의를
        만들어보세요
      </div>
    </div>
  );
}

const wrap: CSSProperties = {
  height: '100%',
  overflow: 'auto',
  padding: '44px 52px',
  boxSizing: 'border-box',
};
const header: CSSProperties = { display: 'flex', alignItems: 'center', gap: 18, marginBottom: 30 };
const avatarBox: CSSProperties = {
  width: 68,
  height: 68,
  borderRadius: 18,
  background: '#f2f3f5',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 38,
  flexShrink: 0,
};
const liveBox: CSSProperties = {
  background: 'rgba(229,72,77,0.08)',
  color: '#c0392b',
  borderRadius: 12,
  padding: '14px 18px',
  fontSize: 14.5,
  marginBottom: 24,
};
const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
  gap: 16,
  marginBottom: 30,
};
const statCard: CSSProperties = {
  background: '#fafafa',
  border: '1px solid #f0f0f0',
  borderRadius: 16,
  padding: '30px 20px',
  textAlign: 'center',
};
const statNum: CSSProperties = {
  fontSize: 40,
  fontWeight: 800,
  color: '#21C818',
  marginBottom: 6,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const statLabel: CSSProperties = { fontSize: 13, color: '#888' };
const hint: CSSProperties = { fontSize: 14, color: '#aaa' };
