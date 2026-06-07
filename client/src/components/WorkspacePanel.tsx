import { useEffect, useState } from 'react';
import { api } from '../api';
import { FolderIcon, PhoneIcon, CloseIcon } from './Icons';
import CanvasBoard from './CanvasBoard';
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

interface Props {
  /** 최근 회의 클릭 → 회의 탭 열기 요청 */
  meetingRequest?: MeetingTabRequest | null;
}

export default function WorkspacePanel({ meetingRequest }: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [meetingTabs, setMeetingTabs] = useState<{ code: string; title: string }[]>([]);
  const [active, setActive] = useState<ActiveTab | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null); // 오버레이 전체화면 회의 코드
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

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

  async function renameWorkspace(e: React.FormEvent) {
    e.preventDefault();
    if (renaming === null || !renameValue.trim()) return setRenaming(null);
    await api(`/api/workspaces/${renaming}`, { method: 'PATCH', body: { name: renameValue } });
    setRenaming(null);
    await refresh();
  }

  async function deleteWorkspace(id: number) {
    if (!window.confirm('작업공간을 삭제할까요? 캔버스 내용은 서버에 보존돼요.')) return;
    await api(`/api/workspaces/${id}`, { method: 'DELETE' });
    setActive((cur) => (cur?.kind === 'ws' && cur.id === id ? null : cur));
    const list = await api<Workspace[]>('/api/workspaces');
    setWorkspaces(list);
    setActive((cur) => cur ?? (list.length > 0 ? { kind: 'ws', id: list[0].id } : null));
  }

  const activeWs = active?.kind === 'ws' ? active.id : null;

  return (
    <section className="workspace-panel">
      <div className="workspace-tabs">
        {workspaces.map((ws) =>
          renaming === ws.id ? (
            <form key={ws.id} className="ws-create" onSubmit={renameWorkspace}>
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={renameWorkspace}
                autoFocus
              />
            </form>
          ) : (
            <button
              key={ws.id}
              className={`ws-tab${activeWs === ws.id ? ' active' : ''}`}
              onClick={() => setActive({ kind: 'ws', id: ws.id })}
              onDoubleClick={() => {
                setRenaming(ws.id);
                setRenameValue(ws.name);
              }}
              title="더블클릭으로 이름 변경"
            >
              <FolderIcon size={16} /> {ws.name}
              <span
                className="tab-close"
                title="작업공간 삭제"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteWorkspace(ws.id);
                }}
              >
                <CloseIcon size={12} />
              </span>
            </button>
          ),
        )}
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
        {activeWs !== null && <CanvasBoard key={activeWs} roomId={`ws-${activeWs}`} />}

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

        {active === null && meetingTabs.length === 0 && (
          <div className="workspace-empty">최근 회의를 클릭하면 회의 공간이 열려요</div>
        )}
      </div>
    </section>
  );
}
