import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

// setup.ts 가 DATA_DIR 을 임시 빈 DB 로 잡아두므로 실데이터와 격리된다.
const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r;
}

describe('인증 API (AUTH-02·03·04·08)', () => {
  it('가입 검증 — 비밀번호 8자 미만 400', async () => {
    const r = await registerUser('shortpw_user', 'short');
    expect(r.status).toBe(400);
  });

  it('가입 검증 — 잘못된 아이디 형식 400', async () => {
    const r = await registerUser('a'); // 3자 미만
    expect(r.status).toBe(400);
  });

  it('가입 성공 → 토큰 + 1회용 복구 코드', async () => {
    const r = await registerUser('qa_user1');
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.recoveryCode).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  });

  it('아이디 중복 409', async () => {
    await registerUser('dup_user');
    const r = await registerUser('dup_user');
    expect(r.status).toBe(409);
  });

  it('로그인 성공 / 틀린 비번 실패', async () => {
    await registerUser('login_user');
    const ok = await request(app)
      .post('/api/auth/login')
      .send({ username: 'login_user', password: 'password123' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    const bad = await request(app)
      .post('/api/auth/login')
      .send({ username: 'login_user', password: 'wrongpass' });
    expect(bad.status).toBe(401);
  });

  it('무효 토큰으로 보호 API 호출 시 401 (AUTH-08)', async () => {
    const r = await request(app).get('/api/auth/me').set('Authorization', 'Bearer invalid-token');
    expect(r.status).toBe(401);
  });

  it('계정 정보 부분 수정 — 이메일·전화번호·주소, 넘어온 필드만 갱신', async () => {
    const reg = await registerUser('contact_user');
    const token = reg.body.token as string;
    const patch = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'juho@example.com', phone: '010-1234-5678' });
    expect(patch.status).toBe(200);

    // 주소만 추가로 수정 — 기존 이메일·전화번호는 유지돼야 함
    await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: '서울시 어딘가 123' });
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.email).toBe('juho@example.com');
    expect(me.body.phone).toBe('010-1234-5678');
    expect(me.body.address).toBe('서울시 어딘가 123');

    // 형식 검증 — 잘못된 이메일·전화번호 400
    const badEmail = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'not-an-email' });
    expect(badEmail.status).toBe(400);
    const badPhone = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '전화번호아님' });
    expect(badPhone.status).toBe(400);
  });
});

describe('보안 (NFR-04 · RUN-04 · INS-01)', () => {
  it('보안 헤더가 응답에 있다 (NFR-04)', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('코드 실행은 무인증 401', async () => {
    const r = await request(app)
      .post('/api/run/exec')
      .send({ lang: 'js', entry: 'a.js', files: [] });
    expect(r.status).toBe(401);
  });

  it('RUNNER_URL·CODE_EXEC_ENABLED 없으면 인증돼도 403 (RUN-04 가드)', async () => {
    const reg = await registerUser('exec_user');
    const r = await request(app)
      .post('/api/run/exec')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ lang: 'js', entry: 'a.js', files: [{ path: 'a.js', content: 'console.log(1)' }] });
    expect(r.status).toBe(403);
  });

  it('insights 무인증 401', async () => {
    const r = await request(app).get('/api/insights/1');
    expect(r.status).toBe(401);
  });

  it('insights 비멤버 403 (INS-01)', async () => {
    const reg = await registerUser('nonmember_user');
    const r = await request(app)
      .get('/api/insights/999')
      .set('Authorization', `Bearer ${reg.body.token}`);
    expect(r.status).toBe(403);
  });
});
