import Database from 'better-sqlite3';
import path from 'node:path';

/** Direct SQLite access to the E2E server's DB (WAL, so a concurrent writer is fine). */
export function openDb() {
  const dir = process.env.E2E_DATA_DIR;
  if (!dir) throw new Error('E2E_DATA_DIR missing');
  const db = new Database(path.join(dir, 'exist.sqlite'), { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  return db;
}

export interface RecapSeed {
  meetingId: number;
  summary: string;
  decisions: string[];
  whys?: (string | null)[];
  criticals?: boolean[];
  attendees: string[];
}

/** Seed one meeting_recaps row the way recap.ts would have written it. Returns recap id. */
export function seedRecap(s: RecapSeed): number {
  const db = openDb();
  try {
    const info = db
      .prepare(
        `INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, criticals, attendees, source)
         VALUES (?, ?, ?, ?, ?, ?, 'rule')`,
      )
      .run(
        s.meetingId,
        s.summary,
        JSON.stringify(s.decisions),
        JSON.stringify(s.whys ?? s.decisions.map(() => null)),
        JSON.stringify(s.criticals ?? s.decisions.map(() => false)),
        JSON.stringify(s.attendees),
      );
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}
