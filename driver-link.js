/* ======================================================================
   Skyway — driver-link.js  (console side of the driver phone page, §4)

   Builds the driver.html#j=<base64url(JSON)> job link for a trip and sends
   it to the driver by sms: deep link (works today, no backend), with a
   "📲 Send job" button on every board row (wraps window.sheetRow, next to
   messages.js's "📱 Text" button). Records trip.sms.jobLink = {at, via}.

   Public API: window.DriverLink (see bottom).
   Plain ES2019, no build step. Never edits index.html. Skipped in pop-outs.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;

  /* SCREEN is a top-level const in index.html (lexical global, not on window) */
  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }
  if (POPOUT) return;
  if (window.DriverLink && window.DriverLink._loaded) return;

  /* ---------- helpers (own copies; globals may be missing) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function say(m, w) { try { if (typeof window.toast === 'function') window.toast(m, w); } catch (e) {} }
  function doSave() { try { if (typeof window.save === 'function') window.save(); } catch (e) {} }
  function findTrip(t) { if (t && typeof t === 'object') return t; return (STATE.trips || []).find(function (x) { return x.id === t; }) || null; }
  function findDriver(id) { return (STATE.drivers || []).find(function (d) { return d.id === id; }) || null; }
  function M() { return window.Messages && typeof window.Messages === 'object' ? window.Messages : null; }
  function normalizePhone(p) {
    if (M() && M().normalizePhone) return M().normalizePhone(p);
    var s = String(p || '').trim(); if (!s) return '';
    var plus = s.charAt(0) === '+', d = s.replace(/\D/g, ''); if (!d) return '';
    if (plus) return '+' + d;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
    return '+' + d;
  }
  function smsHref(phone, body) {
    if (M() && M().smsHref) return M().smsHref(phone, body);
    var h = 'sms:' + normalizePhone(phone);
    if (body != null && body !== '') h += '?&body=' + encodeURIComponent(String(body));
    return h;
  }
  function openHref(href) {
    try {
      var a = document.createElement('a'); a.href = href; a.style.display = 'none'; a.rel = 'noopener';
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { a.remove(); } catch (e) {} }, 500);
      return true;
    } catch (e) { try { location.href = href; return true; } catch (e2) { return false; } }
  }
  function copyText(body, cb) {
    if (M() && M().copyText) return M().copyText(body, cb);
    body = String(body == null ? '' : body);
    function done(ok) { if (typeof cb === 'function') cb(ok); }
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(body).then(function () { done(true); }, function () { done(fallback()); }); return; } } catch (e) {}
    done(fallback());
    function fallback() {
      try {
        var ta = document.createElement('textarea'); ta.value = body; ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;'; document.body.appendChild(ta);
        ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; } ta.remove(); return !!ok;
      } catch (e) { return false; }
    }
  }
  function b64uEncode(str) {
    var utf8 = encodeURIComponent(String(str)).replace(/%([0-9A-F]{2})/g, function (m, p) { return String.fromCharCode(parseInt(p, 16)); });
    return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDecode(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var bin = atob(s);
    try { return decodeURIComponent(bin.split('').map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join('')); } catch (e) { return bin; }
  }
  function time12(t) {
    t = String(t || '').trim(); var m = t.match(/^(\d{1,2}):(\d{2})/); if (!m) return t || 'ASAP';
    var h = +m[1], mi = m[2], ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12; return h + ':' + mi + ' ' + ap;
  }
  function fmtMoney(n) { n = Number(n) || 0; return Math.abs(n - Math.round(n)) < 0.005 ? '$' + Math.round(n) : '$' + n.toFixed(2); }
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

  /* ---------- the job payload + URL ---------- */
  function jobPayload(trip) {
    var t = findTrip(trip); if (!t) return null;
    var s = STATE.settings || {}, d = findDriver(t.driverId);
    var acct = t.accountId ? ((STATE.accounts || []).find(function (a) { return a.id === t.accountId; }) || {}).name : '';
    var pay = t.payType || (t.accountId ? 'Account' : 'Cash');
    var j = {
      no: t.dispatchNo != null ? String(t.dispatchNo) : '', date: t.date || '', time: t.time || '',
      pu: t.puAddr || '', do: t.doAddr || '', stops: Array.isArray(t.stops) ? t.stops.filter(Boolean) : [],
      pax: Number(t.pax) || 1, name: t.passenger || '', phone: t.phone || '', vtype: t.vtype || '',
      fare: Number(t.fare) || 0, tolls: Number(t.tolls) || 0, notes: t.notes || '', pay: pay,
      biz: { name: s.name || 'Skyway Car Service', phone: s.phone || s.cphone || '' },
      drv: { name: d ? d.name || '' : '', car: d ? d.carNo || '' : '' }
    };
    if (acct) j.acct = acct;
    if (t.flight) j.flight = t.flight;
    return j;
  }
  function baseDir() {
    var href = String(location.href || '').replace(/[#?].*$/, '');
    return href.replace(/[^\/]*$/, '');
  }
  function buildJobUrl(tripId) {
    var j = jobPayload(tripId); if (!j) return '';
    return baseDir() + 'driver.html#j=' + b64uEncode(JSON.stringify(j));
  }
  function decodeJobUrl(url) {
    try { var m = String(url || '').match(/#j=([^&]+)/); return m ? JSON.parse(b64uDecode(decodeURIComponent(m[1]))) : null; } catch (e) { return null; }
  }

  /* ---------- job text ---------- */
  function builtinJobText(t) {
    var s = STATE.settings || {}, biz = (s.name || 'Skyway').toUpperCase();
    var when = (t.date ? t.date + ' ' : '') + time12(t.time);
    var acct = t.accountId || /account/i.test(t.payType || '');
    var stops = (t.stops || []).filter(Boolean);
    return biz + ' JOB #' + t.dispatchNo + ' — ' + when + '. PU: ' + (t.puAddr || '?') + '. DO: ' + (t.doAddr || '?') + '.' +
      (stops.length ? ' ' + stops.length + ' stop' + (stops.length > 1 ? 's' : '') + '.' : '') +
      ' ' + (firstName(t.passenger) || 'Passenger') + ', ' + (Number(t.pax) || 1) + ' pax, ' + (t.vtype || 'any car') + '. ' +
      (acct ? 'Account — no cash.' : fmtMoney(t.fare) + ' + tolls.') + (t.notes ? ' Note: ' + t.notes + '.' : '') + ' Reply Y to accept, N to pass.';
  }
  function jobText(trip) {
    var t = findTrip(trip); if (!t) return '';
    var txt = '';
    try { if (M() && M().render) txt = M().render('driverJob', t); } catch (e) { txt = ''; }
    return txt || builtinJobText(t);
  }
  function markSent(t, via) {
    t.sms = t.sms || {}; t.sms.jobLink = { at: new Date().toISOString(), via: via };
    doSave();
    try { if (typeof window.refreshBoard === 'function' && byId('activeBoard')) window.refreshBoard(); } catch (e) {}
  }

  /* ---------- send ---------- */
  function sendJobToDriver(tripId, driverId) {
    var t = findTrip(tripId); if (!t) { say('Trip not found.', true); return false; }
    var url = buildJobUrl(t); if (!url) return false;
    var body = jobText(t) + ' Tap: ' + url;
    var d = findDriver(driverId || t.driverId);
    if (!d || !normalizePhone(d.phone)) {
      copyText(url, function (ok) {
        say(ok ? (d ? d.name + ' has no phone on file' : 'No driver assigned') + ' — job link copied, paste it anywhere.' : (d ? 'No phone for ' + d.name + '.' : 'No driver assigned.') + ' Link: ' + url, !ok);
        if (!ok) { try { window.prompt('Copy this job link:', url); } catch (e) {} }
      });
      markSent(t, 'copy');
      return false;
    }
    var ok = openHref(smsHref(d.phone, body));
    if (ok) { markSent(t, 'sms-link'); say('Opening your Messages app — job #' + t.dispatchNo + ' for ' + d.name + ' is prefilled.'); }
    else { copyText(url, function (c) { say(c ? 'Could not open Messages — job link copied instead.' : 'Could not open Messages.', !c); }); markSent(t, 'copy'); }
    return ok;
  }
  function copyJobUrl(tripId) {
    var t = findTrip(tripId); if (!t) return false;
    var url = buildJobUrl(t);
    copyText(url, function (ok) { say(ok ? 'Driver job link copied.' : 'Copy failed. Link: ' + url, !ok); if (!ok) { try { window.prompt('Copy this job link:', url); } catch (e) {} } });
    markSent(t, 'copy');
    return true;
  }

  /* ---------- driver location + shift (owner decision 7: on-shift-only tracking, consent recorded) ----------
     The phone page (driver.js) shares GPS only while the driver is On shift and only after tapping "I agree"
     under CONSENT_TEXT. Whatever path a pin takes into the console (cloud pull, a pasted "L #12 40.7,-73.9 …
     consent:<ISO>" text, a test), ingestLocation() is the one place that writes d.curLoc (source 'gps'),
     flips d.onShift on and records d.consentAt the first time the payload carries consent. */
  var CONSENT_TEXT = "Skyway tracks this phone's location only while you are On shift, to dispatch jobs and show passengers their ETA. Raw location data is kept 30 days.";
  function pad2(n) { return ('0' + n).slice(-2); }
  function whenStamp(at) {
    var d = at == null || at === '' ? new Date() : new Date(at); if (isNaN(d)) d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function repaintDrivers() {
    try { if (typeof window.renderDriverStatus === 'function') window.renderDriverStatus(); } catch (e) {}
    try { if (typeof window.renderOptimizer === 'function' && byId('view-optimizer') && byId('view-optimizer').classList.contains('active')) window.renderOptimizer(); } catch (e) {}
  }
  function ingestLocation(driverId, p) {
    var d = findDriver(driverId); if (!d || !p || typeof p !== 'object') return null;
    var lat = Number(p.lat), lng = Number(p.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    var when = whenStamp(p.at), cur = d.curLoc || {};
    var consent = p.consentAt || (p.consent === true ? new Date().toISOString() : '');
    if (consent && !d.consentAt) d.consentAt = String(consent);        // first consent on record wins
    if (d.onShift !== true || !d.shiftAt) d.shiftAt = new Date().toISOString();   // a live gps pin means the phone is On shift
    d.onShift = true;
    // an older point (offline replay) never overrides a newer pin, manual or gps — same rule as schema.sql
    if (cur.when && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(cur.when)) && String(cur.when) > when) { doSave(); repaintDrivers(); return d; }
    var near = cur.lat != null && cur.lng != null && Math.abs(Number(cur.lat) - lat) < 0.00045 && Math.abs(Number(cur.lng) - lng) < 0.0006;
    var acc = p.accuracy != null ? p.accuracy : p.acc;
    d.curLoc = {
      addr: (near && cur.addr) || String(p.addr || '') || (lat.toFixed(5) + ', ' + lng.toFixed(5)),
      when: when, lat: lat, lng: lng, source: 'gps',
      heading: p.heading != null && isFinite(Number(p.heading)) ? Number(p.heading) : null,
      speed: p.speed != null && isFinite(Number(p.speed)) ? Number(p.speed) : null,
      accuracy: acc != null && isFinite(Number(acc)) ? Number(acc) : null
    };
    doSave(); repaintDrivers();
    return d;
  }
  /* "L #12 40.71234,-73.98765 https://maps.google.com/?q=… consent:2026-01-31T14:02:11.000Z" → {no, lat, lng, consentAt} */
  function parseLocationText(txt) {
    var s = String(txt || '');
    var m = s.match(/\bL\b\s*(?:#\s*(\d+))?\s+(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/i);
    if (!m) return null;
    var c = s.match(/consent[:\s]+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z?)/i);
    return { no: m[1] || '', lat: Number(m[2]), lng: Number(m[3]), consentAt: c ? c[1] : '' };
  }
  function ingestLocationText(driverId, txt) {
    var p = parseLocationText(txt); if (!p) return null;
    return ingestLocation(driverId, { lat: p.lat, lng: p.lng, consentAt: p.consentAt });
  }
  /* Console marks a driver On/Off shift (no UI here — index.html's Driver status row is not rendered by this file). */
  function setShift(driverId, on) {
    var d = findDriver(driverId); if (!d) return false;
    on = !!on;
    if (!!d.onShift === on && d.shiftAt) return true;
    d.onShift = on; d.shiftAt = new Date().toISOString();
    doSave(); repaintDrivers();
    say((d.name || 'Driver') + (on ? ' is On shift.' : ' is Off shift — phone tracking paused; the last pin stays on the board.'));
    return true;
  }

  /* ---------- board integration: "📲 Send job" in the actions cell ---------- */
  function btnHtml(t) {
    var d = findDriver(t.driverId);
    var sent = t.sms && t.sms.jobLink && t.sms.jobLink.at;
    var title = d ? 'Text the job link to ' + d.name + (d.phone ? ' (' + d.phone + ')' : ' — no phone, copies the link') : 'No driver assigned — copies the job link';
    return '<button class="btn btn-ghost btn-sm dl-btn" type="button" onclick="DriverLink.sendJobToDriver(\'' + t.id + '\')" title="' + title.replace(/"/g, '&quot;') + '">📲 Send job' + (sent ? ' ✓' : '') + '</button> ';
  }
  if (typeof window.sheetRow === 'function' && !window.sheetRow._dlWrapped) {
    var _orig = window.sheetRow;
    var wrapped = function (t, now, leadMs, withDate, n) {
      var html = _orig.apply(this, arguments);
      try {
        if (t && t.id && typeof html === 'string') {
          var marker = '<td class="acts">', i = html.indexOf(marker);
          if (i >= 0) html = html.slice(0, i + marker.length) + btnHtml(t) + html.slice(i + marker.length);
        }
      } catch (e) {}
      return html;
    };
    wrapped._dlWrapped = true; wrapped._orig = _orig;
    if (_orig._msgWrapped) wrapped._msgWrapped = true;   // keep messages.js's guard honest if it re-checks
    window.sheetRow = wrapped;
  }

  function ensureStyle() {
    if (byId('dlStyle')) return;
    var st = document.createElement('style'); st.id = 'dlStyle';
    st.textContent = '.dl-btn{white-space:nowrap;}';
    document.head.appendChild(st);
  }

  /* ---------- public API ---------- */
  window.DriverLink = {
    _loaded: true,
    buildJobUrl: buildJobUrl, jobPayload: jobPayload, decodeJobUrl: decodeJobUrl,
    jobText: jobText, sendJobToDriver: sendJobToDriver, copyJobUrl: copyJobUrl,
    smsHref: smsHref, encode: function (o) { return b64uEncode(JSON.stringify(o)); },
    // owner decision 7
    CONSENT_TEXT: CONSENT_TEXT, ingestLocation: ingestLocation, ingestLocationText: ingestLocationText,
    parseLocationText: parseLocationText, setShift: setShift
  };

  function boot() {
    try { ensureStyle(); } catch (e) {}
    // Rows already on screen were rendered before this file loaded: repaint once.
    try { if (typeof window.refreshBoard === 'function' && byId('activeBoard')) window.refreshBoard(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
