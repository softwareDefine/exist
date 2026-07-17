import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { ensureDefaultChannel } from '../channels.js';
import db from '../db.js';

/*
 * 채팅 채널 — 그룹당 채널 여러 개.
 * 기본 채널 자동 생성·레거시 백필, CRUD 권한, 채널별 메시지 필터, 삭제 정합.
 */
const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string };
}

function userId(username: string): number {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
}

async function setup(prefix: string) {
  const host = await registerUser(`${prefix}_host`);
  const member = await registerUser(`${prefix}_member`);
  const m = await request(app)
    .post('/api/meetings')
    .set('Authorization', `Bearer ${host.token}`)
    .send({ title: `${prefix} 그룹` });
  const code = m.body.code as string;
  await request(app)
    .post('/api/meetings/join')
    .set('Authorization', `Bearer ${member.token}`)
    .send({ code });
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number })
    .id;
  return { host, member, code, meetingId };
}

describe('채팅 채널', () => {
  it('첫 조회 시 기본 채널 "일반"이 생기고 레거시 메시지를 흡수한다', async () => {
    const { host, code, meetingId } = await setup('ch1');
    // 레거시 메시지 (channel_id 없음)
    db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
      meetingId,
      userId('ch1_host'),
      '옛날 메시지',
    );

    const r = await request(app)
      .get(`/api/meetings/${code}/channels`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].name).toBe('일반');
    expect(r.body[0].isDefault).toBe(true);

    // 백필 확인
    const backfilled = db
      .prepare('SELECT channel_id FROM messages WHERE meeting_id = ?')
      .get(meetingId) as { channel_id: number | null };
    expect(backfilled.channel_id).toBe(r.body[0].id);
  });

  it('참가자는 채널을 만들 수 있고, 중복 이름은 409', async () => {
    const { member, code } = await setup('ch2');
    const c = await request(app)
      .post(`/api/meetings/${code}/channels`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: '#개발' });
    expect(c.status).toBe(200);
    expect(c.body.name).toBe('개발'); // # 제거
    const dup = await request(app)
      .post(`/api/meetings/${code}/channels`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: '개발' });
    expect(dup.status).toBe(409);
  });

  it('비참가자는 채널 조회/생성 403', async () => {
    const { code } = await setup('ch3');
    const stranger = await registerUser('ch3_stranger');
    const list = await request(app)
      .get(`/api/meetings/${code}/channels`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(list.status).toBe(403);
    const create = await request(app)
      .post(`/api/meetings/${code}/channels`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ name: '몰래' });
    expect(create.status).toBe(403);
  });

  it('메시지가 채널별로 분리 조회된다', async () => {
    const { host, code, meetingId } = await setup('ch4');
    const defaultId = ensureDefaultChannel(meetingId, userId('ch4_host'));
    const dev = await request(app)
      .post(`/api/meetings/${code}/channels`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ name: '개발' });
    db.prepare('INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)').run(
      meetingId,
      userId('ch4_host'),
      '일반 얘기',
      defaultId,
    );
    db.prepare('INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)').run(
      meetingId,
      userId('ch4_host'),
      '개발 얘기',
      dev.body.id,
    );

    const generalMsgs = await request(app)
      .get(`/api/meetings/${code}/messages`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(generalMsgs.body).toHaveLength(1);
    expect(generalMsgs.body[0].text).toBe('일반 얘기');
    expect(generalMsgs.body[0].channelId).toBe(defaultId);

    const devMsgs = await request(app)
      .get(`/api/meetings/${code}/messages?channel=${dev.body.id}`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(devMsgs.body).toHaveLength(1);
    expect(devMsgs.body[0].text).toBe('개발 얘기');
  });

  it('이름 변경은 호스트/생성자만, 삭제는 호스트만·기본 채널 불가', async () => {
    const { host, member, code } = await setup('ch5');
    const ch = await request(app)
      .post(`/api/meetings/${code}/channels`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: '잡담' });

    // 생성자(member) 이름 변경 OK
    const rename = await request(app)
      .patch(`/api/meetings/${code}/channels/${ch.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: '수다' });
    expect(rename.status).toBe(200);

    // member는 삭제 불가 (호스트 아님)
    const delByMember = await request(app)
      .delete(`/api/meetings/${code}/channels/${ch.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(delByMember.status).toBe(403);

    // 기본 채널 삭제 불가
    const channels = await request(app)
      .get(`/api/meetings/${code}/channels`)
      .set('Authorization', `Bearer ${host.token}`);
    const def = channels.body.find((c: { isDefault: boolean }) => c.isDefault);
    const delDefault = await request(app)
      .delete(`/api/meetings/${code}/channels/${def.id}`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(delDefault.status).toBe(400);

    // 호스트는 일반 채널 삭제 OK (메시지도 같이)
    const delByHost = await request(app)
      .delete(`/api/meetings/${code}/channels/${ch.body.id}`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(delByHost.status).toBe(200);
  });

  it('채널 있는 회의 삭제가 FK 강제 환경에서도 된다', async () => {
    db.pragma('foreign_keys = ON');
    try {
      const { host, code, meetingId } = await setup('ch6');
      await request(app)
        .post(`/api/meetings/${code}/channels`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({ name: '개발' });
      db.prepare('INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)').run(
        meetingId,
        userId('ch6_host'),
        '메시지',
        ensureDefaultChannel(meetingId, userId('ch6_host')),
      );
      const del = await request(app)
        .delete(`/api/meetings/${code}`)
        .set('Authorization', `Bearer ${host.token}`);
      expect(del.status).toBe(200);
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM chat_channels WHERE meeting_id = ?').get(meetingId),
      ).toEqual({ n: 0 });
    } finally {
      db.pragma('foreign_keys = OFF');
    }
  });

  it('recap은 채널 무관하게 회의 전체 채팅을 본다', async () => {
    const { host, code, meetingId } = await setup('ch7');
    const defaultId = ensureDefaultChannel(meetingId, userId('ch7_host'));
    const dev = await request(app)
      .post(`/api/meetings/${code}/channels`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ name: '개발' });
    db.prepare('INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)').run(
      meetingId,
      userId('ch7_host'),
      '배포는 금요일로 확정합니다',
      defaultId,
    );
    db.prepare('INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)').run(
      meetingId,
      userId('ch7_host'),
      '테스트 정리 부탁해요',
      dev.body.id,
    );
    const { runRecapForMeeting } = await import('../recap.js');
    const recapId = await runRecapForMeeting(code, [userId('ch7_host')]);
    expect(recapId).not.toBeNull();
    const row = db
      .prepare('SELECT decisions, actions FROM meeting_recaps WHERE id = ?')
      .get(recapId) as { decisions: string; actions: string };
    expect(JSON.parse(row.decisions).length + JSON.parse(row.actions).length).toBe(2);
  });
});
