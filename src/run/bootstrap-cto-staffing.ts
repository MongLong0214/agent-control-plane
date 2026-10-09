import type { DispatchCapacityTarget } from "../capacity/capacity-monitor.ts";
import {
  CONTINUITY_RECOVERY_REFUSED_REASON_PREFIX,
  isContinuityRevocationReason,
} from "../continuity/continuity-kernel.ts";
import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { BOOTSTRAP_CTO_SPAWN_RECORD, type CtoLifecycle, type CtoPreference } from "../cto/cto-lifecycle.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { FIXED_ROLE_RUNTIME } from "../domain/fixed-role-runtime.ts";
import { isTerminal } from "../domain/run-state.ts";
import {
  Role,
  type RoleBinding,
  RunKind,
  type RunRow,
  RunState,
  SessionLifecycle,
  roleKeyFor,
} from "../domain/types.ts";
import type { ProvisionedSessionRuntime } from "../runtime/provisioned-session-runtime.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRecord, SessionRegistry } from "../session/session-registry.ts";
import type { RunEngine } from "./run-engine.ts";

/**
 * The runtime a run's BOOTSTRAP_CTO is constituted on: Claude Opus, fixed (RF PRD:156), from the
 * one table continuity reads too (`FIXED_ROLE_RUNTIME`).
 *
 * Not the deployment's `ctoPreference`, which a project's primary CTO follows and an operator may
 * change, and not an adapter's `defaultModels.cto`. Nothing is substituted: a deployment with no
 * Claude adapter for the BOOTSTRAP_CTO role refuses the dispatch rather than staffing another one.
 */
export const BOOTSTRAP_CTO_RUNTIME: Readonly<CtoPreference> = Object.freeze({
  ...FIXED_ROLE_RUNTIME[Role.BOOTSTRAP_CTO]!,
  effort: null,
});

/**
 * What `ensure` hands the dispatch transaction: a session it just constituted, unbound, or the live
 * binding a re-dispatch reuses.
 */
export interface BootstrapCtoStaffed {
  sessionId: string;
  /** The run's existing BOOTSTRAP_CTO binding, probed live; null for a session spawned just now. */
  reused: RoleBinding | null;
}

export interface BootstrapCtoReclaimReport {
  /** Role keys whose binding the sweep revoked because their run had ended. */
  revoked: string[];
  /** Sessions the sweep had the provider stop. */
  stopped: string[];
  /** Sessions the provider did not stop; the next sweep asks again. */
  stopFailed: string[];
}

export interface BootstrapCtoStaffingPorts {
  readonly bindings: Pick<BindingRegistry, "active" | "history" | "bind" | "revoke" | "assertHeldAlone">;
  readonly sessions: Pick<SessionRegistry, "get">;
  readonly lifecycle: Pick<CtoLifecycle, "spawnBootstrapCto" | "probeRoleSession" | "stopRoleSession">;
  readonly runs: { get(runId: string): RunRow | null };
}

/** What a same-session recovery needs beyond staffing (#246 C1b); attached by the composition root. */
export interface BootstrapCtoRecoveryPorts {
  readonly clock: Clock;
  readonly capacity: { refreshForDispatch(target?: DispatchCapacityTarget): Promise<Decision<void>> };
  readonly providerScope: { hasRoleScoped(provider: string): boolean };
  readonly runtime: Pick<ProvisionedSessionRuntime, "probe" | "adopt" | "attest" | "release">;
  readonly sessions: Pick<SessionRegistry, "get" | "rotateSecret">;
  readonly bindings: Pick<BindingRegistry, "renewSameSession" | "revoke">;
  readonly runs: Pick<RunEngine, "restoreRecoveredBootstrapOwner">;
}

/**
 * The run states a recovery restores the owner of: continuity's pause (BLOCKED), a hold someone else
 * placed and keeps (BLOCKED for a CEO decision, AWAITING_HUMAN), and a revision waiting to be
 * dispatched (REVISION_REQUIRED). `RunEngine.restoreRecoveredBootstrapOwner` decides which of them
 * resumes.
 */
const RECOVERABLE_RUN_STATES: readonly RunState[] = Object.freeze([
  RunState.BLOCKED,
  RunState.REVISION_REQUIRED,
  RunState.AWAITING_HUMAN,
]);

/** A failed recovery is not tried again on the next restore pass, only after this. */
export const BOOTSTRAP_CTO_RECOVERY_BACKOFF_MS = 15 * 60_000;

/** What a recovery starts from: the revoked generation, its run, and the session it ran on. */
interface RecoverableBootstrapCto {
  /** The role's newest generation, revoked by continuity; the renewal follows it. */
  revoked: RoleBinding;
  /**
   * The generation the run is still pinned to: the one the outage revoked. Later generations an
   * earlier recovery renewed and then abandoned never held the pin.
   */
  pinnedGeneration: number;
  run: RunRow;
  session: SessionRecord;
}

/**
 * Issue #246 PR-C slice C1 — the production path that staffs a project-less PROJECT_BOOTSTRAP
 * run's `BOOTSTRAP_CTO(run)` (RF PRD:156, :360; ACP PRD §9.5) and reclaims it when the run ends.
 * Modelled on `WorkerStaffing`.
 *
 * Dispatch admission asks it in three steps: `admit` before capacity (the refusals that need no
 * provider), `ensure` after capacity (spawn a fresh session, or probe the live binding a
 * re-dispatch reuses), and `bindForDispatch` inside the dispatch transaction, which binds, pins
 * and enqueues RUN_DISPATCH together. It mints generation 1 only. A role with any history and no
 * live binding is refused `BINDING_REVOKED`: a bootstrap CTO is never replaced, and getting a
 * revoked one back belongs to continuity's restore pass (`recover`, #246 C1b), which renews the same
 * actor on the same session rather than minting another.
 *
 * The session is its own: `BindingRegistry` keeps a BOOTSTRAP_CTO alone on its session in both
 * directions, so it is never promoted, never a reviewer, and two runs get two sessions. It is
 * run-scoped work, not a canonical actor, so nothing here reads or replaces the CEO's or a project
 * CTO's canonical conversation.
 */
export class BootstrapCtoStaffing {
  #recovery: BootstrapCtoRecoveryPorts | null = null;
  /** Roles a recovery is running for now: one at a time per role, never two holders. */
  readonly #recovering = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly ports: BootstrapCtoStaffingPorts,
  ) {}

  attach(ports: { recovery?: BootstrapCtoRecoveryPorts }): void {
    if (ports.recovery) this.#recovery = ports.recovery;
  }

  /** The fixed provider dispatch admission is asked about for a fresh bootstrap CTO. */
  get provider(): string {
    return BOOTSTRAP_CTO_RUNTIME.provider;
  }

  /**
   * The refusals that need no provider: the run is a project-less PROJECT_BOOTSTRAP, its role was
   * never held or is held now, any owner pin names exactly that binding, and a binding to be reused
   * passes the admission a fresh one would (`#admitReuse`). Answers the live binding a re-dispatch
   * would reuse, or null when a fresh one is to be staffed.
   */
  admit(run: RunRow): Decision<RoleBinding | null> {
    const role = this.#admitRole(run);
    if (!role.allowed || !role.value) return role;
    const reusable = this.#admitReuse(role.value);
    return reusable.allowed ? role : (reusable as Decision<RoleBinding | null>);
  }

  /** `admit` without the reuse admission: the run, its role's history, and the owner pin. */
  #admitRole(run: RunRow): Decision<RoleBinding | null> {
    if (run.kind !== RunKind.PROJECT_BOOTSTRAP || run.projectId !== null) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a bootstrap CTO is staffed only for a project-less PROJECT_BOOTSTRAP run", {
        runId: run.runId,
        kind: run.kind,
        projectId: run.projectId,
      });
    }
    const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId: run.runId });
    const active = this.ports.bindings.active(roleKey);
    if (active) {
      const pinned = run.ownerRoleKey !== null || run.ownerSessionId !== null;
      if (
        pinned &&
        (run.ownerRoleKey !== roleKey ||
          run.ownerSessionId !== active.boundSessionId ||
          run.ownerSessionIncarnation !== active.boundSessionIncarnation ||
          run.ownerBindingGeneration !== active.bindingGeneration)
      ) {
        return deny(ReasonCode.RUN_OWNER_REVOKED, "the run's owner pin is not its active bootstrap CTO binding", {
          runId: run.runId,
          roleKey,
          pinnedRoleKey: run.ownerRoleKey,
        });
      }
      return allow(ReasonCode.OK, active);
    }
    // A pin with no active binding behind it names an owner that is gone (or was never this role).
    if (run.ownerSessionId !== null || run.ownerRoleKey !== null) {
      return deny(ReasonCode.RUN_OWNER_REVOKED, "the run is pinned to an owner that is not its active bootstrap CTO", {
        runId: run.runId,
        roleKey,
        pinnedRoleKey: run.ownerRoleKey,
      });
    }
    const history = this.ports.bindings.history(roleKey);
    if (history.length > 0) {
      return deny(
        ReasonCode.BINDING_REVOKED,
        "the run's bootstrap CTO role was held before; it is recovered on its own session by continuity, not provisioned again",
        { runId: run.runId, roleKey, generation: history[history.length - 1]!.bindingGeneration },
      );
    }
    return allow(ReasonCode.OK, null);
  }

  /**
   * #246 C1-01 — a binding a re-dispatch would reuse is admitted as a fresh bind is: on the fixed
   * runtime, Claude Opus, by the session it was bound on and its actor's live runtime alike, and
   * alone on that session (`BindingRegistry.assertHeldAlone`, the rule `bind` applies). A persisted
   * binding that is not — one an earlier build or a raw write left — is refused with its reason. It
   * is never reused and never replaced here, and nothing it shares a session with is touched.
   */
  #admitReuse(binding: RoleBinding): Decision<void> {
    for (const sessionId of new Set([binding.boundSessionId, binding.sessionId])) {
      const session = this.ports.sessions.get(sessionId);
      if (session?.provider !== BOOTSTRAP_CTO_RUNTIME.provider || session.model !== BOOTSTRAP_CTO_RUNTIME.model) {
        return deny(
          ReasonCode.ROLE_RUNTIME_SUBSTITUTION_REFUSED,
          "the run's bootstrap CTO binding is not on the fixed Claude Opus runtime, so it is not reused",
          {
            runId: binding.runId,
            roleKey: binding.roleKey,
            sessionId,
            provider: session?.provider ?? null,
            model: session?.model ?? null,
            fixedProvider: BOOTSTRAP_CTO_RUNTIME.provider,
            fixedModel: BOOTSTRAP_CTO_RUNTIME.model,
          },
        );
      }
    }
    return this.ports.bindings.assertHeldAlone(binding);
  }

  /**
   * After capacity admission: probe and reuse the live binding a re-dispatch finds, or spawn a
   * fresh session on the fixed runtime (launch credential → Buzz → probe → READY → readiness). A
   * reused binding whose session the provider no longer has is refused, not replaced.
   */
  async ensure(runId: string): Promise<Decision<BootstrapCtoStaffed>> {
    const run = this.ports.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    const admitted = this.admit(run);
    if (!admitted.allowed) return admitted as Decision<BootstrapCtoStaffed>;
    if (admitted.value) {
      const live = await this.ports.lifecycle.probeRoleSession(admitted.value.sessionId, Role.BOOTSTRAP_CTO);
      if (!live.allowed) return live as Decision<BootstrapCtoStaffed>;
      return allow(ReasonCode.OK, { sessionId: admitted.value.sessionId, reused: admitted.value });
    }
    const spawned = await this.ports.lifecycle.spawnBootstrapCto(runId, BOOTSTRAP_CTO_RUNTIME);
    if (!spawned.allowed) return spawned as Decision<BootstrapCtoStaffed>;
    return allow(ReasonCode.OK, { sessionId: spawned.value, reused: null });
  }

  /**
   * Inside the dispatch transaction: ask `admit`'s role checks again — the awaits since can let
   * another dispatch bind, or a revocation land — then bind generation 1 on the fresh session, or
   * confirm the reused binding is still the one probed and still passes the reuse admission (C1-01).
   * The answer is the binding the run is pinned to, by its binding-time runtime (#493), which is what
   * the owner pin's foreign key resolves against.
   */
  bindForDispatch(runId: string, staffed: BootstrapCtoStaffed): Decision<RoleBinding> {
    const run = this.ports.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    const admitted = this.#admitRole(run);
    if (!admitted.allowed) return admitted as Decision<RoleBinding>;
    if (staffed.reused) {
      const current = admitted.value;
      if (
        !current ||
        current.assignmentId !== staffed.reused.assignmentId ||
        current.bindingGeneration !== staffed.reused.bindingGeneration ||
        current.sessionId !== staffed.reused.sessionId
      ) {
        return deny(ReasonCode.BINDING_GENERATION_STALE, "the bootstrap CTO binding changed while dispatch probed it", {
          runId,
          probedGeneration: staffed.reused.bindingGeneration,
          currentGeneration: current?.bindingGeneration ?? null,
        });
      }
      // The same binding, asked again here: the probe's await can let its session take another role.
      const reusable = this.#admitReuse(current);
      if (!reusable.allowed) return reusable as Decision<RoleBinding>;
      return allow(ReasonCode.OK, {
        ...current,
        sessionId: current.boundSessionId,
        sessionIncarnation: current.boundSessionIncarnation,
      });
    }
    // `admit` above refused any history, so this mints generation 1; a binding another dispatch made
    // meanwhile is refused by `bind` itself (BINDING_ALREADY_ACTIVE).
    const bound = this.ports.bindings.bind({
      role: Role.BOOTSTRAP_CTO,
      sessionId: staffed.sessionId,
      runId,
      mode: "PREFERRED",
    });
    if (!bound.allowed) return bound;
    this.audit.record({
      kind: "BOOTSTRAP_CTO_PROVISIONED",
      runId,
      sessionId: staffed.sessionId,
      roleKey: bound.value.roleKey,
      evidence: {
        generation: bound.value.bindingGeneration,
        provider: BOOTSTRAP_CTO_RUNTIME.provider,
        model: BOOTSTRAP_CTO_RUNTIME.model,
      },
    });
    return bound;
  }

  /**
   * Stops a session `ensure` spawned and the dispatch did not bind. A reused one is left alone, and
   * so is any session that holds a role, whatever produced it. A stop the provider refuses leaves
   * the session ERROR; its spawn record (`BOOTSTRAP_CTO_SPAWN_RECORD`) is how `reclaim` finds it to
   * ask again (C1-04).
   */
  async discard(staffed: BootstrapCtoStaffed, reason: string): Promise<void> {
    if (staffed.reused || this.#holdsRole(staffed.sessionId)) return;
    const stopped = await this.ports.lifecycle.stopRoleSession(staffed.sessionId, Role.BOOTSTRAP_CTO, reason);
    if (!stopped.allowed) {
      this.audit.record({
        kind: "BOOTSTRAP_CTO_UNUSED_SESSION_STOP_FAILED",
        reasonCode: stopped.reasonCode,
        sessionId: staffed.sessionId,
        evidence: { reason },
      });
    }
  }

  /**
   * Inside the transaction that moves a PROJECT_BOOTSTRAP run to a terminal state (CONFIRM →
   * COMPLETED, cancel, fail): revoke `BOOTSTRAP_CTO(run)`. A refusal here does not block the run's
   * transition; it is audited and the daemon's `reclaim` sweep revokes the binding later.
   */
  release(runId: string, reason: string): void {
    const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId });
    if (!this.ports.bindings.active(roleKey)) return;
    const revoked = this.ports.bindings.revoke(roleKey, `bootstrap run ended: ${reason}`);
    if (!revoked.allowed) {
      this.audit.record({
        kind: "BOOTSTRAP_CTO_RECLAIM_DEFERRED",
        reasonCode: revoked.reasonCode,
        runId,
        roleKey,
        evidence: { reason },
      });
    }
  }

  /**
   * The daemon sweep. Revokes any BOOTSTRAP_CTO whose run has ended (or is gone) that the terminal
   * transition did not, then has the provider stop the sessions that are left over: every session
   * that served a bootstrap CTO binding since revoked, once its run has ended, and every session
   * spawned for a run's bootstrap CTO (C1-04) — found by the spawn record written before anything
   * could refuse it — once its run has ended or once it can never be bound. A session holding any
   * role — by its recorded session or its actor's live runtime — is never stopped here, and neither
   * is a spawn a live run's dispatch may still be staffing.
   */
  async reclaim(): Promise<BootstrapCtoReclaimReport> {
    const report: BootstrapCtoReclaimReport = { revoked: [], stopped: [], stopFailed: [] };
    for (const row of this.db.all<{ role_key: string; run_id: string | null }>(
      `SELECT role_key, run_id FROM assignments WHERE role = 'BOOTSTRAP_CTO' AND status = 'ACTIVE' ORDER BY role_key`,
    )) {
      const run = row.run_id === null ? null : this.ports.runs.get(row.run_id);
      if (run && !isTerminal(run.state)) continue;
      const revoked = this.ports.bindings.revoke(row.role_key, `bootstrap run ended: ${run?.state ?? "run missing"}`);
      if (revoked.allowed) report.revoked.push(row.role_key);
    }

    const candidates = this.db.all<{ session_id: string; run_id: string | null }>(
      `SELECT a.session_id AS session_id, a.run_id AS run_id
         FROM assignments a JOIN sessions s ON s.session_id = a.session_id
        WHERE a.role = 'BOOTSTRAP_CTO' AND a.status = 'REVOKED' AND s.lifecycle <> 'STOPPED'
       UNION
       SELECT c.current_session_id AS session_id, a.run_id AS run_id
         FROM assignments a
         JOIN conversational_actors c ON c.actor_id = a.actor_id
         JOIN sessions s ON s.session_id = c.current_session_id
        WHERE a.role = 'BOOTSTRAP_CTO' AND a.status = 'REVOKED' AND s.lifecycle <> 'STOPPED'
       UNION
       SELECT e.session_id AS session_id, e.run_id AS run_id
         FROM audit_events e JOIN sessions s ON s.session_id = e.session_id
        WHERE e.kind = ? AND s.lifecycle <> 'STOPPED'
        ORDER BY session_id`,
      [BOOTSTRAP_CTO_SPAWN_RECORD],
    );
    const runsOf = new Map<string, Array<string | null>>();
    for (const { session_id: sessionId, run_id: runId } of candidates) {
      runsOf.set(sessionId, [...(runsOf.get(sessionId) ?? []), runId]);
    }
    for (const [sessionId, runIds] of runsOf) {
      const session = this.ports.sessions.get(sessionId);
      if (!session || session.lifecycle === SessionLifecycle.STOPPED) continue;
      if (this.#holdsRole(sessionId)) continue;
      const runEnded = runIds.every((runId) => {
        const run = runId === null ? null : this.ports.runs.get(runId);
        return !run || isTerminal(run.state);
      });
      if (!runEnded && !this.#neverBindable(sessionId, session.lifecycle)) continue;
      const stopped = await this.ports.lifecycle.stopRoleSession(
        sessionId,
        Role.BOOTSTRAP_CTO,
        "bootstrap run ended; its bootstrap CTO is reclaimed",
      );
      if (stopped.allowed) report.stopped.push(sessionId);
      else report.stopFailed.push(sessionId);
    }
    if (report.revoked.length > 0 || report.stopped.length > 0 || report.stopFailed.length > 0) {
      this.audit.record({
        kind: "BOOTSTRAP_CTO_RECLAIMED",
        reasonCode: report.stopFailed.length > 0 ? ReasonCode.SESSION_STOP_FAILED : ReasonCode.OK,
        evidence: {
          revoked: report.revoked.length,
          stopped: report.stopped.length,
          stopFailed: report.stopFailed.length,
        },
      });
    }
    return report;
  }

  /**
   * #246 C1b — the same-session recovery of a run's BOOTSTRAP_CTO that continuity revoked when its
   * fixed runtime stopped covering it. Continuity's `restore()` asks for it when coverage returns;
   * nothing else starts it. In order, and nothing is skipped:
   *
   *   1. the run is still the project-less bootstrap pinned to the revoked generation, in a held
   *      state (BLOCKED, REVISION_REQUIRED or AWAITING_HUMAN), and the session is still the READY
   *      Claude Opus session that generation ran on — a COMPLETED, CANCELLED or FAILED run and a
   *      STOPPED or ERROR session are never recovered;
   *   2. capacity admits the fixed runtime for the role;
   *   3. the session's own conversation answers a `--resume` probe — which alone changes nothing;
   *   4. one transaction rotates the session's credential (epoch exactly +1, a new secret) and
   *      renews the binding at the next generation for the same actor on the same session, while
   *      the run keeps its state;
   *   5. the new credential is delivered to that session's runtime and the runtime attests with it
   *      over an authenticated connection;
   *   6. only then the run is pinned to the new generation. A run continuity itself paused for this
   *      role is made ACTIVE and sent RUN_DISPATCH; any other hold — a CEO decision, a revision, a
   *      human gate — is kept, and only the authority comes back (`restoreRecoveredBootstrapOwner`).
   *
   * A refusal at 4 writes nothing. A refusal at 5 or 6 revokes the renewed generation again, as a
   * continuity revocation so the role stays owed, and the run keeps its state on the old pin: no
   * second holder and no dispatch. Every refusal is recorded, and the next attempt waits out
   * `BOOTSTRAP_CTO_RECOVERY_BACKOFF_MS` rather than spending a provider turn on every pass.
   */
  async recover(roleKey: string): Promise<Decision<RoleBinding>> {
    const recovery = this.#recovery;
    if (!recovery) {
      return deny(ReasonCode.SESSION_RUNTIME_UNAVAILABLE, "no bootstrap CTO recovery is attached", { roleKey });
    }
    if (this.#recovering.has(roleKey)) {
      return deny(ReasonCode.CONFLICT, "a recovery of this bootstrap CTO is already running", { roleKey });
    }
    if (this.backingOff(roleKey)) {
      return deny(ReasonCode.BOOTSTRAP_CTO_RECOVERY_BACKOFF, "a recent recovery of this bootstrap CTO failed; waiting out its backoff", {
        roleKey,
        backoffMs: BOOTSTRAP_CTO_RECOVERY_BACKOFF_MS,
      });
    }
    this.#recovering.add(roleKey);
    try {
      const recovered = await this.#recover(recovery, roleKey);
      if (!recovered.allowed) {
        this.audit.record({
          kind: "BOOTSTRAP_CTO_RECOVERY_REFUSED",
          reasonCode: recovered.reasonCode,
          roleKey,
          evidence: { backoffMs: BOOTSTRAP_CTO_RECOVERY_BACKOFF_MS },
        });
      }
      return recovered;
    } finally {
      this.#recovering.delete(roleKey);
    }
  }

  /**
   * Whether this role's latest recovery, since its latest revocation, failed less than a backoff
   * ago. Read from the ledger, so a restart does not reset it.
   */
  backingOff(roleKey: string): boolean {
    const clock = this.#recovery?.clock;
    if (!clock) return false;
    const refused = this.db.get<{ at: string }>(
      `SELECT refused.at FROM audit_events refused
        WHERE refused.kind = 'BOOTSTRAP_CTO_RECOVERY_REFUSED' AND refused.role_key = ?
          AND refused.event_id > COALESCE(
                (SELECT MAX(revoked.event_id) FROM audit_events revoked
                  WHERE revoked.kind = 'BINDING_REVOKED' AND revoked.role_key = ?
                    AND revoked.event_id < refused.event_id
                    AND NOT EXISTS (
                      SELECT 1 FROM audit_events own
                       WHERE own.kind = 'BOOTSTRAP_CTO_RECOVERY_REFUSED' AND own.role_key = ?
                         AND own.event_id > revoked.event_id AND own.event_id < refused.event_id)), 0)
        ORDER BY refused.event_id DESC LIMIT 1`,
      [roleKey, roleKey, roleKey],
    );
    if (!refused) return false;
    return Date.parse(clock.nowIso()) - Date.parse(refused.at) < BOOTSTRAP_CTO_RECOVERY_BACKOFF_MS;
  }

  async #recover(recovery: BootstrapCtoRecoveryPorts, roleKey: string): Promise<Decision<RoleBinding>> {
    const start = this.#recoverable(recovery, roleKey);
    if (!start.allowed) return start as Decision<RoleBinding>;
    const { revoked, session } = start.value;

    const admitted = await recovery.capacity.refreshForDispatch({
      provider: BOOTSTRAP_CTO_RUNTIME.provider,
      capabilities: ["cto"],
      priority: "critical",
      ...(recovery.providerScope.hasRoleScoped(BOOTSTRAP_CTO_RUNTIME.provider) ? { role: Role.BOOTSTRAP_CTO } : {}),
    });
    if (!admitted.allowed) return admitted as Decision<RoleBinding>;

    // The provider still has this conversation. Proves nothing about authority, and grants none.
    const probed = await recovery.runtime.probe(session.sessionId);
    if (!probed.allowed) return probed as Decision<RoleBinding>;

    let sessionSecret = "";
    const rotated = this.db.txDecision<{ renewed: RoleBinding; credentialEpoch: number }>(() => {
      const again = this.#recoverable(recovery, roleKey);
      if (!again.allowed) return again as Decision<{ renewed: RoleBinding; credentialEpoch: number }>;
      if (again.value.session.credentialEpoch !== session.credentialEpoch || again.value.revoked.assignmentId !== revoked.assignmentId) {
        return deny(ReasonCode.SESSION_CREDENTIAL_EPOCH_STALE, "the session or its role moved while the recovery probed it", { roleKey });
      }
      const credential = recovery.sessions.rotateSecret(session.sessionId, session.credentialEpoch);
      if (!credential.allowed) return credential as Decision<{ renewed: RoleBinding; credentialEpoch: number }>;
      const renewed = recovery.bindings.renewSameSession({
        roleKey,
        expectedGeneration: revoked.bindingGeneration,
        sessionId: revoked.boundSessionId,
        sessionIncarnation: revoked.boundSessionIncarnation,
        reason: "bootstrap CTO recovered on its own session",
      });
      if (!renewed.allowed) return renewed as Decision<{ renewed: RoleBinding; credentialEpoch: number }>;
      sessionSecret = credential.value.sessionSecret;
      return allow(ReasonCode.OK, { renewed: renewed.value, credentialEpoch: credential.value.session.credentialEpoch });
    });
    if (!rotated.allowed) return rotated as Decision<RoleBinding>;
    const { renewed, credentialEpoch } = rotated.value;

    const abandon = (refused: Decision<unknown>): Decision<RoleBinding> => {
      recovery.runtime.release(session.sessionId);
      const revokedAgain = recovery.bindings.revoke(roleKey, `${CONTINUITY_RECOVERY_REFUSED_REASON_PREFIX}${refused.reasonCode}`, {
        allowBlockedRuns: true,
      });
      if (!revokedAgain.allowed) {
        this.audit.record({
          kind: "BOOTSTRAP_CTO_RECOVERY_REVOKE_DEFERRED",
          reasonCode: revokedAgain.reasonCode,
          roleKey,
          sessionId: session.sessionId,
          evidence: { generation: renewed.bindingGeneration },
        });
      }
      return refused as Decision<RoleBinding>;
    };

    const adopted = recovery.runtime.adopt(session.sessionId, Role.BOOTSTRAP_CTO, sessionSecret, credentialEpoch);
    sessionSecret = "";
    if (!adopted.allowed) return abandon(adopted);
    const attested = await recovery.runtime.attest(session.sessionId, "resume");
    if (!attested.allowed) return abandon(attested);
    const restored = recovery.runs.restoreRecoveredBootstrapOwner(start.value.run.runId, renewed, start.value.pinnedGeneration);
    if (!restored.allowed) return abandon(restored);
    this.audit.record({
      kind: "BOOTSTRAP_CTO_RECOVERED",
      runId: start.value.run.runId,
      sessionId: session.sessionId,
      roleKey,
      evidence: {
        fromGeneration: start.value.pinnedGeneration,
        toGeneration: renewed.bindingGeneration,
        credentialEpoch,
        resumed: restored.value.resumed,
        state: restored.value.run.state,
      },
    });
    return allow(ReasonCode.OK, renewed);
  }

  /** Step 1 of `recover`, asked again inside the rotation transaction. Reads only. */
  #recoverable(recovery: BootstrapCtoRecoveryPorts, roleKey: string): Decision<RecoverableBootstrapCto> {
    if (this.ports.bindings.active(roleKey)) {
      return deny(ReasonCode.BINDING_ALREADY_ACTIVE, "the bootstrap CTO role is held; there is nothing to recover", { roleKey });
    }
    const history = this.ports.bindings.history(roleKey);
    const revoked = history[history.length - 1];
    if (!revoked) return deny(ReasonCode.NOT_FOUND, "the role was never held", { roleKey });
    if (revoked.role !== Role.BOOTSTRAP_CTO || revoked.runId === null) {
      return deny(ReasonCode.INVALID_ARGUMENT, "only a run's bootstrap CTO is recovered here", { roleKey, role: revoked.role });
    }
    const revokedReason = this.db.get<{ revoked_reason: string | null }>(
      `SELECT revoked_reason FROM assignments WHERE assignment_id = ?`,
      [revoked.assignmentId],
    )?.revoked_reason ?? null;
    if (!isContinuityRevocationReason(revokedReason)) {
      return deny(ReasonCode.BINDING_REVOKED, "the role was released, not lost to an outage; it is not recovered", {
        roleKey,
        generation: revoked.bindingGeneration,
      });
    }
    const run = this.ports.runs.get(revoked.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "the bootstrap CTO's run is gone", { roleKey, runId: revoked.runId });
    if (isTerminal(run.state)) {
      return deny(ReasonCode.RUN_ALREADY_TERMINAL, "an ended run's bootstrap CTO is never recovered", {
        roleKey,
        runId: run.runId,
        state: run.state,
      });
    }
    if (!RECOVERABLE_RUN_STATES.includes(run.state) || run.kind !== RunKind.PROJECT_BOOTSTRAP || run.projectId !== null) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "only a held project-less bootstrap run gets its bootstrap CTO back", {
        roleKey,
        runId: run.runId,
        state: run.state,
      });
    }
    // The pin names the generation the outage revoked. Every generation after it is a renewal an
    // earlier recovery abandoned: same session, same incarnation, same actor, never pinned.
    const pinned = history.find((held) => held.bindingGeneration === run.ownerBindingGeneration);
    const actorOf = (held: RoleBinding): string | undefined => this.db.get<{ actor_id: string }>(
      `SELECT actor_id FROM assignments WHERE assignment_id = ?`,
      [held.assignmentId],
    )?.actor_id;
    const sameRuntime = (held: RoleBinding): boolean =>
      held.status === "REVOKED" &&
      held.boundSessionId === revoked.boundSessionId &&
      held.boundSessionIncarnation === revoked.boundSessionIncarnation &&
      held.sessionId === revoked.boundSessionId &&
      actorOf(held) === actorOf(revoked);
    if (
      !pinned ||
      run.ownerRoleKey !== roleKey ||
      run.ownerSessionId !== revoked.boundSessionId ||
      run.ownerSessionIncarnation !== revoked.boundSessionIncarnation ||
      !history.filter((held) => held.bindingGeneration >= pinned.bindingGeneration).every(sameRuntime)
    ) {
      return deny(ReasonCode.RUN_OWNER_REVOKED, "the run is not pinned to a generation this session lost", {
        roleKey,
        runId: run.runId,
        pinnedGeneration: run.ownerBindingGeneration,
      });
    }
    const session = recovery.sessions.get(revoked.boundSessionId);
    if (!session || session.lifecycle !== SessionLifecycle.READY || session.incarnation !== revoked.boundSessionIncarnation) {
      return deny(ReasonCode.SESSION_NOT_READY, "a bootstrap CTO is recovered only on its own READY session", {
        roleKey,
        sessionId: revoked.boundSessionId,
        lifecycle: session?.lifecycle ?? null,
      });
    }
    if (session.provider !== BOOTSTRAP_CTO_RUNTIME.provider || session.model !== BOOTSTRAP_CTO_RUNTIME.model) {
      return deny(ReasonCode.ROLE_RUNTIME_SUBSTITUTION_REFUSED, "the bootstrap CTO's session is not on the fixed Claude Opus runtime", {
        roleKey,
        sessionId: session.sessionId,
        provider: session.provider,
        model: session.model,
      });
    }
    return allow(ReasonCode.OK, { revoked, pinnedGeneration: pinned.bindingGeneration, run, session });
  }

  /**
   * A spawned session that is ERROR and never held any role, by its recorded session or as an
   * actor's runtime: it can never be bound (ERROR leads only to STOPPED), so it is stopped whatever
   * its run is doing. A session that held a role waits for its run to end, and one still STARTING or
   * READY may be the spawn a live run's dispatch is about to bind.
   */
  #neverBindable(sessionId: string, lifecycle: SessionLifecycle): boolean {
    return lifecycle === SessionLifecycle.ERROR && this.db.get<{ role_key: string }>(
      `SELECT a.role_key FROM assignments a
         LEFT JOIN conversational_actors c ON c.actor_id = a.actor_id
        WHERE a.session_id = ? OR c.current_session_id = ?
        LIMIT 1`,
      [sessionId, sessionId],
    ) === undefined;
  }

  /** Whether the session holds any active role, by its recorded session or its actor's live runtime. */
  #holdsRole(sessionId: string): boolean {
    return this.db.get<{ role_key: string }>(
      `SELECT a.role_key FROM assignments a
         LEFT JOIN conversational_actors c ON c.actor_id = a.actor_id
        WHERE a.status = 'ACTIVE' AND (a.session_id = ? OR c.current_session_id = ?)
        LIMIT 1`,
      [sessionId, sessionId],
    ) !== undefined;
  }
}
