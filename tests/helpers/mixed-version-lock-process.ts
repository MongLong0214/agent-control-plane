import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Daemon } from "../../src/daemon/daemon.ts";
import type { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { SingleInstanceLock as Lock3cb969a4 } from "./earlier-build-lock-3cb969a4.ts";
import { SingleInstanceLock as Lock56c1d019 } from "./earlier-build-lock-56c1d019.ts";
import { makeHarness } from "./harness.ts";

/**
 * One process of a mixed-version witness (#1070 ACP-WORKER-03-LOCK, narrow review 6): a real
 * `Daemon.start()` whose lock is this build's, or an earlier build's acquisition protocol in its
 * place — `56c1d019` (main, the deployed generation's lock) or `3cb969a4`.
 *
 *   <state> <id> <build> <pause>
 *
 * `pause` is `none`, or `after-read`: block synchronously inside `acquire()` right after its first
 * read of the holder record, publish `<id>.read`, and go on only once `<state>/<id>.resume` exists.
 * The start's own acquisition is published as `<id>.acquired` the moment it answers. A successful
 * one holds the start right there, lock held, as a running daemon would: whatever the other process
 * does meanwhile, it does while this one holds. `<state>/check` makes it publish `<id>.held`;
 * `<state>/<id>.exit` lets the start go on, stops the daemon and exits.
 *
 * `ACP_WITNESS_NOW`, when set, is the epoch millisecond this process's `Date.now()` answers: a clock
 * reading moved past whatever a lock record's timestamp says, without changing the system clock.
 */
const [state, id, build, pause] = process.argv.slice(2) as [string, string, string, string];
const publish = (name: string, value: unknown): void => {
  writeFileSync(join(state, `.${name}.tmp`), JSON.stringify(value));
  renameSync(join(state, `.${name}.tmp`), join(state, name));
};
if (process.env["ACP_WITNESS_NOW"]) {
  const now = Number(process.env["ACP_WITNESS_NOW"]);
  Date.now = () => now;
}
/** What stands at the lock path: this build's holder record in its directory, or a record file. */
const record = (): string | null => {
  const path = join(state, "agentcpd.lock");
  try {
    return readFileSync(lstatSync(path).isDirectory() ? join(path, "holder.json") : path, "utf8");
  } catch {
    return null;
  }
};
/** Blocks this whole process, synchronously, until one of `paths` exists; answers which. */
const blockUntil = (...paths: string[]): string => {
  const waited = spawnSync(process.execPath, ["-e", `
    const fs = require("node:fs"), cell = new Int32Array(new SharedArrayBuffer(4)), until = Date.now() + 240000;
    for (;;) {
      const found = process.argv.slice(1).find((p) => fs.existsSync(p));
      if (found) { process.stdout.write(found); process.exit(0); }
      if (Date.now() > until) process.exit(2);
      Atomics.wait(cell, 0, 0, 10);
    }
  `, ...paths], { timeout: 245_000, encoding: "utf8" });
  if (waited.status !== 0) throw new Error(`${id} was never resumed`);
  return waited.stdout;
};
let heldPublished = false;
const publishHeld = (): void => {
  heldPublished = true;
  publish(`${id}.held`, { pid: process.pid, build, held: lock.held(), record: record() });
};

mkdirSync(join(state, `${id}-root`), { recursive: true, mode: 0o700 });
const h = makeHarness({ root: join(state, `${id}-root`) });
const daemon = new Daemon(h.cp, { stateDir: state });
const lockPath = join(state, "agentcpd.lock");
if (build === "56c1d019") {
  Object.defineProperty(daemon, "lock", { value: new Lock56c1d019(lockPath) });
} else if (build === "3cb969a4") {
  Object.defineProperty(daemon, "lock", { value: new Lock3cb969a4(lockPath) });
} else if (build !== "current") {
  throw new Error(`unknown build ${build}`);
}
const lock = daemon.lock as SingleInstanceLock;

if (pause === "after-read") {
  const read = lock.read.bind(lock);
  let first = true;
  lock.read = () => {
    const info = read();
    if (first) {
      first = false;
      publish(`${id}.read`, { pid: process.pid, read: info, sqliteHeld: lock.held() });
      blockUntil(join(state, `${id}.resume`));
    }
    return info;
  };
}
const acquire = lock.acquire.bind(lock);
lock.acquire = (startedAt: string) => {
  const decision = acquire(startedAt);
  publish(`${id}.acquired`, {
    pid: process.pid, build, allowed: decision.allowed, reasonCode: decision.reasonCode,
    message: decision.allowed ? null : decision.message, held: lock.held(), record: record(),
  });
  if (decision.allowed) {
    const exit = join(state, `${id}.exit`);
    if (blockUntil(join(state, "check"), exit) !== exit) {
      publishHeld();
      blockUntil(exit);
    }
  }
  return decision;
};

const started = await daemon.start();
publish(`${id}.started`, { pid: process.pid, allowed: started.allowed, reasonCode: started.reasonCode });
while (!existsSync(join(state, `${id}.exit`))) {
  if (!heldPublished && existsSync(join(state, "check"))) publishHeld();
  await new Promise((resolve) => setTimeout(resolve, 5));
}
if (started.allowed) await daemon.stop();
h.cp.close();
process.exit(0);
