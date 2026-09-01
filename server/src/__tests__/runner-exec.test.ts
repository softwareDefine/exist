import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';

/* /api/run — 로컬 직접 실행 모드(CODE_EXEC_ENABLED=1, RUNNER_URL 없음).
 * child_process.spawn 을 가짜 자식으로 바꿔 실제 툴체인 없이 빌드/실행/타임아웃/출력 폭주/git 단계를 본다. */

process.env.CODE_EXEC_ENABLED = '1';
delete process.env.RUNNER_URL;

interface Script {
  stdout?: string;
  chunks?: string[];
  stderr?: string;
  code?: number | null;
  hang?: boolean; // close 를 내지 않음 (타임아웃/강제 종료 시나리오)
  error?: string; // spawn 'error' 이벤트
}
const scripts: { match: RegExp; s: Script }[] = [];
const spawned: { cmd: string; cwd: string; child: FakeChild; cwdSnapshot: string[] }[] = [];

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_sig?: string) => {
    setImmediate(() => this.emit('close', null));
    return true;
  });
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out.sort();
}

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: (cmd: string, opts: { cwd: string }) => {
      const child = new FakeChild();
      const s = scripts.find((x) => x.match.test(cmd))?.s ?? { stdout: '', code: 0 };
      spawned.push({ cmd, cwd: opts.cwd, child, cwdSnapshot: listFiles(opts.cwd) });
      setImmediate(() => {
        if (s.error) {
          child.emit('error', new Error(s.error));
          return;
        }
        for (const c of s.chunks ?? (s.stdout ? [s.stdout] : [])) child.stdout.emit('data', Buffer.from(c));
        if (s.stderr) child.stderr.emit('data', Buffer.from(s.stderr));
        if (s.hang) return;
        child.emit('close', s.code ?? 0);
      });
      return child as unknown as import('node:child_process').ChildProcess;
    },
  };
});

const isWin = process.platform === 'win32';
let app: express.Express;
let token = '';
const auth = () => `Bearer ${token}`;
const exec = (body: unknown) => request(app).post('/api/run/exec').set('Authorization', auth()).send(body);
const git = (body: unknown) => request(app).post('/api/run/git').set('Authorization', auth()).send(body);
const texts = (r: request.Response) => (r.body.lines as { type: string; text: string }[]).map((l) => l.text);

beforeAll(async () => {
  const { default: runnerRouter } = await import('../runner.js');
  const { default: authRouter } = await import('../auth.js');
  app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/run', runnerRouter);
  const r = await request(app).post('/api/auth/register').send({ username: 'run_exec', password: 'password123' });
  token = r.body.token;
});

beforeEach(() => {
  scripts.length = 0;
  spawned.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('/api/run/exec — 직접 실행', () => {
  it('지원하지 않는 언어는 실행 없이 안내', async () => {
    const r = await exec({ lang: 'brainfuck', entry: 'a.bf', files: [] });
    expect(r.body.lines).toEqual([{ type: 'error', text: 'brainfuck 는 서버 실행을 지원하지 않아요' }]);
    expect(spawned.length).toBe(0);
  });

  it('js: 임시 디렉터리에 파일(하위 폴더 보존·상위 탈출 제거)을 쓰고 node 로 실행, stdout 을 줄 단위로, 끝나면 정리', async () => {
    scripts.push({ match: /^node /, s: { stdout: 'hello\r\nworld\n', code: 0 } });
    const r = await exec({
      lang: 'js',
      entry: 'a.js',
      files: [
        { path: 'a.js', content: 'console.log(1)' },
        { path: 'lib/util.js', content: 'x' },
        { path: '../../escape.txt' }, // content 없음 → 빈 파일, 경로는 디렉터리 안으로
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.lines).toEqual([
      { type: 'log', text: 'hello' },
      { type: 'log', text: 'world' },
      { type: 'info', text: '✓ 종료 코드 0' },
    ]);
    expect(spawned.length).toBe(1);
    expect(spawned[0].cmd).toBe('node "a.js"');
    expect(spawned[0].cwd).toMatch(/exist-run-/);
    expect(spawned[0].cwdSnapshot).toEqual(['a.js', 'escape.txt', 'lib/util.js']);
    await vi.waitFor(() => expect(fs.existsSync(spawned[0].cwd)).toBe(false));
  });

  it('실행기 미설치(is not recognized) 는 설치 안내, 그 외 stderr 는 그대로 error', async () => {
    scripts.push({ match: /python/, s: { stderr: "'python' is not recognized as an internal or external command", code: 1 } });
    const r1 = await exec({ lang: 'py', entry: 'm.py', files: [{ path: 'm.py', content: '' }] });
    expect(texts(r1)).toEqual([
      `실행기를 찾을 수 없어요. 서버 PC에 설치가 필요해요 (${isWin ? 'python' : 'python3'}).`,
      '✓ 종료 코드 1',
    ]);
    scripts.length = 0;
    scripts.push({ match: /ruby/, s: { stdout: 'out', stderr: 'Traceback: boom\n', code: 2 } });
    const r2 = await exec({ lang: 'rb', entry: 'm.rb', files: [] });
    expect(texts(r2)).toEqual(['out', 'Traceback: boom', '✓ 종료 코드 2']);
  });

  it('cpp: 컴파일러 없음 → 빌드 실패로 끝나고 실행 단계는 없다', async () => {
    scripts.push({ match: /^g\+\+/, s: { stderr: "'g++' is not recognized as an internal or external command", code: 1 } });
    const r = await exec({
      lang: 'cpp',
      entry: 'main.cpp',
      files: [{ path: 'main.cpp', content: '' }, { path: 'util.cc', content: '' }, { path: 'README.md', content: '' }],
    });
    expect(r.body.lines.map((l: { type: string }) => l.type)).toEqual(['error', 'error', 'error']);
    expect(texts(r)[1]).toBe('컴파일러를 찾을 수 없어요. 서버 PC에 설치가 필요해요 (g++).');
    expect(texts(r)[2]).toBe('✗ 빌드 실패');
    expect(spawned.length).toBe(1);
    expect(spawned[0].cmd).toBe(`g++ -std=c++17 "main.cpp" "util.cc" -o ${isWin ? 'prog.exe' : 'prog'}`);
  });

  it('c: 빌드 경고(code 0)는 warn 으로 남기고 산출물을 실행한다', async () => {
    scripts.push({ match: /^gcc/, s: { stderr: 'warning: unused variable', code: 0 } });
    scripts.push({ match: /prog/, s: { stdout: '42', code: 0 } });
    const r = await exec({ lang: 'c', entry: 'a.c', files: [{ path: 'a.c', content: '' }] });
    expect(r.body.lines).toEqual([
      { type: 'warn', text: 'warning: unused variable' },
      { type: 'log', text: '42' },
      { type: 'info', text: '✓ 종료 코드 0' },
    ]);
    expect(spawned.map((s) => s.cmd)).toEqual([
      `gcc "a.c" -o ${isWin ? 'prog.exe' : 'prog'}`,
      isWin ? '.\\prog.exe' : './prog',
    ]);
  });

  it('빌드 실패(일반 오류)는 컴파일러 안내 없이 ✗ 빌드 실패', async () => {
    scripts.push({ match: /^javac/, s: { stderr: 'Main.java:3: error: ; expected', code: 1 } });
    const r = await exec({ lang: 'java', entry: 'src/Main.java', files: [] });
    expect(texts(r)).toEqual(['Main.java:3: error: ; expected', '✗ 빌드 실패']);
  });

  it('언어별 명령 매핑 (java·go·rust·ts·php)', async () => {
    scripts.push({ match: /./, s: { stdout: '', code: 0 } });
    const cases: [string, string, string[]][] = [
      ['java', 'src/Main.java', ['javac "src/Main.java"', 'java Main']],
      ['go', 'main.go', ['go run "main.go"']],
      ['rust', 'main.rs', [`rustc "main.rs" -o ${isWin ? 'prog.exe' : 'prog'}`, isWin ? '.\\prog.exe' : './prog']],
      ['ts', 'a.ts', ['npx --yes tsx "a.ts"']],
      ['php', 'i.php', ['php "i.php"']],
    ];
    for (const [lang, entry, cmds] of cases) {
      spawned.length = 0;
      const r = await exec({ lang, entry, files: [] });
      expect(texts(r), lang).toEqual(['✓ 종료 코드 0']);
      expect(spawned.map((s) => s.cmd), lang).toEqual(cmds);
    }
  });

  it("spawn 'error'(셸 없음 등) 는 stderr 로 합쳐지고 종료 코드 1", async () => {
    scripts.push({ match: /node/, s: { error: 'spawn ENOENT' } });
    const r = await exec({ lang: 'js', entry: 'a.js', files: [] });
    expect(texts(r)).toEqual(['spawn ENOENT', '✓ 종료 코드 1']);
  });

  it('12초 타임아웃 → SIGKILL + "⏱ 시간 초과" (부분 출력은 보존)', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const timeoutCbs: (() => void)[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
      if (ms === 12000) {
        timeoutCbs.push(fn);
        return { ref() {}, unref() {}, hasRef: () => true, refresh() {} } as unknown as NodeJS.Timeout;
      }
      return realSetTimeout(fn as () => void, ms, ...args);
    }) as typeof setTimeout);
    scripts.push({ match: /node/, s: { stdout: 'partial', hang: true } });
    const pending = exec({ lang: 'js', entry: 'loop.js', files: [] }).then((r) => r); // supertest 는 then 에서 전송 시작
    await vi.waitFor(() => expect(timeoutCbs.length).toBe(1));
    expect(spawned[0].child.kill).not.toHaveBeenCalled();
    timeoutCbs[0]();
    expect(spawned[0].child.kill).toHaveBeenCalledWith('SIGKILL');
    const r = await pending;
    expect(r.body.lines).toEqual([
      { type: 'log', text: 'partial' },
      { type: 'error', text: '⏱ 시간 초과(12초)' },
    ]);
  });

  it('stdout 100KB 초과 시 프로세스를 죽인다', async () => {
    scripts.push({ match: /node/, s: { chunks: ['x'.repeat(60_000), 'y'.repeat(50_000)], hang: true } });
    const r = await exec({ lang: 'js', entry: 'spam.js', files: [] });
    expect(spawned[0].child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(texts(r).at(-1)).toBe('✓ 종료 코드 0'); // kill 로 닫히면 code null → 0 표기
    expect(texts(r)[0].length).toBe(110_000);
  });
});

describe('/api/run/git — 로컬 git push', () => {
  it('remote·token·files 검증 400', async () => {
    for (const body of [
      {},
      { remote: 'https://github.com/x/y.git', files: [] },
      { remote: 'https://github.com/x/y.git', token: '', files: [] },
      { remote: 'https://github.com/x/y.git', token: 't', files: [{ path: 3 }] },
      { remote: 5, token: 't', files: [] },
    ]) {
      const r = await git(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toBe('remote · token · files 필요');
    }
    expect(spawned.length).toBe(0);
  });

  it('7단계 순서대로 실행, 토큰은 출력·명령에서 가려지고 큰따옴표 메시지는 무해화', async () => {
    scripts.push({ match: /git push/, s: { stdout: 'To https://x-access-token:ghp_SECRET@github.com/x/y.git\n * [new branch]', code: 0 } });
    scripts.push({ match: /./, s: { code: 0 } });
    const r = await git({
      remote: 'https://github.com/x/y.git',
      token: 'ghp_SECRET',
      branch: 'dev',
      message: 'say "hi"',
      name: '주호',
      email: 'j@x.io',
      files: [{ path: 'src/a.txt', content: 'A' }, { path: '../../out.txt', content: 'B' }],
    });
    expect(r.status).toBe(200);
    expect(spawned.map((s) => s.cmd)).toEqual([
      'git init -b dev',
      'git config user.name "주호"',
      'git config user.email "j@x.io"',
      'git add -A',
      `git commit -m "say 'hi'"`,
      'git remote add origin "https://x-access-token:ghp_SECRET@github.com/x/y.git"',
      'git push -u origin dev --force',
    ]);
    expect(spawned[0].cwdSnapshot).toEqual(['out.txt', 'src/a.txt']);
    expect(new Set(spawned.map((s) => s.cwd)).size).toBe(1);
    const lines = texts(r);
    expect(lines).toEqual(['To https://x-access-token:***@github.com/x/y.git\n * [new branch]', '✓ dev 브랜치로 푸시 완료']);
    expect(JSON.stringify(r.body)).not.toContain('ghp_SECRET');
    await vi.waitFor(() => expect(fs.existsSync(spawned[0].cwd)).toBe(false));
  });

  it('git 미설치 → 첫 단계에서 멈추고 설치 안내 · 기본값(main 브랜치)', async () => {
    scripts.push({ match: /git init/, s: { stderr: "'git' is not recognized as an internal or external command", code: 1 } });
    const r = await git({ remote: 'https://github.com/x/y.git', token: 'tok', files: [] });
    expect(texts(r)).toEqual([
      "'git' is not recognized as an internal or external command",
      '서버 PC에 git 이 설치되어 있지 않아요.',
      '✗ 실패: git init -b main',
    ]);
    expect(spawned.length).toBe(1);
  });

  it('중간 단계 실패(인증 거부)는 토큰을 가린 실패 문구로 끝난다', async () => {
    scripts.push({ match: /git push/, s: { stderr: 'remote: Invalid username or token tok123', code: 128 } });
    scripts.push({ match: /./, s: { code: 0 } });
    const r = await git({ remote: 'https://github.com/x/y.git', token: 'tok123', files: [] });
    const lines = texts(r);
    expect(lines).toEqual(['remote: Invalid username or token ***', '✗ 실패: git push -u origin main --force']);
    expect(spawned.length).toBe(7);
  });
});
