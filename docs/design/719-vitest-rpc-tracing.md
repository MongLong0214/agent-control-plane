# #719 phase 2 — measuring Vitest `onTaskUpdate` timeouts

This is an opt-in diagnostic, not a timeout fix. It does not change Vitest's pool, worker count,
reporters, test or hook timeouts, or birpc's 60-second default.

## Use

Leave `ACP_VITEST_RPC_TRACE` unset for the ordinary suite. To trace one run:

```sh
ACP_VITEST_RPC_TRACE=1 CI=1 pnpm test
```

The run writes `evidence/local/vitest-rpc-trace-<run-id>.ndjson` and prints one final line with the
counts for `(a)`, `(b)`, `(c)`, incomplete observations, and the slowest RPC's component times. A
path can be supplied instead of `1` when a caller needs to retain the file elsewhere:

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
| `responseToWorkerMs` | main exit to the worker running the response callback |
| `workerActiveMs` | worker event-loop active time during the whole RPC, from Node's event-loop utilization counter |
| `workerEventLoopDelayMaxMs` | maximum worker event-loop delay observed by `monitorEventLoopDelay` |
| `ipcOrProcessSchedulingMs` | time outside the main handler after subtracting worker-active response pickup time |

The 100 ms classification threshold matches Vitest 3.2.7's task-update batching interval; it is
not a latency target. It does not discard data—all durations are written even below it—and only
gives a slow update a readable label:

- `(a) a-main-onTaskUpdate`: the main handler itself took at least 100 ms.
- `(c) c-worker-event-loop`: the main had returned at least 100 ms earlier and the worker was
  active for at least 100 ms before it ran the response callback.
- `(b) b-ipc-or-process-scheduling`: at least 100 ms remains outside both measured handlers. The
  timestamps cannot honestly separate kernel IPC queueing from OS process scheduling, so the
  label names both rather than claiming kernel IPC alone. `workerActiveMs` covers the full RPC,
  so its subtraction is a conservative attribution aid rather than an exact transport profiler.
- `incomplete`: at least one of worker send, main entry, main exit, or worker settle was not
  observed. `unattributedMainUpdates` separately counts main updates that arrived without a worker
  stamp. Neither absence is reported as zero.

Thus a timeout with a long `mainOnTaskUpdateMs` is `(a)`; a short main interval and long
`ipcOrProcessSchedulingMs` is `(b)`; and a long response-to-worker gap accompanied by worker
active time and event-loop delay is `(c)`. Raw lines remain useful if the run dies before the final
summary.

## Sampling and cost

Tracing is installed only when the environment variable is set. While enabled:

- each real task-update RPC adds one small correlation object to task metadata;
- the worker reads event-loop utilization at send and settle;
- one native `monitorEventLoopDelay` histogram runs per active worker at 20 ms resolution and is
  reset whenever that worker has no pending task-update RPC;
- each RPC emits four small NDJSON records: worker send/settle and main entry/exit;
- records use one append-only file descriptor per process and serialized asynchronous writes; the
  task-update path does not await filesystem I/O;
- the main process reads the trace once at run end, then appends one derived measurement per RPC
  and one summary.

There is no periodic JavaScript sampler, process-tree walk, CPU profiler, or console line per
update. CPU work, memory, filesystem traffic, and the task-metadata bytes all scale linearly with
the number of task-update RPCs, so this remains a diagnosis switch rather than a default CI mode.

## Artificial verification

`tests/process/vitest-rpc-trace.test.ts` starts nested Vitest runs through this repository's real
configuration and fork pool. One nested run blocks a main reporter for 180 ms and asserts an `(a)`
measurement. A test-only setup delays worker RPC response delivery at the process-message boundary
and asserts `(b)` for a real `onTaskUpdate` while main and worker-active time stay short. The third
run lets the worker send a real suite update, holds that worker's JavaScript loop for 260 ms, and
asserts the response gap, event-loop utilization, histogram delay, and `(c)` measurement. These
delays exist only in the fixture; the tracing code has no delay injection.
