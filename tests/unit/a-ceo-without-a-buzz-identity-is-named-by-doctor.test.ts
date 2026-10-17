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

  it("stays quiet once the CEO's runtime carries a Buzz identity", async () => {
    const harness = makeHarness();
    const sessionId = bindCeo(harness);
    harness.cp.db.run(`UPDATE sessions SET buzz_actor_id = ? WHERE session_id = ?`, ["a".repeat(64), sessionId]);
    expect(harness.cp.sessions.get(sessionId)?.buzzActorId).toBe("a".repeat(64));

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
