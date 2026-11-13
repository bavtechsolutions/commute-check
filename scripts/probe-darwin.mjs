// Probe: one real request to Darwin Live Departure Board (public) via Rail Data Marketplace.
// Usage: node --env-file=.env.local scripts/probe-darwin.mjs <fromCRS> [toCRS]
// e.g.   node --env-file=.env.local scripts/probe-darwin.mjs SPT MAN
// Never prints the API key.
import { mkdir, writeFile } from "node:fs/promises";

const key = process.env.RDM_LDB_API_KEY;
const base = process.env.RDM_LDB_BASE_URL;
if (!key) throw new Error("RDM_LDB_API_KEY is not set (check .env.local)");
if (!base) throw new Error("RDM_LDB_BASE_URL is not set (copy it from the Specification tab)");

const [from = "MAN", to] = process.argv.slice(2);
// Operation to call; the Specification tab URL may include one, e.g. .../GetDepartureBoard/{crs}
const op = process.env.LDB_OP ?? "GetDepBoardWithDetails";
const root = base.replace(/\/Get\w+\/\{crs\}\/?$/, "").replace(/\/$/, "");

const url = new URL(`${root}/${op}/${from}`);
url.search = new URLSearchParams({
  numRows: "5",
  timeWindow: "120",
  ...(to && { filterCrs: to, filterType: "to" }),
}).toString();

console.log(`GET ${url}`);
// Header name per community docs; confirm against the Specification tab.
const res = await fetch(url, { headers: { "x-apikey": key, accept: "application/json" } });

console.log(`\nStatus: ${res.status} ${res.statusText}`);
console.log("Headers:");
for (const [name, value] of res.headers) {
  if (name !== "set-cookie") console.log(`  ${name}: ${value}`);
}

const text = await res.text();
await mkdir("probe-output", { recursive: true });
const file = `probe-output/darwin-${from}${to ? "-" + to : ""}-${Date.now()}.json`;
await writeFile(file, text);
console.log(`\nRaw body saved to ${file} (${text.length} bytes)`);

if (!res.ok) {
  console.log("\nBody:\n" + text.slice(0, 2000));
  process.exit(1);
}

const body = JSON.parse(text);
const { trainServices, busServices, ferryServices, ...board } = body;
console.log("\nBoard fields (minus services):", JSON.stringify(board, null, 2));
console.log(`trainServices: ${trainServices?.length ?? "absent"}, busServices: ${busServices?.length ?? "absent"}`);

for (const s of trainServices ?? []) {
  const dest = s.destination?.map((d) => d.locationName).join(" / ");
  console.log(`\n${s.std} -> ${dest}  etd=${JSON.stringify(s.etd)}  platform=${s.platform ?? "-"}  cancelled=${s.isCancelled ?? false}`);
  console.log(`  serviceID=${s.serviceID}  operator=${s.operator} (${s.operatorCode})`);
  if (s.delayReason) console.log(`  delayReason: ${s.delayReason}`);
  if (s.cancelReason) console.log(`  cancelReason: ${s.cancelReason}`);
  const calls = s.subsequentCallingPoints?.[0]?.callingPoint ?? [];
  console.log("  calls: " + calls.map((c) => `${c.crs} st=${c.st} et=${c.et ?? c.at}`).join(", "));
}
console.log("\nFirst service keys:", Object.keys(trainServices?.[0] ?? {}));
