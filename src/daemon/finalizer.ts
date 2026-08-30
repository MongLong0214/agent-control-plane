import { randomUUID } from "node:crypto";

import type { ControlPlane } from "../app/control-plane.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { ArtifactKind, RunState } from "../domain/types.ts";
import { currentBranch } from "../git/git.ts";
import type { DaemonFinalizerAuthority } from "../guard/managed-write-guard.ts";
import {
  deriveConfirmedMergePlan,
  executePreparedConfirmedMerge,
  prepareConfirmedMerge,
  publishConfirmedMergeGate,
  type ConfirmedMergePlan,
  type ConfirmedMergePorts,
} from "../github/confirmed-merge-operation.ts";
import type { CandidateSnapshot } from "../snapshot/candidate-snapshot.ts";
import { verifySnapshotFreshness } from "../snapshot/candidate-snapshot.ts";
import type { CompletionAuthority } from "../run/run-engine.ts";

const FINALIZATION_LEASE_TTL_MS = 30 * 60_000;

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
  pullUrl: string;
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
      return allow(
        ReasonCode.MERGE_IDEMPOTENT_REPLAY,
        this.completedResult(runId),
        { replayed: true },
      );
    }
    if (initial.state === RunState.BLOCKED_POST_MERGE) {
      return deny(
        ReasonCode.FINALIZATION_COMPENSATION_REQUIRED,
        "run has a partial merge failure and requires its durable compensation plan",
        { runId, attempt: this.attempt(runId) },
      );
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

    const acquired = this.acquireAttempt(runId, candidateDigest);
    if (!acquired.allowed) return acquired as Decision<FinalizationResult>;
    const attemptId = acquired.value;
    let completed = false;
    try {
      const plans = await this.reconfirmAndPlan(runId, candidateDigest);
      if (!plans.allowed) return this.handleFailure(runId, attemptId, plans as Decision<unknown>);

      const prepared: PlannedRepository[] = [];
      for (const plan of plans.value) {
        this.touchAttempt(runId, attemptId, `PREPARE_PR:${plan.repositoryIdentity}`);
        const pr = await prepareConfirmedMerge(this.#ports, plan);
        if (!pr.allowed) return this.handleFailure(runId, attemptId, pr as Decision<unknown>);
        prepared.push({ plan, pullNumber: pr.value.pullNumber, pullUrl: pr.value.url });
      }

      // Gate publication is deliberately a separate all-repository phase. No irreversible
      // merge starts until every target has a durable PR intent and trusted gate receipt.
      for (const repository of prepared) {
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
        const done = this.cp.runs.transition(
          runId,
          RunState.COMPLETED,
          "daemon finalized run with nothing to merge",
          noMergeEvidence,
          this.#completionAuthority,
        );
        if (!done.allowed) return this.handleFailure(runId, attemptId, done as Decision<unknown>);
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
          const done = this.cp.runs.transition(
            runId,
            RunState.COMPLETED,
            "all ordered merges passed exact post-merge verification",
            { attemptId, merged },
            this.#completionAuthority,
          );
          if (!done.allowed) return this.handleFailure(runId, attemptId, done as Decision<unknown>);
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
        }),
      );
    } finally {
      if (!completed) this.releaseAttemptIfRunning(runId, attemptId);
    }
  }

  private async reconfirmAndPlan(
    runId: string,
    candidateDigest: string,
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
    if (merges.length > 0) {
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
    this.cp.audit.record({
      kind: "FINALIZATION_ATTEMPT_FAILED",
      runId,
      reasonCode: failure.reasonCode,
      evidence: { attemptId, ...failure.evidence },
    });
    return failure as Decision<FinalizationResult>;
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
