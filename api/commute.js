// @ts-check
// GET /api/commute?from=BON&to=MCO&depart=07:22&arrive=07:45
// LIVE data only. This file never imports fixtures; simulated data is /api/demo.
import { checkCommute } from "../lib/commute.js";
import { liveClients, missingConfig } from "../lib/live-clients.js";
import { parseJourney, json, STATIONS } from "../lib/request.js";

export default {
  /** @param {Request} request */
  async fetch(request) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const parsed = parseJourney(new URL(request.url).searchParams);
    if (!parsed.ok) return json({ error: parsed.error }, 400);

    // Say so plainly rather than returning "couldn't be loaded" for every API.
    const missing = missingConfig();
    if (missing.length) {
      console.error(`Missing environment variables: ${missing.join(", ")}`);
      return json({ error: `This server isn't configured: missing ${missing.join(", ")}. See the README section "Running it locally".` }, 503);
    }

    try {
      const clients = liveClients();
      const result = await checkCommute({
        ...parsed.value,
        now: new Date(),
        stations: STATIONS,
        clients,
        source: "live",
      });
      // 60s at the CDN: fresh enough for live trains, and repeat requests for
      // the same journey don't reach Darwin or the Met Office at all.
      return json(result, 200, {
        "cache-control": "public, max-age=0",
        "vercel-cdn-cache-control": "max-age=60",
        // e.g. "runtime-cache; BON=hit; MCO=miss", so caching can be verified per request
        "x-forecast-cache": [clients.stats.backend, ...Object.entries(clients.stats.forecast).map(([k, v]) => `${k}=${v}`)].join("; "),
      });
    } catch (err) {
      console.error("commute failed", err);
      return json({ error: "Something went wrong checking this journey." }, 500);
    }
  },
};
