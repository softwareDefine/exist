import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { mockApi } from '../../test/mockApi';
import { login } from '../../test/auth';

vi.mock('../socket', () => import('../../test/socket.mock'));
import { fakeSocket } from '../../test/socket.mock';
import { usePresence } from '../usePresence';

describe('usePresence', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    login();
  });

  it('최초 스냅샷 로드 → 소켓 푸시로 갱신 → 재연결 시 재조회, 언마운트 시 해제', async () => {
    m.get('/api/presence', { users: ['a', 'b'] });
    const { result, unmount } = renderHook(() => usePresence());
    expect(result.current.size).toBe(0);
    await waitFor(() => expect(result.current.has('a')).toBe(true));
    expect(result.current.has('b')).toBe(true);

    act(() => fakeSocket.trigger('presence:update', { users: ['c'] }));
    expect([...result.current]).toEqual(['c']);

    m.get('/api/presence', { users: ['d'] });
    act(() => fakeSocket.trigger('connect'));
    await waitFor(() => expect(result.current.has('d')).toBe(true));
    expect(m.calls('GET', '/api/presence')).toHaveLength(2);

    unmount();
    expect(fakeSocket.listenerCount('presence:update')).toBe(0);
    expect(fakeSocket.listenerCount('connect')).toBe(0);
  });

  it('스냅샷 실패는 무시 (빈 집합 유지)', async () => {
    m.fail('GET', '/api/presence', 500);
    const { result } = renderHook(() => usePresence());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.size).toBe(0);
  });
});
