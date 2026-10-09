import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Daemon } from "../../src/daemon/daemon.ts";
import { makeHarness } from "./harness.ts";

const [stateDir, repoPath, branch, target, base, release, ready] = process.argv.slice(2) as string[];
const h = makeHarness();
// Model the actual fail-closed result. No claim that this creates an unkillable kernel process.
Object.defineProperty(h.cp, "workerTurns", {
  value: { shutdown: async () => ({ drained: false, outstanding: [], gitStopped: false }) },
  configurable: true,
});
const daemon = new Daemon(h.cp, { stateDir: stateDir! });
const acquired = daemon.lock.acquire(h.cp.clock.nowIso());
if (!acquired.allowed) throw new Error(acquired.message);
const child = spawn("/bin/sh", ["-c",
  'while [ ! -e "$1" ]; do /bin/sleep 0.05; done; exec /usr/bin/git -C "$2" update-ref "refs/heads/$3" "$4" "$5"',
  "review-paused-update-ref", release!, repoPath!, branch!, target!, base!,
], { detached: true, stdio: "ignore" });
await daemon.stop();
writeFileSync(ready!, JSON.stringify({ daemonPid: process.pid, childPid: child.pid,
  stopped: h.cp.audit.byKind("DAEMON_STOPPED").at(-1)!.evidence }));
// The same exit sequence as agentcpd.ts:4359-4364, following the real Daemon.stop().
h.cp.close();
process.exit(0);
