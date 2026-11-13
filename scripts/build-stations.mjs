// Builds data/stations.json (CRS -> name, lat, lon) from NaPTAN.
// Usage: node scripts/build-stations.mjs <path-to-naptan-910.xml>
// Download: https://naptan.api.dft.gov.uk/v1/access-nodes?atcoAreaCodes=910&dataFormat=xml
// (area 910 = National Rail). The CSV export has no CRS codes, so we use the XML.
// NaPTAN is published under the Open Government Licence v3.
import { readFile, writeFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) throw new Error("Pass the path to the NaPTAN area 910 XML file");
const xml = await readFile(file, "utf8");

// One-off build step over a well-formed government export, so a regex per
// <StopPoint> is enough; no XML parser dependency.
const tag = (block, name) => block.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];

const stations = {};
const skipped = [];
for (const [block] of xml.matchAll(/<StopPoint\b[\s\S]*?<\/StopPoint>/g)) {
  if (!/Status="active"/.test(block.slice(0, 300)) || tag(block, "StopType") !== "RLY") continue;
  const crs = tag(block, "CrsRef");
  const lat = Number(tag(block, "Latitude"));
  const lon = Number(tag(block, "Longitude"));
  const name = (tag(block, "StationName") ?? tag(block, "CommonName") ?? "").replace(/ Rail Station$/, "");
  if (!crs || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
    skipped.push(tag(block, "AtcoCode"));
    continue;
  }
  if (stations[crs]) continue; // a few stations have more than one TIPLOC; first wins
  stations[crs] = { name, lat: +lat.toFixed(5), lon: +lon.toFixed(5) };
}

const sorted = Object.fromEntries(Object.entries(stations).sort(([a], [b]) => a.localeCompare(b)));
await writeFile("data/stations.json", JSON.stringify(sorted, null, 0).replace(/},/g, "},\n") + "\n");
console.log(`Wrote ${Object.keys(sorted).length} stations; skipped ${skipped.length} without CRS/coordinates`);
if (skipped.length) console.log("Skipped:", skipped.slice(0, 20).join(", "), skipped.length > 20 ? "..." : "");
