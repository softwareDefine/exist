import { useEffect, useMemo, useState } from 'react';
import { Tldraw, type TLAssetStore } from 'tldraw';
import { useSync } from '@tldraw/sync';
import 'tldraw/tldraw.css';
import { api } from '../api';
import { useAuthStore } from '../store';
import { FolderIcon } from './Icons';

interface Workspace {
  id: number;
  name: string;
}

function WorkspaceCanvas({ workspaceId }: { workspaceId: number }) {
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
    uri: `${proto}://${location.host}/sync?roomId=ws-${workspaceId}&token=${token}`,
    assets,
  });

  return <Tldraw store={store} />;
}

export default function WorkspacePanel() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  async function refresh() {
    const list = await api<Workspace[]>('/api/workspaces');
    setWorkspaces(list);
    if (list.length > 0 && activeId === null) setActiveId(list[0].id);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createWorkspace(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const ws = await api<Workspace>('/api/workspaces', {
      method: 'POST',
      body: { name: newName },
    });
    setNewName('');
    setCreating(false);
    await refresh();
    setActiveId(ws.id);
  }

  return (
    <section className="workspace-panel">
      <div className="workspace-tabs">
        <button className="ws-add" onClick={() => setCreating((v) => !v)} title="새 작업 공간">
          +
        </button>
        {creating && (
          <form className="ws-create" onSubmit={createWorkspace}>
            <input
              placeholder="작업 공간 이름"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </form>
        )}
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            className={`ws-tab${ws.id === activeId ? ' active' : ''}`}
            onClick={() => setActiveId(ws.id)}
          >
            <FolderIcon size={16} /> {ws.name}
          </button>
        ))}
      </div>

      <div className="workspace-canvas">
        {activeId !== null ? (
          <WorkspaceCanvas key={activeId} workspaceId={activeId} />
        ) : (
          <div className="workspace-empty">+ 버튼으로 첫 작업 공간을 만들어보세요</div>
        )}
      </div>
    </section>
  );
}
