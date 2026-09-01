import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

/* app.ts 프로덕션 분기 — NODE_ENV=production 에서 빌드된 client/dist 정적 서빙(캐시 헤더)·SPA 폴백,
 * cors 미장착, 전역 에러 핸들러(JSON 500). isProd 는 모듈 상수라 env 를 잡고 동적 import. */

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '..', '..', '..', 'client', 'dist');
const hasDist = fs.existsSync(path.join(clientDist, 'index.html'));

let app: ReturnType<typeof import('../app.js').createApp>;
const log = vi.spyOn(console, 'log').mockImplementation(() => {});

beforeAll(async () => {
  process.env.NODE_ENV = 'production';
  const { createApp } = await import('../app.js');
  app = createApp();
});

describe('프로덕션 app', () => {
  it('cors 헤더 없이 API 는 정상 · 보안 헤더 유지', async () => {
    const r = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, service: 'exist' });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it.skipIf(!hasDist)('정적 파일: index.html·sw.js 는 no-cache, /assets 해시 번들은 1년 immutable', async () => {
    expect(log).toHaveBeenCalledWith(`[static] serving client from ${clientDist}`);
    const idx = await request(app).get('/');
    expect(idx.status).toBe(200);
    expect(idx.headers['content-type']).toMatch(/text\/html/);
    expect(idx.headers['cache-control']).toBe('no-cache');
    if (fs.existsSync(path.join(clientDist, 'sw.js'))) {
      const sw = await request(app).get('/sw.js');
      expect(sw.status).toBe(200);
      expect(sw.headers['cache-control']).toBe('no-cache');
    }
    const asset = fs.readdirSync(path.join(clientDist, 'assets')).find((f) => f.endsWith('.js'));
    if (asset) {
      const a = await request(app).get(`/assets/${asset}`);
      expect(a.status).toBe(200);
      expect(a.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }
    const other = fs.readdirSync(clientDist).find((f) => f.endsWith('.svg') || f.endsWith('.webmanifest'));
    if (other) {
      const o = await request(app).get(`/${other}`);
      expect(o.status).toBe(200);
      expect(o.headers['cache-control']).not.toMatch(/immutable|no-cache/);
    }
  });

  it.skipIf(!hasDist)('SPA 폴백: 모르는 GET 경로는 index.html(no-cache), /api·비-GET 은 통과(404)', async () => {
    const spa = await request(app).get('/org/5/files?x=1');
    expect(spa.status).toBe(200);
    expect(spa.headers['content-type']).toMatch(/text\/html/);
    expect(spa.headers['cache-control']).toBe('no-cache');
    expect(spa.text).toBe(fs.readFileSync(path.join(clientDist, 'index.html'), 'utf8'));
    expect((await request(app).get('/api/does-not-exist')).status).toBe(404);
    expect((await request(app).post('/org/5')).status).toBe(404);
  });

  it('전역 에러 핸들러 — 본문 파서 예외는 HTML 스택 대신 JSON, 상태는 파서가 준 400 그대로', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"username": ');
    expect(r.status).toBe(400);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.body).toEqual({ error: '요청 본문이 올바른 JSON이 아니에요' });
    expect(err).not.toHaveBeenCalledWith('[unhandled]', expect.anything()); // 클라이언트 오류는 서버 장애 로그로 안 남긴다
    err.mockRestore();
  });
});
