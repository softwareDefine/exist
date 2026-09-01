import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { fireEvent } from '@testing-library/dom';
import { login } from '../../test/auth';
import { mockApi } from '../../test/mockApi';
import { captureDownloads, makePngFile, setInputFiles, tick } from '../../test/browser';

vi.mock('y-websocket', () => import('../../test/yws.mock'));
vi.mock('../../lib/docx', () => ({ exportDocx: vi.fn(async () => {}) }));

import { WebsocketProvider } from '../../test/yws.mock';
import { exportDocx } from '../../lib/docx';
import DocEditor from '../DocEditor';

const prose = () => document.querySelector<HTMLElement>('.doc-prose')!;
const provider = () => WebsocketProvider.instances.at(-1)!;
const wordCount = () => document.querySelector('.doc-wordcount')?.textContent ?? '';
const tabNames = () => [...document.querySelectorAll('.doc-tab-name')].map((e) => e.textContent);

/** 툴바 버튼 — 오버플로(⋮)로 접혀 있으면 패널을 열어서 찾는다 */
async function tool(title: string): Promise<HTMLElement> {
  let el = document.querySelector<HTMLElement>(`.doc-editor-bar [title="${title}"]`);
  if (!el) {
    const more = document.querySelector<HTMLElement>('.doc-editor-bar .tb-more');
    if (more && !more.classList.contains('on')) await userEvent.click(more);
    el = document.querySelector<HTMLElement>(`.doc-editor-bar [title="${title}"]`);
  }
  if (!el) throw new Error(`no tool ${title}`);
  return el;
}
/** 툴바·드롭다운 클릭은 DOM 이벤트로 — 오버플로 행(overflow:hidden)에 반쯤 잘린 버튼도 Playwright 가시성 판정에 안 걸리게 */
async function click(el: Element) {
  fireEvent.click(el);
  await tick(0);
}
async function clickTool(title: string) {
  await click(await tool(title));
}
/** 오버플로 패널이 열려 있으면 배경이 클릭을 가로챈다 — 본문을 만지기 전에 닫는다 */
async function closeMore() {
  const back = document.querySelector<HTMLElement>('.tb-more-back');
  if (back) {
    fireEvent.click(back);
    await vi.waitFor(() => expect(document.querySelector('.tb-more-back')).toBeNull());
  }
}
async function clickProse() {
  await closeMore();
  await userEvent.click(prose());
}
async function typeInDoc(text: string) {
  await clickProse();
  await userEvent.keyboard(text);
}
const selectAll = () => userEvent.keyboard('{Control>}a{/Control}');
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.doc-dd .item')].find((b) => b.textContent === label)!;

describe('DocEditor (tiptap, Chromium)', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    login({ id: 1, username: 'juho', name: '이주호' });
    WebsocketProvider.instances.length = 0;
    vi.mocked(exportDocx).mockClear();
  });

  it('동기화 후 "문서 1" 생성, 타이핑이 Y.XmlFragment로, 글자·단어 수, 원격 참가자 수', async () => {
    await render(<DocEditor roomId="doc-1" />);
    await vi.waitFor(() => expect(tabNames()).toEqual(['문서 1']));
    await vi.waitFor(() => expect(prose()).toBeTruthy());
    expect(document.querySelector('.code-doc-status')?.textContent).toContain('실시간 연결됨');
    await typeInDoc('Hello world');
    await vi.waitFor(() => expect(prose().textContent).toBe('Hello world'));
    expect(wordCount()).toBe('10자 · 2단어');
    const docId = [...provider().doc.getMap('docs').keys()][0];
    expect(provider().doc.getXmlFragment(`doc:${docId}`).toString()).toContain('Hello world');
    provider().awareness.states.set(9, { user: { name: '김대리', color: '#e5484d' } });
    provider().awareness.emit('change', [{ added: [9], updated: [], removed: [] }, 'remote']);
    await vi.waitFor(() => expect(document.querySelector('.code-doc-peers')?.textContent).toBe('2명 참여'));
  });

  it('툴바 — 굵게·기울임·밑줄·취소선·제목·목록·인용·코드·구분선·정렬·서식 지우기·실행 취소', async () => {
    await render(<DocEditor roomId="doc-2" />);
    await vi.waitFor(() => expect(prose()).toBeTruthy());
    await typeInDoc('bold text');
    await selectAll();
    await clickTool('굵게');
    await vi.waitFor(() => expect(prose().querySelector('strong')?.textContent).toBe('bold text'));
    expect((await tool('굵게')).classList.contains('on')).toBe(true);
    await clickTool('기울임');
    expect(prose().querySelector('em')).toBeTruthy();
    await clickTool('밑줄');
    expect(prose().querySelector('u')).toBeTruthy();
    await clickTool('취소선');
    expect(prose().querySelector('s')).toBeTruthy();
    await clickTool('서식 지우기');
    await vi.waitFor(() => expect(prose().querySelector('strong, em, u, s')).toBeNull());
    // 제목
    await click(await tool('텍스트 스타일'));
    await click(menuItem('제목 1'));
    await vi.waitFor(() => expect(prose().querySelector('h1')?.textContent).toBe('bold text'));
    // Ctrl+A의 AllSelection은 노드 활성 판정(isActive)에 안 잡힌다 — 제목을 클릭해 커서를 그 안에 두면 라벨이 바뀐다
    // (본문 빈 곳을 클릭하면 StarterKit v3의 TrailingNode가 만든 빈 문단으로 간다)
    await closeMore();
    await userEvent.click(prose().querySelector('h1')!);
    await vi.waitFor(async () => expect((await tool('텍스트 스타일')).textContent).toContain('제목 1'));
    await click(await tool('텍스트 스타일'));
    await click(menuItem('제목 2'));
    expect(prose().querySelector('h2')).toBeTruthy();
    await click(await tool('텍스트 스타일'));
    await click(menuItem('제목 3'));
    expect(prose().querySelector('h3')).toBeTruthy();
    // 개요 사이드바 — 제목 목차
    await userEvent.click(document.querySelector('button[title="문서 개요"]')!);
    expect(document.querySelector('.doc-outline-item.lv3')?.textContent).toBe('bold text');
    await userEvent.click(document.querySelector('.doc-outline-item')!);
    await click(await tool('텍스트 스타일'));
    await click(menuItem('일반 텍스트'));
    await vi.waitFor(() => expect(prose().querySelector('h3')).toBeNull());
    expect(document.querySelector('.doc-outline-empty')).toBeInTheDocument();
    await userEvent.click(document.querySelector('button[title="문서 개요"]')!);
    expect(document.querySelector('.doc-outline')).toBeNull();
    // 목록·인용·코드·구분선
    await clickTool('글머리 목록');
    expect(prose().querySelector('ul li')).toBeTruthy();
    await clickTool('번호 목록');
    expect(prose().querySelector('ol li')).toBeTruthy();
    await clickTool('체크리스트');
    expect(prose().querySelector('ul[data-type="taskList"]')).toBeTruthy();
    await clickTool('체크리스트');
    await clickTool('인용');
    expect(prose().querySelector('blockquote')).toBeTruthy();
    await clickTool('인용');
    await clickTool('코드 블록');
    expect(prose().querySelector('pre code')).toBeTruthy();
    await clickTool('코드 블록');
    await clickTool('구분선');
    expect(prose().querySelector('hr')).toBeTruthy();
    // 정렬
    await clickTool('가운데 정렬');
    expect(prose().querySelector('[style*="text-align: center"]')).toBeTruthy();
    await clickTool('오른쪽 정렬');
    expect(prose().querySelector('[style*="text-align: right"]')).toBeTruthy();
    await clickTool('왼쪽 정렬');
    // 실행 취소 / 다시 실행 (Yjs UndoManager)
    await clickTool('실행 취소 (Ctrl+Z)');
    await clickTool('다시 실행 (Ctrl+Y)');
  });

  it('글꼴·줄 간격·글자 크기 스테퍼·글자색·형광펜', async () => {
    await render(<DocEditor roomId="doc-3" />);
    await vi.waitFor(() => expect(prose()).toBeTruthy());
    await typeInDoc('style me');
    await selectAll();
    await click(await tool('글꼴'));
    await click(menuItem('명조'));
    await vi.waitFor(() => expect(prose().querySelector('span[style*="font-family"]')).toBeTruthy());
    await vi.waitFor(async () => expect((await tool('글꼴')).textContent).toContain('명조'));
    await click(await tool('글꼴'));
    await click(menuItem('기본'));
    await vi.waitFor(() => expect(prose().querySelector('span[style*="font-family"]')).toBeNull());
    await click(await tool('줄 간격'));
    await click(menuItem('1.5'));
    await vi.waitFor(() => expect(prose().querySelector('[style*="line-height: 1.5"]')).toBeTruthy());
    await click(await tool('줄 간격'));
    await click(menuItem('기본'));
    await vi.waitFor(() => expect(prose().querySelector('[style*="line-height"]')).toBeNull());
    await selectAll();
    await clickTool('글자 크게');
    await vi.waitFor(() => expect(prose().querySelector('span[style*="font-size: 16px"]')).toBeTruthy());
    await vi.waitFor(() => expect((document.querySelector('.doc-size-input') as HTMLInputElement).value).toBe('16'));
    await clickTool('글자 작게');
    await clickTool('글자 작게');
    await vi.waitFor(() => expect(prose().querySelector('span[style*="font-size: 14px"]')).toBeTruthy());
    const sizeInput = document.querySelector<HTMLInputElement>('.doc-size-input')!;
    await userEvent.fill(sizeInput, '24');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(prose().querySelector('span[style*="font-size: 24px"]')).toBeTruthy());
    // blur 커밋
    await selectAll();
    const sizeInput2 = document.querySelector<HTMLInputElement>('.doc-size-input')!;
    await userEvent.fill(sizeInput2, '15');
    fireEvent.focusOut(sizeInput2);
    await vi.waitFor(() => expect(prose().querySelector('span[style*="font-size"]')).toBeNull());
    // 색
    await selectAll();
    await clickTool('글자색');
    const swatch = document.querySelector<HTMLElement>('.doc-dd.sw button[style*="background"]:not([title="기본"])');
    await click(swatch ?? document.querySelectorAll<HTMLElement>('.doc-dd.sw button')[2]);
    await vi.waitFor(() => expect(prose().querySelector('span[style*="color"]')).toBeTruthy());
    await clickTool('형광펜');
    await click(document.querySelectorAll<HTMLElement>('.doc-dd.sw button')[3]);
    await vi.waitFor(() => expect(prose().querySelector('mark')).toBeTruthy());
    await clickTool('형광펜');
    await click(document.querySelector<HTMLElement>('.doc-dd.sw button')!); // 형광펜 없음
    await vi.waitFor(() => expect(prose().querySelector('mark')).toBeNull());
    await clickTool('글자색');
    await click(document.querySelector<HTMLElement>('.doc-dd.sw button')!); // 기본
    await vi.waitFor(() => expect(prose().querySelector('span[style*="color"]')).toBeNull());
  });

  it('링크 적용/제거, 3×3 표 삽입·행/열 조작·삭제, 찾기/바꾸기', async () => {
    await render(<DocEditor roomId="doc-4" />);
    await vi.waitFor(() => expect(prose()).toBeTruthy());
    await typeInDoc('exist site');
    await selectAll();
    await clickTool('링크');
    await userEvent.fill(document.querySelector('.doc-find input[placeholder="https://…"]')!, 'exist.sofie.co.kr');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(prose().querySelector('a')?.getAttribute('href')).toBe('https://exist.sofie.co.kr'));
    await clickTool('링크');
    expect((document.querySelector('.doc-find input') as HTMLInputElement).value).toBe('https://exist.sofie.co.kr');
    await click([...document.querySelectorAll<HTMLElement>('.doc-find button')].find((b) => b.textContent === '링크 제거')!);
    await vi.waitFor(() => expect(prose().querySelector('a')).toBeNull());
    // 빈 URL 적용 = 링크 해제 경로
    await clickTool('링크');
    await click(document.querySelector('.doc-find-go')!);
    // 표
    await userEvent.keyboard('{End}{Enter}');
    await clickTool('표');
    await click(menuItem('3×3 표 삽입'));
    await vi.waitFor(() => expect(prose().querySelectorAll('table tr')).toHaveLength(3));
    expect(prose().querySelectorAll('th')).toHaveLength(3);
    await clickTool('표');
    await click(menuItem('행 추가'));
    await vi.waitFor(() => expect(prose().querySelectorAll('table tr')).toHaveLength(4));
    await click(menuItem('열 추가'));
    await vi.waitFor(() => expect(prose().querySelectorAll('table tr:first-child th')).toHaveLength(4));
    await click(menuItem('행 삭제')); // 커서가 있던 머리글 행이 지워짐
    await vi.waitFor(() => expect(prose().querySelectorAll('th')).toHaveLength(0));
    await click(menuItem('열 삭제'));
    await vi.waitFor(() => expect(prose().querySelectorAll('table tr:first-child td')).toHaveLength(3));
    await click(menuItem('머리글 행 전환'));
    await vi.waitFor(() => expect(prose().querySelectorAll('th')).toHaveLength(3));
    await click(menuItem('표 삭제'));
    await vi.waitFor(() => expect(prose().querySelector('table')).toBeNull());
    // 찾기/바꾸기
    await selectAll();
    await userEvent.keyboard('Hello world hello');
    await clickTool('찾기/바꾸기');
    await userEvent.fill(document.querySelector('.doc-find input[placeholder="찾을 내용"]')!, 'hello');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(document.querySelector('.doc-find-count')?.textContent).toBe('2개 일치'));
    await userEvent.fill(document.querySelector('.doc-find input[placeholder="바꿀 내용"]')!, 'bye');
    await click([...document.querySelectorAll<HTMLElement>('.doc-find button')].find((b) => b.textContent === '바꾸기')!);
    await vi.waitFor(() => expect(prose().textContent).toContain('bye'));
    await click([...document.querySelectorAll<HTMLElement>('.doc-find button')].find((b) => b.textContent === '모두 바꾸기')!);
    await vi.waitFor(() => expect(prose().textContent).toBe('bye world bye'));
    expect(document.querySelector('.doc-find-count')?.textContent).toBe('결과 없음');
    await click([...document.querySelectorAll<HTMLElement>('.doc-find button')].find((b) => b.textContent === '모두 바꾸기')!);
    await userEvent.fill(document.querySelector('.doc-find input[placeholder="찾을 내용"]')!, 'zzz');
    await click(document.querySelector('.doc-find-go')!);
    expect(document.querySelector('.doc-find-count')?.textContent).toBe('결과 없음');
    fireEvent.click(document.querySelector('.doc-dd-back')!);
    await vi.waitFor(() => expect(document.querySelector('.doc-find')).toBeNull());
  });

  it('댓글 — 선택 후 스레드 생성·답글·해결·삭제, 마크 클릭으로 패널, 배지', async () => {
    await render(<DocEditor roomId="doc-5" />);
    await vi.waitFor(() => expect(prose()).toBeTruthy());
    const commentBtn = () => document.querySelector<HTMLElement>('button[title^="댓글"]')!;
    // 선택 없이 → 패널 토글만
    await userEvent.click(commentBtn());
    expect(document.querySelector('.doc-cpanel-empty')).toBeInTheDocument();
    await userEvent.click(document.querySelector('.doc-cpanel-close')!);
    expect(document.querySelector('.doc-comments-panel')).toBeNull();
    await typeInDoc('review this line');
    await userEvent.keyboard('{Home}{Shift>}{End}{/Shift}');
    await userEvent.click(commentBtn());
    expect(document.querySelector('.doc-cthread-anchor')?.textContent).toContain('review this line');
    await userEvent.fill(document.querySelector('.doc-cthread.new textarea')!, '오타 확인');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(prose().querySelector('.doc-comment-mark')).toBeTruthy());
    expect(document.querySelector('.doc-cbadge')?.textContent).toBe('1');
    expect(document.querySelector('.doc-cthread.active .doc-cthread-text')?.textContent).toBe('오타 확인');
    // 답글
    await userEvent.fill(document.querySelector('.doc-creply-row input')!, '고쳤어요');
    await userEvent.click(document.querySelector('.doc-creply-row button')!);
    await vi.waitFor(() => expect(document.querySelector('.doc-creply .doc-cthread-text')?.textContent).toBe('고쳤어요'));
    // 스레드 클릭 → 본문 점프, 마크 클릭 → 패널 활성
    await userEvent.click(document.querySelector('.doc-cthread .doc-cthread-meta')!);
    await userEvent.click(document.querySelector('.doc-cpanel-close')!);
    await userEvent.click(prose().querySelector('.doc-comment-mark')!);
    await vi.waitFor(() => expect(document.querySelector('.doc-cthread.active')).toBeTruthy());
    // 해결 → 마크 제거 + 해결됨 목록
    await userEvent.click(document.querySelector('.doc-cthread-btns .primary')!);
    await vi.waitFor(() => expect(prose().querySelector('.doc-comment-mark')).toBeNull());
    expect(document.querySelector('.doc-cbadge')).toBeNull();
    expect(document.querySelector('.doc-cresolved summary')?.textContent).toContain('해결됨 1개');
    (document.querySelector('.doc-cresolved') as HTMLDetailsElement).open = true;
    await userEvent.click(document.querySelector('.doc-cthread.resolved .danger')!);
    await vi.waitFor(() => expect(document.querySelector('.doc-cresolved')).toBeNull());
    // 두 번째 스레드 — 취소 / 삭제 경로
    await clickProse();
    await userEvent.keyboard('{Home}{Shift>}{End}{/Shift}');
    await userEvent.click(commentBtn());
    await userEvent.click([...document.querySelectorAll<HTMLElement>('.doc-cthread.new button')].find((b) => b.textContent === '취소')!);
    expect(document.querySelector('.doc-cthread.new')).toBeNull();
    await clickProse();
    await userEvent.keyboard('{Home}{Shift>}{End}{/Shift}');
    await userEvent.click(commentBtn());
    await userEvent.fill(document.querySelector('.doc-cthread.new textarea')!, '삭제될 댓글');
    await userEvent.click(document.querySelector('.doc-cthread.new .primary')!);
    await vi.waitFor(() => expect(prose().querySelector('.doc-comment-mark')).toBeTruthy());
    await userEvent.click(document.querySelector('.doc-cthread-btns .danger')!);
    await vi.waitFor(() => expect(prose().querySelector('.doc-comment-mark')).toBeNull());
  });

  it('변경이력 — 수동 저장, 미리보기, 현재와 비교(diff), 복원(confirm)', async () => {
    await render(<DocEditor roomId="doc-6" />);
    await vi.waitFor(() => expect(prose()).toBeTruthy());
    await typeInDoc('first draft');
    await userEvent.click(document.querySelector('button[title="변경이력"]')!);
    expect(document.querySelector('.doc-vers-list .doc-cpanel-empty')).toBeInTheDocument();
    await userEvent.click(document.querySelector('.doc-vers-save')!);
    await vi.waitFor(() => expect(document.querySelectorAll('.doc-vers-row')).toHaveLength(1));
    await userEvent.click(document.querySelector('.doc-vers-save')!); // 같은 내용 — 중복 저장 안 함
    expect(document.querySelectorAll('.doc-vers-row')).toHaveLength(1);
    expect(document.querySelector('.doc-vers-label')?.textContent).toBe('수동');
    fireEvent.click(document.querySelector('.modal-overlay')!);
    await vi.waitFor(() => expect(document.querySelector('.doc-vers-card')).toBeNull());
    await clickProse();
    await userEvent.keyboard('{End} second');
    await vi.waitFor(() => expect(prose().textContent).toBe('first draft second'));
    await userEvent.click(document.querySelector('button[title="변경이력"]')!);
    await userEvent.click(document.querySelector('.doc-vers-row')!);
    expect(document.querySelector('.doc-vers-preview .doc-prose')?.textContent).toBe('first draft');
    await userEvent.click([...document.querySelectorAll<HTMLElement>('.doc-vers-pbtns button')].find((b) => b.textContent === '현재와 비교')!);
    const diff = document.querySelector('.doc-vers-diff')!;
    expect(diff.querySelector('.add')?.textContent?.trim()).toBe('second');
    expect(diff.querySelectorAll('.del')).toHaveLength(0);
    await userEvent.click(document.querySelector('.doc-vers-back')!);
    await userEvent.click(document.querySelector('.doc-vers-row')!);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(document.querySelector('.doc-vers-pbtns .primary')!);
    expect(document.querySelector('.doc-vers-card')).toBeInTheDocument();
    confirm.mockReturnValue(true);
    await userEvent.click(document.querySelector('.doc-vers-pbtns .primary')!);
    await vi.waitFor(() => expect(prose().textContent).toBe('first draft'));
    expect(document.querySelector('.doc-vers-card')).toBeNull();
    await userEvent.click(document.querySelector('button[title="변경이력"]')!);
    expect(document.querySelectorAll('.doc-vers-row')).toHaveLength(2); // '복원 전' 스냅샷 추가
    expect([...document.querySelectorAll('.doc-vers-label')].map((e) => e.textContent)).toContain('복원 전');
    // 차이 없음 케이스
    await userEvent.click(document.querySelectorAll('.doc-vers-row')[1]!);
    await userEvent.click([...document.querySelectorAll<HTMLElement>('.doc-vers-pbtns button')].find((b) => b.textContent === '현재와 비교')!);
    expect(document.querySelector('.doc-vers-preview .doc-cpanel-empty')?.textContent).toContain('차이가 없어요');
  });

  it('문서 탭 — 새 문서·이름 변경·삭제(confirm, 최소 1개 유지)', async () => {
    await render(<DocEditor roomId="doc-7" />);
    await vi.waitFor(() => expect(prose()).toBeTruthy());
    expect(document.querySelector('.doc-tab-close')).toBeNull();
    await userEvent.click(document.querySelector('.doc-newtab')!);
    await vi.waitFor(() => expect(tabNames()).toEqual(['문서 1', '문서 2']));
    expect(document.querySelector('.doc-tab.active .doc-tab-name')?.textContent).toBe('문서 2');
    await typeInDoc('two');
    await userEvent.click(document.querySelectorAll('.doc-tab')[0]);
    await vi.waitFor(() => expect(prose().textContent).toBe(''));
    await userEvent.dblClick(document.querySelectorAll('.doc-tab')[0]);
    const input = document.querySelector<HTMLInputElement>('.doc-tab-input')!;
    await userEvent.fill(input, '기획안');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(tabNames()).toEqual(['기획안', '문서 2']));
    await userEvent.dblClick(document.querySelectorAll('.doc-tab')[1]);
    await userEvent.keyboard('{Escape}');
    expect(document.querySelector('.doc-tab-input')).toBeNull();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(document.querySelectorAll('.doc-tab-close')[1]);
    expect(tabNames()).toHaveLength(2);
    confirm.mockReturnValue(true);
    await userEvent.click(document.querySelectorAll('.doc-tab-close')[1]);
    await vi.waitFor(() => expect(tabNames()).toEqual(['기획안']));
  });

  it('내보내기 — HTML/텍스트 다운로드, Word는 exportDocx, PDF/인쇄는 window.print', async () => {
    const dl = captureDownloads();
    await render(<DocEditor roomId="doc-8" />);
    await vi.waitFor(() => expect(prose()).toBeTruthy());
    await typeInDoc('export me');
    const openExport = () => userEvent.click(document.querySelector('button[title="내보내기"]')!);
    await openExport();
    await click(menuItem('HTML (.html)'));
    await vi.waitFor(() => expect(dl.got).toHaveLength(1));
    expect(dl.last().name).toBe('문서 1.html');
    expect(await dl.text()).toContain('<p>export me</p>');
    await openExport();
    await click(menuItem('텍스트 (.txt)'));
    await vi.waitFor(() => expect(dl.got).toHaveLength(2));
    expect(dl.last().name).toBe('문서 1.txt');
    expect(await dl.text()).toContain('export me');
    await openExport();
    await click(menuItem('Word (.docx)'));
    expect(exportDocx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(exportDocx).mock.calls[0][0]).toBe('문서 1');
    expect(vi.mocked(exportDocx).mock.calls[0][1]).toMatchObject({ type: 'doc' });
    await openExport();
    await click(menuItem('PDF / 인쇄'));
    await vi.waitFor(() => expect(window.print).toHaveBeenCalled());
    expect(document.body.classList.contains('doc-printing')).toBe(true);
    window.dispatchEvent(new Event('afterprint'));
    await vi.waitFor(() => expect(document.body.classList.contains('doc-printing')).toBe(false));
    await openExport();
    fireEvent.click(document.querySelector('.doc-dd-back')!);
    await vi.waitFor(() => expect(document.querySelector('.doc-dd')).toBeNull());
  });

  it('이미지 — 드롭·파일 선택·붙여넣기 → 리사이즈 후 data URL로 본문 삽입', async () => {
    await render(<DocEditor roomId="doc-9" />);
    await vi.waitFor(() => expect(prose()).toBeTruthy());
    await typeInDoc('plain text');
    // 드롭 — ProseMirror는 드롭 좌표(elementFromPoint)로 위치를 먼저 잡는다: 텍스트 문단 한가운데로
    const dt2 = new DataTransfer();
    dt2.items.add(await makePngFile('c.png'));
    const para = prose().querySelector('p')!;
    const pr = para.getBoundingClientRect();
    const dropInit = { dataTransfer: dt2, bubbles: true, cancelable: true, clientX: pr.left + 8, clientY: pr.top + pr.height / 2 };
    para.dispatchEvent(new DragEvent('dragover', dropInit));
    para.dispatchEvent(new DragEvent('drop', dropInit));
    await vi.waitFor(() => expect(prose().querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png/), { timeout: 3000 });
    // 삽입 직후 커서가 이미지 뒤 텍스트 위치여야 다음 삽입이 이 이미지를 덮어쓰지 않는다 (NodeSelection 잔류 버그 회귀)
    expect(prose().querySelector('.ProseMirror-selectednode')).toBeNull();
    // 파일 선택 (툴바 이미지 버튼 → 숨은 input)
    const png = await makePngFile('a.png');
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await clickTool('이미지 삽입');
    expect(clickSpy).toHaveBeenCalled();
    setInputFiles(document.querySelector<HTMLInputElement>('.doc-editor-bar input[type="file"]')!, [png]);
    await vi.waitFor(() => expect(prose().querySelectorAll('img')).toHaveLength(2), { timeout: 3000 });
    // 붙여넣기 (jpeg → jpeg 인코딩 경로)
    const jpg = new File([await (await makePngFile('b.jpg')).arrayBuffer()], 'b.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer();
    dt.items.add(jpg);
    await clickProse();
    await userEvent.keyboard('{End}');
    prose().dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(prose().querySelectorAll('img')).toHaveLength(3), { timeout: 3000 });
    expect([...prose().querySelectorAll('img')].some((i) => /^data:image\/jpeg/.test(i.getAttribute('src') ?? ''))).toBe(true);
    // 이미지 없는 붙여넣기는 기본 동작
    const dt3 = new DataTransfer();
    dt3.setData('text/plain', ' pasted');
    prose().dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt3, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(prose().textContent).toContain('pasted'));
  });

  it('@멘션 — 그룹 참가자 검색 팝업, 방향키·Enter 선택 → 멘션 노드 + POST mention, Esc 닫기', async () => {
    m.get('/api/meetings/ABCD', {
      participants: [
        { username: 'kim', name: '김대리', avatar: null },
        { username: 'kwon', name: null, avatar: '/api/avatar/1.png' },
        { username: 'lee', name: '이과장', avatar: '🙂' },
      ],
    });
    m.post(/\/files\/7\/mention$/, {});
    await render(<DocEditor roomId="doc-10" code="ABCD" fileId={7} />);
    await vi.waitFor(() => expect(prose()).toBeTruthy());
    await vi.waitFor(() => expect(m.calls('GET', '/api/meetings/ABCD')).toHaveLength(1));
    await tick(20);
    await clickProse();
    await userEvent.keyboard('@k');
    await vi.waitFor(() => expect(document.querySelectorAll('.doc-mention-row')).toHaveLength(2));
    expect(document.querySelector('.doc-mention-row.on')?.textContent).toContain('김대리 (@kim)');
    expect(document.querySelectorAll('.doc-mention-row')[1].textContent).toContain('@kwon');
    expect(document.querySelector('.doc-mention-row img')).toBeTruthy();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.querySelector('.doc-mention-row.on')?.textContent).toContain('@kwon');
    await userEvent.keyboard('{ArrowUp}');
    expect(document.querySelector('.doc-mention-row.on')?.textContent).toContain('김대리');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(prose().querySelector('.doc-mention')?.textContent).toContain('김대리'));
    await vi.waitFor(() => expect(m.calls('POST', /\/mention$/)).toHaveLength(1));
    expect(m.last('POST', /\/mention$/).body).toEqual({ username: 'kim' });
    expect(document.querySelector('.doc-mention-pop')).toBeNull();
    // 없는 사람 → 참가자 없음, Esc로 닫기
    await userEvent.keyboard(' @zz');
    await vi.waitFor(() => expect(document.querySelector('.doc-mention-empty')).toBeTruthy());
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(document.querySelector('.doc-mention-pop')).toBeNull());
    // 마우스로 선택
    await userEvent.keyboard(' @lee');
    await vi.waitFor(() => expect(document.querySelector('.doc-mention-row')).toBeTruthy());
    fireEvent.mouseDown(document.querySelector('.doc-mention-row')!);
    await vi.waitFor(() => expect(prose().querySelectorAll('.doc-mention')).toHaveLength(2));
  });

  it('active=false면 awareness를 내리고 복귀하면 다시 올림, 언마운트 시 provider 정리', async () => {
    const { rerender, unmount } = await render(<DocEditor roomId="doc-11" />);
    await vi.waitFor(() => expect(prose()).toBeTruthy());
    const p = provider();
    await vi.waitFor(() => expect(p.awareness.getLocalState()?.user).toMatchObject({ name: '이주호' }));
    await rerender(<DocEditor roomId="doc-11" active={false} />);
    await vi.waitFor(() => expect(p.awareness.getLocalState()).toBeNull());
    await rerender(<DocEditor roomId="doc-11" active />);
    await vi.waitFor(() => expect(p.awareness.getLocalState()?.user).toMatchObject({ name: '이주호' }));
    unmount();
    expect(p.destroyed).toBe(true);
  });
});
