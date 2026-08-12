import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { newAssignmentId } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { PRODUCER_ROLES, type Role, type RoleBinding, SessionLifecycle } from "../domain/types.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { SessionRegistry } from "./session-registry.ts";

export interface BindInput {
  roleKey: string;
  role: Role;
  sessionId: string;
  projectId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  mode?: "PREFERRED" | "FALLBACK";
  /** Skip the READY requirement — used only while a session is still starting up. */
  allowStarting?: boolean;
}

/**
 * Role bindings and their generations (PRD §9.4, §15.7).
 *
 * The binding generation is the fencing token for every authority decision in the
 * system, so it is minted here and nowhere else. Monotonicity is enforced by a DB
 * trigger rather than by this code, because two concurrent callers could otherwise both
 * read the same maximum.
 */
export class BindingRegistry {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly sessions: SessionRegistry,
    private readonly outbox: Outbox,
  ) {}

  bind(input: BindInput): Decision<RoleBinding> {
    return this.db.tx(() => {
      const session = this.sessions.get(input.sessionId);
      if (!session) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId: input.sessionId });
      if (
        session.lifecycle !== SessionLifecycle.READY &&
        !(input.allowStarting && session.lifecycle === SessionLifecycle.STARTING)
      ) {
        return deny(ReasonCode.SESSION_NOT_READY, `session is ${session.lifecycle}`, {
          sessionId: input.sessionId,
          lifecycle: session.lifecycle,
        });
      }

      if (this.active(input.roleKey)) {
        return deny(ReasonCode.BINDING_ALREADY_ACTIVE, "role key already has an active binding", {
          roleKey: input.roleKey,
        });
      }

      // CP-HI-04 — a blind reviewer may not be drawn from the run's producer set.
      if (input.role === "BLIND_REVIEWER" && input.runId) {
        const independence = this.assertReviewerIndependence(input.runId, input.sessionId);
        if (!independence.allowed) return independence as Decision<RoleBinding>;
      }

      const generation = this.nextGeneration(input.roleKey);
      const assignmentId = newAssignmentId();
      this.db.run(
        `INSERT INTO assignments (assignment_id, role_key, role, project_id, run_id, task_id,
                                  session_id, session_incarnation, binding_generation, mode, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          assignmentId, input.roleKey, input.role, input.projectId ?? null, input.runId ?? null,
          input.taskId ?? null, input.sessionId, session.incarnation, generation,
          input.mode ?? "PREFERRED", this.clock.nowIso(),
        ],
      );

      this.audit.record({
        kind: "BINDING_CREATED",
        roleKey: input.roleKey,
        sessionId: input.sessionId,
        projectId: input.projectId ?? null,
        runId: input.runId ?? null,
        evidence: { role: input.role, generation, mode: input.mode ?? "PREFERRED" },
      });
      return allow(ReasonCode.OK, this.require(input.roleKey));
    });
  }

  /**
   * §15.7 atomic failover. Activating the new generation, revoking the old one and
   * fencing the outbox all happen in one transaction; a crash between them would leave
   * messages addressed to a revoked generation.
   */
  switchTo(input: BindInput & { reason: string }): Decision<RoleBinding> {
    return this.db.tx(() => {
      const current = this.active(input.roleKey);
      const session = this.sessions.get(input.sessionId);
      if (!session) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId: input.sessionId });
      if (
        session.lifecycle !== SessionLifecycle.READY &&
        !(input.allowStarting && session.lifecycle === SessionLifecycle.STARTING)
      ) {
        return deny(ReasonCode.SESSION_NOT_READY, `incoming session is ${session.lifecycle}`, {
          sessionId: input.sessionId,
        });
      }
      if (input.role === "BLIND_REVIEWER" && input.runId) {
        const independence = this.assertReviewerIndependence(input.runId, input.sessionId);
        if (!independence.allowed) return independence as Decision<RoleBinding>;
      }

      if (current) {
        this.db.run(
          `UPDATE assignments SET status = 'REVOKED', revoked_at = ?, revoked_reason = ?
            WHERE assignment_id = ?`,
          [this.clock.nowIso(), input.reason, current.assignmentId],
        );
      }

      const generation = this.nextGeneration(input.roleKey);
      this.db.run(
        `INSERT INTO assignments (assignment_id, role_key, role, project_id, run_id, task_id,
                                  session_id, session_incarnation, binding_generation, mode, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          newAssignmentId(), input.roleKey, input.role, input.projectId ?? null, input.runId ?? null,
          input.taskId ?? null, input.sessionId, session.incarnation, generation,
          input.mode ?? "PREFERRED", this.clock.nowIso(),
        ],
      );

      const fence = current
        ? this.outbox.retargetOrReject(
            input.roleKey,
            current.bindingGeneration,
            generation,
            input.sessionId,
          )
        : { retargeted: [], rejected: [] };

      this.audit.record({
        kind: "BINDING_SWITCHED",
        roleKey: input.roleKey,
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        projectId: input.projectId ?? null,
        evidence: {
          reason: input.reason,
          fromGeneration: current?.bindingGeneration ?? null,
          fromSession: current?.sessionId ?? null,
          toGeneration: generation,
          retargeted: fence.retargeted.length,
          rejected: fence.rejected.length,
        },
      });

      return allow(ReasonCode.OK, this.require(input.roleKey));
    });
  }

  revoke(roleKey: string, reason: string): Decision<void> {
    const current = this.active(roleKey);
    if (!current) return deny(ReasonCode.NOT_FOUND, "no active binding", { roleKey });
    return this.db.tx(() => {
      this.db.run(
        `UPDATE assignments SET status = 'REVOKED', revoked_at = ?, revoked_reason = ?
          WHERE assignment_id = ?`,
        [this.clock.nowIso(), reason, current.assignmentId],
      );
      const fence = this.outbox.retargetOrReject(
        roleKey,
        current.bindingGeneration,
        current.bindingGeneration,
        current.sessionId,
      );
      // Nothing to retarget onto — everything pending for a revoked role is stale.
      for (const id of fence.retargeted) {
        this.db.run(`UPDATE outbox SET status = 'REJECTED', reason_code = ? WHERE message_id = ?`, [
          ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
          id,
        ]);
      }
      this.audit.record({
        kind: "BINDING_REVOKED",
        roleKey,
        sessionId: current.sessionId,
        evidence: { reason, generation: current.bindingGeneration },
      });
      return allow(ReasonCode.OK, undefined);
    });
  }

  active(roleKey: string): RoleBinding | null {
    const row = this.db.get<RawAssignment>(
      `SELECT * FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
      [roleKey],
    );
    return row ? hydrate(row) : null;
  }

  require(roleKey: string): RoleBinding {
    return this.active(roleKey) ?? fail(ReasonCode.NOT_FOUND, "no active binding", { roleKey });
  }

  activePrimaryCto(projectId: string): RoleBinding | null {
    const row = this.db.get<RawAssignment>(
      `SELECT * FROM assignments WHERE project_id = ? AND role = 'PRIMARY_CTO' AND status = 'ACTIVE'`,
      [projectId],
    );
    return row ? hydrate(row) : null;
  }

  byRun(runId: string): RoleBinding[] {
    return this.db
      .all<RawAssignment>(
        `SELECT * FROM assignments WHERE run_id = ?
            OR task_id IN (SELECT task_id FROM tasks WHERE run_id = ?)
          ORDER BY created_at`,
        [runId, runId],
      )
      .map(hydrate);
  }

  bySession(sessionId: string): RoleBinding[] {
    return this.db
      .all<RawAssignment>(`SELECT * FROM assignments WHERE session_id = ? ORDER BY created_at`, [
        sessionId,
      ])
      .map(hydrate);
  }

  /**
   * CP-HI-04 producer set for a run: primary/bootstrap CTO, workers, and any
   * non-blind reviewer. Computed from bindings actually recorded against the run —
   * including revoked ones, because a session that produced part of the candidate is
   * still a producer after its binding moves on.
   */
  producerSessions(runId: string): Set<string> {
    const rows = this.db.all<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM assignments
        WHERE (run_id = ? OR task_id IN (SELECT task_id FROM tasks WHERE run_id = ?))
          AND role IN (${PRODUCER_ROLES.map(() => "?").join(",")})`,
      [runId, runId, ...PRODUCER_ROLES],
    );
    const set = new Set(rows.map((r) => r.session_id));

    // The pinned run owner is a producer even if its binding is project-scoped.
    const owner = this.db.get<{ owner_session_id: string | null }>(
      `SELECT owner_session_id FROM runs WHERE run_id = ?`,
      [runId],
    );
    if (owner?.owner_session_id) set.add(owner.owner_session_id);

    // Sessions that actually executed a task for this run.
    for (const row of this.db.all<{ worker_session_id: string | null }>(
      `SELECT DISTINCT worker_session_id FROM task_executions WHERE run_id = ?`,
      [runId],
    )) {
      if (row.worker_session_id) set.add(row.worker_session_id);
    }
    return set;
  }

  assertReviewerIndependence(runId: string, sessionId: string): Decision<void> {
    const producers = this.producerSessions(runId);
    if (producers.has(sessionId)) {
      return deny(
        ReasonCode.REVIEWER_SESSION_IS_PRODUCER,
        "candidate reviewer session belongs to the run's producer set",
        { runId, sessionId, producers: [...producers] },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * §4 CP-HI-04 second clause — the final CEO session must differ from both the run's
   * primary CTO and its blind reviewer.
   */
  assertFinalCeoIndependence(runId: string, ceoSessionId: string): Decision<void> {
    const conflicting = this.byRun(runId).filter(
      (b) =>
        (b.role === "PRIMARY_CTO" || b.role === "BOOTSTRAP_CTO" || b.role === "BLIND_REVIEWER") &&
        b.sessionId === ceoSessionId,
    );
    if (conflicting.length > 0) {
      return deny(
        ReasonCode.FINAL_CEO_SESSION_NOT_INDEPENDENT,
        "final CEO session is also the run's CTO or blind reviewer",
        { runId, ceoSessionId, roles: conflicting.map((b) => b.role) },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** True when the generation supplied by a caller is the one currently in force. */
  isCurrent(roleKey: string, generation: number): boolean {
    return this.active(roleKey)?.bindingGeneration === generation;
  }

  history(roleKey: string): RoleBinding[] {
    return this.db
      .all<RawAssignment>(`SELECT * FROM assignments WHERE role_key = ? ORDER BY binding_generation`, [
        roleKey,
      ])
      .map(hydrate);
  }

  private nextGeneration(roleKey: string): number {
    const row = this.db.get<{ maximum: number | null }>(
      `SELECT MAX(binding_generation) AS maximum FROM assignments WHERE role_key = ?`,
      [roleKey],
    );
    return (row?.maximum ?? 0) + 1;
  }
}

interface RawAssignment {
  assignment_id: string;
  role_key: string;
  role: Role;
  project_id: string | null;
  run_id: string | null;
  task_id: string | null;
  session_id: string;
  session_incarnation: string;
  binding_generation: number;
  mode: "PREFERRED" | "FALLBACK";
  status: "ACTIVE" | "REVOKED";
  created_at: string;
}

const hydrate = (row: RawAssignment): RoleBinding => ({
  assignmentId: row.assignment_id,
  roleKey: row.role_key,
  role: row.role,
  projectId: row.project_id,
  runId: row.run_id,
  taskId: row.task_id,
  sessionId: row.session_id,
  sessionIncarnation: row.session_incarnation,
  bindingGeneration: row.binding_generation,
  mode: row.mode,
  status: row.status,
  createdAt: row.created_at,
});
