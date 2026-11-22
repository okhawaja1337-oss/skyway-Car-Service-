/* ======================================================================
   Skyway — setup.js
   "Settings, under one roof": one organised Settings page for every module.

   (A) Layout. A hub header at the top of #view-settings (title, live search, a sticky row of section chips) and
       sixteen section containers in a fixed order. The Settings panels the console and the other modules already
       render are MOVED (appendChild of the same node, so every event handler keeps working) into their section.
       A MutationObserver on #view-settings re-homes any panel a module renders late or re-creates; panels this file
       does not know land in a final "Other" section, never lost. Panels that live on other screens (fare tables on
       Rates & zones, the roster check on Fleet, settlement on Earnings, the ledger and the Plan on Business, win-back
       on Accounts, standing rides on the Board) get a small pointer card with a status line and an Open button.
   (B) Go-live checklist (first section): one row per item with a plain reason, a status chip (Done / Needs you /
       Optional / Skipped) and an Open button. Re-evaluated on every Settings render, on every save, on cross-window
       saves (SkyBus / storage) and after module re-renders. While anything needs the owner, Simple mode's Needs-you
       strip carries one line (.ny-item.setup-ny), snoozable for 7 days; re-injected by a MutationObserver on
       #needsYou the same way ops.js and quote.js do (only when absent; nothing when not due).
   (C) Settings bundle (owner only): export JSON without secrets (unless "Include keys" is ticked) and without any
       staff PIN hash; import shows a diff first and applies only settings, the partner base, the call-report column
       map and a rate table as a DRAFT; staff rows are added by name, never overwritten. Both are written to the
       activity log through Recover when present.
   (D) Station sheet (owner only): one printable page of every setting by section, keys masked to the last 4.
   (E) window.Setup = {render, checklist, bundle, applyBundle, sheetHTML, refreshNeedsYou, sections, _loaded}.

   STATE keys owned here: settings.setup = {snoozedUntil, lastChecklistAt, acked{}} — nothing else.
   Conventions: IIFE, skipped in pop-out windows, wrappers keep window.fn._orig and copy marker flags, defensive
   init, idempotent writes, no network, works with Cloud off. Never edits index.html.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;
  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }
  if (POPOUT) return;                                     // pop-outs get nothing from this file
  if (window.Setup && window.Setup._loaded) return;       // load guard

  /* ---------- helpers ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[setup] ' + m); } catch (e) {} }
  function doSave() { var f = window.save; if (typeof f === 'function') { try { f(); } catch (e) {} } }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function copy(o) { try { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function nowISO() { return new Date().toISOString(); }
  function str(v) { return String(v == null ? '' : v).trim(); }
  function isNum(v) { return v !== null && v !== '' && v !== undefined && isFinite(Number(v)) && typeof v !== 'boolean'; }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { try { console.error('[setup]', err); } catch (e2) {} } }; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function setupState() {
    var s = settings();
    if (!s.setup || typeof s.setup !== 'object' || Array.isArray(s.setup)) s.setup = {};
    var u = s.setup;
    if (u.snoozedUntil == null) u.snoozedUntil = '';
    if (u.lastChecklistAt == null) u.lastChecklistAt = '';
    if (!u.acked || typeof u.acked !== 'object' || Array.isArray(u.acked)) u.acked = {};
    return u;
  }
  function inheritFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_|Wrapped$/.test(k) && !(k in w)) w[k] = orig[k]; }); } catch (e) {} }
  function isSimple() { try { var S = window.Simple; if (S && typeof S.isSimple === 'function') return !!S.isSimple(); } catch (e) {} var s = settings(); return s.simpleMode !== false && !s.expertMode; }
  function settingsActive() { var v = byId('view-settings'); return !!(v && v.classList.contains('active')); }
  function cloudOn() { try { return !!(window.Cloud && typeof window.Cloud.enabled === 'function' && window.Cloud.enabled()); } catch (e) { return false; } }
  function mask(v) { v = str(v); if (!v) return ''; return v.length <= 4 ? '••••' : '••••' + v.slice(-4); }
  function daysAgo(iso) { var t = new Date(iso).getTime(); if (!isFinite(t)) return Infinity; return (Date.now() - t) / 86400000; }

  /* ---------- sections ---------- */
  var SECTIONS = [
    { id: 'golive', title: 'Go-live checklist', purpose: 'What is done and what still needs the owner before the first real day.' },
    { id: 'business', title: 'Business', purpose: 'Company name, address, phone and TLC base number. They print on receipts, invoices and the TLC file.' },
    { id: 'staff', title: 'Staff & access', purpose: 'Who works the desk, their role and PIN, and the activity log.' },
    { id: 'phones', title: 'Phones & texting', purpose: 'The business line, what dispatchers say on a booking, and the texts customers get.' },
    { id: 'cloud', title: 'Cloud', purpose: 'Share this console live with other computers and driver phones. Optional: everything works without it.' },
    { id: 'money', title: 'Payments & money', purpose: 'Square links, money defaults, driver settlement and the books.' },
    { id: 'prices', title: 'Prices', purpose: 'The fare table the console quotes from, and its versions filed with the TLC.' },
    { id: 'drivers', title: 'Drivers & vehicles', purpose: 'Licence, insurance and inspection dates, and the partner base for overflow.' },
    { id: 'calls', title: 'Calls & phone system', purpose: 'Call reports from the phone company, missed calls and callbacks.' },
    { id: 'customers', title: 'Customers & win-back', purpose: 'Past riders to call back, and business accounts.' },
    { id: 'standing', title: 'Standing rides', purpose: 'Rides that repeat every week.' },
    { id: 'plan', title: 'Plan', purpose: 'Weekly scorecard and 13-week cash sheet for the owner and the bookkeeper.' },
    { id: 'maps', title: 'Maps & region', purpose: 'Map keys, address search and where this office works.' },
    { id: 'backup', title: 'Backup & recovery', purpose: 'Backups, restores, the paper outage sheet and the settings bundle.' },
    { id: 'imports', title: 'Imports', purpose: 'Bring data in from your old system.' },
    { id: 'display', title: 'Display & modes', purpose: 'Simple or Expert mode, the Settings PIN and the cheat sheet.' },
    { id: 'other', title: 'Other', purpose: 'Settings that do not fit a section above.' }
  ];
  /* Where each known panel goes: by id first, else by panel-head text (start of the head, hint text left out). */
  var HOMES = [
    { id: 'setupChecklist', sec: 'golive', rank: 0 },
    { head: 'company & invoice details', sec: 'business', rank: 10 },
    { id: 'recoverStaff', head: 'staff, access & activity', sec: 'staff', rank: 10 },
    { id: 'setupPhone', sec: 'phones', rank: 10 },
    { id: 'msgTplPanel', head: 'messages', sec: 'phones', rank: 20 },
    { id: 'cloudPanel', head: 'cloud (multi-device sync)', sec: 'cloud', rank: 10 },
    { id: 'moneySettings', head: 'money', exact: true, sec: 'money', rank: 10 },
    { id: 'fixesMoneyDefaults', head: 'money defaults', sec: 'money', rank: 20 },
    { id: 'ledgerEarn', head: 'settlement & receipts', sec: 'money', rank: 30 },
    { id: 'ledgerBiz', head: 'ledger & reconciliation', sec: 'money', rank: 40 },
    { id: 'setupPtrSettle', sec: 'money', rank: 50 },
    { id: 'setupPtrLedger', sec: 'money', rank: 60 },
    { id: 'quoteVersions', head: 'fare table versions', sec: 'prices', rank: 10 },
    { id: 'setupPtrRates', sec: 'prices', rank: 20 },
    { id: 'opsSettings', head: 'eligibility & partner base', sec: 'drivers', rank: 10 },
    { id: 'opsRoster', head: 'roster check', sec: 'drivers', rank: 20 },
    { id: 'setupPtrRoster', sec: 'drivers', rank: 30 },
    { id: 'setupCalls', sec: 'calls', rank: 10 },
    { id: 'crmPanel', head: 'win-back & accounts', sec: 'customers', rank: 10 },
    { id: 'setupPtrCrm', sec: 'customers', rank: 20 },
    { id: 'recPanel', head: 'standing rides', sec: 'standing', rank: 10 },
    { id: 'setupPtrStanding', sec: 'standing', rank: 20 },
    { id: 'planPanel', head: 'plan', exact: true, sec: 'plan', rank: 10 },
    { id: 'setupPtrPlan', sec: 'plan', rank: 20 },
    { id: 'setupMaps', sec: 'maps', rank: 10 },
    { id: 'regionPanel', head: 'region', exact: true, sec: 'maps', rank: 20 },
    { head: 'backup & data', sec: 'backup', rank: 10 },
    { id: 'recoverBackup', head: 'backup, restore & outage sheet', sec: 'backup', rank: 20 },
    { id: 'setupBundle', sec: 'backup', rank: 30 },
    { head: 'import from your old system', sec: 'imports', rank: 10 },
    { id: 'simplePanel', head: 'simple mode', exact: true, sec: 'display', rank: 10 }
  ];
  /* head text without its hint span, lower case, leading symbols (↻, emoji) removed */
  function headText(panel) {
    var h = panel && panel.querySelector ? panel.querySelector(':scope > .panel-head') : null; if (!h) return '';
    var t = '';
    h.childNodes.forEach(function (n) { if (n.nodeType === 3) t += n.textContent; else if (n.nodeType === 1 && !(n.classList && n.classList.contains('hint')) && n.tagName !== 'BUTTON') t += n.textContent; });
    return t.replace(/\s+/g, ' ').trim().toLowerCase().replace(/^[^a-z0-9]+/, '').replace(/[×✕]+$/, '').trim();
  }
  var HEAD_RULES = HOMES.filter(function (r) { return r.head; }).sort(function (a, b) { return b.head.length - a.head.length; });
  function homeFor(panel) {
    if (panel.id) { for (var i = 0; i < HOMES.length; i++) if (HOMES[i].id === panel.id) return HOMES[i]; }
    var t = headText(panel);
    for (var j = 0; j < HEAD_RULES.length; j++) { var r = HEAD_RULES[j]; if (r.exact ? t === r.head : t.indexOf(r.head) === 0) return r; }
    return { sec: 'other', rank: 900 };
  }

  /* ---------- hub DOM ---------- */
  var view = null, hub = null, observer = null, rehoming = false;
  function secBody(id) { return byId('setupSecBody_' + id); }
  function buildHub() {
    view = byId('view-settings'); if (!view) return false;
    if (byId('setupHub')) { hub = byId('setupHub'); return true; }
    hub = document.createElement('div'); hub.id = 'setupHub'; hub.className = 'setup-hub';
    var head = document.createElement('div'); head.className = 'setup-head'; head.id = 'setupHead';
    head.innerHTML = '<div class="setup-titlerow"><h2 class="setup-title">Settings</h2>'
      + '<input type="search" id="setupSearch" class="setup-search" placeholder="Search settings (e.g. PIN, Square, backup)" autocomplete="off" aria-label="Search settings">'
      + '<span id="setupProgress" class="setup-progress"></span></div>'
      + '<nav class="setup-chips" id="setupChips" aria-label="Settings sections">'
      + SECTIONS.map(function (s) { return '<button type="button" class="setup-chip" data-sec="' + s.id + '"' + (s.id === 'other' ? ' hidden' : '') + '>' + esc(s.title) + '<span class="setup-chip-n" data-n="' + s.id + '"></span></button>'; }).join('')
      + '</nav><div id="setupNoMatch" class="setup-nomatch" hidden>Nothing matches. Clear the search to see every setting.</div>';
    hub.appendChild(head);
    SECTIONS.forEach(function (s) {
      var sec = document.createElement('section'); sec.className = 'setup-sec'; sec.id = 'setupSec_' + s.id; sec.setAttribute('data-sec', s.id);
      sec.innerHTML = '<div class="setup-sec-head"><h3>' + esc(s.title) + '</h3><p>' + esc(s.purpose) + '</p></div><div class="setup-sec-pre" id="setupSecPre_' + s.id + '"></div><div class="setup-sec-body" id="setupSecBody_' + s.id + '"></div>';
      if (s.id === 'other') sec.hidden = true;
      hub.appendChild(sec);
    });
    view.insertBefore(hub, view.firstChild);
    /* one-line pointers (not panels) */
    var sp = byId('setupSecPre_staff');
    if (sp) sp.innerHTML = '<div class="setup-pointer">PINs for named staff live here; the Settings PIN is in <a href="#" data-jump="display">Display &amp; modes</a>. An owner PIN set here also becomes the Settings PIN.</div>';
    var dp = byId('setupSecPre_display');
    if (dp) dp.innerHTML = '<div class="setup-pointer">Screen colours (theme) are set in <a href="#" data-jump-el="s_theme">Business → Appearance / theme</a>.</div>';
    hub.addEventListener('click', act(onHubClick));
    hub.addEventListener('change', act(onHubChange));
    byId('setupSearch').addEventListener('input', act(function () { applySearch(); }));
    return true;
  }
  function ownPanel(id, head) {
    var p = byId(id);
    if (!p) { p = document.createElement('div'); p.id = id; p.className = 'panel setup-own'; p.innerHTML = '<div class="panel-head">' + esc(head) + '</div><div class="panel-body" id="' + id + '_body"></div>'; }
    return p;
  }
  function place(panel, home) {
    var body = secBody(home.sec); if (!body) return;
    panel.setAttribute('data-setup-rank', String(home.rank));
    panel.setAttribute('data-setup-sec', home.sec);
    if (panel.parentNode === body) return;
    var before = null, kids = body.children;
    for (var i = 0; i < kids.length; i++) { var r = Number(kids[i].getAttribute('data-setup-rank')) || 0; if (r > home.rank) { before = kids[i]; break; } }
    body.insertBefore(panel, before);   // the same node moves: identity and listeners are kept
  }
  /* panels that sit outside the sections (direct children of the view, or inside the console's .grid2) */
  function strayPanels() {
    var out = [];
    if (!view) return out;
    Array.prototype.forEach.call(view.children, function (c) {
      if (c === hub) return;
      if (c.classList && c.classList.contains('panel')) out.push(c);
      else if (c.querySelectorAll) Array.prototype.forEach.call(c.querySelectorAll(':scope > .panel'), function (p) { out.push(p); });
    });
    return out;
  }
  function rehome() {
    if (!view || !hub || rehoming) return;
    rehoming = true;
    try {
      if (hub.parentNode !== view || view.firstElementChild !== hub) view.insertBefore(hub, view.firstChild);
      strayPanels().forEach(function (p) { place(p, homeFor(p)); });
      /* a wrapper the console left empty (its panels moved) is hidden, never removed */
      Array.prototype.forEach.call(view.children, function (c) {
        if (c === hub || (c.classList && c.classList.contains('panel'))) return;
        var empty = !c.querySelector('.panel');
        c.classList.toggle('setup-emptywrap', empty);
      });
      var other = byId('setupSec_other'), ob = secBody('other');
      if (other && ob) { other.hidden = !ob.children.length; var oc = hub.querySelector('.setup-chip[data-sec="other"]'); if (oc) oc.hidden = !ob.children.length; }
    } finally { rehoming = false; }
  }
  function watchView() {
    if (!view || view.__setupObserved || !window.MutationObserver) return;
    view.__setupObserved = true;
    observer = new MutationObserver(function (recs) {
      if (rehoming) return;
      var need = false, touched = false;
      recs.forEach(function (r) {
        if (r.target === view) need = true;
        else if (!(hub && hub.contains(r.target) && isOwn(r.target))) touched = true;
      });
      if (need) rehome();
      if (need || touched) scheduleRefresh();
    });
    observer.observe(view, { childList: true, subtree: true });
  }
  function isOwn(node) { var n = node && node.nodeType === 1 ? node : node && node.parentNode; return !!(n && n.closest && (n.closest('.setup-own') || n.closest('#setupHead') || n.closest('.setup-sec-head') || n.closest('.setup-sec-pre'))); }

  /* ---------- search ---------- */
  function panelText(p) {
    var t = headText(p) + ' ';
    p.querySelectorAll('label, .lbl, h4, button, summary, th').forEach(function (n) { t += ' ' + n.textContent; });
    return t.replace(/\s+/g, ' ').toLowerCase();
  }
  function applySearch() {
    if (!hub) return;
    var q = str((byId('setupSearch') || {}).value).toLowerCase();
    var words = q ? q.split(/\s+/) : [], anyShown = false;
    SECTIONS.forEach(function (s) {
      var sec = byId('setupSec_' + s.id), body = secBody(s.id); if (!sec || !body) return;
      var shown = 0, secTitle = (s.title + ' ' + s.purpose).toLowerCase();
      Array.prototype.forEach.call(body.children, function (p) {
        var ok = !words.length || words.every(function (w) { return secTitle.indexOf(w) >= 0 || panelText(p).indexOf(w) >= 0; });
        p.classList.toggle('setup-hide', !ok);
        if (ok) shown++;
      });
      var pre = byId('setupSecPre_' + s.id); if (pre) pre.classList.toggle('setup-hide', !!words.length);
      var empty = s.id === 'other' ? !body.children.length : false;
      sec.classList.toggle('setup-hide', empty || (words.length > 0 && !shown));
      if (shown && !empty) anyShown = true;
      var chip = hub.querySelector('.setup-chip[data-sec="' + s.id + '"]'); if (chip) chip.classList.toggle('setup-dim', words.length > 0 && !shown);
    });
    var nm = byId('setupNoMatch'); if (nm) nm.hidden = !words.length || anyShown;
  }

  /* ---------- navigation ---------- */
  var VIEW_SECTION = { dispatch: 'board', trips: 'board', history: 'board', map: 'board', fleet: 'drivers', driveriq: 'drivers', optimizer: 'drivers', zonemap: 'drivers', earnings: 'money', accounts: 'money', invoicing: 'money', biz: 'money', tlc: 'money', settings: 'settings', pricing: 'settings', addrbook: 'settings', estimate: 'settings' };
  function flash(el) {
    if (!el) return;
    el.classList.remove('setup-flash'); void el.offsetWidth; el.classList.add('setup-flash');
    setTimeout(function () { try { el.classList.remove('setup-flash'); } catch (e) {} }, 1500);
  }
  function scrollTo(el) { if (!el) return; try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} } flash(el); }
  function clearSearchIfHidden(el) { if (el && el.closest && el.closest('.setup-hide')) { var s = byId('setupSearch'); if (s) { s.value = ''; applySearch(); } } }
  function jumpSection(id) { var sec = byId('setupSec_' + id); if (!sec) return; clearSearchIfHidden(sec); scrollTo(sec); hub.querySelectorAll('.setup-chip').forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-sec') === id); }); }
  function jumpEl(id) { var el = byId(id); if (!el) return false; clearSearchIfHidden(el); var p = el.closest ? (el.closest('.panel') || el) : el; scrollTo(el.classList && el.classList.contains('panel') ? el : p); if (el.focus && /INPUT|SELECT|TEXTAREA/.test(el.tagName)) { try { el.focus({ preventScroll: true }); } catch (e) {} } if (p !== el) flash(el.closest('label') || el); return true; }
  /* open another screen (Simple mode section or Expert tab), then scroll to and highlight one element there */
  function go(v, targetId, after) {
    var S = window.Simple, sec = VIEW_SECTION[v];
    try { if (isSimple() && S && typeof S.enter === 'function' && sec) S.enter(sec, v); else if (typeof window.goTab === 'function') window.goTab(v); } catch (e) {}
    setTimeout(function () { try { var el = targetId ? byId(targetId) : null; if (el) scrollTo(el); if (after) after(); } catch (e) {} }, 120);
    return true;
  }
  function openSettingsAt(targetId) {
    var ok = true, S = window.Simple;
    try { if (!settingsActive()) { if (isSimple() && S && typeof S.enter === 'function') ok = S.enter('settings', 'settings'); else if (typeof window.goTab === 'function') window.goTab('settings'); } } catch (e) { ok = false; }
    if (ok) setTimeout(function () { render(); if (targetId) jumpEl(targetId); }, 80);
    return ok;
  }
  function clickEl(id, sel) { var el = sel ? document.querySelector(sel) : byId(id); if (!el) return false; try { el.click(); return true; } catch (e) { return false; } }

  /* ---------- owner gate ---------- */
  var fbUnlocked = false;
  /* recover.js first (signed-in owner, or its owner-PIN prompt over the hashed PINs), else settings.adminPin the way ledger.js asks. */
  function ownerOK(what) {
    var R = window.Recover;
    if (R && R._loaded && typeof R.ownerPinOK === 'function') {
      try { if (typeof R.who === 'function' && R.who() && typeof R.role === 'function' && R.role() === 'owner') return Promise.resolve(true); } catch (e) {}
      try { if (typeof R.ownerHere === 'function' && R.ownerHere()) return Promise.resolve(true); } catch (e) {}
      try { return Promise.resolve(R.ownerPinOK(what)).then(function (ok) { return !!ok; }, function () { return false; }); } catch (e) { return Promise.resolve(false); }
    }
    var pin = str(settings().adminPin);
    if (!/^\d{4}$/.test(pin) || fbUnlocked) return Promise.resolve(true);
    var a = null; try { a = window.prompt('Owner PIN to ' + (what || 'continue') + ':', ''); } catch (e) { a = null; }
    if (a === null) return Promise.resolve(false);
    if (str(a) === pin) { fbUnlocked = true; return Promise.resolve(true); }
    toast('Wrong PIN.', true); return Promise.resolve(false);
  }
  function audit(what, detail) { try { var R = window.Recover; if (R && typeof R.log === 'function') R.log(what, detail); } catch (e) {} }

  /* ---------- checklist ---------- */
  var seedKey = null;
  /* the sample Google key the console seeds into a fresh station (read from the console's own defaults, never written here) */
  function sampleKey() {
    if (seedKey !== null) return seedKey;
    seedKey = '';
    try { if (typeof window.defaultState === 'function') { var d = window.defaultState(); seedKey = str(d && d.settings && d.settings.gmapkey); } } catch (e) { seedKey = ''; }
    return seedKey;
  }
  function el(d) { return d && d.eligibility && typeof d.eligibility === 'object' ? d.eligibility : {}; }
  function driverGaps() {
    var act = arr(STATE.drivers).filter(function (d) { return d && d.active !== false; });
    var missing = act.filter(function (d) { var e = el(d); return !str(d.tlc) || !str(e.tlcExp) || !str(e.dmvExp) || !str(e.insuranceExp); });
    return { total: act.length, missing: missing.length };
  }
  function vehicleGaps() {
    var vs = arr(STATE.vehicles).filter(function (v) { return v && !el(v).outOfService; });
    var missing = vs.filter(function (v) { var e = el(v); return !str(e.regExp) || !str(e.inspExp); });
    return { total: vs.length, missing: missing.length };
  }
  function planInputs() {
    var C = (STATE.plan && STATE.plan.cash13) || {}, I = C.inputs || {};
    var vals = [C.opening, I.squareCredits, I.baselineNet, I.payrollUp];
    return { have: vals.filter(isNum).length, of: 4 };
  }
  function lastBackupAt() {
    var best = '';
    arr(STATE.exports).forEach(function (x) { if (x && x.kind === 'backup' && x.at && String(x.at) > best) best = String(x.at); });
    var sec = settings().security; if (sec && sec.lastBackupAt && String(sec.lastBackupAt) > best) best = String(sec.lastBackupAt);
    return best;
  }
  function ownerPinSet() {
    if (/^\d{4}$/.test(str(settings().adminPin))) return true;
    return arr(STATE.staff).some(function (s) { return s && s.role === 'owner' && s.active !== false && s.hash; });
  }
  function hasDispatcher() { return arr(STATE.staff).some(function (s) { return s && s.role === 'dispatcher' && s.active !== false; }); }
  function partnerOK() { try { if (window.Ops && typeof window.Ops.partnerComplete === 'function') return !!window.Ops.partnerComplete(); } catch (e) {} var p = settings().partnerBase || {}; return !!(str(p.baseName) && /^B\d{5}$/i.test(str(p.baseLicence)) && str(p.contact) && str(p.agreementSignedAt) && p.recordExchangeAgreed === true && str(p.verifiedAt)); }
  function cdrCount() { var m = settings().cdrMapping; return m && typeof m === 'object' ? Object.keys(m).length : 0; }
  function worklistCount() { return arr(STATE.crm && STATE.crm.worklist).length; }
  function phoneDrivers() { return arr(STATE.drivers).filter(function (d) { return d && (d.consentAt || (d.curLoc && d.curLoc.source === 'gps')); }).length; }
  function outagePrinted() { return arr(STATE.audit).some(function (r) { return r && r.what === 'print' && r.ref === 'outage-sheet'; }); }
  function rates() { return STATE.rates && typeof STATE.rates === 'object' ? STATE.rates : {}; }

  function row(key, label, status, reason, open, extra) { return { key: key, label: label, status: status, reason: reason, open: open || null, extra: extra || null }; }
  function checklist() {
    var s = settings(), rows = [], acked = setupState().acked;
    var biz = ['name', 'addr', 'phone', 'base'].filter(function (k) { return !str(s[k]); });
    rows.push(row('business', 'Business details', biz.length ? 'needs' : 'done', biz.length ? 'Missing: ' + biz.map(function (k) { return { name: 'company name', addr: 'address', phone: 'phone', base: 'TLC base number' }[k]; }).join(', ') + '. They print on receipts and the TLC file.' : 'Name, address, phone and TLC base ' + str(s.base) + ' are filled in.', { label: 'Open', el: 's_name' }));
    rows.push(row('ownerpin', 'Owner PIN', ownerPinSet() ? 'done' : 'needs', ownerPinSet() ? 'Set. Exports, backups, prices and staff changes ask for it.' : 'Not set: anyone at this desk can export, back up or change prices.', { label: 'Open', el: 'recoverStaff', fallback: 'simplePanel' }));
    rows.push(row('staff', 'Named dispatchers', hasDispatcher() ? 'done' : 'optional', hasDispatcher() ? 'At least one dispatcher has a name on the staff list.' : 'Add each dispatcher by name so the activity log shows who did what.', { label: 'Open', el: 'recoverStaff' }));
    rows.push(row('consent', 'Consent sentence on the cheat sheet', 'done', 'The cheat sheet tells dispatchers to say: "' + consentText() + '"', { label: 'Print cheat sheet', click: 's_cheat' }));
    var tx = cloudOn();
    rows.push(row('texting', 'Texting route', tx ? 'done' : 'optional', tx ? 'Cloud is on: texts can go out from the business number.' : 'For now texts go out from the phone\'s SMS app. Fine for the pilot; business-number texting comes with Cloud.', { label: 'Open', el: 'setupPhone' }));
    rows.push(row('cloud', 'Cloud sync', tx ? 'done' : 'optional', tx ? 'On: other computers and driver phones share this console.' : 'Off. Everything works on this computer without it.', { label: 'Open', el: 'cloudPanel' }));
    var sq = !!str(s.square) || squareViaCloud();
    rows.push(row('square', 'Square', sq ? 'done' : 'needs', sq ? 'The Square card link is set' + (str(s.squarePayLink) ? ', and so is the pay link for texts.' : '.') : 'No Square link: card rides cannot be charged from the console.', { label: 'Open', el: 'moneySettings', fallback: 's_square' }));
    var md = isNum(s.holdFactor) && typeof s.holdFactor === 'number' && typeof s.paFee === 'number' && isNum(s.paFee);
    rows.push(row('moneydefaults', 'Money defaults saved', md ? 'done' : 'needs', md ? 'Card hold ×' + s.holdFactor + ', airport fee $' + Number(s.paFee).toFixed(2) + ', gratuity ' + (Number(s.autoGratuityPct) || 0) + '%.' : 'Card hold and airport fee are not saved yet.', { label: 'Open', el: 'fixesMoneyDefaults' }));
    var R = rates(), live = R.engine === 'v2' && !!(R.filedWithTlcAt || R.belowFiledAck);
    rows.push(row('rates', 'Rate table', live ? 'done' : 'needs', live ? 'Version ' + (R.version || '?') + ' with the new pricing rules is active' + (R.filedWithTlcAt ? ', filed with the TLC on ' + R.filedWithTlcAt + '.' : '.') : (R.draft ? 'A draft (version ' + R.draft.version + ') is waiting: check it, set the TLC filing date, then activate it.' : 'Still the console\'s original prices. Load the proposed rate card, set the TLC filing date and activate it.'), { label: 'Open', go: 'rates' }, R.draft ? null : { label: 'Load proposed rate card', go: 'proposed' }));
    var fm = s.feeMode === 'flat' || s.feeMode === 'tiers';
    rows.push(row('feemode', 'Fee mode chosen', fm ? 'done' : 'needs', fm ? 'Driver base fees: ' + (s.feeMode === 'tiers' ? 'by fare tier.' : 'flat (each driver\'s own fee).') : 'Choose flat or tiers in Money defaults.', { label: 'Open', el: 'fx_feemode', fallback: 'fixesMoneyDefaults' }));
    var dg = driverGaps();
    rows.push(row('eligibility', 'Driver papers', dg.total && !dg.missing ? 'done' : 'needs', !dg.total ? 'No active drivers on file yet.' : dg.missing ? dg.missing + ' of ' + dg.total + ' drivers missing a TLC number or a TLC, DMV or insurance date.' : 'Every active driver has a TLC number and TLC, DMV and insurance dates.', { label: 'Open', go: 'roster' }));
    var vg = vehicleGaps(), reqV = s.requireVehicle === true, vok = vg.total > 0 && !vg.missing;
    rows.push(row('vehicles', 'Vehicle papers', vok ? 'done' : (reqV ? 'needs' : 'optional'), !vg.total ? 'No vehicles on file yet.' + (reqV ? ' A vehicle is required for every assignment.' : '') : vg.missing ? vg.missing + ' of ' + vg.total + ' vehicles missing a registration or inspection date.' + (reqV ? '' : ' Optional while a vehicle is not required on every job.') : 'Every vehicle has registration and inspection dates.', { label: 'Open', go: 'roster' }));
    var pb = partnerOK();
    rows.push(row('partner', 'Partner base for overflow', pb ? 'done' : 'optional', pb ? 'Partner base record complete: overflow is available.' : 'Only needed to send calls you cannot cover to another base.', { label: 'Open', el: 'opsSettings' }));
    var cm = cdrCount();
    rows.push(row('cdr', 'Call reports', cm ? 'done' : 'optional', cm ? 'The column map for the phone company\'s call report is saved.' : 'Import one call report from the phone system to save the column map.', { label: 'Open', go: 'cdr' }));
    var wl = worklistCount();
    rows.push(row('winback', 'Win-back list', wl ? 'done' : 'needs', wl ? wl + ' past riders on the call-back list.' : 'The list of past riders to call back is empty.', { label: 'Open', go: 'winback' }));
    var pi = planInputs();
    rows.push(row('plan', 'Plan figures', pi.have === pi.of ? 'done' : 'needs', pi.have === pi.of ? 'The four private figures are typed in.' : pi.have + ' of 4 private figures typed in (opening cash, Square credits, baseline net, payroll uplift). The bookkeeper types them.', { label: 'Open', go: 'plan' }));
    var gk = str(s.gmapkey), sk = sampleKey(), sample = !!(gk && sk && gk === sk);
    rows.push(row('gmap', 'Google Maps key', gk && !sample ? 'done' : (sample ? 'needs' : 'optional'), sample ? 'Still the sample key that ships with the app. Use your own key.' : gk ? 'Your own key is set.' : 'Not set: the free map and address service is used.', { label: 'Open', el: 'setupMaps' }));
    var ph = phoneDrivers();
    rows.push(row('phones', 'Driver phones', ph ? 'done' : 'optional', ph ? ph + ' driver phone' + (ph === 1 ? '' : 's') + ' connected.' : 'No driver has opened the driver page on a phone yet.', { label: 'Open', go: 'fleet' }));
    var lb = lastBackupAt(), fresh = lb && daysAgo(lb) <= 7;
    rows.push(row('backup', 'Backup in the last 7 days', fresh ? 'done' : 'needs', fresh ? 'Last backup ' + String(lb).slice(0, 10) + '.' : (lb ? 'Last backup ' + String(lb).slice(0, 10) + ', more than 7 days ago.' : 'No backup recorded on this computer.'), { label: 'Open', el: 'recoverBackup', fallback: 'b_export' }));
    rows.push(row('outage', 'Outage sheet', outagePrinted() ? 'done' : 'optional', outagePrinted() ? 'Printed at least once. Print a fresh one each morning.' : 'A paper copy of today\'s and tomorrow\'s trips, in case the computer dies.', { label: 'Print outage sheet', go: 'outage' }));
    rows.forEach(function (r) { if (r.status === 'optional' && acked[r.key]) r.status = 'skipped'; });
    return rows;
  }
  function squareViaCloud() { try { var c = window.Cloud; return !!(c && typeof c.fn === 'function' && c.enabled() && typeof c.configured === 'function' && c.configured()); } catch (e) { return false; } }
  function consentText() { try { if (window.Messages && typeof window.Messages.consentSentence === 'string' && window.Messages.consentSentence) return window.Messages.consentSentence; } catch (e) {} return 'By booking you agree to receive ride updates by text; reply STOP to opt out.'; }
  function summary(rows) {
    rows = rows || checklist();
    var done = rows.filter(function (r) { return r.status === 'done'; }).length, need = rows.filter(function (r) { return r.status === 'needs'; }).length;
    return { done: done, need: need, total: rows.length };
  }
  var CHIP = { done: ['Done', 'ok'], needs: ['Needs you', 'bad'], optional: ['Optional', 'opt'], skipped: ['Skipped', 'opt'] };
  function renderChecklist(rows) {
    var p = ownPanel('setupChecklist', 'Go-live checklist'); place(p, { sec: 'golive', rank: 0 });
    var sm = summary(rows);
    var h = '<div class="setup-cl-sum" id="setupClSum"><b>' + sm.done + ' of ' + sm.total + ' done</b> · ' + sm.need + ' need you</div><div class="setup-cl" role="table">';
    rows.forEach(function (r) {
      var c = CHIP[r.status] || CHIP.optional;
      h += '<div class="setup-cl-row" role="row" data-key="' + r.key + '" data-status="' + r.status + '"><div class="setup-cl-main"><div class="setup-cl-label">' + esc(r.label) + '</div><div class="setup-cl-why">' + esc(r.reason) + '</div></div>'
        + '<span class="setup-st ' + c[1] + '">' + c[0] + '</span><div class="setup-cl-acts">'
        + (r.open ? '<button type="button" class="btn btn-sm btn-navy" data-cl="open" data-key="' + r.key + '">' + esc(r.open.label) + '</button>' : '')
        + (r.extra ? '<button type="button" class="btn btn-sm btn-go" data-cl="extra" data-key="' + r.key + '">' + esc(r.extra.label) + '</button>' : '')
        + (r.status === 'optional' ? '<button type="button" class="btn btn-sm btn-ghost" data-cl="skip" data-key="' + r.key + '" title="Not needed at this station">Skip</button>' : '')
        + (r.status === 'skipped' ? '<button type="button" class="btn btn-sm btn-ghost" data-cl="unskip" data-key="' + r.key + '">Undo skip</button>' : '')
        + '</div></div>';
    });
    h += '</div>';
    var b = byId('setupChecklist_body'); if (b && b.__html !== h) { b.innerHTML = h; b.__html = h; }
    var pr = byId('setupProgress'); if (pr) pr.textContent = sm.done + ' of ' + sm.total + ' done · ' + sm.need + ' need you';
    var n = hub && hub.querySelector('[data-n="golive"]'); if (n) n.textContent = sm.need ? ' ' + sm.need : '';
  }
  function runAction(r, which) {
    var a = which === 'extra' ? r.extra : r.open; if (!a) return;
    if (a.click) { clickEl(a.click); return; }
    if (a.el) { if (!jumpEl(a.el) && a.fallback) jumpEl(a.fallback); return; }
    switch (a.go) {
      case 'rates': openRates(); break;
      case 'proposed': loadProposed(); break;
      case 'roster': go('fleet', 'opsRoster'); break;
      case 'cdr': openCdr(); break;
      case 'winback': openWinback(true); break;
      case 'plan': openPlan(); break;
      case 'fleet': go('fleet', 'driverBody'); break;
      case 'outage': printOutage(); break;
    }
  }
  function openRates() { try { if (window.Quote && typeof window.Quote.openRates === 'function') { window.Quote.openRates(); return; } } catch (e) {} go('pricing', 'quoteVersions'); }
  function loadProposed() {
    var b = document.querySelector('#quoteVersions button[data-q="proposed"]');
    if (b) { b.click(); scheduleRefresh(); return true; }
    toast(rates().draft ? 'A draft rate version already exists: open the fare tables to check it.' : 'The fare table panel is not loaded.', true); return false;
  }
  function openCdr() { go('history', 'opsCalls', function () { var t = byId('ops_cdr_text'); if (t) { try { t.scrollIntoView({ block: 'center' }); t.focus({ preventScroll: true }); } catch (e) {} flash(t); } }); }
  function openWinback(importBox) {
    try { if (window.CRM && typeof window.CRM.open === 'function') window.CRM.open(); else go('accounts', 'crmPanel'); } catch (e) { go('accounts', 'crmPanel'); }
    if (importBox) setTimeout(function () { var b = document.querySelector('#crmPanel button[data-act="imp"][data-kind="winback"]'); if (b) { try { b.click(); } catch (e) {} var t = byId('crm_import_text'); if (t) { try { t.focus(); } catch (e) {} } } }, 150);
  }
  function openPlan() { go('biz', 'planPanel', function () { try { if (window.Plan && typeof window.Plan.show === 'function') window.Plan.show('cash'); } catch (e) {} }); }
  function printOutage() { try { if (window.Recover && typeof window.Recover.printOutageSheet === 'function') { window.Recover.printOutageSheet(); scheduleRefresh(); return true; } } catch (e) {} toast('The outage sheet is not available here.', true); return false; }

  /* ---------- own cards ---------- */
  function setBody(id, h) { var b = byId(id + '_body'); if (b && b.__html !== h) { b.innerHTML = h; b.__html = h; } }
  function chipHtml(ok, yes, no, cls) { return '<span class="setup-st ' + (ok ? 'ok' : (cls || 'opt')) + '">' + esc(ok ? yes : no) + '</span>'; }
  function renderPhoneCard() {
    var p = ownPanel('setupPhone', 'Business line & texting'); place(p, homeFor(p));
    var s = settings(), on = cloudOn();
    setBody('setupPhone', '<div class="setup-kv"><span>Business number</span><b>' + esc(s.phone || 'not set') + '</b></div>'
      + '<div class="setup-kv"><span>Dispatchers say on every phone booking</span><b class="setup-quote">"' + esc(consentText()) + '"</b></div>'
      + '<div class="setup-kv"><span>How texts go out</span><b>' + (on ? 'Cloud is on: texts can go out from the business number.' : 'Texts go out from the phone\'s SMS app until Cloud and business-number texting are on.') + '</b></div>'
      + '<div class="setup-kv"><span>Cloud</span>' + chipHtml(on, 'On', 'Off') + '</div>'
      + '<div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="editphone">Change business number</button><button type="button" class="btn btn-sm btn-ghost" data-own="cheat">Print cheat sheet</button></div>');
  }
  function renderCallsCard() {
    var p = ownPanel('setupCalls', 'Call reports (phone system)'); place(p, homeFor(p));
    var cm = cdrCount(), calls = arr(STATE.calls), fromCdr = calls.filter(function (c) { return c && c.source === 'cdr'; }).length, pb = partnerOK();
    var miss = []; try { if (window.Ops && typeof window.Ops.partnerMissing === 'function') miss = window.Ops.partnerMissing() || []; } catch (e) {}
    setBody('setupCalls', '<div class="setup-kv"><span>Column map for the call report</span>' + chipHtml(cm, cm + ' saved', 'Not saved yet') + '</div>'
      + '<div class="setup-kv"><span>Calls logged</span><b>' + calls.length + (fromCdr ? ' (' + fromCdr + ' from call reports)' : '') + '</b></div>'
      + '<div class="setup-kv"><span>Partner base</span>' + (pb ? '<b>On file: overflow is available.</b>' : '<b>Not complete' + (miss.length ? ': missing ' + esc(miss.join(', ')) : '') + '. Overflow stays off.</b>') + '</div>'
      + '<p class="hint" style="margin:6px 0;">Export the call report (CSV) from the phone company\'s portal, then import it on the Calls screen. You match the columns once; the map is saved.</p>'
      + '<div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="cdr">Import a call report</button><button type="button" class="btn btn-sm btn-ghost" data-own="partner">Partner base record</button></div>');
  }
  function renderMapsCard() {
    var p = ownPanel('setupMaps', 'Maps & addresses'); place(p, homeFor(p));
    var s = settings(), gk = str(s.gmapkey), sample = gk && sampleKey() && gk === sampleKey(), out = byId('s_gtestOut'), last = out ? str(out.textContent) : '';
    setBody('setupMaps', '<div class="setup-kv"><span>Google key</span>' + (gk ? (sample ? '<span class="setup-st bad">Sample key: use your own</span>' : '<span class="setup-st ok">Set</span>') : '<span class="setup-st opt">Not set: free service</span>') + '</div>'
      + '<div class="setup-kv"><span>Address search key (LocationIQ)</span>' + chipHtml(!!str(s.geokey), 'Set', 'Not set: free service') + '</div>'
      + '<div class="setup-kv"><span>Last Google test</span><b id="setupGtestLast">' + esc(last || 'not run on this visit') + '</b></div>'
      + '<p class="hint" style="margin:6px 0;">The keys are typed in Business (Google Maps API key). Both tests use the internet.</p>'
      + '<div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="gtest">Test Google now</button><button type="button" class="btn btn-sm btn-ghost" data-own="doctor">Run the map doctor</button><button type="button" class="btn btn-sm btn-ghost" data-own="gkey">Edit the keys</button></div>');
  }
  function renderBundleCard() {
    var p = ownPanel('setupBundle', 'Settings bundle & station sheet'); place(p, homeFor(p));
    var b = byId('setupBundle_body');
    if (b && !b.__built) {
      b.__built = true;
      b.innerHTML = '<p class="hint" style="margin-top:0;">Copy this station\'s settings to another computer: prices, money defaults, texts, region, partner base and the staff names. Trips, drivers, accounts and the books are never in the bundle. Owner only.</p>'
        + '<div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="bexport">Export settings bundle</button>'
        + '<label class="btn btn-sm btn-ghost setup-file">Import settings bundle<input type="file" id="setupBundleFile" accept=".json,application/json"></label>'
        + '<label class="setup-inl"><input type="checkbox" id="setupIncKeys"> Include keys</label></div>'
        + '<div id="setupKeysWarn" class="setup-warn" hidden>The file will hold your Google keys, the Cloud key and the Settings PIN. Keep it private and delete it after use.</div>'
        + '<div id="setupDiff"></div>'
        + '<h4 class="setup-h4">Station sheet</h4><p class="hint" style="margin:0 0 6px;">One printed page with every setting by section. Keys show only their last 4 characters unless you tick "Show keys".</p>'
        + '<div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="sheet">Print station sheet</button><label class="setup-inl"><input type="checkbox" id="setupShowKeys"> Show keys</label></div>';
    }
  }
  function ptr(id, head, html) { var p = ownPanel(id, head); p.classList.add('setup-ptr'); place(p, homeFor(p)); setBody(id, html); }
  function renderPointers() {
    var R = rates(), dg = driverGaps(), vg = vehicleGaps(), pi = planInputs(), wl = worklistCount(), rec = arr(STATE.recurring).filter(function (x) { return x && x.status !== 'stopped'; }).length;
    if (!byId('quoteVersions') || !(view && view.contains(byId('quoteVersions'))))
      ptr('setupPtrRates', 'Fare tables (on Rates & zones)', '<div class="setup-kv"><span>Active</span><b>Version ' + esc(R.version || '?') + ' · ' + (R.engine === 'v2' ? 'new pricing rules' : 'the console\'s original prices') + ' · ' + (R.filedWithTlcAt ? 'filed with the TLC ' + esc(R.filedWithTlcAt) : 'not filed') + '</b></div>'
        + '<div class="setup-kv"><span>Draft</span><b>' + (R.draft ? 'version ' + esc(R.draft.version) + ' waiting for the owner' : 'none') + '</b></div>'
        + '<div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="rates">Open fare tables</button>' + (R.draft ? '' : '<button type="button" class="btn btn-sm btn-go" data-own="proposed">Load proposed rate card</button>') + '</div>');
    if (!(view && view.contains(byId('opsRoster'))))
      ptr('setupPtrRoster', 'Roster check (on Fleet)', '<div class="setup-kv"><span>Drivers</span><b>' + (dg.total ? (dg.total - dg.missing) + ' of ' + dg.total + ' have every paper on file' : 'none on file') + '</b></div>'
        + '<div class="setup-kv"><span>Vehicles</span><b>' + (vg.total ? (vg.total - vg.missing) + ' of ' + vg.total + ' have registration and inspection dates' : 'none on file') + '</b></div>'
        + '<div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="roster">Open roster check</button></div>');
    if (!(view && view.contains(byId('ledgerEarn'))))
      ptr('setupPtrSettle', 'Driver settlement (on Earnings)', '<p class="hint" style="margin:0 0 6px;">Weekly runs per driver, receipts and refunds live on Money → Earnings. Runs ask for the owner PIN.</p><div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="settle">Open settlement</button></div>');
    if (!(view && view.contains(byId('ledgerBiz'))))
      ptr('setupPtrLedger', 'Ledger & reconciliation (on Business)', '<p class="hint" style="margin:0 0 6px;">Square payouts against the bank, cash base fees and the journal export live on Money → Business.</p><div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="ledger">Open the ledger</button></div>');
    if (!(view && view.contains(byId('crmPanel'))))
      ptr('setupPtrCrm', 'Win-back list (on Accounts)', '<div class="setup-kv"><span>Past riders to call back</span><b>' + wl + '</b></div><div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="crm">Open win-back</button><button type="button" class="btn btn-sm btn-ghost" data-own="crmimp">Import win-back list</button></div>');
    if (!(view && view.contains(byId('recPanel'))))
      ptr('setupPtrStanding', 'Standing rides (on the Board)', '<div class="setup-kv"><span>Weekly series running</span><b>' + rec + '</b></div><p class="hint" style="margin:4px 0 6px;">Make one from any trip with ↻ Repeat on the Board.</p><div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="standing">Open standing rides</button></div>');
    if (!(view && view.contains(byId('planPanel'))))
      ptr('setupPtrPlan', 'Plan (on Money → Business)', '<div class="setup-kv"><span>Private figures typed in</span>' + chipHtml(pi.have === pi.of, pi.have + ' of 4', pi.have + ' of 4', 'bad') + '</div><p class="hint" style="margin:4px 0 6px;">The bookkeeper types opening cash, Square credits, baseline net and payroll uplift in the 13-week cash sheet.</p><div class="btn-row"><button type="button" class="btn btn-sm btn-navy" data-own="plan">Open the Plan</button></div>');
  }

  /* ---------- click handling ---------- */
  function onHubClick(e) {
    var t = e.target;
    var chip = t.closest && t.closest('.setup-chip'); if (chip) { e.preventDefault(); jumpSection(chip.getAttribute('data-sec')); return; }
    var j = t.closest && t.closest('[data-jump]'); if (j) { e.preventDefault(); jumpSection(j.getAttribute('data-jump')); return; }
    var je = t.closest && t.closest('[data-jump-el]'); if (je) { e.preventDefault(); jumpEl(je.getAttribute('data-jump-el')); return; }
    var cl = t.closest && t.closest('[data-cl]');
    if (cl) {
      e.preventDefault();
      var key = cl.getAttribute('data-key'), what = cl.getAttribute('data-cl'), r = checklist().filter(function (x) { return x.key === key; })[0]; if (!r) return;
      if (what === 'skip' || what === 'unskip') { var u = setupState(); if (what === 'skip') u.acked[key] = nowISO(); else delete u.acked[key]; doSave(); refresh(); return; }
      runAction(r, what); return;
    }
    var o = t.closest && t.closest('[data-own]'); if (!o) return;
    e.preventDefault();
    switch (o.getAttribute('data-own')) {
      case 'editphone': jumpEl('s_phone'); break;
      case 'cheat': clickEl('s_cheat'); break;
      case 'cdr': openCdr(); break;
      case 'partner': jumpEl('opsSettings'); break;
      case 'gtest': if (clickEl('s_gtest')) setTimeout(function () { renderMapsCard(); }, 2500); break;
      case 'doctor': clickEl('b_doctor'); break;
      case 'gkey': jumpEl('s_gmapkey'); break;
      case 'rates': openRates(); break;
      case 'proposed': loadProposed(); break;
      case 'roster': go('fleet', 'opsRoster'); break;
      case 'settle': go('earnings', 'ledgerEarn'); break;
      case 'ledger': go('biz', 'ledgerBiz'); break;
      case 'crm': openWinback(false); break;
      case 'crmimp': openWinback(true); break;
      case 'standing': go('dispatch', 'recPanel'); break;
      case 'plan': openPlan(); break;
      case 'bexport': exportBundle(); break;
      case 'bapply': confirmImport(); break;
      case 'bcancel': pendingImport = null; renderDiff(); break;
      case 'sheet': printSheet(); break;
    }
  }
  function onHubChange(e) {
    var t = e.target; if (!t) return;
    if (t.id === 'setupIncKeys') { var w = byId('setupKeysWarn'); if (w) w.hidden = !t.checked; }
    else if (t.id === 'setupBundleFile') { var f = t.files && t.files[0]; t.value = ''; if (f) importBundleFile(f); }
  }

  /* ---------- (C) settings bundle ---------- */
  var SECRET_KEYS = ['gmapkey', 'geokey', 'adminPin'];
  var NEVER_IMPORT = { setup: 1, security: 1, adminPin: 1, expertMode: 1, simpleMode: 1 };
  function activeRates() { var r = copy(rates()) || {}; delete r.history; delete r.draft; return r; }
  function bundle(opts) {
    opts = opts || {};
    var s = copy(settings()) || {};
    if (!opts.includeKeys) {
      SECRET_KEYS.forEach(function (k) { delete s[k]; });
      if (s.cloud && typeof s.cloud === 'object') { delete s.cloud.url; delete s.cloud.anonKey; }
    }
    delete s.setup;
    delete s.security;   /* this station's own backup / restore-test record stays here */
    var out = {
      schema: 'skyway-settings-1', at: nowISO(), from: str(settings().name), keysIncluded: !!opts.includeKeys,
      settings: s, rates: activeRates(), feeTiers: copy(settings().feeTiers) || [], partnerBase: copy(settings().partnerBase) || null,
      cdrMapping: copy(settings().cdrMapping) || {}, region: copy(settings().region) || null, templates: copy(settings().templates) || {},
      staff: arr(STATE.staff).filter(function (x) { return x && x.name; }).map(function (x) { return { name: String(x.name), role: String(x.role || 'dispatcher'), active: x.active !== false }; })
    };
    return out;
  }
  function same(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
  function short(v) { if (v === undefined || v === null || v === '') return '(empty)'; var t = typeof v === 'object' ? JSON.stringify(v) : String(v); return t.length > 80 ? t.slice(0, 77) + '…' : t; }
  var RATE_KEYS = ['zones', 'grid', 'flats', 'addOns', 'meter', 'tiers', 'engine'];
  /* applyBundle(obj, {dryRun}) → {ok, error?, changes:[{key, old, new}], count, applied} */
  function applyBundle(obj, opts) {
    opts = opts || {};
    if (!obj || typeof obj !== 'object' || obj.schema !== 'skyway-settings-1' || !obj.settings || typeof obj.settings !== 'object' || Array.isArray(obj.settings)) return { ok: false, error: 'This is not a Skyway settings bundle.', changes: [], count: 0, applied: false };
    var cur = settings(), inc = copy(obj.settings), changes = [], ops = [];
    ['feeTiers', 'partnerBase', 'cdrMapping', 'region', 'templates'].forEach(function (k) { if (obj[k] !== undefined && obj[k] !== null && inc[k] === undefined) inc[k] = copy(obj[k]); });
    /* Cloud on/off and the Cloud location belong to this station, never to the file */
    if (inc.cloud && typeof inc.cloud === 'object') { delete inc.cloud.enabled; delete inc.cloud.locationId; }
    function badKey(k) { return k.charAt(0) === '_' || k === 'constructor' || k === 'prototype'; }
    Object.keys(inc).forEach(function (k) {
      if (NEVER_IMPORT[k] || badKey(k)) return;
      var nv = inc[k], ov = cur[k];
      if (nv && typeof nv === 'object' && !Array.isArray(nv) && ov && typeof ov === 'object' && !Array.isArray(ov)) {
        Object.keys(nv).forEach(function (sk) { if (badKey(sk)) return; if (!same(ov[sk], nv[sk])) { changes.push({ key: 'settings.' + k + '.' + sk, old: short(ov[sk]), new: short(nv[sk]) }); ops.push(function () { cur[k][sk] = copy(nv[sk]); }); } });
      } else if (!same(ov, nv)) {
        changes.push({ key: 'settings.' + k, old: short(ov), new: short(nv) }); ops.push(function () { cur[k] = copy(nv); });
      }
    });
    /* rate table → a DRAFT the owner activates (never activated here) */
    var br = obj.rates;
    if (br && typeof br === 'object' && Array.isArray(br.zones) && Array.isArray(br.grid)) {
      var act = rates(), differs = RATE_KEYS.some(function (k) { return !same(act[k], br[k]); });
      if (differs) {
        var maxV = Number(act.version) || 0; arr(act.history).forEach(function (h) { maxV = Math.max(maxV, Number(h && h.version) || 0); }); if (act.draft) maxV = Math.max(maxV, Number(act.draft.version) || 0);
        var d = copy(br); delete d.history; delete d.draft; delete d.exportedAt;
        d.version = maxV + 1; d.status = 'draft'; d.activatedAt = null; d.createdAt = nowISO(); d.name = str(br.name || 'Rate table') + ' (imported)'; delete d.retiredAt; delete d.syncedAt;
        changes.push({ key: 'rates.draft', old: act.draft ? 'draft version ' + act.draft.version : '(no draft)', new: 'draft version ' + d.version + ' from the bundle (not active until the owner activates it)' });
        ops.push(function () { if (STATE.rates && typeof STATE.rates === 'object') STATE.rates.draft = d; });
      }
    }
    /* staff names: added if missing, never overwritten, never with a PIN */
    var have = {}; arr(STATE.staff).forEach(function (x) { if (x && x.name) have[String(x.name).toLowerCase()] = 1; });
    arr(obj.staff).forEach(function (x) {
      if (!x || !str(x.name) || have[str(x.name).toLowerCase()]) return;
      var role = ['owner', 'dispatcher', 'bookkeeper'].indexOf(x.role) >= 0 ? x.role : 'dispatcher', name = str(x.name).slice(0, 60);
      have[name.toLowerCase()] = 1;
      changes.push({ key: 'staff + ' + name, old: '(not on this station)', new: role + ', no PIN yet' });
      ops.push(function () { if (!Array.isArray(STATE.staff)) STATE.staff = []; STATE.staff.push({ id: uid(), name: name, role: role, active: x.active !== false, legacy: false, createdAt: nowISO(), salt: '', hash: '', iter: 0, importedAt: nowISO() }); });
    });
    var res = { ok: true, changes: changes, count: changes.length, applied: false };
    if (opts.dryRun || !changes.length) return res;
    ops.forEach(function (f) { f(); });
    doSave(); res.applied = true;
    audit('settings', { ref: 'settings-bundle-import', changes: changes.length, from: str(obj.from) });
    try { if (typeof window.renderSettings === 'function') window.renderSettings(); } catch (e) {}
    try { if (window.Quote && typeof window.Quote.render === 'function') window.Quote.render(); } catch (e) {}
    try { if (window.Recover && typeof window.Recover.render === 'function') window.Recover.render(); } catch (e) {}
    refresh();
    return res;
  }
  function download(name, text) {
    try { var blob = new Blob([text], { type: 'application/json' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 800); return true; } catch (e) { return false; }
  }
  function exportBundle() {
    var inc = !!(byId('setupIncKeys') && byId('setupIncKeys').checked);
    return ownerOK('export the settings bundle').then(function (ok) {
      if (!ok) { toast('Settings bundle not exported: the owner PIN is needed.', true); return false; }
      var b = bundle({ includeKeys: inc }), name = 'skyway-settings-' + todayStr() + '.json';
      download(name, JSON.stringify(b, null, 2));
      audit('export', { ref: 'settings-bundle', keys: inc, file: name });
      toast('Settings bundle downloaded' + (inc ? ' WITH keys. Keep it private.' : ' (no keys, no PINs).'), inc);
      return b;
    });
  }
  var pendingImport = null;
  function importBundleFile(file) {
    return ownerOK('import a settings bundle').then(function (ok) {
      if (!ok) { toast('Not imported: the owner PIN is needed.', true); return false; }
      return new Promise(function (resolve) {
        var rd = new FileReader();
        rd.onload = function () { var obj = null; try { obj = JSON.parse(String(rd.result || '')); } catch (e) { obj = null; } resolve(previewImport(obj)); };
        rd.onerror = function () { toast('Could not read that file.', true); resolve(false); };
        rd.readAsText(file);
      });
    });
  }
  function previewImport(obj) {
    var r = applyBundle(obj, { dryRun: true });
    if (!r.ok) { pendingImport = null; renderDiff(r.error); toast(r.error, true); return r; }
    pendingImport = { obj: obj, res: r }; renderDiff(); return r;
  }
  function renderDiff(err) {
    var host = byId('setupDiff'); if (!host) return;
    if (err) { host.innerHTML = '<div class="setup-warn">' + esc(err) + '</div>'; return; }
    if (!pendingImport) { host.innerHTML = ''; return; }
    var r = pendingImport.res;
    if (!r.count) { host.innerHTML = '<div class="notice">The bundle matches this station. Nothing to change.</div>'; pendingImport = null; return; }
    host.innerHTML = '<h4 class="setup-h4">' + r.count + ' change' + (r.count === 1 ? '' : 's') + ' in the bundle from ' + esc(pendingImport.obj.from || 'another station') + '</h4><div class="tbl-scroll" style="max-height:260px;"><table class="data" id="setupDiffTbl"><thead><tr><th>Setting</th><th>Now</th><th>From the bundle</th></tr></thead><tbody>'
      + r.changes.map(function (c) { return '<tr><td class="mono">' + esc(c.key) + '</td><td>' + esc(c.old) + '</td><td>' + esc(c.new) + '</td></tr>'; }).join('')
      + '</tbody></table></div><p class="hint">Trips, drivers, vehicles, accounts, the books and the win-back list are not touched. A rate table arrives as a draft for the owner to activate.</p><div class="btn-row"><button type="button" class="btn btn-sm btn-go" data-own="bapply">Apply ' + r.count + ' change' + (r.count === 1 ? '' : 's') + '</button><button type="button" class="btn btn-sm btn-ghost" data-own="bcancel">Cancel</button></div>';
  }
  function confirmImport() {
    if (!pendingImport) return false;
    var r = applyBundle(pendingImport.obj, { dryRun: false });
    pendingImport = null; renderDiff();
    toast(r.ok ? (r.count ? r.count + ' setting' + (r.count === 1 ? '' : 's') + ' imported.' : 'Nothing to change.') : r.error, !r.ok);
    return r;
  }

  /* ---------- (D) station sheet ---------- */
  function yes(b) { return b ? 'yes' : 'no'; }
  function sheetHTML(opts) {
    opts = opts || {};
    var s = settings(), show = !!opts.showKeys, k = function (v) { v = str(v); return v ? (show ? v : mask(v)) : '(not set)'; };
    var R = rates(), pb = s.partnerBase || {}, cl = s.cloud || {}, rg = s.region || {}, pi = planInputs(), sm = summary();
    var station = str(cl.locationId) || 'this computer';
    var sec = function (title, rows) { return '<h2>' + esc(title) + '</h2><table>' + rows.map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1] == null || r[1] === '' ? '(not set)' : r[1]) + '</td></tr>'; }).join('') + '</table>'; };
    var nsf = s.noShowFee && typeof s.noShowFee === 'object' ? (s.noShowFee.mode || '') + (s.noShowFee.amount != null ? ' $' + s.noShowFee.amount : '') + (s.noShowFee.pct != null ? ' ' + s.noShowFee.pct + '%' : '') : s.noShowFee;
    var h = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(s.name || 'Skyway') + ' — station sheet</title><style>'
      + 'body{font-family:Calibri,"Segoe UI",Arial,sans-serif;color:#1f1f1f;margin:20px 28px;font-size:12px;}h1{font-size:19px;margin:0;}.sub{color:#555;margin:2px 0 8px;}'
      + 'h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.6px;color:#1c5b9c;border-bottom:1.5px solid #1c5b9c;margin:10px 0 4px;padding-bottom:1px;break-after:avoid;}'
      + 'table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ccc;padding:2px 6px;text-align:left;vertical-align:top;}th{width:38%;background:#f4f4f4;font-weight:600;}'
      + '.cols{columns:2;column-gap:22px;}.cols table{break-inside:avoid;}.btn{background:#1c5b9c;color:#fff;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;margin-bottom:10px;}@media print{.btn{display:none;}body{margin:10mm;}}'
      + '</style></head><body><button class="btn" onclick="window.print()">Print this page</button>'
      + '<h1>' + esc(s.name || 'Skyway Car Service') + ' — station sheet</h1><div class="sub">' + esc(todayStr()) + ' · station: ' + esc(station) + ' · go-live checklist ' + sm.done + ' of ' + sm.total + ' done, ' + sm.need + ' need the owner' + (show ? ' · KEYS SHOWN: keep this page private' : ' · keys masked') + '</div><div class="cols">';
    h += sec('Business', [['Company', s.name], ['Address', [s.addr, s.city].filter(Boolean).join(', ')], ['Phone', s.phone], ['TLC base licence', s.base], ['Invoice contact', [s.contact, s.title, s.cphone].filter(Boolean).join(' · ')], ['Parent / footer org', s.org], ['Card flat fee', isNum(s.ccu) ? '$' + Number(s.ccu).toFixed(2) : ''], ['Extra card %', s.cardPct], ['Historical price adjust %', s.priceAdjust]]);
    h += sec('Staff & access', [['Settings PIN', /^\d{4}$/.test(str(s.adminPin)) ? (show ? s.adminPin : 'set (••••)') : 'not set'], ['Staff', arr(STATE.staff).filter(function (x) { return x && x.active !== false; }).map(function (x) { return x.name + ' (' + x.role + (x.hash ? ', PIN' : ', no PIN') + ')'; }).join('; ') || 'none']]);
    h += sec('Phones & texting', [['Business number', s.phone], ['Consent sentence', consentText()], ['Texts go out', cloudOn() ? 'from the business number (Cloud on)' : 'from the phone\'s SMS app'], ['Custom text templates', String(Object.keys(s.templates || {}).length)]]);
    h += sec('Cloud', [['Cloud sync', cloudOn() ? 'on' : 'off'], ['Server address', k(cl.url)], ['Cloud key', k(cl.anonKey)], ['Location', cl.locationId]]);
    h += sec('Payments & money', [['Square card link', k(s.square)], ['Square pay link', k(s.squarePayLink)], ['Account gratuity %', s.autoGratuityPct == null ? '0' : s.autoGratuityPct], ['No-show fee', nsf], ['Card hold ×', s.holdFactor], ['Airport fee', isNum(s.paFee) ? '$' + Number(s.paFee).toFixed(2) : ''], ['Fee mode', s.feeMode], ['Pass-through lines on receipts', yes(s.itemizePassThroughs)]]);
    h += sec('Prices', [['Active version', 'v' + (R.version || '?') + ' · ' + (R.engine === 'v2' ? 'new pricing rules' : 'original console prices')], ['Filed with TLC', R.filedWithTlcAt || (R.belowFiledAck ? 'owner confirmed below the filed schedule' : 'not filed')], ['Draft', R.draft ? 'v' + R.draft.version : 'none'], ['Fee tiers', arr(s.feeTiers).map(function (t) { return (t.upTo == null ? 'above' : 'up to $' + t.upTo) + ': $' + t.fee; }).join(' · ')]]);
    var dg = driverGaps(), vg = vehicleGaps();
    h += sec('Drivers & vehicles', [['Eligibility check', s.enforceEligibility === false ? 'warn only' : 'blocks'], ['Vehicle required', yes(s.requireVehicle === true)], ['Drivers with every paper', dg.total ? (dg.total - dg.missing) + ' of ' + dg.total : 'none'], ['Vehicles with dates', vg.total ? (vg.total - vg.missing) + ' of ' + vg.total : 'none'], ['Partner base', pb.baseName ? pb.baseName + ' (' + (pb.baseLicence || '?') + ')' + (partnerOK() ? ', complete' : ', incomplete') : 'none']]);
    h += sec('Calls & phone system', [['Call-report column maps', String(cdrCount())], ['Calls logged', String(arr(STATE.calls).length)]]);
    h += sec('Customers & standing rides', [['Win-back list', String(worklistCount())], ['Standing ride series', String(arr(STATE.recurring).length)]]);
    h += sec('Plan', [['Private figures typed in', pi.have + ' of 4 (values are not printed)']]);
    h += sec('Maps & region', [['Google Maps key', k(s.gmapkey)], ['Address search key', k(s.geokey)], ['Region', [rg.name, rg.tz, rg.currency].filter(Boolean).join(' · ')], ['Auto-format addresses', yes(s.autoaddr !== false)]]);
    var lb = lastBackupAt();
    h += sec('Backup & recovery', [['Last backup', lb ? String(lb).slice(0, 16).replace('T', ' ') : 'none recorded'], ['Exports recorded', String(arr(STATE.exports).length)]]);
    h += sec('Display & modes', [['Mode', isSimple() ? 'Simple' : 'Expert'], ['Theme', s.theme]]);
    h += '</div></body></html>';
    return h;
  }
  function printSheet() {
    var show = !!(byId('setupShowKeys') && byId('setupShowKeys').checked);
    return ownerOK(show ? 'print the station sheet with keys' : 'print the station sheet').then(function (ok) {
      if (!ok) { toast('Station sheet not printed: the owner PIN is needed.', true); return false; }
      var html = sheetHTML({ showKeys: show }), w = null;
      try { w = window.open('', 'skyway_station_sheet', 'width=900,height=1000,menubar=no,toolbar=no,location=no,resizable=yes,scrollbars=yes'); } catch (e) { w = null; }
      if (w) { try { w.document.open(); w.document.write(html); w.document.close(); w.focus(); } catch (e) { w = null; } }
      if (!w && typeof window.openPrint === 'function') { try { window.openPrint(html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '')); w = true; } catch (e) {} }
      if (!w) { toast('Allow pop-ups for this page, then try again.', true); return false; }
      audit('print', { ref: 'station-sheet', keys: show });
      return true;
    });
  }

  /* ---------- Needs-you line ---------- */
  function snoozed() { var u = str(setupState().snoozedUntil); return !!(u && u >= todayStr()); }
  function snooze(days) { var d = new Date(); d.setDate(d.getDate() + (Number(days) > 0 ? Number(days) : 7)); var v = ymd(d); var u = setupState(); if (u.snoozedUntil !== v) { u.snoozedUntil = v; doSave(); } refreshNeedsYou(); return v; }
  function nyDue() { if (snoozed()) return 0; return summary().need; }
  function recountNeedsYou(host) {
    var head = host.querySelector('.ny-head'); if (!head) return;
    var n = host.querySelectorAll('.ny-item').length, cnt = head.querySelector('.ny-count');
    if (!cnt) { head.innerHTML = '<span class="ny-count">0</span> Needs you'; cnt = head.querySelector('.ny-count'); }
    cnt.textContent = String(n);
    var txt = head.childNodes[head.childNodes.length - 1];
    if (txt && txt.nodeType === 3) txt.textContent = n ? ' Needs you' : ' Nothing needs you right now';
    host.classList.toggle('ny-clear', !n);
  }
  var nyInjecting = false;
  function refreshNeedsYou() {
    var host = byId('needsYou'); if (!host || nyInjecting) return 0;
    watchNeedsYou(host);
    nyInjecting = true;
    try {
      var had = host.querySelector('.setup-ny'), k = isSimple() ? nyDue() : 0;
      if (!k) { if (had) { had.remove(); recountNeedsYou(host); } return 0; }
      var txt = '<b>Setup: ' + k + ' thing' + (k === 1 ? '' : 's') + ' need' + (k === 1 ? 's' : '') + ' the owner</b> — open Settings to see the go-live checklist.';
      if (had && had.__k === k) return k;
      host.querySelectorAll('.setup-ny').forEach(function (n) { n.remove(); });
      var div = document.createElement('div'); div.className = 'ny-item setup-ny'; div.setAttribute('data-kind', 'setup'); div.__k = k;
      div.innerHTML = '<span class="ny-dot soon"></span><span class="ny-txt">' + txt + '</span><span class="ny-acts"><button type="button" class="btn btn-sm btn-navy" data-setup-ny="open">Open Settings</button><button type="button" class="btn btn-sm btn-ghost" data-setup-ny="snooze" title="Hide this line for 7 days">Not now</button></span>';
      host.appendChild(div);
      recountNeedsYou(host);
      if (!host.__setupWired) {
        host.__setupWired = true;
        host.addEventListener('click', act(function (e) { var b = e.target && e.target.closest ? e.target.closest('[data-setup-ny]') : null; if (!b) return; e.preventDefault(); e.stopPropagation(); if (b.getAttribute('data-setup-ny') === 'open') openSettingsAt('setupChecklist'); else snooze(7); }));
      }
      return k;
    } catch (e) { try { console.error('[setup]', e); } catch (e2) {} return 0; }
    finally { nyInjecting = false; }
  }
  function watchNeedsYou(host) {
    if (!host || host.__setupObserved || !window.MutationObserver) return;
    host.__setupObserved = true;
    try { new MutationObserver(function () { if (nyInjecting) return; if (!host.querySelector('.setup-ny')) { try { if (isSimple() && nyDue()) refreshNeedsYou(); } catch (e) {} } }).observe(host, { childList: true }); } catch (e) {}
  }

  /* ---------- render / refresh ---------- */
  function refresh() {
    if (!hub) return;
    var rows = checklist();
    renderChecklist(rows); renderPhoneCard(); renderCallsCard(); renderMapsCard(); renderBundleCard(); renderPointers();
    rehome(); applySearch();
    refreshNeedsYou();
  }
  var refreshT = null;
  function scheduleRefresh() { if (refreshT) return; refreshT = setTimeout(function () { refreshT = null; try { if (hub) refresh(); else refreshNeedsYou(); } catch (e) { try { console.error('[setup]', e); } catch (e2) {} } }, 250); }
  function render() {
    if (!buildHub()) return false;
    watchView();
    rehome();
    refresh();
    if (settingsActive()) { var u = setupState(), td = todayStr(); if (String(u.lastChecklistAt || '').slice(0, 10) !== td) { u.lastChecklistAt = nowISO(); doSave(); } }
    return true;
  }

  /* ---------- wrappers ---------- */
  function wrapAfter(name, after) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__setupWrapped) return false;
    var w = function () { var r = orig.apply(this, arguments); try { after.apply(this, arguments); } catch (e) {} return r; };
    w.__setupWrapped = true; w._orig = orig; inheritFlags(w, orig);
    window[name] = w; return true;
  }
  function boot() {
    try { setupState(); } catch (e) {}
    try { render(); } catch (e) { try { console.error('[setup]', e); } catch (e2) {} }
    wrapAfter('save', scheduleRefresh);
    wrapAfter('saveNow', scheduleRefresh);
    wrapAfter('renderSettings', function () { render(); });
    wrapAfter('goTab', function (v) { if (v === 'settings') render(); });
    wrapAfter('refreshBoard', function () { refreshNeedsYou(); });
    wrapAfter('reloadFromStorage', scheduleRefresh);
    try { var S = window.Simple; if (S && typeof S.refreshNeedsYou === 'function' && !S.refreshNeedsYou.__setupWrapped) { var o = S.refreshNeedsYou, w = function () { var r = o.apply(this, arguments); try { refreshNeedsYou(); } catch (e) {} return r; }; w.__setupWrapped = true; w._orig = o; inheritFlags(w, o); S.refreshNeedsYou = w; } } catch (e) {}
    try { if (typeof SkyBus !== 'undefined' && SkyBus && typeof SkyBus.on === 'function') SkyBus.on(function (m) { if (m && m.type === 'state') scheduleRefresh(); }); } catch (e) {}
    try { refreshNeedsYou(); } catch (e) {}
    setTimeout(function () { try { rehome(); scheduleRefresh(); } catch (e) {} }, 600);   // recover.js renders its panels after an async step
  }

  window.Setup = {
    _loaded: true,
    render: render, refresh: refresh, checklist: checklist, summary: summary, bundle: bundle, applyBundle: applyBundle, sheetHTML: sheetHTML,
    refreshNeedsYou: refreshNeedsYou, snooze: snooze, exportBundle: exportBundle, previewImport: previewImport, confirmImport: confirmImport, printSheet: printSheet,
    ownerOK: ownerOK, jump: jumpSection, sections: SECTIONS.map(function (s) { return s.id; }), homeFor: homeFor
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
