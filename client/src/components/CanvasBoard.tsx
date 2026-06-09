import { useEffect, useMemo, useRef, useState } from 'react';
import { Tldraw, type TLAssetStore, type Editor } from 'tldraw';
import { useSync } from '@tldraw/sync';
import 'tldraw/tldraw.css';
import { useAuthStore } from '../store';

/** tldraw 동시편집 캔버스 — roomId 단위 공유 (워크스페이스/회의 공용) */
export default function CanvasBoard({ roomId }: { roomId: string }) {
  const token = useAuthStore((s) => s.token);
  const editorRef = useRef<Editor | null>(null);

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
  useEffect(() => {
    editorRef.current?.user.updateUserPreferences({ colorScheme: dark ? 'dark' : 'light' });
  }, [dark]);

  const assets = useMemo<TLAssetStore>(
    () => ({
      async upload(_asset, file) {
        const res = await fetch(
          `/api/workspaces/uploads?name=${encodeURIComponent(file.name)}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: file,
          },
        );
        const { url } = (await res.json()) as { url: string };
        return { src: url };
      },
      resolve(asset) {
        return asset.props.src;
      },
    }),
    [token],
  );

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const store = useSync({
    uri: `${proto}://${location.host}/sync?roomId=${roomId}&token=${token}`,
    assets,
  });

  return (
    <Tldraw
      store={store}
      onMount={(editor) => {
        editorRef.current = editor;
        editor.user.updateUserPreferences({ colorScheme: dark ? 'dark' : 'light' });
      }}
    />
  );
}
