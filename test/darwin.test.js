import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normaliseBoard, findService, parseEstimate, stripHtml, fetchBoard, DarwinError } from "../lib/darwin.js";

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const iso = (d) => d?.toISOString() ?? null;

// Real board captured 2026-11-13 21:07 UTC, Bolton -> Manchester Oxford Road.
const live = load("darwin-BON-MCO-live.json");

/** Copy of the real board with its first service modified: for cases we haven't seen live. */
function withFirstService(patch) {
  const raw = structuredClone(live);
  patch(raw.trainServices[0], raw);
  return raw;
}

test("real board: finds the 21:21 by scheduled time and reads the MCO arrival", () => {
  const board = normaliseBoard(live, "MCO");
  const s = findService(board, new Date("2026-11-13T21:21:00Z"));
  assert.ok(s);
  assert.equal(s.operator, "Northern");
  assert.equal(s.platform, "3");
  assert.equal(s.departure.kind, "expected");
  assert.equal(iso(s.departure.time), "2026-11-13T21:25:00.000Z");
  // Departure is 4 min late but Darwin still says the MCO arrival is "On time".
  assert.equal(iso(s.arrival.scheduled), "2026-11-13T21:41:00.000Z");
  assert.equal(s.arrival.estimate.kind, "on_time");
});

test("real board: no nrccMessages field means no messages", () => {
  assert.deepEqual(normaliseBoard(live, "MCO").messages, []);
});

test("real board: a departure that isn't on the board is not matched to a neighbour", () => {
  const board = normaliseBoard(live, "MCO");
  assert.equal(findService(board, new Date("2026-11-13T21:22:00Z")), null);
});

test("station messages are stripped of HTML but kept station-wide", () => {
  const board = normaliseBoard(load("darwin-SPT-MAN-live.json"), "MAN");
  assert.equal(board.messages.length, 1);
  assert.match(board.messages[0], /^Trains at Exeter St Davids will be cancelled, delayed by up to 25 minutes/);
  assert.doesNotMatch(board.messages[0], /<|&nbsp;/);
});

test("estimates: times, words, the * suffix and unknown words", () => {
  const ref = new Date("2026-11-16T07:22:00Z");
  assert.equal(parseEstimate("On time", ref).kind, "on_time");
  assert.equal(parseEstimate("Delayed", ref).kind, "delayed");
  assert.equal(parseEstimate("Cancelled", ref).kind, "cancelled");
  assert.equal(parseEstimate("No report", ref).kind, "no_report");
  const star = parseEstimate("07:31*", ref);
  assert.equal(star.kind, "expected");
  assert.equal(star.uncertain, true);
  assert.equal(iso(star.time), "2026-11-16T07:31:00.000Z");
  assert.equal(parseEstimate("Starts here", ref).kind, "unknown");
  assert.equal(parseEstimate(undefined, ref).kind, "unknown");
});

test("synthetic: cancelled service", () => {
  const raw = withFirstService((s) => {
    s.isCancelled = true;
    s.etd = "Cancelled";
    s.cancelReason = "This train has been cancelled because of a shortage of train crew";
  });
  const s = findService(normaliseBoard(raw, "MCO"), new Date("2026-11-13T21:21:00Z"));
  assert.equal(s.cancelled, true);
  assert.equal(s.departure.kind, "cancelled");
  assert.match(s.cancelReason, /shortage of train crew/);
});

test("synthetic: cancelled only at the destination (terminates short)", () => {
  const raw = withFirstService((s) => {
    s.filterLocationCancelled = true;
    const mco = s.subsequentCallingPoints[0].callingPoint.find((c) => c.crs === "MCO");
    mco.isCancelled = true;
    mco.et = "Cancelled";
  });
  const s = findService(normaliseBoard(raw, "MCO"), new Date("2026-11-13T21:21:00Z"));
  assert.equal(s.cancelled, false); // the train still runs...
  assert.equal(s.cancelledAtDestination, true); // ...but not to Oxford Road
  assert.equal(s.arrival.cancelled, true);
  assert.equal(s.arrival.estimate.kind, "cancelled");
});

test("synthetic: 'Delayed' with no expected time", () => {
  const raw = withFirstService((s) => {
    s.etd = "Delayed";
    s.delayReason = "This service has been delayed by a signalling problem";
  });
  const s = findService(normaliseBoard(raw, "MCO"), new Date("2026-11-13T21:21:00Z"));
  assert.equal(s.departure.kind, "delayed");
  assert.equal(s.departure.time, null);
});

test("synthetic: bus replacement shows up as mode 'bus'", () => {
  const raw = withFirstService((s, board) => {
    board.busServices = [{ ...s, serviceType: "bus", platform: "BUS", operator: "Northern" }];
    board.trainServices = board.trainServices.slice(1);
  });
  const s = findService(normaliseBoard(raw, "MCO"), new Date("2026-11-13T21:21:00Z"));
  assert.equal(s.mode, "bus");
});

test("synthetic: board crossing midnight keeps arrival on the next day", () => {
  const raw = withFirstService((s, board) => {
    board.generatedAt = "2026-11-13T23:40:00.0000000+00:00";
    s.std = "23:55";
    s.etd = "On time";
    s.subsequentCallingPoints[0].callingPoint.find((c) => c.crs === "MCO").st = "00:15";
  });
  const s = findService(normaliseBoard(raw, "MCO"), new Date("2026-11-13T23:55:00Z"));
  assert.equal(iso(s.arrival.scheduled), "2026-11-14T00:15:00.000Z");
});

const fakeFetch = (status, body) => async () => new Response(JSON.stringify(body), { status });
const opts = { from: "BON", to: "MCO", apiKey: "k", baseUrl: "https://example.test/LDBWS/api/20220120/GetDepartureBoard/{crs}" };

test("fetchBoard: gateway auth error shape -> auth", async () => {
  await assert.rejects(
    fetchBoard({ ...opts, fetch: fakeFetch(401, { fault: { faultstring: "Invalid ApiKey", detail: { errorcode: "oauth.v2.InvalidApiKey" } } }) }),
    (e) => e instanceof DarwinError && e.kind === "auth" && /Invalid ApiKey/.test(e.message),
  );
});

test("fetchBoard: backend error shape -> bad_request", async () => {
  await assert.rejects(
    fetchBoard({ ...opts, fetch: fakeFetch(400, { Message: "Invalid crs code supplied" }) }),
    (e) => e instanceof DarwinError && e.kind === "bad_request" && /Invalid crs/.test(e.message),
  );
});

test("fetchBoard: strips the operation from the Specification-tab URL", async () => {
  let called;
  await fetchBoard({ ...opts, fetch: async (url) => ((called = String(url)), new Response("{}")) });
  assert.match(called, /^https:\/\/example\.test\/LDBWS\/api\/20220120\/GetDepBoardWithDetails\/BON\?/);
  assert.match(called, /filterCrs=MCO/);
});

const hang = async (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));

test("fetchBoard: a hung upstream times out instead of hanging", async () => {
  await assert.rejects(
    fetchBoard({ ...opts, fetch: hang, timeoutMs: 50 }),
    (e) => e instanceof DarwinError && e.kind === "unavailable" && /timed out after 50ms/.test(e.message),
  );
});

test("fetchBoard: a 200 that isn't JSON is 'unavailable', not a crash", async () => {
  await assert.rejects(
    fetchBoard({ ...opts, fetch: async () => new Response("<html>gateway</html>", { status: 200 }) }),
    (e) => e instanceof DarwinError && e.kind === "unavailable",
  );
});
