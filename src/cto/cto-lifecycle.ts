import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { isWithin } from "../guard/workspace-probe.ts";
import type { OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import { type SessionLiveness, probeSessionLiveness } from "../daemon/dead-binding-recovery.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { DRIVEN_PRIMARY_CTO_RUNTIME } from "../domain/fixed-role-runtime.ts";
import { Role, type RoleBinding, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import { SELF_CLAIM_EXECUTOR_KIND, defaultProcessAncestryInspector, isAdoptedCanonicalRuntime } from "../registry/canonical-self-claim.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { ProviderAdapter, ProviderRegistry, SessionHandle } from "../runtime/provider.ts";
import { DRIVEN_PRIMARY_CTO_SPAWN_RECORD, drivenPrimaryCtoSessionSql } from "../runtime/provisioned-session-runtime.ts";
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

/**
 * #246 C1b — the real headless runtime a provisioned (non-canonical) CTO session runs on
 * (`ProvisionedSessionRuntime`), as spawn and probe use it: take custody of the session's
 * credential, prove readiness by an authenticated attestation turn, ask the conversation to answer.
 */
export interface ProvisionedRuntimePort {
  adopt(sessionId: string, role: Role, sessionSecret: string, credentialEpoch: number): Decision<void>;
  attest(sessionId: string, conversation: "new" | "resume"): Promise<Decision<void>>;
  release(sessionId: string): void;
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
 * managed runtime root, and the root itself otherwise. Shared with worker provisioning.
 */
export const containedWorkdir = (reported: string | null | undefined, managedRoot: string): string => {
  if (!reported) return managedRoot;
  return reported === managedRoot || isWithin(managedRoot, reported) ? reported : managedRoot;
};

/**
 * Issue #246 C1-04 — the audit kind that records a session spawned for a run's BOOTSTRAP_CTO, under
 * the run's id, in the transaction that creates the session row: before the launch credential,
 * Buzz, the probe or readiness can refuse it, and before any bind. It is how the reclaim sweep
 * (`BootstrapCtoStaffing.reclaim`) finds a spawn that was never bound and whose provider stop
 * failed. Kept as an append-only audit event, as the native start pin is, because the migration
 * list is frozen; it nominates a session for a stop and grants nothing, and the sweep still never
 * stops a session that holds a role.
 */
export const BOOTSTRAP_CTO_SPAWN_RECORD = "BOOTSTRAP_CTO_SESSION_SPAWNED";

/** #246 C1-R1 — one project's switchover a canonical CTO was left in, withdrawn. */
export interface CanonicalSwitchoverWithdrawal {
  projectId: string;
  /** The PENDING normal handoffs closed REJECTED. */
  handoffIds: string[];
  /** Their replacements, marked ERROR with a provider stop pending. */
  replacements: string[];
  /** Whether the canonical holder was DRAINING and is READY again. */
  restored: boolean;
}

/** What `CtoLifecycle.settleCanonicalSwitchovers` did in one pass. */
export interface CanonicalSwitchoverSettlement {
  withdrawn: CanonicalSwitchoverWithdrawal[];
  /** Withdrawn replacements the provider did not stop; the next pass asks again. */
  stopFailed: string[];
}

/** What `CtoLifecycle.spawn` constitutes: the role it serves, its scope, and the runtime it runs. */
interface SpawnRequest {
  /** Selects the role-scoped adapter, so the session runs under that role's credential scope. */
  role: typeof Role.PRIMARY_CTO | typeof Role.BOOTSTRAP_CTO;
  /** The project a PRIMARY_CTO, or the run a BOOTSTRAP_CTO, is constituted for. */
  scope: string;
  purpose: string;
  runtime: CtoPreference;
  canonicalGuard?: { roleKey: string; runId: string | undefined };
  /** Have the provider stop the session on a refusal after it started, not only record it ERROR. */
  stopOnRefusal?: boolean;
  /** Record the session as spawned for this run, with the session row (`BOOTSTRAP_CTO_SPAWN_RECORD`). */
  spawnedForRun?: string;
  /**
   * #246 C4 — a PRIMARY_CTO for the project this bootstrap run activates, driven on the headless
   * runtime: recorded so with the session row (`DRIVEN_PRIMARY_CTO_SPAWN_RECORD`), under this run.
   */
  drivenForActivation?: string;
}

export class CtoLifecycle {
  #buzz: BuzzConnector | null = null;
  #readiness: ReadinessProbe | null = null;
  #ownerAuthority: OwnerAuthorityPort | null = null;
  #handoffAuthentication: HandoffAuthentication | null = null;
  #sessionLaunch: SessionLaunchChannel | null = null;
  #sessionRuntime: ProvisionedRuntimePort | null = null;

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
    sessionRuntime?: ProvisionedRuntimePort;
  }): void {
    if (ports.sessionRuntime) this.#sessionRuntime = ports.sessionRuntime;
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
    return this.#ensurePrimaryCto(projectId, runId, false);
  }

  /**
   * #246 C4 — the PRIMARY_CTO a bootstrap activation provisions for the project it activates: the
   * same lineage checks, spawn and binding as `ensurePrimaryCto`, but the spawn is a fresh session
   * of its own, in its own workdir, on Claude Opus (`DRIVEN_PRIMARY_CTO_RUNTIME`), driven by the
   * headless runtime and recorded so with its session row. Only a PROJECT_BOOTSTRAP run asks for
   * one. An existing binding is answered exactly as `ensurePrimaryCto` answers it.
   *
   * A door of its own rather than the run's kind read inside `ensurePrimaryCto`: the caller states
   * that it is an activation, and the activation switches to this door together with its fixtures.
   */
  async ensureDrivenPrimaryCto(projectId: string, bootstrapRunId: string): Promise<Decision<RoleBinding>> {
    const run = this.runs.get(bootstrapRunId);
    if (run?.kind !== RunKind.PROJECT_BOOTSTRAP) {
      return deny(ReasonCode.INVALID_ARGUMENT, "only a bootstrap activation provisions a driven primary CTO", {
        projectId,
        runId: bootstrapRunId,
        kind: run?.kind ?? null,
      });
    }
    return this.#ensurePrimaryCto(projectId, bootstrapRunId, true);
  }

  async #ensurePrimaryCto(projectId: string, runId: string, driven: boolean): Promise<Decision<RoleBinding>> {
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const existing = this.bindings.active(roleKey);
    if (existing) {
      const session = this.sessions.get(existing.sessionId);
      // #246 C4 — a driven session is asked by an authenticated attestation turn that resumes its
      // conversation, never by opening its id again, and is never replaced by another session.
      if (this.#spawnedDriven(existing.sessionId)) return this.#reuseDrivenPrimaryCto(existing, session, runId);
      if (session?.lifecycle === SessionLifecycle.READY) {
        // READY is what the control plane last wrote about the session, not proof that the
        // provider still has one. Reusing a session on that alone is the false-ready path
        // §14.3 exists to close, so the provider has to answer for the exact session first —
        // except an adopted canonical CTO, which no provider launched; its process answers.
        if (this.#isAdoptedCanonical(existing)) return this.#dispatchToAdoptedCanonical(existing, session, runId);
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

    // A released canonical role is not given a spawned CTO either; its conversation re-claims it.
    const released = this.#releasedCanonicalHolder(projectId, roleKey);
    if (released) return this.#refuseAdoptedCanonical(released, null, null, runId);
    const runtime: CtoPreference = driven ? { ...DRIVEN_PRIMARY_CTO_RUNTIME, effort: null } : this.preference;
    const created = await this.spawn({
      role: Role.PRIMARY_CTO,
      scope: projectId,
      purpose: "primary-cto",
      runtime,
      canonicalGuard: { roleKey, runId },
      ...(driven ? { drivenForActivation: runId } : {}),
    });
    if (!created.allowed) return created as Decision<RoleBinding>;

    // A canonical claim that landed after `spawn`'s pre-launch check is refused in the transaction
    // that would bind; the launched session is stopped rather than left a live orphan.
    const bound = this.db.txDecision(() => {
      if (this.#releasedCanonicalHolder(projectId, roleKey)) {
        return deny<RoleBinding>(ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM, "the role became canonical during provisioning", { projectId });
      }
      return this.bindings.bind({ roleKey, role: Role.PRIMARY_CTO, sessionId: created.value, projectId, mode: "PREFERRED" });
    });
    if (!bound.allowed && bound.reasonCode === ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM) {
      const claimed = this.#releasedCanonicalHolder(projectId, roleKey);
      await this.stopUnusedSession(created.value, "canonical role claimed during provisioning");
      return claimed ? this.#refuseAdoptedCanonical(claimed, null, null, runId) : bound;
    }
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
      evidence: {
        generation: bound.value.bindingGeneration,
        provider: runtime.provider,
        ...(driven ? { driven: true } : {}),
      },
    });
    return bound;
  }

  /**
   * #246 C4 — an existing binding held by a driven PRIMARY_CTO: reused when an attestation turn that
   * resumes its own conversation proves the daemon still drives it with its current credential, and
   * refused otherwise. Never `--session-id` (the provider refuses to open a conversation it already
   * has), never marked ERROR and never taken over by another session: a driven session is recovered
   * on itself.
   */
  async #reuseDrivenPrimaryCto(
    existing: RoleBinding,
    session: SessionRecord | null,
    runId: string,
  ): Promise<Decision<RoleBinding>> {
    if (session?.lifecycle === SessionLifecycle.DRAINING) {
      return deny(ReasonCode.RUN_DISPATCH_BLOCKED_CTO_DRAINING, "primary CTO is draining", {
        projectId: existing.projectId,
        sessionId: existing.sessionId,
      });
    }
    const live = await this.probeRoleSession(existing.sessionId, Role.PRIMARY_CTO);
    if (live.allowed) return allow(ReasonCode.OK, existing);
    this.audit.record({
      kind: "CTO_SESSION_PROBE_FAILED",
      reasonCode: live.reasonCode,
      projectId: existing.projectId,
      runId,
      sessionId: existing.sessionId,
      roleKey: existing.roleKey,
      evidence: { provider: session?.provider ?? null, driven: true, ...live.evidence },
    });
    return live as Decision<RoleBinding>;
  }

  /** Whether this session's own spawn recorded it as a driven PRIMARY_CTO (`DRIVEN_PRIMARY_CTO_SPAWN_RECORD`). */
  #spawnedDriven(sessionId: string): boolean {
    return this.db.get<{ driven: number }>(`SELECT ${drivenPrimaryCtoSessionSql("?")} AS driven`, [sessionId])?.driven === 1;
  }

  /** §10.1 — replacement requested: the outgoing CTO drains, new runs queue. */
  requestReplacement(projectId: string, reason: string): Decision<{ draining: boolean; activeRuns: number }> {
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const current = this.bindings.active(roleKey);
    if (!current) return deny(ReasonCode.NOT_FOUND, "project has no primary CTO", { projectId });

    // #246 C1-R1 — a canonical CTO is never replaced, so it is never drained for a replacement the
    // handoff would then refuse: refused here, before anything is written, by the switchover guard.
    const canonical = this.#canonicalHolderOf(projectId, roleKey, current);
    if (canonical) return this.#canonicalHandoffDenial<{ draining: boolean; activeRuns: number }>(canonical, null);

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

    // #246 C1-05 — a canonical CTO is never swapped for a spawned replacement: the guard initial
    // staffing and recovery takeover use, asked before anything is spawned and again in the
    // transaction after the spawn's await.
    const canonical = this.#canonicalHolderOf(projectId, roleKey, current);
    if (canonical) return this.#canonicalHandoffDenial<{ handoffId: string; incomingSessionId: string }>(canonical, null);

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

    const incoming = await this.spawn({
      role: Role.PRIMARY_CTO,
      scope: projectId,
      purpose: "primary-cto-replacement",
      runtime: this.preference,
    });
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
      // C1-05 — nor be prepared for a holder that became canonical during that await.
      const claimed = this.#canonicalHolderOf(projectId, roleKey, fresh);
      if (claimed) return this.#canonicalHandoffDenial<{ handoffId: string; incomingSessionId: string }>(claimed, null);
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
    // #246 C1-R1 — a PENDING handoff whose outgoing holder is canonical can never be acknowledged,
    // so it is withdrawn here rather than refused and left: the holder leaves DRAINING, the handoff
    // closes and its replacement is stopped. Done before the transaction below, because a refusal
    // from inside that one rolls back every write it made.
    const withdrawn = this.#withdrawCanonicalHandoff(handoffId);
    if (withdrawn) return withdrawn;

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

      // #246 C1-05 — nor is one acknowledged whose outgoing holder is canonical (prepared by a
      // build before the preparation guard, or its holder canonical since): the switch below would
      // replace the canonical conversation and stop its session.
      const canonical = this.#canonicalHolderOf(row.project_id, roleKeyForAck, currentBinding);
      if (canonical) return this.#canonicalHandoffDenial<RoleBinding>(canonical, handoffId);

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
      // A canonical role is never given a spawned replacement; its own conversation re-claims it.
      if (this.#isAdoptedCanonical(current)) return this.#refuseAdoptedCanonical(current, session, null, runId);
    } else {
      const released = this.#releasedCanonicalHolder(projectId, roleKey);
      if (released) return this.#refuseAdoptedCanonical(released, null, null, runId);
    }

    const recovery = this.buildRecoveryPackage(projectId, reason);
    const incoming = await this.spawn({
      role: Role.PRIMARY_CTO,
      scope: projectId,
      purpose: "acting-cto-recovery",
      runtime: this.preference,
      canonicalGuard: { roleKey, runId },
    });
    if (!incoming.allowed) return incoming as Decision<RoleBinding>;

    // #664 — this body's own handoff-record write must not survive a denial, including
    // one that comes back from the nested `bindings.switchTo` call below.
    const takeover = this.db.txDecision(() => {
      // A canonical claim that landed after `spawn`'s pre-launch check, even one released again,
      // leaves no trace in the active binding, so the lineage is what is read here.
      if (this.#releasedCanonicalHolder(projectId, roleKey)) {
        return deny<RoleBinding>(ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM, "the role became canonical during recovery", { projectId });
      }
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
      const claimed = takeover.reasonCode === ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM
        ? this.#releasedCanonicalHolder(projectId, roleKey)
        : null;
      await this.stopUnusedSession(incoming.value, "recovery takeover refused");
      if (claimed) return this.#refuseAdoptedCanonical(claimed, null, null, runId);
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
      if (session.lifecycle === SessionLifecycle.READY) {
        const draining = this.sessions.transition(current.sessionId, SessionLifecycle.DRAINING, "project suspended");
        if (!draining.allowed) return draining as Decision<void>;
      }
      return allow(ReasonCode.OK, undefined);
    });
    if (!prepared.allowed) return prepared;

    if (current && session && session.lifecycle !== SessionLifecycle.STOPPED) {
      try {
        await this.stopProviderSession(session);
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

      // #692 chooses compensation (b), not a new "stop succeeded, revoke pending" state.
      // STOPPED is already the durable fact after the irreversible provider call. Re-derive
      // the revocation precondition from that fact: a CEO resolution that reactivated a
      // checkpointed run after the stop no longer has a runnable owner, so checkpoint it
      // again before revoke. A new terminal state would need its own retry, clearing and
      // crash-recovery lifecycle while saying no more about the runtime than STOPPED does.
      // This stays plain `tx()`: rolling STOPPED back on an unexpected cleanup refusal would
      // make the durable session claim that a process exists after the provider stopped it.
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
        for (const run of this.runs.activeRunsOwnedBy(current.sessionId)) {
          if (run.state !== RunState.ACTIVE) continue;
          const reblocked = this.runs.transition(
            run.runId,
            RunState.BLOCKED,
            "owner session stopped during project suspension",
          );
          if (!reblocked.allowed) return reblocked as Decision<void>;
        }
        // Suspension is the one deliberate exception to a normal revocation: every
        // owned run is BLOCKED now that its session is STOPPED and cannot regain authority
        // from this revoked binding. Any runnable state still refuses the revocation.
        return this.bindings.revoke(roleKey, `project suspended: ${reason}`, {
          allowBlockedRuns: true,
        });
      });
      if (!completed.allowed) return completed;
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
      `SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
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

  /**
   * Issue #246 — a run's BOOTSTRAP_CTO, constituted by the same spawn a primary CTO is, on the real
   * headless runtime (C1b): its own fixed workdir, its credential in the runtime driver's custody →
   * Buzz → an authenticated attestation turn that opens its conversation → READY → readiness. It
   * runs on the runtime the caller names, which bootstrap staffing fixes; nothing here substitutes
   * another provider or model. The session is returned unbound — the dispatch transaction binds
   * and pins it — and a refusal after the provider session started stops that session rather than
   * leaving it running.
   */
  async spawnBootstrapCto(runId: string, runtime: CtoPreference): Promise<Decision<string>> {
    return this.spawn({
      role: Role.BOOTSTRAP_CTO,
      scope: runId,
      purpose: "bootstrap-cto",
      runtime,
      stopOnRefusal: true,
      spawnedForRun: runId,
    });
  }

  /**
   * Provider proof that a READY session this lifecycle constituted for `role` is still the session
   * the provider has (§14.3). A row that is not READY is refused without asking.
   */
  async probeRoleSession(sessionId: string, role: Role): Promise<Decision<void>> {
    const session = this.sessions.get(sessionId);
    if (!session || session.lifecycle !== SessionLifecycle.READY) {
      return deny(ReasonCode.SESSION_NOT_READY, "the bound session is not READY", {
        sessionId,
        lifecycle: session?.lifecycle ?? null,
      });
    }
    // #246 C1b — a session on the headless runtime is asked by an authenticated attestation turn
    // that continues its conversation: opening its id again is refused by the provider, and an
    // unauthenticated answer would say nothing about the credential the daemon holds for it.
    // #246 C4 — and so is a PRIMARY_CTO whose spawn recorded it driven; never by its role alone.
    if (role === Role.BOOTSTRAP_CTO || (role === Role.PRIMARY_CTO && this.#spawnedDriven(sessionId))) {
      if (!this.#sessionRuntime) return runtimeUnavailable(sessionId, role);
      return notProvenReady(sessionId, await this.#sessionRuntime.attest(sessionId, "resume"));
    }
    return this.probeBoundSession(session, role);
  }

  /**
   * Stops a session this lifecycle constituted for `role`, through the provider's own handle, and
   * marks it STOPPED. A failed provider stop leaves it ERROR, audited, and is refused.
   */
  async stopRoleSession(sessionId: string, role: Role, reason: string): Promise<Decision<void>> {
    await this.stopUnusedSession(sessionId, reason, role);
    const lifecycle = this.sessions.get(sessionId)?.lifecycle ?? null;
    if (lifecycle === SessionLifecycle.STOPPED) this.#sessionRuntime?.release(sessionId);
    return lifecycle === SessionLifecycle.STOPPED
      ? allow(ReasonCode.OK, undefined)
      : deny(ReasonCode.SESSION_STOP_FAILED, "the provider did not stop the session", { sessionId, lifecycle });
  }

  /**
   * Fresh session → launch credential → Buzz → probe → READY → doctor readiness, for `role` on
   * `runtime`. Any failed step stops the activation.
   *
   * `canonicalGuard` names the role a primary-CTO provisioning fills. The caller checked the role's
   * canonical lineage before calling, and the awaits below can let a canonical claim land (and be
   * released) after that check, so the lineage is read again immediately before the launch. A
   * BOOTSTRAP_CTO is run-scoped work, never a canonical actor, so it carries no guard and its spawn
   * neither reads nor replaces any canonical CEO or CTO.
   */
  private async spawn(request: SpawnRequest): Promise<Decision<string>> {
    const { role, scope, purpose, runtime, canonicalGuard } = request;
    // #246 C1b — a BOOTSTRAP_CTO runs on the real headless runtime, and is refused before anything
    // starts when there is none: readiness then has nothing that could authenticate it. #246 C4 — so
    // does a PRIMARY_CTO a bootstrap activation asked for driven; any other PRIMARY_CTO does not.
    const driven = role === Role.BOOTSTRAP_CTO || (role === Role.PRIMARY_CTO && request.drivenForActivation !== undefined);
    const headless = driven ? this.#sessionRuntime : null;
    if (driven && !headless) return runtimeUnavailable(null, role);
    const adapter = this.providers.hasRoleScoped(runtime.provider)
      ? this.providers.requireForRole(runtime.provider, role)
      : this.providers.get(runtime.provider);
    if (!adapter) {
      return deny(ReasonCode.NOT_FOUND, "no adapter for the preferred CTO provider", {
        provider: runtime.provider,
        role,
      });
    }
    const health = await adapter.probeRuntime();
    if (health === "UNAVAILABLE") {
      return deny(ReasonCode.CAPACITY_ADMISSION_SUSPENDED, "CTO provider runtime is unavailable", {
        provider: runtime.provider,
        role,
      });
    }

    // A provider implementation may start a live runtime from `startSession`. Prepare the
    // owner-only channel first, so that runtime never races a not-yet-listening credential
    // endpoint. In the daemon this happens only after its single-instance lock is acquired.
    if (this.#sessionLaunch) {
      const prepared = await this.#sessionLaunch.prepare();
      if (!prepared.allowed) return prepared as Decision<string>;
    }

    if (canonicalGuard) {
      const claimed = this.#releasedCanonicalHolder(scope, canonicalGuard.roleKey);
      if (claimed) return this.#refuseAdoptedCanonical<string>(claimed, null, null, canonicalGuard.runId);
    }
    // A headless session's conversation is addressed per working directory, so it gets one of its
    // own, fixed for its life (`sessions_workdir_immutable`), below the managed root.
    const workdir = headless
      ? join(this.managedRuntimeRoot, "sessions", randomUUID())
      : this.managedRuntimeRoot;
    if (headless) ensurePrivateDirectory(workdir);
    const handle = await adapter.startSession({
      model: runtime.model,
      effort: runtime.effort,
      workdir,
      purpose,
    });
    // Recorded with its native start pinned beside the lstart, read as one snapshot of one process
    // (ACP1045-R2-01, R3-01); see `SessionRegistry.createWithPinnedStart`.
    let session: ReturnType<SessionRegistry["createWithPinnedStart"]>;
    try {
      // The row and, for a run's bootstrap CTO, its spawn record are one write: no refusal below
      // can leave a session the reclaim sweep has no record of (#246 C1-04).
      session = this.db.tx(() => {
        const created = this.sessions.createWithPinnedStart({
          provider: adapter.provider,
          model: runtime.model,
          effort: runtime.effort,
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
        if (request.spawnedForRun !== undefined) {
          this.audit.record({
            kind: BOOTSTRAP_CTO_SPAWN_RECORD,
            runId: request.spawnedForRun,
            sessionId: created.sessionId,
            evidence: { role, provider: adapter.provider, model: runtime.model, purpose },
          });
        }
        // #246 C4 — the one fact that makes a PRIMARY_CTO driven, written with its session row: the
        // runtime adopts its credential, the outbox routes to it in band and its probes resume its
        // conversation only because this row exists. Append-only, so it is never added later.
        if (headless && role === Role.PRIMARY_CTO) {
          this.audit.record({
            kind: DRIVEN_PRIMARY_CTO_SPAWN_RECORD,
            runId: request.drivenForActivation ?? null,
            projectId: scope,
            sessionId: created.sessionId,
            evidence: { role, provider: adapter.provider, model: runtime.model, purpose },
          });
        }
        return created;
      });
    } catch (error) {
      if (request.stopOnRefusal) await adapter.stopSession(handle).catch(() => undefined);
      throw error;
    }
    // A refusal from here on has a provider session behind it. Every role records it ERROR; a role
    // that asked for it (a run's bootstrap CTO) also has the provider stop it, so no refused spawn
    // is left running.
    const refuse = async <T>(reason: string, refused: Decision<T>): Promise<Decision<T>> => {
      headless?.release(session.sessionId);
      this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, reason);
      if (request.stopOnRefusal) {
        try {
          await adapter.stopSession(handle);
          this.sessions.transition(session.sessionId, SessionLifecycle.STOPPED, `${reason}: stopped`);
        } catch (error) {
          this.audit.record({
            kind: "CTO_UNUSED_SESSION_STOP_FAILED",
            reasonCode: ReasonCode.SESSION_STOP_FAILED,
            sessionId: session.sessionId,
            evidence: { reason, role, error: error instanceof Error ? error.message : String(error) },
          });
        }
      }
      return refused;
    };

    // `SessionRegistry.create` is intentionally the only issuer of the plaintext secret.
    // The normal daemon attaches a one-time local launch channel, so a freshly spawned
    // replacement receives the credential before it is allowed to acknowledge a handoff.
    // A direct in-process composition (for example, an offline diagnostic) has no runtime
    // to provision and therefore leaves this optional rather than manufacturing a second,
    // weaker delivery path here.
    if (headless) {
      // The plaintext goes into the runtime driver's custody and nowhere else; each of the
      // session's turns is offered it on the launch channel for that turn alone.
      if (!session.sessionSecret) {
        return refuse("session secret storage unavailable", deny<string>(
          ReasonCode.SESSION_SECRET_STORAGE_UNAVAILABLE,
          "a spawned CTO cannot receive its session credential because secret storage is unavailable",
          { sessionId: session.sessionId },
        ));
      }
      const adopted = headless.adopt(session.sessionId, role, session.sessionSecret, session.credentialEpoch);
      if (!adopted.allowed) return refuse("session runtime refused the credential", adopted as Decision<string>);
    } else if (this.#sessionLaunch) {
      if (!session.sessionSecret) {
        return refuse("session secret storage unavailable", deny<string>(
          ReasonCode.SESSION_SECRET_STORAGE_UNAVAILABLE,
          "a spawned CTO cannot receive its session credential because secret storage is unavailable",
          { sessionId: session.sessionId },
        ));
      }
      const provisioned = await this.#sessionLaunch.provision({
        sessionId: session.sessionId,
        sessionIncarnation: session.incarnation,
        externalSessionId: handle.externalSessionId,
        sessionSecret: session.sessionSecret,
      });
      if (!provisioned.allowed) {
        return refuse("session launch credential provisioning failed", provisioned as Decision<string>);
      }
    }

    if (this.#buzz) {
      const connected = await this.#buzz.connect(session.sessionId, `${purpose}:${scope}`);
      if (!connected.allowed) {
        return refuse("buzz connect failed", connected as Decision<string>);
      }
      this.sessions.setBuzzAddress(session.sessionId, connected.value);
    }

    // A started session is not a reachable one: `probeRuntime` above only proved the
    // binary answers. Only an authenticated answer about *this* handle may turn the
    // session READY, or the CTO role is handed to a runtime nobody has spoken to. On the
    // headless runtime that answer is the attestation: the first turn of the session's own
    // conversation, whose relay authenticates with the delivered credential and presents a
    // challenge the daemon minted (#246 C1b).
    const live = headless
      ? notProvenReady(session.sessionId, await headless.attest(session.sessionId, "new"))
      : await probeSessionHealth(adapter, handle);
    if (!live.allowed) {
      return refuse(headless ? "session attestation failed" : "provider session probe failed", live as Decision<string>);
    }

    this.sessions.transition(session.sessionId, SessionLifecycle.READY, "provider session verified");

    if (this.#readiness) {
      const ready = await this.#readiness.checkSession(session.sessionId);
      if (!ready.allowed) {
        return refuse("readiness failed", ready as Decision<string>);
      }
    }

    return allow(ReasonCode.OK, session.sessionId);
  }

  /**
   * §14.3 / §25.6 — provider proof that the session behind an existing binding is still
   * the session the provider has. The handle is reconstructed from the session record, so
   * the probe addresses the provider's own id rather than the control plane's alias.
   */
  private async probeBoundSession(session: SessionRecord, role: Role = Role.PRIMARY_CTO): Promise<Decision<void>> {
    const adapter = this.providers.hasRoleScoped(session.provider)
      ? this.providers.requireForRole(session.provider, role)
      : this.providers.get(session.provider);
    if (!adapter) {
      return deny(ReasonCode.SESSION_NOT_READY, "no adapter can prove the bound CTO session is live", {
        provider: session.provider,
      });
    }
    return probeSessionHealth(adapter, handleFor(session));
  }

  /**
   * Whether the binding is held by an adopted canonical CTO: an interactive runtime the canonical
   * self-claim bound, which no provider adapter launched and so none can answer for or replace.
   * Read from durable state — the holding actor's lifetime `SELF_CLAIM_EXECUTOR_KIND` target and
   * its current runtime being this binding's session — never from a provider or model string.
   * The rule is the shared one the outbox's in-band delivery reads, scoped to this binding.
   */
  #isAdoptedCanonical(binding: RoleBinding): boolean {
    return isAdoptedCanonicalRuntime(this.db, binding.sessionId, binding.assignmentId);
  }

  /**
   * Where no binding is active, whether the role's latest holder was an adopted canonical CTO: an
   * actor with a `SELF_CLAIM_EXECUTOR_KIND` target at the highest `binding_generation` this role
   * key has ever been granted, ACTIVE or REVOKED. A released canonical binding (`binding
   * recover-dead`, or the dead-binding recovery before the re-claim lands) leaves no actor to ask,
   * and this lineage is the durable fact that the role is still canonical. A role with no history,
   * or whose latest holder is not canonical, answers null and is provisioned as before.
   *
   * Provisioning awaits, and a canonical claim can land — and be released again — inside one of
   * those awaits, which the active binding alone cannot show. So this is asked again after the
   * awaits: just before the launch (`spawn`), and inside the transaction that would bind.
   */
  #releasedCanonicalHolder(projectId: string, roleKey: string): CanonicalHolder | null {
    const latest = this.db.get<{ bindingGeneration: number; sessionId: string; status: "ACTIVE" | "REVOKED" }>(
      `SELECT a.binding_generation AS bindingGeneration, a.session_id AS sessionId, a.status AS status
         FROM assignments a
         JOIN actor_target_bindings tb ON tb.target_actor_id = a.actor_id
        WHERE a.role_key = ? AND tb.executor_kind = ?
          AND a.binding_generation = (SELECT MAX(binding_generation) FROM assignments WHERE role_key = ?)`,
      [roleKey, SELF_CLAIM_EXECUTOR_KIND, roleKey],
    );
    return latest ? { projectId, roleKey, ...latest } : null;
  }

  /**
   * #246 C1-05 — the canonical holder of a PRIMARY_CTO role, by the guard initial staffing and
   * recovery takeover use: the active binding's holder when it is an adopted canonical CTO, else the
   * role's lineage (`#releasedCanonicalHolder`), which also answers for an active canonical actor
   * whose runtime pointer has moved. Null when the role is not canonical.
   */
  #canonicalHolderOf(projectId: string, roleKey: string, current: RoleBinding | null): CanonicalHolder | null {
    if (current && this.#isAdoptedCanonical(current)) {
      return {
        projectId,
        roleKey,
        sessionId: current.sessionId,
        bindingGeneration: current.bindingGeneration,
        status: current.status,
      };
    }
    return this.#releasedCanonicalHolder(projectId, roleKey);
  }

  /**
   * #246 C1-05 — an ordinary handoff never swaps a canonical CTO: it is not prepared (no spawned
   * replacement, no drain) and not acknowledged (no switch, the original session not stopped). The
   * canonical conversation keeps the role. It writes nothing, so a transaction can return it, and
   * like every other handoff refusal it is reported to the caller rather than audited.
   */
  #canonicalHandoffDenial<T>(
    holder: CanonicalHolder,
    handoffId: string | null,
    withdrawal?: CanonicalSwitchoverWithdrawal,
  ): Decision<T> {
    return deny<T>(
      ReasonCode.CANONICAL_CTO_NOT_REPLACEABLE,
      "the outgoing CTO is canonical; a handoff never swaps it for a spawned replacement, its own conversation keeps the role",
      {
        projectId: holder.projectId,
        roleKey: holder.roleKey,
        sessionId: holder.sessionId,
        bindingGeneration: holder.bindingGeneration,
        assignmentStatus: holder.status,
        handoffId,
        ...(withdrawal
          ? { withdrawnHandoffs: withdrawal.handoffIds, stoppingReplacements: withdrawal.replacements, restored: withdrawal.restored }
          : {}),
      },
    );
  }

  /**
   * #246 C1-R1 — the daemon's sweep for switchovers a canonical CTO was left in: a PENDING handoff
   * whose outgoing holder is (or became) canonical, including one a build before the preparation
   * guard left, and a canonical holder a replacement request drained. Each project's is withdrawn
   * in one transaction (`#withdrawCanonicalSwitchover`); then every replacement a withdrawal left
   * ERROR — this pass's, or an earlier one's whose provider stop failed — is stopped through its
   * provider. A provisioned CTO's switchover is not touched, and nothing is ever switched.
   */
  async settleCanonicalSwitchovers(): Promise<CanonicalSwitchoverSettlement> {
    const candidates = this.db.all<{ project_id: string }>(
      `SELECT project_id FROM handoffs WHERE kind = 'HANDOFF' AND status = 'PENDING'
       UNION
       SELECT a.project_id FROM assignments a
         LEFT JOIN conversational_actors c ON c.actor_id = a.actor_id
         JOIN sessions s ON s.session_id = COALESCE(c.current_session_id, a.session_id)
        WHERE a.role = 'PRIMARY_CTO' AND a.status = 'ACTIVE' AND s.lifecycle = 'DRAINING'
        ORDER BY project_id`,
    );
    const withdrawn: CanonicalSwitchoverWithdrawal[] = [];
    for (const { project_id: projectId } of candidates) {
      const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
      const holder = this.#canonicalHolderOf(projectId, roleKey, this.bindings.active(roleKey));
      if (!holder) continue;
      const withdrawal = this.#withdrawCanonicalSwitchover(projectId, "canonical switchover sweep");
      if (withdrawal.handoffIds.length > 0 || withdrawal.restored) withdrawn.push(withdrawal);
    }
    // Every replacement of a withdrawn handoff still waiting for its provider stop.
    const pendingStops = this.db.all<{ session_id: string }>(
      `SELECT DISTINCT h.to_session_id AS session_id
         FROM handoffs h JOIN sessions s ON s.session_id = h.to_session_id
        WHERE h.kind = 'HANDOFF' AND h.status = 'REJECTED' AND s.lifecycle = 'ERROR'
        ORDER BY session_id`,
    ).map((row) => row.session_id);
    const stopFailed = await this.#stopWithdrawnReplacements(pendingStops, "canonical switchover withdrawn");
    return { withdrawn, stopFailed };
  }

  /**
   * #246 C1-R1 — the acknowledgement path's withdrawal: when `handoffId` is a PENDING normal
   * handoff whose project's PRIMARY_CTO is canonical, withdraw that project's switchover, start the
   * replacement's provider stop (the sweep retries one that fails), and answer the refusal. Null
   * when the handoff is not such a one, so the acknowledgement proceeds as before.
   *
   * It runs before the acknowledgement is authenticated, deliberately: the withdrawal grants
   * nothing and switches nothing, it returns the canonical holder to the state every other path
   * already requires, so whoever names the handoff can only bring that about sooner.
   */
  #withdrawCanonicalHandoff(handoffId: string): Decision<RoleBinding> | null {
    const row = this.db.get<{ project_id: string; kind: string; status: string }>(
      `SELECT project_id, kind, status FROM handoffs WHERE handoff_id = ?`,
      [handoffId],
    );
    if (!row || row.kind !== "HANDOFF" || row.status !== "PENDING") return null;
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: row.project_id });
    const holder = this.#canonicalHolderOf(row.project_id, roleKey, this.bindings.active(roleKey));
    if (!holder) return null;
    const withdrawal = this.#withdrawCanonicalSwitchover(row.project_id, `handoff ${handoffId} names a canonical CTO`);
    void this.#stopWithdrawnReplacements(withdrawal.replacements, "canonical handoff withdrawn").catch(() => undefined);
    return this.#canonicalHandoffDenial<RoleBinding>(holder, handoffId, withdrawal);
  }

  /**
   * #246 C1-R1 — one transaction: every PENDING normal handoff of the project is closed REJECTED;
   * each replacement it named that holds no role is marked ERROR, its provider stop pending (a
   * closed handoff's envelope is no longer deliverable, and ERROR fences the rest); and the active
   * holder, if DRAINING for a switchover (`#drainIsSwitchover`, C1-R2) while its project is not
   * suspended, is READY again. Its audit row is the reason the handoffs were closed. Only ever
   * called for a project whose PRIMARY_CTO is canonical; the binding itself is not touched.
   */
  #withdrawCanonicalSwitchover(projectId: string, reason: string): CanonicalSwitchoverWithdrawal {
    return this.db.tx(() => {
      const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
      const pending = this.db.all<{ handoff_id: string; from_session_id: string | null; to_session_id: string }>(
        `SELECT handoff_id, from_session_id, to_session_id FROM handoffs
          WHERE project_id = ? AND kind = 'HANDOFF' AND status = 'PENDING'
          ORDER BY created_at, handoff_id`,
        [projectId],
      );
      const current = this.bindings.active(roleKey);
      const holding = current ? this.sessions.get(current.sessionId) : null;
      const draining = holding?.lifecycle === SessionLifecycle.DRAINING ? holding : null;
      // Attributed before the handoffs below are closed: a PENDING one from the holder is evidence.
      const switchoverDrain =
        draining !== null &&
        this.#drainIsSwitchover(projectId, draining.sessionId, pending.some((handoff) => handoff.from_session_id === draining.sessionId));
      const replacements: string[] = [];
      for (const handoff of pending) {
        this.db.run(`UPDATE handoffs SET status = 'REJECTED' WHERE handoff_id = ? AND status = 'PENDING'`, [handoff.handoff_id]);
        const replacement = this.sessions.get(handoff.to_session_id);
        if (!replacement || replacement.lifecycle === SessionLifecycle.STOPPED || this.#holdsAnyRole(replacement.sessionId)) continue;
        this.sessions.transition(replacement.sessionId, SessionLifecycle.ERROR, `${reason}: handoff withdrawn, provider stop pending`);
        replacements.push(replacement.sessionId);
      }
      const restored =
        draining !== null &&
        switchoverDrain &&
        this.projects.get(projectId)?.suspended !== true &&
        this.sessions.transition(draining.sessionId, SessionLifecycle.READY, `${reason}: a canonical CTO is not replaced`).allowed;
      const withdrawal = { projectId, handoffIds: pending.map((handoff) => handoff.handoff_id), replacements, restored };
      if (withdrawal.handoffIds.length > 0 || restored) {
        this.audit.record({
          kind: "CTO_CANONICAL_SWITCHOVER_WITHDRAWN",
          reasonCode: ReasonCode.CANONICAL_CTO_NOT_REPLACEABLE,
          projectId,
          sessionId: current?.sessionId ?? null,
          roleKey,
          evidence: { reason, ...withdrawal },
        });
      }
      return withdrawal;
    });
  }

  /**
   * #246 C1-R2 — whether the holder's current drain is a switchover's, by positive evidence only.
   * Three writers drain a PRIMARY_CTO session: `prepareSwitchover` (with a PENDING handoff from it),
   * `requestReplacement` (recording CTO_REPLACEMENT_REQUESTED for it right after its drain), and
   * `suspendProject`, whose RECOVERY package from the session is written before its drain and its
   * provider stop and is never closed. A suspension's drain stays the suspension's until its
   * shutdown and revocation settle, whatever resume or a switchover record says; a drain nothing
   * here attributes — another writer's — is left alone too. A replacement record counts only if it
   * is newer than the session's latest transition into DRAINING, so it explains that drain and not
   * an earlier one.
   */
  #drainIsSwitchover(projectId: string, sessionId: string, pendingHandoffFromHolder: boolean): boolean {
    const suspension = this.db.get<{ handoff_id: string }>(
      `SELECT handoff_id FROM handoffs WHERE kind = 'RECOVERY' AND from_session_id = ? LIMIT 1`,
      [sessionId],
    );
    if (suspension) return false;
    if (pendingHandoffFromHolder) return true;
    const drained = this.db.get<{ eventId: number | null }>(
      `SELECT MAX(event_id) AS eventId FROM audit_events
        WHERE kind = 'SESSION_LIFECYCLE' AND session_id = ? AND json_extract(evidence_json, '$.to') = ?`,
      [sessionId, SessionLifecycle.DRAINING],
    )?.eventId ?? null;
    if (drained === null) return false;
    return this.db.get<{ event_id: number }>(
      `SELECT event_id FROM audit_events
        WHERE kind = 'CTO_REPLACEMENT_REQUESTED' AND session_id = ? AND project_id = ? AND event_id > ?
        LIMIT 1`,
      [sessionId, projectId, drained],
    ) !== undefined;
  }

  /** Provider stops for withdrawn replacements; answers the sessions the provider did not stop. */
  async #stopWithdrawnReplacements(sessionIds: readonly string[], reason: string): Promise<string[]> {
    const failed: string[] = [];
    for (const sessionId of sessionIds) {
      if (this.#holdsAnyRole(sessionId)) continue;
      await this.stopUnusedSession(sessionId, reason);
      if (this.sessions.get(sessionId)?.lifecycle !== SessionLifecycle.STOPPED) failed.push(sessionId);
    }
    return failed;
  }

  /** Whether the session holds any active role, by its recorded session or its actor's live runtime. */
  #holdsAnyRole(sessionId: string): boolean {
    return this.db.get<{ role_key: string }>(
      `SELECT a.role_key FROM assignments a
         LEFT JOIN conversational_actors c ON c.actor_id = a.actor_id
        WHERE a.status = 'ACTIVE' AND (a.session_id = ? OR c.current_session_id = ?)
        LIMIT 1`,
      [sessionId, sessionId],
    ) !== undefined;
  }

  /**
   * A READY adopted canonical CTO is dispatched to only while its recorded process is the one
   * running. Asking the provider adapter instead is what turned a live canonical CTO to ERROR and
   * spawned a replacement on 2026-10-03: the adapter cannot vouch for a session it never started.
   * ALIVE reuses the binding and writes nothing; every other answer refuses.
   */
  #dispatchToAdoptedCanonical(binding: RoleBinding, session: SessionRecord, runId: string): Decision<RoleBinding> {
    const liveness = this.#adoptedProcessLiveness(session);
    if (liveness === "ALIVE") return allow(ReasonCode.OK, binding);
    return this.#refuseAdoptedCanonical(binding, session, liveness, runId);
  }

  /**
   * The liveness rule the canonical self-claim and `recoverDeadCanonicalBinding` already apply,
   * `probeSessionLiveness` over the recorded `(os_pid, start token)`, with two readings narrower
   * for dispatch. A row missing either half names no identifiable process (`#predecessorProcessIsGone`
   * declines to decide on one too), so it is UNKNOWN. And `EPERM`, which the rule reads as ALIVE
   * because it must never evict, is separated out: it returns before the start token is compared,
   * so it does not show that the process signalled is the one recorded, and dispatch needs that.
   * The token is read the way the claim recorded it (the claim's inspector's start-token reader),
   * not as `ps` lstart text, which would call every live canonical CTO dead.
   */
  #adoptedProcessLiveness(session: SessionRecord): SessionLiveness | "EPERM" {
    if (session.osPid === null || session.osProcessStartedAt === null) return "UNKNOWN";
    let signalRefused = false;
    const liveness = probeSessionLiveness(session.osPid, session.osProcessStartedAt, {
      signal: (pid) => {
        try {
          process.kill(pid, 0);
        } catch (error) {
          signalRefused = (error as { code?: unknown }).code === "EPERM";
          throw error;
        }
      },
      startedAt: defaultProcessAncestryInspector.readStartToken,
    });
    return liveness === "ALIVE" && signalRefused ? "EPERM" : liveness;
  }

  /**
   * A canonical role is neither dispatched into a runtime that is not running nor handed a
   * spawned replacement: the canonical owner forbids a new actor in that role, and the role
   * recovers when its own conversation claims it again. `liveness` is null when the row is
   * already terminal, or the binding already released, and the process was not asked.
   *
   * The audit row is the only write. The session's lifecycle is left as it is even on DEAD:
   * ERROR is terminal (it leads only to STOPPED), the daemon's reconcile already records a
   * vanished process, and a misread here must never be able to end a live canonical session.
   * DEAD and a terminal row wait for the re-claim; EPERM and UNKNOWN decided nothing, so the
   * same dispatch asked again may succeed.
   */
  #refuseAdoptedCanonical<T = RoleBinding>(
    holder: CanonicalHolder,
    session: SessionRecord | null,
    liveness: SessionLiveness | "EPERM" | null,
    runId: string | undefined,
  ): Decision<T> {
    const evidence = {
      projectId: holder.projectId,
      sessionId: holder.sessionId,
      bindingGeneration: holder.bindingGeneration,
      assignmentStatus: holder.status,
      lifecycle: session?.lifecycle ?? null,
      osPid: session?.osPid ?? null,
      liveness,
    };
    const awaitingReclaim = liveness === null || liveness === "DEAD";
    this.audit.record({
      kind: "CTO_DISPATCH_REFUSED_CANONICAL",
      reasonCode: awaitingReclaim ? ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM : ReasonCode.PROBE_FAILED,
      projectId: holder.projectId,
      runId: runId ?? null,
      sessionId: holder.sessionId,
      roleKey: holder.roleKey,
      evidence,
    });
    if (awaitingReclaim) {
      return deny(
        ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM,
        "the canonical CTO's runtime is not running; it recovers the role by claiming it again, and the run stays queued",
        evidence,
      );
    }
    return deny(
      ReasonCode.PROBE_FAILED,
      "the canonical CTO's recorded process could not be shown to be running; nothing was changed and the run stays queued",
      evidence,
    );
  }

  /**
   * Stops a CTO runtime through the provider's own handle. The control plane's `ses_cto_…` alias
   * means nothing to the provider: a stop addressed to it left the provider's session running
   * while the row said STOPPED. `handleFor` rebuilds the provider id from the incarnation, as the
   * bound-session probe already does.
   */
  private async stopProviderSession(session: SessionRecord, role: Role = Role.PRIMARY_CTO): Promise<void> {
    await this.providers.requireForRole(session.provider, role).stopSession(handleFor(session));
  }

  /** A replacement that never became authoritative must not remain a live orphan. */
  private async stopUnusedSession(sessionId: string, reason: string, role: Role = Role.PRIMARY_CTO): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.lifecycle === SessionLifecycle.STOPPED) return;
    try {
      await this.stopProviderSession(session, role);
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

/**
 * A headless session whose attestation did not settle is, to its caller, a session that was not
 * proven ready — the same answer a failed provider probe gives — with the runtime's own reason kept
 * beside it as the cause.
 */
const notProvenReady = (sessionId: string, attested: Decision<void>): Decision<void> =>
  attested.allowed
    ? attested
    : deny(ReasonCode.SESSION_NOT_READY, "the session's runtime did not prove it is ready", {
        sessionId,
        cause: attested.reasonCode,
      });

/** The refusal for a headless-runtime role with no runtime driver attached to drive it. */
const runtimeUnavailable = <T>(sessionId: string | null, role: Role): Decision<T> =>
  deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "no headless runtime is attached to drive this role's session", {
    sessionId,
    role,
  });

/** The holder a canonical refusal names: the active binding, or the released role's latest assignment. */
type CanonicalHolder = Pick<RoleBinding, "projectId" | "roleKey" | "sessionId" | "bindingGeneration" | "status">;

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
 * and a DEGRADED answer is not one either. Exported so worker provisioning asks the same
 * question rather than a copy of it.
 */
export const probeSessionHealth = async (
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
    return deny(ReasonCode.SESSION_NOT_READY, "provider cannot prove the constituted session is ready", {
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
