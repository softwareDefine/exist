import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockApi } from '../../test/mockApi';
import { login } from '../../test/auth';
import { initPush } from '../push';

vi.mock('../socket', () => import('../../test/socket.mock'));

const VAPID = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

function setupPushEnv(perm: NotificationPermission, existingSub: unknown = null) {
  const subscribe = vi.fn(async () => ({ toJSON: () => ({ endpoint: 'https://push/new' }) }));
  const getSubscription = vi.fn(async () => existingSub);
  const register = vi.fn(async () => ({ pushManager: { subscribe, getSubscription } }));
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
  vi.stubGlobal('PushManager', function PushManager() {});
  const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  vi.stubGlobal('Notification', { permission: perm, requestPermission });
  return { register, subscribe, getSubscription, requestPermission };
}

describe('initPush', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    login();
  });
  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  });

  it('브라우저가 푸시를 지원하지 않으면 아무것도 안 함', async () => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    await initPush();
    expect(m.recorded).toHaveLength(0);
  });

  it('권한 허용 + 기존 구독 없음 → 키 받아 구독하고 서버에 등록', async () => {
    const env = setupPushEnv('granted');
    m.get('/api/push/key', { key: VAPID });
    m.post('/api/push/subscribe', { ok: true });
    await initPush();
    expect(env.register).toHaveBeenCalledWith('/sw.js');
    expect(env.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(ArrayBuffer) }),
    );
    const c = m.last('POST', '/api/push/subscribe');
    expect(c.body).toEqual({ subscription: { endpoint: 'https://push/new' } });
  });

  it('기존 구독이 있으면 재구독하지 않고 그걸 보낸다', async () => {
    const env = setupPushEnv('granted', { toJSON: () => ({ endpoint: 'https://push/old' }) });
    m.get('/api/push/key', { key: VAPID });
    m.post('/api/push/subscribe', { ok: true });
    await initPush();
    expect(env.subscribe).not.toHaveBeenCalled();
    expect(m.last('POST', '/api/push/subscribe').body).toEqual({ subscription: { endpoint: 'https://push/old' } });
  });

  it('권한 미정이면 한 번만 물어본다 (exist:push-asked)', async () => {
    const env = setupPushEnv('default');
    env.requestPermission.mockResolvedValue('denied');
    await initPush();
    expect(env.requestPermission).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('exist:push-asked')).toBe('1');
    expect(m.calls('GET', '/api/push/key')).toHaveLength(0);
    // 두 번째 호출 — 이미 물어봤으므로 다시 묻지 않음
    await initPush();
    expect(env.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('거부 상태면 서버 호출 없음', async () => {
    setupPushEnv('denied');
    await initPush();
    expect(m.recorded).toHaveLength(0);
  });

  it('서버에 VAPID 키가 없으면(404) 조용히 종료', async () => {
    const env = setupPushEnv('granted');
    m.fail('GET', '/api/push/key', 404, 'no key');
    await expect(initPush()).resolves.toBeUndefined();
    expect(env.subscribe).not.toHaveBeenCalled();
  });
});
