import { vi } from 'vitest';

/*
 * OpenAI 클라이언트 모의 — LLM 호출부(recap·steward·stt·handover·agent·fileai·rag)의
 * 프롬프트·파싱 회귀를 잡기 위한 공용 헬퍼.
 *
 * 사용법 (테스트 파일 맨 위, import보다 먼저 실행되도록 hoisted):
 *   vi.hoisted(() => { process.env.OPENAI_API_KEY = 'sk-test'; });
 *   vi.mock('openai', () => import('./helpers/openaiMock.js').then((m) => m.mockOpenAiModule()));
 *
 * 각 모듈은 import 시점에 `process.env.OPENAI_API_KEY ? new OpenAI() : null` 로 클라이언트를 만들므로
 * 키는 반드시 모듈 평가 전에 잡혀야 한다.
 *
 * - chat.completions.create: setNextResponses()로 쌓은 큐를 순서대로 소비. 큐가 비면 throw
 *   (호출부의 폴백 경로가 자연스럽게 돈다). 요청은 captured에 그대로 남는다 (프롬프트 단언용).
 * - embeddings.create: 결정적 임베딩 (기본 = 토큰 해시 벡터, setEmbedder로 교체 가능).
 * - audio.transcriptions.create: setNextTranscriptions()로 쌓은 큐.
 */

export interface CapturedRequest {
  model: string;
  messages: { role: string; content: string }[];
  response_format?: { type: string };
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  /** create()의 두 번째 인자 (timeout 등) */
  options?: unknown;
  [k: string]: unknown;
}

type ChatScript = string | Error | ((req: CapturedRequest) => string | Error);

export const captured: CapturedRequest[] = [];
const chatQueue: ChatScript[] = [];

/** 다음 chat 응답들을 순서대로 예약 — 문자열(모델 출력 원문) | Error(API 실패) | 요청을 보고 만드는 함수 */
export function setNextResponses(...items: ChatScript[]): void {
  chatQueue.push(...items);
}

/** 객체를 JSON 문자열로 직렬화해 예약 (편의) */
export function queueJson(...objs: unknown[]): void {
  setNextResponses(...objs.map((o) => JSON.stringify(o)));
}

export function pendingResponses(): number {
  return chatQueue.length;
}

export function lastRequest(): CapturedRequest {
  return captured[captured.length - 1];
}

/** user 메시지의 JSON 페이로드 (호출부 대부분이 JSON.stringify로 넘긴다) */
export function userPayload<T = Record<string, unknown>>(req: CapturedRequest): T {
  const u = req.messages.find((m) => m.role === 'user');
  if (!u) throw new Error('no user message');
  return JSON.parse(u.content) as T;
}

export function systemPrompt(req: CapturedRequest): string {
  return req.messages.find((m) => m.role === 'system')?.content ?? '';
}

export const chatCreate = vi.fn(async (req: Record<string, unknown>, options?: unknown) => {
  captured.push({ ...(req as CapturedRequest), options });
  if (chatQueue.length === 0) throw new Error('openaiMock: no scripted response');
  let next = chatQueue.shift()!;
  if (typeof next === 'function') next = next(req as CapturedRequest);
  if (next instanceof Error) throw next;
  return { choices: [{ message: { content: next } }] };
});

/* ── 임베딩 ── */
export type Embedder = (text: string) => number[];

const DIM = 512;
function hashToken(t: string): number {
  let h = 2166136261;
  for (const ch of t) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % DIM;
}

/** 기본 임베더 — 토큰 bag을 해시한 정규화 벡터. 같은 단어를 공유하면 코사인이 오르고, 무관하면 ≈0 */
export function tokenEmbedder(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const t of tokens) v[hashToken(t)] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

/** 어휘 기반 임베더 — vocab 단어의 출현만 본다 (임계값 테스트를 정확히 통제할 때).
 *  vocab에 하나도 안 걸리면 텍스트 고유 차원 하나만 켠다 (다른 어떤 텍스트와도 코사인 0) */
export function keywordEmbedder(vocab: string[]): Embedder {
  return (text: string) => {
    const v = new Array<number>(DIM).fill(0);
    let any = false;
    vocab.forEach((w, i) => {
      const c = text.split(w).length - 1;
      if (c > 0) {
        v[i] += c;
        any = true;
      }
    });
    if (!any) v[vocab.length + hashToken(text) % (DIM - vocab.length)] = 1;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
}

let embedder: Embedder = tokenEmbedder;
export function setEmbedder(fn: Embedder): void {
  embedder = fn;
}
export const embedCalls: string[][] = [];

export const embedCreate = vi.fn(async (req: { model: string; input: string[] }) => {
  embedCalls.push(req.input);
  return { data: req.input.map((t, index) => ({ index, embedding: embedder(t) })) };
});

/** 두 텍스트의 모의 코사인 — 테스트가 기대 점수를 계산할 때 */
export function mockCosine(a: string, b: string): number {
  const va = embedder(a);
  const vb = embedder(b);
  let dot = 0;
  for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
  return dot;
}

/* ── 음성 전사 ── */
type TranscribeScript = string | Error;
const transcribeQueue: TranscribeScript[] = [];
export const transcribeCalls: { model: string; language?: string; prompt?: string; path?: string }[] = [];

export function setNextTranscriptions(...items: TranscribeScript[]): void {
  transcribeQueue.push(...items);
}

export const transcribeCreate = vi.fn(
  async (req: { file?: { path?: string }; model: string; language?: string; prompt?: string }) => {
    transcribeCalls.push({ model: req.model, language: req.language, prompt: req.prompt, path: req.file?.path });
    // 호출부는 fs.createReadStream을 넘긴다 — 실제 SDK처럼 스트림을 소비(정리)해 두지 않으면
    // 전사 직후 파일이 지워질 때 열리지 않은 스트림이 ENOENT를 unhandled error로 뿜는다
    const f = req.file as unknown as { on?: (ev: string, fn: () => void) => void; destroy?: () => void } | undefined;
    f?.on?.('error', () => {});
    f?.destroy?.();
    if (transcribeQueue.length === 0) throw new Error('openaiMock: no scripted transcription');
    const next = transcribeQueue.shift()!;
    if (next instanceof Error) throw next;
    return { text: next };
  },
);

/** 테스트 간 초기화 — beforeEach에서 호출 */
export function resetOpenAiMock(): void {
  chatQueue.length = 0;
  captured.length = 0;
  embedCalls.length = 0;
  embedder = tokenEmbedder;
  transcribeQueue.length = 0;
  transcribeCalls.length = 0;
}

/** vi.mock('openai') 팩토리 — default export 클래스 */
export function mockOpenAiModule() {
  class OpenAI {
    chat = { completions: { create: chatCreate } };
    embeddings = { create: embedCreate };
    audio = { transcriptions: { create: transcribeCreate } };
  }
  return { default: OpenAI, OpenAI };
}

/** 비동기 후처리(색인·정산·알림)가 끝날 때까지 — 조건이 참이 되거나 시간이 다할 때까지 기다린다 */
export async function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 고정 시간 대기 — fire-and-forget 체인이 마이크로태스크 몇 번 안에 끝나는 경우 */
export async function flush(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
