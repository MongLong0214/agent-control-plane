import { spawn } from "node:child_process";

/**
 * Starts a child with a time bound and reaps its whole process group if the bound expires.
 *
 * #872. Three facts, each measured rather than assumed, decide this shape:
 *
 * 1. **`spawnSync` cannot be bounded usefully.** It blocks the event loop, so vitest's per-test
 *    timeout cannot interrupt one: the worker stops, and vitest then reports a timeout against
 *    whichever test that worker happened to be holding. Three consecutive local full-suite runs
 *    in one session produced three *different* sets of 60s timeouts, each passing in isolation.
 *    The file that fails is not the file that hung.
 * 2. **`spawnSync`'s own timeout reaps only the direct child.** Measured with a fixture whose
 *    child spawns a never-exiting grandchild and then never exits itself:
 *
 *        { elapsedMs: 2002, status: null, signal: "SIGTERM",
 *          killed: null, grandchildStillAlive: true }
 *
 *    The parent returns on time and the grandchild survives the run. So a bound that does not
 *    signal the group leaves the wedge behind for the next test to inherit.
 * 3. **`killed` is not set on this path.** The same measurement shows `killed: null` beside a real
 *    `SIGTERM`, which is why nothing here consults it. An `execFileSync`-shaped comment asserting
 *    that field's behaviour was once the alibi for an always-false branch in this repository.
 *
 * The containment is the same one `src/verify/sandbox.ts` uses for the same reason — `detached:
 * true` so the child leads its own group, then `process.kill(-pid, …)` — including its reading of
 * `ESRCH` as success, which means the group was already gone.
 *
 * A timeout **throws**, and the message names the concrete command. It is never folded into a
 * status a caller could read as a verdict: a timed-out child has `status: null`, so
 * `expect(result.status).toBe(1)` would otherwise fail with "expected null to be 1" — true about
 * the number and silent about the budget.
 */
export interface BoundedChildResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class BoundedChildTimeout extends Error {}

export const runBoundedChild = async (
  file: string,
  argv: readonly string[],
  options: { cwd?: string; budgetMs: number },
): Promise<BoundedChildResult> => {
  const child = spawn(file, [...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    detached: true, // own process group so the bound can reap the whole tree
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

  // `ESRCH` means the group is already gone, which is the outcome this call wants. Every other
  // error is reported by returning false, so a caller can say the group outlived its signal
  // rather than assuming it did not.
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    const pid = child.pid;
    if (pid === undefined) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // SIGKILL rather than SIGTERM: this path exists for a child that is already not responding,
    // and a second grace period would only move the same wait later.
    signalGroup("SIGKILL");
  }, options.budgetMs);

  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("error", () => resolve({ code: null, signal: null }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );
  clearTimeout(timer);

  const shown = `${file} ${argv.join(" ")}`;
  if (timedOut) {
    throw new BoundedChildTimeout(
      `${shown} did not complete within ${options.budgetMs}ms; its process group was signalled ` +
        "SIGKILL. This is the child being bounded, not a verdict about what it was measuring",
    );
  }
  if (ended.code === null) {
    throw new BoundedChildTimeout(
      `${shown} produced no exit code (signal ${ended.signal ?? "none"}), so there is no verdict to read`,
    );
  }
  return { status: ended.code, stdout, stderr };
};
