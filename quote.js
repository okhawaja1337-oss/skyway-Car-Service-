/* ======================================================================
   Skyway — quote.js
   Versioned fare table, quote object on every booking, deviation approval,
   pricing fixes, settlement fee tiers, rates.json export, "Retained per ride".
   Plan build row 5 (TURNAROUND-PLAN §7) + the pricing fixes (pricing.md §2.3, §3.4).

   STATE keys owned here:
     STATE.rates = the ACTIVE rate version:
       {version, name, engine:'legacy'|'v2', status:'active', effectiveAt, filedWithTlcAt,
        belowFiledAck, createdAt, activatedAt, zones[], grid (16x16 array, symmetric, aligned
        with zones[]), flats{area20, airport{LGA,JFK,EWR}, airportPickupAdd, nassauWest},
        addOns{paFee, govManhattan, onDemand{queens,outBoro,leadHours}, scheduledExempt, rush,
        night, xboroAdd, vtypeAdd, waiting, extraStop, noShow, returnLegPct, waitAndReturnX,
        programLocal}, meter{base,perMile,perMinute,min}, tiers[{upTo,fee}],
        history:[earlier versions], draft: version being edited | null}
     trips[].quote = {id, rateVersion, components[{key,label,amount}], total, source:
       'engine'|'override'|'manual', kind, engineTotal, deviation, approvedBy, approvedAt,
       reason, at}
     settings.quoteDeviationLimit {abs:5, pct:15} · settings.feeMode 'flat'|'tiers' (default
       'flat', the Settings card lives in fixes.js) · settings.feeTiers (published from the
       active version) · settings.paFee (3.50).

   Version 1 is seeded from the console's own engine values and runs the console's own
   functions untouched (engine 'legacy'), so nothing changes until the owner activates a
   version with engine 'v2' (the "proposed" preset). Under 'v2' the wrappers below take over:
   suggestZone (airport first, neighbourhood keywords before street keywords, BRIARWOOD / QHC
   hints), zoneFare (grid from the active version, airport flats + PA fee, Manhattan government
   charges, both-ends-Boro-book → larger midpoint), fareFor (grid), estFare (fallback meter),
   skySurcharge (on-demand only; scheduled ≥ leadHours exempt).

   Under 'v2' the filed table is binding: it is priced BEFORE the farebook / ROUTEBOOK / street / caller lookups
   (those only fill routes the table does not cover), table prices are not learned into the farebook, and a new
   draft always runs 'v2'. A 'legacy' version mirrors the console's own matrix / rate card (synced when they are
   edited). A trip edited with its fare untouched keeps its quote whatever the active version (a quoted price is
   binding, 59B-23).

   The price check never trusts d_fare.dataset.auto: Calculate Fare (Google meter) sets it too, so any fare $1 or more
   away from the book price is judged like a typed one (under $1 = the console's whole-dollar rounding). With Fee mode =
   tiers the Business tab's base revenue / break-even use the tier fees (renderBiz wrapper), and the NYC meter's PA fee
   (NYCFARE.RATES.airports.fhvAirportFee) is a live accessor on settings.paFee.

   Owner-only actions (new version, activate, export, price changes beyond the limit) ask for the admin PIN
   (settings.adminPin, the same 4-digit PIN simple.js uses for Settings / Expert mode). On a station with no PIN
   set they are refused (one confirm offers to open Settings) — never self-approved.
   Plain ES2019, no build step, no network. Works with Cloud off. Never edits index.html.
   Public API: window.Quote (see the bottom of the file).
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;
  if (window.Quote && window.Quote._loaded) return;

  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }

  /* ---------- helpers (own copies; console globals may be missing) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[quote] ' + m); } catch (e) {} }
  function save() { if (typeof window.save === 'function') { try { window.save(); return; } catch (e) {} } if (typeof window.saveNow === 'function') { try { window.saveNow(); } catch (e) {} } }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  function trips() { return Array.isArray(STATE.trips) ? STATE.trips : []; }
  function findTrip(id) { if (id && typeof id === 'object') return id; return trips().filter(function (t) { return t && t.id === id; })[0] || null; }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function whole(n) { return Math.round(Number(n) || 0); }
  function money(n) { if (typeof window.money === 'function') { try { return window.money(n); } catch (e) {} } return '$' + (Number(n) || 0).toFixed(2); }
  function nowISO() { return new Date().toISOString(); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayStr() { if (typeof window.todayStr === 'function') { try { return window.todayStr(); } catch (e) {} } var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function copy(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { try { console.error('[quote]', err); } catch (e2) {} } }; }
  function up(s) { return String(s || '').toUpperCase(); }
  function fmtAmt(n) { n = Number(n) || 0; return (n % 1 ? n.toFixed(2) : String(n)); }
  function uid() { return 'Q-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(); }
  function g(name) { var f = window[name]; return typeof f === 'function' ? f : null; }
  function callG(name) { var f = g(name); if (!f) return null; try { return f.apply(null, Array.prototype.slice.call(arguments, 1)); } catch (e) { return null; } }

  /* Wrap a console global: keep the original as wrapper._orig, mark __quoteWrapped, call through. */
  var ORIG = {};
/* keep the inner wrappers' marker flags (e.g. __fixesWrapped) visible on the outermost function */
  function inheritFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_{1,2}\w*Wrapped$/.test(k) && w[k] === undefined) w[k] = orig[k]; }); } catch (e) {} return w; }
  function hook(name, make) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__quoteWrapped) return false;
    ORIG[name] = orig;
    var wrapped = make(orig);
    wrapped.__quoteWrapped = true; wrapped._orig = orig; inheritFlags(wrapped, orig);
    window[name] = wrapped;
    return true;
  }
  function hookAfter(name, after) { hook(name, function (orig) { return function () { var out; try { out = orig.apply(this, arguments); } finally { try { after(); } catch (e) {} } return out; }; }); }

  /* ---------- defaults ---------- */
  var TIERS_DEFAULT = [{ upTo: 15, fee: 4.5 }, { upTo: 34, fee: 6.5 }, { upTo: 59, fee: 8.5 }, { upTo: null, fee: 11 }];
  var DEV_DEFAULT = { abs: 5, pct: 15 };
  var SQUARE = { keyed: { pct: 0.035, fixed: 0.15 }, tap: { pct: 0.026, fixed: 0.15 } };
  var RETAINED_FLOOR = 5.51;

  function ensureSettings() {
    var s = settings(), dirty = false;
    if (!s.quoteDeviationLimit || typeof s.quoteDeviationLimit !== 'object') { s.quoteDeviationLimit = copy(DEV_DEFAULT); dirty = true; }
    if (s.feeMode !== 'flat' && s.feeMode !== 'tiers') { s.feeMode = 'flat'; dirty = true; }
    if (!Array.isArray(s.feeTiers) || !s.feeTiers.length) { s.feeTiers = copy((STATE.rates && STATE.rates.tiers) || TIERS_DEFAULT); dirty = true; }
    if (s.paFee == null || !isFinite(Number(s.paFee))) { s.paFee = 3.50; dirty = true; }
    if (dirty) save();
  }
  function paFee() { var v = Number(settings().paFee); return (isFinite(v) && v >= 0) ? round2(v) : 3.50; }
  /* NYCFARE.RATES.airports.fhvAirportFee (Fare Estimate tab / NYC meter) follows Settings.paFee live: the property becomes
     an accessor that reads settings.paFee on every use, so a later change in the Settings card (fixes.js) needs no reload.
     A write to it (fixes.js applyPaFee does one at boot) lands in settings.paFee, so both views always agree. */
  function applyPaFee() {
    try {
      var R = (typeof NYCFARE !== 'undefined' && NYCFARE && NYCFARE.RATES) ? NYCFARE.RATES : (window.NYCFARE && window.NYCFARE.RATES);
      if (!R || !R.airports) return;
      var A = R.airports, desc = Object.getOwnPropertyDescriptor(A, 'fhvAirportFee');
      if (desc && desc.get && desc.get.__quoteLive) return;                       // already live (idempotent)
      if (desc && desc.configurable === false) { try { A.fhvAirportFee = paFee(); } catch (e) {} return; }   // sealed object: set once
      var getter = function () { return paFee(); }; getter.__quoteLive = true;
      Object.defineProperty(A, 'fhvAirportFee', {
        get: getter,
        set: function (v) { v = Number(v); if (isFinite(v) && v >= 0 && Math.abs(round2(v) - paFee()) >= 0.005) { settings().paFee = round2(v); save(); } },
        enumerable: true, configurable: true
      });
    } catch (e) {}
  }
  function devLimit() { var l = settings().quoteDeviationLimit || {}; var abs = Number(l.abs), pct = Number(l.pct); return { abs: isFinite(abs) && abs >= 0 ? abs : DEV_DEFAULT.abs, pct: isFinite(pct) && pct >= 0 ? pct : DEV_DEFAULT.pct }; }
  function limitFor(engineTotal) { var l = devLimit(); return round2(Math.max(l.abs, (Number(engineTotal) || 0) * l.pct / 100)); }
  function exceeds(dev, engineTotal) { return Math.abs(Number(dev) || 0) > limitFor(engineTotal) + 0.0001; }

  /* ---------- rate versions ---------- */
  function zonesSnapshot() { return (STATE.zones || []).map(function (z) { return { id: z.id, name: z.name, a20: !!z.a20 }; }); }
  function gridFromFares(zones) {
    var ff = ORIG.fareFor || window.fareFor;
    return zones.map(function (a) { return zones.map(function (b) { var v = null; try { v = ff(a.id, b.id); } catch (e) { v = null; } return v == null ? null : Number(v); }); });
  }
  /* The console's own prices as a version body: zone matrix (STATE.fares), flats and rate card from Settings. */
  function legacyParts() {
    var s = settings(), rate = s.rate || {}, ap = rate.airport || {}, zones = zonesSnapshot();
    var apFlat = Number(s.airportFlat) || 38;
    return {
      zones: zones, grid: gridFromFares(zones),
      flats: { area20: Number(s.area20Flat) || 12, airport: { LGA: apFlat, JFK: apFlat, EWR: Number(ap.EWR) || 110 }, airportPickupAdd: 0, nassauWest: null },
      meter: { base: Number(rate.base) || 0, perMile: Number(rate.perMile) || 0, perMinute: Number(rate.perMinute) || 0, min: Number(rate.min) || 0, booking: Number(rate.booking) || 0 }
    };
  }
  function seedVersion1() {
    var s = settings(), p = legacyParts();
    return {
      version: 1, name: 'Current console prices', engine: 'legacy', status: 'active', effectiveAt: todayStr(), filedWithTlcAt: null, belowFiledAck: null, createdAt: nowISO(), activatedAt: nowISO(),
      zones: p.zones, grid: p.grid,
      flats: p.flats,
      addOns: { paFee: 0, govManhattan: 0, rush: { queens: 2.5, outBoroLow: 5, outBoroHigh: 8, outBoroThreshold: 40 }, night: { queens: 1, outBoroLow: 5, outBoroHigh: 8, outBoroThreshold: 40 }, onDemand: null, scheduledExempt: false, xboroAdd: Number(s.xboroAdd) || 0, vtypeAdd: copy(s.vtypeAdd || {}), waiting: null, extraStop: null, noShow: null, returnLegPct: 0, waitAndReturnX: 0, programLocal: null },
      meter: p.meter,
      tiers: copy(TIERS_DEFAULT)
    };
  }
  /* A 'legacy' version IS the console's own matrix / rate card: when the owner edits those (Zone Price Book cells,
     "Save Rate Card & Flats"), the stored snapshot and rates.json follow, so the export never disagrees with the console. */
  var syncing = false;
  function syncLegacy() {
    if (syncing) return false;
    var V = STATE.rates; if (!V || V.engine === 'v2' || !Array.isArray(V.grid)) return false;
    syncing = true;
    try {
      var p = legacyParts(), changed = false;
      ['zones', 'grid', 'flats', 'meter'].forEach(function (k) { if (JSON.stringify(V[k]) !== JSON.stringify(p[k])) { V[k] = p[k]; changed = true; } });
      if (changed) { V.syncedAt = nowISO(); save(); }
      return changed;
    } catch (e) { return false; } finally { syncing = false; }
  }
  /* The plan's proposed card (pricing.md §3.1, §3.3; pricing_tables.md). Upper triangle, zone ids 1..16. */
  var PROPOSED_ROWS = [
    [13, 23, 25, 15, 13, 15, 27, 42, 31, 30, 30, 32.5, 35.5, 106.5, 65, 38],
    [16, 25, 29, 21, 23, 22, 33, 38, 19, 39, 32.5, 49, 106.5, 65, 42],
    [16, 30, 27, 34, 35, 48, 25, 24, 45, 35, 48.5, 111.5, 65, 38],
    [13, 15, 15, 32, 46, 32, 37, 27, 32.5, 35.5, 106.5, 65, 38],
    [13, 15, 23, 38, 35, 29, 29, 32.5, 35.5, 106.5, 65, 41],
    [13, 18, 32, 42, 32, 27, 32.5, 35.5, 106.5, 65, 48],
    [16, 25, 47, 29, 33, 32.5, 48, 106.5, 65, 52],
    [16, 61, 37, 45, 32.5, 61.5, 106.5, 65, 65],
    [16, 38, 48, 49, 44.5, 122.5, 75, 38],
    [16, 48, 32.5, 56.5, 106.5, 65, 41],
    [16, 44.5, 35.5, 106.5, 65, 54],
    [16, null, null, null, null],
    [16, null, null, null],
    [16, null, null],
    [16, null],
    [16]
  ];
  function proposedGrid(zones) {
    var n = zones.length, grid = [], i, j;
    for (i = 0; i < n; i++) { grid.push([]); for (j = 0; j < n; j++) grid[i].push(null); }
    for (i = 0; i < n; i++) for (j = i; j < n; j++) {
      var a = zones[i].id, b = zones[j].id, lo = Math.min(a, b), hi = Math.max(a, b);
      var row = PROPOSED_ROWS[lo - 1], v = (row && lo >= 1 && lo <= 16 && hi <= 16) ? row[hi - lo] : null;
      grid[i][j] = grid[j][i] = (v == null ? null : v);
    }
    return grid;
  }
  function proposedPreset() {
    var zones = zonesSnapshot(), s = settings();
    var vt = Object.assign({ 'Sedan': 0, 'SUV Standard': 0, 'SUV XL': 10, 'Minivan': 10, 'Van': 10, 'Sprinter': 20, 'Mini-Bus': 25, 'Bus': 40, 'School Bus': 40, 'Wheelchair Van': 15 }, copy(s.vtypeAdd || {}));
    return {
      version: nextVersionNo(), name: 'Proposed rate card (plan §3)', engine: 'v2', status: 'draft', effectiveAt: '', filedWithTlcAt: null, belowFiledAck: null, createdAt: nowISO(), activatedAt: null,
      zones: zones, grid: proposedGrid(zones),
      flats: { area20: 13, adjacent: 15, airport: { LGA: 32.5, JFK: 35.5, EWR: 106.5 }, airportPickupAdd: 5, manhattan: 65, nassauWest: 42 },
      addOns: {
        paFee: paFee(), govManhattan: 3.50, onDemand: { queens: 2.5, outBoro: 5, leadHours: 2, when: 'weekdays 4-8 pm or 8 pm-6 am, booked under 2 h ahead' }, scheduledExempt: true,
        rush: null, night: null, xboroAdd: Number(s.xboroAdd) || 0, vtypeAdd: vt,
        waiting: { freeMin: 5, freeMinScheduled: 10, airportFreeDomestic: 45, airportFreeInternational: 60, perMin: 0.60, blockMin: 5 },
        extraStop: { sameZone: 5, other: 8 }, noShow: { local: 10, airportManhattan: 20 },
        returnLegPct: 10, waitAndReturnX: 1.5, programLocal: 11
      },
      meter: { base: 8, perMile: 2.60, perMinute: 0.45, min: 13, booking: 0 },
      tiers: copy(TIERS_DEFAULT)
    };
  }
  function stripVersion(v) { var o = copy(v); delete o.history; delete o.draft; return o; }
  function ensureRates() {
    var r = STATE.rates;
    if (!r || typeof r !== 'object' || !r.version || !Array.isArray(r.grid)) {
      var v1 = seedVersion1(); v1.history = (r && Array.isArray(r.history)) ? r.history : []; v1.draft = null;
      STATE.rates = v1; save();
    }
    if (!Array.isArray(STATE.rates.history)) STATE.rates.history = [];
    if (STATE.rates.draft === undefined) STATE.rates.draft = null;
    if (!STATE.rates.engine) STATE.rates.engine = 'legacy';
    return STATE.rates;
  }
  function active() { return ensureRates(); }
  function legacy() { return active().engine !== 'v2'; }
  function nextVersionNo() { var r = STATE.rates || {}; var m = Number(r.version) || 0; (r.history || []).forEach(function (h) { m = Math.max(m, Number(h.version) || 0); }); if (r.draft) m = Math.max(m, Number(r.draft.version) || 0); return m + 1; }
  function zoneIndex(V, id) { var z = V.zones || []; for (var i = 0; i < z.length; i++) if (Number(z[i].id) === Number(id)) return i; return -1; }
  function gridPrice(V, a, b) { var i = zoneIndex(V, a), j = zoneIndex(V, b); if (i < 0 || j < 0) return null; var row = V.grid[i] || []; var v = row[j]; if (v == null) { v = (V.grid[j] || [])[i]; } return v == null ? null : Number(v); }
  function zoneRec(id) { return (STATE.zones || []).filter(function (z) { return Number(z.id) === Number(id); })[0] || null; }
  function isA20(id) { var z = zoneRec(id); return !!(z && z.a20); }
  function zoneName(id) { var z = zoneRec(id); return z ? z.name : ''; }
  var AIRPORT_ZONE = { LGA: 12, JFK: 13, EWR: 14 };
  function airportOfZone(id) { id = Number(id); for (var k in AIRPORT_ZONE) if (AIRPORT_ZONE[k] === id) return k; return null; }

  /* ---------- owner PIN (settings.adminPin — same PIN simple.js uses for Settings / Expert mode) ---------- */
  function hasPin() { return /^\d{4}$/.test(String(settings().adminPin || '').trim()); }
  /* No owner PIN on this station: every owner-only action here is refused (the whole control rests on the PIN).
     One confirm() offers to open Settings, where the PIN is set (Settings → Simple mode → Admin PIN). */
  function noPinGate(what) {
    var go = false;
    what = what || 'this owner action';
    try { go = window.confirm('No owner PIN is set on this station, so this is locked: ' + what + '.\nOpen Settings to set the owner PIN now?'); } catch (e) { go = false; }
    if (go) { try { if (window.Simple && typeof window.Simple.enter === 'function') window.Simple.enter('settings'); else callG('goTab', 'settings'); } catch (e) {} }
    toast('Locked until the owner PIN is set (Settings → Simple mode → Admin PIN): ' + what + '.', true);
    return false;
  }
  /* recover.js: a signed-in owner (or an owner PIN already given to recover.js this session) is not asked again */
  function recoverOwner() { try { var R = window.Recover; return !!(R && R._loaded && typeof R.who === 'function' && R.who() && R.role() === 'owner'); } catch (e) { return false; } }
  function ownerPin(what) {
    if (recoverOwner()) return true;
    var pin = String(settings().adminPin || '').trim();
    if (!hasPin()) return noPinGate(what);
    var a = null;
    try { a = window.prompt('Owner PIN needed' + (what ? ' to ' + what : '') + '. Enter the 4-digit admin PIN:', ''); } catch (e) { a = null; }
    if (a === null) return false;
    if (String(a).trim() === pin) return true;
    toast('Wrong PIN.', true); return false;
  }

  /* ---------- pricing fixes: zone hints (v2 only) ---------- */
  var EXTRA_HINTS = [['BRIARWOOD', 5], ['QUEENS HOSPITAL CENTER', 5], ['QUEENS HOSPITAL', 5], ['QHC', 5], ['JAMAICA CENTER', 4], ['ARCHER AVE', 4]];
  var STREET_RE = /\b(ST|AVE|BLVD|RD|PKWY|EXPY|EXPWY|TPKE|PL|DR|LN|CT|TER|HWY)$/;
  function isStreetHint(kw) { kw = up(kw).trim(); return /^\d{5}$/.test(kw) || STREET_RE.test(kw) || /^\d+\s/.test(kw); }
  function v2SuggestZone(addr) {
    var A = up(addr); if (!A) return null;
    var ak = callG('airportKey', addr); if (ak && AIRPORT_ZONE[ak] && zoneRec(AIRPORT_ZONE[ak])) return AIRPORT_ZONE[ak];
    var i, h, hints = STATE.hints || [];
    for (i = 0; i < EXTRA_HINTS.length; i++) if (A.indexOf(EXTRA_HINTS[i][0]) >= 0 && !isStreetHint(EXTRA_HINTS[i][0]) && zoneRec(EXTRA_HINTS[i][1])) return EXTRA_HINTS[i][1];
    for (i = 0; i < hints.length; i++) { h = hints[i]; if (h && h.kw && !isStreetHint(h.kw) && A.indexOf(h.kw) >= 0) return h.zone; }       // neighbourhood keywords first
    for (i = 0; i < EXTRA_HINTS.length; i++) if (A.indexOf(EXTRA_HINTS[i][0]) >= 0 && isStreetHint(EXTRA_HINTS[i][0]) && zoneRec(EXTRA_HINTS[i][1])) return EXTRA_HINTS[i][1];
    for (i = 0; i < hints.length; i++) { h = hints[i]; if (h && h.kw && isStreetHint(h.kw) && A.indexOf(h.kw) >= 0) return h.zone; }        // then street keywords
    return null;
  }
  hook('suggestZone', function (orig) { return function (addr) { if (legacy()) return orig.apply(this, arguments); return v2SuggestZone(addr); }; });

  /* ---------- pricing fixes: zone fare from the active version (v2 only) ---------- */
  function bookHit(a) { var r = callG('bkFind', a); if (!r) r = callG('geoBookLookup', a); return r || null; }
  function bookResult(bk) { return { fare: bk.mid, label: 'Boro book: ' + bk.name + (bk.lo === bk.hi ? ' (flat $' + bk.lo + ')' : ' ($' + bk.lo + '–$' + bk.hi + ' range)'), components: [{ key: 'fare', label: 'Boro book: ' + bk.name, amount: round2(bk.mid) }], kind: 'book' };
  }
  function mk(comps, label, kind) { var t = 0; comps.forEach(function (c) { t += Number(c.amount) || 0; }); return { fare: round2(t), label: label, components: comps, kind: kind || 'grid' }; }
  function v2ZoneFare(pu, doo) {
    var V = active(), za = v2SuggestZone(pu), zb = v2SuggestZone(doo);
    var bkA = bookHit(pu), bkB = bookHit(doo);
    if (za && zb) {
      var apA = airportOfZone(za), apB = airportOfZone(zb);
      if (apA || apB) {
        if (apA && apB) { var gg = gridPrice(V, za, zb); return gg == null ? null : mk([{ key: 'fare', label: 'Rate book: ' + zoneName(za) + ' → ' + zoneName(zb), amount: gg }], 'Rate book v' + V.version + ': ' + zoneName(za) + ' → ' + zoneName(zb)); }
        var key = apA || apB, other = apA ? zb : za, comps = [], base = null, lab;
        var flat = (V.flats && V.flats.airport) ? V.flats.airport[key] : null;
        if (isA20(other) && flat != null) { base = Number(flat); lab = 'Airport flat ' + key + ' (20 area)'; }
        else { base = gridPrice(V, za, zb); lab = 'Rate book: ' + zoneName(za) + ' → ' + zoneName(zb); if (base == null && flat != null) { base = Number(flat); lab = 'Airport flat ' + key; } }
        if (base == null) return null;
        comps.push({ key: 'fare', label: lab, amount: round2(base) });
        var pick = Number(V.flats && V.flats.airportPickupAdd) || 0;
        if (apA && pick) comps.push({ key: 'airportPickup', label: 'Airport pickup (meet at terminal)', amount: round2(pick) });
        // the version says WHETHER the PA fee is added on top (addOns.paFee > 0); the amount is always Settings.paFee
        var pa = (V.addOns && Number(V.addOns.paFee) > 0) ? paFee() : 0;
        if (pa > 0) comps.push({ key: 'paFee', label: 'Airport access fee (Port Authority)', amount: pa });
        var label = 'Rate book v' + V.version + ': ' + comps.map(function (c) { return c.label + ' $' + fmtAmt(c.amount); }).join(' + ');
        return mk(comps, label, 'grid');
      }
      var gp = gridPrice(V, za, zb);
      if (gp == null && za === zb && isA20(za) && V.flats && V.flats.area20 != null) gp = Number(V.flats.area20);
      if (gp == null) return null;
      var c2 = [], nass = Number(V.flats && V.flats.nassauWest) || 0;
      if ((za === 16 || zb === 16) && nass && gp < nass) gp = nass;
      var lab2 = (za === zb && isA20(za)) ? '20 Area flat' : 'Rate book: ' + zoneName(za) + ' → ' + zoneName(zb);
      c2.push({ key: 'fare', label: lab2, amount: round2(gp) });
      var gov = Number(V.addOns && V.addOns.govManhattan) || 0;
      if ((za === 15 || zb === 15) && gov) c2.push({ key: 'govManhattan', label: 'NYS congestion surcharge + MTA zone charge', amount: round2(gov) });
      return mk(c2, 'Rate book v' + V.version + ': ' + c2.map(function (c) { return c.label + ' $' + fmtAmt(c.amount); }).join(' + '), 'grid');
    }
    if (bkB && !bkA && za && (isA20(za) || za === 1)) return bookResult(bkB);
    if (bkA && !bkB && zb && (isA20(zb) || zb === 1)) return bookResult(bkA);
    if (bkA && bkB) return bookResult(bkA.mid >= bkB.mid ? bkA : bkB);     // both ends in the Boro book: the larger midpoint
    return null;
  }
  hook('zoneFare', function (orig) { return function (pu, doo) { if (legacy()) return orig.apply(this, arguments); return v2ZoneFare(pu, doo); }; });
  hook('fareFor', function (orig) { return function (a, b) { if (legacy()) return orig.apply(this, arguments); if (!a || !b) return null; return gridPrice(active(), a, b); }; });
  hook('estFare', function (orig) {
    return function (rate, miles, minutes, ap) {
      if (legacy()) return orig.apply(this, arguments);
      var V = active(), m = V.meter || {};
      if (ap && V.flats && V.flats.airport && V.flats.airport[ap] != null) return Math.round(Number(V.flats.airport[ap]) + paFee());
      var f = (Number(m.base) || 0) + (Number(m.perMile) || 0) * (Number(miles) || 0) + (Number(m.perMinute) || 0) * (Number(minutes) || 0) + (Number(m.booking) || 0);
      return Math.round(Math.max(f, Number(m.min) || 0));
    };
  });
  /* Out of borough (v2). The console's outOfQueens() counts every Boro-book hit, Queens neighbourhoods included
     (Briarwood, Flushing…), so it over-charges local rides; here only the other boroughs, NJ and Nassau count. */
  var OUT_RE = /\b(BROOKLYN|BRONX|MANHATTAN|STATEN ISLAND|NASSAU|NEWARK|EWR|NEW JERSEY|VALLEY STREAM|GREAT NECK|NEW HYDE PARK|ELMONT|FRANKLIN SQUARE|HEMPSTEAD|LONG ISLAND\b(?! CITY))\b/;
  function v2OutOfQueens(a) {
    var A = up(a).trim(); if (!A) return false;
    if (OUT_RE.test(A)) return true;
    var z = v2SuggestZone(A); if (z === 14 || z === 15 || z === 16) return true;
    if (z) return false;
    var bk = callG('bkFind', A); return !!(bk && !/^Queens\b/i.test(bk.name || ''));
  }
  /* On-demand surcharge only (v2): weekdays 4-8 pm or 8 pm-6 am, and only when the ride is booked under leadHours ahead. */
  function v2Surcharge(baseFare, pu, doo, dt) {
    dt = dt || new Date(); var V = active(), od = (V.addOns && V.addOns.onDemand) || { queens: 2.5, outBoro: 5, leadHours: 2 };
    var dow = dt.getDay(), h = dt.getHours();
    var rush = (dow >= 1 && dow <= 5 && h >= 16 && h < 20), night = (h >= 20 || h < 6);
    if (!rush && !night) return { amt: 0, label: '' };
    var leadMin = (dt.getTime() - Date.now()) / 60000;
    if (V.addOns && V.addOns.scheduledExempt && leadMin >= (Number(od.leadHours) || 0) * 60) return { amt: 0, label: '' };
    var outQ = v2OutOfQueens(pu) || v2OutOfQueens(doo), amt;
    if (!(V.addOns && V.addOns.onDemand)) {
      // a version copied from the console's own rules (no on-demand table): keep its rush / night amounts
      var L = (V.addOns && (rush ? V.addOns.rush : V.addOns.night)) || od;
      amt = round2(outQ ? ((Number(baseFare) || 0) >= (Number(L.outBoroThreshold) || 40) ? (L.outBoroHigh != null ? L.outBoroHigh : L.outBoro) : (L.outBoroLow != null ? L.outBoroLow : L.outBoro)) : L.queens);
      if (!amt) return { amt: 0, label: '' };
      return { amt: amt, label: ' + $' + fmtAmt(amt) + ' ' + (rush ? 'rush-hour' : 'overnight') + (outQ ? ' (out of boro)' : '') };
    }
    amt = round2(outQ ? od.outBoro : od.queens);
    if (!amt) return { amt: 0, label: '' };
    return { amt: amt, label: ' + $' + fmtAmt(amt) + ' on-demand ' + (rush ? 'rush-hour' : 'overnight') + (outQ ? ' (out of boro)' : '') };
  }
  hook('skySurcharge', function (orig) { return function (baseFare, pu, doo, dt) { if (legacy()) return orig.apply(this, arguments); return v2Surcharge(baseFare, pu, doo, dt); }; });

  /* ---------- learned prices vs the filed table (v2) ----------
     The console's maybeAutoFare() asks routeFare → caller → streetFare before zoneFare. Under a v2 version the
     table must win, so while the console prices the form (and the table has a price for the ride) those three
     lookups answer null. Scoped to that one call: the route book UI, CTI pop-ups etc. still see the learned prices. */
  var SUPPRESS_LEARNED = false;
  ['routeFare', 'streetFare', 'lookupCaller'].forEach(function (n) { hook(n, function (orig) { return function () { if (SUPPRESS_LEARNED) return null; return orig.apply(this, arguments); }; }); });
  function tableHasPrice(pu, doo) { if (legacy() || !pu || !doo) return false; var z = null; try { z = v2ZoneFare(pu, doo); } catch (e) { z = null; } return !!(z && Number(z.fare) > 0); }

  /* ---------- engine quote (pure: reads the engine, never writes the form) ---------- */
  function formState() {
    var stops = [];
    try { if (typeof dispatchStops !== 'undefined' && Array.isArray(dispatchStops)) stops = dispatchStops.filter(function (s) { return s && String(s.addr || '').trim(); }).map(function (s) { return { addr: String(s.addr).trim() }; }); } catch (e) { stops = []; }
    var dt = null; try { dt = callG('bookDT'); } catch (e) { dt = null; }
    return {
      pu: String((byId('d_puAddr') || {}).value || '').trim(), doo: String((byId('d_doAddr') || {}).value || '').trim(), stops: stops,
      vtype: String((byId('d_vtype') || {}).value || 'SUV Standard'), rt: !!(byId('d_rt') && byId('d_rt').checked), dt: dt || new Date(),
      phone: String((byId('d_phone') || {}).value || '')
    };
  }
  function engineQuote(f) {
    if (!f || !f.pu || !f.doo) return null;
    var stops = f.stops || [], comps = [], base = null, kind = '', label = '', xb = false, zf = null, v2 = !legacy();
    var useZf = function (z) { base = z.fare; kind = z.kind || (v2 ? 'grid' : 'zone'); label = z.label; xb = false; if (z.components) comps = copy(z.components); };
    // Under a v2 version the filed table is binding: it is priced first; learned / historic prices only fill routes the table does not cover.
    if (v2) { zf = callG('zoneFare', f.pu, f.doo); if (zf) useZf(zf); }
    if (base == null) {
      var rf = (SUPPRESS_LEARNED ? null : callG('routeFare', f.pu, f.doo, stops));
      if (rf && !rf.hist) { base = rf.fare; kind = 'learned'; label = 'Your set price for this route'; xb = true; }
      else if (rf && rf.hist) { base = callG('adjustHist', rf.fare); kind = 'historic'; label = 'Historic record for this route'; xb = true; }
      else {
        var ku = (f.phone && !SUPPRESS_LEARNED) ? callG('lookupCaller', f.phone) : null;
        if (ku && ku.f) { base = callG('adjustHist', +ku.f); kind = 'caller'; label = "Caller's usual fare"; xb = true; }
        else {
          var sf = (!stops.length && !SUPPRESS_LEARNED) ? callG('streetFare', f.pu, f.doo) : null;
          if (sf) { base = sf.fare; kind = 'street'; label = 'Learned price book: ' + sf.a + ' → ' + sf.b; xb = true; }
          else if (!v2 && !stops.length) { zf = callG('zoneFare', f.pu, f.doo); if (zf) useZf(zf); }
        }
      }
    }
    if (base == null || !(Number(base) > 0)) return null;
    base = Number(base);
    if (!comps.length) comps.push({ key: 'fare', label: label, amount: round2(base) });
    var one = whole(base), baseAmt = whole(f.rt ? base * 2 : base);          // mirrors setF() in maybeAutoFare: whole dollars
    if (f.rt) comps.push({ key: 'roundTrip', label: 'Round trip ×2', amount: round2(baseAmt - one) });
    var rnd = round2(one - base); if (rnd) comps.push({ key: 'rounding', label: 'Rounded to whole dollar', amount: rnd });
    var isAp = !!(callG('airportKey', f.pu) || callG('airportKey', f.doo));
    var add = (xb && !isAp && (callG('outOfQueens', f.pu) || callG('outOfQueens', f.doo))) ? Math.round(Number(settings().xboroAdd) || 0) : 0;   // mirrors setF() (the console's own test, both engines)
    if (add) comps.push({ key: 'xboro', label: 'Cross-borough', amount: add });
    var va = Math.round(Number((settings().vtypeAdd || {})[f.vtype]) || 0);
    if (va) comps.push({ key: 'vtype', label: f.vtype, amount: va });
    var sur = callG('skySurcharge', baseAmt + add + va, f.pu, f.doo, f.dt) || { amt: 0, label: '' };
    if (sur.amt) comps.push({ key: 'surcharge', label: String(sur.label || 'Surcharge').replace(/^\s*\+\s*\$[\d.]+\s*/, '').trim() || 'Surcharge', amount: round2(sur.amt) });
    if (!legacy() && stops.length && kind === 'grid') {
      var ex = (active().addOns || {}).extraStop || { sameZone: 5, other: 8 }, zp = v2SuggestZone(f.pu), zd = v2SuggestZone(f.doo);
      stops.forEach(function (s, i) { var zs = v2SuggestZone(s.addr); var same = zs && (zs === zp || zs === zd); var amt = round2(same ? ex.sameZone : ex.other); if (amt) comps.push({ key: 'stop', label: 'Extra stop ' + (i + 1) + (same ? ' (same zone)' : ''), amount: amt }); });
    }
    var total = 0; comps.forEach(function (c) { total += Number(c.amount) || 0; });
    return { components: comps, total: round2(total), kind: kind, label: label, rateVersion: active().version, engine: active().engine };
  }
  function tripForm(t, pu, doo) {
    var dt = callG('pickupDT', t) || new Date();
    return { pu: pu != null ? pu : (t.puAddr || ''), doo: doo != null ? doo : (t.doAddr || ''), stops: (t.stops || []).map(function (s) { return { addr: s.addr || s }; }), vtype: t.vtype || 'SUV Standard', rt: !!t.rt, dt: dt, phone: t.phone || '' };
  }

  /* ---------- quote objects ---------- */
  function newQuote(eq, typed, extra) {
    var q = { id: uid(), rateVersion: eq ? eq.rateVersion : active().version, components: eq ? copy(eq.components) : [{ key: 'typed', label: 'Typed fare', amount: round2(typed) }], total: eq ? eq.total : round2(typed), source: 'engine', kind: eq ? eq.kind : 'manual', engineTotal: eq ? eq.total : null, deviation: 0, approvedBy: null, approvedAt: null, reason: '', at: nowISO() };
    if (extra) Object.assign(q, extra);
    return q;
  }
  function overrideQuote(eq, typed, approval, auto) {
    var dev = round2(typed - eq.total);
    var comps = copy(eq.components); comps.push({ key: 'override', label: auto ? 'Auto-filled estimate differs from the rate book' : 'Dispatcher price change', amount: dev });
    return newQuote(eq, typed, { components: comps, total: round2(typed), source: 'override', deviation: dev, approvedBy: approval ? approval.approvedBy : null, approvedAt: approval ? approval.approvedAt : null, reason: approval ? approval.reason : '' });
  }
  function manualQuote(typed) { return newQuote(null, typed, { source: 'manual', kind: 'manual' }); }
  /* Owner PIN + reason for a typed fare outside the deviation limit. Returns the approval or null (refused). */
  function approveOverride(dev, engineTotal, typed) {
    var lim = limitFor(engineTotal), abs = Math.abs(dev);
    var msg = typed ? 'Fare $' + fmtAmt(typed) + ' is $' + fmtAmt(abs) + ' ' + (dev > 0 ? 'above' : 'below') + ' the rate book price $' + fmtAmt(engineTotal) + ' (allowed: $' + fmtAmt(lim) + ').'
      : 'No fare typed, but the rate book price is $' + fmtAmt(engineTotal) + '. Booking at $0 means the price is set later.';
    if (!hasPin()) { noPinGate('booking a price outside the rate book limit'); return { noPin: true }; }   // no owner PIN on this station: refused, never self-approved
    var pin = String(settings().adminPin || '').trim(), ok = false, a;
    try { a = window.prompt(msg + '\nOwner PIN needed to book this price:', ''); } catch (e) { a = null; }
    ok = (a !== null && String(a).trim() === pin);
    if (a !== null && !ok) toast('Wrong PIN.', true);
    if (!ok) return null;
    var reason = null; try { reason = window.prompt('Reason for the price change (required, goes on the quote):', ''); } catch (e) { reason = null; }
    if (!reason || !String(reason).trim()) return null;
    return { approvedBy: 'owner', approvedAt: nowISO(), reason: String(reason).trim().slice(0, 200) };
  }
  function refuse(dev, engineTotal, typed) {
    if (!typed) { toast('Not saved: no fare typed, but the rate book price is ' + money(engineTotal) + '. Use that price, or the owner PIN + a reason to book at $0.', true); return; }
    toast('Price change refused: $' + fmtAmt(Math.abs(dev)) + ' ' + (dev > 0 ? 'over' : 'under') + ' the rate book price ' + money(engineTotal) + ' needs the owner PIN and a reason. The trip was not saved.', true);
  }
  /* The standing price of a trip whose fare is not being changed: recorded, never blocked. */
  function standingQuote(eq, typed, reason) {
    if (!eq) return manualQuote(typed);
    var d0 = round2(typed - eq.total);
    if (Math.abs(d0) < 0.005) return newQuote(eq, typed);
    var q0 = overrideQuote(eq, typed, null); q0.reason = reason; return q0;
  }
  /* Decide the quote for a fare the dispatcher is about to save. Returns {quote} or {refused:true}.
     `auto` (d_fare.dataset.auto) only says the console filled the field; it never skips the price check: Calculate Fare
     (the Google-routed meter) sets the same flag, and that estimate can be far from the book price. Only a gap under $1
     is the console's own whole-dollar rounding of an engine price with cents. */
  /* routeKey(f): what the quoted price depends on — a changed route is a new ride, so the standing quote no longer applies */
  function routeKey(f) { if (!f) return ''; return [up(f.pu), up(f.doo), (f.stops || []).map(function (s) { return up(s && s.addr != null ? s.addr : s); }).join('|'), String(f.vtype || ''), f.rt ? 'rt' : ''].join('#'); }
  function decide(typed, auto, eq, prev, routeChanged) {
    if (prev && Number(prev.fare) === typed && !routeChanged) {
      // Editing a trip with its fare untouched: the price quoted to the customer is binding (TLC 59B-23), so it is
      // never re-judged against a later rate version. Time, driver, notes, addresses change freely.
      if (prev.quote && Math.abs(Number(prev.quote.total) - typed) < 0.005) return { quote: prev.quote };
      if (prev.quote) return { quote: standingQuote(eq, typed, 'fare changed outside quote tracking') };
      return { quote: standingQuote(eq, typed, 'fare set before quote tracking') };      // booked before the module
    }
    if (!eq) return { quote: manualQuote(typed) };
    var dev = round2(typed - eq.total);
    if (Math.abs(dev) < 0.005) return { quote: newQuote(eq, typed) };
    if (Math.abs(dev) < 1) {                         // the console books whole dollars: an engine price with cents lands on the next dollar
      var q = newQuote(eq, typed); q.components.push({ key: 'rounding', label: 'Rounded to whole dollar', amount: dev }); q.total = round2(typed); return { quote: q };
    }
    if (exceeds(dev, eq.total)) {
      var ap = approveOverride(dev, eq.total, typed);
      if (!ap || ap.noPin) { if (!ap) refuse(dev, eq.total, typed); return { refused: true }; }
      return { quote: overrideQuote(eq, typed, ap, auto) };
    }
    return { quote: overrideQuote(eq, typed, null, auto) };
  }

  /* ---------- Book form: quote line, save hooks ---------- */
  var pending = null, saveCtx = null;
  function quoteLine() {
    var ms = byId('d_meterStatus'); if (!ms || !ms.parentNode) return null;
    var el = byId('q_line'); if (!el) { el = document.createElement('div'); el.id = 'q_line'; el.className = 'hint q-line'; el.style.margin = '2px 0 6px'; ms.parentNode.insertBefore(el, ms.nextSibling); }
    return el;
  }
  function showQuoteLine() {
    var el = quoteLine(); if (!el) return;
    var f = byId('d_fare'), typed = f ? Number(f.value) || 0 : 0, auto = !!(f && f.dataset && f.dataset.auto);
    if (!pending || !typed) { el.textContent = ''; return; }
    var ed = editingTrip();
    if (ed && ed.quote && Number(ed.fare) === typed) { el.textContent = 'Quote ' + ed.quote.id + ' · rates v' + (ed.quote.rateVersion || '?') + ' kept — the fare is unchanged, so no price check on this update.'; return; }
    var dev = round2(typed - pending.total), V = active();
    var parts = pending.components.map(function (c) { return c.label + ' $' + fmtAmt(c.amount); }).join(' + ');
    var s = 'Rates v' + V.version + (V.engine === 'v2' ? '' : ' (current console prices)') + ' · book price $' + fmtAmt(pending.total) + ' = ' + parts + '.';
    // an auto-filled value under $1 away is the console's whole-dollar rounding; anything else (typed, or a meter estimate) is a price change
    if (Math.abs(dev) >= (auto ? 1 : 0.005)) s += ' ' + (auto ? 'Auto-filled' : 'Typed') + ' $' + fmtAmt(typed) + ' is $' + fmtAmt(Math.abs(dev)) + (dev > 0 ? ' over' : ' under') + (exceeds(dev, pending.total) ? ' — owner PIN + reason needed to book.' : ' (within the $' + fmtAmt(limitFor(pending.total)) + ' limit).');
    if (legacySurchargeOnScheduled(pending)) s += ' The rush / overnight add-on is the console\'s current rule; rate version 2 drops it for rides booked ' + leadHoursLabel() + ' or more ahead (owner: activate it in Rates & zones).';
    el.textContent = s;
  }
  /* legacy v1 adds the console's rush / out-of-boro add-on to a scheduled ride however far ahead it is booked (plan: scheduled = no add-on) */
  function leadHours() { var od = ((active().draft || proposedPreset()).addOns || {}).onDemand || {}; var h = Number(od.leadHours); return h > 0 ? h : 2; }
  function leadHoursLabel() { var h = leadHours(); return h + ' h'; }
  function legacySurchargeOnScheduled(q) {
    if (!legacy() || !q || !q.components) return false;
    if (!q.components.some(function (c) { return c.key === 'surcharge'; })) return false;
    var f = null; try { f = formState(); } catch (e) { f = null; }
    if (!f || !f.dt || isNaN(f.dt)) return false;
    return (f.dt.getTime() - Date.now()) / 3600000 >= leadHours();
  }
  function refreshPending() { try { pending = engineQuote(formState()); } catch (e) { pending = null; } showQuoteLine(); return pending; }
  hook('maybeAutoFare', function (orig) {
    return function () {
      var out, sup = false;
      try {
        var fe = byId('d_fare'), f0 = formState();
        var priceable = fe && (!(Number(fe.value) > 0) || !!fe.dataset.auto);
        if (priceable && tableHasPrice(f0.pu, f0.doo)) sup = true;     // v2: the table prices the form, not the farebook
      } catch (e) { sup = false; }
      SUPPRESS_LEARNED = sup;
      try { out = orig.apply(this, arguments); } finally { SUPPRESS_LEARNED = false; }
      try {
        var f = byId('d_fare'); var eq = refreshPending();
        // v2 prices a trip with stops from the grid + extra-stop add-ons; the console's own engine leaves those unpriced
        if (eq && f && !legacy() && !f.dataset.auto && !(Number(f.value) > 0) && (formState().stops.length)) {
          f.value = (eq.total % 1 ? eq.total.toFixed(2) : String(eq.total)); f.dataset.auto = '1'; f.dataset.rbase = String(whole(eq.components[0].amount));
          var ms = byId('d_meterStatus'); if (ms) ms.textContent = 'Rate book v' + active().version + ': ' + eq.components.map(function (c) { return c.label + ' $' + fmtAmt(c.amount); }).join(' + ') + ' = $' + fmtAmt(eq.total) + '. Type to override.';
          callG('updateReadout');
        }
      } catch (e) {}
      return out;
    };
  });
  hook('calcFare', function (orig) {
    return function () {
      var out = orig.apply(this, arguments);
      var done = function () {
        try {
          var f = byId('d_fare'); var typed = f ? Number(f.value) || 0 : 0;
          if (f && f.dataset.auto && typed > 0) {
            // the rate book still rules: when the meter estimate is $1 or more away from the book price the quote line (and the
            // save gate in decide()) judge the estimate against the book, exactly like a typed fare
            var eq = null; try { eq = engineQuote(formState()); } catch (e) { eq = null; }
            if (eq && Math.abs(round2(typed - eq.total)) >= 1) {
              pending = eq; showQuoteLine();
              if (exceeds(typed - eq.total, eq.total)) { var ms = byId('d_meterStatus'); if (ms) ms.textContent += ' ⚠ Rate book price is $' + fmtAmt(eq.total) + ' — booking $' + fmtAmt(typed) + ' needs the owner PIN + a reason.'; }
              return;
            }
            var ld = null; try { ld = (typeof lastDist !== 'undefined') ? lastDist : null; } catch (e) { ld = null; }
            var ap = callG('airportKey', (byId('d_doAddr') || {}).value) || callG('airportKey', (byId('d_puAddr') || {}).value);
            var lab = ap ? 'Airport flat ' + ap : 'Distance estimate' + (ld ? ' (' + Number(ld.miles).toFixed(1) + ' mi, ~' + Math.round(ld.minutes) + ' min)' : '');
            pending = { components: [{ key: 'fare', label: lab, amount: round2(typed) }], total: round2(typed), kind: 'meter', label: lab, rateVersion: active().version, engine: active().engine };
            showQuoteLine();
          }
        } catch (e) {}
      };
      if (out && typeof out.then === 'function') return out.then(function (v) { done(); return v; }, function (err) { done(); throw err; });
      done(); return out;
    };
  });
  hookAfter('clearDispatch', function () { pending = null; showQuoteLine(); });
  hookAfter('editTrip', function () { refreshPending(); });          // the quote line says whether the loaded trip's quote is kept
  function editingTrip() { try { return (typeof editingId !== 'undefined' && editingId) ? findTrip(editingId) : null; } catch (e) { return null; } }
  function dSaveBefore(e) {
    saveCtx = null;
    var f = formState(); if (!f.pu || !f.doo) return;           // the console's own handler toasts about the addresses
    var fe = byId('d_fare'), typed = fe ? Math.round(Number(fe.value) || 0) : 0, auto = !!(fe && fe.dataset && fe.dataset.auto);
    var eq = null; try { eq = engineQuote(f); } catch (err) { eq = null; }
    var prev = editingTrip();
    pending = eq; showQuoteLine();
    var routeChanged = false; try { routeChanged = !!prev && routeKey(f) !== routeKey(tripForm(prev)); } catch (err) { routeChanged = false; }
    var d = decide(typed, auto, eq, prev, routeChanged);
    if (d.refused) { e.stopImmediatePropagation(); e.preventDefault(); return; }
    // noLearn: under a v2 version a table price is the source of truth — nothing to learn, and the farebook stays the console's own (version 1 restores exactly)
    saveCtx = { editId: prev ? prev.id : null, seq: Number(STATE.dispatchSeq), quote: d.quote, override: d.quote.source === 'override' && !!d.quote.approvedAt, noLearn: !legacy() && (d.quote.kind === 'grid' || d.quote.kind === 'book') };
  }
  function dSaveAfter() {
    var ctx = saveCtx; saveCtx = null; if (!ctx) return;
    var t = null;
    if (ctx.editId) t = findTrip(ctx.editId);
    else { if (Number(STATE.dispatchSeq) !== ctx.seq + 1) return; t = trips().filter(function (x) { return Number(x.dispatchNo) === ctx.seq; })[0]; }
    if (!t) return;
    var q = ctx.quote; if (t.quote && t.quote.id === q.id) return;   // unchanged
    t.quote = q; save();
    try { if (byId('activeBoard') && typeof window.refreshBoard === 'function') window.refreshBoard(); } catch (e) {}
  }
  function hookBookForm() {
    var b = byId('d_save'); if (!b || b.__quoteHook) return;
    b.__quoteHook = true;
    b.addEventListener('click', act(dSaveBefore), true);
    b.addEventListener('click', act(dSaveAfter), false);
    var f = byId('d_fare'); if (f) f.addEventListener('input', act(showQuoteLine));
  }
  /* Approved deviations are never learned as the next book price (fixes.js already skips typed fares; this guards the approved case even with learnTypedFares on). */
  hook('recordFare', function (orig) { return function () { if (saveCtx && (saveCtx.override || saveCtx.noLearn)) return; return orig.apply(this, arguments); }; });

  /* ---------- edit overlay (eo_fare) ---------- */
  hook('saveEditOvl', function (orig) {
    return function () {
      var t = null; try { t = (typeof editOvlId !== 'undefined') ? findTrip(editOvlId) : null; } catch (e) { t = null; }
      var q = null;
      if (t) {
        var typed = Number(String((byId('eo_fare') || {}).value || '0').replace(/[^0-9.\-]/g, '')) || 0;
        var pu = String((byId('eo_pu') || {}).value || t.puAddr).trim(), doo = String((byId('eo_do') || {}).value || t.doAddr).trim();
        var eq = null; try { eq = engineQuote(tripForm(t, pu, doo)); } catch (e) { eq = null; }
        var routeChanged = false; try { routeChanged = routeKey(tripForm(t, pu, doo)) !== routeKey(tripForm(t)); } catch (e) { routeChanged = false; }
        var d = decide(typed, false, eq, t, routeChanged);
        if (d.refused) return;                       // nothing saved; the overlay stays open
        q = d.quote;
      }
      var out = orig.apply(this, arguments);
      if (t && q && (!t.quote || t.quote.id !== q.id)) { t.quote = q; save(); try { if (typeof window.refreshBoard === 'function') window.refreshBoard(); } catch (e) {} }
      return out;
    };
  });
  /* A doubled-up trip gets its own quote id (same components). */
  hook('duplicateTrip', function (orig) {
    return function (id) {
      var src = findTrip(id); var out = orig.apply(this, arguments);
      try { var c = trips()[0]; if (src && c && c.id !== src.id && c.quote && src.quote && c.quote.id === src.quote.id) { c.quote = Object.assign(copy(src.quote), { id: uid(), at: nowISO(), copiedFrom: src.quote.id }); save(); } } catch (e) {}
      return out;
    };
  });

  hook('classicDup', function (orig) {
    return function () {
      var src = null; try { src = (typeof classicSelId !== 'undefined') ? findTrip(classicSelId) : null; } catch (e) { src = null; }
      var out = orig.apply(this, arguments);
      try { if (src && src.quote) trips().forEach(function (c) { if (c !== src && c.quote && c.quote.id === src.quote.id) { c.quote = Object.assign(copy(src.quote), { id: uid(), at: nowISO(), copiedFrom: src.quote.id }); save(); } }); } catch (e) {}
      return out;
    };
  });

  /* ---------- quote id on receipt, invoice and board ---------- */
  function qtag(t) { return (t && t.quote && t.quote.id) ? ('Quote ' + t.quote.id + ' · rates v' + (t.quote.rateVersion || '?')) : ''; }
  hook('printReceiptById', function (orig) {
    return function (id) {
      var t = findTrip(id), op = window.openPrint, self = this, args = arguments;
      if (!t || !qtag(t) || typeof op !== 'function') return orig.apply(self, args);
      window.openPrint = function (html) {
        window.openPrint = op;
        try { if (typeof html === 'string') { var m = 'Call #' + t.dispatchNo; var i = html.indexOf(m); if (i >= 0) html = html.slice(0, i + m.length) + ' · ' + esc(qtag(t)) + html.slice(i + m.length); else html = html.replace('</table>', '</table><div style="text-align:center;font-size:12px;color:#444;">' + esc(qtag(t)) + '</div>'); } } catch (e) {}
        return op.call(this, html);
      };
      try { return orig.apply(self, args); } finally { window.openPrint = op; }
    };
  });
  hook('buildInvoiceHTML', function (orig) {
    return function (acct, list, due, invNo) {
      var html = orig.apply(this, arguments);
      try {
        if (typeof html === 'string' && Array.isArray(list)) {
          var cur = 0;
          list.forEach(function (t) {
            if (!t || !qtag(t)) return;
            var cell = '<td>' + esc(t.doAddr) + '</td>', i = html.indexOf(cell, cur); if (i < 0) return;
            var rep = '<td>' + esc(t.doAddr) + '<div class="hint" style="margin:0;font-size:10px;">' + esc(qtag(t)) + '</div></td>';
            html = html.slice(0, i) + rep + html.slice(i + cell.length); cur = i + rep.length;
          });
        }
      } catch (e) {}
      return html;
    };
  });
  hook('sheetRow', function (orig) {
    return function (t) {
      var html = orig.apply(this, arguments);
      try {
        if (t && t.quote && t.quote.id && typeof html === 'string') {
          var cell = '<td class="num">' + money(t.fare) + '</td>', i = html.indexOf(cell);
          if (i >= 0) html = html.slice(0, i) + '<td class="num" title="' + esc(qtag(t) + (t.quote.source === 'override' ? ' · price change ' + (t.quote.deviation > 0 ? '+' : '') + fmtAmt(t.quote.deviation) + (t.quote.reason ? ' — ' + t.quote.reason : '') : '')) + '">' + money(t.fare) + '<div class="hint q-id" style="margin:0;font-size:10px;white-space:nowrap;">' + esc(t.quote.id) + (t.quote.source === 'override' ? ' ⚠' : '') + '</div></td>' + html.slice(i + cell.length);
        }
      } catch (e) {}
      return html;
    };
  });

  /* ---------- fee tiers in settlement ---------- */
  function tiers() { var t = settings().feeTiers; if (!Array.isArray(t) || !t.length) t = (active().tiers && active().tiers.length) ? active().tiers : TIERS_DEFAULT; return t; }
  function tierFee(fare) {
    fare = Number(fare) || 0; var T = tiers().slice().sort(function (a, b) { var x = a.upTo == null ? Infinity : Number(a.upTo), y = b.upTo == null ? Infinity : Number(b.upTo); return x - y; });
    for (var i = 0; i < T.length; i++) { var u = T[i].upTo; if (u == null || fare <= Number(u) + 1e-9) return round2(T[i].fee); }
    return round2(T.length ? T[T.length - 1].fee : 0);
  }
  function tiersLabel() { return tiers().map(function (t) { return '$' + fmtAmt(t.fee) + (t.upTo == null ? ' over' : ' to $' + fmtAmt(t.upTo)); }).join(' · '); }
  hook('driverSettlement', function (orig) {
    return function (from, to) {
      var r = orig.apply(this, arguments);
      try {
        if (settings().feeMode !== 'tiers' || !r || !Array.isArray(r.rows)) return r;
        var live = trips().filter(function (t) { return t.date >= from && t.date <= to && t.status !== 'Canceled' && t.status !== 'Disregard' && t.status !== 'No-Show'; });
        r.rows.forEach(function (row) {
          var ts = live.filter(function (t) { return t.driverId === row.d.id; });
          var tierSum = 0; ts.forEach(function (t) { tierSum += tierFee(t.fare); });
          var week = (Number(row.d.feeWeek) || 0) * r.days / 7, pct = (Number(row.fares) || 0) * (Number(row.d.feePct) || 0) / 100;
          row.flatBaseOwed = row.baseOwed; row.tierFees = round2(tierSum);
          row.baseOwed = round2(week + tierSum + pct); row.take = round2((Number(row.fares) || 0) - row.baseOwed); row.feeMode = 'tiers';
        });
        r.feeMode = 'tiers';
      } catch (e) {}
      return r;
    };
  });
  /* Business tab: the console's renderBiz() multiplies completed calls by settings.baseFeePerCall (base-fee revenue,
     break-even calls, net). With Fee mode = tiers that rate is, for the length of the call, the month's average tier fee
     over its completed trips (so base revenue = the sum of the tier fees), and the KPI label says so. Nothing is saved. */
  function tierAverage(ym) {
    var sum = 0, n = 0;
    trips().forEach(function (t) { if (t && t.status === 'Completed' && String(t.date || '').indexOf(ym) === 0) { sum += tierFee(t.fare); n++; } });
    return { sum: round2(sum), n: n, avg: n ? sum / n : null };
  }
  hook('renderBiz', function (orig) {
    return function () {
      if (settings().feeMode !== 'tiers') return orig.apply(this, arguments);
      var s = settings(), had = Object.prototype.hasOwnProperty.call(s, 'baseFeePerCall'), keep = s.baseFeePerCall;
      var ym = String(callG('bizYM') || new Date().toISOString().slice(0, 7)), ta = tierAverage(ym);
      if (ta.avg != null) s.baseFeePerCall = round2(ta.avg);
      var out, br = byId('b_rate'), brBefore = br ? String(br.value) : null;
      try { out = orig.apply(this, arguments); }
      finally {
        if (had) s.baseFeePerCall = keep; else delete s.baseFeePerCall;
        // the console fills an empty #b_rate from baseFeePerCall: put the owner's real rate back so a change event never saves the average
        try { if (br && brBefore === '' && ta.avg != null) br.value = had && keep != null && keep !== '' ? String(keep) : ''; } catch (e) {}
      }
      try {
        // one label in both fee modes: "Base-fee revenue — Fees owed (modeled...)"; ledger.js writes the flat-rate form ("@ $6.04"), this is the tiers form
        var k = byId('bizKpis'); if (k) k.querySelectorAll('.hint').forEach(function (h) { if (/^Base-fee revenue|^Fees owed/.test(h.textContent || '')) h.textContent = 'Base-fee revenue — Fees owed (modeled, fee tiers' + (ta.n ? ': ' + tiersLabel() + ' — ' + money(ta.sum) + ' over ' + ta.n + ' calls' : ', no completed calls yet') + ')'; });
        var kp = k && Array.prototype.filter.call(k.children, function (c) { return /^Base-fee revenue/.test((c.querySelector('.hint') || {}).textContent || ''); })[0];
        if (kp && ta.n) { var v = kp.querySelector('div'); if (v) v.textContent = money(ta.sum); }
      } catch (e) {}
      return out;
    };
  });
  hookAfter('renderEarnings', function () {
    var out = byId('ern_out'); if (!out || POPOUT) return;
    var old = byId('q_ern_note'); if (old) old.remove();
    var n = document.createElement('div'); n.id = 'q_ern_note'; n.className = 'hint'; n.style.marginTop = '4px';
    n.textContent = settings().feeMode === 'tiers' ? 'Base fee by fare tier (Settings → Money defaults → Fee mode: tiers): ' + tiersLabel() + '. The per-trip fee on each driver is replaced by the tier; weekly and percent fees still apply.' : 'Fee mode: flat (each driver’s own per-trip / weekly / percent fee). Tiers are available in Settings → Money defaults.';
    out.appendChild(n);
  });

  /* ---------- "Retained per ride" on the Book readout ---------- */
  function squareCost(amount, payType) {
    if (payType !== 'card' && payType !== 'Credit Card') return 0;
    var k = settings().squareRate === 'tap' ? SQUARE.tap : SQUARE.keyed;
    return round2((Number(amount) || 0) * k.pct + k.fixed);
  }
  function retained(fare, payType, tolls) {
    fare = Number(fare) || 0; if (!(fare > 0)) return null;
    var mode = settings().feeMode === 'tiers' ? 'tiers' : 'flat';
    var fee = mode === 'tiers' ? tierFee(fare) : round2(Number(settings().baseFeePerCall) || 0);
    var sq = squareCost(fare + (Number(tolls) || 0), payType);
    var ret = round2(fee - sq);
    return { fee: fee, square: sq, retained: ret, mode: mode, warn: ret < RETAINED_FLOOR, floor: RETAINED_FLOOR };
  }
  function retainedLine() {
    var brk = document.querySelector('#view-dispatch .readout .break'); if (!brk || !brk.parentNode) return null;
    var el = byId('q_retained'); if (!el) { el = document.createElement('div'); el.id = 'q_retained'; el.className = 'hint q-retained'; el.style.margin = '6px 0 0'; brk.parentNode.insertBefore(el, brk.nextSibling); }
    return el;
  }
  function renderRetained() {
    var el = retainedLine(); if (!el) return;
    var fare = Number((byId('d_fare') || {}).value) || 0, tolls = Number((byId('d_tolls') || {}).value) || 0, pay = String((byId('d_account') || {}).value || 'cash');
    var r = retained(fare, pay === 'card' ? 'card' : (pay === 'cash' ? 'cash' : 'account'), tolls);
    if (!r) { el.textContent = ''; el.classList.remove('q-warn'); return; }
    el.textContent = 'Retained per ride: ' + money(r.retained) + ' (' + (r.mode === 'tiers' ? 'tier fee ' : 'base fee ') + money(r.fee) + (r.square ? ' − Square ' + money(r.square) : (pay === 'card' ? '' : ' · no card cost')) + ')' + (r.warn ? ' — below the $' + r.floor.toFixed(2) + ' target' : '');
    el.classList.toggle('q-warn', !!r.warn);
  }
  hookAfter('updateReadout', renderRetained);

  /* ---------- matrix notice (v2: the grid comes from the version, not the matrix cells) ---------- */
  hookAfter('renderMatrix', function () {
    var w = byId('matrixWrap'); if (!w) return;
    var old = byId('q_matrix_note'); if (old) old.remove();
    if (legacy()) return;
    w.querySelectorAll('input').forEach(function (i) { i.disabled = true; });
    var n = document.createElement('div'); n.id = 'q_matrix_note'; n.className = 'notice'; n.style.marginBottom = '6px';
    n.textContent = 'Prices shown are rate version ' + active().version + ' (the filed table). Change them in "Fare table versions" below, then activate the new version.';
    w.insertBefore(n, w.firstChild);
  });

  /* ---------- export ---------- */
  function exportRates() { syncLegacy(); var o = stripVersion(active()); o.exportedAt = nowISO(); o.paFee = paFee(); o.feeMode = settings().feeMode; o.deviationLimit = devLimit(); return o; }
  function downloadRates() {
    var o = exportRates(), txt = JSON.stringify(o, null, 2);
    if (typeof window.download === 'function') { try { window.download('rates.json', txt, 'application/json'); toast('rates.json (version ' + o.version + ') downloaded.'); return true; } catch (e) {} }
    try { var a = document.createElement('a'); a.href = 'data:application/json,' + encodeURIComponent(txt); a.download = 'rates.json'; document.body.appendChild(a); a.click(); a.remove(); return true; } catch (e) { return false; }
  }

  /* ---------- version management ---------- */
  /* A new draft always runs the new pricing rules (engine 'v2'): its grid, flats and add-ons are what the console
     quotes from. Under 'legacy' those cells are only a mirror of the console's own matrix, so a draft copied from
     version 1 is switched to 'v2' — the edited cells must be what the dispatcher sees. */
  function newDraft(from) {
    var V = active(); if (!from) syncLegacy();
    var d = stripVersion(from || V); d.version = nextVersionNo(); d.status = 'draft'; d.engine = 'v2'; d.createdAt = nowISO(); d.activatedAt = null; d.filedWithTlcAt = null; d.belowFiledAck = null; delete d.syncedAt; delete d.retiredAt;
    if (!from) d.name = 'Version ' + d.version;
    V.draft = d; save(); return d;
  }
  function loadProposed() { var d = proposedPreset(); active().draft = d; save(); return d; }
  function discardDraft() { active().draft = null; save(); }
  /* TLC rule 59B-23: a rate schedule is filed before use. Activation needs filedWithTlcAt, or an explicit owner acknowledgement that every price is at or below the filed schedule. opts.ack = true records that acknowledgement (the UI asks with confirm()). */
  function activate(opts) {
    opts = opts || {}; var V = active(), d = V.draft;
    if (!d) { toast('No draft version to activate.', true); return false; }
    if (!Array.isArray(d.grid) || !Array.isArray(d.zones) || d.grid.length !== d.zones.length) { toast('The draft grid does not match its zone list.', true); return false; }
    if (!d.filedWithTlcAt) {
      var ack = opts.ack === true;
      if (!ack && !opts.silent) { try { ack = window.confirm('Version ' + d.version + ' has no "filed with TLC" date (rule 59B-23: the rate schedule is filed before use).\n\nActivate anyway? Press OK only if every price is at or below the schedule already on file.'); } catch (e) { ack = false; } }
      if (!ack) { toast('Not activated: set the "filed with TLC" date, or confirm the prices are below the filed schedule.', true); return false; }
      d.belowFiledAck = { at: nowISO(), by: 'owner', note: 'owner confirmed every price is at or below the filed schedule' };
    }
    var prev = stripVersion(V); prev.status = 'retired'; prev.retiredAt = nowISO();
    var hist = V.history || []; hist.push(prev);
    d.status = 'active'; d.activatedAt = nowISO(); if (!d.effectiveAt) d.effectiveAt = todayStr();
    d.history = hist; d.draft = null;
    STATE.rates = d;
    settings().feeTiers = copy(d.tiers && d.tiers.length ? d.tiers : TIERS_DEFAULT);
    save();
    toast('Rate version ' + d.version + ' is active' + (d.engine === 'v2' ? ' (new pricing rules on).' : '.'));
    try { refreshAll(); } catch (e) {}
    try { injectNeedsYou(); } catch (e) {}   // the go-live line goes (v2) or comes back (a legacy version re-activated)
    return true;
  }
  function restoreFromHistory(version) { var V = active(); var h = (V.history || []).filter(function (x) { return Number(x.version) === Number(version); })[0]; if (!h) return null; var d = stripVersion(h); d.version = nextVersionNo(); d.status = 'draft'; d.name = (h.name || 'Version ' + h.version) + ' (restored)'; d.createdAt = nowISO(); d.activatedAt = null; d.retiredAt = undefined; V.draft = d; save(); return d; }
  function refreshAll() {
    try { if (byId('matrixWrap') && typeof window.renderMatrix === 'function') window.renderMatrix(); } catch (e) {}
    try { if (typeof window.refreshBoard === 'function' && byId('activeBoard')) window.refreshBoard(); } catch (e) {}
    try { if (byId('d_puAddr') && byId('d_doAddr') && byId('d_puAddr').value && byId('d_doAddr').value && byId('d_fare') && byId('d_fare').dataset.auto) { byId('d_fare').value = ''; byId('d_fare').dataset.auto = ''; callG('maybeAutoFare'); } } catch (e) {}
    try { refreshPending(); } catch (e) {}
    try { renderPanel(); } catch (e) {}
    try { callG('updateReadout'); } catch (e) {}
  }

  /* ---------- editor panel (Settings → Rates & zones in Simple mode; the Pricing tab in Expert mode) ---------- */
  var PANEL_ID = 'quoteVersions';
  function ensureStyle() {
    if (byId('quoteStyle')) return;
    var st = document.createElement('style'); st.id = 'quoteStyle';
    st.textContent = [
      '.q-retained.q-warn{color:#c0392b;font-weight:700;}',
      '.q-line{font-size:11.5px;}',
      '.q-panel .q-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px 12px;margin:6px 0;}',
      '.q-panel .q-grid .fld{margin:0;} .q-panel .q-grid .lbl{font-size:11px;}',
      '.q-panel .q-check{display:flex;flex-direction:row;align-items:center;gap:8px;} .q-panel .q-check input{width:auto;}',
      '.q-panel h4{margin:12px 0 4px;font-size:12.5px;color:var(--green-dark,#15497d);}',
      '.q-panel .q-matrix{overflow:auto;max-height:420px;} .q-panel .q-matrix table{border-collapse:collapse;font-size:11px;} .q-panel .q-matrix th,.q-panel .q-matrix td{border:1px solid var(--line,#d4d4d4);padding:1px;} .q-panel .q-matrix input{width:46px;padding:2px;font-size:11px;text-align:right;} .q-panel .q-matrix td.diag input{background:rgba(120,140,160,.12);}',
      '.q-panel textarea.q-json{font-family:Consolas,monospace;font-size:11px;min-height:90px;width:100%;}',
      '.q-panel .q-hist{font-size:12px;} .q-panel .q-hist li{margin:2px 0;}',
      '.q-panel .q-chip{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:10px;background:rgba(31,122,61,.12);color:#1f7a3d;margin-left:6px;} .q-panel .q-chip.draft{background:rgba(214,158,20,.14);color:#7a5a06;} .q-panel .q-chip.legacy{background:rgba(120,140,160,.14);color:#444;}',
      'body.gold .q-panel h4{color:#e8c75a;} body.classic .q-panel h4{color:#0a246a;} body.classic .q-panel .panel-head .hint{color:#dbe4f3;}',
      'tr .q-id{color:var(--muted,#5b5b5b);}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  function ensurePanel() {
    var view = byId('view-pricing'); if (!view) return null;
    var p = byId(PANEL_ID);
    if (!p) { p = document.createElement('div'); p.id = PANEL_ID; p.className = 'panel q-panel'; view.appendChild(p); p.addEventListener('click', onPanelClick); p.addEventListener('change', onPanelChange); }
    return p;
  }
  function inp(id, label, val, step, extra) { return '<label class="fld"><span class="lbl">' + esc(label) + '</span><input type="' + (extra && extra.type ? extra.type : 'number') + '" id="' + id + '" value="' + esc(val == null ? '' : val) + '"' + (step ? ' step="' + step + '"' : '') + (extra && extra.ph ? ' placeholder="' + esc(extra.ph) + '"' : '') + '></label>'; }
  function draftGridHtml(d) {
    var h = '<div class="q-matrix"><table><thead><tr><th>From \\ To</th>' + d.zones.map(function (z) { return '<th title="' + esc(z.name) + '">' + z.id + '</th>'; }).join('') + '</tr></thead><tbody>';
    d.zones.forEach(function (r, i) {
      h += '<tr><th style="text-align:left;white-space:nowrap;" title="' + esc(r.name) + '">' + r.id + '. ' + esc(String(r.name).slice(0, 22)) + '</th>';
      d.zones.forEach(function (c, j) { var v = (d.grid[i] || [])[j]; h += '<td class="' + (i === j ? 'diag' : '') + '"><input type="number" step="0.5" data-i="' + i + '" data-j="' + j + '" value="' + (v == null ? '' : v) + '" title="' + esc(r.name + ' → ' + c.name) + '"></td>'; });
      h += '</tr>';
    });
    return h + '</tbody></table></div><div class="hint" style="margin:2px 0 0;">Symmetric: typing a cell fills its mirror. Empty = no book price (quote by meter / by hand). Whole or half dollars.</div>';
  }
  function otherAddOns(d) { var a = copy(d.addOns || {}); ['paFee', 'govManhattan', 'onDemand', 'scheduledExempt', 'xboroAdd'].forEach(function (k) { delete a[k]; }); return a; }
  function panelHtml() {
    var V = active(), d = V.draft, s = settings();
    var h = '<div class="panel-head">Fare table versions <span class="hint" style="margin:0;font-weight:400;">quotes carry the version number; activating a version needs the owner PIN and the TLC filing date (rule 59B-23)</span></div><div class="panel-body">';
    h += '<div><b>Active: version ' + V.version + '</b> — ' + esc(V.name || '') + '<span class="q-chip' + (V.engine === 'v2' ? '' : ' legacy') + '">' + (V.engine === 'v2' ? 'new pricing rules' : 'current console prices') + '</span>'
      + '<div class="hint" style="margin:2px 0 0;">Effective ' + esc(V.effectiveAt || '—') + ' · filed with TLC: ' + esc(V.filedWithTlcAt || (V.belowFiledAck ? 'not filed — owner confirmed below the filed schedule on ' + String(V.belowFiledAck.at).slice(0, 10) : 'not filed')) + ' · 20-Area $' + fmtAmt((V.flats || {}).area20) + ' · LGA $' + fmtAmt(((V.flats || {}).airport || {}).LGA) + ' · JFK $' + fmtAmt(((V.flats || {}).airport || {}).JFK) + ' · EWR $' + fmtAmt(((V.flats || {}).airport || {}).EWR) + (V.engine === 'v2' ? ' · PA fee $' + fmtAmt(paFee()) + ' on airport quotes' : '') + '</div>'
      + '<div class="hint" style="margin:2px 0 0;">Fee tiers (settlement when Fee mode is "tiers"): ' + esc(tiersLabel()) + ' · price-change limit: $' + fmtAmt(devLimit().abs) + ' or ' + fmtAmt(devLimit().pct) + '% (owner PIN + reason beyond that).</div>'
      + (V.engine === 'v2' ? '' : '<div class="notice" id="q_golive" style="margin:6px 0 0;">Go-live: this station still quotes the console\'s original prices. A scheduled ride booked ' + esc(leadHoursLabel()) + ' ahead still carries the rush / out-of-boro add-on until the owner loads the proposed rate card and activates it (owner PIN, TLC filing date).</div>')
      + '</div>';
    h += '<div class="btn-row" style="margin-top:8px;"><button class="btn btn-navy btn-sm" type="button" data-q="export">Export rates.json</button>'
      + (d ? '' : '<button class="btn btn-ghost btn-sm" type="button" data-q="new">New version (copy of active)</button><button class="btn btn-go btn-sm" type="button" data-q="proposed">Load proposed rate card</button>') + '</div>';
    if (d) {
      var od = (d.addOns || {}).onDemand || { queens: 2.5, outBoro: 5, leadHours: 2 };
      h += '<h4>Draft: version ' + d.version + '<span class="q-chip draft">draft — not in use</span></h4>';
      h += '<div class="q-grid">' + inp('qd_name', 'Name', d.name || '', '', { type: 'text' }) + inp('qd_eff', 'Effective date', d.effectiveAt || '', '', { type: 'date' }) + inp('qd_filed', 'Filed with TLC on', d.filedWithTlcAt || '', '', { type: 'date' })
        + '<label class="fld"><span class="lbl">Pricing rules</span><select id="qd_engine"><option value="v2"' + (d.engine === 'v2' ? ' selected' : '') + '>New rules (grid, PA fee, on-demand only)</option><option value="legacy"' + (d.engine !== 'v2' ? ' selected' : '') + '>Current console rules</option></select></label></div>'
        + '<div class="notice" id="qd_engine_note"' + (d.engine === 'v2' ? ' hidden' : '') + ' style="margin:4px 0;">With "Current console rules" the grid, flats and add-ons below are NOT used: the console keeps quoting from its own Zone Price Book, Boro book and learned prices, and this version only records them. Choose "New rules" for the edited cells to be what the dispatcher sees.</div>';
      h += '<h4>Flats ($)</h4><div class="q-grid">' + inp('qd_area20', '20-Area local', (d.flats || {}).area20, '0.5') + inp('qd_lga', 'LGA from 20-Area (fare, PA fee added)', ((d.flats || {}).airport || {}).LGA, '0.5') + inp('qd_jfk', 'JFK from 20-Area', ((d.flats || {}).airport || {}).JFK, '0.5') + inp('qd_ewr', 'EWR', ((d.flats || {}).airport || {}).EWR, '0.5') + inp('qd_pick', 'Airport pickup add', (d.flats || {}).airportPickupAdd, '0.5') + inp('qd_nassau', 'Nassau West floor', (d.flats || {}).nassauWest, '0.5') + '</div>';
      h += '<h4>Add-ons</h4><div class="q-grid">' + inp('qd_pafee', 'PA airport fee (from Settings: ' + fmtAmt(paFee()) + ')', (d.addOns || {}).paFee, '0.25') + inp('qd_gov', 'Manhattan government charges', (d.addOns || {}).govManhattan, '0.25') + inp('qd_odq', 'On-demand add-on, Queens', od.queens, '0.5') + inp('qd_odo', 'On-demand add-on, out of boro', od.outBoro, '0.5') + inp('qd_lead', 'Scheduled = booked this many hours ahead', od.leadHours, '0.5')
        + '<label class="fld q-check" style="align-self:end;"><input type="checkbox" id="qd_exempt"' + ((d.addOns || {}).scheduledExempt ? ' checked' : '') + '><span class="lbl" style="margin:0;">Scheduled rides pay no rush / overnight add-on</span></label></div>';
      h += '<h4>Fallback meter (no book price)</h4><div class="q-grid">' + inp('qd_mbase', 'Base ($)', (d.meter || {}).base, '0.05') + inp('qd_mmile', 'Per mile ($)', (d.meter || {}).perMile, '0.05') + inp('qd_mmin', 'Per minute ($)', (d.meter || {}).perMinute, '0.05') + inp('qd_mmin2', 'Minimum ($)', (d.meter || {}).min, '0.5') + '</div>';
      h += '<h4>Fee tiers (base fee by fare)</h4><div class="q-grid">' + (d.tiers || TIERS_DEFAULT).map(function (t, i) { return inp('qd_t' + i + '_up', 'Fare up to ($, blank = and over)', t.upTo == null ? '' : t.upTo, '1') + inp('qd_t' + i + '_fee', 'Fee ($)', t.fee, '0.5'); }).join('') + '</div>';
      h += '<h4>Zone grid ($)</h4>' + draftGridHtml(d);
      h += '<h4>Other add-ons (waiting, extra stop, no-show, return leg, vehicle types) — JSON</h4><textarea class="q-json" id="qd_json">' + esc(JSON.stringify(otherAddOns(d), null, 1)) + '</textarea>';
      h += '<div class="btn-row" style="margin-top:10px;"><button class="btn btn-navy" type="button" data-q="savedraft">Save draft</button><button class="btn btn-go" type="button" data-q="activate">Activate version ' + d.version + ' (owner PIN)</button><button class="btn btn-void" type="button" data-q="discard">Discard draft</button></div>';
    }
    var hist = V.history || [];
    if (hist.length) {
      h += '<h4>Earlier versions</h4><ul class="q-hist">' + hist.slice().reverse().map(function (x) { return '<li>v' + x.version + ' — ' + esc(x.name || '') + ' · ' + esc(x.effectiveAt || '') + ' → ' + esc(String(x.retiredAt || '').slice(0, 10)) + (x.filedWithTlcAt ? ' · filed ' + esc(x.filedWithTlcAt) : '') + (d ? '' : ' <button class="btn btn-ghost btn-sm" type="button" data-q="restore" data-v="' + x.version + '">Restore as draft</button>') + '</li>'; }).join('') + '</ul>';
    }
    h += '<div class="hint q-status" id="q_status" style="margin-top:6px;"></div></div>';
    return h;
  }
  function renderPanel() {
    if (POPOUT) return;
    var p = ensurePanel(); if (!p) return;
    ensureStyle();
    p.innerHTML = panelHtml();
  }
  function readDraftForm() {
    var V = active(), d = V.draft; if (!d) return null;
    var v = function (id) { var el = byId(id); return el ? String(el.value || '').trim() : ''; };
    var num = function (id, dflt) { var x = Number(v(id)); return isFinite(x) && v(id) !== '' ? x : dflt; };
    d.name = v('qd_name') || d.name; d.effectiveAt = v('qd_eff') || ''; d.filedWithTlcAt = v('qd_filed') || null; d.engine = v('qd_engine') === 'legacy' ? 'legacy' : 'v2';
    d.flats = d.flats || {}; d.flats.airport = d.flats.airport || {};
    d.flats.area20 = num('qd_area20', d.flats.area20); d.flats.airport.LGA = num('qd_lga', d.flats.airport.LGA); d.flats.airport.JFK = num('qd_jfk', d.flats.airport.JFK); d.flats.airport.EWR = num('qd_ewr', d.flats.airport.EWR); d.flats.airportPickupAdd = num('qd_pick', 0); d.flats.nassauWest = v('qd_nassau') === '' ? null : num('qd_nassau', null);
    d.addOns = d.addOns || {};
    d.addOns.paFee = num('qd_pafee', 0); d.addOns.govManhattan = num('qd_gov', 0);
    d.addOns.onDemand = { queens: num('qd_odq', 2.5), outBoro: num('qd_odo', 5), leadHours: num('qd_lead', 2) }; d.addOns.scheduledExempt = !!(byId('qd_exempt') && byId('qd_exempt').checked);
    d.meter = { base: num('qd_mbase', 0), perMile: num('qd_mmile', 0), perMinute: num('qd_mmin', 0), min: num('qd_mmin2', 0), booking: 0 };
    var T = []; for (var i = 0; i < 8; i++) { if (!byId('qd_t' + i + '_fee')) break; var upv = v('qd_t' + i + '_up'); T.push({ upTo: upv === '' ? null : Number(upv), fee: num('qd_t' + i + '_fee', 0) }); }
    if (T.length) d.tiers = T;
    try { var extra = JSON.parse(v('qd_json') || '{}'); if (extra && typeof extra === 'object') { var keep = { paFee: d.addOns.paFee, govManhattan: d.addOns.govManhattan, onDemand: d.addOns.onDemand, scheduledExempt: d.addOns.scheduledExempt, xboroAdd: d.addOns.xboroAdd }; d.addOns = Object.assign({}, extra, keep); } } catch (e) { toast('The "Other add-ons" box is not valid JSON — left as it was.', true); }
    var p = byId(PANEL_ID);
    if (p) p.querySelectorAll('.q-matrix input').forEach(function (cell) { var i = Number(cell.dataset.i), j = Number(cell.dataset.j); var x = cell.value === '' ? null : Number(cell.value); if (x != null && !isFinite(x)) x = null; if (d.grid[i]) d.grid[i][j] = x; if (d.grid[j]) d.grid[j][i] = x; });
    return d;
  }
  function onPanelChange(e) {
    var t = e.target; if (!t || !t.matches) return;
    if (t.id === 'qd_engine') { var note = byId('qd_engine_note'); if (note) note.hidden = (t.value === 'v2'); return; }
    if (!t.matches('.q-matrix input')) return;
    var p = byId(PANEL_ID), i = t.dataset.i, j = t.dataset.j; if (!p || i === j) return;
    var mirror = p.querySelector('.q-matrix input[data-i="' + j + '"][data-j="' + i + '"]'); if (mirror) mirror.value = t.value;
  }
  function onPanelClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-q]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-q'), st = byId('q_status');
    try {
      if (a === 'export') { if (!ownerPin('export the rate table')) return; downloadRates(); }
      else if (a === 'new') { if (!ownerPin('create a new rate version')) return; newDraft(); renderPanel(); toast('Draft version created from the active table. Edit, then Activate.'); }
      else if (a === 'proposed') { if (!ownerPin('load the proposed rate card')) return; loadProposed(); renderPanel(); toast('Proposed rate card loaded as a draft. Check it, set the TLC filing date, then Activate.'); }
      else if (a === 'savedraft') { readDraftForm(); save(); renderPanel(); toast('Draft saved (not in use until activated).'); }
      else if (a === 'activate') { readDraftForm(); save(); if (!ownerPin('activate a rate version')) return; if (activate({})) renderPanel(); }
      else if (a === 'discard') { if (!window.confirm('Discard the draft version?')) return; discardDraft(); renderPanel(); }
      else if (a === 'restore') { if (!ownerPin('restore a rate version')) return; restoreFromHistory(b.getAttribute('data-v')); renderPanel(); }
    } catch (err) { try { console.error('[quote]', err); } catch (e2) {} if (st) st.textContent = 'Something went wrong: ' + ((err && err.message) || err); }
  }
  hookAfter('renderPricing', function () { syncLegacy(); renderPanel(); });

  /* ---------- go-live reminder (Simple mode Needs-you) ----------
     By design nothing changes until the owner activates a v2 version, so a fresh station keeps the console's rush add-on on
     scheduled rides. Until a v2 version is active the Needs-you strip carries one line with "Open rates"; "Not now" snoozes
     it for 14 days (settings.quoteGoLiveSnoozedUntil). No PIN: it only opens the rates panel, which gates its own actions. */
  function goLiveDue() { if (POPOUT || !legacy()) return false; var u = String(settings().quoteGoLiveSnoozedUntil || ''); return !(u && u >= todayStr()); }
  function snoozeGoLive(days) { var d = new Date(); d.setDate(d.getDate() + (Number(days) > 0 ? Number(days) : 14)); settings().quoteGoLiveSnoozedUntil = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); save(); injectNeedsYou(); return settings().quoteGoLiveSnoozedUntil; }
  function openRates() {
    var S = window.Simple, ok = false;
    try { if (S && typeof S.isSimple === 'function' && S.isSimple() && typeof S.enter === 'function') ok = S.enter('settings', 'pricing'); else { callG('goTab', 'pricing'); ok = true; } } catch (e) { ok = false; }
    if (ok) { try { var p = byId(PANEL_ID); if (p && p.scrollIntoView) p.scrollIntoView(); } catch (e) {} }
    return ok;
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
     wrapped Simple.refreshNeedsYou: watch the strip and put the line back whenever it is missing (ops.js does the same). The
     observer only acts when the line is absent, and injectNeedsYou adds nothing when the line is not due, so it cannot loop. */
  function watchNeedsYou(host) {
    if (!host || host.__quoteObserved || !window.MutationObserver) return;
    host.__quoteObserved = true;
    try { new MutationObserver(function () { try { if (!host.querySelector('.q-ny')) injectNeedsYou(); } catch (e) {} }).observe(host, { childList: true }); } catch (e) {}
  }
  function injectNeedsYou() {
    var host = byId('needsYou'); if (!host) return;
    watchNeedsYou(host);
    var had = host.querySelector('.q-ny');
    host.querySelectorAll('.q-ny').forEach(function (n) { n.remove(); });
    var simple = true; try { if (window.Simple && typeof window.Simple.isSimple === 'function' && !window.Simple.isSimple()) simple = false; } catch (e) { simple = false; }
    if (!simple) return;
    if (!goLiveDue()) { if (had) recountNeedsYou(host); return; }
    var div = document.createElement('div'); div.className = 'ny-item q-ny'; div.setAttribute('data-kind', 'rates');
    div.innerHTML = '<span class="ny-dot soon"></span><span class="ny-txt"><b>Prices are the console\'s original rates (version ' + esc(active().version) + ')</b> — the proposed rate card is not in use, so scheduled rides booked ' + esc(leadHoursLabel()) + ' ahead still carry the rush add-on. Owner: load and activate it at go-live.</span>'
      + '<span class="ny-acts"><button type="button" class="btn btn-sm btn-navy" data-q-ny="open">Open rates</button><button type="button" class="btn btn-sm btn-ghost" data-q-ny="snooze">Not now</button></span>';
    host.appendChild(div);
    recountNeedsYou(host);
    if (!host.__quoteWired) { host.__quoteWired = true; host.addEventListener('click', function (e) { var b = e.target && e.target.closest ? e.target.closest('[data-q-ny]') : null; if (!b) return; e.stopPropagation(); e.preventDefault(); try { if (b.getAttribute('data-q-ny') === 'open') openRates(); else snoozeGoLive(14); } catch (err) { try { console.error('[quote]', err); } catch (e2) {} } }); }
  }
  function wrapNeedsYou() {
    var S = window.Simple; if (!S || typeof S.refreshNeedsYou !== 'function' || S.refreshNeedsYou.__quoteWrapped) return;
    var o = S.refreshNeedsYou, w = function () { var r = o.apply(this, arguments); try { injectNeedsYou(); } catch (e) {} return r; };
    w.__quoteWrapped = true; w._orig = o; inheritFlags(w, o); S.refreshNeedsYou = w;
  }
  hookAfter('refreshBoard', function () { injectNeedsYou(); });   // simple.js redraws the strip inside refreshBoard; put the line back after it
  /* Keep the legacy snapshot in step with the console's own editors (inline listeners in index.html; bubbling, so they ran first). */
  function watchConsoleEditors() {
    if (document.__quoteEditorsWatched) return; document.__quoteEditorsWatched = true;
    document.addEventListener('change', function (e) { var t = e.target; if (t && t.closest && t.closest('#matrixWrap')) setTimeout(function () { if (syncLegacy()) renderPanel(); }, 0); });
    document.addEventListener('click', function (e) { var t = e.target; if (t && t.closest && t.closest('#rc_save')) setTimeout(function () { if (syncLegacy()) renderPanel(); }, 0); });
  }

  /* ---------- public API ---------- */
  window.Quote = {
    _loaded: true,
    active: active, version: function () { return active().version; }, legacy: legacy, ensureRates: ensureRates,
    engineQuote: engineQuote, formState: formState, pending: function () { return pending; }, refresh: refreshPending,
    decide: decide, exceeds: exceeds, limitFor: limitFor, deviationLimit: devLimit,
    tierFee: tierFee, tiers: tiers, retained: retained, squareCost: squareCost,
    suggestZone: v2SuggestZone, zoneFare: v2ZoneFare, surcharge: v2Surcharge, gridPrice: function (a, b) { return gridPrice(active(), a, b); },
    proposedPreset: proposedPreset, newDraft: newDraft, loadProposed: loadProposed, discardDraft: discardDraft, activate: activate, restoreFromHistory: restoreFromHistory,
    exportRates: exportRates, downloadRates: downloadRates, ownerPin: ownerPin, hasPin: hasPin, render: renderPanel, paFee: paFee, qtag: qtag, syncLegacy: syncLegacy, tableHasPrice: tableHasPrice,
    goLiveDue: goLiveDue, snoozeGoLive: snoozeGoLive, openRates: openRates, refreshNeedsYou: injectNeedsYou, leadHours: leadHours,
    defaults: { tiers: copy(TIERS_DEFAULT), deviationLimit: copy(DEV_DEFAULT), retainedFloor: RETAINED_FLOOR }
  };

  /* ---------- boot ---------- */
  function boot() {
    try { ensureRates(); } catch (e) {}
    try { syncLegacy(); } catch (e) {}
    try { ensureSettings(); } catch (e) {}
    try { applyPaFee(); } catch (e) {}
    if (!POPOUT) {
      try { ensureStyle(); } catch (e) {}
      try { hookBookForm(); } catch (e) {}
      try { watchConsoleEditors(); } catch (e) {}
      try { renderRetained(); } catch (e) {}
      try { renderPanel(); } catch (e) {}
      try { wrapNeedsYou(); injectNeedsYou(); } catch (e) {}
      try { if (byId('activeBoard') && typeof window.refreshBoard === 'function') window.refreshBoard(); } catch (e) {}
      try { if (byId('matrixWrap') && byId('matrixWrap').innerHTML && typeof window.renderMatrix === 'function') window.renderMatrix(); } catch (e) {}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
