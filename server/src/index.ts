import 'dotenv/config';
import http from 'node:http';
import db from './db.js';
import { startMediasoup } from './sfu.js';
import { eventOccurrenceOnOrAfter } from './meetings.js';
import { getUserContext } from './agent.js';
import { attachYjs } from './ydoc.js';
import { notifyUser } from './notify.js';
import { sweepHandoverEscalations } from './handover.js';
import { sweepFileAckAutoReminders, ackAutoRemindHours } from './fileai.js';
import { ensureAgentUser } from './steward.js';
import { runTodoReminders } from './todos.js';
import { runDecisionReminders, sweepDecisionAckAutoReminders } from './recap.js';
import { createApp } from './app.js';
import { attachRealtime } from './realtime.js';

/*
 * 부팅 절차는 startServer() 하나로 묶여 있다 — 테스트가 실제 포트·장주기 타이머 없이
 * 부팅 코드(리마인더 본체 포함)를 검증할 수 있게. NODE_ENV=test 가 아니면 모듈 로드 즉시
 * startServer() 가 호출되므로 프로덕션(node dist/index.js · tsx watch) 동작은 종전과 동일하다.
 */

// ── AI agent 푸시 알림: 회의 시작 30분/10분 전 리마인더 ──
const notified = new Set<string>(); // `${userId}:${meetingTitle}:${threshold}`

/** 1분 인터벌 본체 — 회의 시작 30/10분 전 · 일정 이벤트(remind 존중) · 하루 종일 일정(9시 이후 1회) */
export function runMeetingReminders(now = new Date()) {
  // 접속 여부와 무관하게 회의 참가자 전원 검사 — 오프라인이면 notifyUser가 웹푸시로 배달
  const userIds = (
    db.prepare('SELECT DISTINCT user_id FROM meeting_participants').all() as { user_id: number }[]
  ).map((r) => r.user_id);
  for (const userId of userIds) {
    const ctx = getUserContext(userId);
    for (const m of ctx.meetings) {
      if (!m.starts_at) continue;
      const min = Math.round((new Date(m.starts_at).getTime() - now.getTime()) / 60_000);
      // 30분 전·10분 전 2단계 알림. 한 틱에 두 임계값이 같이 걸리면(첫 검사가 10분 이내) 둘 다 소진하고 한 번만 알림
      const due = [30, 10].filter(
        (t) => min <= t && min > 0 && !notified.has(`${userId}:${m.title}:${t}`),
      );
      if (due.length > 0) {
        due.forEach((t) => notified.add(`${userId}:${m.title}:${t}`));
        // 알림함에 영속 + 접속 소켓에 푸시
        notifyUser(userId, {
          from: 'exist AI',
          text: `"${m.title}" 회의가 ${min}분 뒤에 시작돼요`,
          meetingCode: m.code,
        });
      }
    }

    // 회의 일정 이벤트(통화 등, 시간 있는 것) 리마인더 — 기본 30/10분 전, remind 지정 시 그 시점만 (0=끔)
    const events = db
      .prepare(
        `SELECT e.id AS eid, e.title AS etitle, e.date, e.time, e.is_call, e.remind, e.recur, e.recur_until, m.code, m.title AS mtitle
         FROM meeting_events e
         JOIN meetings m ON m.id = e.meeting_id
         JOIN meeting_participants mp ON mp.meeting_id = m.id
         WHERE mp.user_id = ? AND e.time IS NOT NULL`,
      )
      .all(userId) as {
      eid: number;
      etitle: string;
      date: string;
      time: string;
      is_call: number;
      remind: number | null;
      recur: string | null;
      recur_until: string | null;
      code: string;
      mtitle: string;
    }[];
    const todayY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const ev of events) {
      // 반복 일정은 오늘 이후 첫 occurrence 기준 (키에 날짜 포함 — 회차마다 새로 알림)
      const effDate = ev.recur
        ? eventOccurrenceOnOrAfter(ev.date, ev.recur, ev.recur_until, todayY)
        : ev.date;
      if (!effDate) continue;
      const start = new Date(`${effDate}T${ev.time}`);
      const min = Math.round((start.getTime() - now.getTime()) / 60_000);
      const thresholds = ev.remind == null ? [30, 10] : ev.remind === 0 ? [] : [ev.remind];
      const due = thresholds.filter(
        (t) => min <= t && min > 0 && !notified.has(`${userId}:ev${ev.eid}:${effDate}:${t}`),
      );
      if (due.length > 0) {
        due.forEach((t) => notified.add(`${userId}:ev${ev.eid}:${effDate}:${t}`));
        // 1시간 이상 남은 알림(1시간·2시간·하루 전)은 분 대신 시간/일로
        const lead =
          min >= 1440
            ? `${Math.round(min / 1440)}일 뒤`
            : min >= 60
              ? `${Math.round(min / 60)}시간 뒤`
              : `${min}분 뒤`;
        notifyUser(userId, {
          from: 'exist AI',
          text: ev.is_call
            ? `'${ev.etitle}' 통화 ${lead} 시작 — 들어오세요 (${ev.mtitle})`
            : `'${ev.etitle}' ${lead} 시작 — ${ev.mtitle}`,
          meetingCode: ev.code,
          kind: ev.is_call ? 'call' : undefined,
        });
      }
    }

    // 하루 종일 일정(시간 없음) — 당일 오전 9시 이후 한 번 알림 (애플식 아침 리마인더)
    if (now.getHours() >= 9) {
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const alldays = db
        .prepare(
          `SELECT e.id AS eid, e.title AS etitle, e.date, e.recur, e.recur_until, m.code, m.title AS mtitle
           FROM meeting_events e
           JOIN meetings m ON m.id = e.meeting_id
           JOIN meeting_participants mp ON mp.meeting_id = m.id
           WHERE mp.user_id = ? AND e.time IS NULL AND (e.date = ? OR e.recur IS NOT NULL)`,
        )
        .all(userId, today) as {
        eid: number;
        etitle: string;
        date: string;
        recur: string | null;
        recur_until: string | null;
        code: string;
        mtitle: string;
      }[];
      for (const ev of alldays) {
        // 반복이면 오늘이 occurrence인 날만
        const eff = ev.recur
          ? eventOccurrenceOnOrAfter(ev.date, ev.recur, ev.recur_until, today)
          : ev.date;
        if (eff !== today) continue;
        const key = `${userId}:ev${ev.eid}:allday:${today}`;
        if (notified.has(key)) continue;
        notified.add(key);
        notifyUser(userId, {
          from: 'exist AI',
          text: `오늘 하루 종일 — '${ev.etitle}' (${ev.mtitle})`,
          meetingCode: ev.code,
        });
      }
    }
  }
}

/** 주기 작업 공통 — 스윕 하나가 던져도 타이머(프로세스)는 살아 있어야 한다 */
function safe(label: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    console.error(label, err);
  }
}

/** 서버 부팅 — app·소켓·Yjs·주기 스윕 타이머를 세우고 mediasoup 준비 뒤 listen 한다 */
export function startServer(port = Number(process.env.PORT ?? 4000)) {
  const app = createApp();
  const server = http.createServer(app);

  // AI 유저 확보 + 아바타 마이그레이션(🤖→✦)이 부팅 시 바로 적용되게
  ensureAgentUser();

  // Socket.IO(SFU 시그널링 + presence + nowbar 알림 push) — realtime.ts 로 분리 (통합 테스트에서 재사용)
  const io = attachRealtime(app, server);
  attachYjs(server); // tldraw /sync 제거 — 캔버스는 Excalidraw가 /yjs 사용

  const timers: NodeJS.Timeout[] = [];

  // 인수인계 미확인 에스컬레이션 — 10분마다 스윕 (기동 30초 뒤 1회 선실행)
  const handoverSweep = () => safe('[handover] 에스컬레이션 스윕 실패:', sweepHandoverEscalations);
  timers.push(setTimeout(handoverSweep, 30_000), setInterval(handoverSweep, 10 * 60_000));

  // 회람(열람 서명) 미확인 자동 에스컬레이션 — 기본 시간당 1회 스윕 (기동 45초 뒤 1회 선실행).
  // ACK_AUTOREMIND_HOURS가 1 미만(데모, 예: 0.02 ≈ 1분)이면 1분 간격으로 촘촘히 — 시연에서 바로 보이게
  const ackSweepMs = ackAutoRemindHours() < 1 ? 60_000 : 60 * 60_000;
  const ackSweep = () => {
    safe('[fileai] 회람 자동 리마인드 스윕 실패:', sweepFileAckAutoReminders);
    // 결정 미확인도 같은 리듬으로 — 문서 서명과 대칭 (박형우: "마지막 한 단계"를 시스템이 챙긴다)
    safe('[recap] 결정 자동 리마인드 스윕 실패:', sweepDecisionAckAutoReminders);
  };
  timers.push(setTimeout(ackSweep, 45_000), setInterval(ackSweep, ackSweepMs));

  // 회의·일정 리마인더 — 1분마다
  timers.push(setInterval(() => runMeetingReminders(), 60_000));

  // 할 일 마감 리마인드 — AI 총무가 임박(내일·오늘)·지남을 알아서 조름. 부팅 직후 1회 + 10분 간격
  const todoSweep = () => safe('[todos] 마감 리마인드 실패:', runTodoReminders);
  timers.push(setTimeout(todoSweep, 20_000), setInterval(todoSweep, 10 * 60_000));

  // 미확인자 리마인드 — 원장에 서명이 없는 참가자를 recap당 1회 보챈다 (현장 요구: "미확인자 알림")
  timers.push(setInterval(() => safe('[recap] 리마인드 실패:', runDecisionReminders), 10 * 60_000));

  const ready = startMediasoup().then(
    () =>
      new Promise<void>((resolve) => {
        server.listen(port, () => {
          console.log(`exist server listening on http://localhost:${port}`);
          resolve();
        });
      }),
  );

  return {
    app,
    server,
    io,
    ready,
    /** 테스트용 정리 — 타이머 해제 + 소켓/HTTP 서버 종료 */
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        io.close(() => resolve());
      }),
  };
}

if (process.env.NODE_ENV !== 'test') startServer();
