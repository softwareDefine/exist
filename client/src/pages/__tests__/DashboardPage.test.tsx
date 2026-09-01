import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { mockApi } from '../../test/mockApi';
import { login } from '../../test/auth';
import { captureEvents } from '../../test/render';
import { useNameStore } from '../../names';
import { useOrgStore } from '../../orgStore';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
vi.mock('../../lib/push', () => ({ initPush: vi.fn(async () => {}) }));
// 회의 허브(WebRTC·에디터)와 캔버스는 스텁 — 대시보드 셸(사이드바·탭·나우바·모달) 배선만 검증
vi.mock('../../components/MeetingHub', () => ({
  default: ({ code, gotoTab }: { code: string; gotoTab?: { tab: string } }) => (
    <div data-testid={`hub-${code}`}>{gotoTab?.tab ?? 'dash'}</div>
  ),
}));
vi.mock('../../components/CanvasBoard', () => ({ default: ({ roomId }: { roomId: string }) => <div data-testid="canvas">{roomId}</div> }));

import { fakeSocket } from '../../test/socket.mock';
import { initPush } from '../../lib/push';
import DashboardPage from '../DashboardPage';

const NOW = Date.now();
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString();

function Loc() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname}</div>;
}

function mount(state?: { message?: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/', state }]}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="*" element={<Loc />} />
      </Routes>
    </MemoryRouter>,
  );
}

const recent = [
  { id: 1, code: 'ABCD', title: '생산1팀', thumbnail: null, starts_at: null, ends_at: null },
  { id: 2, code: 'EFGH', title: '품질팀', thumbnail: null, starts_at: iso(60), ends_at: iso(120) },
];

function routes(m: ReturnType<typeof mockApi>) {
  m.get(/\/api\/meetings\/recent\?org=/, recent);
  m.get(/\/api\/meetings\/schedule\?org=/, [{ id: 2, code: 'EFGH', title: '품질 점검', meetingTitle: '품질팀', thumbnail: null, starts_at: iso(60), ends_at: iso(120) }]);
  m.get(/\/api\/todos\?org=/, [{ id: 1, title: '보고서', done: 0, due_at: null }]);
  m.get(/\/api\/todos\?meeting=/, [{ id: 5, title: '그룹 할 일', done: 0, due_at: null }]);
  m.get(/\/api\/workspaces\?ctx=/, []);
  m.get('/api/notifications', { unread: 1, items: [{ id: 1, from: 'kim', text: '결정을 확인해주세요', kind: 'ack', read: false, ts: NOW }] });
  m.get('/api/auth/me', { avatar: '🐯' });
  m.get(/\/api\/agent\/brief/, { text: '오늘 브리핑', card: 0, source: 'rule' });
  m.get('/api/orgs', []);
  m.get(/\/api\/agent\//, {});
  m.get(/\/api\/agent\/overview/, { avatar: '🐯', meetingCount: 2, todoUndone: 1, todoOverdue: 0, unreadTotal: 0, pendingAcks: 0, weekDecisions: 1, liveCalls: [], recentMeetings: [], nextMeeting: null });
  m.get(/\/api\/agent\/daily/, { text: '' });
  m.get(/\/api\/agent\/catchup/, { headline: '', items: [] });
  m.get(/\/api\/agent\/pending-decisions/, { items: [] });
  m.get(/\/api\/agent\/actions/, { decisions: [], todos: [], dms: [], pendingAcks: [], pendingAcksTotal: 0 });
  m.get(/\/api\/agent\/sent/, { entries: [], totalSent: 0 });
  m.get(/\/api\/dm\//, []);
  m.get(/\/api\/meetings\/inbox/, []);
}

describe('DashboardPage', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    login({ id: 1, username: 'juho', name: '이주호' });
    useNameStore.setState({ map: {} });
    useOrgStore.setState({ orgs: [], current: 'personal', loaded: false });
    vi.mocked(initPush).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('최근 그룹 목록(임박 일정 우선) → 카드 클릭으로 허브 탭, 액션 버튼은 세부 탭 지정', async () => {
    routes(m);
    mount();
    expect(await screen.findByText('생산1팀')).toBeInTheDocument();
    expect(initPush).toHaveBeenCalledTimes(1);
    const names = [...document.querySelectorAll('.recent-card .name')].map((e) => e.textContent);
    expect(names[0]).toContain('품질팀'); // 다가오는 일정이 있는 그룹이 먼저
    fireEvent.click(screen.getByText('생산1팀').closest('.recent-card')!);
    expect(await screen.findByTestId('hub-ABCD')).toHaveTextContent('dash');
    const qCard = screen.getByText('품질팀', { selector: '.recent-card .name' }).closest('.recent-card') as HTMLElement;
    fireEvent.click(within(qCard).getByTitle('채팅'));
    expect(await screen.findByTestId('hub-EFGH')).toHaveTextContent('chat');
    // 워크스페이스 탭 2개 + 홈 복귀
    expect(document.querySelectorAll('.ws-tab.meeting')).toHaveLength(2);
    fireEvent.click(screen.getByTitle('홈 — 내 대시보드'));
    expect(document.querySelector('.ws-tab.home')).toHaveClass('active');
    // 탭 닫기
    fireEvent.click(screen.getAllByTitle('그룹 나가기')[0]);
    expect(document.querySelectorAll('.ws-tab.meeting')).toHaveLength(1);
    // 열린 탭은 사용자별 localStorage에 저장
    expect(JSON.parse(localStorage.getItem('exist:meeting-tabs:juho') ?? '[]')).toEqual([{ code: 'EFGH', title: '품질팀' }]);
  });

  it('그룹 코드로 참여 → POST join → 탭 열림 + 목록 갱신, 잘못된 코드는 무시', async () => {
    routes(m);
    m.post('/api/meetings/join', { id: 9, code: 'ZZZZ', title: '새 그룹' });
    mount();
    await screen.findByText('생산1팀');
    const input = screen.getByPlaceholderText('그룹 코드');
    fireEvent.submit(input.closest('form')!);
    expect(m.calls('POST', '/api/meetings/join')).toHaveLength(0);
    await userEvent.type(input, 'zzzz');
    fireEvent.click(screen.getAllByRole('button', { name: '참여' })[0]);
    await waitFor(() => expect(m.calls('POST', '/api/meetings/join')).toHaveLength(1));
    expect(m.last('POST').body).toEqual({ code: 'zzzz' });
    expect(await screen.findByTestId('hub-ZZZZ')).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe('');
    expect(m.calls('GET', /meetings\/recent/).length).toBeGreaterThanOrEqual(2);
  });

  it('초대 링크 pending-join → 자동 참여, pending-join-org → 가입 신청 안내', async () => {
    routes(m);
    sessionStorage.setItem('exist:pending-join', 'QWER');
    sessionStorage.setItem('exist:pending-join-org', 'ORG-1');
    m.post('/api/meetings/join', { id: 3, code: 'QWER', title: '초대 그룹' });
    m.post('/api/orgs/join', { orgName: '동국제약' });
    const ev = captureEvents('app:info');
    mount();
    expect(await screen.findByTestId('hub-QWER')).toBeInTheDocument();
    await waitFor(() => expect(ev.of('app:info')).toEqual(['동국제약 가입 신청 완료 — 관리자가 승인하면 들어갈 수 있어요']));
    expect(sessionStorage.getItem('exist:pending-join')).toBeNull();
    expect(sessionStorage.getItem('exist:pending-join-org')).toBeNull();
    ev.stop();
  });

  it('새 그룹 만들기 모달 → POST /api/meetings → 코드 화면 → 지금 입장', async () => {
    routes(m);
    m.post('/api/meetings', { code: 'NEW1', title: '신규', invited: ['kim'] });
    m.get(/\/api\/meetings\/users\/search/, [{ userId: 2, username: 'kim', avatar: null }]);
    mount();
    await screen.findByText('생산1팀');
    fireEvent.click(screen.getByTitle('새 그룹 만들기'));
    const title = screen.getByPlaceholderText('예: 주간 스프린트 리뷰');
    expect(screen.getByRole('button', { name: '그룹 만들기' })).toBeDisabled();
    await userEvent.type(title, '신규');
    await userEvent.type(screen.getByPlaceholderText('이름으로 검색해서 초대'), 'k');
    const results = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.cm-results');
      if (!el || !el.querySelector('.cm-result')) throw new Error('no results yet');
      return el;
    });
    fireEvent.click(within(results).getByText('kim').closest('button')!);
    expect(document.querySelector('.cm-results')).toBeNull(); // 선택 후 검색 결과 닫힘
    fireEvent.click(screen.getByRole('button', { name: '그룹 만들기' }));
    expect(await screen.findByText('그룹이 만들어졌어요')).toBeInTheDocument();
    expect(m.last('POST', '/api/meetings').body).toMatchObject({ title: '신규', org_id: null, invite: ['kim'] });
    expect(screen.getByText('1명을 초대했어요. 코드로도 참여할 수 있어요')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('클릭해서 복사'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('NEW1'));
    fireEvent.click(screen.getByRole('button', { name: '지금 입장 →' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/meeting/NEW1'));
  });

  it('exist:open-meeting / exist:new-meeting / exist:deeplink 이벤트 처리', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    routes(m);
    const ev = captureEvents('exist:open-file');
    mount();
    await screen.findByText('생산1팀');
    act(() => window.dispatchEvent(new CustomEvent('exist:open-meeting', { detail: { code: 'ABCD', title: '생산1팀', tab: 'decisions' } })));
    expect(await screen.findByTestId('hub-ABCD')).toHaveTextContent('decisions');
    act(() => window.dispatchEvent(new CustomEvent('exist:new-meeting')));
    expect(screen.getByPlaceholderText('예: 주간 스프린트 리뷰')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('예: 주간 스프린트 리뷰')).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent('exist:deeplink', { detail: { code: 'efgh', fileId: 7 } })));
    expect(await screen.findByTestId('hub-EFGH')).toHaveTextContent('files');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(ev.of('exist:open-file')).toEqual([{ code: 'EFGH', fileId: 7 }]);
    ev.stop();
  });

  it('전역 검색(Ctrl+K) → 결과 클릭이 그룹 탭을 연다', async () => {
    routes(m);
    m.get(/\/api\/agent\/search\?q=/, {
      groups: [{ code: 'ABCD', title: '생산1팀' }],
      messages: [{ text: '냉각수 얘기', code: 'ABCD', title: '생산1팀' }],
      decisions: [{ text: '냉각수 63도', code: 'ABCD', title: '생산1팀' }],
      todos: [],
      files: [],
      events: [],
    });
    mount();
    await screen.findByText('생산1팀');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('채팅·결정·할 일·파일·일정 검색');
    expect(screen.getByText('이 워크스페이스의 모든 기록에서 찾아요')).toBeInTheDocument();
    await userEvent.type(input, '냉각수');
    expect(await screen.findByText('냉각수 63도')).toBeInTheDocument();
    expect(screen.getByText('결정')).toBeInTheDocument();
    fireEvent.click(screen.getByText('냉각수 63도'));
    expect(await screen.findByTestId('hub-ABCD')).toHaveTextContent('decisions');
    expect(screen.queryByPlaceholderText('채팅·결정·할 일·파일·일정 검색')).not.toBeInTheDocument();
  });

  it('나우바 — 알림 수신(agent:notify)·읽음 처리, 소켓 call:presence로 목록 재조회(디바운스)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    routes(m);
    m.post('/api/notifications/read', {});
    mount();
    await screen.findByText('생산1팀');
    const before = m.calls('GET', /meetings\/recent/).length;
    act(() => {
      fakeSocket.trigger('call:presence', { code: 'ABCD', peers: ['a'] });
      fakeSocket.trigger('meeting:invited', { code: 'ABCD' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(m.calls('GET', /meetings\/recent/).length).toBe(before + 1);
    act(() => fakeSocket.trigger('agent:notify', { id: 2, from: 'kim', text: '새 알림입니다', ts: NOW, kind: 'chat' }));
    // 알림 벨 열기 → 항목 표시
    fireEvent.click(screen.getByTitle('알림'));
    expect((await screen.findAllByText('새 알림입니다')).length).toBeGreaterThan(0);
  });

  it('라우팅 메시지(강퇴 등) 표시, 사이드바 접기 상태 저장', async () => {
    routes(m);
    mount({ message: '그룹에서 내보내졌어요.' });
    expect(await screen.findByText('그룹에서 내보내졌어요.')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('사이드바 열기/닫기'));
    expect(document.querySelector('main.dashboard')).toHaveClass('collapsed');
    expect(localStorage.getItem('exist:sidebar')).toBe('closed');
  });

  it('조직 컨텍스트에서 그룹 생성 권한이 없으면 + 버튼 숨김 + 안내 문구', async () => {
    routes(m);
    useOrgStore.setState({
      orgs: [{ id: 5, name: '런타임', joinCode: 'X', role: 'member', isManager: false, canCreateGroup: false, memberCount: 2, pendingCount: 0 }],
      current: 5,
      loaded: true,
    });
    m.get('/api/orgs', useOrgStore.getState().orgs);
    m.get(/\/api\/meetings\/recent\?org=5/, []);
    m.get(/\/api\/meetings\/schedule\?org=5/, []);
    mount();
    expect(await screen.findByText(/코드를 받아 참여하거나 관리자에게 요청하세요/)).toBeInTheDocument();
    expect(screen.queryByTitle('새 그룹 만들기')).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent('exist:new-meeting')));
    expect(screen.queryByPlaceholderText('예: 주간 스프린트 리뷰')).not.toBeInTheDocument();
  });
});
