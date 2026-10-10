import { afterAll, afterEach, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { registerFixtureProject } from "../helpers/harness.ts";

/**
 * #246 PR-C C4-R2 — review 2 of the recovery slice: a failover replaces only the exact holder it
 * decided to replace, at every await and at the switch itself, and a replacement it provisioned and
 * does not use is stopped through the provider, never only marked STOPPED. The first three are the
 * review's reproductions with only their harness adapted (no review-tree output files).
 */
afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

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
