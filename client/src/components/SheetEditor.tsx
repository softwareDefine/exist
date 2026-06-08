import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '../store';
import { DownloadIcon } from './Icons';

const COLS = 26; // A..Z
const ROWS = 60;

function colLetter(i: number): string {
  return String.fromCharCode(65 + i); // 0->A
}
function cellKey(r: number, c: number): string {
  return `${colLetter(c)}${r + 1}`; // A1 style (1-indexed row)
}
function parseRef(ref: string): { r: number; c: number } | null {
  const m = /^([A-Z])(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) return null;
  const c = m[1].charCodeAt(0) - 65;
  const r = parseInt(m[2], 10) - 1;
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return null;
  return { r, c };
}

/** 수식 평가 — =SUM(A1:A3), =A1+B2*2 등. 셀 참조는 재귀 평가(사이클 가드). */
function evalCell(
  raw: string | undefined,
  cells: Y.Map<unknown>,
  seen: Set<string>,
  key: string,
): string {
  if (raw == null || raw === '') return '';
  if (raw[0] !== '=') return raw;
  if (seen.has(key)) return '#순환';
  seen.add(key);
  try {
    let expr = raw.slice(1).toUpperCase();
    // 범위 함수: SUM/AVERAGE/MIN/MAX(A1:B3)
    expr = expr.replace(
      /(SUM|AVERAGE|AVG|MIN|MAX|COUNT)\(\s*([A-Z]\d+)\s*:\s*([A-Z]\d+)\s*\)/g,
      (_m, fn: string, a: string, b: string) => {
        const ra = parseRef(a);
        const rb = parseRef(b);
        if (!ra || !rb) return '0';
        const nums: number[] = [];
        for (let r = Math.min(ra.r, rb.r); r <= Math.max(ra.r, rb.r); r++) {
          for (let c = Math.min(ra.c, rb.c); c <= Math.max(ra.c, rb.c); c++) {
            const k = cellKey(r, c);
            const v = parseFloat(evalCell(cells.get(k) as string, cells, new Set(seen), k));
            if (!isNaN(v)) nums.push(v);
          }
        }
        const sum = nums.reduce((s, n) => s + n, 0);
        switch (fn) {
          case 'SUM':
            return String(sum);
          case 'AVERAGE':
          case 'AVG':
            return nums.length ? String(sum / nums.length) : '0';
          case 'MIN':
            return nums.length ? String(Math.min(...nums)) : '0';
          case 'MAX':
            return nums.length ? String(Math.max(...nums)) : '0';
          case 'COUNT':
            return String(nums.length);
        }
        return '0';
      },
    );
    // 단일 셀 참조 치환
    expr = expr.replace(/[A-Z]\d+/g, (ref) => {
      const rf = parseRef(ref);
      if (!rf) return '0';
      const k = cellKey(rf.r, rf.c);
      const v = parseFloat(evalCell(cells.get(k) as string, cells, new Set(seen), k));
      return isNaN(v) ? '0' : String(v);
    });
    // 산술만 허용
    if (!/^[\d.+\-*/() ]*$/.test(expr)) return '#오류';
    if (expr.trim() === '') return '';
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict";return (${expr})`)();
    if (typeof result !== 'number' || !isFinite(result)) return '#오류';
    return String(Math.round(result * 1e10) / 1e10);
  } catch {
    return '#오류';
  }
}

const COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];

/** Yjs 기반 협업 스프레드시트 — roomId 단위 공유 */
export default function SheetEditor({ roomId }: { roomId: string }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const cellsRef = useRef<Y.Map<unknown> | null>(null);
  const [, bump] = useState(0);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [peers, setPeers] = useState(1);
  const [sel, setSel] = useState<{ r: number; c: number }>({ r: 0, c: 0 }); // 활성(포커스) 셀
  const [anchor, setAnchor] = useState<{ r: number; c: number }>({ r: 0, c: 0 }); // 선택 시작점
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);

  // 드래그 종료 (그리드 밖에서 마우스 떼도 처리)
  useEffect(() => {
    const up = () => {
      draggingRef.current = false;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  function selectCell(r: number, c: number) {
    setAnchor({ r, c });
    setSel({ r, c });
  }

  useEffect(() => {
    const ydoc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, ydoc, {
      params: { token: token ?? '' },
    });
    const cells = ydoc.getMap('cells');
    cellsRef.current = cells;
    setStatus(provider.wsconnected ? 'connected' : 'connecting');

    const onCells = () => bump((n) => n + 1);
    cells.observe(onCells);
    const onStatus = (e: { status: 'connecting' | 'connected' | 'disconnected' }) =>
      setStatus(e.status);
    provider.on('status', onStatus);
    const onAwareness = () => setPeers(provider.awareness.getStates().size || 1);
    provider.awareness.on('change', onAwareness);
    const color = COLORS[(user?.id ?? 0) % COLORS.length];
    provider.awareness.setLocalStateField('user', { name: user?.username ?? '익명', color });

    return () => {
      cells.unobserve(onCells);
      provider.off('status', onStatus);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      cellsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  function raw(r: number, c: number): string {
    return (cellsRef.current?.get(cellKey(r, c)) as string) ?? '';
  }
  function display(r: number, c: number): string {
    const cells = cellsRef.current;
    if (!cells) return '';
    const k = cellKey(r, c);
    return evalCell(cells.get(k) as string, cells, new Set(), k);
  }
  function setCell(r: number, c: number, value: string) {
    const cells = cellsRef.current;
    if (!cells) return;
    const k = cellKey(r, c);
    if (value === '') cells.delete(k);
    else cells.set(k, value);
  }

  function startEdit(r: number, c: number, initial?: string) {
    selectCell(r, c);
    setEditing({ r, c, value: initial ?? raw(r, c) });
    setTimeout(() => editRef.current?.focus(), 0);
  }
  function commitEdit(move: 'down' | 'right' | null) {
    if (!editing) return;
    setCell(editing.r, editing.c, editing.value);
    const { r, c } = editing;
    setEditing(null);
    if (move === 'down') selectCell(Math.min(r + 1, ROWS - 1), c);
    else if (move === 'right') selectCell(r, Math.min(c + 1, COLS - 1));
  }

  function clearRange() {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) setCell(r, c, '');
  }

  function onGridKey(e: React.KeyboardEvent) {
    if (editing) return;
    const { r, c } = sel;
    const shift = e.shiftKey;
    const move = (nr: number, nc: number) => {
      setSel({ r: nr, c: nc });
      if (!shift) setAnchor({ r: nr, c: nc });
    };
    if (e.key === 'ArrowUp') { move(Math.max(0, r - 1), c); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { move(Math.min(ROWS - 1, r + 1), c); e.preventDefault(); }
    else if (e.key === 'Enter') { selectCell(Math.min(ROWS - 1, r + 1), c); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { move(r, Math.max(0, c - 1)); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { move(r, Math.min(COLS - 1, c + 1)); e.preventDefault(); }
    else if (e.key === 'Tab') { selectCell(r, Math.min(COLS - 1, c + 1)); e.preventDefault(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { clearRange(); e.preventDefault(); }
    else if (e.key === 'F2') { startEdit(r, c); e.preventDefault(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { startEdit(r, c, e.key); e.preventDefault(); }
  }

  function exportCsv() {
    const cells = cellsRef.current;
    if (!cells) return;
    // 사용된 범위 탐색
    let maxR = 0;
    let maxC = 0;
    cells.forEach((_v, k) => {
      const ref = parseRef(k);
      if (ref) {
        maxR = Math.max(maxR, ref.r);
        maxC = Math.max(maxC, ref.c);
      }
    });
    const rows: string[] = [];
    for (let r = 0; r <= maxR; r++) {
      const cols: string[] = [];
      for (let c = 0; c <= maxC; c++) {
        const v = display(r, c);
        cols.push(/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      }
      rows.push(cols.join(','));
    }
    const csv = '﻿' + rows.join('\r\n'); // BOM(엑셀 한글)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${roomId.replace(/^sheet-/, 'sheet_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const statusLabel =
    status === 'connected' ? '실시간 연결됨' : status === 'connecting' ? '연결 중…' : '연결 끊김';
  const activeRaw = raw(sel.r, sel.c);
  const r1 = Math.min(anchor.r, sel.r);
  const r2 = Math.max(anchor.r, sel.r);
  const c1 = Math.min(anchor.c, sel.c);
  const c2 = Math.max(anchor.c, sel.c);
  const multi = r1 !== r2 || c1 !== c2;

  return (
    <div className="sheet-editor">
      <div className="sheet-bar">
        <div className="sheet-cellref">
          {multi ? `${cellKey(r1, c1)}:${cellKey(r2, c2)}` : cellKey(sel.r, sel.c)}
        </div>
        <input
          className="sheet-formula"
          value={editing ? editing.value : activeRaw}
          placeholder="값 또는 =수식 (예: =SUM(A1:A5))"
          onChange={(e) =>
            setEditing({ r: sel.r, c: sel.c, value: e.target.value })
          }
          onFocus={() => !editing && setEditing({ r: sel.r, c: sel.c, value: activeRaw })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commitEdit('down'); (e.target as HTMLInputElement).blur(); }
            else if (e.key === 'Escape') setEditing(null);
          }}
        />
        <div className="sheet-right">
          <button className="sheet-csv" onClick={exportCsv} title="CSV로 내보내기">
            <DownloadIcon size={15} /> CSV
          </button>
          <span className="code-doc-peers">{peers}명 참여</span>
          <span className={`code-doc-status ${status}`}>
            <i /> {statusLabel}
          </span>
        </div>
      </div>
      <div className="sheet-scroll" tabIndex={0} onKeyDown={onGridKey}>
        <table className="sheet-grid">
          <thead>
            <tr>
              <th className="sheet-corner" />
              {Array.from({ length: COLS }, (_, c) => (
                <th key={c} className={c >= c1 && c <= c2 ? 'sel' : ''}>
                  {colLetter(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: ROWS }, (_, r) => (
              <tr key={r}>
                <th className={`sheet-rownum${r >= r1 && r <= r2 ? ' sel' : ''}`}>{r + 1}</th>
                {Array.from({ length: COLS }, (_, c) => {
                  const isActive = sel.r === r && sel.c === c;
                  const isRange = multi && r >= r1 && r <= r2 && c >= c1 && c <= c2;
                  const isEditing = editing && editing.r === r && editing.c === c;
                  return (
                    <td
                      key={c}
                      className={`${isActive ? 'sel' : ''}${isRange ? ' inrange' : ''}${raw(r, c)[0] === '=' ? ' formula' : ''}`}
                      onMouseDown={(e) => {
                        if (!isEditing) {
                          if (editing) commitEdit(null);
                          if (e.shiftKey) setSel({ r, c });
                          else selectCell(r, c);
                          draggingRef.current = true;
                        }
                      }}
                      onMouseEnter={() => {
                        if (draggingRef.current && !editing) setSel({ r, c });
                      }}
                      onDoubleClick={() => startEdit(r, c)}
                    >
                      {isEditing ? (
                        <input
                          ref={editRef}
                          className="sheet-cell-input"
                          value={editing!.value}
                          onChange={(e) =>
                            setEditing({ r, c, value: e.target.value })
                          }
                          onBlur={() => commitEdit(null)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitEdit('down'); }
                            else if (e.key === 'Tab') { e.preventDefault(); commitEdit('right'); }
                            else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                          }}
                        />
                      ) : (
                        <span className="sheet-cell-val">{display(r, c)}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
