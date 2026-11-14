// @ts-check
// Met Office Weather DataHub, Site-Specific Global Spot, hourly.
// Licence note (DataHub T&Cs clause 3.2.2): we may not redistribute the data
// "in original form", so the raw GeoJSON never leaves this module. We keep a
// reduced summary (which is also what gets cached) and derive conditions.

const URL_HOURLY = "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/hourly";
const HOUR = 3_600_000;
const MS_TO_MPH = 2.23694;

/**
 * @typedef {{ time: Date, temperatureC: number, feelsLikeC: number, precipRateMmH: number,
 *             precipMmPrevHour: number, snowMmPrevHour: number, precipProbability: number,
 *             gustMs: number, visibilityM: number, weatherCode: number | null }} Hour
 *
 * @typedef {{ pointName: string, distanceMetres: number, modelRun: Date, hours: Hour[] }} Forecast
 *
 * @typedef {{ time: Date, weather: string, temperatureC: number, feelsLikeC: number,
 *             precipProbability: number, precipRateMmH: number, rainMmThatHour: number,
 *             gustMph: number, flags: string[] }} Conditions
 */

export class MetOfficeError extends Error {
  /**
   * @param {"auth" | "quota" | "unavailable"} kind
   * @param {number} status
   * @param {string} message
   */
  constructor(kind, status, message) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** Official table: https://datahub.metoffice.gov.uk/definition-of-codes */
export const WEATHER_CODES = {
  [-1]: "Trace rain", 0: "Clear night", 1: "Sunny day", 2: "Partly cloudy (night)", 3: "Partly cloudy (day)",
  4: "Not used", 5: "Mist", 6: "Fog", 7: "Cloudy", 8: "Overcast",
  9: "Light rain shower (night)", 10: "Light rain shower (day)", 11: "Drizzle", 12: "Light rain",
  13: "Heavy rain shower (night)", 14: "Heavy rain shower (day)", 15: "Heavy rain",
  16: "Sleet shower (night)", 17: "Sleet shower (day)", 18: "Sleet",
  19: "Hail shower (night)", 20: "Hail shower (day)", 21: "Hail",
  22: "Light snow shower (night)", 23: "Light snow shower (day)", 24: "Light snow",
  25: "Heavy snow shower (night)", 26: "Heavy snow shower (day)", 27: "Heavy snow",
  28: "Thunder shower (night)", 29: "Thunder shower (day)", 30: "Thunder",
};

/**
 * @param {{ lat: number, lon: number, apiKey: string, fetch?: typeof fetch }} opts
 * @returns {Promise<any>} raw GeoJSON
 */
export async function fetchForecast({ lat, lon, apiKey, fetch = globalThis.fetch }) {
  const url = new URL(URL_HOURLY);
  url.search = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    includeLocationName: "true",
    excludeParameterMetadata: "true",
  }).toString();

  let res;
  try {
    res = await fetch(url, { headers: { apikey: apiKey, accept: "application/json" } });
  } catch (err) {
    throw new MetOfficeError("unavailable", 0, `Met Office request failed: ${/** @type {Error} */ (err).message}`);
  }
  const text = await res.text();
  if (res.ok) return JSON.parse(text);

  let message = text.slice(0, 200);
  try {
    const body = JSON.parse(text);
    message = [body.message, body.description].filter(Boolean).join(": ") || message;
  } catch {}
  // 429 = daily request limit reached (resets 00:00 UTC, per the DataHub FAQ).
  const kind = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "quota" : "unavailable";
  throw new MetOfficeError(kind, res.status, `Met Office ${res.status}: ${message}`);
}

/**
 * Reduce the GeoJSON to the fields we use. This is also what we cache.
 * @param {any} raw
 * @returns {Forecast}
 */
export function summariseForecast(raw) {
  const feature = raw?.features?.[0];
  const series = feature?.properties?.timeSeries;
  if (!Array.isArray(series) || series.length === 0) {
    throw new MetOfficeError("unavailable", 200, "Met Office response has no timeSeries");
  }
  const num = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  return {
    pointName: feature.properties.location?.name ?? "Forecast point",
    distanceMetres: Math.round(num(feature.properties.requestPointDistance)),
    modelRun: new Date(feature.properties.modelRunDate),
    hours: series.map((h) => ({
      time: new Date(h.time), // e.g. "2026-11-13T20:00Z" (UTC, no seconds)
      temperatureC: num(h.screenTemperature),
      feelsLikeC: num(h.feelsLikeTemperature),
      precipRateMmH: num(h.precipitationRate),
      precipMmPrevHour: num(h.totalPrecipAmount), // accumulation over the PREVIOUS hour
      snowMmPrevHour: num(h.totalSnowAmount),
      precipProbability: num(h.probOfPrecipitation),
      gustMs: num(h.windGustSpeed10m),
      visibilityM: num(h.visibility),
      weatherCode: Number.isInteger(h.significantWeatherCode) ? h.significantWeatherCode : null,
    })),
  };
}

/**
 * Restore Dates after a JSON round-trip (e.g. through Runtime Cache).
 * @param {any} json
 * @returns {Forecast}
 */
export function reviveForecast(json) {
  return {
    ...json,
    modelRun: new Date(json.modelRun),
    hours: json.hours.map((/** @type {any} */ h) => ({ ...h, time: new Date(h.time) })),
  };
}

/**
 * Conditions around an instant. Instantaneous values come from the nearest
 * hour; "over previous hour" accumulations come from the entry at the END of
 * the hour containing the instant (07:22 -> the 08:00 entry covers 07:00-08:00).
 * Returns null if the forecast doesn't cover that time.
 * @param {Forecast} forecast
 * @param {Date} instant
 * @returns {Conditions | null}
 */
export function conditionsAt(forecast, instant) {
  const t = instant.getTime();
  const byTime = new Map(forecast.hours.map((h) => [h.time.getTime(), h]));
  const nearest = byTime.get(Math.round(t / HOUR) * HOUR);
  const accumulation = byTime.get(Math.floor(t / HOUR) * HOUR + HOUR);
  if (!nearest || !accumulation) return null;

  const code = nearest.weatherCode;
  const gustMph = Math.round(nearest.gustMs * MS_TO_MPH);
  return {
    time: nearest.time,
    weather: code == null ? "Not available" : WEATHER_CODES[/** @type {keyof typeof WEATHER_CODES} */ (code)] ?? `Code ${code}`,
    temperatureC: Math.round(nearest.temperatureC),
    feelsLikeC: Math.round(nearest.feelsLikeC),
    precipProbability: nearest.precipProbability,
    precipRateMmH: nearest.precipRateMmH,
    rainMmThatHour: accumulation.precipMmPrevHour,
    gustMph,
    flags: weatherFlags(nearest, accumulation, gustMph),
  };
}

/**
 * Our own plain-English heads-ups. These are OUR thresholds, not Met Office
 * warnings, and are labelled that way in the UI (T&Cs clause 3.6.2).
 * @param {Hour} at @param {Hour} hourTotal @param {number} gustMph
 */
function weatherFlags(at, hourTotal, gustMph) {
  const flags = [];
  const code = at.weatherCode ?? -99;
  if ([28, 29, 30].includes(code)) flags.push("Thunder forecast");
  if (code >= 16 && code <= 27 || hourTotal.snowMmPrevHour > 0) flags.push("Snow, sleet or hail forecast");
  else if ([13, 14, 15].includes(code) || hourTotal.precipMmPrevHour >= 4) flags.push("Heavy rain forecast");
  else if (at.precipProbability >= 50 || hourTotal.precipMmPrevHour >= 0.5) flags.push("Rain likely");
  if (gustMph >= 40) flags.push(`Strong gusts (${gustMph} mph)`);
  if (code === 6 || at.visibilityM < 1000) flags.push("Fog / poor visibility");
  if (at.temperatureC <= 0) flags.push("Below freezing: possible ice");
  return flags;
}
