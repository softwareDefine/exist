import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 * 데스크톱: 윈도우 파일탐색기식 — 내비게이션 바(뒤로/앞으로/상위/새로고침/경로/검색) +
 *           툴바(새로 만들기·잘라내기·복사·붙여넣기·이름 바꾸기·공유·삭제·정렬·보기·실행 취소).
 * 모바일: 기존 트리 UI 유지 (7/18 확정 모바일 UX).
 * 파일을 열면 에디터 전체 화면, ← 로 복귀. 한 번 연 파일은 마운트 유지(재연결 방지).
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

type SortKey = 'name' | 'type' | 'author';
type ViewMode = 'grid' | 'list';

/** 실행 취소 스택 항목 — 역연산 클로저 (삭제는 복구 불가라 스택에 안 쌓음) */
interface UndoOp {
  label: string;
  undo: () => Promise<void>;
}

function toast(message: string) {
  window.dispatchEvent(new CustomEvent('app:error', { detail: message }));
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

  // ── 탐색기(데스크톱) 상태 ──
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [cwd, setCwd] = useState<number | null>(null); // 현재 폴더 (null=루트)
  const backStack = useRef<(number | null)[]>([]);
  const fwdStack = useRef<(number | null)[]>([]);
  const [, forceNav] = useState(0); // 스택 변경 시 버튼 활성화 갱신용
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [clipboard, setClipboard] = useState<{ op: 'cut' | 'copy'; id: number } | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortMenu, setSortMenu] = useState(false);
  const [view, setView] = useState<ViewMode>(
    () => (localStorage.getItem('exist:cf-view') as ViewMode) || 'grid',
  );
  const undoStack = useRef<UndoOp[]>([]);
  const [, forceUndo] = useState(0);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const load = useCallback(() => {
    void api<CollabFile[]>(`/api/meetings/${code}/files`)
      .then(setFiles)
      .catch(() => {});
  }, [code]);

  useEffect(load, [load]);

  const byId = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
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

  const canEdit = (f: CollabFile) => isHost || f.author === user?.username;

  function pushUndo(op: UndoOp) {
    undoStack.current.push(op);
    if (undoStack.current.length > 20) undoStack.current.shift();
    forceUndo((n) => n + 1);
  }

  // ── 내비게이션 ──
  function navigate(to: number | null) {
    if (to === cwd) return;
    backStack.current.push(cwd);
    fwdStack.current = [];
    setCwd(to);
    setSelectedId(null);
    setSearch('');
    forceNav((n) => n + 1);
  }

  function goBack() {
    if (backStack.current.length === 0) return;
    fwdStack.current.push(cwd);
    setCwd(backStack.current.pop()!);
    setSelectedId(null);
    forceNav((n) => n + 1);
  }

  function goForward() {
    if (fwdStack.current.length === 0) return;
    backStack.current.push(cwd);
    setCwd(fwdStack.current.pop()!);
    setSelectedId(null);
    forceNav((n) => n + 1);
  }

  function goUp() {
    if (cwd === null) return;
    navigate(byId.get(cwd)?.parent_id ?? null);
  }

  /** 경로(브레드크럼) — 루트부터 현재 폴더까지 */
  const crumbs = useMemo(() => {
    const list: CollabFile[] = [];
    let cur = cwd;
    while (cur != null) {
      const f = byId.get(cur);
      if (!f) break;
      list.unshift(f);
      cur = f.parent_id;
    }
    return list;
  }, [cwd, byId]);

  // ── 목록 (검색·정렬 반영) ──
  const items = useMemo(() => {
    let list: CollabFile[];
    if (search.trim()) {
      // 검색: 현재 폴더 하위 전체에서 이름 매칭
      const q = search.trim().toLowerCase();
      const inScope = new Set<number | null>([cwd]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of files) {
          if (f.type === 'folder' && inScope.has(f.parent_id) && !inScope.has(f.id)) {
            inScope.add(f.id);
            grew = true;
          }
        }
      }
      list = files.filter((f) => inScope.has(f.parent_id) && f.name.toLowerCase().includes(q));
    } else {
      list = byParent.get(cwd) ?? [];
    }
    const cmp: Record<SortKey, (a: CollabFile, b: CollabFile) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, 'ko'),
      type: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'ko'),
      author: (a, b) => a.author.localeCompare(b.author, 'ko') || a.name.localeCompare(b.name, 'ko'),
    };
    return [...list].sort((a, b) => {
      // 폴더 먼저 (윈도우식)
      if ((a.type === 'folder') !== (b.type === 'folder')) return a.type === 'folder' ? -1 : 1;
      return cmp[sortKey](a, b);
    });
  }, [files, byParent, cwd, search, sortKey]);

  const selected = selectedId != null ? byId.get(selectedId) ?? null : null;

  // ── 파일 열기 ──
  function openFile(f: CollabFile) {
    if (f.type === 'folder') {
      if (isMobile) {
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(f.id)) next.delete(f.id);
          else next.add(f.id);
          return next;
        });
      } else {
        navigate(f.id);
      }
      return;
    }
    setActiveId(f.id);
    setOpenedIds((prev) => (prev.includes(f.id) ? prev : [...prev, f.id]));
  }

  // ── 액션 ──
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
      pushUndo({
        label: `"${name}" 만들기`,
        undo: async () => {
          await api(`/api/meetings/${code}/files/${f.id}`, { method: 'DELETE' });
          load();
        },
      });
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
    const prevName = f.name;
    try {
      await api(`/api/meetings/${code}/files/${f.id}`, { method: 'PATCH', body: { name } });
      setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, name } : x)));
      pushUndo({
        label: `이름 바꾸기 (${prevName} → ${name})`,
        undo: async () => {
          await api(`/api/meetings/${code}/files/${f.id}`, { method: 'PATCH', body: { name: prevName } });
          load();
        },
      });
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
      if (selectedId === f.id) setSelectedId(null);
      if (clipboard?.id === f.id) setClipboard(null);
    } catch {
      /* 전역 토스트 */
    }
  }

  async function paste() {
    if (!clipboard) return;
    const src = byId.get(clipboard.id);
    if (!src) {
      setClipboard(null);
      return;
    }
    try {
      if (clipboard.op === 'cut') {
        if (src.parent_id === cwd) {
          setClipboard(null);
          return;
        }
        const from = src.parent_id;
        await api(`/api/meetings/${code}/files/${src.id}`, {
          method: 'PATCH',
          body: { parent_id: cwd },
        });
        pushUndo({
          label: `"${src.name}" 이동`,
          undo: async () => {
            await api(`/api/meetings/${code}/files/${src.id}`, {
              method: 'PATCH',
              body: { parent_id: from },
            });
            load();
          },
        });
        setClipboard(null);
      } else {
        const r = await api<{ id: number }>(`/api/meetings/${code}/files/${src.id}/copy`, {
          method: 'POST',
          body: { parent_id: cwd },
        });
        pushUndo({
          label: `"${src.name}" 복사`,
          undo: async () => {
            await api(`/api/meetings/${code}/files/${r.id}`, { method: 'DELETE' });
            load();
          },
        });
      }
      load();
    } catch {
      /* 전역 토스트 */
    }
  }

  async function undo() {
    const op = undoStack.current.pop();
    forceUndo((n) => n + 1);
    if (!op) return;
    try {
      await op.undo();
      toast(`실행 취소: ${op.label}`);
    } catch {
      toast('실행 취소에 실패했어요 (이미 바뀌었을 수 있어요)');
    }
  }

  function share(f: CollabFile) {
    const link = `${location.origin}/meeting/${code}`;
    void navigator.clipboard
      .writeText(`[exist] ${f.name} — ${link}`)
      .then(() => toast('그룹 링크를 복사했어요'))
      .catch(() => toast('클립보드 복사에 실패했어요'));
  }

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

  // ── 모바일 — 기존 트리 ──
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

  // ── 데스크톱 — 윈도우 탐색기 ──
  function renderExplorer() {
    const disabledSel = !selected;
    const cantTouch = !selected || !canEdit(selected);
    return (
      <div className="cf-explorer" style={{ display: active ? 'none' : undefined }}>
        {/* 1줄 — 내비게이션 바 */}
        <div className="cf-nav">
          <button title="뒤로" disabled={backStack.current.length === 0} onClick={goBack}>
            ←
          </button>
          <button title="앞으로" disabled={fwdStack.current.length === 0} onClick={goForward}>
            →
          </button>
          <button title="상위 폴더" disabled={cwd === null} onClick={goUp}>
            ↑
          </button>
          <button title="새로고침" onClick={load}>
            ⟳
          </button>
          <div className="cf-path">
            <button className="cf-crumb" onClick={() => navigate(null)}>
              <FolderIcon size={13} /> 공동편집
            </button>
            {crumbs.map((c) => (
              <span key={c.id} className="cf-crumb-seg">
                <ChevronIcon size={11} />
                <button className="cf-crumb" onClick={() => navigate(c.id)}>
                  {c.name}
                </button>
              </span>
            ))}
          </div>
          <input
            className="cf-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`${cwd === null ? '공동편집' : byId.get(cwd)?.name ?? ''} 검색`}
          />
        </div>

        {/* 2줄 — 툴바 */}
        <div className="cf-toolbar">
          <div className="cf-tool-wrap">
            <button className="cf-tool primary" onClick={() => setTypeMenuFor('root')}>
              <PlusIcon size={13} /> 새로 만들기
            </button>
            {typeMenuFor === 'root' && <TypeMenu parentId={cwd} />}
          </div>
          <span className="cf-tool-sep" />
          <button
            className="cf-tool"
            disabled={cantTouch}
            onClick={() => selected && setClipboard({ op: 'cut', id: selected.id })}
          >
            ✂ 잘라내기
          </button>
          <button
            className="cf-tool"
            disabled={disabledSel}
            onClick={() => selected && setClipboard({ op: 'copy', id: selected.id })}
          >
            ⧉ 복사
          </button>
          <button className="cf-tool" disabled={!clipboard} onClick={() => void paste()}>
            📋 붙여넣기
          </button>
          <button
            className="cf-tool"
            disabled={cantTouch}
            onClick={() => {
              if (!selected) return;
              setRenamingId(selected.id);
              setNameInput(selected.name);
            }}
          >
            ✎ 이름 바꾸기
          </button>
          <button className="cf-tool" disabled={disabledSel} onClick={() => selected && share(selected)}>
            ↗ 공유
          </button>
          <button
            className="cf-tool danger"
            disabled={cantTouch}
            onClick={() => selected && void deleteEntry(selected)}
          >
            🗑 휴지통
          </button>
          <span className="cf-tool-sep" />
          <div className="cf-tool-wrap">
            <button className="cf-tool" onClick={() => setSortMenu((v) => !v)}>
              ⇅ 정렬
            </button>
            {sortMenu && (
              <div className="cf-type-menu">
                {(
                  [
                    ['name', '이름'],
                    ['type', '종류'],
                    ['author', '만든 사람'],
                  ] as [SortKey, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => {
                      setSortKey(k);
                      setSortMenu(false);
                    }}
                  >
                    {sortKey === k ? '✓ ' : ''}
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="cf-tool"
            onClick={() => {
              const next: ViewMode = view === 'grid' ? 'list' : 'grid';
              setView(next);
              localStorage.setItem('exist:cf-view', next);
            }}
          >
            {view === 'grid' ? '☰ 목록 보기' : '▦ 아이콘 보기'}
          </button>
          <button
            className="cf-tool"
            disabled={undoStack.current.length === 0}
            onClick={() => void undo()}
            title={undoStack.current.at(-1)?.label ?? ''}
          >
            ↩ 실행 취소
          </button>
        </div>

        {/* 본문 — 현재 폴더 내용 */}
        <div className={`cf-main ${view}`} onClick={() => setSelectedId(null)}>
          {creating && (
            <form className="cf-new cf-main-new" onSubmit={createEntry} onClick={(e) => e.stopPropagation()}>
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
          {items.length === 0 && !creating ? (
            <div className="cf-empty">
              {search ? '검색 결과가 없어요' : '비어 있는 폴더예요 — 새로 만들기로 시작해보세요'}
            </div>
          ) : (
            items.map((f) => (
              <div
                key={f.id}
                className={`cf-entry${selectedId === f.id ? ' selected' : ''}${
                  clipboard?.op === 'cut' && clipboard.id === f.id ? ' cutting' : ''
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedId(f.id);
                }}
                onDoubleClick={() => openFile(f)}
                title={`${f.name} · ${f.type === 'folder' ? '폴더' : TYPE_LABEL[f.type]} · ${f.author}`}
              >
                <span className={`cf-entry-icon cf-icon ${f.type}`}>
                  <TypeIcon type={f.type} size={view === 'grid' ? 30 : 16} />
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
                  <span className="cf-entry-name">{f.name}</span>
                )}
                {view === 'list' && (
                  <>
                    <span className="cf-entry-type">
                      {f.type === 'folder' ? '폴더' : TYPE_LABEL[f.type]}
                    </span>
                    <span className="cf-entry-author">{f.author}</span>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`cf-wrap${active ? ' editing' : ''}`}>
      {isMobile ? (
        /* 모바일 — 기존 트리 탐색기 */
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
      ) : (
        renderExplorer()
      )}

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
