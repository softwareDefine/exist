import { sameDecision, normalizeDecision } from '../server/src/recap.js';
const cases: [string, string, boolean][] = [
  ['라벨 부착 위치는 상단 우측으로 통일하기로 했습니다.', '라벨 부착 위치를 상단 우측으로 통일하기로 했다.', true],
  ['방열판 검사 주기를 주 2회로 늘리기로 했습니다', '방열판 검사 주기를 주 2회로 늘리기로 했다.', true],
  ['라벨 부착 위치를 상단 우측으로 통일하기로 했다.', '포장재 재고 건은 다음 회의에서 논의하기로 했다.', false],
  ['출시일은 8월 25일로 하기로 했습니다', '출시일은 9월 10일로 하기로 했습니다', false],
  ['b: 출시일은 8월 25일로 하기로 했습니다', '출시일을 8월 25일로 하기로 결정했다', true],
  ['검사 기준을 0.3mm로 강화하기로 했다', '검사 기준을 0.3mm로 강화한다', true],
  ['방열판 검사 기준을 65도로 유지하기로 결정', '방열판 검사 주기를 주 2회로 늘리기로 했다', false],
];
let fail = 0;
for (const [a, b, want] of cases) {
  const got = sameDecision(a, b);
  if (got !== want) { fail++; console.log(`FAIL: "${a}" vs "${b}" → ${got} (want ${want})  [${normalizeDecision(a)} | ${normalizeDecision(b)}]`); }
  else console.log(`ok: ${got} — ${a.slice(0,22)}… vs ${b.slice(0,22)}…`);
}
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILED`);
