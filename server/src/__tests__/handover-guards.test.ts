import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';
import { publishHandover, ackHandover, listHandovers, sweepHandoverEscalations } from '../handover.js';
import { register, auth, createMeeting, joinMeeting, notifications } from './helpers/fixtures.js';

/*
 * handover.ts 규칙 — 빈 인수인계 거부(체크리스트만 있어도 발행), 수신자 알림, source 정규화,
 * 서명 검증(png dataURL · 40,000자 미만), 목록의 ack 필드, 2시간 미확인 에스컬레이션.
 * (AI 초안·복명복창 대조는 llm-handover.test.ts)
 */
const app = createApp();

async function setup(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const member = await register(app, `${prefix}_member`);
  const third = await register(app, `${prefix}_third`);
  const m = await createMeeting(app, host, `${prefix} 조`);
  await joinMeeting(app, member, m.code);
  await joinMeeting(app, third, m.code);
  return { host, member, third, code: m.code, meetingId: m.id };
}

describe('publishHandover', () => {
  it('섹션·체크리스트가 전부 비면 거부(API 400), 체크리스트만 있어도 발행되고 건수에 포함, 작성자 외 참가자에게 알림', async () => {
    const s = await setup('hp1');
    expect(() => publishHandover(s.meetingId, s.code, s.host.id, '주간조', { issues: [], notes: [null, '', '   '] }, 'manual')).toThrow('빈 인수인계는 발행할 수 없어요');
    expect(() => publishHandover(s.meetingId, s.code, s.host.id, '', 'not-an-object', 'manual', [{ label: '   ' }])).toThrow('빈 인수인계는 발행할 수 없어요');
    const r = await request(app).post(`/api/meetings/${s.code}/handovers`).set(auth(s.host)).send({ sections: {}, checks: [] });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: '빈 인수인계는 발행할 수 없어요' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM handovers WHERE meeting_id = ?').get(s.meetingId)).toEqual({ n: 0 });
    expect(notifications(s.member.id).some((n) => n.text.includes('인수인계'))).toBe(false);

    const id = publishHandover(s.meetingId, s.code, s.host.id, '야간조', {}, 'manual', [{ label: ' 설비 알람 확인 ', done: true }, { label: '파라미터 기록', done: 'yes' }, { label: '' }]);
    const row = db.prepare('SELECT shift_label, sections, checks, source FROM handovers WHERE id = ?').get(id) as { shift_label: string; sections: string; checks: string; source: string };
    expect(JSON.parse(row.checks)).toEqual([{ label: '설비 알람 확인', done: true }, { label: '파라미터 기록', done: false }]);
    expect(JSON.parse(row.sections)).toEqual({ issues: [], changes: [], pending: [], notes: [] });
    for (const u of [s.member, s.third]) {
      expect(notifications(u.id).at(-1)).toEqual({ from_name: 'exist AI', text: '[야간조] 인수인계가 도착했어요 (hp1_host 작성, 2건) — 작업 전에 확인해 주세요', kind: 'recap', meeting_code: s.code });
    }
    expect(notifications(s.host.id).some((n) => n.text.includes('인수인계가 도착'))).toBe(false);
    // 라벨 없으면 접두 없음, 섹션 건수 + 체크 건수 합산, 라벨 40자·항목 160자·섹션당 6개·체크 20개 상한
    const id2 = publishHandover(s.meetingId, s.code, s.member.id, 'L'.repeat(50), { issues: ['a', 'b'], pending: ['x'.repeat(200)] }, 'weird', [{ label: 'c' }]);
    expect(notifications(s.host.id).at(-1)!.text).toBe(`[${'L'.repeat(50)}] 인수인계가 도착했어요 (hp1_member 작성, 4건) — 작업 전에 확인해 주세요`); // 알림엔 원문 라벨, 저장은 40자
    const row2 = db.prepare('SELECT shift_label, sections, source FROM handovers WHERE id = ?').get(id2) as { shift_label: string; sections: string; source: string };
    expect(row2.shift_label).toHaveLength(40);
    expect(row2.source).toBe('manual');
    expect((JSON.parse(row2.sections) as { pending: string[] }).pending[0]).toHaveLength(160);
    const id3 = publishHandover(s.meetingId, s.code, s.host.id, '', { issues: Array.from({ length: 9 }, (_, i) => `이슈 ${i}`) }, 'ai', Array.from({ length: 25 }, (_, i) => ({ label: `체크 ${i}` })));
    const row3 = db.prepare('SELECT sections, checks, source FROM handovers WHERE id = ?').get(id3) as { sections: string; checks: string; source: string };
    expect((JSON.parse(row3.sections) as { issues: string[] }).issues).toHaveLength(6);
    expect(JSON.parse(row3.checks)).toHaveLength(20);
    expect(row3.source).toBe('ai');
    expect(notifications(s.member.id).at(-1)!.text).toBe('인수인계가 도착했어요 (hp1_host 작성, 26건) — 작업 전에 확인해 주세요');
    expect(publishHandover(s.meetingId, s.code, s.host.id, '', { notes: ['n'] }, 'rule')).toBeGreaterThan(id3);
    expect((db.prepare('SELECT source FROM handovers WHERE meeting_id = ? ORDER BY id DESC LIMIT 1').get(s.meetingId) as { source: string }).source).toBe('rule');
  }, 20_000);
});

describe('ackHandover · listHandovers', () => {
  it('없는 id·다른 회의 id 는 false, 멱등, png dataURL 40,000자 미만만 서명 저장, 노트 200자, 목록 ack 필드', async () => {
    const s = await setup('ha1');
    const other = await createMeeting(app, s.host, '다른 조');
    const id = publishHandover(s.meetingId, s.code, s.host.id, '주간조', { issues: ['2호기 진동'] }, 'manual');
    expect(ackHandover(999999, s.meetingId, s.member.id)).toBe(false);
    expect(ackHandover(id, other.id, s.member.id)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM handover_acks WHERE handover_id = ?').get(id)).toEqual({ n: 0 });
    expect(ackHandover(id, s.meetingId, s.member.id, '', 'data:image/jpeg;base64,AAAA')).toBe(true);
    expect(db.prepare('SELECT signature, note FROM handover_acks WHERE handover_id = ? AND user_id = ?').get(id, s.member.id)).toEqual({ signature: null, note: null });
    expect(ackHandover(id, s.meetingId, s.member.id, undefined, 'data:image/png;base64,' + 'C'.repeat(40_000))).toBe(true);
    expect(db.prepare('SELECT signature FROM handover_acks WHERE handover_id = ? AND user_id = ?').get(id, s.member.id)).toEqual({ signature: null });
    const okSig = 'data:image/png;base64,' + 'C'.repeat(1000);
    expect(ackHandover(id, s.meetingId, s.member.id, ' ' + 'n'.repeat(300), okSig)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM handover_acks WHERE handover_id = ?').get(id)).toEqual({ n: 1 }); // 멱등
    const ack = db.prepare('SELECT signature, note FROM handover_acks WHERE handover_id = ? AND user_id = ?').get(id, s.member.id) as { signature: string; note: string };
    expect(ack.signature).toBe(okSig);
    expect(ack.note).toHaveLength(200);
    db.prepare("UPDATE handover_acks SET echo_check = 'mismatch', echo_reason = '요일이 다름' WHERE handover_id = ? AND user_id = ?").run(id, s.member.id);
    expect(ackHandover(id, s.meetingId, s.third.id)).toBe(true);
    db.prepare("UPDATE handover_acks SET echo_check = 'weird' WHERE handover_id = ? AND user_id = ?").run(id, s.third.id);

    const list = listHandovers(s.meetingId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, author: 'ha1_host', shiftLabel: '주간조', source: 'manual', sections: { issues: ['2호기 진동'], changes: [], pending: [], notes: [] }, checks: [] });
    expect(list[0].acks.map((a) => [a.username, a.note, a.echoCheck, a.echoReason, a.signature])).toEqual([
      ['ha1_member', 'n'.repeat(200), 'mismatch', '요일이 다름', okSig],
      ['ha1_third', null, null, null, null], // 알 수 없는 echo_check 값은 null 로
    ]);
    expect(list[0].acks[0].ts).toBeGreaterThan(0);
    // API 로 서명 — 없는 id 404, 본문 signature 가 문자열이 아니면 무시
    const r = await request(app).post(`/api/meetings/${s.code}/handovers/999999/ack`).set(auth(s.member)).send({});
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: '없는 인수인계예요' });
    expect((await request(app).post(`/api/meetings/${s.code}/handovers/${id}/ack`).set(auth(s.host)).send({ signature: 123 })).body).toEqual({ ok: true });
    expect(db.prepare('SELECT signature FROM handover_acks WHERE handover_id = ? AND user_id = ?').get(id, s.host.id)).toEqual({ signature: null });
    const api = await request(app).get(`/api/meetings/${s.code}/handovers`).set(auth(s.third));
    expect(api.body[0].acks).toHaveLength(3);
    // 깨진 sections/checks JSON 은 빈 값으로
    db.prepare("UPDATE handovers SET sections = '{bad', checks = '[bad' WHERE id = ?").run(id);
    expect(listHandovers(s.meetingId)[0]).toMatchObject({ sections: { issues: [], changes: [], pending: [], notes: [] }, checks: [] });
  }, 20_000);
});

describe('sweepHandoverEscalations — 발행 2시간 미확인 에스컬레이션', () => {
  it('2시간 지난 미서명 인수인계는 작성자에게 1회 알림(미확인자 이름), 전원 서명이면 알림 없이 처리 완료 표시, 2시간 안 된 것은 대기', async () => {
    const s = await setup('he1');
    const old = publishHandover(s.meetingId, s.code, s.host.id, '야간조', { issues: ['x'] }, 'manual');
    const done = publishHandover(s.meetingId, s.code, s.host.id, '', { issues: ['y'] }, 'manual');
    const fresh = publishHandover(s.meetingId, s.code, s.host.id, '주간조', { issues: ['z'] }, 'manual');
    db.prepare("UPDATE handovers SET created_at = datetime('now', '-3 hours') WHERE id IN (?, ?)").run(old, done);
    db.prepare("UPDATE handovers SET created_at = datetime('now', '-119 minutes') WHERE id = ?").run(fresh);
    ackHandover(old, s.meetingId, s.member.id);
    ackHandover(done, s.meetingId, s.member.id);
    ackHandover(done, s.meetingId, s.third.id);
    const before = notifications(s.host.id).length;

    sweepHandoverEscalations();
    const after = notifications(s.host.id).slice(before);
    expect(after).toEqual([{ from_name: 'exist AI', text: '⚠️ [야간조] 인수인계 발행 2시간 — 아직 1명이 확인하지 않았어요 (he1_third)', kind: 'recap', meeting_code: s.code }]);
    const esc = (id: number) => (db.prepare('SELECT escalated_at FROM handovers WHERE id = ?').get(id) as { escalated_at: string | null }).escalated_at;
    expect(esc(old)).not.toBeNull();
    expect(esc(done)).not.toBeNull(); // 전원 확인 → 알림 없이 처리 완료
    expect(esc(fresh)).toBeNull();
    sweepHandoverEscalations();
    expect(notifications(s.host.id)).toHaveLength(before + 1); // 1회만
    // 3일 넘은 옛 것은 건드리지 않는다
    const ancient = publishHandover(s.meetingId, s.code, s.host.id, '', { issues: ['w'] }, 'manual');
    db.prepare("UPDATE handovers SET created_at = datetime('now', '-4 days') WHERE id = ?").run(ancient);
    sweepHandoverEscalations();
    expect(esc(ancient)).toBeNull();
    expect(notifications(s.host.id)).toHaveLength(before + 1);
  }, 20_000);
});
