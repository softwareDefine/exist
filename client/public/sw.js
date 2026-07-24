/*
 * exist 서비스워커 — PWA 설치 + 웹푸시 수신.
 * 오프라인 캐시는 하지 않음(실시간 협업 앱이라 stale 화면이 더 해로움) —
 * fetch 핸들러는 설치 가능 조건을 위해 존재하고 네트워크를 그대로 통과시킨다.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// 서버 push.ts 가 보낸 { title, body, tag, url }
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    /* 형식 밖 페이로드 무시 */
  }
  e.waitUntil(
    self.registration.showNotification(data.title || 'exist', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'exist',
      data: { url: data.url || '/' },
    }),
  );
});

// 알림 클릭 — 열린 창 있으면 포커스, 없으면 새로 열기
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(e.notification.data?.url || '/');
    }),
  );
});
