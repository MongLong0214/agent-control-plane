import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { CtoLifecycle, CtoPreference } from "../cto/cto-lifecycle.ts";
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
  readonly bindings: Pick<BindingRegistry, "active" | "history" | "bind" | "revoke">;
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
   * never held or is held now, and any owner pin names exactly that binding. Answers the live
   * binding a re-dispatch would reuse, or null when a fresh one is to be staffed.
   */
  admit(run: RunRow): Decision<RoleBinding | null> {
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
   * Inside the dispatch transaction: ask `admit` again — the awaits since can let another dispatch
   * bind, or a revocation land — then bind generation 1 on the fresh session, or confirm the
   * reused binding is still the one probed. The answer is the binding the run is pinned to, by its
   * binding-time runtime (#493), which is what the owner pin's foreign key resolves against.
   */
  bindForDispatch(runId: string, staffed: BootstrapCtoStaffed): Decision<RoleBinding> {
    const run = this.ports.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    const admitted = this.admit(run);
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
   * so is any session that holds a role, whatever produced it.
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
   * transition did not, then has the provider stop every session that served an ended run's
   * bootstrap CTO and holds no active role now. A session holding any role — by its recorded
   * session or its actor's live runtime — is never stopped here.
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

    const served = this.db.all<{ session_id: string; run_id: string | null }>(
      `SELECT a.session_id AS session_id, a.run_id AS run_id
         FROM assignments a
        WHERE a.role = 'BOOTSTRAP_CTO' AND a.status = 'REVOKED'
       UNION
       SELECT c.current_session_id AS session_id, a.run_id AS run_id
         FROM assignments a JOIN conversational_actors c ON c.actor_id = a.actor_id
        WHERE a.role = 'BOOTSTRAP_CTO' AND a.status = 'REVOKED' AND c.current_session_id IS NOT NULL
        ORDER BY session_id`,
    );
    const seen = new Set<string>();
    for (const { session_id: sessionId, run_id: runId } of served) {
      if (seen.has(sessionId)) continue;
      const run = runId === null ? null : this.ports.runs.get(runId);
      if (run && !isTerminal(run.state)) continue;
      seen.add(sessionId);
      const session = this.ports.sessions.get(sessionId);
      if (!session || session.lifecycle === SessionLifecycle.STOPPED) continue;
      if (this.#holdsRole(sessionId)) continue;
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
