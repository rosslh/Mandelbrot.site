// Reports what GPU the benchmark Chrome actually gets, so a GPU timing is
// never taken on a software rasterizer by accident. Headless Chrome can fall
// back to SwiftShader (WebGL) or a fallback WebGPU adapter, and either would
// make GPU numbers meaningless while still "working".
//
// Launches puppeteer with the same flags as run-e2e.mjs (plus any extra
// Chrome flags given after `--`), loads a localhost page (WebGPU needs a
// secure context), and prints:
// - navigator.gpu presence, adapter info (vendor, architecture, device,
//   isFallbackAdapter), optional features (shader-f16, timestamp-query, ...)
//   and the limits that matter for tile compute;
// - the WebGL2 unmasked renderer string;
// - one timed compute dispatch (a 256x256 f32 escape loop, readback included)
//   to prove the adapter executes work, not just enumerates.
//
// Exits non-zero when WebGPU is missing or the adapter is a fallback/software
// one, so a runner can refuse to time a GPU variant on it.
//
// Usage: node src/gpu-probe.mjs [--json] [-- <extra chrome flags>]
//
// run-e2e.mjs imports probeGpu() and runs the same probe inside the browser
// it times with, so every e2e result records the adapter it ran on.

import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";
import { startServer } from "./server.mjs";

const PROBE = async () => {
  const out = { webgpu: null, webgl: null, dispatch: null };

  try {
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      out.webgl = {
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      };
    }
  } catch (error) {
    out.webgl = { error: String(error) };
  }

  if (!("gpu" in navigator)) return out;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    out.webgpu = { available: false };
    return out;
  }
  const info = adapter.info ?? {};
  out.webgpu = {
    available: true,
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? false,
    features: [...adapter.features].sort(),
    limits: {
      maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
      maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
    // Tiles render in dedicated workers, so a GPU lane needs WebGPU there.
    workerAvailable: await new Promise((resolve) => {
      const source = "self.postMessage('gpu' in navigator && !!navigator.gpu)";
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
      worker.onmessage = (event) => {
        resolve(event.data);
        worker.terminate();
      };
      worker.onerror = () => resolve(false);
    }),
  };

  const device = await adapter.requestDevice();
  const size = 256;
  const maxIter = 1000;
  const module = device.createShaderModule({
    code: `
      @group(0) @binding(0) var<storage, read_write> out: array<u32>;
      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        if (id.x >= ${size}u || id.y >= ${size}u) { return; }
        let c = vec2<f32>(-2.0 + 2.5 * f32(id.x) / ${size}.0, -1.25 + 2.5 * f32(id.y) / ${size}.0);
        var z = vec2<f32>(0.0, 0.0);
        var i = 0u;
        loop {
          if (i >= ${maxIter}u || dot(z, z) > 4.0) { break; }
          z = vec2<f32>(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
          i = i + 1u;
        }
        out[id.y * ${size}u + id.x] = i;
      }`,
  });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const bytes = size * size * 4;
  const storage = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: storage } }],
  });

  const run = async () => {
    const start = performance.now();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(size / 8, size / 8);
    pass.end();
    encoder.copyBufferToBuffer(storage, 0, readback, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Uint32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    return { ms: performance.now() - start, values };
  };

  const first = await run();
  const timings = [];
  let iterationSum = 0;
  for (let i = 0; i < 5; i++) {
    const result = await run();
    timings.push(result.ms);
    iterationSum = result.values.reduce((sum, v) => sum + v, 0);
  }
  timings.sort((a, b) => a - b);
  out.dispatch = {
    pixels: size * size,
    maxIterations: maxIter,
    firstMs: first.ms,
    medianMs: timings[2],
    iterationSum,
  };
  device.destroy();
  return out;
};

const SOFTWARE = /swiftshader|llvmpipe|software|basic render/i;

// True when the report shows a hardware WebGPU adapter (not a fallback
// adapter, not a software rasterizer behind WebGPU or WebGL).
export function isHardwareWebGPU(report) {
  const gpu = report.webgpu;
  return (
    gpu?.available === true &&
    !gpu.isFallbackAdapter &&
    !SOFTWARE.test(`${gpu.vendor} ${gpu.architecture} ${gpu.description}`) &&
    !SOFTWARE.test(report.webgl?.renderer ?? "")
  );
}

// Runs the probe in a fresh page of an already-launched browser, on its own
// localhost origin (the bench page server), so it shares no cache or
// service worker with the origins a runner times. Closes the page and the
// server before returning.
export async function probeGpu(browser) {
  const server = await startServer();
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.port}/bench/page/index.html`);
    const report = await page.evaluate(PROBE);
    report.chrome = await browser.version();
    report.hardwareWebGPU = isHardwareWebGPU(report);
    return report;
  } finally {
    await page.close();
    server.server.close();
  }
}

// One-line adapter summary for logs and result metadata.
export function describeAdapter(report) {
  const gpu = report.webgpu;
  if (!gpu) return "navigator.gpu missing";
  if (!gpu.available) return "no adapter";
  return (
    `${gpu.vendor} / ${gpu.architecture}${gpu.description ? ` (${gpu.description})` : ""}` +
    `${gpu.isFallbackAdapter ? " [FALLBACK ADAPTER]" : ""}`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const dashIndex = argv.indexOf("--");
  const extraFlags = dashIndex >= 0 ? argv.slice(dashIndex + 1) : [];
  const ownArgs = dashIndex >= 0 ? argv.slice(0, dashIndex) : argv;
  const asJson = ownArgs.includes("--json");

  const browser = await puppeteer.launch({
    args: [
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      ...(process.env.CI ? ["--no-sandbox"] : []),
      ...extraFlags,
    ],
  });

  let report;
  try {
    report = await probeGpu(browser);
    report.extraFlags = extraFlags;
  } finally {
    await browser.close();
  }

  const gpu = report.webgpu;
  const hardware = report.hardwareWebGPU;
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Chrome: ${report.chrome}${extraFlags.length ? ` (extra flags: ${extraFlags.join(" ")})` : ""}`);
    console.log(`WebGL2 renderer: ${report.webgl?.renderer ?? report.webgl?.error ?? "unavailable"}`);
    if (!gpu || !gpu.available) console.log(`WebGPU: ${describeAdapter(report)}`);
    else {
      console.log(`WebGPU adapter: ${describeAdapter(report)}`);
      console.log(`  features: ${gpu.features.join(", ") || "(none)"}`);
      console.log(`  limits: ${JSON.stringify(gpu.limits)}`);
      console.log(`  WebGPU in workers: ${gpu.workerAvailable}`);
    }
    if (report.dispatch) {
      const d = report.dispatch;
      console.log(
        `Dispatch (${d.pixels} px, ${d.maxIterations} max iter, readback incl.): first ${d.firstMs.toFixed(1)} ms, ` +
          `median ${d.medianMs.toFixed(2)} ms, iteration sum ${d.iterationSum}`,
      );
    }
    console.log(hardware ? "OK: hardware WebGPU adapter." : "NOT OK: no hardware WebGPU adapter; do not time GPU variants.");
  }
  process.exit(hardware ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
