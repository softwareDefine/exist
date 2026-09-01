import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockApi } from '../test/mockApi';
import { login, logout } from '../test/auth';
import { api, ApiError } from '../api';
import { useAuthStore } from '../store';

vi.mock('../lib/socket', () => import('../test/socket.mock'));

describe('api()', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    logout();
  });

  it('GET 기본 — JSON 헤더, 토큰 없으면 Authorization 없음', async () => {
    m.get('/api/x', { a: 1 });
    await expect(api('/api/x')).resolves.toEqual({ a: 1 });
    const c = m.last();
    expect(c.method).toBe('GET');
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(c.headers.Authorization).toBeUndefined();
    expect(c.body).toBeUndefined();
  });

  it('로그인 상태면 Bearer 토큰을 싣고 body는 JSON 직렬화', async () => {
    login({}, 'abc');
    m.post('/api/y', { ok: true });
    await api('/api/y', { method: 'POST', body: { q: '한글' } });
    const c = m.last('POST', '/api/y');
    expect(c.headers.Authorization).toBe('Bearer abc');
    expect(c.body).toEqual({ q: '한글' });
  });

  it('서버 error 메시지 + 상태코드로 ApiError, 전역 app:error 이벤트', async () => {
    m.fail('GET', '/api/boom', 500, '서버 터짐');
    const onErr = vi.fn();
    window.addEventListener('app:error', onErr);
    const p = api('/api/boom');
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await p.catch((e: ApiError) => {
      expect(e.status).toBe(500);
      expect(e.message).toBe('서버 터짐 (500)');
    });
    expect(onErr).toHaveBeenCalledTimes(1);
    expect((onErr.mock.calls[0][0] as CustomEvent).detail).toBe('서버 터짐 (500)');
    window.removeEventListener('app:error', onErr);
  });

  it('error 필드 없으면 "요청 실패 (status) · METHOD path"', async () => {
    m.on('DELETE', '/api/z', {}, 403);
    await expect(api('/api/z', { method: 'DELETE' })).rejects.toThrow('요청 실패 (403) · DELETE /api/z');
  });

  it('JSON이 아닌 본문도 빈 객체로 흡수', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('bad json'); } })),
    );
    await expect(api('/api/html')).rejects.toThrow('요청 실패 (502)');
  });

  it('401이면 로그아웃하고 토스트는 띄우지 않는다', async () => {
    login({}, 'stale');
    m.fail('GET', '/api/me', 401, 'unauthorized');
    const onErr = vi.fn();
    window.addEventListener('app:error', onErr);
    await expect(api('/api/me')).rejects.toMatchObject({ status: 401 });
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(onErr).not.toHaveBeenCalled();
    window.removeEventListener('app:error', onErr);
  });

  it('silent 옵션이면 토스트 생략', async () => {
    m.fail('GET', '/api/q', 404, 'nope');
    const onErr = vi.fn();
    window.addEventListener('app:error', onErr);
    await expect(api('/api/q', { silent: true })).rejects.toThrow('nope (404)');
    expect(onErr).not.toHaveBeenCalled();
    window.removeEventListener('app:error', onErr);
  });

  it('/api/auth/* 실패는 인라인 표시용 — 전역 토스트 없음', async () => {
    m.fail('POST', '/api/auth/login', 400, '비밀번호가 틀렸어요');
    const onErr = vi.fn();
    window.addEventListener('app:error', onErr);
    await expect(api('/api/auth/login', { method: 'POST', body: {} })).rejects.toThrow('비밀번호가 틀렸어요 (400)');
    expect(onErr).not.toHaveBeenCalled();
    window.removeEventListener('app:error', onErr);
  });
});
