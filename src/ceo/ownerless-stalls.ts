import type { ControlPlane } from "../app/control-plane.ts";
import { type BootstrapApplication, strandedBootstrapApplications } from "../bootstrap/bootstrap-applications.ts";
import { deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { isTerminal, legalTargets } from "../domain/run-state.ts";
import { RunKind, RunState, type RunRow } from "../domain/types.ts";
import { type ContractChangeRunWithoutGrant, contractChangeRunsWithoutGrant } from "../registry/manifest-activation-grants.ts";
import {
  type Incident,
  IncidentClass,
  type NoticeDelivery,
  deliverIncident,
  noticeStatus,
  runEpisode,
} from "./ceo-incident-notices.ts";

/**
 * #1189, CEO ruling 5 — the stalls after a merge, of a bootstrap application and of a CONTRACT_CHANGE that
 * nothing in the system moves on its own, stated as incidents for `ceo-incident-notices.ts` to route to the
 * CEO as CRITICAL_SYSTEM_FAILURE. Each names its owner (the CEO), the concrete blocker, the action the CEO
 * owns — or, where no action within existing authority works, the transition it needs and that it is
 * pending — and what stays as recorded. Nothing here changes state: a merged commit stays merged, a terminal
 * run stays terminal, a reservation stays held. A run's stall is one RUN_STALLED incident, whichever
 * detector sees it first.
 */

type StallPorts = Pick<ControlPlane, "db" | "runs" | "audit" | "outbox" | "bindings">;

export const STALL_OWNER = "CEO";

export type StallRouting = Decision<NoticeDelivery>;

const runStalled = (cp: StallPorts, runId: string, payload: Record<string, unknown>): Incident => ({
  cls: IncidentClass.RUN_STALLED,
  subject: runId,
  runId,
  episode: runEpisode(cp.db, runId),
  payload: { owner: STALL_OWNER, ...payload },
});

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

const postMergeStall = (cp: StallPorts, run: RunRow): Incident => {
  const attempt = cp.db.get<{ attempt_id: string; failure_reason: string | null; compensation_plan_json: string | null }>(
    `SELECT attempt_id, failure_reason, compensation_plan_json FROM finalization_attempts WHERE run_id = ?`,
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
  return runStalled(cp, run.runId, {
    stall: "BLOCKED_POST_MERGE",
    projectId: run.projectId,
    state: run.state,
    candidateSnapshotDigest: cp.runs.currentCandidate(run.runId),
    attemptId: attempt?.attempt_id ?? null,
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
  });
};

/**
 * Routes a run the finalizer has just refused to resume out of BLOCKED_POST_MERGE. The caller is the
 * daemon's finalization sweep, which asks only after that refusal; null when the run is not there.
 */
export const routePostMergeStall = (cp: StallPorts, runId: string): StallRouting | null => {
  const run = cp.runs.get(runId);
  if (!run || run.state !== RunState.BLOCKED_POST_MERGE) return null;
  return deliverIncident(cp, postMergeStall(cp, run));
};

/** A STRANDED application of a run still waiting; its reservation is never released here. */
const strandedStall = (cp: StallPorts, application: BootstrapApplication, run: RunRow): Incident =>
  runStalled(cp, application.runId, {
    stall: "BOOTSTRAP_APPLICATION_STRANDED",
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
    ...(canCancel(run)
      ? {}
      : { needsTransition: `an exit from ${run.state} for a run whose bootstrap application is STRANDED (pending)` }),
    detail:
      "kept as recorded: the reservation of this project id and repository identity is never released, because " +
      "nothing proves the target safe to release; " +
      (run.state === RunState.READY_FOR_CEO_REVIEW
        ? "the run stays at READY_FOR_CEO_REVIEW, which no cancel edge leaves, and its reserved application refuses FINAL_REVISE"
        : canCancel(run)
          ? `the run is at ${run.state} and can be cancelled with run_cancel`
          : `the run stays at ${run.state}, which no cancel edge leaves`),
    whyItMatters: "a bootstrap holds a project id and a repository identity that nothing will ever release or complete",
  });

/**
 * A CONTRACT_CHANGE run in MERGING or POST_MERGE_VERIFYING is a finalizing contract change of its project
 * (`ManifestActivationGrants.finalizingContractChanges`): while it stays there, every other CONTRACT_CHANGE
 * of the project is refused at finalization with CONTRACT_CHANGE_FINALIZATION_OVERLAP.
 */
const FINALIZING_CONTRACT_CHANGE_STATES: readonly RunState[] = [RunState.MERGING, RunState.POST_MERGE_VERIFYING];

/** The other live CONTRACT_CHANGE runs of the project, whose finalization this run holds. */
const heldContractChanges = (cp: StallPorts, run: RunRow): string[] =>
  run.projectId === null
    ? []
    : cp.runs
      .list({ projectId: run.projectId })
      .filter((other) => other.runId !== run.runId && other.kind === RunKind.CONTRACT_CHANGE && !isTerminal(other.state))
      .map((other) => other.runId);

/** What the CEO can do with a CONTRACT_CHANGE run this slice cannot finish, from its state. */
const contractChangeAction = (run: RunRow, cause: ContractChangeRunWithoutGrant["cause"]): string => {
  if (FINALIZING_CONTRACT_CHANGE_STATES.includes(run.state)) {
    return `none within existing authority: no cancel edge leaves ${run.state}, and a replacement CONTRACT_CHANGE of ` +
      "this project is refused at finalization (CONTRACT_CHANGE_FINALIZATION_OVERLAP) while this run stays there; " +
      "see needsTransition";
  }
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

const contractChangeStall = (cp: StallPorts, stuck: ContractChangeRunWithoutGrant, run: RunRow): Incident => {
  const holding = FINALIZING_CONTRACT_CHANGE_STATES.includes(run.state);
  return runStalled(cp, stuck.runId, {
    stall: "CONTRACT_CHANGE_RUN_WITHOUT_GRANT",
    projectId: stuck.projectId,
    state: run.state,
    cause: stuck.cause,
    reason:
      stuck.cause === "CONFIRMED_WITHOUT_GRANT"
        ? "this CONTRACT_CHANGE run was confirmed before activation grants existed, so its finalization can never activate its manifest"
        : "this CONTRACT_CHANGE run's latest PLAN carries no manifest, so it can never be confirmed",
    action: contractChangeAction(run, stuck.cause),
    ...(holding
      ? {
        blocks: {
          what: "the finalization of every other CONTRACT_CHANGE of this project (CONTRACT_CHANGE_FINALIZATION_OVERLAP)",
          by: stuck.runId,
          runs: heldContractChanges(cp, run),
        },
        needsTransition:
          `an exit from ${run.state} for a CONTRACT_CHANGE confirmed without a grant: a cancel once non-application of its ` +
          "merge is confirmed, or follow-up recovery when its effects exist (pending)",
      }
      : {}),
    detail: "kept as recorded: the run and its artifacts stay as they are, and nothing here moves it",
    whyItMatters: "a CONTRACT_CHANGE run that cannot finish holds its project's contract change until someone replaces it",
  });
};

/**
 * Every STRANDED bootstrap application of a run that is not terminal, and every CONTRACT_CHANGE run the
 * activation path cannot finish, stated as a RUN_STALLED incident. Called by the daemon on start and on
 * every watchdog pass; the incident's own episode keeps it to one notice per CEO generation.
 */
export const routeOwnerlessStalls = (cp: StallPorts): StallRouting[] => {
  const routed: StallRouting[] = [];
  for (const application of strandedBootstrapApplications(cp.db, null)) {
    const run = cp.runs.get(application.runId);
    if (!run || isTerminal(run.state)) continue;
    routed.push(deliverIncident(cp, strandedStall(cp, application, run)));
  }
  for (const stuck of contractChangeRunsWithoutGrant(cp.db, null)) {
    const run = cp.runs.get(stuck.runId);
    if (!run) continue;
    routed.push(deliverIncident(cp, contractChangeStall(cp, stuck, run)));
  }
  return routed;
};

/**
 * A retirement refused because confirmed external effects have not settled names the runs it waits on. A
 * run terminal in BLOCKED_POST_MERGE never settles; once that run's stall has reached the CEO, the held
 * retirement does too, as its own RETIREMENT_HELD incident. Treating such a run as settled is a pending
 * transition, so the refusal stands.
 */
export const retirementWaitsForSettlement = (
  cp: StallPorts,
  projectId: string,
  settling: ReadonlyArray<{ run_id: string; state: string }>,
): Decision<never> => {
  for (const run of settling) {
    if (run.state !== RunState.BLOCKED_POST_MERGE) continue;
    if (noticeStatus(cp, runStalled(cp, run.run_id, {})).state === "NOT_ENQUEUED") continue;
    deliverIncident(cp, {
      cls: IncidentClass.RETIREMENT_HELD,
      subject: run.run_id,
      runId: run.run_id,
      episode: runEpisode(cp.db, run.run_id),
      payload: {
        stall: "PROJECT_RETIREMENT_HELD",
        owner: STALL_OWNER,
        projectId,
        state: run.state,
        reason:
          "the project's retirement waits for confirmed external effects to settle, and this run is terminal in " +
          "BLOCKED_POST_MERGE, which nothing settles",
        action:
          "none within existing authority: the project stays suspended and its retirement request stays pending, asked " +
          "again on every daemon pass; see needsTransition",
        needsTransition:
          "retirement over a terminal BLOCKED_POST_MERGE run whose merged effects are kept, treated as settled for retirement (pending)",
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
