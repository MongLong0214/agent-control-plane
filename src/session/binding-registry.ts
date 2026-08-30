import { randomUUID } from "node:crypto";
import type { Clock } from "../core/clock.ts";
import { canonicalJson, digestOf, isDigest } from "../core/digest.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { newAssignmentId } from "../core/ids.ts";
import { processStartedAt } from "../core/process-identity.ts";
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

/**
 * Proof, supplied by the caller, that a target belongs to an actor.
 *
 * Only an authenticated preflight bind against the executor can produce one (#638). It is a
 * parameter rather than something this registry derives, because every route it could derive it
 * from is a claim: a command line is execution configuration, a runtime echoing its own argv is
 * the same string travelling through a handshake, and an operator typing the id twice drifts.
 *
 * Its absence is not an error and not a default — it means the actor's target is unestablished,
 * and a role bound without one is deliberately not routable.
 */
export interface VerifiedTargetBinding {
  /** Which executor family the locator belongs to. */
  executorKind: string;
  /** What the executor itself accepts as a lookup handle. Never derived, never parsed. */
  targetLocator: string;
  /** For comparison and uniqueness; a digest cannot serve as a lookup handle. */
  targetLocatorDigest: string;
}

/** The tuple the executor signs before a target is allowed to become routable. */
export interface AuthenticatedTargetTuple {
  actorId: string;
  generation: number;
  assignmentId: string;
  sessionId: string;
  incarnation: string;
}

/** A claimed target selects reuse only; the executor authenticates the complete planned tuple. */
export interface AuthenticatedTargetBinding {
  claimed: VerifiedTargetBinding;
  protocolVersion: string;
  attestationDigest: string;
  /** The raw, closed Hermes target-bind response; generic executor protocols omit this. */
  targetBindReceipt?: unknown;
  /** Required for Hermes target-bind so receipt identity is bound at persistence, not only at bootstrap. */
  expectedExecutorRuntimeIdentity?: string;
  verify(tuple: AuthenticatedTargetTuple): VerifiedTargetBinding | null;
}

/** The eight fields Hermes emits after it has authenticated the planned binding tuple. */
export interface HermesTargetBindReceipt {
  domain: "hermes.target-bind";
  version: 1;
  actor_id: string;
  binding_generation: number;
  executor_runtime_identity: string;
  requested_session_id: string;
  lineage_root_digest: string;
  receipt_digest: string;
}

const HERMES_TARGET_BIND_PROTOCOL = "hermes.target-bind/v1";
const HERMES_TARGET_BIND_RECEIPT_KEYS = [
  "actor_id",
  "binding_generation",
  "domain",
  "executor_runtime_identity",
  "lineage_root_digest",
  "receipt_digest",
  "requested_session_id",
  "version",
] as const;

interface ValidatedHermesTargetBindReceipt {
  receipt: HermesTargetBindReceipt;
  canonicalJson: string;
  attestationDigest: string;
  /** The bootstrap expectation, persisted independently from the executor-controlled receipt. */
  expectedExecutorRuntimeIdentity: string;
}

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
  /**
   * The target this binding's actor owns, if it has been established.
   *
   * Supplied, an actor that already owns this target is reused rather than replaced — which is
   * what makes reconstitution a recovery instead of a second owner for one transcript. Omitted,
   * a fresh actor is minted and the binding is not routable to a conversation, because nothing
   * has said which conversation it is.
   */
  verifiedTarget?: VerifiedTargetBinding;
  /** Authenticated successor to `verifiedTarget`; legacy callers remain compatible. */
  authenticatedTarget?: AuthenticatedTargetBinding;
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
    return this.db.txDecision(() => {
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
      const claimedTarget = input.authenticatedTarget?.claimed ?? input.verifiedTarget;
      const reused = this.actorOwning(claimedTarget);
      if (!reused.allowed) return reused as Decision<RoleBinding>;
      // Plan a new id before verification so target authentication is the last pre-write step.
      const freshCandidate = `actor:${newAssignmentId()}`;
      const provisionalActorId = reused.value ?? freshCandidate;
      let hermesReceipt: ValidatedHermesTargetBindReceipt | null = null;
      if (input.authenticatedTarget) {
        let authenticated: VerifiedTargetBinding | null;
        try {
          authenticated = input.authenticatedTarget.verify({
            actorId: provisionalActorId,
            generation,
            assignmentId,
            sessionId: input.sessionId,
            incarnation: session.incarnation,
          });
        } catch (error) {
          return deny(ReasonCode.INTERNAL_ERROR, "target verification failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!claimedTarget || !authenticated || !this.sameTarget(authenticated, claimedTarget)) {
          return deny(ReasonCode.CONFLICT, "authenticated target did not confirm the claimed target", {
            claimed: claimedTarget,
            authenticated,
          });
        }
        const validatedReceipt = this.validateHermesTargetBindReceipt(
          input.authenticatedTarget,
          {
            actorId: provisionalActorId,
            generation,
            requestedSessionId: claimedTarget.targetLocator,
            lineageRootDigest: claimedTarget.targetLocatorDigest,
          },
        );
        if (!validatedReceipt.allowed) return validatedReceipt as Decision<RoleBinding>;
        hermesReceipt = validatedReceipt.value;
      }
      // Reuse when the target says which actor owns it; mint otherwise.
      //
      // Minting unconditionally is how re-bootstrapping against the same conversation produced a
      // second owner for one transcript (#649). Two actors do not collide on anything — not the
      // turn partition, not receipt harvest, not reconstitution — so the alias is silent, and
      // `canonical_turns` records a lifetime bijection that would then be unsatisfiable.
      //
      // Without a verified target the mint still happens, because a role has to bind for the
      // deployment to come up at all. What does not happen is any claim about which conversation
      // it answers: that is established by an authenticated preflight bind (#638), and until one
      // exists this binding is not routable to a transcript.
      const actorId = reused.value ?? this.mintActor(
        input.role,
        input.sessionId,
        session.incarnation,
        freshCandidate,
      );
      if (reused.value !== null) {
        // The actor survives and the runtime does not, which is the whole content of a reuse.
        // `mintActor` sets this pointer for a new actor; without the same move here the recovered
        // actor would still name the process that died, and every reader of the live pointer —
        // routing, doctor, the conversation port — would be sent to it.
        this.db.run(
          `UPDATE conversational_actors
              SET current_session_id = ?, current_session_incarnation = ?
            WHERE actor_id = ?`,
          [input.sessionId, session.incarnation, actorId],
        );
      }
      const targetBinding = claimedTarget
        ? this.targetBindingId(actorId, claimedTarget)
        : allow(ReasonCode.OK, null);
      if (!targetBinding.allowed) return targetBinding as Decision<RoleBinding>;
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
      if (input.authenticatedTarget && targetBinding.value) {
        const attested = this.recordTargetAttestation({
          targetBindingId: targetBinding.value,
          generation,
          assignmentId,
          sessionId: input.sessionId,
          incarnation: session.incarnation,
          protocolVersion: input.authenticatedTarget.protocolVersion,
          attestationDigest: hermesReceipt?.attestationDigest ?? input.authenticatedTarget.attestationDigest,
          targetBindReceiptJson: hermesReceipt?.canonicalJson ?? null,
          targetBindExecutorRuntimeIdentity: hermesReceipt?.expectedExecutorRuntimeIdentity ?? null,
        });
        if (!attested.allowed) return attested as Decision<RoleBinding>;
      }

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
   *
   * `conversation` says whether the counterpart survived (#493). It is required and has no
   * default, because a default is a guess and either guess is wrong for half the call sites:
   * `continuity-kernel` provisions a replacement after a session dies — the runtime went, the
   * counterpart did not — while a `cto-lifecycle` handoff is a different CTO genuinely taking
   * the role. Inferring it from provider and model would be the control plane guessing at
   * identity, which is the thing `conversational_actors` exists to stop.
   */
  switchTo(
    input: BindInput & {
      reason: string;
      conversation: "SURVIVED" | "REPLACED";
      takeover?: boolean;
      expectedCurrentGeneration?: number;
    },
  ): Decision<RoleBinding> {
    // #664 — this body's writes (the runtime move, the revoke+mint+insert, the run
    // repoint) are the switch being decided; a denial anywhere below must not leave any
    // of them behind, including the "the transaction rolls back" the comment two writes
    // down already promised and `tx()` alone could not keep.
    return this.db.txDecision(() => {
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
      // A surviving conversation strands nothing: the binding is not replaced, so live runs stay
      // pinned to the same tuple and the same generation. The guard below exists because a *new*
      // generation would leave them owned by a revoked one — a condition this path cannot create.
      if (current && input.conversation === "REPLACED") {
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

      // #493 — the counterpart survived, so only its runtime moves. The binding is not
      // rewritten, which is why `binding_generation` cannot advance here: there is no new row
      // to carry a generation. Holding a generation across a rewrite would have meant weakening
      // `assignments_generation_monotonic`, and weakening a fencing guard to implement failover
      // is the wrong direction.
      if (input.conversation === "SURVIVED") {
        if (!current) {
          return deny(
            ReasonCode.NOT_FOUND,
            "no active binding to carry a surviving conversation",
            { roleKey },
          );
        }
        // `RoleBinding` deliberately does not carry the actor: #449 kept the binding's shape
        // and put the live runtime pointer on the actor, so this reads it where it lives.
        const owner = this.db.get<{ actor_id: string }>(
          `SELECT actor_id FROM assignments WHERE assignment_id = ?`,
          [current.assignmentId],
        );
        if (!owner) {
          return deny(ReasonCode.NOT_FOUND, "the active binding has no actor", {
            roleKey,
            assignmentId: current.assignmentId,
          });
        }
        const moved = this.db.run(
          `UPDATE conversational_actors
              SET current_session_id = ?, current_session_incarnation = ?
            WHERE actor_id = ? AND retired_at IS NULL`,
          [input.sessionId, session.incarnation, owner.actor_id],
        );
        // A retired or missing actor cannot take a new runtime. Reporting success here would
        // leave a live binding pointing at an actor that never moved — CP-HI-08's shape — and
        // the transaction rolls back rather than leaving the pointer indeterminate.
        if (moved.changes !== 1) {
          return deny(
            ReasonCode.CONFLICT,
            "the conversational actor could not take the incoming runtime",
            { roleKey, actorId: owner.actor_id, sessionId: input.sessionId },
          );
        }
        this.audit.record({
          kind: "BINDING_RUNTIME_MOVED",
          roleKey,
          sessionId: input.sessionId,
          projectId: input.projectId ?? null,
          runId: input.runId ?? null,
          evidence: {
            actorId: owner.actor_id,
            generation: current.bindingGeneration,
            reason: input.reason,
          },
        });
        return allow(ReasonCode.OK, this.require(roleKey));
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
            // Both sides are identity: the new row's own binding-time runtime, and the outgoing
            // binding's. `current.sessionId` is the live view and would fail to match the tuple
            // the run actually holds (#493).
            input.sessionId, generation, session.incarnation, roleKey,
            current.boundSessionId, current.bindingGeneration, current.roleKey, ...LIVE_RUN_STATES,
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
      `SELECT a.*,
              c.current_session_id AS live_session_id,
              c.current_session_incarnation AS live_session_incarnation
         FROM assignments a
         LEFT JOIN conversational_actors c ON c.actor_id = a.actor_id
        WHERE a.role_key = ? AND a.status = 'ACTIVE'`,
      [roleKey],
    );
    return row ? hydrate(row) : null;
  }

  require(roleKey: string): RoleBinding {
    return this.active(roleKey) ?? fail(ReasonCode.NOT_FOUND, "no active binding", { roleKey });
  }

  activePrimaryCto(projectId: string): RoleBinding | null {
    const row = this.db.get<RawAssignment>(
      `SELECT a.*,
              c.current_session_id AS live_session_id,
              c.current_session_incarnation AS live_session_incarnation
         FROM assignments a
         LEFT JOIN conversational_actors c ON c.actor_id = a.actor_id
        WHERE a.project_id = ? AND a.role = 'PRIMARY_CTO' AND a.status = 'ACTIVE'`,
      [projectId],
    );
    return row ? hydrate(row) : null;
  }

  byRun(runId: string): RoleBinding[] {
    return this.db
      .all<RawAssignment>(
        `SELECT a.*,
              c.current_session_id AS live_session_id,
              c.current_session_incarnation AS live_session_incarnation
         FROM assignments a
         LEFT JOIN conversational_actors c ON c.actor_id = a.actor_id
        WHERE a.run_id = ?
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
      // #505 — a pid alone does not identify a process. Pids are reused, and resolving one to a
      // session here decides who counts as a producer: if the real producer stops matching, it
      // can be admitted as its own blind reviewer, which is CP-HI-04 defeated. Matching the
      // recorded start time as well makes a reused pid resolve to nothing instead of to the
      // wrong session — unverifiable is the fail-closed answer, not a match.
      const workerProcessIdentity =
        execution.worker_process_id === null ? null : processStartedAt(execution.worker_process_id);
      const processWorkers = execution.worker_process_id === null || workerProcessIdentity === null
        ? []
        : this.db.all<{ session_id: string }>(
            `SELECT DISTINCT session_id FROM sessions
              WHERE os_pid = ? AND os_process_started_at = ?`,
            [execution.worker_process_id, workerProcessIdentity],
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
   * Returns only raw Hermes evidence that still names the exact live role/session incarnation.
   * It deliberately reparses and rechecks the stored evidence rather than rebuilding it from
   * configuration, and it never asks Hermes to bind again while serving a read.
   */
  currentHermesTargetBindReceipt(input: {
    roleKey: string;
    sessionId: string;
    sessionIncarnation: string;
  }): HermesTargetBindReceipt | null {
    const rows = this.db.all<{
      actor_id: string;
      binding_generation: number;
      target_locator: string;
      target_locator_digest: string;
      attestation_digest: string;
      target_bind_receipt_json: string;
      target_bind_executor_runtime_identity: string;
    }>(
      `SELECT a.actor_id, a.binding_generation, b.target_locator, b.target_locator_digest,
              t.attestation_digest, t.target_bind_receipt_json, t.target_bind_executor_runtime_identity
         FROM assignments a
         JOIN conversational_actors c
           ON c.actor_id = a.actor_id
          AND c.current_session_id = a.session_id
          AND c.current_session_incarnation = a.session_incarnation
         JOIN sessions s
           ON s.session_id = a.session_id
          AND s.incarnation = a.session_incarnation
          AND s.lifecycle = 'READY'
         JOIN actor_target_bindings b
           ON b.target_actor_id = a.actor_id
          AND b.executor_kind = 'hermes'
         JOIN actor_target_attestations t
           ON t.target_binding_id = b.target_binding_id
          AND t.assignment_id = a.assignment_id
          AND t.executor_session_id = a.session_id
          AND t.executor_session_incarnation = a.session_incarnation
          AND t.binding_generation = a.binding_generation
          AND t.protocol_version = ?
          AND t.target_bind_receipt_json IS NOT NULL
          AND t.target_bind_executor_runtime_identity IS NOT NULL
        WHERE a.role_key = ?
          AND a.status = 'ACTIVE'
          AND a.session_id = ?
          AND a.session_incarnation = ?`,
      [HERMES_TARGET_BIND_PROTOCOL, input.roleKey, input.sessionId, input.sessionIncarnation],
    );
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.target_bind_receipt_json);
    } catch {
      return null;
    }
    const receipt = this.parseHermesTargetBindReceipt(parsed, {
      actorId: row.actor_id,
      generation: row.binding_generation,
      requestedSessionId: row.target_locator,
      lineageRootDigest: row.target_locator_digest,
      executorRuntimeIdentity: row.target_bind_executor_runtime_identity,
    });
    if (!receipt || receipt.receipt_digest !== row.attestation_digest) return null;
    try {
      return canonicalJson(receipt) === row.target_bind_receipt_json ? receipt : null;
    } catch {
      return null;
    }
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

  /**
   * The actor that already owns this target, or null when the target is new or unestablished.
   *
   * Refuses rather than guesses in the one case that would corrupt the bijection: a locator whose
   * binding names an actor that is no longer usable. A retired actor still owns its transcript —
   * `actor_target_bindings` is a lifetime relation, not an active-only one — so this returns it
   * and lets the caller's own lifecycle rules decide, instead of quietly minting a second owner.
   */
  private actorOwning(target: VerifiedTargetBinding | undefined): Decision<string | null> {
    if (!target) return allow(ReasonCode.OK, null);
    const row = this.db.get<{ target_actor_id: string }>(
      `SELECT target_actor_id FROM actor_target_bindings
        WHERE executor_kind = ? AND target_locator_digest = ?`,
      [target.executorKind, target.targetLocatorDigest],
    );
    return allow(ReasonCode.OK, row?.target_actor_id ?? null);
  }

  private sameTarget(
    left: VerifiedTargetBinding,
    right: VerifiedTargetBinding,
  ): boolean {
    return left.executorKind === right.executorKind &&
      left.targetLocator === right.targetLocator &&
      left.targetLocatorDigest === right.targetLocatorDigest;
  }

  /** Validates executor evidence before bind() writes its actor, assignment, or attestation. */
  private validateHermesTargetBindReceipt(
    authenticated: AuthenticatedTargetBinding,
    expected: {
      actorId: string;
      generation: number;
      requestedSessionId: string;
      lineageRootDigest: string;
    },
  ): Decision<ValidatedHermesTargetBindReceipt | null> {
    if (authenticated.protocolVersion !== HERMES_TARGET_BIND_PROTOCOL) return allow(ReasonCode.OK, null);
    if (authenticated.claimed.executorKind !== "hermes") {
      return deny(ReasonCode.CONFLICT, "Hermes target receipt does not name a Hermes target", {});
    }
    const expectedExecutorRuntimeIdentity = authenticated.expectedExecutorRuntimeIdentity;
    if (typeof expectedExecutorRuntimeIdentity !== "string" || expectedExecutorRuntimeIdentity.length === 0) {
      return deny(ReasonCode.CONFLICT, "Hermes target receipt has no expected executor runtime identity", {});
    }
    let receipt: HermesTargetBindReceipt | null;
    try {
      receipt = this.parseHermesTargetBindReceipt(authenticated.targetBindReceipt, {
        ...expected,
        executorRuntimeIdentity: expectedExecutorRuntimeIdentity,
      });
    } catch {
      receipt = null;
    }
    if (!receipt) {
      return deny(ReasonCode.CONFLICT, "Hermes target receipt is malformed or does not match the planned tuple", {});
    }
    let attestationDigest: string;
    try {
      attestationDigest = authenticated.attestationDigest;
    } catch (error) {
      return deny(ReasonCode.CONFLICT, "Hermes target receipt has no readable attestation digest", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (attestationDigest !== receipt.receipt_digest) {
      return deny(ReasonCode.CONFLICT, "Hermes target receipt digest disagrees with its attestation", {});
    }
    return allow(ReasonCode.OK, {
      receipt,
      canonicalJson: canonicalJson(receipt),
      attestationDigest,
      expectedExecutorRuntimeIdentity,
    });
  }

  /** Parses the closed protocol object and recomputes the digest over its seven public fields. */
  private parseHermesTargetBindReceipt(
    input: unknown,
    expected: {
      actorId: string;
      generation: number;
      requestedSessionId: string;
      lineageRootDigest: string;
      executorRuntimeIdentity?: string;
    },
  ): HermesTargetBindReceipt | null {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== HERMES_TARGET_BIND_RECEIPT_KEYS.length ||
      HERMES_TARGET_BIND_RECEIPT_KEYS.some((key) => !Object.hasOwn(record, key))
    ) return null;
    if (
      record.domain !== "hermes.target-bind" ||
      record.version !== 1 ||
      record.actor_id !== expected.actorId ||
      record.binding_generation !== expected.generation ||
      record.requested_session_id !== expected.requestedSessionId ||
      record.lineage_root_digest !== expected.lineageRootDigest ||
      (expected.executorRuntimeIdentity !== undefined &&
        record.executor_runtime_identity !== expected.executorRuntimeIdentity) ||
      typeof record.executor_runtime_identity !== "string" ||
      record.executor_runtime_identity.length === 0 ||
      !Number.isSafeInteger(record.binding_generation) ||
      !isDigest(record.lineage_root_digest) ||
      !isDigest(record.receipt_digest)
    ) return null;
    const receipt: HermesTargetBindReceipt = {
      domain: record.domain,
      version: record.version,
      actor_id: record.actor_id,
      binding_generation: record.binding_generation,
      executor_runtime_identity: record.executor_runtime_identity,
      requested_session_id: record.requested_session_id,
      lineage_root_digest: record.lineage_root_digest,
      receipt_digest: record.receipt_digest,
    };
    const publicFields = {
      domain: receipt.domain,
      version: receipt.version,
      actor_id: receipt.actor_id,
      binding_generation: receipt.binding_generation,
      executor_runtime_identity: receipt.executor_runtime_identity,
      requested_session_id: receipt.requested_session_id,
      lineage_root_digest: receipt.lineage_root_digest,
    };
    return receipt.receipt_digest === digestOf(publicFields) ? receipt : null;
  }

  /** Finds the exact existing target-binding id or records a new one for this actor. */
  private targetBindingId(actorId: string, target: VerifiedTargetBinding): Decision<string> {
    const existing = this.db.get<{ target_binding_id: string; target_actor_id: string }>(
      `SELECT target_binding_id, target_actor_id FROM actor_target_bindings
        WHERE executor_kind = ? AND target_locator_digest = ?`,
      [target.executorKind, target.targetLocatorDigest],
    );
    if (existing) {
      if (existing.target_actor_id !== actorId) {
        return deny(ReasonCode.CONFLICT, "target is already bound to another actor", {
          actorId,
          targetActorId: existing.target_actor_id,
          executorKind: target.executorKind,
        });
      }
      return allow(ReasonCode.OK, existing.target_binding_id);
    }

    const targetBindingId = `tb_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    try {
      this.db.run(
        `INSERT INTO actor_target_bindings
           (target_binding_id, target_actor_id, executor_kind, target_locator,
            target_locator_digest, bound_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          targetBindingId,
          actorId,
          target.executorKind,
          target.targetLocator,
          target.targetLocatorDigest,
          this.clock.nowIso(),
        ],
      );
      return allow(ReasonCode.OK, targetBindingId);
    } catch (error) {
      return deny(
        ReasonCode.INTERNAL_ERROR,
        "target binding could not be recorded",
        { actorId, executorKind: target.executorKind, error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private recordTargetAttestation(input: {
    targetBindingId: string;
    generation: number;
    assignmentId: string;
    sessionId: string;
    incarnation: string;
    protocolVersion: string;
    attestationDigest: string;
    targetBindReceiptJson: string | null;
    targetBindExecutorRuntimeIdentity: string | null;
  }): Decision<void> {
    try {
      this.db.run(
        `INSERT INTO actor_target_attestations
           (target_attestation_id, target_binding_id, binding_generation, assignment_id, executor_session_id,
            executor_session_incarnation, protocol_version, attestation_digest, target_bind_receipt_json,
            target_bind_executor_runtime_identity, attested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `ta_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          input.targetBindingId,
          input.generation,
          input.assignmentId,
          input.sessionId,
          input.incarnation,
          input.protocolVersion,
          input.attestationDigest,
          input.targetBindReceiptJson,
          input.targetBindExecutorRuntimeIdentity,
          this.clock.nowIso(),
        ],
      );
      return allow(ReasonCode.OK, undefined);
    } catch (error) {
      return deny(ReasonCode.INTERNAL_ERROR, "target attestation could not be recorded", {
        targetBindingId: input.targetBindingId,
        assignmentId: input.assignmentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private mintActor(role: string, sessionId: string, incarnation: string, actorId?: string): string {
    const exactActorId = actorId ?? `actor:${newAssignmentId()}`;
    this.db.run(
      `INSERT INTO conversational_actors
         (actor_id, kind, current_session_id, current_session_incarnation, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [exactActorId, role, sessionId, incarnation, this.clock.nowIso()],
    );
    return exactActorId;
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
  /** Joined from the actor; null only where a binding's actor has no runtime yet. */
  live_session_id: string | null;
  live_session_incarnation: string | null;
}

const hydrate = (row: RawAssignment): RoleBinding => ({
  assignmentId: row.assignment_id,
  roleKey: row.role_key,
  role: row.role,
  projectId: row.project_id,
  runId: row.run_id,
  taskId: row.task_id,
  // The live runtime, resolved through the actor. COALESCE covers an actor that has not been
  // given a runtime yet; the binding's own value is the correct answer there.
  sessionId: row.live_session_id ?? row.session_id,
  sessionIncarnation: row.live_session_incarnation ?? row.session_incarnation,
  boundSessionId: row.session_id,
  boundSessionIncarnation: row.session_incarnation,
  bindingGeneration: row.binding_generation,
  mode: row.mode,
  status: row.status,
  createdAt: row.created_at,
});
