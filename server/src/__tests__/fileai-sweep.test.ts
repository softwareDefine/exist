import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import * as Y from 'yjs';
import { createApp } from '../app.js';
import db from '../db.js';
import { sweepFileAckAutoReminders, ackAutoRemindHours, ackRemindLast, extractRoomText, extractFileText } from '../fileai.js';
import { writeYdoc } from '../ydoc.js';

/*
 * fileai.ts — ① 회람 미확인 자동 에스컬레이션 스윕(sweepFileAckAutoReminders) ② 룸 본문 추출(extractRoomText).
 * 스윕: 기준 시각(그 rev 스냅샷 시각, 없으면 파일 수정 시각)에서 ACK_AUTOREMIND_HOURS(기본 48)가 지났고,
 * 같은 rev의 마지막 자동 발송·수동 리마인드에서도 같은 시간이 지난 파일의 미서명자를 exist AI가 보챈다.
 */
const app = createApp();

async function reg(name: string) {
  const r = await request(app).post('/api/auth/register').send({ username: name, password: 'password123' });
  return { id: r.body.user.id as number, token: r.body.token as string };
}
async function setup(prefix: string, members = 2) {
  const host = await reg(`${prefix}_host`);
  const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${host.token}`).send({ title: `${prefix} 그룹` });
  const code = m.body.code as string;
  const memberIds: number[] = [];
  for (let i = 1; i <= members; i++) {
    const u = await reg(`${prefix}_m${i}`);
    await request(app).post('/api/meetings/join').set('Authorization', `Bearer ${u.token}`).send({ code });
    memberIds.push(u.id);
  }
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
  return { code, meetingId, hostId: host.id, memberIds };
}
/** 회람 문서 — created_at을 hoursAgo 시간 전으로 (updated_at은 NULL → created_at 기준) */
function mkFile(meetingId: number, by: number, hoursAgo: number, p: { rev?: number; type?: string; name?: string; ack?: number } = {}): number {
  return db
    .prepare(
      `INSERT INTO collab_files (meeting_id, name, type, created_by, ack_required, rev, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`,
    )
    .run(meetingId, p.name ?? '절차서', p.type ?? 'doc', by, p.ack ?? 1, p.rev ?? 1, `-${hoursAgo} hours`).lastInsertRowid as number;
}
const notis = (uid: number, fileId?: number) =>
  (db
    .prepare(`SELECT from_name, text, kind, meeting_code, file_id FROM notifications WHERE user_id = ? ${fileId ? 'AND file_id = ?' : ''} ORDER BY id`)
    .all(...(fileId ? [uid, fileId] : [uid])) as { from_name: string; text: string; kind: string; meeting_code: string; file_id: number }[]);
const autoRows = (fileId: number) => db.prepare('SELECT rev, sent_at FROM file_ack_autoremind WHERE file_id = ? ORDER BY id').all(fileId) as { rev: number; sent_at: string }[];

afterEach(() => {
  delete process.env.ACK_AUTOREMIND_HOURS;
  ackRemindLast.clear();
});

describe('ackAutoRemindHours', () => {
  it('env 없음·비수·0 이하는 48, 소수 허용', () => {
    expect(ackAutoRemindHours()).toBe(48);
    process.env.ACK_AUTOREMIND_HOURS = 'abc';
    expect(ackAutoRemindHours()).toBe(48);
    process.env.ACK_AUTOREMIND_HOURS = '-1';
    expect(ackAutoRemindHours()).toBe(48);
    process.env.ACK_AUTOREMIND_HOURS = '0.5';
    expect(ackAutoRemindHours()).toBe(0.5);
  });
});

describe('sweepFileAckAutoReminders', () => {
  it('48시간 지난 미서명자에게 exist AI 리마인드 + 요청자에게 명단 보고, 기록 후 같은 간격 전엔 재발송 없음', async () => {
    const s = await setup('sw1');
    const fileId = mkFile(s.meetingId, s.hostId, 72);
    const fresh = mkFile(s.meetingId, s.hostId, 10, { name: '신규' }); // 아직 안 됨
    mkFile(s.meetingId, s.hostId, 72, { type: 'folder', name: '폴더' }); // 폴더 제외
    mkFile(s.meetingId, s.hostId, 72, { name: '비회람', ack: 0 }); // 회람 아님
    sweepFileAckAutoReminders();

    for (const uid of s.memberIds) {
      expect(notis(uid)).toEqual([
        { from_name: 'exist AI', text: '"절차서" 문서 열람 서명이 3일째 대기 중이에요 — 확인 부탁해요', kind: 'file-ack', meeting_code: s.code, file_id: fileId },
      ]);
    }
    expect(notis(s.hostId)).toEqual([
      { from_name: 'exist AI', text: '"절차서" 미확인 2명에게 자동 리마인드를 보냈어요 — sw1_m1, sw1_m2', kind: 'file-ack', meeting_code: s.code, file_id: fileId },
    ]);
    expect(autoRows(fileId)).toHaveLength(1);
    expect(autoRows(fresh)).toHaveLength(0);

    // 멱등 — 바로 다시 돌려도 아무것도 안 나감
    sweepFileAckAutoReminders();
    expect(notis(s.memberIds[0])).toHaveLength(1);
    expect(autoRows(fileId)).toHaveLength(1);

    // 마지막 자동 발송에서 다시 48시간이 지나면 재발송 (한 명은 그새 서명 → 제외)
    db.prepare("UPDATE file_ack_autoremind SET sent_at = datetime('now', '-49 hours') WHERE file_id = ?").run(fileId);
    db.prepare('INSERT INTO file_acks (file_id, user_id) VALUES (?, ?)').run(fileId, s.memberIds[0]);
    sweepFileAckAutoReminders();
    expect(notis(s.memberIds[0])).toHaveLength(1);
    expect(notis(s.memberIds[1])).toHaveLength(2);
    expect(notis(s.hostId)[1].text).toBe('"절차서" 미확인 1명에게 자동 리마인드를 보냈어요 — sw1_m2');
    expect(autoRows(fileId)).toHaveLength(2);

    // 전원 서명하면 발송도 기록도 없음
    db.prepare("UPDATE file_ack_autoremind SET sent_at = datetime('now', '-49 hours') WHERE file_id = ?").run(fileId);
    db.prepare('INSERT INTO file_acks (file_id, user_id) VALUES (?, ?)').run(fileId, s.memberIds[1]);
    sweepFileAckAutoReminders();
    expect(autoRows(fileId)).toHaveLength(2);
    expect(notis(s.hostId)).toHaveLength(2);
  });

  it('기준 시각은 그 rev의 개정 스냅샷 시각이 우선 — 파일은 오래됐어도 최근 개정이면 대기, 개정만 오래됐으면 발송', async () => {
    const s = await setup('sw2', 1);
    const recent = mkFile(s.meetingId, s.hostId, 200, { rev: 2, name: '최근개정' });
    db.prepare("INSERT INTO file_rev_snapshots (file_id, rev, text, created_at) VALUES (?, 2, 'x', datetime('now', '-1 hours'))").run(recent);
    const old = mkFile(s.meetingId, s.hostId, 0, { rev: 3, name: '오래된개정' });
    db.prepare("INSERT INTO file_rev_snapshots (file_id, rev, text, created_at) VALUES (?, 3, 'x', datetime('now', '-60 hours'))").run(old);
    // 다른 rev의 스냅샷은 기준이 아니다 (rev 1 스냅샷만 있고 rev 2인 파일 → 파일 시각)
    const other = mkFile(s.meetingId, s.hostId, 1, { rev: 2, name: '다른rev' });
    db.prepare("INSERT INTO file_rev_snapshots (file_id, rev, text, created_at) VALUES (?, 1, 'x', datetime('now', '-90 hours'))").run(other);
    sweepFileAckAutoReminders();
    expect(autoRows(recent)).toHaveLength(0);
    expect(autoRows(other)).toHaveLength(0);
    expect(autoRows(old)).toEqual([expect.objectContaining({ rev: 3 })]);
    expect(notis(s.memberIds[0]).map((n) => n.text)).toEqual(['"오래된개정" 문서 열람 서명이 2일째 대기 중이에요 — 확인 부탁해요']);
  });

  it('수동 리마인드 직후(ackRemindLast)엔 한 간격 쉼 · 하루 미만 간격(데모)은 "N시간째" · 6명 이상은 "외 N명"', async () => {
    const s = await setup('sw3', 6);
    const fileId = mkFile(s.meetingId, s.hostId, 2);
    process.env.ACK_AUTOREMIND_HOURS = '0.5';
    ackRemindLast.set(fileId, Date.now() - 5 * 60_000);
    sweepFileAckAutoReminders();
    expect(autoRows(fileId)).toHaveLength(0);

    ackRemindLast.set(fileId, Date.now() - 31 * 60_000);
    sweepFileAckAutoReminders();
    expect(autoRows(fileId)).toHaveLength(1);
    expect(notis(s.memberIds[5])[0].text).toBe('"절차서" 문서 열람 서명이 2시간째 대기 중이에요 — 확인 부탁해요');
    expect(notis(s.hostId)[0].text).toBe('"절차서" 미확인 6명에게 자동 리마인드를 보냈어요 — sw3_m1, sw3_m2, sw3_m3, sw3_m4, sw3_m5 외 1명');
  });

  it('요청자(만든 사람)는 미서명이어도 대상이 아니다 — 멤버가 만든 회람 문서면 호스트가 대상', async () => {
    const s = await setup('sw4', 1);
    const fileId = mkFile(s.meetingId, s.memberIds[0], 50);
    sweepFileAckAutoReminders();
    expect(notis(s.hostId, fileId).map((n) => n.text)).toEqual(['"절차서" 문서 열람 서명이 2일째 대기 중이에요 — 확인 부탁해요']);
    expect(notis(s.memberIds[0], fileId).map((n) => n.text)).toEqual(['"절차서" 미확인 1명에게 자동 리마인드를 보냈어요 — sw4_host']);
  });
});

describe('extractRoomText / extractFileText', () => {
  it('코드(files 맵+file: 텍스트, 폴더 제외)·문서·시트·발표·캔버스 공유 타입에서 텍스트만 긁는다', () => {
    const room = 'file-777777';
    writeYdoc(room, (doc) => {
      doc.getMap('files').set('f1', { name: 'main.ts', ord: 1 });
      doc.getMap('files').set('d1', { name: 'src', ord: 2, dir: true });
      doc.getText('file:f1').insert(0, 'console.log(1)');
      doc.getMap('docs').set('doc1', { name: '절차서', ord: 1 });
      doc.getXmlFragment('doc:doc1').insert(0, [new Y.XmlText('본문 문단')]);
      doc.getMap('sheets').set('s1', { name: '시트1', ord: 1, cellsKey: 'cells:s1' });
      doc.getMap('sheets').set('s2', { name: '깨진', ord: 2 });
      doc.getMap('cells:s1').set('A1', '품목');
      doc.getMap('cells:s1').set('B1', 3);
      doc.getMap('slides').set('sl1', { ord: 1 });
      doc.getMap('slide-els:sl1').set('e1', { text: '슬라이드 제목' });
      doc.getMap('slide-els:sl1').set('e2', { kind: 'rect' });
      doc.getMap('elements').set('c1', { text: '캔버스 메모' });
      doc.getMap('elements').set('c2', { text: '' });
    });
    const text = extractRoomText(room);
    expect(text.split('\n')).toEqual(['main.ts', 'console.log(1)', '절차서', '본문 문단', '품목', '3', '슬라이드 제목', '캔버스 메모']);
    expect(extractRoomText('file-no-such-room')).toBe('');
  });

  it('extractFileText — 룸 없는 파일·폴더·업로드 파일·없는 id는 null', async () => {
    const s = await setup('sw5', 0);
    const folder = mkFile(s.meetingId, s.hostId, 0, { type: 'folder' });
    const upload = mkFile(s.meetingId, s.hostId, 0, { type: 'file' });
    db.prepare('UPDATE collab_files SET room = ? WHERE id IN (?, ?)').run('file-777777', folder, upload);
    const noRoom = mkFile(s.meetingId, s.hostId, 0, { type: 'doc' });
    expect(extractFileText(folder)).toBeNull();
    expect(extractFileText(upload)).toBeNull();
    expect(extractFileText(noRoom)).toBeNull();
    expect(extractFileText(999_999)).toBeNull();
  });
});
