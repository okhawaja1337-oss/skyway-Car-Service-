# Skyway Dispatch Console

A single-file, offline-capable dispatch console for a NYC-area car / livery service.
Everything runs in the browser — no server, no build step, no install. Open
`index.html` and it works. All data (trips, drivers, vehicles, accounts, address
book, pricing, call history) is stored locally in the browser via
`localStorage` / IndexedDB, so it survives refreshes and works with no internet.

## Running it

**Recommended — run it at `http://localhost` (needed for Google Maps):**

- **Windows:** double-click **`start-skyway.bat`**
- **Mac:** double-click **`start-skyway.command`** (first time you may need
  `chmod +x start-skyway.command`)
- **Any OS, manually:** `python3 -m http.server 8080` then open
  `http://localhost:8080/index.html`

The launcher serves the app at `http://localhost:8080` and opens your browser.
Keep the little window open while you work; close it to stop.

You *can* also just double-click `index.html`, and booking, pricing, the board,
invoicing and exports all work that way — **but a Google Maps API key will not
work from a `file://` page** (Google blocks it), which is the usual cause of
"Google is stalling". Running at `http://localhost` fixes that.

Works in any modern browser (Chrome, Edge, Firefox, Safari). No accounts, no
backend. To move a station to a new machine, use **Settings → Export / Backup**
and import the file on the other machine.

### Making Google Maps work

Add your key in **Settings → Google Maps API key**, then click **Test Google
now** for a plain-language pass/fail. To get a green result:

1. Run the app at `http://localhost:8080` (the launchers above) — not `file://`.
2. In Google Cloud, enable **Maps JavaScript API**, **Geocoding API**,
   **Places API** and **Directions API**.
3. Turn on **Billing** (Google's free monthly credit covers small fleets).
4. On the key's **Website restrictions**, add `http://localhost:8080/*` (plus
   your real domain if you host it).

If Google is ever slow or blocked, the app now **falls back automatically** to a
free service and never freezes waiting on it — everything else keeps working
offline from your Address Book pins.

## What it does

| Tab | Purpose |
|-----|---------|
| **Dispatch** | Book trips, live Caller-ID lines (F1–F6), auto-fare, the active board, and one-click driver assignment. |
| **Trips** | Full searchable trip records with filters and CSV export. |
| **Call History** | Archive of historical calls (loaded into an in-browser database). |
| **Trip Map / Zone Map** | Plot trips and service zones on a street map (Leaflet/OpenStreetMap) with an offline route-diagram fallback. |
| **Fare Estimate** | NYC TLC-accurate metered fare estimator with tolls, surcharges and airport flat rates. |
| **Accounts / Invoicing** | Corporate/house accounts and printable invoices. |
| **Zones & Pricing** | Zone-to-zone fare matrix, rate card and toll reference. |
| **Fleet** | Drivers and vehicles, capacity and type matching. |
| **Earnings** | Per-driver settlement and payout math. |
| **Driver IQ** | Ranks the best driver for a call from caller history, route familiarity, zone and last-known location; staging suggestions and per-driver playbooks. |
| **Optimizer** | Live fleet map plus an auto-dispatch planner that chains every open call to the driver who reaches it with the fewest empty miles, keeping cars continuously moving. |
| **Address Book** | Saved, geocoded pickup/drop-off locations for instant autocomplete. |
| **TLC Reports** | Trip-record exports formatted for TLC/FHV reporting. |
| **Business** | Monthly P&L, expenses and finance CSV export. |
| **Settings** | Branding, backup/restore, and import from a prior system. |

### Handy shortcuts

- **F1** Help · **F2** New trip · **F3** Find · **F4** Board · **F5** Refresh
- **F1–F6** open a new job from the matching Caller-ID line
- **Ctrl-K** (⌘K on Mac) jump to the global search from anywhere
- Screen-pop from a phone system: open with `?caller=NUMBER&name=&pickup=&dropoff=`

## Recent improvements

- **Google reliability fix + a lighter UI** — Google geocoding/search/routing
  calls now time out (5s) instead of hanging, so a slow or blocked Google can no
  longer freeze the app; it falls back to the free service automatically. Added
  one-click **launchers** (`start-skyway.bat` / `.command`) to run at
  `http://localhost:8080` (the real fix for "Google is stalling", which is
  caused by opening the app as a `file://` page), plus a **Test Google now**
  button in Settings with exact, plain-language fixes. A new **Light theme**
  (clean, soft, easy on the eyes) is now the default; Black & Gold and Classic
  are still available in Settings.
- **Pop-out screens that talk to each other (real-time)** — the console and every
  pop-out (Calls, Reservations, Caller ID, Board, Wall Board, Map) now share
  live state instantly over a cross-window bus (BroadcastChannel with a
  localStorage fallback). Book, dispatch, assign or set a location in any window
  and all the others update at once. Pop-outs can also *drive* the main console:
  "Open in console →" on a call opens that job in the dispatcher, and "Start a
  job for this caller →" on Caller ID pulls the number up on the booking form. A
  live indicator in the status bar shows how many screens are connected. This is
  the multi-monitor dispatcher setup that systems like iCabbi, Autocab, Limosys
  and TaxiCaller center their consoles on.
- **Fluid, easier-on-the-eyes UI** — smooth view transitions, button and row
  micro-interactions, a softer layered background, refined focus outlines and
  scrollbars, and a pulsing live-sync dot. All honor `prefers-reduced-motion`.


- **Fleet Optimizer (new tab)** — maps where every driver is (or will be after
  their current drop-off) and chains each open call to the driver who reaches it
  with the fewest empty "deadhead" miles, so pickups come faster and cars stay
  in motion. It shows:
  - a **live fleet map** (Leaflet online, offline scatter map otherwise) with
    idle vs on-trip drivers, open pickups and drop-offs, and each assignment's
    empty + fare legs drawn as **real, map-style road routes** (like Google
    Maps) with distance + drive-time tooltips;
  - **ranked assignments** — the best driver for each open call with the empty
    and fare leg distances/times and **pick-up + drop-off ETAs**, one-click
    *Assign* or *Apply all*;
  - **driver chains** — each driver's next back-to-back runs with time windows,
    total empty miles and a "% loaded" utilization figure.

  Distances and times work offline from the Address Book; when online it fetches
  real road routes (Google or OSRM) and refines every ETA to live drive times.

  The matcher is a greedy nearest-in-time chaining heuristic: it walks open
  calls earliest-first, assigns the lowest-cost feasible driver (deadhead miles,
  lateness, vehicle fit), then advances that driver to the drop-off so the next
  call chains on. Distances work fully offline from the Address Book; live road
  routes/tiles draw when online. Tunable **road factor**, **average speed**, and
  a 12-hour planning horizon.
- **Manual "set driver location"** — in **Driver IQ → Driver status & location**,
  place any driver at an address or area by hand. Useful for a driver with no
  recent trip, or one who has repositioned. The pin feeds the whole system
  (Driver IQ ranking, staging and the Optimizer map/chaining), and a fresh
  drop-off automatically supersedes it, so it stays self-correcting.
- **One-click "★ Best" driver assignment** on every active-board row — assigns
  the highest-ranked available driver using the existing Driver IQ engine
  (caller regulars, route familiarity, zone, vehicle fit and distance), and
  tells you *why* it picked them.
- **Global search hotkey** — `Ctrl-K` / `⌘K` focuses the search box from any tab.
- **Resilient map loading** — if the primary CDN is unreachable, Leaflet falls
  back to a second CDN, and the map re-initializes automatically; when fully
  offline the Dispatch trip preview still shows an offline route diagram.
- **Bug fix** — restored a dropped statement in `geoBookLookup` that made
  location-based fare lookups throw (`bd is not defined`); this path is used by
  fare suggestion and Driver IQ ranking.

## Notes

- Street map tiles and live geocoding need internet; everything else (booking,
  the board, fares, accounts, playbooks, exports) works fully offline.
- NYC TLC / MTA rate constants live in the `RATES` object inside the pricing
  engine — edit that block when the authority revises rates.
