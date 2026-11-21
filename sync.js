/* ======================================================================
   Skyway — sync.js
   Cloud adapter, client side (PRODUCT-DESIGN.md §3 "Architecture", §9 "Data
   migration", Appendix A/C).  OFF by default — with Cloud disabled this file
   does nothing beyond adding a Settings card.

   What it does when Cloud is ON:
   - Wraps window.persist (the original still runs first) and
     window.reloadFromStorage; after either, STATE's collections
     (trips, drivers, vehicles, accounts, addrbook, settings, config keys)
     are diffed against the last synced snapshot (content hashes kept in
     localStorage 'skyway_sync_snap') and changed rows are queued in
     localStorage 'skyway_sync_queue' as {table, id, rev, del}.
   - The queue is flushed to Supabase REST (PostgREST):
       POST {url}/rest/v1/{table}?on_conflict=id
       headers apikey / Authorization: Bearer <anonKey> /
               Prefer: resolution=merge-duplicates,return=minimal
     in batches of 200, with retry + exponential backoff.
   - Every 10 s it polls each table for rows changed elsewhere:
       GET {url}/rest/v1/{table}?select=id,body,rev,deleted_at
           &location_id=eq.{loc}&rev=gt.{lastRev}&order=rev.asc&limit=500
     and patches them into STATE by id, then calls the console's existing
     syncRefresh() so every open view re-renders.
   - "Upload everything now": the first-upload routine — all collections in
     batches of 200, then a reconciliation report (counts per collection and
     SUM(fare) by month computed locally vs what the server returns).

   Row shape sent: {id, location_id, body, rev[, deleted_at]}.  Promoted
   columns (status, date, driver_id, ...) are filled by triggers on the server
   (supabase/schema.sql) so this file never needs to know about them.

   Public API: window.Cloud (see bottom).
   Plain ES2019, no build step, no frameworks. Never edits index.html.
   Never throws into the console's own code paths.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;

  /* SCREEN is a top-level `const` in index.html (lexical global): pop-out windows
     share this browser's localStorage, so only the main window talks to the cloud. */
  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }

  /* ---------- constants ---------- */
  var QUEUE_KEY = 'skyway_sync_queue';
  var SNAP_KEY = 'skyway_sync_snap';
  var CURSOR_KEY = 'skyway_sync_cursor';
  var BATCH = 200;
  var POLL_MS = 10000;
  var BACKOFF_MIN = 2000, BACKOFF_MAX = 5 * 60 * 1000;
  var PULL_LIMIT = 500;
  /* STATE[] arrays that become one row per element */
  var ARRAYS = ['trips', 'drivers', 'vehicles', 'accounts', 'addrbook'];
  /* STATE keys mirrored as rows of the `config` table (id = <locationId>:<key>) */
  var CONFIG_KEYS = ['zones', 'fares', 'farebook', 'hints', 'addrFix', 'compliance', 'map', 'finance'];
  /* settings keys that never leave this browser */
  var SETTINGS_SKIP = { cloud: 1, gmapkey: 1, geokey: 1 };
  var TABLES = ARRAYS.concat(['settings', 'config']);

  /* ---------- tiny helpers (own copies: never assume globals exist) ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[cloud] ' + m); } catch (e) {} }
  function log() { try { if (window.Cloud && window.Cloud.debug) console.log.apply(console, ['[cloud]'].concat([].slice.call(arguments))); } catch (e) {} }
  function warn() { try { console.warn.apply(console, ['[cloud]'].concat([].slice.call(arguments))); } catch (e) {} }
  function online() { try { if (typeof window.isOnline === 'function') return !!window.isOnline(); } catch (e) {} return navigator.onLine !== false; }
  function money(n) { if (typeof window.money === 'function') { try { return window.money(n); } catch (e) {} } n = Number(n) || 0; return '$' + n.toFixed(2); }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { warn(err); } }; }
  function lsGet(k, dflt) { try { var v = localStorage.getItem(k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { warn('localStorage write failed for ' + k, e); return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function nowMs() { return Date.now(); }
  function state() { return (typeof STATE !== 'undefined' && STATE) ? STATE : null; }   /* STATE is reassigned by backup restore: always re-read it */

  /* stable JSON (sorted keys) so a hash only changes when content changes */
  function stable(v) {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') { try { return JSON.stringify(v); } catch (e) { return '"?"'; } }
    if (Array.isArray(v)) { var a = []; for (var i = 0; i < v.length; i++) a.push(stable(v[i])); return '[' + a.join(',') + ']'; }
    var keys = Object.keys(v).sort(), out = [];
    for (var k = 0; k < keys.length; k++) { if (v[keys[k]] === undefined || typeof v[keys[k]] === 'function') continue; out.push(JSON.stringify(keys[k]) + ':' + stable(v[keys[k]])); }
    return '{' + out.join(',') + '}';
  }
  /* FNV-1a 32-bit over a string, returned as 8 hex chars + length (cheap, good enough for change detection) */
  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8) + '.' + s.length.toString(36);
  }
  function hashOf(obj) { return hashStr(stable(obj)); }
  function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }

  /* ---------- settings ---------- */
  /* publicBaseUrl: owner decision 2 — one owned domain, go.<domain> for short links in texts (the Edge Functions
     read the PUBLIC_BASE_URL secret; this copy is only shown as a hint in the Cloud card, see docs/SETUP.md §1). */
  var DEFAULTS = { url: '', anonKey: '', locationId: '', enabled: false, publicBaseUrl: '' };
  function cloud() {
    var s = state(); if (!s) return clone(DEFAULTS);
    if (!s.settings || typeof s.settings !== 'object') s.settings = {};
    var c = s.settings.cloud;
    if (!c || typeof c !== 'object') { c = clone(DEFAULTS); s.settings.cloud = c; }
    if (typeof c.url !== 'string') c.url = '';
    if (typeof c.anonKey !== 'string') c.anonKey = '';
    if (typeof c.locationId !== 'string') c.locationId = '';
    if (typeof c.publicBaseUrl !== 'string') c.publicBaseUrl = '';
    c.enabled = c.enabled === true;
    return c;
  }
  function publicBaseUrl() { return String(cloud().publicBaseUrl || '').trim().replace(/\/+$/, ''); }
  function baseUrl() { return String(cloud().url || '').trim().replace(/\/+$/, ''); }
  function configured() { var c = cloud(); return !!(baseUrl() && String(c.anonKey || '').trim() && String(c.locationId || '').trim()); }
  function enabled() { return cloud().enabled === true && configured(); }
  function locId() { return String(cloud().locationId || '').trim(); }
  function headers(extra) {
    var c = cloud(), h = { 'apikey': String(c.anonKey || '').trim(), 'Authorization': 'Bearer ' + String(c.anonKey || '').trim(), 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }

  /* ---------- status ---------- */
  var STATUS = { state: 'off', text: 'Cloud is off', lastOk: 0, lastErr: '', pending: 0 };
  function setStatus(st, text) {
    STATUS.state = st; STATUS.text = text || st;
    if (st === 'ok') { STATUS.lastOk = nowMs(); STATUS.lastErr = ''; }
    if (st === 'error') STATUS.lastErr = text || 'error';
    STATUS.pending = queueLoad().length;
    renderStatus();
  }
  function dotColor(st) { return st === 'ok' ? '#1f9d55' : st === 'error' ? '#b02318' : (st === 'syncing' || st === 'offline' || st === 'pending') ? '#d99a1b' : '#9a9a9a'; }
  function renderStatus() {
    var d = byId('cl_dot'), t = byId('cl_status'), sb = byId('sbCloud');
    var label = STATUS.text + (STATUS.pending ? ' · ' + STATUS.pending + ' change' + (STATUS.pending > 1 ? 's' : '') + ' waiting' : '');
    if (d) { d.style.background = dotColor(STATUS.state); d.setAttribute('data-state', STATUS.state); d.title = label; }
    if (t) t.textContent = label;
    if (sb) { sb.innerHTML = '<span class="cl-sbdot" style="background:' + dotColor(STATUS.state) + '"></span> ' + esc(STATUS.state === 'off' ? 'cloud off' : STATUS.state === 'ok' ? 'cloud' : STATUS.state); sb.title = label; sb.setAttribute('data-state', STATUS.state); }
  }

  /* ---------- snapshot (what the server already has, as content hashes) ---------- */
  var SNAP = null;
  function snapLoad() { if (!SNAP) { SNAP = lsGet(SNAP_KEY, null); if (!SNAP || typeof SNAP !== 'object') SNAP = {}; } return SNAP; }
  var _snapT = null;
  function snapSave() { clearTimeout(_snapT); _snapT = setTimeout(function () { lsSet(SNAP_KEY, snapLoad()); }, 150); }
  function snapGet(table, id) { var s = snapLoad(); return s[table] ? s[table][id] : undefined; }
  function snapSet(table, id, h) { var s = snapLoad(); if (!s[table]) s[table] = {}; if (h == null) delete s[table][id]; else s[table][id] = h; snapSave(); }
  function snapReset() { SNAP = {}; lsDel(SNAP_KEY); }

  /* ---------- queue ---------- */
  /* The queue holds only {table,id,rev,del}; bodies are read from STATE at flush time so
     localStorage stays small.  QIDX makes enqueue O(1) (the first upload queues every row). */
  var QUEUE = null, QIDX = null, _qDirty = false;
  function qkey(table, id) { return table + '\u0001' + id; }
  function queueLoad() {
    if (!QUEUE) {
      QUEUE = lsGet(QUEUE_KEY, null); if (!Array.isArray(QUEUE)) QUEUE = [];
      QIDX = {}; for (var i = 0; i < QUEUE.length; i++) QIDX[qkey(QUEUE[i].table, QUEUE[i].id)] = QUEUE[i];
    }
    return QUEUE;
  }
  function queueSave() { _qDirty = false; lsSet(QUEUE_KEY, queueLoad()); }
  function queueClear() { QUEUE = []; QIDX = {}; queueSave(); }
  function enqueue(table, id, del) {
    var q = queueLoad(), k = qkey(table, id), e = QIDX[k];
    if (e) { e.rev = nowMs(); e.del = !!del; }
    else { e = { table: table, id: id, rev: nowMs(), del: !!del }; q.push(e); QIDX[k] = e; }
    _qDirty = true;
  }
  function queueRemove(items) {
    var q = queueLoad(), keep = [], drop = {};
    for (var j = 0; j < items.length; j++) drop[qkey(items[j].table, items[j].id)] = items[j];
    for (var i = 0; i < q.length; i++) { var k = qkey(q[i].table, q[i].id); if (drop[k] === q[i]) delete QIDX[k]; else keep.push(q[i]); }
    QUEUE = keep; queueSave();
  }

  /* ---------- row builders ---------- */
  function addrId(x) { if (x && x.id != null && x.id !== '') return String(x.id); return 'ab_' + hashStr(String((x && x.address) || '').trim().toLowerCase()); }
  function rowId(table, x) { if (table === 'addrbook') return addrId(x); return x && x.id != null ? String(x.id) : ''; }
  function settingsBody() {
    var s = state(); var out = {}; var st = (s && s.settings) || {};
    Object.keys(st).forEach(function (k) { if (!SETTINGS_SKIP[k]) out[k] = st[k]; });
    return out;
  }
  function settingsRowId() { return locId(); }
  function configRowId(key) { return locId() + ':' + key; }
  function configBody(key) { var s = state(); return { key: key, value: s && s[key] !== undefined ? s[key] : null }; }
  /* the live body for a queued entry (the queue stores only ids so localStorage stays small) */
  function bodyFor(table, id) {
    var s = state(); if (!s) return null;
    if (table === 'settings') return id === settingsRowId() ? settingsBody() : null;
    if (table === 'config') { var key = id.slice(locId().length + 1); return CONFIG_KEYS.indexOf(key) >= 0 ? configBody(key) : null; }
    var arr = s[table]; if (!Array.isArray(arr)) return null;
    for (var i = 0; i < arr.length; i++) if (rowId(table, arr[i]) === id) return arr[i];
    return null;
  }
  function rowFor(entry) {
    var body = entry.del ? null : bodyFor(entry.table, entry.id);
    var row = { id: entry.id, location_id: locId(), rev: entry.rev };
    if (body) { row.body = body; row.deleted_at = null; }
    else { row.body = {}; row.deleted_at = new Date(entry.rev).toISOString(); }
    return row;
  }

  /* ---------- diff STATE vs snapshot → queue ---------- */
  function diffNow() {
    if (!enabled()) return 0;
    var s = state(); if (!s) return 0;
    var n = 0, seen, i, id, h, snap = snapLoad();
    ARRAYS.forEach(function (table) {
      var arr = Array.isArray(s[table]) ? s[table] : []; seen = {};
      for (i = 0; i < arr.length; i++) {
        id = rowId(table, arr[i]); if (!id) continue; seen[id] = 1;
        h = hashOf(arr[i]);
        if (snapGet(table, id) !== h) { enqueue(table, id, false); snapSet(table, id, h); n++; }
      }
      var known = snap[table] || {};
      Object.keys(known).forEach(function (k) { if (!seen[k]) { enqueue(table, k, true); snapSet(table, k, null); n++; } });
    });
    id = settingsRowId(); h = hashOf(settingsBody());
    if (snapGet('settings', id) !== h) { enqueue('settings', id, false); snapSet('settings', id, h); n++; }
    CONFIG_KEYS.forEach(function (key) {
      var cid = configRowId(key), ch = hashOf(configBody(key));
      if (snapGet('config', cid) !== ch) { enqueue('config', cid, false); snapSet('config', cid, ch); n++; }
    });
    if (_qDirty) queueSave();
    if (n) { log('queued', n); STATUS.pending = queueLoad().length; renderStatus(); scheduleFlush(0); }
    return n;
  }
  var _diffT = null;
  function scheduleDiff() { if (!enabled()) return; clearTimeout(_diffT); _diffT = setTimeout(function () { try { diffNow(); } catch (e) { warn('diff', e); } }, 350); }

  /* ---------- HTTP ---------- */
  function fetchJson(method, path, body, extraHeaders) {
    var url = baseUrl() + path;
    var opts = { method: method, headers: headers(extraHeaders) };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var p = ct.indexOf('json') >= 0 ? res.text().then(function (t) { try { return t ? JSON.parse(t) : null; } catch (e) { return t; } }) : res.text();
      return p.then(function (data) { return { ok: res.ok, status: res.status, data: data, headers: res.headers }; });
    });
  }
  function errText(r) {
    if (!r) return 'no response';
    var d = r.data, m = '';
    if (d && typeof d === 'object') m = d.message || d.hint || d.error || d.details || '';
    else if (typeof d === 'string') m = d.slice(0, 160);
    if (r.status === 401 || r.status === 403) m = 'key rejected (' + r.status + ') — check the anon key and the RLS policies' + (m ? ': ' + m : '');
    else if (r.status === 404) m = 'not found (404) — is schema.sql installed on this project?' + (m ? ' ' + m : '');
    else m = 'HTTP ' + r.status + (m ? ': ' + m : '');
    return m;
  }

  /* ---------- flush queue → server ---------- */
  var flushing = false, backoff = BACKOFF_MIN, _flushT = null, failures = 0;
  function scheduleFlush(ms) { clearTimeout(_flushT); _flushT = setTimeout(function () { flush(); }, ms == null ? 0 : ms); }
  function flush() {
    if (!enabled()) return Promise.resolve(false);
    if (flushing) return Promise.resolve(false);
    var q = queueLoad(); STATUS.pending = q.length;
    if (!q.length) { if (STATUS.state === 'pending' || STATUS.state === 'syncing') setStatus('ok', 'Synced'); else renderStatus(); return Promise.resolve(true); }
    if (!online()) { setStatus('offline', 'Offline — changes will upload when back online'); scheduleFlush(POLL_MS); return Promise.resolve(false); }
    flushing = true; setStatus('syncing', 'Uploading ' + q.length + ' change' + (q.length > 1 ? 's' : '') + '…');
    /* one batch: first table in the queue, up to BATCH rows, upserts and tombstones sent separately (PostgREST wants uniform keys per request) */
    var table = q[0].table, del = !!q[0].del, items = [];
    for (var i = 0; i < q.length && items.length < BATCH; i++) if (q[i].table === table && !!q[i].del === del) items.push(q[i]);
    var rows = items.map(rowFor);
    return fetchJson('POST', '/rest/v1/' + encodeURIComponent(table) + '?on_conflict=id', rows, { 'Prefer': 'resolution=merge-duplicates,return=minimal' })
      .then(function (r) {
        flushing = false;
        if (r.ok) {
          failures = 0; backoff = BACKOFF_MIN;
          queueRemove(items);
          for (var k = 0; k < items.length; k++) if (!items[k].del) snapSet(table, items[k].id, hashOf(rows[k].body));
          STATUS.pending = queueLoad().length;
          if (STATUS.pending) { renderStatus(); scheduleFlush(0); } else setStatus('ok', 'Synced');
          return true;
        }
        failures++;
        var msg = errText(r);
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
          /* a bad key / missing table will not fix itself: keep the queue, slow right down */
          setStatus('error', msg); backoff = Math.min(BACKOFF_MAX, backoff * 4);
        } else { setStatus('error', 'Upload failed (' + msg + ') — retrying'); backoff = Math.min(BACKOFF_MAX, backoff * 2); }
        scheduleFlush(backoff);
        return false;
      })
      .catch(function (e) {
        flushing = false; failures++;
        setStatus(online() ? 'error' : 'offline', online() ? 'Cannot reach the cloud (' + (e && e.message ? e.message : 'network') + ') — retrying' : 'Offline — will retry');
        backoff = Math.min(BACKOFF_MAX, backoff * 2); scheduleFlush(backoff);
        return false;
      });
  }

  /* ---------- pull changes made elsewhere → STATE ---------- */
  var CURSOR = null;
  function cursorLoad() { if (!CURSOR) { CURSOR = lsGet(CURSOR_KEY, null); if (!CURSOR || typeof CURSOR !== 'object' || CURSOR._loc !== locId()) CURSOR = { _loc: locId() }; } return CURSOR; }
  function cursorGet(table) { var c = cursorLoad(); return Number(c[table] || 0); }
  function cursorSet(table, rev) { var c = cursorLoad(); c[table] = Number(rev || 0); lsSet(CURSOR_KEY, c); }
  function cursorReset() { CURSOR = null; lsDel(CURSOR_KEY); }

  function applyRow(table, row) {
    var s = state(); if (!s || !row || !row.id) return false;
    var id = String(row.id), body = row.body, deleted = !!row.deleted_at;
    var h = deleted ? null : hashOf(body);
    if (!deleted && snapGet(table, id) === h) return false;          /* our own write echoed back, or nothing new */
    if (table === 'settings') {
      if (deleted || !body || typeof body !== 'object') return false;
      s.settings = s.settings || {};
      Object.keys(body).forEach(function (k) { if (!SETTINGS_SKIP[k]) s.settings[k] = body[k]; });
      snapSet('settings', id, hashOf(settingsBody()));
      return true;
    }
    if (table === 'config') {
      if (deleted || !body || typeof body !== 'object' || !body.key || CONFIG_KEYS.indexOf(body.key) < 0) return false;
      s[body.key] = body.value;
      snapSet('config', id, hashOf(configBody(body.key)));
      return true;
    }
    if (ARRAYS.indexOf(table) < 0) return false;
    if (!Array.isArray(s[table])) s[table] = [];
    var arr = s[table], idx = -1;
    for (var i = 0; i < arr.length; i++) if (rowId(table, arr[i]) === id) { idx = i; break; }
    if (deleted) { if (idx < 0) { snapSet(table, id, null); return false; } arr.splice(idx, 1); snapSet(table, id, null); return true; }
    if (!body || typeof body !== 'object') return false;
    if (table === 'drivers' && idx >= 0) {
      /* a phone's GPS pin replacing a manual pin: tell the dispatcher (design §4) */
      try { var oldL = arr[idx].curLoc, newL = body.curLoc; if (oldL && newL && oldL.source === 'manual' && newL.source === 'gps' && String(newL.when || '') > String(oldL.when || '')) toast((body.name || 'Driver') + "'s phone is reporting again — manual pin replaced."); } catch (e) {}
    }
    if (idx >= 0) arr[idx] = body; else arr.push(body);
    snapSet(table, id, h);
    return true;
  }

  var pulling = false;
  function pullTable(table) {
    var since = cursorGet(table);
    var path = '/rest/v1/' + encodeURIComponent(table) + '?select=id,body,rev,deleted_at&location_id=eq.' + encodeURIComponent(locId()) + '&rev=gt.' + since + '&order=rev.asc&limit=' + PULL_LIMIT;
    return fetchJson('GET', path).then(function (r) {
      if (!r.ok) throw new Error(errText(r));
      var rows = Array.isArray(r.data) ? r.data : [], changed = 0, maxRev = since;
      for (var i = 0; i < rows.length; i++) { try { if (applyRow(table, rows[i])) changed++; } catch (e) { warn('apply', table, e); } var rv = Number(rows[i].rev || 0); if (rv > maxRev) maxRev = rv; }
      if (maxRev !== since) cursorSet(table, maxRev);
      return { changed: changed, more: rows.length >= PULL_LIMIT };
    });
  }
  function pull() {
    if (!enabled() || pulling || !online()) return Promise.resolve(0);
    pulling = true;
    var total = 0, i = 0;
    function next() {
      if (i >= TABLES.length) return Promise.resolve();
      var t = TABLES[i++];
      return pullTable(t).then(function (res) { total += res.changed; return res.more ? pullTable(t).then(function (r2) { total += r2.changed; }) : null; }).then(next);
    }
    return next().then(function () {
      pulling = false;
      if (total) {
        log('pulled', total);
        try { if (typeof ORIG_PERSIST === 'function') ORIG_PERSIST(state()); } catch (e) {}   /* keep the local copy current without re-diffing */
        try { if (typeof window.syncRefresh === 'function') window.syncRefresh(); } catch (e) {}
      }
      if (STATUS.state !== 'syncing' && !queueLoad().length) setStatus('ok', 'Synced'); else renderStatus();
      return total;
    }).catch(function (e) {
      pulling = false;
      if (STATUS.state !== 'syncing') setStatus(online() ? 'error' : 'offline', 'Cannot read from the cloud: ' + (e && e.message ? e.message : e));
      return 0;
    });
  }

  /* ---------- timers ---------- */
  var _tick = null;
  function start() {
    stop();
    if (!enabled()) { setStatus('off', configured() ? 'Cloud is off' : 'Cloud is off (not configured)'); return; }
    setStatus('pending', 'Connecting…');
    try { diffNow(); } catch (e) { warn(e); }
    pull().then(function () { flush(); });
    _tick = setInterval(function () { try { if (document.hidden && !queueLoad().length) return; pull(); flush(); } catch (e) { warn('tick', e); } }, POLL_MS);
    window.addEventListener('online', onOnline);
  }
  function stop() { if (_tick) { clearInterval(_tick); _tick = null; } clearTimeout(_flushT); window.removeEventListener('online', onOnline); }
  function onOnline() { try { backoff = BACKOFF_MIN; scheduleFlush(500); pull(); } catch (e) {} }

  /* ---------- hooks on the console (wrap, never edit) ---------- */
  var ORIG_PERSIST = null;
  function hookPersist() {
    var orig = window.persist;
    if (typeof orig !== 'function' || orig.__cloudWrapped) return;
    ORIG_PERSIST = orig;
    var wrapped = function () { var out; try { out = orig.apply(this, arguments); } finally { try { scheduleDiff(); } catch (e) {} } return out; };
    wrapped.__cloudWrapped = true;
    window.persist = wrapped;
  }
  function hookReload() {
    var orig = window.reloadFromStorage;
    if (typeof orig !== 'function' || orig.__cloudWrapped) return;
    var wrapped = function () { var out; try { out = orig.apply(this, arguments); } finally { try { scheduleDiff(); } catch (e) {} } return out; };
    wrapped.__cloudWrapped = true;
    window.reloadFromStorage = wrapped;
  }
  function hookRenderSettings() {
    var orig = window.renderSettings;
    if (typeof orig !== 'function' || orig.__cloudWrapped) return;
    var wrapped = function () { var out; try { out = orig.apply(this, arguments); } finally { try { render(); } catch (e) {} } return out; };
    wrapped.__cloudWrapped = true;
    window.renderSettings = wrapped;
  }

  /* ---------- test connection ---------- */
  function test() {
    if (!configured()) return Promise.resolve({ ok: false, message: 'Fill in the URL, anon key and location id first.' });
    if (!online()) return Promise.resolve({ ok: false, message: 'This computer is offline.' });
    return fetchJson('GET', '/rest/v1/settings?select=id&location_id=eq.' + encodeURIComponent(locId()) + '&limit=1')
      .then(function (r) {
        if (r.ok) return { ok: true, message: 'Connected. ' + (Array.isArray(r.data) && r.data.length ? 'This location already has data in the cloud.' : 'No data for this location yet — press "Upload everything now".') };
        return { ok: false, message: errText(r) };
      })
      .catch(function (e) { return { ok: false, message: 'Cannot reach ' + baseUrl() + ' (' + (e && e.message ? e.message : 'network') + ').' }; });
  }

  /* ---------- first upload + reconciliation ---------- */
  function localCounts() {
    var s = state() || {}, out = {};
    ARRAYS.forEach(function (t) { out[t] = Array.isArray(s[t]) ? s[t].length : 0; });
    out.settings = 1; out.config = CONFIG_KEYS.length;
    return out;
  }
  function tripMonthKey(t) { var d = String((t && t.date) || ''); return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : 'unknown'; }
  function localFaresByMonth() {
    var s = state() || {}, out = {};
    (s.trips || []).forEach(function (t) { if (!t) return; var st = String(t.status || ''); if (st === 'Canceled' || st === 'Disregard') return; var k = tripMonthKey(t); out[k] = Math.round(((out[k] || 0) + (Number(t.fare) || 0)) * 100) / 100; });
    return out;
  }
  function serverCount(table) {
    var path = '/rest/v1/' + encodeURIComponent(table) + '?select=id&location_id=eq.' + encodeURIComponent(locId()) + '&deleted_at=is.null';
    return fetch(baseUrl() + path, { method: 'HEAD', headers: headers({ 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' }) })
      .then(function (res) { if (!res.ok) return null; var cr = res.headers.get('content-range') || ''; var m = cr.match(/\/(\d+)\s*$/); return m ? Number(m[1]) : null; })
      .catch(function () { return null; });
  }
  function serverFaresByMonth() {
    /* preferred: the sync_reconcile RPC from schema.sql; fallback: read date+fare pages and add them up here */
    return fetchJson('POST', '/rest/v1/rpc/sync_reconcile', { p_location_id: locId() }).then(function (r) {
      if (r.ok && r.data && typeof r.data === 'object' && r.data.fares_by_month) return r.data;
      return pageFares(0, {});
    }).catch(function () { return pageFares(0, {}); });
  }
  function pageFares(from, acc) {
    var size = 1000;
    return fetch(baseUrl() + '/rest/v1/trips?select=date,fare,status&location_id=eq.' + encodeURIComponent(locId()) + '&deleted_at=is.null&order=id.asc', { headers: headers({ 'Range-Unit': 'items', 'Range': from + '-' + (from + size - 1) }) })
      .then(function (res) { return res.ok || res.status === 206 ? res.json() : []; })
      .then(function (rows) {
        rows = Array.isArray(rows) ? rows : [];
        rows.forEach(function (t) { var st = String(t.status || ''); if (st === 'Canceled' || st === 'Disregard') return; var k = tripMonthKey(t); acc[k] = Math.round(((acc[k] || 0) + (Number(t.fare) || 0)) * 100) / 100; });
        if (rows.length >= size && from < 200000) return pageFares(from + size, acc);
        return { fares_by_month: acc };
      }).catch(function () { return { fares_by_month: acc, error: true }; });
  }
  function uploadAll(progress) {
    progress = typeof progress === 'function' ? progress : function () {};
    if (!configured()) return Promise.resolve({ ok: false, message: 'Fill in the URL, anon key and location id first.' });
    if (!online()) return Promise.resolve({ ok: false, message: 'This computer is offline.' });
    var s = state(); if (!s) return Promise.resolve({ ok: false, message: 'No data loaded.' });
    var rev = nowMs(), report = { ok: true, sent: {}, server: {}, local: localCounts(), faresLocal: localFaresByMonth(), faresServer: null, errors: [] };
    var jobs = [];
    ARRAYS.forEach(function (t) {
      var arr = Array.isArray(s[t]) ? s[t] : [], rows = [];
      for (var i = 0; i < arr.length; i++) { var id = rowId(t, arr[i]); if (!id) continue; rows.push({ id: id, location_id: locId(), body: arr[i], rev: rev, deleted_at: null }); }
      jobs.push({ table: t, rows: rows });
    });
    jobs.push({ table: 'settings', rows: [{ id: settingsRowId(), location_id: locId(), body: settingsBody(), rev: rev, deleted_at: null }] });
    jobs.push({ table: 'config', rows: CONFIG_KEYS.map(function (k) { return { id: configRowId(k), location_id: locId(), body: configBody(k), rev: rev, deleted_at: null }; }) });
    var ji = 0;
    function sendJob() {
      if (ji >= jobs.length) return Promise.resolve();
      var job = jobs[ji++], sent = 0, bi = 0;
      function sendBatch() {
        if (bi >= job.rows.length) { report.sent[job.table] = sent; return Promise.resolve(); }
        var batch = job.rows.slice(bi, bi + BATCH); bi += BATCH;
        progress({ table: job.table, done: Math.min(bi, job.rows.length), total: job.rows.length });
        return fetchJson('POST', '/rest/v1/' + encodeURIComponent(job.table) + '?on_conflict=id', batch, { 'Prefer': 'resolution=merge-duplicates,return=minimal' })
          .then(function (r) {
            if (!r.ok) { report.ok = false; report.errors.push(job.table + ': ' + errText(r)); return; }
            sent += batch.length;
            batch.forEach(function (row) { snapSet(job.table, row.id, hashOf(row.body)); });
            return sendBatch();
          })
          .catch(function (e) { report.ok = false; report.errors.push(job.table + ': ' + (e && e.message ? e.message : e)); });
      }
      return sendBatch().then(sendJob);
    }
    setStatus('syncing', 'Uploading everything…');
    return sendJob().then(function () {
      progress({ table: 'reconcile', done: 0, total: 0 });
      var ci = 0, tables = TABLES.slice();
      function countNext() { if (ci >= tables.length) return Promise.resolve(); var t = tables[ci++]; return serverCount(t).then(function (n) { report.server[t] = n; return countNext(); }); }
      return countNext();
    }).then(function () { return serverFaresByMonth(); }).then(function (f) {
      report.faresServer = (f && f.fares_by_month) || {};
      if (f && f.counts) Object.keys(f.counts).forEach(function (k) { if (report.server[k] == null) report.server[k] = f.counts[k]; });
      report.match = true;
      TABLES.forEach(function (t) { if (report.server[t] != null && report.server[t] !== report.local[t]) report.match = false; });
      var months = {}; Object.keys(report.faresLocal).forEach(function (m) { months[m] = 1; }); Object.keys(report.faresServer).forEach(function (m) { months[m] = 1; });
      Object.keys(months).forEach(function (m) { if (Math.abs((report.faresLocal[m] || 0) - (report.faresServer[m] || 0)) > 0.005) report.match = false; });
      report.months = Object.keys(months).sort();
      if (report.ok) setStatus('ok', 'Upload complete'); else setStatus('error', report.errors[0] || 'Upload had errors');
      return report;
    });
  }

  /* ---------- Settings card ---------- */
  var PANEL_ID = 'cloudPanel';
  function ensureStyle() {
    if (byId('cloudStyle')) return;
    var st = document.createElement('style'); st.id = 'cloudStyle';
    st.textContent = [
      '.cl-panel .cl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 14px;}',
      '.cl-panel .cl-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#9a9a9a;margin-right:6px;vertical-align:middle;box-shadow:0 0 0 2px rgba(0,0,0,.06);}',
      '.cl-panel .cl-statusrow{display:flex;align-items:center;gap:6px;margin:6px 0 10px;font-size:12px;color:var(--muted,#5b5b5b);}',
      '.cl-panel .cl-report{margin-top:10px;font-size:12px;}',
      '.cl-panel .cl-report table{border-collapse:collapse;margin-top:6px;}',
      '.cl-panel .cl-report td,.cl-panel .cl-report th{border:1px solid var(--line-soft,#e4e4e4);padding:3px 8px;text-align:left;font-size:12px;}',
      '.cl-panel .cl-report th{background:var(--head,#f3f6f9);}',
      '.cl-panel .cl-ok{color:#1f9d55;font-weight:600;} .cl-panel .cl-bad{color:#b02318;font-weight:600;}',
      '.cl-panel .cl-chk{display:flex;flex-direction:row;align-items:center;gap:8px;} .cl-panel .cl-chk input{width:auto;}',
      '.cl-panel .cl-progress{height:6px;background:var(--line-soft,#e4e4e4);border-radius:3px;overflow:hidden;margin-top:6px;} .cl-panel .cl-progress i{display:block;height:100%;width:0;background:var(--green,#1c5b9c);transition:width .2s;}',
      '.cl-sbdot{display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle;margin-right:3px;}',
      '#sbCloud{align-self:center;font-size:11px;opacity:.85;cursor:default;}',
      'body.gold .cl-panel .cl-report th{background:#1d2027;} body.gold .cl-panel .cl-report td,body.gold .cl-panel .cl-report th{border-color:#2c3038;}',
      'body.classic .cl-panel .cl-report th{background:#d4d0c8;} body.classic .cl-panel .cl-report td,body.classic .cl-panel .cl-report th{border-color:#808080;}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  function render() {
    if (POPOUT) return;
    var view = byId('view-settings'); if (!view) return;
    ensureStyle();
    var c = cloud();
    var panel = byId(PANEL_ID);
    if (!panel) { panel = document.createElement('div'); panel.id = PANEL_ID; panel.className = 'panel cl-panel'; view.appendChild(panel); }
    var h = '<div class="panel-head">Cloud (multi-device sync) <span class="hint" style="margin:0;font-weight:400;">share this console live with other computers and driver phones</span></div><div class="panel-body">';
    h += '<p class="hint" style="margin-top:0;">Off by default &mdash; the console keeps working exactly as it does today from this computer\'s storage. Turn Cloud on after the Supabase project is set up (see <span class="mono">docs/SETUP.md</span>). Every save is then also written to the cloud, and changes made on other devices appear here within about 10 seconds. Turn it off at any time to go back to a pure local app.</p>';
    h += '<div class="cl-statusrow"><span class="cl-dot" id="cl_dot"></span><span id="cl_status">' + esc(STATUS.text) + '</span></div>';
    h += '<div class="cl-grid">';
    h += '<label class="fld"><span class="lbl">Supabase project URL</span><input type="text" id="cl_url" value="' + esc(c.url) + '" placeholder="https://abcdefgh.supabase.co" autocomplete="off" spellcheck="false"></label>';
    h += '<label class="fld"><span class="lbl">Anon (public) key</span><input type="password" id="cl_key" value="' + esc(c.anonKey) + '" placeholder="eyJhbGciOi…" autocomplete="off" spellcheck="false"></label>';
    h += '<label class="fld"><span class="lbl">Location id</span><input type="text" id="cl_loc" value="' + esc(c.locationId) + '" placeholder="nyc" autocomplete="off" spellcheck="false"></label>';
    h += '<label class="fld cl-chk"><input type="checkbox" id="cl_enabled"' + (c.enabled ? ' checked' : '') + '><span class="lbl" style="margin:0;font-weight:600;">Enable cloud sync</span></label>';
    h += '</div>';
    h += '<div class="hint" id="cl_links" style="margin-top:4px;">Short links use: ' + (publicBaseUrl() ? '<span class="mono">' + esc(publicBaseUrl()) + '</span>' : 'not set &mdash; see <span class="mono">docs/SETUP.md &sect;1</span>') + '</div>';
    h += '<div class="btn-row" style="margin-top:6px;"><button class="btn btn-go" type="button" id="cl_save">Save cloud settings</button><button class="btn btn-navy" type="button" id="cl_test">Test connection</button><button class="btn btn-navy" type="button" id="cl_upload">Upload everything now</button><button class="btn btn-ghost" type="button" id="cl_flush">Retry upload</button></div>';
    h += '<div class="hint" id="cl_msg" style="margin-top:6px;"></div>';
    h += '<div class="cl-progress" id="cl_prog" hidden><i id="cl_progbar"></i></div>';
    h += '<div class="cl-report" id="cl_report"></div>';
    h += '</div>';
    panel.innerHTML = h;
    renderStatus();

    var bs = byId('cl_save');
    if (bs) bs.addEventListener('click', act(function () {
      var v = function (id) { var el = byId(id); return el ? String(el.value || '').trim() : ''; };
      var en = byId('cl_enabled'); var wasOn = enabled();
      set({ url: v('cl_url'), anonKey: v('cl_key'), locationId: v('cl_loc'), enabled: !!(en && en.checked) });
      var msg = byId('cl_msg');
      if (cloud().enabled && !configured()) { if (msg) msg.textContent = 'Cloud stays off until the URL, anon key and location id are all filled in.'; toast('Cloud settings saved — fill in all three fields to turn it on.', true); }
      else { if (msg) msg.textContent = enabled() ? 'Cloud is ON for location "' + cloud().locationId + '".' : 'Cloud is off.'; toast(enabled() ? 'Cloud sync is on.' : 'Cloud settings saved' + (wasOn ? ' — cloud sync is now off.' : '.')); }
    }));
    var bt = byId('cl_test');
    if (bt) bt.addEventListener('click', act(function () {
      var v = function (id) { var el = byId(id); return el ? String(el.value || '').trim() : ''; };
      /* test with what is typed, without saving */
      var c0 = cloud(), saved = { url: c0.url, anonKey: c0.anonKey, locationId: c0.locationId };
      c0.url = v('cl_url'); c0.anonKey = v('cl_key'); c0.locationId = v('cl_loc');
      var msg = byId('cl_msg'); if (msg) msg.textContent = 'Testing…'; bt.disabled = true;
      test().then(function (r) {
        c0.url = saved.url; c0.anonKey = saved.anonKey; c0.locationId = saved.locationId; bt.disabled = false;
        if (msg) { msg.innerHTML = '<span class="' + (r.ok ? 'cl-ok' : 'cl-bad') + '">' + (r.ok ? 'OK' : 'Failed') + '</span> &mdash; ' + esc(r.message); }
        toast(r.ok ? 'Cloud connection OK.' : 'Cloud test failed: ' + r.message, !r.ok);
      });
    }));
    var bu = byId('cl_upload');
    if (bu) bu.addEventListener('click', act(function () {
      if (!configured()) { toast('Fill in the URL, anon key and location id, then Save, before uploading.', true); return; }
      var lc = localCounts();
      if (!window.confirm('Upload everything to the cloud now?\n\n' + ARRAYS.map(function (t) { return t + ': ' + lc[t]; }).join('\n') + '\n\nRows already in the cloud with the same id are replaced by this computer\'s copy.')) return;
      bu.disabled = true; var prog = byId('cl_prog'), bar = byId('cl_progbar'), msg = byId('cl_msg'), rep = byId('cl_report');
      if (prog) prog.hidden = false; if (rep) rep.innerHTML = '';
      uploadAll(function (p) { if (msg) msg.textContent = p.table === 'reconcile' ? 'Checking the cloud copy against this computer…' : 'Uploading ' + p.table + ' ' + p.done + ' / ' + p.total; if (bar && p.total) bar.style.width = Math.round(100 * p.done / p.total) + '%'; })
        .then(function (r) {
          bu.disabled = false; if (prog) prog.hidden = true;
          if (!r.ok && r.message) { if (msg) msg.textContent = r.message; toast(r.message, true); return; }
          if (msg) msg.textContent = r.ok ? 'Upload finished.' : 'Upload finished with errors.';
          if (rep) rep.innerHTML = reportHtml(r);
          toast(r.ok ? (r.match ? 'Upload complete — cloud copy matches this computer.' : 'Upload complete — see the reconciliation table.') : 'Upload had errors — see below.', !r.ok || !r.match);
          if (enabled()) scheduleFlush(0);
        });
    }));
    var bf = byId('cl_flush');
    if (bf) bf.addEventListener('click', act(function () { if (!enabled()) { toast('Turn Cloud on first.', true); return; } backoff = BACKOFF_MIN; diffNow(); flush(); pull(); toast('Retrying…'); }));
  }
  function reportHtml(r) {
    var h = '<div><b>Reconciliation report</b> &mdash; ' + (r.match ? '<span class="cl-ok">everything matches</span>' : '<span class="cl-bad">differences found</span>') + (r.errors.length ? ' &mdash; <span class="cl-bad">' + esc(r.errors.join('; ')) + '</span>' : '') + '</div>';
    h += '<table><tr><th>Collection</th><th>This computer</th><th>Sent</th><th>In the cloud</th><th></th></tr>';
    TABLES.forEach(function (t) {
      var l = r.local[t], s = r.server[t], ok = s != null && s === l;
      h += '<tr><td>' + esc(t) + '</td><td>' + esc(l) + '</td><td>' + esc(r.sent[t] != null ? r.sent[t] : '') + '</td><td>' + esc(s == null ? '?' : s) + '</td><td class="' + (ok ? 'cl-ok' : 'cl-bad') + '">' + (ok ? 'match' : (s == null ? 'not counted' : 'differs')) + '</td></tr>';
    });
    h += '</table>';
    if (r.months && r.months.length) {
      h += '<table><tr><th>Fares by month</th><th>This computer</th><th>In the cloud</th><th></th></tr>';
      r.months.forEach(function (m) { var a = r.faresLocal[m] || 0, b = r.faresServer[m] || 0, ok = Math.abs(a - b) <= 0.005; h += '<tr><td>' + esc(m) + '</td><td>' + esc(money(a)) + '</td><td>' + esc(money(b)) + '</td><td class="' + (ok ? 'cl-ok' : 'cl-bad') + '">' + (ok ? 'match' : 'differs') + '</td></tr>'; });
      h += '</table>';
    }
    h += '<div class="hint" style="margin-top:6px;">Canceled and disregarded trips are left out of the fare totals on both sides. If anything differs, press "Upload everything now" again before relying on the cloud copy.</div>';
    return h;
  }
  function renderStatusBar() {
    if (POPOUT) return;
    var sb = byId('statusBar'); if (!sb || byId('sbCloud')) return;
    var el = document.createElement('span'); el.id = 'sbCloud'; el.className = 'sb-cloud';
    try { sb.appendChild(el); } catch (e) {}
    renderStatus();
  }

  /* ---------- set / get ---------- */
  function get() { var c = cloud(); return { url: c.url, anonKey: c.anonKey, locationId: c.locationId, enabled: c.enabled, publicBaseUrl: c.publicBaseUrl }; }
  function set(patch) {
    var c = cloud(); patch = patch || {};
    var before = enabled(), locBefore = locId();
    if (patch.url !== undefined) c.url = String(patch.url || '').trim();
    if (patch.anonKey !== undefined) c.anonKey = String(patch.anonKey || '').trim();
    if (patch.locationId !== undefined) c.locationId = String(patch.locationId || '').trim();
    if (patch.publicBaseUrl !== undefined) c.publicBaseUrl = String(patch.publicBaseUrl || '').trim().replace(/\/+$/, '');
    if (patch.enabled !== undefined) c.enabled = patch.enabled === true;
    if (locId() !== locBefore) { snapReset(); cursorReset(); queueClear(); }
    try { if (typeof window.save === 'function') window.save(); } catch (e) {}
    if (enabled() !== before || (enabled() && locId() !== locBefore)) start(); else renderStatus();
    if (c.enabled !== !!(byId('cl_enabled') && byId('cl_enabled').checked)) { try { render(); } catch (e) {} }   /* keep the card in step when set() is called from code */
    return get();
  }

  /* ---------- Edge Function helper for other files (simple.js, driver-link.js…) ---------- */
  function fn(name, payload) {
    if (!configured()) return Promise.reject(new Error('Cloud is not configured'));
    return fetch(baseUrl() + '/functions/v1/' + encodeURIComponent(name), { method: 'POST', headers: headers(), body: JSON.stringify(payload || {}) })
      .then(function (res) { return res.text().then(function (t) { var d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; } if (!res.ok) { var err = new Error((d && d.error) || ('HTTP ' + res.status)); err.status = res.status; err.data = d; throw err; } return d; }); });
  }

  /* ---------- public API ---------- */
  window.Cloud = {
    get: get, set: set, enabled: enabled, configured: configured, status: function () { return { state: STATUS.state, text: STATUS.text, pending: queueLoad().length, lastOk: STATUS.lastOk, lastErr: STATUS.lastErr }; },
    test: test, uploadAll: uploadAll, flush: flush, pull: pull, diffNow: diffNow,
    queue: function () { return queueLoad().slice(); }, queueSize: function () { return queueLoad().length; },
    snapshotReset: function () { snapReset(); cursorReset(); }, fn: fn, render: render, start: start, stop: stop, publicBaseUrl: publicBaseUrl,
    localCounts: localCounts, localFaresByMonth: localFaresByMonth, rowFor: rowFor, hashOf: hashOf,
    tables: TABLES.slice(), configKeys: CONFIG_KEYS.slice(), debug: false, version: '1.0.0'
  };

  /* ---------- boot ---------- */
  function boot() {
    try { cloud(); } catch (e) {}
    if (POPOUT) return;
    try { hookPersist(); } catch (e) { warn(e); }
    try { hookReload(); } catch (e) { warn(e); }
    try { hookRenderSettings(); } catch (e) { warn(e); }
    try { render(); } catch (e) { warn(e); }
    try { renderStatusBar(); } catch (e) { warn(e); }
    try { start(); } catch (e) { warn(e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
