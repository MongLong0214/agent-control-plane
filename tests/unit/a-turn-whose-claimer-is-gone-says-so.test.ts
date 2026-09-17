import { afterAll, describe, expect, it } from "vitest";

import { IngressGuard, type TurnIdentity } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #631 — `unresolvedTurns` answers "no outcome was ever recorded", and two different facts wear
 * that one word: a turn still running has no outcome yet, and neither does one whose process died
 * holding it. The owner acts on the difference — wait, or send `/again` — and the park reply told
 * them only "ACP does not know whether any of those reached the CEO", which is the same sentence
 * for both.
 *
 * Only one of the two is provable from a row, and these rows pin that asymmetry rather than the
 * convenient version of it. A claim naming a *different* process incarnation was taken by a
 * process that no longer exists (this deployment holds one `agentcpd.lock` at a time), so no
 * outcome can arrive for it on its own. A claim naming *this* process proves nothing either way:
 * the handler may be running, or may have thrown already, and both leave an identical row.
 */
const guardFor = (harness: ReturnType<typeof makeHarness>, incarnation: string) =>
  new IngressGuard(
    harness.cp.db,
    harness.cp.clock,
    harness.cp.audit,
    {
      telegram: {
        allowedActors: ["owner"],
        allowedConversations: ["chat"],
        recoverInFlight: true,
      },
    },
    { claimProcessIncarnation: incarnation },
  );

const identity = (): TurnIdentity => ({
  turnRequestId: "turn-1",
  sessionDigest: "session-digest",
  promptDigest: "prompt-digest",
  bindingDigest: "binding-digest",
});

const admit = (guard: IngressGuard, nonce: string) =>
  guard.admit({
    channel: "telegram",
    actor: "owner",
    conversation: "chat",
    nonce,
    payload: { text: "배포 상태 알려줘" },
  });

describe("an unresolved turn says whether its claimer is gone", () => {
  it("reports a claim from another process incarnation as one that cannot resolve itself", () => {
    const harness = makeHarness();
    const dead = guardFor(harness, "4321#2026-09-17T20:00:00.000Z");
    expect(admit(dead, "update:1").allowed).toBe(true);
    expect(dead.claimTurn("telegram", "update:1", identity()).allowed).toBe(true);

    // The restart. A second incarnation over the same database is exactly what the next daemon
    // sees, and it is the shape a unit test cannot make by forking a real second daemon.
    const live = guardFor(harness, "8765#2026-09-17T22:08:14.046Z");
    const unresolved = live.unresolvedTurns("telegram", "session-digest");

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.claimerProcessGone).toBe(true);
  });

  it("does not claim the converse for a turn this process holds", () => {
    const harness = makeHarness();
    const live = guardFor(harness, "8765#2026-09-17T22:08:14.046Z");
    expect(admit(live, "update:2").allowed).toBe(true);
    expect(live.claimTurn("telegram", "update:2", identity()).allowed).toBe(true);

    // Still listed — it is unresolved, and that has not changed. What must not happen is this
    // row reading as "live": a handler that threw in this process leaves a byte-identical claim,
    // so the only honest answer here is the unknown one the park reply already gave.
    const unresolved = live.unresolvedTurns("telegram", "session-digest");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.claimerProcessGone).toBe(false);
  });

  it("treats a claim written before the field existed as unknown, not as a dead claimer", () => {
    const harness = makeHarness();
    const live = guardFor(harness, "8765#2026-09-17T22:08:14.046Z");
    expect(admit(live, "update:3").allowed).toBe(true);

    // A row from a build older than `claimedByProcess`. `prune` never removes an unresolved
    // claim, so such rows do not age out and one will be read by a build that has the field.
    harness.cp.db.run(
      `UPDATE inbound_messages SET turn_claim_json = ? WHERE channel = 'telegram' AND nonce = ?`,
      [
        JSON.stringify({ deliveryStatus: "TURN_CLAIMED", ...identity() }),
        "update:3",
      ],
    );

    const unresolved = live.unresolvedTurns("telegram", "session-digest");
    expect(unresolved).toHaveLength(1);
    // Absence of the field is absence of evidence about the claimer. Reading it as "gone" would
    // tell the owner an outcome can never arrive for a message that may have been answered.
    expect(unresolved[0]?.claimerProcessGone).toBe(false);
  });
});
