import { afterAll, afterEach, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import type { SessionHandle } from "../../src/runtime/provider.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary } from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest, registerFixtureProject } from "../helpers/harness.ts";

/**
 * #246 PR-C C4-R2 — review 2 of the recovery slice: a failover replaces only the exact holder it
 * decided to replace, at every await and at the switch itself, and a replacement it provisioned and
 * does not use is stopped through the provider, never only marked STOPPED. The first three are the
 * review's reproductions with only their harness adapted (no review-tree output files).
 */
afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/** The row a provisioned replacement was recorded under, found by its provider conversation id. */
const replacementRow = (f: BootstrapRuntimeFixture, resource: SessionHandle) =>
  f.harness.cp.db.get<{ session_id: string; lifecycle: string }>(
    "SELECT session_id, lifecycle FROM sessions WHERE incarnation LIKE ?",
    [`${resource.externalSessionId}#%`],
  );

it("1084-R1-04 final await: same-generation runtime move must refuse failover", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const projectId = "review-final-runtime-move";
    await registerFixtureProject(f.harness, projectId);
    const initial = await cp.cto.ensurePrimaryCto(projectId, "fixture");
    if (!initial.allowed) throw new Error(initial.message);
    const other = cp.sessions.create({ provider: "scripted", model: "concurrent-cto" });
    cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "fixture concurrent runtime");
    const start = f.gpt.startSession.bind(f.gpt);
    let moved = false;
    vi.spyOn(f.gpt, "startSession").mockImplementationOnce(async (spec) => {
      const switched = cp.bindings.switchTo({ roleKey: initial.value.roleKey, role: Role.PRIMARY_CTO, projectId,
        sessionId: other.sessionId, mode: "PREFERRED", reason: "concurrent surviving move", conversation: "SURVIVED" });
      if (!switched.allowed) throw new Error(switched.message);
      moved = true;
      expect(switched.value.assignmentId).toBe(initial.value.assignmentId);
      expect(switched.value.bindingGeneration).toBe(initial.value.bindingGeneration);
      expect(switched.value.sessionId).toBe(other.sessionId);
      return start(spec);
    });
    f.loseClaude();
    const result = await cp.continuity.failover(initial.value.roleKey, Role.PRIMARY_CTO, { projectId }, "fixture final await");
    const after = cp.bindings.active(initial.value.roleKey);
    expect(moved).toBe(true);
    expect.soft(result).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    expect.soft(after?.sessionId).toBe(other.sessionId);
    expect.soft(after?.assignmentId).toBe(initial.value.assignmentId);
    expect.soft(after?.bindingGeneration).toBe(initial.value.bindingGeneration);
  });
});

it("1084-R2-01: new driven-holder refusal must terminate its unused provisioned resource", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const { binding: driven } = await drivenPrimary(f, "review-other-driven");
    const projectId = "review-unused-failover";
    const manifest = fixtureManifest(projectId);
    const registered = cp.projects.register({ projectId, name: projectId, manifest, authorization: cp.manifestAuthorizationForTests(manifest) });
    if (!registered.allowed) throw new Error(registered.message);
    const initial = await cp.cto.ensurePrimaryCto(projectId, "fixture");
    if (!initial.allowed) throw new Error(initial.message);
    const start = f.gpt.startSession.bind(f.gpt);
    const stop = vi.spyOn(f.gpt, "stopSession");
    let unused: SessionHandle | null = null;
    vi.spyOn(f.gpt, "startSession").mockImplementationOnce(async (spec) => {
      const moved = cp.bindings.switchTo({ roleKey: initial.value.roleKey, role: Role.PRIMARY_CTO, projectId,
        sessionId: driven.sessionId, mode: "PREFERRED", reason: "concurrent move to driven runtime", conversation: "SURVIVED" });
      if (!moved.allowed) throw new Error(moved.message);
      expect(moved.value.assignmentId).toBe(initial.value.assignmentId);
      expect(moved.value.bindingGeneration).toBe(initial.value.bindingGeneration);
      unused = await start(spec);
      return unused;
    });
    f.loseClaude();
    const refused = await cp.continuity.failover(initial.value.roleKey, Role.PRIMARY_CTO, { projectId }, "concurrent driven runtime");
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.ROLE_RUNTIME_SUBSTITUTION_REFUSED });
    expect(cp.bindings.active(initial.value.roleKey)?.sessionId).toBe(driven.sessionId);
    expect(unused).not.toBeNull();
    const resource = unused! as SessionHandle;
    const row = replacementRow(f, resource);
    const providerHealth = await f.gpt.probeSession(resource);
    expect(row?.lifecycle).toBe(SessionLifecycle.STOPPED);
    expect.soft(stop).toHaveBeenCalledTimes(1);
    expect.soft(providerHealth).toBe("UNAVAILABLE");
  });
});

it("ROUND1-ESCAPE-01: superseded failover must terminate its unused provisioned resource", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const projectId = "review-superseded-resource";
    await registerFixtureProject(f.harness, projectId);
    const initial = await cp.cto.ensurePrimaryCto(projectId, "fixture");
    if (!initial.allowed) throw new Error(initial.message);
    const winner = cp.sessions.create({ provider: "scripted", model: "concurrent-cto" });
    cp.sessions.transition(winner.sessionId, SessionLifecycle.READY, "fixture concurrent holder");
    const start = f.gpt.startSession.bind(f.gpt);
    const stop = vi.spyOn(f.gpt, "stopSession");
    let unused: SessionHandle | null = null;
    vi.spyOn(f.gpt, "startSession").mockImplementationOnce(async (spec) => {
      expect(cp.bindings.revoke(initial.value.roleKey, "fixture concurrent replacement").allowed).toBe(true);
      const bound = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: winner.sessionId });
      if (!bound.allowed) throw new Error(bound.message);
      unused = await start(spec);
      return unused;
    });
    f.loseClaude();
    const refused = await cp.continuity.failover(initial.value.roleKey, Role.PRIMARY_CTO, { projectId }, "fixture superseded");
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    expect(cp.bindings.active(initial.value.roleKey)?.sessionId).toBe(winner.sessionId);
    expect(unused).not.toBeNull();
    const resource = unused! as SessionHandle;
    const row = replacementRow(f, resource);
    const providerHealth = await f.gpt.probeSession(resource);
    expect(row?.lifecycle).toBe(SessionLifecycle.STOPPED);
    expect.soft(stop).toHaveBeenCalledTimes(1);
    expect.soft(providerHealth).toBe("UNAVAILABLE");
  });
});

it("switch-rejected: a holder moved at the switch's own write boundary is kept, and the replacement is stopped", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const projectId = "review-switch-rejected";
    await registerFixtureProject(f.harness, projectId);
    const initial = await cp.cto.ensurePrimaryCto(projectId, "fixture");
    if (!initial.allowed) throw new Error(initial.message);
    const other = cp.sessions.create({ provider: "scripted", model: "concurrent-cto" });
    cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "fixture concurrent runtime");
    const start = f.gpt.startSession.bind(f.gpt);
    const stop = vi.spyOn(f.gpt, "stopSession");
    let unused: SessionHandle | null = null;
    vi.spyOn(f.gpt, "startSession").mockImplementationOnce(async (spec) => {
      unused = await start(spec);
      return unused;
    });
    // The holder survives onto another runtime in the instant before the failover's own switch.
    const switchTo = cp.bindings.switchTo.bind(cp.bindings);
    vi.spyOn(cp.bindings, "switchTo").mockImplementationOnce((input) => {
      const moved = switchTo({ roleKey: initial.value.roleKey, role: Role.PRIMARY_CTO, projectId,
        sessionId: other.sessionId, mode: "PREFERRED", reason: "concurrent surviving move", conversation: "SURVIVED" });
      if (!moved.allowed) throw new Error(moved.message);
      return switchTo(input);
    });
    f.loseClaude();
    const refused = await cp.continuity.failover(initial.value.roleKey, Role.PRIMARY_CTO, { projectId }, "fixture switch boundary");
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    const after = cp.bindings.active(initial.value.roleKey);
    expect(after).toMatchObject({ assignmentId: initial.value.assignmentId, sessionId: other.sessionId });
    expect(unused).not.toBeNull();
    const resource = unused! as SessionHandle;
    expect(replacementRow(f, resource)?.lifecycle).toBe(SessionLifecycle.STOPPED);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await f.gpt.probeSession(resource)).toBe("UNAVAILABLE");
    // The concurrent holder was not the stop's target.
    expect(cp.sessions.require(other.sessionId).lifecycle).toBe(SessionLifecycle.READY);
  });
});

it("a replacement whose provider stop fails is recorded remaining, never STOPPED", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const projectId = "review-replacement-stop-failed";
    await registerFixtureProject(f.harness, projectId);
    const initial = await cp.cto.ensurePrimaryCto(projectId, "fixture");
    if (!initial.allowed) throw new Error(initial.message);
    const winner = cp.sessions.create({ provider: "scripted", model: "concurrent-cto" });
    cp.sessions.transition(winner.sessionId, SessionLifecycle.READY, "fixture concurrent holder");
    const start = f.gpt.startSession.bind(f.gpt);
    vi.spyOn(f.gpt, "stopSession").mockRejectedValueOnce(new Error("fixture provider stop failure"));
    let unused: SessionHandle | null = null;
    vi.spyOn(f.gpt, "startSession").mockImplementationOnce(async (spec) => {
      expect(cp.bindings.revoke(initial.value.roleKey, "fixture concurrent replacement").allowed).toBe(true);
      const bound = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: winner.sessionId });
      if (!bound.allowed) throw new Error(bound.message);
      unused = await start(spec);
      return unused;
    });
    f.loseClaude();
    expect((await cp.continuity.failover(initial.value.roleKey, Role.PRIMARY_CTO, { projectId }, "fixture stop failure")).allowed).toBe(false);
    const row = replacementRow(f, unused! as SessionHandle)!;
    expect(row.lifecycle).toBe(SessionLifecycle.ERROR);
    expect(cp.db.all<{ outcome: string }>(
      `SELECT json_extract(evidence_json, '$.outcome') AS outcome FROM audit_events
        WHERE kind = 'CONTINUITY_REPLACEMENT_CLEANUP' AND session_id = ?`,
      [row.session_id],
    ).map((r) => r.outcome)).toEqual(["REMAINING_STOP_FAILED"]);
  });
});

it("a replacement being retired cannot be adopted while its stop is pending", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const projectId = "review-replacement-reserved";
    await registerFixtureProject(f.harness, projectId);
    const initial = await cp.cto.ensurePrimaryCto(projectId, "fixture");
    if (!initial.allowed) throw new Error(initial.message);
    const winner = cp.sessions.create({ provider: "scripted", model: "concurrent-cto" });
    cp.sessions.transition(winner.sessionId, SessionLifecycle.READY, "fixture concurrent holder");
    const start = f.gpt.startSession.bind(f.gpt);
    let unused: SessionHandle | null = null;
    vi.spyOn(f.gpt, "startSession").mockImplementationOnce(async (spec) => {
      expect(cp.bindings.revoke(initial.value.roleKey, "fixture concurrent replacement").allowed).toBe(true);
      const bound = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: winner.sessionId });
      if (!bound.allowed) throw new Error(bound.message);
      unused = await start(spec);
      return unused;
    });
    // While the replacement's stop is pending, the winner gives the role up and the replacement is offered it.
    const stop = f.gpt.stopSession.bind(f.gpt);
    let adoptedDuringStop: boolean | null = null;
    vi.spyOn(f.gpt, "stopSession").mockImplementationOnce(async (handle) => {
      const row = replacementRow(f, unused! as SessionHandle)!;
      expect(cp.bindings.revoke(initial.value.roleKey, "fixture winner gives up").allowed).toBe(true);
      adoptedDuringStop = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: row.session_id }).allowed;
      return stop(handle);
    });
    f.loseClaude();
    expect((await cp.continuity.failover(initial.value.roleKey, Role.PRIMARY_CTO, { projectId }, "fixture reserved")).allowed).toBe(false);
    expect(adoptedDuringStop).toBe(false);
    expect(cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM assignments a JOIN sessions s ON s.session_id = a.session_id
        WHERE a.status = 'ACTIVE' AND s.lifecycle = 'STOPPED'`,
    )?.n).toBe(0);
  });
});

it("a replacement that came to hold a role before its retirement is left running and recorded unverified", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const projectId = "review-replacement-holds";
    await registerFixtureProject(f.harness, projectId);
    const initial = await cp.cto.ensurePrimaryCto(projectId, "fixture");
    if (!initial.allowed) throw new Error(initial.message);
    const start = f.gpt.startSession.bind(f.gpt);
    const stop = vi.spyOn(f.gpt, "stopSession");
    let unused: SessionHandle | null = null;
    vi.spyOn(f.gpt, "startSession").mockImplementationOnce(async (spec) => {
      unused = await start(spec);
      return unused;
    });
    // At the switch boundary the replacement is made the role's holder by another path first.
    const switchTo = cp.bindings.switchTo.bind(cp.bindings);
    vi.spyOn(cp.bindings, "switchTo").mockImplementationOnce((input) => {
      expect(cp.bindings.revoke(initial.value.roleKey, "fixture released at the boundary").allowed).toBe(true);
      const held = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: input.sessionId });
      if (!held.allowed) throw new Error(held.message);
      return switchTo(input);
    });
    f.loseClaude();
    expect((await cp.continuity.failover(initial.value.roleKey, Role.PRIMARY_CTO, { projectId }, "fixture holds")).allowed).toBe(false);
    const row = replacementRow(f, unused! as SessionHandle)!;
    expect(stop).not.toHaveBeenCalled();
    expect(row.lifecycle).toBe(SessionLifecycle.READY);
    expect(cp.bindings.active(initial.value.roleKey)?.sessionId).toBe(row.session_id);
    expect(cp.db.all<{ outcome: string }>(
      `SELECT json_extract(evidence_json, '$.outcome') AS outcome FROM audit_events
        WHERE kind = 'CONTINUITY_REPLACEMENT_CLEANUP' AND session_id = ?`,
      [row.session_id],
    ).map((r) => r.outcome)).toEqual(["REMAINING_OWNERSHIP_UNVERIFIED"]);
  });
});

it("1084-R1-04 final await: a holder moved during provisioning is refused before any switch is attempted", async () => {
  await withBootstrapRuntime(async (f) => {
    const cp = f.harness.cp;
    const projectId = "review-final-no-switch";
    await registerFixtureProject(f.harness, projectId);
    const initial = await cp.cto.ensurePrimaryCto(projectId, "fixture");
    if (!initial.allowed) throw new Error(initial.message);
    const other = cp.sessions.create({ provider: "scripted", model: "concurrent-cto" });
    cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "fixture concurrent runtime");
    const switches = vi.spyOn(cp.bindings, "switchTo");
    const start = f.gpt.startSession.bind(f.gpt);
    vi.spyOn(f.gpt, "startSession").mockImplementationOnce(async (spec) => {
      const moved = cp.bindings.switchTo({ roleKey: initial.value.roleKey, role: Role.PRIMARY_CTO, projectId,
        sessionId: other.sessionId, mode: "PREFERRED", reason: "concurrent surviving move", conversation: "SURVIVED" });
      if (!moved.allowed) throw new Error(moved.message);
      return start(spec);
    });
    f.loseClaude();
    const result = await cp.continuity.failover(initial.value.roleKey, Role.PRIMARY_CTO, { projectId }, "fixture final await");
    expect(result).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
    // The only switch was the concurrent move: the failover refused on the whole holder before its own.
    expect(switches).toHaveBeenCalledTimes(1);
  });
});

