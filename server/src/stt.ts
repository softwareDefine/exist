/* 통화 원음 녹음 → 회의 후 OpenAI 전사 — 기록·결정 추출 품질용 (자막과 무관).
 *
 * 실시간 자막은 각자 브라우저의 Web Speech가 그대로 담당하고(즉시성),
 * 이 모듈은 클라(MeetingView)가 sttOn && micOn 동안 올리는 30초 webm/opus
 * 원음 청크를 보관했다가, 통화가 끝나 recap이 돌기 직전에 한꺼번에 전사해
 * call_transcripts(source='whisper')로 넣는다. recap은 whisper 행을 우선 사용.
 * OPENAI_API_KEY 없으면 조용히 스킵 — Web Speech 기록만으로 동작(기존과 동일). */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import db from './db.js';
import type { AuthedRequest } from './auth.js';
import { getIo } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STT_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'stt-chunks');
const MAX_CHUNK = 5 * 1024 * 1024; // 30초 opus면 수백 KB — 5MB면 넉넉
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const STT_MODEL = process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe';

/** 참가자 검증 (files.ts와 동일 패턴 — 순환 import 방지 위해 자체 보유) */
function checkParticipant(
  code: unknown,
  userId: number,
): { ok: false; status: 403 | 404; error: string } | { ok: true; meetingId: number } {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return { ok: false, status: 404, error: '존재하지 않는 회의입니다' };
  const isParticipant = db
    .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
    .get(meeting.id, userId);
  if (!isParticipant) return { ok: false, status: 403, error: '회의 참가자만 쓸 수 있어요' };
  return { ok: true, meetingId: meeting.id };
}

const router = Router({ mergeParams: true });

/** 원음 청크 업로드 — raw audio, ?ts=청크 시작(ms epoch)
 *  ?ext=webm|mp4|ogg (브라우저별 MediaRecorder 컨테이너 — 사파리는 mp4)
 *  ?live=1 이면 저장 직후 이 청크를 바로 전사해 자막으로 방송한다 (Web Speech가 없는
 *  APK·사파리, 또는 Web Speech가 죽었을 때의 자막 경로 — 3~6초 지연). 라이브 전사에
 *  성공한 청크는 지우므로 통화 후 재전사와 이중 과금되지 않는다. */
router.post('/audio', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const startTs = Number(req.query.ts);
  if (!Number.isFinite(startTs) || startTs <= 0) {
    return res.status(400).json({ error: 'ts(청크 시작 시각)가 필요해요' });
  }
  const extRaw = String(req.query.ext ?? 'webm');
  const ext = extRaw === 'mp4' || extRaw === 'ogg' || extRaw === 'm4a' ? extRaw : 'webm';
  const live = req.query.live === '1';

  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_CHUNK && !aborted) {
      aborted = true;
      res.status(413).json({ error: '오디오 청크가 너무 커요' });
      req.destroy();
      return;
    }
    if (!aborted) chunks.push(c);
  });
  req.on('end', () => {
    if (aborted || res.headersSent) return;
    try {
      const buf = Buffer.concat(chunks);
      if (buf.length < 1000) return res.json({ ok: true, skipped: true }); // 빈 조각
      const dir = path.join(STT_DIR, String(r.meetingId));
      fs.mkdirSync(dir, { recursive: true });
      // 파일명에 화자·시작시각을 박아 전사 시 타임라인 복원에 쓴다
      const file = path.join(dir, `${req.userId}-${startTs}.${ext}`);
      fs.writeFileSync(file, buf);
      res.json({ ok: true, live: live && !!openai });
      if (live && openai) void transcribeChunkLive(r.meetingId, req.userId!, file, startTs);
    } catch (e) {
      // 이벤트 콜백 안의 예외는 Express가 못 잡는다 — 직접 응답
      console.error('[stt] chunk save', e);
      if (!res.headersSent) res.status(500).json({ error: '저장에 실패했어요' });
    }
  });
  req.on('error', () => {
    if (!aborted && !res.headersSent) res.status(500).json({ error: '업로드에 실패했어요' });
  });
});

export default router;

/* ── 자막 즉석 교정 — 미트식 소급 수정.
 * Web Speech 확정본 한 줄을 용어집과 함께 LLM에 던져 띄어쓰기·오인식만 고친다.
 * 교정된 줄은 sfu가 voice:caption-fix로 재방송해 이미 띄운 자막을 갈아치운다.
 * 이 함수만 바꾸면 로컬 LLM(Ollama 등)으로 교체 가능하게 격리해 둠. ── */

/** 기본 용어집 — 제조 현장·우리 도메인에서 Web Speech가 자주 깨뜨리는 말들 */
const BASE_GLOSSARY = [
  '방열판', '완제라인', '인수인계', '결정 원장', '검사 기준', '품의서', '절차서',
  'GMP', 'CAPA', 'QA', 'QC', '교대조', '야간조', '작업표준', 'SOP', '부적합',
];

/** 그룹 용어집 — 오인식을 본 사람이 등록한 우리 회사 말 (Quick Fix 루프). 최대 60개 */
export function loadMeetingGlossary(meetingId: number): string[] {
  try {
    return (
      db
        .prepare(
          'SELECT term FROM meeting_glossary WHERE meeting_id = ? ORDER BY id DESC LIMIT 60',
        )
        .all(meetingId) as { term: string }[]
    ).map((r) => r.term);
  } catch {
    return [];
  }
}

/** 자막 한 줄 교정 — 실패·저신뢰면 null (원문 유지) */
export async function correctCaption(
  text: string,
  meetingTitle?: string,
  meetingId?: number,
): Promise<string | null> {
  if (!openai || text.length < 6) return null; // 짧은 추임새는 교정 가치 없음
  try {
    const custom = meetingId ? loadMeetingGlossary(meetingId) : [];
    const glossary = [...new Set([...custom, ...BASE_GLOSSARY, ...(meetingTitle ? [meetingTitle] : [])])].join(', ');
    const res = await openai.chat.completions.create(
      {
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 300,
        messages: [
          {
            role: 'system',
            content:
              `너는 한국어 회의 자막 교정기다. 음성인식이 깨뜨린 띄어쓰기·오인식 단어·숫자 표기만 고쳐서 자막 한 줄만 출력한다.\n` +
              `규칙: 내용을 요약·창작·추가·삭제하지 않는다. 확신이 없으면 원문 그대로 출력한다. 설명·따옴표 없이 교정된 문장만 출력한다.\n` +
              `자주 나오는 용어: ${glossary}`,
          },
          { role: 'user', content: text },
        ],
      },
      { timeout: 8000 },
    );
    const fixed = res.choices[0]?.message?.content?.trim();
    if (!fixed || fixed === text) return null;
    // 폭주 방어 — 길이가 원문의 절반~2배를 벗어나면 창작으로 보고 버림
    if (fixed.length < text.length * 0.5 || fixed.length > text.length * 2) return null;
    return fixed.slice(0, 500);
  } catch {
    return null; // 교정 실패는 조용히 — 원문 자막 유지
  }
}

/** epoch ms → call_transcripts.created_at 형식(UTC 'YYYY-MM-DD HH:MM:SS') */
function toDbTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** 무음 청크에서 Whisper가 지어내는 상투구 (유튜브 학습데이터 잔재) */
const JUNK = /시청해\s*주셔서\s*감사|구독과?\s*좋아요|다음\s*영상에서\s*만나요|^\s*(음|어|아)[.…]*\s*$/;

/** 용어집 프롬프트 바이어스 — whisper는 prompt의 어휘를 우선 후보로 쓴다 */
function biasPrompt(meetingId: number): string {
  const bias = [...new Set([...loadMeetingGlossary(meetingId), ...BASE_GLOSSARY])].slice(0, 40).join(', ');
  return `회의 용어: ${bias}`;
}

/** 프롬프트 에코 방어 — 무음·음악 청크에서 Whisper가 prompt 문장을 그대로 출력하는 현상 실측(8/29).
 *  "회의 용어:"로 시작하거나, 출력 어절의 절반 이상이 용어집 단어면 지어낸 것으로 본다 */
function isPromptEcho(text: string, prompt: string): boolean {
  if (/^회의\s*용어\s*[:：]/.test(text)) return true;
  const terms = new Set(
    prompt.replace(/^회의 용어:\s*/, '').split(/,\s*/).map((t) => t.trim()).filter(Boolean),
  );
  const words = text.replace(/[,.:：]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const hit = words.filter((w) => terms.has(w)).length;
  return hit / words.length >= 0.5;
}

/** 라이브 자막 — 청크 하나를 바로 전사해 룸에 방송하고 기록에 넣는다.
 *  Web Speech와 달리 통화용 트랙(선택 장치·에코 제거)에서 온 소리라 화자가 확실하고,
 *  어느 브라우저·앱이든 같은 경로. 성공하면 청크를 지워 통화 후 재전사와 겹치지 않게 한다. */
async function transcribeChunkLive(meetingId: number, userId: number, file: string, startTs: number) {
  if (!openai) return;
  try {
    const prompt = biasPrompt(meetingId);
    const out = await openai.audio.transcriptions.create({
      file: fs.createReadStream(file),
      model: STT_MODEL,
      language: 'ko',
      prompt,
    });
    const text = String(out.text ?? '').trim().slice(0, 1000);
    if (!text || JUNK.test(text) || isPromptEcho(text, prompt)) {
      fs.unlinkSync(file);
      return;
    }
    db.prepare(
      "INSERT INTO call_transcripts (meeting_id, user_id, text, source, created_at) VALUES (?, ?, ?, 'whisper', ?)",
    ).run(meetingId, userId, text, toDbTime(startTs));
    const m = db.prepare('SELECT code FROM meetings WHERE id = ?').get(meetingId) as { code: string } | undefined;
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
    if (m && u) {
      getIo()?.to(`room:${m.code}`).emit('voice:caption', {
        username: u.username,
        text,
        ts: Date.now(),
        source: 'whisper',
      });
    }
    fs.unlinkSync(file); // 기록됐으니 통화 후 재전사 대상에서 제외
  } catch (e) {
    // 실패한 청크는 남겨둔다 — 통화 후 일괄 전사가 한 번 더 시도
    console.error('[stt] live transcribe 실패:', path.basename(file), (e as Error).message);
  }
}

/** 회의의 대기 청크 전부 전사 → call_transcripts(source='whisper') 삽입.
 *  recap 직전에 호출된다. 실패한 청크는 남겨두지 않고 버린다(다음 회의에 섞이지 않게). */
export async function transcribeMeetingAudio(meetingId: number): Promise<number> {
  if (!openai) return 0;
  const dir = path.join(STT_DIR, String(meetingId));
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.(webm|mp4|m4a|ogg)$/.test(n));
  } catch {
    return 0; // 청크 없음
  }
  const stem = (n: string) => n.replace(/\.(webm|mp4|m4a|ogg)$/, '');
  // 시작 시각순 — 타임라인 순서 보존
  names.sort((a, b) => {
    const ta = Number(stem(a).split('-')[1]);
    const tb = Number(stem(b).split('-')[1]);
    return ta - tb;
  });

  const ins = db.prepare(
    "INSERT INTO call_transcripts (meeting_id, user_id, text, source, created_at) VALUES (?, ?, ?, 'whisper', ?)",
  );
  const prompt = biasPrompt(meetingId);
  let saved = 0;
  for (const name of names) {
    const p = path.join(dir, name);
    const [userIdStr, tsStr] = stem(name).split('-');
    const userId = Number(userIdStr);
    const startTs = Number(tsStr);
    try {
      const out = await openai.audio.transcriptions.create({
        file: fs.createReadStream(p),
        model: STT_MODEL,
        language: 'ko',
        prompt,
      });
      const text = String(out.text ?? '').trim().slice(0, 2000);
      if (text && !JUNK.test(text) && !isPromptEcho(text, prompt) && Number.isInteger(userId) && Number.isFinite(startTs)) {
        ins.run(meetingId, userId, text, toDbTime(startTs));
        saved++;
      }
    } catch (e) {
      console.error('[stt] transcribe 실패:', name, (e as Error).message);
    } finally {
      try {
        fs.unlinkSync(p);
      } catch {
        /* 이미 없음 */
      }
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* 비어있지 않으면 유지 */
  }
  if (saved > 0) console.log(`[stt] 회의 ${meetingId}: whisper 전사 ${saved}청크 저장`);
  return saved;
}
