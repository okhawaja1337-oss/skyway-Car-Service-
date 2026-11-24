/* ======================================================================
   Skyway — tolls.js
   Every quoted price includes tolls and fees: worked out automatically,
   listed line by line, and always editable by the dispatcher.

   (a) Crossing detector. Tolls.tollsFor({puAddr, doAddr, stops[], vtype, rt, when, routeGeo?, quote?})
       → {tolls:[{key,label,amount,source}], free:[labels], fees:[{key,label,amount}],
          tollsTotal, feesTotal, total (= tollsTotal + feesTotal), confidence:'route'|'table'|'none',
          notes[], areas[]}
       Source 'route': a road route geometry (GeoJSON LineString from the console's routeFor / gRoute,
       Google first, OSRM as the console's own backup) is checked against a built-in table of crossing
       midpoints. Source 'table': no geometry, so each leg (pick-up → stops → drop-off) is classified
       by area (Tolls.areaOf) and the usual crossing for that pair is used, for a car based in Queens.
       Rates come from NYCFARE.RATES.tolls (E-ZPass or Tolls by Mail, settings.tolls.rateType), with
       owner overrides in settings.tolls.rates. A round trip doubles the tolls (fees are charged once).
   (b) Fees. NYS congestion surcharge (NYCFARE.RATES.nysCongestionSurcharge.fhvStandard) when the trip
       begins, ends or passes through Manhattan below 96th St; MTA Congestion Relief Zone per-trip FHV
       charge (NYCFARE.RATES.crzPerTripCharge.fhvStandard) when it touches Manhattan at/below 60th St;
       Port Authority airport access fee (settings.paFee) once per airport pick-up / drop-off.
       No double counting with quote.js: quote.js has no hook a module can register into, so this file
       SUPPRESSES its own line when the active quote already carries it — a 'govManhattan' component
       (rate version 2 Manhattan charges) drops the congestion and CRZ lines, a 'paFee' component drops
       the airport fee line. The form reads Quote.pending(); a saved trip reads t.quote.components.
   (c) Book form. Wraps maybeAutoFare, updateReadout, updateDispMap, editTrip, clearDispatch, useLastTrip,
       routeFor (to keep the road geometry of the current form) and listens to address / stop / round-trip
       changes. Fills d_tolls (dataset.auto='1') with a chip "auto · Queens-Midtown $7.00 + 1 fee" whose
       popover lists every line; a hand-typed value (dataset.auto='') wins until an address changes;
       clearing the box puts it back on auto. Adds a "Fees" row to the readout and makes
       r_total = fare + tolls + fees + card fee. On save: t.tolls (console meaning: tolls charged to the
       passenger), t.tollDetail, t.fees, t.feesTotal, t.tollsQuoted; t.quote.components gain
       {key:'tolls'} and {key:'fee:<x>'} lines marked passThrough:true (quote.total is not changed, so
       quote.js's price check is unaffected). Receipt and invoice list them; the Board row shows them.
       The edit overlay (saveEditOvl, also in the Reservations / Calls pop-outs) recomputes from the
       crossing table when an address changes (the saved road line belongs to the old addresses).
       Collecting: Money.total, Messages.render / vars are wrapped to add t.feesTotal; Money-tab and
       message-menu actions on a trip with fees get the fee-inclusive amount in the toast, the sms: body
       and the copied text (see "collecting the fees" below).
   (d) Driver-reported tolls: a "Tolls paid ($)" box in the edit overlay, Tolls.reportTolls(tripId, amount)
       or a pasted driver "D #1234 … tolls 9.80" text (Tolls.parseDriverReport). t.tollsQuoted keeps the
       quote, t.tolls becomes what was paid, the Board row says "tolls +$2.80 vs quote". ledger.js reads
       t.tolls as before.
   (e) Settings panel "Tolls & fees" (setup.js files it under Prices; until setup.js knows it this file
       moves it there itself).
   (f) API: window.Tolls = {tollsFor, feesFor, areaOf, refreshForm, settings, reportTolls,
       parseDriverReport, rateFor, crossings, allIn, _loaded:true}.

   STATE keys owned here: settings.tolls {rateType:'ezpass'|'tollsByMail', includeInQuote, preferTunnel,
     njRoute:'lincoln'|'gwb', manBronx:'free'|'henryHudson', chargeCongestion, chargeCrz, chargePaFee,
     rates{key:{ezpass,tollsByMail}}}, trips[].tollDetail, trips[].fees, trips[].feesTotal, trips[].tollsQuoted.
   Offline first: no network of its own. Skips all UI in pop-outs (the logic-only wraps still run there). Never edits index.html.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;
  if (window.Tolls && window.Tolls._loaded) return;

  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }

  /* ---------- helpers ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { try { if (typeof window.toast === 'function') { window.toast(m, w); return; } } catch (e) {} }
  function save() { try { if (typeof window.save === 'function') { window.save(); return; } } catch (e) {} try { if (typeof window.saveNow === 'function') window.saveNow(); } catch (e) {} }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function num(n) { n = Number(n); return isFinite(n) ? n : 0; }
  function money(n) { return '$' + num(n).toFixed(2); }
  function up(s) { return String(s == null ? '' : s).toUpperCase(); }
  function copy(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }
  function act(fn) { return function (e) { try { return fn.apply(this, arguments); } catch (err) { try { console.warn('[tolls]', err); } catch (e2) {} } }; }
  function g(name) { var f = window[name]; return typeof f === 'function' ? f : null; }
  function callG(name) { var f = g(name); if (!f) return null; try { return f.apply(null, Array.prototype.slice.call(arguments, 1)); } catch (e) { return null; } }
  function trips() { return Array.isArray(STATE.trips) ? STATE.trips : []; }
  function findTrip(id) { if (id && typeof id === 'object') return id; return trips().filter(function (t) { return t && t.id === id; })[0] || null; }
  function addrOf(s) { if (s == null) return ''; if (typeof s === 'string') return s; return String(s.addr || s.address || ''); }

  /* Wrap a console global: wrapper._orig, marker __tollsWrapped, inner marker flags copied to the outer function. */
  function inheritFlags(w, orig) { try { Object.keys(orig).forEach(function (k) { if (/^_{1,2}\w*Wrapped$/.test(k) && w[k] === undefined) w[k] = orig[k]; }); } catch (e) {} return w; }
  function hook(name, make) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__tollsWrapped) return false;
    var w = make(orig);
    w.__tollsWrapped = true; w._orig = orig; inheritFlags(w, orig);
    window[name] = w;
    return true;
  }
  function hookAfter(name, after) {
    return hook(name, function (orig) { return function () { var out; try { out = orig.apply(this, arguments); } finally { try { after.apply(this, arguments); } catch (e) {} } return out; }; });
  }

  /* ---------- settings ---------- */
  var DEFAULTS = { rateType: 'ezpass', includeInQuote: true, preferTunnel: false, njRoute: 'lincoln', manBronx: 'free', chargeCongestion: true, chargeCrz: true, chargePaFee: true };
  function S() { if (!STATE.settings || typeof STATE.settings !== 'object' || Array.isArray(STATE.settings)) STATE.settings = {}; return STATE.settings; }
  function ensureSettings() {
    var s = S(), t = s.tolls, dirty = false;
    if (!t || typeof t !== 'object' || Array.isArray(t)) { t = s.tolls = {}; dirty = true; }
    if (t.rateType !== 'ezpass' && t.rateType !== 'tollsByMail') { t.rateType = DEFAULTS.rateType; dirty = true; }
    ['includeInQuote', 'preferTunnel', 'chargeCongestion', 'chargeCrz', 'chargePaFee'].forEach(function (k) { if (typeof t[k] !== 'boolean') { t[k] = DEFAULTS[k]; dirty = true; } });
    if (t.njRoute !== 'lincoln' && t.njRoute !== 'gwb') { t.njRoute = DEFAULTS.njRoute; dirty = true; }
    if (t.manBronx !== 'free' && t.manBronx !== 'henryHudson') { t.manBronx = DEFAULTS.manBronx; dirty = true; }
    if (!t.rates || typeof t.rates !== 'object' || Array.isArray(t.rates)) { t.rates = {}; dirty = true; }
    Object.keys(t.rates).forEach(function (k) {
      var r = t.rates[k];
      if (!r || typeof r !== 'object' || !(isFinite(Number(r.ezpass)) || isFinite(Number(r.tollsByMail)))) { delete t.rates[k]; dirty = true; }
    });
    return dirty;
  }
  function TS() { ensureSettings(); return S().tolls; }

  /* ---------- rates ---------- */
  function R() { try { if (typeof NYCFARE !== 'undefined' && NYCFARE && NYCFARE.RATES) return NYCFARE.RATES; } catch (e) {} try { if (window.NYCFARE && window.NYCFARE.RATES) return window.NYCFARE.RATES; } catch (e) {} return null; }
  /* built-in fallback only for a console without the RATES block (values as in index.html's table) */
  var FALLBACK_TOLLS = {
    'verrazzano-narrows': { ezpass: 7.46, tollsByMail: 12.85 }, 'rfk-triborough': { ezpass: 7.46, tollsByMail: 12.85 },
    'bronx-whitestone': { ezpass: 7.00, tollsByMail: 11.94 }, 'throgs-neck': { ezpass: 7.00, tollsByMail: 11.94 },
    'queens-midtown-tunnel': { ezpass: 7.00, tollsByMail: 11.94 }, 'hugh-l-carey-tunnel': { ezpass: 7.46, tollsByMail: 12.85 },
    'henry-hudson': { ezpass: 3.42, tollsByMail: 5.50 }, 'cross-bay': { ezpass: 2.80, tollsByMail: 4.65 }, 'marine-parkway': { ezpass: 2.80, tollsByMail: 4.65 },
    'lincoln-tunnel': { ezpass: 17.00, tollsByMail: 22.00 }, 'holland-tunnel': { ezpass: 17.00, tollsByMail: 22.00 }, 'george-washington': { ezpass: 17.00, tollsByMail: 22.00 }
  };
  function baseRate(key) { var r = R(), T = (r && r.tolls) || FALLBACK_TOLLS; return T[key] || FALLBACK_TOLLS[key] || null; }
  function rateFor(key, type) {
    type = type || TS().rateType;
    var o = TS().rates[key];
    if (o && isFinite(Number(o[type])) && o[type] !== '' && o[type] != null) return round2(o[type]);
    var b = baseRate(key); if (!b) return 0;
    return round2(b[type] != null ? b[type] : b.ezpass);
  }
  function congestionFee() { var r = R(), v = r && r.nysCongestionSurcharge ? Number(r.nysCongestionSurcharge.fhvStandard) : NaN; return isFinite(v) ? round2(v) : 2.75; }
  function crzFee() { var r = R(), v = r && r.crzPerTripCharge ? Number(r.crzPerTripCharge.fhvStandard) : NaN; return isFinite(v) ? round2(v) : 0.75; }
  function paFee() {
    try { if (window.Quote && typeof window.Quote.paFee === 'function') { var q = Number(window.Quote.paFee()); if (isFinite(q) && q >= 0) return round2(q); } } catch (e) {}
    var v = Number(S().paFee); return (isFinite(v) && v >= 0) ? round2(v) : 3.50;
  }

  /* ---------- crossings (midpoints, lat/lng) ---------- */
  var CROSSINGS = {
    'queens-midtown-tunnel': { label: 'Queens-Midtown Tunnel', short: 'Queens-Midtown', lat: 40.7445, lng: -73.9650 },
    'bronx-whitestone': { label: 'Bronx-Whitestone Bridge', short: 'Whitestone', lat: 40.8010, lng: -73.8290 },
    'throgs-neck': { label: 'Throgs Neck Bridge', short: 'Throgs Neck', lat: 40.8005, lng: -73.7935 },
    'verrazzano-narrows': { label: 'Verrazzano-Narrows Bridge', short: 'Verrazzano', lat: 40.6066, lng: -74.0447 },
    'rfk-triborough': { label: 'RFK (Triborough) Bridge', short: 'RFK', lat: 40.7800, lng: -73.9260 },
    'hugh-l-carey-tunnel': { label: 'Hugh L. Carey Tunnel', short: 'Hugh Carey', lat: 40.6955, lng: -74.0140 },
    'henry-hudson': { label: 'Henry Hudson Bridge', short: 'Henry Hudson', lat: 40.8777, lng: -73.9220 },
    'cross-bay': { label: 'Cross Bay Bridge', short: 'Cross Bay', lat: 40.5935, lng: -73.8190 },
    'marine-parkway': { label: 'Marine Parkway Bridge', short: 'Marine Parkway', lat: 40.5735, lng: -73.8855 },
    'lincoln-tunnel': { label: 'Lincoln Tunnel', short: 'Lincoln', lat: 40.7620, lng: -74.0120 },
    'holland-tunnel': { label: 'Holland Tunnel', short: 'Holland', lat: 40.7272, lng: -74.0215 },
    'george-washington': { label: 'George Washington Bridge', short: 'GWB', lat: 40.8517, lng: -73.9527 }
  };
  var FREE = {
    'queensboro': { label: 'Ed Koch Queensboro Bridge (free)', lat: 40.7570, lng: -73.9545 },
    'williamsburg': { label: 'Williamsburg Bridge (free)', lat: 40.7137, lng: -73.9726 },
    'manhattan-br': { label: 'Manhattan Bridge (free)', lat: 40.7075, lng: -73.9908 },
    'brooklyn-br': { label: 'Brooklyn Bridge (free)', lat: 40.7061, lng: -73.9969 }
  };
  /* Manhattan below 96th St and at/below 60th St, rough shoreline polygons [lat, lng] */
  var POLY_96 = [[40.7000, -74.0190], [40.7200, -74.0150], [40.7520, -74.0110], [40.7735, -73.9945], [40.7870, -73.9870], [40.7985, -73.9780], [40.7835, -73.9430], [40.7700, -73.9480], [40.7590, -73.9580], [40.7420, -73.9705], [40.7110, -73.9760], [40.7070, -73.9985], [40.7010, -74.0120]];
  var POLY_60 = [[40.7000, -74.0190], [40.7200, -74.0150], [40.7520, -74.0110], [40.7735, -73.9945], [40.7590, -73.9580], [40.7420, -73.9705], [40.7110, -73.9760], [40.7070, -73.9985], [40.7010, -74.0120]];
  var NEAR_KM = 0.3;

  /* ---------- areas ---------- */
  var AREA_LABEL = { QNS: 'Queens', BK: 'Brooklyn', BX: 'Bronx', MAN_LO: 'Manhattan (60th St and below)', MAN_MID: 'Manhattan (61st–95th St)', MAN_HI: 'Manhattan (96th St and above)', SI: 'Staten Island', NAS: 'Nassau / Long Island', WES: 'Westchester', NJ: 'New Jersey', EWR: 'Newark Airport', RK: 'Rockaways', JFK: 'JFK Airport', LGA: 'LaGuardia Airport', UNK: 'Unknown area' };
  var RE = {
    rk: /\b(FAR ROCKAWAY|ROCKAWAY PARK|ROCKAWAY BEACH|ROCKAWAY POINT|BREEZY POINT|ARVERNE|BELLE HARBOR|NEPONSIT|BROAD CHANNEL|EDGEMERE|BAYSWATER|THE ROCKAWAYS|ROCKAWAYS)\b|\bROCKAWAY\b(?!\s+(BLVD|BOULEVARD|PKWY|PARKWAY|TPKE|TURNPIKE|AVE|AVENUE|RD|ROAD|ST|STREET|BEACH BLVD))/,
    si: /\b(STATEN ISLAND|TOTTENVILLE|GREAT KILLS|NEW DORP|ST\.? GEORGE FERRY)\b/,
    bx: /\b(BRONX|WILLIAMSBRIDGE|RIVERDALE|FORDHAM|PELHAM BAY|PELHAM PKWY|PELHAM PARKWAY|PELHAM GARDENS|CO-?OP CITY|PARKCHESTER|MOTT HAVEN|HUNTS POINT|SOUNDVIEW|MORRIS PARK|KINGSBRIDGE|WAKEFIELD|CASTLE HILL|CITY ISLAND|YANKEE STADIUM|HIGHBRIDGE|TREMONT|NORWOOD|BEDFORD PARK|SPUYTEN DUYVIL|THROGS NECK(?! BR)|SCHUYLERVILLE|BAYCHESTER|EASTCHESTER|MORRISANIA|CONCOURSE)\b/,
    nj: /\b(NEW JERSEY|N\.?J\.?|JERSEY CITY|HOBOKEN|FORT LEE|PARAMUS|HACKENSACK|TEANECK|ENGLEWOOD|WEEHAWKEN|SECAUCUS|BAYONNE|UNION CITY|WEST NEW YORK|EDGEWATER|MONTCLAIR|MORRISTOWN|PRINCETON|ATLANTIC CITY|ELIZABETH,? NJ|NEWARK)\b/,
    wes: /\b(WESTCHESTER(?! AVE| AVENUE| SQ)|YONKERS|WHITE PLAINS(?! RD| ROAD)|NEW ROCHELLE|MOUNT VERNON|MT\.? VERNON|SCARSDALE|RYE BROOK|RYE,? NY|PORT CHESTER|MAMARONECK|LARCHMONT|TARRYTOWN|DOBBS FERRY|HASTINGS[- ]ON[- ]HUDSON|OSSINING|PEEKSKILL|ELMSFORD|VALHALLA|ARMONK|BRONXVILLE|PELHAM MANOR|HARRISON,? NY)\b/,
    bk: /\b(BROOKLYN|WILLIAMSBURG|BUSHWICK|BED[- ]?STUY|BEDFORD[- ]STUYVESANT|PARK SLOPE|BROWNSVILLE|FLATBUSH|BAY RIDGE|SHEEPSHEAD|CONEY ISLAND|BENSONHURST|BOROUGH PARK|BORO PARK|CROWN HEIGHTS|DUMBO|CANARSIE|EAST NEW YORK|GREENPOINT|RED HOOK|SUNSET PARK|DYKER HEIGHTS|MARINE PARK|MILL BASIN|BERGEN BEACH|GRAVESEND|MIDWOOD|FORT GREENE|CLINTON HILL|COBBLE HILL|CARROLL GARDENS|GOWANUS|BRIGHTON BEACH|MANHATTAN BEACH|KINGS PLAZA|BARCLAYS CENTER)\b/,
    man: /\b(MANHATTAN(?! BEACH| AVE| AVENUE)|NEW YORK,? NY|NEW YORK CITY|NYC|MIDTOWN|SOHO|TRIBECA|CHELSEA|TIMES SQ|TIMES SQUARE|PENN STATION|GRAND CENTRAL|PORT AUTHORITY BUS|JAVITS|WALL ST|FINANCIAL DISTRICT|FIDI|BATTERY PARK|GREENWICH VILLAGE|EAST VILLAGE|WEST VILLAGE|GRAMERCY|MURRAY HILL|KIPS BAY|FLATIRON|NOHO|NOLITA|CHINATOWN|LOWER EAST SIDE|HELL'?S KITCHEN|HELLS KITCHEN|HUDSON YARDS|ROCKEFELLER|LINCOLN CENTER|COLUMBUS CIRCLE|HARLEM|WASHINGTON HEIGHTS|INWOOD,? NY 10034|MORNINGSIDE|UPPER EAST|UPPER WEST|YORKVILLE|LENOX HILL|HAMILTON HEIGHTS|SUGAR HILL|EMPIRE STATE|CENTRAL PARK|MADISON SQ)\b/,
    nas: /\b(NASSAU|SUFFOLK|LONG ISLAND(?! CITY)|GREAT NECK|GARDEN CITY|HEMPSTEAD|MINEOLA|VALLEY STREAM|HICKSVILLE|LEVITTOWN|MASSAPEQUA|OCEANSIDE|ROSLYN|MANHASSET|ELMONT|UNIONDALE|EAST MEADOW|ROCKVILLE CENTRE|WESTBURY|FREEPORT|LONG BEACH|WANTAGH|NEW HYDE PARK|PORT WASHINGTON|SYOSSET|PLAINVIEW|BETHPAGE|FARMINGDALE|MERRICK|BELLMORE|BALDWIN|LYNBROOK|FRANKLIN SQUARE|GREEN ACRES|CEDARHURST|WOODMERE|HEWLETT|ISLAND PARK|HUNTINGTON|MELVILLE|JERICHO|GLEN COVE|OYSTER BAY|LAKE SUCCESS)\b/,
    qns: /\b(QUEENS|ASTORIA|LONG ISLAND CITY|LIC|FLUSHING|JAMAICA|ELMHURST|CORONA|WOODSIDE|JACKSON HEIGHTS|FOREST HILLS|REGO PARK|KEW GARDENS|FRESH MEADOWS|BAYSIDE|WHITESTONE|COLLEGE POINT|HOWARD BEACH|OZONE PARK|RICHMOND HILL|WOODHAVEN|GLENDALE|RIDGEWOOD|MASPETH|MIDDLE VILLAGE|SUNNYSIDE|HOLLIS|QUEENS VILLAGE|ST\.? ALBANS|SPRINGFIELD GARDENS|ROSEDALE|LAURELTON|CAMBRIA HEIGHTS|BELLEROSE|GLEN OAKS|DOUGLASTON|LITTLE NECK|FORT TOTTEN|UTOPIA|POMONOK|BRIARWOOD|HILLCREST|AUBURNDALE|OAKLAND GARDENS|EAST ELMHURST|SOUTH OZONE PARK)\b/,
    hi: /\b(HARLEM|EAST HARLEM|SPANISH HARLEM|WASHINGTON HEIGHTS|INWOOD|MORNINGSIDE|HAMILTON HEIGHTS|SUGAR HILL|MANHATTANVILLE|COLUMBIA UNIV|MARBLE HILL|FORT TRYON|CLOISTERS)\b/,
    mid: /\b(UPPER EAST|UPPER WEST|UES|UWS|LENOX HILL|YORKVILLE|CARNEGIE HILL|LINCOLN SQ|LINCOLN CENTER|ROOSEVELT ISLAND)\b/,
    lo: /\b(MIDTOWN|SOHO|TRIBECA|CHELSEA|TIMES SQ|TIMES SQUARE|PENN STATION|GRAND CENTRAL|PORT AUTHORITY BUS|JAVITS|WALL ST|FINANCIAL DISTRICT|FIDI|BATTERY PARK|GREENWICH VILLAGE|EAST VILLAGE|WEST VILLAGE|GRAMERCY|MURRAY HILL|KIPS BAY|FLATIRON|NOHO|NOLITA|CHINATOWN|LOWER EAST SIDE|HELL'?S KITCHEN|HELLS KITCHEN|HUDSON YARDS|ROCKEFELLER|COLUMBUS CIRCLE|EMPIRE STATE|MADISON SQ)\b/
  };
  var GENERIC_NY = /\b(NEW YORK,? NY|NEW YORK CITY|NYC)\b/g;
  var MAN_HI_ZIP = /^100(26|27|29|30|31|32|33|34|35|37|39|40)$/;
  var MAN_MID_ZIP = /^100(21|23|24|25|28|44|65|69|75|128)$|^10128$/;
  function zipOf(A) { var m = A.match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/); return m ? m[1] : ''; }
  function zipArea(z) {
    if (!z) return null;
    var n = Number(z);
    if (/^0[78]/.test(z)) return 'NJ';
    if (n >= 10001 && n <= 10299) return 'MAN';
    if (n >= 10301 && n <= 10314) return 'SI';
    if (n >= 10451 && n <= 10475) return 'BX';
    if (n >= 10501 && n <= 10805) return 'WES';
    if (n >= 11201 && n <= 11256) return 'BK';
    if (n >= 11690 && n <= 11697) return 'RK';
    if (n === 11004 || n === 11005 || (n >= 11101 && n <= 11120) || (n >= 11351 && n <= 11499) || (n >= 11411 && n <= 11436)) return 'QNS';
    if ((n >= 11001 && n <= 11099) || (n >= 11501 && n <= 11999)) return 'NAS';
    return null;
  }
  /* Manhattan: which band (60th St and below / 61st–95th / 96th and above) */
  function manBand(A) {
    if (RE.hi.test(A)) return { a: 'MAN_HI', how: 'neighbourhood' };
    var m = A.match(/\b(?:E|W|EAST|WEST)\.?\s+(\d{1,3})(?:ST|ND|RD|TH)?\s+(?:ST|STREET)\b/) || A.match(/\b(\d{1,3})(?:ST|ND|RD|TH)\s+(?:ST|STREET)\b/);
    if (m) { var n = Number(m[1]); if (n > 0 && n <= 230) return { a: n <= 60 ? 'MAN_LO' : (n < 96 ? 'MAN_MID' : 'MAN_HI'), how: 'street', street: n }; }
    var z = zipOf(A);
    if (z && /^10/.test(z)) { if (MAN_HI_ZIP.test(z)) return { a: 'MAN_HI', how: 'zip' }; if (MAN_MID_ZIP.test(z)) return { a: 'MAN_MID', how: 'zip' }; if (Number(z) >= 10001 && Number(z) <= 10299) return { a: 'MAN_LO', how: 'zip' }; }
    if (RE.mid.test(A)) return { a: 'MAN_MID', how: 'neighbourhood' };
    if (RE.lo.test(A)) return { a: 'MAN_LO', how: 'neighbourhood' };
    return { a: 'MAN_LO', how: 'assumed', note: 'street not recognised, so treated as Midtown (60th St and below)' };
  }
  function mk(a, how, extra) { var o = { area: a, label: AREA_LABEL[a] || a, how: how }; if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; }); return o; }
  /* areaOf(addr) → {area, label, how, street?, note?}. Order matters: airports, Rockaways, then the boroughs that share
     words with others (Brooklyn's "Manhattan Beach", Bronx's "White Plains Rd" / "Westchester Ave") before the generic ones. */
  function areaOf(addr) {
    var A = up(addr).replace(/\s+/g, ' ').trim();
    if (!A) return mk('UNK', 'empty');
    var ap = callG('airportKey', A);
    /* the console's airportKey reads any KENNEDY / NEWARK as the airport: a Kennedy Blvd or a Newark street is not */
    if (ap === 'JFK' && !/\bJFK\b|KENNEDY (INT|AIRPORT)|\b11430\b/.test(A)) ap = null;
    if (ap === 'EWR' && !/\bEWR\b|NEWARK (LIBERTY|AIRPORT|INT)|\b07114\b/.test(A)) ap = null;
    if (!ap) { if (/\bLGA\b|LAGUARDIA|LA GUARDIA/.test(A)) ap = 'LGA'; else if (/\bJFK\b|KENNEDY AIRPORT/.test(A)) ap = 'JFK'; else if (/\bEWR\b|NEWARK (LIBERTY|AIRPORT)/.test(A)) ap = 'EWR'; }
    if (ap === 'LGA' || ap === 'JFK' || ap === 'EWR') return mk(ap, 'airport');
    /* Broad Channel sits between the free North Channel bridge and the tolled Cross Bay bridge: Queens side, no toll */
    if (/\bBROAD CHANNEL\b/.test(A)) return mk('QNS', 'keyword');
    if (RE.rk.test(A)) return mk('RK', 'keyword');
    if (RE.si.test(A)) return mk('SI', 'keyword');
    if (RE.bx.test(A)) return mk('BX', 'keyword');
    if (RE.nj.test(A)) return mk('NJ', 'keyword');
    if (RE.bk.test(A)) return mk('BK', 'keyword');
    if (RE.wes.test(A)) return mk('WES', 'keyword');
    var z = zipArea(zipOf(A));
    /* a non-Manhattan zip wins over the generic "New York, NY" / "NYC" that Google and Nominatim put on every
       city address; so does a Queens / Long Island neighbourhood when the only Manhattan hint is that generic text */
    if (z && z !== 'MAN') return mk(z, 'zip');
    if (RE.man.test(A) && !RE.man.test(A.replace(GENERIC_NY, ' '))) {
      if (RE.qns.test(A)) return mk('QNS', 'keyword');
      if (RE.nas.test(A)) return mk('NAS', 'keyword');
    }
    if (RE.man.test(A) || z === 'MAN') { var b = manBand(A); return mk(b.a, b.how, b.street ? { street: b.street } : (b.note ? { note: b.note } : null)); }
    if (RE.nas.test(A)) return mk('NAS', 'keyword');
    if (RE.qns.test(A)) return mk('QNS', 'keyword');
    /* the console's own recognition: zone hints (suggestZone, rate version 2 aware via quote.js) and the borough test */
    var zn = callG('suggestZone', A);
    if (zn != null) {
      zn = Number(zn);
      if (zn === 12) return mk('LGA', 'zone'); if (zn === 13) return mk('JFK', 'zone'); if (zn === 14) return mk('EWR', 'zone');
      if (zn === 15) { var b2 = manBand(A); return mk(b2.a, 'zone', b2.note ? { note: b2.note } : null); }
      if (zn === 16) return mk('NAS', 'zone');
      if (zn >= 1 && zn <= 11) return mk('QNS', 'zone');
    }
    return mk('UNK', 'unknown');
  }
  function groupOf(a) {
    if (a === 'QNS' || a === 'JFK' || a === 'LGA' || a === 'NAS' || a === 'UNK') return 'Q';
    if (a === 'MAN_LO' || a === 'MAN_MID' || a === 'MAN_HI') return 'M';
    if (a === 'EWR' || a === 'NJ') return 'NJ';
    return a;   // BK BX SI WES RK
  }

  /* ---------- table source: usual crossings per pair, car based in Queens ---------- */
  /* returns {keys:[crossing keys], free:[labels], through:{b96,b60}, note} */
  function legTable(a, b, st) {
    var ga = groupOf(a.area), gb = groupOf(b.area), out = { keys: [], free: [], through: { b96: false, b60: false }, note: '' };
    if (ga === 'RK' || gb === 'RK') {
      var other = ga === 'RK' ? b : a, go = groupOf(other.area);
      if (go === 'RK') return out;
      if (go === 'BK') { out.keys.push('marine-parkway'); return out; }
      if (go === 'SI') { out.keys.push('marine-parkway', 'verrazzano-narrows'); return out; }
      out.keys.push('cross-bay');
      var rest = legTable(mk('QNS', 'via'), other, st);
      out.keys = out.keys.concat(rest.keys); out.free = rest.free; out.through = rest.through; out.note = rest.note;
      return out;
    }
    if (ga === gb) return out;
    var pair = [ga, gb].sort().join('-'), man = ga === 'M' ? a : (gb === 'M' ? b : null);
    var lincoln = st.njRoute !== 'gwb';
    switch (pair) {
      case 'M-Q':
        if (st.preferTunnel && man.area === 'MAN_LO') out.keys.push('queens-midtown-tunnel');
        else out.free.push(FREE.queensboro.label);
        break;
      case 'BX-Q': out.keys.push('bronx-whitestone'); break;
      case 'Q-SI': out.keys.push('verrazzano-narrows'); break;
      case 'NJ-Q':
        if (lincoln) { out.keys.push('queens-midtown-tunnel', 'lincoln-tunnel'); out.through = { b96: true, b60: true }; out.note = 'Route via the Queens-Midtown Tunnel and Lincoln Tunnel passes through Midtown.'; }
        else out.keys.push('bronx-whitestone', 'george-washington');
        break;
      case 'Q-WES': out.keys.push('throgs-neck'); break;
      case 'BK-Q': break;
      case 'BK-M': out.free.push('East River bridges (free)'); break;
      case 'BK-BX': out.keys.push('rfk-triborough'); break;
      case 'BK-SI': out.keys.push('verrazzano-narrows'); break;
      case 'BK-NJ': out.keys.push('holland-tunnel'); out.through = { b96: true, b60: true }; out.note = 'Route via the Holland Tunnel passes through Lower Manhattan.'; break;
      case 'BK-WES': out.keys.push('rfk-triborough'); break;
      case 'BX-M': case 'M-WES':
        if (st.manBronx === 'henryHudson') out.keys.push('henry-hudson'); else out.free.push('Harlem River bridges (free)');
        break;
      case 'M-SI': out.keys.push('verrazzano-narrows'); out.free.push('East River bridges (free)'); break;
      case 'M-NJ': out.keys.push((lincoln && man.area !== 'MAN_HI') ? 'lincoln-tunnel' : 'george-washington'); break;
      case 'BX-SI': out.keys.push('bronx-whitestone', 'verrazzano-narrows'); break;
      case 'BX-NJ': out.keys.push('george-washington'); break;
      case 'BX-WES': break;
      case 'NJ-SI': out.note = 'Staten Island ↔ New Jersey uses a Port Authority bridge that is not in the rate table — add it by hand.'; break;
      case 'SI-WES': out.keys.push('verrazzano-narrows', 'rfk-triborough'); break;
      case 'NJ-WES': out.keys.push('george-washington'); break;
      default: break;
    }
    return out;
  }

  /* ---------- route source: geometry ---------- */
  function geoPoints(geo) {
    var pts = [];
    try {
      if (!geo) return pts;
      if (typeof geo === 'object' && !Array.isArray(geo)) {
        if (geo.type === 'Feature') return geoPoints(geo.geometry);
        if (geo.type === 'FeatureCollection') { (geo.features || []).forEach(function (f) { pts = pts.concat(geoPoints(f)); }); return pts; }
        if (geo.type === 'MultiLineString') { (geo.coordinates || []).forEach(function (l) { pts = pts.concat(geoPoints({ type: 'LineString', coordinates: l })); }); return pts; }
        if (geo.coordinates) return geoPoints(geo.coordinates);
        if (geo.geo) return geoPoints(geo.geo);
        return pts;
      }
      geo.forEach(function (p) {
        if (Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1])) pts.push({ lat: Number(p[1]), lng: Number(p[0]) });
        else if (p && typeof p === 'object') {
          var la = typeof p.lat === 'function' ? p.lat() : p.lat, ln = typeof p.lng === 'function' ? p.lng() : p.lng;
          if (isFinite(la) && isFinite(ln)) pts.push({ lat: Number(la), lng: Number(ln) });
        }
      });
    } catch (e) {}
    return pts;
  }
  function kmXY(p, ref) { var k = 111.32; return { x: (p.lng - ref.lng) * k * Math.cos(ref.lat * Math.PI / 180), y: (p.lat - ref.lat) * k }; }
  function distSegKm(c, a, b) {
    var A = kmXY(a, c), B = kmXY(b, c), dx = B.x - A.x, dy = B.y - A.y, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / L)) : 0;
    var x = A.x + t * dx, y = A.y + t * dy; return Math.sqrt(x * x + y * y);
  }
  function nearRoute(pts, c) {
    if (!pts.length) return false;
    if (pts.length === 1) return distSegKm(c, pts[0], pts[0]) <= NEAR_KM;
    for (var i = 0; i < pts.length - 1; i++) if (distSegKm(c, pts[i], pts[i + 1]) <= NEAR_KM) return true;
    return false;
  }
  function inPoly(p, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      if (((yi > p.lat) !== (yj > p.lat)) && (p.lng < (xj - xi) * (p.lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }
  function routeScan(geo) {
    var pts = geoPoints(geo); if (pts.length < 2) return null;
    var keys = [], free = [];
    Object.keys(CROSSINGS).forEach(function (k) { if (nearRoute(pts, CROSSINGS[k])) keys.push(k); });
    Object.keys(FREE).forEach(function (k) { if (nearRoute(pts, FREE[k])) free.push(FREE[k].label); });
    var b96 = false, b60 = false;
    for (var i = 0; i < pts.length; i++) { if (!b96 && inPoly(pts[i], POLY_96)) b96 = true; if (!b60 && inPoly(pts[i], POLY_60)) b60 = true; if (b96 && b60) break; }
    return { keys: keys, free: free, through: { b96: b96, b60: b60 } };
  }

  /* ---------- quote components already carrying a charge (no double counting) ---------- */
  function quoteComps(q) { return (q && Array.isArray(q.components)) ? q.components : []; }
  function quoteHas(q, key) { return quoteComps(q).some(function (c) { return c && c.key === key && !c.passThrough && Number(c.amount) > 0; }); }

  /* ---------- fees ---------- */
  function endsOf(t) {
    var stops = Array.isArray(t.stops) ? t.stops.map(addrOf).filter(function (x) { return String(x).trim(); }) : [];
    return { pu: String(t.puAddr || t.pu || ''), doo: String(t.doAddr || t.do || t.doo || ''), stops: stops };
  }
  /* feesFor(trip-like, opts) → {fees:[{key,label,amount}], feesTotal, notes[]}. opts.areas / opts.through come from tollsFor. */
  function feesFor(t, opts) {
    t = t || {}; opts = opts || {};
    var st = TS(), e = endsOf(t), notes = [];
    var areas = opts.areas || [areaOf(e.pu)].concat(e.stops.map(areaOf)).concat([areaOf(e.doo)]);
    var through = opts.through || { b96: false, b60: false };
    var q = opts.quote !== undefined ? opts.quote : t.quote;
    var fees = [];
    var touch96 = areas.some(function (a) { return a.area === 'MAN_LO' || a.area === 'MAN_MID'; }) || !!through.b96;
    var touch60 = areas.some(function (a) { return a.area === 'MAN_LO'; }) || !!through.b60;
    var gov = quoteHas(q, 'govManhattan');
    var endsInMan = areas.some(function (a) { return a.area === 'MAN_LO' || a.area === 'MAN_MID'; });
    if (touch96 && !endsInMan && !gov && (st.chargeCongestion || (touch60 && st.chargeCrz))) {
      var toNJ = areas.some(function (a) { return a.area === 'NJ' || a.area === 'EWR'; });
      notes.push('The route passes through Midtown Manhattan, so the Manhattan fees apply.' + (toNJ && st.njRoute !== 'gwb' ? ' The George Washington Bridge route (Settings → Tolls & fees) avoids them.' : ''));
    }
    if (touch96 && st.chargeCongestion) {
      if (gov) notes.push('NYS congestion surcharge is already in the rate-book price.');
      else fees.push({ key: 'congestion', label: 'NYS congestion surcharge (Manhattan below 96th St)', amount: congestionFee() });
    }
    if (touch60 && st.chargeCrz) {
      if (gov) notes.push('MTA congestion zone charge is already in the rate-book price.');
      else fees.push({ key: 'crz', label: 'MTA Congestion Relief Zone charge (60th St and below)', amount: crzFee() });
    }
    if (st.chargePaFee) {
      var paInQuote = quoteHas(q, 'paFee');
      [['pu', areas[0]], ['do', areas[areas.length - 1]]].forEach(function (x) {
        var a = x[1]; if (!a || (a.area !== 'JFK' && a.area !== 'LGA' && a.area !== 'EWR')) return;
        if (paInQuote) { notes.push('Airport access fee is already in the rate-book price.'); paInQuote = false; return; }
        fees.push({ key: 'paFee', label: 'Airport access fee (' + a.area + ' ' + (x[0] === 'pu' ? 'pick-up' : 'drop-off') + ')', amount: paFee() });
      });
    }
    var tot = 0; fees.forEach(function (f) { tot += num(f.amount); });
    return { fees: fees, feesTotal: round2(tot), notes: notes };
  }

  /* ---------- tollsFor ---------- */
  function tollLine(key, rt, source) {
    var c = CROSSINGS[key] || { label: key, short: key }, amt = rateFor(key);
    return { key: key, label: c.label + (rt ? ' ×2 (round trip)' : ''), short: c.short, amount: round2(rt ? amt * 2 : amt), source: source };
  }
  function tollsFor(t, opts) {
    t = t || {}; opts = opts || {};
    var st = TS(), e = endsOf(t), res = { tolls: [], free: [], fees: [], tollsTotal: 0, feesTotal: 0, total: 0, confidence: 'none', notes: [], areas: [], rateType: st.rateType };
    if (!String(e.pu).trim() || !String(e.doo).trim()) { res.notes.push('Pick-up and drop-off needed.'); return res; }
    var seq = [e.pu].concat(e.stops).concat([e.doo]), areas = seq.map(areaOf);
    res.areas = areas.map(function (a) { return { area: a.area, label: a.label, how: a.how }; });
    areas.forEach(function (a, i) { if (a.note) res.notes.push(String(seq[i]).slice(0, 40) + ': ' + a.note + '.'); if (a.area === 'UNK') res.notes.push('Area not recognised for "' + String(seq[i]).slice(0, 40) + '" — treated as Queens (no toll).'); });
    var rt = !!(t.rt && Number(t.rt) !== 0);
    var geo = opts.routeGeo || t.routeGeo || null;
    var scan = geo ? routeScan(geo) : null, keys = [], through = { b96: false, b60: false };
    if (scan) {
      res.confidence = 'route'; keys = scan.keys; res.free = scan.free; through = scan.through;
    } else {
      res.confidence = 'table';
      for (var i = 0; i < areas.length - 1; i++) {
        var leg = legTable(areas[i], areas[i + 1], st);
        keys = keys.concat(leg.keys);
        leg.free.forEach(function (f) { if (res.free.indexOf(f) < 0) res.free.push(f); });
        if (leg.through.b96) through.b96 = true; if (leg.through.b60) through.b60 = true;
        if (leg.note && res.notes.indexOf(leg.note) < 0) res.notes.push(leg.note);
      }
    }
    var src = res.confidence;
    keys.forEach(function (k) { res.tolls.push(tollLine(k, rt, src)); });
    var vt = String(t.vtype || '');
    if (res.tolls.length && /SPRINTER|BUS|MINI-BUS/i.test(vt)) res.notes.push(vt + ' may pay a higher toll class than a car — check the amount.');
    var q = opts.quote !== undefined ? opts.quote : t.quote;
    var f = feesFor(t, { areas: areas, through: through, quote: q });
    res.fees = f.fees; res.notes = res.notes.concat(f.notes);
    var tt = 0; res.tolls.forEach(function (x) { tt += num(x.amount); });
    res.tollsTotal = round2(tt); res.feesTotal = f.feesTotal; res.total = round2(tt + f.feesTotal);
    res.through = through;
    return res;
  }
  function allIn(t) { t = findTrip(t); if (!t) return 0; return round2(num(t.fare) + num(t.tolls) + num(t.feesTotal)); }

  /* ======================================================================
     Book form
     ====================================================================== */
  var FORM = { res: null, fees: [], feesTotal: 0, handKey: null, kept: null, geo: null, timer: 0, mode: 'none' };
  function stopsNow() { try { if (typeof dispatchStops !== 'undefined' && Array.isArray(dispatchStops)) return dispatchStops.map(addrOf).filter(function (x) { return String(x).trim(); }); } catch (e) {} return []; }
  function formTrip() {
    return {
      puAddr: String((byId('d_puAddr') || {}).value || '').trim(), doAddr: String((byId('d_doAddr') || {}).value || '').trim(),
      stops: stopsNow().map(function (a) { return { addr: String(a).trim() }; }), vtype: String((byId('d_vtype') || {}).value || ''),
      rt: !!(byId('d_rt') && byId('d_rt').checked) ? 1 : 0
    };
  }
  function keyOf(t) { return [up(t.puAddr).trim(), (t.stops || []).map(function (s) { return up(addrOf(s)).trim(); }).join('|'), up(t.doAddr).trim(), t.rt ? 'rt' : ''].join('#'); }
  function routeKeyOf(t) { return [up(t.puAddr).trim(), (t.stops || []).map(function (s) { return up(addrOf(s)).trim(); }).join('|'), up(t.doAddr).trim()].join('#'); }
  function pendingQuote() { try { if (window.Quote && typeof window.Quote.pending === 'function') return window.Quote.pending() || null; } catch (e) {} return null; }
  function anythingOn() { var st = TS(); return !!(st.includeInQuote || st.chargeCongestion || st.chargeCrz || st.chargePaFee); }
  function mapsGeo(f) {
    try { var M = window.Maps; if (M && typeof M.routeGeo === 'function') { var g0 = M.routeGeo(f); if (g0) return g0; } } catch (e) {}
    return null;
  }
  function refreshForm() {
    if (POPOUT) return null;
    var te = byId('d_tolls'); if (!te) return null;
    var f = formTrip(), key = keyOf(f), st = TS();
    if (FORM.kept && FORM.kept.key !== key) FORM.kept = null;
    if (FORM.handKey && FORM.handKey !== key) FORM.handKey = null;
    if (!f.puAddr || !f.doAddr) {
      FORM.res = null; FORM.fees = []; FORM.feesTotal = 0; FORM.mode = 'none';
      if (te.dataset.auto === '1') { te.value = '0.00'; te.dataset.auto = ''; }
      renderChip(); patchReadout(); return null;
    }
    var geo = (FORM.geo && FORM.geo.key === routeKeyOf(f)) ? FORM.geo.geo : mapsGeo(f);
    var res = tollsFor(f, { routeGeo: geo, quote: pendingQuote() });
    FORM.res = res;
    if (FORM.kept) {
      FORM.mode = 'saved'; FORM.fees = copy(FORM.kept.fees || []);
    } else if (FORM.handKey) {
      FORM.mode = 'hand'; te.dataset.auto = ''; FORM.fees = res.fees;
    } else if (st.includeInQuote) {
      FORM.mode = 'auto'; te.value = res.tollsTotal.toFixed(2); te.dataset.auto = '1'; FORM.fees = res.fees;
    } else {
      FORM.mode = 'off'; if (te.dataset.auto === '1') { te.value = '0.00'; te.dataset.auto = ''; } FORM.fees = res.fees;
    }
    var ft = 0; FORM.fees.forEach(function (x) { ft += num(x.amount); }); FORM.feesTotal = round2(ft);
    renderChip(); patchReadout();
    return res;
  }
  function scheduleRefresh(ms) { if (POPOUT) return; clearTimeout(FORM.timer); FORM.timer = setTimeout(act(refreshForm), ms == null ? 200 : ms); }

  /* chip + popover next to the Tolls box */
  function chipText() {
    var r = FORM.res; if (!r) return '';
    var nf = FORM.fees.length, fees = nf ? ' + ' + nf + ' fee' + (nf > 1 ? 's' : '') : '';
    /* Manhattan fees on a trip that neither starts nor ends there: say why on the chip itself */
    var viaMid = FORM.fees.some(function (x) { return x && (x.key === 'congestion' || x.key === 'crz'); })
      && !(r.areas || []).some(function (a) { return a && (a.area === 'MAN_LO' || a.area === 'MAN_MID'); });
    if (viaMid) fees += ' (via Midtown)';
    var te = byId('d_tolls');
    if (FORM.mode === 'saved') return 'saved · ' + money(te ? te.value : 0) + fees;
    if (FORM.mode === 'hand') return 'typed · auto was ' + money(r.tollsTotal) + fees;
    if (FORM.mode === 'off') return (nf ? 'tolls off' + fees : '');
    var paid = r.tolls.map(function (x) { return (x.short || x.label) + ' ' + money(x.amount); }).join(' + ');
    return 'auto · ' + (paid || 'no tolls') + fees;
  }
  function popHtml() {
    var r = FORM.res; if (!r) return '';
    var h = '<div class="tl-pop-h">Tolls &amp; fees <span class="tl-src">' + (r.confidence === 'route' ? 'from the road route' : 'usual crossing for this trip') + ' · ' + (r.rateType === 'tollsByMail' ? 'Tolls by Mail' : 'E-ZPass') + '</span></div><table class="tl-pop-t">';
    if (FORM.mode === 'saved' && FORM.kept && Array.isArray(FORM.kept.tollDetail)) FORM.kept.tollDetail.forEach(function (x) { h += '<tr><td>' + esc(x.label) + '</td><td class="num">' + money(x.amount) + '</td></tr>'; });
    else r.tolls.forEach(function (x) { h += '<tr><td>' + esc(x.label) + '</td><td class="num">' + money(x.amount) + '</td></tr>'; });
    if (!r.tolls.length && FORM.mode !== 'saved') h += '<tr><td>No toll crossing</td><td class="num">$0.00</td></tr>';
    r.free.forEach(function (x) { h += '<tr class="tl-free"><td>' + esc(x) + '</td><td class="num">$0.00</td></tr>'; });
    FORM.fees.forEach(function (x) { h += '<tr class="tl-fee"><td>' + esc(x.label) + '</td><td class="num">' + money(x.amount) + '</td></tr>'; });
    h += '</table>';
    if (FORM.mode === 'hand') h += '<div class="tl-pop-n">You typed the tolls. Clear the box to go back to auto.</div>';
    if (FORM.mode === 'saved') h += '<div class="tl-pop-n">Kept from the saved trip. Change an address to recount.</div>';
    r.notes.forEach(function (n) { h += '<div class="tl-pop-n">' + esc(n) + '</div>'; });
    return h;
  }
  function chipEl() {
    var te = byId('d_tolls'); if (!te) return null;
    var c = byId('tl_chip');
    if (!c) {
      c = document.createElement('button'); c.type = 'button'; c.id = 'tl_chip'; c.className = 'tl-chip'; c.setAttribute('aria-haspopup', 'true'); c.setAttribute('aria-expanded', 'false');
      c.title = 'Tolls and fees on this trip — click for the lines';
      var host = te.parentNode; host.appendChild(c);
      c.addEventListener('click', act(function (ev) { ev.preventDefault(); ev.stopPropagation(); togglePop(); }));
      c.addEventListener('keydown', act(function (ev) { if (ev.key === 'Escape') closePop(true); }));
    }
    return c;
  }
  function popEl() {
    var p = byId('tl_pop');
    if (!p) {
      var c = chipEl(); if (!c) return null;
      p = document.createElement('div'); p.id = 'tl_pop'; p.className = 'tl-pop'; p.hidden = true; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Tolls and fees'); p.tabIndex = -1;
      document.body.appendChild(p);
      p.addEventListener('keydown', act(function (ev) { if (ev.key === 'Escape') { ev.stopPropagation(); closePop(true); } }));
      window.addEventListener('scroll', act(function (ev) { var pp = byId('tl_pop'); if (pp && !pp.hidden && !(ev.target && ev.target.nodeType === 1 && pp.contains(ev.target))) closePop(false); }), true);
      document.addEventListener('click', act(function (ev) { var pp = byId('tl_pop'); if (pp && !pp.hidden && !pp.contains(ev.target) && ev.target !== byId('tl_chip')) closePop(false); }));
    }
    return p;
  }
  function placePop(p, c) {
    try {
      var r = c.getBoundingClientRect(), w = Math.min(340, Math.max(260, window.innerWidth - 32));
      var left = Math.max(16, Math.min(r.left, window.innerWidth - w - 16));
      p.style.left = left + 'px'; p.style.top = Math.round(r.bottom + 4) + 'px'; p.style.width = w + 'px';
    } catch (e) {}
  }
  function togglePop() { var p = popEl(), c = byId('tl_chip'); if (!p || !c) return; if (p.hidden) { p.innerHTML = popHtml(); p.hidden = false; placePop(p, c); c.setAttribute('aria-expanded', 'true'); } else closePop(false); }
  function closePop(focusChip) { var p = byId('tl_pop'); if (p) p.hidden = true; var c = byId('tl_chip'); if (c) { c.setAttribute('aria-expanded', 'false'); if (focusChip) try { c.focus(); } catch (e) {} } }
  function renderChip() {
    var c = chipEl(); if (!c) return;
    var txt = chipText();
    c.textContent = txt; c.hidden = !txt;
    c.className = 'tl-chip' + (FORM.mode === 'hand' ? ' tl-hand' : '') + (FORM.res && FORM.res.confidence === 'route' ? ' tl-route' : '');
    var p = byId('tl_pop'); if (p && !p.hidden) p.innerHTML = popHtml();
    if (!txt) closePop(false);
  }
  /* readout: Fees row + r_total = fare + tolls + fees + card fee */
  function feesRow() {
    var tr = byId('r_tolls'); if (!tr || !tr.parentNode) return null;
    var row = byId('r_feesrow');
    if (!row) {
      row = document.createElement('div'); row.id = 'r_feesrow'; row.style.display = 'none';
      row.innerHTML = '<span>Fees</span><span class="mono" id="r_fees">$0.00</span>';
      tr.parentNode.parentNode.insertBefore(row, tr.parentNode.nextSibling);
    }
    return row;
  }
  function patchReadout() {
    if (POPOUT) return;
    var row = feesRow(); var tot = byId('r_total'); if (!tot) return;
    var fees = FORM.res ? FORM.feesTotal : 0;
    if (row) { row.style.display = fees > 0 ? '' : 'none'; var rf = byId('r_fees'); if (rf) { rf.textContent = money(fees); rf.title = FORM.fees.map(function (x) { return x.label + ' ' + money(x.amount); }).join('\n'); } }
    /* no addresses yet: the console's own readout stands. Otherwise r_tolls and r_total are written here too,
       because refreshForm sets d_tolls without an input event, after the console's updateReadout already ran. */
    if (!FORM.res) return;
    var fare = num((byId('d_fare') || {}).value), tolls = num((byId('d_tolls') || {}).value);
    var card = byId('d_account') && byId('d_account').value === 'card', cf = 0;
    if (card) { var c0 = callG('cardFeeAmt', fare); cf = num(c0); }
    var rt = byId('r_tolls'); if (rt) rt.textContent = money(tolls);
    tot.textContent = money(round2(fare + tolls + fees + cf));
  }

  /* ---------- save ---------- */
  var saveCtx = null;
  function dSaveBefore() {
    saveCtx = null;
    var te = byId('d_tolls'); if (!te) return;
    var f = formTrip(); if (!f.puAddr || !f.doAddr) return;
    var res = refreshForm();
    var eid = null; try { eid = (typeof editingId !== 'undefined' && editingId) ? editingId : null; } catch (e) { eid = null; }
    var write = anythingOn() || !!FORM.kept;
    var detail;
    if (FORM.mode === 'saved' && FORM.kept) detail = copy(FORM.kept.tollDetail || []);
    else if (FORM.mode === 'auto' && res) detail = res.tolls.map(function (x) { return { key: x.key, label: x.label, amount: x.amount, source: x.source }; });
    else { var v = num(te.value); detail = v > 0 ? [{ key: 'manual', label: 'Tolls (typed)', amount: round2(v), source: 'manual' }] : []; }
    saveCtx = { editId: eid, seq: Number(STATE.dispatchSeq), write: write, detail: detail, fees: copy(FORM.fees || []), kept: !!FORM.kept, mode: FORM.mode };
  }
  function dSaveAfter() {
    var ctx = saveCtx; saveCtx = null; if (!ctx || !ctx.write) return;
    var t = null;
    if (ctx.editId) t = findTrip(ctx.editId);
    else { if (Number(STATE.dispatchSeq) !== ctx.seq + 1) return; t = trips().filter(function (x) { return x && Number(x.dispatchNo) === ctx.seq; })[0]; }
    if (!t) return;
    applyToTrip(t, ctx.detail, ctx.fees, ctx.kept);
    save();
    try { if (typeof window.refreshBoard === 'function' && byId('activeBoard')) window.refreshBoard(); } catch (e) {}
  }
  function applyToTrip(t, detail, fees, kept) {
    t.tollDetail = Array.isArray(detail) ? detail : [];
    t.fees = Array.isArray(fees) ? fees.map(function (x) { return { key: x.key, label: x.label, amount: round2(x.amount) }; }) : [];
    var ft = 0; t.fees.forEach(function (x) { ft += num(x.amount); }); t.feesTotal = round2(ft);
    if (!(kept && t.tollsQuoted != null)) t.tollsQuoted = round2(t.tolls);
    attachToQuote(t);
  }
  function attachToQuote(t) {
    var q = t && t.quote; if (!q || typeof q !== 'object' || !Array.isArray(q.components)) return;
    q.components = q.components.filter(function (c) { return !(c && c.passThrough); });
    var pt = 0;
    if (num(t.tolls) > 0) { q.components.push({ key: 'tolls', label: 'Tolls' + ((t.tollDetail || []).length ? ': ' + t.tollDetail.map(function (x) { return x.label; }).join(', ') : ''), amount: round2(t.tolls), passThrough: true }); pt += num(t.tolls); }
    (t.fees || []).forEach(function (x) { q.components.push({ key: 'fee:' + x.key, label: x.label, amount: round2(x.amount), passThrough: true }); pt += num(x.amount); });
    q.passThroughTotal = round2(pt);
  }

  /* ---------- edit overlay: recount when an address changes ---------- */
  /* "Tolls ($)" box in the edit overlay: what the driver paid. Changing it keeps the quote on file
     (t.tollsQuoted) so the Board row shows "tolls +$2.80 vs quote". */
  function addOverlayTollsField() {
    var t = null; try { t = (typeof editOvlId !== 'undefined' && editOvlId) ? findTrip(editOvlId) : null; } catch (e) { t = null; }
    var tip = byId('eo_tip'); if (!t || !tip || byId('eo_tl')) return;
    var host = tip.closest ? tip.closest('label') : null; if (!host || !host.parentNode) return;
    var lab = document.createElement('label'); lab.className = 'fld'; lab.style.flex = '0 0 110px';
    var q = t.tollsQuoted != null && Math.abs(num(t.tollsQuoted) - num(t.tolls)) >= 0.01 ? ' (quoted ' + money(t.tollsQuoted) + ')' : '';
    lab.innerHTML = '<span class="lbl">Tolls paid ($)</span><input type="number" step="0.01" min="0" id="eo_tl" class="num" value="' + num(t.tolls).toFixed(2) + '" title="What the driver paid in tolls' + esc(q) + '. The quoted tolls stay on file.">';
    host.parentNode.insertBefore(lab, host.nextSibling);
    var inp = byId('eo_tl'); inp.dataset.was = num(t.tolls).toFixed(2);
    inp.addEventListener('keydown', act(function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); if (typeof window.saveEditOvl === 'function') window.saveEditOvl(); } else if (ev.key === 'Escape') { ev.preventDefault(); if (typeof window.closeEditOvl === 'function') window.closeEditOvl(); } }));
  }
  function wrapEditOverlay() {
    hookAfter('openEditOverlay', function () { addOverlayTollsField(); });
    hook('saveEditOvl', function (orig) {
      return function () {
        var t = null; try { t = (typeof editOvlId !== 'undefined' && editOvlId) ? findTrip(editOvlId) : null; } catch (e) { t = null; }
        var before = t ? routeKeyOf(t) : null;
        var paid = null; try { var pe = byId('eo_tl'); if (pe && String(pe.value).trim() !== '' && String(pe.value).trim() !== pe.dataset.was) { var pv = Number(pe.value); if (isFinite(pv) && pv >= 0) paid = round2(pv); } } catch (e) { paid = null; }
        var out = orig.apply(this, arguments);
        try {
          if (t && trips().indexOf(t) >= 0 && routeKeyOf(t) !== before && anythingOn()) {
            /* the saved road line belongs to the old addresses: count the new ones from the crossing table */
            var res = tollsFor(Object.assign({}, t, { routeGeo: null }), { quote: t.quote, routeGeo: null }), st = TS();
            var autoBefore = !Array.isArray(t.tollDetail) ? !(num(t.tolls) > 0) : t.tollDetail.every(function (x) { return x && x.source !== 'manual'; });
            var detail = t.tollDetail;
            if (autoBefore && st.includeInQuote) { t.tolls = res.tollsTotal; detail = res.tolls.map(function (x) { return { key: x.key, label: x.label, amount: x.amount, source: x.source }; }); }
            applyToTrip(t, detail || [], res.fees, false);
            save();
            try { if (typeof window.refreshBoard === 'function') window.refreshBoard(); } catch (e) {}
          } else if (t && trips().indexOf(t) >= 0 && t.quote && Array.isArray(t.quote.components) && (num(t.tolls) > 0 || (Array.isArray(t.fees) && t.fees.length))
                     && !t.quote.components.some(function (c) { return c && c.passThrough; })) {
            /* same route, new quote (a fare-only edit re-quotes): put the tolls and fee lines back on it */
            attachToQuote(t); save();
          }
        } catch (e) {}
        try {
          var closed = true; try { closed = !(typeof editOvlId !== 'undefined' && editOvlId); } catch (e) { closed = true; }
          if (paid != null && closed && t && trips().indexOf(t) >= 0 && Math.abs(paid - num(t.tolls)) >= 0.005) reportTolls(t.id, paid, 'typed');
        } catch (e) {}
        return out;
      };
    });
  }

  /* ---------- driver-reported tolls ---------- */
  function reportTolls(id, amount, source) {
    var t = findTrip(id); if (!t) return null;
    var v = Number(amount); if (!isFinite(v) || v < 0) return null;
    if (t.tollsQuoted == null) t.tollsQuoted = round2(t.tolls);
    t.tolls = round2(v);
    attachToQuote(t);
    save();
    try { if (typeof window.refreshBoard === 'function') window.refreshBoard(); } catch (e) {}
    var d = round2(t.tolls - num(t.tollsQuoted));
    toast('Call #' + (t.dispatchNo || '') + ': tolls ' + money(t.tolls) + (source ? ' (' + source + ')' : '') + (Math.abs(d) >= 0.01 ? ' — ' + (d > 0 ? '+' : '−') + money(Math.abs(d)) + ' vs quote' : '') + '.');
    return t;
  }
  function parseDriverReport(text) {
    var s = String(text || ''), m = s.match(/\bD\s*#\s*(\d+)\b/i), tm = s.match(/\btolls?\s*[:=]?\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
    if (!m || !tm) return null;
    var no = Number(m[1]), t = trips().filter(function (x) { return x && Number(x.dispatchNo) === no; })[0];
    if (!t) { toast('No call #' + no + ' on file.', true); return null; }
    return reportTolls(t.id, Number(tm[1]), 'driver');
  }
  function tollDiff(t) { if (!t || t.tollsQuoted == null) return 0; return round2(num(t.tolls) - num(t.tollsQuoted)); }

  /* ---------- board row, receipt, invoice ---------- */
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function boardBits(t) {
    var parts = [], tl = num(t.tolls), ft = num(t.feesTotal);
    if (tl > 0) parts.push('+ tolls ' + money(tl));
    if (ft > 0) parts.push('fees ' + money(ft));
    var d = tollDiff(t), diff = Math.abs(d) >= 0.01 ? '<span class="tl-diff" title="Quoted tolls ' + esc(money(t.tollsQuoted)) + ', paid ' + esc(money(tl)) + '">tolls ' + (d > 0 ? '+' : '−') + esc(money(Math.abs(d))) + ' vs quote</span>' : '';
    if (!parts.length && !diff) return '';
    var title = (t.tollDetail || []).map(function (x) { return x.label + ' ' + money(x.amount); }).concat((t.fees || []).map(function (x) { return x.label + ' ' + money(x.amount); })).join('\n');
    return '<div class="hint tl-board" style="margin:0;font-size:10px;white-space:nowrap;" title="' + esc(title) + '">' + esc(parts.join(' · ')) + (diff ? (parts.length ? ' ' : '') + diff : '') + '</div>';
  }
  function wrapBoard() {
    hook('sheetRow', function (orig) {
      return function (t) {
        var html = orig.apply(this, arguments);
        try {
          if (t && typeof html === 'string') {
            var bits = boardBits(t);
            if (bits) {
              var re = new RegExp('(<td class="num"[^>]*>' + escRe(money(t.fare)) + ')');
              if (re.test(html)) html = html.replace(re, '$1' + bits);
            }
          }
        } catch (e) {}
        return html;
      };
    });
  }
  var FX_LABEL = { paFee: /Airport access fee/, congestion: /NYS congestion surcharge/, crz: /MTA Congestion Relief Zone/ };
  var ROW = function (l, v, b) { return '<tr><td style="padding:3px 8px;' + (b ? 'font-weight:700;' : '') + '">' + l + '</td><td style="padding:3px 8px;text-align:right;' + (b ? 'font-weight:700;' : '') + '">' + v + '</td></tr>'; };
  function receiptHtml(html, t) {
    if (typeof html !== 'string') return html;
    var detail = Array.isArray(t.tollDetail) ? t.tollDetail.filter(function (x) { return x && num(x.amount) > 0; }) : [];
    var fees = Array.isArray(t.fees) ? t.fees : [], ft = num(t.feesTotal), tl = num(t.tolls);
    if (!detail.length && !fees.length) return html;
    /* fixes.js "incl." lines for a charge now billed on top are removed */
    fees.forEach(function (f) { var re = FX_LABEL[f.key]; if (!re) return; html = html.replace(/<tr class="fx-pass">[\s\S]*?<\/tr>/g, function (m) { return re.test(m) ? '' : m; }); });
    /* tolls: every crossing on its own line (what the driver paid when it differs from the quote) */
    var tollRows = '';
    var dsum = 0; detail.forEach(function (x) { dsum += num(x.amount); });
    if (tl > 0) {
      if (detail.length && Math.abs(round2(dsum) - round2(tl)) < 0.01) tollRows = detail.map(function (x) { return ROW('Toll: ' + esc(x.label), '$' + num(x.amount).toFixed(2)); }).join('');
      else tollRows = ROW('Tolls' + (detail.length ? ' (paid; quoted ' + esc(money(dsum)) + ')' : ''), '$' + tl.toFixed(2));
    }
    var tollRe = /<tr><td style="padding:3px 8px;">Tolls<\/td><td style="padding:3px 8px;text-align:right;">\$[\d.]+<\/td><\/tr>/;
    if (tollRe.test(html)) html = html.replace(tollRe, tollRows);
    else if (tollRows) html = html.replace(/(<tr><td style="padding:3px 8px;">Fare<\/td>)/, tollRows + '$1');
    /* fees: one line each when the owner itemises pass-throughs, else one "Fees" line */
    var feeRows = '';
    if (fees.length) {
      if (S().itemizePassThroughs === true) feeRows = fees.map(function (x) { return ROW(esc(x.label), '$' + num(x.amount).toFixed(2)); }).join('');
      else feeRows = ROW('Fees', '$' + ft.toFixed(2));
    }
    var fare = Math.round(num(t.fare)), card = t.payType === 'Credit Card', cf = card ? num(callG('cardFeeAmt', fare)) : 0, tip = Math.round(num(t.tip));
    var total = round2(fare + tl + ft), grand = round2(total + cf + tip);
    /* every money line with cents once tolls / fees carry cents */
    html = html.replace(/(<tr><td style="padding:3px 8px;">Fare<\/td><td style="padding:3px 8px;text-align:right;">)\$[\d.]+(<\/td><\/tr>)/, function (m0, a, b) { return a + '$' + fare.toFixed(2) + b; });
    html = html.replace(/<tr><td style="padding:3px 8px;font-weight:700;">TOTAL<\/td><td style="padding:3px 8px;text-align:right;font-weight:700;">[^<]*<\/td><\/tr>/, feeRows + ROW('TOTAL', '$' + total.toFixed(2), 1));
    html = html.replace(/<tr><td style="padding:3px 8px;font-weight:700;">GRAND TOTAL<\/td><td style="padding:3px 8px;text-align:right;font-weight:700;">[^<]*<\/td><\/tr>/, ROW('GRAND TOTAL', '$' + grand.toFixed(2), 1));
    return html;
  }
  function wrapReceipt() {
    hook('printReceiptById', function (orig) {
      return function (id) {
        var t = findTrip(id), op = window.openPrint, self = this, args = arguments;
        if (!t || typeof op !== 'function' || (!(Array.isArray(t.tollDetail) && t.tollDetail.length) && !(Array.isArray(t.fees) && t.fees.length))) return orig.apply(self, args);
        var mine = function (html) { window.openPrint = op; var h = html; try { h = receiptHtml(html, t); } catch (e) { h = html; } return op.call(this, h); };
        window.openPrint = mine;
        try { return orig.apply(self, args); } finally { if (window.openPrint === mine) window.openPrint = op; }
      };
    });
  }
  function wrapInvoice() {
    hook('buildInvoiceHTML', function (orig) {
      return function (acct, list) {
        var args = Array.prototype.slice.call(arguments);
        var has = Array.isArray(list) && list.some(function (t) { return t && (num(t.feesTotal) > 0 || (Array.isArray(t.tollDetail) && t.tollDetail.length)); });
        if (!has) return orig.apply(this, args);
        /* fees are billed in the Tolls column (header "Tolls & fees"), each row lists its crossings and fees */
        var copies = list.map(function (t) { if (!t || !(num(t.feesTotal) > 0)) return t; var c = Object.assign({}, t); c.tolls = round2(num(t.tolls) + num(t.feesTotal)); return c; });
        args[1] = copies;
        var html = orig.apply(this, args);
        try {
          if (typeof html === 'string') {
            if (copies.some(function (c, i) { return c !== list[i]; })) html = html.replace('<th class="r">Tolls</th>', '<th class="r">Tolls &amp; fees</th>');
            var cur = html.indexOf('<tbody>'); if (cur < 0) cur = 0;
            copies.forEach(function (c, i) {
              var t = list[i]; if (!t) return;
              var lines = (Array.isArray(t.tollDetail) ? t.tollDetail.filter(function (x) { return num(x.amount) > 0; }) : []).map(function (x) { return x.label + ' ' + money(x.amount); }).concat((Array.isArray(t.fees) ? t.fees : []).map(function (x) { return x.label + ' ' + money(x.amount); }));
              var cell = '<td class="r">' + money(c.tolls) + '</td>', j = html.indexOf(cell, cur); if (j < 0) return;
              var rep = lines.length ? '<td class="r">' + money(c.tolls) + '<div class="hint" style="margin:0;font-size:10px;">' + lines.map(esc).join('<br>') + '</div></td>' : cell;
              html = html.slice(0, j) + rep + html.slice(j + cell.length); cur = j + rep.length;
            });
          }
        } catch (e) {}
        return html;
      };
    });
  }

  /* ---------- Settings panel ---------- */
  var PANEL_ID = 'tollsPanel', editing = false;
  function crossingRows() {
    var keys = Object.keys(CROSSINGS), st = TS();
    return keys.map(function (k) {
      var b = baseRate(k) || {}, o = st.rates[k] || null;
      var ez = rateFor(k, 'ezpass'), tm = rateFor(k, 'tollsByMail');
      if (editing) return '<tr data-k="' + esc(k) + '"><td>' + esc(CROSSINGS[k].label) + '</td><td class="num"><input type="number" step="0.01" min="0" class="tl-rate" data-t="ezpass" value="' + ez.toFixed(2) + '" aria-label="' + esc(CROSSINGS[k].label) + ' E-ZPass"></td><td class="num"><input type="number" step="0.01" min="0" class="tl-rate" data-t="tollsByMail" value="' + tm.toFixed(2) + '" aria-label="' + esc(CROSSINGS[k].label) + ' Tolls by Mail"></td><td></td></tr>';
      return '<tr><td>' + esc(CROSSINGS[k].label) + '</td><td class="num">' + money(ez) + '</td><td class="num">' + money(tm) + '</td><td class="tl-ov">' + (o ? 'edited (built-in ' + money(b.ezpass) + ' / ' + money(b.tollsByMail) + ')' : '') + '</td></tr>';
    }).join('');
  }
  function panelHtml() {
    var st = TS(), chk = function (id, k, label, hint) { return '<label class="fld tl-check"><input type="checkbox" id="' + id + '" data-k="' + k + '"' + (st[k] ? ' checked' : '') + '> <span class="lbl">' + label + '</span></label>' + (hint ? '<div class="tl-hint">' + hint + '</div>' : ''); };
    return '<div class="panel-head">Tolls &amp; fees</div><div class="panel-body">'
      + '<p class="hint" style="margin-top:0;">Each booking adds the tolls for the crossing it uses and the government fees, as their own lines. The dispatcher can always type over the tolls.</p>'
      + '<div class="tl-grid">'
      + '<label class="fld"><span class="lbl">Toll rate</span><select id="tl_rateType"><option value="ezpass"' + (st.rateType === 'ezpass' ? ' selected' : '') + '>E-ZPass</option><option value="tollsByMail"' + (st.rateType === 'tollsByMail' ? ' selected' : '') + '>Tolls by Mail</option></select></label>'
      + '<label class="fld"><span class="lbl">New Jersey / Newark route</span><select id="tl_njRoute"><option value="lincoln"' + (st.njRoute === 'lincoln' ? ' selected' : '') + '>Queens-Midtown Tunnel + Lincoln Tunnel</option><option value="gwb"' + (st.njRoute === 'gwb' ? ' selected' : '') + '>Whitestone + George Washington Bridge</option></select></label>'
      + '<label class="fld"><span class="lbl">Manhattan ↔ Bronx / Westchester</span><select id="tl_manBronx"><option value="free"' + (st.manBronx === 'free' ? ' selected' : '') + '>Free Harlem River bridges</option><option value="henryHudson"' + (st.manBronx === 'henryHudson' ? ' selected' : '') + '>Henry Hudson Bridge</option></select></label>'
      + '</div><div class="tl-grid">'
      + chk('tl_includeInQuote', 'includeInQuote', 'Put tolls in the quoted price', 'Fills the Tolls box on the Book form.')
      + chk('tl_preferTunnel', 'preferTunnel', 'Queens → Midtown by the tunnel', 'Off: the free Queensboro Bridge.')
      + chk('tl_chargeCongestion', 'chargeCongestion', 'Charge the NYS congestion surcharge', money(congestionFee()) + ' when a ride starts, ends or passes through Manhattan below 96th St.')
      + chk('tl_chargeCrz', 'chargeCrz', 'Charge the MTA congestion zone fee', money(crzFee()) + ' per ride that touches Manhattan at or below 60th St.')
      + chk('tl_chargePaFee', 'chargePaFee', 'Charge the airport access fee', money(paFee()) + ' per airport pick-up or drop-off (Port Authority).')
      + '</div>'
      + '<details class="tl-expl"><summary>Fees per crossing, in plain English</summary><ul>'
      + '<li>Queens to Manhattan is free over the Queensboro Bridge; the Queens-Midtown Tunnel costs a toll.</li>'
      + '<li>Queens to the Bronx: Whitestone or Throgs Neck Bridge. To Staten Island: Verrazzano Bridge. To the Rockaways: Cross Bay Bridge.</li>'
      + '<li>Newark and New Jersey: the tunnel or bridge back into New York, plus the Queens side.</li>'
      + '<li>Brooklyn and the East River bridges into Manhattan are free.</li>'
      + '<li>A round trip pays the tolls twice. Fees are once per ride.</li>'
      + '<li>The Manhattan fees and the airport fee are set by the state, the MTA and the Port Authority — they are passed on, not kept.</li></ul></details>'
      + '<div class="tbl-scroll" style="max-height:300px;"><table class="data tl-rates"><thead><tr><th>Crossing</th><th class="num">E-ZPass</th><th class="num">Tolls by Mail</th><th></th></tr></thead><tbody>' + crossingRows() + '</tbody></table></div>'
      + '<div class="btn-row" style="margin-top:6px;">' + (editing
        ? '<button type="button" class="btn btn-go btn-sm" id="tl_saveRates">Save rates</button><button type="button" class="btn btn-ghost btn-sm" id="tl_cancelRates">Cancel</button><button type="button" class="btn btn-ghost btn-sm" id="tl_resetRates">Back to built-in rates</button>'
        : '<button type="button" class="btn btn-ghost btn-sm" id="tl_editRates">Edit rates (owner)</button>') + '</div>'
      + '<div class="tl-grid" style="margin-top:8px;"><label class="fld"><span class="lbl">Driver says (paste the done text)</span><input type="text" id="tl_driverText" placeholder="D #1234 fare 58 tolls 9.80 wait 0"></label>'
      + '<div style="align-self:end;"><button type="button" class="btn btn-navy btn-sm" id="tl_driverApply">Use tolls from text</button></div></div>'
      + '<div class="hint" id="tl_status" aria-live="polite"></div></div>';
  }
  function ownerGate(what) {
    try {
      var Rc = window.Recover;
      if (Rc && Rc._loaded) {
        if (typeof Rc.ownerHere === 'function' && Rc.ownerHere()) return Promise.resolve(true);
        if (typeof Rc.ownerPinOK === 'function') return Promise.resolve(Rc.ownerPinOK(what)).then(function (v) { return !!v; }, function () { return false; });
      }
    } catch (e) {}
    var pin = String(S().adminPin || '').trim();
    if (!/^\d{4}$/.test(pin)) return Promise.resolve(true);
    var a = null; try { a = window.prompt('Owner PIN to ' + what + ':', ''); } catch (e) { a = null; }
    if (a === null) return Promise.resolve(false);
    if (String(a).trim() === pin) return Promise.resolve(true);
    toast('Wrong PIN.', true); return Promise.resolve(false);
  }
  function status(m) { var s = byId('tl_status'); if (s) s.textContent = m; }
  function renderPanel(focusId) {
    if (POPOUT) return;
    var view = byId('view-settings'); if (!view) return;
    var p = byId(PANEL_ID);
    if (!p) {
      p = document.createElement('div'); p.className = 'panel'; p.id = PANEL_ID;
      var body = byId('setupSecBody_prices');
      if (body) { p.setAttribute('data-setup-rank', '30'); body.appendChild(p); } else view.appendChild(p);
      bindPanel(p);
    }
    p.innerHTML = panelHtml();
    if (focusId) { var f = byId(focusId); if (f) try { f.focus(); } catch (e) {} }
  }
  /* setup.js files unknown panels under "Other": move this one to Prices (the same node, listeners kept) */
  function fileUnderPrices() {
    var p = byId(PANEL_ID), body = byId('setupSecBody_prices'); if (!p || !body) return;
    if (p.parentNode === body) return;
    var home = p.closest ? p.closest('.setup-sec-body') : null;
    if (!home || home.id === 'setupSecBody_other') {
      p.setAttribute('data-setup-rank', '30');
      var kids = body.children, before = null;
      for (var i = 0; i < kids.length; i++) { if ((Number(kids[i].getAttribute('data-setup-rank')) || 0) > 30) { before = kids[i]; break; } }
      body.insertBefore(p, before);
      var ob = byId('setupSecBody_other'), os = byId('setupSec_other');
      if (ob && os && !ob.children.length) { os.hidden = true; var oc = document.querySelector('.setup-chip[data-sec="other"]'); if (oc) oc.hidden = true; }
    }
  }
  function bindPanel(p) {
    if (p.__tlBound) return; p.__tlBound = true;
    p.addEventListener('change', act(function (ev) {
      var el = ev.target, st = TS(); if (!el || !el.id) return;
      if (el.classList.contains('tl-rate')) return;
      if (el.id === 'tl_rateType') st.rateType = el.value === 'tollsByMail' ? 'tollsByMail' : 'ezpass';
      else if (el.id === 'tl_njRoute') st.njRoute = el.value === 'gwb' ? 'gwb' : 'lincoln';
      else if (el.id === 'tl_manBronx') st.manBronx = el.value === 'henryHudson' ? 'henryHudson' : 'free';
      else if (el.type === 'checkbox' && el.dataset.k && DEFAULTS.hasOwnProperty(el.dataset.k)) st[el.dataset.k] = !!el.checked;
      else return;
      save(); refreshForm(); status('Saved.');
    }));
    p.addEventListener('click', act(function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('button') : null; if (!b) return;
      if (b.id === 'tl_editRates') ownerGate('edit toll rates').then(function (ok) { if (!ok) { status('Owner PIN needed to edit rates.'); return; } editing = true; renderPanel(); var first = p.querySelector('.tl-rate'); if (first) first.focus(); });
      else if (b.id === 'tl_cancelRates') { editing = false; renderPanel('tl_editRates'); }
      else if (b.id === 'tl_saveRates') saveRates();
      else if (b.id === 'tl_resetRates') { TS().rates = {}; save(); editing = false; renderPanel('tl_editRates'); refreshForm(); status('Built-in rates back in use.'); }
      else if (b.id === 'tl_driverApply') { var inp = byId('tl_driverText'); var t = parseDriverReport(inp ? inp.value : ''); status(t ? 'Call #' + t.dispatchNo + ' tolls now ' + money(t.tolls) + '.' : 'Could not read a call number and tolls in that text.'); if (t && inp) inp.value = ''; }
    }));
    p.addEventListener('keydown', act(function (ev) {
      var el = ev.target; if (!el) return;
      if (el.classList && el.classList.contains('tl-rate')) {
        if (ev.key === 'Enter') { ev.preventDefault(); saveRates(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); editing = false; renderPanel('tl_editRates'); }
      } else if (el.id === 'tl_driverText' && ev.key === 'Enter') { ev.preventDefault(); var bt = byId('tl_driverApply'); if (bt) bt.click(); }
    }));
  }
  function saveRates() {
    var p = byId(PANEL_ID); if (!p) return;
    var st = TS(), out = {}, bad = false;
    p.querySelectorAll('tr[data-k]').forEach(function (tr) {
      var k = tr.getAttribute('data-k'), b = baseRate(k) || {}, o = {};
      tr.querySelectorAll('.tl-rate').forEach(function (inp) { var v = Number(inp.value); if (!isFinite(v) || v < 0 || inp.value === '') { bad = true; return; } if (Math.abs(round2(v) - round2(b[inp.dataset.t])) >= 0.005) o[inp.dataset.t] = round2(v); });
      if (Object.keys(o).length) out[k] = o;
    });
    if (bad) { status('Rates must be numbers, zero or more.'); return; }
    st.rates = out; save(); editing = false; renderPanel('tl_editRates'); refreshForm();
    try { if (window.Recover && typeof window.Recover.log === 'function') window.Recover.log('tolls.rates', Object.keys(out).length + ' toll rate(s) edited'); } catch (e) {}
    status(Object.keys(out).length ? 'Saved — ' + Object.keys(out).length + ' crossing(s) use your rates.' : 'Saved — built-in rates.');
  }

  /* ---------- styles ---------- */
  function ensureStyle() {
    if (byId('tollsStyle')) return;
    var st = document.createElement('style'); st.id = 'tollsStyle';
    st.textContent = [
      '#d_tolls{margin-bottom:2px;}',
      '.tl-chip{display:inline-block;max-width:100%;margin-top:3px;padding:1px 7px;border:1px solid #c9d3e0;border-radius:10px;background:#eef3f9;color:#13315c;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;}',
      '.tl-chip.tl-hand{background:#fff6e0;border-color:#e2c27a;color:#6b4e00;} .tl-chip.tl-route{border-style:solid;border-color:#7aa6d6;}',
      '.tl-chip:focus{outline:2px solid #13315c;outline-offset:1px;}',
      '.tl-pop{position:fixed;z-index:9000;max-width:calc(100vw - 32px);max-height:60vh;overflow:auto;background:#fff;border:1px solid #b8c4d4;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.18);padding:8px;font-size:12px;color:#222;}',
      '.tl-pop-h{font-weight:700;margin-bottom:4px;} .tl-src{font-weight:400;color:#5b5b5b;font-size:11px;}',
      '.tl-pop-t{width:100%;border-collapse:collapse;} .tl-pop-t td{padding:2px 4px;border-bottom:1px solid #eee;} .tl-pop-t td.num{text-align:right;white-space:nowrap;} .tl-free td{color:#777;} .tl-fee td{color:#13315c;}',
      '.tl-pop-n{margin-top:4px;color:#5b5b5b;font-size:11px;}',
      '.tl-diff{color:#a4161a;font-weight:700;}',
      '#tollsPanel .tl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 14px;margin-bottom:6px;}',
      '#tollsPanel .tl-check{display:flex;flex-direction:row;align-items:center;gap:8px;margin:0;} #tollsPanel .tl-check input{width:auto;} #tollsPanel .tl-check .lbl{margin:0;font-weight:600;}',
      '#tollsPanel .tl-hint{font-size:11px;color:#5b5b5b;margin:-2px 0 4px 24px;} #tollsPanel .tl-ov{font-size:11px;color:#8a6d00;}',
      '#tollsPanel .tl-rate{width:90px;text-align:right;} #tollsPanel .tl-expl{margin:6px 0;font-size:12px;} #tollsPanel .tl-expl ul{margin:4px 0 0 18px;padding:0;}',
      'body.classic .tl-chip{background:#e8eef7;}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }

  /* ---------- form hooks ---------- */
  function hookForm() {
    var te = byId('d_tolls'); if (!te || te.__tollsHook) return;
    te.__tollsHook = true;
    te.addEventListener('input', act(function () {
      if (String(te.value).trim() === '') { FORM.handKey = null; FORM.kept = null; te.dataset.auto = ''; scheduleRefresh(0); return; }
      FORM.handKey = keyOf(formTrip()); FORM.kept = null; te.dataset.auto = ''; FORM.mode = 'hand'; renderChip(); patchReadout();
    }));
    te.addEventListener('change', act(function () { if (String(te.value).trim() === '') scheduleRefresh(0); }));
    ['d_puAddr', 'd_doAddr'].forEach(function (id) {
      var el = byId(id); if (!el) return;
      el.addEventListener('input', act(function () { patchReadout(); scheduleRefresh(400); }));
      el.addEventListener('change', act(function () { scheduleRefresh(50); }));
      el.addEventListener('blur', act(function () { scheduleRefresh(250); }));
    });
    var stopsBox = byId('d_stops');
    if (stopsBox) { stopsBox.addEventListener('input', act(function () { scheduleRefresh(400); })); stopsBox.addEventListener('focusout', act(function () { scheduleRefresh(250); })); }
    ['d_rt', 'd_vtype'].forEach(function (id) { var el = byId(id); if (el) el.addEventListener('change', act(function () { scheduleRefresh(0); })); });
    ['d_fare', 'd_account'].forEach(function (id) { var el = byId(id); if (el) { el.addEventListener('input', act(patchReadout)); el.addEventListener('change', act(patchReadout)); } });
    var sb = byId('d_save');
    if (sb && !sb.__tollsHook) { sb.__tollsHook = true; sb.addEventListener('click', act(dSaveBefore), true); sb.addEventListener('click', act(dSaveAfter), false); }
  }
  /* routeFor is also used by the optimizer (driver dead legs, other trips), the Fare estimate tab and the maps:
     only a route whose first and last points sit on the form's own pick-up and drop-off is the form's route */
  function ptOf(p) { if (!p) return null; var la = typeof p.lat === 'function' ? p.lat() : Number(p.lat), ln = typeof p.lng === 'function' ? p.lng() : Number(p.lng); return (isFinite(la) && isFinite(ln)) ? { lat: la, lng: ln } : null; }
  function formCoords(a) { var c = callG('coordsForAddr', a); if (!c) { try { var gc = STATE.geocache, n = callG('normalizeAddr', a); if (gc && n && gc[n]) c = gc[n]; } catch (e) {} } return ptOf(c); }
  function nearPt(a, b) { if (!a || !b) return false; var d = kmXY(a, b); return Math.sqrt(d.x * d.x + d.y * d.y) <= 0.6; }
  function pointsAreForm(points, f) {
    if (!Array.isArray(points) || points.length < 2) return false;
    var a = ptOf(points[0]), b = ptOf(points[points.length - 1]);
    return nearPt(a, formCoords(f.puAddr)) && nearPt(b, formCoords(f.doAddr));
  }
  function wrapConsole() {
    hookAfter('maybeAutoFare', function () { refreshForm(); });
    hookAfter('updateReadout', function () { patchReadout(); });
    hookAfter('updateDispMap', function () { scheduleRefresh(60); });
    hookAfter('useLastTrip', function () { FORM.kept = null; FORM.handKey = null; refreshForm(); });
    hookAfter('clearDispatch', function () { FORM.kept = null; FORM.handKey = null; FORM.geo = null; FORM.res = null; var te = byId('d_tolls'); if (te) te.dataset.auto = ''; refreshForm(); });
    hookAfter('editTrip', function (id) {
      var t = findTrip(id); FORM.handKey = null; FORM.kept = null; FORM.geo = null;
      /* a booked trip keeps its quoted tolls and fees (0 and none included) until an address, stop or round trip changes */
      if (t) {
        var tl = Array.isArray(t.tollDetail) ? t.tollDetail : (num(t.tolls) > 0 ? [{ key: 'manual', label: 'Tolls (typed)', amount: round2(t.tolls), source: 'manual' }] : []);
        FORM.kept = { key: keyOf(formTrip()), tollDetail: copy(tl), fees: copy(Array.isArray(t.fees) ? t.fees : []) };
        var te = byId('d_tolls'); if (te) { te.value = num(t.tolls).toFixed(2); te.dataset.auto = ''; }
      }
      refreshForm();
    });
    /* keep the road geometry the console fetched for the current form (Google first, OSRM backup) */
    hook('routeFor', function (orig) {
      return function (points) {
        var k = null; try { var f = formTrip(); if (f.puAddr && f.doAddr && pointsAreForm(points, f)) k = routeKeyOf(f); } catch (e) { k = null; }
        var p = orig.apply(this, arguments);
        try {
          if (k && p && typeof p.then === 'function') p.then(function (r) {
            try { var f2 = formTrip(); if (r && r.geo && routeKeyOf(f2) === k) { FORM.geo = { key: k, geo: r.geo }; scheduleRefresh(0); } } catch (e) {}
          }, function () {});
        } catch (e) {}
        return p;
      };
    });
    hook('chargeSquareFromReadout', function (orig) {
      return function () {
        var cs = window.chargeSquare, fees = FORM.res ? FORM.feesTotal : 0;
        if (!(fees > 0) || typeof cs !== 'function') return orig.apply(this, arguments);
        window.chargeSquare = function (amount) { window.chargeSquare = cs; return cs.call(this, round2(num(amount) + fees)); };
        try { return orig.apply(this, arguments); } finally { if (window.chargeSquare !== cs) window.chargeSquare = cs; }
      };
    });
  }

  /* ---------- collecting the fees ----------
     money.js (Money tab, Paid/Cash toasts, pay link, ledger officeTotal) and messages.js (receipt text, driver
     job text) add fare + tolls + tip (+ card fee) only. Their inner functions cannot be wrapped from here, so:
     - Money.total, Messages.render and Messages.vars (public) are wrapped to add t.feesTotal;
     - while a Money-tab button or a Messages-menu item runs for a trip with fees, the toast, the sms: link
       body and the clipboard text are corrected to the fee-inclusive amount;
     - the Money tab "Total" cell is corrected after each render.
     A trip with no fees (feesTotal 0 or missing) is never touched. */
  function cmoney(n) { try { if (typeof window.money === 'function') return window.money(n); } catch (e) {} return money(n); }
  function hookObj(obj, name, make) {
    if (!obj || typeof obj[name] !== 'function' || obj[name].__tollsWrapped) return false;
    var orig = obj[name], w = make(orig);
    w.__tollsWrapped = true; w._orig = orig; inheritFlags(w, orig);
    obj[name] = w; return true;
  }
  function feesOf(t) { var f = t && typeof t === 'object' ? num(t.feesTotal) : 0; return f > 0 ? round2(f) : 0; }
  function moneyTotalNoFees(t) {
    try { var M = window.Money, fn = M && M.total; if (fn) { while (fn.__tollsWrapped && fn._orig) fn = fn._orig; var tv = round2(num(fn(t))); return fn.feesIncluded ? round2(tv - feesOf(t)) : tv; } } catch (e) {}
    var cf = 0; try { if (t.cardFee != null) cf = num(t.cardFee); } catch (e) {}
    return round2(num(t.fare) + num(t.tolls) + num(t.tip) + cf);
  }
  function moneyNative() { try { var fn = window.Money && window.Money.total; while (fn && fn.__tollsWrapped && fn._orig) fn = fn._orig; return !!(fn && fn.feesIncluded); } catch (e) { return false; } }
  function feeText(s, t) {
    var fees = feesOf(t); if (!fees || typeof s !== 'string' || !s) return s;
    if (moneyNative()) {
      /* money.js and messages.js already count the fees in every amount: only add the "(incl. $X fees)" note after the fee-inclusive total */
      if (s.indexOf('(incl. ' + cmoney(fees) + ' fees)') >= 0) return s;
      var tw = 0; try { tw = round2(num(window.Money.total(t))); } catch (e) { tw = 0; }
      if (!(tw > 0)) return s;
      var mark = cmoney(tw), note = mark + ' (incl. ' + cmoney(fees) + ' fees)';
      return s.split(note).join('\u0004').split(mark).join(note).split('\u0004').join(note);
    }
    if (s.indexOf(cmoney(fees) + ' fees') >= 0) return s;
    var fare = num(t.fare), A = '\u0001', B = '\u0002', C = '\u0003';
    var out = s.split(cmoney(fare) + ' + tolls').join(A);
    var bases = []; [moneyTotalNoFees(t), round2(fare + num(t.tolls) + num(t.tip))].forEach(function (b) { if (b > 0 && bases.indexOf(b) < 0) bases.push(b); });
    bases.sort(function (a, b) { return cmoney(b).length - cmoney(a).length; });
    bases.forEach(function (b) { out = out.split(cmoney(b)).join(B + b.toFixed(2) + C); });
    out = out.replace(/\u0002([0-9.]+)\u0003/g, function (m, b) { return cmoney(round2(Number(b) + fees)) + ' (incl. ' + cmoney(fees) + ' fees)'; });
    out = out.split(A).join(cmoney(fare) + ' + tolls + ' + cmoney(fees) + ' fees');
    return out;
  }
  var CTX = { t: null, timer: 0 };
  function setCtx(t) {
    clearTimeout(CTX.timer);
    if (!t || !feesOf(t)) { CTX.t = null; return; }   /* a trip with no fees ends the last trip's context at once */
    CTX.t = t;
    CTX.timer = setTimeout(function () { CTX.t = null; }, 1500);
  }
  function smsFix(href, t) {
    var m = String(href).match(/^(sms:[^?]*\?&?body=)(.*)$/i); if (!m) return href;
    var body; try { body = decodeURIComponent(m[2]); } catch (e) { return href; }
    var nb = feeText(body, t); return nb === body ? href : m[1] + encodeURIComponent(nb);
  }
  function wrapCollect() {
    hookObj(window.Money, 'total', function (orig) { return function (t) { var v = orig.apply(this, arguments); if (orig.feesIncluded) return v; try { var tr = findTrip(t); var f = feesOf(tr); if (f) v = round2(num(v) + f); } catch (e) {} return v; }; });
    hookObj(window.Messages, 'render', function (orig) { return function (key, trip) { var s = orig.apply(this, arguments); try { s = feeText(s, findTrip(trip)); } catch (e) {} return s; }; });
    hookObj(window.Messages, 'vars', function (orig) {
      return function (trip) {
        var v = orig.apply(this, arguments);
        try {
          var t = findTrip(trip), f = feesOf(t);
          if (v && typeof v === 'object') {
            v.fees = cmoney(f); v.feesNote = f ? ' (incl. ' + cmoney(f) + ' fees)' : '';
            if (f) { v.total = cmoney(round2(num(t.fare) + num(t.tolls) + num(t.tip) + f)); if (/\+ tolls$/.test(String(v.fareOrAccount || ''))) v.fareOrAccount = v.fareOrAccount + ' + ' + cmoney(f) + ' fees'; }
          }
        } catch (e) {}
        return v;
      };
    });
    /* public actions other modules call (desk.js, smooth.js, crm.js): mark the trip for the corrections below */
    [[window.Money, ['charge', 'paid', 'cash', 'payLink']], [window.Messages, ['textPassenger', 'textDriver', 'textDriverTo', 'copyJob']]].forEach(function (p) {
      p[1].forEach(function (nm) { hookObj(p[0], nm, function (orig) { return function (id) { try { setCtx(findTrip(id)); } catch (e) {} return orig.apply(this, arguments); }; }); });
    });
    /* while CTX is set: toasts, sms: links and copied text carry the fees */
    if (typeof window.toast === 'function' && !window.toast.__tollsWrapped) {
      hook('toast', function (orig) { return function (m) { var a = Array.prototype.slice.call(arguments); try { if (CTX.t && typeof m === 'string') a[0] = feeText(m, CTX.t); } catch (e) {} return orig.apply(this, a); }; });
    }
    try {
      var cb = navigator.clipboard;
      if (cb && typeof cb.writeText === 'function' && !cb.writeText.__tollsWrapped) {
        var ow = cb.writeText;
        var ww = function (txt) { try { if (CTX.t) txt = feeText(String(txt), CTX.t); } catch (e) {} return ow.call(cb, txt); };
        ww.__tollsWrapped = true; ww._orig = ow;
        try { cb.writeText = ww; } catch (e) {}
      }
    } catch (e) {}
    if (!document.__tollsCollect) {
      document.__tollsCollect = true;
      document.addEventListener('click', function (ev) {
        try {
          var el = ev.target; if (!el || el.nodeType !== 1) return;
          if (el.tagName === 'A' && CTX.t && /^sms:/i.test(el.getAttribute('href') || '')) { var h = el.getAttribute('href'), nh = smsFix(h, CTX.t); if (nh !== h) el.setAttribute('href', nh); return; }
          var b = el.closest ? el.closest('button') : null; if (!b) return;
          if (b.closest('#moneyHome') && b.getAttribute('data-id')) { setCtx(findTrip(b.getAttribute('data-id'))); return; }
          var menu = b.closest('#msgMenu');
          if (menu) {
            var hb = menu.querySelector('.msg-h b'), no = hb ? Number(String(hb.textContent).replace(/\D/g, '')) : NaN;
            if (isFinite(no) && no > 0) setCtx(trips().filter(function (x) { return x && Number(x.dispatchNo) === no; })[0] || null);
          }
        } catch (e) {}
      }, true);
    }
    fixMoneyPanel();
    try {
      var mh = byId('moneyHome');
      if (mh && window.MutationObserver && !mh.__tollsObs) { mh.__tollsObs = true; new MutationObserver(function () { fixMoneyPanel(); }).observe(mh, { childList: true, subtree: true }); }
      else if (!mh && !POPOUT && !document.__tollsMoneyWait && window.MutationObserver && document.body) {
        document.__tollsMoneyWait = true;
        var mo = new MutationObserver(function () { var m2 = byId('moneyHome'); if (m2 && !m2.__tollsObs) { m2.__tollsObs = true; mo.disconnect(); fixMoneyPanel(); new MutationObserver(function () { fixMoneyPanel(); }).observe(m2, { childList: true, subtree: true }); } });
        mo.observe(document.body, { childList: true, subtree: true });
      }
    } catch (e) {}
  }
  function fixMoneyPanel() {
    var tb = byId('mny_unpaid'); if (!tb) return;
    tb.querySelectorAll('tr[data-trip]').forEach(function (tr) {
      if (tr.__tollsFixed) return;
      var t = findTrip(tr.getAttribute('data-trip')), f = feesOf(t); if (!f) return;
      var b = tr.querySelector('td.num b'); if (!b) return;
      tr.__tollsFixed = true;
      b.textContent = cmoney(round2(moneyTotalNoFees(t) + f));
      var h = document.createElement('div'); h.className = 'hint tl-feehint'; h.style.margin = '0'; h.textContent = 'incl. ' + cmoney(f) + ' fees';
      b.parentNode.appendChild(h);
    });
  }

  /* ---------- boot ---------- */
  function boot() {
    var dirty = false;
    try { dirty = ensureSettings(); } catch (e) {}
    /* old or damaged trip fields: never throw, only repair the shape */
    try {
      trips().forEach(function (t) {
        if (!t || typeof t !== 'object') return;
        if (t.tollDetail != null && !Array.isArray(t.tollDetail)) { delete t.tollDetail; dirty = true; }
        if (t.fees != null && !Array.isArray(t.fees)) { delete t.fees; delete t.feesTotal; dirty = true; }
        if (t.feesTotal != null && !isFinite(Number(t.feesTotal))) { t.feesTotal = 0; dirty = true; }
      });
    } catch (e) {}
    if (dirty) save();
    /* logic-only wraps run in pop-outs too: the Reservations / Calls pop-outs edit trips through saveEditOvl */
    try { wrapEditOverlay(); } catch (e) {}
    try { wrapCollect(); } catch (e) {}
    if (POPOUT) return;
    try { ensureStyle(); } catch (e) {}
    try { wrapConsole(); } catch (e) {}
    try { wrapBoard(); } catch (e) {}
    try { wrapReceipt(); } catch (e) {}
    try { wrapInvoice(); } catch (e) {}
    try { hookForm(); } catch (e) {}
    try { renderPanel(); fileUnderPrices(); setTimeout(act(fileUnderPrices), 400); setTimeout(act(fileUnderPrices), 1500); } catch (e) {}
    try { var view = byId('view-settings'); if (view && window.MutationObserver && !view.__tollsObs) { view.__tollsObs = true; new MutationObserver(function () { if (!byId(PANEL_ID)) renderPanel(); fileUnderPrices(); }).observe(view, { childList: true }); } } catch (e) {}
    try { refreshForm(); } catch (e) {}
    try { if (byId('activeBoard') && typeof window.refreshBoard === 'function') window.refreshBoard(); } catch (e) {}
  }

  window.Tolls = {
    _loaded: true,
    tollsFor: tollsFor, feesFor: feesFor, areaOf: areaOf, refreshForm: refreshForm, rateFor: rateFor,
    settings: function () { return TS(); },
    reportTolls: reportTolls, parseDriverReport: parseDriverReport, tollDiff: tollDiff, allIn: allIn,
    crossings: function () { return copy(CROSSINGS); }, form: function () { return { mode: FORM.mode, res: FORM.res, fees: copy(FORM.fees), feesTotal: FORM.feesTotal }; },
    renderPanel: renderPanel, attachToQuote: attachToQuote
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
