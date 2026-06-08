import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '../store';
import { PlusIcon, CloseIcon, PlayIcon } from './Icons';

interface SlideMeta {
  id: string;
  ord: number;
}
interface ElData {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  size: number;
  bold?: boolean;
  align?: 'left' | 'center';
}

const COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];

/** Yjs 기반 협업 슬라이드(PowerPoint형) — roomId 단위 공유 */
export default function SlideEditor({ roomId }: { roomId: string }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const ydocRef = useRef<Y.Doc | null>(null);
  const slidesMapRef = useRef<Y.Map<{ ord: number }> | null>(null);
  const elsRef = useRef<Y.Map<ElData> | null>(null);
  const [, bump] = useState(0);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [peers, setPeers] = useState(1);
  const [slides, setSlides] = useState<SlideMeta[]>([]);
  const [activeSlideId, setActiveSlideId] = useState<string | null>(null);
  const [selEl, setSelEl] = useState<string | null>(null);
  const [editingEl, setEditingEl] = useState<string | null>(null);
  const [present, setPresent] = useState(false);
  const [presentIdx, setPresentIdx] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, ydoc, {
      params: { token: token ?? '' },
    });
    const slidesMap = ydoc.getMap<{ ord: number }>('slides');
    ydocRef.current = ydoc;
    slidesMapRef.current = slidesMap;
    setStatus(provider.wsconnected ? 'connected' : 'connecting');

    const syncSlides = () => {
      const list: SlideMeta[] = [];
      slidesMap.forEach((v, id) => list.push({ id, ord: v.ord }));
      list.sort((a, b) => a.ord - b.ord);
      setSlides(list);
      setActiveSlideId((cur) => (cur && list.some((s) => s.id === cur) ? cur : list[0]?.id ?? null));
    };
    slidesMap.observe(syncSlides);
    syncSlides();

    provider.on('sync', (isSynced: boolean) => {
      if (isSynced && slidesMap.size === 0) slidesMap.set(crypto.randomUUID(), { ord: 1 });
    });

    const onStatus = (e: { status: 'connecting' | 'connected' | 'disconnected' }) =>
      setStatus(e.status);
    provider.on('status', onStatus);
    const onAwareness = () => setPeers(provider.awareness.getStates().size || 1);
    provider.awareness.on('change', onAwareness);
    const color = COLORS[(user?.id ?? 0) % COLORS.length];
    provider.awareness.setLocalStateField('user', { name: user?.username ?? '익명', color });

    return () => {
      slidesMap.unobserve(syncSlides);
      provider.off('status', onStatus);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      slidesMapRef.current = null;
      elsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  // 활성 슬라이드 요소 바인딩
  useEffect(() => {
    const ydoc = ydocRef.current;
    if (!ydoc || !activeSlideId) return;
    const els = ydoc.getMap<ElData>(`slide-els:${activeSlideId}`);
    elsRef.current = els;
    bump((n) => n + 1);
    const onEls = () => bump((n) => n + 1);
    els.observe(onEls);
    return () => els.unobserve(onEls);
  }, [activeSlideId]);

  function elsOf(slideId: string): [string, ElData][] {
    const m = ydocRef.current?.getMap<ElData>(`slide-els:${slideId}`);
    return m ? ([...m.entries()] as [string, ElData][]) : [];
  }
  const activeEls = activeSlideId ? elsOf(activeSlideId) : [];

  function addSlide() {
    const map = slidesMapRef.current;
    if (!map) return;
    const ord = slides.reduce((m, s) => Math.max(m, s.ord), 0) + 1;
    const id = crypto.randomUUID();
    map.set(id, { ord });
    setActiveSlideId(id);
  }
  function deleteSlide(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const map = slidesMapRef.current;
    if (!map || slides.length <= 1) return;
    if (!confirm('이 슬라이드를 삭제할까요?')) return;
    ydocRef.current?.getMap(`slide-els:${id}`).clear();
    map.delete(id);
    if (id === activeSlideId) setActiveSlideId(slides.find((s) => s.id !== id)?.id ?? null);
  }
  function addText() {
    const els = elsRef.current;
    if (!els) return;
    const id = crypto.randomUUID();
    els.set(id, { x: 12, y: 36, w: 60, h: 14, text: '텍스트를 입력하세요', size: 22, align: 'left' });
    setSelEl(id);
    setEditingEl(id);
  }
  function addTitle() {
    const els = elsRef.current;
    if (!els) return;
    const id = crypto.randomUUID();
    els.set(id, { x: 8, y: 8, w: 84, h: 16, text: '제목', size: 40, bold: true, align: 'center' });
    setSelEl(id);
    setEditingEl(id);
  }
  function updateEl(id: string, patch: Partial<ElData>) {
    const els = elsRef.current;
    const cur = els?.get(id);
    if (els && cur) els.set(id, { ...cur, ...patch });
  }
  function deleteEl(id: string) {
    elsRef.current?.delete(id);
    setSelEl(null);
    setEditingEl(null);
  }

  // 드래그 이동
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      const canvas = canvasRef.current;
      if (!d || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dx = ((e.clientX - d.sx) / rect.width) * 100;
      const dy = ((e.clientY - d.sy) / rect.height) * 100;
      updateEl(d.id, {
        x: Math.max(0, Math.min(95, d.ox + dx)),
        y: Math.max(0, Math.min(95, d.oy + dy)),
      });
    }
    function onUp() {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.style.userSelect = '';
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startDrag(id: string, el: ElData, e: React.MouseEvent) {
    if (editingEl === id) return;
    setSelEl(id);
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, ox: el.x, oy: el.y };
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  // 발표 모드 키보드
  useEffect(() => {
    if (!present) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' || e.key === ' ') setPresentIdx((i) => Math.min(slides.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setPresentIdx((i) => Math.max(0, i - 1));
      else if (e.key === 'Escape') setPresent(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [present, slides.length]);

  const statusLabel =
    status === 'connected' ? '실시간 연결됨' : status === 'connecting' ? '연결 중…' : '연결 끊김';

  const renderEl = (id: string, el: ElData, editable: boolean) => (
    <div
      key={id}
      className={`slide-el${selEl === id && editable ? ' sel' : ''}`}
      style={{
        left: `${el.x}%`,
        top: `${el.y}%`,
        width: `${el.w}%`,
        fontSize: `clamp(8px, ${el.size / 10}vw, ${el.size}px)`,
        fontWeight: el.bold ? 800 : 400,
        textAlign: el.align ?? 'left',
        cursor: editable ? (editingEl === id ? 'text' : 'move') : 'default',
      }}
      onMouseDown={editable ? (e) => startDrag(id, el, e) : undefined}
      onDoubleClick={editable ? () => setEditingEl(id) : undefined}
    >
      {editable && editingEl === id ? (
        <textarea
          className="slide-el-input"
          autoFocus
          value={el.text}
          style={{ fontSize: 'inherit', fontWeight: 'inherit', textAlign: 'inherit' }}
          onChange={(e) => updateEl(id, { text: e.target.value })}
          onBlur={() => setEditingEl(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditingEl(null);
          }}
        />
      ) : (
        <span className="slide-el-text">{el.text || ' '}</span>
      )}
      {editable && selEl === id && editingEl !== id && (
        <button className="slide-el-del" onMouseDown={(e) => e.stopPropagation()} onClick={() => deleteEl(id)}>
          <CloseIcon size={11} />
        </button>
      )}
    </div>
  );

  if (present) {
    const slide = slides[presentIdx];
    return (
      <div className="slide-present" onClick={() => setPresentIdx((i) => Math.min(slides.length - 1, i + 1))}>
        <div className="slide-present-canvas">
          {slide && elsOf(slide.id).map(([id, el]) => renderEl(id, el, false))}
        </div>
        <div className="slide-present-bar" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => setPresentIdx((i) => Math.max(0, i - 1))}>◀</button>
          <span>
            {presentIdx + 1} / {slides.length}
          </span>
          <button onClick={() => setPresentIdx((i) => Math.min(slides.length - 1, i + 1))}>▶</button>
          <button className="slide-present-exit" onClick={() => setPresent(false)}>
            나가기 (Esc)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="slide-editor">
      <div className="slide-bar">
        <div className="slide-tools">
          <button onClick={addTitle}>＋ 제목</button>
          <button onClick={addText}>＋ 텍스트</button>
        </div>
        <div className="slide-right">
          <button
            className="slide-present-btn"
            onClick={() => {
              setPresentIdx(slides.findIndex((s) => s.id === activeSlideId) || 0);
              setPresent(true);
            }}
          >
            <PlayIcon size={12} /> 발표
          </button>
          <span className="code-doc-peers">{peers}명 참여</span>
          <span className={`code-doc-status ${status}`}>
            <i /> {statusLabel}
          </span>
        </div>
      </div>
      <div className="slide-body">
        {/* 슬라이드 목록 */}
        <div className="slide-list">
          {slides.map((s, i) => (
            <div
              key={s.id}
              className={`slide-thumb${s.id === activeSlideId ? ' active' : ''}`}
              onClick={() => setActiveSlideId(s.id)}
            >
              <span className="slide-thumb-num">{i + 1}</span>
              <div className="slide-thumb-canvas">
                {elsOf(s.id).map(([id, el]) => (
                  <div
                    key={id}
                    className="slide-thumb-el"
                    style={{
                      left: `${el.x}%`,
                      top: `${el.y}%`,
                      width: `${el.w}%`,
                      fontWeight: el.bold ? 800 : 400,
                      textAlign: el.align ?? 'left',
                    }}
                  >
                    {el.text}
                  </div>
                ))}
              </div>
              {slides.length > 1 && (
                <button className="slide-thumb-del" onClick={(e) => deleteSlide(s.id, e)}>
                  <CloseIcon size={10} />
                </button>
              )}
            </div>
          ))}
          <button className="slide-add" onClick={addSlide}>
            <PlusIcon size={16} /> 슬라이드
          </button>
        </div>
        {/* 편집 캔버스 */}
        <div className="slide-stage">
          <div className="slide-canvas" ref={canvasRef} onMouseDown={() => setSelEl(null)}>
            {activeEls.map(([id, el]) => renderEl(id, el, true))}
          </div>
        </div>
      </div>
    </div>
  );
}
