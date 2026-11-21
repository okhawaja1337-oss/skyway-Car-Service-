/* ======================================================================
   Skyway — money.js
   MONEY home panel, client-side part (PRODUCT-DESIGN.md §6 "Payments,
   billing and invoicing with Square" — what works today, no Square API).

   - "Today's money" panel at the TOP of #view-earnings (MONEY → Earnings in
     simple mode, the Earnings tab in expert mode): KPI tiles, the "Unpaid
     rides" table (Completed card rides not yet marked paid) with
     Charge card (Square Virtual Terminal) / Paid / Mark cash / Send pay link,
     and an "Open invoices" summary per account that jumps to Invoicing.
   - trip.payment = {status:'paid'|'pending-vt'|'link-sent'|'noshow-pending'|'noshow-fee', method?,
     at, link?, amount?, cardOnFile?, via?}  — cardOnFile:true (or a cloud sourceId / an
     'authorized' hold from square-charge) is what lets the dispatcher charge a no-show fee.
     Fields square-charge wrote (paymentId, holdCents, sourceId, customerId, authorizedAt…) are
     always preserved: this module only ever merges into trip.payment, never replaces it.
   - No-show fee flow (two steps, like "Charge card" → "Paid"):
       * no cloud hold: "Charge no-show fee" opens the Square Virtual Terminal and records
         status 'noshow-pending' (via:'vt'); nothing is recorded when the pop-up is blocked.
         "Fee paid" then records 'noshow-fee'. The row never reads "charged" before that.
       * cloud hold on the trip (payment.status 'authorized' + paymentId): the VT is NOT opened
         (that would charge the card a second time). With Cloud on, the fee is captured from the
         existing hold through square-charge {action:'capture', kind:'noshow_fee'} and the rest
         of the hold is released (owner decision 5); with Cloud off the dispatcher is told to
         complete the hold in Square and press "Fee paid".
   - STATE.settings.squarePayLink (Square payment-link URL) — field added to
     the Settings → Region card (#rg_extra slot from region.js) or its own card.
   - Owner decision 4 (accepted defaults):
       * settings.autoGratuityPct = 0 — NO automatic gratuity until an account asks;
         account.autoGratuityPct (per account) overrides it. gratuity(t) is only ever
         added on Account rides and is 0 unless one of those is set.
       * No-show fee = the base fare (settings.noShowFee = {mode:'base'}), charged ONLY
         when a card is on file and ONLY by the dispatcher pressing "Charge no-show fee"
         in the "No-shows" list of this panel. Never automatic.
   - Owner decision 3: driver payouts are bank ACH / CSV from the Earnings tab numbers;
     this module builds no settlement rows (settlements.method defaults to 'ach_csv'
     in supabase/schema.sql). No card reader for the pilot.
   - Wraps window.refreshBoard and window.renderEarnings to re-render.
   - All amounts go through window.money (region.js makes it currency-aware).

   Public API: window.Money = {render, unpaid, total, gratuity, charge, paid, cash,
     payLink, noShows, noShowFeeAmount, hasCard, noShowFee, noShowPaid, openInvoices, kpis}
   Plain ES2019, no build step. Never edits index.html.
   ====================================================================== */
(function () {
  'use strict';
  if (typeof STATE === 'undefined') return;

  var POPOUT = '';
  try { if (typeof SCREEN !== 'undefined' && SCREEN) POPOUT = String(SCREEN); else if (window.SCREEN) POPOUT = String(window.SCREEN); } catch (e) { POPOUT = ''; }
  if (POPOUT) return;   // pop-out boards never show the money panel

  /* ---------- helpers ---------- */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function money(n) { if (typeof window.money === 'function') { try { return window.money(n); } catch (e) {} } n = Number(n) || 0; return '$' + n.toFixed(2); }
  function shortAddr(a) { if (typeof window.shortAddr === 'function') { try { return window.shortAddr(a); } catch (e) {} } return (a || '').split(',')[0].trim(); }
  function toast(m, w) { if (typeof window.toast === 'function') { try { window.toast(m, w); return; } catch (e) {} } try { console.log('[money] ' + m); } catch (e) {} }
  function save() { if (typeof window.saveNow === 'function') { try { window.saveNow(); return; } catch (e) {} } if (typeof window.save === 'function') { try { window.save(); } catch (e) {} } }
  function settings() { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; return STATE.settings; }
  function trips() { return Array.isArray(STATE.trips) ? STATE.trips : []; }
  function findTrip(id) { if (id && typeof id === 'object') return id; return trips().filter(function (t) { return t.id === id; })[0] || null; }
  function findAccount(id) { return (STATE.accounts || []).filter(function (a) { return a.id === id; })[0] || null; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayStr() { if (typeof window.todayStr === 'function') { try { return window.todayStr(); } catch (e) {} } var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function monthPrefix() { return todayStr().slice(0, 7); }
  function nowISO() { return new Date().toISOString(); }
  function act(fn) { return function (e) { try { return fn(e); } catch (err) { try { console.error('[money]', err); } catch (e2) {} } }; }
  function bizName() { return settings().name || 'Skyway Car Service'; }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function fmtWhen(iso) { try { var d = new Date(iso); if (isNaN(d)) return ''; if (window.Region && typeof window.Region.fmtTime === 'function') return window.Region.fmtTime(d); return d.toTimeString().slice(0, 5); } catch (e) { return ''; } }
  function fmtTime12(t) { if (window.Messages && typeof window.Messages.fmtTime12 === 'function') { try { return window.Messages.fmtTime12(t); } catch (e) {} } return t || ''; }
  function fmtPhone(p) { if (window.Region && typeof window.Region.fmtPhone === 'function') { try { return window.Region.fmtPhone(p); } catch (e) {} } return p || ''; }
  function openUrl(url) {
    if (!url) return false;
    try { var w = window.open(url, '_blank', 'noopener'); if (w) return true; } catch (e) {}
    try { var a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); return true; } catch (e) { return false; }
  }
  function openHref(href) {
    try { var a = document.createElement('a'); a.href = href; a.rel = 'noopener'; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); return true; } catch (e) { return false; }
  }
  function smsHref(phone, body) {
    if (window.Messages && typeof window.Messages.smsHref === 'function') { try { return window.Messages.smsHref(phone, body); } catch (e) {} }
    var s = String(phone || '').trim(), d = s.replace(/\D/g, ''); if (!d) return '';
    var cc = (window.Region && window.Region.get) ? String(window.Region.get().phoneCC || '+1').replace(/\D/g, '') : '1';
    if (s.charAt(0) !== '+') { if (cc === '1' && d.length === 10) d = '1' + d; else if (d.indexOf(cc) !== 0) d = cc + d; }
    return 'sms:+' + d + '?&body=' + encodeURIComponent(body || '');
  }

  var VT_DEFAULT = 'https://app.squareup.com/dashboard/sales/virtual-terminal/checkout';
  function vtUrl() { return String(settings().square || '').trim() || VT_DEFAULT; }

  /* ---------- money math ---------- */
  function isCard(t) { return !!t && t.payType === 'Credit Card'; }
  function isPaid(t) { return !!(t && t.payment && t.payment.status === 'paid'); }
  function cardFee(t) {
    if (!isCard(t)) return 0;
    if (typeof window.cardFeeAmt === 'function') { try { return Number(window.cardFeeAmt(Number(t.fare) || 0)) || 0; } catch (e) { return 0; } }
    return 0;
  }
  function isAccountTrip(t) { return !!(t && (t.accountId || t.payType === 'Account')); }
  /* Owner decision 4: automatic gratuity on Account rides only; the account's own
     autoGratuityPct wins over settings.autoGratuityPct; both default 0 → adds nothing. */
  function gratuityPct(t) {
    if (!isAccountTrip(t)) return 0;
    var a = t.accountId ? findAccount(t.accountId) : null, pct = NaN;
    if (a && a.autoGratuityPct != null && a.autoGratuityPct !== '') pct = Number(a.autoGratuityPct);
    if (!isFinite(pct)) pct = Number(settings().autoGratuityPct) || 0;
    return Math.min(100, Math.max(0, pct));
  }
  function gratuity(t) {
    t = findTrip(t); if (!t) return 0;
    var pct = gratuityPct(t); if (!pct) return 0;
    return round2((Number(t.fare) || 0) * pct / 100);
  }
  function total(t) {
    t = findTrip(t); if (!t) return 0;
    return round2((Number(t.fare) || 0) + (Number(t.tolls) || 0) + (Number(t.tip) || 0) + cardFee(t) + gratuity(t));
  }
  function sortNewest(a, b) { var ka = (a.date || '') + ' ' + (a.time || ''), kb = (b.date || '') + ' ' + (b.time || ''); if (ka !== kb) return ka < kb ? 1 : -1; return (b.createdAt || '') < (a.createdAt || '') ? -1 : 1; }
  function unpaid() { return trips().filter(function (t) { return t.status === 'Completed' && isCard(t) && !isPaid(t); }).sort(sortNewest); }
  function isInvoiced(t) { return !!(t.invoiced || t.invoiceId || (t.invoice && (t.invoice.id || t.invoice.status)) || isPaid(t)); }

  /* ---------- no-show fee (owner decision 4: base fare, card on file, dispatcher button only) ---------- */
  function hasCard(t) {
    t = findTrip(t); if (!t) return false;
    var p = t.payment || {};
    if (p.cardOnFile || p.sourceId || p.status === 'authorized') return true;   // console flag, or square-charge put a hold / card id on the trip
    if (t.cardOnFile) return true;
    var a = t.accountId ? findAccount(t.accountId) : null;
    return !!(a && (a.cardOnFile || (Array.isArray(a.cards) && a.cards.length)));
  }
  function noShowFeeAmount(t) {
    t = findTrip(t); if (!t) return 0;
    var cfg = settings().noShowFee; if (!cfg || typeof cfg !== 'object') cfg = { mode: 'base' };
    if (cfg.mode === 'none') return 0;
    if (cfg.mode === 'flat') return round2(cfg.amount);
    if (cfg.mode === 'pct') return Math.round((Number(t.fare) || 0) * (Number(cfg.pct) || 0) / 100);
    return Math.round(Number(t.fare) || 0);   // 'base' (default): the base fare, no tolls, no tip, no card fee
  }
  function feeCharged(t) { return !!(t && t.payment && (t.payment.status === 'noshow-fee' || t.payment.status === 'paid')); }
  function feePending(t) { return !!(t && t.payment && t.payment.status === 'noshow-pending'); }
  /* The Square authorization square-charge put on the trip at booking (owner decision 5), or null. Still
     recognised while the fee is pending (priorStatus 'authorized'), so a retry never reaches the Virtual Terminal. */
  function cloudHold(t) {
    var p = (t && t.payment) || {}; if (!p.paymentId) return null;
    if (p.status === 'authorized' || (p.status === 'noshow-pending' && p.priorStatus === 'authorized')) return p;
    return null;
  }
  function holdAmount(p) { return round2((Number(p && p.holdCents) || 0) / 100); }
  function cloudReady() { var c = window.Cloud; try { return !!(c && typeof c.fn === 'function' && typeof c.enabled === 'function' && c.enabled() && typeof c.configured === 'function' && c.configured()); } catch (e) { return false; } }
  function cloudLoc() { try { return String((window.Cloud.get() || {}).locationId || ''); } catch (e) { return ''; } }
  /* Merge into trip.payment — never replace it, so paymentId / holdCents / sourceId from the cloud survive. */
  function setPayment(t, patch) { t.payment = Object.assign({}, t.payment || {}, patch); return t.payment; }
  function undoable(label, fn, t) { if (window.Simple && typeof window.Simple.undoable === 'function') return window.Simple.undoable(label, fn, [t.id]); return fn(); }
  function cutoff30() { var d = new Date(); d.setDate(d.getDate() - 30); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  /* Card no-shows from the last 30 days — the ones the dispatcher may charge, plus the ones already charged (shown with a chip). */
  function noShows() {
    var from = cutoff30();
    return trips().filter(function (t) { return t.status === 'No-Show' && isCard(t) && String(t.date || '') >= from; }).sort(sortNewest);
  }
  function openInvoices() {
    var mp = monthPrefix(), by = {};
    trips().forEach(function (t) {
      if (t.status !== 'Completed' || !isAccountTrip(t) || isInvoiced(t)) return;
      if (String(t.date || '').slice(0, 7) !== mp) return;
      var a = t.accountId ? findAccount(t.accountId) : null;
      var key = t.accountId || '_none';
      if (!by[key]) by[key] = { accountId: t.accountId || '', name: a ? ('#' + (a.number || '') + ' ' + (a.name || '')).trim() : (t.accountId ? 'Account' : 'Account (no account picked)'), count: 0, amount: 0 };
      by[key].count++; by[key].amount = round2(by[key].amount + (Number(t.fare) || 0) + (Number(t.tolls) || 0) + gratuity(t));
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.amount - a.amount; });
  }
  function kpis() {
    var td = todayStr(), booked = 0, card = 0, cash = 0, unpaidAmt = 0, open = 0;
    trips().forEach(function (t) {
      if (t.status === 'Canceled' || t.status === 'Disregard') return;
      if (t.date === td) {
        booked += (Number(t.fare) || 0) + (Number(t.tolls) || 0);
        if (t.status === 'Completed') {
          if (isCard(t) && isPaid(t)) card += total(t);
          if (t.payType === 'Cash') cash += total(t);
        }
      }
    });
    unpaid().forEach(function (t) { unpaidAmt += total(t); });
    openInvoices().forEach(function (a) { open += a.amount; });
    return { booked: round2(booked), card: round2(card), cash: round2(cash), unpaid: round2(unpaidAmt), open: round2(open), unpaidCount: unpaid().length };
  }

  /* ---------- actions ---------- */
  function charge(id) {
    var t = findTrip(id); if (!t) return false;
    var ok = openUrl(vtUrl());
    t.payment = { status: 'pending-vt', at: nowISO() };
    save();
    toast('Enter ' + money(total(t)) + ' in Square, then press Paid' + (ok ? '' : ' (pop-up blocked — open Square from Settings)'), !ok);
    render();
    return ok;
  }
  function paid(id) {
    var t = findTrip(id); if (!t) return false;
    t.payment = { status: 'paid', method: 'card', at: nowISO() };
    save(); toast('#' + (t.dispatchNo || '') + ' marked paid — ' + money(total(t)) + ' by card.'); render();
    return true;
  }
  function cash(id) {
    var t = findTrip(id); if (!t) return false;
    t.payType = 'Cash';
    t.payment = { status: 'paid', method: 'cash', at: nowISO() };
    save(); toast('#' + (t.dispatchNo || '') + ' marked cash — ' + money(total(t)) + '.'); render();
    return true;
  }
  function payLink(id) {
    var t = findTrip(id); if (!t) return false;
    var s = settings(), link = String(s.squarePayLink || '').trim();
    if (!link) {
      var typed = window.prompt('Paste your Square payment link (Square Dashboard → Online → Payment Links). It is saved in Settings for next time.', '');
      if (typed == null) return false;
      link = String(typed).trim();
      if (!/^https?:\/\//i.test(link)) { toast('That is not a web link (it should start with https://).', true); return false; }
      s.squarePayLink = link; save(); syncSettingsField();
    }
    if (!t.phone || !String(t.phone).replace(/\D/g, '')) { toast('No phone number on this trip — add one with Edit first.', true); return false; }
    var body = 'Pay ' + money(total(t)) + ' for your ' + bizName() + ' ride: ' + link;
    var href = smsHref(t.phone, body);
    if (!href) { toast('Could not build a text for ' + t.phone + '.', true); return false; }
    var ok = openHref(href);
    if (!t.payment || t.payment.status !== 'paid') t.payment = { status: 'link-sent', at: nowISO(), link: link };
    save();
    toast(ok ? 'Pay link text opened for ' + (t.passenger || fmtPhone(t.phone)) + ' — ' + money(total(t)) + '.' : 'Could not open your Messages app.', !ok);
    render();
    return ok;
  }
  /* Owner decision 4: no-show fee. Dispatcher-only — this runs from the "Charge no-show fee"
     button and nowhere else (no status hook, no timer). Refuses without a card on file.
     Two steps like "Charge card" → "Paid": this opens Square and records 'noshow-pending';
     noShowPaid() records 'noshow-fee' once the dispatcher saw the charge go through.
     A trip that already carries a Square hold (owner decision 5) is never sent to the Virtual
     Terminal — the fee is captured from that hold instead (see noShowFeeFromHold). */
  function noShowFee(id) {
    var t = findTrip(id); if (!t) return false;
    var no = '#' + (t.dispatchNo || '');
    if (t.status !== 'No-Show') { toast(no + ' is ' + (t.status || 'not a no-show') + ' — the no-show fee is only for No-Show rides.', true); return false; }
    if (!isCard(t)) { toast(no + ' is not a card ride — no no-show fee.', true); return false; }
    if (!hasCard(t)) { toast('No card on file for ' + no + ' — the no-show fee cannot be charged.', true); return false; }
    if (feeCharged(t)) { toast(no + ' already has its no-show fee recorded.', true); return false; }
    var amt = noShowFeeAmount(t);
    if (!(amt > 0)) { toast('No-show fee is zero for ' + no + ' (no base fare).', true); return false; }
    var hold = cloudHold(t);
    if (hold) return noShowFeeFromHold(t, hold, amt);
    if (!window.confirm('Charge the no-show fee of ' + money(amt) + ' (base fare) to the card on file for ' + no + (t.passenger ? ' — ' + t.passenger : '') + '?')) return false;
    var ok = openUrl(vtUrl());
    if (!ok) {   // nothing recorded: the dispatcher never reached Square, so the button stays and the row never says "charged"
      toast('Could not open Square (pop-up blocked) — nothing was recorded for ' + no + '. Allow pop-ups or open Square from Settings, then press the button again.', true);
      render();
      return false;
    }
    undoable('No-show fee ' + money(amt) + ' on ' + no + ' — Square opened', function () {
      setPayment(t, { status: 'noshow-pending', via: 'vt', amount: amt, at: nowISO(), method: 'card', cardOnFile: true });
      save();
    }, t);
    toast('Enter ' + money(amt) + ' in Square for ' + no + ' (no-show fee), then press "Fee paid".');
    render();
    return true;
  }
  /* The passenger's card already holds estimate × 1.2 + tolls (square-charge 'authorize'). Charging the
     Virtual Terminal would be a SECOND charge while the hold sits on the card for up to 7 days, so:
     Cloud on  → square-charge {action:'capture', kind:'noshow_fee', final_cents} completes the hold for the fee
                 (UpdatePayment + CompletePayment) and Square releases the remainder — one charge, no VT.
     Cloud off → tell the dispatcher to complete the hold in Square (payment id shown) and press "Fee paid".
     Returns the capture Promise when Cloud is on, false otherwise. */
  function noShowFeeFromHold(t, hold, amt) {
    var no = '#' + (t.dispatchNo || ''), held = holdAmount(hold);
    var msg = 'Take the no-show fee of ' + money(amt) + ' (base fare) for ' + no + (t.passenger ? ' — ' + t.passenger : '')
      + ' from the ' + money(held) + ' hold already on the card? The rest of the hold is released. The card is not charged a second time.';
    if (!window.confirm(msg)) return false;
    if (!cloudReady()) {
      undoable('No-show fee ' + money(amt) + ' on ' + no + ' — complete the hold in Square', function () {
        setPayment(t, { status: 'noshow-pending', via: 'hold', priorStatus: 'authorized', amount: amt, at: nowISO(), method: 'card', cardOnFile: true });
        save();
      }, t);
      toast('Cloud is off on this station. In Square Dashboard → Transactions, complete the ' + money(held) + ' hold (payment ' + hold.paymentId + ') for ' + money(amt) + ', then press "Fee paid". Do not key the card again.', true);
      render();
      return false;
    }
    setPayment(t, { status: 'noshow-pending', via: 'cloud', priorStatus: 'authorized', amount: amt, at: nowISO(), method: 'card', cardOnFile: true });
    save(); render();
    toast('Taking ' + money(amt) + ' from the hold for ' + no + '…');
    return window.Cloud.fn('square-charge', { action: 'capture', kind: 'noshow_fee', location_id: cloudLoc(), trip_id: String(t.id), final_cents: Math.round(amt * 100), tip_cents: 0 })
      .then(function (res) {
        var cur = findTrip(t.id) || t;
        if (!res || !res.ok) throw new Error((res && res.reason) || 'capture refused');
        setPayment(cur, { status: 'noshow-fee', via: 'cloud', amount: amt, at: nowISO(), method: 'card', cardOnFile: true, paymentId: res.payment_id || cur.payment.paymentId, receiptUrl: res.receipt_url || cur.payment.receiptUrl || null });
        save(); toast('No-show fee ' + money(amt) + ' taken from the hold for ' + no + '. The rest of the hold is released.'); render();
        return true;
      })
      .catch(function (err) {
        var cur = findTrip(t.id) || t;
        if (feePending(cur) && cur.payment.via === 'cloud') { cur.payment = hold; save(); }   // put the authorization back exactly as it was (hold is the untouched prior object)
        toast('Could not take the no-show fee from the hold for ' + no + ': ' + ((err && err.message) || err) + '. Check Needs-you / Square.', true);
        render();
        return false;
      });
  }
  /* Step 2 of the no-show fee: the dispatcher saw the charge go through in Square (or completed the hold there). */
  function noShowPaid(id) {
    var t = findTrip(id); if (!t) return false;
    var no = '#' + (t.dispatchNo || '');
    if (t.status !== 'No-Show' || !isCard(t)) { toast(no + ' is not a card No-Show — nothing to record.', true); return false; }
    if (feeCharged(t)) { toast(no + ' already has its no-show fee recorded.', true); return false; }
    if (!feePending(t) && !hasCard(t)) { toast('No card on file for ' + no + ' — the no-show fee cannot be charged.', true); return false; }
    var amt = (t.payment && Number(t.payment.amount) > 0) ? round2(t.payment.amount) : noShowFeeAmount(t);
    if (!(amt > 0)) { toast('No-show fee is zero for ' + no + ' (no base fare).', true); return false; }
    undoable('No-show fee ' + money(amt) + ' recorded on ' + no, function () {
      setPayment(t, { status: 'noshow-fee', amount: amt, at: nowISO(), method: 'card', cardOnFile: true });
      save();
    }, t);
    toast(no + ' no-show fee ' + money(amt) + ' recorded as charged.');
    render();
    return true;
  }

  /* ---------- styles ---------- */
  function ensureStyle() {
    if (byId('moneyStyle')) return;
    var st = document.createElement('style'); st.id = 'moneyStyle';
    st.textContent = [
      '.mny-panel .stat-row{margin-bottom:10px;}',
      '.mny-panel .stat.mny-warn{border-top-color:#c0392b;} .mny-panel .stat.mny-ok{border-top-color:#1f7a3d;}',
      '.mny-panel .mny-sub{font-size:11px;color:var(--muted,#5b5b5b);margin:0 0 6px;}',
      '.mny-panel .mny-acts{display:flex;flex-wrap:wrap;gap:4px;}',
      '.mny-panel .mny-acts .btn{white-space:nowrap;}',
      '.mny-panel .mny-chip{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:10px;background:rgba(192,57,43,.1);color:#9b2d20;margin-left:6px;white-space:nowrap;}',
      '.mny-panel .mny-chip.vt{background:rgba(214,158,20,.14);color:#7a5a06;} .mny-panel .mny-chip.link{background:rgba(31,122,61,.12);color:#1f7a3d;}',
      '.mny-panel h4{margin:12px 0 4px;font-size:12.5px;color:var(--green-dark,#15497d);}',
      '.mny-panel .mny-inv{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
      '.mny-panel .mny-inv .mny-acct{border:1px solid var(--line,#d4d4d4);border-radius:3px;padding:5px 9px;font-size:12px;background:rgba(120,140,160,.06);}',
      '.mny-panel .mny-inv .mny-acct b{font-family:Consolas,monospace;}',
      '.mny-panel .tbl-scroll{max-height:320px;}',
      'body.gold .mny-panel h4{color:#e8c75a;} body.gold .mny-panel .mny-chip{color:#f0a89f;} body.gold .mny-panel .mny-chip.vt{color:#e8c75a;} body.gold .mny-panel .mny-chip.link{color:#8fd8a4;}',
      'body.classic .mny-panel h4{color:#0a246a;} body.classic .mny-panel .mny-acct{background:#fff;border-radius:0;}',
      'body.classic .mny-panel .panel-head .hint,body.classic .rg-panel .panel-head .hint{color:#dbe4f3;}'
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }

  /* ---------- panel ---------- */
  var PANEL_ID = 'moneyHome';
  function ensurePanel() {
    var view = byId('view-earnings'); if (!view) return null;
    var p = byId(PANEL_ID);
    if (!p) { p = document.createElement('div'); p.id = PANEL_ID; p.className = 'panel mny-panel'; view.insertBefore(p, view.firstChild); p.addEventListener('click', onClick); }
    return p;
  }
  function chip(t) {
    var p = t.payment; if (!p || !p.status) return '';
    if (p.status === 'pending-vt') return '<span class="mny-chip vt" title="Square Virtual Terminal opened ' + esc(fmtWhen(p.at)) + '">in Square ' + esc(fmtWhen(p.at)) + '</span>';
    if (p.status === 'link-sent') return '<span class="mny-chip link" title="Pay link texted ' + esc(fmtWhen(p.at)) + '">link sent ' + esc(fmtWhen(p.at)) + '</span>';
    if (p.status === 'failed') return '<span class="mny-chip">card failed</span>';
    if (p.status === 'authorized') return '<span class="mny-chip link" title="Square is holding ' + esc(money(holdAmount(p))) + ' on the card (payment ' + esc(p.paymentId || '') + ') — the hold releases when a smaller amount is captured">hold ' + esc(money(holdAmount(p))) + '</span>';
    if (p.status === 'noshow-pending') {
      if (p.via === 'cloud') return '<span class="mny-chip vt" title="Taking the no-show fee from the hold ' + esc(fmtWhen(p.at)) + '">taking from hold ' + esc(fmtWhen(p.at)) + '</span>';
      if (p.via === 'hold') return '<span class="mny-chip vt" title="Complete the hold in Square for ' + esc(money(p.amount)) + ', then press Fee paid">complete hold in Square ' + esc(fmtWhen(p.at)) + '</span>';
      return '<span class="mny-chip vt" title="Square Virtual Terminal opened ' + esc(fmtWhen(p.at)) + ' — press Fee paid once the charge went through">in Square ' + esc(fmtWhen(p.at)) + '</span>';
    }
    if (p.status === 'noshow-fee') return '<span class="mny-chip vt" title="No-show fee ' + esc(money(p.amount)) + ' charged ' + esc(fmtWhen(p.at)) + '">fee ' + esc(money(p.amount)) + ' ' + esc(fmtWhen(p.at)) + '</span>';
    if (p.status === 'paid' && t.status === 'No-Show') { var amt = p.amount != null ? p.amount : (Number(p.amountCents) || 0) / 100; return '<span class="mny-chip vt" title="No-show fee charged ' + esc(fmtWhen(p.paidAt || p.at)) + '">fee ' + esc(money(amt)) + '</span>'; }
    return '';
  }
  function noShowRows(list) {
    var h = '<div class="tbl-scroll"><table class="data" id="mny_noshow"><thead><tr><th>#</th><th>When</th><th>Passenger</th><th>Route</th><th class="num">Fee</th><th>No-show fee</th></tr></thead><tbody>';
    list.forEach(function (t) {
      var whenTxt = (t.date === todayStr() ? 'Today' : esc(t.date || '')) + (t.time ? ' ' + esc(fmtTime12(t.time)) : '');
      var card = hasCard(t), done = feeCharged(t), pend = feePending(t), hold = cloudHold(t), amt = noShowFeeAmount(t);
      var btn;
      if (done) btn = '<span class="hint" style="margin:0;">charged</span>';
      else if (!card) btn = '<button class="btn btn-ghost btn-sm" type="button" disabled title="No card on file">Charge no-show fee</button>';
      else {
        var title = hold
          ? 'Take ' + money(amt) + ' from the ' + money(holdAmount(hold)) + ' hold already on the card — the rest is released, the card is not charged twice. Dispatcher only, never automatic'
          : 'Open Square to charge the base fare (' + money(amt) + ') to the card on file — dispatcher only, never automatic';
        btn = '<button class="btn btn-navy btn-sm" type="button" data-act="noshow" data-id="' + esc(t.id) + '" title="' + esc(title) + '">' + (hold ? 'Take fee from hold' : (pend ? 'Open Square again' : 'Charge no-show fee')) + '</button>';
        if (pend) btn += '<button class="btn btn-go btn-sm" type="button" data-act="noshowpaid" data-id="' + esc(t.id) + '" title="The no-show fee went through in Square — record it as charged">Fee paid</button>';
      }
      h += '<tr data-trip="' + esc(t.id) + '"><td>' + esc(t.dispatchNo || '') + '</td><td>' + whenTxt + '</td>'
        + '<td>' + esc(t.passenger || '—') + (t.phone ? '<div class="hint" style="margin:0;">' + esc(fmtPhone(t.phone)) + '</div>' : '') + '</td>'
        + '<td>' + esc(shortAddr(t.puAddr)) + ' &rarr; ' + esc(shortAddr(t.doAddr)) + chip(t) + '</td>'
        + '<td class="num"><b>' + esc(money(amt)) + '</b><div class="hint" style="margin:0;">base fare</div></td>'
        + '<td><div class="mny-acts">' + btn + '</div></td></tr>';
    });
    return h + '</tbody></table></div>';
  }
  function tile(v, k, cls) { return '<div class="stat' + (cls ? ' ' + cls : '') + '"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>'; }
  function render() {
    var panel = ensurePanel(); if (!panel) return;
    ensureStyle();
    var k = kpis(), rows = unpaid(), inv = openInvoices();
    var h = '<div class="panel-head">Today\'s money <span class="hint" style="margin:0;font-weight:400;">' + esc(todayStr()) + ' &middot; card rides collect through Square</span></div><div class="panel-body">';
    h += '<div class="stat-row" id="mny_kpis">' + tile(money(k.booked), 'Booked today') + tile(money(k.card), 'Collected card today', 'mny-ok') + tile(money(k.cash), 'Cash today') + tile(money(k.unpaid), 'Unpaid card (' + k.unpaidCount + ')', k.unpaid > 0 ? 'mny-warn' : '') + tile(money(k.open), 'Open account (this month)') + '</div>';
    h += '<h4>Unpaid rides <span class="hint" style="margin:0;font-weight:400;">&mdash; completed card rides not yet collected</span></h4>';
    if (!rows.length) h += '<div class="empty" id="mny_unpaid_empty">All card rides are collected. Nothing to charge.</div>';
    else {
      h += '<div class="tbl-scroll"><table class="data" id="mny_unpaid"><thead><tr><th>#</th><th>When</th><th>Passenger</th><th>Route</th><th class="num">Total</th><th>Collect</th></tr></thead><tbody>';
      rows.forEach(function (t) {
        var whenTxt = (t.date === todayStr() ? 'Today' : esc(t.date || '')) + (t.time ? ' ' + esc(fmtTime12(t.time)) : '');
        h += '<tr data-trip="' + esc(t.id) + '"><td>' + esc(t.dispatchNo || '') + '</td><td>' + whenTxt + '</td>'
          + '<td>' + esc(t.passenger || '—') + (t.phone ? '<div class="hint" style="margin:0;">' + esc(fmtPhone(t.phone)) + '</div>' : '') + '</td>'
          + '<td>' + esc(shortAddr(t.puAddr)) + ' &rarr; ' + esc(shortAddr(t.doAddr)) + chip(t) + '</td>'
          + '<td class="num"><b>' + esc(money(total(t))) + '</b>' + (cardFee(t) ? '<div class="hint" style="margin:0;">incl. ' + esc(money(cardFee(t))) + ' card fee</div>' : '') + '</td>'
          + '<td><div class="mny-acts">'
          + '<button class="btn btn-navy btn-sm" type="button" data-act="charge" data-id="' + esc(t.id) + '" title="Open the Square Virtual Terminal to key in the card">Charge card</button>'
          + '<button class="btn btn-go btn-sm" type="button" data-act="paid" data-id="' + esc(t.id) + '" title="The card went through — mark collected">Paid</button>'
          + '<button class="btn btn-ghost btn-sm" type="button" data-act="cash" data-id="' + esc(t.id) + '" title="Passenger paid cash instead">Mark cash</button>'
          + '<button class="btn btn-ghost btn-sm" type="button" data-act="link" data-id="' + esc(t.id) + '" title="Text the passenger a Square pay link">Send pay link</button>'
          + '</div></td></tr>';
      });
      h += '</tbody></table></div>';
    }
    var ns = noShows();
    if (ns.length) {
      h += '<h4>No-shows <span class="hint" style="margin:0;font-weight:400;">&mdash; card rides where the rider never appeared (last 30 days). Fee = base fare, only with a card on file, only when you press the button.</span></h4>';
      h += noShowRows(ns);
    }
    h += '<h4>Open invoices <span class="hint" style="margin:0;font-weight:400;">&mdash; account rides this month not yet invoiced</span></h4>';
    if (!inv.length) h += '<div class="hint" id="mny_inv_empty" style="margin:0 0 4px;">No account rides waiting for an invoice this month.</div>';
    else {
      h += '<div class="mny-inv" id="mny_inv">' + inv.map(function (a) { return '<span class="mny-acct">' + esc(a.name) + ' &middot; ' + a.count + ' ride' + (a.count === 1 ? '' : 's') + ' &middot; <b>' + esc(money(a.amount)) + '</b></span>'; }).join('')
        + '<button class="btn btn-navy btn-sm" type="button" data-act="invoicing" id="mny_go_inv">Open Invoicing &rarr;</button></div>';
    }
    h += '</div>';
    panel.innerHTML = h;
  }
  function onClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null; if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    try {
      if (a === 'charge') charge(id);
      else if (a === 'paid') paid(id);
      else if (a === 'cash') cash(id);
      else if (a === 'link') payLink(id);
      else if (a === 'noshow') noShowFee(id);
      else if (a === 'noshowpaid') noShowPaid(id);
      else if (a === 'invoicing') { if (typeof window.goTab === 'function') window.goTab('invoicing'); }
    } catch (err) { try { console.error('[money]', err); } catch (e2) {} }
  }

  /* ---------- settings field (Square pay link) ---------- */
  function settingsFieldHtml() {
    return '<div class="grid2" id="mny_settings"><label class="fld"><span class="lbl">Square payment link (for "Send pay link" texts)</span><input type="text" id="s_squarePayLink" placeholder="https://square.link/u/…" autocomplete="off"></label>'
      + '<label class="fld"><span class="lbl">&nbsp;</span><button class="btn btn-navy" type="button" id="s_squarePayLink_save">Save pay link</button></label></div>'
      + '<div class="hint" style="margin:0;">Make one Square payment link that lets the customer type the amount (Square Dashboard &rarr; Online &rarr; Payment Links &rarr; "Collect a payment"). The Virtual Terminal link above stays as the manual fallback for keyed-in cards.</div>';
  }
  function syncSettingsField() { var el = byId('s_squarePayLink'); if (el) el.value = settings().squarePayLink || ''; }
  function renderSettingsField() {
    var slot = byId('rg_extra'), host = slot;
    if (!host) {
      var view = byId('view-settings'); if (!view) return;
      host = byId('moneySettings');
      if (!host) { host = document.createElement('div'); host.id = 'moneySettings'; host.className = 'panel mny-panel'; view.appendChild(host); }
      host.innerHTML = '<div class="panel-head">Money</div><div class="panel-body">' + settingsFieldHtml() + '</div>';
    } else {
      if (!byId('mny_settings')) slot.insertAdjacentHTML('beforeend', settingsFieldHtml());
    }
    syncSettingsField();
    var bs = byId('s_squarePayLink_save');
    if (bs && !bs.__wired) {
      bs.__wired = true;
      bs.addEventListener('click', act(function () {
        var v = String((byId('s_squarePayLink') || {}).value || '').trim();
        if (v && !/^https?:\/\//i.test(v)) { toast('The pay link should start with https://', true); return; }
        settings().squarePayLink = v; save(); toast(v ? 'Square pay link saved.' : 'Square pay link cleared.');
      }));
    }
  }

  /* ---------- hooks ---------- */
  function hook(name, after) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__moneyWrapped) return;
    var wrapped = function () { var out; try { out = orig.apply(this, arguments); } finally { try { after(); } catch (e) {} } return out; };
    wrapped.__moneyWrapped = true;
    window[name] = wrapped;
  }
  function earningsActive() { var v = byId('view-earnings'); return !!(v && v.classList.contains('active')); }

  /* ---------- public API ---------- */
  window.Money = { render: render, unpaid: unpaid, total: total, gratuity: gratuity, kpis: kpis, openInvoices: openInvoices, charge: charge, paid: paid, cash: cash, payLink: payLink, noShows: noShows, noShowFeeAmount: noShowFeeAmount, hasCard: hasCard, noShowFee: noShowFee, noShowPaid: noShowPaid, renderSettings: renderSettingsField };

  /* ---------- settings defaults (owner decisions 4) — saved only when they were missing ---------- */
  function ensureDefaults() {
    var s = settings(), dirty = false;
    if (s.autoGratuityPct == null) { s.autoGratuityPct = 0; dirty = true; }            // no automatic gratuity until accounts ask
    if (!s.noShowFee || typeof s.noShowFee !== 'object') { s.noShowFee = { mode: 'base' }; dirty = true; }   // no-show fee = base fare
    if (dirty) save();
  }

  /* ---------- boot ---------- */
  function boot() {
    try { ensureStyle(); } catch (e) {}
    try { ensureDefaults(); } catch (e) {}
    if (settings().squarePayLink == null) settings().squarePayLink = '';
    hook('refreshBoard', function () { if (earningsActive()) render(); });
    hook('renderEarnings', render);
    hook('renderSettings', renderSettingsField);
    try { render(); } catch (e) {}
    try { renderSettingsField(); } catch (e) {}
    document.addEventListener('region:rendered', function () { try { renderSettingsField(); } catch (e) {} });
    document.addEventListener('region:changed', function () { try { render(); } catch (e) {} });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
