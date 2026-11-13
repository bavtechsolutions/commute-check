// @ts-check
// SIMULATED scenarios for /api/demo. Each one runs the real checkCommute()
// with fake API clients and a fixed clock, so reviewers can see edge cases
// on demand. Only api/demo.js imports this file.
//
// Darwin data: a real Bolton -> Manchester Oxford Road board captured
// 2026-11-13 21:07 UTC, modified per scenario. Weather: synthetic (we can't
// publish real Met Office responses, DataHub T&Cs 3.2.2).
import liveBoard from "../fixtures/darwin-BON-MCO-live.json" with { type: "json" };
import { syntheticForecast } from "../fixtures/synthetic-forecast.js";
import { DarwinError } from "../lib/darwin.js";
import { MetOfficeError } from "../lib/metoffice.js";

const CAPTURED_AT = new Date("2026-11-13T21:07:00Z");
const LIVE_JOURNEY = { from: "BON", to: "MCO", depart: "21:21", arrive: "21:41" };
const dryEvening = syntheticForecast("2026-11-13T20:00:00Z");

/** @param {(board: any) => void} patch */
function board(patch = () => {}) {
  const b = structuredClone(liveBoard);
  patch(b);
  return b;
}
const first = (b) => b.trainServices[0];

/**
 * @typedef {{ title: string, description: string, journey: typeof LIVE_JOURNEY, now: Date,
 *             getBoard: () => Promise<any>, getForecast: () => Promise<any> }} Scenario
 * @type {Record<string, Scenario>}
 */
export const SCENARIOS = {
  "night-before": {
    title: "The night before",
    description: "Checked at 21:00 for tomorrow's 07:22. Darwin can't see that far ahead, so only the forecast is shown, using your saved times. Rain is forecast around arrival.",
    journey: { from: "BON", to: "MCO", depart: "07:22", arrive: "07:45" },
    now: new Date("2026-11-15T21:00:00Z"),
    getBoard: async () => { throw new Error("Darwin should not be called in planning mode"); },
    getForecast: async () => syntheticForecast("2026-11-15T20:00:00Z", {
      "2026-11-16T08:00Z": { significantWeatherCode: 12, probOfPrecipitation: 70, precipitationRate: 1.2, totalPrecipAmount: 1.1 },
    }),
  },
  "running-late": {
    title: "Running late (real data)",
    description: "The real board as captured: the 21:21 is expected at 21:25, but Darwin still shows the Oxford Road arrival as 'On time'.",
    journey: LIVE_JOURNEY,
    now: CAPTURED_AT,
    getBoard: async () => board(),
    getForecast: async () => dryEvening,
  },
  cancelled: {
    title: "Cancelled",
    description: "The 21:21 is cancelled, with a reason from Darwin.",
    journey: LIVE_JOURNEY,
    now: CAPTURED_AT,
    getBoard: async () => board((b) => Object.assign(first(b), {
      isCancelled: true, etd: "Cancelled", cancelReason: "This train has been cancelled because of a shortage of train crew",
    })),
    getForecast: async () => dryEvening,
  },
  "terminates-short": {
    title: "Doesn't reach your station",
    description: "The train runs, but is cancelled at Manchester Oxford Road (for example, terminating at Salford Crescent).",
    journey: LIVE_JOURNEY,
    now: CAPTURED_AT,
    getBoard: async () => board((b) => {
      first(b).filterLocationCancelled = true;
      const mco = first(b).subsequentCallingPoints[0].callingPoint.find((c) => c.crs === "MCO");
      Object.assign(mco, { isCancelled: true, et: "Cancelled" });
    }),
    getForecast: async () => dryEvening,
  },
  "delayed-no-estimate": {
    title: "Delayed, no estimate",
    description: "Darwin says 'Delayed' with no expected time, so we can't say when it will leave.",
    journey: LIVE_JOURNEY,
    now: CAPTURED_AT,
    getBoard: async () => board((b) => Object.assign(first(b), { etd: "Delayed", delayReason: "This service has been delayed by a signalling problem" })),
    getForecast: async () => dryEvening,
  },
  "bus-replacement": {
    title: "Replacement bus",
    description: "Your departure is a rail replacement bus, listed in Darwin's busServices rather than trainServices.",
    journey: LIVE_JOURNEY,
    now: CAPTURED_AT,
    getBoard: async () => board((b) => {
      b.busServices = [{ ...first(b), serviceType: "bus", platform: "BUS", etd: "On time" }];
      b.trainServices = b.trainServices.slice(1);
    }),
    getForecast: async () => dryEvening,
  },
  "not-on-board": {
    title: "Your train isn't running",
    description: "You saved 21:30, but there's no 21:30 on the board (e.g. after a timetable change). We say so rather than picking the nearest train.",
    journey: { ...LIVE_JOURNEY, depart: "21:30", arrive: "21:50" },
    now: CAPTURED_AT,
    getBoard: async () => board(),
    getForecast: async () => dryEvening,
  },
  "stormy-arrival": {
    title: "Storm on arrival",
    description: "Train on time, but heavy rain and strong gusts forecast at Oxford Road when you arrive.",
    journey: LIVE_JOURNEY,
    now: CAPTURED_AT,
    getBoard: async () => board((b) => { first(b).etd = "On time"; }),
    getForecast: async () => syntheticForecast("2026-11-13T20:00:00Z", {
      "2026-11-13T22:00Z": { significantWeatherCode: 15, probOfPrecipitation: 95, precipitationRate: 6, totalPrecipAmount: 5.5, windGustSpeed10m: 21 },
    }),
  },
  "weather-limit": {
    title: "Met Office limit reached",
    description: "The Met Office daily request limit (360 on the free plan) has been hit. Train information still works.",
    journey: LIVE_JOURNEY,
    now: CAPTURED_AT,
    getBoard: async () => board(),
    getForecast: async () => { throw new MetOfficeError("quota", 429, "Met Office 429: simulated"); },
  },
  "darwin-down": {
    title: "Darwin unavailable",
    description: "The rail API is down. Weather is still shown, and we say clearly that train information is missing.",
    journey: LIVE_JOURNEY,
    now: CAPTURED_AT,
    getBoard: async () => { throw new DarwinError("unavailable", 503, "Darwin 503: simulated"); },
    getForecast: async () => dryEvening,
  },
};
