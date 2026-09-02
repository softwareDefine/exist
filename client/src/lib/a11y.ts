/** 접근성 헬퍼 — 클릭 핸들러가 달린 비인터랙티브 요소(div/span 등)에 키보드 지원 부여 (Sonar S1082)
 *  주의: 이미 role/tabIndex/onKeyDown이 있는 요소에는 clickable 스프레드로 덮어쓰지 말 것 */
import type { KeyboardEvent, KeyboardEventHandler } from 'react';

/** Enter/Space를 클릭처럼 처리하는 onKeyDown 생성
 *  — 자식 input 등에서 버블링된 키는 무시(target 가드), 처리한 경우에만 전파 중단 */
export function keyActivate(fn: () => void): KeyboardEventHandler {
  return (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }
  };
}

/** onClick만 있던 요소에 스프레드로 붙이는 묶음: role/tabIndex/onClick/onKeyDown */
export function clickable(fn: () => void) {
  return { role: 'button' as const, tabIndex: 0, onClick: fn, onKeyDown: keyActivate(fn) };
}

/** 모달 내용 등 클릭 전파 차단(onClick stopPropagation)만 하는 요소의 키보드 짝꿍
 *  — 요소 자신이 대상일 때만 Enter/Space 전파 중단 (동작 변화 없음) */
export function keyStopPropagation(e: KeyboardEvent): void {
  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) e.stopPropagation();
}
