import { afterAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { AGENTCTL_CAPACITY_OBSERVATION_SOURCE, RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ContinuityMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ContinuityKernel } from "../../src/continuity/continuity-kernel.ts";
import type { AuthenticatedTargetTuple } from "../../src/session/binding-registry.ts";
import type {
  CapacityReading,
  InvocationRequest,
  InvocationResult,
  ProviderAdapter,
  SessionHandle,
  SessionSpec,
} from "../../src/runtime/provider.ts";
import { readCapacityFile } from "../../src/runtime/cli-adapters.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";

/** Test double with the production adapter contract; ScriptedAdapter itself remains false. */
class ProductionTestAdapter implements ProviderAdapter {
  readonly #scripted: ScriptedAdapter;
  readonly isProduction = true;

  constructor(clock: ManualClock, provider: string) {
    this.#scripted = new ScriptedAdapter(clock, provider);
  }

  get provider(): string { return this.#scripted.provider; }
  get defaultModels(): Readonly<Record<string, string>> { return this.#scripted.defaultModels; }
  setCapacity(reading: CapacityReading | null): void { this.#scripted.setCapacity(reading); }
  setRuntimeHealth(health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE"): void { this.#scripted.setRuntimeHealth(health); }
  async startSession(spec: SessionSpec): Promise<SessionHandle> {
    const handle = await this.#scripted.startSession(spec);
    return { ...handle, workdir: join(spec.workdir, "provider-returned-workdir") };
  }
  stopSession(handle: SessionHandle): Promise<void> {
    return this.#scripted.stopSession(handle);
  }
  invoke(request: InvocationRequest): Promise<InvocationResult> { return this.#scripted.invoke(request); }
  probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> { return this.#scripted.probeRuntime(); }
  probeSession(handle: SessionHandle): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    return this.#scripted.probeSession(handle);
  }
  probeCapacity(): Promise<CapacityReading> { return this.#scripted.probeCapacity(); }
}

afterAll(cleanupTempDirs);

const makePlane = () => {
  const root = tempDir("acp-cont-hard-");
  const clock = new ManualClock("2026-08-12T00:00:00.000Z");
  const gpt = new ProductionTestAdapter(clock, "gpt");
  const claude = new ProductionTestAdapter(clock, "claude");
  const repoPath = makeRepo({ "src/app.js": "module.exports = () => 1;\n" });

  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [gpt, claude],
    allowTestEvidenceWriters: true,
    ctoPreference: { provider: "claude", model: "opus", effort: null },
    reviewer: {
      preferred: { provider: "gpt", model: "gpt-5.6-sol", effort: "xhigh" },
      fallbacks: [],
    },
  });
  return { cp, clock, gpt, claude, repoPath, root };
};

const reading = (
  provider: string,
  clock: ManualClock,
  buckets: CapacityReading["buckets"],
): CapacityReading => ({
  provider,
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: clock.nowIso(),
  source: "test",
  buckets,
});

const FULL = ["ceo", "cto", "blind-review", "worker"];

const authenticatedTarget = () => {
  const claimed = {
    executorKind: "hermes",
    targetLocator: "target:continuity-hardening-ceo",
    targetLocatorDigest: `sha256:${"c".repeat(64)}`,
  };
  let verified: AuthenticatedTargetTuple | undefined;
  return {
    claimed,
    protocolVersion: "hermes.target-bind/v1",
    get attestationDigest() {
      if (!verified) throw new Error("attestation digest read before tuple verification");
      const tuple = [
        verified.actorId,
        String(verified.generation),
        verified.assignmentId,
        verified.sessionId,
        verified.incarnation,
      ].join("\u0000");
      return `sha256:${createHash("sha256").update(tuple).digest("hex")}`;
    },
    verify: (tuple: AuthenticatedTargetTuple) => {
      verified = tuple;
      return claimed;
    },
  };
};

const bindCeoSessionWithTarget = (plane: ReturnType<typeof makePlane>, attest = true) => {
  const session = plane.cp.sessions.create({ provider: "gpt", model: "gpt-5.6-sol" });
  plane.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
  const bound = plane.cp.bindings.bind({
    roleKey: roleKeyFor(Role.CEO),
    role: Role.CEO,
    sessionId: session.sessionId,
    ...(attest ? { authenticatedTarget: authenticatedTarget() } : {}),
  });
  if (!bound.allowed) throw new Error(bound.message);
  return bound.value;
};

describe("capacity routability (§14.3 — no UNKNOWN routing)", () => {
  it("a bucket with no remaining percentage is not routable and does not staff a role", async () => {
    const { cp, clock, gpt, claude } = makePlane();
    // Quota is genuinely unknown for gpt: the bucket exists, its remaining is not known.
    gpt.setCapacity(
      reading("gpt", clock, [{ id: "rolling-5h", remainingPercent: null, resetAt: null, capabilities: FULL }]),
    );
    claude.setCapacity(
      reading("claude", clock, [{ id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL }]),
    );

    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT);
    const gptCapacity = cp.capacity.current("gpt")!;
    expect(gptCapacity.unknownBuckets).toEqual(["rolling-5h"]);
    expect(gptCapacity.allocationAdmission).toBe("SUSPENDED");
    expect(cp.capacity.isRoutableFor(gptCapacity, "cto")).toBe(false);
    expect(cp.capacity.providersFor("cto").map((c) => c.provider)).toEqual(["claude"]);

    const plan = await cp.continuity.evaluate("unknown gpt quota");
    expect(plan.assignments.every((a) => a.provider === "claude")).toBe(true);
  });

  it("an unprobed runtime suspends the provider even with quota remaining", async () => {
    const { cp, clock, gpt } = makePlane();
    gpt.setCapacity({
      ...reading("gpt", clock, [
        { id: "rolling-5h", remainingPercent: 100, resetAt: null, capabilities: FULL },
      ]),
      runtimeHealth: "UNKNOWN",
    });

    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
    const capacity = cp.capacity.current("gpt")!;
    expect(capacity.allocationAdmission).toBe("SUSPENDED");
    expect(cp.capacity.isRoutableFor(capacity, "cto")).toBe(false);
  });
});

describe("capacity sensor honesty (§14.2)", () => {
  /** Synthetic fixture value only — it is not a real provider quota claim. */
  const FIXTURE_OBSERVED_REMAINING_PERCENT = 74;

  const capacityFile = (body: unknown): string => {
    const dir = tempDir("acp-capfile-");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude.json");
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };

  it("a file with no timestamp is an ERROR sensor with an unknown runtime, not a fresh one", () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const file = capacityFile({
      buckets: [{ id: "b", remainingPercent: 100, capabilities: FULL }],
    });
    const out = readCapacityFile("claude", file, clock, 60_000);
    expect(out.sensorHealth).toBe("ERROR");
    expect(out.runtimeHealth).toBe("UNKNOWN");
    expect(out.error).toBe("no observedAt");
  });

  it("an unparsable timestamp is an ERROR sensor rather than a guess", () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const file = capacityFile({
      observedAt: "yesterday-ish",
      buckets: [{ id: "b", remainingPercent: 100, capabilities: FULL }],
    });
    const out = readCapacityFile("claude", file, clock, 60_000);
    expect(out.sensorHealth).toBe("ERROR");
    expect(out.runtimeHealth).toBe("UNKNOWN");
  });

  it("a quota file that states no runtime health leaves it UNKNOWN for the probe to settle", () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const file = capacityFile({
      observedAt: "2026-08-12T00:00:00.000Z",
      buckets: [{ id: "b", remainingPercent: 100, capabilities: FULL }],
    });
    const out = readCapacityFile("claude", file, clock, 60_000);
    expect(out.sensorHealth).toBe("HEALTHY");
    expect(out.runtimeHealth).toBe("UNKNOWN");
  });

  it("an unparsable observedAt cannot be enriched into a healthy sensor", async () => {
    const { cp, clock, gpt } = makePlane();
    gpt.setCapacity({
      ...reading("gpt", clock, [
        { id: "rolling-5h", remainingPercent: 100, resetAt: null, capabilities: FULL },
      ]),
      observedAt: "not-a-date",
      sensorHealth: "HEALTHY",
    });
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
    const capacity = cp.capacity.current("gpt")!;
    expect(capacity.sensorHealth).toBe("ERROR");
    expect(capacity.allocationAdmission).toBe("SUSPENDED");
  });

  it("replaces a prior healthy reading with SUSPENDED when the live collector throws", async () => {
    const { cp, clock, gpt } = makePlane();
    gpt.setCapacity(reading("gpt", clock, [
      { id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL },
    ]));
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
    expect(cp.capacity.current("gpt")?.allocationAdmission).toBe("OPEN");

    gpt.probeCapacity = async () => { throw new Error("interactive /usage PTY crashed"); };
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);

    const failed = cp.capacity.current("gpt")!;
    expect(failed).toMatchObject({
      sensorHealth: "ERROR",
      allocationAdmission: "SUSPENDED",
      runtimeHealth: "UNKNOWN",
    });
    const admission = await cp.capacity.refreshForBlindReview({
      provider: "gpt",
      capabilities: ["blind-review"],
      priority: "critical",
    });
    expect(admission).toMatchObject({ allowed: false, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    // If the exception catch/persist step is removed, refresh throws or retains OPEN;
    // either outcome breaks this test instead of routing on the old quota.
  });

  it("a collector ERROR replaces a stale operator observation instead of falling back to it", async () => {
    const { cp, clock, gpt } = makePlane();
    const observed = await cp.capacity.observe({
      provider: "gpt",
      observedAt: clock.nowIso(),
      runtimeHealth: "HEALTHY",
      actor: "fixture-operator",
      // Only the daemon-stamped surface is accepted; a caller-chosen source is refused.
      source: AGENTCTL_CAPACITY_OBSERVATION_SOURCE,
      buckets: [{
        id: "fixture-window",
        remainingPercent: FIXTURE_OBSERVED_REMAINING_PERCENT,
        resetAt: null,
        capabilities: FULL,
      }],
    });
    expect(observed).toMatchObject({ allowed: true, value: { allocationAdmission: "OPEN" } });

    // Make the prior human observation stale before the collector reports its own error.
    // The synthetic fixture error is the newer durable fact and must be the only current one.
    clock.advance(15 * 60 * 1000 + 1);
    gpt.setCapacity({
      provider: "gpt",
      sensorHealth: "ERROR",
      runtimeHealth: "HEALTHY",
      observedAt: clock.nowIso(),
      source: "fixture-collector-error",
      error: "synthetic fixture collector error",
      buckets: [],
    });
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);

    const current = cp.capacity.current("gpt")!;
    // Removing the collector-error persist path leaves the old observation in place and
    // fails these source/provenance assertions as well as the immediate suspension check.
    expect(current).toMatchObject({
      sensorHealth: "ERROR",
      allocationAdmission: "SUSPENDED",
      source: "fixture-collector-error",
    });
    expect(current.operatorObservation).toBeUndefined();
    expect(cp.capacity.isRoutableFor(current, "cto")).toBe(false);
  });
});

describe("completion requires a current continuity mode (§15.6)", () => {
  const seed = async (plane: ReturnType<typeof makePlane>) => {
    const manifest = fixtureManifest("cont-hard");
    const project = plane.cp.projects.register({
      projectId: "cont-hard",
      name: "cont-hard",
      manifest,
      authorization: plane.cp.manifestAuthorizationForTests(manifest),
    });
    if (!project.allowed) throw new Error(project.message);
    for (const adapter of [plane.gpt, plane.claude]) {
      adapter.setCapacity(
        reading(adapter.provider, plane.clock, [
          { id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL },
        ]),
      );
    }
    await plane.cp.continuity.evaluate("seed");
  };

  it("refuses completion when coverage has never been evaluated", () => {
    const plane = makePlane();
    const decision = plane.cp.continuity.assertCompletionAllowed("run_x");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION);
  });

  it("allows completion right after an evaluation and refuses once that evaluation is stale", async () => {
    const plane = makePlane();
    await seed(plane);
    expect(plane.cp.continuity.mode()).toBe(ContinuityMode.NORMAL);
    expect(plane.cp.continuity.assertCompletionAllowed("run_x").allowed).toBe(true);

    // Both providers die, but nothing re-evaluates: the stored NORMAL is now a claim about
    // the past, so it must not license a production-ready completion.
    plane.clock.advance(10 * 60 * 1000);
    expect(plane.cp.continuity.mode()).toBe(ContinuityMode.NORMAL);
    const stale = plane.cp.continuity.assertCompletionAllowed("run_x");
    expect(stale.allowed).toBe(false);
    expect(stale.reasonCode).toBe(ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION);
    expect(stale.allowed === false && stale.message.includes("stale")).toBe(true);
  });

  it("a re-evaluation after both providers fail turns the stale NORMAL into SURVIVAL", async () => {
    const plane = makePlane();
    await seed(plane);
    plane.gpt.setRuntimeHealth("UNAVAILABLE");
    plane.claude.setRuntimeHealth("UNAVAILABLE");
    plane.gpt.setCapacity(null);
    plane.claude.setCapacity(null);

    const plan = await plane.cp.continuity.evaluate("both providers down");
    expect(plan.outcome).toBe("NO_VALID_COVERAGE");
    expect(plane.cp.continuity.mode()).toBe(ContinuityMode.SURVIVAL);
    expect(plane.cp.continuity.assertCompletionAllowed("run_x").allowed).toBe(false);
  });
});

describe("failover produces a routable session (§15.7)", () => {
  const bindCeoSession = (plane: ReturnType<typeof makePlane>) => {
    const session = plane.cp.sessions.create({ provider: "gpt", model: "gpt-5.6-sol" });
    plane.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
    const bound = plane.cp.bindings.bind({
      roleKey: roleKeyFor(Role.CEO),
      role: Role.CEO,
      sessionId: session.sessionId,
      authenticatedTarget: authenticatedTarget(),
    });
    if (!bound.allowed) throw new Error(bound.message);
    return session.sessionId;
  };

  it("refuses to switch the binding when no readiness probe is attached", async () => {
    const plane = makePlane();
    bindCeoSession(plane);
    for (const adapter of [plane.gpt, plane.claude]) {
      adapter.setCapacity(
        reading(adapter.provider, plane.clock, [
          { id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL },
        ]),
      );
    }
    await plane.cp.continuity.evaluate("seed");

    // A kernel built from the same components but with no readiness port attached — the
    // shape a caller gets when it forgets to wire the probe.
    const bare = new ContinuityKernel(
      plane.cp.db,
      plane.cp.clock,
      plane.cp.audit,
      plane.cp.capacity,
      plane.cp.providers,
      plane.cp.projects,
      plane.cp.runs,
      plane.cp.sessions,
      plane.cp.bindings,
      plane.cp.telemetry,
    );

    const before = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const decision = await bare.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "test");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
    const after = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.bindingGeneration).toBe(before.bindingGeneration);
  });

  it("refuses the switch when the readiness probe fails, leaving the old binding in force", async () => {
    const plane = makePlane();
    bindCeoSession(plane);
    for (const adapter of [plane.gpt, plane.claude]) {
      adapter.setCapacity(
        reading(adapter.provider, plane.clock, [
          { id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL },
        ]),
      );
    }
    await plane.cp.continuity.evaluate("seed");
    plane.cp.continuity.attach({
      readiness: {
        checkSession: async () =>
          deny(ReasonCode.SESSION_NOT_READY, "process is not running", {}),
      },
    });

    const before = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "test");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
    const after = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.bindingGeneration).toBe(before.bindingGeneration);
  });

  it("switches the binding once the new session is shown to be ready", async () => {
    const plane = makePlane();
    bindCeoSession(plane);
    for (const adapter of [plane.gpt, plane.claude]) {
      adapter.setCapacity(
        reading(adapter.provider, plane.clock, [
          { id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL },
        ]),
      );
    }
    await plane.cp.continuity.evaluate("seed");
    const probed: string[] = [];
    plane.cp.continuity.attach({
      readiness: {
        checkSession: async (sessionId: string) => {
          probed.push(sessionId);
          return allow(ReasonCode.OK, undefined);
        },
      },
      buzz: {
        connect: async (sessionId: string) => allow(ReasonCode.OK, `buzz:${sessionId}`),
      },
    });

    const before = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "test");
    expect(decision.allowed).toBe(true);
    const after = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    expect(after.sessionId).not.toBe(before.sessionId);
    // #493 — both providers are healthy here, so the replacement lands on the same provider and
    // this is one conversation continuing on a new runtime. The generation therefore holds: it
    // is a fencing counter, and advancing it would retire the counterpart the owner is talking
    // to, which is the defect #493 fixed. What this test is named for — that failover produces a
    // routable session — is asserted above and below, and both still hold.
    expect(after.bindingGeneration).toBe(before.bindingGeneration);
    expect(after.boundSessionId).toBe(before.boundSessionId);
    expect(probed).toEqual([after.sessionId]);
    const provisioned = plane.cp.sessions.require(after.sessionId);
    expect(provisioned.workdir).toBe(join(plane.root, "runtime", "provider-returned-workdir"));
    expect(provisioned.workdir).not.toBe(process.cwd());
    expect(() => plane.cp.db.run(
      `UPDATE sessions SET workdir = ? WHERE session_id = ?`,
      [join(plane.root, "another-runtime"), provisioned.sessionId],
    )).toThrow("SESSION_WORKDIR_IMMUTABLE");
  });
});


describe("attested continuity survival (#649 S2)", () => {
  const attach = (plane: ReturnType<typeof makePlane>) => {
    plane.cp.continuity.attach({
      readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
      buzz: { connect: async (sessionId: string) => allow(ReasonCode.OK, `buzz:${sessionId}`) },
    });
  };

  it("survives a provider-changing failover only with an exact current attestation", async () => {
    const plane = makePlane();
    const before = bindCeoSessionWithTarget(plane);
    plane.gpt.setCapacity(reading("gpt", plane.clock, [{ id: "rolling", remainingPercent: 0, resetAt: null, capabilities: FULL }]));
    plane.claude.setCapacity(reading("claude", plane.clock, [{ id: "rolling", remainingPercent: 90, resetAt: null, capabilities: FULL }]));
    attach(plane);

    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "attested provider change");
    expect(decision.allowed).toBe(true);
    expect(plane.cp.bindings.active(roleKeyFor(Role.CEO))!.bindingGeneration).toBe(before.bindingGeneration);
  });

  it("replaces same-provider failover when attestation is absent or any exact tuple denominator is stale", async () => {
    const corruptions: Array<[string, "executor_session_id" | "executor_session_incarnation" | "binding_generation" | "assignment_id", string | number]> = [
      ["stale session", "executor_session_id", "stale-session"],
      ["stale incarnation", "executor_session_incarnation", "stale-incarnation"],
      ["stale generation", "binding_generation", 2],
      ["wrong assignment", "assignment_id", "stale-assignment"],
    ];
    for (const [name, column, value] of [["absent", null, null] as const, ...corruptions]) {
      const plane = makePlane();
      const before = bindCeoSessionWithTarget(plane, column !== null);
      if (column !== null) {
        // The production facade permits DML only. A second test-only connection models a stale
        // persisted row that current write-time guards would otherwise reject.
        const foreign = new Database(join(plane.root, "state.sqlite"));
        try {
          foreign.exec(`
            DROP TRIGGER IF EXISTS actor_target_attestations_append_only;
            DROP TRIGGER IF EXISTS attestation_generation_matches_assignment;
            PRAGMA foreign_keys = OFF;
          `);
          foreign.prepare(`UPDATE actor_target_attestations SET ${column} = ? WHERE assignment_id = ?`)
            .run(value, before.assignmentId);
        } finally {
          foreign.close();
        }
      }
      plane.gpt.setCapacity(reading("gpt", plane.clock, [{ id: "rolling", remainingPercent: 90, resetAt: null, capabilities: FULL }]));
      plane.claude.setCapacity(reading("claude", plane.clock, [{ id: "rolling", remainingPercent: 0, resetAt: null, capabilities: FULL }]));
      attach(plane);

      const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, `same-provider ${name}`);
      expect(decision.allowed).toBe(true);
      expect(plane.cp.bindings.active(roleKeyFor(Role.CEO))!.bindingGeneration).toBe(before.bindingGeneration + 1);
    }
  });

  it("replaces a failover when the target binding belongs to a different actor", async () => {
    const plane = makePlane();
    const before = bindCeoSessionWithTarget(plane);
    // The production facade permits DML only. A second test-only connection models a target
    // ownership row that no longer names the active assignment's actor.
    const foreign = new Database(join(plane.root, "state.sqlite"));
    try {
      foreign.exec(`
        DROP TRIGGER IF EXISTS actor_target_bindings_immutable;
        PRAGMA foreign_keys = OFF;
      `);
      foreign.prepare(`
        UPDATE actor_target_bindings
           SET target_actor_id = ?
         WHERE target_binding_id = (
           SELECT target_binding_id
             FROM actor_target_attestations
            WHERE assignment_id = ?
         )
      `).run("actor:wrong-target-owner", before.assignmentId);
    } finally {
      foreign.close();
    }
    plane.gpt.setCapacity(reading("gpt", plane.clock, [{ id: "rolling", remainingPercent: 90, resetAt: null, capabilities: FULL }]));
    plane.claude.setCapacity(reading("claude", plane.clock, [{ id: "rolling", remainingPercent: 0, resetAt: null, capabilities: FULL }]));
    attach(plane);

    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "wrong target owner");
    expect(decision.allowed).toBe(true);
    expect(plane.cp.bindings.active(roleKeyFor(Role.CEO))!.bindingGeneration).toBe(before.bindingGeneration + 1);
  });

  it("replaces when the actor runtime moves after planning but before the switch transaction", async () => {
    const plane = makePlane();
    const before = bindCeoSessionWithTarget(plane);
    const racedRuntime = plane.cp.sessions.create({ provider: "gpt", model: "race" });
    plane.cp.sessions.transition(racedRuntime.sessionId, SessionLifecycle.READY, "test race runtime");
    plane.gpt.setCapacity(reading("gpt", plane.clock, [{ id: "rolling", remainingPercent: 90, resetAt: null, capabilities: FULL }]));
    plane.claude.setCapacity(reading("claude", plane.clock, [{ id: "rolling", remainingPercent: 0, resetAt: null, capabilities: FULL }]));
    attach(plane);

    const originalSwitchTo = plane.cp.bindings.switchTo.bind(plane.cp.bindings);
    const switchTo = vi.spyOn(plane.cp.bindings, "switchTo").mockImplementation((input) => {
      // ContinuityKernel has already planned SURVIVED by the time its call reaches this wrapper.
      // The same-generation runtime move invalidates the old attestation immediately before the
      // registry's original transaction starts.
      plane.cp.db.run(
        `UPDATE conversational_actors
            SET current_session_id = ?, current_session_incarnation = ?
          WHERE actor_id = (SELECT actor_id FROM assignments WHERE assignment_id = ?)`,
        [racedRuntime.sessionId, racedRuntime.incarnation, before.assignmentId],
      );
      return originalSwitchTo(input);
    });
    try {
      const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "pre-switch runtime race");
      expect(decision.allowed).toBe(true);
      expect(switchTo).toHaveBeenCalledOnce();
      const after = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
      expect(after.bindingGeneration).toBe(before.bindingGeneration + 1);
      expect(after.assignmentId).not.toBe(before.assignmentId);
    } finally {
      switchTo.mockRestore();
    }
  });

  it("applies the same exact-attestation rule during restoration", async () => {
    const plane = makePlane();
    const projectId = "attested-restore";
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
      authenticatedTarget: authenticatedTarget(),
    });
    if (!bound.allowed) throw new Error(bound.message);
    plane.gpt.setCapacity(reading("gpt", plane.clock, [{ id: "rolling", remainingPercent: 90, resetAt: null, capabilities: FULL }]));
    plane.claude.setCapacity(reading("claude", plane.clock, [{ id: "rolling", remainingPercent: 90, resetAt: null, capabilities: FULL }]));
    attach(plane);

    await plane.cp.continuity.restore();
    const active = plane.cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId }))!;
    expect(active.sessionId).not.toBe(session.sessionId);
    expect(active.bindingGeneration).toBe(bound.value.bindingGeneration);
  });
});
