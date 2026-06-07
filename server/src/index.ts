import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { Server } from 'socket.io';
import authRouter from './auth.js';
import meetingsRouter from './meetings.js';
import todosRouter from './todos.js';
import db from './db.js';
import { startMediasoup, attachSfu } from './sfu.js';

const app = express();
app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'exist' }));
app.use('/api/auth', authRouter);
app.use('/api/meetings', meetingsRouter);
app.use('/api/todos', todosRouter);

const server = http.createServer(app);

// Socket.IO — SFU 시그널링 + presence + nowbar 알림 push
const io = new Server(server, {
  cors: { origin: 'http://localhost:5173' },
});

// 소켓 인증: handshake.auth.token으로 세션 검증
io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error('unauthorized'));
  const row = db
    .prepare(
      `SELECT s.user_id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(token) as { user_id: number; username: string } | undefined;
  if (!row) return next(new Error('unauthorized'));
  socket.data.userId = row.user_id;
  socket.data.username = row.username;
  next();
});

attachSfu(io);

const PORT = Number(process.env.PORT ?? 4000);
startMediasoup().then(() => {
  server.listen(PORT, () => {
    console.log(`exist server listening on http://localhost:${PORT}`);
  });
});
