import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';

// setup.ts 가 DATA_DIR 을 임시 빈 DB 로 잡아두므로 실데이터와 격리된다.
const app = createApp();

async function registerUser(username: string, password = 'password123', name?: string) {
  const r = await request(app).post('/api/auth/register').send({ username, password, name });
  return r;
}

const auth = (t: string) => `Bearer ${t}`;
const userRow = (username: string) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | { id: number; pw_hash: string; pw_salt: string; recovery_hash: string; recovery_salt: string; name: string | null; email: string | null; phone: string | null; address: string | null; avatar: string }
    | undefined;
const sessionCount = (userId: number) =>
  (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId) as { n: number }).n;

describe('인증 API (AUTH-02·03·04·08)', () => {
  it('가입 검증 — 비밀번호 8자 미만 400', async () => {
    const r = await registerUser('shortpw_user', 'short');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: '비밀번호는 8자 이상이어야 합니다' });
    expect(userRow('shortpw_user')).toBeUndefined(); // 실패한 가입은 행을 남기지 않는다
    // 아이디·비밀번호 누락은 별도 문구
    const empty = await request(app).post('/api/auth/register').send({ username: 'no_pw_user' });
    expect(empty.status).toBe(400);
    expect(empty.body).toEqual({ error: '아이디와 비밀번호를 입력하세요' });
  });

  it('가입 검증 — 잘못된 아이디 형식 400', async () => {
    const r = await registerUser('a'); // 3자 미만
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: '아이디는 영문·숫자·_ 3~20자입니다' });
    expect((await registerUser('한글아이디')).status).toBe(400);
    expect((await registerUser('with space')).status).toBe(400);
    expect((await registerUser('a'.repeat(21))).status).toBe(400);
    expect((await registerUser('ok_user_20chars_____')).status).toBe(200); // 정확히 20자 경계
  });

  it('가입 성공 → 토큰 + 1회용 복구 코드', async () => {
    const r = await registerUser('qa_user1');
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.recoveryCode).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    expect(r.body.user).toEqual({ id: expect.any(Number), username: 'qa_user1', name: null });
    // DB — 비밀번호·복구 코드는 해시만 저장, 세션 1개, 토큰은 UUID
    const row = userRow('qa_user1')!;
    expect(row.id).toBe(r.body.user.id);
    expect(row.pw_hash).toMatch(/^[0-9a-f]{128}$/);
    expect(row.recovery_hash).toMatch(/^[0-9a-f]{128}$/);
    expect(row.pw_hash).not.toBe(row.recovery_hash);
    expect(sessionCount(row.id)).toBe(1);
    expect(r.body.token).toMatch(/^[0-9a-f-]{36}$/);
    // 표시 이름은 trim + 20자 제한
    const named = await registerUser('qa_named', 'password123', '  이주호'.padEnd(30, '호'));
    expect(named.body.user.name).toHaveLength(20);
    expect(named.body.user.name.startsWith('이주호')).toBe(true);
  });

  it('아이디 중복 409', async () => {
    const first = await registerUser('dup_user');
    const r = await registerUser('dup_user');
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: '이미 존재하는 아이디입니다' });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get('dup_user') as { n: number }).n,
    ).toBe(1);
    expect(sessionCount(first.body.user.id)).toBe(1); // 실패한 시도는 세션을 만들지 않는다
  });

  it('로그인 성공 / 틀린 비번 실패', async () => {
    const reg = await registerUser('login_user');
    const ok = await request(app)
      .post('/api/auth/login')
      .send({ username: 'login_user', password: 'password123' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.token).not.toBe(reg.body.token); // 로그인마다 새 세션
    expect(ok.body.user).toEqual({ id: reg.body.user.id, username: 'login_user', name: null });
    expect(ok.body.recoveryCode).toBeUndefined(); // 복구 코드는 가입 응답에서만
    expect(sessionCount(reg.body.user.id)).toBe(2);
    const bad = await request(app)
      .post('/api/auth/login')
      .send({ username: 'login_user', password: 'wrongpass' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: '아이디 또는 비밀번호가 틀렸습니다' });
    expect(sessionCount(reg.body.user.id)).toBe(2);
    // 없는 아이디도 같은 문구 (계정 존재 여부 노출 금지)
    const ghost = await request(app).post('/api/auth/login').send({ username: 'no_such_user', password: 'password123' });
    expect(ghost.status).toBe(400);
    expect(ghost.body).toEqual(bad.body);
  });

  it('무효 토큰으로 보호 API 호출 시 401 (AUTH-08)', async () => {
    const r = await request(app).get('/api/auth/me').set('Authorization', 'Bearer invalid-token');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: '세션이 만료됐습니다. 다시 로그인하세요' });
    const none = await request(app).get('/api/auth/me');
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ error: '로그인이 필요합니다' });
    // 새 탭용 ?token= 쿼리도 헤더와 동일하게 인증된다
    const reg = await registerUser('query_token_user');
    const viaQuery = await request(app).get(`/api/auth/me?token=${reg.body.token}`);
    expect(viaQuery.status).toBe(200);
    expect(viaQuery.body).toEqual({
      id: reg.body.user.id,
      username: 'query_token_user',
      avatar: '🐧',
      name: null,
      email: null,
      phone: null,
      address: null,
    });
  });

  it('로그아웃하면 그 세션만 무효화된다', async () => {
    const reg = await registerUser('logout_user');
    const second = await request(app).post('/api/auth/login').send({ username: 'logout_user', password: 'password123' });
    const out = await request(app).post('/api/auth/logout').set('Authorization', auth(reg.body.token));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect((await request(app).get('/api/auth/me').set('Authorization', auth(reg.body.token))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', auth(second.body.token))).status).toBe(200);
    expect(sessionCount(reg.body.user.id)).toBe(1);
  });

  it('비밀번호 변경 — 현재 비번 확인 후 다른 세션 전부 무효화', async () => {
    const reg = await registerUser('pwchange_user');
    const other = await request(app).post('/api/auth/login').send({ username: 'pwchange_user', password: 'password123' });
    const wrong = await request(app)
      .post('/api/auth/password')
      .set('Authorization', auth(reg.body.token))
      .send({ currentPassword: 'nope-nope', newPassword: 'newpassword1' });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: '현재 비밀번호가 올바르지 않습니다' });
    expect(sessionCount(reg.body.user.id)).toBe(2); // 실패 시 세션 그대로
    const short = await request(app)
      .post('/api/auth/password')
      .set('Authorization', auth(reg.body.token))
      .send({ currentPassword: 'password123', newPassword: 'short' });
    expect(short.status).toBe(400);
    const before = userRow('pwchange_user')!;
    const ok = await request(app)
      .post('/api/auth/password')
      .set('Authorization', auth(reg.body.token))
      .send({ currentPassword: 'password123', newPassword: 'newpassword1' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    const after = userRow('pwchange_user')!;
    expect(after.pw_hash).not.toBe(before.pw_hash);
    expect(after.pw_salt).not.toBe(before.pw_salt); // salt도 새로 뽑는다
    expect(after.recovery_hash).toBe(before.recovery_hash); // 복구 코드는 그대로
    expect(sessionCount(reg.body.user.id)).toBe(1);
    expect((await request(app).get('/api/auth/me').set('Authorization', auth(other.body.token))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', auth(reg.body.token))).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ username: 'pwchange_user', password: 'password123' })).status).toBe(400);
    expect((await request(app).post('/api/auth/login').send({ username: 'pwchange_user', password: 'newpassword1' })).status).toBe(200);
  });

  it('복구 코드로 비밀번호 재설정 — 1회용, 구분자·대소문자 관대, 전 세션 무효화', async () => {
    const reg = await registerUser('reset_user');
    const code = reg.body.recoveryCode as string;
    const bad = await request(app)
      .post('/api/auth/reset')
      .send({ username: 'reset_user', recoveryCode: 'AAAA-BBBB-CCCC-DDDD', newPassword: 'resetpass1' });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: '아이디 또는 복구 코드가 올바르지 않습니다' });
    // 소문자 + 구분자 없이 보내도 정규화되어 통과
    const ok = await request(app)
      .post('/api/auth/reset')
      .send({ username: 'reset_user', recoveryCode: code.toLowerCase().replace(/-/g, ' '), newPassword: 'resetpass1' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toEqual({ id: reg.body.user.id, username: 'reset_user' });
    expect(ok.body.recoveryCode).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    expect(ok.body.recoveryCode).not.toBe(code);
    expect(ok.body.token).not.toBe(reg.body.token);
    // 기존 세션은 죽고 새 토큰만 살아있다
    expect((await request(app).get('/api/auth/me').set('Authorization', auth(reg.body.token))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', auth(ok.body.token))).status).toBe(200);
    expect(sessionCount(reg.body.user.id)).toBe(1);
    expect((await request(app).post('/api/auth/login').send({ username: 'reset_user', password: 'resetpass1' })).status).toBe(200);
    // 옛 코드는 1회용 — 다시 쓰면 실패, 새 코드는 통과
    const reuse = await request(app)
      .post('/api/auth/reset')
      .send({ username: 'reset_user', recoveryCode: code, newPassword: 'resetpass2' });
    expect(reuse.status).toBe(400);
    const again = await request(app)
      .post('/api/auth/reset')
      .send({ username: 'reset_user', recoveryCode: ok.body.recoveryCode, newPassword: 'resetpass2' });
    expect(again.status).toBe(200);
  });

  it('계정 정보 부분 수정 — 이메일·전화번호·주소, 넘어온 필드만 갱신', async () => {
    const reg = await registerUser('contact_user');
    const token = reg.body.token as string;
    const patch = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'juho@example.com', phone: '010-1234-5678' });
    expect(patch.status).toBe(200);
    expect(patch.body).toEqual({ ok: true });

    // 주소만 추가로 수정 — 기존 이메일·전화번호는 유지돼야 함
    await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: '서울시 어딘가 123' });
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.email).toBe('juho@example.com');
    expect(me.body.phone).toBe('010-1234-5678');
    expect(me.body.address).toBe('서울시 어딘가 123');

    // 형식 검증 — 잘못된 이메일·전화번호 400, 값은 바뀌지 않는다
    const badEmail = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'not-an-email' });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body).toEqual({ error: '이메일 형식이 올바르지 않아요' });
    const badPhone = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '전화번호아님' });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body).toEqual({ error: '전화번호는 숫자와 - + ( )만 쓸 수 있어요' });
    expect(userRow('contact_user')).toMatchObject({
      email: 'juho@example.com',
      phone: '010-1234-5678',
      address: '서울시 어딘가 123',
    });

    // 빈 문자열 = 지움(null), 빈 body = 400, name 은 응답에 정규화된 값이 실린다
    const clear = await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ email: '', address: '   ' });
    expect(clear.status).toBe(200);
    expect(userRow('contact_user')).toMatchObject({ email: null, address: null, phone: '010-1234-5678' });
    const nothing = await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({});
    expect(nothing.status).toBe(400);
    expect(nothing.body).toEqual({ error: '변경할 항목이 없어요' });
    const named = await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ name: '  효헌  ' });
    expect(named.body).toEqual({ ok: true, name: '효헌' });
    expect((await request(app).patch('/api/auth/me').set('Authorization', `Bearer ${token}`).send({ name: '' })).body).toEqual({ ok: true, name: null });
    expect(userRow('contact_user')!.name).toBeNull();
  });
});

describe('보안 (NFR-04 · RUN-04 · INS-01)', () => {
  it('보안 헤더가 응답에 있다 (NFR-04)', async () => {
    const r = await request(app).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, service: 'exist' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    // 에러 응답(401)에도 같은 헤더가 붙는다
    const denied = await request(app).get('/api/auth/me');
    expect(denied.headers['x-content-type-options']).toBe('nosniff');
    expect(denied.headers['x-frame-options']).toBe('DENY');
    expect(denied.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('코드 실행은 무인증 401', async () => {
    const r = await request(app)
      .post('/api/run/exec')
      .send({ lang: 'js', entry: 'a.js', files: [] });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: '로그인이 필요합니다' });
    const bogus = await request(app)
      .post('/api/run/exec')
      .set('Authorization', 'Bearer nope')
      .send({ lang: 'js', entry: 'a.js', files: [] });
    expect(bogus.status).toBe(401);
    expect(bogus.body).toEqual({ error: '세션이 만료됐습니다. 다시 로그인하세요' });
  });

  it('RUNNER_URL·CODE_EXEC_ENABLED 없으면 인증돼도 403 (RUN-04 가드)', async () => {
    const reg = await registerUser('exec_user');
    const r = await request(app)
      .post('/api/run/exec')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ lang: 'js', entry: 'a.js', files: [{ path: 'a.js', content: 'console.log(1)' }] });
    expect(r.status).toBe(403);
    // 클라 콘솔이 그대로 보여주는 lines 형식 — 관리자 안내 문구 포함
    expect(r.body).toEqual({
      lines: [
        {
          type: 'error',
          text: '서버 코드 실행이 비활성화되어 있어요. (관리자: RUNNER_URL 또는 CODE_EXEC_ENABLED=1)',
        },
      ],
    });
    // 형식 오류는 가드보다 먼저 400
    const malformed = await request(app)
      .post('/api/run/exec')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ lang: 'js', entry: 'a.js', files: [{ content: 'x' }] });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: '잘못된 요청' });
  });

  it('insights 무인증 401', async () => {
    const r = await request(app).get('/api/insights/1');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: '로그인이 필요합니다' });
    const query = await request(app).get('/api/insights/1?token=not-a-session');
    expect(query.status).toBe(401);
    expect(query.body).toEqual({ error: '세션이 만료됐습니다. 다시 로그인하세요' });
  });

  it('insights 비멤버 403 (INS-01)', async () => {
    const reg = await registerUser('nonmember_user');
    const r = await request(app)
      .get('/api/insights/999')
      .set('Authorization', `Bearer ${reg.body.token}`);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: '조직 멤버가 아닙니다' });
    // 같은 사람이 멤버(소유자)인 조직은 200 — 가입 신청만 한(pending) 조직은 여전히 403
    const org = await request(app).post('/api/orgs').set('Authorization', auth(reg.body.token)).send({ name: 'INS 조직' });
    const mine = await request(app).get(`/api/insights/${org.body.id}`).set('Authorization', auth(reg.body.token));
    expect(mine.status).toBe(200);
    expect(mine.body.metrics).toMatchObject({ orgName: 'INS 조직', memberCount: 1, meetingCount: 0 });
    const applicant = await registerUser('pending_user');
    await request(app).post('/api/orgs/join').set('Authorization', auth(applicant.body.token)).send({ joinCode: org.body.joinCode });
    const pending = await request(app).get(`/api/insights/${org.body.id}`).set('Authorization', auth(applicant.body.token));
    expect(pending.status).toBe(403);
  });
});
