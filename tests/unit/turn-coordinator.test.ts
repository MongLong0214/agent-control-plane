import { afterAll, describe, expect, it } from "vitest";

import { ConversationTurnCoordinator, type TurnSource } from "../../src/conversation/turn-coordinator.ts";
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

const source = (nonce: string, attempt = 1): TurnSource => ({
  channel: "telegram",
  nonce,
  attempt,
  payload: { text: `message ${nonce}` },
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

const coordinatorOf = (h: Harness): ConversationTurnCoordinator =>
  new ConversationTurnCoordinator(h.cp.db, h.cp.clock, h.cp.audit);

const claimOf = (h: Harness, actorId: string, sources: TurnSource[], prompt = "hello") => {
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

    coordinatorOf(h).settle(first, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });
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
    coordinatorOf(h).settle(
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
    coordinatorOf(h).settle(first, {
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

    coordinatorOf(h).settle(permit, {
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

  it("refuses to overwrite a settlement that already happened", () => {
    // Two sequential calls, no interleaving required. A late receipt arriving after a
    // pre-dispatch refusal is the case, and last-write-wins would replace the authority that
    // actually decided — the single thing a later reader needs most.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source("m1")]);
    coordinatorOf(h).settle(permit, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });

    const second = coordinatorOf(h).settle(permit, {
      kind: "COMPLETED",
      authority: "HERMES_TARGET",
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:late",
    });

    expect(second.allowed).toBe(false);
    const row = h.cp.db.get<{ outcome_kind: string; resolution_authority: string }>(
      `SELECT outcome_kind, resolution_authority FROM canonical_turns WHERE turn_request_id = ?`,
      [permit.turnRequestId],
    );
    expect(row?.outcome_kind).toBe("NEVER_ADMITTED");
    expect(row?.resolution_authority).toBe("ACP_PRE_DISPATCH");
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
