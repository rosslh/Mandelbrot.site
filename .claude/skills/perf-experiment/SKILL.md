---
name: perf-experiment
description: Run WebAssembly-in-Chrome performance experiments for Mandelbrot tile generation - build wasm variants with alternative compiler/optimizer flags, benchmark them against a baseline across real and synthetic workloads, verify correctness, and apply measured winners to the production config. Use when asked to optimize tile generation, wasm performance, or run/interpret benchmarks.
---

# Mandelbrot wasm performance experiments

All benchmarking lives in `bench/` (own package.json; run `npm ci` there once).
There are three runners, in decreasing order of realism:

1. **`src/run-e2e.mjs` — THE STANDARD TEST; every experiment's final verdict
   must come from this.** Drives the actual built client (webpack bundle,
   real wasm, real Leaflet, real `threads` pool, real service worker) in
   Chrome via puppeteer, loads a shareable URL per corpus case
   (corpus/grid-regression.json), and measures wall-clock time from
   navigation to the last visible tile's done callback. Variants are complete
   client builds made by `src/build-dist.mjs <name> [--ref <git-ref>]`, so a
   comparison includes every shipped difference (client JS such as pool
   sizing, service worker, wasm). To isolate one change, build both dists
   from trees differing only in that change.
2. `src/run-grid.mjs` — wasm-level, full visible tile grid on a real worker
   pool (pool size held constant across variants); use to iterate on wasm
   changes with grid-level realism but without client-build turnaround.
3. `src/run.mjs` — wasm-level, single tile per case, main thread; fastest
   iteration and pathway isolation across the full corpus
   (corpus/corpus.json). Calls `get_mandelbrot_image_precise` with the exact
   argument shape the production worker uses (client/js/worker.js).

The wasm-level runners (2, 3) exist because they are fast and isolate the
wasm; they are not the ship gate. A change ships only after run-e2e confirms
it on real client builds.

## Architecture you must know before interpreting numbers

Rendering pathway is selected on `effective_zoom = tile_zoom + zoom_offset`
(thresholds in mandelbrot/src/perturbation.rs):

| pathway | effective zoom | what runs |
|---|---|---|
| `direct` | < 47 | plain f64 escape loop |
| `perturbation-f64` | 47–249 | arbitrary-precision (dashu) reference orbit + f64 pixel deltas |
| `float-exp` | >= 250 | reference orbit + ComplexExp extended-exponent deltas |

- The reference orbit is cached thread-locally per (origin, exponent,
  precision). The runner reports the first call per case as **cold** (includes
  orbit computation) and warm samples separately. Cold times matter for
  first-tile latency when a user pans/zooms to a new region.
- Production config (as of 2026-07): `opt-level = 3` (root Cargo.toml) +
  `-C target-feature=+simd128` (.cargo/config.toml, wasm target only) +
  `wasm-opt -O3 --enable-simd` (mandelbrot/Cargo.toml). This was measured at
  -9.6% on float-exp tiles vs the previous size-tuned config
  (opt-level=s/-Oz); the wasm is ~277 KiB and every visitor downloads it, so
  **every speed claim must also report the size delta** (compare output
  includes it). simd128 sets the browser floor at Safari 16.4 / Chrome 91 /
  Firefox 89 - do not add wasm features beyond simd128 without flagging the
  compat change.

## Workflow

Iterate with the wasm-level runners, then confirm with the standard e2e test:

```sh
cd bench
npm ci                                   # once
node src/build.mjs baseline              # no flags = exact production settings
node src/build.mjs myexp --opt-level s --wasm-opt "-Oz --enable-simd --enable-mutable-globals"
node src/run.mjs --variants baseline,myexp        # fast iteration
node src/run-grid.mjs --variants baseline,myexp   # grid realism (worker pool)

# Final verdict — real client builds, end to end:
node src/build-dist.mjs base-dist --ref HEAD      # or a pre-change ref
node src/build-dist.mjs exp-dist                  # current tree (applies your change)
node src/run-e2e.mjs --variants base-dist,exp-dist
```

run-e2e measures navigation → last tile done on the real client (includes
bundle parse, worker spawn, wasm compile/tier-up — cold passes catch Liftoff
tiering penalties that warm wasm-level numbers hide). Its cases live in
corpus/grid-regression.json; `--viewport WxH` (default 1600x900), `--rounds`,
`--warmup`, `--filter` as usual. Each variant's dist is served on its own
origin; off-localhost requests are blocked so no telemetry fires.

- `run.mjs` writes JSON to `bench/results/` and prints the comparison
  (per-case medians, per-pathway + overall geomean, size delta, cold times).
  `node src/compare.mjs <results.json>` re-prints it.
- Useful runner flags: `--filter <id-substring|pathway>` (e.g. `--filter
  float-exp`, `--filter syn-`), `--samples N` (default 10), `--warmup N`
  (default 3), `--budget-ms N` (per case x variant cap, default 15000).
- Variants live in `bench/artifacts/<name>/` with a `meta.json` recording
  flags, tool versions, git sha, and wasm size. Rebuild after any Rust change
  — artifacts do not track the source tree.

### build.mjs knobs

| flag | maps to | production value |
|---|---|---|
| `--opt-level s\|z\|1\|2\|3` | `CARGO_PROFILE_RELEASE_OPT_LEVEL` | `3` |
| `--lto true\|fat\|thin\|off` | `CARGO_PROFILE_RELEASE_LTO` | `true` (= fat) |
| `--codegen-units N` | `CARGO_PROFILE_RELEASE_CODEGEN_UNITS` | `1` |
| `--rustflags "..."` | `RUSTFLAGS` | (empty; simd128 comes from .cargo/config.toml) |
| `--wasm-opt "<flags>"` / `--no-wasm-opt` | post-build binaryen pass | `-O3 --enable-simd --enable-mutable-globals` |

Experiments never edit production config: variant builds go through
`wasm-pack build --profiling` (release profile, wasm-opt disabled via
mandelbrot/Cargo.toml metadata) with env-var overrides, then bench's own
wasm-opt. **Gotcha:** a `--rustflags` value replaces the `.cargo/config.toml`
rustflags entirely, so it must re-include `-C target-feature=+simd128` (and
keep `--enable-simd` in the wasm-opt flags) to stay comparable to production.

## Prioritizing experiments and judging trade-offs

**Weight by absolute wall-time saved, not percentages.** Cutting a render
from 30 s to 20 s is worth 10x more than cutting one from 3 s to 2 s. Before
picking an experiment, rank the e2e corpus cases by absolute time and target
the slowest; rank them *within each pathway tier* (conventional `direct` vs
arbitrary-precision `perturbation-f64`/`float-exp`) so a slow deep-zoom tier
is not masked by fast direct cases, and each tier's worst case gets attention.
A small regression on a millisecond-scale case is an acceptable price for
seconds off a heavyweight case — say so explicitly in the log rather than
letting a geomean average it away.

**Decompose before you optimize.** Attribute the slow case's time with a
direct measurement (e.g. run.mjs's cold-vs-warm split separates
reference-orbit computation from per-pixel loops) before choosing a fix.
Lesson learned: deep-zoom loads were assumed "orbit-dominated" from indirect
e2e reasoning and orbit sharing was promoted to top priority; a 2-minute
cold/warm probe showed the orbit was ~18 ms and the ComplexExp pixel loops
were ~1300 ms — the fix that followed cut the case by 85%.

**Re-audit old verdicts when criteria change.** A "failed" or "deprioritized"
verdict is only as good as the metric it was judged on; when the weighting or
the corpus changes, re-check whether any settled question flips.

## Interpreting results

- A per-case difference is significant (`*`) when it clears
  `max(3%, 2*(MAD_a + MAD_b)/median_a)`. Judge experiments primarily on
  **absolute time deltas on the slowest cases per pathway tier** (see above),
  with the overall and per-pathway geomeans as secondary regression guards.
- Variants are interleaved within one Chrome session, so thermal drift hits
  both sides. Still: run on AC power, close heavy apps, and re-run close calls
  (within ~2x the threshold) with `--samples 15` before believing them.
- Never trust a single run near the 3% floor. An A/A run
  (`node src/build.mjs baseline2 && node src/run.mjs --variants baseline,baseline2`)
  tells you the current machine's noise floor.
- Watch `direct` vs deep pathways separately: direct is pure f64 loop code;
  the deep pathways also exercise dashu bignum (cold) and delta loops (warm).

## Code-change (algorithmic) experiments

The harness is not just for compiler flags — data-structure and algorithm
changes in the Rust crate (mandelbrot/src/lib.rs, perturbation.rs,
float_exp.rs) are benchmarked the same way. The one extra rule: **build the
baseline artifact from the clean tree before editing any Rust code.**
Artifacts snapshot the source at build time, so afterwards you can iterate on
the code and rebuild only the experiment variant:

```sh
node src/build.mjs baseline        # BEFORE touching the Rust code
# ... edit mandelbrot/src/... ...
node src/build.mjs myalgo          # same flags as production, new code
node src/run.mjs --variants baseline,myalgo
```

(If the tree is already dirty, build the baseline from a stash or a git
worktree of HEAD.) Rebuild the variant after every code tweak — artifacts do
not track the tree. Use `--filter` to iterate quickly on the pathway you're
changing, then do a full-corpus run before drawing conclusions: algorithmic
changes often trade one pathway against another, and corpus pairs (tileSize,
smoothColoring, multibrot exponent) exist precisely to isolate those costs.
Correctness gate for code changes is `cargo test`, not pixel-check (see
below).

## Correctness gates (mandatory before applying any winner)

- **Flag-only change** (opt-level, lto, wasm-opt, codegen-units):
  `node src/pixel-check.mjs --a baseline --b <variant>` must report all cases
  byte-identical. Float reassociation (e.g. ffast-math-style RUSTFLAGS) can
  legitimately change pixels — treat any diff as a red flag and only accept it
  deliberately with `--allow-diff` plus a written justification.
- **Rust code change**: `cargo test` must pass (insta snapshot suite). Use
  `cargo insta test --accept` only when the visual diff is understood and
  intended. Then rebuild the variant and re-run the benchmark.

## Applying a winner

1. Edit the real config: root `Cargo.toml` `[profile.release]`,
   `.cargo/config.toml` (wasm rustflags), and/or
   `[package.metadata.wasm-pack.profile.release] wasm-opt = [...]` in
   mandelbrot/Cargo.toml. Keep `bench/src/build.mjs` `PRODUCTION_DEFAULTS`
   in sync so a no-flag build stays a true baseline.
2. Rebuild production: `cd client && npm run build`; record the production
   wasm size before/after (client/dist `*.wasm`).
3. **Confirm end to end (mandatory):** `node src/build-dist.mjs pre --ref
   <sha-before-change> && node src/build-dist.mjs post && node src/run-e2e.mjs
   --variants pre,post`. The win must survive on real client builds,
   including cold passes. A wasm-level win that disappears or regresses cold
   starts here does not ship without a written justification in LOG.md.
4. Append the entry to `bench/LOG.md` and commit with the numbers: e2e
   deltas (warm and cold), wasm-level geomean delta per pathway, size delta,
   and how to reproduce.

## Workload corpus

`bench/corpus/corpus.json`: synthetic cases (`syn-*`) guarantee coverage of
all three pathways using exact boundary points (cardioid cusp `0.25`,
dendrite `i`, needle `-2`) that stay meaningful at any zoom depth, plus
tileSize and smoothColoring pairs. User cases (`user-*`) come from a Supabase
`events` export via `node src/ingest.mjs <export.csv> --write` (validates,
dedupes, buckets by pathway x iteration tercile, samples a few per bucket).
An export is checked out at the repo root as `events_rows.csv` (~24k rows:
id, created_at, share_url, re, im, zoom, iterations, event_name,
session_id) — use it for ingest, frequency weighting, or finding real slow
views; never copy session_ids or share URLs into committed corpus rows.
Keep the corpus small enough that a two-variant run finishes in minutes.

When adding or choosing cases, **favor views with many border pixels** —
pixels close to but outside the set, escaping at high-but-not-max counts.
That is where users park and where the real work is (interior-heavy tiles
short-circuit via rect_in_set/periodicity; low-iteration exteriors are
cheap). Verify a candidate's composition with a small offline probe (interior
fraction, escaper mean/p90) before trusting it, and keep each pathway tier
represented by its realistic worst case.

## Experiment log — read it first, then append to it

**`bench/LOG.md` is the durable record of every experiment.** Check it before
starting so you don't re-run a settled question (headline so far: the flag
space without code changes is exhausted — everything non-SIMD measured within
±1%; opt3+simd128 shipped at −9.6% float-exp). After every experiment —
win, loss, or inconclusive — append an entry: date, machine, exact flags or
code change, per-pathway geomean deltas, size delta, verdict. Raw results
JSONs are gitignored and machine-local; the log is what survives.

## Experiment backlog (ranked by absolute time on the slowest e2e cases per tier)

1. Perturbation-f64 delta-loop batching/refill (perturbation.rs): z48/i20000
   is now the slowest standard e2e case (~3.4 s). The pf64 pathway still uses
   the 2-wide paired loop, which pays max-of-pair; the direct pathway's
   lane-refill stream kernel (−44% there) is the template. Measure first —
   scalar-index orbit lookups (no wasm gather) are the complication.
2. Float-exp big-phase SIMD (perturbation.rs): after the 2026-07-07 hybrid
   ship, float-exp pixels spend most iterations in a *scalar* plain-f64 loop
   (z259 grid ≈ 2.4 s e2e). Routing the f64 phase through the pair/refill
   machinery could roughly halve it again. Mode switches are per-pixel
   mid-flight, so lanes need per-lane demote handling.
3. Ultra-deep small-mode cost: at effective zoom ≳ 400 the hybrid's
   ComplexExp phase dominates again (syn-fexp-z500-needle −58% not −85%;
   syn-fexp-z500-cusp-hi +2.5% — near-parabolic pixels never promote).
   Options: cheaper ComplexExp step, or a rescaled-f64 epoch loop
   (Fraktaler-style). Only worth it if user data shows z400+ traffic.
4. ~~Orbit cache sharing across worker threads~~ **DEMOTED 2026-07-07**: the
   "orbit-dominated deep-zoom loads" claim (LOG 2026-07-04) was a
   misattribution — a cold/warm probe showed the z259 orbit costs ~18 ms per
   worker vs ~1300 ms of per-pixel ComplexExp work (fixed by the hybrid
   loop). Sharing would save ~18 ms × workers on first view; revisit only if
   very high iteration counts (long orbits) at depth show up in user data.
5. Smooth-coloring cost: already measurable via the
   `syn-pf64-z100-dendrite[-nosmooth]` pair; optimize only if it exceeds
   5–10% of tile time.
6. dashu precision headroom (perturbation.rs: `(zoom + 64) -> 32-bit`
   granularity): affects cold times only; correctness-sensitive.
7. `panic = "abort"` in release profile: trivial; verify wasm-bindgen still
   works.

Shipped milestones: manual f64x2 pixel pairing + tier-up warmup (2026-07-04,
−16.8% e2e; **standing rule: hand-written SIMD hot loops ship only with a
tier-up warmup and an e2e cold-pass check**); quad batching + interior checks
(2026-07-06); lane-refill stream kernel + Mariani–Silver (2026-07-07); hybrid
f64/ComplexExp float-exp loop (2026-07-07, z259 e2e −84.7%).
