/* XMLHttpRequest 대체 — 업로드(진행률 때문에 fetch 대신 XHR)를 쓰는 컴포넌트용.
 *   const xhr = mockXhr();            // globalThis.XMLHttpRequest 교체 (restoreMocks가 되돌림)
 *   xhr.respond = (req) => ({ status: 200, body: '{}' });
 *   ... upload ...
 *   expect(xhr.requests[0]).toMatchObject({ method: 'POST', url: /files\/upload/ });
 * send() 직후 upload.onprogress(50%)→onload가 마이크로태스크로 흐른다 */
import { vi } from 'vitest';

export interface XhrRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export class FakeXhr {
  static requests: XhrRecord[] = [];
  static respond: (req: XhrRecord) => { status: number; body?: string } = () => ({ status: 200, body: '{}' });
  status = 0;
  responseText = '';
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private rec: XhrRecord = { method: 'GET', url: '', headers: {}, body: undefined };
  open(method: string, url: string) {
    this.rec.method = method.toUpperCase();
    this.rec.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.rec.headers[k] = v;
  }
  send(body?: unknown) {
    this.rec.body = body;
    FakeXhr.requests.push(this.rec);
    const total = body instanceof Blob ? body.size : 100;
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: Math.floor(total / 2), total });
      const r = FakeXhr.respond(this.rec);
      this.status = r.status;
      this.responseText = r.body ?? '';
      queueMicrotask(() => this.onload?.());
    });
  }
}

export function mockXhr() {
  FakeXhr.requests = [];
  FakeXhr.respond = () => ({ status: 200, body: '{}' });
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return FakeXhr;
}
