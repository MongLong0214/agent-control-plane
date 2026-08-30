import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { isWithin } from "../guard/workspace-probe.ts";
import {
  type DispatchCapacityTarget,
  type ProviderCapacity,
  type CapacityMonitor,
  RefreshTrigger,
} from "../capacity/capacity-monitor.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { ContinuityMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { ProviderRegistry, SessionHandle } from "../runtime/provider.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRecord, SessionRegistry } from "../session/session-registry.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";

export type CoverageOutcome = "FULL_COVERAGE" | "PARTIAL_COVERAGE" | "NO_VALID_COVERAGE";

export type CoverageAction =
  | "WAIT_FOR_RESET"
  | "FALLBACK_ROLE"
  | "PAUSE_NEW_WORK"
  | "OWNER_APPROVED_PROJECT_SUSPEND"
  | "SURVIVAL";

export interface RequiredRole {
  roleKey: string;
  role: Role;
  capability: string;
  projectId: string | null;
  runId: string | null;
  taskId: string | null;
  /** Roles the coverage plan must keep on distinct sessions (CP-HI-04). */
  isolationGroup: string;
  inFlight: boolean;
}

export interface RoleCoveragePlan {
  outcome: CoverageOutcome;
  action: CoverageAction;
  mode: ContinuityMode;
  requiredRoles: RequiredRole[];
  assignments: Array<{ roleKey: string; provider: string | null; reason: string }>;
  uncovered: string[];
  providers: Array<{
    provider: string;
    optional: boolean;
    admission: string;
    runtimeHealth: string;
    advisoryState: string;
  }>;
  computedAt: string;
}

/** §14.5 — Grok is an optional adversarial reviewer and never a critical dependency. */
const OPTIONAL_PROVIDERS: ReadonlySet<string> = new Set(["grok"]);

/** Preferred normal binding (§15.1) in priority order per capability. */
const PREFERENCE: Readonly<Record<string, readonly string[]>> = {
  ceo: ["gpt", "claude"],
  cto: ["claude", "gpt"],
  "blind-review": ["gpt", "claude"],
  worker: ["gpt", "claude"],
};

/**
 * PRD §15.
 *
 * The kernel never rewires a role before it has a plan. `computeCoveragePlan` answers
 * "given the buckets, capabilities and isolation requirements that exist right now,
 * which roles can be staffed at all?" — and only then does anything move.
 */
export class ContinuityKernel {
  #readiness: { checkSession(sessionId: string): Promise<Decision<void>> } | null = null;
  #buzz: { connect(sessionId: string, purpose: string): Promise<Decision<string>> } | null = null;

  /**
   * §15.7 requires the new session to be READY *before* the switch. Without a readiness
   * probe and a route, a failover would hand the role to an id nothing can reach, and the
   * next fenced message would have nowhere to go. Missing ports therefore fail closed.
   */
  attach(ports: {
    readiness?: { checkSession(sessionId: string): Promise<Decision<void>> };
    buzz?: { connect(sessionId: string, purpose: string): Promise<Decision<string>> };
  }): void {
    if (ports.readiness) this.#readiness = ports.readiness;
    if (ports.buzz) this.#buzz = ports.buzz;
  }

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly capacity: CapacityMonitor,
    private readonly providers: ProviderRegistry,
    private readonly projects: ProjectRegistry,
    private readonly runs: RunEngine,
    private readonly sessions: SessionRegistry,
    private readonly bindings: BindingRegistry,
    private readonly telemetry: Telemetry,
    private readonly managedRuntimeRoot = join(tmpdir(), "agent-control-plane-runtime"),
  ) {
    ensurePrivateDirectory(this.managedRuntimeRoot);
  }

  mode(): ContinuityMode {
    const row = this.db.get<{ mode: ContinuityMode }>(`SELECT mode FROM continuity_state WHERE id = 1`);
    return row?.mode ?? ContinuityMode.NORMAL;
  }

  /** How long ago coverage was actually computed, in ms; Infinity if never. */
  modeAgeMs(): number {
    const row = this.db.get<{ evaluated_at: string | null }>(
      `SELECT evaluated_at FROM continuity_state WHERE id = 1`,
    );
    if (!row?.evaluated_at) return Number.POSITIVE_INFINITY;
    const at = new Date(row.evaluated_at).getTime();
    if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
    return Math.max(0, new Date(this.clock.nowIso()).getTime() - at);
  }

  /** §15.3 — computed before any failover, never after. */
  computeCoveragePlan(): RoleCoveragePlan {
    const requiredRoles = this.requiredRoles();
    const productionProviders = new Set(this.providers.production().map((adapter) => adapter.provider));
    const capacities = this.capacity.all().filter((capacity) => productionProviders.has(capacity.provider));
    const byProvider = new Map(capacities.map((c) => [c.provider, c]));

    const usable = (provider: string, capability: string): ProviderCapacity | null => {
      const capacity = byProvider.get(provider);
      if (!capacity) return null;
      // Same routability rule the monitor applies: an unknown bucket is not routable.
      return this.capacity.isRoutableFor(capacity, capability) ? capacity : null;
    };

    const assignments: RoleCoveragePlan["assignments"] = [];
    const uncovered: string[] = [];
    // Isolation groups must land on different providers where possible, so a single
    // provider outage cannot take a producer and its reviewer at once.
    const usedByGroup = new Map<string, Set<string>>();

    // The §15.1 order first, then any other registered provider that can serve the
    // capability. Coverage must reflect the providers this deployment actually has, not a
    // hardcoded roster: an unlisted provider is a fallback, not an absence of coverage.
    const registered = this.providers.production().map((adapter) => adapter.provider);
    const candidatesFor = (capability: string): string[] => {
      const ranked = (PREFERENCE[capability] ?? []).filter((p) => byProvider.has(p) || registered.includes(p));
      // §14.5 — an optional provider never becomes coverage on its own. It is a
      // candidate only where the preference table names it explicitly.
      const rest = registered.filter((p) => !ranked.includes(p) && !OPTIONAL_PROVIDERS.has(p));
      return [...ranked, ...rest];
    };

    // Preserve the capability needed by already-running work before reserving a fresh
    // session for a role that is merely expected to become active later.
    for (const role of [...requiredRoles].sort((left, right) => Number(right.inFlight) - Number(left.inFlight))) {
      const preferred = candidatesFor(role.capability);
      const taken = usedByGroup.get(role.isolationGroup) ?? new Set<string>();

      const candidate =
        preferred.find((p) => usable(p, role.capability) !== null && !taken.has(p)) ??
        preferred.find((p) => usable(p, role.capability) !== null) ??
        null;

      if (!candidate) {
        uncovered.push(role.roleKey);
        assignments.push({ roleKey: role.roleKey, provider: null, reason: "no provider with capability and admission" });
        continue;
      }
      taken.add(candidate);
      usedByGroup.set(role.isolationGroup, taken);
      assignments.push({
        roleKey: role.roleKey,
        provider: candidate,
        reason: candidate === preferred[0] ? "preferred" : "fallback",
      });
    }

    const outcome: CoverageOutcome =
      uncovered.length === 0
        ? "FULL_COVERAGE"
        : uncovered.length < requiredRoles.length
          ? "PARTIAL_COVERAGE"
          : "NO_VALID_COVERAGE";

    const anyFallback = assignments.some((a) => a.reason === "fallback");
    const requiredProvidersDown = [...byProvider.values()].filter(
      (c) =>
        !OPTIONAL_PROVIDERS.has(c.provider) &&
        (c.allocationAdmission === "SUSPENDED" ||
          c.runtimeHealth === "UNAVAILABLE" ||
          c.runtimeHealth === "UNKNOWN"),
    );

    const activeFallback = requiredRoles.some((role) => this.bindings.active(role.roleKey)?.mode === "FALLBACK");
    const mode: ContinuityMode =
      outcome === "NO_VALID_COVERAGE"
        ? ContinuityMode.SURVIVAL
        : activeFallback || anyFallback || requiredProvidersDown.length > 0 || outcome === "PARTIAL_COVERAGE"
          ? ContinuityMode.DEGRADED
          : ContinuityMode.NORMAL;

    const action: CoverageAction =
      outcome === "NO_VALID_COVERAGE"
        ? "SURVIVAL"
        : outcome === "PARTIAL_COVERAGE"
          ? this.partialAction(byProvider)
          : anyFallback
            ? "FALLBACK_ROLE"
            : "FALLBACK_ROLE";

    return {
      outcome,
      action,
      mode,
      requiredRoles,
      assignments,
      uncovered,
      providers: [...byProvider.values()].map((c) => ({
        provider: c.provider,
        optional: OPTIONAL_PROVIDERS.has(c.provider),
        admission: c.allocationAdmission,
        runtimeHealth: c.runtimeHealth,
        advisoryState: c.advisoryState,
      })),
      computedAt: this.clock.nowIso(),
    };
  }

  /**
   * Refresh capacity, recompute coverage, and move the continuity mode if it changed.
   * This is the only writer of `continuity_state`.
   */
  async evaluate(reason: string): Promise<RoleCoveragePlan> {
    await this.capacity.refresh(RefreshTrigger.CONTINUITY_EVALUATION);
    const plan = this.computeCoveragePlan();
    let previous: ContinuityMode = ContinuityMode.NORMAL;
    let transitioned = false;

    // `evaluated_at` is a claim about the mode in the same row. Commit both state facts
    // and the transition audit together, so a crash cannot leave a freshly evaluated
    // NORMAL beside an uncommitted SURVIVAL decision.
    this.db.tx(() => {
      previous = this.mode();
      transitioned = plan.mode !== previous;
      if (transitioned) {
        this.db.run(
          `UPDATE continuity_state
              SET mode = ?, reason_code = ?, changed_at = ?, evaluated_at = ?
            WHERE id = 1`,
          [plan.mode, plan.outcome, this.clock.nowIso(), this.clock.nowIso()],
        );
      } else {
        this.db.run(`UPDATE continuity_state SET evaluated_at = ? WHERE id = 1`, [this.clock.nowIso()]);
      }
      if (transitioned) {
      this.audit.record({
        kind: "CONTINUITY_ACTIVATED",
        reasonCode:
          plan.outcome === "FULL_COVERAGE"
            ? ReasonCode.COVERAGE_FULL
            : plan.outcome === "PARTIAL_COVERAGE"
              ? ReasonCode.COVERAGE_PARTIAL
              : ReasonCode.COVERAGE_NONE,
        evidence: {
          from: previous,
          to: plan.mode,
          reason,
          outcome: plan.outcome,
          action: plan.action,
          uncovered: plan.uncovered,
        },
      });
      }
    });

    if (transitioned) {
      this.telemetry.record({
        scope: "continuity",
        name: "mode_transition",
        text: `${previous}->${plan.mode}`,
        dims: { outcome: plan.outcome, action: plan.action, uncovered: plan.uncovered.length },
      });
    }

    this.telemetry.record({
      scope: "continuity",
      name: "coverage_plan",
      text: plan.outcome,
      dims: {
        action: plan.action,
        required: plan.requiredRoles.length,
        fallbacks: plan.assignments.filter((a) => a.reason === "fallback").length,
      },
    });

    return plan;
  }

  /**
   * §15.7 — fail a role over to a fresh session on the planned provider. Refused unless
   * the coverage plan actually staffed this role; the gate is never lowered to make a
   * failover succeed.
   */
  async failover(
    roleKey: string,
    role: Role,
    scope: { projectId?: string | null; runId?: string | null; taskId?: string | null },
    reason: string,
  ): Promise<Decision<{ provider: string; generation: number }>> {
    const plan = await this.evaluate(`failover:${roleKey}`);
    const assignment = plan.assignments.find((a) => a.roleKey === roleKey);
    const required = plan.requiredRoles.find((candidate) => candidate.roleKey === roleKey);
    if (!assignment?.provider || !required) {
      return deny(
        plan.outcome === "NO_VALID_COVERAGE" ? ReasonCode.COVERAGE_NONE : ReasonCode.COVERAGE_PARTIAL,
        "coverage plan cannot staff this role; not failing over",
        { roleKey, plan: { outcome: plan.outcome, action: plan.action, uncovered: plan.uncovered } },
      );
    }

    // `evaluate` supplied the coverage plan, but it is not an allocation lease. A provider
    // can become exhausted between that refresh and this fresh session, so the selected
    // replacement must take the dedicated provider-switch trigger and re-admit its exact
    // capability immediately before `startSession` (§14.2). Worker failover remains a
    // lower-priority allocation and therefore carries the same dynamic reserve as fan-out.
    const switchTarget: DispatchCapacityTarget =
      required.capability === "worker"
        ? {
            provider: assignment.provider,
            capabilities: [required.capability],
            priority: "worker",
            reserveDemand: this.capacity.workerReserveDemand(assignment.provider),
          }
        : {
            provider: assignment.provider,
            capabilities: [required.capability],
            priority: "critical",
          };
    const switchAdmission = await this.capacity.refreshForProviderSwitch(switchTarget);
    if (!switchAdmission.allowed) return switchAdmission as Decision<{ provider: string; generation: number }>;

    const expected = this.bindings.active(roleKey);
    const provisioned = await this.provisionRoutableSession(role, assignment.provider, `continuity:${role}`);
    if (!provisioned.allowed) return provisioned as Decision<{ provider: string; generation: number }>;

    // This catches a newer binding that arrived while session creation, route connection,
    // or readiness was awaited. BindingRegistry still performs the final generation check
    // transactionally (see the handoff for the required cross-owner parameter).
    const current = this.bindings.active(roleKey);
    if (
      current?.assignmentId !== expected?.assignmentId ||
      current?.bindingGeneration !== expected?.bindingGeneration
    ) {
      await this.stopUnusedSession(provisioned.value.sessionId, "coverage plan superseded");
      return deny(ReasonCode.BINDING_GENERATION_STALE, "coverage plan was superseded by a newer binding", {
        roleKey,
        expectedGeneration: expected?.bindingGeneration ?? null,
        actualGeneration: current?.bindingGeneration ?? null,
      });
    }

    const outgoingRuntime = current ? this.sessions.get(current.sessionId) : null;
    const incomingRuntime = this.sessions.get(provisioned.value.sessionId);
    const sameProviderReplacement =
      outgoingRuntime !== null &&
      incomingRuntime !== null &&
      outgoingRuntime !== undefined &&
      incomingRuntime !== undefined &&
      outgoingRuntime.provider === incomingRuntime.provider;

    const switched = this.bindings.switchTo({
      roleKey,
      role,
      sessionId: provisioned.value.sessionId,
      projectId: scope.projectId ?? null,
      runId: scope.runId ?? null,
      taskId: scope.taskId ?? null,
      mode: assignment.reason === "preferred" ? "PREFERRED" : "FALLBACK",
      reason: `continuity failover: ${reason}`,
      // #493 — a conversation survives its runtime restarting, not its provider changing. What a
      // conversational actor accumulates cannot be carried to another provider, so a Claude
      // counterpart replaced by GPT is a different counterpart however similar its role; only a
      // same-provider replacement is the same actor continuing on a new runtime. The PRD
      // scenarios say this directly — P0-06 expects a GPT-bound CEO to be replaced by a
      // *fresh Claude generation*.
      conversation: sameProviderReplacement ? "SURVIVED" : "REPLACED",
      // The synchronous check above gives a useful early refusal, while this fence makes
      // the final revoke-and-rebind atomic with the generation that plan observed.
      expectedCurrentGeneration: expected?.bindingGeneration,
      // A failover of a role that still owns live work is a takeover: the runs move to the
      // new generation in the same transaction rather than being orphaned.
      takeover: true,
    });
    if (!switched.allowed) {
      await this.stopUnusedSession(provisioned.value.sessionId, "failover rejected");
      return switched as Decision<{ provider: string; generation: number }>;
    }

    this.telemetry.record({
      scope: "continuity",
      name: "fallback_role",
      text: roleKey,
      dims: { provider: assignment.provider, role, mode: assignment.reason },
    });

    return allow(ReasonCode.OK, {
      provider: assignment.provider,
      generation: switched.value.bindingGeneration,
    });
  }

  /**
   * §15.8 — restoration is additive. A recovered preferred provider takes new work; it
   * does not seize an in-flight run owner or a review already under way.
   */
  async restore(): Promise<{
    restored: string[];
    deferred: Array<{ roleKey: string; reasonCode: string }>;
  }> {
    const plan = await this.evaluate("provider restoration");
    const restored: string[] = [];
    const deferred: Array<{ roleKey: string; reasonCode: string }> = [];

    for (const assignment of plan.assignments) {
      if (!assignment.provider || assignment.reason !== "preferred") continue;
      const current = this.bindings.active(assignment.roleKey);
      if (!current || current.mode === "PREFERRED") continue;

      const session = this.sessions.get(current.sessionId);
      if (session && this.runs.activeRunsOwnedBy(current.sessionId).length > 0) {
        deferred.push({
          roleKey: assignment.roleKey,
          reasonCode: ReasonCode.RESTORE_WOULD_PREEMPT_INFLIGHT_OWNER,
        });
        continue;
      }
      if (current.role === Role.BLIND_REVIEWER) {
        // An in-flight review finishes with the reviewer that started it.
        deferred.push({
          roleKey: assignment.roleKey,
          reasonCode: ReasonCode.RESTORE_WOULD_PREEMPT_INFLIGHT_OWNER,
        });
        continue;
      }
      if (current.role === Role.CEO) {
        // The current owner decision has no run pin to inspect. Until the authority path
        // supplies an explicit finished-decision receipt, retaining the acting CEO is the
        // only non-preemptive reading of §15.8.
        deferred.push({
          roleKey: assignment.roleKey,
          reasonCode: ReasonCode.RESTORE_WOULD_PREEMPT_INFLIGHT_OWNER,
        });
        continue;
      }
      const provisioned = await this.provisionRoutableSession(current.role, assignment.provider, "continuity:restore");
      if (!provisioned.allowed) {
        deferred.push({ roleKey: assignment.roleKey, reasonCode: provisioned.reasonCode });
        continue;
      }
      const switched = this.bindings.switchTo({
        roleKey: assignment.roleKey,
        role: current.role,
        sessionId: provisioned.value.sessionId,
        projectId: current.projectId,
        runId: current.runId,
        taskId: current.taskId,
        mode: "PREFERRED",
        reason: "continuity restoration",
        // #493 — restoration moves a role back to its preferred provider, so by definition the
        // provider changes and the counterpart is a new one. Same rule as the failover path
        // above, and here it always resolves the same way.
        conversation:
          session && this.sessions.get(provisioned.value.sessionId)?.provider === session.provider
            ? "SURVIVED"
            : "REPLACED",
        // Session constitution awaited provider work. Fence the exact incumbent observed
        // before that await so restoration cannot displace a newer owner.
        expectedCurrentGeneration: current.bindingGeneration,
      });
      if (!switched.allowed) {
        await this.stopUnusedSession(provisioned.value.sessionId, "restoration rejected");
        deferred.push({ roleKey: assignment.roleKey, reasonCode: switched.reasonCode });
        continue;
      }
      const active = this.bindings.active(assignment.roleKey);
      if (active?.sessionId !== provisioned.value.sessionId || active.mode !== "PREFERRED") {
        deferred.push({ roleKey: assignment.roleKey, reasonCode: ReasonCode.SESSION_NOT_READY });
        continue;
      }
      restored.push(assignment.roleKey);
    }

    this.audit.record({
      kind: "CONTINUITY_RESTORE",
      evidence: { restored, deferred, mode: plan.mode },
    });
    // A recovered provider does not make the system NORMAL until every fallback binding
    // is actually gone (or remains visible as DEGRADED because restoration was deferred).
    await this.evaluate("post-restoration coverage");
    return { restored, deferred };
  }

  /** §15.6 — SURVIVAL: state is preserved, diagnostics run, completion is forbidden. */
  assertCompletionAllowed(runId: string, maxAgeMs = 5 * 60 * 1000): Decision<void> {
    if (this.mode() === ContinuityMode.SURVIVAL) {
      return deny(
        ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
        "production-ready completion is not permitted in SURVIVAL",
        { runId },
      );
    }
    // §15.6 — a NORMAL that was computed before both providers failed is not evidence of
    // anything. Completion requires a *current* evaluation, so the caller must refresh.
    const ageMs = this.modeAgeMs();
    if (ageMs > maxAgeMs) {
      return deny(
        ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
        "continuity mode is stale; re-evaluate coverage before completing",
        { runId, ageMs, maxAgeMs },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  private requiredRoles(): RequiredRole[] {
    const roles: RequiredRole[] = [
      {
        roleKey: roleKeyFor(Role.CEO),
        role: Role.CEO,
        capability: "ceo",
        projectId: null,
        runId: null,
        taskId: null,
        isolationGroup: "global",
        inFlight: true,
      },
    ];

    for (const project of this.projects.list()) {
      if (project.suspended) continue;
      const hasWork = this.runs
        .list({ projectId: project.projectId })
        .some((r) =>
          r.state !== RunState.COMPLETED &&
          r.state !== RunState.BLOCKED_POST_MERGE &&
          r.state !== RunState.FAILED &&
          r.state !== RunState.CANCELLED,
        );
      if (project.activity !== "ACTIVE" && !hasWork) continue;
      roles.push({
        roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: project.projectId }),
        role: Role.PRIMARY_CTO,
        capability: "cto",
        projectId: project.projectId,
        runId: null,
        taskId: null,
        isolationGroup: `project:${project.projectId}`,
        inFlight: hasWork,
      });
    }

    // A run that will need a verdict needs a reviewer that is isolated from its CTO.
    for (const run of this.runs.list()) {
      if (run.state !== RunState.ACTIVE && run.state !== RunState.READY_FOR_CEO_REVIEW) continue;
      roles.push({
        roleKey: roleKeyFor(Role.BLIND_REVIEWER, { runId: run.runId }),
        role: Role.BLIND_REVIEWER,
        capability: "blind-review",
        projectId: run.projectId,
        runId: run.runId,
        taskId: null,
        isolationGroup: run.projectId ? `project:${run.projectId}` : `run:${run.runId}`,
        inFlight: true,
      });
    }

    // Task executions record the worker session and task scope independently of their
    // parent run owner. Every open execution is therefore a required continuity role.
    for (const execution of this.db.all<{ run_id: string; task_id: string; project_id: string | null }>(
      `SELECT e.run_id, e.task_id, r.project_id
         FROM task_executions e JOIN runs r ON r.run_id = e.run_id
        WHERE e.status = 'RUNNING'`,
    )) {
      roles.push({
        roleKey: roleKeyFor(Role.WORKER, { taskId: execution.task_id }),
        role: Role.WORKER,
        capability: "worker",
        projectId: execution.project_id,
        runId: execution.run_id,
        taskId: execution.task_id,
        isolationGroup: `task:${execution.task_id}`,
        inFlight: true,
      });
    }

    return roles;
  }

  /** Constitute a real, routable provider session before it is allowed to own a role. */
  private async provisionRoutableSession(
    role: Role,
    provider: string,
    purpose: string,
  ): Promise<Decision<{ sessionId: string }>> {
    const adapter = this.providers.require(provider);
    if (!adapter.isProduction) {
      return deny(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE, "non-production adapter cannot provide continuity", {
        provider,
      });
    }
    const buzz = this.#buzz;
    const readiness = this.#readiness;
    if (!buzz || !readiness) {
      return deny(
        ReasonCode.SESSION_NOT_READY,
        "a failover requires both a logical route and an independent readiness probe",
        { provider, hasBuzz: Boolean(buzz), hasReadiness: Boolean(readiness) },
      );
    }
    const model = adapter.defaultModels[
      role === Role.BLIND_REVIEWER ? "reviewer" : role === Role.CEO ? "ceo" : role === Role.WORKER ? "worker" : "cto"
    ] ?? "default";
    let handle;
    try {
      handle = await adapter.startSession({
        model,
        effort: role === Role.BLIND_REVIEWER ? "xhigh" : null,
        workdir: this.managedRuntimeRoot,
        purpose,
      });
    } catch (err) {
      await this.capacity.refresh(RefreshTrigger.PROVIDER_SWITCH_OR_FAILURE, [provider]);
      return deny(ReasonCode.SESSION_NOT_READY, "provider refused to create a session", {
        provider,
        error: (err as Error).message,
      });
    }
    const session = this.sessions.create({
      provider: adapter.provider,
      model,
      effort: role === Role.BLIND_REVIEWER ? "xhigh" : null,
      sessionId: `ses_cont_${handle.externalSessionId.replace(/-/g, "").slice(0, 18)}`,
      incarnation: `${handle.externalSessionId}#${this.clock.nowIso()}`,
      osPid: handle.pid,
      // Same containment rule as CtoLifecycle: an adapter's reported workdir is persisted
      // only when it is inside the managed root, because the immutability trigger makes it
      // permanent.
      workdir: handle.workdir && (handle.workdir === this.managedRuntimeRoot
        || isWithin(this.managedRuntimeRoot, handle.workdir))
        ? handle.workdir
        : this.managedRuntimeRoot,
    });
    const connected = await buzz.connect(session.sessionId, purpose);
    if (!connected.allowed) {
      this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "buzz connect failed");
      return connected as Decision<{ sessionId: string }>;
    }
    this.sessions.setBuzzAddress(session.sessionId, connected.value);
    let runtime: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
    try {
      runtime = await adapter.probeSession(handle);
    } catch (err) {
      await this.capacity.refresh(RefreshTrigger.PROVIDER_SWITCH_OR_FAILURE, [provider]);
      this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "provider session probe threw");
      return deny(ReasonCode.SESSION_NOT_READY, "provider session probe did not complete", {
        provider,
        error: (err as Error).message,
        sessionId: session.sessionId,
      });
    }
    if (runtime !== "HEALTHY") {
      await this.capacity.refresh(RefreshTrigger.PROVIDER_SWITCH_OR_FAILURE, [provider]);
      this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "provider session probe failed");
      return deny(ReasonCode.SESSION_NOT_READY, "provider cannot prove the constituted session is ready", {
        provider,
        runtime,
        sessionId: session.sessionId,
      });
    }
    this.sessions.transition(session.sessionId, SessionLifecycle.READY, "provider session and route verified");
    const checked = await readiness.checkSession(session.sessionId);
    if (!checked.allowed) {
      this.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "readiness failed");
      return checked as Decision<{ sessionId: string }>;
    }
    return allow(ReasonCode.OK, { sessionId: session.sessionId });
  }

  /** A continuity session that lost its commit race must not remain live at the provider. */
  private async stopUnusedSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.lifecycle === SessionLifecycle.STOPPED) return;
    try {
      await this.providers.require(session.provider).stopSession(handleFor(session));
      this.sessions.transition(sessionId, SessionLifecycle.STOPPED, reason);
    } catch (error) {
      if (session.lifecycle !== SessionLifecycle.ERROR) {
        this.sessions.transition(sessionId, SessionLifecycle.ERROR, `${reason}: provider stop failed`);
      }
      this.audit.record({
        kind: "CONTINUITY_UNUSED_SESSION_STOP_FAILED",
        reasonCode: ReasonCode.SESSION_STOP_FAILED,
        sessionId,
        evidence: { reason, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private partialAction(byProvider: Map<string, ProviderCapacity>): CoverageAction {
    const resets = [...byProvider.values()]
      .flatMap((c) => c.buckets.map((b) => b.resetAt))
      .filter((r): r is string => Boolean(r));
    if (resets.length > 0) {
      const soonest = resets.map((r) => new Date(r).getTime()).sort((a, b) => a - b)[0]!;
      const withinTwoHours = soonest - new Date(this.clock.nowIso()).getTime() < 2 * 60 * 60 * 1000;
      if (withinTwoHours) return "WAIT_FOR_RESET";
    }
    return "PAUSE_NEW_WORK";
  }
}

const handleFor = (session: SessionRecord): SessionHandle => ({
  externalSessionId: session.incarnation.split("#")[0] ?? session.sessionId,
  provider: session.provider,
  model: session.model,
  effort: session.effort,
  pid: session.osPid,
  ...(session.workdir ? { workdir: session.workdir } : {}),
});
