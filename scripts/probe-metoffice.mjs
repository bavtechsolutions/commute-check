// Probe: one real request to Met Office Weather DataHub, Global Spot hourly.
// Usage: node --env-file=.env.local scripts/probe-metoffice.mjs [lat] [lon]
// Costs 1 call from the 360/day free allowance. Never prints the API key.
import { mkdir, writeFile } from "node:fs/promises";

const key = process.env.METOFFICE_API_KEY;
if (!key) throw new Error("METOFFICE_API_KEY is not set (check .env.local)");

// Default: Manchester Piccadilly, approximate
const [lat = "53.4774", lon = "-2.2309"] = process.argv.slice(2);

const url = new URL("https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/hourly");
url.search = new URLSearchParams({
  latitude: lat,
  longitude: lon,
  includeLocationName: "true",
  excludeParameterMetadata: "false",
}).toString();

console.log(`GET ${url}`);
const res = await fetch(url, { headers: { apikey: key, accept: "application/json" } });

console.log(`\nStatus: ${res.status} ${res.statusText}`);
console.log("Headers:");
for (const [name, value] of res.headers) {
  if (name !== "set-cookie") console.log(`  ${name}: ${value}`);
}

const text = await res.text();
await mkdir("probe-output", { recursive: true });
const file = `probe-output/metoffice-hourly-${Date.now()}.json`;
await writeFile(file, text);
console.log(`\nRaw body saved to ${file} (${text.length} bytes)`);

if (!res.ok) {
  console.log("\nBody:\n" + text.slice(0, 2000));
  process.exit(1);
}

const body = JSON.parse(text);
console.log("\nTop-level keys:", Object.keys(body));
const feature = body.features?.[0];
console.log("Feature geometry:", JSON.stringify(feature?.geometry));
const { timeSeries, ...props } = feature?.properties ?? {};
console.log("Feature properties (minus timeSeries):", JSON.stringify(props));
console.log(`timeSeries length: ${timeSeries?.length}`);
console.log("First entry:", JSON.stringify(timeSeries?.[0], null, 2));
console.log("Last entry time:", timeSeries?.at(-1)?.time);

const params = body.parameters?.[0];
if (params) {
  console.log("\nParameter metadata (name: unit — description):");
  for (const [name, meta] of Object.entries(params)) {
    console.log(`  ${name}: ${meta.unit?.symbol?.type ?? meta.unit?.symbol?.value ?? "?"} — ${meta.description}`);
  }
}
