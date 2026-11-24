/* ======================================================================
   Skyway — smooth.js
   Operations smoothness: small fixes that save the dispatcher clicks,
   retyping and second looks on every call. Each one has its own switch in
   settings.smooth (default on) and a "Smoothness" panel in Settings
   (Display & modes). Turning a switch off puts the old behaviour back.

   The fixes (key — why):
     saveGuard      — a double-click or a held Enter on Book Trip books once and
                      does not flash "Enter pick-up and drop-off" (800 ms guard).
     dupWarn        — same phone with a Booked pickup within 10 min: asks before
                      a second car goes out; Cancel opens the existing job instead.
     whenCheck      — a pickup in the past or more than 30 days out asks first
                      (typos in the date / time box are caught before the car is late).
     afterSave      — after Book Trip the cursor is back on Phone for the next call,
                      with a bar: Undo (form comes back) and Text the passenger.
     focusFlow      — New Trip puts the cursor on Phone; once the phone is known
                      (F-line, caller lookup, search) it goes to Pick-Up. F1 on a
                      ringing line focuses "Book their usual trip" so Enter books it.
     enterNext      — Enter moves to the next box; Enter on Notes or Ctrl+Enter
                      anywhere books. Shift+Enter in Notes is a new line.
     phoneFormat    — phone boxes format as you type: (718) 555-0123.
     callerDefaults — a known caller gets the vehicle type, passengers and pay type
                      of their last ride (from trip history; nothing new stored).
     accountMatch   — a number that belongs to an account selects that account.
     saveLabel      — Book Trip says what will happen: "· 3:40 pm · Sedan · $21 + $7 tolls".
     oneKey         — on a selected Board / Desk / Classic row: D dispatch,
                      C complete, N no-show, X cancel (Undo from the undo bar).
     telLinks       — every phone number on the board, grids and caller boxes is a
                      tap-to-call link.
     nextPickup     — "Next pickup 3:40 pm · in 12 min" always visible in the
                      status bar and under the clock; red when nobody is assigned.
     chime          — a soft chime 10 and 5 minutes before an unassigned pickup.
                      Never in a pop-out window.
     ctrlKCaller    — Ctrl-K with a phone number offers "Caller history" (the
                      caller's past trips under the phone box, ready to book again).
     nyDedupe       — the Needs-you strip shows one line per trip; extra lines
                      about the same trip fold under "+N more".

   Wrap, never replace: window.fn = wrapper, wrapper._orig, wrapper._smoothWrapped,
   inner marker flags copied onto the outer function. The Book form's #d_save
   handler is anonymous, so the guard and the checks sit on window (capture runs
   before every module's document listeners; bubble runs after the console).
   No driver is assigned here (D goes through cycleStatus: ops.js gate applies);
   no fare is set here (the form and quote.js keep the price check).

   STATE keys owned here: settings.smooth {<key>: true|false}. Nothing else is
   written except trip.status through the console's own functions, and an
   Undo of a fresh booking marks that trip Disregard (an existing status).
   Pop-out windows: no UI, no chime (window.Smooth.popout says which screen).
   API: window.Smooth = {audit, toggles(), on(key), set(key, bool), nextPickup(),
        chimeTick(nowMs), callerHistory(num), _loaded: true}.
   Plain ES2019, no build step, no network of its own. Never edits index.html.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;
  if (window.Smooth && window.Smooth._loaded) return;

  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }

  /* ---------- the audit list (ranked: minutes saved a day; see smooth-audit.md) ---------- */
  var FIXES = [
    { key: 'focusFlow', label: 'Cursor goes where you type next', why: 'New Trip lands on Phone; a known phone lands on Pick-Up; F1 on a ringing line lands on "Book their usual trip".', perDay: 120, secs: 3 },
    { key: 'afterSave', label: 'Ready for the next call after Book Trip', why: 'The cursor goes back to Phone, with Undo and Text the passenger on a bar.', perDay: 120, secs: 3 },
    { key: 'enterNext', label: 'Enter moves to the next box', why: 'No mouse between boxes; Enter on Notes or Ctrl+Enter books.', perDay: 120, secs: 3 },
    { key: 'callerDefaults', label: 'Known caller: last vehicle, passengers, pay', why: 'Their last ride fills vehicle type, passengers and pay type (only boxes you have not touched).', perDay: 70, secs: 4 },
    { key: 'nextPickup', label: 'Next pickup always on screen', why: 'Status bar and clock show the next pickup and how long until it; red if nobody is assigned.', perDay: 60, secs: 4 },
    { key: 'oneKey', label: 'One-key status on the selected row', why: 'D dispatch, C complete, N no-show, X cancel on the row you clicked; Undo on the bar.', perDay: 110, secs: 2 },
    { key: 'telLinks', label: 'Tap a phone number to call', why: 'Every phone on the board, grids and caller boxes is a call link.', perDay: 40, secs: 5 },
    { key: 'dupWarn', label: 'Warn before a duplicate job', why: 'Same phone, a Booked pickup within 10 min: asks first, or opens that job instead.', perDay: 3, secs: 60 },
    { key: 'phoneFormat', label: 'Phone formats as you type', why: 'Numbers read back as (718) 555-0123, so a missing digit is easy to see.', perDay: 120, secs: 1 },
    { key: 'chime', label: 'Chime before an unassigned pickup', why: 'A soft chime 10 and 5 minutes before a pickup with no driver. Off in pop-out windows.', perDay: 6, secs: 20 },
    { key: 'ctrlKCaller', label: 'Ctrl-K: caller history for a phone', why: 'Searching a phone number offers the caller’s past trips, ready to book again.', perDay: 20, secs: 5 },
    { key: 'saveLabel', label: 'Book Trip says what will happen', why: 'The button shows time, vehicle, fare and tolls before you press it.', perDay: 120, secs: 0.8 },
    { key: 'whenCheck', label: 'Check odd pickup dates', why: 'A pickup in the past or more than 30 days out asks first.', perDay: 2, secs: 45 },
    { key: 'accountMatch', label: 'Account callers select their account', why: 'A number that belongs to an account picks that account in Pay / Account.', perDay: 10, secs: 5 },
    { key: 'saveGuard', label: 'Double-click books once', why: 'A second press within 0.8 s is ignored, so no false "Enter pick-up" warning.', perDay: 8, secs: 5 },
    { key: 'nyDedupe', label: 'Needs-you: one line per trip', why: 'Several notes about the same trip fold under "+N more".', perDay: 15, secs: 3 }
  ];
  FIXES.forEach(function (f) { f.minutes = Math.round(f.perDay * f.secs / 6) / 10; });
  FIXES.sort(function (a, b) { return b.minutes - a.minutes; });
  var KEYS = FIXES.map(function (f) { return f.key; });

  /* ---------- helpers ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function log(e) { try { console.warn('[smooth]', e && e.message ? e.message : e); } catch (e2) {} }
  function act(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { log(e); } }; }
  function g(name) { return typeof window[name] === 'function' ? window[name] : null; }
  function call(name) { var f = g(name); if (!f) return undefined; try { return f.apply(null, Array.prototype.slice.call(arguments, 1)); } catch (e) { log(e); } return undefined; }
  function toast(m, w) { try { if (typeof window.toast === 'function') window.toast(m, w); } catch (e) {} }
  function save() { try { if (typeof window.save === 'function') window.save(); } catch (e) {} }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function digits(s) { return String(s == null ? '' : s).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function key10(s) { var d = digits(s); return d.length >= 10 ? d.slice(-10) : ''; }
  function fmtPhone(s) { var k = key10(s); return k ? '(' + k.slice(0, 3) + ') ' + k.slice(3, 6) + '-' + k.slice(6) : String(s || ''); }
  function trips() { return Array.isArray(STATE.trips) ? STATE.trips : []; }
  function findTrip(id) { var a = trips(); for (var i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return a[i]; return null; }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function h12(d) { var h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? 'pm' : 'am'; h = h % 12; if (h === 0) h = 12; return h + ':' + pad2(m) + ' ' + ap; }
  function dayLbl(d) { var t = new Date(); t.setHours(0, 0, 0, 0); var x = new Date(d.getTime()); x.setHours(0, 0, 0, 0); var diff = Math.round((x - t) / 86400000); if (diff === 0) return ''; if (diff === 1) return 'tomorrow '; return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate() + ' '; }
  function pickupOf(t) {
    if (!t) return null;
    try { if (typeof window.pickupDT === 'function') { var r = window.pickupDT(t); if (r && !isNaN(r)) return r; return null; } } catch (e) {}
    if (!t.date) return null; var p = String(t.date).split('-').map(Number), m = /^(\d{1,2}):(\d{2})/.exec(String(t.time || ''));
    var d = new Date(p[0], (p[1] || 1) - 1, p[2] || 1, m ? +m[1] : 0, m ? +m[2] : 0, 0); return isNaN(d) ? null : d;
  }
  function editingNow() { try { return (typeof editingId !== 'undefined') ? editingId : null; } catch (e) { return null; } }
  function whenNow() { try { return (typeof whenMode !== 'undefined') ? whenMode : 'sched'; } catch (e) { return 'sched'; } }
  function visible(el) { return !!(el && el.getClientRects && el.getClientRects().length && !el.disabled); }
  function money(n) { n = Number(n) || 0; return '$' + (Math.round(n * 100) % 100 ? n.toFixed(2) : String(Math.round(n))); }

  /* ---------- settings ---------- */
  function SS() {
    var s = STATE.settings;
    if (!s || typeof s !== 'object') return {};
    if (!s.smooth || typeof s.smooth !== 'object' || Array.isArray(s.smooth)) s.smooth = {};
    return s.smooth;
  }
  function on(k) { var s = SS(); return s[k] !== false; }
  function repair() {
    var s = SS(), changed = false;
    KEYS.forEach(function (k) { if (typeof s[k] !== 'boolean') { s[k] = s[k] === 'false' || s[k] === 0 ? false : true; changed = true; } });
    return changed;
  }
  function toggles() { var s = SS(), o = {}; KEYS.forEach(function (k) { o[k] = s[k] !== false; }); return o; }
  function setKey(k, v) { if (KEYS.indexOf(k) < 0) return false; SS()[k] = !!v; save(); try { applyToggle(k); } catch (e) { log(e); } return true; }

  /* ---------- pop-out: API only, no UI, no chime ---------- */
  if (POPOUT) {
    window.Smooth = { audit: FIXES, toggles: toggles, on: on, popout: POPOUT, _loaded: true };
    return;
  }
  try { if (repair()) save(); } catch (e) { log(e); }

  /* ---------- wrap helper ---------- */
  function wrap(name, make) {
    var orig = window[name]; if (typeof orig !== 'function' || orig._smoothWrapped) return false;
    var w = make(orig);
    try { Object.keys(orig).forEach(function (k) { if (/Wrapped$/.test(k) && !(k in w)) w[k] = orig[k]; }); } catch (e) {}
    w._orig = orig; w._smoothWrapped = true;
    window[name] = w; return true;
  }

  /* =========================================================
     Book form
     ========================================================= */
  function formRoot() {
    var b = byId('d_save'), p = byId('d_phone'); if (!b || !p) return null;
    var n = b.parentNode; while (n && n !== document.body) { if (n.contains(p) && n.contains(byId('d_puAddr'))) return n; n = n.parentNode; }
    return null;
  }
  function inForm(el) { var r = formRoot(); return !!(r && el && r.contains(el)); }
  function focusEl(el, sel) { if (!el) return; try { el.focus(); if (sel && el.select && el.value) el.select(); } catch (e) {} }
  function focusSoon(id, guard) {
    setTimeout(function () { var el = byId(id); if (!visible(el)) return; if (guard && !guard()) return; focusEl(el); }, 0);
    setTimeout(function () { var el = byId(id), a = document.activeElement; if (!visible(el) || a === el) return; if (guard && !guard()) return; if (!a || a === document.body || a.id === 'd_passenger' || a.id === 'd_save' || a.id === 'd_caller') focusEl(el); }, 120);
  }
  function chOpen() { var d = document.querySelector('.ch-drop'); return !!(d && !d.hidden && d.getClientRects().length); }
  function overlayOpen() { var o = byId('editOvl'); return !!(o && !o.hidden); }
  /* callerhist.js's list answers Enter / arrows / R / D only from the list or the phone box it hangs under:
     when the console left the cursor elsewhere (Passenger, Book Trip, nowhere), put it back in that phone box */
  function focusListBox() {
    setTimeout(function () {
      if (!chOpen() || overlayOpen()) return;
      var a = document.activeElement, d = document.querySelector('.ch-drop');
      if (a && ((d && d.contains(a)) || a.id === 'd_phone' || a.id === 'd_caller' || a.id === 'ci_num' || (a.classList && a.classList.contains('cid-in')))) return;
      if (a && a !== document.body && a.id !== 'd_passenger' && a.id !== 'd_save') return;
      var ph = byId('d_phone'); if (visible(ph)) focusEl(ph);
    }, 0);
  }
  function focusAfterPhone() {
    if (chOpen()) { focusListBox(); return; }   // callerhist's list is open under the phone: its keys work from there
    var pu = byId('d_puAddr'), doo = byId('d_doAddr');
    var target = (pu && !pu.value.trim()) ? 'd_puAddr' : ((doo && !doo.value.trim()) ? 'd_doAddr' : 'd_puAddr');
    focusSoon(target, function () { return !chOpen() && !overlayOpen(); });
  }

  /* touched boxes since the form was last cleared (user input only: programmatic fills fire no events) */
  var touched = {}, appliedKey = '';
  function resetForm() { touched = {}; appliedKey = ''; var h = byId('smoothCallerHint'); if (h) { h.hidden = true; h.innerHTML = ''; } }
  document.addEventListener('input', function (e) { if (e.target && e.target.id) touched[e.target.id] = true; }, true);
  document.addEventListener('change', function (e) { if (e.target && e.target.id) touched[e.target.id] = true; }, true);

  function hasOption(sel, v) { if (!sel) return false; for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === v) return true; return false; }
  function ensureAccounts(sel) { if (sel && sel.options.length < 3 && g('fillSelect') && g('accountOptions')) call('fillSelect', sel, window.accountOptions(false)); }
  function lastTripFor(k) {
    var best = null, bt = '';
    trips().forEach(function (t) {
      if (!t || t.status === 'Disregard' || key10(t.phone) !== k) return;
      var s = String(t.createdAt || '') + '|' + String(t.date || '') + String(t.time || '');
      if (!best || s > bt) { best = t; bt = s; }
    });
    return best;
  }
  function accountFor(k) { var a = Array.isArray(STATE.accounts) ? STATE.accounts : []; for (var i = 0; i < a.length; i++) if (a[i] && key10(a[i].phone) === k) return a[i]; return null; }
  /* the phone is known: account match + last ride's vehicle / passengers / pay */
  function phoneKnown(num) {
    var k = key10(num); if (!k || k === appliedKey) return;
    if (!on('callerDefaults') && !on('accountMatch')) return;
    appliedKey = k;
    if (editingNow()) return;
    var bits = [], acSel = byId('d_account'), acctDone = false;
    if (on('accountMatch') && acSel && !touched.d_account) {
      var a = accountFor(k);
      if (a) { ensureAccounts(acSel); if (hasOption(acSel, a.id)) { if (acSel.value !== a.id) acSel.value = a.id; acctDone = true; bits.push('Account #' + esc(a.number || '') + ' ' + esc(a.name || '')); } }
    }
    if (on('callerDefaults')) {
      var t = lastTripFor(k);
      if (t) {
        var vt = byId('d_vtype'), px = byId('d_pax');
        if (vt && t.vtype && !touched.d_vtype && hasOption(vt, t.vtype) && vt.value !== t.vtype) { vt.value = t.vtype; bits.push(esc(t.vtype)); }
        if (px && Number(t.pax) > 0 && !touched.d_pax && String(px.value) !== String(t.pax)) { px.value = String(Number(t.pax)); bits.push(Number(t.pax) + ' pax'); }
        if (acSel && !acctDone && !touched.d_account) {
          var pv = '';
          if (t.accountId && Array.isArray(STATE.accounts) && STATE.accounts.some(function (x) { return x && x.id === t.accountId; })) { ensureAccounts(acSel); pv = t.accountId; }
          else if (t.payType === 'Credit Card') pv = 'card'; else if (t.payType === 'Cash') pv = 'cash';
          if (pv && hasOption(acSel, pv) && acSel.value !== pv) { acSel.value = pv; bits.push(pv === 'card' ? 'card' : (pv === 'cash' ? 'cash' : 'account')); }
        }
      }
    }
    if (bits.length) {
      showCallerHint('Set from their last ride: ' + bits.join(' · ') + '. Change it if today is different.');
      call('updateReadout');
      var pu = byId('d_puAddr'), doo = byId('d_doAddr');
      if (pu && doo && pu.value.trim() && doo.value.trim()) call('maybeAutoFare');
    }
  }
  function showCallerHint(html) {
    var h = byId('smoothCallerHint');
    if (!h) { var anchor = byId('d_returning'); if (!anchor || !anchor.parentNode) return; h = document.createElement('div'); h.id = 'smoothCallerHint'; h.className = 'hint smooth-hint'; anchor.parentNode.insertBefore(h, anchor.nextSibling); }
    h.innerHTML = html; h.hidden = false;
  }

  /* ---------- phone formatting ---------- */
  var PHONE_IDS = { d_phone: 1, d_caller: 1, eo_phone: 1 };
  function formatPartial(v) {
    if (/[a-z]/i.test(v)) return v;
    var d = v.replace(/\D/g, ''), lead = '';
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length > 10) return v;
    if (d.length <= 3) return d.length ? d : v;
    if (d.length <= 6) return lead + '(' + d.slice(0, 3) + ') ' + d.slice(3);
    return lead + '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  }
  document.addEventListener('input', act(function (e) {
    var el = e.target; if (!el || !PHONE_IDS[el.id]) return;
    if (on('phoneFormat') && !/^delete/.test(e.inputType || '')) {
      var atEnd = el.selectionStart === el.value.length;
      if (atEnd) { var f = formatPartial(el.value); if (f !== el.value) { el.value = f; try { el.setSelectionRange(f.length, f.length); } catch (x) {} } }
    }
    if (el.id === 'd_phone' && key10(el.value) && digits(el.value).length === 10) phoneKnown(el.value);
  }));
  document.addEventListener('change', act(function (e) { var el = e.target; if (el && el.id === 'd_phone' && key10(el.value)) phoneKnown(el.value); }));

  /* Addresses: the console's own autoFmt (Settings "Auto-format addresses", settings.autoaddr) already
     capitalises and tidies on leave, so no second fix here (see smooth-audit.md). */

  /* ---------- Enter moves on, Ctrl+Enter books ---------- */
  function formFields() {
    var r = formRoot(); if (!r) return [];
    return Array.prototype.filter.call(r.querySelectorAll('input, select, textarea'), function (el) {
      if (!visible(el) || el.readOnly) return false;
      if (el.tagName === 'INPUT' && /^(checkbox|radio|hidden|button|submit|file|range|color)$/.test(el.type)) return false;
      if (el.id === 'd_caller' || (el.classList && el.classList.contains('cid-in'))) return false;
      if (el.closest && el.closest('.ch-drop')) return false;
      return true;
    });
  }
  function nextField(el) {
    var p = byId('d_passenger'), ph = byId('d_phone'), pu = byId('d_puAddr');
    if (el === ph) return (p && visible(p) && !p.value.trim()) ? p : pu;
    if (el === p) return (ph && visible(ph) && !ph.value.trim()) ? ph : pu;
    var list = formFields(), i = list.indexOf(el);
    return i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  }
  function clickSave() { var b = byId('d_save'); if (b && visible(b)) b.click(); }
  document.addEventListener('keydown', act(function (e) {
    if (e.key !== 'Enter' || e.defaultPrevented || e.altKey || e.isComposing) return;
    if (!on('enterNext')) return;
    var t = e.target; if (!t || !inForm(t)) return;
    if (t.tagName === 'BUTTON' || t.tagName === 'A') return;
    if (t.id === 'd_caller' || (t.classList && t.classList.contains('cid-in'))) return;
    if (t.type === 'checkbox' || t.type === 'radio') return;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); clickSave(); return; }
    if (t.tagName === 'TEXTAREA') { if (e.shiftKey) return; e.preventDefault(); clickSave(); return; }
    if (e.shiftKey) return;
    e.preventDefault();
    var nx = nextField(t);
    if (nx) focusEl(nx, nx.tagName === 'INPUT'); else clickSave();
  }));

  /* ---------- the Save button says what will happen ---------- */
  function formWhen() {
    if (whenNow() === 'asap') return null;
    var d = (byId('d_date') || {}).value, t = (byId('d_time') || {}).value;
    if (!d) return null; var p = d.split('-').map(Number), m = /^(\d{1,2}):(\d{2})/.exec(t || '');
    var x = new Date(p[0], (p[1] || 1) - 1, p[2] || 1, m ? +m[1] : 0, m ? +m[2] : 0, 0); return isNaN(x) ? null : x;
  }
  function labelText() {
    var parts = [], w = formWhen();
    parts.push(whenNow() === 'asap' ? 'now' : (w ? dayLbl(w) + h12(w) : 'time?'));
    var vt = (byId('d_vtype') || {}).value; if (vt) parts.push(vt);
    var fare = Number((byId('d_fare') || {}).value) || 0, tolls = Number((byId('d_tolls') || {}).value) || 0;
    if (fare > 0) parts.push(money(fare) + (tolls > 0 ? ' + ' + money(tolls) + ' tolls' : ''));
    else parts.push('no price yet');
    return ' · ' + parts.join(' · ');
  }
  function paintLabel() {
    var b = byId('d_save'); if (!b) return;
    if (!on('saveLabel')) { if (b.hasAttribute('data-smooth-label')) { b.removeAttribute('data-smooth-label'); b.removeAttribute('title'); } return; }
    var l = labelText();
    if (b.getAttribute('data-smooth-label') !== l) { b.setAttribute('data-smooth-label', l); b.title = (b.textContent || '').trim() + l + '  (Ctrl+Enter)'; }
  }
  document.addEventListener('input', function (e) { if (e.target && inForm(e.target)) setTimeout(paintLabel, 0); }, false);
  document.addEventListener('change', function (e) { if (e.target && inForm(e.target)) setTimeout(paintLabel, 0); }, false);

  /* ---------- the Save path: guard, checks, after-save bar ---------- */
  function formSig() {
    var v = function (id) { return String((byId(id) || {}).value || '').trim().toUpperCase(); };
    return [key10(v('d_phone')), v('d_puAddr'), v('d_doAddr'), whenNow() === 'asap' ? 'ASAP' : v('d_date') + ' ' + v('d_time'), v('d_passenger'), v('d_fare')].join('|');
  }
  function formEmpty() { return !String((byId('d_puAddr') || {}).value || '').trim() && !String((byId('d_doAddr') || {}).value || '').trim(); }
  var lastSave = null, pre = null, passed = null;
  function findDuplicate() {
    var k = key10((byId('d_phone') || {}).value); if (!k) return null;
    var w = whenNow() === 'asap' ? new Date() : formWhen(); if (!w) return null;
    var ed = editingNow(), hit = null, best = Infinity;
    trips().forEach(function (t) {
      if (!t || t.id === ed || t.status !== 'Booked' || key10(t.phone) !== k) return;
      var d = pickupOf(t); if (!d) return;
      var gap = Math.abs(d - w); if (gap <= 10 * 60000 && gap < best) { best = gap; hit = t; }
    });
    return hit;
  }
  function checkWhen() {
    if (whenNow() === 'asap') return '';
    var w = formWhen(); if (!w) return '';
    var ed = editingNow();
    if (ed) { var t = findTrip(ed); if (t && String(t.date) === String((byId('d_date') || {}).value) && (call('mil', t.time || '') || String(t.time || '')).slice(0, 5) === String((byId('d_time') || {}).value).slice(0, 5)) return ''; }
    var now = Date.now();
    if (w.getTime() < now - 60000) return 'past';
    if (w.getTime() > now + 30 * 86400000) return 'far';
    return '';
  }
  function block(e) { e.stopImmediatePropagation(); e.preventDefault(); }
  window.addEventListener('click', act(function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#d_save') : null; if (!b) return;
    pre = null;
    var sig = formSig(), now = Date.now();
    if (on('saveGuard') && lastSave && now - lastSave.at < 800 && (sig === lastSave.sig || formEmpty())) { block(e); return; }
    var ed = editingNow();
    var skip = passed && passed.sig === sig && now - passed.at < 30000;
    if (!skip && !formEmpty()) {
      if (on('dupWarn') && !ed) {
        var dup = findDuplicate();
        if (dup) {
          var dd = pickupOf(dup);
          var ok = window.confirm('Possible duplicate: job #' + dup.dispatchNo + ' for ' + fmtPhone(dup.phone) + ' is already booked for ' + (dd ? dayLbl(dd) + h12(dd) : 'about the same time') + ' (' + String(dup.puAddr || '').split(',')[0] + ').\n\nOK = book this one too\nCancel = open #' + dup.dispatchNo + ' instead');
          if (!ok) { block(e); call('editTrip', dup.id); toast('Opened job #' + dup.dispatchNo + ' instead of booking a second car.'); return; }
        }
      }
      if (on('whenCheck')) {
        var wc = checkWhen();
        if (wc) {
          var w = formWhen();
          var msg = wc === 'past'
            ? 'The pickup time ' + dayLbl(w) + h12(w) + ' (' + (w.getMonth() + 1) + '/' + w.getDate() + ') is in the past.\n\nOK = book it anyway\nCancel = fix the time'
            : 'The pickup is ' + Math.round((w - now) / 86400000) + ' days out (' + (w.getMonth() + 1) + '/' + w.getDate() + '/' + w.getFullYear() + ').\n\nOK = book it anyway\nCancel = fix the date';
          if (!window.confirm(msg)) { block(e); focusEl(byId(wc === 'past' ? 'd_time' : 'd_date')); return; }
        }
      }
      passed = { sig: sig, at: now };
    }
    var snap = null; if (ed) { var t0 = findTrip(ed); if (t0) try { snap = JSON.parse(JSON.stringify(t0)); } catch (x) { snap = null; } }
    pre = { count: trips().length, editing: ed, sig: sig, snap: snap, at: now, first: trips()[0] || null };
  }), true);
  window.addEventListener('click', act(function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#d_save') : null; if (!b || !pre) return;
    var p = pre; pre = null;
    var made = null, updated = null;
    if (!p.editing && trips().length > p.count && trips()[0] !== p.first) made = trips()[0];
    else if (p.editing && editingNow() !== p.editing) updated = findTrip(p.editing);
    if (!made && !updated) return;
    lastSave = { at: Date.now(), sig: p.sig };
    b.classList.add('smooth-busy'); b.setAttribute('aria-disabled', 'true');
    setTimeout(function () { b.classList.remove('smooth-busy'); b.removeAttribute('aria-disabled'); }, 800);
    resetForm();
    if (on('afterSave')) {
      showSavedBar(made ? 'new' : 'edit', made || updated, p.snap);
      focusSoon('d_phone');
    }
    paintLabel();
  }), false);

  /* after-save bar: Undo + Text the passenger */
  var barTimer = null;
  function savedBar() {
    var el = byId('smoothSaved');
    if (!el) {
      el = document.createElement('div'); el.id = 'smoothSaved'; el.className = 'smooth-saved'; el.setAttribute('role', 'status'); el.hidden = true;
      document.body.appendChild(el);
      el.addEventListener('click', act(onBarClick));
    }
    return el;
  }
  var barState = null;
  function showSavedBar(kind, t, snap) {
    if (!t) return;
    var el = savedBar(), d = pickupOf(t);
    barState = { kind: kind, id: t.id, snap: snap };
    var canText = kind === 'new' && t.phone && window.Messages && typeof window.Messages.textPassenger === 'function';
    el.innerHTML = '<span class="smooth-saved-msg">' + (kind === 'new' ? 'Booked' : 'Updated') + ' <b>#' + esc(t.dispatchNo) + '</b>' + (d ? ' · ' + esc(dayLbl(d) + h12(d)) : '') + (t.passenger ? ' · ' + esc(t.passenger) : '') + '</span>'
      + '<button type="button" class="btn btn-sm btn-ghost" data-smooth-bar="undo">Undo</button>'
      + (canText ? '<button type="button" class="btn btn-sm btn-navy" data-smooth-bar="text">Text the passenger</button>' : '')
      + '<button type="button" class="smooth-x" data-smooth-bar="close" title="Close" aria-label="Close">×</button>';
    el.hidden = false;
    clearTimeout(barTimer); barTimer = setTimeout(hideBar, 10000);
  }
  function hideBar() { clearTimeout(barTimer); var el = byId('smoothSaved'); if (el) el.hidden = true; barState = null; }
  function fillFormFrom(t) {
    var set = function (id, v) { var el = byId(id); if (el) el.value = v == null ? '' : v; };
    call('clearDispatch');
    set('d_passenger', t.passenger); set('d_phone', t.phone); set('d_puAddr', t.puAddr); set('d_doAddr', t.doAddr);
    set('d_notes', t.notes); set('d_pax', t.pax || 1);
    var vt = byId('d_vtype'); if (vt && hasOption(vt, t.vtype)) vt.value = t.vtype;
    var ac = byId('d_account'); if (ac) { ensureAccounts(ac); var pv = t.accountId || (t.payType === 'Credit Card' ? 'card' : 'cash'); if (hasOption(ac, pv)) ac.value = pv; }
    try { dispatchStops = (t.stops || []).map(function (s) { return { addr: s.addr }; }); call('renderStops'); } catch (x) {}
    if (t.date !== todayStr() || (pickupOf(t) && Math.abs(pickupOf(t) - Date.now()) > 15 * 60000)) { call('setWhen', 'sched'); set('d_date', t.date); set('d_time', String(call('mil', t.time || '') || t.time || '').slice(0, 5)); }
    set('d_fare', (Number(t.fare) || 0).toFixed(2)); set('d_tolls', (Number(t.tolls) || 0).toFixed(2));
    var df = byId('d_fare'); if (df) df.dataset.auto = '';
    /* the booked tolls come back as they were: tolls.js keeps a typed value (it hears the input event) until an address changes */
    var dt = byId('d_tolls'); if (dt) { dt.dataset.auto = ''; if (window.Tolls) { try { dt.dispatchEvent(new Event('input', { bubbles: true })); } catch (x) {} } }
    var dv = byId('d_driver'); if (dv && t.driverId && hasOption(dv, t.driverId)) dv.value = t.driverId;
    call('updateReadout'); call('updateDispMap'); paintLabel();
  }
  function onBarClick(e) {
    var b = e.target.closest('[data-smooth-bar]'); if (!b || !barState) return;
    var a = b.getAttribute('data-smooth-bar'), st = barState, t = findTrip(st.id);
    if (a === 'close') { hideBar(); return; }
    if (a === 'text') { if (t && window.Messages) window.Messages.textPassenger(t.id, null, e); hideBar(); return; }
    if (a === 'undo') {
      hideBar();
      if (!t) { toast('That trip is gone already.', true); return; }
      if (st.kind === 'new') {
        if (t.status !== 'Booked') { toast('Job #' + t.dispatchNo + ' is ' + t.status + ' now: change it from the board.', true); return; }
        t.status = 'Disregard'; if (!t.dropDate) t.dropDate = t.date;
        save(); call('refreshBoard'); if (g('renderClassic')) call('renderClassic');
        fillFormFrom(t);
        toast('Booking #' + t.dispatchNo + ' undone. The form has it back.');
        focusSoon('d_puAddr');
      } else if (st.snap) {
        Object.keys(t).forEach(function (k) { if (!(k in st.snap)) delete t[k]; });
        Object.assign(t, st.snap); save(); call('refreshBoard');
        toast('Change to #' + t.dispatchNo + ' undone.');
      }
    }
  }

  /* ---------- wraps on the form's console functions ---------- */
  wrap('clearDispatch', function (orig) { return function () { var r = orig.apply(this, arguments); resetForm(); paintLabel(); return r; }; });
  var dc = byId('d_clear'); if (dc && !dc._smooth) { dc._smooth = true; dc.addEventListener('click', function () { resetForm(); setTimeout(paintLabel, 0); if (on('focusFlow')) focusSoon('d_phone'); }); }
  wrap('newTrip', function (orig) { return function () { var r = orig.apply(this, arguments); if (on('focusFlow')) focusSoon('d_phone'); return r; }; });
  wrap('classicNew', function (orig) { return function () { var r = orig.apply(this, arguments); if (on('focusFlow')) focusSoon('d_phone'); return r; }; });
  wrap('applyCaller', function (orig) { return function (num) { var r = orig.apply(this, arguments); try { phoneKnown(num); if (on('focusFlow')) focusAfterPhone(); paintLabel(); } catch (e) { log(e); } return r; }; });
  wrap('cpBlank', function (orig) { return function () { var n = ''; try { n = _cpNum; } catch (e) { n = ''; } var r = orig.apply(this, arguments); try { phoneKnown(n); if (on('focusFlow')) focusAfterPhone(); } catch (e) { log(e); } return r; }; });
  wrap('cpUse', function (orig) { return function () { var r = orig.apply(this, arguments); try { phoneKnown((byId('d_phone') || {}).value); if (on('focusFlow')) focusAfterPhone(); } catch (e) { log(e); } return r; }; });
  wrap('openCallerPopout', function (orig) {
    return function () {
      var r = orig.apply(this, arguments);
      try {
        if (on('focusFlow')) setTimeout(function () {
          var o = byId('editOvl'); if (!o || o.hidden) return;
          var bt = o.querySelector('button[onclick^="cpUsual"]') || o.querySelector('.btn-go'); if (bt) focusEl(bt);
        }, 0);
      } catch (e) { log(e); }
      return r;
    };
  });
  wrap('useLastTrip', function (orig) { return function () { var r = orig.apply(this, arguments); paintLabel(); return r; }; });
  wrap('editTrip', function (orig) { return function () { var r = orig.apply(this, arguments); resetForm(); appliedKey = key10((byId('d_phone') || {}).value); paintLabel(); return r; }; });
  wrap('setWhen', function (orig) { return function () { var r = orig.apply(this, arguments); paintLabel(); return r; }; });
  wrap('updateReadout', function (orig) { return function () { var r = orig.apply(this, arguments); try { paintLabel(); } catch (e) {} return r; }; });

  /* =========================================================
     Board / Desk / Classic: selection, one-key status, tel: links
     ========================================================= */
  var boardSel = null, lastSrc = '';
  function rowTripId(tr) {
    if (!tr) return null;
    var a = tr.getAttribute('data-smooth-id'); if (a) return a;
    var m = /editTrip\('([^']+)'\)/.exec(tr.innerHTML) || /cycleStatus\('([^']+)'\)/.exec(tr.innerHTML) || /assignDriver\('([^']+)'/.exec(tr.innerHTML);
    if (m) { tr.setAttribute('data-smooth-id', m[1]); return m[1]; }
    return null;
  }
  function paintBoardSel() {
    ['activeBoard', 'resvBoard'].forEach(function (hid) {
      var h = byId(hid); if (!h) return;
      h.querySelectorAll('tbody tr').forEach(function (tr) { var id = rowTripId(tr), want = !!(boardSel && id === boardSel && on('oneKey')); if (tr.classList.contains('smooth-sel') !== want) tr.classList.toggle('smooth-sel', want); });
    });
  }
  document.addEventListener('mousedown', act(function (e) {
    var t = e.target; if (!t || !t.closest) return;
    if (t.closest('#activeBoard, #resvBoard')) {
      lastSrc = 'board';
      if (t.closest('button, select, a, input, textarea')) { var tr0 = t.closest('tbody tr'); var id0 = rowTripId(tr0); if (id0) { boardSel = id0; paintBoardSel(); } return; }
      var tr = t.closest('tbody tr'), id = rowTripId(tr); if (id) { boardSel = id; paintBoardSel(); }
    } else if (t.closest('#dkBody, .dk-body')) lastSrc = 'desk';
    else if (t.closest('#classicGrid')) lastSrc = 'classic';
  }), true);
  function selectedTrip() {
    var src = lastSrc;
    var ae = document.activeElement;
    if (ae && ae.closest && ae.closest('.dk-scroll')) src = 'desk';
    if (src === 'desk' && window.Desk && typeof window.Desk.selected === 'function') { var d = window.Desk.selected(); if (d) return findTrip(d); }
    if (src === 'classic') { try { if (typeof classicSelId !== 'undefined' && classicSelId) return findTrip(classicSelId); } catch (e) {} }
    if (src === 'board' && boardSel) return findTrip(boardSel);
    return null;
  }
  function boardOnScreen() { var a = byId('activeBoard'), r = byId('resvBoard'), dk = document.querySelector('.dk-body'), cg = byId('classicGrid'); return visible(a) || visible(r) || visible(dk) || visible(cg); }
  function ownUndo(label, t, fn) {
    var before = null; try { before = JSON.parse(JSON.stringify(t)); } catch (e) {}
    if (window.Simple && typeof window.Simple.undoable === 'function') { fn(); return; }   // simple.js already offers Undo on these
    fn();
    if (before && t.status !== before.status) {
      var el = savedBar(); barState = { kind: 'edit', id: t.id, snap: before };
      el.innerHTML = '<span class="smooth-saved-msg">' + esc(label) + '</span><button type="button" class="btn btn-sm btn-ghost" data-smooth-bar="undo">Undo</button><button type="button" class="smooth-x" data-smooth-bar="close" aria-label="Close">×</button>';
      el.hidden = false; clearTimeout(barTimer); barTimer = setTimeout(hideBar, 10000);
    }
  }
  document.addEventListener('keydown', act(function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !on('oneKey')) return;
    var k = String(e.key || '').toLowerCase(); if (k !== 'd' && k !== 'c' && k !== 'n' && k !== 'x') return;
    var t0 = e.target; if (t0 && (/^(INPUT|TEXTAREA|SELECT)$/.test(t0.tagName) || t0.isContentEditable)) return;
    if (overlayOpen() || !boardOnScreen()) return;
    var t = selectedTrip(); if (!t) return;
    e.preventDefault();
    var no = '#' + t.dispatchNo;
    if (k === 'd') {
      if (t.status !== 'Booked') { toast(no + ' is ' + t.status + ': D dispatches a Booked job.', true); return; }
      if (!t.driverId) { toast(no + ' has no driver yet. Pick one in the Driver box first.', true); return; }
      ownUndo(no + ' dispatched', t, function () { call('cycleStatus', t.id); });
    } else if (k === 'c') {
      if (t.status !== 'Dispatched') { toast(no + ' is ' + t.status + (t.status === 'Booked' ? ': press D to dispatch it first.' : '.'), true); return; }
      ownUndo(no + ' completed', t, function () { call('cycleStatus', t.id); });
    } else if (k === 'n') {
      if (t.status !== 'Booked' && t.status !== 'Dispatched') { toast(no + ' is ' + t.status + '.', true); return; }
      ownUndo(no + ' marked No-Show', t, function () { call('noShowTrip', t.id); });
    } else if (k === 'x') {
      if (t.status !== 'Booked' && t.status !== 'Dispatched') { toast(no + ' is ' + t.status + '.', true); return; }
      ownUndo(no + ' canceled', t, function () { call('cancelTrip', t.id); });
    }
    try { if (window.Desk && typeof window.Desk.render === 'function' && lastSrc === 'desk') window.Desk.render(); } catch (x) {}
    paintBoardSel();
  }));

  /* tel: links */
  var TEL_HOSTS = '#activeBoard, #resvBoard, #classicGrid, #view-trips, #d_callerResult, #d_returning, #smoothCallerHint, .dk-body, #needsYou';
  var PHONE_RE = /(\+?1[\s.\-]?)?(\(\d{3}\)\s?|\b\d{3}[\s.\-])\d{3}[\s.\-]\d{4}\b|\b1?\d{10}\b/g;
  function linkify(root) {
    var hosts = root.querySelectorAll ? root.querySelectorAll(TEL_HOSTS) : [];
    Array.prototype.forEach.call(hosts, function (host) {
      var w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, { acceptNode: function (n) {
        var p = n.parentNode; if (!p || !/\d{3}/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('a, button, select, option, input, textarea, script, style, [contenteditable], .smooth-tel, .dk-editing, th')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT; } });
      var list = []; while (w.nextNode()) list.push(w.currentNode);
      list.forEach(function (n) {
        var s = n.nodeValue; PHONE_RE.lastIndex = 0; if (!PHONE_RE.test(s)) return; PHONE_RE.lastIndex = 0;
        var frag = document.createDocumentFragment(), last = 0, m, any = false;
        while ((m = PHONE_RE.exec(s))) {
          var k = key10(m[0]); if (!k || /^[01]/.test(k)) continue;
          any = true;
          if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
          var a = document.createElement('a'); a.className = 'smooth-tel'; a.href = 'tel:+1' + k; a.textContent = m[0]; a.title = (host.classList && host.classList.contains('dk-body') ? 'Ctrl+click to call ' : 'Call ') + fmtPhone(k);
          frag.appendChild(a); last = m.index + m[0].length;
        }
        if (!any) return;
        if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
        n.parentNode.replaceChild(frag, n);
      });
    });
  }
  function unlinkAll() { document.querySelectorAll('a.smooth-tel').forEach(function (a) { var p = a.parentNode; if (!p) return; p.replaceChild(document.createTextNode(a.textContent), a); p.normalize(); }); }
  /* In the desk grids (desk.js) a click selects the row and a double-click edits the Telephone cell: there a mouse
     click does not dial (Ctrl+click or a tap on a touch screen does), and the click still reaches the grid. */
  var lastPtr = '';
  document.addEventListener('pointerdown', function (e) { lastPtr = e.pointerType || ''; }, true);
  function inDesk(a) { return !!(a && a.closest && a.closest('.dk-body')); }
  document.addEventListener('click', function (e) { var a = e.target && e.target.closest ? e.target.closest('a.smooth-tel') : null; if (!a) return; if (inDesk(a)) { if (!(e.ctrlKey || e.metaKey) && lastPtr !== 'touch') e.preventDefault(); return; } e.stopPropagation(); }, true);
  document.addEventListener('dblclick', function (e) { var a = e.target && e.target.closest ? e.target.closest('a.smooth-tel') : null; if (!a) return; if (inDesk(a)) { e.preventDefault(); return; } e.stopPropagation(); }, true);

  /* one observer for every re-rendered area: tel links, board selection, Needs-you folding */
  var pending = false;
  function sweep() {
    pending = false;
    try { if (on('telLinks')) linkify(document); } catch (e) { log(e); }
    try { paintBoardSel(); } catch (e) { log(e); }
    try { foldNeeds(); } catch (e) { log(e); }
  }
  function schedule() { if (pending) return; pending = true; setTimeout(sweep, 30); }
  if (window.MutationObserver) {
    try { new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        var t = recs[i].target; if (!t || t.nodeType !== 1) continue;
        if (t.closest && t.closest(TEL_HOSTS)) { schedule(); return; }
        var ad = recs[i].addedNodes;
        for (var j = 0; j < ad.length; j++) { var n = ad[j]; if (n.nodeType === 1 && ((n.matches && n.matches(TEL_HOSTS)) || (n.querySelector && n.querySelector(TEL_HOSTS)))) { schedule(); return; } }
      }
    }).observe(document.body, { childList: true, subtree: true }); } catch (e) { log(e); }
  }

  /* =========================================================
     Needs-you: one line per trip
     ========================================================= */
  function foldNeeds() {
    var host = byId('needsYou'); if (!host) return;
    var items = Array.prototype.slice.call(host.querySelectorAll('.ny-item'));
    if (!on('nyDedupe')) {
      items.forEach(function (it) { if (it.classList.contains('smooth-ny-dup')) it.classList.remove('smooth-ny-dup', 'smooth-ny-show'); });
      host.querySelectorAll('.smooth-ny-more').forEach(function (b) { b.remove(); });
      return;
    }
    var groups = {};
    items.forEach(function (it) { var id = it.getAttribute('data-id'); if (!id) return; (groups[id] = groups[id] || []).push(it); });
    items.forEach(function (it) {
      var id = it.getAttribute('data-id'), grp = id ? groups[id] : null, first = grp && grp[0] === it, dup = grp && grp.length > 1 && !first;
      if (it.classList.contains('smooth-ny-dup') !== !!dup) it.classList.toggle('smooth-ny-dup', !!dup);
      var badge = it.querySelector(':scope > .smooth-ny-more');
      var want = first && grp.length > 1 ? grp.length - 1 : 0;
      if (!want) { if (badge) badge.remove(); return; }
      var txt = '+' + want + ' more';
      if (badge && badge.textContent === txt) return;
      if (!badge) { badge = document.createElement('button'); badge.type = 'button'; badge.className = 'smooth-ny-more btn btn-sm btn-ghost'; badge.setAttribute('data-smooth-ny', id); it.appendChild(badge); }
      badge.textContent = txt; badge.title = 'Other notes about this trip: ' + grp.slice(1).map(function (x) { return ((x.querySelector('.ny-txt') || x).textContent || '').trim(); }).join(' | ');
    });
  }
  document.addEventListener('click', act(function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.smooth-ny-more') : null; if (!b) return;
    e.stopPropagation();
    var id = b.getAttribute('data-smooth-ny'), host = byId('needsYou'); if (!host) return;
    host.querySelectorAll('.ny-item.smooth-ny-dup').forEach(function (it) { if (it.getAttribute('data-id') === id) it.classList.toggle('smooth-ny-show'); });
  }), true);

  /* =========================================================
     Next pickup + chime
     ========================================================= */
  function nextPickup(nowMs) {
    var now = nowMs || Date.now(), best = null, bd = null;
    trips().forEach(function (t) {
      if (!t || (t.status !== 'Booked' && t.status !== 'Dispatched')) return;
      if (t.status === 'Dispatched' && t.time && /asap/i.test(t.time)) return;
      var d = pickupOf(t); if (!d || d.getTime() < now - 60000) return;
      if (!bd || d < bd) { bd = d; best = t; }
    });
    if (!best) return null;
    var mins = Math.max(0, Math.round((bd.getTime() - now) / 60000));
    return { id: best.id, no: best.dispatchNo, at: bd, mins: mins, unassigned: !best.driverId, status: best.status };
  }
  function inText(m) { if (m < 1) return 'now'; if (m < 90) return 'in ' + m + ' min'; var h = Math.floor(m / 60); if (h < 24) return 'in ' + h + ' h ' + (m % 60) + ' min'; return 'in ' + Math.round(h / 24) + ' days'; }
  function paintNext() {
    var sb = byId('statusBar'), clock = document.querySelector('.cmdbar .clock');
    var a = byId('smoothNext'), b = byId('smoothNextTop');
    if (!on('nextPickup')) { if (a) a.hidden = true; if (b) b.hidden = true; return; }
    if (!a && sb) { a = document.createElement('span'); a.id = 'smoothNext'; a.className = 'sb-cell smooth-next'; var c = byId('sbClock'); sb.insertBefore(a, c || null); }
    if (!b && clock) { b = document.createElement('div'); b.id = 'smoothNextTop'; b.className = 'smooth-next-top'; clock.appendChild(b); }
    var n = nextPickup(), txt, hot = false, tip = '';
    if (!n) txt = 'No pickups waiting';
    else { txt = 'Next pickup ' + dayLbl(n.at) + h12(n.at) + ' · #' + n.no + ' · ' + inText(n.mins) + (n.unassigned ? ' · no driver' : ''); hot = n.unassigned && n.mins <= 15; tip = 'Click to open job #' + n.no; }
    [a, b].forEach(function (el) {
      if (!el) return; el.hidden = false;
      if (el.textContent !== txt) el.textContent = txt;
      el.classList.toggle('hot', hot); el.title = tip;
      el.setAttribute('data-trip', n ? n.id : '');
    });
  }
  document.addEventListener('click', act(function (e) {
    var el = e.target && e.target.closest ? e.target.closest('#smoothNext, #smoothNextTop') : null; if (!el) return;
    var id = el.getAttribute('data-trip'); if (id) { boardSel = id; lastSrc = 'board'; call('editTrip', id); }
  }));

  var chimed = {};
  try { chimed = JSON.parse(sessionStorage.getItem('skyway_smooth_chimed') || '{}') || {}; } catch (e) { chimed = {}; }
  var audioCtx = null, chimeLog = [];
  function playChime() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended' && audioCtx.resume) { try { audioCtx.resume(); } catch (e) {} }
      var t0 = audioCtx.currentTime;
      [[660, 0], [880, 0.22]].forEach(function (p) {
        var o = audioCtx.createOscillator(), gn = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = p[0];
        gn.gain.setValueAtTime(0.0001, t0 + p[1]); gn.gain.exponentialRampToValueAtTime(0.08, t0 + p[1] + 0.03); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + p[1] + 0.35);
        o.connect(gn); gn.connect(audioCtx.destination); o.start(t0 + p[1]); o.stop(t0 + p[1] + 0.4);
      });
      return true;
    } catch (e) { return false; }
  }
  function chimeTick(nowMs) {
    if (!on('chime')) return [];
    var now = nowMs || Date.now(), fired = [];
    trips().forEach(function (t) {
      if (!t || t.status !== 'Booked' || t.driverId) return;
      var d = pickupOf(t); if (!d) return;
      var left = (d.getTime() - now) / 60000; if (left <= 0 || left > 10) return;
      var c = chimed[t.id] || {}, step = left <= 5 ? 5 : 10;
      if (c[step]) return;
      c[10] = true; if (step === 5) c[5] = true; chimed[t.id] = c;
      fired.push({ id: t.id, no: t.dispatchNo, step: step });
    });
    if (fired.length) {
      playChime();
      fired.forEach(function (f) { chimeLog.push({ id: f.id, step: f.step, at: now }); });
      try { sessionStorage.setItem('skyway_smooth_chimed', JSON.stringify(chimed)); } catch (e) {}
      var f0 = fired[0]; toast('#' + f0.no + ' picks up in ' + (f0.step === 5 ? '5' : '10') + ' min and nobody is assigned.', true);
    }
    return fired;
  }
  wrap('refreshBoard', function (orig) { return function () { var r = orig.apply(this, arguments); try { paintNext(); } catch (e) { log(e); } return r; }; });
  setInterval(act(function () { paintNext(); chimeTick(); paintLabel(); }), 15000);
  setInterval(act(paintLabel), 1500);

  /* =========================================================
     Ctrl-K: caller history for a phone result
     ========================================================= */
  function callerHistory(num) {
    var k = key10(num); if (!k) return false;
    try { if (window.Simple && typeof window.Simple.enter === 'function') window.Simple.enter('book'); } catch (e) {}
    call('applyCaller', fmtPhone(k));
    if (window.CallerHist && typeof window.CallerHist.show === 'function' && !chOpen()) { try { window.CallerHist.show(fmtPhone(k), byId('d_phone')); } catch (e) { log(e); } }
    return true;
  }
  function decorateSearch() {
    var box = byId('gsr'), i = byId('gsearch'); if (!box || !i) return;
    var old = box.querySelector('.smooth-gs'); if (old) old.remove();
    if (!on('ctrlKCaller') || box.hidden) return;
    var d = String(i.value || '').replace(/\D/g, '');
    var k = d.length >= 10 ? key10(d) : '';
    if (!k && d.length >= 7) { var hit = trips().find(function (t) { return t && t.phone && digits(t.phone).indexOf(d) >= 0 && key10(t.phone); }); if (hit) k = key10(hit.phone); }
    if (!k) return;
    var n = trips().filter(function (t) { return t && key10(t.phone) === k; }).length;
    var div = document.createElement('div'); div.className = 'g-item smooth-gs'; div.setAttribute('data-smooth-ch', k);
    div.innerHTML = '<b>Caller history</b> for ' + esc(fmtPhone(k)) + '<div class="g-sub">' + (n ? n + ' trip' + (n === 1 ? '' : 's') + ' on file · ' : '') + 'past trips under the phone box, ready to book again (Enter)</div>';
    box.insertBefore(div, box.firstChild);
  }
  wrap('globalSearch', function (orig) { return function () { var r = orig.apply(this, arguments); try { decorateSearch(); } catch (e) { log(e); } return r; }; });
  (function () {
    var i = byId('gsearch'); if (!i || i._smooth) return; i._smooth = true;
    i.addEventListener('input', act(decorateSearch)); i.addEventListener('focus', act(decorateSearch));
    i.addEventListener('keydown', act(function (e) {
      if (e.key !== 'Enter' || !on('ctrlKCaller')) return;
      var it = (byId('gsr') || document).querySelector('.smooth-gs'); if (!it) return;
      e.preventDefault(); var k = it.getAttribute('data-smooth-ch'); call('gsClear'); callerHistory(k);
    }));
    var box = byId('gsr');
    if (box) box.addEventListener('mousedown', act(function (e) { var it = e.target.closest('.smooth-gs'); if (!it) return; e.preventDefault(); var k = it.getAttribute('data-smooth-ch'); call('gsClear'); callerHistory(k); }));
  })();

  /* =========================================================
     Settings panel "Smoothness" (Display & modes)
     ========================================================= */
  function panelHtml() {
    var s = toggles();
    return '<div class="panel-head">Smoothness <span class="hint" style="text-transform:none;font-weight:400;">small fixes for every call — each can be turned off</span></div>'
      + '<div class="panel-body smooth-panel">'
      + FIXES.map(function (f) {
        return '<label class="smooth-opt"><input type="checkbox" data-smooth-key="' + f.key + '"' + (s[f.key] ? ' checked' : '') + '> <span><b>' + esc(f.label) + '</b><span class="hint"> — ' + esc(f.why) + '</span></span></label>';
      }).join('')
      + '<div class="hint" style="margin-top:6px;">Saves about ' + Math.round(FIXES.reduce(function (a, f) { return a + f.minutes; }, 0)) + ' minutes on a busy day.</div>'
      + '</div>';
  }
  function ensurePanel() {
    var view = byId('view-settings'); if (!view) return;
    var p = byId('smoothPanel');
    if (!p) {
      p = document.createElement('div'); p.className = 'panel'; p.id = 'smoothPanel';
      p.innerHTML = panelHtml();
      p.addEventListener('change', act(function (e) { var el = e.target; var k = el && el.getAttribute && el.getAttribute('data-smooth-key'); if (!k) return; setKey(k, el.checked); toast((el.checked ? 'On: ' : 'Off: ') + (FIXES.filter(function (f) { return f.key === k; })[0] || {}).label); }));
    }
    var body = byId('setupSecBody_display');
    if (body) { if (p.parentNode !== body) { p.setAttribute('data-setup-rank', '40'); p.setAttribute('data-setup-sec', 'display'); body.appendChild(p); } }
    else if (!p.parentNode) view.appendChild(p);
    else if (p.closest && p.closest('#setupSecBody_other') && byId('setupSecBody_display')) byId('setupSecBody_display').appendChild(p);
    var ob = byId('setupSecBody_other'), os = byId('setupSec_other');
    if (ob && os && !ob.children.length && !os.hidden) { os.hidden = true; var oc = document.querySelector('.setup-chip[data-sec="other"]'); if (oc) oc.hidden = true; }
  }
  function syncPanel() { var p = byId('smoothPanel'); if (!p) return; var s = toggles(); p.querySelectorAll('input[data-smooth-key]').forEach(function (el) { var v = !!s[el.getAttribute('data-smooth-key')]; if (el.checked !== v) el.checked = v; }); }
  wrap('renderSettings', function (orig) { return function () { var r = orig.apply(this, arguments); try { ensurePanel(); syncPanel(); } catch (e) { log(e); } return r; }; });

  function applyToggle(k) {
    syncPanel();
    if (k === 'telLinks') { if (on('telLinks')) linkify(document); else unlinkAll(); }
    if (k === 'saveLabel') paintLabel();
    if (k === 'nextPickup') paintNext();
    if (k === 'nyDedupe') foldNeeds();
    if (k === 'oneKey') paintBoardSel();
  }

  /* ---------- styles (own sheet, so the module works without smooth.css) ---------- */
  function ensureStyle() {
    if (byId('smoothStyle')) return;
    var st = document.createElement('style'); st.id = 'smoothStyle';
    st.textContent = [
      '#d_save[data-smooth-label]::after{content:attr(data-smooth-label);font-weight:400;font-size:.86em;opacity:.92;}',
      '#d_save.smooth-busy{opacity:.6;cursor:progress;}',
      '.smooth-hint{margin:-4px 0 10px;color:#2d5a3d;}',
      '.smooth-saved{position:fixed;left:16px;bottom:40px;z-index:9050;display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:calc(100vw - 32px);background:#fff;color:#1f1f1f;border:1px solid #c4c7cc;border-left:4px solid #1f7a3f;border-radius:3px;padding:8px 10px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.2);}',
      '.smooth-saved[hidden]{display:none;}',
      '.smooth-saved .smooth-x{background:none;border:0;font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;color:#555;min-width:32px;min-height:32px;}',
      'tr.smooth-sel>td{box-shadow:inset 0 2px 0 #2f72bd,inset 0 -2px 0 #2f72bd;background:#eaf2fc !important;}',
      'a.smooth-tel{color:inherit;text-decoration:underline dotted;text-underline-offset:2px;}',
      'a.smooth-tel:hover{color:#1f5fa8;}',
      '.smooth-next{font-weight:700;cursor:pointer;}',
      '.smooth-next.hot,.smooth-next-top.hot{color:#b3261e;}',
      '.smooth-next-top{font-size:11px;opacity:.95;cursor:pointer;margin-top:2px;white-space:nowrap;}',
      '.smooth-next-top.hot{background:#fff;border-radius:2px;padding:0 4px;}',
      '.ny-item.smooth-ny-dup{display:none !important;}',
      '.ny-item.smooth-ny-dup.smooth-ny-show{display:flex !important;opacity:.85;margin-left:18px;}',
      '.smooth-ny-more{margin-left:6px;}',
      '.smooth-panel .smooth-opt{display:flex;gap:8px;align-items:flex-start;margin:4px 0;cursor:pointer;}',
      '.smooth-panel .smooth-opt input{width:auto;margin-top:3px;}',
      '@media (max-width:600px){.smooth-next-top{display:none;}.smooth-saved{left:16px;right:16px;}}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- boot ---------- */
  function boot() {
    try { ensureStyle(); } catch (e) { log(e); }
    try { ensurePanel(); } catch (e) { log(e); }
    try { paintNext(); } catch (e) { log(e); }
    try { paintLabel(); } catch (e) { log(e); }
    try { sweep(); } catch (e) { log(e); }
    try { chimeTick(); } catch (e) { log(e); }
    /* setup.js may build its hub after this file: file the panel once more */
    setTimeout(act(ensurePanel), 600); setTimeout(act(ensurePanel), 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.Smooth = {
    audit: FIXES, toggles: toggles, on: on, set: setKey,
    nextPickup: nextPickup, chimeTick: chimeTick, callerHistory: callerHistory,
    _chimes: chimeLog, _resetChimes: function () { chimed = {}; chimeLog.length = 0; try { sessionStorage.removeItem('skyway_smooth_chimed'); } catch (e) {} },
    _loaded: true
  };
})();
