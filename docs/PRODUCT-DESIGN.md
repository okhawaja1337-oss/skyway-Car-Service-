# Skyway Grid — Product Design

**Final architecture: "Skyway Grid — Incremental Edition"** (the incremental build-out of the existing Skyway Dispatch Console, chosen best-overall by the judges, with the best ideas grafted in from the Managed-Services and Robust & Scalable proposals).

**Basis:** LimoGrid-class limo/chauffeur platforms (reservations, quoting, live dispatch, driver app, passenger texts, payments and billing, Google maps, multi-region admin, optional AI assistant).

**Written for:** the owner first (plain English at the top of every section), then the builder (technical detail underneath, marked "Builder notes"). Everything in this document is designed against the real code in `/home/user/skyway-Car-Service-/index.html`. The hooks it relies on were verified to exist there: `persist()` (line 14431), `reloadFromStorage()` (14663), `syncRefresh()` (14638), `migrate()` (14078), `uid()` (14418), `money()` (14419), the storage key `skyway_dispatch_v2` (+ `_rev`), the side keys `skyway_routebook`, `skyway_callerbook`, `skyway_histseed`, `skyway_webseen`, `skyway_help_seen`, the IndexedDB archive `skyway_history`, the `SkyBus` BroadcastChannel (`skyway_bus`, message types `state`, `cmd`, `presence`), the driver field `curLoc={addr,when}`, the settlement fields `feeWeek/feeTrip/feePct/split`, the counters `dispatchSeq/invoiceSeq`, the literal trip status strings `'Booked' | 'Dispatched' | 'Completed' | 'Canceled' | 'No-Show' | 'Disregard'`, `payType` values `'Cash' | 'Credit Card' | 'Account'`, `settings.square` (Virtual Terminal link), `settings.gmapkey`, and the `?caller=` screen-pop.

---

## Table of contents

1. What we're building
2. Simplified product for a high-schooler (new information architecture)
3. Architecture
4. Phones connecting as drivers
5. Texting
6. Payments, billing and invoicing with Square
7. Maps and routing
8. Global / multi-region
9. Data migration from the current app (zero loss)
10. Phased roadmap
11. Monthly costs
12. Risks and decisions needed from the owner
Appendix A — Database tables
Appendix B — Edge Functions
Appendix C — Settings keys added
Appendix D — Where every current feature lives

---

## 1. What we're building (one page)

**Today** Skyway is one file, `index.html`, that opens in a browser on one computer. It books trips, prices them with a real NYC TLC meter and zone books, runs a live board, ranks drivers (Driver IQ), auto-dispatches (Optimizer), prints invoices, exports TLC reports and does the books. It is excellent at the desk — but it stops at the desk. Drivers have no app, nobody gets a text, the dispatcher guesses where cars are, and Square is a bookmark.

**Skyway Grid** keeps that console exactly as it is and grows it into a LimoGrid-style service that reaches out of the office:

| LimoGrid capability | What Skyway Grid does |
|---|---|
| **Reservations** — phone, online widget, one-way / round-trip / hourly / airport with flight tracking, vehicle classes, passenger profiles | The current booking form (phone bookings) plus a public `book.html` widget; new `serviceType` and `flight` fields on every trip; a `passengers` list with saved addresses and cards |
| **Quoting & rates** — flat zones, point-to-point, hourly, surcharges, promo codes, instant quotes | The existing engines (TLC meter, zone matrix, flat/airport/neighborhood books, learned route fares) untouched, plus a Generic metered engine, Hourly/charter engine, surcharge stack and promo codes for other regions |
| **Dispatch** — live board, assign/auto-assign, status pipeline, conflict checks, farm-out | The existing board and ★ Best / Optimizer, plus a real pipeline (Booked → Assigned → En route → On location → Passenger on board → Completed) driven by the driver's phone, a 90-second offer cascade, a "Needs you" strip, and affiliate farm-out links |
| **Driver app** — job list, accept, one-tap status, navigation, live GPS, notes, signatures, earnings | `driver.html`: an installable web app any phone opens from a text sent by the business number (or by texting JOIN to it); later wrapped as a store app for true background GPS |
| **Passenger notifications** — SMS/email at every stage, tracking link | Automatic texts from the business number: booked, driver assigned (name, photo, car, plate), on the way with ETA, arrived, receipt; a live tracking page |
| **Payments & billing** — card on file, authorize at booking, charge at completion, tips, invoices, statements, receipts, payouts | Square connected properly: cards on file, hold at booking, charge at drop-off, tip links, pay-by-text, Square Invoices for accounts (with the CCU fee), receipts, refunds, driver settlement exports |
| **Maps** — Google routing, ETAs, tracking map, geofences | Google Maps Platform (Routes, Places, Geocoding) with the existing free fallbacks kept; plotted courses everywhere; geofences that mark "arrived" and apply airport fees |
| **Admin / reports** — revenue, driver performance, multi-location, time zone, currency | Existing Business / Earnings / TLC Reports, plus a Region profile so the same console runs in Miami or London |
| **AI assistant** | Optional: inbound texts turned into draft bookings the dispatcher confirms |

**The rule that makes this safe:** nothing in the current console is rewritten. One new script (`sync.js`) is added with a single `<script>` tag. Every new capability — Cloud, Phones, Texting, Square, Simple mode, Region — is a switch in Settings. Turn any of them off and you have today's console with today's data. Turn Cloud off entirely and the app is a pure local file again.

**Who runs it:** a dispatcher who learned it in one afternoon. The daily screen is **Today**: answer the phone, the caller's history pops up, book the ride, press ★ Best, and the system does the rest — texts the driver, texts the passenger, tracks the car, charges the card. A strip at the top shows only the things a human has to handle.

**What it costs to run:** roughly $200–400 per month in services at ~2,000 trips a month (Supabase, Twilio texts, Google Maps, flight data), plus Square's normal card fees. No servers to maintain.

**How long:** about 20 weeks of one developer's time in eight phases; each phase ends with a working system. Phones are live by week 6, texting by week 8, Square by week 11, the simple screen by week 14.

---

## 2. Simplified product for a high-schooler

### Plain English

The 17 tabs become **five big buttons** across the top, with **Today** as the home screen. Nothing is deleted. Every old tab is still reachable (one click deeper, under the section it belongs to), and an **Expert mode** switch in Settings brings the whole 17-tab bar back unchanged for the owner.

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │  TODAY    BOOK    BOARD    DRIVERS    MONEY    SETTINGS      [?] [⚙] │
 ├──────────────────────────────────────────────────────────────────────┤
 │  NEEDS YOU (2):  ● Mike didn't answer job #4521 — Try Sam?  [Offer] │
 │                  ● Card declined, trip #4517 — [Send pay link] [Cash]│
 ├───────────────┬───────────────────────────────┬──────────────────────┤
 │ CALLER ID     │ LIVE BOARD (sorted by pickup) │  MAP                 │
 │ F1 ● 718-555… │ 3:40p  John D. → JFK T4       │  (live driver pins,  │
 │ F2 ○          │        ● On the way · Mike 12m│   plotted course of  │
 │ F3 ○ …        │        [Assign] [...]         │   the selected trip) │
 │               │ 4:15p  A. Patel → LGA         │                      │
 │ QUICK BOOK    │        ● Needs a driver       │                      │
 │ Who / From /  │        [★ Best: Sam] [...]    │                      │
 │ To / When     │ …                             │                      │
 │ "$58 + tolls, ├───────────────────────────────┴──────────────────────┤
 │  about 42 min"│ MESSAGES  (driver & passenger replies, newest first) │
 │ [ Book it ]   │  3:31p Mike: "Y"  · 3:29p 917-555-0101: "WHERE?"     │
 └───────────────┴──────────────────────────────────────────────────────┘
```

**The five screens**

1. **TODAY** (home, default) — Caller ID lines (F1–F6 work exactly as now), a quick-book card, the live board, the map and the Messages inbox, all on one screen. This is the whole job on a normal day.
2. **BOOK** — the full booking form in the order you ask a caller: phone (auto-filled from the ringing line), name, pickup, drop-off, when, how many people, car type, pay type/account. The price appears as one plain sentence ("$58 + tolls, about 42 min") with "why" on hover, and a map with the course drawn. One green button: **Book it**. Round-trip, hourly and airport (flight number) are three small buttons at the top of the form.
3. **BOARD** — the live board full-screen as cards sorted by pickup time. Each card has a colored status pill and **at most three buttons**: **Assign** (opens the ranked Driver IQ list with ★ Best preselected and a one-line reason), **Text** (passenger / driver), and **…** for everything else. One button at the top: **Auto-assign everything** (the Optimizer's Apply all). The status legend is pinned to the side.
4. **DRIVERS** — a map of live pins and a list of drivers with a green/amber/grey dot ("live 8 s ago", "last seen 2:31 PM", "not connected"), buttons **Connect phone**, **Text**, **Call**, **On shift / Off shift**, **Set location** (the current manual pin). Vehicles live under each driver. Driver IQ staging/playbooks and the Optimizer detail are tabs inside this screen.
5. **MONEY** — Today's takings, **Unpaid rides** (each with **Charge card** / **Send pay link** / **Mark cash**), **Open invoices** (each with **Send via Square**), **Driver settlement this week** (with **Pay out / Export**), and the monthly P&L. Accounts, Invoicing, Earnings and Business are tabs inside this screen.
6. **SETTINGS** (PIN-locked) — a **6-step setup wizard** with a green check per step: Business → Region → Phone number & texting → Square → Maps → Drivers. Then: Messages (text templates), Rates & Zones, Address Book, Regulatory exports, Backup/Restore, Themes (light/gold/classic kept), Expert mode toggle. Advanced tools (Fare Estimate playground, Driver IQ tuning, Optimizer tuning, imports) sit behind an "Advanced" accordion with a one-sentence description each.

**Rules that keep it simple** (enforced in the new shell code, not by policy):

- One primary (green) button per screen or dialog; never two.
- Every action shows a **10-second Undo** toast (assign, cancel, no-show, charge, text).
- Destructive actions (delete driver, refund, wipe data) require typing the word `DELETE` or `REFUND`.
- Status colors are the same everywhere (board, driver app, tracking page): grey Booked, yellow Offered, blue Assigned, purple On the way, teal Arrived, green On board, dark-green Done, orange Done-unpaid, red Needs you.
- Alerts speak plain language: "Mike didn't answer. Try Sam?" never "offer expired (code 408)".
- The dispatcher's job is **Book** and **Assign**. Status changes come from the drivers' phones.
- A **first-run checklist** on Today until it is complete: add drivers → connect a phone → book a test ride → text yourself → take a $1 test payment.
- A "Show me" tour (driver.js) for: Book a ride, Send a driver, Charge a card, Fix an address. A printed one-page cheat sheet (Settings → Print cheat sheet).
- Keyboard: F1–F6 caller lines, Ctrl-K search, and all current shortcuts kept for the power user.
- Pop-out screens (Calls, Reservations, Caller ID, Board, Wall Board, Map) are "Open on another screen" buttons on Today and Board; unchanged.

### Where every existing feature lives

| Current tab / feature | New home |
|---|---|
| Dispatch: booking form | BOOK (and Quick-book card on TODAY) |
| Dispatch: 6-line Caller ID, F1–F6 screen-pop | TODAY (left column) — unchanged code |
| Dispatch: live board | TODAY (center) and BOARD (full screen) |
| Dispatch: trip preview map | TODAY/BOOK right column |
| Trips (search, filters, CSV) | BOARD → "All trips" tab (Ctrl-K search) |
| Call History (IndexedDB archive) | BOARD → "Call history" tab; also the caller pop on TODAY |
| Trip Map | BOARD → "Map" tab |
| Zone Map | SETTINGS → Rates & Zones → Zone Map |
| Fare Estimate (TLC meter, books, learned fares) | BOOK (the price sentence) and SETTINGS → Advanced → Fare Estimate playground |
| Accounts | MONEY → Accounts |
| Invoicing (printable, CCU fee) | MONEY → Invoices (+ "Send via Square") |
| Zones & Pricing (matrix, rate card, tolls) | SETTINGS → Rates & Zones |
| Fleet (drivers, vehicles) | DRIVERS |
| Earnings (driver settlement) | MONEY → Settlement |
| Driver IQ (ranking, staging, playbooks, set-location) | BOARD → Assign dialog (ranking); DRIVERS → Driver IQ tab (staging, playbooks, set-location) |
| Optimizer (auto-dispatch chaining, road routes, ETAs) | BOARD → "Auto-assign everything"; DRIVERS → Optimizer tab (detail) |
| Address Book (geocoded) | SETTINGS → Address Book; autocompletes in BOOK |
| TLC Reports (CSV) | MONEY → Regulatory exports (TLC CSV for NYC, generic CSV elsewhere) |
| Business (P&L) | MONEY → P&L |
| Settings (branding, Google key, Square link, themes, backup, imports) | SETTINGS (wizard + sections) |
| Pop-out multi-monitor screens | "Open on another screen" buttons; same `SkyBus` |
| Expert mode | SETTINGS → Expert mode: the original 17-tab bar, byte-for-byte |

### Builder notes

- The shell is a new file `simple.js` + `simple.css` loaded after `sync.js`. It **does not move DOM**: it re-parents the existing tab panels into section containers at load (`appendChild` of the existing `#tab-dispatch`, `#tab-trips`… elements) and hides the old tab bar. All existing event handlers, IDs and pop-out code keep working because the elements are the same nodes. Expert mode reverses the re-parenting.
- `settings.simpleMode` (default `true` after Phase 5), `settings.expertMode`, `settings.adminPin` (bcrypt hash, stored in settings body; never required for Today/Book/Board/Drivers/Money).
- "Needs you" strip reads a derived list computed in `sync.js`: offers expired with no next driver, `payment.status==='failed'`, inbound message with `CANCEL`/`C`, driver `curLoc.source==='gps'` and `when` older than 2 min while on a job, flight delay > 15 min awaiting passenger reply, Square/Twilio webhook failure.
- Undo: `sync.js` wraps mutating actions in `withUndo(label, apply, revert)`; the toast calls `revert()` within 10 s; after that the row is synced. Texts are **not sent** until the undo window closes (so "Undo" on Assign really stops the job text).

---

## 3. Architecture

### Plain English

Think of it as the current console with a **cloud notebook** behind it. The console keeps its own copy of everything (so it works offline, as today), and whenever it saves, it also writes the change to the cloud notebook. Drivers' phones, the passenger tracking page and a second dispatcher's computer all read and write the same notebook. Small "helper" programs in the cloud (Edge Functions) do the things a browser can't: send texts from the business number, talk to Square, ask Google for routes with a private key, watch flights.

### Diagram

```
                         ┌─────────────────────────────────────────┐
                         │         Cloudflare Pages (HTTPS)        │
                         │  index.html (+ sync.js, simple.js)      │
                         │  driver.html   book.html   track.html   │
                         └───────┬───────────┬───────────┬─────────┘
                                 │           │           │
   Dispatcher PC(s)        Driver phones   Passenger phones / web
   (console, pop-outs      (PWA, later      (booking widget,
    via SkyBus, offline     Capacitor)       tracking, tip/receipt)
    localStorage+IndexedDB)      │           │
          │                      │           │
          ▼                      ▼           ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                       SUPABASE (one project)                 │
   │  Postgres (JSONB bodies + promoted columns, RLS, triggers)   │
   │  Realtime (board, driver pins, messages)   Auth (phone OTP)  │
   │  Storage (signatures, photos, invoice PDFs)   Vault (keys)   │
   │  pg_cron (reminders, auths, flights, settlement, reconcile)  │
   │  Edge Functions:                                             │
   │   sync-bulk · connect-invite · sms-in · sms-out · sms-status │
   │   offer-job · notify · geofence · quote · route · geocode    │
   │   square-charge · square-link · square-invoice · square-hook │
   │   flight-poll · reconcile-square · ai-draft (optional)       │
   └────┬──────────────┬──────────────┬──────────────┬────────────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
     TWILIO         SQUARE       GOOGLE MAPS      AERODATABOX /
  Messaging Svc   Customers/     Routes · Places   FLIGHTAWARE
  (business #,    Cards/Payments  Geocoding         (flights)
   10DLC, Verify, Checkout/       Maps JS
   Lookup, masked Invoices/       (+ OSRM/Photon/
   numbers)       Terminal/hooks   Nominatim/OSM
                                   fallbacks)
```

### Components

| Component | Technology | Role |
|---|---|---|
| **Dispatcher Console** (existing) | `index.html` as-is + `sync.js` (~500 lines) + `simple.js/css` (Phase 5), served by Cloudflare Pages and by the existing localhost launchers | All 17 tabs, engines, pop-outs, exports unchanged. `sync.js` wraps `persist()` / `reloadFromStorage()` to push/pull row deltas, adds a Cloud status dot, listens to Realtime, renders the Needs-you strip, Messages panel, undo toasts |
| **Cloud mirror + realtime** | Supabase: Postgres, Realtime, Auth (phone OTP via Twilio Verify, email/password for dispatchers), Storage, Vault, pg_cron, Edge Functions (Deno/TypeScript) | Source of truth once Cloud is on. Row-level security by `location_id` and role (dispatcher, driver, passenger-token, affiliate-token) |
| **Driver app** | `driver.html` (PWA: manifest, service worker, Geolocation `watchPosition`, Screen Wake Lock, Web Push, Supabase JS, IndexedDB outbox). Phase 7: same page wrapped in Capacitor with `@capacitor-community/background-geolocation` + FCM/APNs | Job offers, accept/decline, one-tap status rail, navigate deep links, notes, stops/tolls/wait, signature pad, photo, cash toggle, earnings; streams GPS |
| **Messaging** | Twilio Programmable Messaging (Messaging Service with the business number as sender; Hosted SMS or port; A2P 10DLC), Twilio Verify, Twilio Lookup, masked numbers (Proxy-style) | Driver job texts and replies, passenger lifecycle texts, connect invites, OTP, STOP/HELP, inbound text-to-book capture, delivery status |
| **Payments** | Square Web Payments SDK, Customers, Cards, Payments (delayed capture), Checkout payment links, Invoices, Refunds, Terminal (optional), Webhooks; Stripe adapter stub behind the same interface | Card on file, hold at booking, charge at drop-off, tips, pay-by-text, corporate invoices, receipts, refunds, settlement exports |
| **Maps & routing** | Google Maps Platform (Maps JS, Places New Autocomplete, Geocoding, Routes `computeRoutes` + `computeRouteMatrix`), server-side key in Vault; existing OSRM/Photon/Nominatim/OSM + Leaflet fallbacks; offline route-diagram | Plotted courses, ETAs, Optimizer matrix, geofences, tracking map |
| **Passenger pages** | `book.html` (embeddable widget), `track.html` (tracking + driver card + Call/Text via masked number), `pay.html` (tip/receipt) — static, token-scoped RLS | Online booking with instant quotes, saved addresses/cards, live tracking, receipt and tip |
| **Flight tracking** | AeroDataBox (RapidAPI) or FlightAware AeroAPI, polled by pg_cron | Adjusts airport pickups on delays, texts passenger and driver |
| **AI assistant** (optional) | Claude API from `ai-draft` Edge Function with a strict JSON schema | Turns inbound passenger texts into draft trips the dispatcher confirms; never books, charges or dispatches on its own |
| **Monitoring** | Supabase logs + Sentry (browser) + a free uptime check; failure alerts texted to the owner | Know within minutes when texts or charges stop |

### Data flow for one trip (technical)

1. Dispatcher books → `persist()` → `sync.js` upserts `trips` row (`id = uid()`, `body` = trip JSON, promoted columns filled) → Realtime fans out to pop-outs on other machines and to `track.html` → `notify` sends template 1 (after the undo window).
2. Dispatcher presses ★ Best → `offer-job` writes an `offers` row (expires in 90 s), pushes + texts the driver → driver taps Accept (or replies `Y`) → trigger sets `trips.stage='assigned'`, `status='Dispatched'` → `notify` template 2 → board updates.
3. Driver taps En route → `trip_events` row → `notify` template 3 with ETA from `route` → GPS pins flow into `driver_locations` → trigger copies latest into `drivers.body.curLoc` → Driver IQ / Optimizer read it exactly as today.
4. GPS enters 150 m fence → `geofence` suggests Arrived → driver confirms (or auto after 60 s) → template 4.
5. Driver taps Complete → `square-charge` completes the hold with the final amount → `square-hook` marks paid → template 5 with receipt and tip link → Earnings settlement picks up the trip unchanged.

---

## 4. Phones connecting as drivers

### Plain English

Any phone — iPhone, Android, a cheap prepaid phone, in any country — can be a Skyway driver phone. There is nothing to download from an app store at first. There are **two ways to connect**, both using the business's own number:

**Way 1 — the dispatcher sends it.** In DRIVERS, press **Connect phone** next to the driver. The driver gets a text *from the business number*:

> SKYWAY: Tap to connect your phone to dispatch: https://go.skywaycar.com/d/K7F3Q (link good for 24h)

**Way 2 — the driver asks for it.** The driver texts the single word **JOIN** to the business number. If the number matches a driver in Fleet, the same link comes straight back. If it doesn't, the dispatcher sees "New phone wants to join: 917-555-0101 — Approve as which driver?" in the Needs-you strip.

The driver taps the link. The page shows their name and car, asks for a 6-digit code (texted to the same phone, so we know it is really their phone), then asks for **Location** and **Notifications** permission, and shows a two-step "Add to Home Screen" card (iPhone: Share → Add to Home Screen; Android: Install). From that moment:

- The driver's pin appears **live** on the DRIVERS map, the board, the Optimizer map and in Driver IQ, with "live 8 s ago". Driver IQ stops guessing from the last drop-off.
- A green phone icon shows next to the driver in Fleet.
- The manual **Set location** still works; the next GPS fix overrides it (and the dispatcher is told: "Mike's phone is reporting again — manual pin replaced").

**Working a job (Uber-style):**

1. A job offer arrives as a push notification **and** a text: pickup, drop-off, time, passenger first name, how many people, car type, fare (or "Account – no cash"), notes, flight. Two big buttons: **Accept** / **Pass**. The driver can also just reply **Y** or **N** by text.
2. No answer in **90 seconds**: the offer expires and the system automatically offers the next-best driver from Driver IQ's ranking. The dispatcher sees the cascade on the board ("Offered Mike → no answer → offered Sam") and can stop it or pick someone else at any time. If nobody is left, it lands in Needs-you.
3. After accepting, the phone shows **one big button at a time**: **On my way** → **Arrived** (suggested automatically when the phone enters a 150 m circle around the pickup; confirms itself after 60 s inside the circle) → **Passenger on board** → **Complete**. Each tap updates the board instantly and sends the matching passenger text.
4. **Navigate** opens Google Maps, Waze or Apple Maps with the pickup (then the drop-off) preloaded. The plotted course is also shown inside the app.
5. On **Complete**: a summary (fare, tolls the driver added, wait time, stops), an optional signature pad (account/hourly jobs), photo capture (toll receipt), tip prompt if card on file, cash-collected toggle.
6. The **Earnings** tab on the phone shows today/this week using the same settlement math as the console's Earnings tab.
7. **Go off shift** stops GPS and offers.

**No data signal?** Everything still works by text: the job comes by SMS, and the driver replies **Y** (accept), **E** (on my way), **A** (arrived), **P** (passenger on board), **D** (done). The system updates the board from the text.

**Offline?** The app remembers the job list and the current job. Taps and GPS points queue on the phone and upload in order when signal returns, with the original times. The console shows "offline since 2:31 PM" and falls back to last-known / drop-off inference exactly as today.

**iPhone limitation (honest):** a browser app cannot report GPS while the phone is locked or the app is fully in the background. The web app keeps the screen awake while on a job and shows "Keep Skyway open while on a job". The console warns when a pin is stale for 2 minutes. **Phase 7 ships the real fix:** the same app wrapped as a store app (Capacitor) with true background location and push. This is a committed phase, not optional.

### Builder notes

**Connect flow**
- `connect-invite` Edge Function: creates `connect_tokens (token, driver_id, expires_at 24h, used)`, sends SMS via `sms-out`. Link `https://go.<domain>/d/<token>` → `driver.html?t=<token>`.
- JOIN keyword in `sms-in`: `Lookup` normalizes the sender to E.164; match `drivers.phone_e164`; if found → issue token and reply; if not → insert `pending_devices` row, raise Needs-you item.
- OTP: Supabase Auth phone sign-in with Twilio Verify as the SMS provider (message sender configured as the business number's Messaging Service where allowed; Verify's own sender otherwise). Success → `device_sessions (id, driver_id, auth_user_id, phone_e164, platform, push_subscription, app_version, last_seen, revoked)`.
- Consent: the connect screen states tracking is only while On shift, with a visible indicator; `drivers.body.consentAt` recorded.

**GPS pinning**
- `watchPosition({enableHighAccuracy:true, maximumAge:5000})`. Post to `driver_locations` when moved > 50 m or every 10 s while on a job; every 60 s while on shift idle; never when off shift. Batch up to 500 points offline.
- Trigger `driver_locations_latest()` denormalizes the newest point into `drivers.body.curLoc = {addr, when, lat, lng, source:'gps', heading, speed, accuracy}`. `addr` is filled lazily by the console's existing geocode cache (reverse geocode via `geocode` function) so Driver IQ's text labels still populate. `when` keeps the existing `'YYYY-MM-DD HH:MM'` string format produced by `todayStr()+' '+nowTime()` so every current reader works.
- Manual set-location writes `source:'manual'`; a GPS point with a newer `when` overrides and the console toasts the replacement.
- Retention: raw `driver_locations` kept 30 days; pg_cron rolls older rows into `driver_location_daily (driver_id, day, km_driven, first_at, last_at, trips)`.

**Offers and status**
- `offers (id, trip_id, driver_id, rank, reason, sent_at, expires_at, response, responded_at, channel)`. `offer-job` builds the ranked list from the console's Driver IQ output (passed in the request body so the ranking code stays in the browser) and walks it on expiry via pg_cron (`every 15 s` job scanning expired offers) or a `setTimeout` inside the function for the first 90 s.
- Trip `stage` values: `'booked' | 'offered' | 'assigned' | 'enroute' | 'onloc' | 'pob' | 'done' | 'canceled' | 'noshow' | 'disregard'`. The existing `status` string is derived by trigger and never changed by the phone: `booked/offered → 'Booked'`, `assigned/enroute/onloc/pob → 'Dispatched'`, `done → 'Completed'`, `canceled → 'Canceled'`, `noshow → 'No-Show'`, `disregard → 'Disregard'`. TLC CSV, board filters and colors therefore do not change.
- `trip_events (id, trip_id, driver_id, device_id, client_event_id, actor, type, occurred_at, received_at, lat, lng, data)`; unique on `(device_id, client_event_id)` so offline replays are idempotent; `occurred_at` is the phone's clock, `received_at` the server's.
- Field-level ownership enforced by trigger: a `driver` role may update only `body.stage`, `body.acceptedAt/enrouteAt/arrivedAt/pobAt/completedAt`, `body.waitMin`, `body.stops`, `body.tolls`, `body.signatureUrl`, `body.photos`, `body.cashCollected`, `body.driverNotes` on trips where `driver_id` = their driver, plus `drivers.body.curLoc` on their own row. Everything else is rejected.
- Geofence: `geofence` function runs on `driver_locations` insert (database webhook): haversine to the active trip's pickup/drop-off; 150 m default (`locations.body.geofenceM`); airport polygons from `config` key `airports`. Entering an airport fence on a trip without the airport fee applies the rate card's airport rule and notes it on the trip ("Airport fee added automatically").
- Push: Web Push (VAPID) in Phase 2; FCM/APNs through Capacitor in Phase 7.
- Earnings view on phone: SQL view `driver_settlement_v` ports the Earnings tab math (`feeWeek`, `feeTrip`, `feePct`, `split`, tolls, cash collected, tips) — the console keeps computing it in JS; the view must match it in tests.

---

## 5. Texting

### Plain English

All texts go out **from the business number**. The dispatcher never types a message for the normal flow — the system sends them at the right moments. Replies come back into the **Messages** panel on Today. Templates are editable in Settings → Messages (per language and region). Passengers can reply STOP to opt out; the dispatcher then sees "Call instead".

**Driver texts**

| Moment | Message |
|---|---|
| Connect | `SKYWAY: Tap to connect your phone to dispatch: https://go.skywaycar.com/d/K7F3Q (link good for 24h)` |
| Job offer | `SKYWAY JOB #4521 — Today 3:40 PM. PU: 77-35 164th St, Fresh Meadows. DO: JFK Terminal 4. John D., 2 pax, Sedan. $58 + tolls. Reply Y to accept, N to pass, or tap https://go.skywaycar.com/j/8KQ2 (90 sec)` |
| Offer went elsewhere | `SKYWAY: Job #4521 was given to another driver.` |
| Change | `SKYWAY: Job #4521 changed — new pickup time 4:10 PM (flight DL423 delayed). Reply OK.` |
| Cancel | `SKYWAY: Job #4521 is CANCELED. Reply OK.` |
| Status by text (no data) | Driver sends `E` (on my way) · `A` (arrived) · `P` (passenger on board) · `D` (done) · `W 10` (waited 10 min) |

**Passenger texts** (sent at the moment shown; `{…}` are filled in automatically)

1. **Booked** (when the dispatcher saves a trip that has a phone):
   `Skyway Car Service: Your ride is booked for Tue Nov 18, 3:40 PM. Pickup: 77-35 164 St, Fresh Meadows → JFK T4. Est. $58 + tolls. Conf #4521. Reply C to cancel or call (718) 555-0100. Track: https://go.skywaycar.com/t/9Hd2Lk`
2. **Driver assigned** (when the driver accepts):
   `Your Skyway driver is Mike R. in a black Toyota Camry, plate T123456C (Car 89). Photo & live map: https://go.skywaycar.com/t/9Hd2Lk`
3. **On the way** (driver taps On my way; re-sent only if the ETA changes by more than 5 minutes; a "5 min away" text fires from the geofence):
   `Mike is on the way — arriving in about 12 min.`
4. **Arrived** (driver taps Arrived or geofence confirms):
   `Mike has arrived at 77-35 164 St in Car 89 (black Camry T123456C). Please come out when ready.`
5. **Waiting / no-show warning** (10 minutes after Arrived, no Passenger-on-board):
   `Your driver is waiting at 77-35 164 St. Reply 5 for 5 more minutes, or call (718) 555-0100.`
6. **Completed** (card on file charged):
   `Thanks for riding with Skyway! Total $63.50 (incl. $5.50 tolls). Receipt & tip: https://go.skywaycar.com/r/9Hd2Lk`
   — or, no card on file: `Pay $63.50 for your Skyway ride: https://square.link/u/abc123`
7. **Reminder** (evening before, for trips booked more than 24 h ahead):
   `Reminder: your Skyway ride is tomorrow, Tue Nov 18 at 3:40 PM from 77-35 164 St. Reply C to cancel.`
8. **Flight delay** (airport pickups):
   small shift (≤ 15 min): `Flight DL423 is now landing 2:35 PM; we've moved your pickup to 3:05 PM.`
   large shift (> 15 min): `Flight DL423 is delayed to 4:40 PM. Shall we move your pickup to 5:10 PM? Reply YES to move or NO to keep 3:40 PM.`
9. **Cancellation confirmed**: `Your Skyway ride #4521 is canceled. Reply or call (718) 555-0100 to rebook.`

**Replies the system understands:** `C` / `CANCEL` (flags the trip and pops it in Needs-you for the dispatcher to confirm), `WHERE` / `ETA` (answers with the live ETA), `5` (adds 5 minutes wait), `YES` / `NO` (flight move), `STOP` / `START` / `HELP` (handled by Twilio). Anything else lands in the Messages panel. Dispatchers can also press **Text** on any trip card to send an ad-hoc message from the business number and see the reply in the thread.

**Email copies** go to passengers with an email on file and to corporate account contacts (with a calendar invite for booked rides).

**The tracking page** (`/t/<token>`, valid for the life of the trip + 2 hours): map with the plotted course, the car moving, driver name/photo/vehicle/plate, ETA, **Call driver** and **Text driver** buttons that go through a masked number so nobody's personal number is shown, and the receipt once done.

### How the business number sends texts (and what works today)

- **Mechanism:** Twilio Programmable Messaging with a Messaging Service whose sender is the business's own number.
- **If the number is a landline/VoIP line used for calls:** **Twilio Hosted SMS** text-enables it while voice stays exactly where it is (Letter of Authorization + a recent bill; 1–3 weeks).
- **If the number can be ported:** port it to Twilio, forward voice to the office phones (Twilio Voice → PBX/SIP). Bonus: a Twilio Voice webhook can feed the existing `?caller=` screen-pop so F1–F6 light up automatically.
- **A2P 10DLC** (required in the US for business texting from a local number): register the Brand (EIN) and one Campaign ("Customer care / delivery notifications: ride confirmations, driver assignment, ETA, receipts; opt-in by booking by phone or web; reply STOP to opt out"). Filed in Phase 0; approval 1–3 weeks.
- **Interim senders while waiting:** (a) a Twilio **toll-free number with toll-free verification** (faster) shown as "Skyway text line"; (b) the **`sms:` deep link that works today** — the console renders `sms:+1917…?&body=<message>` on every Text button, which opens the dispatcher's own phone/Messages app with the text prefilled (one tap to send); (c) email via Resend where an address exists.
- **Outside the US:** one Messaging Service per region — alphanumeric sender "SKYWAY" where allowed (UK, most of EU, AU; one-way) plus a local long code for two-way; local registration where required (Canada 10DLC-like, India DLT, UAE sender-ID).
- **Delivery tracking:** every text is a `messages` row with its Twilio SID; the `sms-status` webhook records queued → sent → delivered / failed, shown as a small checkmark or red icon on the trip card.
- **Cost:** about $0.0083 per segment in the US; ~6 texts per trip.

### Builder notes

- `sms-out (to, template, vars, trip_id, driver_id)` renders from `templates` (per `location_id` + language), writes `messages`, calls Twilio with `statusCallback`. `sms-in` validates the Twilio signature, normalizes `From` via Lookup, resolves driver vs passenger vs unknown, applies keyword routing, writes `messages`, emits Realtime. `sms-status` updates `messages.status`.
- Texts gated by the undo window: `notify` is called by `sync.js` after 10 s unless undone; the server also de-duplicates by `(trip_id, template, stage)` so a template is never sent twice for the same stage.
- `trips.body.sms = {confirm, assigned, enroute, arrived, waiting, receipt, reminder}` holds message ids so the console's "texts sent" strip renders offline.
- Opt-out: Twilio Advanced Opt-Out; `passengers.sms_opt_out=true` on STOP; `notify` skips and raises a Needs-you "Call instead" item.
- Masked calling on `track.html`: Twilio Proxy-style session (`masked_sessions (trip_id, proxy_number, expires_at)`) created on template 2; voice and SMS between the two parties relayed; expires 2 h after completion.
- Driver push + SMS are sent together for offers; SMS alone when no `push_subscription`.

---

## 6. Payments, billing and invoicing with Square

### Plain English

Square becomes a real part of the system instead of a bookmark. Once, in Settings, the owner presses **Connect Square** and logs in. After that:

- **Card on file:** a passenger's card is saved once — in the booking form ("Add card"), on the booking website, or by sending them a "Save a card" text with a secure Square form. Skyway never sees or stores card numbers; Square does.
- **Hold at booking:** for a card ride, Square puts a hold on the card for the estimate plus 20% (to cover tolls and waiting). The board shows a green "Card OK" chip. If the card fails, the trip lands in Needs-you before the car rolls. Holds are placed the morning of the trip for rides booked far ahead (Square holds expire in 7 days).
- **Charge at drop-off:** when the driver taps Complete, the final fare (fare + tolls + wait + stops + account/CCU fee + any automatic gratuity) is charged against the hold. The passenger gets the receipt text with a **Tip** button (15 / 20 / 25% / custom). If the charge fails, the system texts a pay link automatically and flags the trip.
- **Pay by text:** for walk-ups or cash-to-card, press **Send pay link**. The passenger pays on a Square page (tip included); the trip turns green when paid.
- **In the car (optional):** a Square reader paired to the driver's phone for tap-to-pay.
- **Cash and account trips:** nothing is charged; the console behaves exactly as today. Account trips accumulate for invoicing.
- **Corporate invoices:** the Invoicing tab keeps the printable invoice with the CCU fee **and** gains **Send via Square**: Square emails the customer an invoice with one line per trip plus the CCU fee, they pay by card or bank (ACH), and the invoice and all its trips mark themselves paid. Statements and an aging column appear in Accounts. Weekly or monthly cycles per account.
- **Refunds and no-show fees** from the trip's Money panel, with a reason that is logged.
- **Receipts:** Square's receipt plus Skyway's own branded receipt page.
- **Driver payouts:** the Earnings tab math is unchanged (`feeWeek / feeTrip / feePct / split`, tolls, cash collected, tips 100% to the driver). Card fares collected by the office show as "collected by office" so the settlement nets correctly. Each period produces a settlement row and a payout file the owner picks: a bank ACH/CSV batch, Square Payroll contractor pay, or a Gusto/Melio CSV. Square itself cannot split a payment to a driver.
- **Nightly check:** the system compares Square's list of payments with its own and flags any mismatch in MONEY → P&L.
- The current **Virtual Terminal link stays** in Settings as a manual fallback.

### Builder notes

- OAuth: Square app (sandbox + production); `Connect Square` → OAuth → access/refresh tokens in Supabase Vault; `locations.square_location_id`. `settings.squareConnected=true`.
- Cards: Square Web Payments SDK in the console (`#addCardDlg`), `book.html`, `pay.html`; token → `Customers.CreateCustomer` (reference = phone E.164) → `Cards.CreateCard`; store `passengers.cards[{squareCardId,last4,brand,exp}]`, `square_customer_id`. Accounts get a Square Customer too.
- Authorize: `square-charge` `CreatePayment {autocomplete:false, amount = estimate*1.2, reference_id = dispatchNo, note = route, idempotency_key = trip.id+':auth'}` when `payType==='Credit Card'` and a card is on file and pickup < 7 days; otherwise pg_cron places it 24 h before (grafted from Managed-Services).
- Capture: on `stage='done'` → compute final = `fare + tolls + waitFee(rate card) + stopFee×stops + ccu (accounts) + autoGratuity%`; if ≤ hold → `UpdatePayment` (amount, tip_money) then `CompletePayment`; if > hold → `CancelPayment` + `CreatePayment {autocomplete:true}` on the card. Failure → `body.payment.status='failed'`, auto `square-link`, Needs-you item.
- Pay link: `Checkout.CreatePaymentLink {quick_pay, checkout_options:{allow_tipping:true, redirect_url: pay.html?t=}}`.
- Tips: `pay.html` → `CreatePayment` with `tip_money` against the card on file, or tip inside the link; written to `trip.tip` (existing field) → Earnings unchanged.
- Invoices: `square-invoice` creates an Order (one line per trip: dispatchNo, date, route, fare, tolls; CCU fee as its own line) + Invoice (delivery EMAIL, `payment_requests` due per `accounts.net_days`, custom field account number, PDF from the existing printable template stored in Supabase Storage attached). `invoice.payment_made` webhook → `invoices.status='paid'`, trips `body.payment.status='paid'`.
- Webhooks: `square-hook` verifies the signature, idempotent by `event_id` (`square_events` table): `payment.created/updated`, `refund.updated`, `invoice.payment_made/updated/canceled`, `card.forgotten`, `customer.updated`.
- `payments (id = square payment id, trip_id, invoice_id, kind auth|capture|link|invoice|refund|tip|cash|terminal, amount, tip, fee, currency, status, receipt_url, raw)`. All money in minor units + ISO-4217 currency.
- Reconciliation: pg_cron nightly `reconcile-square` compares `ListPayments(day)` with `payments`; mismatches into `reconcile_issues` surfaced in Business.
- Settlement: `settlements (driver_id, period_start, period_end, gross, commission, tolls, cash_collected, tips, net, paid_at, method, export_url)` computed by the console's existing Earnings code and written through `sync.js`; export formats: NACHA/CSV, Square Payroll contractor CSV/API, Gusto/Melio CSV.
- Provider seam: `PaymentProvider` interface `{saveCard, authorize, capture, charge, link, invoice, refund, webhook}` with `square` implemented and `stripe` stubbed (Phase 5) for countries Square does not serve.
- PCI: SAQ-A — card data only ever touches Square's hosted fields.

---

## 7. Maps and routing

### Plain English

Google Maps becomes the main map everywhere — booking preview, the board, the driver's phone, the passenger tracking page — with the plotted course drawn on it and live ETAs. The free fallbacks the console already has (OpenStreetMap tiles, OSRM routes, Photon/Nominatim addresses, the offline route diagram) stay, so if Google is slow nothing freezes. Address entry uses Google's autocomplete tuned to the region (NYC keeps its curated address book and seeds first). Drivers get turn-by-turn by handing off to Google Maps, Waze or Apple Maps — no extra licensing. Circles around pickups and airports let the system know when a car has arrived or entered an airport.

### Builder notes

- **Maps JavaScript API** (vector map ID, Advanced Markers with car icons rotated by heading) for the Dispatch preview, Trip Map, Zone Map, Optimizer, `track.html`, `driver.html`. Leaflet + OSM remain the automatic fallback (existing 5 s timeout kept).
- **Places API (New) Autocomplete** with `locationRestriction/bias` and `includedRegionCodes` from the Region profile and session tokens; the Address Book pins and NYC `PLACES` seeds answer first (offline).
- **Geocoding API** with the existing Photon/Nominatim fallback; results cached in `config` key `geocache` (= `STATE.geocache`) so repeats are free; reverse geocoding of driver pins.
- **Routes API** `computeRoutes` (`TRAFFIC_AWARE_OPTIMAL`, `departureTime` = pickup, `intermediates` = stops, `extraComputations: TOLLS`) → encoded polyline, distance, duration, toll estimate stored on `trips.body.route = {polyline, distanceM, durationS, tollsEst}`; drawn everywhere. Toll estimate feeds the tolls field as a suggestion (dispatcher/driver can override).
- `computeRouteMatrix` for the Optimizer's deadhead matrix (drivers × open pickups, one request, batched under quota) replacing N×M calls; the greedy chaining heuristic is unchanged; OSRM fallback kept.
- Live ETA: `route` function every 60 s or when the driver moves > 500 m while `stage in ('enroute')`; drives template 3 and the board's "ETA 12m" chip.
- Geofences: `geofence` function (section 4). Airports and zones as polygons in `config` (`airports`, `zones` = `STATE.zones`), editable on the Zone Map (Leaflet draw retained), rendered on Google tiles when online.
- Keys: the browser key in `settings.gmapkey` is **rotated and HTTP-referrer-restricted in Phase 0**; server-side calls (`route`, `geocode`, matrix) use a separate key in Vault, so the browser key is only ever good for Maps JS + Autocomplete on the app's domains. Budget alerts and per-SKU quotas set in Google Cloud.
- Flight tracking: `flight-poll` (pg_cron) polls AeroDataBox (or FlightAware AeroAPI) hourly from T-6 h, every 10 min in the last 2 h; writes `trips.body.flight = {no, sched, est, status, terminal}`; applies the ≤ 15 min auto-move / > 15 min ask rule; texts passenger and driver.

---

## 8. Global / multi-region

### Plain English

Everything that is "New York" today becomes a **Region profile** you fill in once: country, time zone, currency, miles or km, phone format, address style, map center, which pricing engine, which airports, which text sender, which Square location. NYC is simply the first region, with the TLC meter, base number `B01593`, CCU fee and TLC export switched on. Adding Miami or London is a Settings task, not a programming task. One owner can run several regions under one login; the board and reports show one region at a time, with a cross-region roll-up in Business (each region in its own currency — no silent conversion).

### Builder notes

- `locations (id, name, country, tz, currency, locale, units, phone_cc, address_format, map_center, map_bounds, pricing_engine, tax_rule, twilio_messaging_sid, sms_sender_type, square_location_id, payment_provider, regulatory_export, geofence_m, business_hours, after_hours_rule, body)`.
- **Time:** all timestamps `timestamptz` UTC in Postgres; the console keeps its local `date`/`time` strings and `sync.js` tags them with the location tz on write and converts on read; `track.html` shows the viewer's device zone. DST-safe via Luxon/Intl.
- **Currency:** `Intl.NumberFormat(locale,{style:'currency',currency})` replaces the hard-coded `'$'` in `money()` via a one-line override in `sync.js` (`window.money = …`) keyed on the region; all stored amounts in minor units with currency.
- **Phones:** `libphonenumber-js` parses local input to E.164 (`phone_e164` columns) with Twilio Lookup validation at entry; Caller ID lines and callerbook match on E.164 and display national format.
- **Addresses:** Places `includedRegionCodes`, country-specific formatting template (UK postcode-first, Japan reversed), `addrbook` rows carry `formatted_address`, `place_id`, `components`, lat/lng so engines work from coordinates rather than NYC street grammar.
- **Pricing engines** (pluggable, selected per location, versioned rate cards in `config`): `nyc_tlc_meter` (existing, untouched, default for NYC), `zone_matrix` (existing `STATE.fares` 'a|b' matrix with polygons drawn on the Zone Map or imported from GeoJSON), `flat_book` (airport/neighborhood books), `distance_time` (base + per-mile/km + per-minute, minimum, wait, stop fee), `hourly` (hourly rate, minimum hours, overtime). Shared surcharge stack: gratuity %, tolls, airport fee, wait, stops, after-hours/holiday %, promo codes (`promos` table). Learned route fares (`skyway_routebook`) already key on addresses and work anywhere.
- **Regulatory exports:** TLC CSV for NYC; a generic trip-record CSV (same columns, no base number) elsewhere; plugin list per location.
- **Messaging per region:** one Messaging Service per location; templates per language in `templates`.
- **Payments per region:** Square locations in US, CA, UK, IE, FR, ES, AU, JP; `payment_provider='stripe'` elsewhere via the adapter.
- **Multi-location:** every row carries `location_id`; dispatcher logins list their locations; RLS filters; `Business` adds a per-location roll-up view.
- **Example — Miami:** Settings → Region → Add: name Miami, America/New_York, USD, +1, miles, map center Miami, engine `distance_time` ($3.50 base + $2.75/mi + $0.60/min) or draw 8 zones, airports MIA/FLL with polygons, tax none, Square location "Miami", a 305 Twilio number on a new Messaging Service. Drivers connect the same way; the board shows Miami trips on that login.

---

## 9. Data migration from the current app (zero loss)

### Plain English

Nothing is converted by hand and nothing is thrown away. The console's own **Export / Backup** file is the starting point and the rollback point. When Cloud is switched on, the console uploads everything it has, the system counts it all before and after and shows a reconciliation screen (trips, drivers, vehicles, accounts, invoices, total fares by month, first/last dispatch number) that must match to the cent before "Cloud on" is accepted. The browser copy stays as the offline cache. Turn Cloud off and the console is a pure local app again with all its data.

### Steps

0. **Backup.** Settings → Export/Backup (extended to include every side key and the IndexedDB history, with a checksum). Git tag `v3-local` on the current `index.html`.
1. **Host.** Publish the unchanged `index.html` to Cloudflare Pages under the business domain (HTTPS is required for GPS, service workers, push and the referrer-restricted Google key). The localhost launchers keep working.
2. **Add sync.js.** One `<script src="sync.js">` tag at the end of `index.html` and a Settings → Cloud card (URL, anon key, location, Connect). First connect: upload the whole `STATE` (already normalized by `migrate()`) as rows with `rev=now`, then the IndexedDB `skyway_history` archive in 500-row batches with a progress bar; then the reconciliation report (go/no-go gate).
3. **Dual run (1–2 weeks).** Cloud on at the station; a second browser/phone proves realtime; the nightly Export/Backup still works and now also comes from Postgres (`pg_dump` schedule, 30-day retention). A nightly re-import diff catches anything missed.
4. **Drivers one at a time.** A driver without a connected phone is dispatched the old way (manual location / drop-off inference). Mixed fleets are fine.
5. **Texting, Square, Simple mode, Region** are each a Settings toggle. When off, the `sms:` deep link and Virtual Terminal link are the fallbacks.
6. **Rollback at any time.** Cloud off → pure local app with its current localStorage copy. The 3.9 MB single file is never split without the owner's say-so; all new code lives in separate files (`sync.js`, `simple.js`, `driver.html`, `book.html`, `track.html`, `pay.html`, `supabase/functions/*`).
7. **Keys.** The Google key embedded in `index.html` is rotated and referrer-restricted in Phase 0; server keys live in Vault.

### Builder notes — field mapping

- Every table stores the existing STATE object **verbatim** in a JSONB `body` column plus promoted columns for indexing/RLS (grafted strengthening: promote `stage, status, driver_id, vehicle_id, account_id, date, time, pay_type, payment_status, dispatch_no` on `trips` from day one). Primary keys reuse the console's `uid()` ids so an offline booking keeps its id on sync.
- `skyway_dispatch_v2` → `settings` (per location; `gmapkey` removed from the body and kept server-side), `trips`, `drivers`, `vehicles`, `accounts`, `addrbook`, `config` rows for `zones, fares, farebook, hints, geocache, addrFix, compliance, map`, `finance`; `dispatchSeq`/`invoiceSeq` → Postgres sequences per location (offline bookings use a temporary negative `dispatchNo`, renumbered on sync — the console treats `dispatchNo` as data, not identity; texts are not sent until after sync so a passenger never sees a temporary number).
- `skyway_routebook` → `config.routebook`; `skyway_callerbook` → `passengers` (phone E.164, name, email, saved addresses, notes) and `config.callerbook`; `skyway_histseed` + IndexedDB `skyway_history` → `call_history (location_id, at, body)`; `skyway_webseen`, `skyway_help_seen`, theme → per-user settings (localStorage, not migrated).
- `migrate()` gains the new optional fields with defaults (`stage`, `serviceType:'oneway'`, `sms:{}`, `payment:{}`, `flight:null`, `route:null`, `trackToken`) so old backups import cleanly forever.
- Sync mechanics: on `persist()`, diff STATE against the last synced snapshot per collection, upsert changed rows with `rev=updated_at`; queue in `skyway_sync_queue` when offline; on Realtime change, patch the matching element in STATE then call the existing `syncRefresh()`. Conflict rule: last-writer-wins per row by `rev`, with the trigger-enforced field ownership for phones and an `events` audit trail; a conflict banner with Undo when two consoles edit the same trip within 10 s.
- Reconciliation report: counts per collection; `SUM(fare)` by month; driver earnings per period; invoice numbers; first/last `dispatchNo`; must equal what the single-file app shows.

---

## 10. Phased roadmap (about 20 weeks, one developer)

| Phase | Weeks | Deliverables | Client-side now vs backend |
|---|---|---|---|
| **0 — Prep & registrations** | 1 (overlaps with 1) | Backup + git tag; Cloudflare Pages hosting; Supabase project; Twilio account, Hosted-SMS/port LOA for the business number, **10DLC brand + campaign submitted**, interim toll-free number verified; Square developer app (sandbox + production) + OAuth; Google Cloud project with Maps JS, Places (New), Geocoding, Routes enabled, **browser key rotated and referrer-restricted**, server key in Vault; Resend domain; **`sms:` deep-link Text buttons shipped in the console** | Client: `sms:` links, key rotation. Backend: accounts and paperwork only |
| **1 — Cloud mirror** | 2 | Postgres schema + RLS + triggers + promoted columns; `sync.js` hooking `persist()`/`reloadFromStorage()`; Settings → Cloud card; first-sync importer (STATE + IndexedDB history) with reconciliation gate; dispatcher login; realtime between stations; nightly `pg_dump`; dual-run week | Client: `sync.js`. Backend: schema, `sync-bulk` |
| **2 — Driver phones & live GPS** | 3 | `driver.html` PWA (install flow, OTP from the business/interim number, job list, Accept/Pass, 5-step status rail, Navigate links, notes, stops/tolls/wait, signature, photo, earnings); Connect-phone button + **JOIN-by-text**; `driver_locations` + `curLoc` trigger; live pins on Board/Optimizer/Driver IQ/Trip Map/Drivers; `stage`→`status` trigger; **90-second offer cascade** visible on the board; geofence Arrived + airport fee; offline outbox with `(device_id, client_event_id)` idempotency; SMS-only status codes; 30-day location retention | Client: `driver.html`, pins in console. Backend: `connect-invite`, `offer-job`, `geofence`, triggers |
| **3 — Texting** | 2 | Messaging Service on the business number (or interim) with 10DLC attached when approved; `sms-out`/`sms-in`/`sms-status`/`notify`; driver job texts with Y/N; passenger templates 1–9; `track.html` with plotted course and masked Call/Text; Messages panel on the console; opt-out; no-show "reply 5"; reminders (pg_cron); delivery icons | Client: Messages panel, `track.html`. Backend: all SMS functions |
| **4 — Square payments & billing** | 3 | Connect Square (OAuth → Vault); Web Payments SDK card-on-file in booking form + "Save a card" text; hold at booking (+ pg_cron day-of re-auth); charge at drop-off with tip; pay links; `pay.html` tip/receipt; webhooks → Paid badges; Square Invoices for accounts with CCU fee + PDF; refunds; settlement export (ACH CSV / Square Payroll / Gusto); **nightly Square reconciliation**; Money screen's Unpaid rides list | Client: card dialog, Money list, `pay.html`. Backend: `square-*`, `reconcile-square` |
| **5 — Simple mode & Region** | 3 | Five-section shell + Today home + **Needs-you strip** + **10-second undo everywhere** + one-primary-button rule + PIN-locked Settings + typed confirmations + **6-step setup wizard** + first-run checklist + "Show me" tours + printed cheat sheet + **Expert mode**; Region profile (tz, currency, units, phone, address bias, engine, zone import, airports); generic regulatory CSV; multi-location filtering; `computeRouteMatrix` in the Optimizer; Stripe adapter stub | Client: `simple.js/css`, region code in `sync.js`. Backend: `locations`, `templates` per language |
| **6 — Online booking, flights, polish** | 2 | `book.html` widget with instant quotes (`quote` function ports the fare engines), passenger profiles with saved addresses/cards, round-trip/hourly/airport service types; `flight-poll` with the ≤15/>15-minute rule; driver performance & revenue reports from `events`/`payments`; email copies with .ics | Client: `book.html`. Backend: `quote`, `flight-poll` |
| **7 — Native driver app** (committed) | 3 | Capacitor build of `driver.html` with background location and FCM/APNs push; TestFlight / Play internal → store listings; iOS/Android install guides | Client: Capacitor project. Backend: push senders |
| **8 — Harden, launch, optional AI/affiliates** | 1–2 | Pilot with 3–5 cars; load/offline tests; monitoring and owner alerts; security review of RLS/webhooks; documentation; optional `ai-draft` text-to-book with dispatcher confirmation; affiliate farm-out (send a job to a partner's phone as a read-only job link) | Both |

**Milestones the owner will notice:** week 3 — same console, now in the cloud and on two machines; **week 6 — drivers pinned live**; **week 8 — drivers and passengers getting texts from the business number**; **week 11 — cards charged at drop-off, Square invoices**; week 14 — the simple five-screen console; week 16 — online booking and flight tracking; week 19 — store app with background GPS; week 20 — launch.

Each phase is a Settings toggle. The owner can stop after any phase with a working system.

---

## 11. Monthly costs

Assumes one region, 10–15 drivers, ~2,000 trips/month, USD.

| Service | Monthly | Notes |
|---|---|---|
| Supabase Pro | $25 (+ ~$10 compute if Realtime grows) | Free tier is fine for the pilot |
| Cloudflare Pages + domain | $0–1 | |
| Twilio: business number (Hosted SMS or local) | $1–3 | |
| Twilio: 10DLC campaign | $1.50–10 | one-time brand $4 (standard) / $44 (vetted), campaign vetting $15 |
| Twilio: SMS at ~6 texts/trip ≈ 12,000 segments | $100–150 | $0.0083/segment + carrier pass-through; shorter templates lower it |
| Twilio: Verify OTP, Lookup, masked numbers | $5–15 | |
| Google Maps Platform | $50–150 | Routes, Places Autocomplete sessions, Geocoding; geocache and the free per-SKU tiers keep it low; hard quota + alerts; Route Matrix for the Optimizer is the main meter |
| Flight data (AeroDataBox) | $10–30 | FlightAware AeroAPI ~$20–50 if preferred |
| Resend email | $0–20 | |
| Sentry + uptime | $0–26 | free tiers at this size |
| Claude API (optional AI drafts) | $10–30 | Phase 8 only |
| **Total platform** | **≈ $200–400 / month** | vs LimoGrid-class SaaS typically priced per vehicle per month plus SMS/payment add-ons |
| Square processing (separate, on card volume only) | 2.9% + 30¢ online / payment links; ~3.5% + 15¢ card on file; 3.3% + 30¢ invoices by card; 1% ACH on invoices; 2.6% + 15¢ with a reader | no monthly fee |
| One-time | 10DLC $20–60; Square reader $49–299 if wanted; Apple Developer $99/yr + Google Play $25 (Phase 7); build ≈ 20 weeks of one full-stack developer plus the owner for testing | |

---

## 12. Risks and decisions needed from the owner

### Risks and how they are handled

1. **iPhone stops GPS when locked** (browser app). Wake lock during jobs, "keep open" banner, stale-pin alerts, SMS status codes; **fully solved by the Phase 7 store app** (committed, not optional).
2. **10DLC / Hosted-SMS paperwork takes 2–5 weeks.** Filed in Phase 0; interim verified toll-free number; `sms:` deep links and email work from day one.
3. **Business number's carrier won't host SMS.** Port the number and forward voice; or run texting on the toll-free "Skyway text line" until ported.
4. **Browser storage ceiling (5–10 MB) as trips grow.** Once Cloud is the source of truth the console keeps a rolling 12-month local window and lazy-loads older trips; the single file is only split if the owner agrees.
5. **Two consoles editing the same trip.** Row-level last-writer-wins by `rev`, trigger-enforced field ownership for phones, audit trail, conflict banner with Undo.
6. **Exposed Google key in the current file.** Rotated and referrer-restricted in Phase 0; server key in Vault.
7. **Square holds expire after 7 days / card declines at drop-off.** Day-of re-authorization for advance bookings; "Card OK" chip; automatic pay link and cash fallback; Needs-you item.
8. **Google Maps bill spikes.** Server-side proxy with cache, Route Matrix batching, quotas and alerts; OSRM fallback.
9. **Driver privacy and consent.** Tracking only On shift with a visible indicator, consent recorded at connect, 30-day raw retention then daily summaries, NY/NJ law check.
10. **Fare parity outside NYC.** Generic/flat/hourly engines ship with tests against the existing NYC engine so nothing regresses.
11. **Dispatcher trust in automation.** Every automatic action (auto-assign cascade, auto-arrived, auto-charge, auto-airport-fee) is a toggle with Undo and a "why" line, following the existing ★ Best pattern.
12. **Migration fidelity.** Reconciliation report must match to the cent before Cloud is accepted; old file kept read-only; nightly diff during dual run.
13. **Carrier spam filtering.** Registered 10DLC, consistent templates, branded domain links, no URL shorteners.
14. **Single-developer bus factor.** All new code in separate files with a README section per function; keys in Vault; nightly `pg_dump` plus the owner's one-click Export/Backup.
15. **Regions outside Square's countries.** Stripe adapter behind the same interface (stub in Phase 5).
16. **TLC compliance.** NYC export unchanged; `stage → status` trigger keeps 'Dispatched' semantics so TLC files are identical.

### Decisions needed from the owner

1. **The business phone number:** which number should texts come from, and is it a landline/VoIP line (Hosted SMS, voice stays put) or can it be ported to Twilio (voice forwarded, caller-ID screen-pop becomes automatic)? Who signs the Letter of Authorization and can supply a recent bill and the business EIN for 10DLC?
2. **Domain:** which domain for `app.`, `go.` (links in texts), `book.` and `track.`? (Short links in texts must be on your own domain.)
3. **Square:** use the existing Square account; do you want an in-car reader ($49–299)? Which driver-payout method: bank ACH/CSV, Square Payroll, or Gusto/Melio?
4. **Automatic gratuity** for account rides (percent, which accounts) and the **no-show fee** rule.
5. **Hold at booking:** OK to hold estimate + 20% on passengers' cards, or hold the estimate only?
6. **Who is a dispatcher, who is the owner (admin PIN), and should drivers see fares on offers?**
7. **Driver tracking policy:** On-shift-only tracking (recommended) and 30-day raw retention — agree? Written consent text for drivers.
8. **Passenger consent wording** on phone bookings ("By booking you agree to receive ride updates by text; reply STOP to opt out") — dispatchers must say it or it must be on the website/widget.
9. **Store app (Phase 7):** publish under the business's own Apple Developer and Google Play accounts (needs the owner to open them) or under the developer's?
10. **Region plan:** NYC only for now, or is a second region (which city) wanted within the year? This decides when Phase 5's region work is prioritized.
11. **Simple mode default:** Simple mode on for everyone with Expert mode behind the PIN (recommended), or Expert mode on for the owner's station?
12. **Flight data provider:** AeroDataBox (cheaper) vs FlightAware (more accurate, pricier).
13. **AI assistant and affiliate farm-out:** wanted in Phase 8 or parked?
14. **Budget sign-off:** ~$200–400/month running cost and ~20 weeks of development.

---

## Appendix A — Database tables (Supabase Postgres)

All tables: `id` (text, from `uid()` where the console created the row, else uuid), `location_id`, `created_at`, `updated_at`, `rev`, `deleted_at`, `body JSONB`. RLS by `location_id` and role.

| Table | Promoted columns | Source |
|---|---|---|
| `locations` | name, country, tz, currency, locale, units, phone_cc, pricing_engine, square_location_id, twilio_messaging_sid, payment_provider | new (NYC seeded from `STATE.settings`) |
| `settings` | location_id (PK) | `STATE.settings` (minus `gmapkey`) |
| `trips` | dispatch_no, date, time, stage, status, driver_id, vehicle_id, account_id, pay_type, payment_status, track_token | `STATE.trips[]` |
| `trip_events` | trip_id, driver_id, device_id, client_event_id (unique with device_id), type, occurred_at, received_at, lat, lng | new |
| `offers` | trip_id, driver_id, rank, reason, sent_at, expires_at, response | new |
| `drivers` | phone_e164, auth_user_id, active, on_shift, car_no | `STATE.drivers[]` (body gains `curLoc.lat/lng/source/heading/speed/accuracy`, `photoUrl`, `consentAt`) |
| `driver_locations` | driver_id, at, lat, lng, heading, speed, accuracy, battery, trip_id | new (30-day retention) |
| `driver_location_daily` | driver_id, day, km, first_at, last_at | new |
| `device_sessions` | driver_id, auth_user_id, phone_e164, platform, push_subscription, last_seen, revoked | new |
| `connect_tokens` | token, driver_id, expires_at, used | new |
| `vehicles` | plate, type, cap, driver_id | `STATE.vehicles[]` |
| `accounts` | number, name, email, square_customer_id, billing_cycle, net_days | `STATE.accounts[]` |
| `passengers` | phone_e164, name, email, square_customer_id, sms_opt_out | derived from `trips` + `skyway_callerbook` |
| `addrbook` | place_id, lat, lng | `STATE.addrbook[]` + `STATE.addrFix` |
| `config` | key (zones, fares, farebook, routebook, hints, geocache, compliance, map, airports, rate_card, promos) | `STATE.*` + `skyway_routebook` |
| `finance` | period | `STATE.finance` |
| `call_history` | at, phone_e164 | IndexedDB `skyway_history` + `skyway_histseed` |
| `invoices` | invoice_no, account_id, period, total, status, square_invoice_id, pdf_url | existing generator + `invoiceSeq` |
| `payments` | trip_id, invoice_id, kind, amount, tip, fee, currency, status, receipt_url | new (Square webhooks) |
| `square_events` | event_id (unique), type, processed_at | new |
| `reconcile_issues` | day, square_payment_id, kind, note, resolved | new |
| `settlements` | driver_id, period_start, period_end, gross, commission, tolls, cash_collected, tips, net, paid_at, method | Earnings tab math |
| `messages` | direction, to_e164, from_e164, trip_id, driver_id, template, twilio_sid, status, at | new |
| `templates` | location_id, language, key, text | new (defaults = section 5) |
| `masked_sessions` | trip_id, proxy_number, expires_at | new |
| `events` | trip_id, driver_id, actor, type, at | audit log (console actions) |
| `promos` | code, rule, valid_from, valid_to, uses | new |
| `affiliates` | name, phone_e164, rates | new (Phase 8) |
| Sequences | `dispatch_seq_<location>`, `invoice_seq_<location>` | `STATE.dispatchSeq`, `STATE.invoiceSeq` |

## Appendix B — Edge Functions (Deno/TypeScript, `supabase/functions/`)

`sync-bulk` (first import + reconciliation) · `connect-invite` · `sms-out` · `sms-in` · `sms-status` · `notify` (templates + de-dup + undo gate) · `offer-job` (cascade) · `geofence` (DB webhook on `driver_locations`) · `quote` (fare engines ported for `book.html` / AI) · `route` · `geocode` · `square-charge` · `square-link` · `square-invoice` · `square-hook` · `reconcile-square` (cron) · `flight-poll` (cron) · `settle` (cron, settlement rows) · `ai-draft` (optional) · `export-backup` (same JSON bundle format as the console's Export/Backup).

## Appendix C — Settings keys added (all optional; old backups import unchanged)

`settings.cloud {url, anonKey, locationId, enabled}` · `settings.twilioReady` · `settings.squareConnected` · `settings.simpleMode` · `settings.expertMode` · `settings.adminPin` · `settings.region` (mirror of the `locations` row) · `settings.automation {autoAssign, autoArrived, autoCharge, autoAirportFee, offerSeconds:90, geofenceM:150}` · `settings.square` (existing Virtual Terminal link — kept).

## Appendix D — Nothing removed

Every tab, engine, pop-out screen, export, theme, keyboard shortcut and stored record in the current `index.html` is preserved. The only changes to the file itself are: one `<script src="sync.js">` tag (Phase 1), one `<script src="simple.js">` tag (Phase 5), and a rotated Google key (Phase 0). Expert mode shows the original interface byte-for-byte.
