import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import Logo from './Logo';
import SettingsModal from './SettingsModal';
import NotificationCenter from './NotificationCenter';
import Avatar from './Avatar';
import MeetingThumb from './MeetingThumb';

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
}

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
        <div className="nb-thumb none">—</div>
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
}: Props) {
  const [newTodo, setNewTodo] = useState('');
  const [now, setNow] = useState(() => new Date());
  const [brief, setBrief] = useState('');
  const [card, setCard] = useState(0);
  const [avatar, setAvatar] = useState('🐧');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const wheelLock = useRef(0);

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
        const b = await api<{ text: string }>('/api/agent/brief');
        if (alive) setBrief(b.text);
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

  function onWheel(e: React.WheelEvent) {
    const nowMs = Date.now();
    if (nowMs - wheelLock.current < 450) return;
    if (Math.abs(e.deltaY) < 8) return;
    wheelLock.current = nowMs;
    setCard((c) => (c + (e.deltaY > 0 ? 1 : -1) + CARD_COUNT) % CARD_COUNT);
  }

  const ctx = currentMeeting(meetings, now);

  // 다음 일정 (현재 컨텍스트 제외, 최대 2개)
  const nexts = meetings
    .filter(
      (m) =>
        m.starts_at &&
        new Date(m.starts_at).getTime() > now.getTime() &&
        m.id !== ctx?.meeting.id,
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
        <div className="nowbar-pill">
          <div className="nowbar-card front nb-onboard">
            ✨ 일정이나 할 일을 추가해 <b>nowbar</b>를 사용해보세요
          </div>
        </div>
        <span className="nowbar-clock">{formatNow(now)}</span>
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

      <div className="nowbar-pill" onWheel={onWheel} title="스크롤로 카드 전환">
        {/* 카드 1 — 다음/이전 일정 모드 */}
        <div className={`nowbar-card${stackCls(0)}`}>
          <CurrentBlock ctx={ctx} onOpen={onOpenMeeting} />
          <div className="nowbar-divider" />
          <div className="nb-next-list">
            {nexts.map((m) => (
              <div
                key={m.id}
                className={`nb-next-row${onOpenMeeting ? ' clickable' : ''}`}
                onClick={onOpenMeeting ? () => onOpenMeeting(m) : undefined}
                title={onOpenMeeting ? '클릭하면 회의 공간이 열려요' : undefined}
              >
                <MeetingThumb id={m.id} title={m.title} thumbnail={m.thumbnail} className="nb-mini-thumb" />
                <span className="nb-next-title">{m.title}</span>
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
                <input type="checkbox" checked={!!todo.done} readOnly />
                {todo.title}
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

        {/* 카드 위치 점 */}
        <div className="nowbar-dots">
          {Array.from({ length: CARD_COUNT }, (_, i) => (
            <button
              key={i}
              className={`nowbar-dot${i === card ? ' active' : ''}`}
              onClick={() => setCard(i)}
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
                  <div className="nb-expand-title">다가오는 일정</div>
                  {meetings
                    .filter((m) => m.starts_at && new Date(m.starts_at) > now)
                    .sort(
                      (a, b) =>
                        new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime(),
                    )
                    .slice(0, 5)
                    .map((m) => (
                      <div
                        key={m.id}
                        className={`nb-next-row${onOpenMeeting ? ' clickable' : ''}`}
                        onClick={onOpenMeeting ? () => onOpenMeeting(m) : undefined}
                        title={onOpenMeeting ? '클릭하면 회의 공간이 열려요' : undefined}
                      >
                        <MeetingThumb id={m.id} title={m.title} thumbnail={m.thumbnail} className="nb-mini-thumb" />
                        <span className="nb-next-title">{m.title}</span>
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
                {todos.map((todo) => (
                  <label key={todo.id} className={`nowbar-todo${todo.done ? ' done' : ''}`}>
                    <input
                      type="checkbox"
                      checked={!!todo.done}
                      onChange={() => onToggleTodo?.(todo)}
                    />
                    {todo.title}
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
