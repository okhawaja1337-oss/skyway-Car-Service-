// geofence — Database Webhook on driver_locations INSERT (PRODUCT-DESIGN.md §4, §7).
// Supabase Dashboard → Database → Webhooks → table driver_locations, event INSERT,
// type "Supabase Edge Function" → geofence.  (Payload: {type, table, record, schema, old_record})
//
// For the driver's active trip:
//   * enroute + within geofence (150 m default, locations.geofence_m) of the pickup
//       → trip_events 'geofence_enter', trips.body.geofenceEnteredAt, suggest Arrived
//   * still inside after 60 s (next pin) and stage still enroute → auto Arrived (stage 'onloc') + notify "arrived"
//   * enroute/onloc and within 5 min (~ 2 km) → "5 min away" text once (template enroute with etaChanged)
//   * entering an airport polygon (config key `airports`) on a trip without the airport fee → apply it and note it
//
// Pickup coordinates: trips.body.puLat/puLng, else the location's geocache (config key `geocache`),
// else the `geocode` function (cached afterwards).
import { admin, distanceM, functionsBaseUrl, getLocation, json, Json, patchTripBody, pointInPolygon, readJson, serve, setTripStage } from "../_shared/db.ts";

interface Hook extends Json {
  type: string;
  table: string;
  record: { id: string; location_id: string; driver_id: string; at: string; lat: number; lng: number; trip_id?: string | null };
}

const AUTO_ARRIVE_MS = 60 * 1000;
const FIVE_MIN_M = 2000;

async function pickupCoords(locId: string, trip: Json): Promise<{ lat: number; lng: number } | null> {
  if (typeof trip.puLat === "number" && typeof trip.puLng === "number") return { lat: trip.puLat, lng: trip.puLng };
  const addr = String(trip.puAddr || "").trim();
  if (!addr) return null;
  const { data } = await admin().from("config").select("body").eq("id", `${locId}:geocache`).maybeSingle();
  const cache = ((data as { body: Json } | null)?.body?.value || {}) as Record<string, { lat: number; lng: number }>;
  const key = addr.toUpperCase().replace(/\s+/g, " ");
  const hit = cache[key] || cache[addr] || cache[addr.toLowerCase()];
  if (hit && typeof hit.lat === "number") return { lat: hit.lat, lng: hit.lng };
  try {
    const res = await fetch(`${functionsBaseUrl()}/geocode`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ location_id: locId, address: addr }),
    });
    const g = (await res.json()) as { lat?: number; lng?: number };
    if (typeof g.lat === "number" && typeof g.lng === "number") return { lat: g.lat, lng: g.lng };
  } catch (e) {
    console.error("geocode failed", e instanceof Error ? e.message : e);
  }
  return null;
}

serve(async (req) => {
  const hook = await readJson<Hook>(req, ["record"]);
  const r = hook.record;
  if (hook.type && hook.type !== "INSERT") return json({ ok: true, skipped: hook.type });
  if (!r || typeof r.lat !== "number" || typeof r.lng !== "number" || !r.driver_id) return json({ error: "record needs driver_id, lat, lng" }, 400);
  const db = admin();
  const loc = await getLocation(r.location_id);
  const fenceM = Number(loc.geofence_m || (loc.body.geofenceM as number) || 150);

  const { data: active } = await db.from("trips").select("id,dispatch_no,stage,body").eq("driver_id", r.driver_id).in("stage", ["assigned", "enroute", "onloc", "pob"]).is("deleted_at", null).order("date").order("time").limit(1).maybeSingle();
  const trip = active as { id: string; dispatch_no: number; stage: string; body: Json } | null;
  if (!trip) return json({ ok: true, skipped: "no active trip" });
  const out: Json = { trip_id: trip.id, stage: trip.stage };

  // ---- pickup fence ----
  if (trip.stage === "enroute" || trip.stage === "assigned") {
    const pu = await pickupCoords(loc.id, trip.body);
    if (pu) {
      const d = distanceM(r.lat, r.lng, pu.lat, pu.lng);
      out.pickupDistanceM = Math.round(d);
      if (trip.stage === "enroute" && d <= FIVE_MIN_M && !trip.body.fiveMinSentAt) {
        await patchTripBody(trip.id, { fiveMinSentAt: new Date().toISOString() });
        await fetch(`${functionsBaseUrl()}/notify`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` }, body: JSON.stringify({ location_id: loc.id, trip_id: trip.id, template: "enroute", vars: { etaMin: 5, etaChanged: true } }) }).catch(() => undefined);
      }
      if (d <= fenceM) {
        const enteredAt = trip.body.geofenceEnteredAt ? new Date(String(trip.body.geofenceEnteredAt)).getTime() : 0;
        if (!enteredAt) {
          await db.from("trip_events").insert({ location_id: loc.id, trip_id: trip.id, driver_id: r.driver_id, type: "geofence_enter", actor: "system", occurred_at: r.at, lat: r.lat, lng: r.lng, data: { distanceM: Math.round(d), fenceM } });
          await patchTripBody(trip.id, { geofenceEnteredAt: r.at, arrivedSuggested: true });
          out.event = "geofence_enter";
        } else if (trip.stage === "enroute" && Date.now() - enteredAt >= AUTO_ARRIVE_MS && (trip.body.autoArrived !== false)) {
          // TODO(owner risk 11): automation toggle settings.automation.autoArrived — honored via trips.body.autoArrived set by the console
          await setTripStage(trip.id, "onloc", { actor: "system:geofence", arrivedAuto: true, arrivedSuggested: false }, new Date(r.at));
          await fetch(`${functionsBaseUrl()}/notify`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` }, body: JSON.stringify({ location_id: loc.id, trip_id: trip.id, template: "arrived" }) }).catch(() => undefined);
          out.event = "auto_arrived";
        }
      } else if (trip.body.geofenceEnteredAt && trip.stage === "enroute") {
        await patchTripBody(trip.id, { geofenceEnteredAt: null, arrivedSuggested: false });   // drove past; reset
      }
    }
  }

  // ---- airport polygons ----
  const { data: ap } = await db.from("config").select("body").eq("id", `${loc.id}:airports`).maybeSingle();
  const airports = (((ap as { body: Json } | null)?.body?.value) || []) as { code: string; polygon: number[][]; fee?: number }[];
  for (const a of airports) {
    if (!Array.isArray(a.polygon) || a.polygon.length < 3) continue;
    if (pointInPolygon(r.lat, r.lng, a.polygon)) {
      out.airport = a.code;
      if (!trip.body.airportFeeApplied && !trip.body.airport) {
        // TODO(owner decision 4 / rate card): fee amount comes from config `rate_card`.airportFee or locations.body.airportFlat
        const fee = Number(a.fee ?? (loc.body.airportFee as number) ?? 0);
        if (fee > 0) {
          await patchTripBody(trip.id, { airport: a.code, airportFeeApplied: fee, fare: Math.round(((Number(trip.body.fare) || 0) + fee) * 100) / 100, notes: `${trip.body.notes ? trip.body.notes + " · " : ""}Airport fee added automatically (${a.code})` });
          out.airportFee = fee;
        }
      }
      break;
    }
  }
  return json({ ok: true, ...out });
});
