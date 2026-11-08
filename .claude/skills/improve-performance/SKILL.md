---
name: improve-performance
description: "Make Mandelbrot.site measurably faster, one experiment at a time, carried across hour-long runs: finish an experiment already in progress, take the top item of the perf-experiment backlog, or, when the backlog is spent, measure where real views spend their time and add new ranked items. Runs the experiment through the perf-experiment harness and gates, ships a winner to main (which deploys) only after it reproduces on a quiet machine, and records every result in bench/LOG.md. Pass 'routine' when a schedule runs it: trade-offs that need Ross are then held, not shipped; run manually, it first puts held items to him."
argument-hint: "'routine' when run by a schedule; otherwise an optional focus, e.g. 'direct tier only', 'discovery', or a backlog item"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

## What this is

`.claude/skills/perf-experiment/SKILL.md` holds the method: the three runners, the corpus, the
correctness gates, the holdout gate, how to judge trade-offs, and the ranked backlog. **Read it
in full at the start of every run.** This skill decides what a run works on, carries work from
one run to the next, and sets the limits for running without Ross.

The two sources disagree in two ways, and each has a winner:

- **On facts, `bench/LOG.md` wins.** perf-experiment's architecture notes and backlog are
  written by hand and fall behind: an item it lists as next may already have shipped, and a
  threshold or flag set it quotes may have changed since. Before picking work, reconcile it
  against the LOG entries newer than the facts in question, correct the stale statements and
  backlog items in perf-experiment, and commit that correction on its own.
- **On method and gates, perf-experiment wins** over anything here except the stricter rules
  in this skill (the verdict protocol and the "Held for Ross" list), which only add to it.

In routine mode, edit perf-experiment's backlog and its statements of fact only; never loosen
a gate, a threshold or an output policy there.

The goal is less wall-clock time waiting for tiles on real views, weighted by absolute time
saved on the slowest cases in each pathway tier, as perf-experiment describes. Its standing
focus directive (direct f64 tier first, deep tiers as regression guards) and every verdict it
or the LOG marks settled stay in force. Re-open a settled question only when a criterion it was
judged on has changed, and say which.

## Mode: manual or routine

**Routine mode** when the input above contains `routine`, or the session says a schedule or
routine started it. Otherwise **manual mode**: Ross is at the keyboard.

- **Manual mode**: start with step 0. Ask Ross (AskUserQuestion, recommended option first)
  when a trade-off below needs him.
- **Routine mode**: never ask and never stop on a question. Anything on the "Held for Ross"
  list is not shipped: record it in `bench/LOG.md` with the verdict `**Held for Ross**`, the
  numbers, and the decision he needs to make, then carry on with work that does not depend on
  it.

## One run at a time

Before anything else, after deciding the mode:

```sh
.claude/skills/improve-performance/run-lock.sh acquire
```

Benchmarks from two runs at once would measure each other. If a live session holds the lock:
in routine mode stop at once, change nothing, and report "Another /improve-performance run is
active" with the holder the script printed. In manual mode ask Ross whether to wait or take
over (`run-lock.sh release --force`, then `acquire`, only on his say-so). Release the lock at
the end of step 6 and on any other way out of the run.

## Held for Ross

These change something other than speed, so a routine run measures and records them but does
not ship them:

- a regression on any case beyond the significance threshold, accepted as the price of a win
  elsewhere (perf-experiment calls these taxes, and wants each argued in the log; Ross decides
  whether one is worth paying);
- any change to rendered output: an output diff in either build, a move onto the tolerance or
  statistical tier, re-blessing the anchor or the enrich hashes, or accepting changed
  snapshots (`cargo insta accept` or `npm run test:update-snapshots`);
- a new wasm feature, a raised browser floor, or anything else that changes which browsers get
  which build;
- a change a past commit or LOG entry made deliberately for a reason other than speed (the
  worker-pool cap is one: it leaves a core for the OS);
- a wasm size increase over 5% in either artifact, or any new dependency;
- anything perf-experiment or the LOG marks as waiting on a user decision.

## 0. Put held items to Ross (manual mode only)

Search `bench/LOG.md` for `**Held for Ross**` entries with no later resolution. Put them to
him, up to four per AskUserQuestion call, oldest first: what the change buys, what it costs,
and the numbers. Record his answer in the entry (`Resolved YYYY-MM-DD (Ross): ...`). An
approved item becomes this run's work (step 4); a declined one gets its verdict and moves to
settled in the backlog.

## 1. Survey

- `git status -sb`, `git fetch`, and `git log --oneline -10 origin/main`. If `main` is behind,
  `git pull --ff-only`.
- If the working tree has changes this run did not make, it is someone else's unfinished work:
  in routine mode change nothing, report it and stop; in manual mode ask Ross.
- Branches named `perf/*` are experiments a past run left in progress; the LOG entry for each
  says where it stopped. Other branches are Ross's; leave them alone.
- Read `bench/LOG.md`: its `##` headings first, then in full every entry on the tier or
  mechanism you are about to work on, and the newest few entries whatever they cover.
- Reconcile perf-experiment against the LOG, as above. Reconcile the harness too:
  `PRODUCTION_DEFAULTS` in `bench/src/build.mjs` must match the production build settings
  (root `Cargo.toml`, `.cargo/config.toml`, and the wasm-opt flags in `mandelbrot/Cargo.toml`),
  or a no-flag bench build is not a true baseline. Fix a mismatch in its own commit.
- Production builds with the latest stable Rust (see `Dockerfile`), so measure on it too. Run
  `rustup update stable` only when no `cargo` or `rustc` process is running (`pgrep -x cargo;
  pgrep -x rustc`): the toolchain is shared with other projects' builds. Record
  `rustc --version`, then confirm `node src/build.mjs baseline` builds from `bench/`. If it
  fails, fixing the harness is this run's work: newer compilers emit wasm features
  (bulk-memory, nontrapping-float-to-int) that wasm-opt must be told to accept, as the LOG's
  deploy-fix entry records.

## 2. Check the machine

Other routines (Rust builds, test suites, simulators) share this machine, and a timing verdict
is only as good as the machine was quiet while it ran. Two checks:

- **Before starting a timing run**: `pmset -g batt | head -1` says AC Power, and the 1-minute
  figure from `sysctl -n vm.loadavg` is at most 4.0. A heavy build is running otherwise, and
  the run would only waste an hour. Do not re-check the load during or right after a run: the
  benchmark's own workers drive it up.
- **The A/A pair inside every verdict run (step 4) is the real noise gate.** A run whose A/A
  pair flags any case was taken on a noisy machine, whatever the load said.

A run that fails either check is void and counts toward nothing. **When the machine is not
quiet, do not record a timing verdict.** Spend the run on work that needs none:

- correctness gates for the experiment in hand (`cargo test`, pixel-check, `verify-e2e`);
- writing the next variant;
- decomposition by reading code;
- ranking the backlog;
- the research half of discovery.

Note "awaiting a quiet machine" in the LOG entry and leave the timing for the next run.

## 3. Pick one piece of work

Take the first that applies:

1. **An experiment in progress**: a `perf/*` branch, or a LOG entry marked in progress or
   awaiting a quiet machine. Finish it before starting anything new. Once it has had twelve
   runs with a quiet machine (about two days of slots) and still has no verdict, close it
   instead: record it as inconclusive with what is known, and say what would justify re-opening
   it. Runs that found the machine busy do not count toward the twelve; keep the count in its
   LOG entry.
2. **An item Ross approved in step 0.**
3. **The top open item of the perf-experiment backlog**, after reconciliation, under the focus
   directive.
4. **Discovery, when the backlog has nothing worth running.** Find the next win from evidence,
   not from memory:
   - run the e2e suite on current `main` on a quiet machine, and rank cases by absolute time
     within each tier, as perf-experiment says;
   - decompose the slowest two or three by direct measurement (cold vs warm, orbit vs pixel
     loop, wasm vs client time) before forming a hypothesis;
   - look beyond the wasm kernels too: bundle parse and startup, worker spawn and warmups, wasm
     compile and tier-up, tile scheduling and cancellation in Leaflet, the service worker, and
     main-thread work while tiles stream in;
   - add each candidate to the backlog ranked by the absolute time it could save, with the
     measurement behind it, then start the top one.

   If discovery finds nothing with a plausible saving above the noise floor on a case that
   matters, write that in the LOG with the measurements and end the run. Do not invent churn.

**Each run has one hour.** The schedule gives each of Ross's project routines its own hour in
every four, and another project's routine starts when this one's hour ends. So stop 50 minutes
after the run started, whatever state the work is in, at the last clean point:

- commit the work so far to the experiment's `perf/<slug>` branch and push it;
- write or update the LOG entry as in progress, saying exactly what is done and what is next
  (which builds exist, which verdict invocations are taken, which gates have passed);
- let the next run continue.

An experiment usually spans several runs. Build artifacts (`bench/artifacts/`, the dists, and
`bench/results/`) stay on this machine between runs. Reuse them when the commit their
`meta.json` records still matches, rather than rebuilding. Plan each run's work to fit what is
left of its hour: a build, one verdict invocation, or one gate. Do not start a step that cannot
finish before the 50-minute mark.

## 4. Run it

Follow perf-experiment: iterate with the wasm-level runners, take the final verdict from
`run-e2e.mjs` on real client builds, then run the correctness gates and, for algorithmic
changes, the holdout gate. Two rules apply on top of it.

**Baseline at the merge base.** Work on a `perf/<slug>` branch. Build every baseline (`build.mjs`
and `build-dist.mjs`) from `git merge-base origin/main HEAD`, never from `HEAD`. On a resumed
branch `HEAD` already contains the experiment. If `origin/main` has moved since the baseline was
built, rebase the branch, rebuild the baseline at the new merge base, and take the verdict
again.

**Verdict protocol.**

- Build a second, identical baseline dist (`base-dist2`, same ref as `base-dist`), so every
  verdict run carries its own A/A pair:
  `node src/run-e2e.mjs --variants base-dist,base-dist2,exp-dist`.
- Make three independent invocations, each on a quiet machine. They may come from different
  runs as long as all three use the same builds. Each invocation contributes one cold sample per
  variant. If one invocation over the whole corpus will not fit in the time left, split it by
  `--filter` across consecutive runs on the same builds; the parts together count as one
  invocation, and each part must carry the A/A pair.
- A run in which the A/A pair flags any case is void; it does not count toward the three.
- The experiment **wins** only if all three hold:
  - one or more cases that matter are significant in at least two of the three runs and faster
    in all three;
  - their cold times are faster in all three runs;
  - no other case is significantly slower in more than one run.
- A case significantly slower in two or more runs is a regression. Ship it only as a tax, which
  is on the "Held for Ross" list.
- Report medians across the three runs. Report the cold change as the three individual numbers,
  not one figure.

**Gates.** A change ships when it wins under the protocol above and all of these hold:

- every correctness gate perf-experiment requires for its class passes, plus the holdout gate
  where it applies. A gate case the LOG records as non-deterministic is re-run once; it never
  justifies a re-bless.
- from `client/`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test`
  and `npm run build` all pass. From `bench/`, `npm run verify-e2e` passes against the fresh
  `client/dist`.
- for any change to code (not flags alone), a fresh adversarial reviewer has read the diff:
  - launch a general-purpose subagent, on the most capable model tier available, that did not
    write the change;
  - give it the diff, the LOG entry with the numbers, and perf-experiment's correctness rules
    for the change's class;
  - ask it to break the change: inputs where the output differs, engines or lanes it
    mishandles, warmups or caches it invalidates, gate claims the tests do not back;
  - tell it to read only: no tests, builds or benchmarks;
  - fix every finding, or record in the LOG entry why it is dismissed, then re-run the gates
    the fix touches.
- the change is not on the "Held for Ross" list.

Every experiment, shipped or not, gets a LOG entry in perf-experiment's format, plus the
`rustc` version, and the backlog is updated to match: shipped, settled negative, re-ranked, or
new items from what the experiment taught. Keep the mechanism notes that will help the next
run; the backlog is how this routine learns from one run to the next.

## 5. Land it

- **Shipped**: commit on the branch with a message in the repository's style (sentence case,
  imperative, no prefix) that states the e2e medians and the cold numbers from the verdict
  runs and the size delta. Then fast-forward `main` and push. Pushing `main` deploys
  mandelbrot.site.
- **Not shipped** (lost, inconclusive or held): commit only `bench/LOG.md` and the backlog
  change, straight to `main`, and push. Delete any `perf/` branch the run abandoned, local and
  remote. Code worth keeping for a held item stays on its pushed branch, named in the LOG
  entry.
- Stage files by path. Never commit `bench/results/`, `bench/artifacts/`, `client/dist/` or the
  events export.
- Delete a shipped `perf/` branch, local and remote, once step 6 passes.

## 6. Verify the deploy

Every push to `main` rebuilds production from source with the latest compiler, including a
LOG-only push, so check after each one:

1. Before pushing, save `curl -s https://mandelbrot.site/service-worker.js` and run
   `node .claude/skills/improve-performance/smoke-live.mjs`. It loads the live site in headless
   Chrome with every other host unresolvable, so it sends no analytics, and checks that tiles
   render with no page errors. Note whether it passed.
2. After pushing, poll the service worker every two minutes for up to 30 minutes until it
   differs from the saved copy. A LOG-only push may rebuild to identical assets. If nothing
   changes, run the smoke test anyway, and say in the report that no new deploy was observed.
3. Confirm every `.wasm` file the new service worker lists returns 200, then run the smoke test
   again.

Revert only on evidence that this push broke the site: the smoke test passed before the push
and fails after it, on a ship. Then revert the commit on `main` and push the revert. That is in
scope without asking, because the revert restores what was running. Verify again and report
it. If the smoke test already failed before the push, the cause is not this change: report it,
and do not revert. If it fails after a LOG-only push, the source did not change, so report it
rather than reverting: the deploy environment has broken, and fixing that is Ross's call.

Then confirm `git status -sb` shows `main` level with `origin/main`, release the lock, and
report:

- what was tried, and the verdict with its numbers;
- what shipped, and whether the deploy and the smoke test passed;
- anything held for Ross;
- what the next run should pick up.
