import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import NowBar, { type Todo, type Meeting } from '../components/NowBar';
import NotificationToasts from '../components/NotificationToasts';
import WorkspacePanel from '../components/WorkspacePanel';

export default function DashboardPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [code, setCode] = useState('');
  const [recent, setRecent] = useState<Meeting[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [message, setMessage] = useState(
    (location.state as { message?: string } | null)?.message ?? '',
  );

  // 회의 생성 폼
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd] = useState('');


  async function refresh() {
    try {
      const [meetings, todoList] = await Promise.all([
        api<Meeting[]>('/api/meetings/recent'),
        api<Todo[]>('/api/todos'),
      ]);
      setRecent(meetings);
      setTodos(todoList);
    } catch {
      /* 로그아웃 등으로 실패 시 무시 — 라우터 가드가 처리 */
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function joinMeeting(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    try {
      const m = await api<Meeting>('/api/meetings/join', { method: 'POST', body: { code } });
      navigate(`/meeting/${m.code}`);
    } catch {
      /* 전역 에러 토스트가 표시 */
    }
  }

  async function createMeeting(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    try {
      const m = await api<{ code: string }>('/api/meetings', {
        method: 'POST',
        body: {
          title: newTitle,
          starts_at: newStart || null,
          ends_at: newEnd || null,
        },
      });
      setMessage(`회의 생성됨 — 코드: ${m.code}`);
      setShowCreate(false);
      setNewTitle('');
      setNewStart('');
      setNewEnd('');
      void refresh();
    } catch {
      /* 전역 에러 토스트가 표시 */
    }
  }

  return (
    <>
      <NowBar todos={todos} meetings={recent} />
      <NotificationToasts />
      <main className="dashboard">
        <aside>
          <div className="join-card">
            <div className="head">
              <h2>회의 입장</h2>
              <button
                className="new-btn"
                onClick={() => setShowCreate((v) => !v)}
                title="새 회의 만들기"
              >
                +
              </button>
            </div>
            <form onSubmit={joinMeeting}>
              <input
                placeholder="회의 코드"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button type="submit" className="join-btn">
                참여
              </button>
            </form>

            {showCreate && (
              <form className="create-form" onSubmit={createMeeting}>
                <input
                  placeholder="회의 이름"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  autoFocus
                />
                <label>
                  시작
                  <input
                    type="datetime-local"
                    value={newStart}
                    onChange={(e) => setNewStart(e.target.value)}
                  />
                </label>
                <label>
                  종료
                  <input
                    type="datetime-local"
                    value={newEnd}
                    onChange={(e) => setNewEnd(e.target.value)}
                  />
                </label>
                <button type="submit" className="create-btn">
                  만들기
                </button>
              </form>
            )}
          </div>

          <div className="section-title">🕘 최근 회의</div>
          <div className="recent-list">
            {recent.map((m) => (
              <div key={m.id} className="recent-card">
                <div
                  className="thumb"
                  style={{
                    background: `linear-gradient(135deg, hsl(${(m.id * 67) % 360} 60% 55%), hsl(${(m.id * 67 + 40) % 360} 60% 45%))`,
                  }}
                >
                  {m.title.slice(0, 1)}
                </div>
                <div>
                  <div className="name">{m.title}</div>
                  <div className="actions">
                    <button title="통화" onClick={() => navigate(`/meeting/${m.code}`)}>
                      📞
                    </button>
                    <button title="채팅">💬</button>
                    <button title="일정">📅</button>
                    <button title="설정">⚙️</button>
                  </div>
                </div>
              </div>
            ))}
            {recent.length === 0 && (
              <div className="recent-card">
                <div>아직 회의가 없어요. + 버튼으로 만들어보세요.</div>
              </div>
            )}
          </div>

        </aside>

        <div className="workspace-col">
          {message && <div className="dash-message">{message}</div>}
          <WorkspacePanel />
        </div>
      </main>
    </>
  );
}
