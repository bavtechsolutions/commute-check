import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import demo from "../api/demo.js";
import commute from "../api/commute.js";

const get = (handler, qs) => handler.fetch(new Request(`http://localhost/api/x?${qs}`));

test("every demo scenario runs and is labelled simulated", async () => {
  const list = await (await get(demo, "")).json();
  assert.ok(list.scenarios.length >= 8);
  for (const { id } of list.scenarios) {
    const res = await get(demo, `scenario=${id}`);
    assert.equal(res.status, 200, id);
    const body = await res.json();
    assert.equal(body.source, "simulated", id);
    assert.equal(body.scenario.id, id);
  }
});

test("scenario outcomes", async () => {
  const run = async (id) => (await get(demo, `scenario=${id}`)).json();
  assert.equal((await run("night-before")).mode, "planning");
  assert.equal((await run("cancelled")).train.status, "cancelled");
  assert.equal((await run("terminates-short")).train.status, "cancelled_at_destination");
  assert.equal((await run("delayed-no-estimate")).train.status, "delayed");
  assert.equal((await run("bus-replacement")).train.mode, "bus");
  assert.equal((await run("not-on-board")).train.status, "not_found");
  assert.ok((await run("stormy-arrival")).weather.arrival.conditions.flags.includes("Heavy rain forecast"));
  assert.match((await run("weather-limit")).weather.departure.message, /daily request limit/);
  assert.equal((await run("darwin-down")).train.status, "unavailable");
});

test("unknown scenario is a 404, not a fallback to live", async () => {
  assert.equal((await get(demo, "scenario=__proto__")).status, 404);
  assert.equal((await get(demo, "scenario=nope")).status, 404);
});

test("live endpoint validates input before calling any API", async () => {
  assert.equal((await get(commute, "from=bon&to=XXX&depart=07:22&arrive=07:45")).status, 400);
  assert.equal((await get(commute, "from=BON&to=BON&depart=07:22&arrive=07:45")).status, 400);
  assert.equal((await get(commute, "from=BON&to=MCO&depart=7:22&arrive=07:45")).status, 400);
});

test("the live endpoint never imports simulated data", () => {
  for (const file of ["../api/commute.js", "../lib/live-clients.js", "../lib/commute.js", "../lib/request.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0, file);
    for (const path of imports) assert.doesNotMatch(path, /fixtures|demo/, `${file} imports ${path}`);
  }
});

test("live endpoint without keys: 503 naming the missing settings (never values)", async () => {
  const saved = {};
  for (const k of ["METOFFICE_API_KEY", "RDM_LDB_API_KEY", "RDM_LDB_BASE_URL"]) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.RDM_LDB_API_KEY = "set-but-secret-value";
  try {
    const res = await get(commute, "from=BON&to=MCO&depart=07:22&arrive=07:45");
    assert.equal(res.status, 503);
    const { error } = await res.json();
    assert.match(error, /missing METOFFICE_API_KEY, RDM_LDB_BASE_URL/);
    assert.doesNotMatch(error, /RDM_LDB_API_KEY|set-but-secret-value/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
