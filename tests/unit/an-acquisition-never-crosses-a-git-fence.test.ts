import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

/**
 * #1070 ACP-WORKER-03-FC, narrow review 3 — no acquisition crosses a stopped daemon's git fence,
 * whichever way "the predecessor writes its fence and exits" interleaves with "the successor reads the
 * fence / reads the holder / reclaims / installs"; and a fence that names no group stands.
 *
 * The predecessor is a real process: real `Daemon.stop()` with an unconfirmed result naming a real,
 * paused mutation group, the fence written, exit 75. The successor runs here and is paused at a chosen
 * step of `acquire()`; at that pause the predecessor is told to stop, and the successor resumes only
 * once the predecessor has exited.
 */
afterAll(cleanupTempDirs);

/**
 * Run after each case. A group is signalled only while its predecessor has not reported its exit:
 * after that the group is empty and its id may belong to anyone. A mutator is ended through its
 * release file rather than its group id, so it ends even when its group was never reported.
 */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Gone only on ESRCH: on macOS a group whose last member is an unreaped zombie answers EPERM, and the
// lock (rightly) still counts it.
const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
};

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 120_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Blocks this process — as an acquisition in progress would be — until `file` exists and `pid` is gone. */
const blockUntilExited = (file: string, pid: number): void => {
  const waited = spawnSync(process.execPath, ["-e", `
    const fs = require("node:fs");
    const until = Date.now() + 120000;
    const nap = new Int32Array(new SharedArrayBuffer(4));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    while (!fs.existsSync(process.argv[1]) || alive(Number(process.argv[2]))) {
      if (Date.now() > until) process.exit(2);
      Atomics.wait(nap, 0, 0, 10);
    }
  `, file, String(pid)], { timeout: 130_000 });
  if (waited.status !== 0) throw new Error(`the predecessor did not stop: ${String(waited.status)}`);
};

/** A predecessor daemon holding the lock, with a real paused mutation group it will report unconfirmed. */
const predecessor = async () => {
  const repo = makeRepo({ "README.md": "base\n" });
  const base = gitSync(repo, ["rev-parse", "HEAD"]);
  const branch = gitSync(repo, ["symbolic-ref", "--short", "HEAD"]);
  writeFileSync(join(repo, "README.md"), "next\n");
  commitAll(repo, "next");
  const target = gitSync(repo, ["rev-parse", "HEAD"]);
  gitSync(repo, ["update-ref", `refs/heads/${branch}`, base, target]);
  const state = tempDir("acp-fence-interleave-");
  const files = {
    release: join(state, "release"), ready: join(state, "ready"), stop: join(state, "stop"),
    stopped: join(state, "stopped"), code: join(state, "exit-code"), stderr: join(state, "stderr"),
  };
  const helper = fileURLToPath(new URL("../helpers/reviewer-fence-acquire-race-1070.ts", import.meta.url));
  // The daemon is reparented away from this process, as a real predecessor is never the successor's
  // child: an exited child of a synchronously paused acquisition would stay a zombie that
  // `kill(pid, 0)` still reports alive. Its own subshell reaps it and records its exit status.
  // Its own process group (`detached`), which the subshell and the daemon keep, so cleanup reaches
  // them even when a case fails before the daemon reports its pid.
  const wrapper = spawn("/bin/sh", ["-c", '( "$@" 2> "$PREDECESSOR_STDERR"; echo $? > "$PREDECESSOR_CODE" ) &', "sh",
    process.execPath, "--experimental-transform-types", helper,
    state, repo, branch, target, base, files.release, files.ready, files.stop, files.stopped, "race"], {
    cwd: process.cwd(), env: { ...process.env, PREDECESSOR_CODE: files.code, PREDECESSOR_STDERR: files.stderr },
    stdio: "ignore", detached: true,
  });
  cleanups.push(() => {
    if (wrapper.pid !== undefined && !existsSync(files.code)) {
      try {
        process.kill(-wrapper.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    writeFileSync(files.release, "the case is over");
  });
  const exited = async (): Promise<number> => {
    await waitFor(() => existsSync(files.code) && readFileSync(files.code, "utf8").trim() !== "", "the predecessor's exit status");
    return Number(readFileSync(files.code, "utf8").trim());
  };
  await waitFor(() => existsSync(files.ready) || existsSync(files.code), "the predecessor to hold the lock");
  if (!existsSync(files.ready)) throw new Error(`the predecessor failed: ${readFileSync(files.stderr, "utf8")}`);
  const report = JSON.parse(readFileSync(files.ready, "utf8")) as { daemonPid: number; pgid: number };
  const lockPath = join(state, "agentcpd.lock");
  return {
    lockPath,
    report,
    exited,
    /** Tells it to stop, and blocks until it has written its fence and exited. */
    stopAndWait: () => {
      writeFileSync(files.stop, "stop now");
      blockUntilExited(files.stopped, report.daemonPid);
    },
    head: () => gitSync(repo, ["rev-parse", "HEAD"]),
    base,
  };
};

/** After a refusal: the group still lives, the fence stands, and the refused successor left no lock. */
const expectFenced = (p: Awaited<ReturnType<typeof predecessor>>, successor: SingleInstanceLock): void => {
  expect(groupAlive(p.report.pgid)).toBe(true);
  expect(existsSync(successor.fencePath), "the fence was removed while its group lived").toBe(true);
  const held = successor.read();
  expect(held?.pid === process.pid, "the refused acquisition left its own lock installed").toBe(false);
  expect(successor.held()).toBe(false);
  expect(p.head()).toBe(p.base);
};

/** Once the group is gone the fence lifts and authority can be taken. */
const expectReclaimedAfterTheGroupEnds = async (p: Awaited<ReturnType<typeof predecessor>>): Promise<void> => {
  process.kill(-p.report.pgid, "SIGKILL");
  await waitFor(() => !groupAlive(p.report.pgid), "the fenced group to end");
  const later = new SingleInstanceLock(p.lockPath);
  const acquired = later.acquire(new Date().toISOString());
  const fence = existsSync(later.fencePath) ? readFileSync(later.fencePath, "utf8") : "no fence";
  expect(acquired.allowed, acquired.allowed ? "" : `${acquired.message} ${JSON.stringify(acquired.evidence)} ${fence}`).toBe(true);
  expect(existsSync(later.fencePath)).toBe(false);
  later.release();
};

describe("#1070 ACP-WORKER-03-FC every interleaving of a fenced stop and an acquisition refuses", () => {
  it("the predecessor stops before the successor starts: the first fence check refuses", async () => {
    const p = await predecessor();
    p.stopAndWait();
    expect(await p.exited()).toBe(75);
    const successor = new SingleInstanceLock(p.lockPath);
    const decision = successor.acquire(new Date().toISOString());
    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? null : decision.evidence["afterInstall"]).toBeUndefined();
    expectFenced(p, successor);
    await expectReclaimedAfterTheGroupEnds(p);
  }, 360_000);

  it("the predecessor stops after the successor's fence lookup: the check after installing refuses", async () => {
    const p = await predecessor();
    let paused = false;
    class AfterFenceLookup extends SingleInstanceLock {
      override liveFence(): ReturnType<SingleInstanceLock["liveFence"]> {
        const seen = super.liveFence();
        if (!paused) {
          paused = true;
          p.stopAndWait();
        }
        return seen;
      }
    }
    const successor = new AfterFenceLookup(p.lockPath);
    const decision = successor.acquire(new Date().toISOString());
    expect(paused).toBe(true);
    expect(await p.exited()).toBe(75);
    expect(decision.allowed, "authority was granted across a fence written during the acquisition").toBe(false);
    expect(decision.allowed ? null : decision.evidence["afterInstall"]).toBe(true);
    expectFenced(p, successor);
    await expectReclaimedAfterTheGroupEnds(p);
  }, 360_000);

  it("the predecessor stops after the successor read it as the holder: the check after installing refuses", async () => {
    const p = await predecessor();
    let paused = false;
    class AfterHolderRead extends SingleInstanceLock {
      override read(): ReturnType<SingleInstanceLock["read"]> {
        const holder = super.read();
        if (!paused && holder?.pid === p.report.daemonPid) {
          paused = true;
          // The holder was read while alive; it now writes its fence and exits before the liveness check.
          p.stopAndWait();
        }
        return holder;
      }
    }
    const successor = new AfterHolderRead(p.lockPath);
    const decision = successor.acquire(new Date().toISOString());
    expect(paused).toBe(true);
    expect(await p.exited()).toBe(75);
    expect(decision.allowed, "authority was granted across a fence written during the acquisition").toBe(false);
    // Since narrow review 5 the holder is read only after the lock is asked for: the running
    // predecessor held it, so the refusal is the lock's own (SQLITE_BUSY), and the fence stands.
    expect(decision.allowed ? null : decision.evidence["sqlite"]).toBe("SQLITE_BUSY");
    expectFenced(p, successor);
    await expectReclaimedAfterTheGroupEnds(p);
  }, 360_000);

  it("the predecessor is still running when the successor checks its liveness: the live holder refuses", async () => {
    const p = await predecessor();
    const successor = new SingleInstanceLock(p.lockPath);
    const decision = successor.acquire(new Date().toISOString());
    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? null : decision.message).toMatch(/holds the lock/);
    p.stopAndWait();
    expect(await p.exited()).toBe(75);
    // And after it stopped, its fence refuses the next attempt as well.
    expect(successor.acquire(new Date().toISOString()).allowed).toBe(false);
    expectFenced(p, successor);
    await expectReclaimedAfterTheGroupEnds(p);
  }, 360_000);
});

describe("#1070 ACP-WORKER-03-FC-EMPTY a fence that names no group stands", () => {
  it("is never removed as though its groups had ended, and refuses acquisition", () => {
    const lock = new SingleInstanceLock(join(tempDir("acp-fence-empty-"), "agentcpd.lock"));
    lock.fence([], new Date().toISOString());
    expect(lock.acquire(new Date().toISOString()).allowed).toBe(false);
    expect(existsSync(lock.fencePath)).toBe(true);
    expect(lock.liveFence()).toMatchObject({ groups: null, alive: [] });
  });

  it("an incomplete stop that reports an empty group list is fenced as an unknown one", async () => {
    const h = makeHarness();
    Object.defineProperty(h.cp, "workerTurns", {
      value: { shutdown: async () => ({ drained: false, outstanding: [], gitStopped: false, unconfirmedGroups: [] }) },
      configurable: true,
    });
    const stateDir = tempDir("acp-fence-empty-stop-");
    const daemon = new Daemon(h.cp, { stateDir });
    expect(daemon.lock.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
    expect((await daemon.stop()).complete).toBe(false);
    const written = JSON.parse(readFileSync(daemon.lock.fencePath, "utf8")) as { groups: unknown };
    expect(written.groups).toBeNull();
    daemon.lock.release();
    const successor = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
    expect(successor.acquire(h.cp.clock.nowIso()).allowed).toBe(false);
    expect(existsSync(successor.fencePath)).toBe(true);
    expect(alive(process.pid)).toBe(true);
  });
});

describe("#1070 ACP-WORKER-03-FC narrow review 4: no fence is removed by a read it was not about", () => {
  /** A group id no process holds: `kill(-pgid, 0)` answers ESRCH. */
  const GONE = 2_147_483_000;
  const fenceFiles = (lock: SingleInstanceLock): string[] => {
    const name = `${lock.fencePath.slice(dirname(lock.fencePath).length + 1, -"json".length)}`;
    return readdirSync(dirname(lock.fencePath)).filter((file) => file.startsWith(name) && file.endsWith(".json"));
  };
  const liveGroup = async (): Promise<{ pgid: number; token: string | null }> => {
    const child = spawn("/bin/sh", ["-c", "/bin/sleep 60"], { detached: true, stdio: "ignore" });
    cleanups.push(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
    });
    await waitFor(() => readProcessStartToken(child.pid!) !== null, "the live group to start");
    return { pgid: child.pid!, token: readProcessStartToken(child.pid!) };
  };

  it("each fence write is its own file, and the legacy name is a second link to the newest", () => {
    const lock = new SingleInstanceLock(join(tempDir("acp-fence-unique-"), "agentcpd.lock"));
    lock.fence([{ pgid: GONE, leaderStartedAt: null }], new Date().toISOString());
    lock.fence([{ pgid: GONE - 1, leaderStartedAt: null }], new Date().toISOString());
    const files = fenceFiles(lock);
    expect(files.filter((file) => file !== "agentcpd.lock.git-fence.json")).toHaveLength(2);
    expect(files).toContain("agentcpd.lock.git-fence.json");
  });

  it("a lookup that finds a fence's groups gone answers no fence, and removes nothing", () => {
    const lock = new SingleInstanceLock(join(tempDir("acp-fence-lookup-"), "agentcpd.lock"));
    lock.fence([{ pgid: GONE, leaderStartedAt: null }], new Date().toISOString());
    const before = fenceFiles(lock);
    expect(lock.liveFence()).toBeNull();
    expect(fenceFiles(lock)).toEqual(before);
    // Only an acquisition, under the lock it installed, removes it.
    expect(lock.acquire(new Date().toISOString()).allowed).toBe(true);
    expect(fenceFiles(lock)).toEqual([]);
    lock.release();
  });

  it("a fence an earlier build left at the legacy name is read, refuses while live, and is never removed", async () => {
    const live = await liveGroup();
    const lock = new SingleInstanceLock(join(tempDir("acp-fence-legacy-"), "agentcpd.lock"));
    writeFileSync(lock.fencePath, JSON.stringify({ pid: 1, recordedAt: "2026-10-01T00:00:00.000Z", groups: [{ pgid: live.pgid, leaderStartedAt: live.token }] }));
    expect(lock.acquire(new Date().toISOString()).allowed).toBe(false);
    writeFileSync(lock.fencePath, JSON.stringify({ pid: 1, recordedAt: "2026-10-01T00:00:00.000Z", groups: [{ pgid: GONE, leaderStartedAt: null }] }));
    expect(lock.acquire(new Date().toISOString()).allowed).toBe(true);
    expect(existsSync(lock.fencePath), "a file at a reusable name was removed on a confirmation about what it held").toBe(true);
    lock.release();
  });

  it("a new fence adopts an earlier build's live fence at the legacy name instead of replacing it", async () => {
    const live = await liveGroup();
    const lock = new SingleInstanceLock(join(tempDir("acp-fence-adopt-"), "agentcpd.lock"));
    writeFileSync(lock.fencePath, JSON.stringify({ pid: 1, recordedAt: "2026-10-01T00:00:00.000Z", groups: [{ pgid: live.pgid, leaderStartedAt: live.token }] }));
    lock.fence([{ pgid: GONE, leaderStartedAt: null }], new Date().toISOString());
    const refused = lock.acquire(new Date().toISOString());
    expect(refused.allowed, "the earlier build's live fence was lost when the legacy name was reused").toBe(false);
    expect(refused.allowed ? [] : refused.evidence["alive"]).toEqual([{ pgid: live.pgid, leaderStartedAt: live.token }]);
  });

  // `uchg` makes unlink fail for the owner too; macOS only (Linux needs root for `chattr +i`).
  it.skipIf(process.platform !== "darwin")("a stale fence that cannot be removed refuses rather than being passed over", () => {
    const lock = new SingleInstanceLock(join(tempDir("acp-fence-unremovable-"), "agentcpd.lock"));
    lock.fence([{ pgid: GONE, leaderStartedAt: null }], new Date().toISOString());
    const unique = fenceFiles(lock).find((file) => file !== "agentcpd.lock.git-fence.json")!;
    const path = join(dirname(lock.fencePath), unique);
    execFileSync("/usr/bin/chflags", ["uchg", path], { timeout: 10_000 });
    try {
      const refused = lock.acquire(new Date().toISOString());
      expect(refused.allowed, "a fence that could not be removed was passed over").toBe(false);
      expect(lock.held()).toBe(false);
    } finally {
      execFileSync("/usr/bin/chflags", ["nouchg", path], { timeout: 10_000 });
      lock.release();
    }
  });

  it("a fence directory that cannot be listed refuses", () => {
    const directory = tempDir("acp-fence-unlistable-");
    const lock = new SingleInstanceLock(join(directory, "agentcpd.lock"));
    chmodSync(directory, 0o300);
    try {
      expect(lock.acquire(new Date().toISOString()).allowed).toBe(false);
    } finally {
      chmodSync(directory, 0o700);
      lock.release();
    }
  });
});
