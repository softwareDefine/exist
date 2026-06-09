import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'exist.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE,
    pw_hash    TEXT NOT NULL,
    pw_salt    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS organizations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    join_code  TEXT NOT NULL UNIQUE,
    owner_id   INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  /* role: owner | admin | member   status: pending | active */
  CREATE TABLE IF NOT EXISTS organization_members (
    org_id     INTEGER NOT NULL REFERENCES organizations(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    role       TEXT NOT NULL DEFAULT 'member',
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    host_id    INTEGER NOT NULL REFERENCES users(id),
    org_id     INTEGER REFERENCES organizations(id),
    starts_at  TEXT,
    ends_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meeting_participants (
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (meeting_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    title      TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    due_at     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    from_name  TEXT NOT NULL,
    text       TEXT NOT NULL,
    kind       TEXT,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);

  /* 회의별 일정 이벤트 — 달력에서 관리 (회의 참가자 공유) */
  CREATE TABLE IF NOT EXISTS meeting_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    title      TEXT NOT NULL,
    date       TEXT NOT NULL,
    time       TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mevents_meeting ON meeting_events(meeting_id, date);
`);

// 마이그레이션: 복구 코드 컬럼 (기존 DB에 없으면 추가)
try {
  db.exec(`ALTER TABLE users ADD COLUMN recovery_hash TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN recovery_salt TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 프로필 아바타 (이모지)
try {
  db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT '🐧'`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 회의 조직 소속 (기존 DB에 컬럼 없으면 추가, null = 개인 회의)
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN org_id INTEGER REFERENCES organizations(id)`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 조직 멤버의 직급(position)·부서(department) — 한국 회사 조직도
try {
  db.exec(`ALTER TABLE organization_members ADD COLUMN position TEXT`);
} catch {
  /* 이미 존재 */
}
try {
  db.exec(`ALTER TABLE organization_members ADD COLUMN department TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 채팅 첨부 파일 (JSON: {name,url,size}) — 없으면 추가
try {
  db.exec(`ALTER TABLE messages ADD COLUMN file TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 회의 설정/권한 (JSON: {locked,guestEdit,muteOnJoin})
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN settings TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 프로젝트 기간(선택) — 시작일/종료일 (날짜만, null이면 기간 없음)
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN period_start TEXT`);
  db.exec(`ALTER TABLE meetings ADD COLUMN period_end TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 알림 "치우기"(보관) — 지워도 지난 알림에서 볼 수 있게 soft delete
try {
  db.exec(`ALTER TABLE notifications ADD COLUMN cleared INTEGER NOT NULL DEFAULT 0`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 회의 썸네일 사진 (없으면 그라디언트+첫글자 폴백)
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN thumbnail TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 회의별 할 일 — todos.meeting_id (null이면 개인 todo, 값 있으면 회의 공유)
try {
  db.exec(`ALTER TABLE todos ADD COLUMN meeting_id INTEGER REFERENCES meetings(id)`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 반복 회의 — recur(none|daily|weekly|biweekly|monthly), recur_until(날짜, null=무한/없음)
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN recur TEXT NOT NULL DEFAULT 'none'`);
} catch {
  /* 이미 존재 */
}
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN recur_until TEXT`);
} catch {
  /* 이미 존재 */
}

export default db;
