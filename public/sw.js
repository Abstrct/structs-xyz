/* Offline shell for the Command Deck: the app's own static files are cached as they're used, so the
 * client opens (and the simulator, codex and vault work) without a network. Nothing else is touched:
 * no chain, guild or chat traffic is ever cached or intercepted. Works under a base path (a GitHub
 * project page): its scope is wherever it was registered from. */
const CACHE = 'structs-shell-' + (new URL(self.location.href).searchParams.get('v') || 'dev');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('structs-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Chat sign-in's callback carries a one-time code in its address: never cache it.
  if (url.pathname.endsWith('/comms-callback.html')) return;
  const isPage = req.mode === 'navigate';
  const isStatic = /\/(assets|fonts|img|sound)\//.test(url.pathname) || /\.(png|webp|jpg|svg|webmanifest|woff2|ttf|mp3)$/.test(url.pathname);
  if (!isPage && !isStatic) return;
  if (isPage) {
    // The page: network first (new deploys win), the cached copy when offline.
    e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.open(CACHE).then((k) => k.put(req, c)); return r; }).catch(() => caches.match(req).then((r) => r || caches.match(self.registration.scope))));
    return;
  }
  // Hashed assets never change: cache first.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then((k) => k.put(req, c)); } return r; })));
});
