import { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '../store';

/*
 * Excalidraw 동시편집 캔버스 (MIT, 워터마크/라이선스 없음).
 * 협업은 기존 Yjs 백엔드(/yjs)를 재사용한다 — 엘리먼트를 Y.Map<id, element>에
 * 담고, Excalidraw의 element.version(높을수록 최신)으로 충돌을 해소한다.
 * 이미지 등 바이너리는 Y.Map<id, BinaryFileData>로 함께 동기화.
 * 커서/이름은 provider.awareness 로 표시.
 */

const CURSOR_COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];

// Excalidraw 깊은 타입 의존을 피하기 위한 최소 구조 타입
type SceneElement = { id: string; version: number; isDeleted?: boolean; [k: string]: unknown };
type BinaryFile = { id: string; [k: string]: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExcalidrawAPI = any;

export default function CanvasBoard({ roomId }: { roomId: string }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);

  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const yElsRef = useRef<Y.Map<SceneElement> | null>(null);
  const yFilesRef = useRef<Y.Map<BinaryFile> | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const applyingRemote = useRef(false);

  // 앱 다크모드(html.dark) 추종
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains('dark')),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  // ── Yjs 연결 ──
  useEffect(() => {
    const ydoc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, ydoc, {
      params: { token: token ?? '' },
    });
    const yEls = ydoc.getMap<SceneElement>('elements');
    const yFiles = ydoc.getMap<BinaryFile>('files');
    ydocRef.current = ydoc;
    yElsRef.current = yEls;
    yFilesRef.current = yFiles;
    providerRef.current = provider;

    const color = CURSOR_COLORS[(user?.id ?? 0) % CURSOR_COLORS.length];
    provider.awareness.setLocalStateField('user', { name: user?.username ?? '익명', color });

    // 원격 변경 → Excalidraw 반영
    const applyRemote = () => {
      const api = apiRef.current;
      if (!api) return;
      const elements = Array.from(yEls.values());
      const files = Array.from(yFiles.values());
      applyingRemote.current = true;
      try {
        if (files.length) api.addFiles(files);
        api.updateScene({ elements });
      } finally {
        applyingRemote.current = false;
      }
    };
    yEls.observe(applyRemote);
    yFiles.observe(applyRemote);
    provider.on('sync', (isSynced: boolean) => {
      if (isSynced) applyRemote();
    });

    // 원격 커서/선택 → collaborators
    const onAwareness = () => {
      const api = apiRef.current;
      if (!api) return;
      const collaborators = new Map<string, unknown>();
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === provider.awareness.clientID) return;
        const u = (state as { user?: { name: string; color: string }; pointer?: { x: number; y: number } }).user;
        const p = (state as { pointer?: { x: number; y: number } }).pointer;
        if (!u) return;
        collaborators.set(String(clientId), {
          username: u.name,
          color: { background: u.color, stroke: u.color },
          pointer: p ? { x: p.x, y: p.y, tool: 'pointer' } : undefined,
        });
      });
      api.updateScene({ collaborators });
    };
    provider.awareness.on('change', onAwareness);

    return () => {
      yEls.unobserve(applyRemote);
      yFiles.unobserve(applyRemote);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      yElsRef.current = null;
      yFilesRef.current = null;
      providerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  // ── 로컬 변경 → Yjs ──
  const onChange = useCallback(
    (elements: readonly SceneElement[], _appState: unknown, files: Record<string, BinaryFile>) => {
      if (applyingRemote.current) return;
      const yEls = yElsRef.current;
      const yFiles = yFilesRef.current;
      const ydoc = ydocRef.current;
      if (!yEls || !yFiles || !ydoc) return;
      ydoc.transact(() => {
        for (const el of elements) {
          const cur = yEls.get(el.id);
          // version이 더 높을 때만 기록 → 원격 반영으로 인한 에코 방지
          if (!cur || (cur.version ?? 0) < (el.version ?? 0)) yEls.set(el.id, el);
        }
        if (files) {
          for (const id of Object.keys(files)) {
            if (!yFiles.has(id)) yFiles.set(id, files[id]);
          }
        }
      });
    },
    [],
  );

  const onPointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number } }) => {
      providerRef.current?.awareness.setLocalStateField('pointer', {
        x: payload.pointer.x,
        y: payload.pointer.y,
      });
    },
    [],
  );

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Excalidraw
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        excalidrawAPI={(api: any) => {
          apiRef.current = api;
        }}
        onChange={onChange as never}
        onPointerUpdate={onPointerUpdate as never}
        theme={dark ? 'dark' : 'light'}
        isCollaborating
      />
    </div>
  );
}
