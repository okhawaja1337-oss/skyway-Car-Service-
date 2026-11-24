/* ======================================================================
   Skyway — desk.js
   The Trips and Reservations screens like the original program: both grids
   up at once, every row clickable, cells editable in place.

   (a) Layout. One "desk" with TWO dense classic grids, stacked (default) or
       side by side, a draggable splitter between them (settings.desk.split),
       a filter box per grid, sort by clicking a column head, status colours.
         TRIPS        = today's jobs: everything the board calls Active / Due
                        Now (Dispatched, or Booked inside the board's lead time,
                        settings.leadMins — refreshBoard's own rule, reused),
                        plus today's Completed / Canceled / No-Show.
         RESERVATIONS = every live trip the board files under Upcoming
                        Reservations (Booked and not yet due), today later and
                        future, grouped by date, soonest first, with a countdown.
       A reservation moves to Trips the moment refreshBoard's rule says it is
       due (no second clock). The "DUE" badge shows settings.desk.leadMin
       minutes before pickup; "LATE" once pickup has passed.
       Where it lives:
         Expert -> Dispatch tab: inside #classicWrap (the "Classic Jobs view"
                   toggle now shows the desk; settings.desk.on remembers it,
                   default ON). The old single grid and bar are hidden, not
                   removed: renderClassic still runs underneath.
         Simple -> Board (and Today): first thing in #boardArea, above the old
                   Active / Reservations panels, which can be collapsed.
         Pop-out -> the console's own pop-out mechanism: openScreen('desk')
                   opens index.html?screen=desk; this file then shows the desk
                   alone (CSS hides the console body). Double-click / Enter in
                   the pop-out sends the trip to the main console (pushToMain).
   (b) Clickable. Click selects (the classic button bar acts on it: Modify, New,
       Dispatch, Cancel, LocPric, ZSusp, Inquire, 10-4, Sign, Dup, Drop — the
       console's classic* functions through classicSelId). Double-click on a
       non-editable cell, or Enter, opens the trip in the Book form (editTrip).
       Right-click / the ⋯ button / Shift+F10: Dispatch, Complete, Cancel,
       No-show, Duplicate, Return trip, Text passenger (Messages), Send to phone
       (DriverLink), Print job sheet, Caller history (CallerHist when present).
       Keys in a grid: Down / Up move, Home / End, Tab / Shift+Tab switch grid,
       Enter opens, Space selects, Delete cancels (asks first), Left / Right
       pick a column, F2 edits that cell.
   (c) Editable cells (double-click, or F2). Drvr: on-duty drivers, assigned
       through assignDriver (ops.js gate; a refusal shows the reason in the cell
       and the message line). St: cycleStatus. PL, Vtype: written here and
       logged to the recover.js audit ('edit'); a Vtype that would make the
       assigned driver/car fail the ops.js gate (e.g. Wheelchair Van on a car
       without a ramp) is refused with the reason; a Vtype change re-prices
       from the rate engine through the overlay save (deviation gate applies),
       except an owner-approved override price, which stays and is flagged.
       Menu Complete / bar Drop only complete a Dispatched job (a Booked job
       must go through Dispatch first, so the driver check runs).
       F-keys pressed inside a cell editor are swallowed (F2 would wipe the
       Book form through newTrip()).
       Dtime / Date / Telephone / Passenger / Pick-Up / Drop-Off / Fare: saved
       through the console's own edit-overlay save (saveEditOvl), filled and
       submitted out of sight, so every gate on that path applies: quote.js's
       deviation check (owner PIN beyond the limit; a cancelled prompt leaves
       the fare as it was), ops.js eligibility, tolls.js recount on an address
       change, recover.js audit. A changed address re-prices from the rate
       engine (Quote.engineQuote) when it has a price. Never a blank pick-up;
       a past pickup time asks first. Enter saves, Esc cancels, Tab saves and
       moves to the next editable cell. Undo: Simple.undoable when present,
       else a 10-second Undo bar of this file's own.
   (e) Print: Desk.print() — one page per grid, the same columns (openPrint).
   (f) API: window.Desk = {render, select(id), openPopout, layout(mode), print,
       lists, selected, edit(id,col), _loaded:true}.

   STATE keys owned here: settings.desk {on, layout:'stack'|'side', split,
   leadMin, sortTrips{col,dir}, sortResv{col,dir}, panels:'show'|'hide'}.
   Nothing else is written except the trip fields the console's own form /
   overlay writes (and t.pax / t.vtype from their cells).
   Wraps (window.fn = wrapper, wrapper._orig, flag _deskWrapped): refreshBoard,
   renderClassic, toggleClassic, renderSettings. Offline; no network.
   Never edits index.html. Plain ES2019, no build step.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;
  if (window.Desk && window.Desk._loaded) return;

  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }
  var IS_POP = POPOUT === 'desk';

  /* ---------- helpers (own copies; console globals may be missing) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { try { if (typeof window.toast === 'function') { window.toast(m, w); return; } } catch (e) {} }
  function save() { try { if (typeof window.save === 'function') { window.save(); return; } } catch (e) {} try { if (typeof window.saveNow === 'function') window.saveNow(); } catch (e) {} }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  function trips() { return Array.isArray(STATE.trips) ? STATE.trips : []; }
  function drivers() { return Array.isArray(STATE.drivers) ? STATE.drivers : []; }
  function okTrip(t) { return !!(t && typeof t === 'object' && t.id != null && t.id !== ''); }
  function findTrip(id) { var a = trips(); for (var i = 0; i < a.length; i++) if (okTrip(a[i]) && String(a[i].id) === String(id)) return a[i]; return null; }
  function findDriver(id) { var a = drivers(); for (var i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return a[i]; return null; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayStr() { if (typeof window.todayStr === 'function') { try { return window.todayStr(); } catch (e) {} } var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function dateOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function money(n) { if (typeof window.money === 'function') { try { return window.money(n); } catch (e) {} } return '$' + (Number(n) || 0).toFixed(2); }
  function mil(t) { if (typeof window.mil === 'function') { try { return window.mil(String(t == null ? '' : t)); } catch (e) {} } return String(t == null ? '' : t).trim(); }
  function shortAddr(a) { return String(a == null ? '' : a).split(',')[0].trim(); }
  function fn(name) { return typeof window[name] === 'function' ? window[name] : null; }
  function call(name) { var f = fn(name); if (!f) return undefined; try { return f.apply(null, Array.prototype.slice.call(arguments, 1)); } catch (e) { log(e); return undefined; } }
  function log(e) { try { console.warn('[desk]', e); } catch (e2) {} }
  function act(f) { return function (e) { try { return f.apply(this, arguments); } catch (err) { log(err); } }; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function copy(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; } }
  function cssq(s) { try { return window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'); } catch (e) { return String(s); } }
  function pdt(t) {
    if (!okTrip(t) || !t.date) return null;
    var d = null;
    if (typeof window.pickupDT === 'function') { try { d = window.pickupDT(t); } catch (e) { d = null; } }
    else { var p = String(t.date).split('-').map(Number), m = /^(\d{1,2}):(\d{2})/.exec(mil(t.time)); d = new Date(p[0], p[1] - 1, p[2], m ? +m[1] : 0, m ? +m[2] : 0, 0); }
    return (d && !isNaN(d.getTime())) ? d : null;
  }
  function jobNo(t) { var n = t && t.dispatchNo; return (n == null || n === '') ? '----' : String(n).padStart(4, '0'); }
  function isSimpleBody() { try { return document.body.classList.contains('simple-mode'); } catch (e) { return false; } }
  function inheritFlags(w, o) { try { Object.keys(o).forEach(function (k) { if (/^_|Wrapped$/.test(k) && !(k in w)) w[k] = o[k]; }); } catch (e) {} }
  function wrap(name, mk) {
    var o = window[name]; if (typeof o !== 'function' || o._deskWrapped) return false;
    var w = mk(o); w._deskWrapped = true; w._orig = o; inheritFlags(w, o); window[name] = w; return true;
  }

  /* ---------- settings.desk ---------- */
  var COLS = ['job', 'pu', 'do', 'ctime', 'drvr', 'time', 'st', 'pl', 'tel', 'vtype', 'fare', 'pass', 'date'];
  function fixSort(v, def) { if (!v || typeof v !== 'object' || COLS.indexOf(v.col) < 0) return { col: def.col, dir: def.dir }; return { col: v.col, dir: v.dir === -1 ? -1 : 1 }; }
  function DS() {
    var s = settings(), d = s.desk;
    if (!d || typeof d !== 'object' || Array.isArray(d)) d = s.desk = {};
    if (typeof d.on !== 'boolean') d.on = true;
    if (d.layout !== 'stack' && d.layout !== 'side') d.layout = 'stack';
    var sp = Number(d.split); if (!(sp >= 0.15 && sp <= 0.85)) d.split = 0.5;
    var lm = Number(d.leadMin); d.leadMin = (lm >= 5 && lm <= 720) ? Math.round(lm) : 60;
    var st = fixSort(d.sortTrips, { col: 'time', dir: -1 }); if (JSON.stringify(st) !== JSON.stringify(d.sortTrips)) d.sortTrips = st;
    var sr = fixSort(d.sortResv, { col: 'time', dir: 1 }); if (JSON.stringify(sr) !== JSON.stringify(d.sortResv)) d.sortResv = sr;
    if (d.panels !== 'show' && d.panels !== 'hide') d.panels = 'show';
    return d;
  }

  /* ---------- the two lists (refreshBoard's rule for active vs reservations) ---------- */
  /* exactly refreshBoard's expression (a non-number setting gives NaN there, so nothing Booked is due: same here) */
  function boardLeadMs() { return (settings().leadMins || 60) * 60000; }
  /* F1-F6 belong to a Caller-ID line whenever a caller is waiting on it (index.html's document keydown answers it) */
  function callerWaiting(key) {
    var m = /^F([1-6])$/.exec(String(key || '')); if (!m) return false;
    try { return typeof CIDSTATE !== 'undefined' && !!CIDSTATE && !!CIDSTATE[+m[1] - 1]; } catch (e) { return false; }
  }
  function isLive(t) { return t.status !== 'Completed' && t.status !== 'Canceled' && t.status !== 'No-Show' && t.status !== 'Disregard'; }
  function isDue(t, now) { var dt = pdt(t); return t.status === 'Dispatched' || !!(dt && (dt - now) <= boardLeadMs()); }
  function lists() {
    var now = new Date(), today = todayStr(), T = [], R = [];
    trips().forEach(function (t) {
      if (!okTrip(t)) return;
      if (isLive(t)) { (isDue(t, now) ? T : R).push(t); return; }
      if (t.status === 'Disregard') return;
      if (t.date === today || t.dropDate === today) T.push(t);
    });
    return { trips: T, resv: R, now: now };
  }

  /* ---------- cells ---------- */
  var LABEL = { job: 'Job', pu: 'Pick-Up', do: 'Drop-Off', ctime: 'Ctime', drvr: 'Drvr', time: 'Dtime', st: 'St', pl: 'PL', tel: 'Telephone', vtype: 'Vtype', fare: 'Fare', pass: 'Passenger', date: 'Date' };
  var TIPS = { ctime: 'Call time (when the job was taken)', time: 'Pickup time', st: 'Status: blank Booked, A dispatched, D done, C canceled, N no-show', pl: 'Passengers', drvr: 'Driver / car number' };
  var WIDTH = { job: '80px', pu: '18%', do: '18%', ctime: '46px', drvr: '50px', time: '106px', st: '28px', pl: '30px', tel: '118px', vtype: '62px', fare: '68px', pass: '14%', date: '78px' };
  var EDIT = { pu: 'addr', do: 'addr', drvr: 'driver', time: 'time', st: 'status', pl: 'pax', tel: 'text', vtype: 'vtype', fare: 'fare', pass: 'text', date: 'date' };
  var GRID_COLS = { trips: ['job', 'pu', 'do', 'ctime', 'drvr', 'time', 'st', 'pl', 'tel', 'vtype', 'fare', 'pass'], resv: ['date', 'job', 'pu', 'do', 'ctime', 'drvr', 'time', 'st', 'pl', 'tel', 'vtype', 'fare', 'pass'] };
  function hhmm(iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return ''; return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function drvLabel(t) {
    if (typeof window.classicDrv === 'function') { try { return String(window.classicDrv(t) || ''); } catch (e) {} }
    var d = findDriver(t.driverId); if (!d) return ''; return String(d.carNo || d.name || '').slice(0, 9);
  }
  function stCode(t) { return ({ Booked: '', Dispatched: 'A', Completed: 'D', Canceled: 'C', 'No-Show': 'N', Disregard: 'X' })[t.status] || ''; }
  function vtLabel(t) {
    if (typeof window.classicVtype === 'function') { try { return String(window.classicVtype(t)); } catch (e) {} }
    return String(t.vtype || 'SED').slice(0, 3).toUpperCase() + '/' + (Number(t.pax) || 1);
  }
  function fmtDate(s) { var p = String(s || '').split('-'); return p.length === 3 ? p[1] + '/' + p[2] : String(s || ''); }
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function longDate(s) { var p = String(s || '').split('-').map(Number); if (p.length !== 3 || p.some(isNaN)) return s ? String(s) : 'No date'; var d = new Date(p[0], p[1] - 1, p[2]); if (isNaN(d)) return String(s); var t = todayStr(), tm = dateOf(new Date(Date.now() + 86400000)); return DOW[d.getDay()] + ' ' + pad2(p[1]) + '/' + pad2(p[2]) + '/' + p[0] + (s === t ? ' · today' : s === tm ? ' · tomorrow' : ''); }
  function dur(min) { if (min < 60) return min + 'm'; if (min < 48 * 60) return Math.floor(min / 60) + 'h' + pad2(min % 60); return Math.floor(min / 1440) + 'd'; }
  function countdown(t, now) { var dt = pdt(t); if (!dt) return ''; var m = Math.round((dt - now) / 60000); return m >= 0 ? 'in ' + dur(m) : 'late ' + dur(-m); }
  function badge(t, now) {
    if (t.status !== 'Booked') return '';
    var dt = pdt(t); if (!dt) return '';
    var ms = dt - now;
    if (ms < -60000) return '<span class="dk-badge late" title="Pickup time has passed">LATE</span>';
    if (ms <= DS().leadMin * 60000) return '<span class="dk-badge due" title="Pickup within ' + DS().leadMin + ' min">DUE</span>';
    /* Still on Reservations: flag the rows that move to Trips (board lead time) within the next leadMin minutes,
       so a coming job is visible before it changes grid even when both settings are 60. */
    var toMove = ms - boardLeadMs();
    if (toMove > 0 && toMove <= DS().leadMin * 60000) return '<span class="dk-badge due soon" title="Moves to Trips in ' + Math.max(1, Math.round(toMove / 60000)) + ' min (pickup in ' + dur(Math.round(ms / 60000)) + ')">DUE ' + dur(Math.round(ms / 60000)) + '</span>';
    return '';
  }
  function cellText(t, col) {
    switch (col) {
      case 'job': return jobNo(t);
      case 'pu': return shortAddr(t.puAddr) + ((t.stops && t.stops.length) ? ' (+' + t.stops.length + ')' : '');
      case 'do': return shortAddr(t.doAddr);
      case 'ctime': return hhmm(t.createdAt);
      case 'drvr': return drvLabel(t);
      case 'time': return mil(t.time) || 'ASAP';
      case 'st': return stCode(t);
      case 'pl': return String(Number(t.pax) || 1).padStart(2, '0');
      case 'tel': return String(t.phone || '');
      case 'vtype': return vtLabel(t);
      case 'fare': return Number(t.fare) ? money(t.fare) : '';
      case 'pass': return String(t.passenger || '');
      case 'date': return fmtDate(t.date);
    }
    return '';
  }
  function cellHtml(t, col, grid, now) {
    var txt = esc(cellText(t, col)), cls = '', title = '';
    if (col === 'job') { txt += badge(t, now); }
    if (col === 'time' && (t.status === 'Booked')) { var c = countdown(t, now); if (c) txt += '<span class="dk-cd">' + esc(c) + '</span>'; }
    if (col === 'pu') title = t.puAddr || '';
    if (col === 'do') title = t.doAddr || '';
    if (col === 'pass' && t.notes) title = 'Notes: ' + t.notes;
    if (col === 'drvr') { var d = findDriver(t.driverId); if (d) title = d.name || ''; }
    if (col === 'st') { cls = 'ctr'; title = String(t.status || '') + (t.dispTime ? ' · dispatched ' + t.dispTime : ''); }
    if (col === 'pl') cls = 'ctr';
    if (col === 'fare') { cls = 'num'; var x = []; if (Number(t.tolls)) x.push('tolls ' + money(t.tolls)); if (Number(t.feesTotal)) x.push('fees ' + money(t.feesTotal)); if (x.length) title = x.join(' · '); }
    var key = t.id + '|' + col, er = errs[key];
    if (er && er.until > Date.now()) { cls += (er.ok ? ' dk-ok' : ' dk-err'); title = er.msg; }
    return '<td data-col="' + col + '"' + (cls ? ' class="' + cls.trim() + '"' : '') + (title ? ' title="' + esc(title) + '"' : '') + '>' + txt + '</td>';
  }
  function rowCls(t) {
    var c = 'st-booked';
    if (t.status === 'Dispatched') c = 'st-disp';
    else if (t.status === 'Completed') c = 'st-done';
    else if (t.status === 'Canceled' || t.status === 'No-Show' || t.status === 'Disregard') c = 'st-cxl';
    if (sel.id != null && String(sel.id) === String(t.id)) c += ' dk-sel';
    return c;
  }

  /* ---------- sorting / filtering ---------- */
  function sortVal(t, col) {
    switch (col) {
      case 'job': return Number(t.dispatchNo) || 0;
      case 'time': case 'date': { var d = pdt(t); return d ? d.getTime() : Infinity; }
      case 'ctime': { var c = new Date(t.createdAt || 0).getTime(); return isNaN(c) ? 0 : c; }
      case 'pl': return Number(t.pax) || 1;
      case 'fare': return Number(t.fare) || 0;
      case 'tel': return String(t.phone || '').replace(/\D/g, '');
      case 'st': return ['Dispatched', 'Booked', 'Completed', 'No-Show', 'Canceled', 'Disregard'].indexOf(t.status);
      default: return cellText(t, col).toUpperCase();
    }
  }
  function cmp(a, b) { if (a === b) return 0; if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1; return String(a) < String(b) ? -1 : 1; }
  function sortList(list, s) {
    return list.map(function (t, i) { return { t: t, i: i, v: sortVal(t, s.col), k: sortVal(t, 'time') }; })
      .sort(function (a, b) { var r = cmp(a.v, b.v) * s.dir; if (!r) r = cmp(a.k, b.k); if (!r) r = cmp(Number(a.t.dispatchNo) || 0, Number(b.t.dispatchNo) || 0); return r || (a.i - b.i); })
      .map(function (x) { return x.t; });
  }
  var filters = { trips: '', resv: '' };
  function matches(t, q) {
    if (!q) return true;
    var hay = [t.dispatchNo, t.puAddr, t.doAddr, t.passenger, t.phone, t.vtype, drvLabel(t), (findDriver(t.driverId) || {}).name, t.status, t.notes, t.date, mil(t.time), t.fare].join(' ').toUpperCase();
    var Q = String(q).toUpperCase().replace(/\s+/g, ' ').trim();
    if (hay.replace(/\s+/g, ' ').indexOf(Q) >= 0) return true;                       // the phrase as typed
    var dq = Q.replace(/\D/g, ''); if (dq.length >= 3 && dq.length === Q.replace(/[\s()\-.]/g, '').length && String(t.phone || '').replace(/\D/g, '').indexOf(dq) >= 0) return true;   // phone digits
    return false;
  }

  /* ---------- state ---------- */
  var sel = { id: null, grid: null };
  var colCur = { trips: 'pass', resv: 'pass' };
  var errs = {};          // id|col -> {msg, ok, until}
  var editing = null;     // {id, col, grid, kind, el, orig}
  var pendingRender = false, rendering = false;
  var root = null;        // the .dk element
  var order = { trips: [], resv: [] };   // ids in render order
  var pointerDown = false;

  /* ---------- DOM ---------- */
  function build() {
    if (root && document.body.contains(root)) return root;
    var old = byId('desk'); if (old) { root = old; return root; }
    root = document.createElement('div'); root.id = 'desk'; root.className = 'dk';
    root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Trips and Reservations desk');
    root.innerHTML =
      '<div class="dk-top"><span class="dk-title">Trips &amp; Reservations</span><span class="dk-clock" id="dkClock"></span><span class="dk-sp"></span>'
      + '<button type="button" class="dk-tbtn" data-dk="layout" id="dkLayoutBtn" title="Stack the grids or put them side by side">Side by side</button>'
      + '<button type="button" class="dk-tbtn" data-dk="old" id="dkOldBtn" title="Show or hide the old board panels below">Hide old board</button>'
      + '<button type="button" class="dk-tbtn" data-dk="print" title="Print both grids, one page each">Print</button>'
      + (IS_POP ? '' : '<button type="button" class="dk-tbtn" data-dk="pop" title="Open the desk on another monitor">Pop out</button>')
      + (IS_POP ? '' : '<button type="button" class="dk-tbtn" data-dk="hide" id="dkHideBtn" title="Hide the desk (Classic Jobs view toggle)">Hide</button>')
      + '</div>'
      + '<div class="dk-body" id="dkBody">'
      + pane('trips', 'Trips', 'Today') + '<div class="dk-split" id="dkSplit" role="separator" tabindex="0" aria-label="Drag to resize the grids" title="Drag to resize"></div>' + pane('resv', 'Reservations', 'Ahead')
      + '</div>'
      + '<div class="dk-bar" id="dkBar"></div>'
      + '<div class="dk-msg" id="dkMsg" role="status" aria-live="polite"></div>';
    bindRoot(root);
    return root;
  }
  function pane(key, title, sub) {
    return '<section class="dk-pane" data-grid="' + key + '" id="dkPane_' + key + '">'
      + '<div class="dk-phead"><span>' + title + '</span><span class="dk-n" id="dkN_' + key + '">' + sub + '</span><span class="dk-sp"></span>'
      + '<input type="search" class="dk-filter" data-grid="' + key + '" id="dkFilter_' + key + '" placeholder="Filter ' + title.toLowerCase() + '" aria-label="Filter ' + title + '" autocomplete="off"></div>'
      + '<div class="dk-scroll" tabindex="0" data-grid="' + key + '" id="dkScroll_' + key + '" role="grid" aria-label="' + title + '"><table class="dk-grid" id="dkGrid_' + key + '"></table></div></section>';
  }
  var BAR = [['Modify', 'classicModify', 'Open the selected job in the form'], ['New', 'classicNew', 'New job'], ['Dispatch', 'classicDispatch', 'Dispatch the selected job'], ['Cancel', 'deskCancel', 'Cancel the selected job'], ['LocPric', 'classicLocPric', 'Price it in the fare calculator'], ['ZSusp', 'classicZSusp', 'Hold a dispatched job (back to Booked)'], ['Inquire', 'classicInquire', 'Look up the caller'], ['10-4', 'classicTenFour', 'Acknowledge'], ['Sign', 'classicSign', 'Driver sign-in / fleet'], ['Dup', 'classicDup', 'Duplicate the selected job'], ['Drop', 'classicDrop', 'Mark dropped off (completed)'], ['\u22ef', 'menu', 'More actions (right-click a row)']];
  function renderBar() {
    var b = byId('dkBar'); if (!b) return;
    var t = sel.id != null ? findTrip(sel.id) : null;
    if (!b.firstChild) {
      b.innerHTML = BAR.map(function (x) { return '<button type="button" data-bar="' + x[1] + '" title="' + esc(x[2]) + '">' + esc(x[0]) + '</button>'; }).join('') + '<span class="dk-selinfo" id="dkSelInfo"></span>';
    }
    b.querySelectorAll('button[data-bar]').forEach(function (btn) { var k = btn.getAttribute('data-bar'); btn.disabled = !t && k !== 'classicNew' && k !== 'classicSign'; });
    var si = byId('dkSelInfo'); if (si) si.textContent = t ? ('#' + jobNo(t) + ' · ' + (t.passenger || 'no name') + ' · ' + (t.status || '') + ' · ' + (mil(t.time) || 'ASAP') + ' ' + fmtDate(t.date)) : 'Click a job to select it';
  }
  function say(msg, bad) { var m = byId('dkMsg'); if (m) { m.textContent = msg || ''; m.className = 'dk-msg' + (bad ? ' err' : ''); } }

  /* ---------- placement ---------- */
  function hostFor() {
    if (IS_POP) {
      var ph = byId('deskPopHost'); if (!ph) { ph = document.createElement('div'); ph.id = 'deskPopHost'; document.body.insertBefore(ph, document.body.firstChild); }
      return ph;
    }
    if (isSimpleBody()) {
      var ba = byId('boardArea'); if (!ba) return null;
      var sh = byId('deskSimpleHost'); if (!sh) { sh = document.createElement('div'); sh.id = 'deskSimpleHost'; }
      if (sh.parentNode !== ba || ba.firstChild !== sh) ba.insertBefore(sh, ba.firstChild);
      return sh;
    }
    var cw = byId('classicWrap'); if (!cw) return null;
    var body = cw.querySelector('.panel-body') || cw;
    var eh = byId('deskExpertHost'); if (!eh) { eh = document.createElement('div'); eh.id = 'deskExpertHost'; }
    if (eh.parentNode !== body) body.insertBefore(eh, body.firstChild);
    return eh;
  }
  function place() {
    var h = hostFor(); if (!h) return null;
    build();
    if (root.parentNode !== h) h.appendChild(root);
    var d = DS();
    var cw = byId('classicWrap'); if (cw) cw.classList.toggle('dk-on', true);
    var sh = byId('deskSimpleHost'); if (sh) sh.hidden = !d.on;
    /* Simple Board: when the desk was hidden (Expert toggle or Settings), offer a one-click way back right there */
    var sb = byId('dkSimpleShow'), ba0 = byId('boardArea');
    if (isSimpleBody() && !d.on && ba0) {
      if (!sb) { sb = document.createElement('button'); sb.type = 'button'; sb.id = 'dkSimpleShow'; sb.className = 'dk-tbtn'; sb.textContent = 'Show Trips & Reservations desk'; sb.addEventListener('click', act(function () { DS().on = true; save(); syncOn(); var r0 = byId('desk'); if (r0) focusGrid('trips'); })); }
      if (sb.parentNode !== ba0 || (sh && sh.parentNode === ba0 ? sb.previousSibling !== sh : ba0.firstChild !== sb)) ba0.insertBefore(sb, sh && sh.parentNode === ba0 ? sh.nextSibling : ba0.firstChild);
      sb.hidden = false;
    } else if (sb) sb.hidden = true;
    var ba = byId('boardArea'); if (ba) ba.classList.toggle('dk-hide-old', isSimpleBody() && d.panels === 'hide');
    var ob = byId('dkOldBtn'); if (ob) { ob.hidden = !isSimpleBody(); ob.textContent = d.panels === 'hide' ? 'Show old board' : 'Hide old board'; }
    var hb = byId('dkHideBtn'); if (hb) hb.hidden = isSimpleBody();
    if (!isSimpleBody()) expertShow();
    applyLayout();
    return h;
  }
  function applyLayout() {
    if (!root) return;
    var d = DS(), side = d.layout === 'side';
    root.classList.toggle('dk-side', side); root.classList.toggle('dk-stack', !side);
    var lb = byId('dkLayoutBtn'); if (lb) { lb.textContent = side ? 'Stacked' : 'Side by side'; lb.setAttribute('aria-pressed', side ? 'true' : 'false'); }
    var p = byId('dkPane_trips'); if (p) { p.classList.add('dk-first'); p.style.flex = '0 0 calc(' + (d.split * 100).toFixed(1) + '% - 3px)'; }
  }
  /* Expert: the "Classic Jobs view" panel is the desk; show it when settings.desk.on */
  function expertShow() {
    if (IS_POP || isSimpleBody()) return;
    var w = byId('classicWrap'), btn = byId('classicToggle'); if (!w) return;
    if (DS().on && w.style.display === 'none') { w.style.display = ''; }
    label();
  }
  function label() { var w = byId('classicWrap'), btn = byId('classicToggle'); if (!w || !btn) return; var shown = w.style.display !== 'none'; btn.textContent = shown ? '\u25b8 Hide Trips & Reservations desk' : '\ud83d\udda5 Trips & Reservations desk (classic)'; }

  /* ---------- render ---------- */
  function render() {
    if (rendering) return;
    if (editing) { pendingRender = true; return; }
    if (!IS_POP && POPOUT) return;
    rendering = true;
    try {
      if (!place()) return;
      pendingRender = false;
      var L = lists(), d = DS();
      drawGrid('trips', L.trips, d.sortTrips, L.now);
      drawGrid('resv', L.resv, d.sortResv, L.now);
      if (sel.id != null && !findTrip(sel.id)) sel = { id: null, grid: null };
      if (sel.id != null) { sel.grid = order.trips.indexOf(String(sel.id)) >= 0 ? 'trips' : (order.resv.indexOf(String(sel.id)) >= 0 ? 'resv' : sel.grid); }
      renderBar();
      var ck = byId('dkClock'); if (ck) { var n = L.now; ck.textContent = fmtDate(todayStr()) + ' ' + pad2(n.getHours()) + ':' + pad2(n.getMinutes()); }
    } catch (e) { log(e); } finally { rendering = false; }
  }
  function drawGrid(key, list, s, now) {
    var tb = byId('dkGrid_' + key); if (!tb) return;
    var q = filters[key], all = list.length;
    list = list.filter(function (t) { try { return matches(t, q); } catch (e) { return true; } });
    var cols = GRID_COLS[key];
    var h = '<colgroup>' + cols.map(function (c) { return '<col style="width:' + WIDTH[c] + '">'; }).join('') + '</colgroup><thead><tr>'
      + cols.map(function (c) { var on = s.col === c || (c === 'date' && s.col === 'time' && key === 'resv'); return '<th data-col="' + c + '" scope="col" title="' + esc((TIPS[c] ? TIPS[c] + ' · ' : '') + 'Click to sort') + '"' + (s.col === c ? ' aria-sort="' + (s.dir > 0 ? 'ascending' : 'descending') + '"' : '') + '>' + LABEL[c] + (s.col === c ? '<span class="dk-arrow">' + (s.dir > 0 ? '\u25b2' : '\u25bc') + '</span>' : '') + '</th>'; }).join('')
      + '</tr></thead><tbody>';
    var ids = [];
    if (!list.length) {
      h += '<tr class="dk-empty"><td colspan="' + cols.length + '">' + (q ? 'Nothing matches “' + esc(q) + '”.' : key === 'trips' ? 'No jobs on the board for today yet. Reservations move up here as pickup time gets close.' : 'No reservations ahead.') + '</td></tr>';
    } else if (key === 'resv') {
      var byDate = {}, dates = [];
      list.forEach(function (t) { var k = String(t.date || ''); if (!byDate[k]) { byDate[k] = []; dates.push(k); } byDate[k].push(t); });
      var ddir = (s.col === 'date' || s.col === 'time') ? s.dir : 1;
      dates.sort(function (a, b) { if (!a) return 1; if (!b) return -1; return (a < b ? -1 : a > b ? 1 : 0) * ddir; });
      dates.forEach(function (k) {
        h += '<tr class="dk-dhead" aria-hidden="true"><td colspan="' + cols.length + '">' + esc(longDate(k)) + ' &middot; ' + byDate[k].length + ' job' + (byDate[k].length > 1 ? 's' : '') + '</td></tr>';
        sortList(byDate[k], s.col === 'date' ? { col: 'time', dir: s.dir } : s).forEach(function (t) { ids.push(String(t.id)); h += rowHtml(t, cols, key, now); });
      });
    } else {
      sortList(list, s).forEach(function (t) { ids.push(String(t.id)); h += rowHtml(t, cols, key, now); });
    }
    order[key] = ids;
    tb.innerHTML = h + '</tbody>';
    var n = byId('dkN_' + key); if (n) n.textContent = (key === 'trips' ? 'Today ' + fmtDate(todayStr()) : 'Ahead') + ' · ' + (q ? list.length + ' of ' + all : all) + ' job' + (all === 1 ? '' : 's');
  }
  function rowHtml(t, cols, key, now) {
    var selCls = rowCls(t);
    return '<tr data-id="' + esc(t.id) + '" class="' + selCls + '" aria-selected="' + (/dk-sel/.test(selCls) ? 'true' : 'false') + '">' + cols.map(function (c) { var o = ''; try { o = cellHtml(t, c, key, now); } catch (e) { o = '<td data-col="' + c + '"></td>'; } return o; }).join('') + '</tr>';
  }
  function rowEl(grid, id) { var tb = byId('dkGrid_' + grid); return tb ? tb.querySelector('tr[data-id="' + cssq(id) + '"]') : null; }
  function cellEl(grid, id, col) { var r = rowEl(grid, id); return r ? r.querySelector('td[data-col="' + col + '"]') : null; }
  function gridOf(id) { id = String(id); if (order.trips.indexOf(id) >= 0) return 'trips'; if (order.resv.indexOf(id) >= 0) return 'resv'; return null; }

  /* ---------- selection ---------- */
  function select(id, opts) {
    opts = opts || {};
    if (id == null || !findTrip(id)) { sel = { id: null, grid: null }; render(); return false; }
    sel = { id: String(id), grid: gridOf(id) };
    try { classicSelId = sel.id; } catch (e) {}   /* the console's classic* buttons act on classicSelId */
    var ids = ['trips', 'resv'];
    ids.forEach(function (g) {
      var tb = byId('dkGrid_' + g); if (!tb) return;
      tb.querySelectorAll('tr.dk-sel').forEach(function (r) { r.classList.remove('dk-sel'); r.setAttribute('aria-selected', 'false'); });
    });
    var r = sel.grid ? rowEl(sel.grid, sel.id) : null;
    if (r) { r.classList.add('dk-sel'); r.setAttribute('aria-selected', 'true'); reveal(r); }
    renderBar();
    if (opts.focus && sel.grid) focusGrid(sel.grid);
    return !!r;
  }
  /* keep the row visible inside its own grid without scrolling the page */
  function reveal(r) {
    try {
      var sc = r.closest('.dk-scroll'); if (!sc) return;
      var th = sc.querySelector('thead'), headH = th ? th.offsetHeight : 0;
      var top = r.offsetTop, bot = top + r.offsetHeight;
      if (top - headH < sc.scrollTop) sc.scrollTop = Math.max(0, top - headH);
      else if (bot > sc.scrollTop + sc.clientHeight) sc.scrollTop = bot - sc.clientHeight;
    } catch (e) {}
  }
  function focusGrid(g) { var s = byId('dkScroll_' + (g || sel.grid || 'trips')); if (s) { try { s.focus({ preventScroll: true }); } catch (e) { try { s.focus(); } catch (e2) {} } } }
  function moveSel(g, delta) {
    var ids = order[g] || []; if (!ids.length) return;
    var i = ids.indexOf(String(sel.id));
    if (i < 0 || sel.grid !== g) i = delta > 0 ? -1 : ids.length;
    var j = Math.max(0, Math.min(ids.length - 1, i + delta));
    select(ids[j]);
  }

  /* ---------- open / actions ---------- */
  function openTrip(id) {
    var t = findTrip(id); if (!t) return false;
    if (IS_POP) { if (fn('pushToMain')) window.pushToMain('openTrip', t.id, t.dispatchNo); return true; }
    select(id);
    if (!fn('editTrip')) return false;
    window.editTrip(t.id);
    setTimeout(function () { try { var f = byId('d_passenger'); var p = f && f.closest ? f.closest('.panel') : null; if (p) p.scrollIntoView({ block: 'start' }); } catch (e) {} }, 400);
    say('#' + jobNo(t) + ' is in the form — change it and press Update Trip.');
    return true;
  }
  function withConfirm(f) { var c = window.confirm; window.confirm = function () { return true; }; try { return f(); } finally { window.confirm = c; } }
  function cancelSel(id) {
    var t = findTrip(id); if (!t) return;
    if (!(t.status === 'Booked' || t.status === 'Dispatched' || !t.status)) { say('#' + jobNo(t) + ' is already ' + t.status + '.'); return; }
    if (!window.confirm('Cancel job #' + jobNo(t) + (t.passenger ? ' (' + t.passenger + ')' : '') + '? It stays on record as Canceled.')) return;
    withConfirm(function () { call('cancelTrip', t.id); });
    render(); focusGrid();
  }
  window.deskCancel = function () { var t = sel.id != null ? findTrip(sel.id) : null; if (!t) { toast('Click a job in the list first.', true); return; } cancelSel(t.id); };
  function returnTrip(id) {
    var t = findTrip(id); if (!t) return null;
    var c = copy(t); if (!c) return null;
    c.id = uid(); var seq = Number(STATE.dispatchSeq); if (!isFinite(seq) || seq < 1) seq = 1 + trips().reduce(function (m, x) { return Math.max(m, okTrip(x) ? Number(x.dispatchNo) || 0 : 0); }, 0);
    c.dispatchNo = seq; STATE.dispatchSeq = seq + 1;
    c.puAddr = t.doAddr || ''; c.doAddr = t.puAddr || ''; c.stops = Array.isArray(t.stops) ? t.stops.slice().reverse() : [];
    c.status = 'Booked'; c.driverId = ''; c.vehicleId = ''; c.dispTime = ''; c.dropDate = ''; c.dropTime = ''; c.createdAt = new Date().toISOString();
    delete c.quote; delete c.eligibility; delete c._demo; delete c.paid; delete c.paidAt; c.returnOf = t.id;
    trips().unshift(c); save();
    call('refreshBoard'); select(c.id);
    toast('Return trip #' + jobNo(c) + ' made (' + shortAddr(c.puAddr) + ' \u2192 ' + shortAddr(c.doAddr) + ') — set its date and time.');
    if (fn('openEditOverlay')) call('openEditOverlay', c.id);
    return c;
  }
  function doStatus(t) {
    if (t.status === 'Booked' && !t.driverId) { say('Pick a driver first: double-click the Drvr cell.', true); return false; }
    if (t.status !== 'Booked' && t.status !== 'Dispatched') { say('#' + jobNo(t) + ' is ' + t.status + '. Use the menu (right-click) to reinstate it.'); return false; }
    var before = t.status; call('cycleStatus', t.id); render();
    if (t.status === before) { var r = t.eligibility && t.eligibility.ok === false ? (t.eligibility.reasons || [])[0] : ''; mark(t.id, 'st', r || 'Status not changed.', false); say('Not changed' + (r ? ' - ' + r : '.'), true); return false; }
    say('#' + jobNo(t) + ' \u2192 ' + t.status + '.'); return true;
  }
  function runAction(a, id, ev) {
    var t = findTrip(id); if (!t) return;
    switch (a) {
      case 'open': openTrip(id); break;
      case 'dispatch': if (t.status !== 'Booked') say('#' + jobNo(t) + ' is ' + t.status + '.'); else if (!t.driverId) { say('Pick a driver first.', true); startEdit(id, 'drvr', gridOf(id)); } else doStatus(t); break;
      case 'complete': if (t.status === 'Dispatched') doStatus(t); else if (t.status === 'Booked') say('#' + jobNo(t) + ' is not dispatched yet. Dispatch it first (the driver check runs there), then complete it.', true); else say('#' + jobNo(t) + ' is ' + t.status + '.'); break;
      case 'cancel': cancelSel(id); break;
      case 'noshow': call('noShowTrip', id); render(); break;
      case 'reinstate': call('reinstateTrip', id); render(); break;
      case 'dup': call('duplicateTrip', id); render(); break;
      case 'return': returnTrip(id); break;
      case 'text': if (window.Messages && typeof window.Messages.textPassenger === 'function') window.Messages.textPassenger(id, null, ev || null); else say('Texting is not set up on this console.', true); break;
      case 'phone': if (window.DriverLink && typeof window.DriverLink.sendJobToDriver === 'function') window.DriverLink.sendJobToDriver(id); else say('Send to phone is not set up on this console.', true); break;
      case 'print': call('printTicketById', id); break;
      case 'hist':
        if (!t.phone) { say('No phone on this job.', true); break; }
        if (window.CallerHist && typeof window.CallerHist.show === 'function') { var anchor = cellEl(gridOf(id), id, 'tel'); window.CallerHist.show(t.phone, anchor || null); }
        else if (fn('applyCaller')) call('applyCaller', t.phone);
        break;
    }
  }

  /* ---------- context menu ---------- */
  var menuEl = null;
  function closeMenu(refocus) { if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl); menuEl = null; if (refocus) focusGrid(); }
  function openMenu(id, x, y) {
    closeMenu();
    var t = findTrip(id); if (!t) return;
    var live = t.status === 'Booked' || t.status === 'Dispatched';
    var items = [['open', 'Open in form', true], ['dispatch', 'Dispatch', t.status === 'Booked'], ['complete', 'Complete', t.status === 'Dispatched'], ['cancel', 'Cancel', live], ['noshow', 'No-show', live]];
    if (!live && t.status !== 'Completed') items.push(['reinstate', 'Reinstate', true]);
    items = items.concat([['dup', 'Duplicate', true], ['return', 'Return trip', true], ['text', 'Text passenger', !!t.phone], ['phone', 'Send to phone', !!t.driverId], ['print', 'Print job sheet', true], ['hist', 'Caller history', !!t.phone]]);
    menuEl = document.createElement('div'); menuEl.className = 'dk-menu'; menuEl.setAttribute('role', 'menu');
    menuEl.innerHTML = '<div class="dk-mh">#' + esc(jobNo(t)) + ' ' + esc(t.passenger || '') + '</div>' + items.map(function (i) { return '<button type="button" role="menuitem" data-act="' + i[0] + '"' + (i[2] ? '' : ' disabled') + '>' + esc(i[1]) + '</button>'; }).join('');
    document.body.appendChild(menuEl);
    var w = menuEl.offsetWidth || 200, h = menuEl.offsetHeight || 300;
    menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
    menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
    menuEl.addEventListener('click', act(function (e) { var b = e.target.closest('button[data-act]'); if (!b || b.disabled) return; var a = b.getAttribute('data-act'); closeMenu(); runAction(a, id, e); }));
    menuEl.addEventListener('keydown', act(function (e) {
      var bs = Array.prototype.slice.call(menuEl.querySelectorAll('button:not([disabled])')), i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (bs[(i + 1) % bs.length] || bs[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (bs[(i - 1 + bs.length) % bs.length] || bs[0]).focus(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    }));
    var first = menuEl.querySelector('button:not([disabled])'); if (first) first.focus();
  }
  document.addEventListener('mousedown', function (e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);

  /* ---------- undo ---------- */
  var ownUndo = { snap: null, timer: null };
  function withUndo(label, id, f) {
    var S = window.Simple;
    if (S && typeof S.undoable === 'function') { try { return S.undoable(label, f, [String(id)]); } catch (e) { log(e); } }
    var t = findTrip(id), snap = t ? copy(t) : null, r = f();
    var now = findTrip(id);
    if (snap && now && JSON.stringify(now) !== JSON.stringify(snap)) showOwnUndo(label, snap);
    return r;
  }
  function showOwnUndo(label, snap) {
    var el = byId('undoDesk');
    if (!el) {
      el = document.createElement('div'); el.id = 'undoDesk'; el.setAttribute('role', 'status'); el.hidden = true;
      el.innerHTML = '<span id="undoDeskMsg"></span><button type="button" id="undoDeskBtn">Undo</button>';
      document.body.appendChild(el);
      byId('undoDeskBtn').addEventListener('click', act(function () {
        var s = ownUndo.snap; hideOwnUndo(); if (!s) return;
        var a = trips(); for (var i = 0; i < a.length; i++) if (okTrip(a[i]) && String(a[i].id) === String(s.id)) { a[i] = s; break; }
        save(); call('refreshBoard'); render(); toast('Undone.');
      }));
    }
    ownUndo.snap = snap; byId('undoDeskMsg').textContent = label; el.hidden = false;
    clearTimeout(ownUndo.timer); ownUndo.timer = setTimeout(hideOwnUndo, 10000);
  }
  function hideOwnUndo() { clearTimeout(ownUndo.timer); ownUndo.snap = null; var el = byId('undoDesk'); if (el) el.hidden = true; }

  /* ---------- in-cell editing ---------- */
  function vtypes() { var s = byId('d_vtype'), out = []; if (s && s.options) for (var i = 0; i < s.options.length; i++) out.push(s.options[i].value || s.options[i].text); return out.length ? out : ['Sedan', 'SUV Standard', 'SUV XL', 'Minivan', 'Van', 'Sprinter', 'Wheelchair Van']; }
  function driverOpts(t) {
    var h = '<option value="">\u2014 unassigned \u2014</option>';
    drivers().forEach(function (d) {
      if (!d || !d.id) return;
      if (d.active === false && d.id !== t.driverId) return;          // on-duty drivers only (the current one always listed)
      var bad = '';
      try { if (window.Ops && typeof window.Ops.eligibility === 'function') { var r = window.Ops.eligibility(d.id, t.vehicleId || '', t); if (r && !r.ok) bad = ' \u26d4'; } } catch (e) {}
      h += '<option value="' + esc(d.id) + '"' + (d.id === t.driverId ? ' selected' : '') + '>' + esc((d.carNo ? d.carNo + ' ' : '') + (d.name || d.id)) + bad + '</option>';
    });
    return h;
  }
  function editorHtml(t, kind, col) {
    switch (kind) {
      case 'driver': return '<select aria-label="Driver">' + driverOpts(t) + '</select>';
      case 'vtype': return '<select aria-label="Vehicle type">' + vtypes().map(function (v) { return '<option' + (v === t.vtype ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select>';
      case 'date': return '<input type="date" aria-label="Pickup date" value="' + esc(/^\d{4}-\d{2}-\d{2}$/.test(String(t.date || '')) ? t.date : '') + '">';
      case 'time': return '<input type="text" aria-label="Pickup time" placeholder="14:30 or 2:30pm" value="' + esc(mil(t.time)) + '">';
      case 'pax': return '<input type="number" min="1" max="60" step="1" aria-label="Passengers" value="' + esc(Number(t.pax) || 1) + '">';
      case 'fare': return '<input type="text" inputmode="decimal" aria-label="Fare" value="' + esc((Number(t.fare) || 0).toFixed(2)) + '">';
      case 'addr': return '<div class="ac-wrap"><input type="text" autocomplete="off" aria-label="' + (col === 'pu' ? 'Pick-up address' : 'Drop-off address') + '" value="' + esc(col === 'pu' ? t.puAddr || '' : t.doAddr || '') + '"><div class="ac-list" hidden></div></div>';
      default: return '<input type="text" aria-label="' + esc(LABEL[col]) + '" value="' + esc(col === 'tel' ? t.phone || '' : t.passenger || '') + '">';
    }
  }
  function startEdit(id, col, grid) {
    if (editing) finishEdit(true);
    closeMenu();
    var t = findTrip(id), kind = EDIT[col]; if (!t || !kind) return false;
    grid = grid || gridOf(id);
    if (sel.id !== String(id)) select(id);
    if (kind === 'status') { withUndo('#' + jobNo(t) + ' status', t.id, function () { doStatus(t); }); return true; }
    var td = cellEl(grid, id, col); if (!td) return false;
    colCur[grid] = col;
    td.innerHTML = editorHtml(t, kind, col); td.classList.add('dk-editing'); td.removeAttribute('title');
    var el = td.querySelector('input,select'); if (!el) return false;
    editing = { id: String(id), col: col, grid: grid, kind: kind, el: el, orig: String(el.value) };
    if (kind === 'addr' && fn('attachAC')) { try { window.attachAC(el); } catch (e) {} }
    el.addEventListener('keydown', act(onEditKey));
    el.addEventListener('blur', act(function () { var ed = editing; setTimeout(act(function () { if (editing && editing === ed && document.activeElement !== ed.el) finishEdit(true); }), 120); }));
    if (el.tagName === 'SELECT') el.addEventListener('change', act(function () { if (editing && editing.el === el) finishEdit(true, null, true); }));
    try { el.focus(); if (el.select && el.type !== 'number' && el.type !== 'date') el.select(); } catch (e) {}
    say('Editing ' + LABEL[col] + ' on #' + jobNo(t) + ' — Enter saves, Esc cancels, Tab saves and moves on.');
    return true;
  }
  function onEditKey(e) {
    if (!editing) return;
    if (e.key === 'Enter') { if (e.defaultPrevented) return; e.preventDefault(); e.stopPropagation(); finishEdit(true, null, true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishEdit(false, null, true); say('Edit cancelled.'); }
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); finishEdit(true, e.shiftKey ? -1 : 1, true); }
    else if (callerWaiting(e.key)) { finishEdit(true, null, false); /* let the key reach the caller-line handler */ }
    else if (/^F([1-9]|1[0-2])$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); if (e.key === 'F2') say('Already editing ' + LABEL[editing.col] + ' — Enter saves, Esc cancels.'); }
  }
  function nextEditable(grid, col, dir) {
    var cols = GRID_COLS[grid].filter(function (c) { return EDIT[c] && EDIT[c] !== 'status'; });
    var i = cols.indexOf(col); if (i < 0) return cols[0];
    return cols[(i + dir + cols.length) % cols.length];
  }
  function finishEdit(commitIt, moveDir, refocus) {
    var ed = editing; if (!ed) return null;
    editing = null;
    var r = null;
    try { if (commitIt) r = commit(ed); } catch (e) { log(e); r = { err: 'Not saved.' }; }
    render();
    if (r && r.err) mark(ed.id, ed.col, r.err, false);
    else if (r && r.ok) mark(ed.id, ed.col, r.msg || 'Saved', true);
    if (moveDir && !(r && r.err)) { var g = gridOf(ed.id) || ed.grid; startEdit(ed.id, nextEditable(g, ed.col, moveDir), g); return r; }
    if (refocus) focusGrid(gridOf(ed.id) || ed.grid);
    return r;
  }
  function mark(id, col, msg, ok) {
    var key = id + '|' + col; errs[key] = { msg: msg, ok: ok, until: Date.now() + (ok ? 2500 : 9000) };
    var g = gridOf(id), td = g ? cellEl(g, id, col) : null;
    if (td) { td.classList.remove('dk-ok', 'dk-err'); td.classList.add(ok ? 'dk-ok' : 'dk-err'); td.title = msg; }
    if (!ok) say(msg, true);
    setTimeout(function () { if (errs[key] && errs[key].until <= Date.now()) { delete errs[key]; var g2 = gridOf(id), td2 = g2 ? cellEl(g2, id, col) : null; if (td2) td2.classList.remove('dk-ok', 'dk-err'); } }, (ok ? 2500 : 9000) + 50);
  }
  /* time typed the way dispatchers type it: 14:30, 1430, 930, 2:30p, 2pm, 9 → "HH:MM" (or ASAP) */
  function parseTime(s) {
    s = String(s || '').trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
    if (!s) return null; if (/^(asap|now)$/.test(s)) return 'ASAP';
    var m = s.match(/^(\d{1,2})(?::?(\d{2}))?(a|p|am|pm)?$/); if (!m) return null;
    var h = +m[1], mi = m[2] ? +m[2] : 0, ap = m[3] ? m[3].charAt(0) : '';
    if (mi > 59) return null;
    if (ap) { if (h < 1 || h > 12) return null; if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0; }
    else if (h > 23) return null;
    return pad2(h) + ':' + pad2(mi);
  }
  /* a late-evening job retyped with an early-morning time (23:55 -> 00:10) most likely means tomorrow */
  function nextDayFor(t, hm) {
    if ((t.status !== 'Booked' && t.status !== 'Dispatched') || hm === 'ASAP' || t.date !== todayStr()) return null;   /* live jobs only */
    var now = new Date(); if (now.getHours() < 18) return null;
    var h = +hm.slice(0, 2); if (h >= 6) return null;
    var probe = pdt({ id: t.id, date: t.date, time: hm, createdAt: t.createdAt }); if (!probe || probe.getTime() >= now.getTime() - 60000) return null;
    return dateOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  }
  function pastOK(t, date, time) {
    if (t.status !== 'Booked' && t.status !== 'Dispatched') return true;
    var probe = { id: t.id, date: date, time: time, createdAt: t.createdAt }, d = pdt(probe);
    if (!d || time === 'ASAP' || d.getTime() >= Date.now() - 60000) return true;
    return window.confirm('Pickup ' + fmtDate(date) + ' ' + time + ' is in the past. Save it anyway?');
  }
  /* Save through the console's own edit-overlay path (every module's gate applies), out of sight. */
  function lastToast() { var el = byId('toast'); return el ? String(el.textContent || '') : ''; }
  function viaOverlay(t, patch) {
    if (!fn('openEditOverlay') || !fn('saveEditOvl')) return direct(t, patch);
    var keep = { tip: t.tip, payType: t.payType, notes: t.notes, driverId: t.driverId, vehicleId: t.vehicleId };
    var before = lastToast(), ok = false;
    document.body.classList.add('dk-silent');
    try {
      window.openEditOverlay(t.id);
      Object.keys(patch).forEach(function (k) { var el = byId(k); if (el) el.value = patch[k]; });
      var dv = byId('eo_drv'); if (dv && t.driverId && dv.value !== t.driverId) { var o = document.createElement('option'); o.value = t.driverId; o.textContent = t.driverId; dv.appendChild(o); dv.value = t.driverId; }
      window.saveEditOvl();
      var ov = byId('editOvl'); ok = !ov || ov.hidden;
      if (!ok) call('closeEditOvl');
    } finally { document.body.classList.remove('dk-silent'); }
    if (ok) {
      /* the overlay re-writes tip (whole dollars), payment and notes from its own boxes: keep what the trip had */
      var cur = findTrip(t.id) || t, dirty = false;
      ['tip', 'payType', 'notes', 'driverId', 'vehicleId'].forEach(function (k) { if (cur[k] !== keep[k] && keep[k] !== undefined) { cur[k] = keep[k]; dirty = true; } });
      if (dirty) save();
      call('refreshBoard');
      return { ok: true };
    }
    var msg = lastToast(); if (msg === before && !msg) msg = 'Not saved.';
    return { err: msg || 'Not saved.' };
  }
  function heldByStaleDriver(t) {
    if (!t || !t.driverId || !window.Ops || typeof window.Ops.eligibility !== 'function') return false;
    try { var r = window.Ops.eligibility(t.driverId, t.vehicleId || '', t); return !!(r && r.ok === false); } catch (e) { return false; }
  }
  function direct(t, patch) {
    var map = { eo_date: 'date', eo_time: 'time', eo_pass: 'passenger', eo_phone: 'phone', eo_pu: 'puAddr', eo_do: 'doAddr' };
    Object.keys(patch).forEach(function (k) { if (map[k]) t[map[k]] = map[k] === 'time' ? mil(patch[k]) : patch[k]; else if (k === 'eo_fare') t.fare = Number(patch[k]) || 0; });
    save(); call('refreshBoard'); return { ok: true };
  }
  function reprice(t, pu, doo, vt) {
    var Q = window.Quote; if (!Q || typeof Q.engineQuote !== 'function') return null;
    try {
      var eq = Q.engineQuote({ pu: pu, doo: doo, stops: (t.stops || []).map(function (s) { return { addr: s && s.addr != null ? s.addr : s }; }), vtype: vt || t.vtype || 'SUV Standard', rt: !!t.rt, dt: pdt(t) || new Date(), phone: t.phone || '' });
      return eq && Number(eq.total) > 0 ? Number(eq.total) : null;
    } catch (e) { return null; }
  }
  function auditEdit(t, field, from, to) {
    try { if (window.Recover && typeof window.Recover.log === 'function') window.Recover.log('edit', { ref: '#' + jobNo(t), field: field, from: String(from == null ? '' : from), to: String(to == null ? '' : to), how: 'desk' }); } catch (e) {}
  }
  /* reasons an assigned driver/car would newly fail if the trip changed as in `patch` (ops.js gate) */
  function newIneligible(t, patch) {
    if (!t.driverId || !window.Ops || typeof window.Ops.eligibility !== 'function') return '';
    try {
      var b = window.Ops.eligibility(t.driverId, t.vehicleId || '', t), a = window.Ops.eligibility(t.driverId, t.vehicleId || '', Object.assign({}, t, patch));
      if (!a || a.ok !== false) return '';
      var had = (b && b.reasons) || [], fresh = (a.reasons || []).filter(function (r) { return had.indexOf(r) < 0; });
      return fresh.length ? fresh[0] : '';
    } catch (e) { return ''; }
  }
  function commit(ed) {
    var t = findTrip(ed.id); if (!t) return { err: 'That job is gone.' };
    var v = String(ed.el.value == null ? '' : ed.el.value).trim();
    if (v === String(ed.orig).trim()) return null;
    var no = '#' + jobNo(t);
    switch (ed.kind) {
      case 'driver': {
        var before = t.driverId || '';
        call('assignDriver', t.id, v);
        var now = findTrip(ed.id) || t;
        if ((now.driverId || '') !== v) {
          var why = (now.eligibility && now.eligibility.ok === false && (now.eligibility.reasons || [])[0]) || '';
          if (!why && window.Ops && typeof window.Ops.eligibility === 'function') { try { var r = window.Ops.eligibility(v, now.vehicleId || '', now); if (r && !r.ok) why = r.reasons[0]; } catch (e) {} }
          return { err: 'Not assigned - ' + (why || lastToast() || 'refused') };
        }
        call('refreshBoard');
        var dn = findDriver(v); return { ok: true, msg: v ? (dn ? dn.name : 'Driver') + ' assigned to ' + no : 'Driver cleared on ' + no };
      }
      case 'pax': {
        var n = Math.round(Number(v)); if (!(n >= 1 && n <= 60)) return { err: 'Passengers: type a number from 1 to 60.' };
        var pb = Number(t.pax) || 1;
        withUndo(no + ' passengers ' + n, t.id, function () { t.pax = n; save(); call('refreshBoard'); });
        auditEdit(t, 'pax', pb, n);
        return { ok: true };
      }
      case 'vtype': {
        if (!v) return null;
        var bad = newIneligible(t, { vtype: v });
        if (bad) return { err: 'Not changed - ' + bad + '. Change the driver or car first.' };
        var vb = t.vtype || '', fOld = Number(t.fare) || 0;
        var eqOld = (t.puAddr && t.doAddr) ? reprice(t, t.puAddr, t.doAddr, vb || null) : null;
        var eqNew = (t.puAddr && t.doAddr) ? reprice(t, t.puAddr, t.doAddr, v) : null;
        /* re-price from the rate book like an address edit does; an owner-approved override price stays, with a warning */
        var engineFare = !fOld || (eqOld != null && Math.abs(eqOld - fOld) < 0.005) || !(t.quote && t.quote.source === 'override');
        var vr = withUndo(no + ' vehicle ' + v, t.id, function () {
          t.vtype = v; save();
          if (eqNew != null && Math.abs(eqNew - fOld) >= 0.005 && engineFare) {
            var fr = viaOverlay(t, { eo_fare: eqNew.toFixed(2) });
            var cur = findTrip(t.id) || t;
            if (fr && fr.err && (Number(cur.fare) || 0) !== fOld) { cur.fare = fOld; save(); }
            return fr;
          }
          call('refreshBoard'); return { ok: true };
        });
        auditEdit(t, 'vtype', vb, v);
        if (vr && vr.err) return { ok: true, msg: 'Vehicle saved; fare kept at ' + money(fOld) + ' (' + vr.err + ')' };
        if (eqNew != null && Math.abs(eqNew - fOld) >= 0.005) {
          if (engineFare) { toast(no + ' re-priced for ' + v + ': ' + money(fOld) + ' \u2192 ' + money(eqNew) + '.'); return { ok: true, msg: 'Re-priced ' + money(fOld) + ' \u2192 ' + money(eqNew) }; }
          toast(no + ' is now ' + v + '. Rate book price is ' + money(eqNew) + '; fare kept at ' + money(fOld) + '.', true);
          mark(t.id, 'fare', 'Rate book price for ' + v + ' is ' + money(eqNew), false);
          return { ok: true, msg: 'Book price now ' + money(eqNew) };
        }
        return { ok: true };
      }
      case 'time': {
        var hm = parseTime(v); if (!hm) return { err: 'Time not understood. Type 14:30, 1430 or 2:30pm.' };
        if (hm === mil(t.time)) return null;
        var nx = nextDayFor(t, hm);
        if (nx && window.confirm(hm + ' is past midnight. Book it for ' + fmtDate(nx) + ' ' + hm + ' (tomorrow)?')) {
          return withUndo(no + ' pickup ' + fmtDate(nx) + ' ' + hm, t.id, function () { return viaOverlay(t, { eo_date: nx, eo_time: hm }); });
        }
        if (!pastOK(t, t.date, hm)) return { err: 'Not changed.' };
        return withUndo(no + ' pickup ' + hm, t.id, function () { return viaOverlay(t, { eo_time: hm }); });
      }
      case 'date': {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { err: 'Pick a date.' };
        if (!pastOK(t, v, mil(t.time))) return { err: 'Not changed.' };
        return withUndo(no + ' date ' + fmtDate(v), t.id, function () { return viaOverlay(t, { eo_date: v }); });
      }
      case 'text': {
        var p = ed.col === 'tel' ? { eo_phone: v } : { eo_pass: v };
        if (heldByStaleDriver(t)) {
          /* a name or phone fix does not touch the driver: do not make the dispatcher clear a lapsed driver first */
          var fld = ed.col === 'tel' ? 'phone' : 'passenger', was = t[fld];
          withUndo(no + ' ' + LABEL[ed.col].toLowerCase() + ' changed', t.id, function () { t[fld] = v; save(); call('refreshBoard'); return { ok: true }; });
          auditEdit(t, fld, was, v);
          say(no + ' ' + LABEL[ed.col].toLowerCase() + ' saved. The driver on this job is no longer eligible - change the driver before dispatch.', true);
          return { ok: true, msg: 'Saved. Note: the driver on this job is no longer eligible' };
        }
        return withUndo(no + ' ' + LABEL[ed.col].toLowerCase() + ' changed', t.id, function () { return viaOverlay(t, p); });
      }
      case 'fare': {
        var f = Number(v.replace(/[^0-9.\-]/g, '')); if (!isFinite(f) || f < 0 || v.replace(/[^0-9.]/g, '') === '') return { err: 'Fare: type an amount like 45 or 45.50.' };
        if (Math.abs(f - (Number(t.fare) || 0)) < 0.005) return null;
        var fb = Number(t.fare) || 0;
        var res = withUndo(no + ' fare ' + money(f), t.id, function () { return viaOverlay(t, { eo_fare: f.toFixed(2) }); });
        var after = findTrip(ed.id) || t;
        if (res && res.err && (Number(after.fare) || 0) !== fb) after.fare = fb;   // never leave a refused price behind
        return res;
      }
      case 'addr': {
        if (ed.col === 'pu' && !v) return { err: 'The pick-up cannot be blank.' };
        var pu = ed.col === 'pu' ? v : (t.puAddr || ''), doo = ed.col === 'do' ? v : (t.doAddr || '');
        var patch = {}; patch[ed.col === 'pu' ? 'eo_pu' : 'eo_do'] = v;
        var price = (pu && doo) ? reprice(t, pu, doo) : null, oldFare = Number(t.fare) || 0;
        if (price != null && Math.abs(price - oldFare) >= 0.005) patch.eo_fare = price.toFixed(2);
        var out = withUndo(no + ' ' + (ed.col === 'pu' ? 'pick-up' : 'drop-off') + ' changed', t.id, function () { return viaOverlay(t, patch); });
        if (out && out.ok && patch.eo_fare) { out.msg = 'Re-priced ' + money(oldFare) + ' \u2192 ' + money(price); toast(no + ' re-priced from the rate book: ' + money(oldFare) + ' \u2192 ' + money(price) + '.'); }
        return out;
      }
    }
    return null;
  }

  /* ---------- events ---------- */
  function rowIdFrom(e) { var tr = e.target && e.target.closest ? e.target.closest('tr[data-id]') : null; return tr ? tr.getAttribute('data-id') : null; }
  function bindRoot(r) {
    r.addEventListener('click', act(function (e) {
      var b = e.target.closest('[data-dk]');
      if (b) {
        var k = b.getAttribute('data-dk');
        if (k === 'layout') layout();
        else if (k === 'print') printDesk();
        else if (k === 'pop') openPopout();
        else if (k === 'hide') { if (fn('toggleClassic')) window.toggleClassic(); }
        else if (k === 'old') { var d = DS(); d.panels = d.panels === 'hide' ? 'show' : 'hide'; save(); place(); }
        return;
      }
      var bb = e.target.closest('button[data-bar]');
      if (bb) {
        var f = bb.getAttribute('data-bar');
        if (f === 'menu') { if (sel.id == null) { toast('Click a job in the list first.', true); return; } var rc = bb.getBoundingClientRect(); openMenu(sel.id, rc.left, rc.top - 280); return; }
        if (f === 'classicDrop' && sel.id != null) { var st0 = findTrip(sel.id); if (st0 && st0.status === 'Booked') { runAction('complete', sel.id); return; } }
        try { classicSelId = sel.id; } catch (er) {}
        if (fn(f)) window[f](); render(); return;
      }
      var th = e.target.closest('th[data-col]');
      if (th) {
        var g = th.closest('[data-grid]').getAttribute('data-grid'), col = th.getAttribute('data-col'), d2 = DS(), key = g === 'trips' ? 'sortTrips' : 'sortResv';
        var cur = d2[key]; d2[key] = { col: col, dir: cur.col === col ? -cur.dir : 1 }; save(); render(); return;
      }
      if (e.target.closest('.dk-editing')) return;
      var id = rowIdFrom(e); if (id != null) { var td = e.target.closest('td[data-col]'), gg = e.target.closest('[data-grid]').getAttribute('data-grid'); if (td) colCur[gg] = td.getAttribute('data-col'); select(id); focusGrid(gg); }
    }));
    r.addEventListener('dblclick', act(function (e) {
      if (e.target.closest('.dk-editing') || e.target.closest('th')) return;
      var id = rowIdFrom(e); if (id == null) return;
      var td = e.target.closest('td[data-col]'), col = td ? td.getAttribute('data-col') : '', g = e.target.closest('[data-grid]').getAttribute('data-grid');
      if (EDIT[col]) startEdit(id, col, g); else openTrip(id);
    }));
    r.addEventListener('contextmenu', act(function (e) {
      var id = rowIdFrom(e); if (id == null || e.target.closest('.dk-editing')) return;
      e.preventDefault(); select(id); openMenu(id, e.clientX, e.clientY);
    }));
    r.addEventListener('input', act(function (e) { var f = e.target.closest('.dk-filter'); if (!f) return; filters[f.getAttribute('data-grid')] = f.value.trim(); render(); }));
    r.addEventListener('keydown', act(function (e) {
      var f = e.target.closest ? e.target.closest('.dk-filter') : null;
      if (f) { if (e.key === 'Escape') { f.value = ''; filters[f.getAttribute('data-grid')] = ''; render(); e.stopPropagation(); } else if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); var g0 = f.getAttribute('data-grid'); focusGrid(g0); if (order[g0].length) select(order[g0][0]); } return; }
      var sc = e.target.classList && e.target.classList.contains('dk-scroll') ? e.target : null;
      if (e.target.id === 'dkSplit') { if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); var d = DS(); d.split = Math.max(0.15, Math.min(0.85, d.split + ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -0.05 : 0.05))); applyLayout(); save(); } return; }
      if (!sc) return;
      var g = sc.getAttribute('data-grid');
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); moveSel(g, 1); break;
        case 'ArrowUp': e.preventDefault(); moveSel(g, -1); break;
        case 'PageDown': e.preventDefault(); moveSel(g, 12); break;
        case 'PageUp': e.preventDefault(); moveSel(g, -12); break;
        case 'Home': e.preventDefault(); if (order[g].length) select(order[g][0]); break;
        case 'End': e.preventDefault(); if (order[g].length) select(order[g][order[g].length - 1]); break;
        case 'Enter': e.preventDefault(); if (sel.id != null) openTrip(sel.id); break;
        case ' ': e.preventDefault(); if (sel.id == null || sel.grid !== g) moveSel(g, 1); else select(sel.id); break;
        case 'Delete': e.preventDefault(); if (sel.id != null) cancelSel(sel.id); break;
        case 'F2': if (callerWaiting('F2')) break; e.preventDefault(); e.stopPropagation(); if (sel.id != null) startEdit(sel.id, EDIT[colCur[g]] ? colCur[g] : 'pass', g); break;
        case 'ArrowRight': case 'ArrowLeft': { e.preventDefault(); var cols = GRID_COLS[g], i = cols.indexOf(colCur[g]); colCur[g] = cols[Math.max(0, Math.min(cols.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))]; say('Column: ' + LABEL[colCur[g]] + (EDIT[colCur[g]] ? ' — F2 or double-click to edit' : '')); break; }
        case 'Tab': if (!e.shiftKey && g === 'trips') { e.preventDefault(); focusGrid('resv'); if (sel.grid !== 'resv' && order.resv.length) select(order.resv[0]); } else if (e.shiftKey && g === 'resv') { e.preventDefault(); focusGrid('trips'); if (sel.grid !== 'trips' && order.trips.length) select(order.trips[0]); } break;
        case 'ContextMenu': case 'F10':
          if (e.key === 'F10' && !e.shiftKey) break;
          e.preventDefault(); if (sel.id != null) { var re = rowEl(sel.grid, sel.id), rc = re ? re.getBoundingClientRect() : { left: 40, bottom: 40 }; openMenu(sel.id, rc.left + 40, rc.bottom); } break;
        case 'Escape': if (sel.id != null) { e.stopPropagation(); } break;
      }
    }));
    r.addEventListener('mousedown', function () { pointerDown = true; setTimeout(function () { pointerDown = false; }, 1500); }, true);
    document.addEventListener('mouseup', function () { setTimeout(function () { pointerDown = false; }, 0); }, true);
    r.addEventListener('focusin', act(function (e) {
      if (pointerDown) return;      // a mouse click selects the row it lands on
      var sc = e.target.classList && e.target.classList.contains('dk-scroll') ? e.target : null; if (!sc) return;
      var g = sc.getAttribute('data-grid');
      if ((sel.id == null || sel.grid !== g) && order[g].length) select(order[g][0]);
    }));
    /* splitter drag */
    r.addEventListener('pointerdown', act(function (e) {
      if (e.target.id !== 'dkSplit') return;
      e.preventDefault();
      var body = byId('dkBody'), sp = e.target; if (!body) return;
      try { sp.setPointerCapture(e.pointerId); } catch (er) {}
      var mv = act(function (ev) {
        var rc = body.getBoundingClientRect(), side = DS().layout === 'side';
        var f = side ? (ev.clientX - rc.left) / rc.width : (ev.clientY - rc.top) / rc.height;
        DS().split = Math.max(0.15, Math.min(0.85, Math.round(f * 100) / 100)); applyLayout();
      });
      var up = act(function () { sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up); save(); });
      sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
    }));
  }

  /* ---------- layout / pop-out / print ---------- */
  function layout(mode) {
    var d = DS();
    d.layout = (mode === 'stack' || mode === 'side') ? mode : (d.layout === 'side' ? 'stack' : 'side');
    save(); applyLayout(); return d.layout;
  }
  function openPopout() {
    if (fn('openScreen')) { window.openScreen('desk'); return true; }
    try { var w = window.open(location.href.replace(/[?#].*$/, '') + '?screen=desk', 'skyway_desk', 'width=1200,height=800,resizable=yes,scrollbars=yes'); if (w) { w.focus(); return true; } } catch (e) {}
    toast('Allow pop-ups for this page, then try again.', true); return false;
  }
  function printTable(list, cols, withGroups) {
    var h = '<table><thead><tr>' + cols.map(function (c) { return '<th>' + LABEL[c] + '</th>'; }).join('') + '</tr></thead><tbody>';
    var now = new Date(), lastDate = null;
    if (!list.length) h += '<tr><td colspan="' + cols.length + '">None.</td></tr>';
    list.forEach(function (t) {
      if (withGroups && t.date !== lastDate) { lastDate = t.date; h += '<tr><th colspan="' + cols.length + '">' + esc(longDate(t.date)) + '</th></tr>'; }
      h += '<tr>' + cols.map(function (c) { var v = cellText(t, c); if (c === 'pu') v = t.puAddr || ''; if (c === 'do') v = t.doAddr || ''; if (c === 'time' && t.status === 'Booked') { var cd = countdown(t, now); if (cd) v += ' (' + cd + ')'; } return '<td>' + esc(v) + '</td>'; }).join('') + '</tr>';
    });
    return h + '</tbody></table>';
  }
  function printDesk() {
    var L = lists(), d = DS();
    var T = sortList(L.trips, d.sortTrips), R = L.resv.slice().sort(function (a, b) { var x = String(a.date || '9999'), y = String(b.date || '9999'); if (x !== y) return x < y ? -1 : 1; return cmp(sortVal(a, 'time'), sortVal(b, 'time')); });
    var co = (settings().company || settings().companyName || '');
    var stamp = fmtDate(todayStr()) + ' ' + new Date().toTimeString().slice(0, 5);
    var html = '<div class="dk-print"><div class="dk-pb"><h2>' + esc(co ? co + ' — ' : '') + 'Trips · today ' + esc(fmtDate(todayStr())) + ' · ' + T.length + ' jobs</h2>' + printTable(T, GRID_COLS.trips, false) + '<div style="font-size:10px;margin-top:4px;">Printed ' + esc(stamp) + '</div></div>'
      + '<div><h2>Reservations ahead · ' + R.length + ' jobs</h2>' + printTable(R, GRID_COLS.resv, true) + '<div style="font-size:10px;margin-top:4px;">Printed ' + esc(stamp) + '</div></div></div>';
    if (fn('openPrint')) { window.openPrint(html); return html; }
    try { var w = window.open('', 'skyway_desk_print'); if (w) { w.document.write('<!doctype html><title>Desk sheet</title>' + html); w.document.close(); w.focus(); } } catch (e) {}
    return html;
  }

  /* ---------- Settings panel ---------- */
  var PANEL_ID = 'deskSettings';
  function renderPanel() {
    if (POPOUT) return;
    var view = byId('view-settings'); if (!view) return;
    var p = byId(PANEL_ID);
    if (!p) {
      p = document.createElement('div'); p.className = 'panel'; p.id = PANEL_ID;
      view.appendChild(p);
      p.addEventListener('change', act(function (e) {
        var el = e.target, d = DS();
        if (el.id === 'dk_on') { d.on = !!el.checked; save(); syncOn(); }
        else if (el.id === 'dk_layout') { layout(el.value); }
        else if (el.id === 'dk_lead') { var n = Math.round(Number(el.value)); if (n >= 5 && n <= 720) { d.leadMin = n; save(); render(); } else el.value = d.leadMin; }
        else if (el.id === 'dk_panels') { d.panels = el.checked ? 'hide' : 'show'; save(); place(); }
      }));
      p.addEventListener('click', act(function (e) { if (e.target.id === 'dk_pop') openPopout(); else if (e.target.id === 'dk_print') printDesk(); }));
    }
    var d = DS();
    p.innerHTML = '<div class="panel-head">Trips &amp; Reservations desk</div><div class="panel-body">'
      + '<p class="hint" style="margin-top:0;">Both grids up at once, like the old program. Click a row to select it, double-click a cell to change it, right-click for more.</p>'
      + '<label class="fld" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" id="dk_on" style="width:auto;"' + (d.on ? ' checked' : '') + '> <span class="lbl" style="margin:0;">Show the desk on the dispatch screen</span></label>'
      + '<label class="fld"><span class="lbl">Layout</span><select id="dk_layout"><option value="stack"' + (d.layout === 'stack' ? ' selected' : '') + '>Stacked (Trips above Reservations)</option><option value="side"' + (d.layout === 'side' ? ' selected' : '') + '>Side by side</option></select></label>'
      + '<label class="fld"><span class="lbl">“DUE” badge, minutes before pickup</span><input type="number" id="dk_lead" min="5" max="720" step="5" value="' + d.leadMin + '"></label>'
      + '<label class="fld" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" id="dk_panels" style="width:auto;"' + (d.panels === 'hide' ? ' checked' : '') + '> <span class="lbl" style="margin:0;">Simple mode: hide the old board panels under the desk</span></label>'
      + '<div class="btn-row"><button type="button" class="btn btn-navy btn-sm" id="dk_pop">Open desk on another screen</button><button type="button" class="btn btn-ghost btn-sm" id="dk_print">Print desk sheet</button></div>'
      + '<p class="hint">Rows move from Reservations to Trips when the board brings them in (' + (Number(settings().leadMins) ? Number(settings().leadMins) + ' min' : 'the board lead time') + ' before pickup, set on the board).</p></div>';
    fileUnderDisplay();
  }
  function fileUnderDisplay() {
    var p = byId(PANEL_ID), body = byId('setupSecBody_display'); if (!p || !body || p.parentNode === body) return;
    var home = p.closest ? p.closest('.setup-sec-body') : null;
    if (home && home.id !== 'setupSecBody_other') return;
    p.setAttribute('data-setup-rank', '40');
    var kids = body.children, before = null;
    for (var i = 0; i < kids.length; i++) { if ((Number(kids[i].getAttribute('data-setup-rank')) || 0) > 40) { before = kids[i]; break; } }
    body.insertBefore(p, before);
    var ob = byId('setupSecBody_other'), os = byId('setupSec_other');
    if (ob && os && !ob.children.length) { os.hidden = true; var oc = document.querySelector('.setup-chip[data-sec="other"]'); if (oc) oc.hidden = true; }
  }
  function syncOn() {
    var d = DS(), w = byId('classicWrap');
    if (!isSimpleBody() && w) { var shown = w.style.display !== 'none'; if (shown !== d.on) { w.style.display = d.on ? '' : 'none'; } label(); }
    place(); render();
  }

  /* ---------- wraps ---------- */
  function installWraps() {
    wrap('refreshBoard', function (o) { return function () { var r = o.apply(this, arguments); try { render(); } catch (e) { log(e); } return r; }; });
    wrap('renderClassic', function (o) { return function () { var r = o.apply(this, arguments); try { render(); } catch (e) { log(e); } return r; }; });
    wrap('toggleClassic', function (o) {
      return function () {
        var r = o.apply(this, arguments);
        try { var w = byId('classicWrap'); if (w && !isSimpleBody()) { DS().on = w.style.display !== 'none'; save(); } label(); render(); } catch (e) { log(e); }
        return r;
      };
    });
    wrap('renderSettings', function (o) { return function () { var r = o.apply(this, arguments); try { renderPanel(); } catch (e) { log(e); } return r; }; });
  }

  /* ---------- public API ---------- */
  window.Desk = {
    _loaded: true,
    render: function () { render(); },
    select: function (id) { var ok = select(id, { focus: true }); return ok; },
    selected: function () { return sel.id; },
    openPopout: openPopout,
    layout: layout,
    print: printDesk,
    lists: function () { var L = lists(); return { trips: L.trips.map(function (t) { return t.id; }), resv: L.resv.map(function (t) { return t.id; }) }; },
    order: function () { return { trips: order.trips.slice(), resv: order.resv.slice() }; },
    edit: function (id, col) { return startEdit(id, col, gridOf(id)); },
    open: openTrip,
    menu: function (id) { var g = gridOf(id), r = g ? rowEl(g, id) : null, rc = r ? r.getBoundingClientRect() : { left: 40, bottom: 40 }; openMenu(id, rc.left + 40, rc.bottom); },
    action: runAction,
    returnTrip: returnTrip,
    parseTime: parseTime,
    settings: DS,
    isPopout: function () { return IS_POP; }
  };

  /* ---------- boot ---------- */
  function ensureCss() {
    try {
      var have = Array.prototype.some.call(document.querySelectorAll('link[rel="stylesheet"],style'), function (n) { return /desk\.css(\?|$)/.test(n.getAttribute('href') || '') || n.id === 'deskCss' || /\.dk-grid\{/.test(n.textContent || ''); });
      if (!have) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'desk.css'; l.id = 'deskCss'; document.head.appendChild(l); }
    } catch (e) {}
  }
  function boot() {
    var before = JSON.stringify(settings().desk || null);
    DS();
    if (!POPOUT && JSON.stringify(settings().desk) !== before) save();
    if (POPOUT && !IS_POP) return;            // other pop-outs: no desk UI
    ensureCss();
    installWraps();
    if (IS_POP) { try { document.title = 'Skyway — Trips & Reservations desk'; var sub = document.querySelector('.brand .sub'); if (sub) sub.textContent = 'Pop-out · Trips & Reservations desk'; } catch (e) {} }
    expertShow();
    render();
    try { renderPanel(); } catch (e) { log(e); }
    setInterval(function () { try { if (!editing && !menuEl) render(); } catch (e) {} }, 30000);
    try {
      var lastMode = isSimpleBody() + '|' + (document.body.dataset.simpleMode || '');
      new MutationObserver(function () {
        var m = isSimpleBody() + '|' + (document.body.dataset.simpleMode || '');
        if (m === lastMode) return; lastMode = m;
        try { expertShow(); place(); render(); } catch (e) { log(e); }
      }).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-simple-mode'] });
    } catch (e) {}
    try { var sv = byId('view-settings'); if (sv && window.MutationObserver) new MutationObserver(function () { if (byId('setupSecBody_display') && byId(PANEL_ID) && !(byId(PANEL_ID).parentNode && byId(PANEL_ID).parentNode.id === 'setupSecBody_display')) fileUnderDisplay(); if (!byId(PANEL_ID)) renderPanel(); }).observe(sv, { childList: true }); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
