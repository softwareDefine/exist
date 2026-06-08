import { useEffect, useRef, useState } from 'react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
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

type Lang = 'javascript' | 'python' | 'cpp';

const LANGS: { id: Lang; label: string }[] = [
  { id: 'javascript', label: 'JavaScript / TS' },
  { id: 'python', label: 'Python' },
  { id: 'cpp', label: 'C / C++' },
];

const CURSOR_COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];

function langExt(l: Lang): Extension {
  if (l === 'python') return python();
  if (l === 'cpp') return cpp();
  return javascript({ typescript: true });
}

/** Yjs 기반 코드 공동편집 에디터 — roomId 단위 공유 */
export default function CodeDocEditor({ roomId }: { roomId: string }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const metaRef = useRef<Y.Map<unknown> | null>(null);
  const langComp = useRef(new Compartment());
  const [lang, setLang] = useState<Lang>('javascript');
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [peers, setPeers] = useState(1);

  useEffect(() => {
    if (!hostRef.current) return;

    const doc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, doc, {
      params: { token: token ?? '' },
    });
    const ytext = doc.getText('codemirror');
    const ymeta = doc.getMap('meta');
    metaRef.current = ymeta;

    const color = CURSOR_COLORS[(user?.id ?? 0) % CURSOR_COLORS.length];
    provider.awareness.setLocalStateField('user', {
      name: user?.username ?? '익명',
      color,
      colorLight: color + '33',
    });

    const onStatus = (e: { status: 'connecting' | 'connected' | 'disconnected' }) =>
      setStatus(e.status);
    provider.on('status', onStatus);

    const onAwareness = () => setPeers(provider.awareness.getStates().size || 1);
    provider.awareness.on('change', onAwareness);

    const reconfigureLang = () => {
      const l = ((ymeta.get('lang') as Lang) || 'javascript') as Lang;
      setLang(l);
      viewRef.current?.dispatch({ effects: langComp.current.reconfigure(langExt(l)) });
    };
    ymeta.observe(reconfigureLang);

    const startLang = ((ymeta.get('lang') as Lang) || 'javascript') as Lang;
    setLang(startLang);

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        langComp.current.of(langExt(startLang)),
        oneDark,
        yCollab(ytext, provider.awareness),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13.5px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      ymeta.unobserve(reconfigureLang);
      provider.awareness.off('change', onAwareness);
      provider.off('status', onStatus);
      view.destroy();
      provider.destroy();
      doc.destroy();
      viewRef.current = null;
      metaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  function changeLang(l: Lang) {
    setLang(l);
    metaRef.current?.set('lang', l);
  }

  const statusLabel =
    status === 'connected' ? '실시간 연결됨' : status === 'connecting' ? '연결 중…' : '연결 끊김';

  return (
    <div className="code-doc">
      <div className="code-doc-bar">
        <div className="code-doc-left">
          <select
            className="code-doc-lang"
            value={lang}
            onChange={(e) => changeLang(e.target.value as Lang)}
          >
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="code-doc-name">{roomId.replace(/^code-/, '')}</span>
        </div>
        <div className="code-doc-right">
          <span className="code-doc-peers">{peers}명 참여</span>
          <span className={`code-doc-status ${status}`}>
            <i /> {statusLabel}
          </span>
        </div>
      </div>
      <div className="code-doc-editor" ref={hostRef} />
    </div>
  );
}
