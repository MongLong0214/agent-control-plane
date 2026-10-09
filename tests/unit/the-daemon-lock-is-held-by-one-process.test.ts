import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * #1070 ACP-WORKER-03-LOCK, narrow review 5 — the single-instance lock is an exclusive SQLite lock
 * held by one process. Every witness here uses real processes: two lock objects in one process
 * share one owner as far as the operating system is concerned, so they prove nothing about two
 * daemons.
 */
afterAll(cleanupTempDirs);

const HELPER = fileURLToPath(new URL("../helpers/lock-holder-process.ts", import.meta.url));
const children: ChildProcess[] = [];
afterEach(() => {
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

interface Result { pid: number; allowed: boolean; reasonCode: string; held: boolean }

const holder = (state: string, id: string, mode: "lock" | "raw" | "daemon" | "startup-failure") => {
  const child = spawn(process.execPath, ["--experimental-transform-types", HELPER, state, id, mode], {
    cwd: process.cwd(), env: { ...process.env, TMPDIR: "/private/tmp" }, stdio: ["ignore", "ignore", "pipe"],
  });
  const errors: Buffer[] = [];
  child.stderr!.on("data", (chunk: Buffer) => errors.push(chunk));
  children.push(child);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })));
  let asked = 0;
  return {
    child,
    exited,
    result: async (): Promise<Result> => {
      await waitFor(() => existsSync(join(state, `${id}.result`)) || child.exitCode !== null, `${id}'s result`);
      if (!existsSync(join(state, `${id}.result`))) throw new Error(`${id} exited: ${Buffer.concat(errors).toString()}`);
      return JSON.parse(readFileSync(join(state, `${id}.result`), "utf8")) as Result;
    },
    ask: async (question: string): Promise<unknown> => {
      const n = asked++;
      writeFileSync(join(state, `.${id}.ask-${n}`), question);
      renameSync(join(state, `.${id}.ask-${n}`), join(state, `${id}.ask-${n}`));
      await waitFor(() => existsSync(join(state, `${id}.answer-${n}`)), `${id}'s answer to ${question}`);
      return (JSON.parse(readFileSync(join(state, `${id}.answer-${n}`), "utf8")) as { answer: unknown }).answer;
    },
    exit: async (): Promise<void> => {
      writeFileSync(join(state, `${id}.exit`), "exit");
      await exited;
    },
  };
};

const go = (state: string): void => writeFileSync(join(state, "go"), "go");

/** A fresh process's attempt, start to finish. */
const attempt = async (state: string, id: string, mode: "lock" | "raw" = "lock"): Promise<Result> => {
  const contender = holder(state, id, mode);
  const result = await contender.result();
  await contender.exit();
  return result;
};

describe("#1070 ACP-WORKER-03-LOCK one process holds the daemon lock", () => {
  it("two processes running a real Daemon.start() at once: exactly one holds", async () => {
    const state = tempDir("acp-lock-race-");
    const a = holder(state, "a", "daemon");
    const b = holder(state, "b", "daemon");
    go(state);
    // What each real start's own acquisition answered. A successful one holds its start, lock held,
    // until continued, so the other start's acquisition happens while it holds.
    const results = [await a.result(), await b.result()];
    expect(results.filter((result) => result.allowed && result.held), JSON.stringify(results)).toHaveLength(1);
    const refused = results.find((result) => !result.allowed)!;
    expect(refused.reasonCode, JSON.stringify(results)).toBe("DAEMON_ALREADY_RUNNING");
    expect(refused.held).toBe(false);
    for (const id of ["a", "b"]) writeFileSync(join(state, `${id}.continue`), "continue");
    await a.exit();
    await b.exit();
  }, 240_000);

  it("a holder killed with SIGKILL leaves the lock to the next process", async () => {
    const state = tempDir("acp-lock-sigkill-");
    const first = holder(state, "first", "lock");
    go(state);
    expect((await first.result()).allowed).toBe(true);
    expect((await attempt(state, "while-held")).allowed).toBe(false);
    first.child.kill("SIGKILL");
    expect((await first.exited).signal).toBe("SIGKILL");
    const next = await attempt(state, "after-kill");
    expect(next.allowed, next.reasonCode).toBe(true);
  }, 240_000);

  it("a start that fails after taking the lock releases it, while that process still runs", async () => {
    const state = tempDir("acp-lock-startup-failure-");
    const failed = holder(state, "failed", "startup-failure");
    go(state);
    const result = await failed.result();
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("DAEMON_STARTUP_FAILED");
    expect(result.held).toBe(false);
    expect(failed.child.exitCode).toBeNull();
    const next = await attempt(state, "after-failure");
    expect(next.allowed, next.reasonCode).toBe(true);
    await failed.exit();
  }, 240_000);

  it.each(["deleted", "replaced"] as const)("a lock file %s while held does not let a second process acquire", async (how) => {
    const state = tempDir(`acp-lock-${how}-`);
    const first = holder(state, "first", "lock");
    go(state);
    expect((await first.result()).allowed).toBe(true);
    const lockFile = new SingleInstanceLock(join(state, "agentcpd.lock")).lockDatabasePath;
    if (how === "deleted") {
      unlinkSync(lockFile);
    } else {
      writeFileSync(`${lockFile}.other`, "");
      renameSync(`${lockFile}.other`, lockFile);
    }
    const second = await attempt(state, "second");
    expect(second.allowed, "a second process locked a new file at the lock's path").toBe(false);
    expect(second.reasonCode).toBe("DAEMON_ALREADY_RUNNING");
    expect(await first.ask("held")).toBe(true);
    await first.exit();
  }, 240_000);

  it("a lock file that is a symbolic link is not locked through: the file locked must be the path itself", () => {
    const state = tempDir("acp-lock-symlink-");
    const elsewhere = join(state, "elsewhere.db");
    writeFileSync(elsewhere, "");
    const lock = new SingleInstanceLock(join(state, "agentcpd.lock"));
    symlinkSync(elsewhere, lock.lockDatabasePath);
    const refused = lock.acquire(new Date().toISOString());
    expect(refused.allowed, "the lock was taken on whatever the link pointed at").toBe(false);
    expect(lock.held()).toBe(false);
  });

  it("with the holder's record gone, the operating-system lock alone still refuses a second process", async () => {
    const state = tempDir("acp-lock-os-only-");
    const first = holder(state, "first", "lock");
    go(state);
    expect((await first.result()).allowed).toBe(true);
    unlinkSync(join(state, "agentcpd.lock"));
    const second = await attempt(state, "second");
    expect(second.allowed, "only the holder record was keeping a second process out").toBe(false);
    expect(second.reasonCode).toBe("DAEMON_ALREADY_RUNNING");
    await first.exit();
  }, 240_000);

  it("another SQLite connection opened and closed in the holder does not release the lock", async () => {
    const state = tempDir("acp-lock-second-connection-");
    const first = holder(state, "first", "lock");
    go(state);
    expect((await first.result()).allowed).toBe(true);
    expect(await first.ask("second-connection")).toBe("SQLITE_BUSY");
    expect((await attempt(state, "after-second-connection")).allowed).toBe(false);
    await first.exit();
  }, 240_000);

  it("a stopped holder still holds; a terminated one does not", async () => {
    const state = tempDir("acp-lock-signals-");
    const first = holder(state, "first", "lock");
    go(state);
    expect((await first.result()).allowed).toBe(true);
    first.child.kill("SIGSTOP");
    try {
      expect((await attempt(state, "while-stopped")).allowed).toBe(false);
    } finally {
      first.child.kill("SIGCONT");
    }
    expect((await attempt(state, "after-continue")).allowed).toBe(false);
    first.child.kill("SIGTERM");
    await first.exited;
    expect((await attempt(state, "after-terminate")).allowed).toBe(true);
  }, 240_000);

  it("an earlier build's daemon still running on the pathname lock refuses a new one; a dead one does not", async () => {
    const state = tempDir("acp-lock-earlier-build-");
    go(state);
    const running = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    children.push(running);
    const lockPath = join(state, "agentcpd.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: running.pid, startedAt: new Date().toISOString(), path: lockPath }));
    const refused = await attempt(state, "beside-a-running-one");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe("DAEMON_ALREADY_RUNNING");
    running.kill("SIGKILL");
    await waitFor(() => running.exitCode !== null || running.signalCode !== null, "the earlier daemon to end");
    expect((await attempt(state, "after-it-ended")).allowed).toBe(true);
  }, 240_000);

  it("the limit, pinned: a plain descriptor closed in the holder drops the OS lock, and the record still refuses", async () => {
    // POSIX record locks belong to the process, so closing any descriptor on the file releases them.
    // This is why nothing in a holder opens `<lock>.db` except the lock's own connection. Should it
    // happen, the operating-system lock is gone, and only the holder record still stops a second
    // daemon; both halves are pinned so that neither can change unnoticed.
    const state = tempDir("acp-lock-plain-descriptor-");
    const first = holder(state, "first", "lock");
    go(state);
    expect((await first.result()).allowed).toBe(true);
    expect((await attempt(state, "raw-before", "raw")).allowed).toBe(false);
    expect(await first.ask("plain-descriptor")).toBe("closed");
    expect((await attempt(state, "raw-after", "raw")).allowed, "the OS lock survived a closed descriptor").toBe(true);
    const daemon = await attempt(state, "after-plain-descriptor");
    expect(daemon.allowed).toBe(false);
    expect(daemon.reasonCode).toBe("DAEMON_ALREADY_RUNNING");
    await first.exit();
  }, 240_000);
});
