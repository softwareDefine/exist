import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import authRouter from './auth.js';
import meetingsRouter from './meetings.js';
import todosRouter from './todos.js';
import db from './db.js';
import { startMediasoup, attachSfu } from './sfu.js';
import agentRouter, { getUserContext } from './agent.js';
import workspacesRouter from './workspaces.js';
import orgsRouter from './orgs.js';
import notificationsRouter from './notifications.js';
import runnerRouter from './runner.js';
import { attachSync } from './sync.js';
import { attachYjs } from './ydoc.js';
import { initNotifier, notifyUser } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

const app = express();
app.set('trust proxy', 1); // 리버스 프록시(HTTPS 종단) 뒤에서 req.ip 정상화
if (!isProd) app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

// 기본 보안 헤더
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'exist' }));
app.use('/api/auth', authRouter);
app.use('/api/meetings', meetingsRouter);
app.use('/api/todos', todosRouter);
app.use('/api/agent', agentRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/orgs', orgsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/run', runnerRouter);

// 프로덕션: 빌드된 클라이언트 정적 서빙 + SPA 폴백
const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
if (isProd && fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  console.log(`[static] serving client from ${clientDist}`);
}

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
attachSync(server);
attachYjs(server);
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
    if (e.count <= 0) online.delete(userId);
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
  }
}, 60_000);

const PORT = Number(process.env.PORT ?? 4000);
startMediasoup().then(() => {
  server.listen(PORT, () => {
    console.log(`exist server listening on http://localhost:${PORT}`);
  });
});
