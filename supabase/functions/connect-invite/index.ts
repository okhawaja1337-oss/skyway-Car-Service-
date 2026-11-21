// connect-invite — "Connect phone" (PRODUCT-DESIGN.md §4 "Way 1") + the driver's side of finishing it.
//
// 1. Invite (action omitted or "invite") — dispatcher JWT / anon during dual run:
//    POST { location_id, driver_id, phone?: "917…", via?: "dispatcher"|"join" }
//    → creates connect_tokens (token, driver_id, expires_at = +24 h, used=false)
//    → texts the driver from the business number:
//        SKYWAY: Tap to connect your phone to dispatch: https://go.<domain>/d/<token> (link good for 24h)
//        By connecting you agree: Skyway tracks this phone only while On shift; location kept 30 days.
//    → { ok, token, url, expires_at, message_id }
//    Also called internally by sms-in for the JOIN keyword (same body + { via: "join" }).
//
// 2. Complete (action "complete") — from driver.html?t=<token>, no login (the token is the credential;
//    deploy with --no-verify-jwt or put the anon key in driver.html's <meta name="skyway-anon-key">):
//    POST { action: "complete", token, consentAt?: ISO, consentText?, device?: {platform, ua, standalone, version} }
//    → marks the token used, stores drivers.body.consentAt (owner decision 7) + connectedAt, opens a
//      device_sessions row, audits "phone_connected"
//    → { ok, location_id, driver: {id, name, carNo}, biz: {name, phone}, consentAt }
import { admin, audit, functionsBaseUrl, getDriver, getLocation, insertMessage, issueConnectToken, json, Json, nowMs, readJson, requireStr, serve, toE164 } from "../_shared/db.ts";
import { sendSms } from "../_shared/twilio.ts";
import { loadTemplates, render } from "../_shared/templates.ts";

// Owner decision 7 (default): on-shift-only tracking, 30-day raw retention.  Short form for the text;
// the full sentence the driver agrees to on the phone lives in driver.js (CONSENT_TEXT).
const CONSENT_LINE = "By connecting you agree: Skyway tracks this phone only while On shift; location kept 30 days.";

interface Body extends Json {
  action?: "invite" | "complete";
  location_id?: string;
  driver_id?: string;
  phone?: string;
  via?: string;
  token?: string;
  consentAt?: string;
  consentText?: string;
  device?: Json;
}

interface TokenRow { id: string; location_id: string; driver_id: string | null; expires_at: string; used: boolean | null; body: Json }

function isoOrNow(v: unknown, fallback: string): string {
  if (typeof v !== "string" || !v.trim()) return fallback;
  const d = new Date(v);
  return isNaN(d.getTime()) ? fallback : d.toISOString();
}

async function settingsFor(locId: string): Promise<Json> {
  const { data } = await admin().from("settings").select("body").eq("id", locId).maybeSingle();
  return ((data && (data as { body: Json }).body) || {}) as Json;
}

async function invite(body: Body): Promise<Response> {
  const loc = await getLocation(requireStr(body.location_id, "location_id"));
  const driver = await getDriver(requireStr(body.driver_id, "driver_id"));
  if (driver.location_id !== loc.id) return json({ error: "driver belongs to another location" }, 403);

  const to = toE164(body.phone || driver.phone_e164 || (driver.body.phone as string), loc.phone_cc || "+1");
  if (!to) return json({ error: "driver has no phone number on file" }, 400);

  const t = await issueConnectToken(loc.id, driver.id);
  const settings = await settingsFor(loc.id);
  const templates = await loadTemplates(loc.id);
  const bizName = String(settings.name || loc.name || "Skyway");
  let textBody = render(templates.driverConnect, { biz: bizName, bizShort: bizName.split(" ")[0].toUpperCase(), connectUrl: t.url, consentLine: CONSENT_LINE });
  // the connect text always carries the consent line, even when a location's template override left {consentLine} out
  if (!/on shift/i.test(textBody)) textBody = `${textBody} ${CONSENT_LINE}`;

  const sms = await sendSms({ to, body: textBody, messagingServiceSid: loc.twilio_messaging_sid || undefined, statusCallback: `${functionsBaseUrl()}/sms-status` });
  const message_id = await insertMessage({
    location_id: loc.id, direction: "out", to_e164: to, driver_id: driver.id, template: "driverConnect",
    twilio_sid: sms.sid, status: sms.status, text_body: textBody, body: { token: t.token, via: body.via || "dispatcher" },
  });
  return json({ ok: true, token: t.token, url: t.url, expires_at: t.expires_at, message_id });
}

async function complete(body: Body): Promise<Response> {
  const token = requireStr(body.token, "token").toUpperCase();
  const db = admin();
  const { data, error } = await db.from("connect_tokens").select("id,location_id,driver_id,expires_at,used,body").eq("token", token).is("deleted_at", null).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  const row = data as TokenRow | null;
  if (!row || !row.driver_id) return json({ error: "This connect link is not valid. Ask dispatch for a new one." }, 404);
  if (row.used) return json({ error: "This connect link was already used. Ask dispatch for a new one." }, 410);
  if (new Date(row.expires_at).getTime() < Date.now()) return json({ error: "This connect link has expired (links last 24 hours). Ask dispatch for a new one." }, 410);

  const driver = await getDriver(row.driver_id);
  const loc = await getLocation(row.location_id);
  const now = new Date().toISOString();
  const consentAt = isoOrNow(body.consentAt, now);
  const prior = typeof driver.body.consentAt === "string" && driver.body.consentAt ? driver.body.consentAt : "";
  const dev = (body.device && typeof body.device === "object" ? body.device : {}) as Json;
  const consentText = typeof body.consentText === "string" ? body.consentText.slice(0, 400) : "";

  // owner decision 7: the first consent on record is kept; later connects only refresh connectedAt / device
  const newBody: Json = {
    ...driver.body,
    consentAt: prior || consentAt,
    ...(consentText && !prior ? { consentText } : {}),
    connectedAt: now,
    device: { platform: String(dev.platform || "web").slice(0, 60), standalone: dev.standalone === true, version: String(dev.version || "driver.html").slice(0, 40) },
  };
  const { error: dErr } = await db.from("drivers").update({ body: newBody, rev: nowMs() }).eq("id", driver.id);
  if (dErr) return json({ error: dErr.message }, 500);
  await db.from("connect_tokens").update({ used: true, body: { ...row.body, completed_at: now, consentAt: prior || consentAt }, rev: nowMs() }).eq("id", row.id);
  await db.from("device_sessions").insert({
    location_id: loc.id, driver_id: driver.id, phone_e164: driver.phone_e164,
    platform: String(dev.platform || "web").slice(0, 60), app_version: String(dev.version || "driver.html").slice(0, 40), last_seen: now,
    body: { ua: String(dev.ua || "").slice(0, 300), token, consentAt: prior || consentAt },
  });
  await audit(loc.id, "phone_connected", { driver_id: driver.id, actor: `driver:${driver.id}`, body: { token, consentAt: prior || consentAt, firstConsent: !prior } });

  const settings = await settingsFor(loc.id);
  return json({
    ok: true,
    location_id: loc.id,
    driver: { id: driver.id, name: String(driver.name || driver.body.name || ""), carNo: String(driver.car_no || driver.body.carNo || "") },
    biz: { name: String(settings.name || loc.name || "Skyway"), phone: String(settings.phone || settings.cphone || loc.body.phone || "") },
    consentAt: prior || consentAt,
  });
}

serve(async (req) => {
  const body = await readJson<Body>(req);
  if (body.action === "complete") return await complete(body);
  return await invite(body);
});
