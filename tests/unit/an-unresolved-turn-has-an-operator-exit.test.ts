import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";

import { BOOTSTRAP_OPERATOR_METHODS, OPERATOR_METHOD } from "../../src/daemon/daemon.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The state the operator door did not open on.
 *
 * #665 built `contradictions()` / `adjudicate()` for a conversation whose records disagree, and an
 * independent review found the neighbouring state it cannot take: a turn that is simply
 * unresolved. Its records do not disagree — there is nothing to agree with — so the read half does
 * not list it and the write half refuses it. The permit that could settle it is signed with a key
 * that dies with the coordinator instance, so after a restart nothing can. Doctor reported the
 * state and named no command.
 *
 * That is worse than having no exit, for the reason the quarantine door was built in the first
 * place: a report that reads as actionable and is not.
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

const claim = (h: Harness, actorId: string, nonce: string, attempt = 1) => {
  const decision = h.cp.conversation.claim({
    targetActorId: actorId,
    prompt: "hello",
    sources: [{ channel: "telegram", nonce, attempt, payload: {} }],
  });
  if (!decision.allowed) throw new Error(`claim refused: ${decision.reasonCode}`);
  return decision.value;
};

const stateOf = (h: Harness, turnRequestId: string) =>
  h.cp.db.get<{ lifecycle_state: string; outcome_kind: string; observation_consistency: string }>(
    `SELECT lifecycle_state, outcome_kind, observation_consistency FROM canonical_turns
      WHERE turn_request_id = ?`,
    [turnRequestId],
  );

describe("a turn nothing observed can be settled by a person", () => {
  it("is invisible to the door built for a contradiction, which is why this one exists", () => {
    const h = makeHarness();
    const actorId = target(h, "crashed");
    const permit = claim(h, actorId, "m1");

    // The exact gap: no disagreement, so neither half of the quarantine door applies.
    expect(h.cp.conversation.contradictions()).toEqual([]);
    const refused = h.cp.conversation.adjudicate({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      citedObservationIds: [1],
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:operator",
    });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reasonCode).toBe(ReasonCode.CONFLICT);

    // And the conversation is stopped: the next message is refused while the first is unresolved.
    const blocked = h.cp.conversation.claim({
      targetActorId: actorId,
      prompt: "hello again",
      sources: [{ channel: "telegram", nonce: "m2", attempt: 1, payload: {} }],
    });
    expect(blocked.allowed).toBe(false);
  });

  it("shows the operator what is waiting, and what each turn already holds", () => {
    const h = makeHarness();
    const actorId = target(h, "waiting");
    const permit = claim(h, actorId, "m1");
    h.cp.conversation.ports.acpObservedReply.sawCompletion(permit, {
      receiptId: "acp-1",
      evidenceDigest: "sha256:watched",
      reasonCode: ReasonCode.OK,
    });

    const [waiting] = h.cp.conversation.unresolvedAcrossActors();

    expect(waiting?.turnRequestId).toBe(permit.turnRequestId);
    expect(waiting?.targetActorId).toBe(actorId);
    // The observations, not just a count: a turn carrying a completion ACP watched is a different
    // decision from one carrying nothing, and the operator has to be able to tell them apart.
    expect(waiting?.observations).toEqual([
      { observationId: expect.any(Number), authority: "ACP_OBSERVED_HERMES_REPLY", outcome: "COMPLETED" },
    ]);
  });

  it("settles a crashed turn ABORTED, so the owner's message can be sent again", () => {
    const h = makeHarness();
    const actorId = target(h, "resolved");
    const permit = claim(h, actorId, "m1");

    const resolved = h.cp.conversation.resolveInDoubt({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:operator-read-the-transcript",
    });
    expect(resolved.allowed).toBe(true);

    const row = stateOf(h, permit.turnRequestId);
    expect(row?.lifecycle_state).toBe("SETTLED");
    expect(row?.outcome_kind).toBe("ABORTED");
    expect(row?.observation_consistency).toBe("CONSISTENT");

    // The property that matters to the owner: the message is not lost. ABORTED is retry-safe, so
    // the same message may be sent again — which is the direction a person deciding on incomplete
    // information should be able to choose.
    const retry = h.cp.conversation.claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [{ channel: "telegram", nonce: "m1", attempt: 2, payload: {} }],
    });
    expect(retry.allowed).toBe(true);
  });

  it("does not pretend a turn ACP watched complete is safe to re-run", () => {
    // The second shape, and the reason this is not simply "mark it done". A completion ACP
    // observed still stands after the resolution: the outcome is ABORTED, the records now
    // disagree, and the retry is refused. The exit is two steps — resolve, then adjudicate — and
    // both are reachable, which is the whole difference from before.
    const h = makeHarness();
    const actorId = target(h, "watched");
    const permit = claim(h, actorId, "m1");
    h.cp.conversation.ports.acpObservedReply.sawCompletion(permit, {
      receiptId: "acp-1",
      evidenceDigest: "sha256:watched",
      reasonCode: ReasonCode.OK,
    });

    expect(
      h.cp.conversation.resolveInDoubt({
        targetActorId: actorId,
        turnRequestId: permit.turnRequestId,
        reasonCode: ReasonCode.OK,
        evidenceDigest: "sha256:operator",
      }).allowed,
    ).toBe(true);

    expect(stateOf(h, permit.turnRequestId)?.observation_consistency).toBe("CONTRADICTED");
    const retry = h.cp.conversation.claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [{ channel: "telegram", nonce: "m1", attempt: 2, payload: {} }],
    });
    expect(retry.allowed).toBe(false);

    // And now the contradiction door does apply, which it did not before.
    const [reported] = h.cp.conversation.contradictions();
    expect(reported?.turnRequestId).toBe(permit.turnRequestId);
    expect(
      h.cp.conversation.adjudicate({
        targetActorId: actorId,
        turnRequestId: permit.turnRequestId,
        citedObservationIds: (reported?.observations ?? []).map((o) => o.observationId),
        reasonCode: ReasonCode.OK,
        evidenceDigest: "sha256:operator-read-both",
      }).allowed,
    ).toBe(true);
  });

  it("refuses a turn that is already settled", () => {
    const h = makeHarness();
    const actorId = target(h, "settled");
    const permit = claim(h, actorId, "m1");
    h.cp.conversation.ports.preDispatch.neverAdmitted(permit, {
      receiptId: "pre-1",
      evidenceDigest: "sha256:pre",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });

    const refused = h.cp.conversation.resolveInDoubt({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:operator",
    });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reasonCode).toBe(ReasonCode.CONFLICT);
  });

  it("refuses a turn on another conversation, so one turn id cannot settle another's", () => {
    const h = makeHarness();
    const mine = target(h, "mine");
    const theirs = target(h, "theirs");
    const permit = claim(h, theirs, "m1");

    const refused = h.cp.conversation.resolveInDoubt({
      targetActorId: mine,
      turnRequestId: permit.turnRequestId,
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:operator",
    });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reasonCode).toBe(ReasonCode.NOT_FOUND);
    expect(stateOf(h, permit.turnRequestId)?.lifecycle_state).toBe("IN_DOUBT");
  });

  it("refuses a resolution that says nothing", () => {
    const h = makeHarness();
    const actorId = target(h, "unevidenced");
    const permit = claim(h, actorId, "m1");

    for (const input of [
      { reasonCode: "", evidenceDigest: "sha256:x" },
      { reasonCode: ReasonCode.OK, evidenceDigest: "" },
    ]) {
      const refused = h.cp.conversation.resolveInDoubt({
        targetActorId: actorId,
        turnRequestId: permit.turnRequestId,
        ...input,
      });
      expect(refused.allowed).toBe(false);
      if (!refused.allowed) {
        expect(refused.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_OBSERVATION_UNEVIDENCED);
      }
    }
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_observations`)).toEqual([]);
  });

  it("cannot record a completion, in the table and not only in the method", () => {
    // The restriction that makes this authority safe to hand a person. An operator did not watch
    // the target commit, and COMPLETED is the direction that loses the owner's question forever.
    //
    // Entered from a connection that has already satisfied the write-authority trigger, because an
    // ordinary insert is refused by that trigger first and would pass this assertion with the
    // pairing CHECK deleted.
    const h = makeHarness();
    const actorId = target(h, "restricted");
    const permit = claim(h, actorId, "m1");

    const foreign = new Database(join(h.root, "state.sqlite"));
    try {
      foreign.function("acp_turn_materialization_authorized", (_turnRequestId: unknown) => 1);
      const insert = foreign.prepare(
        `INSERT INTO canonical_turn_observations
           (turn_request_id, observed_outcome, observing_authority, receipt_id, evidence_digest,
            reason_code, observed_at, audit_event_id)
         VALUES (?, ?, 'OPERATOR_AFTER_REVIEW', ?, 'sha256:x', 'OK', ?,
                 (SELECT MIN(event_id) FROM audit_events))`,
      );
      expect(() => insert.run(permit.turnRequestId, "COMPLETED", "op-1", NOW)).toThrow(/CHECK constraint/);
      expect(() => insert.run(permit.turnRequestId, "NEVER_ADMITTED", "op-2", NOW)).toThrow(/CHECK constraint/);
      // ABORTED is the one it may record.
      expect(() => insert.run(permit.turnRequestId, "ABORTED", "op-3", NOW)).not.toThrow();
    } finally {
      foreign.close();
    }
  });

  it("is reachable on a parked daemon, where the state is most likely to be met", () => {
    // A daemon that parked for something else is exactly when an operator is looking at unresolved
    // turns, and the door has to be open there or the report is again a remedy nothing can carry
    // out.
    expect(BOOTSTRAP_OPERATOR_METHODS.has(OPERATOR_METHOD.CONVERSATION_UNRESOLVED)).toBe(true);
    expect(BOOTSTRAP_OPERATOR_METHODS.has(OPERATOR_METHOD.CONVERSATION_RESOLVE)).toBe(true);
  });
});
