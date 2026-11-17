// notify — passenger lifecycle texts with de-dup and the undo gate (PRODUCT-DESIGN.md §5).
//
// POST { location_id, trip_id, template: "booked"|"assigned"|"enroute"|"arrived"|"waiting"|"receipt"|"reminder"|"canceled"|"flightSmall"|"flightLarge",
//        vars?: {…}, force?: false }
// → { ok, sent: true|false, reason?, message_id? }
//
// Rules:
//   * the console (sync.js / simple.js) calls this ~10 s after the action unless the dispatcher pressed Undo
//   * never twice for the same (trip_id, template, stage): checked in `messages`
//   * skipped when the passenger opted out → Needs-you "Call instead"
//   * trips.body.sms[template] = {at, message_id, sid} so the console's "texts sent" strip renders offline
//   * texts are not sent for trips that still carry a temporary (negative) dispatchNo (§9)
import { admin, functionsBaseUrl, getLocation, getTrip, insertMessage, json, Json, patchTripBody, raiseNeedsYou, readJson, requireStr, serve, toE164 } from "../_shared/db.ts";
import { sendSms } from "../_shared/twilio.ts";
import { loadTemplates, render, tripVars } from "../_shared/templates.ts";

interface Body extends Json {
  location_id: string;
  trip_id: string;
  template: string | null;
  vars?: Record<string, unknown>;
  force?: boolean;
}

const PASSENGER_TEMPLATES = ["booked", "assigned", "enroute", "arrived", "waiting", "receipt", "payLink", "reminder", "canceled", "flightSmall", "flightLarge"];

serve(async (req) => {
  const body = await readJson<Body>(req, ["location_id", "trip_id"]);
  if (!body.template) return json({ ok: true, sent: false, reason: "no template for this stage" });
  const template = requireStr(body.template, "template");
  if (!PASSENGER_TEMPLATES.includes(template)) return json({ error: `unknown template ${template}` }, 400);
  const loc = await getLocation(requireStr(body.location_id, "location_id"));
  const trip = await getTrip(requireStr(body.trip_id, "trip_id"));
  if (trip.location_id !== loc.id) return json({ error: "trip belongs to another location" }, 403);

  const to = toE164(trip.phone_e164 || (trip.body.phone as string), loc.phone_cc || "+1");
  if (!to) return json({ ok: true, sent: false, reason: "trip has no phone" });
  if (typeof trip.body.dispatchNo === "number" && trip.body.dispatchNo < 0) return json({ ok: true, sent: false, reason: "temporary dispatch number — sync first" });

  const db = admin();
  // opt-out → Needs-you "Call instead"
  const { data: pax } = await db.from("passengers").select("sms_opt_out").eq("location_id", loc.id).eq("phone_e164", to).maybeSingle();
  if (pax && (pax as { sms_opt_out: boolean }).sms_opt_out) {
    await raiseNeedsYou({ location_id: loc.id, kind: "call_instead", trip_id: trip.id, phone_e164: to, note: `Passenger opted out of texts — call about #${trip.dispatch_no} (${template}).` });
    return json({ ok: true, sent: false, reason: "opted_out" });
  }
  // de-dup by (trip_id, template, stage) — "enroute" may repeat only when the ETA moved > 5 min (vars.etaChanged)
  const stage = trip.stage || "";
  if (!body.force) {
    const { data: dup } = await db.from("messages").select("id").eq("trip_id", trip.id).eq("template", template).eq("direction", "out").contains("body", { stage }).limit(1).maybeSingle();
    if (dup && !(template === "enroute" && body.vars && body.vars.etaChanged)) return json({ ok: true, sent: false, reason: "already sent for this stage", message_id: (dup as { id: string }).id });
  }

  const [{ data: settingsRow }, { data: driver }, { data: vehicle }, templates] = await Promise.all([
    db.from("settings").select("body").eq("id", loc.id).maybeSingle(),
    trip.driver_id ? db.from("drivers").select("body").eq("id", trip.driver_id).maybeSingle() : Promise.resolve({ data: null }),
    trip.vehicle_id ? db.from("vehicles").select("body").eq("id", trip.vehicle_id).maybeSingle() : Promise.resolve({ data: null }),
    loadTemplates(loc.id),
  ]);
  const vars = {
    ...tripVars({ trip: trip.body, location: loc, settings: ((settingsRow as { body: Json } | null)?.body) || {}, driver: (driver as { body: Json } | null)?.body || null, vehicle: (vehicle as { body: Json } | null)?.body || null }),
    ...(body.vars || {}),
  };
  // receipt: card charged → receipt+tip link; no card → pay link (square-link fills vars.payUrl)
  let key = template;
  if (template === "receipt" && (trip.body.payment as Json | undefined)?.status !== "paid" && vars.payUrl) key = "payLink";
  const textBody = render(templates[key], vars);

  const sms = await sendSms({ to, body: textBody, messagingServiceSid: loc.twilio_messaging_sid || undefined, statusCallback: `${functionsBaseUrl()}/sms-status` });
  const message_id = await insertMessage({ location_id: loc.id, direction: "out", to_e164: to, trip_id: trip.id, driver_id: trip.driver_id, template, twilio_sid: sms.sid, status: sms.status, text_body: textBody, body: { stage, segments: sms.numSegments } });
  const smsLog = { ...((trip.body.sms as Json) || {}), [template]: { at: new Date().toISOString(), message_id, sid: sms.sid, via: "twilio" } };
  await patchTripBody(trip.id, { sms: smsLog });
  return json({ ok: true, sent: true, message_id, twilio_sid: sms.sid });
});
