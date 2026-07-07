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
