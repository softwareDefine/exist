// Summarise a Stryker JSON report (mutation-testing-elements schema).
// usage: node scripts/mutation-summary.mjs [reports/mutation/mutation.json] [--survivors] [--file src/x.ts]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const jsonPath = args.find((a) => a.endsWith('.json')) ?? 'reports/mutation/mutation.json';
const showSurvivors = args.includes('--survivors');
const onlyFile = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

let cov = {};
try {
  const c = JSON.parse(fs.readFileSync('reports/mutation/coverage/coverage-summary.json', 'utf8'));
  for (const [k, v] of Object.entries(c)) {
    if (k === 'total') continue;
    cov[path.relative(process.cwd(), k).replaceAll(path.win32.sep, '/')] = v.lines.pct;
  }
} catch {}

const STATUSES = ['Killed', 'Survived', 'Timeout', 'NoCoverage', 'RuntimeError', 'CompileError', 'Ignored'];
const rows = [];
const tot = Object.fromEntries(STATUSES.map((s) => [s, 0]));
for (const [file, f] of Object.entries(report.files)) {
  const n = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const m of f.mutants) n[m.status] = (n[m.status] ?? 0) + 1;
  for (const s of STATUSES) tot[s] += n[s];
  const detected = n.Killed + n.Timeout;
  const undetected = n.Survived + n.NoCoverage;
  const valid = detected + undetected;
  const score = valid ? (100 * detected) / valid : NaN;
  const covered = detected + n.Survived;
  const scoreCovered = covered ? (100 * detected) / covered : NaN;
  rows.push({ file: file.replaceAll(path.win32.sep, '/'), ...n, valid, score, scoreCovered, lines: cov[file.replaceAll(path.win32.sep, '/')] });
}
rows.sort((a, b) => (isNaN(a.score) ? 101 : a.score) - (isNaN(b.score) ? 101 : b.score));

const fmt = (x) => (isNaN(x) ? '  n/a' : x.toFixed(1).padStart(5));
console.log('file'.padEnd(22), 'score'.padStart(6), 'covScr'.padStart(6), 'lineCov'.padStart(7), 'killed'.padStart(6), 'surv'.padStart(5), 'tmo'.padStart(4), 'nocov'.padStart(5), 'err'.padStart(4), 'total'.padStart(5));
for (const r of rows) {
  console.log(
    r.file.padEnd(22), fmt(r.score).padStart(6), fmt(r.scoreCovered).padStart(6), (r.lines == null ? 'n/a' : r.lines.toFixed(1)).padStart(7),
    String(r.Killed).padStart(6), String(r.Survived).padStart(5), String(r.Timeout).padStart(4), String(r.NoCoverage).padStart(5),
    String(r.RuntimeError + r.CompileError).padStart(4), String(r.valid).padStart(5),
  );
}
const detected = tot.Killed + tot.Timeout;
const valid = detected + tot.Survived + tot.NoCoverage;
console.log('\nTOTAL', JSON.stringify(tot), `score=${((100 * detected) / valid).toFixed(2)}%`,
  `scoreCovered=${((100 * detected) / (detected + tot.Survived)).toFixed(2)}%`, `valid=${valid}`);

if (showSurvivors) {
  for (const [file, f] of Object.entries(report.files)) {
    const fp = file.replaceAll(path.win32.sep, '/');
    if (onlyFile && fp !== onlyFile) continue;
    const src = f.source.split('\n');
    const surv = f.mutants.filter((m) => m.status === 'Survived' || m.status === 'NoCoverage');
    if (!surv.length) continue;
    console.log(`\n=== ${fp} (${surv.length} undetected)`);
    for (const m of surv) {
      const { start, end } = m.location;
      let orig;
      if (start.line === end.line) orig = src[start.line - 1].slice(start.column - 1, end.column - 1);
      else orig = src[start.line - 1].slice(start.column - 1) + ' …(' + (end.line - start.line) + ' more lines)';
      const line = src[start.line - 1].trim();
      const noise = (/console\.(log|warn|error|info|debug)/.test(line) ? ' [LOG]' : '') + (m.static ? ' [STATIC]' : '');
      console.log(`${fp}:${start.line}:${start.column} ${m.status} ${m.mutatorName}${noise}\n    - ${orig.replace(/\s+/g, ' ').slice(0, 140)}\n    + ${m.replacement.replace(/\s+/g, ' ').slice(0, 140)}\n    | ${line.slice(0, 150)}`);
    }
  }
}
