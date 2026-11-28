import { spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { StartTracker, StopFailure, gracefulStop, type GracefulStopSteps } from "../../src/daemon/graceful-stop.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The one stop after the database is open. A stop that arrives while `start()` is running, after it has
 * been promoted out of a park, after it has failed or after it has thrown must wait for what is still
 * writing, stop the daemon, close the database, and only then let go of the lock.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const steps = (events: string[], options: { complete?: boolean } = {}): GracefulStopSteps => ({
  begin: () => {
    events.push("begin");
  },
  closeListeners: async () => {
    events.push("closeListeners");
  },
  stopDaemon: async () => {
    events.push("DAEMON_STOPPED");
    return { complete: options.complete ?? true };
  },
  closeDatabase: () => {
    events.push("closeDatabase");
  },
  fenceUnconfirmed: () => {
    events.push("fence");
  },
  releaseLock: () => {
    events.push("releaseLock");
  },
});

describe("a stop waits for the start that is writing, and closes before it lets go", () => {
  it("a start still running is waited for: DAEMON_STARTED, then DAEMON_STOPPED, then the close, then the lock", async () => {
    const events: string[] = [];
    const tracker = new StartTracker();
    tracker.track(sleep(120).then(() => events.push("DAEMON_STARTED")));

    await gracefulStop(tracker, steps(events));

    expect(events).toEqual(["begin", "DAEMON_STARTED", "closeListeners", "DAEMON_STOPPED", "closeDatabase", "releaseLock"]);
  });

  it("a park that was promoted is not a latch: the resumed start is waited for, however long it takes after the promotion", async () => {
    const events: string[] = [];
    const tracker = new StartTracker();
    // Parked, then promoted (the door closes), then the rest of startup runs for a while and records the start.
    tracker.track(
      (async () => {
        tracker.park();
        await sleep(30);
        tracker.resume();
        await sleep(700);
        events.push("DAEMON_STARTED");
      })(),
    );
    // Parked first, which a latch would remember forever.
    await sleep(10);
    expect(tracker.parked).toBe(true);
    // The stop arrives after the promotion, while the resumed start is still writing.
    await sleep(60);
    expect(tracker.parked).toBe(false);
    expect(tracker.settled).toBe(false);

    await gracefulStop(tracker, steps(events));

    expect(events).toEqual(["begin", "DAEMON_STARTED", "closeListeners", "DAEMON_STOPPED", "closeDatabase", "releaseLock"]);
  });

  it("a start that is parked now is stopped without waiting: the stop is what wakes it", async () => {
    const events: string[] = [];
    const tracker = new StartTracker();
    let wake: () => void = () => undefined;
    tracker.track(new Promise<void>((resolve) => (wake = resolve)));
    tracker.park();
    const stopped = gracefulStop(
      tracker,
      {
        ...steps(events),
        stopDaemon: async () => {
          events.push("DAEMON_STOPPED");
          // The daemon's stop abandons the park: the door closes and the start settles.
          tracker.resume();
          wake();
          return { complete: true };
        },
      },
      { settleBoundMs: 1_000 },
    );

    await stopped;

    expect(events).toEqual(["begin", "closeListeners", "DAEMON_STOPPED", "closeDatabase", "releaseLock"]);
  });

  it("a start that never settles cannot hold the stop forever, and the database is still closed before the lock goes", async () => {
    const events: string[] = [];
    const tracker = new StartTracker();
    tracker.track(new Promise<void>(() => undefined));
    tracker.park();

    await gracefulStop(tracker, steps(events), { settleBoundMs: 40 });

    expect(events.indexOf("closeDatabase")).toBeGreaterThan(events.indexOf("DAEMON_STOPPED"));
    expect(events.indexOf("releaseLock")).toBe(events.indexOf("closeDatabase") + 1);
  });

  it("a start that rejected is settled: the stop goes ahead, and tracking does not swallow the rejection", async () => {
    const events: string[] = [];
    const tracker = new StartTracker();
    const failure = new Error("start failed");
    const tracked = tracker.track(Promise.reject(failure));
    await expect(tracked).rejects.toBe(failure);

    await gracefulStop(tracker, steps(events));

    expect(tracker.settled).toBe(true);
    expect(events).toEqual(["begin", "closeListeners", "DAEMON_STOPPED", "closeDatabase", "releaseLock"]);
  });

  it("a stop that could not confirm its workers gone closes the database and keeps the lock", async () => {
    const events: string[] = [];
    const tracker = new StartTracker();
    tracker.track(Promise.resolve());

    const stopped = await gracefulStop(tracker, steps(events, { complete: false }));

    expect(stopped.complete).toBe(false);
    expect(events).toEqual(["begin", "closeListeners", "DAEMON_STOPPED", "closeDatabase"]);
  });

  it("the decision to stop is taken before anything is awaited", async () => {
    const events: string[] = [];
    const tracker = new StartTracker();
    tracker.track(new Promise<void>(() => undefined));
    tracker.park();

    const stopping = gracefulStop(tracker, steps(events), { settleBoundMs: 10 });
    // Synchronously, before the first await in the stop has had a chance to yield.
    expect(events).toEqual(["begin"]);
    await stopping;
  });

  it("a stop that fails with no verdict fails closed: the database is closed, a fence is written, and the lock stays", async () => {
    const events: string[] = [];
    const tracker = new StartTracker();
    tracker.track(Promise.resolve());

    await expect(
      gracefulStop(tracker, {
        ...steps(events),
        stopDaemon: async () => {
          events.push("stopDaemon failed");
          throw new Error("the drain threw");
        },
      }),
    ).rejects.toThrow("the drain threw");

    expect(events).toEqual(["begin", "closeListeners", "stopDaemon failed", "closeDatabase", "fence"]);
  });

  it("a stop that failed only after it confirmed its workers gone (its audit write) closes the database and releases the lock", async () => {
    const events: string[] = [];
    const tracker = new StartTracker();
    tracker.track(Promise.resolve());

    await expect(
      gracefulStop(tracker, {
        ...steps(events),
        stopDaemon: async () => {
          events.push("stopDaemon failed");
          throw new StopFailure(new Error("DAEMON_STOPPED could not be written"), true);
        },
      }),
    ).rejects.toThrow("DAEMON_STOPPED could not be written");

    expect(events).toEqual(["begin", "closeListeners", "stopDaemon failed", "closeDatabase", "releaseLock"]);
  });

  it("a close that itself fails keeps the lock: nothing after it runs", async () => {
    const events: string[] = [];
    const tracker = new StartTracker();
    tracker.track(Promise.resolve());

    await expect(
      gracefulStop(tracker, {
        ...steps(events),
        closeDatabase: () => {
          throw new Error("close failed");
        },
      }),
    ).rejects.toThrow("close failed");

    expect(events).toEqual(["begin", "closeListeners", "DAEMON_STOPPED", "fence"]);
  });
});

describe("the lock is let go only when it is safe to", () => {
  it("a close that throws keeps the lock: a second holder is refused, and nothing releases it behind the stop", async () => {
    const dir = tempDir("acp-graceful-stop-lock-");
    const lock = new SingleInstanceLock(join(dir, "agentcpd.lock"));
    expect(lock.acquire(new Date().toISOString()).allowed).toBe(true);
    const events: string[] = [];
    const tracker = new StartTracker();
    tracker.track(Promise.resolve());

    await expect(
      gracefulStop(tracker, {
        ...steps(events),
        closeDatabase: () => {
          events.push("closeDatabase threw");
          throw new Error("the database is busy: a query is still running");
        },
        fenceUnconfirmed: () => lock.fence(null, new Date().toISOString()),
        releaseLock: () => {
          events.push("releaseLock");
          lock.release();
        },
      }),
    ).rejects.toThrow("a query is still running");

    expect(events).not.toContain("releaseLock");
    expect(lock.held()).toBe(true);
    // The marker is kept and a fence stands beside it: a second holder is refused, and stays refused after
    // this process is gone, until the fence is removed.
    expect(existsSync(lock.fencePath)).toBe(true);
    const second = new SingleInstanceLock(join(dir, "agentcpd.lock"));
    expect(second.acquire(new Date().toISOString()).allowed).toBe(false);
    lock.release();
    expect(new SingleInstanceLock(join(dir, "agentcpd.lock")).acquire(new Date().toISOString()).allowed).toBe(false);
  });

  it("a real close that throws on an active iterator, after a confirmed drain, writes the fence and refuses a successor", async () => {
    const dir = tempDir("acp-graceful-stop-iterator-");
    const lock = new SingleInstanceLock(join(dir, "agentcpd.lock"));
    expect(lock.acquire(new Date().toISOString()).allowed).toBe(true);
    const handle = new Database(join(dir, "live.sqlite"));
    handle.exec("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2), (3)");
    // A query still running on the handle: `close()` refuses.
    const rows = handle.prepare("SELECT n FROM t").iterate();
    rows.next();
    const tracker = new StartTracker();
    tracker.track(Promise.resolve());

    await expect(
      gracefulStop(tracker, {
        begin: () => undefined,
        closeListeners: async () => undefined,
        stopDaemon: async () => ({ complete: true }),
        closeDatabase: () => handle.close(),
        fenceUnconfirmed: () => lock.fence(null, new Date().toISOString()),
        releaseLock: () => lock.release(),
      }),
    ).rejects.toThrow(/busy|iterat|running/i);

    expect(handle.open).toBe(true);
    expect(lock.held()).toBe(true);
    expect(existsSync(lock.fencePath)).toBe(true);
    expect(new SingleInstanceLock(join(dir, "agentcpd.lock")).acquire(new Date().toISOString()).allowed).toBe(false);
    rows.return?.();
    handle.close();
    lock.release();
  });

  // #1498: the fence beside the lock could not be written (EACCES), the error was swallowed, and the holder's
  // directory was all that was left. A successor read it as a dead holder and reclaimed it.
  it.skipIf(process.getuid?.() === 0)(
    "a fence the state directory refuses is written inside the holder's directory, and refuses a successor after the holder exits",
    async () => {
      const dir = tempDir("acp-graceful-stop-unwritable-");
      const lockPath = join(dir, "agentcpd.lock");
      const module = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href);
      const source = [
        `import Database from "better-sqlite3";`,
        `import { chmodSync } from "node:fs";`,
        `const { StartTracker, StopFailure, gracefulStop } = await import(${module("../../src/daemon/graceful-stop.ts")});`,
        `const { SingleInstanceLock } = await import(${module("../../src/daemon/single-instance.ts")});`,
        `const lock = new SingleInstanceLock(${JSON.stringify(lockPath)});`,
        `if (!lock.acquire(new Date().toISOString()).allowed) process.exit(3);`,
        `const handle = new Database(${JSON.stringify(join(dir, "live.sqlite"))});`,
        `handle.exec("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2), (3)");`,
        `const rows = handle.prepare("SELECT n FROM t").iterate();`,
        `rows.next();`,
        `const tracker = new StartTracker();`,
        `tracker.track(Promise.resolve());`,
        `await gracefulStop(tracker, {`,
        `  begin: () => undefined,`,
        `  closeListeners: async () => undefined,`,
        // The drain confirmed its workers gone; only the stop's own row could not be written.
        `  stopDaemon: async () => { throw new StopFailure(new Error("the stop row is refused"), true); },`,
        `  closeDatabase: () => { chmodSync(${JSON.stringify(dir)}, 0o500); handle.close(); },`,
        `  fenceUnconfirmed: () => lock.fence(null, new Date().toISOString()),`,
        `  releaseLock: () => lock.release(),`,
        `}).catch(() => undefined);`,
        // Leaves as agentcpd does after a close that failed: non-zero, the lock released only by the exit.
        `process.exit(1);`,
      ].join("\n");
      const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", source], {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const status = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
      chmodSync(dir, 0o700);
      expect(status, stderr).toBe(1);

      // The state directory refused the fence beside the lock, as in the report; the holder's record stays.
      const lock = new SingleInstanceLock(lockPath);
      expect(existsSync(lock.fencePath)).toBe(false);
      expect(lock.read()?.pid).toBe(child.pid);
      const successor = lock.acquire(new Date().toISOString());

      expect(successor.allowed, "the dead holder's lock was reclaimed with no fence standing").toBe(false);
      expect(successor.reasonCode).toBe("DAEMON_ALREADY_RUNNING");
      const files = (successor.evidence as { files?: string[] } | undefined)?.files ?? [];
      expect(files.map((file) => dirname(file)), "the fence that refused it").toEqual([lockPath]);
    },
    60_000,
  );

  it("an incomplete worker drain followed by a failing DAEMON_STOPPED insert keeps the lock, and the fence says why", async () => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-graceful-stop-fence-") });
    expect((await daemon.start()).allowed).toBe(true);
    // The drain could not confirm a worker's process group gone, so the stop fences it and keeps the lock...
    vi.spyOn(harness.cp.workerTurns, "shutdown").mockResolvedValue({
      drained: false,
      outstanding: [],
      gitStopped: false,
      unconfirmedGroups: [{ pgid: 2_147_483_000, leaderStartedAt: null }],
    });
    // ...and then the row that would record it cannot be written.
    const raw = new Database(join(harness.root, "state.sqlite"));
    raw.exec(
      `CREATE TRIGGER zz_refuse_stop BEFORE INSERT ON audit_events WHEN NEW.kind = 'DAEMON_STOPPED'
       BEGIN SELECT RAISE(ABORT, 'the stop row is refused'); END`,
    );
    raw.close();
    const events: string[] = [];
    const tracker = new StartTracker();
    tracker.track(Promise.resolve());

    await expect(
      gracefulStop(tracker, {
        begin: () => daemon.beginStop(),
        closeListeners: async () => undefined,
        stopDaemon: () => daemon.stop({ leaveLockHeld: true }),
        closeDatabase: () => {
          events.push("closeDatabase");
        },
        fenceUnconfirmed: () => undefined,
        releaseLock: () => {
          events.push("releaseLock");
          daemon.lock.release();
        },
      }),
    ).rejects.toMatchObject({ name: "StopFailure", complete: false });

    expect(events).toEqual(["closeDatabase"]);
    expect(daemon.lock.held()).toBe(true);
    expect(existsSync(daemon.lock.fencePath)).toBe(true);
    expect(new SingleInstanceLock(daemon.lock.lockDatabasePath.replace(/\.db$/, "")).acquire(new Date().toISOString()).allowed).toBe(false);
  });
});
