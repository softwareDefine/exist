import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { fireEvent } from '@testing-library/dom';
import { login } from '../../test/auth';
import { captureDownloads, center } from '../../test/browser';

vi.mock('y-websocket', () => import('../../test/yws.mock'));

import { WebsocketProvider } from '../../test/yws.mock';
import SheetEditor from '../SheetEditor';

const provider = () => WebsocketProvider.instances.at(-1)!;
const grid = () => document.querySelector<HTMLElement>('.sheet-scroll')!;
const rows = () => document.querySelectorAll('.sheet-grid tbody tr');
const td = (r: number, c: number) => rows()[r].querySelectorAll('td')[c] as HTMLTableCellElement;
const cellText = (r: number, c: number) => td(r, c)?.textContent ?? '';
const cellref = () => document.querySelector('.sheet-cellref')?.textContent;
const active = () => document.querySelector('.sheet-grid td.sel') as HTMLTableCellElement;

/** 셀 클릭 후 실제 키 입력 → Enter (브라우저 키 이벤트 경로) */
async function type(r: number, c: number, value: string) {
  fireEvent.mouseDown(td(r, c));
  fireEvent.mouseUp(window);
  await vi.waitFor(() => expect(active()).toBe(td(r, c))); // 선택 상태가 렌더된 뒤에 키 입력 (아니면 이전 셀에 편집이 열린다)
  // 편집 시작은 그리드 keydown(합성) — CDP 키 입력은 한글 등 비ASCII에서 keydown이 없어 편집이 안 열린다
  fireEvent.keyDown(grid(), { key: value[0] });
  const input = await vi.waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('.sheet-cell-input');
    if (!el) throw new Error('no input');
    return el;
  });
  await userEvent.fill(input, value);
  await userEvent.keyboard('{Enter}');
  await vi.waitFor(() => expect(document.querySelector('.sheet-cell-input')).toBeNull());
}
async function tool(title: string): Promise<HTMLElement> {
  let el = document.querySelector<HTMLElement>(`.sheet-editor [title="${title}"]`);
  if (!el) {
    const more = document.querySelector<HTMLElement>('.sheet-editor .tb-more');
    if (more && !more.classList.contains('on')) await userEvent.click(more);
    el = document.querySelector<HTMLElement>(`.sheet-editor [title="${title}"], .tb-more-panel [title="${title}"]`);
  }
  if (!el) throw new Error(`no tool ${title}`);
  return el;
}
const menuBtn = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.sheet-editor button')].find((b) => b.textContent === label)!;

async function mount(roomId: string) {
  const r = render(
    <div style={{ width: 1100, height: 700 }}>
      <SheetEditor roomId={roomId} />
    </div>,
  );
  await vi.waitFor(() => expect(document.querySelector('.sheet-tab')).toBeTruthy());
  await vi.waitFor(() => expect(td(0, 0)).toBeTruthy());
  return r;
}

describe('SheetEditor (Chromium — 마우스 범위 선택·채우기·열 폭·차트·내보내기)', () => {
  beforeEach(() => {
    login({ id: 1, username: 'juho', name: '이주호' });
    WebsocketProvider.instances.length = 0;
  });

  it('마우스 드래그로 범위 선택 → A1:B3, shift 클릭 확장, 빈 곳 mouseup으로 종료', async () => {
    await mount('sheet-b1');
    fireEvent.mouseDown(td(0, 0));
    fireEvent.mouseOver(td(1, 1));
    fireEvent.mouseOver(td(2, 1));
    await vi.waitFor(() => expect(cellref()).toBe('A1:B3'));
    expect(document.querySelectorAll('.sheet-grid td.inrange').length).toBeGreaterThanOrEqual(5);
    fireEvent.mouseUp(window);
    fireEvent.mouseOver(td(5, 5)); // 드래그 끝났으니 확장 안 됨
    await new Promise((r) => requestAnimationFrame(r));
    expect(cellref()).toBe('A1:B3');
    fireEvent.mouseDown(td(3, 3), { shiftKey: true });
    await vi.waitFor(() => expect(cellref()).toBe('A1:D4'));
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(td(0, 0));
    fireEvent.mouseUp(window);
    await vi.waitFor(() => expect(cellref()).toBe('A1'));
    expect(document.querySelector('.sheet-grid thead th.sel')?.textContent).toBe('A');
  });

  it('채우기 핸들 — 1,2 를 아래로 끌면 3,4,5 (등차), 오른쪽 방향 채우기', async () => {
    await mount('sheet-b2');
    await type(0, 0, '1');
    await type(1, 0, '2');
    fireEvent.mouseDown(td(0, 0));
    fireEvent.mouseOver(td(1, 0));
    fireEvent.mouseUp(window);
    await vi.waitFor(() => expect(cellref()).toBe('A1:A2'));
    const handle = document.querySelector('.sheet-fillhandle')!;
    fireEvent.mouseDown(handle);
    fireEvent.mouseOver(td(3, 0));
    await vi.waitFor(() => expect(document.querySelectorAll('.sheet-grid td.infill')).toHaveLength(2));
    fireEvent.mouseOver(td(4, 0));
    await vi.waitFor(() => expect(document.querySelectorAll('.sheet-grid td.infill')).toHaveLength(3));
    fireEvent.mouseUp(window);
    await vi.waitFor(() => expect(cellText(4, 0)).toBe('5'));
    expect([cellText(2, 0), cellText(3, 0)]).toEqual(['3', '4']);
    // 오른쪽
    fireEvent.mouseDown(td(0, 0));
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(document.querySelector('.sheet-fillhandle')!);
    fireEvent.mouseOver(td(0, 2));
    await vi.waitFor(() => expect(document.querySelectorAll('.sheet-grid td.infill').length).toBeGreaterThanOrEqual(1));
    fireEvent.mouseUp(window);
    await vi.waitFor(() => expect(cellText(0, 1)).not.toBe(''));
  });

  it('열·행 크기 조절 그립 드래그 → 폭/높이 갱신 + Y dims 저장', async () => {
    await mount('sheet-b3');
    const grip = document.querySelector('.sheet-grid thead th:nth-child(2) .sheet-grip-c')!;
    const c = center(grip);
    fireEvent.mouseDown(grip, { clientX: c.x, clientY: c.y });
    fireEvent.mouseMove(window, { clientX: c.x + 60, clientY: c.y });
    fireEvent.mouseUp(window, { clientX: c.x + 60, clientY: c.y });
    await vi.waitFor(() => expect(document.querySelector('.sheet-grid thead th:nth-child(2)')?.getAttribute('style')).toContain('156px'));
    const sheet = [...provider().doc.getMap<{ cellsKey: string }>('sheets').values()][0];
    const dims = provider().doc.getMap(`${sheet.cellsKey}:dim`);
    await vi.waitFor(() => expect(dims.get('c:0')).toBe(156));
    const rgrip = document.querySelector('.sheet-grid tbody tr:first-child .sheet-grip-r')!;
    const rc = center(rgrip);
    fireEvent.mouseDown(rgrip, { clientX: rc.x, clientY: rc.y });
    fireEvent.mouseMove(window, { clientX: rc.x, clientY: rc.y + 14 });
    fireEvent.mouseUp(window, { clientX: rc.x, clientY: rc.y + 14 });
    await vi.waitFor(() => expect((rows()[0] as HTMLElement).style.height).toBe('40px'));
  });

  it('차트 — 라벨 열 + 숫자 열 범위 → 막대/선/원 SVG, 숫자 없으면 안내', async () => {
    await mount('sheet-b4');
    await type(0, 0, '1월');
    await type(1, 0, '2월');
    await type(2, 0, '3월');
    await type(0, 1, '10');
    await type(1, 1, '20');
    await type(2, 1, '15');
    fireEvent.mouseDown(td(0, 0));
    fireEvent.mouseOver(td(2, 1));
    fireEvent.mouseUp(window);
    await vi.waitFor(() => expect(cellref()).toBe('A1:B3'));
    await userEvent.click(await tool('차트 만들기'));
    await vi.waitFor(() => expect(document.querySelector('.sheet-chart svg')).toBeTruthy());
    expect(document.querySelector('.sheet-chart-range')?.textContent).toBe('A1:B3');
    expect(document.querySelector('.sheet-chart-body')?.textContent).toContain('1월');
    await userEvent.click(menuBtn('선'));
    expect(document.querySelector('.sheet-chart svg polyline, .sheet-chart svg path')).toBeTruthy();
    await userEvent.click(menuBtn('원'));
    expect(document.querySelector('.sheet-chart svg path, .sheet-chart svg circle')).toBeTruthy();
    await userEvent.click(document.querySelector('.sheet-chart-close')!);
    expect(document.querySelector('.sheet-chart')).toBeNull();
    fireEvent.mouseDown(td(6, 6));
    fireEvent.mouseUp(window);
    await userEvent.click(await tool('차트 만들기'));
    expect(document.querySelector('.sheet-chart-empty')).toBeInTheDocument();
    fireEvent.click(document.querySelector('.sheet-chart-overlay')!);
    await vi.waitFor(() => expect(document.querySelector('.sheet-chart')).toBeNull());
  });

  it('내보내기 — CSV(BOM·따옴표 이스케이프)와 xlsx(진짜 Open XML zip)', async () => {
    const dl = captureDownloads();
    await mount('sheet-b5');
    await type(0, 0, 'a,b');
    await type(0, 1, '=1+1');
    await type(1, 0, '한글');
    await userEvent.click(await tool('내보내기'));
    await userEvent.click(menuBtn('CSV (.csv)'));
    await vi.waitFor(() => expect(dl.got).toHaveLength(1));
    expect(dl.last().name).toBe('sheet_b5.csv');
    const bytes = new Uint8Array(await dl.last().blob!.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM (Blob.text()는 BOM을 벗겨 돌려준다)
    expect(await dl.text()).toBe('"a,b",2\r\n한글,');
    await userEvent.click(await tool('내보내기'));
    await userEvent.click(menuBtn('엑셀 (.xlsx)'));
    await vi.waitFor(() => expect(dl.got).toHaveLength(2));
    expect(dl.last().name).toBe('sheet_b5.xlsx');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await dl.last().blob!.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['xl/workbook.xml', 'xl/worksheets/sheet1.xml']));
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheetXml).toContain('한글');
    expect(sheetXml).toContain('>2<');
  });

  it('병합·테두리·행/열 삽입 삭제·정렬·글자/채우기 색·복사 붙여넣기', async () => {
    await mount('sheet-b6');
    await type(0, 0, '3');
    await type(1, 0, '1');
    await type(2, 0, '2');
    // 정렬 (범위 A1:A3)
    fireEvent.mouseDown(td(0, 0));
    fireEvent.mouseOver(td(2, 0));
    fireEvent.mouseUp(window);
    await userEvent.click(await tool('정렬'));
    await userEvent.click(menuBtn('오름차순 정렬'));
    await vi.waitFor(() => expect([cellText(0, 0), cellText(1, 0), cellText(2, 0)]).toEqual(['1', '2', '3']));
    await userEvent.click(await tool('정렬'));
    await userEvent.click(menuBtn('내림차순 정렬'));
    await vi.waitFor(() => expect([cellText(0, 0), cellText(1, 0), cellText(2, 0)]).toEqual(['3', '2', '1']));
    // 테두리
    await userEvent.click(await tool('테두리'));
    await userEvent.click(menuBtn('모든 테두리'));
    await vi.waitFor(() => expect(td(0, 0).style.borderTop).toContain('2px'));
    await userEvent.click(await tool('테두리'));
    await userEvent.click(menuBtn('바깥 테두리'));
    await userEvent.click(await tool('테두리'));
    await userEvent.click(menuBtn('테두리 없음'));
    await vi.waitFor(() => expect(td(0, 0).style.borderTop).toBe(''));
    // 병합 A1:A3 → 해제
    await userEvent.click(await tool('셀 병합'));
    await userEvent.click(menuBtn('선택 영역 병합'));
    await vi.waitFor(() => expect(td(0, 0).rowSpan).toBe(3));
    await userEvent.click(await tool('셀 병합'));
    await userEvent.click(menuBtn('병합 해제'));
    await vi.waitFor(() => expect(td(0, 0).rowSpan).toBe(1));
    expect([cellText(1, 0), cellText(2, 0)]).toEqual(['', '']); // 병합은 좌상단만 남긴다
    await type(1, 0, '2');
    await type(2, 0, '1');
    // 색
    fireEvent.mouseDown(td(0, 0));
    fireEvent.mouseUp(window);
    await userEvent.click(await tool('글자 색'));
    await userEvent.click(document.querySelectorAll<HTMLElement>('.sht-pop button')[5]);
    await vi.waitFor(() => expect(td(0, 0).style.color).not.toBe(''));
    await userEvent.click(await tool('채우기 색'));
    await userEvent.click(document.querySelectorAll<HTMLElement>('.sht-pop button')[5]);
    await vi.waitFor(() => expect(td(0, 0).style.backgroundColor).not.toBe(''));
    // 행/열 삽입·삭제
    await userEvent.click(await tool('행·열 삽입/삭제'));
    await userEvent.click(menuBtn('위에 행 삽입'));
    await vi.waitFor(() => expect(cellText(1, 0)).toBe('3'));
    await userEvent.click(await tool('행·열 삽입/삭제'));
    await userEvent.click(menuBtn('행 삭제'));
    await vi.waitFor(() => expect(cellText(0, 0)).toBe('3'));
    await userEvent.click(await tool('행·열 삽입/삭제'));
    await userEvent.click(menuBtn('왼쪽에 열 삽입'));
    await vi.waitFor(() => expect(cellText(0, 1)).toBe('3'));
    await userEvent.click(await tool('행·열 삽입/삭제'));
    await userEvent.click(menuBtn('열 삭제'));
    await vi.waitFor(() => expect(cellText(0, 0)).toBe('3'));
    // 복사 → 붙여넣기 (앱 내부 클립보드)
    fireEvent.mouseDown(td(0, 0));
    fireEvent.mouseOver(td(2, 0));
    fireEvent.mouseUp(window);
    await vi.waitFor(() => expect(cellref()).toBe('A1:A3'));
    grid().focus();
    await userEvent.keyboard('{Control>}c{/Control}');
    fireEvent.mouseDown(td(0, 3));
    fireEvent.mouseUp(window);
    await vi.waitFor(() => expect(cellref()).toBe('D1')); // 키 핸들러는 마지막 렌더의 sel을 본다
    await userEvent.keyboard('{Control>}v{/Control}');
    await vi.waitFor(() => expect([cellText(0, 3), cellText(1, 3), cellText(2, 3)]).toEqual(['3', '2', '1']));
    // 잘라내기 → 붙여넣기
    fireEvent.mouseDown(td(0, 3));
    fireEvent.mouseUp(window);
    await vi.waitFor(() => expect(cellref()).toBe('D1'));
    await userEvent.keyboard('{Control>}x{/Control}');
    fireEvent.mouseDown(td(5, 5));
    fireEvent.mouseUp(window);
    await vi.waitFor(() => expect(cellref()).toBe('F6'));
    await userEvent.keyboard('{Control>}v{/Control}');
    await vi.waitFor(() => expect(cellText(5, 5)).toBe('3'));
    expect(cellText(0, 3)).toBe('');
    expect(active()).toBeTruthy();
  });

  it('시트 탭 삭제(confirm) — 마지막 시트는 삭제 버튼 없음', async () => {
    await mount('sheet-b7');
    expect(document.querySelector('.sheet-tab-close')).toBeNull();
    await userEvent.click(await tool('새 시트'));
    await vi.waitFor(() => expect(document.querySelectorAll('.sheet-tab')).toHaveLength(2));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(document.querySelectorAll('.sheet-tab-close')[1]);
    expect(document.querySelectorAll('.sheet-tab')).toHaveLength(2);
    confirm.mockReturnValue(true);
    await userEvent.click(document.querySelectorAll('.sheet-tab-close')[1]);
    await vi.waitFor(() => expect(document.querySelectorAll('.sheet-tab')).toHaveLength(1));
  });
});
