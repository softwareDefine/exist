import {
  test as base,
  expect,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type TestInfo,
} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { E2EUser } from './api';

export { expect };

const COV = process.env.E2E_COVERAGE === '1';
const RAW_DIR = path.resolve(__dirname, '..', '..', 'coverage-e2e', 'raw');

/** Records every RTCPeerConnection mediasoup-client creates → `window.__pcs` (for getStats). */
const PC_PATCH = `(() => {
  const O = window.RTCPeerConnection;
  if (!O) return;
  const list = [];
  window.__pcs = list;
  function P(...a) { const pc = new O(...a); list.push(pc); return pc; }
  P.prototype = O.prototype;
  Object.setPrototypeOf(P, O);
  window.RTCPeerConnection = P;
})();`;

/** Skip the login UI: the zustand persist store reads `exist-auth` from localStorage on boot. */
export async function loginAs(ctx: BrowserContext, u: E2EUser) {
  await ctx.addInitScript(
    ({ token, user }) => {
      localStorage.setItem('exist-auth', JSON.stringify({ state: { token, user }, version: 0 }));
    },
    { token: u.token, user: u.user },
  );
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9가-힣_-]+/g, '_').slice(0, 120);

/** Per-test V8 coverage collector. Pages are flushed before their context closes. */
export class CovTracker {
  private pages: Page[] = [];
  private n = 0;
  constructor(private info: TestInfo) {}
  async track(page: Page) {
    if (!COV) return;
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    this.pages.push(page);
  }
  async flush() {
    const pages = this.pages.splice(0);
    for (const p of pages) {
      if (p.isClosed()) continue;
      try {
        const entries = await p.coverage.stopJSCoverage();
        const slim = entries
          .filter((e) => e.url.includes('/assets/') && e.url.endsWith('.js'))
          .map((e) => ({ url: e.url, functions: e.functions }));
        const name = `${sanitize(this.info.project.name + '_' + this.info.title)}-${this.n++}.json`;
        fs.writeFileSync(path.join(RAW_DIR, name), JSON.stringify(slim));
      } catch {
        /* page died mid-test — nothing to collect */
      }
    }
  }
}

export interface Session {
  ctx: BrowserContext;
  page: Page;
  user: E2EUser;
}

type Fx = {
  cov: CovTracker;
  /** Open an authenticated browser context (+page) for a user. Torn down automatically. */
  sessionFor: (user: E2EUser, opts?: BrowserContextOptions) => Promise<Session>;
};

export const test = base.extend<Fx>({
  cov: [
    async ({}, use, testInfo) => {
      const t = new CovTracker(testInfo);
      await use(t);
      await t.flush();
    },
    { auto: true },
  ],
  sessionFor: async ({ browser, cov }, use, testInfo) => {
    const sessions: Session[] = [];
    await use(async (user, opts = {}) => {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        permissions: ['microphone', 'camera'],
        ...opts,
      });
      await loginAs(ctx, user);
      await ctx.addInitScript(PC_PATCH);
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      (page as Page & { __errors?: string[] }).__errors = errors;
      await cov.track(page);
      const s = { ctx, page, user };
      sessions.push(s);
      return s;
    });
    await cov.flush();
    for (const s of sessions) {
      const errs = (s.page as Page & { __errors?: string[] }).__errors ?? [];
      if (errs.length && testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach(`console-${s.user.username}`, {
          body: errs.join('\n'),
          contentType: 'text/plain',
        });
      }
      await s.ctx.close().catch(() => {});
    }
  },
});
