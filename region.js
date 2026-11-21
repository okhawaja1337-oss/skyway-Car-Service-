/* ======================================================================
   Skyway — region.js
   Region profile, client-side part (PRODUCT-DESIGN.md §8 "Global / multi-region").

   - STATE.settings.region = {name, country, tz, currency, locale, units,
     phoneCC, mapCenter:{lat,lng}}; defaults written on first run (NYC).
   - Overrides window.money() with Intl.NumberFormat(locale, currency) so every
     amount in the console follows the region's currency (falls back to the
     original money() on any error).
   - Settings → "Region" card (country, time zone, currency, units, phone code,
     map center with "Use my location"). Save re-renders the current view.
   - Other files add their own small fields to the card through the slot
     #rg_extra: they listen for the 'region:rendered' event on document.

   Public API: window.Region = {get, set, defaults, fmtPhone, unitLabel,
     toUnits, fmtTime, tzNow, countries, render}
   Plain ES2019, no build step. Never edits index.html.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;

  /* SCREEN is a top-level `const` in index.html (lexical global): read by bare identifier. */
  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }

  /* ---------- tiny helpers ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[region] ' + m); } catch (e) {} }
  function save() { if (typeof window.save === 'function') { try { window.save(); } catch (e) {} } }
  function saveNow() { if (typeof window.saveNow === 'function') { try { window.saveNow(); return; } catch (e) {} } save(); }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { try { console.error('[region]', err); } catch (e2) {} } }; }

  /* Owner decision 10: NYC only for the pilot (a second region is a Settings task later; schema carries location_id). */
  var DEFAULTS = { name: 'New York', country: 'US', tz: 'America/New_York', currency: 'USD', locale: 'en-US', units: 'mi', phoneCC: '+1', mapCenter: { lat: 40.737, lng: -73.79 } };
  /* Owner decision 12: AeroDataBox for the pilot; the Phase 6 flight-poll function reads this (switch to 'flightaware' if airport pickups show late/missing updates). */
  var FLIGHT_PROVIDER_DEFAULT = 'aerodatabox';
  var FLIGHT_PROVIDER_LABELS = { aerodatabox: 'AeroDataBox', flightaware: 'FlightAware AeroAPI' };

  /* code, name, phone CC, currency, locale, default tz, units */
  var COUNTRIES = [
    ['US', 'United States', '+1', 'USD', 'en-US', 'America/New_York', 'mi'],
    ['CA', 'Canada', '+1', 'CAD', 'en-CA', 'America/Toronto', 'km'],
    ['GB', 'United Kingdom', '+44', 'GBP', 'en-GB', 'Europe/London', 'mi'],
    ['IE', 'Ireland', '+353', 'EUR', 'en-IE', 'Europe/Dublin', 'km'],
    ['FR', 'France', '+33', 'EUR', 'fr-FR', 'Europe/Paris', 'km'],
    ['ES', 'Spain', '+34', 'EUR', 'es-ES', 'Europe/Madrid', 'km'],
    ['DE', 'Germany', '+49', 'EUR', 'de-DE', 'Europe/Berlin', 'km'],
    ['IT', 'Italy', '+39', 'EUR', 'it-IT', 'Europe/Rome', 'km'],
    ['AU', 'Australia', '+61', 'AUD', 'en-AU', 'Australia/Sydney', 'km'],
    ['JP', 'Japan', '+81', 'JPY', 'ja-JP', 'Asia/Tokyo', 'km'],
    ['AE', 'United Arab Emirates', '+971', 'AED', 'en-AE', 'Asia/Dubai', 'km'],
    ['IN', 'India', '+91', 'INR', 'en-IN', 'Asia/Kolkata', 'km'],
    ['MX', 'Mexico', '+52', 'MXN', 'es-MX', 'America/Mexico_City', 'km'],
    ['BR', 'Brazil', '+55', 'BRL', 'pt-BR', 'America/Sao_Paulo', 'km']
  ];
  var ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
    'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Sao_Paulo',
    'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Berlin', 'Europe/Rome',
    'Asia/Dubai', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];
  var CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'JPY', 'AED', 'INR', 'MXN', 'BRL'];

  function countryRow(code) { code = String(code || '').toUpperCase(); for (var i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i][0] === code) return COUNTRIES[i]; return null; }

  /* ---------- state ---------- */
  function region() {
    if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {};
    var r = STATE.settings.region, changed = false;
    if (!r || typeof r !== 'object') { r = {}; STATE.settings.region = r; changed = true; }
    Object.keys(DEFAULTS).forEach(function (k) {
      if (k === 'mapCenter') {
        if (!r.mapCenter || typeof r.mapCenter !== 'object' || !isFinite(Number(r.mapCenter.lat)) || !isFinite(Number(r.mapCenter.lng))) { r.mapCenter = { lat: DEFAULTS.mapCenter.lat, lng: DEFAULTS.mapCenter.lng }; changed = true; }
      } else if (r[k] == null || r[k] === '') { r[k] = DEFAULTS[k]; changed = true; }
    });
    if (changed) save();
    return r;
  }
  /* settings.flightProvider: seeded once (save() only when it was missing); read by the Phase 6 flight-poll function */
  function flightProvider() {
    if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {};
    if (STATE.settings.flightProvider === undefined) { STATE.settings.flightProvider = FLIGHT_PROVIDER_DEFAULT; save(); }
    return String(STATE.settings.flightProvider || FLIGHT_PROVIDER_DEFAULT);
  }
  function flightProviderLabel() { var p = flightProvider(); return FLIGHT_PROVIDER_LABELS[p] || p; }
  function get() { var r = region(); return { name: r.name, country: r.country, tz: r.tz, currency: r.currency, locale: r.locale, units: r.units, phoneCC: r.phoneCC, mapCenter: { lat: Number(r.mapCenter.lat), lng: Number(r.mapCenter.lng) } }; }

  /* ---------- money override ---------- */
  var ORIG_MONEY = (typeof window.money === 'function') ? window.money : function (n) { n = Number(n) || 0; return '$' + n.toFixed(2); };
  var fmtCache = { key: '', fmt: null };
  function formatter() {
    var r = region(), key = (r.locale || 'en-US') + '|' + (r.currency || 'USD');
    if (fmtCache.key === key && fmtCache.fmt) return fmtCache.fmt;
    var f = null;
    try { f = new Intl.NumberFormat(r.locale || 'en-US', { style: 'currency', currency: String(r.currency || 'USD').toUpperCase() }); } catch (e) { f = null; }
    fmtCache = { key: key, fmt: f };
    return f;
  }
  function money(n) {
    try {
      var f = formatter();
      if (!f) return ORIG_MONEY(n);
      return f.format(Number(n) || 0);
    } catch (e) { try { return ORIG_MONEY(n); } catch (e2) { return '$' + (Number(n) || 0).toFixed(2); } }
  }
  money.original = ORIG_MONEY;
  window.money = money;   // pop-outs show amounts too: the override applies everywhere (the UI below is skipped there)

  /* ---------- phones ---------- */
  function fmtPhone(digits) {
    var s = String(digits == null ? '' : digits).trim(); if (!s) return '';
    var hadPlus = s.charAt(0) === '+';
    var d = s.replace(/\D/g, ''); if (!d) return s;
    var r = region(), cc = String(r.phoneCC || '+1').replace(/\D/g, '');
    var country = String(r.country || 'US').toUpperCase();
    if (country === 'US' || country === 'CA' || cc === '1') {
      if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
      if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
      if (d.length === 7) return d.slice(0, 3) + '-' + d.slice(3);
      return hadPlus ? '+' + d : s;
    }
    /* other countries: +CC then the national number in readable groups */
    var nat = d;
    if (cc && d.indexOf(cc) === 0 && d.length > cc.length + 4) nat = d.slice(cc.length);
    else if (!hadPlus && nat.charAt(0) === '0' && nat.length > 6) nat = nat.slice(1);   // trunk prefix (UK 020…, FR 06…)
    var groups = [];
    if (nat.length <= 4) groups = [nat];
    else if (nat.length <= 7) groups = [nat.slice(0, nat.length - 4), nat.slice(-4)];
    else if (nat.length === 10) groups = [nat.slice(0, 3), nat.slice(3, 6), nat.slice(6)];
    else { var head = nat.length % 4 || 4; groups = [nat.slice(0, head)]; for (var i = head; i < nat.length; i += 4) groups.push(nat.slice(i, i + 4)); }
    return '+' + cc + ' ' + groups.filter(Boolean).join(' ');
  }

  /* ---------- units ---------- */
  function unitLabel() { return region().units === 'km' ? 'km' : 'mi'; }
  function toUnits(miles) {
    var m = Number(miles); if (!isFinite(m)) m = 0;
    var v = region().units === 'km' ? m * 1.609344 : m;
    return Math.round(v * 10) / 10;
  }

  /* ---------- time ---------- */
  function fmtTime(date) {
    var d = date instanceof Date ? date : (date == null ? new Date() : new Date(date));
    if (isNaN(d)) return '';
    var r = region();
    try { return new Intl.DateTimeFormat(r.locale || 'en-US', { hour: 'numeric', minute: '2-digit', timeZone: r.tz || undefined }).format(d); }
    catch (e) { try { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d); } catch (e2) { return d.toTimeString().slice(0, 5); } }
  }
  /* A Date whose local fields (getHours etc.) read the region's wall clock. */
  function tzNow() {
    var now = new Date(), r = region();
    try { var s = now.toLocaleString('en-US', { timeZone: r.tz || 'America/New_York' }); var d = new Date(s); if (!isNaN(d)) return d; } catch (e) {}
    return now;
  }

  /* ---------- set ---------- */
  function set(obj) {
    var r = region(); obj = obj || {};
    ['name', 'country', 'tz', 'currency', 'locale', 'units', 'phoneCC'].forEach(function (k) { if (obj[k] != null && obj[k] !== '') r[k] = String(obj[k]).trim(); });
    if (obj.country) r.country = r.country.toUpperCase();
    if (obj.currency) r.currency = r.currency.toUpperCase();
    if (obj.units) r.units = /^k/i.test(obj.units) ? 'km' : 'mi';
    if (obj.phoneCC) { var cc = String(obj.phoneCC).replace(/[^\d]/g, ''); if (cc) r.phoneCC = '+' + cc; }
    if (obj.mapCenter && typeof obj.mapCenter === 'object') {
      var la = Number(obj.mapCenter.lat), ln = Number(obj.mapCenter.lng);
      if (isFinite(la) && isFinite(ln)) r.mapCenter = { lat: la, lng: ln };
    }
    fmtCache = { key: '', fmt: null };
    saveNow();
    try { document.dispatchEvent(new CustomEvent('region:changed', { detail: get() })); } catch (e) {}
    return get();
  }

  /* ---------- Settings card ---------- */
  var PANEL_ID = 'regionPanel';
  function ensureStyle() {
    if (byId('regionStyle')) return;
    var st = document.createElement('style'); st.id = 'regionStyle';
    st.textContent = [
      '.rg-panel .rg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 14px;}',
      '.rg-panel .rg-sub{font-size:11px;color:var(--muted,#5b5b5b);margin:-4px 0 8px;}',
      '.rg-panel .rg-note{margin-top:10px;}',
      '.rg-panel .rg-now{font-family:Consolas,monospace;font-size:12px;color:var(--green-dark,#15497d);}',
      '.rg-panel .rg-extra:empty{display:none;}',
      '.rg-panel .rg-extra{border-top:1px solid var(--line-soft,#e4e4e4);margin-top:10px;padding-top:10px;}',
      'body.gold .rg-panel .rg-now{color:#e8c75a;}',
      'body.classic .rg-panel .rg-now{color:#0a246a;}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  function opt(v, label, cur) { return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>'; }

  function render() {
    if (POPOUT) return;
    var view = byId('view-settings'); if (!view) return;
    ensureStyle();
    var r = region();
    var panel = byId(PANEL_ID);
    if (!panel) { panel = document.createElement('div'); panel.id = PANEL_ID; panel.className = 'panel rg-panel'; view.appendChild(panel); }
    var zones = ZONES.slice(); if (r.tz && zones.indexOf(r.tz) < 0) zones.unshift(r.tz);
    var curs = CURRENCIES.slice(); if (r.currency && curs.indexOf(r.currency) < 0) curs.unshift(r.currency);
    var h = '<div class="panel-head">Region <span class="hint" style="margin:0;font-weight:400;">where this office works: currency, time zone, phone format, map center</span></div><div class="panel-body">';
    h += '<p class="hint" style="margin-top:0;">New York is the first region. Change these once to run the console somewhere else &mdash; every amount, clock and phone number follows. Current time here: <span class="rg-now" id="rg_now">' + esc(fmtTime(new Date())) + '</span> (' + esc(r.tz) + ').</p>';
    h += '<div class="rg-grid">';
    h += '<label class="fld"><span class="lbl">Region name</span><input type="text" id="rg_name" value="' + esc(r.name) + '" placeholder="New York"></label>';
    h += '<label class="fld"><span class="lbl">Country</span><select id="rg_country">' + COUNTRIES.map(function (c) { return opt(c[0], c[1] + ' (' + c[0] + ')', r.country); }).join('') + (countryRow(r.country) ? '' : opt(r.country, r.country, r.country)) + '</select></label>';
    h += '<label class="fld"><span class="lbl">Time zone</span><select id="rg_tz">' + zones.map(function (z) { return opt(z, z, r.tz); }).join('') + '</select></label>';
    h += '<label class="fld"><span class="lbl">&hellip;or type an IANA zone (overrides)</span><input type="text" id="rg_tz_custom" placeholder="e.g. Europe/Lisbon" autocomplete="off"></label>';
    h += '<label class="fld"><span class="lbl">Currency</span><select id="rg_currency">' + curs.map(function (c) { return opt(c, c, r.currency); }).join('') + '</select></label>';
    h += '<label class="fld"><span class="lbl">&hellip;or type a currency code (overrides)</span><input type="text" id="rg_currency_custom" placeholder="CHF" maxlength="3" autocomplete="off" style="text-transform:uppercase;"></label>';
    h += '<label class="fld"><span class="lbl">Distance units</span><select id="rg_units">' + opt('mi', 'Miles (mi)', r.units) + opt('km', 'Kilometers (km)', r.units) + '</select></label>';
    h += '<label class="fld"><span class="lbl">Phone country code</span><input type="text" id="rg_cc" value="' + esc(r.phoneCC) + '" placeholder="+1"></label>';
    h += '<label class="fld"><span class="lbl">Number &amp; date locale</span><input type="text" id="rg_locale" value="' + esc(r.locale) + '" placeholder="en-US"></label>';
    h += '<label class="fld"><span class="lbl">Map center latitude</span><input type="number" step="0.0001" id="rg_lat" value="' + esc(r.mapCenter.lat) + '"></label>';
    h += '<label class="fld"><span class="lbl">Map center longitude</span><input type="number" step="0.0001" id="rg_lng" value="' + esc(r.mapCenter.lng) + '"></label>';
    h += '<label class="fld"><span class="lbl">&nbsp;</span><button class="btn btn-navy" type="button" id="rg_geo">&#128205; Use my location</button></label>';
    h += '</div>';
    h += '<div class="notice rg-note"><b>What stays New York only:</b> the NYC TLC meter (the Estimate tab\'s TLC rates) and the TLC trip-record export are built for New York City and keep working as they are. <b>Zone, flat-rate and distance pricing work anywhere</b> &mdash; draw zones on the Zone Map or set per-' + esc(unitLabel()) + ' rates on the Pricing tab.</div>';
    h += '<div class="hint" id="rg_flight" style="margin-top:8px;">Flight data: ' + esc(flightProviderLabel()) + ' (Phase 6)</div>';
    h += '<div class="rg-extra" id="rg_extra"></div>';
    h += '<div class="btn-row" style="margin-top:10px;"><button class="btn btn-go" type="button" id="rg_save">Save region</button><button class="btn btn-ghost" type="button" id="rg_reset">Back to New York defaults</button></div>';
    h += '<div class="hint" id="rg_status" style="margin-top:6px;"></div>';
    h += '</div>';
    panel.innerHTML = h;

    var sel = byId('rg_country');
    if (sel) sel.addEventListener('change', act(function () {
      var c = countryRow(sel.value); if (!c) return;
      var cc = byId('rg_cc'), cu = byId('rg_currency'), lo = byId('rg_locale'), tz = byId('rg_tz'), un = byId('rg_units');
      if (cc) cc.value = c[2];
      if (cu) { if (![].slice.call(cu.options).some(function (o) { return o.value === c[3]; })) cu.insertAdjacentHTML('afterbegin', opt(c[3], c[3], c[3])); cu.value = c[3]; }
      if (lo) lo.value = c[4];
      if (tz) { if (![].slice.call(tz.options).some(function (o) { return o.value === c[5]; })) tz.insertAdjacentHTML('afterbegin', opt(c[5], c[5], c[5])); tz.value = c[5]; }
      if (un) un.value = c[6];
      var st = byId('rg_status'); if (st) st.textContent = 'Filled in the usual currency, time zone, phone code and units for ' + c[1] + ' — adjust anything, then Save.';
    }));
    var geo = byId('rg_geo');
    if (geo) geo.addEventListener('click', act(function () {
      if (!navigator.geolocation) { toast('This browser cannot share its location.', true); return; }
      geo.disabled = true;
      navigator.geolocation.getCurrentPosition(function (p) {
        geo.disabled = false;
        var la = byId('rg_lat'), ln = byId('rg_lng');
        if (la) la.value = (Math.round(p.coords.latitude * 10000) / 10000);
        if (ln) ln.value = (Math.round(p.coords.longitude * 10000) / 10000);
        toast('Map center set to your location — press Save region.');
      }, function (err) { geo.disabled = false; toast('Location not available' + (err && err.message ? ': ' + err.message : '') + '.', true); }, { timeout: 10000, maximumAge: 60000 });
    }));
    var bs = byId('rg_save');
    if (bs) bs.addEventListener('click', act(function () {
      var v = function (id) { var el = byId(id); return el ? String(el.value || '').trim() : ''; };
      var tzc = v('rg_tz_custom'), cuc = v('rg_currency_custom').toUpperCase();
      if (tzc) { try { new Intl.DateTimeFormat('en-US', { timeZone: tzc }); } catch (e) { toast('"' + tzc + '" is not a known time zone (use e.g. Europe/Lisbon).', true); return; } }
      if (cuc) { if (!/^[A-Z]{3}$/.test(cuc)) { toast('Currency code must be 3 letters (e.g. CHF).', true); return; } try { new Intl.NumberFormat('en-US', { style: 'currency', currency: cuc }); } catch (e) { toast('"' + cuc + '" is not a known currency code.', true); return; } }
      set({ name: v('rg_name') || DEFAULTS.name, country: v('rg_country'), tz: tzc || v('rg_tz'), currency: cuc || v('rg_currency'), locale: v('rg_locale') || DEFAULTS.locale, units: v('rg_units'), phoneCC: v('rg_cc') || DEFAULTS.phoneCC, mapCenter: { lat: v('rg_lat'), lng: v('rg_lng') } });
      toast('Region saved: ' + region().name + ' · ' + region().currency + ' · ' + region().tz);
      rerenderCurrent();
    }));
    var br = byId('rg_reset');
    if (br) br.addEventListener('click', act(function () {
      if (!window.confirm('Put the region back to New York (USD, America/New_York, miles, +1)?')) return;
      set(JSON.parse(JSON.stringify(DEFAULTS)));
      toast('Region reset to New York.');
      rerenderCurrent();
    }));
    try { document.dispatchEvent(new CustomEvent('region:rendered', { detail: { panel: panel, extra: byId('rg_extra') } })); } catch (e) {}
  }

  function rerenderCurrent() {
    try { render(); } catch (e) {}
    var v = '';
    try { if (typeof ACTIVE_VIEW !== 'undefined') v = ACTIVE_VIEW; else if (window.ACTIVE_VIEW) v = window.ACTIVE_VIEW; } catch (e) { v = ''; }
    if (!v) { var a = document.querySelector('.view.active'); if (a && a.id) v = a.id.replace(/^view-/, ''); }
    if (v && v !== 'settings' && typeof window.renderView === 'function') { try { window.renderView(v); } catch (e) {} }
    if (typeof window.refreshBoard === 'function') { try { window.refreshBoard(); } catch (e) {} }
  }

  /* keep the card's values in step with STATE whenever the Settings tab re-renders (backup import etc.) */
  function hookRenderSettings() {
    if (POPOUT) return;
    var orig = window.renderSettings;
    if (typeof orig !== 'function' || orig.__regionWrapped) return;
    var wrapped = function () { var out; try { out = orig.apply(this, arguments); } finally { try { render(); } catch (e) {} } return out; };
    wrapped.__regionWrapped = true;
    window.renderSettings = wrapped;
  }

  /* ---------- public API ---------- */
  window.Region = {
    get: get, set: set, defaults: JSON.parse(JSON.stringify(DEFAULTS)), countries: COUNTRIES.map(function (c) { return { code: c[0], name: c[1], phoneCC: c[2], currency: c[3], locale: c[4], tz: c[5], units: c[6] }; }),
    fmtPhone: fmtPhone, unitLabel: unitLabel, toUnits: toUnits, fmtTime: fmtTime, tzNow: tzNow,
    money: money, render: render, flightProvider: flightProvider
  };

  /* ---------- boot ---------- */
  function boot() {
    try { region(); } catch (e) {}
    try { flightProvider(); } catch (e) {}
    if (POPOUT) return;
    try { hookRenderSettings(); } catch (e) {}
    try { render(); } catch (e) {}
    try { setInterval(function () { var el = byId('rg_now'); if (el) el.textContent = fmtTime(new Date()); }, 30000); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
