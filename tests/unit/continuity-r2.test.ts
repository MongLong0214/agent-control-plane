import { afterAll, describe, expect, it, vi } from "vitest";
import { accessSync, chmodSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  type ProviderCapacity,
  RefreshTrigger,
} from "../../src/capacity/capacity-monitor.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ContinuityMode, ExecutionMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import {
  ClaudeCliAdapter,
  CodexCliAdapter,
  readCapacityFile,
  runtimeEnvironment,
} from "../../src/runtime/cli-adapters.ts";
import {
  type CapacityReading,
  type InvocationRequest,
  type InvocationResult,
  type ProviderAdapter,
  ProviderRegistry,
  type SessionHandle,
  type SessionSpec,
} from "../../src/runtime/provider.ts";
import { ScriptedAdapter, type ScriptedResponse } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindWorkerForTask, fixtureManifest } from "../helpers/harness.ts";
import { testReviewerEgressEvidence } from "../helpers/production-adapter.ts";

import { afterEach } from "vitest";
import { ApprovedRunFinalizer } from "../../src/daemon/finalizer.ts";
import { makeHarness } from "../helpers/harness.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";

afterAll(cleanupTempDirs);

// The B document driver regression suite stays in the same rollback test unit.
describe("approved document restoration", () => {
const driver = () => readFileSync(new URL("../e2e/real-component-integration.test.ts", import.meta.url), "utf8");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000 }).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "docs-only-component-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Component Test");
  git(root, "config", "user.email", "component@example.invalid");
  git(root, "remote", "add", "origin", "https://github.com/MongLong0214/agent-control-plane.git");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "dogfood.md"), "Before\n");
  git(root, "add", "docs/dogfood.md");
  git(root, "commit", "-qm", "docs: initial");
  const baseHead = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "docs", "dogfood.md"), "After\n");
  const patch = execFileSync("git", ["-C", root, "diff", "--", "docs/dogfood.md"], { encoding: "utf8", timeout: 10_000 });
  writeFileSync(join(root, "docs", "dogfood.md"), "Before\n");
  return { root, input: { evidenceKind: "disposable-component", repositoryIdentity: "github:MongLong0214/agent-control-plane", baseHead, patch,
    contract: { goal: "Update the approved dogfood document", why: "Exercise the document-only terminal path", scope: ["docs/dogfood.md"], nonGoals: ["source changes"], acceptance: ["Only the approved document diff changes"], priority: "NORMAL", humanGate: [], references: ["#512"] } } };
}

describe("document-only component input", () => {
  it("executes the existing single-repository finalization caller exactly once", async () => {
    const source = driver();
    // Execute the actual caller and Daemon lock guard. Only downstream merge effects
    // are stubbed; this is disposable admission evidence, not live merge evidence.
    const start = source.lastIndexOf("      if (secondRepositoryId) {");
    const end = source.indexOf('      evidence["doctor"]', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
    const h = makeHarness();
    const instances: Daemon[] = [];
    class ComponentDaemon extends Daemon {
      constructor(...args: ConstructorParameters<typeof Daemon>) { super(...args); instances.push(this); }
    }
    const merge = vi.spyOn(ApprovedRunFinalizer.prototype, "finalizeApprovedRun").mockResolvedValue(
      allow(ReasonCode.OK, {} as never),
    );
    const stop = vi.spyOn(Daemon.prototype, "stop");
    vi.spyOn(h.cp.runs, "repositoriesOf").mockReturnValue([
      { identity: "component-only", mergeOrder: 0, mergeState: "MERGED" } as never,
    ]);
    const evidence: Record<string, unknown> = {};
    const execute = new Function("cp", "Daemon", "tempDir", "expect", "evidence", "runId", "secondRepositoryId", "SECOND_IDENTITY", `return (async () => {${body}})()`);
    const invoke = () => execute(h.cp, ComponentDaemon, tempDir, expect, evidence, "component-run", null, null);
    try {
      await invoke();
      expect(merge).toHaveBeenCalledExactlyOnceWith("component-run");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(instances[0]!.lock.held()).toBe(false);
      expect(evidence["mergeSequence"]).toEqual([{ identity: "component-only", mergeOrder: 0, mergeState: "MERGED" }]);
      expect(await instances[0]!.finalizeApprovedRun("component-run")).toMatchObject({ allowed: false, reasonCode: ReasonCode.DAEMON_LOCK_LOST });
      expect(merge).toHaveBeenCalledTimes(1);
      merge.mockRejectedValueOnce(new Error("component-finalizer-failure"));
      await expect(invoke()).rejects.toThrow("component-finalizer-failure");
      expect(stop).toHaveBeenCalledTimes(2);
      expect(instances[1]!.lock.held()).toBe(false);
    } finally {
      for (const daemon of instances) await daemon.stop();
      vi.restoreAllMocks();
      h.cp.db.close();
      cleanupTempDirs();
    }
  });
  it("supplies the explicit GitHub App file at the actual constructor boundary", () => {
    const source = driver();
    const start = source.indexOf("      const cp = new ControlPlane({");
    const end = source.indexOf("      // Existing collectors", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
    const construct = new Function("ControlPlane", "join", "root", "systemClock", "ACCEPTANCE_REVIEWER_EGRESS", "ownerIdentities", "REVIEWER_MODEL", "process", `${body}; return cp;`);
    class CaptureConfig { constructor(readonly config: Record<string, unknown>) {} }
    const invoke = (env: Record<string, string>) => construct(CaptureConfig, join, "/disposable", {}, () => ({}), [], "test-model", { env }).config;
    expect(invoke({ ACP_GITHUB_APP_ENV_FILE: "/trusted/app.env" }).githubAppEnvFile).toBe("/trusted/app.env");
    expect(invoke({}).githubAppEnvFile).toBeUndefined();
  });
  it("keeps reviewer credential scope out of the shared Claude override", () => {
    const source = driver();
    const start = source.indexOf("      const cp = new ControlPlane({");
    const end = source.indexOf("      // Existing collectors", start);
    const body = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
    const construct = new Function("ControlPlane", "join", "root", "systemClock", "ACCEPTANCE_REVIEWER_EGRESS", "ownerIdentities", "REVIEWER_MODEL", "process", `${body}; return cp;`);
    class CaptureConfig { constructor(readonly config: { adapterOptions: Record<string, { providerCredentialDir?: string; reviewerEgress: { profilePath: string } }> }) {} }
    const config = construct(CaptureConfig, join, "/disposable", {}, () => ({ profilePath: "/confined/reviewer.sb" }), [], "test-model", { env: { HOME: "/operator" } }).config;
    expect(config.adapterOptions.claude).not.toHaveProperty("providerCredentialDir");
    expect(config.adapterOptions.claude.reviewerEgress.profilePath).toBe("/confined/reviewer.sb");
    expect(config.adapterOptions.gpt.providerCredentialDir).toBe("/operator/.acp-reviewer/codex");

    // Execute the driver's constructor and planning lookup with the real default adapters.
    // No auth/capacity probe or provider invocation is needed to reach this boundary.
    const root = tempDir("acp-planning-role-");
    const cp: ControlPlane = construct(ControlPlane, join, root,
      new ManualClock("2026-08-12T00:00:00.000Z"),
      () => ({ profilePath: join(root, "reviewer.sb") }), [], "test-model", { env: { HOME: root } });
    try {
      expect(() => cp.providers.require("claude")).toThrow("has role-scoped adapters");
      const primary = cp.providers.capacityBindingForRole("claude", Role.PRIMARY_CTO)!.adapter;
      expect(primary).toBeInstanceOf(ClaudeCliAdapter);
      expect(primary).not.toBe(cp.providers.capacityBindingForRole("claude", Role.BLIND_REVIEWER)!.adapter);
      const lookup = vi.spyOn(cp.providers, "requireForRole");
      const statements = source.match(/^\s*const ctoAdapter = cp\.providers\.[^;]+;/gm);
      expect(statements).toHaveLength(1);
      const select = new Function("cp", `${statements![0]} return ctoAdapter;`);
      const selected: ProviderAdapter = select(cp);
      expect(selected.isProduction).toBe(true);
      expect(selected.provider).toBe("claude");
      // requireForRole returns a fresh capacity-observing wrapper on each lookup.
      expect(selected).toBe(lookup.mock.results[0]!.value);
      // Several producer roles share an adapter: identity alone cannot prove the caller role.
      expect(lookup).toHaveBeenCalledExactlyOnceWith("claude", Role.PRIMARY_CTO);
    } finally { vi.restoreAllMocks(); cp.close(); }
  });
  it("accepts a measured HEALTHY CONSERVE counterexample without changing admission policy", async () => {
    const { assertMeasuredCapacity, measureDocumentCapacity } = await import("../helpers/document-only-integration.ts");
    const { cp, clock, gpt, claude } = makePlane();
    try {
      claude.setCapacity(healthy("claude", clock));
      // Offline regression of the failed collector shape, not a live quota observation.
      // 4, not the 20 this case was first measured at: the conserve rung moved to 5 by owner
      // decision 2026-09-20, so 20 is now OPEN. What the case measures is unchanged -- a HEALTHY
      // reading that is nonetheless in CONSERVE stays routable for blind-review -- so the fixture
      // follows the threshold rather than the assertion being dropped.
      gpt.setCapacity(reading("gpt", clock, [{ id: "7d", remainingPercent: 4,
        resetAt: "2026-09-19T08:14:51.000Z", capabilities: ["ceo", "blind-review", "worker", "luna-worker"] }]));
      const [measured] = await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
      expect(measured).toMatchObject({ sensorHealth: "HEALTHY", runtimeHealth: "HEALTHY", allocationAdmission: "CONSERVE" });
      expect(cp.capacity.isRoutableFor(measured!, "blind-review")).toBe(true);
      const readings = [measured!];
      expect(assertMeasuredCapacity(readings, ["gpt"])).toBe(readings);
      expect((await measureDocumentCapacity(cp.capacity, cp.providers)).find((entry) => entry.provider === "gpt"))
        .toMatchObject({ allocationAdmission: "CONSERVE", buckets: [{ remainingPercent: 4 }] });
    } finally { cp.close(); }
  });
  it("unknown measured capacity fails closed; a measured reading is not rewritten", async () => {
    const { assertMeasuredCapacity } = await import("../helpers/document-only-integration.ts");
    const readings: ProviderCapacity[] = ["claude", "gpt"].map((provider) => ({
      provider, sensorHealth: "HEALTHY", runtimeHealth: "HEALTHY", observedAt: new Date().toISOString(),
      source: "component-test-only", allocationAdmission: "OPEN", advisoryState: "HEALTHY", ageMs: 0,
      unknownBuckets: [], buckets: [{ id: "measured", remainingPercent: 38, resetAt: null, capabilities: ["cto", "blind-review"] }],
    }));
    expect(assertMeasuredCapacity(readings)).toBe(readings);
    expect(() => assertMeasuredCapacity([])).toThrow("CAPACITY_UNKNOWN_NOT_ROUTABLE");
    expect(() => assertMeasuredCapacity([readings[0]!, readings[0]!])).toThrow("CAPACITY_UNKNOWN_NOT_ROUTABLE");
    expect(() => assertMeasuredCapacity(readings, ["claude", "claude"])).toThrow("CAPACITY_UNKNOWN_NOT_ROUTABLE");
    expect(() => assertMeasuredCapacity([], [])).toThrow("CAPACITY_UNKNOWN_NOT_ROUTABLE");
    for (const allocationAdmission of ["OPEN", "CONSERVE"] as const) {
      for (const remainingPercent of [Number.MIN_VALUE, 20, 100]) {
        const valid = [{ ...readings[0]!, allocationAdmission,
          buckets: [{ ...readings[0]!.buckets[0]!, remainingPercent }] }, readings[1]!];
        const before = structuredClone(valid);
        expect(assertMeasuredCapacity(valid)).toBe(valid);
        expect(valid).toEqual(before);
      }
      for (const bad of [
        ...["ERROR", "UNKNOWN", "STALE"].map((sensorHealth) => ({ sensorHealth })),
        ...["UNKNOWN", "UNAVAILABLE"].map((runtimeHealth) => ({ runtimeHealth })),
        ...["SUSPENDED", "UNKNOWN", "unexpected", undefined].map((admission) => ({ allocationAdmission: admission })),
        { buckets: [] },
        ...[null, NaN, Infinity, -Infinity, -1, 0, 100.01, "20"].map((remainingPercent) =>
          ({ buckets: [{ ...readings[0]!.buckets[0], remainingPercent }] })),
        { operatorObservation: { actor: "not-a-measurement" } },
      ]) expect(() => assertMeasuredCapacity([{ ...readings[0], allocationAdmission, ...bad }, readings[1]] as ProviderCapacity[]))
        .toThrow("CAPACITY_UNKNOWN_NOT_ROUTABLE");
    }
  });
  it("the existing caller consumes the document input before constructing provider state", () => {
    const source = driver();
    expect(source).toContain('ACP_COMPONENT_INTEGRATION_DOCUMENT_INPUT');
    expect(source.indexOf('validateDocumentInput(REAL_PROJECT')).toBeLessThan(source.indexOf('new ControlPlane('));
    expect(source).toContain('applyDocumentInput(checkout, documentInput)');
    expect(source).not.toContain('export const reasonCodeCount');
    expect(source).not.toContain('cp.capacity.observe(');
    expect(source).toContain('await measureDocumentCapacity(cp.capacity, cp.providers)');
    expect(source.match(/cp\.tasks\.startExecution\(/g)).toHaveLength(2);
    expect(source.match(/bindWorkerForTask\(/g)).toHaveLength(2);
    expect(source).not.toContain('startWorkerExecution(');
    expect(source).not.toContain('remainingPercent: 75');
  });
  it.each(["identity", "remote", "head", "scope", "source", "canonical", "dirty", "symlink"])("refuses %s contamination before applying anything", async (kind) => {
    const { validateDocumentInput } = await import("../helpers/document-only-integration.ts");
    const { root, input } = fixture();
    if (kind === "identity") input.repositoryIdentity = "github:other/project";
    if (kind === "remote") git(root, "remote", "set-url", "origin", "https://github.com/other/project.git");
    if (kind === "head") input.baseHead = "0".repeat(40);
    if (kind === "scope") input.contract.scope = ["docs/other.md"];
    if (kind === "source") { input.contract.scope = ["src/core/reason-codes.ts"]; }
    if (kind === "canonical") input.evidenceKind = "canonical-live";
    if (kind === "dirty") writeFileSync(join(root, "unapproved.txt"), "extra");
    if (kind === "symlink") {
      git(root, "config", "core.symlinks", "true");
      rmSync(join(root, "docs/dogfood.md"));
      const { symlinkSync } = await import("node:fs");
      symlinkSync("../outside.md", join(root, "docs/dogfood.md"));
      git(root, "add", "docs/dogfood.md");
      git(root, "commit", "-qm", "docs: link");
      input.baseHead = git(root, "rev-parse", "HEAD");
    }
    const before = git(root, "status", "--porcelain");
    expect(() => validateDocumentInput(root, input)).toThrow();
    expect(git(root, "status", "--porcelain")).toBe(before);
  });
  it("consumes the exact approved contract and applies only its document diff", async () => {
    const { validateDocumentInput, applyDocumentInput } = await import("../helpers/document-only-integration.ts");
    const { root, input } = fixture();
    const approved = validateDocumentInput(root, input);
    expect(approved.contract).toEqual(input.contract);
    expect(git(root, "status", "--porcelain")).toBe("");
    applyDocumentInput(root, approved);
    expect(readFileSync(join(root, "docs/dogfood.md"), "utf8")).toBe("After\n");
    expect(git(root, "diff", "--cached", "--name-only")).toBe("docs/dogfood.md");
  });
});
});

class ProductionTestAdapter implements ProviderAdapter {
  readonly #scripted: ScriptedAdapter;
  readonly isProduction = true;

  constructor(clock: ManualClock, provider: string) {
    this.#scripted = new ScriptedAdapter(clock, provider);
  }

  get provider(): string { return this.#scripted.provider; }
  get defaultModels(): Readonly<Record<string, string>> { return this.#scripted.defaultModels; }
  get invocations(): readonly InvocationRequest[] { return this.#scripted.invocations; }
  setCapacity(reading: CapacityReading | null): void { this.#scripted.setCapacity(reading); }
  setRuntimeHealth(health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE"): void { this.#scripted.setRuntimeHealth(health); }
  setNextSessionHealth(health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE"): void {
    this.#scripted.setNextSessionHealth(health);
  }
  startSession(spec: SessionSpec): Promise<SessionHandle> { return this.#scripted.startSession(spec); }
  stopSession(handle: SessionHandle): Promise<void> {
    return this.#scripted.stopSession(handle);
  }
  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const result = await this.#scripted.invoke(request);
    // This test-owned adapter does not perform I/O, so an isolated reviewer request is
    // packet-only by construction. Production adapters still have to attest their boundary.
    return request.isolation
      ? { ...result, isolationAttested: true, egressEvidence: testReviewerEgressEvidence(this.provider) }
      : result;
  }
  script(...responses: ScriptedResponse[]): this {
    this.#scripted.script(...responses);
    return this;
  }
  probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> { return this.#scripted.probeRuntime(); }
  probeSession(handle: SessionHandle): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    return this.#scripted.probeSession(handle);
  }
  probeCapacity(): Promise<CapacityReading> { return this.#scripted.probeCapacity(); }
}

const CAPABILITIES = ["ceo", "cto", "blind-review", "worker"];

const reading = (
  provider: string,
  clock: ManualClock,
  buckets: CapacityReading["buckets"],
): CapacityReading => ({
  provider,
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: clock.nowIso(),
  source: "r2-test",
  buckets,
});

const healthy = (provider: string, clock: ManualClock): CapacityReading =>
  reading(provider, clock, [{ id: "rolling", remainingPercent: 90, resetAt: null, capabilities: CAPABILITIES }]);

const makePlane = () => {
  const root = tempDir("acp-cont-r2-");
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
  return { cp, clock, gpt, claude, root };
};

describe("exact-role mandatory coverage", () => {
  it("enumerates every active critical actor and RUNNING worker without borrowing another role's quota", async () => {
    const plane = makePlane();
    const { cp, clock, gpt, claude } = plane;
    try {
      bindCeo(plane);
      const projectId = "scoped-roster";
      const manifest = fixtureManifest(projectId);
      const registered = cp.projects.register({ projectId, name: projectId, manifest,
        authorization: cp.manifestAuthorizationForTests(manifest) });
      if (!registered.allowed) throw new Error(registered.message);
      const run = cp.runs.create({ projectId, executionMode: ExecutionMode.SIMPLE,
        contract: { goal: "roster", why: "coverage", scope: [], nonGoals: [], acceptance: ["done"],
          priority: "NORMAL", humanGate: [], references: [] } });
      if (!run.allowed) throw new Error(run.message);
      gpt.setCapacity(healthy("gpt", clock));
      claude.setCapacity(healthy("claude", clock));
      const dispatched = await cp.runs.dispatch(run.value.runId);
      if (!dispatched.allowed) throw new Error(dispatched.message);
      const expected = ["CEO", roleKeyFor(Role.PRIMARY_CTO, { projectId })];
      for (const role of [Role.BOOTSTRAP_CTO, Role.BLIND_REVIEWER]) {
        const session = cp.sessions.create({ provider: "claude", model: "test" });
        cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
        const bound = cp.bindings.bind({ role, projectId, runId: run.value.runId,
          sessionId: session.sessionId });
        if (!bound.allowed) throw new Error(bound.message);
        expected.push(bound.value.roleKey);
      }
      const submitted = cp.tasks.submit(run.value.runId, ["one", "two", "idle"].map((key) => ({ key, title: key, category: "mechanical" })));
      if (!submitted.allowed) throw new Error(submitted.message);
      const tasks = cp.tasks.ready(run.value.runId);
      expect(tasks).toHaveLength(3);
      const fanout = vi.spyOn(cp.capacity, "refreshForWorkerFanout");
      for (const task of tasks) {
        const workerSessionId = bindWorkerForTask(cp, task.taskId);
        if (task.title === "idle") continue;
        const execution = cp.tasks.startExecution({ runId: run.value.runId, taskId: task.taskId, workerSessionId,
          ownerBindingGeneration: 1, provider: "gpt", model: "worker" });
        if (!execution.allowed) throw new Error(execution.message);
        expected.push(roleKeyFor(Role.WORKER, { taskId: task.taskId }));
      }
      const worker = new ProductionTestAdapter(clock, "claude");
      worker.setCapacity({ ...healthy("claude", clock), runtimeHealth: "UNAVAILABLE", buckets: [] });
      claude.setCapacity(healthy("claude", clock));
      gpt.setCapacity({ ...healthy("gpt", clock), runtimeHealth: "UNAVAILABLE" });
      for (const role of Object.values(Role)) cp.providers.registerForRole(role === Role.WORKER ? worker : claude, role);
      const plan = await cp.continuity.evaluate("complete live roster");
      expect(plan.requiredRoles.map((role) => role.roleKey).sort()).toEqual(expected.sort());
      expect(plan.requiredRoles.filter((role) => role.role === Role.WORKER)).toHaveLength(2);
      expect(plan.uncovered.sort()).toEqual(expected.filter((key) => key.startsWith("WORKER:")).sort());
      expect(plan.outcome).toBe("PARTIAL_COVERAGE");
      expect(fanout).not.toHaveBeenCalled();
      worker.setCapacity(healthy("claude", clock));
      expect((await cp.continuity.evaluate("worker measured independently")).outcome).toBe("FULL_COVERAGE");
    } finally { vi.restoreAllMocks(); cp.db.close(); }
  });
  it("measures the restored document driver against exact critical role bindings", async () => {
    const { measureDocumentCapacity } = await import("../helpers/document-only-integration.ts");
    const { cp, clock, gpt, claude } = makePlane();
    try {
      gpt.setCapacity(healthy("gpt", clock));
      const producer = new ProductionTestAdapter(clock, "claude");
      producer.setCapacity(healthy("claude", clock));
      claude.setCapacity(healthy("claude", clock));
      for (const role of [Role.CEO, Role.BOOTSTRAP_CTO, Role.PRIMARY_CTO, Role.WORKER]) {
        cp.providers.registerForRole(producer, role);
      }
      cp.providers.registerForRole(claude, Role.BLIND_REVIEWER);
      const measured = await measureDocumentCapacity(cp.capacity, cp.providers);
      expect(measured).toHaveLength(6);
      expect(measured.filter((entry) => entry.provider === "claude").map((entry) => "binding" in entry ? entry.binding.role : null))
        .toEqual([Role.CEO, Role.BOOTSTRAP_CTO, Role.PRIMARY_CTO, Role.WORKER, Role.BLIND_REVIEWER]);
      expect(cp.capacity.current("claude")?.runtimeHealth).toBe("UNKNOWN");
      claude.setCapacity({ ...healthy("claude", clock), sensorHealth: "ERROR", buckets: [] });
      await expect(measureDocumentCapacity(cp.capacity, cp.providers)).rejects.toThrow("CAPACITY_UNKNOWN_NOT_ROUTABLE");
      expect(cp.capacity.currentForRole("claude", Role.PRIMARY_CTO)?.allocationAdmission).toBe("OPEN");
    } finally { cp.db.close(); }
  });
  it.each(["generation", "superseded"])("rejects document measurement role %s invalidation under CONSERVE", async (kind) => {
    const { measureDocumentCapacity } = await import("../helpers/document-only-integration.ts");
    const { cp, clock, gpt, claude } = makePlane();
    try {
      gpt.setCapacity(healthy("gpt", clock));
      claude.setCapacity(reading("claude", clock, [{ id: "rolling", remainingPercent: 4, resetAt: null,
        capabilities: CAPABILITIES }]));
      for (const role of [Role.CEO, Role.BOOTSTRAP_CTO, Role.PRIMARY_CTO, Role.WORKER, Role.BLIND_REVIEWER]) {
        cp.providers.registerForRole(claude, role);
      }
      // The state this case is named for, read before the invalidation is injected. The fixture
      // sat at 20% while the ladder conserved below 5, so the refusals below were the injected
      // invalidation's alone and the name was describing a state the reading never had.
      expect((await cp.capacity.refreshForRole("claude", Role.PRIMARY_CTO)).allocationAdmission).toBe("CONSERVE");
      const refresh = cp.capacity.refreshForRole.bind(cp.capacity);
      vi.spyOn(cp.capacity, "refreshForRole").mockImplementation(async (provider, role) => {
        const measured = await refresh(provider, role);
        if (kind === "generation" && role === Role.CEO) {
          return { ...measured, binding: { ...measured.binding, generation: (measured.binding.generation ?? 0) + 1 } };
        }
        if (kind === "superseded" && role === Role.BLIND_REVIEWER) cp.providers.invalidateCapacityForRole("claude", Role.CEO);
        return measured;
      });
      const reason = kind === "generation" ? "role binding unavailable" : "role binding superseded";
      await expect(measureDocumentCapacity(cp.capacity, cp.providers)).rejects.toThrow(reason);
    } finally { vi.restoreAllMocks(); cp.close(); }
  });
  it("composes the original six Claude roles without sharing reviewer identity", async () => {
    const root = tempDir("acp-role-composition-");
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const cp = new ControlPlane({ databasePath: join(root, "state.sqlite"), worktreeRoot: join(root, "worktrees"),
      capacityDir: join(root, "capacity"), secretsDir: join(root, "secrets"), clock });
    try {
      const producerRoles = [Role.CEO, Role.BOOTSTRAP_CTO, Role.PRIMARY_CTO, Role.WORKER];
      const reviewerRoles = [Role.BLIND_REVIEWER, Role.OPTIONAL_ADVERSARIAL_REVIEWER];
      for (const role of [...producerRoles, ...reviewerRoles]) {
        expect(cp.providers.capacityBindingForRole("claude", role)?.role).toBe(role);
      }
      const producer = cp.providers.capacityBindingForRole("claude", Role.CEO)!.adapter;
      const reviewer = cp.providers.capacityBindingForRole("claude", Role.BLIND_REVIEWER)!.adapter;
      expect(producer).not.toBe(reviewer);
      for (const role of producerRoles) expect(cp.providers.capacityBindingForRole("claude", role)!.adapter).toBe(producer);
      for (const role of reviewerRoles) expect(cp.providers.capacityBindingForRole("claude", role)!.adapter).toBe(reviewer);
      vi.spyOn(producer, "probeCapacity").mockResolvedValue(healthy("claude", clock));
      vi.spyOn(reviewer, "probeCapacity").mockResolvedValue(healthy("claude", clock));
      vi.spyOn(cp.capacity, "refresh").mockResolvedValue([]); // no external collectors in this unit
      const plan = await cp.continuity.evaluate("default scoped composition");
      expect(plan.requiredRoles.map((role) => role.roleKey)).toEqual(["CEO"]);
      expect(plan.outcome).toBe("FULL_COVERAGE");
      expect(plan.assignments[0]?.provider).toBe("claude");
      expect(cp.capacity.current("claude")?.runtimeHealth).toBe("UNKNOWN");
    } finally { vi.restoreAllMocks(); cp.db.close(); }
  });
  it("covers a bound role-only provider absent from the shared production inventory", async () => {
    const { cp, clock, gpt, claude } = makePlane();
    try {
      gpt.setCapacity({ ...healthy("gpt", clock), runtimeHealth: "UNAVAILABLE" });
      claude.setCapacity({ ...healthy("claude", clock), runtimeHealth: "UNAVAILABLE" });
      const scoped = new ProductionTestAdapter(clock, "scoped-provider");
      scoped.setCapacity(healthy("scoped-provider", clock));
      cp.providers.registerForRole(scoped, Role.CEO);
      const session = cp.sessions.create({ provider: scoped.provider, model: "ceo" });
      cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
      expect(cp.bindings.bind({ role: Role.CEO, sessionId: session.sessionId }).allowed).toBe(true);
      expect(cp.providers.production().map((adapter) => adapter.provider)).not.toContain(scoped.provider);
      const plan = await cp.continuity.evaluate("bound scoped-only provider");
      expect(plan.outcome).toBe("FULL_COVERAGE");
      expect(plan.assignments[0]?.provider).toBe(scoped.provider);
    } finally { cp.db.close(); }
  });
  it("includes active bootstrap bindings even before their run is dispatched", async () => {
    const { cp, clock, gpt, claude } = makePlane();
    try {
      gpt.setCapacity(healthy("gpt", clock));
      claude.setCapacity(healthy("claude", clock));
      const run = cp.runs.create({ executionMode: ExecutionMode.SIMPLE,
        contract: { goal: "bootstrap", why: "coverage", scope: [], nonGoals: [], acceptance: ["done"],
          priority: "NORMAL", humanGate: [], references: [] } });
      if (!run.allowed) throw new Error(run.message);
      const session = cp.sessions.create({ provider: "claude", model: "cto" });
      cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
      const binding = cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: run.value.runId, sessionId: session.sessionId });
      if (!binding.allowed) throw new Error(binding.message);
      const plan = await cp.continuity.evaluate("active bootstrap");
      expect(plan.requiredRoles.map((role) => role.roleKey).sort()).toEqual([binding.value.roleKey, "CEO"].sort());
      expect(plan.requiredRoles.find((role) => role.role === Role.BOOTSTRAP_CTO)?.inFlight).toBe(true);
    } finally { cp.db.close(); }
  });
  it("evaluates the exact role binding without promoting provider-global UNKNOWN", async () => {
    const { cp, clock, gpt, claude } = makePlane();
    try {
      gpt.setCapacity(healthy("gpt", clock));
      claude.setCapacity({ ...healthy("claude", clock), runtimeHealth: "UNAVAILABLE" });
      cp.providers.registerForRole(gpt, Role.CEO);
      cp.providers.registerForRole(claude, Role.CEO);
      const plan = await cp.continuity.evaluate("scoped CEO coverage");
      expect(plan.requiredRoles.map((role) => role.roleKey)).toEqual(["CEO"]);
      expect(plan.outcome).toBe("FULL_COVERAGE");
      expect(plan.assignments).toEqual([{ roleKey: "CEO", provider: "gpt", reason: "preferred" }]);
      expect(plan.mode).toBe(ContinuityMode.DEGRADED);
      expect(cp.capacity.current("gpt")?.runtimeHealth).toBe("UNKNOWN");
      expect(cp.capacity.currentForRole("gpt", Role.CEO)?.binding.generation).toBe(
        cp.providers.capacityBindingForRole("gpt", Role.CEO)?.generation,
      );
      cp.providers.invalidateCapacityForRole("gpt", Role.CEO);
      expect(cp.continuity.computeCoveragePlan().outcome).toBe("NO_VALID_COVERAGE");
      expect((await cp.continuity.evaluate("fresh generation")).outcome).toBe("FULL_COVERAGE");
    } finally { cp.db.close(); }
  });
});

const attachRoutablePorts = (cp: ControlPlane) => {
  cp.continuity.attach({
    readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
    buzz: { connect: async (sessionId) => allow(ReasonCode.OK, `buzz:${sessionId}`) },
  });
};

type CliProbe = {
  environment: Record<string, string>;
  readable: Record<string, boolean>;
};

const writeCliProbe = (directory: string, paths: readonly string[]): string => {
  const binary = join(directory, "runtime-probe.mjs");
  writeFileSync(binary, `#!${process.execPath}
import { readFileSync } from "node:fs";

const paths = ${JSON.stringify(paths)};
const readable = Object.fromEntries(paths.map((path) => {
  try {
    readFileSync(path, "utf8");
    return [path, true];
  } catch {
    return [path, false];
  }
}));
process.stdout.write(JSON.stringify({ environment: process.env, readable }));
`);
  chmodSync(binary, 0o700);
  return binary;
};

const noGhPath = (): string =>
  [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    .filter((directory) => {
      try {
        accessSync(join(directory, "gh"), constants.X_OK);
        return false;
      } catch {
        return true;
      }
    })
    .join(":");

const withEnvironment = async <T>(
  replacements: Record<string, string | undefined>,
  callback: () => Promise<T>,
): Promise<T> => {
  const previous = Object.fromEntries(Object.keys(replacements).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(replacements)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

const bindCeo = (plane: ReturnType<typeof makePlane>, provider = "gpt", mode: "PREFERRED" | "FALLBACK" = "PREFERRED") => {
  const session = plane.cp.sessions.create({ provider, model: "test" });
  plane.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
  const bound = plane.cp.bindings.bind({
    role: Role.CEO,
    sessionId: session.sessionId,
    mode,
  });
  if (!bound.allowed) throw new Error(bound.message);
  return bound.value;
};


describe("round-2 capacity and runtime regressions", () => {
  it("#52 attempts a capability when one of its applicable quota windows is unknown", async () => {
    const { cp, clock, gpt } = makePlane();
    gpt.setCapacity(reading("gpt", clock, [
      { id: "rolling", remainingPercent: 60, resetAt: null, capabilities: ["cto"] },
      { id: "weekly", remainingPercent: null, resetAt: null, capabilities: ["cto"] },
    ]));
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);

    const capacity = cp.capacity.current("gpt")!;
    expect(capacity.allocationAdmission).toBe("OPEN");
    expect(cp.capacity.isRoutableFor(capacity, "cto")).toBe(true);
    expect(cp.capacity.providersFor("cto")).toHaveLength(1);
  });

  it("#53/#179/#328 admits a working capability and denies the selected missing capability", async () => {
    const { cp, clock, gpt } = makePlane();
    gpt.setCapacity(reading("gpt", clock, [
      { id: "worker", remainingPercent: 90, resetAt: "2026-08-13T00:00:00.000Z", capabilities: ["worker"] },
    ]));

    const worker = await cp.capacity.refreshForDispatch({
      provider: "gpt",
      capabilities: ["worker"],
      priority: "worker",
      reserveDemand: {
        criticalRoleInvocations: 0, expectedReviews: 0, inFlightRuns: 0, burnRatePercentPerHour: 0,
        roleDemand: { ceo: 0, cto: 0, reviewer: 0 },
      },
    });
    expect(worker.allowed).toBe(true);
    expect(worker.reasonCode).toBe(ReasonCode.OK);

    const cto = await cp.capacity.refreshForDispatch({ provider: "gpt", capabilities: ["cto"] });
    expect(cto.allowed).toBe(true);
    expect(cto.reasonCode).toBe(ReasonCode.OK);

    const unprioritizedWorker = await cp.capacity.refreshForDispatch({ provider: "gpt", capabilities: ["worker"] });
    expect(unprioritizedWorker.allowed).toBe(true);
    expect(unprioritizedWorker.reasonCode).toBe(ReasonCode.OK);
  });

  it("P0-06: daemon reconciliation does not preempt a healthy acting CEO when GPT recovers", async () => {
    const plane = makePlane();
    const acting = bindCeo(plane, "claude", "FALLBACK");
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    plane.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    attachRoutablePorts(plane.cp);

    const daemon = new Daemon(plane.cp, { stateDir: join(plane.root, "daemon") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;

    try {
      const reconciled = await daemon.reconcileContinuity("GPT recovered while Claude acting CEO remains healthy");
      expect(reconciled?.reassigned).toEqual([]);
      const current = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
      expect(current.sessionId).toBe(acting.sessionId);
      expect(current.bindingGeneration).toBe(acting.bindingGeneration);
      expect(current.mode).toBe("FALLBACK");
      expect(plane.cp.continuity.mode()).toBe(ContinuityMode.DEGRADED);
    } finally {
      await daemon.stop();
    }
  });

  it("#596: a CEO on a provider capacity does not manage is not evicted by reconciliation", async () => {
    // The once-ever bootstrap creates the generation-1 CEO as `provider: "hermes"`. No collector
    // writes a capacity snapshot for that name, so `capacity.current()` returns null on every
    // pass. Reading that as "not covered" handed the role to continuity, which replaced it with
    // gpt/claude — and the bootstrap door is closed by history, so there was no second one to
    // make. Pressing the button produced a CEO a periodic timer took away.
    const plane = makePlane();
    const bootstrapped = bindCeo(plane, "hermes");
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    plane.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    attachRoutablePorts(plane.cp);

    const daemon = new Daemon(plane.cp, { stateDir: join(plane.root, "daemon") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;

    try {
      // Healthy gpt and claude are the dangerous case, not the safe one: the more coverage the
      // plan can offer, the more certainly the incumbent is replaced.
      const reconciled = await daemon.reconcileContinuity("periodic capacity sensor refresh");

      expect(reconciled?.reassigned).toEqual([]);
      const current = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
      expect(current.sessionId).toBe(bootstrapped.sessionId);
      expect(current.bindingGeneration).toBe(bootstrapped.bindingGeneration);
      expect(plane.cp.sessions.require(current.sessionId).provider).toBe("hermes");
    } finally {
      await daemon.stop();
    }
  });

  it("#596: a CEO on an unmanaged provider still fails over once its session stops being ready", async () => {
    // Liveness is what decides, not capacity. Exempting the unmanaged provider from capacity
    // eviction must not make its binding permanent — §15 relies on failover being the only path
    // to a CEO once the bootstrap door is shut, and a binding nothing can replace would close
    // that path too.
    const plane = makePlane();
    const bootstrapped = bindCeo(plane, "hermes");
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    plane.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    attachRoutablePorts(plane.cp);
    const stopped = plane.cp.sessions.transition(
      bootstrapped.sessionId, SessionLifecycle.STOPPED, "the hermes runtime exited");
    if (!stopped.allowed) throw new Error(stopped.message);

    const daemon = new Daemon(plane.cp, { stateDir: join(plane.root, "daemon") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;

    try {
      const reconciled = await daemon.reconcileContinuity("the bound CEO runtime is gone");

      expect(reconciled?.reassigned.map((r) => r.roleKey)).toContain(roleKeyFor(Role.CEO));
      const current = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
      expect(current.sessionId).not.toBe(bootstrapped.sessionId);
      expect(plane.cp.sessions.require(current.sessionId).provider).not.toBe("hermes");
    } finally {
      await daemon.stop();
    }
  });

  it("P0-06: daemon reconciliation restores an idle acting CTO to the recovered preferred provider", async () => {
    const plane = makePlane();
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    plane.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    attachRoutablePorts(plane.cp);

    const projectId = "p0-06-restore-cto";
    const manifest = fixtureManifest(projectId);
    const project = plane.cp.projects.register({
      projectId,
      name: "P0 continuity CTO restore",
      manifest,
      authorization: plane.cp.manifestAuthorizationForTests(manifest),
    });
    if (!project.allowed) throw new Error(project.message);
    const actingSession = plane.cp.sessions.create({ provider: "gpt", model: "acting-cto" });
    const actingReady = plane.cp.sessions.transition(actingSession.sessionId, SessionLifecycle.READY, "test acting CTO ready");
    if (!actingReady.allowed) throw new Error(actingReady.message);
    const acting = plane.cp.bindings.bind({
      role: Role.PRIMARY_CTO,
      projectId,
      sessionId: actingSession.sessionId,
      mode: "FALLBACK",
    });
    if (!acting.allowed) throw new Error(acting.message);

    const daemon = new Daemon(plane.cp, { stateDir: join(plane.root, "daemon") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;

    try {
      const reconciled = await daemon.reconcileContinuity("Claude recovered before new project work");
      expect(reconciled?.restored).toContain(roleKeyFor(Role.PRIMARY_CTO, { projectId }));
      const restored = plane.cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId }))!;
      expect(restored.sessionId).not.toBe(acting.value.sessionId);
      expect(restored.bindingGeneration).toBe(acting.value.bindingGeneration + 1);
      expect(restored.mode).toBe("PREFERRED");
      expect(plane.cp.sessions.require(restored.sessionId).provider).toBe("claude");
      expect(plane.cp.continuity.mode()).toBe(ContinuityMode.NORMAL);
    } finally {
      await daemon.stop();
    }
  });

  it("#178 denies dispatch admission when no production provider exists", async () => {
    const root = tempDir("acp-no-prod-");
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const scripted = new ScriptedAdapter(clock);
    const cp = new ControlPlane({
      databasePath: join(root, "state.sqlite"),
      worktreeRoot: join(root, "worktrees"),
      capacityDir: join(root, "capacity"),
      secretsDir: join(root, "secrets"),
      clock,
      adapters: [scripted],
      allowNonProductionAdapters: true,
    });
    const decision = await cp.capacity.refreshForDispatch({ provider: "scripted", capabilities: ["cto"] });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
  });

  it("#53 fails closed when a dispatcher cannot name a concrete target", async () => {
    const { cp } = makePlane();
    const targetless = await cp.capacity.refreshForDispatch();
    expect(targetless.allowed).toBe(false);
    expect(targetless.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
    expect(targetless.evidence).toEqual({ target: null });

    const unregistered = await cp.capacity.refreshForDispatch({ provider: "missing", capabilities: ["cto"] });
    expect(unregistered.allowed).toBe(false);
    expect(unregistered.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
    expect(unregistered.evidence).toMatchObject({ provider: "missing", capabilities: ["cto"] });
  });

  it("#56 rejects a future-dated capacity file instead of keeping it fresh indefinitely", () => {
    const root = tempDir("acp-future-capacity-");
    const file = join(root, "capacity.json");
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    writeFileSync(file, JSON.stringify({
      observedAt: "2036-08-12T00:00:00.000Z",
      buckets: [{ id: "bucket", remainingPercent: 90, capabilities: ["cto"] }],
    }));
    const result = readCapacityFile("gpt", file, clock, 60_000);
    expect(result.sensorHealth).toBe("ERROR");
    expect(result.runtimeHealth).toBe("UNKNOWN");
  });

  it("#58 builds a runtime environment without daemon authority variables", () => {
    const previous = process.env.GH_TOKEN;
    const previousOpaque = process.env.RUNTIME_VALUE;
    process.env.GH_TOKEN = "ghp_not_for_agent";
    process.env.RUNTIME_VALUE = "sk-12345678901234567890";
    const environment = runtimeEnvironment(["GH_TOKEN", "RUNTIME_VALUE", "PATH"], tempDir("acp-runtime-env-"));
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
    if (previousOpaque === undefined) delete process.env.RUNTIME_VALUE;
    else process.env.RUNTIME_VALUE = previousOpaque;

    // An authority-shaped name and a credential-shaped value are both withheld even
    // though the caller allowlisted them, which is what #58 is about.
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.RUNTIME_VALUE).toBeUndefined();
    expect(environment.PATH).toBeDefined();
    // HOME is deliberately the real one: an agent session exists to authenticate to its
    // provider, and both CLIs resolve that login through the invoking user's keychain, so
    // a scratch HOME does not contain the agent — it stops it being one. Containment is
    // the withheld variables above plus the write confinement and the denied reads of the
    // database, secrets and capacity directories.
    expect(environment.HOME).toBe(process.env.HOME);
    expect(environment.TMPDIR).not.toBe(process.env.TMPDIR);
    expect(Object.keys(environment).sort()).toEqual(
      [
        "GIT_CONFIG_NOSYSTEM",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "TMPDIR",
        "USER",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      ].filter(
        (name) =>
          (name !== "USER" || process.env["USER"]) &&
          (name !== "CLAUDE_SECURESTORAGE_CONFIG_DIR" || process.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]),
      ).sort(),
    );
  });

  it("#353 denies host keychains and Git credentials without removing the provider HOME or USER", async () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const workdir = tempDir("acp-runtime-work-");
    const hostHome = tempDir("acp-runtime-home-");
    const hostTmp = tempDir("acp-runtime-host-tmp-");
    const providerScope = tempDir("acp-runtime-provider-");
    const ghDirectory = tempDir("acp-runtime-gh-");
    const workFile = join(workdir, "packet.txt");
    const gitconfig = join(hostHome, ".gitconfig");
    const netrc = join(hostHome, ".netrc");
    const keychain = join(hostHome, "Library", "Keychains", "login.keychain-db");
    mkdirSync(join(hostHome, "Library", "Keychains"), { recursive: true });
    writeFileSync(workFile, "packet input");
    writeFileSync(gitconfig, "[user]\nname = daemon\n");
    writeFileSync(netrc, "machine github.example login daemon password token\n");
    writeFileSync(keychain, "daemon provider and GitHub credentials");
    writeFileSync(join(ghDirectory, "gh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(ghDirectory, "gh"), 0o700);
    const binary = writeCliProbe(workdir, [workFile, gitconfig, netrc, keychain]);

    await withEnvironment({
      HOME: hostHome,
      USER: "acp-provider",
      PATH: ghDirectory,
      TMPDIR: hostTmp,
      GH_TOKEN: "ghp_this_must_not_reach_the_agent",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: providerScope,
    }, async () => {
      const adapter = new ClaudeCliAdapter({
        clock,
        capacityFile: join(workdir, "capacity.json"),
        binary,
        // The deployment provisioned a provider credential store, which is what makes closing
        // the host keychain possible rather than self-defeating — without one, denying it stops
        // every session authenticating and dispatch fails SESSION_NOT_READY.
        providerCredentialDir: providerScope,
        // PATH is deliberately listed: an allowlist must not be able to reintroduce gh.
        environmentAllowlist: ["PATH", "GH_TOKEN"],
      });
      const result = await adapter.invoke({
        prompt: "Report the runtime boundary.",
        workdir,
        timeoutMs: 5_000,
        // This probe only reads its supplied inputs. A writable runtime now requires a
        // guard-backed per-effect authorisation, so do not accidentally use this fixture
        // to retain the old blanket-workdir write path.
        readOnly: true,
        correlationId: "runtime-credential-containment",
      });

      expect(result.ok).toBe(true);
      const probe = JSON.parse(result.text) as CliProbe;
      // `__CF_*` is injected by macOS into any sandbox-exec child; it is not ours to remove
      // and carries no authority, so the assertion is about the variables we construct.
      const { TMPDIR, ...rest } = probe.environment;
      const fixedEnvironment = Object.fromEntries(
        Object.entries(rest).filter(([name]) => !name.startsWith("__CF_")),
      );
      expect(fixedEnvironment).toEqual({
        PATH: noGhPath(),
        HOME: hostHome,
        USER: "acp-provider",
        LANG: "C.UTF-8",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: providerScope,
      });
      expect(TMPDIR).not.toBe(hostTmp);
      expect(TMPDIR).not.toBe(hostHome);
      const runtimePath = probe.environment.PATH;
      if (!runtimePath) throw new Error("runtime probe did not receive PATH");
      expect(runtimePath.split(":")).not.toContain(ghDirectory);
      expect(probe.environment.GH_TOKEN).toBeUndefined();
      expect(probe.readable).toEqual({
        [workFile]: true,
        [gitconfig]: false,
        [netrc]: false,
        // Closed, because this fixture provisioned a provider credential store. Without one,
        // denying the host keychain would stop the provider authenticating at all — #354
        // asserts that open case, and dispatch fails SESSION_NOT_READY when it is wrong.
        [keychain]: false,
      });
    });
  });

  it("#360 refuses reviewer attestation when daemon-owned egress is not configured", async () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const packetRoot = tempDir("acp-reviewer-packet-");
    const hostHome = tempDir("acp-reviewer-home-");
    const providerScope = tempDir("acp-reviewer-provider-");
    const ghDirectory = tempDir("acp-reviewer-gh-");
    const packetFile = join(packetRoot, "packet.json");
    const daemonFile = join(tempDir("acp-reviewer-daemon-"), "state.sqlite");
    const providerConfig = join(providerScope, ".claude.json");
    const gitconfig = join(hostHome, ".gitconfig");
    const netrc = join(hostHome, ".netrc");
    const keychain = join(hostHome, "Library", "Keychains", "login.keychain-db");
    mkdirSync(join(hostHome, "Library", "Keychains"), { recursive: true });
    writeFileSync(packetFile, "immutable review input");
    writeFileSync(daemonFile, "daemon state");
    writeFileSync(providerConfig, "scoped provider configuration");
    writeFileSync(gitconfig, "[user]\nname = daemon\n");
    writeFileSync(netrc, "machine github.example login daemon password token\n");
    writeFileSync(keychain, "host keychain must not be granted to reviewers");
    writeFileSync(join(ghDirectory, "gh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(ghDirectory, "gh"), 0o700);
    const binary = writeCliProbe(packetRoot, [packetFile, providerConfig, daemonFile, gitconfig, netrc, keychain]);

    await withEnvironment({
      HOME: hostHome,
      USER: "acp-reviewer-provider",
      PATH: ghDirectory,
      GH_TOKEN: "ghp_this_must_not_reach_the_reviewer",
      CLAUDE_CONFIG_DIR: providerScope,
    }, async () => {
      const adapter = new ClaudeCliAdapter({
        clock,
        capacityFile: join(packetRoot, "capacity.json"),
        binary,
      });
      const result = await adapter.invoke({
        prompt: "Review this packet only.",
        workdir: packetRoot,
        timeoutMs: 5_000,
        readOnly: true,
        correlationId: "reviewer-isolation-spawn-path",
        isolation: {
          packetRoot,
          denyReadPaths: [daemonFile],
          emptyEnvironment: true,
          network: "provider-only",
          tools: "none",
        },
      });

      // A reviewer cannot fall back to an allow-default profile if the egress lease is not
      // configured; lack of infrastructure is a boundary loss, not a best-effort warning.
      expect(result.ok).toBe(false);
      expect(result.isolationAttested).toBe(false);
      expect(result.isolationReasonCode).toBe(ReasonCode.ISOLATION_LOST);
      expect(result.error).toContain("REVIEWER_EGRESS_CONFIG_MISSING");
    });
  });

  it("#354 returns ISOLATION_LOST when reviewer egress infrastructure is absent", async () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const packetRoot = tempDir("acp-reviewer-profile-failure-");
    const adapter = new ClaudeCliAdapter({
      clock,
      capacityFile: join(packetRoot, "capacity.json"),
      binary: writeCliProbe(packetRoot, []),
    });

    const result = await adapter.invoke({
      prompt: "This provider binary must not run.",
      workdir: packetRoot,
      timeoutMs: 5_000,
      readOnly: true,
      correlationId: "reviewer-profile-not-applied",
      isolation: {
        packetRoot,
        // The malformed deny path is immaterial: egress setup occurs before any reviewer
        // child can be spawned, and absent infrastructure must fail closed first.
        denyReadPaths: ["/tmp/acp-profile\u0000cannot-apply"],
        emptyEnvironment: true,
        network: "provider-only",
        tools: "none",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.isolationAttested).toBe(false);
    expect(result.isolationReasonCode).toBe(ReasonCode.ISOLATION_LOST);
    expect(result.error).toContain("REVIEWER_EGRESS_CONFIG_MISSING");
  });

  it("#59 rejects replacement and keeps scripted adapters out of the production registry", () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const providers = new ProviderRegistry();
    const scripted = new ScriptedAdapter(clock, "gpt");
    expect(() => providers.register(scripted)).toThrow("non-production");
    providers.registerTestAdapter(scripted);
    expect(providers.production()).toEqual([]);
    expect(() => providers.registerTestAdapter(new ScriptedAdapter(clock, "gpt"))).toThrow("already registered");
  });

  it("#57 rejects a same-provider handle the runtime never constituted", async () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const gpt = new ProductionTestAdapter(clock, "gpt");
    const result = await gpt.probeSession({
      externalSessionId: "not-a-constituted-session",
      provider: "gpt",
      model: "test",
      effort: null,
      pid: null,
      workdir: process.cwd(),
    });
    expect(result).toBe("UNAVAILABLE");
  });

  it("#132 refuses an isolated Codex answer without a freshly proved provider session", async () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const packetRoot = tempDir("acp-reviewer-packet-");
    const adapter = new CodexCliAdapter({
      clock,
      capacityFile: join(packetRoot, "capacity.json"),
      binary: "codex-not-invoked-by-this-test",
    });

    const result = await adapter.invoke({
      prompt: "Review the packet only.",
      workdir: packetRoot,
      timeoutMs: 1_000,
      readOnly: true,
      correlationId: "reviewer-isolation-test",
      isolation: {
        packetRoot,
        denyReadPaths: [join(packetRoot, "../daemon.sqlite")],
        emptyEnvironment: true,
        network: "provider-only",
        tools: "none",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.isolationAttested).toBe(false);
    expect(result.isolationReasonCode).toBe(ReasonCode.ISOLATION_LOST);
    expect(result.error).toContain("freshly proved provider session");
  });
});

describe("round-2 continuity and persistence regressions", () => {
  it("#60 rolls back a freshness write when the paired mode transition cannot commit", async () => {
    const plane = makePlane();
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    await plane.cp.continuity.evaluate("baseline");
    const before = plane.cp.db.get<{ evaluated_at: string }>(`SELECT evaluated_at FROM continuity_state WHERE id = 1`)!.evaluated_at;

    plane.clock.advance(60_000);
    plane.gpt.setCapacity({ ...healthy("gpt", plane.clock), sensorHealth: "ERROR", buckets: [] });
    plane.claude.setCapacity({ ...healthy("claude", plane.clock), sensorHealth: "ERROR", buckets: [] });
    const original = plane.cp.db.run.bind(plane.cp.db);
    const failModeWrite = vi.spyOn(plane.cp.db, "run").mockImplementation((sql, params) => {
      if (sql.includes("UPDATE continuity_state") && sql.includes("SET mode")) throw new Error("injected crash");
      return original(sql, params);
    });
    await expect(plane.cp.continuity.evaluate("both unavailable")).rejects.toThrow("injected crash");
    failModeWrite.mockRestore();

    const after = plane.cp.db.get<{ mode: ContinuityMode; evaluated_at: string }>(
      `SELECT mode, evaluated_at FROM continuity_state WHERE id = 1`,
    )!;
    expect(after.mode).toBe(ContinuityMode.NORMAL);
    expect(after.evaluated_at).toBe(before);
  });

  it("#61 refuses failover when an independently checked route is missing", async () => {
    const plane = makePlane();
    bindCeo(plane);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    plane.cp.continuity.attach({ readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) } });

    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "route absent");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
  });

  it("#57 refuses failover when a healthy runtime cannot prove its exact constituted session", async () => {
    const plane = makePlane();
    bindCeo(plane);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    plane.gpt.setRuntimeHealth("HEALTHY");
    plane.gpt.setNextSessionHealth("UNAVAILABLE");
    attachRoutablePorts(plane.cp);

    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "session probe failed");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
    expect(await plane.gpt.probeRuntime()).toBe("HEALTHY");
  });

  it("#54/#176 refreshes selected capacity when continuity session allocation fails", async () => {
    const plane = makePlane();
    bindCeo(plane);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    attachRoutablePorts(plane.cp);
    vi.spyOn(plane.gpt, "startSession").mockRejectedValueOnce(new Error("provider allocation failed"));
    const refresh = vi.spyOn(plane.cp.capacity, "refresh");

    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "provider allocation failed");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
    expect(refresh).toHaveBeenCalledWith(RefreshTrigger.PROVIDER_SWITCH_OR_FAILURE, ["gpt"]);
  });

  it("#63 changes and verifies the binding before reporting restoration", async () => {
    const plane = makePlane();
    const projectId = "restore-project";
    const manifest = fixtureManifest(projectId);
    const registered = plane.cp.projects.register({
      projectId,
      name: projectId,
      manifest,
      authorization: plane.cp.manifestAuthorizationForTests(manifest),
    });
    if (!registered.allowed) throw new Error(registered.message);
    const session = plane.cp.sessions.create({ provider: "gpt", model: "test" });
    plane.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
    const bound = plane.cp.bindings.bind({
      role: Role.PRIMARY_CTO,
      projectId,
      sessionId: session.sessionId,
      mode: "FALLBACK",
    });
    if (!bound.allowed) throw new Error(bound.message);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    attachRoutablePorts(plane.cp);

    const restored = await plane.cp.continuity.restore();
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    expect(restored.restored).toContain(roleKey);
    const active = plane.cp.bindings.active(roleKey)!;
    expect(active.sessionId).not.toBe(session.sessionId);
    expect(active.mode).toBe("PREFERRED");
    expect(plane.cp.sessions.require(active.sessionId).provider).toBe("claude");
    expect(plane.cp.continuity.mode()).toBe(ContinuityMode.NORMAL);
  });

  it("#177 retains DEGRADED and defers an acting CEO with no finished-decision receipt", async () => {
    const plane = makePlane();
    bindCeo(plane, "claude", "FALLBACK");
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    attachRoutablePorts(plane.cp);

    const restored = await plane.cp.continuity.restore();
    expect(restored.restored).not.toContain(roleKeyFor(Role.CEO));
    expect(restored.deferred).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleKey: roleKeyFor(Role.CEO), reasonCode: ReasonCode.RESTORE_WOULD_PREEMPT_INFLIGHT_OWNER }),
    ]));
    expect(plane.cp.continuity.mode()).toBe(ContinuityMode.DEGRADED);
  });

  it("#180 includes each active worker task as an in-flight coverage requirement", async () => {
    const plane = makePlane();
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    const run = plane.cp.runs.create({
      executionMode: ExecutionMode.SIMPLE,
      contract: { goal: "worker", why: "worker", scope: [], nonGoals: [], acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] },
    });
    if (!run.allowed) throw new Error(run.message);
    const tasks = plane.cp.tasks.submit(run.value.runId, [{ key: "task", title: "task", category: "mechanical" }]);
    if (!tasks.allowed) throw new Error(tasks.message);
    const task = plane.cp.tasks.ready(run.value.runId)[0]!;
    const workerSessionId = bindWorkerForTask(plane.cp, task.taskId);
    const execution = plane.cp.tasks.startExecution({
      runId: run.value.runId,
      taskId: task.taskId,
      ownerBindingGeneration: 1,
      workerSessionId,
      provider: "gpt",
      model: "worker",
    });
    if (!execution.allowed) throw new Error(execution.message);

    const plan = await plane.cp.continuity.evaluate("worker execution");
    expect(plan.requiredRoles).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: Role.WORKER, taskId: task.taskId, inFlight: true }),
    ]));
  });

  it("#183 detects a binding generation superseded while failover awaits session creation", async () => {
    const plane = makePlane();
    bindCeo(plane);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    attachRoutablePorts(plane.cp);
    const originalStart = plane.gpt.startSession.bind(plane.gpt);
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(plane.gpt, "startSession").mockImplementationOnce(async (spec) => {
      started();
      await gate;
      return originalStart(spec);
    });

    const pending = plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "racing failover");
    await entered;
    const concurrent = plane.cp.sessions.create({ provider: "gpt", model: "concurrent" });
    plane.cp.sessions.transition(concurrent.sessionId, SessionLifecycle.READY, "concurrent");
    const switched = plane.cp.bindings.switchTo({
      role: Role.CEO,
      sessionId: concurrent.sessionId,
      reason: "newer failover",
      conversation: "REPLACED",
      takeover: true,
    });
    expect(switched.allowed).toBe(true);
    release();

    const refused = await pending;
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.BINDING_GENERATION_STALE);
    expect(plane.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId).toBe(concurrent.sessionId);
  });

  it("#183 fences a superseding binding that arrives between the freshness check and switch", async () => {
    const plane = makePlane();
    const incumbent = bindCeo(plane);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    attachRoutablePorts(plane.cp);
    const originalSwitch = plane.cp.bindings.switchTo.bind(plane.cp.bindings);

    vi.spyOn(plane.cp.bindings, "switchTo").mockImplementationOnce((input) => {
      expect(input.expectedCurrentGeneration).toBe(incumbent.bindingGeneration);
      const concurrent = plane.cp.sessions.create({ provider: "gpt", model: "concurrent" });
      plane.cp.sessions.transition(concurrent.sessionId, SessionLifecycle.READY, "concurrent");
      const newer = originalSwitch({
        conversation: "REPLACED",
        role: Role.CEO,
        sessionId: concurrent.sessionId,
        reason: "newer failover",
        takeover: true,
      });
      expect(newer.allowed).toBe(true);
      return originalSwitch(input);
    });

    const refused = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "last-moment race");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.BINDING_GENERATION_STALE);
    expect(plane.cp.bindings.active(roleKeyFor(Role.CEO))!.bindingGeneration).toBe(2);
  });

  it("#64 rolls back a replacement observation when a later bucket insert fails", async () => {
    const plane = makePlane();
    plane.gpt.setCapacity(reading("gpt", plane.clock, [
      { id: "first", remainingPercent: 90, resetAt: null, capabilities: ["cto"] },
      { id: "second", remainingPercent: 90, resetAt: null, capabilities: ["cto"] },
    ]));
    const original = plane.cp.db.run.bind(plane.cp.db);
    const failSecond = vi.spyOn(plane.cp.db, "run").mockImplementation((sql, params) => {
      if (sql.includes("INSERT OR REPLACE INTO capacity_snapshots") && (params ?? []).includes("second")) {
        throw new Error("injected bucket write failure");
      }
      return original(sql, params);
    });
    await expect(plane.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"])).rejects.toThrow(
      "injected bucket write failure",
    );
    failSecond.mockRestore();
    expect(plane.cp.capacity.current("gpt")).toBeNull();
  });
});
