import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * What makes a second arrival of one receipt a redelivery rather than a second claim.
 *
 * A transport that retries reports the same receipt twice, and treating that as two observations
 * manufactures a disagreement with itself — which quarantines a conversation for no reason. So a
 * receipt already recorded under the same authority is accepted as a no-op when its *content*
 * matches, and refused when it does not: a receipt id carrying different content is two claims
 * wearing one identity, and accepting the second reports the first back as a confirmation of it.
 *
 * Four fields decide that. Measured on the head this file was written for, replacing each with
 * `true` in turn broke **no test**: four conditions in one comparison, none of them watched, and
 * `CONVERSATION_TURN_RECEIPT_REUSED` appeared in no test in the repository. One case per field,
 * because a case that moves two of them passes whichever condition is missing.
 */
type Harness = ReturnType<typeof makeHarness>;

const NOW = "2026-08-22T00:00:00.000Z";

const target = (h: Harness, name: string): string => {
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
     VALUES (?, ?, 'v1', ?, 'ses', 'inc', 1, ?)`,
    [`att:${name}`, `bind:${name}`, `attd:${name}`, NOW],
  );
  return actorId;
};

const claim = (h: Harness, actorId: string, nonce: string) => {
  const decision = h.cp.conversation.claim({
    targetActorId: actorId,
    prompt: nonce,
    sources: [{ channel: "telegram", nonce, attempt: 1, payload: {} }],
  });
  if (!decision.allowed) throw new Error(`claim refused: ${decision.reasonCode}`);
  return decision.value;
};

const RECEIPT = {
  receiptId: "r1",
  evidenceDigest: "sha256:evidence",
  reasonCode: ReasonCode.OK,
} as const;

describe("one receipt identity carries one claim", () => {
  it("accepts an exact redelivery as a no-op rather than a second opinion", () => {
    // The case the identity exists for: a retrying transport sends the same receipt twice.
    const h = makeHarness();
    const actorId = target(h, "redelivered");
    const permit = claim(h, actorId, "m1");

    expect(h.cp.conversation.ports.target.completed(permit, RECEIPT).allowed).toBe(true);
    expect(h.cp.conversation.ports.target.completed(permit, RECEIPT).allowed).toBe(true);

    expect(
      h.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM canonical_turn_observations WHERE receipt_id = 'r1'`,
      )!.n,
    ).toBe(1);
  });

  it("refuses the same receipt id on a different turn", () => {
    // Identity is scoped to the authority across turns, so a receipt landing on a second turn is
    // a wrong-turn completion wearing a genuine number.
    const h = makeHarness();
    const actorId = target(h, "twoturns");
    const first = claim(h, actorId, "m1");
    expect(h.cp.conversation.ports.target.completed(first, RECEIPT).allowed).toBe(true);

    const second = claim(h, actorId, "m2");
    const decision = h.cp.conversation.ports.target.completed(second, RECEIPT);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_RECEIPT_REUSED);
  });

  it.each([
    ["a different outcome", { outcome: true }],
    ["a different evidence digest", { evidenceDigest: "sha256:other" }],
    ["a different reason code", { reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE }],
  ] as const)("refuses the same receipt id carrying %s", (_label, change) => {
    const h = makeHarness();
    const actorId = target(h, `content-${_label.replace(/\W+/g, "")}`);
    const permit = claim(h, actorId, "m1");
    expect(h.cp.conversation.ports.target.completed(permit, RECEIPT).allowed).toBe(true);

    // The outcome is fixed by which port is called, so "a different outcome" means the other port
    // under the same authority — which is exactly how one receipt would carry two claims.
    const decision =
      "outcome" in change
        ? h.cp.conversation.ports.target.aborted(permit, RECEIPT)
        : h.cp.conversation.ports.target.completed(permit, { ...RECEIPT, ...change });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_RECEIPT_REUSED);
  });
});

describe("a completion nobody could materialize still blocks a retry", () => {
  it("refuses a retry after an adjudication left a completion observation standing", () => {
    // I wrote at the site that this condition could not be killed — that every state it would
    // catch alone is caught by a neighbour first. The final review refuted it by building the
    // state through the public ports, and this is that state:
    //
    //   ownerFence.aborted            -> outcome_kind ABORTED, which the outcome check calls safe
    //   acpObservedReply.sawCompletion -> a completion that cannot materialize; CONTRADICTED
    //   adjudicate citing both         -> ADJUDICATED, so the contradiction check no longer refuses
    //
    // ABORTED, ADJUDICATED, and a COMPLETED observation still on the turn. Only the completion
    // count refuses the retry. Measured with it replaced by `true`: the retry is ALLOWED — a
    // re-run of an exchange ACP watched Hermes deliver to the owner.
    const h = makeHarness();
    const actorId = target(h, "adjudicated-completion");
    const first = claim(h, actorId, "m1");

    expect(
      h.cp.conversation.ports.ownerFence.aborted(first, {
        receiptId: "fence:1",
        evidenceDigest: "sha256:fence",
        reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
      }).allowed,
    ).toBe(true);
    expect(
      h.cp.conversation.ports.acpObservedReply.sawCompletion(first, {
        receiptId: "acp:1",
        evidenceDigest: "sha256:seen",
        reasonCode: ReasonCode.OK,
      }).allowed,
    ).toBe(true);

    const cited = h.cp.db
      .all<{ observation_id: number }>(
        `SELECT observation_id FROM canonical_turn_observations WHERE turn_request_id = ?`,
        [first.turnRequestId],
      )
      .map((row) => row.observation_id);
    expect(
      h.cp.conversation.adjudicate({
        targetActorId: actorId,
        turnRequestId: first.turnRequestId,
        citedObservationIds: cited,
        reasonCode: ReasonCode.OK,
        evidenceDigest: "sha256:read-both",
      }).allowed,
    ).toBe(true);

    // The premise: both neighbouring conditions now pass.
    expect(
      h.cp.db.get<{ outcome_kind: string; observation_consistency: string }>(
        `SELECT outcome_kind, observation_consistency FROM canonical_turns WHERE turn_request_id = ?`,
        [first.turnRequestId],
      ),
    ).toMatchObject({ outcome_kind: "ABORTED", observation_consistency: "ADJUDICATED" });

    const retry = h.cp.conversation.claim({
      targetActorId: actorId,
      prompt: "m1",
      sources: [
        // Attempt 2 of the same message. The predecessor is found by (channel, nonce, attempt-1)
        // rather than named, so the retry rule reads the turn settled above.
        { channel: "telegram", nonce: "m1", attempt: 2, payload: {} },
      ],
    });

    expect(retry.allowed).toBe(false);
    if (retry.allowed) return;
    expect(retry.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_ATTEMPT_UNSAFE);
  });
});
