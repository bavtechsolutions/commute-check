// @ts-check
// Real API clients for /api/commute. Keys come from the environment and
// never leave the server. Only the live endpoint imports this file.
import { getCache } from "@vercel/functions";
import { fetchBoard } from "./darwin.js";
import { fetchForecast, summariseForecast, reviveForecast } from "./metoffice.js";

// Spot forecasts update hourly (DataHub FAQ). 30 min keeps us at most half
// an hour behind while bounding calls to ~48/day per station in normal use.
// Runtime Cache is regional and best-effort: this saves calls, it is not a
// guarantee against the 360/day limit. A 429 is handled where it's used.
const FORECAST_TTL_SECONDS = 30 * 60;

const REQUIRED_ENV = ["METOFFICE_API_KEY", "RDM_LDB_API_KEY", "RDM_LDB_BASE_URL"];

/** Names (never values) of required settings that aren't set. */
export function missingConfig() {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
}

/** @param {string} name */
function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/**
 * Which cache getCache() will actually use. It silently falls back to a
 * per-instance in-memory cache when Vercel's Runtime Cache isn't available,
 * so we report it rather than assume. Mirrors the library's own check
 * (request-context symbol, then env vars); diagnostic only.
 */
function cacheBackend() {
  const ctx = /** @type {any} */ (globalThis)[Symbol.for("@vercel/request-context")]?.get?.();
  if (ctx?.cache || (process.env.RUNTIME_CACHE_ENDPOINT && process.env.RUNTIME_CACHE_HEADERS)) return "runtime-cache";
  return "in-memory";
}

/** @returns {import("./commute.js").Clients & { stats: { backend: string, forecast: Record<string, "hit" | "miss"> } }} */
export function liveClients() {
  const cache = getCache({ namespace: "commute-check" });
  const stats = { backend: cacheBackend(), forecast: /** @type {Record<string, "hit" | "miss">} */ ({}) };
  return {
    stats,
    getBoard: (from, to) => fetchBoard({ from, to, apiKey: env("RDM_LDB_API_KEY"), baseUrl: env("RDM_LDB_BASE_URL") }),

    async getForecast(crs, station) {
      const key = `metoffice:hourly:v1:${crs}`;
      const hit = await cache.get(key);
      stats.forecast[crs] = hit ? "hit" : "miss";
      if (hit) return reviveForecast(hit);
      const forecast = summariseForecast(await fetchForecast({ lat: station.lat, lon: station.lon, apiKey: env("METOFFICE_API_KEY") }));
      await cache.set(key, forecast, { ttl: FORECAST_TTL_SECONDS, tags: ["metoffice"] });
      return forecast;
    },
  };
}
