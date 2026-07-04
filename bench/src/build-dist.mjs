// Builds a complete production client (webpack bundle + wasm via
// WasmPackPlugin --release + service worker) into bench/artifacts/<name>/dist
// for run-e2e.mjs. This is the REAL shipped artifact: whatever build config,
// client code, and wasm the given tree produces.
//
// Usage:
//   node src/build-dist.mjs <name>              # current tree (client/ must have node_modules)
//   node src/build-dist.mjs <name> --ref <git-ref>   # historical build via temp worktree
//
// --ref creates a temporary git worktree, runs `npm ci --ignore-scripts` +
// `npm run build` in its client/ (WasmPackPlugin builds the crate with that
// ref's own Cargo/.cargo config, so historical wasm flags apply), then copies
// dist and removes the worktree. Rust code changes in the CURRENT tree are
// picked up by the no-ref form, which runs `npm run build` in client/ and
// therefore also refreshes client/dist in place (same as a deploy build).

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(benchDir, "..");

function parseArgs(argv) {
  const opts = { name: null, ref: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ref") opts.ref = argv[++i];
    else if (arg.startsWith("--") || opts.name) throw new Error(`Unexpected argument: ${arg}`);
    else opts.name = arg;
  }
  if (!opts.name || !/^[\w-]+$/.test(opts.name)) {
    throw new Error("Usage: node src/build-dist.mjs <name> [--ref <git-ref>]");
  }
  return opts;
}

function run(command, args, cwd) {
  console.log(`[${cwd}] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let sourceDir = repoDir;
  let worktree = null;

  if (opts.ref) {
    worktree = mkdtempSync(join(tmpdir(), `bench-dist-${opts.name}-`));
    run("git", ["-C", repoDir, "worktree", "add", "--detach", worktree, opts.ref], repoDir);
    sourceDir = worktree;
  }

  try {
    const clientDir = join(sourceDir, "client");
    if (opts.ref) {
      // --ignore-scripts skips the postinstall `cargo build`; WasmPackPlugin
      // builds the wasm itself during webpack.
      run("npm", ["ci", "--ignore-scripts"], clientDir);
    }
    run("npm", ["run", "build"], clientDir);

    const gitSha = execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const outDir = join(benchDir, "artifacts", opts.name);
    const distDir = join(outDir, "dist");
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    cpSync(join(clientDir, "dist"), distDir, { recursive: true });

    const wasmFiles = Object.fromEntries(
      readdirSync(distDir)
        .filter((file) => file.endsWith(".wasm"))
        .map((file) => [file, statSync(join(distDir, file)).size]),
    );
    const meta = {
      name: opts.name,
      kind: "dist",
      builtAt: new Date().toISOString(),
      ref: opts.ref ?? "(current tree)",
      gitSha,
      wasmFiles,
      // Largest .wasm in dist is the mandelbrot module (the other is oxipng).
      wasmSize: Math.max(...Object.values(wasmFiles)),
    };
    writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    console.log(
      `[${opts.name}] dist ready: ${Object.entries(wasmFiles)
        .map(([file, size]) => `${file} ${(size / 1024).toFixed(1)} KiB`)
        .join(", ")}`,
    );
  } finally {
    if (worktree) {
      run("git", ["-C", repoDir, "worktree", "remove", "--force", worktree], repoDir);
    }
  }
}

main();
