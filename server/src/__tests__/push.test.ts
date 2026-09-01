import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * push.ts — 웹푸시(PWA). VAPID 키가 있을 때: 공개키 API, 기기 단위 구독 upsert/해지,
 * 발송 시 만료 구독(404/410) 청소·손상 구독 청소·기타 오류 로그. (키 없는 경로는 push-disabled.test.ts)
 */
const { sendNotification, setVapidDetails } = vi.hoisted(() => {
  process.env.VAPID_PUBLIC_KEY = 'pub-key-test';
  process.env.VAPID_PRIVATE_KEY = 'priv-key-test';
  delete process.env.VAPID_SUBJECT;
  return {
    sendNotification: vi.fn(async (..._a: unknown[]) => ({ statusCode: 201 })),
    setVapidDetails: vi.fn(),
  };
});
vi.mock('web-push', () => ({ default: { setVapidDetails, sendNotification } }));

import { createApp } from '../app.js';
import db from '../db.js';
import { pushEnabled, sendPushToUser } from '../push.js';
import { flush } from './helpers/openaiMock.js';

const app = createApp();
const subOf = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

async function reg(name: string) {
  const r = await request(app).post('/api/auth/register').send({ username: name, password: 'password123' });
  return r.body as { token: string; user: { id: number } };
}
const rows = (userId: number) =>
  db.prepare('SELECT id, endpoint, user_id, sub FROM push_subs WHERE user_id = ? ORDER BY id').all(userId) as { id: number; endpoint: string; user_id: number; sub: string }[];

beforeEach(() => {
  sendNotification.mockClear();
});

describe('설정·구독 API', () => {
  it('import 시 VAPID 등록(기본 subject), GET /key는 공개키, 비로그인 401', async () => {
    expect(pushEnabled).toBe(true);
    expect(setVapidDetails).toHaveBeenCalledWith('mailto:admin@example.com', 'pub-key-test', 'priv-key-test');
    const a = await reg('push_a');
    const r = await request(app).get('/api/push/key').set('Authorization', `Bearer ${a.token}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ key: 'pub-key-test' });
    expect((await request(app).get('/api/push/key')).status).toBe(401);
  });

  it('subscribe — 검증 400, endpoint 기준 upsert(기기 교체 시 소유자 갱신), unsubscribe는 내 구독만', async () => {
    const a = await reg('push_b');
    const b = await reg('push_c');
    const H = { Authorization: `Bearer ${a.token}` };
    for (const body of [{}, { subscription: { keys: {} } }, { subscription: { endpoint: 'https://x', keys: null } }, { subscription: { endpoint: 42, keys: {} } }]) {
      const r = await request(app).post('/api/push/subscribe').set(H).send(body);
      expect(r.status).toBe(400);
    }
    const ok = await request(app).post('/api/push/subscribe').set(H).send({ subscription: subOf('https://push/1') });
    expect(ok.body).toEqual({ ok: true });
    await request(app).post('/api/push/subscribe').set(H).send({ subscription: subOf('https://push/2') });
    expect(rows(a.user.id).map((r) => r.endpoint)).toEqual(['https://push/1', 'https://push/2']);

    // 같은 기기(endpoint)를 다른 계정이 구독 → 소유자·sub 갱신, 행은 하나
    const moved = { ...subOf('https://push/1'), keys: { p256dh: 'new', auth: 'n' } };
    await request(app).post('/api/push/subscribe').set('Authorization', `Bearer ${b.token}`).send({ subscription: moved });
    expect(rows(a.user.id).map((r) => r.endpoint)).toEqual(['https://push/2']);
    expect(rows(b.user.id)).toHaveLength(1);
    expect(JSON.parse(rows(b.user.id)[0].sub)).toEqual(moved);

    // 남의 endpoint 해지는 무시, 내 것은 삭제, endpoint 없으면 그냥 ok
    await request(app).post('/api/push/unsubscribe').set(H).send({ endpoint: 'https://push/1' });
    expect(rows(b.user.id)).toHaveLength(1);
    const un = await request(app).post('/api/push/unsubscribe').set(H).send({ endpoint: 'https://push/2' });
    expect(un.body).toEqual({ ok: true });
    expect(rows(a.user.id)).toHaveLength(0);
    expect((await request(app).post('/api/push/unsubscribe').set(H).send({})).body).toEqual({ ok: true });
  });
});

describe('sendPushToUser', () => {
  it('모든 기기로 발송(TTL 3600·JSON 페이로드), 404/410은 구독 삭제, 손상 JSON도 삭제, 기타 오류는 로그만', async () => {
    const a = await reg('push_d');
    const ins = db.prepare('INSERT INTO push_subs (user_id, endpoint, sub) VALUES (?, ?, ?)');
    ins.run(a.user.id, 'https://push/ok', JSON.stringify(subOf('https://push/ok')));
    ins.run(a.user.id, 'https://push/broken', '{not json');
    ins.run(a.user.id, 'https://push/gone', JSON.stringify(subOf('https://push/gone')));
    ins.run(a.user.id, 'https://push/404', JSON.stringify(subOf('https://push/404')));
    ins.run(a.user.id, 'https://push/err', JSON.stringify(subOf('https://push/err')));
    sendNotification.mockImplementation(async (sub: unknown) => {
      const ep = (sub as { endpoint: string }).endpoint;
      if (ep.endsWith('/gone')) throw { statusCode: 410 };
      if (ep.endsWith('/404')) throw { statusCode: 404 };
      if (ep.endsWith('/err')) throw new Error('boom');
      return { statusCode: 201 };
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const payload = { title: 'exist AI', body: '서명 대기 중', tag: 'file-ack', url: '/' };
    sendPushToUser(a.user.id, payload);
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(4); // 손상 JSON은 발송 전 삭제
    expect(sendNotification).toHaveBeenCalledWith(subOf('https://push/ok'), JSON.stringify(payload), { TTL: 3600 });
    expect(rows(a.user.id).map((r) => r.endpoint)).toEqual(['https://push/ok', 'https://push/err']);
    expect(err).toHaveBeenCalledWith('[push] 발송 실패:', expect.any(Error));
    err.mockRestore();

    // 구독 없는 사용자는 아무것도 안 한다
    sendNotification.mockClear();
    sendPushToUser(999_999, payload);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
