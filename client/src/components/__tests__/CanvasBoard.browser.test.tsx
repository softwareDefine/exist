import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { fireEvent } from '@testing-library/dom';
import * as Y from 'yjs';
import { login } from '../../test/auth';
import { tick } from '../../test/browser';

// 폰트는 로컬(404)에서 찾게 — CDN으로 나가지 않도록
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/';

vi.mock('y-websocket', () => import('../../test/yws.mock'));
// 진짜 Excalidraw를 그대로 쓰되 excalidrawAPI 콜백만 가로채 테스트가 API에 닿게 한다
vi.mock('@excalidraw/excalidraw', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@excalidraw/excalidraw')>();
  const Real = mod.Excalidraw;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Wrapped = (props: any) => (
    <Real
      {...props}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      excalidrawAPI={(api: any) => {
        (window as unknown as { __exApi: unknown }).__exApi = api;
        props.excalidrawAPI?.(api);
      }}
    />
  );
  return { ...mod, Excalidraw: Wrapped };
});

import { WebsocketProvider } from '../../test/yws.mock';
import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import CanvasBoard from '../CanvasBoard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const exApi = () => (window as unknown as { __exApi: any }).__exApi;
const provider = () => WebsocketProvider.instances.at(-1)!;

/** Excalidraw가 만든 것과 같은 완전한 사각형 요소 (index·seed 등 포함) — 진짜 피어가 보낸 형태 */
function rect(id: string, extra: Record<string, unknown> = {}) {
  const [el] = convertToExcalidrawElements([{ type: 'rectangle', x: 100, y: 100, width: 120, height: 80 }]);
  return { ...(el as unknown as Record<string, unknown>), id, version: 1, versionNonce: 1, ...extra };
}

/** 원격 클라이언트가 보낸 것처럼 — 별도 Doc에서 만든 업데이트를 적용 (txn.local=false) */
function remoteSet(doc: Y.Doc, map: string, key: string, value: unknown) {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  other.getMap(map).set(key, value);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)), 'remote');
}

async function mount(props: Partial<{ roomId: string; active: boolean }> = {}) {
  const r = render(
    <div style={{ width: 900, height: 600 }}>
      <CanvasBoard roomId={props.roomId ?? 'canvas-1'} active={props.active} />
    </div>,
  );
  await vi.waitFor(() => expect(document.querySelector('.excalidraw')).toBeTruthy(), { timeout: 15000 });
  await vi.waitFor(() => expect(exApi()).toBeTruthy());
  await tick(50);
  return r;
}

describe('CanvasBoard (Excalidraw + Yjs, Chromium)', () => {
  beforeEach(() => {
    login({ id: 3, username: 'juho', name: '이주호' });
    WebsocketProvider.instances.length = 0;
    (window as unknown as { __exApi: unknown }).__exApi = null;
  });
  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('마운트 — Excalidraw 캔버스가 뜨고 awareness에 내 이름·색이 실린다', async () => {
    await mount();
    expect(document.querySelector('.excalidraw canvas')).toBeTruthy();
    expect(document.querySelector('.excalidraw.theme--dark')).toBeNull();
    const p = provider();
    expect(p.roomname).toBe('canvas-1');
    expect(p.awareness.getLocalState()?.user).toEqual({ name: '이주호', color: '#4f7cff' });
  });

  it('동기화 시 Y.Map의 초기 장면이 캔버스에 실리고, 원격 변경이 반영된다', async () => {
    await mount({ roomId: 'canvas-2' });
    const doc = provider().doc;
    remoteSet(doc, 'elements', 'r1', rect('r1'));
    await vi.waitFor(() => expect(exApi().getSceneElements().map((e: { id: string }) => e.id)).toEqual(['r1']));
    // 원격 이동 — version은 조금만 올라가도 채택
    remoteSet(doc, 'elements', 'r1', rect('r1', { x: 300, version: 2, versionNonce: 2 }));
    await vi.waitFor(() => expect(exApi().getSceneElements()[0].x).toBe(300));
    // 원격 파일(이미지 바이너리) 추가 → addFiles
    remoteSet(doc, 'files', 'f1', {
      id: 'f1',
      mimeType: 'image/png',
      dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      created: 1,
    });
    await vi.waitFor(() => expect(Object.keys(exApi().getFiles())).toContain('f1'));
  });

  it('로컬 변경(updateScene → onChange)이 Yjs에 기록되고, 주입된 원격 요소는 되쓰지 않는다(에코 방지)', async () => {
    await mount({ roomId: 'canvas-3' });
    const doc = provider().doc;
    const yEls = doc.getMap<{ id: string; x: number; version: number }>('elements');
    exApi().updateScene({ elements: [rect('local1', { x: 10 })] });
    await vi.waitFor(() => expect(yEls.get('local1')).toMatchObject({ id: 'local1', x: 10 }));
    // 원격에서 온 요소 — 그대로 다시 저장되지 않아야 함 (버전이 원격 값 그대로)
    // index는 장면 안에서 유일해야 한다 — 겹치면 Excalidraw가 재배정하며 version을 올려 진짜 변경처럼 보인다
    remoteSet(doc, 'elements', 'remote1', rect('remote1', { version: 5, versionNonce: 55, index: 'a1' }));
    await vi.waitFor(() =>
      expect(exApi().getSceneElements().map((e: { id: string }) => e.id).sort()).toEqual(['local1', 'remote1']),
    );
    await tick(100);
    expect(yEls.get('remote1')).toMatchObject({ version: 5, versionNonce: 55 });
    // 파일 등록 → yFiles
    exApi().addFiles([{ id: 'img1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', created: 1 }]);
    exApi().updateScene({ elements: [rect('local1', { x: 11, version: 2, versionNonce: 2 })] });
    await vi.waitFor(() => expect(doc.getMap('files').has('img1')).toBe(true));
  });

  it('원격 커서/이름 → collaborators, 포인터 이동은 awareness pointer 필드로', async () => {
    await mount({ roomId: 'canvas-4' });
    const aw = provider().awareness;
    aw.states.set(42, { user: { name: '김대리', color: '#e5484d' }, pointer: { x: 50, y: 60 } });
    aw.states.set(43, { user: { name: '박과장', color: '#f76808' } });
    aw.states.set(44, { pointer: { x: 1, y: 1 } }); // user 없음 → 무시
    aw.emit('change', [{ added: [42, 43, 44], updated: [], removed: [] }, 'remote']);
    await vi.waitFor(() => {
      const c = exApi().getAppState().collaborators as Map<string, { username: string; pointer?: unknown }>;
      expect([...c.keys()].sort()).toEqual(['42', '43']);
      expect(c.get('42')).toMatchObject({ username: '김대리', pointer: { x: 50, y: 60, tool: 'pointer' } });
      expect(c.get('43')?.pointer).toBeUndefined();
    });
    // 내 포인터 → awareness
    const canvas = document.querySelector('.excalidraw canvas.interactive') ?? document.querySelector('.excalidraw canvas')!;
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 150, pointerId: 1, buttons: 0 });
    await vi.waitFor(() => expect(aw.getLocalState()?.pointer).toBeTruthy());
  });

  it('내가 포인터를 누르고 있는 동안 원격 반영은 보류되고, 놓고 350ms 뒤 적용된다', async () => {
    await mount({ roomId: 'canvas-5' });
    const doc = provider().doc;
    const wrap = document.querySelector('.excalidraw')!;
    fireEvent.pointerDown(wrap, { clientX: 400, clientY: 300, pointerId: 1, buttons: 1, button: 0 });
    remoteSet(doc, 'elements', 'late', rect('late'));
    await tick(150);
    expect(exApi().getSceneElements().map((e: { id: string }) => e.id)).not.toContain('late');
    // 커서도 보류
    const aw = provider().awareness;
    aw.states.set(7, { user: { name: '이대리', color: '#30a46c' } });
    aw.emit('change', [{ added: [7], updated: [], removed: [] }, 'remote']);
    await tick(80);
    expect((exApi().getAppState().collaborators as Map<string, unknown>).has('7')).toBe(false);
    fireEvent.pointerUp(wrap, { clientX: 400, clientY: 300, pointerId: 1, buttons: 0, button: 0 });
    await vi.waitFor(() => expect(exApi().getSceneElements().map((e: { id: string }) => e.id)).toContain('late'), {
      timeout: 3000,
    });
    await vi.waitFor(() => expect((exApi().getAppState().collaborators as Map<string, unknown>).has('7')).toBe(true));
  });

  it('다크모드 추종, active=false면 awareness 내림, 언마운트 시 provider·리스너 정리', async () => {
    const { rerender, unmount } = await mount({ roomId: 'canvas-6' });
    document.documentElement.classList.add('dark');
    await vi.waitFor(() => expect(document.querySelector('.excalidraw.theme--dark')).toBeTruthy());
    const p = provider();
    rerender(
      <div style={{ width: 900, height: 600 }}>
        <CanvasBoard roomId="canvas-6" active={false} />
      </div>,
    );
    await vi.waitFor(() => expect(p.awareness.getLocalState()).toBeNull());
    rerender(
      <div style={{ width: 900, height: 600 }}>
        <CanvasBoard roomId="canvas-6" active />
      </div>,
    );
    await vi.waitFor(() => expect(p.awareness.getLocalState()?.user).toMatchObject({ name: '이주호' }));
    unmount();
    expect(p.destroyed).toBe(true);
  });
});
