import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { TurnReconciler } from "../../src/conversation/turn-reconciler.ts";
import type { ReceiptLookupQuery, ReceiptLookupResult, ReceiptPort } from "../../src/conversation/turn-coordinator.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The active half of #639 contract 6 — and the review that found the tautology in the first
 * draft of this file.
 *
 * The schema and `reconcileWithReceipt` already refuse to complete a turn without a matching
 * receipt — that much has stood since #665. What was still missing is anything that *asks*: a
 * turn nobody ever queries about stays `IN_DOUBT` forever even the instant Hermes commits a
 * receipt for it, and contract 6 without a harvester is vacuously true, exactly the hole a blind
 * review found on this issue. `TurnReconciler` is the harvester; `#638` is what makes the real
 * port answer anything but `found: false`. Until then every one of these turns stays
 * `OUTCOME_UNKNOWN`, which is the state contract 6 requires it stay in rather than guess.
 *
 * A second review (Sol, on the PR this file first shipped in) found that the first draft's fake
 * port keyed answers only on `turnRequestId` and echoed the query's own actor/prompt back as the
 * receipt's identity. That made every "mismatch" test in the sibling file pass by constructing a
 * bad `ReceiptLookupQuery` and handing it straight to `reconcileWithReceipt` — never through
 * `TurnReconciler` at all — while the real sweep always rebuilt the identity it checked from its
 * own row, so the check compared the database against itself and could not fail. `matchingReceipt`
 * below exists to make the honest case cheap to write and the dishonest one impossible to write by
 * accident: every receipt an answer carries states its own actor and prompt, independently of
 * whichever turn the fake happens to be keyed by.
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

/**
 * A receipt found for a turn, stating its own identity rather than echoing the caller's.
 *
 * `overrides` is where a test injects a wrong actor, prompt or generation — the receipt's own
 * claim, which is exactly what `TurnReconciler` must forward to `reconcileWithReceipt` unchanged.
 * There is no way to call this and *not* state an identity, unlike the shape the first draft
 * shipped with, where a caller who forgot to override anything got the query's own values for
 * free.
 */
const matchingReceipt = (
  permit: { turnRequestId: string; targetActorId: string; promptDigest: string },
  overrides: Partial<Extract<ReceiptLookupResult, { found: true }>> = {},
): ReceiptLookupResult => ({
  found: true,
  outcome: "COMPLETED",
  receiptId: `hermes:${permit.turnRequestId}`,
  evidenceDigest: `sha256:${permit.turnRequestId}`,
  reasonCode: ReasonCode.OK,
  targetActorId: permit.targetActorId,
  promptDigest: permit.promptDigest,
  bindingGeneration: 1,
  ...overrides,
});

/**
 * The stand-in #638 will one day be a real implementation of. Every deployment today wires the
 * always-empty variant; tests wire this one to prove the sweep's own logic.
 *
 * Records every query it is asked, so a test can assert on *which turns were actually queried* —
 * not only on how many settled. A candidate this port was never asked about and a candidate it
 * answered `found: false` for are both silent in the settlement counts; only the call list tells
 * them apart, and the sweep's whole claim to ask about *every* unresolved turn stands or falls on
 * that list matching the turns that were actually held.
 */
class FakeReceiptPort implements ReceiptPort {
  private readonly answers = new Map<string, ReceiptLookupResult>();
  readonly calls: ReceiptLookupQuery[] = [];

  answer(turnRequestId: string, result: ReceiptLookupResult): void {
    this.answers.set(turnRequestId, result);
  }

  lookup(query: ReceiptLookupQuery): ReceiptLookupResult {
    this.calls.push(query);
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
    port.answer(receipted.turnRequestId, matchingReceipt({ ...receipted, targetActorId: actorA }));

    const reconciler = new TurnReconciler(h.cp.conversation, port);
    const result = await reconciler.reconcileOnce();

    expect(result).toEqual({ swept: 2, settled: 1, unresolved: 1 });
    expect(stateOf(h, receipted.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
    expect(stateOf(h, silent.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    // Every unresolved turn was asked about, not just the one that happened to settle — the whole
    // claim this describe block makes. Silence in the settlement count does not distinguish
    // "never asked" from "asked and refused", but the call list does.
    expect(port.calls.map((q) => q.turnRequestId).sort()).toEqual(
      [receipted.turnRequestId, silent.turnRequestId].sort(),
    );
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
    port.answer(
      held.turnRequestId,
      matchingReceipt({ ...held, targetActorId: actorId }, { bindingGeneration: 2 }),
    );
    port.answer(alsoHeld.turnRequestId, matchingReceipt({ ...alsoHeld, targetActorId: other }));

    const reconciler = new TurnReconciler(h.cp.conversation, port);
    const summary = await reconciler.reconcileOnce();

    expect(summary).toEqual({ swept: 2, settled: 1, unresolved: 1 });
    expect(stateOf(h, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(stateOf(h, alsoHeld.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
  });

  /**
   * The regression this file exists for. Sol's review: the query `TurnReconciler` sends is built
   * from the very row it is about to check, so an identity check built from that query instead of
   * from the receipt's own answer compares the database against itself and cannot fail.
   *
   * `matchingReceipt` here is told the *wrong* actor on purpose — a receipt that, if #638 existed
   * today, would be a bug in Hermes or evidence of the exact confusion contract 1 exists to catch
   * a generation for: this receipt is not about the turn it is keyed under. Before the fix this
   * test guards, `TurnReconciler` ignored `result.targetActorId` entirely and fed
   * `reconcileWithReceipt` the query's own (correct, self-sourced) actor — so the mismatch this
   * receipt carries was invisible to the one path that runs in production.
   */
  it("does not complete a turn when the receipt attests to the wrong actor, even though the query it was asked under was correct", async () => {
    const h = makeHarness();
    const actorId = target(h, "right-actor", 1);
    const impostor = target(h, "wrong-actor", 1);
    const held = claim(h, actorId, "m1");

    const port = new FakeReceiptPort();
    // The port is asked about `held` (actor "right-actor"), and answers with a receipt that
    // attests to a different actor entirely.
    port.answer(held.turnRequestId, matchingReceipt({ ...held, targetActorId: impostor }));

    const reconciler = new TurnReconciler(h.cp.conversation, port);
    const summary = await reconciler.reconcileOnce();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1 });
    expect(stateOf(h, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  /** Same defect, the other content field: the prompt digest. */
  it("does not complete a turn when the receipt attests to the wrong prompt", async () => {
    const h = makeHarness();
    const actorId = target(h, "right-prompt", 1);
    const held = claim(h, actorId, "m1");

    const port = new FakeReceiptPort();
    port.answer(
      held.turnRequestId,
      matchingReceipt({ ...held, targetActorId: actorId }, { promptDigest: "sha256:not-what-was-asked" }),
    );

    const reconciler = new TurnReconciler(h.cp.conversation, port);
    const summary = await reconciler.reconcileOnce();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1 });
    expect(stateOf(h, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
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
        return matchingReceipt({ ...fine, targetActorId: actorB });
      },
    };

    const reconciler = new TurnReconciler(h.cp.conversation, port);
    const summary = await reconciler.reconcileOnce();

    expect(summary).toEqual({ swept: 2, settled: 1, unresolved: 1 });
    expect(stateOf(h, broken.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(stateOf(h, fine.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
  });
});
