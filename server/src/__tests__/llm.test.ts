import { describe, it, expect } from 'vitest';
import { parseLlmJson, cleanAnswer, samplingFor } from '../llm.js';

describe('LLM 응답 파싱 (추론 모델 찌꺼기 방어)', () => {
  it('JSON 뒤에 괄호 섞인 잡설이 붙어도 첫 객체만 꺼낸다', () => {
    const raw = '{"answer":"방열판은 3mm예요."} icycle to ensure JSON valid? {"x":1} Done.';
    expect(parseLlmJson<{ answer: string }>(raw).answer).toBe('방열판은 3mm예요.');
  });
  it('문자열 안의 중괄호·이스케이프 따옴표를 구조로 오인하지 않는다', () => {
    const raw = '```json\n{"answer":"기호 } 와 \\"인용\\" 포함 {테스트}","n":2}\n```';
    expect(parseLlmJson<{ answer: string; n: number }>(raw)).toEqual({ answer: '기호 } 와 "인용" 포함 {테스트}', n: 2 });
  });
  it('잘린 출력은 마지막 } 까지 시도, 객체가 없으면 던진다', () => {
    expect(() => parseLlmJson('답변만 있음')).toThrow();
    expect(parseLlmJson<{ a: number }>('{"a":1} {"b":').a).toBe(1);
  });
  it('cleanAnswer — 값 안에 흘린 찌꺼기를 첫 "} 에서 자른다', () => {
    expect(cleanAnswer('이 오류는 비교 맥락으로 보여요."}ᴏɴ} icycle Done.')).toBe('이 오류는 비교 맥락으로 보여요.');
    expect(cleanAnswer('  정상 답변이에요.  ')).toBe('정상 답변이에요.');
  });
  it('samplingFor — 5.4 계열은 none 기본, gpt-5/o 계열은 none 미지원이라 low, 4o는 temperature', () => {
    expect(samplingFor('gpt-5.4-mini', 0.2, 400)).toEqual({ max_completion_tokens: 1600, reasoning_effort: 'none' });
    expect(samplingFor('gpt-5.4-mini', 0.2, 700, 'low')).toEqual({ max_completion_tokens: 2800, reasoning_effort: 'low' });
    expect(samplingFor('gpt-5-mini', 0.2, 100)).toEqual({ max_completion_tokens: 1500, reasoning_effort: 'low' });
    expect(samplingFor('o4-mini', 0.2, 100).reasoning_effort).toBe('low');
    expect(samplingFor('gpt-4o-mini', 0.2, 300)).toEqual({ temperature: 0.2, max_tokens: 300 });
  });
  it('samplingFor — 모델명 접두로만 판정(xgpt-5 는 일반 모델), 5.1 이상만 none, medium 은 그대로', () => {
    expect(samplingFor('xgpt-5-mini', 0.2, 100)).toEqual({ temperature: 0.2, max_tokens: 100 });
    expect(samplingFor('gpt-5.1', 0.2, 100)).toEqual({ max_completion_tokens: 1500, reasoning_effort: 'none' });
    expect(samplingFor('gpt-5.0', 0.2, 100).reasoning_effort).toBe('low');
    expect(samplingFor('gpt-5', 0.2, 100, 'medium').reasoning_effort).toBe('medium');
    expect(samplingFor('o3', 0.2, 500).max_completion_tokens).toBe(2000);
  });
  it('parseLlmJson — 객체가 없으면 "no json", 이스케이프된 따옴표 뒤 중괄호는 구조, 잘린 출력은 마지막 }까지', () => {
    expect(() => parseLlmJson('답변만 있음')).toThrow('no json');
    expect(parseLlmJson<{ a: string }>('{"a":"x\\"}"}')).toEqual({ a: 'x"}' }); // \" 다음 } 는 문자열 안
    expect(parseLlmJson<{ a: string; b: number }>('{"a":"\\\\","b":1}')).toEqual({ a: '\\', b: 1 }); // \\ 뒤의 " 는 문자열 종료
    expect(parseLlmJson<{ a: { b: number } }>('x {"a":{"b":1}} y')).toEqual({ a: { b: 1 } });
    expect(() => parseLlmJson('{"a":1')).toThrow('unterminated json');
    expect(() => parseLlmJson('{"a":{"b":1}')).toThrow(); // 마지막 } 까지 잘라도 JSON 이 아님
  });
  it('cleanAnswer — "} 가 맨 앞(0번째)이면 자르지 않고, 공백 뒤 } 도 인식', () => {
    expect(cleanAnswer('"}찌꺼기')).toBe('"}찌꺼기');
    expect(cleanAnswer('답변." }ᴏɴ')).toBe('답변.');
    expect(cleanAnswer('a"}b"}c')).toBe('a');
  });
});
