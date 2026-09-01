import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import db from '../db.js';
import { register, auth, createOrg, joinOrg } from './helpers/fixtures.js';

/*
 * workspaces.ts — 개인/조직 컨텍스트 CRUD, 소유권(만든 사람 / 조직 멤버), 에셋 업로드(파일명 위생·20MB).
 * (뮤테이션 점수 0% — 이전엔 route-sweep 만 지나갔다)
 */
const app = createApp();
const UPLOAD_DIR = path.join(process.env.DATA_DIR!, 'uploads');

describe('작업공간 CRUD · 컨텍스트', () => {
  it('개인 컨텍스트 — 만든 사람에게만 보이고, 이름 검증·404·403·삭제까지', async () => {
    const a = await register(app, 'ws_a');
    const b = await register(app, 'ws_b');
    expect((await request(app).post('/api/workspaces').set(auth(a)).send({ name: '  ' })).body).toEqual({ error: '작업공간 이름을 입력하세요' });
    expect((await request(app).post('/api/workspaces').set(auth(a)).send({ name: 42 })).status).toBe(400);
    const c1 = await request(app).post('/api/workspaces').set(auth(a)).send({ name: '기획 캔버스' });
    expect(c1.body).toEqual({ id: expect.any(Number), name: '기획 캔버스' });
    const c2 = await request(app).post('/api/workspaces').set(auth(a)).send({ name: '두 번째' });
    expect(db.prepare('SELECT name, created_by, org_id FROM workspaces WHERE id = ?').get(c1.body.id)).toEqual({ name: '기획 캔버스', created_by: a.id, org_id: null });

    const mine = await request(app).get('/api/workspaces').set(auth(a));
    expect(mine.body.map((w: { id: number; name: string }) => [w.id, w.name])).toEqual([[c1.body.id, '기획 캔버스'], [c2.body.id, '두 번째']]);
    expect((await request(app).get('/api/workspaces?ctx=personal').set(auth(a))).body).toHaveLength(2);
    expect((await request(app).get('/api/workspaces').set(auth(b))).body).toEqual([]); // 남의 개인 작업공간은 안 보인다
    expect((await request(app).get('/api/workspaces').set(auth(b))).status).toBe(200);
    expect((await request(app).get('/api/workspaces')).status).toBe(401);

    // 이름 변경 — 남의 것 403, 없는 것 404, 빈 이름 400, trim 저장
    const deny = await request(app).patch(`/api/workspaces/${c1.body.id}`).set(auth(b)).send({ name: '탈취' });
    expect(deny.status).toBe(403);
    expect(deny.body).toEqual({ error: '권한이 없어요' });
    expect((await request(app).patch('/api/workspaces/999999').set(auth(a)).send({ name: 'x' })).body).toEqual({ error: '없는 작업공간입니다' });
    expect((await request(app).patch(`/api/workspaces/${c1.body.id}`).set(auth(a)).send({ name: ' ' })).body).toEqual({ error: '이름을 입력하세요' });
    expect((await request(app).patch(`/api/workspaces/${c1.body.id}`).set(auth(a)).send({ name: '  새 이름  ' })).body).toEqual({ ok: true });
    expect((db.prepare('SELECT name FROM workspaces WHERE id = ?').get(c1.body.id) as { name: string }).name).toBe('새 이름');
    expect((db.prepare('SELECT name FROM workspaces WHERE id = ?').get(c2.body.id) as { name: string }).name).toBe('두 번째'); // 다른 행은 그대로

    // 삭제 — 남의 것 403, 없는 것 404, 본인 OK (다른 행은 남는다)
    expect((await request(app).delete(`/api/workspaces/${c1.body.id}`).set(auth(b))).body).toEqual({ error: '권한이 없어요' });
    expect((await request(app).delete('/api/workspaces/999999').set(auth(a))).body).toEqual({ error: '없는 작업공간입니다' });
    expect(db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(c1.body.id)).toBeTruthy();
    expect((await request(app).delete(`/api/workspaces/${c1.body.id}`).set(auth(a))).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(c1.body.id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(c2.body.id)).toBeTruthy();
  }, 20_000);

  it('조직 컨텍스트 — 활성 멤버 전원이 보고 만지되, 비멤버·대기자 403, 잘못된 ctx 400, 개인 목록과 분리', async () => {
    const owner = await register(app, 'ws_owner');
    const member = await register(app, 'ws_member');
    const pending = await register(app, 'ws_pending');
    const stranger = await register(app, 'ws_stranger');
    const org = await createOrg(app, owner, '워크스페이스 조직');
    await joinOrg(app, org, owner, member);
    await request(app).post('/api/orgs/join').set(auth(pending)).send({ joinCode: org.joinCode });

    expect((await request(app).get('/api/workspaces?ctx=abc').set(auth(owner))).body).toEqual({ error: '잘못된 컨텍스트예요' });
    expect((await request(app).get('/api/workspaces?ctx=1.5').set(auth(owner))).status).toBe(400);
    expect((await request(app).get(`/api/workspaces?ctx=${org.id}`).set(auth(stranger))).body).toEqual({ error: '조직 멤버만 쓸 수 있어요' });
    expect((await request(app).get(`/api/workspaces?ctx=${org.id}`).set(auth(pending))).status).toBe(403);
    expect((await request(app).post('/api/workspaces').set(auth(stranger)).send({ name: '몰래', ctx: org.id })).status).toBe(403);
    expect((await request(app).post('/api/workspaces').set(auth(owner)).send({ name: '몰래', ctx: 'nope' })).status).toBe(400);

    const shared = await request(app).post('/api/workspaces').set(auth(member)).send({ name: '조직 보드', ctx: String(org.id) });
    expect(shared.status).toBe(200);
    expect(db.prepare('SELECT created_by, org_id FROM workspaces WHERE id = ?').get(shared.body.id)).toEqual({ created_by: member.id, org_id: org.id });
    const personal = await request(app).post('/api/workspaces').set(auth(member)).send({ name: '내 보드' });

    const orgList = await request(app).get(`/api/workspaces?ctx=${org.id}`).set(auth(owner));
    expect(orgList.body.map((w: { id: number }) => w.id)).toEqual([shared.body.id]);
    expect(orgList.body[0]).toMatchObject({ name: '조직 보드', created_by: member.id });
    expect((await request(app).get('/api/workspaces?ctx=personal').set(auth(member))).body.map((w: { id: number }) => w.id)).toEqual([personal.body.id]);
    expect((await request(app).get('/api/workspaces').set(auth(owner))).body).toEqual([]); // 개인 목록에 조직 것이 섞이지 않는다

    // 조직 작업공간은 만든 사람이 아니어도 활성 멤버면 수정·삭제, 비멤버·대기자는 403
    expect((await request(app).patch(`/api/workspaces/${shared.body.id}`).set(auth(stranger)).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).patch(`/api/workspaces/${shared.body.id}`).set(auth(pending)).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).patch(`/api/workspaces/${shared.body.id}`).set(auth(owner)).send({ name: '소유자가 바꿈' })).body).toEqual({ ok: true });
    expect((db.prepare('SELECT name FROM workspaces WHERE id = ?').get(shared.body.id) as { name: string }).name).toBe('소유자가 바꿈');
    expect((await request(app).delete(`/api/workspaces/${shared.body.id}`).set(auth(stranger))).status).toBe(403);
    expect((await request(app).delete(`/api/workspaces/${shared.body.id}`).set(auth(owner))).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(shared.body.id)).toBeUndefined();
    // 개인 작업공간은 같은 조직 멤버라도 남이면 못 만진다
    expect((await request(app).delete(`/api/workspaces/${personal.body.id}`).set(auth(owner))).status).toBe(403);
    expect(db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(personal.body.id)).toBeTruthy();
  }, 20_000);
});

describe('캔버스 에셋 업로드 (/uploads)', () => {
  it('확장자 위생(비단어 문자 제거·없으면 bin), 저장 후 URL, JSON 본문 400, 인증 401', async () => {
    const u = await register(app, 'ws_up');
    const bytes = Buffer.from('png-bytes-here');
    const r = await request(app).post('/api/workspaces/uploads?name=my%20photo.P%3FN*g').set(auth(u)).set('Content-Type', 'application/octet-stream').send(bytes);
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^\/api\/workspaces\/uploads\/[0-9a-f-]{36}\.PNg$/);
    const filename = (r.body.url as string).split('/').pop()!;
    expect(fs.readFileSync(path.join(UPLOAD_DIR, filename))).toEqual(bytes);
    expect(filename).not.toContain('my'); // 원래 이름은 절대 파일명에 안 쓴다 (UUID 보호)
    // 서빙 — 인증 없이, 경로 탈출 시도는 basename 으로 무력화
    expect((await request(app).get(r.body.url)).body).toEqual(bytes);
    expect((await request(app).get(`/api/workspaces/uploads/..%2F..%2F${filename}`)).status).toBe(200);
    const noName = await request(app).post('/api/workspaces/uploads').set(auth(u)).set('Content-Type', 'application/octet-stream').send(Buffer.from('x'));
    expect(noName.body.url).toMatch(/\.bin$/);
    const dotOnly = await request(app).post('/api/workspaces/uploads?name=archive.tar.gz').set(auth(u)).set('Content-Type', 'application/octet-stream').send(Buffer.from('x'));
    expect(dotOnly.body.url).toMatch(/\.gz$/);
    const json = await request(app).post('/api/workspaces/uploads?name=a.png').set(auth(u)).send({ not: 'binary' });
    expect(json.status).toBe(400);
    expect(json.body).toEqual({ error: '파일 본문을 바이너리로 보내주세요' });
    expect((await request(app).post('/api/workspaces/uploads?name=a.png').set('Content-Type', 'application/octet-stream').send(Buffer.from('x'))).status).toBe(401);
  }, 20_000);

  it('20MB 초과는 413 이고 파일이 남지 않는다, 정확히 20MB 는 저장', async () => {
    const u = await register(app, 'ws_big');
    const before = fs.readdirSync(UPLOAD_DIR).length;
    const big = await request(app).post('/api/workspaces/uploads?name=big.bin').set(auth(u)).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(20 * 1024 * 1024 + 1, 1));
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: '파일이 너무 큽니다 (최대 20MB)' });
    expect(fs.readdirSync(UPLOAD_DIR).length).toBe(before);
    const exact = await request(app).post('/api/workspaces/uploads?name=exact.bin').set(auth(u)).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(20 * 1024 * 1024, 2));
    expect(exact.status).toBe(200);
    expect(fs.statSync(path.join(UPLOAD_DIR, (exact.body.url as string).split('/').pop()!)).size).toBe(20 * 1024 * 1024);
  }, 30_000);
});
