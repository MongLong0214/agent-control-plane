import { randomUUID } from "node:crypto";

import type { ControlPlane } from "../app/control-plane.ts";
import { NotificationKind } from "../ceo/production-gate.ts";
import { type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { ArtifactKind, Role, RunKind, RunState, roleKeyFor } from "../domain/types.ts";
import { currentBranch } from "../git/git.ts";
import type { DaemonFinalizerAuthority } from "../guard/managed-write-guard.ts";
import {
  deriveConfirmedMergePlan,
  executePreparedConfirmedMerge,
  prepareConfirmedMerge,
  publishConfirmedBranch,
  publishConfirmedMergeGate,
  type ConfirmedMergePlan,
  type ConfirmedMergePorts,
} from "../github/confirmed-merge-operation.ts";
import type { CandidateSnapshot } from "../snapshot/candidate-snapshot.ts";
import { verifySnapshotFreshness } from "../snapshot/candidate-snapshot.ts";
import type { CompletionAuthority } from "../run/run-engine.ts";
import type {
  ActivatedWorkflowEvidence,
  FirstActivationWorkflowEvidence,
  GrantConsumer,
  ManifestActivationTarget,
} from "../registry/manifest-activation-grants.ts";
import { GitHubAppClient, transportOutcome } from "../github/github-kernel.ts";
import { workflowDigestAtCommit } from "../github/workflow-digest-at-commit.ts";

type ChangeTarget = Extract<ManifestActivationTarget, { kind: "CHANGE" }>;
type FirstTarget = Extract<ManifestActivationTarget, { kind: "FIRST" }>;

const FINALIZATION_LEASE_TTL_MS = 30 * 60_000;

/**
 * #1189 B5 (CEO ruling 5) — a refusal before anything merged that the daemon retries waits 1, 2, 4, 8 …
 * minutes, never more than the hourly ceiling, and a candidate gets at most FINALIZATION_RETRY_CAP automatic
 * retries: its first attempt is not one of them. Every refusal is counted durably, per failure and in total,
 * so an intervening different failure resets nothing; a failure whose fix is someone else's allows no retry
 * at all. Once a cap is reached nothing retries the run automatically, not the watchdog and not a daemon
 * start, and the owner of its fix is told once. It stays approved and is never FAILED for a spent budget.
 */
const FINALIZATION_RETRY_BASE_MS = 60_000;
const FINALIZATION_RETRY_CEILING_MS = 60 * 60_000;
export const FINALIZATION_RETRY_CAP = 5;

type RetryClass = "TRANSIENT" | "UNCLASSIFIED" | "OWNER_ACTION" | "AUTHORITY_RECOVERY" | "MERGE_OUTCOME_UNKNOWN";

/** What a hand-off at a cap adds to its action: nothing retries the run automatically any more. */
const RETRIES_STOPPED =
  "The daemon no longer retries this candidate automatically, a restart included; it stays approved until it is cancelled " +
  "or, for a CONTRACT_CHANGE, re-entered with a CONFIRM";

const HAND_OFF_WHY = "a CEO-approved run keeps being refused before its merge; it stays approved, and the daemon has stopped retrying it";

/** What a cap's notice carries besides `whyItMatters`; its FINALIZATION_HANDED_OFF record keeps each of them. */
const HAND_OFF_NOTICE_FIELDS = [
  "candidateSnapshotDigest", "failureReasonCode", "failureClass", "failureCause", "limit", "owner", "action", "blocker",
  "retries", "retryCap", "reason",
] as const;

/**
 * What becomes of an approved run whose finalization was refused before any merge receipt existed. A retried
 * refusal's `failureCause` is what "the same failure" means for its cap: every transport failure is one
 * (GitHub unreachable reads as a caught denial at one step and a thrown error at the next), any other is
 * its own reason code. `retries` is how many automatic retries that failure allows (the candidate's total
 * is capped as well).
 */
type PreMergeRoute =
  | { disposition: "REVISION" | "UNRECOVERABLE" }
  | {
      disposition: "RETRY";
      failureClass: RetryClass;
      failureCause: string;
      retries: number;
      owner: "CEO" | "OWNER";
      action: string;
    };

type RetryRoute = Extract<PreMergeRoute, { disposition: "RETRY" }>;

/**
 * The approved candidate cannot merge as it is, and its CTO can fix that with a new candidate: its base or head
 * moved, it conflicts or fails a declared check, or its binding to the frozen candidate and the approval broke.
 */
const REVISION_REASON_CODES: ReadonlySet<ReasonCode> = new Set([
  ReasonCode.MERGE_BASE_STALE,
  ReasonCode.MERGE_HEAD_STALE,
  ReasonCode.SNAPSHOT_STALE,
  ReasonCode.EVIDENCE_STALE,
  ReasonCode.MERGE_CONFLICT,
  ReasonCode.MERGE_CHECK_FAILED,
  ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED,
  ReasonCode.PR_BRANCH_CONTRACT_VIOLATION,
]);

/**
 * Deterministic refusals whose fix is outside the CTO: they allow no automatic retry, so the first refusal
 * hands them on. MERGE_CLAIM_INVALID (CEO ruling 3) is authority, not a candidate defect: the branch claim
 * is missing, released, held by another owner generation or not resolvable to one branch, and a revision
 * request would go to an owner whose authority is the thing in question.
 */
const OWNER_ACTIONS: ReadonlyMap<ReasonCode, Pick<RetryRoute, "failureClass" | "owner" | "action">> =
  new Map<ReasonCode, Pick<RetryRoute, "failureClass" | "owner" | "action">>([
    [ReasonCode.HUMAN_GATE_UNSATISFIED, { failureClass: "OWNER_ACTION", owner: "OWNER", action: "record the owner decision the run's human gate requires for this candidate" }],
    [ReasonCode.GITHUB_APP_PERMISSION_DENIED, { failureClass: "OWNER_ACTION", owner: "OWNER", action: "restore the GitHub App's permissions to an owner-approved grant shape" }],
    [ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE, { failureClass: "OWNER_ACTION", owner: "OWNER", action: "restore the daemon's GitHub App credential" }],
    [ReasonCode.MANIFEST_ACTIVATION_AUTHORITY_STALE, { failureClass: "OWNER_ACTION", owner: "CEO", action: "re-enter with a CONFIRM of the same candidate" }],
    [ReasonCode.MERGE_CLAIM_INVALID, {
      failureClass: "AUTHORITY_RECOVERY", owner: "CEO",
      action: "recover the run owner's authority over the branch it merges (its claim is missing, released, or held under another " +
        "owner generation); the candidate is not sent for revision, so no owner is asked to change it",
    }],
  ]);

/**
 * #1189 B5 (CEO ruling 1) — stale base, conflict and a fixable check failure go back for revision; a
 * deterministic refusal someone else owns is handed to them; only an unrecoverable refusal whose
 * non-application GitHub confirmed ends the run; everything else, transient infrastructure first, is retried
 * with backoff up to a cap. The lists are narrow on purpose: an unknown refusal is retried and handed to the
 * CEO, never failed and never un-approved.
 */
const classifyPreMergeRefusal = (kind: RunKind, failure: Decision<unknown>): PreMergeRoute => {
  const evidence = failure.evidence as Record<string, unknown>;
  // The pinned merge strategy is one GitHub's pull-request merge API cannot perform: no revision of this
  // run's candidate changes its pinned contract. FAILED only on the kernel's read that the pull request is
  // not merged (CEO rulings 2 and 6); without it the refusal is retried like an unknown one.
  if (failure.reasonCode === ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED && evidence["mergeStrategy"] === "fast_forward") {
    if (evidence["pullMerged"] === false) return { disposition: "UNRECOVERABLE" };
    return {
      disposition: "RETRY", failureClass: "UNCLASSIFIED", failureCause: failure.reasonCode, retries: FINALIZATION_RETRY_CAP, owner: "CEO",
      action: "the pinned fast_forward strategy cannot be merged through GitHub's API, and the pull request could not be confirmed unmerged; confirm it, then cancel the run",
    };
  }
  const cause = failure.reasonCode === ReasonCode.INTERNAL_ERROR && typeof evidence["errorReasonCode"] === "string"
    ? evidence["errorReasonCode"] as ReasonCode
    : failure.reasonCode;
  const owned = OWNER_ACTIONS.get(cause);
  if (owned) return { disposition: "RETRY", failureCause: cause, retries: 0, ...owned };
  // A branch already published at another commit is never moved; the CTO publishes a new candidate on a new branch.
  const branchElsewhere = failure.reasonCode === ReasonCode.RESOURCE_COLLISION &&
    typeof evidence["expected"] === "string" && typeof evidence["observed"] === "string";
  if (REVISION_REASON_CODES.has(failure.reasonCode) || branchElsewhere) {
    // A CONTRACT_CHANGE holds the one activation grant its CONFIRM issued, so returned for revision it could
    // never be confirmed again.
    return kind === RunKind.CONTRACT_CHANGE
      ? {
          disposition: "RETRY", failureClass: "OWNER_ACTION", failureCause: failure.reasonCode, retries: 0, owner: "CEO",
          action: "decide how this CONTRACT_CHANGE proceeds: it holds the one activation grant its CONFIRM issued, so it is not returned for revision automatically",
        }
      : { disposition: "REVISION" };
  }
  // Infrastructure: a GitHub request that was not answered, answered 5xx, or was rate-limited (429). The
  // client reports each as PROBE_FAILED, caught as a denial or thrown (then INTERNAL_ERROR naming it). An
  // answered 4xx, and an error that is not the client's, is not transient: it is retried the same way, but
  // named for what it is.
  const status = typeof evidence["status"] === "number" ? evidence["status"] : null;
  const transient = cause === ReasonCode.PROBE_FAILED && (status === null || status >= 500 || status === 429);
  return {
    disposition: "RETRY",
    failureClass: transient ? "TRANSIENT" : "UNCLASSIFIED",
    failureCause: transient ? "TRANSIENT" : cause,
    retries: FINALIZATION_RETRY_CAP,
    owner: "CEO",
    action: transient
      ? "nothing in the candidate to fix: look at GitHub and the network"
      : "inspect the refusal; the approval stands until the run merges or the refusal is fixed",
  };
};

/**
 * #1189 B5 (CEO rulings 4 and 5) — a merge request that was sent and came back with an error status (a 405
 * included) or with nothing: whether it merged is unknown, and its PENDING receipt holds it (the kernel's
 * MERGE_OUTCOME_UNKNOWN). Every refusal while it is open counts as this one failure, and it is never sent for
 * revision or FAILED: the next attempt re-reads the pull before it replays anything or sends a second merge
 * request, and only a read that shows it unmerged turns it into a refusal made before any merge.
 */
const UNKNOWN_MERGE_ROUTE: RetryRoute = {
  disposition: "RETRY",
  failureClass: "MERGE_OUTCOME_UNKNOWN",
  failureCause: "MERGE_OUTCOME_UNKNOWN",
  retries: FINALIZATION_RETRY_CAP,
  owner: "CEO",
  action: "a merge request was sent and whether it merged is unknown: its PENDING merge receipt stays until a re-read of the pull " +
    "request settles it; read the pull request and reconcile that receipt",
};

const retryDelayMs = (refusals: number): number =>
  Math.min(FINALIZATION_RETRY_BASE_MS * 2 ** (refusals - 1), FINALIZATION_RETRY_CEILING_MS);

/**
 * The concrete blocker a hand-off names: the refusal's code and message. Bounded to the length the audit log
 * admits for a field it has not reviewed, so the notice's own record keeps it.
 */
const blockerOf = (failure: Decision<unknown>): string =>
  `${failure.reasonCode}: ${failure.allowed ? "" : failure.message}`.slice(0, 200);

type FinalizationAttemptState = "RUNNING" | "RELEASED" | "COMPLETED" | "BLOCKED";

interface FinalizationAttemptRow {
  run_id: string;
  attempt_id: string;
  lease_owner: string;
  candidate_digest: string;
  state: FinalizationAttemptState;
  started_at: string;
  deadline_at: string;
  released_at: string | null;
  completed_at: string | null;
  last_step: string;
  failure_reason: string | null;
  compensation_plan_json: string | null;
}

interface DurableMergeReceipt {
  repository_identity: string;
  status: "PENDING" | "APPLIED";
  verified: number;
  response_json: string;
}

export interface ReclaimedFinalizationAttempt {
  runId: string;
  attemptId: string;
  startedAt: string;
  deadlineAt: string;
  ageMs: number;
}

export interface FinalizationResult {
  runId: string;
  state: RunState;
  attemptId: string | null;
  repositories: Array<{ repositoryIdentity: string; mergeCommitSha: string }>;
}

/** Narrow capability bundle handed by ControlPlane's daemon factory. */
export interface DaemonFinalizationAuthorities {
  readonly write: DaemonFinalizerAuthority;
  readonly completion: CompletionAuthority;
}

interface PlannedRepository {
  plan: ConfirmedMergePlan;
  pullNumber: number;
  /** This run's merge of the pull is already proven: nothing is published, prepared or gated for it again. */
  merged: boolean;
}

/**
 * The one daemon-owned owner of the irreversible GitHub sequence. Its lease is intentionally
 * separate from individual GitHub receipts: a process death can release/reclaim orchestration
 * while the receipt protocol independently proves whether a one-way remote effect landed.
 */
export class ApprovedRunFinalizer {
  readonly #ports: ConfirmedMergePorts;

  constructor(
    private readonly cp: ControlPlane,
    private readonly leaseOwner = `agentcpd:${process.pid}:${randomUUID()}`,
    authorities?: DaemonFinalizationAuthorities,
  ) {
    const issued = authorities ?? cp.daemonFinalizationAuthorities();
    this.#ports = {
      github: cp.github,
      runs: cp.runs,
      artifacts: cp.artifacts,
      projects: cp.projects,
      clock: cp.clock,
      daemonFinalizerAuthority: issued.write,
    };
    this.#completionAuthority = issued.completion;
  }

  readonly #completionAuthority;

  /**
   * Integration §17.3 — project an already activated project's portable tickets through
   * the daemon-owned GitHub boundary. The caller supplies intent only; the run's pinned
   * owner and the non-forgeable finalizer capability are taken from trusted state here.
   */
  async projectTickets(
    runId: string,
    repositoryIdentity: string,
    tickets: ReadonlyArray<{ id: string; title: string; body: string; labels?: string[] }>,
  ): Promise<Decision<{ created: number; updated: number }>> {
    const run = this.cp.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (!run.ownerSessionId || run.ownerBindingGeneration == null) {
      return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "run has no pinned owner for issue projection", {
        runId,
        repositoryIdentity,
      });
    }
    return this.cp.github.issueProject(runId, repositoryIdentity, tickets, {
      ownerSessionId: run.ownerSessionId,
      ownerBindingGeneration: run.ownerBindingGeneration,
      daemonFinalizerAuthority: this.#ports.daemonFinalizerAuthority,
    });
  }

  /** Resume every expired lease deterministically; the caller decides when to run the work. */
  reclaimExpiredAttempts(): ReclaimedFinalizationAttempt[] {
    return this.cp.db.tx(() => {
      const now = this.cp.clock.now();
      const releasedAt = now.toISOString();
      const stale = this.cp.db.all<Pick<FinalizationAttemptRow, "run_id" | "attempt_id" | "started_at" | "deadline_at">>(
        `SELECT run_id, attempt_id, started_at, deadline_at
           FROM finalization_attempts
          WHERE state = 'RUNNING' AND deadline_at <= ?
          ORDER BY deadline_at, run_id`,
        [releasedAt],
      );
      const reclaimed: ReclaimedFinalizationAttempt[] = [];
      for (const attempt of stale) {
        const changed = this.cp.db.run(
          `UPDATE finalization_attempts
              SET state = 'RELEASED', released_at = ?, last_step = 'LEASE_RECLAIMED',
                  failure_reason = ?
            WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING' AND deadline_at <= ?`,
          [
            releasedAt,
            ReasonCode.FINALIZATION_ATTEMPT_STALE,
            attempt.run_id,
            attempt.attempt_id,
            releasedAt,
          ],
        );
        if (changed.changes !== 1) continue;
        const item: ReclaimedFinalizationAttempt = {
          runId: attempt.run_id,
          attemptId: attempt.attempt_id,
          startedAt: attempt.started_at,
          deadlineAt: attempt.deadline_at,
          ageMs: now.getTime() - new Date(attempt.started_at).getTime(),
        };
        reclaimed.push(item);
        this.cp.audit.record({
          kind: "FINALIZATION_ATTEMPT_RECLAIMED",
          runId: item.runId,
          reasonCode: ReasonCode.FINALIZATION_ATTEMPT_STALE,
          evidence: { ...item, leaseOwner: this.leaseOwner },
        });
      }
      return reclaimed;
    });
  }

  /**
   * Confirm CEO approval again, then execute the complete PR → gate → ordered merge → exact
   * post-merge verification sequence. A failure before any merge releases the lease for a
   * safe retry; a failure after a possible merge terminates BLOCKED_POST_MERGE with a durable
   * compensation plan instead of releasing another repository.
   */
  async finalizeApprovedRun(runId: string): Promise<Decision<FinalizationResult>> {
    const initial = this.cp.runs.get(runId);
    if (!initial) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (initial.state === RunState.COMPLETED) {
      // A process can die after the authoritative COMPLETED transition commits but before
      // its lease row is marked complete. Reconcile that harmless bookkeeping gap without
      // reopening any managed write or converting a successful run into a compensation case.
      this.completeAnyRunningAttempt(runId);
      for (const receipt of this.durableMergeReceipts(runId)) {
        if (receipt.status !== "APPLIED" || receipt.verified !== 1) continue;
        const repository = this.cp.repositories.byIdentity(receipt.repository_identity);
        if (repository) await this.cp.repositories.observe(repository.repositoryId);
      }
      return allow(
        ReasonCode.MERGE_IDEMPOTENT_REPLAY,
        this.completedResult(runId),
        { replayed: true },
      );
    }
    if (initial.state === RunState.BLOCKED_POST_MERGE ||
        (initial.state === RunState.POST_MERGE_VERIFYING && this.wasPostMergeResumed(runId))) {
      return this.resumePostMerge(runId);
    }
    if (!this.isFinalizingState(initial.state)) {
      return deny(ReasonCode.GATE_AUTHORITY_DENIED, "run has no durable CEO approval to finalize", {
        runId,
        state: initial.state,
      });
    }
    const candidateDigest = this.cp.runs.currentCandidate(runId);
    if (!candidateDigest) {
      return deny(ReasonCode.EVIDENCE_MISSING, "CEO-approved run has no current candidate", { runId });
    }

    // #246 B2-b — one CONTRACT_CHANGE of a project finalizes at a time. Asked synchronously with the
    // attempt's acquisition and before any GitHub write, so a second grant on the same base waits rather
    // than merging; the compare-and-set at PRE_MERGE then refuses it once the first has activated.
    if (initial.kind === RunKind.CONTRACT_CHANGE && initial.projectId) {
      const finalizing = this.cp.manifestGrants.finalizingContractChanges(initial.projectId, runId);
      if (finalizing.length > 0) {
        return deny(ReasonCode.CONTRACT_CHANGE_FINALIZATION_OVERLAP, "another CONTRACT_CHANGE of this project is finalizing", {
          runId,
          projectId: initial.projectId,
          finalizing,
        });
      }
    }
    const acquired = this.acquireAttempt(runId, candidateDigest);
    if (!acquired.allowed) return acquired as Decision<FinalizationResult>;
    const attemptId = acquired.value;
    // #246 B2-b, CEO ruling 2 — the attempt runs for the CONTRACT_CHANGE grant's consumer as it stands
    // now: the authenticated CEO session whose call confirmed, or that re-entered since. Read in the
    // same synchronous step as the acquisition, and required again when activation commits.
    const consumer = initial.kind === RunKind.CONTRACT_CHANGE ? this.cp.manifestGrants.consumerOf(runId) : null;
    let completed = false;
    try {
      // Resolve every participant before planning or any remote write.
      for (const repository of this.cp.runs.repositoriesOf(runId)) {
        const inputs = this.cp.github.postMergeVerificationInputs(runId, repository.identity);
        if (!inputs.allowed) return this.handleFailure(runId, attemptId, inputs);
      }
      const plans = await this.reconfirmAndPlan(runId, candidateDigest, consumer);
      if (!plans.allowed) return this.handleFailure(runId, attemptId, plans as Decision<unknown>);

      // #1189 B5 — a merge request this run already sent is settled before anything is replayed: the replay
      // would read the pull it may have merged (GitHub closes a merged pull) and refuse it as closed. Settlement
      // only reads the pull and records what the read establishes: merged, the merge is proven and its receipt
      // kept; unmerged, nothing was applied and the reservation goes, and the ordinary path below publishes,
      // prepares (re-reading the pull's title and body), gates and evaluates before any new merge request; a read
      // that cannot tell keeps the receipt PENDING and the run held. A merged pull is never treated as closed.
      if (this.cp.runs.require(runId).state === RunState.MERGING) {
        for (const plan of plans.value) {
          const receipt = this.mergeReceiptPull(runId, plan.repositoryIdentity);
          if (receipt?.status !== "PENDING") continue;
          this.touchAttempt(runId, attemptId, `RECONCILE_MERGE:${plan.repositoryIdentity}`);
          const settled = await this.cp.github.mergeSettle({ ...plan.merge, pullNumber: receipt.pullNumber });
          if (!settled.allowed) return this.handleFailure(runId, attemptId, settled as Decision<unknown>);
        }
      }

      const prepared: PlannedRepository[] = [];
      for (const plan of plans.value) {
        const receipt = this.mergeReceiptPull(runId, plan.repositoryIdentity);
        if (receipt?.status === "APPLIED" && receipt.verified === 1) {
          prepared.push({ plan, pullNumber: receipt.pullNumber, merged: true });
          continue;
        }
        // #512 S-PUSH — the candidate branch reaches GitHub before its PR is prepared. Create-only: a
        // branch already at the exact candidate is reconciled, any other commit refuses (D4).
        this.touchAttempt(runId, attemptId, `PUBLISH_BRANCH:${plan.repositoryIdentity}`);
        const published = await publishConfirmedBranch(this.#ports, plan);
        if (!published.allowed) return this.handleFailure(runId, attemptId, published as Decision<unknown>);
        this.touchAttempt(runId, attemptId, `PREPARE_PR:${plan.repositoryIdentity}`);
        const pr = await prepareConfirmedMerge(this.#ports, plan);
        if (!pr.allowed) return this.handleFailure(runId, attemptId, pr as Decision<unknown>);
        prepared.push({ plan, pullNumber: pr.value.pullNumber, merged: false });
      }

      // Gate publication is deliberately a separate all-repository phase. No irreversible
      // merge starts until every target has a durable PR intent and trusted gate receipt.
      for (const repository of prepared) {
        if (repository.merged) continue;
        this.touchAttempt(runId, attemptId, `PUBLISH_GATE:${repository.plan.repositoryIdentity}`);
        const gate = await publishConfirmedMergeGate(this.#ports, repository.plan);
        if (!gate.allowed) return this.handleFailure(runId, attemptId, gate as Decision<unknown>);
      }

      const beforeMerge = this.cp.runs.require(runId);
      if (beforeMerge.state === RunState.CEO_APPROVED) {
        const transitioning = this.cp.runs.transition(
          runId,
          RunState.MERGING,
          "daemon finalization gates published",
          { candidateSnapshotDigest: candidateDigest, attemptId },
        );
        if (!transitioning.allowed) return this.handleFailure(runId, attemptId, transitioning as Decision<unknown>);
      }

      if (prepared.length === 0) {
        // An empty participation set is a legal administrative finalization. There is no
        // PR, gate, merge, or post-merge remote check to release, but the run still passes
        // through the ordinary daemon-owned finalization states and completion capability.
        const noMergeEvidence = {
          attemptId,
          candidateSnapshotDigest: candidateDigest,
          repositories: [],
          repositoryCount: 0,
          nothingToMerge: true,
          predicate: "no participating repositories",
        };
        const current = this.cp.runs.require(runId);
        if (current.state === RunState.MERGING) {
          const verifying = this.cp.runs.transition(
            runId,
            RunState.POST_MERGE_VERIFYING,
            "no participating repositories; nothing to merge",
            noMergeEvidence,
          );
          if (!verifying.allowed) return this.handleFailure(runId, attemptId, verifying as Decision<unknown>);
        }
        const postMerge = this.cp.runs.require(runId);
        if (postMerge.state !== RunState.POST_MERGE_VERIFYING) {
          return this.handleFailure(
            runId,
            attemptId,
            deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "empty finalization did not reach post-merge verification", {
              runId,
              state: postMerge.state,
            }),
          );
        }
        const done = await this.complete(
          runId,
          attemptId,
          consumer,
          "daemon finalized run with nothing to merge",
          noMergeEvidence,
        );
        if (!done.allowed) return this.handleFailure(runId, attemptId, done);
        this.completeAttempt(runId, attemptId);
        completed = true;
        this.cp.audit.record({
          kind: "FINALIZATION_COMPLETED",
          runId,
          evidence: { ...noMergeEvidence, finalization: "NO_PARTICIPATING_REPOSITORIES" },
        });
        return allow(ReasonCode.OK, {
          runId,
          state: RunState.COMPLETED,
          attemptId,
          repositories: [],
        });
      }

      const merged: Array<{ repositoryIdentity: string; mergeCommitSha: string }> = [];
      for (let index = 0; index < prepared.length; index += 1) {
        const repository = prepared[index]!;
        const current = this.cp.runs.require(runId);
        if (current.state === RunState.POST_MERGE_VERIFYING) {
          const advancing = this.cp.runs.transition(
            runId,
            RunState.MERGING,
            "resume ordered daemon finalization",
            { attemptId, repositoryIdentity: repository.plan.repositoryIdentity },
          );
          if (!advancing.allowed) return this.handleFailure(runId, attemptId, advancing as Decision<unknown>);
        }

        const existing = this.mergeReceipt(runId, repository.plan.repositoryIdentity);
        let mergeCommitSha: string;
        if (existing?.status === "APPLIED" && existing.verified === 1) {
          const parsed = this.mergeSha(existing);
          if (!parsed) {
            return this.handleFailure(
              runId,
              attemptId,
              deny(ReasonCode.EVIDENCE_MISSING, "recorded merge receipt has no exact merge SHA", {
                runId,
                repositoryIdentity: repository.plan.repositoryIdentity,
              }),
            );
          }
          mergeCommitSha = parsed;
        } else {
          this.touchAttempt(runId, attemptId, `MERGE:${repository.plan.repositoryIdentity}`);
          const executed = await executePreparedConfirmedMerge(this.#ports, repository.plan, repository.pullNumber);
          if (!executed.allowed) return this.handleFailure(runId, attemptId, executed as Decision<unknown>);
          mergeCommitSha = executed.value.mergeCommitSha;
        }
        const localRepository = this.cp.repositories.byIdentity(repository.plan.repositoryIdentity);
        if (localRepository) await this.cp.repositories.observe(localRepository.repositoryId);
        merged.push({ repositoryIdentity: repository.plan.repositoryIdentity, mergeCommitSha });

        const afterMerge = this.cp.runs.require(runId);
        if (afterMerge.state === RunState.MERGING) {
          const verifying = this.cp.runs.transition(
            runId,
            RunState.POST_MERGE_VERIFYING,
            "exact post-merge verification required",
            { attemptId, repositoryIdentity: repository.plan.repositoryIdentity, mergeCommitSha },
          );
          if (!verifying.allowed) return this.handleFailure(runId, attemptId, verifying as Decision<unknown>);
        }
        this.touchAttempt(runId, attemptId, `POST_MERGE_VERIFY:${repository.plan.repositoryIdentity}`);
        const verified = await this.cp.github.postMergeVerify(
          runId,
          repository.plan.repositoryIdentity,
          mergeCommitSha,
          [],
          this.#ports.daemonFinalizerAuthority,
        );
        if (!verified.allowed) return this.handleFailure(runId, attemptId, verified as Decision<unknown>);

        if (index === prepared.length - 1) {
          const done = await this.complete(
            runId,
            attemptId,
            consumer,
            "all ordered merges completed exact post-merge verification",
            { attemptId, merged },
          );
          if (!done.allowed) return this.handleFailure(runId, attemptId, done);
        }
      }

      this.completeAttempt(runId, attemptId);
      completed = true;
      this.cp.audit.record({
        kind: "FINALIZATION_COMPLETED",
        runId,
        evidence: { attemptId, candidateSnapshotDigest: candidateDigest, repositories: merged },
      });
      return allow(ReasonCode.OK, {
        runId,
        state: RunState.COMPLETED,
        attemptId,
        repositories: merged,
      });
    } catch (error) {
      return this.handleFailure(
        runId,
        attemptId,
        deny(ReasonCode.INTERNAL_ERROR, "daemon finalization raised an unexpected error", {
          runId,
          error: error instanceof Error ? error.message : String(error),
          // #1189 B5 — a GitHub read that threw (the kernel does not catch every one) keeps what the
          // classification needs: whether GitHub answered, its status, and the denial's own code.
          ...transportOutcome(error),
          ...(isAcpError(error) ? { errorReasonCode: error.reasonCode } : {}),
        }),
      );
    } finally {
      if (!completed) this.releaseAttemptIfRunning(runId, attemptId);
    }
  }

  /**
   * #1189 B5 — whether the daemon's sweep (at start and on every watchdog tick) may try this run now. A
   * refusal before any merge that the daemon retries waits out its backoff, across restarts; one that reached a
   * cap is not tried again automatically at all; every other run, and a run whose candidate changed since, is
   * due.
   */
  retryDue(runId: string): boolean {
    const run = this.cp.runs.get(runId);
    if (!run || (run.state !== RunState.CEO_APPROVED && run.state !== RunState.MERGING)) return true;
    const latest = this.latestRetryRecord(runId);
    if (!latest || latest.candidateSnapshotDigest !== this.cp.runs.currentCandidate(runId)) return true;
    if (latest.retryNotBefore === null) return false;
    return this.cp.clock.now().getTime() >= Date.parse(latest.retryNotBefore);
  }

  /**
   * #1189 B5 — a cap's notice that could not be enqueued (no CEO was bound to take it) is still owed. The sweep
   * asks for it on each pass over a run it does not retry; it is enqueued once a CEO is bound, and only once. The
   * run itself is not retried for it, and while no CEO is bound nothing is attempted or recorded.
   */
  deliverOwedHandOff(runId: string): void {
    const run = this.cp.runs.get(runId);
    if (!run || (run.state !== RunState.CEO_APPROVED && run.state !== RunState.MERGING)) return;
    const candidateDigest = this.cp.runs.currentCandidate(runId);
    if (!candidateDigest || !this.cp.bindings.active(roleKeyFor(Role.CEO))) return;
    for (const entry of this.cp.audit.forRun(runId)) {
      const { candidateSnapshotDigest, delivered, limit, failureCause } = entry.evidence;
      if (entry.kind !== "FINALIZATION_HANDED_OFF" || candidateSnapshotDigest !== candidateDigest || delivered !== false ||
          (limit !== "FAILURE" && limit !== "CANDIDATE") || typeof failureCause !== "string" ||
          this.handedOff(runId, candidateDigest, limit, failureCause)) continue;
      const notice = Object.fromEntries(HAND_OFF_NOTICE_FIELDS.map((field) => [field, entry.evidence[field] ?? null]));
      const notified = this.cp.ceo.notify(NotificationKind.CRITICAL_SYSTEM_FAILURE, runId, { ...notice, whyItMatters: HAND_OFF_WHY });
      if (!notified.allowed) return;
      this.cp.audit.record({
        kind: "FINALIZATION_HANDED_OFF",
        runId,
        reasonCode: entry.reasonCode as ReasonCode | null,
        evidence: { ...entry.evidence, delivered: true, owedFrom: entry.at },
      });
    }
  }

  private wasPostMergeResumed(runId: string): boolean {
    return this.cp.audit.forRun(runId).some((entry) => entry.kind === "FINALIZATION_POST_MERGE_RESUMED");
  }

  /** Receipt-only recovery: terminal cleanup has already retired workers and released claims. */
  private async resumePostMerge(runId: string): Promise<Decision<FinalizationResult>> {
    const acquired = this.cp.db.txDecision<{ attemptId: string; repositories: FinalizationResult["repositories"] }>(() => {
      const prior = this.attempt(runId);
      const run = this.cp.runs.require(runId);
      const candidateDigest = this.cp.runs.currentCandidate(runId);
      const receipts = this.durableMergeReceipts(runId);
      const blocked = run.state === RunState.BLOCKED_POST_MERGE;
      if (!prior || !candidateDigest || prior.candidate_digest !== candidateDigest || receipts.length === 0 ||
          receipts.some((receipt) => receipt.status !== "APPLIED" || receipt.verified !== 1 || !this.mergeSha(receipt)) ||
          (blocked && (prior.state !== "BLOCKED" || prior.failure_reason !== ReasonCode.POST_MERGE_CHECKS_NOT_DECLARED)) ||
          (!blocked && (run.state !== RunState.POST_MERGE_VERIFYING || !this.wasPostMergeResumed(runId)))) {
        return deny(ReasonCode.FINALIZATION_COMPENSATION_REQUIRED,
          "run has a partial merge failure and requires its durable compensation plan", { runId, attempt: prior });
      }
      const repositories = receipts.map((receipt) => ({
        repositoryIdentity: receipt.repository_identity,
        mergeCommitSha: this.mergeSha(receipt)!,
      }));
      const now = this.cp.clock.now();
      const startedAt = now.toISOString();
      const deadlineAt = new Date(now.getTime() + FINALIZATION_LEASE_TTL_MS).toISOString();
      const attemptId = `finalize_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      if (blocked) {
        const changed = this.cp.db.run(
          `UPDATE finalization_attempts
              SET attempt_id = ?, lease_owner = ?, state = 'RUNNING', started_at = ?, deadline_at = ?,
                  released_at = NULL, completed_at = NULL, last_step = 'POST_MERGE_RESUMED',
                  failure_reason = NULL, compensation_plan_json = NULL
            WHERE run_id = ? AND attempt_id = ? AND state = 'BLOCKED'
              AND failure_reason = ? AND candidate_digest = ?`,
          [attemptId, this.leaseOwner, startedAt, deadlineAt, runId, prior.attempt_id,
            ReasonCode.POST_MERGE_CHECKS_NOT_DECLARED, candidateDigest],
        );
        if (changed.changes !== 1) return deny(ReasonCode.CONFLICT, "blocked attempt no longer owns this run", { runId });
        // The lease table holds only the current attempt. Preserve the entire old attempt in a
        // new immutable audit row before replacing its bookkeeping with the new lease.
        const history = this.cp.audit.record({
          kind: "FINALIZATION_POST_MERGE_RESUMED", runId,
          evidence: {
            resumedFromAttemptId: prior.attempt_id,
            reason: prior.failure_reason,
            priorAttempt: {
              ...prior,
              compensation_plan_json: prior.compensation_plan_json ? JSON.parse(prior.compensation_plan_json) : null,
            },
          },
        });
        if (!history.allowed) return history;
        this.cp.audit.record({
          kind: "FINALIZATION_ATTEMPT_ACQUIRED", runId,
          evidence: { attemptId, candidateSnapshotDigest: candidateDigest, leaseOwner: this.leaseOwner, deadlineAt, resumed: true },
        });
        const transitioned = this.cp.runs.transition(runId, RunState.POST_MERGE_VERIFYING,
          "resume post-merge verification with no checks declared", {
            resumedFromAttemptId: prior.attempt_id, reason: ReasonCode.POST_MERGE_CHECKS_NOT_DECLARED,
          });
        if (!transitioned.allowed) return transitioned;
        return allow(ReasonCode.OK, { attemptId, repositories });
      }
      // A process death after the recovery transition must also stay on this receipt-only path.
      const retry = this.acquireAttempt(runId, candidateDigest);
      if (!retry.allowed) return retry;
      return allow(ReasonCode.OK, { attemptId: retry.value, repositories });
    });
    if (!acquired.allowed) return acquired;
    const { attemptId, repositories } = acquired.value;
    let completed = false;
    try {
      for (const repository of repositories) {
        const localRepository = this.cp.repositories.byIdentity(repository.repositoryIdentity);
        if (localRepository) await this.cp.repositories.observe(localRepository.repositoryId);
        this.touchAttempt(runId, attemptId, `POST_MERGE_VERIFY:${repository.repositoryIdentity}`);
        const verified = await this.cp.github.postMergeVerify(runId, repository.repositoryIdentity,
          repository.mergeCommitSha, [], this.#ports.daemonFinalizerAuthority);
        if (!verified.allowed) return this.handleFailure(runId, attemptId, verified);
      }
      const run = this.cp.runs.require(runId);
      const consumer = run.kind === RunKind.CONTRACT_CHANGE ? this.cp.manifestGrants.consumerOf(runId) : null;
      const done = await this.complete(runId, attemptId, consumer, "resumed post-merge verification completed",
        { attemptId, repositories, resumed: true });
      if (!done.allowed) return this.handleFailure(runId, attemptId, done);
      this.completeAttempt(runId, attemptId);
      completed = true;
      this.cp.audit.record({ kind: "FINALIZATION_COMPLETED", runId, evidence: { attemptId, repositories, resumed: true } });
      return allow(ReasonCode.OK, { runId, state: RunState.COMPLETED, attemptId, repositories });
    } catch (error) {
      return this.handleFailure(runId, attemptId, deny(ReasonCode.INTERNAL_ERROR, "post-merge recovery raised an unexpected error", {
        runId, error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (!completed) this.releaseAttemptIfRunning(runId, attemptId);
    }
  }

  private async reconfirmAndPlan(
    runId: string,
    candidateDigest: string,
    consumer: GrantConsumer | null,
  ): Promise<Decision<ConfirmedMergePlan[]>> {
    const run = this.cp.runs.get(runId);
    if (!run || !this.isFinalizingState(run.state)) {
      return deny(ReasonCode.GATE_AUTHORITY_DENIED, "CEO approval is no longer current", {
        runId,
        state: run?.state ?? null,
      });
    }
    const ceoConfirmation = this.cp.ceo.currentCeoConfirmation(runId, candidateDigest);
    if (!ceoConfirmation.allowed) return ceoConfirmation as Decision<ConfirmedMergePlan[]>;
    // #246 B2-b — a CONTRACT_CHANGE finalizes only on the grant its CEO CONFIRM issued, asked before any
    // GitHub write: a run that reached CEO_APPROVED any other way, a base another activation moved, or a
    // CEO authority that no longer holds the role merges nothing.
    const granted = run.kind === RunKind.CONTRACT_CHANGE ? this.cp.manifestGrants.verify(runId, "PRE_MERGE", consumer) : null;
    if (granted && !granted.allowed) return granted as Decision<ConfirmedMergePlan[]>;
    if (this.cp.runs.currentCandidate(runId) !== candidateDigest) {
      return deny(ReasonCode.EVIDENCE_STALE, "candidate changed after the finalization lease was acquired", {
        runId,
        candidateSnapshotDigest: candidateDigest,
        currentCandidateSnapshotDigest: this.cp.runs.currentCandidate(runId),
      });
    }
    const snapshotArtifact = this.cp.artifacts.latestForSnapshot<CandidateSnapshot>(
      runId,
      ArtifactKind.CANDIDATE_SNAPSHOT,
      candidateDigest,
    );
    if (!snapshotArtifact || snapshotArtifact.superseded) {
      return deny(ReasonCode.EVIDENCE_STALE, "candidate snapshot is no longer current", {
        runId,
        candidateSnapshotDigest: candidateDigest,
      });
    }
    const freshness = await verifySnapshotFreshness(
      snapshotArtifact.content,
      this.cp.runs.repositoriesOf(runId).map((repository) => ({
        identity: repository.identity,
        checkoutPath: repository.checkoutPath,
        activeManifestDigest: repository.activeManifestDigest,
      })),
    );
    if (!freshness.allowed) return freshness as Decision<ConfirmedMergePlan[]>;

    // #246 B2-b — the workflows the manifest names are compared at the candidate before anything is
    // merged, so a workflow that would refuse activation refuses here, with nothing written; activation
    // compares them again at the merge commit.
    // #512 — a first activation reads every bound revision at its exact commit, the same read
    // ACTIVATION makes again; no merge receipt or branch head is ever read in its place.
    if (granted?.allowed) {
      const workflows = granted.value.kind === "FIRST"
        ? await this.compareFirstActivationWorkflows(runId, granted.value)
        : await this.compareActivationWorkflows(runId, granted.value, snapshotArtifact.content);
      if (!workflows.allowed) return workflows as Decision<ConfirmedMergePlan[]>;
    }

    const humanGate = this.cp.ceo.currentHumanGateDecisionDigest(runId);
    if (!humanGate.allowed) return humanGate as Decision<ConfirmedMergePlan[]>;

    const plans: ConfirmedMergePlan[] = [];
    for (const participant of this.cp.runs.repositoriesOf(runId)) {
      const snapshotRepository = snapshotArtifact.content.repositories.find(
        (repository) => repository.identity === participant.identity,
      );
      if (!snapshotRepository) {
        return deny(ReasonCode.COVERAGE_INCOMPLETE, "candidate omits a participating repository", {
          runId,
          repositoryIdentity: participant.identity,
        });
      }
      let head = participant.workBranch;
      if (!head) {
        head = await currentBranch(participant.checkoutPath);
      }
      if (!head || head === "HEAD") {
        return deny(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED, "finalization cannot derive the candidate branch", {
          runId,
          repositoryIdentity: participant.identity,
        });
      }
      const plan = deriveConfirmedMergePlan(this.#ports, {
        runId,
        repositoryIdentity: participant.identity,
        head,
        title: `ACP finalization: ${run.goal}`,
        body: `Automated daemon finalization for run ${runId}.`,
        declaredParent: snapshotRepository.sourceBranch ?? null,
        humanGateDigest: humanGate.value,
      });
      if (!plan.allowed) return plan as Decision<ConfirmedMergePlan[]>;
      plans.push(plan.value);
    }
    return allow(ReasonCode.OK, plans);
  }

  /**
   * COMPLETED, after the last exact post-merge verification. A CONTRACT_CHANGE run completes only in
   * the one transaction that consumes its grant and moves the project's active manifest (#246 B2-b):
   * the grant is verified, every workflow the manifest points to is compared at the exact repository and
   * revision first — reads, outside the transaction — and then activation and COMPLETED commit together
   * or not at all. A refusal is MANIFEST_ACTIVATION_REFUSED; after a merge the caller's failure path
   * makes that BLOCKED_POST_MERGE, and the active manifest has not moved.
   */
  private async complete(
    runId: string,
    attemptId: string,
    consumer: GrantConsumer | null,
    reason: string,
    evidence: Record<string, unknown>,
  ): Promise<Decision<unknown>> {
    if (this.cp.runs.get(runId)?.kind !== RunKind.CONTRACT_CHANGE) {
      return this.cp.runs.transition(runId, RunState.COMPLETED, reason, evidence, this.#completionAuthority);
    }
    const refused = (cause: { reasonCode: ReasonCode; message: string; evidence: Record<string, unknown> }): Decision<unknown> =>
      deny(ReasonCode.MANIFEST_ACTIVATION_REFUSED, "the CONTRACT_CHANGE manifest was not activated, and the active manifest did not move", {
        runId,
        attemptId,
        refusal: { reasonCode: cause.reasonCode, message: cause.message, evidence: cause.evidence },
      });
    const target = this.cp.manifestGrants.verify(runId, "ACTIVATION", consumer);
    if (!target.allowed) return refused(target);
    const workflows: Decision<readonly ActivatedWorkflowEvidence[]> = target.value.kind === "FIRST"
      ? await this.compareFirstActivationWorkflows(runId, target.value)
      : await this.compareActivationWorkflows(runId, target.value);
    if (!workflows.allowed) return refused(workflows);
    const done = this.cp.db.txDecision(() => {
      const activated = this.cp.projects.activateManifest(runId, {
        completion: this.#completionAuthority,
        attemptId,
        workflows: workflows.value,
        consumer,
      });
      if (!activated.allowed) return activated as Decision<unknown>;
      const settled = this.cp.tasks.settleAdministrativeActivation(runId,this.#completionAuthority);
      if (!settled.allowed) return settled;
      return this.cp.runs.transition(
        runId,
        RunState.COMPLETED,
        reason,
        { ...evidence, manifestActivation: activated.value },
        this.#completionAuthority,
      ) as Decision<unknown>;
    });
    return done.allowed ? done : refused(done);
  }

  /**
   * CEO ruling 6 — before activation, every workflow the manifest points to is compared at the exact
   * repository its role names and the revision this finalization verified: the merge commit, for a
   * repository this run merged (its candidate head, when asked before the merge); otherwise the commit
   * the manifest's default branch names now. Every entry is read, one the base declares byte for byte
   * included: an equal declaration is not evidence of the bytes at this revision. One with no approved
   * digest, one that cannot be read, or one that does not hash to its approved digest refuses
   * activation: a contract that cannot be verified is never activated.
   */
  private async compareActivationWorkflows(
    runId: string,
    target: ChangeTarget,
    /** Before any merge: the candidate, whose head stands in for the merge commit of each repository it carries. */
    beforeMerge?: CandidateSnapshot,
  ): Promise<Decision<ActivatedWorkflowEvidence[]>> {
    const repositories = this.cp.repositories
      .byProject(target.grant.projectId)
      .filter((repository) => repository.registration === "REGISTERED");
    const compared: ActivatedWorkflowEvidence[] = [];
    for (const workflow of target.workflowEvidence) {
      const entry = {
        repositoryRole: workflow.repositoryRole,
        repositoryIdentity: workflow.repositoryRemote,
        path: workflow.path,
        checkName: workflow.checkName,
        approvedDigest: workflow.approvedDigest,
      };
      const unverified = (message: string, detail: Record<string, unknown> = {}): Decision<ActivatedWorkflowEvidence[]> =>
        deny(ReasonCode.MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED, message, { runId, workflow: entry, ...detail });
      const approvedDigest = workflow.approvedDigest;
      if (approvedDigest === null || workflow.unapprovedFirstActivation) {
        return unverified("the workflow names no approved digest to compare against");
      }
      const repository = repositories.find((candidate) => candidate.repositoryRole === workflow.repositoryRole);
      if (!repository || repository.identity !== workflow.repositoryRemote) {
        return unverified("no registered repository of the project is the exact repository the workflow names", {
          registeredIdentity: repository?.identity ?? null,
        });
      }
      const receipt = beforeMerge ? null : this.mergeReceipt(runId, repository.identity);
      const merged = beforeMerge
        ? beforeMerge.repositories.find((candidate) => candidate.identity === repository.identity)?.candidateHead ?? null
        : receipt?.status === "APPLIED" && receipt.verified === 1 ? this.mergeSha(receipt) : null;
      const read = await this.cp.github.workflowDigestAt(
        repository.identity,
        merged ? { sha: merged } : { branch: target.manifest.branchProfile.defaultBranch },
        workflow.path,
      );
      if (!read.allowed) {
        return unverified("the workflow could not be read at the exact revision", {
          revision: merged ?? null,
          branch: merged ? null : target.manifest.branchProfile.defaultBranch,
          cause: { reasonCode: read.reasonCode, message: read.message, evidence: read.evidence },
        });
      }
      if (read.value.workflowDigest !== approvedDigest) {
        return unverified("the workflow's bytes at the exact revision are not the ones the manifest approves", {
          revision: read.value.revision,
          observedDigest: read.value.workflowDigest,
        });
      }
      compared.push({
        ...entry,
        repositoryIdentity: repository.identity,
        approvedDigest,
        evidence: "READ",
        revision: read.value.revision,
        observedDigest: read.value.workflowDigest,
      });
    }
    return allow(ReasonCode.OK, compared);
  }

  /**
   * #512 — a first activation's workflows, read at PRE_MERGE and again at ACTIVATION by the exact-commit
   * reader: each bound revision of the grant, at exactly its bound commit object of exactly its bound
   * repository, which must be the project's REGISTERED repository for its role. A wrong object type, an
   * unreadable object, a path that is not a file, or bytes that do not hash to the bound digest refuse
   * activation, and the pointer does not move. Whether the default branch head reaches the commit is
   * recorded as evidence only; the head is never read in the commit's place.
   */
  private async compareFirstActivationWorkflows(
    runId: string,
    target: FirstTarget,
  ): Promise<Decision<FirstActivationWorkflowEvidence[]>> {
    const repositories = this.cp.repositories
      .byProject(target.grant.projectId)
      .filter((repository) => repository.registration === "REGISTERED");
    const client = this.cp.config.githubClient ?? new GitHubAppClient(this.cp.credentials);
    const compared: FirstActivationWorkflowEvidence[] = [];
    for (const revision of target.grant.workflowRevisions) {
      const entry = {
        repositoryRole: revision.repositoryRole,
        repositoryIdentity: revision.repositoryIdentity,
        path: revision.path,
        checkName: revision.checkName,
        commitSha: revision.commitSha,
        fileDigest: revision.fileDigest,
      };
      const unverified = (message: string, detail: Record<string, unknown> = {}): Decision<FirstActivationWorkflowEvidence[]> =>
        deny(ReasonCode.MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED, message, { runId, activation: "FIRST", workflow: entry, ...detail });
      const repository = repositories.find((candidate) => candidate.repositoryRole === revision.repositoryRole);
      if (!repository || repository.identity !== revision.repositoryIdentity) {
        return unverified("no registered repository of the project is the exact repository the revision binds", {
          registeredIdentity: repository?.identity ?? null,
        });
      }
      const read = await workflowDigestAtCommit(
        { repositories: this.cp.repositories, client },
        {
          repositoryIdentity: revision.repositoryIdentity,
          projectId: target.grant.projectId,
          commitSha: revision.commitSha,
          path: revision.path,
          defaultBranch: target.manifest.branchProfile.defaultBranch,
        },
      );
      if (!read.allowed) {
        return unverified("the workflow could not be read at the bound commit", {
          cause: { reasonCode: read.reasonCode, message: read.message, evidence: read.evidence },
        });
      }
      if (read.value.commitSha !== revision.commitSha || read.value.observedDigest !== revision.fileDigest) {
        return unverified("the workflow's bytes at the bound commit are not the ones the manifest approves", {
          revision: read.value.commitSha,
          blobSha: read.value.blobSha,
          observedDigest: read.value.observedDigest,
          readVia: read.value.readVia,
        });
      }
      compared.push({
        repositoryRole: revision.repositoryRole,
        repositoryIdentity: revision.repositoryIdentity,
        path: revision.path,
        checkName: revision.checkName,
        approvedDigest: revision.fileDigest,
        evidence: "READ",
        revision: read.value.commitSha,
        observedDigest: read.value.observedDigest,
        commitSha: read.value.commitSha,
        objectType: read.value.objectType,
        blobSha: read.value.blobSha,
        readVia: read.value.readVia,
        reachable: read.value.reachable,
        defaultBranchHead: read.value.defaultBranchHead,
      });
    }
    return allow(ReasonCode.OK, compared);
  }

  private acquireAttempt(runId: string, candidateDigest: string): Decision<string> {
    // #664 — the upsert below is the reservation itself; a denial means the reservation
    // did not happen and must not leave a row behind.
    return this.cp.db.txDecision(() => {
      const now = this.cp.clock.now();
      const startedAt = now.toISOString();
      const deadlineAt = new Date(now.getTime() + FINALIZATION_LEASE_TTL_MS).toISOString();
      const attemptId = `finalize_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const prior = this.attempt(runId);
      const inserted = this.cp.db.run(
        `INSERT INTO finalization_attempts
           (run_id, attempt_id, lease_owner, candidate_digest, state, started_at, deadline_at, last_step)
         VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, 'ACQUIRED')
         ON CONFLICT(run_id) DO UPDATE SET
           attempt_id = excluded.attempt_id,
           lease_owner = excluded.lease_owner,
           candidate_digest = excluded.candidate_digest,
           state = 'RUNNING',
           started_at = excluded.started_at,
           deadline_at = excluded.deadline_at,
           released_at = NULL,
           completed_at = NULL,
           last_step = 'ACQUIRED',
           failure_reason = NULL,
           compensation_plan_json = NULL
         WHERE finalization_attempts.state = 'RELEASED'
            OR (finalization_attempts.state = 'RUNNING' AND finalization_attempts.deadline_at <= ?)`,
        [runId, attemptId, this.leaseOwner, candidateDigest, startedAt, deadlineAt, startedAt],
      );
      if (inserted.changes !== 1) {
        return deny(ReasonCode.CONFLICT, "a daemon finalization attempt already owns this run", {
          runId,
          current: this.attempt(runId),
        });
      }
      if (prior?.state === "RUNNING" && prior.deadline_at <= startedAt) {
        this.cp.audit.record({
          kind: "FINALIZATION_ATTEMPT_RECLAIMED",
          runId,
          reasonCode: ReasonCode.FINALIZATION_ATTEMPT_STALE,
          evidence: {
            attemptId: prior.attempt_id,
            startedAt: prior.started_at,
            deadlineAt: prior.deadline_at,
            via: "acquire",
            leaseOwner: this.leaseOwner,
          },
        });
      }
      this.cp.audit.record({
        kind: "FINALIZATION_ATTEMPT_ACQUIRED",
        runId,
        evidence: { attemptId, candidateSnapshotDigest: candidateDigest, leaseOwner: this.leaseOwner, deadlineAt },
      });
      return allow(ReasonCode.OK, attemptId);
    });
  }

  private handleFailure(
    runId: string,
    attemptId: string,
    failure: Decision<unknown>,
  ): Decision<FinalizationResult> {
    // The state transition is the authority record. If an exception happened after it
    // committed (for example while recording the attempt completion), preserve completion
    // and reconcile the lease instead of manufacturing a contradictory BLOCKED attempt.
    if (this.cp.runs.get(runId)?.state === RunState.COMPLETED) {
      this.completeAnyRunningAttempt(runId, attemptId);
      this.cp.audit.record({
        kind: "FINALIZATION_COMPLETION_RECONCILED",
        runId,
        evidence: { attemptId, recoveredAfterFailures: true, failureReasonCode: failure.reasonCode },
      });
      return allow(ReasonCode.MERGE_IDEMPOTENT_REPLAY, this.completedResult(runId), {
        replayed: true,
        recoveredAfterFailures: true,
      });
    }
    const merges = this.durableMergeReceipts(runId);
    // #1189 B5 (CEO ruling 4) — a merge request whose outcome is unknown is held, not settled: the run stays
    // MERGING, so the next attempt reconciles its PENDING receipt before anything else, rather than
    // BLOCKED_POST_MERGE, whose recovery reads only proven receipts.
    const unknown = merges.length > 0 && this.mergeOutcomeUnknown(runId);
    if (merges.length > 0 && !unknown) {
      const compensation = merges.map((receipt) => {
        const sha = this.mergeSha(receipt);
        const prepared = sha
          ? this.cp.github.rollbackPrepare(runId, receipt.repository_identity, sha, "halt")
          : null;
        return {
          repositoryIdentity: receipt.repository_identity,
          receiptStatus: receipt.status,
          verified: receipt.verified === 1,
          mergeCommitSha: sha,
          plan: prepared?.allowed ? prepared.value.plan : null,
          requiredAction: sha ? "halt and review rollback plan" : "reconcile pending merge receipt before compensation",
        };
      });
      const run = this.cp.runs.get(runId);
      if (run?.state === RunState.MERGING || run?.state === RunState.POST_MERGE_VERIFYING) {
        const blocked = this.cp.runs.transition(
          runId,
          RunState.BLOCKED_POST_MERGE,
          "partial daemon finalization failure",
          {
            attemptId,
            failureReasonCode: failure.reasonCode,
            failure: failure.evidence,
            compensation,
          },
        );
        if (!blocked.allowed) return blocked as Decision<FinalizationResult>;
      }
      this.cp.db.run(
        `UPDATE finalization_attempts
            SET state = 'BLOCKED', last_step = 'BLOCKED_POST_MERGE', failure_reason = ?,
                compensation_plan_json = ?, completed_at = NULL
          WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING'`,
        [failure.reasonCode, JSON.stringify(compensation), runId, attemptId],
      );
      this.cp.audit.record({
        kind: "FINALIZATION_BLOCKED_POST_MERGE",
        runId,
        reasonCode: ReasonCode.FINALIZATION_COMPENSATION_REQUIRED,
        evidence: { attemptId, failureReasonCode: failure.reasonCode, compensation },
      });
      return deny(
        ReasonCode.FINALIZATION_COMPENSATION_REQUIRED,
        "a merge may have occurred; run is blocked with a compensation plan",
        { runId, attemptId, failureReasonCode: failure.reasonCode, compensation },
      );
    }
    return this.refusedBeforeMerge(runId, attemptId, failure, unknown);
  }

  /**
   * #1189 B5 — a refusal with no merge receipt: nothing merged. An approved run (CEO_APPROVED or MERGING)
   * goes where `classifyPreMergeRefusal` sends it: back to its CTO with the approval invalidated, to FAILED
   * when unrecoverable, or to a backoff whose cap hands it to the owner of its fix. With `unknownMerge` the
   * run holds only receipts of merge requests whose outcome is unknown: it is retried as that one failure and
   * never returned (`returnApprovedCandidate` would refuse it anyway). The returned decision is the refusal
   * itself, as before.
   */
  private refusedBeforeMerge(
    runId: string,
    attemptId: string,
    failure: Decision<unknown>,
    unknownMerge = false,
  ): Decision<FinalizationResult> {
    const run = this.cp.runs.get(runId);
    const attempt = this.attempt(runId);
    const candidateDigest = attempt?.attempt_id === attemptId && attempt.state === "RUNNING" ? attempt.candidate_digest : null;
    if (failure.allowed || !run || candidateDigest === null ||
        (run.state !== RunState.CEO_APPROVED && run.state !== RunState.MERGING)) {
      this.cp.audit.record({
        kind: "FINALIZATION_ATTEMPT_FAILED",
        runId,
        reasonCode: failure.reasonCode,
        evidence: { attemptId, ...failure.evidence },
      });
      return failure as Decision<FinalizationResult>;
    }
    let route = unknownMerge ? UNKNOWN_MERGE_ROUTE : classifyPreMergeRefusal(run.kind, failure);
    this.cp.audit.record({
      kind: "FINALIZATION_ATTEMPT_FAILED",
      runId,
      reasonCode: failure.reasonCode,
      evidence: {
        attemptId,
        ...failure.evidence,
        candidateSnapshotDigest: candidateDigest,
        disposition: route.disposition,
        ...(route.disposition === "RETRY" ? { failureClass: route.failureClass } : {}),
      },
    });
    if (route.disposition !== "RETRY") {
      const unrecoverable = route.disposition === "UNRECOVERABLE";
      const returned = this.cp.runs.returnApprovedCandidate(runId, {
        candidateSnapshotDigest: candidateDigest,
        attemptId,
        reasonCode: failure.reasonCode,
        reason: `${failure.reasonCode}: ${failure.message}`,
        unrecoverable,
      });
      if (returned.allowed) {
        // FAILED, or a revision with no current owner to take it: the CEO hears of it. A revision the CTO
        // took reaches the CEO again as its new candidate's review.
        if (returned.value.state !== RunState.ACTIVE) {
          this.cp.ceo.notify(NotificationKind.CRITICAL_SYSTEM_FAILURE, runId, {
            candidateSnapshotDigest: candidateDigest,
            failureReasonCode: failure.reasonCode,
            failureClass: route.disposition,
            owner: "CEO",
            action: unrecoverable
              ? "the run ended FAILED and its approval is void; start a new run if the change is still wanted"
              : "dispatch the run again so a current CTO revises it; its approval is void",
            blocker: blockerOf(failure),
            reason: failure.message,
            whyItMatters: "a CEO-approved run did not merge, and nothing moves it without this",
          });
        }
        return failure as Decision<FinalizationResult>;
      }
      // The approval stands, so the refusal is retried like any other, not every tick, and handed on at the cap.
      this.cp.audit.record({
        kind: "CEO_APPROVAL_INVALIDATION_REFUSED",
        runId,
        reasonCode: returned.reasonCode,
        evidence: { attemptId, candidateSnapshotDigest: candidateDigest, failureReasonCode: failure.reasonCode, detail: returned.message },
      });
      route = {
        disposition: "RETRY", failureClass: "UNCLASSIFIED", failureCause: failure.reasonCode,
        retries: FINALIZATION_RETRY_CAP, owner: "CEO",
        action: `the candidate could not be returned for revision (${returned.reasonCode}); decide how the run proceeds`,
      };
    }

    // #1189 B5 (CEO ruling 5) — every refusal of this candidate is counted, per failure and in total, so a
    // different failure in between resets nothing; the first attempt is not a retry. Each count is its own
    // record: the refusal's evidence is the caller's, and a row that evidence makes the audit log reject must
    // not lose one.
    const tally = this.refusalTally(runId, candidateDigest);
    const refusals = (tally.byCause.get(route.failureCause) ?? 0) + 1;
    const retries = tally.total;
    const limit: "FAILURE" | "CANDIDATE" | null = refusals - 1 >= route.retries
      ? "FAILURE"
      : retries >= FINALIZATION_RETRY_CAP ? "CANDIDATE" : null;
    const counted = {
      attemptId,
      candidateSnapshotDigest: candidateDigest,
      failureClass: route.failureClass,
      // Not named *Key: the audit log redacts any key ending in "key" as a secret.
      failureCause: route.failureCause,
      // Refusals of this candidate for this failure, and the automatic retries of this candidate so far (its
      // first attempt is not one). Not named consecutive*: the audit log redacts any key containing "nsec".
      refusals,
      failureRetryCap: route.retries,
      retries,
      retryCap: FINALIZATION_RETRY_CAP,
    };
    if (limit === null) {
      this.cp.audit.record({
        kind: "FINALIZATION_RETRY_SCHEDULED",
        runId,
        reasonCode: failure.reasonCode,
        evidence: { ...counted, retryNotBefore: new Date(this.cp.clock.now().getTime() + retryDelayMs(retries + 1)).toISOString() },
      });
      return failure as Decision<FinalizationResult>;
    }

    // A cap: nothing retries the run automatically any more, and the owner of the fix hears of it once (per
    // failure, and once for the candidate's total), which the hand-off record keeps across restarts. A notice
    // that could not be enqueued stays owed (`deliverOwedHandOff`).
    if (!this.handedOff(runId, candidateDigest, limit, route.failureCause)) {
      const handoff = {
        candidateSnapshotDigest: candidateDigest,
        failureReasonCode: failure.reasonCode,
        failureClass: route.failureClass,
        failureCause: route.failureCause,
        limit,
        owner: limit === "CANDIDATE" ? "CEO" : route.owner,
        action: `${limit === "CANDIDATE"
          ? `this candidate used its ${FINALIZATION_RETRY_CAP} automatic retries across different failures without merging; inspect its refusals and decide how the run proceeds`
          : route.action}. ${RETRIES_STOPPED}`,
        blocker: blockerOf(failure),
        retries,
        retryCap: FINALIZATION_RETRY_CAP,
        reason: failure.message,
      };
      const notified = this.cp.ceo.notify(NotificationKind.CRITICAL_SYSTEM_FAILURE, runId, { ...handoff, whyItMatters: HAND_OFF_WHY });
      this.cp.audit.record({
        kind: "FINALIZATION_HANDED_OFF",
        runId,
        reasonCode: failure.reasonCode,
        evidence: { ...counted, ...handoff, delivered: notified.allowed },
      });
    }
    this.cp.audit.record({
      kind: "FINALIZATION_RETRIES_EXHAUSTED",
      runId,
      reasonCode: failure.reasonCode,
      evidence: { ...counted, limit },
    });
    return failure as Decision<FinalizationResult>;
  }

  /**
   * #1189 B5 — this candidate's refusals so far, per failure and in total, from the durable count records
   * `refusedBeforeMerge` writes (a scheduled retry, or a cap reached).
   */
  private refusalTally(runId: string, candidateDigest: string): { byCause: Map<string, number>; total: number } {
    const byCause = new Map<string, number>();
    let total = 0;
    for (const row of this.cp.db.all<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events
        WHERE run_id = ? AND kind IN ('FINALIZATION_RETRY_SCHEDULED', 'FINALIZATION_RETRIES_EXHAUSTED')`,
      [runId],
    )) {
      const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
      const cause = evidence["failureCause"];
      if (evidence["candidateSnapshotDigest"] !== candidateDigest || typeof cause !== "string") continue;
      total += 1;
      byCause.set(cause, (byCause.get(cause) ?? 0) + 1);
    }
    return { byCause, total };
  }

  /**
   * The newest count record `refusedBeforeMerge` wrote for this run, or null: its candidate, and when it may be
   * retried — null once a cap stopped the retries.
   */
  private latestRetryRecord(runId: string): { candidateSnapshotDigest: string; retryNotBefore: string | null } | null {
    const row = this.cp.db.get<{ kind: string; evidence_json: string }>(
      `SELECT kind, evidence_json FROM audit_events
        WHERE run_id = ? AND kind IN ('FINALIZATION_RETRY_SCHEDULED', 'FINALIZATION_RETRIES_EXHAUSTED')
        ORDER BY event_id DESC LIMIT 1`,
      [runId],
    );
    if (!row) return null;
    const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
    const { candidateSnapshotDigest, retryNotBefore } = evidence;
    if (typeof candidateSnapshotDigest !== "string") return null;
    if (row.kind === "FINALIZATION_RETRIES_EXHAUSTED") return { candidateSnapshotDigest, retryNotBefore: null };
    return typeof retryNotBefore === "string" && !Number.isNaN(Date.parse(retryNotBefore))
      ? { candidateSnapshotDigest, retryNotBefore }
      : null;
  }

  /**
   * Whether this candidate was already handed on at this cap, with the notification enqueued: for its
   * failure, or for its total across failures.
   */
  private handedOff(runId: string, candidateDigest: string, limit: "FAILURE" | "CANDIDATE", failureCause: string): boolean {
    return this.cp.db.all<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE run_id = ? AND kind = 'FINALIZATION_HANDED_OFF'`,
      [runId],
    ).some((row) => {
      const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
      if (evidence["candidateSnapshotDigest"] !== candidateDigest || evidence["delivered"] !== true) return false;
      return limit === "CANDIDATE"
        ? evidence["limit"] === "CANDIDATE"
        : evidence["limit"] !== "CANDIDATE" && evidence["failureCause"] === failureCause;
    });
  }

  /**
   * #1189 B5 — whether every merge receipt the MERGING run holds is a PENDING reservation whose merge request
   * was sent and came back with an error status or nothing (the kernel's MERGE_OUTCOME_UNKNOWN, recorded no
   * earlier than the reservation), with nothing acknowledging a merge of that repository (MERGE_EXECUTED, or a
   * drift record naming a merge commit). Such an outcome is still open, and the next attempt's reconciliation of
   * its PENDING receipt, ahead of any replay, decides it: it re-reads the pull before any second merge request.
   */
  private mergeOutcomeUnknown(runId: string): boolean {
    if (this.cp.runs.get(runId)?.state !== RunState.MERGING) return false;
    const receipts = this.cp.db.all<{ repository_identity: string; status: string; verified: number; created_at: string }>(
      `SELECT repository_identity, status, verified, created_at FROM github_receipts
        WHERE run_id = ? AND operation = 'merge_execute' AND status IN ('PENDING','APPLIED')`,
      [runId],
    );
    if (receipts.length === 0 || receipts.some((receipt) => receipt.status !== "PENDING" || receipt.verified !== 0)) return false;
    const audit = this.cp.audit.forRun(runId);
    return receipts.every((receipt) => {
      const ofRepository = audit.filter((entry) => entry.evidence["repositoryIdentity"] === receipt.repository_identity);
      return ofRepository.some((entry) => entry.kind === "MERGE_OUTCOME_UNKNOWN" && entry.at >= receipt.created_at) &&
        !ofRepository.some((entry) => entry.kind === "MERGE_EXECUTED" ||
          (entry.kind === "MERGE_BASE_DRIFT" && typeof entry.evidence["mergeCommitSha"] === "string"));
    });
  }

  private touchAttempt(runId: string, attemptId: string, step: string): void {
    const changed = this.cp.db.run(
      `UPDATE finalization_attempts
          SET last_step = ?, deadline_at = ?
        WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING'`,
      [
        step,
        new Date(this.cp.clock.now().getTime() + FINALIZATION_LEASE_TTL_MS).toISOString(),
        runId,
        attemptId,
      ],
    );
    if (changed.changes !== 1) {
      throw new Error(`finalization attempt ${attemptId} no longer owns run ${runId}`);
    }
  }

  private completeAttempt(runId: string, attemptId: string): void {
    const changed = this.completeAnyRunningAttempt(runId, attemptId);
    if (changed !== 1) throw new Error(`could not complete finalization attempt ${attemptId}`);
  }

  /** Marks a still-owned attempt complete; used to heal the post-state-transition crash gap. */
  private completeAnyRunningAttempt(runId: string, attemptId?: string): number {
    const now = this.cp.clock.nowIso();
    return this.cp.db.run(
      `UPDATE finalization_attempts
          SET state = 'COMPLETED', last_step = 'COMPLETED', completed_at = ?, deadline_at = ?
        WHERE run_id = ? AND state = 'RUNNING'${attemptId ? " AND attempt_id = ?" : ""}`,
      attemptId ? [now, now, runId, attemptId] : [now, now, runId],
    ).changes;
  }

  private releaseAttemptIfRunning(runId: string, attemptId: string): void {
    this.cp.db.run(
      `UPDATE finalization_attempts
          SET state = 'RELEASED', released_at = ?, last_step = 'RELEASED'
        WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING'`,
      [this.cp.clock.nowIso(), runId, attemptId],
    );
  }

  private attempt(runId: string): FinalizationAttemptRow | null {
    return this.cp.db.get<FinalizationAttemptRow>(
      `SELECT * FROM finalization_attempts WHERE run_id = ?`,
      [runId],
    ) ?? null;
  }

  private durableMergeReceipts(runId: string): DurableMergeReceipt[] {
    return this.cp.db.all<DurableMergeReceipt>(
      `SELECT repository_identity, status, verified, response_json
         FROM github_receipts
        WHERE run_id = ? AND operation = 'merge_execute' AND status IN ('PENDING','APPLIED')
        ORDER BY created_at, receipt_id`,
      [runId],
    );
  }

  private mergeReceipt(runId: string, repositoryIdentity: string): DurableMergeReceipt | null {
    return this.cp.db.get<DurableMergeReceipt>(
      `SELECT repository_identity, status, verified, response_json
         FROM github_receipts
        WHERE run_id = ? AND repository_identity = ? AND operation = 'merge_execute'
        ORDER BY created_at DESC, receipt_id DESC LIMIT 1`,
      [runId, repositoryIdentity],
    ) ?? null;
  }

  /**
   * #1189 B5 — the newest merge receipt of this repository, with the pull it reserved, read from its exact key
   * (`merge_execute:<repository>:<pull>`); null when there is none or the key names no pull.
   */
  private mergeReceiptPull(
    runId: string,
    repositoryIdentity: string,
  ): { status: string; verified: number; pullNumber: number } | null {
    const row = this.cp.db.get<{ idempotency_key: string; status: string; verified: number }>(
      `SELECT idempotency_key, status, verified
         FROM github_receipts
        WHERE run_id = ? AND repository_identity = ? AND operation = 'merge_execute'
        ORDER BY created_at DESC, receipt_id DESC LIMIT 1`,
      [runId, repositoryIdentity],
    );
    const prefix = `merge_execute:${repositoryIdentity}:`;
    if (!row?.idempotency_key.startsWith(prefix)) return null;
    const pull = row.idempotency_key.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(pull)) return null;
    return { status: row.status, verified: row.verified, pullNumber: Number(pull) };
  }

  private mergeSha(receipt: DurableMergeReceipt): string | null {
    try {
      const parsed = JSON.parse(receipt.response_json) as { mergeCommitSha?: unknown };
      return typeof parsed.mergeCommitSha === "string" && parsed.mergeCommitSha.length > 0
        ? parsed.mergeCommitSha
        : null;
    } catch {
      return null;
    }
  }

  private completedResult(runId: string): FinalizationResult {
    const attempt = this.attempt(runId);
    return {
      runId,
      state: RunState.COMPLETED,
      attemptId: attempt?.attempt_id ?? null,
      repositories: this.durableMergeReceipts(runId)
        .map((receipt) => ({ repositoryIdentity: receipt.repository_identity, mergeCommitSha: this.mergeSha(receipt) }))
        .filter((entry): entry is { repositoryIdentity: string; mergeCommitSha: string } => entry.mergeCommitSha !== null),
    };
  }

  private isFinalizingState(state: RunState): boolean {
    return (
      state === RunState.CEO_APPROVED ||
      state === RunState.MERGING ||
      state === RunState.POST_MERGE_VERIFYING
    );
  }
}
