// Builds a named wasm variant into bench/artifacts/<name>/pkg without
// touching the production build config. Rust codegen knobs are injected via
// CARGO_PROFILE_RELEASE_* env vars (wasm-pack --profiling compiles with the
// release profile but skips its own wasm-opt; see mandelbrot/Cargo.toml), and
// wasm-opt runs here with per-variant flags.
//
// Usage:
//   node src/build.mjs <name> [--opt-level s|z|1|2|3] [--lto true|fat|thin|off|false]
//     [--codegen-units N] [--rustflags "..."] [--wasm-opt "<flags>"] [--no-wasm-opt]
//     [--ref <git-ref>]
//
// With no flags, the variant matches production exactly (opt-level=3,
// lto=true, codegen-units=1, wasm-opt -O3 with simd; simd128 rustflags come
// from .cargo/config.toml, which a RUSTFLAGS env var would replace - so
// --rustflags experiments must re-include -C target-feature=+simd128).
//
// --ref builds the crate from a temporary git worktree of the given ref
// instead of the current tree (that ref's own Cargo/.cargo config applies).
// This is how the pinned output ANCHOR (bench/anchor.json) is regenerated
// reproducibly on a new machine: node src/build.mjs anchor --ref <sha>.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(benchDir, "..");
const crateDir = join(repoDir, "mandelbrot");

export const PRODUCTION_DEFAULTS = {
  optLevel: "3",
  lto: "true",
  codegenUnits: "1",
  rustflags: "",
  wasmOpt: "-O3 --enable-simd --enable-mutable-globals",
};

function parseArgs(argv) {
  const opts = { ...PRODUCTION_DEFAULTS, name: null, ref: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--ref":
        opts.ref = argv[++i];
        break;
      case "--opt-level":
        opts.optLevel = argv[++i];
        break;
      case "--lto":
        opts.lto = argv[++i];
        break;
      case "--codegen-units":
        opts.codegenUnits = argv[++i];
        break;
      case "--rustflags":
        opts.rustflags = argv[++i];
        break;
      case "--wasm-opt":
        opts.wasmOpt = argv[++i];
        break;
      case "--no-wasm-opt":
        opts.wasmOpt = null;
        break;
      default:
        if (arg.startsWith("--") || opts.name) {
          throw new Error(`Unexpected argument: ${arg}`);
        }
        opts.name = arg;
    }
  }
  if (!opts.name || !/^[\w-]+$/.test(opts.name)) {
    throw new Error(
      "Usage: node src/build.mjs <name> [--opt-level ...] [--lto ...] " +
        "[--codegen-units ...] [--rustflags ...] [--wasm-opt ...] [--no-wasm-opt]",
    );
  }
  return opts;
}

function toolVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function buildVariant(opts) {
  const pkgDir = join(benchDir, "artifacts", opts.name, "pkg");
  mkdirSync(pkgDir, { recursive: true });

  let sourceCrateDir = crateDir;
  let sourceSha = null;
  let worktree = null;
  if (opts.ref) {
    sourceSha = execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", opts.ref],
      { encoding: "utf8" },
    ).trim();
    worktree = mkdtempSync(join(tmpdir(), `bench-build-${opts.name}-`));
    console.log(`[${opts.name}] building from ${sourceSha} in ${worktree}`);
    execFileSync(
      "git",
      ["-C", repoDir, "worktree", "add", "--detach", worktree, sourceSha],
      { stdio: "inherit" },
    );
    sourceCrateDir = join(worktree, "mandelbrot");
  }

  try {
    return buildVariantFrom(opts, sourceCrateDir, sourceSha);
  } finally {
    if (worktree) {
      execFileSync(
        "git",
        ["-C", repoDir, "worktree", "remove", "--force", worktree],
        { stdio: "inherit" },
      );
    }
  }
}

function buildVariantFrom(opts, sourceCrateDir, sourceSha) {
  const pkgDir = join(benchDir, "artifacts", opts.name, "pkg");

  const env = {
    ...process.env,
    CARGO_PROFILE_RELEASE_OPT_LEVEL: opts.optLevel,
    CARGO_PROFILE_RELEASE_LTO: opts.lto,
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: opts.codegenUnits,
  };
  if (opts.rustflags) {
    env.RUSTFLAGS = opts.rustflags;
  } else {
    delete env.RUSTFLAGS;
  }

  console.log(`[${opts.name}] wasm-pack build --profiling --target web`);
  const build = spawnSync(
    "wasm-pack",
    ["build", "--profiling", "--target", "web", "--out-dir", pkgDir],
    { cwd: sourceCrateDir, env, stdio: "inherit" },
  );
  if (build.status !== 0) {
    throw new Error(`wasm-pack build failed for variant "${opts.name}"`);
  }

  const wasmPath = join(pkgDir, "mandelbrot_bg.wasm");
  const sizeBeforeOpt = statSync(wasmPath).size;

  if (opts.wasmOpt) {
    const wasmOptBin = join(benchDir, "node_modules", ".bin", "wasm-opt");
    if (!existsSync(wasmOptBin)) {
      throw new Error("wasm-opt not found; run `npm ci` in bench/ first");
    }
    const flags = opts.wasmOpt.split(/\s+/).filter(Boolean);
    console.log(`[${opts.name}] wasm-opt ${flags.join(" ")}`);
    const optimize = spawnSync(
      wasmOptBin,
      [...flags, wasmPath, "-o", wasmPath],
      { stdio: "inherit" },
    );
    if (optimize.status !== 0) {
      throw new Error(`wasm-opt failed for variant "${opts.name}"`);
    }
  }

  const wasmSize = statSync(wasmPath).size;
  const meta = {
    name: opts.name,
    builtAt: new Date().toISOString(),
    gitSha: sourceSha ?? toolVersion("git", ["-C", repoDir, "rev-parse", "HEAD"]),
    ...(sourceSha && { builtFromRef: true }),
    flags: {
      optLevel: opts.optLevel,
      lto: opts.lto,
      codegenUnits: opts.codegenUnits,
      rustflags: opts.rustflags,
      wasmOpt: opts.wasmOpt,
    },
    versions: {
      rustc: toolVersion("rustc", ["-V"]),
      wasmPack: toolVersion("wasm-pack", ["-V"]),
      wasmOpt: toolVersion(join(benchDir, "node_modules", ".bin", "wasm-opt"), [
        "--version",
      ]),
    },
    wasmSize,
    wasmSizeBeforeOpt: sizeBeforeOpt,
  };
  writeFileSync(
    join(benchDir, "artifacts", opts.name, "meta.json"),
    JSON.stringify(meta, null, 2) + "\n",
  );

  console.log(
    `[${opts.name}] done: ${(wasmSize / 1024).toFixed(1)} KiB ` +
      `(${(sizeBeforeOpt / 1024).toFixed(1)} KiB before wasm-opt)`,
  );
  return meta;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildVariant(parseArgs(process.argv.slice(2)));
}
