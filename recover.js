/* ======================================================================
   Skyway — recover.js
   "Prove recovery" (TURNAROUND-PLAN build rows 9a and 9b; app-gaps.md §7).

   (a) TLC export lint — the Download CSV button in Money → TLC export is
       intercepted (capture-phase listener; the original handler is an
       anonymous listener and cannot be wrapped). The file holds Completed
       trips only; a trip that lacks a plate, a driver TLC licence, a pickup
       time or a drop-off time blocks the export and is listed so it can be
       fixed; pickup time is never written in place of a missing drop time;
       a pre-export checklist shows the row count (= Completed trips with all
       fields) before the file is built; every export is recorded in
       STATE.exports [{at, kind:'tlc', month, from, to, rows, by, file}].
   (b) Named staff with hashed PINs — STATE.staff [{id, name, role, salt,
       hash, iter, active, legacy, createdAt}]; PIN = PBKDF2-SHA-256 over a
       random salt (WebCrypto), never stored in clear. Roles owner /
       dispatcher / bookkeeper. First run: the existing settings.adminPin
       (simple.js's Settings/Expert PIN) is hashed into the owner's record;
       settings.adminPin itself is left in place because simple.js, ops.js,
       ledger.js and quote.js still read it directly (see "Open issues" in
       the integration notes). Role gating: a signed-in dispatcher cannot
       export the trips CSV, the TLC file or a backup, cannot restore, reset
       or run settlements; a bookkeeper sees money and may file the TLC
       export but cannot change rates. With nobody signed in the station is
       a dispatcher (owner decision 6) and an owner-only button asks for the
       owner PIN — the same prompt-style gate the other modules use — and
       signs that owner in for the session. STATE.audit is a ring buffer of
       the last 2,000 events {at, by, role, what, ref, detail} written by
       wrappers on assignDriver / bestAssign / diqAssign / optAssignOne /
       optApplyAll / cancelTrip / noShowTrip / cycleStatus / reinstateTrip /
       deleteTrip / saveEditOvl (Board edit overlay) and by a capture+bubble
       pair around the Book-Trip form's #d_save (edit of an existing trip, or
       a new booking saved with a driver), by Ledger.settle / markPaid /
       refund, by every export, backup, restore, reset, staff and settings
       change, plus the classic layout's Drop and Simple mode's Undo. Viewer +
       CSV export in Settings → "Staff, access & activity"; a signed-in owner
       or bookkeeper opens Settings in Simple mode (bar button, sub-buttons,
       Alt+6) without simple.js's PIN prompt (their own hashed PIN already
       proved who they are). The secrets on that view — simple.js's #s_pin
       (settings.adminPin in clear) and the Google / LocationIQ keys — are
       blanked and read-only for anyone but a signed-in owner (a fresh station
       with no PIN counts as the owner); clicking a masked field asks for the
       owner PIN. An owner or bookkeeper record must have a PIN; a name-only
       sign-in exists only for dispatchers and for the first owner before any
       PIN is set. Owner PINs are exactly 4 digits because they are mirrored
       into settings.adminPin for the modules that still read it.
   (c) Encrypted backup — AES-GCM (WebCrypto) with a key derived by PBKDF2
       from a passphrase the owner types (never stored). The .skyenc file
       carries the salt, iv, iterations, a SHA-256 checksum of the plaintext,
       the schema version and the record counts (counts only — no fare total,
       job numbers or names are readable without the passphrase). The bundle holds STATE
       (Google keys stripped unless "include keys" is ticked) plus the
       localStorage side keys (caller book, route book, history seed…).
       A recovery-key file (the raw AES key) can be downloaded right after a
       backup. Restore runs in a sandbox first: parse → decrypt → checksum →
       migrate() into a local copy → counts compared to the live STATE and
       shown as a diff → the owner types RESTORE to apply. The plaintext
       .json backup stays available to the owner behind a warning; the
       plaintext import now also goes through the sandbox.
   (d) Outage sheet — one click prints today's and tomorrow's booked trips
       (pickup time, passenger first name, phone, pickup, drop, driver, fare)
       plus the driver phone list and blank log rows, so dispatch runs on
       paper if the browser dies. One button that lives on Today (own strip
       above the board, also shown on the Expert-mode Dispatch tab) and on
       Board (simple.js's board tools), plus one in Settings.

   STATE keys owned here: staff[], audit[], exports[], settings.security.
   Conventions: IIFE, bail on pop-outs, wrap globals and call through,
   inject panels into existing views, save() after writes, re-render by the
   console's own functions. STATE is the console's top-level `let`.
   Public API: window.Recover (see bottom). Plain ES2019 + async/await.
   Never edits index.html. Works with Cloud off; nothing here touches the
   network.
   ====================================================================== */
(function () {
  'use strict';
  if (window.Recover && window.Recover._loaded) return;   // load guard: a second <script> or re-include must not add a second set of listeners
  if (typeof STATE === 'undefined') return;

  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }
  if (POPOUT) return;

  /* ---------- helpers (same shape as money.js) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[recover] ' + m); } catch (e) {} }
  function save() { if (typeof window.saveNow === 'function') { try { window.saveNow(); return; } catch (e) {} } if (typeof window.save === 'function') { try { window.save(); } catch (e) {} } }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  function trips() { return Array.isArray(STATE.trips) ? STATE.trips : []; }
  function drivers() { return Array.isArray(STATE.drivers) ? STATE.drivers : []; }
  function vehicles() { return Array.isArray(STATE.vehicles) ? STATE.vehicles : []; }
  function findTrip(id) { if (id && typeof id === 'object') return id; return trips().filter(function (t) { return t.id === id; })[0] || null; }
  function findDriver(id) { return drivers().filter(function (d) { return d.id === id; })[0] || null; }
  function findVehicle(id) { return vehicles().filter(function (v) { return v.id === id; })[0] || null; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function ymdOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { if (typeof window.todayStr === 'function') { try { return window.todayStr(); } catch (e) {} } return ymdOf(new Date()); }
  function tomorrowStr() { var d = new Date(); d.setDate(d.getDate() + 1); return ymdOf(d); }
  function nowISO() { return new Date().toISOString(); }
  function uid() { if (typeof window.uid === 'function') { try { return window.uid(); } catch (e) {} } return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { try { console.error('[recover]', err); } catch (e2) {} } }; }
  function money(n) { if (typeof window.money === 'function') { try { return window.money(n); } catch (e) {} } n = Number(n) || 0; return '$' + n.toFixed(2); }
  function fmtTime12(t) { if (window.Messages && typeof window.Messages.fmtTime12 === 'function') { try { return window.Messages.fmtTime12(t); } catch (e) {} } return t || ''; }
  function fmtPhone(p) { if (window.Region && typeof window.Region.fmtPhone === 'function') { try { return window.Region.fmtPhone(p); } catch (e) {} } return p || ''; }
  function shortAddr(a) { if (typeof window.shortAddr === 'function') { try { return window.shortAddr(a); } catch (e) {} } return (a || '').split(',')[0].trim(); }
  function csvCell(v) { if (typeof window.csv === 'function') { try { return window.csv(v); } catch (e) {} } v = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function download(name, content, type) {
    if (typeof window.download === 'function') { try { window.download(name, content, type); return true; } catch (e) {} }
    try { var blob = new Blob([content], { type: type || 'text/plain' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); return true; } catch (e) { return false; }
  }
  function openPrint(html) { if (typeof window.openPrint === 'function') { try { window.openPrint(html); return true; } catch (e) {} } try { var w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); return true; } } catch (e) {} return false; }
  function fmtWhen(iso) { try { var d = new Date(iso); if (isNaN(d)) return ''; return ymdOf(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); } catch (e) { return ''; } }
  function bizName() { return settings().name || 'Skyway Car Service'; }
  function ask(msg, dflt) { try { return window.prompt(msg, dflt == null ? '' : dflt); } catch (e) { return null; } }
  function confirmBox(msg) { try { return !!window.confirm(msg); } catch (e) { return false; } }
  function dispatchNoOf(t) { return t ? '#' + (t.dispatchNo || '?') : 'trip'; }
  function firstName(s) { return String(s || '').trim().split(/\s+/)[0] || ''; }
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

  /* ---------- STATE (defensive init, idempotent) ---------- */
  var TLC_HEAD = ['dispatching_base_number', 'pickup_date', 'pickup_time', 'TLC_drivers_license_number', 'license_plate', 'affiliated_base_number', 'pickup_location_type', 'pickup_location_name', 'pickup_longitude', 'pickup_latitude', 'dropoff_date', 'dropoff_time', 'dropoff_location_type', 'dropoff_location_name', 'dropoff_longitude', 'dropoff_latitude'];
  var AUDIT_MAX = 2000, EXPORTS_MAX = 500, PBKDF2_ITER = 150000, SCHEMA = 2;   // SCHEMA follows the storage key skyway_dispatch_v2
  function sec() {
    var s = settings();
    if (!s.security || typeof s.security !== 'object') s.security = {};
    var c = s.security;
    if (c.version == null) c.version = 1;
    if (!c.defaultRole) c.defaultRole = 'dispatcher';                 // owner decision 6: every station is a dispatcher unless the owner signs in
    if (!c.pbkdf2Iterations) c.pbkdf2Iterations = PBKDF2_ITER;
    if (c.tlcCompletedOnly == null) c.tlcCompletedOnly = true;
    if (!c.tlcHeader) c.tlcHeader = TLC_HEAD.join(',');              // the accepted spec header; editable by the owner, diffed before each export
    if (c.lastBackupAt == null) c.lastBackupAt = '';
    if (c.lastRestoreTestAt == null) c.lastRestoreTestAt = '';
    if (c.lastRestoreMatch == null) c.lastRestoreMatch = null;
    if (c.backupReminderDays == null) c.backupReminderDays = 2;
    return c;
  }
  function staff() { if (!Array.isArray(STATE.staff)) STATE.staff = []; return STATE.staff; }
  function audit() { if (!Array.isArray(STATE.audit)) STATE.audit = []; return STATE.audit; }
  function exportsLog() { if (!Array.isArray(STATE.exports)) STATE.exports = []; return STATE.exports; }

  /* ---------- WebCrypto ---------- */
  var subtle = null;
  try { subtle = (window.crypto && window.crypto.subtle) || null; } catch (e) { subtle = null; }
  function cryptoReady() { return !!subtle; }
  function bytes(buf) { return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }
  function b64(buf) { var u = bytes(buf), s = ''; for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { var bin = atob(String(s || '')), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function utf8(s) { return new TextEncoder().encode(String(s)); }
  function fromUtf8(buf) { return new TextDecoder().decode(bytes(buf)); }
  function randomBytes(n) { var u = new Uint8Array(n); window.crypto.getRandomValues(u); return u; }
  function hex(buf) { return Array.prototype.map.call(bytes(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function sha256Hex(str) { return subtle.digest('SHA-256', utf8(str)).then(hex); }
  function pbkdf2Bits(secret, salt, iter, bits) {
    return subtle.importKey('raw', utf8(secret), 'PBKDF2', false, ['deriveBits', 'deriveKey'])
      .then(function (k) { return subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(salt), iterations: iter }, k, bits); });
  }
  function hashPin(pin, saltB64, iter) { return pbkdf2Bits('pin:' + String(pin), unb64(saltB64), iter, 256).then(b64); }
  function deriveAesKey(passphrase, salt, iter) {
    return subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, ['deriveKey'])
      .then(function (k) { return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(salt), iterations: iter }, k, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); });
  }
  function importRawKey(rawB64) { return subtle.importKey('raw', unb64(rawB64), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); }
  function ctEqual(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; var r = 0; for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

  /* ---------- staff + session ---------- */
  var ROLES = ['owner', 'dispatcher', 'bookkeeper'];
  var SESSION_KEY = 'skyway_staff_session';
  var session = null;   // {staffId, name, role, at, via}
  function loadSession() {
    try { var raw = sessionStorage.getItem(SESSION_KEY); if (!raw) return null; var s = JSON.parse(raw); var rec = staffById(s.staffId); if (!rec || rec.active === false) return null; s.name = rec.name; s.role = rec.role; return s; } catch (e) { return null; }
  }
  function storeSession() { try { if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); else sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }
  function staffById(id) { return staff().filter(function (s) { return s.id === id; })[0] || null; }
  function activeStaff() { return staff().filter(function (s) { return s.active !== false; }); }
  function owners() { return activeStaff().filter(function (s) { return s.role === 'owner'; }); }
  function who() { return session ? session.name : ''; }
  function role() { return session ? session.role : (sec().defaultRole || 'dispatcher'); }
  function current() { return session ? { id: session.staffId, name: session.name, role: session.role, via: session.via || 'pin' } : null; }
  function legacyPin() { var p = String(settings().adminPin || '').trim(); return /^\d{4}$/.test(p) ? p : ''; }
  /* Owner PINs are exactly 4 digits: simple.js (Settings / Expert mode), ledger.js, quote.js, ops.js, crm.js and plan.js all read
     settings.adminPin and treat anything but 4 digits as "no PIN" (some then allow everything, some refuse everything), so the
     owner's PIN is mirrored there and must fit. Other roles: 4 to 8 digits. */
  function pinRule(roleName) { return roleName === 'owner' ? { re: /^\d{4}$/, msg: 'An owner PIN is exactly 4 digits (it is also the Settings / Expert-mode PIN).' } : { re: /^\d{4,8}$/, msg: 'The PIN must be 4 to 8 digits.' }; }
  function validPin(p, roleName) { return pinRule(roleName || 'dispatcher').re.test(String(p || '')); }
  /* settings.adminPin belongs to the owner record that mirrors it (the migrated owner, or the only active owner — see mirrorsAdminPin):
     that record has a PIN even before its hash is written (async at boot, see adoptLegacyPin) or when it was recreated after a reset. */
  function legacyFor(rec) { return rec && rec.role === 'owner' && mirrorsAdminPin(rec) ? legacyPin() : ''; }
  function hasPin(rec) { return !!(rec && (rec.hash || legacyFor(rec))); }
  function needsPin(roleName) { return roleName === 'owner' || roleName === 'bookkeeper'; }   // money and exports: never a name-only sign-in
  function anyOwnerPin() { return owners().some(hasPin); }
  /* A name-only ("nopin") sign-in is allowed for a dispatcher record, and for an owner record only while no owner has a PIN
     yet (fresh station — the same rule ownerPinOK uses, so the first owner is not locked out before setting a PIN). */
  function nopinAllowed(rec) { if (!rec || hasPin(rec)) return false; if (rec.role === 'dispatcher') return true; if (rec.role === 'owner') return !anyOwnerPin(); return false; }
  /* Who counts as the owner at this station right now: a signed-in owner, or nobody signed in on a station where no owner PIN exists yet. */
  function ownerHere() { return session ? session.role === 'owner' : !anyOwnerPin(); }

  /* verifyPin(rec, pin) → Promise<boolean>. Hashed record first; a record migrated from settings.adminPin that has
     no hash yet (crypto missing, or the hash is still being written) falls back to that legacy PIN. */
  function verifyPin(rec, pin) {
    pin = String(pin == null ? '' : pin).trim();
    if (!rec || !pin) return Promise.resolve(false);
    if (rec.hash && rec.salt && cryptoReady()) return hashPin(pin, rec.salt, rec.iter || PBKDF2_ITER).then(function (h) { return ctEqual(h, rec.hash); }).catch(function () { return false; });
    var lp = legacyFor(rec); if (lp) return Promise.resolve(ctEqual(pin, lp));
    return Promise.resolve(false);
  }
  function setPin(rec, pin) {
    if (!validPin(pin, rec && rec.role)) return Promise.reject(new Error(pinRule(rec && rec.role).msg));
    if (!cryptoReady()) return Promise.reject(new Error('This browser has no WebCrypto — PINs cannot be stored safely here.'));
    var salt = b64(randomBytes(16)), iter = sec().pbkdf2Iterations || PBKDF2_ITER;
    return hashPin(pin, salt, iter).then(function (h) { rec.salt = salt; rec.hash = h; rec.iter = iter; rec.pinSetAt = nowISO(); return true; });
  }
  function signInAs(rec, via) {
    session = { staffId: rec.id, name: rec.name, role: rec.role, at: nowISO(), via: via || 'pin' };
    storeSession(); log('signin', { ref: rec.name, via: via || 'pin' }); renderWho(); return current();
  }
  /* signIn(staffId, pin) → Promise<{ok, reason?, who?}> */
  function signIn(staffId, pin) {
    var rec = staffById(staffId);
    if (!rec || rec.active === false) return Promise.resolve({ ok: false, reason: 'unknown' });
    if (!hasPin(rec)) {                                   // no PIN on record yet
      if (nopinAllowed(rec)) return Promise.resolve({ ok: true, who: signInAs(rec, 'nopin') });   // dispatcher, or the first owner before any PIN exists
      log('signin-failed', { ref: rec.name, why: 'no PIN on record' });
      return Promise.resolve({ ok: false, reason: 'nopin' });
    }
    return verifyPin(rec, pin).then(function (ok) {
      if (!ok) { log('signin-failed', { ref: rec.name }); return { ok: false, reason: 'pin' }; }
      return { ok: true, who: signInAs(rec, 'pin') };
    });
  }
  function signOut() { if (!session) return; var n = session.name; session = null; storeSession(); log('signout', { ref: n }); renderWho(); }

  /* ---------- permissions ---------- */
  var PERMS = {
    'tlc.export': ['owner', 'bookkeeper'],
    'trips.export': ['owner'],         // the trips CSV is a customer list
    'backup': ['owner'], 'restore': ['owner'], 'reset': ['owner'],
    'settlement': ['owner'], 'rates': ['owner'], 'staff': ['owner'], 'settings': ['owner'],
    'settings.open': ['owner', 'bookkeeper'],   // open Settings in Simple mode without simple.js's PIN prompt (the audit viewer lives there)
    'secrets': ['owner'],                        // see or type the Settings PIN and the Google / LocationIQ keys (#s_pin, #s_gmapkey, #s_geokey)
    'audit.view': ['owner', 'bookkeeper'], 'audit.export': ['owner', 'bookkeeper'],
    'outage.print': ['owner', 'dispatcher', 'bookkeeper']
  };
  var WHAT = { 'tlc.export': 'export the TLC file', 'trips.export': 'export the trips list', 'backup': 'make a backup', 'restore': 'restore a backup', 'reset': 'reset all data', 'settlement': 'run settlements', 'rates': 'change rates', 'staff': 'change staff or the PIN', 'settings': 'change company settings', 'secrets': 'see or change the PIN and the map keys', 'audit.view': 'see the activity log', 'audit.export': 'export the activity log' };
  function can(perm, r) { var allow = PERMS[perm]; if (!allow) return true; return allow.indexOf(r || role()) >= 0; }
  /* gate(perm) → 'allow' | 'deny' | 'ask'  (sync decision for capture-phase listeners) */
  function gate(perm) {
    if (can(perm, role())) return 'allow';
    if (session) return 'deny';
    return owners().length ? 'ask' : 'deny';
  }
  function denyToast(perm) {
    var w = WHAT[perm] || perm;
    if (session) toast('Signed in as ' + session.name + ' (' + session.role + ') — only the owner can ' + w + '. Ask the owner to sign in.', true);
    else toast('Only the owner can ' + w + ' — no owner record exists yet. Open Settings → Staff & access.', true);
    log('denied', { ref: perm });
  }
  var noPinHinted = false;
  /* ownerPinOK(what) → Promise<boolean>: the owner-PIN prompt the other modules use, checked against every owner's
     hashed PIN (and the legacy settings.adminPin). Success signs that owner in for the session. */
  function ownerPinOK(what) {
    var list = owners();
    if (!list.length) { toast('No owner record exists yet. Open Settings → Staff & access.', true); return Promise.resolve(false); }
    var withPin = list.filter(hasPin);
    if (!withPin.length) {   // fresh station, no PIN ever set: same as ledger.js — allow with a hint, so the owner is not locked out before setting one
      if (!noPinHinted) { noPinHinted = true; toast('No owner PIN is set — set one in Settings → Staff, access & activity so exports, backups and settlements stay owner-only.', true); }
      signInAs(list[0], 'nopin'); return Promise.resolve(true);
    }
    list = withPin;
    var a = ask('Owner PIN to ' + (what || 'continue') + ':', '');
    if (a === null) return Promise.resolve(false);
    var pin = String(a).trim(), i = 0;
    function next() {
      if (i >= list.length) { toast('Wrong PIN.', true); log('signin-failed', { ref: 'owner-pin', what: what || '' }); return false; }
      var rec = list[i++];
      return verifyPin(rec, pin).then(function (ok) { if (ok) { signInAs(rec, 'pin'); return true; } return next(); });
    }
    return Promise.resolve().then(next);
  }
  /* allowed(perm) → Promise<boolean>: allow / deny / owner-PIN prompt */
  function allowed(perm) {
    var g = gate(perm);
    if (g === 'allow') return Promise.resolve(true);
    if (g === 'deny') { denyToast(perm); return Promise.resolve(false); }
    return ownerPinOK(WHAT[perm] || perm);
  }

  /* ---------- audit ring buffer ---------- */
  function log(what, detail) {
    try {
      var d = Object.assign({}, detail || {}), ref = d.ref || ''; delete d.ref;
      var row = { at: nowISO(), by: who() || '', role: role(), what: String(what || ''), ref: String(ref || ''), detail: d };
      var A = audit(); A.push(row);
      if (A.length > AUDIT_MAX) A.splice(0, A.length - AUDIT_MAX);
      if (what !== 'signin' && what !== 'signout' && what !== 'denied' && what !== 'signin-failed') save(); else if (typeof window.save === 'function') { try { window.save(); } catch (e) {} }
      return row;
    } catch (e) { return null; }
  }
  function auditRows(filter) {
    var rows = audit().slice().reverse();
    if (filter && filter.what) rows = rows.filter(function (r) { return r.what === filter.what; });
    if (filter && filter.by) rows = rows.filter(function (r) { return r.by === filter.by; });
    if (filter && filter.limit) rows = rows.slice(0, filter.limit);
    return rows;
  }
  function detailText(d) { if (!d || typeof d !== 'object') return ''; return Object.keys(d).map(function (k) { var v = d[k]; if (v == null || v === '') return ''; return k + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v)); }).filter(Boolean).join(' '); }
  function auditCSV() {
    var lines = ['when,who,role,what,ref,detail'];
    audit().forEach(function (r) { lines.push([r.at, r.by, r.role, r.what, r.ref, detailText(r.detail)].map(csvCell).join(',')); });
    return lines.join('\r\n');
  }
  function exportAudit() {
    return allowed('audit.export').then(function (ok) {
      if (!ok) return false;
      var name = 'skyway-activity-' + todayStr() + '.csv', n = audit().length;
      download(name, auditCSV(), 'text/csv');
      recordExport({ kind: 'audit', rows: n, file: name });
      log('export', { ref: 'audit', rows: n, file: name });
      toast('Activity log exported (' + n + ' events).'); renderStaffPanel();
      return true;
    });
  }
  function recordExport(x) {
    var E = exportsLog();
    E.push(Object.assign({ at: nowISO(), by: who() || '' }, x));
    if (E.length > EXPORTS_MAX) E.splice(0, E.length - EXPORTS_MAX);
  }

  /* ---------- wrappers that write the audit ---------- */
/* keep the inner wrappers' marker flags (e.g. __fixesWrapped) visible on the outermost function */
  function inheritFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_{1,2}\w*Wrapped$/.test(k) && w[k] === undefined) w[k] = orig[k]; }); } catch (e) {} return w; }
  function hook(name, before, after) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__recoverWrapped) return;
    var wrapped = function () {
      var args = Array.prototype.slice.call(arguments), self = this, pre = null;
      try { pre = before ? before.apply(null, args) : null; } catch (e) { pre = null; }
      var out = orig.apply(self, args);
      try { after(pre, args, out); } catch (e) { try { console.error('[recover]', e); } catch (e2) {} }
      return out;
    };
    wrapped.__recoverWrapped = true; wrapped._orig = orig; inheritFlags(wrapped, orig);
    window[name] = wrapped;
  }
  function snapTrip(id) { var t = findTrip(id); if (!t) return null; return { id: t.id, no: t.dispatchNo, driverId: t.driverId || '', status: t.status || '', ovAt: (t.eligibility && t.eligibility.override && t.eligibility.override.at) || '' }; }
  function afterTrip(pre, kind) {
    if (!pre) return;
    var t = findTrip(pre.id);
    if (!t) { if (kind === 'delete') log('delete', { ref: '#' + pre.no, status: pre.status }); return; }
    if ((t.driverId || '') !== pre.driverId) { var d = findDriver(t.driverId); log(t.driverId ? 'assign' : 'unassign', { ref: '#' + t.dispatchNo, driver: d ? d.name : (t.driverId || ''), how: kind }); }
    if ((t.status || '') !== pre.status) { var w = t.status === 'Canceled' ? 'cancel' : t.status === 'No-Show' ? 'noshow' : t.status === 'Completed' ? 'complete' : t.status === 'Dispatched' ? 'dispatch' : t.status === 'Booked' ? 'reinstate' : 'status'; log(w, { ref: '#' + t.dispatchNo, from: pre.status, to: t.status }); }
    var ov = t.eligibility && t.eligibility.override;
    if (ov && (ov.at || '') !== pre.ovAt) log('override', { ref: '#' + t.dispatchNo, by: ov.by || '', why: ov.why || '' });
  }
  /* Whole-board snapshot for paths that may touch several trips at once (Simple mode's Undo restores stored copies directly) */
  function snapAll() { return trips().filter(function (t) { return t && !t._hist; }).map(function (t) { return snapTrip(t); }).filter(Boolean); }
  function afterAll(pre, kind) { (pre || []).forEach(function (p) { afterTrip(p, kind); }); }
  function hookTrips() {
    [['assignDriver', 'board'], ['bestAssign', 'best'], ['diqAssign', 'driveriq'], ['optAssignOne', 'optimizer']].forEach(function (p) {
      hook(p[0], function (id) { return snapTrip(id); }, function (pre) { afterTrip(pre, p[1]); });
    });
    ['cancelTrip', 'noShowTrip', 'cycleStatus', 'reinstateTrip'].forEach(function (n) { hook(n, function (id) { return snapTrip(id); }, function (pre) { afterTrip(pre, n); }); });
    hook('deleteTrip', function (id) { return snapTrip(id); }, function (pre) { afterTrip(pre, 'delete'); });
    // Board edit overlay (Save → saveEditOvl(), inline onclick): the trip being edited is the console's top-level `let editOvlId`
    hook('saveEditOvl', function () { var id = null; try { if (typeof editOvlId !== 'undefined') id = editOvlId; } catch (e) { id = null; } return snapTrip(id); }, function (pre) { afterTrip(pre, 'edit-overlay'); });
    // Classic layout: Drop writes status Completed + dropTime directly (no cycleStatus); the selected job is the console's top-level `let classicSelId`
    hook('classicDrop', function () { var id = null; try { if (typeof classicSelId !== 'undefined') id = classicSelId; } catch (e) { id = null; } return snapTrip(id); }, function (pre) { afterTrip(pre, 'classic-drop'); });
    hook('optApplyAll', function () { return trips().map(function (t) { return { id: t.id, no: t.dispatchNo, driverId: t.driverId || '' }; }); }, function (pre) {
      var n = 0, nos = [];
      (pre || []).forEach(function (p) { var t = findTrip(p.id); if (t && (t.driverId || '') !== p.driverId) { n++; if (nos.length < 20) nos.push('#' + t.dispatchNo); } });
      if (n) log('assign', { ref: 'optimizer', count: n, trips: nos.join(' '), how: 'optApplyAll' });
    });
  }
  function hookLedger() {
    var L = window.Ledger; if (!L || L.__recoverWrapped) return;
    function wrapL(name, label) {
      var orig = L[name]; if (typeof orig !== 'function') return;
      L[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        var refused = name === 'settle' ? { ok: false, reason: 'role' } : (name === 'refund' ? null : false);
        if (session && !can('settlement', role())) { denyToast('settlement'); return refused; }
        /* Nobody signed in: Ledger's own gate asks for settings.adminPin, and runs with nobody when that is empty. When an owner
           has a PIN on a staff record but settings.adminPin is not set (cleared in Settings, or synced from a station that had
           no legacy PIN), that gate is open — refuse here instead. A hashed PIN cannot be checked inside this synchronous call,
           so the owner signs in first (Settings → Staff, access & activity) and runs it again. A station with no owner PIN at
           all keeps Ledger's own behaviour (allowed with a hint, so the first owner is not locked out). */
        if (!session && !can('settlement', role()) && anyOwnerPin() && !legacyPin()) {
          toast('Only the owner can ' + WHAT.settlement + ' — sign in as the owner first (Settings → Staff, access & activity), then run it again.', true);
          log('denied', { ref: 'settlement', why: 'not signed in' });
          return refused;
        }
        var out = orig.apply(this, args);
        try {
          var ok = out && (out.ok === true || out === true || (typeof out === 'object' && out.id));
          if (ok) log('settlement', { ref: label, args: args.slice(0, 3).map(function (a) { return typeof a === 'object' ? '' : String(a); }).join(' ') });
        } catch (e) {}
        return out;
      };
      L[name]._orig = orig;
    }
    wrapL('settle', 'settle'); wrapL('markPaid', 'markPaid'); wrapL('refund', 'refund');
    L.__recoverWrapped = true;
  }

  /* ---------- TLC export lint ---------- */
  function tlcRange() { var f = byId('tlc_from'), t = byId('tlc_to'); return { from: (f && f.value) || '', to: (t && t.value) || '' }; }
  function isAsap(v) { v = String(v || '').trim(); return !v || /asap|now/i.test(v); }
  function mil(v) { if (typeof window.mil === 'function') { try { return window.mil(v); } catch (e) {} } return String(v || '').trim(); }
  /* Pickup time for the TLC row: the booked time; an ASAP job uses the time the driver was sent (dispTime) — recorded data,
     not a guess. Nothing is ever substituted for the DROP-OFF time. */
  function pickupTimeOf(t) {
    var v = isAsap(t.time) ? (t.dispTime || '') : mil(t.time);
    return /^\d{1,2}:\d{2}/.test(String(v || '')) ? v : '';
  }
  function inRange(t, from, to) { return (!from || t.date >= from) && (!to || t.date <= to); }
  function sortByWhen(a, b) { return a.date === b.date ? ((a.time || '') < (b.time || '') ? -1 : 1) : (a.date < b.date ? -1 : 1); }
  /* tlcLint(from, to) → {clean:[{t,drv,veh}], bad:[{t,drv,veh,problems[]}], skipped:{status:n}, completed:n, header:{ok, expected, stored}} */
  function tlcLint(from, to) {
    var clean = [], bad = [], skipped = {}, completed = 0, asap = 0;
    trips().filter(function (t) { return t && !t._hist && inRange(t, from, to); }).sort(sortByWhen).forEach(function (t) {
      if (t.status !== 'Completed') { var k = t.status || 'blank'; skipped[k] = (skipped[k] || 0) + 1; return; }
      completed++;
      if (isAsap(t.time) && t.dispTime) asap++;
      var drv = findDriver(t.driverId), veh = findVehicle(t.vehicleId), problems = [];
      if (!drv) problems.push('no driver'); else if (!String(drv.tlc || '').trim()) problems.push('driver has no TLC licence #');
      if (!veh) problems.push('no vehicle'); else if (!String(veh.plate || '').trim()) problems.push('vehicle has no plate');
      if (!isDate(t.date)) problems.push('no pickup date');
      if (!pickupTimeOf(t)) problems.push(isAsap(t.time) ? 'no pickup time (ASAP, never dispatched)' : 'no pickup time');
      if (!String(t.dropTime || '').trim()) problems.push('no drop-off time');
      if (!String(t.puAddr || '').trim()) problems.push('no pickup address');
      if (!String(t.doAddr || '').trim()) problems.push('no drop-off address');
      (problems.length ? bad : clean).push({ t: t, drv: drv, veh: veh, problems: problems });
    });
    var stored = String(sec().tlcHeader || '').trim();
    return { clean: clean, bad: bad, skipped: skipped, completed: completed, asap: asap, header: { ok: stored === TLC_HEAD.join(','), expected: TLC_HEAD.join(','), stored: stored } };
  }
  function g(name) { return typeof window[name] === 'function' ? window[name] : null; }
  function tlcDate(s) { var f = g('tlcDate'); if (f) return f(s); if (!s) return ''; var p = String(s).split('-'); return p.length === 3 ? (+p[1]) + '/' + (+p[2]) + '/' + p[0] : s; }
  function tlcTime(t) { var f = g('tlcTime'); if (f) return f(t); if (!t) return ''; var p = String(t).split(':'); p[0] = String(+p[0]); return p.join(':'); }
  function tlcLocType(a) { var f = g('tlcLocType'); return f ? f(a) : 'Exact Address'; }
  function tlcLocName(a) { var f = g('tlcLocName'); return f ? f(a) : String(a || '').toUpperCase(); }
  function ymd(s) { var f = g('ymd'); return f ? f(s) : String(s || '').replace(/-/g, ''); }
  /* tlcBuild(rows, coords) → CSV text. Drop-off time is written as recorded; it is never the pickup time. */
  function tlcBuild(rows, coords) {
    var base = settings().base || '', lines = [TLC_HEAD.join(',')];
    rows.forEach(function (r) {
      var t = r.t, drv = r.drv, veh = r.veh, puLon = '', puLat = '', doLon = '', doLat = '';
      if (coords === 'fill' && STATE.geocache && g('normalizeAddr')) {
        var pc = STATE.geocache[window.normalizeAddr(t.puAddr)], dc = STATE.geocache[window.normalizeAddr(t.doAddr)];
        if (pc) { puLon = pc.lng; puLat = pc.lat; } if (dc) { doLon = dc.lng; doLat = dc.lat; }
      }
      var aff = t.partnerBaseLicence ? String(t.partnerBaseLicence).toUpperCase() : base;   // ops.js overflow: the trip ran under the partner base
      var row = [base, tlcDate(t.date), tlcTime(pickupTimeOf(t)), (drv && drv.tlc) || '', (veh && veh.plate) || '', aff,
        tlcLocType(t.puAddr), tlcLocName(t.puAddr), puLon, puLat,
        tlcDate(t.dropDate || t.date), tlcTime(t.dropTime), tlcLocType(t.doAddr), tlcLocName(t.doAddr), doLon, doLat];
      lines.push(row.map(csvCell).join(','));
    });
    return lines.join('\r\n');
  }
  function tlcFileName(from, to) { return (settings().base || 'BASE').toLowerCase() + '_' + ymd(from) + '-' + ymd(to) + '.csv'; }
  function skippedText(sk) { var ks = Object.keys(sk); if (!ks.length) return ''; return ks.map(function (k) { return sk[k] + ' ' + k; }).join(', '); }
  /* The pre-export checklist (or the refusal) rendered into #tlc_summary */
  function tlcChecklist(from, to) {
    var host = byId('tlc_summary'); var L = tlcLint(from, to);
    var h = '<div class="rc-tlc" id="rc_tlc">';
    if (L.bad.length) {
      h += '<div class="notice" style="margin:0 0 8px;background:#fde8e6;border-color:#c0392b;"><b>Export refused.</b> ' + L.bad.length + ' completed trip' + (L.bad.length === 1 ? '' : 's') + ' in this range ' + (L.bad.length === 1 ? 'is' : 'are') + ' missing a required field. Fix them (Fleet for licence / plate, the trip for times), then press Download CSV again. Nothing was downloaded.</div>';
      h += '<div class="tbl-scroll" style="max-height:300px;"><table class="data" id="rc_tlc_bad"><thead><tr><th>#</th><th>Date</th><th>Pickup</th><th>Drop-off</th><th>Driver</th><th>Plate</th><th>Missing</th><th></th></tr></thead><tbody>';
      L.bad.forEach(function (r) {
        var t = r.t;
        h += '<tr data-trip="' + esc(t.id) + '"><td>' + esc(t.dispatchNo || '') + '</td><td>' + esc(t.date || '') + '</td><td>' + esc(t.time || '—') + '</td><td>' + esc(t.dropTime || '—') + '</td><td>' + esc(r.drv ? (r.drv.name + (r.drv.tlc ? ' · ' + r.drv.tlc : '')) : '—') + '</td><td>' + esc(r.veh ? (r.veh.plate || '—') : '—') + '</td><td><b style="color:#a4161a;">' + esc(r.problems.join('; ')) + '</b></td><td><button class="btn btn-ghost btn-sm" type="button" data-act="open" data-id="' + esc(t.id) + '">Open trip</button></td></tr>';
      });
      h += '</tbody></table></div>';
    } else if (!L.completed) {
      h += '<div class="notice" style="margin:0;">No completed trips between ' + esc(from || 'start') + ' and ' + esc(to || 'today') + '. Only Completed trips go in the TLC file' + (skippedText(L.skipped) ? ' (left out: ' + esc(skippedText(L.skipped)) + ')' : '') + '.</div>';
    } else {
      h += '<div class="notice" style="margin:0 0 8px;"><b>Ready to export.</b> Check the list, then press Download.</div>';
      h += '<ul class="rc-check" style="margin:0 0 8px 18px;padding:0;line-height:1.6;">'
        + '<li>Rows in the file: <b id="rc_tlc_count">' + L.clean.length + '</b> = completed trips with driver licence, plate, pickup and drop-off time (' + L.completed + ' completed in range).</li>'
        + '<li>Left out: ' + (skippedText(L.skipped) ? esc(skippedText(L.skipped)) : 'nothing else in this range') + '. Booked, Dispatched, Canceled and No-Show trips are never filed.</li>'
        + (L.asap ? '<li>' + L.asap + ' ASAP pickup' + (L.asap === 1 ? '' : 's') + ' use the time the driver was sent as the pickup time.</li>' : '')
        + '<li>Drop-off time is written as recorded — never the pickup time.</li>'
        + '<li>Header: ' + (L.header.ok ? '16 columns match the stored spec.' : '<b style="color:#a4161a;">differs from the stored spec</b> — Settings → Staff, access &amp; activity → TLC header.') + '</li>'
        + '<li>File: <span class="mono">' + esc(tlcFileName(from, to)) + '</span> · base ' + esc(settings().base || '—') + ' · by ' + esc(who() || role()) + '</li></ul>';
      h += '<button class="btn btn-go" type="button" data-act="download" data-from="' + esc(from) + '" data-to="' + esc(to) + '">Download ' + L.clean.length + ' row' + (L.clean.length === 1 ? '' : 's') + '</button>';
    }
    var hist = exportsLog().filter(function (x) { return x.kind === 'tlc'; }).slice(-5).reverse();
    if (hist.length) h += '<div class="hint" style="margin:8px 0 0;">Last exports: ' + hist.map(function (x) { return esc(fmtWhen(x.at)) + ' · ' + esc(x.month || '') + ' · ' + x.rows + ' rows · ' + esc(x.by || 'owner PIN'); }).join(' &middot; ') + '</div>';
    h += '</div>';
    if (host) { host.innerHTML = h; if (!host.__rcWired) { host.__rcWired = true; host.addEventListener('click', onTlcClick); } }
    return L;
  }
  function onTlcClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-act');
    if (a === 'open') { var f = g('editTrip'); if (f) f(b.getAttribute('data-id')); }
    else if (a === 'download') {
      // the checklist may be stale (the owner opened it, then signed out): the Download button is gated like the export button itself
      var from = b.getAttribute('data-from'), to = b.getAttribute('data-to');
      allowed('tlc.export').then(function (ok) { if (ok) tlcDownload(from, to); });
    }
  }
  /* tlcDownload(from, to) — lints again, refuses on any bad row, writes the file, records the export. Returns {ok, rows, bad, file} */
  function tlcDownload(from, to, opts) {
    opts = opts || {};
    var L = tlcLint(from, to);
    if (L.bad.length) { if (!opts.quiet) { tlcChecklist(from, to); toast('Export refused — ' + L.bad.length + ' trip(s) are missing a plate, licence or drop-off time.', true); } return { ok: false, rows: 0, bad: L.bad.length, reason: 'incomplete' }; }
    if (!L.clean.length) { if (!opts.quiet) toast('No completed trips in that range.', true); return { ok: false, rows: 0, bad: 0, reason: 'empty' }; }
    var coordsEl = byId('tlc_coords'), coords = opts.coords || (coordsEl && coordsEl.value) || 'blank';
    var text = tlcBuild(L.clean, coords), name = tlcFileName(from, to);
    if (!opts.dryRun) download(name, text, 'text/csv');
    recordExport({ kind: 'tlc', month: String(from || to || todayStr()).slice(0, 7), from: from, to: to, rows: L.clean.length, file: name, headerOk: L.header.ok });
    log('export', { ref: 'tlc', rows: L.clean.length, from: from, to: to, file: name });
    if (!opts.quiet) {
      tlcChecklist(from, to);
      var host = byId('tlc_summary');
      if (host) host.insertAdjacentHTML('afterbegin', '<div class="notice" style="margin:0 0 8px;">Exported <b>' + L.clean.length + '</b> completed trips as <span class="mono">' + esc(name) + '</span>. Verify the column order against the current TLC spec before uploading.</div>');
      toast('TLC file downloaded — ' + L.clean.length + ' rows.');
    }
    return { ok: true, rows: L.clean.length, bad: 0, file: name, csv: text };
  }
  /* Recover.tlcExport(from, to, {download:true}) — the whole flow without the button */
  function tlcExport(from, to, opts) {
    opts = opts || {}; from = from || tlcRange().from; to = to || tlcRange().to;
    return allowed('tlc.export').then(function (ok) {
      if (!ok) return { ok: false, reason: 'role' };
      if (opts.download) return tlcDownload(from, to, opts);
      var L = tlcChecklist(from, to);
      return { ok: !L.bad.length, rows: L.clean.length, bad: L.bad.length, completed: L.completed, checklist: true };
    });
  }

  /* ---------- backup bundle ---------- */
  var FORMAT = 'skyway-backup-enc', KEY_FORMAT = 'skyway-backup-key', STORAGE_KEY = 'skyway_dispatch_v2';
  var SIDE_KEYS = ['skyway_callerbook', 'skyway_routebook', 'skyway_histseed', 'skyway_webseen', 'skyway_help_seen'];
  function counts(st) {
    st = st || STATE; var T = Array.isArray(st.trips) ? st.trips : [], nos = T.map(function (t) { return Number(t.dispatchNo) || 0; }).filter(Boolean), fares = 0, done = 0;
    T.forEach(function (t) { if (t.status === 'Completed') { done++; fares += Number(t.fare) || 0; } });
    return {
      trips: T.length, completed: done, drivers: (st.drivers || []).length, vehicles: (st.vehicles || []).length, accounts: (st.accounts || []).length,
      invoices: (st.invoices || []).length, staff: (st.staff || []).length, audit: (st.audit || []).length,
      fareTotal: Math.round(fares * 100) / 100, firstDispatchNo: nos.length ? Math.min.apply(null, nos) : 0, lastDispatchNo: nos.length ? Math.max.apply(null, nos) : 0
    };
  }
  /* What the clear header of an encrypted file may say: record counts only. Fare totals, job numbers and names stay inside the ciphertext. */
  var PUBLIC_COUNT_KEYS = ['trips', 'completed', 'drivers', 'vehicles', 'accounts', 'invoices', 'staff', 'audit'];
  function publicCounts(c) { var o = {}; PUBLIC_COUNT_KEYS.forEach(function (k) { o[k] = Number(c[k]) || 0; }); return o; }
  function bundle(opts) {
    opts = opts || {};
    var st = JSON.parse(JSON.stringify(STATE));
    if (!opts.includeKeys && st.settings) { st.settings.gmapkey = ''; st.settings.geokey = ''; }
    var side = {};
    SIDE_KEYS.forEach(function (k) { try { var v = localStorage.getItem(k); if (v != null) side[k] = v; } catch (e) {} });
    return { kind: 'skyway-bundle', version: 1, schema: SCHEMA, storageKey: STORAGE_KEY, createdAt: nowISO(), by: who() || '', counts: counts(st), keysIncluded: !!opts.includeKeys, state: st, side: side };
  }
  /* encryptBackup(passphrase, opts) → Promise<{env, json, name, rawKey, keyFile}> */
  function encryptBackup(passphrase, opts) {
    if (!cryptoReady()) return Promise.reject(new Error('This browser has no WebCrypto; use the plain backup.'));
    passphrase = String(passphrase || '');
    if (passphrase.length < 8) return Promise.reject(new Error('The passphrase needs at least 8 characters.'));
    var b = bundle(opts), plain = JSON.stringify(b), salt = randomBytes(16), iv = randomBytes(12), iter = sec().pbkdf2Iterations || PBKDF2_ITER, key;
    return sha256Hex(plain).then(function (sum) {
      return deriveAesKey(passphrase, salt, iter).then(function (k) { key = k; return subtle.encrypt({ name: 'AES-GCM', iv: iv, tagLength: 128 }, key, utf8(plain)); }).then(function (ct) {
        return subtle.exportKey('raw', key).then(function (raw) {
          var env = { format: FORMAT, version: 1, app: 'Skyway Dispatch Console', schema: SCHEMA, storageKey: STORAGE_KEY, createdAt: b.createdAt, counts: publicCounts(b.counts), keysIncluded: b.keysIncluded,
            kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: iter, salt: b64(salt) }, cipher: { name: 'AES-GCM', iv: b64(iv), tagLength: 128 }, checksum: { alg: 'SHA-256', hex: sum, bytes: utf8(plain).length }, data: b64(ct) };
          var name = 'skyway-backup-' + todayStr() + '.skyenc', rawKey = b64(raw);
          var keyFile = { format: KEY_FORMAT, version: 1, createdAt: b.createdAt, forBackup: name, checksum: sum, key: rawKey, note: 'Recovery key for one Skyway backup. Anyone holding this file and the backup can read every record in it. Keep it apart from the backup.' };
          return { env: env, json: JSON.stringify(env), name: name, rawKey: rawKey, keyFile: keyFile, counts: b.counts };
        });
      });
    });
  }
  /* openBackup(text, {passphrase | rawKey}) → Promise<{bundle, env?, encrypted, checksumOk}> — accepts .skyenc, a bundle, or a legacy plain STATE .json */
  function openBackup(text, opts) {
    opts = opts || {};
    var data; try { data = JSON.parse(String(text)); } catch (e) { return Promise.reject(new Error('That file is not a Skyway backup (not valid JSON).')); }
    if (data && data.format === KEY_FORMAT) return Promise.reject(new Error('That is a recovery KEY file, not a backup. Choose it under "Use a recovery key", then pick the backup.'));
    if (data && data.format === FORMAT) {
      if (!cryptoReady()) return Promise.reject(new Error('This browser has no WebCrypto and cannot open an encrypted backup.'));
      var keyP;
      if (opts.rawKey) keyP = importRawKey(opts.rawKey);
      else if (opts.passphrase != null) keyP = deriveAesKey(String(opts.passphrase), unb64(data.kdf.salt), Number(data.kdf.iterations) || PBKDF2_ITER);
      else return Promise.reject(new Error('A passphrase or a recovery key is needed to open this backup.'));
      return keyP.then(function (key) { return subtle.decrypt({ name: 'AES-GCM', iv: unb64(data.cipher.iv), tagLength: data.cipher.tagLength || 128 }, key, unb64(data.data)); })
        .catch(function () { throw new Error('Could not open the backup — wrong passphrase or key, or the file is damaged.'); })
        .then(function (pt) {
          var plain = fromUtf8(pt);
          return sha256Hex(plain).then(function (sum) {
            var ok = !!(data.checksum && ctEqual(sum, data.checksum.hex));
            if (!ok) throw new Error('Checksum mismatch — the backup was altered or damaged after it was written.');
            var b = JSON.parse(plain); validateBundle(b);
            return { bundle: b, env: data, encrypted: true, checksumOk: true };
          });
        });
    }
    if (data && data.kind === 'skyway-bundle') { validateBundle(data); return Promise.resolve({ bundle: data, encrypted: false, checksumOk: null }); }
    if (data && data.trips && data.zones) { var b2 = { kind: 'skyway-bundle', version: 0, schema: SCHEMA, createdAt: '', by: '', counts: counts(data), state: data, side: {}, legacyPlain: true }; return Promise.resolve({ bundle: b2, encrypted: false, checksumOk: null }); }
    return Promise.reject(new Error('That file is not a valid Skyway backup.'));
  }
  function validateBundle(b) { if (!b || b.kind !== 'skyway-bundle' || !b.state || !Array.isArray(b.state.trips) || !b.state.zones) throw new Error('The backup is missing its trips or zones — not a valid Skyway backup.'); }
  /* restoreTest(bundle) → report {fileCounts, liveCounts, diff:[{key, file, live, delta}], equal, migrated:boolean, createdAt, by} — never touches STATE */
  function restoreTest(b) {
    validateBundle(b);
    var copy = JSON.parse(JSON.stringify(b.state)), mig = copy, migrated = false;
    try { if (typeof window.migrate === 'function') { mig = window.migrate(copy) || copy; migrated = true; } } catch (e) { mig = copy; }
    var fc = counts(mig), lc = counts(STATE), keys = ['trips', 'completed', 'drivers', 'vehicles', 'accounts', 'invoices', 'staff', 'audit', 'fareTotal', 'firstDispatchNo', 'lastDispatchNo'];
    var diff = keys.map(function (k) { return { key: k, file: fc[k], live: lc[k], delta: Math.round(((fc[k] || 0) - (lc[k] || 0)) * 100) / 100 }; });
    var core = ['trips', 'drivers', 'vehicles', 'accounts'];
    var equal = core.every(function (k) { return fc[k] === lc[k]; });
    var c = sec(); c.lastRestoreTestAt = nowISO(); c.lastRestoreMatch = equal; save();
    log('restore-test', { ref: b.createdAt ? fmtWhen(b.createdAt) : 'backup', equal: equal, trips: fc.trips, drivers: fc.drivers, accounts: fc.accounts });
    return { fileCounts: fc, liveCounts: lc, diff: diff, equal: equal, migrated: migrated, createdAt: b.createdAt || '', by: b.by || '', side: Object.keys(b.side || {}) };
  }
  /* applyRestore(bundle, {typed}) — replaces the live data. typed must equal 'RESTORE'. */
  function applyRestore(b, opts) {
    opts = opts || {};
    validateBundle(b);
    if (String(opts.typed || '').trim() !== 'RESTORE') { toast('Restore cancelled — type RESTORE to confirm.', true); return false; }
    var before = counts(STATE), byName = who() || '';
    var st = JSON.parse(JSON.stringify(b.state));
    if (opts.keepStaff !== false) {                       // keep this station's staff + activity so the owner stays signed in and the restore is on record
      if (!Array.isArray(st.staff) || !st.staff.length) st.staff = JSON.parse(JSON.stringify(staff()));
      if (!Array.isArray(st.audit)) st.audit = [];
      var mine = audit(); if (st.audit.length < mine.length) st.audit = JSON.parse(JSON.stringify(mine));
      if (!st.settings) st.settings = {};
      var live = sec(), keep = { lastBackupAt: live.lastBackupAt, lastBackupKind: live.lastBackupKind, lastRestoreTestAt: live.lastRestoreTestAt, lastRestoreMatch: live.lastRestoreMatch };   // this station's own backup / restore-test record survives the restore
      st.settings.security = Object.assign({}, JSON.parse(JSON.stringify(live)), st.settings.security || {}, keep);
    }
    try { Object.keys(b.side || {}).forEach(function (k) { if (SIDE_KEYS.indexOf(k) >= 0) localStorage.setItem(k, String(b.side[k])); }); } catch (e) {}
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(st)); } catch (e) { toast('Could not write the restored data — storage may be full.', true); return false; }
    if (typeof window.reloadFromStorage === 'function') window.reloadFromStorage(); else STATE = (typeof window.migrate === 'function' ? window.migrate(st) : st);
    session = loadSession(); if (!session && byName) { var rec = staff().filter(function (s) { return s.name === byName; })[0]; if (rec) session = { staffId: rec.id, name: rec.name, role: rec.role, at: nowISO(), via: 'restore' }; }
    log('restore', { ref: b.createdAt ? fmtWhen(b.createdAt) : 'backup', encrypted: !!opts.encrypted, before: before.trips + ' trips', after: counts(STATE).trips + ' trips' });
    save();
    try { if (g('applyBrand')) window.applyBrand(); } catch (e) {}
    try { if (g('goTab')) window.goTab('dispatch'); } catch (e) {}
    try { if (g('refreshBoard')) window.refreshBoard(); } catch (e) {}
    renderWho(); renderBackupPanel(); renderStaffPanel();
    toast('Backup restored — ' + counts(STATE).trips + ' trips, ' + counts(STATE).drivers + ' drivers.');
    return true;
  }
  /* Owner flow: encrypted backup with a typed passphrase; offers the recovery-key file afterwards */
  function doEncryptedBackup(opts) {
    opts = opts || {};
    return allowed('backup').then(function (ok) {
      if (!ok) return false;
      if (!cryptoReady()) { toast('This browser has no WebCrypto. Use the plain backup (owner only).', true); return false; }
      var p1 = opts.passphrase != null ? String(opts.passphrase) : ask('Passphrase for this backup (8+ characters). It is NOT stored anywhere — write it down. Without it (or the recovery key file) the backup cannot be opened.', '');
      if (p1 === null) return false;
      if (String(p1).length < 8) { toast('The passphrase needs at least 8 characters.', true); return false; }
      if (opts.passphrase == null) { var p2 = ask('Type the passphrase again:', ''); if (p2 === null) return false; if (p2 !== p1) { toast('The two passphrases differ. Nothing was exported.', true); return false; } }
      var inc = byId('rc_incKeys'); var includeKeys = opts.includeKeys != null ? !!opts.includeKeys : !!(inc && inc.checked);
      return encryptBackup(p1, { includeKeys: includeKeys }).then(function (r) {
        if (!opts.dryRun) download(r.name, r.json, 'application/json');
        var c = sec(); c.lastBackupAt = nowISO(); c.lastBackupKind = 'encrypted'; save();
        recordExport({ kind: 'backup', rows: r.counts.trips, file: r.name, encrypted: true });
        log('backup', { ref: r.name, encrypted: true, trips: r.counts.trips, keys: includeKeys });
        lastBackup = r;
        toast('Encrypted backup downloaded (' + r.counts.trips + ' trips). Keep the passphrase somewhere safe.');
        if (!opts.dryRun && opts.keyFile !== false && confirmBox('Also download the recovery key file for this backup?\n\nIt opens this backup WITHOUT the passphrase, so keep it on a different drive than the backup itself.')) downloadKeyFile();
        renderBackupPanel(); refreshNeedsYouMine();
        return r;
      }).catch(function (err) { toast('Backup failed: ' + ((err && err.message) || err), true); return false; });
    });
  }
  var lastBackup = null;
  function downloadKeyFile() {
    if (!lastBackup) { toast('Make an encrypted backup first — the key belongs to one backup.', true); return false; }
    var name = lastBackup.name.replace(/\.skyenc$/, '') + '-KEY.json';
    download(name, JSON.stringify(lastBackup.keyFile, null, 2), 'application/json');
    log('backup-key', { ref: lastBackup.name }); toast('Recovery key downloaded. Store it apart from the backup.');
    return true;
  }
  /* Plain backup — owner only, with a warning. Replays the console's own b_export handler. */
  function doPlainBackup() {
    return allowed('backup').then(function (ok) {
      if (!ok) return false;
      if (!confirmBox('This plain .json backup is NOT encrypted. It holds every passenger name and phone number' + (settings().gmapkey ? ', your Google key' : '') + ' and every fare.\n\nUse "Encrypted backup" unless you have a reason. Continue with the plain file?')) return false;
      var c = sec(); c.lastBackupAt = nowISO(); c.lastBackupKind = 'plain'; save();
      recordExport({ kind: 'backup', rows: trips().length, file: 'skyway-backup-' + todayStr() + '.json', encrypted: false });
      log('backup', { ref: 'skyway-backup-' + todayStr() + '.json', encrypted: false, trips: trips().length });
      passOnce('b_export'); var b = byId('b_export'); if (b) b.click(); else download('skyway-backup-' + todayStr() + '.json', JSON.stringify(STATE, null, 2), 'application/json');
      renderBackupPanel(); refreshNeedsYouMine();
      return true;
    });
  }
  var pendingRawKey = '', pendingRestore = null;
  /* Restore flow from a File: open (asking for the passphrase if needed) → sandbox test → render the diff → owner confirms */
  function restoreFromFile(file, opts) {
    opts = opts || {};
    return allowed('restore').then(function (ok) {
      if (!ok) return false;
      return readFile(file).then(function (text) {
        var head = null; try { head = JSON.parse(text); } catch (e) {}
        var o = {};
        if (head && head.format === FORMAT) {
          if (pendingRawKey) o.rawKey = pendingRawKey;
          else { var p = opts.passphrase != null ? opts.passphrase : ask('Passphrase for this backup (or cancel and load the recovery key file first):', ''); if (p === null) return false; o.passphrase = p; }
        }
        return openBackup(text, o).then(function (r) {
          var rep = restoreTest(r.bundle);
          pendingRestore = { bundle: r.bundle, encrypted: r.encrypted, report: rep, fileName: file && file.name || '' };
          renderRestoreReport(); toast(rep.equal ? 'Restore test: counts match the live data.' : 'Restore test: counts differ from the live data — check the table before restoring.');
          return rep;
        });
      }).catch(function (err) { toast('Restore test failed: ' + ((err && err.message) || err), true); log('restore-failed', { ref: file && file.name || '', why: String((err && err.message) || err) }); return false; });
    });
  }
  function readFile(f) { return new Promise(function (res, rej) { try { var r = new FileReader(); r.onload = function () { res(String(r.result || '')); }; r.onerror = function () { rej(new Error('Could not read the file.')); }; r.readAsText(f); } catch (e) { rej(e); } }); }
  function loadKeyFile(file) {
    return readFile(file).then(function (text) {
      var k = JSON.parse(text); if (!k || k.format !== KEY_FORMAT || !k.key) throw new Error('That is not a Skyway recovery key file.');
      pendingRawKey = String(k.key); toast('Recovery key loaded for ' + (k.forBackup || 'a backup') + '. Now choose the backup file.'); renderBackupPanel(); return true;
    }).catch(function (err) { toast(String((err && err.message) || err), true); return false; });
  }
  function confirmRestore(typed) {
    if (!pendingRestore) { toast('Run a restore test first (choose the backup file).', true); return false; }
    var t = typed != null ? typed : ask('Replace ALL data on this computer with the backup from ' + (pendingRestore.report.createdAt ? fmtWhen(pendingRestore.report.createdAt) : 'the file') + '?\n\nType RESTORE to confirm:', '');
    if (t === null) return false;
    var ok = applyRestore(pendingRestore.bundle, { typed: t, encrypted: pendingRestore.encrypted });
    if (ok) { pendingRestore = null; pendingRawKey = ''; }
    return ok;
  }
  function printRestoreReport() {
    if (!pendingRestore) return false;
    var rep = pendingRestore.report;
    var h = '<div style="max-width:640px;margin:0 auto;font-family:Arial,sans-serif;"><h2 style="margin:4px 0;">' + esc(bizName()) + ' — restore test</h2><div>' + esc(fmtWhen(nowISO())) + ' · by ' + esc(who() || 'owner') + ' · file ' + esc(pendingRestore.fileName || '') + (rep.createdAt ? ' (made ' + esc(fmtWhen(rep.createdAt)) + (rep.by ? ' by ' + esc(rep.by) : '') + ')' : '') + '</div><hr>'
      + '<table style="width:100%;border-collapse:collapse;font-size:14px;"><tr><th style="text-align:left;padding:4px 8px;">Record</th><th style="text-align:right;padding:4px 8px;">In file</th><th style="text-align:right;padding:4px 8px;">Live now</th><th style="text-align:right;padding:4px 8px;">Difference</th></tr>'
      + rep.diff.map(function (d) { return '<tr><td style="padding:3px 8px;">' + esc(d.key) + '</td><td style="text-align:right;padding:3px 8px;">' + esc(d.file) + '</td><td style="text-align:right;padding:3px 8px;">' + esc(d.live) + '</td><td style="text-align:right;padding:3px 8px;' + (d.delta ? 'color:#a4161a;font-weight:700;' : '') + '">' + (d.delta > 0 ? '+' : '') + esc(d.delta) + '</td></tr>'; }).join('')
      + '</table><hr><div><b>' + (rep.equal ? 'Trips, drivers, vehicles and accounts match.' : 'Counts differ — read the table before restoring.') + '</b>' + (rep.migrated ? ' The file passed the console\'s migrate() check.' : '') + '</div></div>';
    return openPrint(h);
  }

  /* ---------- outage sheet ---------- */
  function outageTrips() {
    var td = todayStr(), tm = tomorrowStr();
    return trips().filter(function (t) { return t && !t._hist && (t.date === td || t.date === tm) && (t.status === 'Booked' || t.status === 'Dispatched'); }).sort(sortByWhen);
  }
  function outageHTML() {
    var s = settings(), td = todayStr(), tm = tomorrowStr(), list = outageTrips();
    var td_ = '<td style="border:1px solid #999;padding:4px 6px;vertical-align:top;">', th_ = '<th style="border:1px solid #999;padding:4px 6px;text-align:left;background:#eee;">';
    function tripRows(date) {
      var rows = list.filter(function (t) { return t.date === date; });
      if (!rows.length) return '<tr>' + td_.replace('">', 'text-align:center;color:#666;" colspan="8">') + 'No trips booked.</td></tr>';
      return rows.map(function (t) {
        var d = findDriver(t.driverId), v = findVehicle(t.vehicleId);
        return '<tr>' + td_ + '<b>' + esc(fmtTime12(t.time || '')) + '</b></td>' + td_ + esc(t.dispatchNo || '') + '</td>' + td_ + esc(firstName(t.passenger)) + '</td>' + td_ + esc(fmtPhone(t.phone || '')) + '</td>' + td_ + esc(t.puAddr || '') + (t.stops && t.stops.length ? '<br><i>via ' + esc(t.stops.map(function (x) { return typeof x === 'string' ? x : (x && (x.addr || x.address)) || ''; }).join('; ')) + '</i>' : '') + '</td>' + td_ + esc(t.doAddr || '') + '</td>' + td_ + esc(d ? d.name + (v && v.plate ? ' · ' + v.plate : (d.carNo ? ' · car ' + d.carNo : '')) : '') + (t.status === 'Dispatched' ? '<br><i>dispatched</i>' : '') + '</td>' + td_ + esc(money(t.fare)) + (t.tolls ? ' + tolls' : '') + '<br><span style="font-size:11px;">' + esc(t.payType || '') + (t.pax ? ' · ' + t.pax + ' pax' : '') + (t.vtype ? ' · ' + t.vtype : '') + '</span></td></tr>';
      }).join('');
    }
    var head = '<tr>' + th_ + 'Time</th>' + th_ + '#</th>' + th_ + 'Passenger</th>' + th_ + 'Phone</th>' + th_ + 'Pickup</th>' + th_ + 'Drop-off</th>' + th_ + 'Driver / plate</th>' + th_ + 'Fare</th></tr>';
    var drv = drivers().filter(function (d) { return d.active !== false; }).map(function (d) { var v = vehicles().filter(function (x) { return d.vehicleIds && d.vehicleIds.indexOf(x.id) >= 0; })[0]; return '<tr>' + td_ + esc(d.name) + '</td>' + td_ + esc(fmtPhone(d.phone || '')) + '</td>' + td_ + esc(d.tlc || '') + '</td>' + td_ + esc(v ? v.plate : (d.carNo ? 'car ' + d.carNo : '')) + '</td></tr>'; }).join('') || '<tr>' + td_.replace('">', '" colspan="4">') + 'No active drivers on file.</td></tr>';
    var blank = ''; for (var i = 0; i < 12; i++) blank += '<tr style="height:26px;">' + td_ + '</td>' + td_ + '</td>' + td_ + '</td>' + td_ + '</td>' + td_ + '</td>' + td_ + '</td>' + td_ + '</td>' + td_ + '</td></tr>';
    var consent = (window.Messages && window.Messages.consentSentence) || 'By booking you agree to receive ride updates by text; reply STOP to opt out.';
    return '<div style="font-family:Arial,sans-serif;font-size:12px;color:#111;">'
      + '<h2 style="margin:0 0 2px;">' + esc(s.name || 'Skyway Car Service') + ' — outage sheet</h2>'
      + '<div style="margin-bottom:8px;">Printed ' + esc(fmtWhen(nowISO())) + (who() ? ' by ' + esc(who()) : '') + ' · Office ' + esc(s.phone || '') + ' · Base ' + esc(s.base || '') + '. Run dispatch from this sheet while the computer is down; re-key every change when it is back. Say to each caller: <i>“' + esc(consent) + '”</i></div>'
      + '<h3 style="margin:10px 0 4px;">Today ' + esc(td) + ' — ' + list.filter(function (t) { return t.date === td; }).length + ' trips</h3><table style="width:100%;border-collapse:collapse;">' + head + tripRows(td) + '</table>'
      + '<h3 style="margin:14px 0 4px;">Tomorrow ' + esc(tm) + ' — ' + list.filter(function (t) { return t.date === tm; }).length + ' trips</h3><table style="width:100%;border-collapse:collapse;">' + head + tripRows(tm) + '</table>'
      + '<h3 style="margin:14px 0 4px;">Drivers</h3><table style="width:100%;border-collapse:collapse;"><tr>' + th_ + 'Driver</th>' + th_ + 'Phone</th>' + th_ + 'TLC licence</th>' + th_ + 'Plate / car</th></tr>' + drv + '</table>'
      + '<h3 style="margin:14px 0 4px;page-break-before:always;">New calls (write here, key in later)</h3><table style="width:100%;border-collapse:collapse;">' + head + blank + '</table>'
      + '<div style="margin-top:8px;font-size:11px;color:#444;">Every trip needs, for the TLC file: pickup date and time, driver TLC licence, plate, pickup and drop-off address, drop-off time.</div></div>';
  }
  function printOutageSheet() { var ok = openPrint(outageHTML()); if (ok) { log('print', { ref: 'outage-sheet', trips: outageTrips().length }); toast('Outage sheet ready — press Print / Save as PDF.'); } return ok; }

  /* ---------- capture-phase gates on the console's own buttons ---------- */
  var passFlags = {};
  function passOnce(id) { passFlags[id] = true; }
  function takePass(id) { if (passFlags[id]) { delete passFlags[id]; return true; } return false; }
  /* Book-Trip form (#d_save, anonymous handler in index.html): snapshot in the capture phase, compare in the bubble phase */
  var dsPre = null;
  function snapBookForm() {
    var editing = null; try { if (typeof editingId !== 'undefined') editing = editingId; } catch (e) { editing = null; }
    return { editing: editing, pre: editing ? snapTrip(editing) : null, count: trips().length, top: trips()[0] ? trips()[0].id : '' };
  }
  function afterBookForm(pre) {
    if (!pre) return;
    if (pre.editing) { afterTrip(pre.pre, 'book-form'); return; }
    var t = trips()[0];
    if (!t || trips().length <= pre.count || t.id === pre.top) return;      // nothing was booked (validation toast)
    if (t.driverId) { var d = findDriver(t.driverId); log('assign', { ref: '#' + t.dispatchNo, driver: d ? d.name : t.driverId, how: 'book-form' }); }
  }
  var undoPre = null;
  var SETTINGS_VIEWS = ['settings', 'pricing', 'addrbook', 'estimate'];   // simple.js's Settings section (its VIEW_SECTION map)
  function settingsOpenFree() { return !!(session && can('settings.open', role()) && window.Simple && typeof window.Simple.enter === 'function'); }
  function onCaptureClick(e) {
    var el = e.target && e.target.closest ? e.target.closest('button, input, label') : null; if (!el) return;
    var id = el.id || '';
    if (!id && el.tagName === 'LABEL') return;
    if (id === 'd_save') { dsPre = snapBookForm(); return; }
    if (id === 'undoBtn') { undoPre = snapAll(); return; }          // simple.js's Undo toast (calls its doUndo directly): compare in the bubble phase
    // a masked secret field (#s_pin / Google keys) for someone who is not the owner: ask for the owner PIN instead of showing it
    if (el.tagName === 'INPUT' && SECRET_IDS.indexOf(id) >= 0 && el.__rcMasked) {
      e.preventDefault();
      allowed('secrets').then(function (ok) { if (ok) { maskSecrets(); try { el.focus(); } catch (e2) {} } });
      return;
    }
    // Simple mode: a staff member who already proved who they are (owner / bookkeeper PIN) is not asked for simple.js's Settings PIN again —
    // the Settings bar button, the Settings sub-buttons (Settings / Rates & zones / Address book / Fare estimate) and Alt+6 all go through Simple.enter
    if (el.classList.contains('sb-btn') && el.getAttribute('data-section') === 'settings' && settingsOpenFree()) {
      e.stopImmediatePropagation(); e.preventDefault(); window.Simple.enter('settings'); return;
    }
    if (el.classList.contains('sb-subbtn') && SETTINGS_VIEWS.indexOf(el.getAttribute('data-view') || '') >= 0 && settingsOpenFree()) {
      var sub = byId('simpleSub');
      if (sub && sub.getAttribute('data-sec') === 'settings') { e.stopImmediatePropagation(); e.preventDefault(); window.Simple.enter('settings', el.getAttribute('data-view')); return; }
    }
    if (id === 'sbExpert' && session && role() === 'owner' && window.Simple && typeof window.Simple.setExpert === 'function') {
      e.stopImmediatePropagation(); e.preventDefault(); window.Simple.setExpert(true); return;
    }
    if (id === 'tlc_export') {
      e.stopImmediatePropagation(); e.preventDefault();
      tlcExport(tlcRange().from, tlcRange().to, {});
      return;
    }
    if (id === 't_export') {
      if (takePass(id)) return;
      e.stopImmediatePropagation(); e.preventDefault();
      allowed('trips.export').then(function (ok) {
        if (!ok) return;
        var n = (g('filteredTrips') ? window.filteredTrips().length : trips().length);
        recordExport({ kind: 'trips', rows: n, file: 'skyway-trips.csv' }); log('export', { ref: 'trips-csv', rows: n });
        passOnce(id); el.click();
      });
      return;
    }
    if (id === 'b_export') {
      if (takePass(id)) return;
      e.stopImmediatePropagation(); e.preventDefault();
      doPlainBackup();
      return;
    }
    if (id === 'b_reset') {
      if (takePass(id)) return;
      e.stopImmediatePropagation(); e.preventDefault();
      allowed('reset').then(function (ok) {
        if (!ok) return;
        var byName = who() || '', before = counts(STATE);
        /* The owner who just proved who they are keeps their sign-in across the reset: their staff record WITH its PIN hash
           (and the mirrored Settings PIN) is carried over, so exports, settlements and staff changes stay owner-only on the
           empty station instead of standing open until a PIN is set again. A station that never had a PIN gets the
           "Set the owner PIN" Needs-you line instead. */
        var keepRec = session ? staffById(session.staffId) : null, keep = keepRec ? JSON.parse(JSON.stringify(keepRec)) : null;
        var keepPin = keepRec && mirrorsAdminPin(keepRec) ? legacyPin() : '';
        passOnce(id); el.click();          // the console's own two confirms + migrate(defaultState())
        if (counts(STATE).trips !== before.trips || !staff().length) {
          // the fresh state has no staff/audit/exports/security: re-init our keys, write the reset on record and keep the owner signed in
          sec(); staff(); audit(); exportsLog();
          var kept = '';
          if (!staff().length && session) {
            var rec = keep && keep.role === 'owner' ? keep : { id: session.staffId, name: session.name, role: 'owner', active: true, createdAt: nowISO(), legacy: false };
            rec.active = true; rec.legacy = false; staff().push(rec);   // a fresh station: the record is the owner's own, not "the one migrated from the Settings PIN"
            if (keepPin && !settings().adminPin) settings().adminPin = keepPin;
            kept = hasPin(rec) ? 'owner record and PIN kept' : 'owner record kept (no PIN was set)';
            // the console clears the stored session with the data: the owner stays signed in on this page and signs in again (PIN) after a reload
          }
          log('reset', { ref: 'all-data', by: byName, before: before.trips + ' trips', kept: kept });
          save(); renderWho(); renderStaffPanel(); renderBackupPanel();
          if (kept) toast('All data reset. Your owner sign-in' + (hasPin(staff()[0]) ? ' and PIN were kept.' : ' was kept — set the owner PIN in Settings → Staff & access.'), true);
          try { refreshNeedsYouMine(); } catch (e) {}
        }
      });
      return;
    }
    /* Rate card, the legacy Settings PIN and company settings are owner-only: a signed-in non-owner is refused, an anonymous
       station is asked for the owner PIN once (same allow / deny / ask rule as the exports above). */
    var rt = rateToolOf(el);
    if (rt && (el.tagName === 'BUTTON' || el.tagName === 'INPUT')) {   // Add zone / Add hint / rename / delete / 20-Area box / Remove hint
      if (takePass('rate-tool')) return;
      var gr = gate('rates');
      if (gr === 'allow') { log('settings', { ref: rt }); return; }
      e.stopImmediatePropagation(); e.preventDefault();
      if (el.type === 'checkbox') { try { el.checked = !el.checked; } catch (e2) {} }
      if (gr === 'deny') { denyToast('rates'); return; }
      allowed('rates').then(function (ok) { if (ok) { passOnce('rate-tool'); el.click(); } });
      return;
    }
    if (id === 'rc_save' || id === 's_pinSave' || id === 's_pinClear' || id === 's_save') {
      if (takePass(id)) return;
      var perm = id === 'rc_save' ? 'rates' : id === 's_save' ? 'settings' : 'staff';
      if (gate(perm) === 'allow') return;
      e.stopImmediatePropagation(); e.preventDefault();
      allowed(perm).then(function (ok) { if (ok) { passOnce(id); el.click(); } });
    }
  }
  /* rate tools a signed-in non-owner must not touch: fare-matrix cells, Add zone / Add hint, zone and hint row buttons (verifier: 'bookkeeper can see money, not change rates') */
  function rateToolOf(el) {
    if (!el || !el.closest) return '';
    if (el.id === 'z_add' || el.closest('#zoneBody')) return 'zones';
    if (el.id === 'h_add' || el.closest('#hintBody')) return 'hints';
    if (el.closest('#matrixWrap')) return 'fare-matrix';
    return '';
  }
  function onCaptureChange(e) {
    var el = e.target; if (!el) return;
    if (el.id === 's_expert') {   // simple.js's Expert-mode box used to sit behind the Settings PIN; a signed-in non-owner reaches Settings without it
      if (session && !can('settings', role())) { e.stopImmediatePropagation(); e.preventDefault(); try { el.checked = false; } catch (e2) {} denyToast('settings'); }
      return;
    }
    if (el.tagName === 'INPUT' && el.closest && el.closest('#matrixWrap')) {
      if (takePass('fare-matrix')) return;
      var gm = gate('rates');
      if (gm === 'allow') { log('settings', { ref: 'fare-matrix', cell: (el.dataset.a || '') + '|' + (el.dataset.b || ''), value: el.value }); return; }
      e.stopImmediatePropagation(); e.preventDefault();
      var typed = el.value; el.value = el.defaultValue;
      if (gm === 'deny') { denyToast('rates'); return; }
      allowed('rates').then(function (ok) { if (!ok) return; el.value = typed; passOnce('fare-matrix'); el.dispatchEvent(new Event('change', { bubbles: true })); });
      return;
    }
    if (el.id !== 'b_import') return;
    if (takePass('b_import')) return;
    e.stopImmediatePropagation(); e.preventDefault();
    var f = el.files && el.files[0]; el.value = '';
    if (!f) return;
    restoreFromFile(f).then(function () { try { if (g('goTab')) window.goTab('settings'); } catch (e2) {} });
  }
  /* bubble-phase: settings / rates / legacy PIN changes land in the audit; the legacy PIN change is mirrored into the owner's hash */
  function onBubbleClick(e) {
    var el = e.target && e.target.closest ? e.target.closest('button') : null; if (!el || !el.id) return;
    if (el.id === 'd_save') { var pre = dsPre; dsPre = null; afterBookForm(pre); return; }
    if (el.id === 'undoBtn') { var up = undoPre; undoPre = null; afterAll(up, 'undo'); return; }
    if (el.id === 's_save') log('settings', { ref: 'company' });
    else if (el.id === 'rc_save') log('settings', { ref: 'rate-card' });
    else if (el.id === 's_pinSave' || el.id === 's_pinClear') { log('settings', { ref: el.id === 's_pinSave' ? 'legacy-pin-set' : 'legacy-pin-cleared' }); mirrorLegacyPin(); }
  }
  function mirrorLegacyPin() {
    var rec = staff().filter(function (s) { return s.active !== false && mirrorsAdminPin(s); })[0]; if (!rec) return;
    var lp = legacyPin();
    if (lp && cryptoReady()) setPin(rec, lp).then(function () { save(); renderStaffPanel(); }).catch(function () {});
  }

  /* ---------- migration: the single settings.adminPin becomes the owner's staff record ---------- */
  function migrateStaff() {
    if (staff().length) return Promise.resolve(false);
    var name = String(settings().contact || '').trim() || 'Owner';
    var rec = { id: uid(), name: name, role: 'owner', active: true, legacy: true, createdAt: nowISO(), salt: '', hash: '', iter: 0 };
    staff().push(rec);
    var c = sec(); c.migratedAt = nowISO();
    save();
    log('staff', { ref: name, change: 'owner record created from the Settings PIN' });
    var lp = legacyPin();
    if (lp && cryptoReady()) return setPin(rec, lp).then(function () { save(); return true; }).catch(function () { return true; });
    return Promise.resolve(true);
  }
  /* An owner record that mirrors settings.adminPin but has no hash yet (recreated after a reset; PIN set from another station;
     crypto was missing at migration) gets that PIN hashed in, so the record never counts as "no PIN" while a PIN exists. */
  function adoptLegacyPin() {
    var lp = legacyPin(); if (!lp || !cryptoReady()) return Promise.resolve(false);
    var rec = owners().filter(function (r) { return !r.hash && mirrorsAdminPin(r); })[0]; if (!rec) return Promise.resolve(false);
    return setPin(rec, lp).then(function () { log('staff', { ref: rec.name, change: 'PIN taken over from the Settings PIN' }); save(); renderStaffPanel(); return true; }).catch(function () { return false; });
  }

  /* ---------- staff management (owner) ---------- */
  function addStaff(name, roleName, pin) {
    name = String(name || '').trim(); roleName = String(roleName || 'dispatcher');
    if (!name) return Promise.reject(new Error('A name is required.'));
    if (ROLES.indexOf(roleName) < 0) return Promise.reject(new Error('Role must be owner, dispatcher or bookkeeper.'));
    if (staff().some(function (s) { return s.name.toLowerCase() === name.toLowerCase() && s.active !== false; })) return Promise.reject(new Error('There is already a staff member called ' + name + '.'));
    if (needsPin(roleName) && !String(pin || '').trim()) return Promise.reject(new Error('An ' + roleName + ' needs a PIN — without one anyone could sign in as ' + name + '.'));
    var rec = { id: uid(), name: name, role: roleName, active: true, legacy: false, createdAt: nowISO(), salt: '', hash: '', iter: 0 };
    var p = pin ? setPin(rec, pin) : Promise.resolve(false);
    return p.then(function () { staff().push(rec); if (pin) mirrorOwnerPin(rec, pin); log('staff', { ref: name, change: 'added as ' + roleName + (pin ? ' with PIN' : ' (no PIN yet)') }); save(); renderStaffPanel(); renderWho(); return rec; });
  }
  function setStaffPin(id, pin) {
    var rec = staffById(id); if (!rec) return Promise.reject(new Error('Unknown staff member.'));
    return setPin(rec, pin).then(function () {
      mirrorOwnerPin(rec, pin);
      log('staff', { ref: rec.name, change: 'PIN changed' }); save(); renderStaffPanel(); return true;
    });
  }
  /* Whose PIN is settings.adminPin: the owner record migrated from it, while that record has a PIN of its own (a hash) or no
     other owner has one; otherwise (fresh station whose placeholder owner never got a PIN, after a reset) any active owner
     with a hashed PIN — so the first owner PIN set through the Staff panel reaches every gate that still reads settings.adminPin. */
  function legacyClaimsAdminPin(s) {
    if (!s || !s.legacy || s.role !== 'owner' || s.active === false) return false;
    if (s.hash) return true;
    return !staff().some(function (o) { return o && !o.legacy && o.role === 'owner' && o.active !== false && o.hash; });
  }
  function mirrorsAdminPin(rec) {
    if (!rec || rec.role !== 'owner') return false;
    if (rec.legacy) return legacyClaimsAdminPin(rec);
    return !staff().some(legacyClaimsAdminPin);
  }
  /* An owner PIN just set on rec (a 4-digit string) is written to settings.adminPin when rec is the record that mirrors it. */
  function mirrorOwnerPin(rec, pin) {
    if (!rec || rec.role !== 'owner' || !/^\d{4}$/.test(String(pin || ''))) return false;
    if (!mirrorsAdminPin(rec)) return false;
    settings().adminPin = String(pin); return true;   // keep simple.js / ledger / quote / ops / crm / plan gates on the same PIN while they still read settings.adminPin
  }
  function setStaffRole(id, roleName) {
    var rec = staffById(id); if (!rec) return false; if (ROLES.indexOf(roleName) < 0) return false;
    if (rec.role === 'owner' && roleName !== 'owner' && owners().length <= 1) { toast('Keep at least one owner.', true); return false; }
    if (needsPin(roleName) && !needsPin(rec.role) && !rec.hash) { toast('Set a PIN for ' + rec.name + ' first — an ' + roleName + ' cannot sign in by name alone.', true); return false; }
    var from = rec.role; rec.role = roleName; log('staff', { ref: rec.name, change: 'role ' + from + ' → ' + roleName }); save(); renderStaffPanel(); renderWho(); return true;
  }
  function setStaffActive(id, on) {
    var rec = staffById(id); if (!rec) return false;
    if (!on && rec.role === 'owner' && owners().length <= 1) { toast('Keep at least one active owner.', true); return false; }
    rec.active = !!on; log('staff', { ref: rec.name, change: on ? 'reactivated' : 'deactivated' });
    if (!on && session && session.staffId === id) { session = null; storeSession(); }
    save(); renderStaffPanel(); renderWho(); return true;
  }
  function removeStaff(id) {
    var rec = staffById(id); if (!rec) return false;
    if (rec.role === 'owner' && owners().length <= 1) { toast('Keep at least one owner.', true); return false; }
    STATE.staff = staff().filter(function (s) { return s.id !== id; });
    if (session && session.staffId === id) { session = null; storeSession(); }
    log('staff', { ref: rec.name, change: 'removed' }); save(); renderStaffPanel(); renderWho(); return true;
  }

  /* ---------- styles ---------- */
  function ensureStyle() {
    if (byId('recoverStyle')) return;
    var st = document.createElement('style'); st.id = 'recoverStyle';
    st.textContent = [
      '#rcWho{display:flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap;}',
      '#rcWho .rc-chip{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.35);color:inherit;border-radius:12px;padding:3px 10px;font-size:12px;cursor:pointer;font-weight:600;}',
      '#rcWho .rc-chip:hover{background:rgba(255,255,255,.26);}',
      '#rcWho .rc-role{opacity:.8;font-size:11px;text-transform:uppercase;letter-spacing:.4px;}',
      '#rcDialog{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9000;}',
      '#rcDialog[hidden]{display:none;}',
      '#rcDialog .rc-box{background:var(--paper,#fff);color:var(--ink,#111);border:1px solid var(--line,#ccc);border-radius:6px;padding:16px 18px;min-width:300px;max-width:420px;box-shadow:0 10px 40px rgba(0,0,0,.35);}',
      '#rcDialog h3{margin:0 0 8px;font-size:15px;}',
      '#rcDialog .rc-names{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px;}',
      '#rcDialog .rc-names button{padding:6px 10px;}',
      '#rcDialog .rc-names button.on{outline:2px solid var(--green,#1f7a3d);}',
      '#rcDialog input{font-size:18px;letter-spacing:4px;width:140px;}',
      '.rc-panel h4{margin:12px 0 4px;font-size:12.5px;color:var(--green-dark,#15497d);}',
      '.rc-panel .tbl-scroll{max-height:320px;}',
      '.rc-panel .rc-acts{display:flex;flex-wrap:wrap;gap:4px;}',
      '.rc-panel .rc-chip{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:10px;background:rgba(31,122,61,.12);color:#1f7a3d;white-space:nowrap;}',
      '.rc-panel .rc-chip.warn{background:rgba(192,57,43,.1);color:#9b2d20;}',
      '.rc-panel .rc-chip.off{background:rgba(120,120,120,.15);color:#555;}',
      '.rc-panel .rc-diff td.num{text-align:right;font-family:Consolas,monospace;}',
      '.rc-panel .rc-diff td.bad{color:#a4161a;font-weight:700;}',
      '.rc-panel .rc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;align-items:end;}',
      '.rc-panel .rc-file{display:inline-flex;cursor:pointer;}',
      '.rc-panel .rc-file input{display:none;}',
      '#simpleBoardTools .rc-outage{margin-left:4px;}',
      '#rcTools{display:none;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;}',
      'body.simple-mode[data-simple-mode="today"] #rcTools{display:flex;}',
      'body:not(.simple-mode) #view-dispatch #rcTools{display:flex;}',   // Expert mode: one click from the Dispatch tab too
      'input.rc-masked{background:repeating-linear-gradient(45deg,rgba(120,120,120,.08) 0 6px,transparent 6px 12px) !important;cursor:pointer;font-style:italic;}',
      '#rcTools .btn{min-height:36px;}',
      'body.gold .rc-panel h4{color:#e8c75a;} body.classic .rc-panel h4{color:#0a246a;}',
      '@media (max-width:640px){#rcWho .rc-role{display:none;}}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }

  /* ---------- sign-in chip + dialog ---------- */
  function ensureWho() {
    var host = byId('rcWho'); if (host) return host;
    var bar = document.querySelector('.cmdbar'); if (!bar) return null;
    host = document.createElement('div'); host.id = 'rcWho';
    var clock = bar.querySelector('.clock');
    if (clock) bar.insertBefore(host, clock); else bar.appendChild(host);
    host.addEventListener('click', act(function (e) { var b = e.target.closest ? e.target.closest('button') : null; if (b) openDialog(); }));
    return host;
  }
  function renderWho() {
    var host = ensureWho();
    if (host) {
      if (session) host.innerHTML = '<span class="rc-role">' + esc(session.role) + '</span><button class="rc-chip" type="button" id="rcWhoBtn" title="Signed in — click to switch or sign out">' + esc(session.name) + '</button>';
      else host.innerHTML = '<span class="rc-role">dispatcher</span><button class="rc-chip" type="button" id="rcWhoBtn" title="Sign in with your name and PIN">Sign in</button>';
    }
    try { maskSecrets(); } catch (e) {}
  }

  /* ---------- secrets on the Settings view ----------
     simple.js's panel shows settings.adminPin in a plain text box (#s_pin), index.html shows the Google and LocationIQ keys
     (#s_gmapkey, #s_geokey). A bookkeeper may open Settings (the activity log lives there) and a dispatcher may reach it in
     Expert mode, so for anyone but the owner those boxes are blanked and read-only; clicking one asks for the owner PIN. The
     owner (signed in, or a fresh station with no PIN yet) sees the real values. Re-applied after every renderSettings,
     Simple.enter and sign-in / sign-out. The console's own Save buttons still read the boxes: s_save / s_pinSave are
     owner-gated above, and the gate signs the owner in (which unmasks) before the click is replayed. */
  var SECRET_IDS = ['s_pin', 's_gmapkey', 's_geokey'];
  function secretValue(id) { var s = settings(); if (id === 's_pin') return legacyPin(); if (id === 's_gmapkey') return s.gmapkey || ''; if (id === 's_geokey') return s.geokey || ''; return ''; }
  function maskSecrets() {
    var hide = !ownerHere();
    SECRET_IDS.forEach(function (id) {
      var el = byId(id); if (!el) return;
      if (hide) {
        if (!el.__rcMasked) { el.__rcMasked = true; el.__rcPh = el.placeholder || ''; }
        if (el.value !== '') el.value = '';
        el.readOnly = true; el.placeholder = 'Owner only — click to sign in'; el.classList.add('rc-masked');
      } else if (el.__rcMasked) {
        el.__rcMasked = false; el.readOnly = false; el.placeholder = el.__rcPh || ''; el.classList.remove('rc-masked');
        el.value = secretValue(id);
      }
    });
  }
  function secretsMasked() { return SECRET_IDS.some(function (id) { var el = byId(id); return !!(el && el.__rcMasked); }); }
  var dlgPick = '';
  function openDialog() {
    var d = byId('rcDialog');
    if (!d) {
      d = document.createElement('div'); d.id = 'rcDialog'; d.hidden = true;
      d.addEventListener('click', act(onDialogClick));
      d.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDialog(); if (e.key === 'Enter' && e.target && e.target.id === 'rcPin') { e.preventDefault(); dialogSubmit(); } });
      document.body.appendChild(d);
    }
    var list = activeStaff();
    dlgPick = session ? session.staffId : (list.length === 1 ? list[0].id : '');
    var h = '<div class="rc-box" role="dialog" aria-label="Sign in"><h3>' + (session ? 'Signed in as ' + esc(session.name) + ' (' + esc(session.role) + ')' : 'Who is at this station?') + '</h3>';
    if (!list.length) h += '<div class="hint">No staff yet. The owner adds names in Settings → Staff, access &amp; activity.</div>';
    else {
      h += '<div class="rc-names" id="rcNames">' + list.map(function (s) { return '<button type="button" class="btn btn-ghost btn-sm' + (s.id === dlgPick ? ' on' : '') + '" data-pick="' + esc(s.id) + '">' + esc(s.name) + ' <span class="hint" style="margin:0;">' + esc(s.role) + '</span></button>'; }).join('') + '</div>';
      h += '<label class="fld"><span class="lbl">PIN</span><input type="password" id="rcPin" inputmode="numeric" autocomplete="off" maxlength="8"></label>';
    }
    h += '<div class="btn-row" style="margin-top:10px;">' + (list.length ? '<button class="btn btn-go" type="button" data-act="signin">Sign in</button>' : '') + (session ? '<button class="btn btn-ghost" type="button" data-act="signout">Sign out</button>' : '') + '<button class="btn btn-ghost" type="button" data-act="close">Close</button></div></div>';
    d.innerHTML = h; d.hidden = false;
    var pin = byId('rcPin'); if (pin) { try { pin.focus(); } catch (e) {} }
  }
  function closeDialog() { var d = byId('rcDialog'); if (d) d.hidden = true; }
  function onDialogClick(e) {
    var p = e.target.closest ? e.target.closest('[data-pick]') : null;
    if (p) { dlgPick = p.getAttribute('data-pick'); var names = byId('rcNames'); if (names) names.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-pick') === dlgPick); }); var pin = byId('rcPin'); if (pin) pin.focus(); return; }
    var b = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!b) { if (e.target && e.target.id === 'rcDialog') closeDialog(); return; }
    var a = b.getAttribute('data-act');
    if (a === 'close') closeDialog();
    else if (a === 'signout') { signOut(); closeDialog(); toast('Signed out — this station is a dispatcher again.'); }
    else if (a === 'signin') dialogSubmit();
  }
  function dialogSubmit() {
    if (!dlgPick) { toast('Pick your name first.', true); return; }
    var pin = byId('rcPin'), v = pin ? pin.value : '';
    signIn(dlgPick, v).then(function (r) {
      if (r.ok) { closeDialog(); toast('Signed in as ' + r.who.name + ' (' + r.who.role + ').'); refreshNeedsYouMine(); }
      else {
        var rec = staffById(dlgPick);
        toast(r.reason === 'pin' ? 'Wrong PIN.' : r.reason === 'nopin' ? ((rec ? rec.name : 'This person') + ' has no PIN yet — the owner sets one in Settings → Staff, access & activity.') : 'Could not sign in.', true);
        if (pin) { pin.value = ''; pin.focus(); }
      }
    });
  }

  /* ---------- Settings panels ---------- */
  function ensurePanel(id, afterId) {
    var view = byId('view-settings'); if (!view) return null;
    var p = byId(id);
    if (!p) {
      p = document.createElement('div'); p.id = id; p.className = 'panel rc-panel';
      var anchor = afterId ? byId(afterId) : null;
      if (anchor && anchor.parentNode === view) view.insertBefore(p, anchor.nextSibling); else view.appendChild(p);
    }
    return p;
  }
  var ROLE_TEXT = { owner: 'everything, including exports, backups, settlements, rates and staff', dispatcher: 'books, assigns and completes trips; no exports, no backups, no settlements', bookkeeper: 'sees money and files the TLC export; cannot change rates or staff' };
  function renderStaffPanel() {
    var p = ensurePanel('recoverStaff'); if (!p) return;
    ensureStyle();
    var owner = ownerHere(), canView = can('audit.view', role());   // controls for the signed-in owner, or for a fresh station before any owner PIN exists (each action still passes the owner gate)
    var h = '<div class="panel-head">Staff, access &amp; activity <span class="hint" style="margin:0;font-weight:400;">' + (session ? 'signed in: ' + esc(session.name) + ' (' + esc(session.role) + ')' : 'nobody signed in — this station acts as a dispatcher') + '</span></div><div class="panel-body">';
    h += '<p class="hint" style="margin-top:0;">PINs are stored as salted PBKDF2 hashes, never in clear. Owner: ' + esc(ROLE_TEXT.owner) + '. Dispatcher: ' + esc(ROLE_TEXT.dispatcher) + '. Bookkeeper: ' + esc(ROLE_TEXT.bookkeeper) + '. Owners and bookkeepers must have a PIN; a dispatcher without one signs in by name. The Settings / Expert-mode PIN from Simple mode stays the owner\'s PIN (4 digits); a signed-in owner or bookkeeper opens Settings without being asked for it again, and only the owner sees that PIN and the map keys there.</p>';
    h += '<div class="tbl-scroll"><table class="data" id="rc_staff"><thead><tr><th>Name</th><th>Role</th><th>PIN</th><th>Status</th>' + (owner ? '<th>Actions</th>' : '') + '</tr></thead><tbody>';
    staff().forEach(function (s) {
      h += '<tr data-staff="' + esc(s.id) + '"><td>' + esc(s.name) + (s.legacy ? ' <span class="hint" style="margin:0;">' + (legacyClaimsAdminPin(s) ? '(from the Settings PIN)' : '(first-run record, no PIN)') + '</span>' : '') + '</td><td>' + (owner ? '<select data-act="role" data-id="' + esc(s.id) + '">' + ROLES.map(function (r) { return '<option value="' + r + '"' + (s.role === r ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select>' : esc(s.role)) + '</td>'
        + '<td>' + (s.hash ? '<span class="rc-chip">set</span>' : (legacyFor(s) ? '<span class="rc-chip">legacy</span>' : '<span class="rc-chip warn">none</span>')) + '</td>'
        + '<td>' + (s.active === false ? '<span class="rc-chip off">inactive</span>' : '<span class="rc-chip">active</span>') + '</td>'
        + (owner ? '<td><div class="rc-acts"><button class="btn btn-navy btn-sm" type="button" data-act="pin" data-id="' + esc(s.id) + '">Set PIN</button><button class="btn btn-ghost btn-sm" type="button" data-act="toggle" data-id="' + esc(s.id) + '">' + (s.active === false ? 'Reactivate' : 'Deactivate') + '</button><button class="btn btn-void btn-sm" type="button" data-act="remove" data-id="' + esc(s.id) + '">Remove</button></div></td>' : '') + '</tr>';
    });
    if (!staff().length) h += '<tr><td colspan="5"><div class="empty">No staff yet.</div></td></tr>';
    h += '</tbody></table></div>';
    if (owner) {
      h += '<div class="rc-grid" style="margin-top:8px;"><label class="fld"><span class="lbl">Name</span><input type="text" id="rc_newName" autocomplete="off" placeholder="First name"></label><label class="fld"><span class="lbl">Role</span><select id="rc_newRole"><option value="dispatcher">dispatcher</option><option value="bookkeeper">bookkeeper</option><option value="owner">owner</option></select></label><label class="fld"><span class="lbl">PIN (4 digits for an owner, 4–8 otherwise)</span><input type="password" id="rc_newPin" inputmode="numeric" maxlength="8" autocomplete="off"></label><label class="fld"><span class="lbl">&nbsp;</span><button class="btn btn-go" type="button" data-act="add">Add staff</button></label></div>';
      h += '<div class="rc-grid" style="margin-top:8px;"><label class="fld"><span class="lbl">TLC header (16 columns, comma-separated — the accepted spec)</span><input type="text" id="rc_tlcHeader" value="' + esc(sec().tlcHeader) + '" autocomplete="off"></label><label class="fld"><span class="lbl">&nbsp;</span><button class="btn btn-navy" type="button" data-act="tlcheader">Save header</button></label></div>';
    } else h += '<div class="hint">Only the owner can add staff or change PINs.' + (session ? '' : ' <button class="btn btn-ghost btn-sm" type="button" data-act="signin">Sign in</button>') + '</div>';
    h += '<h4>Activity <span class="hint" style="margin:0;font-weight:400;">&mdash; last 2,000 events kept: who assigned, cancelled, exported, backed up, restored, changed settings</span></h4>';
    if (!canView) h += '<div class="hint">Only the owner or bookkeeper sees the activity log.</div>';
    else {
      var rows = auditRows({ what: auditFilter || '', limit: 200 }), kinds = {}; audit().forEach(function (r) { kinds[r.what] = 1; });
      h += '<div class="rc-acts" style="margin-bottom:6px;"><select id="rc_auditKind" data-act="filter"><option value="">All events (' + audit().length + ')</option>' + Object.keys(kinds).sort().map(function (k) { return '<option value="' + esc(k) + '"' + (auditFilter === k ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') + '</select><button class="btn btn-navy btn-sm" type="button" data-act="auditcsv">Export activity CSV</button></div>';
      h += '<div class="tbl-scroll"><table class="data" id="rc_audit"><thead><tr><th>When</th><th>Who</th><th>Role</th><th>What</th><th>Ref</th><th>Detail</th></tr></thead><tbody>';
      rows.forEach(function (r) { h += '<tr><td class="mono">' + esc(fmtWhen(r.at)) + '</td><td>' + esc(r.by || '—') + '</td><td>' + esc(r.role || '') + '</td><td><b>' + esc(r.what) + '</b></td><td>' + esc(r.ref || '') + '</td><td class="hint" style="margin:0;">' + esc(detailText(r.detail)) + '</td></tr>'; });
      if (!rows.length) h += '<tr><td colspan="6"><div class="empty">Nothing recorded yet.</div></td></tr>';
      h += '</tbody></table></div>';
    }
    h += '</div>';
    p.innerHTML = h;
    if (!p.__rcWired) { p.__rcWired = true; p.addEventListener('click', act(onStaffClick)); p.addEventListener('change', act(onStaffChange)); }
  }
  var auditFilter = '';
  function onStaffChange(e) {
    var el = e.target; if (!el) return;
    if (el.id === 'rc_auditKind') { auditFilter = el.value; renderStaffPanel(); return; }
    if (el.getAttribute('data-act') === 'role') {
      var sid = el.getAttribute('data-id'), rv = el.value;
      allowed('staff').then(function (ok) { if (!ok || !setStaffRole(sid, rv)) renderStaffPanel(); });
    }
  }
  function onStaffClick(e) {
    var b = e.target.closest ? e.target.closest('button[data-act]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    if (a === 'signin') { openDialog(); return; }
    if (a === 'auditcsv') { exportAudit(); return; }
    // owner-only from here: a signed-in non-owner is refused; an anonymous station is asked for the owner PIN (fresh station: allowed with a hint)
    allowed('staff').then(function (ok) { if (ok) staffAction(a, id); });
  }
  function staffAction(a, id) {
    if (a === 'add') {
      var nm = (byId('rc_newName') || {}).value, rl = (byId('rc_newRole') || {}).value, pn = (byId('rc_newPin') || {}).value;
      if (needsPin(rl) && !String(pn || '').trim()) { toast('An ' + rl + ' needs a PIN (type one in the PIN box).', true); return; }
      if (pn && !validPin(pn, rl)) { toast(pinRule(rl).msg, true); return; }
      addStaff(nm, rl, pn).then(function (rec) { toast(rec.name + ' added as ' + rec.role + '.'); }).catch(function (err) { toast(String((err && err.message) || err), true); });
    } else if (a === 'pin') {
      var rec = staffById(id); if (!rec) return;
      var v = ask('New PIN for ' + rec.name + (rec.role === 'owner' ? ' (4 digits — also the Settings / Expert-mode PIN):' : ' (4 to 8 digits):'), ''); if (v === null) return;
      if (!validPin(v, rec.role)) { toast(pinRule(rec.role).msg, true); return; }
      setStaffPin(id, String(v).trim()).then(function () { toast('PIN set for ' + rec.name + '.'); }).catch(function (err) { toast(String((err && err.message) || err), true); });
    } else if (a === 'toggle') { var r2 = staffById(id); if (r2) setStaffActive(id, r2.active === false); }
    else if (a === 'remove') { var r3 = staffById(id); if (r3 && confirmBox('Remove ' + r3.name + ' from staff? Their past activity stays in the log.')) removeStaff(id); }
    else if (a === 'tlcheader') { var hv = String((byId('rc_tlcHeader') || {}).value || '').trim(); if (hv.split(',').length !== 16) { toast('The TLC header must have 16 comma-separated columns.', true); return; } sec().tlcHeader = hv; log('settings', { ref: 'tlc-header' }); save(); toast(hv === TLC_HEAD.join(',') ? 'TLC header saved — matches the file this console writes.' : 'TLC header saved — note it differs from the 16 columns this console writes.'); renderStaffPanel(); }
  }
  function renderBackupPanel() {
    var p = ensurePanel('recoverBackup', 'recoverStaff'); if (!p) return;
    ensureStyle();
    var c = sec(), owner = can('backup', role());
    var h = '<div class="panel-head">Backup, restore &amp; outage sheet <span class="hint" style="margin:0;font-weight:400;">' + (c.lastBackupAt ? 'last backup ' + esc(fmtWhen(c.lastBackupAt)) + (c.lastBackupKind ? ' (' + esc(c.lastBackupKind) + ')' : '') : 'no backup recorded yet') + (c.lastRestoreTestAt ? ' · last restore test ' + esc(fmtWhen(c.lastRestoreTestAt)) + (c.lastRestoreMatch ? ' — matched' : ' — differed') : '') + '</span></div><div class="panel-body">';
    h += '<p class="hint" style="margin-top:0;">The encrypted backup (AES-GCM) needs a passphrase you type each time; it is never stored. The file holds every trip, driver, account, setting and the side lists (caller book, route book). Keep the passphrase and the optional recovery-key file apart from the backup.</p>';
    h += '<div class="btn-row"><button class="btn btn-go" type="button" data-act="enc">Encrypted backup (.skyenc)</button>'
      + '<button class="btn btn-ghost" type="button" data-act="key" title="The raw key for the backup you just made — opens it without the passphrase">Download recovery key</button>'
      + '<label class="btn btn-ghost rc-file" title="Choose a .skyenc or .json backup — it is checked in a sandbox first, nothing changes until you confirm">Test &amp; restore from file<input type="file" id="rc_restoreFile" accept=".skyenc,.json,application/json"></label>'
      + '<label class="btn btn-ghost rc-file" title="Load the recovery key file first if you lost the passphrase">' + (pendingRawKey ? 'Recovery key loaded ✓' : 'Use a recovery key') + '<input type="file" id="rc_keyFile" accept=".json,application/json"></label></div>'
      + '<label style="display:inline-flex;align-items:center;gap:6px;margin:6px 0;"><input type="checkbox" id="rc_incKeys"> Include the Google keys in the backup</label>';
    h += '<div class="hint" style="margin:4px 0 8px;">The plain <b>Export Backup (.json)</b> button above still works for the owner, with a warning: that file is not encrypted.</div>';
    h += '<div id="rc_restoreReport">' + restoreReportHtml() + '</div>';
    h += '<h4>Paper fallback</h4><div class="btn-row"><button class="btn btn-navy" type="button" data-act="outage">Print outage sheet</button><span class="hint" style="margin:0;">Today\'s and tomorrow\'s booked trips with phone, pickup, drop, driver and fare, the driver phone list and blank rows — run dispatch on paper if the browser dies. Also on Today in Simple mode.</span></div>';
    if (!owner) h += '<div class="hint" style="margin-top:8px;">Backups and restores are owner-only' + (session ? ' — you are signed in as ' + esc(session.role) : ' — the owner PIN is asked') + '.</div>';
    h += '</div>';
    p.innerHTML = h;
    if (!p.__rcWired) {
      p.__rcWired = true;
      p.addEventListener('click', act(onBackupClick));
      p.addEventListener('change', act(function (e) {
        var el = e.target; if (!el) return;
        if (el.id === 'rc_restoreFile') { var f = el.files && el.files[0]; el.value = ''; if (f) restoreFromFile(f); }
        else if (el.id === 'rc_keyFile') { var k = el.files && el.files[0]; el.value = ''; if (k) loadKeyFile(k); }
      }));
    }
  }
  function restoreReportHtml() {
    if (!pendingRestore) return '';
    var rep = pendingRestore.report;
    var h = '<h4>Restore test <span class="hint" style="margin:0;font-weight:400;">&mdash; ' + esc(pendingRestore.fileName || 'file') + (rep.createdAt ? ', made ' + esc(fmtWhen(rep.createdAt)) + (rep.by ? ' by ' + esc(rep.by) : '') : '') + (pendingRestore.encrypted ? ' · decrypted, checksum OK' : ' · plain file') + '</span></h4>';
    h += '<div class="notice" style="margin:0 0 6px;' + (rep.equal ? '' : 'background:#fff7df;') + '"><b>' + (rep.equal ? 'Trips, drivers, vehicles and accounts match the live data.' : 'The file differs from the live data — read the table before restoring.') + '</b> Nothing has changed yet.</div>';
    h += '<div class="tbl-scroll" style="max-height:260px;"><table class="data rc-diff" id="rc_diff"><thead><tr><th>Record</th><th class="num">In file</th><th class="num">Live now</th><th class="num">Difference</th></tr></thead><tbody>';
    rep.diff.forEach(function (d) { h += '<tr data-key="' + esc(d.key) + '"><td>' + esc(d.key) + '</td><td class="num">' + esc(d.file) + '</td><td class="num">' + esc(d.live) + '</td><td class="num' + (d.delta ? ' bad' : '') + '">' + (d.delta > 0 ? '+' : '') + esc(d.delta) + '</td></tr>'; });
    h += '</tbody></table></div><div class="btn-row" style="margin-top:6px;"><button class="btn btn-void" type="button" data-act="restore">Restore now (type RESTORE)</button><button class="btn btn-ghost" type="button" data-act="report">Print restore report</button><button class="btn btn-ghost" type="button" data-act="discard">Discard</button></div>';
    return h;
  }
  function renderRestoreReport() { var host = byId('rc_restoreReport'); if (host) host.innerHTML = restoreReportHtml(); else renderBackupPanel(); }
  function onBackupClick(e) {
    var b = e.target.closest ? e.target.closest('button[data-act]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-act');
    if (a === 'enc') doEncryptedBackup();
    else if (a === 'key') { if (gate('backup') === 'allow') downloadKeyFile(); else allowed('backup').then(function (ok) { if (ok) downloadKeyFile(); }); }
    else if (a === 'outage') printOutageSheet();
    else if (a === 'restore') { allowed('restore').then(function (ok) { if (ok) confirmRestore(); }); }
    else if (a === 'report') printRestoreReport();
    else if (a === 'discard') { pendingRestore = null; renderRestoreReport(); }
  }

  /* ---------- Simple mode: outage button on Today; Needs-you reminders ---------- */
  /* One button, two homes: on Today it sits in our own strip (#rcTools, shown only in Simple mode's Today layout — simple.css
     hides #simpleBoardTools there); on Board it moves into simple.js's #simpleBoardTools (the only thing Board shows besides the
     board). A MutationObserver on body[data-simple-mode] moves it when the section changes. */
  var modeObserver = null;
  function ensureOutageButton() {
    var vd = byId('view-dispatch'); if (!vd) return;
    var b = byId('rcOutageBtn');
    if (!b) {
      b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost rc-outage'; b.id = 'rcOutageBtn'; b.textContent = 'Print outage sheet'; b.title = 'Paper copy of today\'s and tomorrow\'s trips, in case the computer dies';
      b.addEventListener('click', act(function (e) { e.stopPropagation(); printOutageSheet(); }));
    }
    var strip = byId('rcTools');
    if (!strip) {
      strip = document.createElement('div'); strip.id = 'rcTools';
      strip.innerHTML = '<span class="hint" style="margin:0;">If the computer dies, run dispatch from paper:</span>';
      var ba = byId('boardArea'); if (ba && ba.parentNode === vd) vd.insertBefore(strip, ba); else vd.appendChild(strip);
    }
    var mode = document.body.getAttribute('data-simple-mode') || '', boardTools = byId('simpleBoardTools');
    var home = (mode === 'board' && boardTools) ? boardTools : strip;
    if (b.parentNode !== home) home.appendChild(b);
    if (!modeObserver && window.MutationObserver) {
      modeObserver = new MutationObserver(function () { try { ensureOutageButton(); } catch (e) {} });
      modeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-simple-mode', 'class'] });
    }
  }
  function myNeedsItems() {
    var items = [], c = sec(), days = Number(c.backupReminderDays) || 2;
    /* no owner PIN anywhere (fresh station, or an owner who reset without ever setting one): every owner-only action is open to whoever sits at the desk */
    if (!anyOwnerPin()) items.push({ k: 'ownerpin', txt: '<b>No owner PIN is set</b> — exports, backups, settlements, rates and staff changes are open to anyone at this desk until the owner sets one.', act: 'rcstaff', lbl: 'Set the owner PIN' });
    if (!c.lastBackupAt || (Date.now() - new Date(c.lastBackupAt).getTime()) > days * 86400000) items.push({ k: 'backup', txt: '<b>No backup in ' + (c.lastBackupAt ? Math.floor((Date.now() - new Date(c.lastBackupAt).getTime()) / 86400000) + ' days' : 'this browser') + '</b> — make an encrypted backup (owner).', act: 'rcbackup', lbl: 'Back up now' });
    if (c.lastRestoreTestAt && (Date.now() - new Date(c.lastRestoreTestAt).getTime()) > 30 * 86400000) items.push({ k: 'restoretest', txt: '<b>Restore test is older than 30 days</b> — test a backup file in Settings.', act: 'rcsettings', lbl: 'Open Settings' });
    return items;
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
  /* simple.js rebuilds the strip from scratch inside its own enter() / goTab / refreshBoard paths, which never pass through the
     wrapped Simple.refreshNeedsYou: watch the strip and put our reminders back whenever they are missing (ops.js does the same).
     The observer only acts when no line of ours is present, and refreshNeedsYouMine adds nothing when there is nothing to say. */
  function watchNeedsYou(host) {
    if (!host || host.__recoverObserved || !window.MutationObserver) return;
    host.__recoverObserved = true;
    try { new MutationObserver(function () { try { if (!host.querySelector('.rc-ny')) refreshNeedsYouMine(); } catch (e) {} }).observe(host, { childList: true }); } catch (e) {}
  }
  function refreshNeedsYouMine() {
    var host = byId('needsYou'); if (!host) return;
    watchNeedsYou(host);
    if (!(window.Simple && window.Simple.isSimple && window.Simple.isSimple())) return;
    var had = host.querySelector('.ny-item.rc-ny');
    host.querySelectorAll('.ny-item.rc-ny').forEach(function (n) { n.remove(); });
    var items = myNeedsItems(); if (!items.length) { if (had) recountNeedsYou(host); return; }
    items.forEach(function (it) {
      var div = document.createElement('div'); div.className = 'ny-item rc-ny'; div.setAttribute('data-kind', it.k);
      div.innerHTML = '<span class="ny-dot soon"></span><span class="ny-txt">' + it.txt + '</span><span class="ny-acts"><button type="button" class="btn btn-sm btn-navy" data-rc="' + it.act + '">' + esc(it.lbl) + '</button></span>';
      div.addEventListener('click', act(function (e) {
        var b = e.target.closest ? e.target.closest('[data-rc]') : null; if (!b) return; e.stopPropagation();
        var a = b.getAttribute('data-rc');
        if (a === 'rcbackup') { doEncryptedBackup(); return; }
        if (window.Simple && window.Simple.enter) window.Simple.enter('settings');
        if (a === 'rcstaff') { var p = byId('recoverStaff'); try { if (p && p.scrollIntoView) p.scrollIntoView(); var f = byId('rc_newName'); if (f && !staff().length) f.focus(); } catch (err) {} }
      }));
      host.appendChild(div);
    });
    recountNeedsYou(host);
  }
  function hookSimple() {
    var S = window.Simple; if (!S) return;
    if (typeof S.refreshNeedsYou === 'function' && !S.refreshNeedsYou.__recoverWrapped) {
      var orig = S.refreshNeedsYou;
      var w = function () { var r = orig.apply(this, arguments); try { refreshNeedsYouMine(); ensureOutageButton(); } catch (e) {} return r; };
      w.__recoverWrapped = true; w._orig = orig; inheritFlags(w, orig); S.refreshNeedsYou = w;
    }
    /* Simple.enter('settings') asks simple.js's pinOK() — a prompt for settings.adminPin — every new tab. A signed-in owner or
       bookkeeper has already proved who they are with a hashed PIN (the bookkeeper may see the activity log, which lives in
       Settings), so pinOK() is let through for them: settings.adminPin is blanked for the duration of the call and put back.
       pinOK() treats a non-4-digit value as "no PIN set". Nothing else changes; a signed-in dispatcher is still asked. */
    if (typeof S.enter === 'function' && !S.enter.__recoverWrapped) {
      var origEnter = S.enter;
      var we = function (sectionId) {
        var out;
        if (sectionId === 'settings' && session && can('settings.open', role())) {
          var s = settings(), had = Object.prototype.hasOwnProperty.call(s, 'adminPin'), pin = s.adminPin;
          s.adminPin = '';
          try { out = origEnter.apply(this, arguments); }
          finally { if (had) s.adminPin = pin; else delete s.adminPin; if (had) save(); }
        } else out = origEnter.apply(this, arguments);
        try { maskSecrets(); } catch (e) {}      // the Settings view is now showing: hide the PIN / keys from anyone but the owner
        return out;
      };
      we.__recoverWrapped = true; we._orig = origEnter; S.enter = we;
    }
    /* Simple.undo (the API form of the Undo toast) restores stored trip copies directly: audit what changed, as 'undo' */
    if (typeof S.undo === 'function' && !S.undo.__recoverWrapped) {
      var origUndo = S.undo;
      var wu = function () { var pre = null; try { pre = snapAll(); } catch (e) { pre = null; } var r = origUndo.apply(this, arguments); try { afterAll(pre, 'undo'); } catch (e) {} return r; };
      wu.__recoverWrapped = true; wu._orig = origUndo; S.undo = wu;
    }
  }

  /* ---------- render hooks ---------- */
  function hookRender(name, after) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__recoverRender) return;
    var wrapped = function () { var out; try { out = orig.apply(this, arguments); } finally { try { after(); } catch (e) {} } return out; };
    wrapped.__recoverRender = true; wrapped._orig = orig;
    window[name] = wrapped;
  }
  function renderAll() { try { renderWho(); } catch (e) {} try { renderStaffPanel(); } catch (e) {} try { renderBackupPanel(); } catch (e) {} try { ensureOutageButton(); } catch (e) {} try { maskSecrets(); } catch (e) {} }
  /* Alt+6 (simple.js's keyboard shortcut for the Settings section) for a signed-in owner / bookkeeper: through our Simple.enter wrapper, no PIN prompt */
  function onCaptureKey(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.key !== '6') return;
    if (!(window.Simple && window.Simple.isSimple && window.Simple.isSimple())) return;
    var tag = (e.target && e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!settingsOpenFree()) return;
    e.stopImmediatePropagation(); e.preventDefault(); window.Simple.enter('settings');
  }

  /* ---------- public API ---------- */
  window.Recover = {
    _loaded: true, ROLES: ROLES, PERMS: PERMS, TLC_HEAD: TLC_HEAD,
    who: who, role: role, current: current, can: can, gate: gate, allowed: allowed, ownerPinOK: ownerPinOK, ownerHere: ownerHere, hasPin: hasPin,
    maskSecrets: maskSecrets, secretsMasked: secretsMasked, SECRET_IDS: SECRET_IDS,
    signIn: signIn, signOut: signOut, verifyPin: verifyPin, openSignIn: openDialog,
    staff: staff, addStaff: addStaff, setStaffPin: setStaffPin, setStaffRole: setStaffRole, setStaffActive: setStaffActive, removeStaff: removeStaff, migrateStaff: migrateStaff,
    log: log, audit: audit, auditRows: auditRows, auditCSV: auditCSV, exportAudit: exportAudit,
    tlcLint: tlcLint, tlcBuild: tlcBuild, tlcChecklist: tlcChecklist, tlcDownload: tlcDownload, tlcExport: tlcExport, exports: exportsLog,
    counts: counts, bundle: bundle, encryptBackup: encryptBackup, openBackup: openBackup, restoreTest: restoreTest, applyRestore: applyRestore,
    backup: doEncryptedBackup, plainBackup: doPlainBackup, downloadKeyFile: downloadKeyFile, restoreFromFile: restoreFromFile, loadKeyFile: loadKeyFile, confirmRestore: confirmRestore, pendingRestore: function () { return pendingRestore; },
    outageTrips: outageTrips, outageHTML: outageHTML, printOutageSheet: printOutageSheet,
    render: renderAll, renderStaff: renderStaffPanel, renderBackup: renderBackupPanel, security: sec, cryptoReady: cryptoReady
  };

  /* ---------- boot ---------- */
  function boot() {
    try { ensureStyle(); } catch (e) {}
    try { sec(); staff(); audit(); exportsLog(); } catch (e) {}
    try { session = loadSession(); } catch (e) { session = null; }
    try { migrateStaff().then(function () { return adoptLegacyPin(); }).then(function () { renderAll(); }); } catch (e) {}
    try { hookTrips(); } catch (e) {}
    try { hookLedger(); } catch (e) {}
    try { hookSimple(); } catch (e) {}
    hookRender('renderSettings', renderAll);
    hookRender('refreshBoard', function () { refreshNeedsYouMine(); ensureOutageButton(); });   // simple.js re-renders the strip inside refreshBoard; put our reminders back after it
    document.addEventListener('click', act(onCaptureClick), true);
    document.addEventListener('keydown', act(onCaptureKey), true);
    document.addEventListener('change', act(onCaptureChange), true);
    document.addEventListener('click', act(onBubbleClick), false);
    try { renderAll(); } catch (e) {}
    // modules that load after this one (ledger.js, simple.js) are hooked on the next ticks
    setTimeout(function () { try { hookLedger(); hookSimple(); ensureOutageButton(); renderWho(); } catch (e) {} }, 0);
    setTimeout(function () { try { hookLedger(); hookSimple(); ensureOutageButton(); refreshNeedsYouMine(); } catch (e) {} }, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
