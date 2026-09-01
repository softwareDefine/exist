/* 스트리밍 자막 — OpenAI Realtime(transcription 세션)에 통화 마이크 PCM을 흘려보내
 * 델타를 그대로 interim 자막으로, 클라의 무음 신호(commit)마다 확정 문장을 기록한다.
 *
 * 왜 이 경로가 기본인가(9/1 실측): Web Speech는 브라우저마다 있다/없다·인식률 편차가 컸고,
 * 서버 Whisper 청크 자막은 6~8초 지연. gpt-live-transcribe는 첫 자막 ~1.3초, 정확도는
 * 파일 전사(gpt-transcribe)와 동일 — "즉시성 + 정확도"를 한 경로로 얻는다.
 * 실측한 API 특성: 구 Realtime 베타 스키마 폐지(GA session.update만), 이 모델은
 * turn_detection(VAD)을 거부하고, commit 없이는 completed를 내지 않는다 → 문장 경계는
 * 클라가 RMS 무음으로 잡아 stt:live-commit을 보낸다.
 *
 * OPENAI_API_KEY 없으면 세션이 열리지 않고 클라는 Web Speech/청크 경로로 내려간다. */
import WebSocket from 'ws';
import db from './db.js';
import { getIo } from './notify.js';
import { biasPrompt, isPromptEcho, JUNK, toDbTime } from './stt.js';

const LIVE_MODEL = process.env.OPENAI_STT_LIVE_MODEL || 'gpt-live-transcribe';
const REALTIME_URL = process.env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime?intent=transcription';
/** 스트리밍 자막 가능 여부 — 키가 있어야 한다(로컬 whisper는 스트리밍 미지원) */
export const liveSttEnabled = !!process.env.OPENAI_API_KEY && process.env.STT_LIVE !== 'off';
/** 한 구간이 이 이상 이어지면 클라 무음 신호가 없어도 서버가 끊는다(자막 줄이 무한히 길어지는 것 방지) */
const MAX_SEGMENT_MS = 20_000;
/** 소켓이 살아 있어도 이만큼 오디오가 안 오면 세션을 닫는다(마이크 끔·탭 백그라운드) */
const IDLE_MS = 30_000;

export interface LiveSttSession {
  push(pcm: Buffer): void;
  commit(): void;
  close(): void;
  readonly state: 'connecting' | 'ready' | 'closed';
}

interface Ctx {
  meetingId: number;
  meetingCode: string;
  userId: number;
  username: string;
  peerId: string;
  /** 상태 통지(클라가 폴백 판단) */
  onStatus: (s: { state: 'ready' | 'error'; reason?: string }) => void;
}

/** 세션 하나 = 통화 참가자 한 명의 마이크. sfu가 소켓 생명주기에 묶어 만들고 닫는다. */
export function openLiveStt(ctx: Ctx): LiveSttSession | null {
  if (!liveSttEnabled) return null;
  const io = getIo();
  let ws: WebSocket | null = null;
  let state: LiveSttSession['state'] = 'connecting';
  const pending: Buffer[] = []; // 연결 전 도착한 오디오
  let segment = ''; // 현재 구간의 델타 누적
  let segmentStart = 0; // 구간에 첫 델타가 온 시각
  let lastAudioAt = Date.now();
  let idleTimer: NodeJS.Timeout | null = null;
  const prompt = biasPrompt(ctx.meetingId);

  const emitCaption = (text: string, interim: boolean, source: string) => {
    io?.to(`room:${ctx.meetingCode}`).emit('voice:caption', {
      peerId: ctx.peerId,
      username: ctx.username,
      text,
      interim,
      ts: Date.now(),
      source,
    });
  };

  const send = (o: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
  };

  const finalize = (transcript: string) => {
    const text = transcript.trim().slice(0, 1000);
    segment = '';
    segmentStart = 0;
    if (!text || JUNK.test(text) || isPromptEcho(text, prompt)) return;
    db.prepare(
      "INSERT INTO call_transcripts (meeting_id, user_id, text, source, created_at) VALUES (?, ?, ?, 'whisper', ?)",
    ).run(ctx.meetingId, ctx.userId, text, toDbTime(Date.now()));
    emitCaption(text, false, 'live');
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (Date.now() - lastAudioAt >= IDLE_MS) close();
    }, IDLE_MS + 500);
  };

  const close = () => {
    if (state === 'closed') return;
    state = 'closed';
    if (idleTimer) clearTimeout(idleTimer);
    try {
      // 열린 구간이 있으면 마지막으로 확정 시도 — 응답은 못 기다리므로 누적 델타로 기록
      if (segment.trim()) finalize(segment);
      ws?.close();
    } catch {
      /* 이미 닫힘 */
    }
    ws = null;
  };

  try {
    ws = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
  } catch (e) {
    ctx.onStatus({ state: 'error', reason: (e as Error).message });
    return null;
  }

  ws.on('open', () => {
    send({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: LIVE_MODEL, language: 'ko', prompt },
          },
        },
      },
    });
  });

  ws.on('message', (raw) => {
    let e: { type?: string; delta?: string; transcript?: string; error?: { message?: string; code?: string } };
    try {
      e = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (e.type) {
      case 'session.updated': {
        if (state === 'connecting') {
          state = 'ready';
          ctx.onStatus({ state: 'ready' });
          for (const b of pending.splice(0)) send({ type: 'input_audio_buffer.append', audio: b.toString('base64') });
          armIdle();
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.delta': {
        const d = String(e.delta ?? '');
        if (!d) break;
        if (!segment) segmentStart = Date.now();
        segment += d;
        emitCaption(segment.trim(), true, 'live');
        // 클라 무음 신호가 오래 없으면(한 호흡으로 계속 말함) 서버가 끊어 준다
        if (Date.now() - segmentStart > MAX_SEGMENT_MS) send({ type: 'input_audio_buffer.commit' });
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        finalize(String(e.transcript ?? segment));
        break;
      }
      case 'error': {
        const msg = e.error?.message ?? 'realtime error';
        // 빈 버퍼 commit은 무해(무음 구간) — 세션을 죽이지 않는다
        if (/buffer.*(empty|too small)/i.test(msg) || e.error?.code === 'input_audio_buffer_commit_empty') break;
        console.error('[stt-live]', ctx.username, msg);
        ctx.onStatus({ state: 'error', reason: msg });
        close();
        break;
      }
      default:
        break;
    }
  });

  ws.on('error', (err) => {
    console.error('[stt-live] ws', (err as Error).message);
    if (state !== 'closed') ctx.onStatus({ state: 'error', reason: (err as Error).message });
    close();
  });
  ws.on('close', () => {
    if (state !== 'closed') {
      state = 'closed';
      ctx.onStatus({ state: 'error', reason: 'closed' });
    }
  });

  return {
    get state() {
      return state;
    },
    push(pcm: Buffer) {
      if (state === 'closed' || !pcm.length) return;
      lastAudioAt = Date.now();
      if (state === 'connecting') {
        pending.push(pcm);
        if (pending.length > 50) pending.shift(); // 연결이 늦으면 5초치만 보존
        return;
      }
      send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
      armIdle();
    },
    commit() {
      if (state !== 'ready') return;
      if (!segment.trim()) return; // 아무 델타도 없던 구간 — 빈 commit 방지
      send({ type: 'input_audio_buffer.commit' });
    },
    close,
  };
}
