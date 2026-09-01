import { describe, it, expect, vi, afterEach } from 'vitest';
import { dueBadge } from '../due';
import { readPins, isPinned, togglePin, PINS_EVENT } from '../pins';
import { POSITIONS } from '../positions';
import { useCallSession, registerCall, clearCall, leaveOtherCall } from '../callSession';

describe('dueBadge', () => {
  afterEach(() => vi.useRealTimers());
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  it('오늘/내일/지남/그 외', () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 30, 15, 0, 0) });
    expect(dueBadge('2026-08-30')).toEqual({ label: '오늘', cls: 'today' });
    expect(dueBadge('2026-08-31')).toEqual({ label: '내일', cls: 'soon' });
    expect(dueBadge('2026-08-28')).toEqual({ label: '8/28 지남', cls: 'over' });
    expect(dueBadge('2026-09-15')).toEqual({ label: '9/15', cls: 'later' });
  });

  it('시각이 붙은 ISO도 날짜 부분만 본다', () => {
    const today = new Date();
    expect(dueBadge(`${ymd(today)}T23:59:00`)?.cls).toBe('today');
  });

  it('잘못된 날짜는 null', () => {
    expect(dueBadge('not-a-date')).toBeNull();
    expect(dueBadge('')).toBeNull();
  });
});

describe('pins', () => {
  it('빈 상태 → 토글로 앞에 추가 → 다시 토글로 제거, 이벤트 발행', () => {
    expect(readPins()).toEqual([]);
    expect(isPinned(3)).toBe(false);
    const onChange = vi.fn();
    window.addEventListener(PINS_EVENT, onChange);
    expect(togglePin(3)).toEqual([3]);
    expect(togglePin(5)).toEqual([5, 3]);
    expect(isPinned(3)).toBe(true);
    expect(togglePin(3)).toEqual([5]);
    expect((onChange.mock.calls[2][0] as CustomEvent).detail).toEqual([5]);
    window.removeEventListener(PINS_EVENT, onChange);
    expect(JSON.parse(localStorage.getItem('exist:pinned-groups')!)).toEqual([5]);
  });

  it('깨진 저장값은 빈 배열로', () => {
    localStorage.setItem('exist:pinned-groups', '{oops');
    expect(readPins()).toEqual([]);
  });
});

describe('POSITIONS', () => {
  it('낮은 직급 → 높은 직급 순, 중복 없음', () => {
    expect(POSITIONS[0]).toBe('인턴');
    expect(POSITIONS[POSITIONS.length - 1]).toBe('대표');
    expect(POSITIONS.indexOf('대리')).toBeLessThan(POSITIONS.indexOf('부장'));
    expect(new Set(POSITIONS).size).toBe(POSITIONS.length);
  });
});

describe('callSession', () => {
  it('registerCall은 대문자로 저장, clearCall은 내 통화일 때만 해제', () => {
    const leave = vi.fn();
    registerCall('abcd', leave);
    expect(useCallSession.getState().code).toBe('ABCD');
    clearCall('zzzz');
    expect(useCallSession.getState().code).toBe('ABCD');
    clearCall('abcd');
    expect(useCallSession.getState()).toEqual({ code: null, leave: null });
  });

  it('leaveOtherCall — 다른 그룹 통화만 종료, 같은 그룹이면 유지, 종료 루틴 예외 삼킴', () => {
    const leave = vi.fn();
    registerCall('AAAA', leave);
    leaveOtherCall('aaaa');
    expect(leave).not.toHaveBeenCalled();
    expect(useCallSession.getState().code).toBe('AAAA');

    leaveOtherCall('BBBB');
    expect(leave).toHaveBeenCalledTimes(1);
    expect(useCallSession.getState().code).toBeNull();

    registerCall('CCCC', () => {
      throw new Error('boom');
    });
    expect(() => leaveOtherCall('DDDD')).not.toThrow();
    expect(useCallSession.getState().code).toBeNull();
  });
});
