import { randomUUID } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { Role, type RoleBinding, RunState, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { ProviderRegistry } from "../runtime/provider.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";

/** PRD §10.2 — the mandatory contents of a handoff package. */
export interface HandoffPackage {
  projectStatus: string;
  activeManifestDigest: string | null;
  recentDecisions: string[];
  openBlockers: string[];
  queuedWork: string[];
  repositoryFacts: Array<{ identity: string; branch: string | null; head: string | null }>;
  knownRisks: string[];
  recommendedNextAction: string;
}

export interface RecoveryPackage extends HandoffPackage {
  reason: string;
  reconstructedFrom: string[];
}

/** Connecting a fresh CTO to Buzz (§9.5 step 2). Injected so the kernel stays testable. */
export interface BuzzConnector {
  connect(sessionId: string, purpose: string): Promise<Decision<string>>;
  disconnect(sessionId: string): Promise<void>;
}

/** Doctor readiness check run before a CTO is bound (§9.5 step 3, §25.6). */
export interface ReadinessProbe {
  checkSession(sessionId: string): Promise<Decision<void>>;
}

export interface CtoPreference {
  provider: string;
  model: string;
  effort: string | null;
}

/**
 * PRD §§9.5, 10.
 *
 * Two rules shape everything here. A switchover happens only when the outgoing CTO owns
 * zero active runs, and the old binding stays in force until the incoming CTO has
 * acknowledged the handoff — so there is never a window in which a project has two
 * CTOs, or none while work is in flight.
 */
export class CtoLifecycle {
  #buzz: BuzzConnector | null = null;
  #readiness: ReadinessProbe | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly projects: ProjectRegistry,
    private readonly sessions: SessionRegistry,
    private readonly bindings: BindingRegistry,
    private readonly providers: ProviderRegistry,
    private readonly outbox: Outbox,
    private readonly runs: RunEngine,
    private readonly preference: CtoPreference,
  ) {}

  attach(ports: { buzz?: BuzzConnector; readiness?: ReadinessProbe }): void {
    if (ports.buzz) this.#buzz = ports.buzz;
    if (ports.readiness) this.#readiness = ports.readiness;
  }

  /**
   * §9.5 — a run arriving at a project with no primary CTO creates one:
   * fresh session → Buzz → doctor readiness → binding → project ACTIVE → dispatch.
   */
  async ensurePrimaryCto(projectId: string, runId: string): Promise<Decision<RoleBinding>> {
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const existing = this.bindings.active(roleKey);
    if (existing) {
      const session = this.sessions.get(existing.sessionId);
      if (session?.lifecycle === SessionLifecycle.READY) return allow(ReasonCode.OK, existing);
      if (session?.lifecycle === SessionLifecycle.DRAINING) {
        return deny(
          ReasonCode.RUN_DISPATCH_BLOCKED_CTO_DRAINING,
          "primary CTO is draining",
          { projectId, sessionId: existing.sessionId },
        );
      }
      // The bound session is dead or errored — recover rather than dispatch into a void.
      return this.recoveryTakeover(projectId, "bound CTO session is not ready", runId);
    }

    const created = await this.spawn(projectId, "primary-cto");
    if (!created.allowed) return created as Decision<RoleBinding>;

    const bound = this.bindings.bind({
      roleKey,
      role: Role.PRIMARY_CTO,
      sessionId: created.value,
      projectId,
      mode: "PREFERRED",
    });
    if (!bound.allowed) {
      this.sessions.transition(created.value, SessionLifecycle.STOPPED, "binding refused");
      return bound;
    }

    this.audit.record({
      kind: "PRIMARY_CTO_ACTIVATED",
      projectId,
      runId,
      sessionId: created.value,
      roleKey,
      evidence: { generation: bound.value.bindingGeneration, provider: this.preference.provider },
    });
    return bound;
  }

  /** §10.1 — replacement requested: the outgoing CTO drains, new runs queue. */
  requestReplacement(projectId: string, reason: string): Decision<{ draining: boolean; activeRuns: number }> {
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const current = this.bindings.active(roleKey);
    if (!current) return deny(ReasonCode.NOT_FOUND, "project has no primary CTO", { projectId });

    const drain = this.sessions.transition(current.sessionId, SessionLifecycle.DRAINING, reason);
    if (!drain.allowed) return drain as Decision<{ draining: boolean; activeRuns: number }>;

    this.outbox.enqueue({
      idempotencyKey: `drain:${projectId}:${current.bindingGeneration}`,
      roleKey,
      bindingGeneration: current.bindingGeneration,
      targetSessionId: current.sessionId,
      runId: null,
      kind: MessageKind.DRAIN_REQUEST,
      payload: { projectId, reason },
    });

    const activeRuns = this.runs.activeRunsOwnedBy(current.sessionId).length;
    this.audit.record({
      kind: "CTO_REPLACEMENT_REQUESTED",
      projectId,
      sessionId: current.sessionId,
      roleKey,
      evidence: { reason, activeRuns },
    });
    return allow(ReasonCode.OK, { draining: true, activeRuns });
  }

  isDraining(projectId: string): boolean {
    const current = this.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId }));
    if (!current) return false;
    return this.sessions.get(current.sessionId)?.lifecycle === SessionLifecycle.DRAINING;
  }

  /**
   * §10.1 — prepare the switchover. Refused while the outgoing CTO still owns active
   * runs; the caller (CTO or CEO) must first continue, cancel or capacity-suspend them.
   */
  async prepareSwitchover(
    projectId: string,
    handoff: HandoffPackage,
  ): Promise<Decision<{ handoffId: string; incomingSessionId: string }>> {
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const current = this.bindings.active(roleKey);
    if (!current) return deny(ReasonCode.NOT_FOUND, "project has no primary CTO", { projectId });

    const activeRuns = this.runs.activeRunsOwnedBy(current.sessionId);
    if (activeRuns.length > 0) {
      return deny(
        ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS,
        "switchover requires the outgoing CTO to have zero active runs",
        { projectId, activeRuns: activeRuns.map((r) => r.runId) },
      );
    }

    const missing = missingHandoffFields(handoff);
    if (missing.length > 0) {
      return deny(ReasonCode.HANDOFF_PACKAGE_INCOMPLETE, "handoff package is incomplete", {
        projectId,
        missing,
      });
    }

    const incoming = await this.spawn(projectId, "primary-cto-replacement");
    if (!incoming.allowed) return incoming as Decision<{ handoffId: string; incomingSessionId: string }>;

    const handoffId = `hof_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    this.db.run(
      `INSERT INTO handoffs (handoff_id, project_id, kind, from_session_id, from_generation,
                             to_session_id, package_json, digest, status, created_at)
       VALUES (?, ?, 'HANDOFF', ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [
        handoffId, projectId, current.sessionId, current.bindingGeneration, incoming.value,
        JSON.stringify(handoff), digestOf(handoff), this.clock.nowIso(),
      ],
    );

    this.outbox.enqueue({
      idempotencyKey: `handoff:${handoffId}`,
      roleKey,
      bindingGeneration: current.bindingGeneration,
      targetSessionId: incoming.value,
      runId: null,
      kind: MessageKind.HANDOFF_PACKAGE,
      payload: { handoffId, projectId, handoff },
    });

    this.audit.record({
      kind: "HANDOFF_SUBMITTED",
      projectId,
      sessionId: current.sessionId,
      roleKey,
      evidence: { handoffId, incomingSessionId: incoming.value, digest: digestOf(handoff) },
    });
    return allow(ReasonCode.OK, { handoffId, incomingSessionId: incoming.value });
  }

  /**
   * §10.1 — HANDOFF_ACK, then the atomic binding generation switch. Until the ack
   * arrives the old binding is still the authority.
   */
  acknowledgeHandoff(handoffId: string, ackBySessionId: string): Decision<RoleBinding> {
    return this.db.tx(() => {
      const row = this.db.get<RawHandoff>(`SELECT * FROM handoffs WHERE handoff_id = ?`, [handoffId]);
      if (!row) return deny(ReasonCode.NOT_FOUND, "unknown handoff", { handoffId });
      if (row.status !== "PENDING") {
        return deny(ReasonCode.CONFLICT, `handoff is already ${row.status}`, { handoffId });
      }
      if (row.to_session_id !== ackBySessionId) {
        return deny(ReasonCode.HANDOFF_ACK_REQUIRED, "ack must come from the incoming session", {
          handoffId,
          expected: row.to_session_id,
          got: ackBySessionId,
        });
      }

      this.db.run(
        `UPDATE handoffs SET status = 'ACKED', acked_at = ?, ack_by_session_id = ? WHERE handoff_id = ?`,
        [this.clock.nowIso(), ackBySessionId, handoffId],
      );

      const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: row.project_id });
      const switched = this.bindings.switchTo({
        roleKey,
        role: Role.PRIMARY_CTO,
        sessionId: ackBySessionId,
        projectId: row.project_id,
        mode: "PREFERRED",
        reason: `handoff ${handoffId} acknowledged`,
      });
      if (!switched.allowed) return switched;

      if (row.from_session_id) {
        this.sessions.transition(row.from_session_id, SessionLifecycle.STOPPED, "handoff complete");
      }

      this.audit.record({
        kind: "HANDOFF_ACK",
        projectId: row.project_id,
        sessionId: ackBySessionId,
        roleKey,
        evidence: {
          handoffId,
          fromGeneration: row.from_generation,
          toGeneration: switched.value.bindingGeneration,
        },
      });
      return switched;
    });
  }

  /**
   * §10.3 — emergency takeover. Used only when the bound session genuinely cannot act.
   * The recovery package is reconstructed from control plane and git evidence rather
   * than from the dead session, and late results from the old generation become
   * audit-only.
   */
  async recoveryTakeover(
    projectId: string,
    reason: string,
    runId?: string,
  ): Promise<Decision<RoleBinding>> {
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const current = this.bindings.active(roleKey);

    if (current) {
      const session = this.sessions.get(current.sessionId);
      if (session?.lifecycle === SessionLifecycle.READY) {
        return deny(
          ReasonCode.RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER,
          "the bound CTO session is READY; use a normal replacement instead",
          { projectId, sessionId: current.sessionId },
        );
      }
    }

    const recovery = this.buildRecoveryPackage(projectId, reason);
    const incoming = await this.spawn(projectId, "acting-cto-recovery");
    if (!incoming.allowed) return incoming as Decision<RoleBinding>;

    return this.db.tx(() => {
      const handoffId = `hof_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      this.db.run(
        `INSERT INTO handoffs (handoff_id, project_id, kind, from_session_id, from_generation,
                               to_session_id, package_json, digest, status, created_at, acked_at, ack_by_session_id)
         VALUES (?, ?, 'RECOVERY', ?, ?, ?, ?, ?, 'ACKED', ?, ?, ?)`,
        [
          handoffId, projectId, current?.sessionId ?? null, current?.bindingGeneration ?? null,
          incoming.value, JSON.stringify(recovery), digestOf(recovery), this.clock.nowIso(),
          this.clock.nowIso(), incoming.value,
        ],
      );

      const switched = this.bindings.switchTo({
        roleKey,
        role: Role.PRIMARY_CTO,
        sessionId: incoming.value,
        projectId,
        mode: "FALLBACK",
        reason: `recovery takeover: ${reason}`,
      });
      if (!switched.allowed) return switched;

      if (current) {
        this.sessions.transition(current.sessionId, SessionLifecycle.ERROR, "recovery takeover");
        // §10.3 — every run the dead generation owned is repointed at the acting CTO.
        for (const run of this.runs.activeRunsOwnedBy(current.sessionId)) {
          this.runs.reassignOwner(run.runId, switched.value, `recovery takeover: ${reason}`);
        }
      }

      this.audit.record({
        kind: "RECOVERY_TAKEOVER",
        projectId,
        runId: runId ?? null,
        sessionId: incoming.value,
        roleKey,
        evidence: {
          reason,
          handoffId,
          fromSession: current?.sessionId ?? null,
          fromGeneration: current?.bindingGeneration ?? null,
          toGeneration: switched.value.bindingGeneration,
        },
      });
      return switched;
    });
  }

  /** §10.4 — capacity-driven suspend. Owner approval is mandatory. */
  async suspendProject(projectId: string, ownerApproved: boolean, reason: string): Promise<Decision<void>> {
    const suspended = this.projects.setSuspended(projectId, true, ownerApproved);
    if (!suspended.allowed) return suspended;

    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const current = this.bindings.active(roleKey);
    if (current) {
      // Checkpoint before the binding disappears, so a resume is not a cold start.
      const recovery = this.buildRecoveryPackage(projectId, `suspend: ${reason}`);
      this.db.run(
        `INSERT INTO handoffs (handoff_id, project_id, kind, from_session_id, from_generation,
                               to_session_id, package_json, digest, status, created_at)
         VALUES (?, ?, 'RECOVERY', ?, ?, ?, ?, ?, 'PENDING', ?)`,
        [
          `hof_${randomUUID().replace(/-/g, "").slice(0, 20)}`, projectId, current.sessionId,
          current.bindingGeneration, current.sessionId, JSON.stringify(recovery),
          digestOf(recovery), this.clock.nowIso(),
        ],
      );
      this.bindings.revoke(roleKey, `project suspended: ${reason}`);
      this.sessions.transition(current.sessionId, SessionLifecycle.STOPPED, "project suspended");
      await this.providers
        .require(this.sessions.require(current.sessionId).provider)
        .stopSession({
          externalSessionId: current.sessionId,
          provider: this.sessions.require(current.sessionId).provider,
          model: this.sessions.require(current.sessionId).model,
          effort: null,
          pid: null,
        })
        .catch(() => undefined);
    }

    this.audit.record({
      kind: "PROJECT_SUSPENDED",
      projectId,
      evidence: { reason, ownerApproved, bindingRemoved: Boolean(current) },
    });
    return allow(ReasonCode.OK, undefined);
  }

  resumeProject(projectId: string): Decision<void> {
    return this.projects.setSuspended(projectId, false, true);
  }

  latestHandoff(projectId: string): (HandoffPackage & { handoffId: string; status: string }) | null {
    const row = this.db.get<RawHandoff>(
      `SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    if (!row) return null;
    return {
      ...(JSON.parse(row.package_json) as HandoffPackage),
      handoffId: row.handoff_id,
      status: row.status,
    };
  }

  /**
   * §10.3 — the package is reconstructed from durable evidence: run state, blockers,
   * repository facts and recent authority decisions. It deliberately does not attempt
   * to recover the dead session's conversation.
   */
  private buildRecoveryPackage(projectId: string, reason: string): RecoveryPackage {
    const project = this.projects.get(projectId);
    const runs = this.runs.list({ projectId });
    const repositories = this.db.all<{ identity: string; last_observed_head: string | null }>(
      `SELECT identity, last_observed_head FROM repositories WHERE project_id = ?`,
      [projectId],
    );
    const decisions = this.db
      .all<{ kind: string; at: string }>(
        `SELECT kind, at FROM audit_events WHERE project_id = ?
           AND kind IN ('CEO_DECISION','OWNER_DECISION','PROJECT_MANIFEST_ACTIVATED','CTO_ESCALATION')
         ORDER BY event_id DESC LIMIT 20`,
        [projectId],
      )
      .map((row) => `${row.at} ${row.kind}`);

    return {
      projectStatus: project ? `${project.activity}/${project.availability}` : "UNKNOWN",
      activeManifestDigest: project?.activeManifestDigest ?? null,
      recentDecisions: decisions,
      openBlockers: runs.filter((r) => r.state === RunState.BLOCKED).map((r) => `${r.runId}: ${r.goal}`),
      queuedWork: runs.filter((r) => r.state === RunState.QUEUED).map((r) => `${r.runId}: ${r.goal}`),
      repositoryFacts: repositories.map((r) => ({
        identity: r.identity,
        branch: null,
        head: r.last_observed_head,
      })),
      knownRisks: [`recovery takeover performed: ${reason}`],
      recommendedNextAction:
        runs.some((r) => r.state === RunState.ACTIVE)
          ? "re-establish ownership of in-flight runs and re-validate their candidates"
          : "resume from the queued work list",
      reason,
      reconstructedFrom: ["control-plane state", "git observations", "audit decisions"],
    };
  }

  /** Fresh session → Buzz → doctor readiness. Any failed step stops the activation. */
  private async spawn(projectId: string, purpose: string): Promise<Decision<string>> {
    const adapter = this.providers.get(this.preference.provider);
    if (!adapter) {
      return deny(ReasonCode.NOT_FOUND, "no adapter for the preferred CTO provider", {
        provider: this.preference.provider,
      });
    }
    const health = await adapter.probeRuntime();
    if (health === "UNAVAILABLE") {
      return deny(ReasonCode.CAPACITY_ADMISSION_SUSPENDED, "CTO provider runtime is unavailable", {
        provider: this.preference.provider,
      });
    }

    const handle = await adapter.startSession({
      model: this.preference.model,
      effort: this.preference.effort,
      workdir: process.cwd(),
      purpose,
    });
    const session = this.sessions.create({
      provider: adapter.provider,
      model: this.preference.model,
      effort: this.preference.effort,
      sessionId: `ses_cto_${handle.externalSessionId.replace(/-/g, "").slice(0, 20)}`,
      incarnation: `${handle.externalSessionId}#${this.clock.nowIso()}`,
      osPid: handle.pid,
    });

    if (this.#buzz) {
      const connected = await this.#buzz.connect(session.sessionId, `${purpose}:${projectId}`);
      if (!connected.allowed) {
        this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "buzz connect failed");
        return connected as Decision<string>;
      }
      this.sessions.setBuzzAddress(session.sessionId, connected.value);
    }

    this.sessions.transition(session.sessionId, SessionLifecycle.READY, "spawned");

    if (this.#readiness) {
      const ready = await this.#readiness.checkSession(session.sessionId);
      if (!ready.allowed) {
        this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "readiness failed");
        return ready as Decision<string>;
      }
    }

    return allow(ReasonCode.OK, session.sessionId);
  }
}

const missingHandoffFields = (handoff: HandoffPackage): string[] => {
  const missing: string[] = [];
  if (!handoff.projectStatus) missing.push("projectStatus");
  if (!handoff.recommendedNextAction) missing.push("recommendedNextAction");
  if (!Array.isArray(handoff.repositoryFacts)) missing.push("repositoryFacts");
  if (!Array.isArray(handoff.openBlockers)) missing.push("openBlockers");
  if (!Array.isArray(handoff.queuedWork)) missing.push("queuedWork");
  if (!Array.isArray(handoff.knownRisks)) missing.push("knownRisks");
  if (!Array.isArray(handoff.recentDecisions)) missing.push("recentDecisions");
  return missing;
};

interface RawHandoff {
  handoff_id: string;
  project_id: string;
  kind: "HANDOFF" | "RECOVERY";
  from_session_id: string | null;
  from_generation: number | null;
  to_session_id: string;
  package_json: string;
  digest: string;
  status: "PENDING" | "ACKED" | "REJECTED";
  created_at: string;
  acked_at: string | null;
  ack_by_session_id: string | null;
}
