// Square helpers: Payments (delayed capture), Checkout payment links, Orders +
// Invoices, Refunds, webhook signature verification.
// Env vars:
//   SQUARE_ACCESS_TOKEN            production (or sandbox) access token. Owner decision 3: personal access token
//                                  for the pilot; OAuth Connect later if a second location is added
//   SQUARE_LOCATION_ID             default Square location (locations.square_location_id overrides)
//   SQUARE_WEBHOOK_SIGNATURE_KEY   from the webhook subscription in the Square developer dashboard
//   SQUARE_ENV                     "production" (default) | "sandbox"
import { HttpError, Json } from "./db.ts";

export const SQUARE_VERSION = "2024-10-17";

export function squareBase(): string {
  return (Deno.env.get("SQUARE_ENV") || "production") === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}

export function squareLocationId(override?: string | null): string {
  const id = override || Deno.env.get("SQUARE_LOCATION_ID");
  if (!id) throw new HttpError(500, "SQUARE_LOCATION_ID is not set");
  return id;
}

export interface Money {
  amount: number;      // minor units (cents)
  currency: string;    // ISO-4217
}

export function money(amountCents: number, currency = "USD"): Money {
  return { amount: Math.max(0, Math.round(amountCents)), currency };
}

async function sq<T = Json>(path: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: Json, accessToken?: string): Promise<T> {
  const token = accessToken || Deno.env.get("SQUARE_ACCESS_TOKEN");
  if (!token) throw new HttpError(500, "SQUARE_ACCESS_TOKEN is not set");
  const res = await fetch(squareBase() + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Json & { errors?: { code: string; detail?: string; category?: string }[] };
  if (!res.ok) {
    const e = data.errors && data.errors[0];
    throw new HttpError(502, `Square ${res.status}: ${e ? `${e.code} ${e.detail || ""}` : "request failed"}`);
  }
  return data as T;
}

export interface CreatePaymentInput {
  idempotencyKey: string;          // e.g. `${trip.id}:auth`
  amount: Money;
  sourceId: string;                // card-on-file id (ccof:…) or a Web Payments SDK token
  customerId?: string;             // required with a card on file
  locationId?: string;
  autocomplete: boolean;           // false = authorize only (delayed capture, 7-day hold)
  referenceId?: string;            // dispatchNo
  note?: string;                   // route
  tip?: Money;
  delayDuration?: string;          // ISO-8601, default P7D
  statementDescription?: string;
}

/** Payments API: POST /v2/payments */
export function createPayment(input: CreatePaymentInput, accessToken?: string): Promise<{ payment: Json }> {
  return sq("/v2/payments", "POST", {
    idempotency_key: input.idempotencyKey,
    amount_money: { amount: input.amount.amount, currency: input.amount.currency },
    source_id: input.sourceId,
    customer_id: input.customerId,
    location_id: squareLocationId(input.locationId),
    autocomplete: input.autocomplete,
    reference_id: input.referenceId,
    note: input.note,
    tip_money: input.tip ? { amount: input.tip.amount, currency: input.tip.currency } : undefined,
    delay_duration: input.autocomplete ? undefined : input.delayDuration || "P7D",
    delay_action: input.autocomplete ? undefined : "CANCEL",
    statement_description_identifier: input.statementDescription,
  }, accessToken);
}

/** PUT /v2/payments/{id} — adjust amount/tip of an approved (uncaptured) payment, only downward or equal. */
export function updatePayment(paymentId: string, idempotencyKey: string, amount: Money, tip?: Money, accessToken?: string): Promise<{ payment: Json }> {
  return sq(`/v2/payments/${encodeURIComponent(paymentId)}`, "PUT", {
    idempotency_key: idempotencyKey,
    payment: {
      amount_money: { amount: amount.amount, currency: amount.currency },
      tip_money: tip ? { amount: tip.amount, currency: tip.currency } : undefined,
    },
  }, accessToken);
}

/** POST /v2/payments/{id}/complete — capture an authorized payment. */
export function completePayment(paymentId: string, accessToken?: string): Promise<{ payment: Json }> {
  return sq(`/v2/payments/${encodeURIComponent(paymentId)}/complete`, "POST", {}, accessToken);
}

/** POST /v2/payments/{id}/cancel — release a hold. */
export function cancelPayment(paymentId: string, accessToken?: string): Promise<{ payment: Json }> {
  return sq(`/v2/payments/${encodeURIComponent(paymentId)}/cancel`, "POST", {}, accessToken);
}

export function getPayment(paymentId: string, accessToken?: string): Promise<{ payment: Json }> {
  return sq(`/v2/payments/${encodeURIComponent(paymentId)}`, "GET", undefined, accessToken);
}

/** POST /v2/refunds */
export function refundPayment(paymentId: string, idempotencyKey: string, amount: Money, reason: string, accessToken?: string): Promise<{ refund: Json }> {
  return sq("/v2/refunds", "POST", {
    idempotency_key: idempotencyKey,
    payment_id: paymentId,
    amount_money: { amount: amount.amount, currency: amount.currency },
    reason,
  }, accessToken);
}

export interface PaymentLinkInput {
  idempotencyKey: string;
  name: string;                    // "Skyway ride #4521"
  amount: Money;
  locationId?: string;
  redirectUrl?: string;            // pay.html?t=<token>
  allowTipping?: boolean;
  note?: string;
  customerEmail?: string;
}

/** Checkout API: POST /v2/online-checkout/payment-links (quick_pay) */
export function createPaymentLink(input: PaymentLinkInput, accessToken?: string): Promise<{ payment_link: Json & { url: string; id: string; order_id?: string } }> {
  return sq("/v2/online-checkout/payment-links", "POST", {
    idempotency_key: input.idempotencyKey,
    quick_pay: {
      name: input.name,
      price_money: { amount: input.amount.amount, currency: input.amount.currency },
      location_id: squareLocationId(input.locationId),
    },
    checkout_options: {
      allow_tipping: input.allowTipping !== false,
      redirect_url: input.redirectUrl,
      ask_for_shipping_address: false,
    },
    pre_populated_data: input.customerEmail ? { buyer_email: input.customerEmail } : undefined,
    payment_note: input.note,
  }, accessToken);
}

export interface OrderLine {
  name: string;
  quantity: string;                // Square wants a string, e.g. "1"
  amount: Money;
  note?: string;
}

/** Orders API: POST /v2/orders — one line per trip plus the CCU fee line. */
export function createOrder(idempotencyKey: string, lines: OrderLine[], opts: { locationId?: string; customerId?: string; referenceId?: string } = {}, accessToken?: string): Promise<{ order: Json & { id: string } }> {
  return sq("/v2/orders", "POST", {
    idempotency_key: idempotencyKey,
    order: {
      location_id: squareLocationId(opts.locationId),
      customer_id: opts.customerId,
      reference_id: opts.referenceId,
      line_items: lines.map((l) => ({
        name: l.name,
        quantity: l.quantity,
        base_price_money: { amount: l.amount.amount, currency: l.amount.currency },
        note: l.note,
      })),
    },
  }, accessToken);
}

export interface CreateInvoiceInput {
  idempotencyKey: string;
  orderId: string;
  customerId: string;
  locationId?: string;
  title: string;                   // "Skyway Car Service — November 2026"
  invoiceNumber: string;           // console's invoiceNo
  dueDate: string;                 // YYYY-MM-DD (accounts.net_days)
  description?: string;
  customFields?: { label: string; value: string; placement?: "ABOVE_LINE_ITEMS" | "BELOW_LINE_ITEMS" }[];
  acceptCard?: boolean;
  acceptAch?: boolean;
  scheduledAt?: string;            // RFC 3339; omit to publish immediately
}

/** Invoices API: POST /v2/invoices (draft) — then publishInvoice() sends the email. */
export function createInvoice(input: CreateInvoiceInput, accessToken?: string): Promise<{ invoice: Json & { id: string; version: number } }> {
  return sq("/v2/invoices", "POST", {
    idempotency_key: input.idempotencyKey,
    invoice: {
      location_id: squareLocationId(input.locationId),
      order_id: input.orderId,
      primary_recipient: { customer_id: input.customerId },
      payment_requests: [{ request_type: "BALANCE", due_date: input.dueDate, automatic_payment_source: "NONE" }],
      delivery_method: "EMAIL",
      invoice_number: input.invoiceNumber,
      title: input.title,
      description: input.description,
      scheduled_at: input.scheduledAt,
      accepted_payment_methods: { card: input.acceptCard !== false, square_gift_card: false, bank_account: input.acceptAch !== false, buy_now_pay_later: false },
      custom_fields: (input.customFields || []).map((f) => ({ label: f.label, value: f.value, placement: f.placement || "ABOVE_LINE_ITEMS" })),
    },
  }, accessToken);
}

/** POST /v2/invoices/{id}/publish */
export function publishInvoice(invoiceId: string, version: number, idempotencyKey: string, accessToken?: string): Promise<{ invoice: Json }> {
  return sq(`/v2/invoices/${encodeURIComponent(invoiceId)}/publish`, "POST", { version, idempotency_key: idempotencyKey }, accessToken);
}

/** Customers API: find-or-create by reference (phone E.164 or account number). */
export async function ensureCustomer(referenceId: string, given: { name?: string; email?: string; phone?: string }, accessToken?: string): Promise<string> {
  const found = await sq<{ customers?: { id: string }[] }>("/v2/customers/search", "POST", {
    query: { filter: { reference_id: { exact: referenceId } } }, limit: 1,
  }, accessToken);
  if (found.customers && found.customers[0]) return found.customers[0].id;
  const parts = (given.name || "").trim().split(/\s+/);
  const created = await sq<{ customer: { id: string } }>("/v2/customers", "POST", {
    idempotency_key: `cust:${referenceId}`,
    reference_id: referenceId,
    given_name: parts[0] || undefined,
    family_name: parts.slice(1).join(" ") || undefined,
    email_address: given.email || undefined,
    phone_number: given.phone || undefined,
  }, accessToken);
  return created.customer.id;
}

/** ListPayments for a day (nightly reconcile-square). */
export function listPayments(beginRfc3339: string, endRfc3339: string, locationId?: string, cursor?: string, accessToken?: string): Promise<{ payments?: Json[]; cursor?: string }> {
  const q = new URLSearchParams({ begin_time: beginRfc3339, end_time: endRfc3339, location_id: squareLocationId(locationId) });
  if (cursor) q.set("cursor", cursor);
  return sq(`/v2/payments?${q.toString()}`, "GET", undefined, accessToken);
}

/**
 * Webhook signature: base64(HMAC-SHA256(signatureKey, notificationUrl + rawBody))
 * compared with the `x-square-hmacsha256-signature` header.
 */
export async function verifyWebhookSignature(signatureHeader: string | null, notificationUrl: string, rawBody: string, signatureKey?: string): Promise<boolean> {
  if (!signatureHeader) return false;
  const keyStr = signatureKey || Deno.env.get("SQUARE_WEBHOOK_SIGNATURE_KEY");
  if (!keyStr) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyStr), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(notificationUrl + rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}
