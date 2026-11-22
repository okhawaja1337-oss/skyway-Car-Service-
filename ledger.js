/* ======================================================================
   Skyway — ledger.js
   Settle and reconcile (TURNAROUND-PLAN build row 3, app-gaps.md §4).

   STATE.ledger = {
     entries[]      double-entry journal lines {id, at, date, tripId, driverId, accountId,
                    kind, amount, ref, createdBy, dr, cr, memo, method, sub, key, settlementId}
                    kind: fare-collected-office | fare-collected-driver | base-fee-owed |
                          base-fee-received | tip | toll | reimbursement | deduction | refund |
                          square-fee | payout (sub 'driver' | 'square')
                          + card-fee-recovered (card fee the office keeps) and invoice-paid
                          (an account paid its invoice) — both needed to keep the books whole.
                    Every line names a debit account (dr) and a credit account (cr) for the
                    same amount, so the journal export balances by construction.
                    Ride lines follow the trip: when a journaled ride is canceled, re-priced, re-dated,
                    reassigned or its pay type changes, the stale line is retired — voided (moved to
                    voided[]) while it is unsettled or in a draft run, or reversed with a counter line
                    {rev:true, reverses:<id>, adj:true} once it sat in a PAID run — and the right line is
                    written again (adj:true when it replaces a paid one, so it rolls into the next run).
                    Money collected on a ride that is then canceled moves to "Held for passengers" with no
                    driver, until it is refunded. A trip that already has a refund is left as it is.
                    A refund reverses each collected line against its own credit account: the driver's share
                    (fare, tip, toll) as kind 'refund' (Due to drivers → Square clearing), the office's card fee
                    as a reversal of the card-fee-recovered line ({rev:true}, Card fee recovery → Square clearing).
                    All rows of one refund share refundId and name the line they reverse (refundOf).
                    invoice-fee: the card fee (CCU) an invoice adds on top of the rides (A/R → CCU income), written
                    when the invoice is opened, so A/R clears to zero when the invoice is paid.
     voided[]       retired lines kept for the audit trail {…line, voidedAt, voidReason}
     receipts[]     numbered cash base-fee receipts {no, id, at, date, driverId, amount, method, note, entryId, by}
     receiptSeq     next receipt number (1-based)
     settlements[]  one per driver per period {id, driverId, from, to, runAt, runBy, status:'draft'|'paid',
                    lines{officeFares,tips,tolls,reimbursements,deductions,refunds,baseOwed,baseReceived,baseWithheld,driverFares,adjustments},
                    net, direction:'pay-driver'|'driver-pays'|'even', tripIds, entryIds, paidAt, paidMethod, paidBy,
                    stale (a ride changed after the draft was run — re-run before paying)}
                    Marking a run paid writes a clearing line base-fee-received/method 'withheld' (Due to drivers →
                    Due from drivers) for the base fee kept out of the payout, so it counts as cash received.
     imports[]      Square CSV imports {id, at, kind:'transactions'|'payouts', fileName, rows, added, skipped, hash, times}
     payouts[]      Square payouts by Square payout id {id, date, amount, fees, status, bankId}
     squarePayments[] Square transactions by payment id {id, date, amount, fee, net, tip, payoutId, ref, tripId, type}
     bank[]         bank credits typed by hand {id, date, amount, memo, payoutId}
     settings       {threshold1099: 2000}
   }
   drivers[].w9 = {onFileAt:'YYYY-MM-DD'}  (a date only; no document is stored)
   trip.refund = {amount, reason, at, by, entryId}; trip.payment gains squarePaymentId, feeCents,
   payoutId, refundedCents (merged, never replaced — same rule as money.js).

   What it does:
   - A sweep after every persist() creates the missing journal lines for Completed / No-Show
     trips from trip.payType + trip.payment (idempotent by key = tripId:kind), so whichever
     button marked a ride paid, the ledger follows. One pass builds its indexes (lines by trip,
     keys, refunded trips) so a sweep is O(trips + entries) and a save stays quick at a year of rides.
     A line written for a ride while a DRAFT run covers it marks that draft stale (re-run before
     paying), so money journaled between "Run settlement" and "Mark paid" is never stranded.
   - Cash base-fee receipts: numbered, printable (number, driver, amount, date, signed line).
   - Settlement run per driver per week behind the owner PIN: office-collected fares, tips,
     tolls, reimbursements, authorised deductions, refunds, base fee owed (the console's own
     driverSettlement() math) vs received → net; stored, printable, "Mark paid" with method/date
     (net > 0 pays the driver → payout line; net < 0 the driver pays → numbered receipt).
     A driver without a W-9 on file cannot be added to a payout run.
   - Refund behind the owner PIN: reverses the trip's collected lines (driver share first, the
     office's card fee last) each against its own account, and tags the trip.
   - Idempotent Square CSV import (Transactions / Payouts exports, detected by header; payout
     and payment ids stored; a file imported twice changes nothing); bank credits typed by hand
     are matched to payouts (auto by amount within 3 days, or by hand).
   - Weekly reconciliation panel, balanced journal CSV, W-9 flag per driver, 1099-NEC candidate
     list (paid $2,000 or more through Skyway's Square in the calendar year).
   - The Business P&L shows revenue as cash actually received; the old completed × $6.04 figure
     stays beside it as "Fees owed (modeled)".
   UI: MONEY → Earnings (settlement runs, receipts, refunds) and MONEY → Business (reconciliation,
   Square import, bank credits, invoices, W-9 / 1099, journal export) — both reachable in Simple
   mode. Fleet gets a "W-9 on file" date on the driver form.

   Wrapper pattern (money.js / driver-link.js / sync.js): IIFE, the original kept as
   window.fn._orig, window.fn replaced by a wrapper that calls through. STATE is the console's
   top-level let. Never edits index.html. Works with Cloud off (the Square refund call is optional).
   Plain ES2019, no build step, no network. Skipped in pop-out windows.

   Public API: window.Ledger (see bottom).
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;

  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }
  if (POPOUT) return;
  if (window.Ledger && window.Ledger._loaded) return;

  /* ---------- helpers (own copies; globals may be missing) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[ledger] ' + m); } catch (e) {} }
  function save() { if (typeof window.save === 'function') { try { window.save(); return; } catch (e) {} } if (typeof window.saveNow === 'function') { try { window.saveNow(); } catch (e) {} } }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  function trips() { if (!Array.isArray(STATE.trips)) STATE.trips = []; return STATE.trips; }
  function drivers() { if (!Array.isArray(STATE.drivers)) STATE.drivers = []; return STATE.drivers; }
  function accounts() { return Array.isArray(STATE.accounts) ? STATE.accounts : []; }
  function invoices() { if (!Array.isArray(STATE.invoices)) STATE.invoices = []; return STATE.invoices; }
  function findTrip(id) { if (id && typeof id === 'object') return id; return trips().filter(function (t) { return t && t.id === id; })[0] || null; }
  function tripByNo(no) { no = String(no || '').replace(/^#/, '').trim(); return trips().filter(function (t) { return t && String(t.dispatchNo) === no; })[0] || null; }
  function findDriver(id) { return drivers().filter(function (d) { return d && d.id === id; })[0] || null; }
  function findAccount(id) { return accounts().filter(function (a) { return a && a.id === id; })[0] || null; }
  function driverName(id) { var d = findDriver(id); return d ? (d.name || 'Driver') : (id ? 'Driver' : 'No driver'); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayStr() { if (typeof window.todayStr === 'function') { try { return window.todayStr(); } catch (e) {} } var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function nowISO() { return new Date().toISOString(); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { try { console.error('[ledger]', err); } catch (e2) {} } }; }
  function num(n) { n = Number(n); return isFinite(n) ? n : 0; }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function money(n) { if (typeof window.money === 'function') { try { return window.money(n); } catch (e) {} } n = Number(n) || 0; return '$' + n.toFixed(2); }
  function signed(n) { n = round2(n); return (n < 0 ? '-' : '') + money(Math.abs(n)); }
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
  function fmtDate(s) { if (typeof window.fmtDate === 'function') { try { return window.fmtDate(s); } catch (e) {} } return String(s || ''); }
  function dateOf(iso) { var d = new Date(iso); if (isNaN(d)) return ''; return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function addDays(s, n) { var p = String(s).split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function dayDiff(a, b) { var pa = String(a).split('-').map(Number), pb = String(b).split('-').map(Number); return Math.round((new Date(pb[0], pb[1] - 1, pb[2]) - new Date(pa[0], pa[1] - 1, pa[2])) / 86400000); }
  function bizName() { return settings().name || 'Skyway Car Service'; }
  function csvCell(v) { if (typeof window.csv === 'function') { try { return window.csv(v); } catch (e) {} } v = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function download(name, content, type) { if (typeof window.download === 'function') { try { window.download(name, content, type); return true; } catch (e) {} } try { var blob = new Blob([content], { type: type || 'text/plain' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); return true; } catch (e) { return false; } }
  function openPrint(html) { if (typeof window.openPrint === 'function') { try { window.openPrint(html); return true; } catch (e) {} } try { var w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); return true; } } catch (e) {} return false; }
  function hashStr(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ('00000000' + h.toString(16)).slice(-8) + '.' + s.length.toString(36); }
  /* Week = Sunday..Saturday, same as the console's periodRange('week') */
  function weekOf(dateStr) {
    if (typeof window.periodRange === 'function') { try { var r = window.periodRange('week', dateStr || todayStr()); if (r && isDate(r.from) && isDate(r.to)) return r; } catch (e) {} }
    var s = isDate(dateStr) ? dateStr : todayStr(), p = s.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]);
    var from = addDays(s, -d.getDay()); return { from: from, to: addDays(from, 6) };
  }
  function who() { try { if (window.Recover && typeof window.Recover.who === 'function') { var w = window.Recover.who(); if (w) return String(w); } } catch (e) {} return 'dispatcher'; }
  function cardFee(t) { if (!t || t.payType !== 'Credit Card') return 0; if (typeof window.cardFeeAmt === 'function') { try { return round2(window.cardFeeAmt(num(t.fare))); } catch (e) {} } return 0; }
  function gratuity(t) { try { if (window.Money && typeof window.Money.gratuity === 'function') return round2(window.Money.gratuity(t)); } catch (e) {} return 0; }
  function officeTotal(t) { try { if (window.Money && typeof window.Money.total === 'function') return round2(window.Money.total(t)); } catch (e) {} return round2(num(t.fare) + num(t.tolls) + num(t.tip) + cardFee(t)); }
  /* "Account ride" — one rule everywhere (owner decision 6): pay type first, account only when the pay type is blank */
  function isAccountTrip(t) { var pay = String((t && t.payType) || '').trim(); return /account/i.test(pay) || (!pay && !!(t && t.accountId)); }
  function isCard(t) { return !!t && t.payType === 'Credit Card'; }
  function isCash(t) { return !!t && (t.payType === 'Cash' || (!t.payType && !t.accountId)); }

  /* ---------- owner PIN (settings.adminPin — simple.js's PIN, once per session like Settings) ---------- */
  var unlocked = false, hinted = false;
  /* recover.js: a signed-in owner (or an owner PIN already given to recover.js this session) is not asked again */
  function recoverOwner() { try { var R = window.Recover; return !!(R && R._loaded && typeof R.who === 'function' && R.who() && R.role() === 'owner'); } catch (e) { return false; } }
  function ownerPinOK(what) {
    if (recoverOwner()) return true;
    var pin = String(settings().adminPin || '').trim();
    if (!/^\d{4}$/.test(pin)) { if (!hinted) { hinted = true; toast('No admin PIN is set — set one in Settings so settlement runs and refunds are owner-only.'); } return true; }
    if (unlocked) return true;
    var a = null; try { a = window.prompt('Owner PIN to ' + (what || 'continue') + ':', ''); } catch (e) { a = null; }
    if (a === null) return false;
    if (String(a).trim() === pin) { unlocked = true; return true; }
    toast('Wrong PIN.', true); return false;
  }

  /* ---------- STATE.ledger ---------- */
  var DEFAULT_1099 = 2000;
  function led() {
    var L = STATE.ledger;
    if (!L || typeof L !== 'object' || Array.isArray(L)) L = STATE.ledger = {};
    if (!Array.isArray(L.entries)) L.entries = [];
    if (!Array.isArray(L.voided)) L.voided = [];
    if (!Array.isArray(L.receipts)) L.receipts = [];
    if (!Array.isArray(L.settlements)) L.settlements = [];
    if (!Array.isArray(L.imports)) L.imports = [];
    if (!Array.isArray(L.payouts)) L.payouts = [];
    if (!Array.isArray(L.squarePayments)) L.squarePayments = [];
    if (!Array.isArray(L.bank)) L.bank = [];
    if (!(Number(L.receiptSeq) >= 1)) L.receiptSeq = Math.max(1, L.receipts.reduce(function (m, r) { return Math.max(m, Number(r.no) || 0); }, 0) + 1);
    if (!L.settings || typeof L.settings !== 'object') L.settings = {};
    if (!(Number(L.settings.threshold1099) > 0)) L.settings.threshold1099 = DEFAULT_1099;
    return L;
  }
  function entries() { return led().entries; }
  /* the live line for a key: a reversed line is history, not the current state of that slot.
     keys (optional) is a key → live line map built once by keyIndex() for a whole sweep. */
  function byKey(key, keys) { if (keys) return keys[key] || null; return entries().filter(function (e) { return e.key === key && !e.reversedBy; })[0] || null; }
  function keyIndex() { var m = {}; entries().forEach(function (e) { if (e.key && !e.reversedBy) m[e.key] = e; }); return m; }
  function entry(id) { return entries().filter(function (e) { return e.id === id; })[0] || null; }
  /* refund rows: kind 'refund' (the driver's share) or any row carrying refundId (the card-fee reversal) */
  function isRefundRow(e) { return e.kind === 'refund' || !!e.refundId; }
  function refundRows(t) { return entries().filter(function (e) { return e.tripId === t.id && isRefundRow(e); }); }
  function refundedTrips() { var s = {}; entries().forEach(function (e) { if (e.tripId && isRefundRow(e)) s[e.tripId] = true; }); return s; }

  /* ---------- accounts (names used on the journal) ---------- */
  var ACCT = {
    cash: 'Cash on hand', bank: 'Bank', square: 'Square clearing', ar: 'Accounts receivable',
    drvcash: 'Driver-held cash (memo)', fares: 'Driver fares collected by driver (memo)',
    due: 'Due to drivers', duefrom: 'Due from drivers (base fees)', basefee: 'Base fee income',
    cardfee: 'Card fee recovery', deduct: 'Deductions (authorised)', sqfees: 'Square fees',
    reimb: 'Reimbursable expenses', noshow: 'No-show fee income', held: 'Held for passengers (refund due)',
    ccu: 'Invoice card fee (CCU) income'
  };
  function cashAcct(method) { method = String(method || 'cash').toLowerCase(); return method === 'cash' ? ACCT.cash : ACCT.bank; }
  function collectAcct(method) { return method === 'account' ? ACCT.ar : ACCT.square; }

  /* addEntry(spec, keys?) — idempotent by spec.key (keys: a keyIndex() map kept current for a sweep); returns {row, added} */
  function addEntry(e, keys) {
    var amt = round2(e.amount); if (!(amt > 0)) return { row: null, added: false };
    if (e.key) { var ex = byKey(e.key, keys); if (ex) return { row: ex, added: false }; }
    var row = {
      id: uid(), at: nowISO(), date: isDate(e.date) ? e.date : todayStr(), tripId: e.tripId || '', driverId: e.driverId || '', accountId: e.accountId || '',
      kind: e.kind, amount: amt, ref: e.ref || '', createdBy: e.createdBy || who(), dr: e.dr, cr: e.cr, memo: e.memo || '', method: e.method || '', sub: e.sub || '', key: e.key || '', settlementId: ''
    };
    entries().push(row);
    if (keys && row.key) keys[row.key] = row;
    return { row: row, added: true };
  }

  /* ---------- the sweep: journal lines from trips (idempotent) ---------- */
  function tripRef(t) { return '#' + (t.dispatchNo != null ? t.dispatchNo : ''); }
  var RIDE_KINDS = { 'fare-collected-office': 1, 'fare-collected-driver': 1, 'tip': 1, 'toll': 1, 'card-fee-recovered': 1 };
  function collected(p) { return p.status === 'paid' || p.status === 'refunded' || p.status === 'noshow-fee'; }
  function collectedAmt(t) { var p = t.payment || {}; if (t.status === 'No-Show' || t.status === 'Canceled' || t.status === 'Disregard') { if (p.amount != null) return round2(p.amount); if (p.amountCents) return round2(Number(p.amountCents) / 100); if (p.status === 'paid') return officeTotal(t); return 0; } return officeTotal(t); }
  /* What the journal should hold for this trip right now: key → line spec. */
  function desiredLines(t) {
    var out = {}; if (!t || !t.id || t._hist) return out;
    var p = t.payment || {}, date = isDate(t.date) ? t.date : todayStr(), fare = round2(t.fare), tolls = round2(t.tolls), tip = round2(t.tip);
    var base = { tripId: t.id, driverId: t.driverId || '', accountId: t.accountId || '', date: date, ref: tripRef(t) };
    function want(kind, amount, extra) { amount = round2(amount); if (!(amount > 0)) return; var key = t.id + ':' + kind + (extra && extra.sub ? ':' + extra.sub : ''); out[key] = Object.assign({}, base, { kind: kind, amount: amount, key: key }, extra || {}); }
    function office(method, memo) {
      var dr = collectAcct(method);
      want('fare-collected-office', fare, { dr: dr, cr: ACCT.due, method: method, memo: memo || '' });
      if (tip > 0) want('tip', tip, { dr: dr, cr: ACCT.due, method: method });
      if (tolls > 0) want('toll', tolls, { dr: dr, cr: ACCT.due, method: method });
      if (method === 'card') { var cf = cardFee(t); if (cf > 0) want('card-fee-recovered', cf, { dr: dr, cr: ACCT.cardfee, method: method, memo: 'card fee kept by the office' }); }
      if (method === 'account') { var g = gratuity(t); if (g > 0) want('tip', g, { dr: dr, cr: ACCT.due, method: method, memo: 'automatic gratuity', sub: 'gratuity' }); }
    }
    if (t.status === 'Completed') {
      if (isAccountTrip(t)) office('account', 'account ride (invoiced)');
      else if (isCard(t)) { if (collected(p)) office('card', 'card ride collected by the office'); }
      else if (isCash(t) || (p.method === 'cash')) want('fare-collected-driver', fare, { dr: ACCT.drvcash, cr: ACCT.fares, method: 'cash', memo: 'cash fare kept by the driver' + (tolls ? ' (+ ' + money(tolls) + ' tolls)' : '') + (tip ? ' (+ ' + money(tip) + ' tip)' : '') });
    } else if (t.status === 'No-Show' && isCard(t) && collected(p)) {
      var amt = collectedAmt(t);
      if (amt > 0) want('fare-collected-office', amt, { dr: ACCT.square, cr: t.driverId ? ACCT.due : ACCT.noshow, method: 'card', memo: 'no-show fee', sub: 'noshow' });
    } else if ((t.status === 'Canceled' || t.status === 'Disregard') && isCard(t) && collected(p) && p.method !== 'cash') {
      /* the card was charged but the ride did not happen: the money is the passenger's until refunded — nobody is owed it */
      var held = collectedAmt(t);
      if (held > 0) want('fare-collected-office', held, { driverId: '', dr: ACCT.square, cr: ACCT.held, method: 'card', memo: 'collected on a ride that was ' + String(t.status || '').toLowerCase() + ' — refund it or record why it is kept', sub: 'held' });
    }
    return out;
  }
  function sameLine(e, s) { return round2(e.amount) === round2(s.amount) && (e.driverId || '') === (s.driverId || '') && (e.accountId || '') === (s.accountId || '') && e.dr === s.dr && e.cr === s.cr && (e.method || '') === (s.method || '') && e.date === s.date; }
  function activeRideLines(tripId, idx) { if (idx) return idx[tripId] || []; return entries().filter(function (e) { return e.tripId === tripId && RIDE_KINDS[e.kind] && !e.rev && !e.reversedBy; }); }
  function rideIndex() { var idx = {}; entries().forEach(function (e) { if (e.tripId && RIDE_KINDS[e.kind] && !e.rev && !e.reversedBy) (idx[e.tripId] = idx[e.tripId] || []).push(e); }); return idx; }
  var corrections = [];   // this session's corrections, for the toast
  /* Retire a ride line that no longer matches its trip. Unsettled or in a draft → voided (kept in voided[]);
     in a PAID run → reversed with a counter line that rolls into the driver's next run. Returns 'voided' | 'reversed'. */
  function retireLine(e, reason, ctx) {
    var L = led(), s = e.settlementId ? settlementById(e.settlementId) : null, keys = ctx && ctx.keys;
    if (keys && e.key && keys[e.key] === e) delete keys[e.key];   // the slot is free again for the corrected line
    if (s && s.status === 'paid') {
      var r = addEntry({ kind: e.kind, sub: e.sub, amount: e.amount, tripId: e.tripId, driverId: e.driverId, accountId: e.accountId, date: todayStr(), method: e.method, dr: e.cr, cr: e.dr, ref: e.ref, memo: 'reversal — ' + reason + ' after ' + s.id + ' was paid', key: e.key + ':rev:' + e.id, createdBy: 'ledger' }, keys);
      if (r.row) { r.row.rev = true; r.row.reverses = e.id; r.row.adj = true; e.reversedBy = r.row.id; }
      corrections.push({ tripId: e.tripId, ref: e.ref, what: reason, how: 'reversed', settlementId: s.id, at: nowISO() });
      return 'reversed';
    }
    var i = L.entries.indexOf(e); if (i >= 0) L.entries.splice(i, 1);
    L.voided.push(Object.assign({}, e, { voidedAt: nowISO(), voidReason: reason }));
    if (s) { s.stale = true; s.staleReason = (e.ref || e.tripId) + ' ' + reason; }
    corrections.push({ tripId: e.tripId, ref: e.ref, what: reason, how: 'voided', settlementId: s ? s.id : '', at: nowISO() });
    return 'voided';
  }
  function changeReason(e, s, t) {
    if (!s) return !t ? 'trip deleted' : t.status === 'Canceled' || t.status === 'Disregard' ? 'trip ' + t.status.toLowerCase() : 'no longer collected this way (status or pay type changed)';
    if ((e.driverId || '') !== (s.driverId || '')) return 'driver changed';
    if (round2(e.amount) !== round2(s.amount)) return 'amount changed ' + money(e.amount) + ' → ' + money(s.amount);
    if (e.date !== s.date) return 'date changed ' + e.date + ' → ' + s.date;
    if (e.dr !== s.dr || e.cr !== s.cr || (e.method || '') !== (s.method || '')) return 'pay type changed';
    return 'changed';
  }
  function paidCovering(driverId, date) { return driverId ? led().settlements.filter(function (s) { return s.driverId === driverId && s.status === 'paid' && date >= s.from && date <= s.to; })[0] || null : null; }
  function draftCovering(driverId, date) { return driverId ? led().settlements.filter(function (s) { return s.driverId === driverId && s.status !== 'paid' && date >= s.from && date <= s.to; })[0] || null : null; }
  /* A draft run that no longer matches the books must be run again before it is paid. */
  function markStale(s, why, c) { if (!s || s.status === 'paid') return; s.stale = true; s.staleReason = why; corrections.push(Object.assign({ what: why, how: 'added', settlementId: s.id, at: nowISO() }, c || {})); }
  /* Bring one trip's ride lines in line with the trip (idempotent). ctx = {idx, keys, refunded} from a sweep
     (all optional: without them the helpers scan the journal). Returns the number of lines written or retired. */
  function ensureTripEntries(t, ctx) {
    if (!t || !t.id || t._hist) return 0;
    ctx = ctx || {};
    var n = 0, want = desiredLines(t), have = activeRideLines(t.id, ctx.idx);
    if (have.length && (ctx.refunded ? ctx.refunded[t.id] : refundedSoFar(t) > 0)) return 0;   // a refunded ride keeps its lines: the refund already reversed them
    var paidSlot = {};
    have.forEach(function (e) {
      var s = want[e.key];
      if (s && sameLine(e, s)) { delete want[e.key]; return; }
      var how = retireLine(e, changeReason(e, s, t), ctx); n++;
      if (how === 'reversed') paidSlot[e.key] = true;
    });
    Object.keys(want).forEach(function (k) {
      var s = want[k], r = addEntry(s, ctx.keys);
      if (!r.added) return;
      n++;
      if (paidSlot[k] || paidCovering(s.driverId, s.date)) { r.row.adj = true; r.row.memo = (r.row.memo ? r.row.memo + ' — ' : '') + (paidSlot[k] ? 'corrected after the run was paid' : 'late: the week was already paid'); return; }
      /* new money for a ride while a draft run covers it: the draft is out of date — re-run before paying */
      var d = draftCovering(s.driverId, s.date);
      if (d) markStale(d, (s.ref || t.id) + ' ' + (s.kind === 'fare-collected-office' ? 'collected' : s.kind) + ' ' + money(s.amount) + ' added after the run', { tripId: t.id, ref: s.ref });
    });
    return n;
  }
  /* The card fee (CCU) an invoice adds on top of its rides is a receivable too: A/R → CCU income, once per invoice,
     written when the invoice is opened (and by the sweep), so A/R clears to zero when the invoice is paid. */
  function ensureInvoiceLines(ctx) {
    ctx = ctx || {}; var n = 0;
    invoices().forEach(function (inv) {
      if (!inv || inv.no == null || !(num(inv.total) > 0) || !Array.isArray(inv.tripIds) || !inv.tripIds.length) return;
      var key = 'invoice:' + inv.no + ':fee'; if (byKey(key, ctx.keys)) return;
      var ar = 0, journaled = 0;
      inv.tripIds.forEach(function (id) { activeRideLines(id, ctx.idx).forEach(function (e) { if (e.dr === ACCT.ar) { ar += e.amount; journaled++; } }); });
      if (!journaled) return;   // the rides are not on the books yet; next sweep
      var fee = round2(num(inv.total) - ar); if (!(fee > 0)) return;
      var r = addEntry({ kind: 'invoice-fee', amount: fee, accountId: inv.accountId || '', date: isDate(inv.date) ? inv.date : todayStr(), method: 'account', dr: ACCT.ar, cr: ACCT.ccu, ref: 'INV-' + inv.no, memo: 'card fee (CCU) on invoice #' + inv.no + (inv.account ? ' — ' + inv.account : ''), key: key, createdBy: 'ledger' }, ctx.keys);
      if (r.added) n++;
    });
    return n;
  }
  var sweeping = false;
  function sweep(silent) {
    if (sweeping) return 0; sweeping = true;
    var n = 0, before = corrections.length;
    try {
      led();
      var ctx = { idx: rideIndex(), keys: keyIndex(), refunded: refundedTrips() }, seen = {};
      trips().forEach(function (t) { if (t && t.id) seen[t.id] = true; try { n += ensureTripEntries(t, ctx); } catch (e) {} });
      Object.keys(ctx.idx).forEach(function (tid) { if (seen[tid]) return; ctx.idx[tid].forEach(function (e) { try { if (entries().indexOf(e) >= 0 && !e.reversedBy) { retireLine(e, 'trip deleted', ctx); n++; } } catch (e2) {} }); });
      try { n += ensureInvoiceLines(ctx); } catch (e) {}
    } finally { sweeping = false; }
    if (corrections.length > before) {
      var fresh = corrections.slice(before), stale = fresh.filter(function (c) { return c.settlementId; });
      if (stale.length) {
        toast(stale.length + ' journaled ride' + (stale.length === 1 ? '' : 's') + ' changed after a settlement run (' + stale.slice(0, 3).map(function (c) { return c.ref + ': ' + c.what; }).join('; ') + ')' + (stale.some(function (c) { return c.how !== 'reversed'; }) ? ' — re-run that draft before paying it.' : ' — the reversal rolls into the next run.'), true);
        try { renderEarnPanel(); } catch (e) {}   // the run's row shows "changed — re-run" right away
      }
    }
    if (n && !silent) save();
    return n;
  }

  /* ---------- cash base-fee receipts ---------- */
  function receiptNo(n) { return 'R-' + String(n).padStart(6, '0'); }
  function cashReceipt(driverId, amount, method, note, opts) {
    opts = opts || {};
    var d = findDriver(driverId); if (!d) { toast('Pick a driver for the receipt.', true); return null; }
    amount = round2(amount); if (!(amount > 0)) { toast('Enter the amount received.', true); return null; }
    method = String(method || 'cash').toLowerCase();
    var L = led(), no = Number(L.receiptSeq) || 1, date = isDate(opts.date) ? opts.date : todayStr();
    (L.receipts || []).forEach(function (x) { if (x && Number(x.no) >= no) no = Number(x.no) + 1; });   // a receipt that arrived from another station already holds this number
    var r = addEntry({ kind: 'base-fee-received', amount: amount, driverId: d.id, date: date, method: method, dr: cashAcct(method), cr: ACCT.duefrom, ref: receiptNo(no), memo: note || 'base fee received', createdBy: opts.by || who() });
    if (!r.row) return null;
    var rec = { no: no, id: uid(), at: nowISO(), date: date, driverId: d.id, driverName: d.name || '', amount: amount, method: method, note: note || '', entryId: r.row.id, by: opts.by || who(), settlementId: opts.settlementId || '' };
    if (opts.settlementId) r.row.settlementId = opts.settlementId;
    L.receipts.push(rec); L.receiptSeq = no + 1;
    save();
    if (!opts.quiet) { toast('Receipt ' + receiptNo(no) + ' — ' + money(amount) + ' from ' + (d.name || 'driver') + '.'); render(); }
    return rec;
  }
  function receiptHTML(rec) {
    var s = settings();
    return '<div style="max-width:420px;margin:0 auto;font-family:Arial,sans-serif;font-size:14px;">'
      + '<div style="text-align:center;"><h2 style="margin:4px 0;">' + esc(s.name || bizName()) + '</h2><div>' + esc(s.addr || '') + (s.city ? ' · ' + esc(s.city) : '') + '</div><div>' + (s.phone ? 'Tel ' + esc(s.phone) : '') + (s.base ? ' · Base ' + esc(s.base) : '') + '</div><hr></div>'
      + '<h3 style="margin:6px 0;text-align:center;">Base fee receipt <span style="font-family:Consolas,monospace;">' + esc(receiptNo(rec.no)) + '</span></h3>'
      + '<table style="width:100%;border-collapse:collapse;">'
      + '<tr><td style="padding:4px 8px;">Receipt number</td><td style="padding:4px 8px;text-align:right;font-family:Consolas,monospace;font-weight:700;">' + esc(receiptNo(rec.no)) + '</td></tr>'
      + '<tr><td style="padding:4px 8px;">Date</td><td style="padding:4px 8px;text-align:right;">' + esc(fmtDate(rec.date)) + '</td></tr>'
      + '<tr><td style="padding:4px 8px;">Received from (driver)</td><td style="padding:4px 8px;text-align:right;">' + esc(rec.driverName || driverName(rec.driverId)) + '</td></tr>'
      + '<tr><td style="padding:4px 8px;">Amount</td><td style="padding:4px 8px;text-align:right;font-weight:700;font-size:18px;">' + esc(money(rec.amount)) + '</td></tr>'
      + '<tr><td style="padding:4px 8px;">Paid by</td><td style="padding:4px 8px;text-align:right;">' + esc(rec.method) + '</td></tr>'
      + (rec.note ? '<tr><td style="padding:4px 8px;">For</td><td style="padding:4px 8px;text-align:right;">' + esc(rec.note) + '</td></tr>' : '')
      + '</table><hr>'
      + '<div style="display:flex;justify-content:space-between;gap:24px;margin-top:28px;"><div style="flex:1;border-top:1px solid #333;padding-top:4px;">Received by (signed)</div><div style="flex:1;border-top:1px solid #333;padding-top:4px;">Driver (signed)</div></div>'
      + '<div style="text-align:center;color:#555;margin-top:14px;font-size:12px;">Keep this receipt. It is the office copy of a cash base fee.</div></div>';
  }
  function printReceipt(noOrId) {
    var rec = led().receipts.filter(function (r) { return r.id === noOrId || String(r.no) === String(noOrId); })[0];
    if (!rec) { toast('Receipt not found.', true); return false; }
    return openPrint(receiptHTML(rec));
  }

  /* ---------- reimbursements, deductions ---------- */
  function reimburse(driverId, amount, note, tripId) {
    var d = findDriver(driverId); if (!d) { toast('Pick a driver.', true); return null; }
    amount = round2(amount); if (!(amount > 0)) { toast('Enter the amount.', true); return null; }
    if (!String(note || '').trim()) { toast('Say what the reimbursement is for (receipt, toll, car wash…).', true); return null; }
    var t = tripId ? findTrip(tripId) : null;
    var r = addEntry({ kind: 'reimbursement', amount: amount, driverId: d.id, tripId: t ? t.id : '', date: t && isDate(t.date) ? t.date : todayStr(), dr: ACCT.reimb, cr: ACCT.due, memo: String(note).trim(), ref: t ? tripRef(t) : '' });
    save(); toast('Reimbursement ' + money(amount) + ' for ' + d.name + ' recorded.'); render();
    return r.row;
  }
  /* A deduction is refused without an authority (the plan's "deduction authority"). */
  function deduct(driverId, amount, authority, note) {
    var d = findDriver(driverId); if (!d) { toast('Pick a driver.', true); return null; }
    amount = round2(amount); if (!(amount > 0)) { toast('Enter the amount.', true); return null; }
    authority = String(authority || '').trim();
    if (!authority) { toast('A deduction needs an authority (the agreement clause or the signed authorisation). Not recorded.', true); return null; }
    var r = addEntry({ kind: 'deduction', amount: amount, driverId: d.id, date: todayStr(), dr: ACCT.due, cr: ACCT.deduct, memo: String(note || '').trim(), ref: 'authority: ' + authority });
    r.row.authority = authority;
    save(); toast('Deduction ' + money(amount) + ' for ' + d.name + ' recorded (' + authority + ').'); render();
    return r.row;
  }

  /* ---------- W-9 ---------- */
  function hasW9(d) { d = typeof d === 'string' ? findDriver(d) : d; return !!(d && d.w9 && isDate(d.w9.onFileAt)); }
  function setW9(driverId, dateStr) {
    var d = findDriver(driverId); if (!d) return false;
    if (dateStr && isDate(dateStr)) { if (!d.w9 || typeof d.w9 !== 'object') d.w9 = {}; d.w9.onFileAt = dateStr; }
    else if (d.w9) delete d.w9;
    save(); return true;
  }

  /* ---------- settlement ---------- */
  /* Same formula as the console's driverSettlement() (feeWeek × days/7 + feeTrip × rides + feePct × fares), but on
     Completed rides only: a weekly close must not charge a base fee on a ride that is still Booked or Dispatched. */
  function baseOwedFor(driverId, from, to) {
    var d = findDriver(driverId); if (!d) return 0;
    var days = dayDiff(from, to) + 1; try { if (typeof window.daysBetween === 'function') days = Number(window.daysBetween(from, to)) || days; } catch (e) {}
    var ts = trips().filter(function (t) { return t && !t._hist && t.driverId === d.id && t.status === 'Completed' && t.date >= from && t.date <= to; });
    var fares = ts.reduce(function (a, t) { return a + num(t.fare); }, 0);
    return round2(num(d.feeWeek) * days / 7 + num(d.feeTrip) * ts.length + fares * num(d.feePct) / 100);
  }
  /* Ride money (fares, tips, tolls, card fees) belongs to the week the ride happened; receipts, deductions,
     reimbursements and refunds roll into the next run whenever they are still unsettled. */
  /* Adjustments (adj: a reversal of a paid run's line, or its replacement) roll into whichever run comes next. */
  function unsettledFor(driverId, from, to) {
    return entries().filter(function (e) {
      if (e.driverId !== driverId || e.settlementId || e.kind === 'base-fee-owed' || e.kind === 'payout') return false;
      return RIDE_KINDS[e.kind] && !e.adj ? (e.date >= from && e.date <= to) : true;
    });
  }
  function carriedBefore(driverId, from) { return entries().filter(function (e) { return e.driverId === driverId && !e.settlementId && RIDE_KINDS[e.kind] && !e.adj && e.date < from; }); }
  function amt1(e) { return e.rev ? -e.amount : e.amount; }   // a reversal counts against its kind
  function sum(list, kind, pred) { return round2(list.reduce(function (a, e) { return (e.kind === kind && (!pred || pred(e))) ? a + amt1(e) : a; }, 0)); }
  function compute(driverId, from, to) {
    var d = findDriver(driverId); if (!d) return null;
    var w = from && to ? { from: from, to: to } : weekOf(from);
    var list = unsettledFor(d.id, w.from, w.to), carry = carriedBefore(d.id, w.from);
    var lines = {
      officeFares: sum(list, 'fare-collected-office'), tips: sum(list, 'tip'), tolls: sum(list, 'toll'),
      reimbursements: sum(list, 'reimbursement'), deductions: sum(list, 'deduction'),
      refunds: sum(list, 'refund', function (e) { return e.dr === ACCT.due; }),
      baseOwed: baseOwedFor(d.id, w.from, w.to), baseReceived: sum(list, 'base-fee-received'), baseWithheld: 0,
      driverFares: sum(list, 'fare-collected-driver'),
      adjustments: round2(list.reduce(function (a, e) { return e.adj && RIDE_KINDS[e.kind] && e.kind !== 'fare-collected-driver' ? a + amt1(e) : a; }, 0))
    };
    var paysDriver = round2(lines.officeFares + lines.tips + lines.tolls + lines.reimbursements);
    var net = round2(paysDriver - lines.deductions - lines.refunds - lines.baseOwed + lines.baseReceived);
    var tripIds = []; list.forEach(function (e) { if (e.tripId && tripIds.indexOf(e.tripId) < 0) tripIds.push(e.tripId); });
    var carryTrips = []; carry.forEach(function (e) { if (e.tripId && carryTrips.indexOf(e.tripId) < 0) carryTrips.push(e.tripId); });
    return { driverId: d.id, driverName: d.name || '', from: w.from, to: w.to, lines: lines, paysDriver: paysDriver, net: net, direction: net > 0 ? 'pay-driver' : net < 0 ? 'driver-pays' : 'even', entryIds: list.map(function (e) { return e.id; }), tripIds: tripIds, carryTrips: carryTrips, w9: hasW9(d) };
  }
  function findSettlement(driverId, from, to) { return led().settlements.filter(function (s) { return s.driverId === driverId && s.from === from && s.to === to; })[0] || null; }
  function settlementById(id) { return led().settlements.filter(function (s) { return s.id === id; })[0] || null; }
  /* A day is settled once: another run whose range overlaps an existing run for the driver is refused. */
  function overlapping(driverId, from, to) { return led().settlements.filter(function (s) { return s.driverId === driverId && !(s.from === from && s.to === to) && !(s.to < from || s.from > to); })[0] || null; }
  function settle(driverId, from, to, opts) {
    opts = opts || {};
    var d = findDriver(driverId); if (!d) { toast('Pick a driver.', true); return { ok: false, reason: 'no-driver' }; }
    var w = from && to ? { from: from, to: to } : weekOf(from);
    if (!(isDate(w.from) && isDate(w.to) && w.from <= w.to)) { toast('Pick a valid date range.', true); return { ok: false, reason: 'bad-range' }; }
    if (!opts.skipPin && !ownerPinOK('run the settlement for ' + (d.name || 'this driver'))) return { ok: false, reason: 'pin' };
    sweep(true);
    var existing = findSettlement(d.id, w.from, w.to);
    if (existing && existing.status === 'paid') { toast((d.name || 'Driver') + ' is already settled and paid for ' + w.from + ' to ' + w.to + ' (' + existing.id + ').', true); return { ok: false, reason: 'already-paid', settlement: existing }; }
    var ov = overlapping(d.id, w.from, w.to);
    if (ov) { toast(w.from + ' to ' + w.to + ' overlaps ' + ov.id + ' (' + ov.from + ' to ' + ov.to + ') for ' + (d.name || 'this driver') + ' — a day is settled once. Run or re-run that one instead.', true); return { ok: false, reason: 'overlap', settlement: ov }; }
    if (existing) {   // re-run a draft: release its lines and drop its base-fee accrual, then compute afresh
      entries().forEach(function (e) { if (e.settlementId === existing.id) e.settlementId = ''; });
      led().entries = entries().filter(function (e) { return !(e.kind === 'base-fee-owed' && e.ref === existing.id); });
      led().settlements = led().settlements.filter(function (s) { return s.id !== existing.id; });
    }
    var c = compute(d.id, w.from, w.to);
    if (c.net > 0 && !hasW9(d)) {   // only a PAYOUT needs the W-9; a driver-pays week (net < 0) runs and is receipted as usual
      toast('No W-9 on file for ' + (d.name || 'this driver') + ' — ' + money(c.net) + ' would be paid out. Add the W-9 date in Fleet first. Not added to the payout run.', true);
      save(); render();
      return { ok: false, reason: 'no-w9', computed: c };
    }
    var id = existing ? existing.id : ('S-' + w.from.replace(/-/g, '') + '-' + d.id);
    if (!existing && settlementById(id)) id += '-' + w.to.replace(/-/g, '');   // never two runs under one id
    if (c.lines.baseOwed > 0) { var bo = addEntry({ kind: 'base-fee-owed', amount: c.lines.baseOwed, driverId: d.id, date: w.to, dr: ACCT.duefrom, cr: ACCT.basefee, ref: id, memo: 'base fee ' + w.from + ' to ' + w.to, key: id + ':base-fee-owed', createdBy: opts.by || 'owner' }); if (bo.row) { bo.row.settlementId = id; bo.row.ref = id; c.entryIds.push(bo.row.id); } }
    c.entryIds.forEach(function (eid) { var e = entry(eid); if (e) e.settlementId = id; });
    var s = { id: id, driverId: d.id, driverName: d.name || '', from: w.from, to: w.to, runAt: nowISO(), runBy: opts.by || 'owner', status: 'draft', stale: false, lines: c.lines, paysDriver: c.paysDriver, net: c.net, direction: c.direction, tripIds: c.tripIds, carryTrips: c.carryTrips, entryIds: c.entryIds, paidAt: '', paidMethod: '', paidBy: '' };
    led().settlements.push(s);
    save();
    if (!opts.quiet) { toast('Settlement ' + id + ' for ' + (d.name || 'driver') + ': ' + (c.net > 0 ? 'office pays ' + money(c.net) : c.net < 0 ? 'driver pays ' + money(-c.net) : 'even') + '.' + (c.lines.adjustments ? ' Includes ' + signed(c.lines.adjustments) + ' of corrections to earlier paid runs.' : '') + (c.carryTrips.length ? ' ' + c.carryTrips.length + ' earlier ride' + (c.carryTrips.length === 1 ? '' : 's') + ' still unsettled — run that week too.' : '')); render(); }
    return { ok: true, settlement: s };
  }
  function markPaid(settlementId, method, dateStr, opts) {
    opts = opts || {};
    var s = settlementById(settlementId); if (!s) { toast('Settlement not found.', true); return false; }
    if (s.status === 'paid') { toast(s.id + ' is already marked paid.', true); return false; }
    /* belt and braces: ride money for this driver dated inside the run that no run holds, or a base fee that moved
       (driver fee edited, ride added or removed) means the draft is out of date */
    if (!s.stale) {
      sweep(true);
      var AFTER_KINDS = { 'base-fee-received': 1, 'reimbursement': 1, 'deduction': 1 };
      var loose = unsettledFor(s.driverId, s.from, s.to).filter(function (e) { return (RIDE_KINDS[e.kind] && !e.adj) || (AFTER_KINDS[e.kind] && e.date <= (isDate(dateStr) ? dateStr : todayStr())); });
      if (loose.length) markStale(s, loose.length + ' line' + (loose.length === 1 ? '' : 's') + ' (' + loose.slice(0, 3).map(function (e) { return e.ref; }).join(', ') + ') recorded after the run — run again');
      else if (round2(baseOwedFor(s.driverId, s.from, s.to)) !== round2(s.lines.baseOwed)) markStale(s, 'base fee changed ' + money(s.lines.baseOwed) + ' → ' + money(baseOwedFor(s.driverId, s.from, s.to)));
      if (s.stale) save();
    }
    if (s.stale) { toast(s.id + ' changed since it was run (' + (s.staleReason || 'a ride was corrected') + ') — run it again before marking it paid.', true); if (!opts.quiet) render(); return false; }
    if (!opts.skipPin && !ownerPinOK('mark ' + s.id + ' paid')) return false;
    if (s.net > 0 && !hasW9(s.driverId)) { toast('No W-9 on file for ' + s.driverName + ' — cannot pay out. Add the W-9 date in Fleet first.', true); return false; }
    method = String(method || (s.net > 0 ? 'ach' : 'cash')).toLowerCase(); dateStr = isDate(dateStr) ? dateStr : todayStr();
    if (s.net > 0) {
      var r = addEntry({ kind: 'payout', sub: 'driver', amount: s.net, driverId: s.driverId, date: dateStr, method: method, dr: ACCT.due, cr: cashAcct(method), ref: s.id, memo: 'driver payout ' + s.from + ' to ' + s.to, key: s.id + ':payout', createdBy: opts.by || 'owner' });
      if (r.row) { r.row.settlementId = s.id; s.entryIds.push(r.row.id); }
    } else if (s.net < 0) {
      var rec = cashReceipt(s.driverId, -s.net, method, 'Settlement ' + s.id + ' (' + s.from + ' to ' + s.to + ')', { settlementId: s.id, quiet: true, date: dateStr, by: opts.by || 'owner' });
      if (rec) { s.receiptNo = rec.no; s.entryIds.push(rec.entryId); }
    }
    /* Base fee kept out of the money the office held for the driver: that part of the fee is received now, not still owed. */
    var L = s.lines, stillOwed = round2(L.baseOwed - L.baseReceived), offset = round2(s.paysDriver - L.deductions - L.refunds);
    var withheld = round2(Math.max(0, Math.min(stillOwed, offset)));
    if (withheld > 0) {
      var wr = addEntry({ kind: 'base-fee-received', amount: withheld, driverId: s.driverId, date: dateStr, method: 'withheld', dr: ACCT.due, cr: ACCT.duefrom, ref: s.id, memo: 'base fee withheld from payout ' + s.from + ' to ' + s.to, key: s.id + ':withheld', createdBy: opts.by || 'owner' });
      if (wr.row) { wr.row.settlementId = s.id; s.entryIds.push(wr.row.id); }
    }
    L.baseWithheld = withheld;
    s.status = 'paid'; s.paidAt = nowISO(); s.paidDate = dateStr; s.paidMethod = method; s.paidBy = opts.by || 'owner';
    save();
    if (!opts.quiet) { toast(s.id + ' marked paid (' + method + ', ' + dateStr + ').' + (withheld ? ' Base fee ' + money(withheld) + ' withheld from the payout.' : '')); render(); }
    return true;
  }
  function statementHTML(s) {
    var L = s.lines, rows = '';
    function row(l, v, b) { return '<tr><td style="padding:3px 8px;' + (b ? 'font-weight:700;' : '') + '">' + l + '</td><td style="padding:3px 8px;text-align:right;' + (b ? 'font-weight:700;' : '') + '">' + v + '</td></tr>'; }
    rows += row('Fares collected by the office for you (card + account)', money(L.officeFares));
    rows += row('Tips collected by the office', money(L.tips));
    rows += row('Tolls collected by the office', money(L.tolls));
    rows += row('Reimbursements', money(L.reimbursements));
    rows += row('Deductions (authorised)', '-' + money(L.deductions));
    rows += row('Refunds to passengers', '-' + money(L.refunds));
    rows += row('Base fee owed ' + esc(s.from) + ' to ' + esc(s.to), '-' + money(L.baseOwed));
    rows += row('Base fee already received (receipts)', '+' + money(L.baseReceived));
    rows += row(s.net > 0 ? 'NET — office pays driver' : s.net < 0 ? 'NET — driver pays base' : 'NET — even', money(Math.abs(s.net)), 1);
    if (L.baseWithheld) rows += row('<span style="color:#555;">of which base fee withheld from the payout</span>', '<span style="color:#555;">' + money(L.baseWithheld) + '</span>');
    if (L.adjustments) rows += row('<span style="color:#555;">includes corrections to rides from earlier paid runs</span>', '<span style="color:#555;">' + signed(L.adjustments) + '</span>');
    var tripRows = (s.tripIds || []).map(function (id) { var t = findTrip(id); if (!t) return ''; var how = isAccountTrip(t) ? 'account' : isCard(t) ? 'card' : 'cash'; return '<tr><td>' + esc(tripRef(t)) + '</td><td>' + esc(fmtDate(t.date)) + '</td><td>' + esc(String(t.puAddr || '').split(',')[0]) + ' → ' + esc(String(t.doAddr || '').split(',')[0]) + '</td><td>' + esc(t.status) + '</td><td>' + how + '</td><td style="text-align:right;">' + esc(money(t.fare)) + '</td></tr>'; }).join('');
    var recs = led().receipts.filter(function (r) { return r.driverId === s.driverId && (r.settlementId === s.id || (s.entryIds || []).indexOf(r.entryId) >= 0); }).map(function (r) { return receiptNo(r.no) + ' ' + money(r.amount) + ' (' + r.date + ')'; }).join(', ');
    var sset = settings();
    return '<div style="max-width:720px;margin:0 auto;font-family:Arial,sans-serif;font-size:13px;">'
      + '<div style="text-align:center;"><h2 style="margin:4px 0;">' + esc(sset.name || bizName()) + '</h2><div>Driver settlement statement</div><hr></div>'
      + '<div><b>' + esc(s.driverName || driverName(s.driverId)) + '</b> · week ' + esc(fmtDate(s.from)) + ' – ' + esc(fmtDate(s.to)) + ' · ' + esc(s.id) + ' · ' + (s.status === 'paid' ? 'PAID ' + esc(s.paidDate || dateOf(s.paidAt)) + ' by ' + esc(s.paidMethod) : 'DRAFT') + '</div>'
      + '<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:14px;">' + rows + '</table>'
      + (L.driverFares ? '<div class="hint" style="margin:6px 0;color:#555;">Cash fares you collected yourself this period: ' + esc(money(L.driverFares)) + ' (not part of the net).</div>' : '')
      + (recs ? '<div style="margin:6px 0;">Receipts: ' + esc(recs) + '</div>' : '')
      + (tripRows ? '<h4 style="margin:10px 0 4px;">Rides</h4><table class="data" style="width:100%;border-collapse:collapse;"><thead><tr><th>#</th><th>Date</th><th>Route</th><th>Status</th><th>Paid by</th><th style="text-align:right;">Fare</th></tr></thead><tbody>' + tripRows + '</tbody></table>' : '')
      + '<div style="display:flex;justify-content:space-between;gap:24px;margin-top:28px;"><div style="flex:1;border-top:1px solid #333;padding-top:4px;">Office (signed)</div><div style="flex:1;border-top:1px solid #333;padding-top:4px;">Driver (signed)</div></div></div>';
  }
  function printStatement(settlementId) { var s = settlementById(settlementId); if (!s) { toast('Settlement not found.', true); return false; } return openPrint(statementHTML(s)); }

  /* ---------- refund (owner PIN) ---------- */
  function officeEntriesFor(t) { return entries().filter(function (e) { return e.tripId === t.id && !e.rev && !e.reversedBy && ['fare-collected-office', 'tip', 'toll', 'card-fee-recovered'].indexOf(e.kind) >= 0; }); }
  function refundedSoFar(t) { return round2(refundRows(t).reduce(function (a, e) { return a + e.amount; }, 0)); }
  /* One refund = one row per collected line it gives back (refundId shared, refundOf = the line reversed):
     the driver's share (fare, tip, toll) as kind 'refund' Due to drivers → Square clearing, so the driver's
     settlement drops by exactly what was collected for them; the office's card fee as a reversal of the
     card-fee-recovered line (Card fee recovery → Square clearing), so card-fee income and the P&L cash figure
     drop by the fee. A partial refund comes out of the driver's share first, the card fee last.
     Returns a summary row: the fare row's fields with amount = the total refunded now, plus rows[] (the lines). */
  var REFUND_ORDER = { 'fare-collected-office': 0, tip: 1, toll: 2, 'card-fee-recovered': 3 };
  function refund(tripId, amount, reason, opts) {
    opts = opts || {};
    var t = typeof tripId === 'string' && !findTrip(tripId) ? tripByNo(tripId) : findTrip(tripId);
    if (!t) { toast('Trip not found.', true); return null; }
    sweep(true);
    var coll = officeEntriesFor(t), collected = round2(coll.reduce(function (a, e) { return a + e.amount; }, 0));
    if (!coll.length || !(collected > 0)) { toast(tripRef(t) + ' has no payment collected by the office — nothing to refund.', true); return null; }
    var done = refundRows(t), already = round2(done.reduce(function (a, e) { return a + e.amount; }, 0)), left = round2(collected - already);
    amount = amount == null || amount === '' ? left : round2(amount);
    if (!(amount > 0)) { toast('Enter the refund amount.', true); return null; }
    if (amount > left + 0.005) { toast('Only ' + money(left) + ' is left to refund on ' + tripRef(t) + '.', true); return null; }
    reason = String(reason || '').trim(); if (!reason) { toast('A refund needs a reason.', true); return null; }
    if (!opts.skipPin && !ownerPinOK('refund ' + money(amount) + ' on ' + tripRef(t))) return null;
    var fareE = coll.filter(function (e) { return e.kind === 'fare-collected-office'; })[0] || coll[0];
    var usedBy = {}; done.forEach(function (e) { var k = e.refundOf || fareE.id; usedBy[k] = round2((usedBy[k] || 0) + e.amount); });   // older rows without refundOf came out of the fare
    var lines = coll.slice().sort(function (a, b) { return (REFUND_ORDER[a.kind] || 0) - (REFUND_ORDER[b.kind] || 0); });
    var rid = uid(), todo = amount, rows = [], driverShare = 0, feeShare = 0, by = opts.by || 'owner';
    lines.forEach(function (e) {
      if (todo <= 0.004) return;
      var room = round2(e.amount - (usedBy[e.id] || 0)); if (!(room > 0)) return;
      var part = round2(Math.min(room, todo)); todo = round2(todo - part);
      var isFee = e.kind === 'card-fee-recovered';
      var r = addEntry({ kind: isFee ? 'card-fee-recovered' : 'refund', sub: isFee ? 'refund' : (e.kind === 'fare-collected-office' ? (e.sub || '') : e.kind), amount: part, tripId: t.id, driverId: isFee || e.cr === ACCT.held ? '' : (e.driverId || t.driverId || ''), accountId: t.accountId || '', date: todayStr(), method: e.method, dr: e.cr, cr: e.dr, ref: tripRef(t), memo: reason + (isFee ? ' — card fee returned to the passenger' : ''), createdBy: by });
      if (!r.row) return;
      r.row.refundId = rid; r.row.refundOf = e.id;
      if (isFee) { r.row.rev = true; r.row.reverses = e.id; feeShare = round2(feeShare + part); } else driverShare = round2(driverShare + part);
      rows.push(r.row);
    });
    if (!rows.length) { toast('Nothing left to refund on ' + tripRef(t) + '.', true); return null; }
    var total = round2(rows.reduce(function (a, e) { return a + e.amount; }, 0)), primary = rows[0];
    var full = round2(already + total) >= collected - 0.005;
    t.refund = { amount: round2(already + total), last: total, reason: reason, at: nowISO(), by: by, entryId: primary.id, entryIds: rows.map(function (e) { return e.id; }), refundId: rid, full: full };
    t.payment = Object.assign({}, t.payment || {}, { refundedCents: Math.round(round2(already + total) * 100), refundReason: reason, refundedAt: nowISO(), status: full ? 'refunded' : (t.payment && t.payment.status) || 'paid' });
    led().squarePayments.forEach(function (p) { if (p.type === 'refund' && !p.consoleRefund) matchSquareRefund(p); });   // a Square refund row imported earlier now has its console refund
    save();
    if (!opts.quiet) { toast('Refund ' + money(total) + ' on ' + tripRef(t) + ' recorded' + (full ? ' (fully refunded)' : '') + (feeShare ? ' — ' + money(driverShare) + ' off the driver, ' + money(feeShare) + ' card fee returned' : '') + '.'); render(); }
    try {   // optional cloud hook: ask Square for the real refund when the hold/charge lives there; local books are already written
      var c = window.Cloud; if (c && typeof c.enabled === 'function' && c.enabled() && typeof c.fn === 'function' && t.payment && t.payment.paymentId) {
        var loc = ''; try { loc = String((c.get() || {}).locationId || ''); } catch (e) {}
        c.fn('square-charge', { action: 'refund', location_id: loc, trip_id: String(t.id), amount_cents: Math.round(total * 100), reason: reason }).then(function (res) { if (res && res.refund_id) { t.refund.squareRefundId = res.refund_id; save(); } }).catch(function (err) { toast('Square refund did not go through (' + ((err && err.message) || err) + ') — refund it in the Square Dashboard; the books already show it.', true); });
      }
    } catch (e) {}
    return Object.assign({}, primary, { amount: total, rows: rows, refundId: rid, driverShare: driverShare, feeShare: feeShare });
  }

  /* ---------- invoices: mark paid ---------- */
  function invoicePaid(no, method, dateStr, opts) {
    opts = opts || {};
    var inv = invoices().filter(function (i) { return String(i.no) === String(no); })[0];
    if (!inv) { toast('Invoice #' + no + ' not found.', true); return null; }
    if (inv.status === 'paid') { toast('Invoice #' + no + ' is already paid.', true); return null; }
    try { ensureInvoiceLines(); } catch (e) {}   // the CCU receivable, if the open-invoice click did not write it
    method = String(method || 'bank').toLowerCase(); dateStr = isDate(dateStr) ? dateStr : todayStr();
    var amt = round2(inv.total); if (!(amt > 0)) amt = round2((inv.tripIds || []).reduce(function (a, id) { var t = findTrip(id); return t ? a + num(t.fare) + num(t.tolls) : a; }, 0));
    var r = addEntry({ kind: 'invoice-paid', amount: amt, accountId: inv.accountId || '', date: dateStr, method: method, dr: cashAcct(method), cr: ACCT.ar, ref: 'INV-' + inv.no, memo: 'invoice #' + inv.no + ' paid by ' + (inv.account || ''), key: 'invoice:' + inv.no + ':paid', createdBy: opts.by || who() });
    inv.status = 'paid'; inv.paidAt = nowISO(); inv.paidDate = dateStr; inv.paidMethod = method;
    (inv.tripIds || []).forEach(function (id) { var t = findTrip(id); if (t) { t.payment = Object.assign({}, t.payment || {}, { status: 'paid', method: 'invoice', invoiceNo: inv.no, at: nowISO() }); } });
    save();
    if (!opts.quiet) { toast('Invoice #' + inv.no + ' marked paid — ' + money(amt) + ' by ' + method + '.'); render(); }
    return r.row;
  }

  /* ---------- Square CSV import (Transactions / Payouts exports) ---------- */
  function parseCSV(text) {
    var rows = [], row = [], cell = '', q = false, s = String(text || '').replace(/^﻿/, '');
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); if (row.length > 1 || row[0] !== '') rows.push(row); }
    return rows;
  }
  function norm(h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function amt(v) { var s = String(v == null ? '' : v).trim(); if (!s) return 0; var neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[$,\s]/g, '')); var n = Number(s.replace(/[^0-9.]/g, '')); if (!isFinite(n)) return 0; return round2(neg ? -n : n); }
  function isoDate(v) {
    var s = String(v || '').trim(); if (!s) return '';
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) { var y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + pad2(m[1]) + '-' + pad2(m[2]); }
    var d = new Date(s); return isNaN(d) ? '' : dateOf(d.toISOString());
  }
  function detectKind(header) {
    var h = header.map(norm);
    var has = function (re) { return h.some(function (c) { return re.test(c); }); };
    if (has(/^(payoutid|transferid)$/) || (has(/^depositid$/) && !has(/^(transactionid|paymentid)$/))) return 'payouts';
    if (has(/^(transactionid|paymentid)$/)) return 'transactions';
    return '';
  }
  function colIndex(header, names) { var h = header.map(norm); for (var i = 0; i < names.length; i++) { var j = h.indexOf(norm(names[i])); if (j >= 0) return j; } return -1; }
  function matchTripForPayment(p) {
    var refTxt = [p.ref, p.description, p.details].join(' ');
    var m = refTxt.match(/#\s*(\d{1,7})\b/);
    var t = null;
    if (m) { t = tripByNo(m[1]); if (t && !isCard(t)) t = null; }
    if (!t && p.amount > 0) {
      var cands = trips().filter(function (x) { return isCard(x) && x.date === p.date && !(x.payment && x.payment.squarePaymentId) && Math.abs(officeTotal(x) - p.amount) < 0.011 && (x.status === 'Completed' || x.status === 'No-Show'); });
      if (cands.length === 1) t = cands[0];
    }
    return t;
  }
  /* Console refunds as events: every row of one refund shares refundId; the event total is what the passenger got back. */
  function refundEvents() {
    var ev = {}, order = [];
    entries().forEach(function (e) { if (!isRefundRow(e)) return; var id = e.refundId || e.id; if (!ev[id]) { ev[id] = { id: id, tripId: e.tripId || '', date: e.date, amount: 0, entryId: e.id }; order.push(id); } ev[id].amount = round2(ev[id].amount + e.amount); });
    return order.map(function (id) { return ev[id]; });
  }
  /* A Square refund row is matched to the console refund it mirrors: by "#dispatchNo" in its text, or by the
     same total within 7 days of a refund nobody has claimed yet. Sets p.tripId and p.consoleRefund (the refund id). */
  function matchSquareRefund(p) {
    if (!p || p.type !== 'refund' || p.consoleRefund) return false;
    var want = round2(Math.abs(p.amount)); if (!(want > 0)) return false;
    var taken = {}; led().squarePayments.forEach(function (x) { if (x.consoleRefund) taken[x.consoleRefund] = true; });
    var refunds = refundEvents().filter(function (e) { return !taken[e.id]; });
    var m = [p.ref, p.description, p.details].join(' ').match(/#\s*(\d{1,7})\b/), t = m ? tripByNo(m[1]) : null, hit = null;
    if (t) hit = refunds.filter(function (e) { return e.tripId === t.id && Math.abs(e.amount - want) < 0.011; })[0] || null;   // same trip, same total (a different amount stays unmatched on purpose)
    if (!hit && !t) { var c = refunds.filter(function (e) { return Math.abs(e.amount - want) < 0.011 && Math.abs(dayDiff(e.date, p.date)) <= 7; }); if (c.length === 1) hit = c[0]; }
    if (!hit) return false;
    p.consoleRefund = hit.id; p.tripId = hit.tripId || (t ? t.id : '');
    var tr = p.tripId ? findTrip(p.tripId) : null; if (tr && tr.refund && !tr.refund.squareRefundId) tr.refund.squareRefundId = p.id;
    return true;
  }
  /* Text as the file holds it, whether it came through a file reader or a textarea (which drops BOM and CR) */
  function normText(s) { return String(s == null ? '' : s).replace(/^﻿/, '').replace(/\r/g, ''); }
  function importSquare(text, fileName, opts) {
    opts = opts || {};
    var L = led(), rows = parseCSV(text);
    if (rows.length < 2) { toast('That file has no data rows.', true); return { ok: false, reason: 'empty' }; }
    var header = rows[0], kind = detectKind(header);
    if (!kind) { toast('Not a Square Transactions or Payouts export (no Transaction ID / Payout ID column).', true); return { ok: false, reason: 'unknown-header' }; }
    var hash = hashStr(normText(text)), prior = L.imports.filter(function (i) { return i.hash === hash; })[0];
    var res = { ok: true, kind: kind, rows: rows.length - 1, added: 0, skipped: 0, updated: 0, matched: 0, entries: 0, repeat: !!prior };
    if (kind === 'transactions') {
      var cId = colIndex(header, ['Payment ID', 'Transaction ID']), cTx = colIndex(header, ['Transaction ID']), cDate = colIndex(header, ['Date']), cTot = colIndex(header, ['Total Collected', 'Net Total', 'Gross Sales']),
        cFee = colIndex(header, ['Fees', 'Fee']), cNet = colIndex(header, ['Net Total']), cTip = colIndex(header, ['Tip']), cDep = colIndex(header, ['Deposit ID', 'Payout ID', 'Transfer ID']), cRef = colIndex(header, ['Customer Reference ID', 'Order Reference ID', 'Reference ID']),
        cDesc = colIndex(header, ['Description']), cDet = colIndex(header, ['Details']), cEv = colIndex(header, ['Event Type']), cStat = colIndex(header, ['Transaction Status', 'Status']), cCard = colIndex(header, ['Card Brand']), cPan = colIndex(header, ['PAN Suffix']);
      for (var i = 1; i < rows.length; i++) {
        var r = rows[i]; if (!r || r.length < 2) continue;
        var id = String((cId >= 0 ? r[cId] : '') || (cTx >= 0 ? r[cTx] : '') || '').trim(); if (!id) { res.skipped++; continue; }
        var known = L.squarePayments.filter(function (p) { return p.id === id; })[0];
        if (known) {   // seen before: the books do not move, but a Deposit ID Square filled since is kept
          res.skipped++;
          var dep = cDep >= 0 ? String(r[cDep] || '').trim() : '';
          if (dep && !known.payoutId) {
            known.payoutId = dep; res.updated++;
            var kt = known.tripId ? findTrip(known.tripId) : null;
            if (kt && kt.payment && !kt.payment.payoutId) kt.payment = Object.assign({}, kt.payment, { payoutId: dep });
          }
          continue;
        }
        var ev = String(cEv >= 0 ? r[cEv] : 'Payment').trim() || 'Payment';
        var p = { id: id, txId: cTx >= 0 ? String(r[cTx] || '').trim() : '', date: isoDate(cDate >= 0 ? r[cDate] : ''), amount: amt(cTot >= 0 ? r[cTot] : 0), fee: Math.abs(amt(cFee >= 0 ? r[cFee] : 0)), net: amt(cNet >= 0 ? r[cNet] : 0), tip: amt(cTip >= 0 ? r[cTip] : 0),
          payoutId: cDep >= 0 ? String(r[cDep] || '').trim() : '', ref: cRef >= 0 ? String(r[cRef] || '').trim() : '', description: cDesc >= 0 ? String(r[cDesc] || '').trim() : '', details: cDet >= 0 ? String(r[cDet] || '').trim() : '',
          type: /refund/i.test(ev) ? 'refund' : 'payment', status: cStat >= 0 ? String(r[cStat] || '').trim() : '', card: (cCard >= 0 ? String(r[cCard] || '') : '') + (cPan >= 0 && r[cPan] ? ' ' + String(r[cPan]) : ''), tripId: '', importedAt: nowISO() };
        if (!p.date) p.date = todayStr();
        if (p.type === 'refund') { p.consoleRefund = ''; matchSquareRefund(p); if (p.consoleRefund) res.refundsMatched = (res.refundsMatched || 0) + 1; }
        if (p.type === 'payment') {
          var t = matchTripForPayment(p);
          if (t) {
            p.tripId = t.id; res.matched++;
            var patch = { squarePaymentId: id, feeCents: Math.round(p.fee * 100) };
            if (p.payoutId) patch.payoutId = p.payoutId;
            var st = t.payment && t.payment.status;
            if (t.status === 'Completed' && (!st || st === 'pending-vt' || st === 'link-sent')) { patch.status = 'paid'; patch.method = 'card'; patch.via = 'square-import'; patch.at = nowISO(); }
            t.payment = Object.assign({}, t.payment || {}, patch);
          }
          if (p.fee > 0) { var fe = addEntry({ kind: 'square-fee', amount: p.fee, tripId: p.tripId, driverId: t ? (t.driverId || '') : '', date: p.date, method: 'card', dr: ACCT.sqfees, cr: ACCT.square, ref: id, memo: 'Square fee' + (t ? ' ' + tripRef(t) : ''), key: 'sq:' + id + ':fee', createdBy: 'square-import' }); if (fe.added) res.entries++; }
        }
        L.squarePayments.push(p); res.added++;
      }
    } else {
      var pId = colIndex(header, ['Payout ID', 'Transfer ID', 'Deposit ID']), pDate = colIndex(header, ['Payout Date', 'Transfer Date', 'Deposit Date', 'Date', 'Arrival Date']), pAmt = colIndex(header, ['Amount', 'Payout Amount', 'Net Total', 'Total']),
        pFee = colIndex(header, ['Fees', 'Fee']), pStat = colIndex(header, ['Status']), pType = colIndex(header, ['Payout Type', 'Transfer Type', 'Type']), pBank = colIndex(header, ['Bank Account', 'Destination']);
      for (var k = 1; k < rows.length; k++) {
        var rr = rows[k]; if (!rr || rr.length < 2) continue;
        var pid = String(pId >= 0 ? rr[pId] : '').trim(); if (!pid) { res.skipped++; continue; }
        if (L.payouts.some(function (x) { return x.id === pid; })) { res.skipped++; continue; }
        var po = { id: pid, date: isoDate(pDate >= 0 ? rr[pDate] : '') || todayStr(), amount: amt(pAmt >= 0 ? rr[pAmt] : 0), fees: Math.abs(amt(pFee >= 0 ? rr[pFee] : 0)), status: pStat >= 0 ? String(rr[pStat] || '').trim() : '', type: pType >= 0 ? String(rr[pType] || '').trim() : '', bankAcct: pBank >= 0 ? String(rr[pBank] || '').trim() : '', bankId: '', importedAt: nowISO() };
        if (po.amount < 0) { po.amount = Math.abs(po.amount); po.type = po.type || 'withdrawal'; }
        if (po.amount > 0) { var pe = addEntry({ kind: 'payout', sub: 'square', amount: po.amount, date: po.date, method: 'bank', dr: ACCT.bank, cr: ACCT.square, ref: pid, memo: 'Square payout to bank', key: 'sqpayout:' + pid, createdBy: 'square-import' }); if (pe.added) res.entries++; }
        L.payouts.push(po); res.added++;
        autoMatchPayout(po);
      }
    }
    if (prior) { prior.times = (prior.times || 1) + 1; prior.lastAt = nowISO(); prior.lastAdded = res.added; }
    else L.imports.push({ id: uid(), at: nowISO(), kind: kind, fileName: fileName || '', rows: res.rows, added: res.added, skipped: res.skipped, updated: res.updated, matched: res.matched, hash: hash, times: 1 });
    save();
    if (!opts.quiet) { toast('Square ' + kind + ': ' + res.added + ' new, ' + res.skipped + ' already known' + (res.updated ? ' (' + res.updated + ' got a payout id)' : '') + (kind === 'transactions' ? ', ' + res.matched + ' matched to rides' + (res.refundsMatched ? ', ' + res.refundsMatched + ' refund' + (res.refundsMatched === 1 ? '' : 's') + ' matched' : '') : '') + (prior ? ' — this file was imported before; nothing changed.' : '.')); render(); }
    return res;
  }

  /* ---------- bank credits (typed by hand) and payout matching ---------- */
  function payoutById(id) { return led().payouts.filter(function (p) { return p.id === id; })[0] || null; }
  function bankById(id) { return led().bank.filter(function (b) { return b.id === id; })[0] || null; }
  function autoMatchPayout(po) {
    if (!po || po.bankId) return false;
    var c = led().bank.filter(function (b) { return !b.payoutId && Math.abs(b.amount - po.amount) < 0.005 && Math.abs(dayDiff(b.date, po.date)) <= 3; });
    if (c.length === 1) { c[0].payoutId = po.id; po.bankId = c[0].id; return true; }
    return false;
  }
  function addBankCredit(dateStr, amount, memo) {
    amount = round2(amount); if (!(amount > 0)) { toast('Enter the amount that landed in the bank.', true); return null; }
    dateStr = isDate(dateStr) ? dateStr : todayStr();
    var b = { id: uid(), at: nowISO(), date: dateStr, amount: amount, memo: String(memo || '').trim(), payoutId: '' };
    led().bank.push(b);
    var c = led().payouts.filter(function (p) { return !p.bankId && Math.abs(p.amount - amount) < 0.005 && Math.abs(dayDiff(p.date, dateStr)) <= 3; });
    if (c.length === 1) { c[0].bankId = b.id; b.payoutId = c[0].id; }
    save(); toast('Bank credit ' + money(amount) + ' on ' + dateStr + (b.payoutId ? ' matched to Square payout ' + b.payoutId : ' recorded (no payout matched yet)') + '.'); render();
    return b;
  }
  function matchPayout(payoutId, bankId) {
    var po = payoutById(payoutId), b = bankId ? bankById(bankId) : null;
    if (!po) return false;
    if (po.bankId) { var old = bankById(po.bankId); if (old) old.payoutId = ''; po.bankId = ''; }
    if (b) { if (b.payoutId) { var op = payoutById(b.payoutId); if (op) op.bankId = ''; } b.payoutId = po.id; po.bankId = b.id; }
    save(); render(); return true;
  }

  /* ---------- weekly reconciliation ---------- */
  function reconcile(dateStr) {
    sweep(true);
    var w = weekOf(dateStr), L = led();
    var inW = function (d) { return d >= w.from && d <= w.to; };
    var payouts = L.payouts.filter(function (p) { return inW(p.date); });
    var bank = L.bank.filter(function (b) { return inW(b.date); });
    /* Base fees for the week: a run's own figure once it exists, else the formula; received = receipts and withheld
       amounts that belong to this week's runs, plus receipts not yet in any run dated this week. */
    var weekRuns = {}; L.settlements.forEach(function (s) { if (s.from === w.from) weekRuns[s.id] = s; });
    var cashOwed = round2(drivers().reduce(function (a, d) { var s = L.settlements.filter(function (x) { return x.driverId === d.id && x.from === w.from; })[0]; return a + (s ? num(s.lines.baseOwed) : baseOwedFor(d.id, w.from, w.to)); }, 0));
    var recLines = entries().filter(function (e) { return e.kind === 'base-fee-received' && (e.settlementId ? !!weekRuns[e.settlementId] : inW(e.date)); });
    var withheld = round2(recLines.reduce(function (a, e) { return e.method === 'withheld' ? a + e.amount : a; }, 0));
    var receiptedCash = round2(recLines.reduce(function (a, e) { return e.method === 'withheld' ? a : a + e.amount; }, 0));
    var receipted = round2(withheld + receiptedCash);
    var cardPaid = trips().filter(function (t) { return isCard(t) && t.payment && (t.payment.status === 'paid' || t.payment.status === 'noshow-fee') && inW(t.date); });
    var unseen = cardPaid.filter(function (t) { return !t.payment.squarePaymentId; });
    var sqUnmatched = L.squarePayments.filter(function (p) { return p.type === 'payment' && !p.tripId && inW(p.date); });
    L.squarePayments.forEach(function (p) { if (p.type === 'refund' && !p.consoleRefund) matchSquareRefund(p); });
    var sqRefunds = L.squarePayments.filter(function (p) { return p.type === 'refund' && inW(p.date); });
    var sqRefundsUnmatched = sqRefunds.filter(function (p) { return !p.consoleRefund; });
    var sqCollected = round2(L.squarePayments.reduce(function (a, p) { return p.type === 'payment' && inW(p.date) ? a + p.amount : a; }, 0));
    var sqFees = round2(L.squarePayments.reduce(function (a, p) { return p.type === 'payment' && inW(p.date) ? a + p.fee : a; }, 0));
    var consoleCard = round2(cardPaid.reduce(function (a, t) { return a + (t.status === 'No-Show' ? round2(t.payment.amount) : officeTotal(t)); }, 0));
    var drafts = L.settlements.filter(function (s) { return s.status !== 'paid' && s.from === w.from; });
    var stale = L.settlements.filter(function (s) { return s.status !== 'paid' && s.stale; });
    /* money the office holds with nobody to pay: card collected on rides that were canceled (held for the passenger) or with no driver */
    var held = entries().filter(function (e) { return e.kind === 'fare-collected-office' && e.sub === 'held' && !e.rev && !e.reversedBy && e.cr === ACCT.held && (inW(e.date) || inW(e.at.slice(0, 10))); });
    var heldTotal = round2(held.reduce(function (a, e) { return a + e.amount; }, 0) - held.reduce(function (a, e) { var t = findTrip(e.tripId); return a + (t ? refundedSoFar(t) : 0); }, 0));
    var unassigned = entries().filter(function (e) { return RIDE_KINDS[e.kind] && e.kind !== 'fare-collected-driver' && e.kind !== 'card-fee-recovered' && e.cr === ACCT.due && !e.driverId && !e.rev && !e.reversedBy && !e.settlementId && inW(e.date); });
    /* rides whose journal lines were corrected after they were written (trip in this week, or corrected this week) */
    var changed = [];
    L.voided.forEach(function (v) { if (!RIDE_KINDS[v.kind]) return; var t = findTrip(v.tripId); if ((t && inW(t.date)) || inW(v.date) || inW(String(v.voidedAt || '').slice(0, 10))) changed.push({ tripId: v.tripId, ref: v.ref, what: v.voidReason, how: 'voided', at: v.voidedAt, settlementId: v.settlementId || '' }); });
    entries().forEach(function (e) { if (!e.rev || e.refundId) return; var t = findTrip(e.tripId); if ((t && inW(t.date)) || inW(e.date)) changed.push({ tripId: e.tripId, ref: e.ref, what: e.memo, how: 'reversed', at: e.at, settlementId: (entry(e.reverses) || {}).settlementId || '', settledIn: e.settlementId || '' }); });
    return {
      from: w.from, to: w.to,
      payouts: payouts, payoutTotal: round2(payouts.reduce(function (a, p) { return a + p.amount; }, 0)),
      payoutsMatched: payouts.filter(function (p) { return p.bankId; }), payoutsUnmatched: payouts.filter(function (p) { return !p.bankId; }),
      bank: bank, bankTotal: round2(bank.reduce(function (a, b) { return a + b.amount; }, 0)), bankUnmatched: bank.filter(function (b) { return !b.payoutId; }),
      cashOwed: cashOwed, receipted: receipted, receiptedCash: receiptedCash, withheld: withheld, cashGap: round2(cashOwed - receipted),
      squareCollected: sqCollected, squareFees: sqFees, consoleCard: consoleCard, cardUnseenInSquare: unseen, squareUnmatched: sqUnmatched, squareRefunds: sqRefunds, squareRefundsUnmatched: sqRefundsUnmatched,
      openSettlements: drafts, staleSettlements: stale, changedAfterJournal: changed, heldForPassengers: held, heldTotal: heldTotal, unassignedCollected: unassigned,
      unmatchedCount: payouts.filter(function (p) { return !p.bankId; }).length + bank.filter(function (b) { return !b.payoutId; }).length + unseen.length + sqUnmatched.length + sqRefundsUnmatched.length + stale.length + held.length + unassigned.length
    };
  }

  /* ---------- journal export (two lines per entry, balanced by construction) ---------- */
  function journalRows(from, to) {
    var list = entries().filter(function (e) { return (!from || e.date >= from) && (!to || e.date <= to); }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.at < b.at ? -1 : 1; });
    var rows = [], debits = 0, credits = 0;
    list.forEach(function (e) {
      var t = e.tripId ? findTrip(e.tripId) : null, memo = (e.memo || '') + (e.settlementId ? ' [' + e.settlementId + ']' : '');
      var common = { date: e.date, id: e.id, kind: e.kind + (e.sub ? '/' + e.sub : '') + (e.refundId ? (e.kind === 'refund' ? '' : ' (refund)') : e.rev ? ' (reversal)' : e.adj ? ' (adjustment)' : ''), memo: memo, trip: t ? tripRef(t) : (e.tripId ? e.tripId : ''), driver: e.driverId ? driverName(e.driverId) : '', ref: e.ref || '', settlement: e.settlementId || '' };
      rows.push(Object.assign({ account: e.dr, debit: e.amount, credit: 0 }, common));
      rows.push(Object.assign({ account: e.cr, debit: 0, credit: e.amount }, common));
      debits += e.amount; credits += e.amount;
    });
    return { rows: rows, debits: round2(debits), credits: round2(credits), balanced: round2(debits) === round2(credits), count: list.length };
  }
  function journalCSV(from, to) {
    var j = journalRows(from, to), lines = ['Date,Entry,Kind,Account,Debit,Credit,Memo,Trip,Driver,Ref,Settlement'];
    j.rows.forEach(function (r) { lines.push([r.date, r.id, r.kind, r.account, r.debit ? r.debit.toFixed(2) : '', r.credit ? r.credit.toFixed(2) : '', r.memo, r.trip, r.driver, r.ref, r.settlement].map(csvCell).join(',')); });
    lines.push(['TOTAL', '', '', '', j.debits.toFixed(2), j.credits.toFixed(2), j.balanced ? 'balanced' : 'OUT OF BALANCE', '', '', '', ''].map(csvCell).join(','));
    return lines.join('\r\n') + '\r\n';
  }
  function exportJournal(from, to) {
    from = isDate(from) ? from : ''; to = isDate(to) ? to : '';
    var csv = journalCSV(from, to);
    download('skyway-journal-' + (from || 'all') + '_' + (to || 'all') + '.csv', csv, 'text/csv');
    toast('Journal CSV downloaded (' + journalRows(from, to).count + ' entries, debits = credits).');
    return csv;
  }

  /* ---------- 1099-NEC candidates ---------- */
  function paidViaSquare(driverId, year) {
    year = String(year || todayStr().slice(0, 4));
    return round2(entries().reduce(function (a, e) {
      if (e.driverId !== driverId || e.date.slice(0, 4) !== year || e.method !== 'card') return a;
      if (e.kind === 'fare-collected-office' || e.kind === 'tip' || e.kind === 'toll') return a + amt1(e);
      if (e.kind === 'refund' && e.dr === ACCT.due) return a - e.amount;
      return a;
    }, 0));
  }
  function nec1099(year) {
    year = String(year || todayStr().slice(0, 4));
    var th = Number(led().settings.threshold1099) || DEFAULT_1099;
    return drivers().map(function (d) { var amt = paidViaSquare(d.id, year); return { driverId: d.id, name: d.name || '', tlc: d.tlc || '', paidViaSquare: amt, candidate: amt >= th, w9: hasW9(d), w9Date: d.w9 && d.w9.onFileAt || '' }; })
      .filter(function (r) { return r.paidViaSquare > 0 || r.candidate; }).sort(function (a, b) { return b.paidViaSquare - a.paidViaSquare; });
  }
  function export1099(year) {
    if (!ownerPinOK('export the 1099-NEC candidate list')) return '';
    year = String(year || todayStr().slice(0, 4));
    var list = nec1099(year).filter(function (r) { return r.candidate; }), lines = ['Year,Driver,TLC,Paid via Square,W-9 on file,Threshold'];
    list.forEach(function (r) { lines.push([year, r.name, r.tlc, r.paidViaSquare.toFixed(2), r.w9 ? r.w9Date : 'NO', led().settings.threshold1099].map(csvCell).join(',')); });
    var csv = lines.join('\r\n') + '\r\n';
    download('skyway-1099nec-candidates-' + year + '.csv', csv, 'text/csv'); toast(list.length + ' 1099-NEC candidate' + (list.length === 1 ? '' : 's') + ' for ' + year + ' exported.');
    return csv;
  }

  /* ---------- P&L: cash actually received ---------- */
  function cashReceived(ym) {
    ym = String(ym || todayStr().slice(0, 7));
    var paid = {}; led().settlements.forEach(function (s) { if (s.status === 'paid') paid[s.id] = true; });
    return round2(entries().reduce(function (a, e) {
      if (e.date.slice(0, 7) !== ym) return a;
      if (e.kind === 'base-fee-received' || e.kind === 'card-fee-recovered') return a + amt1(e);   // receipts, base fees withheld from payouts, card fees kept
      if (e.kind === 'fare-collected-office' && e.cr === ACCT.noshow) return a + amt1(e);
      if (e.kind === 'deduction' && e.settlementId && paid[e.settlementId]) return a + e.amount;
      return a;
    }, 0));
  }
  function parseMoney(s) { var m = String(s || '').replace(/,/g, '').match(/-?\$?\s*(-?\d+(?:\.\d+)?)/); return m ? Number(m[1].replace('$', '')) : 0; }
  function fmtInt(n) { return '$' + Math.round(n).toLocaleString(); }
  function patchPnl() {
    var ym = ''; try { ym = typeof window.bizYM === 'function' ? window.bizYM() : ((byId('b_month') || {}).value || ''); } catch (e) {}
    var cash = cashReceived(ym);
    var kp = byId('bizKpis');
    if (kp && !kp.querySelector('[data-ldg="cash"]')) {
      var tiles = Array.prototype.slice.call(kp.children), old = tiles.filter(function (el) { return /^Base-fee revenue|^Fees owed/.test((el.lastElementChild || {}).textContent || ''); })[0];
      if (old) {
        var nt = old.cloneNode(true); nt.setAttribute('data-ldg', 'cash'); nt.firstElementChild.textContent = fmtInt(cash); nt.lastElementChild.textContent = 'Cash received (ledger) ' + ym; nt.style.borderColor = '#1b7a43';
        kp.insertBefore(nt, old);
        // one label in both fee modes (quote.js writes the tiers form): the console's "Base-fee revenue @ $x" is the modeled figure, not cash
        old.lastElementChild.textContent = old.lastElementChild.textContent.replace(/^Base-fee revenue @/, 'Base-fee revenue — Fees owed (modeled) @');
      }
    }
    var pnl = byId('bizPnl');
    if (pnl && !pnl.querySelector('[data-ldg="rev"]')) {
      var trs = Array.prototype.slice.call(pnl.querySelectorAll('tbody tr')), rev = null, net = null, exp = null;
      trs.forEach(function (tr) { var l = (tr.cells[0] || {}).textContent || ''; if (/^Revenue/.test(l)) rev = tr; else if (/^NET$/.test(l.trim())) net = tr; else if (/^Total expenses/.test(l)) exp = tr; });
      if (rev && rev.cells.length >= 3) {
        var oldVal = rev.cells[2].textContent;
        rev.setAttribute('data-ldg', 'rev');
        rev.cells[0].innerHTML = '<b>Revenue — cash received (ledger)</b>'; rev.cells[2].innerHTML = '<b>' + esc(fmtInt(cash)) + '</b>';
        var fo = document.createElement('tr'); fo.setAttribute('data-ldg', 'owed');
        fo.innerHTML = '<td>Fees owed (modeled: completed × base fee + card recovery)</td><td></td><td class="num" style="color:var(--muted,#5b5b5b);">' + esc(oldVal.trim()) + '</td><td></td>';
        rev.parentNode.insertBefore(fo, rev.nextSibling);
        if (net && net.cells.length >= 3) {
          var expTot = exp ? parseMoney(exp.cells[2].textContent) : 0, nv = cash - expTot;
          net.cells[2].textContent = (nv < 0 ? '-' : '') + fmtInt(Math.abs(nv)); net.cells[2].style.color = nv >= 0 ? '#1b7a43' : '#b00020';
        }
        var hint = document.createElement('div'); hint.className = 'hint'; hint.setAttribute('data-ldg', 'hint'); hint.style.marginTop = '4px';
        hint.textContent = 'Revenue is cash the office actually received this month: cash base-fee receipts, base fees withheld from paid payouts, card fees kept, no-show fees and paid deductions (MONEY → Earnings records them). "Fees owed" is the old estimate — completed rides × the base fee.';
        pnl.appendChild(hint);
      }
    }
    var al = byId('bizAlert');
    if (al && al.firstElementChild && !al.querySelector('[data-ldg="alert"]')) {
      var note = document.createElement('div'); note.setAttribute('data-ldg', 'alert'); note.style.marginTop = '6px'; note.style.fontSize = '12px';
      note.textContent = 'Cash actually received ' + ym + ' (ledger): ' + fmtInt(cash) + '. The pace figures above use the modeled base fee, not cash.';
      al.firstElementChild.appendChild(note);
    }
  }

  /* ---------- styles ---------- */
  function ensureStyle() {
    if (byId('ledgerStyle')) return;
    var st = document.createElement('style'); st.id = 'ledgerStyle';
    st.textContent = [
      '.ldg-panel h4{margin:12px 0 4px;font-size:12.5px;color:var(--green-dark,#15497d);}',
      '.ldg-panel .ldg-row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:4px 0 8px;}',
      '.ldg-panel .ldg-row .fld{flex:0 1 auto;min-width:0;} .ldg-panel .ldg-row input,.ldg-panel .ldg-row select{min-width:90px;}',
      '.ldg-panel .ldg-acts{display:flex;flex-wrap:wrap;gap:4px;} .ldg-panel .ldg-acts .btn{white-space:nowrap;}',
      '.ldg-panel .tbl-scroll{max-height:300px;}',
      '.ldg-chip{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:10px;background:rgba(31,122,61,.12);color:#1f7a3d;margin-left:6px;white-space:nowrap;}',
      '.ldg-chip.warn{background:rgba(192,57,43,.1);color:#9b2d20;} .ldg-chip.draft{background:rgba(214,158,20,.14);color:#7a5a06;}',
      '.ldg-panel .stat-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;} .ldg-panel .stat{border:1px solid var(--line,#d4d4d4);border-radius:6px;padding:6px 10px;min-width:130px;background:rgba(120,140,160,.06);} .ldg-panel .stat .v{font-size:17px;font-weight:800;} .ldg-panel .stat .k{font-size:11px;color:var(--muted,#5b5b5b);}',
      '.ldg-panel .stat.warn{border-top:3px solid #c0392b;} .ldg-panel .stat.ok{border-top:3px solid #1f7a3d;}',
      '.ldg-panel textarea{width:100%;min-height:70px;font-family:Consolas,monospace;font-size:11.5px;}',
      '.ldg-panel .num{text-align:right;white-space:nowrap;}',
      'body.gold .ldg-panel h4{color:#e8c75a;} body.classic .ldg-panel h4{color:#0a246a;}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }

  /* ---------- UI: shared bits ---------- */
  function driverOpts(sel, all) { var h = all ? '<option value="">— pick a driver —</option>' : ''; drivers().forEach(function (d) { h += '<option value="' + esc(d.id) + '"' + (sel === d.id ? ' selected' : '') + '>' + esc(d.name || 'Driver') + (hasW9(d) ? '' : ' (no W-9)') + '</option>'; }); return h; }
  function methodOpts(sel) { return ['cash', 'zelle', 'check', 'ach', 'bank'].map(function (m) { return '<option value="' + m + '"' + (m === sel ? ' selected' : '') + '>' + m + '</option>'; }).join(''); }
  function tile(v, k, cls) { return '<div class="stat' + (cls ? ' ' + cls : '') + '"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>'; }
  var ui = { earnWeek: '', earnDriver: '', bizWeek: '', year: '' };
  function keepVals(panel) { if (!panel) return; panel.querySelectorAll('input,select,textarea').forEach(function (el) { if (el.id) ui['v_' + el.id] = el.type === 'checkbox' ? el.checked : el.value; }); }
  function restoreVals(panel) { if (!panel) return; panel.querySelectorAll('input,select,textarea').forEach(function (el) { if (el.id && ui['v_' + el.id] !== undefined && el.type !== 'file') { if (el.type === 'checkbox') el.checked = !!ui['v_' + el.id]; else el.value = ui['v_' + el.id]; } }); }

  /* ---------- UI: MONEY → Earnings panel ---------- */
  var EARN_ID = 'ledgerEarn';
  function ensureEarnPanel() {
    var view = byId('view-earnings'); if (!view) return null;
    var p = byId(EARN_ID);
    if (!p) { p = document.createElement('div'); p.id = EARN_ID; p.className = 'panel ldg-panel'; view.appendChild(p); p.addEventListener('click', onEarnClick); }
    return p;
  }
  function settlementRows() {
    var L = led(), list = L.settlements.slice().sort(function (a, b) { return a.from < b.from ? 1 : a.from > b.from ? -1 : a.driverName < b.driverName ? -1 : 1; });
    if (!list.length) return '<div class="hint" id="ldg_settle_empty" style="margin:0 0 4px;">No settlement runs yet. Pick the week and press "Run settlement".</div>';
    var h = '<div class="tbl-scroll"><table class="data" id="ldg_settlements"><thead><tr><th>Driver</th><th>Week</th><th class="num">Office-collected</th><th class="num">Tips</th><th class="num">Tolls</th><th class="num">Reimb.</th><th class="num">Deduct.</th><th class="num">Refunds</th><th class="num">Base owed</th><th class="num">Base rec\'d</th><th class="num">Net</th><th>Status</th><th></th></tr></thead><tbody>';
    list.forEach(function (s) {
      var L2 = s.lines;
      h += '<tr data-sid="' + esc(s.id) + '"><td>' + esc(s.driverName || driverName(s.driverId)) + '<div class="hint" style="margin:0;">' + esc(s.id) + '</div></td><td>' + esc(s.from) + '<br>' + esc(s.to) + '</td>'
        + '<td class="num">' + esc(money(L2.officeFares)) + '</td><td class="num">' + esc(money(L2.tips)) + '</td><td class="num">' + esc(money(L2.tolls)) + '</td><td class="num">' + esc(money(L2.reimbursements)) + '</td><td class="num">' + esc(money(L2.deductions)) + '</td><td class="num">' + esc(money(L2.refunds)) + '</td><td class="num">' + esc(money(L2.baseOwed)) + '</td><td class="num">' + esc(money(L2.baseReceived)) + '</td>'
        + '<td class="num"><b>' + esc(signed(s.net)) + '</b><div class="hint" style="margin:0;">' + (s.net > 0 ? 'office pays driver' : s.net < 0 ? 'driver pays base' : 'even') + '</div></td>'
        + '<td>' + (s.status === 'paid' ? '<span class="ldg-chip">paid ' + esc(s.paidDate || '') + ' · ' + esc(s.paidMethod || '') + '</span>' + (L2.baseWithheld ? '<div class="hint" style="margin:0;">base ' + esc(money(L2.baseWithheld)) + ' withheld</div>' : '') : s.stale ? '<span class="ldg-chip warn" title="' + esc(s.staleReason || '') + '">changed — re-run</span>' : '<span class="ldg-chip draft">draft</span>') + (L2.adjustments ? '<div class="hint" style="margin:0;" title="Corrections to rides from earlier paid runs">' + esc(signed(L2.adjustments)) + ' corrections</div>' : '') + (s.carryTrips && s.carryTrips.length ? '<div class="hint" style="margin:0;" title="Rides before this week that no run has settled yet">' + s.carryTrips.length + ' earlier ride' + (s.carryTrips.length === 1 ? '' : 's') + ' unsettled</div>' : '') + '</td>'
        + '<td><div class="ldg-acts"><button class="btn btn-ghost btn-sm" type="button" data-act="print" data-id="' + esc(s.id) + '">Print</button>'
        + (s.status === 'paid' ? '' : s.stale ? '<button class="btn btn-navy btn-sm" type="button" data-act="rerun" data-id="' + esc(s.id) + '" title="Owner PIN">Run again</button>' : '<select class="ldg-method" data-for="' + esc(s.id) + '" title="How it was paid">' + methodOpts(s.net > 0 ? 'ach' : 'cash') + '</select><input type="date" class="ldg-paidon" data-for="' + esc(s.id) + '" value="' + esc(todayStr()) + '" title="Date paid"><button class="btn btn-go btn-sm" type="button" data-act="paid" data-id="' + esc(s.id) + '" title="Owner PIN">Mark paid</button>')
        + '</div></td></tr>';
    });
    return h + '</tbody></table></div>';
  }
  function receiptRows() {
    var list = led().receipts.slice().sort(function (a, b) { return b.no - a.no; }).slice(0, 12);
    if (!list.length) return '<div class="hint" style="margin:0 0 4px;">No receipts yet.</div>';
    return '<div class="tbl-scroll" style="max-height:200px;"><table class="data" id="ldg_receipts"><thead><tr><th>Receipt</th><th>Date</th><th>Driver</th><th class="num">Amount</th><th>Paid by</th><th>For</th><th></th></tr></thead><tbody>'
      + list.map(function (r) { return '<tr><td class="mono">' + esc(receiptNo(r.no)) + '</td><td>' + esc(r.date) + '</td><td>' + esc(r.driverName || driverName(r.driverId)) + '</td><td class="num">' + esc(money(r.amount)) + '</td><td>' + esc(r.method) + '</td><td>' + esc(r.note || '') + '</td><td><button class="btn btn-ghost btn-sm" type="button" data-act="printrec" data-id="' + esc(r.id) + '">Print</button></td></tr>'; }).join('') + '</tbody></table></div>';
  }
  function renderEarnPanel() {
    var panel = ensureEarnPanel(); if (!panel) return;
    ensureStyle(); keepVals(panel);
    var wk = weekOf(ui.earnWeek || (byId('ern_date') || {}).value || todayStr());
    var h = '<div class="panel-head">Settlement &amp; receipts <span class="hint" style="margin:0;font-weight:400;">weekly runs per driver · owner PIN for runs, payouts and refunds</span></div><div class="panel-body">';
    h += '<h4>Settlement run <span class="hint" style="margin:0;font-weight:400;">&mdash; fares the office collected for the driver, tips, tolls, reimbursements, authorised deductions, refunds, base fee owed vs received</span></h4>';
    h += '<div class="ldg-row"><label class="fld"><span class="lbl">Any day in the week</span><input type="date" id="ldg_week" value="' + esc(ui.earnWeek || wk.from) + '"></label>'
      + '<label class="fld"><span class="lbl">Driver</span><select id="ldg_driver"><option value="*">All drivers with activity</option>' + driverOpts(ui.earnDriver, false) + '</select></label>'
      + '<button class="btn btn-go" type="button" data-act="run" title="Owner PIN">Run settlement</button><span class="hint" style="margin:0;">Week ' + esc(wk.from) + ' to ' + esc(wk.to) + '. A driver with no W-9 on file cannot be paid out (Fleet &rarr; W-9 on file).</span></div>';
    h += settlementRows();
    h += '<h4>Cash base-fee receipt <span class="hint" style="margin:0;font-weight:400;">&mdash; numbered, printed, counts against what the driver owes</span></h4>';
    h += '<div class="ldg-row"><label class="fld"><span class="lbl">Driver</span><select id="ldg_rc_driver">' + driverOpts('', true) + '</select></label><label class="fld"><span class="lbl">Amount</span><input type="number" step="0.01" min="0" id="ldg_rc_amt" style="width:100px;"></label><label class="fld"><span class="lbl">Paid by</span><select id="ldg_rc_method">' + methodOpts('cash') + '</select></label><label class="fld"><span class="lbl">For</span><input type="text" id="ldg_rc_note" placeholder="base fee week of…"></label><button class="btn btn-navy" type="button" data-act="receipt">Issue receipt &amp; print</button><span class="hint" style="margin:0;">Next number ' + esc(receiptNo(led().receiptSeq)) + '</span></div>';
    h += receiptRows();
    h += '<h4>Reimbursement or deduction</h4>';
    h += '<div class="ldg-row"><label class="fld"><span class="lbl">Driver</span><select id="ldg_rd_driver">' + driverOpts('', true) + '</select></label><label class="fld"><span class="lbl">Kind</span><select id="ldg_rd_kind"><option value="reimbursement">Reimbursement (office owes driver)</option><option value="deduction">Deduction (needs authority)</option></select></label><label class="fld"><span class="lbl">Amount</span><input type="number" step="0.01" min="0" id="ldg_rd_amt" style="width:100px;"></label><label class="fld"><span class="lbl">What for</span><input type="text" id="ldg_rd_note" placeholder="toll receipt, car wash, damage…"></label><label class="fld"><span class="lbl">Authority (deductions)</span><input type="text" id="ldg_rd_auth" placeholder="agreement clause / signed form"></label><button class="btn btn-navy" type="button" data-act="rd">Add</button></div>';
    h += '<h4>Refund <span class="hint" style="margin:0;font-weight:400;">&mdash; reverses a payment the office collected; the ride is tagged. Owner PIN.</span></h4>';
    h += '<div class="ldg-row"><label class="fld"><span class="lbl">Trip #</span><input type="text" id="ldg_rf_no" placeholder="dispatch #" style="width:100px;"></label><label class="fld"><span class="lbl">Amount (blank = all)</span><input type="number" step="0.01" min="0" id="ldg_rf_amt" style="width:100px;"></label><label class="fld"><span class="lbl">Reason</span><input type="text" id="ldg_rf_reason" placeholder="why"></label><button class="btn btn-void" type="button" data-act="refund">Refund</button></div>';
    var refunds = entries().filter(function (e) { return e.kind === 'refund'; }).slice(-8).reverse();
    if (refunds.length) h += '<div class="hint" style="margin:0;">Recent refunds: ' + refunds.map(function (e) { return esc(e.ref) + ' ' + esc(money(e.amount)) + ' (' + esc(e.date) + (e.memo ? ', ' + esc(e.memo) : '') + ')'; }).join(' · ') + '</div>';
    h += '</div>';
    panel.innerHTML = h;
    restoreVals(panel);
    var wkEl = byId('ldg_week'); if (wkEl && ui.earnWeek) wkEl.value = ui.earnWeek;
  }
  function val(id) { var el = byId(id); return el ? el.value : ''; }
  function onEarnClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    try {
      if (a === 'run') {
        ui.earnWeek = val('ldg_week'); ui.earnDriver = val('ldg_driver');
        var w = weekOf(ui.earnWeek || todayStr()), ids = ui.earnDriver && ui.earnDriver !== '*' ? [ui.earnDriver] : null;
        if (!ids) { sweep(true); ids = drivers().filter(function (d) { return unsettledFor(d.id, w.from, w.to).length || baseOwedFor(d.id, w.from, w.to) > 0; }).map(function (d) { return d.id; }); }
        if (!ids.length) { toast('No driver activity to settle for ' + w.from + ' to ' + w.to + '.', true); return; }
        if (!ownerPinOK('run settlements for ' + w.from + ' to ' + w.to)) return;
        var ok = 0, blocked = [];
        ids.forEach(function (did) { var r = settle(did, w.from, w.to, { skipPin: true, quiet: true }); if (r.ok) ok++; else if (r.reason === 'no-w9') blocked.push(driverName(did)); });
        toast(ok + ' settlement' + (ok === 1 ? '' : 's') + ' run for ' + w.from + ' to ' + w.to + (blocked.length ? '. Not added (no W-9): ' + blocked.join(', ') : '.'), !!blocked.length);
        render();
      }
      else if (a === 'paid') { var m = document.querySelector('.ldg-method[data-for="' + id + '"]'), dt = document.querySelector('.ldg-paidon[data-for="' + id + '"]'); markPaid(id, m ? m.value : '', dt ? dt.value : ''); }
      else if (a === 'rerun') { var st = settlementById(id); if (st) settle(st.driverId, st.from, st.to); }
      else if (a === 'print') printStatement(id);
      else if (a === 'printrec') printReceipt(id);
      else if (a === 'receipt') { var rec = cashReceipt(val('ldg_rc_driver'), val('ldg_rc_amt'), val('ldg_rc_method'), val('ldg_rc_note')); if (rec) { ui.v_ldg_rc_amt = ''; ui.v_ldg_rc_note = ''; render(); openPrint(receiptHTML(rec)); } }
      else if (a === 'rd') { var kind = val('ldg_rd_kind'), r2 = kind === 'deduction' ? deduct(val('ldg_rd_driver'), val('ldg_rd_amt'), val('ldg_rd_auth'), val('ldg_rd_note')) : reimburse(val('ldg_rd_driver'), val('ldg_rd_amt'), val('ldg_rd_note')); if (r2) { ui.v_ldg_rd_amt = ''; ui.v_ldg_rd_note = ''; ui.v_ldg_rd_auth = ''; render(); } }
      else if (a === 'refund') { var t = tripByNo(val('ldg_rf_no')); if (!t) { toast('No trip with that dispatch number.', true); return; } var amtV = val('ldg_rf_amt'); if (refund(t.id, amtV === '' ? null : amtV, val('ldg_rf_reason'))) { ui.v_ldg_rf_no = ''; ui.v_ldg_rf_amt = ''; ui.v_ldg_rf_reason = ''; render(); } }
    } catch (err) { try { console.error('[ledger]', err); } catch (e2) {} }
  }

  /* ---------- UI: MONEY → Business panel ---------- */
  var BIZ_ID = 'ledgerBiz';
  function ensureBizPanel() {
    var view = byId('view-biz'); if (!view) return null;
    var p = byId(BIZ_ID);
    if (!p) { p = document.createElement('div'); p.id = BIZ_ID; p.className = 'panel ldg-panel'; view.appendChild(p); p.addEventListener('click', onBizClick); p.addEventListener('change', onBizChange); }
    return p;
  }
  function listOr(list, fn, empty) { return list.length ? list.map(fn).join('') : '<div class="hint" style="margin:0;">' + empty + '</div>'; }
  function renderBizPanel() {
    var panel = ensureBizPanel(); if (!panel) return;
    ensureStyle(); keepVals(panel);
    var L = led(), wkDate = ui.bizWeek || todayStr(), R = reconcile(wkDate), year = ui.year || todayStr().slice(0, 4);
    var h = '<div class="panel-head">Ledger &amp; reconciliation <span class="hint" style="margin:0;font-weight:400;">Square payouts vs bank · cash base fees owed vs receipted · W-9 / 1099-NEC · journal export</span></div><div class="panel-body">';
    h += '<h4>Weekly reconciliation</h4><div class="ldg-row"><label class="fld"><span class="lbl">Any day in the week</span><input type="date" id="ldg_bz_week" value="' + esc(wkDate) + '"></label><button class="btn btn-navy" type="button" data-act="week">Show week</button><span class="hint" style="margin:0;">Week ' + esc(R.from) + ' to ' + esc(R.to) + '</span></div>';
    h += '<div class="stat-row" id="ldg_recon">' + tile(money(R.payoutTotal), 'Square payouts (' + R.payouts.length + ')') + tile(money(R.bankTotal), 'Bank credits typed (' + R.bank.length + ')', Math.abs(R.payoutTotal - R.bankTotal) < 0.005 ? 'ok' : 'warn')
      + tile(money(R.cashOwed), 'Base fees owed') + tile(money(R.receipted), 'Received (' + money(R.receiptedCash) + ' receipts + ' + money(R.withheld) + ' withheld)', R.cashGap > 0.005 ? 'warn' : 'ok') + tile(signed(R.cashGap), 'Still to collect')
      + tile(money(R.squareCollected), 'Square collected (import)') + tile(money(R.squareFees), 'Square fees (actual)') + tile(money(R.consoleCard), 'Card paid in console') + tile(String(R.unmatchedCount), 'Unmatched items', R.unmatchedCount ? 'warn' : 'ok') + '</div>';
    h += '<div class="grid2"><div><b>Square payouts this week</b>' + listOr(R.payouts, function (p) { return '<div style="margin:3px 0;"><span class="mono">' + esc(p.id) + '</span> ' + esc(p.date) + ' <b>' + esc(money(p.amount)) + '</b> ' + (p.bankId ? '<span class="ldg-chip">bank ✓</span>' : '<span class="ldg-chip warn">no bank credit</span> <select class="ldg-match" data-payout="' + esc(p.id) + '"><option value="">match a bank credit…</option>' + L.bank.filter(function (b) { return !b.payoutId; }).map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.date) + ' ' + esc(money(b.amount)) + ' ' + esc(b.memo) + '</option>'; }).join('') + '</select>') + '</div>'; }, 'No Square payouts this week (import the Payouts CSV below).')
      + '</div><div><b>Unmatched</b>' + listOr([].concat(
        R.bankUnmatched.map(function (b) { return '<div style="margin:3px 0;">Bank credit ' + esc(b.date) + ' <b>' + esc(money(b.amount)) + '</b> ' + esc(b.memo) + ' — no Square payout</div>'; }),
        R.cardUnseenInSquare.map(function (t) { return '<div style="margin:3px 0;">' + esc(tripRef(t)) + ' card ' + esc(money(t.status === 'No-Show' ? t.payment.amount : officeTotal(t))) + ' paid in console — not in a Square import yet</div>'; }),
        R.squareUnmatched.map(function (p) { return '<div style="margin:3px 0;">Square payment <span class="mono">' + esc(p.id) + '</span> ' + esc(p.date) + ' <b>' + esc(money(p.amount)) + '</b> — no ride matched' + (p.ref || p.description ? ' (' + esc(p.ref || p.description) + ')' : '') + '</div>'; }),
        R.squareRefundsUnmatched.map(function (p) { return '<div style="margin:3px 0;">Square refund <span class="mono">' + esc(p.id) + '</span> ' + esc(p.date) + ' <b>' + esc(money(Math.abs(p.amount))) + '</b> — no console refund matches it (record the refund above with the trip #)</div>'; }),
        R.staleSettlements.map(function (s) { return '<div style="margin:3px 0;">Settlement <span class="mono">' + esc(s.id) + '</span> ' + esc(s.driverName || '') + ' — a ride changed after the run (' + esc(s.staleReason || '') + '). Run it again in Earnings.</div>'; }),
        R.heldForPassengers.map(function (e) { var t = findTrip(e.tripId); return '<div style="margin:3px 0;">' + esc(e.ref) + ' card <b>' + esc(money(e.amount)) + '</b> collected on a ride that was ' + esc(t ? String(t.status).toLowerCase() : 'removed') + ' — held for the passenger: refund it (Earnings) or note why it is kept</div>'; }),
        R.unassignedCollected.map(function (e) { return '<div style="margin:3px 0;">' + esc(e.ref) + ' ' + esc(e.kind === 'fare-collected-office' ? 'fare' : e.kind) + ' <b>' + esc(money(e.amount)) + '</b> collected with no driver on the ride — assign the driver so it can be settled</div>'; })
      ), function (x) { return x; }, 'Everything matches.')
      + (R.changedAfterJournal.length ? '<div style="margin-top:6px;"><b>Rides changed after they were journaled</b>' + R.changedAfterJournal.slice(0, 12).map(function (c) { return '<div class="hint" style="margin:2px 0;">' + esc(c.ref || c.tripId) + ' — ' + esc(c.what || '') + ' (' + esc(c.how) + (c.settlementId ? ', was in ' + esc(c.settlementId) : '') + ')</div>'; }).join('') + '</div>' : '')
      + '</div></div>';
    h += '<h4>Square CSV import <span class="hint" style="margin:0;font-weight:400;">&mdash; Dashboard &rarr; Transactions or Payouts export. Detected by header. Importing the same file twice changes nothing.</span></h4>';
    h += '<div class="ldg-row"><input type="file" id="ldg_sq_file" accept=".csv,text/csv"><button class="btn btn-navy" type="button" data-act="importfile">Import file</button><span class="hint" style="margin:0;">or paste the CSV text:</span></div><textarea id="ldg_sq_text" placeholder="Date,Time,...,Transaction ID,Payment ID,..."></textarea><div class="ldg-row"><button class="btn btn-ghost" type="button" data-act="importtext">Import pasted CSV</button></div>';
    var imps = L.imports.slice().reverse().slice(0, 6);
    if (imps.length) h += '<div class="hint" style="margin:0;">Imports: ' + imps.map(function (i) { return esc(i.kind) + ' ' + esc((i.at || '').slice(0, 10)) + ' ' + esc(i.fileName || '') + ' (' + i.rows + ' rows, ' + i.added + ' new' + (i.times > 1 ? ', seen ' + i.times + '×' : '') + ')'; }).join(' · ') + '</div>';
    h += '<h4>Bank credit (typed from the bank statement)</h4><div class="ldg-row"><label class="fld"><span class="lbl">Date</span><input type="date" id="ldg_bk_date" value="' + esc(todayStr()) + '"></label><label class="fld"><span class="lbl">Amount</span><input type="number" step="0.01" min="0" id="ldg_bk_amt" style="width:100px;"></label><label class="fld"><span class="lbl">Memo</span><input type="text" id="ldg_bk_memo" placeholder="SQUARE INC DES:…"></label><button class="btn btn-navy" type="button" data-act="bank">Add bank credit</button></div>';
    var openInv = invoices().filter(function (i) { return i.status !== 'paid'; });
    h += '<h4>Invoices waiting for payment</h4>' + listOr(openInv, function (i) { return '<div class="ldg-row" style="margin:2px 0;">Invoice #' + esc(i.no) + ' · ' + esc(i.account || '') + ' · <b>' + esc(money(i.total)) + '</b> · due ' + esc(i.due || '') + ' <select class="ldg-inv-method" data-for="' + esc(i.no) + '">' + methodOpts('bank') + '</select><input type="date" class="ldg-inv-date" data-for="' + esc(i.no) + '" value="' + esc(todayStr()) + '"><button class="btn btn-go btn-sm" type="button" data-act="invpaid" data-id="' + esc(i.no) + '">Mark paid</button></div>'; }, 'No open invoices.');
    var nec = nec1099(year), th = L.settings.threshold1099;
    h += '<h4>W-9 on file &amp; 1099-NEC candidates <span class="hint" style="margin:0;font-weight:400;">&mdash; drivers paid ' + esc(money(th)) + ' or more through Skyway\'s Square in the calendar year</span></h4>';
    h += '<div class="ldg-row"><label class="fld"><span class="lbl">Year</span><input type="number" id="ldg_year" value="' + esc(year) + '" style="width:90px;"></label><button class="btn btn-ghost" type="button" data-act="year">Show</button><button class="btn btn-navy" type="button" data-act="nec" title="Owner PIN">Export candidate list (CSV)</button></div>';
    h += '<div class="tbl-scroll" style="max-height:220px;"><table class="data" id="ldg_nec"><thead><tr><th>Driver</th><th>W-9 on file</th><th class="num">Paid via Square ' + esc(year) + '</th><th>1099-NEC</th></tr></thead><tbody>'
      + (drivers().length ? drivers().map(function (d) { var r = nec.filter(function (x) { return x.driverId === d.id; })[0] || { paidViaSquare: 0, candidate: false }; return '<tr data-drv="' + esc(d.id) + '"><td>' + esc(d.name || 'Driver') + '</td><td>' + (hasW9(d) ? '<span class="ldg-chip">on file ' + esc(d.w9.onFileAt) + '</span>' : '<span class="ldg-chip warn">no W-9</span>') + '</td><td class="num">' + esc(money(r.paidViaSquare)) + '</td><td>' + (r.candidate ? '<b>candidate</b>' + (hasW9(d) ? '' : ' — get the W-9') : '—') + '</td></tr>'; }).join('') : '<tr><td colspan="4"><div class="empty">No drivers yet.</div></td></tr>') + '</tbody></table></div>';
    h += '<h4>Journal export <span class="hint" style="margin:0;font-weight:400;">&mdash; every entry as a debit line and a credit line; totals balance</span></h4>';
    var wk = weekOf(wkDate);
    h += '<div class="ldg-row"><label class="fld"><span class="lbl">From</span><input type="date" id="ldg_j_from" value="' + esc(wk.from) + '"></label><label class="fld"><span class="lbl">To</span><input type="date" id="ldg_j_to" value="' + esc(wk.to) + '"></label><button class="btn btn-navy" type="button" data-act="journal">Download journal CSV</button><span class="hint" style="margin:0;">' + L.entries.length + ' entries on the books</span></div>';
    h += '</div>';
    panel.innerHTML = h;
    restoreVals(panel);
    var we = byId('ldg_bz_week'); if (we) we.value = wkDate;
    var ye = byId('ldg_year'); if (ye) ye.value = year;
  }
  function onBizChange(e) {
    var s = e.target && e.target.closest ? e.target.closest('select.ldg-match') : null; if (!s) return;
    try { matchPayout(s.getAttribute('data-payout'), s.value); } catch (err) { try { console.error('[ledger]', err); } catch (e2) {} }
  }
  function onBizClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    try {
      if (a === 'week') { ui.bizWeek = val('ldg_bz_week'); render(); }
      else if (a === 'year') { ui.year = val('ldg_year'); render(); }
      else if (a === 'nec') export1099(val('ldg_year'));
      else if (a === 'journal') exportJournal(val('ldg_j_from'), val('ldg_j_to'));
      else if (a === 'bank') { if (addBankCredit(val('ldg_bk_date'), val('ldg_bk_amt'), val('ldg_bk_memo'))) { ui.v_ldg_bk_amt = ''; ui.v_ldg_bk_memo = ''; render(); } }
      else if (a === 'invpaid') { var m = document.querySelector('.ldg-inv-method[data-for="' + id + '"]'), dt = document.querySelector('.ldg-inv-date[data-for="' + id + '"]'); invoicePaid(id, m ? m.value : 'bank', dt ? dt.value : ''); }
      else if (a === 'importtext') { var txt = val('ldg_sq_text'); if (!txt.trim()) { toast('Paste the CSV text first.', true); return; } if (importSquare(txt, 'pasted').ok) { ui.v_ldg_sq_text = ''; render(); } }
      else if (a === 'importfile') {
        var f = byId('ldg_sq_file'), file = f && f.files && f.files[0]; if (!file) { toast('Choose the CSV file first.', true); return; }
        var rd = new FileReader(); rd.onload = function () { try { importSquare(String(rd.result || ''), file.name); } catch (err) { toast('Could not read that file.', true); } }; rd.readAsText(file);
      }
    } catch (err) { try { console.error('[ledger]', err); } catch (e2) {} }
  }

  /* ---------- UI: Fleet → W-9 on file ---------- */
  var fleetPre = null;
  function injectFleetField() {
    var notes = byId('dr_notes'); if (!notes || byId('ldg_drv_fields')) return;
    var anchor = byId('ops_drv_fields') || (notes.closest ? notes.closest('label.fld') : null) || notes.parentNode;
    anchor.insertAdjacentHTML('afterend', '<div class="grid2" id="ldg_drv_fields"><label class="fld"><span class="lbl">W-9 on file (date received)</span><input type="date" id="ldg_dr_w9"></label><label class="fld"><span class="lbl">&nbsp;</span><button type="button" class="btn btn-ghost btn-sm" id="ldg_dr_w9_today">W-9 received today</button></label></div><div class="hint" style="margin:0 0 6px;">Only the date is kept, not the form. A driver without a W-9 cannot be added to a payout run (MONEY &rarr; Earnings).</div>');
    byId('ldg_dr_w9_today').addEventListener('click', act(function () { byId('ldg_dr_w9').value = todayStr(); toast('W-9 date set to today. Press Save Driver to keep it.'); }));
    var cur = (byId('dr_id') || {}).value; fillFleetField(cur ? findDriver(cur) : null);
  }
  function fillFleetField(d) { var el = byId('ldg_dr_w9'); if (el) el.value = d && d.w9 && isDate(d.w9.onFileAt) ? d.w9.onFileAt : ''; }
  function decorateDriverRows() {
    var body = byId('driverBody'); if (!body) return;
    var rows = body.querySelectorAll('tr'), list = drivers();
    rows.forEach(function (tr, i) { var d = list[i]; if (!d || !tr.cells || tr.cells.length < 3) return; tr.querySelectorAll('.ldg-chip').forEach(function (old) { old.remove(); }); var span = document.createElement('span'); span.className = 'ldg-chip' + (hasW9(d) ? '' : ' warn'); span.textContent = hasW9(d) ? 'W-9 ' + d.w9.onFileAt : 'no W-9'; span.title = hasW9(d) ? 'W-9 on file since ' + d.w9.onFileAt : 'No W-9 on file — cannot be added to a payout run'; tr.cells[0].appendChild(span); });
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('#dr_save') : null; if (!t) return;
    try { fleetPre = { id: (byId('dr_id') || {}).value || '', count: drivers().length, w9: (byId('ldg_dr_w9') || {}).value || '' }; } catch (err) { fleetPre = null; }
  }, true);
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('#dr_save') : null; if (!t || !fleetPre) return;
    var pre = fleetPre; fleetPre = null;
    try {
      /* the console's own handler ran first: on a saved driver it clears the form (dr_id empty, or a new row added);
         a refused save ("Driver name required.") leaves the form as it was — then the W-9 date stays as it was too */
      var post = (byId('dr_id') || {}).value || '';
      var saved = pre.id ? post !== pre.id : drivers().length > pre.count;
      if (!saved) return;
      var d = pre.id ? findDriver(pre.id) : drivers()[drivers().length - 1];
      if (!d) return;
      var cur = d.w9 && d.w9.onFileAt || '';
      if ((pre.w9 || '') !== cur) { if (isDate(pre.w9)) d.w9 = Object.assign({}, d.w9 || {}, { onFileAt: pre.w9 }); else delete d.w9; save(); }
      decorateDriverRows();
    } catch (err) { try { console.error('[ledger]', err); } catch (e2) {} }
  });

  /* Invoicing → "Open / Print Invoice": the console records the invoice in that click (its save is debounced),
     so the CCU receivable is written right here, before anything else reads the books. */
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('#iv_open') : null; if (!t) return;
    try { if (ensureInvoiceLines()) save(); } catch (err) { try { console.error('[ledger]', err); } catch (e2) {} }
  });

  /* ---------- hooks (wrap, never edit) ---------- */
/* keep the inner wrappers' marker flags (e.g. __fixesWrapped) visible on the outermost function */
  function inheritFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_{1,2}\w*Wrapped$/.test(k) && w[k] === undefined) w[k] = orig[k]; }); } catch (e) {} return w; }
  function wrap(name, make) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig._ledgerWrapped) return false;
    var w = make(orig); w._ledgerWrapped = true; w._orig = orig; inheritFlags(w, orig);
    window[name] = w; return true;
  }
  function after(name, fn) { return wrap(name, function (orig) { return function () { var out; try { out = orig.apply(this, arguments); } finally { try { fn.apply(this, arguments); } catch (e) { try { console.error('[ledger]', e); } catch (e2) {} } } return out; }; }); }
  /* Needs-you (Simple mode): a refunded card ride is not "not marked paid". Removes those lines and recounts the head
     (the count is every line on the strip, the other modules' included). Returns true when a line was removed. */
  function pruneRefundedNeedsYou() {
    var host = byId('needsYou'); if (!host) return false;
    var gone = false;
    host.querySelectorAll('.ny-item[data-kind="unpaid"]').forEach(function (el) { var t = findTrip(el.getAttribute('data-id')); if (t && t.payment && t.payment.status === 'refunded') { el.remove(); gone = true; } });
    if (!gone) return false;
    var hd = host.querySelector('.ny-head'), c = hd && hd.querySelector('.ny-count');
    if (c) { var n = host.querySelectorAll('.ny-item').length; c.textContent = String(n); var tx = hd.childNodes[hd.childNodes.length - 1]; if (tx && tx.nodeType === 3) tx.textContent = n ? ' Needs you' : ' Nothing needs you right now'; host.classList.toggle('ny-clear', !n); }
    return true;
  }
  /* simple.js also rebuilds the strip inside its own enter() / goTab / refreshBoard paths, which never pass through the wrapped
     Simple.refreshNeedsYou: watch the strip and prune there too. The observer only removes lines, so it cannot loop. */
  function watchNeedsYou() {
    var host = byId('needsYou'); if (!host || host.__ledgerObserved || !window.MutationObserver || POPOUT) return;
    host.__ledgerObserved = true;
    try { new MutationObserver(function () { try { pruneRefundedNeedsYou(); } catch (e) {} }).observe(host, { childList: true }); } catch (e) {}
  }
  function earningsActive() { var v = byId('view-earnings'); return !!(v && v.classList.contains('active')); }
  function bizActive() { var v = byId('view-biz'); return !!(v && v.classList.contains('active')); }
  function render() {
    try { renderEarnPanel(); } catch (e) {}
    try { if (bizActive()) { if (typeof window.renderBiz === 'function') window.renderBiz(); else renderBizPanel(); } else renderBizPanel(); } catch (e) {}
  }
  function hookAll() {
    after('persist', function () { var n = sweep(true); if (n) save(); });
    after('reloadFromStorage', function () { led(); });
    after('renderEarnings', renderEarnPanel);
    after('renderBiz', function () { patchPnl(); renderBizPanel(); });
    after('renderDrivers', function () { injectFleetField(); decorateDriverRows(); });
    after('editDriver', function (id) { fillFleetField(findDriver(id)); });
    after('clearDriver', function () { fillFleetField(null); });
    /* money.js: a fully refunded card ride is not "unpaid" — keep it out of the Unpaid rides table */
    try {
      if (window.Money && typeof window.Money.unpaid === 'function' && !window.Money.unpaid._ledgerWrapped) {
        var ou = window.Money.unpaid; var wu = function () { var list = ou.apply(this, arguments) || []; return list.filter(function (t) { return !(t.payment && t.payment.status === 'refunded'); }); }; wu._ledgerWrapped = true; wu._orig = ou; window.Money.unpaid = wu;
      }
    } catch (e) {}
    /* simple.js Needs-you: drop the "card trip not marked paid" item for a refunded ride */
    try {
      if (window.Simple && typeof window.Simple.refreshNeedsYou === 'function' && !window.Simple.refreshNeedsYou._ledgerWrapped) {
        var on = window.Simple.refreshNeedsYou; var wn = function () { var r = on.apply(this, arguments); try { pruneRefundedNeedsYou(); } catch (e) {} return r; };
        wn._ledgerWrapped = true; wn._orig = on; inheritFlags(wn, on); window.Simple.refreshNeedsYou = wn;
      }
      watchNeedsYou();
    } catch (e) {}
  }

  /* ---------- public API ---------- */
  window.Ledger = {
    _loaded: true, ACCT: ACCT,
    state: led, entries: entries, voided: function () { return led().voided; }, sweep: sweep, ensureTripEntries: ensureTripEntries, ensureInvoiceLines: ensureInvoiceLines, desiredLines: desiredLines, addEntry: addEntry, matchSquareRefund: matchSquareRefund, refundEvents: refundEvents, refundedSoFar: function (t) { t = findTrip(t); return t ? refundedSoFar(t) : 0; },
    cashReceipt: cashReceipt, receiptHTML: receiptHTML, printReceipt: printReceipt, receiptNo: receiptNo,
    reimburse: reimburse, deduct: deduct,
    hasW9: hasW9, setW9: setW9, nec1099: nec1099, paidViaSquare: paidViaSquare, export1099: export1099,
    compute: compute, settle: settle, markPaid: markPaid, settlement: settlementById, findSettlement: findSettlement, statementHTML: statementHTML, printStatement: printStatement,
    refund: refund, invoicePaid: invoicePaid,
    parseCSV: parseCSV, detectKind: detectKind, importSquare: importSquare, addBankCredit: addBankCredit, matchPayout: matchPayout,
    reconcile: reconcile, journalRows: journalRows, journalCSV: journalCSV, exportJournal: exportJournal,
    cashReceived: cashReceived, weekOf: weekOf, render: render, renderEarnings: renderEarnPanel, renderBusiness: renderBizPanel, patchPnl: patchPnl
  };

  /* ---------- boot ---------- */
  function boot() {
    try { led(); } catch (e) {}
    try { ensureStyle(); } catch (e) {}
    hookAll();
    try { var n = sweep(true); if (n) save(); } catch (e) {}
    try { renderEarnPanel(); } catch (e) {}
    try { renderBizPanel(); } catch (e) {}
    try { if (bizActive()) patchPnl(); } catch (e) {}
    try { injectFleetField(); decorateDriverRows(); } catch (e) {}
    document.addEventListener('region:changed', function () { try { render(); } catch (e) {} });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
