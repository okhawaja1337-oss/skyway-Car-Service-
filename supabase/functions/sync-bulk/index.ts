// sync-bulk — first import + reconciliation (PRODUCT-DESIGN.md §9).
//
// POST (anon or dispatcher JWT) {
//   action: "import" | "reconcile",
//   location_id: "nyc",
//   collections?: { trips: [...], drivers: [...], vehicles: [...], accounts: [...], addrbook: [...],
//                   settings: {...}, config: { zones: ..., fares: ... }, invoices: [...], call_history: [...] },
//   dispatch_seq?: 4522, invoice_seq?: 1042,
//   rev?: 1731870000000
// }
// → { ok, imported: {trips: 1234, ...}, renumbered: [{id, from, to}], reconcile: <sync_reconcile()> }
//
// The console's sync.js does its own batched REST upload for everyday use; this
// function exists for the big first import (IndexedDB history, 500-row chunks,
// negative dispatchNo renumbering, sequence bump) and for the go/no-go report.
import { admin, HttpError, json, Json, nowMs, readJson, requireStr, serve } from "../_shared/db.ts";

const CHUNK = 500;
const ARRAY_TABLES = ["trips", "drivers", "vehicles", "accounts", "addrbook", "invoices"];

interface Body extends Json {
  action?: string;
  location_id: string;
  collections?: Record<string, unknown>;
  dispatch_seq?: number;
  invoice_seq?: number;
  rev?: number;
}

function rowId(table: string, x: Json): string {
  if (x.id !== undefined && x.id !== null && x.id !== "") return String(x.id);
  if (table === "addrbook") return "ab_" + fnv(String(x.address || "").trim().toLowerCase());
  throw new HttpError(400, `${table} row without id`);
}

/** Same FNV-1a + length tag as sync.js addrId() so both sides agree on addrbook ids. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8) + "." + s.length.toString(36);
}

async function upsertChunks(table: string, rows: Json[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await admin().from(table).upsert(chunk, { onConflict: "id" });
    if (error) throw new HttpError(500, `${table}: ${error.message}`);
    n += chunk.length;
  }
  return n;
}

serve(async (req) => {
  const body = await readJson<Body>(req, ["location_id"]);
  const loc = requireStr(body.location_id, "location_id");
  const action = body.action || "import";
  const db = admin();
  const rev = Number(body.rev) || nowMs();
  const imported: Record<string, number> = {};
  const renumbered: { id: string; from: number; to: number }[] = [];

  if (action === "import") {
    const c = (body.collections || {}) as Record<string, unknown>;

    // make sure the location exists so RLS / sequences have something to hang on
    await db.from("locations").upsert({ id: loc, name: loc }, { onConflict: "id", ignoreDuplicates: true });
    await db.rpc("bump_sequences", { loc, dispatch_seq: body.dispatch_seq ?? null, invoice_seq: body.invoice_seq ?? null });

    for (const table of ARRAY_TABLES) {
      const arr = Array.isArray(c[table]) ? (c[table] as Json[]) : [];
      if (!arr.length) continue;
      const rows: Json[] = [];
      for (const x of arr) {
        let b = x;
        // offline bookings carry a temporary negative dispatchNo: give them a real one now
        if (table === "trips" && typeof x.dispatchNo === "number" && x.dispatchNo < 0) {
          const { data, error } = await db.rpc("next_dispatch_no", { loc });
          if (error) throw new HttpError(500, error.message);
          renumbered.push({ id: rowId(table, x), from: x.dispatchNo, to: Number(data) });
          b = { ...x, dispatchNo: Number(data) };
        }
        rows.push({ id: rowId(table, b), location_id: loc, body: b, rev, deleted_at: null });
      }
      imported[table] = await upsertChunks(table, rows);
    }

    if (c.settings && typeof c.settings === "object") {
      const s = { ...(c.settings as Json) };
      delete s.gmapkey; delete s.cloud; delete s.geokey;           // browser-only keys never go to the server
      imported.settings = await upsertChunks("settings", [{ id: loc, location_id: loc, body: s, rev, deleted_at: null }]);
    }

    if (c.config && typeof c.config === "object") {
      const rows: Json[] = Object.entries(c.config as Json).map(([key, value]) => ({ id: `${loc}:${key}`, location_id: loc, key, body: { key, value }, rev, deleted_at: null }));
      imported.config = await upsertChunks("config", rows);
    }

    if (Array.isArray(c.call_history)) {
      const rows: Json[] = (c.call_history as Json[]).map((h, i) => ({
        id: String(h.id || `ch_${fnv(JSON.stringify(h))}_${i}`), location_id: loc,
        at: h.at ? new Date(String(h.at)).toISOString() : null, phone_e164: h.phone ? String(h.phone) : null,
        body: h, rev, deleted_at: null,
      }));
      imported.call_history = await upsertChunks("call_history", rows);
    }
  } else if (action !== "reconcile") {
    throw new HttpError(400, "action must be import or reconcile");
  }

  const { data: reconcile, error } = await db.rpc("sync_reconcile", { p_location_id: loc });
  if (error) throw new HttpError(500, error.message);
  return json({ ok: true, action, imported, renumbered, reconcile });
});
