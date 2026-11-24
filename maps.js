/* ======================================================================
   Skyway — maps.js
   Google Maps end to end, with the free maps (OpenStreetMap / OSRM) and an
   offline route diagram whenever there is no key, no Google or no signal.

   (a) Route card inside the Book form's Trip Preview (Simple and Expert, and the
       Call Entry pop-out). Draws pick-up -> stops -> drop-off as the trip is priced:
       Google Map + the fastest route and up to two faint alternates (miles · minutes)
       when Google is on; the console's own Leaflet preview when only the free map is
       up; an SVG run diagram with straight-line numbers when fully offline. Below the
       map: distance, drive time, "leave by" for scheduled rides (pickup time minus the
       drive from the chosen driver's spot, else from the base), the crossings from
       tolls.js, an "Open in Google Maps" link (no key needed) and "Share route".
       The chosen route is window.Maps.currentRoute(); tolls.js reads it through
       Maps.routeGeo(formTrip) so crossings come from the real road.
   (b) Live driver map (Drivers -> Fleet in Simple; Fleet and Trip Map in Expert):
       every on-duty driver from drivers[].curLoc, coloured by how fresh the pin is
       (green < 5 min, amber < 20 min, grey older), the selected trip's pick-up as a
       target, click a driver -> assignDriver(trip, driver) so ops.js's gate applies.
       Refreshes when a pin changes (DriverLink.ingestLocation / setDriverLoc /
       clearDriverLoc wraps) and every 15 s while it is on screen.
   (c) "ETA 12 min" on Dispatched board rows (MutationObserver on the boards): Google
       directions when loaded (cached 60 s per driver/trip, at most one call per 30 s
       per pair), else straight line at 18 mph. A Needs-you line when the driver will
       reach the pick-up more than settings.maps.lateMin minutes after pickup time.
   (d) Address chips next to pick-up, stops and drop-off: ✓ found, ? not found (top 3
       suggestions from the console's own address search), ✈ airport. Uses the console's
       STATE.geocache / addrbook (never a second cache); geocode() calls for the same
       address while one is already running share the same answer.
   (e) Google health chip: "Google on" / "Google off (free maps)" / "Key invalid" /
       "No internet" on the card, the driver map and the Settings hub (Maps & region),
       with Test Google and the map doctor wired. A Needs-you line when Google failed
       to start more than once today (kept per computer in localStorage
       skyway_maps_health). Google is never loaded from a file:// page by this module
       (Google refuses keys there); a Google that is already loaded is always used.
   (f) API window.Maps = {routeFor, currentRoute, routeGeo, driverMap, eta, status,
       googleDirUrl, refresh, checkGoogle, addrConfidence, _loaded:true}.

   STATE keys owned here: settings.maps {routeCard, driverMap, etaOnBoard, lateMin,
   provider:'auto'|'free'}, trips[].routeGeo (compact [[lng,lat],...] of the route
   chosen when the trip was booked). No network of its own: Google only through the
   console's loadGoogleMaps/ensureGoogleReady/gRoute, OSRM only through routeFor.
   Wrap pattern: window.fn = wrapper, wrapper._orig, wrapper._mapsWrapped.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;
  if (window.Maps && window.Maps._loaded) return;

  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }
  var ENTRY = POPOUT === 'entry';

  /* ---------- helpers ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { try { if (typeof window.toast === 'function') window.toast(m, w); } catch (e) {} }
  function save() { try { if (typeof window.save === 'function') { window.save(); return; } } catch (e) {} try { if (typeof window.saveNow === 'function') window.saveNow(); } catch (e) {} }
  function log(e) { try { console.warn('[maps]', e && e.message ? e.message : e); } catch (e2) {} }
  function act(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { log(e); } }; }
  function num(n) { n = Number(n); return isFinite(n) ? n : 0; }
  function fn(name) { return typeof window[name] === 'function' ? window[name] : null; }
  function trips() { if (!Array.isArray(STATE.trips)) STATE.trips = []; return STATE.trips; }
  function drivers() { if (!Array.isArray(STATE.drivers)) STATE.drivers = []; return STATE.drivers; }
  function findTrip(id) { return trips().filter(function (t) { return t && t.id === id; })[0] || null; }
  function findDriver(id) { return drivers().filter(function (d) { return d && d.id === id; })[0] || null; }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  var DEF = { routeCard: true, driverMap: true, etaOnBoard: true, lateMin: 10, provider: 'auto' };
  function MS() {
    var s = settings();
    if (!s.maps || typeof s.maps !== 'object' || Array.isArray(s.maps)) s.maps = {};
    return s.maps;
  }
  function opt(k) { var m = MS(); return m[k] === undefined ? DEF[k] : m[k]; }
  function lateMin() { var n = Number(opt('lateMin')); return isFinite(n) && n >= 1 && n <= 240 ? n : 10; }
  function isOnline() { try { if (typeof window.isOnline === 'function') return !!window.isOnline(); } catch (e) {} return navigator.onLine !== false; }
  function gKeyOn() { try { return typeof window.googleOn === 'function' ? !!window.googleOn() : false; } catch (e) { return false; } }
  function gKey() { try { return typeof window.gKey === 'function' ? String(window.gKey() || '') : String(settings().gmapkey || '').trim(); } catch (e) { return ''; } }
  function pad2(n) { return ('0' + n).slice(-2); }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function hm(d) { if (!d || isNaN(d)) return ''; var h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? 'pm' : 'am'; h = h % 12; if (h === 0) h = 12; return h + ':' + pad2(m) + ap; }
  function up(s) { return String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim(); }
  function shortA(a) { return String(a || '').split(',')[0].trim(); }
  function hav(a, b) { var R = 3958.8, r = function (x) { return x * Math.PI / 180; }; var dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng); var s = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.pow(Math.sin(dLng / 2), 2); return 2 * R * Math.asin(Math.sqrt(s)); }
  function okPt(p) { return !!p && isFinite(Number(p.lat)) && isFinite(Number(p.lng)) && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180 && !(Number(p.lat) === 0 && Number(p.lng) === 0); }
  function pt(p) { return { lat: Number(p.lat), lng: Number(p.lng) }; }
  function coordsFor(a) { if (!a) return null; try { if (typeof window.coordsForAddr === 'function') { var c = window.coordsForAddr(a); if (okPt(c)) return c; } } catch (e) {} return null; }
  function airportOf(a) { try { if (typeof window.airportKey === 'function') return window.airportKey(a); } catch (e) {} var A = up(a); return /\bLGA\b|LAGUARDIA/.test(A) ? 'LGA' : /\bJFK\b|KENNEDY/.test(A) ? 'JFK' : /\bEWR\b|NEWARK AIRPORT/.test(A) ? 'EWR' : null; }
  function pickupMs(t) { try { if (typeof window.pickupDT === 'function') { var d = window.pickupDT(t); return d && !isNaN(d) ? d.getTime() : null; } } catch (e) {} return null; }
  function parseWhen(s) {
    if (!s) return null; s = String(s);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    var d = new Date(s); return isNaN(d) ? null : d.getTime();
  }
  function isSimple() { try { return !!(window.Simple && typeof window.Simple.isSimple === 'function' && window.Simple.isSimple()); } catch (e) {} var s = settings(); return s.simpleMode !== false && !s.expertMode; }
  function visible(el) { return !!(el && el.offsetParent !== null && document.body.contains(el)); }
  function race(p, ms) { return Promise.race([Promise.resolve(p).catch(function () { return null; }), new Promise(function (r) { setTimeout(function () { r(null); }, ms); })]); }

  /* ---------- wrap helper ---------- */
  function inheritFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_{1,2}\w*Wrapped$/.test(k) && w[k] === undefined) w[k] = orig[k]; }); } catch (e) {} return w; }
  function wrapOn(obj, name, maker) {
    try {
      var orig = obj && obj[name];
      if (typeof orig !== 'function' || orig._mapsWrapped) return false;
      var w = maker(orig); w._mapsWrapped = true; w._orig = orig; inheritFlags(w, orig);
      obj[name] = w; return true;
    } catch (e) { return false; }
  }
  function after(name, cb) { return wrapOn(window, name, function (orig) { return function () { var r = orig.apply(this, arguments); try { cb.apply(null, arguments); } catch (e) { log(e); } return r; }; }); }

  /* ======================================================================
     Google health
     ====================================================================== */
  var HKEY = 'skyway_maps_health';
  var session = { gFail: false, startupDone: false };
  function keyTag(k) { var h = 0; k = String(k || ''); for (var i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0; return k ? 'k' + (h >>> 0).toString(36) : ''; }
  function health() {
    var h = null; try { h = JSON.parse(localStorage.getItem(HKEY) || 'null'); } catch (e) { h = null; }
    if (!h || typeof h !== 'object') h = {};
    if (h.day !== todayStr()) { h.day = todayStr(); h.fails = 0; }
    h.fails = Math.max(0, Number(h.fails) || 0);
    return h;
  }
  function putHealth(h) { try { localStorage.setItem(HKEY, JSON.stringify(h)); } catch (e) {} }
  function recordGoogle(ok, why, startup) {
    var h = health();
    h.last = ok ? 'ok' : 'fail'; h.key = keyTag(gKey()); h.at = new Date().toISOString(); h.why = why || '';
    if (!ok && startup) h.fails = (h.fails || 0) + 1;
    putHealth(h);
    if (!ok) session.gFail = true; else session.gFail = false;
    refreshChips(); scheduleNY();
  }
  function googleLoaded() { try { return !!(window.google && window.google.maps && typeof window.google.maps.Map === 'function'); } catch (e) { return false; } }
  function isFilePage() { try { return location.protocol === 'file:'; } catch (e) { return false; } }
  function mayLoadGoogle() { return gKeyOn() && !isFilePage() && !session.gFail && opt('provider') !== 'free'; }
  function googleUsable() { return opt('provider') !== 'free' && gKeyOn() && !window._gAuthFail && !session.gFail && (googleLoaded() || mayLoadGoogle()); }
  /* Google calls window.gm_authFailure when it refuses the key (wrong referrer, billing off): note it, keep any earlier handler */
  function hookAuthFailure() {
    var prev = window.gm_authFailure;
    if (prev && prev._mapsWrapped) return;
    var w = function () { window._gAuthFail = true; try { if (typeof prev === 'function') prev.apply(this, arguments); } catch (e) {} try { recordGoogle(false, 'auth', !session.startupDone); session.startupDone = true; } catch (e) {} try { unbreakInputs(true); } catch (e) {} };
    w._mapsWrapped = true; w._orig = prev || null; window.gm_authFailure = w;
  }
  /* When Google refuses the key (for example a map drawn on a page the key does not allow) it greys out every
     address box it had attached to ("Oops! Something went wrong."). Give the boxes back at once so the dispatcher
     can keep typing; the console's own address suggestions take over. */
  var unbreakObs = null;
  function unbreakInputs(watch) {
    var els = document.querySelectorAll('input.gm-err-autocomplete');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      el.classList.remove('gm-err-autocomplete');
      if (el.disabled) el.disabled = false;
      if (/went wrong/i.test(el.placeholder || '')) el.placeholder = el.getAttribute('data-maps-ph') || 'Start typing an address…';
      try { el.style.backgroundImage = ''; } catch (e) {}
    }
    if (watch && !unbreakObs && typeof MutationObserver === 'function' && document.body) {
      unbreakObs = new MutationObserver(function (muts) {
        for (var j = 0; j < muts.length; j++) { var t = muts[j].target; if (t && t.classList && t.classList.contains('gm-err-autocomplete')) { setTimeout(function () { unbreakInputs(false); }, 0); return; } }
      });
      unbreakObs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'disabled'] });
      [0, 300, 1500].forEach(function (ms) { setTimeout(function () { unbreakInputs(false); }, ms); });
    }
  }
  function rememberPlaceholders() {
    var els = document.querySelectorAll('input[data-gp], input[data-ac]');
    for (var i = 0; i < els.length; i++) { var el = els[i], ph = el.placeholder || ''; if (ph && !/went wrong/i.test(ph) && !el.hasAttribute('data-maps-ph')) el.setAttribute('data-maps-ph', ph); }
  }
  var gNull = 0;
  /* True when Google is (or can be) up. Never starts a Google load from a file:// page. */
  function googleReady() {
    if (opt('provider') === 'free' || !gKeyOn()) return Promise.resolve(false);
    if (googleLoaded()) return Promise.resolve(true);
    if (!mayLoadGoogle() || typeof window.ensureGoogleReady !== 'function') return Promise.resolve(false);
    return race(window.ensureGoogleReady(), 7000).then(function (ok) {
      var up2 = !!ok && googleLoaded();
      if (!up2) recordGoogle(false, 'load', !session.startupDone);
      session.startupDone = true;
      return up2;
    });
  }
  /* Calls into the console's address search / routing only when they cannot start a Google load we would not start */
  function consoleNetSafe() { return !gKeyOn() || googleLoaded() || mayLoadGoogle(); }
  function gtestText() { var o = byId('s_gtestOut'); return o ? String(o.textContent || '') : ''; }
  function status() {
    var key = !!gKey(), online = isOnline(), h = health(), loaded = googleLoaded(), tag = keyTag(gKey());
    var r = { mode: 'free', label: 'Google off (free maps)', why: '', key: key, online: online, loaded: loaded, failsToday: h.fails || 0 };
    if (!online) { r.mode = 'offline'; r.label = 'No internet (route diagram)'; r.why = 'No signal: the run diagram and straight-line distances are shown.'; return r; }
    if (!key) { r.why = 'No Google key: the free OpenStreetMap service is used.'; return r; }
    if (opt('provider') === 'free') { r.why = 'Set to free maps in Settings.'; return r; }
    var bad = !!window._gAuthFail || /❌/.test(gtestText()) || (h.last === 'fail' && h.key === tag && (!loaded || session.gFail));
    if (bad) { r.mode = 'invalid'; r.label = 'Key invalid'; r.why = window._gAuthFail ? 'Google refused the key for this page.' : 'Google did not start with this key. Free maps are used meanwhile.'; return r; }
    if (loaded) { r.mode = 'google'; r.label = 'Google on'; r.why = 'Google map, search and driving times are live.'; return r; }
    if (isFilePage()) { r.why = 'Google only works when the app is opened at http://localhost:8080 (start-skyway), not as a file.'; return r; }
    r.mode = 'google'; r.label = 'Google on'; r.why = 'Google starts the first time a map is needed.';
    return r;
  }
  /* Google can come up (or go away) after the chips were drawn: the console loads it in the background. Repaint
     the chips whenever the answer changes; cheap, no network. */
  var lastChipSig = '';
  function chipsIfChanged() { try { var s = status(), sig = s.mode + '|' + s.label; if (sig !== lastChipSig) { lastChipSig = sig; refreshChips(); } } catch (e) {} }
  function chipHtml() { var s = status(); return '<span class="maps-chip maps-st-' + s.mode + '" data-maps-chip="1" title="' + esc(s.why) + '">' + esc(s.label) + '</span>'; }
  function refreshChips() {
    try {
      var s = status(); lastChipSig = s.mode + '|' + s.label;
      document.querySelectorAll('[data-maps-chip]').forEach(function (c) { c.className = 'maps-chip maps-st-' + s.mode; c.textContent = s.label; c.title = s.why; });
      var w = byId('mapsPanelWhy'); if (w) w.textContent = s.why + (s.failsToday ? ' Google failed to start ' + s.failsToday + '× today.' : '');
      setupChip();
    } catch (e) { log(e); }
  }
  function checkGoogle() {
    if (!gKeyOn()) { refreshChips(); return Promise.resolve(false); }
    if (googleLoaded()) { recordGoogle(true, 'loaded'); return Promise.resolve(true); }
    if (typeof window.ensureGoogleReady !== 'function') return Promise.resolve(false);
    var first = !session.startupDone; session.startupDone = true;
    return race(window.ensureGoogleReady(), 7000).then(function (ok) { var u = !!ok && googleLoaded(); recordGoogle(u, u ? 'loaded' : 'load', first); return u; });
  }

  /* ======================================================================
     Routing (cached)
     ====================================================================== */
  var RC = {}, INFLIGHT = {};
  function ptsKey(points) { return points.map(function (p) { return Number(p.lat).toFixed(4) + ',' + Number(p.lng).toFixed(4); }).join('|'); }
  function speed() { var r = settings().rate; var s = r && Number(r.speed); return s > 0 ? s : 20; }
  function straight(points) {
    var mi = 0; for (var i = 0; i < points.length - 1; i++) mi += hav(points[i], points[i + 1]);
    var road = mi * 1.4;
    return { miles: road, minutes: road / speed() * 60, straightMiles: mi, geo: null, alts: [], src: 'line' };
  }
  function lineOf(geo) {
    try {
      if (!geo) return [];
      if (Array.isArray(geo)) return geo.filter(function (c) { return Array.isArray(c) && isFinite(c[0]) && isFinite(c[1]); });
      if (geo.type === 'Feature') return lineOf(geo.geometry);
      if (geo.type === 'LineString') return lineOf(geo.coordinates);
      if (geo.type === 'MultiLineString') { var o = []; (geo.coordinates || []).forEach(function (l) { o = o.concat(lineOf(l)); }); return o; }
    } catch (e) {}
    return [];
  }
  function asLine(geo) { var c = lineOf(geo); return c.length > 1 ? { type: 'LineString', coordinates: c } : null; }
  function compact(geo, max) {
    var c = lineOf(geo); max = max || 300; if (c.length < 2) return null;
    var step = c.length > max ? (c.length - 1) / (max - 1) : 1, out = [];
    for (var i = 0; i < c.length; i = step === 1 ? i + 1 : i + step) { var p = c[Math.min(c.length - 1, Math.round(i))]; out.push([Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]); if (step !== 1 && Math.round(i) >= c.length - 1) break; }
    var last = c[c.length - 1], lp = out[out.length - 1];
    if (lp[0] !== Math.round(last[0] * 1e5) / 1e5 || lp[1] !== Math.round(last[1] * 1e5) / 1e5) out.push([Math.round(last[0] * 1e5) / 1e5, Math.round(last[1] * 1e5) / 1e5]);
    return out;
  }
  function fromConsoleCache(points) { try { var c = window._rc && window._rc[ptsKey(points)]; if (c && c.geo && isFinite(c.miles)) return c; } catch (e) {} return null; }
  function routeFor(points, opts) {
    opts = opts || {};
    var pts = (Array.isArray(points) ? points : []).filter(okPt).map(pt);
    if (pts.length < 2) return Promise.resolve(null);
    var k = ptsKey(pts), hit = RC[k];
    if (hit && Date.now() - hit.at < 600000 && (hit.r.src !== 'line' || !isOnline())) return Promise.resolve(hit.r);
    if (INFLIGHT[k]) return INFLIGHT[k];
    var p = (async function () {
      var r = null;
      if (!opts.noNet && isOnline() && googleUsable() && typeof window.gRoute === 'function') {
        var ok = await googleReady();
        if (ok) {
          var g = await race(window.gRoute(pts, true), 6000);
          if (!g) { gNull++; if (gNull >= 2 && !session.gFail) recordGoogle(false, 'route'); } else gNull = 0;
          if (g && isFinite(g.miles)) {
            r = { miles: g.miles, minutes: g.minutes, geo: asLine(g.geo), alts: (g.alts || []).filter(function (a) { return a && a.geo; }).slice(0, 2).map(function (a) { return { miles: a.miles, minutes: a.minutes, geo: asLine(a.geo) }; }), src: 'google' };
            try { window._rc = window._rc || {}; if (!window._rc[k] && r.geo) window._rc[k] = { miles: r.miles, minutes: r.minutes, geo: r.geo }; } catch (e) {}
          }
        }
      }
      if (!r) { var cc = fromConsoleCache(pts); if (cc) r = { miles: cc.miles, minutes: cc.minutes, geo: asLine(cc.geo), alts: (cc.alts || []).slice(0, 2), src: 'road' }; }
      if (!r && !opts.noNet && isOnline() && consoleNetSafe() && typeof window.routeFor === 'function') {
        MAPSCALL = true; var op; try { op = window.routeFor(pts); } finally { MAPSCALL = false; }
        var o = await race(op, 7000);
        if (o && isFinite(o.miles) && o.geo) r = { miles: o.miles, minutes: o.minutes, geo: asLine(o.geo), alts: [], src: 'road' };
      }
      if (!r) r = straight(pts);
      if (r.straightMiles == null) r.straightMiles = straight(pts).straightMiles;
      RC[k] = { at: Date.now(), r: r };
      return r;
    })();
    INFLIGHT[k] = p;
    p.then(function () { delete INFLIGHT[k]; }, function () { delete INFLIGHT[k]; });
    return p;
  }

  /* ======================================================================
     (a) Route card
     ====================================================================== */
  var CUR = null;           // {key, addrKey, seq[], points[], route, chosen, at}
  var cardTimer = 0, cardSeq = 0, cardMap = null, cardObjs = [];
  function stopsNow() { try { if (typeof dispatchStops !== 'undefined' && Array.isArray(dispatchStops)) return dispatchStops.map(function (s) { return String((s && s.addr) || '').trim(); }).filter(Boolean); } catch (e) {} return []; }
  function formSeq() {
    var pu = String((byId('d_puAddr') || {}).value || '').trim(), doo = String((byId('d_doAddr') || {}).value || '').trim();
    var seq = []; if (pu) seq.push({ a: pu, role: 'pu' });
    stopsNow().forEach(function (s) { seq.push({ a: s, role: 'stop' }); });
    if (doo) seq.push({ a: doo, role: 'do' });
    return { pu: pu, doo: doo, seq: seq };
  }
  function addrKey(pu, stops, doo) { return [up(pu), (stops || []).map(up).join('|'), up(doo)].join('#'); }
  function routeList(c) { if (!c || !c.route) return []; var r = c.route; var main = { miles: r.miles, minutes: r.minutes, geo: r.geo }; return [main].concat((r.alts || []).filter(function (a) { return a && a.geo; })); }
  function chosenRoute(c) { var l = routeList(c); return l[Math.min(c && c.chosen || 0, Math.max(0, l.length - 1))] || null; }
  function currentRoute() {
    if (!CUR || !CUR.route) return null;
    var ch = chosenRoute(CUR);
    return {
      key: CUR.addrKey, points: CUR.points.map(function (p) { return { lat: p.lat, lng: p.lng, role: p.role, addr: p.a }; }),
      miles: ch ? ch.miles : CUR.route.miles, minutes: ch ? ch.minutes : CUR.route.minutes,
      geo: ch && ch.geo ? ch.geo : null, alts: routeList(CUR).slice(1), chosen: CUR.chosen || 0, source: CUR.route.src, complete: CUR.complete
    };
  }
  /* tolls.js asks with its form trip {puAddr, stops[], doAddr}; a saved trip being edited answers with its own routeGeo */
  function routeGeo(f) {
    try {
      f = f || {};
      var k = addrKey(f.puAddr, (f.stops || []).map(function (s) { return s && typeof s === 'object' ? s.addr : s; }), f.doAddr);
      if (CUR && CUR.route && CUR.complete && CUR.addrKey === k) { var ch = chosenRoute(CUR); if (ch && ch.geo) return ch.geo; }
      var eid = null; try { eid = (typeof editingId !== 'undefined' && editingId) ? editingId : null; } catch (e) { eid = null; }
      var t = eid ? findTrip(eid) : null;
      if (t && Array.isArray(t.routeGeo) && t.routeGeo.length > 1 && addrKey(t.puAddr, (t.stops || []).map(function (s) { return s && s.addr; }), t.doAddr) === k) return { type: 'LineString', coordinates: t.routeGeo };
    } catch (e) {}
    return null;
  }
  function googleDirUrl(addrs) {
    addrs = (addrs || []).map(function (a) { return String(a || '').trim(); }).filter(Boolean);
    if (addrs.length < 2) return '';
    var e = encodeURIComponent, mid = addrs.slice(1, -1);
    return 'https://maps.google.com/maps/dir/?api=1&origin=' + e(addrs[0]) + '&destination=' + e(addrs[addrs.length - 1]) + (mid.length ? '&waypoints=' + e(mid.join('|')) : '') + '&travelmode=driving';
  }
  function previewBody() { var m = byId('mapDisp'); return m ? m.parentNode : null; }
  function ensureCard() {
    if (POPOUT && !ENTRY) return null;
    var body = previewBody(); if (!body) return null;
    var c = byId('mapsCard');
    if (!opt('routeCard')) { if (c) c.remove(); body.classList.remove('maps-own'); return null; }
    if (c && c.parentNode === body) return c;
    if (c) c.remove();
    c = document.createElement('div'); c.id = 'mapsCard'; c.className = 'maps-card';
    c.innerHTML = '<div class="maps-card-head"><b>Route</b> ' + chipHtml() + '</div>'
      + '<div class="maps-view" id="mapsRouteView" hidden></div>'
      + '<div class="maps-alts" id="mapsRouteAlts"></div>'
      + '<div class="maps-facts" id="mapsRouteFacts" aria-live="polite"><span class="hint">Enter a pick-up and a drop-off to see the route.</span></div>'
      + '<div class="maps-links"><a id="mapsGLink" class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="#" hidden>Open in Google Maps</a> <button type="button" class="btn btn-ghost btn-sm" id="mapsShare" hidden>Share route</button></div>';
    body.appendChild(c);
    byId('mapsShare').addEventListener('click', act(shareRoute));
    byId('mapsRouteAlts').addEventListener('click', act(function (e) {
      var b = e.target.closest ? e.target.closest('[data-alt]') : null; if (!b || !CUR) return;
      CUR.chosen = Number(b.getAttribute('data-alt')) || 0;
      drawCard(); renderFacts();
      try { if (window.Tolls && typeof window.Tolls.refreshForm === 'function') window.Tolls.refreshForm(); } catch (e2) {}
      try { if (fareIsDistance() && typeof window.calcFare === 'function') window.calcFare(true); } catch (e3) {}   // a distance fare follows the new miles
    }));
    cardMap = null; cardObjs = [];
    return c;
  }
  function scheduleCard(ms) { if (POPOUT && !ENTRY) return; clearTimeout(cardTimer); cardTimer = setTimeout(act(updateCard), ms == null ? 200 : ms); }
  async function updateCard() {
    var card = ensureCard(); if (!card) return;
    hookTolls();
    var f = formSeq(), seq = f.seq;
    var ak = addrKey(f.pu, stopsNow(), f.doo);
    var located = [];
    seq.forEach(function (x) { var c = coordsFor(x.a); if (c) located.push({ a: x.a, role: x.role, lat: Number(c.lat), lng: Number(c.lng) }); });
    var complete = !!(f.pu && f.doo) && located.length === seq.length;
    var key = ak + '@' + ptsKey(located);
    if (!f.pu || !f.doo || located.length < 2) {
      CUR = { key: key, addrKey: ak, seq: seq, points: located, route: null, chosen: 0, complete: false };
      drawCard(); renderFacts(); return;
    }
    if (CUR && CUR.key === key && CUR.route && !(CUR.route.src === 'line' && isOnline() && fromConsoleCache(located))) { drawCard(); renderFacts(); return; }
    var mine = ++cardSeq;
    var keepChosen = CUR && CUR.key === key ? CUR.chosen : 0;
    CUR = { key: key, addrKey: ak, seq: seq, points: located, route: straight(located), chosen: 0, complete: complete, pending: true };
    CUR.route.src = 'line';
    drawCard(); renderFacts();
    var r = await routeFor(located);
    if (mine !== cardSeq || !CUR || CUR.key !== key) return;
    CUR.route = r || straight(located); CUR.pending = false; CUR.chosen = Math.min(keepChosen, routeList(CUR).length - 1);
    drawCard(); renderFacts();
    try { if (window.Tolls && typeof window.Tolls.refreshForm === 'function') window.Tolls.refreshForm(); } catch (e) {}
    if (CUR.route.src === 'line' && isOnline() && window.L) { setTimeout(act(function () { if (CUR && CUR.key === key && fromConsoleCache(located)) { delete RC[ptsKey(located)]; scheduleCard(0); } }), 3000); }
  }
  /* which picture the card shows: 'google' (own Google map), 'leaflet' (the console's own preview), 'diagram' (own SVG) */
  function cardVisual() {
    if (googleLoaded() && googleUsable() && isOnline()) return 'google';
    if (isOnline() && window.L && byId('mapDisp')) return 'leaflet';
    return 'diagram';
  }
  function clearCardObjs() { cardObjs.forEach(function (o) { try { o.setMap(null); } catch (e) {} }); cardObjs = []; }
  function drawCard() {
    chipsIfChanged();
    var view = byId('mapsRouteView'), body = previewBody(); if (!view || !body) return;
    var vis = cardVisual(), c = CUR;
    view.setAttribute('data-provider', vis);
    if (vis === 'leaflet') { view.hidden = true; body.classList.remove('maps-own'); clearCardObjs(); return; }
    body.classList.add('maps-own'); view.hidden = false;
    if (vis === 'google') {
      try {
        var G = window.google.maps;
        if (!cardMap || !view.querySelector('.maps-gmap')) {
          view.innerHTML = '<div class="maps-gmap" id="mapsRouteMap"></div>';
          cardMap = new G.Map(byId('mapsRouteMap'), { center: baseCoords(), zoom: 11, mapTypeControl: false, streetViewControl: false, fullscreenControl: true });
        }
        clearCardObjs();
        if (!c || !c.points || !c.points.length) { view.setAttribute('data-lines', '0'); return; }
        var bounds = new G.LatLngBounds(), list = routeList(c), ch = Math.min(c.chosen || 0, Math.max(0, list.length - 1)), lines = 0;
        list.forEach(function (r, i) {
          var path = lineOf(r.geo).map(function (q) { return { lat: q[1], lng: q[0] }; });
          if (path.length < 2) return;
          var main = i === ch;
          var pl = new G.Polyline({ path: path, map: cardMap, strokeColor: main ? '#13315c' : '#7a828f', strokeOpacity: main ? 0.9 : 0.45, strokeWeight: main ? 5 : 4, zIndex: main ? 2 : 1, clickable: true });
          try { if (pl.addListener) pl.addListener('click', function () { if (CUR) { CUR.chosen = i; drawCard(); renderFacts(); try { window.Tolls && window.Tolls.refreshForm && window.Tolls.refreshForm(); } catch (e) {} } }); } catch (e) {}
          cardObjs.push(pl); lines++;
          path.forEach(function (q) { bounds.extend(q); });
        });
        if (!lines && c.points.length > 1) { var sp = c.points.map(function (q) { return { lat: q.lat, lng: q.lng }; }); cardObjs.push(new G.Polyline({ path: sp, map: cardMap, strokeColor: '#13315c', strokeOpacity: 0.4, strokeWeight: 2 })); }
        c.points.forEach(function (p, i) {
          var col = p.role === 'pu' ? '#1b7a43' : p.role === 'do' ? '#a4161a' : '#c9a227';
          var mk = new G.Marker({ position: { lat: p.lat, lng: p.lng }, map: cardMap, title: (p.role === 'pu' ? 'Pick-up: ' : p.role === 'do' ? 'Drop-off: ' : 'Stop: ') + shortA(p.a), label: p.role === 'pu' ? 'A' : p.role === 'do' ? 'B' : String(i), icon: G.SymbolPath ? { path: G.SymbolPath.CIRCLE, scale: 8, fillColor: col, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } : undefined });
          cardObjs.push(mk); bounds.extend({ lat: p.lat, lng: p.lng });
        });
        try { if (!bounds.isEmpty || !bounds.isEmpty()) cardMap.fitBounds(bounds); } catch (e) {}
        view.setAttribute('data-lines', String(lines));
      } catch (e) { log(e); view.setAttribute('data-provider', 'diagram'); view.innerHTML = diagramSvg(c); cardMap = null; }
      return;
    }
    cardMap = null; clearCardObjs();
    view.innerHTML = diagramSvg(c);
  }
  function diagramSvg(c) {
    var seq = c && c.seq ? c.seq : [];
    if (!seq.length) return '<div class="maps-empty">Enter a pick-up, stops and a drop-off to see the run.</div>';
    var pts = (c.points || []), W = 320, H = 190, pad = 24, svg = '';
    if (pts.length >= 2) {
      var lats = pts.map(function (p) { return p.lat; }), lngs = pts.map(function (p) { return p.lng; });
      var ch = chosenRoute(c), line = lineOf(ch && ch.geo);
      line.forEach(function (q) { lats.push(q[1]); lngs.push(q[0]); });
      var a = Math.min.apply(null, lats), b = Math.max.apply(null, lats), x0 = Math.min.apply(null, lngs), x1 = Math.max.apply(null, lngs);
      if (b - a < 1e-4) { b += 5e-4; a -= 5e-4; } if (x1 - x0 < 1e-4) { x1 += 5e-4; x0 -= 5e-4; }
      var X = function (lo) { return pad + (lo - x0) / (x1 - x0) * (W - 2 * pad); }, Y = function (la) { return pad + (b - la) / (b - a) * (H - 2 * pad); };
      var path = line.length > 1 ? line.map(function (q) { return X(q[0]).toFixed(1) + ',' + Y(q[1]).toFixed(1); }) : pts.map(function (p) { return X(p.lng).toFixed(1) + ',' + Y(p.lat).toFixed(1); });
      svg = '<svg class="maps-diagram" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Route diagram"><rect width="' + W + '" height="' + H + '" fill="#eef3f7"/>'
        + '<polyline points="' + path.join(' ') + '" fill="none" stroke="#13315c" stroke-width="3" stroke-opacity=".75"' + (line.length > 1 ? '' : ' stroke-dasharray="6 5"') + '/>'
        + pts.map(function (p) { var col = p.role === 'pu' ? '#1b7a43' : p.role === 'do' ? '#a4161a' : '#c9a227'; return '<circle cx="' + X(p.lng).toFixed(1) + '" cy="' + Y(p.lat).toFixed(1) + '" r="6.5" fill="' + col + '" stroke="#fff" stroke-width="2"/>'; }).join('')
        + '<text x="' + (pad - 8) + '" y="' + (pad - 8) + '" font-size="11" font-weight="700" fill="#5d5d5d">N ↑</text></svg>';
    }
    var rows = seq.map(function (x) { var role = x.role === 'pu' ? 'Pick-up' : x.role === 'do' ? 'Drop-off' : 'Stop'; var has = (c.points || []).some(function (p) { return p.a === x.a; }); return '<div class="maps-rd"><span class="maps-dot maps-' + x.role + '"></span><b>' + role + '</b> ' + esc(x.a) + (has ? '' : ' <span class="maps-miss">(not on the map yet)</span>') + '</div>'; }).join('');
    return svg + '<div class="maps-rdlist">' + rows + '</div>';
  }
  function fmtMin(m) { m = Math.max(1, Math.round(num(m))); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'; }
  function srcLabel(s) { return s === 'google' ? 'Google' : s === 'road' ? 'road route' : s === 'saved' ? 'saved route' : 'straight-line estimate'; }
  function renderFacts() {
    var box = byId('mapsRouteFacts'), alts = byId('mapsRouteAlts'), link = byId('mapsGLink'), share = byId('mapsShare'); if (!box) return;
    var c = CUR, f = formSeq();
    var addrs = f.seq.map(function (x) { return x.a; });
    var url = (f.pu && f.doo) ? googleDirUrl(addrs) : '';
    if (link) { link.hidden = !url; link.href = url || '#'; link.setAttribute('aria-label', 'Open this route in Google Maps'); }
    if (share) share.hidden = !url;
    if (!f.pu || !f.doo) { box.innerHTML = '<span class="hint">Enter a pick-up and a drop-off to see the route.</span>'; if (alts) alts.innerHTML = ''; return; }
    if (!c || !c.route) {
      var miss = f.seq.filter(function (x) { return !coordsFor(x.a); }).length;
      box.innerHTML = '<span class="hint">' + (miss ? miss + ' address' + (miss > 1 ? 'es are' : ' is') + ' not on the map yet. Pick from the list or check the spelling.' : 'Working out the route…') + '</span>';
      if (alts) alts.innerHTML = ''; return;
    }
    var list = routeList(c), ch = Math.min(c.chosen || 0, Math.max(0, list.length - 1)), r = list[ch] || c.route;
    var fAlt = (alts && document.activeElement && alts.contains(document.activeElement)) ? document.activeElement.getAttribute('data-alt') : null;
    if (alts) alts.innerHTML = list.length > 1 ? list.map(function (x, i) { return '<button type="button" class="maps-alt' + (i === ch ? ' on' : '') + '" data-alt="' + i + '" aria-pressed="' + (i === ch) + '">' + (i === 0 ? 'Fastest' : 'Other way ' + i) + ' · ' + num(x.miles).toFixed(1) + ' mi · ' + fmtMin(x.minutes) + '</button>'; }).join('') : '';
    if (fAlt != null && alts) { var fb = alts.querySelector('[data-alt="' + fAlt + '"]') || alts.querySelector('[data-alt]'); if (fb) fb.focus(); }
    var h = '<div class="maps-fact"><b>' + num(r.miles).toFixed(1) + ' mi</b> · <b>' + fmtMin(r.minutes) + '</b> drive <span class="maps-src">(' + esc(srcLabel(c.route.src)) + (c.pending ? ', checking the road…' : '') + ')</span></div>';
    if (c.route.src === 'line' && c.route.straightMiles != null) h += '<div class="maps-fact hint">' + num(c.route.straightMiles).toFixed(1) + ' mi straight-line.</div>';
    if (!c.complete) h += '<div class="maps-fact maps-warn">Some stops are not on the map yet: numbers cover only the located ones.</div>';
    var lb = leaveBy(r.minutes); if (lb) h += '<div class="maps-fact" id="mapsLeaveBy">' + lb + '</div>';
    var cx = crossingsText(); if (cx) h += '<div class="maps-fact" id="mapsCross">' + cx + '</div>';
    box.innerHTML = h;
  }
  function crossingsText() {
    try {
      var T = window.Tolls; if (!T || typeof T.form !== 'function') return '';
      var fm = T.form(), res = fm && fm.res; if (!res) return '';
      var paid = (res.tolls || []).map(function (x) { return x.short || x.label; }), free = res.free || [];
      var how = ' <span class="maps-src">(' + (res.confidence === 'route' ? 'from the route' : 'usual way') + ')</span>';
      if (!paid.length && !free.length) return 'Crossings: none with a toll' + how;
      return 'Crossings: ' + esc(paid.concat(free.map(function (x) { return /\(free\)\s*$/.test(x) ? x : x + ' (free)'; })).join(', ')) + how;
    } catch (e) { return ''; }
  }
  function baseCoords() {
    var s = settings(), cands = [], bk = null;
    try { (STATE.addrbook || []).some(function (x) { if (x && x.label === 'Base' && okPt(x)) { bk = pt(x); return true; } return false; }); } catch (e) {}
    if (bk) return bk;
    if (s.addr) { cands.push(s.addr + ', ' + (s.city || '')); cands.push(s.addr); }
    for (var i = 0; i < cands.length; i++) { var c = coordsFor(cands[i]); if (c) return pt(c); }
    return { lat: 40.7233, lng: -73.8043 };
  }
  function driverPos(d) {
    if (!d || !d.curLoc || typeof d.curLoc !== 'object') return null;
    var L = d.curLoc;
    if (okPt(L)) return pt(L);
    var c = coordsFor(L.addr); return c ? pt(c) : null;
  }
  function formPickupDate() {
    var sched = true; try { if (typeof whenMode !== 'undefined') sched = whenMode === 'sched'; } catch (e) {}
    if (!sched) return null;
    var d = (byId('d_date') || {}).value, t = (byId('d_time') || {}).value;
    if (!d || !t) return null;
    var x = new Date(d + 'T' + (t.length >= 4 ? t : '12:00')); return isNaN(x) ? null : x;
  }
  function leaveBy() {
    var when = formPickupDate(); if (!when || when.getTime() < Date.now() + 5 * 60000) return '';
    var c = CUR; if (!c || !c.points || !c.points.length || c.points[0].role !== 'pu') return '';
    var puP = c.points[0], did = String((byId('d_driver') || {}).value || ''), d = did ? findDriver(did) : null, from = driverPos(d), who;
    if (from) who = 'from ' + esc(d.name || 'the driver') + '\'s spot'; else { from = baseCoords(); who = 'from the base'; }
    var m = etaBetween(from, puP, 'form|' + (did || 'base'));
    var at = new Date(when.getTime() - m.minutes * 60000);
    return 'Leave by <b>' + esc(hm(at)) + '</b> (' + fmtMin(m.minutes) + ' ' + who + ', ' + (m.src === 'google' ? 'Google' : 'straight line at 18 mph') + ')';
  }
  async function shareRoute() {
    var link = byId('mapsGLink'); var url = link && !link.hidden ? link.href : ''; if (!url) { toast('Enter a pick-up and a drop-off first.', true); return; }
    var ok = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await race(navigator.clipboard.writeText(url).then(function () { ok = true; }), 1500); } } catch (e) { ok = false; }
    if (!ok) { try { var ta = document.createElement('textarea'); ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.left = '-9999px'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (e) { ok = false; } }
    window.__mapsLastShared = url;
    toast(ok ? 'Route link copied. Paste it in a text or email.' : 'Could not copy. Use Open in Google Maps and copy the address bar.', !ok);
    try { byId('mapsShare').focus(); } catch (e) {}
  }

  /* ---------- trips[].routeGeo on save ---------- */
  var saveCtx = null;
  function dSaveBefore() {
    saveCtx = null;
    var eid = null; try { eid = (typeof editingId !== 'undefined' && editingId) ? editingId : null; } catch (e) { eid = null; }
    var f = formSeq(), cr = currentRoute();
    saveCtx = { editId: eid, seq: Number(STATE.dispatchSeq), ak: addrKey(f.pu, stopsNow(), f.doo), geo: cr && cr.complete && cr.geo && cr.key === addrKey(f.pu, stopsNow(), f.doo) ? compact(cr.geo) : null };
  }
  function dSaveAfter() {
    var ctx = saveCtx; saveCtx = null; if (!ctx) return;
    var t = null;
    if (ctx.editId) t = findTrip(ctx.editId);
    else { if (Number(STATE.dispatchSeq) !== ctx.seq + 1) return; t = trips().filter(function (x) { return x && Number(x.dispatchNo) === ctx.seq; })[0]; }
    if (!t) return;
    var tk = addrKey(t.puAddr, (t.stops || []).map(function (s) { return s && s.addr; }), t.doAddr);
    if (ctx.geo && tk === ctx.ak) { t.routeGeo = ctx.geo; save(); }
    else if (t.routeGeo && tk !== ctx.ak) { delete t.routeGeo; save(); }
  }

  /* ======================================================================
     (d) Address chips
     ====================================================================== */
  function addrConfidence(v) {
    v = String(v || '').trim(); if (!v) return { k: '', label: '' };
    var ap = airportOf(v); if (ap) return { k: 'air', label: '✈ ' + ap, why: 'Airport: flat rate and the airport fee apply.' };
    var c = coordsFor(v);
    if (c && !c.approx) return { k: 'ok', label: '✓ found', why: 'Found on the map.' };
    if (c && c.approx) return { k: 'unk', label: '? rough', why: 'Only placed roughly (same street or neighbourhood). Check it.' };
    return { k: 'unk', label: '? not found', why: 'Not found on the map. Check the spelling or pick a suggestion.' };
  }
  var chipBusy = {};
  function chipHost(inp) { var w = inp.closest ? inp.closest('.ac-wrap') : null; return w || inp.parentNode; }
  function chipFor(inp, pending) {
    if (!inp || !inp.isConnected) return;
    var host = chipHost(inp); if (!host) return;
    var id = inp.id || ('stop' + inp.getAttribute('data-stop'));
    var chip = host.querySelector(':scope > .maps-achip');
    var v = String(inp.value || '').trim();
    var res = pending ? { k: 'wait', label: '…', why: 'Looking up the address.' } : addrConfidence(v);
    if (!res.k) { if (chip) chip.remove(); clearSugg(host); return; }
    if (!chip) { chip = document.createElement('button'); chip.type = 'button'; chip.className = 'maps-achip'; chip.tabIndex = -1; host.appendChild(chip); chip.addEventListener('click', act(function () { if (chip.getAttribute('data-k') === 'unk') showSugg(inp, true); })); }
    chip.setAttribute('data-k', res.k); chip.setAttribute('data-for', id); chip.textContent = res.label; chip.title = res.why || ''; chip.setAttribute('aria-label', res.why || res.label);
    if (res.k === 'unk') showSugg(inp, false); else clearSugg(host);
  }
  function clearSugg(host) { var s = host && host.parentNode ? host.parentNode.querySelector(':scope > .maps-sugg') : null; if (s) s.remove(); }
  function streetPart(v) { var s = shortA(v).replace(/^\s*\d+[A-Z]?(?:-\d+)?\s+/i, '').trim(); return s.length >= 3 ? s : shortA(v); }
  async function suggestionsFor(v) {
    var out = [], seen = {};
    function add(list) { (list || []).forEach(function (it) { if (!it || !it.address || out.length >= 3) return; var k = up(it.address); if (seen[k] || k === up(v)) return; seen[k] = 1; out.push(it); }); }
    try { if (typeof window.localSuggest === 'function') { add(window.localSuggest(v)); if (out.length < 3) add(window.localSuggest(streetPart(v))); } } catch (e) {}
    if (out.length < 3 && isOnline() && consoleNetSafe() && typeof window.suggestAddresses === 'function') {
      try { var r = await race(window.suggestAddresses(v), 5000); add(r && r.items); } catch (e) {}
    }
    return out.slice(0, 3);
  }
  var SUGP = {};   // input key -> address being looked up, so one slow lookup gives one box
  async function showSugg(inp, focus) {
    var host = chipHost(inp); if (!host || !host.parentNode) return;
    var v = String(inp.value || '').trim(), box = host.parentNode.querySelector(':scope > .maps-sugg');
    if (box && box.getAttribute('data-q') === v) { if (focus) { var b0 = box.querySelector('button'); if (b0) b0.focus(); } return; }
    var sk = inp.id || ('stop' + inp.getAttribute('data-stop'));
    if (SUGP[sk] === v) { if (focus) SUGP[sk + '#f'] = true; return; }
    SUGP[sk] = v;
    var list;
    try { list = await suggestionsFor(v); } finally { if (SUGP[sk] === v) delete SUGP[sk]; }
    if (SUGP[sk + '#f']) { focus = true; delete SUGP[sk + '#f']; }
    if (!inp.isConnected) return;
    if (String(inp.value || '').trim() !== v) return;
    if (addrConfidence(v).k !== 'unk') return;
    host = chipHost(inp); if (!host || !host.parentNode) return;
    var all = host.parentNode.querySelectorAll(':scope > .maps-sugg');
    for (var bi = 1; bi < all.length; bi++) all[bi].remove();
    box = all[0] || null;
    if (box && box.getAttribute('data-q') === v) { if (focus) { var b2 = box.querySelector('button'); if (b2) b2.focus(); } return; }
    if (!box) { box = document.createElement('div'); box.className = 'maps-sugg'; box.setAttribute('role', 'listbox'); host.parentNode.insertBefore(box, host.nextSibling); }
    box.setAttribute('data-q', v);
    box.innerHTML = list.length ? '<span class="maps-sugg-h">Did you mean:</span>' + list.map(function (it, i) { return '<button type="button" role="option" class="maps-sugg-i" data-i="' + i + '">' + esc(it.address) + '</button>'; }).join('') + '<button type="button" class="maps-sugg-x" aria-label="Close suggestions">×</button>'
      : '<span class="maps-sugg-h">No close match in the address book. Type the full address with the town.</span><button type="button" class="maps-sugg-x" aria-label="Close">×</button>';
    box.onclick = act(function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if (b.classList.contains('maps-sugg-x')) { box.remove(); inp.focus(); return; }
      pickSugg(inp, list[Number(b.getAttribute('data-i'))]); box.remove();
    });
    box.onkeydown = function (e) { if (e.key === 'Escape') { e.preventDefault(); box.remove(); inp.focus(); } };
    if (focus) { var b1 = box.querySelector('button'); if (b1) b1.focus(); }
  }
  function pickSugg(inp, it) {
    if (!it) return;
    inp.value = it.address;
    try { if (it.lat != null && it.lng != null && typeof window.normalizeAddr === 'function') STATE.geocache[window.normalizeAddr(it.address)] = { lat: Number(it.lat), lng: Number(it.lng) }; } catch (e) {}
    try { if (typeof window.rememberAddr === 'function') window.rememberAddr(it.address, it.lat, it.lng); } catch (e) {}
    var si = inp.getAttribute('data-stop');
    try { if (si != null && typeof dispatchStops !== 'undefined' && dispatchStops[+si]) dispatchStops[+si].addr = it.address; } catch (e) {}
    save();
    try { inp.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    try { if (typeof window.maybeAutoFare === 'function') window.maybeAutoFare(); } catch (e) {}
    try { if (typeof window.updateDispMap === 'function') window.updateDispMap(); } catch (e) {}
    chipFor(inp); inp.focus();
    /* the console may re-render the stop rows: put the chip and focus on the live box */
    setTimeout(act(function () { var el = inp.isConnected ? inp : (si != null ? document.querySelector('#d_stops input[data-stop="' + si + '"]') : null); if (el) { chipFor(el); el.focus(); } }), 0);
  }
  function formInputs() {
    var l = []; ['d_puAddr', 'd_doAddr'].forEach(function (id) { var el = byId(id); if (el) l.push(el); });
    var st = byId('d_stops'); if (st) st.querySelectorAll('input[data-stop]').forEach(function (el) { l.push(el); });
    return l;
  }
  function refreshAddrChips() { if (POPOUT) return; formInputs().forEach(function (el) { if (!chipBusy[el.id || el.getAttribute('data-stop')]) chipFor(el); }); }
  async function checkInput(inp) {
    var v = String(inp.value || '').trim(), key = inp.id || ('s' + inp.getAttribute('data-stop'));
    if (!v) { chipFor(inp); return; }
    if (airportOf(v) || coordsFor(v) || !isOnline() || typeof window.geocode !== 'function' || !consoleNetSafe()) { chipFor(inp); return; }
    chipBusy[key] = true; chipFor(inp, true);
    try { await race(window.geocode(v), 8000); } catch (e) {}
    chipBusy[key] = false;
    if (String(inp.value || '').trim() === v) chipFor(inp);
  }
  function hookInputs() {
    if (POPOUT) return;
    formInputs().forEach(function (el) {
      if (el.__mapsChip) return; el.__mapsChip = true;
      el.addEventListener('blur', act(function () { setTimeout(act(function () { checkInput(el); }), 260); }));
      el.addEventListener('input', act(function () { var host = chipHost(el), c = host && host.querySelector(':scope > .maps-achip'); if (c) c.remove(); clearSugg(host); }));
      el.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var host = chipHost(el); var s = host && host.parentNode && host.parentNode.querySelector(':scope > .maps-sugg'); if (s) s.remove(); } });
    });
  }
  /* one geocode per address at a time: the console's blur handler and the chip share the same answer */
  /* The fare follows the chosen way: while the console's calcFare prices the form, its route question for the
     form's own points is answered with the route the dispatcher picked on the card (fare still set by the console
     and checked by quote.js). Rate-book / set prices do not depend on the route and stay as they are. */
  var FARE_ALT = 0, MAPSCALL = false;
  function samePts(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) { if (!okPt(a[i]) || !okPt(b[i])) return false; if (Math.abs(a[i].lat - b[i].lat) > 0.0005 || Math.abs(a[i].lng - b[i].lng) > 0.0005) return false; }
    return true;
  }
  function wrapFareRoute() {
    wrapOn(window, 'calcFare', function (orig) {
      return function () {
        FARE_ALT++; var out;
        var done = function () { FARE_ALT = Math.max(0, FARE_ALT - 1); };
        try { out = orig.apply(this, arguments); } catch (e) { done(); throw e; }
        if (out && typeof out.then === 'function') out.then(done, done); else done();
        return out;
      };
    });
    wrapOn(window, 'routeFor', function (orig) {
      return function (points) {
        try {
          if (FARE_ALT && !MAPSCALL && CUR && CUR.route && CUR.complete && (CUR.chosen || 0) > 0 && samePts(points, CUR.points)) {
            var ch = chosenRoute(CUR);
            if (ch && isFinite(ch.miles) && isFinite(ch.minutes)) return Promise.resolve({ miles: ch.miles, minutes: ch.minutes, geo: ch.geo, alts: [] });
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    });
  }
  function fareIsDistance() {
    var f = byId('d_fare'), ms = byId('d_meterStatus');
    return !!(f && f.dataset && f.dataset.auto && Number(f.value) > 0 && ms && /^Distance reference/.test(String(ms.textContent || '')));
  }
  function wrapGeocode() {
    var GF = {};
    wrapOn(window, 'geocode', function (orig) {
      return function (addr) {
        var k = up(addr); if (!k) return orig.apply(this, arguments);
        if (GF[k]) return GF[k];
        var p = Promise.resolve(orig.apply(this, arguments));
        GF[k] = p; var done = function () { delete GF[k]; }; p.then(done, done);
        return p;
      };
    });
  }

  /* ======================================================================
     (c) ETA on the board + late warnings
     ====================================================================== */
  var ETAC = {}, LATE = [];
  var STALE_MIN = 30;   // a pin older than this gives no ETA and no late warning
  var NEAR = {};        // tripId -> true once the driver was seen within 0.3 mi of the pick-up (memory only)
  var WASLATE = {};     // tripId -> {d: driverId, min: closest miles seen} once the driver is known to be still on the way
  /* When the driver was sent (date + dispTime), or null. ASAP rides keep the booking minute as their pickup time,
     so the send time is the real start of the run to the door. */
  function dispMs(t) {
    try {
      if (!t || !t.date || !t.dispTime) return null;
      var p = String(t.date).split('-').map(Number), q = String(t.dispTime).split(':');
      var d = new Date(p[0], p[1] - 1, p[2], +q[0] || 0, +q[1] || 0, 0); if (isNaN(d)) return null;
      /* dispTime has no date: a send time well after the pickup (sent 23:55 for 00:05) was the evening before */
      var ms = d.getTime(), tq = String(t.time || '').split(':'), pk = new Date(p[0], p[1] - 1, p[2], +tq[0] || 0, +tq[1] || 0, 0).getTime();
      if (isFinite(pk) && ms - pk > 3600000) ms -= 86400000;
      if (ms > Date.now() + 5 * 60000) ms -= 86400000;   // a send time cannot be in the future: it was yesterday
      return ms;
    } catch (e) { return null; }
  }
  function createdMs(t) { var c = t && t.createdAt ? Date.parse(t.createdAt) : NaN; return isFinite(c) ? c : null; }
  function puMiles(t, d) { var a = driverPos(d), b = coordsFor(t && t.puAddr); return a && b ? hav(a, pt(b)) : null; }
  /* True when the driver's pin is too far from the pick-up to have been there since the job could start:
     not before 10 min ahead of the pickup time, not before the job was booked or sent. Works after a reload. */
  function provablyOnTheWay(t, d, pk) {
    var mi = puMiles(t, d), age = ageMin(d); if (mi == null || age == null || age > STALE_MIN) return false;
    var from = pk - 10 * 60000, dm = dispMs(t), cm = createdMs(t);
    if (dm != null) from = Math.max(from, dm);
    if (cm != null) from = Math.max(from, cm);
    var pinAt = Date.now() - age * 60000, el = Math.max(0, (pinAt - from) / 60000);
    return mi > 0.3 + el * 40 / 60;   // 40 mph is a generous city top speed
  }
  function pruneEtac(now) {
    var ks = Object.keys(ETAC); if (ks.length <= 200) return;
    ks.forEach(function (k) { if (!ETAC[k] || now - (ETAC[k].used || 0) > 600000) delete ETAC[k]; });
  }
  /* The cache and the Google throttle are keyed on the pair (driver|trip) only, never on the driver's exact spot:
     a moving car must not cost one Directions call per GPS ping. Between calls, Google's answer is scaled by how
     much nearer or farther the driver is now. */
  function etaBetween(from, to, pairKey) {
    var mi = hav(from, to), sl = { minutes: mi / 18 * 60, miles: mi, src: 'line' }, now = Date.now();
    var c = ETAC[pairKey];
    if (c && c.to && hav(c.to, to) > 0.05) { c.g = null; c.last = 0; }   // a different pick-up: a new question
    var gOk = googleLoaded() && googleUsable() && isOnline() && typeof window.gRoute === 'function';
    if (gOk) {
      if (!c) { c = ETAC[pairKey] = { last: 0, g: null }; pruneEtac(now); }
      c.to = { lat: to.lat, lng: to.lng }; c.used = now;
      var due = !c.g || now - c.g.at >= 60000;
      if (due && now - c.last >= 30000) {
        c.last = now;
        var f = { lat: from.lat, lng: from.lng }, tt = c.to, me = c;
        race(window.gRoute([f, tt], false), 6000).then(function (r) { if (r && isFinite(r.minutes) && ETAC[pairKey] === me) { me.g = { minutes: r.minutes, miles: r.miles, src: 'google', at: Date.now(), from: f }; scheduleEtaPaint(); } }, function () {});
      }
    }
    if (c && c.g && (now - c.g.at < 60000 || (gOk && now - c.g.at < 300000))) {
      var gm = c.g.from ? hav(c.g.from, to) : mi;
      if (gm <= 0.05) return mi <= 0.05 ? { minutes: c.g.minutes, miles: c.g.miles, src: 'google', at: c.g.at } : sl;
      var k = mi / gm; if (k > 3) return sl;
      return { minutes: c.g.minutes * k, miles: num(c.g.miles) * k, src: 'google', at: c.g.at };
    }
    return sl;
  }
  function driverStage(t, d) {
    var s = String((t && t.stage) || '');
    try { if (!s && d && d.curLoc && d.curLoc.tripId === t.id && d.curLoc.stage) s = String(d.curLoc.stage); } catch (e) {}
    return s.toLowerCase();
  }
  function eta(driverId, tripId) {
    var t = findTrip(tripId), d = findDriver(driverId); if (!t || !d) return null;
    var from = driverPos(d), to = coordsFor(t.puAddr); if (!from || !to) return null;
    var now = Date.now(), pk = pickupMs(t), age = ageMin(d), stale = age == null || age > STALE_MIN;
    if (stale) return { minutes: null, miles: hav(from, pt(to)), source: 'stale', arriveAt: null, pickupAt: pk ? new Date(pk).toISOString() : null, lateBy: null, seenAgo: age, stale: true };
    var m = etaBetween(from, pt(to), d.id + '|' + t.id);
    var arrive = now + m.minutes * 60000;
    return { minutes: Math.max(1, Math.round(m.minutes)), miles: m.miles, source: m.src, arriveAt: new Date(arrive).toISOString(), pickupAt: pk ? new Date(pk).toISOString() : null, lateBy: pk ? Math.round((arrive - pk) / 60000) : null, seenAgo: age, stale: false };
  }
  /* 'pre': before pickup time, ETA counts. 'late': past pickup time but it was already late before then and the
     driver has not reached the door yet. '' : no ETA (no driver, at the door, or likely riding with the passenger:
     this console keeps a trip Dispatched until Completed, so past pickup time the driver's spot says nothing
     about the pick-up). */
  function etaPhase(t) {
    if (!t || t.status !== 'Dispatched' || !t.driverId) return '';
    var d = findDriver(t.driverId);
    if (/^(arrived|atpickup|onscene|pob|onboard|done|dropped)$/.test(driverStage(t, d))) return '';
    if (NEAR[t.id] === t.driverId) return '';
    var pk = pickupMs(t), now = Date.now();
    if (!pk || now <= pk) return 'pre';
    var dm = dispMs(t);
    if (now > Math.max(pk + 30 * 60000, dm != null ? dm + 60 * 60000 : 0)) return '';
    var w = WASLATE[t.id]; if (w && w.d !== t.driverId) { delete WASLATE[t.id]; w = null; }
    var mi = puMiles(t, d);
    if (provablyOnTheWay(t, d, pk)) {   // ASAP rides, late sends, and after a reload
      if (!w) w = WASLATE[t.id] = { d: t.driverId, min: mi };
      else w.min = Math.min(w.min, mi);
      return 'late';
    }
    if (!w) return '';
    if (mi != null) {
      if (mi > w.min + 1.5) { delete WASLATE[t.id]; return ''; }   // moving away from the door: likely picked up unseen
      w.min = Math.min(w.min, mi);
    }
    return 'late';
  }
  function etaApplies(t) { return !!etaPhase(t); }
  function noteNear(t, e) {
    if (e && !e.stale && e.miles < 0.3) NEAR[t.id] = t.driverId;
  }
  function computeLate() {
    var out = [], lim = lateMin(), now = Date.now();
    trips().forEach(function (t) {
      if (!t || t.status !== 'Dispatched' || !t.driverId) return;
      if (NEAR[t.id] && NEAR[t.id] !== t.driverId) delete NEAR[t.id];
      if (WASLATE[t.id] && WASLATE[t.id].d !== t.driverId) delete WASLATE[t.id];
      var ph = etaPhase(t); if (!ph) return;
      var e = eta(t.driverId, t.id); if (!e || e.stale || e.lateBy == null) return;
      noteNear(t, e);
      if (e.miles < 0.3) return;   // at the door
      if (e.lateBy > lim) {
        var pk = pickupMs(t); if (pk && now <= pk) { var w0 = WASLATE[t.id]; WASLATE[t.id] = { d: t.driverId, min: w0 && w0.d === t.driverId ? Math.min(w0.min, e.miles) : e.miles }; }
        var d = findDriver(t.driverId); out.push({ tripId: t.id, no: t.dispatchNo, driver: (d && d.name) || 'Driver', lateBy: e.lateBy, eta: e });
      } else if (ph === 'pre') delete WASLATE[t.id];
    });
    LATE = out; return out;
  }
  function tripIdOfRow(tr) {
    var b = tr.querySelector('[onclick*="editTrip("]'); if (!b) return null;
    var m = String(b.getAttribute('onclick') || '').match(/editTrip\('([^']+)'\)/); return m ? m[1] : null;
  }
  var etaPaintT = 0;
  function scheduleEtaPaint() { clearTimeout(etaPaintT); etaPaintT = setTimeout(act(function () { paintEta(); scheduleNY(); }), 120); }
  function paintEta() {
    if (POPOUT) return;
    var on = !!opt('etaOnBoard');
    ['activeBoard', 'resvBoard'].forEach(function (id) {
      var host = byId(id); if (!host) return;
      host.querySelectorAll('tbody tr').forEach(function (tr) {
        var old = tr.querySelector('.maps-eta'); if (old) old.remove();
        if (!on) return;
        var tid = tripIdOfRow(tr), t = tid ? findTrip(tid) : null; if (!t || !etaApplies(t)) return;
        var e = eta(t.driverId, t.id); if (!e) return;
        var cell = (tr.querySelector('select.cellsel[onchange*="assignDriver"]') || {}).parentNode || tr.cells[tr.cells.length - 1]; if (!cell) return;
        var el = document.createElement('div'); el.setAttribute('data-trip', t.id);
        if (e.stale) {
          el.className = 'maps-eta stale';
          el.textContent = 'ETA ? (' + (e.seenAgo == null ? 'pin has no time' : 'pin ' + ageText(e.seenAgo).replace(/ ago$/, '') + ' old') + ')';
          el.title = 'The driver\'s last position is too old to give an ETA. Call the driver.';
          cell.appendChild(el); return;
        }
        noteNear(t, e);
        if (e.miles < 0.3) return;
        var late = e.lateBy != null && e.lateBy > lateMin();
        el.className = 'maps-eta' + (late ? ' late' : '');
        el.textContent = 'ETA ' + e.minutes + ' min' + (late ? ' · ' + e.lateBy + ' late' : '');
        el.title = 'Driver reaches the pick-up about ' + hm(new Date(e.arriveAt)) + ' (' + (e.source === 'google' ? 'Google' : 'straight line at 18 mph') + ')' + (e.seenAgo != null ? '. Pin ' + Math.round(e.seenAgo) + ' min old.' : '.');
        cell.appendChild(el);
      });
    });
  }
  function watchBoards() {
    if (POPOUT || !window.MutationObserver) return;
    ['activeBoard', 'resvBoard'].forEach(function (id) {
      var host = byId(id); if (!host || host.__mapsObs) return; host.__mapsObs = true;
      new MutationObserver(act(function () { paintEta(); computeLate(); scheduleNY(); })).observe(host, { childList: true });
    });
    paintEta();
  }

  /* ---------- Needs-you lines ---------- */
  var nyInjecting = false, nyT = 0;
  function scheduleNY() { if (POPOUT) return; clearTimeout(nyT); nyT = setTimeout(act(injectNY), 60); }
  function nyItems() {
    var out = [];
    LATE.forEach(function (l) {
      out.push('<div class="ny-item maps-ny" data-id="' + esc(l.tripId) + '" data-kind="late"><span class="ny-dot due"></span><span class="ny-txt"><b>' + esc(l.driver) + '</b> is running ' + esc(l.lateBy) + ' min late for #' + esc(l.no) + ' (ETA ' + esc(hm(new Date(l.eta.arriveAt))) + ', pickup ' + esc(l.eta.pickupAt ? hm(new Date(l.eta.pickupAt)) : '?') + ').</span><span class="ny-acts"><button type="button" class="btn btn-sm btn-ghost" data-act="open" data-id="' + esc(l.tripId) + '">Open</button><button type="button" class="btn btn-sm btn-navy" data-maps="drvmap" data-id="' + esc(l.tripId) + '">Driver map</button></span></div>');
    });
    var h = health(), s = status();
    if ((h.fails || 0) >= 2 && h.last === 'fail' && s.mode !== 'google' && gKey()) {
      out.push('<div class="ny-item maps-ny" data-kind="gfail"><span class="ny-dot soon"></span><span class="ny-txt"><b>Google maps did not start</b> ' + h.fails + ' times today. Free maps are in use. Check the key.</span><span class="ny-acts"><button type="button" class="btn btn-sm btn-navy" data-maps="gtest">Test Google</button></span></div>');
    }
    return out;
  }
  function recountNY(host) {
    var head = host.querySelector('.ny-head'); if (!head) return;
    var n = host.querySelectorAll('.ny-item').length, cnt = head.querySelector('.ny-count');
    if (!cnt) { head.innerHTML = '<span class="ny-count">0</span> Needs you'; cnt = head.querySelector('.ny-count'); }
    cnt.textContent = String(n);
    var txt = head.childNodes[head.childNodes.length - 1];
    if (txt && txt.nodeType === 3) txt.textContent = n ? ' Needs you' : ' Nothing needs you right now';
    host.classList.toggle('ny-clear', !n);
  }
  function injectNY() {
    var host = byId('needsYou'); if (!host || nyInjecting || POPOUT) return;
    nyInjecting = true;
    try {
      var had = !!host.querySelector('.maps-ny');
      host.querySelectorAll('.maps-ny').forEach(function (n) { n.remove(); });
      var head = host.querySelector('.ny-head');
      if (!isSimple() || !head) { if (had && head) recountNY(host); return; }
      var items = nyItems();
      if (!items.length) { if (had) recountNY(host); return; }
      var lastOps = host.querySelectorAll('.ops-ny'), anchor = lastOps.length ? lastOps[lastOps.length - 1] : head;
      anchor.insertAdjacentHTML('afterend', items.join(''));
      recountNY(host);
      if (!host.__mapsWired) { host.__mapsWired = true; host.addEventListener('click', onNYClick); }
    } catch (e) { log(e); } finally { nyInjecting = false; }
  }
  function onNYClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-maps]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-maps');
    if (a === 'drvmap') { SEL.trip = b.getAttribute('data-id') || SEL.trip; openDriverMap(); }
    else if (a === 'gtest') { openSettingsMaps(true); }
  }
  function watchNY() {
    var host = byId('needsYou'); if (!host || host.__mapsNYObs || POPOUT || !window.MutationObserver) return;
    host.__mapsNYObs = true;
    new MutationObserver(function () { if (nyInjecting) return; if (!host.querySelector('.maps-ny') && (LATE.length || health().fails >= 2)) injectNY(); }).observe(host, { childList: true });
    injectNY();
  }
  function openDriverMap() {
    try { if (window.Simple && isSimple() && typeof window.Simple.enter === 'function') window.Simple.enter('drivers', 'fleet'); else if (typeof window.goTab === 'function') window.goTab('fleet'); } catch (e) {}
    setTimeout(act(function () { renderDriverPanels(true); var p = byId('mapsDrv_fleet'); if (p && p.scrollIntoView) p.scrollIntoView({ block: 'start' }); var s = byId('mapsDrvSel_fleet'); if (s) s.focus(); }), 60);
  }
  function openSettingsMaps(runTest) {
    try { if (window.Simple && isSimple() && typeof window.Simple.enter === 'function') window.Simple.enter('settings', 'settings'); else if (typeof window.goTab === 'function') window.goTab('settings'); } catch (e) {}
    setTimeout(act(function () { renderPanel(); var p = byId('mapsPanel'); if (p && p.scrollIntoView) p.scrollIntoView({ block: 'start' }); if (runTest) runGtest(); }), 80);
  }

  /* ======================================================================
     (b) Live driver map
     ====================================================================== */
  var SEL = { trip: null };   // null = pick the most urgent open trip; '' = the dispatcher chose none
  var DM = {};   // elId -> {gmap, lmap, objs[], layer}
  function ageMin(d) { var w = d && d.curLoc ? parseWhen(d.curLoc.when) : null; return w == null ? null : Math.max(0, (Date.now() - w) / 60000); }
  function ageClass(m) { return m == null ? 'old' : m < 5 ? 'fresh' : m < 20 ? 'mid' : 'old'; }
  var AGECOL = { fresh: '#1b7a43', mid: '#c98a00', old: '#8a8f98' };
  function onDuty(d) { return !!d && d.active !== false && d.onShift !== false; }
  function carOf(d) {
    if (d.carNo) return 'Car ' + d.carNo;
    try { var vid = d.eligibility && d.eligibility.vehicleId; var v = vid ? (STATE.vehicles || []).filter(function (x) { return x && x.id === vid; })[0] : null; if (v) return v.name || v.plate || ''; } catch (e) {}
    return '';
  }
  function driverJob(d) {
    var j = trips().filter(function (t) { return t && t.driverId === d.id && t.status === 'Dispatched'; })[0];
    if (j) return { busy: true, text: 'On #' + j.dispatchNo };
    var n = trips().filter(function (t) { return t && t.driverId === d.id && t.status === 'Booked'; }).sort(function (a, b) { return (pickupMs(a) || 0) - (pickupMs(b) || 0); })[0];
    return { busy: false, text: n ? 'Free · next #' + n.dispatchNo + (n.time ? ' at ' + n.time : '') : 'Free' };
  }
  function driverRows() {
    return drivers().filter(onDuty).map(function (d) {
      var p = driverPos(d), a = ageMin(d), j = driverJob(d);
      return { id: d.id, name: d.name || 'Driver', car: carOf(d), pos: p, age: a, cls: p ? ageClass(a) : 'none', job: j.text, busy: j.busy, source: d.curLoc && d.curLoc.source === 'gps' ? 'GPS' : (d.curLoc ? 'set by hand' : '') };
    });
  }
  function openTrips() {
    var dead = { Completed: 1, Canceled: 1, 'No-Show': 1, Disregard: 1 };
    return trips().filter(function (t) { return t && !dead[t.status] && (t.status === 'Booked' || t.status === 'Dispatched') && !t._hist; })
      .sort(function (a, b) { var au = a.driverId ? 1 : 0, bu = b.driverId ? 1 : 0; return (au - bu) || ((a.status === 'Dispatched') - (b.status === 'Dispatched')) || ((pickupMs(a) || 0) - (pickupMs(b) || 0)); });
  }
  function cssEsc(v) { v = String(v); try { if (window.CSS && CSS.escape) return CSS.escape(v); } catch (e) {} return v.replace(/["\\\]]/g, '\\$&'); }
  function ageText(m) { if (m == null) return 'no time on the pin'; if (m < 1) return 'just now'; if (m < 60) return Math.round(m) + ' min ago'; return Math.round(m / 60) + ' h ago'; }
  function panelHtml(tag) {
    return '<div class="panel-head">Live driver map ' + chipHtml() + '</div><div class="panel-body">'
      + '<div class="maps-drvbar"><label class="maps-lbl">Trip to fill <select id="mapsDrvSel_' + tag + '" class="maps-drvsel"></select></label>'
      + '<span class="hint">Click a driver on the map or in the list to assign. Pins: <span class="maps-age fresh">● under 5 min</span> <span class="maps-age mid">● under 20 min</span> <span class="maps-age old">● older</span></span></div>'
      + '<div class="maps-drvmap" id="mapsDrvMap_' + tag + '"></div><div class="maps-drvlist" id="mapsDrvList_' + tag + '"></div></div>';
  }
  function ensureDriverPanels() {
    if (POPOUT || !opt('driverMap')) { ['fleet', 'map'].forEach(function (t) { var p = byId('mapsDrv_' + t); if (p && !opt('driverMap')) p.remove(); }); return; }
    [['fleet', 'view-fleet'], ['map', 'view-map']].forEach(function (x) {
      var view = byId(x[1]); if (!view || byId('mapsDrv_' + x[0])) return;
      var p = document.createElement('div'); p.className = 'panel maps-drvpanel'; p.id = 'mapsDrv_' + x[0];
      p.innerHTML = panelHtml(x[0]);
      var first = x[0] === 'map' ? (view.querySelector('.panel') || view.firstChild) : view.firstChild;
      view.insertBefore(p, first ? (x[0] === 'map' ? first.nextSibling : first) : null);
      var sel = byId('mapsDrvSel_' + x[0]);
      sel.addEventListener('change', act(function () { SEL.trip = sel.value; driverMap('mapsDrvMap_' + x[0]); }));
      p.addEventListener('click', act(function (e) { var b = e.target.closest ? e.target.closest('[data-assign]') : null; if (!b) return; e.preventDefault(); pinClick(b.getAttribute('data-assign')); }));
    });
  }
  function fillTripSel(sel) {
    var list = openTrips();
    /* a trip asked for by name (Maps.selectTrip) stays the target even when it is finished, so a pin click refuses it
       instead of quietly giving another trip to the driver */
    if (SEL.trip == null || (SEL.trip && SEL.trip !== SEL.asked && !list.some(function (t) { return t.id === SEL.trip; }))) { var unas = list.filter(function (t) { return !t.driverId; })[0]; SEL.trip = unas ? unas.id : (list[0] ? list[0].id : ''); }
    var h = '<option value="">— none —</option>' + list.map(function (t) { var pk = pickupMs(t); return '<option value="' + esc(t.id) + '"' + (t.id === SEL.trip ? ' selected' : '') + '>#' + esc(t.dispatchNo) + ' ' + esc(pk ? hm(new Date(pk)) : (t.time || 'ASAP')) + ' · ' + esc(shortA(t.puAddr)) + (t.status === 'Dispatched' ? ' (out now)' : t.driverId ? ' (has a driver)' : '') + '</option>'; }).join('');
    if (sel && sel.innerHTML !== h && document.activeElement !== sel) sel.innerHTML = h;
    if (sel && document.activeElement !== sel) sel.value = SEL.trip || '';
  }
  function pinTitle(r) { return r.name + (r.car ? ' · ' + r.car : '') + ' · ' + r.job + ' · ' + (r.pos ? 'pin ' + ageText(r.age) + (r.source ? ' (' + r.source + ')' : '') : 'no position'); }
  function pinClick(driverId) {
    var t = SEL.trip ? findTrip(SEL.trip) : null, d = findDriver(driverId);
    if (!d) return false;
    if (!t) { toast('Pick a trip first (Trip to fill), then click a driver.', true); return false; }
    if (typeof window.assignDriver !== 'function') { toast('Assigning is not available here.', true); return false; }
    /* a finished job (and its pay) never moves to another driver from the map */
    if (/^(Completed|Canceled|Cancelled|No-Show|Disregard)$/i.test(String(t.status || ''))) { toast('#' + t.dispatchNo + ' is ' + t.status + ': it cannot be given to another driver.', true); renderDriverPanels(true); return false; }
    if (t.driverId === d.id) { toast((d.name || 'Driver') + ' already has #' + t.dispatchNo + '.'); return true; }
    if (t.driverId) {
      var cur = findDriver(t.driverId), cn = (cur && cur.name) || 'another driver';
      var q = t.status === 'Dispatched' ? '#' + t.dispatchNo + ' is out now with ' + cn + '. Take it off ' + cn + ' and give it to ' + (d.name || 'this driver') + '?' : '#' + t.dispatchNo + ' already has ' + cn + '. Give it to ' + (d.name || 'this driver') + ' instead?';
      var yes = false; try { yes = window.confirm(q); } catch (e) { yes = false; }
      if (!yes) { toast('No change. #' + t.dispatchNo + ' stays with ' + cn + '.'); return false; }
    }
    window.assignDriver(t.id, d.id);
    var ok = t.driverId === d.id;
    if (ok) { toast((d.name || 'Driver') + ' assigned to #' + t.dispatchNo + '.'); try { if (typeof window.refreshBoard === 'function' && byId('activeBoard')) window.refreshBoard(); } catch (e) {} }
    renderDriverPanels(true);
    return ok;
  }
  function driverMap(elId) {
    var el = byId(elId); if (!el) return null;
    var tag = elId.replace(/^mapsDrvMap_/, '');
    var sel = byId('mapsDrvSel_' + tag); if (sel) fillTripSel(sel);
    var rows = driverRows(), t = SEL.trip ? findTrip(SEL.trip) : null, target = t ? coordsFor(t.puAddr) : null;
    var mode = googleLoaded() && googleUsable() && isOnline() ? 'google' : (isOnline() && window.L ? 'leaflet' : 'diagram');
    el.setAttribute('data-provider', mode);
    var st = DM[elId] || (DM[elId] = { objs: [] });
    if (mode === 'google') drawDrvGoogle(el, st, rows, target, t);
    else if (mode === 'leaflet') drawDrvLeaflet(el, st, rows, target, t);
    else { st.gmap = null; st.lmap = null; el.innerHTML = drvSvg(rows, target, t); el.querySelectorAll('[data-drv]').forEach(function (g) { g.addEventListener('click', act(function () { pinClick(g.getAttribute('data-drv')); })); }); }
    var list = byId('mapsDrvList_' + tag);
    if (list) {
      var fa = document.activeElement, fDrv = (fa && list.contains(fa) && fa.closest) ? (fa.closest('tr[data-drv]') || { getAttribute: function () { return null; } }).getAttribute('data-drv') : null;
      var fIn = !!(fa && list.contains(fa));
      list.innerHTML = rows.length ? '<table class="data maps-drvtbl"><thead><tr><th></th><th>Driver</th><th>Car</th><th>Status</th><th>Pin</th><th>To pick-up</th><th></th></tr></thead><tbody>' + rows.map(function (r) {
        var e = t && r.pos && target ? etaBetween(r.pos, pt(target), r.id + '|' + t.id + '|sel') : null;
        return '<tr data-drv="' + esc(r.id) + '" data-age="' + r.cls + '"><td><span class="maps-age ' + r.cls + '">●</span></td><td>' + esc(r.name) + '</td><td>' + esc(r.car) + '</td><td>' + esc(r.job) + '</td><td>' + esc(r.pos ? ageText(r.age) + (r.source ? ' · ' + r.source : '') : 'no position') + '</td><td>' + (e ? num(e.miles).toFixed(1) + ' mi · ' + fmtMin(e.minutes) : '—') + '</td><td>' + (t ? '<button type="button" class="btn btn-sm ' + (t.driverId === r.id ? 'btn-ghost' : 'btn-navy') + '"' + (t.driverId === r.id ? ' aria-disabled="true" data-assigned="1"' : ' data-assign="' + esc(r.id) + '"') + '>' + (t.driverId === r.id ? 'Assigned' : 'Assign to #' + esc(t.dispatchNo)) + '</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">No drivers on duty. Mark drivers On duty in Fleet.</div>';
      if (fIn) {   /* the list was rebuilt under the dispatcher's focus: put it back on the same row */
        var back = (fDrv && list.querySelector('tr[data-drv="' + cssEsc(fDrv) + '"] button')) || list.querySelector('button') || sel;
        try { if (back) back.focus(); } catch (e) {}
      }
    }
    return { mode: mode, drivers: rows.map(function (r) { return { id: r.id, name: r.name, age: r.age, cls: r.cls, hasPos: !!r.pos, title: pinTitle(r) }; }), trip: t ? t.id : '', target: target ? pt(target) : null };
  }
  function drvBounds(rows, target) {
    var ps = rows.filter(function (r) { return r.pos; }).map(function (r) { return r.pos; }); if (target) ps.push(pt(target));
    if (!ps.length) ps.push(baseCoords());
    return ps;
  }
  function drvSvg(rows, target, t) {
    var W = 520, H = 260, pad = 26, ps = drvBounds(rows, target);
    var lats = ps.map(function (p) { return p.lat; }), lngs = ps.map(function (p) { return p.lng; });
    var a = Math.min.apply(null, lats), b = Math.max.apply(null, lats), x0 = Math.min.apply(null, lngs), x1 = Math.max.apply(null, lngs);
    if (b - a < 0.01) { b += 0.01; a -= 0.01; } if (x1 - x0 < 0.01) { x1 += 0.01; x0 -= 0.01; }
    var X = function (lo) { return pad + (lo - x0) / (x1 - x0) * (W - 2 * pad); }, Y = function (la) { return pad + (b - la) / (b - a) * (H - 2 * pad); };
    var h = '<svg class="maps-drvsvg" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Drivers on duty"><rect width="' + W + '" height="' + H + '" fill="#eef3f7"/>';
    if (target) h += '<g class="maps-target"><circle cx="' + X(target.lng).toFixed(1) + '" cy="' + Y(target.lat).toFixed(1) + '" r="11" fill="none" stroke="#a4161a" stroke-width="3"/><circle cx="' + X(target.lng).toFixed(1) + '" cy="' + Y(target.lat).toFixed(1) + '" r="3" fill="#a4161a"/><text x="' + (X(target.lng) + 14).toFixed(1) + '" y="' + (Y(target.lat) + 4).toFixed(1) + '" font-size="11" fill="#a4161a" font-weight="700">#' + esc(t.dispatchNo) + ' pick-up</text></g>';
    rows.forEach(function (r) {
      if (!r.pos) return;
      var x = X(r.pos.lng).toFixed(1), y = Y(r.pos.lat).toFixed(1);
      h += '<g class="maps-pin" data-drv="' + esc(r.id) + '" data-age="' + r.cls + '" style="cursor:pointer"><title>' + esc(pinTitle(r)) + '</title><circle cx="' + x + '" cy="' + y + '" r="9" fill="' + AGECOL[r.cls] + '" stroke="#fff" stroke-width="2"/><text x="' + x + '" y="' + (Number(y) - 13) + '" text-anchor="middle" font-size="10" fill="#222">' + esc((r.car || r.name).slice(0, 14)) + '</text></g>';
    });
    if (!rows.some(function (r) { return r.pos; })) h += '<text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle" font-size="12" fill="#5d5d5d">No driver has a position yet.</text>';
    return h + '<text x="' + (pad - 8) + '" y="' + (pad - 8) + '" font-size="11" font-weight="700" fill="#5d5d5d">N ↑</text></svg>';
  }
  function drawDrvGoogle(el, st, rows, target, t) {
    var G = window.google.maps;
    if (!st.gmap || !el.querySelector('.maps-gmap')) { el.innerHTML = '<div class="maps-gmap"></div>'; st.gmap = new G.Map(el.firstChild, { center: baseCoords(), zoom: 11, mapTypeControl: false, streetViewControl: false }); st.objs = []; }
    st.objs.forEach(function (o) { try { o.setMap(null); } catch (e) {} }); st.objs = []; st.pins = {};
    var bounds = new G.LatLngBounds(), any = false;
    rows.forEach(function (r) {
      if (!r.pos) return;
      var mk = new G.Marker({ position: r.pos, map: st.gmap, title: pinTitle(r), label: (r.car || r.name).replace(/^Car /, '').slice(0, 4), icon: G.SymbolPath ? { path: G.SymbolPath.CIRCLE, scale: 10, fillColor: AGECOL[r.cls], fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } : undefined });
      mk.addListener('click', act(function () { pinClick(r.id); }));
      st.objs.push(mk); st.pins[r.id] = mk; bounds.extend(r.pos); any = true;
    });
    if (target) { var tm = new G.Marker({ position: pt(target), map: st.gmap, title: '#' + t.dispatchNo + ' pick-up', label: 'P' }); st.objs.push(tm); bounds.extend(pt(target)); any = true; }
    try { if (any) st.gmap.fitBounds(bounds); } catch (e) {}
  }
  function drawDrvLeaflet(el, st, rows, target, t) {
    var L = window.L;
    try {
      if (!st.lmap || !el.querySelector('.maps-lmap')) {
        el.innerHTML = '<div class="maps-lmap"></div>';
        st.lmap = L.map(el.firstChild).setView([baseCoords().lat, baseCoords().lng], 11);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(st.lmap);
        st.layer = L.layerGroup().addTo(st.lmap);
      }
      st.layer.clearLayers();
      var ll = [];
      rows.forEach(function (r) {
        if (!r.pos) return;
        var m = L.circleMarker([r.pos.lat, r.pos.lng], { radius: 9, color: '#fff', weight: 2, fillColor: AGECOL[r.cls], fillOpacity: 1 }).bindTooltip(esc(pinTitle(r))).addTo(st.layer);
        m.on('click', act(function () { pinClick(r.id); })); ll.push([r.pos.lat, r.pos.lng]);
      });
      if (target) { L.circleMarker([target.lat, target.lng], { radius: 11, color: '#a4161a', weight: 3, fill: false }).bindTooltip('#' + esc(t.dispatchNo) + ' pick-up').addTo(st.layer); ll.push([target.lat, target.lng]); }
      setTimeout(function () { try { st.lmap.invalidateSize(); if (ll.length === 1) st.lmap.setView(ll[0], 13); else if (ll.length) st.lmap.fitBounds(ll, { padding: [30, 30] }); } catch (e) {} }, 60);
    } catch (e) { log(e); st.lmap = null; el.setAttribute('data-provider', 'diagram'); el.innerHTML = drvSvg(rows, target, t); el.querySelectorAll('[data-drv]').forEach(function (g) { g.addEventListener('click', act(function () { pinClick(g.getAttribute('data-drv')); })); }); }
  }
  var drvPrint = '';
  function drvFingerprint() {
    return JSON.stringify([SEL.trip, drivers().map(function (d) { return d && [d.id, d.active, d.onShift, d.curLoc && d.curLoc.when, d.curLoc && d.curLoc.lat, d.curLoc && d.curLoc.lng, d.curLoc && d.curLoc.addr]; }), trips().filter(function (t) { return t && (t.status === 'Booked' || t.status === 'Dispatched'); }).map(function (t) { return [t.id, t.status, t.driverId]; }), Math.floor(Date.now() / 60000), status().mode]);
  }
  function renderDriverPanels(force) {
    if (POPOUT) return;
    ensureDriverPanels(); chipsIfChanged();
    var fp = drvFingerprint(); if (!force && fp === drvPrint) return; drvPrint = fp;
    ['fleet', 'map'].forEach(function (tag) { var p = byId('mapsDrv_' + tag); if (p && (force || visible(p))) driverMap('mapsDrvMap_' + tag); });
  }
  var drvT = 0;
  function scheduleDrivers() { clearTimeout(drvT); drvT = setTimeout(act(function () { renderDriverPanels(false); }), 150); }

  /* ======================================================================
     (e) Settings panel + hub chip
     ====================================================================== */
  function renderPanel() {
    if (POPOUT) return;
    var view = byId('view-settings'); if (!view) return;
    var p = byId('mapsPanel');
    if (!p) { p = document.createElement('div'); p.className = 'panel'; p.id = 'mapsPanel'; view.appendChild(p); p.addEventListener('change', act(onPanelChange)); p.addEventListener('click', act(onPanelClick)); }
    var m = MS();
    p.innerHTML = '<div class="panel-head">Maps &amp; live map</div><div class="panel-body">'   /* head text stays fixed: setup.js files panels by it */
      + '<div class="maps-row"><span>Map service now</span> ' + chipHtml() + '</div><p class="hint" id="mapsPanelWhy" style="margin-top:0;"></p>'
      + '<label class="maps-row"><input type="checkbox" data-mk="routeCard"' + (opt('routeCard') ? ' checked' : '') + '> Route card in the Book form (map, distance, leave-by, Google link)</label>'
      + '<label class="maps-row"><input type="checkbox" data-mk="driverMap"' + (opt('driverMap') ? ' checked' : '') + '> Live driver map in Drivers</label>'
      + '<label class="maps-row"><input type="checkbox" data-mk="etaOnBoard"' + (opt('etaOnBoard') ? ' checked' : '') + '> ETA to pick-up on the board</label>'
      + '<label class="maps-row">Warn when a driver will be more than <input type="number" min="1" max="240" step="1" data-mk="lateMin" value="' + esc(lateMin()) + '" style="width:70px;display:inline-block;"> min late</label>'
      + '<label class="maps-row">Map service <select data-mk="provider" style="width:auto;display:inline-block;"><option value="auto"' + (m.provider !== 'free' ? ' selected' : '') + '>Google when the key works, else free maps</option><option value="free"' + (m.provider === 'free' ? ' selected' : '') + '>Free maps (OpenStreetMap) for maps and routes</option></select></label>'
      + '<p class="hint maps-row" style="margin-top:0;">Free maps here stops Google route and ETA lookups everywhere (the route card, driver map, ETAs and the console\'s own fare routes). Address suggestions still use Google while a key is saved. To stop all Google use, clear the key in Google settings.</p>'
      + '<div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-mact="gtest">Test Google now</button><button type="button" class="btn btn-sm btn-ghost" data-mact="doctor">Run the map doctor</button></div>'
      + '<div class="hint" id="mapsGtestOut"></div></div>';
    refreshChips(); fileUnderMaps();
  }
  function onPanelChange(e) {
    var el = e.target, k = el && el.getAttribute('data-mk'); if (!k) return;
    var m = MS();
    if (el.type === 'checkbox') m[k] = !!el.checked;
    else if (k === 'lateMin') { var n = Math.round(Number(el.value)); m.lateMin = isFinite(n) && n >= 1 && n <= 240 ? n : 10; el.value = m.lateMin; }
    else if (k === 'provider') m.provider = el.value === 'free' ? 'free' : 'auto';
    save(); toast('Map setting saved.');
    RC = {}; refreshAll();
  }
  function onPanelClick(e) {
    var b = e.target.closest ? e.target.closest('[data-mact]') : null; if (!b) return;
    var a = b.getAttribute('data-mact');
    if (a === 'gtest') runGtest();
    else if (a === 'doctor') { try { if (typeof window.goTab === 'function') window.goTab('map'); } catch (e2) {} setTimeout(act(function () { if (typeof window.mapDoctor === 'function') window.mapDoctor(); }), 150); }
  }
  function runGtest() {
    var out = byId('mapsGtestOut');
    if (typeof window.testGoogleNow !== 'function') { if (out) out.textContent = 'The Google test is not available in this window.'; return; }
    if (out) out.textContent = 'Testing Google…';
    Promise.resolve(window.testGoogleNow()).then(act(function () { var t = gtestText(); if (out) out.innerHTML = esc(t); onGtestOut(); }), act(function () { onGtestOut(); }));
  }
  function onGtestOut() {
    var t = gtestText();
    if (/✅/.test(t)) recordGoogle(true, 'test'); else if (/❌/.test(t)) recordGoogle(false, 'test'); else refreshChips();
  }
  function fileUnderMaps() {
    var p = byId('mapsPanel'), body = byId('setupSecBody_maps'); if (!p || !body || p.parentNode === body) return;
    var home = p.closest ? p.closest('.setup-sec-body') : null;
    if (!home || home.id === 'setupSecBody_other') {
      p.setAttribute('data-setup-rank', '15'); p.setAttribute('data-setup-sec', 'maps');
      var kids = body.children, before = null;
      for (var i = 0; i < kids.length; i++) { if ((Number(kids[i].getAttribute('data-setup-rank')) || 0) > 15) { before = kids[i]; break; } }
      body.insertBefore(p, before);
      var ob = byId('setupSecBody_other'), os = byId('setupSec_other');
      if (ob && os && !ob.children.length) { os.hidden = true; var oc = document.querySelector('.setup-chip[data-sec="other"]'); if (oc) oc.hidden = true; }
    }
  }
  /* the hub's own "Maps & addresses" card (setup.js) gets the same chip; it rewrites its body, so re-add when missing */
  function setupChip() {
    var b = byId('setupMaps_body'); if (!b) return;
    var c = b.querySelector('.maps-hubchip');
    if (!c) { c = document.createElement('div'); c.className = 'setup-kv maps-hubchip'; c.innerHTML = '<span>Map service now</span>' + chipHtml(); b.insertBefore(c, b.firstChild); }
    var p = byId('setupMaps');
    if (p && !p.__mapsObs && window.MutationObserver) { p.__mapsObs = true; new MutationObserver(function () { var bb = byId('setupMaps_body'); if (bb && !bb.querySelector('.maps-hubchip')) setupChip(); }).observe(p, { childList: true, subtree: true }); }
  }

  /* ======================================================================
     wiring
     ====================================================================== */
  var tollsHooked = false;
  function hookTolls() {
    if (tollsHooked || !window.Tolls || typeof window.Tolls.refreshForm !== 'function') return;
    tollsHooked = wrapOn(window.Tolls, 'refreshForm', function (orig) { return function () { var r = orig.apply(this, arguments); try { if (byId('mapsRouteFacts')) renderFacts(); } catch (e) {} return r; }; }) || !!window.Tolls.refreshForm._mapsWrapped;
  }
  function refreshAll() {
    try { scheduleCard(0); } catch (e) {}
    if (POPOUT) return;
    try { refreshAddrChips(); } catch (e) {}
    try { renderDriverPanels(true); } catch (e) {}
    try { paintEta(); computeLate(); injectNY(); } catch (e) {}
    try { refreshChips(); } catch (e) {}
  }
  function wrapConsole() {
    after('updateDispMap', function () { scheduleCard(150); if (!POPOUT) { hookInputs(); setTimeout(act(refreshAddrChips), 30); } });
    after('clearDispatch', function () { CUR = null; cardSeq++; scheduleCard(0); if (!POPOUT) setTimeout(act(refreshAddrChips), 30); });
    after('editTrip', function () { scheduleCard(100); if (!POPOUT) setTimeout(act(refreshAddrChips), 50); });
    after('useLastTrip', function () { scheduleCard(100); if (!POPOUT) setTimeout(act(refreshAddrChips), 50); });
    after('renderStops', function () { if (!POPOUT) { hookInputs(); setTimeout(act(refreshAddrChips), 0); } });
    if (POPOUT) return;
    wrapGeocode(); wrapFareRoute();
    /* 'Free maps' also stops the console's own Directions calls: its routeFor then uses the free router or a straight line */
    wrapOn(window, 'gRoute', function (orig) { return function () { if (opt('provider') === 'free') return Promise.resolve(null); return orig.apply(this, arguments); }; });
    after('renderView', function (v) {
      if (v === 'fleet' || v === 'map') setTimeout(act(function () { renderDriverPanels(true); }), 30);
      if (v === 'settings') setTimeout(act(function () { renderPanel(); setupChip(); }), 30);
      if (v === 'dispatch') { watchNY(); watchBoards(); scheduleCard(50); }
    });
    after('renderSettings', function () { setTimeout(act(function () { if (!byId('mapsPanel')) renderPanel(); fileUnderMaps(); setupChip(); }), 0); });
    after('setDriverLoc', scheduleDrivers);
    after('clearDriverLoc', scheduleDrivers);
    after('renderDriverStatus', scheduleDrivers);
    try { if (window.DriverLink) { wrapOn(window.DriverLink, 'ingestLocation', function (orig) { return function () { var r = orig.apply(this, arguments); scheduleDrivers(); scheduleEtaPaint(); return r; }; }); wrapOn(window.DriverLink, 'setShift', function (orig) { return function () { var r = orig.apply(this, arguments); scheduleDrivers(); return r; }; }); } } catch (e) {}
    ['d_date', 'd_time', 'd_driver'].forEach(function (id) { var el = byId(id); if (el && !el.__mapsLB) { el.__mapsLB = true; el.addEventListener('change', act(renderFacts)); } });
    var sb = byId('d_save');
    if (sb && !sb.__mapsHook) { sb.__mapsHook = true; sb.addEventListener('click', act(dSaveBefore), true); sb.addEventListener('click', act(function () { setTimeout(act(dSaveAfter), 0); }), false); }
    var go = byId('s_gtestOut');
    if (go && !go.__mapsObs && window.MutationObserver) { go.__mapsObs = true; new MutationObserver(act(onGtestOut)).observe(go, { childList: true, characterData: true, subtree: true }); }
    var st = byId('d_stops');
    if (st && !st.__mapsObs && window.MutationObserver) { st.__mapsObs = true; new MutationObserver(act(function () { hookInputs(); refreshAddrChips(); })).observe(st, { childList: true }); }
    window.addEventListener('online', act(refreshAll)); window.addEventListener('offline', act(refreshAll));
    window.addEventListener('storage', act(function (e) { if (e && e.key === 'skyway_dispatch_v2') { scheduleDrivers(); scheduleEtaPaint(); } }));
  }
  function ensureCss() {
    try {
      if (document.querySelector('link[href$="maps.css"]') || byId('mapsCssLink')) return;
      var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'maps.css'; l.id = 'mapsCssLink'; document.head.appendChild(l);
    } catch (e) {}
  }
  function repair() {
    var dirty = false;
    try {
      var s = settings();
      if (!s.maps || typeof s.maps !== 'object' || Array.isArray(s.maps)) { s.maps = {}; dirty = true; }
      var m = s.maps;
      ['routeCard', 'driverMap', 'etaOnBoard'].forEach(function (k) { if (typeof m[k] !== 'boolean') { m[k] = m[k] == null ? DEF[k] : !!m[k]; dirty = true; } });
      var n = Number(m.lateMin); if (!(isFinite(n) && n >= 1 && n <= 240)) { m.lateMin = 10; dirty = true; }
      if (m.provider !== 'auto' && m.provider !== 'free') { m.provider = 'auto'; dirty = true; }
    } catch (e) { log(e); }
    try {
      trips().forEach(function (t) {
        if (!t || typeof t !== 'object' || t.routeGeo == null) return;
        var ok = Array.isArray(t.routeGeo) && t.routeGeo.length > 1 && t.routeGeo.every(function (c) { return Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1]); });
        if (!ok) { delete t.routeGeo; dirty = true; }
      });
    } catch (e) { log(e); }
    return dirty;
  }

  window.Maps = {
    _loaded: true,
    routeFor: routeFor, currentRoute: currentRoute, routeGeo: routeGeo, driverMap: driverMap, eta: eta, status: status,
    googleDirUrl: googleDirUrl, refresh: refreshAll, checkGoogle: checkGoogle, addrConfidence: addrConfidence,
    lateList: function () { computeLate(); return LATE.slice(); }, assignFromMap: pinClick,
    selectTrip: function (id) { SEL.trip = id == null ? null : String(id); SEL.asked = SEL.trip && findTrip(SEL.trip) ? SEL.trip : null; renderDriverPanels(true); }, compact: compact, health: health,
    settings: function () { return MS(); }
  };

  function boot() {
    var dirty = false;
    try { dirty = repair(); } catch (e) {}
    if (dirty && !POPOUT) save();
    if (POPOUT && !ENTRY) return;
    try { hookAuthFailure(); } catch (e) {}
    try { rememberPlaceholders(); if (window._gAuthFail) unbreakInputs(true); } catch (e) {}
    try { ensureCss(); } catch (e) {}
    try { wrapConsole(); } catch (e) { log(e); }
    try { ensureCard(); scheduleCard(50); } catch (e) { log(e); }
    if (POPOUT) return;
    try { hookInputs(); hookTolls(); } catch (e) {}
    try { setInterval(chipsIfChanged, 3000); } catch (e) {}
    try { renderPanel(); setTimeout(act(fileUnderMaps), 400); setTimeout(act(fileUnderMaps), 1500); } catch (e) { log(e); }
    try { var view = byId('view-settings'); if (view && window.MutationObserver && !view.__mapsObs) { view.__mapsObs = true; new MutationObserver(act(function () { if (!byId('mapsPanel')) renderPanel(); fileUnderMaps(); })).observe(view, { childList: true }); } } catch (e) {}
    try { ensureDriverPanels(); renderDriverPanels(true); } catch (e) { log(e); }
    try { watchBoards(); computeLate(); watchNY(); } catch (e) { log(e); }
    setInterval(act(function () {
      if (document.hidden) return;
      renderDriverPanels(false);
      var b = byId('activeBoard'); if (b && visible(b)) paintEta();
      computeLate(); injectNY();
    }), 15000);
    /* one startup check per page when Google can really start here (never from file://) */
    if (gKeyOn() && !googleLoaded() && mayLoadGoogle()) setTimeout(act(function () { checkGoogle(); }), 2500);
    else if (googleLoaded()) recordGoogle(true, 'loaded');
    setTimeout(act(function () { hookTolls(); refreshChips(); }), 600);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
