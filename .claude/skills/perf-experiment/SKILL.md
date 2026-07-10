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

**Focus directive (2026-07-09, user): prioritize the direct (plain-f64)
pathway.** It serves ~91% of real views (16,644 of 18,370 deduped export
views) and, after the 2026-07-07/09 deep-zoom ships, it is where the
un-mined headroom is: pick direct-tier targets first, treat the deep tiers
as regression guards. The deep-zoom settled verdicts (pf64 byte-exact space
exhausted; iteration-skipping negative; z400+ traffic-gated) are unchanged
by this — do not re-open them under the new focus.

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
  byte-identical. Float reassociation (e.g. ffast-math-style RUSTFLAGS,
  wasm-opt --fast-math) legitimately changes pixels — such experiments go
  through the anchor-relative tolerance gate below, not --allow-diff.
- **Rust code change**: `cargo test` must pass (insta snapshot suite). Use
  `cargo insta test --accept` only when the visual diff is understood and
  intended. Then rebuild the variant and re-run the benchmark.
- **Drift detector (either kind of change):** `node src/enrich.mjs --check
  <variant>` re-probes every corpus case and compares the values buffer
  against the committed blessed hashes (`stats.valuesHash`) — catches output
  changes that snuck in across experiments. Intentional changes are
  re-blessed with `--check <variant> --bless` plus a LOG.md justification.

### Output policy: byte-exact by default, anchor-relative tolerance by opt-in

Decided by the user 2026-07-10 (LOG entry of the same date). Byte-exactness
stays the default bar for everything above. An experiment whose output
change is float-rounding-class (FMA, reassociation) may instead opt into
the **tolerance gate**, which bounds deviation against a PINNED ANCHOR
build — never against the experiment's own predecessor, so accepted
deviation can never compound across ships (no drift ratchet):

```sh
node src/pixel-check.mjs --b <variant> --tolerance              # fixed corpus
node src/validate.mjs --variants base,<variant> --pixel-check --tolerance  # holdout
```

The anchor is pinned in committed `bench/anchor.json` (variant name, git
sha, budgets); the artifact itself is machine-local and regenerated with
`node src/build.mjs anchor --ref <pinned-sha>` (the runners verify the
artifact's meta sha against the pin and refuse a stale one). The diff runs
on smoothed escape VALUES, not RGBA. Budgets (committed): max |Δ| ≤ 1.0
iteration on escapers, ≤ 0.1% of pixels differing, largest 4-connected
diff blob ≤ 2 px, and **zero escaper↔interior flips** — a flip's delta is
unbounded, so flip-class changes (Mariani-speck-like fills) always
escalate to the user rather than passing quietly. A failing tolerance run
is an escalation, not an acceptance path: the change is either wrong or
needs a deliberate re-anchor (LOG.md entry + re-pin anchor.json + rebuild
the anchor artifact) — moving the anchor is a user-level decision, never
an experiment side effect. Tolerance-accepted ships still re-bless
enrich hashes as usual and must run the holdout tolerance check.
Validated 2026-07-10: A/A identical on all 43 cases; the two known
historical artifact classes (16-flip speck cluster on user-z30, 1-px flip
on a holdout e3 view, both from the 633ad35→ modernization re-bless) are
correctly caught and escalated.

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
What the export says about real usage (probed 2026-07-07/08): the direct
(plain-f64) tier is ~91% of deduped views (16,644 of 18,370; 1,725 pf64,
1 float-exp), and its real heavy views run 68–204M probe iterations — the
top two are user-z28-543f9cfa (i50000 border band, escaper mean 41k,
~1.3 s/tile at 200px) and user-z30-f8a50601 (e6 multibrot, 92% interior,
~11.6 s/tile at 200px on the scalar general loop). The pf64 tier is
effectively all z47–59 (one lone view past z60), there is exactly one
float-exp view (z259), and the slowest deep views are 25k–50k-iteration
pf64 tiles — including an exponent-52 view whose O(exponent) Horner delta
step, not the iteration count, was the cost (~60 s/tile at 200px when
found; ~6 s/tile after the 2026-07-08/09 general-kernel + coefficient-table
ships).

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

Items #1 (pf64 lane-refill stream kernel) and #2 (scalar pf64
periodicity) **shipped 2026-07-08** — see the LOG entry: pf64 geomean
−38.9% wasm-level / −40% on the heavyweight e2e cases (grid-z47 99 → 59 s),
e52 view −31% via scalar state-periodicity, outputs byte-identical.
Mechanism notes that survive: periodicity must compare the full state
(dz, reference_index) — z-only is unsound; interior e2 pixels at pf64
depths *never rebase*, so their state cannot recur and periodicity cannot
touch them (the e2 win is pure refill/ILP; the e52 win is periodicity via
that view's frequent rebases). Fully-interior e2 tiles (border_in_set
regime) remain untouched by everything shipped so far.

The general-exponent pf64 stream kernel **shipped 2026-07-08 (later the
same day)** — see the LOG entry: lane-parallel SIMD Horner delta step, e52
view e2e 133 → 74 s (−44.6%), e4/multibrot3 −27..−31%, all other traffic
neutral. Mechanism notes that survive: monomorphize per exponent-class
(a runtime `exponent == 2` branch in the step cost e2 +3–6%); a new SIMD
kernel *instantiation* is a separate wasm function needing its own tier-up
warmup, and the stream kernel is one call per tile, so an untiered first
tile runs Liftoff for its entire duration (−8% instead of −45% e2e);
warmups that cost every load must be made conditional (the multibrot
warmup rides `config.exponent != 2` at pool spawn).

Conditional deep-zoom (pf64) spawn warmup (former item #1) **shipped
2026-07-08 (same day, third entry)** — see the LOG entry: `warmupDeep`
rides `config.zoom >= 47 && exponent == 2` at pool spawn; grid-z47
54.6 → 45.8 s (−16.2%), z48-i20k −12.6%, light-pf64 z48-i800 −7.1%,
accepted +23 ms on the ultra-light z85-i200 view (now a committed
grid-regression tax-guard case, along with z48-i800). Mechanism notes
that survive: at pf64 depths a warmup tile must get volume from *pixel
count*, not iteration caps — trapped/capped tiles read as 100% interior
and border_in_set fills them without running the kernel (probe: identical
wall time at cap 1000 vs 2000); 2 renders of a 256px dendrite tile
(~5.2M iters) fully tier the e2 stream kernel — doubling to 4 renders
bought nothing on the heavies and doubled the light-view tax.

Former item #1 (float-exp big-phase SIMD) **shipped 2026-07-08** as the
hybrid float-exp stream kernel + conditional `warmupFloatExp` — see the LOG
entry: z259 e2e 2375 → 1250 ms (−47.4%), float-exp geomean −27.7% wasm-level,
all other traffic neutral. Mariani–Silver for pf64 also **shipped
2026-07-08**: interior-heavy real views −57..−69% wasm-level,
grid-z48-i48000 e2e −9.7% (new committed grid-regression case); multibrot
pf64 deliberately stays ungated off the wave driver (scattered interior
pays wave overhead for nothing).

**SETTLED 2026-07-08 (negative — do not re-run): iteration-skipping at
real pf64 depths (z47–59).** Both known families fail against the output
bar; probes are committed as ignored tests in
mandelbrot/src/perturbation_test.rs (`bla_probe`,
`multiplier_interior_probe`), full numbers in the LOG entry. BLA: at
tolerances loose enough to skip meaningful work it shifts boundary-pixel
escape counts by hundreds–thousands of iterations (chaos amplifies any
rounding-path change); at safe tolerances the native win is 1.0–1.35x,
which the shipped SIMD stream kernel (~1.7x scalar) fully eats; the delta
headroom that makes BLA work simply doesn't exist below ~z250, and the e52
view's 85-iteration reference orbit leaves nothing to compose. Multiplier
interior detection: false-retires thousands of escapers at δ=1e-6 (spurious
near-returns + one tiny |2z| factor mimic contraction) and never fires on
the near-parabolic trapped channels (|m|≈1) at δ=1e-9. Consequence:
**grid-z47-i50000's ~45 s is irreducible exact work** — every remaining
pf64 lever inside byte-exact semantics has shipped. Attacking it further
requires an explicit output-policy decision (perceptual-equivalence gate
instead of byte-exactness), taken deliberately by the user, not as a side
effect of an experiment.

### Direct (f64) tier — the active focus (2026-07-09 directive)

Item #1 (direct multibrot modernization) **shipped 2026-07-10** — see the
LOG entry: sqrt drop + `stream_escape_general` (powu-exact SIMD, fused
across chains) + Mariani dispatch for all exponents; the e6 view −94.9%
wasm-level, grid-z30-e6 e2e 34.5 → 4.35 s (−87.4%, cold tracks warm via
the new `warmupGeneralDirect`). Mechanism notes that survive: replicate
num-complex's square-and-multiply order exactly for bit-exactness; 4
chains beat 6/8 (small Mariani waves + refill bookkeeping punish wider
kernels); the accepted output-diff class is isolated escaper specks
ring-filled as interior (17 px across 123 validated views, same class as
tile-level rect_in_set) — any future fill-related diff must match that
signature or it's a bug. grid-z30-e6-f8a50601 is committed to
grid-multibrot.json as the direct-multibrot regression guard.

Heavy-direct e2e coverage (former item #1) **DONE 2026-07-10**:
grid-z28-i50000-543f9cfa committed to grid-regression.json (~11.0 s per
grid pass on the production build; +11 s per round per variant — use
--filter to skip it during iteration, like grid-z47).

**SETTLED 2026-07-10 (measured, cap stays): pool-cap re-audit (7 vs 8
workers).** The 2026-07-04 contention finding is overturned — the spawn
warmups fixed it (z36-i51200 with 8 workers: −0.7% warm / −5.3% cold,
vs +24% in 2026-07-04). On current builds the cap costs ~2–3% on
throughput-bound heavy grids (grid-z47 −3.1%*, ~1.6 s of 50 s; z28
−2.6%; z48-i48k −1.8%; z48-i20k −2.5%), noise on light cases, overall
geomean −1.0% — far below the old confounded ~5.7% estimate. The cap
is a deliberate UX decision (32a1c7d: leave a core for the OS; "video
decode stutters, fans spin up"), and its measured latency cost fits
that commit's "negligible" claim, so it stays. Full numbers in the LOG
entry; re-open only if the user re-weighs the UX tradeoff — the
benchmark side is answered.

Former item #1 (trapped/border direct throughput, the z28-i50000 class)
**shipped 2026-07-10** as deferred escape detection in the quadratic
stream kernel — see the LOG entry: grid-z28 e2e 11.1 → 6.2 s (−44.0%),
direct geomean −24.3% wasm-level, outputs byte-identical, deep tiers
flat. Mechanism notes that survive: exact-detection machinery in a SIMD
escape loop (norm/lt/alive/freeze-selects/masked iter) can be amortized
to stride boundaries — escaped lanes free-run safely (escape-radius
growth is monotone; inf/NaN fail the boundary lt) and a ≤stride scalar
replay from a boundary checkpoint recovers the exact escape step
byte-exactly. After any step-cost change, re-sweep chains AND stride:
both optima moved (4→6 chains, 16→32 stride). The tax lands on
low-escape-count escapers (replay + free-run are fixed per-escaper
costs) — watch syn-z10-seahorse-class cases when touching stride. The
iteration counts themselves remain irreducible (settled).

General-kernel deferred escape detection (former item #1) **shipped
2026-07-10** — see the LOG entry: e6 view 152.6 → 97.6 ms wasm-level
(−36.0%), grid-z30-e6 e2e 5.79 → 3.91 s (−32.5%, colds track — the
existing warmupGeneralDirect covers it), e3 −19.9%, all else byte-
identical noise. Re-sweep flipped the general kernel's optima to 6/32
too — the "register-hungry powu caps it at 4 chains" verdict was stale
the moment the step shed its escape machinery. Free-run safety
generalizes to every exponent d ≥ 2 (growth past R=3 is monotone for
all multibrot degrees). Accepted tax: fast-escaping high-exponent
views (holdout e50 view +12.7% = +0.7 ms/100px tile) — the class is
structurally millisecond-scale, but watch it in holdouts when touching
stride.

The FMA/rounding-class calibration run (former item #1) **DONE
2026-07-10 (settled — do not re-run at flag level)** — see the LOG
entry. The flag-only rounding class is EMPTY on this toolchain:
`wasm-opt --fast-math` is byte-identical to `-O3` alone (both argument
orders, verified at tool level — LLVM opt3 pre-canonicalizes everything
binaryen's fastMath touches), and `-C llvm-args=-enable-unsafe-fp-math`
is byte-identical too (IR reassociation needs per-instruction fast
flags stable rustc never emits; wasm has no FMA instruction to
contract into). The tolerance gate itself was exercised on both paths
(fixed corpus + holdout, A/A and real diffs) with **no tooling issues**.
Budget calibration via a synthetic rounding probe (difference-of-squares
real-part update, reverted): 9/43 corpus cases escalate in two classes —
boundary re-rolls (z28: 56% px, 7,059 flips, |Δ| 12k — flips/|Δ| axes
gate first) and **distributional drift** (user-z44: 53% px differ at
max |Δ| 0.106, zero flips — passes |Δ|, fails only fraction/blob). A
future statistical tier must accept the z44 signature while rejecting
re-rolls; that data is in the LOG. Bonus finding: the probe's DoS form
is +39%/iter on V8/M1 at identical op counts — the quadratic step's
dependency structure is performance-load-bearing; don't reorder it
without measuring. Hardware-FMA relaxed-SIMD stays blocked by the
Safari floor; rounding-class hopes now ride on the renderer survey.

The renderer survey (former item #1, user-approved) **DONE 2026-07-10
(settled — do not re-run)** — see the LOG entry (it is also the
provenance design note). Seven projects read (XaoS, iterated-dynamics/
Fractint, KF2+ [AGPL-3, not GPL], Fraktaler-3, mandelbrot-perturbator,
rust-fractal-core, Fractalshades [MIT]); clones stayed outside the
repo, no code copied. Outcome: **no importable idea survives.** The
field's exact toolkit (periodicity, cardioid/bulb, deferred bailout
with block replay — XaoS independently converged on our deferral
design) is a subset of what already shipped here; everything else is
either flip/blob-class fill (boundary tracing, solid guessing —
escalation-only, and inapplicable to smoothed escaper bands anyway),
settled-negative (SOI/series approx = BLA class; Fractalshades'
dzndz stop = multiplier interior), or deep-tier/traffic-gated
(rescaled-f64 epoch loop, reference tricks). Higher-period interior
closed forms appear nowhere in the field and have no absolute time
here. Together with the FMA calibration (same-day LOG entry), both
import lanes are closed: direct-tier progress now requires a user
decision (statistical output tier, or relaxed-SIMD dual-build), not
an experiment.

Relaxed-SIMD hardware FMA (former item #1) **PRICED 2026-07-10
(parked — awaiting two user decisions; do not re-measure)** — see the
LOG entry. Feasible on stable Rust (relaxed intrinsics stable since
1.82); the win is large and real: −29..−30% on every
stream-kernel-dominated direct heavy (ms/Miter 0.40 → 0.28), direct
geomean −17.7%, time-weighted −28.0%, **grid-z28 e2e 5365 → 3888 ms
(−27.5% warm, −28.4% cold)**, size flat. Blocked by (1) output
policy — the diff is the calibration's boundary re-roll class (z28:
7,141 flips), escalated by the tolerance gate as designed; needs a
statistical-equivalence tier or deliberate re-anchor, and (2) the
browser floor — Safari has no relaxed-simd at any version, so
shipping means a dual-build + runtime feature detection, now priced
against a −27.5% e2e payoff on the heaviest real direct view. The
tolerance gate itself ran clean on its first real rounding-class
input (both fixed-corpus invocations, correct per-axis attribution).
Ship path if ever unblocked (in the LOG entry): FMA-consistent scalar
replay, chains/stride re-sweep, holdout + re-bless, cold-pass e2e,
dual-build plumbing.

1. **Residual z28-class throughput**: after the deferral ship the step
   is the bare z²+c recurrence at 6 chains — per-step op space is now
   genuinely mined out; the survey found no new algorithmic idea, so
   the only known reopener is the parked FMA decision above (byte-exact
   iteration-skipping stays settled). Same now holds for the general
   kernel: its per-step cost is the powu chain itself.
2. z0 whole-set small-tile wave/gather overhead — micro (accepted
   +0.6 ms/tile from the Mariani ship); only if whole-set loads ever
   matter in user data.

**Settled negatives are unchanged under the 2026-07-10 tolerance
policy — do not re-litigate them under the new bar.** BLA fails the
loosened gate as badly as the byte gate (skip-worthy tolerances shift
boundary escape counts by hundreds–thousands across whole bands) and
had no headroom at safe tolerances; multiplier interior detection is
flip-class (the zero-flip budget exists precisely for it); fill
loosenings (bigger Mariani leaves, cheaper boundary sampling) are
flip-class, escalation-only. Smooth-coloring/post-processing math now
has a sanctioned lane but stays closed on absolute-time grounds
(~2.2 ms/tile).

### Deep tiers — deprioritized under the f64 focus directive (status unchanged)

- Ultra-deep small-mode cost: at effective zoom ≳ 400 the hybrid's
  ComplexExp phase dominates again (syn-fexp-z500-needle −58% not −85%;
  syn-fexp-z500-cusp-hi +2.5% — near-parabolic pixels never promote).
  Options: cheaper ComplexExp step, or a rescaled-f64 epoch loop
  (Fraktaler-style). Only worth it if user data shows z400+ traffic.
  (BLA is also viable at these depths — the headroom argument above
  inverts — but same traffic gate applies.)
- ~~Orbit cache sharing across worker threads~~ **DEMOTED 2026-07-07**: the
  "orbit-dominated deep-zoom loads" claim (LOG 2026-07-04) was a
  misattribution — a cold/warm probe showed the z259 orbit costs ~18 ms per
  worker vs ~1300 ms of per-pixel ComplexExp work (fixed by the hybrid
  loop). Sharing would save ~18 ms × workers on first view; revisit only if
  very high iteration counts (long orbits) at depth show up in user data.
- ~~Smooth-coloring cost~~ **CLOSED 2026-07-08**: ~2.2 ms flat per 200px
  tile (~55 ns/px post-processing; the smooth/nosmooth pair differs by 9%
  only on light tiles). Negligible on the heavy tiles that set page-load
  times — below the action threshold under absolute-time weighting.
- dashu precision headroom (perturbation.rs: `(zoom + 64) -> 32-bit`
  granularity): affects cold times only; correctness-sensitive.
- ~~`panic = "abort"` in release profile~~ **CLOSED 2026-07-08**: exactly
  0 bytes size delta and speed within noise — wasm32 panics already lower
  to abort, only the runtime shim changes. The real lever
  (nightly -Zbuild-std + panic_immediate_abort) is out of scope on the
  stable-toolchain policy.

**SETTLED 2026-07-09 (structural negative — do not revisit):
conjugation-symmetry tile mirroring.** The 200/128 = 25/16 factor in the
tile→complex mapping puts the real axis at fractional tile coordinate
0.64·2^tz — never on a tile or pixel boundary at any zoom, so exact mirror
pairs cannot exist in this pyramid; and the heavy deep views sit ~10^11
tiles off-axis anyway. Full arithmetic in the LOG entry.

Shipped milestones: manual f64x2 pixel pairing + tier-up warmup (2026-07-04,
−16.8% e2e; **standing rule: hand-written SIMD hot loops ship only with a
tier-up warmup and an e2e cold-pass check**); quad batching + interior checks
(2026-07-06); lane-refill stream kernel + Mariani–Silver (2026-07-07); hybrid
f64/ComplexExp float-exp loop (2026-07-07, z259 e2e −84.7%); pf64 lane-refill
stream kernel + (dz, index) Brent periodicity (2026-07-08, grid-z47 e2e
−40%, e52 −31%); general-exponent pf64 stream kernel + conditional warmups
(2026-07-08, e52 e2e −44.6%); pf64 Mariani–Silver + hybrid float-exp stream
kernel (2026-07-08); per-orbit-index Horner coefficient table + fused-chain
general step (2026-07-09, e52 e2e −73.3%, 74 → 19.8 s — mechanism note: a
long *serial* recurrence inside a SIMD step is latency-bound; interleaving
independent chains beat removing ops, −60% vs −33%); direct multibrot
modernization (2026-07-10, grid-z30-e6 e2e −87.4%); deferred escape
detection in the quadratic stream kernel + chains/stride re-sweep
(2026-07-10, grid-z28 e2e −44.0%, direct geomean −24.3% wasm-level,
byte-identical — mechanism note: exact escape detection can be amortized
to stride boundaries with a ≤stride scalar replay; after any step-cost
change, re-sweep chains and stride); deferred escape detection in the
general (multibrot) stream kernel + its own 6/32 re-sweep (2026-07-10,
grid-z30-e6 e2e −32.5%, e6 view −36.0% wasm-level, byte-identical —
both direct-tier kernels now run bare recurrences between boundaries);
initial-batch dispatch at pool-ready + 100 ms grace (2026-07-10, overall
e2e geomean −16.0% — mechanism note: spawn warmups only trigger tier-up,
the TurboFan swap needs idle CPU; re-check z28 first-tile curves after
any warmup/pool/dispatch-timing change); single-pool startup — URL config
parsed before the pool spawns (2026-07-10, light/mid cases −3.5..−7.1%,
overall geomean −3.6%, z30-e6 cold −4.3% — kills the double
spawn+warmup cycle and the throwaway default-view tile burst on every
shared-link load; harness rule: never use puppeteer request interception
around this client — it intermittently stalls worker spawns; block
off-localhost via --host-resolver-rules like run-e2e). Per-load floor
after both ships: ~45 ms bundle+init, ~50 ms pool spawn+warmup, 100 ms
tier-up grace, dispatch ≈ 190 ms; remaining levers are the grace itself
(load-bearing) and spawn cost.
