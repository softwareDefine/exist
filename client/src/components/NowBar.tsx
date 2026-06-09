import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import Logo from './Logo';
import SettingsModal from './SettingsModal';
import NotificationCenter from './NotificationCenter';
import Avatar from './Avatar';
import MeetingThumb from './MeetingThumb';
import { PanelLeftIcon, CheckMarkIcon, SunIcon, MoonIcon, SparklesIcon } from './Icons';

function ThemeToggle() {
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('exist:theme', next ? 'dark' : 'light');
    setDark(next);
  }
  return (
    <button className="nowbar-theme" onClick={toggle} title={dark ? '라이트 모드' : '다크 모드'}>
      {dark ? <SunIcon size={18} /> : <MoonIcon size={17} />}
    </button>
  );
}

export interface Todo {
  id: number;
  title: string;
  done: number;
  due_at: string | null;
}

export interface Meeting {
  id: number;
  code: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  thumbnail?: string | null;
  /** 반복 회의를 펼친 occurrence 고유키 (일정 목록용) */
  occId?: string;
  recur?: string;
}

const RECUR_LABEL: Record<string, string> = {
  daily: '매일',
  weekly: '매주',
  biweekly: '격주',
  monthly: '매월',
};

const mkey = (m: Meeting) => m.occId ?? String(m.id);

/** "7월 8일 (오후) 4시 40분" 형식 */
function formatNow(d: Date): string {
  const ampm = d.getHours() < 12 ? '오전' : '오후';
  const h12 = d.getHours() % 12 || 12;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${ampm}) ${h12}시 ${d.getMinutes()}분`;
}

/** "3시간 30분 뒤" */
function formatDiff(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}분 뒤`;
  if (m === 0) return `${h}시간 뒤`;
  return `${h}시간 ${m}분 뒤`;
}

/** 다음 일정 시작 표기 — 당일: "5시간 30분 뒤" / 내일: "내일 오전 8시" / 그 외: "6/12 오후 2시" */
function formatStart(start: Date, now: Date): string {
  const sameDay = start.toDateString() === now.toDateString();
  if (sameDay) return formatDiff(start.getTime() - now.getTime());
  const ampm = start.getHours() < 12 ? '오전' : '오후';
  const h12 = start.getHours() % 12 || 12;
  const min = start.getMinutes();
  const time = `${ampm} ${h12}시${min ? ` ${min}분` : ''}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (start.toDateString() === tomorrow.toDateString()) return `내일 ${time}`;
  return `${start.getMonth() + 1}/${start.getDate()} ${time}`;
}

interface CurrentCtx {
  meeting: Meeting;
  ongoing: boolean;
  label: string; // "종료 3시간 30분 뒤" / "시작 5분 뒤"
}

/** 현재 컨텍스트 회의: 진행 중 > 가장 가까운 예정 */
function currentMeeting(meetings: Meeting[], now: Date): CurrentCtx | null {
  const t = now.getTime();
  const timed = meetings.filter((m) => m.starts_at);
  const ongoing = timed.find(
    (m) => new Date(m.starts_at!) <= now && m.ends_at && now < new Date(m.ends_at),
  );
  if (ongoing) {
    return {
      meeting: ongoing,
      ongoing: true,
      label: formatDiff(new Date(ongoing.ends_at!).getTime() - t),
    };
  }
  const upcoming = timed
    .filter((m) => new Date(m.starts_at!).getTime() > t)
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime())[0];
  if (upcoming) {
    return {
      meeting: upcoming,
      ongoing: false,
      label: formatStart(new Date(upcoming.starts_at!), now),
    };
  }
  return null;
}

/** AI 자동 관리 — 지금 상황에 가장 알맞은 카드를 고른다.
 *  0: 일정  1: 할 일  2: 진행 타임라인 */
function suggestCard(
  ctx: CurrentCtx | null,
  meetings: Meeting[],
  todos: Todo[],
  now: Date,
): { card: number; reason: string } {
  const t = now.getTime();

  // 1) 회의 진행 중 → 타임라인
  if (ctx?.ongoing) return { card: 2, reason: '회의가 진행 중이에요' };

  const pending = todos.filter((td) => !td.done);
  const dueSoon = pending.filter((td) => {
    if (!td.due_at) return false;
    const due = new Date(td.due_at).getTime();
    return due <= t + 24 * 3600_000; // 마감 지났거나 24시간 내
  });

  // 2) 30분 내 시작하는 회의 → 일정
  if (ctx && !ctx.ongoing && ctx.meeting.starts_at) {
    const mins = (new Date(ctx.meeting.starts_at).getTime() - t) / 60_000;
    if (mins <= 30) return { card: 0, reason: '곧 시작하는 회의가 있어요' };
  }

  // 3) 임박한 할 일 → 할 일
  if (dueSoon.length > 0) return { card: 1, reason: '마감이 가까운 할 일이 있어요' };

  // 4) 오늘 남은 예정 회의 → 일정
  const todayUpcoming = meetings.some(
    (m) =>
      m.starts_at &&
      new Date(m.starts_at).getTime() > t &&
      new Date(m.starts_at).toDateString() === now.toDateString(),
  );
  if (todayUpcoming) return { card: 0, reason: '오늘 예정된 회의가 있어요' };

  // 5) 안 끝낸 할 일 → 할 일
  if (pending.length > 0) return { card: 1, reason: '할 일이 남아 있어요' };

  // 6) 기본 → 일정
  return { card: 0, reason: '다가오는 일정을 보여드려요' };
}

/** 모드 카드 공통 — 왼쪽 현재 회의 블록 */
function CurrentBlock({
  ctx,
  onOpen,
}: {
  ctx: CurrentCtx | null;
  onOpen?: (m: Meeting) => void;
}) {
  if (!ctx) {
    return (
      <div className="nb-current">
        <div className="nb-thumb none" />
        <div className="nb-current-text">
          <div className="title">회의 없음</div>
          <div className="countdown tag">예정된 회의가 없습니다</div>
        </div>
      </div>
    );
  }
  return (
    <div
      className={`nb-current${onOpen ? ' clickable' : ''}`}
      onClick={onOpen ? () => onOpen(ctx.meeting) : undefined}
      title={onOpen ? '클릭하면 회의 공간이 열려요' : undefined}
    >
      <MeetingThumb
        id={ctx.meeting.id}
        title={ctx.meeting.title}
        thumbnail={ctx.meeting.thumbnail}
        className="nb-thumb"
      />
      <div className="nb-current-text">
        <div className="title" title={ctx.meeting.title}>
          {ctx.meeting.title}
        </div>
        <div className="countdown">
          <b>{ctx.ongoing ? '종료' : '시작'}</b> {ctx.label}
        </div>
      </div>
    </div>
  );
}

/** 확장 패널 — 월 캘린더 (nowbar.png 첫 번째 모드) */
function MonthCalendar({ meetings, now }: { meetings: Meeting[]; now: Date }) {
  const [offset, setOffset] = useState(0);
  const base = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const year = base.getFullYear();
  const month = base.getMonth();
  const startDow = base.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();

  const meetingDays = new Set(
    meetings
      .filter((m) => {
        if (!m.starts_at) return false;
        const d = new Date(m.starts_at);
        return d.getFullYear() === year && d.getMonth() === month;
      })
      .map((m) => new Date(m.starts_at!).getDate()),
  );

  const cells: { day: number; cur: boolean }[] = [];
  for (let i = startDow - 1; i >= 0; i--) cells.push({ day: prevDays - i, cur: false });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, cur: true });
  while (cells.length % 7 !== 0) cells.push({ day: cells.length - startDow - daysInMonth + 1, cur: false });

  const isToday = (d: number, cur: boolean) =>
    cur && offset === 0 && d === now.getDate();

  return (
    <div className="nb-cal">
      <div className="nb-cal-head">
        <button onClick={() => setOffset((o) => o - 1)}>‹</button>
        <span>
          {year}년 {month + 1}월
        </span>
        <button onClick={() => setOffset((o) => o + 1)}>›</button>
      </div>
      <div className="nb-cal-grid">
        {['일', '월', '화', '수', '목', '금', '토'].map((w) => (
          <span key={w} className="nb-cal-dow">
            {w}
          </span>
        ))}
        {cells.map((c, i) => (
          <span
            key={i}
            className={`nb-cal-day${c.cur ? '' : ' out'}${isToday(c.day, c.cur) ? ' today' : ''}`}
          >
            {c.day}
            {c.cur && meetingDays.has(c.day) && <i className="nb-cal-mark" />}
          </span>
        ))}
      </div>
    </div>
  );
}

interface Props {
  todos?: Todo[];
  meetings?: Meeting[];
  onToggleTodo?: (todo: Todo) => void;
  onAddTodo?: (title: string) => void;
  /** 일정 클릭 → 회의 탭 열기 */
  onOpenMeeting?: (m: Meeting) => void;
  /** "+ 일정 추가" → 회의 일정 잡기 모달 */
  onSchedule?: () => void;
  /** 사이드바 열고 닫기 */
  onToggleSidebar?: () => void;
}

function SidebarToggle({ onToggle }: { onToggle?: () => void }) {
  if (!onToggle) return null;
  return (
    <button className="nowbar-sidebar-toggle" onClick={onToggle} title="사이드바 열기/닫기">
      <PanelLeftIcon size={20} />
    </button>
  );
}

const CARD_COUNT = 3;

function ProfileMenu({
  avatar,
  onOpenSettings,
}: {
  avatar: string;
  onOpenSettings: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  return (
    <div className="nowbar-profile">
      <Avatar value={avatar} className="nowbar-avatar" />
      <div className="profile-menu">
        <div className="profile-menu-box">
          <div className="profile-name">
            <Avatar value={avatar} className="profile-name-avatar" /> <b>{user?.username}</b>
          </div>
          <button className="profile-item" onClick={onOpenSettings}>
            ⚙️ 설정
          </button>
          <button className="profile-item danger" onClick={logout}>
            🚪 로그아웃
          </button>
        </div>
      </div>
    </div>
  );
}

export default function NowBar({
  todos = [],
  meetings = [],
  onToggleTodo,
  onAddTodo,
  onOpenMeeting,
  onSchedule,
  onToggleSidebar,
}: Props) {
  const [newTodo, setNewTodo] = useState('');
  const [now, setNow] = useState(() => new Date());
  const [brief, setBrief] = useState('');
  const [aiCard, setAiCard] = useState<number | null>(null);
  const [aiReason, setAiReason] = useState('');
  const [aiSource, setAiSource] = useState<'ai' | 'rule' | null>(null);
  const [card, setCard] = useState(0);
  const [auto, setAuto] = useState(true);
  const [avatar, setAvatar] = useState('🐧');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const wheelLock = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 프로필 아바타 로드
  useEffect(() => {
    api<{ avatar: string }>('/api/auth/me')
      .then((m) => setAvatar(m.avatar || '🐧'))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  // AI 브리핑 — 2분마다 갱신
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const b = await api<{ text: string; card?: number; reason?: string; source?: 'ai' | 'rule' }>(
          '/api/agent/brief',
        );
        if (!alive) return;
        setBrief(b.text);
        if (typeof b.card === 'number') setAiCard(b.card);
        if (b.reason) setAiReason(b.reason);
        setAiSource(b.source ?? null);
      } catch {
        /* 무시 */
      }
    }
    void load();
    const t = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [todos, meetings]);

  // 사용자가 직접 카드를 넘기면 잠깐 수동 모드 — 30초 쉬면 다시 AI가 맡는다
  function pauseAuto() {
    setAuto(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setAuto(true), 30_000);
  }

  function onWheel(e: React.WheelEvent) {
    const nowMs = Date.now();
    if (nowMs - wheelLock.current < 450) return;
    if (Math.abs(e.deltaY) < 8) return;
    wheelLock.current = nowMs;
    pauseAuto();
    setCard((c) => (c + (e.deltaY > 0 ? 1 : -1) + CARD_COUNT) % CARD_COUNT);
  }

  // AI 자동/수동 토글 버튼
  function toggleAuto() {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setAuto((a) => !a);
  }

  const ctx = currentMeeting(meetings, now);
  // 로컬 즉시 판단(폴백) — AI 응답 도착 전이나 오프라인에서 사용
  const localSug = suggestCard(ctx, meetings, todos, now);
  // 진행 중 회의는 즉시성을 위해 로컬이 우선, 그 외엔 서버 AI 결정을 따른다
  const targetCard = ctx?.ongoing ? 2 : aiCard ?? localSug.card;
  const reasonText = aiSource === 'ai' && aiReason ? aiReason : localSug.reason;

  // 자동 모드일 때 — 상황이 바뀌면 AI 판단대로 카드 전환
  useEffect(() => {
    if (auto && targetCard !== card) setCard(targetCard);
  }, [auto, targetCard, card]);

  // 정리
  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);

  // 다음 일정 (현재 컨텍스트 제외, 최대 2개)
  const nexts = meetings
    .filter(
      (m) =>
        m.starts_at &&
        new Date(m.starts_at).getTime() > now.getTime() &&
        mkey(m) !== (ctx ? mkey(ctx.meeting) : ''),
    )
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime())
    .slice(0, 2);

  const shownTodos = [...todos].sort((a, b) => a.done - b.done).slice(0, 2);

  // 시간 모드 — 진행 중 회의 타임라인
  let timeline: { pct: number; ticks: { pct: number; label: string }[] } | null = null;
  if (ctx?.ongoing && ctx.meeting.starts_at && ctx.meeting.ends_at) {
    const s = new Date(ctx.meeting.starts_at).getTime();
    const e = new Date(ctx.meeting.ends_at).getTime();
    const pct = Math.min(100, Math.max(0, ((now.getTime() - s) / (e - s)) * 100));
    const ticks: { pct: number; label: string }[] = [];
    const first = new Date(ctx.meeting.starts_at);
    first.setMinutes(0, 0, 0);
    first.setHours(first.getHours() + 1);
    for (let t = first.getTime(); t < e; t += 3600_000) {
      const h = new Date(t).getHours();
      ticks.push({ pct: ((t - s) / (e - s)) * 100, label: `${h % 12 || 12}시` });
    }
    timeline = { pct, ticks };
  }

  /** 스택 내 상대 위치: front / next(오른쪽 아래 겹침) / hidden */
  const stackCls = (i: number) => {
    const rel = (i - card + CARD_COUNT) % CARD_COUNT;
    return rel === 0 ? ' front' : rel === 1 ? ' next' : ' hidden';
  };

  // 아무 데이터도 없으면 온보딩 카드만
  const isEmpty = meetings.filter((m) => m.starts_at).length === 0 && todos.length === 0;

  if (isEmpty) {
    return (
      <header className="nowbar">
        <Logo />
        <SidebarToggle onToggle={onToggleSidebar} />
        <div className="nowbar-pill">
          <div className="nowbar-card front nb-onboard">
            ✨ 일정이나 할 일을 추가해 <b>nowbar</b>를 사용해보세요
          </div>
        </div>
        <span className="nowbar-clock">{formatNow(now)}</span>
        <ThemeToggle />
        <NotificationCenter />
        <ProfileMenu avatar={avatar} onOpenSettings={() => setSettingsOpen(true)} />
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          avatar={avatar}
          onAvatarChange={setAvatar}
        />
      </header>
    );
  }

  return (
    <header className="nowbar">
      <Logo />
      <SidebarToggle onToggle={onToggleSidebar} />

      <div className="nowbar-pill" onWheel={onWheel} title="스크롤로 카드 전환">
        {/* 카드 1 — 다음/이전 일정 모드 */}
        <div className={`nowbar-card${stackCls(0)}`}>
          <CurrentBlock ctx={ctx} onOpen={onOpenMeeting} />
          <div className="nowbar-divider" />
          <div className="nb-next-list">
            {nexts.map((m) => (
              <div
                key={mkey(m)}
                className={`nb-next-row${onOpenMeeting ? ' clickable' : ''}`}
                onClick={onOpenMeeting ? () => onOpenMeeting(m) : undefined}
                title={onOpenMeeting ? '클릭하면 회의 공간이 열려요' : undefined}
              >
                <MeetingThumb id={m.id} title={m.title} thumbnail={m.thumbnail} className="nb-mini-thumb" />
                <span className="nb-next-title">{m.title}</span>
                {m.recur && m.recur !== 'none' && (
                  <span className="nb-recur-tag">{RECUR_LABEL[m.recur] ?? '반복'}</span>
                )}
                <span className="nb-next-start">
                  <b>시작</b> {formatStart(new Date(m.starts_at!), now)}
                </span>
              </div>
            ))}
            {nexts.length === 0 && <div className="nb-next-empty">다음 일정이 없어요</div>}
          </div>
        </div>

        {/* 카드 2 — todo list 모드 */}
        <div className={`nowbar-card${stackCls(1)}`}>
          <CurrentBlock ctx={ctx} onOpen={onOpenMeeting} />
          <div className="nowbar-divider" />
          <div className="nowbar-todos">
            {shownTodos.map((todo) => (
              <div key={todo.id} className={`nowbar-todo${todo.done ? ' done' : ''}`}>
                <span className="nowbar-todo-check" aria-hidden>
                  <CheckMarkIcon size={14} />
                </span>
                <span className="nowbar-todo-text">{todo.title}</span>
              </div>
            ))}
            {todos.length === 0 && <div className="nowbar-todo">투두를 추가해보세요</div>}
          </div>
        </div>

        {/* 카드 3 — 시간 보는 모드 (타임라인) */}
        <div className={`nowbar-card${stackCls(2)}`}>
          <CurrentBlock ctx={ctx} onOpen={onOpenMeeting} />
          <div className="nowbar-divider" />
          {timeline ? (
            <div className="nb-timeline">
              <div className="nb-timeline-fill" style={{ width: `${timeline.pct}%` }} />
              {timeline.ticks.map((t, i) => (
                <span key={i} className="nb-tick" style={{ left: `${t.pct}%` }}>
                  {t.label}
                </span>
              ))}
            </div>
          ) : (
            <div className="nb-next-empty">진행 중인 회의가 없어요</div>
          )}
        </div>

        {/* AI 자동 관리 토글 */}
        <button
          className={`nowbar-auto${auto ? ' on' : ''}`}
          onClick={toggleAuto}
          title={
            auto
              ? `${aiSource === 'ai' ? 'exist AI' : 'AI'}가 관리 중 · ${reasonText}`
              : 'AI 자동 관리 켜기'
          }
        >
          <SparklesIcon size={12} />
          {auto ? 'AI' : '수동'}
        </button>

        {/* 카드 위치 점 */}
        <div className="nowbar-dots">
          {Array.from({ length: CARD_COUNT }, (_, i) => (
            <button
              key={i}
              className={`nowbar-dot${i === card ? ' active' : ''}`}
              onClick={() => {
                pauseAuto();
                setCard(i);
              }}
              aria-label={`카드 ${i + 1}`}
            />
          ))}
        </div>

        {/* hover 확장 패널 — 현재 카드 모드의 상세 */}
        <div className="nowbar-expand">
          <div className="nowbar-expand-box">
            {/* key=card → 카드 전환 시 내용도 끌려나오는 애니메이션 재생 */}
            <div className="nb-expand-content" key={card}>
            {card === 0 && (
              <div className="nb-expand-schedule">
                <MonthCalendar meetings={meetings} now={now} />
                <div className="nb-upcoming">
                  <div className="nb-expand-title">
                    다가오는 일정
                    {onSchedule && (
                      <button type="button" className="nb-sched-add" onClick={onSchedule}>
                        + 일정 추가
                      </button>
                    )}
                  </div>
                  {meetings
                    .filter((m) => m.starts_at && new Date(m.starts_at) > now)
                    .sort(
                      (a, b) =>
                        new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime(),
                    )
                    .slice(0, 5)
                    .map((m) => (
                      <div
                        key={mkey(m)}
                        className={`nb-next-row${onOpenMeeting ? ' clickable' : ''}`}
                        onClick={onOpenMeeting ? () => onOpenMeeting(m) : undefined}
                        title={onOpenMeeting ? '클릭하면 회의 공간이 열려요' : undefined}
                      >
                        <MeetingThumb id={m.id} title={m.title} thumbnail={m.thumbnail} className="nb-mini-thumb" />
                        <span className="nb-next-title">{m.title}</span>
                        {m.recur && m.recur !== 'none' && (
                          <span className="nb-recur-tag">{RECUR_LABEL[m.recur] ?? '반복'}</span>
                        )}
                        <span className="nb-next-start">
                          <b>시작</b> {formatStart(new Date(m.starts_at!), now)}
                        </span>
                      </div>
                    ))}
                  {meetings.filter((m) => m.starts_at && new Date(m.starts_at) > now).length ===
                    0 && <div className="nb-next-empty">예정된 일정이 없어요</div>}
                </div>
              </div>
            )}

            {card === 1 && (
              <div className="nb-expand-todos">
                <div className="nb-expand-title">할 일</div>
                {[...todos].sort((a, b) => a.done - b.done).map((todo) => (
                  <label key={todo.id} className={`nowbar-todo${todo.done ? ' done' : ''}`}>
                    <input
                      type="checkbox"
                      checked={!!todo.done}
                      onChange={() => onToggleTodo?.(todo)}
                    />
                    <span className="nowbar-todo-check" aria-hidden>
                      <CheckMarkIcon size={14} />
                    </span>
                    <span className="nowbar-todo-text">{todo.title}</span>
                  </label>
                ))}
                {todos.length === 0 && <div className="nb-next-empty">할 일이 없어요</div>}
                {onAddTodo && (
                  <form
                    className="nb-todo-add"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!newTodo.trim()) return;
                      onAddTodo(newTodo);
                      setNewTodo('');
                    }}
                  >
                    <input
                      placeholder="할 일 추가"
                      value={newTodo}
                      onChange={(e) => setNewTodo(e.target.value)}
                    />
                    <button type="submit">+</button>
                  </form>
                )}
              </div>
            )}

            {card === 2 && (
              <div className="nb-expand-time">
                <div className="nb-expand-title">진행 상황</div>
                {ctx?.ongoing && ctx.meeting.starts_at && ctx.meeting.ends_at ? (
                  <>
                    <div className="nb-time-range">
                      <span>{formatNow(new Date(ctx.meeting.starts_at))} 시작</span>
                      <span>{formatNow(new Date(ctx.meeting.ends_at))} 종료</span>
                    </div>
                    {timeline && (
                      <div className="nb-timeline big">
                        <div
                          className="nb-timeline-fill"
                          style={{ width: `${timeline.pct}%` }}
                        />
                        {timeline.ticks.map((t, i) => (
                          <span key={i} className="nb-tick" style={{ left: `${t.pct}%` }}>
                            {t.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="nb-next-empty">진행 중인 회의가 없어요</div>
                )}
              </div>
            )}
            </div>

            {/* 공통 푸터 — exist AI 브리핑 */}
            <div className="nb-expand-footer">
              <span className="ai-badge">
                <span className="dot" />
                exist AI
              </span>
              <span className="ai-text">{brief || '상황을 분석하는 중이에요…'}</span>
            </div>
          </div>
        </div>
      </div>

      <span className="nowbar-clock">{formatNow(now)}</span>

      <ThemeToggle />
      <NotificationCenter />
      <ProfileMenu avatar={avatar} onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        avatar={avatar}
        onAvatarChange={setAvatar}
      />
    </header>
  );
}
