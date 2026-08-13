import { execFileSync } from "node:child_process";

import { deriveHumanGate } from "./human-gate.ts";
import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { acpError, type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "./owner-authority.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore, EvidenceWriter } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import {
  ArtifactKind,
  type CeoDecision,
  RunState,
  Role,
  RunKind,
  roleKeyFor,
} from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { ReviewPacket } from "../review/blind-review.ts";
import type { RunEngine, CompletionAuthoritySet } from "../run/run-engine.ts";
import type { TaskGraph } from "../run/task-graph.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { VerificationReport } from "../verify/verification-engine.ts";
import type { ContinuityGate } from "../run/run-engine.ts";
import {
  candidateSnapshotDigest,
  candidateSnapshotSchema,
  type CandidateSnapshot,
} from "../snapshot/candidate-snapshot.ts";

/** PRD §19.1 — what Hermes receives by default. */
export interface ProductionReadyPacket {
  runId: string;
  projectId: string | null;
  goal: string;
  resultSummary: string;
  candidateSnapshotDigest: string;
  verification: {
    status: VerificationReport["status"];
    expectedInputs: number;
    observedInputs: number;
    commands: Array<{ commandId: string; source: string; status: string; exactHead: string }>;
    digest: string;
  };
  blindReview: {
    verdict: ReviewPacket["verdict"];
    digest: string;
    provider: string;
    model: string;
    coveredFiles: number;
    omittedItems: number;
    findings: number;
  };
  knownResidualRisk: string[];
  changedRepositories: Array<{ identity: string; baseHead: string; candidateHead: string; files: number }>;
  ctoRecommendation: string;
  humanGate: { required: boolean; items: string[]; satisfied: boolean };
  createdAt: string;
}

export interface CtoFinalApproval {
  runId: string;
  candidateSnapshotDigest: string;
  resultSummary: string;
  recommendation: string;
  residualRisk: string[];
  approvedBySessionId: string;
  approvedByGeneration: number;
  approvedAt: string;
}

export interface Escalation {
  runId: string;
  question: string;
  options: string[];
  ctoRecommendation: string;
  whyItMatters: string;
  blocksCriticalPath: boolean;
  openedBySessionId: string;
  openedAt: string;
}

export interface BootstrapActivationFinalizer {
  finalizeBootstrapActivationConfirm(input: {
    runId: string;
    candidateSnapshotDigest: string;
    ceoSessionId: string;
    confirmedAt: string;
  }): Decision<unknown>;
}

export interface SourceReadLeasePort {
  acquireSourceReadLease(
    runId: string,
    repositoryIdentities: readonly string[],
  ): Decision<{ leaseId: string; release(): void }>;
  /**
   * The lease must cover the repositories this packet is about to publish, not merely exist
   * for the run — a lease over one repository authorised a packet spanning two before #341.
   */
  assertSourceReadLease(
    runId: string,
    leaseId: string,
    repositoryIdentities: readonly string[],
  ): Decision<void>;
}

/** PRD §19.3 — the only three automatic Hermes notifications. */
export const NotificationKind = {
  READY_FOR_CEO_REVIEW: "READY_FOR_CEO_REVIEW",
  TRUE_ESCALATION: "TRUE_ESCALATION",
  CRITICAL_SYSTEM_FAILURE: "CRITICAL_SYSTEM_FAILURE",
} as const;
export type NotificationKind = (typeof NotificationKind)[keyof typeof NotificationKind];

/**
 * The operation an owner-decision receipt must name. The ingress router mints receipts per
 * operation, so a receipt admitted for anything else cannot clear a human gate.
 */
export const OWNER_DECISION_OPERATION = "owner_decision_submit";

/** PRD §21 — the owner-only gate list. */
export { HUMAN_GATE_TRIGGERS } from "./human-gate.ts";

export class ProductionGate {
  #continuity: ContinuityGate | null = null;
  #ownerAuthority: OwnerAuthorityPort | null = null;
  #bootstrapActivation: BootstrapActivationFinalizer | null = null;
  #sourceReadLeases: SourceReadLeasePort | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    /** #70 — the capability that lets this gate write its packet; a name would be forgeable. */
    private readonly packetWriter: EvidenceWriter<"PRODUCTION_READY_PACKET">,
    /** #371 — completing a run needs a capability, not the string "production-gate". */
    private readonly completion: CompletionAuthoritySet,
    private readonly runs: RunEngine,
    private readonly tasks: TaskGraph,
    private readonly bindings: BindingRegistry,
    private readonly outbox: Outbox,
    private readonly telemetry: Telemetry,
  ) {}

  attach(ports: {
    continuity?: ContinuityGate;
    ownerAuthority?: OwnerAuthorityPort;
    bootstrapActivation?: BootstrapActivationFinalizer;
    sourceReadLeases?: SourceReadLeasePort;
  }): void {
    if (ports.continuity) this.#continuity = ports.continuity;
    if (ports.ownerAuthority) this.#ownerAuthority = ports.ownerAuthority;
    if (ports.bootstrapActivation) this.#bootstrapActivation = ports.bootstrapActivation;
    if (ports.sourceReadLeases) this.#sourceReadLeases = ports.sourceReadLeases;
  }

  /**
   * PRD §5.10 — a production-ready candidate needs a pinned contract, configured
   * verification, mandatory blind review, zero unresolved blockers and CTO final
   * approval. Every one of those is checked against the *same* candidate digest.
   */
  buildPacket(input: {
    runId: string;
    candidateSnapshotDigest: string;
    approval: CtoFinalApproval;
    /** A caller-held lease, or omitted only when this gate acquires and releases one itself. */
    sourceReadLeaseId?: string;
  }): Decision<ProductionReadyPacket> {
    const run = this.runs.get(input.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: input.runId });

    const continuity = this.assertCompletionAllowed(input.runId);
    if (!continuity.allowed) return continuity as Decision<ProductionReadyPacket>;

    if (input.approval.candidateSnapshotDigest !== input.candidateSnapshotDigest) {
      return deny(ReasonCode.EVIDENCE_STALE, "CTO approval is bound to a different candidate", {
        approved: input.approval.candidateSnapshotDigest,
        current: input.candidateSnapshotDigest,
      });
    }

    const ownerCheck = this.runs.assertOwner(
      input.runId,
      input.approval.approvedBySessionId,
      input.approval.approvedByGeneration,
    );
    if (!ownerCheck.allowed) return ownerCheck as Decision<ProductionReadyPacket>;

    const completeness = this.tasks.completeness(input.runId);
    if (!completeness.allowed) return completeness as Decision<ProductionReadyPacket>;

    // The candidate must be the one the run is actually on. Anything else is evidence for
    // a superseded candidate, whatever its own digest says (CP-HI-06).
    const current = this.runs.currentCandidate(input.runId);
    if (current !== input.candidateSnapshotDigest) {
      return deny(ReasonCode.EVIDENCE_STALE, "candidate is not the run's current candidate", {
        runId: input.runId,
        supplied: input.candidateSnapshotDigest,
        current,
      });
    }

    const snapshot = this.requireCandidateSnapshot(input.runId, input.candidateSnapshotDigest);
    if (!snapshot.allowed) return snapshot as Decision<ProductionReadyPacket>;

    const sourceLeases = this.#sourceReadLeases;
    if (!sourceLeases) {
      return deny(ReasonCode.SOURCE_READ_LEASE_REQUIRED, "production gate has no source-read lease authority", {
        runId: input.runId,
      });
    }
    const acquired = input.sourceReadLeaseId
      ? null
      : sourceLeases.acquireSourceReadLease(
          input.runId,
          snapshot.value.repositories.map((repository) => repository.identity),
        );
    if (acquired && !acquired.allowed) return acquired as Decision<ProductionReadyPacket>;
    const sourceReadLeaseId = input.sourceReadLeaseId ?? acquired!.value.leaseId;
    const releaseSourceReadLease = acquired?.allowed ? acquired.value.release : null;
    // The identities the packet actually covers: a caller-supplied lease is only good for
    // these, and every re-check through publication asks the same question.
    const leasedIdentities = snapshot.value.repositories.map((repository) => repository.identity);
    const checkLease = (): Decision<void> =>
      sourceLeases.assertSourceReadLease(input.runId, sourceReadLeaseId, leasedIdentities);
    const held = checkLease();
    if (!held.allowed) {
      releaseSourceReadLease?.();
      return held as Decision<ProductionReadyPacket>;
    }

    try {
      const freshness = this.revalidateCandidateFreshness(input.runId, input.candidateSnapshotDigest);
      if (!freshness.allowed) return freshness as Decision<ProductionReadyPacket>;

    const verificationArtifact = this.artifacts.latestForSnapshot<VerificationReport>(
      input.runId,
      ArtifactKind.VERIFICATION,
      input.candidateSnapshotDigest,
    );
    if (!verificationArtifact || verificationArtifact.content.status !== "PASS") {
      return deny(ReasonCode.EVIDENCE_MISSING, "no passing verification for this candidate", {
        runId: input.runId,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        status: verificationArtifact?.content.status ?? null,
      });
    }
    if (verificationArtifact.producedBy !== "verification-engine") {
      return deny(ReasonCode.EVIDENCE_MISSING, "verification artifact was not written by the engine", {
        runId: input.runId,
        producedBy: verificationArtifact.producedBy,
      });
    }

    // The JSON report alone is not the evidence: it must agree with the normalized
    // per-command rows the engine wrote. A hand-assembled PASS blob has no rows behind it.
    const corroboration = this.corroborateVerification(
      input.runId,
      input.candidateSnapshotDigest,
      verificationArtifact.content,
    );
    if (!corroboration.allowed) return corroboration as Decision<ProductionReadyPacket>;

    const reviewArtifact = this.artifacts.latestForSnapshot<ReviewPacket>(
      input.runId,
      ArtifactKind.BLIND_REVIEW,
      input.candidateSnapshotDigest,
    );
    if (!reviewArtifact) {
      return deny(ReasonCode.REVIEW_REQUIRED, "no blind review for this candidate", {
        runId: input.runId,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
      });
    }
    if (reviewArtifact.producedBy !== "blind-review-gate") {
      return deny(ReasonCode.REVIEW_REQUIRED, "review artifact was not written by the review gate", {
        runId: input.runId,
        producedBy: reviewArtifact.producedBy,
      });
    }

    // CP-HI-04 — the reviewer named in the packet must be a session that really held the
    // BLIND_REVIEWER binding for this run at that generation, and must not be a producer.
    const provenance = this.reviewerProvenance(input.runId, reviewArtifact.content);
    if (!provenance.allowed) return provenance as Decision<ProductionReadyPacket>;

    if (reviewArtifact.content.verdict !== "PASS") {
      return deny(ReasonCode.REVIEW_REQUIRED, "blind review has not passed", {
        verdict: reviewArtifact.content.verdict,
      });
    }
    if (reviewArtifact.content.omittedItems.length > 0) {
      return deny(ReasonCode.COVERAGE_INCOMPLETE, "blind review reports omitted items", {
        omittedItems: reviewArtifact.content.omittedItems,
      });
    }

    const blockers = reviewArtifact.content.findings.filter((f) => f.severity === "BLOCKER");
    if (blockers.length > 0) {
      return deny(ReasonCode.REVIEW_BLOCK, "candidate has unresolved blocker findings", {
        blockers: blockers.map((b) => b.summary),
      });
    }

    const humanGate = this.humanGateStatus(input.runId);
    if (humanGate.required && humanGate.items.length === 0) {
      return deny(
        ReasonCode.HUMAN_GATE_REQUIRED,
        "run requires an owner gate but its contract names no owner decision item",
        { runId: input.runId, executionMode: run.executionMode },
      );
    }

    const packet: ProductionReadyPacket = {
      runId: input.runId,
      projectId: run.projectId,
      goal: run.goal,
      resultSummary: input.approval.resultSummary,
      candidateSnapshotDigest: input.candidateSnapshotDigest,
      verification: {
        status: verificationArtifact.content.status,
        expectedInputs: verificationArtifact.content.expectedInputs,
        observedInputs: verificationArtifact.content.observedInputs,
        commands: verificationArtifact.content.results.map((r) => ({
          commandId: r.commandId,
          source: r.source,
          status: r.status,
          exactHead: r.exactHead,
        })),
        digest: verificationArtifact.digest,
      },
      blindReview: {
        verdict: reviewArtifact.content.verdict,
        digest: reviewArtifact.digest,
        provider: reviewArtifact.content.provider,
        model: reviewArtifact.content.model,
        coveredFiles: reviewArtifact.content.coveredFiles.length,
        omittedItems: reviewArtifact.content.omittedItems.length,
        findings: reviewArtifact.content.findings.length,
      },
      knownResidualRisk: input.approval.residualRisk,
      changedRepositories: snapshot.value.repositories.map((repo) => ({
        identity: repo.identity,
        baseHead: repo.baseHead,
        candidateHead: repo.candidateHead,
        files: repo.touchedPaths.length,
      })),
      ctoRecommendation: input.approval.recommendation,
      humanGate,
      createdAt: this.clock.nowIso(),
    };

    const ceo = this.bindings.active(roleKeyFor(Role.CEO));
    if (!ceo) {
      return deny(ReasonCode.GATE_AUTHORITY_DENIED, "no CEO binding can receive the production packet", {
        runId: input.runId,
      });
    }

    // §30.3 — publication means all four durable facts exist together: CTO approval,
    // immutable packet, READY transition, and a fenced notification intent. A denied
    // transition is thrown through the transaction so an earlier artifact cannot escape.
    try {
      return this.db.tx(() => {
        const stillHeld = checkLease();
        if (!stillHeld.allowed) {
          throw acpError(stillHeld.reasonCode, stillHeld.message, stillHeld.evidence);
        }
        const currentCeo = this.bindings.active(roleKeyFor(Role.CEO));
        if (
          !currentCeo ||
          currentCeo.sessionId !== ceo.sessionId ||
          currentCeo.bindingGeneration !== ceo.bindingGeneration
        ) {
          throw acpError(ReasonCode.GATE_AUTHORITY_DENIED, "CEO binding changed before notification", {
            runId: input.runId,
          });
        }

        this.artifacts.put(input.runId, ArtifactKind.APPROVAL, input.approval, input.candidateSnapshotDigest);
        this.artifacts.putEvidence(
          this.packetWriter,
          input.runId,
          ArtifactKind.PRODUCTION_READY_PACKET,
          packet,
          input.candidateSnapshotDigest,
        );

        const afterPacketWrite = checkLease();
        if (!afterPacketWrite.allowed) {
          throw acpError(afterPacketWrite.reasonCode, afterPacketWrite.message, afterPacketWrite.evidence);
        }

        const transition = this.runs.transition(
          input.runId,
          RunState.READY_FOR_CEO_REVIEW,
          "production-ready packet assembled",
          { candidateSnapshotDigest: input.candidateSnapshotDigest },
        );
        if (!transition.allowed) {
          throw acpError(transition.reasonCode, transition.message, transition.evidence);
        }

        const afterTransition = checkLease();
        if (!afterTransition.allowed) {
          throw acpError(afterTransition.reasonCode, afterTransition.message, afterTransition.evidence);
        }

        this.outbox.enqueue({
          idempotencyKey: `notify:${NotificationKind.READY_FOR_CEO_REVIEW}:${input.runId}:${digestOf({
            goal: run.goal,
            candidateSnapshotDigest: input.candidateSnapshotDigest,
            humanGate,
          })}`,
          roleKey: ceo.roleKey,
          bindingGeneration: ceo.bindingGeneration,
          targetSessionId: ceo.sessionId,
          runId: input.runId,
          kind: MessageKind.CEO_NOTIFICATION,
          payload: {
            notification: NotificationKind.READY_FOR_CEO_REVIEW,
            runId: input.runId,
            goal: run.goal,
            candidateSnapshotDigest: input.candidateSnapshotDigest,
            humanGate,
          },
        });
        this.audit.record({
          kind: "CEO_NOTIFICATION",
          runId: input.runId,
          roleKey: ceo.roleKey,
          evidence: {
            notification: NotificationKind.READY_FOR_CEO_REVIEW,
            goal: run.goal,
            candidateSnapshotDigest: input.candidateSnapshotDigest,
            humanGate,
          },
        });
        return allow(ReasonCode.OK, packet);
      });
    } catch (error) {
      if (isAcpError(error)) return deny(error.reasonCode, error.message, error.evidence);
      throw error;
    }
    } finally {
      releaseSourceReadLease?.();
    }
  }

  /**
   * §19.2 — the CEO's confirm is bound to the exact candidate. If the candidate moved
   * between packet and confirm, the confirm is void rather than approximately right.
   */
  submitCeoDecision(input: {
    runId: string;
    decision: CeoDecision;
    candidateSnapshotDigest: string;
    ceoSessionId: string;
    rationale: string;
  }): Decision<{ state: RunState }> {
    const run = this.runs.get(input.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: input.runId });
    if (run.state !== RunState.READY_FOR_CEO_REVIEW) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${run.state}`, { runId: input.runId });
    }

    // A bootstrap run has no candidate to ship, so its evidence is the activation result
    // rather than a production-ready packet (§26.3).
    const isBootstrap = run.kind === RunKind.PROJECT_BOOTSTRAP;
    const packet = this.artifacts.latestForSnapshot<ProductionReadyPacket>(
      input.runId,
      ArtifactKind.PRODUCTION_READY_PACKET,
      input.candidateSnapshotDigest,
    );
    if (!packet && !isBootstrap) {
      return deny(ReasonCode.EVIDENCE_STALE, "no production-ready packet for this candidate", {
        runId: input.runId,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
      });
    }

    if (input.decision === "CONFIRM") {
      const continuity = this.assertCompletionAllowed(input.runId);
      if (!continuity.allowed) return continuity as Decision<{ state: RunState }>;
    }

    // The decision is an exercise of the CEO role, so the session must currently hold it.
    // Independence alone would let any unknown id decide (CP-HI-07).
    const holds = this.assertCurrentCeo(input.ceoSessionId);
    if (!holds.allowed) return holds as Decision<{ state: RunState }>;

    // CP-HI-04 second clause — the deciding CEO session cannot also be this run's CTO
    // or blind reviewer.
    const independence = this.bindings.assertFinalCeoIndependence(input.runId, input.ceoSessionId);
    if (!independence.allowed) return independence as Decision<{ state: RunState }>;

    // The packet records what the owner gate said when it was published, but a later
    // authenticated rejection is authoritative at confirmation time.
    const humanGate = this.humanGateStatus(input.runId);
    if (input.decision === "CONFIRM" && humanGate.required && !humanGate.satisfied) {
      return deny(
        ReasonCode.HUMAN_GATE_UNSATISFIED,
        "candidate requires owner approval that has not been recorded",
        { runId: input.runId, items: humanGate.items },
      );
    }

    if (input.decision === "CONFIRM" && !isBootstrap) {
      const freshness = this.revalidateCandidateFreshness(input.runId, input.candidateSnapshotDigest);
      if (!freshness.allowed) {
        const invalidated = this.runs.invalidateCandidate(
          input.runId,
          "candidate freshness failed at CEO confirmation",
          freshness.evidence,
        );
        if (!invalidated.allowed) return invalidated as Decision<{ state: RunState }>;
        return freshness as Decision<{ state: RunState }>;
      }
    }

    const target =
      input.decision === "CONFIRM"
        ? RunState.COMPLETED
        : input.decision === "FINAL_REVISE"
          ? RunState.REVISION_REQUIRED
          : RunState.AWAITING_HUMAN;

    try {
      return this.db.tx(() => {
        if (input.decision === "CONFIRM" && isBootstrap) {
          const finalizer = this.#bootstrapActivation;
          if (!finalizer) {
            return deny(
              ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
              "bootstrap activation finalizer is not configured",
              { runId: input.runId },
            );
          }
          const finalized = finalizer.finalizeBootstrapActivationConfirm({
            runId: input.runId,
            candidateSnapshotDigest: input.candidateSnapshotDigest,
            ceoSessionId: input.ceoSessionId,
            confirmedAt: this.clock.nowIso(),
          });
          if (!finalized.allowed) return finalized as Decision<{ state: RunState }>;
        }

        const transition = this.runs.transition(
          input.runId,
          target,
          `CEO ${input.decision}`,
          { candidateSnapshotDigest: input.candidateSnapshotDigest, rationale: input.rationale },
          isBootstrap && input.decision === "CONFIRM"
            ? this.completion.bootstrapActivation
            : this.completion.productionGate,
        );
        if (!transition.allowed) return transition as Decision<{ state: RunState }>;

        this.audit.record({
          kind: "CEO_DECISION",
          runId: input.runId,
          sessionId: input.ceoSessionId,
          evidence: {
            decision: input.decision,
            candidateSnapshotDigest: input.candidateSnapshotDigest,
            rationale: input.rationale,
          },
        });
        this.telemetry.record({
          scope: "quality",
          name: "ceo_outcome",
          runId: input.runId,
          text: input.decision,
        });
        return allow(ReasonCode.OK, { state: target });
      });
    } catch (error) {
      if (isAcpError(error)) return deny(error.reasonCode, error.message, error.evidence);
      throw error;
    }
  }

  /**
   * §17.6/§17.7 — the report must match the rows. Every required command needs a PASS row
   * for this exact candidate, and no row for it may be anything other than PASS.
   */
  private corroborateVerification(
    runId: string,
    candidateSnapshotDigest: string,
    report: VerificationReport,
  ): Decision<void> {
    const rows = this.db.all<{
      command_id: string;
      repository_identity: string;
      source: string;
      exact_head: string;
      status: string;
      output_digest: string;
    }>(
      `SELECT command_id, repository_identity, source, exact_head, status, output_digest
         FROM verification_results
        WHERE run_id = ? AND candidate_snapshot_digest = ?`,
      [runId, candidateSnapshotDigest],
    );
    if (rows.length === 0) {
      return deny(ReasonCode.EVIDENCE_MISSING, "no verification result rows for this candidate", {
        runId,
        candidateSnapshotDigest,
      });
    }
    const failing = rows.filter((r) => r.status !== "PASS");
    if (failing.length > 0) {
      return deny(ReasonCode.VERIFICATION_COMMAND_FAILED, "verification rows contradict the report", {
        runId,
        failing,
      });
    }
    const reportRows = report.results.map((result) => ({
      commandId: result.commandId,
      repositoryIdentity: result.repositoryIdentity,
      source: result.source,
      exactHead: result.exactHead,
      status: result.status,
      outputDigest: result.outputDigest,
    }));
    const key = (row: {
      commandId: string;
      repositoryIdentity: string;
      source: string;
      exactHead: string;
      status: string;
      outputDigest: string;
    }): string =>
      [row.commandId, row.repositoryIdentity, row.source, row.exactHead, row.status, row.outputDigest]
        .map((field) => JSON.stringify(field))
        .join("|");
    const reported = reportRows.map(key);
    const observed = rows.map((row) =>
      key({
        commandId: row.command_id,
        repositoryIdentity: row.repository_identity,
        source: row.source,
        exactHead: row.exact_head,
        status: row.status,
        outputDigest: row.output_digest,
      }),
    );
    const reportedSet = new Set(reported);
    const observedSet = new Set(observed);
    const missing = reported.filter((entry) => !observedSet.has(entry));
    const extra = observed.filter((entry) => !reportedSet.has(entry));
    if (
      report.expectedInputs !== report.observedInputs ||
      report.expectedInputs !== reportRows.length ||
      reportRows.length !== rows.length ||
      reportedSet.size !== reportRows.length ||
      observedSet.size !== rows.length ||
      missing.length > 0 ||
      extra.length > 0
    ) {
      return deny(ReasonCode.VERIFICATION_INCOMPLETE, "verification report is not fully corroborated", {
        runId,
        missing,
        extra,
        rows: rows.length,
        reportRows: reportRows.length,
        expectedInputs: report.expectedInputs,
        observedInputs: report.observedInputs,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** A completion is not safe when the continuity evaluator has not been wired. */
  private assertCompletionAllowed(runId: string): Decision<void> {
    if (!this.#continuity?.assertCompletionAllowed) {
      return deny(
        ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
        "completion requires a current continuity evaluation",
        { runId },
      );
    }
    return this.#continuity.assertCompletionAllowed(runId);
  }

  /** Require the stored, self-consistent snapshot that every packet claims to summarize. */
  private requireCandidateSnapshot(
    runId: string,
    digest: string,
  ): Decision<CandidateSnapshot> {
    const artifact = this.artifacts.latestForSnapshot<unknown>(
      runId,
      ArtifactKind.CANDIDATE_SNAPSHOT,
      digest,
    );
    if (!artifact) {
      return deny(ReasonCode.EVIDENCE_MISSING, "candidate snapshot artifact is missing", { runId, digest });
    }
    const parsed = candidateSnapshotSchema.safeParse(artifact.content);
    if (!parsed.success) {
      return deny(ReasonCode.EVIDENCE_MISSING, "candidate snapshot has an invalid schema", {
        runId,
        digest,
      });
    }
    const snapshot = parsed.data;
    if (
      artifact.candidateSnapshotDigest !== digest ||
      snapshot.runId !== runId ||
      candidateSnapshotDigest(snapshot) !== digest
    ) {
      return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "candidate snapshot binding does not match its content", {
        runId,
        expectedDigest: digest,
        artifactDigest: artifact.candidateSnapshotDigest,
        contentDigest: candidateSnapshotDigest(snapshot),
        snapshotRunId: snapshot.runId,
      });
    }

    const participants = this.runs.repositoriesOf(runId);
    const byIdentity = new Map(snapshot.repositories.map((repository) => [repository.identity, repository]));
    if (byIdentity.size !== snapshot.repositories.length || participants.length !== byIdentity.size) {
      return deny(ReasonCode.COVERAGE_INCOMPLETE, "candidate snapshot does not cover every run repository", {
        runId,
        participants: participants.map((repository) => repository.identity),
        snapshotRepositories: snapshot.repositories.map((repository) => repository.identity),
      });
    }
    const mismatch = participants.find((participant) => {
      const frozen = byIdentity.get(participant.identity);
      return (
        !frozen ||
        frozen.repositoryRole !== participant.repositoryRole ||
        frozen.baseBranch !== participant.baseBranch ||
        frozen.manifestDigest !== participant.activeManifestDigest
      );
    });
    if (mismatch) {
      return deny(ReasonCode.COVERAGE_INCOMPLETE, "candidate snapshot repository coverage is inconsistent", {
        runId,
        repository: mismatch.identity,
      });
    }
    return allow(ReasonCode.OK, snapshot);
  }

  /** Re-read the complete frozen tuple directly before the irrevocable CEO confirmation. */
  private revalidateCandidateFreshness(runId: string, digest: string): Decision<void> {
    const snapshot = this.requireCandidateSnapshot(runId, digest);
    if (!snapshot.allowed) return snapshot as Decision<void>;
    const participants = new Map(
      this.runs.repositoriesOf(runId).map((repository) => [repository.identity, repository]),
    );
    const drift: Array<Record<string, unknown>> = [];

    for (const frozen of snapshot.value.repositories) {
      const participant = participants.get(frozen.identity);
      if (!participant) {
        drift.push({ identity: frozen.identity, reason: "repository no longer participates in run" });
        continue;
      }
      const git = (args: string[]): string | null => {
        try {
          return execFileSync("git", ["-C", participant.checkoutPath, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        } catch {
          return null;
        }
      };
      const head = git(["rev-parse", "HEAD"]);
      const tree = git(["rev-parse", `${frozen.candidateHead}^{tree}`]);
      const base = git(["rev-parse", frozen.baseBranch]);
      const status = git(["status", "--porcelain", "--untracked-files=all"]);
      if (head !== frozen.candidateHead) {
        drift.push({ identity: frozen.identity, expectedHead: frozen.candidateHead, observedHead: head });
      }
      if (`git-tree:${tree}` !== frozen.treeDigest) {
        drift.push({ identity: frozen.identity, expectedTree: frozen.treeDigest, observedTree: tree });
      }
      if (base !== frozen.baseHead) {
        drift.push({ identity: frozen.identity, expectedBaseHead: frozen.baseHead, observedBaseHead: base });
      }
      if (participant.activeManifestDigest !== frozen.manifestDigest) {
        drift.push({
          identity: frozen.identity,
          expectedManifestDigest: frozen.manifestDigest,
          observedManifestDigest: participant.activeManifestDigest,
        });
      }
      if (status !== "") {
        drift.push({ identity: frozen.identity, reason: "working tree has uncommitted changes" });
      }
    }

    return drift.length === 0
      ? allow(ReasonCode.OK, undefined)
      : deny(ReasonCode.SNAPSHOT_STALE, "candidate snapshot is no longer fresh at CEO confirmation", {
          runId,
          candidateSnapshotDigest: digest,
          drift,
        });
  }

  /** Facts in a bootstrap result are cross-checked against durable control-plane state. */
  private validateBootstrapActivation(runId: string, value: unknown): Decision<void> {
    if (!isRecord(value)) {
      return deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, "activation result has no valid schema", { runId });
    }
    const projectRegistration = isRecord(value["projectRegistration"])
      ? value["projectRegistration"]
      : null;
    const primary = isRecord(value["primaryCtoBinding"]) ? value["primaryCtoBinding"] : null;
    const buzz = isRecord(value["buzz"]) ? value["buzz"] : null;
    const handoffAck = isRecord(value["handoffAck"]) ? value["handoffAck"] : null;
    const doctor = isRecord(value["doctor"]) ? value["doctor"] : null;
    const projectId = typeof value["projectId"] === "string" ? value["projectId"] : null;
    const incomplete: string[] = [];

    if (
      value["schema"] !== "agent-control-plane.bootstrap-activation.v1" ||
      value["runId"] !== runId ||
      !projectId ||
      !projectRegistration ||
      projectRegistration["registered"] !== true ||
      typeof projectRegistration["activeManifestDigest"] !== "string" ||
      !Array.isArray(value["localBindings"]) ||
      value["localBindings"].length === 0 ||
      !isRecord(value["blindReview"]) ||
      value["blindReview"]["verdict"] !== "PASS" ||
      !primary ||
      typeof primary["roleKey"] !== "string" ||
      typeof primary["sessionId"] !== "string" ||
      typeof primary["bindingGeneration"] !== "number" ||
      !buzz ||
      buzz["connected"] !== true ||
      !handoffAck ||
      typeof handoffAck["handoffId"] !== "string" ||
      typeof handoffAck["ackedAt"] !== "string" ||
      !doctor ||
      (doctor["status"] !== "HEALTHY" && doctor["status"] !== "DEGRADED") ||
      value["activity"] !== "ACTIVE"
    ) {
      incomplete.push("activationResult");
    }

    if (projectId && projectRegistration && typeof projectRegistration["activeManifestDigest"] === "string") {
      const project = this.db.get<{ active_manifest_digest: string }>(
        `SELECT active_manifest_digest FROM projects WHERE project_id = ?`,
        [projectId],
      );
      if (!project || project.active_manifest_digest !== projectRegistration["activeManifestDigest"]) {
        incomplete.push("projectManifestBinding");
      }
    }
    if (projectId && primary) {
      const binding = this.db.get<{ session_id: string; binding_generation: number }>(
        `SELECT session_id, binding_generation FROM assignments
          WHERE role_key = ? AND project_id = ? AND status = 'ACTIVE'`,
        [primary["roleKey"], projectId],
      );
      if (
        !binding ||
        binding.session_id !== primary["sessionId"] ||
        binding.binding_generation !== primary["bindingGeneration"]
      ) {
        incomplete.push("primaryCtoBinding");
      }
    }
    if (primary) {
      const session = this.db.get<{ buzz_address: string | null }>(
        `SELECT buzz_address FROM sessions WHERE session_id = ?`,
        [primary["sessionId"]],
      );
      if (!session?.buzz_address) incomplete.push("buzzBinding");
    }
    if (projectId && handoffAck) {
      const handoff = this.db.get<{ status: string; acked_at: string | null }>(
        `SELECT status, acked_at FROM handoffs WHERE handoff_id = ? AND project_id = ? AND kind = 'BOOTSTRAP'`,
        [handoffAck["handoffId"], projectId],
      );
      if (handoff?.status !== "ACKED" || handoff.acked_at !== handoffAck["ackedAt"]) {
        incomplete.push("handoffAckBinding");
      }
    }
    const blindReview = isRecord(value["blindReview"]) ? value["blindReview"] : null;
    const review = blindReview
      ? this.artifacts
          .list<{ verdict?: string }>(runId, ArtifactKind.BLIND_REVIEW)
          .find((artifact) => artifact.digest === blindReview["digest"] && artifact.content.verdict === "PASS")
      : null;
    if (!review) incomplete.push("blindReviewBinding");

    return incomplete.length === 0
      ? allow(ReasonCode.OK, undefined)
      : deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, "activation result is incomplete or unbound", {
          runId,
          incomplete,
        });
  }

  private humanGateDefinition(runId: string): { required: boolean; items: string[]; digest: string } {
    const run = this.runs.get(runId);
    const contract = this.artifacts.latest<{ humanGate?: unknown; scope?: unknown }>(
      runId,
      ArtifactKind.TASK_CONTRACT,
    );
    const declaredItems = Array.isArray(contract?.content.humanGate)
      ? contract.content.humanGate.filter((item): item is string => typeof item === "string")
      : [];
    const scope = Array.isArray(contract?.content.scope)
      ? contract.content.scope.filter((item): item is string => typeof item === "string")
      : [];
    const definition = run
      ? deriveHumanGate({
          executionMode: run.executionMode,
          goal: run.goal,
          scope,
          declaredItems,
        })
      : { required: declaredItems.length > 0, items: declaredItems };
    return { ...definition, digest: digestOf(definition.items) };
  }

  /** The reviewer identity in the packet must match a real binding, and be independent. */
  private reviewerProvenance(runId: string, packet: ReviewPacket): Decision<void> {
    const binding = this.db.get<{ session_id: string; binding_generation: number }>(
      `SELECT session_id, binding_generation FROM assignments
        WHERE run_id = ? AND role = 'BLIND_REVIEWER' AND session_id = ? AND binding_generation = ?`,
      [runId, packet.reviewerSessionId, packet.reviewerRoleBindingGeneration],
    );
    if (!binding) {
      return deny(
        ReasonCode.REVIEWER_NOT_INDEPENDENT,
        "packet names a reviewer that never held the blind reviewer binding for this run",
        {
          runId,
          reviewerSessionId: packet.reviewerSessionId,
          generation: packet.reviewerRoleBindingGeneration,
        },
      );
    }
    return this.bindings.assertReviewerIndependence(runId, packet.reviewerSessionId);
  }

  private assertCurrentCeo(sessionId: string): Decision<void> {
    const binding = this.bindings.active(roleKeyFor(Role.CEO));
    if (!binding) {
      return deny(ReasonCode.GATE_AUTHORITY_DENIED, "no session currently holds the CEO role", {
        sessionId,
      });
    }
    if (binding.sessionId !== sessionId) {
      return deny(
        ReasonCode.GATE_AUTHORITY_DENIED,
        "only the session currently bound to the CEO role may decide",
        { sessionId, current: binding.sessionId, generation: binding.bindingGeneration },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * §21 — who an owner decision belongs to, as the audit actor `channel:actor`.
   *
   * An allowlisted `{channel, actor}` pair is still caller-controlled data. Even a local
   * process can be reached by an untrusted request path, so only an admitted receipt that
   * binds this exact operation proves non-delegable owner authority (CP-HI-07).
   */
  private attributeOwnerDecision(input: {
    runId: string;
    item: string;
    approved: boolean;
    note: string;
    receipt?: OwnerApprovalReceipt;
    owner?: { channel: string; actor: string };
  }): Decision<string> {
    const authority = this.#ownerAuthority;
    if (!authority) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "no owner authority is configured, so an owner decision cannot be attributed",
        { runId: input.runId },
      );
    }

    const receipt = input.receipt;
    if (!receipt) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner decision requires an admitted ingress receipt, not a caller-supplied identity",
        {
          runId: input.runId,
          channel: input.owner?.channel ?? null,
          actor: input.owner?.actor ?? null,
        },
      );
    }

    const parameterDigest = digestOf({ item: input.item, approved: input.approved, note: input.note });
    if (
      receipt.runId !== input.runId ||
      receipt.operation !== OWNER_DECISION_OPERATION ||
      receipt.parameterDigest !== parameterDigest ||
      receipt.approved !== input.approved
    ) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "owner decision receipt does not bind this exact decision",
        { runId: input.runId, operation: receipt.operation },
      );
    }
    const authorised = authority.assertApproval(receipt);
    if (!authorised.allowed) return authorised as Decision<string>;
    return allow(ReasonCode.OK, `${receipt.channel}:${receipt.actor}`);
  }

  /**
   * §21 — an owner decision recorded against a specific run and gate item. A satisfied
   * gate resumes the run, so the decision and the resumption are one transaction: a gate
   * that reads as cleared while the run stays parked is the failure this prevents.
   */
  recordOwnerDecision(input: {
    runId: string;
    item: string;
    approved: boolean;
    note: string;
    /** The only owner authority a transport can carry (§27.1). */
    receipt?: OwnerApprovalReceipt;
    /** @deprecated Identity alone is never authority; use an admitted receipt. */
    owner?: { channel: string; actor: string };
  }): Decision<void> {
    const attributed = this.attributeOwnerDecision(input);
    if (!attributed.allowed) return attributed as Decision<void>;
    const actor = attributed.value;
    const run = this.runs.get(input.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: input.runId });
    const gate = this.humanGateDefinition(input.runId);

    try {
      return this.db.tx(() => {
      const fresh = this.runs.require(input.runId);
      const candidateSnapshotDigest = this.runs.currentCandidate(input.runId);
      if (!candidateSnapshotDigest) {
        return deny(
          ReasonCode.EVIDENCE_STALE,
          "owner decision requires the run's current frozen candidate",
          { runId: input.runId },
        );
      }
      this.artifacts.put(input.runId, ArtifactKind.APPROVAL, {
        kind: "OWNER_DECISION",
        item: input.item,
        approved: input.approved,
        note: input.note,
        at: this.clock.nowIso(),
        humanGateDigest: gate.digest,
        candidateSnapshotDigest,
      }, candidateSnapshotDigest);
      this.audit.record({
        kind: "OWNER_DECISION",
        runId: input.runId,
        actor,
        evidence: { item: input.item, approved: input.approved, candidateSnapshotDigest, humanGateDigest: gate.digest },
      });

      const status = this.humanGateStatus(input.runId);
      if (fresh.state !== RunState.AWAITING_HUMAN || !status.satisfied) {
        return allow(ReasonCode.OK, undefined);
      }

      const binding = fresh.ownerRoleKey ? this.bindings.active(fresh.ownerRoleKey) : null;
      if (
        !binding ||
        binding.sessionId !== fresh.ownerSessionId ||
        binding.bindingGeneration !== fresh.ownerBindingGeneration
      ) {
        throw acpError(ReasonCode.RUN_OWNER_NOT_PINNED, "cannot resume without the current run owner", {
          runId: input.runId,
          roleKey: fresh.ownerRoleKey,
        });
      }
      const transition = this.runs.transition(
        input.runId,
        RunState.ACTIVE,
        "required owner decisions recorded",
        { candidateSnapshotDigest, humanGateDigest: gate.digest },
      );
      if (!transition.allowed) {
        throw acpError(transition.reasonCode, transition.message, transition.evidence);
      }
      this.outbox.enqueue({
        idempotencyKey: `owner-decision-resume:${input.runId}:${candidateSnapshotDigest ?? "none"}:${gate.digest}`,
        roleKey: binding.roleKey,
        bindingGeneration: binding.bindingGeneration,
        targetSessionId: binding.sessionId,
        runId: input.runId,
        kind: MessageKind.RUN_DISPATCH,
        payload: {
          runId: input.runId,
          reason: "OWNER_DECISION_RECORDED",
          candidateSnapshotDigest,
          humanGate: status,
        },
      });
        return allow(ReasonCode.OK, undefined);
      });
    } catch (error) {
      if (isAcpError(error)) return deny(error.reasonCode, error.message, error.evidence);
      throw error;
    }
  }

  humanGateStatus(runId: string): { required: boolean; items: string[]; satisfied: boolean } {
    const gate = this.humanGateDefinition(runId);
    const { items } = gate;
    if (!gate.required) return { required: false, items: [], satisfied: true };
    if (items.length === 0) return { required: true, items: [], satisfied: false };

    const currentCandidate = this.runs.currentCandidate(runId);
    if (!currentCandidate) return { required: true, items, satisfied: false };
    const latestDecision = new Map<string, boolean>();
    for (const artifact of this.artifacts.list<{
      kind?: string;
      item?: string;
      approved?: boolean;
      humanGateDigest?: string;
      candidateSnapshotDigest?: string | null;
    }>(runId, ArtifactKind.APPROVAL)) {
      const decision = artifact.content;
      if (
        artifact.superseded ||
        decision.kind !== "OWNER_DECISION" ||
        !decision.item ||
        typeof decision.approved !== "boolean" ||
        decision.humanGateDigest !== gate.digest ||
        artifact.candidateSnapshotDigest !== currentCandidate ||
        decision.candidateSnapshotDigest !== currentCandidate
      ) {
        continue;
      }
      // ArtifactStore.list is durable creation order (then rowid), so assignment makes
      // a later explicit rejection revoke an earlier approval for the same gate item.
      latestDecision.set(decision.item, decision.approved);
    }

    return { required: true, items, satisfied: items.every((item) => latestDecision.get(item) === true) };
  }

  /**
   * §20 — a CTO escalation. Non-blocking escalations leave the run ACTIVE so other work
   * continues; only a blocked critical path moves the run to BLOCKED.
   */
  openEscalation(escalation: Escalation): Decision<{ state: RunState }> {
    const run = this.runs.get(escalation.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: escalation.runId });

    this.audit.record({
      kind: "CTO_ESCALATION",
      runId: escalation.runId,
      sessionId: escalation.openedBySessionId,
      evidence: {
        question: escalation.question,
        options: escalation.options,
        recommendation: escalation.ctoRecommendation,
        blocksCriticalPath: escalation.blocksCriticalPath,
      },
    });

    const notified = this.notify(NotificationKind.TRUE_ESCALATION, escalation.runId, {
      question: escalation.question,
      options: escalation.options,
      recommendation: escalation.ctoRecommendation,
      whyItMatters: escalation.whyItMatters,
      blocksCriticalPath: escalation.blocksCriticalPath,
    });
    if (!notified.allowed) return notified as Decision<{ state: RunState }>;

    if (!escalation.blocksCriticalPath) return allow(ReasonCode.OK, { state: run.state });

    const transition = this.runs.transition(
      escalation.runId,
      RunState.BLOCKED,
      "CEO_DECISION_REQUIRED",
      { question: escalation.question },
    );
    if (!transition.allowed) return transition as Decision<{ state: RunState }>;
    return allow(ReasonCode.OK, { state: RunState.BLOCKED });
  }

  resolveEscalation(runId: string, resolution: string, byCeoSession: string): Decision<void> {
    const run = this.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    const holds = this.assertCurrentCeo(byCeoSession);
    if (!holds.allowed) return holds as Decision<void>;
    this.audit.record({
      kind: "CEO_DECISION",
      runId,
      sessionId: byCeoSession,
      evidence: { resolution, escalation: true },
    });
    if (run.state === RunState.BLOCKED) {
      const transition = this.runs.transition(runId, RunState.ACTIVE, "escalation resolved");
      if (!transition.allowed) return transition as Decision<void>;
    }
    const ownerRoleKey = this.runs.ownerRoleKeyFor(run);
    const binding = ownerRoleKey ? this.bindings.active(ownerRoleKey) : null;
    if (binding) {
      this.outbox.enqueue({
        idempotencyKey: `escalation-reply:${runId}:${digestOf(resolution)}`,
        roleKey: binding.roleKey,
        bindingGeneration: binding.bindingGeneration,
        targetSessionId: binding.sessionId,
        runId,
        kind: MessageKind.ESCALATION_REPLY,
        payload: { runId, resolution },
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * §19.3 — routine worker, test and review churn never reaches Hermes. Only the three
   * documented notification kinds are emitted, and this is the only emitter.
   */
  notify(kind: NotificationKind, runId: string, payload: Record<string, unknown>): Decision<void> {
    // Audit evidence is intentionally a reviewed, bounded vocabulary. The delivery needs
    // the full explanation, but persisting its unreviewed field name causes AuditLog to
    // replace the whole evidence payload and makes the notification impossible to trace.
    const { whyItMatters: _whyItMatters, ...auditPayload } = payload;
    const auditEvidence = { notification: kind, ...auditPayload };
    const ceo = this.bindings.active(roleKeyFor(Role.CEO));
    if (!ceo) {
      this.audit.record({
        kind: "CEO_NOTIFICATION_BLOCKED",
        runId,
        reasonCode: ReasonCode.GATE_AUTHORITY_DENIED,
        roleKey: "CEO",
        evidence: auditEvidence,
      });
      return deny(ReasonCode.GATE_AUTHORITY_DENIED, "no CEO binding can receive notification", {
        runId,
        notification: kind,
      });
    }
    this.audit.record({
      kind: "CEO_NOTIFICATION",
      runId,
      roleKey: ceo.roleKey,
      evidence: auditEvidence,
    });
    this.outbox.enqueue({
      idempotencyKey: `notify:${kind}:${runId}:${digestOf(payload)}`,
      roleKey: ceo.roleKey,
      bindingGeneration: ceo.bindingGeneration,
      targetSessionId: ceo.sessionId,
      runId,
      kind: MessageKind.CEO_NOTIFICATION,
      payload: { notification: kind, runId, ...payload },
    });
    return allow(ReasonCode.OK, undefined);
  }

  packet(runId: string, candidateSnapshotDigest: string): ProductionReadyPacket | null {
    return (
      this.artifacts.latestForSnapshot<ProductionReadyPacket>(
        runId,
        ArtifactKind.PRODUCTION_READY_PACKET,
        candidateSnapshotDigest,
      )?.content ?? null
    );
  }

  /** Evidence drill-down for §19.1's "drill down when needed". */
  evidence(runId: string): Array<{ kind: string; digest: string; createdAt: string }> {
    return this.artifacts
      .list(runId)
      .map((a) => ({ kind: a.kind, digest: a.digest, createdAt: a.createdAt }));
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
