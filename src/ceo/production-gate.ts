import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { OwnerAuthorityPort } from "./owner-authority.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import {
  ArtifactKind,
  type CeoDecision,
  ContinuityMode,
  RunState,
  Role,
  roleKeyFor,
} from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { ReviewPacket } from "../review/blind-review.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { TaskGraph } from "../run/task-graph.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { VerificationReport } from "../verify/verification-engine.ts";
import type { ContinuityGate } from "../run/run-engine.ts";

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

/** PRD §19.3 — the only three automatic Hermes notifications. */
export const NotificationKind = {
  READY_FOR_CEO_REVIEW: "READY_FOR_CEO_REVIEW",
  TRUE_ESCALATION: "TRUE_ESCALATION",
  CRITICAL_SYSTEM_FAILURE: "CRITICAL_SYSTEM_FAILURE",
} as const;
export type NotificationKind = (typeof NotificationKind)[keyof typeof NotificationKind];

/** PRD §21 — the owner-only gate list. */
export const HUMAN_GATE_TRIGGERS: readonly string[] = [
  "irreversible production action",
  "destructive data migration or delete",
  "security or permission boundary expansion",
  "public api or protocol breaking change",
  "core product direction change",
  "significant new cost or paid plan change",
  "project decommission",
  "capacity-driven project suspend",
  "quality gate reduction exception",
  "undelegated public release",
];

export class ProductionGate {
  #continuity: ContinuityGate | null = null;
  #ownerAuthority: OwnerAuthorityPort | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    private readonly runs: RunEngine,
    private readonly tasks: TaskGraph,
    private readonly bindings: BindingRegistry,
    private readonly outbox: Outbox,
    private readonly telemetry: Telemetry,
  ) {}

  attach(ports: {
    continuity?: ContinuityGate;
    ownerAuthority?: OwnerAuthorityPort;
  }): void {
    if (ports.continuity) this.#continuity = ports.continuity;
    if (ports.ownerAuthority) this.#ownerAuthority = ports.ownerAuthority;
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
  }): Decision<ProductionReadyPacket> {
    const run = this.runs.get(input.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: input.runId });

    // §15.6 — SURVIVAL forbids completion, and a mode that has not been re-evaluated
    // recently is not evidence that we are not in SURVIVAL.
    if (this.#continuity?.assertCompletionAllowed) {
      const allowed = this.#continuity.assertCompletionAllowed(input.runId);
      if (!allowed.allowed) return allowed as Decision<ProductionReadyPacket>;
    } else if (this.#continuity?.mode() === ContinuityMode.SURVIVAL) {
      return deny(
        ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
        "continuity is in SURVIVAL; production-ready completion is not permitted",
        { runId: input.runId },
      );
    }

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

    // Look the snapshot up by the candidate digest it is bound to, not by the artifact
    // content digest — the two differ because the candidate digest deliberately
    // excludes `createdAt` so re-freezing identical content is stable.
    const snapshotArtifact = this.artifacts.latestForSnapshot<{
      repositories: Array<Record<string, unknown>>;
    }>(input.runId, ArtifactKind.CANDIDATE_SNAPSHOT, input.candidateSnapshotDigest);
    const humanGate = this.humanGateStatus(input.runId);

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
      changedRepositories: (snapshotArtifact?.content.repositories ?? []).map((repo) => ({
        identity: String(repo["identity"]),
        baseHead: String(repo["baseHead"]),
        candidateHead: String(repo["candidateHead"]),
        files: Array.isArray(repo["touchedPaths"]) ? repo["touchedPaths"].length : 0,
      })),
      ctoRecommendation: input.approval.recommendation,
      humanGate,
      createdAt: this.clock.nowIso(),
    };

    this.artifacts.put(input.runId, ArtifactKind.APPROVAL, input.approval, input.candidateSnapshotDigest);
    this.artifacts.putEvidence(
      "production-gate",
      input.runId,
      ArtifactKind.PRODUCTION_READY_PACKET,
      packet,
      input.candidateSnapshotDigest,
    );

    const transition = this.runs.transition(
      input.runId,
      RunState.READY_FOR_CEO_REVIEW,
      "production-ready packet assembled",
      { candidateSnapshotDigest: input.candidateSnapshotDigest },
    );
    if (!transition.allowed) return transition as Decision<ProductionReadyPacket>;

    this.notify(NotificationKind.READY_FOR_CEO_REVIEW, input.runId, {
      goal: run.goal,
      candidateSnapshotDigest: input.candidateSnapshotDigest,
      humanGate,
    });

    return allow(ReasonCode.OK, packet);
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

    const packet = this.artifacts.latestForSnapshot<ProductionReadyPacket>(
      input.runId,
      ArtifactKind.PRODUCTION_READY_PACKET,
      input.candidateSnapshotDigest,
    );
    if (!packet) {
      return deny(ReasonCode.EVIDENCE_STALE, "no production-ready packet for this candidate", {
        runId: input.runId,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
      });
    }

    // The decision is an exercise of the CEO role, so the session must currently hold it.
    // Independence alone would let any unknown id decide (CP-HI-07).
    const holds = this.assertCurrentCeo(input.ceoSessionId);
    if (!holds.allowed) return holds as Decision<{ state: RunState }>;

    // CP-HI-04 second clause — the deciding CEO session cannot also be this run's CTO
    // or blind reviewer.
    const independence = this.bindings.assertFinalCeoIndependence(input.runId, input.ceoSessionId);
    if (!independence.allowed) return independence as Decision<{ state: RunState }>;

    if (input.decision === "CONFIRM" && packet.content.humanGate.required && !packet.content.humanGate.satisfied) {
      return deny(
        ReasonCode.HUMAN_GATE_UNSATISFIED,
        "candidate requires owner approval that has not been recorded",
        { runId: input.runId, items: packet.content.humanGate.items },
      );
    }

    const target =
      input.decision === "CONFIRM"
        ? RunState.COMPLETED
        : input.decision === "FINAL_REVISE"
          ? RunState.REVISION_REQUIRED
          : RunState.AWAITING_HUMAN;

    const transition = this.runs.transition(input.runId, target, `CEO ${input.decision}`, {
      candidateSnapshotDigest: input.candidateSnapshotDigest,
      rationale: input.rationale,
    });
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
    const rows = this.db.all<{ command_id: string; source: string; status: string }>(
      `SELECT command_id, source, status FROM verification_results
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
    const reported = new Set(report.results.map((r) => `${r.commandId}:${r.source}`));
    const observed = new Set(rows.map((r) => `${r.command_id}:${r.source}`));
    const missing = [...reported].filter((k) => !observed.has(k));
    if (missing.length > 0 || rows.length < report.expectedInputs) {
      return deny(ReasonCode.VERIFICATION_INCOMPLETE, "verification report is not fully corroborated", {
        runId,
        missing,
        rows: rows.length,
        expectedInputs: report.expectedInputs,
      });
    }
    return allow(ReasonCode.OK, undefined);
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

  /**
   * §21 — an owner decision recorded against a specific run and gate item.
   *
   * The owner is an identity the deployment allowlisted, verified here. Without that,
   * "the owner approved" would be a claim any caller could make, and a human gate would
   * be satisfiable by the very candidate it exists to gate.
   */
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

  recordOwnerDecision(input: {
    runId: string;
    item: string;
    approved: boolean;
    note: string;
    owner: { channel: string; actor: string };
  }): Decision<void> {
    const authorised = this.#ownerAuthority?.isAllowedActor(input.owner.channel, input.owner.actor);
    if (!authorised) {
      return deny(
        ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
        this.#ownerAuthority
          ? "actor is not an allowlisted owner identity"
          : "no owner authority is configured, so an owner decision cannot be attributed",
        { runId: input.runId, channel: input.owner.channel, actor: input.owner.actor },
      );
    }

    this.artifacts.put(input.runId, ArtifactKind.APPROVAL, {
      kind: "OWNER_DECISION",
      item: input.item,
      approved: input.approved,
      note: input.note,
      at: this.clock.nowIso(),
    });
    this.audit.record({
      kind: "OWNER_DECISION",
      runId: input.runId,
      actor: `${input.owner.channel}:${input.owner.actor}`,
      evidence: { item: input.item, approved: input.approved },
    });
    return allow(ReasonCode.OK, undefined);
  }

  humanGateStatus(runId: string): { required: boolean; items: string[]; satisfied: boolean } {
    const contract = this.artifacts.latest<{ humanGate: string[] }>(
      runId,
      ArtifactKind.TASK_CONTRACT,
    );
    const items = contract?.content.humanGate ?? [];
    if (items.length === 0) return { required: false, items: [], satisfied: true };

    const approvals = this.artifacts
      .list<{ kind?: string; item?: string; approved?: boolean }>(runId, ArtifactKind.APPROVAL)
      .filter((a) => a.content.kind === "OWNER_DECISION" && a.content.approved === true)
      .map((a) => a.content.item);

    return { required: true, items, satisfied: items.every((item) => approvals.includes(item)) };
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

    this.notify(NotificationKind.TRUE_ESCALATION, escalation.runId, {
      question: escalation.question,
      options: escalation.options,
      recommendation: escalation.ctoRecommendation,
      whyItMatters: escalation.whyItMatters,
      blocksCriticalPath: escalation.blocksCriticalPath,
    });

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
  notify(kind: NotificationKind, runId: string, payload: Record<string, unknown>): void {
    const ceo = this.bindings.active(roleKeyFor(Role.CEO));
    this.audit.record({
      kind: "CEO_NOTIFICATION",
      runId,
      roleKey: ceo?.roleKey ?? "CEO",
      evidence: { notification: kind, ...payload },
    });
    if (!ceo) return;
    this.outbox.enqueue({
      idempotencyKey: `notify:${kind}:${runId}:${digestOf(payload)}`,
      roleKey: ceo.roleKey,
      bindingGeneration: ceo.bindingGeneration,
      targetSessionId: ceo.sessionId,
      runId,
      kind: MessageKind.CEO_NOTIFICATION,
      payload: { notification: kind, runId, ...payload },
    });
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
