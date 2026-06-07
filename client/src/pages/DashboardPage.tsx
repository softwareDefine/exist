import { useEffect, useState } from 'react';
import { api } from '../api';
import NowBar, { type Todo } from '../components/NowBar';

interface Meeting {
  id: number;
  code: string;
  title: string;
}

export default function DashboardPage() {
  const [code, setCode] = useState('');
  const [recent, setRecent] = useState<Meeting[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [message, setMessage] = useState('');

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
      setMessage(`"${m.title}" 참여 완료 (회의 화면은 step 3에서)`);
      setCode('');
      void refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '참여 실패');
    }
  }

  async function createMeeting() {
    const title = prompt('회의 이름을 입력하세요');
    if (!title) return;
    const m = await api<Meeting>('/api/meetings', { method: 'POST', body: { title } });
    setMessage(`회의 생성됨 — 코드: ${m.code}`);
    void refresh();
  }

  return (
    <>
      <NowBar todos={todos} />
      <main className="dashboard">
        <aside>
          <div className="join-card">
            <div className="head">
              <h2>회의 입장</h2>
              <button className="new-btn" onClick={createMeeting} title="새 회의 만들기">
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
          </div>

          <div className="section-title">🕘 최근 회의</div>
          <div className="recent-list">
            {recent.map((m) => (
              <div key={m.id} className="recent-card">
                <div className="thumb" />
                <div>
                  <div className="name">{m.title}</div>
                  <div className="actions">
                    <button title="통화">📞</button>
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

        <section className="workspace-panel">
          <h2 className="panel-title">🗂️ 작업 공간</h2>
          <div className="workspace-empty">
            {/* TODO(step 5): tldraw + Yjs 캔버스 */}
            {message || '작업 공간은 step 5에서 tldraw 캔버스로 채워집니다'}
          </div>
        </section>
      </main>
    </>
  );
}
