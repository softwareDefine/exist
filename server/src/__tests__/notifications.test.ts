import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { notifyUser } from '../notify.js';
import db from '../db.js';

/*
 * NOTI-01 (영속/표시) 서버 검증 — notifyUser가 DB에 영속하고,
 * GET /api/notifications 목록·안읽음 카운트·읽음/치우기/삭제가 정확한지.
 * (NOTI-02 실시간 푸시는 소켓 E2E — 2브라우저 QA에서 별도 검증)
 */
const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string };
}

function userId(username: string): number {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
}

describe('알림 API (NOTI-01)', () => {
  it('notifyUser → DB 영속 → 목록·안읽음 카운트', async () => {
    const { token } = await registerUser('noti_user1');
    const uid = userId('noti_user1');

    notifyUser(uid, { from: 'exist AI', text: '첫 번째 알림' });
    notifyUser(uid, { from: 'exist AI', text: '두 번째 알림', kind: 'call' });

    const r = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.unread).toBe(2);
    expect(r.body.items).toHaveLength(2);
    // 최신순 (id DESC)
    expect(r.body.items[0].text).toBe('두 번째 알림');
    expect(r.body.items[0].kind).toBe('call');
    expect(r.body.items[0].read).toBe(false);
  });

  it('meetingCode 있는 알림은 회의 정보(썸네일용)를 함께 준다', async () => {
    const { token } = await registerUser('noti_user2');
    const uid = userId('noti_user2');

    const m = await request(app)
      .post('/api/meetings')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '알림용 회의' });
    expect(m.status).toBe(200);
    const code = m.body.code as string;

    notifyUser(uid, { from: 'exist AI', text: '회의 알림', meetingCode: code });

    const r = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.items[0].meeting).toBeTruthy();
    expect(r.body.items[0].meeting.code).toBe(code);
    expect(r.body.items[0].meeting.title).toBe('알림용 회의');
  });

  it('읽음 처리 → unread 0, 항목은 유지', async () => {
    const { token } = await registerUser('noti_user3');
    notifyUser(userId('noti_user3'), { from: 'exist AI', text: '읽을 알림' });

    await request(app).post('/api/notifications/read').set('Authorization', `Bearer ${token}`);
    const r = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.unread).toBe(0);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].read).toBe(true);
  });

  it('치우기(clear) → 기본 목록에서 빠지고 ?all=1에는 남는다', async () => {
    const { token } = await registerUser('noti_user4');
    notifyUser(userId('noti_user4'), { from: 'exist AI', text: '치울 알림' });

    await request(app).post('/api/notifications/clear').set('Authorization', `Bearer ${token}`);

    const base = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${token}`);
    expect(base.body.items).toHaveLength(0);
    expect(base.body.unread).toBe(0);

    const all = await request(app)
      .get('/api/notifications?all=1')
      .set('Authorization', `Bearer ${token}`);
    expect(all.body.items).toHaveLength(1);
    expect(all.body.items[0].cleared).toBe(true);
  });

  it('완전 삭제(DELETE) → ?all=1에서도 사라진다', async () => {
    const { token } = await registerUser('noti_user5');
    notifyUser(userId('noti_user5'), { from: 'exist AI', text: '지울 알림' });

    await request(app).delete('/api/notifications').set('Authorization', `Bearer ${token}`);
    const all = await request(app)
      .get('/api/notifications?all=1')
      .set('Authorization', `Bearer ${token}`);
    expect(all.body.items).toHaveLength(0);
  });

  it('남의 알림은 안 보인다', async () => {
    const a = await registerUser('noti_owner');
    await registerUser('noti_other');
    notifyUser(userId('noti_owner'), { from: 'exist AI', text: '주인만 볼 알림' });

    const other = await request(app)
      .post('/api/auth/login')
      .send({ username: 'noti_other', password: 'password123' });
    const r = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${other.body.token}`);
    expect(r.body.items).toHaveLength(0);

    const owner = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${a.token}`);
    expect(owner.body.items).toHaveLength(1);
  });

  it('무인증 401', async () => {
    const r = await request(app).get('/api/notifications');
    expect(r.status).toBe(401);
  });
});
