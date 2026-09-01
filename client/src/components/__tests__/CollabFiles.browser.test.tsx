import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { fireEvent } from '@testing-library/dom';
import { mockApi } from '../../test/mockApi';
import { mockXhr } from '../../test/xhr.mock';
import { login } from '../../test/auth';
import { captureEvents } from '../../test/render';
import { captureDownloads, dragAndDrop, setInputFiles, tick } from '../../test/browser';
import { useNameStore } from '../../names';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
// 에디터는 스텁 — 파일시스템 흐름(회람·개정·휴지통·배포·미리보기·이동)만 진짜 DOM에서 검증
vi.mock('../CodeDocEditor', () => ({ default: ({ roomId }: { roomId: string }) => <div data-testid="code-editor">{roomId}</div> }));
vi.mock('../DocEditor', () => ({ default: ({ roomId }: { roomId: string }) => <div data-testid="doc-editor">{roomId}</div> }));
vi.mock('../SheetEditor', () => ({ default: ({ roomId }: { roomId: string }) => <div data-testid="sheet-editor">{roomId}</div> }));
vi.mock('../SlideEditor', () => ({ default: ({ roomId }: { roomId: string }) => <div data-testid="slide-editor">{roomId}</div> }));
vi.mock('../CanvasBoard', () => ({ default: ({ roomId }: { roomId: string }) => <div data-testid="canvas-board">{roomId}</div> }));

import { fakeSocket } from '../../test/socket.mock';
import CollabFiles from '../CollabFiles';

const CODE = 'ABCD';
const T = '2026-08-01 00:00:00';
const FILES = [
  { id: 1, parent_id: null, name: 'SOP', type: 'folder', room: null, author: 'juho', created_at: T },
  { id: 2, parent_id: null, name: '온도표', type: 'sheet', room: 'sheet-2', author: 'kim', created_at: T, updated_at: '2026-08-20 00:00:00', size: 500 },
  { id: 3, parent_id: 1, name: '작업지침', type: 'doc', room: 'doc-3', author: 'kim', created_at: T, ack_required: 1, ack_count: 1, my_ack: 0, ack_total: 3, rev: 2 },
  { id: 4, parent_id: null, name: 'photo.png', type: 'file', room: null, author: 'kim', created_at: T, mime: 'image/png', size: 12345 },
  { id: 5, parent_id: null, name: '설계.slide', type: 'slide', room: 'slide-5', author: 'juho', created_at: T },
  { id: 6, parent_id: null, name: 'spec.pdf', type: 'file', room: null, author: 'kim', created_at: T, mime: 'application/pdf', size: 2048 },
  { id: 7, parent_id: null, name: 'notes.txt', type: 'file', room: null, author: 'kim', created_at: T, size: 10 },
  { id: 8, parent_id: null, name: '품의서.hwpx', type: 'file', room: null, author: 'kim', created_at: T, size: 900 },
  { id: 9, parent_id: null, name: 'old.hwp', type: 'file', room: null, author: 'kim', created_at: T, size: 512 },
  { id: 10, parent_id: null, name: 'report.docx', type: 'file', room: null, author: 'kim', created_at: T, size: 5000 },
  { id: 11, parent_id: null, name: 'clip.mp4', type: 'file', room: null, author: 'kim', created_at: T, size: 99999 },
  { id: 12, parent_id: null, name: 'song.mp3', type: 'file', room: null, author: 'kim', created_at: T, size: 3000 },
  { id: 13, parent_id: null, name: '스크립트', type: 'code', room: 'code-13', author: 'kim', created_at: T },
  { id: 14, parent_id: null, name: '보드', type: 'canvas', room: 'canvas-14', author: 'kim', created_at: T },
  { id: 15, parent_id: null, name: '회의록', type: 'doc', room: 'doc-15', author: 'juho', created_at: T, ack_required: 1, ack_count: 3, my_ack: 1, ack_total: 3, rev: 1 },
];
const TRASH = [
  { id: 21, name: '지운문서', type: 'doc', deleted_at: '2026-08-21 01:00:00', updated_at: T, author: 'juho', children: 0, size: 100, location: '' },
  { id: 22, name: '옛폴더', type: 'folder', deleted_at: '2026-08-20 01:00:00', updated_at: T, author: 'kim', children: 2, size: null, location: 'SOP' },
];

function setup(m: ReturnType<typeof mockApi>, list = FILES, trash: unknown[] = []) {
  m.get(`/api/meetings/${CODE}/files`, () => list);
  m.get(`/api/meetings/${CODE}/files/trash/list`, () => trash);
  m.get(`/api/meetings/${CODE}/files/recent/list`, [{ id: 2, name: '온도표', type: 'sheet', last_ts: '2026-08-20 00:00:00' }]);
  m.get(`/api/meetings/${CODE}/files/presence`, { 2: [{ username: 'kim', avatar: null }] });
  m.get(`/api/meetings/${CODE}/decisions`, [
    { recapId: 3, idx: 0, decision: '63도 기준으로 상향', ts: Date.parse('2026-08-15T00:00:00Z') },
    { recapId: 3, idx: 1, decision: '야간 점검 2회', ts: Date.parse('2026-08-16T00:00:00Z') },
  ]);
  m.get(/\/files\/\d+\/acks$/, {
    required: true,
    total: 3,
    acks: [{ username: 'lee', ack_at: '2026-08-10 00:00:00', signature: 'data:image/png;base64,AAAA' }],
    pending: [{ username: 'juho', avatar: null }, { username: 'kim', avatar: null }],
    rev: 2,
    note: '63도 기준으로 수정',
    basis: { recapId: 3, idx: 0, text: '63도 기준으로 상향' },
  });
  m.get(/\/files\/\d+\/history$/, {
    rev: 2,
    entries: [
      { rev: 2, at: '2026-08-15 00:00:00', note: '온도 기준 변경', basis: { recapId: 3, idx: 0, text: '63도 기준으로 상향' }, basisNote: null, signs: 1, current: true },
      { rev: 1, at: T, note: null, basis: null, basisNote: '초안', signs: 3, current: false },
    ],
  });
  m.get(/\/files\/\d+\/versions$/, [
    { id: 902, size: 200, created_at: '2026-08-05 00:00:00', username: 'kim' },
    { id: 901, size: 100, created_at: T, username: null },
  ]);
  m.get(/\/files\/\d+\/meetings$/, [{ recapId: 3, summary: '온도 기준 회의', ts: Date.parse('2026-08-15T00:00:00Z') }]);
  m.get(/\/files\/\d+\/preview$/, ({ url }: { url: string }) =>
    /\/files\/5\//.test(url) ? { items: [], count: 4 } : { items: ['1행 미리보기', '2행 미리보기'] },
  );
  m.get(`/api/meetings/${CODE}/channels`, [
    { id: 1, name: '일반', isDefault: true },
    { id: 2, name: '설비', kind: 'call' },
  ]);
  m.get(`/api/meetings/${CODE}/files/members/list`, [{ id: 2, username: 'kim', avatar: null }]);
  m.get(`/api/meetings/${CODE}/files/distribute/targets`, [{ id: 9, code: 'ZZZZ', title: '품질팀' }]);
  m.get(/\/files\/search\/content\?q=/, [{ id: 2, name: '온도표', type: 'sheet', snippet: 'temperature log' }]);
  m.patch(/\/files\/\d+$/, {});
  m.delete(/\/files\/\d+$/, {});
  m.post(/\/files\/\d+\/copy$/, ({ url }: { url: string }) => ({ id: 100 + Number(url.match(/files\/(\d+)\/copy/)![1]) }));
}

/** 지금 보이는 에디터 호스트 — 한 번 연 파일은 display:none으로 유지되므로 보이는 것만 */
const host = () =>
  [...document.querySelectorAll<HTMLElement>('.cf-editor-host')].find((h) => h.style.display !== 'none')!;
const entryNames = () => [...document.querySelectorAll('.cf-main .cf-entry .cf-entry-name')].map((e) => e.textContent);
const entry = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.cf-main .cf-entry')].find((e) => e.querySelector('.cf-entry-name')?.textContent === name)!;
const selectedNames = () => [...document.querySelectorAll('.cf-main .cf-entry.selected .cf-entry-name')].map((e) => e.textContent);
const btnByText = (text: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;
const btnStarts = (text: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(text))!;
const ctx = () => document.querySelector<HTMLElement>('.cf-ctx')!;
const tool = (label: string) => document.querySelector<HTMLButtonElement>(`.cf-gbar [aria-label="${label}"]`)!;
const details = () => document.querySelector<HTMLElement>('.cf-details, aside[class*="cf-details"]') ?? document.querySelector('.cf-body aside')!;
const sideFolder = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.cf-desktree-item.side-ic-folder')].find((e) => e.textContent?.trim().endsWith(name))!;

async function openCtx(name: string) {
  const el = entry(name);
  const r = el.getBoundingClientRect();
  fireEvent.contextMenu(el, { clientX: r.left + 10, clientY: r.top + 10 });
  await vi.waitFor(() => expect(ctx()).toBeTruthy());
  return ctx();
}
async function selectEntry(name: string) {
  await userEvent.click(entry(name));
  await vi.waitFor(() => expect(selectedNames()).toEqual([name]));
}
async function mount(m: ReturnType<typeof mockApi>, props: Partial<{ isHost: boolean; visible: boolean }> = {}) {
  const r = await render(
    <div style={{ width: 1200, height: 800 }}>
      <CollabFiles code={CODE} isHost={props.isHost ?? true} visible={props.visible ?? true} groupName="생산1팀" />
    </div>,
  );
  await vi.waitFor(() => expect(entryNames()).toContain('온도표'));
  void m;
  return r;
}

describe('CollabFiles (Chromium) — 파일시스템 흐름', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    login({ id: 1, username: 'juho', name: '이주호' });
    useNameStore.setState({ map: { kim: '김대리', juho: '이주호', lee: '이과장' } });
  });

  it('새로 만들기(툴바 메뉴) → 폴더·시트 POST, F2 이름 바꾸기 PATCH, ⋯ 실행 취소로 되돌림', async () => {
    setup(m);
    m.post(`/api/meetings/${CODE}/files`, ({ body }: { body: { name: string; type: string } }) => ({
      id: body.type === 'folder' ? 30 : 31,
      parent_id: null,
      name: body.name,
      type: body.type,
      room: body.type === 'folder' ? null : `${body.type}-31`,
    }));
    await mount(m);
    await userEvent.click(btnStarts('새로 만들기'));
    await userEvent.click(btnByText('폴더', document.querySelector('.cf-type-menu')!));
    const input = document.querySelector<HTMLInputElement>('.cf-main input[placeholder="이름"]')!;
    await userEvent.fill(input, '도면');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/files`)).toHaveLength(1));
    expect(m.last('POST').body).toEqual({ name: '도면', type: 'folder', parent_id: null });
    await vi.waitFor(() => expect(entryNames()).toContain('도면'));
    // F2 → 인라인 이름 변경
    await selectEntry('도면');
    await userEvent.keyboard('{F2}');
    const rename = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('.cf-main .cf-name-input');
      if (!el) throw new Error('no rename input');
      return el;
    });
    expect(rename.value).toBe('도면');
    await userEvent.fill(rename, '도면v2');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(m.calls('PATCH', `/api/meetings/${CODE}/files/30`)).toHaveLength(1));
    expect(m.last('PATCH').body).toEqual({ name: '도면v2' });
    await vi.waitFor(() => expect(entryNames()).toContain('도면v2'));
    // 실행 취소 (더 보기 메뉴)
    await userEvent.click(tool('더 보기'));
    const undo = btnStarts('실행 취소', document.querySelector('.cf-more-menu')!);
    expect(undo.textContent).toContain('이름 바꾸기');
    await userEvent.click(undo);
    await vi.waitFor(() => expect(m.calls('PATCH', `/api/meetings/${CODE}/files/30`)).toHaveLength(2));
    expect(m.last('PATCH').body).toEqual({ name: '도면' });
    // 시트 생성 → 바로 열림 (에디터 스텁)
    await userEvent.click(btnStarts('새로 만들기'));
    await userEvent.click(btnByText('시트', document.querySelector('.cf-type-menu')!));
    await userEvent.fill(document.querySelector<HTMLInputElement>('.cf-main input[placeholder="이름"]')!, '재고');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="sheet-editor"]')?.textContent).toBe('sheet-31'));
    expect(document.querySelector('.cf-editor-name')?.textContent).toBe('재고');
    await userEvent.click(document.querySelector('.cf-back')!);
    await vi.waitFor(() => expect(document.querySelector('.cf-editor-bar')).toBeNull());
    // Ctrl+Z 단축키로 남은 실행 취소(만들기 → DELETE)
    await userEvent.click(document.querySelector('.cf-statusbar')!);
    await userEvent.keyboard('{Control>}z{/Control}');
    await vi.waitFor(() => expect(m.calls('DELETE', `/api/meetings/${CODE}/files/31`)).toHaveLength(1));
  });

  it('이동 — 우클릭 "이동…" 폴더 픽커 → PATCH parent_id, 드래그로 사이드바 폴더·휴지통·크럼, Ctrl 드래그 복사', async () => {
    setup(m);
    await mount(m);
    const menu = await openCtx('photo.png');
    expect(btnByText('열기', menu)).toBeTruthy();
    await userEvent.click(btnByText('이동…', menu));
    const modal = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('.cf-move-modal');
      if (!el) throw new Error('no move modal');
      return el;
    });
    expect(modal.querySelector('.cf-move-title')?.textContent).toBe('"photo.png" 이동');
    await userEvent.click(btnStarts('SOP', modal.querySelector('.cf-move-tree')!));
    await vi.waitFor(() => expect(m.last('PATCH', `/api/meetings/${CODE}/files/4`)?.body).toEqual({ parent_id: 1 }));
    // 드래그 → 사이드바 폴더
    dragAndDrop(entry('온도표'), sideFolder('SOP'));
    await vi.waitFor(() => expect(m.last('PATCH', `/api/meetings/${CODE}/files/2`)?.body).toEqual({ parent_id: 1 }));
    // Ctrl 드래그 → 폴더 엔트리에 복사
    dragAndDrop(entry('설계.slide'), entry('SOP'), { ctrlKey: true });
    await vi.waitFor(() => expect(m.last('POST', `/api/meetings/${CODE}/files/5/copy`)?.body).toEqual({ parent_id: 1 }));
    // 드래그 → 휴지통 = 삭제
    dragAndDrop(entry('spec.pdf'), document.querySelector('.cf-desktree-item.side-ic-trash')!);
    await vi.waitFor(() => expect(m.calls('DELETE', `/api/meetings/${CODE}/files/6`)).toHaveLength(1));
    // 폴더 안에서 크럼(루트)으로 드래그 = 루트로 이동
    await userEvent.dblClick(entry('SOP'));
    await vi.waitFor(() => expect(entryNames()).toContain('작업지침'));
    dragAndDrop(entry('작업지침'), document.querySelector('.cf-path .cf-crumb')!);
    await vi.waitFor(() => expect(m.last('PATCH', `/api/meetings/${CODE}/files/3`)?.body).toEqual({ parent_id: null }));
    // 픽커 취소
    const menu2 = await openCtx('작업지침');
    await userEvent.click(btnByText('이동…', menu2));
    await userEvent.click(document.querySelector('.cf-move-modal .cf-move-cancel') ?? btnByText('취소', document.querySelector('.cf-move-modal')!));
    await vi.waitFor(() => expect(document.querySelector('.cf-move-modal')).toBeNull());
  });

  it('권한 없는 항목 — 비호스트는 남의 파일을 끌 수 없고(토스트), 컨텍스트 메뉴 항목이 비활성', async () => {
    setup(m);
    const ev = captureEvents('app:error');
    await mount(m, { isHost: false });
    const dt = new DataTransfer();
    fireEvent.dragStart(entry('photo.png'), { dataTransfer: dt });
    await vi.waitFor(() => expect(ev.of('app:error').some((d) => String(d).includes('만든 사람·호스트·관리자만'))).toBe(true));
    const menu = await openCtx('photo.png');
    expect(btnByText('잘라내기', menu)).toBeDisabled();
    expect(btnByText('이름 바꾸기', menu)).toBeDisabled();
    expect(btnByText('삭제', menu)).toBeDisabled();
    expect(btnByText('복사', menu)).not.toBeDisabled();
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(document.querySelector('.cf-ctx')).toBeNull());
    ev.stop();
  });

  it('잘라내기/복사/붙여넣기 — 툴바·Ctrl 단축키·컨텍스트, Ctrl+A/Esc, Delete', async () => {
    setup(m);
    await mount(m);
    // 복사 → 폴더로 들어가 붙여넣기 = copy
    await selectEntry('photo.png');
    await userEvent.click(tool('복사'));
    await userEvent.dblClick(entry('SOP'));
    await vi.waitFor(() => expect(entryNames()).toContain('작업지침'));
    await userEvent.click(tool('붙여넣기'));
    await vi.waitFor(() => expect(m.last('POST', `/api/meetings/${CODE}/files/4/copy`)?.body).toEqual({ parent_id: 1 }));
    await userEvent.click(document.querySelector('[title="뒤로"]')!);
    await vi.waitFor(() => expect(entryNames()).toContain('온도표'));
    // Ctrl+X → 표시(cutting) → 폴더에서 Ctrl+V = 이동
    await selectEntry('온도표');
    await userEvent.keyboard('{Control>}x{/Control}');
    await vi.waitFor(() => expect(entry('온도표')).toHaveClass('cutting'));
    await userEvent.dblClick(entry('SOP'));
    await vi.waitFor(() => expect(entryNames()).toContain('작업지침'));
    await userEvent.click(document.querySelector('.cf-statusbar')!);
    await userEvent.keyboard('{Control>}v{/Control}');
    await vi.waitFor(() => expect(m.last('PATCH', `/api/meetings/${CODE}/files/2`)?.body).toEqual({ parent_id: 1 }));
    // 컨텍스트 복사 → 빈 영역 우클릭 붙여넣기
    const menu = await openCtx('작업지침');
    await userEvent.click(btnByText('복사', menu));
    const main = document.querySelector('.cf-main')!;
    fireEvent.contextMenu(main, { clientX: 600, clientY: 500 });
    await vi.waitFor(() => expect(ctx()?.textContent).toContain('새로 만들기'));
    await userEvent.click(btnByText('붙여넣기', ctx()));
    await vi.waitFor(() => expect(m.last('POST', `/api/meetings/${CODE}/files/3/copy`)?.body).toEqual({ parent_id: 1 }));
    // 빈 영역 메뉴 — 모두 선택 · 새로고침
    fireEvent.contextMenu(main, { clientX: 600, clientY: 500 });
    await vi.waitFor(() => expect(ctx()).toBeTruthy());
    await userEvent.click(btnByText('모두 선택', ctx()));
    await vi.waitFor(() => expect(selectedNames().length).toBeGreaterThan(0));
    const n = m.calls('GET', `/api/meetings/${CODE}/files`).length;
    fireEvent.contextMenu(main, { clientX: 600, clientY: 500 });
    await vi.waitFor(() => expect(ctx()).toBeTruthy());
    await userEvent.click(btnByText('새로고침', ctx()));
    await vi.waitFor(() => expect(m.calls('GET', `/api/meetings/${CODE}/files`).length).toBe(n + 1));
    await userEvent.click(document.querySelector('[title="상위 폴더"]')!);
    await vi.waitFor(() => expect(entryNames()).toContain('온도표'));
    // Ctrl+A → 전체, Esc → 해제, Delete → DELETE
    await userEvent.click(document.querySelector('.cf-statusbar')!);
    await userEvent.keyboard('{Control>}a{/Control}');
    await vi.waitFor(() => expect(selectedNames().length).toBe(entryNames().length - 2)); // 홈·휴지통 제외
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(selectedNames()).toEqual([]));
    await selectEntry('report.docx');
    await userEvent.keyboard('{Delete}');
    await vi.waitFor(() => expect(m.calls('DELETE', `/api/meetings/${CODE}/files/10`)).toHaveLength(1));
  });

  it('휴지통 — 목록·헤더 정렬·선택·우클릭 복원·영구 삭제(confirm)·비우기·모두 복원·잘라내기→폴더 붙여넣기 복원', async () => {
    setup(m, FILES, TRASH);
    m.post(/\/files\/trash\/\d+\/restore$/, ({ url }: { url: string }) => (/\/22\//.test(url) ? { fellBack: true } : {}));
    m.delete(/\/files\/trash\/\d+$/, {});
    m.delete(`/api/meetings/${CODE}/files/trash`, { purged: 1, skipped: 1 });
    const ev = captureEvents('app:info', 'app:error');
    await mount(m);
    expect(document.querySelector('.cf-desktree-item.side-ic-trash')?.textContent).toContain('휴지통 (2)');
    await userEvent.dblClick(entry('휴지통'));
    await vi.waitFor(() => expect(document.querySelectorAll('.cf-trash-row')).toHaveLength(2));
    const rowNames = () => [...document.querySelectorAll('.cf-trash-row .cf-trash-name')].map((e) => e.textContent);
    expect(rowNames()).toEqual(['지운문서', '옛폴더 (+2)']); // 최근 지운 것부터
    expect(document.querySelector('.cf-crumb-trash')).toBeTruthy();
    // 헤더 버튼은 좁은 컬럼에서 CSS로 접힐 수 있어 DOM 이벤트로 (정렬 로직만 검증)
    fireEvent.click(document.querySelector('.cf-trashhead-row [title="이름으로 정렬"]')!);
    await vi.waitFor(() => expect(rowNames()).toEqual(['옛폴더 (+2)', '지운문서']));
    fireEvent.click(document.querySelector('.cf-trashhead-row [title="이름으로 정렬"]')!);
    await vi.waitFor(() => expect(rowNames()).toEqual(['지운문서', '옛폴더 (+2)']));
    for (const t of ['원래 위치로 정렬', '지운 사람으로 정렬', '크기로 정렬', '항목 유형으로 정렬', '수정한 날짜로 정렬', '지운 날짜로 정렬'])
      fireEvent.click(document.querySelector(`.cf-trashhead-row [title="${t}"]`)!);
    expect(document.querySelector('.cf-trash-loc')?.textContent).toContain('생산1팀');
    // 행 선택 → 세부정보 복원 버튼 / 우클릭 복원
    const row = (name: string) => [...document.querySelectorAll<HTMLElement>('.cf-trash-row')].find((r) => r.textContent?.includes(name))!;
    await userEvent.click(row('옛폴더'));
    await vi.waitFor(() => expect(row('옛폴더')).toHaveClass('selected'));
    fireEvent.contextMenu(row('옛폴더'), { clientX: 300, clientY: 300 });
    await vi.waitFor(() => expect(ctx()).toBeTruthy());
    await userEvent.click(btnStarts('복원', ctx()));
    await vi.waitFor(() => expect(m.calls('POST', /\/trash\/22\/restore$/)).toHaveLength(1));
    await vi.waitFor(() => expect(ev.of('app:info').some((d) => String(d).includes('루트로 복원'))).toBe(true));
    // 영구 삭제 (툴바, confirm)
    await userEvent.click(row('지운문서'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(tool('영구 삭제'));
    expect(m.calls('DELETE', /\/trash\/21$/)).toHaveLength(0);
    confirm.mockReturnValue(true);
    await userEvent.click(tool('영구 삭제'));
    await vi.waitFor(() => expect(m.calls('DELETE', /\/trash\/21$/)).toHaveLength(1));
    // 더 보기 — 모두 복원, 비우기
    await userEvent.click(tool('더 보기'));
    await userEvent.click(btnStarts('모든 항목 복원', document.querySelector('.cf-more-menu')!));
    await vi.waitFor(() => expect(m.calls('POST', /\/trash\/\d+\/restore$/).length).toBeGreaterThanOrEqual(3));
    await userEvent.click(tool('더 보기'));
    await userEvent.click(btnStarts('휴지통 비우기', document.querySelector('.cf-more-menu')!));
    await vi.waitFor(() => expect(m.calls('DELETE', `/api/meetings/${CODE}/files/trash`)).toHaveLength(1));
    await vi.waitFor(() => expect(ev.of('app:info').some((d) => String(d).includes('권한이 없는 1개'))).toBe(true));
    // 휴지통 잘라내기 → 폴더에서 붙여넣기 = 그 폴더로 복원
    await userEvent.click(row('지운문서'));
    await userEvent.click(tool('잘라내기'));
    await vi.waitFor(() => expect(row('지운문서')).toHaveClass('cutting'));
    await userEvent.click(sideFolder('SOP'));
    await vi.waitFor(() => expect(entryNames()).toContain('작업지침'));
    expect(tool('붙여넣기').title).toContain('복원');
    await userEvent.click(tool('붙여넣기'));
    await vi.waitFor(() => expect(m.last('POST', /\/trash\/21\/restore$/)?.body).toEqual({ parentId: 1 }));
    // 휴지통 공유 = 그룹 링크
    await userEvent.click(document.querySelector('.cf-desktree-item.side-ic-trash')!);
    await vi.waitFor(() => expect(document.querySelector('.cf-trash-row')).toBeTruthy());
    await userEvent.click(row('지운문서'));
    await userEvent.click(tool('공유'));
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('/meeting/ABCD')));
    ev.stop();
  });

  it('업로드 — 파일 선택 → XHR POST upload?name=, 진행 토스트, 25MB 초과·빈 파일은 경고', async () => {
    setup(m);
    const xhr = mockXhr();
    const ev = captureEvents('app:error');
    await mount(m);
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await userEvent.click(document.querySelector('.cf-upload')!);
    expect(clickSpy).toHaveBeenCalled();
    const input = document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
    const before = m.calls('GET', `/api/meetings/${CODE}/files`).length;
    setInputFiles(input, [
      new File(['hello'], 'report.txt', { type: 'text/plain' }),
      new File([new Uint8Array(0)], 'empty.bin'),
    ]);
    await vi.waitFor(() => expect(xhr.requests).toHaveLength(1));
    expect(xhr.requests[0].method).toBe('POST');
    expect(xhr.requests[0].url).toBe(`/api/meetings/${CODE}/files/upload?name=report.txt`);
    expect(xhr.requests[0].headers).toMatchObject({ Authorization: 'Bearer test-token', 'Content-Type': 'text/plain' });
    await vi.waitFor(() => expect(m.calls('GET', `/api/meetings/${CODE}/files`).length).toBeGreaterThan(before));
    expect(ev.of('app:error').some((d) => String(d).includes('빈 파일'))).toBe(true);
    await vi.waitFor(() => expect(document.querySelector('.cf-upload-toast')).toBeNull());
    // 실패 응답 → 서버 에러 문구
    xhr.respond = () => ({ status: 413, body: JSON.stringify({ error: '너무 큼' }) });
    setInputFiles(input, [new File(['x'], 'b.txt')]);
    await vi.waitFor(() => expect(ev.of('app:error')).toContain('너무 큼'));
    // 25MB 초과는 보내기 전에 거른다
    setInputFiles(input, [new File([new Uint8Array(26 * 1024 * 1024)], 'big.bin')]);
    await vi.waitFor(() => expect(ev.of('app:error').some((d) => String(d).includes('25MB'))).toBe(true));
    expect(xhr.requests).toHaveLength(2);
    ev.stop();
  });

  it('새 버전 업로드 — POST upload-version → 버전 목록(속성), 구본 다운로드 confirm, 회람 문서는 리셋 경고', async () => {
    setup(m);
    m.post(/\/upload-version$/, {});
    const ev = captureEvents('app:info');
    await mount(m);
    await selectEntry('photo.png');
    await vi.waitFor(() => expect(m.calls('GET', /\/files\/4\/versions$/)).toHaveLength(1));
    await userEvent.click(btnStarts('관리', details()));
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await userEvent.click(btnByText('새 버전 업로드', details()));
    expect(clickSpy).toHaveBeenCalled();
    const vInput = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    setInputFiles(vInput, [new File(['v2'], 'photo.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(m.calls('POST', /\/files\/4\/upload-version$/)).toHaveLength(1));
    expect(m.last('POST', /upload-version/).headers).toMatchObject({ 'Content-Type': 'image/png' });
    await vi.waitFor(() => expect(ev.of('app:info').some((d) => String(d).includes('새 버전을 올렸어요'))).toBe(true));
    // 속성 → 버전 기록·연혁·다룬 회의·미리보기
    await userEvent.click(document.querySelector('.cf-props-btn')!);
    const props = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('.cf-props-modal');
      if (!el) throw new Error('no props');
      return el;
    });
    await vi.waitFor(() => expect(props.querySelectorAll('.cf-version-row')).toHaveLength(2));
    expect(props.querySelector('.cf-version-row .cf-version-no')?.textContent).toBe('v2');
    expect(props.textContent).toContain('1행 미리보기');
    expect(props.textContent).toContain('온도 기준 회의');
    await vi.waitFor(() => expect(props.querySelectorAll('.cf-history-row')).toHaveLength(2));
    expect(props.querySelector('.cf-history-row.cur .cf-history-rev')?.textContent).toBe('v2');
    expect(props.textContent).toContain('개정 사유 · 초안');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const dl = props.querySelector<HTMLAnchorElement>('.cf-version-dl')!;
    const evt = fireEvent.click(dl); // confirm 거절 → preventDefault
    expect(evt).toBe(false);
    confirm.mockReturnValue(true);
    const goto = captureEvents('exist:goto-recap');
    await userEvent.click(props.querySelector('.cf-history-basis')!);
    expect(goto.of('exist:goto-recap')[0]).toEqual({ code: CODE, recapId: 3 });
    await vi.waitFor(() => expect(document.querySelector('.cf-props-modal')).toBeNull());
    goto.stop();
    // 다룬 회의 클릭도 원장 점프
    await userEvent.click(document.querySelector('.cf-props-btn')!);
    await vi.waitFor(() => expect(document.querySelector('.cf-filemeet-row')).toBeTruthy());
    await userEvent.click(document.querySelector('.cf-filemeet-row')!);
    await vi.waitFor(() => expect(document.querySelector('.cf-props-modal')).toBeNull());
    ev.stop();
  });

  it('회람 — 세부정보 서명 현황(미확인·서명자 칩·근거 결정), 서명 요청/해제, 미서명자 리마인드', async () => {
    setup(m);
    m.post(/\/ack-request$/, {});
    m.post(/\/ack-remind$/, { reminded: 2 });
    const ev = captureEvents('app:info', 'exist:goto-recap');
    await mount(m);
    await userEvent.dblClick(entry('SOP'));
    await vi.waitFor(() => expect(entryNames()).toContain('작업지침'));
    await selectEntry('작업지침');
    await vi.waitFor(() => expect(details().textContent).toContain('1/3'));
    expect(details().textContent).toContain('63도 기준으로 수정');
    expect(details().querySelectorAll('.cf-ack-pend')).toHaveLength(2);
    expect(details().textContent).toContain('김대리');
    await userEvent.click(details().querySelector('.cf-ack-basis')!);
    expect(ev.of('exist:goto-recap')[0]).toEqual({ code: CODE, recapId: 3 });
    await userEvent.click(btnStarts('서명자 1명', details()));
    await vi.waitFor(() => expect(details().querySelector('.cf-ack-chip img')).toBeTruthy());
    expect(details().textContent).toContain('이과장');
    await userEvent.click(btnByText('미서명자 리마인드', details()));
    await vi.waitFor(() => expect(m.calls('POST', /\/files\/3\/ack-remind$/)).toHaveLength(1));
    expect(ev.of('app:info').some((d) => String(d).includes('2명에게 리마인드'))).toBe(true);
    // 관리 → 서명 요청 해제
    await userEvent.click(btnStarts('관리', details()));
    await userEvent.click(btnByText('서명 요청 해제', details()));
    await vi.waitFor(() => expect(m.last('POST', /\/files\/3\/ack-request$/)?.body).toEqual({ on: false }));
    // 서명 없는 파일 → 요청
    await userEvent.click(document.querySelector('[title="상위 폴더"]')!);
    await vi.waitFor(() => expect(entryNames()).toContain('온도표'));
    await selectEntry('온도표');
    await userEvent.click(btnStarts('관리', details()));
    await userEvent.click(btnStarts('열람 서명 요청', details()));
    await vi.waitFor(() => expect(m.last('POST', /\/files\/2\/ack-request$/)?.body).toEqual({ on: true }));
    expect(ev.of('app:info').some((d) => String(d).includes('열람 서명을 요청했어요'))).toBe(true);
    // 전원 완료 문서
    await selectEntry('회의록');
    await vi.waitFor(() => expect(details().textContent).toContain('내 서명 완료'));
    ev.stop();
  });

  it('서명 — 열람 화면 배너 → 모달(개정 요약) → 진짜 캔버스에 그리기 → POST ack(PNG data URL), 낙관 반영', async () => {
    // 서명 후 재조회가 낙관 반영을 덮지 않게 — 서버처럼 목록도 갱신
    const list = FILES.map((f) => ({ ...f }));
    setup(m, list);
    m.post(/\/files\/3\/ack$/, () => {
      const f = list.find((x) => x.id === 3)!;
      f.my_ack = 1;
      f.ack_count = 2;
      return {};
    });
    await mount(m);
    await userEvent.dblClick(entry('SOP'));
    await vi.waitFor(() => expect(entryNames()).toContain('작업지침'));
    await userEvent.dblClick(entry('작업지침'));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="doc-editor"]')).toBeTruthy());
    expect(document.querySelector('.cf-rev-badge')?.textContent).toBe('개정 v2');
    expect(document.querySelector('.cf-ackbar')?.textContent).toContain('열람 확인이 필요해요');
    await userEvent.click(btnByText('서명하기', document.querySelector('.cf-ackbar')!));
    const modal = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('.cf-signmodal');
      if (!el) throw new Error('no sign modal');
      return el;
    });
    await vi.waitFor(() => expect(modal.querySelector('.cf-signmodal-note')?.textContent).toContain('63도 기준으로 수정'));
    const done = () => btnByText('서명 완료', modal);
    expect(done()).toBeDisabled();
    const canvas = modal.querySelector<HTMLCanvasElement>('canvas.ho-sign-canvas')!;
    const r = canvas.getBoundingClientRect();
    expect(r.width).toBeGreaterThan(200);
    fireEvent.pointerDown(canvas, { clientX: r.left + 10, clientY: r.top + 20, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(canvas, { clientX: r.left + 80, clientY: r.top + 60, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(canvas, { clientX: r.left + 150, clientY: r.top + 30, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    await vi.waitFor(() => expect(done()).not.toBeDisabled());
    // 다시 쓰기 → 비활성 → 다시 그리기
    await userEvent.click(btnByText('다시 쓰기', modal));
    expect(done()).toBeDisabled();
    fireEvent.pointerDown(canvas, { clientX: r.left + 10, clientY: r.top + 20, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(canvas, { clientX: r.left + 90, clientY: r.top + 70, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    await vi.waitFor(() => expect(done()).not.toBeDisabled());
    await userEvent.click(done());
    await vi.waitFor(() => expect(m.calls('POST', /\/files\/3\/ack$/)).toHaveLength(1));
    const sig = (m.last('POST', /\/ack$/).body as { signature: string }).signature;
    expect(sig).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(sig.length).toBeGreaterThan(200);
    await vi.waitFor(() => expect(document.querySelector('.cf-ackbar.done')?.textContent).toContain('열람 확인 서명 완료'));
    expect(document.querySelector('.cf-signmodal')).toBeNull();
    // 취소 경로 (다른 미서명 문서는 없으니 배너가 없어야 함)
    expect(document.querySelector('.cf-ackbar button')).toBeNull();
  });

  it('개정 발행 — 근거 결정 선택/기타 사유 → POST revise, 서명 리셋 토스트, 취소', async () => {
    setup(m);
    m.post(/\/revise$/, { rev: 3 });
    const ev = captureEvents('app:info');
    await mount(m);
    await userEvent.dblClick(entry('SOP'));
    await vi.waitFor(() => expect(entryNames()).toContain('작업지침'));
    const menu = await openCtx('작업지침');
    await userEvent.click(btnByText('개정 발행 (재회람)', menu));
    const modal = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('.cf-revise-modal');
      if (!el) throw new Error('no revise modal');
      return el;
    });
    expect(modal.textContent).toContain('개정 v3 발행');
    expect(modal.textContent).toContain('전원 서명이 리셋돼요');
    await vi.waitFor(() => expect(modal.querySelectorAll('.cf-revise-opt')).toHaveLength(4)); // 없음 + 결정 2 + 기타
    await userEvent.click(modal.querySelectorAll<HTMLInputElement>('.cf-revise-opt input')[1]);
    await userEvent.click(modal.querySelector('.cf-revise-go')!);
    await vi.waitFor(() => expect(m.last('POST', /\/files\/3\/revise$/)?.body).toEqual({ basisRecapId: 3, basisDecisionIdx: 0 }));
    expect(ev.of('app:info').some((d) => String(d).includes('개정 v3을 발행했어요 — 전원 서명이 리셋됐어요'))).toBe(true);
    // 기타 사유
    const menu2 = await openCtx('작업지침');
    await userEvent.click(btnByText('개정 발행 (재회람)', menu2));
    await vi.waitFor(() => expect(document.querySelector('.cf-revise-modal')).toBeTruthy());
    await userEvent.click(document.querySelectorAll<HTMLInputElement>('.cf-revise-opt input')[3]);
    await userEvent.fill(document.querySelector<HTMLInputElement>('.cf-revise-note')!, '오타 수정');
    await userEvent.click(document.querySelector('.cf-revise-go')!);
    await vi.waitFor(() => expect(m.last('POST', /\/files\/3\/revise$/)?.body).toEqual({ basisNote: '오타 수정' }));
    // 근거 없음 + 세부정보의 관리 버튼 경로, 취소
    await selectEntry('작업지침');
    await userEvent.click(btnStarts('관리', details()));
    await userEvent.click(btnStarts('개정 발행', details()));
    await vi.waitFor(() => expect(document.querySelector('.cf-revise-modal')).toBeTruthy());
    await userEvent.click(document.querySelector('.cf-revise-cancel')!);
    await vi.waitFor(() => expect(document.querySelector('.cf-revise-modal')).toBeNull());
    await userEvent.click(btnStarts('개정 발행', details()));
    await vi.waitFor(() => expect(document.querySelector('.cf-revise-modal')).toBeTruthy());
    await userEvent.click(document.querySelector('.cf-revise-go')!);
    await vi.waitFor(() => expect(m.last('POST', /\/files\/3\/revise$/)?.body).toEqual({}));
    // 속성 창이 열린 채 files:changed 푸시 → 연혁 재로드
    await userEvent.click(document.querySelector('.cf-props-btn')!);
    await vi.waitFor(() => expect(m.calls('GET', /\/files\/3\/history$/)).toHaveLength(1));
    fakeSocket.trigger('files:changed', { code: CODE });
    await vi.waitFor(() => expect(m.calls('GET', /\/files\/3\/history$/)).toHaveLength(2));
    ev.stop();
  });

  it('공유 모달 — 채널·사람·다른 그룹 토글 → 보내기(share-channel/dm/distribute), 실패 집계, 링크 복사, 폴더 배포 불가', async () => {
    setup(m);
    m.post(/\/share-channel$/, {});
    m.post(/\/dm$/, {});
    m.post(/\/distribute$/, {});
    const ev = captureEvents('app:info', 'app:error');
    await mount(m);
    const menu = await openCtx('온도표');
    await userEvent.click(btnByText('공유', menu));
    const modal = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('.cf-share-modal');
      if (!el) throw new Error('no share modal');
      return el;
    });
    expect(modal.querySelector('.cf-share-sendsum')?.textContent).toBe('보낼 곳을 골라주세요');
    expect(modal.querySelector<HTMLButtonElement>('.cf-share-send')).toBeDisabled();
    await vi.waitFor(() => expect(modal.querySelectorAll('.cf-share-body button')).toHaveLength(2));
    await userEvent.click(btnStarts('# 일반', modal) ?? modal.querySelectorAll('.cf-share-body button')[0]);
    await userEvent.click(btnByText('사람', modal.querySelector('.cf-share-tabs')!));
    await vi.waitFor(() => expect(modal.querySelector('.cf-share-body')?.textContent).toContain('김대리'));
    await userEvent.click(modal.querySelector('.cf-share-body button')!);
    await userEvent.click(btnByText('다른 그룹', modal.querySelector('.cf-share-tabs')!));
    await vi.waitFor(() => expect(modal.querySelector('.cf-share-body')?.textContent).toContain('품질팀'));
    await userEvent.click(modal.querySelector('.cf-share-body button')!);
    expect(modal.querySelector('.cf-share-sendsum')?.textContent).toBe('채널 1 · 사람 1 · 그룹 1 선택');
    const ack = modal.querySelector<HTMLInputElement>('.cf-share-ack input')!;
    expect(ack.checked).toBe(true);
    await userEvent.click(ack);
    await userEvent.click(modal.querySelector('.cf-share-send')!);
    await vi.waitFor(() => expect(document.querySelector('.cf-share-modal')).toBeNull());
    expect(m.last('POST', /\/files\/2\/share-channel$/).body).toEqual({ channelId: 1 });
    expect(m.last('POST', /\/files\/2\/dm$/).body).toEqual({ userId: 2 });
    expect(m.last('POST', /\/files\/2\/distribute$/).body).toEqual({ targetCode: 'ZZZZ', requestAck: false });
    expect(ev.of('app:info').some((d) => String(d).includes('채널 1곳 · 1명 · 그룹 1곳에 공유했어요'))).toBe(true);
    // 실패 집계 — 모달 유지
    m.fail('POST', /\/dm$/, 500);
    await selectEntry('온도표');
    await userEvent.click(tool('공유'));
    await vi.waitFor(() => expect(document.querySelector('.cf-share-modal')).toBeTruthy());
    await userEvent.click(btnByText('사람', document.querySelector('.cf-share-tabs')!));
    await vi.waitFor(() => expect(document.querySelector('.cf-share-body')?.textContent).toContain('김대리'));
    await userEvent.click(document.querySelector('.cf-share-body button')!);
    await userEvent.click(document.querySelector('.cf-share-send')!);
    await vi.waitFor(() => expect(ev.of('app:error').some((d) => String(d).includes('1건 실패'))).toBe(true));
    expect(document.querySelector('.cf-share-modal')).toBeTruthy();
    // 링크 복사
    await userEvent.click(btnByText('링크 복사', document.querySelector('.cf-share-modal')!));
    await vi.waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(`/?g=${CODE}&file=2`)),
    );
    expect(ev.of('app:info').some((d) => String(d).includes('파일 링크를 복사했어요'))).toBe(true);
    await userEvent.click(document.querySelector('.cf-share-x')!);
    await vi.waitFor(() => expect(document.querySelector('.cf-share-modal')).toBeNull());
    // 폴더 → 다른 그룹 탭은 배포 불가 안내
    const menu2 = await openCtx('SOP');
    await userEvent.click(btnByText('공유', menu2));
    await vi.waitFor(() => expect(document.querySelector('.cf-share-modal')).toBeTruthy());
    await userEvent.click(btnByText('다른 그룹', document.querySelector('.cf-share-tabs')!));
    expect(document.querySelector('.cf-share-body')?.textContent).toContain('폴더는 다른 그룹으로 배포할 수 없어요');
    fireEvent.click(document.querySelector('.cf-move-overlay')!);
    await vi.waitFor(() => expect(document.querySelector('.cf-share-modal')).toBeNull());
    ev.stop();
  });

  it('미리보기 — 이미지·PDF·영상·음성·텍스트·hwpx(진짜 zip 파싱·A4 분할)·hwp 실패·docx는 다운로드 폴백', async () => {
    setup(m);
    m.get(/\/files\/7\/download/, 'hello text preview');
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('mimetype', 'application/hwp+zip');
    zip.file(
      'Contents/section0.xml',
      `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p><hp:run><hp:t>품의서 본문 문단</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>둘째 문단</hp:t></hp:run></hp:p></hs:sec>`,
    );
    m.get(/\/files\/8\/download/, await zip.generateAsync({ type: 'uint8array' }));
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    m.get(/\/files\/9\/download/, ole);
    const dl = captureDownloads();
    await mount(m);
    const open = async (name: string) => {
      await userEvent.dblClick(entry(name));
      await vi.waitFor(() => expect(document.querySelector('.cf-editor-name')?.textContent).toBe(name));
    };
    const back = async () => {
      await userEvent.click(document.querySelector('.cf-back')!);
      await vi.waitFor(() => expect(document.querySelector('.cf-editor-bar')).toBeNull());
    };
    await open('photo.png');
    expect(host().querySelector('.cf-viewer-body.image img')?.getAttribute('src')).toContain('/files/4/download?token=test-token');
    expect(host().querySelector('.cf-viewer-dl')?.getAttribute('download')).toBe('photo.png');
    expect(fakeSocket.emittedOf('file:viewing').at(-1)?.args[0]).toEqual({ code: CODE, fileId: 4 });
    await back();
    expect(fakeSocket.emittedOf('file:viewing').at(-1)?.args[0]).toEqual({ code: CODE, fileId: null });
    await open('spec.pdf');
    expect(host().querySelector('.cf-viewer-body.pdf iframe')).toBeTruthy();
    expect(host().querySelector('.cf-blobview-bar')).toBeNull();
    await back();
    await open('clip.mp4');
    expect(host().querySelector('.cf-viewer-body.video video')).toBeTruthy();
    await back();
    await open('song.mp3');
    expect(host().querySelector('.cf-viewer-body.audio audio')).toBeTruthy();
    await back();
    await open('notes.txt');
    await vi.waitFor(() => expect(host().querySelector('.cf-viewer-text')?.textContent).toBe('hello text preview'));
    await back();
    await open('품의서.hwpx');
    await vi.waitFor(() => expect(host().querySelector('.cf-hwpx-page')).toBeTruthy(), { timeout: 5000 });
    expect(host().querySelector('.cf-hwpx-page')?.textContent).toContain('품의서 본문 문단');
    expect(host().querySelector('.cf-hwpx-pageno')?.textContent?.replace(/\s/g, '')).toMatch(/^1\/\d+$/);
    await back();
    await open('old.hwp');
    await vi.waitFor(() => expect(host().querySelector('.cf-viewer-loading')?.textContent).toContain('내용을 추출하지 못했어요'), {
      timeout: 5000,
    });
    await back();
    // 미지원 형식 → window.open(스텁이 null) → 앵커 다운로드 폴백, 화면은 안 바뀜
    await userEvent.dblClick(entry('report.docx'));
    await vi.waitFor(() => expect(window.open).toHaveBeenCalledWith(expect.stringContaining('/files/10/download'), '_blank'));
    expect(dl.last()?.name).toBe('report.docx');
    expect(document.querySelector('.cf-editor-bar')).toBeNull();
    // 여러 에디터 동시 마운트 유지 + 전체화면 토글 + Esc
    await open('스크립트');
    expect(host().querySelector('[data-testid="code-editor"]')?.textContent).toBe('code-13');
    await userEvent.click(document.querySelector('.cf-fullscreen')!);
    await vi.waitFor(() => expect(document.querySelector('.cf-editor')).toHaveClass('full'));
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(document.querySelector('.cf-editor')).not.toHaveClass('full'));
    await back();
    await open('보드');
    expect(host().querySelector('[data-testid="canvas-board"]')?.textContent).toBe('canvas-14');
    expect(document.querySelector('[data-testid="code-editor"]')).toBeTruthy(); // 마운트 유지
  });

  it('검색(이름+내용 히트)·정렬·보기(목록/아이콘·탐색 창)·필터·세부정보 토글·경로 직접 입력', async () => {
    setup(m);
    const ev = captureEvents('app:error');
    await mount(m);
    const search = document.querySelector<HTMLInputElement>('.cf-nav input[placeholder$="검색"]')!;
    await userEvent.fill(search, 'temperature');
    await vi.waitFor(() => expect(m.calls('GET', /\/files\/search\/content\?q=temperature/)).toHaveLength(1), { timeout: 3000 });
    await vi.waitFor(() => expect(document.querySelector('.cf-contenthit b')?.textContent).toBe('온도표'));
    expect(document.querySelector('.cf-contenthit-snip')?.textContent).toContain('temperature log');
    expect(document.querySelector('.cf-empty')?.textContent).toContain('검색 결과가 없어요');
    await userEvent.click(document.querySelector('.cf-contenthit')!);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="sheet-editor"]')).toBeTruthy());
    await userEvent.click(document.querySelector('.cf-back')!);
    await userEvent.fill(search, '지침');
    await vi.waitFor(() => expect(entryNames()).toEqual(['작업지침'])); // 하위 폴더까지 검색
    await userEvent.fill(search, '');
    await vi.waitFor(() => expect(entryNames()).toContain('온도표'));
    // 정렬 메뉴
    await userEvent.click(btnStarts('정렬'));
    await userEvent.click(btnByText('수정한 날짜', document.querySelector('.cf-type-menu')!));
    await userEvent.click(btnStarts('정렬'));
    await userEvent.click(btnByText('내림차순', document.querySelector('.cf-type-menu')!));
    await vi.waitFor(() => expect(entryNames().filter((n) => n !== '홈' && n !== '휴지통' && n !== 'SOP')[0]).toBe('온도표'));
    await userEvent.click(btnStarts('정렬'));
    await userEvent.click(btnByText('오름차순', document.querySelector('.cf-type-menu')!));
    await userEvent.click(btnStarts('정렬'));
    await userEvent.click(btnByText('이름', document.querySelector('.cf-type-menu')!));
    // 보기 → 목록 + 헤더 정렬 클릭 + 컬럼 폭 드래그/더블클릭 복원
    await userEvent.click(btnStarts('보기'));
    await userEvent.click(btnStarts('목록', document.querySelector('.cf-type-menu')!));
    await vi.waitFor(() => expect(document.querySelector('.cf-main')).toHaveClass('list'));
    expect(localStorage.getItem('exist:cf-view')).toBe('list');
    fireEvent.click(document.querySelector('.cf-listhead [title="크기로 정렬"]')!); // 좁은 컬럼은 CSS로 접힐 수 있어 DOM 이벤트로
    fireEvent.click(document.querySelector('.cf-listhead [title="유형으로 정렬"]')!); // 좁은 컬럼은 CSS로 접힐 수 있어 DOM 이벤트로
    fireEvent.click(document.querySelector('.cf-listhead [title="만든 사람으로 정렬"]')!); // 좁은 컬럼은 CSS로 접힐 수 있어 DOM 이벤트로
    fireEvent.click(document.querySelector('.cf-listhead [title="확인으로 정렬 — 미확인 많은 순"]')!); // 좁은 컬럼은 CSS로 접힐 수 있어 DOM 이벤트로
    fireEvent.click(document.querySelector('.cf-listhead [title="이름으로 정렬"]')!); // 좁은 컬럼은 CSS로 접힐 수 있어 DOM 이벤트로
    const handle = document.querySelector('.cf-listhead .cf-colresize')!;
    const hr = handle.getBoundingClientRect();
    fireEvent.pointerDown(handle, { clientX: hr.left, clientY: hr.top, pointerId: 1, button: 0, buttons: 1 });
    fireEvent.pointerMove(window, { clientX: hr.left + 43, clientY: hr.top, pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(window, { clientX: hr.left + 43, clientY: hr.top, pointerId: 1 });
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem('exist:cf-colw') ?? '{}')).toEqual({ name: 444 }));
    expect((document.querySelector('.cf-explorer') as HTMLElement).style.getPropertyValue('--cf-col-name')).toBe('444px');
    await userEvent.dblClick(document.querySelector('.cf-listhead .cf-colresize')!);
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem('exist:cf-colw') ?? '{}')).toEqual({}));
    await userEvent.click(btnStarts('보기'));
    await userEvent.click(btnStarts('아이콘', document.querySelector('.cf-type-menu')!));
    await vi.waitFor(() => expect(document.querySelector('.cf-main')).toHaveClass('grid'));
    await userEvent.click(btnStarts('보기'));
    await userEvent.click(btnStarts('탐색 창', document.querySelector('.cf-type-menu')!));
    await vi.waitFor(() => expect(document.querySelector('.cf-slide-l')).not.toHaveClass('open'));
    expect(localStorage.getItem('exist:cf-tree')).toBe('0');
    // 필터
    await userEvent.click(btnStarts('필터'));
    await userEvent.click(btnStarts('시트', document.querySelector('.cf-more-menu')!));
    await vi.waitFor(() => expect(entryNames()).toEqual(['홈', '휴지통', 'SOP', '온도표']));
    await userEvent.click(btnStarts('필터'));
    await userEvent.click(btnStarts('전체', document.querySelector('.cf-more-menu')!));
    await vi.waitFor(() => expect(entryNames()).toContain('photo.png'));
    // 세부정보 창 끄기/켜기
    await userEvent.click(document.querySelector('[title="세부 정보 창 켜기/끄기"]')!);
    expect(localStorage.getItem('exist:cf-details')).toBe('0');
    await userEvent.click(document.querySelector('[title="세부 정보 창 켜기/끄기"]')!);
    // 경로 직접 입력
    const path = document.querySelector<HTMLElement>('.cf-path')!;
    const pr = path.getBoundingClientRect();
    fireEvent.click(path, { clientX: pr.right - 4, clientY: pr.top + pr.height / 2 });
    const pinput = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('.cf-path-input');
      if (!el) throw new Error('no path input');
      return el;
    });
    expect(pinput.value).toBe('생산1팀');
    await userEvent.fill(pinput, '생산1팀/없는폴더');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(ev.of('app:error').some((d) => String(d).includes('"없는폴더" 폴더를 찾을 수 없어요'))).toBe(true));
    await userEvent.fill(pinput, 'sop');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(entryNames()).toContain('작업지침'));
    fireEvent.click(document.querySelector('.cf-path')!, { clientX: pr.right - 4, clientY: pr.top + pr.height / 2 });
    await userEvent.fill(document.querySelector<HTMLInputElement>('.cf-path-input')!, '휴지통');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(document.querySelector('.cf-crumb-trash')).toBeTruthy());
    fireEvent.click(document.querySelector('.cf-path')!, { clientX: pr.right - 4, clientY: pr.top + pr.height / 2 });
    await userEvent.fill(document.querySelector<HTMLInputElement>('.cf-path-input')!, '홈');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(document.querySelector('.cf-crumb-home')).toBeTruthy());
    fireEvent.click(document.querySelector('.cf-path')!, { clientX: pr.right - 4, clientY: pr.top + pr.height / 2 });
    await userEvent.fill(document.querySelector<HTMLInputElement>('.cf-path-input')!, '확인 필요');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(document.querySelector('.cf-path')?.textContent).toContain('확인 필요'));
    fireEvent.click(document.querySelector('.cf-path')!, { clientX: pr.right - 4, clientY: pr.top + pr.height / 2 });
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(document.querySelector('.cf-path-input')).toBeNull());
    ev.stop();
  });

  it('키보드 탐색(방향키·타이핑 점프·Enter)·러버밴드 박스 선택·이름 재클릭 인라인 편집', async () => {
    setup(m);
    await mount(m);
    await userEvent.click(document.querySelector('.cf-statusbar')!);
    (document.querySelector('.cf-explorer') as HTMLElement).focus();
    await userEvent.keyboard('{ArrowRight}');
    await vi.waitFor(() => expect(selectedNames()).toHaveLength(1));
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowUp}');
    await userEvent.keyboard('{ArrowLeft}');
    await vi.waitFor(() => expect(selectedNames()).toHaveLength(1));
    await userEvent.keyboard('ph');
    await vi.waitFor(() => expect(selectedNames()).toEqual(['photo.png']));
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(document.querySelector('.cf-editor-name')?.textContent).toBe('photo.png'));
    await userEvent.click(document.querySelector('.cf-back')!);
    await vi.waitFor(() => expect(document.querySelector('.cf-editor-bar')).toBeNull());
    // 러버밴드 — 첫 두 엔트리를 덮는 박스
    const main = document.querySelector<HTMLElement>('.cf-main')!;
    const a = entry('SOP').getBoundingClientRect();
    const b = entry('온도표').getBoundingClientRect();
    const x0 = Math.max(a.right, b.right) + 4;
    const y0 = Math.max(a.bottom, b.bottom) + 4;
    fireEvent.pointerDown(main, { clientX: x0, clientY: y0, pointerId: 1, button: 0, buttons: 1 });
    fireEvent.pointerMove(main, { clientX: x0 - 20, clientY: y0 - 20, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(main, { clientX: Math.min(a.left, b.left) - 4, clientY: Math.min(a.top, b.top) - 4, pointerId: 1, buttons: 1 });
    await vi.waitFor(() => expect(document.querySelector('.cf-rubber')).toBeTruthy());
    fireEvent.pointerUp(main, { pointerId: 1 });
    await vi.waitFor(() => expect(selectedNames()).toEqual(expect.arrayContaining(['SOP', '온도표'])));
    expect(document.querySelector('.cf-statusbar')?.textContent).toContain('선택');
    // 선택된 항목 이름 재클릭 → 450ms 뒤 인라인 편집
    await selectEntry('온도표');
    await userEvent.click(entry('온도표').querySelector('.cf-entry-name')!);
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('.cf-main .cf-name-input')?.value).toBe('온도표'), { timeout: 2000 });
    await userEvent.keyboard('{Escape}');
    fireEvent.focusOut(document.querySelector('.cf-main .cf-name-input')!);
    await vi.waitFor(() => expect(document.querySelector('.cf-main .cf-name-input')).toBeNull());
  });

  it('홈 — 최근/확인 필요 탭·고정 토글·확인 필요 뷰, 딥링크 exist:open-file-now, files:changed·presence 푸시', async () => {
    setup(m);
    await mount(m);
    expect(document.querySelector('.cf-presence')).toBeTruthy(); // 온도표 편집 중인 김대리
    await userEvent.dblClick(entry('홈'));
    await vi.waitFor(() => expect(document.querySelector('.cf-home-tabs')).toBeTruthy());
    expect(document.querySelector('.cf-home-tab.on')?.textContent).toContain('확인 필요'); // 미서명 문서가 있으니 스마트 기본
    expect(document.querySelector('.cf-home-row-name')?.textContent).toBe('작업지침');
    await userEvent.click([...document.querySelectorAll<HTMLElement>('.cf-home-tab')].find((t) => t.textContent?.includes('최근'))!);
    await vi.waitFor(() => expect(document.querySelector('.cf-home-row-name')?.textContent).toBe('온도표'));
    await userEvent.click([...document.querySelectorAll<HTMLElement>('.cf-home-tab')].find((t) => t.textContent?.includes('작업 중'))!);
    await userEvent.click(document.querySelector('[title="상위 폴더"]')!);
    await vi.waitFor(() => expect(entryNames()).toContain('온도표'));
    // 고정
    const menu = await openCtx('설계.slide');
    await userEvent.click(btnByText('고정', menu));
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(`exist:cf-fav:${CODE}`) ?? '[]')).toEqual([5]));
    await userEvent.dblClick(entry('홈'));
    await vi.waitFor(() => expect(document.querySelector('.cf-home-pins')?.textContent).toContain('설계.slide'));
    await userEvent.click(document.querySelector('[title="뒤로"]')!);
    const menu2 = await openCtx('설계.slide');
    await userEvent.click(btnByText('고정 해제', menu2));
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(`exist:cf-fav:${CODE}`) ?? '[]')).toEqual([]));
    // 확인 필요 뷰 (사이드바)
    const ackItem = [...document.querySelectorAll<HTMLElement>('.cf-desktree-item')].find((e) => e.textContent?.includes('확인 필요'));
    if (ackItem) {
      await userEvent.click(ackItem);
      await vi.waitFor(() => expect(document.querySelector('.cf-path')?.textContent).toContain('확인 필요'));
      await userEvent.click(document.querySelector('.cf-home-row')!);
      await vi.waitFor(() => expect(document.querySelector('[data-testid="doc-editor"]')).toBeTruthy());
      await userEvent.click(document.querySelector('.cf-back')!);
    }
    // 딥링크
    window.dispatchEvent(new CustomEvent('exist:open-file-now', { detail: { code: CODE, fileId: 2 } }));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="sheet-editor"]')).toBeTruthy());
    await userEvent.click(document.querySelector('.cf-back')!);
    window.dispatchEvent(new CustomEvent('exist:open-file-now', { detail: { code: CODE, fileId: 1 } }));
    await vi.waitFor(() => expect(entryNames()).toContain('작업지침'));
    // 소켓 푸시
    const nf = m.calls('GET', `/api/meetings/${CODE}/files`).length;
    const np = m.calls('GET', `/api/meetings/${CODE}/files/presence`).length;
    fakeSocket.trigger('files:changed', { code: 'OTHER' });
    fakeSocket.trigger('files:changed', { code: CODE });
    fakeSocket.trigger('files:presence', { code: CODE });
    await vi.waitFor(() => expect(m.calls('GET', `/api/meetings/${CODE}/files`).length).toBe(nf + 1));
    await vi.waitFor(() => expect(m.calls('GET', `/api/meetings/${CODE}/files/presence`).length).toBe(np + 1));
    await tick(10);
  });
});
