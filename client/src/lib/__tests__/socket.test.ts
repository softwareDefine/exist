import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Sock {
  active: boolean;
  disconnect: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  opts?: { auth: (cb: (a: unknown) => void) => void };
}
const created: Sock[] = [];
vi.mock('socket.io-client', () => ({
  io: vi.fn((_url: string, opts: Sock['opts']) => {
    const s: Sock = { active: true, disconnect: vi.fn(), emit: vi.fn(), opts };
    s.disconnect.mockImplementation(() => {
      s.active = false;
    });
    created.push(s);
    return s;
  }),
}));

import { io } from 'socket.io-client';
import { getSocket, disconnectSocket, request } from '../socket';
import { useAuthStore } from '../../store';

beforeEach(() => {
  created.length = 0;
  disconnectSocket();
  created.length = 0;
  vi.mocked(io).mockClear();
});

describe('getSocket', () => {
  it('lazy 싱글턴 — 활성 소켓이 있으면 재사용', () => {
    const a = getSocket();
    const b = getSocket();
    expect(a).toBe(b);
    expect(io).toHaveBeenCalledTimes(1);
    expect(io).toHaveBeenCalledWith('/', expect.objectContaining({ auth: expect.any(Function) }));
  });

  it('auth 콜백은 호출 시점의 스토어 토큰을 준다 (재연결 재인증)', () => {
    useAuthStore.setState({ token: 'tok-1' });
    const s = getSocket() as unknown as Sock;
    const cb = vi.fn();
    s.opts!.auth(cb);
    expect(cb).toHaveBeenCalledWith({ token: 'tok-1' });
    useAuthStore.setState({ token: 'tok-2' });
    s.opts!.auth(cb);
    expect(cb).toHaveBeenLastCalledWith({ token: 'tok-2' });
  });

  it('비활성(끊긴) 소켓이면 정리하고 새로 만든다', () => {
    const a = getSocket() as unknown as Sock;
    a.active = false;
    const b = getSocket();
    expect(b).not.toBe(a);
    expect(a.disconnect).toHaveBeenCalled();
    expect(created).toHaveLength(2);
  });

  it('disconnectSocket 후 다음 getSocket은 새 연결', () => {
    const a = getSocket() as unknown as Sock;
    disconnectSocket();
    expect(a.disconnect).toHaveBeenCalledTimes(1);
    const b = getSocket();
    expect(b).not.toBe(a);
  });

  it('disconnectSocket은 소켓이 없을 때도 안전', () => {
    expect(() => disconnectSocket()).not.toThrow();
    expect(() => disconnectSocket()).not.toThrow();
  });
});

describe('request', () => {
  function sockWithAck(res: unknown) {
    return {
      emit: vi.fn((_ev: string, _data: unknown, cb: (r: unknown) => void) => cb(res)),
    } as unknown as Parameters<typeof request>[0];
  }

  it('ack 응답을 resolve', async () => {
    const s = sockWithAck({ ok: true, list: [1] });
    await expect(request(s, 'x:list', { a: 1 })).resolves.toEqual({ ok: true, list: [1] });
    expect(s.emit).toHaveBeenCalledWith('x:list', { a: 1 }, expect.any(Function));
  });

  it('data 생략 시 빈 객체를 보낸다', async () => {
    const s = sockWithAck(null);
    await request(s, 'ping');
    expect(s.emit).toHaveBeenCalledWith('ping', {}, expect.any(Function));
  });

  it('{error}가 오면 reject(Error)', async () => {
    const s = sockWithAck({ error: '권한 없음' });
    await expect(request(s, 'x')).rejects.toThrow('권한 없음');
  });

  it('error가 빈 문자열이면 정상 응답으로 본다', async () => {
    const s = sockWithAck({ error: '', ok: 1 });
    await expect(request(s, 'x')).resolves.toEqual({ error: '', ok: 1 });
  });

  it('원시값 응답도 그대로 resolve', async () => {
    const s = sockWithAck(42);
    await expect(request<number>(s, 'x')).resolves.toBe(42);
  });
});
