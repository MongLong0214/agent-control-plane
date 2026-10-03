import { execFileSync, spawnSync } from "node:child_process";
import type {
  ExecFileSyncOptions,
  ExecFileSyncOptionsWithStringEncoding,
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";

/**
 * A time bound for the synchronous children tests start (#872).
 *
 * `tests/helpers/bounded-child.ts` is the stronger tool and should be preferred: it spawns, so the
 * event loop keeps turning, and it reaps the child's whole process group at the budget. It is also
 * `async`, and most call sites here are synchronous with hundreds of callers between them — making
 * those async is its own change, repeated.
 *
 * So this is the weaker bound that fits a synchronous site, and the difference is stated rather
 * than glossed: it still blocks the loop for up to the budget, and `timeout` signals only the
 * direct child, so a grandchild survives (measured: `grandchildStillAlive: true`) unless the
 * caller passes `detached: true`, which adds the group kill described at `terminateGroup`. What it buys is
 * that "forever" becomes a failure naming the command — which matters because an unbounded
 * `spawnSync` stops vitest's own per-test timeout from ever firing, and the timeout it eventually
 * reports lands on whichever test the stalled worker happened to be holding.
 *
 * 55s: just under this repository's `testTimeout: 60_000`, so for a case that takes the global
 * limit the bound is what fires and names itself rather than a per-test timeout landing on
 * another test.
 *
 * **It is the default, not a guarantee about the call site.** A case that declares its own
 * shorter timeout is over before 55s could fire, and there the default is not a bound at all —
 * found in `the-database-backup-step-fails-closed.test.ts`, where one case declares `20_000` and
 * its three children are a `find` and two `sqlite3` invocations. Those pass their own
 * `timeout`. Anything converted into a case with a timeout under this default has to do the
 * same, and nothing here can check that: this helper cannot see the timeout of the `it` that
 * encloses its caller.
 *
 * The number is a wedge threshold, and it had to be measured to stay one. 30s was the first value,
 * chosen because it reads as generous; on an idle host `rollback-pair-wal.test.ts`'s
 * "replaces generation B's runtime and database together" takes **39,412ms** in a passing run, and
 * on a loaded one the 30s bound fired against a child that was doing its job. A bound below what a
 * green run costs is not a bound, it is a performance assertion that fails first under load. A call
 * site whose child should never be slow can still say so by passing its own `timeout`, which this
 * helper honours rather than overwrites.
 *
 * `killed` is deliberately never read. Measured in this repository, a timeout gives
 * `status: null`, `signal: "SIGTERM"`, `killed: undefined` and `error.code: "ETIMEDOUT"` — a
 * comment asserting otherwise was once the alibi for an always-false branch here.
 */
export const CHILD_BUDGET_MS = 55_000;

/**
 * `@types/node` types `detached` onto the async `SpawnOptions` only, not onto
 * `SpawnSyncOptions`/`ExecFileSyncOptions` — but the sync bindings share `normalizeSpawnArguments`
 * with the async ones underneath and do honour it at runtime: measured here, a `spawnSync` child
 * given `detached: true` reports its own pid as its pgid, i.e. it is the leader of its own
 * process group rather than a member of this worker's. These local types add back the field the
 * upstream types omit so a caller can opt into the group-kill-on-timeout behaviour below without
 * a cast.
 */
type DetachableSpawnSyncOptions = SpawnSyncOptions & { detached?: boolean };
type DetachableSpawnSyncOptionsWithStringEncoding = SpawnSyncOptionsWithStringEncoding & {
  detached?: boolean;
};
type DetachableExecFileSyncOptions = ExecFileSyncOptions & { detached?: boolean };
type DetachableExecFileSyncOptionsWithStringEncoding = ExecFileSyncOptionsWithStringEncoding & {
  detached?: boolean;
};

const timedOut = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";

const budgetFailure = (file: string, argv: readonly string[], budgetMs: number): Error =>
  new Error(
    `${file} ${argv.join(" ")} did not answer within ${budgetMs}ms — this is the bound, ` +
      "not a verdict about what it was measuring",
  );

/**
 * A timed-out child's whole process group is terminated, not just the direct child — for a caller
 * that passes `detached: true`. Node's own `timeout` handling for `spawnSync` / `execFileSync`
 * signals only the direct child's pid; anything that child forked keeps running after it dies,
 * reparented to PPID 1. Observed on a development host: orphaned `install-launchd.sh install` and
 * `fake-bin/security` processes with PPID 1 outlived their timed-out test by more than an hour.
 *
 * `detached: true` makes the direct child the leader of a new process group (pgid === its pid),
 * so `-pid` addresses that subtree and never this worker's own group. The group outlives its
 * leader for as long as any member is alive, so it is still addressable after `spawnSync` has
 * killed and reaped the leader and returned. On timeout: SIGTERM to the group, wait until the
 * group is gone or `GROUP_SIGTERM_GRACE_MS` passes, then SIGKILL to the group and wait again,
 * bounded by `GROUP_SIGKILL_SETTLE_MS`. Then the budget error is thrown as before.
 *
 * This runs only once `spawnSync` has returned, and `spawnSync` returns only after the direct
 * child exits: a direct child that ignores Node's `killSignal` (SIGTERM unless the caller sets
 * one) still wedges the call. Measured with a `trap '' TERM` child; a grandchild that ignores
 * SIGTERM is handled, by the SIGKILL step.
 *
 * Opt-in rather than the default: without `detached` the child shares this worker's group and
 * `-pid` names no group this helper owns, so a caller that does not ask gets exactly the old
 * behaviour. Widening the default changes all 49 importing files, not the sites this targets.
 *
 * Why the sync site is kept rather than moved to `bounded-child.ts`'s async `runBoundedChild`
 * (which reaps the group unconditionally): that helper takes no `env`, and
 * `deploy-launchd.test.ts`'s `runInstaller` — 77 call sites — passes a per-test `env` and is
 * called from synchronous `it(...)` bodies. Moving it means extending that helper and making every
 * one of those bodies `async`; the group kill above gives the same cleanup at the one site.
 */
const GROUP_SIGTERM_GRACE_MS = 2_000;
const GROUP_SIGKILL_SETTLE_MS = 1_000;
const GROUP_POLL_MS = 25;

const blockingWait = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Best-effort: this runs just before the real budget-exceeded error is thrown, and a secondary
 * error from a group that is already gone (`ESRCH`) or never existed must not shadow it.
 */
const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: already gone, which is what a terminator wants.
  }
};

/** Signal 0 probes without delivering; anything but `ESRCH` means some member is still there. */
const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const waitForGroupExit = (pgid: number, budgetMs: number): boolean => {
  const deadline = Date.now() + budgetMs;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    blockingWait(GROUP_POLL_MS);
  }
  return true;
};

const terminateGroup = (pgid: number | undefined): void => {
  if (pgid === undefined || pgid <= 0) return;
  signalGroup(pgid, "SIGTERM");
  if (waitForGroupExit(pgid, GROUP_SIGTERM_GRACE_MS)) return;
  signalGroup(pgid, "SIGKILL");
  waitForGroupExit(pgid, GROUP_SIGKILL_SETTLE_MS);
};

/**
 * The overloads mirror `spawnSync`'s own, including its two-argument form.
 *
 * A single signature over `Parameters<typeof spawnSync>` was the first shape and it changed what
 * callers get back: `spawnSync` returns strings under `encoding: "utf8"` and Buffers otherwise, so
 * collapsing the overloads made every `stdout + stderr` site stop type-checking. A wrapper that
 * narrows its subject's type is a wrapper that changes it.
 */
export function boundedSpawnSync(
  file: string,
  options: DetachableSpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function boundedSpawnSync(
  file: string,
  argv: readonly string[],
  options: DetachableSpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function boundedSpawnSync(
  file: string,
  argv?: readonly string[],
  options?: DetachableSpawnSyncOptions,
): SpawnSyncReturns<Buffer>;
export function boundedSpawnSync(
  file: string,
  argvOrOptions?: readonly string[] | DetachableSpawnSyncOptions,
  maybeOptions?: DetachableSpawnSyncOptions,
): SpawnSyncReturns<string> | SpawnSyncReturns<Buffer> {
  const argv = Array.isArray(argvOrOptions) ? [...(argvOrOptions as readonly string[])] : [];
  const options =
    (Array.isArray(argvOrOptions) ? maybeOptions : (argvOrOptions as DetachableSpawnSyncOptions)) ?? {};
  const timeout = options.timeout ?? CHILD_BUDGET_MS;
  const result = spawnSync(file, argv, { ...options, timeout });
  if (timedOut(result.error)) {
    if (options.detached === true) terminateGroup(result.pid);
    throw budgetFailure(file, argv, timeout);
  }
  return result as SpawnSyncReturns<string>;
}

/**
 * `execFileSync` throws on a nonzero exit, so its budget arrives as a thrown error rather than in
 * a result field. The two are told apart by `code`, and every other failure keeps its own message
 * and its own `status`/`stderr` — a caller inspecting those still sees what it expects.
 */
export function boundedExecFileSync(
  file: string,
  argv: readonly string[],
  options: DetachableExecFileSyncOptionsWithStringEncoding,
): string;
export function boundedExecFileSync(
  file: string,
  argv?: readonly string[],
  options?: DetachableExecFileSyncOptions,
): Buffer;
export function boundedExecFileSync(
  file: string,
  argv: readonly string[] = [],
  options: DetachableExecFileSyncOptions = {},
): string | Buffer {
  const timeout = options.timeout ?? CHILD_BUDGET_MS;
  try {
    return execFileSync(file, [...argv], { ...options, timeout }) as string;
  } catch (error) {
    if (timedOut(error)) {
      if (options.detached === true) terminateGroup((error as NodeJS.ErrnoException & { pid?: number }).pid);
      throw budgetFailure(file, argv, timeout);
    }
    throw error;
  }
}
