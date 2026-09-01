/* 'y-websocket' 대체 — 네트워크 없이 로컬 Y.Doc + 진짜 Awareness로 에디터를 돌린다.
 *   vi.mock('y-websocket', () => import('../../test/yws.mock'));
 * 생성 직후 microtask에 status=connected·sync=true를 흘려 에디터 초기화(첫 시트/슬라이드 생성)를 유도 */
import type * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

type Handler = (...a: unknown[]) => void;

export class WebsocketProvider {
  static instances: WebsocketProvider[] = [];
  awareness: Awareness;
  doc: Y.Doc;
  roomname: string;
  url: string;
  wsconnected = false;
  synced = false;
  destroyed = false;
  private handlers = new Map<string, Handler[]>();
  constructor(url: string, room: string, doc: Y.Doc, _opts?: unknown) {
    this.url = url;
    this.roomname = room;
    this.doc = doc;
    this.awareness = new Awareness(doc);
    WebsocketProvider.instances.push(this);
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.wsconnected = true;
      this.emit('status', { status: 'connected' });
      this.synced = true;
      this.emit('sync', true);
    });
  }
  on(ev: string, h: Handler) {
    const list = this.handlers.get(ev) ?? [];
    list.push(h);
    this.handlers.set(ev, list);
  }
  off(ev: string, h: Handler) {
    this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter((x) => x !== h));
  }
  once(ev: string, h: Handler) {
    const wrap: Handler = (...a) => {
      this.off(ev, wrap);
      h(...a);
    };
    this.on(ev, wrap);
  }
  emit(ev: string, ...a: unknown[]) {
    for (const h of [...(this.handlers.get(ev) ?? [])]) h(...a);
  }
  connect() {}
  disconnect() {}
  destroy() {
    this.destroyed = true;
    this.awareness.destroy();
    this.handlers.clear();
  }
}
