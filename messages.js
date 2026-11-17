/* ======================================================================
   Skyway — messages.js
   Texting, client-side today (PRODUCT-DESIGN.md §5 "what works today").

   - Editable text templates (Settings → "Messages — text templates"),
     stored in STATE.settings.templates, defaults below.
   - sms: deep links ("sms:+1917…?&body=…") that open the dispatcher's own
     phone / Messages app with the text prefilled; copy-to-clipboard fallback.
   - "📱 Text" button on every board row (wraps window.sheetRow), a Text
     button per Optimizer plan row (wraps window.optRenderPlan) and per
     driver in Driver IQ (wraps window.renderDriverStatus).
   - Records sends on the trip: trip.sms[templateKey] = {at, via}.
   - Map deep links: Google / Apple / Waze.

   Public API: window.Messages (see bottom).
   Plain ES2019, no build step. Never edits index.html.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;

  /* SCREEN is a top-level `const` in index.html (a lexical global, not a window property):
     read it by bare identifier, with window.SCREEN as a fallback. */
  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }

  /* ---------- tiny helpers (own copies: never assume globals exist) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function money(n) { if (typeof window.money === 'function') { try { return window.money(n); } catch (e) {} } n = Number(n) || 0; return '$' + n.toFixed(2); }
  function shortAddr(a) { if (typeof window.shortAddr === 'function') { try { return window.shortAddr(a); } catch (e) {} } return (a || '').split(',')[0].trim(); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[messages] ' + m); } catch (e) {} }
  function save() { if (typeof window.save === 'function') { try { window.save(); } catch (e) {} } }
  function settings() { return (STATE && STATE.settings) || {}; }
  function findTrip(t) { if (!t) return null; if (typeof t === 'object') return t; return (STATE.trips || []).filter(function (x) { return x.id === t; })[0] || null; }
  function findDriver(id) { return (STATE.drivers || []).filter(function (d) { return d.id === id; })[0] || null; }
  function findVehicle(t, d) {
    var vs = STATE.vehicles || [];
    var v = t && t.vehicleId ? vs.filter(function (x) { return x.id === t.vehicleId; })[0] : null;
    if (!v && d && d.tlc) v = vs.filter(function (x) { return x.tlc && String(x.tlc) === String(d.tlc); })[0] || null;
    return v || null;
  }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function addDays(ymd, n) { var p = (ymd || '').split('-').map(Number); if (p.length !== 3) return ''; var d = new Date(p[0], p[1] - 1, p[2] + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /* '2026-11-18' -> 'Tue Nov 18' */
  function fmtDateLong(ymd) { var p = (ymd || '').split('-').map(Number); if (p.length !== 3 || !p[0]) return ymd || ''; var d = new Date(p[0], p[1] - 1, p[2]); if (isNaN(d)) return ymd; return DOW[d.getDay()] + ' ' + MON[d.getMonth()] + ' ' + d.getDate(); }
  /* '15:40' or '3:40 pm' -> '3:40 PM' */
  function fmtTime12(t) {
    t = String(t || '').trim(); if (!t) return '';
    var m = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i); if (!m) return t;
    var h = +m[1], mi = m[2], ap = m[3] ? m[3].toLowerCase() : '';
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    var suf = h >= 12 ? 'PM' : 'AM'; var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + mi + ' ' + suf;
  }
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  function carLabel(d) { if (!d || !d.carNo) return ''; var s = String(d.carNo).trim(); var digits = s.replace(/\D/g, ''); if (digits && digits === s) s = String(parseInt(digits, 10)); return 'Car ' + s; }
  function vehicleDesc(v, t) {
    if (!v) return (t && t.vtype) || '';
    var parts = [v.color, v.make, v.model].filter(function (x) { return x && String(x).trim(); }).map(function (x) { return String(x).trim(); });
    if (parts.length) return parts.join(' ');
    return v.name || v.type || (t && t.vtype) || '';
  }

  /* ---------- phone normalization + sms: links ---------- */
  function normalizePhone(p) {
    var s = String(p || '').trim(); if (!s) return '';
    var plus = s.charAt(0) === '+';
    var d = s.replace(/\D/g, ''); if (!d) return '';
    if (plus) return '+' + d;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
    return '+' + d;
  }
  /* The '?&body=' form opens with the text prefilled on both iOS and Android. */
  function smsHref(phone, body) {
    var to = normalizePhone(phone);
    var h = 'sms:' + to;
    if (body != null && body !== '') h += '?&body=' + encodeURIComponent(String(body));
    return h;
  }
  function openHref(href) {
    try {
      var a = document.createElement('a'); a.href = href; a.style.display = 'none';
      a.rel = 'noopener'; document.body.appendChild(a); a.click();
      setTimeout(function () { try { a.remove(); } catch (e) {} }, 500);
      return true;
    } catch (e) { try { location.href = href; return true; } catch (e2) { return false; } }
  }
  function copyText(body, cb) {
    body = String(body == null ? '' : body);
    function done(ok) { if (typeof cb === 'function') cb(ok); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(body).then(function () { done(true); }, function () { done(copyFallback(body)); });
        return;
      }
    } catch (e) {}
    done(copyFallback(body));
  }
  function copyFallback(body) {
    try {
      var ta = document.createElement('textarea'); ta.value = body; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;'; document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, body.length); var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove(); return !!ok;
    } catch (e) { return false; }
  }

  /* ---------- map deep links ---------- */
  function mapsDirectionsUrl(from, to) {
    var q = 'https://www.google.com/maps/dir/?api=1';
    if (from) q += '&origin=' + encodeURIComponent(from);
    if (to) q += '&destination=' + encodeURIComponent(to);
    return q + '&travelmode=driving';
  }
  function appleMapsUrl(from, to) { return 'http://maps.apple.com/?' + (from ? 'saddr=' + encodeURIComponent(from) + '&' : '') + 'daddr=' + encodeURIComponent(to || ''); }
  function wazeUrl(to) { return 'https://waze.com/ul?q=' + encodeURIComponent(to || '') + '&navigate=yes'; }

  /* ---------- templates ---------- */
  var TEMPLATE_META = [
    { key: 'driverJob', who: 'driver', label: 'Driver — job offer', when: 'Sent to the driver when you press Text driver (job).' },
    { key: 'booked', who: 'passenger', label: 'Passenger — booked', when: 'When a trip with a phone is saved.' },
    { key: 'assigned', who: 'passenger', label: 'Passenger — driver assigned', when: 'When a driver is put on the trip.' },
    { key: 'onTheWay', who: 'passenger', label: 'Passenger — on the way', when: 'When the driver is heading to the pickup.' },
    { key: 'arrived', who: 'passenger', label: 'Passenger — arrived', when: 'When the driver is at the pickup.' },
    { key: 'receipt', who: 'passenger', label: 'Passenger — completed / receipt', when: 'After the trip is completed.' },
    { key: 'reminder', who: 'passenger', label: 'Passenger — reminder', when: 'The evening before a ride booked well ahead.' },
    { key: 'canceled', who: 'passenger', label: 'Passenger — canceled', when: 'When a ride is canceled.' }
  ];
  var DEFAULTS = {
    driverJob: '{BIZ} JOB #{no} — {when}. PU: {pu}. DO: {do}.{stopsNote} {passenger}, {pax} pax, {vtype}. {fare} + tolls. {payType}.{notesNote} Reply Y to accept, N to pass.',
    booked: '{biz}: Your ride is booked for {when}. Pickup: {pu} → {do}. Est. {fare} + tolls. Conf #{no}. Reply C to cancel or call {phone}.',
    assigned: 'Your {biz} driver is {driver} in a {vehicle}{plateNote}{carNote}. Conf #{no}. Questions? Call {phone}.',
    onTheWay: '{driverFirst} is on the way to {pu}{carNote} ({vehicle}{plateNote}). Conf #{no}.',
    arrived: '{driverFirst} has arrived at {pu}{carNote} ({vehicle}{plateNote}). Please come out when ready.',
    receipt: 'Thanks for riding with {biz}! Total {total}{tollsNote}. Conf #{no}. Call {phone} to book your next ride.',
    reminder: 'Reminder: your {biz} ride is {dayWord}, {date} at {time} from {pu}. Reply C to cancel or call {phone}.',
    canceled: 'Your {biz} ride #{no} is canceled. Reply or call {phone} to rebook.'
  };
  var LABELS = { driverJob: 'driver job', booked: 'booked', assigned: 'assigned', onTheWay: 'on the way', arrived: 'arrived', receipt: 'receipt', reminder: 'reminder', canceled: 'canceled' };
  var PASSENGER_MENU = ['booked', 'assigned', 'onTheWay', 'arrived', 'receipt'];

  function templates() {
    var out = {}, user = settings().templates || {};
    Object.keys(DEFAULTS).forEach(function (k) { var u = user[k]; out[k] = (typeof u === 'string' && u.trim()) ? u : DEFAULTS[k]; });
    return out;
  }
  function tripVars(t) {
    t = findTrip(t) || {};
    var s = settings();
    var biz = (s.name || 'Skyway Car Service').trim();
    var d = findDriver(t.driverId), v = findVehicle(t, d);
    var today = todayStr(), tomorrow = addDays(today, 1);
    var time = fmtTime12(t.time) || 'ASAP', date = fmtDateLong(t.date);
    var dayWord = t.date === today ? 'today' : (t.date === tomorrow ? 'tomorrow' : (date ? 'on ' + date : ''));
    var when = t.date === today ? 'Today ' + time : (t.date === tomorrow ? 'Tomorrow ' + time : (date ? date + ', ' + time : time));
    var fare = Number(t.fare) || 0, tolls = Number(t.tolls) || 0, tip = Number(t.tip) || 0;
    var acct = t.accountId ? (((STATE.accounts || []).filter(function (a) { return a.id === t.accountId; })[0] || {}).name || 'Account') : '';
    var stops = (t.stops || []).filter(function (x) { return x; });
    var car = carLabel(d), plate = v && v.plate ? String(v.plate) : '';
    return {
      biz: biz, BIZ: biz.toUpperCase(), phone: s.phone || s.cphone || '',
      no: t.dispatchNo != null ? String(t.dispatchNo) : '', id: t.id || '',
      date: date, time: time, when: when, dayWord: dayWord,
      pu: shortAddr(t.puAddr), do: shortAddr(t.doAddr), puFull: t.puAddr || '', doFull: t.doAddr || '',
      stops: stops.map(shortAddr).join(', '), stopsNote: stops.length ? ' Stops: ' + stops.map(shortAddr).join(', ') + '.' : '',
      passenger: t.passenger || 'Passenger', passengerFirst: firstName(t.passenger) || 'there', paxPhone: t.phone || '',
      pax: String(Number(t.pax) || 1), vtype: t.vtype || 'any car',
      fare: money(fare), tolls: money(tolls), tip: money(tip), total: money(fare + tolls + tip),
      tollsNote: tolls > 0 ? ' (incl. ' + money(tolls) + ' tolls)' : '',
      payType: t.payType === 'Account' && acct ? 'Account: ' + acct : (t.payType || 'Cash'), account: acct,
      notes: t.notes || '', notesNote: t.notes ? ' Notes: ' + String(t.notes).trim() + '.' : '',
      driver: d ? d.name : 'your driver', driverFirst: d ? (firstName(d.name) || d.name) : 'Your driver', driverPhone: d ? (d.phone || '') : '',
      car: car, carNote: car ? ' in ' + car : '', vehicle: vehicleDesc(v, t) || 'car', plate: plate, plateNote: plate ? ', plate ' + plate : '',
      status: t.status || ''
    };
  }
  function fill(tpl, vars) {
    return String(tpl || '').replace(/\{([A-Za-z0-9_]+)\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : ''; })
      .replace(/[ \t]{2,}/g, ' ').replace(/ ([.,])/g, '$1').trim();
  }
  function render(key, trip) {
    var tps = templates(); if (!tps[key]) return '';
    return fill(tps[key], tripVars(trip));
  }

  /* ---------- recording sends ---------- */
  function markSent(trip, key, via) {
    var t = findTrip(trip); if (!t) return;
    t.sms = t.sms || {}; t.sms[key] = { at: new Date().toISOString(), via: via };
    save();
  }
  function sentChip(t) {
    t = findTrip(t); if (!t || !t.sms) return '';
    var ks = Object.keys(t.sms).filter(function (k) { return t.sms[k] && t.sms[k].at; });
    if (!ks.length) return '';
    ks.sort(function (a, b) { return (t.sms[a].at > t.sms[b].at) ? 1 : -1; });
    return '✓ texts: ' + ks.map(function (k) { return LABELS[k] || k; }).join(' · ');
  }

  /* ---------- sending ---------- */
  function sendTo(trip, key, phone, body, who) {
    var t = findTrip(trip);
    if (!body) { toast('Nothing to send — template is empty.', true); return false; }
    if (!normalizePhone(phone)) {
      copyText(body, function (ok) { toast(ok ? 'No ' + who + ' phone on file — message copied to clipboard.' : 'No ' + who + ' phone on file.', !ok); });
      if (t) markSent(t, key, 'copy');
      return false;
    }
    var ok = openHref(smsHref(phone, body));
    if (ok) { if (t) markSent(t, key, 'sms-link'); toast('Opening your Messages app — text to ' + who + ' is prefilled.'); }
    else { copyText(body, function (c) { toast(c ? 'Could not open Messages — text copied instead.' : 'Could not open Messages.', !c); }); if (t) markSent(t, key, 'copy'); }
    return ok;
  }
  function textDriverTo(tripId, driverId) {
    var t = findTrip(tripId); if (!t) return false;
    var d = findDriver(driverId); if (!d) { toast('Driver not found.', true); return false; }
    return sendTo(t, 'driverJob', d.phone, render('driverJob', t), d.name);
  }
  function textDriver(tripId, ev) {
    var t = findTrip(tripId); if (!t) { toast('Trip not found.', true); return false; }
    var d = findDriver(t.driverId);
    if (d) return textDriverTo(t.id, d.id);
    openDriverChooser(t, ev);
    return false;
  }
  function textPassenger(tripId, key, ev) {
    var t = findTrip(tripId); if (!t) { toast('Trip not found.', true); return false; }
    if (!key) { openMenu(ev || null, t.id, true); return false; }
    if (!DEFAULTS[key] || key === 'driverJob') { toast('Unknown template: ' + key, true); return false; }
    return sendTo(t, key, t.phone, render(key, t), t.passenger ? firstName(t.passenger) : 'passenger');
  }
  function copyJob(tripId) {
    var t = findTrip(tripId); if (!t) return;
    var body = render('driverJob', t);
    copyText(body, function (ok) { if (ok) markSent(t, 'driverJob', 'copy'); toast(ok ? 'Job text copied — paste it anywhere.' : 'Copy failed — select the text manually.', !ok); if (!ok) { try { window.prompt('Copy this text:', body); } catch (e) {} } });
  }

  /* ---------- floating menu ---------- */
  var MENU_ID = 'msgMenu', _menuTrip = null, _openedAt = 0;
  function ensureStyle() {
    if (byId('msgStyle')) return;
    var st = document.createElement('style'); st.id = 'msgStyle';
    st.textContent = [
      '.msg-menu{position:fixed;z-index:9500;min-width:240px;max-width:320px;background:var(--paper,#fff);color:var(--ink,#1f1f1f);border:1px solid var(--line,#cfd4da);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:6px;font-size:13px;line-height:1.35;font-family:inherit;}',
      '.msg-menu[hidden]{display:none;}',
      '.msg-menu .msg-h{font-size:11px;font-weight:700;color:var(--muted,#5b5b5b);padding:4px 10px 6px;border-bottom:1px solid var(--line-soft,#e4e4e4);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.msg-menu .msg-h b{color:var(--ink,#1f1f1f);}',
      '.msg-menu .mi{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;text-align:left;background:none;border:none;padding:7px 10px;cursor:pointer;color:inherit;font:inherit;border-radius:6px;}',
      '.msg-menu .mi:hover,.msg-menu .mi:focus{background:rgba(120,140,160,.14);outline:none;}',
      '.msg-menu .mi .k{font-size:11px;color:var(--muted,#5b5b5b);font-weight:400;}',
      '.msg-menu .mi.dim{opacity:.6;}',
      '.msg-menu .msg-sub{padding-left:12px;border-left:2px solid var(--line-soft,#e4e4e4);margin:2px 0 4px 12px;}',
      '.msg-menu .msg-sub[hidden]{display:none;}',
      '.msg-menu .msg-sep{height:1px;background:var(--line-soft,#e4e4e4);margin:4px 2px;}',
      '.msg-menu .msg-chip{display:inline-block;font-size:11px;color:#1f7a3d;background:rgba(33,115,70,.10);border-radius:10px;padding:1px 8px;margin:4px 8px 2px;}',
      '.msg-menu .msg-row{display:flex;gap:6px;padding:4px 8px 6px;flex-wrap:wrap;}',
      '.msg-menu .msg-row a{font-size:11px;color:var(--navy,#1f5fbf);text-decoration:none;border:1px solid var(--line,#cfd4da);border-radius:12px;padding:2px 9px;}',
      '.msg-menu .msg-row a:hover{background:rgba(120,140,160,.14);}',
      '.msg-btn{white-space:nowrap;}',
      'body.gold .msg-menu{background:#15171c;color:#e8e9ec;border-color:#2c3038;box-shadow:0 10px 28px rgba(0,0,0,.55);}',
      'body.gold .msg-menu .msg-chip{color:#8fd8a4;background:rgba(143,216,164,.12);}',
      'body.gold .msg-menu .msg-row a{color:#e8c75a;border-color:#3a3f49;}',
      'body.classic .msg-menu{background:#d4d0c8;color:#000;border:2px solid;border-color:#ffffff #808080 #808080 #ffffff;border-radius:0;box-shadow:2px 2px 0 #000;}',
      'body.classic .msg-menu .mi{border-radius:0;} body.classic .msg-menu .mi:hover{background:#0a246a;color:#fff;}',
      'body.screen-wallboard .msg-menu{background:#161616;color:#eaeaea;border-color:#333;}',
      '.msg-panel .msg-tpl{margin-bottom:10px;} .msg-panel textarea{min-height:58px;font-family:inherit;font-size:12.5px;}',
      '.msg-panel .msg-ph{font-family:Consolas,monospace;font-size:11px;line-height:1.7;}',
      '.msg-panel .msg-ph code{background:rgba(120,140,160,.14);padding:0 4px;border-radius:3px;margin-right:3px;white-space:nowrap;}',
      '.msg-panel .msg-prev{white-space:pre-wrap;font-size:12px;background:rgba(120,140,160,.08);border:1px dashed var(--line,#cfd4da);border-radius:6px;padding:8px 10px;margin-top:6px;}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  function ensureMenu() {
    ensureStyle();
    var m = byId(MENU_ID);
    if (m) return m;
    m = document.createElement('div'); m.id = MENU_ID; m.className = 'msg-menu'; m.hidden = true; m.setAttribute('role', 'menu');
    document.body.appendChild(m);
    document.addEventListener('mousedown', function (e) { var mm = byId(MENU_ID); if (!mm || mm.hidden) return; if (mm.contains(e.target)) return; if (e.target && e.target.closest && e.target.closest('.msg-btn')) return; closeMenu(); }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
    window.addEventListener('resize', closeMenu);
    document.addEventListener('scroll', function (e) { var mm = byId(MENU_ID); if (mm && !mm.hidden && !(mm.contains(e.target)) && (Date.now() - _openedAt) > 400) closeMenu(); }, true);
    return m;
  }
  function closeMenu() { var m = byId(MENU_ID); if (m) { m.hidden = true; m.innerHTML = ''; } _menuTrip = null; }
  function placeMenu(m, ev) {
    var x = 20, y = 20, el = null;
    try {
      if (ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect) el = ev.currentTarget;
      else if (ev && ev.target && ev.target.closest) el = ev.target.closest('button,a') || ev.target;
    } catch (e) { el = null; }
    if (el && el.getBoundingClientRect) { var r = el.getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
    else if (ev && typeof ev.clientX === 'number') { x = ev.clientX; y = ev.clientY; }
    m.style.left = '0px'; m.style.top = '0px'; m.hidden = false; _openedAt = Date.now();
    var w = m.offsetWidth || 260, h = m.offsetHeight || 200;
    if (x + w > window.innerWidth - 8) x = Math.max(8, window.innerWidth - w - 8);
    if (y + h > window.innerHeight - 8) y = Math.max(8, (el ? el.getBoundingClientRect().top - h - 4 : y - h));
    if (y < 8) y = 8;
    m.style.left = Math.round(x) + 'px'; m.style.top = Math.round(y) + 'px';
  }
  function act(fn) { return function () { try { fn.apply(null, arguments); } catch (e) { try { console.error(e); } catch (e2) {} } }; }
  function openMenu(ev, tripId, passengerOpen) {
    var t = findTrip(tripId); if (!t) { toast('Trip not found.', true); return; }
    try { if (ev && ev.stopPropagation) ev.stopPropagation(); } catch (e) {}
    var m = ensureMenu();
    if (!m.hidden && _menuTrip === t.id && !passengerOpen) { closeMenu(); return; }
    _menuTrip = t.id;
    var d = findDriver(t.driverId);
    var hdr = '<div class="msg-h"><b>#' + esc(t.dispatchNo) + '</b> ' + esc(t.passenger || 'Passenger') + (t.phone ? ' · ' + esc(t.phone) : ' · <i>no phone</i>') + '</div>';
    var h = hdr;
    h += '<button class="mi" type="button" data-act="driver">📱 Text driver (job)<span class="k">' + (d ? esc(firstName(d.name)) + (d.phone ? '' : ' · no phone') : 'choose driver ▸') + '</span></button>';
    h += '<button class="mi' + (t.phone ? '' : ' dim') + '" type="button" data-act="pass">💬 Text passenger<span class="k">▸</span></button>';
    h += '<div class="msg-sub" data-sub="pass"' + (passengerOpen ? '' : ' hidden') + '>' + PASSENGER_MENU.map(function (k) { return '<button class="mi" type="button" data-act="ptpl" data-key="' + k + '">' + esc(LABELS[k].charAt(0).toUpperCase() + LABELS[k].slice(1)) + (t.sms && t.sms[k] ? '<span class="k">✓ sent</span>' : '') + '</button>'; }).join('')
      + (t.status === 'Canceled' ? '<button class="mi" type="button" data-act="ptpl" data-key="canceled">Canceled' + (t.sms && t.sms.canceled ? '<span class="k">✓ sent</span>' : '') + '</button>' : '')
      + '<button class="mi" type="button" data-act="ptpl" data-key="reminder">Reminder' + (t.sms && t.sms.reminder ? '<span class="k">✓ sent</span>' : '') + '</button></div>';
    h += '<button class="mi" type="button" data-act="copy">📋 Copy job text</button>';
    h += '<div class="msg-sep"></div>';
    h += '<button class="mi" type="button" data-act="gmaps">🗺 Open in Maps<span class="k">' + esc(shortAddr(t.puAddr) || '?') + ' → ' + esc(shortAddr(t.doAddr) || '?') + '</span></button>';
    h += '<div class="msg-row"><a href="' + esc(appleMapsUrl(t.puAddr, t.doAddr)) + '" target="_blank" rel="noopener">Apple Maps</a><a href="' + esc(wazeUrl(t.puAddr)) + '" target="_blank" rel="noopener" title="Waze to the pickup">Waze → pickup</a><a href="' + esc(wazeUrl(t.doAddr)) + '" target="_blank" rel="noopener" title="Waze to the drop-off">Waze → drop-off</a></div>';
    var chip = sentChip(t); if (chip) h += '<div class="msg-chip">' + esc(chip) + '</div>';
    m.innerHTML = h;
    m.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', act(function (e) {
        e.stopPropagation();
        var a = b.getAttribute('data-act');
        if (a === 'driver') { if (d) { textDriverTo(t.id, d.id); closeMenu(); } else { openDriverChooser(t, e); } }
        else if (a === 'pass') { var sub = m.querySelector('[data-sub="pass"]'); if (sub) sub.hidden = !sub.hidden; }
        else if (a === 'ptpl') { textPassenger(t.id, b.getAttribute('data-key')); closeMenu(); }
        else if (a === 'copy') { copyJob(t.id); closeMenu(); }
        else if (a === 'gmaps') { try { window.open(mapsDirectionsUrl(t.puAddr, t.doAddr), '_blank', 'noopener'); } catch (e2) {} closeMenu(); }
      }));
    });
    placeMenu(m, ev);
  }
  function openDriverChooser(t, ev) {
    t = findTrip(t); if (!t) return;
    var m = ensureMenu(); _menuTrip = t.id;
    var ds = (STATE.drivers || []).filter(function (d) { return d.active !== false; });
    var h = '<div class="msg-h">Text job <b>#' + esc(t.dispatchNo) + '</b> to which driver?</div>';
    if (!ds.length) h += '<div class="mi dim">No active drivers — add them on the Fleet tab.</div>';
    h += ds.map(function (d) { return '<button class="mi" type="button" data-drv="' + esc(d.id) + '">' + esc(d.name) + '<span class="k">' + esc(carLabel(d) || '') + (d.phone ? (carLabel(d) ? ' · ' : '') + esc(d.phone) : ' · no phone') + '</span></button>'; }).join('');
    h += '<div class="msg-sep"></div><button class="mi" type="button" data-copy="1">📋 Copy job text instead</button>';
    m.innerHTML = h;
    m.querySelectorAll('[data-drv]').forEach(function (b) { b.addEventListener('click', act(function (e) { e.stopPropagation(); textDriverTo(t.id, b.getAttribute('data-drv')); closeMenu(); })); });
    var c = m.querySelector('[data-copy]'); if (c) c.addEventListener('click', act(function (e) { e.stopPropagation(); copyJob(t.id); closeMenu(); }));
    if (m.hidden || ev) placeMenu(m, ev); else { m.hidden = false; _openedAt = Date.now(); }
  }

  /* ---------- board integration: wrap sheetRow (also in pop-out boards) ---------- */
  function textBtnHtml(id) { return '<button class="btn btn-ghost btn-sm msg-btn" type="button" onclick="Messages.menu(event,\'' + id + '\')" title="Text the driver or passenger, copy the job, open in Maps">📱 Text</button> '; }
  if (typeof window.sheetRow === 'function' && !window.sheetRow._msgWrapped) {
    var _origSheetRow = window.sheetRow;
    var wrapped = function (t, now, leadMs, withDate, n) {
      var html = _origSheetRow.apply(this, arguments);
      try {
        if (t && t.id && typeof html === 'string') {
          var marker = '<td class="acts">', i = html.indexOf(marker);
          if (i >= 0) html = html.slice(0, i + marker.length) + textBtnHtml(t.id) + html.slice(i + marker.length);
        }
      } catch (e) {}
      return html;
    };
    wrapped._msgWrapped = true; wrapped._orig = _origSheetRow;
    window.sheetRow = wrapped;
  }

  /* ---------- Optimizer plan: a Text button per proposed assignment ---------- */
  function decorateOptPlan() {
    var host = byId('opt_plan'); if (!host) return;
    host.querySelectorAll('button[onclick*="optAssignOne("]').forEach(function (b) {
      if (b.parentNode && b.parentNode.querySelector('.msg-btn')) return;
      var m = String(b.getAttribute('onclick') || '').match(/optAssignOne\('([^']+)','([^']+)'\)/); if (!m) return;
      var tb = document.createElement('button'); tb.type = 'button'; tb.className = 'btn btn-ghost btn-sm msg-btn'; tb.textContent = '📱 Text'; tb.title = 'Text this job to the proposed driver';
      tb.style.marginLeft = '4px';
      var tripId = m[1], drvId = m[2];
      tb.addEventListener('click', act(function (e) { e.stopPropagation(); textDriverTo(tripId, drvId); }));
      b.parentNode.appendChild(tb);
    });
  }
  if (!POPOUT && typeof window.optRenderPlan === 'function' && !window.optRenderPlan._msgWrapped) {
    var _origOpt = window.optRenderPlan;
    var wOpt = function () { var r = _origOpt.apply(this, arguments); try { decorateOptPlan(); } catch (e) {} return r; };
    wOpt._msgWrapped = true; wOpt._orig = _origOpt; window.optRenderPlan = wOpt;
  }

  /* ---------- Driver IQ status table: a Text button per driver ---------- */
  function decorateDriverStatus() {
    var host = byId('diq_status'); if (!host) return;
    host.querySelectorAll('input[id^="setloc_"]').forEach(function (inp) {
      var cell = inp.parentNode; if (!cell || cell.querySelector('.msg-btn')) return;
      var id = inp.id.slice('setloc_'.length); var d = findDriver(id); if (!d) return;
      var tb = document.createElement('button'); tb.type = 'button'; tb.className = 'btn btn-ghost btn-sm msg-btn'; tb.textContent = '📱 Text'; tb.title = d.phone ? 'Text ' + d.name + ' (' + d.phone + ')' : 'No phone on file for ' + d.name; tb.style.marginLeft = '4px';
      tb.addEventListener('click', act(function (e) { e.stopPropagation(); if (!normalizePhone(d.phone)) { toast('No phone on file for ' + d.name + ' — add it on the Fleet tab.', true); return; } openHref(smsHref(d.phone, '')); }));
      cell.appendChild(tb);
    });
  }
  if (!POPOUT && typeof window.renderDriverStatus === 'function' && !window.renderDriverStatus._msgWrapped) {
    var _origDS = window.renderDriverStatus;
    var wDS = function () { var r = _origDS.apply(this, arguments); try { decorateDriverStatus(); } catch (e) {} return r; };
    wDS._msgWrapped = true; wDS._orig = _origDS; window.renderDriverStatus = wDS;
  }

  /* ---------- Settings panel: Messages — text templates ---------- */
  var PLACEHOLDERS = [
    ['{biz}', 'business name'], ['{BIZ}', 'business name, CAPS'], ['{phone}', 'business phone'], ['{no}', 'dispatch #'],
    ['{when}', 'Today 3:40 PM / Tue Nov 18, 3:40 PM'], ['{date}', 'Tue Nov 18'], ['{time}', '3:40 PM'], ['{dayWord}', 'today / tomorrow / on Tue Nov 18'],
    ['{pu}', 'pickup (short)'], ['{do}', 'drop-off (short)'], ['{puFull}', 'pickup, full'], ['{doFull}', 'drop-off, full'], ['{stopsNote}', '" Stops: …" or blank'],
    ['{passenger}', 'passenger'], ['{passengerFirst}', 'first name'], ['{paxPhone}', 'passenger phone'], ['{pax}', 'party size'], ['{vtype}', 'vehicle type'],
    ['{fare}', '$58.00'], ['{tolls}', 'tolls'], ['{tip}', 'tip'], ['{total}', 'fare+tolls+tip'], ['{tollsNote}', '" (incl. $5.50 tolls)" or blank'], ['{payType}', 'Cash / Credit Card / Account: name'],
    ['{notes}', 'notes'], ['{notesNote}', '" Notes: …" or blank'],
    ['{driver}', 'driver name'], ['{driverFirst}', 'driver first name'], ['{driverPhone}', 'driver phone'], ['{car}', 'Car 89'], ['{carNote}', '" in Car 89" or blank'],
    ['{vehicle}', 'black Toyota Camry'], ['{plate}', 'plate'], ['{plateNote}', '", plate T123456C" or blank']
  ];
  function sampleTrip() {
    var live = (STATE.trips || []).filter(function (t) { return t.status === 'Booked' || t.status === 'Dispatched'; })
      .sort(function (a, b) { return ((b.date || '') + (b.time || '')) > ((a.date || '') + (a.time || '')) ? 1 : -1; });
    if (live.length) return live[0];
    var d = (STATE.drivers || [])[0];
    return { dispatchNo: 4521, date: todayStr(), time: '15:40', puAddr: '77-35 164th St, Fresh Meadows, NY', doAddr: 'JFK Terminal 4, Jamaica, NY', passenger: 'John D.', phone: '(718) 555-0100', pax: 2, vtype: 'Sedan', fare: 58, tolls: 5.5, payType: 'Credit Card', driverId: d ? d.id : '', status: 'Booked' };
  }
  function renderSettingsPanel() {
    if (POPOUT) return;
    var view = byId('view-settings'); if (!view) return;
    ensureStyle();
    var panel = byId('msgTplPanel');
    if (!panel) { panel = document.createElement('div'); panel.id = 'msgTplPanel'; panel.className = 'panel msg-panel'; view.appendChild(panel); }
    var tps = templates(), user = settings().templates || {};
    var h = '<div class="panel-head">Messages — text templates <span class="hint" style="margin:0;text-transform:none;font-weight:400;letter-spacing:0;">sent from your phone via the 📱 Text button on every board row</span></div><div class="panel-body">';
    h += '<p class="hint" style="margin-top:0;">The <b>📱 Text</b> button on each trip opens your phone\'s Messages app with the text already filled in (one tap to send), or copies it. Edit the wording below; <span class="mono">{placeholders}</span> fill in from the trip, driver, vehicle and your company settings. Leave a box blank to go back to the default.</p>';
    h += '<div class="grid2">';
    TEMPLATE_META.forEach(function (m) {
      var custom = typeof user[m.key] === 'string' && user[m.key].trim() && user[m.key] !== DEFAULTS[m.key];
      h += '<div class="msg-tpl"><label class="fld"><span class="lbl">' + esc(m.label) + (custom ? ' <span style="color:#1f7a3d;">(customized)</span>' : '') + '</span><textarea id="msg_tpl_' + m.key + '" data-key="' + m.key + '" rows="3" spellcheck="true">' + esc(tps[m.key]) + '</textarea></label><div class="hint" style="margin:2px 0 0;">' + esc(m.when) + '</div></div>';
    });
    h += '</div>';
    h += '<div class="btn-row" style="margin-top:4px;"><button class="btn btn-go" type="button" id="msg_tpl_save">Save templates</button><button class="btn btn-ghost" type="button" id="msg_tpl_reset">Reset to defaults</button><button class="btn btn-navy" type="button" id="msg_tpl_preview">Preview with a real trip</button></div>';
    h += '<div id="msg_tpl_prev"></div>';
    h += '<details style="margin-top:10px;"><summary class="hint" style="cursor:pointer;margin:0;">Placeholders you can use</summary><div class="msg-ph">' + PLACEHOLDERS.map(function (p) { return '<code>' + esc(p[0]) + '</code>' + esc(p[1]); }).join(' &nbsp; ') + '</div></details>';
    h += '</div>';
    panel.innerHTML = h;
    var bs = byId('msg_tpl_save'), br = byId('msg_tpl_reset'), bp = byId('msg_tpl_preview');
    if (bs) bs.addEventListener('click', act(function () {
      var out = {};
      TEMPLATE_META.forEach(function (m) { var ta = byId('msg_tpl_' + m.key); var v = ta ? ta.value : ''; if (v && v.trim() && v !== DEFAULTS[m.key]) out[m.key] = v; });
      STATE.settings = STATE.settings || {};
      if (Object.keys(out).length) STATE.settings.templates = out; else delete STATE.settings.templates;
      if (typeof window.saveNow === 'function') { try { window.saveNow(); } catch (e) { save(); } } else save();
      toast('Text templates saved.'); renderSettingsPanel();
    }));
    if (br) br.addEventListener('click', act(function () {
      var hasCustom = !!(settings().templates && Object.keys(settings().templates).length);
      if (hasCustom && !window.confirm('Put all text templates back to the defaults?')) return;
      if (STATE.settings) delete STATE.settings.templates;
      if (typeof window.saveNow === 'function') { try { window.saveNow(); } catch (e) { save(); } } else save();
      toast('Text templates reset to defaults.'); renderSettingsPanel();
    }));
    if (bp) bp.addEventListener('click', act(function () {
      var t = sampleTrip(), host = byId('msg_tpl_prev'); if (!host) return;
      var saved = templates(), live = {};
      TEMPLATE_META.forEach(function (m) { var ta = byId('msg_tpl_' + m.key); live[m.key] = (ta && ta.value.trim()) ? ta.value : DEFAULTS[m.key]; });
      var vars = tripVars(t);
      host.innerHTML = '<div class="hint" style="margin:8px 0 0;">Preview using ' + (t.id ? 'trip <b>#' + esc(t.dispatchNo) + '</b>' : 'a sample trip') + ' (unsaved edits included):</div>'
        + TEMPLATE_META.map(function (m) { return '<div class="msg-prev"><b>' + esc(m.label) + '</b>\n' + esc(fill(live[m.key], vars)) + '</div>'; }).join('');
      void saved;
    }));
  }

  /* ---------- public API ---------- */
  window.Messages = {
    templates: templates, defaults: DEFAULTS, meta: TEMPLATE_META, labels: LABELS,
    vars: tripVars, render: render, fill: fill,
    smsHref: smsHref, normalizePhone: normalizePhone,
    textDriver: textDriver, textDriverTo: textDriverTo, textPassenger: textPassenger, copyJob: copyJob, copyText: copyText,
    mapsDirectionsUrl: mapsDirectionsUrl, appleMapsUrl: appleMapsUrl, wazeUrl: wazeUrl,
    menu: openMenu, closeMenu: closeMenu, sentChip: sentChip, markSent: markSent,
    renderSettings: renderSettingsPanel, fmtTime12: fmtTime12, fmtDateLong: fmtDateLong
  };

  /* ---------- boot ---------- */
  function boot() {
    try { ensureStyle(); } catch (e) {}
    if (POPOUT) return;              // pop-out boards only get the row button + menu
    try { renderSettingsPanel(); } catch (e) {}
    try { decorateOptPlan(); } catch (e) {}
    try { decorateDriverStatus(); } catch (e) {}
    // Board rows already on screen were rendered before this file loaded: repaint once.
    try { if (typeof window.refreshBoard === 'function' && byId('activeBoard')) window.refreshBoard(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
