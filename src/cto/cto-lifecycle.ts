import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { isWithin } from "../guard/workspace-probe.ts";
import type { OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { Role, type RoleBinding, RunState, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { ProviderAdapter, ProviderRegistry, SessionHandle } from "../runtime/provider.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRecord, SessionRegistry } from "../session/session-registry.ts";

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

/** The receipt an incoming runtime presents after receiving a handoff envelope. */
export interface HandoffAcknowledgement {
  sessionId: string;
  sessionIncarnation: string;
  bindingGeneration: number;
  messageId: string;
  payloadDigest: string;
  /** Session-scoped secret; never persisted in the handoff, audit, or outbox payload. */
  sessionSecret: string;
}

/**
 * Session authentication belongs to the session registry. Keeping this as a narrow port
 * stops a lifecycle caller from treating knowledge of an id as possession of a session.
 */
export interface HandoffAuthentication {
  verifyHandoffAcknowledgement(input: HandoffAcknowledgement): Decision<void>;
}

/**
 * The one-time bootstrap credential for a freshly constituted runtime.  It is deliberately
 * a narrow launch capability rather than a value retained by the lifecycle: the registry
 * hashes the secret, and the launch channel is the sole route that may see its plaintext.
 */
export interface SessionLaunchCredential {
  sessionId: string;
  sessionIncarnation: string;
  externalSessionId: string;
  sessionSecret: string;
}

/**
 * A daemon-owned, recipient-scoped channel used exactly once while a runtime starts.  It
 * keeps a session secret out of handoffs, outbox payloads, audit evidence, and provider
 * prompts while still giving the newly created runtime the proof it needs for local MCP.
 */
export interface SessionLaunchChannel {
  /** Opens the recipient-scoped channel before the provider can start its runtime. */
  prepare(): Promise<Decision<void>>;
  provision(input: SessionLaunchCredential): Promise<Decision<void>>;
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
/**
 * The workdir to persist for a provisioned session: the adapter's, when it is inside the
 * managed runtime root, and the root itself otherwise.
 */
const containedWorkdir = (reported: string | null | undefined, managedRoot: string): string => {
  if (!reported) return managedRoot;
  return reported === managedRoot || isWithin(managedRoot, reported) ? reported : managedRoot;
};

export class CtoLifecycle {
  #buzz: BuzzConnector | null = null;
  #readiness: ReadinessProbe | null = null;
  #ownerAuthority: OwnerAuthorityPort | null = null;
  #handoffAuthentication: HandoffAuthentication | null = null;
  #sessionLaunch: SessionLaunchChannel | null = null;

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
    private readonly managedRuntimeRoot = join(tmpdir(), "agent-control-plane-runtime"),
  ) {
    ensurePrivateDirectory(this.managedRuntimeRoot);
  }

  attach(ports: {
    buzz?: BuzzConnector;
    readiness?: ReadinessProbe;
    ownerAuthority?: OwnerAuthorityPort;
    handoffAuthentication?: HandoffAuthentication;
    sessionLaunch?: SessionLaunchChannel;
  }): void {
    if (ports.buzz) this.#buzz = ports.buzz;
    if (ports.readiness) this.#readiness = ports.readiness;
    if (ports.ownerAuthority) this.#ownerAuthority = ports.ownerAuthority;
    if (ports.handoffAuthentication) this.#handoffAuthentication = ports.handoffAuthentication;
    if (ports.sessionLaunch) this.#sessionLaunch = ports.sessionLaunch;
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
      if (session?.lifecycle === SessionLifecycle.READY) {
        // READY is what the control plane last wrote about the session, not proof that the
        // provider still has one. Reusing a session on that alone is the false-ready path
        // §14.3 exists to close, so the provider has to answer for the exact session first.
        const live = await this.probeBoundSession(session);
        if (live.allowed) return allow(ReasonCode.OK, existing);
        this.audit.record({
          kind: "CTO_SESSION_PROBE_FAILED",
          reasonCode: live.reasonCode,
          projectId,
          runId,
          sessionId: session.sessionId,
          roleKey,
          evidence: { provider: session.provider, ...live.evidence },
        });
        // The durable ERROR is what makes this a recovery rather than a replacement: a
        // session the provider disowns genuinely cannot act.
        this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "provider session probe failed");
        return this.recoveryTakeover(projectId, "bound CTO session failed its provider probe", runId);
      }
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

  /**
   * Connects a session to Buzz if a transport is attached, and records the address. Used
   * whenever a session becomes a role's authority outside `spawn` (§26.2 promotion).
   */
  async ensureBuzz(sessionId: string, purpose: string): Promise<Decision<string | null>> {
    if (!this.#buzz) return allow(ReasonCode.OK, null);
    const existing = this.sessions.get(sessionId)?.buzzAddress;
    if (existing) return allow(ReasonCode.OK, existing);
    const connected = await this.#buzz.connect(sessionId, purpose);
    return connected.allowed ? allow(ReasonCode.OK, connected.value) : (connected as Decision<string | null>);
  }

  /**
   * The provider a dispatch for this project will actually route to: the bound Primary
   * CTO's own provider while one is bound, otherwise the configured preference. §14.2
   * admission has to be asked about *that* provider — asking about "any healthy provider"
   * is how a run gets admitted against quota it will never use.
   */
  plannedProvider(projectId: string): string | null {
    const current = this.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId }));
    const bound = current ? this.sessions.get(current.sessionId)?.provider : null;
    return bound ?? this.preference.provider ?? null;
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
    // #664 — the DRAINING transition and the handoffs INSERT below must not survive a
    // later denial in this body (the outbox enqueue can deny after both have written),
    // so this body's own decision has to roll them back the same way a throw would.
    const prepared = this.db.txDecision(() => {
      // Spawn is asynchronous, so repeat the authority and active-run checks at the
      // moment the drain barrier is persisted. A replacement can never revoke a run that
      // appeared while its incoming session was being readied.
      const fresh = this.bindings.active(roleKey);
      if (
        !fresh ||
        fresh.sessionId !== current.sessionId ||
        fresh.bindingGeneration !== current.bindingGeneration
      ) {
        return deny<{ handoffId: string; incomingSessionId: string }>(
          ReasonCode.WRITE_BINDING_GENERATION_STALE,
          "the primary CTO binding changed while the replacement was being prepared",
          { projectId, expectedGeneration: current.bindingGeneration, current: fresh?.bindingGeneration ?? null },
        );
      }
      const stillActive = this.runs.activeRunsOwnedBy(current.sessionId);
      if (stillActive.length > 0) {
        return deny<{ handoffId: string; incomingSessionId: string }>(
          ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS,
          "the outgoing CTO acquired active runs while the replacement was being prepared",
          { projectId, activeRuns: stillActive.map((run) => run.runId) },
        );
      }

      // DRAINING, the durable handoff, and the message that authorizes its recipient are
      // one transition. A failed transaction rolls the owner back to its prior lifecycle.
      const draining = this.sessions.transition(
        current.sessionId,
        SessionLifecycle.DRAINING,
        "switchover prepared",
      );
      if (!draining.allowed) {
        return draining as Decision<{ handoffId: string; incomingSessionId: string }>;
      }
      this.db.run(
        `INSERT INTO handoffs (handoff_id, project_id, kind, from_session_id, from_generation,
                               to_session_id, package_json, digest, status, created_at)
         VALUES (?, ?, 'HANDOFF', ?, ?, ?, ?, ?, 'PENDING', ?)`,
        [
          handoffId, projectId, current.sessionId, current.bindingGeneration, incoming.value,
          JSON.stringify(handoff), digestOf(handoff), this.clock.nowIso(),
        ],
      );
      const enqueued = this.outbox.enqueue({
        idempotencyKey: `handoff:${handoffId}`,
        roleKey,
        bindingGeneration: current.bindingGeneration,
        targetSessionId: incoming.value,
        runId: null,
        kind: MessageKind.HANDOFF_PACKAGE,
        payload: { handoffId, projectId, handoff },
      });
      if (!enqueued.allowed) {
        return enqueued as Decision<{ handoffId: string; incomingSessionId: string }>;
      }
      return allow(ReasonCode.OK, { handoffId, incomingSessionId: incoming.value });
    });
    if (!prepared.allowed) {
      await this.stopUnusedSession(incoming.value, "switchover preparation refused");
      return prepared;
    }

    this.audit.record({
      kind: "HANDOFF_SUBMITTED",
      projectId,
      sessionId: current.sessionId,
      roleKey,
      evidence: { handoffId, incomingSessionId: incoming.value, digest: digestOf(handoff) },
    });
    return prepared;
  }

  /**
   * §10.1 — HANDOFF_ACK, then the atomic binding generation switch. Until the ack
   * arrives the old binding is still the authority.
   */
  acknowledgeHandoff(
    handoffId: string,
    acknowledgement: HandoffAcknowledgement | string,
  ): Decision<RoleBinding> {
    // #664 — this body's own ACKED write must not survive a denial, including one
    // that comes back from the nested `bindings.switchTo` call below.
    return this.db.txDecision(() => {
      const row = this.db.get<RawHandoff>(`SELECT * FROM handoffs WHERE handoff_id = ?`, [handoffId]);
      if (!row) return deny(ReasonCode.NOT_FOUND, "unknown handoff", { handoffId });
      if (row.status !== "PENDING") {
        return deny(ReasonCode.CONFLICT, `handoff is already ${row.status}`, { handoffId });
      }

      // A session id is an address, not a credential. Legacy callers that only provide
      // it are deliberately refused instead of silently retaining the pre-hardening
      // authentication model.
      if (typeof acknowledgement === "string") {
        return deny(ReasonCode.HANDOFF_ACK_AUTHENTICATION_FAILED, "handoff ack requires a session-authenticated envelope", {
          handoffId,
        });
      }
      if (row.to_session_id !== acknowledgement.sessionId) {
        return deny(ReasonCode.HANDOFF_ACK_REQUIRED, "ack must come from the incoming session", {
          handoffId,
          expected: row.to_session_id,
          got: acknowledgement.sessionId,
        });
      }

      const incoming = this.sessions.get(row.to_session_id);
      const envelope = this.outbox.byIdempotencyKey(`handoff:${handoffId}`);
      if (
        !incoming ||
        acknowledgement.sessionIncarnation !== incoming.incarnation ||
        acknowledgement.bindingGeneration !== row.from_generation ||
        !envelope ||
        envelope.kind !== MessageKind.HANDOFF_PACKAGE ||
        envelope.targetSessionId !== row.to_session_id ||
        envelope.bindingGeneration !== row.from_generation ||
        acknowledgement.messageId !== envelope.messageId ||
        acknowledgement.payloadDigest !== envelope.payloadDigest ||
        envelope.status !== "SENT"
      ) {
        return deny(
          ReasonCode.HANDOFF_ACK_AUTHENTICATION_FAILED,
          "handoff ack does not match a delivered, current handoff envelope",
          {
            handoffId,
            messageId: acknowledgement.messageId,
            delivered: envelope?.status === "SENT",
          },
        );
      }
      if (!this.#handoffAuthentication) {
        return deny(
          ReasonCode.HANDOFF_ACK_AUTHENTICATION_FAILED,
          "handoff session authentication is not configured",
          { handoffId },
        );
      }
      const authenticated = this.#handoffAuthentication.verifyHandoffAcknowledgement(acknowledgement);
      if (!authenticated.allowed) return authenticated as Decision<RoleBinding>;

      // The authority that prepared the handoff must still be the authority. If the
      // binding moved (failover, recovery takeover) this ack is for a generation that no
      // longer exists, and switching on it would strand whatever the new owner is doing.
      const roleKeyForAck = roleKeyFor(Role.PRIMARY_CTO, { projectId: row.project_id });
      const currentBinding = this.bindings.active(roleKeyForAck);
      if (!currentBinding || currentBinding.bindingGeneration !== row.from_generation) {
        return deny(
          ReasonCode.WRITE_BINDING_GENERATION_STALE,
          "the binding moved since this handoff was prepared",
          {
            handoffId,
            preparedFrom: row.from_generation,
            current: currentBinding?.bindingGeneration ?? null,
          },
        );
      }

      // Re-check the barrier: a run dispatched after prepare would be handed to a session
      // that is about to be stopped.
      if (row.from_session_id) {
        const stillActive = this.runs.activeRunsOwnedBy(row.from_session_id);
        if (stillActive.length > 0) {
          return deny(
            ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS,
            "the outgoing CTO acquired active runs after the switchover was prepared",
            { handoffId, activeRuns: stillActive.map((r) => r.runId) },
          );
        }
      }

      this.db.run(
        `UPDATE handoffs SET status = 'ACKED', acked_at = ?, ack_by_session_id = ? WHERE handoff_id = ?`,
        [this.clock.nowIso(), acknowledgement.sessionId, handoffId],
      );

      const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: row.project_id });
      const switched = this.bindings.switchTo({
        roleKey,
        role: Role.PRIMARY_CTO,
        sessionId: acknowledgement.sessionId,
        projectId: row.project_id,
        mode: "PREFERRED",
        reason: `handoff ${handoffId} acknowledged`,
        // #493 — a handoff acknowledged by a different session is a different CTO taking the role.
        conversation: "REPLACED",
      });
      if (!switched.allowed) return switched;

      if (row.from_session_id) {
        this.sessions.transition(row.from_session_id, SessionLifecycle.STOPPED, "handoff complete");
      }

      this.audit.record({
        kind: "HANDOFF_ACK",
        projectId: row.project_id,
        sessionId: acknowledgement.sessionId,
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
      if (!session || !isUnavailable(session.lifecycle)) {
        return deny(
          ReasonCode.RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER,
          "the bound CTO has no durable unavailable/error evidence; use a normal replacement instead",
          { projectId, sessionId: current.sessionId, lifecycle: session?.lifecycle ?? null },
        );
      }
    }

    const recovery = this.buildRecoveryPackage(projectId, reason);
    const incoming = await this.spawn(projectId, "acting-cto-recovery");
    if (!incoming.allowed) return incoming as Decision<RoleBinding>;

    // #664 — this body's own handoff-record write must not survive a denial, including
    // one that comes back from the nested `bindings.switchTo` call below.
    const takeover = this.db.txDecision(() => {
      // `spawn` awaits provider work. Do not let a session that recovered, or a binding
      // that moved in that interval, be displaced by a stale emergency decision.
      const currentNow = this.bindings.active(roleKey);
      if (
        (current &&
          (!currentNow ||
            currentNow.sessionId !== current.sessionId ||
            currentNow.bindingGeneration !== current.bindingGeneration ||
            !isUnavailable(this.sessions.get(current.sessionId)?.lifecycle))) ||
        (!current && currentNow)
      ) {
        return deny<RoleBinding>(
          ReasonCode.WRITE_BINDING_GENERATION_STALE,
          "the owner binding or its unavailable evidence changed during recovery preparation",
          {
            projectId,
            expectedGeneration: current?.bindingGeneration ?? null,
            currentGeneration: currentNow?.bindingGeneration ?? null,
          },
        );
      }
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

      // §10.3 — a takeover: the switch repoints every run the dead generation owned inside
      // the same transaction, so no run is left pinned to a revoked generation.
      const switched = this.bindings.switchTo({
        roleKey,
        role: Role.PRIMARY_CTO,
        sessionId: incoming.value,
        projectId,
        mode: "FALLBACK",
        reason: `recovery takeover: ${reason}`,
        // #493 — fallback promotion installs a different counterpart, not a new runtime for the same one.
        conversation: "REPLACED",
        takeover: true,
      });
      if (!switched.allowed) return switched;

      if (current) {
        this.sessions.transition(current.sessionId, SessionLifecycle.ERROR, "recovery takeover");
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
    if (!takeover.allowed) {
      await this.stopUnusedSession(incoming.value, "recovery takeover refused");
    }
    return takeover;
  }

  /** §10.4 — capacity-driven suspend. Owner approval is mandatory. */
  async suspendProject(
    projectId: string,
    ownerApproved: boolean,
    reason: string,
    owner?: { channel: string; actor: string },
  ): Promise<Decision<void>> {
    // §14.6 — suspension is an owner decision. A bare boolean is a claim, not an
    // authorisation, so an allowlisted owner identity has to carry it.
    if (ownerApproved) {
      const authorised =
        owner && this.#ownerAuthority?.isAllowedActor(owner.channel, owner.actor) === true;
      if (!authorised) {
        return deny(
          ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
          this.#ownerAuthority
            ? "owner approval must come from an allowlisted owner identity"
            : "no owner authority is configured, so an owner approval cannot be attributed",
          { projectId, channel: owner?.channel ?? null, actor: owner?.actor ?? null },
        );
      }
    }

    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const current = this.bindings.active(roleKey);
    const session = current ? this.sessions.require(current.sessionId) : null;
    // #664 — a denial from a later run's BLOCKED checkpoint, or from the DRAINING
    // transition, must not leave an earlier iteration's write (or the recovery INSERT)
    // committed. This is independent of the durability note below: that note is about
    // this transaction committing as a whole and the *external* provider stop failing
    // afterward, which txDecision does not change — it only closes the gap where a
    // denial *inside* this body left partial writes behind it.
    const prepared = this.db.txDecision(() => {
      const suspended = this.projects.setSuspended(projectId, true, ownerApproved);
      if (!suspended.allowed) return suspended;
      if (!current || !session) return allow(ReasonCode.OK, undefined);

      // The recovery package captures ownership before active runs are checkpointed. It
      // remains durable when provider cleanup later fails, so suspension can be retried
      // without pretending that those executions vanished.
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
      for (const run of this.runs.activeRunsOwnedBy(current.sessionId)) {
        if (run.state === RunState.ACTIVE) {
          const checkpointed = this.runs.transition(run.runId, RunState.BLOCKED, "project capacity suspended");
          if (!checkpointed.allowed) return checkpointed as Decision<void>;
        }
      }

      // #692 — this has to run, and deny, from *inside* this transaction, before the
      // DRAINING transition below — not after it as a separate step once this has
      // already committed. LIVE_RUN_STATES (binding-registry.ts) counts QUEUED,
      // READY_FOR_CEO_REVIEW, CEO_APPROVED, MERGING, POST_MERGE_VERIFYING,
      // REVISION_REQUIRED and AWAITING_HUMAN as live, and the checkpoint loop above only
      // moves ACTIVE runs to BLOCKED — a run parked in any of the others refuses the
      // later revoke every single time, not as a race but as an ordinary outcome. A
      // refusal here has to roll back the suspended flag, the recovery insert and the
      // checkpoint above with it (this is a txDecision, not a tx, precisely so a `deny`
      // unwinds all three) — otherwise every one of those writes survives a refused
      // suspend, including the DRAINING transition that follows, and DRAINING blocks
      // dispatch (RUN_DISPATCH_BLOCKED_CTO_DRAINING) with no run left to retry against.
      const preflight = this.bindings.revocationBlockers(roleKey, { allowBlockedRuns: true });
      if (preflight.length > 0) {
        return deny(
          ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS,
          "the active binding owns live runs and cannot be revoked without a takeover",
          { projectId, roleKey, runs: preflight.map((run) => run.run_id) },
        );
      }

      if (session.lifecycle === SessionLifecycle.READY) {
        const draining = this.sessions.transition(current.sessionId, SessionLifecycle.DRAINING, "project suspended");
        if (!draining.allowed) return draining as Decision<void>;
      }
      return allow(ReasonCode.OK, undefined);
    });
    if (!prepared.allowed) return prepared;

    if (current && session) {
      if (session.lifecycle !== SessionLifecycle.STOPPED) {
        // The preflight above already refused this call, atomically with every write it
        // would have needed to undo, whenever a live run blocked it. Nothing yields
        // between that check committing and the `stopSession()` await below — so there
        // is no second window to re-check here — until the await itself, which is the
        // one gap this preflight can never close: a run that reactivates *during* that
        // await is invisible to any check that runs before it, and still reaches the
        // compensation path after it (see the `completed` tx below).
        try {
          await this.providers.require(session.provider).stopSession({
            externalSessionId: current.sessionId,
            provider: session.provider,
            model: session.model,
            effort: session.effort,
            pid: session.osPid,
          });
        } catch (error) {
          this.db.tx(() => {
            const latest = this.sessions.require(current.sessionId);
            if (latest.lifecycle === SessionLifecycle.READY || latest.lifecycle === SessionLifecycle.DRAINING) {
              this.sessions.transition(current.sessionId, SessionLifecycle.ERROR, "provider stop failed");
            }
            this.projects.setAvailability(projectId, "UNAVAILABLE", "provider stop failed during suspension");
            this.audit.record({
              kind: "PROJECT_SUSPEND_RUNTIME_STOP_FAILED",
              reasonCode: ReasonCode.SESSION_STOP_FAILED,
              projectId,
              sessionId: current.sessionId,
              evidence: { reason, error: error instanceof Error ? error.message : String(error) },
            });
          });
          return deny(ReasonCode.SESSION_STOP_FAILED, "CTO runtime stop failed; cleanup remains pending", {
            projectId,
            sessionId: current.sessionId,
          });
        }
      }

      // #692 — `stopped` below writes and commits, and `bindings.revoke()` can still
      // deny (e.g. a concurrent `resolveEscalation` flips a BLOCKED run back to ACTIVE
      // during the `stopSession()` await above — the one gap the preflight check cannot
      // see, because nothing runs between it and the provider call). This stays a plain
      // `tx()`, not `txDecision()`: by this point the external provider has already been
      // told to stop (on this attempt, or — if `session` was already STOPPED above — on
      // an earlier one) and that is not reversible, so rolling the STOPPED write back
      // would leave the session record disagreeing with reality.
      //
      // A denial here is compensated below, in the *same* transaction as the STOPPED
      // write — not a project-level flag written afterward. A separate write needs its
      // own restore path (what un-marks it on a later successful retry?) and its own
      // atomicity (a crash between the two transactions leaves the fact without its
      // explanation). Neither problem exists for a fact the rows already carry: an
      // active binding whose session is STOPPED *is* "revoke denied after an
      // irreversible stop" — doctor.ts's CTO_BINDING_POINTS_AT_DEAD_SESSION check
      // (CRITICAL) already reads exactly this join, so there is nothing further to mark
      // for an operator to see it, and nothing to remember to clear: the moment a later
      // retry's revoke succeeds, the binding is no longer active and the fact is gone
      // on its own. The audit record stays, but moves inside this transaction so it
      // commits atomically with the STOPPED write it explains, with no window where one
      // exists without the other.
      const completed = this.db.tx(() => {
        const fresh = this.bindings.active(roleKey);
        if (
          !fresh ||
          fresh.sessionId !== current.sessionId ||
          fresh.bindingGeneration !== current.bindingGeneration
        ) {
          return deny<void>(
            ReasonCode.WRITE_BINDING_GENERATION_STALE,
            "the CTO binding changed while runtime shutdown was in progress",
            {
              projectId,
              expectedGeneration: current.bindingGeneration,
              currentGeneration: fresh?.bindingGeneration ?? null,
            },
          );
        }
        const stopped = this.sessions.transition(current.sessionId, SessionLifecycle.STOPPED, "project suspended");
        if (!stopped.allowed) return stopped as Decision<void>;
        // Suspension is the one deliberate exception to a normal revocation: every
        // owned run was checkpointed to BLOCKED above and cannot regain authority from
        // this revoked binding. Any runnable state still refuses the revocation.
        const revoked = this.bindings.revoke(roleKey, `project suspended: ${reason}`, {
          allowBlockedRuns: true,
        });
        if (!revoked.allowed && revoked.reasonCode === ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS) {
          // `stopped` above only reaches this line once it has itself already succeeded
          // and committed within this same transaction, so this denial means the
          // session really is stopped and the binding really did just outlive it —
          // recorded here, atomically with that write, not after it.
          this.audit.record({
            kind: "PROJECT_SUSPEND_BINDING_REVOKE_FAILED",
            reasonCode: ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS,
            projectId,
            sessionId: current.sessionId,
            roleKey,
            evidence: { reason, deniedEvidence: revoked.evidence },
          });
        }
        return revoked;
      });
      if (!completed.allowed) {
        if (completed.reasonCode !== ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS) return completed;
        return deny(
          ReasonCode.SESSION_STOPPED_BINDING_REVOKE_FAILED,
          "the runtime stop completed but the binding could not be revoked; the binding now outlives its stopped session",
          { projectId, sessionId: current.sessionId, roleKey },
        );
      }
    }

    this.audit.record({
      kind: "PROJECT_SUSPENDED",
      projectId,
      evidence: { reason, ownerApproved, bindingRemoved: Boolean(current) },
    });
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * §10.4 — undoes `setSuspended`'s ordinary suspend prep, not just the flag it wrote.
   *
   * A successful suspend leaves the primary CTO's session in DRAINING (the FSM
   * (session-registry.ts LEGAL_LIFECYCLE) declares `DRAINING -> READY` legal precisely
   * so this has somewhere to go back to). Clearing only `projects.suspended` and leaving
   * the session in DRAINING would make that a lie: dispatch refuses a DRAINING CTO with
   * RUN_DISPATCH_BLOCKED_CTO_DRAINING (spawn(), run-engine.ts) regardless of the project
   * flag, so the project would stay wedged with nothing left to retry against. This does
   * not touch a session already STOPPED — the provider was actually told to stop and
   * that is not reversible; resuming a suspend that went all the way through means a
   * fresh CTO spawns on the next dispatch, exactly like any other dead binding.
   */
  resumeProject(projectId: string): Decision<void> {
    return this.db.txDecision(() => {
      const resumed = this.projects.setSuspended(projectId, false, true);
      if (!resumed.allowed) return resumed;

      const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
      const current = this.bindings.active(roleKey);
      if (!current) return allow(ReasonCode.OK, undefined);
      const session = this.sessions.get(current.sessionId);
      if (session?.lifecycle === SessionLifecycle.DRAINING) {
        const restored = this.sessions.transition(current.sessionId, SessionLifecycle.READY, "project resumed");
        if (!restored.allowed) return restored as Decision<void>;
      }
      return allow(ReasonCode.OK, undefined);
    });
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

    // A provider implementation may start a live runtime from `startSession`. Prepare the
    // owner-only channel first, so that runtime never races a not-yet-listening credential
    // endpoint. In the daemon this happens only after its single-instance lock is acquired.
    if (this.#sessionLaunch) {
      const prepared = await this.#sessionLaunch.prepare();
      if (!prepared.allowed) return prepared as Decision<string>;
    }

    const handle = await adapter.startSession({
      model: this.preference.model,
      effort: this.preference.effort,
      workdir: this.managedRuntimeRoot,
      purpose,
    });
    const session = this.sessions.create({
      provider: adapter.provider,
      model: this.preference.model,
      effort: this.preference.effort,
      sessionId: `ses_cto_${handle.externalSessionId.replace(/-/g, "").slice(0, 20)}`,
      incarnation: `${handle.externalSessionId}#${this.clock.nowIso()}`,
      osPid: handle.pid,
      // The adapter's answer is accepted only if it is inside the root this daemon manages.
      // `sessions_workdir_immutable` is BEFORE UPDATE, so whatever is written here becomes a
      // permanent routing fact — an adapter that echoes its own cwd would pin the session to
      // it forever. The shipped adapters echo `spec.workdir`; that is caller courtesy, and
      // this is the check that does not depend on it.
      workdir: containedWorkdir(handle.workdir, this.managedRuntimeRoot),
    });

    // `SessionRegistry.create` is intentionally the only issuer of the plaintext secret.
    // The normal daemon attaches a one-time local launch channel, so a freshly spawned
    // replacement receives the credential before it is allowed to acknowledge a handoff.
    // A direct in-process composition (for example, an offline diagnostic) has no runtime
    // to provision and therefore leaves this optional rather than manufacturing a second,
    // weaker delivery path here.
    if (this.#sessionLaunch) {
      if (!session.sessionSecret) {
        this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "session secret storage unavailable");
        return deny(
          ReasonCode.SESSION_SECRET_STORAGE_UNAVAILABLE,
          "a spawned CTO cannot receive its session credential because secret storage is unavailable",
          { sessionId: session.sessionId },
        );
      }
      const provisioned = await this.#sessionLaunch.provision({
        sessionId: session.sessionId,
        sessionIncarnation: session.incarnation,
        externalSessionId: handle.externalSessionId,
        sessionSecret: session.sessionSecret,
      });
      if (!provisioned.allowed) {
        this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "session launch credential provisioning failed");
        return provisioned as Decision<string>;
      }
    }

    if (this.#buzz) {
      const connected = await this.#buzz.connect(session.sessionId, `${purpose}:${projectId}`);
      if (!connected.allowed) {
        this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "buzz connect failed");
        return connected as Decision<string>;
      }
      this.sessions.setBuzzAddress(session.sessionId, connected.value);
    }

    // A started session is not a reachable one: `probeRuntime` above only proved the
    // binary answers. Only an authenticated answer about *this* handle may turn the
    // session READY, or the CTO role is handed to a runtime nobody has spoken to.
    const live = await probeSessionHealth(adapter, handle);
    if (!live.allowed) {
      this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "provider session probe failed");
      return live as Decision<string>;
    }

    this.sessions.transition(session.sessionId, SessionLifecycle.READY, "provider session verified");

    if (this.#readiness) {
      const ready = await this.#readiness.checkSession(session.sessionId);
      if (!ready.allowed) {
        this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "readiness failed");
        return ready as Decision<string>;
      }
    }

    return allow(ReasonCode.OK, session.sessionId);
  }

  /**
   * §14.3 / §25.6 — provider proof that the session behind an existing binding is still
   * the session the provider has. The handle is reconstructed from the session record, so
   * the probe addresses the provider's own id rather than the control plane's alias.
   */
  private async probeBoundSession(session: SessionRecord): Promise<Decision<void>> {
    const adapter = this.providers.get(session.provider);
    if (!adapter) {
      return deny(ReasonCode.SESSION_NOT_READY, "no adapter can prove the bound CTO session is live", {
        provider: session.provider,
      });
    }
    return probeSessionHealth(adapter, handleFor(session));
  }

  /** A replacement that never became authoritative must not remain a live orphan. */
  private async stopUnusedSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.lifecycle === SessionLifecycle.STOPPED) return;
    try {
      await this.providers.require(session.provider).stopSession({
        externalSessionId: sessionId,
        provider: session.provider,
        model: session.model,
        effort: session.effort,
        pid: session.osPid,
      });
      this.sessions.transition(sessionId, SessionLifecycle.STOPPED, reason);
    } catch (error) {
      this.sessions.transition(sessionId, SessionLifecycle.ERROR, `${reason}: provider stop failed`);
      this.audit.record({
        kind: "CTO_UNUSED_SESSION_STOP_FAILED",
        reasonCode: ReasonCode.SESSION_STOP_FAILED,
        sessionId,
        evidence: { reason, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

const isUnavailable = (lifecycle: SessionLifecycle | undefined): boolean =>
  lifecycle === SessionLifecycle.ERROR || lifecycle === SessionLifecycle.STOPPED;

/**
 * The provider handle for a session this kernel already constituted. `spawn` records the
 * provider's own session id as the incarnation prefix, which is the only durable copy of
 * it; the control plane's `ses_cto_…` alias means nothing to the runtime.
 */
const handleFor = (session: SessionRecord): SessionHandle => ({
  externalSessionId: session.incarnation.split("#")[0] ?? session.sessionId,
  provider: session.provider,
  model: session.model,
  effort: session.effort,
  pid: session.osPid,
  ...(session.workdir ? { workdir: session.workdir } : {}),
});

/**
 * An adapter that cannot prove the constituted session is authenticated and reachable
 * fails the check: a version banner or a lifecycle row is not session liveness (§14.3),
 * and a DEGRADED answer is not one either.
 */
const probeSessionHealth = async (
  adapter: ProviderAdapter,
  handle: SessionHandle,
): Promise<Decision<void>> => {
  let health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  try {
    health = await adapter.probeSession(handle);
  } catch (error) {
    return deny(ReasonCode.SESSION_NOT_READY, "provider session probe did not complete", {
      provider: adapter.provider,
      probeError: error instanceof Error ? error.message : String(error),
    });
  }
  if (health !== "HEALTHY") {
    return deny(ReasonCode.SESSION_NOT_READY, "provider cannot prove the CTO session is ready", {
      provider: adapter.provider,
      runtimeHealth: health,
    });
  }
  return allow(ReasonCode.OK, undefined);
};

export const missingHandoffFields = (handoff: HandoffPackage): string[] => {
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
