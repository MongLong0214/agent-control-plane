import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { newAssignmentId } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import {
  PRODUCER_ROLES,
  ROLE_SCOPE,
  Role,
  type RoleBinding,
  SessionLifecycle,
  roleKeyFor,
} from "../domain/types.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { TaskGraph } from "../run/task-graph.ts";
import type { SessionRegistry } from "./session-registry.ts";

export interface BindInput {
  /**
   * Optional. The key is *derived* from the role and its scope; supplying one that does
   * not match is refused, because a mismatched key routes traffic to a session whose
   * role-based checks say something different.
   */
  roleKey?: string;
  role: Role;
  sessionId: string;
  projectId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  mode?: "PREFERRED" | "FALLBACK";
}

const LIVE_RUN_STATES = [
  "QUEUED",
  "ACTIVE",
  "BLOCKED",
  "READY_FOR_CEO_REVIEW",
  "CEO_APPROVED",
  "MERGING",
  "POST_MERGE_VERIFYING",
  "REVISION_REQUIRED",
  "AWAITING_HUMAN",
] as const;

/**
 * Role bindings and their generations (PRD §9.4, §15.7).
 *
 * The binding generation is the fencing token for every authority decision in the
 * system, so it is minted here and nowhere else. Monotonicity is enforced by a DB
 * trigger rather than by this code, because two concurrent callers could otherwise both
 * read the same maximum.
 */
export class BindingRegistry {
  #tasks: TaskGraph | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly sessions: SessionRegistry,
    private readonly outbox: Outbox,
  ) {}

  /** Wired after construction because TaskGraph needs no binding registry dependency. */
  attach(ports: { tasks?: TaskGraph }): void {
    if (ports.tasks) this.#tasks = ports.tasks;
  }

  /**
   * Derives the canonical role key and rejects a caller-supplied key or scope that does
   * not match it. Without this, `bind({roleKey: 'PRIMARY_CTO:P', role: 'CEO'})` would be
   * persisted: key consumers would treat the session as project P's CTO while role-based
   * checks saw a CEO.
   */
  private resolveRoleKey(input: BindInput): Decision<string> {
    const scope = ROLE_SCOPE[input.role];
    const required: Record<typeof scope, string | null | undefined> = {
      none: null,
      project: input.projectId,
      run: input.runId,
      task: input.taskId,
    };
    if (scope !== "none" && !required[scope]) {
      return deny(ReasonCode.INVALID_ARGUMENT, `role ${input.role} requires a ${scope} scope`, {
        role: input.role,
        scope,
      });
    }
    // Extraneous scope is refused too: a WORKER carrying a projectId is addressable two
    // ways, and the two ways can disagree.
    const supplied = { project: input.projectId, run: input.runId, task: input.taskId };
    for (const [name, value] of Object.entries(supplied)) {
      if (!value) continue;
      if (name === scope) continue;
      // A run-scoped role may legitimately record its project for reporting.
      if (scope === "run" && name === "project") continue;
      if (scope === "task" && (name === "run" || name === "project")) continue;
      return deny(ReasonCode.INVALID_ARGUMENT, `role ${input.role} must not carry a ${name} scope`, {
        role: input.role,
        scope,
        extraneous: name,
      });
    }

    const derived = roleKeyFor(input.role, {
      projectId: input.projectId ?? null,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
    });
    if (input.roleKey && input.roleKey !== derived) {
      return deny(ReasonCode.INVALID_ARGUMENT, "supplied role key does not match role and scope", {
        supplied: input.roleKey,
        derived,
      });
    }

    // A role key's semantic role must not change across generations.
    const previous = this.db.get<{ role: Role }>(
      `SELECT role FROM assignments WHERE role_key = ? ORDER BY binding_generation DESC LIMIT 1`,
      [derived],
    );
    if (previous && previous.role !== input.role) {
      return deny(ReasonCode.CONFLICT, "role key already belongs to a different role", {
        roleKey: derived,
        existingRole: previous.role,
        requestedRole: input.role,
      });
    }

    return allow(ReasonCode.OK, derived);
  }

  bind(input: BindInput): Decision<RoleBinding> {
    return this.db.tx(() => {
      const key = this.resolveRoleKey(input);
      if (!key.allowed) return key as Decision<RoleBinding>;
      const roleKey = key.value;
      const session = this.sessions.get(input.sessionId);
      if (!session) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId: input.sessionId });
      if (session.lifecycle !== SessionLifecycle.READY) {
        return deny(ReasonCode.SESSION_NOT_READY, `session is ${session.lifecycle}`, {
          sessionId: input.sessionId,
          lifecycle: session.lifecycle,
        });
      }

      if (this.active(roleKey)) {
        return deny(ReasonCode.BINDING_ALREADY_ACTIVE, "role key already has an active binding", {
          roleKey,
        });
      }

      // CP-HI-04 — a blind reviewer may not be drawn from the run's producer set.
      if (input.role === "BLIND_REVIEWER" && input.runId) {
        const independence = this.assertReviewerIndependence(input.runId, input.sessionId);
        if (!independence.allowed) return independence as Decision<RoleBinding>;
      }

      const generation = this.nextGeneration(roleKey);
      const assignmentId = newAssignmentId();
      const actorId = this.mintActor(input.role, input.sessionId, session.incarnation);
      this.db.run(
        `INSERT INTO assignments (assignment_id, role_key, role, project_id, run_id, task_id,
                                  actor_id, session_id, session_incarnation, binding_generation,
                                  mode, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          assignmentId, roleKey, input.role, input.projectId ?? null, input.runId ?? null,
          input.taskId ?? null, actorId, input.sessionId, session.incarnation, generation,
          input.mode ?? "PREFERRED", this.clock.nowIso(),
        ],
      );

      this.audit.record({
        kind: "BINDING_CREATED",
        roleKey,
        sessionId: input.sessionId,
        projectId: input.projectId ?? null,
        runId: input.runId ?? null,
        evidence: { role: input.role, generation, mode: input.mode ?? "PREFERRED" },
      });
      return allow(ReasonCode.OK, this.require(roleKey));
    });
  }

  /**
   * §15.7 atomic failover. Activating the new generation, revoking the old one and
   * fencing the outbox all happen in one transaction; a crash between them would leave
   * messages addressed to a revoked generation.
   */
  switchTo(
    input: BindInput & { reason: string; takeover?: boolean; expectedCurrentGeneration?: number },
  ): Decision<RoleBinding> {
    return this.db.tx(() => {
      const key = this.resolveRoleKey(input);
      if (!key.allowed) return key as Decision<RoleBinding>;
      const roleKey = key.value;
      const current = this.active(roleKey);

      if (
        input.expectedCurrentGeneration !== undefined &&
        current?.bindingGeneration !== input.expectedCurrentGeneration
      ) {
        return deny(
          ReasonCode.BINDING_GENERATION_STALE,
          "the binding generation changed before the switch could be applied",
          {
            roleKey,
            expectedCurrentGeneration: input.expectedCurrentGeneration,
            actualCurrentGeneration: current?.bindingGeneration ?? null,
          },
        );
      }

      // A plain switch must not orphan work. If the outgoing binding still owns live runs,
      // those runs would be pinned to a revoked generation: the old session is refused
      // because its generation is gone, and the new one because the run still names the
      // old tuple. Either drain first, or ask for an explicit takeover.
      if (current) {
        const orphaned = this.liveRunsOwnedBy(current);
        if (orphaned.length > 0 && !input.takeover) {
          return deny(
            ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS,
            "the outgoing binding still owns live runs; drain them or request a takeover",
            { roleKey, runs: orphaned.map((r) => r.run_id) },
          );
        }
      }

      const session = this.sessions.get(input.sessionId);
      if (!session) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId: input.sessionId });
      if (session.lifecycle !== SessionLifecycle.READY) {
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

      const generation = this.nextGeneration(roleKey);
      // #449 mints a new actor here unconditionally, which preserves exactly the behaviour that
      // existed before the entity was introduced. Reusing the outgoing binding's actor when only
      // the runtime was replaced — so failover stops rotating the generation — is the *next*
      // step, and it needs the caller to say whether the conversation survived. Minting here
      // keeps the schema change behaviour-neutral rather than smuggling the semantic change in.
      const actorId = this.mintActor(input.role, input.sessionId, session.incarnation);
      this.db.run(
        `INSERT INTO assignments (assignment_id, role_key, role, project_id, run_id, task_id,
                                  actor_id, session_id, session_incarnation, binding_generation,
                                  mode, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          newAssignmentId(), roleKey, input.role, input.projectId ?? null, input.runId ?? null,
          input.taskId ?? null, actorId, input.sessionId, session.incarnation, generation,
          input.mode ?? "PREFERRED", this.clock.nowIso(),
        ],
      );

      // A takeover repoints the live runs in the *same* transaction, so a crash cannot
      // leave a run pinned to a revoked generation.
      let repointed = 0;
      if (current && input.takeover) {
        const affectedRuns = this.liveRunsOwnedBy(current);
        const staleExecutions = affectedRuns.flatMap((affected) => this.db.all<{ execution_id: string }>(
          `SELECT execution_id FROM task_executions
            WHERE run_id = ? AND status = 'RUNNING' AND owner_binding_generation <> ?`,
          [affected.run_id, generation],
        ));
        if (staleExecutions.length > 0 && !this.#tasks) {
          return deny(
            ReasonCode.BINDING_GENERATION_STALE,
            "takeover cannot repoint live runs until stale executions can be abandoned",
            {
              roleKey,
              runs: affectedRuns.map((run) => run.run_id),
              executions: staleExecutions.map((execution) => execution.execution_id),
            },
          );
        }
        repointed = this.db.run(
          `UPDATE runs SET owner_session_id = ?, owner_binding_generation = ?,
                           owner_session_incarnation = ?, owner_role_key = ?
            WHERE owner_session_id = ? AND owner_binding_generation = ? AND owner_role_key = ?
              AND state IN (${LIVE_RUN_STATES.map(() => "?").join(",")})`,
          [
            input.sessionId, generation, session.incarnation, roleKey,
            current.sessionId, current.bindingGeneration, current.roleKey, ...LIVE_RUN_STATES,
          ],
        ).changes;
        for (const affected of affectedRuns) {
          this.#tasks?.abandonStaleExecutions(
            affected.run_id,
            generation,
            `binding takeover: ${input.reason}`,
          );
        }
      }

      const fence = current
        ? this.outbox.retargetOrReject(
            roleKey,
            current.bindingGeneration,
            generation,
            input.sessionId,
          )
        : { retargeted: [], rejected: [] };

      this.audit.record({
        kind: "BINDING_SWITCHED",
        roleKey,
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
          runsRepointed: repointed,
          takeover: Boolean(input.takeover),
        },
      });

      return allow(ReasonCode.OK, this.require(roleKey));
    });
  }

  revoke(
    roleKey: string,
    reason: string,
    options: { allowBlockedRuns?: boolean } = {},
  ): Decision<void> {
    return this.db.tx(() => {
      const current = this.active(roleKey);
      if (!current) return deny(ReasonCode.NOT_FOUND, "no active binding", { roleKey });
      const ownedRuns = this.liveRunsOwnedBy(current);
      const orphaned = options.allowBlockedRuns
        ? ownedRuns.filter((run) => run.state !== "BLOCKED")
        : ownedRuns;
      if (orphaned.length > 0) {
        return deny(
          ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS,
          "the active binding owns live runs and cannot be revoked without a takeover",
          { roleKey, runs: orphaned.map((run) => run.run_id) },
        );
      }
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
   * non-blind reviewer. Project-scoped PRIMARY_CTO assignments are included for the
   * run's whole dispatched lifetime, so a takeover never erases the outgoing producer.
   */
  producerSessions(runId: string): Set<string> {
    const history = this.producerHistory(runId);
    if (history.allowed) return history.value;
    return fail(history.reasonCode, history.message, history.evidence);
  }

  private producerHistory(runId: string): Decision<Set<string>> {
    const run = this.db.get<{
      project_id: string | null;
      dispatched_at: string | null;
      ended_at: string | null;
      owner_session_id: string | null;
      owner_binding_generation: number | null;
      owner_role_key: string | null;
    }>(
      `SELECT project_id, dispatched_at, ended_at, owner_session_id, owner_binding_generation, owner_role_key
         FROM runs WHERE run_id = ?`,
      [runId],
    );
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (
      !run.dispatched_at ||
      !run.owner_session_id ||
      run.owner_binding_generation === null ||
      !run.owner_role_key
    ) {
      return deny(
        ReasonCode.PRODUCER_HISTORY_UNAVAILABLE,
        "the run has no complete dispatched owner tuple from which producer history can be reconstructed",
        { runId },
      );
    }

    const rows = this.db.all<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM assignments
        WHERE (run_id = ? OR task_id IN (SELECT task_id FROM tasks WHERE run_id = ?))
          AND role IN (${PRODUCER_ROLES.map(() => "?").join(",")})`,
      [runId, runId, ...PRODUCER_ROLES],
    );
    const set = new Set(rows.map((r) => r.session_id));

    // PRIMARY_CTO is project-scoped. Its immutable assignment history therefore has to
    // be intersected with the run lifetime rather than merely inspecting current owner.
    if (run.project_id) {
      const until = run.ended_at ?? this.clock.nowIso();
      for (const row of this.db.all<{ session_id: string }>(
        `SELECT DISTINCT session_id FROM assignments
          WHERE project_id = ? AND role = 'PRIMARY_CTO'
            AND created_at <= ? AND (revoked_at IS NULL OR revoked_at >= ?)`,
        [run.project_id, until, run.dispatched_at],
      )) {
        set.add(row.session_id);
      }
    }

    const owner = this.db.get<{ role: Role }>(
      `SELECT role FROM assignments
        WHERE role_key = ? AND binding_generation = ? AND session_id = ?`,
      [run.owner_role_key, run.owner_binding_generation, run.owner_session_id],
    );
    if (!owner || !PRODUCER_ROLES.includes(owner.role)) {
      return deny(
        ReasonCode.PRODUCER_HISTORY_UNAVAILABLE,
        "the run owner cannot be matched to an immutable producer binding",
        {
          runId,
          roleKey: run.owner_role_key,
          bindingGeneration: run.owner_binding_generation,
          sessionId: run.owner_session_id,
        },
      );
    }
    set.add(run.owner_session_id);

    const workers = this.workerProducerHistory(runId);
    if (!workers.allowed) return workers;
    for (const sessionId of workers.value) set.add(sessionId);
    return allow(ReasonCode.OK, set);
  }

  /**
   * CP-HI-04 worker provenance supplements the immutable WORKER bindings already in the
   * producer set with execution rows, rather than trusting a caller to fill
   * `worker_session_id`. A null receipt can still identify the worker through its durable
   * process id; if it has neither that match nor a task-scoped WORKER binding, reviewer
   * admission must fail closed rather than treating the run as producer-free.
   */
  private workerProducerHistory(runId: string): Decision<Set<string>> {
    const workers = new Set<string>();
    const executions = this.db.all<{
      execution_id: string;
      task_id: string;
      worker_session_id: string | null;
      worker_process_id: number | null;
    }>(
      `SELECT execution_id, task_id, worker_session_id, worker_process_id
         FROM task_executions WHERE run_id = ?`,
      [runId],
    );

    for (const execution of executions) {
      const boundWorkers = this.db.all<{ session_id: string }>(
        `SELECT DISTINCT session_id FROM assignments
          WHERE role = ? AND task_id = ?`,
        [Role.WORKER, execution.task_id],
      );
      const processWorkers = execution.worker_process_id === null
        ? []
        : this.db.all<{ session_id: string }>(
            `SELECT DISTINCT session_id FROM sessions WHERE os_pid = ?`,
            [execution.worker_process_id],
          );
      for (const binding of boundWorkers) workers.add(binding.session_id);
      for (const processWorker of processWorkers) workers.add(processWorker.session_id);
      if (execution.worker_session_id) workers.add(execution.worker_session_id);

      if (!execution.worker_session_id && boundWorkers.length === 0 && processWorkers.length === 0) {
        return deny(
          ReasonCode.PRODUCER_HISTORY_UNAVAILABLE,
          "worker execution has no recorded worker session, process identity, or task-scoped WORKER binding",
          {
            runId,
            executionId: execution.execution_id,
            taskId: execution.task_id,
          },
        );
      }
    }
    return allow(ReasonCode.OK, workers);
  }

  assertReviewerIndependence(runId: string, sessionId: string): Decision<void> {
    // A directly recorded producer is already disqualifying even when an older fixture
    // or migrated row lacks enough owner history to reconstruct the whole set.
    const directlyRecorded = this.db.get<{ session_id: string }>(
      `SELECT session_id FROM assignments
        WHERE session_id = ?
          AND (run_id = ? OR task_id IN (SELECT task_id FROM tasks WHERE run_id = ?))
          AND role IN (${PRODUCER_ROLES.map(() => "?").join(",")})
        UNION
       SELECT worker_session_id AS session_id FROM task_executions
        WHERE worker_session_id = ? AND run_id = ?
        LIMIT 1`,
      [sessionId, runId, runId, ...PRODUCER_ROLES, sessionId, runId],
    );
    if (directlyRecorded) {
      return deny(
        ReasonCode.REVIEWER_SESSION_IS_PRODUCER,
        "candidate reviewer session belongs to the run's producer set",
        { runId, sessionId, producers: [sessionId] },
      );
    }

    const producerHistory = this.producerHistory(runId);
    if (!producerHistory.allowed) return producerHistory as Decision<void>;
    const producers = producerHistory.value;
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
    // A normal primary CTO binding is project-scoped with run_id NULL, so byRun alone
    // never sees it — and that is exactly the session most likely to be the run's CTO.
    const run = this.db.get<{ project_id: string | null; owner_session_id: string | null }>(
      `SELECT project_id, owner_session_id FROM runs WHERE run_id = ?`,
      [runId],
    );
    if (run?.owner_session_id === ceoSessionId) {
      return deny(
        ReasonCode.FINAL_CEO_SESSION_NOT_INDEPENDENT,
        "final CEO session is the run's pinned owner",
        { runId, ceoSessionId },
      );
    }

    const projectCto = run?.project_id
      ? this.db.get<{ session_id: string }>(
          `SELECT session_id FROM assignments
            WHERE project_id = ? AND role IN ('PRIMARY_CTO','BOOTSTRAP_CTO') AND session_id = ?`,
          [run.project_id, ceoSessionId],
        )
      : undefined;
    if (projectCto) {
      return deny(
        ReasonCode.FINAL_CEO_SESSION_NOT_INDEPENDENT,
        "final CEO session has held the project's CTO role",
        { runId, ceoSessionId, projectId: run?.project_id ?? null },
      );
    }

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

  /**
   * Authenticates a runtime and fences its authority in one check. The session secret
   * proves the session identity; the active binding tuple proves its current generation.
   */
  authenticateBoundSession(input: {
    roleKey: string;
    sessionId: string;
    sessionSecret: string;
    bindingGeneration: number;
  }): Decision<RoleBinding> {
    const authenticated = this.sessions.verifySecret(input.sessionId, input.sessionSecret);
    if (!authenticated.allowed) return authenticated as Decision<RoleBinding>;

    const binding = this.active(input.roleKey);
    if (
      !binding ||
      binding.sessionId !== input.sessionId ||
      binding.bindingGeneration !== input.bindingGeneration
    ) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "session is not the current role binding", {
        roleKey: input.roleKey,
        sessionId: input.sessionId,
        expectedGeneration: input.bindingGeneration,
        currentSessionId: binding?.sessionId ?? null,
        currentGeneration: binding?.bindingGeneration ?? null,
      });
    }
    return allow(ReasonCode.OK, binding);
  }

  history(roleKey: string): RoleBinding[] {
    return this.db
      .all<RawAssignment>(`SELECT * FROM assignments WHERE role_key = ? ORDER BY binding_generation`, [
        roleKey,
      ])
      .map(hydrate);
  }

  /**
   * Creates the conversational actor a binding names (#449).
   *
   * The actor holds the live runtime pointer, so failover can replace the session without
   * touching the binding. `assignments.session_id` keeps recording the runtime at binding time,
   * which is why the composite owner tuple — and the FK from `runs` onto it — still resolves.
   */
  private mintActor(role: string, sessionId: string, incarnation: string): string {
    const actorId = `actor:${newAssignmentId()}`;
    this.db.run(
      `INSERT INTO conversational_actors
         (actor_id, kind, current_session_id, current_session_incarnation, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [actorId, role, sessionId, incarnation, this.clock.nowIso()],
    );
    return actorId;
  }

  private nextGeneration(roleKey: string): number {
    const row = this.db.get<{ maximum: number | null }>(
      `SELECT MAX(binding_generation) AS maximum FROM assignments WHERE role_key = ?`,
      [roleKey],
    );
    return (row?.maximum ?? 0) + 1;
  }

  private liveRunsOwnedBy(binding: RoleBinding): Array<{ run_id: string; state: string }> {
    return this.db.all<{ run_id: string; state: string }>(
      `SELECT run_id, state FROM runs
        WHERE owner_session_id = ? AND owner_binding_generation = ? AND owner_role_key = ?
          AND state IN (${LIVE_RUN_STATES.map(() => "?").join(",")})`,
      [binding.sessionId, binding.bindingGeneration, binding.roleKey, ...LIVE_RUN_STATES],
    );
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
