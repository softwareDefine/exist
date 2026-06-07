import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { Server } from 'socket.io';
import authRouter from './auth.js';
import meetingsRouter from './meetings.js';
import todosRouter from './todos.js';

const app = express();
app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'exist' }));
app.use('/api/auth', authRouter);
app.use('/api/meetings', meetingsRouter);
app.use('/api/todos', todosRouter);

const server = http.createServer(app);

// Socket.IO — 추후 mediasoup 시그널링 + presence + nowbar 알림 push에 사용
const io = new Server(server, {
  cors: { origin: 'http://localhost:5173' },
});

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[socket] disconnected: ${socket.id}`));
});

const PORT = Number(process.env.PORT ?? 4000);
server.listen(PORT, () => {
  console.log(`exist server listening on http://localhost:${PORT}`);
});
