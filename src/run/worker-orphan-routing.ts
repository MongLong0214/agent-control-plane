import { StallSource, routeStallToCeo, type StallRouter, type StallRouting } from "../ceo/stall-notice.ts";
import { liveWorkerSessionCarriers } from "../doctor/repair.ts";
import {
  ORPHAN_RELEASE_CONFIRMATION,
  ORPHAN_RELEASE_REPAIR_ID,
  orphanExecutionOf,
  unreleasedWorkerOrphans,
} from "./worker-orphan-release.ts";

/**
 * #1189 A2 — a task an unidentified worker orphan holds waits for the owner's
 * `release_unidentified_worker_orphan`, and nothing told anyone it was waiting. The release stays the
 * owner's: nothing here records a resolution, signals a process or changes the task. What the daemon
 * does on its own is the release's machine precondition — whether a live process still carries the
 * worker session's id — read once, when the held task is told to the CEO as CRITICAL_SYSTEM_FAILURE,
 * once per orphan event. With the check in hand the CEO can ask the owner for the release, or end the
 * run under its own authority; the notice decides neither.
 *
 * The check is evidence for whoever signs, not a substitute for the signature: it is a reading at one
 * instant, and the release repair reads the process table again when it runs.
 */
export const routeUnreleasedWorkerOrphans = (router: StallRouter): Array<{ orphanEventId: number; routing: StallRouting }> => {
  const { db } = router;
  return unreleasedWorkerOrphans(db).map((orphan) => ({
    orphanEventId: orphan.eventId,
    routing: routeStallToCeo(router, {
      source: StallSource.WORKER_ORPHAN,
      stallId: `worker-orphan:${orphan.eventId}`,
      runId: orphan.runId,
      describe: () => {
        const scan = liveWorkerSessionCarriers(db, orphanExecutionOf(db, orphan.executionId)?.workerSessionId ?? null);
        return {
          blocker: "an earlier worker turn of this task may have launched a process that was never recorded",
          taskId: orphan.taskId,
          executionId: orphan.executionId,
          orphanEventId: orphan.eventId,
          liveProcessCheck: scan.error !== null
            ? { result: "UNKNOWN", error: scan.error }
            : { result: scan.carriers.length === 0 ? "NONE_CARRY_THE_WORKER_SESSION" : "LIVE_PROCESS_CARRIES_THE_WORKER_SESSION",
                carriers: scan.carriers },
          repairOwner: "OWNER",
          recoveryAction: `${ORPHAN_RELEASE_REPAIR_ID} with this executionId and orphanEventId, confirm=${ORPHAN_RELEASE_CONFIRMATION}, under an owner receipt`,
        };
      },
    }),
  }));
};
