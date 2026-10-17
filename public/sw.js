// Service worker for the mobile app (scope /app/): keeps the app, the models
// and the WebAssembly runtimes cached so it starts without a connection.
// API calls always go to the network.
const CACHE = 'cogniroute-v1';
const PRECACHE = ['/app/', '/manifest.webmanifest', '/icons/icon-192.png'];
const CACHE_FIRST = [/^\/assets\//, /^\/models\//, /^\/vendor\//, /^\/icons\//, /\.worklet\.js$/];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (CACHE_FIRST.some((re) => re.test(url.pathname))) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(event.request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Pages: network first, cached copy when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && event.request.mode === 'navigate') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/app/'))),
  );
});
