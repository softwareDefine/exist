import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * agent.ts 생존 변이 사냥 — 라이브 통화 분기(getRoomSize 모의), aiDecision 카드 보정,
 * briefGrounded 숫자 우회 차단, getCatchup 7일 바닥·집계 문구, buildDailyFacts/ruleBasedDaily,
 * /brief /daily 라우트, /actions·/pending-decisions·/search 상한, /sent 정렬, /overview 세부.
 */
const h = vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  return { roomSizes: new Map<string, number>() };
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));
vi.mock('../sfu.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../sfu.js')>();
  return { ...mod, getRoomSize: (code: string) => h.roomSizes.get(code) ?? 0 };
});

import { createApp } from '../app.js';
import db from '../db.js';
import { generateBrief, getCatchup, getDailyBrief, invalidateBrief, briefGrounded } from '../agent.js';
import { withdrawDecision, ackDecision } from '../recap.js';
import { register, auth, createMeeting, joinMeeting, insertRecap, type User } from './helpers/fixtures.js';
import { captured, queueJson, setNextResponses, resetOpenAiMock, userPayload, systemPrompt } from './helpers/openaiMock.js';

const app = createApp();
beforeEach(() => {
  resetOpenAiMock();
  h.roomSizes.clear();
});

const pad = (n: number) => String(n).padStart(2, '0');
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const get = (u: User, path: string) => request(app).get(`/api/agent${path}`).set(auth(u));
const say = (meetingId: number, uid: number, text: string) =>
  db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(meetingId, uid, text);
const agoStr = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace('T', ' ').slice(0, 19);

describe('라이브 통화 분기 — 규칙 브리핑·사실 문장·liveSig 캐시', () => {
  it('통화 인원 많은 그룹 우선, 인원이 바뀌면 캐시를 무시하고 재계산', async () => {
    const u = await register(app, 'as1');
    const m1 = await createMeeting(app, u, '알파 그룹');
    const m2 = await createMeeting(app, u, '베타 그룹');
    h.roomSizes.set(m1.code, 1);
    h.roomSizes.set(m2.code, 3);
    setNextResponses(new Error('down'));
    const r = await generateBrief(u.id);
    expect(r).toEqual({ text: '지금 "베타 그룹"에서 3명이 통화 중이에요', source: 'rule', card: 0, reason: '다가오는 일정을 보여드려요' });
    expect(userPayload<{ facts: string[] }>(captured[0]).facts[0]).toBe('지금 "베타 그룹"에서 3명이 통화 중이다');
    h.roomSizes.set(m1.code, 5);
    setNextResponses(new Error('down'));
    expect((await generateBrief(u.id)).text).toBe('지금 "알파 그룹"에서 5명이 통화 중이에요');
    expect(captured).toHaveLength(2); // liveSig 변화 → 캐시 미적중
  }, 20_000);

  it('진행 중 회의 + 할 일 전부 완료 문구', async () => {
    const u = await register(app, 'as2');
    const now = new Date();
    await createMeeting(app, u, '진행회의', { starts_at: localIso(new Date(now.getTime() - 10 * 60_000)), ends_at: localIso(new Date(now.getTime() + 30 * 60_000)) });
    setNextResponses(new Error('x'));
    expect((await generateBrief(u.id)).text).toBe('회의 진행 중 — 할 일은 모두 완료된 상태예요');
    expect(userPayload<{ facts: string[] }>(captured[0]).facts).toEqual(['"진행회의" 회의가 지금 진행 중이다', '할 일은 모두 완료됐다']);
  }, 20_000);
});

describe('aiDecision — 카드 검증·보정·reason 폴백', () => {
  it('이상한 카드는 0으로, 진행 중이 아니어도 2가 아니면 재작성하지 않고, 빈 reason 은 규칙 이유', async () => {
    const u = await register(app, 'as3');
    db.prepare("INSERT INTO todos (user_id, title, due_at) VALUES (?, '임박', ?)").run(u.id, localIso(new Date(Date.now() + 2 * 3600_000)));
    queueJson({ brief: '  24시간 내 마감 할 일 "임박"부터 처리해요  ', card: 7, reason: '' });
    const r = await generateBrief(u.id);
    // card 7 → 0 (규칙 카드 1로 재작성되지 않는다 — 2가 아니므로), brief 는 트림, reason 은 규칙 폴백
    expect(r).toEqual({ text: '24시간 내 마감 할 일 "임박"부터 처리해요', source: 'ai', card: 0, reason: '마감이 가까운 할 일이 있어요' });
    for (const frag of [
      '너는 분산 근무 플랫폼 exist의 AI 총무로, 상단 상태바(nowbar)를 관리한다',
      '아래 "사실 문장" 목록에서 가장 시급한 것 하나를 골라',
      '절대 규칙: 목록에 있는 사실만 쓴다. 새 사실·시각·수치를 만들지 않는다',
      '카드: 0 = 일정, 1 = 할 일, 2 = 진행 타임라인',
      '통화 중·진행 중 회의 사실이 있으면 2',
      '"진행 중" 사실이 없으면 절대 2를 고르지 않는다',
      '응답은 오직 JSON: {"brief": string, "card": 0|1|2, "reason": string}',
      'brief는 한국어 50자 이내(인사말·이모지 없이)',
      'reason은 카드 선택 이유 20자 이내',
      'reason도 사실 문장에 있는 표현만 사용한다',
    ]) {
      expect(systemPrompt(captured[0]), frag).toContain(frag);
    }
    expect(userPayload<{ facts: string[] }>(captured[0]).facts).toEqual(['예정된 회의가 없다', '24시간 내 마감 할 일: "임박"']);
    invalidateBrief(u.id);
    queueJson({ brief: '24시간 내 마감 할 일 "임박"부터 처리해요', card: 1, reason: '마감 임박' });
    expect(await generateBrief(u.id)).toMatchObject({ card: 1, reason: '마감 임박' });
  }, 20_000);

  it('briefGrounded — 사실 문장 경계를 넘는 숫자 조합 차단', () => {
    expect(briefGrounded('할 일이 12개 있어요', ['할 일이 1개 있다', '회의가 2건 있다'])).toBe(false);
    expect(briefGrounded('미완료 할 일 21개', ['미완료 할 일이 12개 있다'])).toBe(false);
  });
});

describe('getCatchup — 창·항목 문구·집계', () => {
  it('없는 사용자는 빈 결과', async () => {
    expect(await getCatchup(999999)).toEqual({ since: null, headline: '', source: 'rule', items: [], unreadTotal: 0 });
  });

  it('7일 바닥·항목별 문구·4종 집계 헤드라인·unreadTotal', async () => {
    const u = await register(app, 'as4');
    const peer = await register(app, 'as4b');
    const peer2 = await register(app, 'as4c');
    const ms: { code: string; id: number }[] = [];
    for (let i = 1; i <= 4; i++) {
      const m = await createMeeting(app, peer, `as4 채팅 ${i}`);
      await joinMeeting(app, u, m.code);
      ms.push(m);
    }
    // 마지막 접속 8일 전 → 창은 7일 바닥
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(agoStr(8 * 24 * 60), u.id);
    insertRecap(ms[0].id, ['옛 결정'], { attendees: ['nobody'], createdAt: agoStr(8 * 24 * 60), summary: '8일 전 요약' });
    insertRecap(ms[0].id, ['a', 'b'], { attendees: ['nobody'], summary: '라인 점검 확정' });
    const todoId = db.prepare('INSERT INTO todos (user_id, meeting_id, title) VALUES (?, ?, ?)').run(u.id, ms[0].id, '리허설 준비').lastInsertRowid as number;
    db.prepare('INSERT INTO todo_assignees (todo_id, user_id) VALUES (?, ?)').run(todoId, u.id);
    const dm = db.prepare('INSERT INTO dm_messages (org_id, from_id, to_id, text, read) VALUES (NULL, ?, ?, ?, 0)');
    dm.run(peer2.id, u.id, '먼저');
    dm.run(peer.id, u.id, '중간');
    dm.run(peer.id, u.id, '마지막');
    const unread = [3, 2, 1, 1];
    ms.forEach((m, i) => {
      for (let k = 0; k < unread[i]; k++) say(m.id, peer.id, `메시지 ${i}-${k}`);
    });

    setNextResponses(new Error('headline down'));
    const c = await getCatchup(u.id);
    expect(c.source).toBe('rule');
    // 헤드라인 프롬프트 — 실패했어도 요청 자체는 캡처된다
    for (const frag of [
      '너는 분산 근무 플랫폼 exist의 AI 운영자다',
      '사용자가 자리를 비운 사이 놓친 것들의 목록을 받아',
      '한 줄 헤드라인(한국어 60자 이내, 가장 중요한 것 하나를 짚어서)',
      '문체는 반드시 "~요"로 끝나는 해요체',
      '목록에 없는 사실은 만들지 않는다. 응답은 JSON: {"headline": string}',
    ]) {
      expect(systemPrompt(captured[0]), frag).toContain(frag);
    }
    expect(c.headline).toBe('자리 비운 사이 놓친 통화 1건 · 새 할 일 1개 · 안 읽은 DM 3개 · 안 읽은 그룹 채팅 4곳 있어요');
    expect(c.unreadTotal).toBe(7 + 3);
    const recaps = c.items.filter((i) => i.type === 'recap');
    expect(recaps).toEqual([
      { type: 'recap', text: '놓친 통화 정리 — 라인 점검 확정 (결정 2건)', meeting: { code: ms[0].code, title: 'as4 채팅 1' } },
    ]); // 8일 전 recap 은 창 밖
    expect(c.items.filter((i) => i.type === 'todo')).toEqual([
      { type: 'todo', text: '새 할 일 — 리허설 준비', meeting: { code: ms[0].code, title: 'as4 채팅 1' } },
    ]);
    expect(c.items.filter((i) => i.type === 'dm')).toEqual([{ type: 'dm', text: '안 읽은 DM 3개 — 최근: as4b' }]);
    const chats = c.items.filter((i) => i.type === 'chat');
    expect(chats).toHaveLength(3); // 상위 3곳만 항목으로
    expect(chats[0]).toEqual({ type: 'chat', text: '안 읽은 메시지 3개', meeting: { code: ms[0].code, title: 'as4 채팅 1' } });
  }, 20_000);
});

describe('getDailyBrief — 사실 문장 구성과 규칙 문단', () => {
  it('오늘 일정·라이브·놓친 것·총계·서명 대기·미완료 목록이 그대로 사실 문장이 된다', async () => {
    const u = await register(app, 'as5');
    const peer = await register(app, 'as5b');
    const m = await createMeeting(app, peer, 'as5 본진');
    await joinMeeting(app, u, m.code);
    const start = new Date(Date.now() + 2 * 60_000);
    await createMeeting(app, u, '아침 회의', { starts_at: localIso(start) });
    const live = await createMeeting(app, u, '라이브 그룹');
    h.roomSizes.set(live.code, 2);
    insertRecap(m.id, ['결정'], { attendees: ['x'], summary: 'S1' });
    const todoId = db.prepare('INSERT INTO todos (user_id, meeting_id, title) VALUES (?, ?, ?)').run(u.id, m.id, '새 일감').lastInsertRowid as number;
    db.prepare('INSERT INTO todo_assignees (todo_id, user_id) VALUES (?, ?)').run(todoId, u.id);
    say(m.id, peer.id, '안 읽은 채팅');
    db.prepare('INSERT INTO dm_messages (org_id, from_id, to_id, text, read) VALUES (NULL, ?, ?, ?, 0)').run(peer.id, u.id, 'dm');
    db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by, ack_required) VALUES (?, '회람 문서', 'doc', ?, 1)").run(m.id, peer.id);
    db.prepare("INSERT INTO todos (user_id, title) VALUES (?, 'a작업')").run(u.id);
    db.prepare("INSERT INTO todos (user_id, title) VALUES (?, 'b작업')").run(u.id);

    setNextResponses(new Error('headline down')); // catchup 헤드라인 AI
    queueJson({ text: '오늘 브리핑' }); // daily AI
    const d = await getDailyBrief(u.id);
    expect(d).toEqual({ text: '오늘 브리핑', source: 'ai' });
    const hh = start.getHours();
    const expected = [
      `오늘 ${hh < 12 ? '오전' : '오후'} ${hh % 12 || 12}시 "아침 회의" 일정이 있다`,
      '지금 "라이브 그룹"에서 2명이 통화 중이다',
      '자리 비운 사이: 놓친 통화 정리 — S1 (결정 1건)',
      '자리 비운 사이: 새 할 일 — 새 일감',
      '안 읽은 메시지가 총 2개 있다',
      '열람 서명을 기다리는 문서가 1건 있다',
      '미완료 할 일 3개: 새 일감, a작업, b작업',
    ];
    expect(userPayload<{ facts: string[] }>(captured[1]).facts).toEqual(expected);
    for (const frag of [
      '너는 분산 근무 플랫폼 exist의 AI 총무다',
      '"오늘 브리핑" 문단(한국어 2~3문장, 220자 이내)',
      '문체: 모든 문장은 반드시 "~요"로 끝나는 해요체. "~습니다"체 절대 금지',
      '절대 규칙: 사실은 목록에 있는 것만 쓴다. 새 사실·시각·수치·일정을 추가하지 않는다',
      '중요도 순 재배열 허용, 덜 중요한 사실은 생략 가능',
      '판단은 자유: 목록의 사실들에 근거해 "무엇부터 하면 좋을지" 우선순위 제안 한 문장은',
      '응답은 오직 JSON: {"text": string}',
    ]) {
      expect(systemPrompt(captured[1]), frag).toContain(frag);
    }

    // 규칙 문단 — "~다"를 "~어요/요."로 바꿔 이어 붙인다
    invalidateBrief(u.id);
    setNextResponses(new Error('headline down'), new Error('daily down'));
    const rule = await getDailyBrief(u.id);
    expect(rule.source).toBe('rule');
    expect(rule.text).toBe(expected.map((f) => f + '요.').join(' ').replace(/다요\./g, '어요.').slice(0, 300));

    // 아무것도 없는 사용자 — 기본 문구
    const v = await register(app, 'as5v');
    setNextResponses(new Error('daily down'));
    expect(await getDailyBrief(v.id)).toEqual({ text: '오늘은 예정된 일정이 없어요. 밀린 일을 정리하기 좋은 날이에요.', source: 'rule' });
  }, 20_000);
});

describe('/brief · /daily 라우트', () => {
  it('규칙 폴백 응답 형태 + org 파라미터 검증(400/403)', async () => {
    const u = await register(app, 'as6');
    setNextResponses(new Error('x'));
    const b = await get(u, '/brief');
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ text: '오늘 할 일과 회의가 모두 정리됐어요', source: 'rule', card: 0, reason: '다가오는 일정을 보여드려요' });
    setNextResponses(new Error('x'));
    const d = await get(u, '/daily');
    expect(d.status).toBe(200);
    expect(d.body).toEqual({ text: '오늘은 예정된 일정이 없어요. 밀린 일을 정리하기 좋은 날이에요.', source: 'rule' });
    expect((await get(u, '/brief?org=abc')).status).toBe(400);
    expect((await get(u, '/brief?org=abc')).body).toEqual({ error: '잘못된 org 값입니다' });
    expect((await get(u, '/daily?org=999999')).status).toBe(403);
    expect((await get(u, '/daily?org=999999')).body).toEqual({ error: '조직 멤버가 아닙니다' });
  }, 20_000);
});

describe('/actions — recap 내부 상한·단일 결정·회람 서명 대기', () => {
  it('한 recap 안의 결정도 10개 상한, 단일 미확인 결정은 정확히 1건', async () => {
    const u = await register(app, 'as7');
    const m = await createMeeting(app, u, 'as7 그룹');
    const recapId = insertRecap(m.id, Array.from({ length: 12 }, (_, i) => `d${i}`));
    const r = await get(u, '/actions');
    expect(r.body.decisions.map((d: { decision: string; idx: number }) => [d.idx, d.decision])).toEqual(
      Array.from({ length: 10 }, (_, i) => [i, `d${i}`]),
    );
    expect(r.body.decisions[0].recapId).toBe(recapId);

    const u2 = await register(app, 'as7b');
    const m2 = await createMeeting(app, u2, 'as7b 그룹');
    const solo = insertRecap(m2.id, ['하나뿐']);
    expect((await get(u2, '/actions')).body.decisions).toEqual([
      { recapId: solo, idx: 0, decision: '하나뿐', code: m2.code, title: 'as7b 그룹', ts: expect.any(Number) },
    ]);
  }, 20_000);

  it('회람 문서 — 미서명 7건 중 항목 5 + 총계, 서명·폴더·삭제본 제외', async () => {
    const u = await register(app, 'as7c');
    const m = await createMeeting(app, u, 'as7c 그룹');
    const mk = (name: string, type = 'doc', ack = 1, deleted = false) =>
      db.prepare(`INSERT INTO collab_files (meeting_id, name, type, created_by, ack_required, deleted_at) VALUES (?, ?, ?, ?, ?, ${deleted ? "datetime('now')" : 'NULL'})`).run(m.id, name, type, u.id, ack).lastInsertRowid as number;
    const pendings = Array.from({ length: 7 }, (_, i) => mk(`문서${i + 1}`));
    const acked = mk('서명한 문서');
    db.prepare('INSERT INTO file_acks (file_id, user_id) VALUES (?, ?)').run(acked, u.id);
    mk('회람 폴더', 'folder');
    mk('지운 문서', 'doc', 1, true);
    mk('회람 아님', 'doc', 0);
    const r = await get(u, '/actions');
    expect(r.body.pendingAcksTotal).toBe(7);
    expect(r.body.pendingAcks.map((p: { fileId: number }) => p.fileId)).toEqual(pendings.slice(2).reverse()); // 최신(id 큰) 5건
    expect(r.body.pendingAcks[0]).toEqual({ fileId: pendings[6], name: '문서7', code: m.code, title: 'as7c 그룹' });
  }, 20_000);
});

describe('/pending-decisions — 상한·철회·손상 state', () => {
  it('한 recap 안에서도 20개 상한, idx 오름차순', async () => {
    const u = await register(app, 'as8');
    const m = await createMeeting(app, u, 'as8 그룹');
    insertRecap(m.id, Array.from({ length: 22 }, (_, i) => `big${i}`));
    const r = await get(u, '/pending-decisions');
    expect(r.body.items).toHaveLength(20);
    expect(r.body.items.map((i: { idx: number }) => i.idx)).toEqual([...Array(20).keys()]);
  }, 20_000);

  it('철회된 결정은 제외, 손상된 decision_state 는 전체 노출 유지', async () => {
    const u = await register(app, 'as8b');
    const m = await createMeeting(app, u, 'as8b 그룹');
    const r1 = insertRecap(m.id, ['살아있는', '철회되는']);
    expect(withdrawDecision(r1, 1, u.id, '취소').ok).toBe(true);
    const r2 = insertRecap(m.id, ['손상 state']);
    db.prepare('UPDATE meeting_recaps SET decision_state = ? WHERE id = ?').run('broken[', r2);
    const r = await get(u, '/pending-decisions');
    expect(r.body.items.map((i: { decision: string }) => i.decision)).toEqual(['손상 state', '살아있는']);
  }, 20_000);
});

describe('/search — 대소문자·recap/인수인계 내부 상한·손상 sections', () => {
  it('소문자 질의로 대문자 본문 매칭, 한 recap 결정 5건·인수인계 항목 5건 상한', async () => {
    const u = await register(app, 'as9');
    const m = await createMeeting(app, u, 'as9 그룹');
    insertRecap(m.id, Array.from({ length: 7 }, (_, i) => `Weekly REPORT ${i + 1}`));
    db.prepare("INSERT INTO handovers (meeting_id, author_id, shift_label, sections) VALUES (?, ?, '야간조', ?)").run(
      m.id, u.id, JSON.stringify({ issues: Array.from({ length: 7 }, (_, i) => `REPORT 이슈 ${i + 1}`), broken: 'not-array' }),
    );
    db.prepare("INSERT INTO handovers (meeting_id, author_id, shift_label, sections) VALUES (?, ?, '주간조', 'bad json[')").run(m.id, u.id);
    const r = await get(u, '/search?q=' + encodeURIComponent('RePort'));
    expect(r.status).toBe(200);
    expect(r.body.decisions).toHaveLength(5);
    expect(r.body.decisions[0].text).toBe('Weekly REPORT 1');
    expect(r.body.handovers).toHaveLength(5);
    expect(r.body.handovers[0]).toMatchObject({ text: 'REPORT 이슈 1', sub: '야간조' });
  }, 20_000);
});

describe('/sent — 정렬 세부', () => {
  it('완료 뒤로(전원 확인한 critical 포함) → 도달률 낮은 순 → 같은 비율은 최신순, 8건 절단', async () => {
    const host = await register(app, 'as10');
    const m1 = await register(app, 'as10_a');
    const m2 = await register(app, 'as10_b');
    const m = await createMeeting(app, host, 'as10 그룹');
    await joinMeeting(app, m1, m.code);
    await joinMeeting(app, m2, m.code);
    const oldRecap = insertRecap(m.id, ['X 절반'], { createdAt: agoStr(120) });
    ackDecision(oldRecap, 0, m1.id);
    const newRecap = insertRecap(m.id, ['Y 절반', 'Z 다수', 'W 완료', 'V1', 'V2', 'V3', 'V4', 'V5']);
    db.prepare('UPDATE meeting_recaps SET criticals = ? WHERE id = ?').run(JSON.stringify([false, false, true, false, false, false, false, false]), newRecap);
    ackDecision(newRecap, 0, m1.id); // Y 1/3
    ackDecision(newRecap, 1, m1.id);
    ackDecision(newRecap, 1, m2.id); // Z 2/3
    for (const x of [host, m1, m2]) ackDecision(newRecap, 2, x.id); // W 3/3 — critical 이어도 완료는 뒤
    const r = await get(host, '/sent');
    expect(r.body.totalSent).toBe(9);
    // 발신자(host)는 분모에서 제외 (9/3 결함 #10b) — 대상은 m1·m2 둘. 'Z 다수'는 2/2 완료가 되어
    // 최후순 그룹으로 밀리고, 완료끼리는 critical('W 완료')이 앞이라 8건 절단엔 W 가 들어온다
    expect(r.body.entries.map((e: { decision: string }) => e.decision)).toEqual([
      'V1', 'V2', 'V3', 'V4', 'V5', // 0/2 — 같은 비율·시각은 결정 순서 유지
      'Y 절반', // 1/2, 최신
      'X 절반', // 1/2, 오래됨
      'W 완료', // 완료는 뒤 — 'Z 다수'(비 critical 완료)는 절단 밖
    ]);
  }, 20_000);
});

describe('/overview · /recent-decisions 세부', () => {
  it('overview — 지정 아바타·라이브 통화·최근 그룹 8개 절단', async () => {
    const u = await register(app, 'as11');
    db.prepare("UPDATE users SET avatar = '😀' WHERE id = ?").run(u.id);
    const codes: string[] = [];
    for (let i = 0; i < 9; i++) codes.push((await createMeeting(app, u, `as11 그룹 ${i}`)).code);
    h.roomSizes.set(codes[0], 2);
    const r = await get(u, '/overview');
    expect(r.body.avatar).toBe('😀');
    expect(r.body.meetingCount).toBe(9);
    expect(r.body.liveCalls).toEqual([{ title: 'as11 그룹 0', code: codes[0], inCall: 2 }]);
    expect(r.body.recentMeetings.map((m: { title: string }) => m.title)).toEqual(
      Array.from({ length: 8 }, (_, i) => `as11 그룹 ${i}`),
    );
  }, 20_000);

  it('recent-decisions — 회의를 넘나드는 시간 역순 병합', async () => {
    const u = await register(app, 'as12');
    const A = await createMeeting(app, u, 'as12 A');
    const B = await createMeeting(app, u, 'as12 B');
    insertRecap(A.id, ['A-옛'], { createdAt: '2026-08-25 10:00:00' });
    insertRecap(B.id, ['B-중간'], { createdAt: '2026-08-26 10:00:00' });
    insertRecap(A.id, ['A-최신'], { createdAt: '2026-08-27 10:00:00' });
    const r = await get(u, '/recent-decisions');
    expect(r.body.items.map((i: { decision: string }) => i.decision)).toEqual(['A-최신', 'B-중간', 'A-옛']);
  }, 20_000);
});
