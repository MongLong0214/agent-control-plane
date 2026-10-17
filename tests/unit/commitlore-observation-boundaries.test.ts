import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, expect, it, vi } from "vitest";

import { COMMITLORE_LIMITS, commitloreRunner, createCommitLoreCliPort, probeCommitLore } from "../../src/bootstrap/commitlore-observation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * Review S11-R1 (PR #1138) — the reviewer's subprocess witnesses for the CommitLore observer, with real
 * children: R1-01 (no daemon authority reaches a `commitlore` child) and R1-02 (an overflowing child that
 * ignores SIGTERM cannot hold the observation open). Changed from the review's reproduction only for paths
 * and isolation: every file lives in a temporary directory of this run, never in the checkout. Added here:
 * an unknown secret sentinel, the owned-child termination proof, and a timeout on a child that ignores
 * SIGTERM. Every process a witness starts is ended by its exact PID in `finally`, never by group.
 */

afterEach(() => vi.unstubAllEnvs());
// A witness abandoned at its timeout never reaches its own `finally`, which ends its processes and removes
// their PID files. A PID file still here names a process that was never ended: only that one is.
const pidFiles: string[] = [];
afterAll(() => {
  for (const pidFile of pidFiles) killExact(pidFile);
  cleanupTempDirs();
});

const root = tempDir("acp-s11-r1-boundaries-");
const ok = JSON.stringify({ schema: "commitlore_doctor.v2", status: "ok", exitCode: 0, checks: [] });

/** A `commitlore` on PATH that is `body`, run by this Node, its directory first on this process's PATH. */
const fake = (name: string, body: string): string => {
  const dir = tempDir(`acp-s11-r1-${name}-`);
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  writeFileSync(join(dir, "commitlore"), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  vi.stubEnv("PATH", `${dir}:/usr/bin:/bin`);
  return dir;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function killExact(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (Number.isSafeInteger(pid) && pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
}

it("R1-01: CommitLore children receive no daemon authority variables, a known name or an unknown one", async () => {
  const capture = join(root, "child-env.json");
  // An arbitrary name and value nothing in ACP knows: no denylist can be what keeps it out.
  const unknownName = `S11_R1_UNKNOWN_${randomBytes(6).toString("hex").toUpperCase()}`;
  const unknownValue = `s11-r1-${randomBytes(16).toString("hex")}`;
  const bin = fake(
    "env-bin",
    `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.env));
    if (process.argv[2] === 'doctor') console.log(${JSON.stringify(ok)});
  `,
  );
  const sentinels = ["ACP_MCP_TOKEN", "ACP_OPERATOR_TOKEN", "GH_TOKEN", "BUZZ_PRIVATE_KEY", "GIT_REVIEW_SENTINEL"];
  for (const key of sentinels) vi.stubEnv(key, `review-only-${key}`);
  vi.stubEnv(unknownName, unknownValue);

  expect((await createCommitLoreCliPort().observe(root)).outcome).toBe("PASS");
  const observed = JSON.parse(readFileSync(capture, "utf8")) as Record<string, string>;
  expect(Object.fromEntries(sentinels.map((key) => [key, observed[key] ?? null]))).toEqual(
    Object.fromEntries(sentinels.map((key) => [key, null])),
  );
  expect(observed[unknownName]).toBeUndefined();
  const serialized = JSON.stringify(observed);
  expect(serialized).not.toContain(unknownName);
  expect(serialized).not.toContain(unknownValue);
  for (const key of sentinels) expect(serialized).not.toContain(`review-only-${key}`);
  // Constructed, not filtered: only what the CP-HI-05 child environment names (and what macOS's own
  // CoreFoundation sets inside a process that lacks it) is there at all.
  // S11-R3 added git's credential controls, every value of which ACP sets itself.
  const constructed = new Set([
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_TERMINAL_PROMPT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_ASKPASS",
  ]);
  expect(Object.keys(observed).filter((key) => !constructed.has(key) && key !== "__CF_USER_TEXT_ENCODING")).toEqual([]);
  // The daemon's PATH is used to find `commitlore`, and is not handed to it.
  expect(observed["PATH"]?.split(":")).not.toContain(bin);
});

it("R1-02: an output-overflowing child cannot keep the observation pending by ignoring SIGTERM", async () => {
  const pidFile = join(root, "overflow.pid");
  const signalFile = join(root, "overflow-sigterm.txt");
  pidFiles.push(pidFile);
  rmSync(pidFile, { force: true });
  rmSync(signalFile, { force: true });
  fake(
    "overflow-bin",
    `
    const fs = require('node:fs');
    process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(signalFile)}, 'received'));
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.stdout.write('x'.repeat(6 * 1024 * 1024));
    setInterval(() => {}, 1000);
  `,
  );
  let settled = false;
  const pending = createCommitLoreCliPort()
    .observe(root)
    .then((value) => {
      settled = true;
      return value;
    });
  let settledAfterOverflow = false;
  try {
    await vi.waitFor(() => expect(existsSync(signalFile)).toBe(true), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    settledAfterOverflow = settled;
  } finally {
    killExact(pidFile);
    rmSync(pidFile, { force: true });
    await pending;
  }
  expect(settledAfterOverflow).toBe(true);
  expect((await pending).outcome).toBe("FAIL");
  expect((await pending).detail).toMatch(/more than 4194304 bytes to stdout/);
});

it("R1-02: the owned child that ignores SIGTERM is SIGKILLed after the grace, and nothing else is signalled", async () => {
  const pidFile = join(root, "owned.pid");
  const siblingFile = join(root, "owned-descendant.pid");
  pidFiles.push(siblingFile, pidFile);
  rmSync(pidFile, { force: true });
  rmSync(siblingFile, { force: true });
  // The child starts a descendant, in the child's own process group, that also ignores SIGTERM. Ending the
  // child must not reach it: no group signal, and no PID this invocation did not spawn.
  fake(
    "owned-bin",
    `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(siblingFile)}, String(descendant.pid));
    process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `,
  );
  const limits = { ...COMMITLORE_LIMITS, timeoutMs: 1_000, killGraceMs: 500 };
  const started = Date.now();
  try {
    await expect(commitloreRunner(limits)(["init"], root)).rejects.toThrow(/did not answer within 1000 ms/);
    // The answer is refused at the deadline, not when the child finally dies.
    expect(Date.now() - started).toBeLessThan(limits.timeoutMs + 1_000);
    const child = Number(readFileSync(pidFile, "utf8"));
    const descendant = Number(readFileSync(siblingFile, "utf8"));
    expect(alive(child)).toBe(true);
    await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: limits.killGraceMs + 2_000, interval: 50 });
    // The descendant, in the same process group, survives: the runner signalled its own child only.
    expect(alive(descendant)).toBe(true);
  } finally {
    killExact(siblingFile);
    killExact(pidFile);
    rmSync(siblingFile, { force: true });
    rmSync(pidFile, { force: true });
  }
});

it("R1-02: a child that exits 0 after this client signalled it is refused, never PASS", async () => {
  fake(
    "exit0-bin",
    `
    process.on('SIGTERM', () => {
      if (process.argv[2] === 'doctor') console.log(${JSON.stringify(ok)});
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `,
  );
  const run = commitloreRunner({ ...COMMITLORE_LIMITS, timeoutMs: 800, killGraceMs: 500 });
  const observed = await createCommitLoreCliPort(run).observe(root);
  expect(observed).toMatchObject({ outcome: "FAIL", detail: expect.stringMatching(/init could not be run: .*did not answer within 800 ms/) });
});

it("lead-3: a successful init that creates a checkout file is refused by the probe", async () => {
  fake(
    "mutation-bin",
    `
    const fs = require('node:fs');
    if (process.argv[2] === 'init') { fs.mkdirSync('.claude', {recursive:true}); fs.writeFileSync('.claude/settings.json','{}'); }
    else console.log(${JSON.stringify(ok)});
  `,
  );
  expect(await probeCommitLore(createCommitLoreCliPort())).toMatchObject({
    allowed: false,
    evidence: { refusal: "COMMITLORE_CHANGED_CHECKOUT", at: "probe" },
  });
});
