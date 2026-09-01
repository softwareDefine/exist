import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * dm.ts — 1:1 다이렉트 메시지. 스코프(개인/조직) 격리, 상대 목록·검색·안읽음·읽음 처리,
 * 전송 검증·알림·소켓 푸시, exist AI 1:1 답장(비동기). OpenAI 는 모의.
 * (뮤테이션 점수 1% — 이전엔 route-sweep 만 지나갔다)
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { initNotifier } from '../notify.js';
import { ensureAgentUser, AGENT_NAME, AGENT_AVATAR } from '../steward.js';
import { register, auth, createOrg, joinOrg, createMeeting, insertRecap, notifications, fakeIo, type User } from './helpers/fixtures.js';
import { queueJson, resetOpenAiMock, captured, userPayload, waitFor } from './helpers/openaiMock.js';

const app = createApp();
beforeEach(() => resetOpenAiMock());

const threads = (u: User, scope: string | number) => request(app).get(`/api/dm/${scope}/threads`).set(auth(u));
const send = (u: User, scope: string | number, peer: number, text: unknown) => request(app).post(`/api/dm/${scope}/with/${peer}`).set(auth(u)).send({ text });
const history = (u: User, scope: string | number, peer: number | string) => request(app).get(`/api/dm/${scope}/with/${peer}`).set(auth(u));
const unread = (u: User, scope: string | number) => request(app).get(`/api/dm/${scope}/unread`).set(auth(u));
type Thread = { userId: number; username: string; position: string | null; lastText: string | null; lastMine: boolean; unread: number; lastTs: number | null };

describe('개인 스코프', () => {
  it('상대 목록은 대화한 사람 + AI 항목, 전송·안읽음·읽음 처리·히스토리 순서', async () => {
    const a = await register(app, 'dm_a');
    const b = await register(app, 'dm_b');
    const c = await register(app, 'dm_c');
    const agentId = ensureAgentUser();
    const io = fakeIo([a.id, b.id]);
    initNotifier(io.io as never);

    // 아무 대화 없을 때 — AI 만 (직위 'AI 총무'), unread 0
    const empty = (await threads(a, 'personal')).body as Thread[];
    expect(empty.map((t) => t.userId)).toEqual([agentId]);
    expect(empty[0]).toMatchObject({ username: AGENT_NAME, position: 'AI 총무', lastText: null, unread: 0 });
    expect((await unread(a, 'personal')).body).toEqual({ unread: 0 });

    const m1 = await send(a, 'personal', b.id, '  첫 메시지  ');
    expect(m1.status).toBe(200);
    expect(m1.body).toEqual({ id: expect.any(Number), orgId: null, fromId: a.id, toId: b.id, from: 'dm_a', avatar: '🐧', text: '첫 메시지', ts: expect.any(Number) });
    expect(db.prepare('SELECT org_id, from_id, to_id, text, read FROM dm_messages WHERE id = ?').get(m1.body.id)).toEqual({ org_id: null, from_id: a.id, to_id: b.id, text: '첫 메시지', read: 0 });
    // 양쪽 소켓 모두 dm:message
    expect(io.of(b.id, 'dm:message').map((e) => e.payload)).toEqual([m1.body]);
    expect(io.of(a.id, 'dm:message').map((e) => e.payload)).toEqual([m1.body]);
    // 받는 사람 알림 (kind dm) — 보낸 사람은 없음
    expect(notifications(b.id)).toEqual([{ from_name: 'dm_a', text: '첫 메시지', kind: 'dm', meeting_code: null }]);
    expect(notifications(a.id)).toEqual([]);
    await send(b, 'personal', a.id, '답장');
    await send(a, 'personal', b.id, '두 번째');

    const forA = (await threads(a, 'personal')).body as Thread[];
    expect(forA.map((t) => t.userId)).toEqual([b.id, agentId]); // 대화 있는 상대가 AI 보다 앞(최근순)
    expect(forA[0]).toMatchObject({ username: 'dm_b', lastText: '두 번째', lastMine: true, unread: 1 });
    const forB = (await threads(b, 'personal')).body as Thread[];
    expect(forB[0]).toMatchObject({ username: 'dm_a', lastText: '두 번째', lastMine: false, unread: 2 });
    expect((await unread(b, 'personal')).body).toEqual({ unread: 2 });
    expect((await unread(a, 'personal')).body).toEqual({ unread: 1 });
    expect(((await threads(c, 'personal')).body as Thread[]).map((t) => t.userId)).toEqual([agentId]); // 제3자는 남의 대화를 못 본다

    // 히스토리 — 시간순, mine 플래그, 읽음 처리 "전" 상태(unread)를 실어주고 DB 는 읽음으로
    const h = await history(b, 'personal', a.id);
    expect(h.body.map((m: { text: string; mine: boolean; unread?: boolean; from: string }) => [m.text, m.mine, m.unread ?? null, m.from])).toEqual([
      ['첫 메시지', false, true, 'dm_a'],
      ['답장', true, null, 'dm_b'],
      ['두 번째', false, true, 'dm_a'],
    ]);
    expect((await unread(b, 'personal')).body).toEqual({ unread: 0 });
    expect((await unread(a, 'personal')).body).toEqual({ unread: 1 }); // a 쪽 안읽음은 그대로
    expect(((await history(b, 'personal', a.id)).body as { unread?: boolean }[]).every((m) => m.unread === undefined)).toBe(true);
    // 명시 읽음 처리
    expect((await request(app).post(`/api/dm/personal/with/${b.id}/read`).set(auth(a))).body).toEqual({ ok: true });
    expect((await unread(a, 'personal')).body).toEqual({ unread: 0 });
    expect(((await threads(a, 'personal')).body as Thread[])[0].unread).toBe(0);
  }, 20_000);

  it('전송 검증 — 본인 400, 없는 상대 404, 비정수 400, 빈 텍스트 400, 2000자 절단, 80자 넘는 알림은 줄임표', async () => {
    const a = await register(app, 'dm_v1');
    const b = await register(app, 'dm_v2');
    expect((await send(a, 'personal', a.id, '나에게')).body).toEqual({ error: '잘못된 상대입니다' });
    expect((await send(a, 'personal', 999999, 'x')).body).toEqual({ error: '상대를 찾을 수 없어요' });
    expect((await request(app).post('/api/dm/personal/with/abc').set(auth(a)).send({ text: 'x' })).body).toEqual({ error: '잘못된 상대입니다' });
    expect((await send(a, 'personal', b.id, '   ')).body).toEqual({ error: '메시지를 입력하세요' });
    expect((await request(app).post(`/api/dm/personal/with/${b.id}`).set(auth(a)).send({})).status).toBe(400);
    expect((await request(app).get('/api/dm/abc/threads').set(auth(a))).body).toEqual({ error: '잘못된 조직입니다' });
    expect((await history(a, 'personal', 'abc')).body).toEqual({ error: '잘못된 상대입니다' });
    expect((await history(a, 'personal', 999999)).body).toEqual({ error: '상대를 찾을 수 없어요' });
    expect((await request(app).post('/api/dm/personal/with/abc/read').set(auth(a))).status).toBe(400);
    const long = await send(a, 'personal', b.id, 'x'.repeat(2500));
    expect(long.body.text).toHaveLength(2000);
    const n = notifications(b.id);
    expect(n).toHaveLength(1);
    expect(n[0].text).toBe('x'.repeat(80) + '…');
    expect(n[0].text).toHaveLength(81);
    const exact = await send(a, 'personal', b.id, 'y'.repeat(80));
    expect(exact.status).toBe(200);
    expect(notifications(b.id)[1].text).toBe('y'.repeat(80)); // 80자는 그대로
    expect(db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE from_id = ? AND to_id = ?').get(a.id, b.id)).toEqual({ n: 2 });
  }, 20_000);

  it('검색 — 개인 스코프는 전체 사용자(본인 제외), 정확 일치 → 접두 → 부분 순, 빈 q 는 []', async () => {
    const me = await register(app, 'dmq_me');
    await register(app, 'dmq');
    await register(app, 'dmq_x');
    await register(app, 'xdmq');
    const r = await request(app).get('/api/dm/personal/search?q=dmq').set(auth(me));
    expect(r.body.map((u: { username: string }) => u.username)).toEqual(['dmq', 'dmq_x', 'xdmq']);
    expect(r.body[0]).toEqual({ userId: expect.any(Number), username: 'dmq', avatar: '🐧' });
    expect((await request(app).get('/api/dm/personal/search?q=%20').set(auth(me))).body).toEqual([]);
    expect((await request(app).get('/api/dm/personal/search').set(auth(me))).body).toEqual([]);
  }, 20_000);
});

describe('조직 스코프', () => {
  it('멤버 전원이 상대 목록, 비멤버 403, 조직 밖 상대 404, 개인 스코프와 대화가 섞이지 않는다', async () => {
    const owner = await register(app, 'dmo_owner');
    const member = await register(app, 'dmo_member');
    const other = await register(app, 'dmo_other');
    const stranger = await register(app, 'dmo_stranger');
    const org = await createOrg(app, owner, 'DM 조직');
    await joinOrg(app, org, owner, member, { position: '대리', department: '생산1팀' });
    await joinOrg(app, org, owner, other);
    const agentId = ensureAgentUser();

    for (const path of ['threads', 'search?q=dmo', 'unread', `with/${owner.id}`]) {
      const r = await request(app).get(`/api/dm/${org.id}/${path}`).set(auth(stranger));
      expect(r.status, path).toBe(403);
      expect(r.body, path).toEqual({ error: '이 조직의 멤버가 아니에요' });
    }
    expect((await send(stranger, org.id, owner.id, 'x')).status).toBe(403);
    expect((await send(member, org.id, stranger.id, '조직 밖 사람')).body).toEqual({ error: '상대를 찾을 수 없어요' });
    expect((await history(member, org.id, stranger.id)).status).toBe(404);
    expect((await request(app).get('/api/dm/999999/threads').set(auth(member))).status).toBe(403);

    const list = (await threads(member, org.id)).body as Thread[];
    expect(list.map((t) => t.userId)).toEqual([other.id, owner.id, agentId]); // 대화 없으면 이름순(ko) — 본인 제외, AI 항목 포함
    expect(list.find((t) => t.userId === owner.id)).toMatchObject({ username: 'dmo_owner', position: null, lastText: null, unread: 0 });

    const m = await send(member, org.id, owner.id, '조직 스코프 메시지');
    expect(m.body).toMatchObject({ orgId: org.id, fromId: member.id, toId: owner.id });
    expect(db.prepare('SELECT org_id FROM dm_messages WHERE id = ?').get(m.body.id)).toEqual({ org_id: org.id });
    // 조직 목록엔 반영, 개인 목록·개인 히스토리에는 없다
    const orgList = (await threads(owner, org.id)).body as Thread[];
    expect(orgList[0]).toMatchObject({ userId: member.id, lastText: '조직 스코프 메시지', unread: 1, position: '대리' });
    expect(((await threads(owner, 'personal')).body as Thread[]).map((t) => t.userId)).toEqual([agentId]);
    expect((await history(owner, 'personal', member.id)).body).toEqual([]);
    expect((await unread(owner, 'personal')).body).toEqual({ unread: 0 });
    expect((await unread(owner, org.id)).body).toEqual({ unread: 1 });
    expect((await history(owner, org.id, member.id)).body).toHaveLength(1);
    expect((await unread(owner, org.id)).body).toEqual({ unread: 0 });
    // 조직 검색은 활성 멤버만 (stranger 제외, 본인 제외)
    const s = await request(app).get(`/api/dm/${org.id}/search?q=dmo`).set(auth(member));
    expect(s.body.map((u: { username: string }) => u.username)).toEqual(['dmo_other', 'dmo_owner']);
    expect((await request(app).get(`/api/dm/${org.id}/search?q=`).set(auth(member))).body).toEqual([]);
  }, 20_000);
});

describe('exist AI 1:1 질의', () => {
  it('AI 에게 보내면 알림 없이 저장되고, 스코프 기록을 근거로 답장이 비동기로 들어온다 (조직 스코프에서도 멤버 검사 예외)', async () => {
    const owner = await register(app, 'dmai_owner');
    const org = await createOrg(app, owner, 'AI 조직');
    const m = await createMeeting(app, owner, 'AI 조직 그룹', { org_id: org.id });
    insertRecap(m.id, ['방열판 검사 온도 65도로 상향'], { whys: ['편차가 컸음'] });
    const personalMeeting = await createMeeting(app, owner, '개인 그룹');
    insertRecap(personalMeeting.id, ['개인 결정 — 데모 영상 촬영지 확정']);
    const agentId = ensureAgentUser();
    const io = fakeIo([owner.id]);
    initNotifier(io.io as never);

    queueJson({ answer: '방열판 검사 온도는 65도예요.' });
    const r = await send(owner, org.id, agentId, '방열판 온도 기준이 뭐였지?');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ orgId: org.id, fromId: owner.id, toId: agentId, text: '방열판 온도 기준이 뭐였지?' });
    await waitFor(() => db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE from_id = ?').get(agentId) !== undefined && (db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE from_id = ? AND to_id = ?').get(agentId, owner.id) as { n: number }).n === 1, 3000);
    const reply = db.prepare('SELECT org_id, text FROM dm_messages WHERE from_id = ? AND to_id = ?').get(agentId, owner.id);
    expect(reply).toEqual({ org_id: org.id, text: '방열판 검사 온도는 65도예요.' });
    // 근거 = 조직 스코프 그룹의 결정만 ([그룹명] 접두), 개인 그룹 결정은 제외
    const p = userPayload<{ records: { decisions: string[] } }>(captured[captured.length - 1]);
    expect(p.records.decisions).toEqual(['[AI 조직 그룹] 방열판 검사 온도 65도로 상향 (배경: 편차가 컸음)']);
    // AI 답장은 소켓으로 나에게, 알림함엔 아무것도 안 쌓인다 (AI 상대 → 알림 생략)
    const pushed = io.of(owner.id, 'dm:message').map((e) => e.payload as { fromId: number; from: string; avatar: string; text: string });
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toMatchObject({ fromId: agentId, from: AGENT_NAME, avatar: AGENT_AVATAR, text: '방열판 검사 온도는 65도예요.' });
    expect(notifications(agentId)).toEqual([]);
    expect(notifications(owner.id)).toEqual([]);
    // 조직 스코프 히스토리에 두 줄, 개인 스코프엔 없음
    expect((await history(owner, org.id, agentId)).body.map((x: { text: string }) => x.text)).toEqual(['방열판 온도 기준이 뭐였지?', '방열판 검사 온도는 65도예요.']);
    expect((await history(owner, 'personal', agentId)).body).toEqual([]);
    // 개인 스코프 질의는 개인 그룹만 근거
    queueJson({ answer: '데모 촬영지가 확정됐어요.' });
    await send(owner, 'personal', agentId, '개인 결정 뭐 있어?');
    await waitFor(() => (db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE from_id = ? AND org_id IS NULL').get(agentId) as { n: number }).n === 1, 3000);
    const p2 = userPayload<{ records: { decisions: string[] } }>(captured[captured.length - 1]);
    expect(p2.records.decisions).toEqual(['[개인 그룹] 개인 결정 — 데모 영상 촬영지 확정']);
  }, 20_000);
});
