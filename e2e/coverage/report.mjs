// Turn the raw V8 coverage the fixtures wrote (coverage-e2e/raw/*.json — url + functions only)
// into lcov + HTML via monocart-coverage-reports, mapping bundle offsets back to client/src
// through the Vite sourcemaps that sit next to the built chunks in client/dist/assets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MCR from 'monocart-coverage-reports';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rawDir = path.join(root, 'coverage-e2e', 'raw');
const outDir = path.join(root, 'coverage-e2e', 'report'); // monocart wipes its outputDir — keep raw/ outside it
const finalLcov = path.join(root, 'coverage-e2e', 'lcov.info');
const assets = path.join(root, 'client', 'dist', 'assets');

const TARGETS = [
  'client/src/components/MeetingView.tsx',
  'client/src/components/DocEditor.tsx',
  'client/src/components/CanvasBoard.tsx',
  'client/src/components/CollabFiles.tsx',
  'client/src/components/MeetingHub.tsx',
];

if (!fs.existsSync(rawDir)) {
  console.error(`no raw coverage at ${rawDir} — run: npm run e2e:cov`);
  process.exit(1);
}

const mcr = MCR({
  name: 'exist client — Playwright E2E coverage',
  outputDir: outDir,
  cleanCache: true,
  logging: 'error',
  reports: [['v8', { outputFile: 'index.html' }], ['lcovonly', { file: 'lcov.info' }]],
  entryFilter: (entry) => entry.url.includes('/assets/') && entry.url.endsWith('.js'),
  sourceFilter: (sp) => {
    const s = (typeof sp === 'string' ? sp : sp?.url ?? sp?.sourcePath ?? '').replace(/\\/g, '/');
    return s.includes('/src/') && !s.includes('node_modules');
  },
  sourcePath: (fp) => {
    const norm = fp.replace(/\\/g, '/');
    const i = norm.indexOf('src/');
    return i >= 0 ? `client/${norm.slice(i)}` : norm;
  },
});

const cache = new Map();
const loadBundle = (url) => {
  const file = path.join(assets, path.basename(new URL(url).pathname));
  if (!cache.has(file)) {
    if (!fs.existsSync(file)) {
      cache.set(file, null);
    } else {
      const source = fs.readFileSync(file, 'utf8');
      const mapFile = `${file}.map`;
      const sourceMap = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : undefined;
      cache.set(file, { source, sourceMap });
    }
  }
  return cache.get(file);
};

let files = 0;
let entriesTotal = 0;
for (const f of fs.readdirSync(rawDir).filter((n) => n.endsWith('.json'))) {
  const raw = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));
  const entries = [];
  for (const e of raw) {
    const b = loadBundle(e.url);
    if (!b) continue;
    entries.push({ url: e.url, functions: e.functions, source: b.source, sourceMap: b.sourceMap });
  }
  if (entries.length) {
    await mcr.add(entries);
    files++;
    entriesTotal += entries.length;
  }
}
console.log(`[e2e-cov] merged ${entriesTotal} script entries from ${files} page dumps`);
await mcr.generate();

// ── post-process lcov: keep only client/src records (drop un-mapped dist chunks) and write SF as
// absolute native paths — the same form istanbul/vitest's lcov reporter emits — so the file can be
// merged 1:1 with `cd client && npx vitest run --coverage --coverage.reporter=lcov`.
const lcovFile = path.join(outDir, 'lcov.info');
const rawLcov = fs.readFileSync(lcovFile, 'utf8');
const perFile = new Map();
const kept = [];
let cur = null;
let block = [];
for (const line of rawLcov.split('\n')) {
  if (line.startsWith('SF:')) {
    const rel = line.slice(3).trim().replace(/\\/g, '/');
    cur = { sf: rel, lf: 0, lh: 0, fnf: 0, fnh: 0, brf: 0, brh: 0 };
    block = [`SF:${path.resolve(root, rel)}`];
    continue;
  }
  if (!cur) continue;
  block.push(line);
  if (line.startsWith('LF:')) cur.lf = +line.slice(3);
  else if (line.startsWith('LH:')) cur.lh = +line.slice(3);
  else if (line.startsWith('FNF:')) cur.fnf = +line.slice(4);
  else if (line.startsWith('FNH:')) cur.fnh = +line.slice(4);
  else if (line.startsWith('BRF:')) cur.brf = +line.slice(4);
  else if (line.startsWith('BRH:')) cur.brh = +line.slice(4);
  else if (line.startsWith('end_of_record')) {
    if (cur.sf.startsWith('client/src/')) {
      perFile.set(cur.sf, cur);
      kept.push(block.join('\n'));
    }
    cur = null;
    block = [];
  }
}
fs.writeFileSync(finalLcov, kept.join('\n') + '\n');
fs.rmSync(lcovFile, { force: true });
const pct = (h, f) => (f ? ((100 * h) / f).toFixed(2) + '%' : 'n/a');
const findFile = (t) => [...perFile.values()].find((r) => r.sf.endsWith(t) || r.sf.endsWith(t.replace(/^client\//, '')));
const lines = ['', 'E2E line coverage (client/src, from Playwright runs only)', '-'.repeat(72)];
for (const t of TARGETS) {
  const r = findFile(t);
  lines.push(
    r
      ? `${t.padEnd(46)} lines ${pct(r.lh, r.lf).padStart(7)} (${r.lh}/${r.lf})  funcs ${pct(r.fnh, r.fnf)}`
      : `${t.padEnd(46)} (not present in coverage — never loaded?)`,
  );
}
const all = [...perFile.values()].filter((r) => /(^|\/)src\//.test(r.sf) && !r.sf.includes('node_modules'));
const tot = all.reduce((a, r) => ({ lf: a.lf + r.lf, lh: a.lh + r.lh, fnf: a.fnf + r.fnf, fnh: a.fnh + r.fnh }), { lf: 0, lh: 0, fnf: 0, fnh: 0 });
lines.push('-'.repeat(72));
lines.push(`overall client/src (${all.length} files)${' '.repeat(18)} lines ${pct(tot.lh, tot.lf).padStart(7)} (${tot.lh}/${tot.lf})  funcs ${pct(tot.fnh, tot.fnf)}`);
lines.push(
  '',
  `lcov: ${finalLcov}  (SF = absolute paths, client/src only)`,
  `html: ${path.join(outDir, 'index.html')}`,
  '',
  'merge with vitest:  cd client && npx vitest run --coverage --coverage.reporter=lcov',
  '                    npx lcov-result-merger "{client/coverage/lcov.info,coverage-e2e/lcov.info}" merged-lcov.info',
  '',
);
const summary = lines.join('\n');
console.log(summary);
fs.writeFileSync(path.join(root, 'coverage-e2e', 'summary.txt'), summary);
