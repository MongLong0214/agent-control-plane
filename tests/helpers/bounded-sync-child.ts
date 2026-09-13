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
 * direct child, so a grandchild survives (measured: `grandchildStillAlive: true`). What it buys is
 * that "forever" becomes a failure naming the command — which matters because an unbounded
 * `spawnSync` stops vitest's own per-test timeout from ever firing, and the timeout it eventually
 * reports lands on whichever test the stalled worker happened to be holding.
 *
 * 55s: just under the `testTimeout: 60_000` that governs the smallest enclosing test in every
 * file using this helper, so the bound is what fires and names itself rather than a per-test
 * timeout landing on another test.
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

const timedOut = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";

const budgetFailure = (file: string, argv: readonly string[], budgetMs: number): Error =>
  new Error(
    `${file} ${argv.join(" ")} did not answer within ${budgetMs}ms — this is the bound, ` +
      "not a verdict about what it was measuring",
  );

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
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function boundedSpawnSync(
  file: string,
  argv: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function boundedSpawnSync(
  file: string,
  argv?: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer>;
export function boundedSpawnSync(
  file: string,
  argvOrOptions?: readonly string[] | SpawnSyncOptions,
  maybeOptions?: SpawnSyncOptions,
): SpawnSyncReturns<string> | SpawnSyncReturns<Buffer> {
  const argv = Array.isArray(argvOrOptions) ? [...(argvOrOptions as readonly string[])] : [];
  const options =
    (Array.isArray(argvOrOptions) ? maybeOptions : (argvOrOptions as SpawnSyncOptions)) ?? {};
  const timeout = options.timeout ?? CHILD_BUDGET_MS;
  const result = spawnSync(file, argv, { ...options, timeout });
  if (timedOut(result.error)) throw budgetFailure(file, argv, timeout);
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
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function boundedExecFileSync(
  file: string,
  argv?: readonly string[],
  options?: ExecFileSyncOptions,
): Buffer;
export function boundedExecFileSync(
  file: string,
  argv: readonly string[] = [],
  options: ExecFileSyncOptions = {},
): string | Buffer {
  const timeout = options.timeout ?? CHILD_BUDGET_MS;
  try {
    return execFileSync(file, [...argv], { ...options, timeout }) as string;
  } catch (error) {
    if (timedOut(error)) throw budgetFailure(file, argv, timeout);
    throw error;
  }
}
