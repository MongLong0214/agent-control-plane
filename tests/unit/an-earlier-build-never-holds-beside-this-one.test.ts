import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";

/**
 * #1070 ACP-WORKER-03-LOCK, narrow reviews 6 and 7 — an earlier build and this one never both hold.
 *
 * An earlier build's lock is the pathname `agentcpd.lock` alone: it reclaims a record naming a dead
 * process by unlinking the path without checking what it removes, then links its own record into
 * place. This build holds an exclusive SQLite lock on `agentcpd.lock.db`, which an earlier build does
 * not know. So the pathname is where the two schemes meet, and no care taken on this side when
 * reclaiming can stop an earlier reclaimer's blind unlink. These witnesses run real `Daemon.start()`
 * processes on both sides — one with this build's lock, one with an earlier build's acquisition
 * protocol (main `56c1d019`, the deployed generation; and `3cb969a4`) — and pause this build right
 * after it has read the holder record under its SQLite lock, which is where the review's interleaving
 * let both hold.
 *
 * Narrow review 7: a record earlier builds read as incomplete, kept from them only by a modification
 * time pinned in the future, went back to their five-second reclaim after an ordinary `touch`, a copy
 * that did not keep times, or a clock past the pin. This build now holds the path as a directory,
 * which `unlink` cannot remove and `link` cannot replace, so those schedules run here too.
 */
const HELPER = fileURLToPath(new URL("../helpers/mixed-version-lock-process.ts", import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const stateDir = (): string => {
  const root = mkdtempSync(join("/tmp", "acp-mixed-lock-"));
  roots.push(root);
  return root;
};
const waitFor = async (condition: () => boolean, what: string, timeoutMs = 120_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const json = <T>(state: string, name: string): T => JSON.parse(readFileSync(join(state, name), "utf8")) as T;

interface Acquired { pid: number; build: string; allowed: boolean; reasonCode: string; message: string | null; held: boolean }
interface Held { pid: number; build: string; held: boolean; record: string | null }

const run = (
  state: string, id: string, build: "current" | "56c1d019" | "3cb969a4", pause: "none" | "after-read", now?: number,
) => {
  const child = spawn(process.execPath, ["--experimental-transform-types", HELPER, state, id, build, pause], {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: "/private/tmp", ...(now === undefined ? {} : { ACP_WITNESS_NOW: String(now) }) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errors: Buffer[] = [];
  child.stderr!.on("data", (chunk: Buffer) => errors.push(chunk));
  children.push(child);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const published = async (name: string): Promise<void> => {
    await waitFor(() => existsSync(join(state, `${id}.${name}`)) || child.exitCode !== null, `${id}.${name}`);
    if (!existsSync(join(state, `${id}.${name}`))) {
      throw new Error(`${id} exited before ${name}: ${Buffer.concat(errors).toString().slice(-2000)}`);
    }
  };
  return {
    child,
    exited,
    acquired: async (): Promise<Acquired> => {
      await published("acquired");
      return json<Acquired>(state, `${id}.acquired`);
    },
    paused: () => published("read"),
    resume: () => writeFileSync(join(state, `${id}.resume`), "resume"),
    held: async (): Promise<Held> => {
      await published("held");
      return json<Held>(state, `${id}.held`);
    },
    exit: async (): Promise<void> => {
      writeFileSync(join(state, `${id}.exit`), "exit");
      await exited;
    },
  };
};

/** Where the holder record is: this build's, inside its directory, or a record file at the path. */
const holderRecordAt = (lockPath: string): string =>
  lstatSync(lockPath).isDirectory() ? join(lockPath, "holder.json") : lockPath;

/** A pid that answered once and is now gone. */
const deadPid = (): number => {
  const pid = Number(boundedSpawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
};

/** Both report whether they hold, at the same moment; at most one may. */
const holders = async (state: string, ...processes: ReturnType<typeof run>[]): Promise<Held[]> => {
  writeFileSync(join(state, "check"), "check");
  const answers = await Promise.all(processes.map((p) => p.held()));
  return answers.filter((answer) => answer.held);
};

describe.each(["56c1d019", "3cb969a4"] as const)("an earlier build (%s) beside this one", (earlier) => {
  it("a dead earlier-build record: an earlier build reclaiming it while this one is paused after reading it, never both hold", async () => {
    const state = stateDir();
    const lockPath = join(state, "agentcpd.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startedAt: "2026-10-01T00:00:00.000Z", path: lockPath }), { mode: 0o600 });
    const current = run(state, "current", "current", "after-read");
    await current.paused();
    const old = run(state, "old", earlier, "none");
    const oldAcquired = await old.acquired();
    current.resume();
    const currentAcquired = await current.acquired();
    const held = await holders(state, current, old);
    expect(held.length, JSON.stringify({ oldAcquired, currentAcquired, held })).toBeLessThanOrEqual(1);
    // This build never removes or replaces an earlier build's record, dead or not.
    expect(currentAcquired.allowed).toBe(false);
    await Promise.all([current.exit(), old.exit()]);
  }, 240_000);

  it("an empty lock path: an earlier build linking its record while this one is paused after reading nothing, never both hold", async () => {
    const state = stateDir();
    const current = run(state, "current", "current", "after-read");
    await current.paused();
    const old = run(state, "old", earlier, "none");
    const oldAcquired = await old.acquired();
    expect(oldAcquired.allowed, "the earlier build found the path empty and linked its record").toBe(true);
    // Past the five-second grace an unreadable record gets: this build read nothing, and what it finds
    // at the path now is a complete record it never read, not one still being written.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    current.resume();
    const currentAcquired = await current.acquired();
    const held = await holders(state, current, old);
    expect(held.length, JSON.stringify({ oldAcquired, currentAcquired, held })).toBeLessThanOrEqual(1);
    expect(currentAcquired.allowed, "this build replaced a record it had not verified").toBe(false);
    await Promise.all([current.exit(), old.exit()]);
  }, 240_000);

  it("this build's holder killed with SIGKILL: an earlier build cannot reclaim its record, and the next holder of this build takes over alone", async () => {
    const state = stateDir();
    const first = run(state, "first", "current", "none");
    expect((await first.acquired()).allowed).toBe(true);
    first.child.kill("SIGKILL");
    await first.exited;
    const next = run(state, "next", "current", "after-read");
    await next.paused();
    const old = run(state, "old", earlier, "none");
    const oldAcquired = await old.acquired();
    next.resume();
    const nextAcquired = await next.acquired();
    const held = await holders(state, next, old);
    expect(held.length, JSON.stringify({ oldAcquired, nextAcquired, held })).toBeLessThanOrEqual(1);
    expect(oldAcquired.allowed, "an earlier build reclaimed this build's record").toBe(false);
    expect(nextAcquired.allowed).toBe(true);
    await Promise.all([next.exit(), old.exit()]);
  }, 240_000);

  it("a live holder of this build: an earlier build refuses", async () => {
    const state = stateDir();
    const live = run(state, "live", "current", "none");
    expect((await live.acquired()).allowed).toBe(true);
    const old = run(state, "old", earlier, "none");
    const oldAcquired = await old.acquired();
    expect(oldAcquired.allowed).toBe(false);
    const held = await holders(state, live, old);
    expect(held.map((h) => h.build)).toEqual(["current"]);
    await Promise.all([live.exit(), old.exit()]);
  }, 240_000);

  it("a cleanly stopped holder of this build leaves nothing an earlier build would reclaim, and nothing at the path", async () => {
    const state = stateDir();
    const once = run(state, "once", "current", "none");
    expect((await once.acquired()).allowed).toBe(true);
    expect(lstatSync(join(state, "agentcpd.lock")).isDirectory()).toBe(true);
    await once.exit();
    // install-launchd.sh waits for this path to be gone before it replaces anything.
    expect(existsSync(join(state, "agentcpd.lock"))).toBe(false);
  }, 240_000);

  // Narrow review 7: what used to hand this build's record back to an earlier build's reclaim.
  it.each([
    ["touched, then left past the five-second grace", "touch"],
    ["its record copied back without its times, and a copy aimed at the lock path itself", "copy"],
    ["seen by an earlier build whose clock reads past 2100", "clock"],
  ] as const)("a live holder of this build %s: an earlier build still refuses", async (_, perturbation) => {
    const state = stateDir();
    const lockPath = join(state, "agentcpd.lock");
    const live = run(state, "live", "current", "none");
    expect((await live.acquired()).allowed).toBe(true);
    const before = lstatSync(lockPath);
    const recordPath = holderRecordAt(lockPath);
    const record = readFileSync(recordPath);
    if (perturbation === "touch") {
      expect(boundedSpawnSync("/usr/bin/touch", [lockPath, recordPath]).status).toBe(0);
    } else if (perturbation === "copy") {
      writeFileSync(join(state, "record-backup"), record);
      copyFileSync(join(state, "record-backup"), recordPath);
      expect(boundedSpawnSync("/bin/cp", [join(state, "record-backup"), lockPath]).status).toBe(0);
    }
    if (perturbation !== "clock") await new Promise((resolve) => setTimeout(resolve, 5_500));
    const old = run(state, "old", earlier, "none", perturbation === "clock" ? Date.parse("2100-01-01T00:00:06Z") : undefined);
    const oldAcquired = await old.acquired();
    const held = await holders(state, live, old);
    expect(held.map((h) => `${h.build}:${h.pid}`), JSON.stringify({ oldAcquired, held })).toHaveLength(1);
    expect(held[0]!.build).toBe("current");
    expect(oldAcquired.allowed).toBe(false);
    // The directory is the same one, and its record the same bytes.
    expect(lstatSync(lockPath).ino).toBe(before.ino);
    expect(readFileSync(holderRecordAt(lockPath)).equals(record)).toBe(true);
    await Promise.all([live.exit(), old.exit()]);
  }, 240_000);

  it("this build's holder killed with SIGKILL and its directory touched: an earlier build still refuses past the grace", async () => {
    const state = stateDir();
    const lockPath = join(state, "agentcpd.lock");
    const first = run(state, "first", "current", "none");
    expect((await first.acquired()).allowed).toBe(true);
    first.child.kill("SIGKILL");
    await first.exited;
    expect(boundedSpawnSync("/usr/bin/touch", [lockPath]).status).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const old = run(state, "old", earlier, "none");
    const oldAcquired = await old.acquired();
    expect(oldAcquired.allowed).toBe(false);
    expect(lstatSync(lockPath).isDirectory()).toBe(true);
    const next = run(state, "next", "current", "none");
    expect((await next.acquired()).allowed, "this build's next holder did not reclaim its own directory").toBe(true);
    const held = await holders(state, next, old);
    expect(held.map((h) => h.build)).toEqual(["current"]);
    await Promise.all([next.exit(), old.exit()]);
  }, 240_000);
});
