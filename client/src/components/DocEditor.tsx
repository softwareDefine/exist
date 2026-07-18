import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '../store';
import Marquee from './Marquee';
import { PlusIcon, CloseIcon, DownloadIcon } from './Icons';

const CARET_COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];

interface DocMeta {
  id: string;
  name: string;
  ord: number;
}

/** Yjs 기반 리치텍스트 공동편집 — 여러 문서(탭), roomId 단위 공유 */
export default function DocEditor({ roomId }: { roomId: string }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [peers, setPeers] = useState(1);
  const [conn, setConn] = useState<{ ydoc: Y.Doc; provider: WebsocketProvider } | null>(null);
  const docsMapRef = useRef<Y.Map<{ name: string; ord: number }> | null>(null);
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [showExport, setShowExport] = useState(false);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, ydoc, {
      params: { token: token ?? '' },
    });
    const docsMap = ydoc.getMap<{ name: string; ord: number }>('docs');
    docsMapRef.current = docsMap;
    setConn({ ydoc, provider });
    setStatus(provider.wsconnected ? 'connected' : 'connecting');

    const syncDocs = () => {
      const list: DocMeta[] = [];
      docsMap.forEach((v, id) => list.push({ id, name: v.name, ord: v.ord }));
      list.sort((a, b) => a.ord - b.ord);
      setDocs(list);
      setActiveId((cur) => cur ?? list[0]?.id ?? null);
    };
    docsMap.observe(syncDocs);
    syncDocs();

    provider.on('sync', (isSynced: boolean) => {
      if (isSynced && docsMap.size === 0) {
        docsMap.set(crypto.randomUUID(), { name: '문서 1', ord: 1 });
      }
    });

    const onStatus = (e: { status: 'connecting' | 'connected' | 'disconnected' }) =>
      setStatus(e.status);
    provider.on('status', onStatus);
    const onAwareness = () => setPeers(provider.awareness.getStates().size || 1);
    provider.awareness.on('change', onAwareness);
    return () => {
      docsMap.unobserve(syncDocs);
      provider.off('status', onStatus);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      docsMapRef.current = null;
      setConn(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  const color = CARET_COLORS[(user?.id ?? 0) % CARET_COLORS.length];
  const activeDoc = docs.find((d) => d.id === activeId) ?? null;

  const editor = useEditor(
    {
      extensions:
        conn && activeId
          ? [
              StarterKit.configure({ undoRedo: false }),
              Collaboration.configure({ document: conn.ydoc, field: `doc:${activeId}` }),
              CollaborationCaret.configure({
                provider: conn.provider,
                user: { name: user?.username ?? '익명', color },
              }),
            ]
          : [StarterKit],
      editorProps: {
        attributes: { class: 'doc-prose' },
      },
    },
    [conn, activeId],
  );

  function newDoc() {
    const map = docsMapRef.current;
    if (!map) return;
    const ord = docs.reduce((m, d) => Math.max(m, d.ord), 0) + 1;
    const id = crypto.randomUUID();
    map.set(id, { name: `문서 ${ord}`, ord });
    setActiveId(id);
  }
  function deleteDoc(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const map = docsMapRef.current;
    if (!map) return;
    if (docs.length <= 1) return; // 최소 1개 유지
    if (!confirm('이 문서를 삭제할까요? (실시간 공유)')) return;
    map.delete(id);
    if (id === activeId) setActiveId(docs.find((d) => d.id !== id)?.id ?? null);
  }
  function commitRename() {
    const map = docsMapRef.current;
    if (renaming && map) {
      const name = renaming.name.trim();
      const cur = map.get(renaming.id);
      if (name && cur) map.set(renaming.id, { ...cur, name });
    }
    setRenaming(null);
  }

  function exportAs(kind: 'html' | 'txt') {
    if (!editor || !activeDoc) return;
    const name = activeDoc.name;
    let content: string;
    let mime: string;
    let ext: string;
    if (kind === 'html') {
      content = `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body>${editor.getHTML()}</body></html>`;
      mime = 'text/html;charset=utf-8';
      ext = 'html';
    } else {
      content = editor.getText();
      mime = 'text/plain;charset=utf-8';
      ext = 'txt';
    }
    const url = URL.createObjectURL(new Blob(['﻿' + content], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    setShowExport(false);
  }

  const statusLabel =
    status === 'connected' ? '실시간 연결됨' : status === 'connecting' ? '연결 중…' : '연결 끊김';
  const btn = (active: boolean) => `doc-tool${active ? ' on' : ''}`;

  return (
    <div className="doc-editor">
      {/* 문서 탭 바 */}
      <div className="doc-tabbar">
        <div className="doc-tabs">
          {docs.map((d) => (
            <div
              key={d.id}
              className={`doc-tab${d.id === activeId ? ' active' : ''}`}
              onClick={() => setActiveId(d.id)}
              onDoubleClick={() => setRenaming({ id: d.id, name: d.name })}
              title="더블클릭하면 이름 변경"
            >
              {renaming?.id === d.id ? (
                <input
                  className="doc-tab-input"
                  autoFocus
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    else if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <Marquee className="doc-tab-name">{d.name}</Marquee>
              )}
              {docs.length > 1 && (
                <button className="doc-tab-close" onClick={(e) => deleteDoc(d.id, e)}>
                  <CloseIcon size={10} />
                </button>
              )}
            </div>
          ))}
          <button className="doc-newtab" title="새 문서" onClick={newDoc}>
            <PlusIcon size={14} />
          </button>
        </div>
        <div className="doc-tabbar-right">
          <div className="doc-export-wrap">
            <button className="doc-export" onClick={() => setShowExport((v) => !v)}>
              <DownloadIcon size={14} /> 내보내기
            </button>
            {showExport && (
              <>
                <div className="doc-export-back" onClick={() => setShowExport(false)} />
                <div className="doc-export-menu">
                  <button onClick={() => exportAs('html')}>HTML (.html)</button>
                  <button onClick={() => exportAs('txt')}>텍스트 (.txt)</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="doc-editor-bar">
        <div className="doc-tools">
          <button
            className={btn(!!editor?.isActive('bold'))}
            onClick={() => editor?.chain().focus().toggleBold().run()}
            title="굵게"
          >
            <b>B</b>
          </button>
          <button
            className={btn(!!editor?.isActive('italic'))}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
            title="기울임"
          >
            <i>I</i>
          </button>
          <button
            className={btn(!!editor?.isActive('strike'))}
            onClick={() => editor?.chain().focus().toggleStrike().run()}
            title="취소선"
          >
            <s>S</s>
          </button>
          <span className="doc-tool-sep" />
          <button
            className={btn(!!editor?.isActive('heading', { level: 1 }))}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
            title="제목 1"
          >
            H1
          </button>
          <button
            className={btn(!!editor?.isActive('heading', { level: 2 }))}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            title="제목 2"
          >
            H2
          </button>
          <span className="doc-tool-sep" />
          <button
            className={btn(!!editor?.isActive('bulletList'))}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
            title="글머리 목록"
          >
            • 목록
          </button>
          <button
            className={btn(!!editor?.isActive('orderedList'))}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            title="번호 목록"
          >
            1. 목록
          </button>
          <button
            className={btn(!!editor?.isActive('blockquote'))}
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
            title="인용"
          >
            ❝
          </button>
          <button
            className={btn(!!editor?.isActive('codeBlock'))}
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
            title="코드 블록"
          >
            {'</>'}
          </button>
        </div>
        <div className="doc-editor-right">
          <span className="code-doc-peers">{peers}명 참여</span>
          <span className={`code-doc-status ${status}`}>
            <i /> {statusLabel}
          </span>
        </div>
      </div>
      <div className="doc-editor-scroll">
        <div className="doc-page">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
