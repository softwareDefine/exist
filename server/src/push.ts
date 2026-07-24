import { Router } from 'express';
import webpush from 'web-push';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';

/*
 * 웹푸시 (PWA) — 접속해 있지 않은 사용자에게 OS 알림을 보낸다.
 * VAPID 키가 env에 없으면 전체가 조용히 비활성 (구독 API는 404).
 * 구독은 기기 단위(endpoint UNIQUE) — 같은 계정이 폰·데스크탑에 각각 구독 가능.
 */

const PUB = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com';
export const pushEnabled = !!(PUB && PRIV);

if (pushEnabled) {
  webpush.setVapidDetails(SUBJECT, PUB!, PRIV!);
}

export interface PushPayload {
  title: string;
  body: string;
  /** 같은 tag는 OS 알림에서 하나로 갱신됨 */
  tag?: string;
  /** 알림 클릭 시 열 경로 */
  url?: string;
}

/** userId의 모든 기기로 푸시 — 만료된 구독(404/410)은 정리 */
export function sendPushToUser(userId: number, payload: PushPayload) {
  if (!pushEnabled) return;
  const subs = db.prepare('SELECT id, sub FROM push_subs WHERE user_id = ?').all(userId) as {
    id: number;
    sub: string;
  }[];
  for (const s of subs) {
    let parsed: webpush.PushSubscription;
    try {
      parsed = JSON.parse(s.sub);
    } catch {
      db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
      continue;
    }
    webpush
      .sendNotification(parsed, JSON.stringify(payload), { TTL: 3600 })
      .catch((err: { statusCode?: number }) => {
        // 브라우저에서 구독 해지된 endpoint — 조용히 청소
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
        } else {
          console.error('[push] 발송 실패:', err?.statusCode ?? err);
        }
      });
  }
}

const router = Router();
router.use(requireAuth);

/** 클라 구독용 공개 키 — 푸시 비활성이면 404 */
router.get('/key', (_req, res) => {
  if (!pushEnabled) return res.status(404).json({ error: '푸시가 설정되지 않았어요' });
  res.json({ key: PUB });
});

/** 구독 등록/갱신 — endpoint 기준 upsert (기기 교체 시 소유자도 갱신) */
router.post('/subscribe', (req: AuthedRequest, res) => {
  if (!pushEnabled) return res.status(404).json({ error: '푸시가 설정되지 않았어요' });
  const sub = req.body?.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) {
    return res.status(400).json({ error: '구독 정보가 올바르지 않아요' });
  }
  db.prepare(
    `INSERT INTO push_subs (user_id, endpoint, sub) VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, sub = excluded.sub`,
  ).run(req.userId, sub.endpoint, JSON.stringify(sub));
  res.json({ ok: true });
});

/** 구독 해지 (로그아웃 등) */
router.post('/unsubscribe', (req: AuthedRequest, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint === 'string') {
    db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(
      endpoint,
      req.userId,
    );
  }
  res.json({ ok: true });
});

export default router;
