import { useEffect, useState, type CSSProperties } from 'react';
import { displayNameOf } from '../names'; // 미확인자 목록도 아이디 대신 표시명 (9/1 클라 테스트에서 발견)
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuthStore } from '../store';
import { useOrgStore } from '../orgStore';
import InsightsPanel from './InsightsPanel';
import MyOrgFocus from './MyOrgFocus';
import { type Todo, type Meeting } from './NowBar';
import UnifiedInbox from './UnifiedInbox';
import { DmWindow, type Thread, type DmScope } from './DirectMessages';
import { dueBadge } from '../lib/due';
import { getSocket } from '../lib/socket';
import { keyActivate } from '../lib/a11y';
import ScheduleWidget from './ScheduleWidget';
import Marquee from './Marquee';
import { ListIcon, SparklesIcon, CalendarIcon, ChatIcon, UsersIcon, CheckMarkIcon, ChartIcon, CheckIcon, PenIcon, UserIcon, BoltIcon, BuildingIcon, CloseIcon } from './Icons';

/** 확인 대기 결정 — 홈 카드 (P1: 결정은 전달되고, 확인되어야 한다) */
interface PendingDecision {
  recapId: number;
  idx: number;
  decision: string;
  code: string;
  title: string;
  ts: number;
}
/** 홈 "최근 결정" 카드 행 — 내 그룹 원장 최신 결정 + 확인 N/M */
interface RecentDecision {
  recapId: number;
  idx: number;
  decision: string;
  why: string;
  critical: boolean;
  code: string;
  title: string;
  ts: number;
  acked: number;
  total: number;
  mine: boolean;
}

/*
 * 개인 프로필 대시보드 — '홈' 탭(회의 미선택)에서 작업공간을 꽉 채워 표시.
 * 요약 통계 + 빠른 시작(새 회의·팀 인사이트) + 최근 회의(클릭해서 열기).
 */

interface Overview {
  avatar: string;
  meetingCount: number;
  todoUndone: number;
  todoOverdue: number;
  /** 안 읽은 합계 (DM + 그룹 채팅) — 히어로 뱃지 */
  unreadTotal: number;
  /** 수신확인 대기 결정 수 — 히어로 뱃지 */
  pendingAcks: number;
  /** 이번 주(최근 7일) 내 그룹에서 나온 결정 수 — 스탯 카드 */
  weekDecisions: number;
  liveCalls: { title: string; code: string; inCall: number }[];
  recentMeetings: { title: string; code: string; inCall: number }[];
  nextMeeting: { title: string; code: string; startsAt: string | null } | null;
}

/** 문서 열람 서명 대기 — 내가 참가한 전 그룹의 회람 문서 중 미서명 (그룹에 안 들어가도 홈에서 보인다) */
interface PendingFileAck {
  fileId: number;
  name: string;
  /** 그룹 코드 — exist:deeplink 착지용 */
  code: string;
  /** 그룹 이름 */
  title: string;
}

/** 지금 처리할 것 — 미확인 결정 + 서명 대기 문서 + 기한 할 일 + 안읽은 DM (7/29 개편: "전달보다 확인"의 홈) */
interface Actions {
  decisions: PendingDecision[];
  todos: { id: number; title: string; due_at: string; code: string | null; mtitle: string | null }[];
  dms: {
    userId: number;
    username: string;
    name: string | null;
    avatar: string | null;
    unread: number;
    lastText: string;
    ts: number;
  }[];
  /** 서명 대기 문서 — 최근 것부터 상한 5개, 총계는 pendingAcksTotal */
  pendingAcks: PendingFileAck[];
  pendingAcksTotal: number;
}

/** P0 발신자 카드 — 내가 보낸 결정의 도달 현황 ("보내고 도달을 확인할 방법이 없다" — 발신자 현직 증언) */
interface SentEntry {
  recapId: number;
  idx: number;
  decision: string;
  code: string;
  title: string;
  ts: number;
  acked: number;
  total: number;
  missing: string[];
  critical: boolean;
}

/** P2 — 자리 비운 사이 놓친 것 브리핑 */
interface CatchupItem {
  type: 'recap' | 'todo' | 'dm' | 'chat';
  text: string;
  meeting?: { code: string; title: string };
}

interface Catchup {
  headline: string;
  items: CatchupItem[];
}

const CATCHUP_BADGE: Record<CatchupItem['type'], string> = {
  recap: '통화 정리',
  todo: '할 일',
  dm: 'DM',
  chat: '채팅',
};

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
  const [daily, setDaily] = useState('');
  const [catchup, setCatchup] = useState<Catchup | null>(null);
  const [pending, setPending] = useState<PendingDecision[] | null>(null);
  const [recent, setRecent] = useState<RecentDecision[]>([]);
  const [actions, setActions] = useState<Actions | null>(null);
  // 발신자 카드 — 행동 기반 노출: 보낸 결정이 있을 때만 뜬다 (역할 설정 없이 대시보드가 역할을 따라감)
  const [sent, setSent] = useState<{ entries: SentEntry[]; totalSent: number } | null>(null);
  const [reminding, setReminding] = useState<string | null>(null);
  // 우리 조 확인 현황 — 마디(relay)·관리자 전용 카드 재료 (부서 멤버의 미확인 결정)
  const [teamAcks, setTeamAcks] = useState<{
    department: string | null;
    items: {
      recapId: number;
      idx: number;
      text: string;
      meetingCode: string;
      meetingTitle: string;
      total: number;
      acked: number;
      missing: string[];
    }[];
  } | null>(null);
  // 인박스 DM 답장 — 우하단 플로팅 창 (허브·홈 통합 메시지와 같은 창)
  const [dmPeer, setDmPeer] = useState<Thread | null>(null);
  const [statsOpen, setStatsOpen] = useState(false); // 지표·인사이트 한 줄 접힘

  /** 홈에서 바로 완료 토글 — 낙관적 갱신, 실패 시 원복 */
  async function toggleTodo(t: Todo) {
    const next = t.done ? 0 : 1;
    setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: next } : x)));
    try {
      await api(`/api/todos/${t.id}`, { method: 'PATCH', body: { done: !!next } });
    } catch {
      setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: t.done } : x)));
    }
  }

  /** 홈에서 삭제 — 개인 할 일 정리 동선 (서버가 관련자 게이트) */
  async function removeTodo(t: Todo) {
    try {
      await api(`/api/todos/${t.id}`, { method: 'DELETE' });
      setTodos((prev) => prev.filter((x) => x.id !== t.id));
    } catch {
      /* 전역 토스트 */
    }
  }

  // 우리 조 확인 현황 — 마디(relay)·hq·관리자만 조회 (field에겐 서버도 403)
  useEffect(() => {
    setTeamAcks(null);
    if (typeof org !== 'number') return;
    const info = orgs.find((o) => o.id === org);
    const tier = info?.myTier ?? null;
    if (!info || (!info.isManager && tier !== 'relay' && tier !== 'hq')) return;
    let alive = true;
    void api<typeof teamAcks>(`/api/orgs/${org}/team-acks`, { silent: true })
      .then((d) => alive && setTeamAcks(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, orgs]);

  // 확인(서명) 변동 푸시 — "지금 처리할 것" 인박스·발신자 카드 즉시 갱신
  useEffect(() => {
    const socket = getSocket();
    const orgQ = `org=${org === 'personal' ? 'personal' : org}`;
    function onLedgerChanged() {
      api<{ items: PendingDecision[] }>(`/api/agent/pending-decisions?${orgQ}`)
        .then((d) => setPending(d.items))
        .catch(() => {});

      api<{ items: RecentDecision[] }>(`/api/agent/recent-decisions?${orgQ}`)

        .then((d) => setRecent(Array.isArray(d?.items) ? d.items : []))

        .catch(() => {});
      api<{ entries: SentEntry[]; totalSent: number }>(`/api/agent/sent?${orgQ}`)
        .then((d) => setSent(d))
        .catch(() => {});
      api<Actions>(`/api/agent/actions?${orgQ}`).then(setActions).catch(() => {});
    }
    // 파일 변동(서명·회람 요청·개정·배포 포함) 푸시 — 서명 대기 행 즉시 갱신
    function onFilesChanged() {
      api<Actions>(`/api/agent/actions?${orgQ}`).then(setActions).catch(() => {});
    }
    socket.on('ledger:changed', onLedgerChanged);
    socket.on('files:changed', onFilesChanged);
    return () => {
      socket.off('ledger:changed', onLedgerChanged);
      socket.off('files:changed', onFilesChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  // 할 일 배정/변경 푸시 — 홈 "전체 할 일" 즉시 갱신
  useEffect(() => {
    const orgQ = `org=${org === 'personal' ? 'personal' : org}`;
    function onTodos() {
      api<Todo[]>(`/api/todos?${orgQ}`).then(setTodos).catch(() => {});
    }
    window.addEventListener('exist:todos-changed', onTodos);
    return () => window.removeEventListener('exist:todos-changed', onTodos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  // 통화 인원 변동 소켓 푸시 — "지금 N명 통화 중" 배너·그룹 카드 즉시 갱신
  useEffect(() => {
    const socket = getSocket();
    function onCallPresence(p: { code?: string; title?: string; peers?: string[] } | undefined) {
      if (!p?.code || !Array.isArray(p.peers)) return;
      const n = p.peers.length;
      setOv((prev) => {
        if (!prev) return prev;
        let liveCalls = prev.liveCalls.filter((c) => c.code !== p.code);
        if (n > 0) liveCalls = [{ title: p.title ?? p.code!, code: p.code!, inCall: n }, ...liveCalls];
        const recentMeetings = prev.recentMeetings.map((m) =>
          m.code === p.code ? { ...m, inCall: n } : m,
        );
        return { ...prev, liveCalls, recentMeetings };
      });
    }
    socket.on('call:presence', onCallPresence);
    return () => {
      socket.off('call:presence', onCallPresence);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    // AI 콘텐츠는 탭 컨텍스트를 따라간다 — 개인 탭은 개인 그룹만, 조직 탭은 그 조직만
    const orgQ = `org=${org === 'personal' ? 'personal' : org}`;
    // 탭 전환 시 이전 스코프 내용이 잠깐 보이지 않게 비운다
    setOv(null);
    setDaily('');
    setCatchup(null);
    api<Overview>(`/api/agent/overview?${orgQ}`).then((d) => alive && setOv(d)).catch(() => {});
    api<Todo[]>(`/api/todos?${orgQ}`).then((d) => alive && setTodos(d)).catch(() => {});
    // 일정은 현재 컨텍스트(개인/조직) 범위로
    api<Meeting[]>(`/api/meetings/schedule?${orgQ}`)
      .then((d) => alive && setSchedule(d))
      .catch(() => {});
    // 오늘 브리핑 — AI 총무의 하루 세팅 문단
    api<{ text: string }>(`/api/agent/daily?${orgQ}`)
      .then((d) => alive && setDaily(d.text))
      .catch(() => {});
    // P2 — 자리 비운 사이 놓친 것 브리핑
    api<Catchup>(`/api/agent/catchup?${orgQ}`)
      .then((d) => alive && setCatchup(d))
      .catch(() => {});
    // P1 — 확인 대기 결정 (홈에서 바로 회람 사인)
    setPending(null);
    api<{ items: PendingDecision[] }>(`/api/agent/pending-decisions?${orgQ}`)
      .then((d) => alive && setPending(d.items))
      .catch(() => {});

    api<{ items: RecentDecision[] }>(`/api/agent/recent-decisions?${orgQ}`)

      .then((d) => alive && setRecent(Array.isArray(d?.items) ? d.items : []))

      .catch(() => {});
    // 지금 처리할 것 — 결정·기한 할 일·안읽은 DM 집계
    setActions(null);
    api<Actions>(`/api/agent/actions?${orgQ}`)
      .then((d) => alive && setActions(d))
      .catch(() => {});
    // 발신자 카드 — 내가 보낸 결정의 도달 현황
    setSent(null);
    api<{ entries: SentEntry[]; totalSent: number }>(`/api/agent/sent?${orgQ}`)
      .then((d) => alive && setSent(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [org]);

  /** 인박스 갱신 — 확인·답장·완료 후 재조회 */
  const reloadActions = () => {
    const orgQ = `org=${org === 'personal' ? 'personal' : org}`;
    void api<Actions>(`/api/agent/actions?${orgQ}`).then(setActions).catch(() => {});
  };

  const openMeeting = (code: string, title: string) =>
    window.dispatchEvent(new CustomEvent('exist:open-meeting', { detail: { code, title } }));
  /** 서명 대기 문서로 — 그룹 탭→공동편집→해당 문서 착지 (DashboardPage의 exist:deeplink 수신) */
  const openFileAck = (f: PendingFileAck) =>
    window.dispatchEvent(
      new CustomEvent('exist:deeplink', { detail: { code: f.code, fileId: f.fileId } }),
    );
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

  // 전체 할 일 카드 — 개인/조직 홈 공용 (todos는 이미 탭 스코프로 조회됨)
  const todoCard = (
    <div style={cellCard}>
      <div style={sectionHead}><span style={headIcon}><ListIcon size={16} /></span> 전체 할 일</div>
      {todos.length === 0 ? (
        <div style={emptyRow}>할 일이 없어요</div>
      ) : (
        <div className="hub-todos">
          {/* 회의 대시보드의 할 일과 같은 컴포넌트 언어(.hub-todo) — 체크로 완료 토글 */}
          {[...todos]
            .sort((a, b) => a.done - b.done)
            .slice(0, 8)
            .map((t) => (
              <div key={t.id} className={`hub-todo${t.done ? ' done' : ''}`}>
                <label className="hub-todo-label">
                  <input type="checkbox" checked={!!t.done} onChange={() => void toggleTodo(t)} />
                  <span className="hub-todo-check" aria-hidden>
                    <CheckMarkIcon size={16} />
                  </span>
                  <Marquee className="hub-todo-text">{t.title}</Marquee>
                </label>
                {t.due_at && dueBadge(t.due_at) && (
                  <span className={`nb-todo-due ${dueBadge(t.due_at)!.cls}`}>
                    {dueBadge(t.due_at)!.label}
                  </span>
                )}
                {t.meeting_title && (
                  <span className="hub-todo-meet" title={`"${t.meeting_title}" 회의에서 배정됨`}>
                    {t.meeting_title}
                  </span>
                )}
                <button className="hub-todo-del" title="삭제" onClick={() => void removeTodo(t)}>
                  <CloseIcon size={12} />
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );

  // ── 7/29 개편 공용 조각 — "전달보다 확인": 히어로 카운트 + 지금 처리할 것 인박스 + 오늘 일정 ──
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const todayEvents = schedule
    .filter((s) => {
      if (!s.starts_at) return false;
      const t = new Date(s.starts_at).getTime();
      return t >= today0.getTime() && t < today0.getTime() + 864e5;
    })
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime());
  const overdueCount = actions
    ? actions.todos.filter((t) => new Date(t.due_at).getTime() < today0.getTime()).length
    : (ov?.todoOverdue ?? 0);
  const pendingCount = actions?.decisions.length ?? pending?.length ?? ov?.pendingAcks ?? 0;
  const signPendingCount = actions?.pendingAcksTotal ?? 0;
  const inboxTotal = actions
    ? actions.decisions.length + actions.todos.length + actions.dms.length + actions.pendingAcksTotal
    : 0;

  const heroLine = (
    <div className="pd-hero2-line">
      오늘 회의 <b>{todayEvents.length}건</b> <i>·</i> 마감 지난 할 일 <b>{overdueCount}건</b>{' '}
      <i>·</i> 확인 안 한 결정 <b>{pendingCount}건</b>
      {signPendingCount > 0 && (
        <>
          {' '}
          <i>·</i> 서명 대기 문서 <b>{signPendingCount}건</b>
        </>
      )}
    </div>
  );
  const heroDaily = daily ? <div className="pd-hero2-daily">{daily}</div> : null;

  const dmThread = (d: Actions['dms'][number]): Thread => ({
    userId: d.userId,
    username: d.username,
    avatar: d.avatar,
    position: null,
    department: null,
    lastText: d.lastText,
    lastTs: d.ts,
    lastMine: false,
    unread: d.unread,
  });

  /** 인박스에서 결정 확인 — 낙관 제거 + 서버 기록 (회람 사인) */
  async function ackFromInbox(p: PendingDecision) {
    setActions((prev) =>
      prev
        ? {
            ...prev,
            decisions: prev.decisions.filter(
              (d) => !(d.recapId === p.recapId && d.idx === p.idx),
            ),
          }
        : prev,
    );
    setOv((prev) => (prev ? { ...prev, pendingAcks: Math.max(0, prev.pendingAcks - 1) } : prev));
    try {
      await api(`/api/meetings/${p.code}/decisions/ack`, {
        method: 'POST',
        body: { recapId: p.recapId, idx: p.idx },
      });
    } catch {
      reloadActions();
    }
  }

  /** 인박스에서 개인 할 일 완료 — 그룹 할 일은 [열기]로 그룹에서 처리 */
  async function doneFromInbox(id: number) {
    try {
      await api(`/api/todos/${id}`, { method: 'PATCH', body: { done: true } });
      setTodos((prev) => prev.map((x) => (x.id === id ? { ...x, done: 1 } : x)));
      reloadActions();
    } catch {
      /* 전역 토스트 */
    }
  }

  /** 미확인자 리마인드 — AI 총무 명의로 미확인 참가자에게만 (서버 1시간 쿨다운) */
  async function remindSent(e: SentEntry) {
    const key = `${e.recapId}-${e.idx}`;
    setReminding(key);
    try {
      const r = await api<{ reminded: number }>(`/api/meetings/${e.code}/decisions/remind`, {
        method: 'POST',
        body: { recapId: e.recapId, idx: e.idx },
      });
      window.dispatchEvent(
        new CustomEvent(r.reminded > 0 ? 'app:info' : 'app:error', {
          detail: r.reminded > 0 ? `${r.reminded}명에게 리마인드를 보냈어요` : '보낼 대상이 없어요 (쿨다운 중이거나 전원 확인)',
        }),
      );
    } catch {
      /* 전역 토스트 */
    } finally {
      setReminding(null);
    }
  }

  /** 우리 조 리마인드 — 마디(중간관리)가 조원 미확인자에게. AI 총무 명의 (서버 1시간 쿨다운) */
  async function remindTeam(e: { recapId: number; idx: number }, key: string) {
    if (typeof org !== 'number') return;
    setReminding(key);
    try {
      const r = await api<{ reminded: number }>(`/api/orgs/${org}/team-acks/remind`, {
        method: 'POST',
        body: { recapId: e.recapId, idx: e.idx },
      });
      window.dispatchEvent(
        new CustomEvent(r.reminded > 0 ? 'app:info' : 'app:error', {
          detail:
            r.reminded > 0
              ? `우리 조 미확인 ${r.reminded}명에게 리마인드를 보냈어요`
              : '보낼 대상이 없어요 (쿨다운 중이거나 전원 확인)',
        }),
      );
    } catch {
      /* 전역 토스트 */
    } finally {
      setReminding(null);
    }
  }

  // 발신자 카드 — 보낸 결정이 있을 때만 (행동 기반 노출)
  const sentCard = sent && sent.entries.length > 0 && (
    <div style={section} className="pd-sent">
      <div style={sectionHead}>
        <span style={headIcon}><ChartIcon size={16} /></span> 보낸 결정 도달 현황
        {sent.entries.some((e) => e.acked < e.total) && (
          <span className="pd-ack-count">{sent.entries.filter((e) => e.acked < e.total).length}</span>
        )}
        <span className="pd-inbox-hint">누가 아직인지, 여기서 보여요</span>
      </div>
      {sent.entries.slice(0, 5).map((e) => {
        const done = e.acked >= e.total;
        const key = `${e.recapId}-${e.idx}`;
        return (
          <div key={key} className={`pd-sent-row${done ? ' done' : ''}`}>
            <div
              className="pd-act-main"
              role="button"
              tabIndex={0}
              onClick={() => openMeeting(e.code, e.title)}
              onKeyDown={keyActivate(() => openMeeting(e.code, e.title))}
              title={`"${e.title}" 열기`}
            >
              <Marquee className="pd-act-title">
                {e.critical ? '🔴 ' : ''}
                {e.decision}
              </Marquee>
              <span className="pd-act-sub">
                {e.title} · 확인 {e.acked}/{e.total}
                {!done && e.missing.length > 0 && (
                  <span className="pd-sent-missing" title={e.missing.join(', ')}>
                    {' '}
                    — 미확인: {e.missing.slice(0, 3).map(displayNameOf).join(', ')}
                    {e.missing.length > 3 ? ` 외 ${e.missing.length - 3}명` : ''}
                  </span>
                )}
              </span>
              <span className="pd-sent-bar" aria-hidden>
                <i style={{ width: `${Math.round((e.acked / Math.max(1, e.total)) * 100)}%` }} />
              </span>
            </div>
            {done ? (
              <span className="pd-sent-done">
                <CheckMarkIcon size={12} /> 전원 확인
              </span>
            ) : (
              <button
                className="pd-ack-btn"
                disabled={reminding === key}
                onClick={() => void remindSent(e)}
                title="미확인자에게만 AI가 리마인드"
              >
                {reminding === key ? '보내는 중…' : '리마인드'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );

  const inboxCard = (
    <div style={section} className="pd-inbox">
      <div style={sectionHead}>
        <span style={headIcon}><CheckIcon size={16} /></span> 지금 처리할 것
        {inboxTotal > 0 && <span className="pd-ack-count">{inboxTotal}</span>}
        <span className="pd-inbox-hint">비우면 오늘 준비 끝</span>
      </div>
      {!actions ? (
        <div style={emptyRow}>불러오는 중…</div>
      ) : inboxTotal === 0 ? (
        <div className="pd-inbox-empty">
          <span className="pd-inbox-empty-ic"><CheckMarkIcon size={18} /></span>
          모두 처리했어요 — 오늘 준비 끝
          {(ov?.meetingCount ?? 1) === 0 && (
            <div className="pd-onboard">
              처음이신가요? <b>① 그룹 만들기</b> → <b>② 통화 시작</b> → <b>③ 통화가 끝나면 AI가
              결정·할 일을 자동 정리</b>해요. 왼쪽의 "새 그룹 만들기"부터 시작해보세요.
            </div>
          )}
        </div>
      ) : (
        <>
          {actions.decisions.map((p) => (
            <div key={`d-${p.recapId}-${p.idx}`} className="pd-act-row">
              <span className="pd-act-badge">결정</span>
              <div
                className="pd-act-main"
                role="button"
                tabIndex={0}
                onClick={() => openMeeting(p.code, p.title)}
                onKeyDown={keyActivate(() => openMeeting(p.code, p.title))}
                title={`"${p.title}" 열기`}
              >
                <Marquee className="pd-act-title">{p.decision}</Marquee>
                <span className="pd-act-sub">
                  {p.title} ·{' '}
                  {new Date(p.ts).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}{' '}
                  회의
                </span>
              </div>
              <button
                className="pd-ack-btn"
                onClick={() => void ackFromInbox(p)}
                title="수신확인 — 회람 사인"
              >
                확인
              </button>
            </div>
          ))}
          {/* 서명 대기 문서 — 클릭하면 그룹 탭→공동편집→문서로 착지해 바로 서명 */}
          {actions.pendingAcks.map((f) => (
            <div key={`f-${f.fileId}`} className="pd-act-row">
              <span className="pd-act-badge sign">서명</span>
              <div
                className="pd-act-main"
                role="button"
                tabIndex={0}
                onClick={() => openFileAck(f)}
                onKeyDown={keyActivate(() => openFileAck(f))}
                title={`"${f.title}"의 문서를 열어 서명`}
              >
                <Marquee className="pd-act-title">『{f.name}』 열람 서명 — {f.title}</Marquee>
                <span className="pd-act-sub">{f.title} · 문서 회람</span>
              </div>
              <button className="pd-ack-btn" onClick={() => openFileAck(f)} title="문서를 열어 열람 서명">
                서명
              </button>
            </div>
          ))}
          {actions.pendingAcksTotal > actions.pendingAcks.length && actions.pendingAcks[0] && (
            <div className="pd-act-row">
              <span className="pd-act-badge sign">서명</span>
              <div
                className="pd-act-main"
                role="button"
                tabIndex={0}
                onClick={() =>
                  openMeeting(actions.pendingAcks[0].code, actions.pendingAcks[0].title)
                }
                onKeyDown={keyActivate(() =>
                  openMeeting(actions.pendingAcks[0].code, actions.pendingAcks[0].title)
                )}
                title={`"${actions.pendingAcks[0].title}" 열기`}
              >
                <span className="pd-act-title">
                  서명 대기 문서 +{actions.pendingAcksTotal - actions.pendingAcks.length}건 더
                </span>
                <span className="pd-act-sub">그룹의 "확인 필요" 뷰에서 이어서 처리해요</span>
              </div>
            </div>
          )}
          {actions.todos.map((t) => {
            const b = dueBadge(t.due_at);
            return (
              <div key={`t-${t.id}`} className="pd-act-row">
                <span className="pd-act-badge todo">할일</span>
                <div
                  className="pd-act-main"
                  role="button"
                  tabIndex={0}
                  onClick={() => t.code && openMeeting(t.code, t.mtitle ?? t.code)}
                  onKeyDown={keyActivate(() => t.code && openMeeting(t.code, t.mtitle ?? t.code))}
                >
                  <span className="pd-act-title">
                    {t.title}
                    {b && <span className={`nb-todo-due ${b.cls}`}>{b.label}</span>}
                  </span>
                  <span className="pd-act-sub">{t.mtitle ?? '개인 할 일'} · 담당 나</span>
                </div>
                {t.code ? (
                  <button
                    className="pd-ack-btn solid"
                    onClick={() => openMeeting(t.code!, t.mtitle ?? t.code!)}
                  >
                    열기
                  </button>
                ) : (
                  <button className="pd-ack-btn" onClick={() => void doneFromInbox(t.id)}>
                    완료
                  </button>
                )}
              </div>
            );
          })}
          {actions.dms.map((d) => (
            <div key={`m-${d.userId}`} className="pd-act-row">
              <span className="pd-act-badge dm">DM</span>
              <div className="pd-act-main" role="button" tabIndex={0} onClick={() => setDmPeer(dmThread(d))} onKeyDown={keyActivate(() => setDmPeer(dmThread(d)))}>
                <span className="pd-act-title">
                  {d.name || d.username} · {d.lastText}
                </span>
                <span className="pd-act-sub">안 읽은 메시지 {d.unread}건</span>
              </div>
              <button className="pd-ack-btn" onClick={() => setDmPeer(dmThread(d))}>
                답장
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );

  // 최근 결정 카드 — "오늘 일정"이 히어로 문장·전체 일정 타임라인과 3중으로 겹쳐 교체(9/2 주호 결정).
  // 홈에서 유일하게 "확인 끝난 결정까지 포함해 결정이 흐르는 모습"이 보이는 자리. 0건이면 카드 자체를 숨긴다
  // 내가 아직 확인 안 한 결정은 "지금 처리할 것"에 이미 있으니 여기선 뺀다 — 카드끼리 역할이 안 겹치게
  // (여기 = 내가 확인한 결정이 팀에서 어디까지 퍼졌나)
  const recentMine = (recent ?? []).filter((d) => d.mine);
  const recentCard =
    recentMine.length === 0 ? null : (
      <div style={cellCard} className="pd-recent">
        <div style={sectionHead}>
          <span style={headIcon}><CheckMarkIcon size={16} /></span> 최근 결정
          <span className="pd-inbox-hint">내가 확인한 {recentMine.length}건</span>
        </div>
        {recentMine.map((d) => (
          <div key={`${d.recapId}-${d.idx}`} className="pd-act-row">
            <span className={`pd-act-badge${d.critical ? ' critical' : ''}`}>{d.critical ? '중요' : '결정'}</span>
            <div role="button" tabIndex={0} className="pd-act-main" onClick={() => openMeeting(d.code, d.title)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMeeting(d.code, d.title); } }} title={d.why || d.decision}>
              <Marquee className="pd-act-title">{d.decision}</Marquee>
              <span className="pd-act-sub">
                {d.title} · 팀 확인 {d.acked}/{d.total}
                {d.why ? ` · ${d.why}` : ''}
              </span>
            </div>
          </div>
        ))}
      </div>
    );

  const dmScope: DmScope = org === 'personal' ? 'personal' : org;
  const dmWin = dmPeer ? (
    <DmWindow
      scope={dmScope}
      peer={dmPeer}
      onClose={() => {
        setDmPeer(null);
        reloadActions();
      }}
      onActivity={() => {}}
    />
  ) : null;

  // ── 조직 홈 — 관리자는 팀 인사이트, 멤버는 "내 포커스" (내가 지금 챙길 것) ──
  if (org !== 'personal') {
    const orgInfo = orgs.find((o) => o.id === org);
    const orgName = orgInfo?.name ?? '조직';
    const orgManager = !!orgInfo?.isManager;
    /** 내 계층 — 카드 게이팅: field는 발신·현황 카드가 노이즈, relay는 "막힌 전달"이 최우선 */
    const myTier = orgInfo?.myTier ?? null;
    // 우리 조 확인 현황 — 마디의 존재 이유(막힌 전달 뚫기)를 카드 하나로
    const teamAcksCard = teamAcks && teamAcks.items.length > 0 && (
      <div style={section} className="pd-sent pd-teamacks">
        <div style={sectionHead}>
          <span style={headIcon}><UsersIcon size={16} /></span> 우리 조 확인 현황
          <span className="pd-ack-count">{teamAcks.items.length}</span>
          <span className="pd-inbox-hint">
            {teamAcks.department ? `${teamAcks.department} 기준` : '조직 전체 기준'} · 아직 안 본 사람
          </span>
        </div>
        {teamAcks.items.slice(0, 5).map((e) => {
          const key = `team-${e.recapId}-${e.idx}`;
          return (
            <div key={`${e.recapId}-${e.idx}`} className="pd-sent-row">
              <div
                className="pd-act-main"
                role="button"
                tabIndex={0}
                onClick={() => openMeeting(e.meetingCode, e.meetingTitle)}
                onKeyDown={keyActivate(() => openMeeting(e.meetingCode, e.meetingTitle))}
                title={`"${e.meetingTitle}" 열기`}
              >
                <Marquee className="pd-act-title">{e.text}</Marquee>
                <span className="pd-act-sub">
                  {e.meetingTitle} · 확인 {e.acked}/{e.total}
                  <span className="pd-sent-missing" title={e.missing.join(', ')}>
                    {' '}
                    — 미확인: {e.missing.slice(0, 3).map(displayNameOf).join(', ')}
                    {e.missing.length > 3 ? ` 외 ${e.missing.length - 3}명` : ''}
                  </span>
                </span>
                <span className="pd-sent-bar" aria-hidden>
                  <i style={{ width: `${Math.round((e.acked / Math.max(1, e.total)) * 100)}%` }} />
                </span>
              </div>
              {/* 우리 조 리마인드 — 마디의 행동 버튼. 조원 미확인자에게만 AI 총무 명의로 */}
              <button
                className="pd-ack-btn"
                disabled={reminding === key}
                onClick={() => void remindTeam(e, key)}
                title="우리 조 미확인자에게만 AI가 리마인드"
              >
                {reminding === key ? '보내는 중…' : '리마인드'}
              </button>
            </div>
          );
        })}
      </div>
    );
    return (
      <div className="pd-wrap" style={wrap}>
        {/* 히어로 — 카운트 한 줄 + AI 브리핑 문장 (시안1: 오늘 회의 N · 마감 지남 N · 미확인 결정 N) */}
        <div className="pd-hero org pd-hero2">
          <div className="pd-hero2-body">
            <div className="pd-hero2-meta">
              <BuildingIcon size={12} /> {orgName} ·{' '}
              {new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} ·{' '}
              {greeting()}, {user?.name || user?.username}
            </div>
            {heroLine}
            {heroDaily}
          </div>
        </div>

        {live && (
          <div
            style={liveBox}
            className="pd-live-banner"
            role="button"
            tabIndex={0}
            onClick={() => openMeeting(live.code, live.title)}
            onKeyDown={(e) => e.key === 'Enter' && openMeeting(live.code, live.title)}
          >
            <span className="pd-live-dot" aria-hidden /> 지금 <b>{live.title}</b>에서 {live.inCall}명
            통화 중 — 눌러서 바로 참여
          </div>
        )}

        {inboxCard}

        {teamAcksCard}

        {/* 발신 카드 — field에겐 노이즈(결정을 보내는 쪽이 아님), 나머지는 유지 */}
        {myTier !== 'field' && sentCard}

        <div className="pd-quad">
          <div className="pd-quad-col">
            {recentCard}
            <div style={cellCard}>
              <div style={sectionHead}><span style={headIcon}><CalendarIcon size={16} /></span> 전체 일정</div>
              <ScheduleWidget schedule={schedule} onOpen={openMeeting} />
            </div>
            {/* 빠른 시작 — 권한제 그룹 생성 + 조직도 */}
            <div style={cellCard}>
              <div style={sectionHead}><span style={headIcon}><BoltIcon size={16} /></span> 빠른 시작</div>
              <div className="pd-actions" style={actionRow}>
                {(orgInfo?.canCreateGroup ?? true) && (
                  <button style={actionBtn} onClick={newMeeting}>
                    <span style={{ fontSize: 20 }}>＋</span> 새 그룹 만들기
                  </button>
                )}
                <button style={actionBtn} onClick={() => navigate(`/org/${org}`)}>
                  <UsersIcon size={17} /> 조직도 보기
                </button>
              </div>
            </div>
          </div>

          <div className="pd-quad-col">
            {todoCard}
            <div className="pd-org-inbox" style={{ ...cellCard, minHeight: 420 }}>
              <div style={sectionHead}><span style={headIcon}><ChatIcon size={16} /></span> 통합 메시지</div>
              <UnifiedInbox scope={org} />
            </div>
          </div>
        </div>

        {/* 팀 인사이트 — 한 줄 접힘 (시안: "✦ 팀 인사이트 · 자세히") */}
        <div style={cellCard} className="pd-insight-line-card">
          <button className="pd-insight-line" onClick={() => setStatsOpen((v) => !v)}>
            <SparklesIcon size={14} /> {orgManager ? '팀 인사이트' : '내 포커스'}
            <span className="pd-insight-line-more">{statsOpen ? '접기 ▴' : '자세히 ▾'}</span>
          </button>
          {statsOpen && (
            <div className="pd-insight-body">
              {orgManager ? <InsightsPanel orgId={org} /> : <MyOrgFocus orgId={org} />}
            </div>
          )}
        </div>

        {dmWin}
      </div>
    );
  }

  // ── 개인 홈 (내 중심) ──
  return (
    <div className="pd-wrap" style={wrap}>
      <div className="pd-hero personal">
        {/* 모바일: 헤더에 프로필이 없어서 여기가 프로필 수정 진입점 (✎ 뱃지는 모바일만 표시) */}
        <button
          className="pd-hero-avatar pd-hero-edit"
          onClick={() => window.dispatchEvent(new Event('exist:open-settings'))}
          title="프로필 수정"
        >
          {avatarIsImg ? (
            <img
              src={avatarVal}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            avatarVal
          )}
          <span className="pd-hero-edit-badge" aria-hidden>
            <PenIcon size={11} />
          </span>
        </button>
        <div className="pd-hero2-body">
          <div className="pd-hero2-meta">
            {/* 워크스페이스 표기는 모바일에선 숨김 — 상단 조직 바가 이미 보여줌 */}
            <span className="pd-ws-tag"><UserIcon size={12} /> 개인 워크스페이스 · </span>
            {new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} ·{' '}
            {greeting()}, {user?.name || user?.username || '게스트'}
            {ov?.nextMeeting && nextStr && (
              <span className="pd-hero2-next"> · 다음 일정 {ov.nextMeeting.title} {nextStr}</span>
            )}
          </div>
          {heroLine}
          {heroDaily}
        </div>
      </div>

      {live && (
        <div
          style={liveBox}
          className="pd-live-banner"
          role="button"
          tabIndex={0}
          onClick={() => openMeeting(live.code, live.title)}
          onKeyDown={(e) => e.key === 'Enter' && openMeeting(live.code, live.title)}
        >
          <span className="pd-live-dot" aria-hidden /> 지금 <b>{live.title}</b>에서 {live.inCall}명 통화 중 — 눌러서 바로 참여
        </div>
      )}

      {inboxCard}

        {sentCard}

      <div className="pd-quad">
        {/* 좌 = 오늘·못 본 사이·달력, 우 = 할 일·메시지 */}
        <div className="pd-quad-col">
        {recentCard}
        {catchup && catchup.items.length > 0 && (
          <div style={cellCard}>
            <div style={sectionHead}><span style={headIcon}><SparklesIcon size={16} /></span> 못 본 사이</div>
            {catchup.items.slice(0, 5).map((it, i) => (
              <div
                key={i}
                style={{ ...listRow, cursor: it.meeting ? 'pointer' : 'default' }}
                role={it.meeting ? 'button' : undefined}
                tabIndex={it.meeting ? 0 : undefined}
                onClick={() => it.meeting && openMeeting(it.meeting.code, it.meeting.title)}
                onKeyDown={keyActivate(() => it.meeting && openMeeting(it.meeting.code, it.meeting.title))}
                title={it.meeting ? `"${it.meeting.title}" 열기` : undefined}
              >
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 6,
                    background: it.type === 'recap' ? 'var(--green-soft)' : 'var(--surface-2)',
                    color: it.type === 'recap' ? 'var(--green)' : 'var(--text-sub)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {CATCHUP_BADGE[it.type]}
                </span>
                <Marquee className="pd-catchup-text">{it.text}</Marquee>
              </div>
            ))}
          </div>
        )}
        <div style={cellCard}>
          <div style={sectionHead}><span style={headIcon}><CalendarIcon size={16} /></span> 전체 일정</div>
          <ScheduleWidget schedule={schedule} onOpen={openMeeting} />
        </div>
        </div>

        <div className="pd-quad-col">
        {todoCard}

        <div style={cellCard}>
          <div style={sectionHead}><span style={headIcon}><ChatIcon size={16} /></span> 통합 메시지</div>
          <UnifiedInbox scope={org} />
        </div>
        </div>
      </div>

      {/* 내 지표 — 한 줄 접힘 (시안: 인사이트 라인) */}
      <div style={cellCard} className="pd-insight-line-card">
        <button className="pd-insight-line" onClick={() => setStatsOpen((v) => !v)}>
          <ChartIcon size={14} /> 내 지표 · 참여 그룹 <b>{ov?.meetingCount ?? 0}</b> · 할 일{' '}
          <b>{doneCount}/{todos.length}</b>{todos.length > 0 && <> ({donePct}%)</>} · 이번 주 결정{' '}
          <b>{ov?.weekDecisions ?? 0}</b> · 이번 주 일정 <b>{weekCount}</b>
          <span className="pd-insight-line-more">{statsOpen ? '접기 ▴' : '자세히 ▾'}</span>
        </button>
        {statsOpen && (
          <div className="pd-stats" style={{ marginTop: 14 }}>
            <div className="pd-stat">
              <div className="pd-stat-icon"><UsersIcon size={19} /></div>
              <div>
                <div className="pd-stat-num">{ov?.meetingCount ?? 0}</div>
                <div className="pd-stat-label">참여 그룹</div>
              </div>
            </div>
            <div className="pd-stat">
              <div className="pd-stat-icon"><CheckMarkIcon size={19} /></div>
              <div>
                <div className="pd-stat-num">
                  {doneCount}/{todos.length}
                  {todos.length > 0 && <span className="pd-stat-sub"> · {donePct}%</span>}
                </div>
                <div className="pd-stat-label">할 일 완료</div>
              </div>
            </div>
            {/* 이번 주 결정 — "결정이 조직에 남는다"의 홈 지표 (P1) */}
            <div className="pd-stat">
              <div className="pd-stat-icon"><BoltIcon size={19} /></div>
              <div>
                <div className="pd-stat-num">{ov?.weekDecisions ?? 0}</div>
                <div className="pd-stat-label">이번 주 결정</div>
              </div>
            </div>
            <div className="pd-stat">
              <div className="pd-stat-icon"><CalendarIcon size={19} /></div>
              <div>
                <div className="pd-stat-num">{weekCount}</div>
                <div className="pd-stat-label">이번 주 일정</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {dmWin}
    </div>
  );
}

// 패딩은 index.css의 .pd-wrap — 인라인이면 모바일 미디어쿼리가 못 줄임
const wrap: CSSProperties = {
  height: '100%',
  overflow: 'auto',
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

/* 히어로 배너 레이아웃은 index.css의 .pd-hero*·.pd-hero2* (모바일 축소 때문에 클래스) */
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
// 그리드 컨테이너(.pd-quad, .pd-stats)는 index.css — 인라인이면 미디어쿼리가 못 건드림
// grid 셀 카드 — section의 marginBottom을 없애 gap(14)만 세로 간격으로 적용
const cellCard: CSSProperties = { ...section, marginBottom: 0 };
// 내 지표 카드(.pd-stat*)는 index.css — 모바일에서 아이콘·글자 축소
const listRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 2px',
  fontSize: 14,
  borderBottom: '1px solid var(--border)',
};
const emptyRow: CSSProperties = { fontSize: 13, color: 'var(--text-sub)', padding: '8px 2px' };
