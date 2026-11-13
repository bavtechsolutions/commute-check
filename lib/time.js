// @ts-check
// UK local time handling. Darwin speaks local "HH:MM" with no date; the
// Met Office speaks UTC ISO timestamps. Everything internal is a UTC Date.

const ZONE = "Europe/London";
const MINUTE = 60_000;

/** Darwin only returns services up to (just under) 120 minutes ahead. */
export const LIVE_WINDOW_MINUTES = 119;

/** A saved departure still counts as "this one" for a while after its scheduled time, because late trains stay on the board. */
export const LATE_GRACE_MINUTES = 30;

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * @param {string} s
 * @returns {{ hour: number, minute: number } | null}
 */
export function parseHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/**
 * Wall-clock parts of a UTC instant in UK local time.
 * @param {Date} date
 */
export function londonParts(date) {
  /** @type {Record<string, number>} */
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    if (type !== "literal") p[type] = Number(value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute };
}

/**
 * UK local wall-clock time to a UTC instant. Solves for the offset rather
 * than hard-coding BST dates. A time that doesn't exist (inside the spring-
 * forward gap) resolves to the instant one hour later on the clock.
 * @param {number} year @param {number} month 1-12 @param {number} day
 * @param {number} hour @param {number} minute
 */
export function londonToUtc(year, month, day, hour, minute) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = londonParts(new Date(guess));
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wanted - seen;
  }
  return new Date(guess);
}

/**
 * The next time the clock in the UK reads `hhmm`, counting a departure as
 * still current for LATE_GRACE_MINUTES after it was due.
 * @param {string} hhmm
 * @param {Date} now
 */
export function nextOccurrence(hhmm, now) {
  const t = parseHHMM(hhmm);
  if (!t) throw new RangeError(`Invalid time "${hhmm}" (expected HH:MM)`);
  const today = londonParts(now);
  const base = new Date(Date.UTC(today.year, today.month - 1, today.day));
  for (let addDays = 0; addDays < 3; addDays++) {
    const d = new Date(base.getTime() + addDays * 86_400_000);
    const at = londonToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), t.hour, t.minute);
    if (at.getTime() + LATE_GRACE_MINUTES * MINUTE > now.getTime()) return at;
  }
  throw new Error("unreachable");
}

/**
 * Resolve a Darwin "HH:MM" to a full instant: the occurrence closest to
 * `reference` (within 12 hours), which handles boards that cross midnight.
 * Returns null for anything that isn't a clock time ("On time", "Delayed").
 * @param {string | undefined} hhmm
 * @param {Date} reference
 */
export function boardTimeToDate(hhmm, reference) {
  const t = hhmm ? parseHHMM(hhmm.replace(/\*$/, "")) : null;
  if (!t) return null;
  const ref = londonParts(reference);
  let best = null;
  for (const dayShift of [-1, 0, 1]) {
    const d = new Date(Date.UTC(ref.year, ref.month - 1, ref.day + dayShift));
    const at = londonToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), t.hour, t.minute);
    if (!best || Math.abs(at.getTime() - reference.getTime()) < Math.abs(best.getTime() - reference.getTime())) best = at;
  }
  return best;
}

/**
 * When Darwin will first include a departure.
 * @param {Date} departure
 */
export function liveDataFrom(departure) {
  return new Date(departure.getTime() - LIVE_WINDOW_MINUTES * MINUTE);
}

/**
 * "HH:MM" in UK local time, for display.
 * @param {Date} date
 */
export function formatLondon(date) {
  const p = londonParts(date);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** @param {Date} a @param {Date} b */
export function minutesBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / MINUTE);
}
