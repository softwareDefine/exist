/* 브라우저 모드(Chromium) 공통 셋업 — 진짜 DOM·canvas·ResizeObserver가 있으므로 jsdom 스텁은 없다.
 * 남는 건 (1) jest-dom 매처 (2) 테스트마다 스토리지 초기화 (3) 하드웨어(마이크·클립보드) 스텁 뿐 */
import '@testing-library/jest-dom/vitest';
// 앱 스타일시트 — 레이아웃에 기대는 코드(툴바 오버플로·캔버스 좌표·러버밴드·767px 분기)가 실제 치수로 돈다
import '../index.css';
import { afterEach, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  // 에디터가 body에 직접 붙이는 팝업(멘션·툴팁)·인쇄 클래스 정리
  document.body.classList.remove('doc-printing');
  for (const el of document.querySelectorAll('.doc-mention-pop')) el.remove();
});

// 헤드리스 Chromium엔 마이크/카메라가 없다 — 컴포넌트가 요구하면 조용히 가짜 스트림
class FakeTrack {
  kind = 'audio';
  enabled = true;
  readyState = 'live';
  stop() {
    this.readyState = 'ended';
  }
  addEventListener() {}
  removeEventListener() {}
}
if (navigator.mediaDevices) {
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: vi.fn(async () => {
      const s = new MediaStream();
      (s as unknown as { getTracks: () => FakeTrack[] }).getTracks = () => [new FakeTrack()];
      return s;
    }),
  });
  Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
    configurable: true,
    value: vi.fn(async () => []),
  });
}

/** 최소 MediaRecorder — start/stop만. 헤드리스에서 실제 인코딩은 필요 없다 */
export class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  private listeners: Record<string, (() => void)[]> = {};
  constructor(
    public stream: unknown,
    public options?: unknown,
  ) {
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') throw new Error('inactive');
    this.state = 'inactive';
    this.onstop?.();
    for (const l of this.listeners['stop'] ?? []) l();
  }
  addEventListener(ev: string, l: () => void) {
    (this.listeners[ev] ??= []).push(l);
  }
  removeEventListener() {}
}
(globalThis as unknown as Record<string, unknown>).MediaRecorder = FakeMediaRecorder;

// 클립보드 — 헤드리스는 권한 프롬프트 없이 실패하므로 기록만 하는 스텁
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: vi.fn(async () => {}), readText: vi.fn(async () => '') },
});

// window.open/print — 새 창·인쇄 대화상자는 헤드리스에서 멈출 수 있어 무해한 스텁
window.open = vi.fn(() => null) as unknown as typeof window.open;
window.print = vi.fn();
