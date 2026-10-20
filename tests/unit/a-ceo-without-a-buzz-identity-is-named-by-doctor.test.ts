import { afterAll, describe, expect, it } from "vitest";

import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1112. A CEO whose live runtime carries no `sessions.buzz_actor_id` has every CEO->CTO peer
 * mention refused (`buzzPeerRegistry.currentCeo` answers a null identity), and before this nothing
 * but the subscriber's rejection counters said so. Doctor now names the condition, the session and
 * the generation, so it is visible before anyone goes looking for why mentions vanish.
 */
const CODE = "CEO_BUZZ_IDENTITY_UNBOUND";

const findingsOf = async (harness: ReturnType<typeof makeHarness>, scope: "system" | "cto" = "system") =>
  (await harness.cp.doctor.run(scope)).findings;

describe("a CEO session with no Buzz identity bound is named by doctor (#1112)", () => {
  it("names the CEO's live runtime when its buzz_actor_id is NULL", async () => {
    const harness = makeHarness();
    const sessionId = bindCeo(harness);
    expect(harness.cp.sessions.get(sessionId)?.buzzActorId).toBeNull();
    const generation = harness.cp.bindings.active(roleKeyFor(Role.CEO))?.bindingGeneration;

    const report = await harness.cp.doctor.run("system");
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: CODE,
      severity: "WARN",
      blocking: false,
      scope: "global",
      observedEvidence: expect.objectContaining({ sessionId, bindingGeneration: generation, buzzActorId: null }),
    }));
    // A non-blocking WARN (asserted above): it degrades the report and never parks the daemon.
    // The same check runs wherever the CEO_ROLE_UNBOUND check runs.
    expect(await findingsOf(harness, "cto")).toContainEqual(expect.objectContaining({ code: CODE }));
  });

  it("names the official recovery: buzz_actor_bind, the signed answer, and the readback that completes it", async () => {
    const harness = makeHarness();
    const sessionId = bindCeo(harness);

    const finding = (await findingsOf(harness)).find((f) => f.code === CODE);
    expect(finding).toBeDefined();
    // Severity and blocking state are unchanged by naming the action.
    expect(finding).toMatchObject({ severity: "WARN", blocking: false });
    expect(finding?.observedEvidence["recovery"]).toEqual({
      tool: "buzz_actor_bind",
      caller: "CEO",
      argument: "actor: the CEO's own Buzz actor",
      challengeValidForMs: 10 * 60 * 1000,
      answer: "a Buzz mention of the CTO carrying the challenge, signed with that actor's key",
      completion: "the signed answer accepted and a readback of the current canonical CEO binding's runtime showing its buzz_actor_id; a challenge alone is not completion",
    });
    const text = finding?.recommendedAction ?? "";
    expect(text).toMatch(/^the CEO runs buzz_actor_bind with its own Buzz actor to get a one-time challenge \(valid 10 minutes\)/);
    expect(text).toContain("posts it in a Buzz mention of the CTO signed with that actor's key");
    expect(text).toContain("a readback of the current canonical CEO binding's runtime shows its buzz_actor_id");
    expect(text).toContain("issuing a challenge alone binds nothing");
    // Doctor names the action and performs none of it: the runtime is still unbound.
    expect(harness.cp.sessions.get(sessionId)?.buzzActorId).toBeNull();
  });

  it("stays quiet once the CEO's runtime carries a Buzz identity", async () => {
    const harness = makeHarness();
    const sessionId = bindCeo(harness);
    harness.cp.db.run(`UPDATE sessions SET buzz_actor_id = ? WHERE session_id = ?`, ["a".repeat(64), sessionId]);
    expect(harness.cp.sessions.get(sessionId)?.buzzActorId).toBe("a".repeat(64));

    expect(await findingsOf(harness)).not.toContainEqual(expect.objectContaining({ code: CODE }));
  });

  it("resolves the previous CEO identity when a new generation has none", async () => {
    const harness = makeHarness();
    const previous = bindCeo(harness);
    harness.cp.db.run(`UPDATE sessions SET buzz_actor_id = ? WHERE session_id = ?`, ["a".repeat(64), previous]);
    expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "rotation").allowed).toBe(true);
    const current = bindCeo(harness);
    expect(current).not.toBe(previous);
    expect(harness.cp.sessions.get(current)?.buzzActorId).toBeNull();
    expect(await findingsOf(harness)).not.toContainEqual(expect.objectContaining({ code: CODE }));
  });

  it("stays quiet with no CEO bound: that state is CEO_ROLE_UNBOUND's, not this one's", async () => {
    const harness = makeHarness();
    const findings = await findingsOf(harness);
    expect(findings).toContainEqual(expect.objectContaining({ code: "CEO_ROLE_UNBOUND" }));
    expect(findings).not.toContainEqual(expect.objectContaining({ code: CODE }));
  });

  it("stays quiet when the CEO's runtime is not live: a dead runtime is a different repair", async () => {
    const harness = makeHarness();
    const sessionId = bindCeo(harness);
    harness.cp.sessions.transition(sessionId, SessionLifecycle.STOPPED, "test");

    expect(await findingsOf(harness)).not.toContainEqual(expect.objectContaining({ code: CODE }));
  });
});
