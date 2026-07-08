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
