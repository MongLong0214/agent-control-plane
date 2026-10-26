/**
 * S2 round 3 (P1-b) — a worker runner, in a process of its own, stopped dead between a git child's
 * intent record and its group record.
 *
 * Run by `a-task-claim-is-handed-over-at-its-execution-end.test.ts` with
 * `node --experimental-transform-types`. It opens its own control plane on the fixture's database file,
 * starts the turn of the task the parent staffed and claimed — its first git child comes in admission,
 * before any execution exists — and at the entry of that child's group record it either kills itself
 * with SIGKILL (`kill`) or stops itself with SIGSTOP (`stop`, a runner frozen but not gone): the intent
 * is written, the child is spawned, and nothing about its group ever is. Only the WORKER provider is a
 * fixture, and the turn never reaches it.
 */
import { writeFileSync } from "node:fs";

import { ManualClock } from "../../src/core/clock.ts";
import type { AuditRecord } from "../../src/db/audit.ts";
import { Role } from "../../src/domain/types.ts";
import { TASK_WORKER_GIT_GROUP_STARTED } from "../../src/run/worker-turn.ts";
import { GuardedInvocationWriteBroker } from "../../src/runtime/provider.ts";
import { makeHarness } from "./harness.ts";
import { FakeWorkerAdapter } from "./worker-turn-fixture.ts";

interface ChildInput {
  root: string;
  repoPath: string;
  nowIso: string;
  runId: string;
  taskId: string;
  claimId: string;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  mode: "kill" | "stop";
  /** Where the pid of the spawned git child is written, read from the record about to be written. */
  spawnedFile: string;
}

const input = JSON.parse(process.argv[2] ?? "{}") as ChildInput;
const h = makeHarness({ root: input.root, repoPath: input.repoPath, clock: new ManualClock(input.nowIso) });
h.cp.providers.registerForRole(new FakeWorkerAdapter(new GuardedInvocationWriteBroker(h.cp.guard)), Role.WORKER);
const record = h.cp.audit.record.bind(h.cp.audit);
h.cp.audit.record = (entry: AuditRecord) => {
  // The daemon dies, or freezes, here: its git child exists under a recorded intent, its group is not recorded.
  if (entry.kind === TASK_WORKER_GIT_GROUP_STARTED) {
    writeFileSync(input.spawnedFile, String(entry.evidence?.["pgid"] ?? ""));
    process.kill(process.pid, input.mode === "stop" ? "SIGSTOP" : "SIGKILL");
  }
  return record(entry);
};
const started = await h.cp.workerTurns.start({
  runId: input.runId,
  taskId: input.taskId,
  claimId: input.claimId,
  ownerSessionId: input.ownerSessionId,
  ownerBindingGeneration: input.ownerBindingGeneration,
});
// Reaching here means no git child was ever spawned for the turn.
process.stdout.write(`${JSON.stringify({ unexpected: started })}\n`);
process.exit(3);
