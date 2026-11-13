// @ts-check
// GET /api/demo              -> list of scenarios
// GET /api/demo?scenario=... -> SIMULATED result, same logic as /api/commute
import { checkCommute } from "../lib/commute.js";
import { json, STATIONS } from "../lib/request.js";
import { SCENARIOS } from "../demo/scenarios.js";

export default {
  /** @param {Request} request */
  async fetch(request) {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const name = new URL(request.url).searchParams.get("scenario");
    const cacheable = { "cache-control": "public, max-age=300" }; // fixed data

    if (!name) {
      return json(
        { scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, title: s.title, description: s.description })) },
        200,
        cacheable,
      );
    }
    const scenario = Object.hasOwn(SCENARIOS, name) ? SCENARIOS[name] : null;
    if (!scenario) return json({ error: `Unknown scenario "${name}"` }, 404);

    const result = await checkCommute({
      ...scenario.journey,
      now: scenario.now,
      stations: STATIONS,
      clients: { getBoard: scenario.getBoard, getForecast: scenario.getForecast },
      source: "simulated",
    });
    return json({ ...result, scenario: { id: name, title: scenario.title, description: scenario.description } }, 200, cacheable);
  },
};
