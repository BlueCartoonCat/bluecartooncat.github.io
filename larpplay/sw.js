// LarpPlay PWA offline shell. Works with the normal source layout AND the Webpack build.
// Android Auto packets travel over the browser WebSocket, never through this worker.
const CACHE = 'larpplay-shell-v1.1.2';
const CORE = ['./', './index.html', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const result = await fetch(event.request);
      if (result.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, result.clone());
      }
      return result;
    } catch {
      return (await caches.match(event.request)) ||
        (event.request.mode === 'navigate' && await caches.match('./index.html')) ||
        Response.error();
    }
  })());
});
