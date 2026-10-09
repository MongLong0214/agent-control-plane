import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { BOOTSTRAP_CTO_SPAWN_RECORD, type CtoLifecycle, type CtoPreference } from "../cto/cto-lifecycle.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { FIXED_ROLE_RUNTIME } from "../domain/fixed-role-runtime.ts";
import { isTerminal } from "../domain/run-state.ts";
import { Role, type RoleBinding, RunKind, type RunRow, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";

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

/**
 * Issue #246 PR-C slice C1 — the production path that staffs a project-less PROJECT_BOOTSTRAP
 * run's `BOOTSTRAP_CTO(run)` (RF PRD:156, :360; ACP PRD §9.5) and reclaims it when the run ends.
 * Modelled on `WorkerStaffing`.
 *
 * Dispatch admission asks it in three steps: `admit` before capacity (the refusals that need no
 * provider), `ensure` after capacity (spawn a fresh session, or probe the live binding a
 * re-dispatch reuses), and `bindForDispatch` inside the dispatch transaction, which binds, pins
 * and enqueues RUN_DISPATCH together. It mints generation 1 only. A role with any history and no
 * live binding is refused `BINDING_REVOKED`: replacing a bootstrap CTO belongs to continuity, not
 * to a second provisioning, and a retry restores the existing binding rather than minting an actor.
 *
 * The session is its own: `BindingRegistry` keeps a BOOTSTRAP_CTO alone on its session in both
 * directions, so it is never promoted, never a reviewer, and two runs get two sessions. It is
 * run-scoped work, not a canonical actor, so nothing here reads or replaces the CEO's or a project
 * CTO's canonical conversation.
 */
export class BootstrapCtoStaffing {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly ports: BootstrapCtoStaffingPorts,
  ) {}

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
        "the run's bootstrap CTO role was held before; its replacement belongs to continuity, not a second provisioning",
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
