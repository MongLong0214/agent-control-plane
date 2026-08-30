import { afterAll } from "vitest";
import type {
  RunnerTaskEventPack as TaskEventPack,
  RunnerTaskResultPack as TaskResultPack,
} from "vitest";
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";

import {
  attachVitestRpcTraceStamp,
  currentVitestRpcTrace,
  VitestRpcTraceWriter,
  type VitestRpcTraceStamp,
} from "./vitest-rpc-trace.ts";

interface WorkerRpc {
  onTaskUpdate: (packs: TaskResultPack[], events: TaskEventPack[]) => Promise<void>;
  [method: string | symbol]: unknown;
}

interface WorkerState {
  rpc: WorkerRpc;
  onCleanup: (listener: () => void | Promise<void>) => void;
}

type WorkerGlobal = typeof globalThis & {
  __vitest_worker__?: WorkerState;
  __acp_vitest_rpc_trace__?: InstalledWorkerTrace;
};

interface PendingUpdate {
  stamp: VitestRpcTraceStamp;
  utilization: EventLoopUtilization;
}

interface InstalledWorkerTrace {
  writer: VitestRpcTraceWriter;
  flush: () => Promise<void>;
}

const workerGlobal = globalThis as WorkerGlobal;
const trace = currentVitestRpcTrace();
const state = workerGlobal.__vitest_worker__;

const install = (): InstalledWorkerTrace | undefined => {
  if (!trace || !state) return undefined;
  if (workerGlobal.__acp_vitest_rpc_trace__) return workerGlobal.__acp_vitest_rpc_trace__;

  const writer = new VitestRpcTraceWriter(trace.file);
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const originalRpc = state.rpc;
  const originalOnTaskUpdate = originalRpc.onTaskUpdate;
  const pending = new Map<number, PendingUpdate>();
  let sequence = 0;

  const tracedOnTaskUpdate = (
    packs: TaskResultPack[],
    events: TaskEventPack[],
  ): Promise<void> => {
    const stamp: VitestRpcTraceStamp = {
      runId: trace.runId,
      workerPid: process.pid,
      sequence: ++sequence,
      sentAtMs: performance.timeOrigin + performance.now(),
    };
    attachVitestRpcTraceStamp(packs, stamp);
    pending.set(stamp.sequence, {
      stamp,
      utilization: performance.eventLoopUtilization(),
    });
    writer.record({
      version: 1,
      runId: trace.runId,
      pid: process.pid,
      atMs: stamp.sentAtMs,
      type: "worker-send",
      workerPid: process.pid,
      sequence: stamp.sequence,
      taskIds: packs.map((pack) => pack[0]),
      taskEvents: events.map((event) => event[1]),
    });

    const response = originalOnTaskUpdate(packs, events);
    void response.then(
      () => settle(stamp.sequence, "resolved"),
      (error: unknown) => settle(stamp.sequence, "rejected", error),
    );
    return response;
  };

  const settle = (
    settledSequence: number,
    status: "resolved" | "rejected",
    error?: unknown,
  ): void => {
    const entry = pending.get(settledSequence);
    if (!entry) return;
    pending.delete(settledSequence);
    const atMs = performance.timeOrigin + performance.now();
    const utilization = performance.eventLoopUtilization(entry.utilization);
    const eventLoopDelayMaxMs = histogram.max / 1_000_000;
    writer.record({
      version: 1,
      runId: trace.runId,
      pid: process.pid,
      atMs,
      type: "worker-settle",
      workerPid: process.pid,
      sequence: settledSequence,
      status,
      roundTripMs: atMs - entry.stamp.sentAtMs,
      workerActiveMs: utilization.active,
      workerIdleMs: utilization.idle,
      workerUtilization: utilization.utilization,
      workerEventLoopDelayMaxMs: Number.isFinite(eventLoopDelayMaxMs)
        ? eventLoopDelayMaxMs
        : null,
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
    });
    if (pending.size === 0) histogram.reset();
    if (status === "rejected") writer.flushSync();
  };

  state.rpc = new Proxy(originalRpc, {
    get(target, property, receiver) {
      if (property === "onTaskUpdate") return tracedOnTaskUpdate;
      return Reflect.get(target, property, receiver);
    },
  });

  const installed: InstalledWorkerTrace = {
    writer,
    flush: () => writer.flush(),
  };
  workerGlobal.__acp_vitest_rpc_trace__ = installed;
  state.onCleanup(async () => {
    histogram.disable();
    await writer.flush();
  });
  process.once("exit", () => writer.flushSync());
  return installed;
};

const installed = install();
if (installed) afterAll(() => installed.flush());
