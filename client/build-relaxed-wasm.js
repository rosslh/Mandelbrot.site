// Builds the relaxed-SIMD (hardware FMA) wasm artifact into
// ../mandelbrot/pkg-relaxed before webpack runs. The worker feature-detects
// relaxed SIMD at runtime and imports this pkg on engines that support it
// (Chrome 114+/Firefox 125+); Safari has no relaxed-simd at any version and
// gets the byte-exact simd128 build from ../mandelbrot/pkg (built by
// @wasm-tool/wasm-pack-plugin during the webpack compilation, exactly as
// before the dual build).
//
// The relaxed build differs from the fallback only in RUSTFLAGS: a RUSTFLAGS
// env var replaces .cargo/config.toml's rustflags entirely, so it must
// re-include +simd128. Same wasm-pack --release pipeline as production has
// always used; mandelbrot/Cargo.toml's wasm-opt metadata carries
// --enable-relaxed-simd for both builds (byte-identical on the fallback).
//
// Output policy: the relaxed kernel's output is float-rounding-class
// different from the fallback (hardware FMA in the quadratic escape loop).
// It ships under the anchor-relative statistical-equivalence gate, not
// byte-exactness - see bench/LOG.md 2026-07-10 and bench/src/tolerance.mjs.

const { spawnSync } = require("child_process");
const path = require("path");

const crateDir = path.resolve(__dirname, "..", "mandelbrot");

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false,
  });

  return !result.error && result.status === 0;
}

if (!commandExists("wasm-pack")) {
  console.error(
    "wasm-pack is not installed or not on PATH. Install Rust and wasm-pack, then rerun npm run dev.",
  );
  process.exit(1);
}

const result = spawnSync(
  "wasm-pack",
  ["build", "--release", "--out-dir", "pkg-relaxed"],
  {
    cwd: crateDir,
    stdio: "inherit",
    env: {
      ...process.env,
      RUSTFLAGS: "-C target-feature=+simd128,+relaxed-simd",
    },
  },
);

if (result.status !== 0) {
  if (result.error && result.error.code === "ENOENT") {
    console.error(
      "wasm-pack could not be started. Install Rust/wasm-pack and reopen your terminal so PATH updates.",
    );
  } else {
    console.error("relaxed-simd wasm build failed");
  }
  process.exit(result.status ?? 1);
}
