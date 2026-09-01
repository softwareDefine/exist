/* 테스트 공통 셋업 — jsdom에 없는 브라우저 API 최소 스텁 + testing-library 정리 */
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// matchMedia — 반응형 분기(모바일 767px)는 기본 데스크톱
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class IO {
  root = null;
  rootMargin = '';
  thresholds = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= RO;
g.IntersectionObserver ??= IO;

const ep = Element.prototype as unknown as Record<string, unknown>;
ep.scrollIntoView ??= function () {};
ep.setPointerCapture ??= () => {};
ep.releasePointerCapture ??= () => {};
ep.hasPointerCapture ??= () => false;

// CSS.escape — PillSeg가 data-key 셀렉터에 사용
g.CSS ??= {};
(g.CSS as Record<string, unknown>).escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);

// canvas — SignPad가 2d 컨텍스트를 요구. jsdom은 null을 돌려주며 콘솔 에러를 낸다
const ctx2d = () =>
  ({
    scale() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    clearRect() {},
    drawImage() {},
    fillRect() {},
    fillText() {},
    measureText: () => ({ width: 0 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    arc() {},
    fill() {},
    closePath() {},
    setTransform() {},
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '#000',
    fillStyle: '#000',
    font: '',
  }) as unknown as CanvasRenderingContext2D;
HTMLCanvasElement.prototype.getContext = function () {
  return ctx2d();
} as unknown as typeof HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';

// HTMLMediaElement.play — jsdom은 미구현(undefined 반환)이라 .catch()가 터진다. 브라우저처럼 Promise
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};
HTMLMediaElement.prototype.load = () => {};

// URL.createObjectURL — 다운로드·이미지 블롭
(URL as unknown as Record<string, unknown>).createObjectURL ??= () => 'blob:mock';
(URL as unknown as Record<string, unknown>).revokeObjectURL ??= () => {};

// 미디어 — 마운트만 되면 되는 수준의 스텁
class FakeMediaStreamTrack {
  kind = 'audio';
  enabled = true;
  readyState = 'live';
  stop() {
    this.readyState = 'ended';
  }
  addEventListener() {}
  removeEventListener() {}
}
export class FakeMediaStream {
  private tracks: FakeMediaStreamTrack[];
  constructor(tracks: FakeMediaStreamTrack[] = [new FakeMediaStreamTrack()]) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(t: FakeMediaStreamTrack) {
    this.tracks.push(t);
  }
  removeTrack() {}
}
g.MediaStream ??= FakeMediaStream;
g.MediaStreamTrack ??= FakeMediaStreamTrack;

/** 최소 MediaRecorder — start/stop/이벤트만. 테스트가 인스턴스를 잡아 ondataavailable을 직접 부른다 */
export class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  private listeners: Record<string, (() => void)[]> = {};
  stream: unknown;
  options: unknown;
  constructor(stream: unknown, options?: unknown) {
    this.stream = stream;
    this.options = options;
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
g.MediaRecorder = FakeMediaRecorder;

class FakeAudioContext {
  state = 'running';
  destination = {};
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    return { connect() {}, disconnect() {}, fftSize: 0, frequencyBinCount: 0, getByteFrequencyData() {} };
  }
  createGain() {
    return { connect() {}, disconnect() {}, gain: { value: 1 } };
  }
  close() {
    return Promise.resolve();
  }
  resume() {
    return Promise.resolve();
  }
}
g.AudioContext ??= FakeAudioContext;

Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: {
    getUserMedia: vi.fn(async () => new FakeMediaStream()),
    enumerateDevices: vi.fn(async () => []),
    addEventListener() {},
    removeEventListener() {},
  },
});
g.webkitSpeechRecognition ??= class {
  start() {}
  stop() {}
  abort() {}
};

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: vi.fn(async () => {}), readText: vi.fn(async () => '') },
});
