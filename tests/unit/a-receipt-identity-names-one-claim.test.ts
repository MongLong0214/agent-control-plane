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
