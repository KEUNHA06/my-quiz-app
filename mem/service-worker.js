const CACHE='txt-memory-v2';
const FILES=['./','./index.html','./manifest.json','./icon.svg','./icon-180.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const url=new URL(e.request.url);if(url.origin!==location.origin)return;e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(response=>{if(response.ok&&url.pathname.startsWith(new URL('./',self.registration.scope).pathname)){const copy=response.clone();caches.open(CACHE).then(c=>c.put(e.request,copy))}return response}).catch(()=>caches.match('./index.html'))))});
