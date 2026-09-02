import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * agent.ts — 홈 카드 라우트(/sent /actions /search /overview /recent-decisions /pending-decisions)를
 * 심어둔 데이터로 정확한 숫자까지 단언 + nowbar 브리핑 환각 게이트(briefGrounded)와 규칙 카드.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { briefGrounded, generateBrief, invalidateBrief } from '../agent.js';
import { ackDecision, withdrawDecision } from '../recap.js';
import { register, auth, createMeeting, joinMeeting, createOrg, joinOrg, setOrgRole, insertRecap, type User } from './helpers/fixtures.js';
import { queueJson, setNextResponses, resetOpenAiMock, captured } from './helpers/openaiMock.js';

const app = createApp();
beforeEach(() => resetOpenAiMock());

const pad = (n: number) => String(n).padStart(2, '0');
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const get = (u: User, path: string) => request(app).get(`/api/agent${path}`).set(auth(u));
const say = (meetingId: number, uid: number, text: string) => db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(meetingId, uid, text);

describe('/sent — 발신자 카드', () => {
  it('내가 호스트인 그룹의 7일 내 결정만, 미도달 우선(critical → 도달률 → 최신), missing 이름·totalSent', async () => {
    const host = await register(app, 'ag1_host');
    const member = await register(app, 'ag1_member');
    const third = await register(app, 'ag1_third');
    db.prepare("UPDATE users SET name = '박셋째' WHERE id = ?").run(third.id);
    const m = await createMeeting(app, host, 'ag1 그룹');
    await joinMeeting(app, member, m.code);
    await joinMeeting(app, third, m.code);
    const recapId = insertRecap(m.id, ['결정 0 — 모두 미확인', '결정 1 — 중요', '결정 2 — 전원 확인']);
    db.prepare('UPDATE meeting_recaps SET criticals = ? WHERE id = ?').run(JSON.stringify([false, true, false]), recapId);
    ackDecision(recapId, 0, member.id);
    for (const u of [host, member, third]) ackDecision(recapId, 2, u.id);
    insertRecap(m.id, ['8일 전 결정'], { createdAt: new Date(Date.now() - 8 * 864e5).toISOString().replace('T', ' ').slice(0, 19) });
    // 내가 참가만 한 그룹(호스트 아님)의 결정은 발신자 카드 대상이 아니다
    const other = await createMeeting(app, member, '남의 그룹');
    await joinMeeting(app, host, other.code);
    insertRecap(other.id, ['남이 보낸 결정']);

    const r = await get(host, '/sent');
    expect(r.status).toBe(200);
    expect(r.body.totalSent).toBe(3);
    // 발신자(조회자 본인)는 분모·미확인 목록에서 제외 (9/3 결함 #10b) — host 는 3명 중 자신을 뺀 2명 기준
    expect(r.body.entries.map((e: { idx: number; acked: number; total: number; missing: string[]; critical: boolean }) => [e.idx, e.acked, e.total, e.missing, e.critical])).toEqual([
      [1, 0, 2, ['ag1_member', '박셋째'], true], // critical 이 먼저 (표시 이름 우선)
      [0, 1, 2, ['박셋째'], false],
      [2, 2, 2, [], false], // 완료된 건 뒤로
    ]);
    expect(r.body.entries[0]).toMatchObject({ recapId, decision: '결정 1 — 중요', code: m.code, title: 'ag1 그룹', ts: expect.any(Number) });
    // member(발신자)도 자기 자신 제외 — 남은 대상은 host 1명뿐
    expect((await get(member, '/sent')).body).toEqual({ entries: [{ recapId: expect.any(Number), idx: 0, decision: '남이 보낸 결정', code: other.code, title: '남의 그룹', ts: expect.any(Number), acked: 0, total: 1, missing: ['ag1_host'], critical: false }], totalSent: 1 });
    expect((await get(third, '/sent')).body).toEqual({ entries: [], totalSent: 0 });
    // 조직 admin 은 참가하지 않은 조직 그룹의 결정도 발신자로 본다 (?org= 스코프)
    const admin = await register(app, 'ag1_admin');
    const org = await createOrg(app, host, 'ag1 조직');
    await joinOrg(app, org, host, admin);
    await setOrgRole(app, org.id, host, admin, 'admin');
    const orgMeeting = await createMeeting(app, host, '조직 그룹', { org_id: org.id });
    insertRecap(orgMeeting.id, ['조직 결정']);
    expect((await get(admin, `/sent?org=${org.id}`)).body).toMatchObject({ totalSent: 1, entries: [{ decision: '조직 결정', total: 1, missing: ['ag1_host'] }] });
    expect((await get(admin, '/sent?org=personal')).body).toEqual({ entries: [], totalSent: 0 });
    expect((await get(host, '/sent?org=personal')).body.totalSent).toBe(3);
  }, 20_000);
});

describe('/actions — 지금 처리할 것', () => {
  it('미확인 결정(최대 10)·기한 지난/오늘 할 일·상대별 안읽은 DM 을 정확한 수로', async () => {
    const me = await register(app, 'ag2_me');
    const b = await register(app, 'ag2_b');
    const c = await register(app, 'ag2_c');
    const m = await createMeeting(app, me, 'ag2 그룹');
    await joinMeeting(app, b, m.code);
    const recapId = insertRecap(m.id, ['확인한 결정', '안 한 결정']);
    ackDecision(recapId, 0, me.id);
    for (let i = 0; i < 12; i++) insertRecap(m.id, [`추가 ${i}`]);
    db.prepare("INSERT INTO todos (user_id, title, due_at) VALUES (?, '어제 마감', date('now', 'localtime', '-1 day'))").run(me.id);
    db.prepare("INSERT INTO todos (user_id, title, due_at) VALUES (?, '오늘 마감', date('now', 'localtime'))").run(me.id);
    db.prepare("INSERT INTO todos (user_id, title, due_at) VALUES (?, '내일 마감', date('now', 'localtime', '+1 day'))").run(me.id);
    db.prepare("INSERT INTO todos (user_id, title, due_at, done) VALUES (?, '끝낸 것', date('now', 'localtime', '-3 day'), 1)").run(me.id);
    db.prepare("INSERT INTO todos (user_id, title, due_at) VALUES (?, '남의 할 일', date('now', 'localtime', '-1 day'))").run(b.id);
    const ins = db.prepare('INSERT INTO dm_messages (org_id, from_id, to_id, text, read) VALUES (NULL, ?, ?, ?, ?)');
    ins.run(b.id, me.id, 'b 첫 번째', 0);
    ins.run(c.id, me.id, 'c 메시지', 0);
    ins.run(b.id, me.id, 'b 두 번째', 0);
    ins.run(b.id, me.id, '읽은 것', 1);
    ins.run(me.id, b.id, '내가 보낸 것', 0);

    const r = await get(me, '/actions');
    expect(r.status).toBe(200);
    expect(r.body.decisions).toHaveLength(10);
    expect(r.body.decisions[0]).toEqual({ recapId: expect.any(Number), idx: 0, decision: '추가 11', code: m.code, title: 'ag2 그룹', ts: expect.any(Number) });
    expect(r.body.decisions.map((d: { decision: string }) => d.decision)).not.toContain('확인한 결정');
    expect(r.body.todos.map((t: { title: string }) => t.title)).toEqual(['어제 마감', '오늘 마감']);
    expect(r.body.todos[0]).toEqual({ id: expect.any(Number), title: '어제 마감', due_at: expect.any(String), code: null, mtitle: null });
    expect(r.body.dms.map((d: { username: string; unread: number; lastText: string }) => [d.username, d.unread, d.lastText])).toEqual([
      ['ag2_b', 2, 'b 두 번째'], // 마지막 메시지 id 가 큰 상대부터, 읽은 것·내가 보낸 것 제외
      ['ag2_c', 1, 'c 메시지'],
    ]);
    expect(r.body.dms[0]).toMatchObject({ userId: b.id, name: null, avatar: '🐧', ts: expect.any(Number) });
    expect(r.body.pendingAcks).toEqual([]);
    expect(r.body.pendingAcksTotal).toBe(0);
    // b 관점: 결정 14개 중 미확인이 10개 상한, DM 은 me 가 보낸 1건
    const rb = await get(b, '/actions');
    expect(rb.body.decisions).toHaveLength(10);
    expect(rb.body.dms).toEqual([expect.objectContaining({ username: 'ag2_me', unread: 1, lastText: '내가 보낸 것' })]);
    expect(rb.body.todos.map((t: { title: string }) => t.title)).toEqual(['남의 할 일']);
    // /pending-decisions 는 같은 규칙으로 최대 20
    for (let i = 0; i < 10; i++) insertRecap(m.id, [`더 ${i}`]);
    const pd = await get(me, '/pending-decisions');
    expect(pd.body.items).toHaveLength(20);
    expect(pd.body.items[0].decision).toBe('더 9');
    expect(pd.body.items.some((d: { decision: string }) => d.decision === '확인한 결정')).toBe(false);
  }, 20_000);
});

describe('/search — 전역 검색', () => {
  it('내 그룹 범위에서 그룹명·채팅·결정 문장·할 일·파일·일정·인수인계 항목을 각각 5건까지, LIKE 특수문자 이스케이프', async () => {
    const me = await register(app, 'ag3_me');
    const other = await register(app, 'ag3_other');
    const m = await createMeeting(app, me, '수율 개선 TF');
    const foreign = await createMeeting(app, other, '수율 남의 그룹');
    say(m.id, me.id, '수율 100% 달성');
    say(m.id, me.id, '수율 100 개 샘플');
    say(foreign.id, other.id, '수율 100% 남의 채팅');
    insertRecap(m.id, ['수율 100% 유지 결정', '무관한 결정']);
    db.prepare('INSERT INTO todos (user_id, meeting_id, title) VALUES (?, ?, ?)').run(other.id, m.id, '수율 100% 리포트');
    db.prepare('INSERT INTO todos (user_id, title) VALUES (?, ?)').run(me.id, '개인 수율 100% 메모');
    db.prepare('INSERT INTO todos (user_id, title) VALUES (?, ?)').run(other.id, '남의 개인 수율 100%');
    db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by) VALUES (?, '수율 100% 보고서', 'doc', ?)").run(m.id, me.id);
    db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by, deleted_at) VALUES (?, '수율 100% 삭제본', 'doc', ?, datetime('now'))").run(m.id, me.id);
    db.prepare("INSERT INTO meeting_events (meeting_id, title, date, created_by) VALUES (?, '수율 100% 점검', '2026-09-10', ?)").run(m.id, me.id);
    db.prepare("INSERT INTO handovers (meeting_id, author_id, shift_label, sections) VALUES (?, ?, '야간조', ?)").run(m.id, me.id, JSON.stringify({ issues: ['수율 100% 이슈', '다른 이슈'], pending: ['수율 100% 미결'], changes: 'not-array' }));
    for (let i = 0; i < 7; i++) say(m.id, me.id, `수율 100% 반복 ${i}`);

    const r = await get(me, '/search?q=' + encodeURIComponent('수율 100%'));
    expect(r.status).toBe(200);
    expect(r.body.groups).toEqual([]); // 그룹명엔 '%' 가 없다
    expect(r.body.messages).toHaveLength(5); // 상한 5, 최신순
    expect(r.body.messages[0]).toMatchObject({ text: '수율 100% 반복 6', sub: 'ag3_me', code: m.code, title: '수율 개선 TF' });
    expect(r.body.messages.some((x: { text: string }) => x.text === '수율 100 개 샘플')).toBe(false); // '%' 이스케이프
    expect(r.body.messages.some((x: { text: string }) => x.text.includes('남의'))).toBe(false);
    expect(r.body.decisions).toEqual([{ text: '수율 100% 유지 결정', code: m.code, title: '수율 개선 TF', ts: expect.any(String) }]);
    expect(r.body.todos.map((t: { text: string }) => t.text).sort()).toEqual(['개인 수율 100% 메모', '수율 100% 리포트']);
    expect(r.body.files).toEqual([{ text: '수율 100% 보고서', sub: 'doc', code: m.code, title: '수율 개선 TF' }]);
    expect(r.body.events).toEqual([{ text: '수율 100% 점검', sub: '2026-09-10', code: m.code, title: '수율 개선 TF' }]);
    expect(r.body.handovers).toEqual([
      { text: '수율 100% 이슈', sub: '야간조', code: m.code, title: '수율 개선 TF', ts: expect.any(String) },
      { text: '수율 100% 미결', sub: '야간조', code: m.code, title: '수율 개선 TF', ts: expect.any(String) },
    ]);
    const g = await get(me, '/search?q=' + encodeURIComponent('수율'));
    expect(g.body.groups).toEqual([{ code: m.code, title: '수율 개선 TF' }]);
    expect(g.body.decisions).toHaveLength(1);
    expect((await get(me, '/search?q=%20')).body).toEqual({ groups: [], messages: [], decisions: [], todos: [], files: [], events: [] });
    const under = await get(me, '/search?q=' + encodeURIComponent('_'));
    expect(under.body.messages).toEqual([]); // '_' 도 와일드카드가 아니라 문자
  }, 20_000);
});

describe('/overview · /recent-decisions', () => {
  it('overview — 그룹 수·미완료/기한 지난 할 일·안읽음 합계(DM+채팅)·확인 대기·이번 주 결정·다음 회의', async () => {
    const me = await register(app, 'ag4_me');
    const b = await register(app, 'ag4_b');
    const m = await createMeeting(app, me, 'ag4 그룹');
    await joinMeeting(app, b, m.code);
    const soon = new Date(Date.now() + 3 * 3600_000);
    const later = new Date(Date.now() + 48 * 3600_000);
    await createMeeting(app, me, '먼 회의', { starts_at: localIso(later) });
    await createMeeting(app, me, '가까운 회의', { starts_at: localIso(soon) });
    db.prepare("INSERT INTO todos (user_id, title, due_at) VALUES (?, '지남', ?)").run(me.id, localIso(new Date(Date.now() - 3600_000)));
    db.prepare("INSERT INTO todos (user_id, title, due_at) VALUES (?, '아직', ?)").run(me.id, localIso(new Date(Date.now() + 5 * 3600_000)));
    db.prepare("INSERT INTO todos (user_id, title) VALUES (?, '기한 없음')").run(me.id);
    db.prepare("INSERT INTO todos (user_id, title, done) VALUES (?, '완료', 1)").run(me.id);
    const recapId = insertRecap(m.id, ['이번 주 1', '이번 주 2']);
    ackDecision(recapId, 0, me.id);
    insertRecap(m.id, ['지난주 결정'], { createdAt: new Date(Date.now() - 8 * 864e5).toISOString().replace('T', ' ').slice(0, 19) });
    say(m.id, b.id, '안 읽은 채팅 1');
    say(m.id, b.id, '안 읽은 채팅 2');
    say(m.id, me.id, '내 채팅은 안 셈');
    db.prepare('INSERT INTO dm_messages (org_id, from_id, to_id, text) VALUES (NULL, ?, ?, ?)').run(b.id, me.id, 'dm');

    const r = await get(me, '/overview');
    expect(r.body).toEqual({
      avatar: '🐧',
      meetingCount: 3,
      todoUndone: 3,
      todoOverdue: 1,
      unreadTotal: 3,
      pendingAcks: 2, // 결정 3개 중 1개 확인
      weekDecisions: 2,
      liveCalls: [],
      recentMeetings: expect.arrayContaining([{ title: 'ag4 그룹', code: m.code, inCall: 0 }]),
      nextMeeting: { title: '가까운 회의', code: expect.any(String), startsAt: localIso(soon) },
    });
    // 채팅 읽음 처리하면 unreadTotal 이 DM 1 만 남는다
    await request(app).post(`/api/meetings/${m.code}/messages/read`).set(auth(me));
    expect((await get(me, '/overview')).body.unreadTotal).toBe(1);
    expect((await get(b, '/overview')).body).toMatchObject({ meetingCount: 1, todoUndone: 0, pendingAcks: 3, unreadTotal: 1 }); // b 는 me 의 채팅 1건이 안읽음
  }, 20_000);

  it('recent-decisions — 철회 제외, 최신순, 확인 N/M·mine, limit 1~20 클램프', async () => {
    const me = await register(app, 'ag5_me');
    const b = await register(app, 'ag5_b');
    const m = await createMeeting(app, me, 'ag5 그룹');
    await joinMeeting(app, b, m.code);
    const r1 = insertRecap(m.id, ['첫 결정', '철회될 결정'], { whys: ['배경 1', ''], createdAt: '2026-08-01 10:00:00' });
    db.prepare('UPDATE meeting_recaps SET criticals = ? WHERE id = ?').run('[true,false]', r1);
    ackDecision(r1, 0, b.id);
    withdrawDecision(r1, 1, me.id, '취소');
    const r2 = insertRecap(m.id, ['둘째 결정'], { createdAt: '2026-08-02 10:00:00' });
    ackDecision(r2, 0, me.id);
    const r = await get(me, '/recent-decisions');
    expect(r.body.items).toEqual([
      { recapId: r2, idx: 0, decision: '둘째 결정', why: '', critical: false, code: m.code, title: 'ag5 그룹', ts: Date.parse('2026-08-02T10:00:00Z'), acked: 1, total: 2, mine: true },
      { recapId: r1, idx: 0, decision: '첫 결정', why: '배경 1', critical: true, code: m.code, title: 'ag5 그룹', ts: Date.parse('2026-08-01T10:00:00Z'), acked: 1, total: 2, mine: false },
    ]);
    expect((await get(me, '/recent-decisions?limit=1')).body.items.map((i: { decision: string }) => i.decision)).toEqual(['둘째 결정']);
    for (let i = 0; i < 25; i++) insertRecap(m.id, [`많은 결정 ${i}`], { createdAt: `2026-08-${pad(3 + Math.floor(i / 10))} ${pad(i % 24)}:00:00` });
    expect((await get(me, '/recent-decisions?limit=99')).body.items).toHaveLength(20);
    expect((await get(me, '/recent-decisions?limit=0')).body.items).toHaveLength(5);
    expect((await get(me, '/recent-decisions?limit=abc')).body.items).toHaveLength(5);
  }, 20_000);
});

describe('briefGrounded — nowbar 환각 게이트', () => {
  it('숫자·인용 제목이 사실에 없으면 false, 바이그램 포함률 0.35 경계, 사실이 없으면 항상 true', () => {
    expect(briefGrounded('아무 말이나', [])).toBe(true);
    const facts = ['예정된 회의가 없다', '미완료 할 일이 1개 있다'];
    expect(briefGrounded('미완료 할 일 3개부터 정리해요', facts)).toBe(false); // 3 은 사실에 없음
    expect(briefGrounded('미완료 할 일 1개부터 정리해요', facts)).toBe(true);
    expect(briefGrounded('"주간 회의"가 곧 시작해요', ['"주간 회의" 회의가 20분 뒤에 시작한다'])).toBe(true);
    expect(briefGrounded('다음 회의는 "주간 안전 회의"이다', ['다음 회의는 "월간 품질 회의"(9/3)이다'])).toBe(false); // 바이그램은 겹치지만 인용 제목이 없다
    expect(briefGrounded('"안전"', ['"안전 회의"가 진행 중이다'])).toBe(true); // 부분 문자열 인용 허용
    // 바이그램 포함률 — 정확히 0.35 (7/20) 는 통과, 0.30 (6/20) 은 탈락
    const fact = 'abcdefghijklmnopqrstu';
    expect(briefGrounded('abcdefgh' + 'zyxwvutsrqpon', [fact])).toBe(true);
    expect(briefGrounded('abcdefg' + 'zyxwvutsrqponm', [fact])).toBe(false);
    expect(briefGrounded('완전히 다른 문장이에요', facts)).toBe(false);
    expect(briefGrounded('.', facts)).toBe(false); // 정규화 후 빈 문장
  }, 20_000);

  it('aiDecision — 근거 없는 brief 는 규칙 폴백(source rule), 근거 있으면 ai; 진행 중 회의가 있으면 카드 2 유지', async () => {
    const u1 = await register(app, 'ag6_a');
    queueJson({ brief: '"없는 회의"가 5분 뒤에 시작해요', card: 0, reason: '곧 시작' });
    const r1 = await generateBrief(u1.id);
    expect(r1).toEqual({ text: '오늘 할 일과 회의가 모두 정리됐어요', source: 'rule', card: 0, reason: '다가오는 일정을 보여드려요' });
    expect(captured).toHaveLength(1);
    const u2 = await register(app, 'ag6_b');
    const now = new Date();
    await createMeeting(app, u2, '진행 중 회의', { starts_at: localIso(new Date(now.getTime() - 10 * 60_000)), ends_at: localIso(new Date(now.getTime() + 50 * 60_000)) });
    queueJson({ brief: '"진행 중 회의" 회의가 지금 진행 중이에요', card: 2, reason: '진행 중' });
    const r2 = await generateBrief(u2.id);
    expect(r2).toEqual({ text: '"진행 중 회의" 회의가 지금 진행 중이에요', source: 'ai', card: 2, reason: '진행 중' });
  }, 20_000);

  it('규칙 카드 — 진행 중 2 › 30분 내 시작 0 › 마감 임박 1 › 오늘 회의 0 › 남은 할 일 1 › 기본 0 (AI 실패 폴백 문구 포함)', async () => {
    const now = new Date();
    const mk = async (name: string, seed: (u: User) => Promise<void> | void) => {
      const u = await register(app, name);
      await seed(u);
      setNextResponses(new Error('503'));
      return generateBrief(u.id);
    };
    expect(await mk('ag7_ongoing', async (u) => {
      await createMeeting(app, u, '진행중', { starts_at: localIso(new Date(now.getTime() - 5 * 60_000)), ends_at: localIso(new Date(now.getTime() + 30 * 60_000)) });
      db.prepare("INSERT INTO todos (user_id, title) VALUES (?, '남은 일')").run(u.id);
    })).toEqual({ text: '회의 진행 중 — 미완료 할 일 1개가 기다리고 있어요', source: 'rule', card: 2, reason: '회의가 진행 중이에요' });
    const soon = await mk('ag7_soon', async (u) => {
      await createMeeting(app, u, '곧', { starts_at: localIso(new Date(now.getTime() + 20.5 * 60_000)) });
    });
    expect(soon).toMatchObject({ source: 'rule', card: 0, reason: '곧 시작하는 회의가 있어요' });
    expect(soon.text).toMatch(/^"곧" (19|20)분 전 — 준비 완료 상태예요$/); // 느린 CI 에서 분 반올림 편차 허용
    expect(await mk('ag7_due', async (u) => {
      await createMeeting(app, u, '이틀 뒤', { starts_at: localIso(new Date(now.getTime() + 48 * 3600_000)) });
      db.prepare("INSERT INTO todos (user_id, title, due_at) VALUES (?, '임박', ?)").run(u.id, localIso(new Date(now.getTime() + 2 * 3600_000)));
    })).toMatchObject({ source: 'rule', card: 1, reason: '마감이 가까운 할 일이 있어요' });
    const sameDay = new Date(now.getTime() + 120.5 * 60_000);
    if (sameDay.toDateString() === now.toDateString()) {
      expect(await mk('ag7_today', async (u) => {
        await createMeeting(app, u, '오늘 늦게', { starts_at: localIso(sameDay) });
      })).toEqual({ text: '오늘 할 일과 회의가 모두 정리됐어요', source: 'rule', card: 0, reason: '오늘 예정된 회의가 있어요' }); // 60분 넘게 남으면 브리핑엔 안 뜬다
    }
    expect(await mk('ag7_pending', (u) => {
      db.prepare("INSERT INTO todos (user_id, title) VALUES (?, '언젠가')").run(u.id);
    })).toEqual({ text: '예정된 회의 없음 — 할 일 1개에 집중할 시간이에요', source: 'rule', card: 1, reason: '할 일이 남아 있어요' });
    expect(await mk('ag7_empty', () => {})).toEqual({ text: '오늘 할 일과 회의가 모두 정리됐어요', source: 'rule', card: 0, reason: '다가오는 일정을 보여드려요' });
    // 캐시는 2분 — invalidateBrief 후 재계산되고, 데이터가 바뀌면 카드도 바뀐다
    const u = await register(app, 'ag7_cache');
    setNextResponses(new Error('x'));
    expect((await generateBrief(u.id)).card).toBe(0);
    db.prepare("INSERT INTO todos (user_id, title, due_at) VALUES (?, '새 마감', ?)").run(u.id, localIso(new Date(now.getTime() + 3600_000)));
    setNextResponses(new Error('x'));
    expect((await generateBrief(u.id)).card).toBe(0); // 아직 캐시
    invalidateBrief(u.id);
    setNextResponses(new Error('x'));
    expect((await generateBrief(u.id)).card).toBe(1);
  }, 20_000);
});
