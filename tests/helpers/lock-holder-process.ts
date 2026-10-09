import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
 */
const [state, id, mode] = process.argv.slice(2) as [string, string, string];
const publish = (name: string, value: unknown): void => {
  writeFileSync(join(state, `${name}.tmp`), JSON.stringify(value));
  renameSync(join(state, `${name}.tmp`), join(state, name));
};
const until = async (condition: () => boolean): Promise<void> => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
};

const lockPath = join(state, "agentcpd.lock");
let lock: SingleInstanceLock;
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

await until(() => existsSync(join(state, "go")));
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
    publish(`${id}.answer-${answered}`, { question, answer });
    answered += 1;
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}
lock.release();
process.exit(0);
