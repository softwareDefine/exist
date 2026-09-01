import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/*
 * rag.ts — 임베딩 색인·의미 검색. embeddings.create를 결정적 모의(어휘 임베더)로 대체해
 * 청크 텍스트 형식, 코사인 임계(0.25 / 종결 안건 0.5), top-k 정렬, 철회 결정 접두, 백필을 검증.
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  delete process.env.OPENAI_EMBED_MODEL;
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import {
  indexRecap,
  indexFileRevision,
  indexAgendaResolution,
  reindexMeeting,
  searchRag,
  searchRagAcross,
  findSimilarClosedAgenda,
  embedTexts,
} from '../rag.js';
import { withdrawDecision } from '../recap.js';
import { resetOpenAiMock, setEmbedder, keywordEmbedder, embedCalls, waitFor, flush } from './helpers/openaiMock.js';

const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string; user: { id: number } };
}
async function setupMeeting(prefix: string) {
  const host = await registerUser(`${prefix}_host`);
  const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${host.token}`).send({ title: `${prefix} 그룹` });
  const code = m.body.code as string;
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
  const hostId = (db.prepare('SELECT id FROM users WHERE username = ?').get(`${prefix}_host`) as { id: number }).id;
  return { code, meetingId, hostId };
}
function insertRecap(meetingId: number, decisions: string[], summary = '요약') {
  return db
    .prepare(`INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, actions, attendees, source) VALUES (?, ?, ?, ?, '[]', '[]', 'ai')`)
    .run(meetingId, summary, JSON.stringify(decisions), JSON.stringify(decisions.map(() => ''))).lastInsertRowid as number;
}
function chunks(meetingId: number) {
  return db.prepare('SELECT kind, ref_id, text FROM rag_chunks WHERE meeting_id = ? ORDER BY id').all(meetingId) as { kind: string; ref_id: number; text: string }[];
}
const count = (meetingId: number) => (db.prepare('SELECT COUNT(*) c FROM rag_chunks WHERE meeting_id = ?').get(meetingId) as { c: number }).c;

beforeEach(() => {
  resetOpenAiMock();
  setEmbedder(keywordEmbedder(['방열판', '온도', '휴가', '일정', '야간조', '인원', '감축']));
});

describe('색인 — 청크 텍스트 형식', () => {
  it('recap은 요약 1 + 결정별 1청크(배경·대안 포함), 빈 요약은 생략, 같은 ref는 교체(중복 없음)', async () => {
    const s = await setupMeeting('lg1');
    const recapId = insertRecap(s.meetingId, ['방열판 검사 온도 65도로 상향', '여름 휴가 일정은 7월 말']);
    indexRecap(s.meetingId, recapId, {
      summary: '방열판 기준 회의',
      decisions: ['방열판 검사 온도 65도로 상향', '여름 휴가 일정은 7월 말'],
      whys: ['60도에서 편차', ''],
      alts: [['70도 — 설비 한계'], []],
      date: '2026-08-01',
    });
    await waitFor(() => count(s.meetingId) === 3);
    expect(chunks(s.meetingId).map((c) => c.text)).toEqual([
      '[통화 정리 2026-08-01] 방열판 기준 회의',
      '[결정 2026-08-01] 방열판 검사 온도 65도로 상향 (배경: 60도에서 편차) (검토된 대안: 70도 — 설비 한계)',
      '[결정 2026-08-01] 여름 휴가 일정은 7월 말',
    ]);
    expect(embedCalls[0]).toHaveLength(3);
    expect(embedCalls[0][2]).toBe('[결정 2026-08-01] 여름 휴가 일정은 7월 말');
    // 자동 기록(summary '')은 결정 청크만
    const auto = insertRecap(s.meetingId, ['야간조 인원 감축 보류']);
    indexRecap(s.meetingId, auto, { summary: '', decisions: ['야간조 인원 감축 보류'] });
    await waitFor(() => count(s.meetingId) === 4);
    expect(chunks(s.meetingId)[3].text).toBe('[결정] 야간조 인원 감축 보류');
    // 재색인 → 교체
    indexRecap(s.meetingId, recapId, { summary: '방열판 기준 회의 (수정)', decisions: [] });
    await waitFor(() => chunks(s.meetingId).some((c) => c.text.includes('(수정)')));
    expect(count(s.meetingId)).toBe(2); // recap 청크 3→1로 교체, 자동 기록 청크 1은 그대로
  });

  it('개정 연혁·종결 안건 청크 형식과 ref_id 인코딩', async () => {
    const s = await setupMeeting('lg2');
    const fileId = db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by) VALUES (?, '절차서', 'doc', ?)").run(s.meetingId, s.hostId).lastInsertRowid as number;
    indexFileRevision(s.meetingId, fileId, '절차서', 3, { note: '온도 60→65\n적용 시점 추가', basisText: '방열판 온도 65도', basisNote: null });
    indexFileRevision(s.meetingId, fileId, '절차서', 4, { note: '  ', basisText: null, basisNote: '' }); // 알맹이 없음 → 생략
    indexAgendaResolution(s.meetingId, 77, '야간조 인원 감축', '안전팀 반대');
    indexAgendaResolution(s.meetingId, 78, '휴게실 개선', null);
    await waitFor(() => count(s.meetingId) === 3);
    const rows = chunks(s.meetingId);
    expect(rows[0].kind).toBe('filerev');
    expect(rows[0].ref_id).toBe(fileId * 100_000 + 3);
    expect(rows[0].text).toMatch(/^\[문서 "절차서" 개정 v3 \d{4}-\d{2}-\d{2}\] 바뀐 점: 온도 60→65 · 적용 시점 추가 \/ 근거 결정: 방열판 온도 65도$/);
    expect(rows[1]).toMatchObject({ kind: 'agenda', ref_id: 77 });
    expect(rows[1].text).toMatch(/^\[안건 종결 \d{4}-\d{2}-\d{2}\] 야간조 인원 감축 — 종결 사유: 안전팀 반대$/);
    expect(rows[2].text).toContain('휴게실 개선 — 추가 진행하지 않기로 종결 (사유 미기재)');
  });
});

describe('검색', () => {
  it('searchRag — 코사인 ≥ 0.25만, 점수 내림차순, k 제한; 임베딩 실패는 빈 결과', async () => {
    const s = await setupMeeting('lg3');
    const recapId = insertRecap(s.meetingId, ['방열판 검사 온도 65도로 상향', '여름 휴가 일정은 7월 말']);
    indexRecap(s.meetingId, recapId, { summary: '방열판 기준 회의', decisions: ['방열판 검사 온도 65도로 상향', '여름 휴가 일정은 7월 말'], date: '2026-08-01' });
    await waitFor(() => count(s.meetingId) === 3);

    const r = await searchRag(s.meetingId, '방열판 온도 얼마였지');
    expect(r.map((x) => x.text)).toEqual([
      '[결정 2026-08-01] 방열판 검사 온도 65도로 상향', // 방열판+온도 → 1.0
      '[통화 정리 2026-08-01] 방열판 기준 회의', // 방열판만 → ≈0.71
    ]);
    expect(r[0].score).toBeCloseTo(1, 5);
    expect(r[1].score).toBeCloseTo(Math.SQRT1_2, 5);
    expect(r.every((x) => x.kind === 'recap')).toBe(true);
    expect(await searchRag(s.meetingId, '방열판 온도', 1)).toHaveLength(1);
    expect(await searchRag(s.meetingId, '전혀 무관한 질문')).toEqual([]);

    setEmbedder(() => { throw new Error('embedding down'); });
    expect(await searchRag(s.meetingId, '방열판')).toEqual([]);
    expect(await embedTexts(['x'])).toBeNull();
  });

  it('색인이 비어 있으면 이번엔 빈 결과 + 백필(reindexMeeting)이 한 번 걸린다', async () => {
    const s = await setupMeeting('lg4');
    insertRecap(s.meetingId, ['방열판 검사 온도 65도로 상향'], '기준 회의 정리');
    expect(await searchRag(s.meetingId, '방열판 온도')).toEqual([]);
    await waitFor(() => count(s.meetingId) === 2); // 요약 + 결정
    const r = await searchRag(s.meetingId, '방열판 온도');
    expect(r.map((x) => x.text)).toEqual([expect.stringMatching(/^\[결정 \d{4}-\d{2}-\d{2}\] 방열판 검사 온도 65도로 상향$/)]); // 요약은 어휘 없음 → 0점
  });

  it('reindexMeeting — 철회된 결정은 "(철회됨 — 사유)" 접두로 색인돼 현행 결정으로 오인되지 않는다', async () => {
    const s = await setupMeeting('lg5');
    const recapId = insertRecap(s.meetingId, ['방열판 검사 온도 65도로 상향', '여름 휴가 일정은 7월 말']);
    expect(withdrawDecision(recapId, 0, s.hostId, '측정 오류로 철회')).toEqual({ ok: true });
    const n = await reindexMeeting(s.meetingId);
    expect(n).toBe(1);
    await waitFor(() => count(s.meetingId) === 3);
    const texts = chunks(s.meetingId).map((c) => c.text);
    expect(texts.some((t) => /^\[결정 \d{4}-\d{2}-\d{2}\] \(철회됨 — 측정 오류로 철회\) 방열판 검사 온도 65도로 상향$/.test(t))).toBe(true);
    expect(texts.some((t) => t.endsWith('] 여름 휴가 일정은 7월 말'))).toBe(true);
  });

  it('searchRagAcross — 여러 그룹에 걸쳐 임베딩 1회로 top-k, meetingId 포함', async () => {
    const a = await setupMeeting('lg6a');
    const b = await setupMeeting('lg6b');
    indexRecap(a.meetingId, insertRecap(a.meetingId, ['방열판 온도 65도']), { summary: '', decisions: ['방열판 온도 65도'], date: '2026-08-01' });
    indexRecap(b.meetingId, insertRecap(b.meetingId, ['휴가 일정 7월 말']), { summary: '', decisions: ['휴가 일정 7월 말'], date: '2026-08-02' });
    await waitFor(() => count(a.meetingId) + count(b.meetingId) === 2);
    resetOpenAiMock();
    setEmbedder(keywordEmbedder(['방열판', '온도', '휴가', '일정']));
    const r = await searchRagAcross([a.meetingId, b.meetingId], '휴가 일정');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ meetingId: b.meetingId, text: '[결정 2026-08-02] 휴가 일정 7월 말', kind: 'recap' });
    expect(embedCalls).toEqual([['휴가 일정']]);
    expect(await searchRagAcross([], '휴가')).toEqual([]);
  });

  it('findSimilarClosedAgenda — 임계 0.5, titles와 같은 길이, 표시용 접두 정리', async () => {
    const s = await setupMeeting('lg7');
    indexAgendaResolution(s.meetingId, 501, '야간조 인원 감축', '안전팀 반대');
    await waitFor(() => count(s.meetingId) === 1);
    const r = await findSimilarClosedAgenda(s.meetingId, ['야간조 인원 감축 재검토', '방열판 온도 재조정', '야간조 회식']);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ agendaId: 501 });
    expect(r[0]!.text).toMatch(/^\d{2}\/\d{2} 종결: 야간조 인원 감축 — 종결 사유: 안전팀 반대$/);
    expect(r[1]).toBeNull(); // 코사인 0
    // "야간조 회식" — 어휘 1개만 겹침: 1/√3 ≈ 0.58 ≥ 0.5 → 매칭 (임계가 느슨해지면 여기서 잡힌다)
    expect(r[2]).not.toBeNull();
    expect(await findSimilarClosedAgenda(s.meetingId, [])).toEqual([]);
    const empty = await setupMeeting('lg7b');
    expect(await findSimilarClosedAgenda(empty.meetingId, ['아무거나'])).toEqual([null]);
    await flush();
  });
});
