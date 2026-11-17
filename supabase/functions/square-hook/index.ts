// square-hook — Square webhooks (PRODUCT-DESIGN.md §6).
// Deploy with:  supabase functions deploy square-hook --no-verify-jwt
// Square developer dashboard → Webhooks → subscription URL https://<ref>.functions.supabase.co/square-hook
// Events: payment.created, payment.updated, refund.updated, invoice.payment_made, invoice.updated,
//         invoice.canceled, card.forgotten, customer.updated
//
// Verifies x-square-hmacsha256-signature (HMAC-SHA256 over notificationUrl + raw body with the
// subscription's signature key) and is idempotent by event_id (square_events table).
import { admin, Json, nowMs, text } from "../_shared/db.ts";
import { verifyWebhookSignature } from "../_shared/square.ts";

function notificationUrl(req: Request): string {
  const explicit = Deno.env.get("SQUARE_WEBHOOK_URL");            // set this to the exact URL registered in Square
  if (explicit) return explicit;
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || u.host;
  return `${proto}://${host}${u.pathname}`;
}

async function tripForPayment(p: Json): Promise<{ id: string; body: Json; location_id: string } | null> {
  const db = admin();
  // 1) payments row we created (auth/capture/link)   2) reference_id = dispatchNo   3) order_id of a pay link
  const { data: pr } = await db.from("payments").select("trip_id").eq("id", String(p.id)).maybeSingle();
  let tripId = (pr as { trip_id: string | null } | null)?.trip_id || null;
  if (!tripId && p.order_id) {
    const { data: link } = await db.from("payments").select("trip_id").eq("kind", "link").contains("body", { order_id: p.order_id }).maybeSingle();
    tripId = (link as { trip_id: string | null } | null)?.trip_id || null;
  }
  if (!tripId && p.reference_id && /^\d+$/.test(String(p.reference_id))) {
    const { data: byRef } = await db.from("trips").select("id").eq("dispatch_no", Number(p.reference_id)).is("deleted_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    tripId = (byRef as { id: string } | null)?.id || null;
  }
  if (!tripId) return null;
  const { data: t } = await db.from("trips").select("id,body,location_id").eq("id", tripId).maybeSingle();
  return t as { id: string; body: Json; location_id: string } | null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return text("POST only", 405);
  const raw = await req.text();
  const ok = await verifyWebhookSignature(req.headers.get("x-square-hmacsha256-signature"), notificationUrl(req), raw);
  if (!ok) return text("invalid signature", 403);

  let evt: Json;
  try { evt = JSON.parse(raw) as Json; } catch { return text("bad json", 400); }
  const eventId = String(evt.event_id || "");
  const type = String(evt.type || "");
  if (!eventId) return text("missing event_id", 400);
  const db = admin();

  // idempotency: first insert wins
  const { error: dupErr } = await db.from("square_events").insert({ event_id: eventId, type, body: { merchant_id: evt.merchant_id, created_at: evt.created_at } });
  if (dupErr) {
    if (/duplicate|unique/i.test(dupErr.message)) return text("ok (duplicate)", 200);
    return text(dupErr.message, 500);
  }

  const data = ((evt.data as Json) || {});
  const obj = ((data.object as Json) || {});

  try {
    if (type === "payment.created" || type === "payment.updated") {
      const p = (obj.payment as Json) || {};
      const trip = await tripForPayment(p);
      const amount = Number((p.amount_money as Json)?.amount || 0), tip = Number((p.tip_money as Json)?.amount || 0), currency = String((p.amount_money as Json)?.currency || "USD");
      const status = String(p.status || "");
      const fees = (p.processing_fee as Json[]) || [];
      const fee = fees.reduce((s, f) => s + Number(((f.amount_money as Json) || {}).amount || 0), 0);
      await db.from("payments").upsert({ id: String(p.id), location_id: trip?.location_id || null, trip_id: trip?.id || null, kind: p.order_id ? "link" : (status === "APPROVED" ? "auth" : "capture"), amount, tip, fee, currency, status, receipt_url: (p.receipt_url as string) || null, body: p }, { onConflict: "id" });
      if (trip && status === "COMPLETED") {
        const pay = (trip.body.payment as Json) || {};
        await db.from("trips").update({ body: { ...trip.body, payment: { ...pay, status: "paid", paymentId: p.id, amountCents: amount, tipCents: tip, currency, paidAt: p.updated_at || new Date().toISOString(), receiptUrl: p.receipt_url || null }, tip: tip ? tip / 100 : trip.body.tip }, rev: nowMs() }).eq("id", trip.id);
      } else if (trip && (status === "FAILED" || status === "CANCELED")) {
        const pay = (trip.body.payment as Json) || {};
        if (pay.paymentId === p.id) await db.from("trips").update({ body: { ...trip.body, payment: { ...pay, status: status === "FAILED" ? "failed" : "canceled" } }, rev: nowMs() }).eq("id", trip.id);
      }
    } else if (type === "refund.updated") {
      const r = (obj.refund as Json) || {};
      await db.from("payments").upsert({ id: String(r.id), kind: "refund", amount: -Number((r.amount_money as Json)?.amount || 0), currency: String((r.amount_money as Json)?.currency || "USD"), status: String(r.status || ""), body: r, location_id: null }, { onConflict: "id" });
    } else if (type === "invoice.payment_made" || type === "invoice.updated" || type === "invoice.canceled") {
      const inv = (obj.invoice as Json) || {};
      const sqStatus = String(inv.status || "");
      const paid = type === "invoice.payment_made" || sqStatus === "PAID";
      const status = type === "invoice.canceled" || sqStatus === "CANCELED" ? "canceled" : paid ? "paid" : sqStatus === "PARTIALLY_PAID" ? "partial" : "sent";
      const { data: row } = await db.from("invoices").select("id,body").eq("square_invoice_id", String(inv.id)).maybeSingle();
      const invoice = row as { id: string; body: Json } | null;
      if (invoice) {
        await db.from("invoices").update({ status, body: { ...invoice.body, status, squareStatus: sqStatus, paidAt: paid ? new Date().toISOString() : invoice.body.paidAt }, rev: nowMs() }).eq("id", invoice.id);
        if (paid) {
          const ids = (invoice.body.tripIds as string[]) || [];
          for (const id of ids) {
            const { data: t } = await db.from("trips").select("body").eq("id", id).maybeSingle();
            const tb = (t as { body: Json } | null)?.body; if (!tb) continue;
            await db.from("trips").update({ body: { ...tb, payment: { ...((tb.payment as Json) || {}), status: "paid", invoiceId: invoice.id, paidAt: new Date().toISOString() } }, rev: nowMs() }).eq("id", id);
          }
        }
      }
    } else if (type === "card.forgotten") {
      const card = (obj.card as Json) || {};
      const custId = String(card.customer_id || "");
      if (custId) {
        for (const table of ["passengers", "accounts"]) {
          const { data: rows } = await db.from(table).select("id,body").eq("square_customer_id", custId);
          for (const r of (rows || []) as { id: string; body: Json }[]) {
            const cards = ((r.body.cards as Json[]) || []).filter((c) => c.squareCardId !== card.id);
            await db.from(table).update({ body: { ...r.body, cards }, rev: nowMs() }).eq("id", r.id);
          }
        }
      }
    } else if (type === "customer.updated") {
      const c = (obj.customer as Json) || {};
      if (c.id) await db.from("passengers").update({ email: (c.email_address as string) || null, rev: nowMs() }).eq("square_customer_id", String(c.id));
    } else {
      console.log("unhandled square event", type);
    }
    await db.from("square_events").update({ processed_at: new Date().toISOString() }).eq("event_id", eventId);
  } catch (e) {
    console.error("square-hook", type, e instanceof Error ? e.message : e);
    // release the idempotency row so Square's retry (up to 72 h, exponential) reprocesses the event
    await db.from("square_events").delete().eq("event_id", eventId);
    return text("error", 500);
  }
  return text("ok", 200);
});
