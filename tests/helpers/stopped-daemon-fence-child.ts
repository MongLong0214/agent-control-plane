import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { makeHarness } from "./harness.ts";

/**
 * A daemon process for the ACP-WORKER-03-FC witness: it starts a real, paused process group standing
 * for a worker git child it cannot confirm stopped, stops through the real `Daemon.stop()` with that
 * group reported unconfirmed, and exits the way agentcpd's shutdown handler does — non-zero when the
 * stop was incomplete. The group outlives it; what the witness measures is whether the fence does.
 */
const [stateDir, release, ready] = process.argv.slice(2) as [string, string, string];
const h = makeHarness();
const group = spawn("/bin/sh", ["-c", 'while [ ! -e "$1" ]; do /bin/sleep 0.05; done', "fence-witness-group", release], {
  detached: true,
  stdio: "ignore",
});
const pgid = group.pid!;
const leaderStartedAt = readProcessStartToken(pgid);
Object.defineProperty(h.cp, "workerTurns", {
  value: {
    shutdown: async () => ({ drained: false, outstanding: [], gitStopped: false, unconfirmedGroups: [{ pgid, leaderStartedAt }] }),
  },
  configurable: true,
});
const daemon = new Daemon(h.cp, { stateDir });
const acquired = daemon.lock.acquire(h.cp.clock.nowIso());
if (!acquired.allowed) throw new Error(acquired.message);
const stopped = await daemon.stop();
writeFileSync(ready, JSON.stringify({
  daemonPid: process.pid,
  pgid,
  leaderStartedAt,
  complete: stopped.complete,
  stopped: h.cp.audit.byKind("DAEMON_STOPPED").at(-1)!.evidence,
}));
h.cp.close();
process.exit(stopped.complete ? 0 : 75);
