// sms-out — send one text from the business number (PRODUCT-DESIGN.md §5).
//
// POST (dispatcher JWT / service) {
//   location_id, to: "+1917…" | "(917) 555-0101",
//   template?: "booked" | "driverJob" | …   (rendered from templates table + defaults)
//   vars?: {…}                               (extra placeholders)
//   text?: "ad-hoc message"                  (used when no template)
//   trip_id?, driver_id?, language?: "en"
// }
// → { ok, message_id, twilio_sid, status, segments }
//
// Every text becomes a `messages` row; Twilio's StatusCallback points at sms-status.
import { admin, functionsBaseUrl, getLocation, getTrip, insertMessage, json, Json, readJson, requireStr, serve, toE164 } from "../_shared/db.ts";
import { sendSms } from "../_shared/twilio.ts";
import { loadTemplates, render, tripVars } from "../_shared/templates.ts";

interface Body extends Json {
  location_id: string;
  to: string;
  template?: string;
  vars?: Record<string, unknown>;
  text?: string;
  trip_id?: string;
  driver_id?: string;
  language?: string;
}

serve(async (req) => {
  const body = await readJson<Body>(req, ["location_id", "to"]);
  const loc = await getLocation(requireStr(body.location_id, "location_id"));
  const to = toE164(body.to, loc.phone_cc || "+1");
  if (!to) return json({ error: "to is not a phone number" }, 400);
  if (!body.template && !body.text) return json({ error: "template or text is required" }, 400);

  // opt-out check (STOP handled by Twilio Advanced Opt-Out AND recorded by sms-in)
  const { data: pax } = await admin().from("passengers").select("sms_opt_out").eq("location_id", loc.id).eq("phone_e164", to).maybeSingle();
  if (pax && (pax as { sms_opt_out: boolean }).sms_opt_out) return json({ ok: false, skipped: "opted_out" }, 200);

  let textBody = String(body.text || "");
  if (body.template) {
    const templates = await loadTemplates(loc.id, body.language || "en");
    const tpl = templates[body.template];
    if (!tpl) return json({ error: `unknown template ${body.template}` }, 400);
    let vars: Record<string, unknown> = { biz: loc.name || "Skyway", bizShort: String(loc.name || "Skyway").split(" ")[0].toUpperCase(), ...(body.vars || {}) };
    if (body.trip_id) {
      const trip = await getTrip(body.trip_id);
      const { data: settingsRow } = await admin().from("settings").select("body").eq("id", loc.id).maybeSingle();
      const [{ data: driver }, { data: vehicle }] = await Promise.all([
        trip.driver_id ? admin().from("drivers").select("body").eq("id", trip.driver_id).maybeSingle() : Promise.resolve({ data: null }),
        trip.vehicle_id ? admin().from("vehicles").select("body").eq("id", trip.vehicle_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      vars = {
        ...tripVars({
          trip: trip.body, location: loc, settings: ((settingsRow as { body: Json } | null)?.body) || {},
          driver: (driver as { body: Json } | null)?.body || null, vehicle: (vehicle as { body: Json } | null)?.body || null,
        }),
        ...(body.vars || {}),
      };
    }
    textBody = render(tpl, vars);
  }
  if (!textBody) return json({ error: "nothing to send" }, 400);

  const sms = await sendSms({ to, body: textBody, messagingServiceSid: loc.twilio_messaging_sid || undefined, statusCallback: `${functionsBaseUrl()}/sms-status` });
  const message_id = await insertMessage({
    location_id: loc.id, direction: "out", to_e164: to, trip_id: body.trip_id || null, driver_id: body.driver_id || null,
    template: body.template || "adhoc", twilio_sid: sms.sid, status: sms.status, text_body: textBody, body: { segments: sms.numSegments },
  });
  return json({ ok: true, message_id, twilio_sid: sms.sid, status: sms.status, segments: sms.numSegments });
});
