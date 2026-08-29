import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { TurnReconciler } from "../../src/conversation/turn-reconciler.ts";
import type { ReceiptLookupQuery, ReceiptLookupResult, ReceiptPort } from "../../src/conversation/turn-coordinator.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The active half of #639 contract 6.
 *
 * The schema and `reconcileWithReceipt` already refuse to complete a turn without a matching
 * receipt — that much has stood since #665. What was still missing is anything that *asks*: a
 * turn nobody ever queries about stays `IN_DOUBT` forever even the instant Hermes commits a
 * receipt for it, and contract 6 without a harvester is vacuously true, exactly the hole a blind
 * review found on this issue. `TurnReconciler` is the harvester; `#638` is what makes the real
 * port answer anything but `found: false`. Until then every one of these turns stays
 * `OUTCOME_UNKNOWN`, which is the state contract 6 requires it stay in rather than guess.
 */
type Harness = ReturnType<typeof makeHarness>;

const NOW = "2026-08-29T00:00:00.000Z";

const target = (h: Harness, name: string, bindingGeneration = 1): string => {
  const actorId = `actor:${name}`;
  h.cp.db.run(`INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'CEO', ?)`, [
    actorId,
    NOW,
  ]);
  h.cp.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [`bind:${name}`, actorId, `locator:${name}`, `digest:${name}`, NOW],
  );
  h.cp.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, attested_at)
     VALUES (?, ?, 'v1', ?, 'ses', 'inc', ?, ?)`,
    [`att:${name}`, `bind:${name}`, `attd:${name}`, bindingGeneration, NOW],
  );
  return actorId;
};

const claim = (h: Harness, actorId: string, nonce: string) => {
  const decision = h.cp.conversation.claim({
    targetActorId: actorId,
    prompt: "hello",
    sources: [{ channel: "telegram", nonce, attempt: 1, payload: {} }],
  });
  if (!decision.allowed) throw new Error(`claim refused: ${decision.reasonCode}`);
  return decision.value;
};

const stateOf = (h: Harness, turnRequestId: string) =>
  h.cp.db.get<{ lifecycle_state: string; outcome_kind: string | null }>(
    `SELECT lifecycle_state, outcome_kind FROM canonical_turns WHERE turn_request_id = ?`,
    [turnRequestId],
  );

/** The stand-in #638 will one day be a real implementation of. Every deployment today wires the
 *  always-empty variant; tests wire this one to prove the sweep's own logic. */
class FakeReceiptPort implements ReceiptPort {
  private readonly answers = new Map<string, ReceiptLookupResult>();

  answer(turnRequestId: string, result: ReceiptLookupResult): void {
    this.answers.set(turnRequestId, result);
  }

  lookup(query: ReceiptLookupQuery): ReceiptLookupResult {
    return this.answers.get(query.turnRequestId) ?? { found: false };
  }
}

/** A port that never answers "found" — the only real deployment shape before #638. */
const alwaysEmptyPort: ReceiptPort = { lookup: () => ({ found: false }) };

describe("TurnReconciler", () => {
  it("settles a turn the fake port reports as receipted, and leaves the rest untouched", async () => {
    const h = makeHarness();
    const actorA = target(h, "a", 1);
    const actorB = target(h, "b", 1);
    const receipted = claim(h, actorA, "m1");
    const silent = claim(h, actorB, "m2");

    const port = new FakeReceiptPort();
    port.answer(receipted.turnRequestId, {
      found: true,
      outcome: "COMPLETED",
      receiptId: "hermes:r1",
      evidenceDigest: "sha256:evidence",
      reasonCode: ReasonCode.OK,
      bindingGeneration: 1,
    });

    const reconciler = new TurnReconciler(h.cp.conversation, port);
    const result = await reconciler.reconcileOnce();

    expect(result).toEqual({ swept: 2, settled: 1, unresolved: 1 });
    expect(stateOf(h, receipted.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
    expect(stateOf(h, silent.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  it("leaves every unresolved turn exactly where it was when the port never finds anything — the state before #638 lands", async () => {
    const h = makeHarness();
    const actorId = target(h, "untouched", 1);
    const held = claim(h, actorId, "m1");

    const reconciler = new TurnReconciler(h.cp.conversation, alwaysEmptyPort);
    const summary = await reconciler.reconcileOnce();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1 });
    expect(stateOf(h, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  it("does not complete a turn on a receipt naming a different CEO generation, and keeps sweeping the rest", async () => {
    const h = makeHarness();
    const actorId = target(h, "stale-gen", 1);
    const other = target(h, "other", 1);
    const held = claim(h, actorId, "m1");
    const alsoHeld = claim(h, other, "m2");

    const port = new FakeReceiptPort();
    // A receipt for the right turn id, but minted under a generation this turn was never
    // claimed under — the cross-generation completion contract 1 exists to refuse.
    port.answer(held.turnRequestId, {
      found: true,
      outcome: "COMPLETED",
      receiptId: "hermes:stale",
      evidenceDigest: "sha256:stale",
      reasonCode: ReasonCode.OK,
      bindingGeneration: 2,
    });
    port.answer(alsoHeld.turnRequestId, {
      found: true,
      outcome: "COMPLETED",
      receiptId: "hermes:good",
      evidenceDigest: "sha256:good",
      reasonCode: ReasonCode.OK,
      bindingGeneration: 1,
    });

    const reconciler = new TurnReconciler(h.cp.conversation, port);
    const summary = await reconciler.reconcileOnce();

    expect(summary).toEqual({ swept: 2, settled: 1, unresolved: 1 });
    expect(stateOf(h, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(stateOf(h, alsoHeld.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
  });

  it("does not stop the sweep when one lookup throws", async () => {
    const h = makeHarness();
    const actorA = target(h, "throws", 1);
    const actorB = target(h, "after", 1);
    const broken = claim(h, actorA, "m1");
    const fine = claim(h, actorB, "m2");

    const port: ReceiptPort = {
      lookup: (query) => {
        if (query.turnRequestId === broken.turnRequestId) throw new Error("network is down");
        return {
          found: true,
          outcome: "COMPLETED",
          receiptId: "hermes:fine",
          evidenceDigest: "sha256:fine",
          reasonCode: ReasonCode.OK,
          bindingGeneration: 1,
        };
      },
    };

    const reconciler = new TurnReconciler(h.cp.conversation, port);
    const summary = await reconciler.reconcileOnce();

    expect(summary).toEqual({ swept: 2, settled: 1, unresolved: 1 });
    expect(stateOf(h, broken.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(stateOf(h, fine.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
  });
});
