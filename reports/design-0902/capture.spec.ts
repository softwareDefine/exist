/* Design capture + metrics — 2026-09-02.
 * TEMPORARY spec (not a regression test): seeds realistic data, screenshots 9 screens × 4
 * viewports into reports/design-0902/shots/, measures contrast / font sizes / touch targets /
 * horizontal overflow / visual hierarchy per screen, and writes reports/design-0902/metrics.md.
 * Run: npx playwright test design-capture-0902 --project=desktop --workers=1
 */
import fs from 'node:fs';
import path from 'node:path';
import { test } from './lib/fixtures';
import { api, type E2EUser } from './lib/api';
import { openDb, seedRecap } from './lib/db';

const OUT = path.resolve(__dirname, '..', 'reports', 'design-0902');
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'desktop', width: 1920, height: 1080 },
] as const;

/* ── in-page metrics (runs via page.evaluate) ─────────────────────────────── */
type Metrics = {
  contrast: { sel: string; text: string; ratio: number; need: number; fg: string; bg: string; size: number; weight: number }[];
  smallFonts: { sel: string; text: string; size: number }[];
  smallTargets: { sel: string; text: string; w: number; h: number }[];
  overflow: { scrollWidth: number; clientWidth: number };
  hierarchy: { topScore: number; size: number; weight: number; ties: number; samples: string[] };
  scanned: number;
  bgSkipped: number;
};

function collectMetrics(): Metrics {
  const out: Metrics = {
    contrast: [], smallFonts: [], smallTargets: [],
    overflow: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
    hierarchy: { topScore: 0, size: 0, weight: 0, ties: 0, samples: [] },
    scanned: 0, bgSkipped: 0,
  };
  const parse = (c: string): [number, number, number, number] | null => {
    const m = c.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)/);
    if (!m) return c === 'transparent' ? [0, 0, 0, 0] : null;
    return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (top: number[], bot: number[]): number[] => {
    const a = top[3] + bot[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat(a);
  };
  const selOf = (el: Element): string => {
    const part = (e: Element) => {
      let s = e.tagName.toLowerCase();
      if (e.id) return s + '#' + e.id;
      const cls = Array.from(e.classList).slice(0, 2).join('.');
      return cls ? s + '.' + cls : s;
    };
    const p = el.parentElement;
    return p && p !== document.body ? part(p) + ' > ' + part(el) : part(el);
  };
  const visible = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  /** background of el composited up the ancestor chain; null = image/gradient in the way */
  const bgOf = (el: Element): number[] | null => {
    const stack: number[][] = [];
    let n: Element | null = el;
    while (n) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; }
      n = n.parentElement;
    }
    let bg = [255, 255, 255, 1]; // canvas default
    for (let i = stack.length - 1; i >= 0; i--) bg = over(stack[i], bg);
    return bg;
  };

  const all = document.body.querySelectorAll('*');
  let top: { score: number; size: number; weight: number; els: Element[] } = { score: 0, size: 0, weight: 0, els: [] };
  for (const el of Array.from(all)) {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'svg', 'path', 'canvas', 'noscript'].includes(tag)) continue;
    const direct = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0)
      .map((n) => (n.textContent ?? '').trim())
      .join(' ');
    if (!direct) continue;
    if (!visible(el)) continue;
    out.scanned++;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    // 1) contrast
    const fg = parse(cs.color);
    const bg = bgOf(el);
    if (!bg) out.bgSkipped++;
    else if (fg) {
      const fgFlat = fg[3] < 1 ? over(fg, bg) : fg;
      const L1 = lum(fgFlat), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        out.contrast.push({
          sel: selOf(el), text: direct.slice(0, 20), ratio: Math.round(ratio * 100) / 100, need,
          fg: cs.color, bg: `rgb(${bg.slice(0, 3).map(Math.round).join(',')})`, size: Math.round(size * 10) / 10, weight,
        });
      }
    }
    // 2) body-ish font sizes
    if (['p', 'td', 'li', 'span'].includes(tag) && direct.length >= 20 && size < 16) {
      out.smallFonts.push({ sel: selOf(el), text: direct.slice(0, 20), size: Math.round(size * 10) / 10 });
    }
    // 5) hierarchy — biggest size×weight
    const score = size * weight;
    if (score > top.score + 0.01) top = { score, size, weight, els: [el] };
    else if (Math.abs(score - top.score) <= 0.01) top.els.push(el);
  }
  out.hierarchy = {
    topScore: Math.round(top.score), size: Math.round(top.size * 10) / 10, weight: top.weight,
    ties: top.els.length,
    samples: top.els.slice(0, 4).map((e) => (e.textContent ?? '').trim().slice(0, 30)),
  };
  // 3) touch targets (caller decides to report only on mobile)
  const seen = new Set<Element>();
  const cands = document.querySelectorAll('button, a, [role="button"], [onclick]');
  for (const el of Array.from(cands)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 44 && r.height >= 44) continue;
    // exclude fully covered elements (best effort — only checkable inside the viewport)
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) continue; // covered by something else
    }
    const label = (el.textContent ?? (el as HTMLElement).title ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 20);
    out.smallTargets.push({ sel: selOf(el), text: label, w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out;
}

/* ── the capture run ──────────────────────────────────────────────────────── */
interface Shot { screen: string; viewport: string; png: string | null; fail?: string; metrics?: Metrics }
const results: Shot[] = [];

test('design capture 0902', async ({ browser, sessionFor }) => {
  test.setTimeout(1_500_000);

  /* seed — users with display names */
  const mk = async (username: string, name: string): Promise<E2EUser> => {
    const uname = `${username}_${Math.random().toString(36).slice(2, 6)}`.slice(0, 20);
    const r = await api<{ token: string; user: E2EUser['user'] }>('/api/auth/register', {
      body: { username: uname, password: 'e2e-password-123', name },
    });
    return { token: r.token, user: r.user, username: uname };
  };
  const A = await mk('cap_juho', '이주호');
  const B = await mk('cap_sohee', '김소희');
  const C = await mk('cap_minsu', '박민수');

  const M1 = await api<{ id: number; code: string }>('/api/meetings', { body: { title: '주간 품질 회의' }, token: A.token });
  await api('/api/meetings/join', { body: { code: M1.code }, token: B.token });
  await api('/api/meetings/join', { body: { code: M1.code }, token: C.token });

  const org = await api<{ id: number; joinCode: string }>('/api/orgs', { body: { name: '런타임 제조' }, token: A.token });
  for (const u of [B, C]) {
    await api('/api/orgs/join', { body: { joinCode: org.joinCode }, token: u.token });
    await api(`/api/orgs/${org.id}/members/${u.user.id}/approve`, { method: 'POST', body: {}, token: A.token });
  }
  {
    const db = openDb();
    const set = db.prepare('UPDATE organization_members SET tier = ?, department = ?, position = ? WHERE org_id = ? AND user_id = ?');
    set.run('relay', '생산 1팀', '팀장', org.id, A.user.id);
    set.run('field', '생산 1팀', '작업반장', org.id, B.user.id);
    set.run('field', '생산 1팀', '설비담당', org.id, C.user.id);
    // chat lines in M1's default channel (channel_id NULL renders in 일반)
    const say = db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)');
    say.run(M1.id, A.user.id, '이번 주 방열판 라인 점검 일정 공유합니다. 목요일 오전에 설비 세워요.');
    say.run(M1.id, B.user.id, '확인했습니다. 목요일 오전이면 1라인 먼저 세우는 거죠?');
    say.run(M1.id, C.user.id, '점검표는 파일 탭에 올려둘게요. 서명 부탁드립니다.');
    say.run(M1.id, A.user.id, '결정 사항은 기록 탭에서 확인 눌러주세요. 미확인 2건 남아 있어요.');
    db.close();
  }
  const M2 = await api<{ code: string }>('/api/meetings', { body: { title: '생산 1팀 조회', org_id: org.id }, token: A.token });
  await api('/api/meetings/join', { body: { code: M2.code }, token: B.token });

  // this week's events (today = server date)
  const d0 = new Date();
  const iso = (offset: number) => {
    const d = new Date(d0); d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  await api(`/api/meetings/${M1.code}/events`, { body: { title: '주간 품질 회의', date: iso(0), time: '10:00', end_time: '11:00', is_call: true, color: 'blue' }, token: A.token });
  await api(`/api/meetings/${M1.code}/events`, { body: { title: '1라인 설비 점검', date: iso(1), time: '09:00', end_time: '12:00', color: 'orange' }, token: A.token });
  await api(`/api/meetings/${M1.code}/events`, { body: { title: '방열판 시제품 검수', date: iso(2), time: '14:00', end_time: '15:30', color: 'green' }, token: B.token });

  // decisions — recap with 2 (one acked by all, one critical + unacked)
  const recapId = seedRecap({
    meetingId: M1.id,
    summary: '주간 품질 회의 — 방열판 라인 점검 및 설계 변경 논의',
    decisions: ['주간 정기 점검을 목요일 오전으로 옮긴다', '방열판 두께를 3mm로 변경한다'],
    whys: ['수요일 출하와 겹쳐 라인을 세울 수 없음', '진동 시험에서 2mm 균열 발생'],
    criticals: [false, true],
    attendees: [A.username, B.username, C.username],
  });
  for (const u of [A, B, C]) {
    await api(`/api/meetings/${M1.code}/decisions/ack`, { body: { recapId, idx: 0 }, token: u.token });
  }

  // files — a doc with 열람 서명(회람) required + a second doc
  const f1 = await api<{ id: number }>(`/api/meetings/${M1.code}/files`, { body: { name: '방열판 설계 변경 공지', type: 'doc' }, token: A.token });
  await api(`/api/meetings/${M1.code}/files/${f1.id}/ack-request`, { body: { on: true }, token: A.token });
  await api(`/api/meetings/${M1.code}/files`, { body: { name: '9월 설비 점검표', type: 'doc' }, token: C.token });

  /* capture loop */
  const shoot = async (page: import('@playwright/test').Page, screen: string, vp: string) => {
    const file = path.join(SHOTS, `${screen}-${vp}.png`);
    await page.waitForTimeout(700);
    await page.screenshot({ path: file, fullPage: true });
    const metrics = (await page.evaluate(collectMetrics)) as Metrics;
    results.push({ screen, viewport: vp, png: file, metrics });
  };
  const openTab = (page: import('@playwright/test').Page, tab: string) =>
    page.evaluate(({ code, tab: t }) => {
      window.dispatchEvent(new CustomEvent('exist:open-meeting', { detail: { code, title: '주간 품질 회의', tab: t } }));
    }, { code: M1.code, tab });

  for (const vp of VIEWPORTS) {
    const viewport = { width: vp.width, height: vp.height };

    // 1) login — unauthenticated context
    try {
      const ctx = await browser.newContext({ viewport });
      const p = await ctx.newPage();
      await p.goto('/login');
      await p.waitForLoadState('networkidle').catch(() => {});
      await shoot(p, 'login', vp.name);
      await ctx.close();
    } catch (e) {
      results.push({ screen: 'login', viewport: vp.name, png: null, fail: String(e).slice(0, 200) });
    }

    // authed session for everything else
    const S = await sessionFor(A, { viewport });
    const p = S.page;
    const safe = async (screen: string, fn: () => Promise<void>) => {
      try { await fn(); await shoot(p, screen, vp.name); }
      catch (e) { results.push({ screen, viewport: vp.name, png: null, fail: String(e).slice(0, 200) }); }
    };

    await safe('home-personal', async () => {
      await p.goto('/');
      await p.locator('.dashboard').waitFor({ timeout: 20_000 });
      await p.waitForLoadState('networkidle').catch(() => {});
    });
    await safe('hub-chat', async () => {
      await openTab(p, 'chat');
      await p.locator('.hub-chat-input').waitFor({ timeout: 20_000 });
      await p.waitForLoadState('networkidle').catch(() => {});
    });
    await safe('schedule-week', async () => {
      await openTab(p, 'schedule');
      const seg = p.locator('.msched-seg button[data-key="week"]').first();
      if (await seg.isVisible().catch(() => false)) {
        await seg.click();
      } else {
        // 모바일 — PillSeg 대신 보기 형태 알약 메뉴 ('이틀' = 주 뷰)
        await p.locator('.msched-viewpill .vp-view').first().click();
        await p.locator('.msched-view-menu button', { hasText: '이틀' }).first().click();
      }
      await p.waitForTimeout(600);
    });
    await safe('ledger', async () => {
      await openTab(p, 'decisions');
      await p.locator('.ledger-item').first().waitFor({ timeout: 20_000 });
    });
    await safe('files', async () => {
      await openTab(p, 'files');
      // 데스크톱=탐색기(.cf-entry) / 모바일=트리 사이드(.cf-tree) + 확인 필요 배너(.cf-mack)
      await p.getByText('방열판 설계 변경 공지').first().waitFor({ timeout: 20_000 });
      // select the 회람 doc so the detail/manage panel shows (desktop explorer only)
      await p.locator('.cf-entry', { hasText: '방열판 설계 변경 공지' }).first().click({ timeout: 3_000 }).catch(() => {});
      // 모바일 — 확인 필요 배너 펼쳐서 회람 목록이 보이게
      await p.locator('.cf-mack-banner').first().click({ timeout: 2_000 }).catch(() => {});
      await p.waitForTimeout(400);
    });
    await safe('hub-settings', async () => {
      await openTab(p, 'settings');
      await p.waitForTimeout(800);
    });
    await safe('home-org', async () => {
      await p.evaluate(({ key, val }) => localStorage.setItem(key, val),
        { key: `exist:org-context:${A.username}`, val: String(org.id) });
      await p.goto('/');
      await p.locator('.dashboard').waitFor({ timeout: 20_000 });
      await p.waitForLoadState('networkidle').catch(() => {});
      await p.waitForTimeout(800);
    });
    await safe('orgchart', async () => {
      await p.goto(`/org/${org.id}`);
      await p.waitForLoadState('networkidle').catch(() => {});
      await p.waitForTimeout(800);
    });
    await S.ctx.close();
  }

  /* report */
  fs.writeFileSync(path.join(OUT, 'metrics-raw.json'), JSON.stringify(results, null, 1));
  fs.writeFileSync(path.join(OUT, 'metrics.md'), buildReport());
});

function buildReport(): string {
  const L: string[] = [];
  const screens = [...new Set(results.map((r) => r.screen))];
  const vps = VIEWPORTS.map((v) => v.name);
  const get = (s: string, v: string) => results.find((r) => r.screen === s && r.viewport === v);
  const fmt = (n: number) => String(n);

  L.push('# exist 디자인 계측 리포트 — 2026-09-02');
  L.push('');
  L.push(`실측 기반: Playwright(Chromium) 실 DOM \`getComputedStyle\` 측정. 뷰포트 4단계: 모바일 390×844 / 태블릿 768×1024 / 노트북 1366×768 / 데스크탑 1920×1080.`);
  L.push('');
  L.push('심각도 기준: **Major** = 대비 < 3:1, 모바일 가로 스크롤. **Minor** = 대비 < 기준(4.5:1, 큰 텍스트 3:1), 모바일 터치 타겟 < 44×44. **Cosmetic** = 모바일 본문 폰트 < 16px, 시각적 1순위 동률.');
  L.push('');

  /* summary table */
  L.push('## 요약 — 화면 × 뷰포트 위반 카운트');
  L.push('');
  L.push('표기 — 모바일: `대비Major/대비Minor · 터치타겟<44 · 본문<16px · 가로스크롤` / 그 외: `대비Major/대비Minor · 가로스크롤`');
  L.push('');
  L.push('| 화면 | ' + vps.join(' | ') + ' |');
  L.push('|---|' + vps.map(() => '---').join('|') + '|');
  for (const s of screens) {
    const row = vps.map((v) => {
      const r = get(s, v);
      if (!r) return '—';
      if (!r.metrics) return `❌ 실패`;
      const m = r.metrics;
      const cMaj = m.contrast.filter((c) => c.ratio < 3).length;
      const cMin = m.contrast.length - cMaj;
      const ovf = m.overflow.scrollWidth - m.overflow.clientWidth;
      const parts = [`${cMaj}/${cMin}`];
      if (v === 'mobile') {
        parts.push(fmt(m.smallTargets.length), fmt(m.smallFonts.length));
      }
      parts.push(ovf > 1 ? `**+${ovf}px**` : '0');
      return parts.join(' · ');
    });
    L.push(`| ${s} | ${row.join(' | ')} |`);
  }
  L.push('');

  /* horizontal overflow */
  L.push('## 가로 오버플로');
  const ovf = results.filter((r) => r.metrics && r.metrics.overflow.scrollWidth > r.metrics.overflow.clientWidth + 1);
  if (!ovf.length) L.push('- 없음 — 모든 화면·뷰포트에서 `scrollWidth ≤ clientWidth`.');
  for (const r of ovf) {
    const sev = r.viewport === 'mobile' ? 'Major' : 'Minor';
    L.push(`- **[${sev}]** ${r.screen} @ ${r.viewport}: scrollWidth ${r.metrics!.overflow.scrollWidth} > clientWidth ${r.metrics!.overflow.clientWidth}`);
  }
  L.push('');

  /* per-screen details */
  const cap = <T,>(arr: T[], n: number) => ({ shown: arr.slice(0, n), more: Math.max(0, arr.length - n) });
  for (const s of screens) {
    L.push(`## ${s}`);
    for (const v of vps) {
      const r = get(s, v);
      if (!r) continue;
      if (!r.metrics) { L.push(`- ${v}: ❌ 캡처 실패 — ${r.fail ?? '?'}`); continue; }
      const m = r.metrics;
      const bits: string[] = [];
      if (m.contrast.length) {
        const c = cap(m.contrast.sort((a, b) => a.ratio - b.ratio), 15);
        bits.push(`**대비 위반 ${m.contrast.length}건** (${v}):`);
        for (const x of c.shown) {
          const sev = x.ratio < 3 ? 'Major' : 'Minor';
          bits.push(`  - [${sev}] \`${x.sel}\` "${x.text}" — ${x.ratio}:1 (기준 ${x.need}:1, ${x.size}px w${x.weight}, ${x.fg} on ${x.bg})`);
        }
        if (c.more) bits.push(`  - …외 ${c.more}건 (metrics-raw.json 참조)`);
      }
      if (v === 'mobile' && m.smallTargets.length) {
        const c = cap(m.smallTargets.sort((a, b) => a.w * a.h - b.w * b.h), 15);
        bits.push(`**[Minor] 44px 미만 터치 타겟 ${m.smallTargets.length}건**:`);
        for (const x of c.shown) bits.push(`  - \`${x.sel}\` "${x.text}" — ${x.w}×${x.h}px`);
        if (c.more) bits.push(`  - …외 ${c.more}건`);
      }
      if (v === 'mobile' && m.smallFonts.length) {
        const c = cap(m.smallFonts.sort((a, b) => a.size - b.size), 10);
        bits.push(`**[Cosmetic] 모바일 16px 미만 본문 ${m.smallFonts.length}건**:`);
        for (const x of c.shown) bits.push(`  - \`${x.sel}\` "${x.text}" — ${x.size}px`);
        if (c.more) bits.push(`  - …외 ${c.more}건`);
      }
      const h = m.hierarchy;
      if (h.ties > 1) bits.push(`**[Cosmetic] 시각적 1순위 동률 ${h.ties}개** (${h.size}px w${h.weight}): ${h.samples.map((t) => `"${t}"`).join(', ')}`);
      else bits.push(`시각적 1순위 유일: ${h.size}px w${h.weight} "${h.samples[0] ?? ''}"`);
      if (m.bgSkipped) bits.push(`(배경 이미지/그라데이션 때문에 대비 미계산 ${m.bgSkipped}개 노드)`);
      L.push(`### ${v} — 텍스트 노드 ${m.scanned}개 스캔`);
      L.push(...bits);
      L.push('');
    }
  }

  /* png list + failures */
  L.push('## 캡처 파일');
  for (const r of results) {
    if (r.png) L.push(`- \`${r.png}\``);
  }
  const fails = results.filter((r) => !r.png);
  if (fails.length) {
    L.push('');
    L.push('## 실패한 캡처');
    for (const r of fails) L.push(`- ${r.screen} @ ${r.viewport}: ${r.fail}`);
  }
  L.push('');
  return L.join('\n');
}
