/* ============================================================
   Service Worker · offline-first
   - 首次加载时预缓存全部静态资源
   - 后续所有请求 cache-first，失败回落到网络
   - content.json 使用 stale-while-revalidate：优先用缓存，
     后台更新（这样用户改了 content.json 下次刷新就能看到）
   ============================================================ */

const CACHE = 'anniv-countdown-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './content.json'
];

// Install: precache core
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: purge old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategies
self.addEventListener('fetch', (event) => {
  const req = event.request;
  // only handle GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // ignore cross-origin
  if (url.origin !== self.location.origin) return;

  // content.json → stale-while-revalidate
  if (url.pathname.endsWith('/content.json')) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // everything else → cache-first with network fallback
  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.status === 200 && res.type === 'basic') {
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    // fallback to index.html for navigations
    if (req.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    throw e;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then((res) => {
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || networkPromise;
}
