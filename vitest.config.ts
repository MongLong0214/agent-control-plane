import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

import { prepareVitestRpcTrace, VITEST_RPC_TRACE_ENV } from "./tests/helpers/vitest-rpc-trace.ts";

const rpcTrace = prepareVitestRpcTrace(process.env[VITEST_RPC_TRACE_ENV], process.cwd());

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Forks, not threads. This suite loads a native addon (better-sqlite3) and starts real
    // sandboxed children; on the macOS runner that combination crashed the worker outright —
    // `Segmentation fault: 11`, exit 139, with the suite otherwise passing. A crashed worker
    // is not a test failure and reads like one, or like a missing result file downstream.
    // Forks isolate each file in its own process, where a native addon is far safer.
    pool: "forks",
    // The JSON reporter is declared here rather than passed on the command line: `pnpm test --`
    // forwards `--` to vitest, which then has to guess whether the rest are flags or filters.
    reporters: [
      ...(process.env.CI ? (["default", "junit", "json"] as const) : (["default"] as const)),
      ...(rpcTrace ? [rpcTrace.reporter] : []),
    ],
    setupFiles: rpcTrace
      ? [fileURLToPath(new URL("./tests/helpers/vitest-rpc-trace-worker.ts", import.meta.url))]
      : [],
    outputFile: {
      junit: "evidence/junit.xml",
      json: "evidence/local/ci-vitest-results.json",
    },
  },
});
