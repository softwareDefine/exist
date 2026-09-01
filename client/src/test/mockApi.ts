/* fetch 라우트 테이블 — 실제 src/api.ts(api 헬퍼)를 그대로 태우면서 응답만 흉내낸다.
 *
 *   const api = mockApi();
 *   api.get('/api/meetings/ABC/decisions', [...]);
 *   api.post(/\/decisions\/ack$/, { ok: true });
 *   ...
 *   expect(api.calls('POST', '/api/meetings/ABC/decisions/ack')).toHaveLength(1);
 */
import { vi } from 'vitest';

type Matcher = string | RegExp;
type Responder = unknown | ((info: { url: string; body: unknown; method: string }) => unknown);
interface Route {
  method: string;
  match: Matcher;
  status: number;
  respond: Responder;
}
export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

function pathOf(url: string) {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) : url;
}

export class ApiMock {
  routes: Route[] = [];
  recorded: RecordedCall[] = [];
  fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body != null) body = init.body;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.recorded.push({ method, url, path: pathOf(url), body, headers });
    const route = [...this.routes]
      .reverse()
      .find(
        (r) => r.method === method && (typeof r.match === 'string' ? r.match === pathOf(url) : r.match.test(url)),
      );
    if (!route) {
      return this.response(404, { error: `no route ${method} ${url}` });
    }
    const data =
      typeof route.respond === 'function'
        ? await (route.respond as (i: unknown) => unknown)({ url, body, method })
        : route.respond;
    return this.response(route.status, data);
  });

  response(status: number, data: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
      text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
      blob: async () => new Blob([typeof data === 'string' ? data : JSON.stringify(data)]),
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Map<string, string>(),
    } as unknown as Response;
  }

  on(method: string, match: Matcher, respond: Responder, status = 200) {
    this.routes.push({ method: method.toUpperCase(), match, respond, status });
    return this;
  }
  get(match: Matcher, respond: Responder, status = 200) {
    return this.on('GET', match, respond, status);
  }
  post(match: Matcher, respond: Responder, status = 200) {
    return this.on('POST', match, respond, status);
  }
  patch(match: Matcher, respond: Responder, status = 200) {
    return this.on('PATCH', match, respond, status);
  }
  delete(match: Matcher, respond: Responder, status = 200) {
    return this.on('DELETE', match, respond, status);
  }
  /** 실패 라우트 — api()가 ApiError를 던지게 */
  fail(method: string, match: Matcher, status: number, error = 'failed') {
    return this.on(method, match, { error }, status);
  }

  calls(method?: string, match?: Matcher) {
    return this.recorded.filter(
      (c) =>
        (!method || c.method === method.toUpperCase()) &&
        (!match || (typeof match === 'string' ? c.path === match : match.test(c.url))),
    );
  }
  last(method?: string, match?: Matcher) {
    const list = this.calls(method, match);
    return list[list.length - 1];
  }
  reset() {
    this.routes = [];
    this.recorded = [];
    this.fetch.mockClear();
  }
}

/** globalThis.fetch를 라우트 테이블로 교체 — beforeEach에서 호출 */
export function mockApi(): ApiMock {
  const m = new ApiMock();
  vi.stubGlobal('fetch', m.fetch);
  return m;
}

/** 다음 매크로태스크까지 대기 — api() then 체인이 state에 반영될 시간 */
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
