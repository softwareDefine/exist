import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { fireEvent } from '@testing-library/dom';
import { login } from '../../test/auth';
import { mockApi } from '../../test/mockApi';
import { makePngFile, setInputFiles, center, tick } from '../../test/browser';

vi.mock('y-websocket', () => import('../../test/yws.mock'));
vi.mock('../../lib/pptx', () => ({ exportPptx: vi.fn(async () => {}) }));

import { WebsocketProvider } from '../../test/yws.mock';
import SlideEditor from '../SlideEditor';

const provider = () => WebsocketProvider.instances.at(-1)!;
const els = () => [...document.querySelectorAll<HTMLElement>('.slide-canvas .slide-el')];
const canvas = () => document.querySelector<HTMLElement>('.slide-canvas')!;
/** 활성 슬라이드의 요소 맵 (Y) */
function elMap() {
  const doc = provider().doc;
  const slideId = [...doc.getMap('slides').keys()][0];
  return doc.getMap<{ x: number; y: number; w: number; h: number; type: string; text?: string; gid?: string; rot?: number; fill?: string }>(
    `slide-els:${slideId}`,
  );
}
async function tool(title: string): Promise<HTMLElement> {
  let el = document.querySelector<HTMLElement>(`.slide-editor [title="${title}"], .slide-toolbar [title="${title}"], [title="${title}"]`);
  if (!el) {
    const more = document.querySelector<HTMLElement>('.tb-more');
    if (more && !more.classList.contains('on')) await userEvent.click(more);
    el = document.querySelector<HTMLElement>(`[title="${title}"]`);
  }
  if (!el) throw new Error(`no tool ${title}`);
  return el;
}
/** 포인터 드래그 — down은 요소에, move/up은 window 리스너로 */
function drag(el: Element, dx: number, dy: number, opts: { shiftKey?: boolean } = {}) {
  const c = center(el);
  fireEvent.pointerDown(el, { clientX: c.x, clientY: c.y, pointerId: 1, buttons: 1, button: 0, ...opts });
  fireEvent.pointerMove(window, { clientX: c.x + dx / 2, clientY: c.y + dy / 2, pointerId: 1, buttons: 1 });
  fireEvent.pointerMove(window, { clientX: c.x + dx, clientY: c.y + dy, pointerId: 1, buttons: 1 });
  fireEvent.pointerUp(window, { clientX: c.x + dx, clientY: c.y + dy, pointerId: 1, buttons: 0 });
}

async function mount(roomId: string) {
  const r = render(
    <div style={{ width: 1100, height: 700 }}>
      <SlideEditor roomId={roomId} fileName="발표" />
    </div>,
  );
  await vi.waitFor(() => expect(document.querySelectorAll('.slide-thumb')).toHaveLength(1));
  await vi.waitFor(() => expect(canvas().getBoundingClientRect().width).toBeGreaterThan(100));
  return r;
}

describe('SlideEditor (Chromium — 실제 캔버스 좌표)', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    login({ id: 2, username: 'kim', name: '김대리' });
    WebsocketProvider.instances.length = 0;
  });

  it('요소 드래그 이동 → x/y(%)가 캔버스 폭 기준으로 바뀌고 Y.Map에 기록, 크기 조절 핸들', async () => {
    await mount('slide-b1');
    await userEvent.click(await tool('텍스트 상자'));
    await vi.waitFor(() => expect(els()).toHaveLength(1));
    const id = [...elMap().keys()][0];
    const before = elMap().get(id)!;
    const rect = canvas().getBoundingClientRect();
    // 편집 중(textarea)이면 드래그가 막힌다 — 먼저 빈 곳 클릭으로 편집 종료
    fireEvent.focusOut(document.querySelector('.slide-el-input')!);
    await vi.waitFor(() => expect(document.querySelector('.slide-el-input')).toBeNull());
    drag(els()[0], rect.width * 0.2, rect.height * 0.1);
    await vi.waitFor(() => expect(elMap().get(id)!.x).toBeGreaterThan(before.x + 15));
    expect(elMap().get(id)!.y).toBeGreaterThan(before.y + 5);
    expect(els()[0].style.left).toBe(`${elMap().get(id)!.x}%`);
    // 크기 조절
    await userEvent.click(els()[0]);
    const handle = document.querySelector('.slide-el-resize')!;
    const w0 = elMap().get(id)!.w;
    drag(handle, rect.width * 0.1, rect.height * 0.1);
    await vi.waitFor(() => expect(elMap().get(id)!.w).toBeGreaterThan(w0 + 5));
    // 경계 밖으로는 못 나감 (98% 클램프)
    drag(els()[0], rect.width * 2, rect.height * 2);
    await vi.waitFor(() => expect(elMap().get(id)!.x).toBe(98));
    expect(elMap().get(id)!.y).toBe(98);
  });

  it('정렬 보조선 — 다른 요소 왼쪽 가장자리에 스냅되면 세로 가이드가 뜬다', async () => {
    await mount('slide-b2');
    await userEvent.click(await tool('도형'));
    await userEvent.click(document.querySelector('.slide-shape-menu button')!);
    await vi.waitFor(() => expect(els()).toHaveLength(1));
    await userEvent.click(await tool('도형'));
    await userEvent.click(document.querySelector('.slide-shape-menu button')!);
    await vi.waitFor(() => expect(els()).toHaveLength(2));
    const ids = [...elMap().keys()];
    // 두 번째를 오른쪽 아래로 옮겨 놓고, 왼쪽 가장자리를 첫 번째와 맞추며 끌어본다
    elMap().set(ids[1], { ...elMap().get(ids[1])!, x: 60, y: 60 });
    await tick(30);
    const rect = canvas().getBoundingClientRect();
    const a = elMap().get(ids[0])!;
    const b = () => elMap().get(ids[1])!;
    const target = els().find((e) => e.style.left === '60%')!;
    const c = center(target);
    fireEvent.pointerDown(target, { clientX: c.x, clientY: c.y, pointerId: 1, buttons: 1, button: 0 });
    // x를 a.x + 0.3%로 → SNAP(0.8) 안 → 스냅 + 가이드
    const dx = ((a.x + 0.3 - b().x) / 100) * rect.width;
    fireEvent.pointerMove(window, { clientX: c.x + dx, clientY: c.y, pointerId: 1, buttons: 1 });
    await vi.waitFor(() => expect(document.querySelector('.slide-guide-v')).toBeTruthy());
    expect(b().x).toBeCloseTo(a.x, 1);
    fireEvent.pointerUp(window, { clientX: c.x + dx, clientY: c.y, pointerId: 1, buttons: 0 });
    await vi.waitFor(() => expect(document.querySelector('.slide-guide-v')).toBeNull());
    // 버튼이 떨어진 채 move가 오면 드래그 강제 종료
    fireEvent.pointerDown(target, { clientX: c.x, clientY: c.y, pointerId: 1, buttons: 1, button: 0 });
    fireEvent.pointerMove(window, { clientX: c.x + 5, clientY: c.y, pointerId: 1, buttons: 0 });
    expect(document.body.style.userSelect).toBe('');
  });

  it('그림 넣기 — 업로드 POST 후 이미지 요소, 썸네일에도 미니 이미지', async () => {
    m.post(/\/api\/workspaces\/uploads\?name=pic\.png$/, { url: '/uploads/pic.png' });
    await mount('slide-b3');
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await userEvent.click(await tool('그림 넣기'));
    expect(clickSpy).toHaveBeenCalled();
    setInputFiles(document.querySelector<HTMLInputElement>('input[type="file"]')!, [await makePngFile('pic.png')]);
    await vi.waitFor(() => expect(document.querySelector('.slide-canvas .slide-el-img')?.getAttribute('src')).toBe('/uploads/pic.png'));
    expect(m.last('POST', /uploads/).headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(document.querySelector('.slide-thumb-canvas .slide-el-img')).toBeTruthy();
    expect([...elMap().values()][0]).toMatchObject({ type: 'image', x: 25, y: 25, w: 40, h: 40 });
    // 업로드 실패는 조용히 무시
    m.fail('POST', /\/api\/workspaces\/uploads/, 500);
    setInputFiles(document.querySelector<HTMLInputElement>('input[type="file"]')!, [await makePngFile('bad.png')]);
    await tick(50);
    expect(elMap().size).toBe(1);
  });

  it('텍스트 편집·키보드(Delete·방향키·Esc·Ctrl+G 그룹/해제)·shift 다중 선택', async () => {
    await mount('slide-b4');
    await userEvent.click(await tool('제목 추가'));
    await vi.waitFor(() => expect(els()).toHaveLength(1));
    const ta = document.querySelector<HTMLTextAreaElement>('.slide-el-input')!;
    await userEvent.fill(ta, '분기 보고');
    fireEvent.focusOut(ta);
    await vi.waitFor(() => expect(document.querySelector('.slide-el-text')?.textContent).toBe('분기 보고'));
    expect(document.querySelector('.slide-thumb-canvas')?.textContent).toContain('분기 보고');
    // 더블클릭 재편집 → Esc
    await userEvent.dblClick(els()[0]);
    expect(document.querySelector('.slide-el-input')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(document.querySelector('.slide-el-input')).toBeNull();
    // 방향키 미세 이동
    await userEvent.click(els()[0]);
    const id = [...elMap().keys()][0];
    const x0 = elMap().get(id)!.x;
    await userEvent.keyboard('{ArrowRight}{ArrowDown}');
    await vi.waitFor(() => expect(elMap().get(id)!.x).toBeGreaterThan(x0));
    // 두 번째 요소 + shift 클릭 다중 선택 → 그룹 → 해제
    await userEvent.click(await tool('텍스트 상자'));
    await vi.waitFor(() => expect(els()).toHaveLength(2));
    fireEvent.focusOut(document.querySelector('.slide-el-input')!);
    await vi.waitFor(() => expect(document.querySelector('.slide-el-input')).toBeNull());
    // shift 클릭은 토글 — 아직 선택 안 된 쪽을 눌러야 2개가 된다 (DOM 순서는 z-order라 고정이 아님)
    const other = els().find((e) => !e.classList.contains('sel'))!;
    const c0 = center(other);
    fireEvent.pointerDown(other, { clientX: c0.x, clientY: c0.y, pointerId: 1, buttons: 1, button: 0, shiftKey: true });
    fireEvent.pointerUp(window, { pointerId: 1, buttons: 0 });
    await vi.waitFor(() => expect(document.querySelectorAll('.slide-el.sel')).toHaveLength(2));
    await userEvent.keyboard('{Control>}g{/Control}');
    await vi.waitFor(() => expect([...elMap().values()].every((e) => !!e.gid)).toBe(true));
    await userEvent.keyboard('{Control>}{Shift>}g{/Shift}{/Control}');
    await vi.waitFor(() => expect([...elMap().values()].every((e) => !e.gid)).toBe(true));
    // Esc 선택 해제, Delete 삭제
    await userEvent.click(els()[0]);
    await userEvent.keyboard('{Escape}');
    expect(document.querySelectorAll('.slide-el.sel')).toHaveLength(0);
    await userEvent.click(els()[0]);
    await userEvent.keyboard('{Delete}');
    await vi.waitFor(() => expect(els()).toHaveLength(1));
    await userEvent.click(els()[0]);
    await vi.waitFor(() => expect(document.querySelector('.slide-el-del')).toBeTruthy());
    fireEvent.click(document.querySelector('.slide-el-del')!);
    await vi.waitFor(() => expect(els()).toHaveLength(0));
  });

  it('도형 — 채우기/선 색, 회전, 앞뒤 순서, 복제, 슬라이드 배경색, 도형 안 텍스트', async () => {
    await mount('slide-b5');
    await userEvent.click(await tool('도형'));
    const shapes = document.querySelectorAll('.slide-shape-menu button');
    expect(shapes.length).toBeGreaterThan(3);
    await userEvent.click(shapes[1]);
    await vi.waitFor(() => expect(els()).toHaveLength(1));
    expect(els()[0].querySelector('svg')).toBeTruthy();
    const id = [...elMap().keys()][0];
    await userEvent.click(await tool('채우기 색'));
    await userEvent.click(document.querySelectorAll<HTMLElement>('.sht-dd button, .slide-color-menu button, .doc-dd button')[4] ?? document.querySelectorAll<HTMLElement>('button[style*="background"]')[4]);
    await vi.waitFor(() => expect(elMap().get(id)!.fill).not.toBe('#a5d8ff'));
    await userEvent.click(await tool('오른쪽으로 15° 회전'));
    await vi.waitFor(() => expect(elMap().get(id)!.rot).toBe(15));
    await userEvent.click(await tool('왼쪽으로 15° 회전'));
    await vi.waitFor(() => expect(elMap().get(id)!.rot ?? 0).toBe(0));
    expect(els()[0].style.transform).toBe('');
    await userEvent.click(await tool('복제'));
    await vi.waitFor(() => expect(els()).toHaveLength(2));
    await userEvent.click(await tool('맨 뒤로'));
    await userEvent.click(await tool('맨 앞으로'));
    await userEvent.click(await tool('한 단계 뒤로'));
    await userEvent.click(await tool('한 단계 앞으로'));
    // 도형 안 텍스트
    await userEvent.dblClick(els()[1]);
    const ta = document.querySelector<HTMLTextAreaElement>('.slide-shape-textarea')!;
    await userEvent.fill(ta, '공정');
    fireEvent.focusOut(ta);
    await vi.waitFor(() => expect(document.querySelector('.slide-shape-text')?.textContent).toBe('공정'));
    // 배경색
    await userEvent.click(await tool('슬라이드 배경색'));
    const bgBtn = [...document.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.style.background && b.closest('.sht-dd, .slide-color-menu, .doc-dd'),
    );
    if (bgBtn) {
      await userEvent.click(bgBtn);
      await vi.waitFor(() => expect(canvas().style.background).not.toBe(''));
    }
  });

  it('발표 모드 — 방향키/클릭으로 넘기고 Esc로 종료, 인쇄(PDF)는 window.print', async () => {
    await mount('slide-b6');
    await userEvent.click(document.querySelector('.slide-add')!);
    await vi.waitFor(() => expect(document.querySelectorAll('.slide-thumb')).toHaveLength(2));
    await userEvent.click(document.querySelectorAll('.slide-thumb')[0]);
    await userEvent.click(document.querySelector('.slide-present-btn')!);
    await vi.waitFor(() => expect(document.querySelector('.slide-present')).toBeTruthy());
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard('{ArrowLeft}');
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(document.querySelector('.slide-present')).toBeNull());
    await userEvent.click(await tool('내보내기'));
    const pdf = [...document.querySelectorAll<HTMLElement>('button')].find((b) => /PDF|인쇄/.test(b.textContent ?? ''));
    if (pdf) {
      await userEvent.click(pdf);
      await vi.waitFor(() => expect(window.print).toHaveBeenCalled());
      window.dispatchEvent(new Event('afterprint'));
    }
  });
});
