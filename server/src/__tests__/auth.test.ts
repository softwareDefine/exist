import { describe, it, expect } from 'vitest';
import { hashPassword, generateRecoveryCode } from '../auth.js';

/** 복구 코드 알파벳 — auth.ts와 동일 (혼동 문자 I·O·0·1 제외한 32자) */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

describe('hashPassword (AUTH-07)', () => {
  it('동일 비밀번호+salt는 동일 해시(결정적)', () => {
    const runs = Array.from({ length: 3 }, () => hashPassword('pw12345678', 'saltA'));
    expect(new Set(runs).size).toBe(1);
    expect(runs[0]).toMatch(/^[0-9a-f]{128}$/);
    // 평문·salt가 그대로 섞여 들어간 약한 스킴이 아니어야 한다
    expect(runs[0]).not.toContain('pw12345678');
    expect(runs[0]).not.toContain('saltA');
  });

  it('salt가 다르면 해시가 달라진다', () => {
    const a = hashPassword('pw12345678', 'saltA');
    const b = hashPassword('pw12345678', 'saltB');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{128}$/);
    expect(b).toMatch(/^[0-9a-f]{128}$/);
    // salt는 대소문자·공백까지 그대로 쓴다 (정규화하면 저장된 salt로 재검증이 깨진다)
    expect(hashPassword('pw12345678', 'salta')).not.toBe(a);
    expect(hashPassword('pw12345678', 'saltA ')).not.toBe(a);
  });

  it('비밀번호가 다르면 해시가 달라진다', () => {
    const base = hashPassword('pw12345678', 's');
    expect(hashPassword('pw99999999', 's')).not.toBe(base);
    expect(hashPassword('pw12345679', 's')).not.toBe(base); // 한 글자 차이
    expect(hashPassword('PW12345678', 's')).not.toBe(base); // 대소문자
    expect(hashPassword('pw12345678 ', 's')).not.toBe(base); // 뒤 공백 (trim 금지)
  });

  it('scrypt 64바이트 → 128자리 hex', () => {
    const h = hashPassword('x', 's');
    expect(h).toMatch(/^[0-9a-f]{128}$/);
    expect(h).toHaveLength(128);
    expect(h).toBe(h.toLowerCase());
    expect(Buffer.from(h, 'hex')).toHaveLength(64);
  });
});

describe('generateRecoveryCode', () => {
  it('XXXX-XXXX-XXXX-XXXX 형식', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    expect(code).toHaveLength(19);
    const groups = code.split('-');
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.length)).toEqual([4, 4, 4, 4]);
  });

  it('혼동 문자(I·O·0·1)를 쓰지 않는다', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = generateRecoveryCode();
      expect(code).not.toMatch(/[IO01]/);
      for (const ch of code.replace(/-/g, '')) {
        expect(CODE_ALPHABET).toContain(ch);
        seen.add(ch);
      }
    }
    // 32자 알파벳 전부가 실제로 뽑힌다 (200개×16자 = 3200회 추출 → 누락 확률 ≈ 0)
    expect(seen.size).toBe(CODE_ALPHABET.length);
    expect([...seen].sort().join('')).toBe([...CODE_ALPHABET].sort().join(''));
  });

  it('호출마다 다른 코드를 만든다', () => {
    const a = generateRecoveryCode();
    const b = generateRecoveryCode();
    expect(a).not.toBe(b);
    const many = Array.from({ length: 100 }, () => generateRecoveryCode());
    expect(new Set(many).size).toBe(100);
    // 그룹 단위로도 고정 접두/접미가 없어야 한다
    expect(new Set(many.map((c) => c.slice(0, 4))).size).toBeGreaterThan(90);
    expect(new Set(many.map((c) => c.slice(-4))).size).toBeGreaterThan(90);
  });
});
