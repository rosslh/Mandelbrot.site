// Forced render-lane switch for the WebGPU lane (bench/LOG.md 2026-11-12,
// backlog G1/G2). Lets the benchmark harness and tests make one build render
// either through the GPU lane wherever it covers a tile (`?lane=gpu`) or
// all-wasm (`?lane=wasm`), and inject a GPU failure (`&gpuFail=shader|lost|
// tile`). Honored only on a local development host, so the deployed site
// ignores both parameters: they are never a user-visible setting.
//
// Read once at module load, before the client strips the share URL.

import type { RenderLane } from "./protocol";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function readForcedLane(): { lane: RenderLane; inject: string | null } | null {
  if (typeof location === "undefined" || !LOCAL_HOSTS.has(location.hostname)) {
    return null;
  }
  const params = new URLSearchParams(location.search);
  const lane = params.get("lane");
  if (lane !== "gpu" && lane !== "wasm") {
    return null;
  }
  return { lane, inject: params.get("gpuFail") };
}

export const forcedRenderLane = readForcedLane();
