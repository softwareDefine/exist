import { describe, it, expect, beforeAll, vi } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';

/* db.ts 마이그레이션 — (1) 옛 스키마 DB 위에서 import 해 ALTER·백필·1회 변환이 실제로 도는지,
 * (2) vi.resetModules 후 같은 파일로 다시 import 해 "이미 존재" catch 분기·플래그 스킵이 조용한지.
 * setup.ts 가 파일마다 새 DATA_DIR 을 주므로 그 안에 옛 DB 를 먼저 만든다. */

const file = path.join(process.env.DATA_DIR!, 'exist.sqlite');
type Db = typeof import('../db.js').default;
let db: Db;

const cols = (d: Db, table: string) =>
  (d.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);

beforeAll(async () => {
  const old = new Database(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE organizations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, join_code TEXT NOT NULL UNIQUE, owner_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE organization_members (org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (org_id, user_id));
    CREATE TABLE meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, host_id INTEGER NOT NULL, starts_at TEXT, ends_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meeting_participants (meeting_id INTEGER NOT NULL, user_id INTEGER NOT NULL, joined_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (meeting_id, user_id));
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, user_id INTEGER NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    -- todos 는 "중간 세대": meeting_id 는 이미 있고(ALTER catch) recap_id·reminded_* 는 없음 → todo_assignees 백필 대상 행 존재
    CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, due_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), meeting_id INTEGER);
    CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, from_name TEXT NOT NULL, text TEXT NOT NULL, kind TEXT, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meeting_events (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL, time TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE org_roles (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, name TEXT NOT NULL, perms TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE chat_channels (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, name TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE collab_files (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, parent_id INTEGER, name TEXT NOT NULL, type TEXT NOT NULL, room TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meeting_recaps (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, summary TEXT NOT NULL, decisions TEXT NOT NULL DEFAULT '[]', actions TEXT NOT NULL DEFAULT '[]', attendees TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'rule', call_ended_at TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE decision_acks (id INTEGER PRIMARY KEY AUTOINCREMENT, recap_id INTEGER NOT NULL, decision_idx INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(recap_id, decision_idx, user_id));
    CREATE TABLE handovers (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, author_id INTEGER NOT NULL, shift_label TEXT NOT NULL DEFAULT '', sections TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'ai', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE handover_acks (handover_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (handover_id, user_id));
    CREATE TABLE agenda_items (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', rounds INTEGER NOT NULL DEFAULT 1, resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE file_rev_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, rev INTEGER NOT NULL, text TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(file_id, rev));
    CREATE TABLE call_transcripts (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, user_id INTEGER NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    -- 개인 DM 이전: org_id NOT NULL
    CREATE TABLE dm_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, text TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));

    INSERT INTO users (username, pw_hash, pw_salt) VALUES ('legacy', 'h', 's');
    INSERT INTO organizations (name, join_code, owner_id) VALUES ('옛 조직', 'JOIN01', 1);
    INSERT INTO meetings (code, title, host_id) VALUES ('OLD001', '옛 회의', 1);
    INSERT INTO todos (user_id, title, meeting_id) VALUES (1, '회의 할 일', 1), (1, '개인 할 일', NULL);
    INSERT INTO org_roles (org_id, name, perms) VALUES
      (1, '인사', '["member:edit","member:approve"]'),
      (1, '그룹장', '["group:manage"]'),
      (1, '편집자', '["group:edit","group:settings"]'),
      (1, '손상', 'not json'),
      (1, '신형', '["member:remove"]');
    INSERT INTO call_transcripts (meeting_id, user_id, text) VALUES (1, 1, '옛 전사');
    INSERT INTO dm_messages (org_id, from_id, to_id, text) VALUES (1, 1, 1, '조직 DM');
  `);
  old.close();
  db = (await import('../db.js')).default;
});

describe('옛 스키마 → 현재 스키마', () => {
  it('users: 복구코드·last_seen_at·아바타(기존 행 기본값 🐧)·프로필 컬럼 추가', () => {
    expect(cols(db, 'users')).toEqual(expect.arrayContaining(['recovery_hash', 'recovery_salt', 'last_seen_at', 'avatar', 'name', 'email', 'phone', 'address']));
    expect(db.prepare("SELECT avatar FROM users WHERE username = 'legacy'").get()).toEqual({ avatar: '🐧' });
  });

  it('조직·회의·작업공간·메시지·알림·할 일·일정 컬럼 추가 (기존 행 기본값 포함)', () => {
    expect(cols(db, 'organization_members')).toEqual(expect.arrayContaining(['position', 'department', 'tier', 'role_id']));
    expect(cols(db, 'meetings')).toEqual(expect.arrayContaining(['org_id', 'settings', 'period_start', 'period_end', 'thumbnail', 'recur', 'recur_until', 'recur_except', 'call_started_at']));
    expect(db.prepare("SELECT recur, org_id FROM meetings WHERE code = 'OLD001'").get()).toEqual({ recur: 'none', org_id: null });
    expect(cols(db, 'workspaces')).toContain('org_id');
    expect(cols(db, 'messages')).toEqual(expect.arrayContaining(['file', 'channel_id']));
    expect(cols(db, 'notifications')).toEqual(expect.arrayContaining(['cleared', 'meeting_code', 'file_id']));
    expect(cols(db, 'todos')).toEqual(expect.arrayContaining(['meeting_id', 'recap_id', 'reminded_soon', 'reminded_overdue']));
    expect(cols(db, 'meeting_events')).toEqual(expect.arrayContaining(['end_time', 'is_call', 'people', 'memo', 'remind', 'recur', 'recur_until', 'color', 'end_date']));
    expect(cols(db, 'chat_channels')).toContain('kind');
  });

  it('문서·회의록·인수인계·안건·전사 컬럼 추가', () => {
    expect(cols(db, 'collab_files')).toEqual(expect.arrayContaining(['deleted_at', 'deleted_root', 'mime', 'size', 'blob_path', 'ack_required', 'rev', 'deleted_by', 'updated_at']));
    expect(cols(db, 'meeting_recaps')).toEqual(expect.arrayContaining(['files', 'decision_state', 'next_meeting', 'whys', 'alts', 'event_id', 'criticals', 'origin']));
    expect(cols(db, 'decision_acks')).toEqual(expect.arrayContaining(['note', 'signature']));
    expect(cols(db, 'handovers')).toEqual(expect.arrayContaining(['checks', 'escalated_at']));
    expect(cols(db, 'handover_acks')).toEqual(expect.arrayContaining(['note', 'echo_check', 'echo_reason', 'signature']));
    expect(cols(db, 'agenda_items')).toEqual(expect.arrayContaining(['resolved_note', 'status', 'resolved_recap_id', 'resolved_decision_idx', 'status_note']));
    expect(cols(db, 'file_rev_snapshots')).toEqual(expect.arrayContaining(['basis_recap_id', 'basis_decision_idx', 'basis_note']));
    expect(db.prepare('SELECT source FROM call_transcripts').get()).toEqual({ source: 'live' });
  });

  it('새 테이블들이 만들어진다', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'meta', 'org_audit', 'todo_assignees', 'push_subs', 'file_activity', 'file_versions', 'file_acks', 'file_acks_history',
        'file_ack_autoremind', 'decision_revisions', 'decision_remind_sent', 'handover_checklist', 'agenda_events', 'rag_chunks',
        'meeting_glossary', 'decision_ack_autoremind', 'channel_notify_prefs', 'event_acks', 'chat_reads',
      ]),
    );
  });

  it('org_roles 권한 키 1회 변환 — member:edit 세분, group:manage 전개, v3(group:edit 세분 + settings→lock), 손상은 보존', () => {
    const perms = (name: string) => JSON.parse((db.prepare('SELECT perms FROM org_roles WHERE name = ?').get(name) as { perms: string }).perms);
    expect(perms('인사')).toEqual(['member:edit-position', 'member:edit-department', 'member:approve']);
    expect(perms('그룹장')).toEqual([
      'group:lock', 'group:settings', 'group:edit-info', 'group:edit-period', 'group:schedule', 'group:kick',
      'group:transfer', 'group:delete', 'group:channels', 'group:files', 'group:recap',
    ]);
    expect(perms('편집자')).toEqual(['group:edit-info', 'group:edit-period', 'group:settings', 'group:lock']);
    expect(perms('신형')).toEqual(['member:remove']);
    expect(db.prepare("SELECT perms FROM org_roles WHERE name = '손상'").get()).toEqual({ perms: 'not json' });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'org_roles_v3'").get()).toEqual({ value: '1' });
  });

  it('todo_assignees 1회 백필 — 회의 할 일만 담당자로', () => {
    expect(db.prepare('SELECT todo_id, user_id FROM todo_assignees').all()).toEqual([{ todo_id: 1, user_id: 1 }]);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'todo_assignees_v1'").get()).toEqual({ value: '1' });
  });

  it('dm_messages: org_id NOT NULL → NULL 허용으로 재생성, 기존 행 보존, 개인 DM 삽입 가능', () => {
    const col = db.prepare(`SELECT "notnull" AS nn FROM pragma_table_info('dm_messages') WHERE name = 'org_id'`).get();
    expect(col).toEqual({ nn: 0 });
    expect(db.prepare('SELECT id, org_id, text FROM dm_messages').all()).toEqual([{ id: 1, org_id: 1, text: '조직 DM' }]);
    db.prepare("INSERT INTO dm_messages (org_id, from_id, to_id, text) VALUES (NULL, 1, 1, '개인 DM')").run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE org_id IS NULL').get() as { n: number }).n).toBe(1);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dm_messages'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_dm_pair', 'idx_dm_inbox']));
  });
});

describe('현재 스키마 위에서 재기동 (멱등)', () => {
  it('모든 ALTER 는 "이미 존재" 로 조용히 넘어가고, 1회 변환은 다시 돌지 않는다', async () => {
    const snapshotRoles = db.prepare('SELECT id, perms FROM org_roles ORDER BY id').all();
    // 재기동 전 소유자가 lock 을 뺀 상태 — v3 가 다시 돌면 되살아나는 함정을 플래그가 막아야 한다
    db.prepare(`UPDATE org_roles SET perms = '["group:settings"]' WHERE name = '편집자'`).run();
    vi.resetModules();
    const again = (await import('../db.js')).default;
    expect(again).not.toBe(db);
    expect(again.prepare("SELECT perms FROM org_roles WHERE name = '편집자'").get()).toEqual({ perms: '["group:settings"]' });
    expect(again.prepare('SELECT id, perms FROM org_roles WHERE name != ? ORDER BY id').all('편집자')).toEqual(
      (snapshotRoles as { id: number; perms: string }[]).filter((r) => r.id !== 3),
    );
    expect(again.prepare('SELECT COUNT(*) AS n FROM todo_assignees').get()).toEqual({ n: 1 });
    expect(again.prepare('SELECT COUNT(*) AS n FROM dm_messages').get()).toEqual({ n: 2 });
    expect(again.prepare(`SELECT "notnull" AS nn FROM pragma_table_info('dm_messages') WHERE name = 'org_id'`).get()).toEqual({ nn: 0 });
    expect(cols(again, 'users')).toEqual(cols(db, 'users'));
    again.close();
  });
});
