import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api';
import NowBar, { type Todo, type Meeting } from '../components/NowBar';
import WorkspacePanel, { type MeetingTabRequest } from '../components/WorkspacePanel';
import { PhoneIcon, ChatIcon, CalendarIcon, GearIcon, HistoryIcon } from '../components/Icons';
import CreateMeetingModal from '../components/CreateMeetingModal';
import MeetingSettingsModal from '../components/MeetingSettingsModal';
import MeetingThumb from '../components/MeetingThumb';
import OrgSwitcher from '../components/OrgSwitcher';
import { useOrgStore } from '../orgStore';

export default function DashboardPage() {
  const location = useLocation();
  const orgCurrent = useOrgStore((s) => s.current);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('exist:sidebar') !== 'closed',
  );
  const [code, setCode] = useState('');
  const [recent, setRecent] = useState<Meeting[]>([]);
  const [schedule, setSchedule] = useState<Meeting[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  // 강퇴 등 라우팅으로 전달된 안내 메시지
  const message = (location.state as { message?: string } | null)?.message ?? '';

  // 회의 생성 모달 (schedMode = 일정 잡기로 진입)
  const [showCreate, setShowCreate] = useState(false);
  const [createSchedMode, setCreateSchedMode] = useState(false);

  function openCreate(schedMode = false) {
    setCreateSchedMode(schedMode);
    setShowCreate(true);
  }

  // 회의 탭 열기 요청 (우측 패널로 전달)
  const [meetingRequest, setMeetingRequest] = useState<MeetingTabRequest | null>(null);
  // nowbar가 띄울 회의 그룹 (최근회의 클릭 시 그 회의로 고정)
  const [focusedCode, setFocusedCode] = useState<string | null>(null);

  // 회의 설정 모달 (일정/설정 버튼)
  const [settingsMeeting, setSettingsMeeting] = useState<Meeting | null>(null);

  function openMeetingTab(code: string, title: string, tab?: string) {
    setMeetingRequest({ code, title, ts: Date.now(), tab });
    setFocusedCode(code); // nowbar가 이 회의 그룹을 띄우도록
  }

  function toggleSidebar() {
    setSidebarOpen((v) => {
      const next = !v;
      localStorage.setItem('exist:sidebar', next ? 'open' : 'closed');
      return next;
    });
  }


  async function refresh() {
    try {
      const param = useOrgStore.getState().contextParam();
      const [meetings, sched, todoList] = await Promise.all([
        api<Meeting[]>(`/api/meetings/recent?org=${param}`),
        api<Meeting[]>(`/api/meetings/schedule?org=${param}`),
        api<Todo[]>('/api/todos'),
      ]);
      setRecent(meetings);
      setSchedule(sched);
      setTodos(todoList);
    } catch {
      /* 로그아웃 등으로 실패 시 무시 — 라우터 가드가 처리 */
    }
  }

  // 최초 + 조직 컨텍스트 전환 시 회의 목록 갱신
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgCurrent]);

  // 회의 일정 이벤트가 추가/삭제되면 nowbar 일정도 다시 불러오기
  useEffect(() => {
    function onChanged() {
      void refresh();
    }
    window.addEventListener('exist:schedule-changed', onChanged);
    return () => window.removeEventListener('exist:schedule-changed', onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 알림의 "지금 들어가기" 등 → 회의(통화) 탭 열기
  useEffect(() => {
    function onOpen(e: Event) {
      const d = (e as CustomEvent<{ code: string; title?: string; tab?: string }>).detail;
      if (d?.code) openMeetingTab(d.code, d.title ?? d.code, d.tab);
    }
    window.addEventListener('exist:open-meeting', onOpen);
    return () => window.removeEventListener('exist:open-meeting', onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function joinMeeting(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    try {
      const m = await api<Meeting>('/api/meetings/join', { method: 'POST', body: { code } });
      openMeetingTab(m.code, m.title);
      setCode('');
      void refresh();
    } catch {
      /* 전역 에러 토스트가 표시 */
    }
  }

  async function toggleTodo(todo: Todo) {
    await api(`/api/todos/${todo.id}`, { method: 'PATCH', body: { done: !todo.done } });
    void refresh();
  }

  async function addTodo(title: string) {
    await api('/api/todos', { method: 'POST', body: { title } });
    void refresh();
  }

  return (
    <>
      <NowBar
        todos={todos}
        meetings={schedule}
        groups={recent}
        focusedCode={focusedCode}
        onToggleTodo={toggleTodo}
        onAddTodo={addTodo}
        onOpenMeeting={(m) => openMeetingTab(m.code, m.title)}
        onSchedule={() => openCreate(true)}
        onToggleSidebar={toggleSidebar}
      />
      <main className={`dashboard${sidebarOpen ? '' : ' collapsed'}`}>
        <aside>
          <OrgSwitcher />

          <div className="join-card">
            <div className="head">
              <h2>회의 입장</h2>
              <button className="new-btn" onClick={() => openCreate(false)} title="새 회의 만들기">
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

          <div className="section-title">
            <HistoryIcon size={21} /> 최근 회의
          </div>
          <div className="recent-list">
            {recent.map((m) => (
              <div
                key={m.id}
                className="recent-card clickable"
                onClick={() => openMeetingTab(m.code, m.title)}
                title="클릭하면 옆 탭에서 회의가 열려요"
              >
                <MeetingThumb id={m.id} title={m.title} thumbnail={m.thumbnail} className="thumb" />
                <div>
                  <div className="name">{m.title}</div>
                  <div className="actions" onClick={(e) => e.stopPropagation()}>
                    <button title="통화" onClick={() => openMeetingTab(m.code, m.title, 'call')}>
                      <PhoneIcon size={17} />
                    </button>
                    <button title="채팅" onClick={() => openMeetingTab(m.code, m.title, 'chat')}>
                      <ChatIcon size={17} />
                    </button>
                    <button title="일정" onClick={() => openMeetingTab(m.code, m.title, 'schedule')}>
                      <CalendarIcon size={17} />
                    </button>
                    <button title="설정" onClick={() => openMeetingTab(m.code, m.title, 'settings')}>
                      <GearIcon size={17} />
                    </button>
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
          <WorkspacePanel meetingRequest={meetingRequest} />
        </div>
      </main>

      <CreateMeetingModal
        open={showCreate}
        defaultSchedule={createSchedMode}
        onClose={() => setShowCreate(false)}
        onCreated={() => void refresh()}
      />

      <MeetingSettingsModal
        meeting={settingsMeeting}
        onClose={() => setSettingsMeeting(null)}
        onChanged={() => void refresh()}
      />
    </>
  );
}
