// square-link — "Send pay link" / pay by text (PRODUCT-DESIGN.md §6).
//
// POST { location_id, trip_id, amount_cents?: <default fare+tolls>, send_text?: true, description? }
// → Checkout.CreatePaymentLink {quick_pay, checkout_options:{allow_tipping:true, redirect_url: pay.html?t=<trackToken>}}
// → trips.body.payment.linkUrl / linkId, payments row kind 'link' (status 'pending'),
//   optional passenger text via template payLink.  square-hook marks it paid.
import { admin, functionsBaseUrl, getLocation, getTrip, json, Json, patchTripBody, publicBaseUrl, readJson, requireStr, serve, shortToken } from "../_shared/db.ts";
import { createPaymentLink, money } from "../_shared/square.ts";

interface Body extends Json {
  location_id: string;
  trip_id: string;
  amount_cents?: number;
  send_text?: boolean;
  description?: string;
}

serve(async (req) => {
  const body = await readJson<Body>(req, ["location_id", "trip_id"]);
  const loc = await getLocation(requireStr(body.location_id, "location_id"));
  const trip = await getTrip(requireStr(body.trip_id, "trip_id"));
  if (trip.location_id !== loc.id) return json({ error: "trip belongs to another location" }, 403);
  const t = trip.body;
  const payment = (t.payment as Json) || {};
  const currency = loc.currency || "USD";
  const amountC = body.amount_cents != null ? Math.round(Number(body.amount_cents)) : Math.round(((Number(t.fare) || 0) + (Number(t.tolls) || 0)) * 100);
  if (amountC <= 0) return json({ error: "amount must be positive" }, 400);

  // reuse an unpaid link for the same amount
  if (payment.linkUrl && Number(payment.linkCents) === amountC && payment.status !== "paid") {
    return json({ ok: true, url: payment.linkUrl, reused: true });
  }
  const trackToken = String(t.trackToken || shortToken(6));
  const base = publicBaseUrl();
  const { payment_link } = await createPaymentLink({
    idempotencyKey: `${trip.id}:link:${amountC}:${Date.now()}`,
    name: `${loc.name || "Skyway"} ride #${t.dispatchNo || ""}`.trim(),
    amount: money(amountC, currency),
    locationId: loc.square_location_id || undefined,
    redirectUrl: base ? `${base}/pay.html?t=${trackToken}&paid=1` : undefined,
    allowTipping: true,
    note: body.description || `${t.puAddr || ""} → ${t.doAddr || ""}`.slice(0, 500),
  });

  await patchTripBody(trip.id, { trackToken, payment: { ...payment, status: payment.status === "paid" ? "paid" : "link_sent", linkUrl: payment_link.url, linkId: payment_link.id, linkOrderId: payment_link.order_id || null, linkCents: amountC, currency, linkAt: new Date().toISOString() } });
  await admin().from("payments").upsert({ id: `link:${payment_link.id}`, location_id: loc.id, trip_id: trip.id, kind: "link", amount: amountC, currency, status: "pending", body: payment_link }, { onConflict: "id" });

  let text_message_id: string | null = null;
  if (body.send_text !== false && (t.phone || trip.phone_e164)) {
    const res = await fetch(`${functionsBaseUrl()}/notify`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ location_id: loc.id, trip_id: trip.id, template: "payLink", force: true, vars: { payUrl: payment_link.url, total: `${(amountC / 100).toFixed(2)} ${currency === "USD" ? "" : currency}`.trim() } }),
    }).catch(() => null);
    if (res && res.ok) text_message_id = ((await res.json()) as { message_id?: string }).message_id || null;
  }
  return json({ ok: true, url: payment_link.url, link_id: payment_link.id, amount_cents: amountC, text_message_id });
});
