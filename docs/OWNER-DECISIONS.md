# Owner decisions — checklist

These are the 14 decisions from the product design (section 12) that only the owner can make. Each one has a **recommended default**; the build proceeds with the default unless you say otherwise. Tick the box, write your answer, and hand this page back.

Where to find the technical hook for each decision is noted in *italics* so the developer can wire your answer in.

---

- [ ] **1. The business phone number for texts.**
  Which number should texts come from? Is it a landline/VoIP line (we text-enable it with **Twilio Hosted SMS**; calls stay exactly where they are) or can it be **ported** to Twilio (calls get forwarded; caller-ID screen-pop becomes automatic)? Who signs the Letter of Authorization, and who can supply a recent phone bill and the business EIN for 10DLC?
  **Recommended default:** keep the existing number, Hosted SMS (voice untouched). Interim: a verified toll-free "Skyway text line" until Hosted SMS and 10DLC are approved.
  *Hook: `locations.twilio_messaging_sid`, `locations.body.sms_number`; Twilio Messaging Service sender.*
  Your answer: ______________________

- [ ] **2. Domain for links.**
  Which domain for `app.` (console), `go.` (short links inside texts), `book.` and `track.`? Short links in texts must be on your own domain (carriers filter third-party shorteners).
  **Recommended default:** one domain you already own, e.g. `app.skywaycar.com` and `go.skywaycar.com`, both on Cloudflare Pages.
  *Hook: `PUBLIC_BASE_URL` secret on the Edge Functions; Cloudflare Pages `_redirects` for `/d/`, `/j/`, `/t/`, `/r/`.*
  Your answer: ______________________

- [ ] **3. Square.**
  Use the existing Square account? Do you want an in-car reader ($49–299)? Which driver-payout method: bank ACH/CSV, Square Payroll, or Gusto/Melio?
  **Recommended default:** existing Square account, production + sandbox app; no reader for the pilot; payouts by bank ACH/CSV (the Earnings tab already produces the numbers).
  *Hook: `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`; `settlements.method`.*
  Your answer: ______________________

- [ ] **4. Automatic gratuity on account rides and the no-show fee rule.**
  Percent, and for which accounts? What is charged for a no-show (flat amount, % of fare, nothing)?
  **Recommended default:** no automatic gratuity until accounts ask; no-show fee = the base fare, charged only when a card is on file and only by the dispatcher (never automatically).
  *Hook: `settings.autoGratuityPct` (used by `square-charge` capture), `accounts.body.autoGratuityPct`, Money panel "No-show fee".*
  Your answer: ______________________

- [ ] **5. Hold at booking.**
  For card rides, OK to hold the estimate **plus 20 %** on the passenger's card (covers tolls and waiting), or hold the estimate only?
  **Recommended default:** estimate + 20 %; it releases automatically when the final charge is smaller.
  *Hook: `HOLD_FACTOR` in `supabase/functions/square-charge/index.ts`.*
  Your answer: ______________________

- [ ] **6. Who is a dispatcher, who is the owner (admin PIN), and should drivers see fares on offers?**
  **Recommended default:** the owner holds the admin PIN and Expert mode; every other station is a dispatcher; drivers **do** see the fare on job offers (it lowers declines) except on Account rides, which show "Account – no cash".
  *Hook: `settings.adminPin`; user roles in Supabase Auth app_metadata; `offer-job` template `driverJob`.*
  Your answer: ______________________

- [ ] **7. Driver tracking policy.**
  On-shift-only tracking (recommended) with 30-day raw retention, then daily summaries. Please supply or approve the written consent text drivers see when they connect a phone.
  **Recommended default:** agree; consent text: "Skyway tracks this phone's location only while you are On shift, to dispatch jobs and show passengers their ETA. Raw location data is kept 30 days."
  *Hook: `drivers.body.consentAt`, `roll_driver_locations()` in `schema.sql` (pg_cron).*
  Your answer: ______________________

- [ ] **8. Passenger consent wording** for phone bookings.
  Dispatchers must say it, or it must be on the website/widget: "By booking you agree to receive ride updates by text; reply STOP to opt out."
  **Recommended default:** that sentence, printed on the dispatcher cheat sheet and shown on `book.html`.
  *Hook: 10DLC campaign "opt-in description"; template `booked`.*
  Your answer: ______________________

- [ ] **9. Store app (Phase 7).**
  Publish under the business's own Apple Developer ($99/yr) and Google Play ($25 once) accounts, or under the developer's?
  **Recommended default:** the business's own accounts (you keep the listing, the reviews and the keys if the developer changes).
  Your answer: ______________________

- [ ] **10. Region plan.**
  NYC only for now, or is a second region (which city?) wanted within the year? This decides when the Phase 5 region work is prioritized.
  **Recommended default:** NYC only; the schema already carries `location_id` so a second region is a Settings task later.
  *Hook: `locations` table; Settings → Region card; `skyway.anon_sync_locations` in `schema.sql`.*
  Your answer: ______________________

- [ ] **11. Simple mode default.**
  Simple mode on for everyone with Expert mode behind the PIN (recommended), or Expert mode on for the owner's station?
  **Recommended default:** Simple mode for all stations; the owner unlocks Expert mode with the PIN when needed.
  *Hook: `settings.simpleMode`, `settings.expertMode`.*
  Your answer: ______________________

- [ ] **12. Flight data provider.**
  AeroDataBox (cheaper, ~$10–30/mo) vs FlightAware AeroAPI (more accurate, ~$20–50/mo).
  **Recommended default:** AeroDataBox for the pilot; switch if airport pickups show late/missing updates.
  *Hook: `flight-poll` function (Phase 6).*
  Your answer: ______________________

- [ ] **13. AI assistant and affiliate farm-out.**
  Wanted in Phase 8 or parked? (AI drafts trips from passenger texts; the dispatcher always confirms. Affiliate farm-out sends a job to a partner's phone as a read-only link.)
  **Recommended default:** parked; revisit after launch.
  Your answer: ______________________

- [ ] **14. Budget sign-off.**
  About **$200–400 / month** running cost (Supabase, Twilio, Google Maps, Square processing on card volume only) and **about 20 weeks** of one full-stack developer, plus your time for testing.
  **Recommended default:** approve Phases 0–4 now (cloud, phones, texting, payments — about 11 weeks); approve Phases 5–8 after the Phase 4 review.
  Your answer: ______________________

---

### Already decided by the design (no action needed)

- Nothing in the current console is removed; `index.html` only gets script tags (Appendix D).
- Cloud is **off by default** and can be turned off at any time (rollback = pure local app).
- The reconciliation report must match to the cent before "Cloud on" is relied upon.
- Every automatic action (auto-assign cascade, auto-arrived, auto-charge, airport fee) is a toggle with Undo.
