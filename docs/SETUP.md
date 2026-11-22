# Skyway Grid — owner setup guide

This is the plain-English, step-by-step guide to turning the console into the cloud system described in `PRODUCT-DESIGN.md`. Nothing here changes how the console works today: **every feature below is a Settings toggle that is OFF until you turn it on**, and the last section tells you how to turn everything back off.

You will need about half a day for the accounts (most of it waiting on verification emails), and the developer will need the keys you collect. **Never paste a secret key into the console, into a text message or into this document** — secrets go only into Supabase "Secrets" (step 3.6) or Cloudflare.

Shopping list of accounts (all free to open): Cloudflare, Supabase, Twilio, Square developer, Google Cloud.

---

## 0. Before anything: back up

1. Open the console → **Settings → Backup & Data → Export / Backup**. Save the file somewhere safe (email it to yourself and put a copy in Google Drive).
2. The developer tags the current `index.html` in git as `v3-local`. This is the rollback point for everything that follows.

---

## 1. Host the console on Cloudflare Pages (HTTPS)

Why: phones only share GPS, install as an app and receive push over HTTPS. The localhost launchers (`start-skyway.bat` / `.command`) keep working as before.

1. Sign in at https://dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git** (or **Upload assets** to drag the folder in).
2. Pick the repository, branch `main`. Build command: *(leave empty)*. Build output directory: `/` (the repository root — it is a static site).
3. Press **Save and Deploy**. You get a `https://<name>.pages.dev` address in about a minute.
4. **Custom domain:** Pages project → **Custom domains → Set up a custom domain** → `app.<yourdomain>` (console) and `go.<yourdomain>` (the short links inside texts). Cloudflare adds the DNS records for you if the domain is on Cloudflare; otherwise add the CNAME it shows.
5. Short links: the file `_redirects` **already exists at the repository root** (owner decision 2 — `go.<yourdomain>` lives on this same Pages project). Nothing to add; Cloudflare Pages picks it up on deploy. For reference it contains:
   ```
   /d/:token   /driver.html?t=:token   302
   /j/:token   /driver.html?j=:token   302
   /t/:token   /track.html?t=:token    302
   /r/:token   /pay.html?t=:token      302
   ```
   What works today: `/d/<token>` (connect phone → `driver.html`) works. `/j/<token>` is wired but not functional yet — `driver.js` does not resolve short offer tokens until the offer page lands (it still opens jobs from the full `#` payload the console puts in the link). `/t/` and `/r/` return 404 until `track.html` / `pay.html` exist (Phases 3–4).
6. Open `https://app.<yourdomain>` — the console loads exactly as before, from your browser's storage on that computer.

---

## 2. Supabase project (the cloud notebook)

1. Sign in at https://supabase.com → **New project**. Name `skyway`, pick the region closest to the office (US East for New York), choose a strong database password and **store it in your password manager**.
2. When the project is ready, open **Project Settings → API** and copy three things for later:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon public key** — a long string starting `eyJ…` (safe to use in the console)
   - **service_role key** — **secret**; only the developer uses it inside Supabase itself
3. Install the database: **SQL Editor → New query**, paste the whole contents of `supabase/schema.sql`, press **Run**. It creates every table, the triggers (status from stage, live driver pins), the row-level security rules and the per-location numbering sequences. It is safe to run again later.
   - The script seeds one location called `nyc`. If your location id should be different, change the last lines of `schema.sql` (`insert into locations …`, `ensure_location_sequences('nyc', …)`) **and** the `skyway.anon_sync_locations` line before running.
   - Then run once, replacing the numbers with what the console shows under Settings (next dispatch number and next invoice number):
     `select bump_sequences('nyc', 4522, 1042);`
4. **Realtime** (optional, used by phones later): **Database → Replication** → make sure `trips`, `drivers`, `offers`, `messages`, `needs_you` are in the `supabase_realtime` publication (the script tries to add them).
5. **Nightly backups:** Pro plan projects are backed up daily automatically. On the free plan, the developer schedules `pg_dump` (or keep using the console's Export/Backup every evening — it still works).

### 3. Edge Functions (the cloud helpers)

The developer deploys these from a computer with the Supabase CLI (https://supabase.com/docs/guides/cli):

```bash
npm install -g supabase            # once
supabase login                     # opens the browser
supabase link --project-ref abcdefgh   # the part before .supabase.co in the Project URL

# deploy everything in supabase/functions/
supabase functions deploy sync-bulk
# connect-invite is also called by driver.html (action "complete") with no login — the single-use 24 h connect
# token is the credential — so the gateway's JWT check must be off or the driver's POST gets a 401:
supabase functions deploy connect-invite --no-verify-jwt
supabase functions deploy sms-out
supabase functions deploy notify
supabase functions deploy offer-job
supabase functions deploy geofence
supabase functions deploy route
supabase functions deploy geocode
supabase functions deploy square-charge
supabase functions deploy square-link
supabase functions deploy square-invoice
# webhooks called by Twilio / Square (they verify the provider's signature instead of a login):
supabase functions deploy sms-in      --no-verify-jwt
supabase functions deploy sms-status  --no-verify-jwt
supabase functions deploy square-hook --no-verify-jwt
```

3.6 **Secrets** — set once (**Project Settings → Edge Functions → Secrets**, or `supabase secrets set NAME=value`). You collect the values in the next sections:

| Secret | Where it comes from |
|---|---|
| `PUBLIC_BASE_URL` | `https://go.<yourdomain>` (step 1.4) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio Console home page (step 4.1) |
| `TWILIO_MESSAGING_SERVICE_SID` | step 4.5 (starts with `MG`) |
| `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_ENV` | step 5 |
| `SQUARE_WEBHOOK_URL` | the exact URL you registered in step 5.4 |
| `GOOGLE_MAPS_SERVER_KEY` | step 6.4 |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the functions automatically.

3.6b **driver.html metas** — the driver page is a static file, so it finds the cloud through two `<meta>` tags in `driver.html` (the developer fills them before deploying to Pages):

| Meta | Value | Needed? |
|---|---|---|
| `skyway-functions` | the Edge Functions base URL, `https://abcdefgh.supabase.co/functions/v1` | **Required** for the connect link to record consent in the cloud. Empty = no-backend mode: consent is kept on the phone and rides along in the first `L` location text. |
| `skyway-anon-key` | the project's **anon public key** (step 2.2) | Only if `connect-invite` was deployed **with** JWT verification (without `--no-verify-jwt`); then the page sends it so the gateway lets the POST through. Leave empty when the function is deployed as shown above. |

3.7 **Scheduled jobs** (Database → Extensions → enable `pg_cron` and `pg_net`, then SQL Editor):

```sql
-- expire 90-second job offers and move to the next driver (every 15 s)
select cron.schedule('expire-offers', '15 seconds', $$
  select net.http_post(
    url := 'https://abcdefgh.supabase.co/functions/v1/offer-job',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <service_role key>"}'::jsonb,
    body := '{"action":"expire"}'::jsonb) $$);
-- roll raw GPS points older than 30 days into daily totals (03:15 every night)
select cron.schedule('roll-driver-locations', '15 3 * * *', $$ select roll_driver_locations() $$);
```

3.8 **Database webhook for geofences:** **Database → Webhooks → Create** → table `driver_locations`, event **Insert**, type **Supabase Edge Function** → `geofence`.

---

## 4. Twilio (texts from the business number)

### 4.1 Account
1. Sign up at https://www.twilio.com/try-twilio with the business email; upgrade the account (add a card) — trial accounts can only text verified numbers.
2. The Console home shows **Account SID** and **Auth Token** → Supabase secrets `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`.

### 4.2 The business number — Hosted SMS (decided: owner decision 1)
The existing business number keeps handling calls exactly as today; Twilio only takes over its **texts** (Hosted SMS). While Twilio and the carriers approve the paperwork, a verified toll-free number is the interim "Skyway text line".

1. **Interim line first (day one):** Twilio Console → **Phone Numbers → Buy a number → Toll-free**, then **Toll-free verification** (business name, website, sample messages, and the opt-in description from 4.3). Approved in 1–5 days; passenger texts show as the "Skyway text line" until the business number is hosted.
2. **Host the business number:** **Phone Numbers → Manage → Hosted Numbers → Add** → enter the business number. Twilio generates a **Letter of Authorization** — the account owner signs it — and asks for a **recent phone bill** showing the number and the business name. Approval 1–3 weeks. Calls are untouched; texts to that number now reach Twilio.
3. **Add both numbers to the Messaging Service** (4.4 step 2). Texts go out from the business number once it is hosted and 10DLC (4.3) is approved; `sms-in` matches whichever number the passenger or driver texted (`locations.body.sms_number`, falling back to the location's `phone_e164`), so both numbers route to the console.
4. Once the business number is hosted, texting ON in the console (step 7) sends from it; the toll-free line can be released or kept as a spare.

*Alternative — porting:* if the current carrier refuses to host SMS, **Phone Numbers → Manage → Port numbers** (same paperwork; 1–4 weeks). Calls then come through Twilio and are forwarded to the office phones (the developer sets the forwarding); caller-ID screen-pop becomes automatic. Not the default — only if hosting fails.

### 4.3 A2P 10DLC registration (required in the US for a local number)
1. **Messaging → Regulatory Compliance → Brand registration** (also found under "Trust Hub"): legal business name, **EIN**, address, website, contact. Fee about $4 (standard) once; vetting $40 optional.
2. **Campaign registration**: use case **Customer Care / Delivery notifications**. Description: *"Ride confirmations, driver assignment, ETA, arrival and receipt texts for passengers of a car service; job offers and status to drivers. Opt-in by booking by phone or web; reply STOP to opt out."* In the **opt-in description** field quote, verbatim, the exact sentence dispatchers say on every phone booking (owner decision 8): "By booking you agree to receive ride updates by text; reply STOP to opt out." — copy it character for character; it is the same sentence printed on the dispatcher cheat sheet and shown under the Booked template in Settings → Messages. Sample messages: copy two passenger texts from `PRODUCT-DESIGN.md` section 5. Campaign vetting ≈ $15 one-time + $1.50–10/month. Approval 1–3 weeks.

### 4.4 Messaging Service
1. **Messaging → Services → Create Messaging Service**, name `Skyway`. Use case: *Notify my users*.
2. **Sender pool → Add senders** → the business number (once hosted/ported) and/or the toll-free number.
3. **Compliance → A2P 10DLC** → attach the campaign from 4.3.
4. **Integration → Incoming messages → Send a webhook**: `https://abcdefgh.supabase.co/functions/v1/sms-in` (HTTP POST). **Delivery status callback**: `https://abcdefgh.supabase.co/functions/v1/sms-status`.
5. **Opt-out management → Advanced Opt-Out** → enable with the default STOP/START/HELP keywords.
6. The service's SID (`MG…`) → Supabase secret `TWILIO_MESSAGING_SERVICE_SID`, and in the SQL Editor:
   `update locations set twilio_messaging_sid = 'MG…', body = body || '{"sms_number":"+1718…"}' where id = 'nyc';`

### 4.5 Test
In the console, **Settings → Messages**, then on any trip card press **Text** — with texting ON (step 7) the message goes out from the business number and its delivery check mark appears on the card. With texting OFF the button still opens your own phone's Messages app with the text prefilled (works today).

Keep texts to plain (GSM-7) punctuation: one em dash or curly quote switches the whole SMS to UCS-2 (70 characters per segment instead of 160), so a job offer that fits in 2 segments becomes 3–4. The driver offer therefore reads "JOB #12 - Today 3:40 PM" and "Account - no cash" in texts (plain hyphen), even though the console and driver page show the em dash. This happens automatically as the text leaves (`sendSms` on the server, the `sms:` link / copy in the console swap dashes, arrows, curly quotes and "…" for plain characters), so templates under Settings → Messages may keep their typography — but a plain hyphen is still the safest thing to type.

---

## 5. Square (cards, pay links, invoices)

Decided (owner decision 3): the **existing Square account**, one app with sandbox + production credentials; **no card reader for the pilot** (cards are charged on file, by pay link or by invoice); **driver payouts by bank ACH / CSV** — the **Earnings** tab produces the per-driver numbers and `settlements.method` defaults to `ach_csv`. Also decided (owner decisions 4 and 5): card rides hold the **estimate + 20 %** at booking and release the difference at capture (`settings.holdFactor`, default 1.2); **no automatic gratuity** (`settings.autoGratuityPct = 0`, per-account override); the **no-show fee** (base fare) is charged only when a card is on file and only by the dispatcher pressing **Charge no-show fee** in MONEY — never automatically.

1. Sign in at https://developer.squareup.com/apps with the **same login as the business's Square account** → **+ (Create your first application)** → name `Skyway Grid`.
2. **Credentials** tab: toggle **Sandbox** first for testing (`SQUARE_ENV=sandbox`), then **Production** for launch. Copy the **Access token** → secret `SQUARE_ACCESS_TOKEN`. (The design's "Connect Square" OAuth button replaces this personal token later; the token is enough for the pilot.)
3. **Locations** tab: copy the **Location ID** of the business → `SQUARE_LOCATION_ID`; also `update locations set square_location_id = 'L…' where id = 'nyc';`
4. **Webhooks** tab → **Add subscription**: URL `https://abcdefgh.supabase.co/functions/v1/square-hook`, API version latest, events: `payment.created`, `payment.updated`, `refund.updated`, `invoice.payment_made`, `invoice.updated`, `invoice.canceled`, `card.forgotten`, `customer.updated`. After saving, **Show signature key** → `SQUARE_WEBHOOK_SIGNATURE_KEY`, and put that exact URL in `SQUARE_WEBHOOK_URL`.
5. **OAuth** tab (for the later "Connect Square" button): add redirect URL `https://app.<yourdomain>/index.html?square=connected`. Permissions: `PAYMENTS_WRITE`, `PAYMENTS_READ`, `CUSTOMERS_WRITE`, `CUSTOMERS_READ`, `ORDERS_WRITE`, `ORDERS_READ`, `INVOICES_WRITE`, `INVOICES_READ`, `MERCHANT_PROFILE_READ`.
6. Square's **Virtual Terminal link** already in Settings stays as the manual fallback.
7. Test in sandbox: Settings → **Square → Test**, then book a trip with pay type Credit Card and a sandbox test card (`4111 1111 1111 1111`, any future date, CVV 111). The board shows the green "Card OK" chip; Complete charges it; the receipt text arrives.

---

## 6. Google Cloud (maps, addresses, routes)

1. https://console.cloud.google.com → **New project** `skyway-maps` → **Billing → Link a billing account** (the monthly free credit covers a small fleet).
2. **APIs & Services → Library** → enable: **Maps JavaScript API**, **Places API (New)**, **Geocoding API**, **Routes API** (and keep **Directions API** for the console's existing driving-distance code).
3. **Browser key (the one the console already has):** **Credentials → Create credentials → API key** → name `skyway-browser`. **Application restrictions → Websites**: add `https://app.<yourdomain>/*`, `https://<name>.pages.dev/*`, `http://localhost:8080/*`. **API restrictions**: Maps JavaScript, Places (New), Directions, Geocoding. Paste it into the console: **Settings → Google Maps API key → Save**. Then **delete the old key** that was embedded in `index.html` (Credentials → the old key → Delete). The developer removes the old string from the file.
4. **Server key:** create a second key `skyway-server`. **Application restrictions → None** (or IP addresses if Supabase gives you fixed egress IPs). **API restrictions**: Geocoding, Routes. → Supabase secret `GOOGLE_MAPS_SERVER_KEY`. This key never reaches a browser.
5. **Quotas & alerts:** APIs & Services → each API → **Quotas** → set a daily cap (e.g. 2,000 Routes requests); **Billing → Budgets & alerts** → a $50/month budget with email alerts.
6. Test: console → **Settings → Test Google now**, then **Map → Full connection check**.

---

## 6b. Flight data (Phase 6): AeroDataBox

Decided (owner decision 12): **AeroDataBox** for the pilot; switch to FlightAware AeroAPI only if airport pickups show late or missing updates. The console already records this as `settings.flightProvider = 'aerodatabox'` (shown as "Flight data: AeroDataBox (Phase 6)" on the Settings → Region card). Nothing to set up yet — the `flight-poll` Edge Function is built in Phase 6. When it is:

1. Subscribe to AeroDataBox on RapidAPI with the business email; copy the API key → Supabase secret `AERODATABOX_API_KEY` (placeholder name; the developer confirms it when the function ships).
2. `supabase functions deploy flight-poll`, then a `pg_cron` schedule like the ones in 3.7 (every 10 minutes, airport pickups in the next 6 hours only).
3. Test: book an airport pickup with a flight number; the trip card shows the live arrival time and the Needs-you strip flags a delay.

---

## 7. Turning things on in the console (Settings tab)

Open **Settings** (it asks for the Settings PIN once one is set). The page opens on
the **Go-live checklist**. Every row says what it checks, shows **Done**,
**Needs you**, **Optional** or **Skipped**, and has an **Open** button that jumps
straight to the field or screen that fixes it. Rows marked Optional have a
**Skip** button for things this station does not need. The top line counts how
many are done; while anything still needs you, the Today screen shows one
reminder line (**Not now** hides it for a week).

Work down the list in the order it shows. Turn on the big things (Cloud,
business-number texting, Square card charging) **one at a time**, and use the
console for a day between each.

- **Business details** — company name, address, phone and TLC base number
  (B01593). They print on receipts, invoices and the TLC file.
- **Owner PIN** — set it in Staff, access & activity. Exports, backups, price
  changes and staff changes ask for it. Without it anyone at the desk can do them.
  Set it on every station, or once after Cloud is on (settings sync to every
  station). Simple mode is already on everywhere; Expert mode and Settings sit
  behind this PIN.
- **Named dispatchers** (optional) — add each dispatcher by name and role so the
  activity log shows who did what.
- **Consent sentence on the cheat sheet** — always Done. Print the cheat sheet;
  dispatchers say on every phone booking: "By booking you agree to receive ride
  updates by text; reply STOP to opt out."
- **Texting route** (optional) — until Cloud is on, texts go out from the
  phone's SMS app. Business-number texting (Twilio, step 4) comes with Cloud.
- **Cloud sync** (optional) — Cloud card: Supabase URL, anon key, location id
  (`nyc`) → **Save cloud settings** → **Test connection** (must say *Connected*).
  Press **Upload everything now** and wait for the report: every collection must
  say **match** and every fares-by-month line must match to the cent. If it still
  differs after a second upload, stop and call the developer. Then tick **Enable
  cloud sync** → Save; the dot turns green. Keep the nightly backup going and
  dual-run for 1–2 weeks with a second computer or phone.
- **Square** — the Square card link (Virtual Terminal) is set. Do the step 5
  sandbox tests and switch `SQUARE_ENV` to `production` before charging real
  cards through Cloud.
- **Money defaults saved** — open Money defaults and press Save once: card hold
  ×1.2, airport fee $3.50, gratuity 0 % (accounts with their own gratuity keep it).
  The no-show fee stays a dispatcher button.
- **Rate table** — prices do not change until you do this. Press **Load proposed
  rate card**, check the draft on Rates & zones, type the TLC filing date and
  activate it with the owner PIN.
- **Fee mode chosen** — in Money defaults, pick flat (each driver's own base fee)
  or tiers (by fare).
- **Driver papers** — every active driver needs a TLC number and TLC, DMV and
  insurance dates (Fleet → roster check). A driver with a lapsed date cannot be
  put on a ride.
- **Vehicle papers** — registration and inspection dates for every vehicle.
  Optional while a vehicle is not required on every job.
- **Partner base for overflow** (optional) — the partner base record, only needed
  to send calls you cannot cover to another base.
- **Call reports** (optional) — export one call report (CSV) from the phone
  company's portal and import it on the Calls screen; the column map is saved.
- **Win-back list** — import the list of past riders to call back (Accounts →
  win-back, Import).
- **Plan figures** — the bookkeeper types the four private figures on Money →
  Business → Plan: opening cash, Square credits, baseline net and payroll uplift.
  They are never stored in the repository.
- **Google Maps key** — use the firm's own key, not the sample key the app ships
  with (step 6). Empty is fine: the free map and address service is used.
- **Driver phones** (optional) — Drivers tab → **Connect phone** next to each
  driver. The row is Done once a driver has opened the driver page on a phone.
- **Backup in the last 7 days** — Backup, restore & outage sheet → make an
  encrypted backup. Keep doing it nightly.
- **Outage sheet** (optional) — print it once to see it works, then print a
  fresh one each morning in case the computer dies.

Under the checklist every other setting is sorted into sections (Business,
Staff & access, Phones & texting, Cloud, Payments & money, Prices, Drivers &
vehicles, and so on) with a search box at the top. To set up a second computer
quickly, the owner can **Export settings bundle** here and **Import settings
bundle** there: it shows every change before you press Apply, and it never
carries trips, drivers, accounts, the books, PIN hashes, or (unless you tick
"Include keys") the Google and Cloud keys. **Print station sheet** gives one page
of every setting, keys masked, to keep with the outage binder.

Leave the automation toggles (auto-assign cascade, auto-arrived, auto-charge,
auto airport fee) off for the first week; each has an Undo and a "why" line.

---

## 8. Rollback — turning Cloud off

At any moment: **Settings → Cloud → untick Enable cloud sync → Save.** The console is instantly a pure local app again with everything it has in this browser; nothing is deleted anywhere. Changes made on other devices while Cloud is off are not pulled until you turn it on again (they merge by newest-wins when you do).

- To go back to texting from your own phone: Messages → Texting OFF. The Text buttons fall back to the `sms:` links.
- To stop charging cards: Square → OFF. The Virtual Terminal link remains.
- To restore an old backup: Settings → Backup & Data → Restore, pick the file from step 0. If Cloud is on, the restored data is uploaded as the newest version.
- Full stop: Supabase → Project Settings → **Pause project**. Nothing is billed while paused; resume any time.

---

## 9. Who to call when

| Symptom | First check |
|---|---|
| Cloud dot red: "key rejected (401)" | the anon key was pasted with a space, or `schema.sql` was not run (the policies are missing) |
| Cloud dot red: "not found (404)" | `schema.sql` not run on this project, or wrong Project URL |
| Cloud dot amber "Offline" | this computer has no internet; changes upload when it is back |
| Texts not arriving | Twilio Console → Monitor → Logs → Messaging: look for error 30034 (10DLC not approved) or 21610 (passenger replied STOP) |
| "Card hold failed" in Needs-you | Square dashboard → Transactions; expired card or sandbox/production mismatch (`SQUARE_ENV`) |
| Map or addresses blank | Settings → Test Google now; the browser key's website restriction must include the exact address you are using |
| Driver pin stale for 2+ minutes | phone locked or app in background (iPhone limitation until the Phase 7 store app); the driver reopens Skyway |
