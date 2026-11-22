/* ======================================================================
   Skyway — recurring.js  (standing / repeat rides — TURNAROUND-PLAN build row 6)

   "Repeat this ride" on a trip (Board row, Trips tab row, Book form):
   a weekly pattern (weekday set, time, same driver preferred, pay type /
   account, start date, optional end date) stored in STATE.recurring[].
   Children are ordinary Booked trips (trip.recurringId = series id), created
   for today and the next 14 days on load and once a day. Generation is
   idempotent: series.children[] holds exactly one entry per calendar date, so
   re-running never duplicates a ride, and a child the dispatcher deleted or
   canceled is never resurrected unless "Restore missing dates" is pressed.

   STATE.recurring[] = {
     id, templateTripId,
     template: {passenger, phone, puAddr, doAddr, stops[], fare, tolls, vtype, pax, rt,
                payType, accountId, driverId, vehicleId, notes},   // snapshot of the trip at creation
     pattern: {weekdays:[0-6], time:'HH:MM', sameDriver:true, payType, accountId, driverId},
     startDate:'YYYY-MM-DD', endDate:'' | 'YYYY-MM-DD',
     status:'active'|'paused'|'stopped',
     nextGenerateUntil:'YYYY-MM-DD',           // children exist for every pattern date up to here
     children:[{date, tripId, template?:true, imported?:true, removed?:true, dropped?:true, gated?:true}],
                                              // gated: created without its driver because Ops.eligibility refused him for that date
     createdAt, updatedAt }
   trips[].recurringId = series id (children and the template / imported trips).

   UI: ↻ Repeat / ↻ Series buttons on Board + Trips rows (wraps sheetRow and
   tripActions), a ↻ chip after the job number on children, a "Repeat this
   ride every week" block under Notes in the Book form (wired through a
   capture/bubble pair on #d_save like ops.js / crm.js), a "Standing rides"
   panel at the bottom of the board (series list + import suggestions:
   same phone + same route + weekly spacing, or "STANDING" in Notes).
   Everything is reachable in Simple mode (Today / Book / Board) and in Expert
   mode; pop-out windows are skipped like the other modules.

   Eligibility: creating a child with the series driver is an assignment, so each child is checked with
   Ops.eligibility for ITS OWN date (generate, restore, driver changes pushed to future rides). A refused
   child is created without a driver and stamped (trip.eligibility.standingBlank); the Board row, the
   Standing rides panel and a Needs-you line say so, one toast per series per run. Warn-only mode keeps
   the driver and stamps. Without ops.js nothing changes.

   Membership: a trip belongs to a series only when that series lists the trip's id
   in children[] (trip.recurringId alone is not enough). Board "Copy" (duplicateTrip)
   deep-copies a child, so the copy is untagged right after the console creates it
   and any older stray copy is untagged once at boot.

   Wrapped globals (original kept as wrapper._orig, __recWrapped flag, call-through):
   sheetRow, tripActions, refreshBoard, deleteTrip, duplicateTrip, editTrip, clearDispatch,
   reloadFromStorage (rerender() only calls the console's renderTrips, it does not wrap it).
   Offline-first: no network, no cloud hooks needed; sync.js should mirror
   STATE.recurring (see the integration notes).

   Public API: window.Recurring (bottom of file).
   Plain ES2019, no build step. Never edits index.html.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;

  /* SCREEN is a top-level const in index.html (lexical global, not on window) */
  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }
  if (POPOUT) return;
  if (window.Recurring && window.Recurring._loaded) return;

  var HORIZON_DAYS = 14;
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

  /* ---------- helpers (own copies; globals may be missing) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[recurring] ' + m); } catch (e) {} }
  function save() { if (typeof window.save === 'function') { try { window.save(); return; } catch (e) {} } }
  function saveNow() { if (typeof window.saveNow === 'function') { try { window.saveNow(); return; } catch (e) {} } save(); }
  function uid() { if (typeof window.uid === 'function') { try { return window.uid(); } catch (e) {} } return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function nowISO() { return new Date().toISOString(); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtYMD(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { if (typeof window.todayStr === 'function') { try { return window.todayStr(); } catch (e) {} } return fmtYMD(new Date()); }
  function parseYMD(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); if (!m) return null; var d = new Date(+m[1], +m[2] - 1, +m[3]); return isNaN(d) ? null : d; }
  function addDays(ymd, n) { var d = parseYMD(ymd); if (!d) return ''; d.setDate(d.getDate() + n); return fmtYMD(d); }
  function dowOf(ymd) { var d = parseYMD(ymd); return d ? d.getDay() : -1; }
  function daysBetween(a, b) { var da = parseYMD(a), db = parseYMD(b); if (!da || !db) return NaN; return Math.round((db - da) / 86400000); }
  function mil(t) { if (typeof window.mil === 'function') { try { return window.mil(t); } catch (e) {} } return String(t || '').trim(); }
  function hhmm(t) { var m = /^(\d{1,2}):(\d{2})/.exec(mil(t)); if (!m) return ''; var h = +m[1]; if (h > 23) return ''; return pad2(h) + ':' + m[2]; }
  function time12(t) { var m = /^(\d{1,2}):(\d{2})/.exec(hhmm(t)); if (!m) return t || 'ASAP'; var h = +m[1], ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12; return h + ':' + m[2] + ' ' + ap; }
  function fmtDate(s) { if (typeof window.fmtDate === 'function') { try { return window.fmtDate(s); } catch (e) {} } return s || ''; }
  function shortAddr(a) { if (typeof window.shortAddr === 'function') { try { return window.shortAddr(a); } catch (e) {} } return String(a || '').split(',')[0].trim(); }
  function money(n) { if (typeof window.money === 'function') { try { return window.money(n); } catch (e) {} } return '$' + (Number(n) || 0).toFixed(2); }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { try { console.error('[recurring]', err); } catch (e2) {} } }; }
  function trips() { if (!Array.isArray(STATE.trips)) STATE.trips = []; return STATE.trips; }
  function findTrip(id) { if (id && typeof id === 'object') return id; return trips().filter(function (t) { return t && t.id === id; })[0] || null; }
  function findDriver(id) { return (STATE.drivers || []).filter(function (d) { return d.id === id; })[0] || null; }
  function findAccount(id) { return (STATE.accounts || []).filter(function (a) { return a.id === id; })[0] || null; }
  function phoneKey(p) { var d = String(p || '').replace(/\D/g, ''); if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1); return d.slice(-10); }
  function normAddr(a) { if (typeof window.normalizeAddr === 'function') { try { return window.normalizeAddr(a || ''); } catch (e) {} } return String(a || '').toUpperCase().replace(/\s+/g, ' ').trim(); }
  function routeKey(t) { var pu = normAddr(t.puAddr), doo = normAddr(t.doAddr); if (!pu || !doo) return ''; return pu + ' >> ' + doo; }
  function liveStatus(t) { return !!t && t.status !== 'Canceled' && t.status !== 'Disregard' && t.status !== 'No-Show'; }
  function isSimple() { try { return !!(window.Simple && typeof window.Simple.isSimple === 'function' && window.Simple.isSimple()); } catch (e) { return false; } }
  function nextSeq() { var n = Number(STATE.dispatchSeq); if (!isFinite(n) || n < 1) { n = 1; trips().forEach(function (t) { var k = Number(t.dispatchNo); if (isFinite(k) && k >= n) n = k + 1; }); } STATE.dispatchSeq = n + 1; return n; }
  function driverName(id) { var d = findDriver(id); return d ? (d.name || 'Driver') : ''; }
  function payLabel(payType, accountId) { if (accountId) { var a = findAccount(accountId); return a ? ('#' + (a.number || '') + ' ' + (a.name || '')).trim() : 'Account'; } return payType || 'Cash'; }
  function weekdaysLabel(list) {
    list = (list || []).slice().map(Number);
    if (list.length === 7) return 'every day';
    var wk = [1, 2, 3, 4, 5].every(function (d) { return list.indexOf(d) >= 0; });
    if (wk && list.length === 5) return 'Mon–Fri';
    return DOW_ORDER.filter(function (d) { return list.indexOf(d) >= 0; }).map(function (d) { return DOW[d]; }).join(', ') || 'no days';
  }

  /* ---------- STATE ---------- */
  function series() { if (!Array.isArray(STATE.recurring)) STATE.recurring = []; return STATE.recurring; }
  function get(id) { return series().filter(function (s) { return s && s.id === id; })[0] || null; }
  function cleanWeekdays(list) { var out = []; (Array.isArray(list) ? list : []).forEach(function (d) { d = Number(d); if (d >= 0 && d <= 6 && out.indexOf(d) < 0) out.push(d); }); return out.sort(); }
  function ensureShape(s) {
    if (!s || typeof s !== 'object') return s;
    if (!s.pattern || typeof s.pattern !== 'object') s.pattern = {};
    s.pattern.weekdays = cleanWeekdays(s.pattern.weekdays);
    if (typeof s.pattern.time !== 'string') s.pattern.time = '';
    if (s.pattern.sameDriver == null) s.pattern.sameDriver = true;
    if (!s.template || typeof s.template !== 'object') s.template = {};
    if (!Array.isArray(s.children)) s.children = [];
    if (!s.status) s.status = 'active';
    if (typeof s.startDate !== 'string') s.startDate = '';
    if (typeof s.endDate !== 'string') s.endDate = '';
    if (typeof s.nextGenerateUntil !== 'string') s.nextGenerateUntil = '';
    return s;
  }
  function ensureState() {
    var dirty = false; if (!Array.isArray(STATE.recurring)) { STATE.recurring = []; dirty = true; }
    var clean = STATE.recurring.filter(function (x) { return x && typeof x === 'object'; });   // a null/garbage entry must not stop every series
    if (clean.length !== STATE.recurring.length) { STATE.recurring = clean; dirty = true; }
    STATE.recurring.forEach(ensureShape); return dirty;
  }
  /* memberSeries(t): the series this trip really belongs to — it must list the trip id in children[].
     A trip that only carries recurringId (a Board "Copy" of a child, a dangling id) is an ordinary trip. */
  function memberSeries(t) {
    if (!t || !t.recurringId) return null;
    var s = get(t.recurringId); if (!s) return null;
    return (s.children || []).some(function (c) { return c && c.tripId === t.id; }) ? s : null;
  }
  function memberIds() { var set = {}; series().forEach(function (s) { (s.children || []).forEach(function (c) { if (c && c.tripId) set[c.tripId] = s.id; }); }); return set; }
  /* untagStrays(): drop recurringId from trips whose series exists but does not list them (Board copies). Idempotent. */
  function untagStrays() {
    var ids = memberIds(), n = 0;
    trips().forEach(function (t) { if (t && t.recurringId && get(t.recurringId) && ids[t.id] !== t.recurringId) { delete t.recurringId; n++; } });
    if (n) save();
    return n;
  }
  var FALLBACK_TIME = '08:00', lastCreateDefaulted = false;

  var TEMPLATE_FIELDS = ['passenger', 'phone', 'puAddr', 'doAddr', 'stops', 'fare', 'tolls', 'vtype', 'pax', 'rt', 'payType', 'accountId', 'driverId', 'vehicleId', 'notes'];
  function snapshot(t) {
    var out = {};
    TEMPLATE_FIELDS.forEach(function (k) { if (t[k] !== undefined) out[k] = t[k]; });
    out.stops = Array.isArray(t.stops) ? t.stops.filter(function (s) { return s && (s.addr || typeof s === 'string'); }).map(function (s) { return { addr: s.addr || s }; }) : [];
    out.fare = Number(t.fare) || 0; out.tolls = Number(t.tolls) || 0; out.pax = Number(t.pax) || 1;
    out.payType = t.payType || (t.accountId ? 'Account' : 'Cash'); out.accountId = t.accountId || null;
    out.driverId = t.driverId || ''; out.vehicleId = t.vehicleId || ''; out.notes = t.notes || '';
    out.passenger = t.passenger || ''; out.phone = t.phone || ''; out.puAddr = t.puAddr || ''; out.doAddr = t.doAddr || ''; out.vtype = t.vtype || 'Sedan'; out.rt = t.rt ? 1 : 0;
    return JSON.parse(JSON.stringify(out));
  }

  /* ---------- create ---------- */
  /* create(tripId, {weekdays:[..], time:'HH:MM', sameDriver, endDate, startDate, driverId, payType, accountId})
     Returns the series. The template trip's own date is recorded as a child so it is never duplicated. */
  function create(tripId, opts) {
    var t = findTrip(tripId); if (!t) { toast('Trip not found.', true); return null; }
    opts = opts || {};
    var member = memberSeries(t);
    if (member) { toast('#' + (t.dispatchNo || '') + ' already belongs to a weekly series.', true); return member; }
    if (t.recurringId) delete t.recurringId;   // stray tag (a Board copy of a child, or a series that no longer exists)
    var wd = cleanWeekdays(opts.weekdays && opts.weekdays.length ? opts.weekdays : [dowOf(t.date)]);
    if (!wd.length) { toast('Pick at least one weekday.', true); return null; }
    var time = hhmm(opts.time != null ? opts.time : t.time) || '';
    var timeDefaulted = false;
    if (!time) { time = FALLBACK_TIME; timeDefaulted = true; }   // ASAP source trip: a standing ride needs a clock time (the dialog and Book form refuse earlier)
    var tpl = snapshot(t);
    if (opts.driverId !== undefined) tpl.driverId = opts.driverId || '';
    if (opts.payType) { tpl.payType = opts.payType; tpl.accountId = opts.payType === 'Account' ? (opts.accountId || tpl.accountId || null) : null; }
    var start = parseYMD(opts.startDate) ? opts.startDate : (t.date && t.date > todayStr() ? t.date : todayStr());
    var s = ensureShape({
      id: 'R-' + uid(), templateTripId: t.id, template: tpl,
      pattern: { weekdays: wd, time: time, sameDriver: opts.sameDriver !== false, driverId: tpl.driverId, payType: tpl.payType, accountId: tpl.accountId },
      startDate: start, endDate: parseYMD(opts.endDate) ? opts.endDate : '',
      status: 'active', nextGenerateUntil: '', children: [], createdAt: nowISO(), updatedAt: nowISO()
    });
    if (t.date) s.children.push({ date: t.date, tripId: t.id, template: true });
    t.recurringId = s.id;
    series().push(s);
    save();
    lastCreateDefaulted = timeDefaulted;
    if (opts.noGenerate) return s;   // fromTrips() links the other trips first, then generates
    var made = generate({ id: s.id, silent: true, quiet: true }), notes = lastGenerateNotes;
    toast('Weekly series started for ' + (t.passenger || 'this ride') + ' — ' + weekdaysLabel(wd) + ' at ' + time12(time) + '. ' + made + ' ride' + (made === 1 ? '' : 's') + ' added to the board.'
      + (timeDefaulted ? ' #' + (t.dispatchNo || '') + ' had no pick-up time (ASAP), so the series is set to ' + time12(time) + ' — open the series to change it.' : '')
      + (notes.length ? ' ' + notes.join(' ') : ''), timeDefaulted || !!notes.length);
    rerender();
    return s;
  }
  /* fromTrips(tripIds, opts): convert existing separate trips (the "STANDING – customer" workaround) into one series.
     The newest trip is the template; every trip's date becomes a child entry, so nothing is duplicated. */
  function fromTrips(tripIds, opts) {
    opts = opts || {};
    var list = (tripIds || []).map(findTrip).filter(function (t) { return t && !memberSeries(t); });
    if (!list.length) { toast('Nothing to convert.', true); return null; }
    list.sort(function (a, b) { return String(a.date || '') < String(b.date || '') ? -1 : 1; });
    var tpl = list[list.length - 1];
    var wd = {}, times = {}, drv = {};
    list.forEach(function (t) { var d = dowOf(t.date); if (d >= 0) wd[d] = 1; var tm = hhmm(t.time); if (tm) times[tm] = (times[tm] || 0) + 1; if (t.driverId) drv[t.driverId] = (drv[t.driverId] || 0) + 1; });
    var top = function (o) { var best = '', n = 0; Object.keys(o).forEach(function (k) { if (o[k] > n) { n = o[k]; best = k; } }); return best; };
    var s = create(tpl.id, {
      weekdays: opts.weekdays || Object.keys(wd).map(Number), time: opts.time || top(times) || tpl.time,
      driverId: opts.driverId !== undefined ? opts.driverId : (top(drv) || tpl.driverId || ''), sameDriver: opts.sameDriver !== false,
      endDate: opts.endDate, startDate: opts.startDate, noGenerate: true
    });
    if (!s) return null;
    var defaulted = lastCreateDefaulted, joined = 1;
    list.forEach(function (t) {
      if (t.id === tpl.id || !t.date) return;
      var c = childFor(s, t.date);
      if (!c) { s.children.push({ date: t.date, tripId: t.id, imported: true }); t.recurringId = s.id; joined++; }
      else if (c.tripId === t.id) { t.recurringId = s.id; joined++; }
      else if (!findTrip(c.tripId)) { c.tripId = t.id; c.imported = true; delete c.removed; t.recurringId = s.id; joined++; }
      else if (t.recurringId === s.id) delete t.recurringId;   // that date already has a live ride in the series: this one stays an ordinary trip
    });
    s.children.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    save();
    var made = generate({ id: s.id, silent: true, quiet: true }), notes = lastGenerateNotes;
    toast(joined + ' separate trips joined into one weekly series for ' + (tpl.passenger || tpl.phone || 'this caller') + ' — ' + weekdaysLabel(s.pattern.weekdays) + ' at ' + time12(s.pattern.time) + '. ' + made + ' new ride' + (made === 1 ? '' : 's') + ' added.'
      + (defaulted ? ' These trips had no pick-up time (ASAP), so the series is set to ' + time12(s.pattern.time) + ' — check it below.' : '')
      + (notes.length ? ' ' + notes.join(' ') : ''), defaulted || !!notes.length);
    rerender();
    return s;
  }
  function childFor(s, date) { return (s.children || []).filter(function (c) { return c.date === date; })[0] || null; }

  /* ---------- eligibility gate (ops.js): creating a child with the series driver IS an assignment ----------
     Ops.eligibility(driverId, vehicleId, trip) is checked for the child's own date: the regular driver may be fine
     for tomorrow's template and have an expired TLC licence by the tenth child. A refused child is created with
     NO driver and a trip.eligibility stamp naming the reason (standingDriverId keeps who it should have been), the
     Standing rides panel row and a Needs-you line say so, and one toast per series per run tells the desk. With
     the check set to warn only (settings.enforceEligibility false) the driver is kept and the child is stamped. */
  function opsOK() { return !!(window.Ops && window.Ops._loaded && typeof window.Ops.eligibility === 'function'); }
  function elig(driverId, vehicleId, trip) { if (!opsOK()) return null; try { return window.Ops.eligibility(driverId, vehicleId, trip); } catch (e) { return null; } }
  function enforce() { try { return !(window.Ops && typeof window.Ops.enforce === 'function') || window.Ops.enforce(); } catch (e) { return true; } }
  function stampElig(trip, res, extra) {
    trip.eligibility = Object.assign({ ok: !!res.ok, reasons: (res.reasons || []).slice(), warnings: (res.warnings || []).slice(), checkedAt: nowISO(), driverId: res.driverId || '', vehicleId: res.vehicleId || '', enforced: enforce() }, extra || {});
  }
  function seriesDriver(s) { var p = s.pattern || {}, tpl = s.template || {}; return p.sameDriver === false ? '' : (p.driverId != null ? p.driverId : (tpl.driverId || '')); }
  /* gateChild(child, ctx) → child. ctx (per series, per run) collects {blanked, reason, firstDate}. Idempotent. */
  function gateChild(child, ctx) {
    if (!child || !child.driverId) return child;
    var res = elig(child.driverId, child.vehicleId, child); if (!res) return child;
    if (res.ok) return child;   // eligible: the child keeps the plain console trip shape (the Dispatch gate stamps it on the day)
    if (!enforce()) {   // warn only (like every other assign path): the driver stays, the child keeps its plain shape, one warning per series
      if (ctx) { ctx.warned = (ctx.warned || 0) + 1; if (!ctx.warnReason) ctx.warnReason = (res.reasons || [])[0] || 'not eligible'; }
      return child;
    }
    stampElig(child, res, { standingDriverId: child.driverId, standingBlank: true });
    child.driverId = '';
    if (ctx) { ctx.blanked = (ctx.blanked || 0) + 1; if (!ctx.reason) ctx.reason = (res.reasons || [])[0] || 'not eligible'; if (!ctx.firstDate || child.date < ctx.firstDate) ctx.firstDate = child.date; }
    return child;
  }
  function gateNote(s, ctx) {
    if (!ctx) return '';
    var who = (s.template || {}).passenger || 'this series';
    if (ctx.blanked) return ctx.blanked + ' standing ride' + (ctx.blanked === 1 ? '' : 's') + ' for ' + who + (ctx.firstDate ? ' from ' + fmtDate(ctx.firstDate) : '') + ' ' + (ctx.blanked === 1 ? 'has' : 'have') + ' no driver — ' + ctx.reason + '. Pick another driver on the board.';
    if (ctx.warned) return 'Warning - ' + ctx.warnReason + ' on ' + ctx.warned + ' standing ride' + (ctx.warned === 1 ? '' : 's') + ' for ' + who + '. Eligibility check is set to warn only.';
    return '';
  }
  var lastGenerateNotes = [];
  function toastNotes(notes) { if (notes && notes.length) toast(notes.join(' '), true); }
  /* standingGaps(s): upcoming Booked children with no driver. bad = the series driver is refused on that date (reason kept);
     ok = children this gate blanked earlier whose driver is eligible again (licence renewed) and can be put back with one press. */
  function standingGaps(s) {
    var td = todayStr(), drv = seriesDriver(s), out = { driverId: drv, blank: [], bad: [], ok: [], firstBad: '', reason: '' };
    if (!drv || !opsOK()) return out;
    (s.children || []).forEach(function (c) {
      if (!c || c.removed || c.dropped || !c.date || c.date < td) return;
      var t = findTrip(c.tripId); if (!t || t.status !== 'Booked' || t.driverId) return;
      out.blank.push(t);
      var res = elig(drv, t.vehicleId || (s.template || {}).vehicleId || '', t);
      if (res && !res.ok) { out.bad.push(t); if (!out.firstBad || t.date < out.firstBad) { out.firstBad = t.date; out.reason = (res.reasons || [])[0] || 'not eligible'; } }
      else if (c.gated || (t.eligibility && t.eligibility.standingBlank)) out.ok.push(t);
    });
    return out;
  }
  /* the series' own record of a child this gate left without its driver (ops.js re-stamps trip.eligibility on every refused press, so the trip stamp alone is not durable) */
  function gatedEntry(c, child) { if (!c) return c; if (child && !child.driverId && child.eligibility && child.eligibility.standingBlank) c.gated = true; else delete c.gated; return c; }
  /* reassign(seriesId): the series driver is eligible again — put him back on the children this gate left blank (through assignDriver's own gate) */
  function reassign(id) {
    var s = get(id); if (!s) return 0;
    var g = standingGaps(s), n = 0;
    g.ok.forEach(function (t) { try { if (typeof window.assignDriver === 'function') { window.assignDriver(t.id, g.driverId); if (t.driverId === g.driverId) { n++; var c = childFor(s, t.date); if (c) delete c.gated; } } } catch (e) {} });
    if (n) save();
    if (n) toast(driverName(g.driverId) + ' put back on ' + n + ' standing ride' + (n === 1 ? '' : 's') + '.');
    rerender(); return n;
  }

  /* ---------- child trips ---------- */
  function buildChild(s, date, ctx) {
    var tpl = s.template || {}, p = s.pattern || {};
    var driverId = seriesDriver(s);
    var payType = p.payType || tpl.payType || 'Cash', accountId = payType === 'Account' ? (p.accountId || tpl.accountId || null) : null;
    return gateChild({
      id: uid(), dispatchNo: nextSeq(), date: date, time: p.time || hhmm(tpl.time) || '',
      passenger: tpl.passenger || '', phone: tpl.phone || '',
      puAddr: tpl.puAddr || '', puZone: '', doAddr: tpl.doAddr || '', doZone: '',
      stops: JSON.parse(JSON.stringify(tpl.stops || [])),
      tolls: Number(tpl.tolls) || 0, fare: Number(tpl.fare) || 0, tip: 0, vtype: tpl.vtype || 'Sedan', pax: Number(tpl.pax) || 1, rt: tpl.rt ? 1 : 0,
      payType: payType, accountId: accountId,
      driverId: driverId, vehicleId: p.sameDriver === false ? '' : (tpl.vehicleId || ''),
      status: 'Booked', dropDate: '', dropTime: '', dispTime: '', notes: tpl.notes || '',
      createdAt: nowISO(), recurringId: s.id
    }, ctx);
  }
  /* The dates a series should have rides for between from..to (inclusive), honouring start/end and the weekday set */
  /* timePassed(s): the series' pick-up time for today is already in the past */
  function timePassed(s) { var t = hhmm(s && s.pattern && s.pattern.time); if (!t) return false; var n = new Date(); return t <= pad2(n.getHours()) + ':' + pad2(n.getMinutes()); }
  function datesFor(s, from, to) {
    var out = [], wd = (s.pattern && s.pattern.weekdays) || [];
    if (!wd.length) return out;
    var start = s.startDate && s.startDate > from ? s.startDate : from;
    var end = s.endDate && s.endDate < to ? s.endDate : to;
    for (var d = start; d && d <= end; d = addDays(d, 1)) if (wd.indexOf(dowOf(d)) >= 0) out.push(d);
    return out;
  }
  /* generate({id?, horizonDays?, silent?, quiet?}) → number of children created. Idempotent per date.
     silent: no "N rides added" toast (boot, callers that toast themselves). quiet: the eligibility notes are not
     toasted either (create / fromTrips / update fold them into their own toast); they are always left in
     Recurring.lastNotes(). */
  function generate(opts) {
    opts = opts || {};
    ensureState();
    var td = todayStr(), to = addDays(td, Number(opts.horizonDays) || HORIZON_DAYS), made = 0, dirty = false, notes = [];
    series().forEach(function (s) {
      if (opts.id && s.id !== opts.id) return;
      if (s.status !== 'active') return;
      var ctx = {};
      datesFor(s, td, to).forEach(function (d) {
        if (d === td && timePassed(s)) return;   // today's pick-up time is already gone: never book an overdue ride
        var c = childFor(s, d);
        if (c) {   // once per date: a deleted / canceled child is never resurrected here (see restore())
          if (!c.removed && !c.template && !c.imported && !findTrip(c.tripId)) { c.removed = true; dirty = true; }
          return;
        }
        var child = buildChild(s, d, ctx);
        trips().unshift(child);
        s.children.push(gatedEntry({ date: d, tripId: child.id }, child));
        made++; dirty = true;
      });
      var note = gateNote(s, ctx); if (note) notes.push(note);
      if (s.nextGenerateUntil !== to && (!s.endDate || s.endDate >= td)) { s.nextGenerateUntil = to; dirty = true; }
      if (s.endDate && s.endDate < td && s.status === 'active') { s.status = 'stopped'; s.updatedAt = nowISO(); dirty = true; }
    });
    if (dirty) { series().forEach(function (s) { s.children.sort(function (a, b) { return a.date < b.date ? -1 : 1; }); }); save(); }
    lastRunDay = td; lastGenerateNotes = notes;
    var warn = notes.length && !opts.quiet;
    if (made && !opts.silent) { toast(made + ' standing ride' + (made === 1 ? '' : 's') + ' added to the board.' + (warn ? ' ' + notes.join(' ') : ''), !!warn); rerender(); }
    else if (warn) { toastNotes(notes); rerender(); }
    return made;
  }
  /* restore(id): bring back children that were deleted/removed for dates from today on (only when asked). */
  function restore(id) {
    var s = get(id); if (!s) return 0;
    var td = todayStr(), n = 0, ctx = {};
    (s.children || []).forEach(function (c) {
      if (c.date < td || (c.date === td && timePassed(s))) return;
      var cur = findTrip(c.tripId);
      if (cur && cur.status !== 'Canceled' && !c.dropped) return;   // still on the board (or Dispatched / Completed): nothing to put back
      if ((s.pattern.weekdays || []).indexOf(dowOf(c.date)) < 0) return;
      if (s.endDate && c.date > s.endDate) return;
      var child = buildChild(s, c.date, ctx);
      trips().unshift(child); c.tripId = child.id; delete c.removed; delete c.dropped; delete c.template; delete c.imported; gatedEntry(c, child); n++;
      if (cur && cur.id !== child.id && cur.recurringId === s.id) delete cur.recurringId;   // the canceled ride is no longer the series' ride for that date
    });
    var note = gateNote(s, ctx);
    if (n) { save(); toast(n + ' missing ride' + (n === 1 ? '' : 's') + ' put back on the board.' + (note ? ' ' + note : ''), !!note); rerender(); } else toast('Nothing to restore — every date already has its ride.');
    return n;
  }

  /* ---------- future children + series edits ---------- */
  function futureChildren(s) {
    var td = todayStr();
    return (s.children || []).map(function (c) { return findTrip(c.tripId); }).filter(function (t) { return t && t.status === 'Booked' && t.date >= td; });
  }
  /* update(id, patch, applyFuture) — patch: {weekdays, time, sameDriver, driverId, payType, accountId, endDate, fare, notes, vehicleId}
     applyFuture true → future Booked children take the new time / driver / pay / fare / notes; children whose weekday
     left the pattern are Canceled (their date stays in children[] so nothing regenerates); new weekdays are generated. */
  function update(id, patch, applyFuture) {
    var s = get(id); if (!s) return null;
    patch = patch || {}; ensureShape(s);
    var p = s.pattern, tpl = s.template, changed = [];
    if (patch.weekdays) { var wd = cleanWeekdays(patch.weekdays); if (wd.length && wd.join() !== p.weekdays.join()) { p.weekdays = wd; changed.push('days'); } }
    if (patch.time !== undefined) { var tm = hhmm(patch.time); if (tm !== p.time) { p.time = tm; changed.push('time'); } }
    if (patch.sameDriver !== undefined && !!patch.sameDriver !== !!p.sameDriver) { p.sameDriver = !!patch.sameDriver; changed.push('driver'); }
    if (patch.driverId !== undefined && String(patch.driverId || '') !== String(p.driverId || '')) { p.driverId = patch.driverId || ''; tpl.driverId = p.driverId; changed.push('driver'); }
    if (patch.payType && (patch.payType !== p.payType || String(patch.accountId || '') !== String(p.accountId || ''))) { p.payType = patch.payType; p.accountId = patch.payType === 'Account' ? (patch.accountId || null) : null; tpl.payType = p.payType; tpl.accountId = p.accountId; changed.push('pay'); }
    if (patch.fare !== undefined && Number(patch.fare) !== Number(tpl.fare)) { tpl.fare = Number(patch.fare) || 0; changed.push('fare'); }
    if (patch.notes !== undefined && String(patch.notes) !== String(tpl.notes || '')) { tpl.notes = String(patch.notes); changed.push('notes'); }
    if (patch.vehicleId !== undefined && String(patch.vehicleId || '') !== String(tpl.vehicleId || '')) { tpl.vehicleId = patch.vehicleId || ''; changed.push('vehicle'); }
    if (patch.endDate !== undefined) { var ed = parseYMD(patch.endDate) ? patch.endDate : ''; if (ed !== s.endDate) { s.endDate = ed; changed.push('end'); } }
    if (!changed.length) return { series: s, changed: [], applied: 0 };
    s.updatedAt = nowISO();
    var applied = 0, ctx = {};
    if (applyFuture) applied = pushPatch(s, changed, ctx);
    save();
    var notes = [], note = gateNote(s, ctx); if (note) notes.push(note);
    if (s.status === 'active') { generate({ id: s.id, silent: true, quiet: true }); notes = notes.concat(lastGenerateNotes); }
    if (notes.length) toastNotes(notes);
    rerender();
    return { series: s, changed: changed, applied: applied, notes: notes };
  }
  /* pushPatch(s, changed, ctx): the pattern already changed; put the same fields on the future Booked children. A child whose
     weekday left the pattern (or is past the end date) is Canceled and its date kept so nothing regenerates. A driver change
     goes through the eligibility gate for each child's own date (gateChild). Returns the number of children touched. */
  function pushPatch(s, changed, ctx) {
    var p = s.pattern, tpl = s.template, n = 0;
    futureChildren(s).forEach(function (t) {
      if ((s.endDate && t.date > s.endDate) || p.weekdays.indexOf(dowOf(t.date)) < 0) { t.status = 'Canceled'; var c = childFor(s, t.date); if (c) c.dropped = true; n++; return; }
      if (changed.indexOf('time') >= 0) t.time = p.time;
      if (changed.indexOf('vehicle') >= 0) t.vehicleId = tpl.vehicleId || '';
      if (changed.indexOf('driver') >= 0) t.driverId = seriesDriver(s);
      if (changed.indexOf('driver') >= 0 || changed.indexOf('vehicle') >= 0) { gateChild(t, ctx); var ce = childFor(s, t.date); if (ce) gatedEntry(ce, t); }   // a new driver or car is checked for each child's own date
      if (changed.indexOf('pay') >= 0) { t.payType = p.payType; t.accountId = p.accountId; }
      if (changed.indexOf('fare') >= 0) t.fare = Number(tpl.fare) || 0;
      if (changed.indexOf('notes') >= 0) t.notes = tpl.notes || '';
      n++;
    });
    return n;
  }
  function pause(id) { var s = get(id); if (!s || s.status !== 'active') return false; s.status = 'paused'; s.updatedAt = nowISO(); save(); toast('Series paused — no new rides are created. Rides already on the board stay.'); rerender(); return true; }
  function resume(id) { var s = get(id); if (!s || s.status !== 'paused') return false; s.status = 'active'; s.updatedAt = nowISO(); save(); var n = generate({ id: s.id, silent: true }); toast('Series resumed' + (n ? ' — ' + n + ' ride' + (n === 1 ? '' : 's') + ' added.' : '.')); rerender(); return true; }
  /* stop(id, cancelFuture): stops for good; cancelFuture also cancels the future Booked children (kept on record as Canceled). */
  function stop(id, cancelFuture) {
    var s = get(id); if (!s || s.status === 'stopped') return false;
    s.status = 'stopped'; s.updatedAt = nowISO();
    var n = 0;
    if (cancelFuture) futureChildren(s).forEach(function (t) { t.status = 'Canceled'; var c = childFor(s, t.date); if (c) c.dropped = true; n++; });
    save();
    toast('Series stopped.' + (n ? ' ' + n + ' future ride' + (n === 1 ? '' : 's') + ' canceled.' : ''));
    rerender();
    return true;
  }
  function remove(id) {   // forget a stopped series (its trips stay; they lose the chip)
    var s = get(id); if (!s) return false;
    trips().forEach(function (t) { if (t.recurringId === id) delete t.recurringId; });
    STATE.recurring = series().filter(function (x) { return x.id !== id; });
    save(); rerender(); return true;
  }

  /* ---------- import suggestions: same phone + same route + weekly spacing, or "STANDING" in Notes ---------- */
  var sugCache = { key: '', at: 0, list: [] };
  function suggestions(force) {
    var key = trips().length + ':' + series().length;
    if (!force && sugCache.key === key && Date.now() - sugCache.at < 30000) return sugCache.list;
    var groups = {};
    var members = memberIds();
    trips().forEach(function (t) {
      if (!t || !liveStatus(t) || !t.date) return;
      if (t.recurringId && (members[t.id] === t.recurringId || !get(t.recurringId))) return;   // real member, or a tag whose series is gone (left alone)
      var pk = phoneKey(t.phone), rk = routeKey(t);
      if (!rk) return;
      var k = (pk || ('name:' + String(t.passenger || '').trim().toUpperCase())) + '|' + rk;
      if (!pk && !String(t.passenger || '').trim()) return;
      (groups[k] = groups[k] || []).push(t);
    });
    var out = [];
    Object.keys(groups).forEach(function (k) {
      var list = groups[k].slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      var dates = []; list.forEach(function (t) { if (dates.indexOf(t.date) < 0) dates.push(t.date); });
      if (dates.length < 2) return;
      var weekly = 0; for (var i = 1; i < dates.length; i++) { var g = daysBetween(dates[i - 1], dates[i]); if (g === 7) weekly++; }   // weekly spacing only: every-two-weeks riders are not a weekly standing order
      var standing = list.some(function (t) { return /\bSTANDING\b/i.test(t.notes || ''); });
      if (!(weekly >= 2 || (weekly >= 1 && standing))) return;
      var wd = {}; list.forEach(function (t) { wd[dowOf(t.date)] = 1; });
      var t0 = list[list.length - 1];
      out.push({ key: k, tripIds: list.map(function (t) { return t.id; }), passenger: t0.passenger || '', phone: t0.phone || '', puAddr: t0.puAddr, doAddr: t0.doAddr, weekdays: Object.keys(wd).map(Number).sort(), time: hhmm(t0.time), driverId: t0.driverId || '', count: list.length, standing: standing, lastDate: t0.date });
    });
    out.sort(function (a, b) { return (b.standing - a.standing) || (b.count - a.count); });
    sugCache = { key: key, at: Date.now(), list: out };
    return out;
  }
  var dismissed = {};
  function dismissSuggestion(key) { dismissed[key] = true; renderPanel(true); }

  /* ---------- styles ---------- */
  function ensureStyle() {
    if (byId('recStyle')) return;
    var st = document.createElement('style'); st.id = 'recStyle';
    st.textContent = [
      '.rec-chip{display:inline-block;font-size:10px;font-weight:700;padding:0 5px;border-radius:9px;background:rgba(28,91,156,.12);color:#1c5b9c;margin-left:4px;white-space:nowrap;vertical-align:middle;cursor:pointer;}',
      '.rec-chip.paused{background:rgba(214,158,20,.16);color:#7a5a06;} .rec-chip.stopped{background:rgba(120,120,120,.14);color:#555;}',
      '.rec-btn{white-space:nowrap;}',
      '#rec_block{border:1px dashed var(--line,#c9c9c9);border-radius:4px;padding:8px 10px;margin:0 0 10px;background:rgba(28,91,156,.04);}',
      '#rec_block .rec-row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-top:6px;}',
      '#rec_block label.rec-cb{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;margin:0;cursor:pointer;}',
      '#rec_block input[type=checkbox]{width:auto;}',
      '.rec-days{display:inline-flex;gap:3px;flex-wrap:wrap;}',
      '.rec-days button{min-width:34px;padding:3px 6px;font-size:11.5px;border:1px solid var(--line,#c9c9c9);background:#fff;border-radius:3px;cursor:pointer;color:#333;}',
      '.rec-days button.on{background:#1c5b9c;color:#fff;border-color:#1c5b9c;}',
      '#rec_block .fld,#recOvl .fld{margin:0;} #rec_block .fld input,#rec_block .fld select{padding:4px 6px;font-size:12.5px;}',
      '#rec_block .hint{margin:4px 0 0;}',
      '.rec-panel .rec-tbl td{vertical-align:top;} .rec-panel .rec-acts{display:flex;flex-wrap:wrap;gap:4px;} .rec-panel .rec-acts .btn{white-space:nowrap;}',
      '.rec-panel .rec-sug{border:1px solid #d6a800;background:#fff6c4;border-radius:4px;padding:6px 10px;margin:6px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12.5px;}',
      '.rec-panel .rec-sug b{font-weight:700;} .rec-panel .panel-body{padding:8px 10px;}',
      '.rec-panel .rec-dates{font-family:Consolas,monospace;font-size:11px;color:var(--muted,#5b5b5b);}',
      '#recOvl .ovl-card{max-width:520px;} #recOvl .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;} #recOvl .rec-row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin:8px 0;}',
      '#recOvl .rec-sum{font-size:12.5px;color:var(--muted,#5b5b5b);margin:0 0 8px;}',
      'body.gold .rec-days button{background:#1b1e24;color:#ddd;} body.gold .rec-chip{color:#8fb8ea;} body.gold .rec-panel .rec-sug{background:#3a3310;color:#f0e2a0;border-color:#8a7a2a;}',
      'body.classic .rec-days button,body.classic #rec_block,body.classic .rec-panel .rec-sug{border-radius:0;}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }

  /* ---------- Book form block ---------- */
  function dayButtons(idPrefix, selected) {
    selected = selected || [];
    return '<span class="rec-days" id="' + idPrefix + '_days">' + DOW_ORDER.map(function (d) { return '<button type="button" data-dow="' + d + '" class="' + (selected.indexOf(d) >= 0 ? 'on' : '') + '" title="' + DOW[d] + '">' + DOW[d] + '</button>'; }).join('') + '</span>';
  }
  function readDays(idPrefix) { var host = byId(idPrefix + '_days'); if (!host) return []; return Array.prototype.map.call(host.querySelectorAll('button.on'), function (b) { return Number(b.getAttribute('data-dow')); }); }
  function setDays(idPrefix, list) { var host = byId(idPrefix + '_days'); if (!host) return; Array.prototype.forEach.call(host.querySelectorAll('button'), function (b) { b.classList.toggle('on', list.indexOf(Number(b.getAttribute('data-dow'))) >= 0); }); }
  function wireDays(idPrefix) { var host = byId(idPrefix + '_days'); if (!host || host.__wired) return; host.__wired = true; host.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('button[data-dow]') : null; if (!b) return; e.preventDefault(); b.classList.toggle('on'); }); }
  function ensureBookBlock() {
    if (byId('rec_block')) return byId('rec_block');
    var notes = byId('d_notes'); if (!notes) return null;
    var lbl = notes.closest ? notes.closest('label.fld') : null; if (!lbl || !lbl.parentNode) return null;
    var div = document.createElement('div'); div.id = 'rec_block';
    div.innerHTML = '<label class="rec-cb"><input type="checkbox" id="rec_on"> ↻ Repeat this ride every week</label>'
      + '<div id="rec_opts" hidden><div class="rec-row">' + dayButtons('rec_b', []) + '</div>'
      + '<div class="rec-row"><label class="fld"><span class="lbl">Until (optional)</span><input type="date" id="rec_b_until"></label>'
      + '<label class="rec-cb" style="font-weight:400;"><input type="checkbox" id="rec_b_same" checked> Same driver each time</label></div>'
      + '<div class="hint">Uses the pick-up time above. Rides are put on the board for the next ' + HORIZON_DAYS + ' days, then one day at a time. Change or stop the series from the Standing rides list under the board.</div></div>'
      + '<div id="rec_member" class="hint" hidden></div>';
    lbl.parentNode.insertBefore(div, lbl.nextSibling);
    wireDays('rec_b');
    byId('rec_on').addEventListener('change', act(function () {
      var on = byId('rec_on').checked; byId('rec_opts').hidden = !on;
      if (on) {
        if (!readDays('rec_b').length) { var dEl = byId('d_date'), d = dEl && dEl.value ? dowOf(dEl.value) : new Date().getDay(); setDays('rec_b', [d]); }
        try { if (typeof window.setWhen === 'function' && typeof whenMode !== 'undefined' && whenMode === 'asap') window.setWhen('sched'); } catch (e) {}
      }
    }));
    var dEl = byId('d_date'); if (dEl && !dEl.__recWired) { dEl.__recWired = true; dEl.addEventListener('change', act(function () { if (byId('rec_on').checked && !readDays('rec_b').length && dEl.value) setDays('rec_b', [dowOf(dEl.value)]); })); }
    return div;
  }
  function resetBookBlock() {
    var on = byId('rec_on'); if (!on) return;
    on.checked = false; var o = byId('rec_opts'); if (o) o.hidden = true; setDays('rec_b', []); var u = byId('rec_b_until'); if (u) u.value = ''; var sm = byId('rec_b_same'); if (sm) sm.checked = true;
    var m = byId('rec_member'); if (m) { m.hidden = true; m.innerHTML = ''; }
    on.disabled = false; var cb = on.closest('label'); if (cb) cb.style.display = '';
  }
  function showMember(t) {
    var m = byId('rec_member'), on = byId('rec_on'); if (!m || !on) return;
    var s = memberSeries(t);
    if (!s) { m.hidden = true; m.innerHTML = ''; on.disabled = false; on.closest('label').style.display = ''; return; }
    on.checked = false; var o = byId('rec_opts'); if (o) o.hidden = true; on.closest('label').style.display = 'none';
    m.hidden = false;
    m.innerHTML = '↻ Part of a weekly series (' + esc(weekdaysLabel(s.pattern.weekdays)) + (s.pattern.time ? ' at ' + esc(time12(s.pattern.time)) : '') + ', ' + esc(s.status) + '). Updating this ride changes this one day only. <button type="button" class="btn btn-ghost btn-sm" onclick="Recurring.openSeries(\'' + esc(s.id) + '\')">Open series</button>';
  }
  /* #d_save: capture (remember what is about to happen) + bubble (the console's handler has run) */
  var dsavePre = null;
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#d_save') : null; if (!b) return;
    dsavePre = null;
    try {
      var on = byId('rec_on'); if (!on || !on.checked) return;
      var editing = null; try { if (typeof editingId !== 'undefined') editing = editingId; } catch (err) { editing = null; }
      var days = readDays('rec_b');
      if (!days.length) { e.stopPropagation(); e.preventDefault(); toast('Pick the weekdays for the repeat ride, or untick "Repeat this ride".', true); return; }
      var tEl = byId('d_time'), tm = hhmm(tEl ? tEl.value : '');
      if (!tm) { e.stopPropagation(); e.preventDefault(); toast('Set a pick-up time for the repeat ride (ASAP cannot repeat).', true); try { if (typeof window.setWhen === 'function') window.setWhen('sched'); } catch (err) {} return; }
      dsavePre = { editing: editing, seq: Number(STATE.dispatchSeq), days: days, time: tm, until: (byId('rec_b_until') || {}).value || '', same: !!(byId('rec_b_same') && byId('rec_b_same').checked) };
    } catch (err) { try { console.error('[recurring]', err); } catch (e2) {} }
  }, true);
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#d_save') : null; if (!b || !dsavePre) return;
    var pre = dsavePre; dsavePre = null;
    try {
      var t = null;
      if (pre.editing) t = findTrip(pre.editing);
      else { if (Number(STATE.dispatchSeq) !== pre.seq + 1) return; t = trips().filter(function (x) { return Number(x.dispatchNo) === pre.seq; })[0]; }
      if (!t) return;   // the console refused the booking (addresses missing etc.) — nothing to repeat
      create(t.id, { weekdays: pre.days, time: pre.time, endDate: pre.until, sameDriver: pre.same });
      resetBookBlock();
    } catch (err) { try { console.error('[recurring]', err); } catch (e2) {} }
  }, false);

  /* ---------- dialog (Board "Repeat" and series "Edit") ---------- */
  function ensureOvl() {
    var o = byId('recOvl'); if (o) return o;
    o = document.createElement('div'); o.id = 'recOvl'; o.className = 'ovl'; o.hidden = true;
    o.innerHTML = '<div class="ovl-card" id="recOvlCard"></div>';
    o.addEventListener('click', function (e) { if (e.target === o) closeDialog(); });
    document.body.appendChild(o);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !o.hidden) { closeDialog(); } });
    return o;
  }
  function closeDialog() { var o = byId('recOvl'); if (o) o.hidden = true; }
  function payOptions(sel, acct) {
    var h = '<option value="Cash"' + (sel === 'Cash' ? ' selected' : '') + '>Cash</option><option value="Credit Card"' + (sel === 'Credit Card' ? ' selected' : '') + '>Credit Card</option>';
    (STATE.accounts || []).forEach(function (a) { h += '<option value="acct:' + esc(a.id) + '"' + (sel === 'Account' && acct === a.id ? ' selected' : '') + '>#' + esc(a.number || '') + ' — ' + esc(a.name || '') + '</option>'; });
    return h;
  }
  /* ⛔ marks a driver who is blocked today (ops.js roster standing) — still selectable: each child is gated on its own date */
  function blockedToday(d) { try { if (window.Ops && typeof window.Ops.standing === 'function') return window.Ops.standing(d, 'driver').state === 'blocked'; } catch (e) {} return false; }
  function driverSelect(sel) { var h = '<option value="">— unassigned —</option>'; (STATE.drivers || []).forEach(function (d) { if (d.active === false && d.id !== sel) return; h += '<option value="' + esc(d.id) + '"' + (d.id === sel ? ' selected' : '') + '>' + (blockedToday(d) ? '⛔ ' : '') + esc(d.name || '') + '</option>'; }); return h; }
  /* openDialog(tripId) — start a series from a trip; openSeries(seriesId) — edit an existing one */
  function openDialog(tripId) {
    var t = findTrip(tripId); if (!t) return;
    var member = memberSeries(t);
    if (member) { openSeries(member.id); return; }
    renderDialog({ mode: 'new', trip: t, weekdays: [dowOf(t.date)], time: hhmm(t.time) || '08:00', driverId: t.driverId || '', sameDriver: true, payType: t.payType || (t.accountId ? 'Account' : 'Cash'), accountId: t.accountId || null, fare: t.fare, endDate: '', notes: t.notes || '' });
  }
  function openSeries(id) {
    var s = get(id); if (!s) { toast('That series no longer exists.', true); return; }
    renderDialog({ mode: 'edit', series: s, weekdays: s.pattern.weekdays, time: s.pattern.time, driverId: s.pattern.driverId || s.template.driverId || '', sameDriver: s.pattern.sameDriver !== false, payType: s.pattern.payType || s.template.payType || 'Cash', accountId: s.pattern.accountId || s.template.accountId || null, fare: s.template.fare, endDate: s.endDate || '', notes: s.template.notes || '' });
  }
  function renderDialog(d) {
    ensureStyle(); var o = ensureOvl(), card = byId('recOvlCard');
    var src = d.mode === 'new' ? d.trip : d.series.template, who = src.passenger || src.phone || 'this ride';
    var fut = d.mode === 'edit' ? futureChildren(d.series).length : 0;
    card.innerHTML = '<div class="panel-head" style="display:flex;justify-content:space-between;align-items:center;">' + (d.mode === 'new' ? '↻ Repeat this ride every week' : '↻ Weekly series — ' + esc(who)) + '<span style="cursor:pointer;font-size:16px;" id="rec_x">&times;</span></div>'
      + '<div class="panel-body">'
      + '<div class="rec-sum">' + esc(shortAddr(src.puAddr)) + ' → ' + esc(shortAddr(src.doAddr)) + (d.mode === 'new' ? ' · ' + esc(who) + ' · from #' + esc(d.trip.dispatchNo || '') : ' · ' + esc(d.series.status) + ' · ' + (d.series.children || []).filter(function (c) { return !c.removed && !c.dropped; }).length + ' dates on record') + '</div>'
      + '<div class="rec-row"><span class="lbl" style="margin:0;">Days</span>' + dayButtons('rec_d', d.weekdays) + '</div>'
      + '<div class="grid2"><label class="fld"><span class="lbl">Pick-up time</span><input type="time" id="rec_d_time" value="' + esc(d.time || '') + '"></label>'
      + '<label class="fld"><span class="lbl">Until (optional)</span><input type="date" id="rec_d_until" value="' + esc(d.endDate || '') + '"></label></div>'
      + '<div class="grid2" style="margin-top:8px;"><label class="fld"><span class="lbl">Driver</span><select id="rec_d_drv">' + driverSelect(d.driverId) + '</select></label>'
      + '<label class="fld"><span class="lbl">Pay / Account</span><select id="rec_d_pay">' + payOptions(d.payType, d.accountId) + '</select></label></div>'
      + '<div class="grid2" style="margin-top:8px;"><label class="fld"><span class="lbl">Fare ($)</span><input type="number" step="1" id="rec_d_fare" value="' + esc(Math.round(Number(d.fare) || 0)) + '"></label>'
      + '<label class="rec-cb" style="align-self:end;font-weight:400;"><input type="checkbox" id="rec_d_same"' + (d.sameDriver ? ' checked' : '') + '> Same driver each time</label></div>'
      + '<label class="fld" style="margin-top:8px;"><span class="lbl">Notes on every ride</span><input type="text" id="rec_d_notes" value="' + esc(d.notes || '') + '"></label>'
      + '<div class="hint" style="margin:8px 0 0;">' + (d.mode === 'new' ? 'Booked rides are put on the board for today and the next ' + HORIZON_DAYS + ' days, then one more each day. Nothing is created twice.' : (fut ? fut + ' future ride' + (fut === 1 ? '' : 's') + ' already on the board — you will be asked whether to change them too.' : 'No future rides on the board yet.')) + '</div>'
      + '<div class="btn-row" style="margin-top:10px;"><button class="btn btn-go" type="button" id="rec_d_ok">' + (d.mode === 'new' ? 'Start weekly series' : 'Save series') + '</button><button class="btn btn-ghost" type="button" id="rec_d_cancel">Cancel</button>'
      + (d.mode === 'edit' ? '<span style="flex:1"></span>' + (d.series.status === 'active' ? '<button class="btn btn-ghost" type="button" id="rec_d_pause">Pause</button>' : d.series.status === 'paused' ? '<button class="btn btn-navy" type="button" id="rec_d_resume">Resume</button>' : '') + (d.series.status !== 'stopped' ? '<button class="btn btn-void" type="button" id="rec_d_stop">Stop series</button>' : '<button class="btn btn-void" type="button" id="rec_d_remove">Forget series</button>') : '')
      + '</div></div>';
    wireDays('rec_d');
    byId('rec_x').addEventListener('click', closeDialog); byId('rec_d_cancel').addEventListener('click', closeDialog);
    byId('rec_d_ok').addEventListener('click', act(function () {
      var days = readDays('rec_d'); if (!days.length) { toast('Pick at least one weekday.', true); return; }
      var tm = hhmm((byId('rec_d_time') || {}).value); if (!tm) { toast('Set a pick-up time.', true); return; }
      var payV = String((byId('rec_d_pay') || {}).value || 'Cash'), payType = payV.indexOf('acct:') === 0 ? 'Account' : payV, accountId = payV.indexOf('acct:') === 0 ? payV.slice(5) : null;
      var patch = { weekdays: days, time: tm, endDate: (byId('rec_d_until') || {}).value || '', driverId: (byId('rec_d_drv') || {}).value || '', sameDriver: !!(byId('rec_d_same') && byId('rec_d_same').checked), payType: payType, accountId: accountId, fare: Number((byId('rec_d_fare') || {}).value) || 0, notes: String((byId('rec_d_notes') || {}).value || '') };
      if (d.mode === 'new') {
        var s = create(d.trip.id, patch);
        if (s && (Number(patch.fare) !== Number(s.template.fare) || patch.notes !== (s.template.notes || ''))) update(s.id, { fare: patch.fare, notes: patch.notes }, true);
        closeDialog(); return;
      }
      var probe = update(d.series.id, patch, false);
      if (!probe || !probe.changed.length) { closeDialog(); toast('No changes.'); return; }
      var fut2 = futureChildren(d.series).length, applyF = false;
      if (fut2) applyF = window.confirm('Apply the change (' + probe.changed.join(', ') + ') to the ' + fut2 + ' future ride' + (fut2 === 1 ? '' : 's') + ' already on the board?\n\nOK = change them too.  Cancel = only rides created from now on.');
      var notes = probe.notes || [];
      if (applyF) { applyPatchToFuture(d.series, probe.changed); notes = notes.concat(lastGenerateNotes); }
      closeDialog(); toast('Series saved' + (applyF ? ' — future rides updated.' : '.') + (notes.length ? ' ' + notes.join(' ') : ''), !!notes.length);
    }));
    if (byId('rec_d_pause')) byId('rec_d_pause').addEventListener('click', act(function () { pause(d.series.id); closeDialog(); }));
    if (byId('rec_d_resume')) byId('rec_d_resume').addEventListener('click', act(function () { resume(d.series.id); closeDialog(); }));
    if (byId('rec_d_stop')) byId('rec_d_stop').addEventListener('click', act(function () {
      var fut3 = futureChildren(d.series).length;
      if (!window.confirm('Stop this weekly series for ' + who + '? No more rides will be created.')) return;
      var cancelF = fut3 ? window.confirm('Also cancel the ' + fut3 + ' future ride' + (fut3 === 1 ? '' : 's') + ' already on the board?\n\nOK = cancel them.  Cancel = leave them booked.') : false;
      stop(d.series.id, cancelF); closeDialog();
    }));
    if (byId('rec_d_remove')) byId('rec_d_remove').addEventListener('click', act(function () { if (window.confirm('Forget this stopped series? Its rides stay on record.')) { remove(d.series.id); closeDialog(); } }));
    o.hidden = false;
    setTimeout(function () { var f = byId('rec_d_time'); if (f) f.focus(); }, 30);
  }
  /* update() already changed the pattern; this pushes the same fields onto the future children (used after the dispatcher said OK) */
  function applyPatchToFuture(s, changed) {
    var ctx = {}, n = pushPatch(s, changed || [], ctx);
    save();
    var note = gateNote(s, ctx); lastGenerateNotes = note ? [note] : []; if (note) toast(note, true);
    rerender(); return n;
  }

  /* ---------- Standing rides panel (under the board) ---------- */
  var PANEL_ID = 'recPanel', lastSig = '';
  function ensurePanel() {
    var host = byId('boardArea'); if (!host) return null;
    var p = byId(PANEL_ID);
    if (!p) { p = document.createElement('div'); p.id = PANEL_ID; p.className = 'panel rec-panel'; p.hidden = true; host.appendChild(p); p.addEventListener('click', onPanelClick); }
    return p;
  }
  function nextDates(s, n) {
    var td = todayStr(), out = [];
    (s.children || []).forEach(function (c) { if (c.date >= td && !c.removed && !c.dropped && out.length < n) { var t = findTrip(c.tripId); if (t && t.status !== 'Canceled') out.push(fmtDate(c.date).slice(0, 5) + (t.driverId ? '' : '*')); } });
    return out;
  }
  function renderPanel(force) {
    var p = ensurePanel(); if (!p) return;
    ensureStyle();
    var list = series(), sug = suggestions().filter(function (x) { return !dismissed[x.key]; });
    var sig = JSON.stringify([list.map(function (s) { return [s.id, s.status, s.updatedAt, (s.children || []).length, nextDates(s, 3)]; }), sug.map(function (x) { return x.key + x.count; }), isSimple()]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    if (!list.length && !sug.length) { p.hidden = true; p.innerHTML = ''; return; }
    var h = '<div class="panel-head">↻ Standing rides <span class="hint" style="margin:0;font-weight:400;text-transform:none;">weekly repeats — rides are created ' + HORIZON_DAYS + ' days ahead, once each</span></div><div class="panel-body">';
    sug.forEach(function (x) {
      h += '<div class="rec-sug" data-key="' + esc(x.key) + '">' + (x.standing ? '<b>STANDING</b> ' : '') + '<span><b>' + esc(x.passenger || x.phone || 'Same caller') + '</b> — ' + x.count + ' separate trips, ' + esc(shortAddr(x.puAddr)) + ' → ' + esc(shortAddr(x.doAddr)) + ', ' + esc(weekdaysLabel(x.weekdays)) + (x.time ? ' at ' + esc(time12(x.time)) : '') + (x.driverId ? ', ' + esc(driverName(x.driverId)) : '') + '. Looks like a standing order.</span>'
        + '<span style="flex:1"></span><button class="btn btn-go btn-sm" type="button" data-act="convert" data-key="' + esc(x.key) + '">Make it a weekly series</button><button class="btn btn-ghost btn-sm" type="button" data-act="dismiss" data-key="' + esc(x.key) + '">Not now</button></div>';
    });
    if (list.length) {
      h += '<div class="tbl-scroll"><table class="data rec-tbl" id="rec_list"><thead><tr><th>Passenger</th><th>Route</th><th>When</th><th>Driver</th><th>Pay</th><th class="num">Fare</th><th>Next dates</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
      list.slice().sort(function (a, b) { return (a.status === 'active' ? 0 : a.status === 'paused' ? 1 : 2) - (b.status === 'active' ? 0 : b.status === 'paused' ? 1 : 2); }).forEach(function (s) {
        var tpl = s.template || {}, p2 = s.pattern || {}, drv = p2.sameDriver === false ? 'any driver' : (driverName(p2.driverId || tpl.driverId) || 'unassigned');
        var nd = nextDates(s, 4), gap = s.status === 'stopped' ? null : standingGaps(s);
        var gapChip = gap && gap.bad.length ? '<div><span class="rec-chip stopped" title="' + esc(gap.reason) + '">⛔ not eligible on ' + gap.bad.length + ' date' + (gap.bad.length === 1 ? '' : 's') + ' from ' + esc(fmtDate(gap.firstBad).slice(0, 5)) + '</span><div class="hint" style="margin:0;">' + esc(gap.reason) + ' — those rides have no driver.</div></div>'
          : gap && gap.ok.length ? '<div><span class="rec-chip" title="The driver is eligible again">eligible again</span> <button class="btn btn-go btn-sm" type="button" data-act="reassign" data-id="' + esc(s.id) + '">Put back on ' + gap.ok.length + ' ride' + (gap.ok.length === 1 ? '' : 's') + '</button></div>' : '';
        h += '<tr data-series="' + esc(s.id) + '"><td><b>' + esc(tpl.passenger || '—') + '</b>' + (tpl.phone ? '<div class="hint" style="margin:0;">' + esc(tpl.phone) + '</div>' : '') + '</td>'
          + '<td title="' + esc(tpl.puAddr + ' → ' + tpl.doAddr) + '">' + esc(shortAddr(tpl.puAddr)) + ' → ' + esc(shortAddr(tpl.doAddr)) + (tpl.stops && tpl.stops.length ? ' <span class="s-more">(+' + tpl.stops.length + ')</span>' : '') + '</td>'
          + '<td>' + esc(weekdaysLabel(p2.weekdays)) + '<div class="hint" style="margin:0;">' + esc(time12(p2.time)) + (s.endDate ? ' · until ' + esc(fmtDate(s.endDate)) : '') + '</div></td>'
          + '<td>' + esc(drv) + gapChip + '</td><td>' + esc(payLabel(p2.payType || tpl.payType, p2.accountId || tpl.accountId)) + '</td><td class="num">' + esc(money(tpl.fare)) + '</td>'
          + '<td class="rec-dates">' + (nd.length ? esc(nd.join(' ')) : (s.status === 'active' ? '—' : 'none')) + (nd.some(function (x) { return /\*$/.test(x); }) ? '<div class="hint" style="margin:0;">* no driver</div>' : '') + '</td>'
          + '<td><span class="rec-chip ' + esc(s.status) + '">' + esc(s.status) + '</span></td>'
          + '<td><div class="rec-acts"><button class="btn btn-ghost btn-sm" type="button" data-act="edit" data-id="' + esc(s.id) + '">Edit</button>'
          + (s.status === 'active' ? '<button class="btn btn-ghost btn-sm" type="button" data-act="pause" data-id="' + esc(s.id) + '">Pause</button>' : s.status === 'paused' ? '<button class="btn btn-navy btn-sm" type="button" data-act="resume" data-id="' + esc(s.id) + '">Resume</button>' : '')
          + (s.status !== 'stopped' ? '<button class="btn btn-void btn-sm" type="button" data-act="stop" data-id="' + esc(s.id) + '">Stop</button>' : '<button class="btn btn-ghost btn-sm" type="button" data-act="remove" data-id="' + esc(s.id) + '">Forget</button>')
          + (s.status === 'active' ? '<button class="btn btn-ghost btn-sm" type="button" data-act="restore" data-id="' + esc(s.id) + '" title="Put back rides that were deleted or canceled for dates from today on">Restore missing dates</button>' : '')
          + '</div></td></tr>';
      });
      h += '</tbody></table></div>';
    }
    h += '</div>';
    p.innerHTML = h; p.hidden = false;
  }
  function onPanelClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-act'), id = b.getAttribute('data-id'), key = b.getAttribute('data-key');
    try {
      if (a === 'edit') openSeries(id);
      else if (a === 'pause') pause(id);
      else if (a === 'resume') resume(id);
      else if (a === 'restore') restore(id);
      else if (a === 'reassign') reassign(id);
      else if (a === 'remove') { if (window.confirm('Forget this stopped series? Its rides stay on record.')) remove(id); }
      else if (a === 'stop') {
        var s = get(id); if (!s) return;
        var fut = futureChildren(s).length;
        if (!window.confirm('Stop this weekly series for ' + ((s.template || {}).passenger || 'this ride') + '? No more rides will be created.')) return;
        var cancelF = fut ? window.confirm('Also cancel the ' + fut + ' future ride' + (fut === 1 ? '' : 's') + ' already on the board?\n\nOK = cancel them.  Cancel = leave them booked.') : false;
        stop(id, cancelF);
      }
      else if (a === 'convert') { var x = suggestions().filter(function (y) { return y.key === key; })[0]; if (x) convertSuggestion(x); }
      else if (a === 'dismiss') dismissSuggestion(key);
    } catch (err) { try { console.error('[recurring]', err); } catch (e2) {} }
  }
  function convertSuggestion(x) {
    var s = fromTrips(x.tripIds, { weekdays: x.weekdays, time: x.time, driverId: x.driverId });
    if (s) { sugCache.key = ''; renderPanel(true); openSeries(s.id); }
    return s;
  }

  /* ---------- rows: chip + buttons ---------- */
  function chipHtml(t) {
    var s = memberSeries(t); if (!s) return '';
    var h = '<span class="rec-chip ' + esc(s.status) + '" title="Weekly standing ride — ' + esc(weekdaysLabel(s.pattern.weekdays)) + (s.pattern.time ? ' at ' + esc(time12(s.pattern.time)) : '') + ' (' + esc(s.status) + '). Click to open the series." onclick="Recurring.openSeries(\'' + esc(s.id) + '\')">↻</span>';
    /* the gate left this child without its regular driver: say so on the row (gone once a driver is assigned) */
    var e = t.eligibility;
    if (!t.driverId && t.status === 'Booked' && e && e.standingBlank && e.ok === false) h += '<span class="rec-chip stopped" title="' + esc((e.reasons || [])[0] || 'not eligible') + '">⛔ ' + esc(driverName(e.standingDriverId) || 'regular driver') + ' not eligible</span>';
    return h;
  }
  function btnHtml(t) {
    if (!t || !t.id) return '';
    var s = memberSeries(t);
    if (s) return '<button class="btn btn-ghost btn-sm rec-btn" type="button" onclick="Recurring.openSeries(\'' + esc(s.id) + '\')" title="This ride repeats weekly — open the series">↻ Series</button> ';
    if (t.status !== 'Booked' && t.status !== 'Dispatched' && t.status !== 'Completed') return '';
    return '<button class="btn btn-ghost btn-sm rec-btn" type="button" onclick="Recurring.openDialog(\'' + esc(t.id) + '\')" title="Repeat this ride every week (standing order)">↻ Repeat</button> ';
  }
/* keep the inner wrappers' marker flags (e.g. __fixesWrapped) visible on the outermost function */
  function inheritFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_{1,2}\w*Wrapped$/.test(k) && w[k] === undefined) w[k] = orig[k]; }); } catch (e) {} return w; }
  function hook(name, make) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__recWrapped) return;
    var w = make(orig); w.__recWrapped = true; w._orig = orig; inheritFlags(w, orig);
    window[name] = w;
  }
  hook('sheetRow', function (orig) {
    return function (t) {
      var html = orig.apply(this, arguments);
      try {
        if (t && t.id && typeof html === 'string') {
          var marker = '<td class="acts">', i = html.indexOf(marker);
          if (i >= 0) html = html.slice(0, i + marker.length) + btnHtml(t) + html.slice(i + marker.length);
          var chip = chipHtml(t);
          if (chip) { var no = '#' + t.dispatchNo + '</td>', j = html.indexOf(no); if (j >= 0) html = html.slice(0, j + no.length - 5) + chip + html.slice(j + no.length - 5); }
        }
      } catch (e) {}
      return html;
    };
  });
  hook('tripActions', function (orig) {
    return function (t) {
      var html = orig.apply(this, arguments);
      try { if (t && t.id && typeof html === 'string') html = btnHtml(t) + html; } catch (e) {}
      return html;
    };
  });
  hook('refreshBoard', function (orig) {
    return function () { var out = orig.apply(this, arguments); try { renderPanel(false); } catch (e) {} try { injectNeedsYou(); } catch (e) {} return out; };
  });

  /* ---------- Needs-you (Simple mode): standing rides the gate left without a driver ---------- */
  /* The strip's head count is the number of lines on it, whoever put them there (simple.js, this module, the other modules). */
  function recountNeedsYou(host) {
    var head = host.querySelector('.ny-head'); if (!head) return;
    var n = host.querySelectorAll('.ny-item').length, cnt = head.querySelector('.ny-count');
    if (!cnt) { head.innerHTML = '<span class="ny-count">0</span> Needs you'; cnt = head.querySelector('.ny-count'); }
    cnt.textContent = String(n);
    var txt = head.childNodes[head.childNodes.length - 1];
    if (txt && txt.nodeType === 3) txt.textContent = n ? ' Needs you' : ' Nothing needs you right now';
    host.classList.toggle('ny-clear', !n);
  }
  /* simple.js rebuilds the strip from scratch inside its own enter() / goTab / refreshBoard paths, which never pass through the
     wrapped Simple.refreshNeedsYou: watch the strip and put our lines back whenever they are missing (ops.js does the same).
     The observer only acts when no line of ours is present, and injectNeedsYou adds nothing when there is nothing to say. */
  function watchNeedsYou(host) {
    if (!host || host.__recObserved || !window.MutationObserver) return;
    host.__recObserved = true;
    try { new MutationObserver(function () { try { if (!host.querySelector('.rec-ny')) injectNeedsYou(); } catch (e) {} }).observe(host, { childList: true }); } catch (e) {}
  }
  function injectNeedsYou() {
    var host = byId('needsYou'); if (!host) return;
    watchNeedsYou(host);
    var had = host.querySelector('.rec-ny');
    host.querySelectorAll('.rec-ny').forEach(function (n) { n.remove(); });
    if (!isSimple()) return;
    var items = [];
    series().forEach(function (s) {
      if (!s || s.status === 'stopped') return;
      var g = standingGaps(s), who = (s.template || {}).passenger || (s.template || {}).phone || 'this series', dn = driverName(g.driverId) || 'the regular driver';
      if (g.bad.length) items.push({ id: s.id, kind: 'bad', txt: '<b>Standing rides for ' + esc(who) + '</b> — ' + esc(dn) + ' is not eligible on ' + g.bad.length + ' date' + (g.bad.length === 1 ? '' : 's') + ' from ' + esc(fmtDate(g.firstBad)) + ' (' + esc(g.reason) + '). Those rides have no driver yet.', acts: [['series', 'Open series', 'btn-navy'], ['board', 'Board', 'btn-ghost']] });
      else if (g.ok.length) items.push({ id: s.id, kind: 'ok', txt: '<b>Standing rides for ' + esc(who) + '</b> — ' + g.ok.length + ' ride' + (g.ok.length === 1 ? '' : 's') + ' had no eligible driver; ' + esc(dn) + ' is eligible again.', acts: [['reassign', 'Put ' + esc(dn) + ' back', 'btn-go'], ['series', 'Open series', 'btn-ghost']] });
    });
    if (!items.length) { if (had) recountNeedsYou(host); return; }
    items.forEach(function (it) {
      var div = document.createElement('div'); div.className = 'ny-item rec-ny'; div.setAttribute('data-kind', 'recurring'); div.setAttribute('data-series', it.id);
      div.innerHTML = '<span class="ny-dot ' + (it.kind === 'bad' ? 'due' : 'soon') + '"></span><span class="ny-txt">' + it.txt + '</span><span class="ny-acts">' + it.acts.map(function (a) { return '<button type="button" class="btn btn-sm ' + a[2] + '" data-rec="' + a[0] + '" data-id="' + esc(it.id) + '">' + a[1] + '</button>'; }).join('') + '</span>';
      host.appendChild(div);
    });
    recountNeedsYou(host);
    if (!host.__recWired) { host.__recWired = true; host.addEventListener('click', act(function (e) { var b = e.target && e.target.closest ? e.target.closest('[data-rec]') : null; if (!b) return; e.stopPropagation(); e.preventDefault(); var a = b.getAttribute('data-rec'), id = b.getAttribute('data-id'); if (a === 'series') openSeries(id); else if (a === 'reassign') reassign(id); else if (a === 'board') { try { if (window.Simple && typeof window.Simple.enter === 'function') window.Simple.enter('board'); } catch (err) {} } })); }
  }
  function wrapNeedsYou() {
    var S = window.Simple; if (!S || typeof S.refreshNeedsYou !== 'function' || S.refreshNeedsYou.__recWrapped) return;
    var o = S.refreshNeedsYou, w = function () { var r = o.apply(this, arguments); try { injectNeedsYou(); } catch (e) {} return r; };
    w.__recWrapped = true; w._orig = o; inheritFlags(w, o); S.refreshNeedsYou = w;
  }
  hook('deleteTrip', function (orig) {
    return function (id) {
      var t = findTrip(id), sid = t && t.recurringId, date = t && t.date;
      var out = orig.apply(this, arguments);
      try { if (sid && !findTrip(id)) { var s = get(sid); var c = s && childFor(s, date); if (c && c.tripId === id) { c.removed = true; save(); } } } catch (e) {}
      return out;
    };
  });
  /* Board "Copy": the console deep-copies the trip, recurringId included. The copy is not in any series.children[],
     so it is an ordinary trip — drop the tag right away (the row already rendered without chip thanks to memberSeries). */
  hook('duplicateTrip', function (orig) {
    return function (id) {
      var t = findTrip(id), tagged = !!(t && t.recurringId);
      var out = orig.apply(this, arguments);
      try { if (tagged) untagStrays(); } catch (e) {}
      return out;
    };
  });
  hook('editTrip', function (orig) {
    return function (id) { var out = orig.apply(this, arguments); try { ensureBookBlock(); showMember(findTrip(id)); } catch (e) {} return out; };
  });
  hook('clearDispatch', function (orig) {
    return function () { var out = orig.apply(this, arguments); try { resetBookBlock(); } catch (e) {} return out; };
  });
  hook('reloadFromStorage', function (orig) {
    return function () { var out = orig.apply(this, arguments); try { ensureState(); lastSig = ''; renderPanel(true); } catch (e) {} return out; };
  });

  function rerender() {
    lastSig = '';
    try { if (typeof window.refreshBoard === 'function' && byId('activeBoard')) window.refreshBoard(); } catch (e) {}
    try { var vt = byId('view-trips'); if (vt && vt.classList.contains('active') && typeof window.renderTrips === 'function') window.renderTrips(); } catch (e) {}
    try { renderPanel(true); } catch (e) {}
    try { if (window.Simple && typeof window.Simple.refreshNeedsYou === 'function') window.Simple.refreshNeedsYou(); } catch (e) {}
  }

  /* ---------- daily run ---------- */
  var lastRunDay = '';
  function dailyTick() { try { if (todayStr() !== lastRunDay) generate({ silent: false }); } catch (e) {} }

  /* ---------- public API ---------- */
  window.Recurring = {
    _loaded: true, HORIZON_DAYS: HORIZON_DAYS,
    list: series, get: get, create: create, fromTrips: fromTrips, generate: generate, restore: restore,
    update: update, applyPatchToFuture: applyPatchToFuture, pause: pause, resume: resume, stop: stop, remove: remove,
    futureChildren: futureChildren, datesFor: datesFor, suggestions: suggestions, convertSuggestion: convertSuggestion,
    standingGaps: standingGaps, reassign: reassign, lastNotes: function () { return lastGenerateNotes.slice(); }, refreshNeedsYou: injectNeedsYou,
    openDialog: openDialog, openSeries: openSeries, closeDialog: closeDialog, render: function () { renderPanel(true); },
    weekdaysLabel: weekdaysLabel, childFor: childFor, memberSeries: memberSeries, untagStrays: untagStrays, FALLBACK_TIME: FALLBACK_TIME
  };

  /* ---------- boot ---------- */
  function boot() {
    try { ensureStyle(); } catch (e) {}
    try { if (ensureState()) save(); } catch (e) {}
    try { untagStrays(); } catch (e) {}   // copies made before this check existed
    try { ensureBookBlock(); } catch (e) {}
    try { wrapNeedsYou(); } catch (e) {}
    try { generate({ silent: true }); } catch (e) {}
    try { rerender(); } catch (e) {}
    setInterval(dailyTick, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) dailyTick(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
