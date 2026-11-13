import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHHMM,
  londonToUtc,
  nextOccurrence,
  boardTimeToDate,
  liveDataFrom,
  formatLondon,
} from "../lib/time.js";

const iso = (d) => d.toISOString();

test("parseHHMM accepts only 24h HH:MM", () => {
  assert.deepEqual(parseHHMM("07:22"), { hour: 7, minute: 22 });
  assert.equal(parseHHMM("7:22"), null);
  assert.equal(parseHHMM("24:00"), null);
  assert.equal(parseHHMM("On time"), null);
});

test("londonToUtc applies GMT in winter and BST in summer", () => {
  assert.equal(iso(londonToUtc(2026, 11, 16, 7, 22)), "2026-11-16T07:22:00.000Z");
  assert.equal(iso(londonToUtc(2026, 7, 16, 7, 22)), "2026-07-16T06:22:00.000Z");
});

test("the night before: next 07:22 is tomorrow morning", () => {
  const now = new Date("2026-11-15T21:00:00Z"); // Sunday 21:00 GMT
  assert.equal(iso(nextOccurrence("07:22", now)), "2026-11-16T07:22:00.000Z");
});

test("a few minutes after departure, the same train is still current (it may be late)", () => {
  const now = new Date("2026-11-16T07:40:00Z");
  assert.equal(iso(nextOccurrence("07:22", now)), "2026-11-16T07:22:00.000Z");
});

test("well after departure, it rolls to tomorrow", () => {
  const now = new Date("2026-11-16T08:00:00Z");
  assert.equal(iso(nextOccurrence("07:22", now)), "2026-11-17T07:22:00.000Z");
});

test("checking the night before the clocks go forward gets the BST instant", () => {
  // Sat 28 Mar 2026 21:00 GMT; clocks go forward 01:00 GMT Sun 29 Mar
  const now = new Date("2026-03-28T21:00:00Z");
  assert.equal(iso(nextOccurrence("07:22", now)), "2026-03-29T06:22:00.000Z");
});

test("checking the night before the clocks go back gets the GMT instant", () => {
  // Sat 24 Oct 2026 21:00 BST; clocks go back 01:00 GMT Sun 25 Oct
  const now = new Date("2026-10-24T20:00:00Z");
  assert.equal(iso(nextOccurrence("07:22", now)), "2026-10-25T07:22:00.000Z");
});

test("Darwin board times resolve across midnight", () => {
  const generatedAt = new Date("2026-11-16T23:50:00Z");
  assert.equal(iso(boardTimeToDate("00:10", generatedAt)), "2026-11-17T00:10:00.000Z");
  assert.equal(iso(boardTimeToDate("23:40", generatedAt)), "2026-11-16T23:40:00.000Z");
});

test("Darwin board times handle the uncertain-time asterisk and non-times", () => {
  const ref = new Date("2026-11-16T07:00:00Z");
  assert.equal(iso(boardTimeToDate("07:31*", ref)), "2026-11-16T07:31:00.000Z");
  assert.equal(boardTimeToDate("On time", ref), null);
  assert.equal(boardTimeToDate("Delayed", ref), null);
  assert.equal(boardTimeToDate(undefined, ref), null);
});

test("live data becomes available just under two hours before", () => {
  const dep = new Date("2026-11-16T07:22:00Z");
  assert.equal(formatLondon(liveDataFrom(dep)), "05:23");
});
