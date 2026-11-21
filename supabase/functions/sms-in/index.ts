// sms-in — Twilio inbound-message webhook (PRODUCT-DESIGN.md §4 JOIN, §5 replies).
// Deploy with:  supabase functions deploy sms-in --no-verify-jwt
// Twilio Messaging Service → Integration → "Send a webhook" → https://<ref>.functions.supabase.co/sms-in
//
// Flow: validate X-Twilio-Signature → normalize From → resolve driver / passenger / unknown
//       → keyword routing → write `messages` row → TwiML reply (or silence).
//
// Driver keywords:   JOIN · Y / N (open offer) · E A P D (stage codes) · W <min> · OK
//                    ON / OFF [#job]  (shift, owner decision 7 — driver.js shiftText())
//                    L [#job] <lat>,<lng> <map link> consent:<ISO>  (location pin, driver.js locText())
// Passenger:         C / CANCEL · WHERE / ETA · 5 · YES / NO (flight move) · STOP / START / HELP
// Anything else lands in the Messages panel (messages row, status 'unread').
import { admin, audit, insertMessage, issueConnectToken, Json, nowMs, raiseNeedsYou, readForm, setTripStage, text, toE164 } from "../_shared/db.ts";
import { twiml, validateSignature, webhookUrl } from "../_shared/twilio.ts";
import { CONSENT_TEXT, loadTemplates, render } from "../_shared/templates.ts";

const STAGE_CODES: Record<string, string> = { E: "enroute", A: "onloc", P: "pob", D: "done" };
const STAGE_WORDS: Record<string, string> = { enroute: "on the way", onloc: "arrived", pob: "passenger on board", done: "completed" };

/** "L #12 40.71234,-73.98765 https://maps.google.com/?q=… consent:2026-01-31T14:02:11.000Z" → {no, lat, lng, consentAt}
 *  (same shape driver.js locText() sends and driver-link.js parseLocationText() reads). */
function parseLocationText(raw: string): { no: string; lat: number; lng: number; consentAt: string } | null {
  const m = raw.match(/^\s*L\b\s*(?:#\s*(\d+))?\s+(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/i);
  if (!m) return null;
  const lat = Number(m[2]), lng = Number(m[3]);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const c = raw.match(/consent[:\s]+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z?)/i);
  const consentAt = c && !isNaN(new Date(c[1]).getTime()) ? new Date(c[1]).toISOString() : "";
  return { no: m[1] || "", lat, lng, consentAt };
}

async function locationForNumber(to: string): Promise<{ id: string; name: string | null; phone_cc: string | null } | null> {
  // The business number that received the text identifies the location (one Messaging Service per region).
  // Owner decision 1 (default): texts come from the EXISTING business number via Twilio Hosted SMS (voice
  // untouched); until Hosted SMS + 10DLC are approved the verified toll-free "Skyway text line" is the sender.
  // Either number is matched here: locations.body.sms_number (the Twilio sender, set in docs/SETUP.md §4.4
  // step 6) or locations.body.phone_e164 (the voice line).  Falls back to the first location, so a
  // single-region install works before sms_number is set.
  const db = admin();
  const { data } = await db.from("locations").select("id,name,phone_cc,body").is("deleted_at", null);
  const rows = (data || []) as { id: string; name: string | null; phone_cc: string | null; body: Json }[];
  const want = toE164(to);
  const same = (v: unknown) => !!want && !!v && toE164(String(v)) === want;
  const hit = want ? rows.find((l) => same(l.body.sms_number) || same(l.body.phone_e164)) : undefined;
  return hit || rows[0] || null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return text("POST only", 405);
  const { params } = await readForm(req);
  const ok = await validateSignature(req.headers.get("x-twilio-signature"), webhookUrl(req), params);
  if (!ok) return text("invalid signature", 403);

  const from = toE164(params.From) || params.From;
  const to = toE164(params.To) || params.To;
  const raw = String(params.Body || "").trim();
  const word = raw.toUpperCase().replace(/[^A-Z0-9 ]/g, "").trim();
  const loc = await locationForNumber(to);
  if (!loc) return twiml();
  const db = admin();
  const templates = await loadTemplates(loc.id);
  const biz = String(loc.name || "Skyway");
  const vars: Record<string, unknown> = { biz, bizShort: biz.split(" ")[0].toUpperCase() };

  // who is texting?
  const { data: drv } = await db.from("drivers").select("id,name,body").eq("location_id", loc.id).eq("phone_e164", from).is("deleted_at", null).maybeSingle();
  const driver = drv as { id: string; name: string | null; body: Json } | null;
  const { data: paxRow } = await db.from("passengers").select("id,sms_opt_out").eq("location_id", loc.id).eq("phone_e164", from).maybeSingle();

  const record = async (status: string, extra: Json = {}) =>
    insertMessage({ location_id: loc.id, direction: "in", from_e164: from, to_e164: to, driver_id: driver?.id || null, twilio_sid: params.MessageSid || null, status, text_body: raw, body: { ...extra, keyword: word } });

  // --- carrier keywords (Twilio Advanced Opt-Out also handles these; we only record) ---
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL ALL", "END", "QUIT"].includes(word)) {
    await db.from("passengers").upsert({ id: (paxRow as { id: string } | null)?.id || crypto.randomUUID(), location_id: loc.id, phone_e164: from, sms_opt_out: true }, { onConflict: "id" });
    await record("opt_out");
    return twiml();
  }
  if (["START", "UNSTOP", "YES START"].includes(word)) {
    if (paxRow) await db.from("passengers").update({ sms_opt_out: false }).eq("id", (paxRow as { id: string }).id);
    await record("opt_in");
    return twiml();
  }
  if (word === "HELP" || word === "INFO") {
    await record("help");
    return twiml(render(templates.help, { ...vars, bizPhone: "" }));
  }

  // --- JOIN: a phone asks to connect (§4 Way 2) ---
  if (word === "JOIN") {
    if (driver) {
      const t = await issueConnectToken(loc.id, driver.id);
      await record("join", { driver_id: driver.id, token: t.token });
      // owner decision 7: the connect text always states the policy in the approved words (same as connect-invite),
      // even when a location's template override left {consentLine} out
      let reply = render(templates.driverConnect, { ...vars, connectUrl: t.url, consentLine: CONSENT_TEXT });
      if (!reply.includes(CONSENT_TEXT)) reply = `${reply} ${CONSENT_TEXT}`;
      return twiml(reply);
    }
    await db.from("pending_devices").insert({ location_id: loc.id, phone_e164: from });
    await raiseNeedsYou({ location_id: loc.id, kind: "pending_device", phone_e164: from, note: `New phone wants to join: ${from} — approve as which driver?` });
    await record("join_unknown");
    return twiml(render(templates.joinUnknown, vars));
  }

  // --- driver replies ---
  if (driver) {
    const body = driver.body || {};
    // L [#job] <lat>,<lng> … consent:<ISO> — a location pin texted by driver.js (no-backend mode, or GPS fallback).
    // The driver_locations insert fires the schema trigger (drivers.body.curLoc, on_shift) and the geofence webhook;
    // owner decision 7: a live pin means On shift, and the first consent stamp on record is kept (never overwritten).
    const pin = parseLocationText(raw);
    if (pin) {
      const now = new Date().toISOString();
      const patch: Json = { onShift: true, shiftAt: body.onShift === true && body.shiftAt ? body.shiftAt : now };
      const firstConsent = !!pin.consentAt && !(typeof body.consentAt === "string" && body.consentAt);
      if (firstConsent) { patch.consentAt = pin.consentAt; patch.consentText = CONSENT_TEXT; }
      await db.from("drivers").update({ body: { ...body, ...patch }, on_shift: true, rev: nowMs() }).eq("id", driver.id);
      let tripId: string | null = null;
      if (pin.no) {
        const { data: tr } = await db.from("trips").select("id").eq("location_id", loc.id).eq("dispatch_no", Number(pin.no)).is("deleted_at", null).order("date", { ascending: false }).limit(1).maybeSingle();
        tripId = (tr as { id: string } | null)?.id || null;
      }
      const { error: lErr } = await db.from("driver_locations").insert({ location_id: loc.id, driver_id: driver.id, at: now, lat: pin.lat, lng: pin.lng, trip_id: tripId, device_id: from, body: { source: "sms", twilio_sid: params.MessageSid || null, dispatchNo: pin.no || null } });
      if (lErr) console.error("driver_locations insert failed", lErr.message);
      if (firstConsent) await audit(loc.id, "consent_recorded", { driver_id: driver.id, actor: `driver:${driver.id}`, body: { consentAt: pin.consentAt, via: "sms" } });
      await record("location", { trip_id: tripId, lat: pin.lat, lng: pin.lng, consentAt: pin.consentAt || null });
      return twiml();
    }
    // ON / OFF [#job] — the phone's own switch only gates GPS sending; this text marks the driver On / Off shift in
    // dispatch too (same as the console's Driver IQ → Driver status → Off shift button, driver-link.js setShift()).
    const sh = word.match(/^(ON|OFF)(?:\s+SHIFT)?(?:\s+\d+)?$/);
    if (sh) {
      const on = sh[1] === "ON";
      await db.from("drivers").update({ body: { ...body, onShift: on, shiftAt: new Date().toISOString() }, on_shift: on, rev: nowMs() }).eq("id", driver.id);
      await audit(loc.id, on ? "shift_on" : "shift_off", { driver_id: driver.id, actor: `driver:${driver.id}`, body: { channel: "sms" } });
      await record(on ? "shift_on" : "shift_off");
      return twiml(`${vars.bizShort}: you are ${on ? "On shift — location is shared while you work" : "Off shift — location sharing stopped"}.`);
    }
    // Y / N answer the newest open offer for this driver
    if (word === "Y" || word === "YES" || word === "N" || word === "NO") {
      const { data: offer } = await db.from("offers").select("id,trip_id").eq("driver_id", driver.id).is("response", null).gt("expires_at", new Date().toISOString()).order("sent_at", { ascending: false }).limit(1).maybeSingle();
      if (offer) {
        const o = offer as { id: string; trip_id: string };
        const accept = word.startsWith("Y");
        // offer-job owns the state machine: call it so the cascade / assignment logic lives in one place
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/offer-job`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
          body: JSON.stringify({ action: "respond", location_id: loc.id, offer_id: o.id, driver_id: driver.id, response: accept ? "accept" : "decline", channel: "sms" }),
        });
        await record(accept ? "offer_accept" : "offer_decline", { offer_id: o.id, trip_id: o.trip_id });
        return twiml();
      }
    }
    // E / A / P / D stage codes and W <min> for the driver's active trip
    const m = word.match(/^([EAPDW])(?:\s+(\d{1,3}))?$/);
    if (m) {
      const { data: active } = await db.from("trips").select("id,dispatch_no,stage").eq("driver_id", driver.id).in("stage", ["assigned", "enroute", "onloc", "pob"]).is("deleted_at", null).order("date", { ascending: true }).order("time", { ascending: true }).limit(1).maybeSingle();
      const trip = active as { id: string; dispatch_no: number; stage: string } | null;
      if (!trip) {
        await record("unread");
        return twiml(`${vars.bizShort}: no active job on this phone.`);
      }
      if (m[1] === "W") {
        await db.rpc("set_trip_stage", { p_trip_id: trip.id, p_stage: trip.stage, p_extra: { waitMin: Number(m[2] || 0), actor: `driver:${driver.id}` } });
        await record("wait", { trip_id: trip.id, minutes: Number(m[2] || 0) });
        return twiml(`${vars.bizShort}: #${trip.dispatch_no} wait ${m[2] || 0} min noted.`);
      }
      const stage = STAGE_CODES[m[1]];
      await setTripStage(trip.id, stage, { actor: `driver:${driver.id}`, channel: "sms" });
      await record("stage", { trip_id: trip.id, stage });
      // passenger text for this stage goes through notify (de-duplicated there)
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
        body: JSON.stringify({ location_id: loc.id, trip_id: trip.id, template: stage === "enroute" ? "enroute" : stage === "onloc" ? "arrived" : stage === "done" ? "receipt" : null }),
      }).catch(() => undefined);
      return twiml(render(templates.driverAck, { ...vars, dispatchNo: trip.dispatch_no, stageWord: STAGE_WORDS[stage] }));
    }
    if (word === "OK") { await record("ack"); return twiml(); }
    await record("unread", { who: "driver" });
    return twiml();
  }

  // --- passenger replies: find their most recent live trip ---
  const { data: live } = await db.from("trips").select("id,dispatch_no,stage,body").eq("location_id", loc.id).eq("phone_e164", from).is("deleted_at", null).not("status", "in", "(Completed,Canceled,No-Show,Disregard)").order("date", { ascending: true }).order("time", { ascending: true }).limit(1).maybeSingle();
  const trip = live as { id: string; dispatch_no: number; stage: string | null; body: Json } | null;

  if (word === "C" || word === "CANCEL") {
    if (trip) {
      await db.from("trips").update({ body: { ...trip.body, cancelRequestedAt: new Date().toISOString() }, rev: Date.now() }).eq("id", trip.id);
      await raiseNeedsYou({ location_id: loc.id, kind: "cancel_request", trip_id: trip.id, phone_e164: from, note: `Passenger texted CANCEL for #${trip.dispatch_no} — confirm?` });
      await audit(loc.id, "cancel_requested", { trip_id: trip.id, actor: "passenger" });
      await record("cancel_request", { trip_id: trip.id });
      return twiml(render(templates.cancelRequested, { ...vars, dispatchNo: trip.dispatch_no }));
    }
  }
  if (word === "WHERE" || word === "ETA") {
    await record("eta_request", { trip_id: trip?.id || null });
    if (trip && trip.stage === "enroute") {
      // TODO(Phase 3): call `route` for the live ETA from the driver's last pin; until then acknowledge
      return twiml(`${biz}: your driver is on the way. We'll text when they arrive.`);
    }
    return twiml(trip ? `${biz}: your ride #${trip.dispatch_no} is confirmed. We'll text when your driver is on the way.` : `${biz}: we don't see an upcoming ride for this number. Call us to book.`);
  }
  if (word === "5" && trip && trip.stage === "onloc") {
    await db.rpc("set_trip_stage", { p_trip_id: trip.id, p_stage: "onloc", p_extra: { waitExtendedAt: new Date().toISOString(), actor: "passenger" } });
    await record("wait_more", { trip_id: trip.id });
    return twiml(`${biz}: no problem — your driver will wait 5 more minutes.`);
  }
  if ((word === "YES" || word === "NO") && trip && trip.body.flightMoveProposed) {
    const move = word === "YES";
    const patch: Json = move ? { time: trip.body.flightMoveProposed, flightMoveProposed: null } : { flightMoveProposed: null };
    await db.from("trips").update({ body: { ...trip.body, ...patch }, rev: Date.now() }).eq("id", trip.id);
    await record(move ? "flight_move_yes" : "flight_move_no", { trip_id: trip.id });
    return twiml(move ? `${biz}: done — pickup moved to ${trip.body.flightMoveProposed}.` : `${biz}: okay, we'll keep the original pickup time.`);
  }

  // everything else: Messages panel
  await record("unread", { who: paxRow ? "passenger" : "unknown", trip_id: trip?.id || null });
  return twiml();
});
