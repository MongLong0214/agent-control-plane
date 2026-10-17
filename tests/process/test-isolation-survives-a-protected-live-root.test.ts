import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { VITEST_RPC_TRACE_ENV } from "../helpers/vitest-rpc-trace.ts";

afterAll(cleanupTempDirs);

/**
 * #1093, review R2 — the private-HOME setup must not need to read the live state it keeps tests out
 * of. On a host whose sandbox protects `~/.agent-control-plane`, resolving that directory fails with
 * EPERM, and a setup that resolved it unconditionally stopped every test file before its first
 * assertion: the guard file below reported 0 passed, 3 skipped.
 *
 * The protection is reproduced without touching the live directory. A preload, handed to the nested
 * run and its workers through NODE_OPTIONS, makes the live root look the way that host shows it —
 * present, and EPERM to resolve, at or below it — and logs each refusal it serves, so a run that
 * never reached the protected path cannot pass as one that survived it.
 */
const ROOT = process.cwd();
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const GUARD = "tests/unit/a-test-run-never-resolves-the-live-scratch-root.test.ts";

const PRELOAD = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";

const live = join(userInfo().homedir, ".agent-control-plane");
const log = process.env.ACP_TEST_PROTECTED_LIVE_ROOT_LOG;
const underLive = (path) => {
  const at = resolve(String(path));
  return at === live || at.startsWith(live + sep);
};
const denied = (syscall, path) => {
  if (log) fs.appendFileSync(log, syscall + " " + process.pid + "\\n");
  return Object.assign(new Error("EPERM: operation not permitted, " + syscall + " '" + live + "'"), {
    errno: -1, code: "EPERM", syscall, path: live,
  });
};
const realpathSync = fs.realpathSync;
const realpathNative = fs.realpathSync.native;
const existsSync = fs.existsSync;
const patched = (path, options) => {
  if (underLive(path)) throw denied("lstat", path);
  return realpathSync(path, options);
};
patched.native = (path, options) => {
  if (underLive(path)) throw denied("realpath", path);
  return realpathNative(path, options);
};
fs.realpathSync = patched;
fs.existsSync = (path) => (underLive(path) ? resolve(String(path)) === live : existsSync(path));
syncBuiltinESMExports();
`;

describe("test isolation on a host that protects the live state root (#1093, R2)", () => {
  it("still sets up a private HOME, and the isolation assertions run and pass", () => {
    const dir = tempDir("acp-protected-live-root-");
    const preload = join(dir, "protect-live-root.mjs");
    const log = join(dir, "denials.log");
    const report = join(dir, "report.json");
    writeFileSync(preload, PRELOAD);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "",
      NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import=${pathToFileURL(preload).href}`.trim(),
      ACP_TEST_PROTECTED_LIVE_ROOT_LOG: log,
    };
    // The nested run writes its own report, never the gate's: no gate reporters, no shared trace.
    delete env["ACP_VITEST_GATE"];
    delete env[VITEST_RPC_TRACE_ENV];
    delete env["ACP_VITEST_RPC_TRACE_FILE"];
    delete env["ACP_VITEST_RPC_TRACE_RUN"];

    const done = spawnSync(
      process.execPath,
      [VITEST, "run", GUARD, "--reporter=json", `--outputFile.json=${report}`],
      { cwd: ROOT, encoding: "utf8", timeout: 50_000, env },
    );
    const output = `${done.stdout}${done.stderr}`.slice(-4000);

    expect(existsSync(log), `the protected path was never reached, so nothing was measured\n${output}`).toBe(true);
    expect(readFileSync(log, "utf8").trim().split("\n").length).toBeGreaterThan(0);

    expect(existsSync(report), output).toBe(true);
    const results = JSON.parse(readFileSync(report, "utf8")) as {
      numPassedTests: number;
      numFailedTests: number;
      numPendingTests: number;
      numFailedTestSuites: number;
      testResults: { message?: string }[];
    };
    const why = results.testResults.map((file) => file.message ?? "").join("\n");
    expect(
      {
        passed: results.numPassedTests,
        failed: results.numFailedTests,
        skipped: results.numPendingTests,
        failedFiles: results.numFailedTestSuites,
      },
      `${why}\n${output}`,
    ).toEqual({ passed: 3, failed: 0, skipped: 0, failedFiles: 0 });
    expect(done.status, output).toBe(0);
  }, 60_000);
});
