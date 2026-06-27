import { describe, it, expect } from 'vitest';
import { positionRank, byPositionDesc, POSITION_ORDER } from '../positions.js';

describe('positionRank (ORG-07 보조)', () => {
  it('알려진 직급은 POSITION_ORDER 인덱스를 돌려준다', () => {
    expect(positionRank('인턴')).toBe(0);
    expect(positionRank('대표')).toBe(POSITION_ORDER.length - 1);
    expect(positionRank('과장')).toBe(POSITION_ORDER.indexOf('과장'));
  });

  it('null·undefined·빈 문자열은 -1', () => {
    expect(positionRank(null)).toBe(-1);
    expect(positionRank(undefined)).toBe(-1);
    expect(positionRank('')).toBe(-1);
  });

  it('목록에 없는 자유 입력 직급은 -1', () => {
    expect(positionRank('수석연구원')).toBe(-1);
  });
});

describe('byPositionDesc', () => {
  it('높은 직급이 앞으로 정렬된다', () => {
    const arr = [{ position: '사원' }, { position: '대표' }, { position: '과장' }];
    arr.sort(byPositionDesc);
    expect(arr.map((x) => x.position)).toEqual(['대표', '과장', '사원']);
  });

  it('미지정/자유입력 직급은 뒤로 밀린다', () => {
    const arr = [{ position: null }, { position: '부장' }, { position: '자유직급' }];
    arr.sort(byPositionDesc);
    expect(arr[0].position).toBe('부장');
  });
});
