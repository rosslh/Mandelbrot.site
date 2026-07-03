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
