import { describe, expect, it } from "vitest";

import { StartTracker, gracefulStop, type GracefulStopSteps } from "../../src/daemon/graceful-stop.ts";

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

  it("a step that fails, the daemon's own stop and its audit write among them, still closes the database and only then releases the lock", async () => {
    const events: string[] = [];
    const tracker = new StartTracker();
    tracker.track(Promise.resolve());

    await expect(
      gracefulStop(tracker, {
        ...steps(events),
        stopDaemon: async () => {
          events.push("stopDaemon failed");
          throw new Error("DAEMON_STOPPED could not be written");
        },
      }),
    ).rejects.toThrow("DAEMON_STOPPED could not be written");

    expect(events).toEqual(["begin", "closeListeners", "stopDaemon failed", "closeDatabase", "releaseLock"]);
  });

  it("a close that itself fails still lets the lock go", async () => {
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

    expect(events).toEqual(["begin", "closeListeners", "DAEMON_STOPPED", "releaseLock"]);
  });
});
