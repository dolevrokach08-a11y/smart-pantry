/* Smart Pantry service worker — network-first to avoid stale code,
 * cache fallback for offline. Bump CACHE to force a refresh. */
const CACHE = 'smart-pantry-v11';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './ui.js', './prices.js',
  './manifest.webmanifest', './icon.svg', './landing.html',
];
// prices.json is intentionally NOT precached — it's served network-first so the
// app always sees the latest supermarket data, with cache as offline fallback.

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Firebase / CDN go straight to network
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});
