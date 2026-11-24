/* ======================================================================
   Skyway — callerhist.js
   Caller history drop-down: when a person calls, their past trips drop down
   under the phone field and one click places the trip again.

   Trigger points (all wrapped, never replaced):
     - an F-line number (cidSet) -> drop-down under that F-line row, with a
       "Book" button that opens the form and keeps the drop-down;
     - the F-key / "New job" that opens a job from a line (openCallerPopout),
       the Calls panel / Needs-you "Book" (ops.js calls openCallerPopout) ->
       opens the Book form for the number and drops the list under the phone;
     - applyCaller (the ?caller= screen-pop, the crm.js worklist "Book", the
       Caller lookup button) -> drop-down under the phone field;
     - typing or leaving #d_phone / #d_caller with 10 digits;
     - the Caller-ID pop-out (?screen=callerid): the same list renders inline
       under the caller card; a click sends the trip to the main console.

   Content: header (name · phone · N trips · last date, account chip, CRM
   do-not-call / do-not-text / STOP flags, consent chip), USUAL routes (top
   5 by count over settings.callerHist.months, typical time / fare / vehicle /
   pay / driver, routebook price) and RECENT trips (last settings.callerHist.
   recent). Sources: STATE.trips (not Disregard), the IndexedDB call archive
   through the console's histLoadMem() (async: STATE rows paint first, the
   archive rows are merged when they arrive, deduped by date+time+addresses),
   CALLERBOOK (usual addresses) and the route book (learned price).

   Actions: click a row / Enter = fill the whole Book form as a NEW trip and
   re-price it through the engine (maybeAutoFare, Quote.refresh, Tolls.
   refreshForm when present), "Return trip" swaps the ends, "Same, different
   drop-off" leaves #d_doAddr empty and focused. A chip names the source trip
   and offers Undo fill. Hotkeys while open: Enter, R, D, Esc, Down / Up.
   No driver is ever assigned here; the fare goes through the form, so the
   quote.js deviation gate and ops.js eligibility still apply on Save.

   Safety: hotkeys act only while focus is in the drop-down or in the phone box it hangs under
   (same number); Enter on an F-line stays the console's "open the job" key. Opening a new
   caller over a half-typed booking or an unsaved edit sets that booking aside ("Bring it back"
   in the chip, kept through the next Save, dropped by Clear). Later-day reservations show as
   "Booked ahead", never as "last" or in USUAL. Without a toll engine a return trip starts at
   $0 tolls. A pop-out click fills one main window: the one used last.

   STATE keys owned here: settings.callerHist {enabled, months, recent}.
   Nothing else is written to STATE; localStorage 'skyway_callerhist_main' holds the id of
   the main window used last and 'skyway_callerhist_mains' the open main windows, last used
   first (pop-out target only).
   Public API: window.CallerHist = {show, hide, listFor, fill, _loaded}.
   Plain ES2019, no build step, no network of its own. Never edits index.html.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;
  if (window.CallerHist && window.CallerHist._loaded) return;

  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }

  /* ---------- helpers (own copies; console globals may be missing) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } }
  function log(e) { try { console.warn('[callerhist]', e); } catch (e2) {} }
  function g(name) { return typeof window[name] === 'function' ? window[name] : null; }
  function call(name) { var f = g(name); if (!f) return undefined; try { return f.apply(null, Array.prototype.slice.call(arguments, 1)); } catch (e) { log(e); } return undefined; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function digits(s) { return String(s == null ? '' : s).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function keyOf(s) { var d = digits(s); return d.length >= 10 ? d.slice(-10) : ''; }
  function fmtPhone(s) { var k = keyOf(s); return k ? '(' + k.slice(0, 3) + ') ' + k.slice(3, 6) + '-' + k.slice(6) : String(s || ''); }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fmtDate(s) { s = String(s || ''); var p = s.split('-'); return p.length === 3 ? p[1] + '/' + p[2] + '/' + p[0] : s; }
  function mil(t) { t = String(t || '').trim(); var f = g('mil'); if (f) { try { return f(t) || t; } catch (e) {} } return t; }
  function h12(t) { t = String(t || '').trim(); var m = t.match(/^(\d{1,2}):(\d{2})/); if (!m) return t || 'ASAP'; var h = +m[1], mi = m[2], ap = h >= 12 ? 'pm' : 'am'; h = h % 12; if (h === 0) h = 12; return h + ':' + mi + ap; }
  function short(a) { return String(a || '').split(',')[0].trim(); }
  /* one spelling per street, so "9 PARK PLACE GREAT NECK", "9 PARK PL" and "161-30-JEWEL AVE QUEENS"
     group with their twins: suffixes shortened, the town / borough after the street suffix dropped */
  var SUFFIX = { PLACE: 'PL', AVENUE: 'AVE', AV: 'AVE', STREET: 'ST', ROAD: 'RD', BOULEVARD: 'BLVD', DRIVE: 'DR', LANE: 'LN', PARKWAY: 'PKWY', TURNPIKE: 'TPKE', EXPRESSWAY: 'EXPY', COURT: 'CT', TERRACE: 'TER', HIGHWAY: 'HWY', CIRCLE: 'CIR' };
  var SUFFIX_END = /^(PL|AVE|ST|RD|BLVD|DR|LN|PKWY|TPKE|EXPY|CT|TER|HWY|CIR|WAY|SQ|LOOP)$/;
  var normCache = new Map();
  function normAddr(a) {
    var raw = String(a == null ? '' : a);
    var hit = normCache.get(raw); if (hit !== undefined) return hit;
    var s = raw;
    var fa = g('fixAddr'); if (fa && s) { try { s = fa(s) || s; } catch (e) {} }
    s = short(s).toUpperCase().replace(/(\d)-(?=[A-Z])/g, '$1 ').replace(/[^A-Z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
    var w = s.split(' ').map(function (x) { return SUFFIX[x] || x; });
    if (w.length > 2 && /^\d/.test(w[0])) {
      for (var i = 2; i < w.length; i++) if (SUFFIX_END.test(w[i])) { w = w.slice(0, i + 1); break; }
    }
    s = w.join(' ');
    if (normCache.size > 20000) normCache.clear();
    normCache.set(raw, s);
    return s;
  }
  function whole(n) { return Math.round(Number(n) || 0); }
  function money0(n) { return '$' + whole(n); }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  function trips() { return Array.isArray(STATE.trips) ? STATE.trips : []; }
  function visible(el) { if (!el || !el.isConnected) return false; if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function mode(arr) { var c = {}, best = null, bn = 0; arr.forEach(function (v) { if (v === '' || v == null) return; c[v] = (c[v] || 0) + 1; if (c[v] > bn) { bn = c[v]; best = v; } }); return best; }
  function median(arr) { var a = arr.filter(function (x) { return x > 0; }).sort(function (x, y) { return x - y; }); if (!a.length) return 0; return a[Math.floor(a.length / 2)]; }
  function copyFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_{1,2}\w*Wrapped$/.test(k) && w[k] === undefined) w[k] = orig[k]; }); } catch (e) {} return w; }
  function wrap(name, maker) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig._chWrapped) return false;
    var w = maker(orig);
    w._chWrapped = true; w._orig = orig;
    copyFlags(w, orig);
    window[name] = w;
    return true;
  }

  /* ---------- settings (repaired on load; idempotent) ---------- */
  function cfg() {
    var s = settings();
    var c = s.callerHist;
    if (!c || typeof c !== 'object' || Array.isArray(c)) { c = s.callerHist = { enabled: true, months: 24, recent: 15 }; }
    if (typeof c.enabled !== 'boolean') c.enabled = true;
    var m = Number(c.months); if (!(m >= 1 && m <= 120)) c.months = 24; else c.months = Math.round(m);
    var r = Number(c.recent); if (!(r >= 3 && r <= 100)) c.recent = 15; else c.recent = Math.round(r);
    return c;
  }
  try { cfg(); } catch (e) { log(e); }
  function on() { try { return cfg().enabled !== false; } catch (e) { return true; } }

  /* ---------- index: phone key -> STATE trips (rebuilt lazily after a save) ---------- */
  var idx = null, idxArr = null, idxLen = -1, idxDirty = true;
  function markDirty() { idxDirty = true; }
  function index() {
    var arr = trips();
    if (idx && !idxDirty && idxArr === arr && idxLen === arr.length) return idx;
    var m = new Map();
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i]; if (!t || typeof t !== 'object') continue;
      var k = keyOf(t.phone); if (!k) continue;
      var l = m.get(k); if (!l) { l = []; m.set(k, l); } l.push(t);
    }
    idx = m; idxArr = arr; idxLen = arr.length; idxDirty = false;
    return m;
  }
  ['save', 'saveNow'].forEach(function (n) {
    wrap(n, function (orig) { return function () { idxDirty = true; return orig.apply(this, arguments); }; });
  });
  try { if (typeof SkyBus !== 'undefined' && SkyBus && typeof SkyBus.on === 'function') SkyBus.on(function (msg) { if (msg && msg.type === 'state') idxDirty = true; }); } catch (e) {}

  /* ---------- archive (IndexedDB through the console's histLoadMem) ---------- */
  var arch = { src: null, map: null, loading: null, failed: false, hc: null };
  function histNow() { try { return (typeof HISTCALLS !== 'undefined') ? HISTCALLS : null; } catch (e) { return null; } }
  /* the History tab sets HISTCALLS = null after an import or a clear: drop our copy so the next show reloads it */
  function archStale() {
    if (!arch.map || arch.loading) return;
    var hc = histNow();
    if (hc !== arch.hc) { arch.map = null; arch.src = null; arch.failed = false; arch.hc = null; }
  }
  function archFor(k) { archStale(); return (arch.map && arch.map.get(k)) || []; }
  function loadArchive() {
    if (arch.loading) return arch.loading;
    var f = g('histLoadMem');
    if (!f) return Promise.resolve(null);
    var p;
    try { p = Promise.resolve(f()); } catch (e) { return Promise.resolve(null); }
    arch.loading = p.then(function (all) {
      if (!Array.isArray(all)) all = [];
      if (all !== arch.src) {
        var m = new Map();
        for (var i = 0; i < all.length; i++) {
          var r = all[i]; if (!r || typeof r !== 'object') continue;
          var k = keyOf(r.p); if (!k) continue;
          var l = m.get(k); if (!l) { l = []; m.set(k, l); } l.push(r);
        }
        arch.src = all; arch.map = m;
      }
      arch.hc = histNow();
      arch.loading = null;
      return arch.map;
    }, function () { arch.loading = null; arch.failed = true; return null; });
    return arch.loading;
  }

  /* ---------- names, accounts, flags ---------- */
  function account(id) { var a = Array.isArray(STATE.accounts) ? STATE.accounts : []; for (var i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return a[i]; return null; }
  function acctForPhone(k) { var a = Array.isArray(STATE.accounts) ? STATE.accounts : []; for (var i = 0; i < a.length; i++) if (a[i] && keyOf(a[i].phone) === k) return a[i]; return null; }
  function driverName(id) { var d = Array.isArray(STATE.drivers) ? STATE.drivers : []; for (var i = 0; i < d.length; i++) if (d[i] && d[i].id === id) return d[i].name || ''; return ''; }
  function driverByCar(no) { var c = String(no || '').replace(/\D/g, ''); if (!c) return ''; var d = Array.isArray(STATE.drivers) ? STATE.drivers : []; for (var i = 0; i < d.length; i++) { var x = d[i]; if (x && x.carNo && String(x.carNo).replace(/\D/g, '').replace(/^0+/, '') === c.replace(/^0+/, '')) return x.name || ''; } return 'car ' + c; }
  function known(k) { try { if (typeof lookupCaller === 'function') return lookupCaller(k) || null; } catch (e) {} return null; }
  function customer(k) {
    try { if (window.CRM && typeof window.CRM.customer === 'function') return window.CRM.customer(k) || null; } catch (e) {}
    var list = Array.isArray(STATE.customers) ? STATE.customers : [];
    for (var i = 0; i < list.length; i++) { var c = list[i]; if (c && (c.phoneKey === k || keyOf(c.phone) === k)) return c; }
    return null;
  }
  function flagsFor(k) {
    var out = [], c = customer(k);
    var cb = null, tb = null;
    try { if (window.CRM && typeof window.CRM.callBlock === 'function') cb = window.CRM.callBlock(k); } catch (e) {}
    try { if (window.CRM && typeof window.CRM.textBlock === 'function') tb = window.CRM.textBlock(k); } catch (e) {}
    if (!cb && c && c.suppressCall) cb = { kind: 'suppressed', reason: 'Do not call' };
    if (!tb && c && c.suppressText) tb = { kind: 'suppressed', reason: 'Do not text' };
    if (!tb && c && c.smsOptOut) tb = { kind: 'optout', reason: 'Replied STOP' };
    if (cb) out.push({ cls: 'bad', label: 'DO NOT CALL', title: cb.reason });
    if (tb) out.push({ cls: tb.kind === 'optout' ? 'warn' : 'bad', label: tb.kind === 'optout' ? 'STOP — no texts' : 'DO NOT TEXT', title: tb.reason });
    if (c && c.smsConsentInformational && !tb) out.push({ cls: 'ok', label: 'Texts OK', title: 'Ride-update consent on file' });
    return out;
  }
  function payLabel(t) {
    if (!t) return '';
    if (t.accountId) { var a = account(t.accountId); return a ? '#' + a.number + ' ' + a.name : 'Account'; }
    return t.payType || '';
  }
  function payValue(t) {
    if (!t) return '';
    if (t.accountId && account(t.accountId)) return t.accountId;
    if (t.payType === 'Credit Card') return 'card';
    if (t.payType === 'Cash') return 'cash';
    return '';
  }

  /* ---------- the list ---------- */
  var ARCH_ST = { A: 'Dispatched', D: 'Completed', C: 'Canceled', N: 'No-Show', X: 'Disregard' };
  function rowFromTrip(t) {
    return {
      src: 'trip', id: t.id, no: t.dispatchNo, date: String(t.date || (t.createdAt ? String(t.createdAt).slice(0, 10) : '')), time: mil(t.time || ''),
      pu: String(t.puAddr || ''), dropoff: String(t.doAddr || ''), stops: Array.isArray(t.stops) ? t.stops.filter(function (s) { return s && s.addr; }).map(function (s) { return { addr: String(s.addr) }; }) : [],
      fare: Number(t.fare) || 0, tolls: Number(t.tolls) || 0, pay: payLabel(t), payValue: payValue(t), payType: t.payType || '', accountId: t.accountId || '',
      driver: driverName(t.driverId), driverId: t.driverId || '', vtype: t.vtype || '', pax: Number(t.pax) || 1,
      status: t.status || '', notes: String(t.notes || ''), passenger: String(t.passenger || ''), phone: String(t.phone || ''), createdAt: t.createdAt || ''
    };
  }
  function rowFromArch(r) {
    var st = String(r.s || '').trim().toUpperCase();
    var xo = String(r.xo || ''), fare = 0, m = xo.match(/\$\s*(\d+(?:\.\d+)?)/);
    if (m) { fare = Number(m[1]) || 0; xo = xo.replace(/\s*\$\s*\d+(?:\.\d+)?/, '').trim(); }
    return {
      src: 'archive', id: '', no: String(r.n || ''), date: String(r.d || ''), time: mil(r.t || ''),
      pu: String(r.pu || ''), dropoff: xo, stops: [], fare: fare, tolls: 0, pay: '', payValue: '', payType: '', accountId: '',
      driver: r.dr ? driverByCar(r.dr) : '', driverId: '', vtype: '', pax: 1,
      status: ARCH_ST[st] || (st ? st : ''), notes: '', passenger: '', phone: String(r.p || ''), createdAt: ''
    };
  }
  function dedupeKey(r) { return r.date + '|' + (r.time || '').slice(0, 5) + '|' + normAddr(r.pu) + '|' + normAddr(r.dropoff); }
  function sortKey(r) { return (r.date || '') + ' ' + (/^\d{1,2}:\d{2}/.test(r.time) ? pad2(r.time.split(':')[0]) + ':' + r.time.split(':')[1].slice(0, 2) : '00:00') + ' ' + (r.createdAt || ''); }
  function cutoff(months) { var d = new Date(); d.setMonth(d.getMonth() - months); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  function listFor(phone) {
    var k = keyOf(phone);
    var out = { phone: k ? fmtPhone(k) : String(phone || ''), key: k, name: '', acct: null, flags: [], usual: [], usualAll: [], ahead: [], aheadAll: [], recent: [], all: [], total: 0, last: '', archivePending: false, known: null };
    if (!k) return out;
    var c = cfg();
    var rows = [], seen = {};
    (index().get(k) || []).forEach(function (t) {
      if (!t || t.status === 'Disregard') return;
      var r = rowFromTrip(t), dk = dedupeKey(r); if (seen[dk]) return; seen[dk] = 1; rows.push(r);
    });
    archFor(k).forEach(function (a) {
      var r = rowFromArch(a); if (r.status === 'Disregard') return;
      var dk = dedupeKey(r); if (seen[dk]) return; seen[dk] = 1; rows.push(r);
    });
    out.archivePending = !arch.map && !arch.failed && !!g('histLoadMem');
    rows.sort(function (a, b) { var x = sortKey(a), y = sortKey(b); return x < y ? 1 : (x > y ? -1 : 0); });
    /* reservations on a later day are "booked ahead": shown on their own, never as "last" or in USUAL */
    var today = todayStr(), ahead = [], past = [];
    rows.forEach(function (r) { if (r.date && r.date > today && !/^(Canceled|No-Show|Disregard|Completed)$/.test(r.status)) { r.ahead = true; ahead.push(r); } else past.push(r); });
    ahead.reverse();   // soonest first
    rows = past;
    out.ahead = ahead.slice(0, 3);
    out.aheadAll = ahead;
    out.all = rows;
    out.recent = rows.slice(0, c.recent);
    out.total = rows.length + ahead.length;
    out.last = rows.length ? rows[0].date : '';
    var acct = acctForPhone(k); out.acct = acct ? { id: acct.id, number: acct.number, name: acct.name } : null;
    var cu = customer(k), kn = known(k); out.known = kn;
    var named = rows.concat(ahead).filter(function (r) { return r.passenger; })[0];
    out.name = (cu && cu.name) || (named && named.passenger) || (acct && acct.name) || '';
    out.flags = flagsFor(k);
    if (kn && Number(kn.n) > out.total) { out.total = Number(kn.n); if (!out.last && kn.last) out.last = String(kn.last); }
    /* usual: routes with 2+ trips inside the window, ranked by count then recency */
    var from = cutoff(c.months), groups = {};
    rows.forEach(function (r) {
      if (!r.pu || !r.dropoff) return;
      if (r.date && r.date < from) return;
      if (/^(Canceled|No-Show|Disregard)$/.test(r.status)) return;
      var gk = normAddr(r.pu) + '>>' + normAddr(r.dropoff);
      var gr = groups[gk] || (groups[gk] = { rows: [] }); gr.rows.push(r);
    });
    var usual = Object.keys(groups).map(function (gk) {
      var rs = groups[gk].rows, top = rs[0];   // rows are newest first
      var tmpl = rs.filter(function (r) { return r.src === 'trip'; })[0] || top;
      var times = rs.map(function (r) { var m = String(r.time || '').match(/^(\d{1,2}):(\d{2})/); if (!m) return ''; var mins = Math.round((+m[1] * 60 + +m[2]) / 15) * 15; return pad2(Math.floor(mins / 60) % 24) + ':' + pad2(mins % 60); });
      var book = null;
      try { if (typeof routeFare === 'function') book = routeFare(tmpl.pu, tmpl.dropoff, []); } catch (e) { book = null; }
      return {
        usual: true, count: rs.length, lastDate: top.date, pu: tmpl.pu, dropoff: tmpl.dropoff, stops: tmpl.stops,
        time: mode(times) || '', fare: median(rs.map(function (r) { return r.fare; })), bookFare: book && book.fare ? Number(book.fare) : 0,
        vtype: mode(rs.map(function (r) { return r.vtype; })) || tmpl.vtype || '',
        pay: mode(rs.map(function (r) { return r.pay; })) || '', payValue: mode(rs.map(function (r) { return r.payValue; })) || tmpl.payValue || '',
        driver: mode(rs.map(function (r) { return r.driver; })) || '',
        pax: tmpl.pax, notes: tmpl.notes, passenger: tmpl.passenger, phone: tmpl.phone, tolls: tmpl.tolls,
        no: tmpl.no, id: tmpl.id, date: tmpl.date, src: tmpl.src
      };
    }).filter(function (u) { return u.count >= 2; })
      .sort(function (a, b) { return b.count - a.count || (a.lastDate < b.lastDate ? 1 : (a.lastDate > b.lastDate ? -1 : 0)); });
    if (!usual.length && kn && kn.pu) {
      usual.push({ usual: true, count: Number(kn.n) || 0, lastDate: String(kn.last || ''), pu: String(kn.pu), dropoff: String(kn.do || ''), stops: [], time: '', fare: Number(kn.f) || 0, bookFare: 0, vtype: '', pay: '', payValue: '', driver: '', pax: 1, notes: '', passenger: out.name, phone: k, tolls: 0, no: '', id: '', date: String(kn.last || ''), src: 'callerbook' });
    }
    out.usualAll = usual;
    out.usual = usual.slice(0, 5);
    return out;
  }

  /* ---------- rendering ---------- */
  var cur = null;          // {key, anchorFn, data, sel, expanded, inline, host}
  var drop = null;         // the floating .ch-drop element
  var dismissed = '';      // key the dispatcher closed with Esc / outside click (reopens on the next number)

  function chipsHTML(d) {
    var h = '';
    if (d.acct) h += '<span class="ch-chip ch-acct" title="Account">#' + esc(d.acct.number) + ' ' + esc(d.acct.name) + '</span>';
    d.flags.forEach(function (f) { h += '<span class="ch-chip ch-' + f.cls + '" title="' + esc(f.title || '') + '">' + esc(f.label) + '</span>'; });
    return h;
  }
  function rowActs(i) {
    return '<span class="ch-acts">'
      + '<button type="button" class="btn btn-go btn-sm" data-ch="book" data-i="' + i + '" title="Fill the form with this trip (Enter)">Book this</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-ch="return" data-i="' + i + '" title="Pickup and drop-off swapped (R)">Return trip</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-ch="newdrop" data-i="' + i + '" title="Same pickup, type a new drop-off (D)">Same, different drop-off</button>'
      + '</span>';
  }
  function bodyHTML(d, st) {
    var h = '';
    var name = d.name || 'Unknown';
    h += '<div class="ch-head"><b>' + esc(name) + '</b> · <span class="mono">' + esc(d.phone) + '</span>';
    if (d.total) h += ' · ' + d.total.toLocaleString() + ' trip' + (d.total === 1 ? '' : 's') + (d.last ? ' · last ' + esc(fmtDate(d.last)) : '');
    h += ' ' + chipsHTML(d);
    if (!st.inline) h += '<button type="button" class="ch-x" data-ch="close" title="Close (Esc)" aria-label="Close">&times;</button>';
    h += '</div>';
    if (st.banner) h += '<div class="ch-crm">' + st.banner + '</div>';
    if (!d.total && !d.usual.length && !d.ahead.length && !d.archivePending) {
      h += '<div class="ch-new"><b>New caller — no history.</b> Fill the form and press Book Trip; the number is kept as a customer for next time.</div>';
      if (st.bookBtn) h += '<div class="ch-foot"><button type="button" class="btn btn-go btn-sm" data-ch="open">Book</button></div>';
      return h;
    }
    if (d.usual.length) {
      var u0 = d.usual[0];
      h += '<div class="ch-sum">Usual: ' + esc(short(u0.pu)) + ' → ' + esc(short(u0.dropoff)) + ' (' + u0.count + '×' + (u0.time ? ', about ' + esc(h12(u0.time)) : '') + ')</div>';
    }
    var n = 0;
    var uN = st.expanded ? d.usualAll.slice(0, 10) : d.usual;
    if (uN.length) {
      h += '<div class="ch-grp">Usual</div>';
      uN.forEach(function (u) {
        var i = n++;
        h += '<div class="ch-row ch-usual' + (i === st.sel ? ' sel' : '') + '" data-i="' + i + '" role="option">'
          + '<div class="ch-main"><b class="ch-n">' + u.count + '×</b> ' + esc(short(u.pu)) + ' → ' + esc(short(u.dropoff))
          + '<span class="ch-meta">' + [u.time ? 'usually ' + h12(u.time) : '', u.fare ? 'fare ' + money0(u.fare) : '', u.bookFare ? 'book ' + money0(u.bookFare) : '', u.vtype, u.pay, u.driver ? 'drv ' + u.driver : ''].filter(Boolean).map(esc).join(' · ') + '</span></div>'
          + rowActs(i) + '</div>';
      });
    }
    var aN = st.expanded ? d.aheadAll.slice(0, 20) : d.ahead;
    if (aN.length) {
      h += '<div class="ch-grp">Booked ahead</div>';
      aN.forEach(function (r) {
        var i = n++;
        h += '<div class="ch-row ch-ahead' + (i === st.sel ? ' sel' : '') + '" data-i="' + i + '" role="option">'
          + '<div class="ch-main"><span class="mono">' + esc(fmtDate(r.date)) + ' ' + esc(r.time ? h12(r.time) : '') + '</span> ' + esc(short(r.pu)) + ' → ' + esc(short(r.dropoff) || '—')
          + '<span class="ch-meta">' + [r.no ? '#' + r.no : '', r.fare ? money0(r.fare) : '', r.pay, r.driver ? 'drv ' + r.driver : '', r.vtype, r.status].filter(Boolean).map(esc).join(' · ') + '</span></div>'
          + rowActs(i) + '</div>';
      });
    }
    var rN = st.expanded ? d.all.slice(0, 200) : d.recent;
    if (rN.length) {
      h += '<div class="ch-grp">Recent</div>';
      rN.forEach(function (r) {
        var i = n++;
        h += '<div class="ch-row' + (i === st.sel ? ' sel' : '') + (r.src === 'archive' ? ' ch-arch' : '') + '" data-i="' + i + '" role="option">'
          + '<div class="ch-main"><span class="mono">' + esc(fmtDate(r.date)) + ' ' + esc(r.time ? h12(r.time) : '') + '</span> ' + esc(short(r.pu)) + ' → ' + esc(short(r.dropoff) || '—')
          + '<span class="ch-meta">' + [r.no ? '#' + r.no : '', r.fare ? money0(r.fare) : '', r.pay, r.driver ? 'drv ' + r.driver : '', r.vtype, r.status, r.notes ? '“' + r.notes.slice(0, 40) + (r.notes.length > 40 ? '…' : '') + '”' : '', r.src === 'archive' ? 'archive' : ''].filter(Boolean).map(esc).join(' · ') + '</span></div>'
          + rowActs(i) + '</div>';
      });
    }
    if (d.archivePending) h += '<div class="ch-hint">Searching the call archive…</div>';
    var more = (d.all.length > d.recent.length) || (d.usualAll.length > d.usual.length) || (d.aheadAll.length > d.ahead.length);
    h += '<div class="ch-foot">'
      + (st.bookBtn ? '<button type="button" class="btn btn-go btn-sm" data-ch="open">Book</button> ' : '')
      + (more ? '<button type="button" class="btn btn-ghost btn-sm" data-ch="all">' + (st.expanded ? 'Show less' : 'Show all (' + d.all.length + ')') + '</button> ' : '')
      + (st.inline ? '' : '<span class="ch-hint">Enter = book · R = return · D = new drop-off · ↑↓ move · Esc close</span>')
      + '</div>';
    return h;
  }
  function rowsShown(d, st) {
    var u = st.expanded ? d.usualAll.slice(0, 10) : d.usual;
    var a = st.expanded ? d.aheadAll.slice(0, 20) : d.ahead;
    var r = st.expanded ? d.all.slice(0, 200) : d.recent;
    return u.concat(a, r);
  }
  /* the row Enter books by default: the top usual, else the latest past trip. A booked-ahead
     reservation is never the default (Enter + Book Trip would book it twice): the dispatcher
     picks it with the arrows or a click, and the fill says it is already booked. */
  function defaultSel(d, st) {
    var u = st.expanded ? d.usualAll.slice(0, 10) : d.usual, a = st.expanded ? d.aheadAll.slice(0, 20) : d.ahead, r = st.expanded ? d.all.slice(0, 200) : d.recent;
    if (u.length) return 0;
    if (r.length) return a.length;
    return -1;
  }

  function ensureDrop() {
    if (drop && drop.isConnected) return drop;
    drop = document.createElement('div');
    drop.className = 'ch-drop'; drop.setAttribute('role', 'listbox'); drop.tabIndex = -1;
    drop.hidden = true;
    drop.addEventListener('mousedown', function (e) { if (e.target && e.target.closest && e.target.closest('button,.ch-row')) e.preventDefault(); });
    drop.addEventListener('click', onDropClick);
    document.body.appendChild(drop);
    return drop;
  }
  function paint() {
    if (!cur) return;
    var el = cur.inline ? cur.host : ensureDrop();
    if (!el) return;
    el.innerHTML = bodyHTML(cur.data, cur);
    if (!cur.inline) { el.hidden = false; position(); }
  }
  function position() {
    if (!cur || cur.inline || !drop || drop.hidden) return;
    var a = null; try { a = cur.anchorFn(); } catch (e) { a = null; }
    if (!a || !visible(a)) { drop.style.visibility = 'hidden'; return; }
    drop.style.visibility = '';
    var r = a.getBoundingClientRect(), vw = document.documentElement.clientWidth || window.innerWidth, vh = window.innerHeight;
    var w = Math.min(Math.max(r.width, 620), vw - 16);
    var left = Math.min(Math.max(8, r.left), vw - w - 8);
    drop.style.width = w + 'px'; drop.style.maxHeight = '';
    var natural = Math.min(drop.scrollHeight, Math.round(vh * 0.6));
    var below = vh - r.bottom - 8, above = r.top - 8;
    var save = byId('d_save'), limitBelow = below;
    if (save && visible(save)) {
      var s = save.getBoundingClientRect();
      var overlapX = s.right > left && s.left < left + w;
      if (overlapX && s.top > r.bottom) limitBelow = Math.min(below, s.top - r.bottom - 6);
    }
    var top, maxH;
    if (natural <= limitBelow) { top = r.bottom + 2; maxH = natural; }
    else if (natural <= above) { top = r.top - natural - 2; maxH = natural; }
    else if (limitBelow >= 180 || limitBelow >= above) { top = r.bottom + 2; maxH = Math.max(120, limitBelow); }
    else { maxH = above; top = r.top - above - 2; }
    drop.style.maxHeight = Math.max(120, Math.floor(maxH)) + 'px';
    drop.style.left = (left + window.scrollX) + 'px';
    drop.style.top = (Math.max(4, top) + window.scrollY) + 'px';
    drop.classList.toggle('ch-up', top < r.top);
  }

  function phoneAnchor() { return byId('d_phone'); }
  function formVisible() { return visible(byId('d_phone')); }
  function lineAnchorFn(i) { return function () { var ins = document.querySelectorAll('#cid_lines .cid-in'); var inp = ins[i]; return inp ? (inp.closest('.cid-row') || inp) : null; }; }

  function show(phone, anchorEl, opts) {
    opts = opts || {};
    if (POPOUT && !opts.inline) return null;
    if (!on()) return null;
    var k = keyOf(phone); if (!k) { hide(); return null; }
    var d = listFor(k);
    var anchorFn;
    if (typeof anchorEl === 'function') anchorFn = anchorEl;
    else if (anchorEl && anchorEl.nodeType === 1) anchorFn = function () { return anchorEl.isConnected ? anchorEl : phoneAnchor(); };
    else anchorFn = phoneAnchor;
    var same = cur && !cur.inline && cur.key === k;
    var banner = opts.banner != null ? String(opts.banner) : (same && cur.banner ? cur.banner : '');
    cur = { key: k, phone: phone, anchorFn: anchorFn, data: d, sel: -1, moved: false, expanded: same ? cur.expanded : false, inline: !!opts.inline, host: opts.host || null, bookBtn: !!opts.bookBtn, banner: banner };
    cur.sel = defaultSel(d, cur);
    if (!cur.inline) dismissed = '';
    paint();
    if (d.archivePending) {
      var want = k, inl = cur.inline, host = cur.host;
      loadArchive().then(function () {
        if (!cur || cur.key !== want || cur.inline !== inl || cur.host !== host) return;
        var sel = cur.sel; cur.data = listFor(want); cur.data.archivePending = false;
        cur.sel = cur.moved ? Math.min(sel, rowsShown(cur.data, cur).length - 1) : defaultSel(cur.data, cur);
        paint();
      });
    }
    return d;
  }
  function hide() {
    if (drop) { drop.hidden = true; drop.innerHTML = ''; }
    if (cur && !cur.inline) cur = null;
  }
  function isOpen() { return !!(cur && !cur.inline && drop && !drop.hidden); }

  /* ---------- filling the Book form ---------- */
  var undoSnap = null;
  var parked = [];         // [{snap, label}]: bookings set aside when a new caller was put over them, newest last
  var undoPark = null;     // the entry the last fill set aside (Undo fill takes it back out)
  var PARK_MAX = 6;
  var chipText = '';
  var FIELDS = ['d_passenger', 'd_phone', 'd_caller', 'd_puAddr', 'd_doAddr', 'd_fare', 'd_tolls', 'd_vtype', 'd_pax', 'd_account', 'd_notes', 'd_driver', 'd_vehicle', 'd_date', 'd_time'];
  function snapshot() {
    var s = { f: {}, stops: [], auto: '', rbase: '', editing: null, when: '' };
    FIELDS.forEach(function (id) { var el = byId(id); if (el) s.f[id] = el.value; });
    try { s.stops = (typeof dispatchStops !== 'undefined' && Array.isArray(dispatchStops)) ? dispatchStops.map(function (x) { return { addr: x.addr }; }) : []; } catch (e) {}
    var fe = byId('d_fare'); if (fe) { s.auto = fe.dataset.auto || ''; s.rbase = fe.dataset.rbase || ''; }
    try { s.editing = (typeof editingId !== 'undefined') ? editingId : null; } catch (e) {}
    try { s.when = (typeof whenMode !== 'undefined') ? whenMode : ''; } catch (e) {}
    s.meter = (byId('d_meterStatus') || {}).textContent || '';
    var rt = byId('d_rt'); s.rt = !!(rt && rt.checked);
    if (s.editing) { var lt = liveTrip(s.editing); if (lt) s.live = { driverId: lt.driverId || '', vehicleId: lt.vehicleId || '', status: lt.status || '' }; }
    return s;
  }
  function liveTrip(id) { var a = trips(); for (var i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return a[i]; return null; }
  /* an edit that waited while set aside: the trip may have been assigned or changed meanwhile */
  function syncLive(s) {
    if (!s.editing || !s.live) return '';
    var lt = liveTrip(s.editing);
    if (!lt) return 'That trip is no longer on the board — check before saving.';
    var msg = [];
    var dv = byId('d_driver'), vv = byId('d_vehicle');
    if ((lt.driverId || '') !== s.live.driverId) {
      try { if (dv && typeof fillSelect === 'function' && typeof driverOptions === 'function') fillSelect(dv, driverOptions(true)); } catch (e) {}
      if (dv) dv.value = lt.driverId || '';
      msg.push('driver');
    }
    if ((lt.vehicleId || '') !== s.live.vehicleId) {
      try { if (vv && typeof fillSelect === 'function' && typeof vehicleOptions === 'function') fillSelect(vv, vehicleOptions()); } catch (e) {}
      if (vv) vv.value = lt.vehicleId || '';
      msg.push('vehicle');
    }
    if ((lt.status || '') !== s.live.status) msg.push('status (now ' + (lt.status || '—') + ')');
    return msg.length ? 'Trip changed while set aside: ' + msg.join(', ') + ' taken from the board.' : '';
  }
  function setStops(list) {
    try { dispatchStops = (list || []).map(function (x) { return { addr: String(x.addr || '') }; }); } catch (e) { return; }
    call('renderStops');
  }
  function refresh() { call('updateReadout'); call('updateDispMap'); }
  function applySnap(s, restoreNew) {
    if (s.when && g('setWhen')) call('setWhen', s.when);
    Object.keys(s.f).forEach(function (id) { var el = byId(id); if (el) el.value = s.f[id]; });
    setStops(s.stops);
    var fe = byId('d_fare'); if (fe) { fe.dataset.auto = s.auto; fe.dataset.rbase = s.rbase; }
    var rt = byId('d_rt'); if (rt && s.rt != null) rt.checked = !!s.rt;
    var tag = byId('editTag'), sv = byId('d_save');
    if (s.editing) { try { editingId = s.editing; } catch (e) {} if (tag) tag.style.display = 'inline'; if (sv) sv.textContent = 'Update Trip'; }
    else if (restoreNew) { try { editingId = null; } catch (e) {} if (tag) tag.style.display = 'none'; if (sv) sv.textContent = 'Book Trip'; }
    if (byId('d_meterStatus')) byId('d_meterStatus').textContent = s.meter;
    refresh();
    try { if (window.Quote && typeof window.Quote.refresh === 'function') window.Quote.refresh(); } catch (e) {}
  }
  function undoFill() {
    var s = undoSnap; if (!s) return false;
    if (undoPark) { var j = parked.indexOf(undoPark); if (j >= 0) parked.splice(j, 1); undoPark = null; }
    applySnap(s, false);
    undoSnap = null; chipText = ''; renderChip();
    toast('Fill undone.');
    var p = byId('d_phone'); if (p) p.focus();
    return true;
  }
  /* is something typed in the form that a new caller would wipe? */
  function formDirty() {
    try { if (typeof editingId !== 'undefined' && editingId) return true; } catch (e) {}
    return ['d_passenger', 'd_puAddr', 'd_doAddr', 'd_notes'].some(function (id) { var el = byId(id); return !!(el && String(el.value || '').trim()); });
  }
  function formLabel(s) {
    var f = s.f || {};
    var who = String(f.d_passenger || '').trim() || (keyOf(f.d_phone) ? fmtPhone(f.d_phone) : '') || short(f.d_puAddr) || 'the last booking';
    return (s.editing ? 'edit of ' : '') + who;
  }
  function park(s) {
    var e = { snap: s, label: formLabel(s) };
    parked.push(e);
    if (parked.length > PARK_MAX) { var gone = parked.shift(); toast('Too many set aside — the oldest (' + gone.label + ') was dropped.', 'warn'); }
    renderChip();
    return e;
  }
  function unpark(i) {
    if (!parked.length) return false;
    if (!(i >= 0 && i < parked.length)) i = parked.length - 1;
    var p = parked[i];
    var swap = formDirty() ? snapshot() : null;
    hide();
    applySnap(p.snap, true);
    var warn = syncLive(p.snap);
    if (swap) parked[i] = { snap: swap, label: formLabel(swap) }; else parked.splice(i, 1);
    undoSnap = null; undoPark = null; chipText = '';
    renderChip();
    var k = keyOf((byId('d_phone') || {}).value); if (k) dismissed = k;
    toast(warn || ('Booking for ' + p.label + ' brought back.'), warn ? 'warn' : undefined);
    var el = byId('d_puAddr') || byId('d_phone'); if (el) { try { el.focus(); } catch (e) {} }
    return true;
  }
  function removeChip() { var c = byId('chFillChip'); if (c && c.parentNode) c.parentNode.removeChild(c); }
  function renderChip() {
    removeChip();
    if (!chipText && !parked.length) return;
    var c = document.createElement('div'); c.id = 'chFillChip'; c.className = 'ch-fillchip';
    var h = '';
    if (chipText) h += '<span>' + esc(chipText) + '</span>' + (undoSnap ? ' <a href="#" data-ch="undo">Undo fill</a>' : '');
    for (var pi = parked.length - 1; pi >= 0; pi--) h += (h ? ' <span class="ch-sep">|</span> ' : '') + '<span class="ch-park">Set aside: ' + esc(parked[pi].label) + '</span> <a href="#" data-ch="undo" data-park="' + pi + '" title="Put that booking back in the form">Bring it back</a> <a href="#" data-ch="forget" data-park="' + pi + '" title="Forget this set-aside booking" aria-label="Forget">&times;</a>';
    c.innerHTML = h;
    c.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-ch]'); if (!a) return; e.preventDefault();
      var k = a.getAttribute('data-ch');
      var pi = a.getAttribute('data-park');
      if (k === 'forget') { var j = pi != null ? +pi : parked.length - 1; if (parked[j] === undoPark) undoPark = null; parked.splice(j, 1); renderChip(); return; }
      if (pi != null) { unpark(+pi); return; }
      undoFill();
    });
    var ret = byId('d_returning'), ph = byId('d_phone');
    if (ret && ret.parentNode) ret.parentNode.insertBefore(c, ret);
    else if (ph) { var f = ph.closest('.fld') || ph; if (f.parentNode) f.parentNode.insertBefore(c, f.nextSibling); }
  }
  function putChip(text) { chipText = String(text || ''); renderChip(); }
  /* the console clears the form (Clear, after Save, a new job): the fill chip goes, a set-aside booking stays offered */
  var keepParkUntil = 0;   // the form is cleared after a Save: the set-aside booking stays offered then, not after Clear
  function onCleared() { hide(); chipText = ''; undoSnap = null; undoPark = null; dismissed = ''; removeChip(); if (Date.now() > keepParkUntil) parked = []; }
  function openBook() {
    if (formVisible()) return;
    try { if (window.Simple && typeof window.Simple.enter === 'function' && document.body.classList.contains('simple-mode')) { window.Simple.enter('book'); if (formVisible()) return; } } catch (e) {}
    call('goTab', 'dispatch');
  }
  function setVal(id, v) { var el = byId(id); if (el) el.value = v; }
  function setSelect(id, v) { var el = byId(id); if (!el || v == null || v === '') return; for (var i = 0; i < el.options.length; i++) if (el.options[i].value === String(v)) { el.value = String(v); return; } }

  function fill(t, how) {
    if (POPOUT) { sendToMain(t, how); return false; }
    if (!t || typeof t !== 'object') return false;
    how = how || (t.usual ? 'usual' : 'book');
    var like = {
      passenger: t.passenger || '', phone: t.phone || '', pu: t.pu != null ? t.pu : (t.puAddr || ''), dropoff: t.dropoff != null ? t.dropoff : (t.doAddr || ''),
      stops: Array.isArray(t.stops) ? t.stops : [], vtype: t.vtype || '', pax: Number(t.pax) || 1, payValue: t.payValue || payValue(t), notes: t.notes || '',
      fare: Number(t.fare) || 0, tolls: Number(t.tolls) || 0, no: t.no || t.dispatchNo || '', date: t.date || t.lastDate || '', src: t.src || 'trip'
    };
    if (!like.pu && !like.dropoff) return false;
    openBook();
    var phoneNow = (byId('d_phone') || {}).value || '';
    var curKey = cur && cur.key;
    undoSnap = snapshot(); undoPark = null;
    /* a half-typed booking for someone else (a walk-in, another caller, an edit) is set aside, not overwritten */
    var callerKey = keyOf(like.phone) || curKey || '';
    if (formDirty() && keyOf(phoneNow) !== callerKey) { undoPark = park(undoSnap); phoneNow = ''; }
    try { editingId = null; } catch (e) {}
    var tag = byId('editTag'); if (tag) tag.style.display = 'none';
    var sv = byId('d_save'); if (sv) sv.textContent = 'Book Trip';
    var name = like.passenger || (cur && cur.data && cur.data.name) || '';
    if (name) setVal('d_passenger', name);
    var ph = (keyOf(phoneNow) && (!curKey || keyOf(phoneNow) === curKey)) ? phoneNow : (cur && cur.phone) || like.phone || phoneNow;
    setVal('d_phone', ph);
    var fx = function (a) { var f = g('fixAddr'); if (f) { try { return f(a) || a; } catch (e) {} } return a; };
    var pu = fx(like.pu), dd = fx(like.dropoff), stops = like.stops.slice();
    if (how === 'return') { var tmp = pu; pu = dd; dd = tmp; stops = stops.slice().reverse(); }
    if (how === 'newdrop') dd = '';
    setVal('d_puAddr', pu); setVal('d_doAddr', dd); setStops(stops);
    if (like.vtype) setSelect('d_vtype', like.vtype);
    setVal('d_pax', String(like.pax || 1));
    if (like.payValue) {
      var acc = byId('d_account');
      if (acc && like.payValue !== 'cash' && like.payValue !== 'card') { try { if (typeof fillSelect === 'function' && typeof accountOptions === 'function') fillSelect(acc, accountOptions(false)); } catch (e) {} }
      setSelect('d_account', like.payValue);
    } else {
      var a2 = cur && cur.data && cur.data.acct;
      if (a2) { var acc2 = byId('d_account'); try { if (acc2 && typeof fillSelect === 'function' && typeof accountOptions === 'function') fillSelect(acc2, accountOptions(false)); } catch (e) {} setSelect('d_account', a2.id); }
    }
    var notes = like.notes;
    if (how === 'usual') notes = 'as usual' + (notes ? ' — ' + notes.replace(/^as usual(\s*—\s*)?/i, '') : '');
    setVal('d_notes', notes);
    /* re-price at today's rates through the console's own engine */
    var fe = byId('d_fare');
    if (fe) { fe.value = ''; fe.dataset.auto = ''; fe.dataset.rbase = ''; }
    /* without a toll engine the old toll is only a guess: never carried onto a return (some crossings charge one way) */
    var tollEngine = !!(window.Tolls && typeof window.Tolls.refreshForm === 'function');
    var carryTolls = !tollEngine && how !== 'newdrop' && how !== 'return' && like.tolls > 0;
    setVal('d_tolls', carryTolls ? like.tolls.toFixed(2) : '0.00');
    var priced = false;
    if (pu && dd) {
      call('maybeAutoFare');
      try { if (window.Tolls && typeof window.Tolls.refreshForm === 'function') window.Tolls.refreshForm(); } catch (e) { log(e); }
      priced = !!(fe && Number(fe.value) > 0);
      if (!priced && fe && like.fare > 0) { fe.value = String(whole(like.fare)); fe.dataset.auto = ''; }
    }
    try { if (window.Quote && typeof window.Quote.refresh === 'function') window.Quote.refresh(); } catch (e) { log(e); }
    refresh();
    var label = t.ahead ? 'Copy of a ride already booked for ' + fmtDate(like.date) + (like.no ? ' (#' + like.no + ')' : '') + ' — change the date or it books twice' : null;
    if (!label) label = like.src === 'archive' ? 'From archive call' + (like.no ? ' #' + like.no : '') : (like.src === 'callerbook' ? 'From their usual on record' : 'From trip' + (like.no ? ' #' + like.no : ''));
    if (like.date && !t.ahead) label += ' on ' + fmtDate(like.date);
    if (how === 'return') label += ' · return trip';
    if (how === 'newdrop') label += ' · new drop-off';
    if (how === 'usual') label += ' · usual';
    if (pu && dd) label += priced ? ' · priced at today’s rates' : (like.fare > 0 ? ' · no book price, last fare used' : ' · type the fare');
    if (carryTolls) label += ' · tolls $' + like.tolls.toFixed(2) + ' from last trip';
    else if (!tollEngine && how === 'return' && like.tolls > 0) label += ' · check tolls (last trip had $' + like.tolls.toFixed(2) + ')';
    putChip(label);
    hide();
    dismissed = keyOf(ph) || dismissed;   // leaving the phone field must not pop the list straight back
    var focusEl = how === 'newdrop' ? byId('d_doAddr') : (byId('d_save') || byId('d_puAddr'));
    if (focusEl) { try { focusEl.focus(); } catch (e) {} }
    toast(how === 'newdrop' ? 'Filled — type the new drop-off.' : 'Filled — check it and press Book Trip.');
    return true;
  }

  function rowAt(i) { if (!cur) return null; var l = rowsShown(cur.data, cur); return l[i] || null; }
  function act(kind, i) {
    if (!cur) return;
    if (kind === 'close') { dismissed = cur.key; hide(); return; }
    if (kind === 'all') { cur.expanded = !cur.expanded; if (!cur.moved) cur.sel = defaultSel(cur.data, cur); paint(); return; }
    if (kind === 'open') {
      var num = cur.phone || cur.key;
      hide();
      if (g('openCallerPopout')) window.openCallerPopout(num); else { openBook(); call('applyCaller', num); }
      return;
    }
    var r = rowAt(i); if (!r) return;
    var how = kind === 'return' ? 'return' : (kind === 'newdrop' ? 'newdrop' : (r.usual ? 'usual' : 'book'));
    if (cur.inline) { sendToMain(Object.assign({}, r, { phone: r.phone || cur.phone }), how); return; }
    fill(r, how);
  }
  function onDropClick(e) {
    var b = e.target.closest ? e.target.closest('[data-ch]') : null;
    var host = cur && cur.inline ? cur.host : drop;
    if (b && host && host.contains(b)) { e.preventDefault(); act(b.getAttribute('data-ch'), +b.getAttribute('data-i')); return; }
    var row = e.target.closest ? e.target.closest('.ch-row') : null;
    if (row && host && host.contains(row)) { e.preventDefault(); act('book', +row.getAttribute('data-i')); }
  }
  function moveSel(dlt) {
    if (!cur) return; var n = rowsShown(cur.data, cur).length; if (!n) return;
    cur.moved = true; cur.sel = ((cur.sel < 0 ? -1 : cur.sel) + dlt + n) % n; paint();
    var el = (cur.inline ? cur.host : drop).querySelector('.ch-row.sel'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- pop-out -> main console ----------
     Only ONE main window takes the fill: the one the dispatcher last used (its id is kept in
     localStorage). If that window does not answer within a second (closed), the pop-out asks
     every main window instead. */
  var WID = ''; try { WID = (typeof WIN_ID !== 'undefined' && WIN_ID) ? String(WIN_ID) : ''; } catch (e) {}
  if (!WID) WID = 'ch' + Math.random().toString(36).slice(2, 9);
  var MAIN_KEY = 'skyway_callerhist_main';
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { if (localStorage.getItem(k) !== v) localStorage.setItem(k, v); } catch (e) {} }
  /* main windows, most recently used first, so closing the last-used one hands over to the next */
  var MAINS_KEY = 'skyway_callerhist_mains';
  function mainsGet() { try { var a = JSON.parse(lsGet(MAINS_KEY) || '[]'); return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string' && x; }) : []; } catch (e) { return []; } }
  function mainsSet(a) { try { localStorage.setItem(MAINS_KEY, JSON.stringify(a.slice(0, 8))); } catch (e) {} }
  function markMain() {
    if (POPOUT) return;
    lsSet(MAIN_KEY, WID);
    var a = mainsGet(); if (a[0] !== WID) mainsSet([WID].concat(a.filter(function (x) { return x !== WID; })));
  }
  function unmarkMain() {
    var a = mainsGet().filter(function (x) { return x !== WID; }); mainsSet(a);
    try { if (localStorage.getItem(MAIN_KEY) === WID) { if (a[0]) localStorage.setItem(MAIN_KEY, a[0]); else localStorage.removeItem(MAIN_KEY); } } catch (e) {}
  }
  var acks = {}, filled = {};
  function postFill(like, how, rid, target) {
    SkyBus.post({ type: 'cmd', cmd: 'callerHistFill', trip: like, how: how || 'book', rid: rid, target: target || '*' });
  }
  function sendToMain(r, how) {
    try {
      if (typeof SkyBus === 'undefined' || !SkyBus) return;
      var like = { passenger: r.passenger || '', phone: r.phone || '', pu: r.pu || '', dropoff: r.dropoff || '', stops: r.stops || [], vtype: r.vtype || '', pax: r.pax || 1, payValue: r.payValue || '', notes: r.notes || '', fare: r.fare || 0, tolls: r.tolls || 0, no: r.no || '', date: r.date || '', src: r.src || 'trip', usual: !!r.usual, ahead: !!r.ahead };
      var rid = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      /* the last-used main window first; if it does not answer in a second, the next one, and so on;
         only when none answers does every main window get it */
      var cands = [lsGet(MAIN_KEY)].concat(mainsGet()).filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, 4);
      var step = function (j) {
        var target = cands[j] || '*';
        postFill(like, how, rid, target);
        if (target !== '*') acks[rid] = setTimeout(function () { delete acks[rid]; try { step(j + 1); } catch (e) {} }, 1000);
      };
      step(0);
      toast('Sent to the dispatcher window.');
    } catch (e) { log(e); }
  }
  try {
    if (typeof SkyBus !== 'undefined' && SkyBus && typeof SkyBus.on === 'function') SkyBus.on(function (msg) {
      if (!msg || msg.type !== 'cmd') return;
      if (msg.cmd === 'callerHistFillAck') { if (msg.rid && acks[msg.rid]) { clearTimeout(acks[msg.rid]); delete acks[msg.rid]; } return; }
      if (POPOUT || msg.cmd !== 'callerHistFill' || !msg.trip) return;
      if (msg.target && msg.target !== '*' && msg.target !== WID) return;
      if (msg.rid) { if (filled[msg.rid]) return; filled[msg.rid] = 1; try { SkyBus.post({ type: 'cmd', cmd: 'callerHistFillAck', rid: msg.rid }); } catch (e) {} }
      markMain();
      setTimeout(function () { try { var k = keyOf(msg.trip.phone); if (k) cur = { key: k, phone: msg.trip.phone, anchorFn: phoneAnchor, data: listFor(k), sel: 0, inline: false }; fill(msg.trip, msg.how); } catch (e) { log(e); } }, 30);
    });
  } catch (e) {}
  if (!POPOUT) {
    markMain();
    window.addEventListener('focus', markMain);
    document.addEventListener('mousedown', markMain, true);
    document.addEventListener('keydown', markMain, true);
    window.addEventListener('beforeunload', unmarkMain);
  }

  /* ---------- keyboard + outside click ---------- */
  function phoneish(el) { return !!(el && (el.id === 'd_phone' || el.id === 'd_caller' || el.id === 'ci_num' || (el.classList && el.classList.contains('cid-in')))); }
  function editable(el) { return !!(el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)); }
  function anchorEl() { try { return cur && cur.anchorFn ? cur.anchorFn() : null; } catch (e) { return null; } }
  /* hotkeys belong to the drop-down only when the dispatcher is in it, or in the phone box it hangs
     under and that box still holds the same number. Anywhere else the keys are the console's. */
  document.addEventListener('keydown', function (e) {
    if (!isOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target, inDrop = !!(drop && t && drop.contains(t));
    var a = anchorEl(), inAnchor = !!(a && t && t.nodeType === 1 && a.contains(t));
    var sameNum = !(t && t.tagName === 'INPUT') || keyOf(t.value) === cur.key || !keyOf(t.value);
    var mine = inDrop || (inAnchor && sameNum);
    if (e.key === 'Escape') {
      if (mine) { e.preventDefault(); e.stopImmediatePropagation(); }
      dismissed = cur.key; hide(); return;
    }
    if (!mine) return;
    if (t && t.tagName === 'BUTTON' && !inDrop && (e.key === 'Enter' || e.key === ' ')) return;
    var isLine = !!(t && t.classList && t.classList.contains('cid-in'));
    var n = rowsShown(cur.data, cur).length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); e.stopImmediatePropagation(); moveSel(1); return; }
    if (e.key === 'ArrowUp' && n) { e.preventDefault(); e.stopImmediatePropagation(); moveSel(-1); return; }
    if (isLine) return;   // Enter on an F-line is the console's "open the job" key; letters are typing
    if (cur.sel < 0) return;   // nothing picked (only booked-ahead rows): Enter, R, D stay the console's
    var i = cur.sel;
    if (e.key === 'Enter' && n) { e.preventDefault(); e.stopImmediatePropagation(); act('book', i); return; }
    if ((e.key === 'r' || e.key === 'R') && n) { e.preventDefault(); e.stopImmediatePropagation(); act('return', i); return; }
    if ((e.key === 'd' || e.key === 'D') && n) { e.preventDefault(); e.stopImmediatePropagation(); act('newdrop', i); return; }
  }, true);
  /* another phone box (an F-line, the Caller box) takes focus with a different number: the list is not its */
  document.addEventListener('focusin', function (e) {
    if (!isOpen()) return;
    var t = e.target; if (!phoneish(t)) return;
    if (drop.contains(t)) return;
    var a = anchorEl(); if (a && a.contains && a.contains(t)) return;
    if (keyOf(t.value) === cur.key) return;
    hide();
  }, true);
  document.addEventListener('mousedown', function (e) {
    if (!isOpen()) return;
    var t = e.target;
    if (drop.contains(t)) return;
    var a = null; try { a = cur.anchorFn(); } catch (x) {}
    if (a && a.contains && a.contains(t)) return;
    if (phoneish(t)) return;
    dismissed = cur.key; hide();
  }, true);
  window.addEventListener('resize', function () { position(); });
  window.addEventListener('scroll', function () { position(); }, true);

  /* ---------- trigger points ---------- */
  if (!POPOUT) {
    var typeT = null;
    var onType = function (ev) {
      var el = ev.target; if (!el) return;
      clearTimeout(typeT);
      typeT = setTimeout(function () {
        var k = keyOf(el.value);
        if (!k) { if (isOpen() && cur.anchorFn() === el) hide(); return; }
        if (ev.type === 'blur' && (k === dismissed || (isOpen() && cur.key === k))) return;
        if (isOpen() && cur.key === k) return;
        if (k === dismissed && ev.type !== 'input') return;
        show(el.value, el);
      }, ev.type === 'input' ? 40 : 0);
    };
    ['d_phone', 'd_caller'].forEach(function (id) {
      var el = byId(id); if (!el || el._chWired) return; el._chWired = true;
      el.addEventListener('input', onType);
      el.addEventListener('blur', function (ev) { var ed = null; try { ed = (typeof editingId !== 'undefined') ? editingId : null; } catch (x) {} if (!isOpen() && !ed) onType(ev); });
    });
    /* Save and Clear close the drop-down */
    var sv = byId('d_save'); if (sv && !sv._chWired) { sv._chWired = true; sv.addEventListener('click', function () { hide(); keepParkUntil = Date.now() + 3000; }, true); }
    /* #d_clear is bound to the original clearDispatch, so the wrapper below never sees it: listen too */
    var cl = byId('d_clear'); if (cl && !cl._chWired) { cl._chWired = true; cl.addEventListener('click', function () { onCleared(); setTimeout(function () { if (parked.length) renderChip(); }, 0); }, true); }
    wrap('clearDispatch', function (orig) { return function () { onCleared(); var r = orig.apply(this, arguments); if (parked.length) renderChip(); return r; }; });
    wrap('applyCaller', function (orig) {
      return function (num) {
        var r = orig.apply(this, arguments);
        try { if (on() && keyOf(num)) { var p = byId('d_phone'); show(num, p); } } catch (e) { log(e); }
        return r;
      };
    });
    /* F-key / New job / Needs-you Book: open the Book form with the drop-down instead of the old overlay.
       The inner wrappers still run (ops.js marks the call answered, crm.js ties the booking to a
       win-back row and paints its banner); their overlay is closed straight after and the banner
       is carried into the drop-down. A half-typed booking for someone else is set aside, not lost. */
    wrap('openCallerPopout', function (orig) {
      return function (num) {
        if (!on() || !keyOf(num) || !g('applyCaller')) return orig.apply(this, arguments);
        var out, hadCard = !!byId('editOvlCard');
        try {
          openBook();
          var p = byId('d_phone');
          if (p && keyOf(p.value) !== keyOf(num)) {
            var snap = formDirty() ? snapshot() : null, before = parked.slice();
            call('clearDispatch');
            parked = before;
            if (snap) park(snap); else if (parked.length) renderChip();
          }
        } catch (e) { log(e); }
        try { out = orig.apply(this, arguments); } catch (e) { log(e); }
        try {
          var banner = '';
          var ovl = byId('editOvl'), card = byId('editOvlCard');
          if (card && ovl && !ovl.hidden) {
            Array.prototype.forEach.call(card.querySelectorAll('.crm-ban'), function (b) { if (!b.classList.contains('crm-ban-stop')) banner += b.outerHTML; });
            call('closeEditOvl');
          }
          openBook();
          if (hadCard) window.applyCaller(num);
          var c = byId('d_caller'); if (c) c.value = num;
          openBook();
          show(num, byId('d_phone'), { banner: banner });
          if (parked.length) renderChip();
          p = byId('d_phone'); if (p) { try { p.focus(); } catch (e) {} }
          setTimeout(position, 60);
        } catch (e) { log(e); }
        return out;
      };
    });
    wrap('cidSet', function (orig) {
      return function (i, v) {
        var r = orig.apply(this, arguments);
        try { var val = String(v || '').trim(); if (on() && keyOf(val)) show(val, lineAnchorFn(+i), { bookBtn: true }); else if (isOpen() && !val) { var a = cur.anchorFn(); if (a && a.closest && a.closest('#cid_lines')) hide(); } } catch (e) { log(e); }
        return r;
      };
    });
    wrap('useLastTrip', function (orig) {
      return function (id) {
        var t = null; try { t = trips().filter(function (x) { return x && x.id === id; })[0] || null; } catch (e) {}
        var snap = snapshot();
        var r = orig.apply(this, arguments);
        try { if (t) { undoSnap = snap; editingId = null; putChip('From trip' + (t.dispatchNo ? ' #' + t.dispatchNo : '') + (t.date ? ' on ' + fmtDate(t.date) : '') + ' · last fare kept'); hide(); } } catch (e) { log(e); }
        return r;
      };
    });
    /* re-renders of the F-lines replace the row the drop-down hangs under: re-anchor */
    try {
      var lines = byId('cid_lines');
      if (lines && typeof MutationObserver === 'function') new MutationObserver(function () { if (isOpen()) setTimeout(position, 0); }).observe(lines, { childList: true });
    } catch (e) {}
    /* the ?caller= screen-pop ran before this file loaded */
    try {
      var qp = new URLSearchParams(location.search), qc = qp.get('caller') || qp.get('phone') || qp.get('ani');
      if (qc && keyOf(qc)) setTimeout(function () { if (!isOpen()) show(qc, byId('d_phone')); }, 50);
    } catch (e) {}
  }

  /* ---------- Caller-ID pop-out: the list inline under the caller card ---------- */
  function inlineCI() {
    var box = byId('ci_result'), num = (byId('ci_num') || {}).value || '';
    if (!box || !keyOf(num) || !on()) return;
    var old = byId('ch_inline'); if (old && old.parentNode) old.parentNode.removeChild(old);
    var host = document.createElement('div'); host.id = 'ch_inline'; host.className = 'ch-drop ch-inline';
    host.addEventListener('click', onDropClick);
    box.appendChild(host);
    show(num, null, { inline: true, host: host });
  }
  if (POPOUT === 'callerid') {
    wrap('ciLookup', function (orig) { return function () { var r = orig.apply(this, arguments); try { inlineCI(); } catch (e) { log(e); } return r; }; });
    setTimeout(function () { try { if (byId('ci_result') && byId('ci_result').innerHTML && !byId('ch_inline')) inlineCI(); } catch (e) { log(e); } }, 0);
  }

  /* ---------- Settings panel ---------- */
  function settingsPanel() {
    if (POPOUT) return;
    var view = byId('view-settings'); if (!view || byId('chSettings')) return;
    var c = cfg();
    var p = document.createElement('div'); p.className = 'panel'; p.id = 'chSettings';
    p.innerHTML = '<div class="panel-head">Caller history drop-down</div><div class="panel-body">'
      + '<label class="chk" style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="ch_on"' + (c.enabled ? ' checked' : '') + '> Show the caller’s past trips when a number comes in</label>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;"><label class="fld" style="margin:0;"><span class="lbl">Usual routes: look back (months)</span><input type="number" id="ch_months" min="1" max="120" value="' + c.months + '" style="width:90px;"></label>'
      + '<label class="fld" style="margin:0;"><span class="lbl">Recent trips shown</span><input type="number" id="ch_recent" min="3" max="100" value="' + c.recent + '" style="width:90px;"></label></div>'
      + '<div class="hint">Click a row (or Enter) to fill the Book form. R = return trip, D = new drop-off, Esc = close.</div></div>';
    view.appendChild(p);
    var upd = function () {
      var cc = cfg();
      cc.enabled = !!byId('ch_on').checked;
      var m = +byId('ch_months').value; if (m >= 1 && m <= 120) cc.months = Math.round(m);
      var r = +byId('ch_recent').value; if (r >= 3 && r <= 100) cc.recent = Math.round(r);
      if (!cc.enabled) hide();
      call('save');
    };
    ['ch_on', 'ch_months', 'ch_recent'].forEach(function (id) { var el = byId(id); if (el) el.addEventListener('change', upd); });
  }
  try { settingsPanel(); } catch (e) { log(e); }

  /* ---------- styles (inline so the file works on its own; callerhist.css may override) ---------- */
  (function css() {
    if (byId('chStyles')) return;
    var s = document.createElement('style'); s.id = 'chStyles';
    s.textContent = [
      '.ch-drop{position:absolute;z-index:9000;background:var(--panel,#fff);color:var(--ink,#1b2430);border:1px solid var(--line,#b9c3cf);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.22);overflow:auto;font-size:13px;padding:6px 0;}',
      '.ch-drop.ch-inline{position:static;box-shadow:none;margin-top:10px;max-height:none;}',
      '.ch-head{padding:4px 10px 6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;border-bottom:1px solid var(--line-soft,#e2e7ee);}',
      '.ch-x{margin-left:auto;border:none;background:transparent;font-size:18px;cursor:pointer;color:inherit;line-height:1;}',
      '.ch-chip{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:700;background:#e8eef6;color:#23406b;}',
      '.ch-chip.ch-bad{background:#c62828;color:#fff;}.ch-chip.ch-warn{background:#f3c44b;color:#3a2a00;}.ch-chip.ch-ok{background:#d9f2df;color:#1e5b2c;}',
      '.ch-sum{padding:4px 10px;font-weight:600;}',
      '.ch-grp{padding:6px 10px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;opacity:.7;}',
      '.ch-row{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:4px 10px;cursor:pointer;border-left:3px solid transparent;}',
      '.ch-row:hover{background:rgba(35,64,107,.06);}.ch-row.sel{background:rgba(35,64,107,.12);border-left-color:#23406b;}',
      '.ch-row.ch-arch .ch-main{opacity:.9;}',
      '.ch-main{flex:1;min-width:0;}.ch-meta{display:block;font-size:11px;opacity:.75;}',
      '.ch-acts{display:flex;gap:4px;flex:0 0 auto;}.ch-acts .btn{padding:2px 6px;font-size:11px;}',
      '.ch-new{padding:8px 10px;}.ch-foot{padding:6px 10px 2px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.ch-hint{font-size:11px;opacity:.7;padding:2px 10px;}',
      '.ch-fillchip{display:inline-block;margin:-4px 0 8px;padding:3px 9px;border-radius:12px;background:#e8eef6;color:#23406b;font-size:12px;}',
      '.ch-fillchip a{margin-left:6px;font-weight:700;}',
      '.ch-fillchip .ch-park{font-weight:600;}.ch-fillchip .ch-sep{opacity:.5;margin:0 4px;}',
      '.ch-crm{padding:4px 10px 0;}.ch-crm .crm-ban{margin:0 0 4px;}',
      '.ch-row.ch-ahead{border-left-color:#f3c44b;}',
      '@media (prefers-color-scheme: dark){.ch-drop{background:var(--panel,#1e2530);color:var(--ink,#e6ebf2);}}',
      '@media (max-width:700px){.ch-row{flex-direction:column;align-items:stretch;}.ch-acts{flex-wrap:wrap;}}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  })();

  window.CallerHist = {
    _loaded: true,
    show: function (phone, anchorEl) { try { return show(phone, anchorEl); } catch (e) { log(e); return null; } },
    hide: hide,
    isOpen: isOpen,
    listFor: function (phone) {
      try { var d = listFor(phone); return { usual: d.usual, recent: d.recent, name: d.name, acct: d.acct, flags: d.flags, total: d.total, last: d.last, phone: d.phone }; }
      catch (e) { log(e); return { usual: [], recent: [], name: '', acct: null, flags: [] }; }
    },
    fill: function (t, how) { try { return fill(t, how); } catch (e) { log(e); return false; } },
    undo: undoFill,
    loadArchive: loadArchive,
    _reindex: markDirty
  };
})();
