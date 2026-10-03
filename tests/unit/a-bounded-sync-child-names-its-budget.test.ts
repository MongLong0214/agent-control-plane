import type * as ChildProcessModule from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { boundedExecFileSync, boundedSpawnSync, CHILD_BUDGET_MS } from "../helpers/bounded-sync-child.ts";

/**
 * The real functions, wrapped so the options the helper actually passes are observable. Without
 * this the default budget has no witness at all: waiting it out costs 55s, and asserting the
 * exported constant only says what the number is, not that either wrapper applies it.
 */
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync), execFileSync: vi.fn(actual.execFileSync) };
});
const { execFileSync, spawn, spawnSync } = await import("node:child_process");

/**
 * #872. The helper exists so a wedged synchronous child becomes a failure that names itself instead
 * of a vitest timeout reported against whichever test the stalled worker happened to hold. Nothing
 * in the converted files can witness that: they only ever run children that finish, so every one of
 * them stays green if the bound is deleted.
 *
 * These use a caller-supplied 700ms budget rather than `CHILD_BUDGET_MS`, because a witness that
 * waits out the real bound costs 55s per case and would itself be the slowest thing in the suite.
 * That the default is the value the files actually run under is asserted directly.
 */
describe("a bounded synchronous child", () => {
  it("turns a child that never answers into an error naming the command and the budget", () => {
    expect(() =>
      boundedSpawnSync("/bin/sleep", ["30"], { encoding: "utf8", timeout: 700 }),
    ).toThrowError(/\/bin\/sleep 30 did not answer within 700ms/);

    expect(() =>
      boundedExecFileSync("/bin/sleep", ["30"], { encoding: "utf8", timeout: 700 }),
    ).toThrowError(/\/bin\/sleep 30 did not answer within 700ms/);
  });

  it("honours a caller's own timeout rather than overwriting it with the default", () => {
    // The first shape spread `timeout: CHILD_BUDGET_MS` *after* the caller's options, so a site
    // that had already chosen a tighter bound silently got the looser one. The 700ms above is the
    // proof this no longer happens: at the default it would not have thrown inside the test's own
    // timeout at all.
    expect(CHILD_BUDGET_MS).toBe(55_000);
  });

  it("passes the default budget down when the caller supplies none", () => {
    // A merge-gate review found that nothing here measured this. The case above pins the constant
    // and the cases before it drive a caller-supplied 700ms, so a helper that forwarded no timeout
    // at all — or forwarded some other number — stayed green. Waiting out the real 55s is the only
    // direct observation, and it would be the slowest thing in the suite, so the options handed to
    // the subject are read instead.
    boundedSpawnSync("/bin/echo", ["bounded"], { encoding: "utf8" });
    expect(spawnSync).toHaveBeenLastCalledWith(
      "/bin/echo",
      ["bounded"],
      expect.objectContaining({ timeout: CHILD_BUDGET_MS }),
    );

    boundedExecFileSync("/bin/echo", ["bounded"], { encoding: "utf8" });
    expect(execFileSync).toHaveBeenLastCalledWith(
      "/bin/echo",
      ["bounded"],
      expect.objectContaining({ timeout: CHILD_BUDGET_MS }),
    );
  });

  it("leaves an ordinary nonzero exit reported as itself, not as the budget", () => {
    const refused = boundedSpawnSync("/bin/sh", ["-c", "exit 3"], { encoding: "utf8" });
    expect(refused.status).toBe(3);
    expect(refused.error).toBeUndefined();

    expect(() =>
      boundedExecFileSync("/bin/sh", ["-c", "exit 3"], { encoding: "utf8" }),
    ).toThrowError(/Command failed/);
  });
});

/**
 * `spawnSync`'s own timeout signals only the direct child, so a grandchild is reparented to PPID 1
 * and outlives the test — orphaned `install-launchd.sh install` and `fake-bin/security` processes
 * were seen doing so for over an hour. With `detached: true` the helper signals the child's whole
 * process group on a timeout: SIGTERM, a bounded wait, then SIGKILL.
 *
 * The child is an existing `/bin/sh` given its script as an argument, not a file written for the
 * run, so these cases add no executable inode to syspolicyd's provenance table. It starts a
 * grandchild, records the grandchild's pid in a file, and waits on it, so the 1s budget always
 * expires with the grandchild still running.
 */
describe("a timed-out detached child takes its process group with it", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const grandchildScript = (ignoreTerm: boolean): string =>
    `( ${ignoreTerm ? "trap '' TERM; " : ""}exec /bin/sleep 30 ) & echo $! > "$1"; wait`;

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  /** Runs `call` against a fresh pid file and returns the grandchild pid and the elapsed time. */
  const timeOutWithGrandchild = (
    ignoreTerm: boolean,
    call: (argv: readonly string[]) => unknown,
  ): { grandchild: number; elapsedMs: number } => {
    const dir = mkdtempSync(join(tmpdir(), "acp-bounded-grandchild-"));
    scratch.push(dir);
    const pidFile = join(dir, "grandchild.pid");
    const started = Date.now();
    let grandchild = Number.NaN;
    try {
      expect(() => call(["-c", grandchildScript(ignoreTerm), "sh", pidFile])).toThrowError(
        /\/bin\/sh -c .* did not answer within 1000ms/,
      );
      const elapsedMs = Date.now() - started;
      grandchild = Number(readFileSync(pidFile, "utf8").trim());
      expect(grandchild, "the child recorded no grandchild pid").toBeGreaterThan(1);
      expect(alive(grandchild), `grandchild ${grandchild} outlived its timed-out parent`).toBe(false);
      return { grandchild, elapsedMs };
    } finally {
      // A failing case must not leave the orphan it is about behind for the next test.
      if (!Number.isInteger(grandchild) && existsSync(pidFile)) {
        grandchild = Number(readFileSync(pidFile, "utf8").trim());
      }
      if (Number.isInteger(grandchild) && grandchild > 1 && alive(grandchild)) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          // Already gone between the probe and the signal.
        }
      }
    }
  };

  it("reaps a grandchild that outlives its timed-out parent", () => {
    timeOutWithGrandchild(false, (argv) =>
      boundedSpawnSync("/bin/sh", argv, { encoding: "utf8", timeout: 1_000, detached: true }),
    );
  });

  it("escalates to SIGKILL for a grandchild that ignores SIGTERM", () => {
    const { elapsedMs } = timeOutWithGrandchild(true, (argv) =>
      boundedSpawnSync("/bin/sh", argv, { encoding: "utf8", timeout: 1_000, detached: true }),
    );
    // A lower bound, so load cannot make it fail: the SIGTERM grace only runs its full length when
    // the group is still there at the end of it. Without this, a `trap` that did not take would
    // turn the case into the one above and the SIGKILL step would have no witness.
    expect(elapsedMs, "the grandchild ended on SIGTERM, so SIGKILL was never needed").toBeGreaterThanOrEqual(
      2_500,
    );
  });

  it("reaps the group for boundedExecFileSync too", () => {
    timeOutWithGrandchild(false, (argv) =>
      boundedExecFileSync("/bin/sh", argv, { encoding: "utf8", timeout: 1_000, detached: true }),
    );
  });
});

/**
 * The cases above all have a direct child that dies on SIGTERM, so `spawnSync` returns as soon as
 * its own timeout signals that child and the group cleanup gets its turn. A direct child that
 * ignores SIGTERM is the case that was never covered: `spawnSync` waits for the direct child, so
 * cleanup that only starts once the call returns never starts at all. A review reproduced exactly
 * that through both wrappers — both groups stayed alive until an outside watchdog killed them.
 *
 * Here the leader and its grandchild both ignore SIGTERM, the budget is 100ms, and the group has
 * to be gone when the wrapper returns, within the escalation's own bound: the SIGTERM grace (2s,
 * which runs in full because nothing here honours SIGTERM — hence the lower bound) plus the
 * SIGKILL settle (1s) plus slack for starting the supervising process under load. A backstop
 * outside the call kills the group at 8s, so a regression fails in seconds instead of waiting out
 * the grandchild's 30s and leaves nothing behind.
 */
describe("a timed-out detached child whose leader ignores SIGTERM still takes its group with it", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const BACKSTOP_SECONDS = 8;
  const RESISTANT_SCRIPT = `trap '' TERM; ( exec /bin/sleep 30 ) & echo "$$ $!" > "$1"; wait`;

  const exists = (target: number): boolean => {
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  const forceKill = (target: number): void => {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone.
    }
  };

  const timeOutResistantGroup = (call: (argv: readonly string[]) => unknown): void => {
    const dir = mkdtempSync(join(tmpdir(), "acp-bounded-resistant-"));
    scratch.push(dir);
    const pidFile = join(dir, "pids");
    const backstop = spawn(
      "/bin/sh",
      [
        "-c",
        `sleep ${BACKSTOP_SECONDS}; read leader grandchild < "$1" && kill -KILL -"$leader" "$grandchild" 2>/dev/null`,
        "sh",
        pidFile,
      ],
      { detached: true, stdio: "ignore" },
    );
    backstop.unref();
    let leader = Number.NaN;
    let grandchild = Number.NaN;
    try {
      const started = Date.now();
      expect(() => call(["-c", RESISTANT_SCRIPT, "sh", pidFile])).toThrowError(
        /\/bin\/sh -c .* did not answer within 100ms/,
      );
      const elapsedMs = Date.now() - started;
      [leader, grandchild] = readFileSync(pidFile, "utf8").trim().split(" ").map(Number) as [number, number];
      expect(leader, "the leader recorded no pid").toBeGreaterThan(1);
      expect(grandchild, "the leader recorded no grandchild pid").toBeGreaterThan(1);
      expect(exists(-leader), `process group ${leader} outlived its timed-out call`).toBe(false);
      expect(exists(grandchild), `grandchild ${grandchild} outlived its timed-out call`).toBe(false);
      expect(elapsedMs, "the group was not escalated until something outside the call killed it").toBeLessThan(
        5_000,
      );
      expect(elapsedMs, "SIGKILL came without the SIGTERM grace before it").toBeGreaterThanOrEqual(2_000);
    } finally {
      if (backstop.pid !== undefined) forceKill(-backstop.pid);
      if (!Number.isInteger(leader) && existsSync(pidFile)) {
        [leader, grandchild] = readFileSync(pidFile, "utf8").trim().split(" ").map(Number) as [number, number];
      }
      if (Number.isInteger(leader) && leader > 1) forceKill(-leader);
      if (Number.isInteger(grandchild) && grandchild > 1) forceKill(grandchild);
    }
  };

  it("through boundedSpawnSync", () => {
    timeOutResistantGroup((argv) =>
      boundedSpawnSync("/bin/sh", argv, { encoding: "utf8", timeout: 100, detached: true }),
    );
  });

  it("through boundedExecFileSync", () => {
    timeOutResistantGroup((argv) =>
      boundedExecFileSync("/bin/sh", argv, { encoding: "utf8", timeout: 100, detached: true }),
    );
  });

  it("is reaped from the caller's side when the supervisor itself is killed", () => {
    // The supervisor holds the escalation, so a supervisor that dies holds nothing. `maxBuffer` is
    // the ordinary way that happens: `spawnSync` kills the process it ran — now the supervisor —
    // and the child it started would be left running. The supervisor records the child's pid
    // before anything else, and that record is what the caller reaps the group by.
    const dir = mkdtempSync(join(tmpdir(), "acp-bounded-overflow-"));
    scratch.push(dir);
    const pidFile = join(dir, "pids");
    let leader = Number.NaN;
    let grandchild = Number.NaN;
    try {
      const result = boundedSpawnSync(
        "/bin/sh",
        ["-c", `( exec /bin/sleep 30 ) & echo "$$ $!" > "$1"; head -c 2000000 /dev/zero; wait`, "sh", pidFile],
        { detached: true, maxBuffer: 1_000 },
      );
      [leader, grandchild] = readFileSync(pidFile, "utf8").trim().split(" ").map(Number) as [number, number];
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOBUFS");
      expect(result.pid, "the result names the supervisor rather than the child").toBe(leader);
      expect(exists(-leader), `process group ${leader} outlived its supervisor`).toBe(false);
      expect(exists(grandchild), `grandchild ${grandchild} outlived its supervisor`).toBe(false);
    } finally {
      if (Number.isInteger(leader) && leader > 1) forceKill(-leader);
      if (Number.isInteger(grandchild) && grandchild > 1) forceKill(grandchild);
    }
  });
});
