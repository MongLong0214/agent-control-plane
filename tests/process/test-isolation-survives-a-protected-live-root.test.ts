import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * Review r2, R3 — the reviewer's alias-setup replay, unchanged but for its paths and its isolation.
 *
 * The live root is a surrogate in a temporary directory: the preload hands the nested run an
 * account home there (`os.userInfo`), and refuses to resolve anything that resolves into its state
 * root, as a protected host does. The test file points HOME at a directory whose
 * `.agent-control-plane` is a link straight to that root. Round 2 compared the link by its own
 * spelling once resolving it failed, so setup passed it and the file allocated into the surrogate's
 * live scratch. Setup must refuse it before the first test, and a private HOME must still pass.
 */
const SURROGATE_PRELOAD = `
import fs from 'node:fs';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {join,resolve,sep} from 'node:path';
const account=process.env.ACP_REVIEW_ACCOUNT_HOME;
const live=join(account,'.agent-control-plane');
const userInfo=os.userInfo;
os.userInfo=(...args)=>({...userInfo(...args),homedir:account});
const original=fs.realpathSync;
const within=p=>p===live||p.startsWith(live+sep);
const protect=(p,options)=>{
 const r=original(p,options);
 if(process.env.ACP_REVIEW_PROTECT==='1' && within(String(r))) {
  fs.appendFileSync(process.env.ACP_REVIEW_DENIAL_LOG,'denied\\n');
  throw Object.assign(new Error('synthetic EPERM'),{code:'EPERM'});
 }
 return r;
};
protect.native=protect;
fs.realpathSync=protect;
syncBuiltinESMExports();
`;

const aliasTest = (scratchRoot: string): string => `import {it,expect,vi} from 'vitest';
import {writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
vi.hoisted(()=>{process.env.HOME=process.env.ACP_REVIEW_ALIAS_HOME;});
import {acpScratchDir} from ${JSON.stringify(scratchRoot)};
it('records whether setup lets an aliased allocation reach the surrogate live root',()=>{
 const allocated=acpScratchDir('acp-review-alias-');
 writeFileSync(join(allocated,'marker'),'synthetic fixture only');
 writeFileSync(process.env.ACP_REVIEW_ALLOCATION_LOG,allocated);
 expect(existsSync(join(allocated,'marker'))).toBe(true);
});`;

describe("test isolation refuses a HOME that links straight to a protected live root (#1093, review r2 R3)", () => {
  it("fails setup before allocating through the link, and still runs a private HOME", () => {
    const dir = realpathSync(tempDir("acp-protected-live-alias-"));
    const account = join(dir, "home");
    const state = join(account, ".agent-control-plane");
    mkdirSync(join(state, "scratch"), { recursive: true });
    const aliasHome = join(dir, "alias-process-home");
    mkdirSync(aliasHome);
    symlinkSync(state, join(aliasHome, ".agent-control-plane"));
    const privateHome = join(dir, "private-process-home");
    mkdirSync(privateHome);

    // The nested run resolves vitest through this directory and keeps its cache here, not in the repository.
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    const preload = join(dir, "protect-surrogate.mjs");
    writeFileSync(preload, SURROGATE_PRELOAD);
    writeFileSync(join(dir, "alias.test.ts"), aliasTest(join(ROOT, "src", "core", "scratch-root.ts")));
    const config = join(dir, "alias.config.ts");
    writeFileSync(
      config,
      `import {defineConfig} from 'vitest/config'; export default defineConfig({cacheDir:${JSON.stringify(join(dir, ".vite"))},test:{include:['alias.test.ts'],setupFiles:[${JSON.stringify(join(ROOT, "tests", "helpers", "isolated-home.ts"))}],pool:'forks'}});`,
    );

    const run = (label: string, home: string) => {
      const report = join(dir, `${label}.json`);
      const allocationLog = join(dir, `${label}-allocation.log`);
      const denialLog = join(dir, `${label}-denied.log`);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CI: "",
        HOME: account,
        ACP_REVIEW_ACCOUNT_HOME: account,
        ACP_REVIEW_PROTECT: "1",
        ACP_REVIEW_DENIAL_LOG: denialLog,
        ACP_REVIEW_ALIAS_HOME: home,
        ACP_REVIEW_ALLOCATION_LOG: allocationLog,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      };
      delete env["ACP_VITEST_GATE"];
      delete env[VITEST_RPC_TRACE_ENV];
      delete env["ACP_VITEST_RPC_TRACE_FILE"];
      delete env["ACP_VITEST_RPC_TRACE_RUN"];
      const done = spawnSync(
        process.execPath,
        [VITEST, "run", "--config", config, "--reporter=json", `--outputFile.json=${report}`],
        { cwd: dir, encoding: "utf8", timeout: 50_000, env },
      );
      const output = `${done.stdout}${done.stderr}`.slice(-4000);
      expect(existsSync(report), output).toBe(true);
      const results = JSON.parse(readFileSync(report, "utf8")) as {
        numPassedTests: number;
        testResults: { message?: string }[];
      };
      return {
        status: done.status,
        passed: results.numPassedTests,
        why: results.testResults.map((file) => file.message ?? "").join("\n"),
        allocated: existsSync(allocationLog) ? readFileSync(allocationLog, "utf8") : null,
        denials: existsSync(denialLog) ? readFileSync(denialLog, "utf8").trim().split("\n").length : 0,
        output,
      };
    };

    const aliased = run("alias", aliasHome);
    expect(aliased.denials, `the protected surrogate was never reached\n${aliased.output}`).toBeGreaterThan(0);
    expect(aliased.allocated, `${aliased.why}\n${aliased.output}`).toBeNull();
    expect(readdirSync(join(state, "scratch"))).toEqual([]);
    expect(aliased.passed).toBe(0);
    expect(aliased.why).toContain("#1093");
    expect(aliased.status).not.toBe(0);

    const isolated = run("private", privateHome);
    expect(isolated.denials, `the protected surrogate was never reached\n${isolated.output}`).toBeGreaterThan(0);
    expect({ status: isolated.status, passed: isolated.passed }, `${isolated.why}\n${isolated.output}`).toEqual({
      status: 0,
      passed: 1,
    });
    expect(isolated.allocated?.startsWith(join(privateHome, ".agent-control-plane", "scratch", "acp-review-alias-"))).toBe(true);
    expect(readdirSync(join(state, "scratch"))).toEqual([]);
  }, 120_000);
});
