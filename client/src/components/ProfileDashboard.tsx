import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuthStore } from '../store';
import { useOrgStore } from '../orgStore';
import DirectMessages from './DirectMessages';

/*
 * 개인 프로필 대시보드 — '홈' 탭(회의 미선택)에서 작업공간을 꽉 채워 표시.
 * 요약 통계 + 빠른 시작(새 회의·팀 인사이트) + 최근 회의(클릭해서 열기).
 */

interface Overview {
  avatar: string;
  meetingCount: number;
  todoUndone: number;
  todoOverdue: number;
  liveCalls: { title: string; code: string; inCall: number }[];
  recentMeetings: { title: string; code: string; inCall: number }[];
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
  const org = useOrgStore((s) => s.current);
  const navigate = useNavigate();
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

  const openMeeting = (code: string, title: string) =>
    window.dispatchEvent(new CustomEvent('exist:open-meeting', { detail: { code, title } }));
  const newMeeting = () => window.dispatchEvent(new CustomEvent('exist:new-meeting'));

  const live = ov?.liveCalls[0];
  const avatarVal = ov?.avatar ?? user?.avatar ?? '🐧';
  const avatarIsImg =
    avatarVal.startsWith('/api') ||
    avatarVal.startsWith('http') ||
    avatarVal.startsWith('/uploads');
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
        <div style={avatarBox}>
          {avatarIsImg ? (
            <img
              src={avatarVal}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            avatarVal
          )}
        </div>
        <div>
          <div style={{ fontSize: 15, color: 'var(--text-sub)' }}>{greeting()}</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--text)' }}>
            {user?.username ?? '게스트'}님 👋
          </div>
        </div>
      </div>

      {live && (
        <div style={liveBox}>
          🔴 지금 <b>{live.title}</b>에서 {live.inCall}명 통화 중 — 아래 최근 회의에서 참여하세요
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
          <div style={{ ...statNum, color: ov?.todoOverdue ? '#e5484d' : 'var(--text-sub)' }}>
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

      <div style={sectionTitle}>빠른 시작</div>
      <div style={actionRow}>
        <button style={actionBtn} onClick={newMeeting}>
          <span style={{ fontSize: 20 }}>＋</span> 새 회의 만들기
        </button>
        {typeof org === 'number' && (
          <button style={actionBtn} onClick={() => navigate(`/org/${org}`)}>
            <span style={{ fontSize: 18 }}>📊</span> 팀 인사이트 보기
          </button>
        )}
      </div>

      {/* 1:1 DM — 조직이면 멤버 목록, 개인이면 이름 검색으로 대화 */}
      {/* DM 기능 임시 비활성화 (배포용) — 복구 시 false → true */}
      {false && (
        <div style={dmSection}>
          <DirectMessages scope={org} />
        </div>
      )}

      {ov && ov.recentMeetings.length > 0 && (
        <>
          <div style={sectionTitle}>최근 회의</div>
          <div style={meetGrid}>
            {ov.recentMeetings.map((m) => (
              <button key={m.code} style={meetCard} onClick={() => openMeeting(m.code, m.title)}>
                <div style={meetTitle}>{m.title}</div>
                <div style={{ ...meetSub, color: m.inCall > 0 ? '#e5484d' : '#aaa' }}>
                  {m.inCall > 0 ? `🔴 ${m.inCall}명 통화 중` : '클릭해서 열기 →'}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const wrap: CSSProperties = {
  height: '100%',
  overflow: 'auto',
  padding: '44px 52px',
  boxSizing: 'border-box',
};
const header: CSSProperties = { display: 'flex', alignItems: 'center', gap: 18, marginBottom: 28 };
const avatarBox: CSSProperties = {
  width: 68,
  height: 68,
  borderRadius: 18,
  background: 'var(--border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 38,
  flexShrink: 0,
  overflow: 'hidden',
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
  marginBottom: 32,
};
const statCard: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: '30px 20px',
  textAlign: 'center',
};
const statNum: CSSProperties = {
  fontSize: 40,
  fontWeight: 800,
  color: 'var(--green)',
  marginBottom: 6,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const statLabel: CSSProperties = { fontSize: 13, color: 'var(--text-sub)' };
const sectionTitle: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: 'var(--text)',
  margin: '0 0 14px',
};
const actionRow: CSSProperties = { display: 'flex', gap: 12, marginBottom: 32, flexWrap: 'wrap' };
const dmSection: CSSProperties = { maxWidth: 520, marginBottom: 32 };
const actionBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '12px 20px',
  borderRadius: 12,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text)',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};
const meetGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
  gap: 12,
};
const meetCard: CSSProperties = {
  textAlign: 'left',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  padding: '16px 18px',
  cursor: 'pointer',
};
const meetTitle: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: 'var(--text)',
  marginBottom: 6,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const meetSub: CSSProperties = { fontSize: 12.5 };
