import request from 'supertest';
import type { Express } from 'express';
import db from '../../db.js';

/*
 * 공용 픽스처 — 사용자·회의·조직을 "테스트 본문 안에서" 만든다.
 * (beforeAll에서 만들면 Stryker가 그 코드의 커버리지를 static 버킷으로 돌려 뮤턴트가 Ignored 된다)
 */

export interface User {
  token: string;
  id: number;
  username: string;
}

export async function register(app: Express, username: string, password = 'password123'): Promise<User> {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  if (r.status !== 200) throw new Error(`register ${username} → ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.token as string, id: r.body.user.id as number, username };
}

export const auth = (u: User) => ({ Authorization: `Bearer ${u.token}` });

export async function createMeeting(
  app: Express,
  host: User,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<{ code: string; id: number }> {
  const r = await request(app).post('/api/meetings').set(auth(host)).send({ title, ...extra });
  if (r.status !== 200) throw new Error(`createMeeting → ${r.status} ${JSON.stringify(r.body)}`);
  return { code: r.body.code as string, id: r.body.id as number };
}

export async function joinMeeting(app: Express, u: User, code: string): Promise<void> {
  const r = await request(app).post('/api/meetings/join').set(auth(u)).send({ code });
  if (r.status !== 200) throw new Error(`join → ${r.status} ${JSON.stringify(r.body)}`);
}

export async function createOrg(app: Express, owner: User, name: string): Promise<{ id: number; joinCode: string }> {
  const r = await request(app).post('/api/orgs').set(auth(owner)).send({ name });
  if (r.status !== 200) throw new Error(`createOrg → ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id as number, joinCode: r.body.joinCode as string };
}

/** 가입 신청 + 승인 (직급·부서 지정 가능) */
export async function joinOrg(
  app: Express,
  org: { id: number; joinCode: string },
  owner: User,
  u: User,
  approve: { position?: string; department?: string } = {},
): Promise<void> {
  const j = await request(app).post('/api/orgs/join').set(auth(u)).send({ joinCode: org.joinCode });
  if (j.status !== 200) throw new Error(`joinOrg → ${j.status} ${JSON.stringify(j.body)}`);
  const a = await request(app).post(`/api/orgs/${org.id}/members/${u.id}/approve`).set(auth(owner)).send(approve);
  if (a.status !== 200) throw new Error(`approve → ${a.status} ${JSON.stringify(a.body)}`);
}

export async function setOrgRole(app: Express, orgId: number, owner: User, target: User, role: 'admin' | 'member'): Promise<void> {
  const r = await request(app).patch(`/api/orgs/${orgId}/members/${target.id}`).set(auth(owner)).send({ role });
  if (r.status !== 200) throw new Error(`setOrgRole → ${r.status} ${JSON.stringify(r.body)}`);
}

export function insertRecap(
  meetingId: number,
  decisions: string[],
  opts: { whys?: string[]; attendees?: string[]; source?: string; createdAt?: string; summary?: string } = {},
): number {
  return db
    .prepare(
      `INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, alts, actions, attendees, source, created_at, call_ended_at)
       VALUES (?, ?, ?, ?, ?, '[]', ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`,
    )
    .run(
      meetingId,
      opts.summary ?? decisions[0] ?? '요약',
      JSON.stringify(decisions),
      JSON.stringify(decisions.map((_, i) => opts.whys?.[i] ?? '')),
      JSON.stringify(decisions.map(() => [])),
      JSON.stringify(opts.attendees ?? []),
      opts.source ?? 'ai',
      opts.createdAt ?? null,
      opts.createdAt ?? null,
    ).lastInsertRowid as number;
}

export function notifications(userId: number) {
  return db
    .prepare('SELECT from_name, text, kind, meeting_code FROM notifications WHERE user_id = ? ORDER BY id')
    .all(userId) as { from_name: string; text: string; kind: string | null; meeting_code: string | null }[];
}

/** notify.ts의 io 주입용 가짜 Socket.IO — emitToUser(소켓 맵)·to(room).emit 둘 다 관측 */
export function fakeIo(userIds: number[]) {
  const emitted: { userId: number; event: string; payload: unknown }[] = [];
  const rooms: { room: string; event: string; payload: unknown }[] = [];
  const sockets = new Map<string, { data: { userId: number }; emit: (event: string, payload: unknown) => void }>();
  for (const uid of userIds) {
    sockets.set(`s${uid}`, { data: { userId: uid }, emit: (event, payload) => emitted.push({ userId: uid, event, payload }) });
  }
  const io = {
    sockets: { sockets },
    to: (room: string) => ({ emit: (event: string, payload: unknown) => rooms.push({ room, event, payload }) }),
  };
  return { io, emitted, rooms, of: (uid: number, event: string) => emitted.filter((e) => e.userId === uid && e.event === event) };
}
