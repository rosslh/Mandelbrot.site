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
next entry). [Re-landed later the same day with the warmup — see the
matrix entry below.]

## 2026-07-04 — E2E replication of prior wasm-level experiments

Corpus gained grid-z259-i1600 (float-exp, real user point) so all three
pathways have e2e coverage. Run: old (b47adc6 build) vs reverted (2c6334b
build = scalar + opt3/simd128 + pool cap) vs reverted2 (byte-identical A/A
copy), 5 rounds (results/e2e-replication-old_reverted_AA.json).

- **A/A (harness validation replication):** reverted vs reverted2 within
  ±0.6% on every case, no false significants. E2E noise floor is <1% —
  the 3% significance floor holds at this level too. Sensitivity is
  demonstrated by the known-different builds (+18%/−38% detected).
- **opt3+simd128 (flag-change replication):** old vs reverted is
  +1.4–1.8% overall geomean. The −9.6% wasm-level float-exp win shrinks
  to −3.4–3.7% e2e (z259), because deep-zoom page loads are dominated by
  per-worker reference-orbit computation, not delta loops (z259 grid:
  ~15.5 s). z46/z48 show +5.7%* — but this is a complete-build
  comparison: reverted also carries the pool cap (7 vs 8 workers), which
  costs throughput-bound mid-weight grids ~5% while helping the
  compile-contended z36 case. Verdict: the flag change is roughly e2e
  neutral on its own; it stays for the float-exp win and because pairing
  requires simd128 anyway. NOT replicated per-variant: the 7-build
  non-SIMD flag matrix (all were ±1% at wasm level; e2e would cost 7
  client builds to re-answer a settled question).
- **Pairing (e38df5b) replication:** the two entries above — e2e is what
  exposed the regression the wasm-level runners missed.
- Observation for the backlog: at z259 the page load is ~15.5 s in every
  variant — per-worker orbit recomputation dominates deep-zoom loads.
  Orbit cache sharing (backlog #5) is the highest-leverage deep-zoom item
  by far.

## 2026-07-04 — SHIPPED: pairing re-landed + worker tier-up warmup

Experiment: worker.js runs two 64x64, 1000-iteration renders of the
seahorse valley (boundary-rich, exponent 2, direct pathway — exercises the
paired quadratic loop without the rect_in_set interior short-circuit)
right after wasm init, before expose(). This consumes V8's dynamic
tier-up budget during pool spawn, so TurboFan code replaces Liftoff
before the user's first tiles render.

Full 2x2 matrix (pairing x warmup), one session, 5 rounds
(results/e2e-matrix-pairing-x-warmup.json), deltas vs old:

| case | reverted | reverted-warm | pair-warm |
|---|---|---|---|
| z36 i51200 | −2.4% | −2.2% | **−38.1%** (cold −39.6%) |
| z46 i6400 | +5.7%* | +6.2%* | **−19.6%** |
| z20 i1600 | +2.0% | +3.0% | **−14.9%** |
| z48 i20000 | +5.7%* | +5.9%* | −2.5% |
| z259 i1600 | −3.7%* | −3.5%* | −3.4%* |
| overall | +1.4% | +1.8% | **−16.8%** |

Conclusions:
- **Warmup alone does nothing** (reverted-warm ≡ reverted within noise):
  the scalar/autovectorized loops already run near tiered speed under
  Liftoff. The penalty is specific to hand-written f64x2 pairing.
- **Pairing + warmup wins everywhere**, including the case that
  originally regressed (8.8 s → 5.5 s) and the light cases (warmup cost
  is unmeasurable, ≤ a few ms per load).
- Earlier confirmation run (results/e2e-warmup-old_head_pairwarm.json):
  head (pairing, no warmup) +18.3% on z36 — reproducing the regression —
  vs pair-warm −38.7% in the same session.

Shipped: paired Rust code restored (identical to e38df5b) + warmup in
client/js/worker.js. cargo test 53/53. Production wasm back to 276.5 KiB.
Rule for the future, now encoded in the skill: hand-written SIMD hot
loops must ship with a tier-up warmup and an e2e cold-pass check.

## 2026-07-06 — SHIPPED: quad batching + interior checks (direct pathway, sub-40 zoom / >25k iterations)

Machine: mac arm64 (M-series), Chrome for Testing, macOS 14. Code change
only, production flags throughout.

Target regime (user-directed): direct pathway, zoom < 40, iterations > 25k,
prioritizing views with many border pixels (high-but-not-max escape counts).
New focused corpora: corpus/hi-iter-direct.json (6 single-tile cases) and
corpus/hi-iter-direct-grid.json (3 e2e grid cases), compositions verified by
offline 64x64 probes.

**Corpus findings worth keeping:**
- The reported z36/i51200 tile is ~98% interior (minibrot); grid-wide the
  view is 13.5% interior pixels carrying ~90% of the total work.
- The near-parabolic "channels" users park on (cusp exterior d<=1e-6, seahorse
  valley pinch) are **f64-trapped**: every pixel runs the full budget without
  escaping, and most orbits never become exactly periodic within it. These are
  pure throughput workloads; genuinely high-but-not-max escaper bands live
  next to minibrot/interior boundaries (mean 1-6k, p90 up to ~14k at i51200).

**Change (mandelbrot/src/lib.rs):**
1. Quad batching: the quadratic escape loop iterates 4 pixels per step across
   two f64x2 vectors (two independent FP dependency chains), with pair/scalar
   remainder handling; rect_in_set corner + border probes batched 4-wide too.
2. Interior checks: closed-form main-cardioid/period-2-bulb membership before
   the loop, plus exact-equality Brent periodicity inside all escape loops
   (saves at 8,16,32,...; checked every 4th iteration — stride keeps the check
   off the hot path, and detection stays guaranteed because saves land on
   stride multiples). Detected pixels return max_iterations, exactly what the
   timed-out loop would return, so output is unchanged.

Wasm-level (run.mjs, focused corpus, 10 samples), deltas vs clean-tree base:

| case | interior | quad | both+stride |
|---|---|---|---|
| hi-border-z36-rep-u1 | −6.8% | −45.5% | **−48.6%** |
| hi-border-z36-rep-r075 | −46.8% | −48.3% | **−71.8%** |
| hi-border-z30-seahorse | +3.1% | −46.4% | **−44.9%** |
| hi-mixed-z12-valley | −90.0% | −47.3% | **−92.6%** |
| hi-interior-z36-rep | −73.8% | −48.8% | **−86.1%** |
| hi-trapped-z21-cusp | −99.9% | −49.1% | **−99.9%** |
| geomean | −85.3% | −47.6% | **−91.3%** |

Quad batching alone is a uniform ~−47% (ILP win, helps every workload
including trapped/escaper tiles); interior checks crush interior/mixed tiles;
the 4-iteration check stride cut the periodicity overhead on pure-escaper
tiles from ~+10% (vs quad-only) to ~+2%.

Correctness: byte-identical output across all variants on the focused corpus
and all 35 standard-corpus cases (pixel-check); cargo test 59/59. Exactness
argument: cardioid/bulb membership and exact-cycle detection only fire for
points that provably never escape.

E2E (run-e2e.mjs, complete client builds pre=689e024 / post=this change):
- Focused grid corpus: rep-up4 (border-heavy) −20.1% (cold −22.1%), report
  grid −70.4% (5573 → 1649 ms, cold −70.1%), valley −84.6%. Overall −66.9%.
- Standard grid-regression corpus: z36 −70.2%, z46 −26.3%, z20 −19.3%,
  z48 perturbation +0.3% (untouched; a one-shot cold +11.3% did not reproduce:
  two reruns gave cold −0.8%/−0.2%), z259 float-exp −0.2%. Overall −29.2%.
- Cold passes track warm everywhere: the existing worker tier-up warmup
  (two 64x64 seahorse renders at spawn) already exercises the quad kernel
  (64 % 4 == 0), so no new Liftoff penalty.

Size: production module wasm 280.6 → 284.3 KiB (+1.3%).

Reproduce: `node src/run.mjs --variants base-hi,hi-final --corpus
corpus/hi-iter-direct.json --filter hi- --budget-ms 30000`; e2e as usual with
`--corpus corpus/hi-iter-direct-grid.json`.

Verdict: shipped. Follow-ups noted: (a) 8-wide (four-vector) batching
untested — quad's uniform −47% suggests ILP headroom may remain; (b) the
perturbation-f64 delta loop got no interior/quad treatment (its pixels rarely
run full budget at z47+ except near minibrots — measure before touching);
(c) orbit cache sharing remains the top deep-zoom item.

## 2026-07-07 — SHIPPED: lane-refill stream kernel + Mariani–Silver subdivision (direct pathway)

Machine: mac arm64 (M-series), Chrome for Testing, macOS 14. Code change
only, production flags throughout.

Target regime (user-directed refinement of 2026-07-06): tiles dominated by
EXTERIOR set-adjacent pixels escaping at high-but-not-max counts, some
interior mixed in. New focused corpus corpus/hi-border.json (7 cases):
the two hi-border z36 anchors, two new minibrot-halo cases found by probing
~30 candidates around the rep minibrot (hi-band-z39-efar: 44% interior,
escaper mean 6.7k/p90 16.7k, most near-max-dominated tile found;
hi-band-z38-nedge: 90% interior + escaper tail mean 11k/p90 28k), seahorse
(0% interior throughput control), valley, trapped-cusp (now resolves
instantly via rect_in_set + border periodicity — fast-path control only).
Probe finding: near-max escapers are inherently a thin band; no tile is
majority >25k escapers — heavy-tailed escaper work is the realistic shape.

**Change 1 — lane-refill streaming kernel (lib.rs `stream_escape_quadratic`):**
replaces the fixed quad batches for wasm32/exponent-2 tiles. STREAM_CHAINS=4
f64x2 vectors (8 pixels) stay permanently busy; a lane is retired and
refilled the moment its pixel escapes / goes periodic / exhausts budget, so
no lane idles waiting for a slow neighbor (fixed batches pay max-of-batch —
expensive exactly when a near-max escaper sits beside fast escapers). All
bookkeeping (retire/refill, budget compare, periodicity save/compare — the
save schedule fully vectorized per-lane via mask selects) runs every
STREAM_STRIDE=16 steps; escaped lanes freeze iter/z exactly via the alive
mask, so results are bit-identical. Parameter sweep: chains 2/4/6/8 →
4 optimal (2 much worse: bookkeeping without ILP to hide it, refill2 LOST
+4-17% on escaper tiles at stride 4; 6/8 flat-to-worse — register spills);
stride 4→8 −18% uniform, 8→16 another −5-9%, 32 past the knee (delayed
periodicity hurts interior-heavy tiles). Net refill4-s16 vs base: **−44.2%
geomean, −35 to −64% every case.**

**Change 2 — Mariani–Silver subdivision (lib.rs `stream_tile_subdivided`):**
wave-based worklist over sub-rects; each wave streams all pending rects'
uncomputed border-ring pixels through the refill kernel in ONE call, then
per rect: ring all max_iterations → fill inside as interior (no compute);
else split into quadrants; dims ≤ MARIANI_LEAF compute directly. Every pixel
computed at most once, so escaper-only tiles pay only bookkeeping (seahorse
delta identical with/without). Fill exactness: in the continuum a max-iter
ring cannot enclose an in-budget escaper (maximum principle on the Green's
function); only sub-pixel channels break it — the same assumption
rect_in_set already makes at tile level. Leaf sweep: 16 much worse, 4
fastest (−10% vs 8), 2 ≈ 4. **Shipped leaf 8, not 4:** leaf 4's finer fills
misfilled 6 more single-pixel escaper specks on 2 realistic focused cases
(r075: 1px, efar: 5px); leaf 8 diffs only on the degenerate trapped-cusp
control (2 isolated specks on the channel centerline, each fully surrounded
by max-iter pixels in the baseline output; a third speck survived by landing
on a ring). Accepted deliberately: same artifact class the tile-level
rect_in_set already produces resolution-dependently (the same tile is
solid-blacked entirely at 100x100), iteration stats unchanged, and all 35
standard-corpus cases byte-identical (official pixel-check) including
dendrite/filament views and every user case.

Wasm-level (run.mjs, hi-border corpus, 10 samples), final config
(chains 4 / stride 16 / leaf 8) vs clean-tree base:

| case | refill only | + Mariani |
|---|---|---|
| hi-border-z36-rep-u1 | −43.8% | −57.6% |
| hi-border-z36-rep-r075 | −40.2% | −75.8% |
| hi-band-z39-efar | −42.0% | −74.7% |
| hi-band-z38-nedge | −37.5% | −87.2% |
| hi-border-z30-seahorse | −34.9% | −34.4% |
| hi-mixed-z12-valley | −63.9% | −63.1% |
| geomean (7 cases) | −44.2% | **−65.4%** |

Full standard corpus: direct **−13.8%** geomean, perturbation-f64 +0.6%,
float-exp +0.1% (untouched). Known cost: two z0 whole-set user views
+18-24% — but those are ~3 ms tiles (+0.5-0.7 ms of wave/gather overhead);
multibrot (exponent ≠ 2) keeps the old fixed-batch path.

Correctness: cargo test 59/59; pixel-check all 35 standard cases
byte-identical; focused-corpus diffs limited to the justified specks above
(values buffers and min/max iteration stats otherwise identical).

E2E (run-e2e.mjs, complete builds pre=HEAD@d7dd95d / post=this change):
- Standard grid corpus: z36/i51200 **−47.2%** (cold −46.9%), z46 −22.2%,
  z20 −16.4%, z48 pf64 +0.0%, z259 float-exp +0.2%. Overall **−19.2%.**
- Focused grid corpus: report grid −47.5% (cold −47.5%), rep-up4 −9.5%,
  valley −16.5%. Overall **−26.5%.**
- Cold tracks warm everywhere: the existing worker tier-up warmup renders
  64x64 exponent-2 tiles through the new kernel, satisfying the standing
  SIMD-warmup rule with no new Liftoff penalty.

Size: bench artifact 283.2 → 290.5 KiB (+2.6%); production module wasm
284.3 → 291.6 KiB.

Reproduce: `node src/run.mjs --variants base-border,mariani8 --corpus
corpus/hi-border.json --filter hi- --budget-ms 30000`; e2e as usual, plus
`--corpus corpus/hi-iter-direct-grid.json` for the focused grid.

Verdict: shipped. Follow-ups: (a) z0 small-tile wave/gather overhead is the
only measured regression — micro-opt the point-gather path if whole-set
loads ever matter; (b) exponent ≠ 2 could reuse the stream kernel with a
general-exponent step; (c) the perturbation-f64 delta loop could get the
same refill treatment (its batches also pay max-of-pair) — measure first;
(d) orbit cache sharing remains the top deep-zoom item.
[2026-07-07, later: (d) was a misattribution — see the hybrid float-exp
entry below.]

## 2026-07-07 — SHIPPED: hybrid f64/ComplexExp float-exp loop (z259 e2e −84.7%)

Machine: mac arm64 (M1 Pro, 8 logical cores), Chrome for Testing 136,
macOS 14. Code change only, production flags throughout. Session directive:
weight experiments by absolute wall-time saved (30→20 s outweighs 3→2 s
tenfold) and re-audit verdicts reached under naive criteria.

**Corrected verdict (audit finding):** the 2026-07-04 claim "deep-zoom page
loads are dominated by per-worker reference-orbit recomputation" — which
promoted orbit cache sharing to top backlog item — was wrong. A cold/warm
probe (run.mjs, user-z259-3898a95f) showed cold 1325 ms vs warm 1307 ms:
the arbitrary-precision orbit costs ~18 ms; the per-pixel ComplexExp delta
loops are the other ~1300 ms. ComplexExp optimization had been deprioritized
*because of* that misattribution. Orbit sharing demoted (would save
~18 ms/worker once per view). No other logged verdict flips under
time-weighted criteria: the z0 whole-set +18–24% (≈+0.6 ms/tile) and
syn-fexp-z500-cusp-hi +2.5% below are correctly accepted costs, and the
opt3+simd128 "e2e neutral" call still nets positive absolute time (z259
−3.5% ≈ −540 ms vs z46/z48 +5.7% ≈ +290 ms).

**Change (perturbation.rs):** per-pixel hybrid delta loop for the float-exp
pathway (exponent 2, `dc.exp >= -800`). While `|dz|²` stays above 2^-800,
the step runs in plain f64 — bit-identical there because every ComplexExp
op is the same mantissa arithmetic at a power-of-two scale, and the margins
(promote at dz ≥ 2^-380, dc ≥ 2^-800, redo floor at |dz|² < 2^-800) keep all
intermediates plus the 120-bit `+ dc` alignment window clear of subnormals.
A step whose result dips below the floor is *redone* in ComplexExp from the
exact pre-step state, so no f64 rounding of the dip is ever observed; the
pixel demotes to the ComplexExp loop and re-promotes when the delta grows
back. At z259 (dc ≈ 2^-259) pixels run essentially 100% in the f64 phase.

Wasm-level (run.mjs, full 35-case corpus, 10 samples) vs clean-tree base:

| case | delta |
|---|---|
| user-z259-3898a95f | **−85.0%** (1305 → 196 ms; cold −84.8%) |
| syn-fexp-z300-dendrite / -cusp | −83.8% / −83.8% |
| syn-fexp-z500-needle | −58.0% (small-mode phase longer at 2^-500 deltas) |
| syn-fexp-z500-cusp-hi | +2.9% (near-parabolic pixels never promote; below sig floor) |
| direct / perturbation-f64 geomean | −0.2% / +0.0% (untouched) |
| float-exp geomean | **−72.7%** |

Correctness: cargo test 59/59; pixel-check all 35 cases byte-identical
(the bit-exactness argument held empirically, including deep user cases).

E2E (run-e2e.mjs, complete builds pre=HEAD@aff677c / post=this change,
5 rounds): **grid-z259-i1600 15586 → 2382 ms (−84.7%, cold −84.9%)**; z36
+0.6%, z46 −0.8%, z20 +0.6%, z48 +0.2% (all within noise); overall geomean
−31.2%. Cold tracks warm (scalar loop, no new hand-SIMD, warmup rule n/a).
Slowest standard case is now grid-z48-i20000 (pf64) at ~3.4 s.

Size: bench artifact 290.5 → 293.1 KiB (+0.9%); dist module wasm
291.6 → 294.2 KiB.

Reproduce: `node src/run.mjs --variants base259,hybrid-fe --filter float-exp`;
e2e as usual with the standard grid corpus.

Verdict: shipped — the largest absolute win so far (~13.2 s off the slowest
e2e case). Follow-ups moved to the skill backlog: pf64 delta-loop refill
(now the slowest case), SIMD for the hybrid's f64 phase (z259's remaining
2.4 s), rescaled-epoch loop if z400+ traffic materializes.

## 2026-07-08 — Corpus expansion: 7 probed pf64 user cases + holdout ship gate

Machine: mac arm64 (M1 Pro), Chrome for Testing 136. No production code
change — corpus + skill guidance only.

Probed 54 deduped pf64 candidates from events_rows.csv at 64x64 (interior
fraction, escaper mean/p50/p90/p99, iteration sum). Export findings: the
pf64 tier in real usage is essentially all z47–59 (exactly one view past
z60); exactly one float-exp view exists (the z259 already in the corpus);
the slowest real views are 25–50k-iteration pf64 tiles the old corpus
(capped at i20000) never covered.

Added (all perturbation-f64; heavy cases carry tileSize overrides so
samples fit the budget — per-pixel cost is size-invariant):
- user-z47-fb5f0315 i50000 @100px — heaviest real e2 view: 62% interior,
  escaper mean 49.7k/50k (trapped needle channel), ~3.1 s/sample
- user-z48-0a309fb2 i48000 @100px — cusp channel, 68% interior + trapped
- user-z48-f36112fd i50000 @100px — border band, 19% interior, mean 40k
- user-z47-da3d5543 i25600 — fully in-set (border_in_set shortcut path)
- user-z48-58cd3904 i25600 e4 — fully in-set multibrot (general-exponent
  border pixels)
- user-z48-6481040a i999 — low-iter, 60% interior + near-max escapers
- user-z48-0611aae8 i45999 e52 @64px — slowest real view in the export
  (~60 s/tile at 200px): the O(exponent) Horner delta step dominates
  (escaper mean only 100). Candidate target for a future experiment.

Corpus 35 → 42 cases; pixel-check base259 vs hybrid-fe: all 42
byte-identical (hybrid bit-exactness holds on the new views too).

Also added to the skill: holdout validation as an anti-overfitting ship
gate (fresh seeded sample from events_rows.csv, excluding corpus views,
per-tier, pre/post at low sample count) — the fixed corpus stays the
iteration target, the holdout guards tuned constants and accepted diffs.
Possible follow-up flagged: the e2e grid corpus has no heavyweight pf64
case; the z47 i50000 view would represent real ~90 s page loads but would
roughly double e2e runtime — decide deliberately.

## 2026-07-08 — Composition-aware corpus pipeline + holdout validator (harness only)

Machine: mac arm64 (M1 Pro), Chrome for Testing 136. No production code
change — bench harness, corpus, and skill docs only. Baseline artifacts
built at 29e7970 (== HEAD wasm; later commits are docs/corpus only).

**New probe stage (bench/src/enrich.mjs + window.probeCase in page/bench.js):**
every corpus row and every ingest candidate is rendered at 64x64 through
`get_mandelbrot_tile_precise(include_values=true)` and reduced in-page to a
compact stats block: interior (= did-not-escape) fraction, near-max escaper
fractions (>50%/>90% of budget), escaper mean/p50/p90/p99, total iteration
sum (machine-independent work proxy), and an FNV-1a hash of the values
buffer (blessed-output hash). Stats are variant-invariant (escape counts are
the correctness invariant) and committed into corpus rows with provenance
(generator version, artifact sha, date); probe wall times are advisory only.
Probes are cached (results/probe-cache.json, machine-local), watchdogged
(default 15 s budget, skip-and-flag with session restart), and re-runs are
idempotent — unchanged stats keep their original provenance, and a third
`--write` left corpus.json byte-identical. `node src/enrich.mjs --check
<variant>` is the drift detector (all 43 cases matched blessed hashes for
baseline); `--check <v> --bless` is the documented re-bless flow for
intentional output changes.

**Selection rework (bench/src/ingest.mjs):** replaces pathway x
iteration-tercile bucketing. All 24,328 export rows -> 18,370 deduped
candidate views (16,644 direct / 1,725 pf64 / 1 float-exp), all probed in
~2.5 min (cold cache). Per tier: heaviest by iteration sum (in-set class
excluded from heavy slots — nominal sums are huge but rect_in_set renders
them in ~0 ms), border-heavy by near-max escaper fraction, one
most-frequented pick (per-view user weight: distinct sessions + 365-day
recency-decayed sum, aggregated in ingest — session ids never reach the
corpus), coverage picks per composition class (in-set, interior, trapped,
border, multibrot, low-iter), and a zoom-max pick for perturbation tiers
(orbit-length coverage). The 7 hand-picked 2026-07-08 pf64 cases are pinned
(`"pinned": true`) and their stats backfilled; notes/overrides preserved.

Why terciles failed: the raw `iterations` parameter is a poor work proxy.
The old tercile-selected user set had NO direct-tier case above 3.5M probe
iterations; the export's real heavy direct views run 68–204M (e.g. z28
i50000 border view: 1.3 s/tile, escaper mean 41k). Old->new: 26 -> 27 user
cases (11 direct / 15 pf64 / 1 fexp), 17 light incumbents dropped (all
<=6.4M iterSum, <=47 ms probes — reviewed side by side in the ingest
report), 10 new heavy/border cases added, z85 (deepest real pf64 view) and
z259 kept. Corpus 42 -> 43 cases; two-variant full run ~13 min (recorded
samples+cold 553 s; tileSize overrides at 100/64 keep the 9 heavy cases in
budget). Dropped z0 whole-set user views were the accepted-cost +18-24%
(~3 ms) cases from the Mariani entry; syn-direct-z3-home remains the
small-tile overhead guard.

**Runner integration:** run.mjs prints ms per million iterations (probe
iterSum scaled to case tileSize) next to each median — the structural
slowness detector. On the A/A run pf64 escaper cases cluster at 6.2–6.8
ms/Miter while the e52 Horner case sits at 202.7 (O(exponent) delta step)
and direct multibrot at 11.7 — exactly the signal that would have exposed
the z259 ComplexExp misattribution (LOG 2026-07-07) immediately.
compare.mjs adds interior%/near-max90% composition columns and two weighted
summary lines (weighted geomean by baseline median ms, and by user
frequency) alongside the geomeans.

**A/A validation (baseline vs baseline2, 10 samples, full new corpus):**
zero false significants across 43 cases; geomeans direct +0.4% / pf64 +0.0%
/ float-exp +0.2% / overall +0.2%; time-weighted -0.0%; user-weighted
-0.4%. No drift against blessed hashes.

**Holdout validator (bench/src/validate.mjs, skill ship gate):** dedupes
the export, excludes corpus views, stratified-samples per tier (seeded;
default seed = today's date so each experiment gets a fresh sample), runs
a/b run.mjs-style at --samples 3 / --budget-ms 8000 / tileSize 100, reports
per-tier geomeans, worst movers, time-weighted delta; --pixel-check mode
byte-diffs outputs on the holdout. A/A noise floor (seed aa-noise-floor,
40/tier): all aggregates within +/-0.1%; three sub-ms/13-ms views
false-flagged at up to +5.9% (MAD unreliable at n=3) — judge on aggregates,
re-run single movers with --samples 10. Float-exp holdout pool is empty
(the export's only fexp view is in the corpus) — synthetic cases remain the
only deep-zoom guard. Pixel-check mode verified byte-identical on an A/A
sample. Full 80-view timing run ~5 min.

**Flagged, not changed:** corpus/grid-regression.json still has no
heavyweight pf64 e2e case (backlog #4 decides this deliberately — the z47
i50000 view represents real ~90 s page loads but roughly doubles e2e
runtime). The composition stats now on every corpus row are the input that
decision needs.

Reproduce: `node src/ingest.mjs ../events_rows.csv --artifact baseline`
(report only; --write to apply), `node src/enrich.mjs --check baseline`,
`node src/run.mjs --variants baseline,baseline2`,
`node src/validate.mjs --variants baseline,baseline2 --seed aa-noise-floor`.

## 2026-07-08 — Backlog items 1–4 resolved: pf64 verdicts re-validated on the heavyweight cases

Machine: mac arm64 (M1 Pro, 8 logical cores), Chrome for Testing 136,
macOS 14. No production code change — measurements, harness parity fix,
corpus addition, and backlog re-ranking only. Baseline artifact = HEAD wasm
(29e7970); scalar-pf64 artifact built from a git worktree at 2210aea
(pre-pairing scalar code + shipped flags; build.mjs has no --ref, so the
build steps were reproduced manually — 271.0 KiB output matches that ref's
logged size exactly).

**Item 1 — A/A noise floor on the heavy cases: settled, no new run.** The
2026-07-08 A/A (results/aa-new-corpus.json, 10 samples, full 43-case corpus)
already includes all seven heavy additions: every heavy case within ±0.4%,
zero false significants corpus-wide, aggregates ≤ +0.4%. The 3% significance
floor holds despite budget-trimmed samples (~4 on the heaviest cases).

**Item 2 — f64x2 pairing re-validated on heavyweight pf64: verdict holds,
stronger than originally claimed.** scalar-pf64 vs baseline,
`--filter user-z4 --budget-ms 30000`, 10 samples
(results/2026-07-08T01-29-57-137Z-scalar-pf64_baseline.json):

| composition class | cases | delta |
|---|---|---|
| trapped channels (fb5f0315 i50000, 0a309fb2 i48000) | 2 | −11.0% / −10.2% |
| border band, wide spread (f36112fd i50000, d0e211ec) | 2 | −9.9% / −10.7% |
| interior-heavy (953fa585, 9d06c2d7) | 2 | −10.5% / −10.4% |
| all other exponent-2 pf64 | 7 | −10.2% to −11.0% |
| in-set multibrot e4 (58cd3904) | 1 | +0.0% (scalar fallback) |
| e52 Horner (0611aae8 i45999) | 1 | **−0.2% (untouched)** |

Every exponent-2 case −9.9% to −11.0%, all significant; the feared
max-of-pair penalty on wide-spread border compositions is ≤ ~1 point. Cold
tracks warm on all 14 cases (−0.0% to −10.9%). Size delta in the comparison
(271.0 → 293.1 KiB, +8.1%) is cumulative over everything shipped since
2210aea, not pairing alone (pairing itself was +1.6%, LOG 2026-07-02).
First-ever measurement of the e52 case: **195.99 ms/Miter vs 6.1–6.7 for
every exponent-2 pf64 case** — the O(exponent) Horner delta step is ~32x
structurally slower, exactly what the ms/Miter column exists to expose.

**Item 3 — the 2026-07-06 "no pf64 interior treatment" decision is
contradicted and reopened.** Its premise (pf64 pixels rarely run full budget
at z47+) fails against the probe data. Upside cap per case = interior share
of iteration work (interior% x budget x pixels / iterSum) x baseline median:

| case | interior work share | cap on baseline median |
|---|---|---|
| user-z48-0611aae8 (e52) | 98.9% | ~6.3 s of 6.4 s |
| user-z48-9d06c2d7 | 94.3% | ~1.4 s of 1.5 s |
| user-z47-953fa585 | 90.2% | ~1.4 s of 1.5 s |
| user-z48-0a309fb2 | 75.8% | ~2.0 s of 2.6 s |
| user-z47-fb5f0315 | 62.5% | ~1.9 s of 3.1 s |
| user-z48-4ef9f039 | 49.8% | ~0.8 s of 1.5 s |
| user-z48-f36112fd | 22.4% | ~0.6 s of 2.6 s |
| user-z48-d0e211ec | 8.8% | ~0.2 s of 1.9 s |

Roughly 60% of the heavy-pf64 corpus time is interior pixels grinding the
full budget. Trapped-channel *escapers* (49.7k/50k) remain out of reach, as
the backlog predicted — the caps above already exclude them. Mechanism note:
closed-form cardioid/bulb checks cannot work at z47+ (the test needs c
resolved beyond f64), but the paired loop already reconstructs full
z = ref + dz every step (perturbation.rs pair_step), so exact-equality Brent
periodicity on reconstructed z bolts on like the direct path's vectorized
save schedule. Whether the computed sequence becomes exactly periodic
through delta+rebase arithmetic is the prototype's empirical question
(after a rebase the state is self-consistent in (dz, index), so exact cycles
are plausible).

**Item 4 — tier-up warmup holds at heavyweight pf64 scale; no pf64 warmup
tile needed.** Harness parity fix first: bench/page/grid-worker.js now runs
the identical two-tile warmup as production client/js/worker.js at init
(it previously had none, so cold passes overstated what real page loads
pay). run-grid, z47 i50000 grid (45 tiles, 7 workers), 1 cold + 1 warmup +
3 rounds (results/grid-z47-heavy-coldwarm.json): **cold 99596 ms vs warm
median 99189 ms (±974) — +0.4%, within noise.** The direct-tile warmup
suffices even though the pf64 paired loop is a different function; the
compile-contention regime that caused the original +18% regression does not
reproduce here. Also confirms this view is a ~100 s real page load — the
slowest real regime in the export. Decision per the backlog: grid-z47-i50000
added to corpus/grid-regression.json so the e2e ship gate covers the
heavyweight pf64 regime; it adds ~100 s per round per variant (a two-variant
5-round e2e gains ~20 min) — use `--filter` to skip it during iteration.

**Verdict / re-ranked priorities.** Items 2+3 converge on one experiment,
now backlog #1: port the direct pathway's lane-refill stream kernel to the
exponent-2 pf64 delta loop with vectorized Brent periodicity on
reconstructed z (refill/ILP expected −20–40% on every heavy e2 pf64 case;
periodicity upside additionally capped by the table above). New #2: scalar
periodicity in the general-exponent delta loop — the e52 case (slowest real
view, 6.4 s median tile at 64px, ~99% interior work) is untouched by all
SIMD work and needs only the cheap scalar check. No shipped verdict flips:
pairing stays shipped, warmup rule stays as-is.

Reproduce: `node src/run.mjs --variants scalar-pf64,baseline --filter
user-z4 --budget-ms 30000`; `node src/run-grid.mjs --variants baseline
--corpus <z47-grid-case> --rounds 3` (case now in grid-regression.json,
id grid-z47-i50000-fb5f0315).

## 2026-07-08 — SHIPPED: pf64 lane-refill stream kernel + Brent state-periodicity (backlog #1 + #2)

Machine: mac arm64 (M1 Pro, 8 logical cores), Chrome for Testing 136,
macOS 14. Code change only (mandelbrot/src/perturbation.rs, lib.rs); no
flag or config changes. Pre-change ref: 8dd0e98.

**What changed:**
1. Brent-style periodicity on the *full perturbation state* `(dz,
   reference_index)` in the scalar f64-delta loop (all exponents) and the
   pf64 pair kernel. State equality — not reconstructed z as the backlog
   sketched — is the sound check: the step map is deterministic in that
   state, so an exact recurrence proves the pixel can never escape, and
   returning max_iterations is bit-identical to grinding the budget (z is
   unused for interior pixels). A z-only check can false-positive because
   distinct states reconstruct the same z.
2. `stream_perturbed_escape_f64`: the direct pathway's lane-refill stream
   kernel ported to the exponent-2 f64-delta path — 4 chains x 2 pixels via
   the existing `pair_step`, bookkeeping (retire/refill, budget, periodicity)
   every 16 iterations, lanes refilled the moment a pixel finishes. Wired
   through `PerturbedFrame::compute_all` in `render_tile_precise`.
   `border_in_set` stays on the early-exit pair path (streaming the whole
   border would forfeit the first-escaper exit).

**Empirical findings (native probe, 2 minutes, before stage B):** the
periodicity half of the e2 upside estimate was falsified. Interior e2
pixels at z48 never rebase — dz stays tiny relative to z, so
reference_index climbs monotonically to orbit end and the state cannot
recur within budget (probe: 0 mid-orbit rebases on 8/8 pixels of the
9d06c2d7 view). Even z-only recurrence fired on just 1/8 pixels (at iter
20332/25600): index drift changes the rounding path each step. The
interior-heavy e2 win therefore comes entirely from refill/ILP width. The
e52 view is the opposite regime: |z|^52 swings force frequent rebases,
state cycles are short, and scalar periodicity alone cuts the slowest real
view in the export by 31% (6.40 -> 4.42 s at 64px).

**Wasm-level (full 43-case corpus, 10 samples, baseline vs pf64-stream):**
pf64 geomean **-38.9%** — every heavy e2 case -42% to -54% (953fa585
1512 -> 705 ms; 9d06c2d7 1482 -> 677 ms; fb5f0315 3049 -> 1486 ms; dc40277a
2486 -> 1216 ms), e52 -31.0%, z85 -47.6%; e2 pf64 ms/Miter 6.2 -> ~2.9.
direct -0.0%, float-exp -0.1% — untouched. Fully-interior e2 tiles
(da3d5543, cusp synthetics) unchanged as predicted: border_in_set
dominates them and interior pixels cannot cycle without rebases. Cold
tracks warm on all pf64 cases (-42% to -52% cold on the heavy cases).
Chain count: CHAINS=2 is +55% vs 4; CHAINS=8 within noise of 4 (-1%) —
kept 4, matching the direct kernel. Artifact size 293.1 -> 298.9 KiB
(+2.0%).

**Correctness:** cargo test 59/59; pixel-check byte-identical on all 43
corpus cases; enrich --check matches all blessed hashes. Zero output
change — no re-bless, no --allow-diff.

**Holdout ship gate (seed 2026-07-08, 40 views/tier):** pf64 geomean
**-39.9%**, direct +0.1%, time-weighted -33.9%; worst mover in the wrong
direction +0.8% (a fully-interior view, noise-level). No pixel-check run
on the holdout (no accepted output diff exists).

**E2E ship gate (pre-stream @8dd0e98 vs post-stream, 5 rounds + cold):**

| case | pre | post | warm | cold |
|---|---|---|---|---|
| grid-z47-i50000-fb5f0315 | 98955 ms | 59418 ms | **-40.0%*** | -40.9% |
| grid-z48-i20000-d0ddf3dd | 3378 ms | 2181 ms | **-35.4%*** | -33.0% |
| grid-z36 / z46 / z20 / z259 | — | — | -0.1..-0.4% | ±1% |

Overall e2e geomean -14.7%. Cold passes track warm everywhere — the
existing direct-tile tier-up warmup covers the new kernel (standing SIMD
warmup rule satisfied, no extra warmup tile added). Production wasm
294.2 -> 300.0 KiB (+5.8 KiB, +2.0%) — the slowest real page load in the
export drops from ~99 s to ~59 s for that size cost.

**Verdict: shipped.** Backlog #1 and #2 both resolved. Not pursued:
periodicity for fully-interior e2 pf64 borders (needs rebases that never
happen; revisit only if in-set pf64 traffic shows up heavy in user data).

Reproduce: `node src/run.mjs --variants baseline,pf64-stream`;
`node src/validate.mjs --variants baseline,pf64-stream`;
`node src/build-dist.mjs pre-stream --ref 8dd0e98 && node
src/build-dist.mjs post-stream && node src/run-e2e.mjs --variants
pre-stream,post-stream`.

## 2026-07-08 — SHIPPED: general-exponent pf64 stream kernel + conditional multibrot tier-up warmup

Machine: mac arm64 (M1 Pro, 8 logical cores), Chrome for Testing 136,
macOS 14. Code change only (mandelbrot/src/perturbation.rs,
client/js/worker.js, client/js/MandelbrotMap.ts); no flag changes.
Pre-change ref: 45b903d. Chosen over the static backlog #1 (float-exp
big-phase SIMD, ~1.2 s upside on the one z259 view) by absolute-time
weighting: the e52 view — the slowest real view in the export — was
untouched by every SIMD kernel shipped so far (exponent != 2 fell back to
the fully scalar loop; 196 ms/Miter vs ~2.9 for e2 pf64).

**Change 1 (perturbation.rs):** `pair_delta_step<const GENERAL: bool>` —
the O(exponent) Horner delta step evaluated for both f64x2 lanes at once
(coefficients are lane-invariant scalars; per-lane ops are IEEE-identical
to scalar `delta_step_f64`, so results are bit-identical). `pair_step`,
the pair kernel, and the stream kernel take the exponent + a `GENERAL`
const-generic; `compute_all` / `escape_iterations_pair` now route ALL
f64-delta tiles (any exponent 2..=64) through the stream/pair kernels,
dispatching on exponent==2 at the entry points. **Monomorphization is
load-bearing:** a first version with a runtime `exponent == 2` branch
inside `pair_step` cost every e2 pf64 case +3–6%; the const-generic split
restored e2 to baseline exactly.

**Change 2 (worker.js + MandelbrotMap.ts):** conditional tier-up warmup.
The general kernel is a separate wasm function, so the existing spawn
warmup never tiers it and the first e2e run showed the win capped at −8%
(Liftoff): post cold ≈ warm ≈ 122 s vs ~74 s tiered. An unconditional
extra warmup (2 tiny e52 renders) unlocked −44.6% but cost EVERY light
page load +60–75 ms (z20 +10.7%, z46 +8.7%, z36 +6.9%, z259 +3.1%) — an
unacceptable tax for a rare view type. Shipped design: worker exposes a
`warmupGeneral` request (2 renders of the e52 view at 32x32 / i=300 —
probed 5% interior, escaper mean ~139, so border_in_set fails fast and
all pixels stream); `createPool` sends it per worker at spawn only when
`config.exponent != 2`. Share-URL loads recreate the pool after URL
parsing (`setConfigFromUrl` → `refresh`) and exponent changes go through
`refresh`, so every multibrot pool is warmed and exponent-2 loads pay
nothing.

Wasm-level (run.mjs, full 43-case corpus, 10 samples, base-e52 vs
e52-stream, both @45b903d):

| case | delta |
|---|---|
| user-z48-0611aae8 (e52, i45999) | **−46.5%** (4425 → 2367 ms @64px; 138.6 → 72.7 ms/Miter) |
| user-z48-58cd3904 (e4 in-set multibrot) | −31.5% |
| syn-pf64-z100-multibrot3 (in-set) | −27.1% |
| pf64 geomean / direct / float-exp | −7.6% / −0.2% / +0.1% |

e2 pf64 cases all within noise (the focused 11-case run showed +0.1–0.6%).
Correctness: cargo test 59/59; pixel-check byte-identical on all 43 cases;
enrich --check matches all blessed hashes; no output diff anywhere.

Holdout ship gate (seed 2026-07-08, 40/tier): pf64 −2.8%, direct −0.3%,
multibrot holdout views −23% to −53%. One flagged mover
(hold-z48-da230d26, e2, +65.7% at n=3) re-ran at **−0.4%** with
--samples 15 — n=3 scheduler/GC fluke, as the validator's noise-floor
note predicts for ~16 ms views.

E2E (complete builds pre=45b903d / post=this change):
- Standard grid corpus: all six cases ±1.7%, overall geomean +0.3% —
  no regression, no warmup tax (their URLs carry no exponent).
- grid-z48-e52-0611aae8 (new corpus/grid-multibrot.json, 800x600, the
  e52 view at production tile size): **133.4 → 73.9 s (−44.6%, cold
  −44.7%)**. Without the warmup the same wasm delivered only −8.0%
  (whole-tile Liftoff execution: the stream kernel is one call per tile,
  so tier-up never lands mid-tile) — the standing SIMD-warmup rule
  strikes again, now per kernel *instantiation*.
- run-e2e.mjs now passes `e=<exponent>` in case URLs;
  grid-multibrot.json stays out of grid-regression.json deliberately
  (~2–4 min/round/variant) — run it when touching the general kernels.

Size: bench artifact 298.9 → 305.9 KiB (+2.3%); dist module wasm
300.0 → 307.1 KiB (+2.4%) — the duplicated stream-kernel instantiation.

**Finding for the backlog (not shipped):** the unconditional-warmup run
showed heavy e2 pf64 loads improving from *extra spawn-time execution
volume alone* — z47-i50000 −15.9% (−8.7 s!), z48-i20000 −10.6% — i.e.
the current two-render direct warmup does not exhaust V8's per-instance
dynamic-tiering budget, and heavy pf64 first-tiles still run partly under
Liftoff. A follow-up could recover seconds on the slowest real e2 loads
by adding cheap spawn volume (or deferring it off the critical path),
paying tens of ms on light loads — needs its own cost/benefit e2e matrix.

Verdict: shipped — the slowest real view in the export drops from
~133 s to ~74 s per page load end-to-end (−44.6%), on top of the −31%
it got from scalar periodicity yesterday; all other traffic unaffected.

Reproduce: `node src/run.mjs --variants base-e52,e52-stream --filter
user-z48 --budget-ms 30000`; `node src/validate.mjs --variants
base-e52,e52-stream`; e2e standard corpus as usual plus `node
src/run-e2e.mjs --variants pre-e52,post-e52 --corpus
corpus/grid-multibrot.json --viewport 800x600 --rounds 2 --warmup 0`.

## 2026-07-08 — SHIPPED: conditional deep-zoom (pf64) spawn warmup — backlog #1

Machine: mac arm64 (M1 Pro, 8 logical cores), Chrome for Testing 136,
macOS 14. Client JS change only (client/js/worker.js,
client/js/MandelbrotMap.ts); no Rust, no flags, wasm byte-identical
(307.1 KiB both sides). Pre-change ref: 3372666.

Follow-up to yesterday's finding: the spawn warmup only exercised the
*direct* kernel, so the exponent-2 pf64 stream kernel (a separate wasm
function) ran heavy first tiles partly under Liftoff — the unconditional
e52-warmup probe had shown z47-i50000 −15.9% from spawn execution volume
alone.

**Change:** worker exposes a `warmupDeep` request; `createPool` sends it
per worker at spawn when the initial view is already at deep-zoom depth
(`config.zoom >= 47`, mirroring DEEP_ZOOM_THRESHOLD in perturbation.rs)
and the exponent is 2 (multibrot pools already get `warmupGeneral`).
Shallow loads pay nothing; shallow views that later zoom past the
threshold tier up naturally over their first tiles.

**Warmup tile design (probed before implementing):** at pf64 depths a
tile is either fast-escaping or fully capped, and capped tiles are a trap:
the trapped-channel candidate (z47 needle coords) probed 100% interior
with identical wall time at cap 1000 vs 2000 — border_in_set fills the
tile and the kernel never runs. Shipped tile: dendrite tip (0, 1) at
effective zoom 48 (0% interior, escapers mean ~40, so nothing
short-circuits and lanes refill constantly), volume via pixel count
instead of iteration depth: 256x256, ~2.6M iterations/render, 2 renders
(~31 ms cold / ~16 ms tiered each), plus a 2000-step dashu reference
orbit that warms the bignum code deep views run cold per worker.

E2E (complete builds, pre=3372666 / post, standard grid corpus + 2 new
light-pf64 tax cases, 3 rounds):

| case | delta (warm) | cold |
|---|---|---|
| grid-z47-i50000 | **−16.2%** (54.6 → 45.8 s) | −16.0% |
| grid-z48-i20000 | **−12.6%** (2154 → 1881 ms) | −12.0% |
| grid-z48-i800 (light pf64) | **−7.1%** (891 → 828 ms) | −5.2% |
| grid-z85-i200 (ultra-light pf64) | +5.7% (401 → 424 ms) | +5.2% |
| grid-z20 / z36 / z46 / z259 | ±1.1% (gated off / untargeted) | — |

Overall geomean −4.2%. **Accepted trade-off, stated explicitly:** the
+23 ms on the 0.4 s z85-i200 view (warmup cost exceeds tiering benefit at
200 iterations) buys −8.9 s per load on the heaviest real pf64 view and
−273 ms on z48-i20000 — absolute-time weighting says that is a bargain.
Both light views are now committed grid-regression cases so future
spawn-time work stays honest.

**Volume matrix (2 vs 4 renders, focused e2e):** doubling spawn volume
bought nothing on the heavies (z47 −0.1%, z48-i20k −0.3% — the kernel is
fully tiered at 2 renders) and doubled the z85 tax to +10.8%. 2 renders
is the knee. Deferred/idle warmup (the backlog's alternative) is moot for
the conditional design: on deep loads the warmup must precede the first
tile to help it, and shallow loads don't run it at all.

Correctness: no wasm/output change possible (warmup renders are discarded;
tile parameters untouched); tsc, eslint, prettier clean. Holdout gate
n/a — the change is invisible at wasm level; e2e is the gate.

Verdict: shipped. Heavy deep-zoom share-URL loads drop 12–16% end to end
on top of yesterday's kernel wins (grid-z47 cumulative 2026-07-07→08:
99 s → 45.8 s).

Reproduce: `node src/build-dist.mjs pre-pf64warm --ref 3372666 && node
src/build-dist.mjs post-pf64warm && node src/run-e2e.mjs --variants
pre-pf64warm,post-pf64warm --rounds 3` (grid-regression.json now includes
the two tax cases).

## 2026-07-08 — SHIPPED: hybrid float-exp stream kernel + conditional float-exp spawn warmup — backlog #1

Machine: mac arm64 (M1 Pro, 8 logical cores), Chrome for Testing 136,
macOS 14. Code change (mandelbrot/src/perturbation.rs) + client warmup
(client/js/worker.js, client/js/MandelbrotMap.ts); no flag changes.
Pre-change ref: cc36994.

After the 2026-07-07 hybrid ship, float-exp pixels spent most iterations
in a *scalar* plain-f64 loop — the only remaining scalar hot loop. This
routes that big phase through the lane-refill stream machinery.

**Change 1 (perturbation.rs):** `stream_hybrid_escape` — the stream kernel
adapted to the hybrid loop (quadratic only, 4 chains x 2 lanes,
bookkeeping every 16 steps, no periodicity — matching the scalar hybrid,
which has none). Pixels start in the small (ComplexExp) phase, so each is
scalar-stepped until its first promotion before being loaded onto a lane
(`hybrid_warm_in`; at z259 that is one step — dc ≈ 2^-259 promotes
immediately). The floor-dip check is vectorized per step (reusing the
|dz|² the rebase test already needs): if any live lane's step lands below
2^-800, the whole chain skips the commit, the dipped lanes are *evicted*
with their exact pre-step state and finished on the scalar hybrid loop
(whose first advance redoes the step in ComplexExp), and surviving lanes
recompute the identical step next pass. A rebase landing below the floor
evicts post-commit in small mode (the scalar demote path). Eviction means
a pixel that leaves the f64 phase loses SIMD for its remainder — at real
depths (z259–300) dips are ~nonexistent, and at z500 the small mode
dominates anyway. Ineligible pixels (dc zero / exp < -800) run the pure
float-exp loop during warm-in. Every scalar path is the existing code, so
results are bit-identical.

**Change 2 (worker.js + MandelbrotMap.ts):** `warmupFloatExp` at pool
spawn when the initial view has `zoom >= 250` (FLOAT_EXP_THRESHOLD) and
exponent 2 — the new kernel is a separate wasm function, so the standing
per-instantiation warmup rule applies (a float-exp view's tiles never run
the pf64 kernel, so this *replaces* `warmupDeep` at those depths rather
than adding to it). Warmup tile probed before implementing: dendrite tip
(0, 1) at effective zoom 260 (escaper-rich, mean ~240 iterations, 0%
interior, nothing short-circuits; 40 ms warm / 68 ms cold at 200px),
shipped at 128x128 / i=1500 / 2 renders ≈ 3.9M iterations per render,
~16 ms tiered.

Wasm-level (run.mjs, full 43-case corpus, 10 samples, baseline vs
fexp-stream, both from clean tree @cc36994):

| case | delta |
|---|---|
| user-z259-3898a95f | **−53.1%** (196 → 92 ms; cold −52.4%; 9.0 → 4.2 ms/Miter) |
| syn-fexp-z300-dendrite | −49.6% (90 → 45 ms) |
| syn-fexp-z500-needle | −16.9% (small-mode phase untouched) |
| syn-fexp-z300-cusp / z500-cusp-hi | −0.1% / +0.0% (near-parabolic, never promote) |
| float-exp geomean / direct / pf64 | **−27.7%** / +0.3% / −0.0% |

Only the three targeted float-exp cases flagged significant, all wins.

Correctness: cargo test 59/59; pixel-check byte-identical on all 43
corpus cases; enrich --check matches all blessed hashes. Zero output
change — no re-bless, no --allow-diff.

Holdout ship gate (seed 2026-07-08, 40/tier; float-exp holdout pool is
empty, so this guards direct/pf64 neutrality): direct +0.2%, pf64 +0.6%,
time-weighted +0.4% — at the A/A floor. One flagged mover
(hold-z48-da230d26, +29.4% at n=3 — the same ~16 ms view that
false-flagged +65.7% last experiment) re-ran at **+0.2%** with
--samples 15.

E2E ship gate (complete builds pre=cc36994 / post, 3 rounds; first run
died with a transient puppeteer detached-frame error after the heavy
cases, light five re-run in a second session):

| case | delta (warm) | cold |
|---|---|---|
| grid-z259-i1600 | **−47.4%** (2375 → 1250 ms) | **−46.7%** (2370 → 1264 ms) |
| grid-z47-i50000 / z48-i20000 | −0.7% / −1.0% | +0.4% / +1.0% |
| grid-z36 / z46 / z20 | −1.6% / +0.1% / −1.9% | ≤±2.9% |
| grid-z48-i800 / z85-i200 (warmup tax guards) | −1.4% / −3.0% | −1.3% / −5.0% |

Cold tracks warm on the target case — the conditional warmup does its
job — and no light case pays a tax (the warmup fires only at zoom >= 250,
where loads take seconds).

Size: bench artifact 305.9 → 315.8 KiB (+3.2%); production module wasm
307.1 → 317.0 KiB (+9.9 KiB) — the second stream-kernel-sized function.

Verdict: shipped. The float-exp tier's page load halves again on top of
the −84.7% hybrid ship (z259 cumulative 2026-07-06→08: 15.6 s → 1.25 s).
Remaining float-exp headroom is the ultra-deep small mode (backlog: z500
cusp-hi never promotes; z500 needle keeps a long ComplexExp phase) — only
worth it if z400+ traffic materializes.

Reproduce: `node src/run.mjs --variants baseline,fexp-stream --filter
float-exp`; `node src/validate.mjs --variants baseline,fexp-stream`;
`node src/build-dist.mjs pre-fexp --ref cc36994 && node
src/build-dist.mjs post-fexp && node src/run-e2e.mjs --variants
pre-fexp,post-fexp --rounds 3`.

## 2026-07-08 — SHIPPED: Mariani–Silver subdivision for the pf64 pathway (exponent 2)

Machine: mac arm64 (M1 Pro, 8 logical cores), Chrome for Testing 136,
macOS 14. Code change only (mandelbrot/src/lib.rs, perturbation.rs); no
flag, config, or client JS changes. Pre-change ref: fa6d90b.

Motivation: after the pf64 stream-kernel ship, interior pixels on *mixed*
e2 tiles were the last untouched cost — they never rebase at pf64 depths,
so (dz, index) periodicity provably cannot retire them, and border_in_set
only catches fully-interior tiles. The heaviest real e2 views are 62–88%
interior, each interior pixel grinding the full 25–50k budget.

**Change 1 (lib.rs):** the Mariani–Silver wave/worklist machinery moved
out of `stream_tile_subdivided` into `subdivide_tile_streamed`, generic
over a compute-wave closure (uncomputed ring pixel indices → results);
the direct pathway is now a thin wrapper around it. Verified neutral for
direct: wasm-level geomean −0.1%, e2e standard corpus ±1%.

**Change 2 (perturbation.rs):** exponent-2 f64-delta tiles route
`compute_all` through the driver over `stream_perturbed_escape_f64`, so
all-max-iter rings fill their inside without computing it. **Multibrot
pf64 deliberately stays on the plain stream call:** the only real
multibrot pf64 view (e52 0611aae8 — 17% *scattered* interior, escapers
dead by ~100 iters) never fills a ring and paid +2.7% (~+2 s at e2e grid
scale on the slowest real view) of pure wave/drain-tail overhead in the
ungated build; the gate returns it to −0.0%.

No new tier-up warmup needed, with one subtlety worth recording: the wave
call site is a *new monomorphization* of the kernel (generic `dc_of`), but
`warmupDeep`'s tile renders through the subdivided path itself, so the new
instantiation is warmed automatically — e2e colds confirm (below).

Wasm-level (run.mjs, full 43-case corpus, 10 samples): pf64 geomean
**−14.0%**, time-weighted −20.3%. Interior-heavy real views:

| case | int% | delta |
|---|---|---|
| user-z47-953fa585 | 86% | **−69.3%** (688 → 211 ms) |
| user-z48-9d06c2d7 | 88% | **−63.9%** (665 → 240 ms) |
| user-z48-0a309fb2 | 68% | **−57.2%** (1196 → 512 ms) |
| user-z48-6481040a | 60% | −17.3% |
| user-z47-fb5f0315 | 62% | −4.3% (trapped *needle channel*: interior too thin for rings to land) |

Fully-interior (border_in_set) and 0%-interior cases neutral; direct
−0.1%; float-exp noise. Artifact 315.8 → 318.8 KiB (+1.0%).

Correctness: cargo test 59/59; pixel-check byte-identical on all 43
corpus cases (the ring-fill produced zero output change); enrich --check
matches all blessed hashes. No re-bless, no --allow-diff.

Holdout ship gate (seed 2026-07-08, 40/tier): pf64 geomean **−10.3%**,
direct −0.9%, no significant wrong-direction mover. Ran `--pixel-check`
despite zero accepted diffs (fill artifacts are exactly the class that
hides on shapes the corpus lacks): all 80 holdout views byte-identical.

E2E ship gate (complete builds pre=fa6d90b / post, 3 rounds): standard
grid corpus all neutral-or-better — overall geomean −0.3%, grid-z47
−1.0% (−450 ms; its grid's makespan is set by trapped-channel tiles where
fills rarely land), light/tax guards within ±1.3%, colds track warm. The
interior-heavy composition class had no e2e representative, so
grid-z48-i48000-0a309fb2 is now a committed grid-regression case:
warm **−9.7%** (17.04 → 15.38 s), cold **−11.2%** (17.25 → 15.32 s).

Size: production module wasm 317.0 → 320.0 KiB (+3.0 KiB).

Verdict: shipped. Interior-heavy deep-zoom loads drop ~10% e2e and up to
~70% per tile at wasm level, output byte-identical everywhere measured.
Not pursued: a finer MARIANI_LEAF might fill fb5f0315's thin channel, but
the direct-pathway leaf sweep showed leaf 4 misfills single-pixel escaper
specks — not worth risking output diffs for one view's remaining −few %.

Reproduce: `node src/run.mjs --variants baseline,pf64-mariani --filter
perturbation-f64`; `node src/validate.mjs --variants baseline,pf64-mariani
--pixel-check`; `node src/build-dist.mjs pre-mariani --ref fa6d90b && node
src/build-dist.mjs post-mariani && node src/run-e2e.mjs --variants
pre-mariani,post-mariani --rounds 3` (plus `--filter 0a309fb2` for the new
case).

## 2026-07-08 — NEGATIVE: iteration-skipping at real pf64 depths (BLA + multiplier interior detection); backlog #4 and #6 closed

Machine: mac arm64 (M1 Pro, 8 logical cores), Chrome for Testing 136,
macOS 14. **No production change.** Two native decomposition probes (kept as
ignored tests in mandelbrot/src/perturbation_test.rs), one flag experiment,
one readout from existing data. Baseline artifact rebuilt at HEAD (7ed51f6).

Target selection: after the 2026-07-07/08 ships, the slowest standard e2e
case by far is grid-z47-i50000 (~45 s; next-worst standard case ~2 s). Its
tiles are trapped needle channel: 62% interior pixels that never rebase (so
(dz, index) periodicity provably cannot fire) in a channel too thin for
Mariani rings, plus escapers at mean 49.7k of 50k. Every pixel grinds
~full budget at the e2 stream kernel's structural norm (~2.9 ms/Miter) —
the remaining cost IS the iteration count, so only iteration-skipping could
cut it. Both known skipping techniques were probed and both fail.

**Probe 1 — BLA (Zhuoran-style bivariate linear approximation),
`bla_probe`:** per-orbit-index affine steps dz -> A·dz + B·dc merged into
power-of-two levels, validity radius r = eps·|A| (single step, quadratic;
general-exponent analogue for e52), merge r = min(r1, (r2 − |B1|·dc_max)/
|A1|), skips aligned at index mod 2^level, exact single steps otherwise.
Native scalar exact loop vs BLA loop on the 6 heavy e2 corpus views + e52
at 100px (bench-corpus coordinates, worker-identical frame math):

| view | eps 2^-24: skipped / native speedup / diff px (max Δiter) | eps 2^-32: same |
|---|---|---|
| fb5f0315 trapped-needle i50k | 93% / 7.2x / 291 (334) | 62% / 1.18x / 27 (53) |
| 0a309fb2 cusp-channel i48k | 88% / 5.5x / 951 (21987) | 30% / 1.34x / 212 (11676) |
| f36112fd border-band i50k | 56% / 1.3x / 4305 (6448) | 27% / 1.05x / 1153 (3203) |
| d0e211ec trapped i32k | 61% / 1.4x / 2408 (1252) | 27% / 1.01x / 494 (916) |
| 953fa585 interior i25k | 18% / 1.2x / 126 (12469) | 6% / 1.04x / 12 (12469) |
| dc40277a border i16k | 84% / 3.2x / 328 (434) | 55% / 1.29x / 75 (188) |

Even at eps 2^-40 (skip rates 0.7–10%, speed ≤ 1.0x) diffs persist:
f36112fd 312 px (max Δ2821), 0a309fb2 24 px (max Δ16363). e52 is a
non-starter (reference orbit escapes at 85 iterations — nothing to compose;
1.0x at eps 2^-40 with garbage z errors). Why it fails here: at z47–59 the
deltas have only ~47 bits of smallness headroom; after the first ~40
doublings — and permanently after any rebase — pixels iterate with O(1)
deltas where the step is genuinely nonlinear, so tolerances tight enough to
respect the output bar leave almost nothing skippable, and the production
SIMD stream kernel is already ~1.7x scalar per step, which eats the entire
1.0–1.35x native-scalar win. The diffs are not ulp-level: chaos amplifies
any rounding-path change into escape-count shifts of hundreds to thousands
of iterations on boundary pixels. BLA remains a z250+ technique; that tier
(one real view) is already at 1.25 s e2e.

**Probe 2 — attracting-cycle (multiplier) interior detection,
`multiplier_interior_probe`:** on an approximate return |z − z_saved| < δ
(Brent-scheduled saves), accumulate the candidate period's multiplier
∏(2z); |m| < margin would retire the pixel as interior. Simulated on the
exact loop without changing it, so retire decisions are compared against
each pixel's true outcome. Result: unsound at useful δ and useless at safe
δ. δ=1e-6: retires 100% of interior pixels (fb5f0315 saves 81% of interior
work) but falsely retires *thousands of escapers* — including all 10000
pixels of the 0%-interior dc40277a view (chaotic orbits pass near z≈0, so a
spurious near-return plus one tiny |2z| factor mimics contraction; margin
0.9 vs 0.99 changes nothing, i.e. the products are garbage, not
near-threshold). δ=1e-9: retires ~nothing on the channel views (0/6184 on
fb5f0315 — the trapped channels are near-parabolic, |m|≈1, so true
convergence never reaches δ within budget) and *still* falsely retires 17
escapers on 0a309fb2. A rigorous ball-arithmetic version would refuse
near-parabolic cycles by construction — firing on exactly nothing here.

**Structural conclusion (the durable one):** within the project's output
bar (byte-identical, or isolated justified artifacts), the pf64 algorithmic
space is now exhausted — refill/ILP, state periodicity, Mariani fill,
general-exponent SIMD kernels, and spawn warmups have all shipped, and both
iteration-skipping families fail. grid-z47's remaining ~45 s is irreducible
exact per-pixel work. Do not re-probe BLA/multiplier variants at z47–59;
any future attack on this case requires an explicit output-policy decision
(perceptual-equivalence gate instead of byte-exactness) taken deliberately,
not as a side effect of a perf experiment.

**Backlog #4 (smooth-coloring cost) — closed, no action.** From the
2026-07-08 A/A data: syn-pf64-z100-dendrite 25.43 ms vs -nosmooth 23.24 ms
at 200px → ~2.2 ms/tile flat post-processing (~55 ns/px). That is ~9% of a
light tile and ~0.05% of the heavy tiles that set page-load times —
below the action threshold under absolute-time weighting.

**Backlog #6 (panic = "abort") — closed, no benefit, not shipped.** Built
via env passthrough (`CARGO_PROFILE_RELEASE_PANIC=abort node src/build.mjs
panic-abort`; build.mjs spreads process.env). Builds are deterministic
(no-flag rebuild is byte-identical to baseline), the flag did change the
binary — and the size delta is exactly **0 bytes** (326491 both): on
wasm32-unknown-unknown panics already lower to abort, so only the linked
runtime shim changes. Speed: 16-case `--filter syn-` run, all pathways
+0.0–0.1% geomean, time-weighted +0.3% — noise. The real wasm size lever
in this family (nightly -Zbuild-std + panic_immediate_abort) is out of
scope on the stable-toolchain policy.

Correctness: cargo test 59/59 (+2 new ignored probes); no wasm change
anywhere, so no pixel-check/holdout/e2e applicable.

Reproduce: `cargo test --release bla_probe -- --ignored --nocapture` and
`cargo test --release multiplier_interior_probe -- --ignored --nocapture`
(probes committed in mandelbrot/src/perturbation_test.rs);
`CARGO_PROFILE_RELEASE_PANIC=abort node src/build.mjs panic-abort && node
src/run.mjs --variants baseline,panic-abort --filter syn-`.

## 2026-07-09 — SHIPPED: per-orbit-index Horner coefficient table + fused-chain general step (e52 e2e −73.3%)

Machine: mac arm64 (M1 Pro, 8 logical cores), Chrome for Testing 136,
macOS 14. Code change only (mandelbrot/src/perturbation.rs); no flag,
config, or client JS changes. Pre-change ref: d85d0cb.

Session directive: "try ideas implemented in performant Mandelbrot set
projects which we haven't tried." Survey outcome: the canon is nearly
exhausted here — perturbation+rebasing, Mariani–Silver, periodicity,
cardioid/bulb, SIMD kernels, warmups all shipped; BLA/SA and multiplier
interior detection settled negative at real pf64 depths; rescaled-epoch
loops traffic-gated (no z400+ views); XaoS-style pixel reuse violates the
output bar. Two untried ideas remained: conjugation-symmetry mirroring
(structural negative, see next entry) and this one — precomputing the
reference-orbit-derived Horner terms of the general-exponent (multibrot)
delta step once per orbit instead of once per pixel-step, the standard
practice in KF/Imagina-class renderers. Target: the e52 view
(user-z48-0611aae8), still the slowest real view in the export (~74 s
e2e) after the general-exponent stream kernel ship.

**Change 1 — coefficient table:** `ReferenceOrbit` gains `coeff_table`:
for exponent != 2, the Horner terms `C(e,k)·Z_n^(e-k)` depend only on the
orbit index n, so they are built once per orbit (`compute_coeff_table`)
with the exact operation sequence the in-loop code used — consuming them
is bit-identical. `pair_delta_step_table` replaces the per-step serial
`z_power` complex-mul recurrence + coefficient scaling with two v128
loads + two shuffles per term. Capped at 512Ki entries / 8 MiB
(`COEFF_TABLE_MAX_ENTRIES`); over-cap orbits fall back to the on-the-fly
loop. e52 real table: 85-entry orbit × 51 terms ≈ 69 KB. Alone: e52
−33.5% wasm-level (74.5 → 49.5 ms/Miter).

**Change 2 — fused-chain step (the bigger half):** the Horner sum is a
serial mul→add dependency chain (51 dependent steps per pixel-step for
e52), and the stream kernel ran each chain's Horner loop to completion
before the next chain's — latency-bound, not throughput-bound.
`fused_general_table_step` advances all 4 chains' Horner recurrences in
one interleaved loop over terms (per-lane op order unchanged →
bit-identical), giving the pipeline 4 independent chains. On top of the
table: another −60.4% (49.5 → 19.5 ms/Miter). The unfused pair kernel
still serves `border_in_set` early-exit probes.

Wasm-level (run.mjs, full 43-case corpus, 10 samples, baseline vs
coeff-fused, baseline built from clean tree @d85d0cb):

| case | delta |
|---|---|
| user-z48-0611aae8 (e52, i45999) | **−73.7%** (2475 → 651 ms @64px; 74.5 → 20.0 ms/Miter; cold −73.9%) |
| user-z48-58cd3904 (e4 in-set) / syn-pf64-z100-multibrot3 | +1.3% / +0.7% at n=15 (not significant; ~3 ms absolute, accepted) |
| direct / pf64 / float-exp geomean | +0.0% / −5.8% (all from e52) / +0.3% |

Correctness: cargo test 59/59; pixel-check byte-identical on all 43
corpus cases; enrich --check matches all blessed hashes. Zero output
change — no re-bless, no --allow-diff.

Holdout ship gate (seed 2026-07-09, 40/tier): direct +0.4%, pf64 −1.3%,
time-weighted −0.7%; one real mover, a multibrot holdout view
(hold-z48-2e40c56e) at **−52.0%**. The n=3 pass flagged several sub-10 ms
views at +6–8%; the full re-run at --samples 10 dissolved all of them
(two flipped sign) — the validator's noise-floor note strikes again.

E2E ship gate (complete builds pre=d85d0cb / post, 3 rounds standard +
2 rounds multibrot 800x600):
- Standard grid corpus: all eight cases within ±2.9%, overall geomean
  −0.5%; colds track warm; no warmup tax anywhere.
- grid-z48-e52-0611aae8: **73977 → 19758 ms (−73.3%, cold −73.3%)**.
  No new warmup needed: the fused step lives inside the kernel
  `warmupGeneral` already renders through, so tier-up covers it — the
  identical cold deltas confirm.

Size: bench artifact 318.8 → 323.3 KiB (+1.4%); production module wasm
320.0 → 324.6 KiB (+4.6 KiB).

Verdict: shipped. The slowest real view in the export drops 133 s → 74 s
→ **19.8 s** across three days of experiments; all other traffic
unaffected. Mechanism note that survives: when a SIMD kernel's per-step
work contains a long *serial* recurrence, chain-interleaving it is worth
more than removing ops (−60% vs −33% here) — check latency-boundedness
before micro-optimizing op counts.

Reproduce: `node src/run.mjs --variants baseline,coeff-fused --filter
user-z48-0611aae8 --budget-ms 30000`; `node src/validate.mjs --variants
baseline,coeff-fused --samples 10`; `node src/build-dist.mjs pre-coeff
--ref d85d0cb && node src/build-dist.mjs post-coeff && node
src/run-e2e.mjs --variants pre-coeff,post-coeff` plus `--corpus
corpus/grid-multibrot.json --viewport 800x600 --rounds 2 --warmup 0`.

## 2026-07-09 — NEGATIVE (structural, no benchmark): conjugation-symmetry tile mirroring

Settled by arithmetic, not measurement — recording it so nobody probes it
again. The classic fractint "symmetry" trick (tiles below the real axis
are exact vertical mirrors of tiles above it; escape counts are exactly
conjugation-symmetric, and IEEE negation is exact, so mirrored output
would be byte-identical) cannot apply to this client's tile pyramid:

1. **The axis never lands on a tile or pixel boundary.** The tile→complex
   mapping is `(v / 2^(tz-2)) · (200/128) − 4` scaled by `2^-zoomOffset`
   from the view origin (lib.rs `render_tile_precise` docs,
   perturbation.rs `tile_coordinate_offset`). With `origin_im = 0` the
   axis sits at fractional tile coordinate `0.64·2^tz`; the factor
   200/128 = 25/16 puts a 25 in the denominator, so `16·2^tz/25` is never
   an integer or half-integer — no whole-tile mirror pairs exist at any
   zoom, and within a tile the axis is never at a pixel-symmetric offset.
   Pixel rows below the axis are near-mirrors offset by an arbitrary
   sub-pixel amount → not byte-exact → fails the output bar.
2. **The traffic isn't there anyway.** Mirroring needs the axis *in the
   visible grid*. The heavy deep views sit near but not on the axis at
   scales where "near" is astronomically far: grid-z47-i50000 has
   im ≈ 4.4e-3 against a ~4.4e-14 tile span (~10^11 tiles from the axis);
   grid-z48-i48000 similar. Only shallow on-axis views (home view, whole
   needle/cusp) could ever pair tiles, and those are millisecond grids.

Consequence: exact-mirror reuse would require re-anchoring the tile grid
to the axis (a client architecture change that breaks for arbitrary
origins) to save time on views that cost almost nothing. Do not revisit
within the current tile addressing scheme.

## 2026-07-09 — Focus shift (user directive): direct (plain-f64) tier; backlog re-ranked

No production change — skill/docs update plus a structural finding read out
of existing data (no new benchmark).

User directive: prioritize f64 views. Encoded in the skill as a standing
focus: pick direct-tier targets first, deep tiers become regression guards.
Grounding from the 2026-07-08 ingest probe: the direct tier is ~91% of
deduped export views (16,644 of 18,370), and after the 2026-07-07/09
deep-zoom ships the un-mined headroom is concentrated there. The deep-tier
settled verdicts (pf64 byte-exact space exhausted, iteration-skipping
negative, z400+ traffic-gated) are unchanged and stay closed.

**Structural finding (the new backlog #1):** user-z30-f8a50601 — the
slowest direct corpus case (2.9 s at its 100px override, ~11.6 s/tile at
production 200px) — is an e6 multibrot at 11.8 ms/Miter vs the ~0.75
direct escaper norm. Attribution is code inspection, not conjecture:
exponent ≠ 2 direct tiles still run the fully scalar
`calculate_escape_iterations_general` (lib.rs) — `z.powu(e) + c` with a
`z.norm()` sqrt every iteration, scalar Brent periodicity, no
pairing/stream kernel, no Mariani fill — i.e. none of the machinery the
quadratic direct path gained since 2026-07-02. Same signature that flagged
the e52 pf64 view; the ms/Miter column earns its keep again.

Re-ranked backlog (details in the skill): #1 direct multibrot
modernization (sqrt drop + general stream kernel + Mariani; warmup caveat:
`warmupGeneral` renders a pf64-depth tile, which does not tier a
direct-tier kernel instantiation), #2 heavy-direct e2e coverage
(user-z28-543f9cfa i50000 border ≈ 9 s grid and the z30 e6 multibrot
≈ 75 s grid are absent from every e2e corpus), #3 pool-cap re-audit
(~5.7% on throughput-bound grids, motivation since mitigated by spawn
warmups), #4 trapped/border direct throughput (likely irreducible, per the
iteration-skipping verdict), #5 z0 wave/gather micro. Deep items parked
under "deprioritized" with their existing gates.

## 2026-07-10 — SHIPPED: direct-tier multibrot modernization (sqrt drop + general stream kernel + Mariani–Silver)

Backlog item #1 under the 2026-07-09 direct-tier focus directive. Exponent
!= 2 direct tiles previously ran the fully scalar
`calculate_escape_iterations_general` — `z.powu(e) + c` with a `z.norm()`
(hypot) call every iteration, no SIMD, no stream kernel, no Mariani fill.

**Change 1 — sqrt drop (scalar loop):** compare `z.norm_sqr()` against
ESCAPE_RADIUS² (9.0, exactly representable) instead of `z.norm()` (hypot)
against 3.0. Alone: −27.8% on user-z30-f8a50601, byte-identical on all 43
corpus cases (the hypot↔norm_sqr comparison never flips on real data).

**Change 2 — general stream kernel (lib.rs `stream_escape_general`):** the
lane-refilling stream structure of `stream_escape_quadratic` with the step
`z = z.powu(e) + c`, where the power replicates num-complex 0.3.1's
square-and-multiply sequence exactly (same multiply operand order per lane
→ bit-identical to the scalar loop). The powu chain is a serial recurrence
(e6 = 3 dependent complex multiplies per step), so `fused_powu_lanes`
advances all chains through each multiply together — the same
latency-hiding structure as the perturbation fused general step. Chain
sweep: 4 chains best (6: +14.9%, 8: +30.3% on the e6 view — bookkeeping
overhead and small Mariani waves punish wider kernels). No closed-form
interior test exists for e != 2, so points stream unfiltered.

**Change 3 — Mariani–Silver for general exponents:** `stream_tile_subdivided`
takes the exponent and dispatches per wave (branch is per-wave, not
per-step, so the quadratic path is untouched — measured flat). The
ring-fill maximum-principle argument holds for every multibrot degree; same
assumption rect_in_set makes at tile level for all exponents.

Wasm-level (run.mjs, full 43-case corpus, 10 samples, baseline @633ad35):
- user-z30-f8a50601 (e6, i25600, 92% interior — slowest direct corpus
  case): **2931 → 151 ms (−94.9%)**; ms/Miter 11.8 → 0.60, from 16x the
  direct escaper norm to on it.
- syn-direct-z5-multibrot3: −94.0%.
- Everything else flat: direct geomean −31.5% (all from the two multibrot
  cases), pf64 +0.0%, float-exp −0.2%; quadratic direct cases within noise.

Correctness: cargo test 59/59 (scalar loop still the native arbiter).
Pixel-check: 42/43 byte-identical; user-z30-f8a50601 differs on 16/10000
pixels — verified individually: every one an isolated escaper speck
(baseline colored, 6–8 of 8 neighbors interior-black) on a sub-pixel
exterior channel, now ring-filled as interior. Same artifact class the
2026-07-07 quadratic Mariani ship accepted deliberately and that tile-level
rect_in_set produces resolution-dependently. Kernel-vs-scalar bit-exactness
verified separately: a MARIANI_LEAF=100000 diagnostic build (fill disabled,
every pixel through the kernel) is byte-identical to baseline on the case.
valuesHash re-blessed 6f67e811 → 693532ad with this justification (probe
composition ticks: interior 0.916 → 0.9167).

Holdout ship gate (seed 2026-07-10, 40/tier): direct geomean **−23.3%**
(four fresh multibrot views −83..−94%), pf64 −0.4%, time-weighted −21.9%;
positive movers all sub-10 ms n=3 noise-floor class. --pixel-check: 79/80
identical; hold-z6-ee5b9472 (e3) differs on exactly 1/10000 pixels —
verified: isolated escaper speck, 8/8 neighbors interior. Total accepted
artifact rate: 17 pixels across 123 validated views, all multibrot
interior-region specks.

Warmup (client): the direct general kernel is a separate wasm function from
both the quadratic kernel (init warmup) and the deep general perturbation
kernel (warmupGeneral renders an effective-z50 e52 tile), so direct
multibrot first tiles would run Liftoff for their full duration. New
`warmupGeneralDirect` (worker.js): 2 renders of a 128px e6 tile just past
the degree-6 cusp (0.5975, 0) at z10 — probed ~82% escapers, escMean 27,
~360k kernel-iterations per render (the shipped pf64-general warmup
succeeded on ~150k). The pool picks general vs general-direct warmup by
initialZoom against DEEP_ZOOM_THRESHOLD (exclusive, like deep/float-exp);
exponent-2 loads pay nothing.

E2E ship gate (complete builds pre=633ad35 / post):
- Standard grid corpus (2 rounds, warmup 0): all nine cases within ±5.6%
  at n=2, overall geomean −2.0%; colds track warm (single-sample ±8%
  swings on untouched exponent-2 views only).
- grid-multibrot corpus (800x600, 2 rounds, warmup 0):
  - grid-z30-e6-f8a50601 (NEW committed case, heaviest real direct view in
    the export): **34539 → 4351 ms (−87.4%), cold 35821 → 4323 ms
    (−87.9%)** — cold tracks warm, so warmupGeneralDirect covers tier-up
    per the standing SIMD-warmup rule.
  - grid-z48-e52-0611aae8: +0.3% (cold −0.6%) — deep multibrot untouched.

Size: bench artifact 323.3 → 324.2 KiB (+0.3%); production module wasm
324.6 → 328.2 KiB (+3.6 KiB).

Verdict: shipped. The slowest real direct view drops ~8x end to end
(~11.6 s/tile → ~1.4 s/tile at production tile size), closing the last
structural ms/Miter outlier in the direct tier; all exponent-2 and deep
traffic unaffected. Backlog effects: item #1 done; item #2 partially done
(grid-z30-e6 committed to grid-multibrot.json; the z28 border-band direct
case remains uncommitted); item #4's "no byte-exact lever" verdict now
extends to multibrot escaper bands (same structural norm).

Reproduce: `node src/run.mjs --variants baseline,genstream --filter
user-z30-f8a50601`; `node src/validate.mjs --variants baseline,genstream
--pixel-check`; `node src/build-dist.mjs pre-genstream --ref 633ad35 &&
node src/build-dist.mjs post-genstream && node src/run-e2e.mjs --variants
pre-genstream,post-genstream --rounds 2 --warmup 0` plus `--corpus
corpus/grid-multibrot.json --viewport 800x600 --rounds 2 --warmup 0`.

## 2026-07-10 — SETTLED: pool-cap re-audit (7 vs 8 workers) — cap stays; grid-z28 heavy-direct coverage committed

Backlog items #1 (remaining half) and #2 under the direct-tier focus.
Machine: 8-logical-core mac (as all prior entries), AC power.

**Coverage:** grid-z28-i50000-543f9cfa added to grid-regression.json — the
export's heaviest real quadratic direct view (177M probe iters, 77%
near-max escapers, escaper mean 41k/50k border band), the direct-tier
analogue of grid-z47. Measures ~11.0 s per grid pass on the production
build (the "~9 s" backlog estimate was extrapolated from the 64px probe).
Adds ~11 s per round per variant to a full-corpus e2e run; --filter past
it during iteration, same as grid-z47.

**Pool-cap re-audit:** dists pool7 (HEAD = production, cores−1) vs pool8
(cores), built from the same tree path so the wasm is byte-identical and
the bundles differ in exactly one expression (`Math.max(1,t-1)` →
`Math.max(1,t)`). Build gotcha worth keeping: a dist built via
`--ref` goes through a temp git worktree and the worktree *path* leaks
into the wasm (+34 bytes, different contenthash) — for a client-JS-only
A/B, build both variants from the same tree so the wasm hash matches.

run-e2e, full grid-regression corpus (now 10 cases), 5 rounds, warmup 0,
viewport 1600x900 (results/2026-07-10T13-34-13-272Z-e2e-pool7_pool8.json),
pool8 vs pool7:

| case | pool7 median | pool8 delta (warm) | cold |
|---|---|---|---|
| grid-z36-i51200 | 965 ms | −0.7% | −5.3% |
| grid-z46-i6400 | 856 ms | +0.9% | +0.2% |
| grid-z20-i1600 | 681 ms | −0.4% | −1.6% |
| grid-z48-i20000 | 2063 ms | −2.5% | −1.3% |
| grid-z47-i50000 | 50495 ms | **−3.1%*** | −3.5% |
| grid-z48-i48000 | 17324 ms | −1.8% | −0.5% |
| grid-z28-i50000 (new) | 11027 ms | −2.6% | −0.1% |
| grid-z259-i1600 | 1371 ms | −1.7% | +1.1% |
| grid-z48-i800 | 899 ms | +1.0% | −0.6% |
| grid-z85-i200 | 501 ms | +1.2% | −0.8% |
| overall geomean | | −1.0% | |

Findings:
- **The 2026-07-04 contention verdict is overturned.** Then, the 8th
  worker made z36-i51200 *worse* (+24.1%) because 8 workers grinding
  Liftoff code starved TurboFan's background compile threads. With the
  spawn warmups tiering the kernels before real tiles arrive, 8 workers
  is now −0.7% warm / −5.3% cold on that same case. The cap's
  contention-mitigation role is gone.
- **The cap's true latency cost is ~2–3% on throughput-bound heavy
  grids** (z47 −3.1%*, ~1.6 s of 50 s; z28 −2.6%, ~285 ms of 11 s;
  z48-i48k −1.8%; z48-i20k −2.5%), noise (±1.2%) on sub-second cases,
  −1.0% overall. The old "~5.7% on mid-weight grids" figure came from a
  confounded complete-build comparison (reverted-vs-old also carried
  wasm differences); the isolated cost is roughly half that even on the
  heaviest case. The 8th logical core buying only ~3% (not 14%) is
  consistent with makespan being critical-path-bound on the longest
  tiles plus the main thread needing cycles for compositing/callbacks.

Verdict: **cap stays; no production change.** The cap is a deliberate
UX decision (32a1c7d — leave a logical core free so the rest of the
system stays responsive) whose commit claimed "negligible cost to render
latency"; that claim now has numbers and holds (~1.6 s on a 50 s worst
case, ~1% typical). Removing it is a UX-vs-latency call for the user,
not a benchmark question — the benchmark side is answered and settled.
Both dist artifacts kept (bench/artifacts/pool7, pool8).

Reproduce: edit renderPoolSize() in client/js/MandelbrotMap.ts
(cores−1 → cores), `node src/build-dist.mjs pool8`, revert, `node
src/build-dist.mjs pool7`, `node src/run-e2e.mjs --variants pool7,pool8
--rounds 5 --warmup 0`.

## 2026-07-10 — SHIPPED: deferred escape detection in the quadratic stream kernel (+ chains 6 / stride 32 re-sweep)

Backlog item #1 under the direct-tier focus — the class previously framed
"only per-step micro-headroom; don't burn sessions without a genuinely new
mechanism." The mechanism found: the per-step loop carried ~6 of ~13 vector
ops per chain purely for exact escape detection (norm add, lt, alive and,
two freeze bitselects, masked iter sub). Deferring all of it to the stride
boundary leaves the bare z²+c recurrence (7 ops); escaped lanes free-run
past the radius between boundaries (growth past R=3 is monotonic, and
inf/NaN blow-ups fail the boundary `f64x2_lt` the same way), and the exact
escape iteration + frozen z are recovered by replaying at most one stride
of scalar steps from the previous boundary's checkpoint with the kernel's
exact IEEE op order — byte-exact by construction. Every iteration is still
computed: this is check amortization, not iteration-skipping; the settled
iteration-skipping verdicts stand untouched.

Re-sweep under the lighter step (the 2026-07-09 Horner-entry lesson applied:
reduced per-step register pressure moves the ILP optimum): chains 4→6 gave
another −10.5% on the heavies (8 sits between — the old "6/8 spill" verdict
flipped); stride 16→32 another −13%; stride 64 is past the knee
(low-iteration escapers pay free-run waste + replay: syn-z10-seahorse +33%).
Shipped as `QUADRATIC_STREAM_CHAINS = 6`, `QUADRATIC_STREAM_STRIDE = 32`;
the general kernel keeps `STREAM_CHAINS = 4` / `STREAM_STRIDE = 16` (its
fused-powu step is register-hungrier; its measured optima are unchanged).

Wasm-level (run.mjs, full 43-case corpus, 10 samples, baseline @17b1c59):
- user-z28-543f9cfa (the export's heaviest real quadratic direct view, the
  target): **1339 → 726 ms (−45.8%)**; ms/Miter 0.77 → 0.42 — a new
  structural norm for the direct escaper tier.
- Every heavy direct escaper view −44..−46% (user-z14 ×2, z20, z37, z38,
  z44); syn-z30-seahorse −32.4%.
- direct geomean **−24.3%**; pf64 +0.6% and float-exp +0.2% (untouched
  code; noise). Size: bench artifact 324.2 → 324.5 KiB.
- Accepted tax, stated explicitly: light tiles pay the boundary/replay
  overhead — syn-z3-home +13.6% (+0.13 ms), syn-z10-seahorse +13.7%
  (+1.0 ms), user-z2 +9.0% (+0.25 ms). Millisecond-scale against ~600 ms
  saved per heavy tile-set; confirmed invisible at e2e (below).

Correctness: cargo test 59/59 (the SIMD kernel is cfg(wasm32), so the real
gates are:) pixel-check all 43 cases byte-identical vs baseline; enrich
--check all blessed hashes match (no re-bless needed). Holdout (seed
2026-07-10, 40/tier): heavy fresh movers −40..−43%, time-weighted −1.8%;
direct geomean +0.7% — the fresh sample is dominated by sub-2 ms views each
paying ≤ +0.5 ms absolute; judged acceptable under absolute-time weighting.

E2E ship gate (complete builds pre=17b1c59 / post=this change,
grid-regression 10 cases, 3 rounds, warmup 0, 1600x900):
- grid-z28-i50000: **11143 → 6238 ms (−44.0%, cold −44.7%)**
- grid-z36-i51200 −15.6% (cold −19.2%); grid-z46-i6400 −14.1%;
  grid-z20-i1600 −6.9% — the light-tile tax never shows at page-load level.
- Deep tiers + tax guards all within ±0.5% (z47 +0.4%, z48-i48k +0.2%,
  z48-i20k +0.5%, z259 +0.2%, z48-i800 +0.1%, z85-i200 +0.2%).
- Overall geomean **−9.1%**; colds track warm everywhere — the kernel is
  the same wasm function the existing spawn warmup already renders through,
  so the standing SIMD-warmup rule is satisfied with no new warmup.
- Production module wasm 325.5 → 325.8 KiB (+0.3 KiB).

Verdict: shipped. The z28 class's "irreducible" framing was about iteration
counts and remains true; the per-step *op count* still had a ~45% seam.
Mechanism notes that survive: (1) exact-detection machinery inside a SIMD
escape loop can be amortized to any stride whose replay stays cheap — the
free-run is safe because escape-radius growth is monotone and NaN fails lt;
(2) after any step-cost change, re-sweep chains AND stride — both optima
moved (4→6, 16→32) and the stride move alone was worth −13% on the heavies;
(3) the tax lands on low-escape-count escapers (replay + free-run are a
fixed cost per escaper, large relative to short orbits) — watch syn-z10-
seahorse-class cases when touching stride.

Follow-up (new backlog item): the general (multibrot) stream kernel still
runs per-step escape machinery (~25% of its step at e6, more at e3); the
same deferral applies, with the scalar powu loop as the replay. Bounded
upside: a fraction of the e6 view's ~150 ms wasm-level / 4.35 s e2e.

Reproduce: `node src/run.mjs --variants baseline,deferfinal`; sweep
artifacts defer/defer6/defer8/defer6s32/defer6s64; `node src/validate.mjs
--variants baseline,deferfinal`; `node src/build-dist.mjs pre-defer --ref
17b1c59 && node src/build-dist.mjs post-defer && node src/run-e2e.mjs
--variants pre-defer,post-defer --rounds 3 --warmup 0`.

## 2026-07-10 — SHIPPED: deferred escape detection in the general (multibrot) stream kernel (+ chains 6 / stride 32 re-sweep)

Direct-tier backlog item #1: the follow-up from the quadratic deferral ship,
same mechanism applied to `stream_escape_general`. The per-step loop carried
a norm/lt/alive-and plus two freeze bitselects and a masked iter sub around
the fused powu step; all of it now defers to the `STREAM_STRIDE` boundary,
leaving the bare fused powu + c. Free-run safety generalizes to every
exponent d >= 2 (the client clamps exponent to >= 2): once |z| >= R = 3 and
|z| >= |c| — both invariant from the first boundary crossing — |z^d + c| >=
|z|^d − |z| >= 2|z|, so growth past the radius is monotone, and inf/NaN
blow-ups fail the boundary lt as before. The replay is the scalar
`z = z.powu(exponent) + c` loop: `fused_powu_lanes` replicates num-complex's
square-and-multiply order, so replayed steps are bit-identical to the lane
arithmetic and results are byte-exact by construction.

Re-sweep (the standing rule paid again — both optima moved):
- chains 4 → 6: e6 heavy view another −17.0%, e3 another −9.6% (8 sits
  between at −11.5%). The old "general kernel's fused powu step is
  register-hungrier and peaks at 4" verdict flipped: the binding register
  pressure was the per-step escape machinery, not the powu itself.
- stride 16 → 32: e6 another −5.0%, e3 −3.7%. Stride 64 is past the knee
  (e6 only −2% more, e3 flips to +0.8%). Shipped `STREAM_CHAINS = 6`,
  `STREAM_STRIDE = 32` — now equal to the quadratic kernel's constants,
  kept as separate consts since they are independently swept optima.

Wasm-level (run.mjs, full 43-case corpus, 10 samples, baseline @397e111):
- user-z30-f8a50601 (e6 multibrot, the export's heaviest real direct view
  post-modernization): **152.6 → 97.6 ms (−36.0%)**.
- syn-direct-z5-multibrot3 (e3): 4.02 → 3.22 ms (−19.9%).
- direct geomean −4.5% (all of it from the two multibrot cases; quadratic
  cases untouched — QUADRATIC_* constants unchanged); pf64 +0.6% and
  float-exp −0.2% (untouched code; the two flagged light pf64 cases washed
  out to −1.9%/−1.5% at --samples 15). Size: bench artifact 324.5 →
  325.6 KiB.

Accepted tax, stated explicitly: fast-escaping high-exponent views pay
doubled lane-occupancy waste per escaper (stride 16 → 32) plus the scalar
powu replay, and both costs scale with exponent (~2·log2(e) muls per step).
The holdout surfaced the class: hold-z20-1e197d5a (exponent 50, i200,
escapes fast) +12.7% = +0.7 ms at 100px tiles (confirmed at --samples 15).
At stride 16 that tax vanishes (−1.9%) but the e6 heavy loses ~5 ms/tile —
absolute-time weighting keeps stride 32: the tax class is structurally
millisecond-scale (views full of fast escapers are cheap by construction),
the win class is the seconds-scale multibrot heavies.

Correctness: cargo test 59/59; pixel-check all 43 cases byte-identical vs
baseline; enrich --check all blessed hashes match (no re-bless).

Holdout (seed 2026-07-10, 40/tier; float-exp tier empty as always):
direct geomean −1.6%, pf64 −0.1%, time-weighted −0.0%. Real movers, both
re-confirmed at --samples 15: hold-z25-22bbd802 (e3) −37.3%; hold-z20 e50
+12.7% (the accepted tax above). Everything else noise.

E2E ship gate (complete builds pre=397e111 / post=this change, 3 rounds,
warmup 0, 1600x900):
- grid-multibrot.json: **grid-z30-e6-f8a50601 5792 → 3911 ms (−32.5%,
  cold −32.6%)** — colds track warm; the kernel is the same wasm function
  the existing `warmupGeneralDirect` spawn warmup renders through, so no
  new warmup needed. grid-z48-e52 (pf64 general kernel, untouched) +0.3%.
- grid-regression.json (all 10 cases): everything within ±2.6%, overall
  geomean 0.1%; the z36 +2.6% warm is untouched quadratic traffic with its
  cold at −3.4% — round-to-round jitter, not a regression.
- Production module wasm 325.8 → 326.9 KiB (+1.1 KiB).

Verdict: shipped. With this, both direct-tier stream kernels run bare
recurrences between stride boundaries; the general kernel's remaining
per-step cost is the powu chain itself, which is the mathematically
required work per iteration. Mechanism notes that survive: (1) the deferral
mechanism transfers across step functions — the free-run argument only
needs monotone growth past the radius, which holds for every multibrot
degree; (2) a "register-hungry step" verdict about chain count can be
stale the moment the step sheds ops — the escape machinery, not the powu,
was what capped the general kernel at 4 chains; (3) the deferral tax scales
with exponent (replay step cost) and inversely with escape time (per-escaper
fixed cost), so its worst case is a fast-escaping high-exponent view — a
structurally light class, but watch it in holdouts when touching stride.

Reproduce: `node src/run.mjs --variants baseline,gendeferfinal`; sweep
artifacts gendefer/gendefer6/gendefer8/gendefer6s32/gendefer6s64;
`node src/validate.mjs --variants baseline,gendeferfinal`;
`node src/build-dist.mjs pre-gendefer --ref 397e111 && node
src/build-dist.mjs post-gendefer && node src/run-e2e.mjs --variants
pre-gendefer,post-gendefer --rounds 3 --warmup 0` (and the same with
`--corpus corpus/grid-multibrot.json`).

## 2026-07-10 — SHIPPED: initial tile batch dispatches at pool-ready + 100 ms instead of waiting out the 350 ms debounce

Machine: Rosss-MacBook-Pro.local darwin/arm64 Apple M1 Pro, Chrome 136.
Client-JS change only (MandelbrotLayer.ts, MandelbrotMap.ts); wasm untouched
and byte-identical, so pixel-check/enrich/holdout do not apply — run-e2e on
complete builds is the whole gate.

First audit of the fixed per-load floor (new territory under the direct-tier
focus: it taxes 100% of loads, and the 91%-of-traffic direct tier is mostly
light views that are all floor). Decomposition probe: on desktop, every view
with iterations > 500 routes tiles through a 350 ms trailing debounce
(MandelbrotLayer.debounceTileGeneration); the initial burst arrives in one
tick, so the whole grid idles until t≈375 ms while the pool is spawned and
warmed by ~140 ms. Measured by flipping one view across the i≤500
immediate-path boundary (same compute): z20 load 239 ms immediate vs 569 ms
debounced — ~330 ms of pure latency on essentially every real shared-link
load (export views run i800–51200).

The fix took three iterations — the intermediate failures are the durable
lesson:
1. Flush at t≈0 (setTimeout 0): light views −31..−52%, but grid-z28
   +8.0% warm / +15.8% cold *. Tile-completion curves showed first tiles
   per worker at 1.6–2.2x normal: the debounce had been accidentally
   serving as a TurboFan tier-up shadow. The spawn warmups only *trigger*
   tiering; dispatching before the compile lands runs each worker's
   in-flight stream-kernel call (one call per wave) at Liftoff speed.
2. Flush at pool-ready (~140 ms, new MandelbrotMap.poolSpawned promise):
   z28 flipped to −5.8% in an isolated probe but stayed bimodal across
   rounds (5279 vs 6710 ms samples, 2 of 5 curve-probe passes bad) — with
   all 7 workers dispatching real tiles immediately, Liftoff execution
   occupies every core and starves the compile threads, so whether the
   compile wins is a coin flip.
3. Flush at pool-ready + TIER_UP_GRACE_MS = 100 of idle: the compile gets
   a quiet machine; 7/7 curve-probe passes clean (first tiles ~965–1235 ms,
   tight), and z28 becomes a small outright win.

E2E ship gate (complete builds pre=bb5e75e / post=this change, 3 rounds,
warmup 0, 1600x900), grid-regression all 10 cases:
- grid-z20-i1600 615 → 378 ms (−38.6%, cold −35.4%); grid-z46-i6400
  −33.9%; grid-z36-i51200 −30.0%; grid-z48-i800 −18.3%; grid-z259 −11.4%;
  grid-z48-i20000 −7.9% — all *.
- grid-z28-i50000 5586 → 5415 ms (−3.0%*, cold −3.4%, MAD ±25 — no
  bimodality); grid-z47 −0.2%, grid-z48-i48000 −0.9%, grid-z85-i200 −3.4%
  (all n.s. guards).
- Overall geomean −16.0%. grid-multibrot: z30-e6 −5.0%*, z48-e52 −0.8%.
- Wasm size unchanged (byte-identical module).

Interaction behavior is untouched: the flush consumes a once-per-layer flag
on the first debounced batch (which is always a full-view burst — the
debounced path only activates at i>500, reachable from an i≤500 start only
via a settings refresh), and pan/zoom flurries plus the existing drag-flush
keep the 350 ms debounce.

Mechanism notes that survive: (1) the per-load floor decomposes as ~140 ms
pool spawn+warmup, ~235 ms of pure debounce idle, and the debounce idle was
also hiding TurboFan compile latency — any future change to warmups, pool
size, or dispatch timing must re-check the z28-class first-tile curves for
Liftoff staggering (probe pattern: first-8 tile completion times, bad passes
show 1.6–2.4x stagger); (2) "budget consumed" ≠ "tiered" — spawn warmups
guarantee the trigger, not the swap, and the swap needs idle CPU headroom;
(3) an isolated single-case e2e probe can miss an intermittent regression —
the bimodality only showed up across repeated passes (re-run suspicious
heavy-case results with a multi-pass curve probe, not one more 3-round run).

Reproduce: node src/build-dist.mjs pre-flush --ref bb5e75e && node
src/build-dist.mjs post-flush3 && node src/run-e2e.mjs --variants
pre-flush,post-flush3 --rounds 3 --warmup 0 (and the same with --corpus
corpus/grid-multibrot.json).

## 2026-07-10 — SHIPPED: single-pool startup (URL config parsed before the pool spawns)

Machine: Rosss-MacBook-Pro.local darwin/arm64 Apple M1 Pro, Chrome 136.
Client-JS change only (MandelbrotMap.ts); wasm untouched and byte-identical
(326.9 KiB both sides), so pixel-check/enrich/holdout do not apply — run-e2e
on complete builds is the whole gate. Continuation of the per-load-floor
audit the flush ship opened.

Decomposition probe (temporary [probe] console timestamps on a built dist,
grid-z20 URL): on every shared-link load, initializeMap spawned the pool
*before* parsing the URL, so the whole startup ran twice — pool #1 spawns
against the default view (t≈46→103 ms; no conditional warmups because
this.config isn't set yet), setView(default z3, i=200 ≤ 500) dispatches a
burst of throwaway default-view tiles through the immediate path onto that
pool, then setConfigFromUrl → refresh() → createPool #2, whose
`terminate(true)` *waits for pool #1's in-flight spawns to finish* before
the second 7-worker spawn+warmup cycle even starts (ready ≈ 151 ms). Net:
two full spawn cycles serialized plus wasted default-view tiles, and the
initial-batch flush waited on pool #2 (~251 ms dispatch).

Fix (initializeMap reorder): set config from the URL first (setConfigFromUrl
no longer calls refresh(); it runs before the controls exist, whose
constructor does the auto-adjust UI sync), then spawn the one pool — which
now picks its conditional warmups from the real view depth/exponent — then
add the layer and set the view once via goToCoordinates(config), so the
first and only tile batch is the target view. refresh() keeps its
createPool for genuine setting changes. Probe after: single 7/7 spawn ready
≈ 90 ms, dispatch ≈ 190 ms (−60 ms), no throwaway tiles.

Standing-rule check (dispatch timing changed → re-check z28-class first-tile
curves for Liftoff staggering): 6/6 passes clean, first-8 tiles 906–1073 ms
tight, no 1.6–2.4x stagger; last tile 5.31–5.47 s, tracking the shipped
numbers.

E2E ship gate (complete builds pre=97180e8 / post=this change, 3 rounds,
warmup 0, 1600x900), grid-regression all 10 cases:
- grid-z20-i1600 380 → 353 ms (−7.1%*, cold −7.9%); grid-z85-i200 −7.0%*;
  grid-z36-i51200 −7.0%* (cold −9.7%); grid-z46-i6400 −6.0%* (cold −10.0%);
  grid-z48-i800 −3.5%*; grid-z259 −2.9% — the floor cut shows on every
  light/mid view, colds track or beat warm.
- Heavies + guards flat: grid-z28 −1.0%, grid-z47 +0.1%, grid-z48-i48k
  +0.1%, grid-z48-i20k −1.6%. Overall geomean **−3.6%**.
- grid-multibrot: z30-e6 −0.9% warm, **cold −4.3%** (the general-direct
  warmup now rides the first and only pool); z48-e52 −0.3%.
- Smoke (post build): bare-origin load, interactive zoom, and a
  palette-param share URL all render; input fields sync (the auto-adjust
  UI sync moved from setConfigFromUrl to the controls constructor).

Two harness lessons, recorded so they aren't relearned:
- **Never use puppeteer request interception around this client.** The
  decomposition probe's interception intermittently stalled one worker's
  spawn forever (6/7 workers, poolSpawned unresolved, flush degraded to
  the 350 ms debounce) — reproduced in 5/7 passes, vanished without
  interception. run-e2e already knew: its off-localhost blocking uses
  --host-resolver-rules for exactly this reason. Probes must copy that.
- A "detached Frame" crash mid-run-e2e (z47 cold, pre variant) was a
  one-off harness flake; full re-run was clean. Re-run before diagnosing.

Mechanism note that survives: the per-load floor now decomposes as
~45 ms bundle+init, ~45–55 ms single pool spawn+warmup, 100 ms tier-up
grace, then dispatch (~190 ms total on this machine). The remaining
floor levers are the grace itself (load-bearing per the flush ship) and
spawn cost (wasm compile is already process-cached across workers).

Reproduce: node src/build-dist.mjs pre-onepool --ref 97180e8 && node
src/build-dist.mjs post-onepool && node src/run-e2e.mjs --variants
pre-onepool,post-onepool --rounds 3 --warmup 0 (and the same with
--corpus corpus/grid-multibrot.json).

## 2026-07-10 — POLICY (user decision): anchor-relative output-tolerance gate, opt-in; byte-exact stays the default

Machine: Rosss-MacBook-Pro.local darwin/arm64 Apple M1 Pro, Chrome 136.
Harness + policy change only; no production code touched.

Context: with both direct-tier kernels at bare recurrences, the remaining
compute lever the byte-exact bar blocks is the float-rounding class (FMA,
reassociation). The user weighed relaxing byte-exactness against the risk
of functional regressions and of slow drift (N "imperceptible" ships
compounding), and approved this design:

- **Byte-exact remains the default gate.** Nothing changes for ordinary
  experiments.
- **Opt-in tolerance gate, always anchor-relative.** A candidate's output
  is compared against a PINNED ANCHOR build — never against the
  candidate's predecessor — so accepted deviation can never exceed the one
  fixed budget no matter how many tolerance ships land. A candidate that
  would exceed it fails loudly and forces an explicit re-anchor decision
  (LOG entry + re-pin), turning "the drift budget is spent" into a user
  choice instead of a silent ratchet.
- The anchor is pinned in committed bench/anchor.json:
  variant "anchor", sha 3517e5678f5ec9238c970ef714f67d730af7d044
  (2026-07-10, current production output). Artifacts are gitignored, so
  the runners verify the local anchor artifact's meta sha against the pin
  and refuse a stale one; regenerate with
  `node src/build.mjs anchor --ref <sha>` (build.mjs gained --ref for
  this — temp-worktree build like build-dist).
- The diff runs on smoothed escape VALUES (get_mandelbrot_tile_precise
  include_values; Infinity = interior), not RGBA, so palette settings can
  neither mask nor fake an output change. Committed budgets: max |Δ| ≤ 1.0
  smoothed iteration on escapers, ≤ 0.1% of pixels differing, largest
  4-connected diff blob ≤ 2 px, zero escaper↔interior flips (a flip's
  delta is unbounded by construction, so fill-class changes always
  escalate — the multiplier-interior failure mode is contiguous regions,
  which the blob bound also catches).
- Tooling: `node src/pixel-check.mjs --b <variant> --tolerance` (fixed
  corpus) and `node src/validate.mjs --variants a,b --pixel-check
  --tolerance` (fresh holdout; the anchor being a *build* means reference
  values for never-seen views are generated on demand, so drift is
  bounded off-corpus too). New page primitive window.getValues; shared
  gate logic in src/tolerance.mjs.

Validation of the gate itself:
- A/A: anchor vs itself and anchor vs baseline@397e111 (two shipped
  changes apart, byte-identical era) — all 43 corpus cases identical,
  exit 0.
- Escalation, fixed corpus: a 633ad35 build (pre direct-multibrot
  modernization, the re-blessed 16-px speck diff) vs anchor —
  user-z30-f8a50601 flagged OVER BUDGET (16 flips, 0.160% > 0.1%, blob
  3 px > 2), exit 1.
- Escalation, holdout: same variant caught the *other* known historical
  artifact (hold-z6-ee5b9472, exactly 1 flip px, matching the
  modernization ship's holdout note), exit 1.

Consequences: ffast-math-class experiments (RUSTFLAGS reassociation,
wasm-opt --fast-math) are now runnable through a defined gate instead of
being auto-rejected at pixel-check; flip-class diffs (Mariani-speck-like)
still require explicit user acceptance via re-anchor. enrich --check
re-blessing stays as-is for accepted ships. Moving the anchor is a
deliberate, logged user decision — never an experiment side effect.

## 2026-07-10 — Backlog #1: FMA/rounding-class calibration — flag space is EMPTY; gate calibrated with a synthetic probe (nothing ships)

Machine: Rosss-MacBook-Pro.local darwin/arm64 Apple M1 Pro, Chrome 136.
Anchor: 3517e56 (as pinned). Baseline artifact rebuilt from clean HEAD
(c288faa). Probe code reverted after the experiment; production untouched.

### 1. The flag-only rounding class does not exist on this toolchain (settled)

- `wasm-opt --fast-math` (binaryen 112) on top of the production flags:
  **byte-identical binary** — verified both via build.mjs and by running
  wasm-opt by hand on the pre-wasm-opt binary, in both argument orders
  (`-O3 --fast-math` and `--fast-math -O3`). LLVM at opt-level 3 already
  canonicalizes every pattern binaryen's fastMath rules can touch.
- `--rustflags "-C target-feature=+simd128 -C llvm-args=-enable-unsafe-fp-math"`:
  **byte-identical** too. LLVM IR reassociation is gated on per-instruction
  fast-math flags that stable rustc never emits (nightly `fadd_fast`
  intrinsics are out of scope on the stable-toolchain policy), and the wasm
  target has no FMA instruction for codegen-level contraction to target
  (relaxed-SIMD stays blocked by the Safari 16.4 floor).
- Consequence: backlog outcome (a) ("passes + wins → clean ship lane") is
  unreachable via flags. The only remaining routes to rounding-class wins
  are a relaxed-SIMD dual-build (price only if a real win is demonstrated)
  or algorithmic imports from the renderer survey (backlog #2).

### 2. Tolerance tooling verified on both paths — no issues found

The tolerance option was flagged as new/possibly buggy; none surfaced:
- Fixed corpus, A/A (byte-identical variant vs anchor): all 43 cases
  "identical to anchor", exit 0.
- Fixed corpus, real diffs (probe below): 9/43 OVER BUDGET with correct
  per-axis attribution, exit 1. (An early "exit 0" reading was a shell
  artifact — `$?` after a pipe reports tail's status, not node's.)
- Holdout path `validate.mjs --pixel-check --tolerance --per-tier 6`:
  on-demand anchor reference generation for never-seen views works;
  stratified sample drew 6 direct + 6 pf64 (float-exp tier empty as
  expected); 1/12 OVER BUDGET, exit 1.

### 3. Budget calibration with a genuine rounding-class change

Variant `fmaprobe` (experiment-only, reverted): real-part update
`zr²−zi²` → `(zr+zi)(zr−zi)` — the same ±1-ulp perturbation class as FMA
contraction — applied consistently at all four quadratic direct-tier
sites (scalar, pair kernel, quad kernel, stream kernel + its scalar
replay). Deep tiers and the general (multibrot) kernel untouched, and
their outputs came back byte-identical — clean isolation control.

Fixed-corpus gate: 9/43 over budget. Two distinct failure classes:

- **Boundary re-roll (dominant, exactly as the backlog predicted):**
  chaos re-rolls long-orbit boundary pixels rather than shifting them.
  user-z28-543f9cfa (i50000 border band): 56.1% px differ, 7,059 flips,
  blob 2,033 px, max |Δ| 12,182 iterations. user-z14/z20 views: 4.3–5.4%
  px, 17–108 flips, max |Δ| ~26k. syn-direct-z30-seahorse: 23.6% px,
  210 flips. These fail every axis; the flips and |Δ| axes trigger first
  and hardest.
- **Distributional drift (new datum):** user-z44-b1cf403c: 53.4% of px
  differ but max |Δ| 0.106, ZERO flips, blob 10,634 px — ubiquitous
  sub-visual drift that PASSES the per-pixel |Δ| budget and fails only
  the fraction/blob axes (which were designed for specks). Holdout
  hold-z45-31ff9669 is the same class plus 415 flips at |Δ| ≤ 97.9.
  Any future "statistical equivalence" tier must be designed to accept
  exactly the z44 signature while still rejecting the re-roll class —
  that distinction (zero flips + tiny |Δ| vs re-rolled counts) is the
  concrete shape of that policy decision.
- Light/short-orbit views (syn-z3-home, user-z38): 4–6 px at |Δ| ≈ 0.001
  — within budget, so the gate is not trigger-happy on trivial diffs.

### 4. Rounding freedom would buy nothing on this transform anyway

run.mjs, direct filter, 16 cases: the difference-of-squares form is
**+39% per iteration** on the stream-kernel heavies (ms/Miter 0.400 →
0.556 uniformly; z37/z38 with identical/1-px output are +39.0%, so it is
pure per-step cost, not workload change from flips). Direct geomean
+20.9%; multibrot/general-kernel cases 0.0% (control). Wasm-level op
counts are identical (−6 mul / +6 add overall) — V8/M1 punishes the
changed dependency structure; mechanism not chased further since the
transform is a loss regardless. Size +0.0%.

### Verdict

Backlog item #1 resolved as an informative (b): no flag-level candidate
exists to ship; the tolerance gate is validated end-to-end on both the
fixed-corpus and holdout paths; and the committed budgets demonstrably
reject genuine rounding-class changes — dominated by the zero-flips and
|Δ| ≤ 1 axes on boundary re-rolls, with the fraction/blob axes binding
only on the z44-style distributional class. The data a statistical-tier
policy discussion needs is in §3. Hardware-FMA (relaxed-SIMD dual-build)
remains blocked/unpriced; rounding-class hopes now ride on backlog #2
(renderer survey). Artifacts kept: fastmath, unsafefp, preopt, fmaprobe.

## 2026-07-10 — Backlog #1: Renderer survey — 7 projects read; no importable byte-exact idea for the direct tier; field's exact toolkit is a subset of ours

Machine: n/a (reading, no benchmark). Clones made OUTSIDE the repo
(session scratchpad, deleted with it); licenses verified on arrival;
no code copied or translated from any GPL/AGPL source — findings below
are technique names + our own analysis (this entry is the design
note / provenance record the backlog required).

Projects read: XaoS (GPL-2), Fractint lineage via iterated-dynamics
(GPL-3), Kalles Fraktaler 2+ (AGPL-3 in the mathr lineage — note the
backlog said GPL-3), Fraktaler-3 (AGPL-3), mandelbrot-perturbator
(AGPL-3), rust-fractal-core (GPL-3), Fractalshades (MIT — the one
copyable-with-attribution source).

### Ranked idea list (deliverable), mapped against settled verdicts

1. REJECTED (class): boundary tracing / edge following
   (iterated-dynamics libid/engine/BoundaryTrace.cpp; XaoS
   src/engine/btrace.cpp, edge*.cpp). Fills a region once its
   same-iteration-count outline closes. Count-fill on escapers is
   incompatible with smooth-coloring float values (our default output),
   and XaoS's own algorithms.md concedes it misses small connected
   lakes ("many claim that it does not introduce any errors, but this
   is not true"). Flip/blob-class under our tolerance budgets —
   escalation-only. This closes the backlog's "beats ring-fill on
   border-heavy tiles" hope: on border-heavy escaper bands (z28-class)
   no fill method applies at all (the cost is escapers, bands are thin,
   smoothed values vary per pixel); on interior regions our
   Mariani/rect_in_set already covers the same ground in the same
   acceptance class.
2. REJECTED (class): solid guessing / tesseral / half-res guessing
   (iterated-dynamics SolidGuess.cpp, tesseral.cpp; XaoS interlaced
   guessing; KF "guessing"). Same flip/blob class, looser error
   control; XaoS's doc explicitly accepts visible-error risk. The
   2026-07-10 calibration already demonstrated the gate escalates this
   class.
3. REJECTED (settled 2026-07-08): SOI / series approximation
   (iterated-dynamics SynchronousOrbit.cpp, AlmondBread lineage —
   Newton-polynomial interpolation of whole rectangles from key
   orbits; rust-fractal-core probe-based SA; KF SA + NanoMB).
   Count-changing iteration skipping — the BLA settled negative's
   acceptance argument applies verbatim (skip-worthy tolerances
   re-roll boundary counts).
4. REJECTED (settled 2026-07-08): derivative/multiplier interior
   detection (Fractalshades mandelbrot_M2.py dzndz attractivity stop +
   Newton interior via mathr's interior-coordinates method; MIT, so
   copyable — but the technique itself is our settled
   multiplier-interior negative: false-retires escapers loose, never
   fires near-parabolic tight).
5. CONFIRMED (ours, independently): XaoS's Mandelbrot loop unrolls
   blocks of 8 iterations with one bailout test, saving state and
   re-running the last block exactly on escape — the same design as
   our 2026-07-10 deferred-escape ship (we run stride 32, SIMD,
   lane-refilled, with cardioid/bulb + exact Brent on top; Fractint's
   periodicity is tolerance-based `g_close_enough`, weaker than our
   exact compare). Nobody surveyed has a byte-exact escaper lever we
   lack; our direct kernels are at or past the field's frontier.
6. NOT FOUND anywhere: higher-period (3+) closed-form interior
   membership tests — every surveyed renderer stops at cardioid +
   period-2 bulb like us or uses the settled multiplier method.
   Correctly so: Brent already resolves settled interior cycles
   cheaply, Mariani fills interior regions, and the expensive interior
   pixels are near-parabolic where algebraic tests straddle anyway.
   No absolute time available — not backlogged.
7. DEEP TIER (status unchanged, provenance noted): Fraktaler-3's
   rescaled-f64 epoch loop (AGPL — reimplement from note if ever
   unlocked), BLA (settled), reference reuse / period-locked reference
   iterations (our orbits cost ~18 ms — no), Zhuoran rebasing (pf64
   already rebases), KF glitch machinery (perturbation-correctness,
   N/A). All stay traffic-gated at z400+ / closed.
8. OUT OF SCOPE (product, not wasm): XaoS priority-ordered dynamic
   resolution / progressive refinement — tile-scheduling UX idea, not
   a tile-compute change. Parked here for the record only.

### Consequence

Combined with the same-day calibration entry (±1-ulp arithmetic change
re-rolls z28-class boundary bands, 7k flips), the import lanes are now
both closed: no byte-exact idea exists in the field that we lack, and
no rounding-class idea can pass the tolerance gate on the views where
time lives. Remaining routes to direct-tier wins are decisions, not
experiments: (a) a statistical-equivalence output tier (user policy;
required data is in the calibration entry §3), (b) relaxed-SIMD
hardware FMA (Safari-floor/dual-build decision — wasm-level win priced
in the next entry), (c) new traffic data. No tolerance-gate tooling
was needed for the survey itself; the gate's next real exercise is the
FMA pricing run below.

## 2026-07-10 — Relaxed-SIMD hardware FMA priced: −30%/iter on the direct heavies, grid-z28 e2e −27.5% — real, large, and blocked on two user decisions (nothing ships)

Machine: Rosss-MacBook-Pro.local darwin/arm64 Apple M1 Pro, Chrome 136.
Probe code and config edits reverted after measurement; production
untouched. Artifacts kept: fmaprice (wasm-level), fma-pre/fma-post
(dists). This resolves the backlog's "relaxed-SIMD dual-build — price
only if a real win is demonstrated" contingency: the win is demonstrated.

Feasibility unblocked on the stable-toolchain policy: the wasm relaxed
intrinsics are stable Rust since 1.82 (`f64x2_relaxed_madd`/`_nmadd`
verified in the 1.86 sysroot), so this is NOT nightly-gated. Chrome
lowers them to hardware FMA (FMLA/FMLS on ARM64); the blocker is only
the browser floor (relaxed-simd: Chrome 114+/Firefox 125+, **no Safari
support**) plus the output policy.

Setup: quadratic stream kernel step only —
`zr' = madd(zr, zr, nmadd(zi, zi, cr))`, `zi' = madd(2·zr, zi, ci)`
(7 ops → 4, critical path 3 → 2). Scalar replay left in exact non-FMA
order, so recovered escape steps are approximate — fine for a timing
datum, never for production. Build: `--rustflags "-C
target-feature=+simd128,+relaxed-simd"` + wasm-opt
`--enable-relaxed-simd`; 18 relaxed-FMA instructions confirmed in the
binary. Deep tiers and the general kernel untouched (their outputs came
back byte-identical — isolation control).

Wasm-level (run.mjs, direct filter, 16 cases, n=10): every
stream-kernel-dominated heavy lands at −29..−30% with ms/Miter
uniformly 0.40 → 0.28 — user-z28-543f9cfa 684 → 479 ms,
z37 −29.9%, z38 −29.6%, z44 −29.2%, z20 −29.6%, both z14 views
−29%. Direct geomean −17.7%; time-weighted −28.0%. Controls: z30-e6
multibrot +0.4% (general kernel untouched), interior-only views ~+1%
(never in the escape loop). Size −0.0%.

E2E (run-e2e, grid-z28-i50000-543f9cfa, real dists, n=5): 5365 →
3888 ms median, **−27.5% warm, −28.4% cold** (5504 → 3939 ms) — the
kernel win survives bundle/spawn/tier-up intact; Liftoff executes
relaxed SIMD fine and the existing quadratic warmup covers tier-up.
For the temporary dist build, .cargo/config.toml and the Cargo.toml
wasm-opt line carried the relaxed flags (reverted; a real ship would
need the dual-build plumbing instead).

Tolerance gate (first real rounding-class exercise; the new option ran
clean on both invocations — no tooling issues): 9/43 OVER BUDGET,
exit 1, exactly the calibration's predicted classes. z28 is a boundary
re-roll (56.8% px, 7,141 flips, blob 1,401 px, max |Δ| 12,206); z44 is
the distributional class (62.3% px, max |Δ| 0.104, ZERO flips, blob
17,287 px — fails only fraction/blob); z37/z38 pass within budget
(3 px, |Δ| ≤ 0.002). All pf64/float-exp cases identical to anchor.
Escalated, not accepted: FMA cannot pass the current gate on the views
where its time lives.

### Verdict — the decision datum the backlog asked for

Hardware FMA is the single largest direct-tier lever measured since
the deferral ship (−1.5 s per z28 grid load), it is free in size, and
it is implementable on stable Rust today. It stays unshipped because
of exactly two user-level decisions, now priced:
1. **Output policy**: the diff is chaos re-roll on long-orbit boundary
   views — no budget tweak covers it; it needs either a deliberate
   re-anchor or the statistical-equivalence tier sketched in the
   calibration entry (§3). Note z28's re-roll is *statistically* the
   same picture (band structure preserved, counts re-rolled within the
   band) — the same tier that would accept z44 could plausibly be
   designed to accept it, but that design is the user's call.
2. **Browser floor**: no Safari support at any version → shipping
   means a dual-build (relaxed + simd128 fallback) with runtime
   feature detection, i.e. ~2x wasm artifacts in the service worker
   and a selection shim. That cost was previously "unpriced"; the
   payoff side is now −27.5% e2e on the heaviest real direct view and
   −28% time-weighted across the direct corpus.
If both decisions ever land, the ship path is: FMA-ize the scalar
replay consistently (software fma in replay is fine — it runs ≤ stride
steps per escaper... measure it), re-sweep chains/stride (the step got
cheaper again — the deferral entry's rule), holdout + re-bless, e2e
with cold passes, dual-build plumbing. Until then: parked, priced.

## 2026-07-10 — SHIPPED: relaxed-SIMD hardware FMA dual-build (grid-z28 e2e −44.0%) + the statistical-equivalence output tier that gates it

Machine: Rosss-MacBook-Pro.local darwin/arm64 Apple M1 Pro, Chrome 136.
Both blocking user decisions from the pricing entry landed today: (1) build
a statistical-equivalence output tier for the rounding class, and (2) accept
the dual-build shipping cost. This entry ships both. Anchor unchanged
(3517e56); byte-exact remains the default gate for everything else.

### 1. Statistical-equivalence tier (harness; opt-in via --statistical)

`node src/pixel-check.mjs --b <v> --statistical` (fixed corpus) and
`node src/validate.mjs --variants a,b --pixel-check --statistical`
(holdout). Anchor-relative like --tolerance — never candidate-vs-
predecessor, so no drift ratchet. For changes claimed AND LOG-justified as
float-rounding-class only; a failure is an escalation exactly like the
strict gate. Axes (budgets committed in anchor.json `statisticalBudgets`,
semantics in src/tolerance.mjs), calibrated on the kept fmaprice/fmaprobe
artifacts (accept side) and speck-test@633ad35 + synthetic mutations
(reject side):

- flip direction balance |ΔftI−ftE| ≤ max(4, 3√flips): re-rolls are
  symmetric coin flips (z28: 3602/3539 of 7,141), structural fills are
  one-directional (speck-test 16/0 → rejected at 16 > 12).
- delta sign balance ≤ max(16, 4√n) over common escapers: real FMA drift is
  sign-symmetric (worst z28 imbalance 162/499 allowed); uniform shifts,
  scales, and band shifts are 100% one-signed — this axis alone kills the
  shift+2/scale1.01 mutations that hide from KS/quantiles on 40k-iteration
  tiles.
- largest 4-connected FLIP blob ≤ 24 px (FMA max 15; fills are hundreds).
- calm violations ≤ max(8, 0.05%): a flip or |Δ|>1 where the anchor's 3×3
  neighborhood has ≥6 finite values spanning <1.0 iteration. FMA scores 0
  everywhere; interior-embedded pixels are exempt (legitimately chaotic —
  an early roughness-only definition wrongly flagged them).
- escaper-distribution stability: central quantiles p25/p50/p75 rel drift
  ≤1.5%, tile KS ≤0.01, per-16×16-block KS ≤0.25 (band structure),
  interior fraction Δ ≤0.5% global / ≤15% per block. Skipped under 100
  escapers per tile / 64 per block.

Two design bugs found and fixed during validation, both worth remembering:
(a) two-sample KS must consume tied values on BOTH sides before measuring —
nosmooth tiles have integer values with huge tie groups, and the naive walk
scores identical arrays at tieGroup/n (a byte-identical pf64 case failed at
KS 0.012); (b) tail quantiles (p5/p95) are rank-fragile under legitimate
re-roll membership churn — a holdout z7 view (2,419 escapers) moved its p95
by 5.02% from a net 7-escaper tail change while KS read 0.0045, so the
quantile axis is central-only and tail integrity rides KS + sign + flips.

Tier validation: A/A (baseline@c288faa vs anchor) 43/43 identical, exit 0.
fmaprice + fmaprobe: all 43 within budget (the z28 re-roll and z44
distributional signatures both accepted, per the decision). speck-test:
rejected on flip imbalance, exit 1. All 30 synthetic mutations
(shift±2/scale1.01/blobfill24/bandshift2% across 6 representative cases)
rejected, most on several independent axes. Offline cross-check script and
captured buffers in the session scratchpad; the numbers above are the
committed record.

### 2. The kernel change (mandelbrot/src/lib.rs)

Quadratic stream kernel step under `#[cfg(target_feature = "relaxed-simd")]`:
`zr' = relaxed_madd(zr, zr, relaxed_nmadd(zi, zi, cr))`,
`zi' = relaxed_madd(zr+zr, zi, ci)` — 7 ops → 4, critical path 3 → 2. The
not-relaxed branch is the exact step, unchanged. Pair/quad kernels and
rect_in_set stay exact in BOTH builds (fills must stay byte-exact —
FMA there would be flip-class).

**Replay lesson (the pricing entry's "software fma is fine — measure it"
resolved: it is NOT fine):** f64::mul_add lowers to a libm call on wasm32
and cost +139..+223% on low-escape-count views (seahorse class, z2/z3 —
replay is a fixed per-escaper cost). Fix: replay THROUGH the same relaxed
SIMD instructions with the value in lane 0. That is faster than the exact
replay ever was AND makes replay-vs-vector consistency exact by
construction on every engine, fused or not (mul_add only matched "where
relaxed madd is fused"). The former disasters became wins (syn-z10
−11.7%, z3-home −9.8% at 6/32). Watch the loop-exit case: extract lanes
AFTER the loop so a full-stride replay returns the post-step boundary z.

Re-sweep (the deferral rule held again): 4/6/8/10 chains × stride
16/32/64. The FMA step's shorter critical path moved the optimum from 6/32
to **8/64** (chains 8: −12.2..−13.0% over 6; stride 64: another
−9.8..−13.1%; chains 10: +10% — 8 chains × 4 v128 state vectors exactly
fills the 32-register file). Stride-64 tax lands on low-escape-count views
(syn-z10-seahorse +23% vs c8s32 = +1.6 ms on a 7 ms view; net vs baseline
+7.7%) — accepted on absolute-time grounds. The constants are cfg-gated:
the simd128 fallback keeps its measured 6/32. Stride/chains never affect
output (the replay recovers exact escape steps from any checkpoint on the
same trajectory) — confirmed: z28's diff-vs-anchor stats are bit-stable
across 6/32, 8/64, and both replay forms.

### 3. Gates (all green)

- cargo test 59/59 (kernel change is wasm-only; native untouched).
- Fallback build (default flags, current source) **byte-identical to the
  anchor on all 43 cases** — the Safari lane is provably unchanged, so the
  committed enrich hashes and the anchor stay pinned to the byte-exact
  lane and NO re-bless is needed. (Convention going forward: blessed
  hashes track the fallback lane; the relaxed lane is judged by the
  statistical tier.)
- Fixed corpus statistical gate: 43/43 within budget.
- Holdout statistical gate (seed 2026-07-10, 40 direct + 40 pf64): 80/80
  within budget (after the tail-quantile fix above; the escalation that
  prompted it was investigated to root cause first, not budget-tweaked
  away).
- Holdout timing: direct geomean −5.1%, pf64 +0.2% (control), heavies
  −38..−42%; the tax class shows as predicted (two fast-escaping views
  +25% = +0.4–0.5 ms each).

### 4. Wasm-level result (run.mjs, full corpus, n=10, final 8/64 build)

Direct geomean **−25.8%**; every stream-kernel-dominated heavy −44..−46.5%
(user-z28 684 → 366 ms, ms/Miter 0.40 → 0.21; z37 −45.3%, z38 −45.0%,
z44 −43.8%, z20 −46.1%, both z14 views −44%). pf64 −0.1%, float-exp +0.3%
(untouched, as designed). Overall geomean −10.5%; time-weighted −8.8%;
user-frequency-weighted −20.8%. Size +0.1%. Accepted regressions:
syn-z10-seahorse +7.7% (+0.6 ms), z11 +3.4% (+0.02 ms, n.s.).

### 5. Dual build (client) + e2e verdict

- `client/build-relaxed-wasm.js` builds `mandelbrot/pkg-relaxed`
  (wasm-pack --release, RUSTFLAGS +simd128,+relaxed-simd) before webpack;
  WasmPackPlugin builds `pkg` (fallback) exactly as before. Cargo.toml's
  wasm-opt metadata gained --enable-relaxed-simd — verified byte-neutral
  on the fallback binary. bench PRODUCTION_DEFAULTS synced (no-flag build
  = fallback lane).
- worker.js picks the pkg via WebAssembly.validate on wasm-feature-detect's
  relaxed-simd probe module; the two pkgs are separate lazy chunks, so each
  visitor downloads one (~327 KiB either way; relaxed 335,227 B vs fallback
  334,735 B raw). The service worker precaches both (dist total 2.51 MiB)
  for offline; that background fetch is the priced ~2x-artifacts cost.
- webpack gotcha: the worker config's `.wasm` asset rule excluded only
  `pkg/`, so pkg-relaxed's wasm was emitted as a file asset (import returns
  a URL, breaks at runtime) — exclude is now `pkg(-relaxed)?/`.
- Both runtime branches verified rendering on the real dist (fallback
  branch forced by negating the detection in a patched dist copy — Chrome
  136's V8 no longer has a disable flag for shipped relaxed-simd; the
  fallback fetches the simd128 chunk and renders, the default fetches the
  relaxed chunk).
- **E2E (run-e2e, fma-pre2@HEAD vs fma-post2, n=5):**
  grid-z28-i50000 **5336 → 2987 ms, −44.0% warm, −44.0% cold** (the
  priced estimate was −27.5% before the 8/64 re-sweep). z36-i51200 −14.7%
  (cold −19.8%), z46-i6400 −13.8%, z20-i1600 −3.7%. Deep guards flat:
  z47 +1.0% (n.s.), z48-i48000 −0.1%, z48-i20000 −0.3%, z259 +0.7%,
  z48-i800 +0.7%, z85 −0.8%. **Overall e2e geomean −8.7%.** Cold tracks
  warm everywhere — the existing quadratic spawn warmup tiers the relaxed
  kernel, and feature detection adds nothing measurable.

### Reproduce

    node src/build.mjs baseline                      # fallback lane
    node src/build.mjs fma-ship --rustflags "-C target-feature=+simd128,+relaxed-simd"
    node src/run.mjs --variants baseline,fma-ship
    node src/pixel-check.mjs --b fma-ship --statistical
    node src/validate.mjs --variants baseline,fma-ship --pixel-check --statistical
    node src/build-dist.mjs pre --ref <pre-sha> && node src/build-dist.mjs post
    node src/run-e2e.mjs --variants pre,post

Backlog consequences: "residual z28-class throughput" is resolved — the
parked FMA lever shipped; the per-step op space on BOTH direct kernels is
again the bare recurrence, now at hardware-FMA cost. The general
(multibrot) kernel still runs the exact powu chain in both lanes — a
relaxed-FMA complex-multiply for it is the natural next candidate in the
sanctioned rounding lane, gated the same way (its heaviest real view is
z30-e6 at ~3.9 s e2e). Safari stays on the byte-exact lane until
relaxed-simd exists there at all.

## 2026-07-10 — SHIPPED: general (multibrot) kernel relaxed-FMA + fused `+c` powu step (grid-z30-e6 e2e −16.0%)

Machine: M1 MacBook (AC power). Backlog #1 after the quadratic FMA ship: the
same rounding-lane treatment for `stream_escape_general`, riding the existing
dual build and statistical gate. Relaxed lane only; the simd128 fallback keeps
the exact powu chain and is byte-identical to the anchor.

### The change (mandelbrot/src/lib.rs, all under `target_feature = "relaxed-simd"`)

1. `complex_mul_lanes` gains a relaxed branch: each component's second
   multiply fuses into the combining add/sub (`nmadd(a_im, b_im,
   mul(a_re, b_re))` / `madd(a_im, b_re, mul(a_re, b_im))`) — 6 ops → 4 per
   complex multiply. **Measured alone: only −6.3% on the e6 heavy.** The powu
   chain is a serial dependency chain per step (the 2026-07-09 lesson holds:
   latency-bound, not op-bound), so shaving parallel ops barely moves it.
2. The win came from shortening the chain: `fused_powu_add_c_lanes` folds the
   escape step's `+ c` into the powu chain's **final** complex multiply via
   `complex_mul_add_lanes` (`a*b + addend`, both cross terms and the addend
   fused — replaces final-multiply-then-add, one less serial step). Final-op
   identification: the last op is the `trailing_zeros`-th squaring when the
   exponent is a power of two, else the `exp == 1` accumulator multiply (the
   final `exp` is odd, so that multiply always runs last). **Fusion doubled
   the win to −18.5%.**
3. Escape replay runs through `fused_powu_add_c_lanes::<1>` with the value in
   lane 0 — the same instruction sequence as the vector step, per the
   quadratic ship's replay rule (never `f64::mul_add` on wasm32).

Re-sweep (chains 4/6/8 × stride 32/64/128 on the e6 heavy): **6 chains / 
stride 64**, cfg-gated to the relaxed lane (fallback keeps 6/32). Unlike the
quadratic kernel, 6 chains stays optimal — powu's per-chain temporaries make
8 spill (+9%) and 4 starve (+44%). Stride 64 beats 32 (75.3 vs 77.8 ms);
128 buys only another −1% and doubles the free-run/replay tax on
fast-escaping views — declined.

### Gates (all green)

- cargo test 59/59 (change is wasm-cfg-only).
- Fallback lane (no-flag build of the edited tree vs clean tree): **43/43
  byte-identical** — Safari lane provably unchanged, anchor and blessed
  hashes stay pinned, no re-bless.
- Fixed corpus statistical gate vs anchor: 43/43 within budget. The
  general-kernel diffs are tiny (e6: 20 px, 0 flips; multibrot3: 27 px,
  flip blob 1); the large z28/z44 signatures in the report are the
  already-shipped quadratic FMA vs the exact anchor, unchanged.
- Holdout (seed 2026-07-10, 40 direct + 40 pf64, --pixel-check
  --statistical): **80/80 within budget.** Timing overall +0.2% (the sample
  is quadratic-dominated; that kernel is untouched). Movers confirmed at
  --samples 10: hold-z20-1e197d5a (exponent 50, i200) **+29.3% = +1.7 ms**
  — the documented fast-escaping high-exponent stride-tax class (free-run +
  replay are fixed per-escaper costs; stride 64 doubles the free-run
  waste), accepted on absolute-time grounds like the quadratic ship's
  seahorse tax; hold-z48-c728a5ef pf64 +28.1% = +0.2 ms on a 0.7 ms view
  (pf64 code and output untouched — sub-ms layout noise class).

### Results

Wasm-level (run.mjs full corpus, n=10, genfma-final vs fma-base = relaxed
lane @ HEAD): **e6 view 92.7 → 75.3 ms (−18.8%, ms/Miter 0.372 → 0.302)**;
direct geomean −2.1%; pf64 +0.3%, float-exp +0.2% (controls); overall −0.6%.
syn-direct-z5-multibrot3 +0.7% n.s. (3.2 ms, Mariani-filled light view —
the e3 chain is only 2 multiplies, and the view is stride-tax-exposed).
Size 326.1 → 327.6 KiB (+0.5%).

E2E (run-e2e, genfma-pre@a280634 vs genfma-post, n=5):
- grid-multibrot corpus: **grid-z30-e6 3386 → 2845 ms (−16.0% warm, −18.2%
  cold — the existing warmupGeneralDirect tiers the new kernel)**;
  grid-z48-e52 −0.1% (pf64 general kernel untouched, control flat).
- grid-regression corpus: overall geomean −0.2%, every case within noise
  (z28 −1.0%, z47 +0.4%, z48-i48000 −0.0%, z259 +1.3%, z85 −2.1%).
- Fast-lane wasm 327.4 → 328.9 KiB (+1.5 KiB); fallback lane byte-identical.

### Reproduce

    node src/build.mjs fma-base --ref <pre-sha> --rustflags "-C target-feature=+simd128,+relaxed-simd"
    node src/build.mjs genfma-final --rustflags "-C target-feature=+simd128,+relaxed-simd"
    node src/run.mjs --variants fma-base,genfma-final
    node src/pixel-check.mjs --b genfma-final --statistical
    node src/validate.mjs --variants fma-base,genfma-final --pixel-check --statistical
    node src/build-dist.mjs genfma-pre --ref <pre-sha> && node src/build-dist.mjs genfma-post
    node src/run-e2e.mjs --variants genfma-pre,genfma-post --corpus corpus/grid-multibrot.json
    node src/run-e2e.mjs --variants genfma-pre,genfma-post

Backlog consequences: backlog #1 (general-kernel relaxed-FMA) is shipped;
both direct-tier kernels now run hardware-FMA bare recurrences in the fast
lane. Mechanism notes that survive: (a) FMA on a serial complex-multiply
chain buys little — the lever is removing a serial step (fold the recurrence
add into the chain's final multiply); (b) the general kernel's chains
optimum did NOT move under FMA (6, both lanes) — powu register pressure,
not step latency, binds it; only the stride moved (64, relaxed lane).
Remaining rounding-lane candidates in the direct tier: none — the per-step
op space on both kernels is now the fused bare recurrence. Next absolute-time
targets stay as ranked (z0 whole-set micro is the only open direct item).
