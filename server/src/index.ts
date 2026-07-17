import 'dotenv/config';
import http from 'node:http';
import { Server } from 'socket.io';
import db from './db.js';
import { startMediasoup, attachSfu } from './sfu.js';
import { getUserContext } from './agent.js';
import { attachYjs } from './ydoc.js';
import { initNotifier, notifyUser } from './notify.js';
import { createApp } from './app.js';

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

const app = createApp();
const server = http.createServer(app);

// Socket.IO — SFU 시그널링 + presence + nowbar 알림 push
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN },
});

// 소켓 인증: handshake.auth.token으로 세션 검증
io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error('unauthorized'));
  const row = db
    .prepare(
      `SELECT s.user_id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.created_at > datetime('now', '-30 days')`,
    )
    .get(token) as { user_id: number; username: string } | undefined;
  if (!row) return next(new Error('unauthorized'));
  socket.data.userId = row.user_id;
  socket.data.username = row.username;
  next();
});

attachSfu(io);
attachYjs(server); // tldraw /sync 제거 — 캔버스는 Excalidraw가 /yjs 사용
initNotifier(io); // orgs 등 라우터에서 notifyUser 사용 가능하게

// ── presence: 접속 중인 사용자 (exist의 존재감 레이어) ──
const online = new Map<number, { username: string; count: number }>();

function broadcastPresence() {
  io.emit('presence:update', { users: [...online.values()].map((u) => u.username) });
}

io.on('connection', (socket) => {
  const userId = socket.data.userId as number;
  const username = socket.data.username as string;
  const entry = online.get(userId);
  if (entry) entry.count++;
  else online.set(userId, { username, count: 1 });
  broadcastPresence();

  socket.on('disconnect', () => {
    const e = online.get(userId);
    if (!e) return;
    e.count--;
    if (e.count <= 0) {
      online.delete(userId);
      // 마지막 소켓이 끊긴 시각 = "자리를 비운 시점" — P2 놓친 것 브리핑의 기준
      db.prepare(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`).run(userId);
    }
    broadcastPresence();
  });
});

app.get('/api/presence', (_req, res) => {
  res.json({ users: [...online.values()].map((u) => u.username) });
});

// ── AI agent 푸시 알림: 회의 시작 30분/10분 전 리마인더 ──
const notified = new Set<string>(); // `${userId}:${meetingTitle}:${threshold}`

setInterval(() => {
  const now = new Date();
  for (const socket of io.sockets.sockets.values()) {
    const userId = socket.data.userId as number | undefined;
    if (!userId) continue;
    const ctx = getUserContext(userId);
    for (const m of ctx.meetings) {
      if (!m.starts_at) continue;
      const min = Math.round((new Date(m.starts_at).getTime() - now.getTime()) / 60_000);
      // 걸린 임계값(30/10분)을 모두 소진 처리하되 알림은 한 번만 (중복 토스트 방지)
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

    // 회의 일정 이벤트(통화 등, 시간 있는 것)도 30/10분 전 리마인더
    const events = db
      .prepare(
        `SELECT e.id AS eid, e.title AS etitle, e.date, e.time, e.is_call, m.code, m.title AS mtitle
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
      code: string;
      mtitle: string;
    }[];
    for (const ev of events) {
      const start = new Date(`${ev.date}T${ev.time}`);
      const min = Math.round((start.getTime() - now.getTime()) / 60_000);
      const due = [30, 10].filter(
        (t) => min <= t && min > 0 && !notified.has(`${userId}:ev${ev.eid}:${t}`),
      );
      if (due.length > 0) {
        due.forEach((t) => notified.add(`${userId}:ev${ev.eid}:${t}`));
        notifyUser(userId, {
          from: 'exist AI',
          text: ev.is_call
            ? `'${ev.etitle}' 통화 ${min}분 뒤 시작 — 들어오세요 (${ev.mtitle})`
            : `'${ev.etitle}' ${min}분 뒤 시작 — ${ev.mtitle}`,
          meetingCode: ev.code,
          kind: ev.is_call ? 'call' : undefined,
        });
      }
    }
  }
}, 60_000);

const PORT = Number(process.env.PORT ?? 4000);
startMediasoup().then(() => {
  server.listen(PORT, () => {
    console.log(`exist server listening on http://localhost:${PORT}`);
  });
});
