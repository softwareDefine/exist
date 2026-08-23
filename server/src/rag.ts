/* ── RAG — 결정 원장·통화 정리·문서를 임베딩해 의미 검색 ──
 * "축적된 기록이 조직의 문제 해결 가이드가 된다": @AI의 최근 창(30건) 주입이 못 닿는
 * 오래된 기록·표현이 다른 기록을 질문의 의미로 찾아온다.
 *
 * 저장: rag_chunks.embedding = Float32Array BLOB (text-embedding-3-small, 1536차원).
 * 검색: JS 코사인 브루트포스 — 그룹당 수천 청크까지 수 ms, 네이티브 확장(sqlite-vec)
 * 의존이 없어 Docker arm64에서 안전. 규모가 커지면 그때 벡터 DB로 교체.
 * 실패는 전부 조용히 — RAG는 보강 재료라 없어도 @AI는 기존 창 주입으로 동작한다 */
import OpenAI from 'openai';
import db from './db.js';
import { extractFileText } from './fileai.js';
import { extractUploadedFileText } from './filetext.js';

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const TOP_K = 6;
const MIN_SCORE = 0.25; // 이보다 낮으면 "관련 기록 없음"으로 취급 (엉뚱한 근거 주입 방지)

function toBlob(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}
function fromBlob(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/** 코사인 유사도 — 임베딩은 정규화돼 나오므로 내적으로 충분하지만 방어적으로 정식 계산 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

async function embed(texts: string[]): Promise<number[][] | null> {
  if (!openai || texts.length === 0) return null;
  try {
    const res = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: texts.map((t) => t.slice(0, 2000)),
    });
    return res.data.map((d) => d.embedding);
  } catch (e) {
    console.error('[rag] 임베딩 실패:', (e as Error).message);
    return null;
  }
}

/** 외부용 임베딩 — steward의 보류 깨우기(안건↔결정 매칭)가 사용. 실패 시 null(조용히) */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  return embed(texts);
}

/** 청크 저장(교체) — 같은 (kind, ref_id)의 기존 청크를 지우고 다시 넣는다 */
async function upsertChunks(
  meetingId: number,
  kind: string,
  refId: number,
  texts: string[],
): Promise<void> {
  const clean = texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t.length >= 8);
  if (clean.length === 0) return;
  const vecs = await embed(clean);
  if (!vecs) return;
  const del = db.prepare('DELETE FROM rag_chunks WHERE meeting_id = ? AND kind = ? AND ref_id = ?');
  const ins = db.prepare(
    'INSERT INTO rag_chunks (meeting_id, kind, ref_id, text, embedding) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    del.run(meetingId, kind, refId);
    for (let i = 0; i < clean.length; i++) ins.run(meetingId, kind, refId, clean[i], toBlob(vecs[i]));
  })();
}

/** recap 색인 — 요약 1청크 + 결정별 1청크(배경·대안 포함: "왜"까지 검색되게) */
export function indexRecap(
  meetingId: number,
  recapId: number,
  p: { summary: string; decisions: string[]; whys?: string[]; alts?: string[][]; date?: string },
): void {
  const texts: string[] = [];
  if (p.summary) texts.push(`[통화 정리${p.date ? ` ${p.date}` : ''}] ${p.summary}`);
  p.decisions.forEach((d, i) => {
    const why = p.whys?.[i] ? ` (배경: ${p.whys[i]})` : '';
    const alts = p.alts?.[i]?.length ? ` (검토된 대안: ${p.alts[i].join(' / ')})` : '';
    texts.push(`[결정${p.date ? ` ${p.date}` : ''}] ${d}${why}${alts}`);
  });
  void upsertChunks(meetingId, 'recap', recapId, texts).catch(() => {});
}

/** 문서 색인 — 본문을 ~600자 청크로. 개정 발행·업로드·재색인 때 호출.
 *  편집 문서(Yjs)는 extractFileText, 업로드 파일(hwp·hwpx·docx·txt 등)은 filetext 추출 폴백 */
export function indexFile(meetingId: number, fileId: number, name: string): void {
  void (async () => {
    let text: string | null = null;
    try {
      text = extractFileText(fileId);
      if (!text) text = await extractUploadedFileText(fileId);
    } catch {
      return;
    }
    if (!text) return;
    const flat = text.replace(/\s+/g, ' ').trim();
    const chunks: string[] = [];
    for (let i = 0; i < flat.length && chunks.length < 20; i += 600) {
      chunks.push(`[문서 "${name}"] ${flat.slice(i, i + 600)}`);
    }
    await upsertChunks(meetingId, 'file', fileId, chunks);
  })().catch(() => {});
}

/** 개정 연혁 색인 — "언제 왜 무엇이 바뀌었나"가 의미 검색으로 찾아지게.
 *  rev당 1청크(바뀐 점 요약 + 근거 결정 + 기타 사유). 발행 시점에 확정되는 불변 기록이라
 *  RAG에 맞다 (서명 현황 같은 실시간 상태는 색인하지 않는다 — 낡은 답 방지) */
export function indexFileRevision(
  meetingId: number,
  fileId: number,
  name: string,
  rev: number,
  p: { note?: string | null; basisText?: string | null; basisNote?: string | null },
): void {
  const parts: string[] = [];
  if (p.note?.trim()) parts.push(`바뀐 점: ${p.note.trim().split('\n').join(' · ')}`);
  if (p.basisText?.trim()) parts.push(`근거 결정: ${p.basisText.trim()}`);
  if (p.basisNote?.trim()) parts.push(`개정 사유: ${p.basisNote.trim()}`);
  if (parts.length === 0) return; // 알맹이 없는 개정은 색인 생략
  const date = new Date().toISOString().slice(0, 10);
  const text = `[문서 "${name}" 개정 v${rev} ${date}] ${parts.join(' / ')}`;
  // ref_id에 rev를 함께 인코딩 — rev마다 별도 청크로 남긴다 (fileId 단독이면 새 rev가 옛 rev를 지움)
  void upsertChunks(meetingId, 'filerev', fileId * 100_000 + rev, [text]).catch(() => {});
}

/** 종결 안건 색인 — "검토했음/채택하지 않음/이유"가 몇 년 뒤 같은 아이디어 재검토 때 소환되게
 *  (박형우 멘토: "예전에 왜 안 됐는지도 모른 채 같은 과정을 반복하는 게 문제") */
export function indexAgendaResolution(
  meetingId: number,
  agendaId: number,
  title: string,
  note: string | null,
): void {
  const date = new Date().toISOString().slice(0, 10);
  const text = `[안건 종결 ${date}] ${title} — ${note?.trim() ? `종결 사유: ${note.trim()}` : '추가 진행하지 않기로 종결 (사유 미기재)'}`;
  void upsertChunks(meetingId, 'agenda', agendaId, [text]).catch(() => {});
}

/** 그룹 전체 재색인 — 기존 기록 백필 (원장·recap 전부 + 살아있는 편집 문서) */
export async function reindexMeeting(meetingId: number): Promise<number> {
  const recaps = db
    .prepare(
      'SELECT id, summary, decisions, whys, alts, created_at FROM meeting_recaps WHERE meeting_id = ?',
    )
    .all(meetingId) as {
    id: number;
    summary: string;
    decisions: string;
    whys: string | null;
    alts: string | null;
    created_at: string;
  }[];
  for (const r of recaps) {
    let decisions: string[] = [];
    let whys: string[] = [];
    let alts: string[][] = [];
    try {
      decisions = JSON.parse(r.decisions);
      whys = r.whys ? JSON.parse(r.whys) : [];
      alts = r.alts ? JSON.parse(r.alts) : [];
    } catch {
      /* 형식 깨진 행은 요약만 */
    }
    indexRecap(meetingId, r.id, {
      summary: r.summary,
      decisions,
      whys,
      alts,
      date: r.created_at.slice(0, 10),
    });
  }
  const files = db
    .prepare(
      `SELECT id, name FROM collab_files
       WHERE meeting_id = ? AND deleted_at IS NULL AND type != 'folder'`,
    )
    .all(meetingId) as { id: number; name: string }[];
  for (const f of files) indexFile(meetingId, f.id, f.name);
  // 개정 연혁 백필 — note·근거·사유가 있는 rev만
  const revs = db
    .prepare(
      `SELECT s.file_id, s.rev, s.note, s.basis_recap_id, s.basis_decision_idx, s.basis_note, f.name
       FROM file_rev_snapshots s JOIN collab_files f ON f.id = s.file_id
       WHERE f.meeting_id = ? AND f.deleted_at IS NULL
         AND (s.note IS NOT NULL OR s.basis_recap_id IS NOT NULL OR s.basis_note IS NOT NULL)`,
    )
    .all(meetingId) as {
    file_id: number;
    rev: number;
    note: string | null;
    basis_recap_id: number | null;
    basis_decision_idx: number | null;
    basis_note: string | null;
    name: string;
  }[];
  for (const s of revs) {
    let basisText: string | null = null;
    if (s.basis_recap_id != null && s.basis_decision_idx != null) {
      try {
        const rec = db
          .prepare('SELECT decisions FROM meeting_recaps WHERE id = ?')
          .get(s.basis_recap_id) as { decisions: string } | undefined;
        basisText = rec ? ((JSON.parse(rec.decisions) as string[])[s.basis_decision_idx] ?? null) : null;
      } catch {
        basisText = null;
      }
    }
    indexFileRevision(meetingId, s.file_id, s.name, s.rev, {
      note: s.note,
      basisText,
      basisNote: s.basis_note,
    });
  }
  return recaps.length + files.length + revs.length;
}

/** 여러 그룹에 걸친 의미 검색 — DM 1:1 AI 질의용 (임베딩 1회, 그룹 경계 없이 top k) */
export async function searchRagAcross(
  meetingIds: number[],
  query: string,
  k = TOP_K,
): Promise<{ meetingId: number; text: string; kind: string; score: number }[]> {
  if (!openai || meetingIds.length === 0) return [];
  const qv = await embed([query]);
  if (!qv) return [];
  const q = new Float32Array(qv[0]);
  const ph = meetingIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT meeting_id, text, kind, embedding FROM rag_chunks WHERE meeting_id IN (${ph})`,
    )
    .all(...meetingIds) as { meeting_id: number; text: string; kind: string; embedding: Buffer }[];
  return rows
    .map((r) => ({
      meetingId: r.meeting_id,
      text: r.text,
      kind: r.kind,
      score: cosine(q, fromBlob(r.embedding)),
    }))
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** 새 안건 후보와 유사한 "과거 종결 안건" 탐색 — "이거 예전에 접었던 건이에요"의 선제 표시.
 *  오탐(멀쩡한 새 안건에 과거 종결 딱지)이 미탐보다 나쁘므로 임계 0.5로 엄격하게.
 *  반환은 titles와 같은 길이 배열 — 매칭 없으면 null */
export async function findSimilarClosedAgenda(
  meetingId: number,
  titles: string[],
): Promise<({ text: string; agendaId: number } | null)[]> {
  if (!openai || titles.length === 0) return titles.map(() => null);
  const chunks = db
    .prepare(
      `SELECT ref_id, text, embedding FROM rag_chunks WHERE meeting_id = ? AND kind = 'agenda'`,
    )
    .all(meetingId) as { ref_id: number; text: string; embedding: Buffer }[];
  if (chunks.length === 0) return titles.map(() => null);
  const vecs = await embed(titles);
  if (!vecs) return titles.map(() => null);
  return titles.map((_, i) => {
    const q = new Float32Array(vecs[i]);
    let best: { text: string; agendaId: number; score: number } | null = null;
    for (const c of chunks) {
      const s = cosine(q, fromBlob(c.embedding));
      if (s >= 0.5 && (!best || s > best.score))
        best = { text: c.text, agendaId: c.ref_id, score: s };
    }
    // "[안건 종결 YYYY-MM-DD] 제목 — 사유" → 표시용으로 정리. agendaId = 생애 타임라인 입구
    return best
      ? {
          text: best.text.replace(/^\[안건 종결 (\d{4})-(\d{2})-(\d{2})\]\s*/, '$2/$3 종결: '),
          agendaId: best.agendaId,
        }
      : null;
  });
}

const backfillKicked = new Set<number>();

/** 의미 검색 — 질문과 가장 가까운 기록 top K. 색인이 비어 있으면 백필을 걸고 이번엔 빈 결과 */
export async function searchRag(
  meetingId: number,
  query: string,
  k = TOP_K,
): Promise<{ text: string; kind: string; score: number }[]> {
  if (!openai) return [];
  const count = (
    db.prepare('SELECT COUNT(*) c FROM rag_chunks WHERE meeting_id = ?').get(meetingId) as {
      c: number;
    }
  ).c;
  if (count === 0) {
    if (!backfillKicked.has(meetingId)) {
      backfillKicked.add(meetingId);
      void reindexMeeting(meetingId).catch(() => {});
    }
    return [];
  }
  const qv = await embed([query]);
  if (!qv) return [];
  const q = new Float32Array(qv[0]);
  const rows = db
    .prepare('SELECT text, kind, embedding FROM rag_chunks WHERE meeting_id = ?')
    .all(meetingId) as { text: string; kind: string; embedding: Buffer }[];
  return rows
    .map((r) => ({ text: r.text, kind: r.kind, score: cosine(q, fromBlob(r.embedding)) }))
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
