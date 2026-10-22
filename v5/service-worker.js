const CACHE_NAME = "job-audio-reader-v1";
const SHELL = ["./", "./index.html"];
const LIBS = [
 "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
 "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"
];
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL);
    // Cache PDF.js for offline use after the first successful online installation.
    for (const url of LIBS) {
      try {
        const response = await fetch(url, {mode:"cors", cache:"reload"});
        if (response.ok) await cache.put(url, response.clone());
      } catch (_) {}
    }
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin === self.location.origin || url.href.startsWith("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, {ignoreSearch:true});
      if (cached) return cached;
      try {
        const response = await fetch(req);
        if (response && (response.ok || response.type === "opaque")) {
          try { await cache.put(req, response.clone()); } catch (_) {}
        }
        return response;
      } catch (e) {
        return cached || Response.error();
      }
    })());
  }
});