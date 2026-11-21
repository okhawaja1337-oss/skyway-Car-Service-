# Owner decisions — checklist

**Status: all 14 decided on the recommended defaults (2026-11-21). Hooks wired in code are listed per item.**

These are the 14 decisions from the product design (section 12) that only the owner can make. Each one has a **recommended default**; the owner accepted every default on 2026-11-21, so the build proceeds exactly as described under "Recommended default" below. Any later change is a Settings change (or a one-line config edit) — the "Wired:" line under each item says where.

Where to find the technical hook for each decision is noted in *italics*; the **Wired:** line says which file / function now carries the decided value.

---

- [x] **1. The business phone number for texts.**
  Which number should texts come from? Is it a landline/VoIP line (we text-enable it with **Twilio Hosted SMS**; calls stay exactly where they are) or can it be **ported** to Twilio (calls get forwarded; caller-ID screen-pop becomes automatic)? Who signs the Letter of Authorization, and who can supply a recent phone bill and the business EIN for 10DLC?
  **Recommended default:** keep the existing number, Hosted SMS (voice untouched). Interim: a verified toll-free "Skyway text line" until Hosted SMS and 10DLC are approved.
  *Hook: `locations.twilio_messaging_sid`, `locations.body.sms_number`; Twilio Messaging Service sender.*
  Your answer: Recommended default — accepted 2026-11-21. Keep the existing business number; Twilio Hosted SMS (voice untouched); interim verified toll-free "Skyway text line" until Hosted SMS + 10DLC are approved.
  Wired: `supabase/functions/sms-in/index.ts` (resolves the location by the number the passenger/driver texted — `locations.body.sms_number`, falling back to `body.phone_e164`, so the hosted number and the interim toll-free line both route to `nyc`) + `docs/SETUP.md` §4 (Hosted SMS is the primary path; porting is the alternative).

- [x] **2. Domain for links.**
  Which domain for `app.` (console), `go.` (short links inside texts), `book.` and `track.`? Short links in texts must be on your own domain (carriers filter third-party shorteners).
  **Recommended default:** one domain you already own, e.g. `app.skywaycar.com` and `go.skywaycar.com`, both on Cloudflare Pages.
  *Hook: `PUBLIC_BASE_URL` secret on the Edge Functions; Cloudflare Pages `_redirects` for `/d/`, `/j/`, `/t/`, `/r/`.*
  Your answer: Recommended default — accepted 2026-11-21. One owned domain: `app.<domain>` for the console, `go.<domain>` for short links, both on the same Cloudflare Pages project.
  Wired: `_redirects` at the repository root (the `/d/ /j/ /t/ /r/` short-link rules now exist in the repo) + the `PUBLIC_BASE_URL` Edge Function secret (`supabase/functions/_shared/db.ts`), set to `https://go.<domain>` per `docs/SETUP.md` §3.6.

- [x] **3. Square.**
  Use the existing Square account? Do you want an in-car reader ($49–299)? Which driver-payout method: bank ACH/CSV, Square Payroll, or Gusto/Melio?
  **Recommended default:** existing Square account, production + sandbox app; no reader for the pilot; payouts by bank ACH/CSV (the Earnings tab already produces the numbers).
  *Hook: `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`; `settlements.method`.*
  Your answer: Recommended default — accepted 2026-11-21. Existing Square account, production + sandbox app; no card reader for the pilot; driver payouts by bank ACH/CSV from the Earnings tab.
  Wired: `supabase/schema.sql` (`settlements.method` default `'ach_csv'`, check constraint lists the other methods for later) + `SQUARE_ACCESS_TOKEN` / `SQUARE_LOCATION_ID` secrets (`docs/SETUP.md` §5).

- [x] **4. Automatic gratuity on account rides and the no-show fee rule.**
  Percent, and for which accounts? What is charged for a no-show (flat amount, % of fare, nothing)?
  **Recommended default:** no automatic gratuity until accounts ask; no-show fee = the base fare, charged only when a card is on file and only by the dispatcher (never automatically).
  *Hook: `settings.autoGratuityPct` (used by `square-charge` capture), `accounts.body.autoGratuityPct`, Money panel "No-show fee".*
  Your answer: Recommended default — accepted 2026-11-21. 0 % gratuity (per-account override available); no-show fee = base fare, card on file, dispatcher-only button — never automatic.
  Wired: `money.js` (`settings.autoGratuityPct` seeded to `0`; `accounts[].autoGratuityPct` overrides it; MONEY → "No-shows" list with the **Charge no-show fee** button, enabled only when a card is on file) + `supabase/functions/square-charge/index.ts` (capture applies the same gratuity rule; both default 0).

- [x] **5. Hold at booking.**
  For card rides, OK to hold the estimate **plus 20 %** on the passenger's card (covers tolls and waiting), or hold the estimate only?
  **Recommended default:** estimate + 20 %; it releases automatically when the final charge is smaller.
  *Hook: `HOLD_FACTOR` in `supabase/functions/square-charge/index.ts`.*
  Your answer: Recommended default — accepted 2026-11-21. Hold estimate + 20 % on card rides; the hold releases automatically when the final charge is smaller.
  Wired: hook ready (`settings.holdFactor` 1.2, clamped 1.0–1.5, read by `supabase/functions/square-charge/index.ts`; capture releases the unused part of the hold) — not yet triggered: the console does not call square-charge authorize/capture until the Money build lands.

- [x] **6. Who is a dispatcher, who is the owner (admin PIN), and should drivers see fares on offers?**
  **Recommended default:** the owner holds the admin PIN and Expert mode; every other station is a dispatcher; drivers **do** see the fare on job offers (it lowers declines) except on Account rides, which show "Account — no cash".
  *Hook: `settings.adminPin`; user roles in Supabase Auth app_metadata; `offer-job` template `driverJob`.*
  Your answer: Recommended default — accepted 2026-11-21. Owner holds the admin PIN + Expert mode; every other station is a dispatcher; drivers see the fare on offers, Account rides show "Account — no cash".
  Wired: `simple.js` (`settings.adminPin`, Settings → Admin PIN) + the `driverJob` template's `{fareOrAccount}` variable in `messages.js` (console texts), `supabase/functions/_shared/templates.ts` / `offer-job` (server offers) and `driver.js` (payment line on the driver page). Note on punctuation: on screen (driver page, docs) the phrase is "Account — no cash"; in **texts** it goes out with a plain hyphen — "Account - no cash", and "JOB #12 - Today 3:40 PM" — because one em dash switches the whole SMS to UCS-2 (70 chars/segment) and turns a 2-segment offer into 3–4 segments. This is automatic: `twilio.ts` `sendSms()` / `twiml()` and the console's `messages.js` `smsHref()` / copy swap dashes, arrows, curly quotes and ellipses for GSM-7 characters as the text leaves; the templates keep their typography on screen. "Account ride" has one definition everywhere (pay type first; the account only when the pay type is blank): `messages.js` `isAccountTrip()`, `driver-link.js` `isAccountRide()`, `driver.js` `fareLine()`, `templates.ts` `isAccountRide()`.

- [x] **7. Driver tracking policy.**
  On-shift-only tracking (recommended) with 30-day raw retention, then daily summaries. Please supply or approve the written consent text drivers see when they connect a phone.
  **Recommended default:** agree; consent text: "Skyway tracks this phone's location only while you are On shift, to dispatch jobs and show passengers their ETA. Raw location data is kept 30 days."
  *Hook: `drivers.body.consentAt`, `roll_driver_locations()` in `schema.sql` (pg_cron).*
  Your answer: Recommended default — accepted 2026-11-21. On-shift-only tracking; 30-day raw retention then daily summaries; consent text exactly as above.
  Wired: `driver.js` shows the consent text and records `consentAt` on the phone (`localStorage`) when the driver taps **I agree**, then sends it with the connect POST (`connect-invite` action `complete`) and in every `'L'` location text (`L #12 40.7,-73.9 … consent:<ISO>`); `connect-invite` refuses to record consent under any wording other than the approved sentence (`CONSENT_TEXT`, one definition in `supabase/functions/_shared/templates.ts`, byte-identical to `driver.js`), and `sms-in` records `drivers.body.consentAt` from the first `'L'` text that carries it. The phone's **On shift** toggle only gates whether the phone sends GPS pins; `onShift` is set **in the console** by the first GPS pin (`driver-link.js` `ingestLocation()`) and cleared by Driver IQ → Driver status → **Off shift** (`DriverLink.setShift`) or a driver **OFF** text (`sms-in` sets `drivers.body.onShift` and the `on_shift` column; **ON** turns it back on); the schema trigger mirrors `body.onShift` to `drivers.on_shift`. + `supabase/schema.sql` (`roll_driver_locations()` keeps 30 days of raw points, then daily totals; scheduled in `docs/SETUP.md` §3.7).

- [x] **8. Passenger consent wording** for phone bookings.
  Dispatchers must say it, or it must be on the website/widget: "By booking you agree to receive ride updates by text; reply STOP to opt out."
  **Recommended default:** that sentence, printed on the dispatcher cheat sheet and shown on `book.html`.
  *Hook: 10DLC campaign "opt-in description"; template `booked`.*
  Your answer: Recommended default — accepted 2026-11-21. Exactly: "By booking you agree to receive ride updates by text; reply STOP to opt out." — on the cheat sheet, under the Booked template, and on `book.html` when that page is built (it does not exist yet).
  Wired: `messages.js` (`Messages.consentSentence`; shown under the `booked` template in Settings → Messages) + `simple.js` (printed on the dispatcher cheat sheet, Settings → Print cheat sheet). `book.html` is not built yet — it must show the same sentence when it is.

- [x] **9. Store app (Phase 7).**
  Publish under the business's own Apple Developer ($99/yr) and Google Play ($25 once) accounts, or under the developer's?
  **Recommended default:** the business's own accounts (you keep the listing, the reviews and the keys if the developer changes).
  Your answer: Recommended default — accepted 2026-11-21. Publish under the business's own Apple Developer and Google Play accounts.
  Wired: docs only (`docs/PRODUCT-DESIGN.md` §12; the Phase 7 store app is not built yet).

- [x] **10. Region plan.**
  NYC only for now, or is a second region (which city?) wanted within the year? This decides when the Phase 5 region work is prioritized.
  **Recommended default:** NYC only; the schema already carries `location_id` so a second region is a Settings task later.
  *Hook: `locations` table; Settings → Region card; `skyway.anon_sync_locations` in `schema.sql`.*
  Your answer: Recommended default — accepted 2026-11-21. NYC only; a second region is a Settings → Region task later.
  Wired: `region.js` (`DEFAULTS` = New York / US / America/New_York / USD / miles / +1; Settings → Region card) + `supabase/schema.sql` (`locations` seeded with `nyc`; every table carries `location_id`).

- [x] **11. Simple mode default.**
  Simple mode on for everyone with Expert mode behind the PIN (recommended), or Expert mode on for the owner's station?
  **Recommended default:** Simple mode for all stations; the owner unlocks Expert mode with the PIN when needed.
  *Hook: `settings.simpleMode`, `settings.expertMode`.*
  Your answer: Recommended default — accepted 2026-11-21. Simple mode for all stations; the owner unlocks Expert mode with the admin PIN.
  Wired: `simple.js` (`settings.simpleMode` seeded `true` on first run; `settings.adminPin` is a 4-digit PIN stored in the settings body). The PIN lives in settings, which are **per browser**: set it on every station, or set it once after Cloud sync is on (`sync.js` syncs settings, PIN included, to all stations). Once set, opening **Settings** or **Expert mode** on that station asks for the PIN once per session, so dispatchers stay in Simple mode; they only need it to open Settings (e.g. to print the cheat sheet) — the daily Today/Book/Board/Drivers/Money screens never ask for it.

- [x] **12. Flight data provider.**
  AeroDataBox (cheaper, ~$10–30/mo) vs FlightAware AeroAPI (more accurate, ~$20–50/mo).
  **Recommended default:** AeroDataBox for the pilot; switch if airport pickups show late/missing updates.
  *Hook: `flight-poll` function (Phase 6).*
  Your answer: Recommended default — accepted 2026-11-21. AeroDataBox for the pilot; switch to FlightAware if airport pickups show late/missing updates.
  Wired: `region.js` (`settings.flightProvider` seeded `'aerodatabox'`, shown as "Flight data: AeroDataBox (Phase 6)" on the Settings → Region card); the Phase 6 `flight-poll` function will read that setting. See `docs/SETUP.md` §6b.

- [x] **13. AI assistant and affiliate farm-out.**
  Wanted in Phase 8 or parked? (AI drafts trips from passenger texts; the dispatcher always confirms. Affiliate farm-out sends a job to a partner's phone as a read-only link.)
  **Recommended default:** parked; revisit after launch.
  Your answer: Recommended default — accepted 2026-11-21. Parked; revisit after launch.
  Wired: docs only (nothing is built for either feature; `docs/PRODUCT-DESIGN.md` §12).

- [x] **14. Budget sign-off.**
  About **$200–400 / month** running cost (Supabase, Twilio, Google Maps, Square processing on card volume only) and **about 20 weeks** of one full-stack developer, plus your time for testing.
  **Recommended default:** approve Phases 0–4 now (cloud, phones, texting, payments — about 11 weeks); approve Phases 5–8 after the Phase 4 review.
  Your answer: Recommended default — accepted 2026-11-21. Phases 0–4 approved now (cloud, phones, texting, payments; ~11 weeks); Phases 5–8 after the Phase 4 review; ~$200–400/month running cost.
  Wired: docs only (`docs/PRODUCT-DESIGN.md` roadmap; `docs/SETUP.md` covers the Phase 0–4 accounts).

---

### Already decided by the design (no action needed)

- Nothing in the current console is removed; `index.html` only gets script tags (Appendix D).
- Cloud is **off by default** and can be turned off at any time (rollback = pure local app).
- The reconciliation report must match to the cent before "Cloud on" is relied upon.
- Every automatic action (auto-assign cascade, auto-arrived, auto-charge, airport fee) is a toggle with Undo.
