import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import db from '../db.js';

const app = createApp();

/* 라이브 자막 청크 업로드 — ext·live 파라미터 처리와 저장 규칙.
 * OPENAI_API_KEY 없는 테스트 환경에선 live 전사가 돌지 않고(live:false) 파일만 남는다. */

async function register(username: string) {
  const r = await request(app).post('/api/auth/register').send({ username, password: 'password123' });
  return r.body as { token: string };
}

describe('STT 청크 업로드 (라이브 자막 경로)', () => {
  it('ext=mp4·live=1 — 확장자대로 저장되고 키 없으면 live:false', async () => {
    const host = await register('stt_host');
    const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${host.token}`).send({ title: 'stt' });
    const code = m.body.code as string;
    const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
    const ts = Date.now();
    const body = Buffer.alloc(4000, 1);
    const r = await request(app)
      .post(`/api/meetings/${code}/stt/audio?ts=${ts}&ext=mp4&live=1`)
      .set('Authorization', `Bearer ${host.token}`)
      .set('Content-Type', 'audio/mp4')
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.live).toBe(false); // 테스트 환경: OpenAI 없음
    const dir = path.join(process.env.DATA_DIR!, 'stt-chunks', String(meetingId));
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.endsWith(`-${ts}.mp4`))).toBe(true);
  });

  it('이상한 ext는 webm으로, 비참가자는 403', async () => {
    const host = await register('stt_host2');
    const other = await register('stt_other');
    const m = await request(app).post('/api/meetings').set('Authorization', `Bearer ${host.token}`).send({ title: 'stt2' });
    const code = m.body.code as string;
    const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }).id;
    const ts = Date.now();
    const r = await request(app)
      .post(`/api/meetings/${code}/stt/audio?ts=${ts}&ext=exe`)
      .set('Authorization', `Bearer ${host.token}`)
      .set('Content-Type', 'audio/webm')
      .send(Buffer.alloc(3000, 2));
    expect(r.status).toBe(200);
    const dir = path.join(process.env.DATA_DIR!, 'stt-chunks', String(meetingId));
    expect(fs.readdirSync(dir).some((f) => f.endsWith(`-${ts}.webm`))).toBe(true);
    const deny = await request(app)
      .post(`/api/meetings/${code}/stt/audio?ts=${ts}`)
      .set('Authorization', `Bearer ${other.token}`)
      .set('Content-Type', 'audio/webm')
      .send(Buffer.alloc(3000, 2));
    expect(deny.status).toBe(403);
  });
});
