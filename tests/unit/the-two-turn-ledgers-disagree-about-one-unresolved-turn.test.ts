import { afterAll, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { IngressGuard, type TurnIdentity } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { admitInbound, makeHarness, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The disagreement #858 names, written down so it can be run instead of argued.
 *
 * Two mechanisms claim to answer "which turn is this conversation running". The one wired to
 * production is `IngressGuard.claimTurn`, writing `inbound_messages.turn_claim_json`. The one the
 * adjudication surfaces read is `ConversationTurnCoordinator.claim`, writing `canonical_turns` —
 * and it has no production caller, which is the whole of #858.
 *
 * They disagree on one rule, and `turn-coordinator.ts:591-600` says so in as many words, declining
 * to decide it because `claim()` had no caller to be wrong in front of yet. This file makes that
 * sentence executable: whichever way the decision goes, one of these cases changes, and the diff
 * says which rule was chosen.
 *
 * What it deliberately does **not** do is assert that either behaviour is correct. Both cases here
 * pass today, and they are written to keep passing until someone decides — a test that pinned the
 * coordinator's strictness as *right* would make the decision by being green.
 */
const NOW = "2026-01-01T00:00:00.000Z";

/** A CEO actor with the binding and attestation `claim()` checks for currency. */
const ceoActor = (h: Harness, name = "ceo"): string => {
  const actorId = `actor:${name}`;
  const sessionId = `runtime:${name}`;
  h.cp.db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc', 'claude', 'opus', 'READY', ?, ?)`,
    [sessionId, NOW, NOW],
  );
  h.cp.db.run(
    `INSERT INTO conversational_actors
       (actor_id, kind, current_session_id, current_session_incarnation, created_at)
     VALUES (?, 'CEO', ?, 'inc', ?)`,
    [actorId, sessionId, NOW],
  );
  h.cp.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [`bind:${name}`, actorId, `locator:${name}`, `digest:${name}`, NOW],
  );
  h.cp.db.run(
    `INSERT INTO assignments
       (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
        binding_generation, mode, status, created_at)
     VALUES (?, ?, 'CEO', ?, ?, 'inc', 1, 'PREFERRED', 'ACTIVE', ?)`,
    [`asg:${name}`, `CEO:${name}`, actorId, sessionId, NOW],
  );
  h.cp.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
        attested_at)
     VALUES (?, ?, 'v1', ?, ?, 'inc', 1, ?, ?)`,
    [`att:${name}`, `bind:${name}`, `attd:${name}`, sessionId, `asg:${name}`, NOW],
  );
  return actorId;
};

const telegramGuard = (h: Harness): IngressGuard =>
  new IngressGuard(h.cp.db, h.cp.clock, h.cp.audit, {
    telegram: { allowedActors: ["owner"], allowedConversations: ["convo"] },
  });

/** The identity shape the production router builds, including the `/again` field when it applies. */
const identityFor = (nonce: string, overridden?: readonly string[]): TurnIdentity => ({
  turnRequestId: `turn:${nonce}`,
  sessionDigest: digestOf({ channel: "telegram", conversation: "convo" }),
  promptDigest: digestOf(nonce),
  bindingDigest: digestOf({ bindingGeneration: 1 }),
  ...(overridden ? { overriddenUnresolvedNonces: [...overridden] } : {}),
});

describe("the two turn ledgers disagree about the one-unresolved-turn hold", () => {
  it("the ingress ledger claims a second turn while the first is unresolved", () => {
    const h = makeHarness();
    const actorId = ceoActor(h);
    const guard = telegramGuard(h);

    admitInbound(h, { nonce: "m1", payload: {} });
    const first = h.cp.conversation.claim({
      targetActorId: actorId,
      prompt: "m1",
      sources: [{ channel: "telegram", nonce: "m1", attempt: 1, payload: {} }],
    });
    expect(first.allowed, "the canonical ledger takes the first turn").toBe(true);

    // A different message, arriving while m1's outcome is unknown. This is the `/again` shape: the
    // owner was shown the unresolved turn and asked for this one anyway, and the router records
    // which nonces that overrode (telegram-router.ts, `overriddenUnresolvedNonces`).
    admitInbound(h, { nonce: "m2", payload: {} });
    const second = guard.claimTurn("telegram", "m2", identityFor("m2", ["m1"]));

    expect(second.allowed, "ingress admits it — claimTurn has no unresolved-turn hold at all").toBe(true);
  });

  it("the canonical ledger refuses the same second turn", () => {
    const h = makeHarness();
    const actorId = ceoActor(h);

    admitInbound(h, { nonce: "m1", payload: {} });
    expect(
      h.cp.conversation.claim({
        targetActorId: actorId,
        prompt: "m1",
        sources: [{ channel: "telegram", nonce: "m1", attempt: 1, payload: {} }],
      }).allowed,
    ).toBe(true);

    admitInbound(h, { nonce: "m2", payload: {} });
    const second = h.cp.conversation.claim({
      targetActorId: actorId,
      prompt: "m2",
      sources: [{ channel: "telegram", nonce: "m2", attempt: 1, payload: {} }],
    });

    expect(second.allowed).toBe(false);
    if (second.allowed) throw new Error("unreachable");
    expect(second.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_IN_DOUBT);

    // The hold is not a preference in this method: `canonical_turns_one_unresolved` is a partial
    // UNIQUE index on (target_actor_id) WHERE lifecycle_state = 'IN_DOUBT'. The read above returns
    // a decision; the index is what would otherwise throw. An override is therefore a migration,
    // not a branch — which is why the decision is worth making once rather than discovered while
    // wiring.
  });

  it("so the two ledgers end up holding different turns, each blind to the other's", () => {
    const h = makeHarness();
    const actorId = ceoActor(h);
    const guard = telegramGuard(h);

    admitInbound(h, { nonce: "m1", payload: {} });
    h.cp.conversation.claim({
      targetActorId: actorId,
      prompt: "m1",
      sources: [{ channel: "telegram", nonce: "m1", attempt: 1, payload: {} }],
    });
    admitInbound(h, { nonce: "m2", payload: {} });
    guard.claimTurn("telegram", "m2", identityFor("m2", ["m1"]));

    const ingressClaims = h.cp.db.all<{ nonce: string }>(
      `SELECT nonce FROM inbound_messages WHERE turn_claim_json IS NOT NULL ORDER BY nonce`,
    );
    const canonical = h.cp.conversation.unresolved(actorId);

    // This is sharper than "one ledger has two rows and the other has one". The coordinator's
    // claim never touches `inbound_messages.turn_claim_json` — only ingress writes that — so after
    // the sequence above each ledger holds exactly one turn, **and they are different turns**.
    //
    //   ingress   says the conversation is running m2   (the turn the owner asked for with /again)
    //   canonical says m1 is unresolved                 (the turn whose outcome nobody knows)
    //
    // `contradictions()`, `unresolvedAcrossActors()`, `resolveInDoubt()` and `adjudicate()` all
    // read the second. So the surfaces built to adjudicate "which turn is really in flight" are
    // looking at a turn production has already moved on from, and the turn production is actually
    // running is in neither of their results. Measured here rather than argued; which ledger
    // should win is #858's open decision.
    const canonicalSources = h.cp.db.all<{ source_nonce: string }>(
      `SELECT source_nonce FROM canonical_turn_sources ORDER BY source_nonce`,
    );

    expect(canonical).toHaveLength(1);
    expect(canonicalSources.map((row) => row.source_nonce)).toEqual(["m1"]);
    expect(ingressClaims.map((row) => row.nonce)).toEqual(["m2"]);
  });
});
