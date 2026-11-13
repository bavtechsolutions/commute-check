// @ts-check
// SYNTHETIC Met Office forecasts with the same shape as a real Global Spot
// hourly response. We never commit real Met Office responses: the DataHub
// licence (clause 3.2.2) forbids redistributing the data in original form.
import { summariseForecast } from "../lib/metoffice.js";

/** Calm, dry, cloudy hour. */
const CALM = {
  screenTemperature: 5, feelsLikeTemperature: 2, windGustSpeed10m: 5, visibility: 15000,
  significantWeatherCode: 7, precipitationRate: 0, totalPrecipAmount: 0, totalSnowAmount: 0,
  probOfPrecipitation: 5,
};

/**
 * 49 hourly entries from `start` (a model run), with optional overrides keyed
 * by the Met Office's own time format, e.g. "2026-11-16T07:00Z".
 * @param {string} start ISO time on the hour
 * @param {Record<string, object>} [overrides]
 */
export function rawForecast(start, overrides = {}) {
  const t0 = new Date(start).getTime();
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0, 0] },
      properties: {
        location: { name: "Synthetic forecast point" },
        requestPointDistance: 500,
        modelRunDate: new Date(t0).toISOString().replace(":00.000Z", "Z"),
        timeSeries: Array.from({ length: 49 }, (_, i) => {
          const time = new Date(t0 + i * 3_600_000).toISOString().replace(":00.000Z", "Z");
          return { time, ...CALM, ...overrides[time] };
        }),
      },
    }],
  };
}

/** @param {string} start @param {Record<string, object>} [overrides] */
export const syntheticForecast = (start, overrides) => summariseForecast(rawForecast(start, overrides));
