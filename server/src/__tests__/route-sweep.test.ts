import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.js';
import db from '../db.js';

/*
 * 라우트 스윕 — 모든 HTTP 라우트를 정상·쓰레기·권한없음·비로그인·없는 id·숫자 아닌 id 변형으로
 * 두드려서 500(미포착 예외) 또는 응답 없음(행)을 잡는다.
 * 라우트 목록은 src/*.ts 소스를 정규식으로 긁어 자동 추출 — 새 라우트도 자동 포함된다.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..');
const app = createApp();

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface Route {
  method: Method;
  path: string; // 마운트 포함 전체 경로 (':param' 그대로)
  file: string; // 라우트가 선언된 파일명
}

/** ── 라우트 추출: app.ts 의 app.use 마운트 + 각 파일의 router.use 서브마운트 + router.<verb> ── */
function discoverRoutes(): { routes: Route[]; unmounted: string[] } {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'));
  const source = new Map<string, string>();
  for (const f of files) source.set(f, fs.readFileSync(path.join(SRC, f), 'utf8'));

  // import 이름 → 파일
  const importsOf = (code: string) => {
    const m = new Map<string, string>();
    for (const im of code.matchAll(/import\s+(\w+)(?:\s*,\s*\{[^}]*\})?\s+from\s+'\.\/(\w+)\.js'/g)) m.set(im[1], `${im[2]}.ts`);
    return m;
  };
  // 파일 → 마운트 prefix 목록
  const mounts = new Map<string, string[]>();
  const addMount = (file: string, prefix: string) => {
    if (!mounts.has(file)) mounts.set(file, []);
    mounts.get(file)!.push(prefix);
  };
  const appCode = source.get('app.ts')!;
  const appImports = importsOf(appCode);
  for (const m of appCode.matchAll(/app\.use\('([^']+)',\s*(\w+)\)/g)) {
    const file = appImports.get(m[2]);
    if (file) addMount(file, m[1]);
  }
  // 서브마운트 (router.use('/x', otherRouter)) — 부모 마운트가 정해진 뒤 전파
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10) {
    changed = false;
    for (const [file, code] of source) {
      const parents = mounts.get(file);
      if (!parents) continue;
      const imps = importsOf(code);
      for (const m of code.matchAll(/router\.use\('([^']+)',\s*(\w+)\)/g)) {
        const child = imps.get(m[2]);
        if (!child) continue;
        for (const p of parents) {
          const full = p + m[1];
          if (!mounts.get(child)?.includes(full)) {
            addMount(child, full);
            changed = true;
          }
        }
      }
    }
  }

  const routes: Route[] = [{ method: 'get', path: '/api/health', file: 'app.ts' }];
  const unmounted: string[] = [];
  for (const [file, code] of source) {
    if (file === 'app.ts') continue;
    const decls = [...code.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)];
    if (decls.length === 0) continue;
    const prefixes = mounts.get(file);
    if (!prefixes) {
      unmounted.push(file);
      continue;
    }
    for (const d of decls) {
      for (const p of prefixes) {
        const sub = d[2] === '/' ? '' : d[2];
        routes.push({ method: d[1] as Method, path: (p + sub).replace(/\/+/g, '/'), file });
      }
    }
  }
  return { routes, unmounted };
}

/** ── 픽스처 ── */
interface Fixture {
  host: { token: string; id: number; username: string };
  member: { token: string; id: number; username: string };
  outsider: { token: string; id: number; username: string };
  orgId: number;
  joinCode: string;
  code: string; // 조직 회의
  pcode: string; // 개인 회의
  meetingId: number;
  channelId: number;
  eventId: number;
  fileId: number;
  termId: number;
  checklistId: number;
  recapId: number;
  manualRecapId: number;
  agendaId: number;
  handoverId: number;
  todoId: number;
  wsId: number;
  roleId: number;
}

const auth = (t?: string) => (t ? { Authorization: `Bearer ${t}` } : {});

async function register(username: string) {
  const r = await request(app).post('/api/auth/register').send({ username, password: 'password123' });
  expect(r.status, `register ${username}: ${JSON.stringify(r.body)}`).toBe(200);
  return { token: r.body.token as string, id: r.body.user.id as number, username };
}

async function ok(p: request.Test, what: string) {
  const r = await p;
  expect(r.status, `${what}: ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

async function buildFixture(prefix: string): Promise<Fixture> {
  const host = await register(`${prefix}_host`);
  const member = await register(`${prefix}_member`);
  const outsider = await register(`${prefix}_out`);

  const org = await ok(request(app).post('/api/orgs').set(auth(host.token)).send({ name: `${prefix} 조직` }), 'org');
  const orgId = org.id as number;
  const joinCode = org.joinCode as string;
  await ok(request(app).post('/api/orgs/join').set(auth(member.token)).send({ joinCode }), 'org join');
  await ok(
    request(app).post(`/api/orgs/${orgId}/members/${member.id}/approve`).set(auth(host.token)).send({}),
    'approve',
  );
  const role = await ok(
    request(app).post(`/api/orgs/${orgId}/roles`).set(auth(host.token)).send({ name: '검토자', perms: ['member:approve'] }),
    'role',
  );

  const m = await ok(
    request(app).post('/api/meetings').set(auth(host.token)).send({ title: `${prefix} 그룹`, org_id: orgId }),
    'meeting',
  );
  const code = m.code as string;
  const meetingId = m.id as number;
  await ok(request(app).post('/api/meetings/join').set(auth(member.token)).send({ code }), 'join');
  const pm = await ok(request(app).post('/api/meetings').set(auth(host.token)).send({ title: `${prefix} 개인` }), 'pmeeting');
  const pcode = pm.code as string;

  const ch = await ok(request(app).post(`/api/meetings/${code}/channels`).set(auth(host.token)).send({ name: '공지' }), 'channel');
  const ev = await ok(
    request(app).post(`/api/meetings/${code}/events`).set(auth(host.token)).send({ title: '점검', date: '2026-09-10', time: '10:00' }),
    'event',
  );
  const file = await ok(
    request(app).post(`/api/meetings/${code}/files`).set(auth(host.token)).send({ name: 'a.md', type: 'doc' }),
    'file',
  );
  await ok(request(app).post(`/api/meetings/${code}/glossary`).set(auth(host.token)).send({ term: '방열판' }), 'glossary');
  const termId = (db.prepare('SELECT id FROM meeting_glossary WHERE meeting_id = ?').get(meetingId) as { id: number }).id;
  const chk = await ok(
    request(app).post(`/api/meetings/${code}/handovers/checklist`).set(auth(host.token)).send({ label: '설비 알람 확인' }),
    'checklist',
  );
  const manual = await ok(
    request(app).post(`/api/meetings/${code}/decisions/manual`).set(auth(host.token)).send({ text: '수동 결정 1' }),
    'manual decision',
  );
  const todo = await ok(
    request(app).post('/api/todos').set(auth(host.token)).send({ title: '할 일', meeting: code }),
    'todo',
  );
  const ws = await ok(request(app).post('/api/workspaces').set(auth(host.token)).send({ name: '작업공간' }), 'workspace');
  await ok(
    request(app).post(`/api/dm/personal/with/${member.id}`).set(auth(host.token)).send({ text: '안녕' }),
    'dm',
  );
  await ok(
    request(app).post(`/api/dm/${orgId}/with/${member.id}`).set(auth(host.token)).send({ text: '조직 dm' }),
    'org dm',
  );
  const ho = await ok(
    request(app)
      .post(`/api/meetings/${code}/handovers`)
      .set(auth(host.token))
      .send({ shiftLabel: '주간', sections: { issues: ['라인2 알람'], changes: [], pending: [], notes: [] }, checks: [{ label: '점검', done: true }] }),
    'handover',
  );

  // 채팅 메시지 (소켓 경로라 DB 직접)
  db.prepare('INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)').run(
    meetingId,
    host.id,
    '첫 메시지',
    ch.id,
  );
  // AI recap 1건 (결정 2개) + 서명 1건
  const recapId = Number(
    db
      .prepare(
        `INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, alts, actions, attendees, source)
         VALUES (?, '온도 기준 논의', ?, ?, ?, '[]', ?, 'ai')`,
      )
      .run(
        meetingId,
        JSON.stringify(['검사 온도 65도로 상향', '야간조 인원 유지']),
        JSON.stringify(['편차가 컸음', '']),
        JSON.stringify([['70도 — 설비 한계'], []]),
        JSON.stringify([host.username, member.username]),
      ).lastInsertRowid,
  );
  db.prepare('INSERT INTO decision_acks (recap_id, decision_idx, user_id) VALUES (?, ?, ?)').run(recapId, 0, member.id);
  // 안건 + 이벤트
  const agendaId = Number(
    db.prepare(`INSERT INTO agenda_items (meeting_id, title, why) VALUES (?, '온도 기준', '편차')`).run(meetingId).lastInsertRowid,
  );
  db.prepare(`INSERT INTO agenda_events (agenda_id, meeting_id, kind, detail) VALUES (?, ?, 'created', '첫 등장')`).run(
    agendaId,
    meetingId,
  );
  // RAG 청크
  db.prepare('INSERT INTO rag_chunks (meeting_id, kind, ref_id, text, embedding) VALUES (?, ?, ?, ?, ?)').run(
    meetingId,
    'recap',
    recapId,
    '검사 온도 65도로 상향',
    Buffer.from(new Float32Array(8).fill(0.1).buffer),
  );
  // 섹션이 비정상('{}')인 인수인계 행 — 과거 데이터 방어
  db.prepare(`INSERT INTO handovers (meeting_id, author_id, sections) VALUES (?, ?, '{}')`).run(meetingId, host.id);

  return {
    host,
    member,
    outsider,
    orgId,
    joinCode,
    code,
    pcode,
    meetingId,
    channelId: ch.id,
    eventId: ev.id,
    fileId: file.id,
    termId,
    checklistId: chk.id,
    recapId,
    manualRecapId: manual.id,
    agendaId,
    handoverId: ho.id,
    todoId: todo.id,
    wsId: ws.id,
    roleId: role.id,
  };
}

/** ── 파라미터 치환 ── */
type ParamMode = 'valid' | 'missing' | 'nan' | 'personal';
const NUMERIC_PARAMS = new Set([
  'id', 'fileId', 'recapId', 'idx', 'itemId', 'termId', 'eventId', 'channelId', 'userId', 'roleId', 'vid', 'orgId', 'scope',
]);

function fillPath(route: Route, f: Fixture, mode: ParamMode): string {
  return route.path.replace(/:(\w+)/g, (_m, name: string) => {
    if (mode === 'missing') {
      if (name === 'code') return 'ZZZZZZ';
      if (name === 'username') return 'nobody_x';
      if (name === 'filename') return 'nope_x.png';
      return '999999';
    }
    if (mode === 'nan' && NUMERIC_PARAMS.has(name)) return 'abc';
    switch (name) {
      case 'code':
        return mode === 'personal' ? f.pcode : f.code;
      case 'fileId':
        return String(f.fileId);
      case 'recapId':
        return String(f.recapId);
      case 'idx':
        return '0';
      case 'itemId':
        return route.path.includes('checklist') ? String(f.checklistId) : String(f.agendaId);
      case 'termId':
        return String(f.termId);
      case 'eventId':
        return String(f.eventId);
      case 'channelId':
        return String(f.channelId);
      case 'userId':
        return String(f.member.id);
      case 'username':
        return f.member.username;
      case 'id':
        if (route.file === 'orgs.ts') return String(f.orgId);
        if (route.file === 'todos.ts') return String(f.todoId);
        if (route.file === 'workspaces.ts') return String(f.wsId);
        return String(f.handoverId); // meetings.ts /handovers/:id/ack
      case 'roleId':
        return String(f.roleId);
      case 'vid':
        return '1';
      case 'filename':
        return 'nope_x.png';
      case 'scope':
        return mode === 'personal' ? 'personal' : String(f.orgId);
      case 'orgId':
        return String(f.orgId);
      default:
        return '1';
    }
  });
}

const GARBAGE = {
  a: 1,
  text: 123,
  name: [],
  items: 'x',
  code: {},
  status: 'zzz',
  label: null,
  ids: 'nope',
  term: 5,
  decisions: 'x',
  date: 'not-a-date',
  title: {},
  userId: 'x',
  sections: 'x',
  checks: 5,
  done: 'maybe',
  assignees: 'x',
  due_at: 5,
  parent_id: 'x',
  recapId: 'x',
  idx: 'x',
  decision: 5,
  reason: [],
  why: {},
  note: 7,
  signature: 9,
  joinCode: 1,
  position: [],
  department: {},
  perms: 'x',
  role: 5,
  channelId: 'x',
  enabled: 'x',
  mute: 'x',
  message: 4,
  q: {},
  sql: 5,
  lang: 5,
  entry: [],
  files: 'x',
  subscription: 'x',
  endpoint: 5,
  people: 'x',
  memo: [],
  remind: 'x',
  recur: 5,
  color: {},
  locked: 'x',
  settings: 'x',
  starts_at: 5,
  ends_at: [],
  invite: 'x',
  org_id: 'x',
  ctx: [],
  shiftLabel: {},
  source: 5,
  target: 'x',
  fileId: 'x',
  fileIds: 'x',
  user: 5,
  users: 'x',
  password: 5,
  username: {},
  current: [],
  next: 5,
  dates: 'x',
  meeting: {},
  version: 'x',
  content: 5,
  ack: 'x',
  ackRequired: 'x',
  ack_required: 'x',
  deadline: 5,
  targets: 'x',
  channels: 5,
};
const GARBAGE_QS = '?q=&limit=abc&page=-1&since=zzz&from=1&to=0&org=abc&ctx=abc&meeting=abc&name=&date=zzz&kind=zzz&fresh=abc&scope=x&ts=abc';

// 호스트 세션을 무효화하는 auth 라우트 — 별도 일회용 사용자로만
const HOST_EXCLUDED = new Set(['post /api/auth/logout', 'post /api/auth/password', 'post /api/auth/reset', 'patch /api/auth/me']);
// 스트림을 직접 읽는(raw body) 라우트 — express.json 이 이미 소비한 뒤면 'end' 가 안 와 행이 날 수 있다
const RAW_ROUTES = new Set([
  'post /api/meetings/:code/files/upload',
  'post /api/meetings/:code/files/:fileId/upload-version',
  'post /api/workspaces/uploads',
  'post /api/auth/avatar',
  'post /api/meetings/:code/thumbnail',
  'post /api/meetings/:code/stt/audio',
]);
// 그룹 안에서 맨 뒤로 보내는 파괴적 라우트 (앞 변형들의 404/401 로 뒤 크래시가 가려지지 않게)
const LAST = ['delete /api/meetings/:code', 'delete /api/orgs/:id/members/:userId', 'patch /api/meetings/:code/host', 'delete /api/workspaces/:id', 'delete /api/notifications'];

interface Attempt {
  label: string;
  method: Method;
  url: string;
  token?: string;
  body?: unknown;
  raw?: { ct: string; buf: Buffer };
}
interface Failure {
  method: string;
  url: string;
  variant: string;
  status: number | 'HANG';
  error: string;
}

function attemptsFor(route: Route, f: Fixture, throwaway: string): Attempt[] {
  const key = `${route.method} ${route.path}`;
  const out: Attempt[] = [];
  const valid = fillPath(route, f, 'valid');
  const isGet = route.method === 'get';
  const hostToken = HOST_EXCLUDED.has(key) ? throwaway : f.host.token;
  const hostOk = !HOST_EXCLUDED.has(key);

  if (hostOk) out.push({ label: 'host {}', method: route.method, url: valid, token: hostToken, body: {} });
  out.push({ label: 'host garbage', method: route.method, url: valid, token: hostToken, body: GARBAGE });
  if (isGet) out.push({ label: 'host garbage-qs', method: route.method, url: valid + GARBAGE_QS, token: hostToken });
  if (hostOk && route.path.includes(':code')) {
    out.push({ label: 'host personal-meeting {}', method: route.method, url: fillPath(route, f, 'personal'), token: hostToken, body: {} });
  }
  if (hostOk && route.path.includes(':scope')) {
    out.push({ label: 'host scope=personal {}', method: route.method, url: fillPath(route, f, 'personal'), token: hostToken, body: {} });
  }
  out.push({ label: 'member {}', method: route.method, url: valid, token: f.member.token, body: {} });
  out.push({ label: 'outsider {}', method: route.method, url: valid, token: f.outsider.token, body: {} });
  out.push({ label: 'unauth', method: route.method, url: valid, body: {} });
  if (/:\w+/.test(route.path)) {
    out.push({ label: 'missing params', method: route.method, url: fillPath(route, f, 'missing'), token: hostToken, body: {} });
    const nan = fillPath(route, f, 'nan');
    if (nan !== valid) out.push({ label: 'nan params', method: route.method, url: nan, token: hostToken, body: {} });
  }
  if (RAW_ROUTES.has(key)) {
    const small = Buffer.from('x'.repeat(64));
    const isImage = key.includes('avatar') || key.includes('thumbnail');
    const qs = key.includes('stt/audio') ? '?ts=1700000000000' : key.endsWith('upload') || key.endsWith('uploads') ? '?name=t.txt' : '';
    // 검증을 통과하는 쿼리 + JSON 본문 — express.json 이 스트림을 비운 뒤 핸들러가 'end' 를 기다리며 행 나는지
    out.push({ label: 'json body + valid query', method: route.method, url: valid + qs, token: hostToken, body: { a: 1 } });
    out.push({
      label: 'raw small body',
      method: route.method,
      url: valid + qs,
      token: hostToken,
      raw: { ct: isImage ? 'image/png' : 'application/octet-stream', buf: small },
    });
    out.push({ label: 'raw empty body', method: route.method, url: valid + qs, token: hostToken, raw: { ct: isImage ? 'image/png' : 'application/octet-stream', buf: Buffer.alloc(0) } });
  }
  return out;
}

const unhandled: string[] = [];
let errSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (args[0] === '[unhandled]') {
      const e = args[1];
      unhandled.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  });
});
afterAll(() => errSpy?.mockRestore());

const statuses = new Map<string, number | 'HANG'>();
const histogram = new Map<string, number>();

async function fire(a: Attempt): Promise<Failure | null> {
  const before = unhandled.length;
  let status: number | 'HANG';
  let body: unknown = null;
  try {
    let req = request(app)[a.method](a.url).set(auth(a.token)).timeout({ response: 8000, deadline: 12000 });
    if (a.raw) req = req.set('Content-Type', a.raw.ct).send(a.raw.buf);
    else if (a.body !== undefined) req = req.send(a.body as object);
    const r = await req;
    status = r.status;
    body = r.body;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ECONNABORTED' || /timeout/i.test(String((e as Error).message))) status = 'HANG';
    else throw e;
  }
  statuses.set(`${a.method} ${a.url} [${a.label}]`, status);
  histogram.set(String(status), (histogram.get(String(status)) ?? 0) + 1);
  if (status === 'HANG' || status >= 500) {
    const msg = unhandled.slice(before).join(' | ') || (body && typeof body === 'object' ? JSON.stringify(body) : String(body));
    return { method: a.method.toUpperCase(), url: a.url, variant: a.label, status, error: msg };
  }
  return null;
}

function orderRoutes(routes: Route[]): Route[] {
  const rank = (r: Route) => {
    const g = r.method === 'get' ? 0 : r.method === 'post' ? 1 : r.method === 'patch' || r.method === 'put' ? 2 : 3;
    const key = `${r.method} ${r.path}`;
    const li = LAST.indexOf(key);
    return g * 100 + (li >= 0 ? 50 + li : 0);
  };
  return [...routes].map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

describe('라우트 스윕 — 500·행 0건', () => {
  it(
    '모든 라우트 × 변형에서 status < 500',
    async () => {
      const { routes, unmounted } = discoverRoutes();
      expect(unmounted, `router 선언은 있는데 마운트를 못 찾은 파일: ${unmounted.join(', ')}`).toEqual([]);
      const f = await buildFixture('sw');
      const throwaway = (await register('sw_throwaway')).token;

      const failures: Failure[] = [];
      let made = 0;
      for (const route of orderRoutes(routes)) {
        for (const a of attemptsFor(route, f, throwaway)) {
          made++;
          const fail = await fire(a);
          if (fail) failures.push(fail);
        }
      }
      // 세션 무효화 라우트 — 일회용 사용자로 유효 바디까지 (logout 은 마지막)
      const t2 = (await register('sw_throwaway2')).token;
      const extra: Attempt[] = [
        { label: 'throwaway valid', method: 'patch', url: '/api/auth/me', token: t2, body: { name: '새이름' } },
        { label: 'throwaway wrong-current', method: 'post', url: '/api/auth/password', token: t2, body: { current: 'wrong', next: 'password456' } },
        { label: 'throwaway valid', method: 'post', url: '/api/auth/password', token: t2, body: { current: 'password123', next: 'password456' } },
        { label: 'no-auth garbage', method: 'post', url: '/api/auth/reset', body: { username: 'sw_throwaway2', recoveryCode: 'XXXX', password: 'password789' } },
        { label: 'throwaway', method: 'post', url: '/api/auth/logout', token: t2, body: {} },
        { label: 'after logout', method: 'get', url: '/api/auth/me', token: t2 },
      ];
      for (const a of extra) {
        made++;
        const fail = await fire(a);
        if (fail) failures.push(fail);
      }

      const hist = [...histogram.entries()].sort().map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`[route-sweep] routes=${routes.length} requests=${made} failures=${failures.length} statuses={${hist}}`);
      if (failures.length) console.log(failures.map((x) => `${x.status} ${x.method} ${x.url} [${x.variant}] :: ${x.error}`).join('\n'));
      expect(routes.length).toBeGreaterThan(100);
      expect(failures).toEqual([]);

      // 스윕이 진짜로 안쪽까지 갔는지 — 호스트 세션이 도중에 죽어 전부 401 로 가려진 게 아니어야 한다
      // (세션 무효화 라우트는 일회용 토큰이라 제외 — 틀린 현재 비밀번호 → 401 이 정답)
      const host401 = [...statuses.entries()]
        .filter(([k, v]) => v === 401 && /\[host /.test(k) && !HOST_EXCLUDED.has(k.split(' [')[0]))
        .map(([k]) => k);
      expect(host401, `호스트 토큰인데 401: ${host401.join(', ')}`).toEqual([]);
      const me = await request(app).get('/api/auth/me').set(auth(f.host.token));
      expect(me.status).toBe(200);
      // 깊은 삭제 경로(recap·rag·안건·인수인계·용어집 등 FK 연쇄)가 실제로 실행됐는지
      expect(statuses.get(`delete /api/meetings/${f.code} [host {}]`)).toBe(200);
      expect(statuses.get(`delete /api/meetings/${f.pcode} [host personal-meeting {}]`)).toBe(200);
      expect(statuses.get(`delete /api/orgs/${f.orgId}/members/${f.member.id} [host {}]`)).toBe(200);
      expect(statuses.get(`delete /api/workspaces/${f.wsId} [host {}]`)).toBe(200);
    },
    180_000,
  );
});

describe('라이프사이클 — 생성부터 삭제까지 500 없음', () => {
  it('register → org → meeting → … → delete 전 구간', async () => {
    const steps: { what: string; status: number; body: unknown }[] = [];
    const bad: string[] = [];
    const step = async (what: string, p: request.Test, expectMax = 499) => {
      const before = unhandled.length;
      const r = await p;
      steps.push({ what, status: r.status, body: r.body });
      if (r.status > expectMax) bad.push(`${what}: ${r.status} ${JSON.stringify(r.body)} ${unhandled.slice(before).join(' | ')}`);
      return r;
    };
    const host = await register('lc_host');
    const member = await register('lc_member');
    const H = auth(host.token);
    const M = auth(member.token);

    const org = (await step('org create', request(app).post('/api/orgs').set(H).send({ name: 'LC' }), 299)).body;
    await step('org join', request(app).post('/api/orgs/join').set(M).send({ joinCode: org.joinCode }), 299);
    await step('approve', request(app).post(`/api/orgs/${org.id}/members/${member.id}/approve`).set(H).send({}), 299);
    const m = (await step('meeting', request(app).post('/api/meetings').set(H).send({ title: 'LC 그룹', org_id: org.id }), 299)).body;
    const code = m.code as string;
    await step('join', request(app).post('/api/meetings/join').set(M).send({ code }), 299);
    const ch = (await step('channel', request(app).post(`/api/meetings/${code}/channels`).set(H).send({ name: '공지' }), 299)).body;
    db.prepare('INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)').run(m.id, host.id, 'hi', ch.id);
    await step('messages', request(app).get(`/api/meetings/${code}/messages?channel=${ch.id}`).set(M), 299);
    await step('messages read', request(app).post(`/api/meetings/${code}/messages/read`).set(M).send({ channelId: ch.id }), 299);

    const recapId = Number(
      db
        .prepare(`INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, actions, attendees, source) VALUES (?, '요약', ?, ?, '[]', '[]', 'ai')`)
        .run(m.id, JSON.stringify(['결정 A', '결정 B']), JSON.stringify(['이유 A', ''])).lastInsertRowid,
    );
    await step('decisions', request(app).get(`/api/meetings/${code}/decisions`).set(M), 299);
    await step('ack', request(app).post(`/api/meetings/${code}/decisions/ack`).set(M).send({ recapId, idx: 0 }), 299);
    await step('edit', request(app).patch(`/api/meetings/${code}/decisions/${recapId}/0`).set(H).send({ decision: '결정 A2', why: '이유 A2', reason: '정정' }), 299);
    await step('revisions', request(app).get(`/api/meetings/${code}/decisions/${recapId}/0/revisions`).set(M), 299);
    await step('withdraw', request(app).post(`/api/meetings/${code}/decisions/${recapId}/1/withdraw`).set(H).send({ reason: '철회' }), 299);
    await step('history', request(app).get(`/api/meetings/${code}/decisions/history`).set(H), 299);
    await step('remind', request(app).post(`/api/meetings/${code}/decisions/remind`).set(H).send({ recapId }));
    await step('delete auto', request(app).delete(`/api/meetings/${code}/decisions/auto/${recapId}`).set(H));

    const ho = (
      await step('handover', request(app).post(`/api/meetings/${code}/handovers`).set(H).send({ shiftLabel: '주간', sections: { issues: ['a'], changes: [], pending: [], notes: [] } }), 299)
    ).body;
    await step('handover ack', request(app).post(`/api/meetings/${code}/handovers/${ho.id}/ack`).set(M).send({ note: '확인' }), 299);
    await step('handovers list', request(app).get(`/api/meetings/${code}/handovers`).set(M), 299);

    const file = (await step('file', request(app).post(`/api/meetings/${code}/files`).set(H).send({ name: 'spec.md', type: 'doc' }), 299)).body;
    await step('ack-request', request(app).post(`/api/meetings/${code}/files/${file.id}/ack-request`).set(H).send({}));
    await step('revise', request(app).post(`/api/meetings/${code}/files/${file.id}/revise`).set(H).send({ note: '개정' }));
    await step('file ack', request(app).post(`/api/meetings/${code}/files/${file.id}/ack`).set(M).send({}));
    await step('history', request(app).get(`/api/meetings/${code}/files/${file.id}/history`).set(M));
    await step('acks', request(app).get(`/api/meetings/${code}/files/${file.id}/acks`).set(H));
    await step('rename', request(app).patch(`/api/meetings/${code}/files/${file.id}`).set(H).send({ name: 'spec2.md' }));
    await step('copy', request(app).post(`/api/meetings/${code}/files/${file.id}/copy`).set(H).send({}));
    await step('delete file', request(app).delete(`/api/meetings/${code}/files/${file.id}`).set(H), 299);
    await step('trash', request(app).get(`/api/meetings/${code}/files/trash/list`).set(H), 299);
    await step('restore', request(app).post(`/api/meetings/${code}/files/trash/${file.id}/restore`).set(H).send({}));
    await step('delete again', request(app).delete(`/api/meetings/${code}/files/${file.id}`).set(H));
    await step('purge', request(app).delete(`/api/meetings/${code}/files/trash/${file.id}`).set(H));
    await step('empty trash', request(app).delete(`/api/meetings/${code}/files/trash`).set(H));

    const todo = (await step('todo', request(app).post('/api/todos').set(H).send({ title: 't', meeting: code, assignees: [member.username] }), 299)).body;
    await step('todo done', request(app).patch(`/api/todos/${todo.id}`).set(M).send({ done: true }), 299);
    const ev = (await step('event', request(app).post(`/api/meetings/${code}/events`).set(H).send({ title: 'e', date: '2026-09-11' }), 299)).body;
    await step('event ack', request(app).post(`/api/meetings/${code}/events/${ev.id}/ack`).set(M).send({}));
    await step('event patch', request(app).patch(`/api/meetings/${code}/events/${ev.id}`).set(H).send({ title: 'e2' }));
    await step('event delete', request(app).delete(`/api/meetings/${code}/events/${ev.id}`).set(H));
    const ws = (await step('workspace', request(app).post('/api/workspaces').set(H).send({ name: 'w', ctx: org.id }), 299)).body;

    await step('delete channel', request(app).delete(`/api/meetings/${code}/channels/${ch.id}`).set(H), 299);
    await step('todo delete', request(app).delete(`/api/todos/${todo.id}`).set(H));
    await step('remove participant', request(app).delete(`/api/meetings/${code}/participants/${member.username}`).set(H));
    await step('delete meeting', request(app).delete(`/api/meetings/${code}`).set(H), 299);
    await step('meeting gone', request(app).get(`/api/meetings/${code}`).set(H));
    await step('remove member', request(app).delete(`/api/orgs/${org.id}/members/${member.id}`).set(H), 299);
    await step('delete workspace', request(app).delete(`/api/workspaces/${ws.id}?ctx=${org.id}`).set(H), 299);
    await step('notifications', request(app).get('/api/notifications').set(M), 299);
    await step('delete notifications', request(app).delete('/api/notifications').set(M), 299);
    await step('todos after', request(app).get('/api/todos').set(M), 299);
    await step('brief after', request(app).get('/api/agent/overview').set(H));

    expect(bad, bad.join('\n')).toEqual([]);
  }, 60_000);
});
