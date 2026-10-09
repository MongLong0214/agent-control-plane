import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";

/**
 * A successor for the #1070 ACP-WORKER-03-FC narrow-review-5 witnesses, in its own process:
 *
 *   <state> <id> [pause-on <text> | pause-list]
 *
 * Acquires the lock at `<state>/agentcpd.lock`. With `pause-on`, it stops at the first fence read
 * whose content contains `<text>` while it already holds the lock; with `pause-list`, it stops just
 * after its first listing of the state directory made before it holds the lock, and then answers
 * with that earlier listing. Either way it publishes `<state>/<id>.paused` and resumes on
 * `<state>/<id>.resume` — the reviewer's technique of wrapping `fs`, so no production code is changed
 * for the schedule. Publishes `<state>/<id>.result` and holds whatever it acquired until
 * `<state>/<id>.exit`.
 */
const [state, id, pauseFlag, pauseText] = process.argv.slice(2) as [string, string, string?, string?];
const publish = (name: string, value: unknown): void => {
  fs.writeFileSync(join(state, `${name}.tmp`), JSON.stringify(value));
  fs.renameSync(join(state, `${name}.tmp`), join(state, name));
};
const lock = new SingleInstanceLock(join(state, "agentcpd.lock"));

const pause = (): void => {
  publish(`${id}.paused`, { pid: process.pid, held: lock.held() });
  const waited = spawnSync(process.execPath, ["-e", `
    const fs = require("node:fs"), cell = new Int32Array(new SharedArrayBuffer(4)), until = Date.now() + 120000;
    while (!fs.existsSync(process.argv[1])) { if (Date.now() > until) process.exit(2); Atomics.wait(cell, 0, 0, 10); }
  `, join(state, `${id}.resume`)], { timeout: 125_000 });
  if (waited.status !== 0) throw new Error("the paused successor was never resumed");
};

if (pauseFlag === "pause-on" && pauseText) {
  const read = fs.readFileSync;
  let paused = false;
  fs.readFileSync = function patched(this: unknown, ...args: Parameters<typeof read>) {
    const content = read.apply(this, args);
    if (!paused && typeof args[0] === "number" && lock.held() && String(content).includes(pauseText)) {
      paused = true;
      pause();
    }
    return content;
  } as typeof read;
  syncBuiltinESMExports();
}
if (pauseFlag === "pause-list") {
  const list = fs.readdirSync;
  let paused = false;
  fs.readdirSync = function patched(this: unknown, ...args: Parameters<typeof list>) {
    const listing = list.apply(this, args);
    if (!paused && args[0] === state && !lock.held()) {
      paused = true;
      pause();
    }
    return listing;
  } as typeof list;
  syncBuiltinESMExports();
}

const decision = lock.acquire(new Date().toISOString());
publish(`${id}.result`, {
  pid: process.pid,
  allowed: decision.allowed,
  reasonCode: decision.reasonCode,
  held: lock.held(),
  evidence: decision.allowed ? null : decision.evidence,
});
while (!fs.existsSync(join(state, `${id}.exit`))) await new Promise((resolve) => setTimeout(resolve, 10));
lock.release();
process.exit(0);
