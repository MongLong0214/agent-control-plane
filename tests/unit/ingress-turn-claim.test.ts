import { afterAll, describe, expect, it } from "vitest";

import { IngressGuard, TURN_CLAIMED, type TurnIdentity } from "../../src/ingress/ingress-guard.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * A handler that only produced a reply could be re-run after a crash for free, and the ingress
 * recovery path is built on that. The Telegram DIRECT handler stopped being one when it became a
 * CEO turn: its reply command resumes the owner's own conversation, so a second run appends the
 * same exchange twice to a transcript that is then carried forward as context.
 *
 * So the right to run is taken once, and the compare-and-set is the whole mechanism — an
 * unconditional write would let two claimers both proceed, which is the case it exists to refuse.
 */
const guardFor = (harness: ReturnType<typeof makeHarness>) =>
  new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    telegram: {
      allowedActors: ["owner"],
      allowedConversations: ["chat"],
      recoverInFlight: true,
    },
  });

/** A fixed identity, so a test that cares about the claim is not also testing UUID generation. */
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

describe("taking the right to run a message's handler", () => {
  it("succeeds once and refuses the second claimer", () => {
    const harness = makeHarness();
    const guard = guardFor(harness);
    expect(admitOne(guard, "n1").allowed).toBe(true);

    const first = guard.claimTurn("telegram", "n1", identity());
    const second = guard.claimTurn("telegram", "n1", identity());

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.reasonCode).toBe(ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN);
  });

  it("refuses a claim on a message that was never admitted", () => {
    // Claiming a row that does not exist would write nothing and, on an unconditional update,
    // report success — a handler would then run for a message the guard never let in.
    const harness = makeHarness();

    const claimed = guardFor(harness).claimTurn("telegram", "never-seen", identity());

    expect(claimed.allowed).toBe(false);
    expect(claimed.reasonCode).toBe(ReasonCode.NOT_FOUND);
  });

  it("stops the recovery path from re-admitting a claimed message", () => {
    // This is the property the claim exists for. `recoverInFlight` re-admits an update whose
    // workflow is still ADMITTED; once claimed it must not, or the handler runs again.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n2");
    expect(guard.claimTurn("telegram", "n2", identity()).allowed).toBe(true);

    const replayed = admitOne(guard, "n2");

    expect(replayed.allowed).toBe(false);
    // Not INGRESS_REPLAY_IGNORED. A replay means the work was done and this copy is redundant;
    // this means nobody knows whether it was, and the two need different responses.
    expect(replayed.reasonCode).toBe(ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN);
  });

  it("records the unknown outcome in the audit log rather than only refusing", () => {
    // A refusal the caller may swallow is not a record. This is the one state that needs a
    // person, so it has to be visible after the fact without replaying the process.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n3");
    guard.claimTurn("telegram", "n3", identity());

    admitOne(guard, "n3");

    const events = harness.cp.audit.all().filter((event) => event.kind === "INGRESS_TURN_OUTCOME_UNKNOWN");
    expect(events).toHaveLength(1);
    expect(events[0]?.evidence).toMatchObject({ channel: "telegram", nonce: "n3" });
  });

  it("names the claimed state so a reader can tell it from a delivery status", () => {
    expect(TURN_CLAIMED).toBe("TURN_CLAIMED");
  });
});

describe("what the claim carries", () => {
  /**
   * The identity is written in the same statement as the claim. Nothing reads it yet — the reply
   * command has no argument that would carry the id to Hermes, and no receipt comes back (#638).
   *
   * What can be established now is that it survives, which is the floor the later comparison
   * stands on: a comparison against an id that drifts fails always, and its failure cannot be
   * told apart from a missing receipt.
   */
  const storedClaim = (harness: ReturnType<typeof makeHarness>, nonce: string): Record<string, unknown> => {
    // `turn_claim_json`, not `result_json`. The claim used to share a field with this message's
    // reply-delivery lifecycle, and the reply's advanced and took the turn's with it (#646).
    const row = harness.cp.db.get<{ turn_claim_json: string | null }>(
      "SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?",
      [nonce],
    );
    return JSON.parse(row?.turn_claim_json ?? "{}") as Record<string, unknown>;
  };

  it("stores the identity in the same row as the claim", () => {
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n10");

    const claimed = guard.claimTurn("telegram", "n10", identity("turn-abc"));

    expect(claimed.allowed).toBe(true);
    expect(storedClaim(harness, "n10")).toMatchObject({
      deliveryStatus: TURN_CLAIMED,
      turnRequestId: "turn-abc",
      sessionDigest: "session-digest",
      promptDigest: "prompt-digest",
      bindingDigest: "binding-digest",
    });
  });

  it("keeps it byte-identical when the row is read back by a new guard", () => {
    // The reader after a crash is a different process against the same file. This is the
    // property #639's later comparison depends on, and the only one observable before #638.
    const harness = makeHarness();
    admitOne(guardFor(harness), "n11");
    guardFor(harness).claimTurn("telegram", "n11", identity("turn-xyz"));

    const first = storedClaim(harness, "n11");
    const second = storedClaim(harness, "n11");

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second["turnRequestId"]).toBe("turn-xyz");
  });

  it("does not let a second claim overwrite the first one's identity", () => {
    // The refusal already returns OUTCOME_UNKNOWN. What matters here is that the stored identity
    // is still the one whose handler may have run — overwriting it would point a later receipt
    // match at an attempt that never happened.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n12");
    guard.claimTurn("telegram", "n12", identity("first"));

    guard.claimTurn("telegram", "n12", identity("second"));

    expect(storedClaim(harness, "n12")["turnRequestId"]).toBe("first");
  });
});

describe("expiry of the nonce window", () => {
  /**
   * The row is aged directly rather than by shortening the TTL. A TTL small enough to expire the
   * row also expires it inside the same `admit` that inserted it — `prune` runs after the insert
   * — so the claim under test never gets a row to claim, and the test would pass for the wrong
   * reason. Ageing the row states what the test is about.
   */
  const age = (harness: ReturnType<typeof makeHarness>, nonce: string): void => {
    harness.cp.db.run(
      "UPDATE inbound_messages SET received_at = ? WHERE channel = 'telegram' AND nonce = ?",
      ["2000-01-01T00:00:00.000Z", nonce],
    );
  };

  it("does not delete a turn whose outcome is unknown", () => {
    // The window exists so a replay of old traffic is refused cheaply. A claimed row is not old
    // traffic: it is the only record that a handler may already have run, and deleting it frees
    // the nonce — so the fail-closed state becomes fail-open after nonceTtlMs, and the replay
    // executes the turn a second time. Found by a blind review of this design.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n20");
    expect(guard.claimTurn("telegram", "n20", identity()).allowed).toBe(true);
    age(harness, "n20");

    // Any later admission runs the prune.
    admitOne(guard, "n21");

    const replayed = admitOne(guard, "n20");
    expect(replayed.allowed, "a pruned claim would be admitted and run again").toBe(false);
    expect(replayed.reasonCode).toBe(ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN);
  });

  it("still expires an ordinary row, so the window has not been disabled", () => {
    // Without this, exempting claimed rows could be widened to exempt everything and nothing
    // here would notice.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "n30");
    age(harness, "n30");

    admitOne(guard, "n31");

    // Re-admitted rather than refused as a replay: the row aged out, which is the point of a TTL.
    expect(admitOne(guard, "n30").allowed).toBe(true);
  });
});

describe("finding an unresolved turn without knowing its nonce", () => {
  /**
   * A claimed turn could only be found by nonce, and the person who needs to find one is the
   * owner — who has an unanswered message, not a nonce. The single state that requires a human
   * was reachable only by someone who already knew where to look.
   *
   * The lookup is by `sessionDigest` because it is already in the claim and is exactly
   * `digestOf({ channel, conversation })`. A second column recording the conversation would be a
   * second definition of "the same conversation", free to disagree with the first.
   */
  const claimOne = (guard: IngressGuard, nonce: string, session: string, id: string): void => {
    admitOne(guard, nonce);
    guard.claimTurn("telegram", nonce, { ...identity(id), sessionDigest: session });
  };

  it("returns the turns of that conversation and not another's", () => {
    const harness = makeHarness();
    const guard = guardFor(harness);
    claimOne(guard, "a1", "chat-A", "turn-a1");
    claimOne(guard, "b1", "chat-B", "turn-b1");

    const outstanding = guard.unresolvedTurns("telegram", "chat-A");

    expect(outstanding.map((turn) => turn.turnRequestId)).toEqual(["turn-a1"]);
  });

  it("carries the nonce and the prompt digest, so a reader can say which message it was", () => {
    // A list of ids answers "how many" and nothing else. The owner's question is which of their
    // messages is outstanding, and the digest is what a caller can compare their text against.
    const harness = makeHarness();
    const guard = guardFor(harness);
    claimOne(guard, "a2", "chat-A", "turn-a2");

    const [turn] = guard.unresolvedTurns("telegram", "chat-A");

    expect(turn?.nonce).toBe("a2");
    expect(turn?.promptDigest).toBe("prompt-digest");
    expect(turn?.receivedAt).toBeTruthy();
  });

  it("does not return a turn that was never claimed", () => {
    // Admitted-and-running is not outstanding, and neither is admitted-and-answered. Returning
    // them would make every message look unresolved and the list would stop meaning anything.
    const harness = makeHarness();
    const guard = guardFor(harness);
    admitOne(guard, "a3");

    expect(guard.unresolvedTurns("telegram", "chat-A")).toEqual([]);
  });

  it("returns the oldest first, because that is the one unanswered longest", () => {
    const harness = makeHarness();
    const guard = guardFor(harness);
    claimOne(guard, "a4", "chat-A", "older");
    harness.cp.db.run(
      "UPDATE inbound_messages SET received_at = ? WHERE nonce = ?",
      ["2000-01-01T00:00:00.000Z", "a4"],
    );
    claimOne(guard, "a5", "chat-A", "newer");

    const outstanding = guard.unresolvedTurns("telegram", "chat-A");

    expect(outstanding.map((turn) => turn.turnRequestId)).toEqual(["older", "newer"]);
  });
});
