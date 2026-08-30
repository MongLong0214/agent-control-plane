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

No workflow enables it. Deciding which CI run should retain the artifact is separate from this
instrumentation.

## What one correlated update says

The worker stamps the real `rpc().onTaskUpdate` task pack immediately before birpc sends it. The
main reporter wraps Vitest's real `_testRun.updated` method, which includes state update, task-event
reporting, and every reporter's `onTaskUpdate`. The worker records when that same RPC promise
settles.

Each `measurement` line gives these clocks and boundaries:

| Field | Observation |
| --- | --- |
| `requestToMainMs` | worker send to entry into main `_testRun.updated` |
| `mainOnTaskUpdateMs` | time spent in main `_testRun.updated` |
| `outsideMainMs` | request-to-main plus response-to-worker time |
| `responseToWorkerMs` | main exit to the worker running the response callback |
| `workerActiveMs` | worker event-loop active time during the whole RPC, retained as raw context but not used to classify `(c)` |
| `workerActivityObserved` | whether the opt-in callback observer ran, so zero is distinct from no observation |
| `workerActiveAfterMainMs` | merged worker JavaScript callback activity overlapping main exit to worker settle |
| `workerEventLoopDelayMaxMs` | maximum worker delay observed by `monitorEventLoopDelay`; `null` means unmeasured |
| `ipcOrProcessSchedulingMs` | time outside main after subtracting only observed post-main worker activity |

The 100 ms classification threshold matches Vitest 3.2.7's task-update batching interval; it is
not a latency target. It does not discard data—all durations are written even below it—and only
gives a slow update a readable label:

- `(a) a-main-onTaskUpdate`: the main handler took at least 100 ms and time outside it stayed below
  100 ms.
- `(c) c-worker-event-loop`: the response gap, observed post-main worker callback activity, and
  worker event-loop delay histogram maximum were each at least 100 ms.
- `(b) b-ipc-or-process-scheduling`: at least 100 ms remains outside both measured handlers. The
  timestamps cannot honestly separate kernel IPC queueing from OS process scheduling, so the
  label names both rather than claiming kernel IPC alone.
- `insufficient`: more than one slow cause has evidence, or at least 100 ms lies outside the main
  handler without enough evidence to choose `(b)` or `(c)`. A 60-second update with 101 ms in main
  is reported as `main=101ms`, `outside-main=59899ms`, `insufficient`, not `(a)`.
- `incomplete`: at least one of worker send, main entry, main exit, or worker settle was not
  observed. `unattributedMainUpdates` separately counts main updates that arrived without a worker
  stamp. Neither absence is reported as zero.

Thus a timeout with only a long `mainOnTaskUpdateMs` is `(a)`; a short main interval and long
`ipcOrProcessSchedulingMs` is `(b)`; and a long response-to-worker gap accompanied by measured
post-main worker activity and histogram delay is `(c)`. When those observations do not identify
one cause, the result stays `insufficient`. Raw lines remain useful if the run dies before the
final summary.

## Sampling and cost

Tracing is installed only when the environment variable is set. While enabled:

- each real task-update RPC adds one small correlation object to task metadata;
- the worker reads event-loop utilization at send and settle;
- one native `monitorEventLoopDelay` histogram runs per active worker at 20 ms resolution and is
  reset whenever that worker has no pending task-update RPC;
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
and asserts `(b)` for a real `onTaskUpdate` while main and worker-active time stay short. The third
run lets the worker send a real suite update, holds that worker's JavaScript loop for 260 ms, and
asserts the response gap, post-main callback activity, histogram delay, and `(c)` measurement.
Three synthetic correlations preserve the review counterexamples: activity entirely before main
exit and a zero-delay histogram cannot produce `(c)`, while 101 ms in main plus 59,899 ms outside
main cannot produce `(a)`. These delays exist only in the fixture; the tracing code has no delay
injection.
