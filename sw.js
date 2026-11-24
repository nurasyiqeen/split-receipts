// Offline support. Network first (so updates show up straight away), cache as fallback when offline.
const CACHE = 'split-receipts-v18';
const SHELL = ['./', 'index.html', 'styles.css', 'js/app.js', 'js/db.js', 'js/scan.js', 'js/split.js', 'manifest.json', 'icon.svg', 'icon-192.png'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache so we never store an outdated copy.
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => fetch(new Request(u, { cache: 'reload' })).then(r => r.ok && c.put(u, r)))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
    // Reload any open app windows so they pick up the new version (works even for old app code).
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url).catch(() => {});
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never touch API calls or fonts
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request, { cache: 'no-cache' }); // revalidate with the server every time
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || (e.request.mode === 'navigate' ? cache.match('index.html') : Response.error());
    }
  })());
});
