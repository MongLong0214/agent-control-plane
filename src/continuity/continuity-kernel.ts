import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { isWithin } from "../guard/workspace-probe.ts";
import {
  type DispatchCapacityTarget,
  type ProviderCapacity,
  type RoleProviderCapacity,
  type CapacityMonitor,
  RefreshTrigger,
} from "../capacity/capacity-monitor.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
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
  /**
   * The subset of `uncovered` where no candidate provider had a reading at all.
   *
   * Separate from `uncovered` because they are opposite claims wearing one word. "No provider can
   * staff this" is a fact about the deployment; "nothing has measured any candidate" is a fact
   * about the reader, and reporting the second as the first is how a cold process talks itself
   * into a verdict. A consumer that blocks on missing coverage must check this first.
   */
  unmeasured: string[];
  /**
   * Required roles continuity revoked for want of coverage and nobody holds yet (#954).
   *
   * A third thing `uncovered` cannot say. "No provider can staff this role" and "a provider can
   * staff it and the role is empty" are different states, and the second one had no field, no
   * status and no reader: continuity revoked a binding because the plan could not staff it, the
   * plan could staff it again 2m29s later, and coverage reported itself whole with the role still
   * unbound five days on. `outcome` is therefore never `FULL_COVERAGE` while this list is
   * non-empty — coverage is not whole when one of its roles is empty — and `restore()` reads it to
   * find what it owes.
   *
   * Deliberately not folded into `uncovered`: the doctor blocks a cold daemon on
   * `NO_VALID_COVERAGE` and scores `unmeasured` against `uncovered`, so a role that *can* be
   * staffed must not arrive there wearing the word for one that cannot.
   */
  restorationPending: string[];
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

/**
 * The revocation reasons continuity writes when it could not put a provider behind a bound role
 * (`Daemon.reconcileContinuity`, through `revokePausedBinding`).
 *
 * Declared here because this module reads them back: `assignments.revoked_reason` is the only
 * durable thing that tells a revocation continuity performed from an operator release, and the
 * difference decides whether the role is still owed a binding. The literal text is load-bearing —
 * every past revocation on a live deployment already carries it in `assignments` and in
 * `BINDING_REVOKED` — so it is shared between the writer and this reader rather than spelled twice.
 */
export const CONTINUITY_COVERAGE_REVOCATION_REASON = "coverage plan cannot staff the bound role";

/** A planned failover that returned without leaving the ready binding it promised. */
export const CONTINUITY_INCOMPLETE_FAILOVER_REVOCATION_REASON =
  "continuity failover did not leave a ready planned binding";

/** The prefix of the third such reason, whose tail is the refused failover's reason code. */
export const CONTINUITY_FAILOVER_REFUSED_REASON_PREFIX = "continuity failover refused: ";

/** The exact reasons above, for the reader that has a `revoked_reason` and needs its origin. */
export const CONTINUITY_REVOCATION_REASONS: readonly string[] = [
  CONTINUITY_COVERAGE_REVOCATION_REASON,
  CONTINUITY_INCOMPLETE_FAILOVER_REVOCATION_REASON,
];

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

  /**
   * Measure every required role against the providers that answer per role, so that a later
   * `computeCoveragePlan` scores what was measured rather than what nothing measured yet.
   *
   * This is separate from `capacity.refresh` and cannot be folded into it. A provider with
   * role-scoped adapters is deliberately skipped there — a provider-global row cannot carry role
   * provenance (#917) — and the role readings it would need live in a volatile snapshot keyed by
   * the registration itself, which no restart inherits. So *every* caller that is about to read a
   * coverage plan has to take this measurement first, and until this method existed only
   * `evaluate` did.
   *
   * The caller that did not was the doctor, which is the one that runs first: a cold daemon's
   * startup doctor scored coverage off an empty snapshot, found every role uncovered, and parked
   * on a CRITICAL finding — after which the park uninstalls the continuity coordinator, so the
   * only thing that would have taken the measurement no longer runs. Measured 2026-09-16: the
   * daemon parked at 00:52:48Z and two further doctor passes reported the same thing.
   */
  async refreshRoleScopedCapacity(): Promise<RoleProviderCapacity[]> {
    const required = this.requiredRoles();
    const taken: RoleProviderCapacity[] = [];
    for (const provider of this.coverageProviders(required)) {
      if (!this.providers.hasRoleScoped(provider)) continue;
      for (const role of new Set(required.map((entry) => entry.role))) {
        const measured = await this.capacity.refreshForRole(provider, role);
        taken.push(measured);
        // Recorded here rather than inside `refreshForRole`, which is deliberately pure with respect
        // to db, audit and telemetry — `role-bound-capacity.test.ts` hands that slice a proxy that
        // throws on any of the three, so role facts cannot reach provider-global storage. This is
        // the caller that decides coverage from the reading, so this is where the reading becomes
        // explainable.
        //
        // It had been explainable nowhere. `refresh` audits every provider probe; this path audited
        // nothing and writes to a volatile map rather than `capacity_snapshots`, so a role reading
        // existed only inside the process that took it. Measured on the live deployment 2026-09-16:
        // the generation carrying #917 started at 02:05:09Z and three hours later there were zero
        // audit events mentioning `claude` — 140 `CAPACITY_PROBE` rows, all `gpt` — while this loop
        // had been consulting `claude`'s role reading every four minutes and had moved the
        // deployment into SURVIVAL at 03:25:33.928Z. Nothing on disk could say why.
        this.audit.record({
          kind: "CAPACITY_ROLE_PROBE",
          reasonCode: measured.sensorHealth === "ERROR" ? ReasonCode.PROBE_FAILED : ReasonCode.OK,
          evidence: {
            provider,
            role,
            bindingGeneration: measured.binding.generation,
            sensorHealth: measured.sensorHealth,
            runtimeHealth: measured.runtimeHealth,
            allocationAdmission: measured.allocationAdmission,
            advisoryState: measured.advisoryState,
            // The shape of the reading without the reason for it is half an explanation, and the
            // half that cannot name a broken pin. On the live deployment `claude` is role-scoped,
            // so `CapacityMonitor.refresh` excludes it even when a caller names it explicitly and
            // its `CAPACITY_PROBE` sibling — the only other row carrying a collector's sentence —
            // is never written for it. This event is the whole durable record of a role probe, and
            // the role snapshot it mirrors dies with the process. `error` is an allowlisted audit
            // key, matching the provider-global sibling, so a full collector sentence survives
            // `redact` rather than being refused as an unknown free-form field.
            error: measured.error ?? null,
            buckets: measured.buckets.map((bucket) => ({
              id: bucket.id,
              remainingPercent: bucket.remainingPercent,
              resetAt: bucket.resetAt,
            })),
          },
        });
      }
    }
    // Returned rather than discarded, because these are the only readings anything takes for such
    // a provider: `capacity.refresh` skips it and nothing writes its provider-global row, so a
    // caller that reports on capacity has no other way to see it. Measured 2026-09-16 — the
    // doctor's `CAPACITY_LOW` findings went from two to one the moment this deployment's `claude`
    // became role-scoped, and the one that disappeared was the provider actually running out.
    return taken;
  }

  /** §15.3 — computed before any failover, never after. */
  computeCoveragePlan(): RoleCoveragePlan {
    const requiredRoles = this.requiredRoles();
    const productionProviders = this.coverageProviders(requiredRoles);
    const byProvider = new Map<string, ProviderCapacity>();
    for (const provider of productionProviders) {
      if (this.providers.hasRoleScoped(provider)) {
        for (const role of new Set(requiredRoles.map((required) => required.role))) {
          // Diagnostic UNKNOWN remains UNKNOWN. It is never relabelled as role evidence.
          const capacity = this.capacity.currentForRole(provider, role) ?? this.capacity.current(provider);
          if (capacity) byProvider.set(`${provider}:${role}`, capacity);
        }
      } else {
        const capacity = this.capacity.current(provider);
        if (capacity) byProvider.set(provider, capacity);
      }
    }

    /** `"UNMEASURED"` is "nothing read this", `null` is "read it and it is not routable". */
    const usable = (provider: string, required: RequiredRole): ProviderCapacity | "UNMEASURED" | null => {
      const capacity = this.providers.hasRoleScoped(provider)
        ? this.capacity.currentForRole(provider, required.role)
        : byProvider.get(provider);
      // Absent is not refused. `null` here means nothing has measured this provider for this role
      // at all — no reading, not an unroutable one — and the two produce the same `uncovered`
      // entry while meaning opposite things. The caller separates them; see `unmeasured`.
      if (!capacity) return "UNMEASURED";
      // currentForRole checks the current registration identity, not another role's quota.
      return this.capacity.isRoutableFor(capacity, required.capability) ? capacity : null;
    };

    const assignments: RoleCoveragePlan["assignments"] = [];
    const uncovered: string[] = [];
    /**
     * Roles no candidate provider had any reading for.
     *
     * `uncovered` answers "can this role be staffed", and on a process where nothing has measured
     * yet the honest answer is not "no" — it is "ask again after something measures". Those were
     * the same value, so a cold reader reported `NO_VALID_COVERAGE` as a fact about the deployment
     * when it was a fact about itself. Measured 2026-09-16: a startup doctor did exactly that and
     * parked the daemon on a CRITICAL finding no reachable command could clear.
     */
    const unmeasured: string[] = [];
    // Isolation groups must land on different providers where possible, so a single
    // provider outage cannot take a producer and its reviewer at once.
    const usedByGroup = new Map<string, Set<string>>();

    // The §15.1 order first, then any other registered provider that can serve the
    // capability. Coverage must reflect the providers this deployment actually has, not a
    // hardcoded roster: an unlisted provider is a fallback, not an absence of coverage.
    const registered = [...productionProviders];
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

      const routable = (provider: string): boolean => {
        const answer = usable(provider, role);
        return answer !== null && answer !== "UNMEASURED";
      };
      const candidate =
        preferred.find((p) => routable(p) && !taken.has(p)) ??
        preferred.find((p) => routable(p)) ??
        null;

      if (!candidate) {
        uncovered.push(role.roleKey);
        // Every candidate came back `UNMEASURED`, so nothing was read and nothing was refused.
        if (preferred.length > 0 && preferred.every((p) => usable(p, role) === "UNMEASURED")) {
          unmeasured.push(role.roleKey);
        }
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

    // #954 — the roles this plan can staff that nobody holds. `bindings.active` is the only
    // authority for who holds a role now; `assignments` is where the revocation stayed visible
    // after the binding went.
    const restorationPending = requiredRoles
      .filter((role) => this.bindings.active(role.roleKey) === null && this.continuityOwesBinding(role.roleKey))
      .map((role) => role.roleKey);

    const staffable: CoverageOutcome =
      uncovered.length === 0
        ? "FULL_COVERAGE"
        : uncovered.length < requiredRoles.length
          ? "PARTIAL_COVERAGE"
          : "NO_VALID_COVERAGE";
    // Coverage is not whole while one of its roles is empty, and this is the only place that can
    // say so: every consumer downstream reads this one word. `staffable` keeps the question this
    // module was built to answer — can these roles be staffed at all — because callers pin that
    // meaning; the answer that cannot be wrong in this direction is composed from it here rather
    // than by widening `uncovered`, which decides the doctor's blocking finding.
    const outcome: CoverageOutcome =
      staffable === "FULL_COVERAGE" && restorationPending.length > 0 ? "PARTIAL_COVERAGE" : staffable;

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
      staffable === "NO_VALID_COVERAGE"
        ? "SURVIVAL"
        : staffable === "PARTIAL_COVERAGE"
          ? this.partialAction(byProvider)
          // Read from `staffable`, not from the composed `outcome`: nothing can be given to a role
          // nobody holds, and no quota reset will change that, so `partialAction` would have
          // offered WAIT_FOR_RESET — a wait on the wrong thing — whenever a window happened to
          // reset within two hours.
          : restorationPending.length > 0
            ? "PAUSE_NEW_WORK"
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
      unmeasured,
      restorationPending,
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
    await this.refreshRoleScopedCapacity();
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
          restorationPending: plan.restorationPending,
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
      this.sessions.transition(provisioned.value.sessionId, SessionLifecycle.STOPPED, "coverage plan superseded");
      return deny(ReasonCode.BINDING_GENERATION_STALE, "coverage plan was superseded by a newer binding", {
        roleKey,
        expectedGeneration: expected?.bindingGeneration ?? null,
        actualGeneration: current?.bindingGeneration ?? null,
      });
    }

    const switched = this.bindings.switchTo({
      roleKey,
      role,
      sessionId: provisioned.value.sessionId,
      projectId: scope.projectId ?? null,
      runId: scope.runId ?? null,
      taskId: scope.taskId ?? null,
      mode: assignment.reason === "preferred" ? "PREFERRED" : "FALLBACK",
      reason: `continuity failover: ${reason}`,
      // The registry revalidates the active actor, target binding, and attestation tuple at its
      // write boundary. Provider identity neither substitutes for that proof nor defeats it.
      conversation: "SURVIVED",
      requireCurrentTargetAttestation: true,
      expectedCurrentGeneration: expected?.bindingGeneration,
      // A failover of a role that still owns live work is a takeover: the runs move to the
      // new generation in the same transaction rather than being orphaned.
      takeover: true,
    });
    if (!switched.allowed) {
      this.sessions.transition(provisioned.value.sessionId, SessionLifecycle.STOPPED, "failover rejected");
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
    /** Pending needs this pass had already recorded; see the audit note at the end of the loop. */
    let alreadyRecorded = 0;

    for (const assignment of plan.assignments) {
      const current = this.bindings.active(assignment.roleKey);
      if (!current) {
        // #954 — the role is empty because continuity revoked it when no provider could staff it,
        // and the plan can staff it again now. Restoration records what is owed and stops here.
        //
        // It stops because this is not continuity's binding to create. The canonical PRIMARY_CTO
        // conversation is adopted in place by a claim on the self-claim socket
        // (`src/registry/canonical-self-claim.ts`, admitted by `startCanonicalSelfClaimListener`),
        // which derives who is asking from process ancestry and an entitlement this module cannot
        // check and must not stand in for; the CEO's generation 1 comes only from the once-ever
        // possession-proven bootstrap. Writing a fresh assignment row here would hand out by
        // recovery what the design requires a claim for — and `switchTo` would write one: with no
        // active binding the target attestation cannot match, a surviving switch is downgraded to
        // REPLACED, and the mint path runs. `Daemon.reconcileContinuity` refuses the same thing at
        // its own loop for the same reason.
        //
        // A role the plan cannot staff is left to `uncovered`, which already says that.
        if (!assignment.provider || !plan.restorationPending.includes(assignment.roleKey)) continue;
        deferred.push({ roleKey: assignment.roleKey, reasonCode: ReasonCode.BINDING_REVOKED });
        if (!this.recordRestorationAwaitsClaim(assignment.roleKey, assignment.provider)) alreadyRecorded += 1;
        continue;
      }
      if (!assignment.provider || assignment.reason !== "preferred") continue;
      if (current.mode === "PREFERRED") continue;

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
        // Restoration asks for the same write-boundary proof as failover; a provider is not
        // evidence of continuity in either direction.
        conversation: "SURVIVED",
        requireCurrentTargetAttestation: true,
        expectedCurrentGeneration: current.bindingGeneration,
      });
      if (!switched.allowed) {
        this.sessions.transition(provisioned.value.sessionId, SessionLifecycle.STOPPED, "restoration rejected");
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

    // The reconcile loop asks for restoration on every tick — once a minute on a live daemon — and
    // a role waiting on a claim answers the same way every time. A pass whose entire content is a
    // need already recorded for this revocation therefore writes nothing: the ledger keeps the one
    // `CONTINUITY_RESTORE_AWAITS_CLAIM` row that says what is owed, and the daemon's own
    // `CONTINUITY_RECONCILED` row still carries `deferred` on every pass regardless.
    if (restored.length > 0 || deferred.length > alreadyRecorded) {
      this.audit.record({
        kind: "CONTINUITY_RESTORE",
        evidence: { restored, deferred, mode: plan.mode },
      });
    }
    // A recovered provider does not make the system NORMAL until every fallback binding
    // is actually gone (or remains visible as DEGRADED because restoration was deferred).
    await this.evaluate("post-restoration coverage");
    return { restored, deferred };
  }

  /**
   * Whether this role's pending need is already on the ledger for the revocation it is waiting on.
   *
   * Keyed on `event_id >` the role's newest `BINDING_REVOKED`, which is what makes the answer
   * survive a restart and what re-arms it: a *later* revocation of the same role has no record yet,
   * so it is answered afresh.
   *
   * Public because the reconcile loop asks the same question before it asks for a restoration pass.
   * A pending role whose need is recorded has nothing left for `restore()` to do, and reaching that
   * same stop again costs two coverage evaluations — a full provider probe round each — every tick.
   * The daemon reconciles once a minute and the measured role waited five days, so re-deriving it is
   * a standing load, not a rounding error. One reader, two callers: a second query with this
   * meaning could drift from the record it is supposed to be about.
   */
  restorationNeedRecorded(roleKey: string): boolean {
    return this.db.get<{ one: number }>(
      `SELECT 1 AS one FROM audit_events
        WHERE kind = 'CONTINUITY_RESTORE_AWAITS_CLAIM' AND role_key = ?
          AND event_id > COALESCE(
                (SELECT MAX(revoked.event_id) FROM audit_events revoked
                  WHERE revoked.kind = 'BINDING_REVOKED' AND revoked.role_key = ?), 0)
        LIMIT 1`,
      [roleKey, roleKey],
    ) !== undefined;
  }

  /**
   * Record, once per revocation, that a role the plan can now staff is waiting on a claim.
   * Answers whether it wrote the row.
   */
  private recordRestorationAwaitsClaim(roleKey: string, provider: string): boolean {
    if (this.restorationNeedRecorded(roleKey)) return false;
    this.audit.record({
      kind: "CONTINUITY_RESTORE_AWAITS_CLAIM",
      roleKey,
      reasonCode: ReasonCode.BINDING_REVOKED,
      evidence: {
        provider,
        reason: "the coverage plan can staff this role again; the binding it lost is created by a claim, not by restoration",
      },
    });
    return true;
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


  private coverageProviders(requiredRoles: readonly RequiredRole[]): Set<string> {
    const shared = new Set(this.providers.production().map((adapter) => adapter.provider));
    // production() enumerates shared adapters only. Preserve preferred scoped routes and
    // every live binding/execution provider without pretending the shared list is complete.
    const candidates = new Set([...shared, ...Object.values(PREFERENCE).flat()]);
    for (const required of requiredRoles) {
      const binding = this.bindings.active(required.roleKey);
      const session = binding && this.sessions.get(binding.sessionId);
      if (session) candidates.add(session.provider);
    }
    for (const execution of this.db.all<{ provider: string }>(
      `SELECT DISTINCT provider FROM task_executions WHERE status = 'RUNNING'`,
    )) candidates.add(execution.provider);
    return new Set([...candidates].filter((provider) => shared.has(provider) || requiredRoles.some(
      (required) => this.providers.capacityBindingForRole(provider, required.role)?.adapter.isProduction,
    )));
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

    // Bound critical actors remain requirements even before dispatch or while a project
    // is inactive. Optional adversarial review is not promoted to a critical dependency;
    // WORKER demand remains the RUNNING execution roster above, never all old bindings.
    for (const row of this.db.all<{ role_key: string }>(
      `SELECT role_key FROM assignments WHERE status = 'ACTIVE'
         AND role IN ('CEO', 'BOOTSTRAP_CTO', 'PRIMARY_CTO', 'BLIND_REVIEWER')`,
    )) {
      const binding = this.bindings.active(row.role_key);
      if (!binding || roles.some((required) => required.roleKey === binding.roleKey)) continue;
      roles.push({
        roleKey: binding.roleKey,
        role: binding.role,
        capability: binding.role === Role.CEO ? "ceo" : binding.role === Role.BLIND_REVIEWER ? "blind-review" : "cto",
        projectId: binding.projectId,
        runId: binding.runId,
        taskId: binding.taskId,
        isolationGroup: binding.projectId ? `project:${binding.projectId}` : binding.runId ? `run:${binding.runId}` : "global",
        inFlight: true,
      });
    }
    // #954 — a role continuity revoked for want of coverage stays a requirement until something
    // binds it again. Two of the roles above have no other witness once the binding is gone:
    // `ProjectRegistry` derives `activity` as "(bound PRIMARY_CTO count) > 0 ? ACTIVE : INACTIVE",
    // so revoking the CTO of a project with no open run erases the only evidence that the project
    // wanted one, and a BOOTSTRAP_CTO reaches this list only through the ACTIVE-assignment sweep
    // above. Measured: the role left the plan on the same tick that revoked it, after which
    // coverage reported itself whole over a role it had stopped counting.
    //
    // BLIND_REVIEWER and WORKER need nothing from this loop — their requirement comes from the
    // open-run and RUNNING-execution rosters, which a revocation does not touch — and the CEO is
    // unconditional at the top. Every entry is still admitted on the same liveness its own loop
    // uses (`scopeStillOpen`), so a role whose scope closed while it was unbound stays out.
    for (const owed of this.continuityOwedBindings()) {
      if (roles.some((required) => required.roleKey === owed.roleKey)) continue;
      if (!this.scopeStillOpen(owed)) continue;
      roles.push({
        roleKey: owed.roleKey,
        role: owed.role,
        capability: owed.role === Role.CEO
          ? "ceo"
          : owed.role === Role.BLIND_REVIEWER
            ? "blind-review"
            : owed.role === Role.WORKER ? "worker" : "cto",
        projectId: owed.projectId,
        runId: owed.runId,
        taskId: owed.taskId,
        isolationGroup: owed.taskId
          ? `task:${owed.taskId}`
          : owed.projectId
            ? `project:${owed.projectId}`
            : owed.runId ? `run:${owed.runId}` : "global",
        inFlight: true,
      });
    }
    return [...new Map(roles.map((required) => [required.roleKey, required])).values()];
  }

  /**
   * Whether the most recent binding of this role was revoked by continuity for want of coverage.
   *
   * The newest generation is the one that answers: a role bound again and later released for some
   * other reason is owed nothing, and only the latest row distinguishes those two histories. An
   * ACTIVE binding is always the newest generation, so a role that is held now answers `false`
   * here without a second lookup.
   */
  private continuityOwesBinding(roleKey: string): boolean {
    const latest = this.db.get<{ status: string; revoked_reason: string | null }>(
      `SELECT status, revoked_reason FROM assignments
        WHERE role_key = ? ORDER BY binding_generation DESC LIMIT 1`,
      [roleKey],
    );
    if (!latest || latest.status !== "REVOKED" || latest.revoked_reason === null) return false;
    return CONTINUITY_REVOCATION_REASONS.includes(latest.revoked_reason) ||
      latest.revoked_reason.startsWith(CONTINUITY_FAILOVER_REFUSED_REASON_PREFIX);
  }

  /** The scope each owed role carried, read from the revoked row because no binding holds it. */
  private continuityOwedBindings(): Array<{
    roleKey: string;
    role: Role;
    projectId: string | null;
    runId: string | null;
    taskId: string | null;
  }> {
    return this.db
      .all<{ role_key: string; role: Role; project_id: string | null; run_id: string | null; task_id: string | null }>(
        `SELECT a.role_key, a.role, a.project_id, a.run_id, a.task_id
           FROM assignments a
          WHERE a.status = 'REVOKED'
            AND a.binding_generation = (
                  SELECT MAX(b.binding_generation) FROM assignments b WHERE b.role_key = a.role_key)`,
      )
      .filter((row) => this.continuityOwesBinding(row.role_key))
      .map((row) => ({
        roleKey: row.role_key,
        role: row.role,
        projectId: row.project_id,
        runId: row.run_id,
        taskId: row.task_id,
      }));
  }

  /**
   * Whether the scope an owed binding named is still open, judged exactly as the loop that would
   * otherwise have required the role judges it: a RUNNING execution for a task, a run that has not
   * ended, a project that is not suspended. The CEO carries no scope and is always required.
   */
  private scopeStillOpen(owed: {
    role: Role;
    projectId: string | null;
    runId: string | null;
    taskId: string | null;
  }): boolean {
    if (owed.taskId !== null) {
      return this.db.get<{ one: number }>(
        `SELECT 1 AS one FROM task_executions WHERE task_id = ? AND status = 'RUNNING'`,
        [owed.taskId],
      ) !== undefined;
    }
    if (owed.runId !== null) {
      const run = this.runs.get(owed.runId);
      if (!run) return false;
      return run.state !== RunState.COMPLETED &&
        run.state !== RunState.BLOCKED_POST_MERGE &&
        run.state !== RunState.FAILED &&
        run.state !== RunState.CANCELLED;
    }
    if (owed.projectId !== null) {
      const project = this.projects.get(owed.projectId);
      return project !== null && !project.suspended;
    }
    return owed.role === Role.CEO;
  }

  /** Constitute a real, routable provider session before it is allowed to own a role. */
  private async provisionRoutableSession(
    role: Role,
    provider: string,
    purpose: string,
  ): Promise<Decision<{ sessionId: string }>> {
    const adapter = this.providers.requireForRole(provider, role);
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
