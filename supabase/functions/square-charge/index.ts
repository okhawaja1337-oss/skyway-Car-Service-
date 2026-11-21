// square-charge — card on file: hold at booking, charge at drop-off, refund (PRODUCT-DESIGN.md §6).
//
// POST { action: "authorize", location_id, trip_id }
//      CreatePayment {autocomplete:false, amount = estimate × holdFactor + tolls, idempotency_key = trip.id+':auth'}
//      Owner decision 5: hold the estimate + 20 % (settings.holdFactor, default 1.2, clamped 1.0–1.5).
//      The hold is released automatically when the final charge is smaller — see "capture".
//      WIRING STATUS: the hook is ready but NOTHING CALLS IT YET. No console module, trigger or cron
//      invokes {action:"authorize"} when a card ride is saved (nor "capture" on Completed); today it is
//      only reachable by a manual POST. The booking flow (index.html / sync.js) owns that call —
//      Cloud.fn('square-charge', {action:'authorize', location_id, trip_id}) on save of a Credit Card
//      trip with a card on file, and 'capture' on Completed. Until then: holds are NOT live in the pilot.
// POST { action: "capture", location_id, trip_id, tip_cents?: 0, final_cents?: <override>, kind?: "noshow_fee" }
//      final = fare + tolls + waitFee + stopFee×stops + ccu (accounts) + autoGratuity%
//      Owner decision 4: autoGratuity% is 0 unless an account asked for it —
//      accounts.body.autoGratuityPct overrides settings.autoGratuityPct; both default 0.
//      ≤ hold → UpdatePayment(amount, tip) + CompletePayment; > hold → CancelPayment + CreatePayment{autocomplete:true}
//      failure → trips.body.payment.status='failed', square-link, Needs-you
//      kind:"noshow_fee" (owner decision 4): sent ONLY by the dispatcher's "Take fee from hold" button in the
//      console's Money panel (money.js) for a No-Show card trip that already carries a hold. final = the base fare
//      (or final_cents), tip 0 → the hold is completed for the fee and Square releases the rest; the trip gets
//      payment.status='noshow-fee' (not 'paid'), payments.kind='noshow_fee', no pay-link text on failure.
//      No-show fees are never charged by this function on its own (no trigger, no cron).
// POST { action: "charge", location_id, trip_id, amount_cents, tip_cents?, source_id? }  (no prior hold; pay.html tips)
// POST { action: "refund", location_id, trip_id, amount_cents, reason }
// → { ok, payment_id, status, amount_cents, ... }
//
// Card tokens never pass through here: `source_id` is a Square card-on-file id (ccof:…) stored on
// passengers.cards[] / accounts, or a Web Payments SDK nonce produced in the browser.
import { admin, functionsBaseUrl, getLocation, getTrip, json, Json, patchTripBody, raiseNeedsYou, readJson, requireStr, serve, audit } from "../_shared/db.ts";
import { cancelPayment, completePayment, createPayment, money, refundPayment, updatePayment } from "../_shared/square.ts";

interface Body extends Json {
  action: "authorize" | "capture" | "charge" | "refund";
  location_id: string;
  trip_id: string;
  tip_cents?: number;
  final_cents?: number;
  amount_cents?: number;
  source_id?: string;
  reason?: string;
  kind?: "noshow_fee";
}

// Owner decision 5 (accepted default): hold the estimate + 20 % on card rides. `settings.holdFactor`
// can change it later without a deploy; anything outside 1.0–1.5 falls back to the clamp edge.
const HOLD_FACTOR = 1.2;
const HOLD_FACTOR_MIN = 1.0, HOLD_FACTOR_MAX = 1.5;

function cents(n: unknown): number { return Math.round((Number(n) || 0) * 100); }

/** Hold multiplier for `authorize`: settings.holdFactor (number) clamped to 1.0–1.5, default HOLD_FACTOR. */
function holdFactor(settings: Json): number {
  const n = Number(settings.holdFactor);
  if (!Number.isFinite(n) || n <= 0) return HOLD_FACTOR;
  return Math.min(HOLD_FACTOR_MAX, Math.max(HOLD_FACTOR_MIN, n));
}

/** Owner decision 4: automatic gratuity only on Account rides, per-account override first, otherwise the
 *  location setting; both default 0 (no automatic gratuity until an account asks). Clamped 0–100. */
function gratuityPct(trip: Json, settings: Json, account: Json | null): number {
  if (trip.payType !== "Account") return 0;
  const own = account ? Number(account.autoGratuityPct) : NaN;
  const pct = Number.isFinite(own) ? own : Number(settings.autoGratuityPct) || 0;
  return Math.min(100, Math.max(0, pct));
}

/** settings.body for the location ({} when none). */
async function loadSettings(locId: string): Promise<Json> {
  const { data } = await admin().from("settings").select("body").eq("id", locId).maybeSingle();
  return ((data as { body: Json } | null)?.body) || {};
}

/** accounts.body for the trip's account (null for non-account trips). */
async function loadAccount(trip: Json): Promise<Json | null> {
  if (trip.payType !== "Account" || !trip.accountId) return null;
  const { data } = await admin().from("accounts").select("body").eq("id", String(trip.accountId)).maybeSingle();
  return ((data as { body: Json } | null)?.body) || null;
}

/** Card on file for the trip: passenger (by phone) first, then the account. */
async function cardFor(locId: string, trip: Json): Promise<{ sourceId: string; customerId: string } | null> {
  const db = admin();
  const pay = (trip.payment as Json) || {};
  if (pay.sourceId && pay.customerId) return { sourceId: String(pay.sourceId), customerId: String(pay.customerId) };
  const phone = String(trip.phone || "").replace(/[^0-9+]/g, "");
  if (phone) {
    const { data } = await db.from("passengers").select("square_customer_id,body").eq("location_id", locId).ilike("phone_e164", `%${phone.slice(-10)}`).maybeSingle();
    const p = data as { square_customer_id: string | null; body: Json } | null;
    const cards = (p?.body.cards as { squareCardId: string }[]) || [];
    if (p?.square_customer_id && cards[0]) return { sourceId: cards[0].squareCardId, customerId: p.square_customer_id };
  }
  if (trip.accountId) {
    const { data } = await db.from("accounts").select("square_customer_id,body").eq("id", String(trip.accountId)).maybeSingle();
    const a = data as { square_customer_id: string | null; body: Json } | null;
    const cards = (a?.body.cards as { squareCardId: string }[]) || [];
    if (a?.square_customer_id && cards[0]) return { sourceId: cards[0].squareCardId, customerId: a.square_customer_id };
  }
  return null;
}

/** Final amount at drop-off in cents (mirrors the console's Money panel math). */
function finalCents(trip: Json, settings: Json, rate: Json, account: Json | null): number {
  const fare = cents(trip.fare), tolls = cents(trip.tolls);
  const waitMin = Number(trip.waitMin) || 0, freeWait = Number(rate.freeWaitMin ?? 10), perMin = cents(rate.waitPerMin ?? 0);
  const waitFee = Math.max(0, waitMin - freeWait) * perMin;
  const stops = Array.isArray(trip.stops) ? trip.stops.length : 0, stopFee = stops * cents(rate.stopFee ?? 0);
  const ccu = trip.payType === "Account" || trip.payType === "Credit Card" ? cents(settings.ccu ?? 0) + Math.round(fare * (Number(settings.cardPct) || 0) / 100) : 0;
  const grat = Math.round(fare * gratuityPct(trip, settings, account) / 100);   // 0 by default (owner decision 4)
  return fare + tolls + waitFee + stopFee + ccu + grat;
}

async function recordPayment(row: Json): Promise<void> {
  const { error } = await admin().from("payments").upsert(row, { onConflict: "id" });
  if (error) console.error("payments upsert failed", error.message);
}

serve(async (req) => {
  const body = await readJson<Body>(req, ["action", "location_id", "trip_id"]);
  const loc = await getLocation(requireStr(body.location_id, "location_id"));
  const trip = await getTrip(requireStr(body.trip_id, "trip_id"));
  if (trip.location_id !== loc.id) return json({ error: "trip belongs to another location" }, 403);
  const currency = loc.currency || "USD";
  const sqLoc = loc.square_location_id || undefined;
  const t = trip.body;
  const payment = (t.payment as Json) || {};
  const route = `${t.puAddr || ""} → ${t.doAddr || ""}`.slice(0, 500);
  const ref = String(t.dispatchNo || trip.id);

  if (body.action === "authorize") {
    if (t.payType !== "Credit Card") return json({ ok: false, reason: "not a card trip" });
    if (payment.status === "authorized" || payment.status === "paid" || payment.status === "noshow-fee") return json({ ok: true, reason: `already ${payment.status}`, payment_id: payment.paymentId });
    const card = body.source_id ? { sourceId: body.source_id, customerId: String(payment.customerId || "") } : await cardFor(loc.id, t);
    if (!card) {
      await raiseNeedsYou({ location_id: loc.id, kind: "no_card", trip_id: trip.id, note: `#${ref}: card ride but no card on file — add a card or send a pay link.` });
      return json({ ok: false, reason: "no card on file" });
    }
    const factor = holdFactor(await loadSettings(loc.id));
    const hold = Math.round(cents(t.fare) * factor) + cents(t.tolls);
    try {
      const { payment: p } = await createPayment({ idempotencyKey: `${trip.id}:auth`, amount: money(hold, currency), sourceId: card.sourceId, customerId: card.customerId || undefined, locationId: sqLoc, autocomplete: false, referenceId: ref, note: route });
      const next = { ...payment, status: "authorized", paymentId: p.id, holdCents: hold, currency, sourceId: card.sourceId, customerId: card.customerId, authorizedAt: new Date().toISOString() };
      await patchTripBody(trip.id, { payment: next });
      await recordPayment({ id: p.id, location_id: loc.id, trip_id: trip.id, kind: "auth", amount: hold, currency, status: String(p.status), body: p });
      await audit(loc.id, "square_authorized", { trip_id: trip.id, body: { hold, factor } });
      return json({ ok: true, payment_id: p.id, status: p.status, amount_cents: hold });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await patchTripBody(trip.id, { payment: { ...payment, status: "failed", error: msg, failedAt: new Date().toISOString() } });
      await raiseNeedsYou({ location_id: loc.id, kind: "card_declined", trip_id: trip.id, note: `#${ref}: card hold failed (${msg}) — before the car rolls.` });
      return json({ ok: false, reason: msg }, 402);
    }
  }

  if (body.action === "capture") {
    // Owner decision 4: the no-show fee is dispatcher-only. This flag arrives from the console button, never from a trigger.
    const noShow = body.kind === "noshow_fee";
    if (noShow && t.status !== "No-Show") return json({ error: "kind noshow_fee is only for No-Show trips" }, 400);
    if (noShow && t.payType !== "Credit Card") return json({ error: "kind noshow_fee is only for card trips" }, 400);
    const settings = await loadSettings(loc.id);
    const rate = (settings.rate as Json) || {};
    const account = noShow ? null : await loadAccount(t);
    const finalC = body.final_cents != null ? Math.round(Number(body.final_cents)) : noShow ? cents(t.fare) : finalCents(t, settings, rate, account);
    const tipC = noShow ? 0 : Math.max(0, Math.round(Number(body.tip_cents) || cents(t.tip)));
    if (payment.status === "paid" || payment.status === "noshow-fee") return json({ ok: true, reason: `already ${payment.status}`, payment_id: payment.paymentId });
    if (noShow && finalC <= 0) return json({ error: "no-show fee is zero (no base fare)" }, 400);
    const holdC = Number(payment.holdCents) || 0;
    // The console marks a no-show fee 'noshow-pending' (priorStatus 'authorized') before this call and sync may
    // push that first — the hold is still open in Square, so treat it exactly like 'authorized' here.
    const held = !!payment.paymentId && (payment.status === "authorized" || (payment.status === "noshow-pending" && payment.priorStatus === "authorized"));
    try {
      let p: Json;
      if (held && finalC + tipC <= holdC) {
        // Hold release (owner decision 5): the authorization was for estimate × holdFactor + tolls. We first
        // UpdatePayment to the smaller final amount (+ tip) and then CompletePayment — Square captures only that
        // amount and releases the remainder of the hold back to the passenger's card automatically (a partial
        // capture; no separate refund or void call is needed). Equal amounts simply capture the whole hold.
        await updatePayment(String(payment.paymentId), `${trip.id}:update:${finalC}:${tipC}`, money(finalC, currency), tipC ? money(tipC, currency) : undefined);
        p = (await completePayment(String(payment.paymentId))).payment;
      } else {
        // Final > hold (or no hold): void the authorization — which releases it in full — and charge the card again.
        if (held) await cancelPayment(String(payment.paymentId)).catch(() => undefined);
        const card = body.source_id ? { sourceId: body.source_id, customerId: String(payment.customerId || "") } : await cardFor(loc.id, t);
        if (!card) throw new Error("no card on file");
        p = (await createPayment({ idempotencyKey: `${trip.id}:capture:${finalC}:${tipC}`, amount: money(finalC, currency), tip: tipC ? money(tipC, currency) : undefined, sourceId: card.sourceId, customerId: card.customerId || undefined, locationId: sqLoc, autocomplete: true, referenceId: ref, note: route })).payment;
      }
      const now = new Date().toISOString();
      // The no-show fee keeps its own status so the console's Money panel shows "fee $X" (money.js chip) and
      // the fee is never mistaken for a completed ride's payment; the hold's paymentId stays on the record.
      const next = noShow
        ? { ...payment, status: "noshow-fee", paymentId: p.id, amount: finalC / 100, amountCents: finalC, tipCents: 0, currency, at: now, paidAt: now, method: "card", cardOnFile: true, via: "cloud", receiptUrl: p.receipt_url || null }
        : { ...payment, status: "paid", paymentId: p.id, amountCents: finalC, tipCents: tipC, currency, paidAt: now, receiptUrl: p.receipt_url || null };
      await patchTripBody(trip.id, noShow ? { payment: next } : { payment: next, tip: tipC / 100 });
      await recordPayment({ id: p.id, location_id: loc.id, trip_id: trip.id, kind: noShow ? "noshow_fee" : "capture", amount: finalC, tip: tipC, currency, status: String(p.status), receipt_url: p.receipt_url || null, body: p });
      await audit(loc.id, noShow ? "square_noshow_fee" : "square_captured", { trip_id: trip.id, actor: noShow ? "dispatcher" : undefined, body: { finalC, tipC, holdC } });
      return json({ ok: true, payment_id: p.id, status: p.status, amount_cents: finalC, tip_cents: tipC, receipt_url: p.receipt_url || null, kind: noShow ? "noshow_fee" : "capture" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await patchTripBody(trip.id, { payment: { ...payment, status: "failed", error: msg, failedAt: new Date().toISOString(), amountCents: finalC } });
      if (noShow) {
        // A failed no-show fee is a dispatcher matter — no pay-link text to a passenger who never showed.
        await raiseNeedsYou({ location_id: loc.id, kind: "noshow_fee_failed", trip_id: trip.id, note: `#${ref}: no-show fee of ${(finalC / 100).toFixed(2)} could not be taken from the hold (${msg}).` });
        return json({ ok: false, reason: msg }, 402);
      }
      await raiseNeedsYou({ location_id: loc.id, kind: "charge_failed", trip_id: trip.id, note: `#${ref}: charge of ${(finalC / 100).toFixed(2)} failed (${msg}) — pay link sent automatically.` });
      await fetch(`${functionsBaseUrl()}/square-link`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` }, body: JSON.stringify({ location_id: loc.id, trip_id: trip.id, amount_cents: finalC, send_text: true }) }).catch(() => undefined);
      return json({ ok: false, reason: msg }, 402);
    }
  }

  if (body.action === "charge") {
    const amountC = Math.round(Number(body.amount_cents) || 0);
    const tipC = Math.max(0, Math.round(Number(body.tip_cents) || 0));
    if (amountC + tipC <= 0) return json({ error: "amount_cents or tip_cents required" }, 400);
    const card = body.source_id ? { sourceId: body.source_id, customerId: String(payment.customerId || "") } : await cardFor(loc.id, t);
    if (!card) return json({ ok: false, reason: "no card on file" }, 402);
    const { payment: p } = await createPayment({ idempotencyKey: `${trip.id}:charge:${amountC}:${tipC}:${body.source_id || "cof"}`, amount: money(amountC, currency), tip: tipC ? money(tipC, currency) : undefined, sourceId: card.sourceId, customerId: card.customerId || undefined, locationId: sqLoc, autocomplete: true, referenceId: ref, note: route });
    const kind = amountC === 0 ? "tip" : "capture";
    await recordPayment({ id: p.id, location_id: loc.id, trip_id: trip.id, kind, amount: amountC, tip: tipC, currency, status: String(p.status), receipt_url: p.receipt_url || null, body: p });
    const patch: Json = kind === "tip" ? { tip: (Number(t.tip) || 0) + tipC / 100 } : { payment: { ...payment, status: "paid", paymentId: p.id, amountCents: amountC, tipCents: tipC, currency, paidAt: new Date().toISOString(), receiptUrl: p.receipt_url || null }, tip: tipC / 100 };
    await patchTripBody(trip.id, patch);
    return json({ ok: true, payment_id: p.id, status: p.status, kind });
  }

  if (body.action === "refund") {
    const amountC = Math.round(Number(body.amount_cents) || 0);
    if (!payment.paymentId || payment.status !== "paid") return json({ error: "trip has no completed payment to refund" }, 400);
    if (amountC <= 0) return json({ error: "amount_cents required" }, 400);
    const reason = String(body.reason || "dispatcher refund").slice(0, 192);
    const { refund } = await refundPayment(String(payment.paymentId), `${trip.id}:refund:${amountC}:${reason}`, money(amountC, currency), reason);
    await recordPayment({ id: refund.id, location_id: loc.id, trip_id: trip.id, kind: "refund", amount: -amountC, currency, status: String(refund.status), body: refund });
    await patchTripBody(trip.id, { payment: { ...payment, refundedCents: (Number(payment.refundedCents) || 0) + amountC, refundReason: reason, status: amountC >= Number(payment.amountCents || 0) ? "refunded" : "paid" } });
    await audit(loc.id, "square_refund", { trip_id: trip.id, actor: "dispatcher", body: { amountC, reason } });
    return json({ ok: true, refund_id: refund.id, status: refund.status });
  }

  return json({ error: "action must be authorize | capture | charge | refund" }, 400);
});
