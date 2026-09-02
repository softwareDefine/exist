import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import db from '../db.js';
import { initNotifier } from '../notify.js';
import { register, auth, createMeeting, joinMeeting, createOrg, joinOrg, notifications, fakeIo, type User } from './helpers/fixtures.js';

/*
 * 그룹 관리 라우트 — PATCH settings 의 필드별 권한 분리(변경 없으면 통과)와 감사 로그,
 * 썸네일 업로드(형식·5MB 경계), 강퇴·호스트 위임의 알림/감사, PATCH /:code 의 일시·반복 갱신 규칙,
 * 채널 생성 상한·중복·알림 모드.
 */
const app = createApp();

async function orgSetup(prefix: string) {
  const host = await register(app, `${prefix}_host`);
  const member = await register(app, `${prefix}_member`);
  const org = await createOrg(app, host, `${prefix} 조직`);
  await joinOrg(app, org, host, member);
  const m = await createMeeting(app, host, `${prefix} 그룹`, { org_id: org.id });
  await joinMeeting(app, member, m.code);
  return { host, member, org, m };
}
const audits = (orgId: number) =>
  db.prepare("SELECT action, text FROM org_audit WHERE org_id = ? AND action LIKE 'group.%' ORDER BY id").all(orgId) as {
    action: string;
    text: string;
  }[];

describe('그룹 설정 (PATCH /:code/settings) — 필드별 권한·감사', () => {
  it('바뀌는 필드에만 권한 검사 — 잠금은 group:lock, 운영 설정은 group:settings, 변경 없으면 멤버도 200', async () => {
    const { host, member, org, m } = await orgSetup('ma1');
    const patch = (u: User, body: Record<string, unknown>) =>
      request(app).patch(`/api/meetings/${m.code}/settings`).set(auth(u)).send(body);

    // 멤버가 아무것도 안 바꾸는 요청 — 통과 (기본값 그대로)
    const same = await patch(member, {});
    expect(same.status).toBe(200);
    expect(same.body).toEqual({ settings: { locked: false, guestEdit: true, muteOnJoin: false } });

    expect((await patch(member, { locked: true })).status).toBe(403);
    expect((await patch(member, { locked: true })).body).toEqual({ error: '입장 잠금을 변경할 권한이 없어요' });
    expect((await patch(member, { guestEdit: false })).body).toEqual({ error: '그룹 설정을 변경할 권한이 없어요' });
    expect((await patch(member, { muteOnJoin: true })).body).toEqual({ error: '그룹 설정을 변경할 권한이 없어요' });
    expect(audits(org.id)).toEqual([]);

    // 호스트 — 잠금만: lock 감사 1건, settings 감사 없음
    expect((await patch(host, { locked: true })).body).toEqual({ settings: { locked: true, guestEdit: true, muteOnJoin: false } });
    expect(audits(org.id)).toEqual([{ action: 'group.lock', text: '그룹 "ma1 그룹" 입장 잠금 설정' }]);

    // 이미 잠긴 상태에서 멤버가 같은 값 — 변경 없음이라 통과
    expect((await patch(member, { locked: true })).status).toBe(200);

    // 호스트 — 해제 + 운영 설정 동시 변경: 감사 2건 추가
    expect((await patch(host, { locked: false, guestEdit: false, muteOnJoin: true })).body).toEqual({
      settings: { locked: false, guestEdit: false, muteOnJoin: true },
    });
    expect(audits(org.id)).toEqual([
      { action: 'group.lock', text: '그룹 "ma1 그룹" 입장 잠금 설정' },
      { action: 'group.lock', text: '그룹 "ma1 그룹" 입장 잠금 해제' },
      { action: 'group.settings', text: '그룹 "ma1 그룹" 설정 변경' },
    ]);
    expect(db.prepare('SELECT settings FROM meetings WHERE id = ?').get(m.id)).toEqual({
      settings: JSON.stringify({ locked: false, guestEdit: false, muteOnJoin: true }),
    });
    const nf = await request(app).patch('/api/meetings/NOPE21/settings').set(auth(host)).send({});
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: '회의를 찾을 수 없어요' });
  }, 20_000);
});

describe('썸네일 업로드 (POST /:code/thumbnail)', () => {
  it('이미지만·5MB 경계·빈 파일·확장자 정제, 저장 후 url 이 그룹에 반영', async () => {
    const host = await register(app, 'ma2_host');
    const m = await createMeeting(app, host, 'ma2 그룹');
    const up = (ct: string, body: Buffer) =>
      request(app).post(`/api/meetings/${m.code}/thumbnail`).set(auth(host)).set('Content-Type', ct).send(body);

    const bad = await up('text/plain', Buffer.from('x'));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: '이미지 파일만 올릴 수 있어요' });
    const empty = await up('image/png', Buffer.alloc(0));
    expect(empty.status).toBe(400);
    expect(empty.body).toEqual({ error: '빈 파일이에요' });

    const ok = await up('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(ok.status).toBe(200);
    expect(ok.body.thumbnail).toMatch(/^\/api\/workspaces\/uploads\/mthumb-[0-9a-f-]{36}\.png$/);
    const fname = String(ok.body.thumbnail).split('/').pop()!;
    expect(fs.readFileSync(path.join(process.env.DATA_DIR!, 'uploads', fname))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(db.prepare('SELECT thumbnail FROM meetings WHERE id = ?').get(m.id)).toEqual({ thumbnail: ok.body.thumbnail });
    expect((await request(app).get(`/api/meetings/${m.code}`).set(auth(host))).body.thumbnail).toBe(ok.body.thumbnail);

    // 확장자 정제 — svg+xml → 영숫자만 5자
    const svg = await up('image/svg+xml', Buffer.from('<svg/>'));
    expect(svg.body.thumbnail).toMatch(/\.svgxm$/);

    // 정확히 5MB 는 허용, 1바이트 초과는 413
    expect((await up('image/png', Buffer.alloc(5 * 1024 * 1024, 1))).status).toBe(200);
    const big = await up('image/png', Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: '사진이 너무 커요 (최대 5MB)' });
  }, 30_000);
});

describe('강퇴·호스트 위임', () => {
  it('강퇴 — 참가자 삭제 + meeting:kicked 소켓 + 알림 + 감사, 없는 사용자 404', async () => {
    const { host, member, org, m } = await orgSetup('ma3');
    const io = fakeIo([host.id, member.id]);
    initNotifier(io.io as never);
    const nf = await request(app).delete(`/api/meetings/${m.code}/participants/ma3_ghost`).set(auth(host));
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: '사용자를 찾을 수 없어요' });

    expect((await request(app).delete(`/api/meetings/${m.code.toLowerCase()}/participants/ma3_member`).set(auth(host))).body).toEqual({ ok: true });
    expect(db.prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?').get(m.id, member.id)).toBeUndefined();
    expect(io.of(member.id, 'meeting:kicked').map((e) => e.payload)).toEqual([{ code: m.code, title: 'ma3 그룹' }]);
    expect(notifications(member.id).at(-1)).toEqual({
      from_name: 'ma3 그룹',
      text: '회의에서 내보내졌어요.',
      kind: null,
      meeting_code: m.code,
    });
    expect(audits(org.id)).toEqual([{ action: 'group.kick', text: '그룹 "ma3 그룹"에서 ma3_member님 내보내기' }]);
  }, 20_000);

  it('호스트 위임 — host_id 변경 + 감사, 없는 사용자 404', async () => {
    const { host, member, org, m } = await orgSetup('ma4');
    expect((await request(app).patch(`/api/meetings/${m.code}/host`).set(auth(host)).send({ username: 'ma4_ghost' })).body).toEqual({
      error: '사용자를 찾을 수 없어요',
    });
    expect((await request(app).patch(`/api/meetings/${m.code}/host`).set(auth(host)).send({ username: 'ma4_member' })).body).toEqual({ ok: true });
    expect(db.prepare('SELECT host_id FROM meetings WHERE id = ?').get(m.id)).toEqual({ host_id: member.id });
    expect(audits(org.id)).toEqual([{ action: 'group.transfer', text: '그룹 "ma4 그룹" 호스트를 ma4_member님에게 위임' }]);
  }, 20_000);
});

describe('회의 수정 (PATCH /:code) — 일시는 항상 덮어쓰고 제목은 COALESCE', () => {
  it('제목만 보내면 일시가 비워지고, recur 를 보내면 반복 정보까지 갱신, 숫자 제목 400', async () => {
    const host = await register(app, 'ma5_host');
    const m = await createMeeting(app, host, 'ma5 그룹', { starts_at: '2026-10-01T10:00', ends_at: '2026-10-01T11:00' });
    const patch = (body: Record<string, unknown>) => request(app).patch(`/api/meetings/${m.code}`).set(auth(host)).send(body);
    const row = () =>
      db.prepare('SELECT title, starts_at, ends_at, recur, recur_until FROM meetings WHERE id = ?').get(m.id) as Record<string, unknown>;

    expect((await patch({ title: 42 })).body).toEqual({ error: '회의 이름을 입력하세요' });
    expect((await patch({ title: '  ' })).status).toBe(400);

    // 제목 없이 일시만 — 제목 유지(COALESCE)
    expect((await patch({ starts_at: '2026-11-01T09:00' })).body).toEqual({ ok: true });
    expect(row()).toEqual({ title: 'ma5 그룹', starts_at: '2026-11-01T09:00', ends_at: null, recur: 'none', recur_until: null });

    // recur 동반 갱신
    expect((await patch({ title: '새 이름', starts_at: '2026-11-02T09:00', ends_at: '2026-11-02T10:00', recur: 'biweekly', recur_until: '2026-12-31' })).body).toEqual({ ok: true });
    expect(row()).toEqual({ title: '새 이름', starts_at: '2026-11-02T09:00', ends_at: '2026-11-02T10:00', recur: 'biweekly', recur_until: '2026-12-31' });

    // recur='none' 이면 until 은 무시, 제목만 보내면 일시는 비워지고 recur 는 유지
    expect((await patch({ recur: 'none', recur_until: '2027-01-01' })).body).toEqual({ ok: true });
    expect(row()).toEqual({ title: '새 이름', starts_at: null, ends_at: null, recur: 'none', recur_until: null });
    expect((await patch({ title: '제목만' })).body).toEqual({ ok: true });
    expect(row()).toEqual({ title: '제목만', starts_at: null, ends_at: null, recur: 'none', recur_until: null });
  }, 20_000);
});

describe('채널 — 중복·상한·알림 모드', () => {
  it('중복 이름 409, 그룹당 20개 상한, 알림 모드 all/mention/off 만 허용·본인 설정에 반영', async () => {
    const host = await register(app, 'ma6_host');
    const m = await createMeeting(app, host, 'ma6 그룹');
    const mk = (name: unknown) => request(app).post(`/api/meetings/${m.code}/channels`).set(auth(host)).send({ name });

    const c1 = await mk('공지');
    expect(c1.status).toBe(200);
    expect(c1.body).toEqual({ id: expect.any(Number), name: '공지', isDefault: false });
    const dup = await mk(' 공지 ');
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: '이미 있는 채널 이름이에요' });
    expect((await mk('')).body).toEqual({ error: '채널 이름을 입력하세요' });

    // 기본(1) + 공지(1) + 18 = 20 → 21번째 400
    for (let i = 0; i < 18; i++) expect((await mk(`부속 ${i}`)).status).toBe(200);
    const over = await mk('넘침');
    expect(over.status).toBe(400);
    expect(over.body).toEqual({ error: '채널은 그룹당 20개까지예요' });

    // 알림 모드
    const put = (chId: number | string, mode: unknown) =>
      request(app).put(`/api/meetings/${m.code}/channels/${chId}/notify`).set(auth(host)).send({ mode });
    expect((await put(c1.body.id, 'loud')).body).toEqual({ error: '알 수 없는 알림 모드예요' });
    expect((await put(999999, 'all')).body).toEqual({ error: '존재하지 않는 채널이에요' });
    expect((await put(c1.body.id, 'all')).body).toEqual({ id: c1.body.id, notifyMode: 'all' });
    expect((await put(c1.body.id, 'off')).body).toEqual({ id: c1.body.id, notifyMode: 'off' });
    const list = (await request(app).get(`/api/meetings/${m.code}/channels`).set(auth(host))).body as {
      id: number;
      name: string;
      isDefault: boolean;
      notifyMode: string;
    }[];
    expect(list.find((c) => c.id === c1.body.id)!.notifyMode).toBe('off');
    expect(list.filter((c) => c.isDefault)).toHaveLength(1);
    expect(list.find((c) => c.isDefault)!.name).toBe('일반');
  }, 20_000);
});
