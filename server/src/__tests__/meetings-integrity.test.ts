import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import db from '../db.js';
import { initNotifier } from '../notify.js';
import { writeYdoc, ydocExists } from '../ydoc.js';
import { register, auth, createMeeting, joinMeeting, createOrg, joinOrg, insertRecap, notifications, fakeIo } from './helpers/fixtures.js';

/*
 * meetings.ts 데이터 무결성 — 결정 정정 시 서명 초기화·재확인 알림, ledger:changed 방송,
 * 반복 회의 occurrence 전개(daily/weekly/biweekly/monthly · recur_until · 제외 회차), 리마인드 쿨다운,
 * 회의 삭제 시 파일 blob·Yjs 정리.
 */
const app = createApp();
const BLOB_DIR = path.join(process.env.DATA_DIR!, 'uploads-files');
const YDOCS_DIR = path.join(process.env.DATA_DIR!, 'ydocs');

async function setup(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const member = await register(app, `${prefix}_member`);
  const third = await register(app, `${prefix}_third`);
  const m = await createMeeting(app, host, `${prefix} 그룹`);
  await joinMeeting(app, member, m.code);
  await joinMeeting(app, third, m.code);
  return { host, member, third, code: m.code, meetingId: m.id };
}

describe('결정 정정 — 서명 초기화와 재확인 알림 (acksReset)', () => {
  it('문장이 바뀌면 서명 삭제 + 리마인드 기록 삭제 + 정정자 외 참가자에게 재확인 알림, 배경만 바꾸면 아무 것도 안 건드린다', async () => {
    const s = await setup('ar1');
    const recapId = insertRecap(s.meetingId, ['검사 온도 65도로 상향', '야간조 인원 유지'], { whys: ['편차', ''] });
    for (const u of [s.member, s.third]) {
      expect((await request(app).post(`/api/meetings/${s.code}/decisions/ack`).set(auth(u)).send({ recapId, idx: 0 })).body).toEqual({ ok: true });
      expect((await request(app).post(`/api/meetings/${s.code}/decisions/ack`).set(auth(u)).send({ recapId, idx: 1 })).body).toEqual({ ok: true });
    }
    db.prepare('INSERT INTO decision_remind_sent (recap_id, user_id) VALUES (?, ?)').run(recapId, s.member.id);
    const before = notifications(s.member.id).length;

    // 배경만 — 서명 유지, 알림 없음
    const whyOnly = await request(app).patch(`/api/meetings/${s.code}/decisions/${recapId}/0`).set(auth(s.host)).send({ why: '지난주 불량 원인', reason: '배경 보강' });
    expect(whyOnly.body).toEqual({ ok: true, acksReset: false });
    expect(db.prepare('SELECT COUNT(*) AS n FROM decision_acks WHERE recap_id = ? AND decision_idx = 0').get(recapId)).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM decision_remind_sent WHERE recap_id = ?').get(recapId)).toEqual({ n: 1 });
    expect(notifications(s.member.id)).toHaveLength(before);
    expect(notifications(s.third.id).some((n) => n.text.includes('정정됐어요'))).toBe(false);

    // 문장 변경 — idx 0 서명만 삭제(idx 1 은 유지), 리마인드 기록 삭제, 알림 문구
    const edit = await request(app).patch(`/api/meetings/${s.code}/decisions/${recapId}/0`).set(auth(s.host)).send({ decision: '  검사 온도 63도로 상향  ', reason: '  원문 확인 — 63도였음  ' });
    expect(edit.body).toEqual({ ok: true, acksReset: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM decision_acks WHERE recap_id = ? AND decision_idx = 0').get(recapId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM decision_acks WHERE recap_id = ? AND decision_idx = 1').get(recapId)).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM decision_remind_sent WHERE recap_id = ?').get(recapId)).toEqual({ n: 0 });
    const expected = {
      from_name: 'exist AI',
      text: `결정이 정정됐어요 — '검사 온도 63도로 상향' (ar1_host, 사유: 원문 확인 — 63도였음). 다시 확인해 주세요 ('ar1 그룹')`,
      kind: 'recap',
      meeting_code: s.code,
    };
    expect(notifications(s.member.id).slice(before)).toEqual([expected]);
    expect(notifications(s.third.id).filter((n) => n.text.includes('정정됐어요'))).toEqual([expected]);
    expect(notifications(s.host.id).some((n) => n.text.includes('정정됐어요'))).toBe(false); // 정정자 본인 제외
    // 이력에 구버전 서명 스냅샷
    const rev = db.prepare("SELECT prev_decision, new_decision, prev_acks, reason FROM decision_revisions WHERE recap_id = ? AND decision_idx = 0 AND kind = 'edit' ORDER BY id DESC LIMIT 1").get(recapId) as { prev_decision: string; new_decision: string; prev_acks: string; reason: string };
    expect(rev.prev_decision).toBe('검사 온도 65도로 상향');
    expect(rev.new_decision).toBe('검사 온도 63도로 상향');
    expect((JSON.parse(rev.prev_acks) as { username: string }[]).map((a) => a.username).sort()).toEqual(['ar1_member', 'ar1_third']);
    // 긴 문장·사유는 알림에서 60·40자로 잘린다
    const long = await request(app).patch(`/api/meetings/${s.code}/decisions/${recapId}/1`).set(auth(s.host)).send({ decision: '가'.repeat(100), reason: '나'.repeat(100) });
    expect(long.body.acksReset).toBe(true);
    const last = notifications(s.member.id).at(-1)!;
    expect(last.text).toBe(`결정이 정정됐어요 — '${'가'.repeat(60)}' (ar1_host, 사유: ${'나'.repeat(40)}). 다시 확인해 주세요 ('ar1 그룹')`);
  }, 20_000);

  it('조직 그룹의 정정·철회는 감사 로그에 남고, 철회 알림은 정정자 외 전원에게', async () => {
    const owner = await register(app, 'ar2_owner');
    const member = await register(app, 'ar2_member');
    const org = await createOrg(app, owner, 'ar2 조직');
    await joinOrg(app, org, owner, member);
    const m = await createMeeting(app, owner, 'ar2 그룹', { org_id: org.id });
    await joinMeeting(app, member, m.code);
    const recapId = insertRecap(m.id, ['A안 채택']);
    await request(app).patch(`/api/meetings/${m.code}/decisions/${recapId}/0`).set(auth(owner)).send({ decision: 'B안 채택', reason: 'A안 공급 불가' });
    const wd = await request(app).post(`/api/meetings/${m.code}/decisions/${recapId}/0/withdraw`).set(auth(owner)).send({ reason: '전면 재검토' });
    expect(wd.body).toEqual({ ok: true });
    const audit = db.prepare('SELECT action, target_id, text FROM org_audit WHERE org_id = ? AND action LIKE ? ORDER BY id').all(org.id, 'decision:%') as { action: string; target_id: number; text: string }[];
    expect(audit).toEqual([
      { action: 'decision:edit', target_id: recapId, text: `'ar2 그룹' 결정 #${recapId}-0 정정 — A안 공급 불가` },
      { action: 'decision:withdraw', target_id: recapId, text: `'ar2 그룹' 결정 #${recapId}-0 철회 — 전면 재검토` },
    ]);
    expect(notifications(member.id).at(-1)).toEqual({
      from_name: 'exist AI',
      text: `결정이 철회됐어요 — 'B안 채택' (ar2_owner, 사유: 전면 재검토) ('ar2 그룹')`,
      kind: 'recap',
      meeting_code: m.code,
    });
    expect(notifications(owner.id).some((n) => n.text.includes('철회됐어요'))).toBe(false);
  }, 20_000);
});

describe('ledger:changed 방송 (emitLedgerChanged)', () => {
  it('결정 ack·정정·철회·인수인계 서명마다 그룹 참가자 전원의 소켓에 {code} (대문자) — 비참가자 소켓엔 없음', async () => {
    const s = await setup('lc1');
    const outsider = await register(app, 'lc1_out');
    const io = fakeIo([s.host.id, s.member.id, s.third.id, outsider.id]);
    initNotifier(io.io as never);
    const recapId = insertRecap(s.meetingId, ['결정 하나']);
    const ho = await request(app).post(`/api/meetings/${s.code}/handovers`).set(auth(s.host)).send({ sections: { notes: ['유의'] } });
    const lower = s.code.toLowerCase();
    const count = () => [s.host, s.member, s.third].map((u) => io.of(u.id, 'ledger:changed').length);

    expect((await request(app).post(`/api/meetings/${lower}/decisions/ack`).set(auth(s.member)).send({ recapId, idx: 0 })).status).toBe(200);
    expect(count()).toEqual([1, 1, 1]);
    expect(io.of(s.host.id, 'ledger:changed')[0].payload).toEqual({ code: s.code.toUpperCase() });
    expect((await request(app).patch(`/api/meetings/${lower}/decisions/${recapId}/0`).set(auth(s.host)).send({ decision: '결정 둘', reason: 'x' })).status).toBe(200);
    expect(count()).toEqual([2, 2, 2]);
    expect((await request(app).post(`/api/meetings/${lower}/decisions/${recapId}/0/withdraw`).set(auth(s.host)).send({ reason: 'y' })).status).toBe(200);
    expect(count()).toEqual([3, 3, 3]);
    expect((await request(app).post(`/api/meetings/${lower}/handovers/${ho.body.id}/ack`).set(auth(s.third)).send({})).status).toBe(200);
    expect(count()).toEqual([4, 4, 4]);
    expect(io.of(outsider.id, 'ledger:changed')).toEqual([]);
    expect(io.emitted.filter((e) => e.event === 'ledger:changed').every((e) => (e.payload as { code: string }).code === s.code.toUpperCase())).toBe(true);
    // 실패한 요청(잘못된 idx)은 방송하지 않는다
    expect((await request(app).post(`/api/meetings/${lower}/decisions/ack`).set(auth(s.member)).send({ recapId, idx: 5 })).status).toBe(404);
    expect(count()).toEqual([4, 4, 4]);
  }, 20_000);
});

describe('반복 회의 occurrence 전개 (GET /schedule)', () => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const iso = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const addDays = (d: Date, n: number) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };

  it('daily/weekly/biweekly/monthly 간격, 종료 시각은 duration 유지, recur_until 컷오프, 제외 회차 건너뜀, none 은 1회', async () => {
    const host = await register(app, 'oc1_host');
    const base = new Date();
    base.setHours(10, 0, 0, 0);
    base.setDate(base.getDate() + 1); // 내일 10:00
    const start = iso(base);
    const end = iso(new Date(base.getTime() + 90 * 60_000));
    const mk = (title: string, recur: string, extra: Record<string, unknown> = {}) =>
      createMeeting(app, host, title, { starts_at: start, ends_at: end, recur, ...extra });
    const daily = await mk('매일', 'daily', { recur_until: ymd(addDays(base, 3)) });
    const weekly = await mk('매주', 'weekly', { recur_until: ymd(addDays(base, 21)) });
    const biweekly = await mk('격주', 'biweekly', { recur_until: ymd(addDays(base, 28)) });
    const monthly = await mk('매월', 'monthly');
    const once = await mk('한 번', 'none', { recur_until: ymd(addDays(base, 30)) }); // none 이면 until 은 저장되지 않는다
    const bad = await mk('잘못된 반복', 'yearly'); // → none
    expect(db.prepare('SELECT recur, recur_until FROM meetings WHERE id = ?').get(once.id)).toEqual({ recur: 'none', recur_until: null });
    expect(db.prepare('SELECT recur FROM meetings WHERE id = ?').get(bad.id)).toEqual({ recur: 'none' });
    // 매일 회의의 둘째 날은 제외
    expect((await request(app).post(`/api/meetings/${daily.code}/occurrences/exclude`).set(auth(host)).send({ date: ymd(addDays(base, 1)) })).body.recur_except).toEqual([ymd(addDays(base, 1))]);
    expect((await request(app).post(`/api/meetings/${daily.code}/occurrences/exclude`).set(auth(host)).send({ date: '2026/09/10' })).body).toEqual({ error: '날짜를 확인하세요' });

    const r = await request(app).get('/api/meetings/schedule').set(auth(host));
    expect(r.status).toBe(200);
    const occ = (id: number) => (r.body as { id: number; starts_at: string; ends_at: string | null; recur: string; occId: string }[]).filter((o) => o.id === id);

    expect(occ(daily.id).map((o) => o.starts_at)).toEqual([iso(base), iso(addDays(base, 2)), iso(addDays(base, 3))]); // until 포함, 둘째 날 제외
    expect(occ(daily.id).map((o) => o.ends_at)).toEqual([end, iso(new Date(addDays(base, 2).getTime() + 90 * 60_000)), iso(new Date(addDays(base, 3).getTime() + 90 * 60_000))]);
    expect(occ(daily.id)[0].occId).toBe(`${daily.id}@${iso(base)}`);
    expect(occ(weekly.id).map((o) => o.starts_at)).toEqual([0, 7, 14, 21].map((n) => iso(addDays(base, n))));
    expect(occ(biweekly.id).map((o) => o.starts_at)).toEqual([0, 14, 28].map((n) => iso(addDays(base, n))));
    const m1 = new Date(base);
    m1.setMonth(m1.getMonth() + 1);
    const m2 = new Date(base);
    m2.setMonth(m2.getMonth() + 2);
    expect(occ(monthly.id).map((o) => o.starts_at)).toEqual([iso(base), iso(m1), iso(m2)]); // 90일 창 안 3회
    expect(occ(monthly.id).every((o) => o.recur === 'monthly')).toBe(true);
    expect(occ(once.id)).toHaveLength(1);
    expect(occ(once.id)[0]).toMatchObject({ starts_at: start, ends_at: end, recur: 'none' });
    expect(occ(bad.id)).toHaveLength(1);
    // 시간순 정렬
    const all = (r.body as { starts_at: string }[]).map((o) => o.starts_at);
    expect([...all].sort()).toEqual(all);
    // 복원하면 다시 나온다
    expect((await request(app).post(`/api/meetings/${daily.code}/occurrences/exclude`).set(auth(host)).send({ date: ymd(addDays(base, 1)), restore: true })).body.recur_except).toEqual([]);
    const r2 = await request(app).get('/api/meetings/schedule').set(auth(host));
    expect((r2.body as { id: number }[]).filter((o) => o.id === daily.id)).toHaveLength(4);
  }, 20_000);

  it('과거 시작 회의는 31일 전까지만, 반복 없는 옛 회의는 그대로 1건, 시작 없는 회의는 제외 — 개별 일정 반복도 같은 규칙', async () => {
    const host = await register(app, 'oc2_host');
    const old = new Date();
    old.setHours(9, 0, 0, 0);
    old.setDate(old.getDate() - 40);
    const weeklyOld = await createMeeting(app, host, '40일 전 시작 매주', { starts_at: iso(old), recur: 'weekly' });
    const noStart = await createMeeting(app, host, '시작 없음', { recur: 'daily' });
    const r = await request(app).get('/api/meetings/schedule').set(auth(host));
    const rows = r.body as { id: number; starts_at: string; ends_at: string | null; kind?: string; occId: string; allDay?: boolean }[];
    const wk = rows.filter((o) => o.id === weeklyOld.id);
    const lower = Date.now() - 31 * 24 * 3600_000;
    expect(wk.length).toBeGreaterThanOrEqual(17); // (31+90)/7 ≈ 17~18
    expect(wk.every((o) => new Date(o.starts_at).getTime() >= lower)).toBe(true);
    expect(wk[0].starts_at).toBe(iso(addDays(old, 7 * Math.ceil((lower - old.getTime()) / (7 * 24 * 3600_000)))));
    expect(wk.every((o) => o.ends_at === null)).toBe(true); // 종료 없으면 null
    expect(rows.some((o) => o.id === noStart.id)).toBe(false);
    // 개별 일정 — biweekly, until 로 2회, 종일이면 ends_at null + allDay
    const today = new Date();
    const ev = await request(app).post(`/api/meetings/${weeklyOld.code}/events`).set(auth(host)).send({ title: '격주 점검', date: ymd(today), recur: 'biweekly', recur_until: ymd(addDays(today, 20)) });
    expect(ev.status).toBe(200);
    const r2 = await request(app).get('/api/meetings/schedule').set(auth(host));
    const evs = (r2.body as { occId: string; starts_at: string; ends_at: string | null; allDay?: boolean; kind?: string }[]).filter((o) => o.occId.startsWith(`ev${ev.body.id}@`));
    expect(evs.map((o) => o.starts_at)).toEqual([`${ymd(today)}T00:00`, `${ymd(addDays(today, 14))}T00:00`]);
    expect(evs[0]).toMatchObject({ kind: 'event', allDay: true, ends_at: null });
  }, 20_000);
});

describe('리마인드 쿨다운 · 회의 삭제 정리', () => {
  it('미확인자 리마인드는 결정당 1시간 1회(429), 전원 확인이면 0건이고 쿨다운도 안 잡힌다', async () => {
    const s = await setup('rm1');
    const recapId = insertRecap(s.meetingId, ['결정 A', '결정 B']);
    await request(app).post(`/api/meetings/${s.code}/decisions/ack`).set(auth(s.member)).send({ recapId, idx: 0 });
    const r1 = await request(app).post(`/api/meetings/${s.code}/decisions/remind`).set(auth(s.host)).send({ recapId, idx: 0 });
    expect(r1.body).toEqual({ reminded: 1 }); // third 만 미확인
    expect(notifications(s.third.id).at(-1)).toEqual({ from_name: 'exist AI', text: `'결정 A' 결정을 아직 확인 안 하셨어요 — 확인 부탁해요 ('rm1 그룹')`, kind: 'recap', meeting_code: s.code });
    expect(notifications(s.member.id).some((n) => n.text.includes('아직 확인 안'))).toBe(false);
    const r2 = await request(app).post(`/api/meetings/${s.code}/decisions/remind`).set(auth(s.host)).send({ recapId, idx: 0 });
    expect(r2.status).toBe(429);
    expect(r2.body).toEqual({ error: '이미 최근에 리마인드했어요 — 1시간 뒤에 다시' });
    // 다른 결정(idx 1)은 별개 키
    expect((await request(app).post(`/api/meetings/${s.code}/decisions/remind`).set(auth(s.host)).send({ recapId, idx: 1 })).body).toEqual({ reminded: 2 });
    expect((await request(app).post(`/api/meetings/${s.code}/decisions/remind`).set(auth(s.host)).send({ recapId, idx: 2 })).body).toEqual({ error: '존재하지 않는 결정입니다' });
    expect((await request(app).post(`/api/meetings/${s.code}/decisions/remind`).set(auth(s.host)).send({ recapId: 'x', idx: 0 })).body).toEqual({ error: '잘못된 요청입니다' });
    // 전원 확인 → 0건, 쿨다운 없음 (바로 다시 호출해도 429 아님)
    const recap2 = insertRecap(s.meetingId, ['모두 확인한 결정']);
    for (const u of [s.member, s.third]) await request(app).post(`/api/meetings/${s.code}/decisions/ack`).set(auth(u)).send({ recapId: recap2, idx: 0 });
    expect((await request(app).post(`/api/meetings/${s.code}/decisions/remind`).set(auth(s.host)).send({ recapId: recap2, idx: 0 })).body).toEqual({ reminded: 0 });
    expect((await request(app).post(`/api/meetings/${s.code}/decisions/remind`).set(auth(s.host)).send({ recapId: recap2, idx: 0 })).status).toBe(200);
  }, 20_000);

  it('회의 삭제 시 업로드 blob·버전 blob·Yjs 상태 파일이 디스크에서 지워지고 참가자에게 meeting:deleted', async () => {
    const s = await setup('del1');
    const io = fakeIo([s.host.id, s.member.id]);
    initNotifier(io.io as never);
    const up = await request(app).post(`/api/meetings/${s.code}/files/upload?name=drawing.bin`).set(auth(s.host)).set('Content-Type', 'application/octet-stream').send(Buffer.from('blob-bytes'));
    expect(up.status).toBe(200);
    const blob = (db.prepare('SELECT blob_path FROM collab_files WHERE id = ?').get(up.body.id) as { blob_path: string }).blob_path;
    expect(fs.existsSync(path.join(BLOB_DIR, blob))).toBe(true);
    const doc = await request(app).post(`/api/meetings/${s.code}/files`).set(auth(s.host)).send({ name: '메모', type: 'doc' });
    writeYdoc(doc.body.room, (d) => d.getText('t').insert(0, 'hello'));
    expect(ydocExists(doc.body.room)).toBe(true);
    const binName = `${String(doc.body.room).replace(/[^\w-]/g, '_')}.bin`;
    expect(fs.existsSync(path.join(YDOCS_DIR, binName))).toBe(true);
    // 버전 blob 도 하나
    fs.writeFileSync(path.join(BLOB_DIR, 'ver-del1.bin'), 'v1');
    db.prepare('INSERT INTO file_versions (file_id, blob_path, size, mime, uploaded_by) VALUES (?, ?, 2, ?, ?)').run(up.body.id, 'ver-del1.bin', 'application/octet-stream', s.host.id);

    const del = await request(app).delete(`/api/meetings/${s.code}`).set(auth(s.host));
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(BLOB_DIR, blob))).toBe(false);
    expect(fs.existsSync(path.join(BLOB_DIR, 'ver-del1.bin'))).toBe(false);
    expect(fs.existsSync(path.join(YDOCS_DIR, binName))).toBe(false);
    expect(ydocExists(doc.body.room)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM collab_files WHERE meeting_id = ?').get(s.meetingId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM file_versions WHERE file_id = ?').get(up.body.id)).toEqual({ n: 0 });
    for (const u of [s.host, s.member]) expect(io.of(u.id, 'meeting:deleted').map((e) => e.payload)).toEqual([{ code: s.code }]);
  }, 20_000);
});
