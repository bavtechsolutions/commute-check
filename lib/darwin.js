// @ts-check
// Darwin Live Departure Board (public) via Rail Data Marketplace.
// Fetches a board and normalises the parts we use into our own shape;
// nothing outside this file touches raw Darwin fields.
import { boardTimeToDate } from "./time.js";

/**
 * @typedef {{ kind: "on_time" | "expected" | "delayed" | "cancelled" | "no_report" | "unknown",
 *             time: Date | null, uncertain: boolean, raw: string | null }} Estimate
 *
 * @typedef {{ scheduled: Date, estimate: Estimate, cancelled: boolean }} Stop
 *
 * @typedef {{ scheduledDeparture: Date, departure: Estimate, platform: string | null,
 *             operator: string, mode: "train" | "bus", cancelled: boolean, cancelledAtDestination: boolean,
 *             delayReason: string | null, cancelReason: string | null,
 *             destinationName: string, arrival: Stop | null }} Service
 *
 * @typedef {{ generatedAt: Date, stationName: string, services: Service[],
 *             messages: string[] }} Board
 */

export class DarwinError extends Error {
  /**
   * @param {"auth" | "bad_request" | "rate_limited" | "unavailable"} kind
   * @param {number} status
   * @param {string} message
   */
  constructor(kind, status, message) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/**
 * @param {{ from: string, to: string, apiKey: string, baseUrl: string, fetch?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<any>} raw board JSON
 */
export async function fetchBoard({ from, to, apiKey, baseUrl, fetch = globalThis.fetch, timeoutMs = 8000 }) {
  // The Specification tab shows the URL with an operation already appended.
  const root = baseUrl.replace(/\/Get\w+\/\{crs\}\/?$/, "").replace(/\/$/, "");
  const url = new URL(`${root}/GetDepBoardWithDetails/${from}`);
  url.search = new URLSearchParams({ numRows: "10", timeWindow: "119", filterCrs: to, filterType: "to" }).toString();

  // The timeout covers headers and body, so a hung upstream can't hang us.
  let res, text;
  try {
    res = await fetch(url, { headers: { "x-apikey": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (err) {
    const e = /** @type {Error} */ (err);
    throw new DarwinError("unavailable", 0, `Darwin request failed: ${e.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : e.message}`);
  }
  if (res.ok) {
    try {
      return JSON.parse(text);
    } catch {
      throw new DarwinError("unavailable", res.status, "Darwin returned a response that isn't JSON");
    }
  }

  // Two error shapes: the API gateway ({fault:{faultstring}}) for auth and
  // limits, and the Darwin backend ({Message}) for bad input.
  let message = text.slice(0, 200);
  try {
    const body = JSON.parse(text);
    message = body?.fault?.faultstring ?? body?.Message ?? message;
  } catch {}
  const kind = res.status === 401 || res.status === 403 ? "auth"
    : res.status === 429 ? "rate_limited"
    : res.status === 400 ? "bad_request"
    : "unavailable";
  throw new DarwinError(kind, res.status, `Darwin ${res.status}: ${message}`);
}

/**
 * Darwin estimates are times or words, sometimes with a trailing "*"
 * meaning "uncertain". The documented list of words is not exhaustive,
 * so anything unrecognised becomes "unknown" rather than an error.
 * @param {string | undefined} raw
 * @param {Date} reference
 * @returns {Estimate}
 */
export function parseEstimate(raw, reference) {
  if (raw == null || raw === "") return { kind: "unknown", time: null, uncertain: false, raw: raw ?? null };
  const uncertain = raw.endsWith("*");
  const value = raw.replace(/\*$/, "").trim();
  const time = boardTimeToDate(value, reference);
  if (time) return { kind: "expected", time, uncertain, raw };
  /** @type {Record<string, Estimate["kind"]>} */
  const words = { "on time": "on_time", delayed: "delayed", cancelled: "cancelled", "no report": "no_report" };
  return { kind: words[value.toLowerCase()] ?? "unknown", time: null, uncertain, raw };
}

/**
 * Strip the HTML Darwin puts in station messages.
 * @param {string} html
 */
export function stripHtml(html) {
  return html
    .replace(/<\/?p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {any} raw board JSON from fetchBoard
 * @param {string} to destination CRS
 * @returns {Board}
 */
export function normaliseBoard(raw, to) {
  const generatedAt = new Date(raw.generatedAt);
  if (Number.isNaN(generatedAt.getTime())) throw new DarwinError("unavailable", 200, "Darwin board has no valid generatedAt");

  /** @type {Service[]} */
  const services = [];
  for (const [mode, list] of /** @type {const} */ ([["train", raw.trainServices], ["bus", raw.busServices]])) {
    for (const s of list ?? []) {
      const scheduledDeparture = boardTimeToDate(s.std, generatedAt);
      if (!scheduledDeparture) continue; // no std: doesn't pick up here
      // A service can have several calling-point lists (splits/joins).
      const calls = (s.subsequentCallingPoints ?? []).flatMap((/** @type {any} */ l) => l.callingPoint ?? []);
      const stop = calls.find((/** @type {any} */ c) => c.crs === to);
      const arrivalScheduled = stop ? boardTimeToDate(stop.st, scheduledDeparture) : null;
      services.push({
        scheduledDeparture,
        departure: parseEstimate(s.etd, scheduledDeparture),
        platform: s.platform ?? null,
        operator: s.operator ?? "Unknown operator",
        mode,
        // Whole service cancelled vs runs but not to our destination (e.g. terminates short).
        cancelled: Boolean(s.isCancelled),
        cancelledAtDestination: Boolean(s.filterLocationCancelled) || Boolean(stop?.isCancelled),
        delayReason: s.delayReason ?? null,
        cancelReason: s.cancelReason ?? null,
        destinationName: (s.destination ?? []).map((/** @type {any} */ d) => d.locationName).join(" / ") || "Unknown",
        arrival: stop && arrivalScheduled
          ? { scheduled: arrivalScheduled, estimate: parseEstimate(stop.et ?? stop.at, arrivalScheduled), cancelled: Boolean(stop.isCancelled) }
          : null,
      });
    }
  }
  services.sort((a, b) => a.scheduledDeparture.getTime() - b.scheduledDeparture.getTime());

  return {
    generatedAt,
    stationName: raw.locationName ?? "",
    services,
    // Station-wide messages; NOT necessarily about this route.
    messages: (raw.nrccMessages ?? []).map((/** @type {any} */ m) => stripHtml(m.Value ?? m.value ?? "")).filter(Boolean),
  };
}

/**
 * Find "my usual train": the service scheduled at exactly the saved
 * departure. Matched on scheduled time, never board position, because
 * late-running earlier trains stay on the board.
 * @param {Board} board
 * @param {Date} departure
 */
export function findService(board, departure) {
  return board.services.find((s) => s.scheduledDeparture.getTime() === departure.getTime()) ?? null;
}
