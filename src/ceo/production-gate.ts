import { execFileSync } from "node:child_process";

import { deriveHumanGate } from "./human-gate.ts";
import {
  bootstrapPlanIntentTasks,
  bootstrapReviewIntentCurrent,
  currentBootstrapPlan,
  isProjectlessBootstrap,
  sameBootstrapPlanBinding,
} from "../bootstrap/bootstrap-plan.ts";
import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { acpError, type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "./owner-authority.ts";
import type { BootstrapApplications } from "../bootstrap/bootstrap-applications.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore, EvidenceWriter } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import {
  ArtifactKind,
  type CeoDecision,
  RunState,
  Role,
  RunKind,
  type RunRow,
  roleKeyFor,
} from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { ReviewPacket } from "../review/blind-review.ts";
import type { RunEngine, CompletionAuthoritySet } from "../run/run-engine.ts";
import type { TaskGraph } from "../run/task-graph.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { CeoDecisionIngress, ManifestActivationGrants } from "../registry/manifest-activation-grants.ts";
import { type HermesAdmittedTurn, hermesTurnEvidence } from "../mcp/hermes-provenance.ts";
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

/** The longest resolution the CEO may send a run's owner in an ESCALATION_REPLY. */
export const ESCALATION_RESOLUTION_MAX_LENGTH = 4000;

/** What a resolution answered: the run, its state afterwards, the escalation and the reply. */
export interface EscalationResolution {
  runId: string;
  state: RunState;
  escalationId: number | null;
  messageId: string | null;
}

/** The identity of one `escalation_resolve` request: the run, the escalation it names, the resolution. */
export const escalationRequestDigestOf = (runId: string, escalationId: number, resolution: string): string =>
  digestOf({ runId, escalationId, resolution: digestOf(resolution) });

/** The digest an `escalation_resolve` idempotency key is recorded under; the key itself is never stored. */
const escalationKeyDigestOf = (idempotencyKey: string): string =>
  digestOf({ door: "escalation_resolve", idempotencyKey });

/**
 * #246 C3 — the bootstrap application record, as the CEO decision reads and completes it: a CONFIRM
 * completes a bootstrap only on a WRITTEN application of that candidate, and a FINAL_REVISE is
 * refused once the application is frozen.
 */
export type BootstrapApplicationsPort = Pick<BootstrapApplications, "get" | "assertNotFrozen" | "markCompleted">;

/**
 * #246 C3, review 1076-R1-02 — the chain a WRITTEN bootstrap application completes on, verified by
 * the Repo Factory runner: the approval anchored as its execution's identity and the stored result
 * attributed to the attempt ledger. A WRITTEN phase and a stored result are database rows, so the
 * decision that completes the run asks for the chain itself rather than trusting the phase.
 */
export interface BootstrapCompletionChainPort {
  verifyCompletionChain(runId: string, candidateSnapshotDigest: string): Decision<void>;
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

/** A CEO's decision on a run at READY_FOR_CEO_REVIEW, as Hermes submits it. */
export interface CeoDecisionInput {
  runId: string;
  decision: CeoDecision;
  candidateSnapshotDigest: string;
  ceoSessionId: string;
  rationale: string;
  /**
   * #246 B2-b — the session the MCP door authenticated for this call and the key of the MCP mutation it
   * runs under, passed through by the door and never taken from a tool argument. A CONTRACT_CHANGE
   * CONFIRM requires it, in flight now and naming the live CEO session the decision names; an
   * in-process caller has none and issues no grant.
   */
  ingress?: CeoDecisionIngress;
  /** The Hermes turn the CEO door admitted this call for, recorded in the decision's audit row. */
  hermesTurn?: HermesAdmittedTurn;
}

/** #246 B2-b — the grant authority a CONTRACT_CHANGE CONFIRM admits against and issues through. */
export type ManifestGrantsPort = Pick<
  ManifestActivationGrants,
  "admitConfirm" | "issue" | "bindConsumer" | "issueFirst" | "isFirstActivation"
>;

export class ProductionGate {
  #continuity: ContinuityGate | null = null;
  #ownerAuthority: OwnerAuthorityPort | null = null;
  #bootstrapApplications: BootstrapApplicationsPort | null = null;
  #bootstrapCompletionChain: BootstrapCompletionChainPort | null = null;
  #bootstrapActivation: BootstrapActivationFinalizer | null = null;
  #sourceReadLeases: SourceReadLeasePort | null = null;
  #manifestGrants: ManifestGrantsPort | null = null;

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
    bootstrapApplications?: BootstrapApplicationsPort;
    bootstrapCompletionChain?: BootstrapCompletionChainPort;
    sourceReadLeases?: SourceReadLeasePort;
    manifestGrants?: ManifestGrantsPort;
  }): void {
    if (ports.continuity) this.#continuity = ports.continuity;
    if (ports.ownerAuthority) this.#ownerAuthority = ports.ownerAuthority;
    if (ports.bootstrapActivation) this.#bootstrapActivation = ports.bootstrapActivation;
    if (ports.bootstrapApplications) this.#bootstrapApplications = ports.bootstrapApplications;
    if (ports.bootstrapCompletionChain) this.#bootstrapCompletionChain = ports.bootstrapCompletionChain;
    if (ports.sourceReadLeases) this.#sourceReadLeases = ports.sourceReadLeases;
    if (ports.manifestGrants) this.#manifestGrants = ports.manifestGrants;
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

    const completeness = this.reviewEntry(ownerCheck.value);
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

      const noParticipatingRepositories =
        snapshot.value.repositories.length === 0 && this.runs.repositoriesOf(input.runId).length === 0;
      let verificationForPacket: ProductionReadyPacket["verification"];
      let reviewForPacket: ProductionReadyPacket["blindReview"];

      // #246 C2 — a project-less bootstrap candidate joins no repository either, but its planned
      // outputs are reviewed (BOOTSTRAP_PLAN); its packet carries that review, never a not-applicable
      // one, and is refused without a PASS bound to the PLAN the candidate names.
      const bootstrapReview = noParticipatingRepositories && snapshot.value.bootstrapPlan !== undefined
        ? this.bootstrapPlanReview(input.runId, input.candidateSnapshotDigest, snapshot.value.bootstrapPlan)
        : null;
      if (bootstrapReview && !bootstrapReview.allowed) return bootstrapReview as Decision<ProductionReadyPacket>;

      if (noParticipatingRepositories) {
        // There is no source, command, or reviewer input in this predicate. Persist the
        // explicit no-op fact in the packet summary fields; the daemon adds the authoritative
        // "nothing to merge" completion evidence when it closes the run.
        verificationForPacket = {
          status: "PASS",
          expectedInputs: 0,
          observedInputs: 0,
          commands: [],
          digest: digestOf({
            kind: "NO_PARTICIPATING_REPOSITORIES",
            runId: input.runId,
            candidateSnapshotDigest: input.candidateSnapshotDigest,
          }),
        };
        reviewForPacket = bootstrapReview?.allowed
          ? bootstrapReview.value
          : {
              verdict: "PASS",
              digest: digestOf({
                kind: "NO_PARTICIPATING_REPOSITORIES",
                runId: input.runId,
                candidateSnapshotDigest: input.candidateSnapshotDigest,
                review: "NOT_APPLICABLE",
              }),
              provider: "not-applicable",
              model: "not-applicable",
              coveredFiles: 0,
              omittedItems: 0,
              findings: 0,
            };
      } else {
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

        verificationForPacket = {
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
        };
        reviewForPacket = {
          verdict: reviewArtifact.content.verdict,
          digest: reviewArtifact.digest,
          provider: reviewArtifact.content.provider,
          model: reviewArtifact.content.model,
          coveredFiles: reviewArtifact.content.coveredFiles.length,
          omittedItems: reviewArtifact.content.omittedItems.length,
          findings: reviewArtifact.content.findings.length,
        };
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
      verification: verificationForPacket,
      blindReview: reviewForPacket,
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
  submitCeoDecision(input: CeoDecisionInput): Decision<{ state: RunState }> {
    const reentry = this.contractChangeConsumerReentry(input);
    if (reentry) return reentry;
    const admitted = this.admitCeoDecision(input, "decide");
    if (!admitted.allowed) return admitted as Decision<{ state: RunState }>;
    const { isBootstrap } = admitted.value;
    const isContractChange = this.runs.get(input.runId)?.kind === RunKind.CONTRACT_CHANGE;

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
        ? (isBootstrap ? RunState.COMPLETED : RunState.CEO_APPROVED)
        : input.decision === "FINAL_REVISE"
          ? RunState.REVISION_REQUIRED
          : RunState.AWAITING_HUMAN;

    try {
      return this.db.tx(() => {
        // A packet is immutable audit evidence of the graph at publication time, not a
        // completion token. Re-read completeness under the same write transaction as the
        // terminal transition so work admitted after publication cannot complete the run.
        if (input.decision === "CONFIRM" && !isBootstrap) {
          const completeness = this.tasks.completeness(input.runId);
          if (!completeness.allowed) return completeness as Decision<{ state: RunState }>;
        }

        if (input.decision === "CONFIRM" && isBootstrap) {
          const finalizer = this.#bootstrapActivation;
          if (!finalizer) {
            return deny(
              ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
              "bootstrap activation finalizer is not configured",
              { runId: input.runId },
            );
          }
          // #246 C3, review 1076-R1-02 — the finalizer runs only on the verified chain, asked again
          // inside the transaction that completes the run and its application.
          const chain = this.#bootstrapCompletionChain;
          const verified = chain
            ? chain.verifyCompletionChain(input.runId, input.candidateSnapshotDigest)
            : deny(ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE, "the bootstrap completion chain verifier is not configured", {
                runId: input.runId,
              });
          if (!verified.allowed) return verified as Decision<{ state: RunState }>;
          const finalized = finalizer.finalizeBootstrapActivationConfirm({
            runId: input.runId,
            candidateSnapshotDigest: input.candidateSnapshotDigest,
            ceoSessionId: input.ceoSessionId,
            confirmedAt: this.clock.nowIso(),
          });
          if (!finalized.allowed) return finalized as Decision<{ state: RunState }>;
          // CEO 1792120507 / 1792120860 — the run's execution task is settled here, in this transaction,
          // from the producer's stored create receipt and the activation result the finalizer just
          // wrote; then completeness is read exactly as before. A refusal of either throws, so the
          // activation result and everything else this transaction wrote roll back with it. The GitHub
          // write is not undone: its receipt and WRITTEN application stay for the next CONFIRM.
          const settled = this.settleBootstrapTask(input);
          if (!settled.allowed) throw acpError(settled.reasonCode, settled.message, settled.evidence);
          const completeness = this.tasks.completeness(input.runId);
          if (!completeness.allowed) throw acpError(completeness.reasonCode, completeness.message, completeness.evidence);
        }

        const transition = this.runs.transition(
          input.runId,
          target,
          `CEO ${input.decision}`,
          { candidateSnapshotDigest: input.candidateSnapshotDigest, rationale: input.rationale },
          isBootstrap && input.decision === "CONFIRM"
            ? this.completion.bootstrapActivation
            : undefined,
        );
        // A bootstrap CONFIRM settled its task and wrote its activation result above: a refused
        // transition throws, so neither is left behind without the run's COMPLETED. Any other
        // decision has written nothing yet, and its refusal returns as before.
        if (!transition.allowed && isBootstrap && input.decision === "CONFIRM") {
          throw acpError(transition.reasonCode, transition.message, transition.evidence);
        }
        if (!transition.allowed) return transition as Decision<{ state: RunState }>;

        // CEO 1792120860 (5) — a project-less bootstrap's owner is a driven session, woken only by what
        // is addressed to it, and no other message carries the CEO's reason: the revision goes to it in
        // band, in this transaction, so the decision and its delivery stand or fall together.
        if (input.decision === "FINAL_REVISE") {
          const returned = this.returnBootstrapForRevision(input);
          if (!returned.allowed) throw acpError(returned.reasonCode, returned.message, returned.evidence);
        }

        // #246 B2-b — a CONTRACT_CHANGE CONFIRM is where its one activation grant is issued, in this
        // transaction and after CEO_APPROVED, so a refusal undoes the decision with it. #512 — a
        // NULL-pinned CONTRACT_CHANGE is a first activation, and its grant is the first-activation one.
        let grantDigest: string | null = null;
        let firstActivation = false;
        if (input.decision === "CONFIRM" && isContractChange) {
          const grants = this.#manifestGrants;
          firstActivation = grants?.isFirstActivation(input.runId) ?? false;
          const request = {
            runId: input.runId,
            candidateSnapshotDigest: input.candidateSnapshotDigest,
            ceoSessionId: input.ceoSessionId,
            ...(input.ingress === undefined ? {} : { ingress: input.ingress }),
          };
          const issued: Decision<{ grantDigest: string }> = grants
            ? firstActivation
              ? grants.issueFirst(request)
              : grants.issue(request)
            : deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_MISSING, "manifest activation grants are not configured", { runId: input.runId });
          if (!issued.allowed) throw acpError(issued.reasonCode, issued.message, issued.evidence);
          grantDigest = issued.value.grantDigest;
        }

        // #246 C3 — the application that produced this activation is COMPLETED with the run, in
        // this transaction; a refusal here undoes the run's COMPLETED as well.
        if (input.decision === "CONFIRM" && isBootstrap) {
          const applications = this.#bootstrapApplications;
          const completed = applications
            ? applications.markCompleted(input.runId, input.candidateSnapshotDigest)
            : deny(ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE, "the bootstrap application record is not configured", {
                runId: input.runId,
              });
          if (!completed.allowed) throw acpError(completed.reasonCode, completed.message, completed.evidence);
        }

        this.audit.record({
          kind: "CEO_DECISION",
          runId: input.runId,
          sessionId: input.ceoSessionId,
          evidence: {
            decision: input.decision,
            candidateSnapshotDigest: input.candidateSnapshotDigest,
            rationale: input.rationale,
            // Traceability only; the grant row is what activation reads, never this.
            ...(grantDigest === null ? {} : { manifestActivationGrantDigest: grantDigest }),
            ...(firstActivation ? { manifestActivation: "FIRST" } : {}),
            ...hermesTurnEvidence(input.hermesTurn),
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
   * #246 B2-b, CEO ruling 2 — a CONFIRM of a CONTRACT_CHANGE already confirmed and finalizing does not
   * decide again: it makes the calling live CEO session the consumer of the run's unconsumed grant, so
   * a re-adopted CEO resumes consumption without a new approval. The same CEO-role checks a CONFIRM
   * asks apply; null when the call is not such a re-entry.
   */
  private contractChangeConsumerReentry(input: CeoDecisionInput): Decision<{ state: RunState }> | null {
    if (input.decision !== "CONFIRM") return null;
    const run = this.runs.get(input.runId);
    if (
      run?.kind !== RunKind.CONTRACT_CHANGE ||
      (run.state !== RunState.CEO_APPROVED && run.state !== RunState.MERGING && run.state !== RunState.POST_MERGE_VERIFYING)
    ) {
      return null;
    }
    const continuity = this.assertCompletionAllowed(input.runId);
    if (!continuity.allowed) return continuity as Decision<{ state: RunState }>;
    const holds = this.assertCurrentCeo(input.ceoSessionId);
    if (!holds.allowed) return holds as Decision<{ state: RunState }>;
    const independence = this.bindings.assertFinalCeoIndependence(input.runId, input.ceoSessionId);
    if (!independence.allowed) return independence as Decision<{ state: RunState }>;
    const grants = this.#manifestGrants;
    if (!grants) {
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_MISSING, "manifest activation grants are not configured", { runId: input.runId });
    }
    return this.db.txDecision(() => {
      const bound = grants.bindConsumer({
        runId: input.runId,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        ceoSessionId: input.ceoSessionId,
        ...(input.ingress === undefined ? {} : { ingress: input.ingress }),
      });
      if (!bound.allowed) return bound as Decision<{ state: RunState }>;
      this.audit.record({
        kind: "MANIFEST_ACTIVATION_CONSUMER_BOUND",
        runId: input.runId,
        sessionId: input.ceoSessionId,
        evidence: {
          candidateSnapshotDigest: input.candidateSnapshotDigest,
          grantId: bound.value.grantId,
          consumer: bound.value.consumer,
          rationale: input.rationale,
          ...hermesTurnEvidence(input.hermesTurn),
        },
      });
      return allow(ReasonCode.OK, { state: run.state });
    });
  }

  /**
   * The checks a CEO decision passes before it changes anything. Read-only, so a caller with
   * asynchronous work to do ahead of the decision can ask first: a PROJECT_BOOTSTRAP CONFIRM
   * runs Repo Factory's GitHub writes before `submitCeoDecision` (issue #246), and a decision
   * this refuses — a session that is not the CEO, a stale continuity mode — must not set them off.
   * `submitCeoDecision` asks the same question again, so passing here admits nothing by itself.
   */
  assertCeoDecisionAdmissible(input: CeoDecisionInput): Decision<void> {
    const admitted = this.admitCeoDecision(input, "apply");
    return admitted.allowed ? allow(ReasonCode.OK, undefined) : (admitted as Decision<void>);
  }

  /**
   * `stage` is where the question is asked. A bootstrap CONFIRM is asked twice: before its
   * application runs (`apply` — the CONFIRM door and the Repo Factory runner, which perform the
   * writes before the decision), and again by the decision itself (`decide`), which completes the
   * run only on the WRITTEN application of the candidate it names (#246 C3).
   */
  /**
   * What review entry asks of the run's tasks (CEO 1792120507 / 1792120860), the same question
   * `CandidatePipeline` asks: a project-less PROJECT_BOOTSTRAP run that joins no repository is asked
   * `TaskGraph.bootstrapReviewEntry` against its current PLAN, validated by `currentBootstrapPlan`;
   * every other run keeps `completeness` exactly.
   */
  private reviewEntry(run: RunRow): Decision<unknown> {
    if (!isProjectlessBootstrap(run) || this.runs.repositoriesOf(run.runId).length > 0) return this.tasks.completeness(run.runId);
    const current = currentBootstrapPlan(run.runId, this.artifacts.latest<unknown>(run.runId, ArtifactKind.PLAN));
    if (!current.allowed) return current;
    return this.tasks.bootstrapReviewEntry(run.runId, current.value.binding.planDigest);
  }

  /**
   * The CONFIRM transaction's settlement of a project-less bootstrap's one task: the run's current
   * PLAN and its repository-create operation, the task review entry answers for that PLAN, the
   * confirmed candidate, and the stored producer result and activation result, all handed to
   * `TaskGraph.settleBootstrapExecutionTask`, which checks every binding again. Any other run settles
   * nothing here.
   */
  private settleBootstrapTask(input: CeoDecisionInput): Decision<unknown> {
    const run = this.runs.get(input.runId);
    if (!run || !isProjectlessBootstrap(run)) return allow(ReasonCode.OK, undefined);
    const current = currentBootstrapPlan(input.runId, this.artifacts.latest<unknown>(input.runId, ArtifactKind.PLAN));
    if (!current.allowed) return current;
    const entry = this.tasks.bootstrapReviewEntry(input.runId, current.value.binding.planDigest);
    if (!entry.allowed) return entry;
    return this.tasks.settleBootstrapExecutionTask({
      runId: input.runId,
      taskId: entry.value.taskId,
      planDigest: current.value.binding.planDigest,
      operationId: current.value.outputs.githubOperations[0]?.operationId ?? "",
      candidateSnapshotDigest: input.candidateSnapshotDigest,
      repoFactoryResultDigest: this.artifacts.latest(input.runId, ArtifactKind.REPO_FACTORY_RESULT)?.digest ?? "",
      activationResultDigest: this.artifacts.latest(input.runId, ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT)?.digest ?? "",
    });
  }

  /**
   * CEO 1792120860 (5) — a FINAL_REVISE of a project-less bootstrap sends the run's owner a
   * REVISION_REQUEST carrying the CEO's rationale, as a review verdict's revision does
   * (`CandidatePipeline.returnToCto`). The run stays REVISION_REQUIRED until the CEO dispatches it
   * again; the owner plans anew from the reason meanwhile. Any other run is unchanged.
   */
  private returnBootstrapForRevision(input: CeoDecisionInput): Decision<unknown> {
    const run = this.runs.get(input.runId);
    if (!run || !isProjectlessBootstrap(run) || !run.ownerRoleKey) return allow(ReasonCode.OK, undefined);
    const binding = this.bindings.active(run.ownerRoleKey);
    if (!binding) return allow(ReasonCode.OK, undefined);
    // PR #1114 BOOT-03 — one delivery per revision cycle: the FINAL_REVISE transition above counted this
    // cycle (`revisionCount`, the cycle a redispatch keys its RUN_DISPATCH by), and a later FINAL_REVISE
    // of the same candidate is a new cycle with its own rationale.
    return this.outbox.enqueue({
      idempotencyKey: `ceo-final-revise:${input.runId}:r${run.revisionCount}:${input.candidateSnapshotDigest}`,
      roleKey: binding.roleKey,
      bindingGeneration: binding.bindingGeneration,
      targetSessionId: binding.sessionId,
      runId: input.runId,
      kind: MessageKind.REVISION_REQUEST,
      payload: {
        runId: input.runId,
        stage: "ceo-final-revise",
        decision: "FINAL_REVISE",
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        rationale: input.rationale,
      },
    });
  }

  private admitCeoDecision(input: CeoDecisionInput, stage: "apply" | "decide"): Decision<{ isBootstrap: boolean }> {
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
      if (!continuity.allowed) return continuity as Decision<{ isBootstrap: boolean }>;
    }

    // The decision is an exercise of the CEO role, so the session must currently hold it.
    // Independence alone would let any unknown id decide (CP-HI-07).
    const holds = this.assertCurrentCeo(input.ceoSessionId);
    if (!holds.allowed) return holds as Decision<{ isBootstrap: boolean }>;

    // CP-HI-04 second clause — the deciding CEO session cannot also be this run's CTO
    // or blind reviewer.
    const independence = this.bindings.assertFinalCeoIndependence(input.runId, input.ceoSessionId);
    if (!independence.allowed) return independence as Decision<{ isBootstrap: boolean }>;

    // Issue #246 PR-C slice C3 — a bootstrap CONFIRM sets off the Repo Factory GitHub writes, and
    // only the runner's full path performs them: the pre-write checks, the reservation, an attempt
    // recorded before every external write, WRITTEN with the result, then activation. The decision
    // itself completes the run only on the WRITTEN application of the candidate it names, so a
    // CONFIRM that skipped that path completes nothing.
    if (isBootstrap && input.decision === "CONFIRM" && stage === "decide") {
      const application = this.#bootstrapApplications?.get(input.runId) ?? null;
      if (application?.phase !== "WRITTEN" || application.candidateSnapshotDigest !== input.candidateSnapshotDigest) {
        return deny(
          ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE,
          "a PROJECT_BOOTSTRAP confirmation completes only on its WRITTEN application record, which the Repo Factory runner writes",
          {
            runId: input.runId,
            decision: input.decision,
            candidateSnapshotDigest: input.candidateSnapshotDigest,
            applicationPhase: application?.phase ?? null,
            applicationCandidate: application?.candidateSnapshotDigest ?? null,
          },
        );
      }
      // Review 1076-R1-02 — the WRITTEN phase is a row; the chain behind it is what completes the run,
      // the same chain the runner requires: the anchored approval and the result the ledger attributes.
      const chain = this.#bootstrapCompletionChain;
      const verified = chain
        ? chain.verifyCompletionChain(input.runId, input.candidateSnapshotDigest)
        : deny(ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE, "the bootstrap completion chain verifier is not configured", {
            runId: input.runId,
          });
      if (!verified.allowed) return verified as Decision<{ isBootstrap: boolean }>;
    }
    // CEO 1792120860 — a project-less bootstrap CONFIRM settles the run's one task from the create
    // receipt. Whether that task can be settled is asked here too, at both stages, so a run that
    // could not complete is refused before the runner's GitHub write rather than after it.
    if (isBootstrap && input.decision === "CONFIRM" && isProjectlessBootstrap(run)) {
      const settleable = this.reviewEntry(run);
      if (!settleable.allowed) return settleable as Decision<{ isBootstrap: boolean }>;
    }
    // #246 C3 — the contract freeze: once an external write of the application may have happened,
    // the run cannot be sent back for another plan.
    if (isBootstrap && input.decision === "FINAL_REVISE") {
      const frozen = this.#bootstrapApplications?.assertNotFrozen(input.runId, "FINAL_REVISE");
      if (frozen !== undefined && !frozen.allowed) return frozen as Decision<{ isBootstrap: boolean }>;
    }

    // #246 B2-b — a CONTRACT_CHANGE CONFIRM issues the run's activation grant, so it is admitted only
    // while its base is still the active manifest (CEO ruling 1), no other CONTRACT_CHANGE of the
    // project is confirmed and finalizing, and the candidate still binds its PLAN and its packet.
    if (run.kind === RunKind.CONTRACT_CHANGE && input.decision === "CONFIRM") {
      const grants = this.#manifestGrants;
      const admissible = grants
        ? grants.admitConfirm(input.runId, input.candidateSnapshotDigest, {
            ceoSessionId: input.ceoSessionId,
            ...(input.ingress === undefined ? {} : { ingress: input.ingress }),
          })
        : deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_MISSING, "manifest activation grants are not configured", { runId: input.runId });
      if (!admissible.allowed) return admissible as Decision<{ isBootstrap: boolean }>;
    }

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
    return allow(ReasonCode.OK, { isBootstrap });
  }

  /**
   * Re-read the durable confirmation that authorized an irreversible finalization. State is
   * necessary but deliberately not sufficient here: the generic run transition primitive is
   * used by several internal recovery paths, whereas only `submitCeoDecision(CONFIRM)` may
   * release the daemon's GitHub sequence for this exact candidate.
   */
  currentCeoConfirmation(runId: string, candidateSnapshotDigest: string): Decision<void> {
    const run = this.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (
      run.state !== RunState.CEO_APPROVED &&
      run.state !== RunState.MERGING &&
      run.state !== RunState.POST_MERGE_VERIFYING
    ) {
      return deny(ReasonCode.GATE_AUTHORITY_DENIED, "run is not in a CEO-finalization state", {
        runId,
        state: run.state,
      });
    }
    if (this.runs.currentCandidate(runId) !== candidateSnapshotDigest) {
      return deny(ReasonCode.EVIDENCE_STALE, "CEO confirmation no longer names the current candidate", {
        runId,
        candidateSnapshotDigest,
        currentCandidateSnapshotDigest: this.runs.currentCandidate(runId),
      });
    }
    const confirmed = this.audit
      .forRun(runId)
      .slice()
      .reverse()
      .find((entry) =>
        entry.kind === "CEO_DECISION" &&
        entry.evidence.decision === "CONFIRM" &&
        entry.evidence.candidateSnapshotDigest === candidateSnapshotDigest,
      );
    if (!confirmed) {
      return deny(ReasonCode.GATE_AUTHORITY_DENIED, "run has no durable CEO confirmation for this candidate", {
        runId,
        candidateSnapshotDigest,
      });
    }
    return allow(ReasonCode.OK, undefined, {
      runId,
      candidateSnapshotDigest,
      ceoSessionId: confirmed.sessionId,
      confirmedAt: confirmed.at,
    });
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
            // A read of a participant checkout cannot be allowed to hold the gate open. An index
            // lock another process holds has no deadline of its own (#859).
            timeout: 30_000,
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

  /**
   * Issue #246 PR-C slice C2 — the BOOTSTRAP_PLAN review a bootstrap candidate's packet summarizes:
   * written by the review gate for this candidate, by an independent reviewer that held the binding,
   * a PASS with nothing omitted and no blocker, of exactly the PLAN binding the candidate names.
   */
  private bootstrapPlanReview(
    runId: string,
    candidateSnapshotDigest: string,
    binding: { planDigest: string; projectManifestDigest: string; plannedOutputsDigest: string },
  ): Decision<ProductionReadyPacket["blindReview"]> {
    // Review round 1 (RF-REVIEW-02) — the candidate's PLAN must still be the run's. A review of the
    // PLAN the candidate names is not a review of a PLAN that replaced it; comparing the review with
    // the frozen candidate alone cannot tell, since both still name the replaced one.
    const planArtifact = this.artifacts.latest<unknown>(runId, ArtifactKind.PLAN);
    const current = currentBootstrapPlan(runId, planArtifact);
    const currentBinding = current.allowed ? current.value.binding : null;
    if (!sameBootstrapPlanBinding(currentBinding, binding) || planArtifact === null) {
      return deny(ReasonCode.EVIDENCE_STALE, "the candidate names a PLAN, manifest or planned outputs that are not the run's current ones", {
        runId,
        candidateSnapshotDigest,
        candidate: binding,
        current: currentBinding,
      });
    }
    const reviewArtifact = this.artifacts.latestForSnapshot<ReviewPacket>(
      runId,
      ArtifactKind.BLIND_REVIEW,
      candidateSnapshotDigest,
    );
    if (!reviewArtifact || reviewArtifact.producedBy !== "blind-review-gate") {
      return deny(ReasonCode.REVIEW_REQUIRED, "no bootstrap plan review by the review gate for this candidate", {
        runId,
        candidateSnapshotDigest,
        producedBy: reviewArtifact?.producedBy ?? null,
      });
    }
    const review = reviewArtifact.content;
    const provenance = this.reviewerProvenance(runId, review);
    if (!provenance.allowed) return provenance as Decision<ProductionReadyPacket["blindReview"]>;
    const reviewed = review.bootstrapPlan;
    if (
      !reviewed ||
      reviewed.planDigest !== binding.planDigest ||
      reviewed.projectManifestDigest !== binding.projectManifestDigest ||
      reviewed.plannedOutputsDigest !== binding.plannedOutputsDigest
    ) {
      return deny(ReasonCode.REVIEW_REQUIRED, "the bootstrap plan review is not of the PLAN this candidate names", {
        runId,
        candidateSnapshotDigest,
        reviewed: reviewed ?? null,
        candidate: binding,
      });
    }
    // The reviewer was shown the PLAN's intent, its one task's included, which no binding digest
    // covers: the same PLAN submitted again with another task leaves the review stale.
    const intent = bootstrapReviewIntentCurrent({
      runId,
      reviewedIntentDigest: review.bootstrapPlanIntentDigest,
      planArtifact,
      tasks: bootstrapPlanIntentTasks(this.db, runId),
    });
    if (!intent.allowed) return deny(intent.reasonCode, intent.message, { candidateSnapshotDigest, ...intent.evidence });
    if (review.verdict !== "PASS") {
      return deny(ReasonCode.REVIEW_REQUIRED, "blind review has not passed", { verdict: review.verdict });
    }
    if (review.omittedItems.length > 0) {
      return deny(ReasonCode.COVERAGE_INCOMPLETE, "blind review reports omitted items", {
        omittedItems: review.omittedItems,
      });
    }
    const blockers = review.findings.filter((finding) => finding.severity === "BLOCKER");
    if (blockers.length > 0) {
      return deny(ReasonCode.REVIEW_BLOCK, "candidate has unresolved blocker findings", {
        blockers: blockers.map((blocker) => blocker.summary),
      });
    }
    return allow(ReasonCode.OK, {
      verdict: review.verdict,
      digest: reviewArtifact.digest,
      provider: review.provider,
      model: review.model,
      coveredFiles: review.coveredFiles.length,
      omittedItems: review.omittedItems.length,
      findings: review.findings.length,
    });
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
  /**
   * `requireLiveAdmission` separates two different questions that share this shape check.
   *
   * Recording a decision must prove the receipt is admitted *now* — that is the moment the
   * owner's authority is being exercised. Re-reading a retained artifact must not: admission
   * happened when the decision was consumed, and `assertApproval` answers from
   * `inbound_messages`, a 24h replay cache. Asking it again later makes an approved run
   * become unapproved when the cache is pruned, which is the P1-18 defect.
   */
  private assertOwnerDecisionReceipt(input: {
    runId: string;
    item: string;
    approved: boolean;
    note: string;
    receipt?: unknown;
    owner?: { channel: string; actor: string };
    requireLiveAdmission?: boolean;
  }): Decision<OwnerApprovalReceipt> {
    const authority = this.#ownerAuthority;
    if (!authority) {
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "no owner authority is configured, so an owner decision cannot be attributed",
        { runId: input.runId },
      );
    }

    const receipt = input.receipt;
    if (!isOwnerApprovalReceipt(receipt)) {
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
    if (input.requireLiveAdmission !== false) {
      const authorised = authority.assertApproval(receipt);
      if (!authorised.allowed) return authorised as Decision<OwnerApprovalReceipt>;
    }
    return allow(ReasonCode.OK, receipt);
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
    // Preserve the established authority-first denial ordering: an invalid or non-owner
    // receipt is refused before candidate freshness is even considered. The same receipt is
    // re-checked by consumeApproval inside the candidate transaction below.
    const admittedReceipt = this.assertOwnerDecisionReceipt(input);
    if (!admittedReceipt.allowed) return admittedReceipt as Decision<void>;
    const receipt = admittedReceipt.value;
    const run = this.runs.get(input.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: input.runId });

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

        // Validate and consume while the same write transaction holds the current candidate
        // stable. This is the receipt's candidate binding: a later revision cannot inherit an
        // approval first consumed for the previous snapshot.
        const consumed = this.#ownerAuthority!.consumeApproval(receipt, candidateSnapshotDigest);
        if (!consumed.allowed) return consumed;

        const actor = `${receipt.channel}:${receipt.actor}`;
        const gate = this.humanGateDefinition(input.runId);
        this.artifacts.put(input.runId, ArtifactKind.APPROVAL, {
          kind: "OWNER_DECISION",
          item: input.item,
          approved: input.approved,
          note: input.note,
          at: this.clock.nowIso(),
          humanGateDigest: gate.digest,
          candidateSnapshotDigest,
          // The receipt is part of the durable decision, not a one-time ingress check. A
          // later consumer must be able to re-admit the exact operation and parameters.
          receipt,
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
          idempotencyKey: `owner-decision-resume:${input.runId}:${candidateSnapshotDigest}:${gate.digest}`,
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
    // An approval row is only evidence of owner authority while its retained ingress receipt
    // can still be admitted. In particular, never let a direct ArtifactStore write turn an
    // APPROVAL-shaped object into an owner decision (CP-HI-07).
    if (!this.#ownerAuthority) return { required: true, items, satisfied: false };
    const latestDecision = new Map<string, boolean>();
    for (const artifact of this.artifacts.list<{
      kind?: string;
      item?: string;
      approved?: boolean;
      note?: unknown;
      humanGateDigest?: string;
      candidateSnapshotDigest?: string | null;
      receipt?: unknown;
    }>(runId, ArtifactKind.APPROVAL)) {
      const decision = artifact.content;
      if (
        artifact.superseded ||
        decision.kind !== "OWNER_DECISION" ||
        typeof decision.item !== "string" ||
        decision.item.length === 0 ||
        typeof decision.approved !== "boolean" ||
        typeof decision.note !== "string" ||
        decision.humanGateDigest !== gate.digest ||
        artifact.candidateSnapshotDigest !== currentCandidate ||
        decision.candidateSnapshotDigest !== currentCandidate
      ) {
        continue;
      }
      const retainedReceipt = this.assertOwnerDecisionReceipt({
        runId,
        item: decision.item,
        approved: decision.approved,
        note: decision.note,
        receipt: decision.receipt,
        // Retained read: authority comes from the consumption record below, not from a
        // replay cache that has since been pruned.
        requireLiveAdmission: false,
      });
      if (!retainedReceipt.allowed) continue;
      const candidateBinding = this.#ownerAuthority.assertConsumedApproval(
        retainedReceipt.value,
        currentCandidate,
      );
      if (!candidateBinding.allowed) continue;
      // ArtifactStore.list is durable creation order (then rowid), so assignment makes
      // a later explicit rejection revoke an earlier approval for the same gate item.
      latestDecision.set(decision.item, decision.approved);
    }

    return { required: true, items, satisfied: items.every((item) => latestDecision.get(item) === true) };
  }

  /**
   * The GitHub gate names an actual authenticated owner-decision artifact, not merely the
   * human-gate definition. Keep the selection beside `humanGateStatus` so the daemon never
   * turns a free-form digest into owner authority; the kernel independently re-validates it
   * when it publishes and again when it merges.
   */
  currentHumanGateDecisionDigest(runId: string): Decision<string> {
    const gate = this.humanGateDefinition(runId);
    if (!gate.required) return allow(ReasonCode.OK, digestOf({ humanGate: "NOT_REQUIRED" }));
    if (gate.items.length === 0) {
      return deny(ReasonCode.HUMAN_GATE_UNSATISFIED, "run requires a human gate with no durable gate items", {
        runId,
      });
    }
    const candidateSnapshotDigest = this.runs.currentCandidate(runId);
    if (!candidateSnapshotDigest || !this.#ownerAuthority) {
      return deny(ReasonCode.HUMAN_GATE_UNSATISFIED, "no current authenticated owner decision exists", {
        runId,
      });
    }

    const latest = new Map<string, { approved: boolean; digest: string }>();
    for (const artifact of this.artifacts.list<{
      kind?: string;
      item?: string;
      approved?: boolean;
      note?: unknown;
      humanGateDigest?: string;
      candidateSnapshotDigest?: string | null;
      receipt?: unknown;
    }>(runId, ArtifactKind.APPROVAL)) {
      const decision = artifact.content;
      if (
        artifact.superseded ||
        decision.kind !== "OWNER_DECISION" ||
        typeof decision.item !== "string" ||
        !gate.items.includes(decision.item) ||
        typeof decision.approved !== "boolean" ||
        typeof decision.note !== "string" ||
        decision.humanGateDigest !== gate.digest ||
        artifact.candidateSnapshotDigest !== candidateSnapshotDigest ||
        decision.candidateSnapshotDigest !== candidateSnapshotDigest
      ) {
        continue;
      }
      const retainedReceipt = this.assertOwnerDecisionReceipt({
        runId,
        item: decision.item,
        approved: decision.approved,
        note: decision.note,
        receipt: decision.receipt,
        // Retained read: authority comes from the consumption record below, not from a
        // replay cache that has since been pruned.
        requireLiveAdmission: false,
      });
      if (retainedReceipt.allowed && this.#ownerAuthority.assertConsumedApproval(
        retainedReceipt.value,
        candidateSnapshotDigest,
      ).allowed) {
        latest.set(decision.item, { approved: decision.approved, digest: artifact.digest });
      }
    }
    if (!gate.items.every((item) => latest.get(item)?.approved === true)) {
      return deny(ReasonCode.HUMAN_GATE_UNSATISFIED, "every current owner-gate item needs approval", {
        runId,
        items: gate.items,
      });
    }
    const named = gate.items.map((item) => latest.get(item)!.digest).sort()[0]!;
    return allow(ReasonCode.OK, named);
  }

  /**
   * §20 — a CTO escalation. Non-blocking escalations leave the run ACTIVE so other work
   * continues; only a blocked critical path moves the run to BLOCKED. The escalation's identity is
   * its CTO_ESCALATION audit event, which the CEO's notification names as `escalationId`.
   *
   * One transaction: the CTO_ESCALATION record, the CEO's notification and the BLOCKED transition
   * commit together or not at all. A refused opening — a second blocking escalation while the run
   * is already BLOCKED, or no CEO to notify — leaves no record and no notification behind, so it can
   * never become the run's current escalation in place of the one that blocked it.
   */
  openEscalation(escalation: Escalation): Decision<{ state: RunState; escalationId: number | null }> {
    return this.db.txDecision(() => {
      const run = this.runs.get(escalation.runId);
      if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: escalation.runId });

      const recorded = this.audit.record({
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
      const escalationId = recorded.allowed ? recorded.value : null;

      const notified = this.notify(NotificationKind.TRUE_ESCALATION, escalation.runId, {
        ...(escalationId === null ? {} : { escalationId }),
        question: escalation.question,
        options: escalation.options,
        recommendation: escalation.ctoRecommendation,
        whyItMatters: escalation.whyItMatters,
        blocksCriticalPath: escalation.blocksCriticalPath,
      });
      if (!notified.allowed) return notified as Decision<{ state: RunState; escalationId: number | null }>;

      if (!escalation.blocksCriticalPath) return allow(ReasonCode.OK, { state: run.state, escalationId });

      const transition = this.runs.transition(
        escalation.runId,
        RunState.BLOCKED,
        "CEO_DECISION_REQUIRED",
        { question: escalation.question },
      );
      if (!transition.allowed) return transition as Decision<{ state: RunState; escalationId: number | null }>;
      return allow(ReasonCode.OK, { state: RunState.BLOCKED, escalationId });
    });
  }

  /**
   * The run's current open escalation: its latest blocking CTO_ESCALATION, unless a CEO escalation
   * decision was recorded after it. Only an escalation that blocked the critical path counts: a
   * non-blocking one never moved the run, so it neither shadows the one that did nor is resolved
   * through this door. Every CTO_ESCALATION row is an admitted opening (`openEscalation` rolls a
   * refused one back), and `audit_events` is append only, so this is the whole escalation record.
   */
  openEscalationOf(runId: string): { escalationId: number } | null {
    const opened = this.db.get<{ event_id: number }>(
      `SELECT event_id FROM audit_events WHERE run_id = ? AND kind = 'CTO_ESCALATION'
         AND json_extract(evidence_json, '$.blocksCriticalPath') = 1 ORDER BY event_id DESC LIMIT 1`,
      [runId],
    );
    if (!opened) return null;
    const answered = this.db.get<{ event_id: number }>(
      `SELECT event_id FROM audit_events WHERE run_id = ? AND kind = 'CEO_DECISION' AND event_id > ?
         AND json_extract(evidence_json, '$.escalation') = 1 LIMIT 1`,
      [runId, opened.event_id],
    );
    return answered ? null : { escalationId: opened.event_id };
  }

  /**
   * The committed answer to an `escalation_resolve` request, read from the CEO_DECISION that recorded
   * its idempotency key: the same request is answered with that decision's result, and the same key
   * naming anything else is refused. `null` when no decision carries the key. Read only; the door
   * consults it when its own mutation reservation has no stored result to answer with.
   */
  escalationResolutionReplay(
    idempotencyKey: string,
    request: { runId: string; escalationId: number; resolution: string },
    byCeoSession: string,
  ): Decision<EscalationResolution> | null {
    if (!this.assertCurrentCeo(byCeoSession).allowed) return null;
    return this.#replayEscalationResolution(
      escalationKeyDigestOf(idempotencyKey),
      escalationRequestDigestOf(request.runId, request.escalationId, request.resolution),
    );
  }

  #replayEscalationResolution(keyDigest: string, requestDigest: string): Decision<EscalationResolution> | null {
    const prior = this.db.get<{ run_id: string; evidence_json: string }>(
      `SELECT run_id, evidence_json FROM audit_events WHERE kind = 'CEO_DECISION'
         AND json_extract(evidence_json, '$.idempotencyKeyDigest') = ? ORDER BY event_id LIMIT 1`,
      [keyDigest],
    );
    if (!prior) return null;
    const recorded = JSON.parse(prior.evidence_json) as { requestDigest?: unknown; escalationId?: unknown; messageId?: unknown };
    if (recorded.requestDigest !== requestDigest) {
      return deny(ReasonCode.CONFLICT, "this idempotencyKey already names a different request", { requestDigest });
    }
    return allow(ReasonCode.OK, {
      runId: prior.run_id,
      state: RunState.ACTIVE,
      escalationId: typeof recorded.escalationId === "number" ? recorded.escalationId : null,
      messageId: typeof recorded.messageId === "string" ? recorded.messageId : null,
    });
  }

  /** Why the door refuses to resolve `escalationId` on this run now, or `null` when it may. */
  #escalationTargetRefusal(run: RunRow, escalationId: number): Decision<EscalationResolution> | null {
    const resolved = this.db.get<{ event_id: number }>(
      `SELECT event_id FROM audit_events WHERE run_id = ? AND kind = 'CEO_DECISION'
         AND json_extract(evidence_json, '$.escalation') = 1 AND json_extract(evidence_json, '$.escalationId') = ? LIMIT 1`,
      [run.runId, escalationId],
    );
    if (resolved) {
      return deny(ReasonCode.CONFLICT, `escalation ${escalationId} is already resolved`, {
        runId: run.runId,
        escalationId,
        resolved: true,
      });
    }
    const open = this.openEscalationOf(run.runId);
    if (open?.escalationId !== escalationId) {
      return deny(ReasonCode.CONFLICT, "the escalation named is not this run's current open escalation", {
        runId: run.runId,
        escalationId,
        currentEscalationId: open?.escalationId ?? null,
      });
    }
    if (run.state !== RunState.BLOCKED || run.stateReason !== "CEO_DECISION_REQUIRED") {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${run.state}`, {
        runId: run.runId,
        state: run.state,
        reason: run.stateReason,
      });
    }
    return null;
  }

  /**
   * The CEO's answer to a CTO escalation, in one transaction: BLOCKED → ACTIVE, the owner's
   * ESCALATION_REPLY and the CEO_DECISION record commit together or not at all. The reply carries the
   * resolution text, bounded; the audit row carries only its digest and length, the reply's message
   * id and the run's project.
   *
   * `target` is the CEO door's binding (`escalation_resolve`): it resolves only the escalation it
   * names, and only while that is the run's current open escalation and the run is BLOCKED with
   * CEO_DECISION_REQUIRED, and it refuses rather than resolve with no reply enqueued. Without a
   * target, an in-process caller resolves the run's escalation without naming it, as before.
   *
   * The door's `idempotencyKey` is committed with the decision, as a digest beside the request's
   * digest, and is looked up first, before any state is read: the same request answers with the
   * recorded result, with no transition and no enqueue, and the same key naming anything else is
   * refused. So a replay never depends on the MCP layer having stored its response.
   */
  resolveEscalation(
    runId: string,
    resolution: string,
    byCeoSession: string,
    target?: { escalationId: number; idempotencyKey?: string; hermesTurn?: HermesAdmittedTurn },
  ): Decision<EscalationResolution> {
    return this.db.txDecision(() => {
      const run = this.runs.get(runId);
      if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
      const holds = this.assertCurrentCeo(byCeoSession);
      if (!holds.allowed) return holds as Decision<EscalationResolution>;
      if (resolution.trim().length === 0 || resolution.length > ESCALATION_RESOLUTION_MAX_LENGTH) {
        return deny(
          ReasonCode.INVALID_ARGUMENT,
          `an escalation resolution is non-blank text of at most ${ESCALATION_RESOLUTION_MAX_LENGTH} characters`,
          { runId, resolutionLength: resolution.length },
        );
      }
      const request = target?.idempotencyKey === undefined
        ? null
        : {
            idempotencyKeyDigest: escalationKeyDigestOf(target.idempotencyKey),
            requestDigest: escalationRequestDigestOf(runId, target.escalationId, resolution),
          };
      if (request) {
        const replayed = this.#replayEscalationResolution(request.idempotencyKeyDigest, request.requestDigest);
        if (replayed) return replayed;
      }
      if (target) {
        const refused = this.#escalationTargetRefusal(run, target.escalationId);
        if (refused) return refused;
      }
      let state = run.state;
      if (run.state === RunState.BLOCKED) {
        const transition = this.runs.transition(runId, RunState.ACTIVE, "escalation resolved");
        if (!transition.allowed) return transition as Decision<EscalationResolution>;
        state = RunState.ACTIVE;
      }
      const ownerRoleKey = this.runs.ownerRoleKeyFor(run);
      const binding = ownerRoleKey ? this.bindings.active(ownerRoleKey) : null;
      if (!binding && target) {
        return deny(ReasonCode.OUTBOX_TARGET_NOT_CURRENT, "the run has no current owner to receive the resolution", { runId });
      }
      const enqueued = binding
        ? this.outbox.enqueue({
            idempotencyKey: target
              ? `escalation-reply:${runId}:e${target.escalationId}`
              : `escalation-reply:${runId}:${digestOf(resolution)}`,
            roleKey: binding.roleKey,
            bindingGeneration: binding.bindingGeneration,
            targetSessionId: binding.sessionId,
            runId,
            kind: MessageKind.ESCALATION_REPLY,
            payload: target ? { runId, escalationId: target.escalationId, resolution } : { runId, resolution },
          })
        : null;
      if (target && enqueued && !enqueued.allowed) return enqueued as Decision<EscalationResolution>;
      const messageId = enqueued?.allowed ? enqueued.value.messageId : null;
      const recorded = this.audit.record({
        kind: "CEO_DECISION",
        runId,
        projectId: run.projectId,
        sessionId: byCeoSession,
        evidence: {
          escalation: true,
          escalationId: target?.escalationId ?? null,
          resolutionDigest: digestOf(resolution),
          resolutionLength: resolution.length,
          messageId,
          ...(request ?? {}),
          ...hermesTurnEvidence(target?.hermesTurn),
        },
      });
      if (target && !recorded.allowed) return recorded as Decision<EscalationResolution>;
      return allow(ReasonCode.OK, { runId, state, escalationId: target?.escalationId ?? null, messageId });
    });
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

/** Content loaded from an artifact is untrusted JSON until it has this complete receipt shape. */
const isOwnerApprovalReceipt = (value: unknown): value is OwnerApprovalReceipt =>
  isRecord(value) &&
  typeof value.channel === "string" &&
  typeof value.actor === "string" &&
  typeof value.inboundNonce === "string" &&
  (typeof value.runId === "string" || value.runId === null) &&
  (typeof value.candidateSnapshotDigest === "string" || value.candidateSnapshotDigest === null) &&
  typeof value.operation === "string" &&
  typeof value.parameterDigest === "string" &&
  typeof value.idempotencyKey === "string" &&
  typeof value.approved === "boolean";
