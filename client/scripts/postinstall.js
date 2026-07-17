const { spawnSync } = require("child_process");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");

function hasCommand(command, args) {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    shell: false,
  });

  return !result.error && result.status === 0;
}

if (!hasCommand("cargo", ["--version"])) {
  console.warn(
    "Skipping cargo build during npm install: Rust is not installed or not on PATH.",
  );
  console.warn("Install Rust to build the wasm modules and run the app.");
  process.exit(0);
}

const build = spawnSync("cargo", ["build"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: false,
});

process.exit(build.status ?? 1);
