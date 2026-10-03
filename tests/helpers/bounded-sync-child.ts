import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * caller passes `detached: true`, which hands the child to the supervisor described at
 * `superviseSync` and gets its whole group escalated on a timeout. What it buys is
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
 * On timeout: the caller's `killSignal` (SIGTERM unless it set one) to the group, wait until the
 * group is gone or `GROUP_SIGTERM_GRACE_MS` passes, then SIGKILL to the group and wait again,
 * bounded by `GROUP_SIGKILL_SETTLE_MS`. Then the budget error is thrown as before.
 *
 * That sequence cannot run in this process. `spawnSync` returns only once its direct child has
 * exited, so cleanup that starts after the call returns never starts for a direct child that
 * ignores the signal Node's own timeout sends it: measured with a `trap '' TERM` leader, both
 * wrappers stayed blocked until something outside the call killed the group. So the escalation
 * lives in `superviseSync`'s supervising process instead, which is what `spawnSync` waits on here.
 *
 * Opt-in rather than the default: without `detached` the child shares this worker's group and
 * `-pid` names no group this helper owns, so a caller that does not ask gets exactly the old
 * behaviour. Widening the default changes all 49 importing files, not the sites this targets. It
 * also costs one `node` start per call: measured 46ms a call supervised against 6ms direct, for a
 * `/bin/sh -c 'exit 0'`.
 *
 * Why the sync site is kept rather than moved to `bounded-child.ts`'s async `runBoundedChild`
 * (which reaps the group unconditionally): that helper takes no `env`, and
 * `deploy-launchd.test.ts`'s `runInstaller` — 77 call sites — passes a per-test `env` and is
 * called from synchronous `it(...)` bodies. Moving it means extending that helper and making every
 * one of those bodies `async`; the supervisor gives the same cleanup at the one site.
 */
const GROUP_SIGTERM_GRACE_MS = 2_000;
const GROUP_SIGKILL_SETTLE_MS = 1_000;
const GROUP_POLL_MS = 25;
/**
 * The supervisor's own bound, past the child's budget and both escalation waits. It fires only if
 * the supervisor itself stops answering, and then the group is still reaped from here, because the
 * supervisor records the child's pid before it waits on anything.
 */
const SUPERVISOR_SLACK_MS = 5_000;
/** `NODE_OPTIONS` is meant for the child, not for the supervisor that starts it. */
const NODE_OPTIONS_CARRIER = "ACP_BOUNDED_CHILD_NODE_OPTIONS";

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

/** The fallback for a supervisor that did not finish: the same escalation, from this side. */
const terminateGroup = (pgid: number | undefined): void => {
  if (pgid === undefined || pgid <= 0) return;
  signalGroup(pgid, "SIGTERM");
  if (waitForGroupExit(pgid, GROUP_SIGTERM_GRACE_MS)) return;
  signalGroup(pgid, "SIGKILL");
  waitForGroupExit(pgid, GROUP_SIGKILL_SETTLE_MS);
};

/**
 * The supervising process, as source for `node -e`: the same interpreter this worker runs, so it
 * adds no executable file, and nothing it does depends on the child honouring a signal.
 *
 * It starts the child as the leader of a new process group (`detached`), records the child's pid
 * at once, and relays the child's stdout and stderr to its own — it owns those pipes, so it sees
 * the same "exited and every pipe closed" moment `spawnSync` would have waited for, and the same
 * budget from it. stdin is handed straight through. On the budget it does what `spawnSync` does to
 * the pipes (closes them) and then escalates against the group; the records it leaves are read by
 * `superviseSync`, never parsed out of the child's own output.
 *
 * The escalation polls on timers rather than blocking, and that is load-bearing. The leader is the
 * supervisor's own child, so once it dies it stays a zombie until the supervisor's event loop reaps
 * it — and a zombie still answers `kill(-pgid, 0)`. Measured: with a blocking poll, a group whose
 * every member died on SIGTERM still ran the full grace and the full settle (4.2s on a 1s budget).
 */
const SUPERVISOR_SOURCE = `"use strict";
const { spawn } = require("node:child_process");
const { renameSync, writeFileSync, writeSync } = require("node:fs");
const c = JSON.parse(process.argv[1]);
const env = { ...process.env };
delete env[c.nodeOptionsCarrier];
if (process.env[c.nodeOptionsCarrier] !== undefined) env.NODE_OPTIONS = process.env[c.nodeOptionsCarrier];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
const signal = (pgid, name) => { try { process.kill(-pgid, name); } catch {} };
const record = (value) => { writeFileSync(c.report + ".tmp", JSON.stringify(value)); renameSync(c.report + ".tmp", c.report); };
const relay = (fd) => (chunk) => { for (let at = 0; at < chunk.length; ) { try { at += writeSync(fd, chunk, at); } catch (e) { if (e.code !== "EAGAIN") return; pause(1); } } };
const child = spawn(c.file, c.args, { detached: true, env, stdio: c.stdio, argv0: c.argv0, shell: c.shell });
if (child.pid === undefined) {
  child.once("error", (e) => record({ error: { code: e.code, errno: e.errno } }));
} else {
  const pid = child.pid;
  record({ pid });
  let settled = false;
  child.on("error", () => {});
  if (child.stdout) child.stdout.on("data", relay(1));
  if (child.stderr) child.stderr.on("data", relay(2));
  const timer = setTimeout(() => {
    settled = true;
    if (child.stdout) child.stdout.destroy();
    if (child.stderr) child.stderr.destroy();
    signal(pid, c.killSignal);
    const graceEnd = Date.now() + c.graceMs;
    let settleEnd;
    const poll = () => {
      const now = Date.now();
      if (alive(pid) && (settleEnd === undefined || now < settleEnd)) {
        if (settleEnd === undefined && now >= graceEnd) { signal(pid, "SIGKILL"); settleEnd = now + c.settleMs; }
        setTimeout(poll, c.pollMs);
        return;
      }
      record({ pid, timedOut: true });
      process.exit(0);
    };
    setTimeout(poll, c.pollMs);
  }, c.timeoutMs);
  child.once("close", (status, name) => {
    if (settled) return;
    clearTimeout(timer);
    record({ pid, status, signal: name });
    process.exit(0);
  });
}
`;

type StdioMode = "pipe" | "inherit" | "ignore";

/**
 * The stdio shapes a supervised child supports: the three named modes, per stream or for all
 * three. A stream object or an extra descriptor cannot be handed through a second process
 * faithfully, so it is refused by name rather than approximated.
 */
const stdioModes = (stdio: SpawnSyncOptions["stdio"]): [StdioMode, StdioMode, StdioMode] => {
  const named = (entry: unknown): StdioMode => {
    if (entry === undefined || entry === null) return "pipe";
    if (entry === "pipe" || entry === "inherit" || entry === "ignore") return entry;
    throw new TypeError(`a detached bounded child supports only "pipe", "inherit" or "ignore" stdio, not ${String(entry)}`);
  };
  if (stdio === undefined) return ["pipe", "pipe", "pipe"];
  if (typeof stdio === "string") return [named(stdio), named(stdio), named(stdio)];
  if (stdio.length > 3) throw new TypeError("a detached bounded child supports at most three stdio entries");
  return [named(stdio[0]), named(stdio[1]), named(stdio[2])];
};

interface SupervisorRecord {
  pid?: number;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: true;
  error?: { code: string; errno: number };
}

let recordDirectory: string | undefined;
let recordSequence = 0;
const nextRecordPath = (): string => {
  if (recordDirectory === undefined) {
    const directory = mkdtempSync(join(tmpdir(), "acp-bounded-supervisor-"));
    recordDirectory = directory;
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  }
  recordSequence += 1;
  return join(recordDirectory, `${recordSequence}.json`);
};

const takeRecord = (path: string): SupervisorRecord | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SupervisorRecord;
  } catch {
    return undefined;
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}.tmp`, { force: true });
  }
};

/** `argv0` is typed onto the spawn options only; `execFileSync` honours it at runtime too. */
type DetachedOptions = SpawnSyncOptions & { detached?: boolean };

/**
 * Runs `file` under the supervisor and answers in `spawnSync`'s own shape: the child's pid, its
 * status and signal, and its output, as if `spawnSync` had run it directly. `timedOut` replaces
 * the `ETIMEDOUT` error a caller would otherwise have to recognise.
 */
const superviseSync = (
  file: string,
  argv: readonly string[],
  options: DetachedOptions,
  timeout: number,
): { result: SpawnSyncReturns<string | Buffer>; timedOut: boolean } => {
  const modes = stdioModes(options.stdio);
  const recordPath = nextRecordPath();
  const {
    detached: _detached,
    timeout: _timeout,
    killSignal,
    env,
    stdio: _stdio,
    argv0,
    shell,
    ...passthrough
  } = options;
  const { NODE_OPTIONS: nodeOptions, ...childEnv } = env ?? process.env;
  const config = {
    file,
    args: [...argv],
    argv0,
    shell,
    // stdin is handed through as it is; stdout and stderr are relayed, so the supervisor owns them.
    stdio: [modes[0] === "pipe" ? "inherit" : modes[0], modes[1], modes[2]],
    timeoutMs: timeout,
    killSignal: killSignal ?? "SIGTERM",
    graceMs: GROUP_SIGTERM_GRACE_MS,
    settleMs: GROUP_SIGKILL_SETTLE_MS,
    pollMs: GROUP_POLL_MS,
    report: recordPath,
    nodeOptionsCarrier: NODE_OPTIONS_CARRIER,
  };
  const outer = spawnSync(process.execPath, ["-e", SUPERVISOR_SOURCE, "--", JSON.stringify(config)], {
    ...passthrough,
    env: nodeOptions === undefined ? childEnv : { ...childEnv, [NODE_OPTIONS_CARRIER]: nodeOptions },
    stdio: modes,
    timeout: timeout + GROUP_SIGTERM_GRACE_MS + GROUP_SIGKILL_SETTLE_MS + SUPERVISOR_SLACK_MS,
    killSignal: "SIGKILL",
  });
  const record = takeRecord(recordPath);

  if (record?.error !== undefined) {
    const { code, errno } = record.error;
    const error = Object.assign(new Error(`spawnSync ${file} ${code}`), {
      errno,
      code,
      syscall: `spawnSync ${file}`,
      path: file,
      spawnargs: [...argv],
    });
    // `spawnSync`'s own shape for a child that never started: no output at all, not empty output.
    const notStarted = { error, status: null, signal: null, output: null, pid: 0, stdout: undefined, stderr: undefined };
    return { result: notStarted as unknown as SpawnSyncReturns<string | Buffer>, timedOut: false };
  }
  if (record?.timedOut === true) return { result: outer, timedOut: true };
  if (record !== undefined && "status" in record) {
    return {
      result: {
        pid: record.pid ?? outer.pid,
        output: outer.output.slice(0, 3),
        stdout: outer.stdout,
        stderr: outer.stderr,
        status: record.status ?? null,
        signal: record.signal ?? null,
      },
      timedOut: false,
    };
  }

  // The supervisor did not finish: killed at its own bound, or by `spawnSync` for `maxBuffer`.
  // Its child's group is reaped from here, by the pid it recorded first.
  terminateGroup(record?.pid);
  if (timedOut(outer.error)) return { result: outer, timedOut: true };
  if (outer.error !== undefined) return { result: { ...outer, pid: record?.pid ?? outer.pid }, timedOut: false };
  throw new Error(
    `the supervisor for ${file} ${argv.join(" ")} exited (${outer.status ?? outer.signal}) without reporting ` +
      `its child: ${String(outer.stderr ?? "").slice(0, 400)}`,
  );
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
  if (options.detached === true) {
    const supervised = superviseSync(file, argv, options, timeout);
    if (supervised.timedOut) throw budgetFailure(file, argv, timeout);
    return supervised.result as SpawnSyncReturns<string>;
  }
  const result = spawnSync(file, argv, { ...options, timeout });
  if (timedOut(result.error)) throw budgetFailure(file, argv, timeout);
  return result as SpawnSyncReturns<string>;
}

/**
 * `execFileSync` throws on a nonzero exit, so its budget arrives as a thrown error rather than in
 * a result field. The two are told apart by `code`, and every other failure keeps its own message
 * and its own `status`/`stderr` — a caller inspecting those still sees what it expects.
 *
 * The detached form runs under the supervisor, so what `execFileSync` itself does with a
 * `spawnSync` result is done here instead, as Node does it (`lib/child_process.js`): with no
 * `stdio` option the child's stderr is echoed to this process's, a spawn error is thrown carrying
 * the result, and a nonzero exit throws `Command failed: <file> <args>` with the stderr appended.
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
  if (options.detached === true) {
    const { result, timedOut: expired } = superviseSync(file, argv, options as DetachedOptions, timeout);
    if (expired) throw budgetFailure(file, argv, timeout);
    if (options.stdio === undefined && result.stderr) process.stderr.write(result.stderr);
    if (result.error !== undefined) throw Object.assign(result.error, result);
    if (result.status !== 0) {
      const stderr = result.stderr && result.stderr.length > 0 ? `\n${result.stderr.toString()}` : "";
      const command = [(options as DetachedOptions).argv0 ?? file, ...argv].join(" ");
      throw Object.assign(new Error(`Command failed: ${command}${stderr}`), result);
    }
    return result.stdout;
  }
  try {
    return execFileSync(file, [...argv], { ...options, timeout }) as string;
  } catch (error) {
    if (timedOut(error)) throw budgetFailure(file, argv, timeout);
    throw error;
  }
}
