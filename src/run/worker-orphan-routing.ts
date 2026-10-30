import { IncidentClass, type NoticeDelivery, type NoticePorts, deliverIncident } from "../ceo/ceo-incident-notices.ts";
import type { Decision } from "../core/errors.ts";
import { liveWorkerSessionCarriers } from "../doctor/repair.ts";
import {
  ORPHAN_RELEASE_CONFIRMATION,
  ORPHAN_RELEASE_REPAIR_ID,
  orphanExecutionOf,
  unreleasedWorkerOrphans,
} from "./worker-orphan-release.ts";

/** The source a held task's notice names, for its reader. */
export const WORKER_ORPHAN_SOURCE = "WORKER_ORPHAN_UNRELEASED";

/**
 * #1189 A2 — a task an unidentified worker orphan holds waits for the owner's
 * `release_unidentified_worker_orphan`, and nothing told anyone it was waiting. The release stays the
 * owner's: nothing here records a resolution, signals a process or changes the task. Each held task is
 * a RUN_STALLED incident of its run for `ceo-incident-notices.ts` to deliver as CRITICAL_SYSTEM_FAILURE,
 * one episode per orphan event; that module owns its dedup and its re-delivery to a replaced CEO.
 *
 * What the daemon reads on its own is the release's machine precondition — whether a live process still
 * carries the worker session's id — read only when a notice is enqueued. With the check in hand the CEO
 * can ask the owner for the release, or end the run under its own authority; the notice decides neither.
 * The check is evidence for whoever signs, not a substitute for the signature: it is a reading at one
 * instant, a failed read is UNKNOWN and never "none", and the release repair reads the process table
 * again when it runs.
 */
export const routeUnreleasedWorkerOrphans = (
  ports: NoticePorts,
): Array<{ orphanEventId: number; routing: Decision<NoticeDelivery> }> => {
  const { db } = ports;
  return unreleasedWorkerOrphans(db).map((orphan) => ({
    orphanEventId: orphan.eventId,
    routing: deliverIncident(ports, {
      cls: IncidentClass.RUN_STALLED,
      subject: orphan.runId,
      runId: orphan.runId,
      episode: `worker-orphan:${orphan.eventId}`,
      payload: {
        source: WORKER_ORPHAN_SOURCE,
        blocker: "an earlier worker turn of this task may have launched a process that was never recorded",
        taskId: orphan.taskId,
        executionId: orphan.executionId,
        orphanEventId: orphan.eventId,
        repairOwner: "OWNER",
        recoveryAction: `${ORPHAN_RELEASE_REPAIR_ID} with this executionId and orphanEventId, confirm=${ORPHAN_RELEASE_CONFIRMATION}, under an owner receipt`,
      },
      describe: () => {
        const scan = liveWorkerSessionCarriers(db, orphanExecutionOf(db, orphan.executionId)?.workerSessionId ?? null);
        return {
          liveProcessCheck: scan.error !== null
            ? { result: "UNKNOWN", error: scan.error }
            : { result: scan.carriers.length === 0 ? "NONE_CARRY_THE_WORKER_SESSION" : "LIVE_PROCESS_CARRIES_THE_WORKER_SESSION",
                carriers: scan.carriers },
        };
      },
    }),
  }));
};
