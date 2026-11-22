/**
 * What a stop has to know about a start that is still running, and the one order it then runs in.
 *
 * A stop can arrive at any point after the database is open: while `daemon.start()` is running, after it
 * has parked for the bootstrap door and been promoted, after it has failed, or after it has thrown. Taking
 * the process out from under a start that is still writing leaves no DAEMON_STARTED row for a start that
 * was about to succeed (or one written after DAEMON_STOPPED, with the lock already given back), and a
 * handle that never closed leaves `-wal` and `-shm` behind. So every exit after the open goes through the
 * same two pieces below: the tracker says when a stop may go ahead, and `gracefulStop` runs the stop in an
 * order that closes the database before the lock is let go.
 */
export class StartTracker {
  #settled = false;
  #parked = false;
  #changed: Promise<void>;
  #wake: () => void = () => undefined;

  constructor() {
    this.#changed = new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
  }

  /** Whether the start has settled, resolved or rejected. */
  get settled(): boolean {
    return this.#settled;
  }

  /** Whether the start is parked right now. Not whether it ever was. */
  get parked(): boolean {
    return this.#parked;
  }

  /** Watches a start without changing what it returns or throws. */
  track<T>(start: Promise<T>): Promise<T> {
    start.then(
      () => this.#settle(),
      () => this.#settle(),
    );
    return start;
  }

  /** The start has parked for the bootstrap door. It settles only when something wakes it. */
  park(): void {
    this.#parked = true;
    this.#signal();
  }

  /** The door is closed: the park ended, whether by promotion (the start goes on and writes) or abandonment. */
  resume(): void {
    this.#parked = false;
    this.#signal();
  }

  /**
   * Resolves when a stop may go ahead: the start has settled, or it is parked now and so will not settle
   * until the stop wakes it. A start that resumed after a park is running again and is waited for; the
   * parked state is the current one, never a latch.
   */
  async untilStoppable(): Promise<void> {
    while (!this.#settled && !this.#parked) await this.#changed;
  }

  /** Resolves true when the start settles, or false after `boundMs` if it has not. */
  async untilSettled(boundMs: number): Promise<boolean> {
    if (this.#settled) return true;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<"BOUND">((resolve) => {
      timer = setTimeout(() => resolve("BOUND"), boundMs);
      timer.unref();
    });
    try {
      while (!this.#settled) {
        const outcome = await Promise.race([this.#changed.then(() => "CHANGED" as const), bound]);
        if (outcome === "BOUND") return this.#settled;
      }
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #settle(): void {
    this.#settled = true;
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    this.#changed = new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
    wake();
  }
}

/**
 * A stop that threw after it had settled whether its workers are confirmed gone. `complete: false` means it
 * had already fenced them (the fence is written before anything that can fail), so the failure, an audit
 * insert for instance, must not be read as "nothing is known": the lock is kept.
 */
export class StopFailure extends Error {
  constructor(readonly original: unknown, readonly complete: boolean) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "StopFailure";
  }
}

/** The steps a stop runs, handed in so the order is the one thing this module owns. */
export interface GracefulStopSteps {
  /**
   * The decision to stop, taken first and synchronously, before anything is awaited: whatever the start in
   * flight could still decide to do (promote out of a park, resume runs) is closed off here, not once the
   * slower steps below have run.
   */
  begin(): void;
  /** Closes what the process is serving on. */
  closeListeners(): Promise<void>;
  /** The daemon's own stop: drains workers, writes DAEMON_STOPPED, and leaves the lock for the caller to give back. */
  stopDaemon(): Promise<{ complete: boolean }>;
  /** Closes the live database handle. */
  closeDatabase(): void;
  /**
   * Writes the fence for workers whose exit is not confirmed, when the stop did not (or could not) write
   * its own: a close that failed, or a stop that threw before it had a verdict. Unknown groups: it holds
   * until an operator removes it, which is the point.
   */
  fenceUnconfirmed(): void;
  /** Gives the lock back. Only called once the handle is closed. */
  releaseLock(): void;
}

/**
 * The one stop, in the one order: decide to stop, wait until the start can be stopped, close what serves,
 * stop the daemon, give a start that was woken from a park a bounded time to settle, close the database in
 * any case, and only then let go of the lock. The close and the release are in a `finally`: a step that
 * fails (the stop's own audit write included) still closes the handle, and the lock still goes only after
 * it, and only if the close itself succeeded. The bound exists so a start that never settles cannot hold a
 * stop forever; it never skips the close. A stop that could not confirm its worker process groups finished
 * keeps the lock (and the fence beside it), whether it returned that or failed after deciding it; a stop
 * that failed before it knew anything about them releases the lock once the handle is closed.
 */
export const gracefulStop = async (
  tracker: StartTracker,
  steps: GracefulStopSteps,
  options: { settleBoundMs?: number } = {},
): Promise<{ complete: boolean }> => {
  steps.begin();
  await tracker.untilStoppable();
  let stopped: { complete: boolean } | null = null;
  let failure: { error: unknown } | null = null;
  // Whether worker exit is, or may be, unconfirmed: the stop said so, or failed in a way that says nothing, or
  // the handle could not be closed. In every such case the lock marker AND a fence are kept, so a successor is
  // refused the same way. Failing closed: only a stop that returned complete, or one that failed after it had
  // confirmed the workers gone (an audit write), may let the lock go.
  let unconfirmed = false;
  let fenceNeeded = false;
  try {
    await steps.closeListeners();
    stopped = await steps.stopDaemon();
    await tracker.untilSettled(options.settleBoundMs ?? 5_000);
  } catch (error) {
    failure = { error };
    if (error instanceof StopFailure) {
      // The stop had already decided, and fenced if it had to. A failure of its audit write is not a verdict.
      if (!error.complete) unconfirmed = true;
    } else {
      unconfirmed = true;
      fenceNeeded = true;
    }
  }
  if (stopped !== null && !stopped.complete) unconfirmed = true;
  // The close comes first, and the lock is let go only if it succeeded: a close that throws (a query still
  // running on the handle) leaves the lock held, and a fence beside it. The process leaves non-zero, and the
  // kernel releases what the process held; the marker and the fence stay for whoever finds them.
  let closeFailure: { error: unknown } | null = null;
  try {
    steps.closeDatabase();
  } catch (error) {
    closeFailure = { error };
    unconfirmed = true;
    fenceNeeded = true;
  }
  if (fenceNeeded) {
    try {
      steps.fenceUnconfirmed();
    } catch {
      // The lock is kept either way; a fence that could not be written is the one thing this cannot repair.
    }
  }
  if (!unconfirmed) steps.releaseLock();
  if (closeFailure !== null) throw closeFailure.error;
  if (failure !== null) throw failure.error;
  return stopped!;
};
