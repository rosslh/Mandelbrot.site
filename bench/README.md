# Benchmark harness

Performance benchmarks for the WebAssembly tile renderer, run in real Chrome
(via Puppeteer and Chrome for Testing) rather than Node, so results reflect
what V8 actually does with the shipped module.

The core loop: build one or more wasm variants with alternative compiler or
`wasm-opt` flags (or a code change), run each against the corpus, and compare
timings against the pinned baseline in `anchor.json`. Every experiment,
shipped or rejected, gets an entry in [`LOG.md`](LOG.md) so settled
questions are not re-run.

## Scripts

Run from this directory (`npm install` first):

- `npm run build-variant`: build a wasm variant with specific flags.
- `npm run run`: benchmark a variant against the corpus.
- `npm run compare`: compare variant results against the baseline.
- `npm run pixel-check`: verify output is byte-identical to the baseline.
- `npm run ingest`: turn exported analytics rows into corpus cases.

`src/run-e2e.mjs` measures end-to-end page-load-to-rendered time (the
standard test for anything touching startup), and `src/run-grid.mjs` runs
full-grid regression workloads.

## Corpus

[`corpus/corpus.json`](corpus/corpus.json) holds the cases: synthetic views
covering each render pathway (direct f64, perturbation, float-exp) plus
views ingested from real user traffic, selected to match the observed
composition of production workloads. Auxiliary corpus files cover grid and
high-iteration workloads.

## Ship gates

A change ships only if it clears:

1. **Significance**: per-pathway geomean deltas vs the baseline, with the
   harness's noise floor validated by A/A runs (two identical builds must
   show no significant difference).
2. **Correctness**: output must be byte-identical to the baseline on every
   corpus case. Changes that legitimately alter floating-point results
   (e.g. hardware FMA) can instead use the opt-in anchor-relative
   statistical-equivalence tier defined in `src/tolerance.mjs`.
3. **Holdout**: a final validation run on cases not used while iterating.

The `perf-experiment` skill (`.claude/skills/perf-experiment`) automates
this workflow, including appending the `LOG.md` entry.
