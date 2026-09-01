import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockApi, tick } from '../../test/mockApi';
import { FakeMediaRecorder } from '../../test/setup';

vi.mock('../socket', () => import('../../test/socket.mock'));

/* 모듈 스코프 상태(stream/recorder/stopped)가 있으므로 테스트마다 새 모듈 인스턴스 */
async function load() {
  vi.resetModules();
  const mod = await import('../fieldRecording');
  const { useAuthStore } = await import('../../store');
  useAuthStore.setState({ token: 'tok', user: { id: 1, username: 'juho' } });
  return mod;
}

const infos: string[] = [];
const errors: string[] = [];
const onInfo = (e: Event) => infos.push((e as CustomEvent<string>).detail);
const onError = (e: Event) => errors.push((e as CustomEvent<string>).detail);

describe('fieldRecording', () => {
  let m: ReturnType<typeof mockApi>;
  beforeEach(() => {
    m = mockApi();
    FakeMediaRecorder.instances.length = 0;
    FakeMediaRecorder.isTypeSupported = () => true;
    infos.length = 0;
    errors.length = 0;
    window.addEventListener('app:info', onInfo);
    window.addEventListener('app:error', onError);
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReset();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(
      async () => new MediaStream() as unknown as MediaStream,
    );
  });
  afterEach(() => {
    window.removeEventListener('app:info', onInfo);
    window.removeEventListener('app:error', onError);
    vi.useRealTimers();
  });

  it('시작 → 청크 업로드(2KB 초과만) → 종료 → finish 호출', async () => {
    const { startFieldRecording, stopFieldRecording, useFieldRec } = await load();
    m.post('/api/meetings/ABCD/field-recording/start', { ok: true });
    m.post(/\/stt\/audio\?ts=\d+$/, { ok: true });
    m.post('/api/meetings/ABCD/field-recording/finish', { ok: true });

    await expect(startFieldRecording('ABCD')).resolves.toBe(true);
    expect(useFieldRec.getState().code).toBe('ABCD');
    expect(useFieldRec.getState().startedAt).toBeTypeOf('number');
    expect(m.calls('POST', '/api/meetings/ABCD/field-recording/start')).toHaveLength(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    const rec = FakeMediaRecorder.instances[0];
    expect(rec.state).toBe('recording');
    expect(rec.options).toMatchObject({ mimeType: 'audio/webm;codecs=opus' });

    // 너무 작은 조각은 버림
    rec.ondataavailable?.({ data: new Blob([new Uint8Array(10)]) });
    // 정상 조각은 업로드
    rec.ondataavailable?.({ data: new Blob([new Uint8Array(5000)]) });
    await tick();
    const ups = m.calls('POST', /\/stt\/audio/);
    expect(ups).toHaveLength(1);
    expect(ups[0].headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'audio/webm' });

    await stopFieldRecording();
    expect(rec.state).toBe('inactive');
    expect(m.calls('POST', '/api/meetings/ABCD/field-recording/finish')).toHaveLength(1);
    expect(useFieldRec.getState()).toEqual({ code: null, startedAt: null, finishing: false });
    expect(infos.some((s) => s.includes('현장 녹음 종료'))).toBe(true);
  });

  it('30초마다 레코더를 재시작한다 (청크마다 독립 헤더)', async () => {
    vi.useFakeTimers();
    const { startFieldRecording, stopFieldRecording } = await load();
    m.post(/field-recording\/start$/, { ok: true });
    m.post(/field-recording\/finish$/, { ok: true });
    await startFieldRecording('ABCD');
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(FakeMediaRecorder.instances[0].state).toBe('inactive');
    expect(FakeMediaRecorder.instances[1].state).toBe('recording');
    await stopFieldRecording();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(FakeMediaRecorder.instances).toHaveLength(2); // 종료 후엔 재시작 없음
  });

  it('이미 녹음 중이면 거부 + 안내', async () => {
    const { startFieldRecording, stopFieldRecording } = await load();
    m.post(/field-recording\/start$/, { ok: true });
    m.post(/field-recording\/finish$/, { ok: true });
    await startFieldRecording('AAAA');
    await expect(startFieldRecording('AAAA')).resolves.toBe(false);
    expect(errors.at(-1)).toContain('이미 이 그룹에서');
    await expect(startFieldRecording('BBBB')).resolves.toBe(false);
    expect(errors.at(-1)).toContain('다른 그룹(AAAA)');
    await stopFieldRecording();
  });

  it('MediaRecorder 미지원이면 시작 안 함', async () => {
    const { startFieldRecording, useFieldRec } = await load();
    FakeMediaRecorder.isTypeSupported = () => false;
    await expect(startFieldRecording('ABCD')).resolves.toBe(false);
    expect(errors.at(-1)).toContain('지원하지 않아요');
    expect(useFieldRec.getState().code).toBeNull();
    expect(m.recorded).toHaveLength(0);
  });

  it('마이크 권한 거부 → 안내, 서버 호출 없음', async () => {
    const { startFieldRecording } = await load();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await expect(startFieldRecording('ABCD')).resolves.toBe(false);
    expect(errors.at(-1)).toContain('마이크 권한');
    expect(m.recorded).toHaveLength(0);
  });

  it('start API 실패 → 트랙 정지, 상태 대기', async () => {
    const { startFieldRecording, useFieldRec } = await load();
    const stream = new MediaStream() as unknown as MediaStream;
    const stop = vi.spyOn(stream.getTracks()[0], 'stop');
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream);
    m.fail('POST', /field-recording\/start$/, 403, '권한 없음');
    await expect(startFieldRecording('ABCD')).resolves.toBe(false);
    expect(stop).toHaveBeenCalled();
    expect(useFieldRec.getState().code).toBeNull();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it('stop — 녹음 중이 아니거나 이미 종료 처리 중이면 no-op', async () => {
    const { stopFieldRecording, useFieldRec } = await load();
    await stopFieldRecording();
    expect(m.recorded).toHaveLength(0);
    useFieldRec.setState({ code: 'X', finishing: true });
    await stopFieldRecording();
    expect(m.recorded).toHaveLength(0);
  });

  it('finish 실패해도 상태는 대기로 돌아간다', async () => {
    const { startFieldRecording, stopFieldRecording, useFieldRec } = await load();
    m.post(/field-recording\/start$/, { ok: true });
    m.fail('POST', /field-recording\/finish$/, 500, '정리 실패');
    await startFieldRecording('ABCD');
    await stopFieldRecording();
    expect(useFieldRec.getState().code).toBeNull();
    expect(errors.at(-1)).toContain('정리 실패');
  });
});
