import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #639 contract 6's write half: settling a turn from a receipt, with no `TurnPermit`.
 *
 * Every other settlement port requires one, and a permit is signed with a key that dies with its
 * coordinator instance (`TurnPermit.issuance`'s own docstring). A reconciler runs precisely when
 * that instance may be gone — recovering a turn a dead execution left `IN_DOUBT` — so it cannot
 * hold one. What replaces it is reading `canonical_turns` directly and checking every field the
 * identity carries, including `bindingGeneration`, which a permit does not sign.
 *
 * The generation check is the one this file exists for: contract 1 fixed `bindingGeneration` on
 * the claim precisely so a receipt minted under the *next* CEO generation could be told apart
 * from evidence about this one. Without that check here, `reconcileWithReceipt` would complete a
 * turn on a receipt describing a different CEO's work — the cross-generation completion #639
 * names as the reason the digest exists at all.
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

describe("reconcileWithReceipt", () => {
  it("settles an IN_DOUBT turn from a receipt whose identity and binding generation match, with no permit involved", () => {
    const h = makeHarness();
    const actorId = target(h, "reconciled", 1);
    const permit = claim(h, actorId, "m1");

    const decision = h.cp.conversation.reconcileWithReceipt(
      {
        turnRequestId: permit.turnRequestId,
        targetActorId: actorId,
        promptDigest: permit.promptDigest,
        bindingGeneration: 1,
      },
      { outcome: "COMPLETED", receiptId: "hermes:r1", evidenceDigest: "sha256:evidence", reasonCode: ReasonCode.OK },
    );

    expect(decision.allowed).toBe(true);
    expect(stateOf(h, permit.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
  });

  it("refuses to complete a turn when the receipt names a different CEO generation than the one that claimed it", () => {
    const h = makeHarness();
    const actorId = target(h, "wrong-gen", 1);
    const permit = claim(h, actorId, "m1");

    const decision = h.cp.conversation.reconcileWithReceipt(
      {
        turnRequestId: permit.turnRequestId,
        targetActorId: actorId,
        promptDigest: permit.promptDigest,
        // The claim was made under generation 1; this receipt claims to be from generation 2 —
        // a different CEO's work, per #639's own framing.
        bindingGeneration: 2,
      },
      { outcome: "COMPLETED", receiptId: "hermes:r1", evidenceDigest: "sha256:evidence", reasonCode: ReasonCode.OK },
    );

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_RECEIPT_WRONG_GENERATION);
    // Left exactly where it was: IN_DOUBT, not settled and not contradicted. A mismatched
    // generation is not evidence this turn's own observations disagree about anything.
    expect(stateOf(h, permit.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  it("refuses when no turn was ever claimed under this id", () => {
    const h = makeHarness();
    target(h, "unused", 1);

    const decision = h.cp.conversation.reconcileWithReceipt(
      { turnRequestId: "tr_ghost", targetActorId: "actor:unused", promptDigest: "sha256:x", bindingGeneration: 1 },
      { outcome: "COMPLETED", receiptId: "hermes:r1", evidenceDigest: "sha256:evidence", reasonCode: ReasonCode.OK },
    );

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCode).toBe(ReasonCode.NOT_FOUND);
  });

  it("refuses when the receipt's actor or prompt digest does not match the row it names", () => {
    const h = makeHarness();
    const actorId = target(h, "wrong-identity", 1);
    const permit = claim(h, actorId, "m1");

    const decision = h.cp.conversation.reconcileWithReceipt(
      {
        turnRequestId: permit.turnRequestId,
        targetActorId: actorId,
        promptDigest: "sha256:not-what-was-asked",
        bindingGeneration: 1,
      },
      { outcome: "COMPLETED", receiptId: "hermes:r1", evidenceDigest: "sha256:evidence", reasonCode: ReasonCode.OK },
    );

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_PERMIT_MISMATCH);
    expect(stateOf(h, permit.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  it("treats the same receipt redelivered as a no-op rather than a second opinion", () => {
    const h = makeHarness();
    const actorId = target(h, "redelivered", 1);
    const permit = claim(h, actorId, "m1");
    const query = {
      turnRequestId: permit.turnRequestId,
      targetActorId: actorId,
      promptDigest: permit.promptDigest,
      bindingGeneration: 1,
    };
    const receipt = {
      outcome: "COMPLETED" as const,
      receiptId: "hermes:r1",
      evidenceDigest: "sha256:evidence",
      reasonCode: ReasonCode.OK,
    };

    expect(h.cp.conversation.reconcileWithReceipt(query, receipt).allowed).toBe(true);
    const second = h.cp.conversation.reconcileWithReceipt(query, receipt);
    expect(second.allowed).toBe(true);
    expect(stateOf(h, permit.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
  });
});
