import { useEffect, useMemo, useState } from 'react';
import { Tldraw, type TLAssetStore } from 'tldraw';
import { useSync } from '@tldraw/sync';
import 'tldraw/tldraw.css';
import { api } from '../api';
import { useAuthStore } from '../store';
import { FolderIcon, PhoneIcon, CloseIcon } from './Icons';
import MeetingHub from './MeetingHub';

interface Workspace {
  id: number;
  name: string;
}

export interface MeetingTabRequest {
  code: string;
  title: string;
  ts: number; // 같은 회의 재클릭도 감지
}

type ActiveTab = { kind: 'ws'; id: number } | { kind: 'meeting'; code: string };

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

interface Props {
  /** 최근 회의 클릭 → 회의 탭 열기 요청 */
  meetingRequest?: MeetingTabRequest | null;
}

export default function WorkspacePanel({ meetingRequest }: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [meetingTabs, setMeetingTabs] = useState<{ code: string; title: string }[]>([]);
  const [active, setActive] = useState<ActiveTab | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null); // 오버레이 전체화면 회의 코드
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  // ESC로 전체화면 축소
  useEffect(() => {
    if (!expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setExpanded(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  async function refresh() {
    const list = await api<Workspace[]>('/api/workspaces');
    setWorkspaces(list);
    if (list.length > 0 && active === null) setActive({ kind: 'ws', id: list[0].id });
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 회의 탭 열기 요청 처리
  useEffect(() => {
    if (!meetingRequest) return;
    setMeetingTabs((prev) =>
      prev.some((t) => t.code === meetingRequest.code)
        ? prev
        : [...prev, { code: meetingRequest.code, title: meetingRequest.title }],
    );
    setActive({ kind: 'meeting', code: meetingRequest.code });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingRequest?.ts]);

  function closeMeetingTab(code: string, message?: string) {
    setMeetingTabs((prev) => prev.filter((t) => t.code !== code));
    setExpanded((cur) => (cur === code ? null : cur));
    setActive((cur) =>
      cur?.kind === 'meeting' && cur.code === code
        ? workspaces.length > 0
          ? { kind: 'ws', id: workspaces[0].id }
          : null
        : cur,
    );
    if (message) window.dispatchEvent(new CustomEvent('app:error', { detail: message }));
  }

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
    setActive({ kind: 'ws', id: ws.id });
  }

  const activeWs = active?.kind === 'ws' ? active.id : null;

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
            className={`ws-tab${activeWs === ws.id ? ' active' : ''}`}
            onClick={() => setActive({ kind: 'ws', id: ws.id })}
          >
            <FolderIcon size={16} /> {ws.name}
          </button>
        ))}
        {meetingTabs.map((t) => (
          <button
            key={t.code}
            className={`ws-tab meeting${
              active?.kind === 'meeting' && active.code === t.code ? ' active' : ''
            }`}
            onClick={() => setActive({ kind: 'meeting', code: t.code })}
          >
            <PhoneIcon size={14} /> {t.title}
            <span
              className="tab-close"
              title="회의 나가기"
              onClick={(e) => {
                e.stopPropagation();
                closeMeetingTab(t.code);
              }}
            >
              <CloseIcon size={12} />
            </span>
          </button>
        ))}
      </div>

      <div className="workspace-canvas">
        {activeWs !== null && <WorkspaceCanvas key={activeWs} workspaceId={activeWs} />}

        {/* 회의 탭은 비활성이어도 마운트 유지 (연결 보존) — display로만 전환,
            확대 시 fixed 오버레이로 승격 (리마운트 없음 = 끊김 없음) */}
        {meetingTabs.map((t) => {
          const isActive = active?.kind === 'meeting' && active.code === t.code;
          const isExpanded = expanded === t.code;
          return (
            <div
              key={t.code}
              className={`meeting-tab-host${isExpanded ? ' fullscreen' : ''}`}
              style={{ display: isActive || isExpanded ? 'block' : 'none' }}
            >
              <MeetingHub
                code={t.code}
                expanded={isExpanded}
                onToggleExpand={() => setExpanded((cur) => (cur === t.code ? null : t.code))}
              />
            </div>
          );
        })}

        {active === null && (
          <div className="workspace-empty">+ 버튼으로 첫 작업 공간을 만들어보세요</div>
        )}
      </div>
    </section>
  );
}
