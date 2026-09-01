import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';

const app = createApp();

/* 홈 "최근 결정" 카드 (9/2) — 내 그룹 원장의 최신 결정을 스코프별로, 철회 제외, 확인 N/M 포함 */

async function register(username: string) {
  const r = await request(app).post('/api/auth/register').send({ username, password: 'password123' });
  return r.body as { token: string; user: { id: number } };
}

describe('GET /api/agent/recent-decisions', () => {
  it('최신순·철회 제외·확인 N/M·mine, limit, 스코프(personal/org), 비참가 그룹 제외', async () => {
    const host = await register('rd_host');
    const mem = await register('rd_mem');
    const other = await register('rd_other');
    const H = (t: string) => ({ Authorization: `Bearer ${t}` });
    // 개인 회의(host+mem) / 조직 회의(host만) / 남의 회의(other만)
    const m1 = (await request(app).post('/api/meetings').set(H(host.token)).send({ title: '생산1팀' })).body.code as string;
    await request(app).post('/api/meetings/join').set(H(mem.token)).send({ code: m1 });
    const org = (await request(app).post('/api/orgs').set(H(host.token)).send({ name: '조직' })).body as { id: number };
    const m2 = (await request(app).post('/api/meetings').set(H(host.token)).send({ title: '조직회의', org_id: org.id })).body.code as string;
    const m3 = (await request(app).post('/api/meetings').set(H(other.token)).send({ title: '남의회의' })).body.code as string;
    const id = (code: string) => (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;

    const ins = db.prepare(
      "INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, criticals, attendees, created_at) VALUES (?, 's', ?, ?, ?, '[]', ?)",
    );
    const r1 = ins.run(id(m1), JSON.stringify(['냉각수 63도로 유지', '야간조 점검 2회']), JSON.stringify(['발열 테스트', '']), JSON.stringify([true, false]), '2026-09-01 01:00:00').lastInsertRowid as number;
    const r2 = ins.run(id(m1), JSON.stringify(['방열판 3mm 확정']), JSON.stringify(['']), JSON.stringify([false]), '2026-09-01 02:00:00').lastInsertRowid as number;
    ins.run(id(m2), JSON.stringify(['조직 결정 A']), JSON.stringify(['']), JSON.stringify([false]), '2026-09-01 03:00:00');
    ins.run(id(m3), JSON.stringify(['남의 결정']), JSON.stringify(['']), JSON.stringify([false]), '2026-09-01 04:00:00');
    // r2의 결정은 철회, r1[0]은 mem이 확인
    db.prepare('UPDATE meeting_recaps SET decision_state = ? WHERE id = ?').run(JSON.stringify([{ withdrawn: true, reason: '재검토' }]), r2);
    db.prepare('INSERT INTO decision_acks (recap_id, decision_idx, user_id) VALUES (?, 0, ?)').run(r1, mem.user.id);

    // personal 스코프, mem 시점
    const p = await request(app).get('/api/agent/recent-decisions?org=personal').set(H(mem.token));
    expect(p.status).toBe(200);
    expect(p.body.items.map((x: { decision: string }) => x.decision)).toEqual(['냉각수 63도로 유지', '야간조 점검 2회']); // 철회·조직·남의 것 제외
    expect(p.body.items[0]).toMatchObject({ recapId: r1, idx: 0, why: '발열 테스트', critical: true, code: m1, title: '생산1팀', acked: 1, total: 2, mine: true });
    expect(p.body.items[1]).toMatchObject({ idx: 1, why: '', critical: false, acked: 0, total: 2, mine: false });
    expect(p.body.items[0].ts).toBeGreaterThan(0);

    // host 시점: 같은 결정이지만 mine=false, limit=1
    const h = await request(app).get('/api/agent/recent-decisions?org=personal&limit=1').set(H(host.token));
    expect(h.body.items).toHaveLength(1);
    expect(h.body.items[0]).toMatchObject({ decision: '냉각수 63도로 유지', mine: false, acked: 1, total: 2 });

    // org 스코프: 조직 회의만
    const o = await request(app).get(`/api/agent/recent-decisions?org=${org.id}`).set(H(host.token));
    expect(o.body.items.map((x: { decision: string }) => x.decision)).toEqual(['조직 결정 A']);
    // 조직 비멤버는 403, 결정 없는 사용자는 빈 배열
    expect((await request(app).get(`/api/agent/recent-decisions?org=${org.id}`).set(H(mem.token))).status).toBe(403);
    const none = await register('rd_none');
    expect((await request(app).get('/api/agent/recent-decisions?org=personal').set(H(none.token))).body).toEqual({ items: [] });
    expect((await request(app).get('/api/agent/recent-decisions')).status).toBe(401);
  });
});
