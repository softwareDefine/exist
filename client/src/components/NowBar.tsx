import { useEffect, useState } from 'react';
import { useAuthStore } from '../store';

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
  countdown: string; // 예: "종료" / "시작"
  diff: string;
}

/** 진행 중 회의 > 가장 가까운 예정 회의 순으로 nowbar 컨텍스트 결정 */
function meetingContext(meetings: Meeting[], now: Date): MeetingContext | null {
  const t = now.getTime();
  const timed = meetings.filter((m) => m.starts_at);

  const ongoing = timed.find(
    (m) => new Date(m.starts_at!).getTime() <= t && m.ends_at && t < new Date(m.ends_at).getTime(),
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

export default function NowBar({ todos = [], meetings = [] }: Props) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  const ctx = meetingContext(meetings, now);
  // 미완료 우선, 최대 2개 (피그마: 미완 1 + 완료 1 형태)
  const shown = [...todos].sort((a, b) => a.done - b.done).slice(0, 2);

  return (
    <header className="nowbar">
      <span className="logo">exist</span>

      <div className="nowbar-pill">
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

      <span className="nowbar-clock">{formatNow(now)}</span>
      <div className="nowbar-avatar" title={`${user?.username} — 클릭하면 로그아웃`} onClick={logout}>
        🐧
      </div>
    </header>
  );
}
