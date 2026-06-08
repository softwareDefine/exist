import { useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '../store';

const CARET_COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];

/** Yjs 기반 리치텍스트 공동편집 문서 (Word형) — roomId 단위 공유 */
export default function DocEditor({ roomId }: { roomId: string }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [peers, setPeers] = useState(1);
  const [conn, setConn] = useState<{ ydoc: Y.Doc; provider: WebsocketProvider } | null>(null);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, ydoc, {
      params: { token: token ?? '' },
    });
    setConn({ ydoc, provider });
    setStatus(provider.wsconnected ? 'connected' : 'connecting');

    const onStatus = (e: { status: 'connecting' | 'connected' | 'disconnected' }) =>
      setStatus(e.status);
    provider.on('status', onStatus);
    const onAwareness = () => setPeers(provider.awareness.getStates().size || 1);
    provider.awareness.on('change', onAwareness);
    return () => {
      provider.off('status', onStatus);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      setConn(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  const color = CARET_COLORS[(user?.id ?? 0) % CARET_COLORS.length];

  const editor = useEditor(
    {
      extensions: conn
        ? [
            StarterKit.configure({ undoRedo: false }),
            Collaboration.configure({ document: conn.ydoc }),
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
    [conn],
  );

  const statusLabel =
    status === 'connected' ? '실시간 연결됨' : status === 'connecting' ? '연결 중…' : '연결 끊김';

  const btn = (active: boolean) => `doc-tool${active ? ' on' : ''}`;

  return (
    <div className="doc-editor">
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
