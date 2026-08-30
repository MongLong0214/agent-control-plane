import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  readVitestRpcTrace,
  summarizeVitestRpcTrace,
  VITEST_RPC_TRACE_ENV,
  type VitestRpcMeasurement,
  type VitestRpcTraceRecord,
} from "../helpers/vitest-rpc-trace.ts";

afterAll(cleanupTempDirs);

const ROOT = process.cwd();
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");

const measureRecords = (records: VitestRpcTraceRecord[]): VitestRpcMeasurement => {
  const { measurements } = summarizeVitestRpcTrace(records, "counterexample");
  expect(measurements).toHaveLength(1);
  return measurements[0]!;
};

interface TraceFixtureRun {
  status: number | null;
  stdout: string;
  stderr: string;
  measurements: VitestRpcMeasurement[];
}

interface TraceFixtureOptions {
  blockMainMs?: number;
  delayRpcResponseMs?: number;
}

const fixtureConfig = (blockMainMs?: number, delaySetup?: string): string => {
  const configPath = join(ROOT, "vitest.config.ts");
  const blockingReporter =
    blockMainMs === undefined
      ? ""
      : `
class BlockingMainReporter {
  onTaskUpdate() {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${blockMainMs});
  }
}
`;
  const appendedReporter =
    blockMainMs === undefined ? "" : ", new BlockingMainReporter()";
  return `
import base from ${JSON.stringify(configPath)};
${blockingReporter}
const baseTest = base.test ?? {};
export default {
  ...base,
  root: import.meta.dirname,
  test: {
    ...baseTest,
    include: ["tests/**/*.test.ts"],
    reporters: [...(baseTest.reporters ?? [])${appendedReporter}],
    setupFiles: [...(baseTest.setupFiles ?? [])${
      delaySetup === undefined ? "" : `, ${JSON.stringify(delaySetup)}`
    }],
  },
};
`;
};

const responseDelaySetup = (delayMs: number): string => `
import v8 from "node:v8";
import { setTimeout } from "node:timers";

for (const listener of process.listeners("message")) {
  process.off("message", listener);
  process.on("message", function delayedRpcResponse(message, ...args) {
    try {
      const decoded = v8.deserialize(Buffer.from(message));
      if (decoded?.t === "s") {
        setTimeout(() => listener.call(process, message, ...args), ${delayMs});
        return;
      }
    } catch {}
    return listener.call(process, message, ...args);
  });
}
`;

const runTraceFixture = (
  testSource: string,
  options: TraceFixtureOptions = {},
): TraceFixtureRun => {
  const dir = tempDir("acp-vitest-rpc-trace-");
  const testsDir = join(dir, "tests");
  const traceFile = join(dir, "rpc-trace.ndjson");
  mkdirSync(testsDir, { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const delaySetup = join(dir, "delay-rpc-response.ts");
  if (options.delayRpcResponseMs !== undefined) {
    writeFileSync(delaySetup, responseDelaySetup(options.delayRpcResponseMs));
  }
  writeFileSync(
    join(dir, "vitest.config.ts"),
    fixtureConfig(
      options.blockMainMs,
      options.delayRpcResponseMs === undefined ? undefined : delaySetup,
    ),
  );
  writeFileSync(join(testsDir, "probe.test.ts"), testSource);

  const done = spawnSync(process.execPath, [VITEST, "run", "tests/probe.test.ts"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      CI: "",
      [VITEST_RPC_TRACE_ENV]: traceFile,
    },
  });
  const records = existsSync(traceFile) ? readVitestRpcTrace(traceFile) : [];
  return {
    status: done.status,
    stdout: done.stdout,
    stderr: done.stderr,
    measurements: records.filter(
      (record): record is VitestRpcMeasurement => record.type === "measurement",
    ),
  };
};

describe("Vitest onTaskUpdate tracing", () => {
  it("does not call worker activity before an unobserved response arrival a worker cause", () => {
    const measurement = measureRecords([
      {
        version: 1,
        runId: "counterexample",
        pid: 41,
        atMs: 1_000,
        type: "worker-send",
        workerPid: 41,
        sequence: 1,
        taskIds: ["task"],
        taskEvents: [],
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 41,
        atMs: 1_110,
        type: "worker-active",
        workerPid: 41,
        startedAtMs: 1_000,
        endedAtMs: 1_110,
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 40,
        atMs: 1_090,
        type: "main-update-start",
        workerPid: 41,
        sequence: 1,
        workerSentAtMs: 1_000,
        taskCount: 1,
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 40,
        atMs: 1_189,
        type: "main-update-end",
        workerPid: 41,
        sequence: 1,
        mainOnTaskUpdateMs: 99,
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 41,
        atMs: 1_299,
        type: "worker-settle",
        workerPid: 41,
        sequence: 1,
        status: "resolved",
        roundTripMs: 299,
        workerActiveMs: 110,
        workerIdleMs: 189,
        workerUtilization: 110 / 299,
        workerActivityObserved: true,
        workerEventLoopDelayMaxMs: 1,
      },
    ]);

    expect(measurement.requestToMain).toEqual({
      durationMs: 90,
      workerBusyMs: 90,
      workerEventLoopDelayMaxMs: null,
    });
    expect(measurement.mainOnTaskUpdate).toEqual({
      durationMs: 99,
      workerBusyMs: 20,
      workerEventLoopDelayMaxMs: null,
    });
    expect(measurement.unpartitionedMainReturnToWorkerPickup).toEqual({
      durationMs: 110,
      workerBusyMs: 0,
      workerEventLoopDelayMaxMs: null,
    });
    expect(measurement.responseArrivalObserved).toBe(false);
    expect(measurement.classification).toBe("insufficient");
    expect(measurement.classification).not.toBe("c-worker-event-loop");
  });

  it("does not call a zero-delay histogram a worker event-loop cause", () => {
    const measurement = measureRecords([
      {
        version: 1,
        runId: "counterexample",
        pid: 41,
        atMs: 1_000,
        type: "worker-send",
        workerPid: 41,
        sequence: 1,
        taskIds: ["task"],
        taskEvents: [],
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 40,
        atMs: 1_090,
        type: "main-update-start",
        workerPid: 41,
        sequence: 1,
        workerSentAtMs: 1_000,
        taskCount: 1,
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 40,
        atMs: 1_189,
        type: "main-update-end",
        workerPid: 41,
        sequence: 1,
        mainOnTaskUpdateMs: 99,
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 41,
        atMs: 1_299,
        type: "worker-active",
        workerPid: 41,
        startedAtMs: 1_189,
        endedAtMs: 1_299,
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 41,
        atMs: 1_299,
        type: "worker-settle",
        workerPid: 41,
        sequence: 1,
        status: "resolved",
        roundTripMs: 299,
        workerActiveMs: 110,
        workerIdleMs: 189,
        workerUtilization: 110 / 299,
        workerActivityObserved: true,
        workerEventLoopDelayMaxMs: 0,
      },
    ]);

    expect(measurement.unpartitionedMainReturnToWorkerPickup.workerBusyMs).toBe(110);
    expect(measurement.workerHistogramDelayMaxMs).toBe(0);
    expect(measurement.mainReturnToResponseArrival.durationMs).toBeNull();
    expect(measurement.responseArrivalToWorkerPickup.durationMs).toBeNull();
    expect(measurement.classification).toBe("insufficient");
  });

  it("does not let a short main stall claim a mostly outside-main timeout", () => {
    const measurement = measureRecords([
      {
        version: 1,
        runId: "counterexample",
        pid: 41,
        atMs: 1_000,
        type: "worker-send",
        workerPid: 41,
        sequence: 1,
        taskIds: ["task"],
        taskEvents: [],
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 40,
        atMs: 1_000,
        type: "main-update-start",
        workerPid: 41,
        sequence: 1,
        workerSentAtMs: 1_000,
        taskCount: 1,
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 40,
        atMs: 1_101,
        type: "main-update-end",
        workerPid: 41,
        sequence: 1,
        mainOnTaskUpdateMs: 101,
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 41,
        atMs: 61_000,
        type: "worker-settle",
        workerPid: 41,
        sequence: 1,
        status: "resolved",
        roundTripMs: 60_000,
        workerActiveMs: 0,
        workerIdleMs: 60_000,
        workerUtilization: 0,
        workerActivityObserved: true,
        workerEventLoopDelayMaxMs: 0,
      },
    ]);

    expect(measurement.mainOnTaskUpdate.durationMs).toBe(101);
    expect(measurement.unpartitionedMainReturnToWorkerPickup.durationMs).toBe(59_899);
    expect(measurement.classification).toBe("insufficient");
    expect(measurement.classification).not.toBe("a-main-onTaskUpdate");
  });

  it("does not subtract overlapping worker work from a sixty second response gap", () => {
    const measurement = measureRecords([
      {
        version: 1,
        runId: "counterexample",
        pid: 41,
        atMs: 1_000,
        type: "worker-send",
        workerPid: 41,
        sequence: 1,
        taskIds: ["task"],
        taskEvents: [],
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 40,
        atMs: 1_000,
        type: "main-update-start",
        workerPid: 41,
        sequence: 1,
        workerSentAtMs: 1_000,
        taskCount: 1,
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 40,
        atMs: 1_001,
        type: "main-update-end",
        workerPid: 41,
        sequence: 1,
        mainOnTaskUpdateMs: 1,
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 41,
        atMs: 60_951,
        type: "worker-active",
        workerPid: 41,
        startedAtMs: 1_001,
        endedAtMs: 60_951,
      },
      {
        version: 1,
        runId: "counterexample",
        pid: 41,
        atMs: 61_001,
        type: "worker-settle",
        workerPid: 41,
        sequence: 1,
        status: "resolved",
        roundTripMs: 60_001,
        workerActiveMs: 59_950,
        workerIdleMs: 51,
        workerUtilization: 59_950 / 60_001,
        workerActivityObserved: true,
        workerEventLoopDelayMaxMs: 59_950,
      },
    ]);

    expect(measurement.mainOnTaskUpdate.durationMs).toBe(1);
    expect(measurement.unpartitionedMainReturnToWorkerPickup).toEqual({
      durationMs: 60_000,
      workerBusyMs: 59_950,
      workerEventLoopDelayMaxMs: null,
    });
    expect(measurement.mainReturnToResponseArrival.durationMs).toBeNull();
    expect(measurement.responseArrivalToWorkerPickup.durationMs).toBeNull();
    expect(measurement.unmeasured).toEqual([
      "main-return-to-response-arrival",
      "response-arrival-to-worker-pickup",
      "worker-event-loop-delay-by-segment",
    ]);
    expect(measurement).not.toHaveProperty("ipcOrProcessSchedulingMs");
    expect(measurement.classification).toBe("insufficient");
    expect(measurement.classification).not.toBe("c-worker-event-loop");
  });

  it("reports an artificial main handler stall as the main onTaskUpdate segment", () => {
    const run = runTraceFixture(
      `
import { expect, it } from "vitest";
it("passes through the real runner", () => expect(1).toBe(1));
`,
      { blockMainMs: 180 },
    );

    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const mainStall = run.measurements.find(
      (measurement) => measurement.classification === "a-main-onTaskUpdate",
    );
    expect(mainStall?.missing).toEqual([]);
    expect(mainStall?.mainOnTaskUpdate.durationMs).toBeGreaterThanOrEqual(150);
  });

  it("leaves an artificial response transport delay insufficient without arrival timing", () => {
    const run = runTraceFixture(
      `
import { expect, it } from "vitest";
it("passes through the delayed response transport", () => expect(1).toBe(1));
`,
      { delayRpcResponseMs: 180 },
    );

    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const transportDelay = run.measurements.find(
      (measurement) =>
        (measurement.unpartitionedMainReturnToWorkerPickup.durationMs ?? 0) >= 150,
    );
    expect(transportDelay, JSON.stringify(run.measurements, null, 2)).toBeDefined();
    expect(transportDelay?.missing).toEqual([]);
    expect(transportDelay?.mainOnTaskUpdate.durationMs).toBeLessThan(100);
    expect(transportDelay?.mainReturnToResponseArrival.durationMs).toBeNull();
    expect(transportDelay?.responseArrivalToWorkerPickup.durationMs).toBeNull();
    expect(transportDelay?.classification).toBe("insufficient");
  });

  it("leaves an artificial worker stall insufficient without response arrival timing", () => {
    const run = runTraceFixture(`
import { expect, it } from "vitest";

await new Promise((resolve) => setTimeout(resolve, 60));

it("occupies the worker event loop after a real task update", () => {
  const until = performance.now() + 260;
  while (performance.now() < until) {
    // The synchronous test body deliberately keeps Vitest's worker from receiving the RPC reply.
  }
  expect(true).toBe(true);
});
`);

    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const workerStall = run.measurements.find(
      (measurement) =>
        (measurement.unpartitionedMainReturnToWorkerPickup.workerBusyMs ?? 0) >= 180,
    );
    expect(workerStall?.missing).toEqual([]);
    expect(workerStall?.unpartitionedMainReturnToWorkerPickup.durationMs).toBeGreaterThanOrEqual(
      180,
    );
    expect(workerStall?.wholeRpcWorkerActiveMs).toBeGreaterThanOrEqual(180);
    expect(workerStall?.unpartitionedMainReturnToWorkerPickup.workerBusyMs).toBeGreaterThanOrEqual(
      180,
    );
    expect(workerStall?.workerHistogramDelayMaxMs).toBeGreaterThanOrEqual(100);
    expect(workerStall?.mainReturnToResponseArrival.durationMs).toBeNull();
    expect(workerStall?.responseArrivalToWorkerPickup.durationMs).toBeNull();
    expect(workerStall?.classification).toBe("insufficient");
  });
});
