# #719 phase 2 — measuring Vitest `onTaskUpdate` timeouts

This is an opt-in diagnostic, not a timeout fix. It does not change Vitest's pool, worker count,
reporters, test or hook timeouts, or birpc's 60-second default.

## Use

Leave `ACP_VITEST_RPC_TRACE` unset for the ordinary suite. To trace one run:

```sh
ACP_VITEST_RPC_TRACE=1 CI=1 pnpm test
```

The run writes `evidence/local/vitest-rpc-trace-<run-id>.ndjson` and prints one final line with the
counts for `(a)`, `(b)`, `(c)`, insufficient classifications, incomplete observations, and the
slowest RPC's component times. A path can be supplied instead of `1` when a caller needs to retain
the file elsewhere:

```sh
ACP_VITEST_RPC_TRACE=/tmp/acp-vitest-rpc.ndjson CI=1 pnpm test
```

The top-level run creates that exact path exclusively and refuses to replace a file that already
exists. If a test starts another Vitest process with the trace environment inherited, the nested
run remains instrumented but owns a sibling file named
`/tmp/acp-vitest-rpc.<run-id>.ndjson`. This keeps the nested observations instead of suppressing
them, while preventing either run from appending to or replacing the other's trace.

No workflow enables it. Deciding which CI run should retain the artifact is separate from this
instrumentation.

## What one correlated update says

The worker stamps the real `rpc().onTaskUpdate` task pack immediately before birpc sends it. The
main reporter wraps Vitest's real `_testRun.updated` method, which includes state update, task-event
reporting, and every reporter's `onTaskUpdate`. The worker records when that same RPC promise
settles.

Each `measurement` line reports intervals instead of subtracting one interval from another:

| Field | Observation |
| --- | --- |
| `requestToMain` | worker send to entry into main `_testRun.updated` |
| `mainOnTaskUpdate` | entry into main `_testRun.updated` to its return |
| `mainReturnToResponseArrival` | main return to response arrival in the worker; currently `null` because the JavaScript hooks do not observe transport arrival before the worker event loop runs |
| `responseArrivalToWorkerPickup` | response arrival to the worker promise callback; currently `null` for the same reason |
| `unpartitionedMainReturnToWorkerPickup` | the directly observed main-return-to-worker-pickup interval, retained without assigning its time to transport or the worker |

Every interval is a `{ durationMs, workerBusyMs, workerEventLoopDelayMaxMs }` object. Worker busy
time is the merged JavaScript callback activity that overlaps that exact interval. The existing
event-loop histogram covers the whole pending RPC and has no timestamps, so the per-interval
event-loop-delay value is `null`; `workerHistogramDelayMaxMs` retains the raw histogram maximum
without assigning it to a segment. That histogram starts when tracing is installed and resets only
after all pending task-update RPCs settle. Its maximum is therefore not per-RPC: it can include
delay before the measured RPC began and, when RPCs overlap, delay from the other RPCs. The value is
diagnostic context only and is not used for classification. `workerActivityObserved` and
`responseArrivalObserved` distinguish an observed zero from an unmeasured value. The `unmeasured`
array names the three unavailable observations explicitly.

The 100 ms classification threshold matches Vitest 3.2.7's task-update batching interval; it is
not a latency target. It does not discard data—all durations are written even below it—and only
gives a slow update a readable label:

- `(a) a-main-onTaskUpdate`: the directly observed main handler took at least 100 ms and the
  unpartitioned response interval stayed below 100 ms.
- `(b) b-ipc-or-process-scheduling`: the directly observed request-to-main interval took at least
  100 ms, while the main and unpartitioned response intervals stayed below 100 ms.
- `(c) c-worker-event-loop`: reserved for a future observation that measures response arrival and
  at least 100 ms of worker busy time inside the arrival-to-pickup window. The current hooks cannot
  measure that window and therefore never emit this classification.
- `insufficient`: more than one directly observed segment is slow, or the main-return-to-worker
  interval is at least 100 ms but response arrival was not observed. That interval may contain
  transport delay, process scheduling, or worker pickup delay; overlapping worker activity does
  not split it.
- `incomplete`: at least one of worker send, main entry, main exit, or worker settle was not
  observed. `unattributedMainUpdates` separately counts main updates that arrived without a worker
  stamp. Neither absence is reported as zero.

Thus a timeout with only a long `mainOnTaskUpdate.durationMs` is `(a)`, and a timeout with only a
long `requestToMain.durationMs` is `(b)`. A long unpartitioned response interval remains
`insufficient`, even when worker activity overlaps most of it. Raw lines remain useful if the run
dies before the final summary.

## Sampling and cost

Tracing is installed only when the environment variable is set. While enabled:

- each real task-update RPC adds one small correlation object to task metadata;
- the worker reads event-loop utilization at send and settle;
- one native `monitorEventLoopDelay` histogram runs per active worker at 20 ms resolution and is
  reset after the worker's pending task-update RPC count returns to zero;
- an async-hooks observer timestamps JavaScript callback-active intervals only while an update RPC
  is pending; overlapping intervals are merged before calculating post-main activity;
- each RPC emits four boundary records—worker send/settle and main entry/exit—plus callback-active
  records observed while an RPC is pending;
- records use one append-only file descriptor per process and serialized asynchronous writes; the
  task-update path does not await filesystem I/O;
- the main process reads the trace once at run end, then appends one derived measurement per RPC
  and one summary.

There is no periodic JavaScript sampler, process-tree walk, CPU profiler, or console line per
update. Callback-active records also scale with worker callback activity while an RPC is pending,
so this remains a diagnosis switch rather than a default CI mode.

## Artificial verification

`tests/process/vitest-rpc-trace.test.ts` starts nested Vitest runs through this repository's real
configuration and fork pool. One nested run blocks a main reporter for 180 ms and asserts an `(a)`
measurement. A test-only setup delays worker RPC response delivery at the process-message boundary
and asserts that the real `onTaskUpdate` remains `insufficient` without response-arrival timing.
The third run lets the worker send a real suite update, holds that worker's JavaScript loop for 260
ms, and asserts that the unsplit response interval, worker activity, and worker histogram also
remain `insufficient`. Four synthetic correlations preserve the review counterexamples: activity
before an unobserved arrival and a zero-delay histogram cannot produce `(c)`; 101 ms in main plus
59,899 ms after main cannot produce `(a)`; and 59,950 ms of worker activity overlapping a 60-second
response gap is not subtracted into a 50 ms transport claim. These delays exist only in the
fixture; the tracing code has no delay injection.

The same test file also starts a Vitest process whose test starts another Vitest without changing
the inherited trace environment. It asserts that the parent keeps the requested custom path, the
nested run succeeds with a run-id sibling path, and both files contain their own summary.
