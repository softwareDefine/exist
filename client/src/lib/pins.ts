// 사이드바 "최근 그룹" 맨 위 고정 — 기기별(localStorage) 개인 설정.
// DashboardPage(목록 정렬)와 MeetingHub(그룹 설정 토글)가 공유하며,
// 변경 시 PINS_EVENT로 같은 탭 내 구독자에게 알린다.
const KEY = 'exist:pinned-groups';
export const PINS_EVENT = 'exist:pins-changed';

export function readPins(): number[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as number[];
  } catch {
    return [];
  }
}

export function isPinned(id: number): boolean {
  return readPins().includes(id);
}

export function togglePin(id: number): number[] {
  const cur = readPins();
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur];
  localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(PINS_EVENT, { detail: next }));
  return next;
}
