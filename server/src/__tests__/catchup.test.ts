import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { runRecapForMeeting } from '../recap.js';
import db from '../db.js';

/*
 * P2 검증 — GET /api/agent/catchup.
 * 마지막 접속 이후의 recap(불참 구분)·새 할 일·안 읽은 DM·안 읽은 그룹 채팅이
 * 항목으로 나오는지. (AI 키 없는 환경 → 규칙 헤드라인 경로)
 */
const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string };
}

function userId(username: string): number {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
}

describe('놓친 것 브리핑 (P2)', () => {
  it('놓친 게 없으면 빈 목록 + 평온 헤드라인', async () => {
    const { token } = await registerUser('cu_calm');
    const r = await request(app).get('/api/agent/catchup').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(0);
    expect(r.body.headline).toContain('놓친 건 없어요');
  });

  it('불참 recap·자동 할 일·안 읽은 DM이 항목으로 나온다', async () => {
    const host = await registerUser('cu_host');
    const absent = await registerUser('cu_absent');

    // 회의 + 채팅 + recap (absent는 통화 불참)
    const m = await request(app)
      .post('/api/meetings')
      .set('Authorization', `Bearer ${host.token}`)
      .send({ title: '지사 협업 회의' });
    const code = m.body.code as string;
    await request(app)
      .post('/api/meetings/join')
      .set('Authorization', `Bearer ${absent.token}`)
      .send({ code });
    const mid = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number })
      .id;
    db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
      mid,
      userId('cu_host'),
      '배포 일정은 금요일로 확정합니다',
    );
    db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
      mid,
      userId('cu_host'),
      '@cu_absent 리허설 준비 부탁해요',
    );
    await runRecapForMeeting(code, [userId('cu_host')]);

    // 안 읽은 DM 하나
    db.prepare('INSERT INTO dm_messages (from_id, to_id, text) VALUES (?, ?, ?)').run(
      userId('cu_host'),
      userId('cu_absent'),
      '내일 아침에 잠깐 얘기해요',
    );

    const r = await request(app)
      .get('/api/agent/catchup')
      .set('Authorization', `Bearer ${absent.token}`);
    expect(r.status).toBe(200);
    const types = r.body.items.map((i: { type: string }) => i.type);

    // 불참 recap
    const recapItem = r.body.items.find((i: { type: string }) => i.type === 'recap');
    expect(recapItem).toBeTruthy();
    expect(recapItem.text).toContain('놓친 통화');
    expect(recapItem.meeting.code).toBe(code);

    // recap이 자동 배정한 할 일
    expect(types).toContain('todo');
    const todoItem = r.body.items.find((i: { type: string }) => i.type === 'todo');
    expect(todoItem.text).toContain('리허설');

    // 안 읽은 DM
    const dmItem = r.body.items.find((i: { type: string }) => i.type === 'dm');
    expect(dmItem.text).toContain('DM 1개');

    // 규칙 헤드라인에 핵심 집계
    expect(r.body.source).toBe('rule');
    expect(r.body.headline).toContain('놓친 통화 1건');

    // 참석자(host)에겐 같은 recap이 "놓친"이 아니어야 함
    const rh = await request(app)
      .get('/api/agent/catchup')
      .set('Authorization', `Bearer ${host.token}`);
    const hostRecap = rh.body.items.find((i: { type: string }) => i.type === 'recap');
    expect(hostRecap.text).not.toContain('놓친');
  });

  it('안 읽은 그룹 채팅이 chat 항목으로 나온다 (chat_reads 기준)', async () => {
    const a = await registerUser('cu_chat_a');
    const b = await registerUser('cu_chat_b');
    const m = await request(app)
      .post('/api/meetings')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ title: '채팅 회의' });
    await request(app)
      .post('/api/meetings/join')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ code: m.body.code });
    const mid = (
      db.prepare('SELECT id FROM meetings WHERE code = ?').get(m.body.code) as { id: number }
    ).id;
    // a가 메시지 2개 (b는 안 읽음 — chat_reads 없음)
    db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
      mid,
      userId('cu_chat_a'),
      '공유드립니다',
    );
    db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
      mid,
      userId('cu_chat_a'),
      '확인 부탁해요',
    );

    const r = await request(app)
      .get('/api/agent/catchup')
      .set('Authorization', `Bearer ${b.token}`);
    const chatItem = r.body.items.find((i: { type: string }) => i.type === 'chat');
    expect(chatItem).toBeTruthy();
    expect(chatItem.text).toContain('2개');
    expect(chatItem.meeting.title).toBe('채팅 회의');

    // 본인이 보낸 메시지는 안 읽음으로 세지 않는다
    const ra = await request(app)
      .get('/api/agent/catchup')
      .set('Authorization', `Bearer ${a.token}`);
    expect(ra.body.items.find((i: { type: string }) => i.type === 'chat')).toBeUndefined();
  });
});
