import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

/* index.ts 부팅 — startServer(0) 으로 실제 포트 없이 app·소켓·Yjs·주기 타이머를 세우고,
 * 타이머 콜백은 캡처해서 직접 돌린다. 회의/일정 리마인더 본체(runMeetingReminders)는 now 를 주입해 검증.
 * index.ts 가 'dotenv/config' 를 읽으므로 외부 서비스 키는 먼저 비워 둔다 (dotenv 는 기존 값을 덮지 않음). */

process.env.OPENAI_API_KEY = '';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';
process.env.ANNOUNCED_IP = '';
process.env.LOCAL_IP = '';
process.env.DOTENV_CONFIG_QUIET = 'true';

vi.mock('../handover.js', async (orig) => ({
  ...(await orig<typeof import('../handover.js')>()),
  sweepHandoverEscalations: vi.fn(),
}));

type Mod = typeof import('../index.js');
let mod: Mod;
let handle: ReturnType<Mod['startServer']>;
let db: typeof import('../db.js').default;
const timeouts: { fn: () => void; ms: number }[] = [];
const intervals: { fn: () => void; ms: number }[] = [];
let timeoutSpy: ReturnType<typeof vi.spyOn>;
let intervalSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mod = await import('../index.js');
  db = (await import('../db.js')).default;
  // NODE_ENV=test 라 모듈 로드만으로는 부팅하지 않는다 — 여기서 명시적으로, 포트 0 으로
  const realTimeout = globalThis.setTimeout;
  const realInterval = globalThis.setInterval;
  timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
    if (ms && ms >= 20_000) {
      timeouts.push({ fn, ms });
      return { ref() {}, unref() {}, hasRef: () => true, refresh() {} } as unknown as NodeJS.Timeout;
    }
    return realTimeout(fn, ms, ...a);
  }) as typeof setTimeout);
  intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
    if (ms && ms >= 60_000) {
      intervals.push({ fn, ms });
      return { ref() {}, unref() {}, hasRef: () => true, refresh() {} } as unknown as NodeJS.Timeout;
    }
    return realInterval(fn, ms, ...a);
  }) as typeof setInterval);
  handle = mod.startServer(0);
  timeoutSpy.mockRestore();
  intervalSpy.mockRestore();
  await handle.ready;
}, 20_000);

afterAll(async () => {
  await handle.close();
});

describe('startServer', () => {
  it('mediasoup 준비 뒤 포트 0 으로 listen — app·소켓·AI 유저가 살아 있다', async () => {
    const port = (handle.server.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);
    const live = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(await live.json()).toEqual({ ok: true, service: 'exist' });
    expect((await request(handle.app).get('/api/presence')).body).toEqual({ users: [] });
    expect(handle.io).toBeTruthy();
    expect(db.prepare("SELECT 1 AS ok FROM users WHERE username = 'exist AI'").get()).toEqual({ ok: 1 });
  });

  it('주기 스윕 타이머 — 기동 후 1회(20·30·45초) + 인터벌(1·10·60분)', () => {
    expect(timeouts.map((t) => t.ms).sort((a, b) => a - b)).toEqual([20_000, 30_000, 45_000]);
    expect(intervals.map((t) => t.ms).sort((a, b) => a - b)).toEqual([60_000, 600_000, 600_000, 600_000, 3_600_000]);
  });

  it('스윕 콜백은 빈 DB 에서 조용히 돌고, 하나가 던져도 나머지·프로세스는 산다', async () => {
    const { sweepHandoverEscalations } = await import('../handover.js');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    (sweepHandoverEscalations as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    for (const t of [...timeouts, ...intervals]) expect(() => t.fn()).not.toThrow();
    expect(sweepHandoverEscalations).toHaveBeenCalledTimes(2); // 30초 선실행 + 10분 인터벌
    expect(err).toHaveBeenCalledWith('[handover] 에스컬레이션 스윕 실패:', expect.any(Error));
    err.mockRestore();
  });
});

describe('runMeetingReminders', () => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const plusDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  let userId = 0;
  let code = '';
  const texts = () =>
    (db.prepare("SELECT text FROM notifications WHERE user_id = ? AND from_name = 'exist AI' ORDER BY id").all(userId) as { text: string }[]).map((r) => r.text);

  beforeAll(() => {
    const today = new Date();
    const at10 = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10, 0, 0);
    userId = db.prepare("INSERT INTO users (username, pw_hash, pw_salt) VALUES ('remind_u', 'x', 'x')").run().lastInsertRowid as number;
    code = 'RMND01';
    const mk = (c: string, title: string, startsAt: string | null) => {
      const id = db.prepare('INSERT INTO meetings (code, title, host_id, starts_at) VALUES (?, ?, ?, ?)').run(c, title, userId, startsAt).lastInsertRowid as number;
      db.prepare('INSERT INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)').run(id, userId);
      return id;
    };
    const m1 = mk(code, '월요 TBM', new Date(at10.getTime() + 25 * 60_000).toISOString());
    mk('RMND02', '시작 없음', null);
    mk('RMND03', '한참 뒤', new Date(at10.getTime() + 90 * 60_000).toISOString());
    const ev = (title: string, date: string, time: string | null, extra: Partial<{ is_call: number; remind: number | null; recur: string | null; recur_until: string | null }> = {}) =>
      db
        .prepare('INSERT INTO meeting_events (meeting_id, title, date, time, created_by, is_call, remind, recur, recur_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(m1, title, date, time, userId, extra.is_call ?? 0, extra.remind ?? null, extra.recur ?? null, extra.recur_until ?? null);
    const T = ymd(today);
    ev('설비 점검 통화', T, '10:08', { is_call: 1 });
    ev('알림 끔', T, '10:20', { remind: 0 });
    ev('2시간 전 알림', T, '12:00', { remind: 120 });
    ev('하루 전 알림', ymd(plusDays(today, 1)), '10:00', { remind: 1440 });
    ev('매일 조회', ymd(plusDays(today, -1)), '10:15', { recur: 'daily' });
    ev('끝난 반복', ymd(plusDays(today, -14)), '10:05', { recur: 'weekly', recur_until: ymd(plusDays(today, -1)) });
    ev('전사 안전의 날', T, null);
    ev('매일 종일', ymd(plusDays(today, -3)), null, { recur: 'daily' });
    ev('내일 종일', ymd(plusDays(today, 1)), null);
    ev('주간 종일(오늘 아님)', ymd(plusDays(today, -1)), null, { recur: 'weekly' });
  });

  it('오전 9시 전에는 하루 종일 알림이 없고, 아직 임박한 것도 없다', () => {
    const t = new Date();
    mod.runMeetingReminders(new Date(t.getFullYear(), t.getMonth(), t.getDate(), 8, 0, 0));
    expect(texts()).toEqual([]);
  });

  it('10시 기준 — 회의 30분 전 · 통화 10분 전 · remind 존중(0=끔, 120=2시간, 1440=1일) · 반복 · 하루 종일', () => {
    const t = new Date();
    mod.runMeetingReminders(new Date(t.getFullYear(), t.getMonth(), t.getDate(), 10, 0, 0));
    expect(texts().sort()).toEqual(
      [
        '"월요 TBM" 회의가 25분 뒤에 시작돼요',
        "'설비 점검 통화' 통화 8분 뒤 시작 — 들어오세요 (월요 TBM)",
        "'2시간 전 알림' 2시간 뒤 시작 — 월요 TBM",
        "'하루 전 알림' 1일 뒤 시작 — 월요 TBM",
        "'매일 조회' 15분 뒤 시작 — 월요 TBM",
        "오늘 하루 종일 — '전사 안전의 날' (월요 TBM)",
        "오늘 하루 종일 — '매일 종일' (월요 TBM)",
      ].sort(),
    );
    const call = db.prepare("SELECT kind, meeting_code FROM notifications WHERE user_id = ? AND text LIKE '%통화%'").get(userId);
    expect(call).toEqual({ kind: 'call', meeting_code: code });
  });

  it('같은 임계값은 다시 알리지 않는다 (1분마다 돌아도 중복 없음)', () => {
    const before = texts().length;
    const t = new Date();
    mod.runMeetingReminders(new Date(t.getFullYear(), t.getMonth(), t.getDate(), 10, 1, 0));
    expect(texts().length).toBe(before);
    // 10분 임계값은 별도 키 — 30분 알림 뒤 다시 임박하면 한 번 더 (같은 틱에 둘 다 걸리면 한 번만)
    mod.runMeetingReminders(new Date(t.getFullYear(), t.getMonth(), t.getDate(), 10, 16, 0));
    expect(texts().slice(before)).toEqual(['"월요 TBM" 회의가 9분 뒤에 시작돼요']);
    mod.runMeetingReminders(new Date(t.getFullYear(), t.getMonth(), t.getDate(), 10, 17, 0));
    expect(texts().length).toBe(before + 1);
  });
});
