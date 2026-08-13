import { randomUUID } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { commandsForMode } from "../contracts/manifest.ts";
import type { VerificationCommand } from "../contracts/verification-command.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, RunState } from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { ProductionGate, ProductionReadyPacket } from "../ceo/production-gate.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { BlindReviewGate, BlindReviewInvoker, ReviewPacket } from "../review/blind-review.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import {
  type CandidateSnapshot,
  buildCandidateSnapshot,
  candidateSnapshotDigest,
  verifySnapshotFreshness,
} from "../snapshot/candidate-snapshot.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { VerificationEngine, VerificationReport } from "../verify/verification-engine.ts";
import type { RunEngine, TaskContract } from "./run-engine.ts";
import type { TaskGraph } from "./task-graph.ts";
import type { ManagedWriteGuard } from "../guard/managed-write-guard.ts";

const ATTEMPT_LEASE_TTL_MS = 30 * 60 * 1000;

export interface SubmitResultInput {
  runId: string;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  resultSummary: string;
  recommendation: string;
  residualRisk?: string[];
  /**
   * Run-scoped verification commands. Used only when the repository has no active
   * project manifest (§17.5); otherwise the pinned contract's commands win.
   */
  runScopedCommands?: readonly VerificationCommand[];
}

export type PipelineOutcome =
  | { stage: "COMPLETED_REVIEW"; packet: ProductionReadyPacket; snapshotDigest: string }
  | { stage: "REVISION_REQUIRED"; reasonCode: string; snapshotDigest: string; review?: ReviewPacket }
  | { stage: "VERIFICATION_FAILED"; reasonCode: string; snapshotDigest: string; report: VerificationReport }
  /**
   * §18.7 — assurance could not be constituted. Editing the candidate cannot fix a lost
   * reviewer isolation or a dead provider, so this is *not* a revision request: the run
   * waits, and continuity decides.
   */
  | { stage: "REVIEW_UNAVAILABLE"; reasonCode: string; snapshotDigest: string }
  /** The source moved while the candidate was being judged; all its evidence is stale. */
  | { stage: "CANDIDATE_STALE"; reasonCode: string; snapshotDigest: string };

/**
 * A durable submission lease that a watchdog reclaimed after its holder disappeared.
 * `deadlineAt` is the deadline persisted when the lease was acquired. Recovery must honor
 * that fact rather than reconstructing a potentially changed policy from `startedAt` (#335).
 */
export interface ReclaimedCandidatePipelineAttempt {
  runId: string;
  attemptId: string;
  startedAt: string;
  deadlineAt: string;
  ageMs: number;
}

/**
 * The candidate completion path (PRD §§16–19).
 *
 * Freeze → verify → *automatically* blind review → production-ready packet. The
 * automatic step is the point: §18.2 gives the control plane the invocation, and no
 * agent-facing operation can skip, reorder or repeat it against stale evidence. A
 * REVISE verdict returns to the CTO here and never reaches Hermes (§18.6, CP-S33).
 */
export class CandidatePipeline {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    private readonly runs: RunEngine,
    private readonly tasks: TaskGraph,
    private readonly projects: ProjectRegistry,
    private readonly repositories: RepositoryRegistry,
    private readonly verification: VerificationEngine,
    private readonly review: BlindReviewGate,
    private readonly invokeReview: BlindReviewInvoker,
    private readonly ceo: ProductionGate,
    private readonly bindings: BindingRegistry,
    private readonly outbox: Outbox,
    private readonly telemetry: Telemetry,
    private readonly guard: ManagedWriteGuard,
  ) {}

  #continuity: { evaluate?(reason: string): Promise<unknown> } | null = null;

  attach(ports: { continuity?: { evaluate?(reason: string): Promise<unknown> } }): void {
    if (ports.continuity) this.#continuity = ports.continuity;
  }

  /** Freeze the candidate across every repository participating in the run (§16.2). */
  async freeze(runId: string): Promise<Decision<CandidateSnapshot>> {
    const run = this.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });

    const participants = this.runs.repositoriesOf(runId);
    if (participants.length === 0) {
      return deny(ReasonCode.EVIDENCE_MISSING, "run has no participating repository", { runId });
    }

    const snapshot = await buildCandidateSnapshot(
      {
        runId,
        contractDigest: run.contractDigest,
        repositories: participants.map((repo) => ({
          identity: repo.identity,
          repositoryRole: repo.repositoryRole,
          checkoutPath: repo.checkoutPath,
          baseBranch: repo.baseBranch,
          baseRef: repo.baseBranch,
          worktreeId: repo.worktreeId,
          manifestDigest: this.repositories.byIdentity(repo.identity)?.activeManifestDigest ?? null,
        })),
      },
      this.clock,
    );

    this.artifacts.put(runId, ArtifactKind.CANDIDATE_SNAPSHOT, snapshot, candidateSnapshotDigest(snapshot));
    // One transaction records the new candidate and stales everything bound to an older
    // one, so no window exists in which superseded evidence still reads as current.
    this.runs.promoteCandidate(runId, candidateSnapshotDigest(snapshot));
    this.audit.record({
      kind: "CANDIDATE_FROZEN",
      runId,
      evidence: {
        candidateSnapshotDigest: candidateSnapshotDigest(snapshot),
        repositories: snapshot.repositories.map((r) => ({
          identity: r.identity,
          candidateHead: r.candidateHead,
          files: r.touchedPaths.length,
        })),
      },
    });
    return allow(ReasonCode.OK, snapshot);
  }

  async submitResult(input: SubmitResultInput): Promise<Decision<PipelineOutcome>> {
    // A caller that cannot prove the run owner must not be able to reserve the run's
    // durable submission fence, even briefly. This check is repeated after acquisition
    // to cover a state/ownership change between the two database operations.
    const owner = this.runs.assertOwner(
      input.runId,
      input.ownerSessionId,
      input.ownerBindingGeneration,
    );
    if (!owner.allowed) return owner as Decision<PipelineOutcome>;
    if (owner.value.state !== RunState.ACTIVE) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${owner.value.state}`, { runId: input.runId });
    }

    const attemptId = `attempt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const acquired = this.acquireAttempt(input, attemptId);
    if (!acquired.allowed) return acquired as Decision<PipelineOutcome>;
    try {
      return await this.submitResultOnce(input, attemptId);
    } finally {
      this.releaseAttempt(input.runId, attemptId);
    }
  }

  private async submitResultOnce(input: SubmitResultInput, attemptId: string): Promise<Decision<PipelineOutcome>> {
    const owner = this.runs.assertOwner(
      input.runId,
      input.ownerSessionId,
      input.ownerBindingGeneration,
    );
    if (!owner.allowed) return owner as Decision<PipelineOutcome>;
    const run = owner.value;

    if (run.state !== RunState.ACTIVE) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${run.state}`, { runId: input.runId });
    }

    const completeness = this.tasks.completeness(input.runId);
    if (!completeness.allowed) return completeness as Decision<PipelineOutcome>;

    const frozen = await this.freeze(input.runId);
    if (!frozen.allowed) return frozen as Decision<PipelineOutcome>;
    const snapshot = frozen.value;
    const snapshotDigest = candidateSnapshotDigest(snapshot);
    const boundAttempt = this.bindAttemptCandidate(input.runId, attemptId, snapshotDigest);
    if (!boundAttempt.allowed) return boundAttempt as Decision<PipelineOutcome>;

    const commands = this.resolveCommands(
      run.pinnedManifestDigest,
      run.executionMode,
      input.runScopedCommands,
    );
    const verified = await this.verification.verify({
      runId: input.runId,
      snapshot,
      commands,
      contractDigest: run.contractDigest,
      pinnedManifestDigest: run.pinnedManifestDigest,
      executionMode: run.executionMode,
      runScoped: Boolean(input.runScopedCommands),
    });

    if (!verified.allowed) {
      const report =
        this.verification.latestReport(input.runId, snapshotDigest) ??
        ({
          runId: input.runId,
          candidateSnapshotDigest: snapshotDigest,
          contractDigest: run.contractDigest,
          expectedInputs: commands.length,
          observedInputs: 0,
          results: [],
          status: "INCOMPLETE",
          reasonCode: verified.reasonCode,
          gaps: [],
        } satisfies VerificationReport);

      // §34.2 — a failed verification returns to CTO revision with the evidence still
      // bound to the candidate that failed.
      this.returnToCto(input.runId, verified.reasonCode, {
        stage: "verification",
        candidateSnapshotDigest: snapshotDigest,
        report,
      });
      return allow(ReasonCode.OK, {
        stage: "VERIFICATION_FAILED",
        reasonCode: verified.reasonCode,
        snapshotDigest,
        report,
      });
    }

    // CP-HI-06 / §16.2 — verification ran against a detached head, but the source may have
    // moved while it ran. Re-check before spending a review on it.
    const stillFreshAfterVerify = await this.assertStillFresh(snapshot);
    if (!stillFreshAfterVerify.allowed) {
      return allow(ReasonCode.OK, {
        stage: "CANDIDATE_STALE",
        reasonCode: stillFreshAfterVerify.reasonCode,
        snapshotDigest,
      });
    }

    const contract = this.artifacts
      .list<TaskContract>(input.runId, ArtifactKind.TASK_CONTRACT)
      .find((artifact) => !artifact.superseded && artifact.digest === run.contractDigest);
    if (!contract || digestOf(contract.content) !== run.contractDigest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "run's pinned task contract is not retrievable by digest", {
        runId: input.runId,
        expected: run.contractDigest,
        found: contract?.digest ?? null,
      });
    }

    // §18.2 — automatic, immediately after verification passes.
    const reviewed = await this.invokeReview({
      runId: input.runId,
      projectId: run.projectId,
      executionMode: run.executionMode,
      snapshot,
      contract: contract.content,
      contractDigest: run.contractDigest,
      verification: verified.value,
    });

    if (!reviewed.allowed) {
      // §18.7 is an assurance decision too. Re-evaluate continuity before deciding
      // whether a provider/isolation failure waits or moves the system into SURVIVAL.
      if (this.#continuity?.evaluate) await this.#continuity.evaluate("blind-review-unavailable");
      // §18.7 — only a reviewer *verdict* enters the CTO revision loop. A lost isolation
      // or a provider that never answered is an assurance failure the candidate cannot
      // repair, so the gate is neither lowered nor handed to the CTO to "fix".
      const isVerdict =
        reviewed.reasonCode === ReasonCode.REVIEW_REVISE ||
        reviewed.reasonCode === ReasonCode.REVIEW_BLOCK ||
        reviewed.reasonCode === ReasonCode.REVIEW_OMITTED_ITEMS_PRESENT;

      if (!isVerdict) {
        this.audit.record({
          kind: "BLIND_REVIEW_UNAVAILABLE",
          runId: input.runId,
          reasonCode: reviewed.reasonCode,
          evidence: { candidateSnapshotDigest: snapshotDigest, ...reviewed.evidence },
        });
        return allow(ReasonCode.OK, {
          stage: "REVIEW_UNAVAILABLE",
          reasonCode: reviewed.reasonCode,
          snapshotDigest,
        });
      }

      this.returnToCto(input.runId, reviewed.reasonCode, {
        stage: "blind-review",
        candidateSnapshotDigest: snapshotDigest,
        ...reviewed.evidence,
      });
      const packet = this.review.latestPacket(input.runId, snapshotDigest);
      return allow(ReasonCode.OK, {
        stage: "REVISION_REQUIRED",
        reasonCode: reviewed.reasonCode,
        snapshotDigest,
        ...(packet ? { review: packet } : {}),
      });
    }

    // Coverage is re-evaluated here, in async context, so the gate's completion check
    // decides on a current mode rather than one that predates a provider outage (§15.6).
    if (this.#continuity?.evaluate) await this.#continuity.evaluate("pre-completion");

    const sourceReadLease = this.guard.acquireSourceReadLease(
      input.runId,
      snapshot.repositories.map((repository) => repository.identity),
    );
    if (!sourceReadLease.allowed) return sourceReadLease as Decision<PipelineOutcome>;
    try {
      // And again before the packet: the review is also asynchronous. Managed source
      // writes cannot slip between this observation and production-ready publication.
      const stillFreshAfterReview = await this.assertStillFresh(snapshot);
      if (!stillFreshAfterReview.allowed) {
        return allow(ReasonCode.OK, {
          stage: "CANDIDATE_STALE",
          reasonCode: stillFreshAfterReview.reasonCode,
          snapshotDigest,
        });
      }

      const built = this.ceo.buildPacket({
        runId: input.runId,
        candidateSnapshotDigest: snapshotDigest,
        sourceReadLeaseId: sourceReadLease.value.leaseId,
        approval: {
          runId: input.runId,
          candidateSnapshotDigest: snapshotDigest,
          resultSummary: input.resultSummary,
          recommendation: input.recommendation,
          residualRisk: input.residualRisk ?? [],
          approvedBySessionId: input.ownerSessionId,
          approvedByGeneration: input.ownerBindingGeneration,
          approvedAt: this.clock.nowIso(),
        },
      } as Parameters<ProductionGate["buildPacket"]>[0] & { sourceReadLeaseId: string });
      if (!built.allowed) return built as Decision<PipelineOutcome>;

      return allow(ReasonCode.OK, {
        stage: "COMPLETED_REVIEW",
        packet: built.value,
        snapshotDigest,
      });
    } finally {
      sourceReadLease.value.release();
    }
  }

  /** Durable, per-run fence for the whole asynchronous verification/review attempt. */
  private acquireAttempt(input: SubmitResultInput, attemptId: string): Decision<void> {
    return this.db.tx(() => {
      const acquiredAt = this.clock.now();
      const startedAt = acquiredAt.toISOString();
      const deadlineAt = new Date(acquiredAt.getTime() + ATTEMPT_LEASE_TTL_MS).toISOString();
      const inserted = this.db.run(
        `INSERT INTO candidate_pipeline_attempts
           (run_id, attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, started_at, deadline_at, released_at)
         VALUES (?, ?, ?, ?, NULL, 'RUNNING', ?, ?, NULL)
         ON CONFLICT(run_id) DO UPDATE SET
           attempt_id = excluded.attempt_id,
           owner_session_id = excluded.owner_session_id,
           owner_binding_generation = excluded.owner_binding_generation,
           candidate_digest = NULL,
           state = 'RUNNING',
           started_at = excluded.started_at,
           deadline_at = excluded.deadline_at,
           released_at = NULL
         WHERE candidate_pipeline_attempts.state = 'RELEASED'
            OR (candidate_pipeline_attempts.state = 'RUNNING'
                AND candidate_pipeline_attempts.deadline_at <= ?)`,
        [input.runId, attemptId, input.ownerSessionId, input.ownerBindingGeneration, startedAt, deadlineAt, startedAt],
      );
      if (inserted.changes === 1) return allow(ReasonCode.OK, undefined);
      const current = this.db.get<{
        attempt_id: string;
        owner_session_id: string;
        owner_binding_generation: number;
        candidate_digest: string | null;
        state: string;
        deadline_at: string;
      }>(
        `SELECT attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, deadline_at
           FROM candidate_pipeline_attempts WHERE run_id = ?`,
        [input.runId],
      );
      return deny(ReasonCode.CONFLICT, "a durable candidate submission attempt already owns this run", {
        runId: input.runId,
        current,
      });
    });
  }

  /**
   * Releases leases whose owner can no longer be assumed live. This is deliberately a
   * synchronous, conditional transaction: a watchdog may observe a stale row just as a
   * new submission replaces it, and must never release that new holder's fence.
   *
   * The watchdog owns the diagnostic/audit consequence; this method owns the candidate
   * pipeline's state transition and returns the exact rows it changed.
   */
  reclaimExpiredAttempts(): ReclaimedCandidatePipelineAttempt[] {
    return this.db.tx(() => {
      const now = this.clock.now();
      const releasedAt = now.toISOString();
      const stale = this.db.all<{
        run_id: string;
        attempt_id: string;
        started_at: string;
        deadline_at: string;
      }>(
        `SELECT run_id, attempt_id, started_at, deadline_at
           FROM candidate_pipeline_attempts
          WHERE state = 'RUNNING' AND deadline_at <= ?
          ORDER BY deadline_at, run_id`,
        [releasedAt],
      );
      const reclaimed: ReclaimedCandidatePipelineAttempt[] = [];
      for (const attempt of stale) {
        const released = this.db.run(
          `UPDATE candidate_pipeline_attempts
              SET state = 'RELEASED', released_at = ?
            WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING' AND deadline_at <= ?`,
          [releasedAt, attempt.run_id, attempt.attempt_id, releasedAt],
        );
        if (released.changes !== 1) continue;
        const startedAt = new Date(attempt.started_at).getTime();
        reclaimed.push({
          runId: attempt.run_id,
          attemptId: attempt.attempt_id,
          startedAt: attempt.started_at,
          deadlineAt: attempt.deadline_at,
          ageMs: now.getTime() - startedAt,
        });
      }
      return reclaimed;
    });
  }

  private bindAttemptCandidate(runId: string, attemptId: string, candidateDigest: string): Decision<void> {
    const updated = this.db.run(
      `UPDATE candidate_pipeline_attempts
          SET candidate_digest = ?
        WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING'`,
      [candidateDigest, runId, attemptId],
    );
    return updated.changes === 1
      ? allow(ReasonCode.OK, undefined)
      : deny(ReasonCode.CONFLICT, "candidate submission attempt lease was replaced before snapshot binding", {
          runId,
          attemptId,
          candidateDigest,
        });
  }

  private releaseAttempt(runId: string, attemptId: string): void {
    this.db.run(
      `UPDATE candidate_pipeline_attempts
          SET state = 'RELEASED', released_at = ?
        WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING'`,
      [this.clock.nowIso(), runId, attemptId],
    );
  }

  /**
   * §18.6 — the revision loop is internal. The run returns to the CTO with the reason
   * and the evidence; Hermes is not notified.
   */
  private returnToCto(runId: string, reasonCode: string, evidence: Record<string, unknown>): void {
    const run = this.runs.require(runId);
    const roleKey = this.runs.ownerRoleKeyFor(run);
    const binding = roleKey ? this.bindings.active(roleKey) : null;

    if (binding) {
      this.outbox.enqueue({
        idempotencyKey: `revision:${runId}:${String(evidence["candidateSnapshotDigest"])}:${reasonCode}`,
        roleKey: binding.roleKey,
        bindingGeneration: binding.bindingGeneration,
        targetSessionId: binding.sessionId,
        runId,
        kind: MessageKind.REVISION_REQUEST,
        payload: { runId, reasonCode, ...evidence },
      });
    }

    this.audit.record({
      kind: "REVISION_RETURNED_TO_CTO",
      runId,
      roleKey: binding?.roleKey ?? null,
      reasonCode: reasonCode as never,
      evidence,
    });

    // §31.3 — revision count is run-scope telemetry. The FSM keeps a blind-review
    // revision inside ACTIVE (§29.2 has no ACTIVE→REVISION_REQUIRED edge), so the count
    // has to be recorded here rather than inferred from a state change.
    this.telemetry.record({
      scope: "run",
      name: "revision",
      runId,
      value: 1,
      text: reasonCode,
      dims: { stage: evidence["stage"] ?? null, mode: run.executionMode },
    });
  }

  /**
   * §17.1/§17.5 — commands come from the pinned project contract. A repository with no
   * active manifest may use run-scoped commands the CTO proposed, validated against the
   * same argv/sandbox contract and never persisted as a default.
   */
  /**
   * CP-HI-03 — commands come from the manifest this run pinned at dispatch admission, not
   * from whatever is active now. A concurrent CONTRACT_CHANGE must not change the bar a
   * run in flight is judged against.
   */
  private resolveCommands(
    pinnedManifestDigest: string | null,
    mode: "SIMPLE" | "STANDARD" | "GUARDED",
    runScoped: readonly VerificationCommand[] | undefined,
  ): VerificationCommand[] {
    if (pinnedManifestDigest) {
      const pinned = this.projects.manifest(pinnedManifestDigest);
      if (pinned) return commandsForMode(pinned, mode);
    }
    return [...(runScoped ?? [])];
  }

  /** Re-reads every frozen repository and reports drift (§16.2). */
  private async assertStillFresh(snapshot: CandidateSnapshot): Promise<Decision<CandidateSnapshot>> {
    const probes = snapshot.repositories
      .map((repo) => ({
        identity: repo.identity,
        checkoutPath: this.repositories.byIdentity(repo.identity)?.checkoutPath ?? "",
        activeManifestDigest: this.repositories.byIdentity(repo.identity)?.activeManifestDigest ?? null,
      }))
      .filter((p) => p.checkoutPath);
    return verifySnapshotFreshness(snapshot, probes);
  }
}
