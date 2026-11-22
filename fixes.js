/* ======================================================================
   Skyway — fixes.js
   The five small fixes from the plan's build table plus the "Money defaults"
   Settings card. Wraps console globals from index.html; never edits them.

   (a) isInvoiced() also tests t.invoiceNo — that one lives in money.js and was
       changed there (money.js isInvoiced).
   (b) The 15% airport "tip" the booking form wrote onto airport trips is not
       money. It is stored as trip.tipEstimate (a number, never billed) and
       trip.tip stays 0 unless a human typed it (edit overlay "Tip" box).
       Invoices, Money totals, settlement, receipts and exports read t.tip only,
       so they ignore tipEstimate without any change. Existing airport trips that
       carry exactly the formula tip and were never invoiced/paid are moved once.
       The hook sits on #d_save wherever that button exists (main console and the
       Call Entry / Active Board / Wall Board pop-outs); saveEditOvl is wrapped so
       a fare change in the board Edit overlay refreshes the estimate too.
   (c) cardFeeAmt(fare) returns 0 unless settings.cardPct > 0 (the Square bracket
       table no longer applies by default). Book readout and MONEY follow.
   (d) recordFare() (fare learning) runs only when the Book form fare came from
       the engine (#d_fare dataset.auto set) — a typed override is a one-off.
       settings.learnTypedFares = true restores the old "learn everything".
   (e) driverOptions(true) (the assign selects: board row, Book form, Edit
       overlay) hides drivers with active === false (Off-duty): the option is
       disabled + hidden, so a trip already assigned to that driver still shows
       the name instead of silently reading "unassigned". driverOptions(false),
       the Trip Records / Map "All drivers" filters, is left alone so history
       of an Off-duty driver stays reachable.
   (f) Port Authority airport access fee: the NYC engine (NYCFARE.RATES.airports
       .fhvAirportFee) reads settings.paFee (default 3.50). Receipts itemise it
       (and the NYS congestion surcharge / MTA CRZ charge on Manhattan trips) as
       "incl." lines only when settings.itemizePassThroughs is true (owner
       decision A9: quote all-in; default false). Totals never change.
   (g) Settings card "Money defaults" (Simple mode: Settings → Settings; behind
       the admin PIN like the rest of Settings): autoGratuityPct, noShowFee rule,
       holdFactor (1.0–1.5), paFee, itemizePassThroughs, feeMode ('flat' |
       'tiers', read-only tier table from settings.feeTiers), learnTypedFares.
       "Card on file" toggle in the account editor (accounts[].cardOnFile — the
       flag money.js hasCard() already reads).

   STATE keys (settings.* only): autoGratuityPct, noShowFee{mode,amount,pct},
     holdFactor, paFee, itemizePassThroughs, feeMode, feeTiers (read only),
     learnTypedFares, fixesTipMigratedAt. Trip field: tipEstimate. Account field:
     cardOnFile (already read by money.js).
   Public API: window.Fixes = {render, passThroughs, tipEstimateFor, paFee,
     applyPaFee, isAirportTrip, defaults}
   Plain ES2019, no build step, no network. Works with Cloud off.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;
  if (window.Fixes && window.Fixes._loaded) return;

  /* SCREEN is a top-level const in index.html (lexical global). Function fixes and the
     booking-form hook apply everywhere (pop-outs book trips, print receipts and render
     driver selects too); only the Settings card is limited to the main console page. */
  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }

  /* ---------- helpers (own copies; globals may be missing) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[fixes] ' + m); } catch (e) {} }
  function save() { if (typeof window.save === 'function') { try { window.save(); return; } catch (e) {} } if (typeof window.saveNow === 'function') { try { window.saveNow(); } catch (e) {} } }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  function trips() { return Array.isArray(STATE.trips) ? STATE.trips : []; }
  function accounts() { return Array.isArray(STATE.accounts) ? STATE.accounts : []; }
  function findTrip(id) { if (id && typeof id === 'object') return id; return trips().filter(function (t) { return t && t.id === id; })[0] || null; }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { try { console.error('[fixes]', err); } catch (e2) {} } }; }
  function nowISO() { return new Date().toISOString(); }

  /* Wrap a console global: keep the original as wrapper._orig, mark __fixesWrapped, call through. */
/* keep the inner wrappers' marker flags (e.g. __fixesWrapped) visible on the outermost function */
  function inheritFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_{1,2}\w*Wrapped$/.test(k) && w[k] === undefined) w[k] = orig[k]; }); } catch (e) {} return w; }
  function hook(name, make) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__fixesWrapped) return false;
    var wrapped = make(orig);
    wrapped.__fixesWrapped = true; wrapped._orig = orig; inheritFlags(wrapped, orig);
    window[name] = wrapped;
    return true;
  }

  /* ---------- defaults (owner decisions 4, 5, A9) — written only when missing ---------- */
  var DEFAULTS = { autoGratuityPct: 0, noShowFee: { mode: 'base' }, holdFactor: 1.2, paFee: 3.50, itemizePassThroughs: false, feeMode: 'flat', learnTypedFares: false };
  function clampHold(v) { v = Number(v); if (!isFinite(v)) return DEFAULTS.holdFactor; return round2(Math.min(1.5, Math.max(1.0, v))); }
  function paFee() { var v = Number(settings().paFee); return (isFinite(v) && v >= 0) ? round2(v) : DEFAULTS.paFee; }
  function ensureDefaults() {
    var s = settings(), dirty = false;
    if (s.autoGratuityPct == null || s.autoGratuityPct === '') { s.autoGratuityPct = DEFAULTS.autoGratuityPct; dirty = true; }
    if (!s.noShowFee || typeof s.noShowFee !== 'object') { s.noShowFee = { mode: 'base' }; dirty = true; }
    if (s.holdFactor == null || !isFinite(Number(s.holdFactor))) { s.holdFactor = DEFAULTS.holdFactor; dirty = true; }
    else if (clampHold(s.holdFactor) !== Number(s.holdFactor)) { s.holdFactor = clampHold(s.holdFactor); dirty = true; }
    if (s.paFee == null || !isFinite(Number(s.paFee))) { s.paFee = DEFAULTS.paFee; dirty = true; }
    if (typeof s.itemizePassThroughs !== 'boolean') { s.itemizePassThroughs = DEFAULTS.itemizePassThroughs; dirty = true; }
    if (s.feeMode !== 'flat' && s.feeMode !== 'tiers') { s.feeMode = DEFAULTS.feeMode; dirty = true; }
    if (typeof s.learnTypedFares !== 'boolean') { s.learnTypedFares = DEFAULTS.learnTypedFares; dirty = true; }
    if (dirty) save();
  }

  /* ---------- (c) card fee: 0 unless cardPct > 0 ---------- */
  hook('cardFeeAmt', function (orig) {
    return function (fare) {
      var pct = Number(settings().cardPct) || 0;
      if (!(pct > 0)) return 0;                 // no Square bracket table by default — the owner sets a % in Settings
      return orig.apply(this, arguments);
    };
  });

  /* ---------- (d) fare learning only for engine-priced fares ---------- */
  hook('recordFare', function (orig) {
    return function () {
      if (settings().learnTypedFares === true) return orig.apply(this, arguments);
      var f = byId('d_fare');
      var auto = !!(f && f.dataset && f.dataset.auto);
      if (!auto) return;                        // typed override: a one-off, never the next book price
      return orig.apply(this, arguments);
    };
  });

  /* ---------- (e) manual Assign dropdown hides Off-duty drivers ----------
     driverOptions(true) builds the assign selects (board row, Book form, Edit overlay, Best driver).
     driverOptions(false) builds the Trip Records / Map "All drivers" filters: history of a driver who
     is Off-duty today must stay reachable, so those are left alone. */
  hook('driverOptions', function (orig) {
    return function (blank) {
      var html = orig.apply(this, arguments);
      if (blank !== true) return html;
      var off = (STATE.drivers || []).filter(function (d) { return d && d.active === false; });
      if (!off.length || typeof html !== 'string') return html;
      var sel = document.createElement('select'); sel.innerHTML = html;
      off.forEach(function (d) {
        var id = String(d.id);
        for (var i = 0; i < sel.options.length; i++) {
          var o = sel.options[i];
          if (o.value === id) { o.disabled = true; o.hidden = true; o.textContent = o.textContent + ' (off duty)'; }
        }
      });
      return sel.innerHTML;
    };
  });

  /* ---------- (b) airport tip estimate ---------- */
  function isAirportTrip(t) {
    t = findTrip(t); if (!t) return false;
    var ak = window.airportKey; if (typeof ak !== 'function') return false;
    try { return !!(ak(t.puAddr || '') || ak(t.doAddr || '')); } catch (e) { return false; }
  }
  function tipEstimateFor(t) { t = findTrip(t); if (!t || !isAirportTrip(t)) return 0; return Math.round((Number(t.fare) || 0) * 0.15); }
  function setEstimate(t, est) {
    var cur = Number(t.tipEstimate) || 0;
    if (est > 0) { if (cur !== est) { t.tipEstimate = est; return true; } return false; }
    if (t.tipEstimate != null) { delete t.tipEstimate; return true; }
    return false;
  }
  /* The Book form has no tip box: every tip #d_save writes is the 15% airport formula (or a carried-over
     value when the fare did not change). Capture phase remembers the context; the bubble listener runs
     after the console's own handler and moves the formula tip to tipEstimate. */
  var saveCtx = null;
  function dSaveBefore() {
    var eid = null; try { eid = (typeof editingId !== 'undefined') ? editingId : null; } catch (e) { eid = null; }
    var prev = eid ? findTrip(eid) : null;
    saveCtx = { editId: eid, seq: Number(STATE.dispatchSeq), prev: prev ? { fare: Number(prev.fare) || 0, tip: Number(prev.tip) || 0 } : null };
  }
  function dSaveAfter() {
    var ctx = saveCtx; saveCtx = null; if (!ctx) return;
    var t, changed = false;
    if (ctx.editId) {
      t = findTrip(ctx.editId); if (!t) return;
      if (ctx.prev && (Number(t.fare) || 0) !== ctx.prev.fare) {
        // the fare changed: the console recomputed the tip from the formula (or zeroed it) — put the human tip back
        if ((Number(t.tip) || 0) !== ctx.prev.tip) { t.tip = ctx.prev.tip; changed = true; }
      }
      if (setEstimate(t, tipEstimateFor(t))) changed = true;
    } else {
      if (Number(STATE.dispatchSeq) !== ctx.seq + 1) return;      // nothing was booked (validation stopped the handler)
      t = trips().filter(function (x) { return Number(x.dispatchNo) === ctx.seq; })[0]; if (!t) return;
      if (setEstimate(t, tipEstimateFor(t))) changed = true;
      if ((Number(t.tip) || 0) !== 0) { t.tip = 0; changed = true; }  // nobody typed a tip on a new booking
    }
    if (changed) save();
  }
  function hookBookForm() {
    var b = byId('d_save'); if (!b || b.__fixesTip) return;
    b.__fixesTip = true;
    b.addEventListener('click', act(dSaveBefore), true);
    b.addEventListener('click', act(dSaveAfter), false);
  }
  /* The board Edit overlay (saveEditOvl) has its own Tip box, so whatever it writes to t.tip is the
     human's number; only the estimate has to follow the new fare. closeEditOvl() nulls editOvlId
     inside the original, so the id is read first. */
  hook('saveEditOvl', function (orig) {
    return function () {
      var id = null; try { id = (typeof editOvlId !== 'undefined') ? editOvlId : null; } catch (e) { id = null; }
      var out = orig.apply(this, arguments);
      try { var t = id ? findTrip(id) : null; if (t && setEstimate(t, tipEstimateFor(t))) save(); } catch (e) {}
      return out;
    };
  });
  /* One-time move of formula tips already on file: airport trip, tip equals round(fare × 15%), not invoiced, not paid. */
  function migrateTips() {
    var s = settings(); if (s.fixesTipMigratedAt) return 0;
    var n = 0;
    trips().forEach(function (t) {
      if (!t || !isAirportTrip(t)) return;
      var tip = Number(t.tip) || 0; if (!(tip > 0)) return;
      if (t.invoiceNo || (t.payment && t.payment.status === 'paid')) return;
      if (tip !== Math.round((Number(t.fare) || 0) * 0.15)) return;
      t.tipEstimate = tip; t.tip = 0; n++;
    });
    s.fixesTipMigratedAt = nowISO();
    save();
    return n;
  }

  /* ---------- (f) Port Authority fee + itemised pass-throughs ---------- */
  function rates() { try { if (typeof NYCFARE !== 'undefined' && NYCFARE && NYCFARE.RATES) return NYCFARE.RATES; } catch (e) {} try { return (window.NYCFARE && window.NYCFARE.RATES) || null; } catch (e) { return null; } }
  function applyPaFee() { var R = rates(); if (R && R.airports) R.airports.fhvAirportFee = paFee(); return paFee(); }
  var MANHATTAN = /\b(MANHATTAN|MIDTOWN|SOHO|TRIBECA|CHELSEA|TIMES SQ|TIMES SQUARE|HARLEM|UPPER EAST|UPPER WEST|PENN STATION|GRAND CENTRAL|PORT AUTHORITY|JAVITS|WALL ST|FINANCIAL DISTRICT|BATTERY PARK|GREENWICH VILLAGE|EAST VILLAGE|WEST VILLAGE|GRAMERCY|MURRAY HILL|KIPS BAY|FLATIRON|NOHO|NOLITA|CHINATOWN|LOWER EAST SIDE|HELL'?S KITCHEN|HUDSON YARDS|ROCKEFELLER|LINCOLN CENTER|COLUMBUS CIRCLE|WASHINGTON HEIGHTS|INWOOD|MORNINGSIDE)\b/;
  var BELOW_60 = /\b(MIDTOWN|SOHO|TRIBECA|CHELSEA|TIMES SQ|TIMES SQUARE|PENN STATION|GRAND CENTRAL|PORT AUTHORITY|JAVITS|WALL ST|FINANCIAL DISTRICT|BATTERY PARK|GREENWICH VILLAGE|EAST VILLAGE|WEST VILLAGE|GRAMERCY|MURRAY HILL|KIPS BAY|FLATIRON|NOHO|NOLITA|CHINATOWN|LOWER EAST SIDE|HELL'?S KITCHEN|HUDSON YARDS|ROCKEFELLER|COLUMBUS CIRCLE)\b/;
  function both(t) { return String((t.puAddr || '') + ' | ' + (t.doAddr || '') + ' | ' + ((t.stops || []).map(function (s) { return s && (s.addr || s); }).join(' | '))).toUpperCase(); }
  /* Pass-through fees already inside an all-in fare. Shown on receipts only when itemizePassThroughs is on. */
  function passThroughs(t) {
    t = findTrip(t); if (!t) return [];
    var R = rates() || {}, out = [], b = both(t);
    if (isAirportTrip(t)) out.push({ key: 'paFee', label: 'Airport access fee (Port Authority)', amount: paFee() });
    if (MANHATTAN.test(b)) {
      var cs = Number(R.nysCongestionSurcharge && R.nysCongestionSurcharge.fhvStandard); if (!isFinite(cs)) cs = 2.75;
      out.push({ key: 'congestion', label: 'NYS congestion surcharge (Manhattan below 96 St)', amount: round2(cs) });
      if (BELOW_60.test(b)) {
        var crz = Number(R.crzPerTripCharge && R.crzPerTripCharge.fhvStandard); if (!isFinite(crz)) crz = 0.75;
        out.push({ key: 'crz', label: 'MTA Congestion Relief Zone charge (below 60 St)', amount: round2(crz) });
      }
    }
    return out;
  }
  var TOTAL_ROW = '<tr><td style="padding:3px 8px;font-weight:700;">TOTAL</td>';
  function injectPassThroughs(html, t) {
    if (typeof html !== 'string' || html.indexOf(TOTAL_ROW) < 0) return html;
    var lines = passThroughs(t); if (!lines.length) return html;
    var rows = lines.map(function (l) {
      return '<tr class="fx-pass"><td style="padding:1px 8px 1px 18px;color:#555;font-size:12px;">incl. ' + esc(l.label) + '</td><td style="padding:1px 8px;text-align:right;color:#555;font-size:12px;">$' + l.amount.toFixed(2) + '</td></tr>';
    }).join('');
    return html.replace(TOTAL_ROW, rows + TOTAL_ROW);
  }
  hook('printReceiptById', function (orig) {
    return function (id) {
      var t = findTrip(id), op = window.openPrint, self = this, args = arguments;
      if (!t || settings().itemizePassThroughs !== true || typeof op !== 'function') return orig.apply(self, args);
      window.openPrint = function (html) { window.openPrint = op; return op.call(this, injectPassThroughs(html, t)); };
      try { return orig.apply(self, args); } finally { window.openPrint = op; }
    };
  });

  /* ---------- (g) Settings card "Money defaults" ---------- */
  var PANEL_ID = 'fixesMoneyDefaults';
  function ensureStyle() {
    if (byId('fixesStyle')) return;
    var st = document.createElement('style'); st.id = 'fixesStyle';
    st.textContent = [
      '.fx-panel .fx-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 14px;}',
      '.fx-panel .fx-check{display:flex;flex-direction:row;align-items:center;gap:8px;} .fx-panel .fx-check input{width:auto;} .fx-panel .fx-check .lbl{margin:0;font-weight:600;}',
      '.fx-panel .fx-hint{font-size:11px;color:var(--muted,#5b5b5b);margin:2px 0 0;}',
      '.fx-panel .fx-tiers{margin-top:6px;} .fx-panel .fx-tiers table{font-size:12px;}',
      '.fx-panel .fx-status{margin-top:6px;}',
      'body.classic .fx-panel .panel-head .hint{color:#dbe4f3;}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  function tiersHtml() {
    var tiers = settings().feeTiers;
    if (!Array.isArray(tiers) || !tiers.length) return '<div class="fx-hint">No tier table yet — the quote module publishes one. Flat fees apply until then.</div>';
    var keys = [];
    tiers.forEach(function (r) { if (r && typeof r === 'object' && !Array.isArray(r)) Object.keys(r).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); });
    var h = '<div class="tbl-scroll" style="max-height:200px;"><table class="data"><thead><tr>';
    if (keys.length) h += keys.map(function (k) { return '<th>' + esc(k) + '</th>'; }).join('');
    else h += '<th>Tier</th><th>Values</th>';
    h += '</tr></thead><tbody>';
    tiers.forEach(function (r, i) {
      if (keys.length && r && typeof r === 'object' && !Array.isArray(r)) h += '<tr>' + keys.map(function (k) { var v = r[k]; return '<td>' + esc(v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v)) + '</td>'; }).join('') + '</tr>';
      else h += '<tr><td>' + (i + 1) + '</td><td>' + esc(Array.isArray(r) ? r.join(' / ') : String(r)) + '</td></tr>';
    });
    return h + '</tbody></table></div><div class="fx-hint">Read only — published by the quote module.</div>';
  }
  function panelHtml() {
    return '<div class="panel-head">Money defaults <span class="hint" style="margin:0;font-weight:400;">Saved on this station (and to Cloud when on)</span></div>'
      + '<div class="panel-body">'
      + '<div class="fx-grid">'
      + '<label class="fld"><span class="lbl">Automatic gratuity on Account rides (%)</span><input type="number" step="0.5" min="0" max="100" id="fx_grat"><div class="fx-hint">0 = none until an account asks. Only Account rides. (An account\'s own value, when set, wins.)</div></label>'
      + '<label class="fld"><span class="lbl">No-show fee rule</span><select id="fx_ns_mode"><option value="base">Base fare (default)</option><option value="flat">Flat amount</option><option value="pct">Percent of fare</option><option value="none">No fee</option></select><div class="fx-hint">Charged only when the dispatcher presses "Charge no-show fee" in Money, only with a card on file. Never automatic.</div></label>'
      + '<label class="fld" id="fx_ns_amount_w"><span class="lbl">No-show flat amount ($)</span><input type="number" step="1" min="0" id="fx_ns_amount"></label>'
      + '<label class="fld" id="fx_ns_pct_w"><span class="lbl">No-show percent of fare (%)</span><input type="number" step="5" min="0" max="100" id="fx_ns_pct"></label>'
      + '<label class="fld"><span class="lbl">Card hold at booking (&times; estimate)</span><input type="number" step="0.05" min="1" max="1.5" id="fx_hold"><div class="fx-hint">1.2 = estimate + 20%, released when the final charge is smaller. Allowed 1.0 to 1.5.</div></label>'
      + '<label class="fld"><span class="lbl">Airport access fee, Port Authority ($)</span><input type="number" step="0.25" min="0" id="fx_pafee"><div class="fx-hint">Built into airport quotes (all-in). Feeds the NYC fare calculator too.</div></label>'
      + '<label class="fld"><span class="lbl">Fee mode</span><select id="fx_feemode"><option value="flat">Flat (default)</option><option value="tiers">Tiers</option></select><div class="fx-hint">Tiers arrive with the quote module; flat until then.</div></label>'
      + '</div>'
      + '<label class="fld fx-check" style="margin-top:8px;"><input type="checkbox" id="fx_itemize"><span class="lbl">Show pass-through fees as lines on receipts (airport access fee, congestion surcharge, MTA zone charge)</span></label>'
      + '<div class="fx-hint">Off = quote and print all-in (the default). On = the receipt lists them as "incl." lines; the total does not change.</div>'
      + '<label class="fld fx-check" style="margin-top:8px;"><input type="checkbox" id="fx_learn"><span class="lbl">Remember typed fares as book prices</span></label>'
      + '<div class="fx-hint">Off (default): only fares the engine priced are remembered for next time. A fare typed over the book price is a one-off.</div>'
      + '<div class="fx-tiers" id="fx_tiers"></div>'
      + '<div class="btn-row" style="margin-top:10px;"><button class="btn btn-go" type="button" id="fx_save">Save money defaults</button></div>'
      + '<div class="hint fx-status" id="fx_status"></div>'
      + '</div>';
  }
  function nsModeVis() {
    var m = (byId('fx_ns_mode') || {}).value || 'base';
    var a = byId('fx_ns_amount_w'), p = byId('fx_ns_pct_w');
    if (a) a.style.display = m === 'flat' ? '' : 'none';
    if (p) p.style.display = m === 'pct' ? '' : 'none';
  }
  function syncPanel() {
    var s = settings();
    var set = function (id, v) { var el = byId(id); if (el) el.value = v; };
    set('fx_grat', Number(s.autoGratuityPct) || 0);
    var ns = (s.noShowFee && typeof s.noShowFee === 'object') ? s.noShowFee : { mode: 'base' };
    set('fx_ns_mode', /^(base|flat|pct|none)$/.test(ns.mode) ? ns.mode : 'base');
    set('fx_ns_amount', ns.amount != null ? Number(ns.amount) || 0 : '');
    set('fx_ns_pct', ns.pct != null ? Number(ns.pct) || 0 : '');
    set('fx_hold', clampHold(s.holdFactor));
    set('fx_pafee', paFee().toFixed(2));
    set('fx_feemode', s.feeMode === 'tiers' ? 'tiers' : 'flat');
    var it = byId('fx_itemize'); if (it) it.checked = s.itemizePassThroughs === true;
    var lf = byId('fx_learn'); if (lf) lf.checked = s.learnTypedFares === true;
    var tw = byId('fx_tiers'); if (tw) { tw.innerHTML = (s.feeMode === 'tiers' || (Array.isArray(s.feeTiers) && s.feeTiers.length)) ? tiersHtml() : ''; }
    nsModeVis();
  }
  function savePanel() {
    var s = settings();
    var v = function (id) { var el = byId(id); return el ? String(el.value || '').trim() : ''; };
    var grat = Number(v('fx_grat')); if (!isFinite(grat) || grat < 0) grat = 0; if (grat > 100) grat = 100;
    var mode = v('fx_ns_mode'); if (!/^(base|flat|pct|none)$/.test(mode)) mode = 'base';
    var ns = { mode: mode };
    if (mode === 'flat') { var raw = v('fx_ns_amount'), amt = Number(raw); if (raw === '' || !isFinite(amt) || !(amt > 0)) { toast('Enter the flat no-show amount in dollars (more than 0), or pick "No fee".', true); return false; } ns.amount = round2(amt); }
    if (mode === 'pct') { var pct = Number(v('fx_ns_pct')); if (!isFinite(pct) || pct <= 0 || pct > 100) { toast('Enter the no-show percent (1 to 100).', true); return false; } ns.pct = pct; }
    var hold = Number(v('fx_hold')); if (!isFinite(hold)) hold = DEFAULTS.holdFactor;
    var clamped = clampHold(hold);
    var paRaw = v('fx_pafee'), pa = Number(paRaw); if (paRaw === '' || !isFinite(pa) || pa < 0) { toast('Enter the airport access fee in dollars (0 or more).', true); return false; }
    s.autoGratuityPct = grat;
    s.noShowFee = ns;
    s.holdFactor = clamped;
    s.paFee = round2(pa);
    s.itemizePassThroughs = !!(byId('fx_itemize') && byId('fx_itemize').checked);
    s.feeMode = v('fx_feemode') === 'tiers' ? 'tiers' : 'flat';
    s.learnTypedFares = !!(byId('fx_learn') && byId('fx_learn').checked);
    applyPaFee();
    save();
    syncPanel();
    var st = byId('fx_status'); if (st) st.textContent = 'Saved. Gratuity ' + grat + '% · no-show: ' + (mode === 'base' ? 'base fare' : mode === 'flat' ? '$' + ns.amount : mode === 'pct' ? ns.pct + '% of fare' : 'no fee') + ' · hold ×' + clamped + (clamped !== hold ? ' (kept inside 1.0–1.5)' : '') + ' · airport fee $' + s.paFee.toFixed(2) + ' · ' + (s.itemizePassThroughs ? 'receipts itemise pass-throughs' : 'receipts all-in') + ' · fees ' + s.feeMode + '.';
    toast('Money defaults saved.' + (clamped !== hold ? ' Hold kept inside 1.0–1.5.' : ''));
    try { if (window.Money && typeof window.Money.render === 'function') window.Money.render(); } catch (e) {}
    try { if (typeof window.updateReadout === 'function') window.updateReadout(); } catch (e) {}
    return true;
  }
  function render() {
    if (POPOUT) return;
    var view = byId('view-settings'); if (!view) return;
    ensureStyle();
    var p = byId(PANEL_ID);
    if (!p) {
      p = document.createElement('div'); p.id = PANEL_ID; p.className = 'panel fx-panel';
      p.innerHTML = panelHtml();
      view.appendChild(p);
      var bs = byId('fx_save'); if (bs) bs.addEventListener('click', act(savePanel));
      var nm = byId('fx_ns_mode'); if (nm) nm.addEventListener('change', act(nsModeVis));
      var fm = byId('fx_feemode'); if (fm) fm.addEventListener('change', act(function () { var tw = byId('fx_tiers'); if (tw) tw.innerHTML = (fm.value === 'tiers' || (Array.isArray(settings().feeTiers) && settings().feeTiers.length)) ? tiersHtml() : ''; }));
    }
    syncPanel();
  }

  /* ---------- account editor: "Card on file" toggle (accounts[].cardOnFile, read by money.js hasCard) ---------- */
  var acctCtx = null;
  function acctField() { return byId('fx_a_cardOnFile'); }
  function injectAccountField() {
    if (acctField()) return;
    var notes = byId('a_notes'); if (!notes) return;
    var host = notes.closest ? notes.closest('label.fld') : null; if (!host || !host.parentNode) return;
    var lab = document.createElement('label'); lab.className = 'fld fx-check'; lab.id = 'fx_a_cardOnFile_w';
    lab.innerHTML = '<input type="checkbox" id="fx_a_cardOnFile" style="width:auto;"><span class="lbl" style="margin:0;font-weight:600;">Card on file &mdash; lets the dispatcher charge the no-show fee on this account\'s rides</span>';
    host.parentNode.insertBefore(lab, host.nextSibling);
    var bs = byId('a_save');
    if (bs && !bs.__fixesCard) {
      bs.__fixesCard = true;
      bs.addEventListener('click', act(function () { acctCtx = { id: String((byId('a_id') || {}).value || ''), n: accounts().length, on: !!acctField().checked }; }), true);
      bs.addEventListener('click', act(function () {
        var ctx = acctCtx; acctCtx = null; if (!ctx) return;
        var a = null;
        if (ctx.id) a = accounts().filter(function (x) { return x && x.id === ctx.id; })[0] || null;
        else if (accounts().length > ctx.n) a = accounts()[accounts().length - 1];
        if (!a) return;                                     // the console refused the save (number / name missing)
        if (!!a.cardOnFile !== ctx.on) { a.cardOnFile = ctx.on; save(); }
      }), false);
    }
    var bc = byId('a_clear'); if (bc && !bc.__fixesCard) { bc.__fixesCard = true; bc.addEventListener('click', act(function () { var f = acctField(); if (f) f.checked = false; })); }
  }
  hook('editAccount', function (orig) {
    return function (id) {
      var out = orig.apply(this, arguments);
      try { var a = accounts().filter(function (x) { return x && x.id === id; })[0]; var f = acctField(); if (f) f.checked = !!(a && a.cardOnFile); } catch (e) {}
      return out;
    };
  });
  hook('clearAccountForm', function (orig) {
    return function () { var out = orig.apply(this, arguments); try { var f = acctField(); if (f) f.checked = false; } catch (e) {} return out; };
  });

  /* ---------- re-render hooks ---------- */
  function hookAfter(name, after) {
    hook(name, function (orig) { return function () { var out; try { out = orig.apply(this, arguments); } finally { try { after(); } catch (e) {} } return out; }; });
  }

  /* ---------- public API ---------- */
  window.Fixes = {
    _loaded: true, render: render, passThroughs: passThroughs, tipEstimateFor: tipEstimateFor, isAirportTrip: isAirportTrip,
    paFee: paFee, applyPaFee: applyPaFee, clampHold: clampHold, defaults: JSON.parse(JSON.stringify(DEFAULTS)), migrateTips: migrateTips
  };

  /* ---------- boot ---------- */
  function boot() {
    try { ensureDefaults(); } catch (e) {}
    try { migrateTips(); } catch (e) {}
    try { applyPaFee(); } catch (e) {}
    // The Call Entry / Active Board / Wall Board pop-outs (?screen=entry|board|wallboard) show the full
    // dispatch view with the live Book Trip button, so the tip hook and the account field go wherever
    // their anchors exist (byId guards). Only the Settings card stays on the main console page.
    try { hookBookForm(); } catch (e) {}
    try { injectAccountField(); } catch (e) {}
    hookAfter('renderAccounts', injectAccountField);
    if (!POPOUT) {
      try { render(); } catch (e) {}
      hookAfter('renderSettings', render);
    }
    // selects already on the board were built before this file loaded
    try { if (typeof window.refreshBoard === 'function') window.refreshBoard(); } catch (e) {}
    try { if (typeof window.updateReadout === 'function') window.updateReadout(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
