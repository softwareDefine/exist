import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

/* push.ts — VAPID 키가 없으면 전체가 조용히 비활성: 구독 API 404, 발송은 no-op (DB도 안 건드림) */
vi.hoisted(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

import { createApp } from '../app.js';
import db from '../db.js';
import { pushEnabled, sendPushToUser } from '../push.js';

const app = createApp();

describe('푸시 비활성', () => {
  it('key·subscribe는 404, unsubscribe는 ok, sendPushToUser는 아무것도 안 함', async () => {
    expect(pushEnabled).toBe(false);
    const r = await request(app).post('/api/auth/register').send({ username: 'pd_user', password: 'password123' });
    const H = { Authorization: `Bearer ${r.body.token}` };
    expect((await request(app).get('/api/push/key').set(H)).status).toBe(404);
    const sub = await request(app).post('/api/push/subscribe').set(H).send({ subscription: { endpoint: 'https://x', keys: {} } });
    expect(sub.status).toBe(404);
    expect((await request(app).post('/api/push/unsubscribe').set(H).send({ endpoint: 'https://x' })).body).toEqual({ ok: true });

    db.prepare('INSERT INTO push_subs (user_id, endpoint, sub) VALUES (?, ?, ?)').run(r.body.user.id, 'https://x', '{broken');
    sendPushToUser(r.body.user.id, { title: 't', body: 'b' });
    await new Promise((res) => setTimeout(res, 20));
    expect(db.prepare('SELECT COUNT(*) AS c FROM push_subs WHERE user_id = ?').get(r.body.user.id)).toEqual({ c: 1 });
  });
});
