const CACHE_NAME = 'my-quiz-offline-v2';
const APP_FILES = ['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_FILES);
    // Cache SheetJS during the first online visit so XLSX imports can work offline.
    try { const response = await fetch(XLSX_URL, {mode:'no-cors'}); await cache.put(XLSX_URL, response); } catch (e) {}
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('my-quiz-offline-') && k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin || req.url === XLSX_URL) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME); const cached = await cache.match(req);
      if (cached) return cached;
      try { const response = await fetch(req); if (response && (response.ok || response.type === 'opaque')) cache.put(req, response.clone()); return response; }
      catch (e) { if (url.origin === self.location.origin) { const fallback = await cache.match('./index.html'); if (fallback) return fallback; } throw e; }
    })());
  }
});
