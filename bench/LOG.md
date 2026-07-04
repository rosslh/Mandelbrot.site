# Experiment log

Running record of performance experiments. Append an entry per experiment
(the perf-experiment skill does this as part of its workflow) so nobody
re-runs a settled question. Raw results JSONs are machine-local
(bench/results/, gitignored); this log is the durable record — include the
numbers that matter, not just a verdict.

Entry format: date, machine, what was tried (exact build.mjs flags or code
change), per-pathway geomean deltas vs baseline, size delta, verdict.

---

## 2026-07-02 — Harness validation

Machine: mac arm64 (M-series), Chrome for Testing 136, macOS 14.
Corpus: 33 cases (14 synthetic + 19 user).

- **A/A** (two identical baseline builds): overall geomean −0.0%, no case
  flagged significant. Noise floor on this machine is well under 1%.
- **Sensitivity** (`--opt-level 0 --no-wasm-opt`): +189% overall, all cases
  significant. Harness detects real differences.
- Pixel-check: byte-identical across builds, including across opt levels
  (rustc does not reassociate floats).

## 2026-07-02 — Flag matrix (results/first-pass.json)

Baseline: old production config (`opt-level=s`, lto=true, codegen-units=1,
`wasm-opt -Oz`), 240.2 KiB. Deltas are overall geomean vs that baseline;
negative = faster.

| variant | flags | direct | pf64 | float-exp | overall | size |
|---|---|---|---|---|---|---|
| opt3 | `--opt-level 3 --wasm-opt "-O3 ..."` | −0.1% | −1.3% | −0.3% | −0.7% | +10.7% |
| o3only | `--wasm-opt "-O3 ..."` | −0.2% | −0.5% | +0.3% | −0.3% | +1.5% |
| opt2 | `--opt-level 2 --wasm-opt "-O3 ..."` | −0.1% | −1.5% | −0.2% | −0.7% | +10.2% |
| opt3-simd | opt3 + `+simd128` + `--enable-simd` | −0.0% | −1.4% | **−9.7%** | −2.2% | +12.8% |
| simd-oz | `+simd128` at opt-level s / -Oz | +0.1% | +0.0% | −0.3% | −0.0% | −1.1% |
| opt2-simd | `+simd128` at opt-level 2 / -O3 | −0.6% | −1.2% | −0.6% | −0.9% | +12.1% |
| opt3-simd-oz | opt3+simd, wasm-opt -Oz | +0.7% | −1.1% | −9.8% | −1.8% | +12.0% |

Also slow (`--opt-level 1 --no-wasm-opt`): +0.2% overall — rustc opt levels
1/2/3/s are near-indistinguishable once V8 compiles the wasm.

**Conclusions:**
- The flag space without SIMD is exhausted: everything within ±1%.
- simd128 only pays off at `opt-level 3` (LLVM autovectorization threshold);
  the win is concentrated in the float-exp (ComplexExp) loops.
- wasm-opt -Oz vs -O3 on top of opt3+simd: same speed, ~2 KiB apart.

## 2026-07-02 — SHIPPED: opt-level 3 + simd128 (commit bbea8b5)

Confirmation run (results/simd-confirm.json), 15 samples, float-exp filter:
−9.6% geomean (per-case −9.2% to −10.0%, all significant), cold orbit times
−9.4% to −10.2%, byte-identical output on all 33 corpus cases.
Size 240.2 → 271.0 KiB (+12.8%). Browser floor now Safari 16.4 / Chrome 91 /
Firefox 89 (older browsers fail wasm validation).

New production config: root Cargo.toml `opt-level = 3`; `.cargo/config.toml`
`-C target-feature=+simd128` (wasm target only); mandelbrot/Cargo.toml
`wasm-opt = ["-O3", "--enable-simd", "--enable-mutable-globals"]`.

## 2026-07-02 — SHIPPED: manual f64x2 pixel pairing (backlog #1, code change)

Machine: mac arm64 (M-series), Chrome for Testing 136, macOS 14. No flag
changes — Rust code change only, built with production settings.

Escape loops now iterate two pixels at once, one per f64x2 lane
(`core::arch::wasm32`), freezing escaped lanes with a mask while the other
lane keeps iterating:

- lib.rs: `calculate_escape_iterations_quadratic_pair` + paired pixel loop in
  `render_mandelbrot_set`; `rect_in_set` border checks paired (two border
  points per call).
- perturbation.rs: `perturbed_escape_iterations_f64_pair` — per-lane orbit
  indices stay scalar (rebasing makes them diverge; wasm has no gather), delta
  step and rebase test are vectorized, rebase applied via mask select. Escaped
  lanes keep stepping on garbage values (output is frozen separately); the
  rebase-at-orbit-end rule keeps their indices in bounds. `border_in_set`
  paired.
- Scalar fallbacks: exponent != 2, float-exp pathway, non-wasm targets,
  trailing odd pixel.

Full 35-case corpus, 10 samples (results/*baseline_simd-pair.json):

| pathway | geomean | notes |
|---|---|---|
| direct | **−22.2%** | up to −38% on iteration-heavy tiles; interior/multibrot flat |
| perturbation-f64 | **−9.5%** | −7 to −13% warm and cold; multibrot flat |
| float-exp | −0.3% | untouched, as expected |
| overall | **−13.7%** | |

Size: bench artifact 271.0 → 275.4 KiB (+1.6%); production wasm
272.1 → 276.5 KiB. Correctness: lane arithmetic is IEEE-identical to the
scalar loops (`a*b + b*a` rounds to exactly `2*(a*b)`), pixel-check
byte-identical on all 35 cases, cargo test 53/53.

Verdict: shipped. Not attempted: ComplexExp (float-exp) lane pairing — the
extended-exponent ops are struct-heavy and autovectorization already captured
~10% there; stays on the backlog.

## 2026-07-04 — Regression check: full-grid render, moderate zoom / high iter

Machine: mac arm64 (M-series), Chrome for Testing 136, macOS 14.

User-reported suspicion of a regression at ~z35 / ~50k iterations after the
recent optimizations. New harness: `src/run-grid.mjs` +
`corpus/grid-regression.json` measures the summed wasm time for the ENTIRE
visible tile grid (200px Leaflet tiles around the view center, 1600x900
viewport → 9x5 = 45 tiles), replicating MandelbrotLayer's layout. Scope was
wasm-level changes only (the render-pool cap in 32a1c7d was deliberately
excluded; pool size held constant).

Variants: `old` = pre-optimization source+flags from b47adc6 (scalar loops,
opt-level=s, wasm-opt -Oz, no simd128, 242.8 KiB); `baseline` = scalar code +
shipped flags (2210aea, 271.0 KiB); `head` = shipped SIMD pairing + flags
(275.4 KiB). 1 cold + 1 warmup + 3 measured grid passes, interleaved;
per-tile hashes deterministic.

| case | pathway | old | head | head vs old |
|---|---|---|---|---|
| grid-z36-i51200-report (reported URL) | direct | 43435 ms | 26655 ms | **−38.6%** (cold −36.9%) |
| grid-z46-i6400 | direct | 8003 ms | 5322 ms | −33.5% |
| grid-z20-i1600 | direct | 3842 ms | 2615 ms | −31.9% |
| grid-z48-i20000 | perturbation-f64 | 18352 ms | 16779 ms | −8.6% |

baseline vs old: −0.5% geomean (flags alone are neutral outside float-exp,
as expected). head vs old geomean: −29.0%. No single tile regressed —
worst per-tile movers for head were all −26% to −35%. Grid-total spread
(MAD) was ≤25 ms on totals of 2.6–44 s, far below the 3% floor.

Verdict: **no wasm-level regression**; the reported config is ~1.6x faster
than before the optimizations. If whole-grid wall time regressed for a user,
the remaining in-scope-excluded suspect is the pool cap
(hardwareConcurrency−1 workers, 32a1c7d), which adds ~1/(cores−1) wall time
on uniform heavy grids — measure separately if reports persist.

## 2026-07-04 — Re-run with real worker pool (wall-clock makespan)

Same machine/cases/variants. run-grid.mjs reworked to match production:
one pool of real Web Workers per variant (7 workers on 8 logical cores =
renderPoolSize(), held constant across variants), tiles dispatched FIFO
center-out like Leaflet queues them, pixel buffers posted back via
structured clone like `threads` does. Headline metric is wall-clock
makespan (first dispatch → last tile done); summed per-tile wasm time
kept as secondary. 1 cold + 1 warmup + 5 measured passes
(results/grid-wallclock-old_baseline_head.json).

| case | old wall | head wall | head vs old | cold |
|---|---|---|---|---|
| grid-z36-i51200-report | 8722 ms | 5350 ms | **−38.7%** | **+24.6%** (see below) |
| grid-z46-i6400 | 1421 ms | 943 ms | −33.6% | −33.8% |
| grid-z20-i1600 | 728 ms | 494 ms | −32.2% | −32.0% |
| grid-z48-i20000 | 3436 ms | 3094 ms | −10.0% | −10.2% |

Wall-clock deltas match the sequential CPU-sum deltas within ~1 point
(overall geomean −29.4% vs −29.0%): 7-way contention inflates per-tile
times ~15% on both sides equally, so single-threaded wins carry over to
wall clock. baseline (flags-only) again −0.5% geomean. Worst per-tile
movers under head all negative on every case.

**New finding — cold-start tiering penalty:** head's very first grid pass
of the session on the z36/i51200 case took 11074 ms vs 5350 ms warm
(old: 8884 cold ≈ 8722 warm; baseline: no penalty). The paired-SIMD hot
loop runs much slower under Liftoff until TurboFan tiers it up, and each
of the 7 fresh workers pays that independently on its first heavy tiles.
Later cases show no penalty (workers already tiered), so in production
this costs one page load's first render (~+25% vs old at this config),
after which renders are ~1.6x faster. Possible mitigation for the
backlog: prime each worker at spawn with a tiny offscreen render to
trigger tiering before user tiles arrive.

Verdict: no regression in steady-state wall clock; first-render cold
start at very high iteration counts is the one measurable cost.

## 2026-07-04 — END-TO-END harness (now the standard test) finds the real regression

New standard configuration, per project decision: **all future perf verdicts
come from `src/run-e2e.mjs`**, which drives the actual built client
(`src/build-dist.mjs`, real webpack bundle + wasm + Leaflet + threads pool +
service worker) in Chrome and measures navigation → last visible tile done
(MutationObserver on `.leaflet-tile-loaded`). Each variant dist is served on
its own origin; DNS for everything except 127.0.0.1 is stubbed out
(`--host-resolver-rules`), so no telemetry or external fetches. Wasm-level
runners (run.mjs, run-grid.mjs) remain for iteration only.
Gotcha for future harness work: puppeteer request interception never sees
dedicated-worker requests and stalls the threads pool — block at DNS level.

E2E old (b47adc6 full build) vs head (11b3447 full build), 5 rounds
(results/e2e-regression-old_head.json):

| case | old | head | delta | cold |
|---|---|---|---|---|
| grid-z36-i51200-report | 8827 ms | 10573 ms | **+19.8%** | +9.4% |
| grid-z46-i6400 | 1704 ms | 1508 ms | −11.5% | −12.5% |
| grid-z20-i1600 | 1068 ms | 982 ms | −8.1% | −7.0% |
| grid-z48-i20000 | 3478 ms | 3323 ms | −4.5% | −2.1% |

**The user-reported regression at z36/i51200 is real end-to-end** (+15–20%
across runs, high round-to-round variance ±100–400 ms) even though the same
build is −38.7% on tiered-up wasm (grid runner). Decomposition
(results/e2e-z36-pool-decomposition.json) with a head build whose pool cap
is reverted (8 workers instead of 7):

| variant | z36 median |
|---|---|
| old (8 workers, scalar wasm) | 8871 ms |
| head (7 workers, paired-SIMD wasm) | 10185 ms (+14.8%) |
| head-fullpool (8 workers, paired-SIMD wasm) | 11007 ms (+24.1%) |

So the pool cap is NOT the cause — the 8th worker makes it worse. The
regression is per-page-load wasm warmup: every navigation respawns the
pool, each worker compiles/instantiates the module fresh, and the
paired-SIMD hot loop runs under Liftoff (whose SIMD codegen is poor) until
TurboFan tiers it up — while 7–8 workers grinding 51k-iteration tiles
saturate the cores TurboFan's background compile threads need. Old's scalar
loop is much closer to its tiered speed under Liftoff, so it barely pays.
Lighter configs tier up early in the pass and still win end-to-end. Warm
passes are not faster than cold: the wasm comes back through the service
worker on revisits, which (in this setup) bypasses V8's optimized-code
cache, so every visit pays the penalty. Caveat: bench server sends
`Cache-Control: no-store`; production CDN headers might let V8's wasm code
cache kick in for non-SW paths — unverified.

Verdict: steady-state exploration (pan/zoom after load) is ~1.5–1.6x faster
than pre-optimization, but page loads at very high iteration counts
regressed ~15–20%. Mitigation to test next: warm the hot loop at worker
spawn (tiny high-iteration render during pool init / the 350 ms tile
debounce window) so tier-up completes before real tiles arrive; measure
with run-e2e.

## 2026-07-04 — REVERTED: manual f64x2 pixel pairing (e38df5b)

mandelbrot/src/lib.rs and perturbation.rs restored to their pre-pairing
state (2210aea) because of the e2e page-load regression above. The
opt-level 3 + simd128 flag config (bbea8b5) stays: it showed no e2e
regression and carries the float-exp win. cargo test 53/53 after revert.
The pairing code is preserved in git history (e38df5b); re-landing is
blocked on an e2e-verified tier-up mitigation (worker warmup experiment,
next entry).
