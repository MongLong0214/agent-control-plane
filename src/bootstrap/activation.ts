import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type ProjectManifest, manifestDigest } from "../contracts/manifest.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import { ArtifactKind, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import { missingHandoffFields, type CtoLifecycle, type HandoffPackage } from "../cto/cto-lifecycle.ts";
import type { Db } from "../db/database.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { Doctor, DoctorReport } from "../doctor/doctor.ts";
import type { ProductionGate } from "../ceo/production-gate.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import { tryRevParse } from "../git/git.ts";
import type { RepoFactoryResult } from "./repo-factory-result.ts";
import { parseRepoFactoryResult } from "./repo-factory-result.ts";

/** Integration §13.5 — the activation facts only the control plane may state. */
export interface ACPBootstrapActivationResult {
  schema: "agent-control-plane.bootstrap-activation.v1";
  runId: string;
  projectId: string;
  projectRegistration: { registered: boolean; activeManifestDigest: string };
  localBindings: Array<{ identity: string; checkoutPath: string; repositoryRole: string }>;
  blindReview: { verdict: string; digest: string } | null;
  ceoConfirm: { decision: string; at: string } | null;
  primaryCtoBinding: { roleKey: string; sessionId: string; bindingGeneration: number; promotedFromBootstrap: boolean } | null;
  buzz: { connected: boolean; address: string | null };
  handoffAck: { handoffId: string; ackedAt: string } | null;
  doctor: { status: DoctorReport["status"]; findings: number };
  activity: "ACTIVE" | "INACTIVE";
  availability: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  completedAt: string;
}

export interface ActivationInput {
  runId: string;
  factoryResult: unknown;
  /** The approved manifest whose digest the factory result must match. */
  approvedManifest: ProjectManifest;
  /** Local checkout paths the owner (or the factory's proposal) supplies. */
  localBindings: ReadonlyArray<{ identity: string; checkoutPath: string; repositoryRole: string }>;
  projectName: string;
  handoff: HandoffPackage;
}

export interface BootstrapConfirmationInput {
  runId: string;
  candidateSnapshotDigest: string;
  ceoSessionId: string;
  confirmedAt: string;
}

interface ApprovedBootstrapPlan {
  bootstrapOperationId: string;
  requestDigest: string;
  projectManifestDigest: string;
  githubOperations: ReadonlyArray<{
    operationId: string;
    resourceType: string;
    resourceIdentity: string;
  }>;
}

/**
 * PRD §26 / Integration §7 Phase J.
 *
 * This is the control plane's half of the bootstrap contract and nothing more. Plan
 * compilation, template rendering and GitHub provisioning stay in Repo Factory; what
 * happens here is validation of the result, activation of the contract, and the
 * activation facts that only this runtime may assert.
 */
export class BootstrapActivation {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    private readonly projects: ProjectRegistry,
    private readonly repositories: RepositoryRegistry,
    private readonly runs: RunEngine,
    private readonly bindings: BindingRegistry,
    private readonly sessions: SessionRegistry,
    private readonly cto: CtoLifecycle,
    private readonly doctor: Doctor,
    private readonly ceo: ProductionGate,
    private readonly outbox: Outbox,
  ) {}

  /**
   * §26.2 — a bootstrap run binds `BOOTSTRAP_CTO(run)` for technical feasibility and
   * lean review. It is run-scoped, so it cannot silently become the project's authority.
   */
  bindBootstrapCto(runId: string, sessionId: string): Decision<{ roleKey: string; generation: number }> {
    const run = this.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (run.kind !== RunKind.PROJECT_BOOTSTRAP) {
      return deny(ReasonCode.INVALID_ARGUMENT, "bootstrap CTO requires a PROJECT_BOOTSTRAP run", {
        runId,
        kind: run.kind,
      });
    }
    const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
    const bound = this.bindings.bind({
      roleKey,
      role: Role.BOOTSTRAP_CTO,
      sessionId,
      runId,
      projectId: run.projectId,
      mode: "PREFERRED",
    });
    if (!bound.allowed) return bound as Decision<{ roleKey: string; generation: number }>;

    // A bootstrap run has no project, so dispatch admission cannot pin an owner for it.
    // Without this the run has no owner and every CTO surface call fails assertOwner
    // (§26.2), which made the PROJECT_BOOTSTRAP path unusable.
    const pinned = this.runs.reassignOwner(runId, bound.value, "bootstrap CTO bound");
    if (!pinned.allowed) return pinned as Decision<{ roleKey: string; generation: number }>;

    return allow(ReasonCode.OK, { roleKey, generation: bound.value.bindingGeneration });
  }

  /**
   * §26.2 — a bootstrap CTO may be promoted only if its session is healthy and was
   * never used as a blind reviewer for that run. Otherwise a fresh primary CTO is made.
   */
  canPromoteBootstrapCto(runId: string): Decision<string> {
    const bootstrap = this.bindings.active(roleKeyFor(Role.BOOTSTRAP_CTO, { runId }));
    if (!bootstrap) {
      return deny(ReasonCode.NOT_FOUND, "run has no bootstrap CTO binding", { runId });
    }
    const session = this.sessions.get(bootstrap.sessionId);
    if (!session || session.lifecycle !== SessionLifecycle.READY) {
      return deny(
        ReasonCode.BOOTSTRAP_CTO_INELIGIBLE_FOR_PROMOTION,
        "bootstrap CTO session is not healthy",
        { runId, lifecycle: session?.lifecycle ?? "missing" },
      );
    }
    const reviewedThisRun = this.bindings
      .byRun(runId)
      .some((b) => b.role === Role.BLIND_REVIEWER && b.sessionId === bootstrap.sessionId);
    if (reviewedThisRun) {
      return deny(
        ReasonCode.BOOTSTRAP_CTO_INELIGIBLE_FOR_PROMOTION,
        "bootstrap CTO session was used as this run's blind reviewer",
        { runId, sessionId: bootstrap.sessionId },
      );
    }
    return allow(ReasonCode.OK, bootstrap.sessionId);
  }

  /** Integration §7 Phase J, steps 1–11. Only this result completes the run. */
  async activate(input: ActivationInput): Promise<Decision<ACPBootstrapActivationResult>> {
    const run = this.runs.get(input.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: input.runId });
    if (run.kind !== RunKind.PROJECT_BOOTSTRAP) {
      return deny(ReasonCode.INVALID_ARGUMENT, "activation requires a PROJECT_BOOTSTRAP run", {
        runId: input.runId,
        kind: run.kind,
      });
    }
    if (run.state === RunState.COMPLETED) {
      const finalized = this.artifacts.latest<ACPBootstrapActivationResult>(
        input.runId,
        ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT,
      );
      return finalized
        ? allow(ReasonCode.OK, finalized.content)
        : deny(
            ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
            "completed bootstrap run has no final activation result",
            { runId: input.runId },
          );
    }

    // 1. Validate the RepoFactoryResult — including that it does not overclaim.
    const factory = parseRepoFactoryResult(input.factoryResult);
    if (!factory.allowed) return factory as Decision<ACPBootstrapActivationResult>;
    const result: RepoFactoryResult = factory.value;

    if (result.unresolvedGaps.length > 0) {
      return deny(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "bootstrap reported unresolved gaps",
        { gaps: result.unresolvedGaps },
      );
    }

    if (result.runId !== input.runId) {
      return deny(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "Repo Factory result belongs to a different bootstrap run",
        { activatingRunId: input.runId, resultRunId: result.runId },
      );
    }

    // Integration §19.5 — the applied manifest must be the approved one.
    const approvedDigest = manifestDigest(input.approvedManifest);
    if (result.projectManifestDigest !== approvedDigest) {
      return deny(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "applied manifest digest differs from the approved digest",
        { applied: result.projectManifestDigest, approved: approvedDigest },
      );
    }

    const provenance = await this.validateFactoryProvenance(input, result, approvedDigest);
    if (!provenance.allowed) return provenance as Decision<ACPBootstrapActivationResult>;

    // Everything that can be refused is refused *before* the first mutation. Registering a
    // project, binding a primary CTO and then denying would leave a half-activated
    // project behind and make a retry conflict with itself (Integration §7 Phase J).
    const preflight = this.preflight(input, run.projectId ?? input.approvedManifest.projectId);
    if (!preflight.allowed) return preflight as Decision<ACPBootstrapActivationResult>;

    // 2. Register the project and activate the approved manifest digest.
    const projectId = run.projectId ?? input.approvedManifest.projectId;
    const existing = this.projects.get(projectId);
    if (!existing) {
      const registered = this.projects.register({
        projectId,
        name: input.projectName,
        manifest: input.approvedManifest,
      });
      if (!registered.allowed) return registered as Decision<ACPBootstrapActivationResult>;
    } else {
      const activated = this.projects.activateManifest(projectId, input.approvedManifest, {
        runKind: RunKind.PROJECT_BOOTSTRAP,
        runId: input.runId,
      });
      if (!activated.allowed) return activated as Decision<ACPBootstrapActivationResult>;
    }

    // 3. Create local repository bindings. The committed manifest never holds a path.
    const localBindings: ACPBootstrapActivationResult["localBindings"] = [];
    for (const binding of input.localBindings) {
      const registered = await this.repositories.register({
        checkoutPath: binding.checkoutPath,
        projectId,
        repositoryRole: binding.repositoryRole,
        activeManifestDigest: approvedDigest,
        identity: binding.identity,
      });
      if (!registered.allowed) return registered as Decision<ACPBootstrapActivationResult>;
      localBindings.push({
        identity: registered.value.identity,
        checkoutPath: registered.value.checkoutPath,
        repositoryRole: binding.repositoryRole,
      });
    }

    // 4. Blind review is recorded from the run's own artifact. CEO confirmation is
    // deliberately not read here: it is the next ordered phase and builds the final
    // activation result atomically with the COMPLETED transition.
    const reviewArtifact = this.artifacts.latest<{ verdict: string }>(
      input.runId,
      ArtifactKind.BLIND_REVIEW,
    );

    // 6. Primary CTO: promote the bootstrap CTO if eligible, otherwise create fresh.
    const promotion = this.canPromoteBootstrapCto(input.runId);
    let primaryCtoBinding: ACPBootstrapActivationResult["primaryCtoBinding"] = null;
    const primaryRoleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });

    // A retried activation must not try to bind a role that is already bound. The existing
    // binding *is* the activation fact; re-binding would burn a generation for nothing.
    const alreadyBound = this.bindings.active(primaryRoleKey);
    if (alreadyBound) {
      await this.cto.ensureBuzz(alreadyBound.sessionId, `primary-cto:${projectId}`);
      primaryCtoBinding = {
        roleKey: primaryRoleKey,
        sessionId: alreadyBound.sessionId,
        bindingGeneration: alreadyBound.bindingGeneration,
        promotedFromBootstrap: promotion.allowed && promotion.value === alreadyBound.sessionId,
      };
    } else if (promotion.allowed) {
      const bound = this.bindings.bind({
        roleKey: primaryRoleKey,
        role: Role.PRIMARY_CTO,
        sessionId: promotion.value,
        projectId,
        mode: "PREFERRED",
      });
      if (!bound.allowed) return bound as Decision<ACPBootstrapActivationResult>;
      // A promoted session becomes the project's authority, so it needs the same route a
      // freshly provisioned CTO gets.
      await this.cto.ensureBuzz(bound.value.sessionId, `primary-cto:${projectId}`);
      primaryCtoBinding = {
        roleKey: primaryRoleKey,
        sessionId: bound.value.sessionId,
        bindingGeneration: bound.value.bindingGeneration,
        promotedFromBootstrap: true,
      };
    } else {
      const provisioned = await this.cto.ensurePrimaryCto(projectId, input.runId);
      if (!provisioned.allowed) return provisioned as Decision<ACPBootstrapActivationResult>;
      primaryCtoBinding = {
        roleKey: provisioned.value.roleKey,
        sessionId: provisioned.value.sessionId,
        bindingGeneration: provisioned.value.bindingGeneration,
        promotedFromBootstrap: false,
      };
    }

    // 7. Buzz connection state of the now-bound primary CTO.
    const ctoSession = this.sessions.get(primaryCtoBinding.sessionId);

    // 8/9. Structured handoff must be persisted and acknowledged *by the incoming
    // session* (§26.5). This call only records and delivers it; the ack is a separate act.
    const handoff = this.openActivationHandoff(
      projectId,
      input.runId,
      primaryCtoBinding.sessionId,
      input.handoff,
    );
    if (!handoff.allowed) return handoff as Decision<ACPBootstrapActivationResult>;
    const handoffAck = this.acknowledgedActivationHandoff(
      input.runId,
      handoff.value.handoffId,
      primaryCtoBinding.sessionId,
    );

    // 10. Doctor.
    const report = await this.doctor.run("project", projectId);

    // §25 — the doctor's verdict is the availability this activation may claim. Reporting
    // HEALTHY over a DEGRADED runtime would be exactly the silent degradation the PRD
    // forbids, so the project's own availability is corrected here.
    if (report.status === "DEGRADED") {
      this.projects.setAvailability(projectId, "DEGRADED", "bootstrap activation doctor report");
    } else if (report.status === "BLOCKED" || report.status === "ERROR") {
      this.projects.setAvailability(projectId, "UNAVAILABLE", "bootstrap activation doctor report");
    }

    const project = this.projects.require(projectId);
    const activation: ACPBootstrapActivationResult = {
      schema: "agent-control-plane.bootstrap-activation.v1",
      runId: input.runId,
      projectId,
      projectRegistration: { registered: true, activeManifestDigest: approvedDigest },
      localBindings,
      blindReview: reviewArtifact
        ? { verdict: reviewArtifact.content.verdict, digest: reviewArtifact.digest }
        : null,
      ceoConfirm: null,
      primaryCtoBinding,
      buzz: { connected: Boolean(ctoSession?.buzzAddress), address: ctoSession?.buzzAddress ?? null },
      handoffAck,
      doctor: { status: report.status, findings: report.findings.length },
      activity: project.activity,
      availability: project.availability,
      completedAt: this.clock.nowIso(),
    };

    // §26.3 — the factory result and doctor observation are retained for retry. Neither
    // is an activation result: only the CEO-confirm transaction can write that claim.
    this.artifacts.put(input.runId, ArtifactKind.REPO_FACTORY_RESULT, result);
    this.artifacts.put(input.runId, ArtifactKind.DOCTOR_REPORT, {
      source: "bootstrap-activation",
      projectId,
      report,
    });

    const incomplete = this.incompleteness(activation, report);
    if (incomplete.length > 0) {
      this.audit.record({
        kind: "BOOTSTRAP_ACTIVATION_INCOMPLETE",
        runId: input.runId,
        projectId,
        reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
        evidence: { incomplete },
      });
      return deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, "activation is not complete", {
        incomplete,
        // The handoff the incoming CTO still has to acknowledge, so a caller can act on it.
        pendingHandoffId: handoff.value.handoffId,
        activation,
      });
    }

    this.audit.record({
      kind: "BOOTSTRAP_ACTIVATION_READY_FOR_CONFIRM",
      runId: input.runId,
      projectId,
      evidence: {
        activeManifestDigest: approvedDigest,
        primaryCtoGeneration: primaryCtoBinding.bindingGeneration,
        promotedFromBootstrap: primaryCtoBinding.promotedFromBootstrap,
        doctorStatus: report.status,
      },
    });
    return allow(ReasonCode.OK, activation);
  }

  /**
   * Phase J's last operation. ProductionGate invokes this while its completion
   * transaction is open, so every fact is re-read before the final artifact and run
   * state become durable together. Calling it outside that transaction is refused.
   */
  finalizeBootstrapActivationConfirm(
    input: BootstrapConfirmationInput,
  ): Decision<ACPBootstrapActivationResult> {
    if (!this.db.inTransaction) {
      return deny(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "bootstrap activation finalization must run inside the CEO completion transaction",
        { runId: input.runId },
      );
    }
    const run = this.runs.get(input.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: input.runId });
    if (run.kind !== RunKind.PROJECT_BOOTSTRAP || run.state !== RunState.READY_FOR_CEO_REVIEW) {
      return deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, "bootstrap run is not ready to finalize", {
        runId: input.runId,
        kind: run.kind,
        state: run.state,
      });
    }

    const factory = this.artifacts.latest<RepoFactoryResult>(input.runId, ArtifactKind.REPO_FACTORY_RESULT);
    const handoffArtifact = this.artifacts.latest<{
      handoffId: string;
      projectId: string;
      toSessionId: string;
    }>(input.runId, ArtifactKind.HANDOFF);
    const doctorArtifact = this.artifacts.latest<{
      source?: string;
      projectId?: string;
      report?: DoctorReport;
    }>(input.runId, ArtifactKind.DOCTOR_REPORT);
    const review = this.artifacts.latestForSnapshot<{
      verdict?: string;
      candidateSnapshotDigest?: string;
      reviewerSessionId?: string;
    }>(input.runId, ArtifactKind.BLIND_REVIEW, input.candidateSnapshotDigest);
    if (
      !factory ||
      !handoffArtifact ||
      !doctorArtifact ||
      doctorArtifact.content.source !== "bootstrap-activation" ||
      !doctorArtifact.content.report ||
      !review ||
      review.content.verdict !== "PASS" ||
      review.content.candidateSnapshotDigest !== input.candidateSnapshotDigest
    ) {
      return deny(
        ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
        "bootstrap confirmation is missing activation facts bound to this candidate",
        { runId: input.runId, candidateSnapshotDigest: input.candidateSnapshotDigest },
      );
    }

    const projectId = handoffArtifact.content.projectId;
    if (doctorArtifact.content.projectId !== projectId) {
      return deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, "bootstrap doctor report belongs to another project", {
        runId: input.runId,
        expectedProjectId: projectId,
        actualProjectId: doctorArtifact.content.projectId ?? null,
      });
    }
    const project = this.projects.get(projectId);
    const primary = this.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId }));
    const ctoSession = primary ? this.sessions.get(primary.sessionId) : null;
    const handoffAck = this.acknowledgedActivationHandoff(
      input.runId,
      handoffArtifact.content.handoffId,
      handoffArtifact.content.toSessionId,
    );
    const localBindings = factory.content.repositories.flatMap((repository) => {
      const local = this.repositories.byIdentity(repository.identity);
      if (
        !local ||
        local.projectId !== projectId ||
        local.repositoryRole !== repository.role ||
        local.activeManifestDigest !== project?.activeManifestDigest
      ) {
        return [];
      }
      return [{
        identity: local.identity,
        checkoutPath: local.checkoutPath,
        repositoryRole: local.repositoryRole,
      }];
    });
    if (localBindings.length !== factory.content.repositories.length) {
      return deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, "bootstrap local bindings changed before confirmation", {
        runId: input.runId,
        projectId,
      });
    }
    const reviewer = review.content.reviewerSessionId
      ? this.bindings.assertReviewerIndependence(input.runId, review.content.reviewerSessionId)
      : deny(ReasonCode.REVIEWER_NOT_INDEPENDENT, "blind review has no reviewer session", { runId: input.runId });
    if (!reviewer.allowed) return reviewer as Decision<ACPBootstrapActivationResult>;

    const activation: ACPBootstrapActivationResult = {
      schema: "agent-control-plane.bootstrap-activation.v1",
      runId: input.runId,
      projectId,
      projectRegistration: {
        registered: Boolean(project),
        activeManifestDigest: project?.activeManifestDigest ?? "",
      },
      localBindings,
      blindReview: { verdict: "PASS", digest: review.digest },
      ceoConfirm: { decision: "CONFIRM", at: input.confirmedAt },
      primaryCtoBinding: primary
        ? {
            roleKey: primary.roleKey,
            sessionId: primary.sessionId,
            bindingGeneration: primary.bindingGeneration,
            promotedFromBootstrap: primary.sessionId === run.ownerSessionId,
          }
        : null,
      buzz: { connected: Boolean(ctoSession?.buzzAddress), address: ctoSession?.buzzAddress ?? null },
      handoffAck,
      doctor: {
        status: doctorArtifact.content.report.status,
        findings: doctorArtifact.content.report.findings.length,
      },
      activity: project?.activity ?? "INACTIVE",
      availability: project?.availability ?? "UNAVAILABLE",
      completedAt: input.confirmedAt,
    };
    const incomplete = this.incompleteness(activation, doctorArtifact.content.report);
    if (!activation.ceoConfirm) incomplete.push("ceoConfirm");
    if (incomplete.length > 0) {
      return deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, "activation changed before CEO confirmation", {
        runId: input.runId,
        incomplete,
      });
    }

    this.artifacts.put(input.runId, ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT, activation);
    this.audit.record({
      kind: "BOOTSTRAP_ACTIVATED",
      runId: input.runId,
      projectId,
      sessionId: input.ceoSessionId,
      evidence: {
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        blindReviewDigest: review.digest,
        primaryCtoGeneration: primary?.bindingGeneration ?? null,
        doctorStatus: activation.doctor.status,
      },
    });
    return allow(ReasonCode.OK, activation);
  }

  /**
   * Persists the activation handoff as PENDING and delivers it. It is deliberately not
   * acknowledged here: an ack the control plane writes on the recipient's behalf proves
   * nothing about the recipient (§26.5).
   */
  private openActivationHandoff(
    projectId: string,
    runId: string,
    toSessionId: string,
    handoff: HandoffPackage,
  ): Decision<{ handoffId: string }> {
    const missing = missingHandoffFields(handoff);
    if (missing.length > 0) {
      return deny(ReasonCode.HANDOFF_PACKAGE_INCOMPLETE, "activation handoff is incomplete", {
        runId,
        missing,
      });
    }

    const handoffDigest = digestOf(handoff);
    const recorded = this.artifacts.latest<{
      handoffId: string;
      projectId: string;
      toSessionId: string;
      handoff: HandoffPackage;
    }>(runId, ArtifactKind.HANDOFF);
    if (recorded) {
      const recordedDigest = digestOf(recorded.content.handoff);
      if (
        recorded.content.projectId !== projectId ||
        recorded.content.toSessionId !== toSessionId ||
        recordedDigest !== handoffDigest
      ) {
        return deny(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "bootstrap handoff retry changed its bound package", {
          runId,
          expected: {
            projectId: recorded.content.projectId,
            toSessionId: recorded.content.toSessionId,
            digest: recordedDigest,
          },
          received: { projectId, toSessionId, digest: handoffDigest },
        });
      }
      const row = this.db.get<{ project_id: string; to_session_id: string; digest: string; kind: string }>(
        `SELECT project_id, to_session_id, digest, kind FROM handoffs WHERE handoff_id = ?`,
        [recorded.content.handoffId],
      );
      if (
        !row ||
        row.kind !== "BOOTSTRAP" ||
        row.project_id !== projectId ||
        row.to_session_id !== toSessionId ||
        row.digest !== handoffDigest
      ) {
        return deny(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "bootstrap handoff record no longer matches its run artifact", {
          runId,
          handoffId: recorded.content.handoffId,
        });
      }
      return allow(ReasonCode.OK, { handoffId: recorded.content.handoffId });
    }

    const handoffId = `hof_${digestOf({ runId, toSessionId, handoffDigest }).slice(7, 27)}`;
    this.db.run(
      `INSERT INTO handoffs (handoff_id, project_id, kind, from_session_id, from_generation,
                             to_session_id, package_json, digest, status, created_at)
       VALUES (?, ?, 'BOOTSTRAP', NULL, 0, ?, ?, ?, 'PENDING', ?)`,
      [
        handoffId, projectId, toSessionId, JSON.stringify(handoff), handoffDigest,
        this.clock.nowIso(),
      ],
    );
    this.artifacts.put(runId, ArtifactKind.HANDOFF, {
      handoffId,
      projectId,
      toSessionId,
      handoff,
      at: this.clock.nowIso(),
    });
    this.outbox.enqueue({
      idempotencyKey: `bootstrap-handoff:${handoffId}`,
      roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
      bindingGeneration: this.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId }))
        ?.bindingGeneration ?? 1,
      targetSessionId: toSessionId,
      runId,
      kind: MessageKind.HANDOFF_PACKAGE,
      payload: { handoffId, projectId, handoff },
    });
    this.audit.record({
      kind: "HANDOFF_SUBMITTED",
      projectId,
      runId,
      sessionId: toSessionId,
      evidence: { handoffId, source: "bootstrap-activation" },
    });
    return allow(ReasonCode.OK, { handoffId });
  }

  /** The ack, as recorded by the incoming session itself. */
  acknowledgeActivationHandoff(handoffId: string, ackBySessionId: string): Decision<void> {
    const row = this.db.get<{ to_session_id: string; status: string; kind: string }>(
      `SELECT to_session_id, status, kind FROM handoffs WHERE handoff_id = ?`,
      [handoffId],
    );
    if (!row) return deny(ReasonCode.NOT_FOUND, "unknown handoff", { handoffId });
    if (row.kind !== "BOOTSTRAP") {
      return deny(ReasonCode.INVALID_ARGUMENT, "handoff is not a bootstrap activation handoff", { handoffId });
    }
    if (row.to_session_id !== ackBySessionId) {
      return deny(ReasonCode.HANDOFF_ACK_REQUIRED, "ack must come from the incoming session", {
        handoffId,
        expected: row.to_session_id,
        got: ackBySessionId,
      });
    }
    if (row.status === "ACKED") return allow(ReasonCode.OK, undefined);
    this.db.run(
      `UPDATE handoffs SET status = 'ACKED', acked_at = ?, ack_by_session_id = ? WHERE handoff_id = ?`,
      [this.clock.nowIso(), ackBySessionId, handoffId],
    );
    this.audit.record({
      kind: "HANDOFF_ACK",
      runId: null,
      sessionId: ackBySessionId,
      evidence: { handoffId, source: "bootstrap-activation" },
    });
    return allow(ReasonCode.OK, undefined);
  }

  private acknowledgedActivationHandoff(
    runId: string,
    handoffId: string,
    toSessionId: string,
  ): { handoffId: string; ackedAt: string } | null {
    const row = this.db.get<{ handoff_id: string; acked_at: string | null }>(
      `SELECT handoff_id, acked_at FROM handoffs
        WHERE handoff_id = ? AND kind = 'BOOTSTRAP' AND to_session_id = ? AND status = 'ACKED'`,
      [handoffId, toSessionId],
    );
    const artifact = this.artifacts.latest<{ handoffId: string }>(runId, ArtifactKind.HANDOFF);
    if (artifact?.content.handoffId !== handoffId) return null;
    return row?.acked_at ? { handoffId: row.handoff_id, ackedAt: row.acked_at } : null;
  }

  /**
   * Integration §13 — every result fact must trace to the approved plan, this run, and
   * the exact checked-out repository head before activation writes begin.
   */
  private async validateFactoryProvenance(
    input: ActivationInput,
    result: RepoFactoryResult,
    approvedManifestDigest: string,
  ): Promise<Decision<void>> {
    const planArtifact = this.artifacts.latest<Partial<ApprovedBootstrapPlan>>(
      input.runId,
      ArtifactKind.PLAN,
    );
    const plan = planArtifact?.content;
    if (
      !planArtifact ||
      !plan ||
      typeof plan.bootstrapOperationId !== "string" ||
      typeof plan.requestDigest !== "string" ||
      typeof plan.projectManifestDigest !== "string" ||
      !Array.isArray(plan.githubOperations) ||
      plan.githubOperations.some(
        (operation) =>
          !operation ||
          typeof operation.operationId !== "string" ||
          typeof operation.resourceType !== "string" ||
          typeof operation.resourceIdentity !== "string",
      )
    ) {
      return deny(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "activation requires a durable approved bootstrap plan with operation provenance",
        {
          runId: input.runId,
          missing: ["planDigest", "bootstrapOperationId", "requestDigest", "githubOperations"],
        },
      );
    }
    if (
      planArtifact.digest !== result.planDigest ||
      plan.bootstrapOperationId !== result.bootstrapOperationId ||
      plan.projectManifestDigest !== approvedManifestDigest
    ) {
      return deny(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "Repo Factory result does not match the approved bootstrap plan",
        {
          approvedPlanDigest: planArtifact.digest,
          resultPlanDigest: result.planDigest,
          approvedBootstrapOperationId: plan.bootstrapOperationId,
          resultBootstrapOperationId: result.bootstrapOperationId,
          approvedManifestDigest: plan.projectManifestDigest,
          resultManifestDigest: result.projectManifestDigest,
        },
      );
    }

    const expectedRepositories = input.approvedManifest.repositories.map((repository) => ({
      role: repository.role,
      identity: repository.remote,
    }));
    const resultRepositories = result.repositories.map((repository) => ({
      role: repository.role,
      identity: repository.identity,
    }));
    if (
      expectedRepositories.length !== resultRepositories.length ||
      expectedRepositories.some((expected) =>
        !resultRepositories.some(
          (actual) => actual.role === expected.role && actual.identity === expected.identity,
        ),
      )
    ) {
      return deny(
        ReasonCode.COVERAGE_INCOMPLETE,
        "Repo Factory result does not cover the approved repository contract",
        { expectedRepositories, resultRepositories },
      );
    }

    const duplicateRepositories = new Set<string>();
    for (const repository of result.repositories) {
      const key = `${repository.role}:${repository.identity}`;
      if (duplicateRepositories.has(key)) {
        return deny(ReasonCode.COVERAGE_INCOMPLETE, "Repo Factory result repeats a repository", {
          repository,
        });
      }
      duplicateRepositories.add(key);
    }

    const heads = new Map<string, string>();
    for (const repository of result.repositories) {
      const local = input.localBindings.find(
        (binding) => binding.identity === repository.identity && binding.repositoryRole === repository.role,
      );
      if (!local) {
        return deny(ReasonCode.COVERAGE_INCOMPLETE, "activation has no local binding for factory repository", {
          repository,
        });
      }
      const head = await tryRevParse(local.checkoutPath, "HEAD");
      if (!head) {
        return deny(ReasonCode.EVIDENCE_MISSING, "local bootstrap repository has no exact HEAD", {
          repository: repository.identity,
          checkoutPath: local.checkoutPath,
        });
      }
      heads.set(repository.identity, head);
    }

    const badReceipts = result.externalWriteReceipts.filter(
      (receipt) =>
        receipt.bootstrapOperationId !== result.bootstrapOperationId ||
        receipt.requestDigest !== plan.requestDigest,
    );
    if (badReceipts.length > 0) {
      return deny(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "external-write receipt provenance does not match the approved bootstrap plan",
        { receipts: badReceipts.map((receipt) => receipt.operationId) },
      );
    }
    const plannedOperations = plan.githubOperations;
    const unmatchedReceipts = result.externalWriteReceipts.filter(
      (receipt) =>
        !plannedOperations.some(
          (operation) =>
            operation.operationId === receipt.operationId &&
            operation.resourceType === receipt.resourceType &&
            operation.resourceIdentity === receipt.resourceIdentity,
        ),
    );
    const missingReceipts = plannedOperations.filter(
      (operation) =>
        !result.externalWriteReceipts.some(
          (receipt) =>
            receipt.operationId === operation.operationId &&
            receipt.resourceType === operation.resourceType &&
            receipt.resourceIdentity === operation.resourceIdentity,
        ),
    );
    if (unmatchedReceipts.length > 0 || missingReceipts.length > 0) {
      return deny(ReasonCode.COVERAGE_INCOMPLETE, "external-write receipt coverage is incomplete", {
        unmatchedReceipts: unmatchedReceipts.map((receipt) => receipt.operationId),
        missingReceipts: missingReceipts.map((operation) => operation.operationId),
      });
    }

    const missingVerification: Array<{ commandId: string; repositoryIdentity: string | null }> = [];
    for (const command of input.approvedManifest.verificationCommands.filter((candidate) => candidate.required)) {
      const repository = result.repositories.find((candidate) => candidate.role === command.repositoryRole);
      if (!repository) {
        missingVerification.push({ commandId: command.id, repositoryIdentity: null });
        continue;
      }
      const expectedHead = heads.get(repository.identity);
      const found = result.bootstrapVerification.some(
        (verification) =>
          verification.commandId === command.id &&
          verification.repositoryIdentity === repository.identity &&
          verification.exactHead === expectedHead &&
          verification.status === "PASS",
      );
      if (!found) missingVerification.push({ commandId: command.id, repositoryIdentity: repository.identity });
    }
    if (missingVerification.length > 0) {
      return deny(ReasonCode.VERIFICATION_GAP, "required bootstrap verification is missing or not PASS", {
        missingVerification,
      });
    }

    const missingCi = input.approvedManifest.ciWorkflows.flatMap((workflow) =>
      result.repositories.flatMap((repository) => {
        const expectedHead = heads.get(repository.identity);
        const found = result.ciEvidence.some(
          (evidence) =>
            evidence.repositoryIdentity === repository.identity &&
            evidence.checkName === workflow.checkName &&
            evidence.head === expectedHead &&
            evidence.conclusion === "PASS" &&
            (workflow.approvedDigest === null || evidence.workflowDigest === workflow.approvedDigest),
        );
        return found ? [] : [{ repositoryIdentity: repository.identity, checkName: workflow.checkName }];
      }),
    );
    if (missingCi.length > 0) {
      return deny(ReasonCode.VERIFICATION_GAP, "required bootstrap CI evidence is missing or not PASS", {
        missingCi,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * Refusals that must happen before anything is written: the caller's own inputs, and the
   * run evidence §26.5 requires for an activation to be assertable at all.
   */
  private preflight(input: ActivationInput, projectId: string): Decision<void> {
    if (input.localBindings.length === 0) {
      return deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, "activation needs local bindings", {
        runId: input.runId,
        incomplete: ["localBindings"],
      });
    }
    const missing = missingHandoffFields(input.handoff);
    if (missing.length > 0) {
      return deny(ReasonCode.HANDOFF_PACKAGE_INCOMPLETE, "activation handoff is incomplete", {
        runId: input.runId,
        missing,
      });
    }

    const review = this.artifacts.latest<{ verdict: string }>(input.runId, ArtifactKind.BLIND_REVIEW);
    if (!review || review.content.verdict !== "PASS") {
      return deny(
        ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
        "activation requires a passing blind review of the bootstrap run",
        { runId: input.runId, incomplete: ["blindReview"], verdict: review?.content.verdict ?? null },
      );
    }

    const state = this.runs.get(input.runId)?.state;
    if (state !== RunState.READY_FOR_CEO_REVIEW) {
      return deny(
        ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
        "activation requires the bootstrap run to have reached CEO review",
        { runId: input.runId, incomplete: ["ceoConfirm"], state: state ?? null },
      );
    }

    void projectId;
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * CP-S52 — the operational facts that must all be present before final CEO
   * confirmation. `activate` prepares these facts; finalization re-reads them and adds
   * the CEO receipt before it writes ACPBootstrapActivationResult.
   */
  private incompleteness(
    activation: ACPBootstrapActivationResult,
    report: DoctorReport,
  ): string[] {
    const missing: string[] = [];
    if (!activation.projectRegistration.registered) missing.push("projectRegistration");
    if (activation.localBindings.length === 0) missing.push("localBindings");
    // The CEO gate re-checks this activation immediately before its CONFIRM transition.
    // Requiring that future decision here would deadlock the ordered Phase J flow: the
    // gate needs the operational activation facts before it can make that decision.
    if (activation.blindReview?.verdict !== "PASS") missing.push("blindReview");
    if (!activation.primaryCtoBinding) missing.push("primaryCtoBinding");
    // A CTO with no route cannot be handed anything.
    if (!activation.buzz.connected) missing.push("buzz");
    if (!activation.handoffAck) missing.push("handoffAck");
    // §25.4 — a blocking finding is exactly the thing that must stop an activation, at any
    // status. A non-blocking DEGRADED is reported through `availability` instead of being
    // silently dropped.
    if (report.status === "ERROR" || report.status === "BLOCKED") missing.push(`doctor:${report.status}`);
    const blocking = report.findings.filter((f) => f.blocking).map((f) => f.code);
    if (blocking.length > 0) missing.push(`doctor:blocking:${blocking.join(",")}`);

    if (activation.activity !== "ACTIVE") missing.push("projectActivity");
    return missing;
  }
}
