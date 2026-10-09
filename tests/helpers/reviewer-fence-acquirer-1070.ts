import { spawnSync } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";

const [lockPath, checked, resume, acquired, release] = process.argv.slice(2) as string[];
const publish = (path: string, value: unknown) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
};
class PausingFenceLock extends SingleInstanceLock {
  override liveFence(): ReturnType<SingleInstanceLock["liveFence"]> {
    const initial = super.liveFence();
    publish(checked!, { initial });
    // This separate successor process is paused after the real lookup. Its parent remains free
    // to observe the daemon's exit, then resumes this exact acquire call.
    const waited = spawnSync(process.execPath, ["-e", `
      const fs = require('node:fs');
      const until = Date.now() + 45000;
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(process.argv[1])) {
        if (Date.now() > until) process.exit(2);
        Atomics.wait(sleep, 0, 0, 10);
      }
    `, resume!], { timeout: 50_000 });
    if (waited.status !== 0) throw new Error(`resume gate failed: ${waited.status}`);
    return initial;
  }
}
const lock = new PausingFenceLock(lockPath!);
const decision = lock.acquire(new Date().toISOString());
publish(acquired!, { successorPid: process.pid, decision });
while (!existsSync(release!)) await new Promise(resolve => setTimeout(resolve, 10));
lock.release();
