import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockApi } from '../../test/mockApi';
import { login } from '../../test/auth';
import { captureEvents } from '../../test/render';
import { useNameStore } from '../../names';

vi.mock('../../lib/socket', () => import('../../test/socket.mock'));
// 에디터는 전부 스텁 — 파일시스템(목록·탐색·생성·서명) 배선만 검증
vi.mock('../CodeDocEditor', () => ({ default: ({ roomId }: { roomId: string }) => <div data-testid="code-editor">{roomId}</div> }));
vi.mock('../DocEditor', () => ({ default: ({ roomId }: { roomId: string }) => <div data-testid="doc-editor">{roomId}</div> }));
vi.mock('../SheetEditor', () => ({ default: ({ roomId }: { roomId: string }) => <div data-testid="sheet-editor">{roomId}</div> }));
vi.mock('../SlideEditor', () => ({ default: ({ roomId }: { roomId: string }) => <div data-testid="slide-editor">{roomId}</div> }));
vi.mock('../CanvasBoard', () => ({ default: ({ roomId }: { roomId: string }) => <div data-testid="canvas-board">{roomId}</div> }));

import { fakeSocket } from '../../test/socket.mock';
import CollabFiles from '../CollabFiles';

const CODE = 'ABCD';
const files = [
  { id: 1, parent_id: null, name: 'SOP', type: 'folder', room: null, author: 'juho', created_at: '2026-08-01 00:00:00' },
  { id: 2, parent_id: null, name: '온도표', type: 'sheet', room: 'sheet-2', author: 'kim', created_at: '2026-08-02 00:00:00', updated_at: '2026-08-20 00:00:00' },
  { id: 3, parent_id: 1, name: '작업지침', type: 'doc', room: 'doc-3', author: 'kim', created_at: '2026-08-03 00:00:00', ack_required: 1, ack_count: 1, my_ack: 0, ack_total: 3, rev: 2 },
  { id: 4, parent_id: null, name: 'photo.png', type: 'file', room: null, author: 'kim', created_at: '2026-08-04 00:00:00', mime: 'image/png', size: 12345 },
  { id: 5, parent_id: null, name: '설계.slide', type: 'slide', room: 'slide-5', author: 'juho', created_at: '2026-08-05 00:00:00' },
];

function setup(m: ReturnType<typeof mockApi>, list = files) {
  m.get(`/api/meetings/${CODE}/files`, list);
  m.get(`/api/meetings/${CODE}/files/trash/list`, []);
  m.get(`/api/meetings/${CODE}/files/recent/list`, [{ id: 2, name: '온도표', type: 'sheet', last_ts: '2026-08-20 00:00:00' }]);
  m.get(`/api/meetings/${CODE}/files/presence`, { 2: [{ username: 'kim', avatar: null }] });
  m.get(`/api/meetings/${CODE}/decisions`, []);
  m.get(/\/files\/\d+\/acks$/, {
    required: true,
    total: 3,
    acks: [{ username: 'lee', ack_at: '2026-08-10 00:00:00', signature: null }],
    pending: [{ username: 'juho', avatar: null }, { username: 'kim', avatar: null }],
    rev: 2,
    note: '63도 기준으로 수정',
    basis: null,
  });
  m.get(/\/files\/\d+\/history$/, []);
}

const entryNames = () => [...document.querySelectorAll('.cf-entry .cf-entry-name')].map((e) => e.textContent);

describe('CollabFiles', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    fakeSocket.reset();
    login({ id: 1, username: 'juho' });
    useNameStore.setState({ map: { kim: '김대리', juho: '이주호' } });
  });

  it('루트 목록 — 홈·휴지통 시스템 항목 + 파일·폴더, 서명 필요 표시', async () => {
    setup(m);
    render(<CollabFiles code={CODE} isHost groupName="생산1팀" />);
    await waitFor(() => expect(entryNames()).toContain('온도표'));
    expect(entryNames()).toEqual(expect.arrayContaining(['홈', '휴지통', 'SOP', '온도표', 'photo.png', '설계.slide']));
    expect(entryNames()).not.toContain('작업지침'); // 폴더 안
    expect(m.calls('GET', `/api/meetings/${CODE}/files`)).toHaveLength(1);
    expect(screen.getAllByText('생산1팀').length).toBeGreaterThan(0);
  });

  it('폴더 더블클릭 → 안으로, 상위 폴더/뒤로 내비게이션', async () => {
    setup(m);
    render(<CollabFiles code={CODE} isHost />);
    await waitFor(() => expect(entryNames()).toContain('SOP'));
    const sop = screen.getByText('SOP', { selector: '.cf-entry-name' }).closest('.cf-entry')!;
    fireEvent.doubleClick(sop);
    await waitFor(() => expect(entryNames()).toContain('작업지침'));
    expect(entryNames()).not.toContain('온도표');
    expect(document.querySelector('.cf-path')?.textContent).toContain('SOP');
    fireEvent.click(screen.getByTitle('상위 폴더'));
    await waitFor(() => expect(entryNames()).toContain('온도표'));
    expect(screen.getByTitle('앞으로')).toBeDisabled(); // 상위 이동은 새 탐색 — 앞으로 스택 초기화
    fireEvent.click(screen.getByTitle('뒤로'));
    await waitFor(() => expect(entryNames()).toContain('작업지침'));
    fireEvent.click(screen.getByTitle('앞으로'));
    await waitFor(() => expect(entryNames()).toContain('온도표'));
    expect(screen.getByTitle('앞으로')).toBeDisabled();
  });

  it('파일 더블클릭 → 해당 에디터 마운트(유지), 닫으면 목록 재조회', async () => {
    setup(m);
    render(<CollabFiles code={CODE} isHost />);
    await waitFor(() => expect(entryNames()).toContain('온도표'));
    fireEvent.doubleClick(screen.getByText('온도표', { selector: '.cf-entry-name' }).closest('.cf-entry')!);
    expect(await screen.findByTestId('sheet-editor')).toHaveTextContent('sheet-2');
    fireEvent.doubleClick(screen.getByText('설계.slide', { selector: '.cf-entry-name' }).closest('.cf-entry')!);
    expect(await screen.findByTestId('slide-editor')).toHaveTextContent('slide-5');
    expect(screen.getByTestId('sheet-editor')).toBeInTheDocument(); // 한 번 연 파일은 마운트 유지
  });

  it('새로 만들기(컨텍스트 메뉴) → 이름 입력 → POST → 문서는 바로 열림', async () => {
    setup(m);
    m.post(`/api/meetings/${CODE}/files`, ({ body }: { body: unknown }) => ({
      id: 9,
      parent_id: null,
      name: (body as { name: string }).name,
      type: (body as { type: string }).type,
      room: 'doc-9',
    }));
    render(<CollabFiles code={CODE} isHost />);
    await waitFor(() => expect(entryNames()).toContain('온도표'));
    fireEvent.contextMenu(document.querySelector('.cf-main')!, { clientX: 100, clientY: 100 });
    const ctx = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.cf-ctx');
      if (!el) throw new Error('no ctx menu');
      return el;
    });
    expect(ctx.textContent).toContain('새로 만들기');
    fireEvent.click(within(ctx).getByText('문서').closest('button')!);
    const nameInput = await screen.findByPlaceholderText('이름');
    fireEvent.change(nameInput, { target: { value: '회의록' } });
    fireEvent.submit(nameInput.closest('form')!);
    await waitFor(() => expect(m.calls('POST', `/api/meetings/${CODE}/files`)).toHaveLength(1));
    expect(m.last('POST').body).toEqual({ name: '회의록', type: 'doc', parent_id: null });
    expect(await screen.findByTestId('doc-editor')).toHaveTextContent('doc-9');
  });

  it('선택 후 삭제 → DELETE + 휴지통 이동 안내 + 재조회', async () => {
    setup(m);
    m.delete(/\/files\/\d+$/, {});
    const ev = captureEvents('app:info');
    render(<CollabFiles code={CODE} isHost />);
    await waitFor(() => expect(entryNames()).toContain('photo.png'));
    fireEvent.click(screen.getByText('photo.png', { selector: '.cf-entry-name' }).closest('.cf-entry')!);
    fireEvent.click(screen.getByTitle('삭제'));
    await waitFor(() => expect(m.calls('DELETE', `/api/meetings/${CODE}/files/4`)).toHaveLength(1));
    expect(ev.of('app:info').some((d) => String(d).includes('휴지통으로 이동'))).toBe(true);
    await waitFor(() => expect(m.calls('GET', `/api/meetings/${CODE}/files`).length).toBeGreaterThanOrEqual(2));
    ev.stop();
  });

  it('files:changed 소켓 푸시로 목록 재조회, 검색으로 필터', async () => {
    setup(m);
    render(<CollabFiles code={CODE} isHost />);
    await waitFor(() => expect(entryNames()).toContain('온도표'));
    const before = m.calls('GET', `/api/meetings/${CODE}/files`).length;
    fakeSocket.trigger('files:changed', { code: CODE });
    await waitFor(() => expect(m.calls('GET', `/api/meetings/${CODE}/files`).length).toBeGreaterThan(before));
    const search = document.querySelector<HTMLInputElement>('.cf-nav input[placeholder$="검색"]');
    if (search) {
      fireEvent.change(search, { target: { value: '온도' } });
      await waitFor(() => expect(entryNames()).toContain('온도표'));
      expect(entryNames()).not.toContain('photo.png');
    }
  });

  it('홈 → 확인 필요 탭에 미서명 회람 문서, 열면 서명 모달에서 서명 → POST ack', async () => {
    setup(m);
    m.post(/\/files\/3\/ack$/, { ok: true });
    render(<CollabFiles code={CODE} isHost />);
    await waitFor(() => expect(entryNames()).toContain('홈'));
    fireEvent.doubleClick(screen.getByText('홈', { selector: '.cf-entry-name' }).closest('.cf-entry')!);
    const row = await screen.findByText('작업지침', { selector: '.cf-home-row-name' });
    fireEvent.doubleClick(row.closest('.cf-home-row')!);
    expect(await screen.findByTestId('doc-editor')).toBeInTheDocument();
    // 서명 배너/버튼 → 모달
    const signBtn = await screen.findByText(/열람 확인 서명|서명하기|확인 서명/);
    fireEvent.click(signBtn.closest('button') ?? signBtn);
    const head = await screen.findByText('열람 확인 서명', { selector: '.cf-signmodal-head' });
    expect(head).toBeInTheDocument();
    expect(within(head.parentElement as HTMLElement).getByText(/63도 기준으로 수정/)).toBeInTheDocument();
    const canvas = document.querySelector('canvas.ho-sign-canvas')!;
    fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: '서명 완료' }));
    await waitFor(() => expect(m.calls('POST', /\/files\/3\/ack$/)).toHaveLength(1));
    expect(m.last('POST', /\/ack$/).body).toEqual({ signature: 'data:image/png;base64,AAAA' });
  });
});
