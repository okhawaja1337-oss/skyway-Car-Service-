/* ======================================================================
   Skyway — ops.js
   Operations module (TURNAROUND-PLAN build rows 1 and 2, app-gaps.md §2 and §3).

   PART 1  Eligibility.  drivers[].eligibility / vehicles[].eligibility carry the TLC /
           DMV / insurance / registration / inspection expiry dates, affiliated base
           (default B01593), out-of-service flag, WAV flag and verifiedBy / verifiedAt.
           Ops.eligibility(driverId, vehicleId, trip) -> {ok, reasons[]} is pure.
           HARD GATE on every assign path: assignDriver, bestAssign, diqAssign,
           optAssignOne, optApplyAll, cycleStatus (Booked -> Dispatched), the Book form
           (#d_save), the edit overlay (saveEditOvl) and the board's Assign dropdown
           (which calls assignDriver).  A refusal toasts the reason and stamps
           trip.eligibility = {ok, reasons, checkedAt, ...}.  settings.enforceEligibility
           (default true) switches the gate to warn-only; an owner-PIN override records
           who / why on the trip.  Fleet gets the editor fields, a roster check panel and
           a printable roster with a signed-line footer.
   PART 2  Call log.  STATE.calls[] = one record per offered call {id, at, number,
           direction, outcome: answered|missed|voicemail|overflow, line, callbackAt,
           closedAt, tripId, reason: no-car|price-refused|booked|other}.  Logged from the
           F1–F6 lines (cidSet) and the caller pop-out (the same number within 3 minutes
           merges only into a still-open record: a transfer on another line or an unclosed
           missed call; a closed / answered / booked record never swallows a redial);
           one-tap Missed on each line;
           callback queue inside the Needs-you strip (Call back / Book / Close); CDR import
           (paste or file, column mapping saved in settings.cdrMapping, transfers within
           60 s deduped, idempotent); weekly metric CSV by day.
   PART 3  Partner-base record settings.partnerBase {baseName, baseLicence, contact,
           agreementSignedAt, recordExchangeAgreed, verifiedAt}.  The overflow buttons stay
           DISABLED (tooltip says why) until the record is complete; overflow trips carry
           trip.partnerBaseLicence and the TLC export writes that base in
           affiliated_base_number.  Owner decision 13: overflow is never on by default.

   Wrapper pattern (same as money.js / driver-link.js / sync.js): IIFE, the original
   kept as window.fn._orig, window.fn replaced by a wrapper that calls through.  STATE is
   the console's top-level let (shared lexical global).  Never edits index.html.  Works
   with Cloud off.  Plain ES2019, no build step.  In pop-out windows (?screen=...) the
   gate wraps stay active (they carry Dispatch / Edit / Assign controls and persist into the
   shared store); only the console-only panels and the F-line call logging are skipped.
   The classic-view Dispatch button (classicDispatch) is gated before its own toast runs.
   Busy check: hard block only when the driver is OUT (Dispatched) within 30 min; Booked
   overlaps are a note.  settings.requireVehicle (default false) makes a resolved vehicle
   mandatory so registration / inspection / affiliation are always checked.

   Public API: window.Ops (see bottom).
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;

  /* Pop-out windows (?screen=resv / calls / board / entry / wallboard ...) carry real Dispatch, Edit and
     Assign controls and persist() straight into the shared localStorage, so the eligibility GATE stays on
     there too.  Only the console-only DOM (roster panel, calls panel, settings card, Needs-you items,
     F-line call logging) is skipped in a pop-out. */
  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }
  if (window.Ops && window.Ops._loaded) return;

  /* ---------- helpers (own copies; globals may be missing) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  var opsToastAt = 0;   // when this module last toasted: the refusal safety net never overwrites a later note of its own
  function toast(m, w) { opsToastAt = Date.now(); if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[ops] ' + m); } catch (e) {} }
  function save() { if (typeof window.save === 'function') { try { window.save(); return; } catch (e) {} } if (typeof window.saveNow === 'function') { try { window.saveNow(); } catch (e) {} } }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  function trips() { if (!Array.isArray(STATE.trips)) STATE.trips = []; return STATE.trips; }
  function drivers() { if (!Array.isArray(STATE.drivers)) STATE.drivers = []; return STATE.drivers; }
  function vehicles() { if (!Array.isArray(STATE.vehicles)) STATE.vehicles = []; return STATE.vehicles; }
  function calls() { if (!Array.isArray(STATE.calls)) STATE.calls = []; return STATE.calls; }
  function findTrip(id) { if (id && typeof id === 'object') return id; return trips().filter(function (t) { return t && t.id === id; })[0] || null; }
  function findDriver(id) { return drivers().filter(function (d) { return d && d.id === id; })[0] || null; }
  function findVehicle(id) { return vehicles().filter(function (v) { return v && v.id === id; })[0] || null; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayStr() { if (typeof window.todayStr === 'function') { try { return window.todayStr(); } catch (e) {} } var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function nowISO() { return new Date().toISOString(); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { try { console.error('[ops]', err); } catch (e2) {} } }; }
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
  function dateOf(iso) { var d = new Date(iso); if (isNaN(d)) return ''; return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function h12(t) { t = String(t || '').trim(); var m = t.match(/^(\d{1,2}):(\d{2})/); if (!m) return t || 'ASAP'; var h = +m[1], mi = m[2], ap = h >= 12 ? 'pm' : 'am'; h = h % 12; if (h === 0) h = 12; return h + ':' + mi + ap; }
  function fmtWhen(iso) { var d = new Date(iso); if (isNaN(d)) return ''; return h12(pad2(d.getHours()) + ':' + pad2(d.getMinutes())); }
  function fmtStamp(iso) { var d = new Date(iso); if (isNaN(d)) return ''; return dateOf(iso) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function numberKey(n) { var d = digits(n); if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1); return d.length > 10 ? d.slice(-10) : d; }
  function fmtPhone(p) { if (window.Region && typeof window.Region.fmtPhone === 'function') { try { return window.Region.fmtPhone(p); } catch (e) {} } var d = numberKey(p); if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6); return String(p || ''); }
  function M() { return window.Messages && typeof window.Messages === 'object' ? window.Messages : null; }
  function gsmSafe(s) { if (M() && typeof M().gsmSafe === 'function') { try { return M().gsmSafe(s); } catch (e) {} } return String(s == null ? '' : s).replace(/[—–]/g, '-').replace(/→/g, 'to').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...'); }
  function normalizePhone(p) { if (M() && M().normalizePhone) return M().normalizePhone(p); var s = String(p || '').trim(); if (!s) return ''; var plus = s.charAt(0) === '+', d = digits(s); if (!d) return ''; if (plus) return '+' + d; if (d.length === 10) return '+1' + d; return '+' + d; }
  /* Every text that leaves the console goes through messages.js's smsHref (gsmSafe inside); the fallback applies the same pass. */
  function smsHref(phone, body) { if (M() && M().smsHref) return M().smsHref(phone, body); var h = 'sms:' + normalizePhone(phone); if (body) h += '?&body=' + encodeURIComponent(gsmSafe(body)); return h; }
  function openHref(href) { try { var a = document.createElement('a'); a.href = href; a.rel = 'noopener'; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(function () { try { a.remove(); } catch (e) {} }, 500); return true; } catch (e) { return false; } }
  function download(name, content, type) { if (typeof window.download === 'function') { try { window.download(name, content, type); return true; } catch (e) {} } try { var blob = new Blob([content], { type: type || 'text/plain' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); return true; } catch (e) { return false; } }
  function csvCell(v) { if (typeof window.csv === 'function') { try { return window.csv(v); } catch (e) {} } v = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function bizName() { return settings().name || 'Skyway Car Service'; }
  function refreshBoard() { try { if (typeof window.refreshBoard === 'function' && byId('activeBoard')) window.refreshBoard(); } catch (e) {} }
  function isSimple() { try { return !!(window.Simple && typeof window.Simple.isSimple === 'function' && window.Simple.isSimple()); } catch (e) { return false; } }
  /* wrap(name, maker): window[name] = maker(orig) with ._orig kept — the module's one wrapper pattern */
/* keep the inner wrappers' marker flags (e.g. __fixesWrapped) visible on the outermost function */
  function inheritFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_{1,2}\w*Wrapped$/.test(k) && w[k] === undefined) w[k] = orig[k]; }); } catch (e) {} return w; }
  function wrap(name, maker) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig._opsWrapped) return false;
    var w = maker(orig);
    w._opsWrapped = true; w._orig = orig;
    inheritFlags(w, orig);   // simple.js's wrapUndo guard (and the other modules' flags) stay honest if re-checked
    window[name] = w;
    return true;
  }

  /* ======================================================================
     PART 1 — ELIGIBILITY
     ====================================================================== */
  var DEFAULT_BASE = 'B01593', BUSY_MIN = 30;
  function baseNo() { return String(settings().base || '').trim().toUpperCase() || DEFAULT_BASE; }
  function enforce() { return settings().enforceEligibility !== false; }
  /* settings.requireVehicle (default false): when on, a trip is refused unless a vehicle resolves (trip.vehicleId or the driver's usual vehicle),
     so registration / inspection / affiliation are always checked.  Off: a driver without a vehicle on record is judged on the driver record alone. */
  function requireVehicle() { return settings().requireVehicle === true; }
  function rec(o) { if (!o) return {}; if (!o.eligibility || typeof o.eligibility !== 'object') o.eligibility = {}; return o.eligibility; }
  /* driver: tlcExp, dmvExp, insuranceExp, vehicleId (usual car), outOfService, outOfServiceWhy, wav, verifiedBy, verifiedAt
     vehicle: tlcExp, regExp, inspExp, insuranceExp, affiliatedBase, outOfService, outOfServiceWhy, wav, verifiedBy, verifiedAt */
  function ensureRecords() {
    var dirty = false;
    drivers().forEach(function (d) { if (!d) return; if (!d.eligibility || typeof d.eligibility !== 'object') { d.eligibility = {}; dirty = true; } });
    vehicles().forEach(function (v) {
      if (!v) return;
      if (!v.eligibility || typeof v.eligibility !== 'object') { v.eligibility = {}; dirty = true; }
      if (v.eligibility.affiliatedBase == null) { v.eligibility.affiliatedBase = baseNo(); dirty = true; }   // default: affiliated to our base
      if (v.eligibility.wav == null && /wheelchair|wav/i.test(String(v.type || ''))) { v.eligibility.wav = true; dirty = true; }
    });
    return dirty;
  }
  function tripDate(trip) { return (trip && isDate(trip.date)) ? trip.date : todayStr(); }
  function needsWav(trip) {
    if (!trip) return false;
    if (trip.accessibleNeed === true) return true;
    return /wheelchair|\bwav\b|accessible/i.test(String(trip.vtype || '')) || /\bwheelchair\b/i.test(String(trip.notes || ''));
  }
  function expiryCheck(label, val, onDate, reasons) {
    if (!val) { reasons.push(label + ' expiry date not recorded'); return; }
    if (!isDate(val)) { reasons.push(label + ' expiry date is not a date (' + val + ')'); return; }
    if (val < onDate) reasons.push(label + ' expired ' + val);
  }
  function pickupMs(t) {
    try { if (typeof window.pickupDT === 'function') { var d = window.pickupDT(t); if (d && !isNaN(d)) return d.getTime(); } } catch (e) {}
    if (!t || !isDate(t.date)) return null;
    var p = t.date.split('-').map(Number), tp = String(t.time || '0:0').split(':');
    var d2 = new Date(p[0], p[1] - 1, p[2], +tp[0] || 0, +tp[1] || 0, 0); return isNaN(d2) ? null : d2.getTime();
  }
  /* busy check.  HARD block: the driver is OUT (Dispatched) on another trip whose pickup is within 30 minutes of this one
     (or has no pickup time to compare).  Two merely Booked jobs close together are a normal chain of short rides: that is a
     WARNING (shown, never blocking, no override needed).  status 'Dispatched' only for conflict(); softConflict() finds Booked overlaps. */
  function overlapping(d, trip, statuses) {
    if (!d || !trip) return null;
    var mine = pickupMs(trip);
    return trips().filter(function (x) {
      if (!x || x.id === trip.id || x.driverId !== d.id) return false;
      if (statuses.indexOf(x.status) < 0) return false;
      var other = pickupMs(x);
      if (x.status === 'Dispatched' && (mine == null || other == null)) return true;
      if (mine == null || other == null) return false;
      return Math.abs(other - mine) <= BUSY_MIN * 60000;
    })[0] || null;
  }
  function conflict(d, trip) { return overlapping(d, trip, ['Dispatched']); }
  function softConflict(d, trip) { return overlapping(d, trip, ['Booked']); }
  function driverReasons(d, onDate, trip, opts, warnings) {
    var reasons = [], e = rec(d), name = d.name || 'Driver';
    if (d.active === false) reasons.push(name + ' is Off duty');
    if (e.outOfService) reasons.push(name + ' is out of service' + (e.outOfServiceWhy ? ' (' + e.outOfServiceWhy + ')' : ''));
    if (!String(d.tlc || '').trim()) reasons.push(name + ': no TLC driver licence number');
    expiryCheck(name + ': TLC driver licence', e.tlcExp, onDate, reasons);
    expiryCheck(name + ': DMV licence', e.dmvExp, onDate, reasons);
    if (!(opts && opts.noBusy) && trip) {
      var c = conflict(d, trip); if (c) reasons.push(name + ' is already out on #' + (c.dispatchNo || '?') + (c.time ? ' (pickup ' + h12(c.time) + ')' : ''));
      var s = softConflict(d, trip); if (s && warnings) warnings.push(name + ' is also booked on #' + (s.dispatchNo || '?') + (s.time ? ' (pickup ' + h12(s.time) + ')' : '') + ' - ' + BUSY_MIN + ' min apart or less');
    }
    return reasons;
  }
  function vehicleReasons(v, onDate, trip) {
    var reasons = [], e = rec(v), label = v.name || v.plate || v.tlc || 'Vehicle';
    if (e.outOfService) reasons.push(label + ' is out of service' + (e.outOfServiceWhy ? ' (' + e.outOfServiceWhy + ')' : ''));
    if (!String(v.plate || '').trim()) reasons.push(label + ': no plate on record');
    expiryCheck(label + ': TLC vehicle licence', e.tlcExp, onDate, reasons);
    expiryCheck(label + ': registration', e.regExp, onDate, reasons);
    expiryCheck(label + ': inspection', e.inspExp, onDate, reasons);
    expiryCheck(label + ': insurance', e.insuranceExp, onDate, reasons);
    var aff = String(e.affiliatedBase || '').trim().toUpperCase();
    if (aff !== baseNo()) reasons.push(label + ' is not affiliated to base ' + baseNo() + (aff ? ' (record says ' + aff + ')' : ' (no base recorded)'));
    if (trip && needsWav(trip) && !e.wav) reasons.push(label + ' is not wheelchair accessible and this trip needs a WAV');
    return reasons;
  }
  function resolveVehicle(d, vehicleId) {
    var v = vehicleId ? findVehicle(vehicleId) : null;
    if (!v && d && rec(d).vehicleId) v = findVehicle(rec(d).vehicleId);
    return v;
  }
  /* Pure: no toast, no save. trip may be a trip, a form snapshot or null.  -> {ok, reasons[], warnings[], driverId, vehicleId} */
  function eligibility(driverId, vehicleId, trip, opts) {
    trip = trip || null; var onDate = tripDate(trip), reasons = [], warnings = [];
    if (!driverId) return { ok: false, reasons: ['No driver assigned'], warnings: [], driverId: '', vehicleId: vehicleId || '' };
    var d = findDriver(driverId);
    if (!d) return { ok: false, reasons: ['Driver is not on the roster'], warnings: [], driverId: driverId, vehicleId: vehicleId || '' };
    reasons = driverReasons(d, onDate, trip, opts, warnings);
    var v = resolveVehicle(d, vehicleId);
    if (v) reasons = reasons.concat(vehicleReasons(v, onDate, trip));
    else {
      if (requireVehicle()) reasons.push((d.name || 'Driver') + ': no vehicle on record - pick the car on the job or set the usual vehicle in Fleet');
      expiryCheck((d.name || 'Driver') + ': insurance', rec(d).insuranceExp, onDate, reasons);   // no vehicle on record: the driver record must carry the insurance date
      if (trip && needsWav(trip) && !rec(d).wav) reasons.push('This trip needs a wheelchair-accessible vehicle and none is assigned');
    }
    return { ok: !reasons.length, reasons: reasons, warnings: warnings, driverId: driverId, vehicleId: v ? v.id : (vehicleId || '') };
  }
  function daysTo(s) { if (!isDate(s)) return null; var a = new Date(s + 'T12:00:00'), b = new Date(todayStr() + 'T12:00:00'); return Math.round((a - b) / 86400000); }
  /* roster standing for one record: {state:'ok'|'soon'|'blocked', reasons[], soonest} */
  function standing(obj, kind) {
    var today = todayStr(), reasons = kind === 'vehicle' ? vehicleReasons(obj, today, null) : driverReasons(obj, today, null, { noBusy: true });
    if (kind === 'driver' && !resolveVehicle(obj, '')) expiryCheck((obj.name || 'Driver') + ': insurance', rec(obj).insuranceExp, today, reasons);
    var e = rec(obj), soonest = null;
    ['tlcExp', 'dmvExp', 'regExp', 'inspExp', 'insuranceExp'].forEach(function (k) { var n = daysTo(e[k]); if (n != null && n >= 0 && (soonest == null || n < soonest)) soonest = n; });
    return { state: reasons.length ? 'blocked' : (soonest != null && soonest <= 30 ? 'soon' : 'ok'), reasons: reasons, soonest: soonest };
  }
  function stamp(trip, res, extra) {
    if (!trip) return;
    trip.eligibility = Object.assign({ ok: !!res.ok, reasons: (res.reasons || []).slice(), warnings: (res.warnings || []).slice(), checkedAt: nowISO(), driverId: res.driverId || '', vehicleId: res.vehicleId || '', enforced: enforce() }, extra || {});
  }
  function summarise(reasons) { if (!reasons || !reasons.length) return ''; return reasons[0] + (reasons.length > 1 ? ' (+' + (reasons.length - 1) + ' more)' : ''); }

  /* ---------- the gate ---------- */
  var BYPASS = null;   // {by, why, at} while an owner override is running
  var lastRefusal = null;   // {at, tripId, msg}: lets a wrapper re-show the reason when the caller's own toast would hide it
  function gate(trip, driverId, vehicleId, verb, retry) {
    var res = eligibility(driverId, vehicleId, trip);
    if (BYPASS) { res.override = BYPASS; return res; }
    if (res.ok) { if (res.warnings && res.warnings.length) toast('Note - ' + summarise(res.warnings) + '.', true); return res; }
    if (!enforce()) { toast('Warning - ' + summarise(res.reasons) + '. Eligibility check is set to warn only.', true); return res; }
    var msg = (verb || 'Not assigned') + ' - ' + summarise(res.reasons);
    toast(msg, true);
    /* safety net for callers that toast their own success message right after a refused call: re-show the reason */
    var me = lastRefusal = { at: Date.now(), tripId: trip && trip.id || '', msg: msg };
    setTimeout(function () { try { var el = byId('toast'); if (lastRefusal === me && opsToastAt <= me.at && el && el.textContent !== msg) toast(msg, true); } catch (e) {} }, 80);
    if (trip && trip.id && findTrip(trip.id)) { stamp(findTrip(trip.id), res); save(); }
    showOverrideBar(trip, res, retry);
    return null;
  }
  /* owner-PIN override: settings.adminPin (simple.js's PIN); refuses when no PIN is set */
  /* recover.js: a signed-in owner (or an owner PIN already given to recover.js this session) is not asked again */
  function recoverOwner() { try { var R = window.Recover; return !!(R && R._loaded && typeof R.who === 'function' && R.who() && R.role() === 'owner'); } catch (e) { return false; } }
  function ownerPinOK() {
    if (recoverOwner()) return true;
    var pin = String(settings().adminPin || '').trim();
    if (!/^\d{4}$/.test(pin)) { toast('No admin PIN is set. The owner sets one in Settings before an override is possible.', true); return false; }
    var a = null; try { a = window.prompt('Owner PIN to override the eligibility block:', ''); } catch (e) { a = null; }
    if (a === null) return false;
    if (String(a).trim() !== pin) { toast('Wrong PIN.', true); return false; }
    return true;
  }
  function overrideWith(retry, res) {
    if (!ownerPinOK()) return false;
    var by = '', why = '';
    try { by = String(window.prompt('Your name (recorded on the trip):', '') || '').trim(); } catch (e) {}
    if (!by) { toast('Override cancelled - a name is required.', true); return false; }
    try { why = String(window.prompt('Why is this assignment allowed anyway?', '') || '').trim(); } catch (e) {}
    if (!why) { toast('Override cancelled - a reason is required.', true); return false; }
    BYPASS = { by: by, why: why, at: nowISO(), reasons: (res && res.reasons || []).slice() };
    try { retry(); } finally { BYPASS = null; }
    hideOverrideBar();
    toast('Override recorded for ' + by + '.');
    return true;
  }
  var overrideTimer = null, overrideCtx = null;
  function showOverrideBar(trip, res, retry) {
    var bar = byId('opsOverride');
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'opsOverride'; bar.className = 'ops-ovr'; bar.hidden = true;
      bar.innerHTML = '<span class="ops-ovr-txt" id="opsOverrideTxt"></span><button type="button" class="btn btn-sm btn-navy" id="opsOverrideGo">Override with owner PIN</button><button type="button" class="btn btn-sm btn-ghost" id="opsOverrideX">Dismiss</button>';
      document.body.appendChild(bar);
      byId('opsOverrideGo').addEventListener('click', act(function () { if (overrideCtx) overrideWith(overrideCtx.retry, overrideCtx.res); }));
      byId('opsOverrideX').addEventListener('click', act(hideOverrideBar));
    }
    overrideCtx = { trip: trip, res: res, retry: retry };
    byId('opsOverrideTxt').textContent = 'Blocked' + (trip && trip.dispatchNo ? ' on #' + trip.dispatchNo : '') + ': ' + (res.reasons || []).join('; ');
    byId('opsOverrideGo').hidden = typeof retry !== 'function';
    bar.hidden = false;
    clearTimeout(overrideTimer); overrideTimer = setTimeout(hideOverrideBar, 20000);
  }
  function hideOverrideBar() { var bar = byId('opsOverride'); if (bar) bar.hidden = true; overrideCtx = null; clearTimeout(overrideTimer); }

  /* ---------- wraps: every assign path ---------- */
  function wrapAssignLike(name, verb) {
    wrap(name, function (orig) {
      return function (tripId, driverId) {
        var self = this, args = arguments, t = findTrip(tripId);
        if (!t || !driverId) return orig.apply(self, args);
        var res = gate(t, driverId, t.vehicleId, verb, function () { window[name].apply(self, args); });
        if (!res) { refreshBoard(); return undefined; }
        var r = orig.apply(self, args);
        stamp(t, res, res.override ? { override: res.override } : null); save();
        return r;
      };
    });
  }
  wrapAssignLike('assignDriver', 'Not assigned');   // also the board's manual Assign dropdown (onchange="assignDriver(...)")
  wrapAssignLike('diqAssign', 'Not assigned');
  wrapAssignLike('optAssignOne', 'Not assigned');

  wrap('bestAssign', function (orig) {
    return function (tripId) {
      var self = this, args = arguments, t = findTrip(tripId);
      if (!t || typeof window.rankDriversForTrip !== 'function') return orig.apply(self, args);
      var ranker = window.rankDriversForTrip, blocked = [], swapped = false;
      if (BYPASS) { var r0 = orig.apply(self, args); if (t.driverId) { stamp(t, eligibility(t.driverId, t.vehicleId, t), { override: BYPASS }); save(); } return r0; }
      var filtering = function (call) {
        var ranked = ranker.apply(this, arguments);
        if (!enforce()) return ranked;
        return ranked.filter(function (r) { var res = eligibility(r.d.id, t.vehicleId, t); if (!res.ok) blocked.push(res.reasons[0]); return res.ok; });
      };
      var probe = filtering({ phone: t.phone, pu: t.puAddr, do: t.doAddr, vtype: t.vtype, pax: t.pax, notes: t.notes });
      if (enforce() && !probe.length) {
        var all = ranker({ phone: t.phone, pu: t.puAddr, do: t.doAddr, vtype: t.vtype, pax: t.pax, notes: t.notes });
        if (all.length) { toast('No eligible driver for #' + (t.dispatchNo || '?') + ' - ' + blocked[0] + (blocked.length > 1 ? ' (+' + (blocked.length - 1) + ' more)' : ''), true); stamp(t, { ok: false, reasons: blocked, driverId: '', vehicleId: t.vehicleId || '' }); save(); return undefined; }
        return orig.apply(self, args);   // no drivers at all: the original's own message
      }
      blocked = [];
      try { window.rankDriversForTrip = filtering; swapped = true; return orig.apply(self, args); }
      finally {
        if (swapped && window.rankDriversForTrip === filtering) window.rankDriversForTrip = ranker;
        if (t.driverId) { var res = eligibility(t.driverId, t.vehicleId, t); stamp(t, res); if (!res.ok && !enforce()) toast('Warning - ' + summarise(res.reasons) + '. Eligibility check is set to warn only.', true); save(); }
      }
    };
  });

  wrap('optApplyAll', function (orig) {
    return function () {
      var self = this, args = arguments;
      var plan = null; try { if (typeof _optPlan !== 'undefined') plan = _optPlan; } catch (e) { plan = null; }
      if (!plan || !Array.isArray(plan.assignments) || BYPASS) return orig.apply(self, args);
      var keep = [], skipped = [], stamps = [];
      plan.assignments.forEach(function (a) {
        var t = a && a.callId ? findTrip(a.callId) : null;
        if (!a || !a.driverId || !t) { keep.push(a); return; }
        var res = eligibility(a.driverId, t.vehicleId, t);
        if (res.ok || !enforce()) { keep.push(a); stamps.push([t, res]); }
        else { skipped.push('#' + (t.dispatchNo || '?') + ' ' + res.reasons[0]); stamp(t, res); }
      });
      var temp = Object.assign({}, plan, { assignments: keep }), r;
      try { _optPlan = temp; r = orig.apply(self, args); }
      finally { try { if (_optPlan === temp) _optPlan = plan; } catch (e) {} }
      stamps.forEach(function (p) { stamp(p[0], p[1]); });
      if (skipped.length) toast('Skipped ' + skipped.length + ' assignment' + (skipped.length > 1 ? 's' : '') + ' - ' + skipped[0] + (skipped.length > 1 ? ' (+' + (skipped.length - 1) + ' more)' : ''), true);
      save();
      return r;
    };
  });

  /* Booked -> Dispatched is the "cannot accept an assignment" gate */
  wrap('cycleStatus', function (orig) {
    return function (id) {
      var self = this, args = arguments, t = findTrip(id);
      if (!t || t.status !== 'Booked') return orig.apply(self, args);
      var res = gate(t, t.driverId, t.vehicleId, 'Not dispatched', t.driverId ? function () { window.cycleStatus.apply(self, args); } : null);
      if (!res) return undefined;
      var r = orig.apply(self, args);
      stamp(t, res, res.override ? { override: res.override } : null); save();
      return r;
    };
  });

  /* Classic-view Dispatch button: classicDispatch() calls cycleStatus() and then toasts '#N dispatched.' whatever happened,
     which would hide the refusal.  Gate first; refuse before the original runs so the visible toast names the reason. */
  wrap('classicDispatch', function (orig) {
    return function () {
      var self = this, args = arguments, t = null;
      try { if (typeof window.classicSelTrip === 'function') t = window.classicSelTrip(); } catch (e) { t = null; }
      if (!t || t.status !== 'Booked' || !t.driverId) return orig.apply(self, args);
      var res = gate(t, t.driverId, t.vehicleId, 'Not dispatched', function () { window.classicDispatch.apply(self, args); });
      if (!res) { try { if (typeof window.renderClassic === 'function') window.renderClassic(); } catch (e) {} return undefined; }
      return orig.apply(self, args);   // the cycleStatus wrapper runs inside and stamps the trip (BYPASS stays set during an override retry)
    };
  });
  /* Edit overlay Save (inline onclick="saveEditOvl()") */
  wrap('saveEditOvl', function (orig) {
    return function () {
      var self = this, args = arguments, t = null;
      try { if (typeof editOvlId !== 'undefined') t = findTrip(editOvlId); } catch (e) { t = null; }
      var drvEl = byId('eo_drv'), vehEl = byId('eo_veh'), drv = drvEl ? drvEl.value : '';
      if (!t || !drv) return orig.apply(self, args);
      var snap = Object.assign({}, t, { date: (byId('eo_date') && byId('eo_date').value) || t.date, time: (byId('eo_time') && byId('eo_time').value) || t.time, notes: (byId('eo_notes') && byId('eo_notes').value) || t.notes, vehicleId: vehEl ? vehEl.value : t.vehicleId });
      var res = gate(snap, drv, snap.vehicleId, 'Not saved', function () { window.saveEditOvl.apply(self, args); });
      if (!res) return undefined;
      var r = orig.apply(self, args);
      stamp(t, res, res.override ? { override: res.override } : null); save();
      return r;
    };
  });

  /* Book form: the #d_save handler is anonymous, so a capture-phase listener on document runs first and can stop it */
  var dsavePre = null;
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#d_save') : null; if (!b) return;
    try {
      var drv = (byId('d_driver') || {}).value || '', veh = (byId('d_vehicle') || {}).value || '';
      var editing = null; try { if (typeof editingId !== 'undefined') editing = editingId; } catch (err) { editing = null; }
      var asap = false; try { asap = (typeof whenMode !== 'undefined' && whenMode === 'asap'); } catch (err) { asap = false; }
      dsavePre = { editing: editing, count: trips().length, driverId: drv, vehicleId: veh, phone: (byId('d_phone') || {}).value || '' };
      if (!drv) return;
      var snap = { id: editing || '', date: asap ? todayStr() : ((byId('d_date') || {}).value || todayStr()), time: (byId('d_time') || {}).value || '', vtype: (byId('d_vtype') || {}).value || '', pax: Number((byId('d_pax') || {}).value) || 1, notes: (byId('d_notes') || {}).value || '', vehicleId: veh, dispatchNo: editing ? ((findTrip(editing) || {}).dispatchNo) : '' };
      var res = gate(snap, drv, veh, 'Not booked', function () { b.click(); });
      if (!res) { e.stopPropagation(); e.preventDefault(); dsavePre = null; return; }
      dsavePre.res = res; dsavePre.override = res.override || null;
    } catch (err) { try { console.error('[ops]', err); } catch (e2) {} }
  }, true);
  /* bubble phase on document: the console's own handler has run (trip pushed or updated) */
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#d_save') : null; if (!b || !dsavePre) return;
    var pre = dsavePre; dsavePre = null;
    try {
      var t = pre.editing ? findTrip(pre.editing) : null;
      if (!t && trips().length > pre.count) t = trips()[0];
      if (!t) return;
      if (pre.driverId && t.driverId === pre.driverId) stamp(t, pre.res || eligibility(t.driverId, t.vehicleId, t), pre.override ? { override: pre.override } : null);
      if (!pre.editing) attachTripToCall(t);
      save();
    } catch (err) { try { console.error('[ops]', err); } catch (e2) {} }
  }, false);

  /* ⛔ in the driver dropdowns for drivers who are blocked today (still selectable: the toast explains) */
  wrap('driverOptions', function (orig) {
    return function () {
      var html = orig.apply(this, arguments);
      try {
        if (typeof html !== 'string') return html;
        var blocked = drivers().filter(function (d) { return d && standing(d, 'driver').state === 'blocked'; });
        if (!blocked.length) return html;
        // mark through the DOM: another module (fixes.js) may already have re-serialised the options, so a string match is not safe
        var sel = document.createElement('select'); sel.innerHTML = html; var changed = false;
        blocked.forEach(function (d) {
          var id = String(d.id);
          for (var i = 0; i < sel.options.length; i++) {
            var o = sel.options[i];
            if (o.value === id && !o.getAttribute('data-blocked')) { o.setAttribute('data-blocked', '1'); o.textContent = '⛔ ' + o.textContent; changed = true; }
          }
        });
        return changed ? sel.innerHTML : html;
      } catch (e) {}
      return html;
    };
  });

  /* ---------- Fleet: editor fields, row chips, roster panel ---------- */
  function fld(label, id, type, extra) { return '<label class="fld"><span class="lbl">' + esc(label) + '</span><input type="' + (type || 'text') + '" id="' + id + '"' + (extra || '') + '></label>'; }
  function chk(label, id) { return '<label class="fld ops-chk"><input type="checkbox" id="' + id + '" style="width:auto;"> <span class="lbl" style="margin:0;">' + esc(label) + '</span></label>'; }
  function driverFieldsHtml() {
    return '<div id="ops_drv_fields" class="ops-fields"><div class="ops-fields-head">Eligibility (TLC roster)</div>'
      + '<div class="grid2">' + fld('TLC driver licence expires', 'ops_dr_tlcExp', 'date') + fld('DMV licence expires', 'ops_dr_dmvExp', 'date') + '</div>'
      + '<div class="grid2">' + fld('Insurance expires (if the driver carries the policy)', 'ops_dr_insExp', 'date') + '<label class="fld"><span class="lbl">Usual vehicle</span><select id="ops_dr_vehicle"></select></label></div>'
      + '<div class="grid2">' + chk('Out of service', 'ops_dr_oos') + chk('Can take wheelchair (WAV) jobs', 'ops_dr_wav') + '</div>'
      + fld('Out-of-service reason', 'ops_dr_oosWhy', 'text', ' placeholder="e.g. suspended, on leave"')
      + '<div class="grid2">' + fld('Documents verified by', 'ops_dr_verifiedBy', 'text', ' placeholder="your name"') + '<label class="fld"><span class="lbl">Verified at</span><div class="ops-verify"><span id="ops_dr_verifiedAtTxt" class="hint" style="margin:0;">never</span><button type="button" class="btn btn-ghost btn-sm" id="ops_dr_verify">Verified now</button><input type="hidden" id="ops_dr_verifiedAt"></div></label></div>'
      + '<div class="hint" style="margin:0;">Save Driver stores these with the driver. A missing or expired date blocks every assignment while the eligibility check is on.</div></div>';
  }
  function vehicleFieldsHtml() {
    return '<div id="ops_veh_fields" class="ops-fields"><div class="ops-fields-head">Eligibility (TLC roster)</div>'
      + '<div class="grid2">' + fld('TLC vehicle licence expires', 'ops_ve_tlcExp', 'date') + fld('Registration expires', 'ops_ve_regExp', 'date') + '</div>'
      + '<div class="grid2">' + fld('Inspection expires', 'ops_ve_inspExp', 'date') + fld('Insurance expires', 'ops_ve_insExp', 'date') + '</div>'
      + '<div class="grid2">' + fld('Affiliated base', 'ops_ve_base', 'text', ' placeholder="' + esc(DEFAULT_BASE) + '"') + fld('Out-of-service reason', 'ops_ve_oosWhy', 'text', ' placeholder="e.g. in the shop"') + '</div>'
      + '<div class="grid2">' + chk('Out of service', 'ops_ve_oos') + chk('Wheelchair accessible (WAV)', 'ops_ve_wav') + '</div>'
      + '<div class="grid2">' + fld('Documents verified by', 'ops_ve_verifiedBy', 'text', ' placeholder="your name"') + '<label class="fld"><span class="lbl">Verified at</span><div class="ops-verify"><span id="ops_ve_verifiedAtTxt" class="hint" style="margin:0;">never</span><button type="button" class="btn btn-ghost btn-sm" id="ops_ve_verify">Verified now</button><input type="hidden" id="ops_ve_verifiedAt"></div></label></div></div>';
  }
  function setVal(id, v) { var el = byId(id); if (!el) return; if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v; }
  function getVal(id) { var el = byId(id); if (!el) return ''; return el.type === 'checkbox' ? !!el.checked : String(el.value || '').trim(); }
  function setVerifiedTxt(prefix, at, by) { var el = byId(prefix + '_verifiedAtTxt'); if (el) el.textContent = at ? fmtStamp(at) + (by ? ' by ' + by : '') : 'never'; }
  function fillDriverFields(d) {
    var e = d ? rec(d) : {};
    var sel = byId('ops_dr_vehicle'); if (sel) sel.innerHTML = '<option value="">— none on record —</option>' + vehicles().map(function (v) { return '<option value="' + esc(v.id) + '">' + esc(v.name || v.plate || v.tlc || 'Vehicle') + (v.plate ? ' · ' + esc(v.plate) : '') + '</option>'; }).join('');
    setVal('ops_dr_tlcExp', e.tlcExp); setVal('ops_dr_dmvExp', e.dmvExp); setVal('ops_dr_insExp', e.insuranceExp); setVal('ops_dr_vehicle', e.vehicleId || '');
    setVal('ops_dr_oos', e.outOfService); setVal('ops_dr_wav', e.wav); setVal('ops_dr_oosWhy', e.outOfServiceWhy); setVal('ops_dr_verifiedBy', e.verifiedBy); setVal('ops_dr_verifiedAt', e.verifiedAt);
    setVerifiedTxt('ops_dr', e.verifiedAt, e.verifiedBy);
  }
  function fillVehicleFields(v) {
    var e = v ? rec(v) : {};
    setVal('ops_ve_tlcExp', e.tlcExp); setVal('ops_ve_regExp', e.regExp); setVal('ops_ve_inspExp', e.inspExp); setVal('ops_ve_insExp', e.insuranceExp);
    setVal('ops_ve_base', v ? (e.affiliatedBase == null ? baseNo() : e.affiliatedBase) : baseNo()); setVal('ops_ve_oosWhy', e.outOfServiceWhy);
    setVal('ops_ve_oos', e.outOfService); setVal('ops_ve_wav', v ? e.wav : false); setVal('ops_ve_verifiedBy', e.verifiedBy); setVal('ops_ve_verifiedAt', e.verifiedAt);
    setVerifiedTxt('ops_ve', e.verifiedAt, e.verifiedBy);
  }
  function readDriverFields() {
    return { tlcExp: getVal('ops_dr_tlcExp'), dmvExp: getVal('ops_dr_dmvExp'), insuranceExp: getVal('ops_dr_insExp'), vehicleId: getVal('ops_dr_vehicle'), outOfService: getVal('ops_dr_oos'), wav: getVal('ops_dr_wav'), outOfServiceWhy: getVal('ops_dr_oosWhy'), verifiedBy: getVal('ops_dr_verifiedBy'), verifiedAt: getVal('ops_dr_verifiedAt') };
  }
  function readVehicleFields() {
    return { tlcExp: getVal('ops_ve_tlcExp'), regExp: getVal('ops_ve_regExp'), inspExp: getVal('ops_ve_inspExp'), insuranceExp: getVal('ops_ve_insExp'), affiliatedBase: (getVal('ops_ve_base') || baseNo()).toUpperCase(), outOfService: getVal('ops_ve_oos'), wav: getVal('ops_ve_wav'), outOfServiceWhy: getVal('ops_ve_oosWhy'), verifiedBy: getVal('ops_ve_verifiedBy'), verifiedAt: getVal('ops_ve_verifiedAt') };
  }
  /* writes the editor's record onto a driver/vehicle (idempotent; keeps other eligibility keys) */
  function setDriverEligibility(id, patch) { var d = findDriver(id); if (!d) return null; Object.assign(rec(d), patch || {}); return d; }
  function setVehicleEligibility(id, patch) { var v = findVehicle(id); if (!v) return null; Object.assign(rec(v), patch || {}); if (rec(v).affiliatedBase) rec(v).affiliatedBase = String(rec(v).affiliatedBase).toUpperCase(); return v; }
  var fleetPre = null;
  function injectFleetFields() {
    var notes = byId('dr_notes'), name = byId('ve_name');
    if (notes && !byId('ops_drv_fields')) {
      var host = notes.closest ? notes.closest('label.fld') : null; if (!host) host = notes.parentNode;
      host.insertAdjacentHTML('afterend', driverFieldsHtml());
      fillDriverFields(null);
      byId('ops_dr_verify').addEventListener('click', act(function () { var at = nowISO(); setVal('ops_dr_verifiedAt', at); if (!getVal('ops_dr_verifiedBy')) { var who = ''; try { who = String(window.prompt('Who checked the documents?', '') || '').trim(); } catch (e) {} setVal('ops_dr_verifiedBy', who); } setVerifiedTxt('ops_dr', at, getVal('ops_dr_verifiedBy')); toast('Verified-at stamped. Press Save Driver to keep it.'); }));
    }
    if (name && !byId('ops_veh_fields')) {
      var host2 = name.closest ? name.closest('label.fld') : null; if (!host2) host2 = name.parentNode;
      host2.insertAdjacentHTML('afterend', vehicleFieldsHtml());
      fillVehicleFields(null);
      byId('ops_ve_verify').addEventListener('click', act(function () { var at = nowISO(); setVal('ops_ve_verifiedAt', at); if (!getVal('ops_ve_verifiedBy')) { var who = ''; try { who = String(window.prompt('Who checked the documents?', '') || '').trim(); } catch (e) {} setVal('ops_ve_verifiedBy', who); } setVerifiedTxt('ops_ve', at, getVal('ops_ve_verifiedBy')); toast('Verified-at stamped. Press Save Vehicle to keep it.'); }));
    }
  }
  wrap('editDriver', function (orig) { return function (id) { var r = orig.apply(this, arguments); try { fillDriverFields(findDriver(id)); } catch (e) {} return r; }; });
  wrap('editVehicle', function (orig) { return function (id) { var r = orig.apply(this, arguments); try { fillVehicleFields(findVehicle(id)); } catch (e) {} return r; }; });
  wrap('clearDriver', function (orig) { return function () { var r = orig.apply(this, arguments); try { fillDriverFields(null); } catch (e) {} return r; }; });
  wrap('clearVehicle', function (orig) { return function () { var r = orig.apply(this, arguments); try { fillVehicleFields(null); } catch (e) {} return r; }; });
  /* Save Driver / Save Vehicle: snapshot before (capture), apply after (bubble) when the console's handler saved */
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('#dr_save,#ve_save') : null; if (!t) return;
    try {
      fleetPre = null;
      if (t.id === 'dr_save') { if (byId('ops_drv_fields')) fleetPre = { kind: 'driver', id: (byId('dr_id') || {}).value || '', count: drivers().length, patch: readDriverFields(), name: (byId('dr_name') || {}).value || '' }; }
      else if (byId('ops_veh_fields')) fleetPre = { kind: 'vehicle', id: (byId('ve_id') || {}).value || '', count: vehicles().length, patch: readVehicleFields() };   // no editor fields on this page: never overwrite the record with blanks
    } catch (err) { fleetPre = null; }
  }, true);
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('#dr_save,#ve_save') : null; if (!t || !fleetPre) return;
    var pre = fleetPre; fleetPre = null;
    try {
      var list = pre.kind === 'driver' ? drivers() : vehicles(), target = null;
      if (pre.id) { var idEl = byId(pre.kind === 'driver' ? 'dr_id' : 've_id'); if (idEl && !idEl.value) target = pre.kind === 'driver' ? findDriver(pre.id) : findVehicle(pre.id); }   // the form was cleared: the save went through
      else if (list.length > pre.count) target = list[list.length - 1];
      if (!target) return;
      if (pre.kind === 'driver') setDriverEligibility(target.id, pre.patch); else setVehicleEligibility(target.id, pre.patch);
      save();
      if (pre.kind === 'driver' && typeof window.renderDrivers === 'function') window.renderDrivers(); else if (typeof window.renderVehicles === 'function') window.renderVehicles();
      renderRoster();
    } catch (err) { try { console.error('[ops]', err); } catch (e2) {} }
  }, false);

  function chipHtml(st) {
    if (st.state === 'blocked') return '<span class="ops-chip bad" title="' + esc(st.reasons.join('; ')) + '">⛔ ' + esc(st.reasons[0].replace(/^[^:]+: /, '')) + '</span>';
    if (st.state === 'soon') return '<span class="ops-chip soon" title="A document expires in ' + st.soonest + ' day' + (st.soonest === 1 ? '' : 's') + '">expires in ' + st.soonest + ' d</span>';
    return '<span class="ops-chip ok" title="All dates valid">✓ eligible</span>';
  }
  function decorateRows(bodyId, list, kind) {
    var body = byId(bodyId); if (!body) return;
    var rows = body.querySelectorAll('tr');
    list.forEach(function (o, i) { var tr = rows[i]; if (!o || !tr || !tr.cells || tr.cells.length < 2 || tr.querySelector('.ops-chip')) return; tr.cells[0].insertAdjacentHTML('beforeend', ' ' + chipHtml(standing(o, kind))); });
  }
  wrap('renderDrivers', function (orig) { return function () { var r = orig.apply(this, arguments); try { decorateRows('driverBody', drivers(), 'driver'); injectFleetFields(); renderRoster(); } catch (e) {} return r; }; });
  wrap('renderVehicles', function (orig) { return function () { var r = orig.apply(this, arguments); try { decorateRows('vehicleBody', vehicles(), 'vehicle'); injectFleetFields(); renderRoster(); } catch (e) {} return r; }; });

  /* ---------- roster panel + print ---------- */
  function rosterRows() {
    var out = [];
    drivers().forEach(function (d) { if (!d) return; var e = rec(d), st = standing(d, 'driver'); var v = resolveVehicle(d, ''); out.push({ kind: 'Driver', name: d.name || '', tlc: d.tlc || '', plate: v ? (v.plate || '') : '', tlcExp: e.tlcExp || '', exp2: e.dmvExp || '', exp2Label: 'DMV', inspExp: '', insExp: e.insuranceExp || '', base: v ? (rec(v).affiliatedBase || '') : '', wav: !!e.wav, oos: !!e.outOfService, st: st, verifiedBy: e.verifiedBy || '', verifiedAt: e.verifiedAt || '', active: d.active !== false }); });
    vehicles().forEach(function (v) { if (!v) return; var e = rec(v), st = standing(v, 'vehicle'); out.push({ kind: 'Vehicle', name: v.name || v.type || '', tlc: v.tlc || '', plate: v.plate || '', tlcExp: e.tlcExp || '', exp2: e.regExp || '', exp2Label: 'Reg', inspExp: e.inspExp || '', insExp: e.insuranceExp || '', base: e.affiliatedBase || '', wav: !!e.wav, oos: !!e.outOfService, st: st, verifiedBy: e.verifiedBy || '', verifiedAt: e.verifiedAt || '', active: true }); });
    return out;
  }
  function statusText(r) { if (r.st.state === 'blocked') return 'BLOCKED: ' + r.st.reasons.join('; '); if (r.st.state === 'soon') return 'OK - expires in ' + r.st.soonest + ' d'; return 'OK'; }
  function rosterTableHtml(rows, forPrint) {
    var h = '<table class="' + (forPrint ? 'ops-print-tbl' : 'data') + '"><thead><tr><th>Type</th><th>Name / unit</th><th>TLC #</th><th>Plate</th><th>TLC exp</th><th>DMV / Reg exp</th><th>Inspection exp</th><th>Insurance exp</th><th>Base</th><th>Status</th><th>Verified by / at</th></tr></thead><tbody>';
    if (!rows.length) h += '<tr><td colspan="11"><div class="empty">No drivers or vehicles yet.</div></td></tr>';
    rows.forEach(function (r) {
      var cls = r.st.state === 'blocked' ? 'ops-bad' : (r.st.state === 'soon' ? 'ops-soon' : 'ops-ok');
      h += '<tr class="' + cls + '"><td>' + esc(r.kind) + (r.wav ? ' <span class="hint" style="margin:0;">WAV</span>' : '') + '</td><td>' + esc(r.name) + (r.active ? '' : ' <span class="hint" style="margin:0;">(Off duty)</span>') + '</td><td class="mono">' + esc(r.tlc || '—') + '</td><td class="mono">' + esc(r.plate || '—') + '</td><td>' + esc(r.tlcExp || '—') + '</td><td>' + esc(r.exp2 || '—') + (r.exp2 ? ' <span class="hint" style="margin:0;">' + r.exp2Label + '</span>' : '') + '</td><td>' + esc(r.inspExp || (r.kind === 'Driver' ? 'n/a' : '—')) + '</td><td>' + esc(r.insExp || '—') + '</td><td class="mono">' + esc(r.base || '—') + '</td><td>' + esc(statusText(r)) + '</td><td>' + (r.verifiedAt ? esc(r.verifiedBy || '?') + ' · ' + esc(fmtStamp(r.verifiedAt)) : '<i>not verified</i>') + '</td></tr>';
    });
    return h + '</tbody></table>';
  }
  function renderRoster() {
    var view = byId('view-fleet'); if (!view || POPOUT) return;
    var p = byId('opsRoster');
    if (!p) { p = document.createElement('div'); p.id = 'opsRoster'; p.className = 'panel ops-panel'; view.insertBefore(p, view.firstChild); p.addEventListener('click', onRosterClick); }
    var rows = rosterRows(), blocked = rows.filter(function (r) { return r.st.state === 'blocked'; }).length, soon = rows.filter(function (r) { return r.st.state === 'soon'; }).length;
    p.innerHTML = '<div class="panel-head">Roster check <span class="hint" style="margin:0;font-weight:400;">' + rows.length + ' record' + (rows.length === 1 ? '' : 's') + ' · ' + blocked + ' blocked · ' + soon + ' expiring within 30 days · eligibility check ' + (enforce() ? 'ON' : 'OFF (warn only)') + '</span></div><div class="panel-body">'
      + '<div class="ops-acts" style="margin-bottom:8px;"><button type="button" class="btn btn-navy btn-sm" data-act="print">Print roster</button><button type="button" class="btn btn-ghost btn-sm" data-act="csv">Roster CSV</button><span class="hint" style="margin:0;align-self:center;">Edit the dates in the Drivers and Vehicles forms below. Blocked records cannot be assigned or dispatched while the check is on (Settings → Eligibility).</span></div>'
      + '<div class="tbl-scroll" style="max-height:300px;">' + rosterTableHtml(rows, false) + '</div></div>';
  }
  function rosterHtml() {
    var s = settings(), rows = rosterRows(), when = fmtStamp(nowISO());
    return '<div class="ops-print"><div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;"><div><h2 style="margin:0 0 2px;">' + esc(bizName()) + ' — Driver &amp; vehicle roster</h2><div>Base ' + esc(baseNo()) + (s.phone ? ' · Tel ' + esc(s.phone) : '') + ' · printed ' + esc(when) + '</div></div><div style="text-align:right;font-size:12px;">Eligibility check: <b>' + (enforce() ? 'ON' : 'OFF (warn only)') + '</b><br>' + rows.filter(function (r) { return r.st.state === 'blocked'; }).length + ' blocked · ' + rows.filter(function (r) { return r.st.state === 'soon'; }).length + ' expiring within 30 days</div></div><hr>'
      + rosterTableHtml(rows, true)
      + '<div class="ops-print-foot"><div class="hint" style="margin:0 0 14px;">Dates are the expiry dates on the documents checked. A record reads BLOCKED when a date is missing or expired, the vehicle is not affiliated to this base, or the record is out of service. Keep the signed copy with the TLC file.</div>'
      + '<div class="ops-sign"><div>Roster reviewed by: ______________________________</div><div>Signature: ______________________________</div><div>Date: ________________</div></div></div></div>';
  }
  function printRoster() {
    var html = rosterHtml();
    if (typeof window.openPrint === 'function') { try { window.openPrint(html); return true; } catch (e) {} }
    var w = null; try { w = window.open('', 'skyway_roster', 'width=1000,height=800'); } catch (e) { w = null; }
    if (!w) { toast('Allow pop-ups for this page, then try again.', true); return false; }
    try { w.document.open(); w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Roster</title></head><body>' + html + '</body></html>'); w.document.close(); } catch (e) { return false; }
    return true;
  }
  function rosterCSV() {
    var head = ['type', 'name', 'tlc_number', 'plate', 'tlc_expiry', 'dmv_or_registration_expiry', 'inspection_expiry', 'insurance_expiry', 'affiliated_base', 'wav', 'out_of_service', 'status', 'verified_by', 'verified_at'];
    var lines = [head.join(',')];
    rosterRows().forEach(function (r) { lines.push([r.kind, r.name, r.tlc, r.plate, r.tlcExp, r.exp2, r.inspExp, r.insExp, r.base, r.wav ? 'yes' : 'no', r.oos ? 'yes' : 'no', statusText(r), r.verifiedBy, r.verifiedAt].map(csvCell).join(',')); });
    var txt = lines.join('\r\n') + '\r\n';
    download('skyway-roster-' + todayStr() + '.csv', txt, 'text/csv');
    return txt;
  }
  function onRosterClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null; if (!b) return;
    var a = b.getAttribute('data-act');
    try { if (a === 'print') printRoster(); else if (a === 'csv') rosterCSV(); } catch (err) { try { console.error('[ops]', err); } catch (e2) {} }
  }

  /* ======================================================================
     PART 2 — CALL LOG
     ====================================================================== */
  var CALLBACK_MIN = 2, CONSOLE_DEDUPE_MS = 3 * 60000, CDR_DEDUPE_MS = 60000, ATTRIB_MS = 30 * 60000;
  var OUTCOMES = ['answered', 'missed', 'voicemail', 'overflow'], REASONS = [['no-car', 'No car'], ['price-refused', 'Price refused'], ['booked', 'Booked'], ['other', 'Other']];
  var lineCall = [null, null, null, null, null, null];
  var bookingCallId = '';
  function findCall(id) { return calls().filter(function (c) { return c && c.id === id; })[0] || null; }
  function callMs(c) { var d = new Date(c.at); return isNaN(d) ? 0 : d.getTime(); }
  /* the most recent inbound call on this number within windowMs of `at` */
  function findNear(key, atMs, windowMs, direction, filter) {
    if (!key) return null;
    var best = null, bestGap = Infinity;
    calls().forEach(function (c) { if (!c || c.numberKey !== key) return; if (direction && (c.direction || 'in') !== direction) return; if (filter && !filter(c)) return; var gap = Math.abs(callMs(c) - atMs); if (gap <= windowMs && gap < bestGap) { best = c; bestGap = gap; } });
    return best;
  }
  function noTrip(c) { return !c.tripId; }
  /* console dedupe (app-gaps §3): a number seen again within 3 minutes is the SAME offered call only while its record is still open —
     no outcome yet and ringing on another line (a transfer), or missed / voicemail and not closed (a redial before the callback).
     A record that was answered, closed or booked is history: the next ring from that number is a new offered call. */
  function openForMerge(line) {
    return function (c) {
      if (c.tripId) return false;
      if (!c.outcome) return !line || !c.line || c.line !== line;
      return (c.outcome === 'missed' || c.outcome === 'voicemail') && !c.closedAt;
    };
  }
  function newCall(p) {
    return { id: 'c' + uid(), at: p.at || nowISO(), number: String(p.number || '').trim(), numberKey: numberKey(p.number), direction: p.direction || 'in', outcome: p.outcome || '', line: p.line || '', source: p.source || 'manual', callbackAt: '', closedAt: '', tripId: '', reason: '', ringSec: p.ringSec != null ? p.ringSec : null, talkSec: p.talkSec != null ? p.talkSec : null, cdrRef: p.cdrRef || '', attempts: [] };
  }
  /* logCall({number, line, source, outcome?, at?}) — one record per offered call: the same number within 3 minutes merges only into a still-open record (see openForMerge) */
  function logCall(p, windowMs) {
    p = p || {}; var key = numberKey(p.number); if (!key) return null;
    var atMs = p.at ? new Date(p.at).getTime() : Date.now();
    var c = findNear(key, atMs, windowMs == null ? CONSOLE_DEDUPE_MS : windowMs, 'in', openForMerge(p.line || ''));
    if (c) { if (!c.line && p.line) c.line = p.line; if (p.outcome && !c.outcome) applyOutcome(c, p.outcome); save(); return c; }
    c = newCall(p); if (c.outcome) applyOutcome(c, c.outcome);
    calls().push(c); save(); rerenderCalls();
    return c;
  }
  function applyOutcome(c, outcome) {
    c.outcome = outcome;
    if (outcome === 'missed' || outcome === 'voicemail') { if (!c.callbackAt) c.callbackAt = new Date(callMs(c) + CALLBACK_MIN * 60000).toISOString(); if (c.closedAt && !c.tripId && c.reason !== 'booked') { /* reopened */ c.closedAt = ''; c.reason = ''; } }
    else if (outcome === 'answered' && !c.closedAt) { c.closedAt = nowISO(); }
    else if (outcome === 'overflow') { if (!c.closedAt) { c.closedAt = nowISO(); c.reason = c.reason || 'no-car'; } }
  }
  function setOutcome(id, outcome) {
    var c = findCall(id); if (!c || OUTCOMES.indexOf(outcome) < 0) return false;
    if (c.outcome === 'answered' && (outcome === 'missed' || outcome === 'voicemail')) { c.closedAt = ''; }
    applyOutcome(c, outcome); save(); rerenderCalls();
    if (outcome === 'missed' || outcome === 'voicemail') toast(outcome === 'missed' ? 'Missed call logged - call ' + fmtPhone(c.number) + ' back within ' + CALLBACK_MIN + ' minutes.' : 'Voicemail logged - call ' + fmtPhone(c.number) + ' back within ' + CALLBACK_MIN + ' minutes.');
    return true;
  }
  function closeCall(id, reason) {
    var c = findCall(id); if (!c) return false;
    reason = String(reason || 'other'); if (!REASONS.some(function (r) { return r[0] === reason; })) reason = 'other';
    c.closedAt = nowISO(); c.reason = reason; save(); rerenderCalls();
    return true;
  }
  function reopenCall(id) { var c = findCall(id); if (!c) return false; c.closedAt = ''; c.reason = ''; save(); rerenderCalls(); return true; }
  function callBack(id, by) {
    var c = findCall(id); if (!c) return false;
    c.attempts = c.attempts || []; c.attempts.push({ at: nowISO(), by: by || '' });
    save(); rerenderCalls();
    var tel = normalizePhone(c.number); if (tel) openHref('tel:' + tel);
    toast('Calling ' + fmtPhone(c.number) + ' back - log the result with Book or Close.');
    return true;
  }
  function bookFromCall(id) {
    var c = findCall(id); if (!c) return false;
    bookingCallId = c.id;
    if (typeof window.openCallerPopout === 'function') { try { window.openCallerPopout(c.number); return true; } catch (e) {} }
    if (typeof window.applyCaller === 'function') { try { window.applyCaller(c.number); return true; } catch (e) {} }
    return false;
  }
  /* a trip was just booked: attach it to the call that produced it (callback item closes, never reappears) */
  function attachTripToCall(t) {
    if (!t) return null;
    var key = numberKey(t.phone), c = bookingCallId ? findCall(bookingCallId) : null;
    if (c && key && c.numberKey && c.numberKey !== key) c = null;
    if (!c && key) c = findNear(key, Date.now(), ATTRIB_MS, 'in', noTrip);
    bookingCallId = '';
    if (!c) return null;
    c.tripId = t.id; c.reason = 'booked'; c.closedAt = nowISO(); if (!c.outcome) c.outcome = 'answered';
    save(); rerenderCalls();
    return c;
  }
  function callbackQueue() {
    return calls().filter(function (c) { return c && (c.direction || 'in') === 'in' && (c.outcome === 'missed' || c.outcome === 'voicemail') && !c.closedAt; })
      .sort(function (a, b) { return callMs(a) - callMs(b); });
  }
  function missedToday() { var td = todayStr(); return calls().filter(function (c) { return c && dateOf(c.at) === td && (c.outcome === 'missed' || c.outcome === 'voicemail'); }); }

  /* ---------- hooks into the F-line / caller-ID flow (main console only: a pop-out never logs calls) ---------- */
  if (!POPOUT) wrap('cidSet', function (orig) {
    return function (i, v) {
      var prev = ''; try { if (typeof CIDSTATE !== 'undefined' && CIDSTATE) prev = CIDSTATE[i] || ''; } catch (e) { prev = ''; }
      var val = String(v || '').trim();
      try {
        if (val && val !== prev) { var c = logCall({ line: 'F' + (i + 1), number: val, source: 'cid' }); lineCall[i] = c ? c.id : null; }
        else if (!val && prev) { var open = lineCall[i] ? findCall(lineCall[i]) : null; if (open && !open.outcome) { applyOutcome(open, 'answered'); save(); } lineCall[i] = null; }
      } catch (e) { try { console.error('[ops]', e); } catch (e2) {} }
      return orig.apply(this, arguments);
    };
  });
  function markAnswered(num, source) {
    var key = numberKey(num); if (!key) return null;
    var c = findNear(key, Date.now(), ATTRIB_MS, 'in', noTrip) || logCall({ number: num, source: source || 'screenpop' }, 0);
    if (c && !c.outcome) { applyOutcome(c, 'answered'); save(); }
    if (c) bookingCallId = c.id;
    return c;
  }
  if (!POPOUT) wrap('openCallerPopout', function (orig) { return function (num) { try { markAnswered(num, 'cid'); } catch (e) {} return orig.apply(this, arguments); }; });
  if (!POPOUT) wrap('applyCaller', function (orig) { return function (num) { try { if (num) markAnswered(num, 'screenpop'); } catch (e) {} return orig.apply(this, arguments); }; });
  /* one-tap Missed / Voicemail on each F-line */
  if (!POPOUT) wrap('renderCID', function (orig) {
    return function () {
      var r = orig.apply(this, arguments);
      try {
        var host = byId('cid_lines'); if (!host) return r;
        var rows = host.querySelectorAll('.cid-row'), st = []; try { st = (typeof CIDSTATE !== 'undefined' && CIDSTATE) ? CIDSTATE : []; } catch (e) { st = []; }
        rows.forEach(function (row, i) {
          if (row.querySelector('.ops-cid')) return;
          var val = st[i] || ''; if (!val) return;
          var c = lineCall[i] ? findCall(lineCall[i]) : findNear(numberKey(val), Date.now(), CONSOLE_DEDUPE_MS, 'in');
          var span = document.createElement('span'); span.className = 'ops-cid';
          var state = c && c.outcome ? c.outcome : '';
          span.innerHTML = (state ? '<span class="ops-chip ' + (state === 'answered' ? 'ok' : 'bad') + '">' + esc(state) + '</span>' : '')
            + (state === 'missed' ? '' : '<button type="button" class="btn btn-void btn-sm" data-ops-cid="missed" data-line="' + i + '" title="One tap: this call rang and nobody picked up. It goes to the callback list for ' + CALLBACK_MIN + ' minutes.">Missed</button>')
            + (state === 'voicemail' ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-ops-cid="voicemail" data-line="' + i + '" title="Caller left a voicemail - goes to the callback list">Voicemail</button>');
          row.appendChild(span);
        });
        if (!host._opsWired) { host._opsWired = true; host.addEventListener('click', act(function (e) { var b = e.target.closest ? e.target.closest('[data-ops-cid]') : null; if (!b) return; e.preventDefault(); e.stopPropagation(); var i = +b.getAttribute('data-line'), num = st[i] || ''; if (!num) return; var c = lineCall[i] ? findCall(lineCall[i]) : null; if (!c) { c = logCall({ line: 'F' + (i + 1), number: num, source: 'cid' }); lineCall[i] = c ? c.id : null; } if (c) setOutcome(c.id, b.getAttribute('data-ops-cid')); if (typeof window.renderCID === 'function') window.renderCID(); })); }
      } catch (e) { try { console.error('[ops]', e); } catch (e2) {} }
      return r;
    };
  });

  /* ---------- callback queue in the Needs-you strip ---------- */
  function knownLabel(num) { if (typeof window.cidKnownLabel === 'function') { try { return window.cidKnownLabel(num) || ''; } catch (e) {} } return ''; }
  function queueItemHtml(c, nowMs) {
    var due = new Date(c.callbackAt || callMs(c) + CALLBACK_MIN * 60000).getTime(), diff = due - nowMs, when;
    if (diff > 0) when = 'call back within ' + Math.max(1, Math.ceil(diff / 1000)) + ' s';
    else if (-diff < 60000) when = 'call back now';
    else when = 'overdue by ' + Math.round(-diff / 60000) + ' min';
    var k = knownLabel(c.number), tries = (c.attempts || []).length;
    var pb = partnerComplete();
    return '<div class="ny-item ops-ny" data-call="' + esc(c.id) + '" data-kind="callback"><span class="ny-dot due"></span><span class="ny-txt"><b>' + (c.outcome === 'voicemail' ? 'Voicemail' : 'Missed call') + ' ' + esc(fmtPhone(c.number)) + '</b> at ' + esc(fmtWhen(c.at)) + (c.line ? ' on ' + esc(c.line) : '') + ' — ' + esc(when) + (k ? ' · ' + esc(k) : '') + (tries ? ' · called back ' + tries + '×' : '') + '</span>'
      + '<span class="ny-acts"><button type="button" class="btn btn-sm btn-go" data-ops="callback" data-call="' + esc(c.id) + '" title="Dial the number and log the attempt">Call back</button>'
      + '<button type="button" class="btn btn-sm btn-navy" data-ops="book" data-call="' + esc(c.id) + '" title="Open a job for this caller; booking closes the item">Book</button>'
      + '<select class="ops-reason" data-call="' + esc(c.id) + '" title="Why is this call closed?">' + REASONS.map(function (r) { return '<option value="' + r[0] + '">' + esc(r[1]) + '</option>'; }).join('') + '</select>'
      + '<button type="button" class="btn btn-sm btn-ghost" data-ops="close" data-call="' + esc(c.id) + '">Close</button>'
      + '<button type="button" class="btn btn-sm btn-ghost ops-overflow" data-ops="overflow" data-call="' + esc(c.id) + '"' + (pb ? '' : ' disabled') + ' title="' + esc(pb ? 'Text this caller\'s number to the partner base ' + partner().baseName + ' (' + partner().baseLicence + ') and close the call as overflow' : OVERFLOW_WHY) + '">Partner base</button></span></div>';
  }
  var injecting = false;
  function injectNeedsYou() {
    var host = byId('needsYou'); if (!host || injecting || POPOUT) return;
    injecting = true;
    try {
      var had = host.querySelector('.ops-ny');
      host.querySelectorAll('.ops-ny').forEach(function (n) { n.remove(); });
      var head = host.querySelector('.ny-head');
      if (!isSimple() || !head) return;
      var q = callbackQueue();
      if (!q.length) { if (had) recountNeedsYou(host); return; }
      var now = Date.now(), html = q.map(function (c) { return queueItemHtml(c, now); }).join('');
      head.insertAdjacentHTML('afterend', html);
      recountNeedsYou(host);
      if (!host._opsWired) { host._opsWired = true; host.addEventListener('click', onQueueClick); }
    } catch (e) { try { console.error('[ops]', e); } catch (e2) {} }
    finally { injecting = false; }
  }
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
  function onQueueClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-ops]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var id = b.getAttribute('data-call'), a = b.getAttribute('data-ops');
    try {
      if (a === 'callback') callBack(id);
      else if (a === 'book') bookFromCall(id);
      else if (a === 'close') { var sel = b.parentNode.querySelector('.ops-reason'); closeCall(id, sel ? sel.value : 'other'); }
      else if (a === 'overflow') overflowCall(id);
    } catch (err) { try { console.error('[ops]', err); } catch (e2) {} }
    injectNeedsYou();
  }
  function watchNeedsYou() {
    var host = byId('needsYou'); if (!host || host._opsObserved || POPOUT) return;
    host._opsObserved = true;
    try {
      new MutationObserver(function () { if (injecting) return; if (!host.querySelector('.ops-ny')) injectNeedsYou(); }).observe(host, { childList: true });
    } catch (e) {}
    injectNeedsYou();
  }

  /* ---------- Calls panel (Board -> Call history) ---------- */
  function callsToday() { var td = todayStr(); return calls().filter(function (c) { return c && dateOf(c.at) === td; }).sort(function (a, b) { return callMs(b) - callMs(a); }); }
  function returnedWithin(c, ms) {
    var base = callMs(c), limit = base + ms;
    if ((c.attempts || []).some(function (a) { var t = new Date(a.at).getTime(); return t >= base && t <= limit; })) return true;
    return calls().some(function (o) { return o && o !== c && (o.direction === 'out') && o.numberKey === c.numberKey && callMs(o) >= base && callMs(o) <= limit; });
  }
  function dayMetrics(list) {
    var m = { offered: 0, answered: 0, answered30: 0, answeredNoRing: 0, missed: 0, voicemail: 0, overflow: 0, returned2: 0, booked: 0, outbound: 0 };
    list.forEach(function (c) {
      if (!c) return;
      if (c.direction === 'out') { m.outbound++; return; }
      m.offered++;
      if (c.outcome === 'answered' || (!c.outcome && c.tripId)) { m.answered++; if (c.ringSec != null) { if (Number(c.ringSec) <= 30) m.answered30++; } else m.answeredNoRing++; }
      else if (c.outcome === 'missed') { m.missed++; if (returnedWithin(c, CALLBACK_MIN * 60000)) m.returned2++; }
      else if (c.outcome === 'voicemail') { m.voicemail++; if (returnedWithin(c, CALLBACK_MIN * 60000)) m.returned2++; }
      else if (c.outcome === 'overflow') m.overflow++;
      if (c.tripId) m.booked++;
    });
    return m;
  }
  function weekDays(anchor) {
    var d = isDate(anchor) ? new Date(anchor + 'T12:00:00') : new Date(); d.setHours(12, 0, 0, 0);
    var dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow);   // Monday
    var out = []; for (var i = 0; i < 7; i++) { out.push(d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())); d.setDate(d.getDate() + 1); }
    return out;
  }
  function weeklyCSV(anchor) {
    var days = weekDays(anchor), head = ['date', 'offered', 'answered', 'answered_within_30s', 'answered_ring_time_unknown', 'missed', 'voicemail', 'missed_returned_within_2min', 'overflow', 'booked', 'outbound_calls'];
    var lines = [head.join(',')], tot = dayMetrics([]);
    days.forEach(function (day) {
      var m = dayMetrics(calls().filter(function (c) { return c && dateOf(c.at) === day; }));
      Object.keys(tot).forEach(function (k) { tot[k] += m[k]; });
      lines.push([day, m.offered, m.answered, m.answered30, m.answeredNoRing, m.missed, m.voicemail, m.returned2, m.overflow, m.booked, m.outbound].join(','));
    });
    lines.push(['week_total', tot.offered, tot.answered, tot.answered30, tot.answeredNoRing, tot.missed, tot.voicemail, tot.returned2, tot.overflow, tot.booked, tot.outbound].join(','));
    var txt = lines.join('\r\n') + '\r\n';
    download('skyway-calls-week-' + days[0] + '.csv', txt, 'text/csv');
    toast('Weekly call metrics downloaded for the week of ' + days[0] + '.');
    return txt;
  }
  function tile(v, k, cls) { return '<div class="stat' + (cls ? ' ' + cls : '') + '"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>'; }
  function tripNo(id) { var t = id ? findTrip(id) : null; return t ? '#' + (t.dispatchNo || '') : ''; }
  var PANEL_ID = 'opsCalls';
  function ensureCallsPanel() {
    var view = byId('view-history'); if (!view || POPOUT) return null;
    var p = byId(PANEL_ID);
    if (!p) { p = document.createElement('div'); p.id = PANEL_ID; p.className = 'panel ops-panel'; view.insertBefore(p, view.firstChild); p.addEventListener('click', onCallsClick); p.addEventListener('change', onCallsChange); }
    return p;
  }
  function renderCallsPanel() {
    var p = ensureCallsPanel(); if (!p) return;
    var list = callsToday(), m = dayMetrics(list), q = callbackQueue();
    var h = '<div class="panel-head">Calls today <span class="hint" style="margin:0;font-weight:400;">' + esc(todayStr()) + ' · one record per offered call · ' + calls().length + ' on file</span></div><div class="panel-body">';
    h += '<div class="stat-row">' + tile(m.offered, 'Offered today') + tile(m.answered + (m.answeredNoRing ? ' (' + m.answered30 + ' ≤ 30 s)' : ' (' + m.answered30 + ' ≤ 30 s)'), 'Answered', 'ops-ok-t') + tile(m.missed + m.voicemail, 'Missed / voicemail', (m.missed + m.voicemail) ? 'ops-bad-t' : '') + tile(m.returned2, 'Returned within 2 min') + tile(q.length, 'Waiting for a callback', q.length ? 'ops-bad-t' : '') + '</div>';
    h += '<div class="ops-acts" style="margin:8px 0;"><input type="text" id="ops_call_num" class="mono" placeholder="Caller number" style="width:150px;" autocomplete="off"><select id="ops_call_line">' + [1, 2, 3, 4, 5, 6].map(function (n) { return '<option value="F' + n + '">F' + n + '</option>'; }).join('') + '<option value="">no line</option></select>'
      + '<button type="button" class="btn btn-void btn-sm" data-act="log" data-outcome="missed">Log missed</button><button type="button" class="btn btn-ghost btn-sm" data-act="log" data-outcome="voicemail">Log voicemail</button><button type="button" class="btn btn-ghost btn-sm" data-act="log" data-outcome="answered">Log answered</button>'
      + '<span style="flex:1"></span><label class="fld" style="margin:0;flex-direction:row;align-items:center;gap:6px;"><span class="lbl" style="margin:0;">Week of</span><input type="date" id="ops_week" value="' + esc(todayStr()) + '"></label><button type="button" class="btn btn-navy btn-sm" data-act="weekly">Weekly metric CSV</button></div>';
    if (!list.length) h += '<div class="empty">No calls logged today. Numbers typed on the F1–F6 lines log themselves; press Missed on a line when nobody picked up.</div>';
    else {
      h += '<div class="tbl-scroll" style="max-height:320px;"><table class="data" id="ops_calls_tbl"><thead><tr><th>Time</th><th>Line</th><th>Number</th><th>Outcome</th><th>Callback</th><th>Trip</th><th>Closed</th><th></th></tr></thead><tbody>';
      list.forEach(function (c) {
        var open = (c.outcome === 'missed' || c.outcome === 'voicemail') && !c.closedAt;
        h += '<tr data-call="' + esc(c.id) + '"' + (open ? ' class="ops-bad"' : '') + '><td class="mono">' + esc(fmtWhen(c.at)) + (c.direction === 'out' ? ' <span class="hint" style="margin:0;">out</span>' : '') + '</td><td>' + esc(c.line || (c.source === 'cdr' ? 'CDR' : '')) + '</td><td class="mono">' + esc(fmtPhone(c.number)) + (knownLabel(c.number) ? '<div class="hint" style="margin:0;">' + esc(knownLabel(c.number)) + '</div>' : '') + '</td>'
          + '<td><select class="ops-outcome" data-call="' + esc(c.id) + '"><option value="">—</option>' + OUTCOMES.map(function (o) { return '<option value="' + o + '"' + (c.outcome === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select>' + (c.ringSec != null ? '<div class="hint" style="margin:0;">rang ' + esc(c.ringSec) + ' s</div>' : '') + '</td>'
          + '<td>' + (open ? '<span class="ops-chip bad">waiting</span>' : (c.attempts && c.attempts.length ? 'called back ' + c.attempts.length + '×' : '')) + '</td><td class="mono">' + esc(tripNo(c.tripId)) + '</td><td>' + (c.closedAt ? esc(fmtWhen(c.closedAt)) + (c.reason ? ' · ' + esc(c.reason) : '') : '') + '</td>'
          + '<td class="ops-acts">' + (open ? '<button type="button" class="btn btn-go btn-sm" data-act="callback" data-call="' + esc(c.id) + '">Call back</button><button type="button" class="btn btn-navy btn-sm" data-act="book" data-call="' + esc(c.id) + '">Book</button><select class="ops-reason" data-call="' + esc(c.id) + '">' + REASONS.map(function (r) { return '<option value="' + r[0] + '">' + esc(r[1]) + '</option>'; }).join('') + '</select><button type="button" class="btn btn-ghost btn-sm" data-act="close" data-call="' + esc(c.id) + '">Close</button>' : (c.closedAt && (c.outcome === 'missed' || c.outcome === 'voicemail') ? '<button type="button" class="btn btn-ghost btn-sm" data-act="reopen" data-call="' + esc(c.id) + '">Reopen</button>' : '')) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    h += '<h4>Import call records from the phone vendor (CDR)</h4><div class="hint" style="margin:0 0 6px;">Paste or upload the CSV your phone vendor exports (BCM One, Zoom Phone, RingCentral all work: you map the columns once and the mapping is saved). Transfers of the same number within 60 seconds count as one call. Importing the same file twice adds nothing.</div>'
      + '<div class="ops-acts"><label class="btn btn-ghost btn-sm" style="cursor:pointer;">Choose CSV file…<input type="file" id="ops_cdr_file" accept=".csv,.txt,.tsv" style="display:none;"></label><button type="button" class="btn btn-navy btn-sm" data-act="cdrread">Read columns →</button></div>'
      + '<textarea id="ops_cdr_text" placeholder="Start Time,From,To,Direction,Result,Duration&#10;2026-11-20 09:14:03,(718) 555-0101,(718) 555-7000,Inbound,Answered,0:02:11" style="min-height:70px;width:100%;font-family:Consolas,monospace;margin-top:6px;"></textarea>'
      + '<div id="ops_cdr_map"></div><div id="ops_cdr_status" class="hint" style="margin:6px 0 0;"></div>';
    h += '</div>';
    p.innerHTML = h;
    var f = byId('ops_cdr_file'); if (f) f.addEventListener('change', act(function () { var file = f.files && f.files[0]; if (!file) return; var rd = new FileReader(); rd.onload = function () { byId('ops_cdr_text').value = String(rd.result || ''); readCdrColumns(); }; rd.readAsText(file); }));
  }
  function historyActive() { var v = byId('view-history'); return !!(v && v.classList.contains('active')); }
  function rerenderCalls() { try { if (historyActive() && byId(PANEL_ID)) renderCallsPanel(); } catch (e) {} try { injectNeedsYou(); } catch (e) {} }
  function onCallsChange(e) {
    var sel = e.target && e.target.closest ? e.target.closest('select.ops-outcome') : null; if (!sel) return;
    var c = findCall(sel.getAttribute('data-call')); if (!c) return;
    if (!sel.value) { c.outcome = ''; save(); rerenderCalls(); return; }
    setOutcome(c.id, sel.value);
  }
  function onCallsClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null; if (!b) return;
    e.preventDefault();
    var a = b.getAttribute('data-act'), id = b.getAttribute('data-call');
    try {
      if (a === 'log') { var num = (byId('ops_call_num') || {}).value || ''; if (!numberKey(num)) { toast('Type the caller\'s number first.', true); return; } var c = logCall({ number: num, line: (byId('ops_call_line') || {}).value || '', source: 'manual' }, 0); if (c) setOutcome(c.id, b.getAttribute('data-outcome')); byId('ops_call_num').value = ''; renderCallsPanel(); }
      else if (a === 'callback') callBack(id);
      else if (a === 'book') bookFromCall(id);
      else if (a === 'close') { var sel = b.parentNode.querySelector('.ops-reason'); closeCall(id, sel ? sel.value : 'other'); }
      else if (a === 'reopen') reopenCall(id);
      else if (a === 'weekly') weeklyCSV((byId('ops_week') || {}).value || todayStr());
      else if (a === 'cdrread') readCdrColumns();
      else if (a === 'cdrimport') importFromDialog();
    } catch (err) { try { console.error('[ops]', err); } catch (e2) {} }
  }

  /* ---------- CDR import ---------- */
  var CDR_FIELDS = [['at', 'Call date & time (one column)'], ['date', 'Date (when separate)'], ['time', 'Time (when separate)'], ['from', 'Caller number (from)'], ['to', 'Dialed number (to)'], ['direction', 'Direction (inbound / outbound)'], ['result', 'Result / disposition'], ['duration', 'Talk duration'], ['ring', 'Ring / wait time'], ['line', 'Line / queue / extension']];
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    var firstLine = text.split(/\r?\n/)[0] || '', delim = (firstLine.split('\t').length > firstLine.split(',').length) ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
    var rows = [], row = [], field = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some(function (x) { return String(x).trim() !== ''; })) rows.push(row); row = []; }
      else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); if (row.some(function (x) { return String(x).trim() !== ''; })) rows.push(row); }
    return rows;
  }
  function normHeader(h) { return String(h || '').trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' '); }
  function sigOf(headers) { return headers.map(normHeader).join('|'); }
  var GUESS = {
    at: /^(start time|call start|start date time|date time|date\/time|datetime|timestamp|time stamp|call date time|call time|start|started|call started|begin time)$/,
    date: /^(date|call date|start date|day)$/,
    time: /^(time|start time|call time)$/,
    from: /^(from|from number|from phone|caller|caller id|caller number|calling number|calling party|ani|origin|source|cli|from name)$/,
    to: /^(to|to number|to phone|called number|called party|dialed|dialed number|dialled number|destination|dnis|callee)$/,
    direction: /^(direction|call type|type|in\/out|inbound\/outbound|call direction)$/,
    result: /^(result|disposition|status|action result|action|outcome|call result|answered|answer status|call status)$/,
    duration: /^(duration|talk time|call duration|length|total duration|talk)$/,
    ring: /^(ring time|ring|wait time|queue time|time to answer|answer time|ringing|ring duration|wait)$/,
    line: /^(line|queue|extension|ext|did|group|queue name|ring group|to name|user)$/
  };
  function guessMapping(headers) {
    var map = {}, norm = headers.map(normHeader), used = {};
    function take(field, re) { if (map[field]) return; for (var i = 0; i < norm.length; i++) { if (used[i]) continue; if (re.test(norm[i])) { map[field] = headers[i]; used[i] = true; return; } } }
    take('date', GUESS.date);
    if (map.date) take('time', GUESS.time); else take('at', GUESS.at);
    if (!map.at && !map.date) take('at', /time|date/);
    take('from', GUESS.from); take('to', GUESS.to); take('direction', GUESS.direction); take('result', GUESS.result); take('duration', GUESS.duration); take('ring', GUESS.ring); take('line', GUESS.line);
    return map;
  }
  function mappingComplete(map) { return !!(map && (map.at || map.date) && (map.from || map.to)); }
  function cdrMappings() { var s = settings(); if (!s.cdrMapping || typeof s.cdrMapping !== 'object') s.cdrMapping = {}; return s.cdrMapping; }
  function savedMapping(headers) { var m = cdrMappings()[sigOf(headers)]; return m && m.map ? m.map : null; }
  function saveMapping(headers, map) { cdrMappings()[sigOf(headers)] = { headers: headers.slice(), map: map, savedAt: nowISO() }; save(); }
  function parseWhen(dateStr, timeStr) {
    var s = String(dateStr || '').trim(), t = String(timeStr || '').trim();
    if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
    if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
    var full = (s + ' ' + t).trim(), d = new Date(full);
    if (isNaN(d)) { var m = full.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/), tm = full.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i); if (m) { var y = +m[3]; if (y < 100) y += 2000; var hh = tm ? +tm[1] : 0, mm = tm ? +tm[2] : 0, ss = tm && tm[3] ? +tm[3] : 0; if (tm && tm[4]) { var ap = tm[4].toUpperCase(); if (ap === 'PM' && hh < 12) hh += 12; if (ap === 'AM' && hh === 12) hh = 0; } d = new Date(y, +m[1] - 1, +m[2], hh, mm, ss); } }
    if (isNaN(d)) { var iso = full.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/); if (iso) d = new Date(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +(iso[6] || 0)); }
    return isNaN(d) ? '' : d.toISOString();
  }
  function parseSecs(v) {
    v = String(v == null ? '' : v).trim(); if (!v) return null;
    var m = v.match(/^(\d+):(\d{2})(?::(\d{2}))?$/); if (m) return m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
    var h = v.match(/(\d+)\s*h/i), mi = v.match(/(\d+)\s*m(?!s)/i), s = v.match(/(\d+)\s*s/i); if (h || mi || s) return (h ? +h[1] * 3600 : 0) + (mi ? +mi[1] * 60 : 0) + (s ? +s[1] : 0);
    var n = Number(v.replace(/[^\d.]/g, '')); return isFinite(n) ? Math.round(n) : null;
  }
  function directionOf(v, fromNum, toNum) {
    var s = String(v || '').toLowerCase();
    if (/out|placed|dialed|dialled/.test(s)) return 'out';
    if (/in|received|incoming/.test(s)) return 'in';
    var ours = numberKey(settings().phone || '');
    if (ours && numberKey(fromNum) === ours) return 'out';
    return 'in';
  }
  function outcomeOf(result, talkSec, direction) {
    var s = String(result || '').toLowerCase();
    if (/voice ?mail|\bvm\b|message/.test(s)) return 'voicemail';
    if (/overflow|forward|fwd/.test(s)) return 'overflow';
    if (/miss|no answer|not answered|unanswer|abandon|busy|reject|declin|cancel|hang ?up|dropped|failed/.test(s)) return 'missed';
    if (/answer|complet|connect|accept|success|talk|transfer/.test(s)) return 'answered';
    if (direction === 'out') return 'answered';
    if (talkSec != null) return talkSec > 0 ? 'answered' : 'missed';
    return 'answered';
  }
  function hashStr(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ('00000000' + h.toString(16)).slice(-8); }
  /* importCDR(text, map?) -> {rows, imported, merged, skipped, duplicates, needsMapping?, headers, map} */
  function importCDR(text, mapOverride) {
    var rows = parseCSV(text); if (rows.length < 2) return { rows: 0, imported: 0, merged: 0, skipped: 0, duplicates: 0, error: 'No data rows found (first row must be the column names).' };
    var headers = rows[0].map(function (h) { return String(h).trim(); }), map = mapOverride || savedMapping(headers) || guessMapping(headers);
    if (!mappingComplete(map)) return { rows: rows.length - 1, imported: 0, merged: 0, skipped: 0, duplicates: 0, needsMapping: true, headers: headers, map: map };
    var idx = {}; headers.forEach(function (h, i) { idx[h] = i; });
    function col(r, f) { var h = map[f]; if (!h || idx[h] == null) return ''; return r[idx[h]] == null ? '' : String(r[idx[h]]).trim(); }
    var res = { rows: rows.length - 1, imported: 0, merged: 0, skipped: 0, duplicates: 0, headers: headers, map: map };
    var seenRefs = {}; calls().forEach(function (c) { if (!c) return; if (c.cdrRef) seenRefs[c.cdrRef] = c; (c.cdrRefs || []).forEach(function (x) { seenRefs[x] = c; }); });
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var at = map.at ? parseWhen(col(r, 'at'), '') : parseWhen(col(r, 'date'), col(r, 'time'));
      var from = col(r, 'from'), to = col(r, 'to'), dir = directionOf(col(r, 'direction'), from, to);
      var number = dir === 'out' ? (to || from) : (from || to);
      var key = numberKey(number);
      if (!at || !key) { res.skipped++; continue; }
      var talk = parseSecs(col(r, 'duration')), ring = parseSecs(col(r, 'ring')), outcome = outcomeOf(col(r, 'result'), talk, dir);
      var ref = 'cdr:' + hashStr(at + '|' + key + '|' + dir + '|' + i + '|' + col(r, 'result') + '|' + col(r, 'duration'));
      if (seenRefs[ref]) { res.duplicates++; continue; }
      var atMs = new Date(at).getTime(), near = findNear(key, atMs, CDR_DEDUPE_MS, dir);
      if (near) {   // the console logged it, or a transfer leg of the same call: enrich, do not duplicate
        if (!near.outcome) applyOutcome(near, outcome);
        if (near.ringSec == null && ring != null) near.ringSec = ring;
        if (near.talkSec == null && talk != null) near.talkSec = talk;
        if (!near.line && col(r, 'line')) near.line = col(r, 'line');
        if (!near.cdrRef) near.cdrRef = ref; else { near.cdrRefs = near.cdrRefs || []; if (near.cdrRefs.indexOf(ref) < 0) near.cdrRefs.push(ref); }   // every merged leg is remembered, so a re-import is a no-op
        seenRefs[ref] = near; res.merged++; continue;
      }
      var c = newCall({ at: at, number: number, direction: dir, source: 'cdr', line: col(r, 'line'), ringSec: ring, talkSec: talk, cdrRef: ref });
      applyOutcome(c, outcome);
      if ((outcome === 'missed' || outcome === 'voicemail') && Date.now() - atMs > 24 * 3600000 && !c.closedAt) { c.closedAt = c.at; c.reason = 'other'; }   // old missed calls from a report are history, not today's callback queue
      calls().push(c); seenRefs[ref] = c; res.imported++;
    }
    if (!mapOverride || !savedMapping(headers)) saveMapping(headers, map); else saveMapping(headers, map);
    save(); rerenderCalls();
    return res;
  }
  var cdrPending = null;
  function readCdrColumns() {
    var text = (byId('ops_cdr_text') || {}).value || '', host = byId('ops_cdr_map'), st = byId('ops_cdr_status'); if (!host) return;
    var rows = parseCSV(text);
    if (rows.length < 2) { host.innerHTML = ''; if (st) st.textContent = 'Paste or upload a CSV with a header row and at least one call.'; return; }
    var headers = rows[0].map(function (h) { return String(h).trim(); }), map = savedMapping(headers) || guessMapping(headers), saved = !!savedMapping(headers);
    cdrPending = { text: text, headers: headers };
    var h = '<div class="hint" style="margin:8px 0 4px;">' + (saved ? 'Saved mapping found for these columns.' : 'Pick which column holds each field (best guess filled in).') + ' Required: a date/time and the caller number.</div><div class="grid2 ops-map">';
    CDR_FIELDS.forEach(function (f) { h += '<label class="fld"><span class="lbl">' + esc(f[1]) + '</span><select data-field="' + f[0] + '"><option value="">— not in this file —</option>' + headers.map(function (hd) { return '<option value="' + esc(hd) + '"' + (map[f[0]] === hd ? ' selected' : '') + '>' + esc(hd) + '</option>'; }).join('') + '</select></label>'; });
    h += '</div><div class="ops-acts"><button type="button" class="btn btn-go btn-sm" data-act="cdrimport">Import ' + (rows.length - 1) + ' row' + (rows.length === 2 ? '' : 's') + ' with this mapping</button><span class="hint" style="margin:0;align-self:center;">The mapping is saved for next time.</span></div>';
    host.innerHTML = h;
    if (st) st.textContent = 'Columns found: ' + headers.join(', ');
  }
  function importFromDialog() {
    if (!cdrPending) { readCdrColumns(); return; }
    var map = {}; byId('ops_cdr_map').querySelectorAll('select[data-field]').forEach(function (s) { if (s.value) map[s.getAttribute('data-field')] = s.value; });
    if (!mappingComplete(map)) { toast('Pick the date/time column and the caller number column first.', true); return; }
    var res = importCDR(cdrPending.text, map), st = byId('ops_cdr_status');
    var msg = 'Read ' + res.rows + ' row' + (res.rows === 1 ? '' : 's') + ': ' + res.imported + ' new call' + (res.imported === 1 ? '' : 's') + ', ' + res.merged + ' merged into calls already on file (transfers / console entries), ' + res.duplicates + ' already imported, ' + res.skipped + ' skipped (no date or number).';
    if (st) st.textContent = msg; toast(msg); cdrPending = null; byId('ops_cdr_map').innerHTML = '';
    renderCallsPanel(); var st2 = byId('ops_cdr_status'); if (st2) st2.textContent = msg;
  }

  /* ======================================================================
     PART 3 — PARTNER-BASE OVERFLOW RECORD
     ====================================================================== */
  var OVERFLOW_WHY = 'Overflow is off. TLC lets a base dispatch only to another base of the same class under a written agreement, and the two bases must exchange the trip records within 48 hours. Fill the partner-base record in Settings (base name, TLC base licence B#, contact, agreement date, record exchange agreed, verified date) to turn this on. It is never on by default.';
  function partner() {
    var s = settings();
    if (!s.partnerBase || typeof s.partnerBase !== 'object') s.partnerBase = { baseName: '', baseLicence: '', contact: '', agreementSignedAt: '', recordExchangeAgreed: false, verifiedAt: '' };
    var p = s.partnerBase;
    ['baseName', 'baseLicence', 'contact', 'agreementSignedAt', 'verifiedAt'].forEach(function (k) { if (typeof p[k] !== 'string') p[k] = p[k] == null ? '' : String(p[k]); });
    p.recordExchangeAgreed = p.recordExchangeAgreed === true;
    if (!p.contact && typeof s.overflowNumber === 'string' && s.overflowNumber.trim()) p.contact = s.overflowNumber.trim();   // an old plain overflow number becomes the contact (the record is still incomplete)
    return p;
  }
  function partnerMissing() {
    var p = partner(), miss = [];
    if (!p.baseName.trim()) miss.push('base name');
    if (!/^B\d{5}$/i.test(p.baseLicence.trim())) miss.push('TLC base licence (B#####)');
    if (!numberKey(p.contact)) miss.push('contact phone');
    if (!isDate(p.agreementSignedAt)) miss.push('agreement signed date');
    if (!p.recordExchangeAgreed) miss.push('48-hour record exchange agreed');
    if (!isDate(p.verifiedAt)) miss.push('verified date');
    return miss;
  }
  function partnerComplete() { return partnerMissing().length === 0; }
  function overflowTitle() { var miss = partnerMissing(); return miss.length ? OVERFLOW_WHY + ' Missing: ' + miss.join(', ') + '.' : 'Text this job to the partner base ' + partner().baseName + ' (' + partner().baseLicence.toUpperCase() + ') and tag the trip for the TLC export.'; }
  function builtinJobText(t) {
    var when = (t.date ? t.date + ' ' : '') + h12(t.time);
    return bizName().toUpperCase() + ' JOB #' + (t.dispatchNo || '') + ' - ' + when + '. PU: ' + (t.puAddr || '?') + '. DO: ' + (t.doAddr || '?') + '. ' + (Number(t.pax) || 1) + ' pax, ' + (t.vtype || 'any car') + '.';
  }
  function overflowTrip(tripId) {
    var t = findTrip(tripId); if (!t) return false;
    if (!partnerComplete()) { toast('Overflow refused - no complete partner-base record. Missing: ' + partnerMissing().join(', ') + '.', true); return false; }
    var p = partner(), lic = p.baseLicence.trim().toUpperCase();
    var body = '';
    try { if (window.DriverLink && typeof window.DriverLink.jobText === 'function') body = window.DriverLink.jobText(t); } catch (e) { body = ''; }
    if (!body) body = builtinJobText(t);
    body += ' Overflow from ' + bizName() + ' (base ' + baseNo() + ') to ' + p.baseName + ' (' + lic + '). Trip record to be exchanged within 48 h.';
    var ok = openHref(smsHref(p.contact, body));   // smsHref runs gsmSafe
    t.partnerBaseLicence = lic; t.overflow = { at: nowISO(), baseName: p.baseName, baseLicence: lic, via: ok ? 'sms' : 'failed' };
    save(); refreshBoard();
    toast(ok ? 'Job #' + (t.dispatchNo || '') + ' texted to ' + p.baseName + ' - tagged as overflow for the TLC export.' : 'Could not open your Messages app.', !ok);
    return ok;
  }
  function overflowCall(callId) {
    var c = findCall(callId); if (!c) return false;
    if (!partnerComplete()) { toast('Overflow refused - no complete partner-base record. Missing: ' + partnerMissing().join(', ') + '.', true); return false; }
    var p = partner(), body = 'Overflow from ' + bizName() + ' (base ' + baseNo() + '): please call ' + fmtPhone(c.number) + ' back for a ride' + (c.at ? ' (called ' + fmtWhen(c.at) + ')' : '') + '. Trip record to be exchanged within 48 h.';
    var ok = openHref(smsHref(p.contact, body));
    c.outcome = 'overflow'; c.closedAt = nowISO(); c.reason = 'no-car'; c.partnerBaseLicence = p.baseLicence.trim().toUpperCase();
    save(); rerenderCalls();
    toast(ok ? 'Caller passed to ' + p.baseName + ' - call closed as overflow.' : 'Could not open your Messages app.', !ok);
    return ok;
  }
  /* board row: "Partner base" for Booked trips with no driver — disabled until the record is complete */
  function overflowBtnHtml(t) {
    var ok = partnerComplete();
    return '<button class="btn btn-ghost btn-sm ops-overflow" type="button"' + (ok ? ' onclick="Ops.overflowTrip(\'' + esc(t.id) + '\')"' : ' disabled') + ' title="' + esc(overflowTitle()) + '">' + (t.partnerBaseLicence ? 'Overflow ✓' : 'Partner base') + '</button> ';
  }
  wrap('sheetRow', function (orig) {
    return function (t) {
      var html = orig.apply(this, arguments);
      try {
        if (t && t.id && typeof html === 'string' && (t.status === 'Booked' && !t.driverId || t.partnerBaseLicence)) {
          var marker = '<td class="acts">', i = html.indexOf(marker);
          if (i >= 0) html = html.slice(0, i + marker.length) + overflowBtnHtml(t) + html.slice(i + marker.length);
        }
      } catch (e) {}
      return html;
    };
  });
  /* TLC export: when any trip in the range went to a partner base, write that base in affiliated_base_number.
     The console's own handler is anonymous, so this capture listener runs first and takes over only in that case. */
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#tlc_export') : null; if (!b) return;
    if (window.Recover && window.Recover._loaded) return;   // recover.js owns the export (pre-export checklist); it writes the partner base in affiliated_base_number itself
    try {
      var from = (byId('tlc_from') || {}).value || '', to = (byId('tlc_to') || {}).value || '', coords = (byId('tlc_coords') || {}).value || '';
      var list = trips().filter(function (t) { return t && (!from || t.date >= from) && (!to || t.date <= to) && t.status !== 'Canceled' && t.status !== 'No-Show' && t.status !== 'Disregard'; });
      if (!list.some(function (t) { return t.partnerBaseLicence; })) return;   // nothing changes: let the console's export run
      if (typeof window.tlcLocType !== 'function' || typeof window.tlcLocName !== 'function' || typeof window.tlcDate !== 'function' || typeof window.tlcTime !== 'function') return;
      e.stopPropagation(); e.preventDefault();
      list.sort(function (a, b2) { return a.date === b2.date ? (a.time < b2.time ? -1 : 1) : (a.date < b2.date ? -1 : 1); });
      var base = String(settings().base || ''), head = ['dispatching_base_number', 'pickup_date', 'pickup_time', 'TLC_drivers_license_number', 'license_plate', 'affiliated_base_number', 'pickup_location_type', 'pickup_location_name', 'pickup_longitude', 'pickup_latitude', 'dropoff_date', 'dropoff_time', 'dropoff_location_type', 'dropoff_location_name', 'dropoff_longitude', 'dropoff_latitude'];
      var lines = [head.join(',')], missing = 0, overflow = 0;
      list.forEach(function (t) {
        var drv = findDriver(t.driverId), veh = findVehicle(t.vehicleId);
        if (!drv || !drv.tlc || !veh || !veh.plate) missing++;
        var puLon = '', puLat = '', doLon = '', doLat = '';
        if (coords === 'fill' && STATE.geocache && typeof window.normalizeAddr === 'function') { var pc = STATE.geocache[window.normalizeAddr(t.puAddr)], dc = STATE.geocache[window.normalizeAddr(t.doAddr)]; if (pc) { puLon = pc.lng; puLat = pc.lat; } if (dc) { doLon = dc.lng; doLat = dc.lat; } }
        var aff = t.partnerBaseLicence ? String(t.partnerBaseLicence).toUpperCase() : base; if (t.partnerBaseLicence) overflow++;
        var row = [base, window.tlcDate(t.date), window.tlcTime(t.time), (drv && drv.tlc) || '', (veh && veh.plate) || '', aff, window.tlcLocType(t.puAddr), window.tlcLocName(t.puAddr), puLon, puLat, window.tlcDate(t.dropDate || t.date), window.tlcTime(t.dropTime || t.time), window.tlcLocType(t.doAddr), window.tlcLocName(t.doAddr), doLon, doLat];
        lines.push(row.map(csvCell).join(','));
      });
      var ymd = function (s) { return s ? s.replace(/-/g, '') : ''; };
      var fname = (base || 'BASE').toLowerCase() + '_' + ymd(from) + '-' + ymd(to) + '.csv';
      download(fname, lines.join('\r\n'), 'text/csv');
      var sum = byId('tlc_summary'); if (sum) sum.innerHTML = '<div class="notice" style="margin:0;">Exported <b>' + list.length + '</b> trips as <span class="mono">' + esc(fname) + '</span> — <b>' + overflow + '</b> overflow trip' + (overflow === 1 ? ' carries' : 's carry') + ' the partner base in affiliated_base_number.' + (missing ? ' <b style="color:#a4161a;">' + missing + ' trip(s) missing a driver TLC # or vehicle plate</b>.' : '') + ' Verify the column order against the current TLC CSV spec before uploading.</div>';
      toast('TLC export downloaded (' + overflow + ' overflow trip' + (overflow === 1 ? '' : 's') + ' tagged with the partner base).');
    } catch (err) { try { console.error('[ops]', err); } catch (e2) {} }
  }, true);

  /* ---------- Settings card: eligibility toggle + partner-base record ---------- */
  function partnerStatusHtml() { var miss = partnerMissing(); return miss.length ? '<span class="ops-chip bad">Overflow OFF</span> missing: ' + esc(miss.join(', ')) : '<span class="ops-chip ok">Overflow available</span> to ' + esc(partner().baseName) + ' (' + esc(partner().baseLicence.toUpperCase()) + ')'; }
  function renderSettingsCard() {
    var view = byId('view-settings'); if (!view || POPOUT) return;
    var p = byId('opsSettings');
    if (!p) {
      p = document.createElement('div'); p.id = 'opsSettings'; p.className = 'panel ops-panel'; view.appendChild(p);
      p.innerHTML = '<div class="panel-head">Eligibility &amp; partner base</div><div class="panel-body">'
        + '<label class="fld ops-chk"><input type="checkbox" id="ops_enforce" style="width:auto;"> <span class="lbl" style="margin:0;">Enforce driver / vehicle eligibility (block assignments; off = warn only)</span></label>'
        + '<div class="hint" style="margin:0 0 6px;">When on, a driver or vehicle with a missing or expired TLC, DMV, insurance, registration or inspection date, an out-of-service flag or the wrong affiliated base cannot be assigned or dispatched by any path (pop-out screens included). A driver already out on a job within ' + BUSY_MIN + ' minutes is blocked too; two Booked jobs close together only show a note. The owner can override one assignment with the admin PIN; the override is recorded on the trip.</div>'
        + '<label class="fld ops-chk"><input type="checkbox" id="ops_requireVehicle" style="width:auto;"> <span class="lbl" style="margin:0;">Also require a vehicle on record for every assignment (checks registration, inspection and base affiliation every time)</span></label>'
        + '<div class="hint" style="margin:0 0 10px;">Off: a driver with no car on the job and no usual vehicle in Fleet is checked on the driver record alone (TLC, DMV, insurance dates). On: such an assignment is refused until a vehicle is picked.</div>'
        + '<h4>Partner base for overflow</h4><div class="hint" style="margin:0 0 6px;">Overflow dispatch stays off until every field is filled. TLC rule: same-class base, written agreement, trip records exchanged within 48 hours.</div>'
        + '<div class="grid2">' + fld('Partner base name', 'ops_pb_name') + fld('Partner TLC base licence (B#####)', 'ops_pb_lic', 'text', ' placeholder="B00000"') + '</div>'
        + '<div class="grid2">' + fld('Partner dispatch phone (texts go here)', 'ops_pb_contact', 'text', ' placeholder="(718) 555-0000"') + fld('Written agreement signed on', 'ops_pb_signed', 'date') + '</div>'
        + '<div class="grid2">' + chk('48-hour trip-record exchange agreed in writing', 'ops_pb_exchange') + '<label class="fld"><span class="lbl">Record verified on</span><div class="ops-verify"><input type="date" id="ops_pb_verified"><button type="button" class="btn btn-ghost btn-sm" id="ops_pb_verifynow">Today</button></div></label></div>'
        + '<div class="ops-acts"><button type="button" class="btn btn-navy" id="ops_pb_save">Save partner record</button><span id="ops_pb_status" class="hint" style="margin:0;align-self:center;"></span></div>'
        + '</div>';
      byId('ops_enforce').addEventListener('change', act(function () { settings().enforceEligibility = !!byId('ops_enforce').checked; save(); toast(enforce() ? 'Eligibility check ON - blocked drivers and vehicles cannot be assigned.' : 'Eligibility check OFF - assignments go through with a warning.'); renderRoster(); refreshBoard(); }));
      byId('ops_requireVehicle').addEventListener('change', act(function () { settings().requireVehicle = !!byId('ops_requireVehicle').checked; save(); toast(requireVehicle() ? 'A vehicle on record is now required for every assignment.' : 'Vehicle no longer required - drivers without a car on record are checked on their own documents.'); renderRoster(); refreshBoard(); }));
      byId('ops_pb_verifynow').addEventListener('click', act(function () { byId('ops_pb_verified').value = todayStr(); }));
      byId('ops_pb_save').addEventListener('click', act(function () {
        var p2 = partner();
        p2.baseName = getVal('ops_pb_name'); p2.baseLicence = getVal('ops_pb_lic').toUpperCase(); p2.contact = getVal('ops_pb_contact'); p2.agreementSignedAt = getVal('ops_pb_signed'); p2.recordExchangeAgreed = getVal('ops_pb_exchange') === true; p2.verifiedAt = getVal('ops_pb_verified');
        save(); syncSettingsCard(); refreshBoard(); injectNeedsYou();
        toast(partnerComplete() ? 'Partner base saved - overflow buttons are now available.' : 'Partner base saved. Overflow stays off - missing: ' + partnerMissing().join(', ') + '.', !partnerComplete());
      }));
    }
    syncSettingsCard();
  }
  function syncSettingsCard() {
    if (!byId('opsSettings')) return;
    var p = partner();
    setVal('ops_enforce', enforce()); setVal('ops_requireVehicle', requireVehicle()); setVal('ops_pb_name', p.baseName); setVal('ops_pb_lic', p.baseLicence); setVal('ops_pb_contact', p.contact); setVal('ops_pb_signed', p.agreementSignedAt); setVal('ops_pb_exchange', p.recordExchangeAgreed); setVal('ops_pb_verified', p.verifiedAt);
    var st = byId('ops_pb_status'); if (st) st.innerHTML = partnerStatusHtml();
  }

  /* ---------- styles ---------- */
  function ensureStyle() {
    if (byId('opsStyle')) return;
    var st = document.createElement('style'); st.id = 'opsStyle';
    st.textContent = [
      '.ops-chip{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:10px;white-space:nowrap;vertical-align:middle;}',
      '.ops-chip.ok{background:rgba(31,122,61,.12);color:#1f7a3d;} .ops-chip.soon{background:rgba(214,158,20,.16);color:#7a5a06;} .ops-chip.bad{background:rgba(192,57,43,.12);color:#9b2d20;}',
      '.ops-fields{border:1px dashed var(--line,#c9ced6);border-radius:4px;padding:8px 10px;margin:6px 0 10px;background:rgba(120,140,160,.05);}',
      '.ops-fields-head{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--green-dark,#15497d);margin-bottom:4px;}',
      '.ops-chk{flex-direction:row!important;align-items:center;gap:8px;} .ops-verify{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}',
      '.ops-panel h4{margin:12px 0 4px;font-size:12.5px;color:var(--green-dark,#15497d);} .ops-panel .stat-row{margin-bottom:6px;}',
      '.ops-panel .stat.ops-bad-t{border-top-color:#c0392b;} .ops-panel .stat.ops-ok-t{border-top-color:#1f7a3d;}',
      '.ops-acts{display:flex;flex-wrap:wrap;gap:6px;align-items:center;} .ops-acts .btn{white-space:nowrap;}',
      'tr.ops-bad td{background:rgba(192,57,43,.07);} tr.ops-soon td{background:rgba(214,158,20,.08);}',
      '.ops-reason{font-size:11px;padding:2px 4px;max-width:120px;} .ny-item.ops-ny .ny-acts{flex-wrap:wrap;gap:4px;}',
      '.ops-ovr{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:9000;background:#2b2b2b;color:#fff;padding:10px 14px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:min(720px,94vw);font-size:13px;}',
      '.ops-ovr[hidden]{display:none;} .ops-ovr .ops-ovr-txt{flex:1;min-width:180px;}',
      '.ops-print{font-family:Arial,sans-serif;color:#111;} .ops-print-tbl{width:100%;border-collapse:collapse;font-size:11.5px;margin-top:8px;} .ops-print-tbl th,.ops-print-tbl td{border:1px solid #999;padding:3px 5px;text-align:left;vertical-align:top;} .ops-print-tbl th{background:#eee;}',
      '.ops-print tr.ops-bad td{background:#fde8e6;} .ops-print tr.ops-soon td{background:#fff5d6;} .ops-print-foot{margin-top:18px;} .ops-sign{display:flex;gap:28px;flex-wrap:wrap;margin-top:28px;font-size:13px;}',
      '.ops-cid{display:inline-flex;gap:4px;align-items:center;margin-left:4px;} .ops-overflow[disabled]{opacity:.55;cursor:not-allowed;}',
      'body.gold .ops-fields-head,body.gold .ops-panel h4{color:#e8c75a;} body.gold .ops-chip.ok{color:#8fd8a4;} body.gold .ops-chip.bad{color:#f0a89f;} body.gold .ops-chip.soon{color:#e8c75a;}',
      'body.classic .ops-fields{border-radius:0;background:#fff;}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }

  /* ---------- defaults (saved only when something was missing) ---------- */
  function ensureDefaults() {
    var s = settings(), dirty = false;
    if (s.enforceEligibility == null) { s.enforceEligibility = true; dirty = true; }
    if (!s.cdrMapping || typeof s.cdrMapping !== 'object') { s.cdrMapping = {}; dirty = true; }
    var hadPartner = !!(s.partnerBase && typeof s.partnerBase === 'object'); partner(); if (!hadPartner) dirty = true;
    if (!Array.isArray(STATE.calls)) { STATE.calls = []; dirty = true; }
    if (s.requireVehicle == null) { s.requireVehicle = false; dirty = true; }
    if (ensureRecords()) dirty = true;
    if (dirty && !POPOUT) save();   // a pop-out only fills its own copy; the main console owns the saved defaults
  }

  /* ---------- public API ---------- */
  window.Ops = {
    _loaded: true,
    eligibility: eligibility, standing: standing, conflict: conflict, softConflict: softConflict, needsWav: needsWav, enforce: enforce, requireVehicle: requireVehicle, BUSY_MIN: BUSY_MIN, isPopout: function () { return !!POPOUT; },
    setDriverEligibility: setDriverEligibility, setVehicleEligibility: setVehicleEligibility,
    renderRoster: renderRoster, rosterRows: rosterRows, rosterHtml: rosterHtml, printRoster: printRoster, rosterCSV: rosterCSV,
    logCall: logCall, setOutcome: setOutcome, closeCall: closeCall, reopenCall: reopenCall, callBack: callBack, bookFromCall: bookFromCall, attachTripToCall: attachTripToCall,
    callbackQueue: callbackQueue, callsToday: callsToday, dayMetrics: dayMetrics, weeklyCSV: weeklyCSV, weekDays: weekDays,
    parseCSV: parseCSV, guessMapping: guessMapping, importCDR: importCDR, savedMapping: savedMapping, numberKey: numberKey,
    renderCalls: renderCallsPanel, refreshNeedsYou: injectNeedsYou,
    partner: partner, partnerMissing: partnerMissing, partnerComplete: partnerComplete, overflowTrip: overflowTrip, overflowCall: overflowCall, OVERFLOW_WHY: OVERFLOW_WHY,
    renderSettings: renderSettingsCard, CALLBACK_MIN: CALLBACK_MIN
  };

  /* ---------- boot ---------- */
  function boot() {
    try { ensureStyle(); } catch (e) {}
    try { ensureDefaults(); } catch (e) { try { console.error('[ops]', e); } catch (e2) {} }
    wrap('renderView', function (orig) { return function (v) { var r = orig.apply(this, arguments); try { if (v === 'history') renderCallsPanel(); if (v === 'fleet') { injectFleetFields(); renderRoster(); } if (v === 'settings') renderSettingsCard(); if (v === 'dispatch') watchNeedsYou(); } catch (e) {} return r; }; });
    wrap('renderSettings', function (orig) { return function () { var r = orig.apply(this, arguments); try { renderSettingsCard(); } catch (e) {} return r; }; });
    try { injectFleetFields(); renderRoster(); } catch (e) {}
    try { renderSettingsCard(); } catch (e) {}
    try { if (historyActive()) renderCallsPanel(); else ensureCallsPanel(); } catch (e) {}
    try { watchNeedsYou(); } catch (e) {}
    try {   // external callers of Simple.refreshNeedsYou get the callback items at once (internal calls are caught by the observer)
      if (!POPOUT && window.Simple && typeof window.Simple.refreshNeedsYou === 'function' && !window.Simple.refreshNeedsYou._opsWrapped) {
        var origNY = window.Simple.refreshNeedsYou, nyw = function () { var r = origNY.apply(this, arguments); try { injectNeedsYou(); } catch (e) {} return r; };
        nyw._opsWrapped = true; nyw._orig = origNY; inheritFlags(nyw, origNY); window.Simple.refreshNeedsYou = nyw;
      }
    } catch (e) {}
    try { if (!POPOUT && typeof window.renderCID === 'function' && byId('cid_lines')) window.renderCID(); } catch (e) {}
    try { if (typeof window.renderDrivers === 'function' && byId('driverBody')) window.renderDrivers(); if (typeof window.renderVehicles === 'function' && byId('vehicleBody')) window.renderVehicles(); } catch (e) {}
    try { refreshBoard(); } catch (e) {}
    if (!POPOUT) setInterval(function () { try { if (callbackQueue().length) injectNeedsYou(); } catch (e) {} }, 30000);   // "due in" text and newly due items without waiting for a board refresh
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
