// offer-job — the 90-second offer cascade (PRODUCT-DESIGN.md §4 "Offers and status").
//
// POST { action: "offer",   location_id, trip_id, ranked: [{driver_id, reason}], offer_seconds?: 90 }
//      → writes offers row for rank 0, trips.stage='offered', texts (+push) the driver
// POST { action: "respond", location_id, offer_id, driver_id, response: "accept"|"decline", channel?: "app"|"sms" }
//      → accept: trips.driverId + stage 'assigned' (→ status 'Dispatched' by trigger), other offers closed,
//                `notify` template "assigned";  decline: next driver is offered
// POST { action: "expire",  location_id? }      ← pg_cron every 15 s (or the console's tick)
//      → expired offers without a response → 'expired' → next driver; nobody left → Needs-you
// POST { action: "stop",    location_id, trip_id }  ← dispatcher stops the cascade
//
// The ranking comes from the console's Driver IQ (passed in `ranked`) so the ranking code stays in the browser.
import { admin, audit, functionsBaseUrl, getLocation, getTrip, insertMessage, json, Json, patchTripBody, publicBaseUrl, raiseNeedsYou, readJson, requireStr, serve, setTripStage, shortToken, toE164 } from "../_shared/db.ts";
import { sendSms } from "../_shared/twilio.ts";
import { loadTemplates, render, tripVars } from "../_shared/templates.ts";

interface Body extends Json {
  action: "offer" | "respond" | "expire" | "stop";
  location_id?: string;
  trip_id?: string;
  ranked?: { driver_id: string; reason?: string }[];
  offer_seconds?: number;
  offer_id?: string;
  driver_id?: string;
  response?: "accept" | "decline";
  channel?: string;
}

interface OfferRow { id: string; location_id: string; trip_id: string; driver_id: string; rank: number; reason: string | null; expires_at: string; response: string | null; body: Json }

async function sendOffer(locId: string, tripId: string, rank: number, driverId: string, reason: string | undefined, seconds: number, cascade: { driver_id: string; reason?: string }[]): Promise<OfferRow> {
  const db = admin();
  const loc = await getLocation(locId);
  const trip = await getTrip(tripId);
  const token = shortToken(4);
  const expires_at = new Date(Date.now() + seconds * 1000).toISOString();
  const { data: offer, error } = await db.from("offers").insert({ location_id: locId, trip_id: tripId, driver_id: driverId, rank, reason: reason || null, expires_at, channel: "sms+push", body: { token, cascade } }).select("*").single();
  if (error) throw new Error(error.message);
  await patchTripBody(tripId, { stage: trip.stage && trip.stage !== "booked" ? trip.stage : "offered", offer: { id: (offer as OfferRow).id, driverId, rank, expiresAt: expires_at, cascade } });
  await audit(locId, "offer_sent", { trip_id: tripId, driver_id: driverId, body: { rank, reason } });

  const [{ data: drv }, { data: settingsRow }, templates] = await Promise.all([
    db.from("drivers").select("phone_e164,body").eq("id", driverId).maybeSingle(),
    db.from("settings").select("body").eq("id", locId).maybeSingle(),
    loadTemplates(locId),
  ]);
  const driver = drv as { phone_e164: string | null; body: Json } | null;
  const to = toE164(driver?.phone_e164 || (driver?.body.phone as string), loc.phone_cc || "+1");
  const base = publicBaseUrl();
  const vars = tripVars({ trip: trip.body, location: loc, settings: ((settingsRow as { body: Json } | null)?.body) || {}, driver: driver?.body || null, extra: { jobUrl: base ? `${base}/j/${token}` : "", offerSeconds: seconds } });
  // Owner decision 6 (default): drivers DO see the fare on offers; Account rides read "Account — no cash".
  // The PAY TYPE governs: an account customer's ride that dispatch switched to Cash / Credit Card (the console's
  // edit-order Payment select allows it, and Earnings / cash_collected are pay-type based) must still read as a
  // cash fare so the driver collects it. The account is only the fallback when the pay type is blank or says
  // "account" in any spelling. Same rule as driver.js fareLine() and driver-link.js isAccountRide().
  const payType = String(trip.pay_type || trip.body.payType || "").trim();
  const onAccount = /account/i.test(payType) || (!payType && !!(trip.account_id || trip.body.accountId));
  vars.fareOrAccount = onAccount ? "Account — no cash" : `${String(vars.fare)} + tolls`;
  if (to) {
    try {
      const sms = await sendSms({ to, body: render(templates.driverJob, vars), messagingServiceSid: loc.twilio_messaging_sid || undefined, statusCallback: `${functionsBaseUrl()}/sms-status` });
      await insertMessage({ location_id: locId, direction: "out", to_e164: to, trip_id: tripId, driver_id: driverId, template: "driverJob", twilio_sid: sms.sid, status: sms.status, text_body: render(templates.driverJob, vars), body: { offer_id: (offer as OfferRow).id } });
    } catch (e) {
      console.error("offer SMS failed", e instanceof Error ? e.message : e);
    }
  }
  // TODO(Phase 2): Web Push via device_sessions.push_subscription (VAPID); Phase 7: FCM/APNs
  return offer as OfferRow;
}

async function nextInCascade(offer: OfferRow): Promise<"offered" | "exhausted"> {
  const cascade = ((offer.body.cascade as { driver_id: string; reason?: string }[]) || []);
  const next = cascade[offer.rank + 1];
  const trip = await getTrip(offer.trip_id);
  if (trip.stage === "assigned" || trip.driver_id) return "exhausted";   // someone already took it (dispatcher assigned by hand)
  if (!next) {
    await patchTripBody(offer.trip_id, { stage: "booked", offer: null });
    await raiseNeedsYou({ location_id: offer.location_id, kind: "no_driver", trip_id: offer.trip_id, note: `Nobody accepted #${trip.dispatch_no} — ${cascade.length} driver(s) offered. Assign by hand.` });
    return "exhausted";
  }
  const seconds = Math.max(15, Math.round((new Date(offer.expires_at).getTime() - new Date((offer.body.sent_at as string) || 0).getTime()) / 1000)) || 90;
  await sendOffer(offer.location_id, offer.trip_id, offer.rank + 1, next.driver_id, next.reason, Number(offer.body.seconds) || seconds, cascade);
  return "offered";
}

serve(async (req) => {
  const body = await readJson<Body>(req, ["action"]);
  const db = admin();

  if (body.action === "offer") {
    const locId = requireStr(body.location_id, "location_id");
    const tripId = requireStr(body.trip_id, "trip_id");
    const ranked = Array.isArray(body.ranked) ? body.ranked.filter((r) => r && r.driver_id) : [];
    if (!ranked.length) return json({ error: "ranked must list at least one driver" }, 400);
    const seconds = Math.min(600, Math.max(15, Number(body.offer_seconds) || 90));
    // close any open offer on this trip first
    await db.from("offers").update({ response: "superseded", responded_at: new Date().toISOString() }).eq("trip_id", tripId).is("response", null);
    const offer = await sendOffer(locId, tripId, 0, ranked[0].driver_id, ranked[0].reason, seconds, ranked);
    await db.from("offers").update({ body: { ...offer.body, seconds, sent_at: new Date().toISOString() } }).eq("id", offer.id);
    return json({ ok: true, offer_id: offer.id, driver_id: ranked[0].driver_id, expires_at: offer.expires_at });
  }

  if (body.action === "respond") {
    const offerId = requireStr(body.offer_id, "offer_id");
    const driverId = requireStr(body.driver_id, "driver_id");
    const { data } = await db.from("offers").select("*").eq("id", offerId).maybeSingle();
    const offer = data as OfferRow | null;
    if (!offer) return json({ error: "offer not found" }, 404);
    if (offer.driver_id !== driverId) return json({ error: "offer belongs to another driver" }, 403);
    if (offer.response) return json({ ok: false, reason: `offer already ${offer.response}` });
    const accept = body.response === "accept";
    const expired = new Date(offer.expires_at).getTime() < Date.now();
    await db.from("offers").update({ response: accept ? (expired ? "late_accept" : "accepted") : "declined", responded_at: new Date().toISOString(), channel: body.channel || "app" }).eq("id", offerId);
    if (!accept) {
      await audit(offer.location_id, "offer_declined", { trip_id: offer.trip_id, driver_id: driverId });
      const r = await nextInCascade(offer);
      return json({ ok: true, result: "declined", next: r });
    }
    const trip = await getTrip(offer.trip_id);
    if (trip.driver_id && trip.driver_id !== driverId) {
      // someone else got it first
      const templates = await loadTemplates(offer.location_id);
      const loc = await getLocation(offer.location_id);
      const { data: drv } = await db.from("drivers").select("phone_e164").eq("id", driverId).maybeSingle();
      const to = (drv as { phone_e164: string | null } | null)?.phone_e164;
      if (to) await sendSms({ to, body: render(templates.driverGone, { bizShort: String(loc.name || "Skyway").split(" ")[0].toUpperCase(), dispatchNo: trip.dispatch_no }), messagingServiceSid: loc.twilio_messaging_sid || undefined }).catch(() => undefined);
      return json({ ok: false, reason: "taken" });
    }
    await setTripStage(offer.trip_id, "assigned", { driverId, actor: `driver:${driverId}`, offer: null, acceptedVia: body.channel || "app" });
    await db.from("offers").update({ response: "superseded", responded_at: new Date().toISOString() }).eq("trip_id", offer.trip_id).is("response", null);
    await audit(offer.location_id, "offer_accepted", { trip_id: offer.trip_id, driver_id: driverId });
    // passenger template 2 ("Driver assigned")
    await fetch(`${functionsBaseUrl()}/notify`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ location_id: offer.location_id, trip_id: offer.trip_id, template: "assigned" }),
    }).catch(() => undefined);
    return json({ ok: true, result: "assigned", trip_id: offer.trip_id });
  }

  if (body.action === "expire") {
    let q = db.from("offers").select("*").is("response", null).lt("expires_at", new Date().toISOString()).limit(50);
    if (body.location_id) q = q.eq("location_id", body.location_id);
    const { data } = await q;
    const rows = (data || []) as OfferRow[];
    const results: Json[] = [];
    for (const offer of rows) {
      await db.from("offers").update({ response: "expired", responded_at: new Date().toISOString() }).eq("id", offer.id);
      await audit(offer.location_id, "offer_expired", { trip_id: offer.trip_id, driver_id: offer.driver_id });
      const r = await nextInCascade(offer);
      results.push({ offer_id: offer.id, trip_id: offer.trip_id, next: r });
    }
    return json({ ok: true, expired: results.length, results });
  }

  if (body.action === "stop") {
    const tripId = requireStr(body.trip_id, "trip_id");
    await db.from("offers").update({ response: "stopped", responded_at: new Date().toISOString() }).eq("trip_id", tripId).is("response", null);
    const trip = await getTrip(tripId);
    if (trip.stage === "offered") await patchTripBody(tripId, { stage: "booked", offer: null });
    await audit(trip.location_id, "offer_stopped", { trip_id: tripId, actor: "dispatcher" });
    return json({ ok: true });
  }

  return json({ error: "action must be offer | respond | expire | stop" }, 400);
});
