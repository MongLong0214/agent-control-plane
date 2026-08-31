# #719 reporter RPC timeout measurement

Measured on 2026-08-31 against `0d722bd` with Vitest 3.2.7, Node 22.23.2,
Darwin 25.3.0 arm64, and 12 available CPUs. The local host is not a GitHub Actions runner.
Nothing in this document treats a local non-reproduction as a runner result.

## Result

The timeout is 60,000ms. It is birpc's default call timeout, not this repository's
`testTimeout` or `hookTimeout`, and Vitest 3.2.7 exposes no standard configuration key for it.

The exact CI delay remains **unmeasured**. The exception text proves that the worker did not
process a matching response inside 60 seconds. It does not distinguish these cases:

- the main process had not finished `onTaskUpdate`;
- the response was delayed in child-process IPC; or
- the main process had replied but the worker event loop did not process that reply in time.

The source and local runs do narrow the mechanism. The `junit` and `json` reporters do not write
on every task update. They build and write their reports in `onFinished`. In CI the `default`
reporter is non-TTY and disables its dynamic summary. Thus "three reporters synchronously rewrite
three reports for each update" is not the mechanism in Vitest 3.2.7.

The strongest remaining hypothesis is scheduling or IPC starvation under the loaded CI process
mix. The writer-census file contributes material process, CPU, and filesystem pressure, but the
measurements below neither establish it as the cause nor eliminate it. The current file uses
asynchronous `spawn`, so its child waits do not by themselves block the worker's JavaScript event
loop. A failing-run main/worker event-loop trace is still needed to locate the missing 60 seconds.

## Reproduction and measurements

The reporter set came from `CI=1`; no reporter, pool, or worker setting was changed.
`/usr/bin/time -lp` supplied wall/user/sys figures. In this sandbox it prints
`sysctl kern.clockrate: Operation not permitted` after the command and therefore makes its own
wrapper exit 1. Run R4 below repeats the affected test without that wrapper and records the actual
Vitest exit code.

| run | command | result | RPC timeout |
|---|---|---|---|
| R0 | `pnpm exec vitest list` | 116 files and 1,667 listed test paths; the candidate has 26 tests | not applicable |
| R1, candidate included | `/usr/bin/time -lp env CI=1 pnpm test` | wall 484.40s, user 280.12s, sys 196.90s; Vitest 480.76s; 39 failed, 76 passed, 1 skipped files; 249 failed, 1,418 passed, 6 skipped tests; candidate passed 26/26 in 82.909s | no |
| R2, candidate excluded | `/usr/bin/time -lp env CI=1 pnpm exec vitest run --exclude tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts` | wall 481.37s, user 168.32s, sys 156.74s; Vitest 480.68s; 39 failed, 75 passed, 1 skipped files; 249 failed, 1,392 passed, 6 skipped tests | no |
| R3, candidate only, timed | `/usr/bin/time -lp env CI=1 pnpm exec vitest run tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts` | wall 67.85s, user 101.09s, sys 30.10s; Vitest 67.29s; 26/26 passed | no |
| R4, candidate only, exit check | `CI=1 pnpm exec vitest run tests/process/the-turn-fence-inline-db-run-census-enforces-declared-owners.test.ts` | exit 0; Vitest 65.82s; 26/26 passed; JUnit and JSON reports written | no |

R1 and R2 were not clean functional gates. Socket binding is blocked by this sandbox. Both runs
therefore had many `listen EPERM` failures followed by test timeouts. Those failures are
**sandbox-suspected, unmeasured outside the sandbox**, not repository defects and not evidence
about #719. Both runs also observed
`tests/process/harness-refuses-concurrent-edits.test.ts` timing out at 120 seconds and leaving its
`concurrent-writer-marker` in `src/runtime/hermes-ceo.ts`; the marker was removed after each run.
This is a measured failed-run cleanup outcome, not a diagnosis of that test.

Consequently:

- the `onTaskUpdate` exception itself did not reproduce in either full invocation or either
  candidate-only invocation;
- a full local run in which every test passes and the process then reaches the reported CI failure
  shape is **unmeasured** because the sandbox prevents that precondition;
- Node 22.18.0 is **unmeasured** locally;
- GitHub macOS runner load and the two observed matrix environments are **unmeasured** locally.

R1 versus R2 removes exactly one file and 26 tests. It removes 111.80s user CPU and 40.16s system
CPU from these non-controlled runs, but only 3.03s of wall time because the same 480-second
sandbox-blocked socket test remained the critical path. The CPU delta is evidence that the file is
expensive. It is not a causal estimate for #719 because the two suite runs were not otherwise
controlled and did not reproduce #719.

The candidate's 82.909s duration in R1 is close to the reviewed 83.856s. Its direct child count can
also be reconstructed from the source: each of 26 tests starts one `git clone` and one census
`node`, and four expanded probes add ten `tsc`, `esbuild`, or execution children. That is 62 direct
`spawn` calls per matrix leg, or 124 across two legs. Subprocesses started internally by `git` are
not included. The two matrix legs run on separate runners, so 124 is a workflow sum, not 124 direct
children on one host.

## Where 60 seconds comes from

The installed bundle in `node_modules/vitest/dist/chunks/index.B521nVV-.js` declares
`DEFAULT_TIMEOUT = 6e4`. `createBirpc` selects `timeout = DEFAULT_TIMEOUT`, starts that timer when a
request is posted, and clears it only when the calling side handles the matching response.

`node_modules/vitest/dist/chunks/rpc.-pEldfrD.js` creates the worker RPC. `onTaskUpdate` is not in
its `eventNames`, so it is a response-bearing call and receives that timeout. Its timeout handler
is the source of `[vitest-worker]: Timeout calling "onTaskUpdate"`.

The standard worker path does not pass a timeout. `node_modules/vitest/dist/worker.js` calls
`createRuntimeRpc(worker.getRpcOptions(ctx))`, while `node_modules/vitest/dist/workers.d.ts`
defines `WorkerRpcOptions` as only `on`, `post`, `serialize`, and `deserialize`. The forks worker
supplies those transport operations and no timeout. The resolved Vitest config types and CLI have
no worker-RPC-timeout option.

Therefore there is no `vitest.config.ts` key to set for this timeout in Vitest 3.2.7. birpc itself
accepts an options-level `timeout`, but the standard Vitest worker configuration does not expose
it. Editing the installed bundle or supplying an unsupported custom worker is not a configuration
key. The equal 60,000 values in this repository's `testTimeout` and `hookTimeout` are coincidental
and govern different timers.

## One task update's lifecycle

The relevant source path is:

```text
worker runner
  updateTask -> batch for up to 100ms
  -> rpc().onTaskUpdate(packs, events) + 60s birpc timer
  -> keep the promise, continue running tests

main process
  state.updateTasks
  -> process event records in order
  -> await matching reporter hooks
  -> await legacy onTaskUpdate hooks
  -> send RPC response

worker runner
  handle response and clear timer
  -> await any still-pending update promises at the end of the file
```

`@vitest/runner` does not await each update at the call site. It stores the returned promise in
`pendingTasksUpdates` and awaits the set only after the file finishes. An update may therefore be
outstanding while the worker starts later test work. This matters because the exception measures
round-trip observation at the worker, not only main-handler CPU time. Long synchronous work in
that worker can prevent it from observing an already available response; asynchronous child waits
leave the event loop able to observe it, subject to OS scheduling and IPC pressure.

On the main side, `createMethodsRPC(...).onTaskUpdate` awaits `_testRun.updated`. That method first
updates central task state, processes each event sequentially, and awaits `vitest.report(...)`.
The reporter dispatcher invokes whichever reporters implement that hook in parallel.

### `default` under CI

Vitest's `isTTY` is `process.stdout.isTTY && !isCI`. With `CI=1`, `DefaultReporter` is non-TTY and
sets `summary` false. It does not run the live `SummaryReporter` renderer.

For a test-finished event, the base reporter checks whether the test failed. For a module-finished
event, it walks that module's tests, formats failures and slow tests, and writes the module result.
That is real per-update main-process work, including stdout writes, but no local invocation showed
one such round trip reaching 60 seconds. Per-hook latency is **unmeasured** because the failure did
not reproduce and no timing instrumentation was installed.

### `junit`

`JUnitReporter` opens its target file in `onInit`, but it has no task-update or test-result hook.
Its `onFinished` flattens the completed files and tasks, formats XML, writes the elements, and
closes the file. It therefore does not write XML once per worker task update.

### `json`

`JsonReporter` records a start time in `onInit` and has no task-update or test-result hook. Its
`onFinished` walks all completed files and tests, builds the result object, serializes it once, and
writes the configured JSON file once.

Normal JUnit/JSON finalization occurs in the run-end path, after worker file execution has awaited
pending task updates. Source order therefore does not support final XML/JSON writing as the work
holding an ordinary `onTaskUpdate` response open. A failing-run trace could overturn that only by
showing an unexpected lifecycle overlap.

## Answered and unanswered questions

Answered:

- Timeout: 60,000ms from birpc's bundled default.
- Configuration: no supported Vitest 3.2.7 config key for the standard forks worker.
- Main handler: central state update, ordered event-to-reporter dispatch, then legacy
  `onTaskUpdate` dispatch.
- CI default mode: non-TTY with the live summary disabled.
- JUnit/JSON per update: neither writes its report per update; both write at finish.
- Local exception reproduction: no, in R1-R4.
- Candidate cost: 82.909s inside R1, 65.462-66.902s alone, and 62 direct children per leg.
- Candidate causality: not established. Including and excluding it both produced no RPC timeout.

Unanswered or unmeasured:

- Which process failed to get scheduled during the observed CI 60-second window.
- Whether the main handler had already sent the response when the worker timer fired.
- Main event-loop delay, worker event-loop delay, IPC queue delay, and individual reporter-hook
  latency in a failing run.
- Whether Node 22.18.0 versus the moving Node 22 alias changes the probability.
- Whether runner CPU, filesystem, or stdout load is a necessary condition.
- A clean full-suite local post-test reproduction outside the socket-restricted sandbox.

## Most likely mechanism and alternatives

The most likely current mechanism is not reporter file serialization but transient scheduling or
IPC starvation: task-update promises overlap subsequent test work; many forks and real children
compete for CPU and filesystem service; and the fixed worker-side timer includes the time until the
worker handles the response. The zero-test-failure CI observations, local non-reproduction,
candidate CPU cost, and source lifecycle all support that mechanism. They do not prove where the
60 seconds was spent.

Alternatives not excluded:

- a main-process event-loop stall in Vite/task-state work before reporter dispatch;
- stdout backpressure or a very slow non-TTY default reporter module print;
- a worker event-loop stall from synchronous work in another spawn-heavy test while an earlier
  update promise is outstanding;
- child-process IPC backlog or a Vitest/tinypool/macOS interaction independent of reporters;
- a Node 22 patch-version-specific scheduling or IPC behavior.

JUnit/JSON per-update writes are excluded by the installed source. Their finish-time cost is not a
leading alternative because of lifecycle order, although its absolute duration was not separately
profiled.

## Fix candidates, not changes

No candidate below was installed.

1. Add temporary failing-run telemetry for worker RPC send/response timestamps, main
   `_testRun.updated` entry/exit, reporter-hook durations, and main/worker event-loop delay. This is
   the only candidate that distinguishes main work from worker response starvation. It assumes a
   diagnostic Vitest patch or custom build is acceptable for a measurement run; without a failing
   run it produces no answer.
2. Reduce the writer-census process load by reusing a prepared scratch baseline or batching probes
   while still entering through the real census command. This assumes its 62 direct children and
   repeated clones/copies materially contribute to starvation, and that isolation and the
   production entry path can be preserved. R1-R4 show cost, not causality.
3. Experiment with fewer CI workers or a serial lane for process-heavy files. This assumes
   scheduler headroom is the missing resource. It should be treated as a causal experiment before
   becoming configuration; the present measurements do not identify a safe worker count.
4. Raise the RPC timeout only through a Vitest version or supported option that actually exposes
   it. This assumes measured healthy updates legitimately need more than 60 seconds. Vitest 3.2.7
   has no key, and a larger timer can only hide starvation if that assumption is false.
5. Change or remove reporters only if failing-run telemetry names a reporter hook. Current source
   weighs against removing JUnit or JSON: neither participates in per-update work, both are
   intentional CI outputs, and JSON feeds `trace`.

## Downstream checks skipped by a test failure

`.github/workflows/ci.yml` runs these steps in this order in one matrix job:

```text
pnpm test
pnpm guards:falsifiable
pnpm trace
node scripts/ssot-report.mjs
```

The last three steps have no `if: always()` and no independent job boundary. GitHub Actions'
default success condition therefore skips all three when `pnpm test` fails. An RPC timeout makes
them neither green nor red; they are unexecuted. This is source-confirmed from the workflow, not a
locally executed Actions result. The full `guards:falsifiable` sweep was not run during this work.

Separating the three existing checks into clean-checkout jobs is a distinct candidate worth
considering. Merely adding `if: always()` in the same workspace assumes a failed test leaves the
tree clean; R1 and R2 each left a mutation marker after a timed-out test, so that assumption did
not hold locally. Independent clean workspaces would assume the extra CI cost is acceptable and
that `trace` defines what it should report when the test-result artifact is missing or incomplete.

## Implemented resolution

Follow-up work on 2026-08-31 upgraded the pinned version to Vitest 4.1.11 and added an
exit-code-independent result gate. These are two separate protections: the version removes the
specific 60-second worker RPC timer, while the gate distinguishes product failures and incomplete
result sets and fails closed when a nonzero process exit has no cause in its report artifacts.

### Vitest 4 source result

The exact 4.1.11 npm artifact contains the structural change #719 needed:

- `dist/chunks/rpc.MzXet3jl.js` passes `timeout: -1` when it creates the runtime worker RPC;
- `dist/chunks/cli-api.CnMVyzaz.js` also passes `timeout: -1` for the pool-side RPC;
- bundled birpc still declares `DEFAULT_TIMEOUT = 6e4`, but creates a timer only when
  `timeout >= 0`; and
- `onTaskUpdate` still crosses that RPC and still awaits the main process's test-run update, so
  this is a timeout removal rather than a claim that the update path disappeared.

There is still no repository configuration key for this timer. Vitest 4.1.11 disables it inside
the standard transport. Consequently the exact `[vitest-worker]: Timeout calling "onTaskUpdate"`
failure cannot be produced by waiting 60 seconds on that worker RPC in 4.1.11.

The 4.1.11 JSON reporter's `StatusMap` keeps the evidence needed by the gate: task states `run`
and `queued` become assertion status `pending`, while mode/state `skip` becomes `skipped` and
`todo` remains `todo`. Its top-level `numPendingTests` counter is less precise: it combines
`run`/`queued` tests with skipped tests. The gate therefore reads assertion status to distinguish
unfinished work from intentional non-execution, and checks `numPendingTests` against the combined
pending-plus-skipped assertion count.

The same source also establishes what those report files cannot prove. `JsonReporter.onTestRunEnd`
does not consume the `unhandledErrors` argument, and computes `success` only from collected files,
failed suites, and failed tests. `JUnitReporter.onTestRunEnd` likewise consumes only test modules.
The blob reporter would serialize unhandled errors, and the default reporter prints their type and
message, but neither JSON nor JUnit preserves them. The run writes both files; the classifier reads
JSON and inherits the default reporter's output instead of capturing it. A complete passing JSON
report plus exit 1 therefore does not identify whether the process saw a product-code rejection, a
reporter failure, or an RPC failure.

The old RPC timeout text and an ordinary unhandled rejection are visually distinguishable in the
default reporter output, but there is no remaining retry case to justify adding a text classifier:
the pinned 4.1.11 transport disables the specific `onTaskUpdate` timeout this change addressed.
No other error signature has been established as safely retryable. The gate therefore treats every
nonzero exit after a complete passing report as an unexplained run failure and fails the first run.
It does not retry.

The npm artifact does not bundle a changelog. External release-note review was unavailable in the
networkless sandbox and is **unmeasured**. The locally available package and source did expose the
relevant compatibility changes: Vitest now requires Node 20.x, 22.x, or 24 and newer; this repository
requires Node 22.18.0 and therefore remains inside that range. Vitest 4 removes `test.poolOptions`,
but this repository uses the still-supported top-level `pool: "forks"` setting and has no
`poolOptions` entry.

An exact Vitest 4.1.11 runner, assembled from cached npm artifacts and pointed at this repository,
accepted the existing config and collected all 116 test files. The full run took 480.57 seconds:
75 files passed, 40 failed, and 1 skipped; 1,426 tests passed, 250 failed, and 6 skipped, with 11
errors. The run did not emit an `onTaskUpdate` RPC timeout. Its failure output was dominated by
socket binding and writes beneath the sandbox-blocked user scratch directory; the run is
**sandbox-suspected, unmeasured outside the sandbox**, not an outside-sandbox compatibility result.
A focused 4.1.11 run of the new result-gate file passed 6/6 tests, and its CI reporter output
contained a completed interval for the one collected file and consistent 6/6 counters.

### Result gate

`pnpm test` now enters `scripts/run-vitest-gate.mjs`. Before the run it deletes both old report
files, runs the normal Vitest production entry point, and classifies the new JSON result:

- every assertion must have a recognized status, and the enumerated assertion total must equal
  `numTotalTests`;
- the enumerated passed, failed, pending-or-skipped, and todo distributions must equal
  `numPassedTests`, `numFailedTests`, `numPendingTests`, and `numTodoTests`, while the four counters
  must account for `numTotalTests`;
- suite counters must likewise account for `numTotalTestSuites`;
- a consistently reported failed assertion is a product failure;
- a collected file without a finite, ordered start/end interval, or with any `pending` assertion,
  is incomplete and fails;
- missing, malformed, empty, inconsistent, or unsuccessful result data fails closed;
- a complete result with no product failure plus exit zero passes; and
- a complete result with no product failure plus a nonzero exit is an unexplained run failure.

No failed classification is retried or converted to success. In particular, a later passing run
cannot erase an intermittent unhandled error whose first JSON report looked completely green.

The incomplete fixture is an actual 4.1.11 JSON report. A forked test first waited 100 ms so its
`run` update reached the main process, then sent `SIGTERM` to its own worker. Vitest exited 1 and
warned that a test was still running, but wrote `success: true`, `numPendingTests: 1`, a `pending`
assertion, and equal finite file start/end times. That saved output drives both the classification
test and the no-retry test; the latter supplies a successful second attempt and proves it is never
called.

Six report counterexamples cover a shorter assertion enumeration, a longer enumeration, and each
of the four mismatched status counters. A separate integration test calls the production `main()`
path, which spawns Vitest 4.1.11 against a one-test fixture with an opt-in unhandled rejection,
writes JSON and JUnit to isolated temporary paths, reads the real JSON through the gate, and fails
that run once. In the measured focused run the child reported one passing test, `success: true`,
one unhandled rejection, and exit 1; the gate returned 1 without retrying. The outer focused file
passed 12/12 tests.

Four classification counterexamples remain permanent mutation rows. Each row has a
regular-expression-safe test selector:

| mutation | named test |
|---|---|
| ignore a failed assertion | `fails when the result contains a failed test` |
| conflate a pending assertion with a completed skip | `classifies a reporter pending assertion as incomplete` |
| treat a nonzero exit after complete pass as zero | `fails closed when a nonzero exit follows complete passing results` |
| retry an unexplained run failure into a pass | `does not retry an unexplained run failure` |

### Independent downstream jobs and cost

Guard falsifiability, traceability, and SSOT reconciliation now each run in a separate checkout
after `verify-matrix`, under a job-level `always()` condition. The required `verify` job allow-lists
success from all four jobs, so a failed, cancelled, or skipped downstream job cannot satisfy the
gate. No downstream command runs in a workspace a failed test or mutation may have edited.

Traceability deliberately does not download a matrix artifact: it runs its own suite and creates
its own JSON result in the clean checkout. This preserves its complete-result dependency when
both matrix tests fail or produce no artifact.

The source-counted workflow cost changes are exact: full-suite invocations increase from two to
three, full falsifiability sweeps decrease from two to one, and SSOT invocations decrease from two
to one. Three independent job setup/install sequences are added. The local 4.1.11 full-suite run
above measured 480.57 seconds, but GitHub runner duration for the extra traceability suite, the
falsifiability job, job startup, and install/rebuild is **unmeasured**. All dependency-bearing jobs
use `actions/setup-node`'s pnpm cache with the same lockfile-derived key; actual cache hits and
saved runner time are **unmeasured** until this workflow runs on GitHub Actions.
