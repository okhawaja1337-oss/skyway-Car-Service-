/* ======================================================================
   Skyway Driver — driver.js  (PRODUCT-DESIGN.md §4, no-backend mode)

   The job arrives in the URL:  driver.html#j=<base64url(JSON)>
     JSON = {no, date 'YYYY-MM-DD', time 'HH:MM', pu, do, stops[], pax, name,
             phone, vtype, fare, tolls, notes, pay?, biz:{name, phone}, drv:{name, car}}
   Everything the driver does opens an sms: link to the business number with
   the short codes the design understands (Y/N accept, E/A/P/D status,
   L location, D summary) and advances a local state kept in localStorage,
   so a reload keeps the job where it was. Works offline after first load
   (sw.js caches the shell). Plain ES2019, no build step, no frameworks.

   Public API: window.Driver (see bottom).
   ====================================================================== */
(function () {
  'use strict';

  var LS_JOB = 'skyway_drv_job_';     // + key  -> per-job state
  var LS_LAST = 'skyway_drv_last';    // last job hash payload (to resume)
  var LS_BIZ = 'skyway_drv_biz';      // last known business {name, phone}
  var STAGES = ['offered', 'accepted', 'enroute', 'arrived', 'pob', 'done'];
  var RAIL = [
    { from: 'accepted', to: 'enroute', code: 'E', label: 'On my way', ico: '🚗', cls: 'go' },
    { from: 'enroute', to: 'arrived', code: 'A', label: 'Arrived', ico: '📍', cls: 'navy' },
    { from: 'arrived', to: 'pob', code: 'P', label: 'Passenger on board', ico: '🧍', cls: 'gold' },
    { from: 'pob', to: 'done', code: 'D', label: 'Complete', ico: '🏁', cls: 'go' }
  ];

  var JOB = null, KEY = '', ST = null;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ls(k, v) {
    try {
      if (v === undefined) { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; }
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
  }
  function toast(m, warn) {
    var t = $('toast'); if (!t) return;
    t.textContent = m; t.className = 'toast show' + (warn ? ' warn' : '');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = 'toast' + (warn ? ' warn' : ''); }, 2600);
  }
  function b64uEncode(str) {
    var utf8 = encodeURIComponent(String(str)).replace(/%([0-9A-F]{2})/g, function (m, p) { return String.fromCharCode(parseInt(p, 16)); });
    return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDecode(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    try { return decodeURIComponent(bin.split('').map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join('')); } catch (e) { return bin; }
  }
  function normalizePhone(p) {
    var s = String(p || '').trim(); if (!s) return '';
    var plus = s.charAt(0) === '+', d = s.replace(/\D/g, ''); if (!d) return '';
    if (plus) return '+' + d;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
    return '+' + d;
  }
  /* '?&body=' works on both iOS and Android */
  function smsHref(phone, body) {
    var h = 'sms:' + normalizePhone(phone);
    if (body != null && body !== '') h += '?&body=' + encodeURIComponent(String(body));
    return h;
  }
  function telHref(phone) { return 'tel:' + normalizePhone(phone); }
  function money(n, short) {
    n = Number(n) || 0;
    if (short && Math.abs(n - Math.round(n)) < 0.005) return '$' + Math.round(n);
    return '$' + n.toFixed(2);
  }
  function time12(t) {
    t = String(t || '').trim(); var m = t.match(/^(\d{1,2}):(\d{2})/); if (!m) return t || 'ASAP';
    var h = +m[1], mi = m[2], ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12;
    return h + ':' + mi + ' ' + ap;
  }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function dateWord(s) {
    if (!s) return '';
    var p = String(s).split('-').map(Number); if (p.length !== 3) return s;
    var d = new Date(p[0], p[1] - 1, p[2]); if (isNaN(d)) return s;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var diff = Math.round((d - today) / 86400000);
    var txt = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + d.getDate();
    if (diff === 0) return 'Today · ' + txt;
    if (diff === 1) return 'Tomorrow · ' + txt;
    if (diff === -1) return 'Yesterday · ' + txt;
    return txt;
  }
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  function flightOf(j) {
    if (j.flight) return String(j.flight);
    var m = String(j.notes || '').match(/\b(?:flight|flt|fl)?\s*#?\s*([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{2,4})\b/i);
    return m ? (m[1] + m[2]).toUpperCase() : '';
  }
  function fareLine(j) {
    if (String(j.pay || '').toLowerCase() === 'account' || j.acct) return { txt: 'Account — no cash', acct: true };
    if (j.fare != null && j.fare !== '' && Number(j.fare) > 0) return { txt: money(j.fare, true) + ' + tolls', acct: false };
    return { txt: 'Fare: ask dispatch', acct: false };
  }
  function bizPhone() { return (JOB && JOB.biz && JOB.biz.phone) || ''; }
  function codeHref(code) { return smsHref(bizPhone(), code + ' #' + (JOB ? JOB.no : '')); }

  /* ---------- map deep links ---------- */
  function gmaps(addr) { return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(addr || '') + '&travelmode=driving'; }
  function amaps(addr) { return 'http://maps.apple.com/?daddr=' + encodeURIComponent(addr || '') + '&dirflg=d'; }
  function waze(addr) { return 'https://waze.com/ul?q=' + encodeURIComponent(addr || '') + '&navigate=yes'; }

  /* ---------- job + state ---------- */
  function readJobFromUrl() {
    var raw = '';
    try {
      var h = location.hash || '';
      var m = h.match(/[#&]j=([^&]+)/); if (m) raw = m[1];
      if (!raw) { var q = new URLSearchParams(location.search).get('j'); if (q) raw = q; }
    } catch (e) {}
    if (!raw) return null;
    try {
      var txt = raw.charAt(0) === '{' || raw.indexOf('%7B') === 0 ? decodeURIComponent(raw) : b64uDecode(decodeURIComponent(raw));
      var j = JSON.parse(txt);
      if (!j || typeof j !== 'object') return null;
      j.no = j.no != null ? String(j.no) : '';
      j.stops = Array.isArray(j.stops) ? j.stops.filter(Boolean) : [];
      j.biz = j.biz || {}; j.drv = j.drv || {};
      j._raw = raw;
      return j;
    } catch (e) { return null; }
  }
  function jobKey(j) { return LS_JOB + (j.no || 'x') + '_' + (j.date || ''); }
  function loadState() {
    var s = ls(KEY) || {};
    if (STAGES.indexOf(s.stage) < 0 && s.stage !== 'passed') s.stage = 'offered';
    s.t = s.t || {};
    return s;
  }
  function saveState() { ls(KEY, ST); }
  function setStage(stage, silent) {
    if (!JOB) return false;
    if (STAGES.indexOf(stage) < 0 && stage !== 'passed') return false;
    ST.stage = stage; ST.t[stage] = new Date().toISOString(); saveState();
    if (!silent) render();
    wake();
    return true;
  }
  function stageIdx(s) { return STAGES.indexOf(s); }
  function onJob() { var i = stageIdx(ST && ST.stage); return i >= 1 && i <= 4; }

  /* ---------- screen wake lock ---------- */
  var wakeLock = null;
  function wake() {
    var want = !!(JOB && onJob());
    var chip = $('wakeChip');
    if (!('wakeLock' in navigator) || !navigator.wakeLock || !navigator.wakeLock.request) { if (chip) chip.classList.add('hidden'); return; }
    if (want && !wakeLock && document.visibilityState === 'visible') {
      try {
        navigator.wakeLock.request('screen').then(function (l) {
          wakeLock = l; if (chip) chip.classList.remove('hidden');
          l.addEventListener('release', function () { wakeLock = null; if (chip) chip.classList.add('hidden'); });
        }, function () { wakeLock = null; });
      } catch (e) {}
    } else if (!want && wakeLock) {
      try { wakeLock.release(); } catch (e) {} wakeLock = null; if (chip) chip.classList.add('hidden');
    }
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') wake(); });

  /* ---------- GPS ---------- */
  var gps = { watch: null, last: null, err: '', tick: null };
  function gpsSupported() { return !!(navigator.geolocation && navigator.geolocation.watchPosition); }
  function gpsStart() {
    if (!gpsSupported()) { gps.err = 'This phone/browser has no location service.'; renderGps(); return; }
    if (!window.isSecureContext && location.protocol !== 'file:') { gps.err = 'Location only works on an https:// link. Ask dispatch for the secure link.'; renderGps(); return; }
    if (gps.watch != null) return;
    gps.err = '';
    try {
      gps.watch = navigator.geolocation.watchPosition(function (pos) {
        gps.last = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, speed: pos.coords.speed, at: Date.now() };
        gps.err = ''; renderGps();
      }, function (e) {
        var c = e && e.code;
        gps.err = c === 1 ? 'Location is blocked for this page. iPhone: Settings → Privacy → Location Services → Safari Websites → "While Using". Android: tap the lock icon in the address bar → Permissions → Location → Allow. Then press Share my location again.'
          : c === 3 ? 'Still looking for a GPS fix… go near a window or outside.'
            : 'Location unavailable right now (' + ((e && e.message) || 'unknown') + ').';
        if (c === 1) { gpsStop(false); ST.share = false; saveState(); }
        renderGps();
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
      ST.share = true; saveState();
      if (!gps.tick) gps.tick = setInterval(renderGpsAge, 1000);
    } catch (e) { gps.err = 'Could not start location: ' + e.message; }
    renderGps();
  }
  function gpsStop(persist) {
    if (gps.watch != null) { try { navigator.geolocation.clearWatch(gps.watch); } catch (e) {} }
    gps.watch = null; if (gps.tick) { clearInterval(gps.tick); gps.tick = null; }
    if (persist !== false) { ST.share = false; saveState(); }
    renderGps();
  }
  function gpsAgeTxt() { if (!gps.last) return ''; var s = Math.max(0, Math.round((Date.now() - gps.last.at) / 1000)); return s < 60 ? 'updated ' + s + 's ago' : 'updated ' + Math.round(s / 60) + ' min ago'; }
  function gpsLocHref() {
    if (!gps.last) return '#';
    var ll = gps.last.lat.toFixed(5) + ',' + gps.last.lng.toFixed(5);
    return smsHref(bizPhone(), 'L #' + JOB.no + ' ' + ll + ' https://maps.google.com/?q=' + ll);
  }
  function renderGpsAge() { var a = $('gpsAge'); if (a) a.textContent = gpsAgeTxt(); }
  function renderGps() {
    var host = $('gpsBody'); if (!host) return;
    var on = gps.watch != null, h = '';
    if (on) {
      if (gps.last) {
        h += '<div class="gps-vals"><b>' + gps.last.lat.toFixed(5) + ', ' + gps.last.lng.toFixed(5) + '</b><br>±' + Math.round(gps.last.acc || 0) + ' m · <span id="gpsAge">' + esc(gpsAgeTxt()) + '</span></div>';
        h += '<div class="stack" style="margin-top:10px"><a class="btn navy" id="btnSendLoc" data-act="sendloc" href="' + esc(gpsLocHref()) + '"><span class="ico">📡</span> Send location to dispatch</a>';
      } else {
        h += '<div class="muted">Getting a GPS fix… <span id="gpsAge"></span></div><div class="stack" style="margin-top:10px">';
      }
      h += '<button class="btn ghost sm" type="button" data-act="gpsoff">Stop sharing</button></div>';
      h += '<div class="small muted" style="margin-top:8px">Keep Skyway open while on a job — a phone browser cannot report location when the screen is locked.</div>';
    } else {
      h += '<button class="btn navy" type="button" id="btnShareLoc" data-act="gpson"><span class="ico">📍</span> Share my location</button>';
      h += '<div class="small muted" style="margin-top:8px">Dispatch sees where you are so they can plan the next job. Only while you are on a job.</div>';
    }
    if (gps.err) h += '<div class="err" id="gpsErr">' + esc(gps.err) + '</div>';
    host.innerHTML = h;
  }

  /* ---------- rendering ---------- */
  function header() {
    var bizEl = $('bizName'), who = $('drvName');
    var biz = (JOB && JOB.biz && JOB.biz.name) || (ls(LS_BIZ) || {}).name || 'Skyway Driver';
    if (bizEl) bizEl.textContent = biz;
    if (who) { var d = JOB && JOB.drv; who.textContent = d && (d.name || d.car) ? [d.name, d.car ? 'Car ' + d.car : ''].filter(Boolean).join(' · ') : ''; }
    var f = $('foot'); if (f) f.textContent = JOB ? 'Job #' + JOB.no + ' · taps open your Messages app with the code prefilled — just press send.' : 'Skyway Driver · add this page to your Home Screen.';
  }
  function legHtml(lbl, addr, cls) {
    return '<div class="leg"><span class="dot ' + cls + '"></span><div><div class="lbl">' + lbl + '</div><div class="addr' + (cls === 'stop' ? ' sub' : '') + '">' + esc(addr || '—') + '</div></div></div>';
  }
  function routeHtml(j, compact) {
    var h = legHtml('Pickup', j.pu, 'pu');
    if (!compact) j.stops.forEach(function (s, i) { h += legHtml('Stop ' + (i + 1), s, 'stop'); });
    else if (j.stops.length) h += legHtml(j.stops.length + ' stop' + (j.stops.length > 1 ? 's' : ''), j.stops.join(' → '), 'stop');
    h += legHtml('Drop-off', j.do, 'do');
    return h;
  }
  function jobCard(j, compact) {
    var fl = fareLine(j), flight = flightOf(j);
    var h = '<section class="card" id="jobCard">';
    h += '<div class="jobno"><span>Job <b id="jobNo">#' + esc(j.no) + '</b></span><span>' + esc(j.vtype || '') + '</span></div>';
    h += '<div class="bigtime" id="jobTime">' + esc(time12(j.time)) + '</div><div class="bigdate" id="jobDate">' + esc(dateWord(j.date)) + '</div>';
    h += '<div id="jobRoute">' + routeHtml(j, compact) + '</div>';
    h += '<div class="pax"><span class="tag" id="jobPax">' + esc(firstName(j.name) || 'Passenger') + ' · ' + (Number(j.pax) || 1) + ' pax</span>' + (j.vtype ? '<span class="tag">' + esc(j.vtype) + '</span>' : '') + '</div>';
    h += '<div class="fareline' + (fl.acct ? ' acct' : '') + '" id="jobFare">' + esc(fl.txt) + '</div>';
    if (flight) h += '<span class="flight" id="jobFlight">✈ Flight ' + esc(flight) + '</span>';
    if (!compact && j.notes) h += '<div class="notes" id="jobNotes">' + esc(j.notes) + '</div>';
    h += '</section>';
    return h;
  }
  function navCard() {
    var toDo = stageIdx(ST.stage) >= stageIdx('pob');
    var target = toDo ? JOB.do : JOB.pu, lbl = toDo ? 'drop-off' : 'pickup';
    var h = '<section class="card" id="navCard"><h2>Navigate to ' + lbl + '</h2><div class="muted small" style="margin-bottom:10px">' + esc(target || '') + '</div>';
    h += '<div class="grid3"><a class="btn sm" id="navG" href="' + esc(gmaps(target)) + '" target="_blank" rel="noopener">Google</a><a class="btn sm" id="navA" href="' + esc(amaps(target)) + '" target="_blank" rel="noopener">Apple</a><a class="btn sm" id="navW" href="' + esc(waze(target)) + '" target="_blank" rel="noopener">Waze</a></div>';
    if (toDo && JOB.stops.length) {
      h += '<div class="small muted" style="margin:10px 0 4px">Stops first:</div>';
      JOB.stops.forEach(function (s, i) { h += '<a class="btn ghost sm" style="margin-top:6px" href="' + esc(gmaps(s)) + '" target="_blank" rel="noopener">Stop ' + (i + 1) + ': ' + esc(s) + '</a>'; });
    }
    h += '</section>';
    return h;
  }
  function paxCard() {
    var ph = JOB.phone, nm = firstName(JOB.name) || 'passenger';
    var h = '<section class="card" id="paxCard"><h2>Passenger</h2><h3>' + esc(JOB.name || 'Passenger') + ' · ' + (Number(JOB.pax) || 1) + ' pax</h3>';
    if (normalizePhone(ph)) {
      h += '<div class="grid2" style="margin-top:8px"><a class="btn go" id="btnCall" href="' + esc(telHref(ph)) + '"><span class="ico">📞</span> Call</a><a class="btn navy" id="btnText" href="' + esc(smsHref(ph, 'Hi ' + nm + ', this is your ' + ((JOB.biz && JOB.biz.name) || 'Skyway') + ' driver' + (JOB.drv && JOB.drv.name ? ' ' + firstName(JOB.drv.name) : '') + '. ')) + '"><span class="ico">💬</span> Text</a></div>';
    } else h += '<div class="muted small">No passenger phone on this job — call dispatch if you need to reach them.</div>';
    if (bizPhone()) h += '<a class="btn ghost sm" style="margin-top:10px" id="btnCallDispatch" href="' + esc(telHref(bizPhone())) + '">📞 Call dispatch</a>';
    h += '</section>';
    return h;
  }
  function gpsCard() { return '<section class="card" id="gpsCard"><h2>Location</h2><div id="gpsBody"></div></section>'; }
  function railHtml() {
    var i = stageIdx(ST.stage), h = '<div class="rail" id="rail">';
    RAIL.forEach(function (r, k) { h += '<span class="' + (stageIdx(r.to) <= i ? 'done' : (stageIdx(r.from) === i ? 'cur' : '')) + '"></span>'; });
    return h + '</div>';
  }
  function stageName(s) { return { offered: 'Offered', accepted: 'Accepted', enroute: 'On my way', arrived: 'Arrived', pob: 'Passenger on board', done: 'Completed', passed: 'Passed' }[s] || s; }

  function screenOffer() {
    var h = jobCard(JOB, false);
    h += '<section class="card" id="scr-job"><div class="stack">';
    h += '<a class="btn huge go" id="btnAccept" data-act="stage" data-to="accepted" href="' + esc(codeHref('Y')) + '"><span class="ico">✅</span> Accept</a>';
    h += '<a class="btn warn" id="btnPass" data-act="stage" data-to="passed" href="' + esc(codeHref('N')) + '"><span class="ico">✖</span> Pass</a>';
    h += '</div><div class="small muted center" style="margin-top:10px">Each button opens a text to dispatch (Y / N #' + esc(JOB.no) + ') — press send.</div></section>';
    if (bizPhone()) h += '<section class="card"><a class="btn ghost sm" href="' + esc(telHref(bizPhone())) + '">📞 Call dispatch</a></section>';
    return h;
  }
  function screenPassed() {
    return jobCard(JOB, true) + '<section class="card center" id="scr-passed"><h3>You passed on job #' + esc(JOB.no) + '</h3><div class="muted small">Dispatch will offer it to someone else. Changed your mind?</div><div class="undo"><button class="linkbtn" type="button" data-act="stage" data-to="offered">Undo — show the offer again</button></div></section>';
  }
  function screenRail() {
    var step = RAIL.filter(function (r) { return r.from === ST.stage; })[0];
    var h = '<section class="card" id="scr-rail">' + railHtml();
    h += '<div class="stage">Status: <b id="stageNow">' + esc(stageName(ST.stage)) + '</b></div>';
    if (step) {
      h += '<a class="btn huge ' + step.cls + '" id="btnStage" data-act="stage" data-to="' + step.to + '" data-code="' + step.code + '" href="' + esc(codeHref(step.code)) + '"><span class="ico">' + step.ico + '</span> ' + step.label + '</a>';
      h += '<div class="small muted center" style="margin-top:8px">Opens a text "' + step.code + ' #' + esc(JOB.no) + '" to dispatch — press send.</div>';
    }
    var i = stageIdx(ST.stage);
    if (i > 1) h += '<div class="undo"><button class="linkbtn" type="button" data-act="stage" data-to="' + STAGES[i - 1] + '">↩ Back one step</button></div>';
    else h += '<div class="undo"><button class="linkbtn" type="button" data-act="stage" data-to="offered">↩ Back to the offer</button></div>';
    h += '</section>';
    h += jobCard(JOB, true) + navCard() + paxCard() + gpsCard();
    return h;
  }
  function sumVals() {
    var fare = Number(JOB.fare) || 0;
    var tolls = ST.tolls != null ? Number(ST.tolls) || 0 : (Number(JOB.tolls) || 0);
    var wait = ST.wait != null ? Number(ST.wait) || 0 : 0;
    var stops = ST.stops != null ? Number(ST.stops) || 0 : JOB.stops.length;
    var acct = fareLine(JOB).acct;
    var cash = ST.cash != null ? !!ST.cash : (!acct && String(JOB.pay || 'Cash').toLowerCase() === 'cash');
    return { fare: fare, tolls: tolls, wait: wait, stops: stops, cash: cash, acct: acct, total: fare + tolls };
  }
  function summaryBody() {
    var v = sumVals();
    var b = 'D #' + JOB.no + ' fare ' + v.fare.toFixed(2).replace(/\.00$/, '') + ' tolls ' + v.tolls.toFixed(2).replace(/\.00$/, '') + ' wait ' + v.wait;
    if (v.stops) b += ' stops ' + v.stops;
    b += ' cash ' + (v.cash ? 'Y' : 'N');
    return b;
  }
  function screenDone() {
    var v = sumVals();
    var h = '<section class="card" id="scr-done">' + railHtml() + '<div class="stage">Status: <b id="stageNow">Completed</b></div><h3>Job #' + esc(JOB.no) + ' done 🏁</h3>';
    h += '<div class="muted small">' + esc(firstName(JOB.name) || 'Passenger') + ' · ' + esc(JOB.pu || '') + ' → ' + esc(JOB.do || '') + '</div>';
    h += '<div class="grid2" style="margin-top:12px"><div><label class="f" for="inTolls">Tolls ($)</label><input class="in" id="inTolls" type="number" inputmode="decimal" step="0.01" min="0" value="' + esc(v.tolls || '') + '" placeholder="0.00"></div>';
    h += '<div><label class="f" for="inWait">Wait (minutes)</label><input class="in" id="inWait" type="number" inputmode="numeric" step="1" min="0" value="' + esc(v.wait || '') + '" placeholder="0"></div></div>';
    h += '<div style="margin-top:10px"><label class="f" for="inStops">Stops made</label><input class="in" id="inStops" type="number" inputmode="numeric" step="1" min="0" value="' + esc(v.stops) + '"></div>';
    h += '<label class="switch" style="margin-top:8px"><span>Cash collected' + (v.acct ? ' <span class="muted small">(account job)</span>' : '') + '</span><input type="checkbox" id="inCash"' + (v.cash ? ' checked' : '') + '><span class="knob"></span></label>';
    h += '<dl class="sum" id="sumList"><dt>Fare</dt><dd id="sumFare">' + money(v.fare) + '</dd><dt>Tolls</dt><dd id="sumTolls">' + money(v.tolls) + '</dd><dt>Wait</dt><dd id="sumWait">' + v.wait + ' min</dd><dt>Stops</dt><dd id="sumStops">' + v.stops + '</dd></dl>';
    h += '<div class="total"><span>Total</span><span id="sumTotal">' + money(v.total) + '</span></div>';
    h += '<div class="stack" style="margin-top:14px"><a class="btn huge go" id="btnSummary" data-act="summary" href="' + esc(smsHref(bizPhone(), summaryBody())) + '"><span class="ico">📨</span> Send summary</a>';
    if (ST.summarySent) h += '<div class="sent center">Summary sent ' + esc(new Date(ST.summarySent).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + ' — send again if anything changed.</div>';
    h += '<button class="btn ghost sm" type="button" data-act="stage" data-to="pob">↩ Not done yet — go back</button>';
    h += '<button class="btn ghost sm" type="button" data-act="clear">Finish — clear this job from my phone</button></div></section>';
    h += gpsCard();
    return h;
  }
  function screenNoJob() {
    var biz = ls(LS_BIZ) || {}, last = ls(LS_LAST);
    var h = '<section class="card" id="scr-nojob"><h2>Connect phone</h2><h3>No job on this link yet</h3>';
    h += '<ol class="steps"><li><b>Ask dispatch for your job link.</b> They press <i>Send job</i> on the board and you get a text — tap the link in it.</li>';
    if (normalizePhone(biz.phone)) h += '<li>Or text <b>JOIN</b> to <span class="bigphone">' + esc(biz.phone) + '</span><br><a class="btn navy sm" id="btnJoin" style="margin-top:8px" href="' + esc(smsHref(biz.phone, 'JOIN')) + '">💬 Text JOIN to ' + esc(biz.name || 'dispatch') + '</a></li>';
    else h += '<li>Or text <b>JOIN</b> to the business number and dispatch will send your link.</li>';
    h += '</ol>';
    if (last && last.no) h += '<div class="stack" style="margin-top:12px"><button class="btn gold" type="button" id="btnResume" data-act="resume">Resume job #' + esc(last.no) + '</button></div>';
    h += '</section>';
    h += '<section class="card" id="a2hs"><h2>Add to Home Screen</h2><div class="muted small">Then Skyway Driver opens like an app, full screen, even with no signal.</div>';
    h += '<div id="installRow" class="hidden" style="margin-top:10px"><button class="btn navy" type="button" id="btnInstall" data-act="install">⬇ Install Skyway Driver</button></div>';
    h += '<h3 style="margin-top:12px"> iPhone (Safari)</h3><ol class="steps"><li>Tap the <b>Share</b> button (square with an arrow) at the bottom.</li><li>Scroll and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. Open it from your Home Screen from now on.</li></ol>';
    h += '<h3 style="margin-top:12px">🤖 Android (Chrome)</h3><ol class="steps"><li>Tap the <b>⋮</b> menu at the top right.</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li><li>Tap <b>Install</b>. Open it from your Home Screen from now on.</li></ol></section>';
    return h;
  }

  function render() {
    var app = $('app'); if (!app) return;
    header();
    var h;
    if (!JOB) h = screenNoJob();
    else if (ST.stage === 'offered') h = screenOffer();
    else if (ST.stage === 'passed') h = screenPassed();
    else if (ST.stage === 'done') h = screenDone();
    else h = screenRail();
    app.innerHTML = h;
    if (!app._bound) { app._bound = true; bind(app); }
    renderGps();
    if (JOB && ST.share && gps.watch == null && onJob()) gpsStart();
    if (JOB && !onJob() && gps.watch != null && ST.stage !== 'done') gpsStop(false);
    if (installEvt) { var r = $('installRow'); if (r) r.classList.remove('hidden'); }
    try { window.scrollTo(0, 0); } catch (e) {}
  }

  function bind(root) {
    root.addEventListener('click', function (ev) {
      var el = ev.target.closest ? ev.target.closest('[data-act]') : null; if (!el) return;
      var act = el.getAttribute('data-act');
      if (act === 'stage') {
        var to = el.getAttribute('data-to');
        var isLink = el.tagName === 'A';
        setStage(to, false);
        if (isLink) toast(to === 'passed' ? 'Opening Messages — send "N #' + JOB.no + '" to dispatch.' : 'Opening Messages — press send.');
        // let the sms: link open; the page state is already saved
      } else if (act === 'gpson') { gpsStart(); }
      else if (act === 'gpsoff') { gpsStop(true); }
      else if (act === 'sendloc') { if (!gps.last) { ev.preventDefault(); toast('No GPS fix yet.', true); return; } toast('Opening Messages — send your location to dispatch.'); }
      else if (act === 'summary') { ST.summarySent = new Date().toISOString(); saveState(); toast('Opening Messages — press send.'); }
      else if (act === 'clear') { clearJob(); }
      else if (act === 'resume') { var last = ls(LS_LAST); if (last && last.raw) { location.hash = '#j=' + last.raw; } }
      else if (act === 'install') { if (installEvt) { try { installEvt.prompt(); } catch (e) {} } }
    });
    root.addEventListener('input', function (ev) {
      var id = ev.target && ev.target.id;
      if (id === 'inTolls') ST.tolls = ev.target.value === '' ? null : Number(ev.target.value);
      else if (id === 'inWait') ST.wait = ev.target.value === '' ? null : Number(ev.target.value);
      else if (id === 'inStops') ST.stops = ev.target.value === '' ? null : Number(ev.target.value);
      else if (id === 'inCash') ST.cash = !!ev.target.checked;
      else return;
      saveState(); refreshSummary();
    });
  }
  function refreshSummary() {
    var v = sumVals();
    var set = function (id, txt) { var e = $(id); if (e) e.textContent = txt; };
    set('sumFare', money(v.fare)); set('sumTolls', money(v.tolls)); set('sumWait', v.wait + ' min'); set('sumStops', String(v.stops)); set('sumTotal', money(v.total));
    var b = $('btnSummary'); if (b) b.setAttribute('href', smsHref(bizPhone(), summaryBody()));
  }
  function clearJob() {
    if (!JOB) return;
    gpsStop(true);
    ls(KEY, null);
    var last = ls(LS_LAST); if (last && last.no === JOB.no) ls(LS_LAST, null);
    JOB = null; KEY = ''; ST = null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { try { location.hash = ''; } catch (e2) {} }
    wake(); render(); toast('Job cleared.');
  }

  /* ---------- boot ---------- */
  var installEvt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; var r = $('installRow'); if (r) r.classList.remove('hidden'); });
  function netChip() { var c = $('netChip'); if (!c) return; var on = navigator.onLine !== false; c.textContent = on ? 'online' : 'offline'; c.className = 'chip' + (on ? '' : ' off'); }
  window.addEventListener('online', netChip); window.addEventListener('offline', netChip);

  function init() {
    JOB = readJobFromUrl();
    if (JOB) {
      KEY = jobKey(JOB); ST = loadState();
      ls(LS_LAST, { no: JOB.no, raw: JOB._raw, at: new Date().toISOString() });
      if (JOB.biz && (JOB.biz.phone || JOB.biz.name)) ls(LS_BIZ, { name: JOB.biz.name || '', phone: JOB.biz.phone || '' });
    } else { KEY = ''; ST = null; }
    netChip(); render(); wake();
  }
  window.addEventListener('hashchange', function () { gpsStop(false); init(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    try { navigator.serviceWorker.register('./sw.js').catch(function () {}); } catch (e) {}
  }

  /* ---------- public API (for tests and the console) ---------- */
  window.Driver = {
    job: function () { return JOB; },
    state: function () { return ST; },
    setStage: setStage,
    stages: STAGES.slice(), rail: RAIL.slice(),
    encode: function (obj) { return b64uEncode(JSON.stringify(obj)); },
    decode: function (s) { return JSON.parse(b64uDecode(s)); },
    smsHref: smsHref, normalizePhone: normalizePhone,
    codeHref: codeHref, summaryBody: summaryBody,
    gps: { start: gpsStart, stop: gpsStop, last: function () { return gps.last; }, error: function () { return gps.err; } },
    render: render, clear: clearJob, reload: init,
    maps: { google: gmaps, apple: amaps, waze: waze }
  };
})();
