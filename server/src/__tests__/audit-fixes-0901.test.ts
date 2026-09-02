import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/* 9/1 커버리지 감사에서 나온 4건 — 회귀 방지 */

describe('sameDecision — 수치 불일치·짧은 문장', async () => {
  const { sameDecision } = await import('../recap.js');
  it('같은 문장에 숫자만 다르면 다른 결정이다', () => {
    expect(sameDecision('방열판 두께 3mm로 확정', '방열판 두께 5mm로 확정')).toBe(false);
    expect(sameDecision('검사 설비 온도 180도로 세팅', '검사 설비 온도 200도로 세팅')).toBe(false);
  });
  it('숫자까지 같으면 표현이 달라도 같은 결정', () => {
    expect(sameDecision('방열판 두께 3mm로 확정했다', '방열판 두께 3mm 확정한다')).toBe(true);
  });
  it('짧은 문장은 바이그램 몇 개 겹쳐도 병합하지 않는다', () => {
    expect(sameDecision('검사 강화', '검사 완화')).toBe(false);
    expect(sameDecision('야간조 폐지', '야간조 유지')).toBe(false);
    expect(sameDecision('야간조 폐지', '야간조 폐지한다')).toBe(true); // 포함 관계는 여전히 같은 결정
  });
});

describe('briefGrounded — nowbar 브리핑 근거 게이트', async () => {
  const { briefGrounded } = await import('../agent.js');
  const facts = ['30분 뒤 "주간 회의"가 시작된다', '마감 지난 할 일이 2개 있다', '확인 안 한 결정이 1건 있다'];
  it('facts의 제목·숫자를 담은 문장은 통과', () => {
    expect(briefGrounded('"주간 회의"가 30분 뒤에 시작돼요', facts)).toBe(true);
    expect(briefGrounded('마감 지난 할 일 2개부터 정리해요', facts)).toBe(true);
  });
  it('facts에 없는 숫자·제목·내용은 거른다', () => {
    expect(briefGrounded('내일 9시 출장 준비를 해요', facts)).toBe(false); // 9·출장 모두 근거 없음
    expect(briefGrounded('"품질 회의"가 곧 시작돼요', facts)).toBe(false); // 지어낸 제목
    expect(briefGrounded('오늘 날씨가 좋으니 산책해요', facts)).toBe(false);
  });
  it('facts가 비어 있으면 일반 문장 허용', () => {
    expect(briefGrounded('오늘 처리할 게 없어요', [])).toBe(true);
  });
});

describe('db 마이그레이션 — 짝 컬럼 중 첫 번째만 있는 DB', () => {
  it('둘째 컬럼(recovery_salt·period_end·recur_until)이 추가된다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exist-partial-'));
    const old = new Database(path.join(dir, 'exist.sqlite'));
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), recovery_hash TEXT);
      CREATE TABLE meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        host_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), period_start TEXT);
      CREATE TABLE meeting_events (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL REFERENCES meetings(id),
        title TEXT NOT NULL, date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), recur TEXT);
    `);
    old.close();
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    try {
      const mod = await import('../db.js?partial=' + Date.now());
      const db = (mod as { default: Database.Database }).default;
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols('users')).toContain('recovery_salt');
      expect(cols('meetings')).toContain('period_end');
      expect(cols('meeting_events')).toContain('recur_until');
      db.close();
    } finally {
      process.env.DATA_DIR = prev;
    }
  });

describe('pending-decisions — 철회 제외 (9/2 E2E 발견)', () => {
  it('철회된 결정은 홈 인박스(확인 대기)에서 빠진다', async () => {
    const request = (await import('supertest')).default;
    const { createApp } = await import('../app.js');
    const db = (await import('../db.js')).default;
    const app = createApp();
    const r = await request(app).post('/api/auth/register').send({ username: 'pw_user', password: 'password123' });
    const H = { Authorization: `Bearer ${r.body.token}` };
    const code = (await request(app).post('/api/meetings').set(H).send({ title: '철회' })).body.code as string;
    const mid = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
    const rid = db.prepare("INSERT INTO meeting_recaps (meeting_id, summary, decisions, attendees) VALUES (?, 's', ?, '[]')")
      .run(mid, JSON.stringify(['살아있는 결정', '철회된 결정'])).lastInsertRowid as number;
    db.prepare('UPDATE meeting_recaps SET decision_state = ? WHERE id = ?')
      // 실제 withdrawDecision 이 쓰는 canonical 형태 (db.ts 주석·rag.ts 와 동일: {status:'withdrawn', ...})
      .run(JSON.stringify([null, { status: 'withdrawn', reason: '재검토', by: 'pw_user', at: new Date().toISOString() }]), rid);
    const p = await request(app).get('/api/agent/pending-decisions?org=personal').set(H);
    expect(p.status).toBe(200);
    expect(p.body.items.map((x: { decision: string }) => x.decision)).toEqual(['살아있는 결정']);
  });
});
});
