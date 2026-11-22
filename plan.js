/* ======================================================================
   Skyway — plan.js
   Management tool (TURNAROUND-PLAN build row 10, app-gaps.md §8): the "Plan" panel for
   the owner and the bookkeeper, at the bottom of MONEY → Business (#view-biz), reachable
   in Simple mode (Money → Business) and in Expert mode (the Business tab).
   (a) Weekly scorecard — every plan §9 metric computed from STATE for one Monday–Sunday
       week: inbound calls/day and answer / callback rates (STATE.calls from ops.js; the
       answer-within-30 s rate needs ring seconds from a CDR import), scheduled pickups on
       time (promised window vs an arrived time on the trip), eligible assignments %
       (trip.eligibility from ops.js), paid recovered rides/day (Completed + paid +
       crmRowId or a callback call), win-back conversations / paid return rides /
       recurring (STATE.crm), standing orders (STATE.recurring), pilots live (crm
       pipeline), retained contribution per ride (tier or base fee minus the Square cost
       by pay type), cash base fees received vs owed (STATE.ledger), unexplained payout
       variance and the Square effective rate (ledger imports), active callers a month.
       A metric whose source is absent reads "n/a (no data)" — never a silent zero.
       Baseline and target columns are editable and seeded with the plan's values.
       "Save this week" keeps a snapshot; CSV export.
   (b) 13-week cash sheet mirroring the workbook "13 week cash": opening cash, reserve
       floor ($5,000), the workbook's eight flow columns C–J (Base fees in · Customer
       cash / settlements · Other cash in · Driver fare & tips · Payroll & taxes · Space,
       phone, tech · Insurance, debt, other · One-time cash out), Net change =
       SUM(C:E) − SUM(F:J) only when all eight are filled, Ending cash, and the
       workbook's cash check (Inputs missing / Cash shortfall / Set reserve floor /
       Below reserve / Meets reserve). The plan's STRUCTURAL inputs are seeded (weekly =
       monthly × 12/52, ride cash in C from the ride ramp × 7 × retained, savings landed
       in E, software in H, workers' comp in I, one-time items in J). The firm's own
       bank and payroll figures are NOT in this file (the repository is public): opening
       cash, Square credits a month (D), the baseline operating net a month (D − F) and
       the payroll uplift a month (G) stay blank — every week reads "Inputs missing" —
       until the bookkeeper types them in the "Private inputs" row, or a git-ignored
       local script sets window.PLAN_SEED = {opening, squareCredits, baselineNet,
       payrollUp, baselines:{metricKey: text}} before this file loads. With the same
       inputs the sheet reproduces the ending balances of cash13.md §2. "Ending, no new
       rides" column, CSV export in the workbook's column order, and the "Operating
       math" scenario box (the PDF p. 2 wage inputs; the baseline net is the typed one).
   (c) Five-route test log — 5 routes × 3 windows × 4 dates; per cell Uber, Lyft, Curb,
       two phone quotes, the Skyway console quote and retained dollars; pass rules per
       the plan §5 protocol: price Skyway ÷ median(Uber, Lyft) ≤ 1.00 at 5 pm and ≤ 1.10
       off-peak / Saturday, contribution ≥ $6 airport / Manhattan and ≥ $4 local at the
       tap assumption (tier fee − 2.6 % − 15 ¢), and an eligible driver available.
   (d) "Retained per ride" warning on the Book form when the quote retains under $5.51
       (Quote.retained from quote.js when present, own computation otherwise). It listens to
       #d_fare / #d_tolls / #d_account directly as well as wrapping updateReadout, because
       index.html bound its own 'input' listeners to the original updateReadout by reference.
   Panel re-renders are focus-safe: an outside rebuild (renderBiz on a remote save,
   reloadFromStorage) waits while a panel input is being typed in; own edits re-focus the
   equivalent input. Route-test pass rules compare the exact price ratio (rounded only for
   display); changing a test date carries the typed cells to the new date; four different
   dates are required.
   STATE keys owned here: STATE.plan = {scorecard, cash13, routeTest} — initialised
   defensively, every write idempotent; nothing existing is renamed or reshaped.
   Wrapper pattern (money.js / driver-link.js / sync.js): IIFE, originals kept as
   window.fn._orig, call-through wrappers (renderBiz, updateReadout, reloadFromStorage).
   STATE is the console's top-level let. Never edits index.html. Works with Cloud off;
   nothing here touches the network. Owner-only actions (reset the cash sheet, clear the
   route log) ask for the admin PIN the way simple.js / quote.js do. Plain ES2019.
   Public API: window.Plan (see bottom).
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;
  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }
  if (POPOUT) return;
  if (window.Plan && window.Plan._loaded) return;

  /* ---------- helpers (own copies; console globals may be missing) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[plan] ' + m); } catch (e) {} }
  function save() { if (typeof window.save === 'function') { try { window.save(); return; } catch (e) {} } if (typeof window.saveNow === 'function') { try { window.saveNow(); } catch (e) {} } }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  function trips() { return Array.isArray(STATE.trips) ? STATE.trips : []; }
  function drivers() { return Array.isArray(STATE.drivers) ? STATE.drivers : []; }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function r6(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }   // seeded cash inputs keep the model's precision; the UI shows cents
  function num(v) { if (v === '' || v == null) return null; var n = Number(String(v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; }
  function money(n) { if (typeof window.money === 'function') { try { return window.money(n); } catch (e) {} } return '$' + (Number(n) || 0).toFixed(2); }
  function dollars(n) { n = Math.round(Number(n) || 0); return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US'); }
  function pct(n) { return (Math.round(Number(n) * 10) / 10) + '%'; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function isoLocal(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { if (typeof window.todayStr === 'function') { try { return window.todayStr(); } catch (e) {} } return isoLocal(new Date()); }
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
  function addDays(ymd, n) { var p = ymd.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]); d.setDate(d.getDate() + n); return isoLocal(d); }
  function dateOf(iso) { if (!iso) return ''; if (isDate(iso) && String(iso).length === 10) return iso; var d = new Date(iso); return isNaN(d) ? String(iso).slice(0, 10) : isoLocal(d); }
  function nowISO() { return new Date().toISOString(); }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { try { console.error('[plan]', err); } catch (e2) {} } }; }
  function download(name, content, type) {
    if (typeof window.download === 'function') { try { window.download(name, content, type || 'text/csv'); return true; } catch (e) {} }
    try { var blob = new Blob([content], { type: type || 'text/csv' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); return true; } catch (e) { return false; }
  }
  function csvCell(v) {
    if (typeof window.csv === 'function') { try { return window.csv(v); } catch (e) {} }
    var s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvLine(arr) { return arr.map(csvCell).join(','); }
  /* Owner PIN — the same 4-digit settings.adminPin simple.js uses for Settings / Expert mode (quote.js, ledger.js, crm.js reuse it the same way). */
  var pinHinted = false;
  /* recover.js: a signed-in owner (or an owner PIN already given to recover.js this session) is not asked again */
  function recoverOwner() { try { var R = window.Recover; return !!(R && R._loaded && typeof R.who === 'function' && R.who() && R.role() === 'owner'); } catch (e) { return false; } }
  function ownerPin(what) {
    if (recoverOwner()) return true;
    var pin = String(settings().adminPin || '').trim();
    if (!/^\d{4}$/.test(pin)) { if (!pinHinted) { pinHinted = true; toast('No admin PIN is set — set one in Settings so resetting the cash sheet and clearing the route log stay owner-only.'); } return true; }
    var a = null;
    try { a = window.prompt('Owner PIN needed' + (what ? ' to ' + what : '') + '. Enter the 4-digit admin PIN:', ''); } catch (e) { a = null; }
    if (a === null) return false;
    if (String(a).trim() === pin) return true;
    toast('Wrong PIN.', true); return false;
  }
/* keep the inner wrappers' marker flags (e.g. __fixesWrapped) visible on the outermost function */
  function inheritFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_{1,2}\w*Wrapped$/.test(k) && w[k] === undefined) w[k] = orig[k]; }); } catch (e) {} return w; }
  function hook(name, make) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__planWrapped) return false;
    var wrapped = make(orig);
    wrapped.__planWrapped = true; wrapped._orig = orig; inheritFlags(wrapped, orig);
    window[name] = wrapped;
    return true;
  }
  function hookAfter(name, after) { return hook(name, function (orig) { return function () { var out; try { out = orig.apply(this, arguments); } finally { try { after.apply(this, arguments); } catch (e) {} } return out; }; }); }

  /* ---------- constants ---------- */
  var RETAINED_FLOOR = 5.51;            // cash13.md: retained per extra ride at the archive mix; $6.00 at the target mix
  var TIERS_DEFAULT = [{ upTo: 15, fee: 4.5 }, { upTo: 34, fee: 6.5 }, { upTo: 59, fee: 8.5 }, { upTo: null, fee: 11 }];
  var SQUARE = { keyed: { pct: 0.035, fixed: 0.15 }, tap: { pct: 0.026, fixed: 0.15 } };
  var WEEKLY = 12 / 52;                 // monthly → weekly, as cash13.py
  /* cash13.md §1 STRUCTURAL inputs (plan estimates). The firm's bank / payroll figures are deliberately absent — see PRIVATE_INPUTS. */
  var CASH_SEED = {
    start: '2026-11-23', reserve: 5000, retained: 5.51,
    workersComp: 60, software: 150, squareSave: 65, phoneSave: 375,
    oneTime: { 0: [20, '10DLC brand / Twilio prepay'], 1: [40, '10DLC campaign'], 2: [118, 'Two Square Readers (only if the driver phones lack NFC)'], 3: [400, 'Counsel / payroll adviser consult (E)'] },
    ramp: [0, 0, 2, 2, 4, 4, 6, 6, 8, 8, 10, 10, 10]
  };
  /* Monthly figures typed by the bookkeeper (never stored in this public file): they fill the workbook's D, F and G
     columns for every week (× 12/52). Blank → those cells are blank → "Inputs missing" for every week. */
  var PRIVATE_INPUTS = [
    ['squareCredits', 'Square credits / month (D)', 'Customer cash / settlements: the May–Oct average Square deposit a month'],
    ['baselineNet', 'Baseline operating net / month (D − F)', 'average monthly checking change at the old payroll, rent, phone and driver flows (negative = outflow); sets Driver fare & tips = D − this'],
    ['payrollUp', 'Payroll uplift / month (G)', 'higher monthly payroll at the new wage, hours, employer costs and payroll service, from the payroll run']
  ];
  /* Optional local seed: a git-ignored script loaded before this file may set window.PLAN_SEED = {opening, squareCredits,
     baselineNet, payrollUp, baselines: {metricKey: 'text'}} so a station is pre-filled without putting the figures in the repository. */
  function localSeed() { try { var s = window.PLAN_SEED; return (s && typeof s === 'object') ? s : {}; } catch (e) { return {}; } }
  function blankInputs() { var o = {}; PRIVATE_INPUTS.forEach(function (p) { o[p[0]] = null; }); return o; }
  var CASH_COLS = [
    ['c', 'Base fees in', 'in', 'ride cash retained (extra rides × 7 × retained per ride)'],
    ['d', 'Customer cash / settlements', 'in', 'Square credits at the May–Oct average'],
    ['e', 'Other cash in', 'in', 'savings landed (Square from Dec 7, phone from Feb 1)'],
    ['f', 'Driver fare & tips', 'out', 'driver payout at the May–Oct average, so D − F is the −$572 baseline'],
    ['g', 'Payroll & taxes', 'out', 'payroll uplift $11 → $17/h, 40 h, burden + Square Payroll'],
    ['h', 'Space, phone, tech', 'out', 'software allowance from week 2'],
    ['i', 'Insurance, debt, other', 'out', "workers' comp + DBL minimum (E)"],
    ['j', 'One-time cash out', 'out', '10DLC, Readers, counsel']
  ];
  /* Operating math sheet inputs (PDF p. 2). The baseline monthly cash change is the private input `baselineNet` above
     (a legacy opmath.baselineCash value is still honoured when present). */
  var OPMATH_SEED = { oldPay: 11, oldHours: 40, newHours: 40, newWage: 17, burden: 0.15, savings: 600, software: 150, days: 30 };
  var SCENARIOS = [['Fixed driver fee only', 10, 0], ['Slow', 5, 4], ['Working', 10, 6], ['Strong', 15, 8]];
  /* Five-route test protocol (plan §5) */
  var ROUTES_SEED = [
    { id: 'a', name: 'Fresh Meadows → JFK T4 (7.3 mi)', kind: 'airport' },
    { id: 'b', name: 'Fresh Meadows → LGA B (6.3 mi)', kind: 'airport' },
    { id: 'c', name: 'Hillcrest, 164th & Union Tpke → Queens Hospital Center (1.3 mi)', kind: 'local' },
    { id: 'd', name: 'Briarwood → Jamaica Center (1.5 mi)', kind: 'local' },
    { id: 'e', name: 'Fresh Meadows → Penn Station (12.2 mi)', kind: 'manhattan' }
  ];
  var WINDOWS_SEED = [{ id: 'am', name: 'Weekday 6–7 am', peak: false }, { id: 'pm', name: 'Weekday 5 pm', peak: true }, { id: 'sat', name: 'Saturday 11 am', peak: false }];
  var DATES_SEED = ['2026-12-12', '2026-12-14', '2026-12-15', '2026-12-19'];
  var CONTRIB_MIN = { airport: 6, manhattan: 6, local: 4 };

  /* ---------- STATE.plan (defensive init, idempotent) ---------- */
  function plan() {
    if (!STATE.plan || typeof STATE.plan !== 'object') STATE.plan = {};
    var P = STATE.plan;
    if (!P.scorecard || typeof P.scorecard !== 'object') P.scorecard = {};
    if (!P.scorecard.targets || typeof P.scorecard.targets !== 'object') P.scorecard.targets = {};
    if (!P.scorecard.weeks || typeof P.scorecard.weeks !== 'object') P.scorecard.weeks = {};
    if (P.scorecard.promisedWindowMin == null) P.scorecard.promisedWindowMin = 15;
    var LB = localSeed().baselines; LB = (LB && typeof LB === 'object') ? LB : {};
    METRICS.forEach(function (m) { if (!P.scorecard.targets[m.key]) P.scorecard.targets[m.key] = { baseline: LB[m.key] != null ? String(LB[m.key]) : m.baseline, target: m.target }; });
    if (!P.cash13 || typeof P.cash13 !== 'object' || !Array.isArray(P.cash13.weeks) || !P.cash13.weeks.length) P.cash13 = seedCash();
    if (!P.cash13.opmath || typeof P.cash13.opmath !== 'object') P.cash13.opmath = Object.assign({}, OPMATH_SEED);
    if (!P.cash13.inputs || typeof P.cash13.inputs !== 'object') {
      P.cash13.inputs = blankInputs();
      var legacy = num(P.cash13.opmath.baselineCash); if (legacy != null) P.cash13.inputs.baselineNet = legacy;   // older stations typed the baseline in the Operating math box
    }
    if (!P.routeTest || typeof P.routeTest !== 'object') P.routeTest = {};
    var R = P.routeTest;
    if (!Array.isArray(R.routes) || !R.routes.length) R.routes = ROUTES_SEED.map(function (r) { return Object.assign({}, r); });
    if (!Array.isArray(R.windows) || !R.windows.length) R.windows = WINDOWS_SEED.map(function (w) { return Object.assign({}, w); });
    if (!datesOk(R.dates)) R.dates = DATES_SEED.slice();
    if (!Array.isArray(R.phoneNames) || R.phoneNames.length !== 2) R.phoneNames = ['Phone quote 1', 'Phone quote 2'];
    if (!R.cells || typeof R.cells !== 'object') R.cells = {};
    return P;
  }
  /* keep = {opening, inputs, opmath} — the owner's typed figures survive a reset; window.PLAN_SEED fills what is still blank. */
  function seedCash(keep) {
    keep = keep || {}; var S = CASH_SEED, L = localSeed(), weeks = [];
    for (var i = 0; i < 13; i++) {
      var ot = S.oneTime[i];
      weeks.push({
        weekOf: addDays(S.start, 7 * i),
        c: r6(S.ramp[i] * 7 * S.retained),
        d: null,
        e: r6((i >= 2 ? S.squareSave * WEEKLY : 0) + (i >= 10 ? S.phoneSave * WEEKLY : 0)),
        f: null,
        g: null,
        h: r6(i >= 1 ? S.software * WEEKLY : 0),
        i: r6(S.workersComp * WEEKLY),
        j: ot ? ot[0] : 0,
        rides: S.ramp[i],
        note: [ot ? ot[1] : '', i === 1 ? 'software line starts' : '', i === 2 ? 'Square saving lands' : '', i === 10 ? 'phone saving lands' : ''].filter(Boolean).join('; ')
      });
    }
    var inputs = blankInputs();
    PRIVATE_INPUTS.forEach(function (p) { var k = p[0], v = keep.inputs && num(keep.inputs[k]); if (v == null) v = num(L[k]); inputs[k] = v; });
    var opening = num(keep.opening); if (opening == null) opening = num(L.opening);
    var C = { opening: opening, reserve: S.reserve, retained: S.retained, asOf: '', inputs: inputs, weeks: weeks, seededAt: nowISO(),
      source: 'cash13.md §1 structure; bank and payroll figures typed locally', opmath: (keep.opmath && typeof keep.opmath === 'object') ? keep.opmath : Object.assign({}, OPMATH_SEED) };
    applyInputs(C);
    return C;
  }
  /* D, F and G for every week from the monthly private inputs (idempotent; overwrites those three columns only). */
  /* derived(I) → the D/F/G values the monthly inputs imply for one week (null while an input is missing) */
  function derived(I) {
    I = I || blankInputs(); var sq = num(I.squareCredits), bn = num(I.baselineNet), pu = num(I.payrollUp);
    return { d: sq == null ? null : r6(sq * WEEKLY), f: (sq == null || bn == null) ? null : r6((sq - bn) * WEEKLY), g: pu == null ? null : r6(pu * WEEKLY) };
  }
  function near(a, b) { return a == null ? b == null : (b != null && Math.abs(Number(a) - Number(b)) < 0.005); }
  /* applyInputs(C, prev): refill D/F/G from the monthly inputs. A cell the bookkeeper typed over (it no longer equals what the
     previous inputs implied) is an actual and is kept; only derived cells follow the new inputs. */
  function applyInputs(C, prev) {
    var now = derived(C.inputs), was = prev ? derived(prev) : null;
    C.weeks.forEach(function (wk) {
      ['d', 'f', 'g'].forEach(function (k) {
        var typed = was ? !(wk[k] == null || near(wk[k], was[k])) : false;
        if (!typed) wk[k] = now[k];
      });
    });
  }
  function setInput(field, val) {
    if (!PRIVATE_INPUTS.some(function (p) { return p[0] === field; })) return false;
    var C = plan().cash13, prev = Object.assign({}, C.inputs || blankInputs()); C.inputs[field] = num(val); applyInputs(C, prev); C.asOf = todayStr(); save(); return true;
  }

  /* ---------- weeks (Monday–Sunday, like ops.js weekDays; the plan reviews on Fridays) ---------- */
  function weekOf(anchor) {
    var s = isDate(anchor) ? anchor : todayStr(), p = s.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]);
    var dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow);
    var from = isoLocal(d), days = []; for (var i = 0; i < 7; i++) days.push(addDays(from, i));
    var td = todayStr(), elapsed = days.filter(function (x) { return x <= td; }).length;
    return { from: from, to: days[6], days: days, elapsed: Math.max(1, Math.min(7, elapsed || 7)) };
  }
  function inW(w, ymd) { return !!ymd && ymd >= w.from && ymd <= w.to; }

  /* ---------- retained per ride ---------- */
  function tiers() { var t = settings().feeTiers; if (Array.isArray(t) && t.length) return t; try { if (window.Quote && typeof window.Quote.tiers === 'function') { var q = window.Quote.tiers(); if (Array.isArray(q) && q.length) return q; } } catch (e) {} return TIERS_DEFAULT; }
  function tierFee(fare) {
    if (window.Quote && typeof window.Quote.tierFee === 'function') { try { return round2(window.Quote.tierFee(fare)); } catch (e) {} }
    fare = Number(fare) || 0; var T = tiers().slice().sort(function (a, b) { var x = a.upTo == null ? Infinity : Number(a.upTo), y = b.upTo == null ? Infinity : Number(b.upTo); return x - y; });
    for (var i = 0; i < T.length; i++) { var u = T[i].upTo; if (u == null || fare <= Number(u) + 1e-9) return round2(T[i].fee); }
    return round2(T.length ? T[T.length - 1].fee : 0);
  }
  function payKind(t) { var p = t && t.payType; if (p === 'Credit Card' || p === 'card') return 'card'; if (p === 'Account' || (t && t.accountId)) return 'account'; return 'cash'; }
  function squareCost(amount, kind, rate) { if (kind !== 'card') return 0; var k = SQUARE[rate || (settings().squareRate === 'tap' ? 'tap' : 'keyed')]; return round2((Number(amount) || 0) * k.pct + k.fixed); }
  /* {fee, square, retained, mode, warn, floor} — Quote.retained when quote.js is loaded, the same math otherwise */
  function retained(fare, kind, tolls) {
    fare = Number(fare) || 0; if (!(fare > 0)) return null;
    if (window.Quote && typeof window.Quote.retained === 'function') { try { var r = window.Quote.retained(fare, kind, tolls); if (r && typeof r === 'object') { r.floor = floor(); r.warn = r.retained < r.floor; return r; } } catch (e) {} }
    var mode = settings().feeMode === 'tiers' ? 'tiers' : 'flat';
    var fee = mode === 'tiers' ? tierFee(fare) : round2(Number(settings().baseFeePerCall) || 0);
    var sq = squareCost(fare + (Number(tolls) || 0), kind);
    var ret = round2(fee - sq);
    return { fee: fee, square: sq, retained: ret, mode: mode, warn: ret < floor(), floor: floor() };
  }
  function floor() { var f = Number(plan().scorecard.retainedFloor); return f > 0 ? f : RETAINED_FLOOR; }
  /* Contribution of a Completed trip: the fee (tier or base) minus the actual Square fee when the import stamped one, else the estimate by pay type. */
  function tripContribution(t) {
    var r = retained(t.fare, payKind(t), t.tolls); if (!r) return null;
    var p = t.payment || {};
    if (p.feeCents != null && Number(p.feeCents) >= 0 && payKind(t) === 'card') return round2(r.fee - Number(p.feeCents) / 100);
    return r.retained;
  }

  /* ---------- Book form warning (d) ---------- */
  function bookPayKind() { var v = String((byId('d_account') || {}).value || 'cash'); return v === 'card' ? 'card' : (v === 'cash' ? 'cash' : 'account'); }
  function renderBookWarn() {
    var fareEl = byId('d_fare'); if (!fareEl) return;
    var brk = document.querySelector('#view-dispatch .readout .break'); if (!brk || !brk.parentNode) return;
    var fare = Number(fareEl.value) || 0, tolls = Number((byId('d_tolls') || {}).value) || 0;
    var r = retained(fare, bookPayKind(), tolls);
    var el = byId('plan_retained_warn');
    if (!r || !r.warn) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div'); el.id = 'plan_retained_warn'; el.className = 'plan-warn'; el.setAttribute('role', 'status');
      var after = byId('q_retained') || brk; after.parentNode.insertBefore(el, after.nextSibling);
    }
    el.textContent = 'Retained per ride ' + money(r.retained) + ' is under the $' + r.floor.toFixed(2) + ' floor (' + (r.mode === 'tiers' ? 'tier fee ' : 'base fee ') + money(r.fee) + (r.square ? ' − Square ' + money(r.square) : '') + '). Check the price before offering a discount.';
  }

  /* ---------- scorecard metrics ---------- */
  function NA(why) { return { na: true, text: 'n/a (' + (why || 'no data') + ')', value: null }; }
  function callsOf(w) { if (!Array.isArray(STATE.calls)) return null; return STATE.calls.filter(function (c) { return c && inW(w, dateOf(c.at)); }); }
  function callMetrics(list) {
    if (window.Ops && typeof window.Ops.dayMetrics === 'function') { try { return window.Ops.dayMetrics(list); } catch (e) {} }
    var m = { offered: 0, answered: 0, answered30: 0, answeredNoRing: 0, missed: 0, voicemail: 0, returned2: 0, booked: 0, outbound: 0 };
    list.forEach(function (c) {
      if (c.direction === 'out') { m.outbound++; return; }
      m.offered++;
      if (c.outcome === 'answered' || (!c.outcome && c.tripId)) { m.answered++; if (c.ringSec != null) { if (Number(c.ringSec) <= 30) m.answered30++; } else m.answeredNoRing++; }
      else if (c.outcome === 'missed' || c.outcome === 'voicemail') {
        m[c.outcome]++;
        var base = new Date(c.at).getTime();
        if ((c.attempts || []).some(function (a) { var t = new Date(a.at).getTime(); return t >= base && t <= base + 120000; })) m.returned2++;
      }
      if (c.tripId) m.booked++;
    });
    return m;
  }
  function arrivedISO(t) { return t.arrivedAt || (t.stageAt && t.stageAt.arrived) || (t.stages && t.stages.arrived) || (t.driverStages && t.driverStages.arrived) || ''; }
  function pickupMs(t) { if (typeof window.pickupDT === 'function') { try { var d = window.pickupDT(t); if (d && !isNaN(d)) return d.getTime(); } catch (e) {} } if (!t.date) return NaN; var p = t.date.split('-').map(Number), tp = String(t.time || '0:0').split(':'); return new Date(p[0], p[1] - 1, p[2], +tp[0] || 0, +tp[1] || 0, 0).getTime(); }
  function isScheduled(t) { return !!(t.time && !/asap/i.test(String(t.time))); }
  function isPaid(t) { return !!(t && t.payment && t.payment.status === 'paid'); }
  function callbackSource(t) { if (!Array.isArray(STATE.calls)) return false; return STATE.calls.some(function (c) { return c && c.tripId === t.id && (c.outcome === 'missed' || c.outcome === 'voicemail' || (c.callbackAt && c.direction !== 'out')); }); }
  function completedIn(w) { return trips().filter(function (t) { return t && !t._hist && t.status === 'Completed' && inW(w, t.date); }); }
  function crm() { return (STATE.crm && typeof STATE.crm === 'object') ? STATE.crm : null; }
  function ledgerState() { if (window.Ledger && typeof window.Ledger.state === 'function') { try { return window.Ledger.state(); } catch (e) {} } return (STATE.ledger && typeof STATE.ledger === 'object') ? STATE.ledger : null; }
  function baseOwed(w) {
    var owed = 0;
    drivers().forEach(function (d) {
      if (window.Ledger && typeof window.Ledger.compute === 'function') { try { var c = window.Ledger.compute(d.id, w.from, w.to); if (c && c.lines) { owed += Number(c.lines.baseOwed) || 0; return; } } catch (e) {} }
      var ts = trips().filter(function (t) { return t && !t._hist && t.driverId === d.id && t.status === 'Completed' && inW(w, t.date); });
      var fares = ts.reduce(function (a, t) { return a + (Number(t.fare) || 0); }, 0);
      owed += (Number(d.feeWeek) || 0) + (Number(d.feeTrip) || 0) * ts.length + fares * (Number(d.feePct) || 0) / 100;
    });
    return round2(owed);
  }

  var METRICS = [
    { key: 'callsPerDay', label: 'Inbound calls / day', baseline: '75', target: '100', source: 'call log (ops.js) / CDR import',
      calc: function (w) { var L = callsOf(w); if (!L) return NA('no call log'); if (!L.length) return NA('no calls logged this week'); var m = callMetrics(L); return { value: m.offered / w.elapsed, text: (Math.round(m.offered / w.elapsed * 10) / 10) + ' / day (' + m.offered + ' offered over ' + w.elapsed + ' day' + (w.elapsed === 1 ? '' : 's') + ')' }; } },
    { key: 'answered30', label: 'Answered within 30 s', baseline: 'unknown (measure in week 1)', target: '90%', source: 'CDR import (ring seconds)',
      calc: function (w) { var L = callsOf(w); if (!L) return NA('no call log'); var ring = L.filter(function (c) { return c.direction !== 'out' && c.ringSec != null; }); if (!ring.length) return NA('no CDR import — ring time unknown'); var m = callMetrics(ring); var v = m.answered30 / ring.length * 100; return { value: v, text: pct(v) + ' (' + m.answered30 + ' of ' + ring.length + ' with ring time)' }; } },
    { key: 'returned2', label: 'Missed calls returned within 2 min', baseline: 'unknown (no record exists)', target: '90%', source: 'callback queue (ops.js)',
      calc: function (w) { var L = callsOf(w); if (!L) return NA('no call log'); var m = callMetrics(L), missed = m.missed + m.voicemail; if (!missed) return NA(L.length ? 'no missed calls this week' : 'no calls logged this week'); var v = m.returned2 / missed * 100; return { value: v, text: pct(v) + ' (' + m.returned2 + ' of ' + missed + ')' }; } },
    { key: 'onTime', label: 'Scheduled pickups on time (promised window)', baseline: 'unknown (dispatch-within-2-min proxy 78% am / 62% pm)', target: '90%', source: 'trip time + arrived time',
      calc: function (w) { var win = Number(plan().scorecard.promisedWindowMin) || 15; var list = trips().filter(function (t) { return t && !t._hist && inW(w, t.date) && isScheduled(t) && (t.status === 'Completed' || t.status === 'Dispatched') && arrivedISO(t); }); if (!list.length) return NA('no arrived times recorded'); var ok = 0; list.forEach(function (t) { var a = new Date(arrivedISO(t)).getTime(), p = pickupMs(t); var allow = Number(t.promisedWindowMin) || win; if (!isNaN(a) && !isNaN(p) && a <= p + allow * 60000) ok++; }); var v = ok / list.length * 100; return { value: v, text: pct(v) + ' (' + ok + ' of ' + list.length + ' within ' + win + ' min)' }; } },
    { key: 'eligible', label: 'Eligible assignments', baseline: '0% enforced', target: '100%', source: 'trip.eligibility (ops.js)',
      calc: function (w) { var list = completedIn(w).filter(function (t) { return t.eligibility && typeof t.eligibility === 'object'; }); if (!list.length) return NA('no eligibility checks recorded'); var ok = list.filter(function (t) { return t.eligibility.ok === true; }).length; var v = ok / list.length * 100; return { value: v, text: pct(v) + ' (' + ok + ' of ' + list.length + ' completed rides)' }; } },
    { key: 'recovered', label: 'Paid recovered rides / day', baseline: '0', target: '5 (or the measured missed-call baseline if lower)', source: 'Completed + paid + callback or win-back row',
      calc: function (w) { if (!Array.isArray(STATE.calls) && !crm()) return NA('no call log or win-back list'); var list = completedIn(w).filter(function (t) { return isPaid(t) && (t.crmRowId || t.recoveredFrom || callbackSource(t)); }); return { value: list.length / w.elapsed, text: (Math.round(list.length / w.elapsed * 10) / 10) + ' / day (' + list.length + ' this week)' }; } },
    { key: 'winback', label: 'Win-back: conversations / paid return rides / recurring', baseline: '0 / 0 / 0', target: '5 / 3 / 1 by Dec 4', source: 'CRM outreach log (crm.js)',
      calc: function (w) { var C = crm(); if (!C) return NA('no win-back list'); var conv = (C.outreach || []).filter(function (e) { return e && e.result === 'reached' && inW(w, dateOf(e.at)); }).length; var rows = C.worklist || []; var paid = trips().filter(function (t) { return t && t.crmRowId && isPaid(t) && inW(w, dateOf((t.payment || {}).at) || t.date); }).length; var rec = rows.filter(function (r) { return r && r.status === 'recurring'; }).length; return { value: paid, text: conv + ' / ' + paid + ' / ' + rec }; } },
    { key: 'standing', label: 'Standing orders re-confirmed (131 list)', baseline: '0', target: '13 by Dec 21; 26 by Jan 20', source: 'standing rides (recurring.js)',
      calc: function (w) { if (!Array.isArray(STATE.recurring)) return NA('no standing rides module'); var n = STATE.recurring.filter(function (s) { return s && s.status === 'active' && dateOf(s.createdAt) <= w.to; }).length; return { value: n, text: n + ' active standing order' + (n === 1 ? '' : 's') }; } },
    { key: 'pilots', label: 'Paid account pilots live', baseline: '0', target: '1 by Dec 21; 2 by Jan 20', source: 'account pipeline (crm.js)',
      calc: function (w) { var C = crm(); if (!C) return NA('no pipeline'); var p = C.pipeline || []; var live = p.filter(function (x) { return x && (x.status === 'pilot_live' || x.status === 'account'); }).length; return { value: live, text: live + ' live (' + p.length + ' in pipeline)' }; } },
    { key: 'retained', label: 'Retained contribution / ride', baseline: '$6.04 assumed; $5.51 at the archive mix', target: '≥ $6 airport / Manhattan, ≥ $4 local; mix floor $5.51, target $6.00', source: 'tier or base fee − Square cost by pay type',
      calc: function (w) { var list = completedIn(w), vals = []; list.forEach(function (t) { var c = tripContribution(t); if (c != null) vals.push(c); }); if (!vals.length) return NA('no completed rides'); var avg = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length; return { value: round2(avg), text: money(avg) + ' avg over ' + vals.length + ' ride' + (vals.length === 1 ? '' : 's') + (avg < floor() ? ' — below the $' + floor().toFixed(2) + ' floor' : ''), warn: avg < floor() }; } },
    { key: 'cashFees', label: 'Cash base fees received vs owed', baseline: 'unknown', target: '100% receipted', source: 'ledger receipts (ledger.js)',
      calc: function (w) { var L = ledgerState(); if (!L || !Array.isArray(L.entries)) return NA('ledger not loaded'); var rec = round2(L.entries.reduce(function (a, e) { return e && e.kind === 'base-fee-received' && inW(w, e.date) ? a + (Number(e.amount) || 0) : a; }, 0)); var owed = baseOwed(w); if (!owed && !rec) return NA('no base fees owed or received this week'); var v = owed > 0 ? rec / owed * 100 : 100; return { value: v, text: money(rec) + ' of ' + money(owed) + ' (' + pct(v) + ')', warn: rec + 0.005 < owed }; } },
    { key: 'payoutVariance', label: 'Unexplained Square payout variance', baseline: 'unknown here — type the Jan–Oct figure from the bank reconciliation', target: '$0', source: 'payout import vs bank credits (ledger.js)',
      calc: function (w) { var L = ledgerState(); if (!L) return NA('ledger not loaded'); var po = (L.payouts || []).filter(function (p) { return p && inW(w, p.date); }), bk = (L.bank || []).filter(function (b) { return b && inW(w, b.date); }); if (!po.length && !bk.length) return NA('no payouts or bank credits this week'); var v = round2(po.reduce(function (a, p) { return a + (Number(p.amount) || 0); }, 0) - bk.reduce(function (a, b) { return a + (Number(b.amount) || 0); }, 0)); return { value: v, text: money(v) + ' (payouts ' + po.length + ', bank credits ' + bk.length + ')', warn: Math.abs(v) >= 0.005 }; } },
    { key: 'squareRate', label: 'Square effective rate', baseline: '3.78%', target: '≤ 3.0% by Day 60', source: 'Square transactions import (ledger.js)',
      calc: function (w) { var L = ledgerState(); if (!L) return NA('ledger not loaded'); var ps = (L.squarePayments || []).filter(function (p) { return p && p.type === 'payment' && inW(w, p.date); }); if (!ps.length) return NA('no Square import this week'); var amt = ps.reduce(function (a, p) { return a + (Number(p.amount) || 0); }, 0), fees = ps.reduce(function (a, p) { return a + (Number(p.fee) || 0); }, 0); if (!(amt > 0)) return NA('Square sales total is zero'); var v = fees / amt * 100; return { value: v, text: (Math.round(v * 100) / 100) + '% (' + money(fees) + ' fees on ' + money(amt) + ')', warn: v > 3.0 }; } },
    { key: 'activeCallers', label: 'Active callers / month', baseline: '758 (2026 H1 avg)', target: '≥ 800 by February', source: 'console trips (distinct phones in the month)',
      calc: function (w) { var ym = w.from.slice(0, 7), set = {}; var any = false; trips().forEach(function (t) { if (!t || t._hist || String(t.date || '').slice(0, 7) !== ym) return; if (t.status === 'Canceled' || t.status === 'Disregard') return; any = true; var k = String(t.phone || '').replace(/\D/g, '').slice(-10); if (k) set[k] = 1; }); if (!any) return NA('no trips in ' + ym); var n = Object.keys(set).length; return { value: n, text: n + ' distinct callers in ' + ym }; } }
  ];
  function scorecard(anchor) {
    var w = weekOf(anchor), P = plan(), rows = METRICS.map(function (m) {
      var r; try { r = m.calc(w) || NA(); } catch (e) { r = NA('error: ' + (e && e.message)); }
      var tg = P.scorecard.targets[m.key] || {};
      return { key: m.key, label: m.label, source: m.source, baseline: tg.baseline != null ? tg.baseline : m.baseline, target: tg.target != null ? tg.target : m.target, actual: r.text, value: r.value, na: !!r.na, warn: !!r.warn };
    });
    return { from: w.from, to: w.to, elapsed: w.elapsed, rows: rows, filled: rows.filter(function (r) { return !r.na; }).length };
  }
  function saveWeek(anchor) {
    var sc = scorecard(anchor), P = plan(), vals = {};
    sc.rows.forEach(function (r) { vals[r.key] = r.actual; });
    P.scorecard.weeks[sc.from] = { from: sc.from, to: sc.to, savedAt: nowISO(), values: vals };
    save(); return P.scorecard.weeks[sc.from];
  }
  function scorecardCSV(anchor, dl) {
    var sc = scorecard(anchor), lines = [csvLine(['week_from', 'week_to', 'metric', 'baseline', 'pilot_target', 'actual', 'source'])];
    sc.rows.forEach(function (r) { lines.push(csvLine([sc.from, sc.to, r.label, r.baseline, r.target, r.actual, r.source])); });
    var txt = lines.join('\r\n') + '\r\n';
    if (dl !== false) download('skyway-scorecard-' + sc.from + '.csv', txt, 'text/csv');
    return txt;
  }
  function setTarget(key, field, val) { var P = plan(); if (!P.scorecard.targets[key]) P.scorecard.targets[key] = {}; if (field === 'baseline' || field === 'target') { P.scorecard.targets[key][field] = String(val == null ? '' : val); save(); return true; } return false; }

  /* ---------- 13-week cash (workbook formulas) ---------- */
  function cashRows(opts) {
    var C = plan().cash13, noRides = !!(opts && opts.noRides);
    var opening = num(C.opening), reserve = num(C.reserve), prev = opening, out = [];
    C.weeks.forEach(function (wk) {
      var vals = {}, complete = true;
      CASH_COLS.forEach(function (col) { var v = num(wk[col[0]]); if (noRides && col[0] === 'c') v = v == null ? null : 0; vals[col[0]] = v; if (v == null) complete = false; });
      var net = complete ? r6(vals.c + vals.d + vals.e - vals.f - vals.g - vals.h - vals.i - vals.j) : null;   // full precision like the workbook; rounded only for display
      var open = prev, end = (open != null && net != null) ? r6(open + net) : null;
      var status = end == null ? 'Inputs missing' : end < 0 ? 'Cash shortfall' : reserve == null ? 'Set reserve floor' : end < reserve ? 'Below reserve' : 'Meets reserve';
      out.push({ weekOf: wk.weekOf, opening: open, vals: vals, net: net, ending: end, status: status, rides: wk.rides, note: wk.note || '' });
      prev = end;
    });
    return out;
  }
  function cash13() {
    var rows = cashRows(), flat = cashRows({ noRides: true });
    rows.forEach(function (r, i) { r.endingNoRides = flat[i].ending; });
    var C = plan().cash13, low = null, below = 0;
    rows.forEach(function (r) { if (r.ending != null) { if (low == null || r.ending < low) low = r.ending; if (r.status !== 'Meets reserve') below++; } });
    return { opening: num(C.opening), reserve: num(C.reserve), retained: num(C.retained), rows: rows, lowest: low, weeksNotMeeting: below, allMeet: rows.every(function (r) { return r.status === 'Meets reserve'; }) };
  }
  function setCash(idx, col, val) {
    var C = plan().cash13, wk = C.weeks[idx]; if (!wk) return false;
    if (col === 'note') { wk.note = String(val || ''); save(); return true; }
    if (col === 'rides') { var n = num(val); wk.rides = n; if (n != null) wk.c = r6(n * 7 * (num(C.retained) || 0)); save(); return true; }
    if (!CASH_COLS.some(function (c) { return c[0] === col; })) return false;
    var v = num(val); wk[col] = v == null ? null : round2(v); save(); return true;
  }
  function setCashTop(field, val) {
    var C = plan().cash13;
    if (field === 'opening' || field === 'reserve') { C[field] = num(val); C.asOf = todayStr(); }
    else if (field === 'retained') { var old = num(C.retained) || 0; C.retained = num(val); C.weeks.forEach(function (wk) { if (wk.rides == null || num(wk.rides) == null) return; var wasC = r6(num(wk.rides) * 7 * old); if (wk.c == null || Math.abs(Number(wk.c) - wasC) < 0.005) wk.c = r6(num(wk.rides) * 7 * (C.retained || 0)); }); }   // a typed Base-fees-in actual is kept
    else return false;
    save(); return true;
  }
  /* Puts the plan's estimates back in every week; the owner's counted opening cash, the typed private inputs and the Operating math inputs are kept. */
  function resetCash() { var P = plan(), C = P.cash13; P.cash13 = seedCash({ opening: C.opening, inputs: C.inputs, opmath: C.opmath }); save(); return P.cash13; }
  function cashCSV(dl) {
    var K = cash13(), lines = [];
    lines.push(csvLine(['13-week cash forecast', 'Skyway', 'exported ' + todayStr()]));
    lines.push(csvLine(['Opening cash', K.opening == null ? '' : K.opening]));
    lines.push(csvLine(['Minimum reserve', K.reserve == null ? '' : K.reserve]));
    lines.push(csvLine(['Week of', 'Opening'].concat(CASH_COLS.map(function (c) { return c[1]; })).concat(['Net change', 'Ending cash', 'Cash check', 'Notes / due dates', 'Extra rides / day', 'Ending, no new rides'])));
    K.rows.forEach(function (r) {
      var r4 = function (v) { return v == null ? '' : Math.round(v * 1e4) / 1e4; };
      lines.push(csvLine([r.weekOf, r4(r.opening)].concat(CASH_COLS.map(function (c) { return r4(r.vals[c[0]]); })).concat([r4(r.net), r4(r.ending), r.status, r.note, r.rides == null ? '' : r.rides, r4(r.endingNoRides)])));
    });
    var txt = lines.join('\r\n') + '\r\n';
    if (dl !== false) download('skyway-cash13-' + (K.rows[0] ? K.rows[0].weekOf : todayStr()) + '.csv', txt, 'text/csv');
    return txt;
  }
  /* Operating math sheet: payroll uplift, cash before new rides, the four scenarios */
  function opMath(inputs) {
    var C = plan().cash13, ov = inputs || {}, o = Object.assign({}, OPMATH_SEED, C.opmath || {}, ov);
    var base = num(ov.baselineCash);                                        // an explicit override wins,
    if (base == null) base = num((C.inputs || {}).baselineNet);             // then the typed private input,
    if (base == null) base = num((C.opmath || {}).baselineCash);            // then a legacy value typed in the old Operating math box
    o.baselineCash = base;
    var payrollUp = round2((o.newWage * o.newHours * (1 + o.burden) - o.oldPay * o.oldHours) * 52 / 12);
    var gap = base == null ? null : round2(base + o.savings - o.software - payrollUp);
    var rows = SCENARIOS.map(function (s) {
      var added = round2(s[1] * s[2] * o.days), cash = gap == null ? null : round2(gap + added);
      var cover = gap == null ? null : gap >= 0 ? 0 : (s[2] > 0 ? Math.ceil(-gap / (o.days * s[2])) : 'Needs other income');
      return { name: s[0], ridesPerDay: s[1], retained: s[2], added: added, cash: cash, ridesToCover: cover };
    });
    return { inputs: o, payrollUp: payrollUp, gap: gap, rows: rows, missing: base == null };
  }
  function setOpMath(field, val) {
    if (field === 'baselineCash') return setInput('baselineNet', val);   // same figure, kept under its old name for callers
    var o = plan().cash13.opmath; if (!(field in OPMATH_SEED)) return false; var n = num(val); if (n == null) return false; o[field] = n; save(); return true;
  }

  /* ---------- five-route test ---------- */
  function cellKey(r, w, d) { return r + '|' + w + '|' + d; }
  function cell(r, w, d) { var R = plan().routeTest, k = cellKey(r, w, d); if (!R.cells[k]) R.cells[k] = {}; return R.cells[k]; }
  function median2(a, b) { if (a != null && b != null) return (a + b) / 2; return a != null ? a : b; }
  function scoreCell(route, win, c) {
    c = c || {};
    var uber = num(c.uber), lyft = num(c.lyft), sky = num(c.skyway), med = median2(uber, lyft);
    /* the exact ratio decides pass / fail (1.104 is over the 1.10 limit); round2 is for display only */
    var limit = win.peak ? 1.00 : 1.10, exact = (sky != null && med != null && med > 0) ? sky / med : null, ratio = exact == null ? null : round2(exact);
    var minC = CONTRIB_MIN[route.kind] != null ? CONTRIB_MIN[route.kind] : 6;
    var ret = num(c.retained); var computed = false;
    if (ret == null && sky != null && sky > 0) { ret = round2(tierFee(sky) - squareCost(sky, 'card', 'tap')); computed = true; }
    var elig = c.eligible === 'yes' ? true : c.eligible === 'no' ? false : null;
    var price = exact == null ? null : exact <= limit + 1e-9, contrib = ret == null ? null : ret >= minC - 1e-9;
    var complete = price != null && contrib != null && elig != null;
    var pass = complete && price && contrib && elig;
    return { uber: uber, lyft: lyft, curb: num(c.curb), phone1: num(c.phone1), phone2: num(c.phone2), skyway: sky, median: med == null ? null : round2(med), ratio: ratio, limit: limit, retained: ret, retainedComputed: computed, minContribution: minC, eligible: elig,
      pricePass: price, contribPass: contrib, eligiblePass: elig, complete: complete, pass: pass, status: !complete ? 'incomplete' : pass ? 'pass' : 'fail',
      why: complete && !pass ? [price ? '' : 'price ' + (ratio <= limit ? exact.toFixed(3) : ratio.toFixed(2)) + ' > ' + limit.toFixed(2), contrib ? '' : 'contribution ' + money(ret) + ' < $' + minC, elig ? '' : 'no eligible driver'].filter(Boolean).join('; ') : '' };
  }
  function setCell(r, w, d, field, val) {
    var FIELDS = ['uber', 'lyft', 'curb', 'phone1', 'phone2', 'skyway', 'retained', 'eligible', 'notes', 'source'];
    if (FIELDS.indexOf(field) < 0) return false;
    var c = cell(r, w, d);
    if (field === 'eligible') c.eligible = val === 'yes' ? 'yes' : val === 'no' ? 'no' : '';
    else if (field === 'notes' || field === 'source') c[field] = String(val || '');
    else { var n = num(val); if (n == null) delete c[field]; else c[field] = round2(n); }
    c.at = nowISO(); save(); return true;
  }
  function routeGrid() {
    var R = plan().routeTest, out = { routes: [], dates: R.dates.slice(), windows: R.windows.slice(), phoneNames: R.phoneNames.slice(), cells: 0, complete: 0, pass: 0, fail: 0 };
    R.routes.forEach(function (route) {
      var rr = { id: route.id, name: route.name, kind: route.kind, windows: [] };
      R.windows.forEach(function (win) {
        var ww = { id: win.id, name: win.name, peak: !!win.peak, obs: [], passes: 0, fails: 0, complete: 0 };
        R.dates.forEach(function (d) {
          var raw = R.cells[cellKey(route.id, win.id, d)] || {}, s = scoreCell(route, win, raw);
          s.date = d; s.notes = raw.notes || ''; s.source = raw.source || '';
          ww.obs.push(s); out.cells++;
          if (s.complete) { ww.complete++; out.complete++; if (s.pass) { ww.passes++; out.pass++; } else { ww.fails++; out.fail++; } }
        });
        ww.verdict = ww.complete < R.dates.length ? 'Incomplete' : ww.fails ? 'Adjust ±$2 and re-test' : 'Adopt';
        rr.windows.push(ww);
      });
      out.routes.push(rr);
    });
    return out;
  }
  /* Changing a test date moves the quotes typed under the old date to the new one (cells are keyed by date), so nothing typed is orphaned.
     A cell that already exists under the new date is kept; the old one then stays in STATE untouched. Returns {moved} on success, false when
     refused: not four valid dates, or the same date twice (two rows would share one cell). */
  function datesOk(list) { return Array.isArray(list) && list.length === 4 && list.every(isDate) && list.filter(function (d, i) { return list.indexOf(d) === i; }).length === 4; }
  function setDates(list) {
    var R = plan().routeTest; if (!datesOk(list)) return false;
    var old = R.dates.slice(), moved = 0;
    old.forEach(function (od, i) {
      var nd = list[i]; if (!nd || nd === od || list.indexOf(od) >= 0) return;   // unchanged, or the old date still has a slot
      Object.keys(R.cells).forEach(function (k) {
        var parts = k.split('|'); if (parts.length !== 3 || parts[2] !== od) return;
        var nk = cellKey(parts[0], parts[1], nd);
        if (R.cells[nk] && Object.keys(R.cells[nk]).some(function (f) { return f !== 'at' && R.cells[nk][f] !== '' && R.cells[nk][f] != null; })) return;   // keep what is already typed under the new date
        R.cells[nk] = R.cells[k]; delete R.cells[k]; moved++;
      });
    });
    R.dates = list.slice(); save(); return { moved: moved };
  }
  function setPhoneName(i, name) { var R = plan().routeTest; if (i !== 0 && i !== 1) return false; R.phoneNames[i] = String(name || '').trim() || ('Phone quote ' + (i + 1)); save(); return true; }
  function clearRoutes() { plan().routeTest.cells = {}; save(); return true; }
  function routeCSV(dl) {
    var G = routeGrid(), lines = [csvLine(['route', 'kind', 'window', 'peak', 'date', 'uber', 'lyft', 'median_uber_lyft', 'curb', G.phoneNames[0], G.phoneNames[1], 'skyway_quote', 'skyway_source', 'price_ratio', 'price_limit', 'retained', 'min_contribution', 'eligible_driver', 'result', 'why', 'notes'])];
    G.routes.forEach(function (r) { r.windows.forEach(function (w) { w.obs.forEach(function (o) {
      lines.push(csvLine([r.name, r.kind, w.name, w.peak ? 'yes' : 'no', o.date, o.uber, o.lyft, o.median, o.curb, o.phone1, o.phone2, o.skyway, o.source, o.ratio, o.limit, o.retained, o.minContribution, o.eligible == null ? '' : (o.eligible ? 'yes' : 'no'), o.status, o.why, o.notes].map(function (v) { return v == null ? '' : v; })));
    }); }); });
    var txt = lines.join('\r\n') + '\r\n';
    if (dl !== false) download('skyway-route-test-' + G.dates[0] + '.csv', txt, 'text/csv');
    return txt;
  }

  /* ---------- styles ---------- */
  function ensureStyle() {
    if (byId('planStyle')) return;
    var st = document.createElement('style'); st.id = 'planStyle';
    st.textContent = [
      '.plan-panel .plan-tabs{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 10px;}',
      '.plan-panel .plan-tabs .btn.active{background:var(--green-dark,#15497d);color:#fff;}',
      '.plan-panel h4{margin:12px 0 4px;font-size:12.5px;color:var(--green-dark,#15497d);}',
      '.plan-panel .plan-sub{font-size:11px;color:var(--muted,#5b5b5b);margin:0 0 6px;}',
      '.plan-panel .plan-row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:4px 0 8px;}',
      '.plan-panel .plan-row .fld{margin:0;} .plan-panel .plan-row input[type=number],.plan-panel .plan-row input[type=date]{width:130px;}',
      '.plan-panel .tbl-scroll{max-height:none;overflow-x:auto;}',
      '.plan-panel table.data td.num,.plan-panel table.data th.num{text-align:right;white-space:nowrap;}',
      '.plan-panel table.data input.plan-in{width:84px;text-align:right;font-size:12px;padding:2px 4px;}',
      '.plan-panel table.data input.plan-txt{width:150px;font-size:12px;padding:2px 4px;}',
      '.plan-panel table.data select.plan-sel{font-size:12px;padding:2px 2px;}',
      '.plan-panel .plan-na{color:var(--muted,#6b6b6b);font-style:italic;}',
      '.plan-panel .plan-ok{color:#1f7a3d;font-weight:700;} .plan-panel .plan-bad{color:#c0392b;font-weight:700;} .plan-panel .plan-mid{color:#7a5a06;font-weight:700;}',
      '.plan-panel .stat.plan-warn-t{border-top-color:#c0392b;} .plan-panel .stat.plan-ok-t{border-top-color:#1f7a3d;}',
      '.plan-panel .plan-chip{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:10px;background:rgba(120,140,160,.14);margin-left:4px;white-space:nowrap;}',
      '.plan-panel .plan-chip.pass{background:rgba(31,122,61,.14);color:#1f7a3d;} .plan-panel .plan-chip.fail{background:rgba(192,57,43,.12);color:#9b2d20;} .plan-panel .plan-chip.inc{background:rgba(214,158,20,.14);color:#7a5a06;}',
      '.plan-panel tr.plan-route-head td{background:rgba(120,140,160,.08);font-weight:700;}',
      '.plan-warn{margin:6px 0 0;padding:6px 10px;border:1px solid #c0392b;border-radius:4px;background:rgba(192,57,43,.08);color:#9b2d20;font-weight:700;font-size:12px;}',
      'body.gold .plan-panel h4{color:#e8c75a;} body.gold .plan-warn{color:#f0a89f;} body.classic .plan-panel h4{color:#0a246a;}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }

  /* ---------- panel ---------- */
  var PANEL_ID = 'planPanel';
  var ui = { tab: 'scorecard', week: '', route: 'a' };
  function ensurePanel() {
    var view = byId('view-biz'); if (!view) return null;
    var p = byId(PANEL_ID);
    if (!p) { p = document.createElement('div'); p.id = PANEL_ID; p.className = 'panel plan-panel'; view.appendChild(p); p.addEventListener('click', act(onClick)); p.addEventListener('change', act(onChange)); p.addEventListener('focusout', act(onFocusOut)); }
    return p;
  }
  function tile(v, k, cls) { return '<div class="stat' + (cls ? ' ' + cls : '') + '"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>'; }
  function restricted() { try { if (window.Recover && typeof window.Recover.who === 'function' && typeof window.Recover.role === 'function') { return !!window.Recover.who() && window.Recover.role() === 'dispatcher'; } } catch (e) {} return false; }
  function tabBtn(id, label) { return '<button class="btn btn-ghost btn-sm' + (ui.tab === id ? ' active' : '') + '" type="button" data-act="tab" data-tab="' + id + '">' + esc(label) + '</button>'; }
  /* The panel is rebuilt with innerHTML. While a bookkeeper is typing in one of its inputs, a rebuild that comes from outside
     (renderBiz on a remote save, reloadFromStorage, region change) is deferred until the field loses focus; our own UI
     actions pass force and re-focus the equivalent input afterwards (same id or data-* attributes) so Tab order survives. */
  var deferred = false;
  function focusedField() {
    var a = document.activeElement, p = byId(PANEL_ID);
    if (!a || !p || !p.contains(a) || !/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return null;
    return a;
  }
  function fieldSelector(el) {
    if (el.id) return '#' + el.id;
    var sel = el.tagName.toLowerCase(), n = 0;
    for (var i = 0; i < el.attributes.length; i++) { var at = el.attributes[i]; if (/^data-/.test(at.name)) { sel += '[' + at.name + '="' + String(at.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]'; n++; } }
    return n ? sel : null;
  }
  function render(force) {
    var panel = ensurePanel(); if (!panel) return;
    var fld = focusedField();
    if (fld && !force) { deferred = true; return; }      // keep the field the bookkeeper is typing in
    deferred = false;
    var refocus = fld ? { sel: fieldSelector(fld), start: null, end: null } : null;
    if (refocus) { try { refocus.start = fld.selectionStart; refocus.end = fld.selectionEnd; } catch (e) {} }
    renderNow(panel);
    if (refocus && refocus.sel) {
      try { var again = panel.querySelector(refocus.sel); if (again) { again.focus({ preventScroll: true }); if (refocus.start != null) { try { again.setSelectionRange(refocus.start, refocus.end); } catch (e) {} } } } catch (e) {}
    }
  }
  function onFocusOut() { if (!deferred) return; setTimeout(function () { try { if (deferred && !focusedField()) render(true); } catch (e) {} }, 0); }
  function renderNow(panel) {
    ensureStyle(); plan();
    var h = '<div class="panel-head">Plan <span class="hint" style="margin:0;font-weight:400;">weekly scorecard &middot; 13-week cash &middot; five-route price test &middot; owner and bookkeeper</span></div><div class="panel-body">';
    if (restricted()) { h += '<div class="hint" id="plan_restricted" style="margin:0;">The Plan panel is for the owner and the bookkeeper. Sign in with an owner or bookkeeper PIN (Settings &rarr; Staff, access &amp; activity) to open it.</div></div>'; panel.innerHTML = h; return; }
    h += '<div class="plan-tabs" id="plan_tabs">' + tabBtn('scorecard', 'Weekly scorecard') + tabBtn('cash', '13-week cash') + tabBtn('routes', 'Five-route test') + '</div>';
    h += ui.tab === 'cash' ? cashHtml() : ui.tab === 'routes' ? routesHtml() : scorecardHtml();
    h += '</div>';
    panel.innerHTML = h;
  }
  function scorecardHtml() {
    var sc = scorecard(ui.week), saved = plan().scorecard.weeks[sc.from];
    var h = '<div class="plan-row"><label class="fld"><span class="lbl">Any day in the week</span><input type="date" id="plan_week" value="' + esc(ui.week || todayStr()) + '"></label>'
      + '<button class="btn btn-navy btn-sm" type="button" data-act="week">Show week</button>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="sc_save" title="Keep this week\'s numbers for the Friday review">Save this week</button>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="sc_csv">Export CSV</button>'
      + '<span class="hint" style="margin:0;">Week ' + esc(sc.from) + ' to ' + esc(sc.to) + ' &middot; ' + sc.filled + ' of ' + sc.rows.length + ' metrics have data' + (saved ? ' &middot; saved ' + esc(dateOf(saved.savedAt)) : '') + '</span></div>';
    h += '<div class="plan-sub">Baseline and target are editable (seeded from the plan). A metric whose source is not in the console yet reads "n/a" instead of 0. Promised pickup window: <input type="number" id="plan_window" class="plan-in" min="1" max="120" value="' + esc(plan().scorecard.promisedWindowMin) + '" style="width:60px;"> min.</div>';
    h += '<div class="tbl-scroll"><table class="data" id="plan_scorecard"><thead><tr><th>Metric</th><th>Baseline</th><th>Pilot target</th><th>This week</th><th>Source</th></tr></thead><tbody>';
    sc.rows.forEach(function (r) {
      h += '<tr data-metric="' + esc(r.key) + '"><td>' + esc(r.label) + '</td>'
        + '<td><input type="text" class="plan-txt" data-field="baseline" data-key="' + esc(r.key) + '" value="' + esc(r.baseline) + '"></td>'
        + '<td><input type="text" class="plan-txt" data-field="target" data-key="' + esc(r.key) + '" value="' + esc(r.target) + '"></td>'
        + '<td class="' + (r.na ? 'plan-na' : r.warn ? 'plan-bad' : '') + '" data-actual="' + esc(r.key) + '">' + esc(r.actual) + '</td>'
        + '<td class="hint" style="margin:0;">' + esc(r.source) + '</td></tr>';
    });
    h += '</tbody></table></div>';
    var keys = Object.keys(plan().scorecard.weeks).sort();
    if (keys.length) h += '<div class="hint" style="margin:6px 0 0;">Saved weeks: ' + keys.map(function (k) { return esc(k); }).join(', ') + '.</div>';
    return h;
  }
  function cashHtml() {
    var K = cash13(), C = plan().cash13, M = opMath();
    var h = '<div class="plan-row"><label class="fld"><span class="lbl">Opening cash (counted)</span><input type="number" step="0.01" id="plan_opening" data-cashtop="opening" value="' + esc(K.opening == null ? '' : K.opening) + '"></label>'
      + '<label class="fld"><span class="lbl">Minimum reserve</span><input type="number" step="1" id="plan_reserve" data-cashtop="reserve" value="' + esc(K.reserve == null ? '' : K.reserve) + '"></label>'
      + '<label class="fld"><span class="lbl">Retained per extra ride</span><input type="number" step="0.01" id="plan_retained" data-cashtop="retained" value="' + esc(K.retained == null ? '' : K.retained) + '"></label>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="cash_csv">Export CSV</button>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="cash_reset" title="Owner PIN — puts the plan\'s estimates back in every cell">Reset to plan inputs</button></div>';
    var I = C.inputs || blankInputs(), missingIn = PRIVATE_INPUTS.filter(function (p) { return num(I[p[0]]) == null; }).map(function (p) { return p[1]; });
    if (K.opening == null) missingIn.unshift('Opening cash');
    h += '<div class="plan-row" id="plan_inputs">';
    PRIVATE_INPUTS.forEach(function (p) { h += '<label class="fld" title="' + esc(p[2]) + '"><span class="lbl">' + esc(p[1]) + '</span><input type="number" step="0.01" id="plan_in_' + esc(p[0]) + '" data-input="' + esc(p[0]) + '" value="' + esc(I[p[0]] == null ? '' : I[p[0]]) + '" placeholder="type the figure"></label>'; });
    h += '</div>';
    h += '<div class="plan-sub" id="plan_inputs_hint">' + (missingIn.length
      ? '<b>Inputs missing:</b> ' + esc(missingIn.join(', ')) + '. These come from the bank statement and the payroll run and are typed here on this station (never stored in the app\'s files). Until they are in, every week reads "Inputs missing".'
      : 'Bank and payroll inputs typed ' + esc(C.asOf || '') + '. They fill Customer cash (D), Driver fare &amp; tips (F = D − baseline net) and Payroll (G) for every week; type over any week\'s cell to enter an actual.') + '</div>';
    h += '<div class="stat-row" id="plan_cash_kpis">' + tile(K.lowest == null ? 'n/a' : dollars(K.lowest), 'Lowest ending cash', K.lowest == null ? '' : K.lowest < (K.reserve || 0) ? 'plan-warn-t' : 'plan-ok-t') + tile(K.lowest == null ? 'n/a' : String(K.weeksNotMeeting), 'Weeks not meeting the reserve', K.lowest == null ? '' : K.weeksNotMeeting ? 'plan-warn-t' : 'plan-ok-t') + tile(K.lowest == null ? 'n/a' : K.allMeet ? 'Yes' : 'No', 'Port / move / new subscription allowed (reserve met 13 weeks)', K.lowest == null ? '' : K.allMeet ? 'plan-ok-t' : 'plan-warn-t') + '</div>';
    h += '<div class="plan-sub">Mirrors the workbook "13 week cash": Net change = Base fees in + Customer cash + Other cash in − Driver fare &amp; tips − Payroll − Space/phone/tech − Insurance/other − One-time, only when all eight cells are filled (type 0 for a verified zero). Plan estimates seeded (' + esc(C.source || 'cash13.md') + '); the bookkeeper replaces them with actuals each Friday.</div>';
    h += '<div class="tbl-scroll"><table class="data" id="plan_cash"><thead><tr><th>Week of</th><th class="num">Opening</th><th class="num" title="extra paid rides per day; sets Base fees in = rides × 7 × retained">Rides/day</th>';
    CASH_COLS.forEach(function (c) { h += '<th class="num" title="' + esc(c[3]) + '">' + esc(c[1]) + (c[2] === 'in' ? ' (+)' : ' (−)') + '</th>'; });
    h += '<th class="num">Net change</th><th class="num">Ending cash</th><th>Cash check</th><th class="num" title="same inputs with Base fees in = 0 (flat weekly driver fee case)">Ending, no new rides</th><th>Notes</th></tr></thead><tbody>';
    K.rows.forEach(function (r, i) {
      var cls = r.status === 'Meets reserve' ? 'plan-ok' : r.status === 'Inputs missing' ? 'plan-mid' : 'plan-bad';
      h += '<tr data-week="' + esc(r.weekOf) + '"><td>' + esc(r.weekOf) + '</td><td class="num">' + (r.opening == null ? '—' : esc(dollars(r.opening))) + '</td>'
        + '<td class="num"><input type="number" step="1" min="0" class="plan-in" style="width:56px;" data-cash="rides" data-idx="' + i + '" value="' + esc(r.rides == null ? '' : r.rides) + '"></td>';
      CASH_COLS.forEach(function (c) { var v = r.vals[c[0]]; h += '<td class="num"><input type="number" step="0.01" class="plan-in" data-cash="' + c[0] + '" data-idx="' + i + '" value="' + esc(v == null ? '' : round2(v)) + '" placeholder="blank"></td>'; });
      h += '<td class="num">' + (r.net == null ? '—' : esc(dollars(r.net))) + '</td><td class="num"><b>' + (r.ending == null ? '—' : esc(dollars(r.ending))) + '</b></td><td class="' + cls + '" data-status="' + esc(r.weekOf) + '">' + esc(r.status) + '</td>'
        + '<td class="num">' + (r.endingNoRides == null ? '—' : esc(dollars(r.endingNoRides))) + '</td>'
        + '<td><input type="text" class="plan-txt" data-cash="note" data-idx="' + i + '" value="' + esc(r.note) + '"></td></tr>';
    });
    h += '</tbody></table></div>';
    h += '<h4>Operating math <span class="hint" style="margin:0;font-weight:400;">&mdash; monthly scenarios from the owner\'s plan (PDF p. 2); edit the inputs to restate</span></h4>';
    var O = M.inputs, inp = function (k, step, label) { return '<label class="fld"><span class="lbl">' + esc(label) + '</span><input type="number" step="' + step + '" class="plan-in" style="width:90px;" data-opmath="' + k + '" value="' + esc(O[k]) + '"></label>'; };
    h += '<div class="plan-row" id="plan_opmath">' + inp('oldPay', '0.5', 'Old hourly pay') + inp('oldHours', '1', 'Old weekly hours') + inp('newWage', '0.5', 'New hourly wage') + inp('newHours', '1', 'New weekly hours') + inp('burden', '0.01', 'Employer costs (fraction)') + inp('savings', '1', 'Verified savings / mo') + inp('software', '1', 'Added phone / software / mo') + inp('days', '1', 'Operating days / mo') + '</div>';
    h += '<div class="plan-sub">Baseline monthly cash change: ' + (M.missing ? '<b>not typed yet</b> — enter "Baseline operating net / month" above.' : esc(dollars(O.baselineCash)) + ' (the private input above).') + '</div>';
    h += '<div class="stat-row" id="plan_opmath_kpis">' + tile(dollars(-M.payrollUp), 'Higher monthly payroll vs old wages') + tile(M.gap == null ? 'n/a' : dollars(M.gap), 'Cash before new ride contribution', M.gap == null ? '' : M.gap < 0 ? 'plan-warn-t' : 'plan-ok-t') + '</div>';
    h += '<div class="tbl-scroll"><table class="data" id="plan_scenarios"><thead><tr><th>Cash scenario</th><th class="num">Extra rides / day</th><th class="num">Retained / ride</th><th class="num">Added / month</th><th class="num">Modeled cash / mo</th><th class="num">Whole rides/day to cover gap</th></tr></thead><tbody>';
    M.rows.forEach(function (r) { h += '<tr data-scenario="' + esc(r.name) + '"><td>' + esc(r.name) + '</td><td class="num">' + r.ridesPerDay + '</td><td class="num">' + esc(money(r.retained)) + '</td><td class="num">' + esc(dollars(r.added)) + '</td><td class="num ' + (r.cash == null ? 'plan-na' : r.cash >= 0 ? 'plan-ok' : 'plan-bad') + '">' + (r.cash == null ? 'n/a (inputs missing)' : esc(dollars(r.cash))) + '</td><td class="num">' + (r.ridesToCover == null ? '—' : esc(String(r.ridesToCover))) + '</td></tr>'; });
    h += '</tbody></table></div>';
    return h;
  }
  function routesHtml() {
    var G = routeGrid(), R = plan().routeTest;
    var h = '<div class="plan-row">';
    G.dates.forEach(function (d, i) { h += '<label class="fld"><span class="lbl">Date ' + (i + 1) + '</span><input type="date" class="plan-date" data-date="' + i + '" value="' + esc(d) + '"></label>'; });
    h += '<label class="fld"><span class="lbl">Phone quote 1 (livery)</span><input type="text" class="plan-txt" data-phone="0" value="' + esc(G.phoneNames[0]) + '"></label><label class="fld"><span class="lbl">Phone quote 2 (livery)</span><input type="text" class="plan-txt" data-phone="1" value="' + esc(G.phoneNames[1]) + '"></label>'
      + '<button class="btn btn-ghost btn-sm" type="button" data-act="rt_csv">Export CSV</button><button class="btn btn-ghost btn-sm" type="button" data-act="rt_clear" title="Owner PIN — empties every cell">Clear log</button></div>';
    h += '<div class="stat-row" id="plan_rt_kpis">' + tile(G.complete + ' / ' + G.cells, 'Cells recorded') + tile(String(G.pass), 'Pass', G.pass ? 'plan-ok-t' : '') + tile(String(G.fail), 'Fail', G.fail ? 'plan-warn-t' : '') + '</div>';
    h += '<div class="plan-sub">Quote every provider within 10 minutes of the Skyway console quote, confirmation-step totals, never accept a ride. Pass rules per cell: price = Skyway &divide; median(Uber, Lyft) &le; 1.00 at 5 pm and &le; 1.10 off-peak / Saturday; contribution &ge; $6 airport / Manhattan and &ge; $4 local (tier fee &minus; Square tap 2.6% + 15&cent;, or type the actual); an eligible driver and vehicle available for the slot.</div>';
    h += '<div class="plan-tabs" id="plan_route_tabs">' + G.routes.map(function (r) { return '<button class="btn btn-ghost btn-sm' + (ui.route === r.id ? ' active' : '') + '" type="button" data-act="route" data-route="' + esc(r.id) + '">(' + esc(r.id) + ') ' + esc(r.name.split(' (')[0]) + '</button>'; }).join('') + '</div>';
    var route = G.routes.filter(function (r) { return r.id === ui.route; })[0] || G.routes[0];
    h += '<h4>(' + esc(route.id) + ') ' + esc(route.name) + ' <span class="plan-chip">' + esc(route.kind) + ' &middot; min contribution $' + CONTRIB_MIN[route.kind] + '</span></h4>';
    h += '<div class="tbl-scroll"><table class="data" id="plan_routes"><thead><tr><th>Window</th><th>Date</th><th class="num">Uber</th><th class="num">Lyft</th><th class="num">Curb</th><th class="num">' + esc(G.phoneNames[0]) + '</th><th class="num">' + esc(G.phoneNames[1]) + '</th><th class="num">Skyway quote</th><th class="num" title="Skyway ÷ median(Uber, Lyft)">Price</th><th class="num" title="tier fee − Square tap; type to override">Retained</th><th>Eligible driver</th><th>Result</th><th>Notes</th></tr></thead><tbody>';
    route.windows.forEach(function (w) {
      h += '<tr class="plan-route-head"><td colspan="13">' + esc(w.name) + (w.peak ? ' (peak, price limit 1.00)' : ' (off-peak, price limit 1.10)') + ' &middot; ' + w.passes + ' pass / ' + w.fails + ' fail / ' + (G.dates.length - w.complete) + ' open &middot; <span class="plan-chip ' + (w.verdict === 'Adopt' ? 'pass' : w.verdict === 'Incomplete' ? 'inc' : 'fail') + '">' + esc(w.verdict) + '</span></td></tr>';
      w.obs.forEach(function (o) {
        var a = 'data-r="' + esc(route.id) + '" data-w="' + esc(w.id) + '" data-d="' + esc(o.date) + '"';
        var inN = function (f, v) { return '<td class="num"><input type="number" step="0.01" min="0" class="plan-in" data-cell="' + f + '" ' + a + ' value="' + esc(v == null ? '' : v) + '"></td>'; };
        h += '<tr data-cell-row="' + esc(cellKey(route.id, w.id, o.date)) + '"><td>' + esc(w.name) + '</td><td>' + esc(o.date) + '</td>' + inN('uber', o.uber) + inN('lyft', o.lyft) + inN('curb', o.curb) + inN('phone1', o.phone1) + inN('phone2', o.phone2) + inN('skyway', o.skyway)
          + '<td class="num ' + (o.pricePass == null ? '' : o.pricePass ? 'plan-ok' : 'plan-bad') + '">' + (o.ratio == null ? '—' : esc(o.ratio.toFixed(2))) + '</td>'
          + '<td class="num"><input type="number" step="0.01" class="plan-in" data-cell="retained" ' + a + ' value="' + esc(o.retainedComputed || o.retained == null ? '' : o.retained) + '" placeholder="' + esc(o.retained == null ? '' : o.retained.toFixed(2)) + '"><div class="hint ' + (o.contribPass == null ? '' : o.contribPass ? 'plan-ok' : 'plan-bad') + '" style="margin:0;font-size:10px;">' + (o.retained == null ? '' : esc(money(o.retained)) + (o.retainedComputed ? ' est.' : '')) + '</div></td>'
          + '<td><select class="plan-sel" data-cell="eligible" ' + a + '><option value=""' + (o.eligible == null ? ' selected' : '') + '>—</option><option value="yes"' + (o.eligible === true ? ' selected' : '') + '>yes</option><option value="no"' + (o.eligible === false ? ' selected' : '') + '>no</option></select></td>'
          + '<td><span class="plan-chip ' + (o.status === 'pass' ? 'pass' : o.status === 'fail' ? 'fail' : 'inc') + '" title="' + esc(o.why) + '">' + esc(o.status) + '</span>' + (o.why ? '<div class="hint" style="margin:0;font-size:10px;">' + esc(o.why) + '</div>' : '') + '</td>'
          + '<td><input type="text" class="plan-txt" data-cell="notes" ' + a + ' value="' + esc(o.notes) + '" placeholder="lead time, pickup promise, source"></td></tr>';
      });
    });
    h += '</tbody></table></div>';
    return h;
  }
  function onClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-act');
    if (a === 'tab') { ui.tab = b.getAttribute('data-tab') || 'scorecard'; render(true); }
    else if (a === 'week') { var v = (byId('plan_week') || {}).value; ui.week = isDate(v) ? v : ''; render(true); }
    else if (a === 'sc_save') { var s = saveWeek(ui.week); toast('Scorecard for the week of ' + s.from + ' saved.'); render(true); }
    else if (a === 'sc_csv') { scorecardCSV(ui.week); toast('Scorecard CSV downloaded.'); }
    else if (a === 'cash_csv') { cashCSV(); toast('13-week cash CSV downloaded (workbook column order).'); }
    else if (a === 'cash_reset') { if (!ownerPin('reset the cash sheet')) return; if (!window.confirm('Put the plan\'s estimates back in every cell of the 13-week cash sheet? Typed actuals are lost.')) return; resetCash(); toast('Cash sheet reset to the plan inputs.'); render(true); }
    else if (a === 'rt_csv') { routeCSV(); toast('Route test CSV downloaded.'); }
    else if (a === 'rt_clear') { if (!ownerPin('clear the route test log')) return; if (!window.confirm('Clear every quote in the five-route test log?')) return; clearRoutes(); toast('Route test log cleared.'); render(true); }
    else if (a === 'route') { ui.route = b.getAttribute('data-route') || 'a'; render(true); }
  }
  function onChange(e) {
    var el = e.target; if (!el || !el.getAttribute) return;
    if (el.id === 'plan_window') { var n = num(el.value); if (n != null && n > 0) { plan().scorecard.promisedWindowMin = Math.round(n); save(); render(true); } return; }
    if (el.getAttribute('data-field') && el.getAttribute('data-key')) { setTarget(el.getAttribute('data-key'), el.getAttribute('data-field'), el.value); return; }
    if (el.getAttribute('data-cashtop')) { setCashTop(el.getAttribute('data-cashtop'), el.value); render(true); return; }
    if (el.getAttribute('data-cash')) { setCash(Number(el.getAttribute('data-idx')), el.getAttribute('data-cash'), el.value); render(true); return; }
    if (el.getAttribute('data-opmath')) { setOpMath(el.getAttribute('data-opmath'), el.value); render(true); return; }
    if (el.getAttribute('data-cell')) { setCell(el.getAttribute('data-r'), el.getAttribute('data-w'), el.getAttribute('data-d'), el.getAttribute('data-cell'), el.value); render(true); return; }
    if (el.getAttribute('data-date') != null && el.classList.contains('plan-date')) {
      var R = plan().routeTest, list = R.dates.slice(); list[Number(el.getAttribute('data-date'))] = el.value;
      if (setDates(list)) render(true);
      else { toast(list.every(isDate) ? 'Enter four different dates.' : 'Enter four dates.', true); render(true); }   // the rebuild puts the kept date back in the field
      return;
    }
    if (el.getAttribute('data-input')) { setInput(el.getAttribute('data-input'), el.value); render(true); return; }
    if (el.getAttribute('data-phone') != null) { setPhoneName(Number(el.getAttribute('data-phone')), el.value); render(true); return; }
  }
  function bizActive() { var v = byId('view-biz'); return !!(v && v.classList.contains('active')); }

  /* ---------- public API ---------- */
  window.Plan = {
    _loaded: true, METRICS: METRICS.map(function (m) { return { key: m.key, label: m.label, baseline: m.baseline, target: m.target, source: m.source }; }),
    CASH_COLS: CASH_COLS, PRIVATE_INPUTS: PRIVATE_INPUTS.map(function (p) { return p.slice(); }), RETAINED_FLOOR: RETAINED_FLOOR, CONTRIB_MIN: CONTRIB_MIN,
    state: plan, render: render, show: function (tab) { if (tab) ui.tab = tab; render(true); },
    weekOf: weekOf, scorecard: scorecard, saveWeek: saveWeek, scorecardCSV: scorecardCSV, setTarget: setTarget,
    retained: retained, tripContribution: tripContribution, tierFee: tierFee, squareCost: squareCost, renderBookWarn: renderBookWarn,
    cash13: cash13, cashRows: cashRows, setCash: setCash, setCashTop: setCashTop, setInput: setInput, resetCash: resetCash, cashCSV: cashCSV, seedCash: seedCash, opMath: opMath, setOpMath: setOpMath,
    routeGrid: routeGrid, scoreCell: scoreCell, setCell: setCell, setDates: setDates, setPhoneName: setPhoneName, clearRoutes: clearRoutes, routeCSV: routeCSV
  };

  /* ---------- boot ---------- */
  function boot() {
    try { ensureStyle(); } catch (e) {}
    try { plan(); } catch (e) { try { console.error('[plan]', e); } catch (e2) {} }
    hookAfter('renderBiz', function () { render(); });
    hookAfter('updateReadout', renderBookWarn);
    hookAfter('reloadFromStorage', function () { plan(); if (bizActive()) render(); renderBookWarn(); });
    try { render(); } catch (e) {}
    try { renderBookWarn(); } catch (e) {}
    /* index.html bound its fare / tolls 'input' listeners to the ORIGINAL updateReadout by reference before this module loaded,
       so the wrapper above never sees a typed price. Listen to the fields directly (quote.js does the same for its quote line). */
    var acc = byId('d_account'); if (acc && !acc.__planWarn) { acc.__planWarn = true; acc.addEventListener('change', act(renderBookWarn)); acc.addEventListener('input', act(renderBookWarn)); }
    ['d_fare', 'd_tolls'].forEach(function (id) { var el = byId(id); if (el && !el.__planWarn) { el.__planWarn = true; el.addEventListener('input', act(renderBookWarn)); el.addEventListener('change', act(renderBookWarn)); } });
    var rt = byId('d_rt'); if (rt && !rt.__planWarn) { rt.__planWarn = true; rt.addEventListener('change', act(renderBookWarn)); }
    document.addEventListener('region:changed', function () { try { if (bizActive()) render(); } catch (e) {} });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
