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
  /** Gives the lock back. Only called once the handle is closed. */
  releaseLock(): void;
}

/**
 * The one stop, in the one order: decide to stop, wait until the start can be stopped, close what serves,
 * stop the daemon, give a start that was woken from a park a bounded time to settle, close the database in
 * any case, and only then let go of the lock. The close and the release are in a `finally`: a step that
 * fails (the stop's own audit write included) still closes the handle, and the lock still goes only after
 * it. The bound exists so a start that never settles cannot hold a stop forever; it never skips the close.
 * A stop that could not confirm its worker process groups finished keeps the lock (and the fence beside
 * it), exactly as before; a stop that failed outright reports nothing about them and releases it.
 */
export const gracefulStop = async (
  tracker: StartTracker,
  steps: GracefulStopSteps,
  options: { settleBoundMs?: number } = {},
): Promise<{ complete: boolean }> => {
  steps.begin();
  await tracker.untilStoppable();
  let stopped: { complete: boolean } | null = null;
  try {
    await steps.closeListeners();
    stopped = await steps.stopDaemon();
    await tracker.untilSettled(options.settleBoundMs ?? 5_000);
  } finally {
    try {
      steps.closeDatabase();
    } finally {
      if (stopped === null || stopped.complete) steps.releaseLock();
    }
  }
  return stopped;
};
