import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import CodeDocEditor from './CodeDocEditor';
import DocEditor from './DocEditor';
import SheetEditor from './SheetEditor';
import SlideEditor from './SlideEditor';
import CanvasBoard from './CanvasBoard';
import Marquee from './Marquee';
import {
  FolderIcon,
  CodeIcon,
  DocIcon,
  SheetIcon,
  SlideIcon,
  PenIcon,
  ChevronIcon,
  PlusIcon,
} from './Icons';

/*
 * 공동편집 파일시스템 — 코드/문서/시트/발표/캔버스를 파일 단위로 여러 개, 폴더로 정리.
 * 탐색기(파일 트리 전체 화면) ↔ 에디터(전체 화면, ← 로 복귀) 두 뷰로 전환.
 * 한 번 연 파일은 마운트 유지(재연결 방지).
 */

type FileType = 'folder' | 'code' | 'doc' | 'sheet' | 'slide' | 'canvas';

interface CollabFile {
  id: number;
  parent_id: number | null;
  name: string;
  type: FileType;
  room: string | null;
  author: string;
}

const TYPE_LABEL: Record<Exclude<FileType, 'folder'>, string> = {
  code: '코드',
  doc: '문서',
  sheet: '시트',
  slide: '발표',
  canvas: '캔버스',
};

function TypeIcon({ type, size = 15 }: { type: FileType; size?: number }) {
  if (type === 'folder') return <FolderIcon size={size} />;
  if (type === 'code') return <CodeIcon size={size} />;
  if (type === 'doc') return <DocIcon size={size} />;
  if (type === 'sheet') return <SheetIcon size={size} />;
  if (type === 'canvas') return <PenIcon size={size} />;
  return <SlideIcon size={size} />;
}

export default function CollabFiles({ code, isHost }: { code: string; isHost: boolean }) {
  const user = useAuthStore((s) => s.user);
  const [files, setFiles] = useState<CollabFile[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [openedIds, setOpenedIds] = useState<number[]>([]); // 마운트 유지용
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  // 생성 플로우: 타입 선택 → 이름 입력
  const [creating, setCreating] = useState<{ parentId: number | null; type: FileType } | null>(null);
  const [typeMenuFor, setTypeMenuFor] = useState<number | null | 'root'>(null); // 'root' | folderId
  const [nameInput, setNameInput] = useState('');
  const [renamingId, setRenamingId] = useState<number | null>(null);

  const load = useCallback(() => {
    void api<CollabFile[]>(`/api/meetings/${code}/files`)
      .then(setFiles)
      .catch(() => {});
  }, [code]);

  useEffect(load, [load]);

  const byParent = useMemo(() => {
    const map = new Map<number | null, CollabFile[]>();
    for (const f of files) {
      const key = f.parent_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return map;
  }, [files]);

  const active = files.find((f) => f.id === activeId) ?? null;
  const openedFiles = openedIds
    .map((id) => files.find((f) => f.id === id))
    .filter((f): f is CollabFile => !!f && f.type !== 'folder' && !!f.room);

  function openFile(f: CollabFile) {
    if (f.type === 'folder') {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(f.id)) next.delete(f.id);
        else next.add(f.id);
        return next;
      });
      return;
    }
    setActiveId(f.id);
    setOpenedIds((prev) => (prev.includes(f.id) ? prev : [...prev, f.id]));
  }

  async function createEntry(e: React.FormEvent) {
    e.preventDefault();
    if (!creating) return;
    const name = nameInput.trim();
    if (!name) return;
    try {
      const f = await api<CollabFile>(`/api/meetings/${code}/files`, {
        method: 'POST',
        body: { name, type: creating.type, parent_id: creating.parentId },
      });
      setFiles((prev) => [...prev, { ...f, author: user?.username ?? '' }]);
      setCreating(null);
      setNameInput('');
      if (f.type !== 'folder') openFile({ ...f, author: user?.username ?? '' });
    } catch {
      /* 전역 토스트 */
    }
  }

  async function renameEntry(f: CollabFile, e: React.FormEvent) {
    e.preventDefault();
    const name = nameInput.trim();
    setRenamingId(null);
    if (!name || name === f.name) return;
    try {
      await api(`/api/meetings/${code}/files/${f.id}`, { method: 'PATCH', body: { name } });
      setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, name } : x)));
    } catch {
      /* 전역 토스트 */
    }
  }

  async function deleteEntry(f: CollabFile) {
    const isFolder = f.type === 'folder';
    if (!confirm(isFolder ? `"${f.name}" 폴더와 안의 파일을 모두 삭제할까요?` : `"${f.name}" 파일을 삭제할까요?`))
      return;
    try {
      await api(`/api/meetings/${code}/files/${f.id}`, { method: 'DELETE' });
      load();
      if (activeId === f.id) setActiveId(null);
      setOpenedIds((prev) => prev.filter((id) => id !== f.id));
    } catch {
      /* 전역 토스트 */
    }
  }

  const canEdit = (f: CollabFile) => isHost || f.author === user?.username;

  function TypeMenu({ parentId }: { parentId: number | null }) {
    return (
      <div className="cf-type-menu">
        {(['folder', 'code', 'doc', 'sheet', 'slide', 'canvas'] as FileType[]).map((t) => (
          <button
            key={t}
            onClick={() => {
              setCreating({ parentId, type: t });
              setTypeMenuFor(null);
              setNameInput('');
            }}
          >
            <TypeIcon type={t} size={14} /> {t === 'folder' ? '폴더' : TYPE_LABEL[t]}
          </button>
        ))}
      </div>
    );
  }

  function renderTree(parentId: number | null, depth: number) {
    const children = byParent.get(parentId) ?? [];
    return (
      <>
        {children.map((f) => (
          <div key={f.id}>
            <div
              className={`cf-item${f.id === activeId ? ' active' : ''}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => openFile(f)}
            >
              {f.type === 'folder' && (
                <span className={`cf-chevron${collapsed.has(f.id) ? '' : ' open'}`}>
                  <ChevronIcon size={11} />
                </span>
              )}
              <span className={`cf-icon ${f.type}`}>
                <TypeIcon type={f.type} />
              </span>
              {renamingId === f.id ? (
                <form onSubmit={(e) => renameEntry(f, e)} onClick={(e) => e.stopPropagation()}>
                  <input
                    className="cf-name-input"
                    autoFocus
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onBlur={() => setRenamingId(null)}
                    maxLength={60}
                  />
                </form>
              ) : (
                <Marquee className="cf-name">{f.name}</Marquee>
              )}
              <span className="cf-actions" onClick={(e) => e.stopPropagation()}>
                {f.type === 'folder' && (
                  <button title="안에 만들기" onClick={() => setTypeMenuFor(f.id)}>
                    ＋
                  </button>
                )}
                {canEdit(f) && (
                  <>
                    <button
                      title="이름 변경"
                      onClick={() => {
                        setRenamingId(f.id);
                        setNameInput(f.name);
                      }}
                    >
                      ✎
                    </button>
                    <button title="삭제" className="danger" onClick={() => void deleteEntry(f)}>
                      ×
                    </button>
                  </>
                )}
              </span>
            </div>
            {typeMenuFor === f.id && <TypeMenu parentId={f.id} />}
            {creating?.parentId === f.id && (
              <form
                className="cf-new"
                style={{ paddingLeft: 10 + (depth + 1) * 14 }}
                onSubmit={createEntry}
              >
                <span className={`cf-icon ${creating.type}`}>
                  <TypeIcon type={creating.type} />
                </span>
                <input
                  className="cf-name-input"
                  autoFocus
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onBlur={() => {
                    if (!nameInput.trim()) setCreating(null);
                  }}
                  placeholder="이름"
                  maxLength={60}
                />
              </form>
            )}
            {f.type === 'folder' && !collapsed.has(f.id) && renderTree(f.id, depth + 1)}
          </div>
        ))}
      </>
    );
  }

  return (
    <div className={`cf-wrap${active ? ' editing' : ''}`}>
      {/* 탐색기 — 파일을 열기 전엔 전체 화면, 열면 숨김 */}
      <aside className="cf-side" style={{ display: active ? 'none' : undefined }}>
        <div className="cf-head">
          <span>파일</span>
          <button className="cf-add" title="새 파일/폴더" onClick={() => setTypeMenuFor('root')}>
            <PlusIcon size={14} />
          </button>
        </div>
        {typeMenuFor === 'root' && <TypeMenu parentId={null} />}
        <div className="cf-tree">
          {creating?.parentId === null && (
            <form className="cf-new" style={{ paddingLeft: 10 }} onSubmit={createEntry}>
              <span className={`cf-icon ${creating.type}`}>
                <TypeIcon type={creating.type} />
              </span>
              <input
                className="cf-name-input"
                autoFocus
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onBlur={() => {
                  if (!nameInput.trim()) setCreating(null);
                }}
                placeholder="이름"
                maxLength={60}
              />
            </form>
          )}
          {files.length === 0 && !creating ? (
            <div className="cf-empty">
              아직 파일이 없어요.
              <br />＋ 로 코드·문서·시트·발표·캔버스 파일을 만들어보세요.
            </div>
          ) : (
            renderTree(null, 0)
          )}
        </div>
      </aside>

      {/* 에디터 — 파일을 열면 전체 화면, ← 로 탐색기 복귀 */}
      <div className="cf-editor" style={{ display: active ? undefined : 'none' }}>
        {active && (
          <div className="cf-editor-bar">
            <button className="cf-back" onClick={() => setActiveId(null)}>
              <ChevronIcon size={13} /> 파일 목록
            </button>
            <span className={`cf-icon ${active.type}`}>
              <TypeIcon type={active.type} />
            </span>
            <Marquee className="cf-editor-name">{active.name}</Marquee>
          </div>
        )}
        {openedFiles.map((f) => (
          <div
            key={f.id}
            className="cf-editor-host"
            style={{ display: f.id === activeId ? 'flex' : 'none' }}
          >
            {f.type === 'code' && <CodeDocEditor roomId={f.room!} />}
            {f.type === 'doc' && <DocEditor roomId={f.room!} />}
            {f.type === 'sheet' && <SheetEditor roomId={f.room!} />}
            {f.type === 'slide' && <SlideEditor roomId={f.room!} />}
            {f.type === 'canvas' && <CanvasBoard roomId={f.room!} />}
          </div>
        ))}
      </div>
    </div>
  );
}
