/**
 * 아바타 식별성 유틸 (design-0903 결함 #8)
 * — 같은 사람은 어디서나 같은 색: username 해시 → 고정 팔레트 인덱스.
 * — 프로필 사진이 없으면 기본 펭귄 대신 "이니셜 + 고정색 배경"이 기본.
 *   (아바타 모양 규칙: 정사각 + 살짝 radius — 원형 금지. 모양은 각 위치의 CSS가 유지)
 */

/** 서버 users.avatar 기본값 — 이 값이면 "직접 고른 적 없음"으로 취급해 이니셜로 대체 */
export const DEFAULT_AVATAR = '🐧';

/** 인물 고정색 팔레트 — 연한 배경 + 진한 글자(대비 확보), 라이트/다크 공통 고정값 */
export const AVATAR_COLORS: readonly { bg: string; fg: string }[] = [
  { bg: '#dbeafe', fg: '#1d4ed8' }, // blue
  { bg: '#dcfce7', fg: '#15803d' }, // green
  { bg: '#ffe4e6', fg: '#be123c' }, // rose
  { bg: '#fef3c7', fg: '#a16207' }, // amber
  { bg: '#f3e8ff', fg: '#7e22ce' }, // purple
  { bg: '#fce7f3', fg: '#be185d' }, // pink
  { bg: '#e0e7ff', fg: '#4338ca' }, // indigo
  { bg: '#ccfbf1', fg: '#0f766e' }, // teal
  { bg: '#ffedd5', fg: '#c2410c' }, // orange
  { bg: '#e2e8f0', fg: '#334155' }, // slate
];

/** FNV-1a 32bit — 짧은 한글/영문 아이디에서도 분포가 고른 결정적 해시 */
export function avatarHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** username(또는 userId 문자열) → 인물 고정색. 컨텍스트와 무관하게 항상 같은 색 */
export function avatarColor(key: string): { bg: string; fg: string } {
  return AVATAR_COLORS[avatarHash(key) % AVATAR_COLORS.length];
}

/** 표시 이름 → 이니셜 한 글자. 한글은 첫 음절, 영문은 대문자 첫 글자 (서로게이트 안전) */
export function avatarInitial(display: string): string {
  const first = Array.from(display.trim())[0];
  return first ? first.toUpperCase() : '?';
}
