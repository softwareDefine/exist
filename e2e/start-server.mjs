// webServer launcher: build client (+sourcemaps) and server once, then boot the production
// server against the temp DATA_DIR that playwright.config.ts chose. E2E_SKIP_BUILD=1 → reuse dist.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'client');
const server = path.join(root, 'server');
const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error('DATA_DIR missing');

const run = (cmd, cwd) => {
  console.log(`[e2e] ${cmd}  (${path.relative(root, cwd)})`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: true });
};

const skip =
  process.env.E2E_SKIP_BUILD === '1' && fs.existsSync(path.join(client, 'dist', 'index.html'));
if (!skip) {
  const t0 = Date.now();
  run('npx tsc && npx vite build --sourcemap', client);
  run('npx tsc', server);
  console.log(`[e2e] build done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else {
  console.log('[e2e] E2E_SKIP_BUILD=1 — reusing client/dist + server/dist');
}

// Best-effort prune of previous runs' data dirs (each run gets a fresh sibling under exist-e2e/).
try {
  const parent = path.dirname(dataDir);
  if (path.basename(parent) === 'exist-e2e') {
    for (const d of fs.readdirSync(parent)) {
      const full = path.join(parent, d);
      if (full !== dataDir && d.startsWith('run-')) fs.rmSync(full, { recursive: true, force: true });
    }
  }
} catch {
  /* locked by a live run — leave it */
}
fs.mkdirSync(dataDir, { recursive: true });
console.log(`[e2e] DATA_DIR=${dataDir}`);
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: server,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    child.kill();
    process.exit(0);
  });
}
