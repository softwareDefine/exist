import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { fireEvent } from '@testing-library/dom';
import { login } from '../../test/auth';
import { mockApi } from '../../test/mockApi';
import { captureDownloads, dragAndDrop } from '../../test/browser';

vi.mock('y-websocket', () => import('../../test/yws.mock'));

import { WebsocketProvider } from '../../test/yws.mock';
import CodeDocEditor from '../CodeDocEditor';

const cm = () => document.querySelector<HTMLElement>('.cm-content')!;
const provider = () => WebsocketProvider.instances.at(-1)!;
const fileNames = () =>
  [...document.querySelectorAll('.vsc-files .vsc-file:not(.creating)')].map((e) => e.getAttribute('title'));
const outLines = () => [...document.querySelectorAll('.vsc-out-line')].map((e) => e.textContent);
const status = () => document.querySelector('.vsc-status-right')?.textContent ?? '';
const runBtn = () => document.querySelector<HTMLButtonElement>('.vsc-run')!;

/** userEvent.keyboard는 { [ 를 특수문자로 읽는다 — 코드 입력이라 이스케이프 */
const kb = (s: string) => s.replace(/\{/g, '{{').replace(/\[/g, '[[');
async function typeInEditor(text: string) {
  await userEvent.click(cm());
  await userEvent.keyboard(kb(text));
}
/** 탐색기 ＋ → 이름 입력 → Enter (확장자 있으면 파일, 없으면 폴더) */
async function createEntry(name: string) {
  await userEvent.click(document.querySelector('.vsc-newfile')!);
  const input = document.querySelector<HTMLInputElement>('.vsc-file-input')!;
  await userEvent.fill(input, name);
  await userEvent.keyboard('{Enter}');
  await vi.waitFor(() => expect(document.querySelector('.vsc-file-input')).toBeNull());
}
const ytext = (name: string) => {
  const files = provider().doc.getMap<{ name: string }>('files');
  const id = [...files.entries()].find(([, v]) => v.name === name)?.[0];
  return provider().doc.getText(`file:${id}`);
};

describe('CodeDocEditor (CodeMirror, Chromium)', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    login({ id: 1, username: 'juho', name: '이주호' });
    WebsocketProvider.instances.length = 0;
  });
  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('동기화 후 main.js 생성 → 타이핑이 Y.Text에 반영, 줄/열 상태바, 언어 라벨', async () => {
    await render(<CodeDocEditor roomId="code-1" />);
    await vi.waitFor(() => expect(fileNames()).toEqual(['main.js']));
    await vi.waitFor(() => expect(cm()).toBeTruthy());
    await typeInEditor('const a = 1;');
    await vi.waitFor(() => expect(ytext('main.js').toString()).toBe('const a = 1;'));
    expect(status()).toContain('줄 1, 열 13');
    expect(status()).toContain('JavaScript');
    expect(document.querySelector('.vsc-status-left')?.textContent).toContain('연결됨');
    expect(document.querySelector('.vsc-status-left')?.textContent).toContain('1명 참여');
    // 원격 참가자 — awareness 변화로 N명 갱신
    provider().awareness.states.set(77, { user: { name: '김대리', color: '#e5484d' } });
    provider().awareness.emit('change', [{ added: [77], updated: [], removed: [] }, 'remote']);
    await vi.waitFor(() => expect(document.querySelector('.vsc-status-left')?.textContent).toContain('2명 참여'));
  });

  it('JavaScript 실행 — 진짜 Worker: console.log/error/반환값 → 출력 패널, 지우기·닫기', async () => {
    await render(<CodeDocEditor roomId="code-2" />);
    await vi.waitFor(() => expect(cm()).toBeTruthy());
    await typeInEditor('console.log("hi", {a:1}); console.warn("w"); console.error("bad"); return 1+1');
    await userEvent.click(runBtn());
    await vi.waitFor(() => expect(outLines()).toContain('✓ 완료'), { timeout: 5000 });
    expect(outLines()).toEqual(['hi {"a":1}', 'w', 'bad', '2', '✓ 완료']);
    expect(document.querySelector('.vsc-out-line.error')?.textContent).toBe('bad');
    expect(document.querySelector('.vsc-out-line.warn')?.textContent).toBe('w');
    await userEvent.click(document.querySelector('.vsc-output-tools button[title="지우기"]')!);
    expect(outLines()).toEqual(['실행 결과가 여기 표시돼요']);
    await userEvent.click(document.querySelector('.vsc-output-tools button[title="닫기"]')!);
    expect(document.querySelector('.vsc-output')).toBeNull();
  });

  it('JavaScript 런타임 에러 → 스택이 error 줄로', async () => {
    await render(<CodeDocEditor roomId="code-2e" />);
    await vi.waitFor(() => expect(cm()).toBeTruthy());
    await typeInEditor('throw new Error("boom")');
    await userEvent.click(runBtn());
    await vi.waitFor(() => expect(outLines()).toContain('✓ 완료'), { timeout: 5000 });
    expect(document.querySelector('.vsc-out-line.error')?.textContent).toContain('boom');
  });

  it('서버 실행(.cpp) → POST /api/run/exec {lang, entry, files}, 실패 시 에러 줄', async () => {
    m.post('/api/run/exec', { lines: [{ type: 'log', text: '42' }] });
    await render(<CodeDocEditor roomId="code-3" />);
    await vi.waitFor(() => expect(cm()).toBeTruthy());
    await createEntry('a.cpp');
    await vi.waitFor(() => expect(fileNames()).toEqual(['main.js', 'a.cpp']));
    expect(document.querySelector('.vsc-file.active')?.getAttribute('title')).toBe('a.cpp');
    expect(status()).toContain('C/C++');
    await typeInEditor('int main(){}');
    await userEvent.click(runBtn());
    await vi.waitFor(() => expect(outLines()).toEqual(['42']));
    const body = m.last('POST', '/api/run/exec').body as { lang: string; entry: string; files: { path: string; content: string }[] };
    expect(body.lang).toBe('cpp');
    expect(body.entry).toBe('a.cpp');
    expect(body.files).toEqual(
      expect.arrayContaining([{ path: 'a.cpp', content: 'int main(){}' }, { path: 'main.js', content: '' }]),
    );
    // 빈 출력
    m.post('/api/run/exec', { lines: [] });
    await userEvent.click(runBtn());
    await vi.waitFor(() => expect(outLines()).toEqual(['(출력 없음)']));
    // 실패
    m.fail('POST', '/api/run/exec', 500, 'compiler missing');
    await userEvent.click(runBtn());
    await vi.waitFor(() => expect(outLines()[0]).toContain('서버 실행 실패'));
    expect(outLines()[0]).toContain('compiler missing');
  });

  it('SQL 실행 → POST /api/run/sql {sql}; 미지원 확장자는 실행 버튼 비활성', async () => {
    m.post('/api/run/sql', { lines: [{ type: 'log', text: 'id | name' }] });
    await render(<CodeDocEditor roomId="code-4" />);
    await vi.waitFor(() => expect(cm()).toBeTruthy());
    await createEntry('q.sql');
    await typeInEditor('select 1');
    expect(status()).toContain('SQL');
    await userEvent.click(runBtn());
    await vi.waitFor(() => expect(outLines()).toEqual(['id | name']));
    expect(m.last('POST', '/api/run/sql').body).toEqual({ sql: 'select 1' });
    m.fail('POST', '/api/run/sql', 400, 'syntax');
    await userEvent.click(runBtn());
    await vi.waitFor(() => expect(outLines()[0]).toContain('SQL 실행 실패'));
    await createEntry('notes.md');
    expect(status()).toContain('Markdown');
    expect(runBtn()).toBeDisabled();
    expect(runBtn().title).toBe('실행 미지원 파일');
    await createEntry('readme.txt');
    expect(status()).toContain('일반 텍스트');
  });

  it('폴더 생성 → 현재 폴더 안에 파일 생성, 접기/펴기, 드래그로 이동(루트↔폴더), 폴더 삭제(confirm)', async () => {
    await render(<CodeDocEditor roomId="code-5" />);
    await vi.waitFor(() => expect(cm()).toBeTruthy());
    await createEntry('src');
    await vi.waitFor(() => expect(fileNames()).toEqual(['src', 'main.js']));
    expect(document.querySelector('.vsc-curdir')?.textContent).toContain('src/');
    await createEntry('util.ts');
    await vi.waitFor(() => expect(fileNames()).toEqual(['src', 'src/util.ts', 'main.js']));
    expect(status()).toContain('TypeScript');
    // 접기 → 하위 숨김, 다시 펴기
    const folder = () => document.querySelector('.vsc-folder')!;
    await userEvent.click(folder());
    await vi.waitFor(() => expect(fileNames()).toEqual(['src', 'main.js']));
    await userEvent.click(folder());
    await vi.waitFor(() => expect(fileNames()).toEqual(['src', 'src/util.ts', 'main.js']));
    // 루트 파일을 폴더로 드래그
    const mainRow = () => document.querySelector('.vsc-file[title="main.js"]')!;
    dragAndDrop(mainRow(), folder());
    await vi.waitFor(() => expect(fileNames()).toEqual(['src', 'src/main.js', 'src/util.ts']));
    // 폴더 안 파일을 루트(.vsc-files 빈 영역)로
    dragAndDrop(document.querySelector('.vsc-file[title="src/util.ts"]')!, document.querySelector('.vsc-files')!);
    await vi.waitFor(() => expect(fileNames()).toEqual(['src', 'src/main.js', 'util.ts']));
    // 최상위로 버튼
    await userEvent.click(document.querySelector('button[title="최상위로"]')!);
    expect(document.querySelector('.vsc-curdir')).toBeNull();
    // 폴더 삭제 — 취소하면 그대로, 확인하면 하위까지 삭제
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(document.querySelector('.vsc-folder .vsc-file-del')!);
    expect(fileNames()).toHaveLength(3);
    confirm.mockReturnValue(true);
    await userEvent.click(document.querySelector('.vsc-folder .vsc-file-del')!);
    await vi.waitFor(() => expect(fileNames()).toEqual(['util.ts']));
    expect(document.querySelector('.vsc-file.active')?.getAttribute('title')).toBe('util.ts');
  });

  it('탭 열기/닫기, 파일 삭제(confirm), 마지막 파일 삭제 → 빈 안내', async () => {
    await render(<CodeDocEditor roomId="code-6" />);
    await vi.waitFor(() => expect(cm()).toBeTruthy());
    await createEntry('b.js');
    await vi.waitFor(() => expect(document.querySelectorAll('.vsc-tab')).toHaveLength(2));
    await userEvent.click(document.querySelector('.vsc-file[title="main.js"]')!);
    expect(document.querySelector('.vsc-tab.active')?.textContent).toContain('main.js');
    // 활성 탭 닫기 → 남은 탭이 활성
    await userEvent.click(document.querySelector('.vsc-tab.active .vsc-tab-close')!);
    await vi.waitFor(() => expect(document.querySelectorAll('.vsc-tab')).toHaveLength(1));
    expect(document.querySelector('.vsc-tab.active')?.textContent).toContain('b.js');
    // 삭제
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(document.querySelector('.vsc-file[title="b.js"] .vsc-file-del')!);
    await vi.waitFor(() => expect(fileNames()).toEqual(['main.js']));
    await userEvent.click(document.querySelector('.vsc-file[title="main.js"] .vsc-file-del')!);
    await vi.waitFor(() => expect(document.querySelector('.vsc-welcome')).toBeInTheDocument());
    expect(document.querySelector('.vsc-empty')?.textContent).toContain('파일/폴더를 만들어보세요');
    // Escape로 생성 취소
    await userEvent.click(document.querySelector('.vsc-newfile')!);
    await userEvent.keyboard('{Escape}');
    expect(document.querySelector('.vsc-file-input')).toBeNull();
  });

  it('zip 내보내기 — 파일 내용·빈 폴더 포함, project_<id>.zip', async () => {
    const dl = captureDownloads();
    await render(<CodeDocEditor roomId="code-7" />);
    await vi.waitFor(() => expect(cm()).toBeTruthy());
    await typeInEditor('x');
    await createEntry('empty');
    await userEvent.click(document.querySelector('button[title="전체 프로젝트 zip 내보내기"]')!);
    await vi.waitFor(() => expect(dl.got).toHaveLength(1));
    expect(dl.last().name).toBe('project_7.zip');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await dl.last().blob!.arrayBuffer());
    expect(await zip.file('main.js')!.async('string')).toBe('x');
    expect(zip.files['empty/']?.dir).toBe(true);
  });

  it('git 업로드 — 원격·토큰 입력 후 푸시 → POST /api/run/git, 원격은 localStorage에', async () => {
    m.post('/api/run/git', { lines: [{ type: 'info', text: 'pushed' }] });
    await render(<CodeDocEditor roomId="code-8" />);
    await vi.waitFor(() => expect(cm()).toBeTruthy());
    await userEvent.click(document.querySelector('button[title="Git 업로드(push)"]')!);
    const push = () => document.querySelector<HTMLButtonElement>('.vsc-git-push')!;
    expect(push()).toBeDisabled();
    await userEvent.fill(document.querySelector('.vsc-git-menu input[placeholder^="원격 URL"]')!, 'https://github.com/u/r.git');
    await userEvent.fill(document.querySelector('.vsc-git-menu input[type="password"]')!, 'tok');
    await userEvent.fill(document.querySelector('.vsc-git-menu input[placeholder="브랜치"]')!, 'dev');
    await userEvent.fill(document.querySelector('.vsc-git-menu input[placeholder="커밋 메시지"]')!, 'msg');
    expect(push()).not.toBeDisabled();
    await userEvent.click(push());
    await vi.waitFor(() => expect(outLines()).toEqual(['pushed']));
    expect(m.last('POST', '/api/run/git').body).toMatchObject({
      remote: 'https://github.com/u/r.git',
      token: 'tok',
      branch: 'dev',
      message: 'msg',
      files: [{ path: 'main.js', content: '' }],
    });
    expect(localStorage.getItem('exist:git-remote')).toBe('https://github.com/u/r.git');
    // 실패 경로 + 배경 클릭으로 메뉴 닫기
    m.fail('POST', '/api/run/git', 500, 'auth');
    await userEvent.click(document.querySelector('button[title="Git 업로드(push)"]')!);
    await userEvent.click(push());
    await vi.waitFor(() => expect(outLines()[0]).toContain('git 실패'));
    await userEvent.click(document.querySelector('button[title="Git 업로드(push)"]')!);
    expect(document.querySelector('.vsc-git-menu')).toBeInTheDocument();
    fireEvent.click(document.querySelector('.vsc-git-back')!);
    await vi.waitFor(() => expect(document.querySelector('.vsc-git-menu')).toBeNull());
  });

  it('앱 다크모드(html.dark) 추종, 이웃 문서 전환, 모바일 서랍 토글, active=false면 awareness 내림', async () => {
    const onOpenSibling = vi.fn();
    const { rerender, unmount } = await render(
      <CodeDocEditor
        roomId="code-9"
        siblings={[
          { id: 1, name: '나', type: 'code' },
          { id: 2, name: '기획.doc', type: 'doc' },
          { id: 3, name: '표', type: 'sheet' },
          { id: 4, name: '발표', type: 'slide' },
          { id: 5, name: '보드', type: 'canvas' },
        ]}
        currentSibId={1}
        onOpenSibling={onOpenSibling}
      />,
    );
    await vi.waitFor(() => expect(cm()).toBeTruthy());
    expect(document.querySelector('.vsc')).toHaveClass('light');
    document.documentElement.classList.add('dark');
    await vi.waitFor(() => expect(document.querySelector('.vsc')).toHaveClass('dark'));
    expect(document.querySelector('.cm-editor')).toBeTruthy();
    // 이웃 문서
    const sibs = document.querySelectorAll('.vsc-sib');
    expect(sibs).toHaveLength(5);
    expect(sibs[0]).toHaveClass('on');
    await userEvent.click(sibs[0]); // 현재 문서는 no-op
    expect(onOpenSibling).not.toHaveBeenCalled();
    await userEvent.click(sibs[1]);
    expect(onOpenSibling).toHaveBeenCalledWith(2);
    // 모바일 서랍 — 데스크톱 폭에선 CSS로 숨긴 버튼이라 DOM 이벤트로 직접
    fireEvent.click(document.querySelector('.vsc-side-toggle')!);
    await vi.waitFor(() => expect(document.querySelector('.vsc-sidebar')).toHaveClass('m-open'));
    fireEvent.click(document.querySelector('.vsc-side-scrim')!);
    await vi.waitFor(() => expect(document.querySelector('.vsc-sidebar')).not.toHaveClass('m-open'));
    // awareness
    const p = provider();
    expect(p.awareness.getLocalState()?.user).toMatchObject({ name: '이주호' });
    await rerender(<CodeDocEditor roomId="code-9" active={false} />);
    await vi.waitFor(() => expect(p.awareness.getLocalState()).toBeNull());
    await rerender(<CodeDocEditor roomId="code-9" active />);
    await vi.waitFor(() => expect(p.awareness.getLocalState()?.user).toMatchObject({ name: '이주호' }));
    unmount();
    expect(p.destroyed).toBe(true);
  });
});
