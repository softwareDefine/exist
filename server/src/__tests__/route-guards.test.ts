import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';
import { register, auth, createMeeting, joinMeeting, createOrg, joinOrg, setOrgRole, insertRecap, type User } from './helpers/fixtures.js';

/*
 * 라우트 권한 게이트 — 변경 라우트마다 (a) 외부인 → 403/404 + 정확한 에러 문구,
 * (b) 권한 없는 참가자 → 403, (c) 호스트 / 조직 관리자 → 2xx 를 한 번에 돈다.
 * (route-sweep 은 status < 500 만 보므로 `if (!r.ok) return res.status(...)` 가드가 뮤테이션에서 전부 살아남았다)
 */
const app = createApp();

interface Fx {
  host: User;
  member: User;
  outsider: User;
  admin: User; // 조직 admin — 회의 참가자는 아님
  orgId: number;
  code: string;
  meetingId: number;
  personal: { code: string; id: number }; // 조직 없는 회의 — admin 권한이 안 통해야 함
}

async function fixture(prefix: string): Promise<Fx> {
  const host = await register(app, `${prefix}_host`);
  const member = await register(app, `${prefix}_member`);
  const outsider = await register(app, `${prefix}_out`);
  const admin = await register(app, `${prefix}_admin`);
  const org = await createOrg(app, host, `${prefix} 조직`);
  await joinOrg(app, org, host, member, { department: '생산1팀' });
  await joinOrg(app, org, host, admin);
  await setOrgRole(app, org.id, host, admin, 'admin');
  const m = await createMeeting(app, host, `${prefix} 그룹`, { org_id: org.id });
  await joinMeeting(app, member, m.code);
  const personal = await createMeeting(app, host, `${prefix} 개인`);
  await joinMeeting(app, member, personal.code);
  return { host, member, outsider, admin, orgId: org.id, code: m.code, meetingId: m.id, personal };
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
function call(method: Method, url: string, u: User, body?: unknown) {
  const r = request(app)[method](url).set(auth(u));
  return body === undefined ? r : r.send(body);
}

const NOT_FOUND = { error: '존재하지 않는 회의입니다' };
const NOT_PARTICIPANT = { error: '회의 참가자만 쓸 수 있어요' };

describe('회의 관리 라우트 — canManageMeeting 가드', () => {
  it('설정·기간·강퇴·위임·수정·썸네일·회차 제외·정리 실행·리마인드 — 외부인·일반 참가자 403(문구), 조직 admin·호스트 2xx, 없는 코드 404', async () => {
    const f = await fixture('rg1');
    const recapId = insertRecap(f.meetingId, ['라인 점검 주기 단축']);
    const cases: { name: string; method: Method; path: string; body?: unknown; deny: string }[] = [
      { name: 'settings(lock)', method: 'patch', path: '/settings', body: { locked: true }, deny: '입장 잠금을 변경할 권한이 없어요' },
      { name: 'settings(mute)', method: 'patch', path: '/settings', body: { muteOnJoin: true }, deny: '그룹 설정을 변경할 권한이 없어요' },
      { name: 'period', method: 'patch', path: '/period', body: { start: '2026-09-01', end: '2026-09-30' }, deny: '호스트나 조직 관리자만 변경할 수 있어요' },
      { name: 'kick', method: 'delete', path: `/participants/${f.member.username}`, deny: '호스트나 조직 관리자만 강퇴할 수 있어요' },
      { name: 'host', method: 'patch', path: '/host', body: { username: f.host.username }, deny: '호스트나 조직 관리자만 위임할 수 있어요' },
      { name: 'edit-info', method: 'patch', path: '', body: { title: '바뀐 제목' }, deny: '호스트나 조직 관리자만 수정할 수 있어요' },
      { name: 'thumbnail', method: 'post', path: '/thumbnail', body: { x: 1 }, deny: '호스트나 조직 관리자만 사진을 바꿀 수 있어요' },
      { name: 'exclude', method: 'post', path: '/occurrences/exclude', body: { date: '2026-09-10' }, deny: '호스트나 조직 관리자만 회차를 삭제할 수 있어요' },
      { name: 'recaps/run', method: 'post', path: '/recaps/run', body: {}, deny: '호스트나 조직 관리자만 정리를 실행할 수 있어요' },
      { name: 'decisions/remind', method: 'post', path: '/decisions/remind', body: { recapId, idx: 0 }, deny: '호스트나 관리자만 리마인드할 수 있어요' },
    ];
    for (const c of cases) {
      const out = await call(c.method, `/api/meetings/${f.code}${c.path}`, f.outsider, c.body);
      expect(out.status, `${c.name} outsider`).toBe(403);
      expect(out.body, `${c.name} outsider body`).toEqual(c.deny.startsWith('호스트나 관리자만') ? NOT_PARTICIPANT : { error: c.deny });
      const mem = await call(c.method, `/api/meetings/${f.code}${c.path}`, f.member, c.body);
      expect(mem.status, `${c.name} member`).toBe(403);
      expect(mem.body, `${c.name} member body`).toEqual({ error: c.deny });
      const none = await call(c.method, `/api/meetings/ZZZZZZ${c.path}`, f.host, c.body);
      expect(none.status, `${c.name} 404`).toBe(404);
    }
    // 강퇴는 "회의 참가자 강퇴" 뒤에 member 가 사라지므로 admin 검증은 다른 참가자 없이도 됨 — 순서: admin 먼저 관리 행위
    expect((await call('patch', `/api/meetings/${f.code}/settings`, f.admin, { locked: true })).body).toEqual({
      settings: { locked: true, guestEdit: true, muteOnJoin: false },
    });
    expect((await call('patch', `/api/meetings/${f.code}/period`, f.admin, { start: '2026-09-01', end: 'bad' })).body).toEqual({
      period: { start: '2026-09-01', end: null },
    });
    expect((await call('patch', `/api/meetings/${f.code}`, f.admin, { title: '관리자가 바꾼 제목' })).status).toBe(200);
    expect((db.prepare('SELECT title FROM meetings WHERE id = ?').get(f.meetingId) as { title: string }).title).toBe('관리자가 바꾼 제목');
    const ex = await call('post', `/api/meetings/${f.code}/occurrences/exclude`, f.admin, { date: '2026-09-10' });
    expect(ex.body).toEqual({ ok: true, recur_except: ['2026-09-10'] });
    const thumb = await request(app)
      .post(`/api/meetings/${f.code}/thumbnail`)
      .set(auth(f.admin))
      .set('Content-Type', 'image/png')
      .send(Buffer.from('png-bytes'));
    expect(thumb.status).toBe(200);
    expect(thumb.body.thumbnail).toMatch(/^\/api\/workspaces\/uploads\/mthumb-[0-9a-f-]+\.png$/);
    // 리마인드 — admin 은 참가자가 아니라 참가자 검사에서 403, 호스트는 미확인 참가자(member)에게 1건
    expect((await call('post', `/api/meetings/${f.code}/decisions/remind`, f.admin, { recapId, idx: 0 })).body).toEqual(NOT_PARTICIPANT);
    expect((await call('post', `/api/meetings/${f.code}/decisions/remind`, f.host, { recapId, idx: 0 })).body).toEqual({ reminded: 1 });
    // 호스트 강퇴 불가(400), 참가자 강퇴는 admin 도 가능
    expect((await call('delete', `/api/meetings/${f.code}/participants/${f.host.username}`, f.admin)).body).toEqual({ error: '호스트는 강퇴할 수 없어요' });
    expect((await call('delete', `/api/meetings/${f.code}/participants/${f.member.username}`, f.admin)).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?').get(f.meetingId, f.member.id)).toBeUndefined();
    expect((await call('patch', `/api/meetings/${f.code}/host`, f.admin, { username: f.admin.username })).body).toEqual({ ok: true });
    expect((db.prepare('SELECT host_id FROM meetings WHERE id = ?').get(f.meetingId) as { host_id: number }).host_id).toBe(f.admin.id);
    // 개인 회의(org 없음)에는 조직 admin 권한이 안 통한다
    const p = await call('patch', `/api/meetings/${f.personal.code}`, f.admin, { title: 'x' });
    expect(p.status).toBe(403);
    expect(p.body).toEqual({ error: '호스트나 조직 관리자만 수정할 수 있어요' });
    // 감사 로그 — 조직 그룹의 관리 행위가 남는다
    const audit = (db.prepare('SELECT action FROM org_audit WHERE org_id = ? ORDER BY id').all(f.orgId) as { action: string }[]).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['group.lock', 'group.kick', 'group.transfer']));
  }, 30_000);

  it('회의 삭제 — 일반 참가자·외부인 403(문구), 없는 코드 404, 조직 admin 은 삭제 + 참가자에게 meeting:deleted', async () => {
    const f = await fixture('rg2');
    const mem = await call('delete', `/api/meetings/${f.code}`, f.member);
    expect(mem.status).toBe(403);
    expect(mem.body).toEqual({ error: '호스트나 조직 관리자만 삭제할 수 있어요' });
    const out = await call('delete', `/api/meetings/${f.code}`, f.outsider);
    expect(out.status).toBe(403);
    expect(db.prepare('SELECT 1 FROM meetings WHERE id = ?').get(f.meetingId)).toBeTruthy();
    const none = await call('delete', '/api/meetings/NOPE01', f.host);
    expect(none.status).toBe(404);
    expect(none.body).toEqual(NOT_FOUND);
    const ok = await call('delete', `/api/meetings/${f.code.toLowerCase()}`, f.admin);
    expect(ok.status).toBe(200);
    expect(db.prepare('SELECT 1 FROM meetings WHERE id = ?').get(f.meetingId)).toBeUndefined();
    const audit = db.prepare("SELECT text FROM org_audit WHERE org_id = ? AND action = 'group.delete'").get(f.orgId) as { text: string };
    expect(audit.text).toBe('그룹 "rg2 그룹" 삭제');
    // 개인 회의는 호스트만
    const pd = await call('delete', `/api/meetings/${f.personal.code}`, f.admin);
    expect(pd.status).toBe(403);
    expect((await call('delete', `/api/meetings/${f.personal.code}`, f.host)).status).toBe(200);
  }, 30_000);

  it('일정 이벤트 삭제·수정 — 작성자 아니면 403(문구), 작성자·호스트·admin 은 OK', async () => {
    const f = await fixture('rg3');
    const ev = await call('post', `/api/meetings/${f.code}/events`, f.member, { title: '멤버가 만든 일정', date: '2026-10-01', time: '10:00' });
    expect(ev.status).toBe(200);
    const other = await register(app, 'rg3_other');
    await joinMeeting(app, other, f.code);
    const del = await call('delete', `/api/meetings/${f.code}/events/${ev.body.id}`, other);
    expect(del.status).toBe(403);
    expect(del.body).toEqual({ error: '작성자·호스트·조직 관리자만 삭제할 수 있어요' });
    const pat = await call('patch', `/api/meetings/${f.code}/events/${ev.body.id}`, other, { title: '남의 일정 수정' });
    expect(pat.status).toBe(403);
    expect(pat.body).toEqual({ error: '작성자·호스트·조직 관리자만 수정할 수 있어요' });
    expect((await call('patch', `/api/meetings/${f.code}/events/${ev.body.id}`, f.admin, { title: '관리자 수정' })).body.title).toBe('관리자 수정');
    expect((await call('patch', `/api/meetings/${f.code}/events/${ev.body.id}`, f.member, { title: '작성자 수정' })).body.title).toBe('작성자 수정');
    expect((await call('delete', `/api/meetings/${f.code}/events/${ev.body.id}`, f.host)).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM meeting_events WHERE id = ?').get(ev.body.id)).toBeUndefined();
    // 없는 이벤트 삭제는 멱등 200, 수정은 404
    expect((await call('delete', `/api/meetings/${f.code}/events/${ev.body.id}`, f.host)).body).toEqual({ ok: true });
    expect((await call('patch', `/api/meetings/${f.code}/events/${ev.body.id}`, f.host, { title: 'x' })).status).toBe(404);
  }, 30_000);

  it('채널 이름 변경·삭제 — 만든 사람/호스트/admin 만, 기본·통화 채널 삭제 불가', async () => {
    const f = await fixture('rg4');
    const ch = await call('post', `/api/meetings/${f.code}/channels`, f.member, { name: '품질' });
    expect(ch.status).toBe(200);
    const other = await register(app, 'rg4_other');
    await joinMeeting(app, other, f.code);
    const ren = await call('patch', `/api/meetings/${f.code}/channels/${ch.body.id}`, other, { name: '해킹' });
    expect(ren.status).toBe(403);
    expect(ren.body).toEqual({ error: '만든 사람·호스트·조직 관리자만 바꿀 수 있어요' });
    expect((await call('patch', `/api/meetings/${f.code}/channels/${ch.body.id}`, f.member, { name: '품질2' })).body).toEqual({ id: ch.body.id, name: '품질2' });
    const delMem = await call('delete', `/api/meetings/${f.code}/channels/${ch.body.id}`, f.member);
    expect(delMem.status).toBe(403);
    expect(delMem.body).toEqual({ error: '호스트나 조직 관리자만 채널을 삭제할 수 있어요' });
    const outsider = await call('delete', `/api/meetings/${f.code}/channels/${ch.body.id}`, f.outsider);
    expect(outsider.body).toEqual(NOT_PARTICIPANT);
    const chans = await call('get', `/api/meetings/${f.code}/channels`, f.host);
    const defaultId = (chans.body as { id: number; isDefault: boolean }[]).find((c) => c.isDefault)!.id;
    expect((await call('delete', `/api/meetings/${f.code}/channels/${defaultId}`, f.host)).body).toEqual({ error: '기본 채널은 삭제할 수 없어요' });
    const callCh = await call('get', `/api/meetings/${f.code}/channels/call`, f.host);
    expect((await call('delete', `/api/meetings/${f.code}/channels/${callCh.body.id}`, f.host)).body).toEqual({ error: '통화 채널은 삭제할 수 없어요' });
    expect((await call('delete', `/api/meetings/${f.code}/channels/${ch.body.id}`, f.host)).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM chat_channels WHERE id = ?').get(ch.body.id)).toBeUndefined();
    expect((await call('delete', `/api/meetings/${f.code}/channels/999999`, f.host)).status).toBe(404);
  }, 30_000);
});

describe('참가자 전용 라우트 — meetingForParticipant 가드', () => {
  it('외부인 403(문구)·없는 코드 404(문구)·참가자 2xx', async () => {
    const f = await fixture('rg5');
    const recapId = insertRecap(f.meetingId, ['검사 온도 65도']);
    const ev = await call('post', `/api/meetings/${f.code}/events`, f.host, { title: '점검', date: '2026-10-02' });
    const item = db.prepare("INSERT INTO agenda_items (meeting_id, title) VALUES (?, '보류 안건')").run(f.meetingId).lastInsertRowid;
    const ho = await call('post', `/api/meetings/${f.code}/handovers`, f.host, { sections: { issues: ['2호기 알람'] } });
    expect(ho.status).toBe(200);
    const cases: { name: string; method: Method; path: string; body?: unknown }[] = [
      { name: 'events ack', method: 'post', path: `/events/${ev.body.id}/ack` },
      { name: 'schedule suggest', method: 'get', path: '/schedule/suggest' },
      { name: 'field start', method: 'post', path: '/field-recording/start' },
      { name: 'decisions manual', method: 'post', path: '/decisions/manual', body: { text: '수동 결정' } },
      { name: 'handovers list', method: 'get', path: '/handovers' },
      { name: 'checklist list', method: 'get', path: '/handovers/checklist' },
      { name: 'checklist add', method: 'post', path: '/handovers/checklist', body: { label: '설비 알람 확인' } },
      { name: 'handover ack', method: 'post', path: `/handovers/${ho.body.id}/ack`, body: {} },
      { name: 'recap source', method: 'get', path: `/recaps/${recapId}/source` },
      { name: 'decisions', method: 'get', path: '/decisions' },
      { name: 'decisions history', method: 'get', path: '/decisions/history' },
      { name: 'decisions ack', method: 'post', path: '/decisions/ack', body: { recapId, idx: 0 } },
      { name: 'revisions', method: 'get', path: `/decisions/${recapId}/0/revisions` },
      { name: 'agenda', method: 'get', path: '/agenda' },
      { name: 'rag reindex', method: 'post', path: '/rag/reindex' },
      { name: 'glossary get', method: 'get', path: '/glossary' },
      { name: 'glossary add', method: 'post', path: '/glossary', body: { term: '완제라인' } },
      { name: 'agenda timeline', method: 'get', path: `/agenda/${item}/timeline` },
      { name: 'agenda status', method: 'post', path: `/agenda/${item}/status`, body: { status: 'hold', note: '승인 대기' } },
      { name: 'channels', method: 'get', path: '/channels' },
      { name: 'channels call', method: 'get', path: '/channels/call' },
      { name: 'channel create', method: 'post', path: '/channels', body: { name: '새 채널' } },
      { name: 'files list', method: 'get', path: '/files' },
    ];
    for (const c of cases) {
      const out = await call(c.method, `/api/meetings/${f.code}${c.path}`, f.outsider, c.body);
      expect(out.status, `${c.name} outsider`).toBe(403);
      expect(out.body, `${c.name} outsider body`).toEqual(NOT_PARTICIPANT);
      const none = await call(c.method, `/api/meetings/NOPE02${c.path}`, f.outsider, c.body);
      expect(none.status, `${c.name} 404`).toBe(404);
      expect(none.body, `${c.name} 404 body`).toEqual(NOT_FOUND);
      const ok = await call(c.method, `/api/meetings/${f.code}${c.path}`, f.member, c.body);
      expect(ok.status, `${c.name} member → ${JSON.stringify(ok.body)}`).toBeLessThan(300);
    }
    // recaps 목록·next-registered 는 자체 검사 문구
    const recaps = await call('get', `/api/meetings/${f.code}/recaps`, f.outsider);
    expect(recaps.body).toEqual({ error: '회의 참가자만 볼 수 있어요' });
    const nr = await call('post', `/api/meetings/${f.code}/recaps/${recapId}/next-registered`, f.outsider);
    expect(nr.body).toEqual({ error: '회의 참가자만 쓸 수 있어요' });
    expect((await call('post', `/api/meetings/${f.code}/recaps/${recapId}/next-registered`, f.member)).status).toBe(404); // 제안 없음
    // 부수 효과가 실제로 남았는지 — 서명·용어·체크리스트·수동 결정·안건 상태
    expect(db.prepare('SELECT 1 FROM event_acks WHERE event_id = ? AND user_id = ?').get(ev.body.id, f.member.id)).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM decision_acks WHERE recap_id = ? AND decision_idx = 0 AND user_id = ?').get(recapId, f.member.id)).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM handover_acks WHERE handover_id = ? AND user_id = ?').get(ho.body.id, f.member.id)).toBeTruthy();
    expect((db.prepare('SELECT term FROM meeting_glossary WHERE meeting_id = ?').get(f.meetingId) as { term: string }).term).toBe('완제라인');
    expect((db.prepare('SELECT label FROM handover_checklist WHERE meeting_id = ?').get(f.meetingId) as { label: string }).label).toBe('설비 알람 확인');
    expect(db.prepare("SELECT 1 FROM meeting_recaps WHERE meeting_id = ? AND source = 'manual' AND decisions = '[\"수동 결정\"]'").get(f.meetingId)).toBeTruthy();
    expect(db.prepare('SELECT status, status_note FROM agenda_items WHERE id = ?').get(item)).toEqual({ status: 'hold', status_note: '승인 대기' });
    // 수동 결정은 기록자 외 참가자(host)에게 알림
    const hostNoti = db.prepare("SELECT text, kind FROM notifications WHERE user_id = ? AND text LIKE '결정이 원장에 기록됐어요%'").get(f.host.id) as { text: string; kind: string };
    expect(hostNoti).toEqual({ text: '결정이 원장에 기록됐어요 — 수동 결정', kind: 'recap' });
    // 입력 검증 — 용어 2자 미만 400, 수동 결정 빈 문자열 400, 체크리스트 20개 상한
    expect((await call('post', `/api/meetings/${f.code}/glossary`, f.member, { term: 'a' })).body).toEqual({ error: '용어는 2자 이상이어야 해요' });
    expect((await call('post', `/api/meetings/${f.code}/decisions/manual`, f.member, { text: '  ' })).body).toEqual({ error: '기록할 내용이 없어요' });
    for (let i = 0; i < 19; i++) expect((await call('post', `/api/meetings/${f.code}/handovers/checklist`, f.member, { label: `항목 ${i}` })).status).toBe(200);
    expect((await call('post', `/api/meetings/${f.code}/handovers/checklist`, f.member, { label: '21번째' })).body).toEqual({ error: '항목을 추가할 수 없어요 (최대 20개)' });
    expect((await call('delete', `/api/meetings/${f.code}/handovers/checklist/999999`, f.member)).body).toEqual({ error: '없는 항목이에요' });
    // 용어집 삭제 — 다른 회의 것은 못 지운다
    const termId = (db.prepare('SELECT id FROM meeting_glossary WHERE meeting_id = ?').get(f.meetingId) as { id: number }).id;
    expect((await call('delete', `/api/meetings/${f.personal.code}/glossary/${termId}`, f.member)).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM meeting_glossary WHERE id = ?').get(termId)).toBeTruthy();
    expect((await call('delete', `/api/meetings/${f.code}/glossary/${termId}`, f.member)).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM meeting_glossary WHERE id = ?').get(termId)).toBeUndefined();
  }, 30_000);

  it('결정 ack — 다른 회의의 recap 은 404, idx 범위 밖 404, 잘못된 요청 400', async () => {
    const f = await fixture('rg6');
    const recapId = insertRecap(f.meetingId, ['A']);
    const foreign = insertRecap(f.personal.id, ['B']);
    expect((await call('post', `/api/meetings/${f.code}/decisions/ack`, f.member, { recapId: foreign, idx: 0 })).status).toBe(404);
    expect((await call('post', `/api/meetings/${f.code}/decisions/ack`, f.member, { recapId, idx: 1 })).body).toEqual({ error: '존재하지 않는 결정입니다' });
    expect((await call('post', `/api/meetings/${f.code}/decisions/ack`, f.member, { recapId: 'x', idx: 0 })).body).toEqual({ error: '잘못된 요청입니다' });
    expect((await call('post', `/api/meetings/${f.code}/decisions/ack`, f.member, { recapId, idx: 0, note: '  확인함  ' })).body).toEqual({ ok: true });
    expect(db.prepare('SELECT note FROM decision_acks WHERE recap_id = ? AND user_id = ?').get(recapId, f.member.id)).toEqual({ note: '확인함' });
    // 정정·철회 라우트도 소유 검사·정수 검사
    expect((await call('patch', `/api/meetings/${f.code}/decisions/${foreign}/0`, f.host, { decision: 'x', reason: 'y' })).status).toBe(404);
    expect((await call('patch', `/api/meetings/${f.code}/decisions/abc/0`, f.host, { decision: 'x', reason: 'y' })).body).toEqual({ error: '잘못된 요청입니다' });
    expect((await call('post', `/api/meetings/${f.code}/decisions/${foreign}/0/withdraw`, f.host, { reason: 'y' })).status).toBe(404);
    expect((await call('get', `/api/meetings/${f.code}/decisions/${foreign}/0/revisions`, f.member)).status).toBe(404);
    expect((await call('get', `/api/meetings/${f.code}/decisions/x/0/revisions`, f.member)).status).toBe(400);
  }, 30_000);
});

describe('조직 라우트 가드', () => {
  it('역할 CRUD 는 소유자만(admin 도 403), 조회·감사·그룹·팀 확인 현황의 멤버/관리자 경계', async () => {
    const f = await fixture('rg7');
    const o = f.orgId;
    const roleDeny = await call('post', `/api/orgs/${o}/roles`, f.admin, { name: '리더', perms: ['member:approve'] });
    expect(roleDeny.status).toBe(403);
    expect(roleDeny.body).toEqual({ error: '역할은 소유자만 만들 수 있어요' });
    expect((await call('post', `/api/orgs/${o}/roles`, f.outsider, { name: '리더', perms: ['member:approve'] })).status).toBe(403);
    const role = await call('post', `/api/orgs/${o}/roles`, f.host, { name: '리더', perms: ['member:approve', 'bogus:perm'] });
    expect(role.body).toEqual({ id: expect.any(Number), name: '리더', perms: ['member:approve'] });
    expect((await call('post', `/api/orgs/${o}/roles`, f.host, { name: '빈 권한', perms: ['bogus'] })).body).toEqual({ error: '권한을 하나 이상 선택하세요' });
    expect((await call('post', `/api/orgs/${o}/roles`, f.host, { name: '  ', perms: ['member:approve'] })).body).toEqual({ error: '역할 이름을 입력하세요' });
    const pd = await call('patch', `/api/orgs/${o}/roles/${role.body.id}`, f.admin, { name: '탈취' });
    expect(pd.body).toEqual({ error: '역할은 소유자만 수정할 수 있어요' });
    expect((await call('patch', `/api/orgs/${o}/roles/999999`, f.host, { name: 'x' })).status).toBe(404);
    expect((await call('patch', `/api/orgs/${o}/roles/${role.body.id}`, f.host, { perms: [] })).body).toEqual({ error: '권한을 하나 이상 선택하세요' });
    expect((await call('patch', `/api/orgs/${o}/roles/${role.body.id}`, f.host, { name: '부서 리더', perms: ['member:reject'] })).body).toEqual({ ok: true });
    expect(db.prepare('SELECT name, perms FROM org_roles WHERE id = ?').get(role.body.id)).toEqual({ name: '부서 리더', perms: '["member:reject"]' });
    const dd = await call('delete', `/api/orgs/${o}/roles/${role.body.id}`, f.admin);
    expect(dd.body).toEqual({ error: '역할은 소유자만 삭제할 수 있어요' });
    // 부여 후 삭제하면 멤버는 일반 멤버로
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, f.host, { roleId: role.body.id })).body).toEqual({ ok: true });
    expect((db.prepare('SELECT role_id FROM organization_members WHERE org_id = ? AND user_id = ?').get(o, f.member.id) as { role_id: number }).role_id).toBe(role.body.id);
    expect((await call('delete', `/api/orgs/${o}/roles/${role.body.id}`, f.host)).body).toEqual({ ok: true });
    expect((db.prepare('SELECT role_id FROM organization_members WHERE org_id = ? AND user_id = ?').get(o, f.member.id) as { role_id: number | null }).role_id).toBeNull();
    expect(db.prepare('SELECT 1 FROM org_roles WHERE id = ?').get(role.body.id)).toBeUndefined();
    const actions = (db.prepare('SELECT action FROM org_audit WHERE org_id = ? ORDER BY id').all(o) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['role.create', 'role.update', 'member.assign_role', 'role.delete']));

    // 조회 경계
    expect((await call('get', `/api/orgs/${o}`, f.outsider)).body).toEqual({ error: '이 조직의 멤버가 아니에요' });
    expect((await call('get', '/api/orgs/999999', f.host)).body).toEqual({ error: '이 조직의 멤버가 아니에요' });
    const asMember = await call('get', `/api/orgs/${o}`, f.member);
    expect(asMember.body.joinCode).toBeUndefined(); // 가입코드는 관리자만
    expect(asMember.body.isManager).toBe(false);
    expect(asMember.body.myRole).toBe('member');
    const asOwner = await call('get', `/api/orgs/${o}`, f.host);
    expect(asOwner.body.joinCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(asOwner.body.isManager).toBe(true);
    expect((await call('get', `/api/orgs/${o}/audit`, f.member)).body).toEqual({ error: '활동 기록은 관리자만 볼 수 있어요' });
    expect((await call('get', `/api/orgs/${o}/audit`, f.admin)).status).toBe(200);
    expect((await call('get', `/api/orgs/${o}/groups`, f.member)).body).toEqual({ error: '전체 그룹은 관리자만 볼 수 있어요' });
    const groups = await call('get', `/api/orgs/${o}/groups`, f.admin);
    expect(groups.body).toHaveLength(1);
    expect(groups.body[0]).toMatchObject({ code: f.code, host: f.host.username, participantCount: 2, joined: false });
    expect((await call('get', `/api/orgs/${o}/my-focus`, f.outsider)).body).toEqual({ error: '이 조직의 멤버가 아니에요' });
    expect((await call('get', `/api/orgs/${o}/my-focus`, f.admin)).body).toEqual({ todos: [], events: [], unread: [] }); // 참가 그룹 없음
    // 팀 확인 현황 — 계층 미지정 일반 멤버 403, field 403, relay 200, 관리자 200
    expect((await call('get', `/api/orgs/${o}/team-acks`, f.member)).body).toEqual({ error: '확인 현황은 관리자·중간관리자만 볼 수 있어요' });
    expect((await call('get', `/api/orgs/${o}/team-acks`, f.outsider)).body).toEqual({ error: '이 조직의 멤버가 아니에요' });
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, f.admin, { tier: 'field' })).body).toEqual({ ok: true });
    expect((await call('get', `/api/orgs/${o}/team-acks`, f.member)).status).toBe(403);
    expect((await call('post', `/api/orgs/${o}/team-acks/remind`, f.member, { recapId: 1, idx: 0 })).body).toEqual({ error: '리마인드는 관리자·중간관리자만 보낼 수 있어요' });
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, f.admin, { tier: 'relay' })).body).toEqual({ ok: true });
    expect((await call('get', `/api/orgs/${o}/team-acks`, f.member)).body).toEqual({ department: '생산1팀', items: [] });
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, f.admin, { tier: 'ceo' })).body).toEqual({ error: '계층은 hq·relay·field 중 하나예요' });
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, f.member, { tier: 'hq' })).body).toEqual({ error: '계층 지정은 관리자만 할 수 있어요' });
  }, 30_000);

  it('멤버 승인·거절·제거·역할 변경 — 권한 경계와 알림', async () => {
    const f = await fixture('rg8');
    const o = f.orgId;
    const applicant = await register(app, 'rg8_applicant');
    const org = db.prepare('SELECT join_code FROM organizations WHERE id = ?').get(o) as { join_code: string };
    expect((await call('post', '/api/orgs/join', applicant, { joinCode: org.join_code.toLowerCase().replace('-', ' ') })).body).toEqual({ ok: true, orgName: 'rg8 조직', status: 'pending' });
    // 관리자(owner·admin)에게 가입 신청 알림
    for (const mgr of [f.host, f.admin]) {
      const n = db.prepare("SELECT text, kind FROM notifications WHERE user_id = ? AND kind = 'org-request' ORDER BY id DESC LIMIT 1").get(mgr.id);
      expect(n, mgr.username).toEqual({ text: 'rg8_applicant님이 rg8 조직 가입을 신청했어요', kind: 'org-request' });
    }
    expect(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'org-request' AND text LIKE 'rg8_applicant%'").get(f.member.id)).toBeUndefined();
    expect((await call('post', '/api/orgs/join', applicant, { joinCode: org.join_code })).body).toEqual({ error: '이미 가입 신청을 보냈어요 — 승인을 기다려주세요' });
    expect((await call('post', '/api/orgs/join', f.member, { joinCode: org.join_code })).body).toEqual({ error: '이미 이 조직의 멤버예요' });
    expect((await call('post', '/api/orgs/join', applicant, { joinCode: 'ABC' })).body).toEqual({ error: '가입코드를 확인하세요' });
    expect((await call('post', '/api/orgs/join', applicant, { joinCode: 'AAAA-BBBB' })).body).toEqual({ error: '존재하지 않는 가입코드입니다' });
    // 승인 — 일반 멤버 403, 활성 멤버 재승인 404
    const deny = await call('post', `/api/orgs/${o}/members/${applicant.id}/approve`, f.member, {});
    expect(deny.body).toEqual({ error: '승인 권한이 없어요' });
    expect((await call('post', `/api/orgs/${o}/members/${f.member.id}/approve`, f.host, {})).body).toEqual({ error: '대기 중인 신청이 아니에요' });
    // 대기 목록은 승인권자에게만
    expect((await call('get', `/api/orgs/${o}`, f.member)).body.pending).toEqual([]);
    expect((await call('get', `/api/orgs/${o}`, f.admin)).body.pending).toMatchObject([{ userId: applicant.id, username: 'rg8_applicant' }]);
    const ok = await call('post', `/api/orgs/${o}/members/${applicant.id}/approve`, f.admin, { position: '대리', department: '품질팀' });
    expect(ok.body).toEqual({ ok: true });
    expect(db.prepare('SELECT status, position, department FROM organization_members WHERE org_id = ? AND user_id = ?').get(o, applicant.id)).toEqual({ status: 'active', position: '대리', department: '품질팀' });
    expect(db.prepare("SELECT text, kind FROM notifications WHERE user_id = ? AND kind = 'org-approved'").get(applicant.id)).toEqual({ text: 'rg8 조직 가입이 승인됐어요 — 품질팀 대리', kind: 'org-approved' });
    // 제거 — 소유자 400, 일반 멤버 403, admin OK
    expect((await call('delete', `/api/orgs/${o}/members/${f.host.id}`, f.admin)).body).toEqual({ error: '소유자는 제거할 수 없어요' });
    expect((await call('delete', `/api/orgs/${o}/members/${applicant.id}`, f.member)).body).toEqual({ error: '권한이 없어요' });
    expect((await call('delete', `/api/orgs/${o}/members/999999`, f.host)).body).toEqual({ error: '대상을 찾을 수 없어요' });
    expect((await call('delete', `/api/orgs/${o}/members/${applicant.id}`, f.admin)).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ?').get(o, applicant.id)).toBeUndefined();
    // 거절 — 대기자 거절은 member:reject 필요
    await call('post', '/api/orgs/join', applicant, { joinCode: org.join_code });
    expect((await call('delete', `/api/orgs/${o}/members/${applicant.id}`, f.member)).body).toEqual({ error: '가입 거절 권한이 없어요' });
    expect((await call('delete', `/api/orgs/${o}/members/${applicant.id}`, f.host)).body).toEqual({ ok: true });
    expect(db.prepare("SELECT text FROM org_audit WHERE org_id = ? AND action = 'member.reject'").get(o)).toEqual({ text: 'rg8_applicant님 가입 거절' });
    // 역할 변경(admin↔member)은 소유자만, 소유자 역할은 불변, 값 검증
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, f.admin, { role: 'admin' })).body).toEqual({ error: '소유자만 역할을 바꿀 수 있어요' });
    expect((await call('patch', `/api/orgs/${o}/members/${f.host.id}`, f.host, { role: 'member' })).body).toEqual({ error: '소유자 역할은 바꿀 수 없어요' });
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, f.host, { role: 'owner' })).body).toEqual({ error: '역할은 admin 또는 member여야 해요' });
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, f.host, { role: 'admin' })).body).toEqual({ ok: true });
    expect(db.prepare("SELECT text, kind FROM notifications WHERE user_id = ? AND kind = 'org-role'").get(f.member.id)).toEqual({ text: '관리자로 지정됐어요 — 조직 전체를 관리할 수 있어요', kind: 'org-role' });
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, f.member, { roleId: null })).body).toEqual({ error: '역할 부여는 소유자만 할 수 있어요' });
    expect((await call('patch', `/api/orgs/${o}/members/${f.host.id}`, f.host, { roleId: null })).body).toEqual({ error: '소유자에겐 역할을 줄 수 없어요' });
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, f.host, { roleId: 999999 })).body).toEqual({ error: '역할을 찾을 수 없어요' });
    expect((await call('patch', `/api/orgs/${o}/members/999999`, f.host, { role: 'admin' })).body).toEqual({ error: '활성 멤버가 아니에요' });
    // 직급·부서 — 소유자 정보는 본인만
    expect((await call('patch', `/api/orgs/${o}/members/${f.host.id}`, f.admin, { position: '사장' })).body).toEqual({ error: '소유자 정보는 본인만 수정할 수 있어요' });
    expect((await call('patch', `/api/orgs/${o}/members/${f.host.id}`, f.host, { position: '대표', department: '경영' })).body).toEqual({ ok: true });
    expect(db.prepare('SELECT position, department FROM organization_members WHERE org_id = ? AND user_id = ?').get(o, f.host.id)).toEqual({ position: '대표', department: '경영' });
  }, 30_000);

  it('중간관리자(커스텀 역할) 스코프 — 자기 부서의 일반 멤버만, 승인은 자기 부서로', async () => {
    const f = await fixture('rg9');
    const o = f.orgId;
    const leader = await register(app, 'rg9_leader');
    await joinOrg(app, { id: o, joinCode: (db.prepare('SELECT join_code FROM organizations WHERE id = ?').get(o) as { join_code: string }).join_code }, f.host, leader, { department: '생산1팀' });
    const otherDept = await register(app, 'rg9_other');
    await joinOrg(app, { id: o, joinCode: (db.prepare('SELECT join_code FROM organizations WHERE id = ?').get(o) as { join_code: string }).join_code }, f.host, otherDept, { department: '생산2팀' });
    const role = await call('post', `/api/orgs/${o}/roles`, f.host, { name: '조장', perms: ['member:approve', 'member:edit-position', 'member:remove'] });
    expect((await call('patch', `/api/orgs/${o}/members/${leader.id}`, f.host, { roleId: role.body.id })).body).toEqual({ ok: true });
    expect(db.prepare("SELECT text FROM notifications WHERE user_id = ? AND kind = 'org-role'").get(leader.id)).toEqual({
      text: '"조장" 역할을 받았어요 — 부서 안에서 가입 승인, 직급 수정, 멤버 내보내기 권한이 생겼어요',
    });
    // 같은 부서 일반 멤버(member)는 직급 수정 가능, 다른 부서(otherDept)는 403
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, leader, { position: '주임' })).body).toEqual({ ok: true });
    expect((await call('patch', `/api/orgs/${o}/members/${otherDept.id}`, leader, { position: '주임' })).body).toEqual({ error: '직급을 수정할 권한이 없어요' });
    expect((await call('patch', `/api/orgs/${o}/members/${f.member.id}`, leader, { department: '생산2팀' })).body).toEqual({ error: '부서를 수정할 권한이 없어요' }); // edit-department 없음
    expect((await call('delete', `/api/orgs/${o}/members/${otherDept.id}`, leader)).body).toEqual({ error: '권한이 없어요' });
    expect((await call('delete', `/api/orgs/${o}/members/${f.admin.id}`, leader)).body).toEqual({ error: '권한이 없어요' }); // 관리자는 대상 아님
    // 승인 — 중간관리자의 승인은 자기 부서로 강제 (body.department 무시)
    const applicant = await register(app, 'rg9_applicant');
    await call('post', '/api/orgs/join', applicant, { joinCode: (db.prepare('SELECT join_code FROM organizations WHERE id = ?').get(o) as { join_code: string }).join_code });
    expect((await call('post', `/api/orgs/${o}/members/${applicant.id}/approve`, leader, { department: '경영', position: '사원' })).body).toEqual({ ok: true });
    expect(db.prepare('SELECT department, position FROM organization_members WHERE org_id = ? AND user_id = ?').get(o, applicant.id)).toEqual({ department: '생산1팀', position: '사원' });
    expect((await call('delete', `/api/orgs/${o}/members/${applicant.id}`, leader)).body).toEqual({ ok: true });
    // 역할 보유자는 그룹 생성 권한이 없으면 조직 그룹을 못 만든다 (canCreateOrgGroup)
    const g = await call('post', '/api/meetings', leader, { title: '조장 그룹', org_id: o });
    expect(g.body).toEqual({ error: '조직에 그룹을 만들 권한이 없어요 — 관리자에게 요청하세요' });
    expect((await call('post', '/api/meetings', leader, { title: 'x', org_id: 'abc' })).body).toEqual({ error: '잘못된 조직입니다' });
    // GET /orgs 의 canCreateGroup·pendingCount·myTier
    const list = await call('get', '/api/orgs', leader);
    expect(list.body[0]).toMatchObject({ id: o, role: 'member', isManager: false, canCreateGroup: false, pendingCount: 0, myTier: null });
    const ownerList = await call('get', '/api/orgs', f.host);
    expect(ownerList.body[0]).toMatchObject({ isManager: true, canCreateGroup: true, memberCount: 5 });
  }, 30_000);
});

describe('할 일·스코프 라우트 가드', () => {
  it('todos — 관련 없는 참가자·외부인 403(문구), 담당자·호스트·admin OK, 기한 형식 400', async () => {
    const f = await fixture('rg10');
    const t = await call('post', '/api/todos', f.member, { title: '지그 교체', meeting: f.code });
    expect(t.status).toBe(200);
    const other = await register(app, 'rg10_other');
    await joinMeeting(app, other, f.code);
    const deny = await call('patch', `/api/todos/${t.body.id}`, other, { done: true });
    expect(deny.status).toBe(403);
    expect(deny.body).toEqual({ error: '담당자·작성자·관리자만 할 일을 바꿀 수 있어요' });
    const delDeny = await call('delete', `/api/todos/${t.body.id}`, f.outsider);
    expect(delDeny.body).toEqual({ error: '담당자·작성자·관리자만 지울 수 있어요' });
    expect((await call('patch', `/api/todos/${t.body.id}`, f.admin, { due_at: '2026-9-1' })).body).toEqual({ error: '마감일 형식이 잘못됐어요' });
    expect((await call('patch', `/api/todos/${t.body.id}`, f.admin, { due_at: '2026-09-15' })).body).toEqual({ ok: true });
    expect((await call('patch', `/api/todos/${t.body.id}`, f.host, { done: true })).body).toEqual({ ok: true });
    // 완료 보고 — 작성자(member)에게 알림, 완료자 본인 제외
    expect(db.prepare("SELECT text, kind, meeting_code FROM notifications WHERE user_id = ? AND kind = 'todo'").get(f.member.id)).toEqual({
      text: `'지그 교체' 할 일을 완료했어요 ('rg10 그룹')`,
      kind: 'todo',
      meeting_code: f.code,
    });
    expect(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'todo'").get(f.host.id)).toBeUndefined();
    expect((await call('delete', `/api/todos/${t.body.id}`, f.member)).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM todos WHERE id = ?').get(t.body.id)).toBeUndefined();
  }, 30_000);

  it('agent ?org= 스코프 — 비정수 400, 비멤버 403, 개인/조직 스코프 분리', async () => {
    const f = await fixture('rg11');
    expect((await call('get', '/api/agent/overview?org=abc', f.host)).body).toEqual({ error: '잘못된 org 값입니다' });
    expect((await call('get', '/api/agent/overview?org=0', f.host)).status).toBe(400);
    expect((await call('get', `/api/agent/overview?org=${f.orgId}`, f.outsider)).body).toEqual({ error: '조직 멤버가 아닙니다' });
    for (const p of ['sent', 'actions', 'search?q=x', 'recent-decisions', 'pending-decisions']) {
      const sep = p.includes('?') ? '&' : '?';
      expect((await call('get', `/api/agent/${p}${sep}org=${f.orgId}`, f.outsider)).status, p).toBe(403);
    }
    expect((await call('get', `/api/agent/overview?org=${f.orgId}`, f.host)).body.meetingCount).toBe(1);
    expect((await call('get', '/api/agent/overview?org=personal', f.host)).body.meetingCount).toBe(1);
    expect((await call('get', '/api/agent/overview', f.host)).body.meetingCount).toBe(2);
    // meetings ?org= 도 같은 규칙
    expect((await call('get', `/api/meetings/recent?org=${f.orgId}`, f.outsider)).body).toEqual({ error: '이 조직의 멤버가 아니에요' });
    expect((await call('get', '/api/meetings/recent?org=abc', f.host)).body).toEqual({ error: '잘못된 조직입니다' });
    expect((await call('get', `/api/meetings/schedule?org=${f.orgId}`, f.outsider)).status).toBe(403);
    expect((await call('get', `/api/meetings/inbox?org=${f.orgId}`, f.outsider)).status).toBe(403);
    expect((await call('get', `/api/meetings/users/search?q=rg11&org=${f.orgId}`, f.outsider)).status).toBe(403);
    const inOrg = await call('get', `/api/meetings/users/search?q=rg11&org=${f.orgId}`, f.host);
    expect(inOrg.body.map((u: { username: string }) => u.username).sort()).toEqual(['rg11_admin', 'rg11_member']); // 조직 밖 outsider 제외, 본인 제외
    const all = await call('get', '/api/meetings/users/search?q=rg11', f.host);
    expect(all.body.map((u: { username: string }) => u.username).sort()).toEqual(['rg11_admin', 'rg11_member', 'rg11_out']);
  }, 30_000);
});
