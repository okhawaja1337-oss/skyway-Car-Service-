/* ======================================================================
   Skyway — crm.js
   Win-back worklist, outreach log, suppression / consent flags and the
   account pipeline (TURNAROUND-PLAN.md section 7 row 4; app-gaps.md §5;
   plan/customers.md §6).  Everything is local and offline-first: no network
   call is made here; Cloud hooks are optional.

   STATE keys this file owns (all initialised defensively, writes idempotent):
     STATE.crm = { worklist[], outreach[], pipeline[], settings{} }
       worklist[] : one row per workbook "customer row ID" — {id (= row ID), name, phone,
                    phoneKey, lastTrip, wave, status, nextAt, owner, suppress, queueLabel,
                    notes, source, linkedTripIds[], createdAt, updatedAt}
       outreach[] : one row per attempt, the workbook "Outreach log" columns —
                    {id, at, caller, channel, rowId, result, reasonCode, quote, tripId,
                     consentRead, wave, status, nextAt, owner, suppressFlag, linkedTripIds[]}
       pipeline[] : the Prospects list — {id, account, priority (A/B/C), buyer, nextAction,
                    owner, date, status (research … closed), notes}
     STATE.customers[] : one record per phone — {id, phoneKey, phone, name,
                    suppressCall, suppressText, suppressAt, suppressBy, suppressReason,
                    smsConsentInformational, smsConsentInformationalAt, smsConsentInformationalHow,
                    smsConsentMarketing, smsConsentMarketingAt, smsConsentMarketingHow,
                    smsOptOut, smsOptOutAt, updatedAt}
     trips[].crmRowId : the worklist row a booking came from (attribution; one trip → one row)

   Wrapped console globals (original kept as wrapper._orig, call-through, __crmWrapped flag):
     renderView, renderAccounts, refreshBoard, openCallerPopout, globalSearch,
     Messages.textPassenger / menu / smsHref, Money.payLink / paid / cash / noShowPaid,
     Cloud.fn (sms-out / notify refused for suppressed numbers), Simple.refreshNeedsYou.
   The #d_save handler is anonymous, so a capture + bubble pair of document listeners
   stamps crmRowId on the trip the dispatcher just booked (same approach as ops.js).

   UI: a "Win-back & accounts" panel at the bottom of #view-accounts (Simple mode:
   MONEY → Accounts; Expert: the Accounts tab), a banner on the caller pop
   (openCallerPopout), a "Win-back" group in the Ctrl-K search, a Needs-you line
   ("N win-back calls due today") and a consent checkbox on the Book form.

   Owner-only (settings.adminPin, same PIN as Settings / ledger.js): clearing a
   suppression flag, exporting the outreach log / customer list.
   Text that leaves the console goes through Messages.smsHref (gsmSafe inside).

   Public API: window.CRM (see bottom). Plain ES2019, no build step. Never edits index.html.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;

  /* SCREEN is a top-level const in index.html (lexical global, not on window) */
  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }
  if (window.CRM && window.CRM._loaded) return;

  /* ---------- helpers (own copies; globals may be missing) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[crm] ' + m); } catch (e) {} }
  function save() { if (typeof window.save === 'function') { try { window.save(); return; } catch (e) {} } }
  function saveNow() { if (typeof window.saveNow === 'function') { try { window.saveNow(); return; } catch (e) {} } save(); }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  function trips() { return Array.isArray(STATE.trips) ? STATE.trips : []; }
  function findTrip(id) { if (id && typeof id === 'object') return id; return trips().filter(function (t) { return t.id === id; })[0] || null; }
  function findDriver(id) { return (STATE.drivers || []).filter(function (d) { return d.id === id; })[0] || null; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayStr() { if (typeof window.todayStr === 'function') { try { return window.todayStr(); } catch (e) {} } var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function nowISO() { return new Date().toISOString(); }
  function uid() { if (typeof window.uid === 'function') { try { return window.uid(); } catch (e) {} } return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { try { console.error('[crm]', err); } catch (e2) {} } }; }
  function shortAddr(a) { if (typeof window.shortAddr === 'function') { try { return window.shortAddr(a); } catch (e) {} } return String(a || '').split(',')[0].trim(); }
  function fmtPhone(p) { if (window.Region && typeof window.Region.fmtPhone === 'function') { try { return window.Region.fmtPhone(p); } catch (e) {} } return p || ''; }
  function fmtDate(s) { if (typeof window.fmtDate === 'function') { try { return window.fmtDate(s); } catch (e) {} } return s || ''; }
  function money(n) { if (typeof window.money === 'function') { try { return window.money(n); } catch (e) {} } n = Number(n) || 0; return '$' + n.toFixed(2); }
  function bizName() { return settings().name || 'Skyway Car Service'; }
  function addDays(ymd, n) { var p = String(ymd || todayStr()).split('-').map(Number); if (p.length !== 3) return todayStr(); var d = new Date(p[0], p[1] - 1, p[2] + n); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function dateOf(iso) { var s = String(iso || ''); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; var d = new Date(s); if (isNaN(d)) return s.slice(0, 10); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function stamp(iso) { var d = new Date(iso); if (isNaN(d)) return String(iso || ''); return dateOf(d.toISOString()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  /* phone → last 10 digits (same rule as index.html phoneDigits + findCaller) */
  function phoneDigits(p) { var d = String(p || '').replace(/\D/g, ''); if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1); return d; }
  function phoneKey(p) { var d = phoneDigits(p); return d.length >= 7 ? d.slice(-10) : ''; }
  function csvCell(v) {
    if (typeof window.csv === 'function') { try { return window.csv(v); } catch (e) {} }
    v = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = "'" + v;
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function downloadFile(name, content, type) {
    if (typeof window.download === 'function') { try { window.download(name, content, type); return true; } catch (e) {} }
    try { var blob = new Blob([content], { type: type || 'text/csv' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000); return true; } catch (e) { return false; }
  }
  /* RFC-4180-ish CSV → array of arrays (quotes, doubled quotes, CR/LF inside quotes) */
  function parseCSV(text) {
    var rows = [], row = [], c = '', q = false, s = String(text || '').replace(/^﻿/, '');
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) { if (ch === '"') { if (s[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(c); c = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(c); c = ''; if (row.some(function (x) { return x.trim(); })) rows.push(row); row = []; }
      else c += ch;
    }
    row.push(c); if (row.some(function (x) { return x.trim(); })) rows.push(row);
    return rows;
  }
  function normHead(h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function yes(v) { return /^(y|yes|true|1|x|read)$/i.test(String(v || '').trim()); }
  function initials() { var s = crm().settings; return String(s.caller || '').trim(); }

  /* ---------- owner PIN (settings.adminPin — simple.js's PIN, once per session like Settings / ledger.js) ---------- */
  var unlocked = false, hinted = false;
  /* recover.js: a signed-in owner (or an owner PIN already given to recover.js this session) is not asked again */
  function recoverOwner() { try { var R = window.Recover; return !!(R && R._loaded && typeof R.who === 'function' && R.who() && R.role() === 'owner'); } catch (e) { return false; } }
  function ownerPinOK(what) {
    if (recoverOwner()) return true;
    var pin = String(settings().adminPin || '').trim();
    if (!/^\d{4}$/.test(pin)) { if (!hinted) { hinted = true; toast('No admin PIN is set — set one in Settings so customer exports and un-suppressing are owner-only.'); } return true; }
    if (unlocked) return true;
    var a = null; try { a = window.prompt('Owner PIN to ' + (what || 'continue') + ':', ''); } catch (e) { a = null; }
    if (a === null) return false;
    if (String(a).trim() === pin) { unlocked = true; return true; }
    toast('Wrong PIN.', true); return false;
  }

  /* ---------- STATE.crm / STATE.customers (defensive init) ---------- */
  function crm() {
    var c = STATE.crm;
    if (!c || typeof c !== 'object' || Array.isArray(c)) c = STATE.crm = {};
    if (!Array.isArray(c.worklist)) c.worklist = [];
    if (!Array.isArray(c.outreach)) c.outreach = [];
    if (!Array.isArray(c.pipeline)) c.pipeline = [];
    if (!c.settings || typeof c.settings !== 'object') c.settings = {};
    return c;
  }
  function customers() { if (!Array.isArray(STATE.customers)) STATE.customers = []; return STATE.customers; }
  function worklist() { return crm().worklist; }
  function outreach() { return crm().outreach; }
  function pipeline() { return crm().pipeline; }
  function findRow(id) { if (id && typeof id === 'object') return id; return worklist().filter(function (r) { return r.id === id; })[0] || null; }
  function rowsForPhone(p) { var k = phoneKey(p); if (!k) return []; return worklist().filter(function (r) { return r.phoneKey === k; }); }

  /* ---------- customers: suppression + consent ---------- */
  function custFor(phone, create) {
    var k = phoneKey(phone); if (!k) return null;
    var list = customers(), c = list.filter(function (x) { return x.phoneKey === k; })[0] || null;
    if (!c && create) { c = { id: 'cu_' + k, phoneKey: k, phone: String(phone || '').trim(), name: '', suppressCall: false, suppressText: false, smsConsentInformational: false, smsConsentMarketing: false, smsOptOut: false, updatedAt: nowISO() }; list.push(c); }
    return c;
  }
  function textBlock(phone) {
    var c = custFor(phone, false); if (!c) return null;
    if (c.suppressText) return { kind: 'suppressed', reason: 'Do not text' + (c.suppressReason ? ' — ' + c.suppressReason : '') + (c.suppressAt ? ' (since ' + dateOf(c.suppressAt) + ')' : '') };
    if (c.smsOptOut) return { kind: 'optout', reason: 'Replied STOP' + (c.smsOptOutAt ? ' on ' + dateOf(c.smsOptOutAt) : '') };
    return null;
  }
  function callBlock(phone) {
    var c = custFor(phone, false); if (!c || !c.suppressCall) return null;
    return { kind: 'suppressed', reason: 'Do not call' + (c.suppressReason ? ' — ' + c.suppressReason : '') + (c.suppressAt ? ' (since ' + dateOf(c.suppressAt) + ')' : '') };
  }
  function isSuppressed(phone) { return !!(textBlock(phone) || callBlock(phone)); }
  /* marketing templates (review requests, offers, win-back texts) need the written opt-in; ride updates do not */
  var MARKETING_RE = /review|offer|promo|market|winback|win-back|campaign|newsletter|survey/i;
  function isMarketingKey(key) { return MARKETING_RE.test(String(key || '')); }
  function hasMarketingConsent(phone) { var c = custFor(phone, false); return !!(c && c.smsConsentMarketing); }
  function hasInfoConsent(phone) { var c = custFor(phone, false); return !!(c && c.smsConsentInformational); }
  /* canText(phone, templateKey) → {ok, reason} — the one rule every texting path asks */
  function canText(phone, key) {
    if (!phoneKey(phone)) return { ok: false, reason: 'No phone number.' };
    var b = textBlock(phone); if (b) return { ok: false, reason: b.reason, kind: b.kind };
    if (isMarketingKey(key) && !hasMarketingConsent(phone)) return { ok: false, reason: 'No written marketing opt-in on file for ' + fmtPhone(phone) + ' — this text is promotional.', kind: 'marketing' };
    return { ok: true, reason: '' };
  }
  function suppress(phone, opts) {
    opts = opts || {};
    var c = custFor(phone, true); if (!c) { toast('Enter a phone number first.', true); return null; }
    var call = opts.call !== false, text = opts.text !== false;   // default: both
    c.suppressCall = !!(c.suppressCall || call); c.suppressText = !!(c.suppressText || text);
    if (!c.suppressAt) c.suppressAt = nowISO();
    if (opts.reason) c.suppressReason = String(opts.reason).trim();
    if (opts.by || initials()) c.suppressBy = opts.by || initials();
    if (opts.name && !c.name) c.name = opts.name;
    c.updatedAt = nowISO();
    rowsForPhone(phone).forEach(function (r) { r.suppress = flagText(c); r.status = 'suppressed'; r.updatedAt = nowISO(); });
    save(); render(); refreshBoardIfAny();
    toast(fmtPhone(phone) + ': ' + flagText(c) + ' — every text and call button for this number is now blocked.');
    return c;
  }
  function unsuppress(phone) {
    var c = custFor(phone, false); if (!c) return false;
    if (!ownerPinOK('clear the do-not-contact flag for ' + fmtPhone(phone))) return false;
    c.suppressCall = false; c.suppressText = false; c.suppressAt = ''; c.suppressReason = ''; c.updatedAt = nowISO();
    rowsForPhone(phone).forEach(function (r) { r.suppress = ''; if (r.status === 'suppressed') r.status = 'not_started'; r.updatedAt = nowISO(); });
    save(); render(); refreshBoardIfAny();
    toast('Flag cleared for ' + fmtPhone(phone) + '.');
    return true;
  }
  function flagText(c) { if (!c) return ''; if (c.suppressCall && c.suppressText) return 'do-not-contact'; if (c.suppressCall) return 'do-not-call'; if (c.suppressText) return 'do-not-text'; return ''; }
  /* kind: 'informational' (consent sentence read at booking) | 'marketing' (written opt-in only) */
  function setConsent(phone, kind, how, name) {
    var c = custFor(phone, true); if (!c) return null;
    var at = nowISO(), ver = consentVersion();
    if (kind === 'marketing') {
      if (!/^(written|signed form|text reply|email|web form|written form)$/i.test(String(how || ''))) { toast('Marketing opt-in must be written (text reply, signed form, email or web form).', true); return null; }
      if (!c.smsConsentMarketing) { c.smsConsentMarketing = true; c.smsConsentMarketingAt = at; c.smsConsentMarketingHow = how; c.smsConsentMarketingVersion = ver; }
    } else {
      if (!c.smsConsentInformational) { c.smsConsentInformational = true; c.smsConsentInformationalAt = at; c.smsConsentInformationalHow = how || 'phone'; c.smsConsentInformationalVersion = ver; }
    }
    if (name && !c.name) c.name = name;
    c.updatedAt = at; save();
    return c;
  }
  function consentSentence() { try { if (window.Messages && typeof window.Messages.consentSentence === 'string') return window.Messages.consentSentence; } catch (e) {} return 'By booking you agree to receive ride updates by text; reply STOP to opt out.'; }
  function consentVersion() { var s = consentSentence(), h = 0; for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return 'v' + (h >>> 0).toString(36); }
  function optOut(phone) { var c = custFor(phone, true); if (!c) return null; if (!c.smsOptOut) { c.smsOptOut = true; c.smsOptOutAt = nowISO(); } c.updatedAt = nowISO(); save(); render(); return c; }

  /* ---------- worklist ---------- */
  var RESULTS = ['no_answer', 'voicemail', 'reached', 'busy', 'bad_number', 'declined', 'booked'];
  var RESULT_LABEL = { no_answer: 'no answer', voicemail: 'voicemail', reached: 'reached', busy: 'busy', bad_number: 'bad number', declined: 'declined', booked: 'booked' };
  var REASONS = ['', 'price', 'late', 'missed_call', 'driver', 'no_longer_travel', 'moved', 'using_app', 'unknown'];
  var STATUSES = ['not_started', 'attempt_1', 'attempt_2', 'attempt_3', 'reached', 'booked', 'recurring', 'declined', 'bad_number', 'suppressed', 'unmatched_archived'];
  var WAVES = ['this_week', 'next_two_weeks', 'later', 'verify_only', 'keep_active'];
  var CLOSED = { declined: 1, bad_number: 1, suppressed: 1, unmatched_archived: 1 };
  function normResult(v) { var s = String(v || '').toLowerCase().trim().replace(/[\s-]+/g, '_'); if (s === 'noanswer') s = 'no_answer'; if (s === 'badnumber' || s === 'bad_no' || s === 'wrong_number') s = 'bad_number'; if (s === 'vm' || s === 'left_message' || s === 'left_msg') s = 'voicemail'; if (s === 'conversation' || s === 'spoke') s = 'reached'; return RESULTS.indexOf(s) >= 0 ? s : ''; }
  function normWave(v) { var s = String(v || '').toLowerCase().trim().replace(/[\s-]+/g, '_'); if (/first|^1$|this/.test(s)) return 'this_week'; if (/second|^2$|next/.test(s)) return 'next_two_weeks'; if (/later|third|^3$/.test(s)) return 'later'; if (/verify|match/.test(s)) return 'verify_only'; if (/keep|retain|active/.test(s)) return 'keep_active'; return WAVES.indexOf(s) >= 0 ? s : (s || 'later'); }
  function normStatus(v) { var s = String(v || '').toLowerCase().trim().replace(/[\s-]+/g, '_'); if (!s || s === 'open' || s === 'new') return 'not_started'; if (/^attempt_?(\d)$/.test(s)) return 'attempt_' + s.match(/(\d)$/)[1]; if (s === 'do_not_contact' || s === 'do_not_call' || s === 'dnc' || s === 'stop') return 'suppressed'; if (s === 'repeat' || s === 'standing') return 'recurring'; if (s === 'called') return 'attempt_1'; return STATUSES.indexOf(s) >= 0 ? s : 'not_started'; }
  function splitIds(v) { return String(v || '').split(/[;,|\s]+/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function newRow(id, data) {
    var r = { id: String(id), name: '', phone: '', phoneKey: '', lastTrip: '', wave: 'later', status: 'not_started', nextAt: '', owner: '', suppress: '', queueLabel: '', notes: '', source: 'manual', linkedTripIds: [], createdAt: nowISO(), updatedAt: nowISO() };
    Object.keys(data || {}).forEach(function (k) { if (data[k] !== undefined && data[k] !== null && data[k] !== '') r[k] = data[k]; });
    r.phoneKey = phoneKey(r.phone);
    return r;
  }
  function nextRowId() { var n = 0; worklist().forEach(function (r) { var m = String(r.id).match(/^WB-(\d+)$/); if (m) n = Math.max(n, Number(m[1])); }); return 'WB-' + pad2(n + 1); }
  function addRow(data) {
    data = data || {};
    var id = String(data.id || data.rowId || '').trim() || nextRowId();
    var existing = findRow(id);
    if (existing) { ['name', 'phone', 'lastTrip', 'wave', 'owner', 'nextAt', 'notes', 'queueLabel'].forEach(function (k) { if (data[k]) existing[k] = data[k]; }); existing.phoneKey = phoneKey(existing.phone); existing.updatedAt = nowISO(); save(); return existing; }
    var r = newRow(id, { name: data.name, phone: data.phone, lastTrip: data.lastTrip, wave: data.wave ? normWave(data.wave) : 'later', status: data.status ? normStatus(data.status) : 'not_started', owner: data.owner, nextAt: data.nextAt, notes: data.notes, queueLabel: data.queueLabel, source: data.source || 'manual' });
    var c = custFor(r.phone, false); if (c) { r.suppress = flagText(c); if (r.suppress) r.status = 'suppressed'; if (!r.name && c.name) r.name = c.name; }
    worklist().push(r); save(); return r;
  }
  function removeRow(id) { var c = crm(); var n = c.worklist.length; c.worklist = c.worklist.filter(function (r) { return r.id !== id; }); if (c.worklist.length !== n) { save(); render(); } return c.worklist.length !== n; }

  /* Match a row to the console's own history by phone: usual route, usual driver, last three trips.
     Sources: STATE.trips (live records) then CALLERBOOK (the imported caller directory) for the usual route. */
  function matchRow(row) {
    row = findRow(row); if (!row) return null;
    var k = row.phoneKey, out = { known: false, tripCount: 0, usualRoute: null, usualDriver: null, lastTrips: [], usualFare: 0 };
    if (!k) return out;
    var mine = trips().filter(function (t) { return t && t.phone && phoneKey(t.phone) === k && t.status !== 'Disregard'; })
      .sort(function (a, b) { var ka = (a.date || '') + ' ' + (a.time || ''), kb = (b.date || '') + ' ' + (b.time || ''); return ka < kb ? 1 : ka > kb ? -1 : 0; });
    out.tripCount = mine.length;
    if (mine.length) {
      out.known = true;
      out.lastTrips = mine.slice(0, 3).map(function (t) { return { id: t.id, dispatchNo: t.dispatchNo, date: t.date, time: t.time, pu: t.puAddr, do: t.doAddr, fare: Number(t.fare) || 0, status: t.status, driverId: t.driverId || '' }; });
      var routes = {}, drivers = {}, fares = [];
      mine.forEach(function (t) {
        var rk = shortAddr(t.puAddr).toUpperCase() + ' > ' + shortAddr(t.doAddr).toUpperCase();
        routes[rk] = routes[rk] || { pu: t.puAddr, do: t.doAddr, n: 0 }; routes[rk].n++;
        if (t.driverId) drivers[t.driverId] = (drivers[t.driverId] || 0) + 1;
        if (Number(t.fare) > 0 && t.status === 'Completed') fares.push(Number(t.fare));
      });
      var top = Object.keys(routes).map(function (x) { return routes[x]; }).sort(function (a, b) { return b.n - a.n; })[0];
      if (top) out.usualRoute = top;
      var dk = Object.keys(drivers).sort(function (a, b) { return drivers[b] - drivers[a]; })[0];
      if (dk) { var d = findDriver(dk); out.usualDriver = { id: dk, name: d ? d.name : '(driver removed)', n: drivers[dk] }; }
      if (fares.length) { fares.sort(function (a, b) { return a - b; }); out.usualFare = fares[Math.floor(fares.length / 2)]; }
      if (!row.lastTrip && mine[0].date) row.lastTrip = mine[0].date;
    }
    if (!out.usualRoute) {
      var cb = null; try { if (typeof window.lookupCaller === 'function') cb = window.lookupCaller(k); } catch (e) { cb = null; }
      if (cb) { out.known = true; if (cb.pu) out.usualRoute = { pu: cb.pu, do: cb.do || '', n: Number(cb.n) || 0, fromDirectory: true }; if (!out.usualFare && cb.f) out.usualFare = Number(cb.f) || 0; if (!row.lastTrip && cb.last) row.lastTrip = cb.last; }
    }
    return out;
  }

  /* ---------- imports ---------- */
  /* Win-back list: row ID, name, phone, last trip, wave (header names matched loosely, order free) */
  var WB_COLS = { rowId: ['rowid', 'customerrowid', 'id', 'row'], name: ['name', 'customer', 'customername'], phone: ['phone', 'phonee164', 'phonenumber', 'number', 'tel'], lastTrip: ['lasttrip', 'lastride', 'lastrideat', 'lastpaid', 'lastpaidat', 'lastpayment'], wave: ['wave', 'queue', 'queuelabel'], owner: ['owner'], notes: ['notes', 'onequestion', 'whattocheckoroffer', 'question'] };
  function colIndex(head, names) { for (var i = 0; i < names.length; i++) { var j = head.indexOf(names[i]); if (j >= 0) return j; } return -1; }
  function importWinback(text) {
    var rows = parseCSV(text); if (rows.length < 2) { toast('Paste the win-back list with a header row and at least one row.', true); return { ok: false, error: 'empty' }; }
    var head = rows[0].map(normHead), ix = {};
    Object.keys(WB_COLS).forEach(function (k) { ix[k] = colIndex(head, WB_COLS[k]); });
    var missing = ['rowId', 'name', 'phone'].filter(function (k) { return ix[k] < 0; });
    if (missing.length) { toast('Win-back list needs these columns: row ID, name, phone (missing: ' + missing.join(', ') + ').', true); return { ok: false, error: 'missing', missing: missing }; }
    var res = { ok: true, added: 0, updated: 0, matched: 0, unmatched: 0, skipped: 0, ids: [] };
    rows.slice(1).forEach(function (c) {
      var id = String(c[ix.rowId] || '').trim(), phone = String(c[ix.phone] || '').trim(), name = String(c[ix.name] || '').trim();
      if (!id && !phone) { res.skipped++; return; }
      var before = !!findRow(id || ('WB-' + phoneKey(phone)));
      var r = addRow({ id: id || ('WB-' + phoneKey(phone)), name: name, phone: phone, lastTrip: ix.lastTrip >= 0 ? String(c[ix.lastTrip] || '').trim() : '', wave: ix.wave >= 0 ? c[ix.wave] : '', owner: ix.owner >= 0 ? c[ix.owner] : '', notes: ix.notes >= 0 ? c[ix.notes] : '', queueLabel: ix.wave >= 0 ? String(c[ix.wave] || '').trim() : '', source: 'winback' });
      if (before) res.updated++; else res.added++;
      var m = matchRow(r); if (m && m.known) res.matched++; else res.unmatched++;
      res.ids.push(r.id);
    });
    saveNow(); render();
    toast('Win-back list: ' + res.added + ' added, ' + res.updated + ' updated · ' + res.matched + ' matched to your history, ' + res.unmatched + ' unmatched.');
    return res;
  }
  /* The workbook "Outreach log" tab — exactly these 15 columns (order free, names matched loosely) */
  var OL_COLS = [
    ['at', 'date/time', ['datetime', 'date', 'when', 'at']],
    ['caller', 'caller', ['caller', 'callerALDL', 'by', 'who', 'whocalled', 'calleraldl']],
    ['channel', 'channel', ['channel']],
    ['rowId', 'customer row ID', ['customerrowid', 'rowid', 'customerrow', 'customerid']],
    ['result', 'result', ['result', 'outcome']],
    ['reasonCode', 'reason code', ['reasoncode', 'reason']],
    ['quote', 'quote given', ['quotegiven', 'quote']],
    ['tripId', 'trip ID booked', ['tripidbooked', 'tripid', 'tripbooked', 'trip']],
    ['consentRead', 'consent read Y/N', ['consentreadyn', 'consentread', 'consent']],
    ['wave', 'wave', ['wave']],
    ['status', 'status', ['status']],
    ['nextAt', 'next action date', ['nextactiondate', 'nextaction', 'nextdate', 'next']],
    ['owner', 'owner', ['owner']],
    ['suppressFlag', 'suppression flag', ['suppressionflag', 'suppression', 'suppress', 'suppressed', 'dnc']],
    ['linkedTripIds', 'linked trip IDs', ['linkedtripids', 'linkedtrips', 'linked']]
  ];
  function importOutreach(text) {
    var rows = parseCSV(text); if (rows.length < 1) { toast('Paste the Outreach log with its header row.', true); return { ok: false, error: 'empty' }; }
    var head = rows[0].map(normHead), ix = {}, missing = [];
    OL_COLS.forEach(function (col) { ix[col[0]] = colIndex(head, col[2].map(normHead)); if (ix[col[0]] < 0) missing.push(col[1]); });
    if (missing.length) { toast('Outreach log must have exactly the workbook columns. Missing: ' + missing.join(' · '), true); return { ok: false, error: 'missing', missing: missing }; }
    var res = { ok: true, added: 0, duplicates: 0, rowsTouched: 0, suppressed: 0, consents: 0, skipped: 0 };
    rows.slice(1).forEach(function (c) {
      var g = function (k) { return String(c[ix[k]] == null ? '' : c[ix[k]]).trim(); };
      var rowId = g('rowId'); if (!rowId) { res.skipped++; return; }
      var atRaw = g('at'), atD = new Date(atRaw), at = isNaN(atD) ? atRaw : atD.toISOString();
      var e = { id: 'ol_' + hash(rowId + '|' + at + '|' + g('result') + '|' + g('caller')), at: at, caller: g('caller'), channel: g('channel') || 'call', rowId: rowId, result: normResult(g('result')) || g('result').toLowerCase(), reasonCode: g('reasonCode'), quote: g('quote'), tripId: g('tripId'), consentRead: yes(g('consentRead')), wave: normWave(g('wave')), status: normStatus(g('status')), nextAt: g('nextAt'), owner: g('owner'), suppressFlag: g('suppressFlag'), linkedTripIds: splitIds(g('linkedTripIds')), source: 'import' };
      if (outreach().some(function (x) { return x.id === e.id; })) { res.duplicates++; return; }
      outreach().push(e); res.added++;
      var r = findRow(rowId) || addRow({ id: rowId, wave: e.wave, source: 'outreach' });
      res.rowsTouched++;
      if (e.wave) r.wave = e.wave;
      if (e.status) r.status = e.status;
      if (e.nextAt) r.nextAt = e.nextAt;
      if (e.owner) r.owner = e.owner;
      e.linkedTripIds.forEach(function (id) { if (r.linkedTripIds.indexOf(id) < 0) r.linkedTripIds.push(id); var t = findTrip(id) || trips().filter(function (x) { return String(x.dispatchNo) === id; })[0]; if (t && !t.crmRowId) t.crmRowId = r.id; });
      if (e.tripId) { if (r.linkedTripIds.indexOf(e.tripId) < 0) r.linkedTripIds.push(e.tripId); var tb = findTrip(e.tripId) || trips().filter(function (x) { return String(x.dispatchNo) === e.tripId; })[0]; if (tb && !tb.crmRowId) tb.crmRowId = r.id; }
      r.updatedAt = nowISO();
      var flag = e.suppressFlag.toLowerCase();
      if (r.phone && flag && !/^(n|no|none|false|0|-)$/.test(flag)) {
        var textOnly = /text|sms/.test(flag) && !/call|contact|both/.test(flag), callOnly = /call/.test(flag) && !/text|sms|contact|both/.test(flag);
        suppressQuiet(r.phone, { call: !textOnly, text: !callOnly, reason: 'Outreach log: ' + e.suppressFlag, by: e.caller, name: r.name }); res.suppressed++;
      }
      if (r.phone && e.consentRead) { setConsent(r.phone, 'informational', 'phone', r.name); res.consents++; }
      if (e.result === 'bad_number' && !CLOSED[r.status]) r.status = 'bad_number';
    });
    saveNow(); render();
    toast('Outreach log: ' + res.added + ' attempts imported (' + res.duplicates + ' already there), ' + res.rowsTouched + ' rows updated' + (res.suppressed ? ', ' + res.suppressed + ' suppression flags' : '') + '.');
    return res;
  }
  function suppressQuiet(phone, opts) { var c = custFor(phone, true); if (!c) return null; if (opts.call) c.suppressCall = true; if (opts.text) c.suppressText = true; if (!c.suppressAt) c.suppressAt = nowISO(); if (opts.reason && !c.suppressReason) c.suppressReason = opts.reason; if (opts.by) c.suppressBy = opts.by; if (opts.name && !c.name) c.name = opts.name; c.updatedAt = nowISO(); rowsForPhone(phone).forEach(function (r) { r.suppress = flagText(c); r.status = 'suppressed'; }); return c; }
  function hash(s) { var h = 0x811c9dc5; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ('00000000' + h.toString(16)).slice(-8); }
  /* Export the outreach log back as CSV — the same 15 columns. Owner-only (customer list). */
  function outreachCSV() {
    var head = OL_COLS.map(function (c) { return c[1]; });
    var lines = [head.map(csvCell).join(',')];
    outreach().slice().sort(function (a, b) { return String(a.at) < String(b.at) ? -1 : 1; }).forEach(function (e) {
      var r = findRow(e.rowId);
      lines.push([stamp(e.at), e.caller, e.channel, e.rowId, RESULT_LABEL[e.result] || e.result, e.reasonCode, e.quote, e.tripId, e.consentRead ? 'Y' : 'N', e.wave || (r && r.wave) || '', e.status || (r && r.status) || '', e.nextAt || (r && r.nextAt) || '', e.owner || (r && r.owner) || '', e.suppressFlag || (r && r.suppress) || '', (e.linkedTripIds && e.linkedTripIds.length ? e.linkedTripIds : (r ? r.linkedTripIds : [])).join(';')].map(csvCell).join(','));
    });
    return lines.join('\r\n');
  }
  function exportOutreach() {
    if (!ownerPinOK('export the outreach log')) return '';
    var text = outreachCSV();
    downloadFile('outreach-log-' + todayStr() + '.csv', text, 'text/csv');
    toast('Outreach log exported (' + outreach().length + ' attempts). Keep the file on the private drive.');
    return text;
  }
  /* Worklist as CSV (row ID, name, phone, last trip, wave, status, next action, owner, suppression, linked trips, paid return rides) — owner-only */
  function exportWorklist() {
    if (!ownerPinOK('export the win-back list')) return '';
    var lines = [['row ID', 'name', 'phone', 'last trip', 'wave', 'status', 'next action date', 'owner', 'suppression flag', 'linked trip IDs', 'paid return rides'].map(csvCell).join(',')];
    worklist().forEach(function (r) { lines.push([r.id, r.name, r.phone, r.lastTrip, r.wave, r.status, r.nextAt, r.owner, r.suppress, (r.linkedTripIds || []).join(';'), paidRides(r).length].map(csvCell).join(',')); });
    var text = lines.join('\r\n'); downloadFile('win-back-list-' + todayStr() + '.csv', text, 'text/csv'); return text;
  }

  /* ---------- outcome logging ---------- */
  function attempts(row) { var id = typeof row === 'object' ? row.id : row; return outreach().filter(function (e) { return e.rowId === id; }).sort(function (a, b) { return String(a.at) < String(b.at) ? 1 : -1; }); }
  function callAttempts(row) { return attempts(row).filter(function (e) { return e.result !== 'booked' && e.channel !== 'system'; }); }
  function logOutcome(rowId, o) {
    var r = findRow(rowId); if (!r) { toast('Win-back row not found.', true); return null; }
    o = o || {};
    var result = normResult(o.result); if (!result) { toast('Pick a result: no answer, voicemail, reached, busy, bad number, declined or booked.', true); return null; }
    var who = String(o.caller || initials() || '').trim();
    if (!who) { try { who = String(window.prompt('Your initials (who made this call)?', '') || '').trim(); } catch (e) { who = ''; } if (!who) { toast('Enter your initials first (top of the panel).', true); return null; } crm().settings.caller = who; }
    var e = { id: 'ol_' + uid(), at: o.at || nowISO(), caller: who, channel: o.channel || 'call', rowId: r.id, result: result, reasonCode: REASONS.indexOf(String(o.reasonCode || '')) >= 0 ? String(o.reasonCode || '') : String(o.reasonCode || '').trim(), quote: o.quote != null && o.quote !== '' ? String(o.quote) : '', tripId: o.tripId || '', consentRead: !!o.consentRead, wave: r.wave, status: '', nextAt: '', owner: who, suppressFlag: r.suppress || '', linkedTripIds: r.linkedTripIds.slice(), note: String(o.note || '').trim(), source: 'console' };
    var n = callAttempts(r).length + (result === 'booked' ? 0 : 1);
    if (result === 'booked') { r.status = 'booked'; r.nextAt = ''; }
    else if (result === 'reached') { r.status = 'reached'; r.nextAt = o.nextAt || addDays(todayStr(), 7); }
    else if (result === 'declined') { r.status = 'declined'; r.nextAt = ''; }
    else if (result === 'bad_number') { r.status = 'bad_number'; r.nextAt = ''; }
    else { r.status = n >= 3 ? 'attempt_3' : 'attempt_' + Math.max(1, n); r.nextAt = n >= 3 ? '' : (o.nextAt || addDays(todayStr(), 1)); }
    if (o.nextAt) r.nextAt = o.nextAt;
    if (r.suppress) r.status = 'suppressed';
    r.owner = r.owner || who; r.updatedAt = nowISO();
    e.status = r.status; e.nextAt = r.nextAt;
    if (e.consentRead && r.phone) setConsent(r.phone, 'informational', 'phone', r.name);
    outreach().push(e);
    save(); render(); refreshNeedsYou();
    return e;
  }

  /* ---------- booking from a row + attribution ---------- */
  var pending = null;   // {rowId, at} — the row a booking is about to come from
  var PENDING_MS = 30 * 60000, RECENT_DAYS = 14;
  function bookFrom(rowId) {
    var r = findRow(rowId); if (!r) return false;
    if (callBlock(r.phone)) { toast('Do not call ' + fmtPhone(r.phone) + ' — ' + callBlock(r.phone).reason + '. Booking is only allowed if they called you.', true); }
    if (!r.phone) { toast('This row has no phone number — add one first.', true); return false; }
    pending = { rowId: r.id, at: Date.now(), phoneKey: r.phoneKey };
    try { if (typeof window.openCallerPopout === 'function') { window.openCallerPopout(r.phone); return true; } } catch (e) {}
    try { if (typeof window.applyCaller === 'function') { window.applyCaller(r.phone, r.name); return true; } } catch (e) {}
    return false;
  }
  function attribute(trip, rowId) {
    var t = findTrip(trip), r = findRow(rowId); if (!t || !r) return false;
    if (t.crmRowId && t.crmRowId !== r.id) return false;         // one trip → one row, never re-attributed
    var changed = false;
    if (t.crmRowId !== r.id) { t.crmRowId = r.id; changed = true; }
    if (r.linkedTripIds.indexOf(t.id) < 0) { r.linkedTripIds.push(t.id); changed = true; }
    if (!CLOSED[r.status] && r.status !== 'recurring' && r.status !== 'booked') { r.status = 'booked'; r.nextAt = ''; changed = true; }
    if (changed) {
      var e = { id: 'ol_' + uid(), at: nowISO(), caller: initials() || 'console', channel: 'system', rowId: r.id, result: 'booked', reasonCode: '', quote: Number(t.fare) > 0 ? String(t.fare) : '', tripId: t.id, consentRead: hasInfoConsent(t.phone), wave: r.wave, status: r.status, nextAt: r.nextAt, owner: r.owner, suppressFlag: r.suppress || '', linkedTripIds: r.linkedTripIds.slice(), note: 'Booked #' + (t.dispatchNo || '') + ' from the win-back row', source: 'console' };
      outreach().push(e);
      r.updatedAt = nowISO(); save();
    }
    return true;
  }
  function recentAttemptRow(phone) {
    var rows = rowsForPhone(phone).filter(function (r) { return !r.suppress; }); if (rows.length !== 1) return null;
    var since = Date.now() - RECENT_DAYS * 86400000;
    return attempts(rows[0]).some(function (e) { var d = new Date(e.at); return !isNaN(d) && d.getTime() >= since; }) ? rows[0] : null;
  }
  /* a trip was just booked (new, not edited): decide which row it belongs to */
  function afterBook(t) {
    if (!t || t.crmRowId) return null;
    var k = phoneKey(t.phone), r = null;
    if (pending && Date.now() - pending.at < PENDING_MS) { var pr = findRow(pending.rowId); if (pr && k && (!pr.phoneKey || pr.phoneKey === k)) r = pr; }   // a booking with no phone is never tied to the pending row
    pending = null;
    if (!r && k) r = recentAttemptRow(t.phone);
    if (!r) return null;
    attribute(t, r.id);
    toast('#' + (t.dispatchNo || '') + ' is tied to win-back row ' + r.id + (r.name ? ' (' + r.name + ')' : '') + '.');
    render();
    return r;
  }
  function isPaid(t) { return !!(t && t.status === 'Completed' && t.payment && t.payment.status === 'paid'); }
  function linkedTrips(row) { row = findRow(row); if (!row) return []; return trips().filter(function (t) { return t && t.crmRowId === row.id; }); }
  function paidRides(row) { return linkedTrips(row).filter(isPaid).sort(function (a, b) { return String((a.payment || {}).at || '') < String((b.payment || {}).at || '') ? -1 : 1; }); }
  function allPaidRides() { return trips().filter(function (t) { return t && t.crmRowId && isPaid(t) && findRow(t.crmRowId); }).sort(function (a, b) { return String((a.payment || {}).at || '') < String((b.payment || {}).at || '') ? -1 : 1; }); }
  var PAID_TARGET = 3;
  /* "paid return ride n/3": n = this ride's ordinal among every paid return ride (Day-14 target 3) */
  function paidLabel(row) {
    var mine = paidRides(row); if (!mine.length) return '';
    var all = allPaidRides(), n = all.indexOf(mine[mine.length - 1]) + 1;
    return 'paid return ride ' + n + '/' + PAID_TARGET + (mine.length > 1 ? ' (' + mine.length + ' rides)' : '');
  }
  function isRecurring(row) { var td = todayStr(); return linkedTrips(row).filter(function (t) { return t.date > td && t.status === 'Booked'; }).length >= 2; }
  function syncDerivedStatus() {
    var dirty = false;
    worklist().forEach(function (r) {
      if (CLOSED[r.status]) return;
      if (isRecurring(r) && r.status !== 'recurring') { r.status = 'recurring'; dirty = true; }
      else if (!isRecurring(r) && r.status === 'recurring' && linkedTrips(r).length) { r.status = 'booked'; dirty = true; }
    });
    if (dirty) save();
  }

  /* ---------- metrics (weekly scorecard feed) ---------- */
  function weekStart(ymd) { var p = String(ymd || todayStr()).split('-').map(Number); var d = new Date(p[0], p[1] - 1, p[2]); var dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function dueToday() { var td = todayStr(); return worklist().filter(function (r) { return r.nextAt && r.nextAt <= td && !CLOSED[r.status] && r.status !== 'booked' && r.status !== 'recurring'; }); }
  function metrics() {
    var td = todayStr(), ws = weekStart(td);
    var conv = outreach().filter(function (e) { return e.result === 'reached' && dateOf(e.at) >= ws; }).length;
    var paid = allPaidRides();
    return {
      rows: worklist().length, dueToday: dueToday().length,
      conversationsThisWeek: conv, conversationsTarget: 5,
      paidReturnRides: paid.length, paidReturnTarget: PAID_TARGET, paidReturnToday: paid.filter(function (t) { return dateOf((t.payment || {}).at) === td; }).length,
      recurring: worklist().filter(function (r) { return r.status === 'recurring'; }).length, recurringTarget: 1,
      suppressed: customers().filter(function (c) { return c.suppressCall || c.suppressText || c.smsOptOut; }).length,
      attemptsThisWeek: outreach().filter(function (e) { return e.channel !== 'system' && dateOf(e.at) >= ws; }).length,
      pipeline: pipelineCounts()
    };
  }

  /* ---------- account pipeline ---------- */
  var STAGES = ['research', 'contacted', 'qualified', 'pilot_proposed', 'pilot_live', 'account', 'parked', 'closed'];
  var STAGE_LABEL = { research: 'Research', contacted: 'Contacted', qualified: 'Qualified', pilot_proposed: 'Pilot proposed', pilot_live: 'Pilot live', account: 'Account', parked: 'Parked', closed: 'Closed' };
  var STAGE_RANK = { research: 0, contacted: 1, qualified: 2, pilot_proposed: 3, pilot_live: 4, account: 5, parked: -1, closed: -1 };
  /* TURNAROUND-PLAN.md §4 weekly targets: week ending → approached (cum.), qualified conversations (cum.), pilots proposed, pilots live */
  var WEEK_TARGETS = [
    { ending: '2026-11-27', approached: 4, qualified: 2, proposed: 0, live: 0, ref: 'Day 7' },
    { ending: '2026-12-04', approached: 8, qualified: 3, proposed: 1, live: 0, ref: 'Day 14' },
    { ending: '2026-12-11', approached: 14, qualified: 4, proposed: 3, live: 1, ref: '' },
    { ending: '2026-12-21', approached: 20, qualified: 5, proposed: 3, live: 1, ref: 'Day 30' },
    { ending: '2027-01-20', approached: 20, qualified: 5, proposed: null, live: 2, ref: 'Day 60' }
  ];
  function currentTarget(ymd) { ymd = ymd || todayStr(); for (var i = 0; i < WEEK_TARGETS.length; i++) if (WEEK_TARGETS[i].ending >= ymd) return WEEK_TARGETS[i]; return WEEK_TARGETS[WEEK_TARGETS.length - 1]; }
  function normStage(v) { var s = String(v || '').toLowerCase().trim().replace(/[\s-]+/g, '_'); if (!s) return 'research'; if (/^pilot_?prop|^trial_?quot|^proposed/.test(s)) return 'pilot_proposed'; if (/^pilot_?live|^trial_?live|^live/.test(s)) return 'pilot_live'; if (/^(won|recurring|account|retain|protected)/.test(s)) return 'account'; if (/^(lost|closed|dead)/.test(s)) return 'closed'; if (/^(hold|park)/.test(s)) return 'parked'; if (/^contact/.test(s)) return 'contacted'; if (/^qualif/.test(s)) return 'qualified'; return STAGES.indexOf(s) >= 0 ? s : 'research'; }
  function normPriority(v) { var m = String(v || '').toUpperCase().match(/\b([ABC])\b/); return m ? m[1] : (String(v || '').trim() ? 'C' : ''); }
  /* Weekly-targets counter: approached = contacted or beyond (parked/closed count as approached when they got past research) */
  function pipelineCounts() {
    var p = pipeline(), c = { approached: 0, qualified: 0, proposed: 0, live: 0, total: p.length };
    p.forEach(function (x) {
      var st = x.status || 'research', rank = STAGE_RANK[st];
      var reached = rank >= 1 || ((st === 'parked' || st === 'closed') && x.reached);
      if (reached || (st === 'parked' || st === 'closed') && x.everContacted) c.approached++;
      if (rank >= 2 || x.everQualified) c.qualified++;
      if (rank >= 3 || x.everProposed) c.proposed++;
      if (rank >= 4) c.live++;
    });
    return c;
  }
  function findProspect(id) { return pipeline().filter(function (x) { return x.id === id; })[0] || null; }
  function addProspect(data) {
    data = data || {};
    var name = String(data.account || data.name || '').trim(); if (!name) { toast('Account name is required.', true); return null; }
    var ex = pipeline().filter(function (x) { return x.account.toLowerCase() === name.toLowerCase(); })[0];
    var row = ex || { id: 'pp_' + uid(), account: name, priority: '', buyer: '', nextAction: '', owner: '', date: '', status: 'research', notes: '', createdAt: nowISO() };
    if (data.priority) row.priority = normPriority(data.priority);
    if (data.buyer) row.buyer = String(data.buyer).trim();
    if (data.nextAction) row.nextAction = String(data.nextAction).trim();
    if (data.owner) row.owner = String(data.owner).trim();
    if (data.date) row.date = String(data.date).trim();
    if (data.status) markStage(row, normStage(data.status));
    if (data.notes) row.notes = String(data.notes).trim();
    row.updatedAt = nowISO();
    if (!ex) pipeline().push(row);
    save();
    return row;
  }
  function markStage(row, st) { row.status = st; var rank = STAGE_RANK[st]; if (rank >= 1) row.everContacted = true; if (rank >= 2) row.everQualified = true; if (rank >= 3) row.everProposed = true; }
  /* Stage change needs an owner and a next-action date (app-gaps §5 acceptance 5) */
  function setStage(id, stage, opts) {
    var p = findProspect(id); if (!p) return false;
    opts = opts || {};
    var st = normStage(stage);
    var owner = String(opts.owner || p.owner || '').trim(), date = String(opts.date || p.date || '').trim();
    if (!owner) { try { owner = String(window.prompt('Owner for ' + p.account + ' (initials)?', initials() || '') || '').trim(); } catch (e) { owner = ''; } }
    if (!owner) { toast('A stage change needs an owner.', true); return false; }
    if (!date || opts.askDate) { try { date = String(window.prompt('Next action date for ' + p.account + ' (YYYY-MM-DD)?', date || addDays(todayStr(), 7)) || '').trim(); } catch (e) { date = ''; } }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('A stage change needs a next action date (YYYY-MM-DD).', true); return false; }
    p.owner = owner; p.date = date; markStage(p, st); if (opts.nextAction) p.nextAction = String(opts.nextAction).trim(); p.updatedAt = nowISO();
    save(); render();
    return true;
  }
  function removeProspect(id) { var c = crm(), n = c.pipeline.length; c.pipeline = c.pipeline.filter(function (x) { return x.id !== id; }); if (n !== c.pipeline.length) { save(); render(); } }
  var PP_COLS = { account: ['account', 'accountname', 'name', 'prospect'], priority: ['priority', 'prio', 'priorityabc'], buyer: ['buyer', 'buyerrole', 'buyerroute', 'contact', 'businesscontact'], nextAction: ['nextaction', 'offerornextaction', 'next', 'action'], owner: ['owner'], date: ['date', 'nextactiondate', 'nextdate', 'due'], status: ['status', 'stage', 'pipelinestage'], notes: ['notes', 'evidence', 'evidenceurl'] };
  function importPipeline(text) {
    var rows = parseCSV(text); if (rows.length < 2) { toast('Paste the prospects list with a header row.', true); return { ok: false, error: 'empty' }; }
    var head = rows[0].map(normHead), ix = {}; Object.keys(PP_COLS).forEach(function (k) { ix[k] = colIndex(head, PP_COLS[k]); });
    if (ix.account < 0) { toast('Prospects list needs an "account" column (plus priority, buyer, next action, owner, date, status).', true); return { ok: false, error: 'missing', missing: ['account'] }; }
    var res = { ok: true, added: 0, updated: 0, skipped: 0 };
    rows.slice(1).forEach(function (c) {
      var name = String(c[ix.account] || '').trim(); if (!name) { res.skipped++; return; }
      var before = pipeline().some(function (x) { return x.account.toLowerCase() === name.toLowerCase(); });
      var d = { account: name }; Object.keys(PP_COLS).forEach(function (k) { if (k !== 'account' && ix[k] >= 0) d[k] = c[ix[k]]; });
      if (addProspect(d)) { if (before) res.updated++; else res.added++; }
    });
    saveNow(); render();
    toast('Prospects: ' + res.added + ' added, ' + res.updated + ' updated.');
    return res;
  }

  /* ---------- texting paths: suppression + marketing consent enforced everywhere ---------- */
  function blockToast(phone, chk) { toast('Not sent to ' + fmtPhone(phone) + ': ' + chk.reason, true); }
/* keep the inner wrappers' marker flags (e.g. __fixesWrapped) visible on the outermost function */
  function inheritFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_{1,2}\w*Wrapped$/.test(k) && w[k] === undefined) w[k] = orig[k]; }); } catch (e) {} return w; }
  function wrapMessages() {
    var M = window.Messages; if (!M || typeof M !== 'object') return;
    if (typeof M.textPassenger === 'function' && !M.textPassenger.__crmWrapped) {
      var oTP = M.textPassenger;
      var wTP = function (tripId, key, ev) {
        var t = findTrip(tripId);
        if (t && t.phone && key) { var chk = canText(t.phone, key); if (!chk.ok) { blockToast(t.phone, chk); return false; } }
        var out = oTP.apply(this, arguments);
        if (!key) { try { decorateMenu(tripId); } catch (e) {} }   // no key = the menu opened: the suppression banner and disabled buttons apply there too
        return out;
      };
      wTP.__crmWrapped = true; wTP._orig = oTP; inheritFlags(wTP, oTP); M.textPassenger = wTP;
    }
    if (typeof M.smsHref === 'function' && !M.smsHref.__crmWrapped) {
      var oSH = M.smsHref;
      var wSH = function (phone, body) {
        var b = textBlock(phone);
        if (b) { blockToast(phone, { reason: b.reason }); return ''; }   // callers test for '' (money.js payLink does)
        return oSH.apply(this, arguments);
      };
      wSH.__crmWrapped = true; wSH._orig = oSH; inheritFlags(wSH, oSH); M.smsHref = wSH;
    }
    if (typeof M.menu === 'function' && !M.menu.__crmWrapped) {
      var oMenu = M.menu;
      var wMenu = function (ev, tripId) {
        var out = oMenu.apply(this, arguments);
        try { decorateMenu(tripId); } catch (e) {}
        return out;
      };
      wMenu.__crmWrapped = true; wMenu._orig = oMenu; inheritFlags(wMenu, oMenu); M.menu = wMenu;
    }
  }
  var menuTrip = null;
  function decorateMenu(tripId) {
    var m = byId('msgMenu'), t = findTrip(tripId); menuTrip = t ? t.id : null;
    if (!m || m.hidden || !t) return;
    var b = t.phone ? textBlock(t.phone) : null;
    if (!b) {   // marketing-only buttons (none in the stock menu) are disabled without the written opt-in
      m.querySelectorAll('[data-act="ptpl"]').forEach(function (btn) { var k = btn.getAttribute('data-key'); if (isMarketingKey(k) && !hasMarketingConsent(t.phone)) { btn.disabled = true; btn.classList.add('dim'); btn.title = 'Needs written marketing opt-in'; } });
      return;
    }
    m.querySelectorAll('[data-act="ptpl"],[data-act="pass"]').forEach(function (btn) { btn.disabled = true; btn.classList.add('dim'); btn.title = b.reason; });
    var sub = m.querySelector('[data-sub="pass"]'); if (sub) sub.hidden = true;
    if (!m.querySelector('.crm-menu-ban')) {
      var ban = document.createElement('div'); ban.className = 'crm-menu-ban'; ban.textContent = 'DO NOT TEXT this passenger — ' + b.reason;
      var hdr = m.querySelector('.msg-h'); if (hdr && hdr.nextSibling) m.insertBefore(ban, hdr.nextSibling); else m.insertBefore(ban, m.firstChild);
    }
  }
  /* belt and braces: the menu's own click handlers call messages.js's private textPassenger, so stop the click first */
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('#msgMenu [data-act="ptpl"]') : null; if (!btn) return;
    var t = menuTrip ? findTrip(menuTrip) : null; if (!t || !t.phone) return;
    var chk = canText(t.phone, btn.getAttribute('data-key'));
    if (!chk.ok) { e.stopImmediatePropagation(); e.preventDefault(); blockToast(t.phone, chk); try { if (window.Messages && window.Messages.closeMenu) window.Messages.closeMenu(); } catch (e2) {} }
  }, true);
  function wrapMoney() {
    var Mo = window.Money; if (!Mo || typeof Mo !== 'object') return;
    if (typeof Mo.payLink === 'function' && !Mo.payLink.__crmWrapped) {
      var oPL = Mo.payLink;
      var wPL = function (id) { var t = findTrip(id); if (t && t.phone) { var b = textBlock(t.phone); if (b) { blockToast(t.phone, { reason: b.reason }); return false; } } return oPL.apply(this, arguments); };
      wPL.__crmWrapped = true; wPL._orig = oPL; inheritFlags(wPL, oPL); Mo.payLink = wPL;
    }
    ['paid', 'cash', 'noShowPaid'].forEach(function (k) {
      if (typeof Mo[k] !== 'function' || Mo[k].__crmWrapped) return;
      var o = Mo[k]; var w = function () { var r = o.apply(this, arguments); try { if (accountsActive()) render(); } catch (e) {} return r; };
      w.__crmWrapped = true; w._orig = o; inheritFlags(w, o); Mo[k] = w;
    });
  }
  /* Twilio path (sms-out / notify Edge Functions through sync.js's Cloud.fn): refuse suppressed numbers client-side too */
  function wrapCloud() {
    var C = window.Cloud; if (!C || typeof C.fn !== 'function' || C.fn.__crmWrapped) return;
    var oFn = C.fn;
    var wFn = function (name, payload) {
      try {
        if (/^(sms-out|notify)$/.test(String(name || '')) && payload && typeof payload === 'object') {
          var to = payload.to || payload.phone || payload.phone_e164 || payload.passenger_phone || '';
          if (to) { var chk = canText(to, payload.template || payload.kind || payload.key || ''); if (!chk.ok) { blockToast(to, chk); return Promise.reject(new Error('CRM: ' + chk.reason)); } }
        }
      } catch (e) {}
      return oFn.apply(this, arguments);
    };
    wFn.__crmWrapped = true; wFn._orig = oFn; inheritFlags(wFn, oFn); C.fn = wFn;
  }

  /* ---------- Book form: consent checkbox + attribution of the booked trip ---------- */
  function ensureConsentBox() {
    if (byId('crm_consent')) return;
    var notes = byId('d_notes'); if (!notes) return;
    var host = notes.closest ? notes.closest('label.fld, .fld') : null; if (!host || !host.parentNode) host = notes;
    var wrap = document.createElement('label'); wrap.className = 'crm-consent'; wrap.id = 'crm_consent_wrap';
    wrap.innerHTML = '<input type="checkbox" id="crm_consent"> <span>Consent sentence read: <i>&ldquo;' + esc(consentSentence()) + '&rdquo;</i></span>';
    wrap.title = 'Tick when you said the sentence to the caller — the number is then marked as consenting to ride-update texts. Marketing texts need a separate written opt-in.';
    host.parentNode.insertBefore(wrap, host.nextSibling);
  }
  var dsavePre = null;
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#d_save') : null; if (!b) return;
    var editing = null; try { if (typeof editingId !== 'undefined') editing = editingId; } catch (err) { editing = null; }
    dsavePre = { editing: editing, count: trips().length, phone: String((byId('d_phone') || {}).value || '').trim(), name: String((byId('d_passenger') || {}).value || '').trim(), consent: !!(byId('crm_consent') && byId('crm_consent').checked) };
  }, true);
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#d_save') : null; if (!b || !dsavePre) return;
    var pre = dsavePre; dsavePre = null;
    try {
      var t = pre.editing ? findTrip(pre.editing) : null;
      if (!t && trips().length > pre.count) t = trips()[0];
      if (!t) return;                                   // nothing saved (validation toast)
      if (pre.consent && t.phone) { setConsent(t.phone, 'informational', 'phone', t.passenger); var cb = byId('crm_consent'); if (cb) cb.checked = false; }
      if (!pre.editing) afterBook(t);
      save();
    } catch (err) { try { console.error('[crm]', err); } catch (e2) {} }
  }, false);

  /* ---------- caller pop banner (openCallerPopout) ---------- */
  function popBanner(num) {
    var rows = rowsForPhone(num), cb = textBlock(num), cc = callBlock(num);
    if (!rows.length && !cb && !cc) return '';
    var h = '';
    if (cc || cb) h += '<div class="crm-ban crm-ban-stop">' + esc((cc ? 'DO NOT CALL' : '') + (cc && cb ? ' · ' : '') + (cb ? 'DO NOT TEXT' : '')) + ' — ' + esc((cc || cb).reason) + (cc ? '. Book only if they called you.' : '') + '</div>';
    rows.forEach(function (r) {
      var at = attempts(r), last = at[0], paid = paidLabel(r);
      h += '<div class="crm-ban"><b>Win-back row ' + esc(r.id) + '</b>' + (r.name ? ' · ' + esc(r.name) : '') + ' · wave ' + esc(r.wave) + ' · ' + esc(r.status.replace(/_/g, ' ')) + (last ? ' · last: ' + esc(RESULT_LABEL[last.result] || last.result) + ' ' + esc(stamp(last.at)) : ' · no attempts yet') + (paid ? ' · <span class="crm-paid">' + esc(paid) + '</span>' : '')
        + ' <button class="btn btn-ghost btn-sm" type="button" data-crm-open="' + esc(r.id) + '">Open row</button></div>';
    });
    return h;
  }
  function wrapCallerPop() {
    if (typeof window.openCallerPopout !== 'function' || window.openCallerPopout.__crmWrapped) return;
    var o = window.openCallerPopout;
    var w = function (num) {
      var out = o.apply(this, arguments);                     // async: the card is painted before its first await
      try {
        var card = byId('editOvlCard'), body = card ? card.querySelector('.panel-body') : null;
        if (body && !body.querySelector('.crm-ban')) { var html = popBanner(num); if (html) body.insertAdjacentHTML('afterbegin', html); }
        var rows = rowsForPhone(num).filter(function (r) { return !r.suppress; });
        if (rows.length === 1 && !(pending && Date.now() - pending.at < PENDING_MS)) pending = { rowId: rows[0].id, at: Date.now(), phoneKey: rows[0].phoneKey };
      } catch (e) {}
      return out;
    };
    w.__crmWrapped = true; w._orig = o; inheritFlags(w, o); window.openCallerPopout = w;
  }

  /* ---------- Ctrl-K search: a "Win-back" group ---------- */
  function crmSearchHtml(q) {
    q = String(q || '').trim().toLowerCase(); if (q.length < 2) return '';
    var digits = q.replace(/\D/g, '');
    var hits = worklist().filter(function (r) { return r.id.toLowerCase().indexOf(q) >= 0 || (r.name && r.name.toLowerCase().indexOf(q) >= 0) || (digits.length >= 3 && r.phoneKey && r.phoneKey.indexOf(digits) >= 0); }).slice(0, 5);
    var pp = pipeline().filter(function (p) { return p.account.toLowerCase().indexOf(q) >= 0; }).slice(0, 3);
    var h = '';
    if (hits.length) h += '<div class="g-grp">Win-back</div>' + hits.map(function (r) { return '<div class="g-item" data-crm-open="' + esc(r.id) + '" data-crm-clear="1"><b>' + esc(r.id) + '</b> ' + esc(r.name || '') + (r.suppress ? ' <span class="crm-flag">' + esc(r.suppress) + '</span>' : '') + '<div class="g-sub">' + esc(fmtPhone(r.phone)) + ' · ' + esc(r.status.replace(/_/g, ' ')) + (r.nextAt ? ' · next ' + esc(r.nextAt) : '') + '</div></div>'; }).join('');
    if (pp.length) h += '<div class="g-grp">Pipeline</div>' + pp.map(function (p) { return '<div class="g-item" data-crm-prospect="' + esc(p.id) + '" data-crm-clear="1">' + esc(p.account) + '<div class="g-sub">' + esc(p.priority ? p.priority + ' · ' : '') + esc(STAGE_LABEL[p.status] || p.status) + (p.date ? ' · ' + esc(p.date) : '') + '</div></div>'; }).join('');
    return h;
  }
  function appendSearch() {
    var i = byId('gsearch'), box = byId('gsr'); if (!i || !box) return;
    var h = crmSearchHtml(i.value); if (!h) return;
    if (box.querySelector('.crm-grp')) return;
    if (box.hidden || /No matches\./.test(box.innerHTML) && box.children.length === 1) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', '<div class="crm-grp">' + h + '</div>'); box.hidden = false;
  }
  /* one delegated handler for every CRM link built from data (row ids come from the owner's CSV: never put them in inline script) */
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-crm-open],[data-crm-prospect]') : null; if (!el) return;
    e.preventDefault();
    try {
      if (el.hasAttribute('data-crm-prospect')) openProspectById(el.getAttribute('data-crm-prospect'));
      else { var id = el.getAttribute('data-crm-open'); if (id) open(id); else open(); }
      if (el.getAttribute('data-crm-clear') && typeof window.gsClear === 'function') window.gsClear();
    } catch (err) {}
  });
  /* a Board "Copy" / Classic "Duplicate" deep-copies the trip, crmRowId included: a copy the row never linked is not a win-back ride */
  function stripCopiedRows() {
    var changed = false;
    trips().forEach(function (c) { if (!c || !c.crmRowId) return; var r = findRow(c.crmRowId); if (r && r.linkedTripIds.indexOf(c.id) < 0) { delete c.crmRowId; changed = true; } });
    if (changed) save();
  }
  function wrapSearch() {
    if (typeof window.globalSearch === 'function' && !window.globalSearch.__crmWrapped) {
      var o = window.globalSearch; var w = function () { var r = o.apply(this, arguments); try { appendSearch(); } catch (e) {} return r; };
      w.__crmWrapped = true; w._orig = o; inheritFlags(w, o); window.globalSearch = w;
    }
    var i = byId('gsearch');   // index.html bound its own listeners with a direct reference: add ours after them
    if (i && !i.__crmSearch) { i.__crmSearch = true; i.addEventListener('input', act(appendSearch)); i.addEventListener('focus', act(appendSearch)); }
  }

  /* ---------- Needs-you: "N win-back calls due today" ---------- */
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
     wrapped Simple.refreshNeedsYou: watch the strip and put the line back whenever it is missing (ops.js does the same). The
     observer only acts when the line is absent, and injectNeedsYou adds nothing when no call is due, so it cannot loop. */
  function watchNeedsYou(host) {
    if (!host || host.__crmObserved || !window.MutationObserver) return;
    host.__crmObserved = true;
    try { new MutationObserver(function () { try { if (!host.querySelector('.crm-ny')) injectNeedsYou(); } catch (e) {} }).observe(host, { childList: true }); } catch (e) {}
  }
  function injectNeedsYou() {
    var host = byId('needsYou'); if (!host) return;
    watchNeedsYou(host);
    var old = host.querySelector('.crm-ny'); if (old) old.remove();
    if (window.Simple && typeof window.Simple.isSimple === 'function' && !window.Simple.isSimple()) return;
    var due = dueToday(); if (!due.length) { if (old) recountNeedsYou(host); return; }
    var head = host.querySelector('.ny-head');
    var div = document.createElement('div'); div.className = 'ny-item crm-ny'; div.setAttribute('data-kind', 'crm');
    div.innerHTML = '<span class="ny-dot soon"></span><span class="ny-txt"><b>' + due.length + ' win-back call' + (due.length > 1 ? 's' : '') + ' due today</b> — ' + esc(due.slice(0, 3).map(function (r) { return r.name || r.id; }).join(', ')) + (due.length > 3 ? ', …' : '') + '.</span><span class="ny-acts"><button type="button" class="btn btn-sm btn-navy" data-crm-open="">Open list</button></span>';
    if (head && head.nextSibling) host.insertBefore(div, head.nextSibling); else host.appendChild(div);
    recountNeedsYou(host);
  }
  function refreshNeedsYou() { try { if (window.Simple && typeof window.Simple.refreshNeedsYou === 'function') window.Simple.refreshNeedsYou(); else injectNeedsYou(); } catch (e) {} }
  function wrapNeedsYou() {
    if (!window.Simple || typeof window.Simple.refreshNeedsYou !== 'function' || window.Simple.refreshNeedsYou.__crmWrapped) return;
    var o = window.Simple.refreshNeedsYou; var w = function () { var r = o.apply(this, arguments); try { injectNeedsYou(); } catch (e) {} return r; };
    w.__crmWrapped = true; w._orig = o; inheritFlags(w, o); window.Simple.refreshNeedsYou = w;
  }

  /* ---------- styles ---------- */
  function ensureStyle() {
    if (byId('crmStyle')) return;
    var st = document.createElement('style'); st.id = 'crmStyle';
    st.textContent = [
      '.crm-panel h4{margin:12px 0 4px;font-size:12.5px;color:var(--green-dark,#15497d);}',
      '.crm-panel .crm-sub{font-size:11px;color:var(--muted,#5b5b5b);margin:0 0 6px;}',
      '.crm-panel .stat-row{margin-bottom:10px;}',
      '.crm-panel .crm-tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 8px;}',
      '.crm-panel .crm-tools input[type=text]{width:70px;}',
      '.crm-panel .crm-acts{display:flex;flex-wrap:wrap;gap:4px;}',
      '.crm-panel .crm-acts .btn,.crm-panel .crm-acts a.btn{white-space:nowrap;text-decoration:none;}',
      '.crm-panel .tbl-scroll{max-height:420px;}',
      '.crm-panel tr.crm-due td{background:rgba(214,158,20,.10);}',
      '.crm-panel tr.crm-stop td{background:rgba(192,57,43,.08);}',
      '.crm-panel tr.crm-open td{border-bottom:none;}',
      '.crm-flag{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:10px;background:rgba(192,57,43,.12);color:#9b2d20;margin-left:4px;white-space:nowrap;}',
      '.crm-paid{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:10px;background:rgba(31,122,61,.12);color:#1f7a3d;margin-left:4px;white-space:nowrap;}',
      '.crm-chip{display:inline-block;font-size:10.5px;padding:1px 7px;border-radius:10px;background:rgba(120,140,160,.14);margin-left:4px;white-space:nowrap;}',
      '.crm-detail{background:rgba(120,140,160,.06);border:1px solid var(--line,#d4d4d4);border-radius:4px;padding:8px 10px;margin:2px 0 8px;font-size:12px;}',
      '.crm-detail .grid2{gap:8px;}',
      '.crm-detail .crm-hist{margin:4px 0 0;font-size:11.5px;color:var(--muted,#5b5b5b);}',
      '.crm-detail .crm-form{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;margin-top:6px;}',
      '.crm-detail .crm-form label{display:flex;flex-direction:column;font-size:10.5px;color:var(--muted,#5b5b5b);}',
      '.crm-detail .crm-form input,.crm-detail .crm-form select{min-width:90px;}',
      '.crm-detail .crm-form input[type=text].wide{min-width:200px;}',
      '.crm-import textarea{width:100%;min-height:80px;font-family:Consolas,monospace;font-size:11.5px;}',
      '.crm-ban{margin:0 0 8px;padding:6px 10px;border-radius:4px;background:rgba(31,122,61,.10);border:1px solid rgba(31,122,61,.35);font-size:12px;}',
      '.crm-ban-stop{background:rgba(192,57,43,.12);border-color:#c0392b;color:#7a1f16;font-weight:700;}',
      '.crm-menu-ban{margin:4px 6px 6px;padding:5px 8px;border-radius:6px;background:rgba(192,57,43,.12);border:1px solid #c0392b;color:#7a1f16;font-size:11.5px;font-weight:700;}',
      '.crm-consent{display:flex;gap:6px;align-items:flex-start;font-size:12px;margin:4px 0 6px;cursor:pointer;line-height:1.35;}',
      '.crm-consent input{margin-top:3px;}',
      '.crm-consent i{color:var(--muted,#5b5b5b);}',
      '.crm-script{white-space:pre-wrap;font-size:12px;background:rgba(255,246,196,.5);border:1px dashed var(--line,#cfd4da);border-radius:6px;padding:8px 10px;}',
      '.crm-ny .ny-dot.soon{background:#d99a1b;}',
      'body.gold .crm-panel h4{color:#e8c75a;} body.gold .crm-ban{color:#e8e9ec;} body.gold .crm-ban-stop{color:#f0a89f;} body.gold .crm-paid{color:#8fd8a4;} body.gold .crm-flag{color:#f0a89f;} body.gold .crm-script{background:rgba(232,199,90,.08);}',
      'body.classic .crm-panel h4{color:#0a246a;} body.classic .crm-detail{background:#fff;border-radius:0;}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }

  /* ---------- panel ---------- */
  var PANEL_ID = 'crmPanel', openRow = null, openProspect = null, showLog = false;
  function ensurePanel() {
    var view = byId('view-accounts'); if (!view) return null;
    var p = byId(PANEL_ID);
    if (!p) { p = document.createElement('div'); p.id = PANEL_ID; p.className = 'panel crm-panel'; view.appendChild(p); p.addEventListener('click', onClick); p.addEventListener('change', onChange); }
    return p;
  }
  function accountsActive() { var v = byId('view-accounts'); return !!(v && v.classList.contains('active')); }
  function refreshBoardIfAny() { try { if (typeof window.refreshBoard === 'function' && byId('activeBoard')) window.refreshBoard(); } catch (e) {} }
  function tile(v, k, cls) { return '<div class="stat' + (cls ? ' ' + cls : '') + '"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>'; }
  function sel(id, opts, val, labels) { return '<select id="' + id + '" data-f="' + id + '">' + opts.map(function (o) { return '<option value="' + esc(o) + '"' + (o === val ? ' selected' : '') + '>' + esc(labels && labels[o] != null ? labels[o] : (o || '—').replace(/_/g, ' ')) + '</option>'; }).join('') + '</select>'; }
  var SCRIPT = 'What to say on a live call (20 seconds): "Hi, this is {biz}. You used to ride with us from {route} and we have not seen you since {last}. We are rebuilding the service with on-time pickups and a set price. Is there a ride coming up we can take care of for you?" Then ask the one question on the row. Read the consent sentence before you book. If they say stop, press Suppress and say "Done - you will not hear from us again."';
  function sortRows(a, b) {
    var wa = WAVES.indexOf(a.wave), wb = WAVES.indexOf(b.wave); if (wa < 0) wa = 9; if (wb < 0) wb = 9;
    var ca = CLOSED[a.status] ? 1 : 0, cb = CLOSED[b.status] ? 1 : 0; if (ca !== cb) return ca - cb;
    if (wa !== wb) return wa - wb;
    if ((a.nextAt || '9') !== (b.nextAt || '9')) return (a.nextAt || '9') < (b.nextAt || '9') ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
  }
  function rowHtml(r) {
    var td = todayStr(), m = matchRow(r), at = callAttempts(r), last = attempts(r)[0];
    var due = r.nextAt && r.nextAt <= td && !CLOSED[r.status] && r.status !== 'booked' && r.status !== 'recurring';
    var cb = textBlock(r.phone), cc = callBlock(r.phone), paid = paidLabel(r), mk = hasMarketingConsent(r.phone), info = hasInfoConsent(r.phone);
    var cls = (cb || cc ? 'crm-stop' : (due ? 'crm-due' : '')) + (openRow === r.id ? ' crm-open' : '');
    var route = m && m.usualRoute ? shortAddr(m.usualRoute.pu) + ' > ' + shortAddr(m.usualRoute.do || '') : '';
    var h = '<tr class="' + cls + '" data-row="' + esc(r.id) + '"><td class="mono">' + esc(r.id) + (r.suppress ? '<span class="crm-flag">' + esc(r.suppress) + '</span>' : '') + '</td>'
      + '<td>' + esc(r.name || '—') + '<div class="hint" style="margin:0;">' + esc(fmtPhone(r.phone) || 'no phone') + (info ? ' <span class="crm-chip" title="Consent sentence read">updates ✓</span>' : '') + (mk ? ' <span class="crm-chip" title="Written marketing opt-in">marketing ✓</span>' : '') + '</div></td>'
      + '<td>' + (m && m.known ? esc(route || 'known caller') + '<div class="hint" style="margin:0;">' + (m.usualDriver ? 'usual driver ' + esc(m.usualDriver.name) + ' · ' : '') + (m.tripCount ? m.tripCount + ' trip' + (m.tripCount === 1 ? '' : 's') : 'directory') + (m.usualFare ? ' · ' + esc(money(m.usualFare)) : '') + '</div>' : '<span class="crm-flag" style="background:rgba(214,158,20,.14);color:#7a5a06;" title="No trips or caller-directory entry on this phone">unmatched</span>') + '</td>'
      + '<td>' + esc(r.lastTrip || (m && m.lastTrips[0] ? m.lastTrips[0].date : '—')) + '</td>'
      + '<td>' + esc(String(r.wave || '').replace(/_/g, ' ')) + '</td>'
      + '<td>' + esc(String(r.status || '').replace(/_/g, ' ')) + (at.length ? '<div class="hint" style="margin:0;">' + at.length + ' attempt' + (at.length === 1 ? '' : 's') + (last ? ' · ' + esc(RESULT_LABEL[last.result] || last.result) + ' ' + esc(dateOf(last.at)) : '') + '</div>' : '') + (paid ? '<div><span class="crm-paid">' + esc(paid) + '</span></div>' : '') + '</td>'
      + '<td>' + (r.nextAt ? esc(r.nextAt) + (due ? ' <span class="crm-flag" style="background:rgba(214,158,20,.14);color:#7a5a06;">due</span>' : '') : '—') + (r.owner ? '<div class="hint" style="margin:0;">' + esc(r.owner) + '</div>' : '') + '</td>'
      + '<td><div class="crm-acts">'
      + (r.phone && !cc ? '<a class="btn btn-ghost btn-sm" href="tel:' + esc('+1' + r.phoneKey) + '" title="Call from this device">Call</a>' : '<button class="btn btn-ghost btn-sm" type="button" disabled title="' + esc(cc ? cc.reason : 'No phone') + '">Call</button>')
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="text" data-id="' + esc(r.id) + '"' + (!r.phone || cb || !mk ? ' disabled' : '') + ' title="' + esc(cb ? cb.reason : (!mk ? 'Needs written marketing opt-in (a win-back text is promotional)' : 'Text from your phone — opens Messages')) + '">Text</button>'
      + '<button class="btn btn-go btn-sm" type="button" data-act="book" data-id="' + esc(r.id) + '" title="Open the caller pop for this number — the booking is tied to this row">Book</button>'
      + '<button class="btn btn-navy btn-sm" type="button" data-act="toggle" data-id="' + esc(r.id) + '">' + (openRow === r.id ? 'Close' : 'Log / details') + '</button>'
      + '</div></td></tr>';
    if (openRow === r.id) h += '<tr class="crm-detail-row" data-row="' + esc(r.id) + '"><td colspan="8">' + detailHtml(r, m) + '</td></tr>';
    return h;
  }
  function detailHtml(r, m) {
    var at = attempts(r).slice(0, 6), c = custFor(r.phone, false), paid = paidRides(r);
    var h = '<div class="crm-detail"><div class="grid2"><div>';
    h += '<b>Before you call</b><div class="crm-hist">' + (m && m.known ? 'Usual route: ' + esc(m.usualRoute ? shortAddr(m.usualRoute.pu) + ' > ' + shortAddr(m.usualRoute.do || '') : '—') + (m.usualRoute && m.usualRoute.n ? ' (' + m.usualRoute.n + '×)' : '') + '<br>Usual driver: ' + esc(m.usualDriver ? m.usualDriver.name : '—') + (m.usualFare ? '<br>Usual fare: ' + esc(money(m.usualFare)) : '') + '<br>Last three trips: ' + (m.lastTrips.length ? m.lastTrips.map(function (t) { return esc(fmtDate(t.date)) + ' ' + esc(shortAddr(t.pu)) + ' > ' + esc(shortAddr(t.do)) + (t.fare ? ' ' + esc(money(t.fare)) : '') + ' (' + esc(t.status) + ')'; }).join('<br>') : 'none in the console') : 'Unmatched — no trips or directory entry for this phone. Verify the number before calling.') + '</div>';
    if (r.notes) h += '<div class="crm-hist">Question / note: ' + esc(r.notes) + '</div>';
    h += '<div class="crm-hist">Consent: ride updates ' + (c && c.smsConsentInformational ? '✓ ' + esc(dateOf(c.smsConsentInformationalAt)) : '— not recorded') + ' · marketing ' + (c && c.smsConsentMarketing ? '✓ ' + esc(c.smsConsentMarketingHow || '') + ' ' + esc(dateOf(c.smsConsentMarketingAt)) : '— no written opt-in') + (c && c.smsOptOut ? ' · <b>STOP received ' + esc(dateOf(c.smsOptOutAt)) + '</b>' : '') + '</div>';
    if (paid.length) h += '<div class="crm-hist">Paid return rides: ' + paid.map(function (t) { return '#' + esc(t.dispatchNo) + ' ' + esc(t.date); }).join(', ') + '</div>';
    else if (r.linkedTripIds.length) h += '<div class="crm-hist">Linked trips: ' + r.linkedTripIds.map(function (id) { var t = findTrip(id); return t ? '#' + esc(t.dispatchNo) + ' ' + esc(t.status) + (t.payment && t.payment.status ? ' · ' + esc(t.payment.status) : '') : esc(id); }).join(', ') + '</div>';
    h += '</div><div><b>Attempts</b><div class="crm-hist">' + (at.length ? at.map(function (e) { return esc(stamp(e.at)) + ' · ' + esc(e.caller || '') + ' · ' + esc(e.channel) + ' · <b>' + esc(RESULT_LABEL[e.result] || e.result) + '</b>' + (e.reasonCode ? ' (' + esc(e.reasonCode) + ')' : '') + (e.quote ? ' · quote ' + esc(e.quote) : '') + (e.consentRead ? ' · consent read' : '') + (e.note ? ' · ' + esc(e.note) : ''); }).join('<br>') : 'none yet') + '</div></div></div>';
    h += '<div class="crm-form" data-form="' + esc(r.id) + '">'
      + '<label>Result ' + sel('crm_f_result', RESULTS, 'no_answer', RESULT_LABEL) + '</label>'
      + '<label>Reason code ' + sel('crm_f_reason', REASONS, '') + '</label>'
      + '<label>Quote given <input type="text" id="crm_f_quote" placeholder="$" style="min-width:70px;"></label>'
      + '<label>Next action <input type="date" id="crm_f_next" value=""></label>'
      + '<label style="flex-direction:row;align-items:center;gap:4px;padding-bottom:6px;"><input type="checkbox" id="crm_f_consent"> consent read</label>'
      + '<label>Note <input type="text" id="crm_f_note" class="wide" placeholder="what they said"></label>'
      + '<button class="btn btn-go btn-sm" type="button" data-act="log" data-id="' + esc(r.id) + '">Save outcome</button>'
      + '</div>';
    h += '<div class="crm-form">'
      + '<label>Wave ' + sel('crm_f_wave', WAVES, r.wave) + '</label>'
      + '<label>Owner <input type="text" id="crm_f_owner" value="' + esc(r.owner || '') + '" style="min-width:60px;"></label>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="saverow" data-id="' + esc(r.id) + '">Save row</button>'
      + (r.suppress ? '<button class="btn btn-ghost btn-sm" type="button" data-act="unsuppress" data-id="' + esc(r.id) + '" title="Owner PIN">Clear flag (owner)</button>'
        : '<button class="btn btn-void btn-sm" type="button" data-act="suppress" data-id="' + esc(r.id) + '" data-mode="both" title="They asked not to be contacted — blocks every call and text button">Do not contact</button>'
        + '<button class="btn btn-ghost btn-sm" type="button" data-act="suppress" data-id="' + esc(r.id) + '" data-mode="text" title="Blocks every text to this number">Do not text</button>')
      + (c && c.smsConsentMarketing ? '' : '<button class="btn btn-ghost btn-sm" type="button" data-act="mkconsent" data-id="' + esc(r.id) + '" title="Record a WRITTEN marketing opt-in (text reply, signed form, email)">Record written opt-in</button>')
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="delrow" data-id="' + esc(r.id) + '" title="Remove this row (attempts stay in the log)">Remove row</button>'
      + '</div></div>';
    return h;
  }
  function prospectHtml(p) {
    var h = '<tr data-pp="' + esc(p.id) + '"><td>' + esc(p.account) + (p.notes ? '<div class="hint" style="margin:0;">' + esc(p.notes) + '</div>' : '') + '</td><td>' + esc(p.priority || '—') + '</td><td>' + esc(p.buyer || '—') + '</td><td>' + esc(p.nextAction || '—') + '</td><td>' + esc(p.owner || '—') + '</td><td>' + esc(p.date || '—') + (p.date && p.date <= todayStr() && STAGE_RANK[p.status] >= 0 ? ' <span class="crm-flag" style="background:rgba(214,158,20,.14);color:#7a5a06;">due</span>' : '') + '</td>'
      + '<td><select data-stage="' + esc(p.id) + '">' + STAGES.map(function (s) { return '<option value="' + s + '"' + (s === p.status ? ' selected' : '') + '>' + esc(STAGE_LABEL[s]) + '</option>'; }).join('') + '</select></td>'
      + '<td><div class="crm-acts"><button class="btn btn-navy btn-sm" type="button" data-act="pptoggle" data-id="' + esc(p.id) + '">' + (openProspect === p.id ? 'Close' : 'Edit') + '</button></div></td></tr>';
    if (openProspect === p.id) {
      h += '<tr><td colspan="8"><div class="crm-detail"><div class="crm-form" data-ppform="' + esc(p.id) + '">'
        + '<label>Account <input type="text" id="crm_p_account" class="wide" value="' + esc(p.account) + '"></label>'
        + '<label>Priority ' + sel('crm_p_priority', ['', 'A', 'B', 'C'], p.priority) + '</label>'
        + '<label>Buyer <input type="text" id="crm_p_buyer" class="wide" value="' + esc(p.buyer || '') + '"></label>'
        + '<label>Next action <input type="text" id="crm_p_next" class="wide" value="' + esc(p.nextAction || '') + '"></label>'
        + '<label>Owner <input type="text" id="crm_p_owner" value="' + esc(p.owner || '') + '" style="min-width:60px;"></label>'
        + '<label>Date <input type="date" id="crm_p_date" value="' + esc(p.date || '') + '"></label>'
        + '<label>Notes <input type="text" id="crm_p_notes" class="wide" value="' + esc(p.notes || '') + '"></label>'
        + '<button class="btn btn-go btn-sm" type="button" data-act="ppsave" data-id="' + esc(p.id) + '">Save</button>'
        + '<button class="btn btn-ghost btn-sm" type="button" data-act="ppdel" data-id="' + esc(p.id) + '">Remove</button>'
        + '</div><div class="crm-hist">Pilot checklist (plan §4): approved booker · pickup zone · service window · per-trip quote · weekly cap · invoice terms. A pilot passes at 25 paid rides with at least $6 retained each.</div></div></td></tr>';
    }
    return h;
  }
  function render() {
    var panel = ensurePanel(); if (!panel) return;
    ensureStyle(); syncDerivedStatus();
    var k = metrics(), rows = worklist().slice().sort(sortRows), pc = k.pipeline, tg = currentTarget();
    var h = '<div class="panel-head">Win-back &amp; accounts <span class="hint" style="margin:0;font-weight:400;">worklist · outreach log · suppression · pipeline — local only, nothing leaves this station</span></div><div class="panel-body">';
    h += '<div class="stat-row" id="crm_kpis">' + tile(String(k.dueToday), 'Calls due today', k.dueToday ? 'mny-warn' : '') + tile(k.conversationsThisWeek + ' / ' + k.conversationsTarget, 'Conversations this week') + tile(k.paidReturnRides + ' / ' + k.paidReturnTarget, 'Paid return rides', k.paidReturnRides >= k.paidReturnTarget ? 'mny-ok' : '') + tile(k.recurring + ' / ' + k.recurringTarget, 'Recurring bookings') + tile(String(k.suppressed), 'Suppressed numbers') + '</div>';
    h += '<div class="crm-tools"><label class="hint" style="margin:0;">Your initials <input type="text" id="crm_caller" value="' + esc(initials()) + '" maxlength="6" placeholder="AL"></label>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="imp" data-kind="winback">Import win-back list</button>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="imp" data-kind="outreach">Import Outreach log</button>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="addrow">Add row</button>'
      + '<button class="btn btn-navy btn-sm" type="button" data-act="export" title="Owner PIN">Export outreach log (CSV)</button>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="exportwl" title="Owner PIN">Export list (CSV)</button>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="showlog">' + (showLog ? 'Hide' : 'Show') + ' outreach log (' + outreach().length + ')</button>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="script">Call script</button></div>';
    h += '<div id="crm_import" hidden class="crm-import"></div>';
    h += '<div id="crm_script" hidden class="crm-script">' + esc(SCRIPT.replace('{biz}', bizName()).replace('{route}', '[usual route]').replace('{last}', '[last trip]')) + '\n\nConsent sentence: "' + esc(consentSentence()) + '"</div>';
    h += '<h4>Win-back worklist <span class="hint" style="margin:0;font-weight:400;">&mdash; sorted by wave, then next action. Red rows: do not contact. Yellow: call due.</span></h4>';
    if (!rows.length) h += '<div class="empty" id="crm_wl_empty">No win-back rows yet. Paste the workbook "Win back" rows (row ID, name, phone, last trip, wave) with Import win-back list.</div>';
    else h += '<div class="tbl-scroll"><table class="data" id="crm_worklist"><thead><tr><th>Row</th><th>Customer</th><th>Usual route</th><th>Last trip</th><th>Wave</th><th>Status</th><th>Next</th><th></th></tr></thead><tbody>' + rows.map(rowHtml).join('') + '</tbody></table></div>';
    h += '<h4>Account pipeline <span class="hint" style="margin:0;font-weight:400;">&mdash; week ending ' + esc(tg.ending) + (tg.ref ? ' (' + esc(tg.ref) + ')' : '') + ': approached ' + pc.approached + '/' + tg.approached + ' · qualified ' + pc.qualified + '/' + tg.qualified + ' · pilots proposed ' + pc.proposed + (tg.proposed == null ? '' : '/' + tg.proposed) + ' · pilots live ' + pc.live + '/' + tg.live + '</span></h4>';
    h += '<div class="stat-row" id="crm_pp_kpis">' + tile(pc.approached + ' / ' + tg.approached, 'Approached', pc.approached >= tg.approached ? 'mny-ok' : '') + tile(pc.qualified + ' / ' + tg.qualified, 'Qualified conversations', pc.qualified >= tg.qualified ? 'mny-ok' : '') + tile(pc.proposed + (tg.proposed == null ? '' : ' / ' + tg.proposed), 'Pilots proposed') + tile(pc.live + ' / ' + tg.live, 'Pilots live', pc.live >= tg.live ? 'mny-ok' : '') + '</div>';
    h += '<div class="crm-tools"><button class="btn btn-ghost btn-sm" type="button" data-act="imp" data-kind="pipeline">Import prospects list</button><button class="btn btn-ghost btn-sm" type="button" data-act="ppadd">Add prospect</button></div>';
    var pp = pipeline().slice().sort(function (a, b) { var ra = STAGE_RANK[a.status], rb = STAGE_RANK[b.status]; if ((ra < 0) !== (rb < 0)) return ra < 0 ? 1 : -1; if ((a.priority || 'Z') !== (b.priority || 'Z')) return (a.priority || 'Z') < (b.priority || 'Z') ? -1 : 1; return (a.date || '9') < (b.date || '9') ? -1 : 1; });
    if (!pp.length) h += '<div class="empty" id="crm_pp_empty">No prospects yet. Import the workbook "Prospects" rows (account, priority A/B/C, buyer, next action, owner, date, status).</div>';
    else h += '<div class="tbl-scroll"><table class="data" id="crm_pipeline"><thead><tr><th>Account</th><th>Pri</th><th>Buyer</th><th>Next action</th><th>Owner</th><th>Date</th><th>Stage</th><th></th></tr></thead><tbody>' + pp.map(prospectHtml).join('') + '</tbody></table></div>';
    if (showLog) {
      var log = outreach().slice().sort(function (a, b) { return String(a.at) < String(b.at) ? 1 : -1; }).slice(0, 60);
      h += '<h4>Outreach log <span class="hint" style="margin:0;font-weight:400;">&mdash; latest ' + log.length + ' of ' + outreach().length + '</span></h4>';
      h += '<div class="tbl-scroll"><table class="data" id="crm_log"><thead><tr><th>When</th><th>Caller</th><th>Row</th><th>Result</th><th>Reason</th><th>Quote</th><th>Trip</th><th>Consent</th><th>Note</th></tr></thead><tbody>' + log.map(function (e) { var t = e.tripId ? findTrip(e.tripId) : null; return '<tr><td>' + esc(stamp(e.at)) + '</td><td>' + esc(e.caller) + '</td><td class="mono">' + esc(e.rowId) + '</td><td>' + esc(RESULT_LABEL[e.result] || e.result) + '</td><td>' + esc(e.reasonCode) + '</td><td>' + esc(e.quote) + '</td><td>' + esc(t ? '#' + t.dispatchNo : e.tripId) + '</td><td>' + (e.consentRead ? 'Y' : 'N') + '</td><td>' + esc(e.note || '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
    }
    h += '</div>';
    panel.innerHTML = h;
    var ci = byId('crm_caller'); if (ci) ci.addEventListener('change', act(function () { crm().settings.caller = String(ci.value || '').trim().toUpperCase().slice(0, 6); save(); }));
  }
  function importBox(kind) {
    var host = byId('crm_import'); if (!host) return;
    if (!host.hidden && host.dataset.kind === kind) { host.hidden = true; return; }
    host.dataset.kind = kind; host.hidden = false;
    var what = kind === 'winback' ? 'Win-back list — columns: row ID, name, phone, last trip, wave (header row first)' : kind === 'outreach' ? 'Outreach log — exactly the workbook columns: date/time, caller, channel, customer row ID, result, reason code, quote given, trip ID booked, consent read Y/N, wave, status, next action date, owner, suppression flag, linked trip IDs' : 'Prospects — columns: account, priority (A/B/C), buyer, next action, owner, date, status';
    host.innerHTML = '<div class="hint" style="margin:0 0 4px;">' + esc(what) + '. Paste the CSV (copy the rows from the workbook; tabs are accepted too).</div><textarea id="crm_import_text" spellcheck="false"></textarea><div class="btn-row" style="margin-top:4px;"><button class="btn btn-go btn-sm" type="button" data-act="doimport" data-kind="' + esc(kind) + '">Import</button><button class="btn btn-ghost btn-sm" type="button" data-act="cancelimport">Cancel</button></div>';
    try { byId('crm_import_text').focus(); } catch (e) {}
  }
  function tsvToCsv(text) { if (text.indexOf('\t') < 0) return text; return text.split(/\r?\n/).map(function (line) { return line.split('\t').map(function (c) { return /[",]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(','); }).join('\n'); }
  function readForm(sel) { var f = document.querySelector(sel); if (!f) return {}; var o = {}; f.querySelectorAll('input,select').forEach(function (el) { o[el.id] = el.type === 'checkbox' ? el.checked : el.value; }); return o; }
  function onChange(e) {
    var s = e.target && e.target.closest ? e.target.closest('select[data-stage]') : null; if (!s) return;
    var id = s.getAttribute('data-stage'), p = findProspect(id); if (!p) return;
    if (!setStage(id, s.value, {})) { s.value = p.status; }
  }
  function onClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    try {
      if (a === 'toggle') { openRow = openRow === id ? null : id; render(); }
      else if (a === 'book') bookFrom(id);
      else if (a === 'text') textRow(id);
      else if (a === 'log') { var f = readForm('[data-form="' + id + '"]'); if (logOutcome(id, { result: f.crm_f_result, reasonCode: f.crm_f_reason, quote: f.crm_f_quote, nextAt: f.crm_f_next, consentRead: f.crm_f_consent, note: f.crm_f_note })) toast('Outcome saved for ' + id + '.'); }
      else if (a === 'saverow') { var r = findRow(id), g = readForm('[data-row="' + id + '"] .crm-detail'); if (r) { if (g.crm_f_wave) r.wave = g.crm_f_wave; r.owner = String(g.crm_f_owner || '').trim(); r.updatedAt = nowISO(); save(); render(); toast('Row ' + id + ' saved.'); } }
      else if (a === 'suppress') { var rr = findRow(id); if (rr) { var why = ''; try { why = window.prompt('Reason (what they said), kept on the record:', 'Asked not to be contacted') || ''; } catch (err) { why = ''; } suppress(rr.phone, { call: b.getAttribute('data-mode') !== 'text', text: true, reason: why, name: rr.name }); } }
      else if (a === 'unsuppress') { var ru = findRow(id); if (ru) unsuppress(ru.phone); }
      else if (a === 'mkconsent') { var rm = findRow(id); if (rm) { var how = ''; try { how = window.prompt('How was the written opt-in given? (text reply / signed form / email / web form)', 'text reply') || ''; } catch (err) { how = ''; } if (how && setConsent(rm.phone, 'marketing', how.trim().toLowerCase(), rm.name)) { toast('Marketing opt-in recorded for ' + fmtPhone(rm.phone) + '.'); render(); } } }
      else if (a === 'delrow') { if (window.confirm('Remove row ' + id + ' from the worklist? Its attempts stay in the outreach log.')) removeRow(id); }
      else if (a === 'imp') importBox(b.getAttribute('data-kind'));
      else if (a === 'cancelimport') { var ib = byId('crm_import'); if (ib) ib.hidden = true; }
      else if (a === 'doimport') { var txt = tsvToCsv(String((byId('crm_import_text') || {}).value || '')), kind = b.getAttribute('data-kind'); var res = kind === 'winback' ? importWinback(txt) : kind === 'outreach' ? importOutreach(txt) : importPipeline(txt); if (res && res.ok) { var ib2 = byId('crm_import'); if (ib2) ib2.hidden = true; } }
      else if (a === 'addrow') { var ph = '', nm = ''; try { nm = window.prompt('Customer name:', '') || ''; if (nm !== null) ph = window.prompt('Phone number:', '') || ''; } catch (err) {} if (nm && ph) { var nr = addRow({ name: nm.trim(), phone: ph.trim(), wave: 'this_week', source: 'manual' }); openRow = nr.id; render(); } }
      else if (a === 'export') exportOutreach();
      else if (a === 'exportwl') exportWorklist();
      else if (a === 'showlog') { showLog = !showLog; render(); }
      else if (a === 'script') { var sc = byId('crm_script'); if (sc) sc.hidden = !sc.hidden; }
      else if (a === 'ppadd') { var an = ''; try { an = window.prompt('Account / prospect name:', '') || ''; } catch (err) {} if (an.trim()) { var np = addProspect({ account: an.trim(), priority: 'B' }); if (np) { openProspect = np.id; render(); } } }
      else if (a === 'pptoggle') { openProspect = openProspect === id ? null : id; render(); }
      else if (a === 'ppsave') { var p = findProspect(id), pf = readForm('[data-ppform="' + id + '"]'); if (p) { if (String(pf.crm_p_account || '').trim()) p.account = String(pf.crm_p_account).trim(); p.priority = pf.crm_p_priority || ''; p.buyer = String(pf.crm_p_buyer || '').trim(); p.nextAction = String(pf.crm_p_next || '').trim(); p.owner = String(pf.crm_p_owner || '').trim(); p.date = String(pf.crm_p_date || '').trim(); p.notes = String(pf.crm_p_notes || '').trim(); p.updatedAt = nowISO(); save(); render(); toast('Prospect saved.'); } }
      else if (a === 'ppdel') { if (window.confirm('Remove this prospect?')) { removeProspect(id); openProspect = null; } }
    } catch (err) { try { console.error('[crm]', err); } catch (e2) {} }
  }
  /* Text a worklist customer from the dispatcher's phone — a win-back text is promotional: written opt-in required.
     Body goes through Messages.smsHref (gsmSafe inside). */
  function textRow(rowId) {
    var r = findRow(rowId); if (!r) return false;
    var chk = canText(r.phone, 'winback'); if (!chk.ok) { blockToast(r.phone, chk); return false; }
    var s = settings(), body = String(crm().settings.textTemplate || 'Hi {first}, this is {biz}. We would like to drive you again - call {phone} to book your next ride. Reply STOP to opt out.').replace('{first}', (r.name || '').split(/\s+/)[0] || 'there').replace('{biz}', bizName()).replace('{phone}', s.phone || s.cphone || '');
    var href = window.Messages && typeof window.Messages.smsHref === 'function' ? window.Messages.smsHref(r.phone, body) : '';
    if (!href) return false;
    try { var a = document.createElement('a'); a.href = href; a.rel = 'noopener'; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(function () { try { a.remove(); } catch (e) {} }, 500); } catch (e) { return false; }
    logOutcome(r.id, { result: 'reached', channel: 'text', note: 'Win-back text opened in Messages', nextAt: addDays(todayStr(), 3) });
    return true;
  }
  function open(rowId) {
    if (window.Simple && typeof window.Simple.enter === 'function' && window.Simple.isSimple && window.Simple.isSimple()) window.Simple.enter('money', 'accounts');
    else if (typeof window.goTab === 'function') window.goTab('accounts');
    if (rowId) openRow = rowId;
    render();
    try { var tr = document.querySelector('#crm_worklist tr[data-row="' + rowId + '"]') || byId(PANEL_ID); if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'center' }); } catch (e) {}
  }
  function openProspectById(id) { openProspect = id; open(); }

  /* ---------- hooks ---------- */
  function hook(name, after) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__crmWrapped) return;
    var wrapped = function () { var out; try { out = orig.apply(this, arguments); } finally { try { after.apply(null, arguments); } catch (e) {} } return out; };
    wrapped.__crmWrapped = true; wrapped._orig = orig; inheritFlags(wrapped, orig);
    window[name] = wrapped;
  }

  /* ---------- public API ---------- */
  window.CRM = {
    _loaded: true,
    render: render, open: open, openProspect: openProspectById, metrics: metrics,
    setCaller: function (v) { crm().settings.caller = String(v || '').trim().toUpperCase().slice(0, 6); save(); return crm().settings.caller; }, caller: initials,
    // worklist
    worklist: worklist, outreach: outreach, pipeline: pipeline, customers: customers, findRow: findRow, addRow: addRow, removeRow: removeRow, matchRow: matchRow,
    importWinback: importWinback, importOutreach: importOutreach, importPipeline: importPipeline, exportOutreach: exportOutreach, exportWorklist: exportWorklist, outreachCSV: outreachCSV,
    logOutcome: logOutcome, attempts: attempts, bookFrom: bookFrom, attribute: attribute, afterBook: afterBook, paidRides: paidRides, paidLabel: paidLabel, allPaidRides: allPaidRides, dueToday: dueToday,
    RESULTS: RESULTS, REASONS: REASONS.filter(Boolean), STATUSES: STATUSES, WAVES: WAVES,
    // consent + suppression
    customer: function (phone) { return custFor(phone, false); }, canText: canText, isSuppressed: isSuppressed, textBlock: textBlock, callBlock: callBlock, suppress: suppress, unsuppress: unsuppress, setConsent: setConsent, optOut: optOut, hasMarketingConsent: hasMarketingConsent, hasInfoConsent: hasInfoConsent, isMarketingKey: isMarketingKey,
    // pipeline
    addProspect: addProspect, setStage: setStage, removeProspect: removeProspect, pipelineCounts: pipelineCounts, currentTarget: currentTarget, STAGES: STAGES, WEEK_TARGETS: WEEK_TARGETS,
    parseCSV: parseCSV, phoneKey: phoneKey
  };

  /* ---------- boot ---------- */
  function boot() {
    if (POPOUT) {   // pop-out boards / wallboard / calls screen: suppression and consent still apply to every 📱 path; no panel, no Needs-you
      try { wrapMessages(); } catch (e) {}
      try { wrapMoney(); } catch (e) {}
      try { wrapCloud(); } catch (e) {}
      return;
    }
    try { ensureStyle(); } catch (e) {}
    try { crm(); customers(); } catch (e) {}
    hook('renderView', function (v) { if (v === 'accounts') render(); if (v === 'dispatch') ensureConsentBox(); });
    hook('renderAccounts', function () { render(); });
    hook('refreshBoard', function () { if (accountsActive()) render(); });
    hook('duplicateTrip', function () { stripCopiedRows(); });
    hook('classicDup', function () { stripCopiedRows(); });
    try { wrapMessages(); } catch (e) {}
    try { wrapMoney(); } catch (e) {}
    try { wrapCloud(); } catch (e) {}
    try { wrapCallerPop(); } catch (e) {}
    try { wrapSearch(); } catch (e) {}
    try { wrapNeedsYou(); } catch (e) {}
    try { ensureConsentBox(); } catch (e) {}
    try { render(); } catch (e) {}
    try { injectNeedsYou(); } catch (e) {}
    document.addEventListener('region:changed', function () { try { render(); } catch (e) {} });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
