// The character editor's server: node tools/character-editor/server.mjs [port]
// Node's built-ins only. It serves the page (web/), the viewer build (build/: viewer.wasm and
// Odin's odin.js and wgpu.js, made by `make web`) and a read-only file API over the repo's assets/characters/:
//   GET /api/characters      [{name, file}] for every assets/characters/<name>.json
//   GET /api/file?name=...   a character file's text
// The editor saves in the browser and exports files; it never writes here.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHARACTERS = path.resolve(HERE, "../../assets/characters");
const ROOTS = [path.join(HERE, "web"), path.join(HERE, "build")];
const PORT = Number(process.argv[2] ?? 5180);
const FILE = /^[A-Za-z0-9_-]+\.json$/;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };

function assetPath(name) {
  if (!name || !FILE.test(name)) return null;
  const full = path.resolve(CHARACTERS, name);
  return path.dirname(full) === CHARACTERS ? full : null;
}

function send(res, status, body, type = "text/plain") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function api(req, res, url) {
  if (url.pathname === "/api/characters" && req.method === "GET") {
    const list = fs
      .readdirSync(CHARACTERS)
      .filter((f) => FILE.test(f))
      .sort()
      .map((f) => ({ name: f.slice(0, -".json".length), file: f }));
    return send(res, 200, JSON.stringify(list), "application/json");
  }
  if (url.pathname === "/api/file") {
    const file = assetPath(url.searchParams.get("name"));
    if (!file) return send(res, 400, "only assets/characters/<name>.json");
    if (req.method === "GET") {
      if (!fs.existsSync(file)) return send(res, 404, "not found");
      return send(res, 200, fs.readFileSync(file), "application/json");
    }
  }
  send(res, 404, "no such api");
}

function serveStatic(res, url) {
  const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  for (const root of ROOTS) {
    const file = path.resolve(root, "." + rel);
    if (!file.startsWith(root + path.sep)) break;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] ?? "application/octet-stream");
    }
  }
  send(res, 404, "not found");
}

http
  .createServer((req, res) => {
    // mjolnir's wasm is built with atomics: the page must be cross-origin isolated
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) return api(req, res, url);
    serveStatic(res, url);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`character editor: http://localhost:${PORT}/`));
