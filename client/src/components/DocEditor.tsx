import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '../store';
import Marquee from './Marquee';
import { PlusIcon, CloseIcon, DownloadIcon } from './Icons';

const CARET_COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];

const TEXT_COLORS = ['#1c2024', '#e5484d', '#f76808', '#f0b400', '#30a46c', '#4f7cff', '#8e4ec6', '#d6409f'];
const HL_COLORS = ['#fff59d', '#b9f6ca', '#b3e5fc', '#f8bbd0', '#ffe0b2', '#e1bee7'];
const FONT_SIZES = ['12px', '14px', '16px', '18px', '20px', '24px', '32px'];

interface DocMeta {
  id: string;
  name: string;
  ord: number;
}

type Menu = 'export' | 'size' | 'color' | 'hl' | 'table' | 'link' | 'find' | null;

function AlignSvg({ mode }: { mode: 'left' | 'center' | 'right' }) {
  const mid = mode === 'left' ? [1, 8.5] : mode === 'center' ? [3.2, 10.8] : [5.5, 13];
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="1" y1="3" x2="13" y2="3" />
      <line x1={mid[0]} y1="7" x2={mid[1]} y2="7" />
      <line x1="1" y1="11" x2="13" y2="11" />
    </svg>
  );
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
  const [menu, setMenu] = useState<Menu>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [findCount, setFindCount] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<Editor | null>(null);

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

  const baseExtensions = [
    StarterKit.configure({ undoRedo: false, link: { openOnClick: false, autolink: true } }),
    Image.configure({ allowBase64: true }),
    TableKit.configure({ table: { resizable: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TextStyle,
    Color,
    FontSize,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
  ];

  const editor = useEditor(
    {
      extensions:
        conn && activeId
          ? [
              ...baseExtensions,
              Collaboration.configure({ document: conn.ydoc, field: `doc:${activeId}` }),
              CollaborationCaret.configure({
                provider: conn.provider,
                user: { name: user?.username ?? '익명', color },
              }),
            ]
          : baseExtensions,
      editorProps: {
        attributes: { class: 'doc-prose' },
        handlePaste: (_view, event) => {
          const file = Array.from(event.clipboardData?.files ?? []).find((f) =>
            f.type.startsWith('image/'),
          );
          if (file) {
            insertImageFile(file);
            return true;
          }
          return false;
        },
        handleDrop: (_view, event) => {
          const file = Array.from(event.dataTransfer?.files ?? []).find((f) =>
            f.type.startsWith('image/'),
          );
          if (file) {
            event.preventDefault();
            insertImageFile(file);
            return true;
          }
          return false;
        },
      },
    },
    [conn, activeId],
  );
  editorRef.current = editor;

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
    setMenu(null);
  }

  /** 이미지 파일 → 리사이즈(최대 1400px) 후 data URL로 본문 삽입 (Yjs로 함께 공유됨) */
  function insertImageFile(file: File) {
    const objUrl = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      const MAX = 1400;
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w > MAX) {
        h = Math.round((h * MAX) / w);
        w = MAX;
      }
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      cv.getContext('2d')!.drawImage(img, 0, 0, w, h);
      const keepAlpha = file.type === 'image/png' || file.type === 'image/gif';
      const src = keepAlpha ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.85);
      editorRef.current?.chain().focus().setImage({ src }).run();
      URL.revokeObjectURL(objUrl);
    };
    img.src = objUrl;
  }

  function openLinkMenu() {
    if (!editor) return;
    setLinkUrl((editor.getAttributes('link').href as string | undefined) ?? '');
    setMenu(menu === 'link' ? null : 'link');
  }
  function applyLink() {
    if (!editor) return;
    const url = linkUrl.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    setMenu(null);
  }

  /** 대소문자 무시 전체 매치 위치 */
  function getMatches(term: string): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    if (!term || !editor) return out;
    const lower = term.toLowerCase();
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      const text = node.text.toLowerCase();
      let i = text.indexOf(lower);
      while (i !== -1) {
        out.push({ from: pos + i, to: pos + i + term.length });
        i = text.indexOf(lower, i + term.length);
      }
    });
    return out;
  }
  function findNext() {
    if (!editor) return;
    const ms = getMatches(findText);
    setFindCount(ms.length);
    if (!ms.length) return;
    const after = editor.state.selection.to;
    const m = ms.find((x) => x.from >= after) ?? ms[0];
    editor.chain().focus().setTextSelection({ from: m.from, to: m.to }).scrollIntoView().run();
  }
  function replaceOne() {
    if (!editor || !findText) return;
    const { from, to } = editor.state.selection;
    const sel = editor.state.doc.textBetween(from, to);
    if (sel.toLowerCase() === findText.toLowerCase()) {
      editor.chain().focus().insertContentAt({ from, to }, replaceText).run();
    }
    findNext();
  }
  function replaceAll() {
    if (!editor || !findText) return;
    const ms = getMatches(findText);
    if (!ms.length) {
      setFindCount(0);
      return;
    }
    let chain = editor.chain().focus();
    for (const m of [...ms].reverse()) {
      chain = chain.insertContentAt({ from: m.from, to: m.to }, replaceText);
    }
    chain.run();
    setFindCount(0);
  }

  const statusLabel =
    status === 'connected' ? '실시간 연결됨' : status === 'connecting' ? '연결 중…' : '연결 끊김';
  const btn = (active: boolean) => `doc-tool${active ? ' on' : ''}`;
  const curColor = (editor?.getAttributes('textStyle').color as string | undefined) ?? '#1c2024';
  const curSize = (editor?.getAttributes('textStyle').fontSize as string | undefined) ?? '';
  const inTable = !!editor?.isActive('table');

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
          <div className="doc-dd-wrap">
            <button className="doc-export" onClick={() => setMenu(menu === 'export' ? null : 'export')}>
              <DownloadIcon size={14} /> 내보내기
            </button>
            {menu === 'export' && (
              <>
                <div className="doc-dd-back" onClick={() => setMenu(null)} />
                <div className="doc-dd right">
                  <button className="item" onClick={() => exportAs('html')}>HTML (.html)</button>
                  <button className="item" onClick={() => exportAs('txt')}>텍스트 (.txt)</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="doc-editor-bar">
        <div className="doc-tools">
          {/* 글자 크기 */}
          <div className="doc-dd-wrap">
            <button
              className={btn(!!curSize)}
              title="글자 크기"
              onClick={() => setMenu(menu === 'size' ? null : 'size')}
            >
              {curSize ? curSize.replace('px', '') : '크기'}
            </button>
            {menu === 'size' && (
              <>
                <div className="doc-dd-back" onClick={() => setMenu(null)} />
                <div className="doc-dd">
                  <button
                    className="item"
                    onClick={() => {
                      editor?.chain().focus().unsetFontSize().run();
                      setMenu(null);
                    }}
                  >
                    기본
                  </button>
                  {FONT_SIZES.map((s) => (
                    <button
                      key={s}
                      className={`item${curSize === s ? ' on' : ''}`}
                      onClick={() => {
                        editor?.chain().focus().setFontSize(s).run();
                        setMenu(null);
                      }}
                    >
                      {s.replace('px', '')}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <span className="doc-tool-sep" />
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
            className={btn(!!editor?.isActive('underline'))}
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
            title="밑줄"
          >
            <u>U</u>
          </button>
          <button
            className={btn(!!editor?.isActive('strike'))}
            onClick={() => editor?.chain().focus().toggleStrike().run()}
            title="취소선"
          >
            <s>S</s>
          </button>
          {/* 글자색 */}
          <div className="doc-dd-wrap">
            <button
              className={btn(!!editor?.getAttributes('textStyle').color)}
              title="글자색"
              onClick={() => setMenu(menu === 'color' ? null : 'color')}
            >
              <span className="doc-colorA" style={{ ['--c' as string]: curColor }}>
                A
              </span>
            </button>
            {menu === 'color' && (
              <>
                <div className="doc-dd-back" onClick={() => setMenu(null)} />
                <div className="doc-dd sw">
                  <button
                    className="doc-sw none"
                    title="기본"
                    onClick={() => {
                      editor?.chain().focus().unsetColor().run();
                      setMenu(null);
                    }}
                  />
                  {TEXT_COLORS.map((c) => (
                    <button
                      key={c}
                      className="doc-sw"
                      style={{ background: c }}
                      onClick={() => {
                        editor?.chain().focus().setColor(c).run();
                        setMenu(null);
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
          {/* 형광펜 */}
          <div className="doc-dd-wrap">
            <button
              className={btn(!!editor?.isActive('highlight'))}
              title="형광펜"
              onClick={() => setMenu(menu === 'hl' ? null : 'hl')}
            >
              <span className="doc-hl-ico">가</span>
            </button>
            {menu === 'hl' && (
              <>
                <div className="doc-dd-back" onClick={() => setMenu(null)} />
                <div className="doc-dd sw">
                  <button
                    className="doc-sw none"
                    title="없음"
                    onClick={() => {
                      editor?.chain().focus().unsetHighlight().run();
                      setMenu(null);
                    }}
                  />
                  {HL_COLORS.map((c) => (
                    <button
                      key={c}
                      className="doc-sw"
                      style={{ background: c }}
                      onClick={() => {
                        editor?.chain().focus().setHighlight({ color: c }).run();
                        setMenu(null);
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
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
          {(['left', 'center', 'right'] as const).map((m) => (
            <button
              key={m}
              className={btn(!!editor?.isActive({ textAlign: m }))}
              onClick={() => editor?.chain().focus().setTextAlign(m).run()}
              title={m === 'left' ? '왼쪽 정렬' : m === 'center' ? '가운데 정렬' : '오른쪽 정렬'}
            >
              <AlignSvg mode={m} />
            </button>
          ))}
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
            className={btn(!!editor?.isActive('taskList'))}
            onClick={() => editor?.chain().focus().toggleTaskList().run()}
            title="체크리스트"
          >
            ☑ 체크
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
          <span className="doc-tool-sep" />
          {/* 링크 */}
          <div className="doc-dd-wrap">
            <button className={btn(!!editor?.isActive('link'))} title="링크" onClick={openLinkMenu}>
              링크
            </button>
            {menu === 'link' && (
              <>
                <div className="doc-dd-back" onClick={() => setMenu(null)} />
                <div className="doc-find">
                  <input
                    autoFocus
                    placeholder="https://…"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && applyLink()}
                  />
                  <div className="doc-find-btns">
                    <button className="doc-find-go" onClick={applyLink}>
                      적용
                    </button>
                    {!!editor?.isActive('link') && (
                      <button
                        onClick={() => {
                          editor?.chain().focus().extendMarkRange('link').unsetLink().run();
                          setMenu(null);
                        }}
                      >
                        링크 제거
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          {/* 이미지 */}
          <button className={btn(false)} title="이미지 삽입" onClick={() => fileInputRef.current?.click()}>
            이미지
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) insertImageFile(f);
              e.target.value = '';
            }}
          />
          {/* 표 */}
          <div className="doc-dd-wrap">
            <button
              className={btn(inTable)}
              title="표"
              onClick={() => setMenu(menu === 'table' ? null : 'table')}
            >
              표
            </button>
            {menu === 'table' && (
              <>
                <div className="doc-dd-back" onClick={() => setMenu(null)} />
                <div className="doc-dd">
                  {!inTable ? (
                    <button
                      className="item"
                      onClick={() => {
                        editor
                          ?.chain()
                          .focus()
                          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                          .run();
                        setMenu(null);
                      }}
                    >
                      3×3 표 삽입
                    </button>
                  ) : (
                    <>
                      <button className="item" onClick={() => editor?.chain().focus().addRowAfter().run()}>
                        행 추가
                      </button>
                      <button className="item" onClick={() => editor?.chain().focus().deleteRow().run()}>
                        행 삭제
                      </button>
                      <button className="item" onClick={() => editor?.chain().focus().addColumnAfter().run()}>
                        열 추가
                      </button>
                      <button className="item" onClick={() => editor?.chain().focus().deleteColumn().run()}>
                        열 삭제
                      </button>
                      <button className="item" onClick={() => editor?.chain().focus().toggleHeaderRow().run()}>
                        머리글 행 전환
                      </button>
                      <button
                        className="item danger"
                        onClick={() => {
                          editor?.chain().focus().deleteTable().run();
                          setMenu(null);
                        }}
                      >
                        표 삭제
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          {/* 찾기/바꾸기 */}
          <div className="doc-dd-wrap">
            <button
              className={btn(menu === 'find')}
              title="찾기/바꾸기"
              onClick={() => {
                setFindCount(null);
                setMenu(menu === 'find' ? null : 'find');
              }}
            >
              찾기
            </button>
            {menu === 'find' && (
              <>
                <div className="doc-dd-back" onClick={() => setMenu(null)} />
                <div className="doc-find">
                  <input
                    autoFocus
                    placeholder="찾을 내용"
                    value={findText}
                    onChange={(e) => {
                      setFindText(e.target.value);
                      setFindCount(null);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && findNext()}
                  />
                  <input
                    placeholder="바꿀 내용"
                    value={replaceText}
                    onChange={(e) => setReplaceText(e.target.value)}
                  />
                  <div className="doc-find-btns">
                    <button className="doc-find-go" onClick={findNext}>
                      다음
                    </button>
                    <button onClick={replaceOne}>바꾸기</button>
                    <button onClick={replaceAll}>모두 바꾸기</button>
                  </div>
                  {findCount !== null && (
                    <span className="doc-find-count">
                      {findCount === 0 ? '결과 없음' : `${findCount}개 일치`}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
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
