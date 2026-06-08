/*
 * 한국 기업 표준 직급(직위) 서열 — 낮은 직급부터 높은 직급 순.
 * 멤버 정렬·표시에 사용. 목록에 없는 직급(자유 입력)은 서열 미지정으로 맨 뒤.
 */
export const POSITION_ORDER = [
  '인턴',
  '사원',
  '주임',
  '대리',
  '과장',
  '차장',
  '부장',
  '실장',
  '이사',
  '상무',
  '전무',
  '부사장',
  '사장',
  '부회장',
  '회장',
  '대표',
] as const;

/** 직급 서열 인덱스 (없으면 -1 → 정렬 시 맨 뒤로 보냄) */
export function positionRank(position: string | null | undefined): number {
  if (!position) return -1;
  return POSITION_ORDER.indexOf(position as (typeof POSITION_ORDER)[number]);
}

/** 직급 높은 순 정렬 비교자 (rank 큰 게 앞). 미지정/자유입력은 뒤로. */
export function byPositionDesc(
  a: { position?: string | null },
  b: { position?: string | null },
): number {
  const ra = positionRank(a.position);
  const rb = positionRank(b.position);
  if (ra !== rb) return rb - ra; // 높은 직급 먼저
  return 0;
}
