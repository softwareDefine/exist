import { describe, it, expect } from 'vitest';
import { positionRank, byPositionDesc, POSITION_ORDER } from '../positions.js';

describe('positionRank (ORG-07 보조)', () => {
  it('알려진 직급은 POSITION_ORDER 인덱스를 돌려준다', () => {
    expect(positionRank('인턴')).toBe(0);
    expect(positionRank('대표')).toBe(POSITION_ORDER.length - 1);
    expect(positionRank('과장')).toBe(POSITION_ORDER.indexOf('과장'));
    // 서열표 자체 — 16단계, 중복 없음, 인턴 → 대표 순
    expect(POSITION_ORDER).toHaveLength(16);
    expect(new Set(POSITION_ORDER).size).toBe(POSITION_ORDER.length);
    expect(POSITION_ORDER.map((p) => positionRank(p))).toEqual(POSITION_ORDER.map((_, i) => i));
    expect(positionRank('부장')).toBeGreaterThan(positionRank('대리'));
    expect(positionRank('회장')).toBeLessThan(positionRank('대표'));
  });

  it('null·undefined·빈 문자열은 -1', () => {
    expect(positionRank(null)).toBe(-1);
    expect(positionRank(undefined)).toBe(-1);
    expect(positionRank('')).toBe(-1);
    // 미지정끼리는 서열이 같다 → 정렬에서 동률
    expect(byPositionDesc({ position: null }, { position: undefined })).toBe(0);
    expect(byPositionDesc({}, { position: '' })).toBe(0);
  });

  it('목록에 없는 자유 입력 직급은 -1', () => {
    expect(positionRank('수석연구원')).toBe(-1);
    expect(positionRank('Manager')).toBe(-1);
    // 정규화(trim·대소문자)는 저장 시점(orgs PATCH)의 책임 — 여기선 문자열 그대로 비교한다
    expect(positionRank(' 과장')).toBe(-1);
    expect(positionRank('과장 ')).toBe(-1);
    // 자유 입력은 미지정과 같은 서열 (둘 다 뒤로)
    expect(positionRank('수석연구원')).toBe(positionRank(null));
  });
});

describe('byPositionDesc', () => {
  it('높은 직급이 앞으로 정렬된다', () => {
    const arr = [{ position: '사원' }, { position: '대표' }, { position: '과장' }];
    arr.sort(byPositionDesc);
    expect(arr.map((x) => x.position)).toEqual(['대표', '과장', '사원']);
    // 비교자 부호 규약 — 높은 쪽이 음수(앞), 같은 직급은 0
    expect(byPositionDesc({ position: '대표' }, { position: '사원' })).toBeLessThan(0);
    expect(byPositionDesc({ position: '사원' }, { position: '대표' })).toBeGreaterThan(0);
    expect(byPositionDesc({ position: '과장' }, { position: '과장' })).toBe(0);
    // 16단계 전부 뒤섞어도 서열표 역순으로 복원된다
    const mixed = [0, 1, 2].flatMap((k) => POSITION_ORDER.filter((_, i) => i % 3 === k));
    mixed.sort((a, b) => byPositionDesc({ position: a }, { position: b }));
    expect(mixed).toEqual([...POSITION_ORDER].reverse());
  });

  it('미지정/자유입력 직급은 뒤로 밀린다', () => {
    const arr = [{ position: null }, { position: '부장' }, { position: '자유직급' }];
    arr.sort(byPositionDesc);
    expect(arr[0].position).toBe('부장');
    // 미지정과 자유입력은 동률(0) → 안정 정렬이라 원래 순서(null → 자유직급) 유지
    expect(byPositionDesc({ position: null }, { position: '자유직급' })).toBe(0);
    expect(arr.map((x) => x.position)).toEqual(['부장', null, '자유직급']);
    // 인턴(최하위 정식 직급)도 미지정보다는 앞
    const low = [{ position: null }, { position: '인턴' }];
    low.sort(byPositionDesc);
    expect(low.map((x) => x.position)).toEqual(['인턴', null]);
  });
});
