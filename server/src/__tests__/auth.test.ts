import { describe, it, expect } from 'vitest';
import { hashPassword, generateRecoveryCode } from '../auth.js';

describe('hashPassword (AUTH-07)', () => {
  it('동일 비밀번호+salt는 동일 해시(결정적)', () => {
    expect(hashPassword('pw12345678', 'saltA')).toBe(hashPassword('pw12345678', 'saltA'));
  });

  it('salt가 다르면 해시가 달라진다', () => {
    expect(hashPassword('pw12345678', 'saltA')).not.toBe(hashPassword('pw12345678', 'saltB'));
  });

  it('비밀번호가 다르면 해시가 달라진다', () => {
    expect(hashPassword('pw12345678', 's')).not.toBe(hashPassword('pw99999999', 's'));
  });

  it('scrypt 64바이트 → 128자리 hex', () => {
    expect(hashPassword('x', 's')).toMatch(/^[0-9a-f]{128}$/);
  });
});

describe('generateRecoveryCode', () => {
  it('XXXX-XXXX-XXXX-XXXX 형식', () => {
    expect(generateRecoveryCode()).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  });

  it('혼동 문자(I·O·0·1)를 쓰지 않는다', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateRecoveryCode()).not.toMatch(/[IO01]/);
    }
  });

  it('호출마다 다른 코드를 만든다', () => {
    expect(generateRecoveryCode()).not.toBe(generateRecoveryCode());
  });
});
