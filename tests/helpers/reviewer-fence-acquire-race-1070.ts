import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { makeHarness } from "./harness.ts";

const [stateDir, repo, branch, target, base, release, ready, stop, stopped, mode] = process.argv.slice(2) as string[];
const publish = (path: string, value: unknown) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
};
const h = makeHarness();
const mutation = spawn("/bin/sh", ["-c",
  'while [ ! -e "$1" ]; do /bin/sleep 0.01; done; exec /usr/bin/git -C "$2" update-ref "refs/heads/$3" "$4" "$5"',
  "review-fence-acquire-mutator", release!, repo!, branch!, target!, base!,
], { detached: true, stdio: "ignore" });
const pgid = mutation.pid!;
Object.defineProperty(h.cp, "workerTurns", {
  value: { shutdown: async () => ({ drained: false, outstanding: [], gitStopped: false,
    unconfirmedGroups: mode === "empty" ? [] : [{ pgid, leaderStartedAt: readProcessStartToken(pgid) }] }) },
  configurable: true,
});
const daemon = new Daemon(h.cp, { stateDir: stateDir! });
const acquired = daemon.lock.acquire(h.cp.clock.nowIso());
if (!acquired.allowed) throw new Error(acquired.message);
publish(ready!, { daemonPid: process.pid, pgid });
while (!existsSync(stop!)) await new Promise(resolve => setTimeout(resolve, 10));
const result = await daemon.stop();
publish(stopped!, { ...result, evidence: h.cp.audit.byKind("DAEMON_STOPPED").at(-1)!.evidence });
h.cp.close();
process.exit(result.complete ? 0 : 75);
