import { test } from "node:test";
import assert from "node:assert/strict";
import { summariseForecast, conditionsAt, fetchForecast, MetOfficeError } from "../lib/metoffice.js";

// SYNTHETIC forecast with the same shape as a real Global Spot hourly response.
// We don't commit real Met Office responses: the DataHub licence (clause 3.2.2)
// forbids redistributing the data in its original form.
function forecast(hours) {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [-2.4258, 53.5741, 90] },
      properties: {
        location: { name: "Bolton" },
        requestPointDistance: 412.3,
        modelRunDate: "2026-11-15T20:00Z",
        timeSeries: hours.map(([time, over]) => ({
          time,
          screenTemperature: 6, feelsLikeTemperature: 3, windGustSpeed10m: 8, visibility: 12000,
          significantWeatherCode: 7, precipitationRate: 0, totalPrecipAmount: 0, totalSnowAmount: 0,
          probOfPrecipitation: 10,
          ...over,
        })),
      },
    }],
  };
}

test("summary keeps only our fields, parses UTC 'HH:MMZ' times", () => {
  const f = summariseForecast(forecast([["2026-11-16T07:00Z", {}]]));
  assert.equal(f.pointName, "Bolton");
  assert.equal(f.distanceMetres, 412);
  assert.equal(f.hours[0].time.toISOString(), "2026-11-16T07:00:00.000Z");
  assert.equal("screenRelativeHumidity" in f.hours[0], false);
});

test("07:22: instantaneous values from 07:00, rain total from the 08:00 entry (previous hour)", () => {
  const f = summariseForecast(forecast([
    ["2026-11-16T07:00Z", { significantWeatherCode: 12, probOfPrecipitation: 60, totalPrecipAmount: 0.1 }],
    ["2026-11-16T08:00Z", { significantWeatherCode: 7, probOfPrecipitation: 20, totalPrecipAmount: 1.4 }],
  ]));
  const c = conditionsAt(f, new Date("2026-11-16T07:22:00Z"));
  assert.equal(c.time.toISOString(), "2026-11-16T07:00:00.000Z");
  assert.equal(c.weather, "Light rain");
  assert.equal(c.precipProbability, 60);
  assert.equal(c.rainMmThatHour, 1.4); // 07:00-08:00, not the 0.1 that fell 06:00-07:00
  assert.deepEqual(c.flags, ["Rain likely"]);
});

test("07:38 rounds to the 08:00 entry for instantaneous values", () => {
  const f = summariseForecast(forecast([
    ["2026-11-16T07:00Z", { significantWeatherCode: 1 }],
    ["2026-11-16T08:00Z", { significantWeatherCode: 15 }],
  ]));
  const c = conditionsAt(f, new Date("2026-11-16T07:38:00Z"));
  assert.equal(c.weather, "Heavy rain");
  assert.deepEqual(c.flags, ["Heavy rain forecast"]);
});

test("beyond the forecast range returns null rather than guessing", () => {
  const f = summariseForecast(forecast([["2026-11-16T07:00Z", {}]]));
  assert.equal(conditionsAt(f, new Date("2026-11-16T07:22:00Z")), null); // no 08:00 entry
  assert.equal(conditionsAt(f, new Date("2026-11-18T07:22:00Z")), null);
});

test("flags: gusts converted from m/s to mph, fog, freezing, snow, thunder", () => {
  const f = summariseForecast(forecast([
    ["2026-11-16T07:00Z", { windGustSpeed10m: 20, visibility: 800, screenTemperature: -1, significantWeatherCode: 24 }],
    ["2026-11-16T08:00Z", {}],
  ]));
  const c = conditionsAt(f, new Date("2026-11-16T07:10:00Z"));
  assert.equal(c.gustMph, 45);
  assert.deepEqual(c.flags, ["Snow, sleet or hail forecast", "Strong gusts (45 mph)", "Fog / poor visibility", "Below freezing: possible ice"]);

  const t = summariseForecast(forecast([["2026-11-16T07:00Z", { significantWeatherCode: 29 }], ["2026-11-16T08:00Z", {}]]));
  assert.deepEqual(conditionsAt(t, new Date("2026-11-16T07:10:00Z")).flags, ["Thunder forecast"]);
});

test("a dry, calm hour has no flags", () => {
  const f = summariseForecast(forecast([["2026-11-16T07:00Z", {}], ["2026-11-16T08:00Z", {}]]));
  assert.deepEqual(conditionsAt(f, new Date("2026-11-16T07:22:00Z")).flags, []);
});

test("a missing timeSeries is an error, not an empty forecast", () => {
  assert.throws(() => summariseForecast({ features: [] }), MetOfficeError);
});

const fakeFetch = (status, body) => async () => new Response(JSON.stringify(body), { status });

test("fetchForecast: 429 -> quota (daily limit)", async () => {
  await assert.rejects(
    fetchForecast({ lat: 1, lon: 1, apiKey: "k", fetch: fakeFetch(429, { message: "Too many requests" }) }),
    (e) => e instanceof MetOfficeError && e.kind === "quota",
  );
});

test("fetchForecast: gateway 401 -> auth, message kept", async () => {
  await assert.rejects(
    fetchForecast({ lat: 1, lon: 1, apiKey: "k", fetch: fakeFetch(401, { code: "900901", message: "Invalid Credentials", description: "Make sure you have provided the correct security credentials" }) }),
    (e) => e instanceof MetOfficeError && e.kind === "auth" && /Invalid Credentials/.test(e.message),
  );
});

test("fetchForecast: sends the key as an 'apikey' header, never in the URL", async () => {
  let seen;
  await fetchForecast({ lat: 53.57, lon: -2.43, apiKey: "secret", fetch: async (url, init) => ((seen = { url: String(url), init }), new Response("{}")) });
  assert.equal(seen.init.headers.apikey, "secret");
  assert.doesNotMatch(seen.url, /secret/);
});

test("fetchForecast: a hung upstream times out instead of hanging", async () => {
  const hang = async (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  await assert.rejects(
    fetchForecast({ lat: 1, lon: 1, apiKey: "k", fetch: hang, timeoutMs: 50 }),
    (e) => e instanceof MetOfficeError && e.kind === "unavailable" && /timed out after 50ms/.test(e.message),
  );
});
