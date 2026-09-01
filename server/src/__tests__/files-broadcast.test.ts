import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import db from '../db.js';
import { initNotifier } from '../notify.js';
import { register, auth, createMeeting, joinMeeting, fakeIo } from './helpers/fixtures.js';

/*
 * files.ts — files:changed 방송 미들웨어(변경 성공 시에만, 300ms 디바운스, 참가자 전원)와 업로드 25MB 상한.
 */
const app = createApp();
const BLOB_DIR = path.join(process.env.DATA_DIR!, 'uploads-files');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('files:changed 방송', () => {
  it('변경 성공(2xx·비GET) 뒤 300ms 안에 참가자 전원에게 {code}(대문자) 1회, GET·실패한 변경은 방송 없음, 연속 변경은 한 번으로 뭉친다', async () => {
    const host = await register(app, 'fb_host');
    const member = await register(app, 'fb_member');
    const outsider = await register(app, 'fb_out');
    const m = await createMeeting(app, host, 'fb 그룹');
    await joinMeeting(app, member, m.code);
    const io = fakeIo([host.id, member.id, outsider.id]);
    initNotifier(io.io as never);
    const lower = m.code.toLowerCase();
    const changed = () => [host, member, outsider].map((u) => io.of(u.id, 'files:changed').length);

    expect((await request(app).get(`/api/meetings/${lower}/files`).set(auth(host))).status).toBe(200);
    await sleep(400);
    expect(changed()).toEqual([0, 0, 0]);

    const bad = await request(app).post(`/api/meetings/${lower}/files`).set(auth(host)).send({ name: '', type: 'doc' });
    expect(bad.status).toBe(400);
    const forbidden = await request(app).post(`/api/meetings/${lower}/files`).set(auth(outsider)).send({ name: '몰래', type: 'doc' });
    expect(forbidden.status).toBe(403);
    await sleep(400);
    expect(changed()).toEqual([0, 0, 0]);

    const a = await request(app).post(`/api/meetings/${lower}/files`).set(auth(host)).send({ name: '문서 A', type: 'doc' });
    const b = await request(app).post(`/api/meetings/${lower}/files`).set(auth(member)).send({ name: '문서 B', type: 'doc' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(changed()).toEqual([0, 0, 0]); // 즉시가 아니라 디바운스 뒤
    await sleep(450);
    expect(changed()).toEqual([1, 1, 0]);
    expect(io.of(host.id, 'files:changed')[0].payload).toEqual({ code: m.code.toUpperCase() });

    // 이름 변경(PATCH)·삭제(DELETE)도 각각 방송
    expect((await request(app).patch(`/api/meetings/${m.code}/files/${a.body.id}`).set(auth(host)).send({ name: '문서 A2' })).status).toBe(200);
    await sleep(450);
    expect(changed()).toEqual([2, 2, 0]);
    expect((await request(app).delete(`/api/meetings/${m.code}/files/${b.body.id}`).set(auth(member))).status).toBe(200);
    await sleep(450);
    expect(changed()).toEqual([3, 3, 0]);
    // 다른 그룹의 변경은 이 그룹 참가자에게 오지 않는다 (코드별 타이머)
    const other = await createMeeting(app, outsider, '다른 그룹');
    expect((await request(app).post(`/api/meetings/${other.code}/files`).set(auth(outsider)).send({ name: 'x', type: 'doc' })).status).toBe(200);
    await sleep(450);
    expect(changed()).toEqual([3, 3, 1]);
    expect(io.of(outsider.id, 'files:changed')[0].payload).toEqual({ code: other.code });
  }, 20_000);
});

describe('업로드 상한', () => {
  it('25MB 초과는 413 이고 blob·행이 남지 않는다', async () => {
    const host = await register(app, 'fu_host');
    const m = await createMeeting(app, host, 'fu 그룹');
    fs.mkdirSync(BLOB_DIR, { recursive: true });
    const before = fs.readdirSync(BLOB_DIR).length;
    const r = await request(app)
      .post(`/api/meetings/${m.code}/files/upload?name=huge.bin`)
      .set(auth(host))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(25 * 1024 * 1024 + 1, 1));
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ error: '파일은 25MB까지 올릴 수 있어요' });
    expect(fs.readdirSync(BLOB_DIR).length).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM collab_files WHERE meeting_id = ? AND type = 'file'").get(m.id)).toEqual({ n: 0 });
    const ok = await request(app)
      .post(`/api/meetings/${m.code}/files/upload?name=small.bin`)
      .set(auth(host))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(1024, 2));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: 'small.bin', type: 'file', size: 1024 });
    expect(fs.readdirSync(BLOB_DIR).length).toBe(before + 1);
  }, 30_000);
});
