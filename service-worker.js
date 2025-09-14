const CACHE_NAME = 'fieldgps-v1';
const CORE_ASSETS = [
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
];
let CORE_URLS = [];

self.addEventListener('install', (event) => {
  CORE_URLS = CORE_ASSETS.map(p => new URL(p, self.registration.scope).toString());
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Cache-first for tiles and core assets, network-first for everything else
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isTile = /\/(tiles|tile|maps|basemaps|cartocdn|tile\.openstreetmap)\//i.test(url.href);
  if (isTile || CORE_URLS.includes(url.href)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const res = await fetch(event.request, { mode: 'cors' });
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch (e) {
          return cached || Response.error();
        }
      })
    );
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

