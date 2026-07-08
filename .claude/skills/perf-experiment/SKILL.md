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

# Algorithmic winners additionally pass the holdout ship gate before applying
# (fresh sample from the events export; see "Holdout validation" below):
node src/validate.mjs --variants baseline,myexp
node src/validate.mjs --variants baseline,myexp --pixel-check   # if any accepted diff
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
- **Drift detector (either kind of change):** `node src/enrich.mjs --check
  <variant>` re-probes every corpus case and compares the values buffer
  against the committed blessed hashes (`stats.valuesHash`) — catches output
  changes that snuck in across experiments. Intentional changes are
  re-blessed with `--check <variant> --bless` plus a LOG.md justification.

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
   For algorithmic winners, also pass the holdout gate first:
   `node src/validate.mjs --variants <pre>,<post>` (plus `--pixel-check` if
   any output diff was accepted) — see "Holdout validation" below.
4. Append the entry to `bench/LOG.md` and commit with the numbers: e2e
   deltas (warm and cold), wasm-level geomean delta per pathway, size delta,
   and how to reproduce.

## Workload corpus

`bench/corpus/corpus.json`: synthetic cases (`syn-*`) guarantee coverage of
all three pathways using exact boundary points (cardioid cusp `0.25`,
dendrite `i`, needle `-2`) that stay meaningful at any zoom depth, plus
tileSize and smoothColoring pairs. User cases (`user-*`) come from a Supabase
`events` export via `node src/ingest.mjs <export.csv> --artifact <name>
--write`. Ingest validates and dedupes the rows, **probes every surviving
candidate at 64x64 through the wasm** (enrich.mjs; interior fraction,
near-max escaper fractions, escaper mean/p50/p90/p99, total iteration sum),
then selects per pathway tier by composition/cost: heaviest views by
iteration sum, border-heavy views by near-max escaper fraction, the
most-frequented view, plus one coverage pick per distinctive composition
class (in-set, interior-heavy, trapped/throughput, multibrot, low-iter).
The raw `iterations` parameter is deliberately not the work proxy — a
50k-iteration empty-exterior view is cheap, a 1k-iteration trapped channel
is not. Review the printed old-vs-new selection report before `--write`.
An export is checked out at the repo root as `events_rows.csv` (~24k rows:
id, created_at, share_url, re, im, zoom, iterations, event_name,
session_id) — use it for ingest, frequency weighting, or finding real slow
views; never copy session_ids or share URLs into committed corpus rows.
Keep the corpus small enough that a two-variant run finishes in minutes.

Each written corpus row carries a generated `stats` block (probe composition
+ iteration sum + provenance: generator version, artifact sha, date) and a
`weight` block (distinct sessions + recency-decayed user frequency). Stats
are **generated, never hand-edited** — re-run `node src/enrich.mjs --write`
(or ingest) to refresh them; unchanged stats keep their provenance so
re-runs are idempotent. Hand-maintained `note` text, `overrides`, and
`pinned` rows are always preserved: set `"pinned": true` on a hand-added
case to exempt it from selection pressure. `stats.valuesHash` is the blessed
FNV-1a hash of the probe's values buffer; `node src/enrich.mjs --check
<variant>` re-probes and reports output drift (the re-bless flow for an
intentional output change is `--check <variant> --bless`, justified in
LOG.md). Composition stats and iteration sums are variant-invariant (escape
counts are the correctness invariant) and safe to commit; probe wall times
are machine-dependent and never committed.

When adding or choosing cases, **favor views with many border pixels** —
pixels close to but outside the set, escaping at high-but-not-max counts.
That is where users park and where the real work is (interior-heavy tiles
short-circuit via rect_in_set/periodicity; low-iteration exteriors are
cheap). The probe stats make this checkable; keep each pathway tier
represented by its realistic worst case. Heavy cases may carry a `tileSize`
override (100 or 64) so a sample fits the per-case budget: per-pixel cost is
size-invariant, so relative deltas are preserved (ingest suggests the
override automatically from the probe time). run.mjs scales each case's
iteration sum to its tileSize and prints **ms per million iterations** next
to the median — watch that column: a case whose ms/Miter is far off its
pathway's norm is structurally slow for a reason iteration counts don't
explain (this is what would have caught the z259 ComplexExp misattribution
immediately). compare.mjs prints composition columns (interior %, near-max
%) plus time-weighted and user-frequency-weighted delta summaries alongside
the geomeans.
What the export says about real usage (probed 2026-07-07): the pf64 tier is
effectively all z47–59 (one lone view past z60), there is exactly one
float-exp view (z259), and the slowest real views are 25k–50k-iteration
pf64 tiles — including an exponent-52 view (~60 s/tile at 200px) where the
O(exponent) Horner delta step, not the iteration count, is the cost.

### Holdout validation (anti-overfitting ship gate)

The fixed corpus is what you iterate against, and that also makes it easy to
overfit: tuned constants and accepted trade-offs are only ever validated on
its ~40 views. Before shipping an algorithmic winner — especially one with
tuned thresholds (e.g. the hybrid promote/floor exponents) or deliberately
accepted pixel diffs — validate against a *fresh* sample with
`src/validate.mjs`:

```sh
node src/validate.mjs --variants baseline,myexp            # timing gate
node src/validate.mjs --variants baseline,myexp --pixel-check   # output gate
```

It dedupes events_rows.csv, excludes views already in corpus.json,
stratified-samples `--per-tier N` (default 40) per pathway tier with a
seeded RNG, and runs a/b like run.mjs at low sample count
(`--samples 3`, `--budget-ms 8000`, tiles at `--tile-size 100` — per-pixel
cost is size-invariant, so relative deltas are preserved while heavyweight
views stay in budget). The default seed derives from today's date: a rerun
the same day reproduces, but each experiment gets a fresh sample so the
holdout does not become a second training set (pin `--seed` only to
reproduce a specific run). It reports per-tier geomeans, the worst movers,
and a time-weighted delta (weighted by variant-a median ms). Judge on those
aggregates: the measured A/A noise floor (2026-07-08) is <=0.1% on every
aggregate, but at `--samples 3` individual sub-millisecond views can
false-flag up to ~6% — re-run a suspicious single mover with `--samples 10`
before believing it. Run
`--pixel-check` (byte-diffs the two variants' output on the holdout) whenever
the change has any accepted output diff — artifact classes can hide on view
shapes the fixed corpus lacks. The fixed corpus stays the fast iteration
target; the holdout is a ship gate, paid once per experiment. Note the
export's tier skew: the float-exp tier has ~1 real view (already in the
corpus), so the float-exp holdout is empty — synthetic corpus cases remain
the only deep-zoom guard.

## Experiment log — read it first, then append to it

**`bench/LOG.md` is the durable record of every experiment.** Check it before
starting so you don't re-run a settled question (headline so far: the flag
space without code changes is exhausted — everything non-SIMD measured within
±1%; opt3+simd128 shipped at −9.6% float-exp). After every experiment —
win, loss, or inconclusive — append an entry: date, machine, exact flags or
code change, per-pathway geomean deltas, size delta, verdict. Raw results
JSONs are gitignored and machine-local; the log is what survives.

## Experiment backlog (ranked by absolute time on the slowest e2e cases per tier)

**Items 1–4 are the priority queue for upcoming experiments** (set
2026-07-08): the corpus expansion added the first heavyweight pf64 cases
(25k–50k iterations, trapped/border-band/in-set compositions), and several
shipped verdicts were only ever measured without them. Re-validate before
building anything new on those verdicts.

1. **A/A noise floor on the new heavy cases** (prerequisite, ~minutes):
   `baseline` vs `baseline2` over the 2026-07-08 additions. Their budget
   caps trim samples to ~4 instead of 10, so medians are noisier; confirm
   the 3% significance floor still holds before trusting items 2–4.
2. **Re-validate f64x2 pairing on heavyweight pf64 + decide the refill
   port.** The shipped −9.5% pf64 verdict (LOG 2026-07-02) was measured on
   light cases only. The paired loop pays max-of-pair — worst exactly on the
   new border-band composition (z48 i50000: escaper mean 40k, wide spread),
   best on the trapped channels (mean 49.7k/50k, uniform). Run pre-pairing
   scalar (`node src/build.mjs scalar-pf64 --ref 2210aea`) vs HEAD with
   `--filter user-z4 --budget-ms 30000`; the same run measures the e52
   Horner case (a hot loop no flag/code experiment ever saw) and produces
   the numbers that decide whether the direct pathway's lane-refill kernel
   (−44% there) gets ported to pf64.
3. **Re-validate the 2026-07-06 "no pf64 interior treatment" decision.**
   Its premise — pf64 pixels rarely run full budget at z47+ — is
   contradicted by the probe data: real heavyweight pf64 views are 62–68%
   interior at i48000–50000, ground through the full delta loop with no
   cardioid/periodicity check. The direct pathway gained −74 to −86% on this
   composition class. Bound the upside honestly: trapped-channel *escapers*
   finish at 49.7k/50k and periodicity cannot help them, so the win is
   capped by the interior fraction — measure per-case.
4. **Re-validate the tier-up warmup cold-pass guarantee at heavyweight pf64
   scale.** The warmup renders direct-pathway tiles; the pf64 paired loop is
   a different function that may still hit page loads under Liftoff. The
   original cold check passed on z48 i20000 grids (~3.4 s); a z47 i50000
   grid is ~6× heavier, in the compile-contention regime that caused the
   original +18% regression. Check cold vs warm with run-grid on the z47
   i50000 point; if a penalty appears, the standing SIMD-warmup rule needs a
   pf64 warmup tile. Decide here too whether grid-regression.json gains one
   heavyweight pf64 e2e case (real ~90 s page loads, but roughly doubles e2e
   runtime).

Then, ranked as before:

5. Float-exp big-phase SIMD (perturbation.rs): after the 2026-07-07 hybrid
   ship, float-exp pixels spend most iterations in a *scalar* plain-f64 loop
   (z259 grid ≈ 2.4 s e2e). Routing the f64 phase through the pair/refill
   machinery could roughly halve it again. Mode switches are per-pixel
   mid-flight, so lanes need per-lane demote handling.
6. Ultra-deep small-mode cost: at effective zoom ≳ 400 the hybrid's
   ComplexExp phase dominates again (syn-fexp-z500-needle −58% not −85%;
   syn-fexp-z500-cusp-hi +2.5% — near-parabolic pixels never promote).
   Options: cheaper ComplexExp step, or a rescaled-f64 epoch loop
   (Fraktaler-style). Only worth it if user data shows z400+ traffic.
7. ~~Orbit cache sharing across worker threads~~ **DEMOTED 2026-07-07**: the
   "orbit-dominated deep-zoom loads" claim (LOG 2026-07-04) was a
   misattribution — a cold/warm probe showed the z259 orbit costs ~18 ms per
   worker vs ~1300 ms of per-pixel ComplexExp work (fixed by the hybrid
   loop). Sharing would save ~18 ms × workers on first view; revisit only if
   very high iteration counts (long orbits) at depth show up in user data.
8. Smooth-coloring cost: already measurable via the
   `syn-pf64-z100-dendrite[-nosmooth]` pair; optimize only if it exceeds
   5–10% of tile time.
9. dashu precision headroom (perturbation.rs: `(zoom + 64) -> 32-bit`
   granularity): affects cold times only; correctness-sensitive.
10. `panic = "abort"` in release profile: trivial; verify wasm-bindgen still
    works.

Hybrid float-exp does NOT need re-validation against the expanded corpus:
the new cases are all pf64 (untouched by the hybrid) and pixel-check
already passed on all 42 cases.

Shipped milestones: manual f64x2 pixel pairing + tier-up warmup (2026-07-04,
−16.8% e2e; **standing rule: hand-written SIMD hot loops ship only with a
tier-up warmup and an e2e cold-pass check**); quad batching + interior checks
(2026-07-06); lane-refill stream kernel + Mariani–Silver (2026-07-07); hybrid
f64/ComplexExp float-exp loop (2026-07-07, z259 e2e −84.7%).
