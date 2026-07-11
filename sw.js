/* CCTV 근무표 — 서비스 워커
   설치(홈 화면 추가)와 오프라인 동작을 위한 앱 셸 캐시.
   전략: 같은 출처 자원은 network-first(온라인이면 항상 최신) + 오프라인 시 캐시 폴백.
   버전을 올리면(아래 APP_VERSION) 이전 캐시는 자동 정리됩니다. */
const APP_VERSION = '4.2';
const CACHE = 'cctv-roster-' + APP_VERSION;

/* 앱 셸: 오프라인에서도 첫 화면이 뜨도록 미리 받아둘 핵심 자원.
   firebase-config.js / sync.js 는 동기화(선택) 자원이라 실패해도 무시합니다. */
const PRECACHE = [
  './',
  './index.html',
  './engine.js?v=4.2',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 개별 add 로 처리해 일부 자원이 없어도 설치가 실패하지 않게 함
    await Promise.allSettled(PRECACHE.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // 외부 자원(firebase SDK 등)은 네트워크 우선, 오프라인이면 캐시(있을 때) 폴백
  if (!sameOrigin) {
    e.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (_) {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw _;
      }
    })());
    return;
  }

  // 같은 출처: network-first → 성공 시 캐시 갱신, 실패 시 캐시 폴백
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch (_) {
      const cached = await cache.match(req);
      if (cached) return cached;
      // 네비게이션 요청이면 앱 셸로 폴백
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw _;
    }
  })());
});
