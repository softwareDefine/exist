/* ../lib/socket 대체 모듈 — 테스트 파일에서
 *   vi.mock('../lib/socket', () => import('../test/socket.mock'));
 * 로 걸고, fakeSocket.trigger('event', payload)로 서버 푸시를 흉내낸다. */
import { vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

export class FakeSocket {
  handlers = new Map<string, Handler[]>();
  emitted: { event: string; args: unknown[] }[] = [];
  /** request()/ack 응답 — 이벤트별 핸들러, 없으면 {} */
  ackHandlers = new Map<string, (data: unknown) => unknown>();
  connected = true;
  active = true;
  id = 'fake-socket';
  io = {
    handlers: new Map<string, Handler[]>(),
    on: (ev: string, h: Handler) => {
      const list = this.io.handlers.get(ev) ?? [];
      list.push(h);
      this.io.handlers.set(ev, list);
      return this.io;
    },
    off: (ev: string, h?: Handler) => {
      const list = this.io.handlers.get(ev) ?? [];
      this.io.handlers.set(ev, h ? list.filter((x) => x !== h) : []);
      return this.io;
    },
  };

  on = vi.fn((ev: string, h: Handler) => {
    const list = this.handlers.get(ev) ?? [];
    list.push(h);
    this.handlers.set(ev, list);
    return this;
  });
  off = vi.fn((ev: string, h?: Handler) => {
    const list = this.handlers.get(ev) ?? [];
    this.handlers.set(ev, h ? list.filter((x) => x !== h) : []);
    return this;
  });
  once = vi.fn((ev: string, h: Handler) => {
    const wrap: Handler = (...a) => {
      this.off(ev, wrap);
      h(...a);
    };
    return this.on(ev, wrap);
  });
  emit = vi.fn((event: string, ...args: unknown[]) => {
    this.emitted.push({ event, args });
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      const h = this.ackHandlers.get(event);
      const res = h ? h(args[0]) : {};
      // 실제 소켓처럼 비동기 ack
      queueMicrotask(() => (cb as (r: unknown) => void)(res));
    }
    return this;
  });
  disconnect = vi.fn(() => {
    this.connected = false;
    this.active = false;
    return this;
  });
  connect = vi.fn(() => {
    this.connected = true;
    this.active = true;
    return this;
  });

  /** 서버 푸시 흉내 */
  trigger(ev: string, ...args: unknown[]) {
    for (const h of [...(this.handlers.get(ev) ?? [])]) h(...args);
  }
  triggerIo(ev: string, ...args: unknown[]) {
    for (const h of [...(this.io.handlers.get(ev) ?? [])]) h(...args);
  }
  listenerCount(ev: string) {
    return (this.handlers.get(ev) ?? []).length;
  }
  emittedOf(event: string) {
    return this.emitted.filter((e) => e.event === event);
  }
  reset() {
    this.handlers.clear();
    this.io.handlers.clear();
    this.emitted = [];
    this.ackHandlers.clear();
    this.connected = true;
    this.active = true;
    this.on.mockClear();
    this.off.mockClear();
    this.emit.mockClear();
    this.disconnect.mockClear();
  }
}

export const fakeSocket = new FakeSocket();

export const getSocket = vi.fn(() => fakeSocket);
export const disconnectSocket = vi.fn(() => {
  fakeSocket.disconnect();
});
/** 실제 request()와 같은 의미론 — ack 객체에 error가 있으면 reject */
export function request<T = unknown>(sock: FakeSocket, event: string, data?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    sock.emit(event, data ?? {}, (res: T & { error?: string }) => {
      if (res && typeof res === 'object' && 'error' in res && res.error) reject(new Error(res.error));
      else resolve(res);
    });
  });
}
