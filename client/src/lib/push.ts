import { api } from '../api';

/*
 * 웹푸시 구독 (PWA) — 로그인 후 한 번 호출.
 * 권한이 이미 허용돼 있으면 조용히 구독 갱신, 미정이면 딱 한 번만 물어본다.
 * 서버에 VAPID 키가 없으면(404) 아무것도 하지 않음.
 */

function b64ToUint8(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function initPush(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
      return;
    const reg = await navigator.serviceWorker.register('/sw.js');

    let perm = Notification.permission;
    if (perm === 'default' && !localStorage.getItem('exist:push-asked')) {
      localStorage.setItem('exist:push-asked', '1');
      perm = await Notification.requestPermission();
    }
    if (perm !== 'granted') return;

    const { key } = await api<{ key: string }>('/api/push/key');
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToUint8(key).buffer as ArrayBuffer,
      }));
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  } catch {
    /* 푸시는 부가 기능 — 실패해도 앱 동작에 영향 없음 */
  }
}
