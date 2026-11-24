/* Skyway Driver — service worker.
   Caches the driver page shell (driver.html / driver.js / driver.css / manifest)
   so the page opens with no signal after the first load. The job itself lives in
   the URL hash and in localStorage, so nothing else is needed offline.
   Bump CACHE when any of the shell files change.
   The console's add-on modules are listed too so a station that registers this worker
   (https only) keeps them offline; a missing file never fails the install. */
var CACHE = 'skyway-driver-v5';
var MODULES = ['./fixes.js', './quote.js', './ops.js', './ledger.js', './crm.js', './recurring.js', './plan.js', './recover.js', './tolls.js', './maps.js', './maps.css', './callerhist.js', './desk.js', './desk.css', './smooth.js', './setup.js', './setup.css'];
var SHELL = ['./driver.html', './driver.js', './driver.css', './manifest.webmanifest'].concat(MODULES);

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(CACHE).then(function (c) {
      // add one by one so a single missing file does not fail the whole install
      return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isShell(url) {
  try {
    var u = new URL(url);
    if (u.origin !== self.location.origin) return false;
    var p = u.pathname.split('/').pop();
    if (MODULES.indexOf('./' + p) >= 0) return true;
    return p === 'driver.html' || p === 'driver.js' || p === 'driver.css' || p === 'manifest.webmanifest' || p === '';
  } catch (e) { return false; }
}

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  var nav = req.mode === 'navigate';
  if (!nav && !isShell(req.url)) return;          // maps, sms etc. go straight through
  ev.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(req, { ignoreSearch: true }).then(function (hit) {
        // network in the background to keep the shell fresh (stale-while-revalidate)
        var fresh = fetch(req).then(function (res) {
          if (res && res.ok && isShell(req.url)) { try { c.put(req, res.clone()); } catch (e) {} }
          return res;
        }).catch(function () { return null; });
        if (hit) { fresh.catch(function () {}); return hit; }
        return fresh.then(function (res) {
          if (res) return res;
          if (nav) return c.match('./driver.html');
          return new Response('', { status: 503, statusText: 'offline' });
        });
      });
    })
  );
});
