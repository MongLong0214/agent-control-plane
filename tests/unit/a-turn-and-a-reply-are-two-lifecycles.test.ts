import { afterAll, describe, expect, it } from "vitest";

import { IngressGuard, TURN_CLAIMED, type TurnIdentity } from "../../src/ingress/ingress-guard.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The ordinary timeout, which is the common case and the one nothing covered.
 *
 * The claim and this Telegram message's reply-delivery state shared `result_json`. The reply
 * reservation writes that field whole, and its precondition — "not PENDING and not APPLIED" —
 * treats a claimed turn as a free slot. So:
 *
 *     crash before a reply is produced   the claim survives     ← what the tests covered
 *     an ordinary timeout                a reply IS produced
 *                                        the reservation overwrites it
 *                                        the claim and the turn identity are gone
 *
 * A measured turn is 3m15s against a 120s inner deadline, so the second is not the rare path. The
 * fail-closed state was present exactly where it was tested and absent where it is needed.
 *
 * The tests missed it because they called `claimTurn` on the guard, and the reservation lives in
 * the router, after the handler returns — the guard-level test proved the guard and said nothing
 * about the path. These go through the reply lifecycle rather than around it.
 */
const guardFor = (harness: ReturnType<typeof makeHarness>) =>
  new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    telegram: {
      allowedActors: ["owner"],
      allowedConversations: ["chat"],
      recoverInFlight: true,
    },
  });

const identity = (turnRequestId = "turn-1"): TurnIdentity => ({
  turnRequestId,
  sessionDigest: "session-digest",
  promptDigest: "prompt-digest",
  bindingDigest: "binding-digest",
});

const admitOne = (guard: IngressGuard, nonce: string) =>
  guard.admit({
    channel: "telegram",
    actor: "owner",
    conversation: "chat",
    nonce,
    payload: { text: "어떻게 돼가?" },
  });

/** What the router does after a handler returns a reply: reserve, send, complete. */
const reserve = (guard: IngressGuard, nonce: string) =>
  guard.recordResultIf(
    "telegram",
    nonce,
    { kind: "TELEGRAM_WORKFLOW", phase: "REPLIED", reply: "답", sent: false, deliveryStatus: "PENDING" },
    "AVAILABLE",
  );

const complete = (guard: IngressGuard, nonce: string) =>
  guard.recordResultIf(
    "telegram",
    nonce,
    { kind: "TELEGRAM_WORKFLOW", phase: "REPLIED", reply: "답", sent: true, deliveryStatus: "APPLIED" },
    "PENDING",
  );

const storedClaim = (harness: ReturnType<typeof makeHarness>, nonce: string) =>
  harness.cp.db.get<{ turn_claim_json: string | null }>(
    "SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?",
    [nonce],
  )?.turn_claim_json;

describe("a reply moving through its lifecycle does not take the turn's with it", () => {
  it("keeps the claim and its identity when a reply is reserved", () => {
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n1");
    expect(guard.claimTurn("telegram", "n1", identity("turn-xyz")).allowed).toBe(true);

    expect(reserve(guard, "n1").allowed).toBe(true);

    // The exact assertion the old storage could not make: the claim is still there afterwards.
    const claim = JSON.parse(storedClaim(harness, "n1") ?? "{}") as Record<string, unknown>;
    expect(claim.deliveryStatus).toBe(TURN_CLAIMED);
    expect(claim.turnRequestId).toBe("turn-xyz");
    expect(guard.unresolvedTurns("telegram", "session-digest").map((t) => t.nonce)).toEqual(["n1"]);
  });

  it("still reports an unknown outcome after a reply was reserved and never sent", () => {
    // The state a timeout leaves when the send never lands: a reply reserved, a turn nobody
    // resolved. Re-admitting must refuse — the handler may already have spoken to the CEO.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n1");
    guard.claimTurn("telegram", "n1", identity());
    reserve(guard, "n1");

    const again = admitOne(guard, "n1");

    expect(again.allowed).toBe(false);
    expect(again.reasonCode).toBe(ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN);
  });

  it("resolves the turn when the transport accepts the reply, so a replay is an ordinary replay", () => {
    // The other half, and #651's warning: with the claim surviving, something has to clear it or a
    // finished turn reports an unknown outcome forever. What clears it is the one thing ACP can
    // observe — the transport accepted the reply.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n1");
    guard.claimTurn("telegram", "n1", identity());
    reserve(guard, "n1");
    expect(complete(guard, "n1").allowed).toBe(true);
    expect(guard.resolveTurn("telegram", "n1").allowed).toBe(true);

    const replay = admitOne(guard, "n1");

    expect(replay.allowed).toBe(false);
    expect(replay.reasonCode).toBe(ReasonCode.INGRESS_REPLAY_IGNORED);
    expect(guard.unresolvedTurns("telegram", "session-digest")).toEqual([]);
    // And the identity is still in the row, because a receipt has to be matched against something
    // when one exists (#638). Resolving is not forgetting.
    expect(
      (JSON.parse(storedClaim(harness, "n1") ?? "{}") as { turnRequestId?: string }).turnRequestId,
    ).toBe("turn-1");
  });

  it("resolves the turn in the same transaction that records the reply", () => {
    // A review found the window: the process commits APPLIED, crashes, and on restart
    // `completeResponse` sees APPLIED and returns before it ever resolves the turn. The claim is
    // then outstanding forever — re-admission is refused as an unknown outcome and pruning
    // preserves the row, so a finished turn holds the nonce.
    //
    // Any ordering of two commits has that window, so they are one commit.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n1");
    guard.claimTurn("telegram", "n1", identity());
    reserve(guard, "n1");

    const done = guard.completeReplyAndResolveTurn("telegram", "n1", {
      kind: "TELEGRAM_WORKFLOW",
      phase: "REPLIED",
      reply: "답",
      sent: true,
      deliveryStatus: "APPLIED",
    });

    expect(done.allowed).toBe(true);
    expect(
      (JSON.parse(storedClaim(harness, "n1") ?? "{}") as { repliedAt?: string }).repliedAt,
    ).toBe(harness.clock.nowIso());
    expect(guard.unresolvedTurns("telegram", "session-digest")).toEqual([]);
  });

  it("leaves the claim outstanding when the reply transition is refused", () => {
    // The other half of one transaction: a completion that cannot happen must not resolve the turn
    // either. Without a reservation the APPLIED transition is refused, and the claim has to stay.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n1");
    guard.claimTurn("telegram", "n1", identity());

    const refused = guard.completeReplyAndResolveTurn("telegram", "n1", {
      kind: "TELEGRAM_WORKFLOW",
      phase: "REPLIED",
      reply: "답",
      sent: true,
      deliveryStatus: "APPLIED",
    });

    expect(refused.allowed).toBe(false);
    expect(
      (JSON.parse(storedClaim(harness, "n1") ?? "{}") as { repliedAt?: string }).repliedAt,
    ).toBeUndefined();
    expect(guard.unresolvedTurns("telegram", "session-digest").map((t) => t.nonce)).toEqual(["n1"]);
  });

  it("is a no-op for a message that never claimed a turn", () => {
    // The ordinary non-CEO path: a handler that only formats a reply. Nothing to resolve, and a
    // refusal here would make every such message fail.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n1");
    reserve(guard, "n1");

    expect(guard.resolveTurn("telegram", "n1").allowed).toBe(true);
    expect(storedClaim(harness, "n1")).toBeNull();
  });

  it("does not resolve a turn twice, so the first reply is the one recorded", () => {
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n1");
    guard.claimTurn("telegram", "n1", identity());
    reserve(guard, "n1");
    complete(guard, "n1");
    guard.resolveTurn("telegram", "n1");
    const first = (JSON.parse(storedClaim(harness, "n1") ?? "{}") as { repliedAt?: string }).repliedAt;

    harness.clock.advance(60_000);
    guard.resolveTurn("telegram", "n1");

    expect(
      (JSON.parse(storedClaim(harness, "n1") ?? "{}") as { repliedAt?: string }).repliedAt,
    ).toBe(first);
  });
});
