import { afterAll, describe, expect, it } from "vitest";

import {
  IngressGuard,
  processIncarnationForClaims,
  type TurnIdentity,
} from "../../src/ingress/ingress-guard.ts";
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
/** The production constructor — no injected incarnation, so it takes the process's own. */
const productionGuardFor = (harness: ReturnType<typeof makeHarness>) =>
  new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    telegram: {
      allowedActors: ["owner"],
      allowedConversations: ["chat"],
      recoverInFlight: true,
    },
  });

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

  it("gives every guard in one process the same incarnation", () => {
    // Measured: the first version computed this per construction, from
    // `Date.now() - process.uptime() * 1000`. Those are two clocks with sub-millisecond drift, so
    // the reconstructed start instant lands on either side of a millisecond boundary — 5,000 reads
    // in one process produced **two** distinct values, five times out of five. A daemon builds
    // more than one guard (the Telegram listener's and the Buzz ingress's), so each read the
    // other's claims as taken by a process that is gone: the fail-open direction, a live turn
    // reported as one whose claimer can never answer.
    //
    // Probed rather than sampled twice, deliberately. Two back-to-back constructions land in the
    // same millisecond and the broken version passes that check every time — measured, six runs
    // out of six. What separates the two implementations is stability *across* the boundary.
    const readings = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) readings.add(processIncarnationForClaims());
    expect(
      readings.size,
      "the incarnation a claim records must not depend on when it is read",
    ).toBe(1);

    // And the consequence that motivates it, through the product: two guards, one process, one
    // answer about whose claim it is.
    const harness = makeHarness();
    const first = productionGuardFor(harness);
    const second = productionGuardFor(harness);
    expect(admit(first, "update:4").allowed).toBe(true);
    expect(first.claimTurn("telegram", "update:4", identity()).allowed).toBe(true);

    const throughSecond = second.unresolvedTurns("telegram", "session-digest");
    expect(throughSecond).toHaveLength(1);
    expect(
      throughSecond[0]?.claimerProcessGone,
      "a second guard in the same process must not read the first's claim as abandoned",
    ).toBe(false);
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
