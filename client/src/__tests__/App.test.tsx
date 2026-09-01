import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { mockApi } from '../test/mockApi';
import { login, logout } from '../test/auth';

vi.mock('../lib/socket', () => import('../test/socket.mock'));
// 보호 라우트 뒤의 무거운 페이지는 스텁 — 라우팅·가드·프레즌스 배선만 검증
vi.mock('../pages/DashboardPage', () => ({ default: () => <div data-testid="dashboard" /> }));
vi.mock('../pages/OrgChartPage', () => ({ default: () => <div data-testid="orgchart" /> }));
vi.mock('../pages/MeetingRoomPage', () => ({ default: () => <div data-testid="room" /> }));

import { fakeSocket } from '../test/socket.mock';
import App from '../App';

describe('App', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    m.get('/api/auth/names', [{ username: 'kim', name: '김대리' }]);
    window.history.pushState({}, '', '/');
  });

  it('비로그인 — 보호 라우트는 /login으로, 이름 디렉터리·프레즌스 통지 없음', async () => {
    logout();
    render(<App />);
    expect(await screen.findByPlaceholderText('아이디')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
    expect(m.calls('GET', '/api/auth/names')).toHaveLength(0);
    expect(fakeSocket.emittedOf('presence:visible')).toHaveLength(0);
  });

  it('로그인 — 대시보드 렌더 + 이름 로드 + 탭 가시성 presence(연결 시 재보고)', async () => {
    login();
    render(<App />);
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument();
    expect(m.calls('GET', '/api/auth/names')).toHaveLength(1);
    expect(fakeSocket.emittedOf('presence:visible')[0].args[0]).toEqual({ visible: true });
    act(() => fakeSocket.trigger('connect'));
    expect(fakeSocket.emittedOf('presence:visible')).toHaveLength(2);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(fakeSocket.emittedOf('presence:visible')).toHaveLength(3);
    // 전역 토스트가 마운트돼 있다
    act(() => window.dispatchEvent(new CustomEvent('app:error', { detail: '앱 오류' })));
    expect(screen.getByText('앱 오류')).toBeInTheDocument();
  });

  it('초대 링크 라우트는 로그인 없이 진입해 코드를 저장하고 /login', async () => {
    logout();
    window.history.pushState({}, '', '/join/org/abcd');
    render(<App />);
    expect(await screen.findByPlaceholderText('아이디')).toBeInTheDocument();
    expect(sessionStorage.getItem('exist:pending-join-org')).toBe('ABCD');
  });
});
