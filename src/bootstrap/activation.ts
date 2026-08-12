import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type ProjectManifest, manifestDigest } from "../contracts/manifest.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import { ArtifactKind, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import type { CtoLifecycle, HandoffPackage } from "../cto/cto-lifecycle.ts";
import type { Doctor, DoctorReport } from "../doctor/doctor.ts";
import type { ProductionGate } from "../ceo/production-gate.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
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

    // Integration §19.5 — the applied manifest must be the approved one.
    const approvedDigest = manifestDigest(input.approvedManifest);
    if (result.projectManifestDigest !== approvedDigest) {
      return deny(
        ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        "applied manifest digest differs from the approved digest",
        { applied: result.projectManifestDigest, approved: approvedDigest },
      );
    }

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

    // 4/5. Blind review and CEO confirm are recorded from the run's own artifacts —
    // this method never fabricates them.
    const reviewArtifact = this.artifacts.latest<{ verdict: string }>(
      input.runId,
      ArtifactKind.BLIND_REVIEW,
    );
    const ceoDecision = this.runs.get(input.runId)?.state;

    // 6. Primary CTO: promote the bootstrap CTO if eligible, otherwise create fresh.
    const promotion = this.canPromoteBootstrapCto(input.runId);
    let primaryCtoBinding: ACPBootstrapActivationResult["primaryCtoBinding"] = null;
    const primaryRoleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });

    if (promotion.allowed) {
      const bound = this.bindings.bind({
        roleKey: primaryRoleKey,
        role: Role.PRIMARY_CTO,
        sessionId: promotion.value,
        projectId,
        mode: "PREFERRED",
      });
      if (!bound.allowed) return bound as Decision<ACPBootstrapActivationResult>;
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

    // 8/9. Structured handoff must be persisted and acknowledged (§26.5).
    const handoffAck = this.recordActivationHandoff(
      projectId,
      input.runId,
      primaryCtoBinding.sessionId,
      input.handoff,
    );
    if (!handoffAck.allowed) return handoffAck as Decision<ACPBootstrapActivationResult>;

    // 10. Doctor.
    const report = await this.doctor.run("project", projectId);

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
      ceoConfirm:
        ceoDecision === RunState.COMPLETED ? { decision: "CONFIRM", at: this.clock.nowIso() } : null,
      primaryCtoBinding,
      buzz: { connected: Boolean(ctoSession?.buzzAddress), address: ctoSession?.buzzAddress ?? null },
      handoffAck: handoffAck.value,
      doctor: { status: report.status, findings: report.findings.length },
      activity: project.activity,
      availability: project.availability,
      completedAt: this.clock.nowIso(),
    };

    // §26.3 — the factory result is stored as evidence; only this activation result can
    // complete the run.
    this.artifacts.put(input.runId, ArtifactKind.REPO_FACTORY_RESULT, result);
    this.artifacts.put(input.runId, ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT, activation);

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
        activation,
      });
    }

    this.audit.record({
      kind: "BOOTSTRAP_ACTIVATED",
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

  private recordActivationHandoff(
    projectId: string,
    runId: string,
    toSessionId: string,
    handoff: HandoffPackage,
  ): Decision<{ handoffId: string; ackedAt: string }> {
    const stored = this.artifacts.put(runId, ArtifactKind.HANDOFF, {
      projectId,
      toSessionId,
      handoff,
      at: this.clock.nowIso(),
    });
    this.audit.record({
      kind: "HANDOFF_ACK",
      projectId,
      runId,
      sessionId: toSessionId,
      evidence: { handoffId: stored.artifactId, source: "bootstrap-activation" },
    });
    return allow(ReasonCode.OK, { handoffId: stored.artifactId, ackedAt: this.clock.nowIso() });
  }

  /** CP-S52 — the activation facts that must all be present before the run completes. */
  private incompleteness(
    activation: ACPBootstrapActivationResult,
    report: DoctorReport,
  ): string[] {
    const missing: string[] = [];
    if (!activation.projectRegistration.registered) missing.push("projectRegistration");
    if (activation.localBindings.length === 0) missing.push("localBindings");
    if (!activation.primaryCtoBinding) missing.push("primaryCtoBinding");
    if (!activation.handoffAck) missing.push("handoffAck");
    if (report.status === "ERROR" || report.status === "BLOCKED") missing.push(`doctor:${report.status}`);
    if (activation.activity !== "ACTIVE") missing.push("projectActivity");
    return missing;
  }
}
