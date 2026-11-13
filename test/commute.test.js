import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkCommute } from "../lib/commute.js";
import { summariseForecast } from "../lib/metoffice.js";
import { DarwinError } from "../lib/darwin.js";
import { MetOfficeError } from "../lib/metoffice.js";

const stations = {
  BON: { name: "Bolton", lat: 53.57414, lon: -2.42582 },
  MCO: { name: "Manchester Oxford Road", lat: 53.47403, lon: -2.242 },
};
// Real board, captured 2026-11-13 21:07 UTC.
const liveBoard = JSON.parse(readFileSync(new URL("./fixtures/darwin-BON-MCO-live.json", import.meta.url), "utf8"));

/** Synthetic hourly forecast covering 48h from `start`, with optional per-hour overrides. */
function forecastFrom(start, overrides = {}) {
  const t0 = new Date(start).getTime();
  return summariseForecast({
    features: [{
      properties: {
        location: { name: "Test point" }, requestPointDistance: 500, modelRunDate: new Date(t0).toISOString(),
        timeSeries: Array.from({ length: 49 }, (_, i) => {
          const time = new Date(t0 + i * 3_600_000).toISOString().replace(":00.000Z", "Z");
          return {
            time, screenTemperature: 5, feelsLikeTemperature: 2, windGustSpeed10m: 5, visibility: 15000,
            significantWeatherCode: 7, precipitationRate: 0, totalPrecipAmount: 0, totalSnowAmount: 0,
            probOfPrecipitation: 5, ...overrides[time],
          };
        }),
      },
    }],
  });
}

function clients({ board = liveBoard, forecast, boardError, forecastError } = {}) {
  const calls = { board: 0, forecast: 0 };
  return {
    calls,
    getBoard: async () => { calls.board++; if (boardError) throw boardError; return board; },
    getForecast: async () => { calls.forecast++; if (forecastError) throw forecastError; return forecast; },
  };
}

const base = { from: "BON", to: "MCO", stations, source: "live" };

test("night before: weather only, no Darwin call, says when live data starts, times are 'saved'", async () => {
  const c = clients({
    forecast: forecastFrom("2026-11-15T20:00:00Z", { "2026-11-16T07:00Z": { significantWeatherCode: 12, probOfPrecipitation: 70 } }),
  });
  const r = await checkCommute({ ...base, depart: "07:22", arrive: "07:45", now: new Date("2026-11-15T21:00:00Z"), clients: c });
  assert.equal(r.mode, "planning");
  assert.equal(c.calls.board, 0);
  assert.equal(r.train, null);
  assert.equal(r.liveAvailableFrom.local, "05:23");
  assert.equal(r.journey.departure.basis, "saved");
  assert.equal(r.journey.arrival.basis, "saved");
  assert.equal(r.weather.departure.local, "07:22");
  assert.equal(r.weather.arrival.local, "07:45");
  assert.deepEqual(r.weather.departure.conditions.flags, ["Rain likely"]);
  assert.ok(r.notChecked.length > 0);
});

test("within two hours: live train found, arrival from the timetable, weather at live times", async () => {
  const c = clients({ forecast: forecastFrom("2026-11-13T20:00:00Z") });
  const r = await checkCommute({ ...base, depart: "21:21", arrive: "21:41", now: new Date("2026-11-13T21:07:00Z"), clients: c });
  assert.equal(r.mode, "live");
  assert.equal(c.calls.board, 1);
  assert.equal(r.train.status, "late");
  assert.equal(r.train.minutesLate, 4);
  assert.equal(r.train.expectedDeparture, "21:25");
  assert.equal(r.train.expectedArrival, "On time");
  assert.equal(r.journey.departure.basis, "live estimate");
  assert.equal(r.journey.arrival.basis, "timetable"); // "On time" gives no time, so we use the scheduled one
  assert.equal(r.weather.departure.local, "21:25");
  assert.equal(r.weather.arrival.local, "21:41");
  assert.deepEqual(r.notes, []);
});

test("saved arrival differs from the timetable: we say so", async () => {
  const c = clients({ forecast: forecastFrom("2026-11-13T20:00:00Z") });
  const r = await checkCommute({ ...base, depart: "21:21", arrive: "21:45", now: new Date("2026-11-13T21:07:00Z"), clients: c });
  assert.match(r.notes[0], /arriving at 21:41, not the 21:45 you saved/);
});

test("saved train not on the board: not_found, lists what is there, no guessing", async () => {
  const c = clients({ forecast: forecastFrom("2026-11-13T20:00:00Z") });
  const r = await checkCommute({ ...base, depart: "21:30", arrive: "21:50", now: new Date("2026-11-13T21:07:00Z"), clients: c });
  assert.equal(r.train.status, "not_found");
  assert.match(r.train.message, /No 21:30 from Bolton calling at MCO/);
  assert.equal(r.train.otherServices[0], "21:21 to Manchester Airport");
  assert.equal(r.journey.departure.basis, "saved");
});

test("checked after the scheduled time and gone from the board: may have departed", async () => {
  const c = clients({ forecast: forecastFrom("2026-11-13T20:00:00Z") });
  const r = await checkCommute({ ...base, depart: "20:55", arrive: "21:15", now: new Date("2026-11-13T21:07:00Z"), clients: c });
  assert.equal(r.mode, "live");
  assert.match(r.train.message, /may already have departed/);
});

test("Darwin down: train unavailable, weather still shown", async () => {
  const c = clients({ forecast: forecastFrom("2026-11-13T20:00:00Z"), boardError: new DarwinError("unavailable", 503, "Darwin 503") });
  const r = await checkCommute({ ...base, depart: "21:21", arrive: "21:41", now: new Date("2026-11-13T21:07:00Z"), clients: c });
  assert.equal(r.train.status, "unavailable");
  assert.ok(r.weather.departure.conditions);
});

test("Met Office quota reached: weather says why, train still shown", async () => {
  const c = clients({ forecastError: new MetOfficeError("quota", 429, "Met Office 429") });
  const r = await checkCommute({ ...base, depart: "21:21", arrive: "21:41", now: new Date("2026-11-13T21:07:00Z"), clients: c });
  assert.equal(r.train.status, "late");
  assert.equal(r.weather.departure.conditions, null);
  assert.match(r.weather.departure.message, /daily request limit/);
});

test("cancelled train", async () => {
  const board = structuredClone(liveBoard);
  Object.assign(board.trainServices[0], { isCancelled: true, etd: "Cancelled", cancelReason: "This train has been cancelled because of a fault on this train" });
  const r = await checkCommute({ ...base, depart: "21:21", arrive: "21:41", now: new Date("2026-11-13T21:07:00Z"), clients: clients({ board, forecast: forecastFrom("2026-11-13T20:00:00Z") }) });
  assert.equal(r.train.status, "cancelled");
  assert.match(r.train.reason, /fault on this train/);
});

test("journey over midnight: arrival is the next day", async () => {
  const c = clients({ forecast: forecastFrom("2026-11-15T20:00:00Z") });
  const r = await checkCommute({ ...base, depart: "23:50", arrive: "00:15", now: new Date("2026-11-15T21:00:00Z"), clients: c });
  assert.equal(r.journey.departure.time, "2026-11-15T23:50:00.000Z");
  assert.equal(r.journey.arrival.time, "2026-11-16T00:15:00.000Z");
});
