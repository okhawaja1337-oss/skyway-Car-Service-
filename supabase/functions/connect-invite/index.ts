// connect-invite — "Connect phone" (PRODUCT-DESIGN.md §4 "Way 1").
//
// POST (dispatcher JWT / anon during dual run) { location_id, driver_id, phone?: "917…" }
// → creates connect_tokens (token, driver_id, expires_at = +24 h, used=false)
// → texts the driver from the business number:
//     SKYWAY: Tap to connect your phone to dispatch: https://go.<domain>/d/<token> (link good for 24h)
// → { ok, token, url, message_id }
//
// Also called internally by sms-in for the JOIN keyword (same body + { via: "join" }).
import { admin, functionsBaseUrl, getDriver, getLocation, insertMessage, issueConnectToken, json, Json, readJson, requireStr, serve, toE164 } from "../_shared/db.ts";
import { sendSms } from "../_shared/twilio.ts";
import { loadTemplates, render } from "../_shared/templates.ts";

interface Body extends Json {
  location_id: string;
  driver_id: string;
  phone?: string;
  via?: string;
}

serve(async (req) => {
  const body = await readJson<Body>(req, ["location_id", "driver_id"]);
  const loc = await getLocation(requireStr(body.location_id, "location_id"));
  const driver = await getDriver(requireStr(body.driver_id, "driver_id"));
  if (driver.location_id !== loc.id) return json({ error: "driver belongs to another location" }, 403);

  const to = toE164(body.phone || driver.phone_e164 || (driver.body.phone as string), loc.phone_cc || "+1");
  if (!to) return json({ error: "driver has no phone number on file" }, 400);

  const t = await issueConnectToken(loc.id, driver.id);
  const { data: settingsRow } = await admin().from("settings").select("body").eq("id", loc.id).maybeSingle();
  const settings = ((settingsRow && (settingsRow as { body: Json }).body) || {}) as Json;
  const templates = await loadTemplates(loc.id);
  const bizName = String(settings.name || loc.name || "Skyway");
  const textBody = render(templates.driverConnect, { biz: bizName, bizShort: bizName.split(" ")[0].toUpperCase(), connectUrl: t.url });

  const sms = await sendSms({ to, body: textBody, messagingServiceSid: loc.twilio_messaging_sid || undefined, statusCallback: `${functionsBaseUrl()}/sms-status` });
  const message_id = await insertMessage({
    location_id: loc.id, direction: "out", to_e164: to, driver_id: driver.id, template: "driverConnect",
    twilio_sid: sms.sid, status: sms.status, text_body: textBody, body: { token: t.token, via: body.via || "dispatcher" },
  });
  return json({ ok: true, token: t.token, url: t.url, expires_at: t.expires_at, message_id });
});
