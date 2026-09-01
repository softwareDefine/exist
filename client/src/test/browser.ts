/* 브라우저 모드 전용 헬퍼 — 진짜 DOM에서만 의미 있는 것들 (다운로드 가로채기·실제 PNG 생성·포인터 시퀀스) */
import { vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';

/** a.click() 다운로드 가로채기 — 실제 내비게이션 대신 download 이름·blob 내용을 모은다 */
export function captureDownloads() {
  const got: { name: string; blob: Blob | null; href: string }[] = [];
  const blobs = new Map<string, Blob>();
  const origCreate = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
    const url = origCreate(obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    got.push({ name: this.download, blob: blobs.get(this.href) ?? null, href: this.href });
  });
  return {
    got,
    last: () => got[got.length - 1],
    text: async (i = got.length - 1) => (got[i]?.blob ? await got[i].blob!.text() : ''),
  };
}

/** 진짜 PNG 파일 — canvas.toBlob (Image.onload·drawImage 경로가 실제로 돈다) */
export function makePngFile(name = 'pic.png', w = 40, h = 30): Promise<File> {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#e5484d';
  ctx.fillRect(0, 0, w, h);
  return new Promise((resolve) =>
    cv.toBlob((b) => resolve(new File([b!], name, { type: 'image/png' })), 'image/png'),
  );
}

/** <input type=file>에 파일을 얹고 change 발생 — 사용자가 파일 선택창에서 고른 것과 같은 경로 */
export function setInputFiles(input: HTMLInputElement, files: File[]) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  input.files = dt.files;
  fireEvent.change(input);
}

/** 포인터 드래그 시퀀스 — 대상에 down, window에 move/up (컴포넌트가 window 리스너를 쓰는 패턴) */
export function pointerDrag(
  target: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number; pointerId?: number; ctrlKey?: boolean } = {},
) {
  const { steps = 3, pointerId = 1, ctrlKey = false } = opts;
  fireEvent.pointerDown(target, { clientX: from.x, clientY: from.y, pointerId, buttons: 1, button: 0, ctrlKey, isPrimary: true });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    fireEvent.pointerMove(target, { clientX: x, clientY: y, pointerId, buttons: 1, ctrlKey, isPrimary: true });
  }
  fireEvent.pointerUp(target, { clientX: to.x, clientY: to.y, pointerId, buttons: 0, button: 0, ctrlKey, isPrimary: true });
}

/** HTML5 드래그앤드롭 흉내 — DataTransfer가 진짜라 setData/effectAllowed 코드가 그대로 돈다 */
export function dragAndDrop(src: Element, dst: Element, opts: { ctrlKey?: boolean } = {}) {
  const dataTransfer = new DataTransfer();
  fireEvent.dragStart(src, { dataTransfer, clientX: 10, clientY: 10 });
  fireEvent.dragEnter(dst, { dataTransfer });
  fireEvent.dragOver(dst, { dataTransfer, ctrlKey: opts.ctrlKey });
  fireEvent.drop(dst, { dataTransfer, ctrlKey: opts.ctrlKey });
  fireEvent.dragEnd(src, { dataTransfer });
}

export const center = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
