// @ts-check
// The adapter: combines a saved journey, Darwin and the Met Office into one
// answer, and says where every time came from. API clients and the clock are
// passed in, so live and simulated runs use exactly the same logic.
import { normaliseBoard, findService, DarwinError } from "./darwin.js";
import { conditionsAt, MetOfficeError } from "./metoffice.js";
import { nextOccurrence, parseHHMM, liveDataFrom, formatLondon, minutesBetween, londonParts, londonToUtc, LIVE_WINDOW_MINUTES } from "./time.js";

/**
 * @typedef {import("./metoffice.js").Forecast} Forecast
 * @typedef {import("./darwin.js").Service} Service
 * @typedef {import("./darwin.js").Estimate} Estimate
 * @typedef {{ name: string, lat: number, lon: number }} Station
 *
 * @typedef {{
 *   getBoard: (from: string, to: string) => Promise<any>,
 *   getForecast: (crs: string, station: Station) => Promise<Forecast>,
 * }} Clients
 */

export const NOT_CHECKED = [
  "Planned engineering works and timetable changes",
  "Met Office weather warnings",
  "Disruption elsewhere on the route that hasn't affected this train yet",
];

/**
 * @param {{ from: string, to: string, depart: string, arrive: string, now: Date,
 *           stations: Record<string, Station>, clients: Clients, source: "live" | "simulated" }} input
 */
export async function checkCommute({ from, to, depart, arrive, now, stations, clients, source }) {
  const origin = stations[from];
  const destination = stations[to];
  const departure = nextOccurrence(depart, now);
  const savedArrival = arrivalAfter(departure, arrive);
  const isLive = minutesBetween(now, departure) <= LIVE_WINDOW_MINUTES;

  /** @type {any} */
  const result = {
    source,
    checkedAt: now.toISOString(),
    journey: {
      from: { crs: from, name: origin.name },
      to: { crs: to, name: destination.name },
      departure: { time: departure.toISOString(), local: depart, basis: "saved" },
      arrival: { time: savedArrival.toISOString(), local: arrive, basis: "saved" },
    },
    mode: isLive ? "live" : "planning",
    train: null,
    liveAvailableFrom: isLive ? null : { time: liveDataFrom(departure).toISOString(), local: formatLondon(liveDataFrom(departure)) },
    networkMessages: [],
    notes: [],
    weather: null,
    notChecked: NOT_CHECKED,
  };

  // Times the weather is looked up for: saved times unless Darwin knows better.
  let departAt = departure;
  let arriveAt = savedArrival;

  if (isLive) {
    const live = await liveTrain(clients, from, to, departure, result);
    if (live?.service) {
      const s = live.service;
      result.train = describeService(s);
      if (s.cancelled || s.cancelledAtDestination) {
        result.notes.push(`This train won't get you to ${destination.name}. The arrival forecast is for the time it was due, as a guide only.`);
      }
      if (s.departure.time) departAt = s.departure.time;
      result.journey.departure = {
        time: departAt.toISOString(),
        local: formatLondon(departAt),
        basis: s.departure.time ? "live estimate" : "timetable",
      };
      if (s.arrival) {
        arriveAt = s.arrival.estimate.time ?? s.arrival.scheduled;
        result.journey.arrival = {
          time: arriveAt.toISOString(),
          local: formatLondon(arriveAt),
          basis: s.arrival.estimate.time ? "live estimate" : "timetable",
        };
        if (s.arrival.scheduled.getTime() !== savedArrival.getTime()) {
          result.notes.push(`The timetable has this train arriving at ${formatLondon(s.arrival.scheduled)}, not the ${arrive} you saved.`);
        }
      }
    }
  }

  result.weather = await weather(clients, { from, origin, departAt }, { to, destination, arriveAt });
  return result;
}

/** @param {Date} departure @param {string} hhmm */
function arrivalAfter(departure, hhmm) {
  const t = parseHHMM(hhmm);
  if (!t) throw new RangeError(`Invalid arrival time "${hhmm}"`);
  // Same UK date as the departure, or the next day if that isn't after it (journeys over midnight).
  const d = londonParts(departure);
  const sameDay = londonToUtc(d.year, d.month, d.day, t.hour, t.minute);
  if (sameDay > departure) return sameDay;
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  return londonToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), t.hour, t.minute);
}

/**
 * @param {Clients} clients @param {string} from @param {string} to @param {Date} departure @param {any} result
 * @returns {Promise<{ service: Service | null } | null>}
 */
async function liveTrain(clients, from, to, departure, result) {
  let board;
  try {
    board = normaliseBoard(await clients.getBoard(from, to), to);
  } catch (err) {
    const kind = err instanceof DarwinError ? err.kind : "unavailable";
    result.train = { status: "unavailable", reason: kind, message: "Live train information couldn't be loaded." };
    return null;
  }
  result.networkMessages = board.messages;
  const service = findService(board, departure);
  if (!service) {
    const others = board.services.slice(0, 4).map((s) => `${formatLondon(s.scheduledDeparture)} to ${s.destinationName}`);
    const departed = departure.getTime() < board.generatedAt.getTime();
    result.train = {
      status: "not_found",
      message: `No ${formatLondon(departure)} from ${board.stationName || from} calling at ${to} is on the live board.` +
        (departed ? " It may already have departed." : ""),
      otherServices: others,
    };
  }
  return { service };
}

/** @param {Service} s */
function describeService(s) {
  const late = s.departure.time ? minutesBetween(s.scheduledDeparture, s.departure.time) : null;
  /** @type {string} */
  let status;
  if (s.cancelled || s.departure.kind === "cancelled") status = "cancelled";
  else if (s.cancelledAtDestination) status = "cancelled_at_destination";
  else if (s.departure.kind === "delayed") status = "delayed";
  else if (late != null && late > 0) status = "late";
  else if (s.departure.kind === "on_time" || late === 0 || (late != null && late < 0)) status = "on_time";
  else status = "unknown";

  return {
    status,
    minutesLate: late != null && late > 0 ? late : null,
    mode: s.mode,
    scheduledDeparture: formatLondon(s.scheduledDeparture),
    expectedDeparture: describeEstimate(s.departure),
    scheduledArrival: s.arrival ? formatLondon(s.arrival.scheduled) : null,
    expectedArrival: s.arrival ? describeEstimate(s.arrival.estimate) : null,
    platform: s.platform,
    operator: s.operator,
    destinationName: s.destinationName,
    reason: s.cancelReason ?? s.delayReason,
  };
}

/** @param {Estimate} e */
function describeEstimate(e) {
  const text = e.time ? formatLondon(e.time)
    : { on_time: "On time", delayed: "Delayed", cancelled: "Cancelled", no_report: "No report", unknown: e.raw ?? "Unknown", expected: "" }[e.kind];
  return e.uncertain ? `${text} (uncertain)` : text;
}

/**
 * @param {Clients} clients
 * @param {{ from: string, origin: Station, departAt: Date }} a
 * @param {{ to: string, destination: Station, arriveAt: Date }} b
 */
async function weather(clients, a, b) {
  /** @param {string} crs @param {Station} station @param {Date} at @param {"departure" | "arrival"} label */
  const one = async (crs, station, at, label) => {
    try {
      const f = await clients.getForecast(crs, station);
      const c = conditionsAt(f, at);
      return {
        label,
        at: at.toISOString(),
        local: formatLondon(at),
        forecastPoint: { name: f.pointName, distanceMetres: f.distanceMetres },
        modelRun: f.modelRun.toISOString(),
        conditions: c,
        message: c ? null : "The forecast doesn't cover this time yet.",
      };
    } catch (err) {
      const quota = err instanceof MetOfficeError && err.kind === "quota";
      return {
        label,
        at: at.toISOString(),
        local: formatLondon(at),
        conditions: null,
        message: quota
          ? "Weather temporarily unavailable: the Met Office daily request limit has been reached (resets at midnight UTC)."
          : "Weather couldn't be loaded.",
      };
    }
  };
  const [departure, arrival] = await Promise.all([
    one(a.from, a.origin, a.departAt, "departure"),
    one(b.to, b.destination, b.arriveAt, "arrival"),
  ]);
  return { departure, arrival };
}
