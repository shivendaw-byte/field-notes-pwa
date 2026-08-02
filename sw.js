/* Field Notes service worker — offline-first app shell */
var CACHE = 'field-notes-v13';
var ASSETS = [
  './', './index.html', './styles.css', './app.js', './data.js',
  './sync.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png',
  './icons/apple-touch-icon.png', './icons/favicon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // Sync is live data — never cache it, or the app would keep replaying a
  // stale snapshot and silently lose edits made on the other device.
  if (url.pathname.indexOf('/api/') === 0) return;

  // Navigations: network first, fall back to cached shell so the app opens offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
          return res;
        })
        .catch(function () {
          return caches.match('./index.html').then(function (r) {
            return r || caches.match('./');
          });
        })
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  // Pure cache-first would pin the app to whatever shipped with this cache
  // name, so an app.js change with no sw.js change would never reach anyone.
  // Serving the cached copy immediately keeps it instant and offline-capable,
  // while the background refetch means the next load has the new version.
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(e.request).then(function (cached) {
        var net = fetch(e.request).then(function (res) {
          if (res && res.status === 200 && res.type === 'basic') cache.put(e.request, res.clone());
          return res;
        }).catch(function () { return null; });

        if (cached) { e.waitUntil(net); return cached; }
        return net.then(function (r) {
          return r || new Response('', { status: 504, statusText: 'Offline and not cached' });
        });
      });
    })
  );
});
