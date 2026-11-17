// route — Google Routes API computeRoutes with the server key (PRODUCT-DESIGN.md §7).
//
// POST { location_id, origin: "address" | {lat,lng}, destination: "address" | {lat,lng},
//        intermediates?: [ "stop", {lat,lng} ], departure_time?: RFC3339, trip_id?: "…", matrix?: false }
// → { polyline, distanceM, durationS, staticDurationS, tollsEst, currency, legs:[{distanceM,durationS}] }
//   and, when trip_id is given, stores trips.body.route = {polyline, distanceM, durationS, tollsEst, at}
//
// POST { location_id, matrix: true, origins: [...], destinations: [...] }
// → computeRouteMatrix → { rows: [{originIndex, destinationIndex, distanceM, durationS, condition}] }
//   (the Optimizer's deadhead matrix: drivers × open pickups in one call)
//
// Env: GOOGLE_MAPS_SERVER_KEY (IP/App-restricted, Routes API enabled). OSRM fallback stays in the console.
import { getLocation, HttpError, json, Json, patchTripBody, readJson, requireStr, serve } from "../_shared/db.ts";

const ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";
const MATRIX = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

type Place = string | { lat: number; lng: number };

function waypoint(p: Place): Json {
  if (typeof p === "string") return { address: p };
  return { location: { latLng: { latitude: p.lat, longitude: p.lng } } };
}

function key(): string {
  const k = Deno.env.get("GOOGLE_MAPS_SERVER_KEY");
  if (!k) throw new HttpError(500, "GOOGLE_MAPS_SERVER_KEY is not set");
  return k;
}

interface Body extends Json {
  location_id: string;
  origin?: Place;
  destination?: Place;
  intermediates?: Place[];
  departure_time?: string;
  trip_id?: string;
  matrix?: boolean;
  origins?: Place[];
  destinations?: Place[];
}

serve(async (req) => {
  const body = await readJson<Body>(req, ["location_id"]);
  const loc = await getLocation(requireStr(body.location_id, "location_id"));
  const region = String(loc.body.country || "US").toLowerCase();
  const units = loc.body.units === "km" ? "METRIC" : "IMPERIAL";

  if (body.matrix) {
    const origins = Array.isArray(body.origins) ? body.origins : [];
    const destinations = Array.isArray(body.destinations) ? body.destinations : [];
    if (!origins.length || !destinations.length) return json({ error: "origins and destinations required" }, 400);
    if (origins.length * destinations.length > 625) return json({ error: "matrix too large (max 625 elements per call)" }, 400);
    const res = await fetch(MATRIX, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key(), "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,condition" },
      body: JSON.stringify({
        origins: origins.map((o) => ({ waypoint: waypoint(o) })),
        destinations: destinations.map((d) => ({ waypoint: waypoint(d) })),
        travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", regionCode: region, units,
      }),
    });
    const data = (await res.json()) as Json[] | Json;
    if (!res.ok) throw new HttpError(502, `Routes matrix ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    const rows = (Array.isArray(data) ? data : []).map((r) => ({ originIndex: r.originIndex, destinationIndex: r.destinationIndex, distanceM: Number(r.distanceMeters || 0), durationS: Number(String(r.duration || "0s").replace("s", "")), condition: r.condition }));
    return json({ ok: true, rows });
  }

  if (!body.origin || !body.destination) return json({ error: "origin and destination required" }, 400);
  const departure = body.departure_time && new Date(body.departure_time).getTime() > Date.now() ? new Date(body.departure_time).toISOString() : undefined;
  const payload: Json = {
    origin: waypoint(body.origin), destination: waypoint(body.destination),
    intermediates: (body.intermediates || []).map((p) => waypoint(p)),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE_OPTIMAL",
    departureTime: departure,
    computeAlternativeRoutes: false,
    extraComputations: ["TOLLS"],
    routeModifiers: { vehicleInfo: { emissionType: "GASOLINE" }, tollPasses: ["US_NY_EZPASSNY"] },   // TODO(region): toll passes per location
    regionCode: region, units, languageCode: String(loc.locale || "en-US"),
  };
  const res = await fetch(ROUTES, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key(), "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.travelAdvisory.tollInfo,routes.legs.duration,routes.legs.distanceMeters" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { routes?: Json[]; error?: Json };
  if (!res.ok) throw new HttpError(502, `Routes ${res.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
  const r = (data.routes || [])[0];
  if (!r) return json({ ok: false, reason: "no route" });
  const toll = ((((r.travelAdvisory as Json)?.tollInfo as Json)?.estimatedPrice as Json[]) || [])[0];
  const tollsEst = toll ? Number(toll.units || 0) + Number(toll.nanos || 0) / 1e9 : null;
  const out = {
    polyline: String(((r.polyline as Json) || {}).encodedPolyline || ""),
    distanceM: Number(r.distanceMeters || 0),
    durationS: Number(String(r.duration || "0s").replace("s", "")),
    staticDurationS: Number(String(r.staticDuration || "0s").replace("s", "")),
    tollsEst, currency: toll ? String(toll.currencyCode || loc.currency || "USD") : null,
    legs: ((r.legs as Json[]) || []).map((l) => ({ distanceM: Number(l.distanceMeters || 0), durationS: Number(String(l.duration || "0s").replace("s", "")) })),
  };
  if (body.trip_id) await patchTripBody(String(body.trip_id), { route: { ...out, legs: undefined, at: new Date().toISOString() } });
  return json({ ok: true, ...out });
});
