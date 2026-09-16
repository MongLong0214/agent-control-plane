import { afterAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { CAPACITY_SWEEP_BUDGET_MS } from "../../src/doctor/doctor.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { Role } from "../../src/domain/types.ts";
import type {
  CapacityReading,
  InvocationRequest,
  InvocationResult,
  ProviderAdapter,
  SessionHandle,
  SessionSpec,
} from "../../src/runtime/provider.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { testReviewerEgressEvidence } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * `Doctor.checkCapacity` refreshes provider capacity and then scores role coverage from it. After
 * #917 those became two different measurements: a provider with role-scoped adapters answers
 * `currentForRole`, whose snapshot is a `WeakMap` that only `ContinuityKernel.evaluate` fills, and
 * `capacity.refresh` deliberately skips such a provider because a provider-global row cannot carry
 * role provenance. The doctor kept refreshing only the half it does not read.
 *
 * On this deployment that is every start. `claude` is registered for `CTO_ROLES` and
 * `REVIEWER_ROLES` (`control-plane.ts`), `codex` and `grok` are both SUSPENDED, and the startup
 * doctor runs before any continuity evaluation — so the first coverage score of a cold daemon sees
 * an empty role snapshot, reports `ROLE_COVERAGE_NO_VALID_COVERAGE` as CRITICAL and blocking, and
 * the daemon parks. The park then *uninstalls the continuity coordinator*, which is the only thing
 * that would have taken the measurement, so nothing reachable clears the finding: measured
 * 2026-09-16 on `generation-e2c52f4`, parked at 00:52:48Z and still parked after two further
 * doctor passes.
 */
class ProductionTestAdapter implements ProviderAdapter {
  readonly #scripted: ScriptedAdapter;
  readonly isProduction = true;

  constructor(clock: ManualClock, provider: string) {
    this.#scripted = new ScriptedAdapter(clock, provider);
  }

  get provider(): string { return this.#scripted.provider; }
  get defaultModels(): Readonly<Record<string, string>> { return this.#scripted.defaultModels; }
  setCapacity(reading: CapacityReading | null): void { this.#scripted.setCapacity(reading); }
  startSession(spec: SessionSpec): Promise<SessionHandle> { return this.#scripted.startSession(spec); }
  stopSession(handle: SessionHandle): Promise<void> { return this.#scripted.stopSession(handle); }
  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const result = await this.#scripted.invoke(request);
    return request.isolation
      ? { ...result, isolationAttested: true, egressEvidence: testReviewerEgressEvidence(this.provider) }
      : result;
  }
  probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> { return this.#scripted.probeRuntime(); }
  probeSession(handle: SessionHandle): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    return this.#scripted.probeSession(handle);
  }
  probeCapacity(): Promise<CapacityReading> { return this.#scripted.probeCapacity(); }
}

const CAPABILITIES = ["ceo", "cto", "blind-review", "worker"];

const healthy = (provider: string, clock: ManualClock): CapacityReading => ({
  provider,
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: clock.nowIso(),
  source: "doctor-role-scope-test",
  buckets: [{ id: "rolling", remainingPercent: 90, resetAt: null, capabilities: CAPABILITIES }],
});

/**
 * A cold plane: nothing has evaluated continuity, which is exactly the state a daemon's startup
 * doctor runs in. `gpt` stands for the unscoped providers this deployment has that are out of
 * quota; `claude` is reachable only through a role-scoped registration.
 */
const coldPlane = () => {
  const root = tempDir("acp-doctor-role-");
  const clock = new ManualClock("2026-08-12T00:00:00.000Z");
  const gpt = new ProductionTestAdapter(clock, "gpt");
  const claude = new ProductionTestAdapter(clock, "claude");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [gpt, claude],
    allowTestEvidenceWriters: true,
  });
  return { cp, clock, gpt, claude };
};

const coverageFinding = (findings: readonly { code: string }[]) =>
  findings.find((finding) => finding.code.startsWith("ROLE_COVERAGE_"));

describe("the doctor measures the role before it scores it", () => {
  it("does not report a role-scoped provider as uncovered before anything measured it", async () => {
    const { cp, clock, gpt, claude } = coldPlane();
    try {
      gpt.setCapacity({ ...healthy("gpt", clock), runtimeHealth: "UNAVAILABLE" });
      claude.setCapacity(healthy("claude", clock));
      cp.providers.registerForRole(claude, Role.CEO);

      const report = await cp.doctor.run("system");

      expect(coverageFinding(report.findings)).toBeUndefined();
    } finally {
      cp.db.close();
    }
  });

  /**
   * The operator half of the same seam. `capacity.refresh` skips a provider with role-scoped
   * adapters, and nothing writes its provider-global row afterwards, so the provider disappeared
   * from the report entirely — not as a warning, as an absence.
   *
   * Measured on the live deployment 2026-09-16: `CAPACITY_LOW` findings per `DOCTOR_REPORT` were
   * consistently 2 from 00:46 through 02:00 and consistently 1 from 02:05 — the generation
   * carrying #917 — onward. The finding that vanished was `claude`'s, at 4% of its weekly window,
   * while `capacity_snapshots` last held a `claude` row at 02:04:05.872Z and `gpt` refreshed every
   * minute for the hour after.
   *
   * The scope carries the role because two roles on one provider are two quotas, and reporting
   * them under one `provider:claude` scope would collapse them into a single finding.
   */
  it("reports a role-scoped provider that is running out of quota", async () => {
    const { cp, clock, gpt, claude } = coldPlane();
    try {
      gpt.setCapacity(healthy("gpt", clock));
      claude.setCapacity({
        ...healthy("claude", clock),
        buckets: [{ id: "current-week-all-models", remainingPercent: 4, resetAt: null, capabilities: CAPABILITIES }],
      });
      cp.providers.registerForRole(claude, Role.CEO);

      const report = await cp.doctor.run("system");
      const low = report.findings.filter((finding) => finding.code === "CAPACITY_LOW");

      expect(low.map((finding) => finding.scope)).toContain("provider:claude:CEO");
    } finally {
      cp.db.close();
    }
  });

  /**
   * The same distinction one layer up, for the readers that cannot measure.
   *
   * `computeCoveragePlan` has four callers. Two of them — `OPERATOR_METHOD.CONTINUITY_STATUS`
   * (`daemon.ts`) and `continuityStatus()` (`mcp/hermes-server.ts`) — are synchronous status
   * surfaces that take no measurement, so on a `ControlPlane` where nothing has refreshed
   * capacity they read an empty snapshot and report `NO_VALID_COVERAGE`. That is a statement
   * about the reader, not about the deployment, and it is the same word an operator acts on.
   *
   * The plan says which it is now. `unmeasured` is the subset of `uncovered` where no candidate
   * provider had any reading at all — nothing read it, as against read it and refused it.
   */
  it("separates uncovered-because-nothing-read-it from uncovered-because-nothing-is-routable", async () => {
    const { cp, clock, claude, gpt } = coldPlane();
    try {
      claude.setCapacity(healthy("claude", clock));
      gpt.setCapacity(healthy("gpt", clock));
      cp.providers.registerForRole(claude, Role.CEO);

      // Nothing has refreshed: both adapters can answer, and no reader has asked.
      const cold = cp.continuity.computeCoveragePlan();
      expect(cold.outcome).toBe("NO_VALID_COVERAGE");
      expect(cold.unmeasured).toEqual(cold.uncovered);

      // After a measurement the same plan is covered, and `unmeasured` is empty — so the field
      // tracks the reading rather than the shape of the deployment.
      const measured = await cp.continuity.evaluate("a reader that measures first");
      expect(measured.outcome).toBe("FULL_COVERAGE");
      expect(measured.unmeasured).toEqual([]);
    } finally {
      cp.db.close();
    }
  });

  /**
   * And the direction that keeps the separation from becoming "never block on coverage": a
   * deployment that *was* measured and has nothing routable still reports the blocking CRITICAL.
   */
  it("still blocks when every candidate was measured and none is routable", async () => {
    const { cp, clock, claude, gpt } = coldPlane();
    try {
      claude.setCapacity({ ...healthy("claude", clock), runtimeHealth: "UNAVAILABLE" });
      gpt.setCapacity({ ...healthy("gpt", clock), runtimeHealth: "UNAVAILABLE" });
      cp.providers.registerForRole(claude, Role.CEO);

      const report = await cp.doctor.run("system");
      const coverage = report.findings.find((finding) => finding.code.startsWith("ROLE_COVERAGE_"));

      expect(coverage?.code).toBe("ROLE_COVERAGE_NO_VALID_COVERAGE");
      expect(coverage?.blocking).toBe(true);
    } finally {
      cp.db.close();
    }
  });

  /**
   * The sweep has a deadline, and what it does not reach is a finding rather than an absence.
   *
   * `REPOSITORY_SWEEP_BUDGET_MS` exists because N repository probes grow with the registry inside a
   * `doctor.run` budget of 165s. Capacity has the identical shape — one probe per provider plus one
   * per role for each role-scoped provider — and had no deadline at all. A single probe is bounded
   * at its own layer (`COLLECTOR_TIMEOUT_MS` 45s, the `--version` fallback 15s); the pass was not.
   *
   * Abandoning the sweep is only safe because the plan can now say `unmeasured`: otherwise a spent
   * budget produces the blocking CRITICAL that parks a daemon behind the coordinator that would
   * clear it. The two changes are one design and this case is where they meet.
   */
  it("reports the sweep it could not finish, and does not block on it", async () => {
    const { cp, clock, claude, gpt } = coldPlane();
    try {
      claude.setCapacity(healthy("claude", clock));
      gpt.setCapacity(healthy("gpt", clock));
      cp.providers.registerForRole(claude, Role.CEO);

      // A provider that never answers. The budget is what has to end the pass.
      vi.spyOn(gpt, "probeCapacity").mockImplementation(() => new Promise(() => {}));
      vi.useFakeTimers();
      const running = cp.doctor.run("system");
      await vi.advanceTimersByTimeAsync(CAPACITY_SWEEP_BUDGET_MS + 1_000);
      const report = await running;
      vi.useRealTimers();

      const sweep = report.findings.find((finding) => finding.code === "CAPACITY_SWEEP_NOT_REACHED");
      expect(sweep?.severity).toBe("WARN");
      expect(sweep?.blocking).toBe(false);
      expect(sweep?.observedEvidence).toMatchObject({ sweepBudgetMs: CAPACITY_SWEEP_BUDGET_MS });
    } finally {
      vi.restoreAllMocks();
      cp.db.close();
    }
  });

  /**
   * The other direction, so the fix cannot be "stop asking". A doctor that measured the role and
   * found nothing routable must still block: this is the case the CRITICAL finding is *for*, and
   * a repair that satisfied the first case by never reporting coverage would pass it while
   * removing the only automatic signal that a deployment has no provider left.
   */
  it("still reports no coverage when the measured role capacity is unroutable", async () => {
    const { cp, clock, gpt, claude } = coldPlane();
    try {
      gpt.setCapacity({ ...healthy("gpt", clock), runtimeHealth: "UNAVAILABLE" });
      claude.setCapacity({ ...healthy("claude", clock), runtimeHealth: "UNAVAILABLE" });
      cp.providers.registerForRole(claude, Role.CEO);

      const report = await cp.doctor.run("system");

      expect(coverageFinding(report.findings)?.code).toBe("ROLE_COVERAGE_NO_VALID_COVERAGE");
    } finally {
      cp.db.close();
    }
  });
});
