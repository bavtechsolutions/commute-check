// @ts-check
// Input validation and JSON responses shared by both endpoints. We validate
// everything ourselves: Darwin rejects lowercase CRS codes but silently
// accepts out-of-range parameters, so it can't be relied on to do it.
import stations from "../public/stations.json" with { type: "json" };
import { parseHHMM } from "./time.js";

/** @type {Record<string, { name: string, lat: number, lon: number }>} */
export const STATIONS = stations;

/**
 * @param {URLSearchParams} q
 * @returns {{ ok: true, value: { from: string, to: string, depart: string, arrive: string } } | { ok: false, error: string }}
 */
export function parseJourney(q) {
  const from = (q.get("from") ?? "").trim().toUpperCase();
  const to = (q.get("to") ?? "").trim().toUpperCase();
  const depart = (q.get("depart") ?? "").trim();
  const arrive = (q.get("arrive") ?? "").trim();
  if (!STATIONS[from]) return { ok: false, error: `Unknown origin station code "${from}"` };
  if (!STATIONS[to]) return { ok: false, error: `Unknown destination station code "${to}"` };
  if (from === to) return { ok: false, error: "Origin and destination must be different" };
  if (!parseHHMM(depart)) return { ok: false, error: "depart must be HH:MM (24-hour)" };
  if (!parseHHMM(arrive)) return { ok: false, error: "arrive must be HH:MM (24-hour)" };
  return { ok: true, value: { from, to, depart, arrive } };
}

/** @param {unknown} body @param {number} status @param {Record<string, string>} [headers] */
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
