# Commute Check

Save your usual train and get a heads-up about it: live running information from
**National Rail (Darwin)** plus the **Met Office** forecast where you leave and where you
arrive.

Built for a technical challenge about connecting two APIs that were never designed to work
together. The interesting part is the seam between them, so most of this README is about
that.

- **Live demo:** https://commute-check-wine.vercel.app/
- **Test scenarios (simulated data):** https://commute-check-wine.vercel.app/scenarios.html

## What it does

You save a journey (origin, destination, usual departure and arrival times). When you check it:

- **More than ~2 hours before departure** ("planning" mode): the forecast at your origin at
  departure time and at your destination at arrival time, based on **the times you saved**,
  plus when live train information will become available. Darwin can't see that far ahead, so
  the app doesn't pretend it can.
- **Within ~2 hours** ("live" mode): your actual train from Darwin (on time / late /
  delayed / cancelled / doesn't reach your station / replacement bus / not on the board),
  with the forecast looked up at the **live** expected times.

Every time on the page says where it came from: *your saved time*, *timetable* or *live
estimate*. Weather heads-ups ("Rain likely", "Strong gusts") are this app's own thresholds,
not Met Office warnings. The app doesn't predict delays from weather. It shows both side
by side.

## How the two APIs fit together

| | Darwin LDB (public), via Rail Data Marketplace | Met Office Weather DataHub, Global Spot hourly |
|---|---|---|
| Identifies places by | 3-letter CRS code (`BON`, `MCO`) | latitude / longitude, snapped to the nearest forecast point |
| Time format | local `HH:MM`, **no date**, mixed with words (`"On time"`, `"Delayed"`, `"07:31*"`) | UTC ISO timestamps (`2026-11-13T20:00Z`) |
| Horizon | ~2 hours ahead | 48 hours ahead, hourly |
| Shape | JSON converted mechanically from SOAP (`Value`, `filtercrs`, leftover `Xmlns`) | GeoJSON FeatureCollection |
| Auth | `x-apikey` header | `apikey` header |
| Errors | two shapes: gateway `{"fault":{...}}` and backend `{"Message":...}` | gateway `{"code":"900901",...}`; `429` when the daily limit is hit |
| Limits | fair use | 360 calls/day on the free plan, reset 00:00 UTC |

The adapter (`lib/commute.js`) bridges them:

1. **Location.** Darwin gives CRS codes, the Met Office needs coordinates. `public/stations.json`
   maps CRS → lat/lon, built once from DfT's NaPTAN data (`scripts/build-stations.mjs`). NaPTAN's
   CSV export has no CRS codes, so it's built from the XML export. The forecast point can be
   ~1 km from the station, and the page shows which point it is.
2. **Time.** A saved "07:22" becomes the next UK-local occurrence (BST/GMT solved with `Intl`,
   not hard-coded dates). Darwin's dateless times are resolved against the board's
   `generatedAt`, which handles boards that cross midnight.
3. **Which forecast hour.** Instantaneous values (weather type, rain chance, gusts) come from
   the nearest hour. Accumulations like `totalPrecipAmount` cover the *previous* hour, so the
   rain for a 07:22 departure comes from the **08:00** entry (07:00–08:00).
4. **Which train is "mine".** Matched by scheduled departure time, never by position on the
   board: late trains from earlier stay on the board, and `serviceID` is specific to the
   day. If there's no exact match, the app says so rather than picking the nearest train.
5. **Arrival.** The destination arrival comes from the train's calling points. The night
   before, it's your saved time, clearly labelled. If the timetable disagrees with what you
   saved, the app tells you.
6. **Station messages.** Darwin's `nrccMessages` are station-wide (a Stockport board carried
   a message about Exeter), so they're shown as "may not be about your route", with HTML
   removed.
7. **Failures are independent.** If Darwin is down you still get the weather. If the Met
   Office limit is reached you still get the train.

`docs/api-findings.md` records what real responses showed compared with the documentation.

## Running it locally

Requires **Node.js 24+**. No framework and no build step. The only runtime dependency is
`@vercel/functions` (Runtime Cache).

```bash
npm ci
cp .env.example .env.local   # Windows: copy .env.example .env.local, then fill in the three values
npm run dev                  # http://localhost:3000
```

Without keys, the scenarios page still works fully, and the live check returns a clear
`503` naming the missing settings.

Keys (both free):

- **Rail Data Marketplace** (raildata.org.uk): subscribe to **Live Departure Board**. From the
  product's Specification tab, copy the **Consumer Key** (`RDM_LDB_API_KEY`) and the URL
  (`RDM_LDB_BASE_URL`, pasted as shown, including `/GetDepartureBoard/{crs}` if present).
  Approval can take up to 3 working days.
- **Met Office Weather DataHub** (datahub.metoffice.gov.uk): **Site Specific → Global Spot**,
  free plan (`METOFFICE_API_KEY`). Not the old DataPoint API, which was retired in 2025.

The scenarios page (`/scenarios.html`) needs no keys.

To see each raw API response for yourself:

```bash
npm run probe:metoffice              # 1 call from the 360/day allowance
npm run probe:darwin -- BON MCO
```

Raw responses are saved to `probe-output/` (git-ignored).

## Tests

```bash
npm test          # 51 tests, Node's built-in runner
npm run typecheck # strict TypeScript check of the JSDoc-typed JavaScript (no build step)
```

The tests cover:

- **Time:** BST/GMT both ways, the night before a clock change, midnight boards, `*` suffix.
- **Darwin:** parsing a **real captured board**, plus edge cases built by modifying it:
  cancelled, terminates short, "Delayed" with no time, replacement bus, both error shapes,
  timeouts, a 200 that isn't JSON.
- **Met Office:** forecast-hour alignment, unit conversion, heads-up thresholds, 429 → quota,
  timeouts. Uses a **synthetic** forecast (see Licensing).
- **Adapter:** night-before vs live, not on the board, already departed, each API failing on
  its own, journeys over midnight.
- **Endpoints:** input validation, missing configuration (names reported, never values), and a
  check that the live path never imports simulated data.

## Security and API handling

- **Keys are server-side only:** environment variables, sent as request headers (never in
  URLs), never logged or returned. A test checks the Met Office key isn't in the URL.
- **Input is validated** against the station list and `HH:MM` before any upstream call, so the
  endpoint can't be used as an open relay to either API.
- **Upstream calls time out after 8 s**, covering the body as well as the headers. Upstream
  error text is logged server-side, and only an error *kind* reaches the browser.
- **All rendered values are HTML-escaped.** Darwin's station messages have their HTML removed.
- **Headers:** `nosniff`, `Referrer-Policy`, `frame-ancestors 'none'`, `Permissions-Policy`.
- **No real Met Office data in responses or the repo** (see Licensing).
- `npm audit`: 0 vulnerabilities. The only runtime dependency is `@vercel/functions`.

## Live vs simulated data

- `GET /api/commute?from=BON&to=MCO&depart=07:22&arrive=07:45` is **live only**.
- `GET /api/demo?scenario=cancelled` is **simulated**: the same `checkCommute()` with fake API
  clients and a fixed clock. Responses carry `"source": "simulated"`, and the page shows a banner.

Scenarios: night before, running late (the real board, unmodified), cancelled, terminates
short, delayed with no estimate, replacement bus, train not on the board, storm on arrival,
Met Office limit reached, Darwin unavailable.

## Caching and rate limits

- **Met Office:** the reduced forecast is kept in **Vercel Runtime Cache** for 30 minutes per
  station (forecasts update hourly). Functions are pinned to one region (`lhr1`), so the cache
  is shared.
- **Whole response:** cached at Vercel's CDN for 60 s, so repeat checks of the same journey
  don't call either API.
- **You can check it per request.** `/api/commute` responses carry
  `x-forecast-cache: runtime-cache; BON=hit; MCO=hit` (which cache backend was used, and
  hit/miss per station) alongside Vercel's `x-vercel-cache`. `getCache()` silently falls back
  to a per-instance in-memory cache when Runtime Cache isn't available, so the header reports
  which one actually ran. On production, forecasts were still hits after two redeploys.
- **These caches save calls but don't guarantee anything.** Vercel describes both as regional
  and best-effort, and entries can be evicted early. So there's no "daily budget counter":
  without an atomic store it would look like protection without working reliably. Running out
  of quota costs nothing on the free plan (just a 429 until midnight UTC), so the real
  protection is handling that case cleanly.
- **Inputs are validated** against the station list and `HH:MM` before any API is called.
  (Darwin rejects lowercase CRS codes, but silently accepts out-of-range parameters.)

## Limitations

- **Not checked:** planned engineering works, Met Office weather warnings, and disruption that
  hasn't reached your train yet. The page lists these.
- **The night before, nothing is known about the train itself.** Not even whether your saved
  train still runs (e.g. after the December timetable change). Only the forecast is real.
- **One saved journey per browser** (`localStorage`). No accounts, no notifications.
- **Weather is a forecast for the nearest Met Office point**, not the platform.
- **Heads-up thresholds are ours** (e.g. ≥50% rain chance, gusts ≥40 mph). They're
  reasonable, not validated.
- **Not seen live yet:** a real cancellation, `"Delayed"` without a time, a `*` uncertain time,
  or a bus replacement. These are handled from the documentation and synthetic tests, and
  need checking against real data.
- **BST:** whether Darwin's `generatedAt` carries `+01:00` in summer isn't confirmed yet. The
  code reads the offset rather than assuming one.

### Not verifiable, so not claimed

- **Met Office call counts.** The DataHub account shows the plan (360 calls/day) but no usage
  figures. That Runtime Cache saves calls is verified from our side only, through the
  `x-forecast-cache` header.
- **What the Met Office returns at the daily limit.** The DataHub FAQ says `429`. We haven't
  used up the allowance to confirm it, and the handling is tested with a simulated 429.
- **Darwin's fair-use limit** for this product isn't published on a page we could access.

## What I'd harden for production

- An atomic quota store (e.g. Redis `INCR` with expiry) and Vercel Firewall rate limiting
  before the Met Office limit is shared by real users, or a paid Met Office plan.
- Notifications: a scheduled job calling the same `checkCommute()` the night before and
  ~90 minutes before departure, alerting only when something changes.
- The National Rail Knowledgebase incidents feed for planned engineering works, and the Met
  Office warnings feed. Both would need route matching.
- Investigate Darwin's `rsid` as a more stable train identifier than scheduled time.
- Monitoring on both upstream error rates, and alerts on schema changes (Darwin's JSON is a
  mechanical conversion of SOAP and could change shape).
- A full Content Security Policy (move the pages' inline module scripts into files first),
  and one retry with backoff for upstream `5xx` errors and timeouts.

## Project structure

```
api/commute.js        live endpoint (Vercel Function)
api/demo.js           simulated scenarios endpoint
lib/commute.js        the adapter: combines journey, Darwin and Met Office
lib/darwin.js         Darwin client + normaliser
lib/metoffice.js      Met Office client + summary + forecast-hour alignment
lib/time.js           UK time handling
lib/live-clients.js   real clients: env keys, Runtime Cache
lib/request.js        input validation, JSON responses
demo/scenarios.js     simulated scenarios
fixtures/             real Darwin boards + synthetic forecast generator
public/               page, scenarios page, stations.json
scripts/              dev server, API probes, stations build
test/                 node:test suites
docs/api-findings.md  what real responses showed compared with the docs
```

## Licensing and attribution

- **Met Office:** "Powered by Met Office data". Under the Weather DataHub terms (clause 3.2.2)
  the data may not be redistributed "in original form", so the API returns only a derived
  summary, and **no real Met Office responses are committed**. Test weather is synthetic.
- **National Rail Enquiries:** train data from Darwin, attributed in the page footer.
  `fixtures/` contains two boards captured on 13 Nov 2026.
- **NaPTAN** (DfT), Open Government Licence v3.
