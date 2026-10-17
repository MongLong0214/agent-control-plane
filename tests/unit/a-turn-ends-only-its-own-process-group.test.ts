import type * as ChildProcessModule from "node:child_process";
import type * as ProcessArgvModule from "../../src/core/process-argv.ts";
import { execFileSync, spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ACP_SCRATCH_ROOT } from "../../src/core/scratch-root.ts";
import { ClaudeCliAdapter, __testing } from "../../src/runtime/cli-adapters.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { requireSeatbelt } from "../helpers/seatbelt.ts";

/**
 * #1104 — a worker or CTO turn owns what its CLI leaves in its process group, and ends that group on
 * every completion, a normal exit included. It signals a group only with the ownership proof: the
 * group is the one the turn's own spawn created, its leader is still ACP's unreaped child, and the
 * leader's start token reads back as it did at spawn. A shared group, an external process and a pid
 * whose start token no longer matches each get no signal at all.
 *
 * #1105 — a probe group observed empty in time but answered late is reported as a late completion,
 * never as a negative overrun.
 *
 * HOME points at a private directory before anything is imported, so the scratch root and every
 * profile follow it and the live daemon's state is never touched. Every process these rows start
 * carries a marker of its own, and only processes carrying one are ever killed by the test.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-turn-group-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});

/** How the adapter's start-token reads answer: as the kernel does, or differently once the turn has spawned. */
const tokenRead = vi.hoisted(() => ({ mode: "native" as "native" | "mismatch-after-spawn", spawned: false }));
vi.mock("../../src/core/process-argv.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessArgvModule>();
  return {
    ...actual,
    readProcessStartToken: (pid: number): string | null => {
      const token = actual.readProcessStartToken(pid);
      if (tokenRead.mode === "mismatch-after-spawn" && tokenRead.spawned && token !== null) return `${token}0`;
      return token;
    },
  };
});

const markers: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  tokenRead.mode = "native";
  tokenRead.spawned = false;
  for (const marker of markers.splice(0)) killMarked(marker);
});
afterAll(() => {
  cleanupTempDirs();
  rmSync(isolatedHome, { recursive: true, force: true });
});

const marker = (kind: string): string => {
  const value = `acp-turn-group-${kind}-${randomUUID()}`;
  markers.push(value);
  return value;
};

/** Live processes whose command line names `value`, read from `ps` rather than from ACP's records. */
const processesNaming = (value: string): string[] =>
  execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 10_000 })
    .split("\n")
    .filter((line) => line.includes(value));

/** Kills only processes carrying this test's own marker: a RED run must not leave its leak behind. */
const killMarked = (value: string): void => {
  for (const line of processesNaming(value)) {
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
};

/** Kills the live members of a group this test observed its own turn create. */
const killGroupMembers = (pgid: number): void => {
  const lines = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 10_000 }).split("\n");
  for (const line of lines) {
    const [pid, group, stat] = line.trim().split(/\s+/);
    if (Number(group) === pgid && stat !== undefined && !stat.startsWith("Z")) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const waitFor = async (condition: () => boolean, boundMs: number): Promise<boolean> => {
  const deadline = Date.now() + boundMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
};

/**
 * A `claude` stand-in that starts an owned descendant in its own group and an intended long-lived
 * child that leaves the group (`detached`, so `setsid`), reports both pids in its answer, and exits 0
 * as a turn's CLI does. `holdPipes` gives the owned descendant the CLI's stdout and stderr instead.
 */
const cliLeavingChildren = (dir: string, owned: string, longLived: string, holdPipes = false): string => {
  const binary = join(dir, `claude-leaves-children-${randomUUID()}.cjs`);
  writeFileSync(binary, `#!${process.execPath}
const { spawn } = require("node:child_process");
const owned = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ${JSON.stringify(owned)}], { stdio: ${holdPipes ? '["ignore", "inherit", "inherit"]' : '"ignore"'} });
owned.unref();
const longLived = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ${JSON.stringify(longLived)}], { stdio: "ignore", detached: true });
longLived.unref();
const report = { owned: owned.pid, longLived: longLived.pid };
process.stdout.write(JSON.stringify({ type: "result", session_id: null, result: JSON.stringify(report) }), () => process.exit(0));
`);
  chmodSync(binary, 0o700);
  return binary;
};

/** A process of the test's own, outside any turn: it must still be running after every turn. */
const startBystander = (value: string, detached: boolean): ChildProcessModule.ChildProcess => {
  const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)", value], { stdio: "ignore", detached });
  child.unref();
  return child;
};

/** Every group signal ACP's code sends (a negative pid with a real signal), and, optionally, a faked spawn-time group check. */
const watchGroupSignals = (options: { firstGroupCheck?: "ESRCH" } = {}) => {
  const nativeKill = process.kill.bind(process);
  const groupSignals: { pgid: number; signal: string | number }[] = [];
  let checks = 0;
  const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if (pid < 0 && signal !== 0 && signal !== undefined) groupSignals.push({ pgid: -pid, signal });
    if (pid < 0 && signal === 0) {
      checks += 1;
      if (checks === 1 && options.firstGroupCheck === "ESRCH") {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH", errno: -3, syscall: "kill" });
      }
    }
    return nativeKill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill);
  return { groupSignals, restore: () => spy.mockRestore() };
};

const adapterFor = (binary: string, dir: string): ClaudeCliAdapter =>
  new ClaudeCliAdapter({ clock: { nowIso: () => "2026-10-17T00:00:00.000Z" } as never, capacityFile: join(dir, "capacity.fixture"), binary });

describe("#1104 a turn ends its own process group on a normal exit, and nothing else", () => {
  it("RED/GREEN: a turn whose CLI exits 0 leaves no owned descendant; an intended long-lived child and two bystanders survive", async (ctx) => {
    requireSeatbelt(ctx);
    expect(ACP_SCRATCH_ROOT.startsWith(`${isolatedHome}/`)).toBe(true);
    const dir = tempDir("acp-turn-group-");
    const owned = marker("owned");
    const longLived = marker("long-lived");
    const ownGroupBystander = startBystander(marker("bystander-own-group"), true);
    const sharedGroupBystander = startBystander(marker("bystander-test-group"), false);
    const watch = watchGroupSignals();
    let leader: number | null = null;
    try {
      const result = await adapterFor(cliLeavingChildren(dir, owned, longLived), dir).invoke({
        prompt: "Reply.", workdir: dir, timeoutMs: 30_000, readOnly: true, correlationId: "turn-normal-exit",
        onSpawn: (pid) => {
          leader = pid;
        },
      });
      const report = JSON.parse(result.text) as { owned: number; longLived: number };
      const ownedGone = await waitFor(() => !alive(report.owned), 3_000);
      const observed = {
        ok: result.ok,
        exitCode: result.exitCode,
        leader,
        groupSignals: watch.groupSignals,
        ownedAlive: !ownedGone,
        longLivedAlive: alive(report.longLived),
        bystanders: [alive(ownGroupBystander.pid!), alive(sharedGroupBystander.pid!)],
        processesNamingOwned: processesNaming(owned),
      };
      console.error(`WITNESS turn-normal-exit ${JSON.stringify(observed)}`);
      expect(result.exitCode).toBe(0);
      // The owned descendant is gone, by pid and by its marker.
      expect(observed.ownedAlive).toBe(false);
      expect(observed.processesNamingOwned).toEqual([]);
      // What left the group, and what was never in it, is untouched.
      expect(observed.longLivedAlive).toBe(true);
      expect(observed.bystanders).toEqual([true, true]);
      // Every group signal went to the turn's own group, and none to anything else.
      expect(leader).not.toBeNull();
      expect(observed.groupSignals.length).toBeGreaterThan(0);
      expect(observed.groupSignals.every((sent) => sent.pgid === leader)).toBe(true);
      expect(observed.groupSignals.some((sent) => sent.pgid === ownGroupBystander.pid || sent.pgid === process.pid)).toBe(false);
    } finally {
      watch.restore();
    }
  });

  it("a CTO session turn and every non-reviewer invoke run under the holder; a packet reviewer does not", async () => {
    const seen: Array<boolean | undefined> = [];
    __testing.setRunCli(async (_file, _args, options) => {
      seen.push(options.reapProcessGroup);
      return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false, isolationEnforced: false };
    });
    try {
      const dir = tempDir("acp-turn-group-options-");
      const adapter = adapterFor(process.execPath, dir);
      await adapter.invoke({ prompt: "x", workdir: dir, timeoutMs: 1_000, readOnly: true, correlationId: "read-only-turn" });
      await adapter.runSessionTurn({
        handle: { externalSessionId: randomUUID(), provider: "claude", model: "opus", effort: null, pid: null, workdir: dir },
        prompt: "x",
        timeoutMs: 1_000,
        conversation: "new",
      } as Parameters<ClaudeCliAdapter["runSessionTurn"]>[0]);
      expect(seen).toEqual([true, true]);
    } finally {
      __testing.setRunCli(null);
    }
  });
});

describe("#1104 (CEO ruling) no foreign signal: a shared group, an external process, a reused pid", () => {
  it("RED/GREEN: a holder with no group of its own at spawn (a shared group) gets no group signal at all", async (ctx) => {
    requireSeatbelt(ctx);
    const dir = tempDir("acp-turn-group-shared-");
    const owned = marker("owned-shared");
    const watch = watchGroupSignals({ firstGroupCheck: "ESRCH" });
    let leader: number | null = null;
    try {
      const result = await __testing.productionRunCli(cliLeavingChildren(dir, owned, marker("long-lived-shared")), [], {
        cwd: undefined,
        timeoutMs: 30_000,
        reapProcessGroup: true,
        onSpawn: (pid) => {
          leader = pid;
        },
      });
      console.error(`WITNESS shared-group ${JSON.stringify({ groupSignals: watch.groupSignals, processGroup: result.processGroup })}`);
      expect(watch.groupSignals).toEqual([]);
      expect(result.processGroup).toMatchObject({ reaped: false, signalled: false, signals: [], ownership: "UNVERIFIABLE" });
      expect(result.processGroup!.detail).toContain("no group of its own was present at spawn");
    } finally {
      watch.restore();
      if (leader !== null) killGroupMembers(leader);
    }
  });

  it("a pid whose start token no longer matches (a reused pid) gets no group signal, and its processes are left", async (ctx) => {
    requireSeatbelt(ctx);
    const dir = tempDir("acp-turn-group-reuse-");
    const owned = marker("owned-reuse");
    const watch = watchGroupSignals();
    tokenRead.mode = "mismatch-after-spawn";
    let leader: number | null = null;
    try {
      const result = await adapterFor(cliLeavingChildren(dir, owned, marker("long-lived-reuse")), dir).invoke({
        prompt: "Reply.", workdir: dir, timeoutMs: 30_000, readOnly: true, correlationId: "turn-reused-pid",
        onSpawn: (pid) => {
          leader = pid;
          tokenRead.spawned = true;
        },
      });
      const report = JSON.parse(result.text) as { owned: number };
      console.error(`WITNESS reused-pid ${JSON.stringify({ groupSignals: watch.groupSignals, ownedAlive: alive(report.owned) })}`);
      expect(result.exitCode).toBe(0);
      expect(watch.groupSignals).toEqual([]);
      // Left as it was, because nothing proved it the turn's: the test removes it below.
      expect(alive(report.owned)).toBe(true);
    } finally {
      watch.restore();
      if (leader !== null) killGroupMembers(leader);
    }
  });

  it("RED/GREEN: without a holder, a timeout after the leader has exited sends no group signal and still answers", async (ctx) => {
    requireSeatbelt(ctx);
    const dir = tempDir("acp-turn-group-no-holder-");
    const owned = marker("owned-pipes");
    const bystander = startBystander(marker("bystander-no-holder"), true);
    const watch = watchGroupSignals();
    try {
      // The CLI exits at once; its descendant keeps the pipes, so only the timeout can end the wait.
      const result = await __testing.productionRunCli(cliLeavingChildren(dir, owned, marker("long-lived-pipes"), true), [], {
        cwd: undefined,
        timeoutMs: 1_500,
      });
      const ownedPids = processesNaming(owned).map((line) => Number(line.trim().split(/\s+/)[0]));
      console.error(`WITNESS no-holder-timeout ${JSON.stringify({ timedOut: result.timedOut, groupSignals: watch.groupSignals, ownedPids })}`);
      expect(result.timedOut).toBe(true);
      expect(watch.groupSignals).toEqual([]);
      expect(alive(bystander.pid!)).toBe(true);
    } finally {
      watch.restore();
    }
  });
});

describe("#1105 a probe group seen empty in time but answered late is a late completion", () => {
  /**
   * The answer is computed on `performance.now()`. These rows move that clock forward 2.5 s from a
   * chosen reading on, as a stalled event loop would: from the ESRCH reading itself (a late
   * observation), or only from the reading after it (an in-time observation, a late completion).
   */
  const skewAfterEsrch = (from: "observation" | "completion") => {
    const nativeKill = process.kill.bind(process);
    const nativeNow = performance.now.bind(performance);
    const state = { esrchSeen: false, readsAfter: 0 };
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      try {
        return nativeKill(pid, signal as NodeJS.Signals);
      } catch (error) {
        if (pid < 0 && signal === 0 && (error as NodeJS.ErrnoException).code === "ESRCH") state.esrchSeen = true;
        throw error;
      }
    }) as typeof process.kill);
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      if (!state.esrchSeen) return nativeNow();
      state.readsAfter += 1;
      const skewed = from === "observation" || state.readsAfter > 1;
      return nativeNow() + (skewed ? 2_500 : 0);
    });
    return { restore: () => { killSpy.mockRestore(); nowSpy.mockRestore(); } };
  };

  const completingCli = (dir: string): string => {
    const binary = join(dir, "claude-completes.cjs");
    writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write("done", () => process.exit(0));\n`);
    chmodSync(binary, 0o700);
    return binary;
  };

  it("RED/GREEN: an ESRCH before the deadline and a completion after it reads as a late completion, with no negative number", async (ctx) => {
    requireSeatbelt(ctx);
    const clock = skewAfterEsrch("completion");
    try {
      const result = await __testing.productionRunCli(completingCli(tempDir("acp-late-completion-")), [], {
        cwd: undefined, timeoutMs: 30_000, reapProcessGroup: true,
      });
      const detail = result.processGroup?.detail ?? "";
      console.error(`WITNESS late-completion ${JSON.stringify(result.processGroup)}`);
      expect(result.processGroup).toMatchObject({ reaped: false, ownership: "HELD" });
      expect(detail).toMatch(/was observed empty \(ESRCH\) \d+ ms before the deadline, but the probe's answer completed \d+ ms after it/);
      expect(detail).not.toMatch(/-\d/);
    } finally {
      clock.restore();
    }
  });

  it("control: an ESRCH first seen after the deadline keeps its late-observation wording", async (ctx) => {
    requireSeatbelt(ctx);
    const clock = skewAfterEsrch("observation");
    try {
      const result = await __testing.productionRunCli(completingCli(tempDir("acp-late-observation-")), [], {
        cwd: undefined, timeoutMs: 30_000, reapProcessGroup: true,
      });
      const detail = result.processGroup?.detail ?? "";
      console.error(`WITNESS late-observation ${JSON.stringify(result.processGroup)}`);
      expect(result.processGroup).toMatchObject({ reaped: false, ownership: "HELD" });
      expect(detail).toMatch(/process group \d+ was first observed empty \d+ ms after the deadline/);
      expect(detail).not.toMatch(/-\d/);
    } finally {
      clock.restore();
    }
  });
});
