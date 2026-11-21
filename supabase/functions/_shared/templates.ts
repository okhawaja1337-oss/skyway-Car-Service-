// Text templates (PRODUCT-DESIGN.md §5).  Defaults below; per-location /
// per-language overrides live in the `templates` table (key = these names).
// Placeholders: {name} filled by render().  The console's messages.js keeps the
// same keys so a template edited in Settings → Messages can be mirrored here.
import { admin, Json } from "./db.ts";

// Owner decision 7 (default): on-shift-only tracking, 30-day raw retention, and THIS exact consent sentence.
// It must stay byte-identical to driver.js / driver-link.js CONSENT_TEXT: the connect text (connect-invite and the
// JOIN reply in sms-in) carries it as {consentLine}, and connect-invite action "complete" refuses to record consent
// given under any other wording. Do not reword or shorten here.
export const CONSENT_TEXT = "Skyway tracks this phone's location only while you are On shift, to dispatch jobs and show passengers their ETA. Raw location data is kept 30 days.";

/** Owner decision 6: what counts as an Account ride. The PAY TYPE governs: an account customer's ride that dispatch
 *  switched to Cash / Credit Card (the console's edit-order Payment select allows it, and Earnings / cash_collected are
 *  pay-type based) must still read as a cash fare so the driver collects it; the account is only the fallback when the
 *  pay type is blank. Same rule as messages.js isAccountTrip(), driver-link.js isAccountRide() and driver.js fareLine(). */
export function isAccountRide(payType: unknown, accountId: unknown): boolean {
  const pay = String(payType || "").trim();
  return /account/i.test(pay) || (!pay && !!accountId);
}

export const DEFAULT_TEMPLATES: Record<string, string> = {
  // passenger lifecycle (1–9)
  // Owner decision 8 (default): every booking confirmation ends with the opt-out line.  The full consent
  // sentence dispatchers say on the phone is "By booking you agree to receive ride updates by text;
  // reply STOP to opt out." (dispatcher cheat sheet, Settings → Messages, book.html, 10DLC opt-in description).
  booked: "{biz}: Your ride is booked for {dateLong}, {time12}. Pickup: {pu} → {do}. Est. {fare} + tolls. Conf #{dispatchNo}. Reply C to cancel or call {bizPhone}.{trackLine} Reply STOP to opt out.",
  assigned: "Your {biz} driver is {driverName} in a {vehicle}, plate {plate} ({car}).{trackLine}",
  enroute: "{driverFirst} is on the way — arriving in about {etaMin} min.",
  arrived: "{driverFirst} has arrived at {puShort} in {car} ({vehicleShort}). Please come out when ready.",
  waiting: "Your driver is waiting at {puShort}. Reply 5 for 5 more minutes, or call {bizPhone}.",
  receipt: "Thanks for riding with {biz}! Total {total}{tollsNote}.{receiptLine}",
  payLink: "Pay {total} for your {biz} ride: {payUrl}",
  reminder: "Reminder: your {biz} ride is tomorrow, {dateLong} at {time12} from {puShort}. Reply C to cancel.",
  flightSmall: "Flight {flightNo} is now landing {flightTime}; we've moved your pickup to {newTime}.",
  flightLarge: "Flight {flightNo} is delayed to {flightTime}. Shall we move your pickup to {newTime}? Reply YES to move or NO to keep {time12}.",
  canceled: "Your {biz} ride #{dispatchNo} is canceled. Reply or call {bizPhone} to rebook.",
  cancelRequested: "{biz}: we received your cancel request for ride #{dispatchNo}. A dispatcher will confirm shortly.",
  // driver
  // {consentLine} = CONSENT_TEXT (owner decision 7); connect-invite / sms-in append it when a location override drops it
  driverConnect: "{bizShort}: Tap to connect your phone to dispatch: {connectUrl} (link good for 24h) {consentLine}",
  driverJob: "{bizShort} JOB #{dispatchNo} — {dayWord} {time12}. PU: {pu}. DO: {do}. {paxName}, {pax} pax, {vtype}. {fareOrAccount}. Reply Y to accept, N to pass, or tap {jobUrl} ({offerSeconds} sec)",
  driverGone: "{bizShort}: Job #{dispatchNo} was given to another driver.",
  driverChange: "{bizShort}: Job #{dispatchNo} changed — {change}. Reply OK.",
  driverCancel: "{bizShort}: Job #{dispatchNo} is CANCELED. Reply OK.",
  driverAck: "{bizShort}: got it — #{dispatchNo} {stageWord}.",
  joinUnknown: "{bizShort}: we don't have this number on file. Dispatch has been told and will connect you.",
  // generic
  help: "{biz} ride updates. Reply STOP to opt out, or call {bizPhone}.",
};

export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? "" : String(v);
  }).replace(/[ ]{2,}/g, " ").trim();
}

/** Default templates merged with the location's overrides from the `templates` table. */
export async function loadTemplates(locationId: string, language = "en"): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...DEFAULT_TEMPLATES };
  const { data, error } = await admin().from("templates").select("key,text").eq("location_id", locationId).eq("language", language).is("deleted_at", null);
  if (error) {
    console.error("templates load failed", error.message);
    return out;
  }
  for (const row of (data || []) as { key: string; text: string }[]) if (row.key && row.text) out[row.key] = row.text;
  return out;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDateLong(ymd: string | null | undefined): string {
  const p = String(ymd || "").split("-").map(Number);
  if (p.length !== 3 || !p[0]) return String(ymd || "");
  const d = new Date(p[0], p[1] - 1, p[2]);
  return `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`;
}

export function fmtTime12(t: string | null | undefined): string {
  const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return String(t || "");
  let h = Number(m[1]);
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  const suf = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suf}`;
}

export function shortAddr(a: unknown): string {
  return String(a || "").split(",")[0].trim();
}

export function fmtMoney(n: unknown, currency = "USD", locale = "en-US"): string {
  const v = Number(n) || 0;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

export function firstName(n: unknown): string {
  return String(n || "").trim().split(/\s+/)[0] || "";
}

/** Build the variable bag for a trip (passenger + driver templates). */
export function tripVars(opts: {
  trip: Json;
  location: { name?: string | null; currency?: string | null; body?: Json };
  settings?: Json;
  driver?: Json | null;
  vehicle?: Json | null;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const t = opts.trip;
  const s = opts.settings || {};
  const biz = String(s.name || opts.location.name || "Skyway Car Service");
  const bizPhone = String(s.phone || (opts.location.body && opts.location.body.phone) || "");
  const currency = opts.location.currency || "USD";
  const d = opts.driver || {};
  const v = opts.vehicle || {};
  const fare = Number(t.fare) || 0;
  const tolls = Number(t.tolls) || 0;
  const total = fare + tolls + (Number(t.tip) || 0);
  const carNo = String(d.carNo || "").replace(/^0+/, "");
  const vehicleDesc = [v.color, v.make, v.model].filter(Boolean).join(" ") || String(t.vtype || "car");
  const base = Deno.env.get("PUBLIC_BASE_URL") || "";
  const track = t.trackToken ? `${base}/t/${t.trackToken}` : "";
  return {
    biz, bizShort: biz.split(" ")[0].toUpperCase(), bizPhone,
    dispatchNo: t.dispatchNo, dateLong: fmtDateLong(t.date as string), time12: fmtTime12(t.time as string),
    pu: t.puAddr, do: t.doAddr, puShort: shortAddr(t.puAddr), doShort: shortAddr(t.doAddr),
    fare: fmtMoney(fare, currency), total: fmtMoney(total, currency),
    tollsNote: tolls ? ` (incl. ${fmtMoney(tolls, currency)} tolls)` : "",
    pax: t.pax || 1, paxName: firstName(t.passenger) + (String(t.passenger || "").trim().split(/\s+/)[1] ? ` ${String(t.passenger).trim().split(/\s+/)[1][0]}.` : ""),
    vtype: t.vtype || "",
    // Owner decision 6 (default): drivers see the fare on job offers; Account rides show "Account — no cash"
    // (same wording as driver.js fareLine()).  Override per location by editing the `driverJob` template row.
    // isAccountRide() is the one definition of "Account ride" (pay type first), shared with offer-job.
    fareOrAccount: isAccountRide(t.payType, t.accountId) ? "Account — no cash" : `${fmtMoney(fare, currency)} + tolls`,
    driverName: d.name ? `${firstName(d.name)}${String(d.name).trim().split(/\s+/)[1] ? ` ${String(d.name).trim().split(/\s+/)[1][0]}.` : ""}` : "your driver",
    driverFirst: firstName(d.name) || "Your driver",
    car: carNo ? `Car ${carNo}` : "", vehicle: vehicleDesc, vehicleShort: [v.color, v.model, v.plate].filter(Boolean).join(" "), plate: v.plate || "",
    trackLine: track ? ` Track: ${track}` : "", receiptLine: track ? ` Receipt & tip: ${base}/r/${t.trackToken}` : "",
    dayWord: "Today", offerSeconds: 90,
    ...(opts.extra || {}),
  };
}
