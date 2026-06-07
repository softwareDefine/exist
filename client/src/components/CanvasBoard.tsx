import { useMemo } from 'react';
import { Tldraw, type TLAssetStore } from 'tldraw';
import { useSync } from '@tldraw/sync';
import 'tldraw/tldraw.css';
import { useAuthStore } from '../store';

/** tldraw 동시편집 캔버스 — roomId 단위 공유 (워크스페이스/회의 공용) */
export default function CanvasBoard({ roomId }: { roomId: string }) {
  const token = useAuthStore((s) => s.token);

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

  return <Tldraw store={store} />;
}
