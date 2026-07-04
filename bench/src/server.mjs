// Minimal static server. Two uses:
// - bench page + wasm artifacts (default): rooted at the repo, with COOP/COEP
//   headers so the page is crossOriginIsolated, which raises
//   performance.now() resolution from 100us to 5us.
// - a built client dist (run-e2e.mjs): rooted at the dist directory, WITHOUT
//   COOP/COEP to match how production serves the site.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".map": "application/json",
};

export function startServer({ root = repoDir, crossOriginIsolate = true } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    if (pathname === "/favicon.ico" && !existsSync(join(root, pathname))) {
      response.writeHead(204);
      response.end();
      return;
    }
    const filePath = normalize(join(root, pathname));
    if (
      !filePath.startsWith(root + sep) ||
      !existsSync(filePath) ||
      !statSync(filePath).isFile()
    ) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    const headers = {
      "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    };
    if (crossOriginIsolate) {
      headers["Cross-Origin-Opener-Policy"] = "same-origin";
      headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    }
    response.writeHead(200, headers);
    createReadStream(filePath).pipe(response);
  });

  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({ server, port: server.address().port });
    });
  });
}
