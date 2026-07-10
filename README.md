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
