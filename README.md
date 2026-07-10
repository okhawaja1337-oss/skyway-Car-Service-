# Skyway Dispatch Console

A single-file, offline-capable dispatch console for a NYC-area car / livery service.
Everything runs in the browser — no server, no build step, no install. Open
`index.html` and it works. All data (trips, drivers, vehicles, accounts, address
book, pricing, call history) is stored locally in the browser via
`localStorage` / IndexedDB, so it survives refreshes and works with no internet.

## Running it

Just open the file:

```
# double-click index.html, or serve it locally:
python3 -m http.server 8080
# then visit http://localhost:8080/index.html
```

Works in any modern browser (Chrome, Edge, Firefox, Safari). No accounts, no
backend. To move a station to a new machine, use **Settings → Export / Backup**
and import the file on the other machine.

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

- **Fleet Optimizer (new tab)** — maps where every driver is (or will be after
  their current drop-off) and chains each open call to the driver who reaches it
  with the fewest empty "deadhead" miles, so pickups come faster and cars stay
  in motion. It shows:
  - a **live fleet map** (Leaflet online, offline scatter map otherwise) with
    idle vs on-trip drivers, open pickups, and each assignment's deadhead + live
    legs — plus optional live street routing;
  - **ranked assignments** — the best driver for each open call, its empty-mile
    cost and pickup ETA, with one-click *Assign* or *Apply all*;
  - **driver chains** — each driver's next back-to-back runs with total empty
    miles and a "% loaded" utilization figure.

  The matcher is a greedy nearest-in-time chaining heuristic: it walks open
  calls earliest-first, assigns the lowest-cost feasible driver (deadhead miles,
  lateness, vehicle fit), then advances that driver to the drop-off so the next
  call chains on. Distances work fully offline from the Address Book; live road
  routes/tiles draw when online. Tunable **road factor**, **average speed**, and
  a 12-hour planning horizon.
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
