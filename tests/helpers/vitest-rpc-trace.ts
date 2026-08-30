import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  write,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { Reporter } from "vitest/reporters";
import type {
  RunnerTaskEventPack as TaskEventPack,
  RunnerTaskResultPack as TaskResultPack,
} from "vitest";
import type { Vitest } from "vitest/node";

const TRACE_VERSION = 1;
const TRACE_META_KEY = "__acpVitestRpcTrace";
const INTERNAL_TRACE_FILE_ENV = "ACP_VITEST_RPC_TRACE_FILE";
const INTERNAL_TRACE_RUN_ENV = "ACP_VITEST_RPC_TRACE_RUN";

export const VITEST_RPC_TRACE_ENV = "ACP_VITEST_RPC_TRACE";
export const VITEST_RPC_SLOW_SEGMENT_MS = 100;

export interface VitestRpcTraceStamp {
  runId: string;
  workerPid: number;
  sequence: number;
  sentAtMs: number;
}

interface TraceBase {
  version: typeof TRACE_VERSION;
  runId: string;
  pid: number;
  atMs: number;
}

export interface WorkerSendRecord extends TraceBase {
  type: "worker-send";
  workerPid: number;
  sequence: number;
  taskIds: string[];
  taskEvents: string[];
}

export interface WorkerSettleRecord extends TraceBase {
  type: "worker-settle";
  workerPid: number;
  sequence: number;
  status: "resolved" | "rejected";
  roundTripMs: number;
  workerActiveMs: number;
  workerIdleMs: number;
  workerUtilization: number;
  workerActivityObserved: boolean;
  workerEventLoopDelayMaxMs: number | null;
  error?: string;
}

export interface WorkerActiveRecord extends TraceBase {
  type: "worker-active";
  workerPid: number;
  startedAtMs: number;
  endedAtMs: number;
}

export interface MainUpdateStartRecord extends TraceBase {
  type: "main-update-start";
  workerPid: number;
  sequence: number;
  workerSentAtMs: number;
  taskCount: number;
}

export interface MainUpdateEndRecord extends TraceBase {
  type: "main-update-end";
  workerPid: number;
  sequence: number;
  mainOnTaskUpdateMs: number;
}

export interface MainUpdateUnattributedRecord extends TraceBase {
  type: "main-update-unattributed";
  taskCount: number;
  mainOnTaskUpdateMs: number;
}

export type VitestRpcClassification =
  | "a-main-onTaskUpdate"
  | "b-ipc-or-process-scheduling"
  | "c-worker-event-loop"
  | "insufficient"
  | "no-slow-segment"
  | "incomplete";

export interface VitestRpcSegmentMeasurement {
  durationMs: number | null;
  workerBusyMs: number | null;
  workerEventLoopDelayMaxMs: number | null;
}

export interface VitestRpcMeasurement extends TraceBase {
  type: "measurement";
  workerPid: number;
  sequence: number;
  classification: VitestRpcClassification;
  missing: string[];
  unmeasured: string[];
  roundTripMs: number | null;
  workerActivityObserved: boolean;
  responseArrivalObserved: boolean;
  requestToMain: VitestRpcSegmentMeasurement;
  mainOnTaskUpdate: VitestRpcSegmentMeasurement;
  mainReturnToResponseArrival: VitestRpcSegmentMeasurement;
  responseArrivalToWorkerPickup: VitestRpcSegmentMeasurement;
  unpartitionedMainReturnToWorkerPickup: VitestRpcSegmentMeasurement;
  wholeRpcWorkerActiveMs: number | null;
  workerHistogramDelayMaxMs: number | null;
}

export interface VitestRpcSummaryRecord extends TraceBase {
  type: "summary";
  measurements: number;
  unattributedMainUpdates: number;
  counts: Record<VitestRpcClassification, number>;
  worst: Partial<Record<VitestRpcClassification, VitestRpcMeasurement>>;
  slowest: VitestRpcMeasurement | null;
}

export type VitestRpcTraceRecord =
  | WorkerSendRecord
  | WorkerSettleRecord
  | WorkerActiveRecord
  | MainUpdateStartRecord
  | MainUpdateEndRecord
  | MainUpdateUnattributedRecord
  | VitestRpcMeasurement
  | VitestRpcSummaryRecord;

interface TraceMeta {
  [TRACE_META_KEY]?: VitestRpcTraceStamp;
}

interface InternalTestRun {
  updated: (packs: TaskResultPack[], events: TaskEventPack[]) => Promise<void>;
}

interface InternalVitest {
  _testRun: InternalTestRun;
}

const nowEpochMs = (): number => performance.timeOrigin + performance.now();

const rounded = (value: number): number => Math.round(value * 1_000) / 1_000;

const durationText = (value: number | null): string =>
  value === null ? "unmeasured" : `${value}ms`;

const correlationKey = (workerPid: number, sequence: number): string =>
  `${workerPid}:${sequence}`;

const recordBase = (runId: string): TraceBase => ({
  version: TRACE_VERSION,
  runId,
  pid: process.pid,
  atMs: rounded(nowEpochMs()),
});

/**
 * A line is handed to libuv immediately, but the callback is not awaited by Vitest's main or
 * worker event loop. This preserves the last entered boundary when that same event loop blocks
 * without turning every observation into a synchronous filesystem stall.
 */
export class VitestRpcTraceWriter {
  private readonly fd: number;
  private readonly queue: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private writing = false;
  private closed = false;
  private failure: Error | undefined;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.fd = openSync(file, "a");
  }

  record(record: VitestRpcTraceRecord): void {
    if (this.closed) return;
    this.queue.push(`${JSON.stringify(record)}\n`);
    this.drain();
  }

  async flush(): Promise<void> {
    if (!this.writing && this.queue.length === 0) {
      if (this.failure) throw this.failure;
      return;
    }
    await new Promise<void>((resolveFlush) => this.waiters.push(resolveFlush));
    if (this.failure) throw this.failure;
  }

  flushSync(): void {
    if (this.closed || this.queue.length === 0) return;
    const pending = this.queue.splice(0).join("");
    try {
      writeSync(this.fd, pending);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    closeSync(this.fd);
  }

  private drain(): void {
    if (this.writing || this.closed) return;
    const line = this.queue.shift();
    if (line === undefined) {
      for (const resolveWaiter of this.waiters.splice(0)) resolveWaiter();
      return;
    }
    this.writing = true;
    write(this.fd, line, (error) => {
      this.writing = false;
      if (error) this.failure = error;
      this.drain();
    });
  }
}

const isTraceRecord = (value: unknown): value is VitestRpcTraceRecord => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VitestRpcTraceRecord>;
  return candidate.version === TRACE_VERSION && typeof candidate.type === "string";
};

export const readVitestRpcTrace = (file: string): VitestRpcTraceRecord[] => {
  const text = readFileSync(file, "utf8");
  const records: VitestRpcTraceRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isTraceRecord(value)) records.push(value);
    } catch {
      // A torn line is an absent observation. summarizeVitestRpcTrace reports the resulting
      // incomplete correlation instead of treating unreadable output as a zero-duration segment.
    }
  }
  return records;
};

interface Correlation {
  send?: WorkerSendRecord;
  mainStart?: MainUpdateStartRecord;
  mainEnd?: MainUpdateEndRecord;
  settle?: WorkerSettleRecord;
}

const missingParts = (entry: Correlation): string[] => {
  const missing: string[] = [];
  if (!entry.send) missing.push("worker-send");
  if (!entry.mainStart) missing.push("main-update-start");
  if (!entry.mainEnd) missing.push("main-update-end");
  if (!entry.settle) missing.push("worker-settle");
  return missing;
};

const classifyMeasurement = (
  missing: readonly string[],
  requestToMainMs: number,
  mainOnTaskUpdateMs: number,
  unpartitionedMainReturnToWorkerPickupMs: number,
): VitestRpcClassification => {
  if (missing.length > 0) return "incomplete";
  const candidates: VitestRpcClassification[] = [];
  if (requestToMainMs >= VITEST_RPC_SLOW_SEGMENT_MS) {
    candidates.push("b-ipc-or-process-scheduling");
  }
  if (mainOnTaskUpdateMs >= VITEST_RPC_SLOW_SEGMENT_MS) {
    candidates.push("a-main-onTaskUpdate");
  }
  const unpartitionedResponseIsSlow =
    unpartitionedMainReturnToWorkerPickupMs >= VITEST_RPC_SLOW_SEGMENT_MS;
  if (
    candidates.length === 1 &&
    !unpartitionedResponseIsSlow
  ) {
    return candidates[0]!;
  }
  if (
    candidates.length > 1 ||
    unpartitionedResponseIsSlow
  ) {
    return "insufficient";
  }
  return "no-slow-segment";
};

interface ActivitySpan {
  start: number;
  end: number;
}

const activeTimeWithin = (
  records: readonly WorkerActiveRecord[],
  startAtMs: number,
  endAtMs: number,
): number => {
  const spans = records
    .map((record): ActivitySpan => ({
      start: Math.max(startAtMs, record.startedAtMs),
      end: Math.min(endAtMs, record.endedAtMs),
    }))
    .filter((span) => span.end > span.start)
    .sort((left, right) => left.start - right.start);
  let activeMs = 0;
  let current: ActivitySpan | undefined;
  for (const span of spans) {
    if (!current) {
      current = { ...span };
    } else if (span.start <= current.end) {
      current.end = Math.max(current.end, span.end);
    } else {
      activeMs += current.end - current.start;
      current = { ...span };
    }
  }
  if (current) activeMs += current.end - current.start;
  return activeMs;
};

const unmeasuredSegment = (): VitestRpcSegmentMeasurement => ({
  durationMs: null,
  workerBusyMs: null,
  workerEventLoopDelayMaxMs: null,
});

const measuredSegment = (
  activity: readonly WorkerActiveRecord[],
  startAtMs: number | undefined,
  endAtMs: number | undefined,
  workerActivityObserved: boolean,
): VitestRpcSegmentMeasurement => {
  if (startAtMs === undefined || endAtMs === undefined) return unmeasuredSegment();
  return {
    durationMs: rounded(Math.max(0, endAtMs - startAtMs)),
    workerBusyMs: workerActivityObserved
      ? rounded(activeTimeWithin(activity, startAtMs, endAtMs))
      : null,
    // monitorEventLoopDelay exposes one histogram for the whole pending RPC. It does not retain
    // timestamps that could assign its maximum to one of these cross-process segments.
    workerEventLoopDelayMaxMs: null,
  };
};

export const summarizeVitestRpcTrace = (
  records: readonly VitestRpcTraceRecord[],
  runId: string,
): { measurements: VitestRpcMeasurement[]; summary: VitestRpcSummaryRecord } => {
  const correlations = new Map<string, Correlation>();
  const workerActivity = new Map<number, WorkerActiveRecord[]>();
  let unattributedMainUpdates = 0;

  const entryFor = (workerPid: number, sequence: number): Correlation => {
    const key = correlationKey(workerPid, sequence);
    const current = correlations.get(key) ?? {};
    correlations.set(key, current);
    return current;
  };

  for (const record of records) {
    if (record.runId !== runId) continue;
    switch (record.type) {
      case "worker-send":
        entryFor(record.workerPid, record.sequence).send = record;
        break;
      case "main-update-start":
        entryFor(record.workerPid, record.sequence).mainStart = record;
        break;
      case "main-update-end":
        entryFor(record.workerPid, record.sequence).mainEnd = record;
        break;
      case "worker-settle":
        entryFor(record.workerPid, record.sequence).settle = record;
        break;
      case "worker-active": {
        const recordsForWorker = workerActivity.get(record.workerPid) ?? [];
        recordsForWorker.push(record);
        workerActivity.set(record.workerPid, recordsForWorker);
        break;
      }
      case "main-update-unattributed":
        unattributedMainUpdates += 1;
        break;
      case "measurement":
      case "summary":
        break;
    }
  }

  const measurements = [...correlations.values()].map((entry): VitestRpcMeasurement => {
    const missing = missingParts(entry);
    const workerPid =
      entry.send?.workerPid ??
      entry.mainStart?.workerPid ??
      entry.mainEnd?.workerPid ??
      entry.settle?.workerPid ??
      -1;
    const sequence =
      entry.send?.sequence ??
      entry.mainStart?.sequence ??
      entry.mainEnd?.sequence ??
      entry.settle?.sequence ??
      -1;
    const roundTripMs = entry.settle?.roundTripMs ?? null;
    const workerActivityObserved = entry.settle?.workerActivityObserved === true;
    const activity = workerActivity.get(workerPid) ?? [];
    const requestToMain = measuredSegment(
      activity,
      entry.send?.atMs,
      entry.mainStart?.atMs,
      workerActivityObserved,
    );
    const mainOnTaskUpdate = measuredSegment(
      activity,
      entry.mainStart?.atMs,
      entry.mainEnd?.atMs,
      workerActivityObserved,
    );
    const unpartitionedMainReturnToWorkerPickup = measuredSegment(
      activity,
      entry.mainEnd?.atMs,
      entry.settle?.atMs,
      workerActivityObserved,
    );

    return {
      ...recordBase(runId),
      type: "measurement",
      workerPid,
      sequence,
      classification: classifyMeasurement(
        missing,
        requestToMain.durationMs ?? 0,
        mainOnTaskUpdate.durationMs ?? 0,
        unpartitionedMainReturnToWorkerPickup.durationMs ?? 0,
      ),
      missing,
      unmeasured: [
        "main-return-to-response-arrival",
        "response-arrival-to-worker-pickup",
        "worker-event-loop-delay-by-segment",
      ],
      roundTripMs: roundTripMs === null ? null : rounded(roundTripMs),
      workerActivityObserved,
      responseArrivalObserved: false,
      requestToMain,
      mainOnTaskUpdate,
      mainReturnToResponseArrival: unmeasuredSegment(),
      responseArrivalToWorkerPickup: unmeasuredSegment(),
      unpartitionedMainReturnToWorkerPickup,
      wholeRpcWorkerActiveMs:
        entry.settle === undefined ? null : rounded(entry.settle.workerActiveMs),
      workerHistogramDelayMaxMs:
        entry.settle?.workerEventLoopDelayMaxMs === null || entry.settle === undefined
          ? null
          : rounded(entry.settle.workerEventLoopDelayMaxMs),
    };
  });

  const classifications: VitestRpcClassification[] = [
    "a-main-onTaskUpdate",
    "b-ipc-or-process-scheduling",
    "c-worker-event-loop",
    "insufficient",
    "no-slow-segment",
    "incomplete",
  ];
  const counts = Object.fromEntries(
    classifications.map((classification) => [classification, 0]),
  ) as Record<VitestRpcClassification, number>;
  const worst: Partial<Record<VitestRpcClassification, VitestRpcMeasurement>> = {};
  let slowest: VitestRpcMeasurement | null = null;
  for (const measurement of measurements) {
    counts[measurement.classification] += 1;
    const current = worst[measurement.classification];
    if ((measurement.roundTripMs ?? -1) > (current?.roundTripMs ?? -1)) {
      worst[measurement.classification] = measurement;
    }
    if ((measurement.roundTripMs ?? -1) > (slowest?.roundTripMs ?? -1)) slowest = measurement;
  }

  return {
    measurements,
    summary: {
      ...recordBase(runId),
      type: "summary",
      measurements: measurements.length,
      unattributedMainUpdates,
      counts,
      worst,
      slowest,
    },
  };
};

const stampFromPacks = (
  packs: readonly TaskResultPack[],
  runId: string,
): VitestRpcTraceStamp | undefined => {
  for (const pack of packs) {
    const stamp = (pack[2] as TraceMeta)[TRACE_META_KEY];
    if (stamp?.runId === runId) return stamp;
  }
  return undefined;
};

export interface PreparedVitestRpcTrace {
  file: string;
  runId: string;
  reporter: Reporter;
}

export const prepareVitestRpcTrace = (
  setting: string | undefined,
  root: string,
): PreparedVitestRpcTrace | undefined => {
  if (!setting || setting === "0") return undefined;
  const runId = `${process.pid}-${Date.now()}`;
  const file =
    setting === "1"
      ? resolve(root, "evidence", "local", `vitest-rpc-trace-${runId}.ndjson`)
      : isAbsolute(setting)
        ? setting
        : resolve(root, setting);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  process.env[INTERNAL_TRACE_FILE_ENV] = file;
  process.env[INTERNAL_TRACE_RUN_ENV] = runId;
  return { file, runId, reporter: new VitestRpcTraceReporter(file, runId) };
};

export const currentVitestRpcTrace = (): { file: string; runId: string } | undefined => {
  const file = process.env[INTERNAL_TRACE_FILE_ENV];
  const runId = process.env[INTERNAL_TRACE_RUN_ENV];
  return file && runId ? { file, runId } : undefined;
};

export class VitestRpcTraceReporter implements Reporter {
  private readonly writer: VitestRpcTraceWriter;

  constructor(
    readonly file: string,
    readonly runId: string,
  ) {
    this.writer = new VitestRpcTraceWriter(file);
  }

  onInit(vitest: Vitest): void {
    const testRun = (vitest as unknown as InternalVitest)._testRun;
    const originalUpdated = testRun.updated.bind(testRun);
    testRun.updated = async (packs, events) => {
      const stamp = stampFromPacks(packs, this.runId);
      const startedAt = performance.now();
      if (stamp) {
        this.writer.record({
          ...recordBase(this.runId),
          type: "main-update-start",
          workerPid: stamp.workerPid,
          sequence: stamp.sequence,
          workerSentAtMs: stamp.sentAtMs,
          taskCount: packs.length,
        });
      }
      try {
        await originalUpdated(packs, events);
      } finally {
        const duration = rounded(performance.now() - startedAt);
        if (stamp) {
          this.writer.record({
            ...recordBase(this.runId),
            type: "main-update-end",
            workerPid: stamp.workerPid,
            sequence: stamp.sequence,
            mainOnTaskUpdateMs: duration,
          });
        } else {
          this.writer.record({
            ...recordBase(this.runId),
            type: "main-update-unattributed",
            taskCount: packs.length,
            mainOnTaskUpdateMs: duration,
          });
        }
      }
    };
  }

  async onFinished(): Promise<void> {
    await this.writer.flush();
    const { measurements, summary } = summarizeVitestRpcTrace(
      readVitestRpcTrace(this.file),
      this.runId,
    );
    for (const measurement of measurements) this.writer.record(measurement);
    this.writer.record(summary);
    await this.writer.close();

    const counts = summary.counts;
    const slowest = summary.slowest;
    const slowestText = slowest
      ? `slowest=${slowest.classification} ` +
        `rtt=${durationText(slowest.roundTripMs)} ` +
        `request-to-main=${durationText(slowest.requestToMain.durationMs)} ` +
        `main=${durationText(slowest.mainOnTaskUpdate.durationMs)} ` +
        `main-to-response-arrival=unmeasured ` +
        `response-arrival-to-worker-pickup=unmeasured ` +
        `unpartitioned-main-to-worker=${durationText(slowest.unpartitionedMainReturnToWorkerPickup.durationMs)} ` +
        `worker-busy-request=${durationText(slowest.requestToMain.workerBusyMs)} ` +
        `worker-busy-main=${durationText(slowest.mainOnTaskUpdate.workerBusyMs)} ` +
        `worker-busy-unpartitioned-response=${durationText(slowest.unpartitionedMainReturnToWorkerPickup.workerBusyMs)} ` +
        `worker-delay-by-segment=unmeasured; `
      : "slowest=unmeasured; ";
    process.stderr.write(
      `[ACP Vitest RPC trace] ` +
        `a-main=${counts["a-main-onTaskUpdate"]} ` +
        `b-ipc-or-scheduling=${counts["b-ipc-or-process-scheduling"]} ` +
        `c-worker-loop=${counts["c-worker-event-loop"]} ` +
        `insufficient=${counts.insufficient} ` +
        `incomplete=${counts.incomplete + summary.unattributedMainUpdates}; ` +
        slowestText +
        `${this.file}\n`,
    );
  }
}

export const attachVitestRpcTraceStamp = (
  packs: TaskResultPack[],
  stamp: VitestRpcTraceStamp,
): void => {
  for (const pack of packs) (pack[2] as TraceMeta)[TRACE_META_KEY] = stamp;
};
