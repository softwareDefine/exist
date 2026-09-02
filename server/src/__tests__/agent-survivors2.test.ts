import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * agent.ts 생존 변이 사냥 2 (9/2 뮤테이션 최종 라운드) —
 * 진행 중 판정(경계 3형: 미래 창·끝만·이미 끝남)의 브리핑/카드/사실 문장,
 * 90분 경계 사실 문장, dmScopeSql, getCatchup 창(7일 바닥·접속 시각·24시간),
 * 헤드라인 놓친 집계, 오늘 일정 필터, /search 상한, /overview nextMeeting, 공백 응답 폴백.
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
import { generateBrief, getCatchup, getDailyBrief } from '../agent.js';
import { register, auth, createMeeting, joinMeeting, insertRecap, createOrg, type User } from './helpers/fixtures.js';
import { captured, queueJson, setNextResponses, resetOpenAiMock, userPayload } from './helpers/openaiMock.js';

const app = createApp();
beforeEach(() => {
  resetOpenAiMock();
  h.roomSizes.clear();
});

const pad = (n: number) => String(n).padStart(2, '0');
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const get = (u: User, path: string) => request(app).get(`/api/agent${path}`).set(auth(u));
const agoStr = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace('T', ' ').slice(0, 19);
const isoAt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const recapTexts = (items: { type: string; text: string }[]) => items.filter((i) => i.type === 'recap').map((i) => i.text);

describe('진행 중 판정 경계 — AI 카드 2 보정과 사실 문장', () => {
  it('미래 창 회의: 진행 중이 아니다 — 카드 2는 0으로, 사실은 다음 회의 한 줄', async () => {
    const u = await register(app, 'av1');
    const start = new Date(Date.now() + 2 * 3600_000);
    await createMeeting(app, u, '미래회의', {
      starts_at: localIso(start),
      ends_at: localIso(new Date(start.getTime() + 3600_000)),
    });
    queueJson({ brief: '다음 회의는 "미래회의" 일정이에요', card: 2, reason: '일정 확인' });
    const r = await generateBrief(u.id);
    expect(userPayload<{ facts: string[] }>(captured[0]).facts).toEqual([
      `다음 회의는 "미래회의"(${start.getMonth() + 1}/${start.getDate()})이다`,
      '할 일은 모두 완료됐다',
    ]);
    expect(r.source).toBe('ai');
    expect(r.card).toBe(0);
  }, 20_000);

  it('끝 시각만 있는 회의는 진행 중이 아니다', async () => {
    const u = await register(app, 'av2');
    const m = await createMeeting(app, u, '끝만회의');
    db.prepare('UPDATE meetings SET ends_at = ? WHERE id = ?').run(localIso(new Date(Date.now() + 2 * 3600_000)), m.id);
    queueJson({ brief: '오늘은 예정된 회의가 없어요', card: 2, reason: '확인' });
    const r = await generateBrief(u.id);
    expect(userPayload<{ facts: string[] }>(captured[0]).facts).toEqual(['예정된 회의가 없다', '할 일은 모두 완료됐다']);
    expect(r.card).toBe(0);
  }, 20_000);

  it('이미 끝난 회의는 진행 중이 아니다', async () => {
    const u = await register(app, 'av3');
    await createMeeting(app, u, '끝난회의', {
      starts_at: localIso(new Date(Date.now() - 10 * 60_000)),
      ends_at: localIso(new Date(Date.now() - 5 * 60_000)),
    });
    queueJson({ brief: '오늘은 예정된 회의가 없어요', card: 2, reason: '확인' });
    const r = await generateBrief(u.id);
    expect(userPayload<{ facts: string[] }>(captured[0]).facts).toEqual(['예정된 회의가 없다', '할 일은 모두 완료됐다']);
    expect(r.card).toBe(0);
  }, 20_000);
});

describe('규칙 폴백 — 진행 중·다가옴 판정 경계', () => {
  it('미래 창 회의는 진행 중 문구가 아니다', async () => {
    const u = await register(app, 'av4');
    const start = new Date(Date.now() + 2 * 3600_000);
    await createMeeting(app, u, '미래회의', { starts_at: localIso(start), ends_at: localIso(new Date(start.getTime() + 3600_000)) });
    setNextResponses(new Error('down'));
    const r = await generateBrief(u.id);
    expect(r.text).toBe('오늘 할 일과 회의가 모두 정리됐어요');
    expect(r.source).toBe('rule');
    expect(r.card).toBe(0);
  }, 20_000);

  it('끝 시각만 있는 회의 — 진행 중도, 곧 시작도 아니다', async () => {
    const u = await register(app, 'av5');
    const m = await createMeeting(app, u, '끝만회의');
    db.prepare('UPDATE meetings SET ends_at = ? WHERE id = ?').run(localIso(new Date(Date.now() + 2 * 3600_000)), m.id);
    setNextResponses(new Error('down'));
    expect(await generateBrief(u.id)).toEqual({
      text: '오늘 할 일과 회의가 모두 정리됐어요',
      source: 'rule',
      card: 0,
      reason: '다가오는 일정을 보여드려요',
    });
  }, 20_000);

  it('방금 끝난 회의 — 진행 중·곧 시작·오늘 예정 어디에도 안 걸린다', async () => {
    const u = await register(app, 'av6');
    await createMeeting(app, u, '끝난회의', {
      starts_at: localIso(new Date(Date.now() - 3 * 60_000)),
      ends_at: localIso(new Date(Date.now() - 60_000)),
    });
    setNextResponses(new Error('down'));
    expect(await generateBrief(u.id)).toEqual({
      text: '오늘 할 일과 회의가 모두 정리됐어요',
      source: 'rule',
      card: 0,
      reason: '다가오는 일정을 보여드려요',
    });
  }, 20_000);

  it('시작만 지난 회의(끝 없음)는 다가오는 회의가 아니다', async () => {
    const u = await register(app, 'av7');
    await createMeeting(app, u, '지난회의', { starts_at: localIso(new Date(Date.now() - 30 * 60_000)) });
    setNextResponses(new Error('down'));
    expect(await generateBrief(u.id)).toEqual({
      text: '오늘 할 일과 회의가 모두 정리됐어요',
      source: 'rule',
      card: 0,
      reason: '다가오는 일정을 보여드려요',
    });
  }, 20_000);

  it('곧 시작하는 회의(10분 전)는 곧 시작 문구·이유', async () => {
    const u = await register(app, 'av8');
    await createMeeting(app, u, '곧회의', {
      starts_at: localIso(new Date(Date.now() + 10 * 60_000)),
      ends_at: localIso(new Date(Date.now() + 40 * 60_000)),
    });
    setNextResponses(new Error('down'));
    const r = await generateBrief(u.id);
    expect(r.text).toMatch(/^"곧회의" (9|10)분 전 — 준비 완료 상태예요$/);
    expect(r.card).toBe(0);
    expect(r.reason).toBe('곧 시작하는 회의가 있어요');
  }, 20_000);

  it('90분 경계 — 정확히 90분 뒤는 분 단위 사실 문장', async () => {
    const u = await register(app, 'av9');
    const base = new Date();
    base.setSeconds(0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: base });
    try {
      await createMeeting(app, u, '경계회의', { starts_at: localIso(new Date(base.getTime() + 90 * 60_000)) });
      setNextResponses(new Error('down'));
      await generateBrief(u.id);
      expect(userPayload<{ facts: string[] }>(captured[0]).facts[0]).toBe('"경계회의" 회의가 90분 뒤에 시작한다');
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

describe('getCatchup — DM 스코프·창 경계', () => {
  it('DM 스코프 — personal 은 org NULL 만, 조직은 그 조직 것만', async () => {
    const u = await register(app, 'av10');
    const sp = await register(app, 'av10p');
    const so = await register(app, 'av10o');
    const org = await createOrg(app, u, 'av10 조직');
    const dm = db.prepare('INSERT INTO dm_messages (org_id, from_id, to_id, text, read) VALUES (?, ?, ?, ?, 0)');
    dm.run(null, sp.id, u.id, '개인 디엠');
    dm.run(org.id, so.id, u.id, '조직 디엠 1');
    dm.run(org.id, so.id, u.id, '조직 디엠 2');

    const personal = await getCatchup(u.id, 'personal');
    expect(personal.items.filter((i) => i.type === 'dm')).toEqual([{ type: 'dm', text: '안 읽은 DM 1개 — 최근: av10p' }]);
    expect(personal.unreadTotal).toBe(1);

    const orgc = await getCatchup(u.id, org.id);
    expect(orgc.items.filter((i) => i.type === 'dm')).toEqual([{ type: 'dm', text: '안 읽은 DM 2개 — 최근: av10o' }]);
    expect(orgc.unreadTotal).toBe(2);
  }, 20_000);

  it('8일 자리 비움 — 창은 7일 바닥까지만 열린다', async () => {
    const u = await register(app, 'av11');
    const peer = await register(app, 'av11b');
    const m = await createMeeting(app, peer, 'av11 그룹');
    await joinMeeting(app, u, m.code);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(agoStr(8 * 24 * 60), u.id);
    insertRecap(m.id, ['a'], { attendees: ['nobody'], createdAt: agoStr(Math.round(7.5 * 24 * 60)), summary: '창밖 요약' });
    // 7일 바닥 20분 뒤 — 바닥과 같은 UTC 날짜로 보정 ("T"/" " 문자열 변이가 날짜 경계를 뭉개는 걸 잡는다)
    const floor = Date.now() - 7 * 24 * 3600_000;
    let tail = floor + 20 * 60_000;
    if (new Date(tail).getUTCDate() !== new Date(floor).getUTCDate()) tail = floor + 5000;
    insertRecap(m.id, ['b'], { attendees: ['nobody'], createdAt: isoAt(tail), summary: '경계 요약' });
    insertRecap(m.id, ['c'], { attendees: ['nobody'], createdAt: agoStr(2 * 24 * 60), summary: '이틀 요약' });

    setNextResponses(new Error('down'));
    const c = await getCatchup(u.id);
    expect(recapTexts(c.items)).toEqual([
      '놓친 통화 정리 — 이틀 요약 (결정 1건)',
      '놓친 통화 정리 — 경계 요약 (결정 1건)',
    ]);
  }, 20_000);

  it('최근 접속자는 접속 종료 시각이 창이다 (7일 바닥으로 넓어지지 않는다)', async () => {
    const u = await register(app, 'av12');
    const peer = await register(app, 'av12b');
    const m = await createMeeting(app, peer, 'av12 그룹');
    await joinMeeting(app, u, m.code);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(agoStr(120), u.id);
    insertRecap(m.id, ['a'], { attendees: ['nobody'], createdAt: agoStr(300), summary: '다섯시간 요약' });
    insertRecap(m.id, ['b'], { attendees: ['nobody'], createdAt: agoStr(60), summary: '한시간 요약' });

    setNextResponses(new Error('down'));
    const c = await getCatchup(u.id);
    expect(recapTexts(c.items)).toEqual(['놓친 통화 정리 — 한시간 요약 (결정 1건)']);
  }, 20_000);

  it('첫 접속(last_seen 없음)은 24시간 창', async () => {
    const u = await register(app, 'av13');
    const peer = await register(app, 'av13b');
    const m = await createMeeting(app, peer, 'av13 그룹');
    await joinMeeting(app, u, m.code);
    db.prepare('UPDATE users SET last_seen_at = NULL WHERE id = ?').run(u.id);
    insertRecap(m.id, ['a'], { attendees: ['nobody'], createdAt: agoStr(25 * 60), summary: '스물다섯 요약' });
    const floor = Date.now() - 24 * 3600_000;
    let tail = floor + 20 * 60_000;
    if (new Date(tail).getUTCDate() !== new Date(floor).getUTCDate()) tail = floor + 5000;
    insertRecap(m.id, ['b'], { attendees: ['nobody'], createdAt: isoAt(tail), summary: '경계24 요약' });

    setNextResponses(new Error('down'));
    const c = await getCatchup(u.id);
    expect(recapTexts(c.items)).toEqual(['놓친 통화 정리 — 경계24 요약 (결정 1건)']);
  }, 20_000);

  it('참석한 통화는 놓친 집계에 들어가지 않는다', async () => {
    const u = await register(app, 'av14');
    const peer = await register(app, 'av14b');
    const m = await createMeeting(app, peer, 'av14 그룹');
    await joinMeeting(app, u, m.code);
    insertRecap(m.id, ['x'], { attendees: [u.username], summary: '참석 요약' });
    insertRecap(m.id, ['y'], { attendees: ['nobody'], summary: '불참 요약' });

    setNextResponses(new Error('down'));
    const c = await getCatchup(u.id);
    expect(recapTexts(c.items)).toEqual(['놓친 통화 정리 — 불참 요약 (결정 1건)', '통화 정리 — 참석 요약']);
    expect(c.headline).toBe('자리 비운 사이 놓친 통화 1건 있어요');
  }, 20_000);
});

describe('getDailyBrief — 오늘 일정 필터', () => {
  // 9/3 결함 #10a: 홈 배지 "오늘 회의 N건"은 이미 시작한 오늘 일정도 세는데 브리핑만 "없다"고
  // 말해 자기모순이었다 — 이제 시작이 지난 오늘 일정은 "이미 시작됐거나 끝났다"로 사실화한다
  it('오늘 이미 시작한 회의는 "없다"가 아니라 "이미 시작됐거나 끝났다"로 말한다', async () => {
    const u = await register(app, 'av15');
    await createMeeting(app, u, '지나간오늘', { starts_at: localIso(new Date(Date.now() - 2 * 60_000)) });
    queueJson({ text: '오늘 브리핑' });
    const d = await getDailyBrief(u.id);
    expect(d).toEqual({ text: '오늘 브리핑', source: 'ai' });
    expect(userPayload<{ facts: string[] }>(captured[0]).facts).toEqual(['오늘 일정 1건은 이미 시작됐거나 끝났다']);
  }, 20_000);
});

describe('/search — recap·인수인계를 넘나드는 5건 상한', () => {
  it('여러 recap/인수인계에 걸쳐도 정확히 5건에서 멈춘다', async () => {
    const u = await register(app, 'av16');
    const m = await createMeeting(app, u, 'av16 그룹');
    insertRecap(m.id, ['알파 공지 1', '알파 공지 2', '알파 공지 3']);
    insertRecap(m.id, ['알파 공지 4', '알파 공지 5', '알파 공지 6']);
    insertRecap(m.id, ['알파 공지 7', '알파 공지 8', '알파 공지 9']);
    const ho = db.prepare('INSERT INTO handovers (meeting_id, author_id, shift_label, sections) VALUES (?, ?, ?, ?)');
    ho.run(m.id, u.id, '1조', JSON.stringify({ issues: ['알파 이슈 1', '알파 이슈 2', '알파 이슈 3'] }));
    ho.run(m.id, u.id, '2조', JSON.stringify({ issues: ['알파 이슈 4', '알파 이슈 5', '알파 이슈 6'] }));
    ho.run(m.id, u.id, '3조', JSON.stringify({ issues: ['알파 이슈 7', '알파 이슈 8', '알파 이슈 9'] }));

    const r = await get(u, '/search?q=' + encodeURIComponent('알파'));
    expect(r.status).toBe(200);
    // 최신 recap(7~9) 전부 + 그 다음 recap 에서 2건을 채우고 정확히 5건에서 멈춘다
    expect(r.body.decisions.map((d: { text: string }) => d.text)).toEqual([
      '알파 공지 7', '알파 공지 8', '알파 공지 9', '알파 공지 4', '알파 공지 5',
    ]);
    expect(r.body.handovers.map((x: { text: string }) => x.text)).toEqual([
      '알파 이슈 7', '알파 이슈 8', '알파 이슈 9', '알파 이슈 4', '알파 이슈 5',
    ]);
  }, 20_000);
});

describe('/overview — nextMeeting 판정', () => {
  it('시작이 지난 회의는 nextMeeting 이 아니다', async () => {
    const u = await register(app, 'av17');
    await createMeeting(app, u, '지난회의', { starts_at: localIso(new Date(Date.now() - 30 * 60_000)) });
    const r = await get(u, '/overview');
    expect(r.status).toBe(200);
    expect(r.body.nextMeeting).toBeNull();
  }, 20_000);
});

describe('aiDecision — 공백 응답 방어', () => {
  it('공백뿐인 응답은 empty AI response 로 즉시 폴백 (trim 변이 방어)', async () => {
    const u = await register(app, 'av18');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setNextResponses('   ');
      const r = await generateBrief(u.id);
      expect(r.source).toBe('rule');
      const calls = err.mock.calls.filter((c) => String(c[0]).includes('OpenAI API 실패'));
      expect(calls).toHaveLength(1);
      expect((calls[0][1] as Error).message).toBe('empty AI response');
    } finally {
      err.mockRestore();
    }
  }, 20_000);
});
