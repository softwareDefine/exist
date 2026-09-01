import type http from 'node:http';
import type { Express } from 'express';
import { Server } from 'socket.io';
import db from './db.js';
import { attachSfu } from './sfu.js';
import { initNotifier, notifyUser, emitToUser } from './notify.js';
import { setBlobViewing, clearBlobViewingBySocket } from './files.js';

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

/*
 * 실시간 계층 — Socket.IO 서버 생성 + 소켓 인증 + SFU 시그널링 + presence + notifier 주입.
 * index.ts 에서 떼어낸 이유: 통합 테스트가 고정 포트·리마인더 setInterval 없이
 * http 서버 하나에 소켓 계층만 붙여 검증할 수 있게. 프로덕션 동작은 index.ts 시절과 동일
 * (index.ts 가 이 함수 → attachYjs → 각종 스윕 타이머 순으로 호출).
 */
export function attachRealtime(app: Express, server: http.Server): Server {
  // Socket.IO — SFU 시그널링 + presence + nowbar 알림 push
  const io = new Server(server, {
    cors: { origin: CLIENT_ORIGIN },
    // 탭 강제 종료·모바일 백그라운드 같은 비정상 이탈 감지 시간 단축 (기본 25s+20s ≈ 최대 45초 → 최대 ~15초)
    // 통화 인원 표시가 이 감지에 걸려 있어서 기본값이면 "나갔는데 한참 남아 있는" 것처럼 보인다
    pingInterval: 10_000,
    pingTimeout: 5_000,
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
  initNotifier(io); // orgs 등 라우터에서 notifyUser 사용 가능하게

  /* ── 출근 브리핑 — 4시간 이상 자리를 비웠다 돌아오면(교대 출근의 신호) 밀린 확인거리를 한 번에.
   * 교대 누락의 타이밍 해법: 자는 사람에게 낮에 쏜 알림은 묻힌다 — 출근 순간에 다시 모아준다 */
  const welcomedAt = new Map<number, number>();
  function sendShiftBriefing(userId: number) {
    const recaps = db
      .prepare(
        `SELECT r.id, r.decisions FROM meeting_recaps r
         JOIN meeting_participants mp ON mp.meeting_id = r.meeting_id
         WHERE mp.user_id = ? AND r.created_at > datetime('now', '-3 days')`,
      )
      .all(userId) as { id: number; decisions: string }[];
    const ackStmt = db.prepare(
      'SELECT COUNT(DISTINCT decision_idx) AS n FROM decision_acks WHERE recap_id = ? AND user_id = ?',
    );
    let pendingDecisions = 0;
    for (const r of recaps) {
      let total = 0;
      try {
        total = (JSON.parse(r.decisions) as string[]).length;
      } catch {
        /* 구형 데이터 */
      }
      if (!total) continue;
      pendingDecisions += Math.max(0, total - (ackStmt.get(r.id, userId) as { n: number }).n);
    }
    const pendingHandover = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM handovers h
           JOIN meeting_participants mp ON mp.meeting_id = h.meeting_id
           WHERE mp.user_id = ? AND h.author_id != ? AND h.created_at > datetime('now', '-3 days')
             AND NOT EXISTS (SELECT 1 FROM handover_acks a WHERE a.handover_id = h.id AND a.user_id = ?)`,
        )
        .get(userId, userId, userId) as { n: number }
    ).n;
    if (pendingDecisions + pendingHandover === 0) return;
    const parts = [
      pendingDecisions ? `미확인 결정 ${pendingDecisions}건` : null,
      pendingHandover ? `인수인계 ${pendingHandover}건` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    notifyUser(userId, {
      from: 'exist AI',
      text: `출근 브리핑 — 자리 비운 사이 ${parts}이 기다리고 있어요. 작업 전에 확인해 주세요.`,
      kind: 'recap',
      meetingCode: '',
    });
  }

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

    // 출근 브리핑 트리거 — 마지막 접속에서 4시간+ 지났고, 최근 4시간 내 브리핑한 적 없으면
    try {
      const last = db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(userId) as
        | { last_seen_at: string | null }
        | undefined;
      const awayMs = last?.last_seen_at
        ? Date.now() - new Date(last.last_seen_at + 'Z').getTime()
        : 0;
      if (awayMs >= 4 * 3600_000 && Date.now() - (welcomedAt.get(userId) ?? 0) >= 4 * 3600_000) {
        welcomedAt.set(userId, Date.now());
        setTimeout(() => {
          try {
            sendShiftBriefing(userId);
          } catch (err) {
            console.error('[brief] 출근 브리핑 실패:', err);
          }
        }, 2500);
      }
    } catch {
      /* best effort */
    }

    // DM 창 열람 상태 — 보고 있는 상대의 메시지는 알림(notifyUser) 생략용
    socket.on('dm:viewing', (p: { peerId?: number | null } | undefined) => {
      const id = Number(p?.peerId);
      socket.data.dmPeer = Number.isInteger(id) ? id : null;
    });

    // 그룹 채팅 화면 열람 상태 — 채팅 알림 생략 판정용.
    // chat:CODE 룸 멤버십은 판정에 못 씀 (통합 메시지함이 전달용으로 전 그룹 룸을 구독함)
    socket.on('chat:viewing', (p: { code?: string | null } | undefined) => {
      socket.data.chatViewing = p?.code ? String(p.code).toUpperCase() : null;
    });

    // 업로드 파일 미리보기 열람 신고 — "누가 지금 이 파일을 보고 있나" (30초 심박, null=떠남)
    socket.on('file:viewing', (p: { code?: string; fileId?: number | null } | undefined) => {
      const code = p?.code ? String(p.code).toUpperCase() : null;
      if (!code) return;
      const meeting = db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as
        | { id: number }
        | undefined;
      if (!meeting) return;
      const isPart = db
        .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
        .get(meeting.id, userId);
      if (!isPart) return;
      const fid = Number(p?.fileId);
      setBlobViewing(meeting.id, socket.id, userId, Number.isInteger(fid) && fid > 0 ? fid : null);
      // 참가자들에게 재조회 핑 — 편집 프레즌스(ydoc pingPresence)와 같은 채널
      const parts = db
        .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?')
        .all(meeting.id) as { user_id: number }[];
      for (const q of parts) emitToUser(q.user_id, 'files:presence', { code });
    });

    // 탭 가시성 — 접속 소켓이 있어도 전부 백그라운드면 웹푸시(OS 알림)를 쏘기 위한 신호.
    // 구버전 클라(신호 안 보냄)는 true로 남아 기존 동작(접속 중이면 푸시 생략) 유지
    socket.data.visible = true;
    socket.on('presence:visible', (p: { visible?: boolean } | undefined) => {
      socket.data.visible = p?.visible !== false;
    });

    socket.on('disconnect', () => {
      // 이 소켓이 신고한 미리보기 시청 상태 즉시 정리 + 해당 그룹에 프레즌스 핑
      // (소켓 귀속 모델 — 탭 하나가 죽으면 그 탭 몫만 정확히 사라진다)
      for (const mid of clearBlobViewingBySocket(socket.id)) {
        try {
          const m = db.prepare('SELECT code FROM meetings WHERE id = ?').get(mid) as
            | { code: string }
            | undefined;
          if (!m) continue;
          const parts = db
            .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?')
            .all(mid) as { user_id: number }[];
          for (const q of parts) emitToUser(q.user_id, 'files:presence', { code: m.code });
        } catch {
          /* 방송 실패 무시 */
        }
      }
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

  return io;
}
