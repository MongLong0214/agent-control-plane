import { describe, expect, it } from "vitest";

import { systemClock } from "../../src/core/clock.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { makeHarness } from "../helpers/harness.ts";

/**
 * #858. The contract for this issue says ordering must not rest on `received_at` alone. This file
 * is the measurement behind that clause and the witness for the tiebreaker that answers it.
 *
 * **These rows pin the property, and they cannot kill the tiebreaker. That is recorded, not
 * hidden.** Running them with `nonce ASC` removed leaves all three green: `PRIMARY KEY (channel,
 * nonce)` gives the table an implicit index, `WHERE channel = ?` makes it the access path, and the
 * scan therefore already arrives nonce-ordered. So the order this file asserts is currently
 * supplied by the query planner's index choice rather than by the `ORDER BY`, and the tiebreaker
 * makes it a property of the SQL instead of a property of a plan.
 *
 * What that means for a reader: a green run here is evidence about *the order the product
 * answers*, and is not evidence that the `ORDER BY` is what produces it. The measurement in the
 * first row below is the part that says why the clause is needed at all.
 */
const OWNER = "isaac";
const CHANNEL = "cli";
const SESSION = "session-digest-under-test";

const admitInOrder = (nonces: readonly string[]) => {
  const harness = makeHarness();
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    [CHANNEL]: { allowedActors: [OWNER] },
  } as never);
  for (const nonce of nonces) {
    const admitted = guard.admit({
      channel: CHANNEL,
      nonce,
      actor: OWNER,
      payload: { text: nonce },
    } as never) as { allowed: boolean };
    expect(admitted.allowed, `admission of ${nonce} was refused`).toBe(true);
  }
  return { harness, guard };
};

describe("unresolved turns are totally ordered", () => {
  /**
   * The measurement the tiebreaker rests on, taken through the production clock rather than
   * through the harness's `ManualClock`. If this ever reports 400 distinct timestamps the
   * collision case is gone and the tiebreaker is merely harmless; it does not become wrong.
   */
  it("received_at cannot order messages admitted in one millisecond", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 400; i += 1) {
      const at = systemClock.nowIso();
      seen.set(at, (seen.get(at) ?? 0) + 1);
    }
    const worst = Math.max(...seen.values());
    // Not "exactly 1 distinct": a slow machine could tick mid-loop. The claim is that a tie is
    // reachable at all, which is what makes `received_at` alone a partial order.
    expect(worst, "no two of 400 consecutive clock reads shared a millisecond").toBeGreaterThan(1);
  });

  it("the harness clock makes every row share a timestamp, so an order asserted through it asserts nothing", () => {
    const { harness } = admitInOrder(["a", "b", "c"]);
    const stamps = harness.cp.db.all<{ received_at: string }>(
      `SELECT received_at FROM inbound_messages`,
      [],
    );
    expect(new Set(stamps.map((row) => row.received_at)).size).toBe(1);
  });

  /**
   * The witness, through the production reader rather than through a copy of its ORDER BY.
   *
   * Two runs over the same three messages, claimed into the same conversation, inserted in
   * opposite orders. `unresolvedTurns` must answer identically — and before `nonce ASC` was added
   * it did not: each run came back in its own insertion order, so the answer depended on the order
   * the rows were written rather than on anything the schema declares.
   *
   * A test that inserts in the order it expects back cannot see this. The `inbound_received` index
   * hands ties back in insertion order, so such a test passes with or without a tiebreaker. The
   * opposite-order pair is what makes "totally ordered" a measurement.
   */
  it("unresolvedTurns answers the same order however the rows were written", () => {
    const orders = new Map<string, readonly string[]>();
    const insertionOrders = new Map<string, readonly string[]>();

    for (const nonces of [
      ["m-1", "m-2", "m-3"],
      ["m-3", "m-2", "m-1"],
      ["m-2", "m-3", "m-1"],
    ]) {
      const { harness, guard } = admitInOrder(nonces);
      for (const nonce of nonces) {
        const claimed = guard.claimTurn(CHANNEL, nonce, {
          turnRequestId: `turn-${nonce}`,
          sessionDigest: SESSION,
          promptDigest: `prompt-${nonce}`,
          bindingDigest: "binding-1",
        });
        expect(claimed.allowed, `claim of ${nonce} was refused`).toBe(true);
      }
      const key = nonces.join(">");
      orders.set(key, guard.unresolvedTurns(CHANNEL, SESSION).map((turn) => turn.nonce));
      insertionOrders.set(
        key,
        harness.cp.db
          .all<{ nonce: string }>(`SELECT nonce FROM inbound_messages WHERE channel = ? ORDER BY rowid ASC`, [CHANNEL])
          .map((row) => row.nonce),
      );
    }

    // The three databases disagree about the order the rows were written in. Without this, the
    // assertion below would be a restatement rather than a measurement.
    expect([...insertionOrders.values()]).toEqual([
      ["m-1", "m-2", "m-3"],
      ["m-3", "m-2", "m-1"],
      ["m-2", "m-3", "m-1"],
    ]);

    // And they agree about what is outstanding.
    expect([...new Set([...orders.values()].map((one) => one.join(",")))]).toEqual(["m-1,m-2,m-3"]);
  });
});
