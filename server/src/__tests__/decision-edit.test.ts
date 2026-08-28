import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';
import { editDecision, withdrawDecision, listDecisions, listDecisionRevisions, ackDecision } from '../recap.js';

const app = createApp();

/*
 * 결정 정정·철회 — 인간 감독의 두 번째 층.
 * 원칙: 지우지 않는다(이력), 문장이 바뀌면 서명은 구버전(재확인), 관리자만, 철회는 상태.
 */

async function register(username: string) {
  const r = await request(app).post('/api/auth/register').send({ username, password: 'password123' });
  return r.body as { token: string; user: { id: number } };
}

async function setup(prefix: string) {
  const host = await register(`${prefix}_host`);
  const member = await register(`${prefix}_member`);
  const m = await request(app)
    .post('/api/meetings')
    .set('Authorization', `Bearer ${host.token}`)
    .send({ title: `${prefix} 그룹` });
  const code = m.body.code as string;
  await request(app).post('/api/meetings/join').set('Authorization', `Bearer ${member.token}`).send({ code });
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
  const hostId = (db.prepare('SELECT id FROM users WHERE username = ?').get(`${prefix}_host`) as { id: number }).id;
  const memberId = (db.prepare('SELECT id FROM users WHERE username = ?').get(`${prefix}_member`) as { id: number }).id;
  // AI가 정리한 recap 1건 — 결정 2개
  const recapId = Number(
    db
      .prepare(
        `INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, alts, attendees, source)
         VALUES (?, '온도 기준 논의', ?, ?, ?, ?, 'ai')`,
      )
      .run(
        meetingId,
        JSON.stringify(['검사 온도 65도로 상향', '야간조 인원 유지']),
        JSON.stringify(['편차가 컸음', '']),
        JSON.stringify([['70도 — 설비 한계'], []]),
        JSON.stringify([`${prefix}_host`]),
      ).lastInsertRowid,
  );
  return { host, member, code, meetingId, hostId, memberId, recapId };
}

describe('결정 정정·철회 (인간 감독)', () => {
  it('정정 — 문장이 바뀌면 서명이 초기화되고 이력에 구버전 서명이 남는다', async () => {
    const s = await setup('de1');
    ackDecision(s.recapId, 0, s.memberId, null, 'data:image/png;base64,AAAA');
    expect(listDecisions(s.meetingId)[0].acks).toHaveLength(1);

    const r = editDecision(s.recapId, 0, s.hostId, { decision: '검사 온도 63도로 상향', reason: '원문 확인 — 63도였음' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.acksReset).toBe(true);

    const led = listDecisions(s.meetingId);
    const e0 = led.find((e) => e.idx === 0)!;
    expect(e0.decision).toBe('검사 온도 63도로 상향');
    expect(e0.why).toBe('편차가 컸음'); // 배경은 그대로
    expect(e0.acks).toHaveLength(0); // 구버전 서명은 지워짐(재확인)
    expect(e0.revisions).toBe(1);

    const revs = listDecisionRevisions(s.recapId, 0);
    expect(revs).toHaveLength(1);
    expect(revs[0].kind).toBe('edit');
    expect(revs[0].prevDecision).toBe('검사 온도 65도로 상향');
    expect(revs[0].prevAcks).toEqual([`de1_member`]); // 구버전에 서명한 사람 보존
    expect(revs[0].editor).toBe('de1_host');
  });

  it('배경만 고치면 서명은 유지된다', async () => {
    const s = await setup('de2');
    ackDecision(s.recapId, 0, s.memberId);
    const r = editDecision(s.recapId, 0, s.hostId, { why: '지난주 불량 원인이 온도 편차', reason: '배경 보강' });
    expect(r.ok && !r.acksReset).toBe(true);
    const e0 = listDecisions(s.meetingId).find((e) => e.idx === 0)!;
    expect(e0.acks).toHaveLength(1);
    expect(e0.why).toBe('지난주 불량 원인이 온도 편차');
  });

  it('사유 없음·변경 없음·빈 문장은 거부', async () => {
    const s = await setup('de3');
    expect(editDecision(s.recapId, 0, s.hostId, { decision: '바뀜', reason: '  ' }).ok).toBe(false);
    expect(editDecision(s.recapId, 0, s.hostId, { reason: '이유' }).ok).toBe(false);
    expect(editDecision(s.recapId, 0, s.hostId, { decision: '', reason: '이유' }).ok).toBe(false);
  });

  it('철회 — 지우지 않고 상태로 남고, 철회된 결정은 정정 불가', async () => {
    const s = await setup('de4');
    const w = withdrawDecision(s.recapId, 1, s.hostId, '안전팀 검토 결과 보류');
    expect(w.ok).toBe(true);
    const led = listDecisions(s.meetingId);
    expect(led).toHaveLength(2); // 줄이 사라지지 않는다
    const e1 = led.find((e) => e.idx === 1)!;
    expect(e1.withdrawn?.reason).toBe('안전팀 검토 결과 보류');
    expect(e1.withdrawn?.by).toBe('de4_host');
    expect(led.find((e) => e.idx === 0)!.withdrawn).toBeNull();
    expect(editDecision(s.recapId, 1, s.hostId, { decision: 'x', reason: 'y' }).ok).toBe(false);
    expect(withdrawDecision(s.recapId, 1, s.hostId, '다시').ok).toBe(false);
    expect(listDecisionRevisions(s.recapId, 1)[0].kind).toBe('withdraw');
  });

  it('API — 일반 참가자는 403, 호스트는 200 + 원장 반영, 이력은 참가자 누구나', async () => {
    const s = await setup('de5');
    const deny = await request(app)
      .patch(`/api/meetings/${s.code}/decisions/${s.recapId}/0`)
      .set('Authorization', `Bearer ${s.member.token}`)
      .send({ decision: '해킹', reason: '내맘' });
    expect(deny.status).toBe(403);

    const ok = await request(app)
      .patch(`/api/meetings/${s.code}/decisions/${s.recapId}/0`)
      .set('Authorization', `Bearer ${s.host.token}`)
      .send({ decision: '검사 온도 65도로 상향, 다음 배치부터', reason: '적용 시점 누락 보완' });
    expect(ok.status).toBe(200);
    expect(ok.body.acksReset).toBe(true);

    const led = await request(app)
      .get(`/api/meetings/${s.code}/decisions`)
      .set('Authorization', `Bearer ${s.member.token}`);
    expect(led.body.find((e: { idx: number }) => e.idx === 0).decision).toBe('검사 온도 65도로 상향, 다음 배치부터');

    const wdDeny = await request(app)
      .post(`/api/meetings/${s.code}/decisions/${s.recapId}/1/withdraw`)
      .set('Authorization', `Bearer ${s.member.token}`)
      .send({ reason: '내맘' });
    expect(wdDeny.status).toBe(403);
    const wd = await request(app)
      .post(`/api/meetings/${s.code}/decisions/${s.recapId}/1/withdraw`)
      .set('Authorization', `Bearer ${s.host.token}`)
      .send({ reason: '보류' });
    expect(wd.status).toBe(200);
    const noReason = await request(app)
      .post(`/api/meetings/${s.code}/decisions/${s.recapId}/0/withdraw`)
      .set('Authorization', `Bearer ${s.host.token}`)
      .send({});
    expect(noReason.status).toBe(400);

    const revs = await request(app)
      .get(`/api/meetings/${s.code}/decisions/${s.recapId}/0/revisions`)
      .set('Authorization', `Bearer ${s.member.token}`);
    expect(revs.status).toBe(200);
    expect(revs.body).toHaveLength(1);
  });

  it('자동 기록 [취소] — 발언자 본인이나 관리자가 아니면 403', async () => {
    const s = await setup('de6');
    const autoId = Number(
      db
        .prepare(
          `INSERT INTO meeting_recaps (meeting_id, summary, decisions, attendees, source) VALUES (?, '자동', ?, '[]', 'auto')`,
        )
        .run(s.meetingId, JSON.stringify(['자동 결정'])).lastInsertRowid,
    );
    const deny = await request(app)
      .delete(`/api/meetings/${s.code}/decisions/auto/${autoId}`)
      .set('Authorization', `Bearer ${s.member.token}`);
    expect(deny.status).toBe(403);
    const ok = await request(app)
      .delete(`/api/meetings/${s.code}/decisions/auto/${autoId}`)
      .set('Authorization', `Bearer ${s.host.token}`);
    expect(ok.status).toBe(200);
  });
});
