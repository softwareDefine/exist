import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import db from '../db.js';

const app = createApp();

/* 회의 삭제 — 회의·recap을 FK로 물고 있는 테이블이 하나라도 빠지면 500(FOREIGN KEY constraint failed)이
 * 나고, 트랜잭션이 아니면 참가자·채팅만 사라진 유령 회의가 남는다 (9/1 라이브에서 실제 발생).
 * 여기서는 recap 뒤에 생기는 부속 데이터를 전부 심어두고 삭제가 한 번에 끝나는지 본다. */

async function register(username: string) {
  const r = await request(app).post('/api/auth/register').send({ username, password: 'password123' });
  return r.body as { token: string; user: { id: number } };
}

describe('회의 삭제 (부속 데이터 전부)', () => {
  it('recap·정정 이력·안건·RAG·용어집·인수인계·파일 활동이 있어도 200이고 잔여 FK가 없다', async () => {
    const host = await register('del_host');
    const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${host.token}`).send({ title: '삭제 대상' });
    const code = m.body.code as string;
    const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
    const uid = host.user.id;
    // 다른 회의 — 이 회의 recap을 출처(basis)로 쓰는 스냅샷·할 일이 살아남는지 확인용
    const other = await request(app).post('/api/meetings').set('Authorization', `Bearer ${host.token}`).send({ title: '남는 회의' });
    const otherId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(other.body.code) as { id: number }).id;

    const recapId = db
      .prepare("INSERT INTO meeting_recaps (meeting_id, summary, decisions) VALUES (?, '짧은 통화', '[\"방열판 3mm\"]')")
      .run(meetingId).lastInsertRowid as number;
    db.prepare("INSERT INTO decision_revisions (recap_id, decision_idx, kind, reason, editor_id) VALUES (?, 0, 'edit', '오타', ?)").run(recapId, uid);
    db.prepare('INSERT INTO decision_acks (recap_id, decision_idx, user_id) VALUES (?, 0, ?)').run(recapId, uid);
    const agendaId = db.prepare("INSERT INTO agenda_items (meeting_id, title) VALUES (?, '보류 안건')").run(meetingId).lastInsertRowid as number;
    db.prepare("INSERT INTO agenda_events (agenda_id, meeting_id, kind, recap_id) VALUES (?, ?, 'wake', ?)").run(agendaId, meetingId, recapId);
    // 다른 회의의 안건이 이 회의 recap으로 깨어난 이력
    const otherAgenda = db.prepare("INSERT INTO agenda_items (meeting_id, title) VALUES (?, '남는 안건')").run(otherId).lastInsertRowid as number;
    db.prepare("INSERT INTO agenda_events (agenda_id, meeting_id, kind, recap_id) VALUES (?, ?, 'wake', ?)").run(otherAgenda, otherId, recapId);
    db.prepare("INSERT INTO rag_chunks (meeting_id, kind, ref_id, text, embedding) VALUES (?, 'recap', ?, '방열판', X'00')").run(meetingId, recapId);
    db.prepare("INSERT INTO meeting_glossary (meeting_id, term) VALUES (?, '방열판')").run(meetingId);
    const hoId = db.prepare("INSERT INTO handovers (meeting_id, author_id, sections) VALUES (?, ?, '{}')").run(meetingId, uid).lastInsertRowid as number;
    db.prepare('INSERT INTO handover_acks (handover_id, user_id) VALUES (?, ?)').run(hoId, uid);
    db.prepare("INSERT INTO handover_checklist (meeting_id, label, created_by) VALUES (?, '체크', ?)").run(meetingId, uid);
    const fileId = db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by) VALUES (?, 'a.md', 'doc', ?)").run(meetingId, uid).lastInsertRowid as number;
    db.prepare('INSERT INTO file_activity (meeting_id, file_id) VALUES (?, ?)').run(meetingId, fileId);
    db.prepare('INSERT INTO file_rev_snapshots (file_id, rev, basis_recap_id) VALUES (?, 1, ?)').run(fileId, recapId);
    const otherFile = db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by) VALUES (?, 'b.md', 'doc', ?)").run(otherId, uid).lastInsertRowid as number;
    db.prepare('INSERT INTO file_rev_snapshots (file_id, rev, basis_recap_id) VALUES (?, 1, ?)').run(otherFile, recapId);
    db.prepare("INSERT INTO call_transcripts (meeting_id, user_id, text) VALUES (?, ?, '녹취')").run(meetingId, uid);

    const r = await request(app).delete(`/api/meetings/${code}`).set('Authorization', `Bearer ${host.token}`);
    expect(r.status).toBe(200);
    expect(db.prepare('SELECT 1 FROM meetings WHERE id = ?').get(meetingId)).toBeUndefined();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    for (const t of ['meeting_recaps', 'agenda_items', 'rag_chunks', 'meeting_glossary', 'handovers', 'collab_files', 'call_transcripts', 'file_activity']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE meeting_id = ?`).get(meetingId) as { n: number }).n, t).toBe(0);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM decision_revisions WHERE recap_id = ?').get(recapId) as { n: number }).n).toBe(0);
    // 다른 회의 것은 남되, 이 회의 recap을 가리키던 참조만 끊긴다
    expect(db.prepare('SELECT 1 FROM meetings WHERE id = ?').get(otherId)).toBeTruthy();
    expect(db.prepare('SELECT basis_recap_id FROM file_rev_snapshots WHERE file_id = ?').get(otherFile)).toEqual({ basis_recap_id: null });
    expect((db.prepare('SELECT COUNT(*) AS n FROM agenda_items WHERE meeting_id = ?').get(otherId) as { n: number }).n).toBe(1);
  });
});
