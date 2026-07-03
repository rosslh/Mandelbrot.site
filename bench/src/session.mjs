// Shared Chrome session setup for run.mjs and pixel-check.mjs: starts the
// static server, launches pinned Chrome for Testing, and loads one wasm
// module instance per variant into the bench page.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { startServer } from "./server.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function readVariantMeta(name) {
  const metaPath = join(benchDir, "artifacts", name, "meta.json");
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    throw new Error(
      `Variant "${name}" not built (missing ${metaPath}); run: node src/build.mjs ${name} [flags]`,
    );
  }
}

export async function startSession(variantNames) {
  const { server, port } = await startServer();
  const browser = await puppeteer.launch({
    args: [
      "--js-flags=--expose-gc",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      ...(process.env.CI ? ["--no-sandbox"] : []),
    ],
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("[page error]", error));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("[page]", message.text());
  });

  await page.goto(`http://127.0.0.1:${port}/bench/page/index.html`);
  await page.evaluate(() => window.benchReady);
  const loaded = await page.evaluate(
    (urls) => window.loadVariants(urls),
    variantNames.map((name) => `/bench/artifacts/${name}/pkg/mandelbrot.js`),
  );
  if (!loaded.crossOriginIsolated) {
    console.warn("Warning: page is not crossOriginIsolated; timer resolution is 100us");
  }

  return {
    page,
    chromeVersion: await browser.version(),
    close: async () => {
      await browser.close();
      server.close();
    },
  };
}
