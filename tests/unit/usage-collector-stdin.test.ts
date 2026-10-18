import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runBoundedChild } from "../helpers/bounded-child.ts";
import { CHILD_BUDGET_MS } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

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
