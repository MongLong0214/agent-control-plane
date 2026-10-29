import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

import { prepareVitestRpcTrace, VITEST_RPC_TRACE_ENV } from "./tests/helpers/vitest-rpc-trace.ts";

const rpcTrace = prepareVitestRpcTrace(process.env[VITEST_RPC_TRACE_ENV], process.cwd());
const checkoutWriterProcessWitness = "tests/unit/a-task-claim-is-handed-over-at-its-execution-end.test.ts";
const sourceAlias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };
// #1093: HOME is private before any test file loads. Both projects must use the same setup so moving
// a file between them cannot weaken the live-state boundary or the optional RPC trace.
const setupFiles = [
  fileURLToPath(new URL("./tests/helpers/isolated-home.ts", import.meta.url)),
  ...(rpcTrace ? [fileURLToPath(new URL("./tests/helpers/vitest-rpc-trace-worker.ts", import.meta.url))] : []),
];

export default defineConfig({
  resolve: {
    alias: sourceAlias,
  },
  test: {
    // This file stops and kills real process groups while proving restart recovery. Once shard 2
    // grew, running a second test-file fork beside it made the macOS 15 hosted runner lose those
    // witnesses even though the exact file passes in isolation. Keep ordinary files at two workers,
    // then run this one as its own ordered project group; no test is skipped or retried.
    projects: [
      {
        resolve: { alias: sourceAlias },
        test: {
          name: "parallel",
          include: ["tests/**/*.test.ts"],
          exclude: [checkoutWriterProcessWitness],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // Forks isolate native addons and real sandbox children; two workers retain the existing
          // ordinary-suite throughput without sharing one native-addon process.
          pool: "forks",
          maxWorkers: 2,
          setupFiles,
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve: { alias: sourceAlias },
        test: {
          name: "checkout-writer-process-witness",
          include: [checkoutWriterProcessWitness],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          pool: "forks",
          fileParallelism: false,
          setupFiles,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    // The JSON reporter is declared here rather than passed on the command line: `pnpm test --`
    // forwards `--` to vitest, which then has to guess whether the rest are flags or filters.
    // The gate reads the JSON report rather than the exit status, so it needs that report even
    // when CI is unset — a local `pnpm test` judged from a stale or absent file is not judged.
    reporters: [
      ...(process.env.CI || process.env.ACP_VITEST_GATE
        ? (["default", "junit", "json"] as const)
        : (["default"] as const)),
      ...(rpcTrace ? [rpcTrace.reporter] : []),
    ],
    outputFile: {
      junit: "evidence/junit.xml",
      json: "evidence/local/ci-vitest-results.json",
    },
  },
});
