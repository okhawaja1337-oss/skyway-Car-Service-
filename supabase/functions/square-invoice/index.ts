// square-invoice — "Send via Square" for corporate accounts (PRODUCT-DESIGN.md §6).
//
// POST { location_id, invoice_id?: <console invoice id>, account_id, trip_ids: [...], period: "2026-11",
//        ccu_cents?: <override>, pdf_url?: "https://…/storage/v1/object/…", due_days?: <accounts.net_days> }
// → Orders.CreateOrder (one line per trip: #dispatchNo date route fare+tolls; CCU fee as its own line)
// → Invoices.CreateInvoice (delivery EMAIL, payment_requests BALANCE due in net_days, custom field account number,
//   PDF link in description) → Invoices.PublishInvoice
// → invoices row {square_invoice_id, status:'sent', total}, trips.body.payment.invoiceId
// `invoice.payment_made` webhook (square-hook) later marks the invoice and its trips paid.
import { admin, getLocation, json, Json, nowMs, readJson, requireStr, serve, audit } from "../_shared/db.ts";
import { createInvoice, createOrder, ensureCustomer, money, OrderLine, publishInvoice } from "../_shared/square.ts";

interface Body extends Json {
  location_id: string;
  invoice_id?: string;
  account_id: string;
  trip_ids: string[];
  period?: string;
  ccu_cents?: number;
  pdf_url?: string;
  due_days?: number;
}

function cents(n: unknown): number { return Math.round((Number(n) || 0) * 100); }

serve(async (req) => {
  const body = await readJson<Body>(req, ["location_id", "account_id", "trip_ids"]);
  const loc = await getLocation(requireStr(body.location_id, "location_id"));
  const db = admin();
  const tripIds = Array.isArray(body.trip_ids) ? body.trip_ids.map(String) : [];
  if (!tripIds.length) return json({ error: "trip_ids is empty" }, 400);

  const { data: acct } = await db.from("accounts").select("*").eq("id", String(body.account_id)).maybeSingle();
  const account = acct as { id: string; number: string | null; name: string | null; email: string | null; square_customer_id: string | null; net_days: number | null; body: Json } | null;
  if (!account) return json({ error: "account not found" }, 404);
  const email = account.email || String(account.body.email || "");
  if (!email) return json({ error: "account has no email — Square delivers invoices by email" }, 400);

  const { data: trows } = await db.from("trips").select("id,dispatch_no,date,fare,tolls,body").in("id", tripIds).eq("location_id", loc.id).is("deleted_at", null);
  const trips = (trows || []) as { id: string; dispatch_no: number | null; date: string | null; fare: number | null; tolls: number | null; body: Json }[];
  if (!trips.length) return json({ error: "no trips found" }, 404);
  const { data: settingsRow } = await db.from("settings").select("body").eq("id", loc.id).maybeSingle();
  const settings = ((settingsRow as { body: Json } | null)?.body) || {};
  const currency = loc.currency || "USD";

  const lines: OrderLine[] = trips.map((t) => ({
    name: `#${t.dispatch_no ?? ""} ${t.date ?? ""} ${String(t.body.puAddr || "").split(",")[0]} → ${String(t.body.doAddr || "").split(",")[0]}`.slice(0, 512),
    quantity: "1",
    amount: money(cents(t.fare) + cents(t.tolls), currency),
    note: t.tolls ? `incl. tolls ${(Number(t.tolls) || 0).toFixed(2)}` : undefined,
  }));
  const ccuC = body.ccu_cents != null ? Math.round(Number(body.ccu_cents)) : cents(account.body.ccu ?? settings.ccu ?? 0) * trips.length;
  if (ccuC > 0) lines.push({ name: "CCU / processing fee", quantity: "1", amount: money(ccuC, currency) });
  const totalC = lines.reduce((s, l) => s + l.amount.amount, 0);

  const customerId = account.square_customer_id || await ensureCustomer(`acct:${account.number || account.id}`, { name: account.name || undefined, email, phone: String(account.body.phone || "") || undefined });
  if (!account.square_customer_id) await db.from("accounts").update({ square_customer_id: customerId, body: { ...account.body, squareCustomerId: customerId }, rev: nowMs() }).eq("id", account.id);

  const period = body.period || new Date().toISOString().slice(0, 7);
  const invoiceId = body.invoice_id || `inv_${account.id}_${period}`;
  // console invoice number: reuse the row's number or draw the next one from the per-location sequence
  const { data: existing } = await db.from("invoices").select("invoice_no,square_invoice_id,status").eq("id", invoiceId).maybeSingle();
  const ex = existing as { invoice_no: number | null; square_invoice_id: string | null; status: string | null } | null;
  if (ex?.square_invoice_id) return json({ ok: true, reused: true, square_invoice_id: ex.square_invoice_id, status: ex.status });
  let invoiceNo = ex?.invoice_no || null;
  if (!invoiceNo) { const { data: n } = await db.rpc("next_invoice_no", { loc: loc.id }); invoiceNo = Number(n); }

  const { order } = await createOrder(`${invoiceId}:order`, lines, { locationId: loc.square_location_id || undefined, customerId, referenceId: invoiceId });
  const netDays = Number(body.due_days ?? account.net_days ?? 30);
  const due = new Date(Date.now() + netDays * 86400000).toISOString().slice(0, 10);
  const title = `${settings.name || loc.name || "Skyway Car Service"} — ${period}`;
  const { invoice } = await createInvoice({
    idempotencyKey: `${invoiceId}:invoice`,
    orderId: order.id, customerId, locationId: loc.square_location_id || undefined,
    title, invoiceNumber: String(invoiceNo), dueDate: due,
    description: `${trips.length} trip(s) for ${account.name || ""}${body.pdf_url ? `. Detailed statement: ${body.pdf_url}` : ""}`,
    customFields: [{ label: "Account", value: String(account.number || account.id) }, { label: "Period", value: period }],
  });
  const { invoice: published } = await publishInvoice(invoice.id, invoice.version, `${invoiceId}:publish`);

  await db.from("invoices").upsert({
    id: invoiceId, location_id: loc.id, invoice_no: invoiceNo, account_id: account.id, period, total: totalC / 100, status: "sent",
    square_invoice_id: invoice.id, pdf_url: body.pdf_url || null, rev: nowMs(),
    body: { invoiceNo, accountId: account.id, period, total: totalC / 100, tripIds: trips.map((t) => t.id), squareInvoiceId: invoice.id, squareOrderId: order.id, publicUrl: published.public_url || null, status: "sent" },
  }, { onConflict: "id" });
  for (const t of trips) {
    const pay = (t.body.payment as Json) || {};
    await db.from("trips").update({ body: { ...t.body, payment: { ...pay, status: "invoiced", invoiceId, squareInvoiceId: invoice.id } }, rev: nowMs() }).eq("id", t.id);
  }
  await audit(loc.id, "square_invoice_sent", { actor: "dispatcher", body: { invoiceId, squareInvoiceId: invoice.id, totalC } });
  return json({ ok: true, invoice_id: invoiceId, invoice_no: invoiceNo, square_invoice_id: invoice.id, public_url: published.public_url || null, total_cents: totalC, due });
});
