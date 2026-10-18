import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_NON_INTERACTIVE_ARGS,
  ClaudeUsageCollector,
  CodexUsageCollector,
  ExpectUsageTerminal,
  SpawnNonInteractiveUsageProbe,
  type UsageTerminal,
  type UsageTerminalResult,
} from "../../src/capacity/usage-collectors.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { runBoundedChild } from "../helpers/bounded-child.ts";
import { CHILD_BUDGET_MS } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * When set, the next spawn returns what this gives back: a stand-in child, or the real child it was
 * handed to start, watched. Every other spawn, the stand-in daemons' included, is real.
 */
const spawnSeam = vi.hoisted(() => ({ next: null as null | ((real: () => ChildProcess.ChildProcess) => unknown) }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcess>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: ChildProcess.SpawnOptions) {
      const next = spawnSeam.next;
      spawnSeam.next = null;
      return next === null ? actual.spawn(command, args, options) : next(() => actual.spawn(command, args, options));
    },
  };
});

afterAll(cleanupTempDirs);

const NODE = process.execPath;
const USAGE_COLLECTORS = new URL("../../src/capacity/usage-collectors.ts", import.meta.url).href;
const CLOCK = new URL("../../src/core/clock.ts", import.meta.url).href;
/** Larger than any pipe or socket buffer, so an `expect` that stops reading its program cannot have taken it. */
const LARGE = 1 << 20;

/**
 * A process standing in for the daemon. It installs no `uncaughtException` handler, exactly as `src`
 * has none, so an `error` event nobody hears ends it the way it would end the daemon. It runs a
 * collector to its reading `repeat` times in one process, as the daemon does, waits, and only then
 * reports: a process that died on the way reports nothing and exits non-zero.
 *
 * `codex` is the daemon's own Codex path: `cli-adapters.ts` builds `CodexUsageCollector` with no
 * terminal, so `collect()` asks `SpawnCodexRateLimitProbe`. `claude-pty` is the pseudo-terminal path a
 * collector takes when `ExpectUsageTerminal` is configured; with `enlarge`, the collector's own steps
 * reach the real terminal with `enlarge` bytes ahead of the last step's keystrokes, because the
 * program its fixed steps make is far smaller than a socket buffer and so can never be refused.
 */
const STAND_IN = String.raw`
const [collectorsUrl, clockUrl, mode, binary, enlarge, home, repeat] = process.argv.slice(2);
const { ClaudeUsageCollector, CodexUsageCollector, ExpectUsageTerminal } = await import(collectorsUrl);
const { ManualClock } = await import(clockUrl);
const clock = new ManualClock("2026-08-13T00:00:00.000Z");
let collector;
if (mode === "codex") {
  collector = new CodexUsageCollector({ clock, binary, timeoutMs: 8_000, codexHome: home });
} else {
  const real = new ExpectUsageTerminal();
  const terminal =
    Number(enlarge) === 0
      ? real
      : {
          run: (input) =>
            real.run({
              ...input,
              steps: input.steps.map((step, index) =>
                index === input.steps.length - 1 ? { ...step, input: "x".repeat(Number(enlarge)) + step.input } : step,
              ),
            }),
        };
  collector = new ClaudeUsageCollector({ clock, binary, timeoutMs: 8_000, terminal });
}
const results = [];
for (let round = 0; round < Number(repeat); round++) {
  try {
    const reading = await collector.collect();
    results.push({ survived: true, settled: "resolved", sensorHealth: reading.sensorHealth, buckets: reading.buckets, error: reading.error ?? null });
  } catch (error) {
    results.push({ survived: true, settled: "rejected", message: String(error?.message) });
  }
}
// Room for a late error from the child's stdin to arrive, were nothing listening for it.
await new Promise((resolve) => setTimeout(resolve, 250));
process.stdout.write(JSON.stringify(results), () => process.exit(0));
`;

interface Settled {
  readonly survived: true;
  readonly settled: "resolved" | "rejected";
  readonly sensorHealth?: string;
  readonly buckets?: ReadonlyArray<{ readonly id: string; readonly remainingPercent: number }>;
  readonly error?: string | null;
  readonly message?: string;
}

const home = tempDir("acp-usage-stdin-");
const standInPath = join(home, "stand-in.mjs");
const codexHome = join(home, "codex-home");
mkdirSync(codexHome);
writeFileSync(standInPath, STAND_IN);

const script = (name: string, body: string): string => {
  const path = join(home, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

const READ_ANSWER = `{"id":1,"result":{"primary":{"usedPercent":%s,"windowDurationMins":10080,"resetsAt":1787196559}}}`;

/** Takes `initialize`, shuts its stdin, answers the handshake, and later answers a read it never received: 0% used. */
const codexShutsStdin = script(
  "codex-shuts-stdin",
  `IFS= read -r line\nexec 0<&-\nprintf '{"id":0,"result":{}}\\n'\nsleep 0.4\nprintf '${READ_ANSWER}\\n' 0\nsleep 5`,
);
/** Answers the handshake and exits at once: the requests that follow meet a closed pipe or a dead server. */
const codexExitsAfterHandshake = script("codex-exits", `IFS= read -r line\nprintf '{"id":0,"result":{}}\\n'\nexit 0`);
/** A server that takes every line and answers the read: 23% used. It never exits; the probe kills its group. */
const codexNormal = script(
  "codex-normal",
  `IFS= read -r line\nprintf '{"id":0,"result":{}}\\n'\nIFS= read -r line\nIFS= read -r line\nprintf '${READ_ANSWER}\\n' 23\nsleep 5`,
);
const expectPidPath = join(home, "expect.pid");
/**
 * Prints a usage line and exits before its banner: the program's wait for the banner meets eof. It
 * records its parent, the `expect` running it, so the witness can see that `expect` is gone after.
 */
const claudeExitsAtOnce = script(
  "claude-exits",
  `echo $PPID >> '${expectPidPath}'\nprintf '5-hour limit: 77%% remaining - resets in 2h\\n'\nexit 0`,
);

/** Whether `pid` has ended within a few seconds. */
const ends = async (pid: number): Promise<boolean> => {
  for (let waited = 0; waited < 3_000; waited += 50) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};
/** The next spawn, real, with its `exit` watched from before the probe's own listeners. */
const watchNextSpawn = (): { child: ChildProcess.ChildProcess | undefined; exited: boolean } => {
  const watch: { child: ChildProcess.ChildProcess | undefined; exited: boolean } = { child: undefined, exited: false };
  spawnSeam.next = (real) => {
    const started = real();
    watch.child = started;
    started.once("exit", () => {
      watch.exited = true;
    });
    return started;
  };
  return watch;
};

/**
 * FIX-1148-R2 — read at the moment the call returns, with nothing awaited in between: whether the owned
 * child's `exit` had been seen (Node emits it after reaping), and whether its pid still names any process,
 * a zombie included. Never a poll after the return: that would pass a call that returned first.
 */
const atReturn = (pid: number | undefined): { pidPresent: boolean } => {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) throw new Error(`no owned pid to check: ${pid}`);
  try {
    process.kill(pid, 0);
    return { pidPresent: true };
  } catch (error) {
    return { pidPresent: (error as NodeJS.ErrnoException).code !== "ESRCH" };
  }
};

/** Whether `pid` names a process right now: read before any cleanup, so a check is never passed by killing first. */
const alive = (pid: number): boolean => atReturn(pid).pidPresent;

/** The most of a timeout `usage-collectors.ts` keeps for cleanup (CLEANUP_RESERVE_CAP_MS). */
const cleanupReserveCap = 500;

/** Exits at once, saying nothing. */
const claudeSilent = script("claude-silent", "exit 0");
/** The banner after a moment, then the usage screen once /usage arrives. */
const claudeNormal = script(
  "claude-normal",
  `sleep 0.9\nprintf 'Claude Code v2.1.233\\n'\nIFS= read -r line\nprintf '5-hour limit: 77%% remaining - resets in 2h\\n'\nsleep 5`,
);

/** `repeat` collections in one fresh stand-in daemon; throws naming how the stand-in died, if it did. */
const collections = async (mode: "codex" | "claude-pty", binary: string, enlarge: number, repeat: number): Promise<Settled[]> => {
  const { status, stdout, stderr } = await runBoundedChild(
    NODE,
    ["--experimental-transform-types", "--no-warnings", standInPath, USAGE_COLLECTORS, CLOCK, mode, binary, String(enlarge), codexHome, String(repeat)],
    { budgetMs: CHILD_BUDGET_MS },
  );
  if (status !== 0 || stdout === "") {
    throw new Error(`the stand-in daemon did not survive the collection: exit ${status}; stderr: ${stderr.slice(-1200)}`);
  }
  return JSON.parse(stdout) as Settled[];
};

const standIn = async (mode: "codex" | "claude-pty", binary: string, enlarge = 0): Promise<Settled> =>
  (await collections(mode, binary, enlarge, 1))[0]!;

/** A reading that says the query failed: no window, no figure, nothing that could read as headroom or as 0 left. */
const failedReading = (settled: Settled): string => {
  expect(settled.survived).toBe(true);
  if (settled.settled !== "resolved") throw new Error(`the collector threw instead of answering a failed reading: ${settled.message}`);
  expect(settled.sensorHealth).toBe("ERROR");
  expect(settled.buckets).toEqual([]);
  expect(settled.error).toEqual(expect.any(String));
  return settled.error!;
};

/**
 * FIX-STDIN-SIBLINGS, usage-collectors.ts:658: `SpawnCodexRateLimitProbe` wrote its JSON-RPC lines to
 * the app-server with no `error` listener on stdin. A server that is gone, or has shut its stdin, by
 * the time the read is sent fails that write with EPIPE; the unheard `error` event is an uncaught
 * exception, and the daemon reaches this probe through `cli-adapters.ts` → `CodexUsageCollector`.
 */
describe("FIX-STDIN-SIBLINGS: the Codex rate-limit probe when the app-server does not take its request", () => {
  it("leaves the daemon standing and reads a failure when the server shuts its stdin, never the answer it sends later", async () => {
    const error = failedReading(await standIn("codex", codexShutsStdin));
    expect(error).toMatch(/did not take/);
    expect(error).toMatch(/EPIPE/);
  });

  it("leaves the daemon standing and reads a failure when the server exits right after the handshake, every time", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const error = failedReading(await standIn("codex", codexExitsAfterHandshake));
      expect(error).toMatch(/did not take|exited before answering/);
    }
  });

  it("control: reads the window a server that took every line answered", async () => {
    const settled = await standIn("codex", codexNormal);
    expect(settled).toMatchObject({ survived: true, settled: "resolved", sensorHealth: "HEALTHY", error: null });
    expect(settled.buckets?.map((bucket) => [bucket.id, bucket.remainingPercent])).toEqual([["7d", 77]]);
  });
});

/**
 * FIX-STDIN-SIBLINGS, usage-collectors.ts:416: `ExpectUsageTerminal` handed `expect` its program on
 * stdin with no `error` listener there. `expect -f -` runs the program as it reads it, so an `expect`
 * that exits partway (its wait for the banner met eof) leaves the rest unread and fails the write.
 */
describe("FIX-STDIN-SIBLINGS: the pseudo-terminal collector when expect does not take its program", () => {
  it("leaves the daemon standing and reads a failure, not the usage line the CLI printed, when expect stops reading, and no expect behind", async () => {
    const rounds = await collections("claude-pty", claudeExitsAtOnce, LARGE, 10);
    expect(rounds).toHaveLength(10);
    for (const settled of rounds) expect(failedReading(settled)).toMatch(/did not take its program/);
    // A SIGTERM that lands while expect is already exiting deadlocks it, and it never ends.
    const expectPids = readFileSync(expectPidPath, "utf8").trim().split("\n").map(Number);
    expect(expectPids).toHaveLength(10);
    for (const pid of expectPids) expect(await ends(pid), `expect ${pid} is still running`).toBe(true);
  });

  it("control: with the collector's own program, a CLI that exits at once saying nothing is a failed reading, as before", async () => {
    failedReading(await standIn("claude-pty", claudeSilent));
  });

  it("control: reads the window a CLI showed once its banner was up and /usage arrived", async () => {
    const settled = await standIn("claude-pty", claudeNormal);
    expect(settled).toMatchObject({ survived: true, settled: "resolved", sensorHealth: "HEALTHY", error: null });
    expect(settled.buckets?.map((bucket) => bucket.remainingPercent)).toEqual([77]);
  });
});

/**
 * Unit 2 kill(0), usage-collectors.ts `stop()`: it signalled `-(child.pid ?? 0)`. A child with no pid —
 * a spawn that failed — made that `kill(0)`, which signals every process in the daemon's OWN group.
 * The witnesses below replace `process.kill` with a spy that sends nothing, so a regression is seen,
 * never suffered.
 */
describe("Unit 2 kill(0): ExpectUsageTerminal signals only a process group it owns", () => {
  /** A child as Node hands one back from a failed spawn: no pid, and stdio that leads nowhere. */
  const pidlessChild = (how: { spawnError?: boolean; stdinRefuses?: boolean; prints?: string }) => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new Writable({
        write(_chunk, _encoding, callback) {
          callback(how.stdinRefuses ? Object.assign(new Error("write EPIPE"), { code: "EPIPE" }) : null);
        },
      }),
      kill: vi.fn(() => false),
    });
    if (how.spawnError) {
      process.nextTick(() =>
        child.emit("error", Object.assign(new Error("spawn /usr/bin/expect ENOENT"), { code: "ENOENT" })),
      );
    }
    if (how.prints !== undefined) setImmediate(() => child.stdout.write(how.prints));
    return child;
  };

  const runWithoutPid = async (
    child: ReturnType<typeof pidlessChild>,
    timeoutMs: number,
  ): Promise<{ result: UsageTerminalResult; kills: unknown[][]; childKills: number }> => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    spawnSeam.next = () => child;
    try {
      const result = await new ExpectUsageTerminal().run({ binary: "claude", args: [], steps: [], timeoutMs, environment: {} });
      // Room for a stdin error that lands after the result settled.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { result, kills: kill.mock.calls.map((call) => [...call]), childKills: child.kill.mock.calls.length };
    } finally {
      kill.mockRestore();
      spawnSeam.next = null;
    }
  };

  it("spawn failure, then a stdin that refuses the program: sends no signal at all and returns the spawn failure", async () => {
    const { result, kills, childKills } = await runWithoutPid(pidlessChild({ spawnError: true, stdinRefuses: true }), 5_000);
    expect(kills).toEqual([]);
    expect(childKills).toBe(0);
    expect(result).toMatchObject({ exitCode: null, timedOut: false, error: "spawn /usr/bin/expect ENOENT" });
  });

  it("no pid and the timer fires: sends no signal and keeps the timeout classification", async () => {
    const { result, kills, childKills } = await runWithoutPid(pidlessChild({}), 100);
    expect(kills).toEqual([]);
    expect(childKills).toBe(0);
    expect(result).toMatchObject({ exitCode: null, timedOut: true, error: "interactive /usage timed out" });
  });

  it("no pid and a trust prompt on screen: sends no signal and still refuses the prompt", async () => {
    const { result, kills, childKills } = await runWithoutPid(pidlessChild({ prints: "Do you trust the files in this folder?" }), 5_000);
    expect(kills).toEqual([]);
    expect(childKills).toBe(0);
    expect(result.error).toMatch(/refuses to approve/);
  });

  it("control: an owned expect group that never answers is SIGKILLed at its own group and reaped before the call returns, within the timeout", async () => {
    const pidsPath = join(home, "hung.pids");
    const hung = script("claude-hangs", `echo $PPID $$ > '${pidsPath}'\nexec sleep 30`);
    const timeoutMs = 1_100;
    const watch = watchNextSpawn();
    const kill = vi.spyOn(process, "kill");
    let result: UsageTerminalResult;
    let kills: unknown[][];
    let exitedAtReturn: boolean;
    let returnedAfterMs: number;
    const startedAt = performance.now();
    try {
      // expect's own wait is ceil(1.1 s) = 2 s, so the outer timer is what ends this run.
      result = await new ExpectUsageTerminal().run({ binary: hung, args: [], steps: [], timeoutMs, environment: process.env });
      returnedAfterMs = performance.now() - startedAt;
      exitedAtReturn = watch.exited;
      kills = kill.mock.calls.map((call) => [...call]);
    } finally {
      kill.mockRestore();
      spawnSeam.next = null;
    }
    const { pidPresent } = atReturn(watch.child?.pid);
    try {
      expect(result).toMatchObject({ exitCode: null, timedOut: true, error: "interactive /usage timed out" });
      const [expectPid, cliPid] = readFileSync(pidsPath, "utf8").trim().split(" ").map(Number);
      expect(expectPid).toBe(watch.child?.pid);
      expect(kills).toEqual([[-expectPid!, "SIGKILL"]]);
      // FIX-1148-R2: confirmed at the return, not polled for after it, and inside the unchanged timeout.
      expect(exitedAtReturn, `expect ${expectPid} had not exited when the call returned`).toBe(true);
      expect(pidPresent, `expect ${expectPid} was not reaped when the call returned`).toBe(false);
      expect(returnedAfterMs).toBeLessThan(timeoutMs);
      // The CLI is expect's child, not this probe's: it is not reaped here, only seen to end.
      expect(await ends(cliPid!), `the CLI ${cliPid} under expect is still running`).toBe(true);
    } finally {
      exactPidCleanup(existsSync(pidsPath) ? readFileSync(pidsPath, "utf8").trim().split(" ").map(Number) : []);
    }
  });
});

/** SIGKILL to exactly these pids, any still there; never a process group. */
const exactPidCleanup = (pids: ReadonlyArray<number | undefined>): void => {
  for (const pid of pids) {
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
};

/**
 * FIX-1148-R1, R1148-01: `SpawnCodexRateLimitProbe` settled on a stdin failure but kept parsing what the
 * server said afterwards, and kept its pipes. A `null` line then threw out of the stdout handler and
 * ended the caller's process; a descendant outside the killed group that held stdout kept the caller's
 * process alive past the probe's timeout.
 */
describe("FIX-1148-R1 R1148-01: the Codex probe reads nothing after it settles and lets its pipes go", () => {
  /** Takes `initialize`, shuts its stdin, answers the handshake, then writes forty thousand `null` lines. */
  const codexLateNulls = script(
    "codex-late-nulls",
    `IFS= read -r line\nexec 0<&-\nprintf '{"id":0,"result":{}}\\n'\nyes null | head -n 40000\nsleep 5`,
  );
  /** Takes every line, says things that parse but are no message, then answers the read with `null`. */
  const codexNullAnswer = script(
    "codex-null-answer",
    `IFS= read -r line\nprintf '{"id":0,"result":{}}\\n'\nIFS= read -r line\nIFS= read -r line\nprintf 'null\\n[]\\n42\\n"x"\\n{"id":1,"result":null}\\n'\nsleep 5`,
  );

  it("late `null` lines after the stdin failure settled it: the daemon stands and the reading stays the failure", async () => {
    const error = failedReading(await standIn("codex", codexLateNulls));
    expect(error).toMatch(/did not take/);
  });

  it("`null`, an array, a number, a string and a `null` result: the daemon stands and none of it is HEALTHY", async () => {
    const error = failedReading(await standIn("codex", codexNullAnswer));
    expect(error).toMatch(/returned no object/);
  });

  it("a descendant outside the killed group holds the server's stdout: the caller's process still ends with its reading", async () => {
    const holderPidPath = join(home, "holder.pid");
    const server = join(home, "codex-held-pipe.mjs");
    writeFileSync(
      server,
      `#!${NODE}
import { closeSync, readSync, writeFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
// Its own process group, so the probe's kill of the server's group does not reach it. It holds stdout.
const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
holder.unref();
writeFileSync(${JSON.stringify(holderPidPath)}, String(holder.pid));
readSync(0, Buffer.alloc(4096));
closeSync(0);
writeSync(1, '{"id":0,"result":{}}\\n');
setTimeout(() => {}, 10000);
`,
    );
    chmodSync(server, 0o755);
    // No `process.exit`: the caller ends only when nothing it owns is left open.
    const caller = join(home, "held-caller.mjs");
    writeFileSync(
      caller,
      String.raw`
const [collectorsUrl, clockUrl, binary, codexHome] = process.argv.slice(2);
const { CodexUsageCollector } = await import(collectorsUrl);
const { ManualClock } = await import(clockUrl);
const reading = await new CodexUsageCollector({ clock: new ManualClock("2026-08-13T00:00:00.000Z"), binary, timeoutMs: 1_500, codexHome }).collect();
process.stdout.write(JSON.stringify({ sensorHealth: reading.sensorHealth, buckets: reading.buckets, error: reading.error ?? null }));
`,
    );
    const started = performance.now();
    let ran: Awaited<ReturnType<typeof runBoundedChild>>;
    try {
      // The holder lives 10 s. A caller its pipe holds meets this 6 s bound, which throws.
      ran = await runBoundedChild(
        NODE,
        ["--experimental-transform-types", "--no-warnings", caller, USAGE_COLLECTORS, CLOCK, server, codexHome],
        { budgetMs: 6_000 },
      );
    } finally {
      exactPidCleanup([existsSync(holderPidPath) ? Number(readFileSync(holderPidPath, "utf8").trim()) : undefined]);
    }
    const elapsedMs = performance.now() - started;
    expect(ran.status, ran.stderr.slice(-1200)).toBe(0);
    const reading = JSON.parse(ran.stdout) as { sensorHealth: string; buckets: unknown[]; error: string | null };
    expect(reading).toMatchObject({ sensorHealth: "ERROR", buckets: [] });
    expect(reading.error).toMatch(/did not take/);
    expect(elapsedMs).toBeLessThan(4_000);
  });
});

/**
 * FIX-1148-R1, R1148-02: `ExpectUsageTerminal` resolved the moment it decided, and cleared its deadline
 * there. An `expect` that did not end on the trust prompt's SIGTERM — here one stopped just before it —
 * was never signalled again and outlived the call. Deciding and cleaning up are now two steps: the
 * call returns once the owned `expect` is confirmed exited and reaped, SIGKILLed if need be at the end
 * of the work, inside the existing deadline (FIX-1148-R2).
 */
describe("FIX-1148-R1 R1148-02: the pseudo-terminal's cleanup confirms the owned expect is gone, within the existing deadline", () => {
  const trustThenSleep = (name: string, pidsPath: string): string =>
    script(name, `echo $PPID $$ > '${pidsPath}'\nprintf 'Do you trust the files in this folder?\\n'\nexec sleep 10`);

  /** The real terminal on the real `expect`, watched from before the terminal's own listeners. */
  const runWatched = async (binary: string, timeoutMs: number, stopOnTrust: boolean) => {
    const realKill = process.kill.bind(process);
    let child: ChildProcess.ChildProcess | undefined;
    let exited = false;
    let seen = "";
    let stopped = false;
    spawnSeam.next = (real) => {
      const started = real();
      child = started;
      started.once("exit", () => {
        exited = true;
      });
      started.stdout?.on("data", (chunk: Buffer) => {
        seen += chunk.toString("utf8");
        const pid = started.pid;
        if (stopOnTrust && !stopped && seen.includes("Do you trust") && pid !== undefined && pid > 1) {
          stopped = true;
          realKill(pid, "SIGSTOP");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
      });
      return started;
    };
    const kill = vi.spyOn(process, "kill");
    const startedAt = performance.now();
    try {
      const result = await new ExpectUsageTerminal().run({ binary, args: [], steps: [], timeoutMs, environment: { PATH: "/usr/bin:/bin" } });
      const returnedAfterMs = performance.now() - startedAt;
      const exitedAtReturn = exited;
      const groupSignals = kill.mock.calls.map((call) => [...call]).filter(([pid]) => typeof pid === "number" && pid < 0);
      kill.mockRestore();
      // FIX-1148-R2: read before anything is awaited, never polled for after the return.
      const { pidPresent } = atReturn(child?.pid);
      return { result, returnedAfterMs, exitedAtReturn, pidPresentAtReturn: pidPresent, stopped, pid: child?.pid, groupSignals };
    } finally {
      kill.mockRestore();
      spawnSeam.next = null;
    }
  };

  const pidsOf = (path: string): [number | undefined, number | undefined] => {
    if (!existsSync(path)) return [undefined, undefined];
    const [expectPid, cliPid] = readFileSync(path, "utf8").trim().split(" ").map(Number);
    return [expectPid, cliPid];
  };

  it("an expect stopped before the trust prompt's SIGTERM is SIGKILLed inside the existing deadline, and exited and reaped when the call returns", async () => {
    const pidsPath = join(home, "stopped-trust.pids");
    const timeoutMs = 1_100;
    try {
      const watched = await runWatched(trustThenSleep("claude-trust-stopped", pidsPath), timeoutMs, true);
      expect(watched.stopped).toBe(true);
      expect(watched.result).toMatchObject({ exitCode: null, timedOut: false });
      expect(watched.result.error).toMatch(/refuses to approve/);
      // The trust prompt's own SIGTERM is kept; the end of the work adds the SIGKILL a stopped expect needs.
      expect(watched.groupSignals).toEqual([
        [-watched.pid!, "SIGTERM"],
        [-watched.pid!, "SIGKILL"],
      ]);
      const [expectPid, cliPid] = pidsOf(pidsPath);
      expect(expectPid).toBe(watched.pid);
      // FIX-1148-R2: the owned expect is exited and reaped at the return, inside the unchanged deadline.
      expect(watched.exitedAtReturn, `expect ${expectPid} had not exited when the call returned`).toBe(true);
      expect(watched.pidPresentAtReturn, `expect ${expectPid} was not reaped when the call returned`).toBe(false);
      expect(watched.returnedAfterMs).toBeLessThan(timeoutMs);
      // The CLI is expect's child, not this probe's: it is not reaped here, only seen to end.
      expect(await ends(cliPid!), `the CLI ${cliPid} under expect is still running`).toBe(true);
    } finally {
      exactPidCleanup(pidsOf(pidsPath));
    }
  });

  it("an expect that takes the trust prompt's SIGTERM is confirmed gone before the call returns, with no further signal", async () => {
    const pidsPath = join(home, "live-trust.pids");
    try {
      const watched = await runWatched(trustThenSleep("claude-trust-live", pidsPath), 5_000, false);
      expect(watched.result.error).toMatch(/refuses to approve/);
      expect(watched.groupSignals).toEqual([[-watched.pid!, "SIGTERM"]]);
      expect(watched.exitedAtReturn).toBe(true);
      expect(watched.pidPresentAtReturn).toBe(false);
      const [, cliPid] = pidsOf(pidsPath);
      expect(await ends(cliPid!), `the CLI ${cliPid} under expect is still running`).toBe(true);
    } finally {
      exactPidCleanup(pidsOf(pidsPath));
    }
  });
});

/**
 * FIX-1148-R2, R1148-02 and its Codex sibling: both probes returned at their decision, or at the
 * deadline's SIGKILL, with the owned child still there; it exited 0.5 to 2.6 ms after the return. The
 * existing timeout is now split, not extended: the work ends a reserve before it, and the call returns
 * once the owned child is exited and reaped, or at the deadline with a cleanup failure that says so.
 */
describe("FIX-1148-R2: a probe returns only once its owned child is exited and reaped, inside the unchanged timeout", () => {
  const clock = () => new ManualClock("2026-08-13T00:00:00.000Z");
  /** Takes nothing and answers nothing, until its group is killed. */
  const codexHangs = script("codex-hangs", "exec sleep 10");

  const collectWatched = async (binary: string, timeoutMs: number) => {
    const watch = watchNextSpawn();
    const startedAt = performance.now();
    try {
      const reading = await new CodexUsageCollector({ clock: clock(), binary, timeoutMs, codexHome }).collect();
      const returnedAfterMs = performance.now() - startedAt;
      const exitedAtReturn = watch.exited;
      const { pidPresent } = atReturn(watch.child?.pid);
      return { reading, returnedAfterMs, exitedAtReturn, pidPresentAtReturn: pidPresent, pid: watch.child?.pid };
    } finally {
      spawnSeam.next = null;
    }
  };

  it.each([
    { name: "answers the read", binary: () => codexNormal, health: "HEALTHY", error: null },
    { name: "shuts its stdin before the read", binary: () => codexShutsStdin, health: "ERROR", error: /did not take/ },
    { name: "never answers", binary: () => codexHangs, health: "ERROR", error: /did not answer in time/ },
  ])("Codex probe, a server that $name: its server is exited and reaped when the call returns", async ({ binary, health, error }) => {
    const timeoutMs = 2_000;
    let watched: Awaited<ReturnType<typeof collectWatched>> | undefined;
    try {
      watched = await collectWatched(binary(), timeoutMs);
      expect(watched.reading.sensorHealth).toBe(health);
      if (error === null) expect(watched.reading.error ?? null).toBeNull();
      else expect(watched.reading.error).toMatch(error);
      expect(watched.exitedAtReturn, `codex app-server ${watched.pid} had not exited when the call returned`).toBe(true);
      expect(watched.pidPresentAtReturn, `codex app-server ${watched.pid} was not reaped when the call returned`).toBe(false);
      expect(watched.returnedAfterMs).toBeLessThan(timeoutMs);
    } finally {
      exactPidCleanup([watched?.pid]);
    }
  });

  /** Above any pid this kernel hands out. `process.kill` is stubbed throughout, so it is never signalled. */
  const FAKE_PID = 2 ** 30;
  /** A child the OS never reports gone: a pid, pipes, and no `exit`, ever. */
  const neverExitingChild = (onLine?: (line: string, stdout: PassThrough) => void) => {
    const stdout = new PassThrough();
    return Object.assign(new EventEmitter(), {
      pid: FAKE_PID,
      stdout,
      stderr: new PassThrough(),
      stdin: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          for (const line of chunk.toString("utf8").split("\n")) if (line.trim() !== "") onLine?.(line, stdout);
          callback(null);
        },
      }),
      kill: vi.fn(() => true),
    });
  };

  const withoutConfirmation = async <T>(child: ReturnType<typeof neverExitingChild>, run: () => Promise<T>) => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    spawnSeam.next = () => child;
    const startedAt = performance.now();
    try {
      const value = await run();
      const returnedAfterMs = performance.now() - startedAt;
      return { value, returnedAfterMs, kills: kill.mock.calls.map((call) => [...call]) };
    } finally {
      kill.mockRestore();
      spawnSeam.next = null;
    }
  };

  const CLEANUP_FAILED = new RegExp(`^cleanup failed: the owned (expect|codex app-server) \\(pid ${FAKE_PID}\\) was sent SIGKILL, but its exit was not confirmed by the deadline`);

  it("expect: a decided trust refusal whose expect the OS never confirms gone returns at the deadline as a cleanup failure, not as the refusal alone", async () => {
    const timeoutMs = 400;
    const child = neverExitingChild();
    setImmediate(() => child.stdout.write("Do you trust the files in this folder?\n"));
    const { value: result, returnedAfterMs, kills } = await withoutConfirmation(child, () =>
      new ExpectUsageTerminal().run({ binary: "claude", args: [], steps: [], timeoutMs, environment: {} }),
    );
    expect(result.error).toMatch(CLEANUP_FAILED);
    expect(result.error).toMatch(/refuses to approve/);
    expect(kills).toEqual([
      [-FAKE_PID, "SIGTERM"],
      [-FAKE_PID, "SIGKILL"],
    ]);
    // It waited through the reserve for the exit, and no further than the unchanged deadline.
    expect(returnedAfterMs).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(returnedAfterMs).toBeLessThan(timeoutMs + 100);
  });

  it("expect, through the collector: a run that timed out and whose expect is never confirmed gone is an ERROR reading naming the cleanup failure", async () => {
    const timeoutMs = 400;
    const child = neverExitingChild();
    const { value: reading, returnedAfterMs } = await withoutConfirmation(child, () =>
      new ClaudeUsageCollector({ clock: clock(), binary: "claude", timeoutMs, terminal: new ExpectUsageTerminal() }).collect(),
    );
    expect(reading).toMatchObject({ sensorHealth: "ERROR", buckets: [] });
    expect(reading.error).toMatch(CLEANUP_FAILED);
    expect(reading.error).toMatch(/timed out/);
    expect(returnedAfterMs).toBeLessThan(timeoutMs + 100);
  });

  it("Codex: an answer read from a server the OS never confirms gone is an ERROR reading naming the cleanup failure, never HEALTHY", async () => {
    const timeoutMs = 400;
    const child = neverExitingChild((line, stdout) => {
      const { id } = JSON.parse(line) as { id?: number };
      if (id === 0) setImmediate(() => stdout.write('{"id":0,"result":{}}\n'));
      if (id === 1) setImmediate(() => stdout.write(`${READ_ANSWER.replace("%s", "23")}\n`));
    });
    const { value: reading, returnedAfterMs, kills } = await withoutConfirmation(child, () =>
      new CodexUsageCollector({ clock: clock(), binary: "codex", timeoutMs, codexHome }).collect(),
    );
    expect(reading).toMatchObject({ sensorHealth: "ERROR", buckets: [] });
    expect(reading.error).toMatch(CLEANUP_FAILED);
    expect(reading.error).toMatch(/an answer was read/);
    expect(kills).toEqual([[-FAKE_PID, "SIGKILL"]]);
    expect(returnedAfterMs).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(returnedAfterMs).toBeLessThan(timeoutMs + 100);
  });

  /**
   * The same rule on `SpawnNonInteractiveUsageProbe`, the daemon's Claude path: on its timeout it sent
   * SIGKILL and returned at once, before the CLI's exit. `exit` is taken as proof that the DIRECT child
   * ended and was reaped, never that its descendants did.
   */
  const NI_RESULT = [
    "Current session: 12% used · resets Aug 18 at 7:49pm (Asia/Seoul)",
    "Current week (all models): 64% used · resets Aug 21 at 4:59am (Asia/Seoul)",
  ].join("\n");
  const NI_ENVELOPE = JSON.stringify({ is_error: false, num_turns: 0, total_cost_usd: 0, result: NI_RESULT });

  it("non-interactive Claude probe, a CLI that never answers: the CLI is exited and reaped when the call returns, inside the timeout", async () => {
    const pidPath = join(home, "ni-hung.pid");
    const hung = script("claude-ni-hangs", `echo $ > '${pidPath}'\nexec sleep 30`);
    const timeoutMs = 1_000;
    const watch = watchNextSpawn();
    const startedAt = performance.now();
    try {
      const reading = await new ClaudeUsageCollector({ clock: clock(), binary: hung, timeoutMs, accountIdentity: null }).collect();
      const returnedAfterMs = performance.now() - startedAt;
      const exitedAtReturn = watch.exited;
      const { pidPresent } = atReturn(watch.child?.pid);
      expect(reading).toMatchObject({ sensorHealth: "ERROR", buckets: [] });
      expect(reading.error).toBe("non-interactive /usage did not finish in time");
      expect(exitedAtReturn, `the CLI ${watch.child?.pid} had not exited when the call returned`).toBe(true);
      expect(pidPresent, `the CLI ${watch.child?.pid} was not reaped when the call returned`).toBe(false);
      expect(returnedAfterMs).toBeLessThan(timeoutMs);
    } finally {
      spawnSeam.next = null;
      exactPidCleanup([watch.child?.pid, existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8").trim()) : undefined]);
    }
  });

  it("non-interactive control: a CLI that answers and exits while a descendant in another group holds its stdout is read HEALTHY at its exit, not held to a timeout, its pipes let go while the holder lives", async () => {
    const holderPidPath = join(home, "ni-holder.pid");
    const cli = join(home, "claude-ni-held.mjs");
    writeFileSync(
      cli,
      `#!${NODE}
import { spawn } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";
// Its own process group, so the probe's kill of the CLI's group does not reach it. It holds stdout.
const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
holder.unref();
writeFileSync(${JSON.stringify(holderPidPath)}, String(holder.pid));
writeSync(1, ${JSON.stringify(NI_ENVELOPE)});
process.exit(0);
`,
    );
    chmodSync(cli, 0o755);
    const timeoutMs = 4_000;
    const watch = watchNextSpawn();
    const startedAt = performance.now();
    try {
      const reading = await new ClaudeUsageCollector({ clock: clock(), binary: cli, timeoutMs, accountIdentity: null }).collect();
      const returnedAfterMs = performance.now() - startedAt;
      // FIX-1148-R3 — read at the return, before anything is awaited or the holder is touched.
      const owned = watch.child!;
      const released = {
        stdoutDestroyed: owned.stdout!.destroyed,
        stderrDestroyed: owned.stderr!.destroyed,
        stdoutDataListeners: owned.stdout!.listenerCount("data"),
        stderrDataListeners: owned.stderr!.listenerCount("data"),
      };
      const holderPid = Number(readFileSync(holderPidPath, "utf8").trim());
      expect(watch.exited).toBe(true);
      expect(reading.sensorHealth, reading.error ?? "").toBe("HEALTHY");
      expect(reading.buckets).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "current-session", remainingPercent: 88 })]),
      );
      // Returned at the CLI's exit: the held pipe's `close` is not waited for, and the work's end is far off.
      expect(returnedAfterMs).toBeLessThan(timeoutMs - cleanupReserveCap);
      // The pipes were let go by the probe, not by the holder going: the holder is still there.
      expect(alive(holderPid), `holder ${holderPid} was gone before the check, so it proves nothing`).toBe(true);
      expect(released).toEqual({ stdoutDestroyed: true, stderrDestroyed: true, stdoutDataListeners: 0, stderrDataListeners: 0 });
    } finally {
      spawnSeam.next = null;
      exactPidCleanup([existsSync(holderPidPath) ? Number(readFileSync(holderPidPath, "utf8").trim()) : undefined]);
    }
  });

  /**
   * FIX-1148-R3, R1148-04: `SpawnNonInteractiveUsageProbe` returned HEALTHY at its CLI's exit but kept
   * its pipes and their `data` handlers. A detached descendant that inherited one kept the caller's
   * process alive long after its 1 s timeout; killing the holder is what let it end. Here the holder
   * outlives every bound and is checked alive when the caller ends: the caller ends by itself or not at all.
   */
  it.each([{ held: "stdout" }, { held: "stderr" }])(
    "FIX-1148-R3 R1148-04: the CLI answered and exited while a detached descendant still holds its $held: the caller's process ends by itself, the holder still alive",
    async ({ held }) => {
      const holderPidPath = join(home, `ni-natural-${held}.pid`);
      const cli = join(home, `claude-ni-natural-${held}.mjs`);
      const holderStdio = JSON.stringify(["ignore", held === "stdout" ? "inherit" : "ignore", held === "stderr" ? "inherit" : "ignore"]);
      writeFileSync(
        cli,
        `#!${NODE}
import { spawn } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";
// Its own process group, so the probe's kill of the CLI's group does not reach it. It outlives every bound here.
const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: ${holderStdio} });
holder.unref();
writeFileSync(${JSON.stringify(holderPidPath)}, String(holder.pid));
writeSync(1, ${JSON.stringify(NI_ENVELOPE)});
process.exit(0);
`,
      );
      chmodSync(cli, 0o755);
      // No `process.exit`: the caller ends only when nothing it owns is left open.
      const caller = join(home, "ni-natural-caller.mjs");
      writeFileSync(
        caller,
        String.raw`
const [collectorsUrl, clockUrl, binary] = process.argv.slice(2);
const { ClaudeUsageCollector } = await import(collectorsUrl);
const { ManualClock } = await import(clockUrl);
const reading = await new ClaudeUsageCollector({ clock: new ManualClock("2026-08-13T00:00:00.000Z"), binary, timeoutMs: 1_000, accountIdentity: null }).collect();
process.stdout.write(JSON.stringify({ sensorHealth: reading.sensorHealth, buckets: reading.buckets, error: reading.error ?? null }));
`,
      );
      const startedAt = performance.now();
      try {
        // The holder lives 20 s. A caller its pipe holds meets this 6 s bound, which throws.
        const ran = await runBoundedChild(
          NODE,
          ["--experimental-transform-types", "--no-warnings", caller, USAGE_COLLECTORS, CLOCK, cli],
          { budgetMs: 6_000 },
        );
        const elapsedMs = performance.now() - startedAt;
        // Read the moment the caller has ended, before any cleanup: the holder had not gone.
        const holderPid = Number(readFileSync(holderPidPath, "utf8").trim());
        expect(alive(holderPid), `holder ${holderPid} was gone when the caller ended, so it proves nothing`).toBe(true);
        expect(ran.status, ran.stderr.slice(-1200)).toBe(0);
        const reading = JSON.parse(ran.stdout) as { sensorHealth: string; buckets: unknown[]; error: string | null };
        expect(reading).toMatchObject({ sensorHealth: "HEALTHY", error: null });
        expect(reading.buckets).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "current-session", remainingPercent: 88 })]),
        );
        expect(elapsedMs).toBeLessThan(4_000);
      } finally {
        exactPidCleanup([existsSync(holderPidPath) ? Number(readFileSync(holderPidPath, "utf8").trim()) : undefined]);
      }
    },
  );

  it("non-interactive, short timeouts with no owned pid: the work and cleanup budgets stay valid, the call returns timed out, and nothing is signalled", async () => {
    for (const timeoutMs of [1, 3, 4, 10]) {
      // A child as Node hands one back from a failed spawn: no pid, so there is no group to signal.
      const child = neverExitingChild();
      Reflect.set(child, "pid", undefined);
      const { value: outcome, returnedAfterMs, kills } = await withoutConfirmation(child, () =>
        new SpawnNonInteractiveUsageProbe(CLAUDE_NON_INTERACTIVE_ARGS).run({ binary: "claude", timeoutMs }),
      );
      expect(outcome, `timeout ${timeoutMs}`).toMatchObject({ code: null, timedOut: true });
      expect(outcome.cleanupError).toBeUndefined();
      expect(kills).toEqual([]);
      expect(child.kill).not.toHaveBeenCalled();
      expect(returnedAfterMs).toBeLessThan(timeoutMs + 100);
    }
  });

  it("non-interactive: a full answer from a CLI the OS never confirms gone is an ERROR reading naming the cleanup failure at the deadline, never HEALTHY", async () => {
    const timeoutMs = 400;
    const child = neverExitingChild();
    setImmediate(() => child.stdout.write(NI_ENVELOPE));
    const { value: reading, returnedAfterMs, kills } = await withoutConfirmation(child, () =>
      new ClaudeUsageCollector({ clock: clock(), binary: "claude", timeoutMs, accountIdentity: null }).collect(),
    );
    expect(reading).toMatchObject({ sensorHealth: "ERROR", buckets: [] });
    expect(reading.error).toMatch(
      new RegExp(
        `^non-interactive /usage cleanup failed: the owned non-interactive /usage CLI \\(pid ${FAKE_PID}\\) was sent SIGKILL, but its exit was not confirmed by the deadline`,
      ),
    );
    expect(kills).toEqual([[-FAKE_PID, "SIGKILL"]]);
    // It did not wait for an exit that never came: it returned at the unchanged deadline.
    expect(returnedAfterMs).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(returnedAfterMs).toBeLessThan(timeoutMs + 100);
  });
});

/**
 * FIX-1148-R1, R1148-03: the collector's own small program. A CLI that printed a plausible quota line
 * and exited before its banner made `expect` exit 125 (eof in a step's wait); `finish` on stdin had
 * marked the program taken and the reader ignored `exitCode`, so the reading was HEALTHY at 77%.
 */
describe("FIX-1148-R1 R1148-03: a terminal that did not finish its program is never read as quota", () => {
  const clock = () => new ManualClock("2026-08-13T00:00:00.000Z");
  /** No pid recording here: the 10-round witness above counts its own `expect`s from its own file. */
  const quotaThenExit = script("cli-quota-then-exit", `printf '5-hour limit: 77%% remaining - resets in 2h\\n'\nexit 0`);
  const QUOTA_LINE = "5-hour limit: 77% remaining - resets in 2h\n";

  it.each([
    { name: "Claude", Collector: ClaudeUsageCollector },
    { name: "Codex (configured terminal)", Collector: CodexUsageCollector },
  ])("$name, with the collector's unchanged program: expect exits 125 and the reading is a failure, not 77 percent", async ({ Collector }) => {
    const real = new ExpectUsageTerminal();
    const seen: UsageTerminalResult[] = [];
    const terminal: UsageTerminal = {
      async run(input) {
        const result = await real.run(input);
        seen.push(result);
        return result;
      },
    };
    const reading = await new Collector({ clock: clock(), binary: quotaThenExit, timeoutMs: 3_000, terminal }).collect();
    expect(reading).toMatchObject({ sensorHealth: "ERROR", buckets: [] });
    expect(reading.error).toMatch(/exited 125/);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ exitCode: 125, timedOut: false });
    expect(seen[0]!.stdout).toContain("77% remaining");
    expect(seen[0]!.error).toMatch(/exited 125/);
  });

  it("the reader refuses any terminal's non-zero or missing exit before parsing, whatever it printed", async () => {
    for (const exitCode of [125, 1, null]) {
      const terminal: UsageTerminal = {
        async run() {
          return { stdout: QUOTA_LINE, stderr: "", exitCode, timedOut: false, error: null };
        },
      };
      const reading = await new ClaudeUsageCollector({ clock: clock(), binary: "claude", terminal }).collect();
      expect(reading, `exit ${exitCode}`).toMatchObject({ sensorHealth: "ERROR", buckets: [] });
      expect(reading.error).toMatch(/not read as quota/);
    }
  });

  it("control: the same output from a terminal that ended 0 is still read", async () => {
    const terminal: UsageTerminal = {
      async run() {
        return { stdout: QUOTA_LINE, stderr: "", exitCode: 0, timedOut: false, error: null };
      },
    };
    const reading = await new ClaudeUsageCollector({ clock: clock(), binary: "claude", terminal }).collect();
    expect(reading).toMatchObject({ sensorHealth: "HEALTHY" });
    expect(reading.buckets.map((bucket) => bucket.remainingPercent)).toEqual([77]);
  });
});
