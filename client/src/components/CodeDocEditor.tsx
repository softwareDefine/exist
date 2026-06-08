import { useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { useAuthStore } from '../store';
import {
  PlusIcon,
  CloseIcon,
  CodeIcon,
  PlayIcon,
  DownloadIcon,
  SunIcon,
  MoonIcon,
} from './Icons';

const CURSOR_COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];

type OutLine = { type: 'log' | 'error' | 'warn' | 'info'; text: string };

// Pyodide (브라우저 Python) 지연 로드 — 한 번만
let pyodidePromise: Promise<unknown> | null = null;
function loadPyodide(): Promise<unknown> {
  if (pyodidePromise) return pyodidePromise;
  pyodidePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
    s.onload = async () => {
      try {
        const py = await (window as unknown as { loadPyodide: () => Promise<unknown> }).loadPyodide();
        resolve(py);
      } catch (e) {
        reject(e);
      }
    };
    s.onerror = () => reject(new Error('Pyodide 로드 실패 (인터넷 연결 필요)'));
    document.head.appendChild(s);
  });
  return pyodidePromise;
}

function runtimeForExt(ext: string): 'js' | 'py' | null {
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'js';
  if (ext === 'py') return 'py';
  return null;
}

interface FileMeta {
  id: string;
  name: string;
  ord: number;
}

function langForName(name: string): { ext: Extension; label: string } {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'py') return { ext: python(), label: 'Python' };
  if (['c', 'cc', 'cpp', 'cxx', 'h', 'hpp'].includes(ext)) return { ext: cpp(), label: 'C/C++' };
  if (['ts', 'tsx'].includes(ext))
    return { ext: javascript({ typescript: true, jsx: ext === 'tsx' }), label: 'TypeScript' };
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext))
    return { ext: javascript({ jsx: ext.includes('x') }), label: 'JavaScript' };
  if (ext === 'json') return { ext: javascript(), label: 'JSON' };
  return { ext: [], label: '일반 텍스트' };
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'py') return '🐍';
  if (['ts', 'tsx'].includes(ext)) return '🇹';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return '🟨';
  if (['c', 'cc', 'cpp', 'cxx', 'h', 'hpp'].includes(ext)) return '🔵';
  if (ext === 'json') return '⚙️';
  if (ext === 'md') return '📝';
  return '📄';
}

/** VS Code식 코드 공동편집 — 파일 탐색기 + 멀티파일 탭, Yjs 실시간 */
export default function CodeDocEditor({ roomId }: { roomId: string }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const filesMapRef = useRef<Y.Map<{ name: string; ord: number }> | null>(null);

  const [conn, setConn] = useState<{ ydoc: Y.Doc; provider: WebsocketProvider } | null>(null);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [peers, setPeers] = useState(1);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const creatingRef = useRef(false); // Enter/blur 중복 생성 방지
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('exist:code-theme') as 'dark' | 'light') || 'dark',
  );
  const [output, setOutput] = useState<OutLine[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const [running, setRunning] = useState(false);

  // ── 연결 + 파일 목록 ──
  useEffect(() => {
    const ydoc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, ydoc, {
      params: { token: token ?? '' },
    });
    const filesMap = ydoc.getMap<{ name: string; ord: number }>('files');
    filesMapRef.current = filesMap;
    setConn({ ydoc, provider });
    setStatus(provider.wsconnected ? 'connected' : 'connecting');

    const color = CURSOR_COLORS[(user?.id ?? 0) % CURSOR_COLORS.length];
    provider.awareness.setLocalStateField('user', {
      name: user?.username ?? '익명',
      color,
      colorLight: color + '33',
    });

    const syncFiles = () => {
      const list: FileMeta[] = [];
      filesMap.forEach((v, id) => list.push({ id, name: v.name, ord: v.ord }));
      list.sort((a, b) => a.ord - b.ord);
      setFiles(list);
      setActiveId((cur) => cur ?? list[0]?.id ?? null);
      setOpenTabs((tabs) => {
        const valid = tabs.filter((t) => list.some((f) => f.id === t));
        if (valid.length === 0 && list[0]) return [list[0].id];
        return valid;
      });
    };
    filesMap.observe(syncFiles);
    syncFiles();

    // 빈 프로젝트면 기본 파일 생성 (동기화 후, 한 번만)
    const ensureDefault = () => {
      if (filesMap.size === 0) {
        filesMap.set(crypto.randomUUID(), { name: 'main.js', ord: 1 });
      }
    };
    provider.on('sync', (isSynced: boolean) => {
      if (isSynced) ensureDefault();
    });

    const onStatus = (e: { status: 'connecting' | 'connected' | 'disconnected' }) =>
      setStatus(e.status);
    provider.on('status', onStatus);
    const onAwareness = () => setPeers(provider.awareness.getStates().size || 1);
    provider.awareness.on('change', onAwareness);

    return () => {
      filesMap.unobserve(syncFiles);
      provider.off('status', onStatus);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      filesMapRef.current = null;
      setConn(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  const activeFile = files.find((f) => f.id === activeId) ?? null;

  // ── 에디터 (활성 파일 바뀔 때 재생성) ──
  useEffect(() => {
    if (!conn || !activeId || !hostRef.current || !activeFile) return;
    const ytext = conn.ydoc.getText(`file:${activeId}`);
    const { ext } = langForName(activeFile.name);

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        ext,
        ...(theme === 'dark' ? [oneDark] : []),
        yCollab(ytext, conn.provider.awareness),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            setCursor({ line: line.number, col: head - line.from + 1 });
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13.5px' },
          '.cm-scroller': {
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, 'NanumSquareNeo', 'Malgun Gothic', monospace",
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, activeId, activeFile?.name, theme]);

  function toggleTheme() {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      localStorage.setItem('exist:code-theme', next);
      return next;
    });
  }

  function downloadActive() {
    if (!activeFile || !conn) return;
    const text = conn.ydoc.getText(`file:${activeId}`).toString();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeFile.name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function runActive() {
    if (!activeFile || !conn || running) return;
    const code = conn.ydoc.getText(`file:${activeId}`).toString();
    const ext = activeFile.name.split('.').pop()?.toLowerCase() ?? '';
    const rt = runtimeForExt(ext);
    setShowOutput(true);
    if (rt === 'js') runJS(code);
    else if (rt === 'py') runPython(code);
    else {
      setOutput([
        { type: 'error', text: `.${ext} 파일은 브라우저 실행을 지원하지 않아요 (JS·Python만 가능)` },
      ]);
    }
  }

  function runJS(code: string) {
    setRunning(true);
    setOutput([{ type: 'info', text: '▶ JavaScript 실행 중…' }]);
    const workerSrc = `
      self.onmessage = (e) => {
        const fmt = (a) => { try { return (typeof a === 'object' && a !== null) ? JSON.stringify(a) : String(a); } catch { return String(a); } };
        const send = (type) => (...args) => self.postMessage({ line: { type, text: args.map(fmt).join(' ') } });
        const console = { log: send('log'), info: send('log'), debug: send('log'), warn: send('warn'), error: send('error') };
        try {
          const fn = new Function('console', e.data);
          const r = fn(console);
          if (r !== undefined) self.postMessage({ line: { type: 'log', text: fmt(r) } });
          self.postMessage({ done: true });
        } catch (err) {
          self.postMessage({ line: { type: 'error', text: (err && err.stack) ? String(err.stack) : String(err) } });
          self.postMessage({ done: true });
        }
      };`;
    const url = URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' }));
    const worker = new Worker(url);
    const lines: OutLine[] = [];
    const finish = (extra?: OutLine) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      setRunning(false);
      setOutput(extra ? [...lines, extra] : [...lines]);
    };
    const timer = setTimeout(
      () => finish({ type: 'error', text: '⏱ 시간 초과(3초) — 실행을 중단했어요' }),
      3000,
    );
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data as { line?: OutLine; done?: boolean };
      if (d.line) {
        lines.push(d.line);
        setOutput([...lines]);
      }
      if (d.done) {
        clearTimeout(timer);
        finish({ type: 'info', text: '✓ 완료' });
      }
    };
    worker.postMessage(code);
  }

  async function runPython(code: string) {
    setRunning(true);
    setOutput([{ type: 'info', text: '🐍 Python 준비 중… (처음 실행은 몇 초 걸려요)' }]);
    try {
      const py = (await loadPyodide()) as {
        setStdout: (o: { batched: (s: string) => void }) => void;
        setStderr: (o: { batched: (s: string) => void }) => void;
        runPythonAsync: (c: string) => Promise<unknown>;
      };
      const lines: OutLine[] = [{ type: 'info', text: '▶ Python 실행 중…' }];
      setOutput([...lines]);
      py.setStdout({
        batched: (s: string) => {
          lines.push({ type: 'log', text: s });
          setOutput([...lines]);
        },
      });
      py.setStderr({
        batched: (s: string) => {
          lines.push({ type: 'error', text: s });
          setOutput([...lines]);
        },
      });
      await py.runPythonAsync(code);
      lines.push({ type: 'info', text: '✓ 완료' });
      setOutput([...lines]);
    } catch (e) {
      setOutput((l) => [...l, { type: 'error', text: String((e as Error)?.message ?? e) }]);
    } finally {
      setRunning(false);
    }
  }

  function openFile(id: string) {
    setActiveId(id);
    setOpenTabs((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]));
  }
  function closeTab(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setOpenTabs((tabs) => {
      const next = tabs.filter((t) => t !== id);
      if (id === activeId) setActiveId(next[next.length - 1] ?? null);
      return next;
    });
  }
  function createFile() {
    const map = filesMapRef.current;
    const name = draftName.trim();
    setCreating(false);
    setDraftName('');
    if (!map || !name || !creatingRef.current) return;
    creatingRef.current = false; // 두 번째 호출(blur) 무시
    const ord = files.reduce((m, f) => Math.max(m, f.ord), 0) + 1;
    const id = crypto.randomUUID();
    map.set(id, { name, ord });
    openFile(id);
  }
  function startCreating() {
    creatingRef.current = true;
    setCreating(true);
    setDraftName('');
  }
  function deleteFile(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const map = filesMapRef.current;
    if (!map) return;
    if (!confirm('이 파일을 삭제할까요? (실시간 공유 파일)')) return;
    map.delete(id);
    conn?.ydoc.getText(`file:${id}`).delete(0, conn.ydoc.getText(`file:${id}`).length);
    setOpenTabs((tabs) => tabs.filter((t) => t !== id));
    if (id === activeId) {
      const remaining = files.filter((f) => f.id !== id);
      setActiveId(remaining[0]?.id ?? null);
    }
  }

  const statusLabel =
    status === 'connected' ? '연결됨' : status === 'connecting' ? '연결 중…' : '연결 끊김';
  const langLabel = activeFile ? langForName(activeFile.name).label : '';

  const canRun = !!activeFile && runtimeForExt(activeFile.name.split('.').pop()?.toLowerCase() ?? '') !== null;

  return (
    <div className={`vsc ${theme}`}>
      {/* 파일 탐색기 */}
      <div className="vsc-sidebar">
        <div className="vsc-sidebar-head">
          <span>탐색기</span>
          <button className="vsc-newfile" title="새 파일" onClick={startCreating}>
            <PlusIcon size={15} />
          </button>
        </div>
        <div className="vsc-files">
          {files.map((f) => (
            <div
              key={f.id}
              className={`vsc-file${f.id === activeId ? ' active' : ''}`}
              onClick={() => openFile(f.id)}
              title={f.name}
            >
              <span className="vsc-file-ic">{fileIcon(f.name)}</span>
              <span className="vsc-file-name">{f.name}</span>
              <button className="vsc-file-del" title="삭제" onClick={(e) => deleteFile(f.id, e)}>
                <CloseIcon size={11} />
              </button>
            </div>
          ))}
          {creating && (
            <div className="vsc-file creating">
              <span className="vsc-file-ic">📄</span>
              <input
                className="vsc-file-input"
                autoFocus
                placeholder="파일명.js"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={createFile}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createFile();
                  else if (e.key === 'Escape') {
                    creatingRef.current = false;
                    setCreating(false);
                    setDraftName('');
                  }
                }}
              />
            </div>
          )}
          {files.length === 0 && !creating && (
            <div className="vsc-empty">+ 로 파일을 만들어보세요</div>
          )}
        </div>
      </div>

      {/* 에디터 영역 */}
      <div className="vsc-main">
        <div className="vsc-tabbar">
          <div className="vsc-tabs">
            {openTabs.map((id) => {
              const f = files.find((x) => x.id === id);
              if (!f) return null;
              return (
                <div
                  key={id}
                  className={`vsc-tab${id === activeId ? ' active' : ''}`}
                  onClick={() => setActiveId(id)}
                >
                  <span className="vsc-tab-ic">{fileIcon(f.name)}</span>
                  {f.name}
                  <button className="vsc-tab-close" onClick={(e) => closeTab(id, e)}>
                    <CloseIcon size={10} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="vsc-actions">
            <button
              className="vsc-run"
              onClick={runActive}
              disabled={!canRun || running}
              title={canRun ? '실행 (JS·Python)' : '실행 미지원 파일'}
            >
              <PlayIcon size={13} /> {running ? '실행 중…' : '실행'}
            </button>
            <button
              className="vsc-act"
              onClick={downloadActive}
              disabled={!activeFile}
              title="현재 파일 다운로드"
            >
              <DownloadIcon size={16} />
            </button>
            <button className="vsc-act" onClick={toggleTheme} title="테마 전환">
              {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={15} />}
            </button>
          </div>
        </div>
        {activeFile ? (
          <div className="vsc-editor" ref={hostRef} />
        ) : (
          <div className="vsc-welcome">
            <CodeIcon size={40} />
            <p>왼쪽에서 파일을 선택하거나 새로 만들어 시작하세요</p>
          </div>
        )}
        {showOutput && (
          <div className="vsc-output">
            <div className="vsc-output-head">
              <span>출력</span>
              <div className="vsc-output-tools">
                <button onClick={() => setOutput([])} title="지우기">
                  지우기
                </button>
                <button onClick={() => setShowOutput(false)} title="닫기">
                  <CloseIcon size={12} />
                </button>
              </div>
            </div>
            <div className="vsc-output-body">
              {output.length === 0 ? (
                <div className="vsc-out-line info">실행 결과가 여기 표시돼요</div>
              ) : (
                output.map((o, i) => (
                  <div key={i} className={`vsc-out-line ${o.type}`}>
                    {o.text}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        <div className="vsc-statusbar">
          <div className="vsc-status-left">
            <span className={`vsc-conn ${status}`}>
              <i /> {statusLabel}
            </span>
            <span>{peers}명 참여</span>
          </div>
          <div className="vsc-status-right">
            {activeFile && (
              <>
                <span>
                  줄 {cursor.line}, 열 {cursor.col}
                </span>
                <span>공백: 2</span>
                <span>UTF-8</span>
                <span>{langLabel}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
