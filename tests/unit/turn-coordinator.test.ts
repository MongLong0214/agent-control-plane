import { afterAll, describe, expect, it } from "vitest";

import {
  ConversationTurnCoordinator,
  type TurnPermit,
  type TurnSource,
} from "../../src/conversation/turn-coordinator.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The coordinator's whole job is refusing, so every test here is a refusal it must produce or a
 * hold it must not release.
 *
 * The rule under all of them: nothing clears a hold except a positively observed outcome. A test
 * that only checks the happy path would pass against a coordinator that quietly settles turns on
 * a timeout, and that coordinator is the one this design exists to not build.
 */
type Harness = ReturnType<typeof makeHarness>;

const NOW = "2026-08-21T00:00:00.000Z";

/**
 * An admitted inbound message, which a turn's source now has to name.
 *
 * A source used to carry a digest of a payload its caller supplied, so the ledger's record of
 * what a turn consumed was the caller's word about a message the caller also named. It reads the
 * digest from this row instead.
 */
const admit = (h: Harness, nonce: string, channel = "telegram"): void => {
  h.cp.db.run(
    `INSERT OR IGNORE INTO inbound_messages (channel, nonce, actor, received_at, payload_digest)
     VALUES (?, ?, 'owner', ?, ?)`,
    [channel, nonce, NOW, `sha256:${channel}:${nonce}`],
  );
};

const source = (nonce: string, attempt = 1): TurnSource => ({
  channel: "telegram",
  nonce,
  attempt
});

/** An actor with a verified, attested target — everything a turn needs before it can exist. */
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
    [`bind:${name}`, actorId, `sess-${name}`, `digest:${name}`, NOW],
  );
  h.cp.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, attested_at)
     VALUES (?, ?, 'v1', ?, 'ses-1', 'inc-1', 1, ?)`,
    [`att:${name}`, `bind:${name}`, `attd:${name}`, NOW],
  );
  return actorId;
};

/**
 * One coordinator per harness.
 *
 * Deliberate: a permit is signed with a key that lives only in the instance that issued it, so
 * handing every call its own coordinator would make every settlement fail for a reason that has
 * nothing to do with what the test is about. The composed daemon holds one, and these tests hold
 * one. Where a *second* instance is the subject, `anotherCoordinator` says so out loud.
 */
const coordinators = new WeakMap<object, ConversationTurnCoordinator>();
const coordinatorOf = (h: Harness): ConversationTurnCoordinator => {
  const existing = coordinators.get(h.cp.db as object);
  if (existing) return existing;
  const made = new ConversationTurnCoordinator(h.cp.db, h.cp.clock, h.cp.audit);
  coordinators.set(h.cp.db as object, made);
  return made;
};

/**
 * Constructing a second coordinator on the same database — as a thunk, because it throws.
 *
 * The materialization authority is issued once per database file, for the same reason the
 * evidence port is: two materializers make "the outcome is computed from the observations" a
 * matter of which one ran.
 */
const anotherCoordinator = (h: Harness): (() => ConversationTurnCoordinator) => () =>
  new ConversationTurnCoordinator(h.cp.db, h.cp.clock, h.cp.audit);

/**
 * The old `settle(permit, outcome)` shape, expressed against `observe`.
 *
 * Settlement is an observation now, and an observation carries a receipt identity so that the
 * same receipt redelivered is a no-op rather than a second opinion. These tests predate that, so
 * the adapter mints a unique receipt per call — which is what a caller with one genuine receipt
 * would supply, and keeps the tests about the behaviour they were written for.
 */
let receiptCounter = 0;
const settle = (
  coordinator: ConversationTurnCoordinator,
  permit: TurnPermit,
  outcome: {
    kind: "COMPLETED" | "NEVER_ADMITTED" | "ABORTED";
    authority: "ACP_PRE_DISPATCH" | "HERMES_TARGET" | "OWNER_AFTER_TARGET_FENCE";
    reasonCode: string;
    evidenceDigest?: string;
  },
) =>
  coordinator.observe(permit, {
    outcome: outcome.kind,
    authority: outcome.authority,
    receiptId: `receipt-${(receiptCounter += 1)}`,
    evidenceDigest: outcome.evidenceDigest ?? "sha256:evidence",
    reasonCode: outcome.reasonCode,
  });

const claimOf = (h: Harness, actorId: string, sources: TurnSource[], prompt = "hello") => {
  for (const one of sources) admit(h, one.nonce, one.channel);
  const decision = coordinatorOf(h).claim({ targetActorId: actorId, prompt, sources });
  if (!decision.allowed) throw new Error(`expected a permit, got ${decision.reasonCode}`);
  return decision.value;
};

describe("a turn cannot be claimed without a verified target", () => {
  it("refuses an actor that has no binding", () => {
    // This is the activation embargo. It is not a flag somebody sets — until an authenticated
    // preflight bind exists, no actor has a binding, so nothing can be admitted at all.
    const h = makeHarness();
    h.cp.db.run(`INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'CEO', ?)`, [
      "actor:unbound",
      NOW,
    ]);

    const decision = coordinatorOf(h).claim({
      targetActorId: "actor:unbound",
      prompt: "hello",
      sources: [source("m1")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TARGET_UNVERIFIED);
  });

  it("refuses a binding no runtime ever attested", () => {
    // A binding says which conversation. An attestation says a named generation checked it. The
    // second is the one that can go stale, so admitting on the first alone trusts an old claim.
    const h = makeHarness();
    h.cp.db.run(`INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'CEO', ?)`, [
      "actor:claimed",
      NOW,
    ]);
    h.cp.db.run(
      `INSERT INTO actor_target_bindings
         (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
       VALUES ('bind:claimed', 'actor:claimed', 'hermes', 'sess-x', 'digest:x', ?)`,
      [NOW],
    );

    const decision = coordinatorOf(h).claim({
      targetActorId: "actor:claimed",
      prompt: "hello",
      sources: [source("m1")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TARGET_UNATTESTED);
  });

  it("writes nothing when it refuses", () => {
    // A refusal that left a turn row behind would wedge the conversation it just declined to
    // serve — the next legitimate claim would hit the unresolved index and be told it is busy.
    const h = makeHarness();
    h.cp.db.run(`INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'CEO', ?)`, [
      "actor:unbound",
      NOW,
    ]);

    coordinatorOf(h).claim({ targetActorId: "actor:unbound", prompt: "x", sources: [source("m1")] });

    expect(h.cp.db.all(`SELECT 1 FROM canonical_turns`)).toHaveLength(0);
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_sources`)).toHaveLength(0);
  });
});

describe("a turn's sources name messages someone admitted", () => {
  it("refuses a source with no admission record", () => {
    // The ledger used to record that a turn consumed a message that did not exist, because the
    // source was whatever the caller handed over. The retry chain then reasoned about attempts
    // of a message nobody had let in.
    const h = makeHarness();
    const actorId = target(h, "ceo");

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source("never-admitted")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_SOURCE_NOT_ADMITTED);
  });

  it("refuses a message admitted before its payload was recorded", () => {
    // A digest that was never written cannot be checked. Treating its absence as satisfaction
    // would restore the gap the column closed, under the column's own name.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    h.cp.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at) VALUES ('telegram','legacy','owner',?)`,
      [NOW],
    );

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source("legacy")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_SOURCE_NOT_DIGESTED);
  });

  it("takes the digest from the admitted row, not from the caller", () => {
    // Two halves of one claim — what the message was, and that it was admitted — used to come
    // from the same untrusted place.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);

    const stored = h.cp.db.get<{ source_digest: string }>(
      `SELECT source_digest FROM canonical_turn_sources WHERE turn_request_id = ?`,
      [permit.turnRequestId],
    );
    const admittedRow = h.cp.db.get<{ payload_digest: string }>(
      `SELECT payload_digest FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'm1'`,
    );
    expect(stored?.source_digest).toBe(admittedRow?.payload_digest);
  });

  it("refuses to delete an admitted row a turn's source points at", () => {
    // The reference is evidence that the message was let in. Deleting the row leaves the source
    // naming nothing — and a cascade would erase the source instead of protecting it, which is
    // the opposite of what the reference is for.
    const h = makeHarness();
    claimOf(h, target(h, "ceo"), [source("m1")]);

    expect(() =>
      h.cp.db.run(`DELETE FROM inbound_messages WHERE channel='telegram' AND nonce='m1'`),
    ).toThrow(/INBOUND_MESSAGE_REFERENCED_BY_TURN/);
  });

  it("refuses to rewrite an admitted payload digest", () => {
    const h = makeHarness();
    claimOf(h, target(h, "ceo"), [source("m1")]);

    expect(() =>
      h.cp.db.run(`UPDATE inbound_messages SET payload_digest='sha256:other' WHERE nonce='m1'`),
    ).toThrow(/INBOUND_PAYLOAD_DIGEST_IMMUTABLE/);
  });

  it("writes nothing when a source is refused", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");
    admit(h, "m1");

    coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source("m1"), source("never-admitted")],
    });

    expect(h.cp.db.all(`SELECT 1 FROM canonical_turns`)).toHaveLength(0);
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_sources`)).toHaveLength(0);
  });
});

describe("a claim takes the hold in the same transaction", () => {
  it("records the turn already in doubt, before anything has run", () => {
    // The ordering the design turns on. The hold exists before the peer is called, so a crash
    // during the call leaves a record that says "unknown" rather than leaving no record at all.
    const h = makeHarness();
    const actorId = target(h, "ceo");

    const permit = claimOf(h, actorId, [source("m1")]);

    const row = h.cp.db.get<{ lifecycle_state: string; claimed_at: string }>(
      `SELECT lifecycle_state, claimed_at FROM canonical_turns WHERE turn_request_id = ?`,
      [permit.turnRequestId],
    );
    expect(row?.lifecycle_state).toBe("IN_DOUBT");
    expect(row?.claimed_at).toBe(h.clock.nowIso());
  });

  it("keeps several coalesced messages as one turn, in order", () => {
    // Three consecutive owner messages are one turn with three sources — not three turns, and
    // not one turn that forgot two of them.
    const h = makeHarness();
    const actorId = target(h, "ceo");

    const permit = claimOf(h, actorId, [source("m1"), source("m2"), source("m3")]);

    const rows = h.cp.db.all<{ source_nonce: string; batch_ordinal: number }>(
      `SELECT source_nonce, batch_ordinal FROM canonical_turn_sources
        WHERE turn_request_id = ? ORDER BY batch_ordinal`,
      [permit.turnRequestId],
    );
    expect(rows.map((r) => r.source_nonce)).toEqual(["m1", "m2", "m3"]);
    expect(rows.map((r) => r.batch_ordinal)).toEqual([0, 1, 2]);
  });

  it("refuses an attempt numbered below one", () => {
    // Attempts are 1-based, and the chain check reads `attempt - 1`. Without this, attempt 0
    // looks up attempt -1, finds nothing, and is refused as unchained — a plausible-looking
    // denial with the wrong reason, which is how a malformed request gets read as a retry
    // ordering problem.
    const h = makeHarness();
    const actorId = target(h, "ceo");

    admit(h, "m1");

    admit(h, "m1");

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "x",
      sources: [source("m1", 0)],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });

  it("refuses a turn that answers no message at all", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");

    const decision = coordinatorOf(h).claim({ targetActorId: actorId, prompt: "x", sources: [] });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });
});

describe("one unresolved turn per conversation", () => {
  it("refuses a second claim while the first is in doubt", () => {
    // Refuses rather than queues. Queueing here would hold the caller for the length of a turn,
    // which is the stall this design exists to remove.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    claimOf(h, actorId, [source("m1")]);

    admit(h, "m2");

    admit(h, "m2");

    const second = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "another",
      sources: [source("m2")],
    });

    expect(second.allowed).toBe(false);
    expect(second.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_IN_DOUBT);
  });

  it("leaves the first turn untouched when it refuses the second", () => {
    // The refused claim must not have consumed the incumbent's sources or moved its state. This
    // is the half a bare "it throws" assertion would not notice.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const first = claimOf(h, actorId, [source("m1")]);

    coordinatorOf(h).claim({ targetActorId: actorId, prompt: "another", sources: [source("m2")] });

    expect(h.cp.db.all(`SELECT 1 FROM canonical_turns`)).toHaveLength(1);
    expect(
      h.cp.db.all(`SELECT 1 FROM canonical_turn_sources WHERE turn_request_id = ?`, [
        first.turnRequestId,
      ]),
    ).toHaveLength(1);
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_sources WHERE source_nonce = 'm2'`)).toHaveLength(0);
  });

  it("admits the next turn once the first is settled", () => {
    // The hold releases on evidence and only on evidence — but it does release, or the first
    // refusal would be permanent.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const first = claimOf(h, actorId, [source("m1")]);

    settle(coordinatorOf(h), first, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });
    admit(h, "m2");
    admit(h, "m2");
    const second = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "another",
      sources: [source("m2")],
    });

    expect(second.allowed).toBe(true);
  });

  it("holds one conversation without blocking another", () => {
    // The hold is per conversation. A single global lock would make two CTOs serialise against
    // each other for no reason, which is the scaling shape this design refuses.
    const h = makeHarness();
    const ceo = target(h, "ceo");
    const cto = target(h, "cto");
    claimOf(h, ceo, [source("m1")]);

    admit(h, "m2");

    admit(h, "m2");

    const other = coordinatorOf(h).claim({
      targetActorId: cto,
      prompt: "unrelated",
      sources: [source("m2")],
    });

    expect(other.allowed).toBe(true);
  });
});

describe("a retry is legal only when the previous attempt ended safely", () => {
  const settleFirst = (h: Harness, actorId: string, outcome: "NEVER_ADMITTED" | "ABORTED" | "COMPLETED") => {
    const first = claimOf(h, actorId, [source("m1")]);
    settle(
      coordinatorOf(h),
      first,
      outcome === "NEVER_ADMITTED"
        ? { kind: "NEVER_ADMITTED", authority: "ACP_PRE_DISPATCH", reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE }
        : {
            kind: outcome,
            authority: "HERMES_TARGET",
            reasonCode: ReasonCode.OK,
            evidenceDigest: "sha256:receipt",
          },
    );
    return coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source("m1", 2)],
    });
  };

  it("permits a retry after the first attempt never ran", () => {
    const h = makeHarness();
    expect(settleFirst(h, target(h, "ceo"), "NEVER_ADMITTED").allowed).toBe(true);
  });

  it("permits a retry after the target proved the first was fenced", () => {
    const h = makeHarness();
    expect(settleFirst(h, target(h, "ceo"), "ABORTED").allowed).toBe(true);
  });

  it("refuses a retry of a message that already completed", () => {
    // The duplicate this whole ledger exists to prevent. The side effect is a write into the
    // owner's conversation, so there is no de-duplicating it afterwards.
    const h = makeHarness();
    const decision = settleFirst(h, target(h, "ceo"), "COMPLETED");

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_ATTEMPT_UNSAFE);
  });

  it("refuses a retry while the previous attempt is still in doubt", () => {
    // Reached on a *different* conversation, so the one-unresolved index is not what refuses it.
    // Without that separation this test would pass against a coordinator with no chain check at
    // all, since the incumbent hold alone would produce a denial.
    const h = makeHarness();
    const first = target(h, "first");
    const second = target(h, "second");
    claimOf(h, first, [source("m1")]);

    admit(h, "m1");

    admit(h, "m1");

    const decision = coordinatorOf(h).claim({
      targetActorId: second,
      prompt: "hello",
      sources: [source("m1", 2)],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_ATTEMPT_UNSAFE);
  });

  it("refuses an attempt whose predecessor does not exist", () => {
    // Otherwise an admission could number itself attempt 3 and skip every check that the
    // earlier attempts ended safely.
    const h = makeHarness();
    const actorId = target(h, "ceo");

    admit(h, "m1");

    admit(h, "m1");

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source("m1", 3)],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_ATTEMPT_UNCHAINED);
  });

  it("records which turn a retry followed", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const first = claimOf(h, actorId, [source("m1")]);
    settle(coordinatorOf(h), first, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });
    claimOf(h, actorId, [source("m1", 2)]);

    const row = h.cp.db.get<{ predecessor_turn_request_id: string }>(
      `SELECT predecessor_turn_request_id FROM canonical_turn_sources WHERE source_attempt = 2`,
    );
    expect(row?.predecessor_turn_request_id).toBe(first.turnRequestId);
  });
});

describe("settlement needs an authority that observed something", () => {
  it("records the authority and its evidence", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);

    settle(coordinatorOf(h), permit, {
      kind: "COMPLETED",
      authority: "HERMES_TARGET",
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:receipt",
    });

    const row = h.cp.db.get<{
      lifecycle_state: string;
      outcome_kind: string;
      resolution_authority: string;
      evidence_digest: string;
      settled_at: string;
    }>(`SELECT * FROM canonical_turns WHERE turn_request_id = ?`, [permit.turnRequestId]);
    expect(row?.lifecycle_state).toBe("SETTLED");
    expect(row?.outcome_kind).toBe("COMPLETED");
    expect(row?.resolution_authority).toBe("HERMES_TARGET");
    expect(row?.evidence_digest).toBe("sha256:receipt");
    expect(row?.settled_at).toBe(h.clock.nowIso());
  });

  it("lets a late target receipt beat an earlier mistaken refusal, and keeps both", () => {
    // The behaviour that replaced first-settlement-wins. A pre-dispatch refusal arriving before
    // the target's real receipt used to keep the false retry-safe answer and discard the true
    // one — worse than the overwrite it prevented, because an overwrite loses the first record
    // and this lost the correct one.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);
    settle(coordinatorOf(h), permit, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });

    const late = settle(coordinatorOf(h), permit, {
      kind: "COMPLETED",
      authority: "HERMES_TARGET",
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:late",
    });

    expect(late.allowed).toBe(true);
    const row = h.cp.db.get<{ outcome_kind: string; resolution_authority: string;
      observation_consistency: string }>(
      `SELECT outcome_kind, resolution_authority, observation_consistency
         FROM canonical_turns WHERE turn_request_id = ?`,
      [permit.turnRequestId],
    );
    expect(row?.outcome_kind).toBe("COMPLETED");
    expect(row?.resolution_authority).toBe("HERMES_TARGET");
    // Both records survive, and the turn says the two authorities disagreed.
    expect(row?.observation_consistency).toBe("CONTRADICTED");
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_observations`)).toHaveLength(2);
  });

  it("never lowers an outcome, whatever arrives afterwards", () => {
    // The direction that matters. COMPLETED forbids a re-run; ABORTED and NEVER_ADMITTED permit
    // one. So a later authority talking a completion down is exactly how a finished exchange
    // becomes runnable again.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);
    settle(coordinatorOf(h), permit, {
      kind: "COMPLETED",
      authority: "HERMES_TARGET",
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:receipt",
    });

    settle(coordinatorOf(h), permit, {
      kind: "ABORTED",
      authority: "OWNER_AFTER_TARGET_FENCE",
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:fence",
    });

    const row = h.cp.db.get<{ outcome_kind: string }>(
      `SELECT outcome_kind FROM canonical_turns WHERE turn_request_id = ?`,
      [permit.turnRequestId],
    );
    expect(row?.outcome_kind).toBe("COMPLETED");
  });

  it("treats the same receipt redelivered as a no-op, not a disagreement", () => {
    // Without receipt identity a retrying transport reports itself twice and quarantines the
    // conversation for no reason.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);
    const twice = () =>
      coordinatorOf(h).observe(permit, {
        outcome: "COMPLETED",
        authority: "HERMES_TARGET",
        receiptId: "the-same-receipt",
        evidenceDigest: "sha256:receipt",
        reasonCode: ReasonCode.OK,
      });

    twice();
    const again = twice();

    expect(again.allowed).toBe(true);
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_observations`)).toHaveLength(1);
    const row = h.cp.db.get<{ observation_consistency: string }>(
      `SELECT observation_consistency FROM canonical_turns WHERE turn_request_id = ?`,
      [permit.turnRequestId],
    );
    expect(row?.observation_consistency).toBe("CONSISTENT");
  });
});

describe("only a permit this coordinator issued can settle a turn", () => {
  const settleWith = (h: Harness, permit: TurnPermit) =>
    settle(coordinatorOf(h), permit, {
      kind: "COMPLETED",
      authority: "HERMES_TARGET",
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:forged",
    });

  it("refuses a hand-built permit naming a real turn", () => {
    // `TurnPermit` is a structural type, so this object satisfies it without a cast. That is
    // exactly why the shape cannot be the check: what separates a permit from something that
    // looks like one is the signature, and only the coordinator can produce that.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const real = claimOf(h, actorId, [source("m1")]);

    const decision = settleWith(h, { ...real, issuance: "00".repeat(32) });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_PERMIT_UNISSUED);
    expect(coordinatorOf(h).unresolved(actorId)).toHaveLength(1);
  });

  it("refuses a permit whose signature is absent entirely", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const real = claimOf(h, actorId, [source("m1")]);

    const decision = settleWith(h, { ...real, issuance: "" });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_PERMIT_UNISSUED);
  });

  it("refuses a genuine permit re-pointed at another actor's turn", () => {
    // The signature covers the actor, so editing it invalidates the permit. Without that
    // coverage a caller could settle any turn it knew the id of and have the audit blame
    // whichever actor it named.
    const h = makeHarness();
    const ceo = target(h, "ceo");
    const cto = target(h, "cto");
    const real = claimOf(h, ceo, [source("m1")]);
    claimOf(h, cto, [source("m2")]);

    const decision = settleWith(h, { ...real, targetActorId: cto });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_PERMIT_UNISSUED);
    expect(coordinatorOf(h).unresolved(ceo)).toHaveLength(1);
    expect(coordinatorOf(h).unresolved(cto)).toHaveLength(1);
  });

  it("refuses to exist as a second coordinator on the same database", () => {
    // The permit key is per instance and never persisted, so a permit was already unusable by a
    // second coordinator. This is the stronger statement: there is no second coordinator, because
    // the materialization authority is issued once per database file. Two materializers would
    // make "the outcome is computed from the observations" a matter of which one ran.
    const h = makeHarness();
    claimOf(h, target(h, "ceo"), [source("m1")]);

    expect(anotherCoordinator(h)).toThrow();
  });

  it("records the audit against the turn's own actor", () => {
    // Taken from the row rather than from the permit, so no future bug in permit handling can
    // steer who the audit says a settlement was about.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);

    settle(coordinatorOf(h), permit, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });

    const row = h.cp.db.get<{ actor: string }>(
      `SELECT actor FROM audit_events WHERE kind = 'CONVERSATION_TURN_OBSERVED'`,
    );
    expect(row?.actor).toBe(actorId);
  });

  it("cannot be given a permit whose turn vanished, because a turn cannot vanish", () => {
    // This test used to delete the rows and assert that `settle()` reported CONFLICT rather than
    // a forgery. The v24 triggers make that state unreachable, which is the better answer: the
    // hold is releasable only by an observed outcome, and a deletion released it silently.
    //
    // `settle()` keeps the branch for a row it cannot find. Nothing can reach it now, and it is
    // recorded as unreachable rather than claimed as a guard — the distinction this file has had
    // to make twice already.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    claimOf(h, actorId, [source("m1")]);

    expect(() => h.cp.db.run(`DELETE FROM canonical_turn_sources`)).toThrow(
      /CANONICAL_TURN_SOURCE_IMMUTABLE/,
    );
    expect(() => h.cp.db.run(`DELETE FROM canonical_turns`)).toThrow(/CANONICAL_TURN_NO_DELETE/);
  });
});

describe("evidence that cannot set the outcome still counts against a retry", () => {
  it("refuses a retry after ACP watched the reply reach the owner", () => {
    // The blocking counterexample from review, reproduced exactly. ACP_OBSERVED_HERMES_REPLY
    // cannot raise the outcome — deliberate — but it was also not counted as dissent, so a later
    // pre-dispatch NEVER_ADMITTED became the only materializing record, settled the turn
    // retry-safe, reported CONSISTENT, and the retry rule admitted attempt 2. That is a re-run of
    // an exchange ACP had watched Hermes deliver.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);
    coordinatorOf(h).observe(permit, {
      outcome: "COMPLETED",
      authority: "ACP_OBSERVED_HERMES_REPLY",
      receiptId: "acp-1",
      evidenceDigest: "sha256:watched",
      reasonCode: ReasonCode.OK,
    });
    settle(coordinatorOf(h), permit, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });

    admit(h, "m1");

    admit(h, "m1");

    const retry = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source("m1", 2)],
    });

    expect(retry.allowed).toBe(false);
    expect(retry.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_ATTEMPT_UNSAFE);
  });

  it("raises the disagreement rather than reporting it as consistent", () => {
    // "ACP observed a reply" and "nothing was admitted" cannot both be true, so the honest
    // record is a disagreement — not a settlement that looks decided.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);
    coordinatorOf(h).observe(permit, {
      outcome: "COMPLETED",
      authority: "ACP_OBSERVED_HERMES_REPLY",
      receiptId: "acp-1",
      evidenceDigest: "sha256:watched",
      reasonCode: ReasonCode.OK,
    });
    settle(coordinatorOf(h), permit, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });

    const row = h.cp.db.get<{ observation_consistency: string }>(
      `SELECT observation_consistency FROM canonical_turns WHERE turn_request_id = ?`,
      [permit.turnRequestId],
    );
    expect(row?.observation_consistency).toBe("CONTRADICTED");
  });

  it("refuses a retry while the previous attempt's observations are still in dispute", () => {
    // A disagreement with no completion in it: the target says it was fenced, pre-dispatch says
    // nothing ran. Both permit a retry on their own, so nothing but the open dispute refuses
    // this — which makes it the one case that tests the dispute check by itself.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);
    settle(coordinatorOf(h), permit, {
      kind: "ABORTED",
      authority: "HERMES_TARGET",
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:fence",
    });
    settle(coordinatorOf(h), permit, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });

    admit(h, "m1");

    admit(h, "m1");

    const retry = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source("m1", 2)],
    });

    expect(retry.allowed).toBe(false);
    expect(retry.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_ATTEMPT_UNSAFE);
  });

  it("still treats two authorities reporting the same outcome as corroboration", () => {
    // The over-correction to avoid. If any two observations counted as conflict, the ordinary
    // case — a target receipt confirming what ACP already saw — would quarantine every
    // conversation that worked.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);
    coordinatorOf(h).observe(permit, {
      outcome: "COMPLETED",
      authority: "ACP_OBSERVED_HERMES_REPLY",
      receiptId: "acp-1",
      evidenceDigest: "sha256:watched",
      reasonCode: ReasonCode.OK,
    });
    coordinatorOf(h).observe(permit, {
      outcome: "COMPLETED",
      authority: "HERMES_TARGET",
      receiptId: "target-1",
      evidenceDigest: "sha256:receipt",
      reasonCode: ReasonCode.OK,
    });

    const row = h.cp.db.get<{ observation_consistency: string; outcome_kind: string }>(
      `SELECT observation_consistency, outcome_kind FROM canonical_turns WHERE turn_request_id = ?`,
      [permit.turnRequestId],
    );
    expect(row?.observation_consistency).toBe("CONSISTENT");
    expect(row?.outcome_kind).toBe("COMPLETED");
  });

  it("records when the turn settled, and does not move it afterwards", () => {
    // A late observation that decides nothing was rewriting the terminal time of a turn it did
    // not settle.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);
    settle(coordinatorOf(h), permit, {
      kind: "COMPLETED",
      authority: "HERMES_TARGET",
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:receipt",
    });
    const settledAt = h.cp.db.get<{ settled_at: string }>(
      `SELECT settled_at FROM canonical_turns WHERE turn_request_id = ?`,
      [permit.turnRequestId],
    )?.settled_at;

    h.clock.advance(60_000);
    coordinatorOf(h).observe(permit, {
      outcome: "COMPLETED",
      authority: "ACP_OBSERVED_HERMES_REPLY",
      receiptId: "acp-late",
      evidenceDigest: "sha256:watched",
      reasonCode: ReasonCode.OK,
    });

    expect(
      h.cp.db.get<{ settled_at: string }>(
        `SELECT settled_at FROM canonical_turns WHERE turn_request_id = ?`,
        [permit.turnRequestId],
      )?.settled_at,
    ).toBe(settledAt);
  });
});

describe("a conversation whose last outcome is disputed takes no new turns", () => {
  const contradict = (h: Harness, actorId: string) => {
    const permit = claimOf(h, actorId, [source("m1")]);
    settle(coordinatorOf(h), permit, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });
    settle(coordinatorOf(h), permit, {
      kind: "COMPLETED",
      authority: "HERMES_TARGET",
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:late",
    });
    return permit;
  };

  it("refuses a new claim while an earlier turn's observations disagree", () => {
    // The contradicted turn is *settled*, so the one-unresolved index does not see it. Without a
    // separate check the conversation would carry on as if the disagreement had been resolved.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    contradict(h, actorId);

    admit(h, "m2");

    admit(h, "m2");

    const next = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "a new question",
      sources: [source("m2")],
    });

    expect(next.allowed).toBe(false);
    expect(next.reasonCode).toBe(ReasonCode.CONVERSATION_ACTOR_QUARANTINED);
  });

  it("names the disputed turn, so the refusal points somewhere", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const disputed = contradict(h, actorId);

    admit(h, "m2");

    admit(h, "m2");

    const next = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "q",
      sources: [source("m2")],
    });

    expect(next.evidence).toMatchObject({ contradicted: disputed.turnRequestId });
  });

  it("quarantines the disputed conversation and no other", () => {
    // Per actor, not global. A disagreement on one conversation stopping every other would be a
    // worse failure than the one it is protecting against.
    const h = makeHarness();
    contradict(h, target(h, "ceo"));
    const cto = target(h, "cto");

    admit(h, "m3");
    expect(
      coordinatorOf(h).claim({ targetActorId: cto, prompt: "q", sources: [source("m3")] }).allowed,
    ).toBe(true);
  });
});

describe("nothing clears a hold on time", () => {
  it("still refuses the next claim an hour later", () => {
    // The load-bearing half, and the one a reader-only assertion misses. An age-based sweeper
    // frees the unresolved index, so the way to see it is to try to claim again — not to ask
    // `unresolved()` what it thinks. A sweeper was written by hand and this suite stayed green
    // until this test existed.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    claimOf(h, actorId, [source("m1")]);

    h.clock.advance(60 * 60 * 1000);
    admit(h, "m2");
    admit(h, "m2");
    const next = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "later",
      sources: [source("m2")],
    });

    expect(next.allowed).toBe(false);
    expect(next.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_IN_DOUBT);
  });

  it("still reports a turn as unresolved an hour later", () => {
    // The design's central rule, stated as a test. There is no sweeper, no expiry and no
    // restart path that settles this row — only an authority that saw the outcome. If someone
    // adds an age-based cleanup, this is what fails.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);
    const claimedAt = h.clock.nowIso();

    h.clock.advance(60 * 60 * 1000);

    const outstanding = coordinatorOf(h).unresolved(actorId);
    expect(outstanding).toEqual([{ turnRequestId: permit.turnRequestId, claimedAt }]);
  });

  it("carries the claim time so age can be judged rather than guessed", () => {
    // The reader's half. The test above proves the column is written; this one proves the age a
    // caller actually sees comes from it, rather than from something reconstructed at read time.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    claimOf(h, actorId, [source("m1")]);

    expect(coordinatorOf(h).unresolved(actorId).map((t) => t.claimedAt)).toEqual([h.clock.nowIso()]);
  });
});
