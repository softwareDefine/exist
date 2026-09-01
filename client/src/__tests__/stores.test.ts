import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { mockApi, tick } from '../test/mockApi';
import { login, logout } from '../test/auth';

vi.mock('../lib/socket', () => import('../test/socket.mock'));

import { disconnectSocket } from '../test/socket.mock';
import { useAuthStore } from '../store';
import { useOrgStore, type Org } from '../orgStore';
import { useNameStore, useDisplayName, displayNameOf, useLoadNames } from '../names';

const org = (id: number, extra: Partial<Org> = {}): Org => ({
  id,
  name: `조직${id}`,
  joinCode: `CODE${id}`,
  role: 'member',
  isManager: false,
  canCreateGroup: false,
  memberCount: 3,
  pendingCount: 0,
  ...extra,
});

describe('useAuthStore', () => {
  beforeEach(() => {
    logout();
    vi.mocked(disconnectSocket).mockClear();
  });

  it('setAuth — 토큰·유저 저장 + persist(exist-auth) + 소켓 강제 재연결', async () => {
    useAuthStore.getState().setAuth('t1', { id: 7, username: 'kim' });
    expect(useAuthStore.getState().token).toBe('t1');
    expect(useAuthStore.getState().user?.username).toBe('kim');
    const raw = JSON.parse(localStorage.getItem('exist-auth') ?? '{}');
    expect(raw.state.token).toBe('t1');
    await tick();
    expect(disconnectSocket).toHaveBeenCalled();
  });

  it('logout — 비우고 소켓 끊기', async () => {
    login();
    useAuthStore.getState().logout();
    expect(useAuthStore.getState()).toMatchObject({ token: null, user: null });
    await tick();
    expect(disconnectSocket).toHaveBeenCalled();
  });
});

describe('useOrgStore', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    login({ username: 'juho' });
    useOrgStore.setState({ orgs: [], current: 'personal', loaded: false });
  });

  it('load — 목록 저장, 현재 컨텍스트 유지', async () => {
    m.get('/api/orgs', [org(1), org(2)]);
    useOrgStore.setState({ current: 2 });
    await useOrgStore.getState().load();
    expect(useOrgStore.getState().orgs).toHaveLength(2);
    expect(useOrgStore.getState().current).toBe(2);
    expect(useOrgStore.getState().loaded).toBe(true);
  });

  it('load — 더 이상 멤버가 아닌 조직이면 개인으로 폴백', async () => {
    m.get('/api/orgs', [org(1)]);
    useOrgStore.setState({ current: 99 });
    await useOrgStore.getState().load();
    expect(useOrgStore.getState().current).toBe('personal');
  });

  it('load 실패해도 loaded=true (빈 목록)', async () => {
    m.fail('GET', '/api/orgs', 500);
    await useOrgStore.getState().load();
    expect(useOrgStore.getState().loaded).toBe(true);
    expect(useOrgStore.getState().orgs).toEqual([]);
  });

  it('setCurrent — 사용자별 localStorage 키에 저장, contextParam 반영', () => {
    useOrgStore.getState().setCurrent(5);
    expect(localStorage.getItem('exist:org-context:juho')).toBe('5');
    expect(useOrgStore.getState().contextParam()).toBe('5');
    useOrgStore.getState().setCurrent('personal');
    expect(localStorage.getItem('exist:org-context:juho')).toBe('personal');
    expect(useOrgStore.getState().contextParam()).toBe('personal');
  });
});

describe('names', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    useNameStore.setState({ map: {}, loaded: false });
    logout();
  });

  it('load — 이름 있는 사용자만 맵에', async () => {
    m.get('/api/auth/names', [
      { username: 'a', name: '에이' },
      { username: 'b', name: null },
    ]);
    await useNameStore.getState().load();
    expect(useNameStore.getState().map).toEqual({ a: '에이' });
    expect(useNameStore.getState().loaded).toBe(true);
  });

  it('load 실패는 조용히 무시', async () => {
    m.fail('GET', '/api/auth/names', 401);
    await useNameStore.getState().load();
    expect(useNameStore.getState().loaded).toBe(false);
  });

  it('displayNameOf / useDisplayName — 없으면 아이디, 빈 값은 빈 문자열', () => {
    useNameStore.setState({ map: { a: '에이' } });
    expect(displayNameOf('a')).toBe('에이');
    expect(displayNameOf('zzz')).toBe('zzz');
    expect(displayNameOf(null)).toBe('');
    const { result } = renderHook(() => useDisplayName());
    expect(result.current('a')).toBe('에이');
    expect(result.current('exist AI')).toBe('exist AI');
    expect(result.current(undefined)).toBe('');
  });

  it('useLoadNames — 토큰이 생기면 로드', async () => {
    m.get('/api/auth/names', [{ username: 'a', name: '에이' }]);
    renderHook(() => useLoadNames());
    expect(m.calls('GET', '/api/auth/names')).toHaveLength(0);
    act(() => login());
    await tick();
    expect(m.calls('GET', '/api/auth/names')).toHaveLength(1);
    expect(useNameStore.getState().map.a).toBe('에이');
  });
});
