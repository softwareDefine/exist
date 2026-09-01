#!/usr/bin/env node
/*
 * 테스트 단언 밀도 — 파일별 it/test 개수 대비 expect 개수 (정적 카운트).
 *   node scripts/test-density.mjs          전체 (밀도 오름차순)
 *   node scripts/test-density.mjs --min 4  밀도 4 미만만 표시
 * 카운트 규칙:
 *   - 테스트: 줄 시작(들여쓰기 허용)의 it( / test( / it.each( / test.skip( 등
 *   - 단언:   expect( / expect.soft( / expect.<matcher>( (예: expect.arrayContaining) — 줄 안 어디든
 * ※ route-sweep.test.ts 는 ~1,100개 검사를 배열 단언 몇 개로 묶어 하므로 정적 카운트가 크게 과소평가된다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'src', '__tests__');
const minArg = process.argv.indexOf('--min');
const min = minArg >= 0 ? Number(process.argv[minArg + 1]) : null;

const TEST_RE = /^\s*(?:it|test)(?:\.(?:only|skip|todo|each|concurrent))*\s*\(/gm;
const EXPECT_RE = /\bexpect(?:\.soft|\.[A-Za-z]+)?\s*\(/g;

const rows = [];
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.test.ts')).sort()) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const tests = (src.match(TEST_RE) ?? []).length;
  const expects = (src.match(EXPECT_RE) ?? []).length;
  rows.push({ file: f, tests, expects, density: tests ? expects / tests : 0 });
}
rows.sort((a, b) => a.density - b.density || a.file.localeCompare(b.file));

const totT = rows.reduce((s, r) => s + r.tests, 0);
const totE = rows.reduce((s, r) => s + r.expects, 0);
const w = Math.max(...rows.map((r) => r.file.length));
const pad = (s, n) => String(s).padStart(n);
console.log(`${'file'.padEnd(w)}  ${pad('it', 4)}  ${pad('expect', 6)}  ${pad('density', 7)}`);
for (const r of rows) {
  if (min != null && r.density >= min) continue;
  console.log(`${r.file.padEnd(w)}  ${pad(r.tests, 4)}  ${pad(r.expects, 6)}  ${pad(r.density.toFixed(1), 7)}`);
}
console.log('-'.repeat(w + 24));
console.log(`${'TOTAL'.padEnd(w)}  ${pad(totT, 4)}  ${pad(totE, 6)}  ${pad((totT ? totE / totT : 0).toFixed(1), 7)}`);
console.log(
  '\n※ route-sweep.test.ts 는 ~1,100개 검사를 배열 단언으로 묶어 실행하므로 정적 카운트가 실제보다 크게 낮다.',
);
