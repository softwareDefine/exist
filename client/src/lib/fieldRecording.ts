/* ── 현장 녹음(TBM) 엔진 — 통화 없이 대면 회의를 폰 마이크로 기록하는 두 번째 입구.
 *
 * 컴포넌트 밖(모듈)에 사는 이유: 녹음 중에 탭·그룹을 옮겨도(컴포넌트 언마운트)
 * 녹음이 끊기면 안 된다. 상태는 zustand로 어디서나 구독(대시보드 버튼·전역 표시줄).
 *
 * 파이프라인 재사용: MeetingView의 통화 원음 트랙과 동일하게 30초마다 MediaRecorder를
 * 새로 시작(청크마다 webm 헤더가 붙어 각 파일이 독립 디코딩 가능해야 서버가 전사 가능),
 * 기존 /:code/stt/audio로 업로드. 종료 시 /field-recording/finish가 whisper 전사→
 * recap(원장·할일·안건 정산·RAG)을 통화와 같은 경로로 태운다.
 * 한 번에 한 그룹만 — 마이크는 하나다. */
import { create } from 'zustand';
import { api } from '../api';
import { useAuthStore } from '../store';

interface FieldRecState {
  /** 녹음 중인 그룹 코드 — null이면 대기 */
  code: string | null;
  startedAt: number | null;
  /** 종료 처리 중(마지막 청크 업로드~finish 호출) — 버튼 잠금용 */
  finishing: boolean;
}

export const useFieldRec = create<FieldRecState>(() => ({
  code: null,
  startedAt: null,
  finishing: false,
}));

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let sliceTimer: number | undefined;
let stopped = true;
/** 진행 중 청크 업로드 — 종료 시 전부 끝나길 기다렸다 finish (마지막 발언 유실 방지) */
const inflight = new Set<Promise<unknown>>();

function toast(message: string, kind: 'ok' | 'error' = 'ok') {
  window.dispatchEvent(new CustomEvent(kind === 'error' ? 'app:error' : 'app:info', { detail: message }));
}

function uploadChunk(code: string, blob: Blob, startTs: number) {
  const token = useAuthStore.getState().token;
  const p = fetch(`/api/meetings/${code}/stt/audio?ts=${startTs}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/webm' },
    body: blob,
  }).catch(() => {
    /* 청크 하나 유실은 치명적이지 않음 */
  });
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

/** 30초 청크 루프 — MeetingView와 동일 패턴 (타임슬라이스 대신 재시작) */
function startLoop(code: string, mime: string) {
  if (stopped || !stream) return;
  const startTs = Date.now();
  let r: MediaRecorder;
  try {
    r = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 });
  } catch {
    return;
  }
  recorder = r;
  r.ondataavailable = (e) => {
    if (e.data && e.data.size > 2000) uploadChunk(code, e.data, startTs);
  };
  r.onstop = () => {
    if (!stopped) startLoop(code, mime);
  };
  try {
    r.start();
  } catch {
    return;
  }
  sliceTimer = window.setTimeout(() => {
    try {
      r.stop();
    } catch {
      /* 이미 종료 */
    }
  }, 30_000);
}

/** 녹음 시작 — 마이크 권한 요청부터. 실패 사유는 토스트로 */
export async function startFieldRecording(code: string): Promise<boolean> {
  const st = useFieldRec.getState();
  if (st.code) {
    toast(st.code === code ? '이미 이 그룹에서 녹음 중이에요' : `다른 그룹(${st.code})에서 녹음 중이에요`, 'error');
    return false;
  }
  const mime = 'audio/webm;codecs=opus';
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported?.(mime)) {
    toast('이 브라우저는 녹음을 지원하지 않아요', 'error');
    return false;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('마이크 권한이 필요해요 — 브라우저 설정을 확인해주세요', 'error');
    return false;
  }
  try {
    await api(`/api/meetings/${code}/field-recording/start`, { method: 'POST' });
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    return false; // api()가 이미 에러 토스트를 띄움
  }
  stopped = false;
  useFieldRec.setState({ code, startedAt: Date.now(), finishing: false });
  startLoop(code, mime);
  return true;
}

/** 녹음 종료 — 마지막 청크까지 업로드를 기다렸다 정리를 요청한다 */
export async function stopFieldRecording(): Promise<void> {
  const { code, finishing } = useFieldRec.getState();
  if (!code || finishing) return;
  useFieldRec.setState({ finishing: true });
  stopped = true;
  window.clearTimeout(sliceTimer);
  // stop() → ondataavailable(마지막 조각 업로드 시작) → onstop 순서가 보장된다
  const r = recorder;
  if (r && r.state !== 'inactive') {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      r.addEventListener('stop', done, { once: true });
      try {
        r.stop();
      } catch {
        resolve();
      }
      window.setTimeout(done, 3000); // stop 이벤트 유실 대비
    });
  }
  recorder = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  await Promise.allSettled([...inflight]); // 마지막 발언까지 서버에 도착한 뒤에
  try {
    await api(`/api/meetings/${code}/field-recording/finish`, { method: 'POST' });
    toast('현장 녹음 종료 — 정리 중이에요. 잠시 후 기록에 올라와요');
  } catch {
    /* api()가 에러 토스트 담당 */
  }
  useFieldRec.setState({ code: null, startedAt: null, finishing: false });
}
