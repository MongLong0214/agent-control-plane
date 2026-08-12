import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type ProviderCapacity, type CapacityMonitor, RefreshTrigger } from "../capacity/capacity-monitor.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ContinuityMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { ProviderRegistry } from "../runtime/provider.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
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
  ) {}

  mode(): ContinuityMode {
    const row = this.db.get<{ mode: ContinuityMode }>(`SELECT mode FROM continuity_state WHERE id = 1`);
    return row?.mode ?? ContinuityMode.NORMAL;
  }

  /** §15.3 — computed before any failover, never after. */
  computeCoveragePlan(): RoleCoveragePlan {
    const requiredRoles = this.requiredRoles();
    const capacities = this.capacity.all();
    const byProvider = new Map(capacities.map((c) => [c.provider, c]));

    const usable = (provider: string): ProviderCapacity | null => {
      const capacity = byProvider.get(provider);
      if (!capacity) return null;
      if (capacity.allocationAdmission === "SUSPENDED") return null;
      if (capacity.runtimeHealth === "UNAVAILABLE") return null;
      return capacity;
    };

    const assignments: RoleCoveragePlan["assignments"] = [];
    const uncovered: string[] = [];
    // Isolation groups must land on different providers where possible, so a single
    // provider outage cannot take a producer and its reviewer at once.
    const usedByGroup = new Map<string, Set<string>>();

    for (const role of requiredRoles) {
      const preferred = PREFERENCE[role.capability] ?? [];
      const taken = usedByGroup.get(role.isolationGroup) ?? new Set<string>();

      const candidate =
        preferred.find((p) => {
          const capacity = usable(p);
          return (
            capacity !== null &&
            capacity.buckets.some((b) => b.capabilities.includes(role.capability)) &&
            !taken.has(p)
          );
        }) ??
        preferred.find((p) => {
          const capacity = usable(p);
          return capacity !== null && capacity.buckets.some((b) => b.capabilities.includes(role.capability));
        }) ??
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
        (c.allocationAdmission === "SUSPENDED" || c.runtimeHealth === "UNAVAILABLE"),
    );

    const mode: ContinuityMode =
      outcome === "NO_VALID_COVERAGE"
        ? ContinuityMode.SURVIVAL
        : anyFallback || requiredProvidersDown.length > 0 || outcome === "PARTIAL_COVERAGE"
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
    const previous = this.mode();

    if (plan.mode !== previous) {
      this.db.run(`UPDATE continuity_state SET mode = ?, reason_code = ?, changed_at = ? WHERE id = 1`, [
        plan.mode,
        plan.outcome,
        this.clock.nowIso(),
      ]);
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
    scope: { projectId?: string | null; runId?: string | null },
    reason: string,
  ): Promise<Decision<{ provider: string; generation: number }>> {
    const plan = await this.evaluate(`failover:${roleKey}`);
    const assignment = plan.assignments.find((a) => a.roleKey === roleKey);
    if (!assignment?.provider) {
      return deny(
        plan.outcome === "NO_VALID_COVERAGE" ? ReasonCode.COVERAGE_NONE : ReasonCode.COVERAGE_PARTIAL,
        "coverage plan cannot staff this role; not failing over",
        { roleKey, plan: { outcome: plan.outcome, action: plan.action, uncovered: plan.uncovered } },
      );
    }

    const adapter = this.providers.require(assignment.provider);
    const model = adapter.defaultModels[role === Role.BLIND_REVIEWER ? "reviewer" : role === Role.CEO ? "ceo" : "cto"] ?? "default";
    const handle = await adapter.startSession({
      model,
      effort: role === Role.BLIND_REVIEWER ? "xhigh" : null,
      workdir: process.cwd(),
      purpose: `continuity:${role}`,
    });
    const session = this.sessions.create({
      provider: adapter.provider,
      model,
      effort: role === Role.BLIND_REVIEWER ? "xhigh" : null,
      sessionId: `ses_cont_${handle.externalSessionId.replace(/-/g, "").slice(0, 18)}`,
      incarnation: `${handle.externalSessionId}#${this.clock.nowIso()}`,
    });
    this.sessions.transition(session.sessionId, SessionLifecycle.READY, "continuity failover");

    const switched = this.bindings.switchTo({
      roleKey,
      role,
      sessionId: session.sessionId,
      projectId: scope.projectId ?? null,
      runId: scope.runId ?? null,
      mode: assignment.reason === "preferred" ? "PREFERRED" : "FALLBACK",
      reason: `continuity failover: ${reason}`,
      // A failover of a role that still owns live work is a takeover: the runs move to the
      // new generation in the same transaction rather than being orphaned.
      takeover: true,
    });
    if (!switched.allowed) {
      this.sessions.transition(session.sessionId, SessionLifecycle.STOPPED, "failover rejected");
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
      restored.push(assignment.roleKey);
    }

    this.audit.record({
      kind: "CONTINUITY_RESTORE",
      evidence: { restored, deferred, mode: plan.mode },
    });
    return { restored, deferred };
  }

  /** §15.6 — SURVIVAL: state is preserved, diagnostics run, completion is forbidden. */
  assertCompletionAllowed(runId: string): Decision<void> {
    if (this.mode() === ContinuityMode.SURVIVAL) {
      return deny(
        ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
        "production-ready completion is not permitted in SURVIVAL",
        { runId },
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
        isolationGroup: "global",
        inFlight: true,
      },
    ];

    for (const project of this.projects.list()) {
      if (project.suspended) continue;
      const hasWork = this.runs
        .list({ projectId: project.projectId })
        .some((r) => r.state !== RunState.COMPLETED && r.state !== RunState.FAILED && r.state !== RunState.CANCELLED);
      if (project.activity !== "ACTIVE" && !hasWork) continue;
      roles.push({
        roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: project.projectId }),
        role: Role.PRIMARY_CTO,
        capability: "cto",
        projectId: project.projectId,
        runId: null,
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
        isolationGroup: run.projectId ? `project:${run.projectId}` : `run:${run.runId}`,
        inFlight: true,
      });
    }

    return roles;
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
