import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuthStore } from '../store';
import { useOrgStore } from '../orgStore';
import DirectMessages from './DirectMessages';
import InsightsPanel from './InsightsPanel';
import { type Todo, type Meeting } from './NowBar';
import InboxPanel from './InboxPanel';
import ScheduleWidget from './ScheduleWidget';
import { ListIcon, SparklesIcon, CalendarIcon, ChatIcon, UsersIcon, CheckMarkIcon, ChartIcon } from './Icons';

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
  const orgs = useOrgStore((s) => s.orgs);
  const navigate = useNavigate();
  const [ov, setOv] = useState<Overview | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [schedule, setSchedule] = useState<Meeting[]>([]);
  const [brief, setBrief] = useState('');

  useEffect(() => {
    let alive = true;
    api<Overview>('/api/agent/overview').then((d) => alive && setOv(d)).catch(() => {});
    api<Todo[]>('/api/todos').then((d) => alive && setTodos(d)).catch(() => {});
    api<Meeting[]>('/api/meetings/schedule?org=personal')
      .then((d) => alive && setSchedule(d))
      .catch(() => {});
    api<{ brief: string }>('/api/agent/brief')
      .then((d) => alive && setBrief(d.brief))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const openMeeting = (code: string, title: string) =>
    window.dispatchEvent(new CustomEvent('exist:open-meeting', { detail: { code, title } }));
  const newMeeting = () => window.dispatchEvent(new CustomEvent('exist:new-meeting'));

  const live = ov?.liveCalls[0];
  // 내 지표
  const doneCount = todos.filter((t) => t.done).length;
  const donePct = todos.length ? Math.round((doneCount / todos.length) * 100) : 0;
  const nowMs = Date.now();
  const weekCount = schedule.filter(
    (s) =>
      s.starts_at &&
      new Date(s.starts_at).getTime() >= nowMs &&
      new Date(s.starts_at).getTime() <= nowMs + 7 * 864e5,
  ).length;
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

  // ── 조직 홈 — 팀 인사이트 중심 (개인 홈과 완전 분리) ──
  if (org !== 'personal') {
    const orgName = orgs.find((o) => o.id === org)?.name ?? '조직';
    return (
      <div style={wrap}>
        <div style={heroOrg}>
          <div style={heroAvatar}>👥</div>
          <div>
            <div style={heroGreeting}>🏢 {orgName} · {greeting()}</div>
            <div style={heroName}>{orgName} 팀</div>
            <div style={heroChips}>
              <span style={heroChip}>📊 팀 협업 현황을 아래에서 한눈에</span>
            </div>
          </div>
        </div>

        <div style={section}>
          <div style={sectionHead}>⚡ 빠른 시작</div>
          <div style={actionRow}>
            <button style={actionBtn} onClick={newMeeting}>
              <span style={{ fontSize: 20 }}>＋</span> 새 그룹 만들기
            </button>
            <button style={actionBtn} onClick={() => navigate(`/org/${org}`)}>
              <span style={{ fontSize: 18 }}>👥</span> 조직도 보기
            </button>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <InsightsPanel orgId={org} />
        </div>

        <div style={{ ...section, maxWidth: '50%', minHeight: 420 }}>
          <div style={sectionHead}><span style={headIcon}><ChatIcon size={16} /></span> 통합 메시지</div>
          <InboxPanel scope={org} />
          <DirectMessages scope={org} />
        </div>
      </div>
    );
  }

  // ── 개인 홈 (내 중심) ──
  return (
    <div style={wrap}>
      <div style={heroPersonal}>
        <div style={heroAvatar}>
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
          <div style={heroGreeting}>👤 개인 워크스페이스 · {greeting()}</div>
          <div style={heroName}>{user?.username ?? '게스트'}님 👋</div>
          <div style={heroChips}>
            <span style={heroChip}>
              <b style={heroChipVal}>{ov?.meetingCount ?? '–'}</b> 참여 그룹
            </span>
            <span style={heroChip}>
              <b style={heroChipVal}>{ov?.todoUndone ?? '–'}</b> 미완료 할 일
            </span>
            {!!ov?.todoOverdue && (
              <span style={heroChip}>
                <b style={heroChipVal}>{ov.todoOverdue}</b> 마감 지남
              </span>
            )}
            <span style={heroChip}>
              📅 {ov?.nextMeeting ? `${ov.nextMeeting.title}${nextStr ? ` · ${nextStr}` : ''}` : '다음 일정 없음'}
            </span>
          </div>
        </div>
      </div>

      {live && (
        <div style={liveBox}>
          🔴 지금 <b>{live.title}</b>에서 {live.inCall}명 통화 중 — 아래 최근 그룹에서 참여하세요
        </div>
      )}

      <div style={section}>
        <div style={sectionHead}><span style={headIcon}><ChartIcon size={16} /></span> 내 지표</div>
        <div style={statRow}>
          <div style={statCard}>
            <div style={statIcon}><UsersIcon size={19} /></div>
            <div>
              <div style={statNum}>{ov?.meetingCount ?? 0}</div>
              <div style={statLabel}>참여 그룹</div>
            </div>
          </div>
          <div style={statCard}>
            <div style={statIcon}><CheckMarkIcon size={19} /></div>
            <div>
              <div style={statNum}>{donePct}%</div>
              <div style={statLabel}>할 일 완료율</div>
            </div>
          </div>
          <div style={statCard}>
            <div style={statIcon}><ListIcon size={19} /></div>
            <div>
              <div style={statNum}>{doneCount}/{todos.length}</div>
              <div style={statLabel}>완료한 할 일</div>
            </div>
          </div>
          <div style={statCard}>
            <div style={statIcon}><CalendarIcon size={19} /></div>
            <div>
              <div style={statNum}>{weekCount}</div>
              <div style={statLabel}>이번 주 일정</div>
            </div>
          </div>
        </div>
      </div>

      <div style={quadGrid}>
        <div style={cellCard}>
          <div style={sectionHead}><span style={headIcon}><SparklesIcon size={16} /></span> AI 피드백</div>
          {brief ? (
            <div style={{ fontSize: 14.5, color: 'var(--text)', lineHeight: 1.55 }}>{brief}</div>
          ) : (
            <div style={emptyRow}>분석할 활동이 아직 없어요</div>
          )}
        </div>

        <div style={cellCard}>
          <div style={sectionHead}><span style={headIcon}><ListIcon size={16} /></span> 전체 할 일</div>
          {todos.length === 0 ? (
            <div style={emptyRow}>할 일이 없어요</div>
          ) : (
            todos.slice(0, 8).map((t) => (
              <div key={t.id} style={listRow}>
                <span style={{ color: t.done ? 'var(--green)' : 'var(--border)', fontSize: 15 }}>
                  {t.done ? '●' : '○'}
                </span>
                <span
                  style={{
                    textDecoration: t.done ? 'line-through' : 'none',
                    color: t.done ? 'var(--text-sub)' : 'var(--text)',
                  }}
                >
                  {t.title}
                </span>
              </div>
            ))
          )}
        </div>

        <div style={cellCard}>
          <div style={sectionHead}><span style={headIcon}><CalendarIcon size={16} /></span> 전체 일정</div>
          <ScheduleWidget schedule={schedule} onOpen={openMeeting} />
        </div>

        <div style={cellCard}>
          <div style={sectionHead}><span style={headIcon}><ChatIcon size={16} /></span> 통합 메시지</div>
          <InboxPanel scope={org} />
          <DirectMessages scope={org} />
        </div>
      </div>

    </div>
  );
}

const wrap: CSSProperties = {
  height: '100%',
  overflow: 'auto',
  padding: '20px 18px',
  boxSizing: 'border-box',
  background: 'var(--surface-2)',
};
const liveBox: CSSProperties = {
  background: 'rgba(229,72,77,0.08)',
  color: '#c0392b',
  borderRadius: 12,
  padding: '14px 18px',
  fontSize: 14.5,
  marginBottom: 24,
};
const actionRow: CSSProperties = { display: 'flex', gap: 12, marginBottom: 4, flexWrap: 'wrap' };
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

/* ── 히어로 배너 (개편) ── */
const hero: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 22,
  borderRadius: 20,
  padding: '30px 34px',
  marginBottom: 20,
  color: '#fff',
  boxShadow: '0 10px 28px rgba(0,0,0,0.14)',
};
const heroPersonal: CSSProperties = {
  ...hero,
  background: 'linear-gradient(135deg, #2c3e50 0%, #54708e 100%)',
};
const heroOrg: CSSProperties = {
  ...hero,
  background: 'linear-gradient(135deg, #178a37 0%, #21C818 100%)',
};
const heroAvatar: CSSProperties = {
  width: 64,
  height: 64,
  borderRadius: 16,
  background: 'rgba(255,255,255,0.2)',
  display: 'grid',
  placeItems: 'center',
  fontSize: 32,
  flexShrink: 0,
  overflow: 'hidden',
};
const heroGreeting: CSSProperties = { fontSize: 14, opacity: 0.85 };
const heroName: CSSProperties = { fontSize: 26, fontWeight: 700, margin: '2px 0 13px' };
const heroChips: CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap' };
const heroChip: CSSProperties = {
  background: 'rgba(255,255,255,0.16)',
  borderRadius: 11,
  padding: '7px 14px',
  fontSize: 13,
  display: 'flex',
  alignItems: 'baseline',
  gap: 7,
  whiteSpace: 'nowrap',
};
const heroChipVal: CSSProperties = { fontSize: 17, fontWeight: 700 };
const section: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  boxShadow: 'var(--shadow-sm)',
  padding: '16px 20px',
  marginBottom: 14,
};
const sectionHead: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--text)',
  margin: '0 0 16px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
// 섹션 제목 아이콘 — 텍스트보다 한 톤 낮춘 회색
const headIcon: CSSProperties = { color: 'var(--text-sub)', display: 'inline-flex', alignItems: 'center' };
const quadGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '2fr 1fr',
  gap: 14,
};
// grid 셀 카드 — section의 marginBottom을 없애 gap(14)만 세로 간격으로 적용
const cellCard: CSSProperties = { ...section, marginBottom: 0 };
const statRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 8,
};
const statCard: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 13,
  padding: '4px 2px',
};
const statIcon: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 11,
  background: 'var(--surface-2)',
  color: 'var(--green)',
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
};
const statNum: CSSProperties = { fontSize: 22, fontWeight: 700, color: 'var(--text)', lineHeight: 1.1 };
const statLabel: CSSProperties = { fontSize: 12.5, color: 'var(--text-sub)', marginTop: 3 };
const listRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 2px',
  fontSize: 14,
  borderBottom: '1px solid var(--border)',
};
const emptyRow: CSSProperties = { fontSize: 13, color: 'var(--text-sub)', padding: '8px 2px' };
