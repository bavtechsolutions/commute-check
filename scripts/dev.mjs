// Local dev server: serves public/ and routes /api/* to the same handlers
// Vercel runs, so no Vercel CLI or account is needed to try it locally.
// Usage: npm run dev   (reads keys from .env.local)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import commute from "../api/commute.js";
import demo from "../api/demo.js";

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = join(import.meta.dirname, "..", "public");
const API = { "/api/commute": commute, "/api/demo": demo };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    const handler = API[url.pathname];
    if (handler) {
      const response = await handler.fetch(new Request(url, { method: req.method }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const path = normalize(join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
    // Must be inside public/ itself, not just share its prefix (e.g. "public-x").
    if (!path.startsWith(ROOT + sep)) throw Object.assign(new Error("forbidden"), { code: "ENOENT" });
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain" });
    res.end(err.code === "ENOENT" ? "Not found" : "Server error");
    if (err.code !== "ENOENT") console.error(err);
  }
}).listen(PORT, () => console.log(`Commute Check on http://localhost:${PORT}`));
