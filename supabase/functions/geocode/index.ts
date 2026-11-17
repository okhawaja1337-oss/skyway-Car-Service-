// geocode — Google Geocoding with the server key + the location's cache (PRODUCT-DESIGN.md §7).
//
// POST { location_id, address: "77-35 164 St, Fresh Meadows" }      → { lat, lng, formatted, placeId, cached }
// POST { location_id, lat: 40.72, lng: -73.80 }   (reverse)          → { formatted, short, cached }
// POST { location_id, driver_id, lat, lng }  fills drivers.body.curLoc.addr lazily (Driver IQ labels)
//
// Cache: config row `<location_id>:geocache` (= the console's STATE.geocache, same normalized key),
// so repeats are free and the console's existing geocache keeps working.  Photon/Nominatim fallbacks
// stay in the browser; here Google only (server key, Geocoding API enabled).
import { admin, getLocation, HttpError, json, Json, nowMs, readJson, requireStr, serve } from "../_shared/db.ts";

const GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";

interface Body extends Json {
  location_id: string;
  address?: string;
  lat?: number;
  lng?: number;
  driver_id?: string;
}

function key(): string {
  const k = Deno.env.get("GOOGLE_MAPS_SERVER_KEY");
  if (!k) throw new HttpError(500, "GOOGLE_MAPS_SERVER_KEY is not set");
  return k;
}

/** Mirrors the console's normalizeAddr() closely enough for cache hits: upper-case, collapse spaces, strip punctuation. */
function normKey(a: string): string {
  return a.toUpperCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
}

async function cache(locId: string): Promise<{ id: string; body: Json; value: Record<string, Json> }> {
  const id = `${locId}:geocache`;
  const { data } = await admin().from("config").select("body").eq("id", id).maybeSingle();
  const body = ((data as { body: Json } | null)?.body) || { key: "geocache", value: {} };
  return { id, body, value: ((body.value as Record<string, Json>) || {}) };
}

async function cachePut(locId: string, c: { id: string; body: Json; value: Record<string, Json> }, k: string, v: Json): Promise<void> {
  c.value[k] = v;
  await admin().from("config").upsert({ id: c.id, location_id: locId, key: "geocache", body: { ...c.body, key: "geocache", value: c.value }, rev: nowMs() }, { onConflict: "id" });
}

serve(async (req) => {
  const body = await readJson<Body>(req, ["location_id"]);
  const loc = await getLocation(requireStr(body.location_id, "location_id"));
  const region = String(loc.body.country || "US").toLowerCase();
  const c = await cache(loc.id);

  // ---- forward ----
  if (body.address) {
    const addr = String(body.address).trim();
    const k = normKey(addr);
    const hit = c.value[k];
    if (hit && typeof hit.lat === "number") return json({ ok: true, lat: hit.lat, lng: hit.lng, formatted: hit.formatted || addr, placeId: hit.placeId || null, cached: true });
    const q = new URLSearchParams({ address: addr, region, key: key() });
    const center = loc.body.mapCenter as { lat: number; lng: number } | undefined;
    if (center) q.set("bounds", `${center.lat - 0.6},${center.lng - 0.8}|${center.lat + 0.6},${center.lng + 0.8}`);
    const res = await fetch(`${GEOCODE}?${q.toString()}`);
    const data = (await res.json()) as { status: string; results?: Json[]; error_message?: string };
    if (data.status !== "OK" || !data.results?.length) return json({ ok: false, status: data.status, reason: data.error_message || "no result" }, data.status === "ZERO_RESULTS" ? 404 : 502);
    const r = data.results[0];
    const ll = ((r.geometry as Json).location as { lat: number; lng: number });
    const out = { lat: ll.lat, lng: ll.lng, formatted: String(r.formatted_address || addr), placeId: String(r.place_id || "") };
    await cachePut(loc.id, c, k, out);
    return json({ ok: true, ...out, cached: false });
  }

  // ---- reverse ----
  if (typeof body.lat === "number" && typeof body.lng === "number") {
    const k = `@${body.lat.toFixed(4)},${body.lng.toFixed(4)}`;
    let hit = c.value[k];
    if (!hit) {
      const q = new URLSearchParams({ latlng: `${body.lat},${body.lng}`, result_type: "street_address|premise|intersection|route", key: key() });
      const res = await fetch(`${GEOCODE}?${q.toString()}`);
      const data = (await res.json()) as { status: string; results?: Json[]; error_message?: string };
      if (data.status !== "OK" || !data.results?.length) return json({ ok: false, status: data.status, reason: data.error_message || "no result" }, 404);
      const r = data.results[0];
      const formatted = String(r.formatted_address || "");
      hit = { formatted, short: formatted.split(",").slice(0, 2).join(",").trim(), placeId: String(r.place_id || "") };
      await cachePut(loc.id, c, k, hit);
    }
    if (body.driver_id) {
      const { data: d } = await admin().from("drivers").select("body").eq("id", String(body.driver_id)).maybeSingle();
      const db = (d as { body: Json } | null)?.body;
      const cur = (db?.curLoc as Json) || null;
      if (db && cur && !cur.addr && Math.abs(Number(cur.lat) - body.lat) < 0.0005 && Math.abs(Number(cur.lng) - body.lng) < 0.0005) {
        await admin().from("drivers").update({ body: { ...db, curLoc: { ...cur, addr: hit.short } }, rev: nowMs() }).eq("id", String(body.driver_id));
      }
    }
    return json({ ok: true, formatted: hit.formatted, short: hit.short, placeId: hit.placeId || null, cached: !!c.value[k] });
  }

  return json({ error: "address, or lat+lng, required" }, 400);
});
