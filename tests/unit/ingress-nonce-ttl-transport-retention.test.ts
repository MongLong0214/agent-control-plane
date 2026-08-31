import { afterAll, describe, expect, it } from "vitest";

import { IngressGuard, type IngressPolicy, type TurnIdentity } from "../../src/ingress/ingress-guard.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #673 — a resolved turn's row is pruned after the nonce TTL, so a late redelivery can run the
 * handler again.
 *
 * Measured on the issue (see #673's comments): Telegram's own redelivery window for an
 * unconfirmed long-poll update is bounded by `getUpdates` offset advancement — once ACP's offset
 * passes an `update_id`, Telegram will not send that update again — and by its documented queue
 * retention for updates whose offset never advances (24h). ACP's own clock for `received_at`
 * starts no earlier than Telegram's own creation time, so `received_at + nonceTtlMs >= created_at
 * + retention` whenever `nonceTtlMs >= retention`. At the *default* `nonceTtlMs` (also 24h) that
 * inequality already holds — the defect is that nothing enforces it, so a deployment (or a test)
 * that configures a shorter `nonceTtlMs` opens the window this issue describes, silently.
 *
 * That inequality is not an absolute guarantee (found by review, #682): both timestamps come from
 * the local wall clock (`clock.ts`'s `new Date()` in production), and a forward clock step
 * between admission and a later prune shortens the effective window by the size of the step —
 * `nonce-clock-adjustment-residual.test.ts` demonstrates the mechanism directly, and
 * `TRANSPORT_RETENTION_MS`'s docstring in `ingress-guard.ts` explains why a monotonic clock
 * cannot close it (`received_at` has to survive a daemon restart, which a monotonic value does
 * not). The floor this file tests is still real: it is the relationship between two configured
 * numbers holding regardless of what either is set to, and the residual is a disclosed,
 * clock-adjustment-sized gap, not an unmeasured one.
 */
const identity = (turnRequestId = "turn-1"): TurnIdentity => ({
  turnRequestId,
  sessionDigest: "session-digest",
  promptDigest: "prompt-digest",
  bindingDigest: "binding-digest",
});

describe("#673 the nonce window must not close before the transport's own retention", () => {
  it("refuses to construct a Telegram policy whose nonceTtlMs is shorter than Telegram's redelivery retention", () => {
    const harness = makeHarness();

    expect(
      () =>
        new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
          telegram: {
            allowedActors: ["owner"],
            allowedConversations: ["chat"],
            // Well under 24h — exactly the configuration #673 shows is unsafe.
            nonceTtlMs: 60_000,
          },
        }),
    ).toThrow(/retention/i);
  });

  it("a construction that would have reproduced the exploit is refused before any row exists", () => {
    // This is the exploit #673 describes end to end — resolve, prune, re-admit, claim — reduced
    // to its precondition: it only ever reproduced because nothing refused the too-short
    // `nonceTtlMs` that makes the window reachable. Once the guard above exists, the reproduction
    // cannot even be assembled: the guard itself never comes into being, so there is no row to
    // resolve, no prune to run and no redelivery to accept.
    const harness = makeHarness();

    expect(() => {
      const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
        telegram: { allowedActors: ["owner"], allowedConversations: ["chat"], nonceTtlMs: 1_000, recoverInFlight: true },
      });
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce: "n", payload: {} });
    }).toThrow(/retention/i);
  });

  it("still resolves and still prunes a finished turn once the enforced floor has passed", () => {
    // The floor this issue adds does not stop pruning — `inbound_messages` still has to shrink
    // back down, or every message ever received would sit in it forever (the cost this issue's
    // own "why not just extend the exemption" section rejects). What the floor buys is that this
    // deletion cannot happen until the ttl is at least as long as Telegram's own retention, so a
    // genuine redelivery is refused by Telegram itself before ACP would ever need to refuse it.
    // That external fact is asserted, not exercised here — a unit test cannot drive real
    // Telegram — so this test only proves the half it can: resolving a reply still lands
    // `unresolvedTurns` empty, and ageing the row still lets prune reclaim it, exactly as before
    // the fix. The row is aged directly rather than by advancing 24h of wall-clock, purely so the
    // test does not have to spend that time; see ingress-turn-claim.test.ts for the same idiom.
    const harness = makeHarness();
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      telegram: { allowedActors: ["owner"], allowedConversations: ["chat"], recoverInFlight: true },
    });
    const nonce = "resolved-update";
    const admit = () =>
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce, payload: { text: "hi" } });

    expect(admit().allowed).toBe(true);
    expect(guard.claimTurn("telegram", nonce, identity()).allowed).toBe(true);
    expect(
      guard.recordResultIf(
        "telegram",
        nonce,
        { kind: "TELEGRAM_WORKFLOW", phase: "REPLIED", reply: "answered", sent: false, deliveryStatus: "PENDING" },
        "AVAILABLE",
      ).allowed,
    ).toBe(true);
    expect(
      guard.completeReplyAndResolveTurn("telegram", nonce, {
        kind: "TELEGRAM_WORKFLOW",
        phase: "REPLIED",
        reply: "answered",
        sent: true,
        deliveryStatus: "APPLIED",
      }, "ANSWERED").allowed,
    ).toBe(true);
    // Resolved: an ordinary replay right now is correctly ignored, not treated as unknown, and
    // there is nothing left in `unresolvedTurns` for a person to chase.
    expect(admit().reasonCode).toBe(ReasonCode.INGRESS_REPLAY_IGNORED);
    expect(guard.unresolvedTurns("telegram", "session-digest")).toEqual([]);

    // Age the row directly, the same way ingress-turn-claim.test.ts does, rather than advancing
    // the clock a full 24h — the point under test is what pruning does with the enforced floor,
    // not how long a test takes to run.
    harness.cp.db.run(
      "UPDATE inbound_messages SET received_at = ? WHERE channel = 'telegram' AND nonce = ?",
      ["2000-01-01T00:00:00.000Z", nonce],
    );
    expect(
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce: "unrelated", payload: {} })
        .allowed,
    ).toBe(true);

    // The row is gone, so a redelivery is admitted as a fresh message — the same as
    // ingress-turn-claim.test.ts's "still expires an ordinary row" case. What this test cannot
    // show is that a *real* Telegram redelivery could never reach this point once `nonceTtlMs`
    // respects the floor; that rests on the external fact in this file's docstring, not on
    // anything a unit test can drive.
    const redelivered = admit();
    expect(redelivered.allowed).toBe(true);
  });

  it("#682: holds the floor even if the caller mutates the policy object after construction", () => {
    // Sol's review: `policies` is typed `Readonly<Record<string, IngressPolicy>>`, and that
    // readonly is shallow — it stops reassigning the record's own entries, not writing to the
    // `IngressPolicy` object one of those entries points at. The constructor validated
    // `nonceTtlMs` against the retention floor exactly once; `admit` used to re-read
    // `policy.nonceTtlMs` from that same object on every call, so mutating it after construction
    // silently reopened the window the constructor had just refused to allow.
    //
    // Built with a valid ttl, then mutated to something the constructor would have refused
    // outright — proving the floor is enforced from a value this guard copied out, not from the
    // object the caller still holds a reference to.
    // `recoverInFlight` is deliberately left unset: with it on, a replay of an unclaimed,
    // never-completed row is legitimately re-admitted through the *recovery* path regardless of
    // whether the row still exists — `allowed: true` there proves nothing about pruning. Leaving
    // it off makes `admit`'s only path to `allowed: true` for a still-existing, unclaimed row be
    // "the row is gone" — the one fact this test needs to observe.
    const harness = makeHarness();
    const policy: { telegram: IngressPolicy } = {
      telegram: { allowedActors: ["owner"], allowedConversations: ["chat"] },
    };
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, policy);
    // Well under the retention floor — exactly the value the constructor throws on if given it
    // directly (see the first test in this file).
    policy.telegram.nonceTtlMs = 1;

    const nonce = "mutated-policy-update";
    expect(
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce, payload: {} }).allowed,
    ).toBe(true);
    // Past the mutated 1ms ttl, nowhere near the 24h default this guard actually validated.
    harness.clock.advance(10);
    expect(
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce: "unrelated", payload: {} })
        .allowed,
    ).toBe(true);

    // A pruned row is re-admitted as fresh; a row the floor still protects is refused as an
    // ordinary replay (`recoverInFlight` is off, so there is no other way to reach `allowed: true`
    // for a row that still exists). If `admit` had re-read the mutated `nonceTtlMs`, this row
    // would already be gone and this call would be `allowed: true`.
    const replay = guard.admit({
      channel: "telegram",
      actor: "owner",
      conversation: "chat",
      nonce,
      payload: {},
    });
    expect(replay.allowed, "the mutated nonceTtlMs must not have pruned this row after only 10ms").toBe(false);
    expect(replay.reasonCode).toBe(ReasonCode.INGRESS_REPLAY_IGNORED);
  });
});
