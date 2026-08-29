import { afterAll, describe, expect, it } from "vitest";

import type { ConversationTurnCoordinator} from "../../src/conversation/turn-coordinator.ts";
import { type TurnPermit } from "../../src/conversation/turn-coordinator.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { admitInbound, makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The way out of a quarantine, which shipped once with no test calling it at all.
 *
 * That absence is why its first version was wrong in two ways nobody noticed: it recorded the
 * resolution as an *observation* under the authority that happened to own the outcome — so
 * resolving a dispute about what the target said produced a second row claiming the target had
 * said it again — and it lasted exactly until the next observation of any kind, including one
 * that agreed with it. Both were found by review, not by the suite.
 *
 * So this file exercises the boundaries rather than the happy path: what a citation has to
 * cover, what an adjudication may not decide, and what re-opens one.
 */
type Harness = ReturnType<typeof makeHarness>;

const NOW = "2026-08-22T00:00:00.000Z";

const target = (h: Harness, name = "ceo"): string => {
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
  // The active role binding the attestation's generation names, so `claim()`'s currency check
  // (#666) has a current generation to find.
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

const coordinatorOf = (h: Harness): ConversationTurnCoordinator => h.cp.conversation;

const claim = (h: Harness, actorId: string, nonce: string): TurnPermit => {
  // `claim()` now requires ingress to have admitted the (channel, nonce) a source names, with the
  // same payload it names (#666).
  admitInbound(h, { nonce, payload: {} });
  const claimed = coordinatorOf(h).claim({
    targetActorId: actorId,
    prompt: nonce,
    sources: [{ channel: "telegram", nonce, attempt: 1, payload: {} }],
  });
  if (!claimed.allowed) throw new Error(`claim refused: ${claimed.reasonCode}`);
  return claimed.value;
};

/** A turn whose records disagree: the target says it committed, pre-dispatch says nothing ran. */
const disputed = (h: Harness, actorId: string, nonce = "m1"): TurnPermit => {
  const permit = claim(h, actorId, nonce);
  coordinatorOf(h).ports.target.completed(permit, {
    receiptId: `target:${nonce}`,
    evidenceDigest: "sha256:receipt",
    reasonCode: ReasonCode.OK,
  });
  coordinatorOf(h).ports.preDispatch.neverAdmitted(permit, {
    receiptId: `pre:${nonce}`,
    evidenceDigest: "sha256:pre",
    reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
  });
  return permit;
};

const observationsOn = (h: Harness, turnRequestId: string): number[] =>
  h.cp.db
    .all<{ observation_id: number }>(
      `SELECT observation_id FROM canonical_turn_observations WHERE turn_request_id = ?`,
      [turnRequestId],
    )
    .map((row) => row.observation_id);

const consistencyOf = (h: Harness, turnRequestId: string): string =>
  h.cp.db.get<{ observation_consistency: string }>(
    `SELECT observation_consistency FROM canonical_turns WHERE turn_request_id = ?`,
    [turnRequestId],
  )!.observation_consistency;

describe("an adjudication has to have read the whole disagreement", () => {
  it("closes the disagreement when it cites every observation", () => {
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);

    const decision = coordinatorOf(h).adjudicate({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      citedObservationIds: observationsOn(h, permit.turnRequestId),
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:read-both",
    });

    expect(decision.allowed).toBe(true);
    expect(consistencyOf(h, permit.turnRequestId)).toBe("ADJUDICATED");
  });

  it("refuses a partial citation", () => {
    // Closing a disagreement while leaving part of it unread is the same shape as a review that
    // reports on what it happened to look at.
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);

    const decision = coordinatorOf(h).adjudicate({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      citedObservationIds: observationsOn(h, permit.turnRequestId).slice(0, 1),
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:partial",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_ADJUDICATION_INCOMPLETE);
    expect(consistencyOf(h, permit.turnRequestId)).toBe("CONTRADICTED");
  });

  it("refuses an adjudication naming a different actor than the turn belongs to", () => {
    // The quarantine is per actor, and this is the line that makes it so. Without it a caller
    // holding actor B's identity clears actor A's quarantine, and the audit row attributes A's
    // adjudication to B — the record of who decided is the point of recording it at all.
    //
    // Measured before this test: replacing the actor comparison with `false` broke nothing in the
    // whole suite. An authorization boundary with no test.
    const h = makeHarness();
    const owner = target(h, "owner");
    const other = target(h, "other");
    const permit = disputed(h, owner);

    const decision = coordinatorOf(h).adjudicate({
      targetActorId: other,
      turnRequestId: permit.turnRequestId,
      citedObservationIds: observationsOn(h, permit.turnRequestId),
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:wrong-actor",
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reasonCode).toBe(ReasonCode.NOT_FOUND);
    // And the quarantine is still on, which is what the refusal is for.
    expect(consistencyOf(h, permit.turnRequestId)).toBe("CONTRADICTED");
  });

  it("refuses a citation from another turn", () => {
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);
    const other = target(h, "cto");
    const elsewhere = disputed(h, other, "m2");

    const decision = coordinatorOf(h).adjudicate({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      citedObservationIds: observationsOn(h, elsewhere.turnRequestId),
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:foreign",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_ADJUDICATION_INCOMPLETE);
  });

  it("refuses an adjudication with no reason or no evidence", () => {
    // Otherwise the vocabulary becomes a way to mark a conversation reviewed when nothing was.
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);
    const cited = observationsOn(h, permit.turnRequestId);

    for (const [reasonCode, evidenceDigest] of [
      ["", "sha256:x"],
      [ReasonCode.OK, ""],
    ]) {
      expect(
        coordinatorOf(h).adjudicate({
          targetActorId: actorId,
          turnRequestId: permit.turnRequestId,
          citedObservationIds: cited,
          reasonCode: reasonCode!,
          evidenceDigest: evidenceDigest!,
        }).allowed,
      ).toBe(false);
    }
  });

  it("refuses to adjudicate a turn nothing disagreed about", () => {
    const h = makeHarness();
    const actorId = target(h);
    const permit = claim(h, actorId, "m1");
    coordinatorOf(h).ports.target.completed(permit, {
      receiptId: "r1",
      evidenceDigest: "sha256:receipt",
      reasonCode: ReasonCode.OK,
    });

    expect(
      coordinatorOf(h).adjudicate({
        targetActorId: actorId,
        turnRequestId: permit.turnRequestId,
        citedObservationIds: observationsOn(h, permit.turnRequestId),
        reasonCode: ReasonCode.OK,
        evidenceDigest: "sha256:nothing-to-do",
      }).reasonCode,
    ).toBe(ReasonCode.CONFLICT);
  });
});

describe("an adjudication records the resolution and does not choose it", () => {
  it("leaves the outcome exactly as the evidence produced it", () => {
    // The conservative order chose COMPLETED from the records. A human step that could pick a
    // more retry-safe one would make "an authenticated COMPLETED is never lowered" a preference.
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);

    coordinatorOf(h).adjudicate({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      citedObservationIds: observationsOn(h, permit.turnRequestId),
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:read-both",
    });

    const row = h.cp.db.get<{ outcome_kind: string; resolution_authority: string }>(
      `SELECT outcome_kind, resolution_authority FROM canonical_turns WHERE turn_request_id = ?`,
      [permit.turnRequestId],
    );
    expect(row?.outcome_kind).toBe("COMPLETED");
    expect(row?.resolution_authority).toBe("HERMES_TARGET");
  });

  it("does not add an observation under any authority's name", () => {
    // The version this replaces recorded the resolution as an observation carrying whichever
    // authority owned the outcome — so resolving a dispute about what the target said produced a
    // second row claiming the target had said it again.
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);
    const before = observationsOn(h, permit.turnRequestId);

    coordinatorOf(h).adjudicate({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      citedObservationIds: before,
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:read-both",
    });

    expect(observationsOn(h, permit.turnRequestId)).toEqual(before);
  });

  it("keeps the citation set as rows, not as a number in a column", () => {
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);
    const cited = observationsOn(h, permit.turnRequestId);

    coordinatorOf(h).adjudicate({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      citedObservationIds: cited,
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:read-both",
    });

    const stored = h.cp.db
      .all<{ observation_id: number }>(`SELECT observation_id FROM canonical_turn_adjudication_citations`)
      .map((row) => row.observation_id)
      .sort();
    expect(stored).toEqual([...cited].sort());
  });
});

describe("what an adjudication survives, and what re-opens it", () => {
  const adjudicate = (h: Harness, actorId: string, permit: TurnPermit) =>
    coordinatorOf(h).adjudicate({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      citedObservationIds: observationsOn(h, permit.turnRequestId),
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:read-both",
    });

  it("unblocks the conversation", () => {
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);
    adjudicate(h, actorId, permit);

    admitInbound(h, { nonce: "m2", payload: {} });
    expect(
      coordinatorOf(h).claim({
        targetActorId: actorId,
        prompt: "a new question",
        sources: [{ channel: "telegram", nonce: "m2", attempt: 1, payload: {} }],
      }).allowed,
    ).toBe(true);
  });

  it("survives a later observation that agrees with the resolution", () => {
    // The defect two lanes found: the recompute counted every observation that ever existed, and
    // the disagreeing ones are permanent — so an adjudication lasted until the next record of any
    // kind, including a redelivered receipt agreeing with it. That made the exit single-use.
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);
    adjudicate(h, actorId, permit);

    coordinatorOf(h).ports.acpObservedReply.sawCompletion(permit, {
      receiptId: "acp:late",
      evidenceDigest: "sha256:watched",
      reasonCode: ReasonCode.OK,
    });

    expect(consistencyOf(h, permit.turnRequestId)).toBe("ADJUDICATED");
  });

  it("re-opens on a later observation that disagrees with the resolution", () => {
    // The other half. An adjudication answers the disagreement it read; a new one is a new fact,
    // and a ledger that could not hear it would be refusing to record the thing it exists for.
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);
    adjudicate(h, actorId, permit);

    coordinatorOf(h).ports.ownerFence.aborted(permit, {
      receiptId: "fence:late",
      evidenceDigest: "sha256:fence",
      reasonCode: ReasonCode.OK,
    });

    expect(consistencyOf(h, permit.turnRequestId)).toBe("CONTRADICTED");
  });

  it("re-quarantines the conversation when it re-opens", () => {
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);
    adjudicate(h, actorId, permit);
    coordinatorOf(h).ports.ownerFence.aborted(permit, {
      receiptId: "fence:late",
      evidenceDigest: "sha256:fence",
      reasonCode: ReasonCode.OK,
    });

    admitInbound(h, { nonce: "m3", payload: {} });
    expect(
      coordinatorOf(h).claim({
        targetActorId: actorId,
        prompt: "another",
        sources: [{ channel: "telegram", nonce: "m3", attempt: 1, payload: {} }],
      }).reasonCode,
    ).toBe(ReasonCode.CONVERSATION_ACTOR_QUARANTINED);
  });
});

describe("an adjudication cannot be forged or edited", () => {
  it("refuses a directly inserted adjudication", () => {
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);

    expect(() =>
      h.cp.db.run(
        `INSERT INTO canonical_turn_adjudications
           (turn_request_id, resolved_outcome, reason_code, evidence_digest, adjudicated_at,
            audit_event_id)
         VALUES (?, 'COMPLETED', 'OK', 'forged', ?, (SELECT MIN(event_id) FROM audit_events))`,
        [permit.turnRequestId, NOW],
      ),
    ).toThrow(/CANONICAL_TURN_ADJUDICATION_AUTHORITY_DENIED/);
  });

  it("refuses to edit or delete one", () => {
    const h = makeHarness();
    const actorId = target(h);
    const permit = disputed(h, actorId);
    coordinatorOf(h).adjudicate({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      citedObservationIds: observationsOn(h, permit.turnRequestId),
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:read-both",
    });

    expect(() => h.cp.db.run(`UPDATE canonical_turn_adjudications SET reason_code = 'x'`)).toThrow(
      /CANONICAL_TURN_ADJUDICATION_APPEND_ONLY/,
    );
    expect(() => h.cp.db.run(`DELETE FROM canonical_turn_adjudications`)).toThrow(
      /CANONICAL_TURN_ADJUDICATION_APPEND_ONLY/,
    );
    expect(() => h.cp.db.run(`DELETE FROM canonical_turn_adjudication_citations`)).toThrow(
      /CANONICAL_TURN_ADJUDICATION_CITATION_APPEND_ONLY/,
    );
  });
});
