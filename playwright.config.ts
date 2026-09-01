import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeToneWav } from './e2e/lib/wav';

/* Playwright E2E — real Chromium + the real mediasoup server.
 * - webServer[0]: local stub that stands in for the OpenAI Realtime WS (live captions) AND for
 *   the OpenAI REST API (every request 500s fast so the app falls back to its rule-based paths).
 * - webServer[1]: builds client (with sourcemaps) + server, then boots `node dist/index.js`
 *   against a fresh temp DATA_DIR. E2E_SKIP_BUILD=1 reuses the existing dist.
 * - E2E_COVERAGE=1 makes the fixtures collect V8 JS coverage per page → coverage-e2e/raw/. */

const root = __dirname;
const port = Number(process.env.E2E_PORT ?? 4599);
const sttPort = Number(process.env.E2E_STT_PORT ?? 4598);
const baseURL = `http://127.0.0.1:${port}`;
const dataDir =
  process.env.E2E_DATA_DIR ?? path.join(os.tmpdir(), 'exist-e2e', `run-${Date.now()}-${process.pid}`);
const tmp = path.join(root, 'e2e', '.tmp');
fs.mkdirSync(tmp, { recursive: true });
const wav = path.join(tmp, 'tone-16k.wav');
if (!fs.existsSync(wav)) writeToneWav(wav);

const coverage = process.env.E2E_COVERAGE === '1';
// This file is evaluated again inside every worker process — only the runner may wipe the dumps.
if (coverage && !process.env.TEST_WORKER_INDEX) {
  const raw = path.join(root, 'coverage-e2e', 'raw');
  fs.rmSync(raw, { recursive: true, force: true });
  fs.mkdirSync(raw, { recursive: true });
}

// Shared with test workers (they inherit process.env).
process.env.E2E_DATA_DIR = dataDir;
process.env.E2E_BASE_URL = baseURL;
process.env.E2E_STT_PORT = String(sttPort);

const chromiumArgs = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${wav}`,
  '--autoplay-policy=no-user-gesture-required',
  '--disable-dev-shm-usage',
];

export default defineConfig({
  testDir: path.join(root, 'e2e'),
  testMatch: /.*\.spec\.ts$/,
  outputDir: path.join(root, 'e2e', '.results'),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 2,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: path.join(root, 'e2e', '.report'), open: 'never' }]],
  use: {
    baseURL,
    // Playwright's headless-shell build crashes the renderer on /meeting (WebRTC preview);
    // the full Chromium in new-headless mode is fine.
    channel: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    launchOptions: { args: chromiumArgs },
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /mobile\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      testMatch: /mobile\.spec\.ts$/,
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: [
    {
      command: 'node e2e/stt-stub.mjs',
      url: `http://127.0.0.1:${sttPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { STT_STUB_PORT: String(sttPort) },
    },
    {
      command: 'node e2e/start-server.mjs',
      url: `${baseURL}/api/health`,
      reuseExistingServer: false,
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: String(port),
        DATA_DIR: dataDir,
        NODE_ENV: 'production',
        // Live-caption path: server opens a WS to this URL (stub answers like OpenAI Realtime).
        OPENAI_API_KEY: 'sk-test-e2e',
        OPENAI_REALTIME_URL: `ws://127.0.0.1:${sttPort}/realtime`,
        // Every other OpenAI call hits the stub over HTTP and fails fast → rule-based fallbacks.
        OPENAI_BASE_URL: `http://127.0.0.1:${sttPort}/v1`,
        // Short recap grace so call-end recaps do not linger.
        RECAP_GRACE_MS: '500',
      },
    },
  ],
});
