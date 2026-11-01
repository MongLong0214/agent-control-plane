import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  __testing as sandboxTesting,
  CANDIDATE_PROCESS_BUDGET,
  DESCENDANT_OUTLIVED_CANDIDATE,
  PROCESS_LIMIT_EXCEEDED,
  PROCESS_LIMIT_UNAVAILABLE,
  runSandboxed,
  type SandboxOutcome,
} from "../../src/verify/sandbox.ts";
import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { requireSeatbelt } from "../helpers/seatbelt.ts";
import { stableFixtureExecutable } from "../helpers/stable-fixture-executable.ts";

/**
 * E2E-02: a freshly activated project's required verification is `npm test`, and under RLIMIT_NPROC 1
 * it failed EAGAIN whatever the candidate held -- that limit counts every process of the user on
 * macOS, so npm could not start `sh -c node --test`. A declared command that runs no gate entry now
 * runs under the trusted supervisor's polled process budget instead. Every case here runs in the
 * real seatbelt sandbox with the real supervisor; none of them stands in for the sandbox.
 */

afterEach(cleanupTempDirs);

const described = (outcome: SandboxOutcome): string =>
  `sandbox ${outcome.status} exit=${outcome.exitCode} signal=${outcome.signal ?? "none"} reason=${outcome.reasonCode ?? "none"} ` +
  `stdout: ${outcome.stdout.trim().slice(-1_500)} stderr: ${outcome.stderr.trim().slice(-1_500)}`;

/** Each probe runs `/bin/sleep <this>`, so a pid this file kills is one of its own probes. */
const PROBE_SECONDS = "3607";

const isOurProbe = (pid: number): boolean => {
  const ps = boundedSpawnSync("/bin/ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return ps.status === 0 && String(ps.stdout).trim() === `/bin/sleep ${PROBE_SECONDS}`;
};

/** Pids the candidate recorded, one per line, as it created each probe. */
const recordedPids = (worktree: string): number[] => {
  const path = join(worktree, "pids.txt");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
};

/**
 * The recorded probes still running after the outcome. A killed probe's zombie can outlast its kill
 * for a moment while launchd reaps it, so this waits briefly before calling one alive. Whatever is
 * still running at the end is killed here -- only pids this file's own probes hold.
 */
const survivorsAfterOutcome = async (worktree: string): Promise<number[]> => {
  const pids = recordedPids(worktree);
  let running = pids;
  for (let attempt = 0; attempt < 40 && running.length > 0; attempt += 1) {
    running = running.filter(isOurProbe);
    if (running.length > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  for (const pid of running) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return running;
};

/**
 * A node candidate that starts `/bin/sleep` probes, appending each pid to pids.txt as soon as it
 * exists. `detached` probes call setsid(2), leaving the launched process group.
 */
const probeSpawner = (body: string): string => `
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const probe = (detached) => {
  const child = spawn('/bin/sleep', ['${PROBE_SECONDS}'], { detached, stdio: 'ignore' });
  if (child.pid) appendFileSync('pids.txt', child.pid + '\\n');
  child.unref();
  return child;
};
${body}
`;

const budgetRun = (
  worktree: string,
  argv: string[],
  overrides: Record<string, unknown> = {},
): Promise<SandboxOutcome> =>
  runSandboxed({
    command: parseVerificationCommand({ id: "budget", argv, timeoutSeconds: 30, ...overrides }),
    worktreePath: worktree,
    processLimit: "supervised-budget",
  });

/** A package whose `npm test` is `node --test` over two files, one of which runs a child of its own. */
const npmTestPackage = (secondAssertion: string): Record<string, string> => ({
  "package.json": `${JSON.stringify({ name: "budget-fixture", version: "1.0.0", scripts: { test: "node --test" } })}\n`,
  "test/arithmetic.test.js": [
    "const { test } = require('node:test');",
    "const assert = require('node:assert/strict');",
    "test('adds', () => assert.equal(2 + 2, 4));",
    "",
  ].join("\n"),
  "test/child.test.js": [
    "const { test } = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { execFileSync } = require('node:child_process');",
    "test('runs a child process', () => {",
    "  const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(6 * 7))'], { encoding: 'utf8' });",
    `  ${secondAssertion}`,
    "});",
    "",
  ].join("\n"),
});

describe("a declared verification command spawns under a supervised process budget", () => {
  it("passes an `npm test` whose `node --test` runs child processes, with its assertion results", async (context) => {
    requireSeatbelt(context);
    const worktree = tempDir("acp-budget-npm-pass-");
    writeFiles(worktree, npmTestPackage("assert.equal(out, '42');"));

    const outcome = await budgetRun(worktree, ["npm", "test"]);

    expect(outcome, described(outcome)).toMatchObject({
      status: "PASS",
      exitCode: 0,
      reasonCode: null,
      enforcement: { processLimit: "supervised-budget", childContainmentEnforced: true, networkEnforced: false },
    });
    // The verdict is the runner's own: both files ran, in their own processes, and passed.
    expect(outcome.stdout).toMatch(/^# tests 2$/m);
    expect(outcome.stdout).toMatch(/^# pass 2$/m);
    expect(outcome.stdout).toMatch(/^# fail 0$/m);
    expect(outcome.stdout).toMatch(/^ok \d+ - runs a child process$/m);
  });

  it("propagates a failing assertion in that `npm test` as FAIL with the runner's nonzero exit", async (context) => {
    requireSeatbelt(context);
    const worktree = tempDir("acp-budget-npm-fail-");
    writeFiles(worktree, npmTestPackage("assert.equal(out, '43');"));

    const outcome = await budgetRun(worktree, ["npm", "test"]);

    expect(outcome, described(outcome)).toMatchObject({ status: "FAIL", exitCode: 1, reasonCode: null });
    expect(outcome.stdout).toMatch(/^# pass 1$/m);
    expect(outcome.stdout).toMatch(/^# fail 1$/m);
    expect(outcome.stdout).toMatch(/^not ok \d+ - runs a child process$/m);
  });

  it(`kills the whole tree and FAILs a candidate that forks past ${CANDIDATE_PROCESS_BUDGET} live descendants`, async (context) => {
    requireSeatbelt(context);
    const worktree = tempDir("acp-budget-exceeded-");
    // Half of the probes leave the launched process group, so only the supervisor's tracking --
    // not the group kill -- can reach them.
    writeFiles(worktree, {
      "fork.js": probeSpawner(`
for (let i = 0; i < ${CANDIDATE_PROCESS_BUDGET + 40}; i += 1) probe(i % 2 === 0);
setInterval(() => {}, 1000);
`),
    });

    const outcome = await budgetRun(worktree, ["node", "fork.js"], { timeoutSeconds: 20 });

    expect(outcome, described(outcome)).toMatchObject({
      status: "FAIL",
      exitCode: 123,
      reasonCode: ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED,
      enforcement: { processLimit: "supervised-budget", childContainmentEnforced: true },
    });
    expect(outcome.stderr).toContain(`${PROCESS_LIMIT_EXCEEDED}:`);
    expect(outcome.stderr).toContain(`the supervised budget of ${CANDIDATE_PROCESS_BUDGET}`);
    expect(recordedPids(worktree).length).toBeGreaterThan(CANDIDATE_PROCESS_BUDGET);
    expect(await survivorsAfterOutcome(worktree)).toEqual([]);
  });

  it("leaves no tracked descendant after a timeout, in or out of the launched process group", async (context) => {
    requireSeatbelt(context);
    const worktree = tempDir("acp-budget-timeout-");
    writeFiles(worktree, { "hang.js": probeSpawner("probe(false); probe(true);\nsetInterval(() => {}, 1000);\n") });

    const outcome = await budgetRun(worktree, ["node", "hang.js"], { timeoutSeconds: 2 });

    expect(outcome, described(outcome)).toMatchObject({ status: "TIMEOUT", reasonCode: ReasonCode.VERIFICATION_TIMEOUT });
    expect(recordedPids(worktree)).toHaveLength(2);
    expect(await survivorsAfterOutcome(worktree)).toEqual([]);
  });

  it("leaves no tracked descendant after the output limit cancels the run", async (context) => {
    requireSeatbelt(context);
    const worktree = tempDir("acp-budget-cancel-");
    writeFiles(worktree, {
      "flood.js": probeSpawner(`
probe(false); probe(true);
setTimeout(() => { const line = 'x'.repeat(1000); for (;;) process.stdout.write(line + '\\n'); }, 300);
`),
    });

    const outcome = await budgetRun(worktree, ["node", "flood.js"], { maxOutputBytes: 10_000 });

    expect(outcome, described(outcome)).toMatchObject({
      outputTruncated: true,
      reasonCode: ReasonCode.VERIFICATION_OUTPUT_TRUNCATED,
    });
    expect(outcome.status).not.toBe("PASS");
    expect(recordedPids(worktree)).toHaveLength(2);
    expect(await survivorsAfterOutcome(worktree)).toEqual([]);
  });

  it("FAILs a candidate that exits 0 while a descendant it started is still running, and kills it", async (context) => {
    requireSeatbelt(context);
    const worktree = tempDir("acp-budget-outlived-");
    // The pause keeps the probes the candidate's own children until the supervisor has seen them;
    // a child created and reparented between two polls is the #461 residual, not this case.
    writeFiles(worktree, { "leave.js": probeSpawner("probe(false); probe(true);\nsetTimeout(() => process.exit(0), 300);\n") });

    const outcome = await budgetRun(worktree, ["node", "leave.js"]);

    expect(outcome, described(outcome)).toMatchObject({
      status: "FAIL",
      exitCode: 121,
      reasonCode: ReasonCode.VERIFICATION_COMMAND_FAILED,
    });
    expect(outcome.stderr).toContain(`${DESCENDANT_OUTLIVED_CANDIDATE}: 2 tracked descendant(s)`);
    expect(await survivorsAfterOutcome(worktree)).toEqual([]);
  });

  it("FAILs a candidate whose descendant is still running when it exits, even if that descendant ends moments later", async (context) => {
    requireSeatbelt(context);
    const worktree = tempDir("acp-budget-outlived-briefly-");
    // The child waits on a pipe only the candidate holds, so it is running at the instant the
    // candidate exits and ends a few milliseconds after -- inside the supervisor's settling turns,
    // which a verdict read after those turns would no longer see.
    writeFiles(worktree, {
      "brief.js": [
        "const { spawn } = require('node:child_process');",
        "spawn('/bin/sh', ['-c', 'read line; /bin/sleep 0.005'], { stdio: ['pipe', 'ignore', 'ignore'] });",
        "setTimeout(() => process.exit(0), 300);",
        "",
      ].join("\n"),
    });

    const outcome = await budgetRun(worktree, ["node", "brief.js"]);

    expect(outcome, described(outcome)).toMatchObject({
      status: "FAIL",
      exitCode: 121,
      reasonCode: ReasonCode.VERIFICATION_COMMAND_FAILED,
    });
    expect(outcome.stderr).toContain(`${DESCENDANT_OUTLIVED_CANDIDATE}:`);
  });

  it("does not claim containment, or pass, when the candidate kills its supervisor", async (context) => {
    requireSeatbelt(context);
    const worktree = tempDir("acp-budget-supervisor-killed-");
    // The probe is tracked before the supervisor dies, and only the supervisor tracked it. It is the
    // residual this case documents rather than asserts on: with the supervisor gone nothing reaps a
    // probe that left the launched group, so the cleanup below kills it.
    writeFiles(worktree, {
      "kill-supervisor.js": probeSpawner(`
probe(true);
setTimeout(() => { process.kill(process.ppid, 'SIGKILL'); setTimeout(() => process.exit(0), 100); }, 300);
`),
    });

    const outcome = await budgetRun(worktree, ["node", "kill-supervisor.js"]);
    await survivorsAfterOutcome(worktree);

    expect(outcome, described(outcome)).toMatchObject({
      status: "ERROR",
      signal: "SIGKILL",
      reasonCode: ReasonCode.SANDBOX_CHILD_CLEANUP_FAILED,
      enforcement: { processLimit: "supervised-budget", childContainmentEnforced: false },
    });
    expect(outcome.enforcement.childContainmentReason).toContain("supervisor");
  });

  it("records a candidate's own CPU-limit kill as SIGXCPU, exactly as without the budget", async (context) => {
    requireSeatbelt(context);
    const worktree = tempDir("acp-budget-cpu-");
    writeFiles(worktree, { "spin.js": "for (;;) {}\n" });

    const outcome = await budgetRun(worktree, ["node", "spin.js"], { maxCpuSeconds: 1, timeoutSeconds: 15 });

    expect(outcome, described(outcome)).toMatchObject({
      status: "ERROR",
      signal: "SIGXCPU",
      reasonCode: ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED,
    });
  });

  /**
   * A `ps` that answers late, as on a loaded CI runner: the sandbox's own identity probes run through
   * it. That is how #1222's CI saw the candidate gone before its identity could be fenced.
   */
  const SLOW_PS = "#!/bin/sh\n/bin/sleep 0.08\nexec /bin/ps \"$@\"\n";
  const withSlowPs = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = process.env["PATH"];
    process.env["PATH"] = `${dirname(stableFixtureExecutable("ps", SLOW_PS))}${delimiter}${previous ?? ""}`;
    try {
      return await operation();
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
  };

  const asIs = <T>(operation: () => Promise<T>): Promise<T> => operation();
  for (const [answers, probes] of [["promptly", asIs], ["late, as on a loaded runner", withSlowPs]] as const) {
    it(`FAILs closed, starting no candidate, when the child-list reader is unavailable and ps answers ${answers}`, async (context) => {
      requireSeatbelt(context);
      const worktree = tempDir("acp-budget-no-reader-");

      const outcome = await probes(() =>
        sandboxTesting.withChildListReaderUnavailable(() => budgetRun(worktree, ["node", "-e", "process.exit(0)"])),
      );

      expect(outcome, described(outcome)).toMatchObject({
        status: "FAIL",
        exitCode: 122,
        reasonCode: ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE,
        enforcement: { processLimit: "supervised-budget", childContainmentEnforced: false },
      });
      expect(outcome.stderr).toContain(`${PROCESS_LIMIT_UNAVAILABLE}: the kernel child list cannot be read, so no candidate was started`);
      expect(outcome.enforcement.childContainmentReason).toContain("started no candidate");
    });
  }

  it("records a cleanup it cannot prove when the candidate stops and continues its supervisor", async (context) => {
    requireSeatbelt(context);
    const worktree = tempDir("acp-budget-supervisor-stopped-");
    // After release the supervisor did not watch the tree while it was stopped, so whatever the
    // candidate did meanwhile is not proven stopped: that is not the same as a budget refused up front.
    writeFiles(worktree, {
      "stop-supervisor.js": [
        "setTimeout(() => {",
        "  process.kill(process.ppid, 'SIGSTOP');",
        "  setTimeout(() => process.kill(process.ppid, 'SIGCONT'), 100);",
        "}, 300);",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    });

    const outcome = await budgetRun(worktree, ["node", "stop-supervisor.js"]);

    expect(outcome, described(outcome)).toMatchObject({
      status: "ERROR",
      exitCode: 126,
      reasonCode: ReasonCode.SANDBOX_CHILD_CLEANUP_FAILED,
      enforcement: { processLimit: "supervised-budget", childContainmentEnforced: false },
    });
    expect(outcome.stderr).toContain("ACP_CHILD_CLEANUP_UNAVAILABLE: the supervisor could not watch the candidate's process tree");
    expect(outcome.stderr).not.toContain(`${PROCESS_LIMIT_UNAVAILABLE}:`);
  });

  it("still refuses every spawn when the trusted caller asks for no-spawn or names no mode", async (context) => {
    requireSeatbelt(context);
    const worktree = tempDir("acp-budget-no-spawn-");
    writeFiles(worktree, {
      "spawn.js": "const r = require('node:child_process').spawnSync('/bin/echo', ['spawned']);\nconsole.log(r.error ? r.error.code : 'status ' + r.status);\n",
    });
    const command = parseVerificationCommand({ id: "no-spawn", argv: ["node", "spawn.js"], timeoutSeconds: 30 });

    for (const request of [{ processLimit: "no-spawn" as const }, {}]) {
      const outcome = await runSandboxed({ command, worktreePath: worktree, ...request });
      expect(outcome, described(outcome)).toMatchObject({
        status: "PASS",
        enforcement: { processLimit: "no-spawn", childContainmentEnforced: true },
      });
      expect(outcome.stdout.trim()).toBe("EAGAIN");
    }
  });
});
