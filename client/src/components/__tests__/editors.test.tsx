import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { login } from '../../test/auth';

vi.mock('y-websocket', () => import('../../test/yws.mock'));
vi.mock('../../lib/pptx', () => ({ exportPptx: vi.fn(async () => {}) }));

import { WebsocketProvider } from '../../test/yws.mock';
import { exportPptx } from '../../lib/pptx';
import SheetEditor from '../SheetEditor';
import SlideEditor from '../SlideEditor';

const grid = () => document.querySelector<HTMLElement>('.sheet-scroll')!;
const cellText = (r: number, c: number) =>
  document.querySelectorAll('.sheet-grid tbody tr')[r]?.querySelectorAll('td')[c]?.textContent ?? '';

/** 셀에 값 입력 — 타이핑 시작(첫 글자) → 편집 input 전체 값 교체 → Enter */
async function typeCell(value: string) {
  fireEvent.keyDown(grid(), { key: value[0] });
  const input = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('.sheet-cell-input');
    if (!el) throw new Error('no cell input');
    return el;
  });
  expect(input.value).toBe(value[0]);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('SheetEditor (Yjs 로컬)', () => {
  beforeEach(() => {
    login({ id: 1, username: 'juho', name: '이주호' });
    WebsocketProvider.instances.length = 0;
  });

  it('동기화 후 첫 시트 생성, 값·수식 입력, 표시값 계산, 수식바', async () => {
    render(<SheetEditor roomId="sheet-1" />);
    expect(await screen.findByText('시트1')).toBeInTheDocument();
    expect(screen.getByText('실시간 연결됨')).toBeInTheDocument();
    expect(screen.getByText('1명 참여')).toBeInTheDocument();
    expect(document.querySelector('.sheet-cellref')?.textContent).toBe('A1');

    await typeCell('12');
    expect(cellText(0, 0)).toBe('12'); // 행 번호는 th — querySelectorAll('td')는 데이터 셀만
    expect(document.querySelector('.sheet-cellref')?.textContent).toBe('A2');
    await typeCell('=A1*2');
    expect(cellText(1, 0)).toBe('24');
    await typeCell('=SUM(A1:A2)');
    expect(cellText(2, 0)).toBe('36');
    await typeCell('=AVERAGE(A1:A3)');
    expect(cellText(3, 0)).toBe('24');
    await typeCell('=COUNTIF(A1:A3,">20")');
    expect(cellText(4, 0)).toBe('2');
    await typeCell('=IF(A1>10,"big","small")');
    expect(cellText(5, 0)).toMatch(/big|#/);
    // 수식바 — 선택 셀의 원본
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    expect(document.querySelector('.sheet-cellref')?.textContent).toBe('A5');
    expect((document.querySelector('.sheet-formula') as HTMLInputElement).value).toBe('=COUNTIF(A1:A3,">20")');
    // 순환 참조
    fireEvent.keyDown(grid(), { key: 'ArrowRight' });
    await typeCell('=C1');
    fireEvent.keyDown(grid(), { key: 'ArrowRight' });
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    expect(document.querySelector('.sheet-cellref')?.textContent).toBe('C1');
    await typeCell('=B5');
    expect(cellText(0, 2)).toBe('#순환');
  });

  it('서식 툴바(굵게·정렬·통화)·실행 취소·Delete·새 시트·시트 이름 변경', async () => {
    render(<SheetEditor roomId="sheet-2" />);
    await screen.findByText('시트1');
    await typeCell('1234.5');
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    fireEvent.click(screen.getByTitle('굵게'));
    const td = () => document.querySelectorAll('.sheet-grid tbody tr')[0].querySelectorAll('td')[0] as HTMLElement;
    expect(td().style.fontWeight).toBe('700');
    fireEvent.click(screen.getByTitle('굵게'));
    expect(td().style.fontWeight).toBe('');
    fireEvent.click(screen.getByTitle('통화 서식'));
    expect(td().textContent).toContain('₩');
    fireEvent.click(screen.getByTitle('백분율 서식'));
    expect(td().textContent).toContain('%');
    fireEvent.click(screen.getByTitle('백분율 서식'));
    fireEvent.click(screen.getByTitle('천 단위 콤마'));
    expect(td().textContent).toContain('1,234');
    fireEvent.click(screen.getByTitle('소수점 늘리기')); // dec 0→1
    expect(td().textContent).toContain('1,234.5');
    fireEvent.click(screen.getByTitle('소수점 늘리기')); // dec 1→2
    expect(td().textContent).toContain('1,234.50');
    fireEvent.click(screen.getByTitle('소수점 줄이기'));
    expect(td().textContent).toContain('1,234.5');
    // 실행 취소 — 마지막 스타일 변경 되돌리기
    fireEvent.keyDown(grid(), { key: 'z', ctrlKey: true });
    // Delete로 값 비우기
    fireEvent.keyDown(grid(), { key: 'Delete' });
    expect(td().textContent).toBe('');
    // 새 시트 + 이름 변경
    fireEvent.click(screen.getByTitle('새 시트'));
    expect(await screen.findByText('시트2')).toBeInTheDocument();
    expect(document.querySelector('.sheet-tab.active')?.textContent).toContain('시트2');
    fireEvent.doubleClick(screen.getByText('시트2'));
    const rename = document.querySelector('.sheet-tabbar input') as HTMLInputElement;
    fireEvent.change(rename, { target: { value: '재고' } });
    fireEvent.keyDown(rename, { key: 'Enter' });
    expect(await screen.findByText('재고')).toBeInTheDocument();
    // 찾기·바꾸기 / 필터 / 조건부 서식 패널 토글
    fireEvent.keyDown(grid(), { key: 'f', ctrlKey: true });
    expect(screen.getByPlaceholderText('찾기')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('필터'));
    expect(screen.getByPlaceholderText('포함할 값 (비우면 전체)')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('조건부 서식'));
    expect(screen.getByText('규칙 추가')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('첫 행 틀 고정'));
    expect(document.querySelector('.sheet-grid')).toHaveClass('freeze');
  });

  it('원격 사용자의 선택이 이름표로 표시된다 (awareness)', async () => {
    render(<SheetEditor roomId="sheet-3" />);
    await screen.findByText('시트1');
    const p = WebsocketProvider.instances.at(-1)!;
    const sheetId = [...p.doc.getMap('sheets').keys()][0];
    // 다른 클라이언트의 상태를 흉내 — awareness 내부 맵에 직접 넣고 change 이벤트
    act(() => {
      p.awareness.states.set(999, {
        user: { name: '김대리', color: '#e5484d' },
        sel: { sheetId, r1: 1, c1: 1, r2: 1, c2: 1 },
      });
      p.awareness.emit('change', [{ added: [999], updated: [], removed: [] }, 'remote']);
    });
    await waitFor(() => expect(screen.getByText('2명 참여')).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector('.sheet-remote-name')?.textContent).toBe('김대리'));
  });

  it('언마운트 시 provider 정리', async () => {
    const { unmount } = render(<SheetEditor roomId="sheet-4" />);
    await screen.findByText('시트1');
    const p = WebsocketProvider.instances.at(-1)!;
    unmount();
    expect(p.destroyed).toBe(true);
  });
});

describe('SlideEditor (Yjs 로컬)', () => {
  beforeEach(() => {
    login({ id: 2, username: 'kim' });
    WebsocketProvider.instances.length = 0;
    vi.mocked(exportPptx).mockClear();
  });

  it('첫 슬라이드 생성 → 제목·텍스트·도형 추가 → 슬라이드 추가/복제 → 내보내기', async () => {
    render(<SlideEditor roomId="slide-1" fileName="발표" />);
    await waitFor(() => expect(document.querySelectorAll('.slide-thumb')).toHaveLength(1));
    fireEvent.click(screen.getByTitle('제목 추가'));
    await waitFor(() => expect(document.querySelectorAll('.slide-el').length).toBe(1));
    fireEvent.click(screen.getByTitle('텍스트 상자'));
    await waitFor(() => expect(document.querySelectorAll('.slide-el').length).toBe(2));
    fireEvent.click(screen.getByTitle('도형'));
    const shapeBtns = document.querySelectorAll('.slide-shape-menu button');
    expect(shapeBtns.length).toBeGreaterThan(0);
    fireEvent.click(shapeBtns[0]);
    await waitFor(() => expect(document.querySelectorAll('.slide-el').length).toBe(3));
    // 편집 중인 텍스트 상자에 입력
    const ta = document.querySelector('.slide-el-input') as HTMLTextAreaElement | HTMLInputElement | null;
    if (ta) {
      fireEvent.change(ta, { target: { value: '새 텍스트' } });
      fireEvent.blur(ta);
    }
    fireEvent.click(document.querySelector('.slide-add')!);
    await waitFor(() => expect(document.querySelectorAll('.slide-thumb')).toHaveLength(2));
    fireEvent.click(screen.getAllByTitle('복제')[0]);
    await waitFor(() => expect(document.querySelectorAll('.slide-thumb')).toHaveLength(3));
    fireEvent.click(screen.getAllByTitle('아래로')[0]);
    fireEvent.click(document.querySelectorAll('.slide-thumb')[1]);
    expect(document.querySelectorAll('.slide-thumb')[1]).toHaveClass('active');
    fireEvent.click(screen.getByTitle('내보내기'));
    fireEvent.click(screen.getByText('파워포인트 (.pptx)'));
    await waitFor(() => expect(exportPptx).toHaveBeenCalledTimes(1));
    expect(vi.mocked(exportPptx).mock.calls[0][0]).toBe('발표');
    expect(vi.mocked(exportPptx).mock.calls[0][1]).toHaveLength(3);
    // 발표 모드 진입/종료
    fireEvent.click(document.querySelector('.slide-present-btn')!);
    expect(document.querySelector('.slide-present')).toBeInTheDocument();
    fireEvent.click(document.querySelector('.slide-present-exit')!);
    expect(document.querySelector('.slide-present')).not.toBeInTheDocument();
  });

  it('슬라이드 삭제는 confirm, 마지막 한 장은 삭제 불가', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SlideEditor roomId="slide-2" />);
    await waitFor(() => expect(document.querySelectorAll('.slide-thumb')).toHaveLength(1));
    expect(document.querySelector('.slide-thumb-del')).toBeNull(); // 한 장뿐이면 삭제 버튼 없음
    fireEvent.click(document.querySelector('.slide-add')!);
    await waitFor(() => expect(document.querySelectorAll('.slide-thumb')).toHaveLength(2));
    fireEvent.click(document.querySelectorAll('.slide-thumb-del')[1]);
    await waitFor(() => expect(document.querySelectorAll('.slide-thumb')).toHaveLength(1));
  });
});
