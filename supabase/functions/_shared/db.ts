// Shared database + HTTP helpers for every Skyway Edge Function.
// Runtime: Supabase Edge Functions (Deno).  Env vars read here:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (injected automatically by Supabase)
//   SUPABASE_ANON_KEY                        (injected automatically; used to check caller JWTs)
//   PUBLIC_BASE_URL   e.g. https://go.skywaycar.com   (short links in texts; owner decision 2)
//   FUNCTIONS_BASE_URL e.g. https://<ref>.functions.supabase.co  (webhook callbacks)
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export type Json = Record<string, unknown>;

export interface LocationRow {
  id: string;
  name: string | null;
  tz: string | null;
  currency: string | null;
  locale: string | null;
  units: string | null;
  country: string | null;
  phone_cc: string | null;
  square_location_id: string | null;
  twilio_messaging_sid: string | null;
  geofence_m: number | null;
  body: Json;
}

export interface TripRow {
  id: string;
  location_id: string;
  dispatch_no: number | null;
  date: string | null;
  time: string | null;
  stage: string | null;
  status: string | null;
  driver_id: string | null;
  vehicle_id: string | null;
  account_id: string | null;
  pay_type: string | null;
  payment_status: string | null;
  track_token: string | null;
  fare: number | null;
  tolls: number | null;
  tip: number | null;
  phone_e164: string | null;
  rev: number;
  body: Json;
}

export interface DriverRow {
  id: string;
  location_id: string;
  phone_e164: string | null;
  active: boolean | null;
  on_shift: boolean | null;
  car_no: string | null;
  name: string | null;
  body: Json;
}

let _admin: SupabaseClient | null = null;

/** Service-role client: bypasses RLS. Never expose its key to a browser. */
export function admin(): SupabaseClient {
  if (_admin) return _admin;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  _admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _admin;
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

export function text(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType, ...CORS_HEADERS } });
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Wraps a handler: OPTIONS preflight, JSON errors, never leaks stack traces. */
export function serve(handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    try {
      return await handler(req);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[${status}]`, message);
      return json({ error: message }, status);
    }
  });
}

/** Parse a JSON body and check required keys. */
export async function readJson<T extends Json>(req: Request, required: string[] = []): Promise<T> {
  if (req.method !== "POST") throw new HttpError(405, "POST only");
  let body: Json;
  try {
    body = (await req.json()) as Json;
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === "") throw new HttpError(400, `missing field: ${k}`);
  }
  return body as T;
}

/** Parse application/x-www-form-urlencoded (Twilio webhooks). */
export async function readForm(req: Request): Promise<{ params: Record<string, string>; raw: string }> {
  const raw = await req.text();
  const params: Record<string, string> = {};
  new URLSearchParams(raw).forEach((v, k) => (params[k] = v));
  return { params, raw };
}

export function requireStr(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${name} must be a non-empty string`);
  return v.trim();
}

export function nowMs(): number {
  return Date.now();
}

export function publicBaseUrl(): string {
  return (Deno.env.get("PUBLIC_BASE_URL") || "").replace(/\/+$/, "");
}

export function functionsBaseUrl(): string {
  const explicit = Deno.env.get("FUNCTIONS_BASE_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  const url = Deno.env.get("SUPABASE_URL") || "";
  return url.replace(/\/+$/, "") + "/functions/v1";
}

/** Short random token for links (no vowels/ambiguous chars so it reads well in a text). */
export function shortToken(len = 6): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Connect-phone token (§4): 24 h, single use. Shared by connect-invite and the JOIN keyword in sms-in. */
export async function issueConnectToken(locationId: string, driverId: string): Promise<{ token: string; url: string; expires_at: string }> {
  const token = shortToken(5);
  const expires_at = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const { error } = await admin().from("connect_tokens").insert({ location_id: locationId, token, driver_id: driverId, expires_at, used: false });
  if (error) throw new HttpError(500, error.message);
  const base = publicBaseUrl();
  // go.<domain>/d/<token> rewrites to driver.html?t=<token> (Cloudflare Pages _redirects, see docs/SETUP.md)
  const url = base ? `${base}/d/${token}` : `driver.html?t=${token}`;
  return { token, url, expires_at };
}

export async function getLocation(id: string): Promise<LocationRow> {
  const { data, error } = await admin().from("locations").select("*").eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, `location ${id} not found`);
  return data as LocationRow;
}

export async function getTrip(id: string): Promise<TripRow> {
  const { data, error } = await admin().from("trips").select("*").eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, `trip ${id} not found`);
  return data as TripRow;
}

export async function getDriver(id: string): Promise<DriverRow> {
  const { data, error } = await admin().from("drivers").select("*").eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, `driver ${id} not found`);
  return data as DriverRow;
}

/** Patch keys into trips.body (server-side merge; bumps rev so consoles pull it). */
export async function patchTripBody(tripId: string, patch: Json): Promise<TripRow> {
  const trip = await getTrip(tripId);
  const body = { ...trip.body, ...patch };
  const { data, error } = await admin().from("trips").update({ body, rev: nowMs() }).eq("id", tripId).select("*").single();
  if (error) throw new HttpError(500, error.message);
  return data as TripRow;
}

/** Set a trip's stage through the SQL helper (also writes the events audit row). */
export async function setTripStage(tripId: string, stage: string, extra: Json = {}, at: Date = new Date()): Promise<TripRow> {
  const { data, error } = await admin().rpc("set_trip_stage", {
    p_trip_id: tripId,
    p_stage: stage,
    p_at: at.toISOString(),
    p_extra: extra,
  });
  if (error) throw new HttpError(500, error.message);
  return data as TripRow;
}

export interface MessageInsert {
  location_id: string;
  direction: "out" | "in";
  to_e164?: string | null;
  from_e164?: string | null;
  trip_id?: string | null;
  driver_id?: string | null;
  template?: string | null;
  twilio_sid?: string | null;
  status?: string | null;
  text_body?: string | null;
  body?: Json;
}

export async function insertMessage(m: MessageInsert): Promise<string> {
  const { data, error } = await admin().from("messages").insert({ ...m, at: new Date().toISOString() }).select("id").single();
  if (error) throw new HttpError(500, error.message);
  return (data as { id: string }).id;
}

/** Raise an item in the console's Needs-you strip. */
export async function raiseNeedsYou(item: {
  location_id: string;
  kind: string;
  note: string;
  trip_id?: string | null;
  driver_id?: string | null;
  phone_e164?: string | null;
  body?: Json;
}): Promise<void> {
  const { error } = await admin().from("needs_you").insert(item);
  if (error) console.error("needs_you insert failed", error.message);
}

export async function audit(location_id: string, type: string, extra: { trip_id?: string | null; driver_id?: string | null; actor?: string; body?: Json } = {}): Promise<void> {
  const { error } = await admin().from("events").insert({ location_id, type, actor: extra.actor || "system", trip_id: extra.trip_id || null, driver_id: extra.driver_id || null, body: extra.body || {} });
  if (error) console.error("events insert failed", error.message);
}

/** Normalize a phone to E.164 without a network call (Twilio Lookup is used where it matters). */
export function toE164(raw: string | null | undefined, defaultCc = "+1"): string | null {
  if (!raw) return null;
  const d = String(raw).replace(/[^0-9+]/g, "");
  if (!d) return null;
  if (d.startsWith("+")) return d;
  if (d.length === 10) return `${defaultCc}${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return `+${d}`;
}

/** Haversine distance in meters. */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Ray-casting point in polygon; polygon = [[lat,lng],...]. */
export function pointInPolygon(lat: number, lng: number, poly: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 'YYYY-MM-DD HH:MM' in the location's time zone — the console's own curLoc.when format. */
export function localStamp(tz: string | null | undefined, d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  const hh = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hh}:${parts.minute}`;
}
