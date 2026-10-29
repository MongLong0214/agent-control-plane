import type { ControlPlane } from "../app/control-plane.ts";
import { type BootstrapApplication, strandedBootstrapApplications } from "../bootstrap/bootstrap-applications.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { isTerminal, legalTargets } from "../domain/run-state.ts";
import { RunState, type RunRow } from "../domain/types.ts";
import { type ContractChangeRunWithoutGrant, contractChangeRunsWithoutGrant } from "../registry/manifest-activation-grants.ts";
import { NotificationKind, notificationKey } from "./production-gate.ts";

/**
 * #1189, CEO ruling 5 — a stall that nothing in the system moves on its own is routed to the CEO through
 * the existing CRITICAL_SYSTEM_FAILURE notification. The notice names its owner (the CEO), the concrete
 * blocker, the recovery action the CEO owns and what stays as recorded. It changes no state: a merged
 * commit stays merged, a terminal run stays terminal, a reservation stays held. It is sent once per
 * stall identity — a durable fact, never a delivery outcome — so a daemon pass or a restart that finds
 * the same stall sends nothing more. A pass with no ready CEO sends nothing and asks again next time.
 */

type StallPorts = Pick<ControlPlane, "db" | "runs" | "audit" | "ceo" | "outbox">;

export const STALL_OWNER = "CEO";

export type OwnerlessStall =
  | "BLOCKED_POST_MERGE"
  | "BOOTSTRAP_APPLICATION_STRANDED"
  | "CONTRACT_CHANGE_RUN_WITHOUT_GRANT"
  | "PROJECT_RETIREMENT_HELD";

interface StallNotice {
  runId: string;
  identity: { stall: OwnerlessStall } & Record<string, unknown>;
  payload: Record<string, unknown>;
}

export type StallRouting = Decision<{ messageId: string; created: boolean }>;

const send = (cp: StallPorts, notice: StallNotice): StallRouting =>
  cp.ceo.notifyOnce(NotificationKind.CRITICAL_SYSTEM_FAILURE, notice.runId, notice.identity, {
    stall: notice.identity.stall,
    owner: STALL_OWNER,
    ...notice.payload,
  });

/** The notice already routed for this stall identity, if any: asked before any payload is read. */
const alreadyRouted = (cp: StallPorts, runId: string, identity: StallNotice["identity"]): StallRouting | null => {
  const existing = cp.outbox.byIdempotencyKey(notificationKey(NotificationKind.CRITICAL_SYSTEM_FAILURE, runId, identity));
  return existing
    ? allow(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED, { messageId: existing.messageId, created: false })
    : null;
};

const parsed = (json: string | null): unknown => {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

const canCancel = (run: RunRow): boolean => legalTargets(run.state, run.kind).includes(RunState.CANCELLED);

/**
 * A post-merge block is one finalization attempt: a resumed attempt that blocks again has a new attempt id,
 * and a failure reason recorded later on the same attempt does not make it a second stall.
 */
const postMergeStallIdentity = (cp: StallPorts, runId: string): StallNotice["identity"] => ({
  stall: "BLOCKED_POST_MERGE",
  runId,
  attemptId:
    cp.db.get<{ attempt_id: string }>(`SELECT attempt_id FROM finalization_attempts WHERE run_id = ?`, [runId])
      ?.attempt_id ?? null,
});

const postMergeStallNotice = (cp: StallPorts, run: RunRow, identity: StallNotice["identity"]): StallNotice => {
  const attempt = cp.db.get<{ failure_reason: string | null; compensation_plan_json: string | null }>(
    `SELECT failure_reason, compensation_plan_json FROM finalization_attempts WHERE run_id = ?`,
    [run.runId],
  );
  // The merges as their durable receipts record them: APPLIED is a merge that landed, PENDING one whose
  // outcome is not yet known and is reconciled before anything is compensated.
  const repositories = cp.db
    .all<{ repository_identity: string; status: string; verified: number; response_json: string }>(
      `SELECT repository_identity, status, verified, response_json FROM github_receipts
        WHERE run_id = ? AND operation = 'merge_execute' AND status IN ('PENDING','APPLIED')
        ORDER BY created_at, receipt_id`,
      [run.runId],
    )
    .map((receipt) => {
      const response = parsed(receipt.response_json);
      return {
        repositoryIdentity: receipt.repository_identity,
        mergeCommitSha: isRecord(response) ? text(response["mergeCommitSha"]) : null,
        status: receipt.status,
        verified: receipt.verified === 1,
      };
    });
  const failedChecks = cp.audit
    .forRun(run.runId)
    .filter((entry) => entry.kind === "POST_MERGE_FAILED")
    .flatMap((entry) => {
      const failed = entry.evidence["failed"];
      return (Array.isArray(failed) ? failed : []).filter(isRecord).map((check) => ({
        repositoryIdentity: text(entry.evidence["repositoryIdentity"]),
        mergeCommitSha: text(entry.evidence["mergeCommitSha"]),
        name: text(check["name"]),
        conclusion: text(check["conclusion"]),
      }));
    });
  const plan = parsed(attempt?.compensation_plan_json ?? null);
  const compensation = (Array.isArray(plan) ? plan : []).filter(isRecord).map((entry) => ({
    repositoryIdentity: text(entry["repositoryIdentity"]),
    mergeCommitSha: text(entry["mergeCommitSha"]),
    receiptStatus: text(entry["receiptStatus"]),
    requiredAction: text(entry["requiredAction"]),
    planPrepared: entry["plan"] !== null && entry["plan"] !== undefined,
  }));
  const failureReasonCode = attempt?.failure_reason ?? null;
  return {
    runId: run.runId,
    identity,
    payload: {
      projectId: run.projectId,
      state: run.state,
      candidateSnapshotDigest: cp.runs.currentCandidate(run.runId),
      failureReasonCode,
      repositories,
      failedChecks,
      compensation,
      reason:
        `after its merge this run's finalization failed (${failureReasonCode ?? "no failure recorded"}), and the run is ` +
        "terminal in BLOCKED_POST_MERGE; nothing in the system acts on its compensation plan",
      action:
        "review the compensation plan and the failed checks (run_get, doctor_run), then decide the follow-up: a new run, " +
        "created with run_create and taken through review and CONFIRM, that fixes forward or reverts the merged change; " +
        "a merge receipt still PENDING is reconciled before anything is compensated",
      detail:
        "kept as recorded: the merge commits stay merged, nothing is reverted or merged again, and the run stays " +
        "terminal in BLOCKED_POST_MERGE without being marked failed",
      whyItMatters: "a merged change failed its required post-merge proof, and no agent owns the follow-up until the CEO takes it",
    },
  };
};

/**
 * Routes a run the finalizer has just refused to resume out of BLOCKED_POST_MERGE. The caller is
 * the daemon's finalization sweep, which asks only after that refusal; null when the run is not there.
 */
export const routePostMergeStall = (cp: StallPorts, runId: string): StallRouting | null => {
  const run = cp.runs.get(runId);
  if (!run || run.state !== RunState.BLOCKED_POST_MERGE) return null;
  const identity = postMergeStallIdentity(cp, runId);
  return alreadyRouted(cp, runId, identity) ?? send(cp, postMergeStallNotice(cp, run, identity));
};

/** Whether this run's current post-merge block has been routed to the CEO. */
const postMergeStallRouted = (cp: StallPorts, runId: string): boolean =>
  alreadyRouted(cp, runId, postMergeStallIdentity(cp, runId)) !== null;

/** A STRANDED application of a run still waiting; its reservation is never released here. */
const strandedNotice = (application: BootstrapApplication, run: RunRow): StallNotice => ({
  runId: application.runId,
  identity: {
    stall: "BOOTSTRAP_APPLICATION_STRANDED",
    runId: application.runId,
    projectId: application.projectId,
    repositoryIdentity: application.repositoryIdentity,
  },
  payload: {
    projectId: application.projectId,
    repositoryIdentity: application.repositoryIdentity,
    state: run.state,
    attempts: application.attempts,
    cause: text(application.lastRefusal?.["cause"]),
    reason:
      "what GitHub holds at this bootstrap's target cannot be attributed to this run; its application is STRANDED, " +
      "and nothing retries, adopts, deletes or releases its reservation",
    action:
      "bootstrap the project again under a new project id and repository identity (run_create, run_dispatch); " +
      "whether the repository at the target is this run's is read from its GitHub node id against the attempt " +
      "ledger in the run's doctor evidence (doctor_run)",
    detail:
      "kept as recorded: the reservation of this project id and repository identity is never released, because " +
      "nothing proves the target safe to release; " +
      (run.state === RunState.READY_FOR_CEO_REVIEW
        ? "the run stays at READY_FOR_CEO_REVIEW, which no cancel edge leaves, and its reserved application refuses FINAL_REVISE"
        : canCancel(run)
          ? `the run is at ${run.state} and can be cancelled with run_cancel`
          : `the run stays at ${run.state}, which no cancel edge leaves`),
    whyItMatters: "a bootstrap holds a project id and a repository identity that nothing will ever release or complete",
  },
});

/** What the CEO can do with a CONTRACT_CHANGE run this slice cannot finish, from its state. */
const contractChangeAction = (run: RunRow, cause: ContractChangeRunWithoutGrant["cause"]): string => {
  if (run.state === RunState.READY_FOR_CEO_REVIEW) {
    return "submit FINAL_REVISE for it, then cancel it with run_cancel and create a new CONTRACT_CHANGE run whose PLAN " +
      "carries the manifest, or dispatch it again for such a PLAN";
  }
  if (canCancel(run)) {
    return "cancel it with run_cancel and create a new CONTRACT_CHANGE run whose PLAN carries the manifest" +
      (cause === "PLAN_CARRIES_NO_MANIFEST" && run.state === RunState.ACTIVE
        ? ", or have its CTO submit a PLAN carrying the manifest"
        : "");
  }
  return `create a new CONTRACT_CHANGE run whose PLAN carries the manifest; no cancel edge leaves ${run.state}, so this run stays as recorded`;
};

const contractChangeNotice = (stuck: ContractChangeRunWithoutGrant, run: RunRow): StallNotice => ({
  runId: stuck.runId,
  identity: { stall: "CONTRACT_CHANGE_RUN_WITHOUT_GRANT", runId: stuck.runId, cause: stuck.cause },
  payload: {
    projectId: stuck.projectId,
    state: run.state,
    cause: stuck.cause,
    reason:
      stuck.cause === "CONFIRMED_WITHOUT_GRANT"
        ? "this CONTRACT_CHANGE run was confirmed before activation grants existed, so its finalization can never activate its manifest"
        : "this CONTRACT_CHANGE run's latest PLAN carries no manifest, so it can never be confirmed",
    action: contractChangeAction(run, stuck.cause),
    detail: "kept as recorded: the run and its artifacts stay as they are, and nothing here moves it",
    whyItMatters: "a CONTRACT_CHANGE run that cannot finish holds its project's contract change until someone replaces it",
  },
});

/**
 * Every STRANDED bootstrap application of a run that is not terminal, and every CONTRACT_CHANGE
 * run the activation path cannot finish, routed to the CEO once each. Called by the daemon on start and on
 * every watchdog pass.
 */
export const routeOwnerlessStalls = (cp: StallPorts): StallRouting[] => {
  const routed: StallRouting[] = [];
  for (const application of strandedBootstrapApplications(cp.db, null)) {
    const run = cp.runs.get(application.runId);
    if (!run || isTerminal(run.state)) continue;
    routed.push(send(cp, strandedNotice(application, run)));
  }
  for (const stuck of contractChangeRunsWithoutGrant(cp.db, null)) {
    const run = cp.runs.get(stuck.runId);
    if (!run) continue;
    routed.push(send(cp, contractChangeNotice(stuck, run)));
  }
  return routed;
};

/**
 * A retirement refused because confirmed external effects have not settled names the runs it waits
 * on. A run terminal in BLOCKED_POST_MERGE never settles; once its block has been routed to the CEO, the
 * held retirement is routed too, once per project and run. Whether such a run counts as settled is not
 * decided here, so the refusal stands.
 */
export const retirementWaitsForSettlement = (
  cp: StallPorts,
  projectId: string,
  settling: ReadonlyArray<{ run_id: string; state: string }>,
): Decision<never> => {
  for (const run of settling) {
    if (run.state !== RunState.BLOCKED_POST_MERGE || !postMergeStallRouted(cp, run.run_id)) continue;
    send(cp, {
      runId: run.run_id,
      identity: { stall: "PROJECT_RETIREMENT_HELD", projectId, runId: run.run_id },
      payload: {
        projectId,
        state: run.state,
        reason:
          "the project's retirement waits for confirmed external effects to settle, and this run is terminal in " +
          "BLOCKED_POST_MERGE, which nothing settles",
        action:
          "rule whether a terminal BLOCKED_POST_MERGE run's merged effects count as settled for retirement; until then " +
          "the retirement request stays pending and is asked again on every daemon pass",
        detail:
          "kept as recorded: the run, its merge commits and its compensation plan stay as they are; retirement cancels " +
          "or reverts nothing of them",
        whyItMatters: "an owner retirement is held by a run that will never settle on its own",
      },
    });
  }
  return deny(ReasonCode.CONFLICT, "retirement waits for confirmed external effects to settle", {
    projectId,
    waitingOn: settling.map((run) => ({ runId: run.run_id, state: run.state })),
  });
};
