import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import db from '../db.js';
import { register, auth } from './helpers/fixtures.js';

/*
 * auth.ts — 무차별 대입 제한(IP+아이디당 15분 10회), 복구 코드 재설정, 비밀번호 변경,
 * 프로필 검증(이메일·전화·길이 상한), 아바타 업로드(5MB), ?token= 쿼리 인증.
 */
const app = createApp();
const UPLOAD_DIR = path.join(process.env.DATA_DIR!, 'uploads');
const login = (username: string, password: string) => request(app).post('/api/auth/login').send({ username, password });

afterEach(() => vi.restoreAllMocks());

describe('로그인 무차별 대입 제한 (rateLimited)', () => {
  it('같은 아이디로 10번 실패까지는 400, 11번째부터 429, 성공하면 카운터 리셋', async () => {
    await register(app, 'rl_user');
    for (let i = 1; i <= 10; i++) {
      const r = await login('rl_user', 'wrong-password');
      expect(r.status, `attempt ${i}`).toBe(400);
      expect(r.body).toEqual({ error: '아이디 또는 비밀번호가 틀렸습니다' });
    }
    const blocked = await login('rl_user', 'wrong-password');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: '시도가 너무 많습니다. 15분 뒤에 다시 해보세요' });
    // 막힌 동안은 맞는 비밀번호로도 못 들어온다 (카운터는 요청마다 계속 오른다)
    expect((await login('rl_user', 'password123')).status).toBe(429);
    // 다른 아이디는 별개 키 — 영향 없음
    await register(app, 'rl_other');
    expect((await login('rl_other', 'password123')).status).toBe(200);
    // 15분 창이 지나면 다시 1회부터
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 15 * 60 * 1000 + 1);
    const again = await login('rl_user', 'password123');
    expect(again.status).toBe(200);
    expect(again.body.user).toEqual({ id: expect.any(Number), username: 'rl_user', name: null });
    vi.restoreAllMocks();
    // 성공으로 리셋됐으니 다시 10번 실패까지 400
    for (let i = 1; i <= 10; i++) expect((await login('rl_user', 'nope-nope-nope')).status, `after reset ${i}`).toBe(400);
    expect((await login('rl_user', 'nope-nope-nope')).status).toBe(429);
  }, 20_000);

  it('창 만료 경계 — 정확히 resetAt 시각에는 아직 막혀 있고, 1ms 뒤에 풀린다', async () => {
    await register(app, 'rl_edge');
    const base = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(base);
    for (let i = 0; i < 11; i++) await login('rl_edge', 'x');
    expect((await login('rl_edge', 'password123')).status).toBe(429);
    vi.spyOn(Date, 'now').mockReturnValue(base + 15 * 60 * 1000); // now > resetAt 가 아님
    expect((await login('rl_edge', 'password123')).status).toBe(429);
    vi.spyOn(Date, 'now').mockReturnValue(base + 15 * 60 * 1000 + 1);
    expect((await login('rl_edge', 'password123')).status).toBe(200);
  }, 20_000);

  it('없는 아이디·비문자열 비밀번호도 400 이고 같은 제한을 받는다', async () => {
    for (let i = 0; i < 10; i++) expect((await login('rl_ghost', 'x')).status).toBe(400);
    expect((await login('rl_ghost', 'x')).status).toBe(429);
    await register(app, 'rl_obj');
    const r = await request(app).post('/api/auth/login').send({ username: 'rl_obj', password: { $ne: '' } });
    expect(r.status).toBe(400);
    expect((await request(app).post('/api/auth/login').send({})).status).toBe(400);
  }, 20_000);
});

describe('복구 코드 재설정 (/reset)', () => {
  it('입력 검증 → 코드 검증 → 새 비밀번호·새 코드 발급, 기존 세션 전부 무효, 옛 코드는 1회용', async () => {
    const reg = await request(app).post('/api/auth/register').send({ username: 'rs_user', password: 'password123' });
    const code = reg.body.recoveryCode as string;
    expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    const oldToken = reg.body.token as string;
    expect((await request(app).post('/api/auth/reset').send({ username: 'rs_user', recoveryCode: code })).body).toEqual({ error: '모든 항목을 입력하세요' });
    expect((await request(app).post('/api/auth/reset').send({ username: 'rs_user', recoveryCode: code, newPassword: 'short7!' })).body).toEqual({ error: '비밀번호는 8자 이상이어야 합니다' });
    expect((await request(app).post('/api/auth/reset').send({ username: 'rs_user', recoveryCode: code, newPassword: 12345678 })).body).toEqual({ error: '비밀번호는 8자 이상이어야 합니다' });
    expect((await request(app).post('/api/auth/reset').send({ username: 'rs_nobody', recoveryCode: code, newPassword: 'newpass123' })).body).toEqual({ error: '아이디 또는 복구 코드가 올바르지 않습니다' });
    expect((await request(app).post('/api/auth/reset').send({ username: 'rs_user', recoveryCode: 'AAAA-AAAA-AAAA-AAAA', newPassword: 'newpass123' })).body).toEqual({ error: '아이디 또는 복구 코드가 올바르지 않습니다' });
    // 코드는 소문자·공백·구분자 없이 넣어도 정규화된다
    const loose = code.toLowerCase().replace(/-/g, ' ');
    const ok = await request(app).post('/api/auth/reset').send({ username: 'rs_user', recoveryCode: loose, newPassword: 'newpass123' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toEqual({ id: reg.body.user.id, username: 'rs_user' });
    expect(ok.body.recoveryCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect(ok.body.recoveryCode).not.toBe(code);
    // 옛 세션은 죽고 새 토큰만 산다
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${oldToken}`)).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${ok.body.token}`)).status).toBe(200);
    expect((await login('rs_user', 'password123')).status).toBe(400);
    expect((await login('rs_user', 'newpass123')).status).toBe(200);
    // 옛 코드 재사용 불가, 새 코드는 동작
    expect((await request(app).post('/api/auth/reset').send({ username: 'rs_user', recoveryCode: code, newPassword: 'another123' })).status).toBe(400);
    expect((await request(app).post('/api/auth/reset').send({ username: 'rs_user', recoveryCode: ok.body.recoveryCode, newPassword: 'another123' })).status).toBe(200);
    // 복구 코드 없는 계정(구 데이터)은 항상 거부
    db.prepare("UPDATE users SET recovery_hash = NULL WHERE username = 'rs_user'").run();
    expect((await request(app).post('/api/auth/reset').send({ username: 'rs_user', recoveryCode: 'AAAA-AAAA-AAAA-AAAA', newPassword: 'another123' })).status).toBe(400);
  }, 20_000);

  it('재설정도 IP+아이디당 10회 제한(429), 성공하면 리셋', async () => {
    const reg = await request(app).post('/api/auth/register').send({ username: 'rs_limit', password: 'password123' });
    for (let i = 0; i < 10; i++) {
      expect((await request(app).post('/api/auth/reset').send({ username: 'rs_limit', recoveryCode: 'BBBB-BBBB-BBBB-BBBB', newPassword: 'newpass123' })).status).toBe(400);
    }
    const blocked = await request(app).post('/api/auth/reset').send({ username: 'rs_limit', recoveryCode: reg.body.recoveryCode, newPassword: 'newpass123' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: '시도가 너무 많습니다. 15분 뒤에 다시 해보세요' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
    expect((await request(app).post('/api/auth/reset').send({ username: 'rs_limit', recoveryCode: reg.body.recoveryCode, newPassword: 'newpass123' })).status).toBe(200);
  }, 20_000);
});

describe('비밀번호 변경·회원가입 검증', () => {
  it('/password — 항목 누락·타입·8자 미만 400, 현재 비밀번호 불일치 400, 성공 시 현재 세션만 유지', async () => {
    const u = await register(app, 'pw_user');
    const second = await login('pw_user', 'password123');
    expect((await request(app).post('/api/auth/password').set(auth(u)).send({ currentPassword: 'password123' })).body).toEqual({ error: '모든 항목을 입력하세요' });
    expect((await request(app).post('/api/auth/password').set(auth(u)).send({ currentPassword: 'password123', newPassword: 12345678 })).body).toEqual({ error: '모든 항목을 입력하세요' });
    expect((await request(app).post('/api/auth/password').set(auth(u)).send({ currentPassword: 'password123', newPassword: 'abcdefg' })).body).toEqual({ error: '새 비밀번호는 8자 이상이어야 합니다' });
    expect((await request(app).post('/api/auth/password').set(auth(u)).send({ currentPassword: 'wrong-one', newPassword: 'abcdefgh' })).body).toEqual({ error: '현재 비밀번호가 올바르지 않습니다' });
    const ok = await request(app).post('/api/auth/password').set(auth(u)).send({ currentPassword: 'password123', newPassword: 'abcdefgh' }); // 정확히 8자
    expect(ok.body).toEqual({ ok: true });
    expect((await request(app).get('/api/auth/me').set(auth(u))).status).toBe(200); // 내 세션 유지
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${second.body.token}`)).status).toBe(401); // 다른 세션 무효
    expect((await login('pw_user', 'abcdefgh')).status).toBe(200);
    expect((await login('pw_user', 'password123')).status).toBe(400);
  }, 20_000);

  it('/register — 아이디 형식·8자 미만·중복, name 20자 절단·빈 값 null', async () => {
    expect((await request(app).post('/api/auth/register').send({ username: 'bad name', password: 'password123' })).body).toEqual({ error: '아이디는 영문·숫자·_ 3~20자입니다' });
    expect((await request(app).post('/api/auth/register').send({ username: 'ok_name', password: 'seven77' })).body).toEqual({ error: '비밀번호는 8자 이상이어야 합니다' });
    expect((await request(app).post('/api/auth/register').send({ username: 'ok_name' })).body).toEqual({ error: '아이디와 비밀번호를 입력하세요' });
    const long = await request(app).post('/api/auth/register').send({ username: 'reg_long', password: 'eight888', name: '  ' + 'ㄱ'.repeat(25) });
    expect(long.status).toBe(200);
    expect(long.body.user.name).toBe('ㄱ'.repeat(20));
    const blank = await request(app).post('/api/auth/register').send({ username: 'reg_blank', password: 'eight888', name: '   ' });
    expect(blank.body.user.name).toBeNull();
    expect((await request(app).post('/api/auth/register').send({ username: 'reg_blank', password: 'eight888' })).body).toEqual({ error: '이미 존재하는 아이디입니다' });
    // 로그인 응답의 name 은 null 또는 저장값
    expect((await login('reg_long', 'eight888')).body.user.name).toBe('ㄱ'.repeat(20));
    expect((await login('reg_blank', 'eight888')).body.user.name).toBeNull();
  }, 20_000);
});

describe('프로필 (PATCH /me · /names · /avatar · ?token=)', () => {
  it('변경 항목 없음 400, 이메일·전화 형식, 길이 상한, 빈 문자열은 지움', async () => {
    const u = await register(app, 'pf_user');
    expect((await request(app).patch('/api/auth/me').set(auth(u)).send({})).body).toEqual({ error: '변경할 항목이 없어요' });
    expect((await request(app).patch('/api/auth/me').set(auth(u)).send({ avatar: '' })).body).toEqual({ error: '올바르지 않은 아바타입니다' });
    expect((await request(app).patch('/api/auth/me').set(auth(u)).send({ avatar: '123456789' })).body).toEqual({ error: '올바르지 않은 아바타입니다' });
    expect((await request(app).patch('/api/auth/me').set(auth(u)).send({ avatar: '🐧' })).body).toEqual({ ok: true });
    for (const bad of ['no-at.com', 'a@b', 'x a@b.co', 'a@b.co x', 'a@b .co']) {
      expect((await request(app).patch('/api/auth/me').set(auth(u)).send({ email: bad })).body, bad).toEqual({ error: '이메일 형식이 올바르지 않아요' });
    }
    for (const bad of ['010-1234-5678x', 'x010', '010 1234 5678 ext']) {
      expect((await request(app).patch('/api/auth/me').set(auth(u)).send({ phone: bad })).body, bad).toEqual({ error: '전화번호는 숫자와 - + ( )만 쓸 수 있어요' });
    }
    const ok = await request(app).patch('/api/auth/me').set(auth(u)).send({
      name: ' 이주호 ',
      email: '  juho@example.com  ',
      phone: ' +82 (10) 1234-5678 ',
      address: 'a'.repeat(200),
    });
    expect(ok.body).toEqual({ ok: true, name: '이주호' });
    const me = await request(app).get('/api/auth/me').set(auth(u));
    expect(me.body).toEqual({ id: u.id, username: 'pf_user', avatar: '🐧', name: '이주호', email: 'juho@example.com', phone: '+82 (10) 1234-5678', address: 'a'.repeat(120) });
    // 80자 이메일 절단은 형식 검사보다 먼저 — 잘려서 형식이 깨지면 400
    expect((await request(app).patch('/api/auth/me').set(auth(u)).send({ email: 'a'.repeat(78) + '@b.com' })).status).toBe(400);
    // 빈 문자열 = 지움, name 은 null 로 응답
    expect((await request(app).patch('/api/auth/me').set(auth(u)).send({ email: '', phone: '', address: '', name: '' })).body).toEqual({ ok: true, name: null });
    expect((await request(app).get('/api/auth/me').set(auth(u))).body).toMatchObject({ name: null, email: null, phone: null, address: null });
    // /names 는 name 있는 사용자만
    await request(app).patch('/api/auth/me').set(auth(u)).send({ name: '효헌' });
    const names = await request(app).get('/api/auth/names').set(auth(u));
    expect(names.body).toContainEqual({ username: 'pf_user', name: '효헌' });
    expect(names.body.some((n: { username: string }) => n.username === 'rl_user')).toBe(false);
  }, 20_000);

  it('아바타 업로드 — 이미지 아니면 400, 빈 파일 400, 5MB 초과 413, 성공 시 파일 저장 + avatar URL', async () => {
    const u = await register(app, 'av_user');
    expect((await request(app).post('/api/auth/avatar').set(auth(u)).set('Content-Type', 'text/plain').send('hello')).body).toEqual({ error: '이미지 파일만 올릴 수 있어요' });
    const empty = await request(app).post('/api/auth/avatar').set(auth(u)).set('Content-Type', 'image/png').send(Buffer.alloc(0));
    expect(empty.body).toEqual({ error: '빈 파일이에요' });
    const big = await request(app).post('/api/auth/avatar').set(auth(u)).set('Content-Type', 'image/png').send(Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: '사진이 너무 커요 (최대 5MB)' });
    const ok = await request(app).post('/api/auth/avatar').set(auth(u)).set('Content-Type', 'image/jpeg').send(Buffer.from('jpeg-bytes'));
    expect(ok.status).toBe(200);
    expect(ok.body.avatar).toMatch(/^\/api\/workspaces\/uploads\/avatar-[0-9a-f-]+\.jpeg$/);
    const filename = (ok.body.avatar as string).split('/').pop()!;
    expect(fs.readFileSync(path.join(UPLOAD_DIR, filename)).toString()).toBe('jpeg-bytes');
    expect((db.prepare('SELECT avatar FROM users WHERE id = ?').get(u.id) as { avatar: string }).avatar).toBe(ok.body.avatar);
    // 서빙은 인증 없이, 없는 파일은 404
    const served = await request(app).get(ok.body.avatar);
    expect(served.status).toBe(200);
    expect(served.body.toString()).toBe('jpeg-bytes');
    expect((await request(app).get('/api/workspaces/uploads/nope.png')).status).toBe(404);
  }, 20_000);

  it('?token= 쿼리 인증 — 헤더 없이도 통과, 로그아웃은 그 토큰을 지운다, 만료 세션 401', async () => {
    const u = await register(app, 'tk_user');
    expect((await request(app).get(`/api/auth/me?token=${u.token}`)).body.username).toBe('tk_user');
    expect((await request(app).get('/api/auth/me')).body).toEqual({ error: '로그인이 필요합니다' });
    expect((await request(app).get('/api/auth/me?token=bogus')).body).toEqual({ error: '세션이 만료됐습니다. 다시 로그인하세요' });
    db.prepare("UPDATE sessions SET created_at = datetime('now', '-31 days') WHERE token = ?").run(u.token);
    expect((await request(app).get(`/api/auth/me?token=${u.token}`)).status).toBe(401);
    db.prepare("UPDATE sessions SET created_at = datetime('now', '-29 days') WHERE token = ?").run(u.token);
    expect((await request(app).get(`/api/auth/me?token=${u.token}`)).status).toBe(200);
    expect((await request(app).post(`/api/auth/logout?token=${u.token}`)).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(u.token)).toBeUndefined();
    expect((await request(app).get(`/api/auth/me?token=${u.token}`)).status).toBe(401);
  }, 20_000);

  it('아바타 확장자 — content-type 파라미터는 떼고 서브타입만 (image/jpeg; charset=binary → .jpeg)', async () => {
    const r = await request(app).post('/api/auth/register').send({ username: 'avatar_ct', password: 'password123' });
    const up = await request(app)
      .post('/api/auth/avatar')
      .set('Authorization', `Bearer ${r.body.token}`)
      .set('Content-Type', 'image/jpeg; charset=binary')
      .send(Buffer.alloc(100, 1));
    expect(up.status).toBe(200);
    expect(up.body.avatar).toMatch(/\.jpeg$/);
  });
});
