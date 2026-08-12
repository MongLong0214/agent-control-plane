import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { commandsForMode } from "../contracts/manifest.ts";
import type { VerificationCommand } from "../contracts/verification-command.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import { ArtifactKind, RunState } from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { ProductionGate, ProductionReadyPacket } from "../ceo/production-gate.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { BlindReviewGate, ReviewPacket } from "../review/blind-review.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import {
  type CandidateSnapshot,
  buildCandidateSnapshot,
  candidateSnapshotDigest,
} from "../snapshot/candidate-snapshot.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { VerificationEngine, VerificationReport } from "../verify/verification-engine.ts";
import type { RunEngine, TaskContract } from "./run-engine.ts";
import type { TaskGraph } from "./task-graph.ts";

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
  projectContext?: string;
}

export type PipelineOutcome =
  | { stage: "COMPLETED_REVIEW"; packet: ProductionReadyPacket; snapshotDigest: string }
  | { stage: "REVISION_REQUIRED"; reasonCode: string; snapshotDigest: string; review?: ReviewPacket }
  | { stage: "VERIFICATION_FAILED"; reasonCode: string; snapshotDigest: string; report: VerificationReport };

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
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    private readonly runs: RunEngine,
    private readonly tasks: TaskGraph,
    private readonly projects: ProjectRegistry,
    private readonly repositories: RepositoryRegistry,
    private readonly verification: VerificationEngine,
    private readonly review: BlindReviewGate,
    private readonly ceo: ProductionGate,
    private readonly bindings: BindingRegistry,
    private readonly outbox: Outbox,
    private readonly telemetry: Telemetry,
  ) {}

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

    const commands = this.resolveCommands(run.projectId, run.executionMode, input.runScopedCommands);
    const verified = await this.verification.verify({
      runId: input.runId,
      snapshot,
      commands,
      contractDigest: run.contractDigest,
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

    const contract = this.artifacts.latest<TaskContract>(input.runId, ArtifactKind.TASK_CONTRACT);
    if (!contract) {
      return deny(ReasonCode.EVIDENCE_MISSING, "run has no task contract artifact", {
        runId: input.runId,
      });
    }

    // §18.2 — automatic, immediately after verification passes.
    const reviewed = await this.review.review({
      runId: input.runId,
      projectId: run.projectId,
      executionMode: run.executionMode,
      snapshot,
      contract: contract.content,
      contractDigest: run.contractDigest,
      verification: verified.value,
      ...(input.projectContext !== undefined ? { projectContext: input.projectContext } : {}),
    });

    if (!reviewed.allowed) {
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

    const built = this.ceo.buildPacket({
      runId: input.runId,
      candidateSnapshotDigest: snapshotDigest,
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
    });
    if (!built.allowed) return built as Decision<PipelineOutcome>;

    return allow(ReasonCode.OK, {
      stage: "COMPLETED_REVIEW",
      packet: built.value,
      snapshotDigest,
    });
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
  private resolveCommands(
    projectId: string | null,
    mode: "SIMPLE" | "STANDARD" | "GUARDED",
    runScoped: readonly VerificationCommand[] | undefined,
  ): VerificationCommand[] {
    if (projectId) {
      const active = this.projects.activeManifest(projectId);
      if (active) return commandsForMode(active.manifest, mode);
    }
    return [...(runScoped ?? [])];
  }
}
