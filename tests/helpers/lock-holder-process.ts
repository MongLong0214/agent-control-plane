import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { Daemon } from "../../src/daemon/daemon.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { makeHarness } from "./harness.ts";

/**
 * A separate process for the #1070 ACP-WORKER-03-LOCK witnesses: what one process sees of the lock is
 * only evidence about another process when the two really are two processes.
 *
 *   <state> <id> <mode>
 *
 * Modes: `lock` takes the bare lock; `raw` only tries the operating-system lock; `daemon` runs a real
 * `Daemon.start()` and reports its acquisition, holding a successful one until `<state>/<id>.continue`;
 * `startup-failure` runs a real start whose reconciliation throws. Each waits for `<state>/go` before acquiring, so several
 * can be released at once, then publishes `<state>/<id>.result` and stays alive until
 * `<state>/<id>.exit`. While alive it answers `<state>/<id>.ask-<n>` files: `held` reports whether
 * its lock is held, `second-connection` opens and closes another SQLite connection to the lock file.
 *
 * Narrow liveness: `<state>/<id>.go` releases one process alone, and `<state>/<id>.entering` is
 * published the moment an acquisition begins. `shared` takes only the SHARED lock a contender holds
 * inside its own `BEGIN EXCLUSIVE`, before it asks for RESERVED, and keeps it until asked `release`.
 *
 *   <state> <id> contend <lock path> <watched pid>
 *
 * `contend` is a competing start in its own process: the real acquisition of the lock at `<lock
 * path>`, asked again and again until `<state>/<id>.stop`. Each ask notes whether the watched process
 * was alive before it, and a lock it is granted is kept only while it asks once more whether that
 * process is alive, then given back; every ask is published to `<state>/<id>.attempts`.
 * `<state>/<id>.ready` is published once a process is loaded and waiting for its go.
 */
const [state, id, mode, lockPathArgument, watchedArgument] = process.argv.slice(2) as [string, string, string, string?, string?];
const publish = (name: string, value: unknown): void => {
  writeFileSync(join(state, `${name}.tmp`), JSON.stringify(value));
  renameSync(join(state, `${name}.tmp`), join(state, name));
};
const until = async (condition: () => boolean): Promise<void> => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
};

const lockPath = lockPathArgument ?? join(state, "agentcpd.lock");
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
let lock: SingleInstanceLock;
/** `shared` mode's connection, held in a cell: it is assigned inside `start`, after the module's own flow. */
const shared: { db: Database.Database | null } = { db: null };
let start: () => Promise<{ allowed: boolean; reasonCode: string; message?: string }>;
if (mode === "lock") {
  lock = new SingleInstanceLock(lockPath);
  start = async () => lock.acquire(new Date().toISOString());
} else if (mode === "raw") {
  // Only the operating-system lock, without the record checks `acquire()` adds on top of it.
  lock = new SingleInstanceLock(lockPath);
  start = async () => {
    const raw = new Database(lock.lockDatabasePath, { timeout: 0 });
    try {
      raw.exec("BEGIN EXCLUSIVE");
      return { allowed: true, reasonCode: "OK" };
    } catch (error) {
      return { allowed: false, reasonCode: (error as { code?: string }).code ?? "UNKNOWN" };
    } finally {
      raw.close();
    }
  };
} else if (mode === "shared") {
  // A contender's state inside its `BEGIN EXCLUSIVE` at the step the diagnosed schedule needs: SHARED
  // granted, RESERVED not yet asked for. A deferred read transaction holds exactly that lock.
  lock = new SingleInstanceLock(lockPath);
  start = async () => {
    try {
      closeSync(openSync(lock.lockDatabasePath, "wx", 0o600));
    } catch {
      /* it exists */
    }
    // Reported as `raw` reports its own SQLite step: OK once the lock is held, SQLite's code if not.
    // The lock it holds is SHARED; that is the mode's name, never a reason code.
    const db = new Database(lock.lockDatabasePath, { timeout: 0 });
    shared.db = db;
    try {
      db.exec("BEGIN");
      db.prepare("SELECT count(*) FROM sqlite_master").get();
      return { allowed: db.inTransaction, reasonCode: "OK" };
    } catch (error) {
      return { allowed: false, reasonCode: (error as { code?: string }).code ?? "UNKNOWN" };
    }
  };
} else if (mode === "contend") {
  lock = new SingleInstanceLock(lockPath);
  start = async () => {
    const watched = Number(watchedArgument);
    const attempts: Array<{ at: number; aliveBefore: boolean; taken: boolean; aliveWhileHeld: boolean | null }> = [];
    while (!existsSync(join(state, `${id}.stop`))) {
      const at = Date.now();
      const aliveBefore = isAlive(watched);
      const taken = lock.acquire(new Date(at).toISOString()).allowed;
      // Asked while this process still holds what it was granted, so an answer of alive is a
      // successor holding the lock while the watched process lives, whenever that process ends.
      const aliveWhileHeld = taken ? isAlive(watched) : null;
      if (taken) lock.release();
      attempts.push({ at, aliveBefore, taken, aliveWhileHeld });
      publish(`${id}.attempts`, attempts);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { allowed: true, reasonCode: "OK" };
  };
} else {
  mkdirSync(join(state, `${id}-root`), { recursive: true, mode: 0o700 });
  const h = makeHarness({ root: join(state, `${id}-root`) });
  const daemon = new Daemon(h.cp, { stateDir: state });
  lock = daemon.lock;
  const reconcile = daemon.reconcile.bind(daemon);
  Object.defineProperty(daemon, "reconcile", {
    value: mode === "startup-failure"
      ? async () => {
        throw new Error("reconciliation failed on purpose");
      }
      // A real start's reconciliation, as is.
      : reconcile,
    configurable: true,
  });
  start = () => daemon.start();
}

// `daemon` reports the real start's own acquisition, as `Daemon.start()` took it, and what the start
// then returned; the others report what their start returned.
// In `daemon` mode the real start's own acquisition is reported the moment it answers, and a
// successful one holds the start right there, lock held, until `<state>/<id>.continue`: so whatever the
// other process does meanwhile, it does while this one holds.
const acquire = lock.acquire.bind(lock);
lock.acquire = (startedAt: string) => {
  publish(`${id}.entering`, { pid: process.pid });
  const decision = acquire(startedAt);
  if (mode === "daemon") {
    publish(`${id}.result`, { pid: process.pid, allowed: decision.allowed, reasonCode: decision.reasonCode, held: lock.held() });
    if (decision.allowed) {
      const waited = spawnSync(process.execPath, ["-e", `
        const fs = require("node:fs"), cell = new Int32Array(new SharedArrayBuffer(4)), until = Date.now() + 240000;
        while (!fs.existsSync(process.argv[1])) { if (Date.now() > until) process.exit(2); Atomics.wait(cell, 0, 0, 10); }
      `, join(state, `${id}.continue`)], { timeout: 245_000 });
      if (waited.status !== 0) throw new Error("the holding start was never continued");
    }
  }
  return decision;
};

publish(`${id}.ready`, { pid: process.pid });
await until(() => existsSync(join(state, "go")) || existsSync(join(state, `${id}.go`)));
const returned = await start().then((decision) => ({ allowed: decision.allowed, reasonCode: decision.reasonCode, held: lock.held() }));
publish(mode === "daemon" ? `${id}.started` : `${id}.result`, { pid: process.pid, ...returned });

let answered = 0;
while (!existsSync(join(state, `${id}.exit`))) {
  const ask = join(state, `${id}.ask-${answered}`);
  if (existsSync(ask)) {
    const question = readFileSync(ask, "utf8").trim();
    let answer: unknown = null;
    if (question === "held") answer = lock.held();
    if (question === "second-connection") {
      const second = new Database(lock.lockDatabasePath, { timeout: 0 });
      let code = "OK";
      try {
        second.exec("BEGIN EXCLUSIVE");
      } catch (error) {
        code = (error as { code?: string }).code ?? "UNKNOWN";
      }
      second.close();
      answer = code;
    }
    if (question === "plain-descriptor") {
      // The documented hazard: POSIX record locks belong to the process, so closing any descriptor
      // on the file releases them. Nothing in a holder does this; the witness shows why not.
      const { closeSync, openSync } = await import("node:fs");
      closeSync(openSync(lock.lockDatabasePath, "r"));
      answer = "closed";
    }
    if (question === "release" && shared.db !== null) {
      shared.db.exec("ROLLBACK");
      shared.db.close();
      shared.db = null;
      answer = "released";
    }
    publish(`${id}.answer-${answered}`, { question, answer });
    answered += 1;
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}
lock.release();
process.exit(0);
