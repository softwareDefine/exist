import { useEffect, useState } from 'react';
import { useAuthStore } from '../store';

export interface Todo {
  id: number;
  title: string;
  done: number;
  due_at: string | null;
}

/** "7월 8일 (오후) 4시 40분" 형식 */
function formatNow(d: Date): string {
  const ampm = d.getHours() < 12 ? '오전' : '오후';
  const h12 = d.getHours() % 12 || 12;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${ampm}) ${h12}시 ${d.getMinutes()}분`;
}

interface Props {
  todos?: Todo[];
}

export default function NowBar({ todos = [] }: Props) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="nowbar">
      <span className="logo">exist</span>

      <div className="nowbar-pill">
        {/* TODO(step 3): 실제 진행 중/다음 회의 컨텍스트 연동 */}
        <div className="nowbar-meeting">
          <div>
            <span className="title">회의 없음</span>
            <span className="tag">예정된 회의가 없습니다</span>
          </div>
          <div className="countdown">
            <b>nowbar</b> — AI 알림이 여기 표시됩니다
          </div>
        </div>

        <div className="nowbar-todos">
          {todos.slice(0, 2).map((todo) => (
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
