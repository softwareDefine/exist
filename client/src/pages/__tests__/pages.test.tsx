import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { mockApi } from '../../test/mockApi';
import { logout, login } from '../../test/auth';
import { useAuthStore } from '../../store';
import { useOrgStore } from '../../orgStore';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
import LoginPage from '../LoginPage';
import RegisterPage from '../RegisterPage';
import ForgotPage from '../ForgotPage';
import JoinPage from '../JoinPage';
import OrgSwitcher from '../../components/OrgSwitcher';

function Location() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}
function mount(ui: React.ReactElement, path: string, pattern = path.split('?')[0]) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={ui} />
        <Route path="*" element={<Location />} />
      </Routes>
    </MemoryRouter>,
  );
}

const USER = { id: 3, username: 'kim', name: '김대리' };

describe('LoginPage', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    logout();
  });

  it('로그인 성공 → setAuth + / 이동', async () => {
    m.post('/api/auth/login', { token: 'T', user: USER });
    mount(<LoginPage />, '/login');
    await userEvent.type(screen.getByPlaceholderText('아이디'), 'kim');
    await userEvent.type(screen.getByPlaceholderText('비밀번호'), 'secret12');
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/'));
    expect(m.last('POST', '/api/auth/login').body).toEqual({ username: 'kim', password: 'secret12' });
    expect(useAuthStore.getState().token).toBe('T');
    expect(useAuthStore.getState().user?.username).toBe('kim');
  });

  it('실패 → 인라인 에러 (전역 토스트 아님), 링크 2개', async () => {
    m.fail('POST', '/api/auth/login', 401, '아이디 또는 비밀번호가 틀렸어요');
    mount(<LoginPage />, '/login');
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText('아이디 또는 비밀번호가 틀렸어요 (401)')).toHaveClass('error');
    expect(useAuthStore.getState().token).toBeNull();
    expect(screen.getByRole('link', { name: '회원가입' })).toHaveAttribute('href', '/register');
    expect(screen.getByRole('link', { name: /잊어버리셨나요/ })).toHaveAttribute('href', '/forgot');
  });
});

describe('RegisterPage', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    logout();
  });

  async function fill(username: string, pw: string, confirm: string, name = '') {
    const id = screen.getByPlaceholderText(/아이디 \(영문/);
    await userEvent.clear(id);
    if (username) await userEvent.type(id, username);
    if (name) await userEvent.type(screen.getByPlaceholderText(/이름 \(선택/), name);
    const p = screen.getByPlaceholderText('비밀번호 (8자 이상)');
    await userEvent.clear(p);
    if (pw) await userEvent.type(p, pw);
    const c = screen.getByPlaceholderText('비밀번호 확인');
    await userEvent.clear(c);
    if (confirm) await userEvent.type(c, confirm);
    fireEvent.click(screen.getByRole('button', { name: '가입하기' }));
  }

  it('클라이언트 검증 — 아이디 형식, 길이, 확인 불일치', async () => {
    mount(<RegisterPage />, '/register');
    await fill('k!', 'password1', 'password1');
    expect(screen.getByText('아이디는 영문·숫자·_ 조합 3~20자입니다')).toBeInTheDocument();
    await fill('kim_1', 'short', 'short');
    expect(screen.getByText('비밀번호는 8자 이상이어야 합니다')).toBeInTheDocument();
    await fill('kim_1', 'password1', 'password2');
    expect(screen.getByText('비밀번호가 서로 다릅니다')).toBeInTheDocument();
    expect(m.recorded).toHaveLength(0);
  });

  it('가입 → 복구 코드 화면 → 시작하기에서 로그인 처리', async () => {
    m.post('/api/auth/register', { token: 'T2', user: USER, recoveryCode: 'AAAA-BBBB-CCCC-DDDD' });
    mount(<RegisterPage />, '/register');
    await fill('kim_1', 'password1', 'password1', '김대리');
    expect(await screen.findByText('AAAA-BBBB-CCCC-DDDD')).toBeInTheDocument();
    expect(m.last('POST').body).toEqual({ username: 'kim_1', password: 'password1', name: '김대리' });
    expect(useAuthStore.getState().token).toBeNull(); // 아직 로그인 전
    fireEvent.click(screen.getByRole('button', { name: '시작하기' }));
    expect(useAuthStore.getState().token).toBe('T2');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/'));
  });

  it('서버 실패 → 인라인 에러', async () => {
    m.fail('POST', '/api/auth/register', 409, '이미 있는 아이디');
    mount(<RegisterPage />, '/register');
    await fill('kim_1', 'password1', 'password1');
    expect(await screen.findByText('이미 있는 아이디 (409)')).toBeInTheDocument();
  });
});

describe('ForgotPage', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    logout();
  });

  it('검증 → 재설정 → 새 복구 코드 → 시작하기', async () => {
    m.post('/api/auth/reset', { token: 'T3', user: USER, recoveryCode: 'NEW-CODE' });
    mount(<ForgotPage />, '/forgot');
    fireEvent.click(screen.getByRole('button', { name: '재설정' }));
    expect(screen.getByText('비밀번호는 8자 이상이어야 합니다')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('아이디'), 'kim');
    await userEvent.type(screen.getByPlaceholderText(/복구 코드/), 'AAAA-BBBB');
    await userEvent.type(screen.getByPlaceholderText('새 비밀번호 (8자 이상)'), 'password1');
    await userEvent.type(screen.getByPlaceholderText('새 비밀번호 확인'), 'password2');
    fireEvent.click(screen.getByRole('button', { name: '재설정' }));
    expect(screen.getByText('비밀번호가 서로 다릅니다')).toBeInTheDocument();
    await userEvent.clear(screen.getByPlaceholderText('새 비밀번호 확인'));
    await userEvent.type(screen.getByPlaceholderText('새 비밀번호 확인'), 'password1');
    fireEvent.click(screen.getByRole('button', { name: '재설정' }));
    expect(await screen.findByText('비밀번호가 변경됐어요')).toBeInTheDocument();
    expect(m.last('POST').body).toEqual({ username: 'kim', recoveryCode: 'AAAA-BBBB', newPassword: 'password1' });
    expect(screen.getByText('NEW-CODE')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '시작하기' }));
    expect(useAuthStore.getState().token).toBe('T3');
  });

  it('서버 실패 → 인라인 에러', async () => {
    m.fail('POST', '/api/auth/reset', 400, '복구 코드가 틀렸어요');
    mount(<ForgotPage />, '/forgot');
    await userEvent.type(screen.getByPlaceholderText('새 비밀번호 (8자 이상)'), 'password1');
    await userEvent.type(screen.getByPlaceholderText('새 비밀번호 확인'), 'password1');
    fireEvent.click(screen.getByRole('button', { name: '재설정' }));
    expect(await screen.findByText('복구 코드가 틀렸어요 (400)')).toBeInTheDocument();
  });
});

describe('JoinPage', () => {
  it('비로그인 — 코드를 sessionStorage에 대문자로 저장하고 /login', async () => {
    logout();
    mount(<JoinPage />, '/join/abcd', '/join/:code');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/login'));
    expect(sessionStorage.getItem('exist:pending-join')).toBe('ABCD');
  });

  it('로그인 + 조직 초대 — 조직 키에 저장하고 /', async () => {
    login();
    mount(<JoinPage org />, '/join/org/xy-12', '/join/org/:code');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/'));
    expect(sessionStorage.getItem('exist:pending-join-org')).toBe('XY-12');
    expect(sessionStorage.getItem('exist:pending-join')).toBeNull();
  });
});

describe('OrgSwitcher + 조직 생성/가입 모달', () => {
  let m: ReturnType<typeof mockApi>;
  const orgs = [
    { id: 1, name: '런타임', joinCode: 'RT-0001', role: 'owner', isManager: true, canCreateGroup: true, memberCount: 5, pendingCount: 2 },
    { id: 2, name: '동국제약', joinCode: 'DK-0002', role: 'member', isManager: false, canCreateGroup: false, memberCount: 30, pendingCount: 0 },
  ];
  beforeEach(() => {
    m = mockApi();
    login();
    useOrgStore.setState({ orgs: [], current: 'personal', loaded: false });
    m.get('/api/orgs', orgs);
  });

  it('로드 → 라벨·대기 배지 → 메뉴에서 조직 선택/조직도 이동/개인 복귀', async () => {
    mount(<OrgSwitcher />, '/');
    await waitFor(() => expect(useOrgStore.getState().orgs).toHaveLength(2));
    expect(screen.getByText('개인', { selector: '.org-switcher-name' })).toBeInTheDocument();
    expect(screen.getByText('2', { selector: '.org-switcher-badge' })).toBeInTheDocument();
    fireEvent.click(document.querySelector('.org-switcher-btn')!);
    expect(screen.getByText('런타임')).toBeInTheDocument();
    fireEvent.click(screen.getByText('동국제약').closest('button')!);
    expect(useOrgStore.getState().current).toBe(2);
    expect(screen.getByText('동국제약', { selector: '.org-switcher-name' })).toBeInTheDocument();
    expect(screen.queryByText('런타임')).not.toBeInTheDocument(); // 메뉴 닫힘
    // 모바일 바에서 여는 이벤트
    fireEvent(window, new CustomEvent('exist:open-org-menu'));
    expect(screen.getByText('런타임')).toBeInTheDocument();
    fireEvent.click(screen.getAllByTitle('조직도 보기')[0]);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/org/1'));
  });

  it('바깥 클릭으로 닫힘, 개인으로 복귀', async () => {
    useOrgStore.setState({ current: 1 });
    mount(<OrgSwitcher />, '/');
    await waitFor(() => expect(useOrgStore.getState().orgs).toHaveLength(2));
    fireEvent.click(document.querySelector('.org-switcher-btn')!);
    expect(document.querySelector('.org-menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(document.querySelector('.org-menu')).not.toBeInTheDocument();
    fireEvent.click(document.querySelector('.org-switcher-btn')!);
    fireEvent.click(screen.getByText('개인', { selector: '.org-menu-item' }));
    expect(useOrgStore.getState().current).toBe('personal');
  });

  it('조직 만들기 — 이름 필수, 생성 후 가입코드 표시·복사·현재 컨텍스트 전환, Esc로 닫기', async () => {
    m.post('/api/orgs', { ...orgs[0], id: 9, name: '새조직', joinCode: 'NEW-9999' });
    mount(<OrgSwitcher />, '/');
    await waitFor(() => expect(useOrgStore.getState().orgs).toHaveLength(2));
    fireEvent.click(document.querySelector('.org-switcher-btn')!);
    fireEvent.click(screen.getByText('조직 만들기'));
    expect(screen.getByText('새 조직 만들기')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '만들기' })).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/런타임 주식회사/), '새조직');
    m.get('/api/orgs', [...orgs, { ...orgs[0], id: 9, name: '새조직', joinCode: 'NEW-9999' }]);
    fireEvent.click(screen.getByRole('button', { name: '만들기' }));
    expect(await screen.findByText(/새조직 조직이 만들어졌어요/)).toBeInTheDocument();
    expect(m.last('POST', '/api/orgs').body).toEqual({ name: '새조직' });
    expect(useOrgStore.getState().current).toBe(9);
    fireEvent.click(screen.getByText('NEW-9999'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('NEW-9999'));
    expect(await screen.findByText('복사됨')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '완료' }));
    expect(screen.queryByText(/조직이 만들어졌어요/)).not.toBeInTheDocument();
    // 다시 열고 Esc
    fireEvent.click(document.querySelector('.org-switcher-btn')!);
    fireEvent.click(screen.getByText('조직 만들기'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('새 조직 만들기')).not.toBeInTheDocument();
  });

  it('조직 가입 — 코드 제출 → 대기 안내, 실패는 폼 유지, 취소/오버레이 클릭', async () => {
    mount(<OrgSwitcher />, '/');
    await waitFor(() => expect(useOrgStore.getState().orgs).toHaveLength(2));
    fireEvent.click(document.querySelector('.org-switcher-btn')!);
    fireEvent.click(screen.getByText('조직 가입하기'));
    expect(screen.getByText('조직 가입하기', { selector: '.modal-head' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '신청' })).toBeDisabled();
    m.fail('POST', '/api/orgs/join', 404, '없는 코드');
    await userEvent.type(screen.getByPlaceholderText(/ABCD-2345/), 'BAD');
    fireEvent.click(screen.getByRole('button', { name: '신청' }));
    await waitFor(() => expect(m.calls('POST', '/api/orgs/join')).toHaveLength(1));
    expect(screen.getByPlaceholderText(/ABCD-2345/)).toBeInTheDocument();
    m.post('/api/orgs/join', { orgName: '동국제약' });
    fireEvent.click(screen.getByRole('button', { name: '신청' }));
    expect(await screen.findByText('가입 신청을 보냈어요')).toBeInTheDocument();
    expect(m.last('POST', '/api/orgs/join').body).toEqual({ joinCode: 'BAD' });
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    expect(screen.queryByText('가입 신청을 보냈어요')).not.toBeInTheDocument();
    fireEvent.click(document.querySelector('.org-switcher-btn')!);
    fireEvent.click(screen.getByText('조직 가입하기'));
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByText('가입코드')).not.toBeInTheDocument();
    fireEvent.click(document.querySelector('.org-switcher-btn')!);
    fireEvent.click(screen.getByText('조직 가입하기'));
    fireEvent.click(document.querySelector('.modal-overlay')!);
    expect(screen.queryByText('가입코드')).not.toBeInTheDocument();
  });
});
