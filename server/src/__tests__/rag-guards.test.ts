import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/*
 * rag.ts 가드 — 문서 청크 크기(600자)·상한(20개), 검색 임계 MIN_SCORE(0.25)·종결 안건 임계(0.5)의 경계.
 * 임베딩은 정수 좌표 벡터로 코사인이 정확히 떨어지게 만든다 (Float32 저장 오차 회피).
 */
vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
});
vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));

import { createApp } from '../app.js';
import db from '../db.js';
import { indexFile, indexRecap, indexAgendaResolution, searchRag, searchRagAcross, findSimilarClosedAgenda } from '../rag.js';
import { register, createMeeting, insertRecap } from './helpers/fixtures.js';
import { resetOpenAiMock, setEmbedder, embedCalls, waitFor } from './helpers/openaiMock.js';

const app = createApp();
const BLOB_DIR = path.join(process.env.DATA_DIR!, 'uploads-files');
beforeEach(() => resetOpenAiMock());

async function setup(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const m = await createMeeting(app, host, `${prefix} 그룹`);
  return { host, code: m.code, meetingId: m.id };
}
const chunks = (meetingId: number) => db.prepare('SELECT kind, ref_id, text FROM rag_chunks WHERE meeting_id = ? ORDER BY id').all(meetingId) as { kind: string; ref_id: number; text: string }[];
const count = (meetingId: number) => (db.prepare('SELECT COUNT(*) c FROM rag_chunks WHERE meeting_id = ?').get(meetingId) as { c: number }).c;

/** 질의 [1,0,0,0,0] 과의 코사인이 정확히 떨어지는 정수 벡터 — |v| 가 정수인 것만 골랐다 */
const VEC: Record<string, number[]> = {
  QUERY: [1, 0, 0, 0, 0, 0],
  EXACT25: [1, 3, 2, 1, 1, 0], // |v| = 4 → cos = 1/4
  BELOW25: [1, 4, 0, 0, 0, 0], // cos = 1/√17 ≈ 0.243
  EXACT50: [1, 1, 1, 1, 0, 0], // |v| = 2 → cos = 1/2
  BELOW50: [1, 1, 1, 1, 1, 0], // cos = 1/√5 ≈ 0.447
  HIGH: [3, 4, 0, 0, 0, 0], // cos = 0.6
  ORTHO: [0, 0, 0, 0, 0, 1], // 모든 키 벡터와 직교 — "무관한" 텍스트
};
function keyedEmbedder(text: string): number[] {
  for (const k of Object.keys(VEC)) if (text.includes(k)) return VEC[k];
  return VEC.ORTHO;
}

describe('indexFile — 문서 청크', () => {
  it('공백 정규화 후 600자 단위로 잘라 [문서 "이름"] 접두, 최대 20청크', async () => {
    const s = await setup('rc1');
    fs.mkdirSync(BLOB_DIR, { recursive: true });
    const body = Array.from({ length: 1500 }, (_, i) => String.fromCharCode(0xac00 + (i % 500))).join('');
    fs.writeFileSync(path.join(BLOB_DIR, 'rc1-note.txt'), '  ' + body.slice(0, 700) + '\n\n  ' + body.slice(700));
    const fileId = db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by, blob_path) VALUES (?, 'note.txt', 'file', ?, 'rc1-note.txt')").run(s.meetingId, s.host.id).lastInsertRowid as number;
    indexFile(s.meetingId, fileId, 'note.txt');
    await waitFor(() => count(s.meetingId) === 3);
    const flat = body.slice(0, 700) + ' ' + body.slice(700); // 1501자
    const rows = chunks(s.meetingId);
    expect(rows.map((r) => r.text)).toEqual([
      `[문서 "note.txt"] ${flat.slice(0, 600)}`,
      `[문서 "note.txt"] ${flat.slice(600, 1200)}`,
      `[문서 "note.txt"] ${flat.slice(1200)}`,
    ]);
    expect(rows.every((r) => r.kind === 'file' && r.ref_id === fileId)).toBe(true);
    expect(embedCalls.at(-1)).toHaveLength(3);

    // 13,000자 → 22개가 나와야 하지만 20개에서 멈춘다
    fs.writeFileSync(path.join(BLOB_DIR, 'rc1-long.txt'), 'x'.repeat(13_000));
    const longId = db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by, blob_path) VALUES (?, 'long.txt', 'file', ?, 'rc1-long.txt')").run(s.meetingId, s.host.id).lastInsertRowid as number;
    indexFile(s.meetingId, longId, 'long.txt');
    await waitFor(() => count(s.meetingId) === 23);
    const long = chunks(s.meetingId).filter((r) => r.ref_id === longId);
    expect(long).toHaveLength(20);
    expect(long.every((r) => r.text.length === '[문서 "long.txt"] '.length + 600)).toBe(true);
    // 본문 없는 파일(blob 없음)·삭제된 파일은 색인하지 않는다
    const empty = db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by) VALUES (?, 'empty.txt', 'file', ?)").run(s.meetingId, s.host.id).lastInsertRowid as number;
    indexFile(s.meetingId, empty, 'empty.txt');
    await new Promise((r) => setTimeout(r, 60));
    expect(count(s.meetingId)).toBe(23);
  }, 20_000);
});

describe('검색 임계 경계', () => {
  it('searchRag·searchRagAcross — 코사인 0.25 는 포함, 그 아래는 제외, 점수 내림차순·top-k', async () => {
    const s = await setup('rt1');
    setEmbedder(keyedEmbedder);
    const r1 = insertRecap(s.meetingId, ['EXACT25 결정', 'BELOW25 결정', 'HIGH 결정']);
    indexRecap(s.meetingId, r1, { summary: '', decisions: ['EXACT25 결정', 'BELOW25 결정', 'HIGH 결정'] });
    await waitFor(() => count(s.meetingId) === 3);
    const hits = await searchRag(s.meetingId, 'QUERY');
    expect(hits.map((h) => [h.text, h.score])).toEqual([
      ['[결정] HIGH 결정', 0.6],
      ['[결정] EXACT25 결정', 0.25],
    ]);
    expect(hits[0].kind).toBe('recap');
    expect((await searchRag(s.meetingId, 'QUERY', 1)).map((h) => h.text)).toEqual(['[결정] HIGH 결정']);
    const across = await searchRagAcross([s.meetingId, 999999], 'QUERY');
    expect(across.map((h) => [h.meetingId, h.text, h.score])).toEqual([
      [s.meetingId, '[결정] HIGH 결정', 0.6],
      [s.meetingId, '[결정] EXACT25 결정', 0.25],
    ]);
    expect(await searchRagAcross([], 'QUERY')).toEqual([]);
    // 질의가 아무 청크와도 안 닿으면(코사인 0) 빈 결과
    expect(await searchRag(s.meetingId, '무관한 질문')).toEqual([]);
    expect(await searchRagAcross([s.meetingId], '무관한 질문')).toEqual([]);
  }, 20_000);

  it('findSimilarClosedAgenda — 0.5 정확히는 매칭, 0.447 은 null, 더 높은 점수를 고르고 표시 문구를 정리한다', async () => {
    const s = await setup('rt2');
    setEmbedder(keyedEmbedder);
    indexAgendaResolution(s.meetingId, 11, 'EXACT50 안건', '안전팀 반대');
    indexAgendaResolution(s.meetingId, 12, 'BELOW50 안건', null);
    indexAgendaResolution(s.meetingId, 13, 'HIGH 안건', '예산 부족');
    await waitFor(() => count(s.meetingId) === 3);
    const today = new Date().toISOString().slice(0, 10);
    const r = await findSimilarClosedAgenda(s.meetingId, ['QUERY 하나', '무관한 제목', '']);
    expect(r[0]).toEqual({ text: `${today.slice(5, 7)}/${today.slice(8, 10)} 종결: HIGH 안건 — 종결 사유: 예산 부족`, agendaId: 13 });
    expect(r[1]).toBeNull();
    // HIGH 를 빼면 0.5 짜리가 잡힌다
    db.prepare("DELETE FROM rag_chunks WHERE meeting_id = ? AND ref_id = 13").run(s.meetingId);
    const r2 = await findSimilarClosedAgenda(s.meetingId, ['QUERY 하나']);
    expect(r2[0]).toEqual({ text: `${today.slice(5, 7)}/${today.slice(8, 10)} 종결: EXACT50 안건 — 종결 사유: 안전팀 반대`, agendaId: 11 });
    db.prepare("DELETE FROM rag_chunks WHERE meeting_id = ? AND ref_id = 11").run(s.meetingId);
    expect(await findSimilarClosedAgenda(s.meetingId, ['QUERY 하나'])).toEqual([null]); // 0.447 < 0.5
    expect(await findSimilarClosedAgenda(s.meetingId, [])).toEqual([]);
    expect(await findSimilarClosedAgenda(999999, ['QUERY 하나'])).toEqual([null]); // 청크 없음 → 임베딩 호출 없이 null
  }, 20_000);
});
