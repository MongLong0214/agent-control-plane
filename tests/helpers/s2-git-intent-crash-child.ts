/**
 * S2 round 3 (P1-b) — a worker runner, in a process of its own, stopped dead between a git child's
 * intent record and its group record.
 *
 * Run by `a-task-claim-is-handed-over-at-its-execution-end.test.ts` with
 * `node --experimental-transform-types`. It opens its own control plane on the fixture's database file,
 * starts the turn of the task the parent staffed and claimed — its first git child comes in admission,
 * before any execution exists — and once that child is spawned, before its group is recorded (outside
 * any transaction), it either kills itself with SIGKILL (`kill`) or stops itself with SIGSTOP (`stop`, a
 * runner frozen but not gone): the intent is written, the child is spawned, and nothing about its group
 * ever is. Round 4 adds two pauses that the
 * parent resumes with SIGCONT: right after the intent is committed and before the spawn
 * (`stop-after-intent`), and before the intent is written at all (`stop-before-intent`); resumed, the
 * runner goes on, and prints what its turn answered. Only the WORKER provider is a fixture, and the turn
 * never reaches it.
 */
import { writeFileSync } from "node:fs";

import { ManualClock } from "../../src/core/clock.ts";
import type { AuditRecord } from "../../src/db/audit.ts";
import { Role } from "../../src/domain/types.ts";
import { GitChildren } from "../../src/run/worker-git.ts";
import { TASK_WORKER_GIT_INTENT } from "../../src/run/worker-turn.ts";
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
  mode: "kill" | "stop" | "stop-after-intent" | "stop-before-intent";
  /** Where the pid of the spawned git child is written, read from the record about to be written. */
  spawnedFile: string;
}

const input = JSON.parse(process.argv[2] ?? "{}") as ChildInput;
const h = makeHarness({ root: input.root, repoPath: input.repoPath, clock: new ManualClock(input.nowIso) });
h.cp.providers.registerForRole(new FakeWorkerAdapter(new GuardedInvocationWriteBroker(h.cp.guard)), Role.WORKER);
const record = h.cp.audit.record.bind(h.cp.audit);
let paused = false;
h.cp.audit.record = (entry: AuditRecord) => {
  if (entry.kind === TASK_WORKER_GIT_INTENT && input.mode === "stop-before-intent" && !paused) {
    paused = true;
    process.kill(process.pid, "SIGSTOP");
  }
  const written = record(entry);
  // Frozen with the intent committed and nothing spawned yet.
  if (entry.kind === TASK_WORKER_GIT_INTENT && input.mode === "stop-after-intent" && !paused) {
    paused = true;
    process.kill(process.pid, "SIGSTOP");
  }
  return written;
};
const track = GitChildren.prototype.track;
GitChildren.prototype.track = function (this: GitChildren, child, nonce) {
  // The daemon dies, or freezes, here: its git child exists under a recorded intent, its group is not recorded.
  if (input.mode === "kill" || input.mode === "stop") {
    writeFileSync(input.spawnedFile, String(child.pid ?? ""));
    process.kill(process.pid, input.mode === "stop" ? "SIGSTOP" : "SIGKILL");
  }
  return track.call(this, child, nonce);
};
const started = await h.cp.workerTurns.start({
  runId: input.runId,
  taskId: input.taskId,
  claimId: input.claimId,
  ownerSessionId: input.ownerSessionId,
  ownerBindingGeneration: input.ownerBindingGeneration,
});
// A resumed runner reports what its turn answered; for the others, reaching here means no git child was spawned.
process.stdout.write(`${JSON.stringify({ started })}\n`);
process.exit(input.mode === "stop-after-intent" || input.mode === "stop-before-intent" ? 0 : 3);
