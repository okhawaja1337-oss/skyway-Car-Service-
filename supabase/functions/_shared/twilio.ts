// Twilio helpers: Programmable Messaging (send), request-signature validation
// (inbound webhooks), Lookup (E.164 normalization).
// Env vars:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   TWILIO_MESSAGING_SERVICE_SID   default Messaging Service (the business number is its sender)
//   TWILIO_FROM_NUMBER             optional fallback when no Messaging Service is configured
import { HttpError } from "./db.ts";

const API = "https://api.twilio.com/2010-04-01";

function creds(): { sid: string; token: string } {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!sid || !token) throw new HttpError(500, "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set");
  return { sid, token };
}

function basicAuth(): string {
  const { sid, token } = creds();
  return "Basic " + btoa(`${sid}:${token}`);
}

export interface SendSmsInput {
  to: string;                       // E.164
  body: string;
  statusCallback?: string;          // sms-status function URL
  messagingServiceSid?: string;     // per-location Messaging Service (locations.twilio_messaging_sid)
  from?: string;                    // explicit sender (overrides the Messaging Service)
}

export interface SendSmsResult {
  sid: string;
  status: string;
  numSegments: number;
  raw: Record<string, unknown>;
}

/**
 * Keep a text GSM-7: one em dash, arrow or curly quote switches the whole SMS to UCS-2 (70 chars/segment instead of
 * 160), so a 2-segment job offer becomes 3–4. Templates keep their typography on screen (console, driver page, the
 * `messages` row); only the body handed to Twilio is normalized. Same pass as the console's messages.js gsmSafe().
 */
export function gsmSafe(s: string): string {
  return String(s ?? "")
    .replace(/[—–]/g, "-")        // — –  → -
    .replace(/→/g, "to")               // →    → to
    .replace(/[‘’]/g, "'")        // ‘ ’  → '
    .replace(/[“”]/g, '"')        // “ ”  → "
    .replace(/…/g, "...");             // …    → ...
}

/** Twilio Messages API: POST /2010-04-01/Accounts/{AccountSid}/Messages.json */
export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const { sid } = creds();
  const form = new URLSearchParams();
  form.set("To", input.to);
  form.set("Body", gsmSafe(input.body));
  const mss = input.messagingServiceSid || Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") || "";
  if (input.from) form.set("From", input.from);
  else if (mss) form.set("MessagingServiceSid", mss);
  else {
    const from = Deno.env.get("TWILIO_FROM_NUMBER");
    if (!from) throw new HttpError(500, "no Messaging Service or From number configured for Twilio");
    form.set("From", from);
  }
  if (input.statusCallback) form.set("StatusCallback", input.statusCallback);
  const res = await fetch(`${API}/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new HttpError(502, `Twilio ${res.status}: ${(data.message as string) || "send failed"} (code ${data.code})`);
  return { sid: String(data.sid), status: String(data.status), numSegments: Number(data.num_segments || 1), raw: data };
}

/**
 * Validate X-Twilio-Signature: HMAC-SHA1(authToken, url + sorted(key+value)) base64.
 * `url` must be the exact public URL Twilio posted to (scheme, host, path, query).
 */
export async function validateSignature(signature: string | null, url: string, params: Record<string, string>, authToken?: string): Promise<boolean> {
  if (!signature) return false;
  const token = authToken || Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!token) return false;
  const keys = Object.keys(params).sort();
  let data = url;
  for (const k of keys) data += k + params[k];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, signature);
}

/** Rebuild the URL Twilio signed, honoring the proxy headers Supabase puts in front of functions. */
export function webhookUrl(req: Request): string {
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || u.host;
  return `${proto}://${host}${u.pathname}${u.search}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Twilio Lookup v2: normalize any national/international input to E.164. */
export async function lookupE164(phone: string, countryCode = "US"): Promise<{ e164: string; valid: boolean; carrier?: string }> {
  const url = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?CountryCode=${encodeURIComponent(countryCode)}`;
  const res = await fetch(url, { headers: { Authorization: basicAuth() } });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new HttpError(502, `Twilio Lookup ${res.status}: ${(data.message as string) || "failed"}`);
  return { e164: String(data.phone_number || phone), valid: data.valid !== false };
}

/** Minimal TwiML reply for an inbound SMS (empty = no auto-reply). The reply is a text too, so it gets the same GSM-7 pass. */
export function twiml(reply?: string): Response {
  const body = reply
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(gsmSafe(reply))}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/xml" } });
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string);
}
