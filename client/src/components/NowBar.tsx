import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import Logo from './Logo';

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
}

/** "7월 8일 (오후) 4시 40분" 형식 */
function formatNow(d: Date): string {
  const ampm = d.getHours() < 12 ? '오전' : '오후';
  const h12 = d.getHours() % 12 || 12;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${ampm}) ${h12}시 ${d.getMinutes()}분`;
}

/** "3시간 30분 뒤" 형식 */
function formatDiff(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}분 뒤`;
  if (m === 0) return `${h}시간 뒤`;
  return `${h}시간 ${m}분 뒤`;
}

interface MeetingContext {
  title: string;
  tag: string;
  countdown: string;
  diff: string;
}

/** 진행 중 회의 > 가장 가까운 예정 회의 순으로 nowbar 컨텍스트 결정 */
function meetingContext(meetings: Meeting[], now: Date): MeetingContext | null {
  const t = now.getTime();
  const timed = meetings.filter((m) => m.starts_at);

  const ongoing = timed.find(
    (m) =>
      m.starts_at &&
      m.ends_at &&
      new Date(m.starts_at) <= now &&
      now < new Date(m.ends_at),
  );
  if (ongoing) {
    return {
      title: ongoing.title,
      tag: '진행 중',
      countdown: '종료',
      diff: formatDiff(new Date(ongoing.ends_at!).getTime() - t),
    };
  }

  const upcoming = timed
    .filter((m) => new Date(m.starts_at!).getTime() > t)
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime())[0];
  if (upcoming) {
    return {
      title: upcoming.title,
      tag: '예정',
      countdown: '시작',
      diff: formatDiff(new Date(upcoming.starts_at!).getTime() - t),
    };
  }
  return null;
}

interface Props {
  todos?: Todo[];
  meetings?: Meeting[];
}

const CARD_COUNT = 3;

export default function NowBar({ todos = [], meetings = [] }: Props) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [now, setNow] = useState(() => new Date());
  const [brief, setBrief] = useState('');
  const [card, setCard] = useState(0);
  const wheelLock = useRef(0);

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
        /* 로그인 풀림 등 — 무시 */
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
    if (nowMs - wheelLock.current < 450) return; // 전환 애니메이션 중 잠금
    if (Math.abs(e.deltaY) < 8) return;
    wheelLock.current = nowMs;
    setCard((c) => {
      const dir = e.deltaY > 0 ? 1 : -1;
      return (c + dir + CARD_COUNT) % CARD_COUNT;
    });
  }

  const ctx = meetingContext(meetings, now);
  const shown = [...todos].sort((a, b) => a.done - b.done).slice(0, 2);
  const doneCount = todos.filter((t) => t.done).length;
  const progress = todos.length > 0 ? Math.round((doneCount / todos.length) * 100) : 0;

  /** 스택 내 상대 위치: front(앞) / next(오른쪽 아래 겹침) / hidden */
  const stackCls = (i: number) => {
    const rel = (i - card + CARD_COUNT) % CARD_COUNT;
    return rel === 0 ? ' front' : rel === 1 ? ' next' : ' hidden';
  };

  return (
    <header className="nowbar">
      <Logo />

      <div className="nowbar-pill" onWheel={onWheel} title="스크롤로 카드 전환">
        {/* 카드 1 — 회의 + 투두 (기본) */}
        <div className={`nowbar-card${stackCls(0)}`}>
          <div className="nowbar-meeting">
            {ctx ? (
              <>
                <div>
                  <span className="title">{ctx.title}</span>
                  <span className="tag">{ctx.tag}</span>
                </div>
                <div className="countdown">
                  <b>{ctx.countdown}</b> {ctx.diff}
                </div>
              </>
            ) : (
              <>
                <div>
                  <span className="title">회의 없음</span>
                </div>
                <div className="countdown">
                  <span className="tag">예정된 회의가 없습니다</span>
                </div>
              </>
            )}
          </div>
          <div className="nowbar-divider" />
          <div className="nowbar-todos">
            {shown.map((todo) => (
              <div key={todo.id} className={`nowbar-todo${todo.done ? ' done' : ''}`}>
                <input type="checkbox" checked={!!todo.done} readOnly />
                {todo.title}
              </div>
            ))}
            {todos.length === 0 && <div className="nowbar-todo">투두를 추가해보세요</div>}
          </div>
        </div>

        {/* 카드 2 — AI 브리핑 */}
        <div className={`nowbar-card${stackCls(1)}`}>
          <div className="nowbar-ai">
            <span className="ai-badge">
              <span className="dot" />
              exist AI
            </span>
            <span className="ai-text">{brief || '상황을 분석하는 중이에요…'}</span>
          </div>
        </div>

        {/* 카드 3 — 할 일 진행률 */}
        <div className={`nowbar-card${stackCls(2)}`}>
          <div className="nowbar-progress">
            <div className="progress-label">
              ✅ 오늘 할 일 <b>{todos.length}개 중 {doneCount}개 완료</b>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="progress-pct">{progress}%</span>
          </div>
        </div>
        {/* 카드 위치 점 — 카드 오른쪽 모서리에 앵커 */}
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
      </div>

      <span className="nowbar-clock">{formatNow(now)}</span>
      <div className="nowbar-avatar" title={`${user?.username} — 클릭하면 로그아웃`} onClick={logout}>
        🐧
      </div>
    </header>
  );
}
