import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/* /api/run — 격리 러너 프록시 모드(RUNNER_URL) + /sql + /git 게이트.
 * runner.ts 는 import 시점에 RUNNER_URL·CODE_EXEC_ENABLED 를 읽으므로 env 를 먼저 잡고 동적 import.
 * 직접 실행 모드(CODE_EXEC_ENABLED=1)는 runner-exec.test.ts (워커 분리). */

process.env.RUNNER_URL = 'http://runner.internal:8080/'; // 끝 슬래시는 벗겨져야 한다
delete process.env.CODE_EXEC_ENABLED;

let app: express.Express;
let token = '';
const auth = () => `Bearer ${token}`;

beforeAll(async () => {
  const { default: runnerRouter } = await import('../runner.js');
  const { default: authRouter } = await import('../auth.js');
  app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/run', runnerRouter);
  const r = await request(app).post('/api/auth/register').send({ username: 'run_proxy', password: 'password123' });
  expect(r.status).toBe(200);
  token = r.body.token;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('/api/run/exec — RUNNER_URL 프록시', () => {
  it('무인증 401 · 잘못된 본문 400', async () => {
    expect((await request(app).post('/api/run/exec').send({ lang: 'js', entry: 'a.js', files: [] })).status).toBe(401);
    for (const body of [
      {},
      { lang: 'js', entry: 'a.js' },
      { lang: 'js', entry: 'a.js', files: 'nope' },
      { lang: 'js', entry: 'a.js', files: [{ path: 1 }] },
      { lang: 'js', entry: 'a.js', files: [null] },
    ]) {
      const r = await request(app).post('/api/run/exec').set('Authorization', auth()).send(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body).toEqual({ error: '잘못된 요청' });
    }
  });

  it('러너에 그대로 위임하고 응답(상태 코드 포함)을 되돌린다', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ lines: [{ type: 'log', text: 'hi' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const files = [{ path: 'a.js', content: 'console.log("hi")' }];
    const r = await request(app)
      .post('/api/run/exec')
      .set('Authorization', auth())
      .send({ lang: 'js', entry: 'a.js', files, extra: 'ignored' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ lines: [{ type: 'log', text: 'hi' }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://runner.internal:8080/exec');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ lang: 'js', entry: 'a.js', files });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('러너의 비-200 응답도 상태 코드째 전달한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ lines: [{ type: 'error', text: '거부' }] }, 422)));
    const r = await request(app)
      .post('/api/run/exec')
      .set('Authorization', auth())
      .send({ lang: 'py', entry: 'a.py', files: [] });
    expect(r.status).toBe(422);
    expect(r.body.lines[0].text).toBe('거부');
  });

  it('러너 연결 실패(타임아웃/abort) · 깨진 JSON 은 안내 문구로 감싼다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'TimeoutError'); }));
    const r1 = await request(app)
      .post('/api/run/exec')
      .set('Authorization', auth())
      .send({ lang: 'js', entry: 'a.js', files: [] });
    expect(r1.status).toBe(200);
    expect(r1.body.lines).toEqual([{ type: 'error', text: '실행 러너에 연결할 수 없어요. 잠시 후 다시 시도해주세요.' }]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    const r2 = await request(app)
      .post('/api/run/exec')
      .set('Authorization', auth())
      .send({ lang: 'js', entry: 'a.js', files: [] });
    expect(r2.status).toBe(200);
    expect(r2.body.lines[0].type).toBe('error');
  });
});

describe('/api/run/sql — 인메모리 SQLite', () => {
  const sql = (s: unknown) => request(app).post('/api/run/sql').set('Authorization', auth()).send({ sql: s });

  it('sql 이 문자열이 아니면 400 · 빈 SQL 은 안내', async () => {
    expect((await sql(123)).status).toBe(400);
    expect((await request(app).post('/api/run/sql').set('Authorization', auth()).send({})).status).toBe(400);
    const r = await sql('  ;  ; ');
    expect(r.body.lines).toEqual([{ type: 'info', text: '실행할 SQL이 없어요' }, { type: 'info', text: '✓ 완료' }]);
  });

  it('DDL/DML 은 변경 행 수, SELECT 는 표 형태(헤더·구분선·행)', async () => {
    const r = await sql(`
      CREATE TABLE t (id INTEGER, name TEXT);
      INSERT INTO t VALUES (1, '가'), (2, NULL);
      SELECT * FROM t ORDER BY id;
      SELECT * FROM t WHERE id = 99;
      PRAGMA table_info(t)
    `);
    expect(r.status).toBe(200);
    const texts = r.body.lines.map((l: { text: string }) => l.text);
    expect(texts).toContain('OK (0행 변경)');
    expect(texts).toContain('OK (2행 변경)');
    expect(texts).toContain('id | name');
    expect(texts).toContain('----+-----');
    expect(texts).toContain('1 | 가');
    expect(texts).toContain('2 | '); // NULL → 빈 문자열
    expect(texts).toContain('(행 없음)');
    expect(texts.at(-1)).toBe('✓ 완료');
    // PRAGMA 도 SELECT 처럼 표로
    expect(texts.some((t: string) => t.startsWith('cid | name | type'))).toBe(true);
  });

  it('200행 초과는 잘라서 "외 N행", 문법 오류는 error 로 이어서 진행', async () => {
    const r = await sql(`
      WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 250) SELECT x FROM c;
      SELEC broken;
      SELECT 1 AS after_error
    `);
    const lines = r.body.lines as { type: string; text: string }[];
    expect(lines.filter((l) => l.type === 'log').length).toBe(2 + 200 + 2 + 1); // 헤더2 + 200행 + (헤더2 + 1행)
    expect(lines.find((l) => l.text === '… 외 50행')).toBeTruthy();
    const err = lines.find((l) => l.type === 'error');
    expect(err?.text).toMatch(/syntax error/i);
    expect(lines.some((l) => l.text === 'after_error')).toBe(true);
  });

  it('ATTACH/DETACH/load_extension 은 차단 (호스트 파일 접근 봉쇄)', async () => {
    const r = await sql(`ATTACH DATABASE '/etc/passwd' AS x; detach x; SELECT load_extension('evil'); SELECT 7 AS ok`);
    const lines = r.body.lines as { type: string; text: string }[];
    expect(lines.filter((l) => l.text === 'ATTACH/확장 로드는 허용되지 않아요.').length).toBe(3);
    expect(lines.some((l) => l.text === '7')).toBe(true);
  });
});

describe('/api/run/git — CODE_EXEC_ENABLED 게이트', () => {
  it('비활성 환경에서는 인증돼도 403', async () => {
    const r = await request(app)
      .post('/api/run/git')
      .set('Authorization', auth())
      .send({ remote: 'https://github.com/x/y.git', token: 't', files: [] });
    expect(r.status).toBe(403);
    expect(r.body.lines[0].text).toContain('CODE_EXEC_ENABLED=1');
  });
});
