import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { runBoundedChild } from "../helpers/bounded-child.ts";
import { boundedExecFileSync, CHILD_BUDGET_MS } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const NODE = process.execPath;
const SQUASH_RECORDS = new URL("../../src/git/squash-records.ts", import.meta.url).href;
const MERGE_COMMIT_MESSAGE = new URL("../../src/github/merge-commit-message.ts", import.meta.url).href;
/** Larger than any pipe buffer, so a child that does not read it cannot have taken it. */
const LARGE = 1 << 20;

/**
 * A process standing in for the daemon. It installs no `uncaughtException` handler, exactly as `src`
 * has none, so an `error` event nobody listens for ends it the way it would end the daemon. It makes
 * one request through the real code, waits, and only then reports: a process that died on the way
 * reports nothing and exits non-zero.
 */
const STAND_IN = String.raw`
const [mode, moduleUrl, ...rest] = process.argv.slice(2);
const outcome = async (promise) => {
  try {
    const value = await promise;
    return { settled: "resolved", value };
  } catch (error) {
    return {
      settled: "rejected",
      message: String(error?.message),
      reasonCode: error?.reasonCode ?? null,
      evidence: error?.evidence ?? null,
      code: error?.code ?? null,
      signal: error?.signal ?? null,
    };
  }
};
let result;
if (mode === "run") {
  const [cwd, timeoutMs, inputBytes, file, ...args] = rest;
  const { boundedRun } = await import(moduleUrl);
  const input = inputBytes === "none" ? undefined : "x".repeat(Number(inputBytes));
  result = await outcome(boundedRun(cwd, { PATH: process.env.PATH }, Number(timeoutMs))(file, args, input));
} else {
  const [bin, messageBytes] = rest;
  process.env.PATH = bin + ":" + process.env.PATH;
  const { squashCommitForMerge } = await import(moduleUrl);
  const head = "a".repeat(40);
  const commits = [{ sha: head, message: "feat: a large change\n\n" + "x".repeat(Number(messageBytes)) + "\n" }];
  result = await outcome(squashCommitForMerge(commits, "A reviewed change", 100, head));
}
// Room for a late error from the child's stdin to arrive, were nothing listening for it.
await new Promise((resolve) => setTimeout(resolve, 250));
process.stdout.write(JSON.stringify({ survived: true, ...result }));
`;

interface Settled {
  readonly survived: true;
  readonly settled: "resolved" | "rejected";
  readonly value?: unknown;
  readonly message?: string;
  readonly reasonCode?: string | null;
  readonly evidence?: Record<string, unknown> | null;
  readonly code?: unknown;
  readonly signal?: unknown;
}

const home = tempDir("acp-squash-stdin-");
const standInPath = join(home, "stand-in.mjs");
writeFileSync(standInPath, STAND_IN);

/** Runs one stand-in to completion and returns what it reported, or throws naming how it died. */
const standIn = async (args: readonly string[]): Promise<Settled> => {
  const { status, stdout, stderr } = await runBoundedChild(NODE, [standInPath, ...args], { budgetMs: CHILD_BUDGET_MS });
  if (status !== 0 || stdout === "") {
    throw new Error(`the stand-in daemon did not survive the request: exit ${status}; stderr: ${stderr.slice(-1200)}`);
  }
  return JSON.parse(stdout) as Settled;
};

/** `boundedRun` in a fresh stand-in, against `child` with `input` bytes (or none) and the given bound. */
const run = (child: readonly string[], input: number | "none", timeoutMs = 30_000): Promise<Settled> =>
  standIn(["run", SQUASH_RECORDS, tempDir("acp-squash-stdin-cwd-"), String(timeoutMs), String(input), ...child]);

const node = (source: string): readonly string[] => [NODE, "-e", source];
const exitsAtOnce = (code: number) => node(`process.exit(${code})`);
const READS_ALL = "let n = 0; process.stdin.on('data', (c) => { n += c.length; }).on('end', () => { process.stdout.write(String(n));";
const readsAll = node(`${READS_ALL} });`);
const readsAllThenFails = node(`${READS_ALL} process.exitCode = 3; });`);

const refused = (settled: Settled): Record<string, unknown> => {
  if (settled.settled !== "rejected") throw new Error(`a child that never took its input was answered: ${JSON.stringify(settled)}`);
  expect(settled.reasonCode).toBe(ReasonCode.GIT_INPUT_NOT_DELIVERED);
  expect(settled.evidence).not.toBeNull();
  return settled.evidence!;
};

/**
 * FIX-EPIPE: `boundedRun` wrote a child's input with no `error` listener on its stdin. A child that
 * exits before reading it closes the pipe under the write, which fails with EPIPE; the unheard
 * `error` event is an uncaught exception, and the daemon builds merge messages on this path.
 */
describe("a child that does not take the input it is given", () => {
  it("leaves the daemon standing and refuses the request when the child exits 0 early, every time", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const settled = await run(exitsAtOnce(0), LARGE);
      expect(settled.survived).toBe(true);
      const evidence = refused(settled);
      expect(evidence).toMatchObject({ command: "node -e", inputBytes: LARGE, stdinFinished: false, exitCode: 0, signal: null });
      // EPIPE when the write fails first; none when the child's exit closes the stream first.
      expect(["EPIPE", null]).toContain(evidence["stdinError"]);
    }
  });

  it("leaves the daemon standing and refuses the merge when git fast-import exits 0 without reading the branch", async () => {
    const realGit = boundedExecFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(tempDir("acp-squash-stdin-git-"), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ "$1" = fast-import ]; then exit 0; fi\nexec '${realGit}' "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const settled = await standIn(["merge", MERGE_COMMIT_MESSAGE, bin, String(LARGE)]);
    expect(settled.survived).toBe(true);
    expect(refused(settled)).toMatchObject({ command: "git fast-import", stdinFinished: false, exitCode: 0, signal: null });
  });

  /**
   * No EPIPE to hear: the child hands its stdin to a process that holds it open unread and exits 0,
   * so the write never fails and Node destroys the stream as the child exits. Unfinished is refused.
   */
  it("refuses an exit 0 whose stdin closed unfinished without any error", async () => {
    const pidFile = join(tempDir("acp-squash-stdin-holder-"), "pid");
    const holder = node([
      "const holder = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
      "  { stdio: [0, 'ignore', 'ignore'], detached: true });",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid));`,
      "holder.unref();",
      "process.exit(0);",
    ].join("\n"));
    try {
      const evidence = refused(await run(holder, LARGE));
      expect(evidence).toMatchObject({ inputBytes: LARGE, stdinError: null, stdinFinished: false, exitCode: 0, signal: null });
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  });

  it("refuses an early non-zero exit as undelivered input, naming the exit", async () => {
    expect(refused(await run(exitsAtOnce(3), LARGE))).toMatchObject({ inputBytes: LARGE, stdinFinished: false, exitCode: 3, signal: null });
  });

  it("refuses an early signal exit as undelivered input, naming the signal", async () => {
    const settled = await run(node("process.kill(process.pid, 'SIGKILL')"), LARGE);
    expect(refused(settled)).toMatchObject({ inputBytes: LARGE, stdinFinished: false, exitCode: null, signal: "SIGKILL" });
  });
});

describe("a child that takes its input, or is given none", () => {
  it("answers with the child's output when it reads all of its input", async () => {
    expect(await run(readsAll, LARGE)).toEqual({ survived: true, settled: "resolved", value: String(LARGE) });
  });

  it("keeps a failure after the input was taken as the child's own, unclassified as before", async () => {
    const settled = await run(readsAllThenFails, LARGE);
    expect(settled).toMatchObject({ survived: true, settled: "rejected", reasonCode: null, code: 3 });
  });

  it("closes stdin without writing when there is no input, and answers a child that exits 0 at once", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await run(exitsAtOnce(0), "none")).toEqual({ survived: true, settled: "resolved", value: "" });
    }
  });
});

/** Each control twice: with no input, as every caller but `fast-import` runs, and with input never taken. */
describe("the bound and the output cap keep their own classification", () => {
  const outlivesTheBound = node("setInterval(() => {}, 1000)");
  const floods = node("const b = Buffer.alloc(1 << 20, 120); const w = () => { while (process.stdout.write(b)); process.stdout.once('drain', w); }; w();");

  it.each(["none", LARGE] as const)("refuses a child that outlives the bound as GIT_TIMEOUT (input: %s)", async (input) => {
    const settled = await run(outlivesTheBound, input, 500);
    expect(settled).toMatchObject({ survived: true, settled: "rejected", reasonCode: ReasonCode.GIT_TIMEOUT });
    expect(settled.evidence).toEqual({ timeoutMs: 500, started: true });
  });

  it.each(["none", LARGE] as const)("fails a child that overflows maxBuffer with Node's own error (input: %s)", async (input) => {
    const settled = await run(floods, input);
    expect(settled).toMatchObject({ survived: true, settled: "rejected", reasonCode: null, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });
});
