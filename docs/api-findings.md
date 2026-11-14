# API findings from real requests

Probed 2026-11-13 (~20:52 UTC) with `scripts/probe-*.mjs`. Everything below was observed
in real responses unless it is marked **unverified**.

## Met Office Weather DataHub: Global Spot hourly

- `GET https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/hourly?latitude=&longitude=&includeLocationName=true&excludeParameterMetadata=false`
- Auth: `apikey` header (confirmed). Errors come from the API gateway: `401 {"code":"900902","message":"Missing Credentials"}` and `401 {"code":"900901","message":"Invalid Credentials"}`.
- GeoJSON `FeatureCollection`, one feature. `properties.timeSeries` had 49 hourly entries running from the model-run hour (20:00Z) to +48h.
- **The location is snapped to a forecast point.** We asked for 53.4774,-2.2309 (Piccadilly) and got a point named "Manchester" at 53.479,-2.2465, with `requestPointDistance: 1047.7` (metres). Geometry is `[lon, lat, altitude]`.
- **Times are UTC**, written as `"2026-11-13T20:00Z"` (no seconds). `modelRunDate` is in the same format.
- **Accumulations cover the previous hour.** `totalPrecipAmount` is "Total Precipitation Amount Over Previous Hour", and the same goes for snow, max/min temperature and max gust. `precipitationRate` and `probOfPrecipitation` are values at that time.
- Units come in the `parameters` metadata: wind in **m/s** (not mph), pressure in Pa, visibility in m.
- `significantWeatherCode` is an integer. **Unverified:** the code→description table (we need the official list before mapping it).
- No rate-limit headers. `cache-control: no-cache, no-store`, so any caching is up to us. **Unverified:** what happens when the 360/day quota runs out (probably 429). Resets 00:00 UTC.

## Darwin LDB Webservice (public) via Rail Data Marketplace

- `GET https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/{operation}/{CRS}`
  - The Specification tab shows the URL with `/GetDepartureBoard/{crs}` already appended. `GetDepBoardWithDetails` works with the same key.
- Auth: `x-apikey` header (confirmed).
- **Two different error shapes:**
  - Gateway: `401 {"fault":{"faultstring":"Invalid ApiKey","detail":{"errorcode":"oauth.v2.InvalidApiKey"}}}`
  - Backend: `400 {"Message":"Invalid crs code supplied"}`
- **CRS is case-sensitive.** `spt` gives a 400, so we uppercase it ourselves.
- **Out-of-range parameters are accepted without complaint.** `timeWindow=200` (documented as <120) returned 200 OK. We validate inputs ourselves rather than relying on the API.
- The JSON is a mechanical conversion of the SOAP schema: `nrccMessages[].Value` (capital V), `filtercrs` (lowercase c), and a leftover `"Xmlns": {"Count": 8}`.
- `generatedAt` is a full ISO timestamp with an offset (`+00:00`). **Unverified:** whether it shows `+01:00` during BST.
- `std` / `etd` / `st` / `et` are local `HH:MM` strings with **no date**. `etd`/`et` mix times (`"20:55"`) with words (`"On time"`).
- **Trains that are already late stay on the board.** At 20:52, the 20:19 CrossCountry train (etd 20:55) was still listed. Matching "my 07:42" has to use `std`, not position on the board.
- `serviceID` looks like `10662002STKP____`, so it's specific to that day and station. It's no use as a saved identifier.
- `filterCrs=MAN&filterType=to` included a Liverpool Lime Street train because it calls at MAN. The arrival estimate at the destination is in `subsequentCallingPoints[0].callingPoint[] (crs === "MAN").et`.
- **`nrccMessages` aren't specific to the route.** The Stockport board carried a message about Exeter St Davids. The messages contain HTML (`&nbsp;`, `<a href>`).
- Delays come with free-text `delayReason` / `cancelReason`.
- No rate-limit headers (`cache-control: public,no-cache`). **Unverified:** the fair-use limit on the RDM product page.
- No station coordinates in the response, confirmed. We still need the NaPTAN lookup.
- **Not yet seen:** a cancelled service (`isCancelled: true`, `etd: "Cancelled"`), `"Delayed"` with no time, a bus replacement, or a `*` suffix. We need to see these before trusting the parser.

## After deployment (2026-11-14, Vercel, region lhr1)

- **Runtime Cache works on Vercel.** Seen via our `x-forecast-cache` header: `runtime-cache`
  (not the in-memory fallback `getCache()` silently uses when Runtime Cache is unavailable),
  and forecasts were still hits after two redeploys, as Vercel's docs describe.
- **The DataHub account shows no usage figures**, only the plan (360/day). So the effect on
  the Met Office quota can't be confirmed from their side.
- **CDN cache:** identical requests go `MISS` then `HIT`. Different query strings are separate
  cache entries.
- **Live check on production** found a display bug the tests didn't catch: the departure was
  labelled "live estimate" but still showed the saved time. Fixed, and the test now checks both.
- **`commute-check.vercel.app` is an unrelated site.** Ours got `commute-check-wine.vercel.app`.
- **Node version:** Vercel maps open ranges like `>=24` to its newest major (26.x), so `engines`
  is pinned to `24.x`, the version the tests run on.
