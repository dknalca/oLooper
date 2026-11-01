// Run from any directory: node /path/to/oLooper/promo/serve.mjs
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".mp3": "audio/mpeg" };
createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = resolve(root, `.${path.endsWith("/") ? path + "index.html" : path}`);
    const allowed = ["promo", "docs/screenshots", "src-tauri/icons"].some((folder) => file.startsWith(resolve(root, folder) + sep));
    if (!allowed) { response.writeHead(403).end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-cache" });
    createReadStream(file).pipe(response);
  } catch { response.writeHead(404).end(); }
}).listen(4173, "127.0.0.1", () => console.log("Promo: http://localhost:4173/promo/"));
