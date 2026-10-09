import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, linkSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";

/**
 * #1070 ACP-WORKER-03-FC, narrow review 5 — fences under the exclusive lock.
 *
 *   * Two real reclaimers: whichever holds the lock, the other can neither write nor clear a fence
 *     meanwhile, and a live fence written by a stopped predecessor survives the successor, which
 *     refuses, with HEAD unchanged (the reviewer's late-fence race, in the orders that can occur).
 *   * UNKNOWN: only a confirmed ESRCH, or a start-token mismatch, ends a fenced group; an id that
 *     cannot be asked about, and any other probe error, keeps the fence standing.
 *   * ADOPT: the legacy name is never overwritten, and a file there that no scanned unique name links
 *     is adopted under a unique name before anything else, so an outside hard link cannot hide it.
 */
afterAll(cleanupTempDirs);

const ACQUIRER = fileURLToPath(new URL("../helpers/fence-acquirer-process.ts", import.meta.url));
const PREDECESSOR = fileURLToPath(new URL("../helpers/reviewer-fence-acquire-race-1070.ts", import.meta.url));
const GONE = 2_147_483_000;
const now = (): string => new Date().toISOString();

const children: ChildProcess[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 120_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const fenceFiles = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.startsWith("agentcpd.lock.git-fence.") && name.endsWith(".json")).sort();

const spawnNode = (args: string[]): { child: ChildProcess; exited: Promise<number | null>; errors: () => string } => {
  const child = spawn(process.execPath, ["--experimental-transform-types", ...args], {
    cwd: process.cwd(), env: { ...process.env, TMPDIR: "/private/tmp" }, stdio: ["ignore", "ignore", "pipe"],
  });
  const errors: Buffer[] = [];
  child.stderr!.on("data", (chunk: Buffer) => errors.push(chunk));
  children.push(child);
  return { child, exited: new Promise((resolve) => child.once("exit", resolve)), errors: () => Buffer.concat(errors).toString() };
};

/** A repository with a ref update a paused mutator would make, and a state directory. */
const world = () => {
  const repo = makeRepo({ "README.md": "base\n" });
  const base = gitSync(repo, ["rev-parse", "HEAD"]);
  const branch = gitSync(repo, ["symbolic-ref", "--short", "HEAD"]);
  writeFileSync(join(repo, "README.md"), "next\n");
  commitAll(repo, "next");
  const target = gitSync(repo, ["rev-parse", "HEAD"]);
  gitSync(repo, ["update-ref", `refs/heads/${branch}`, base, target]);
  const state = tempDir("acp-fence-under-lock-");
  return { repo, base, branch, target, state, head: () => gitSync(repo, ["rev-parse", "HEAD"]) };
};

/** The reviewer's predecessor: real Daemon.stop() with a real paused mutator, exiting 75. */
const predecessor = (w: ReturnType<typeof world>, id: string) => {
  const files = {
    release: join(w.state, `${id}.release-mutator`), ready: join(w.state, `${id}.ready`),
    stop: join(w.state, `${id}.stop`), stopped: join(w.state, `${id}.stopped`),
  };
  const run = spawnNode([PREDECESSOR, w.state, w.repo, w.branch, w.target, w.base,
    files.release, files.ready, files.stop, files.stopped, "race"]);
  // Its mutator starts before it acquires; released at the end, it finishes against the test repository.
  cleanups.push(() => {
    if (existsSync(files.ready)) {
      try {
        process.kill(-readJson<{ pgid: number }>(files.ready).pgid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    writeFileSync(files.release, "the case is over");
  });
  return { ...run, files };
};

const successor = (w: ReturnType<typeof world>, id: string, pause?: string) => {
  const run = spawnNode([ACQUIRER, w.state, id, ...(pause === "list" ? ["pause-list"] : pause ? ["pause-on", pause] : [])]);
  cleanups.push(() => {
    writeFileSync(join(w.state, `${id}.resume`), "cleanup");
    writeFileSync(join(w.state, `${id}.exit`), "cleanup");
  });
  return {
    ...run,
    result: async () => {
      await waitFor(() => existsSync(join(w.state, `${id}.result`)) || run.child.exitCode !== null, `${id}'s result`);
      if (!existsSync(join(w.state, `${id}.result`))) throw new Error(`${id} exited: ${run.errors()}`);
      return readJson<{ allowed: boolean; reasonCode: string; held: boolean }>(join(w.state, `${id}.result`));
    },
    exit: async () => {
      writeFileSync(join(w.state, `${id}.exit`), "exit");
      await run.exited;
    },
  };
};

describe("#1070 ACP-WORKER-03-FC two real reclaimers and a stopped predecessor's fence", () => {
  it("a predecessor cannot write a fence while a successor holds the lock, and a fence written after it is kept", async () => {
    const w = world();
    // An old fence whose group is gone, and a dead holder's record, as the reviewer's race starts.
    new SingleInstanceLock(join(w.state, "agentcpd.lock")).fence([{ pgid: GONE, leaderStartedAt: null }], now());
    // B holds the lock and is paused at its fence read under it.
    const b = successor(w, "b", `"pgid":${GONE}`);
    await waitFor(() => existsSync(join(w.state, "b.paused")), "the successor to pause under the lock");
    // A, a real daemon, tries to take the lock now: refused, so it can write no fence.
    const a = predecessor(w, "a");
    expect(await a.exited, a.errors()).not.toBe(0);
    expect(existsSync(a.files.ready)).toBe(false);
    writeFileSync(join(w.state, "b.resume"), "resume");
    const held = await b.result();
    expect(held.allowed, JSON.stringify(held)).toBe(true);
    expect(fenceFiles(w.state)).toEqual([]);
    await b.exit();

    // Now a real predecessor holds the lock. A successor lists the fences before it asks for the lock
    // and finds none; paused there, the predecessor stops with its mutator unconfirmed, writes its
    // fence and exits 75. Resumed, the successor takes the lock, finds that fence under it, refuses.
    const a2 = predecessor(w, "a2");
    await waitFor(() => existsSync(a2.files.ready), "the predecessor to hold the lock");
    const b2 = successor(w, "b2", "list");
    await waitFor(() => existsSync(join(w.state, "b2.paused")), "the second successor to list the fences");
    writeFileSync(a2.files.stop, "stop");
    expect(await a2.exited).toBe(75);
    const written = fenceFiles(w.state);
    expect(written.length).toBeGreaterThan(0);
    writeFileSync(join(w.state, "b2.resume"), "resume");
    const refused = await b2.result();
    expect(refused.allowed).toBe(false);
    expect(refused.held).toBe(false);
    expect(fenceFiles(w.state)).toEqual(written);
    expect(w.head()).toBe(w.base);
    await b2.exit();
  }, 300_000);

  it("a process that does not hold the lock cannot write a fence while another process holds it", async () => {
    const w = world();
    const holder = successor(w, "holder");
    expect((await holder.result()).allowed).toBe(true);
    const outsider = new SingleInstanceLock(join(w.state, "agentcpd.lock"));
    expect(() => outsider.fence([{ pgid: GONE, leaderStartedAt: null }], now())).toThrow(/holder/u);
    expect(fenceFiles(w.state)).toEqual([]);
    await holder.exit();
  }, 300_000);
});

describe("#1070 ACP-WORKER-03-FC-UNKNOWN only a confirmed absence ends a fenced group", () => {
  const fenced = (pgid: number) => {
    const lock = new SingleInstanceLock(join(tempDir("acp-fence-unknown-"), "agentcpd.lock"));
    lock.fence([{ pgid, leaderStartedAt: null }], now());
    return lock;
  };

  it("an id the probe cannot even ask about stands", () => {
    const lock = fenced(Number.MAX_SAFE_INTEGER);
    expect(lock.acquire(now()).allowed).toBe(false);
    expect(existsSync(lock.fencePath)).toBe(true);
  });

  it.each(["EIO", "EINVAL", "ENOMEM", "ERR_INVALID_ARG_TYPE"])("a probe answering %s stands", (code) => {
    const lock = fenced(GONE);
    const kill = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -GONE) throw Object.assign(new Error(code), { code });
      return kill(pid, signal);
    });
    try {
      expect(lock.acquire(now()).allowed).toBe(false);
      expect(existsSync(lock.fencePath)).toBe(true);
    } finally {
      spy.mockRestore();
      lock.release();
    }
  });

  it("an EPERM group with no readable start token stands; a readable, different token ends it", () => {
    const kill = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -GONE || pid === -process.pid) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return kill(pid, signal);
    });
    try {
      // No process holds GONE, so no token can be read: not a mismatch, so the group may be alive.
      const unread = new SingleInstanceLock(join(tempDir("acp-fence-token-unread-"), "agentcpd.lock"));
      unread.fence([{ pgid: GONE, leaderStartedAt: "darwin-tv:1.000000" }], now());
      expect(unread.acquire(now()).allowed).toBe(false);
      expect(existsSync(unread.fencePath)).toBe(true);
      // This process holds its own id, started at another time than recorded: that group is gone.
      const reused = new SingleInstanceLock(join(tempDir("acp-fence-token-reused-"), "agentcpd.lock"));
      reused.fence([{ pgid: process.pid, leaderStartedAt: "darwin-tv:1.000000" }], now());
      expect(reused.acquire(now()).allowed).toBe(readProcessStartToken(process.pid) !== null);
      reused.release();
    } finally {
      spy.mockRestore();
    }
  });

  it("a confirmed ESRCH ends it, and the fence is cleared under the lock", () => {
    const lock = fenced(GONE);
    expect(lock.acquire(now()).allowed).toBe(true);
    expect(fenceFiles(join(lock.fencePath, ".."))).toEqual([]);
    lock.release();
  });
});

describe("#1070 ACP-WORKER-03-FC-ADOPT the legacy name is never overwritten", () => {
  const liveGroup = (): { pgid: number; token: string | null } => {
    const child = spawn("/bin/sleep", ["120"], { detached: true, stdio: "ignore" });
    children.push(child);
    cleanups.push(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
    });
    return { pgid: child.pid!, token: readProcessStartToken(child.pid!) };
  };

  it("a live legacy fence with a hard link outside the scan survives a new fence, and refuses", () => {
    const live = liveGroup();
    const dir = tempDir("acp-fence-operator-copy-");
    const lock = new SingleInstanceLock(join(dir, "agentcpd.lock"));
    writeFileSync(lock.fencePath, JSON.stringify({ groups: [{ pgid: live.pgid, leaderStartedAt: live.token }] }));
    const legacy = statSync(lock.fencePath).ino;
    linkSync(lock.fencePath, join(dir, "operator-copy"));
    lock.fence([{ pgid: GONE, leaderStartedAt: null }], now());
    expect(statSync(lock.fencePath).ino, "the legacy name was overwritten").toBe(legacy);
    const refused = lock.acquire(now());
    expect(refused.allowed).toBe(false);
    expect(refused.allowed ? [] : refused.evidence["alive"]).toEqual([{ pgid: live.pgid, leaderStartedAt: live.token }]);
    expect(fenceFiles(dir).some((name) => name.includes(".adopted.") && statSync(join(dir, name)).ino === legacy)).toBe(true);
  });

  it("a fence written while an acquisition is clearing the old one is never cleared with it", () => {
    const live = liveGroup();
    const dir = tempDir("acp-fence-during-clear-");
    const lock = new SingleInstanceLock(join(dir, "agentcpd.lock"));
    lock.fence([{ pgid: GONE, leaderStartedAt: null }], now());
    // The moment the stale fence is judged gone under the lock, a live one is written beside it.
    const kill = process.kill.bind(process);
    let written = false;
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      try {
        return kill(pid, signal);
      } finally {
        if (pid === -GONE && lock.held() && !written) {
          written = true;
          lock.fence([{ pgid: live.pgid, leaderStartedAt: live.token }], now());
        }
      }
    });
    let decision;
    try {
      decision = lock.acquire(now());
    } catch (error) {
      decision = { allowed: false, thrown: String(error) };
    } finally {
      spy.mockRestore();
    }
    expect(written).toBe(true);
    expect(decision.allowed, "a fence written during the clearing was cleared with it").toBe(false);
    expect(fenceFiles(dir).some((name) => readFileSync(join(dir, name), "utf8").includes(`"pgid":${live.pgid}`))).toBe(true);
  });

  it("a lookup outside the lock adopts nothing: the directory is as it was", () => {
    const dir = tempDir("acp-fence-lookup-adopts-nothing-");
    const lock = new SingleInstanceLock(join(dir, "agentcpd.lock"));
    writeFileSync(lock.fencePath, JSON.stringify({ groups: [{ pgid: GONE, leaderStartedAt: null }] }));
    const before = readdirSync(dir).sort();
    expect(lock.liveFence()).toBeNull();
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("an unreadable legacy file stands and is kept", () => {
    const dir = tempDir("acp-fence-unreadable-legacy-");
    const lock = new SingleInstanceLock(join(dir, "agentcpd.lock"));
    writeFileSync(lock.fencePath, JSON.stringify({ groups: [{ pgid: GONE, leaderStartedAt: null }] }));
    chmodSync(lock.fencePath, 0o000);
    try {
      expect(lock.acquire(now()).allowed).toBe(false);
      expect(existsSync(lock.fencePath)).toBe(true);
    } finally {
      chmodSync(lock.fencePath, 0o600);
      lock.release();
    }
  });

  it("a running holder's record leaves even stale fences untouched", () => {
    const dir = tempDir("acp-fence-running-holder-");
    const lock = new SingleInstanceLock(join(dir, "agentcpd.lock"));
    lock.fence([{ pgid: GONE, leaderStartedAt: null }], now());
    const before = fenceFiles(dir);
    writeFileSync(join(dir, "agentcpd.lock"), JSON.stringify({ pid: process.pid, startedAt: now(), path: join(dir, "agentcpd.lock") }));
    expect(lock.acquire(now()).allowed).toBe(false);
    expect(fenceFiles(dir)).toEqual(before);
  });
});
