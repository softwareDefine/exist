import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '../store';
import { PlusIcon, CloseIcon, PlayIcon } from './Icons';

interface SlideMeta {
  id: string;
  ord: number;
}
type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'line' | 'arrow';
interface ElData {
  type?: 'text' | 'shape' | 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  // 텍스트
  text?: string;
  size?: number;
  bold?: boolean;
  align?: 'left' | 'center';
  color?: string;
  // 도형
  shape?: ShapeKind;
  fill?: string;
  stroke?: string;
  // 이미지
  src?: string;
}

const COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];
const PALETTE = ['#21c818', '#e5484d', '#f76808', '#f5a524', '#4f7cff', '#8e4ec6', '#1c2024', '#ffffff', ''];

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
  const resizeRef = useRef<{ id: string; sx: number; sy: number; ow: number; oh: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [shapeMenu, setShapeMenu] = useState(false);

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
    els.set(id, { type: 'text', x: 12, y: 36, w: 60, h: 14, text: '텍스트를 입력하세요', size: 22, align: 'left' });
    setSelEl(id);
    setEditingEl(id);
  }
  function addTitle() {
    const els = elsRef.current;
    if (!els) return;
    const id = crypto.randomUUID();
    els.set(id, { type: 'text', x: 8, y: 8, w: 84, h: 16, text: '제목', size: 40, bold: true, align: 'center' });
    setSelEl(id);
    setEditingEl(id);
  }
  function addShape(shape: ShapeKind) {
    const els = elsRef.current;
    if (!els) return;
    const id = crypto.randomUUID();
    const isLine = shape === 'line' || shape === 'arrow';
    els.set(id, {
      type: 'shape',
      shape,
      x: 30,
      y: 30,
      w: 30,
      h: isLine ? 6 : 22,
      fill: isLine ? '' : '#a5d8ff',
      stroke: '#1971c2',
    });
    setShapeMenu(false);
    setSelEl(id);
    setEditingEl(null);
  }
  async function addImage(file: File) {
    const els = elsRef.current;
    if (!els) return;
    try {
      const res = await fetch(`/api/workspaces/uploads?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: file,
      });
      const { url } = (await res.json()) as { url: string };
      const id = crypto.randomUUID();
      els.set(id, { type: 'image', src: url, x: 25, y: 25, w: 40, h: 40 });
      setSelEl(id);
    } catch {
      /* 업로드 실패 무시 */
    }
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

  // 드래그 이동 / 크기 조절
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const d = dragRef.current;
      if (d) {
        const dx = ((e.clientX - d.sx) / rect.width) * 100;
        const dy = ((e.clientY - d.sy) / rect.height) * 100;
        updateEl(d.id, {
          x: Math.max(0, Math.min(98, d.ox + dx)),
          y: Math.max(0, Math.min(98, d.oy + dy)),
        });
      }
      const z = resizeRef.current;
      if (z) {
        const dw = ((e.clientX - z.sx) / rect.width) * 100;
        const dh = ((e.clientY - z.sy) / rect.height) * 100;
        updateEl(z.id, {
          w: Math.max(3, z.ow + dw),
          h: Math.max(2, z.oh + dh),
        });
      }
    }
    function onUp() {
      if (dragRef.current || resizeRef.current) {
        dragRef.current = null;
        resizeRef.current = null;
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
  function startResize(id: string, el: ElData, e: React.MouseEvent) {
    e.stopPropagation();
    setSelEl(id);
    resizeRef.current = { id, sx: e.clientX, sy: e.clientY, ow: el.w, oh: el.h };
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
  const selElData = selEl ? elsRef.current?.get(selEl) ?? null : null;

  const renderShapeSvg = (el: ElData) => {
    const fill = el.fill || 'none';
    const stroke = el.stroke || 'none';
    const sw = 3;
    return (
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" style={{ display: 'block', overflow: 'visible' }}>
        {el.shape === 'rect' && <rect x="2" y="2" width="96" height="96" fill={fill} stroke={stroke} strokeWidth={sw} />}
        {el.shape === 'ellipse' && <ellipse cx="50" cy="50" rx="48" ry="48" fill={fill} stroke={stroke} strokeWidth={sw} />}
        {el.shape === 'triangle' && <polygon points="50,3 97,97 3,97" fill={fill} stroke={stroke} strokeWidth={sw} />}
        {el.shape === 'line' && <line x1="2" y1="50" x2="98" y2="50" stroke={el.stroke || '#1971c2'} strokeWidth="5" strokeLinecap="round" />}
        {el.shape === 'arrow' && (
          <g stroke={el.stroke || '#1971c2'} fill={el.stroke || '#1971c2'}>
            <line x1="2" y1="50" x2="88" y2="50" strokeWidth="5" strokeLinecap="round" />
            <polygon points="84,40 100,50 84,60" stroke="none" />
          </g>
        )}
      </svg>
    );
  };

  const renderEl = (id: string, el: ElData, editable: boolean) => {
    const isText = (el.type ?? 'text') === 'text';
    const isShape = el.type === 'shape';
    const isImage = el.type === 'image';
    return (
      <div
        key={id}
        className={`slide-el${selEl === id && editable ? ' sel' : ''}${isText ? '' : ' bare'}`}
        style={{
          left: `${el.x}%`,
          top: `${el.y}%`,
          width: `${el.w}%`,
          height: isText ? undefined : `${el.h}%`,
          fontSize: isText ? `clamp(8px, ${(el.size ?? 22) / 10}vw, ${el.size ?? 22}px)` : undefined,
          fontWeight: el.bold ? 800 : 400,
          textAlign: el.align ?? 'left',
          color: el.color || undefined,
          cursor: editable ? (editingEl === id ? 'text' : 'move') : 'default',
        }}
        onMouseDown={editable ? (e) => startDrag(id, el, e) : undefined}
        onDoubleClick={editable && isText ? () => setEditingEl(id) : undefined}
      >
        {isText &&
          (editable && editingEl === id ? (
            <textarea
              className="slide-el-input"
              autoFocus
              value={el.text}
              style={{ fontSize: 'inherit', fontWeight: 'inherit', textAlign: 'inherit', color: 'inherit' }}
              onChange={(e) => updateEl(id, { text: e.target.value })}
              onBlur={() => setEditingEl(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditingEl(null);
              }}
            />
          ) : (
            <span className="slide-el-text">{el.text || ' '}</span>
          ))}
        {isShape && renderShapeSvg(el)}
        {isImage && <img className="slide-el-img" src={el.src} alt="" draggable={false} />}
        {editable && selEl === id && editingEl !== id && (
          <>
            <button className="slide-el-del" onMouseDown={(e) => e.stopPropagation()} onClick={() => deleteEl(id)}>
              <CloseIcon size={11} />
            </button>
            <span className="slide-el-resize" onMouseDown={(e) => startResize(id, el, e)} />
          </>
        )}
      </div>
    );
  };

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
          <div className="slide-shape-wrap">
            <button onClick={() => setShapeMenu((v) => !v)}>＋ 도형 ▾</button>
            {shapeMenu && (
              <>
                <div className="slide-shape-back" onClick={() => setShapeMenu(false)} />
                <div className="slide-shape-menu">
                  <button onClick={() => addShape('rect')}>▭ 사각형</button>
                  <button onClick={() => addShape('ellipse')}>◯ 원</button>
                  <button onClick={() => addShape('triangle')}>△ 삼각형</button>
                  <button onClick={() => addShape('line')}>— 선</button>
                  <button onClick={() => addShape('arrow')}>→ 화살표</button>
                </div>
              </>
            )}
          </div>
          <button onClick={() => fileRef.current?.click()}>＋ 그림</button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void addImage(f);
              e.target.value = '';
            }}
          />
          {/* 선택 요소 속성 */}
          {selElData && (
            <div className="slide-props">
              <span className="sht-sep" />
              {selElData.type === 'shape' && (
                <>
                  <span className="slide-prop-label">채움</span>
                  {PALETTE.map((col) => (
                    <button
                      key={'f' + col}
                      className="sht-swatch"
                      style={{ background: col || '#fff', outline: selElData.fill === col ? '2px solid var(--green)' : undefined }}
                      onClick={() => updateEl(selEl!, { fill: col })}
                      title={col || '없음'}
                    >
                      {col ? '' : '✕'}
                    </button>
                  ))}
                  <span className="slide-prop-label">선</span>
                  {PALETTE.slice(0, 7).map((col) => (
                    <button
                      key={'s' + col}
                      className="sht-swatch"
                      style={{ background: col || '#fff', outline: selElData.stroke === col ? '2px solid var(--green)' : undefined }}
                      onClick={() => updateEl(selEl!, { stroke: col })}
                    />
                  ))}
                </>
              )}
              {(selElData.type ?? 'text') === 'text' && (
                <>
                  <button className="slide-prop-btn" onClick={() => updateEl(selEl!, { bold: !selElData.bold })}>
                    <b>B</b>
                  </button>
                  <span className="slide-prop-label">글자색</span>
                  {PALETTE.slice(0, 8).map((col) => (
                    <button
                      key={'t' + col}
                      className="sht-swatch"
                      style={{ background: col || '#fff', outline: selElData.color === col ? '2px solid var(--green)' : undefined }}
                      onClick={() => updateEl(selEl!, { color: col })}
                    />
                  ))}
                </>
              )}
            </div>
          )}
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
                      height: (el.type ?? 'text') === 'text' ? undefined : `${el.h}%`,
                      fontWeight: el.bold ? 800 : 400,
                      textAlign: el.align ?? 'left',
                      color: el.color || undefined,
                    }}
                  >
                    {el.type === 'shape' && renderShapeSvg(el)}
                    {el.type === 'image' && <img className="slide-el-img" src={el.src} alt="" />}
                    {(el.type ?? 'text') === 'text' && el.text}
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
