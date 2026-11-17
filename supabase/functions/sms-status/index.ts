// sms-status — Twilio StatusCallback webhook: queued → sent → delivered / undelivered / failed.
// Deploy with:  supabase functions deploy sms-status --no-verify-jwt
// Updates messages.status by MessageSid; the console shows a check mark / red icon on the trip card.
import { admin, readForm, text } from "../_shared/db.ts";
import { validateSignature, webhookUrl } from "../_shared/twilio.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return text("POST only", 405);
  const { params } = await readForm(req);
  const ok = await validateSignature(req.headers.get("x-twilio-signature"), webhookUrl(req), params);
  if (!ok) return text("invalid signature", 403);

  const sid = params.MessageSid || params.SmsSid;
  const status = params.MessageStatus || params.SmsStatus;
  if (!sid || !status) return text("missing MessageSid/MessageStatus", 400);

  const db = admin();
  const { data: row } = await db.from("messages").select("id,body,trip_id,template").eq("twilio_sid", sid).maybeSingle();
  if (!row) return text("ok (unknown sid)", 200);      // a text sent outside the app; nothing to update
  const r = row as { id: string; body: Record<string, unknown>; trip_id: string | null; template: string | null };
  const body = { ...r.body, lastStatus: status, statusAt: new Date().toISOString() };
  if (params.ErrorCode) body.errorCode = params.ErrorCode;
  await db.from("messages").update({ status, body, rev: Date.now() }).eq("id", r.id);

  // failed passenger texts land in Needs-you ("Call instead")
  if ((status === "failed" || status === "undelivered") && r.trip_id) {
    await db.from("needs_you").insert({ location_id: (params.To && "") || "", kind: "sms_failed", trip_id: r.trip_id, note: `Text "${r.template}" to ${params.To} ${status} (code ${params.ErrorCode || "?"}) — call instead.` })
      .then(({ error }) => { if (error) console.error(error.message); });
  }
  return text("ok", 200);
});
