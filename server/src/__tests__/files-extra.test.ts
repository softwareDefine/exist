import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { createApp } from '../app.js';
import db from '../db.js';
import { setBlobViewing, clearBlobViewingBySocket } from '../files.js';
import { ackRemindLast } from '../fileai.js';
import { writeYdoc, readYdocSnapshot } from '../ydoc.js';

/*
 * files.ts 보강 — files.test.ts가 안 다루는 라우트: 열람 서명(요청·서명·리마인드·현황), 개정·연혁·근거 결정,
 * 문서↔회의 역조회, 미리보기 시청자 프레즌스, 멘션, 업로드 검증·다운로드, 깊이 제한·이동·복제,
 * 휴지통(비우기·위치·복원 폴백), 최근·내용 검색·멤버·DM·채널 공유, 그룹 간 배포, 버전, 미리보기.
 */
const app = createApp();
const BLOB_DIR = path.join(process.env.DATA_DIR!, 'uploads-files');

interface User { id: number; token: string; name: string }
async function reg(name: string): Promise<User> {
  const r = await request(app).post('/api/auth/register').send({ username: name, password: 'password123' });
  return { id: r.body.user.id, token: r.body.token, name };
}
const H = (u: User) => ({ Authorization: `Bearer ${u.token}` });

async function setup(prefix: string, extraMembers = 0) {
  const host = await reg(`${prefix}_host`);
  const member = await reg(`${prefix}_member`);
  const m = await request(app).post('/api/meetings').set(H(host)).send({ title: `${prefix} 그룹` });
  const code = m.body.code as string;
  await request(app).post('/api/meetings/join').set(H(member)).send({ code });
  const others: User[] = [];
  for (let i = 0; i < extraMembers; i++) {
    const u = await reg(`${prefix}_x${i}`);
    await request(app).post('/api/meetings/join').set(H(u)).send({ code });
    others.push(u);
  }
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
  const F = `/api/meetings/${code}/files`;
  const mk = async (u: User, body: Record<string, unknown>) => {
    const r = await request(app).post(F).set(H(u)).send(body);
    expect(r.status).toBe(200);
    return r.body as { id: number; room: string | null; name: string };
  };
  const upload = async (u: User, name: string, buf: Buffer, mime = 'application/pdf', parent?: number) => {
    const r = await request(app)
      .post(`${F}/upload?name=${encodeURIComponent(name)}${parent != null ? `&parent_id=${parent}` : ''}`)
      .set(H(u)).set('Content-Type', mime).send(buf);
    expect(r.status).toBe(200);
    return r.body as { id: number; name: string; type: string };
  };
  return { host, member, others, code, meetingId, F, mk, upload };
}
const notis = (uid: number, kind?: string) =>
  db.prepare(`SELECT from_name, text, kind, file_id FROM notifications WHERE user_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY id`).all(...(kind ? [uid, kind] : [uid])) as { from_name: string; text: string; kind: string | null; file_id: number | null }[];
function setDocText(room: string, text: string) {
  writeYdoc(room, (doc) => {
    doc.getMap('docs').set('main', { name: '본문', ord: 1 });
    doc.getXmlFragment('doc:main').insert(0, [new Y.XmlText(text)]);
  });
}
const binary = () =>
  request(app).get('/').buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
const getBinary = (url: string, u: User) =>
  request(app).get(url).set(H(u)).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
void binary;

describe('목록 크기', () => {
  it('공동편집 문서는 Yjs 상태 크기, 폴더는 하위 합산 (변경 방송 타이머까지 한 번 기다린다)', async () => {
    const s = await setup('fx1');
    const folder = await s.mk(s.host, { name: '자료', type: 'folder' });
    const doc = await s.mk(s.host, { name: '메모', type: 'doc', parent_id: folder.id });
    setDocText(doc.room!, '내용이 좀 있는 문서');
    const up = await s.upload(s.host, 'a.pdf', Buffer.alloc(100), 'application/pdf', folder.id);
    const list = await request(app).get(s.F).set(H(s.host));
    const rows = list.body as { id: number; size: number | null; ack_total: number }[];
    const docRow = rows.find((r) => r.id === doc.id)!;
    expect(docRow.size).toBeGreaterThan(0);
    expect(rows.find((r) => r.id === up.id)!.size).toBe(100);
    expect(rows.find((r) => r.id === folder.id)!.size).toBe(docRow.size! + 100);
    expect(rows[0].ack_total).toBe(2);
    await new Promise((r) => setTimeout(r, 350)); // files:changed 디바운스 타이머 실행 (io 없음 → 조용히)
  });
});

describe('열람 서명', () => {
  it('요청 켜기(알림) → 서명(작성자 알림) → 현황 → 리마인드(쿨다운) → 끄기, 검증·권한', async () => {
    const s = await setup('fx2', 1);
    const [third] = s.others;
    const folder = await s.mk(s.host, { name: '폴더', type: 'folder' });
    const doc = await s.mk(s.host, { name: '작업표준', type: 'doc' });
    expect((await request(app).post(`${s.F}/${folder.id}/ack-request`).set(H(s.host)).send({})).status).toBe(400);
    expect((await request(app).post(`${s.F}/999999/ack-request`).set(H(s.host)).send({})).status).toBe(404);
    expect((await request(app).post(`${s.F}/${doc.id}/ack-request`).set(H(s.member)).send({})).status).toBe(403);
    expect((await request(app).post(`${s.F}/${doc.id}/ack`).set(H(s.member)).send({})).status).toBe(400);
    expect((await request(app).post(`${s.F}/${doc.id}/ack-remind`).set(H(s.host)).send({})).status).toBe(400);
    expect((await request(app).post(`${s.F}/999999/ack`).set(H(s.member)).send({})).status).toBe(404);

    const on = await request(app).post(`${s.F}/${doc.id}/ack-request`).set(H(s.host)).send({});
    expect(on.body).toEqual({ ok: true, ack_required: 1 });
    expect(notis(s.member.id, 'file-ack')).toEqual([{ from_name: 'fx2_host', text: '"작업표준" 문서의 열람 확인 서명을 요청했어요', kind: 'file-ack', file_id: doc.id }]);
    expect(notis(s.host.id, 'file-ack')).toEqual([]);

    const sig = 'data:image/png;base64,AAAA';
    expect((await request(app).post(`${s.F}/${doc.id}/ack`).set(H(s.member)).send({ signature: sig })).body).toEqual({ ok: true });
    expect(notis(s.host.id, 'file-ack')).toEqual([{ from_name: 'fx2_member', text: '"작업표준" 문서를 열람 확인(서명)했어요', kind: 'file-ack', file_id: doc.id }]);
    await request(app).post(`${s.F}/${doc.id}/ack`).set(H(s.host)).send({}); // 본인 서명 → 알림 없음
    expect(notis(s.host.id, 'file-ack')).toHaveLength(1);

    const acks = await request(app).get(`${s.F}/${doc.id}/acks`).set(H(third));
    expect(acks.body).toMatchObject({ required: true, total: 3, rev: 1, note: null, basis: null, basisNote: null });
    expect(acks.body.acks.map((a: { username: string; signature: string | null }) => [a.username, a.signature])).toEqual([['fx2_member', sig], ['fx2_host', null]]);
    expect(acks.body.pending).toEqual([{ username: 'fx2_x0', avatar: '🐧' }]);
    expect((await request(app).get(`${s.F}/999999/acks`).set(H(third))).status).toBe(404);

    const list = await request(app).get(s.F).set(H(s.member));
    expect(list.body.find((f: { id: number }) => f.id === doc.id)).toMatchObject({ ack_required: 1, ack_count: 2, my_ack: 1, ack_total: 3 });

    // 리마인드 — 미서명자(third)에게만, 1시간 쿨다운, 권한
    expect((await request(app).post(`${s.F}/${doc.id}/ack-remind`).set(H(s.member)).send({})).status).toBe(403);
    expect((await request(app).post(`${s.F}/999999/ack-remind`).set(H(s.host)).send({})).status).toBe(404);
    ackRemindLast.delete(doc.id);
    expect((await request(app).post(`${s.F}/${doc.id}/ack-remind`).set(H(s.host)).send({})).body).toEqual({ reminded: 1 });
    expect(notis(third.id, 'file-ack').map((n) => n.text)).toEqual(['"작업표준" 문서의 열람 확인 서명을 요청했어요', '"작업표준" 문서 열람 서명이 아직이에요 — 확인 부탁해요']);
    expect((await request(app).post(`${s.F}/${doc.id}/ack-remind`).set(H(s.host)).send({})).status).toBe(429);
    ackRemindLast.delete(doc.id);

    expect((await request(app).post(`${s.F}/${doc.id}/ack-request`).set(H(s.host)).send({ on: false })).body).toEqual({ ok: true, ack_required: 0 });
    expect(notis(third.id, 'file-ack')).toHaveLength(2);
  });
});

describe('개정·연혁·근거 결정', () => {
  it('근거 결정 검증, 발행 시 서명 이력 이관, history/acks에 근거·기타 사유·서명 수, 문서↔회의 역조회', async () => {
    const s = await setup('fx3');
    const folder = await s.mk(s.host, { name: '폴더', type: 'folder' });
    const doc = await s.mk(s.member, { name: 'SOP-01', type: 'doc' });
    setDocText(doc.room!, '초판 본문');
    const recapId = db
      .prepare("INSERT INTO meeting_recaps (meeting_id, summary, decisions, files) VALUES (?, '요약', ?, ?)")
      .run(s.meetingId, JSON.stringify(['검사 온도 65도로 상향']), JSON.stringify([{ id: doc.id, name: 'SOP-01' }])).lastInsertRowid as number;
    db.prepare("INSERT INTO meeting_recaps (meeting_id, summary, decisions, files) VALUES (?, '다른 요약', 'broken', ?)").run(s.meetingId, JSON.stringify([{ id: 999_999 }]));
    const brokenRecap = (db.prepare('SELECT MAX(id) AS id FROM meeting_recaps').get() as { id: number }).id;

    expect((await request(app).post(`${s.F}/${folder.id}/revise`).set(H(s.host)).send({})).status).toBe(400);
    expect((await request(app).post(`${s.F}/999999/revise`).set(H(s.host)).send({})).status).toBe(404);
    const stranger = await reg('fx3_other');
    await request(app).post('/api/meetings/join').set(H(stranger)).send({ code: s.code });
    expect((await request(app).post(`${s.F}/${doc.id}/revise`).set(H(stranger)).send({})).status).toBe(403);
    for (const body of [{ basisRecapId: 999_999, basisDecisionIdx: 0 }, { basisRecapId: recapId, basisDecisionIdx: 5 }, { basisRecapId: recapId, basisDecisionIdx: 'x' }, { basisRecapId: brokenRecap, basisDecisionIdx: 0 }]) {
      const r = await request(app).post(`${s.F}/${doc.id}/revise`).set(H(s.member)).send(body);
      expect(r.status).toBe(400);
    }

    await request(app).post(`${s.F}/${doc.id}/ack-request`).set(H(s.member)).send({});
    await request(app).post(`${s.F}/${doc.id}/ack`).set(H(s.host)).send({ signature: 'sig' });
    const rev = await request(app).post(`${s.F}/${doc.id}/revise`).set(H(s.host)).send({ basisRecapId: recapId, basisDecisionIdx: 0, basisNote: '  오타 수정  ' });
    expect(rev.body).toEqual({ ok: true, rev: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM file_acks WHERE file_id = ?').get(doc.id)).toEqual({ c: 0 });
    expect(db.prepare('SELECT user_id, rev, signature FROM file_acks_history WHERE file_id = ?').all(doc.id)).toEqual([{ user_id: s.host.id, rev: 1, signature: 'sig' }]);
    expect(db.prepare('SELECT text, basis_recap_id, basis_decision_idx, basis_note FROM file_rev_snapshots WHERE file_id = ? AND rev = 2').get(doc.id)).toEqual({ text: '본문\n초판 본문', basis_recap_id: recapId, basis_decision_idx: 0, basis_note: '오타 수정' });

    const hist = await request(app).get(`${s.F}/${doc.id}/history`).set(H(s.member));
    expect(hist.body.rev).toBe(2);
    expect(hist.body.entries).toEqual([
      { rev: 2, at: expect.any(String), note: null, basis: { recapId, idx: 0, text: '검사 온도 65도로 상향' }, basisNote: '오타 수정', signs: 0, current: true },
      { rev: 1, at: expect.any(String), note: null, basis: null, basisNote: null, signs: 1, current: false },
    ]);
    expect((await request(app).get(`${s.F}/${folder.id}/history`).set(H(s.member))).status).toBe(400);
    expect((await request(app).get(`${s.F}/999999/history`).set(H(s.member))).status).toBe(404);

    const acks = await request(app).get(`${s.F}/${doc.id}/acks`).set(H(s.member));
    expect(acks.body).toMatchObject({ rev: 2, basis: { recapId, idx: 0, text: '검사 온도 65도로 상향' }, basisNote: '오타 수정', acks: [] });

    // 근거 결정이 손상된 recap을 가리키면 표시 생략
    db.prepare("UPDATE meeting_recaps SET decisions = 'broken' WHERE id = ?").run(recapId);
    expect((await request(app).get(`${s.F}/${doc.id}/acks`).set(H(s.member))).body.basis).toBeNull();
    expect((await request(app).get(`${s.F}/${doc.id}/history`).set(H(s.member))).body.entries[0].basis.text).toBeNull();

    const mt = await request(app).get(`${s.F}/${doc.id}/meetings`).set(H(s.member));
    expect(mt.body).toEqual([{ recapId, summary: '요약', ts: expect.any(Number), eventId: null }]);
    expect((await request(app).get(`${s.F}/abc/meetings`).set(H(s.member))).status).toBe(400);
  });
});

describe('프레즌스·멘션', () => {
  it('업로드 파일 시청자는 소켓 귀속 — 신고·이동·해제, 비참가자 제외 / 멘션 알림', async () => {
    const s = await setup('fx4');
    const a = await s.upload(s.host, 'a.pdf', Buffer.from('a'));
    const b = await s.upload(s.host, 'b.pdf', Buffer.from('b'));
    const outsider = await reg('fx4_out');
    setBlobViewing(s.meetingId, 'sock1', s.member.id, a.id);
    setBlobViewing(s.meetingId, 'sock2', s.host.id, a.id);
    setBlobViewing(s.meetingId, 'sock3', outsider.id, a.id);
    setBlobViewing(s.meetingId, 'sock4', s.member.id, b.id);
    let p = await request(app).get(`${s.F}/presence`).set(H(s.host));
    expect(p.body).toEqual({ [a.id]: [{ username: 'fx4_member', avatar: '🐧' }, { username: 'fx4_host', avatar: '🐧' }], [b.id]: [{ username: 'fx4_member', avatar: '🐧' }] });
    setBlobViewing(s.meetingId, 'sock1', s.member.id, b.id); // 같은 소켓이 다른 파일로 이동
    p = await request(app).get(`${s.F}/presence`).set(H(s.host));
    expect(p.body[a.id]).toEqual([{ username: 'fx4_host', avatar: '🐧' }]);
    expect(clearBlobViewingBySocket('sock2')).toEqual([s.meetingId]);
    expect(clearBlobViewingBySocket('nope')).toEqual([]);
    setBlobViewing(s.meetingId, 'sock1', s.member.id, null);
    setBlobViewing(s.meetingId, 'sock3', outsider.id, null);
    setBlobViewing(s.meetingId, 'sock4', s.member.id, null);
    p = await request(app).get(`${s.F}/presence`).set(H(s.host));
    expect(p.body).toEqual({});
    setBlobViewing(s.meetingId, 'sock9', s.member.id, null); // 없는 회의 맵에 해제 — 무해

    expect((await request(app).post(`${s.F}/999999/mention`).set(H(s.host)).send({ username: 'fx4_member' })).status).toBe(404);
    expect((await request(app).post(`${s.F}/${a.id}/mention`).set(H(s.host)).send({ username: 'fx4_out' })).status).toBe(404);
    expect((await request(app).post(`${s.F}/${a.id}/mention`).set(H(s.host)).send({ username: 'fx4_host' })).body).toEqual({ ok: true });
    expect(notis(s.host.id, 'mention')).toEqual([]);
    await request(app).post(`${s.F}/${a.id}/mention`).set(H(s.host)).send({ username: 'fx4_member' });
    expect(notis(s.member.id, 'mention')).toEqual([{ from_name: 'fx4_host', text: '"a.pdf" 문서에서 회원님을 멘션했어요', kind: 'mention', file_id: null }]);
  });
});

describe('업로드 검증·다운로드·개수 제한', () => {
  it('이름 없음·부모 검증·JSON 본문 400, 폴더 안 업로드, 다운로드 404들, 100개 제한', async () => {
    const s = await setup('fx5');
    const doc = await s.mk(s.host, { name: '문서', type: 'doc' });
    const folder = await s.mk(s.host, { name: '폴더', type: 'folder' });
    expect((await request(app).post(`${s.F}/upload`).set(H(s.host)).set('Content-Type', 'application/pdf').send(Buffer.from('x'))).status).toBe(400);
    expect((await request(app).post(`${s.F}/upload?name=a.pdf&parent_id=${doc.id}`).set(H(s.host)).set('Content-Type', 'application/pdf').send(Buffer.from('x'))).status).toBe(400);
    expect((await request(app).post(`${s.F}/upload?name=a.pdf&parent_id=999999`).set(H(s.host)).set('Content-Type', 'application/pdf').send(Buffer.from('x'))).status).toBe(400);
    const json = await request(app).post(`${s.F}/upload?name=a.pdf`).set(H(s.host)).send({ hello: 1 });
    expect(json.status).toBe(400);
    expect(json.body.error).toBe('파일 본문을 바이너리로 보내주세요');
    const inFolder = await s.upload(s.host, 'in.pdf', Buffer.from('pdf'), 'application/pdf', folder.id);
    expect(db.prepare('SELECT parent_id FROM collab_files WHERE id = ?').get(inFolder.id)).toEqual({ parent_id: folder.id });

    expect((await request(app).get(`${s.F}/${doc.id}/download`).set(H(s.host))).status).toBe(404);
    const blob = (db.prepare('SELECT blob_path FROM collab_files WHERE id = ?').get(inFolder.id) as { blob_path: string }).blob_path;
    fs.unlinkSync(path.join(BLOB_DIR, blob));
    const gone = await request(app).get(`${s.F}/${inFolder.id}/download`).set(H(s.host));
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe('파일이 사라졌어요');

    // 그룹당 100개 — 생성·업로드·복제 모두 400
    const ins = db.prepare("INSERT INTO collab_files (meeting_id, name, type, created_by) VALUES (?, ?, 'doc', ?)");
    const cur = (db.prepare('SELECT COUNT(*) AS n FROM collab_files WHERE meeting_id = ? AND deleted_at IS NULL').get(s.meetingId) as { n: number }).n;
    for (let i = cur; i < 100; i++) ins.run(s.meetingId, `채움 ${i}`, s.host.id);
    expect((await request(app).post(s.F).set(H(s.host)).send({ name: '넘침', type: 'doc' })).status).toBe(400);
    expect((await request(app).post(`${s.F}/upload?name=over.pdf`).set(H(s.host)).set('Content-Type', 'application/pdf').send(Buffer.from('x'))).status).toBe(400);
    const cp = await request(app).post(`${s.F}/${doc.id}/copy`).set(H(s.host)).send({});
    expect(cp.status).toBe(400);
    expect(cp.body.error).toContain('100개');
  });
});

describe('깊이 제한·이동·복제', () => {
  it('폴더 5단계, 이동(사이클·비폴더·중복·루트), 복제(내용 복사·재귀·이름 회피)', async () => {
    const s = await setup('fx6');
    const chain: number[] = [];
    let parent: number | null = null;
    for (let i = 1; i <= 5; i++) {
      const f = await s.mk(s.host, { name: `f${i}`, type: 'folder', parent_id: parent });
      chain.push(f.id);
      parent = f.id;
    }
    const tooDeep = await request(app).post(s.F).set(H(s.host)).send({ name: 'f6', type: 'folder', parent_id: chain[4] });
    expect(tooDeep.status).toBe(400);
    const doc = await s.mk(s.host, { name: '문서', type: 'doc', parent_id: chain[3] });
    setDocText(doc.room!, '복제될 내용');

    const patch = (id: number, body: Record<string, unknown>, u = s.host) => request(app).patch(`${s.F}/${id}`).set(H(u)).send(body);
    expect((await patch(doc.id, { parent_id: chain[4] })).status).toBe(400); // 깊이 초과
    expect((await patch(doc.id, { parent_id: 999_999 })).status).toBe(400);
    expect((await patch(chain[0], { parent_id: doc.id })).status).toBe(400); // 비폴더
    expect((await patch(chain[0], { parent_id: chain[0] })).status).toBe(400); // 자기 자신
    expect((await patch(chain[0], { parent_id: chain[2] })).status).toBe(400); // 자기 하위
    await s.mk(s.host, { name: '문서', type: 'doc' }); // 루트에 같은 이름
    expect((await patch(doc.id, { parent_id: null })).status).toBe(409);
    expect((await patch(doc.id, { parent_id: chain[0] })).body).toEqual({ id: doc.id, parent_id: chain[0] });
    expect((await patch(chain[1], { parent_id: null })).body).toEqual({ id: chain[1], parent_id: null });
    expect((await patch(doc.id, { name: '  ' })).status).toBe(400);
    expect((await patch(999_999, { name: 'x' })).status).toBe(404);

    const copy = (id: number, body: Record<string, unknown> = {}) => request(app).post(`${s.F}/${id}/copy`).set(H(s.member)).send(body);
    expect((await copy(999_999)).status).toBe(404);
    expect((await copy(doc.id, { parent_id: doc.id })).status).toBe(400);
    const c1 = await copy(doc.id); // 루트로 — 참가자 누구나. 루트에 '문서'가 이미 있어 " (2)"
    expect(c1.body.created).toBe(1);
    expect(db.prepare('SELECT name, parent_id FROM collab_files WHERE id = ?').get(c1.body.id)).toEqual({ name: '문서 (2)', parent_id: null });
    const snap = readYdocSnapshot(`file-${c1.body.id}`)!;
    expect(snap.getXmlFragment('doc:main').toString()).toBe('복제될 내용');
    snap.destroy();
    const c2 = await copy(doc.id); // 같은 위치 재복제 → " (3)"
    expect(db.prepare('SELECT name, parent_id FROM collab_files WHERE id = ?').get(c2.body.id)).toEqual({ name: '문서 (3)', parent_id: null });
    const c3 = await copy(chain[1], { parent_id: chain[0] }); // 폴더(f2 > f3 > f4 > f5) 재귀
    expect(c3.body.created).toBe(4);
    expect(db.prepare('SELECT name, parent_id FROM collab_files WHERE id = ?').get(c3.body.id)).toEqual({ name: 'f2', parent_id: chain[0] });
  });
});

describe('휴지통', () => {
  it('비우기는 내 권한 항목만, 목록에 원래 위치·크기, 복원 대상 지정·폴백·이름 회피, 권한·404', async () => {
    const s = await setup('fx7');
    const folder = await s.mk(s.host, { name: '폴더', type: 'folder' });
    const sub = await s.mk(s.host, { name: '하위', type: 'folder', parent_id: folder.id });
    const deep = await s.mk(s.member, { name: '깊은 문서', type: 'doc', parent_id: sub.id });
    setDocText(deep.room!, '깊은 내용');
    const up = await s.upload(s.host, '자료.pdf', Buffer.alloc(77));
    const mine = await s.mk(s.member, { name: '내 문서', type: 'doc' });
    const del = (id: number, u: User) => request(app).delete(`${s.F}/${id}`).set(H(u));
    await del(deep.id, s.member);
    await del(up.id, s.host);
    await del(mine.id, s.member);

    const trash = await request(app).get(`${s.F}/trash/list`).set(H(s.member));
    const rows = trash.body as { id: number; location: string; size: number; author: string; children: number }[];
    expect(rows.find((r) => r.id === deep.id)).toMatchObject({ location: '폴더 › 하위', author: 'fx7_member', children: 0 });
    expect(rows.find((r) => r.id === deep.id)!.size).toBeGreaterThan(0);
    expect(rows.find((r) => r.id === up.id)).toMatchObject({ location: '', size: 77, author: 'fx7_host' });

    // 멤버가 비우기 — 자기 것 2개만, 호스트 것은 건너뜀
    const purgeAll = await request(app).delete(`${s.F}/trash`).set(H(s.member));
    expect(purgeAll.body).toEqual({ ok: true, purged: 2, skipped: 1 });
    expect(db.prepare('SELECT 1 FROM collab_files WHERE id = ?').get(deep.id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM collab_files WHERE id = ?').get(up.id)).toBeDefined();

    // 복원 — 권한·404·지정 폴더·삭제된 폴더 폴백·이름 충돌
    const restore = (id: number, u: User, body: Record<string, unknown> = {}) => request(app).post(`${s.F}/trash/${id}/restore`).set(H(u)).send(body);
    expect((await restore(up.id, s.member)).status).toBe(403);
    expect((await restore(999_999, s.host)).status).toBe(404);
    expect((await restore(up.id, s.host, { parentId: sub.id })).body).toEqual({ ok: true, parent_id: sub.id, name: '자료.pdf', fellBack: false });
    await del(up.id, s.host);
    await del(sub.id, s.host); // 원래 부모가 사라짐
    await s.upload(s.host, '자료.pdf', Buffer.alloc(1)); // 루트에 같은 이름
    const fb = await restore(up.id, s.host, { parentId: sub.id });
    expect(fb.body).toEqual({ ok: true, parent_id: null, name: '자료.pdf (2)', fellBack: true }); // 복원은 확장자를 안 가른다
    expect((await restore(sub.id, s.host, { parentId: null })).body).toMatchObject({ parent_id: null, fellBack: false });

    expect((await request(app).delete(`${s.F}/trash/999999`).set(H(s.host))).status).toBe(404);
    await del(up.id, s.host);
    expect((await request(app).delete(`${s.F}/trash/${up.id}`).set(H(s.member))).status).toBe(403);
    expect((await request(app).delete(`${s.F}/${up.id}`).set(H(s.member))).status).toBe(404); // 이미 휴지통
    expect((await request(app).delete(`${s.F}/trash/${up.id}`).set(H(s.host))).body).toEqual({ ok: true, purged: 1 });
    expect((await request(app).delete(`${s.F}/trash`).set(H(s.host))).body).toEqual({ ok: true, purged: 0, skipped: 0 });
  });
});

describe('최근·검색·멤버·DM·채널 공유', () => {
  it('최근 목록, 내용 검색 스니펫, 멤버 목록, DM 딥링크, 채널 공유 카드(파일·폴더·문서)', async () => {
    const s = await setup('fx8');
    const doc = await s.mk(s.host, { name: '검사 절차', type: 'doc' });
    setDocText(doc.room!, '1. 준비\n2. 검사 온도는 65도로 상향한다\n3. 기록');
    const folder = await s.mk(s.host, { name: '폴더', type: 'folder' });
    const up = await s.upload(s.host, '성적서.pdf', Buffer.alloc(2048));
    db.prepare('INSERT INTO file_activity (meeting_id, file_id, ts) VALUES (?, ?, ?), (?, ?, ?)').run(s.meetingId, doc.id, '2026-01-01 00:00:00', s.meetingId, up.id, '2026-01-02 00:00:00');
    const recent = await request(app).get(`${s.F}/recent/list`).set(H(s.member));
    expect(recent.body.map((r: { id: number }) => r.id)).toEqual([up.id, doc.id]);

    expect((await request(app).get(`${s.F}/search/content?q=온`).set(H(s.member))).body).toEqual([]);
    const hits = await request(app).get(`${s.F}/search/content?q=온도`).set(H(s.member));
    expect(hits.body).toEqual([{ id: doc.id, name: '검사 절차', type: 'doc', snippet: expect.stringContaining('검사 온도는 65도로 상향한다') }]);
    expect((await request(app).get(`${s.F}/search/content?q=없는말`).set(H(s.member))).body).toEqual([]);

    const members = await request(app).get(`${s.F}/members/list`).set(H(s.host));
    expect(members.body).toEqual([{ id: s.member.id, username: 'fx8_member', avatar: '🐧' }]);

    const dm = (id: number, body: Record<string, unknown>) => request(app).post(`${s.F}/${id}/dm`).set(H(s.host)).send(body);
    expect((await dm(999_999, { userId: s.member.id })).status).toBe(404);
    expect((await dm(doc.id, {})).status).toBe(400);
    expect((await dm(doc.id, { userId: s.host.id })).status).toBe(400);
    const out = await reg('fx8_out');
    expect((await dm(doc.id, { userId: out.id })).status).toBe(404);
    expect((await dm(doc.id, { userId: s.member.id })).body).toEqual({ ok: true });
    expect((await dm(folder.id, { userId: s.member.id })).body).toEqual({ ok: true });
    const dms = db.prepare('SELECT text FROM dm_messages WHERE from_id = ? AND to_id = ? ORDER BY id').all(s.host.id, s.member.id) as { text: string }[];
    expect(dms[0].text).toBe(`📄 "검사 절차" 파일을 공유했어요 — "fx8 그룹" 그룹의 공동편집에서 열 수 있어요\n/?g=${s.code}&file=${doc.id}`);
    expect(dms[1].text).toContain('📁 "폴더" 폴더을 공유했어요');

    const share = (id: number, body: Record<string, unknown> = {}) => request(app).post(`${s.F}/${id}/share-channel`).set(H(s.host)).send(body);
    expect((await share(999_999)).status).toBe(404);
    expect((await share(up.id, { channelId: 999_999 })).status).toBe(404);
    const r1 = await share(up.id);
    expect(r1.body).toEqual({ ok: true, channelId: expect.any(Number), channelName: '일반' });
    await share(folder.id, { channelId: r1.body.channelId });
    await share(doc.id, { channelId: r1.body.channelId });
    const msgs = db.prepare('SELECT text, file FROM messages WHERE meeting_id = ? ORDER BY id').all(s.meetingId) as { text: string; file: string }[];
    expect(msgs).toHaveLength(3);
    expect(JSON.parse(msgs[0].file)).toEqual({ name: '성적서.pdf', size: 2048, url: `/api/meetings/${s.code}/files/${up.id}/download`, fileId: up.id });
    expect(msgs[0].text).toBe('');
    expect(JSON.parse(msgs[1].file)).toEqual({ name: '폴더', fileId: folder.id, folder: true });
    expect(msgs[1].text).toBe('📁 "폴더" 폴더를 공유했어요 — 공동편집에서 열어보세요');
    expect(JSON.parse(msgs[2].file)).toEqual({ name: '검사 절차', fileId: doc.id });
    expect(msgs[2].text).toBe('📄 "검사 절차" 문서를 공유했어요 — 공동편집에서 열어보세요');
  });
});

describe('그룹 간 배포', () => {
  it('대상 목록, 검증·권한, 문서 사본(회의 자료 폴더·Yjs 복사·회람 알림), 회람 없이, 업로드 파일 blob 복사, 이름 회피', async () => {
    const s = await setup('fx9');
    const t = await setup('fx9t');
    await request(app).post('/api/meetings/join').set(H(s.host)).send({ code: t.code }); // 배포자는 양쪽 참가자
    const doc = await s.mk(s.host, { name: 'SOP-7', type: 'doc' });
    setDocText(doc.room!, '본사 개정판');
    const folder = await s.mk(s.host, { name: '폴더', type: 'folder' });
    const up = await s.upload(s.host, '도면.pdf', Buffer.from('drawing-bytes'));

    const targets = await request(app).get(`${s.F}/distribute/targets`).set(H(s.host));
    expect(targets.body.map((m: { code: string }) => m.code)).toEqual([t.code]);

    const dist = (id: number, body: Record<string, unknown>, u = s.host) => request(app).post(`${s.F}/${id}/distribute`).set(H(u)).send(body);
    expect((await dist(999_999, { targetCode: t.code })).status).toBe(404);
    expect((await dist(folder.id, { targetCode: t.code })).status).toBe(400);
    expect((await dist(doc.id, {})).status).toBe(400);
    expect((await dist(doc.id, { targetCode: 'ZZZZZZ' })).status).toBe(404);
    expect((await dist(doc.id, { targetCode: s.code.toLowerCase() })).status).toBe(400);
    expect((await dist(doc.id, { targetCode: t.code }, s.member)).status).toBe(403);

    const r = await dist(doc.id, { targetCode: t.code.toLowerCase() });
    expect(r.body).toEqual({ ok: true, id: expect.any(Number), name: 'SOP-7', targetCode: t.code, requestAck: true });
    const copyRow = db.prepare('SELECT parent_id, ack_required, room, type, meeting_id FROM collab_files WHERE id = ?').get(r.body.id) as { parent_id: number; ack_required: number; room: string; type: string; meeting_id: number };
    expect(copyRow).toMatchObject({ ack_required: 1, room: `file-${r.body.id}`, type: 'doc', meeting_id: t.meetingId });
    expect(db.prepare('SELECT name FROM collab_files WHERE id = ?').get(copyRow.parent_id)).toEqual({ name: '회의 자료' });
    const snap = readYdocSnapshot(copyRow.room)!;
    expect(snap.getXmlFragment('doc:main').toString()).toBe('본사 개정판');
    snap.destroy();
    expect(notis(t.host.id, 'file-ack')).toEqual([{ from_name: 'fx9_host', text: '『SOP-7』 문서가 배포됐어요 — 열람 서명이 필요해요', kind: 'file-ack', file_id: r.body.id }]);
    expect(notis(t.member.id, 'file-ack')).toHaveLength(1);

    const r2 = await dist(doc.id, { targetCode: t.code, requestAck: false });
    expect(r2.body).toMatchObject({ name: 'SOP-7 (2)', requestAck: false });
    expect(notis(t.host.id).at(-1)).toEqual({ from_name: 'fx9_host', text: '『SOP-7 (2)』 문서가 배포됐어요', kind: null, file_id: r2.body.id });
    expect(db.prepare('SELECT ack_required FROM collab_files WHERE id = ?').get(r2.body.id)).toEqual({ ack_required: 0 });

    const r3 = await dist(up.id, { targetCode: t.code });
    const src = db.prepare('SELECT blob_path, size, mime FROM collab_files WHERE id = ?').get(up.id) as { blob_path: string; size: number; mime: string };
    const dst = db.prepare('SELECT blob_path, size, mime, type FROM collab_files WHERE id = ?').get(r3.body.id) as { blob_path: string; size: number; mime: string; type: string };
    expect(dst).toMatchObject({ size: src.size, mime: src.mime, type: 'file' });
    expect(dst.blob_path).not.toBe(src.blob_path);
    expect(fs.readFileSync(path.join(BLOB_DIR, dst.blob_path)).toString()).toBe('drawing-bytes');
    const dl = await getBinary(`/api/meetings/${t.code}/files/${r3.body.id}/download`, t.member);
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).toString()).toBe('drawing-bytes');
  });
});

describe('버전', () => {
  it('업로드 파일에만 새 버전, 이전 blob 보관·목록·다운로드, 자동 개정, 회의 삭제 시 버전 blob 정리', async () => {
    const s = await setup('fx10');
    const doc = await s.mk(s.host, { name: '문서', type: 'doc' });
    const up = await s.upload(s.host, '성적서.pdf', Buffer.from('v1-bytes'));
    const uv = (id: number, body: Buffer | Record<string, unknown>, u = s.member) => {
      const req = request(app).post(`${s.F}/${id}/upload-version`).set(H(u));
      return Buffer.isBuffer(body) ? req.set('Content-Type', 'application/pdf').send(body) : req.send(body);
    };
    expect((await uv(doc.id, Buffer.from('x'))).status).toBe(400);
    expect((await uv(999_999, Buffer.from('x'))).status).toBe(400);
    expect((await uv(up.id, { json: true })).status).toBe(400);
    expect((await uv(up.id, Buffer.alloc(0))).status).toBe(400);
    const oldBlob = (db.prepare('SELECT blob_path FROM collab_files WHERE id = ?').get(up.id) as { blob_path: string }).blob_path;
    const ok = await uv(up.id, Buffer.from('v2-bytes-longer'));
    expect(ok.body).toEqual({ ok: true, size: 15, rev: 2 });
    expect(db.prepare('SELECT created_by, size, rev FROM collab_files WHERE id = ?').get(up.id)).toEqual({ created_by: s.member.id, size: 15, rev: 2 });
    const versions = await request(app).get(`${s.F}/${up.id}/versions`).set(H(s.host));
    expect(versions.body).toEqual([{ id: expect.any(Number), size: 8, created_at: expect.any(String), username: 'fx10_host' }]);
    const vid = versions.body[0].id;
    const old = await getBinary(`${s.F}/${up.id}/versions/${vid}/download`, s.host);
    expect(old.status).toBe(200);
    expect((old.body as Buffer).toString()).toBe('v1-bytes');
    expect(old.headers['content-disposition']).toContain('attachment');
    expect((await request(app).get(`${s.F}/${up.id}/versions/999999/download`).set(H(s.host))).status).toBe(404);
    fs.unlinkSync(path.join(BLOB_DIR, oldBlob));
    expect((await request(app).get(`${s.F}/${up.id}/versions/${vid}/download`).set(H(s.host))).status).toBe(404);
    fs.writeFileSync(path.join(BLOB_DIR, oldBlob), 'restored');
    // 다시 새 버전 → 휴지통 → 영구 삭제하면 버전 blob도 사라진다
    await uv(up.id, Buffer.from('v3'));
    const blobs = (db.prepare('SELECT blob_path FROM file_versions WHERE file_id = ?').all(up.id) as { blob_path: string }[]).map((v) => v.blob_path);
    expect(blobs).toHaveLength(2);
    await request(app).delete(`${s.F}/${up.id}`).set(H(s.host));
    await request(app).delete(`${s.F}/trash/${up.id}`).set(H(s.host));
    for (const b of blobs) expect(fs.existsSync(path.join(BLOB_DIR, b))).toBe(false);

    // 회의 삭제 경로(deleteMeetingFiles)도 버전 blob 정리
    const up2 = await s.upload(s.host, '두번째.pdf', Buffer.from('x1'));
    await uv(up2.id, Buffer.from('x2'), s.host);
    const vb = (db.prepare('SELECT blob_path FROM file_versions WHERE file_id = ?').get(up2.id) as { blob_path: string }).blob_path;
    expect(fs.existsSync(path.join(BLOB_DIR, vb))).toBe(true);
    expect((await request(app).delete(`/api/meetings/${s.code}`).set(H(s.host))).status).toBe(200);
    expect(fs.existsSync(path.join(BLOB_DIR, vb))).toBe(false);
  });
});

describe('미리보기', () => {
  it('코드·문서·시트·발표·캔버스·폴더·업로드(KB/MB)·빈 룸·404', async () => {
    const s = await setup('fx11');
    const pv = async (id: number) => (await request(app).get(`${s.F}/${id}/preview`).set(H(s.member))).body;
    const code = await s.mk(s.host, { name: '코드', type: 'code' });
    writeYdoc(code.room!, (d) => {
      d.getMap('files').set('b', { name: 'b.ts', ord: 2 });
      d.getMap('files').set('a', { name: 'src', ord: 1, dir: true });
    });
    expect(await pv(code.id)).toEqual({ items: ['src/', 'b.ts'] });
    const doc = await s.mk(s.host, { name: '문서', type: 'doc' });
    writeYdoc(doc.room!, (d) => {
      d.getMap('docs').set('y', { name: '둘째', ord: 2 });
      d.getMap('docs').set('x', { name: '첫째', ord: 1 });
    });
    expect(await pv(doc.id)).toEqual({ items: ['첫째', '둘째'] });
    const sheet = await s.mk(s.host, { name: '시트', type: 'sheet' });
    writeYdoc(sheet.room!, (d) => d.getMap('sheets').set('s', { name: '재고', ord: 1, cellsKey: 'c' }));
    expect(await pv(sheet.id)).toEqual({ items: ['재고'] });
    const slide = await s.mk(s.host, { name: '발표', type: 'slide' });
    writeYdoc(slide.room!, (d) => {
      d.getMap('slides').set('1', {});
      d.getMap('slides').set('2', {});
    });
    expect(await pv(slide.id)).toEqual({ items: [], count: 2 });
    const canvas = await s.mk(s.host, { name: '캔버스', type: 'canvas' });
    writeYdoc(canvas.room!, (d) => d.getMap('elements').set('e', {}));
    expect(await pv(canvas.id)).toEqual({ items: [] });
    const folder = await s.mk(s.host, { name: '폴더', type: 'folder' });
    expect(await pv(folder.id)).toEqual({ items: [] });
    const empty = await s.mk(s.host, { name: '빈문서', type: 'doc' });
    expect(await pv(empty.id)).toEqual({ items: [] });
    const up = await s.upload(s.host, 'a.pdf', Buffer.alloc(1500), 'application/pdf');
    expect(await pv(up.id)).toEqual({ items: ['application/pdf', '1KB'] });
    db.prepare('UPDATE collab_files SET size = ?, mime = NULL WHERE id = ?').run(1.5 * 1048576, up.id);
    expect(await pv(up.id)).toEqual({ items: ['파일', '1.5MB'] });
    expect((await request(app).get(`${s.F}/999999/preview`).set(H(s.member))).status).toBe(404);
  });
});
