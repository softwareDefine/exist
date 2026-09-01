/* LLM 호출 공통 — 모델 세대별 샘플링 파라미터.
 * gpt-5·o 계열(추론 모델)은 temperature·max_tokens를 거부하고 max_completion_tokens(추론 토큰 포함)를
 * 요구한다. env로 모델만 바꿔도(OPENAI_MODEL / _RECAP / _JUDGE) 호출부가 안 깨지게 여기서 흡수.
 * 9/1 실측: gpt-5-mini는 출력 예산이 빠듯하면 추론 토큰이 다 먹어 빈 응답 → 넉넉히 + reasoning 최소 */
export function samplingFor(model: string, temperature: number, maxOut: number): Record<string, unknown> {
  if (/^(gpt-5|o\d)/.test(model)) {
    return { max_completion_tokens: Math.max(maxOut * 4, 1500), reasoning_effort: 'low' };
  }
  return { temperature, max_tokens: maxOut };
}
