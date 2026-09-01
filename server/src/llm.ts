/* LLM 호출 공통 — 모델 세대별 샘플링 파라미터.
 * gpt-5·o 계열(추론 모델)은 temperature·max_tokens를 거부하고 max_completion_tokens(추론 토큰 포함)를
 * 요구한다. env로 모델만 바꿔도(OPENAI_MODEL / _RECAP / _JUDGE) 호출부가 안 깨지게 여기서 흡수.
 * 9/1 실측: gpt-5-mini는 출력 예산이 빠듯하면 추론 토큰이 다 먹어 빈 응답 → 넉넉히 + reasoning 최소 */
export function samplingFor(
  model: string,
  temperature: number,
  maxOut: number,
  /** 추론 강도 — 기본 'none'(채팅·교정·판정: 추론 토큰 0 → 2배 빠르고, 9/1 라이브에서 본
   *  "answer 문자열 안에 추론 찌꺼기 누출"이 구조적으로 불가능). 결정 추출처럼 품질이 우선인
   *  곳만 'low'. gpt-5.1 미만·o 계열은 'none' 미지원이라 'low'로 강등 */
  effort: 'none' | 'low' | 'medium' = 'none',
): Record<string, unknown> {
  if (/^(gpt-5|o\d)/.test(model)) {
    const supportsNone = /^gpt-5\.[1-9]/.test(model);
    const reasoning_effort = effort === 'none' && !supportsNone ? 'low' : effort;
    return { max_completion_tokens: Math.max(maxOut * 4, 1500), reasoning_effort };
  }
  return { temperature, max_tokens: maxOut };
}

/** LLM 응답에서 첫 번째 완전한 JSON 객체만 꺼낸다 — 코드펜스·앞뒤 잡설·뒤에 붙은 찌꺼기 괄호 방어.
 *  "첫 { ~ 마지막 }" 자르기는 뒤에 { } 가 섞인 잡설이 오면 통째로 파싱 실패했다(9/1). 문자열 안의
 *  괄호·이스케이프를 인식하며 깊이 0으로 돌아오는 지점에서 끊는다 */
export function parseLlmJson<T = Record<string, unknown>>(raw: string): T {
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('no json');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1)) as T;
    }
  }
  // 닫히지 않음(출력 잘림) — 마지막 } 까지 시도
  const end = raw.lastIndexOf('}');
  if (end > start) return JSON.parse(raw.slice(start, end + 1)) as T;
  throw new Error('unterminated json');
}

/** 답변 문자열 위생 — 추론 모델이 값 안에 흘린 찌꺼기("...끝이에요."}ᴏɴ… Done.)를 첫 `"}` 에서 자른다 */
export function cleanAnswer(s: string): string {
  const cut = s.search(/"\s*\}/);
  return (cut > 0 ? s.slice(0, cut) : s).trim();
}
