import { afterAll, describe, expect, it } from "vitest";

import { ConversationTurnCoordinator } from "../../src/conversation/turn-coordinator.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Raw SQL against the ledger, because the coordinator is not the only writer.
 *
 * Every existing test of this ledger drives `ConversationTurnCoordinator`, which is exactly why
 * the mutability hole survived review: a suite that only ever enters through the component under
 * test cannot discover that the component is not the boundary. The defect was reported by an
 * external reviewer running a probe, and reproduced here before the triggers were written —
 * rewriting a settled `COMPLETED` to `ABORTED` with a plain `UPDATE` made the retry rule admit
 * attempt 2, so a completed exchange could be run a second time into the owner's conversation.
 *
 * So these use `db.run` deliberately. They are the counterexamples the schema has to refuse.
 */
type Harness = ReturnType<typeof makeHarness>;

const NOW = "2026-08-21T00:00:00.000Z";

const target = (h: Harness): string => {
  h.cp.db.run(`INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES ('a','CEO',?)`, [NOW]);
  h.cp.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES ('b','a','hermes','locator','digest',?)`,
    [NOW],
  );
  h.cp.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, attested_at)
     VALUES ('t','b','v1','att','ses','inc',1,?)`,
    [NOW],
  );
  return "a";
};

const settledTurn = (h: Harness): string => {
  const coordinator = new ConversationTurnCoordinator(h.cp.db, h.cp.clock, h.cp.audit);
  const claimed = coordinator.claim({
    targetActorId: target(h),
    prompt: "question",
    sources: [{ channel: "telegram", nonce: "n1", attempt: 1, payload: {} }],
  });
  if (!claimed.allowed) throw new Error(`claim refused: ${claimed.reasonCode}`);
  const settled = coordinator.observe(claimed.value, {
    outcome: "COMPLETED",
    authority: "HERMES_TARGET",
    receiptId: "receipt-1",
    evidenceDigest: "sha256:reply",
    reasonCode: ReasonCode.OK,
  });
  if (!settled.allowed) throw new Error(`observe refused: ${settled.reasonCode}`);
  return claimed.value.turnRequestId;
};

describe("a settlement cannot be rewritten", () => {
  it("refuses to weaken the outcome of a settled turn", () => {
    // The measured defect. Before the trigger, this succeeded and the retry became legal —
    // COMPLETED forbids a re-run and ABORTED permits one, so lowering it re-opens a finished
    // exchange.
    const h = makeHarness();
    const turnRequestId = settledTurn(h);

    expect(() =>
      h.cp.db.run(`UPDATE canonical_turns SET outcome_kind = 'ABORTED' WHERE turn_request_id = ?`, [
        turnRequestId,
      ]),
    ).toThrow(/CANONICAL_TURN_MATERIALIZATION_AUTHORITY_DENIED/);
  });

  it("refuses to clear the outcome of a settled turn", () => {
    const h = makeHarness();
    const turnRequestId = settledTurn(h);

    expect(() =>
      h.cp.db.run(`UPDATE canonical_turns SET outcome_kind = NULL WHERE turn_request_id = ?`, [
        turnRequestId,
      ]),
    ).toThrow(/CANONICAL_TURN_MATERIALIZATION_AUTHORITY_DENIED/);
  });

  it("refuses to put a settled turn back in doubt", () => {
    // That would place the hold back on a conversation whose outcome is known.
    const h = makeHarness();
    const turnRequestId = settledTurn(h);

    expect(() =>
      h.cp.db.run(`UPDATE canonical_turns SET lifecycle_state = 'IN_DOUBT' WHERE turn_request_id = ?`, [
        turnRequestId,
      ]),
    ).toThrow(/CANONICAL_TURN_MATERIALIZATION_AUTHORITY_DENIED/);
  });

  it("refuses to weaken an outcome even from inside the materializer", () => {
    // The authority trigger stops an outsider. This one stops the materializer itself, and it is
    // the only place the weakening rule is reachable — so it is tested with the marker held,
    // which is where it actually stands.
    const h = makeHarness();
    const turnRequestId = settledTurn(h);

    expect(() =>
      h.cp.db.materializeTurn(
        { turnRequestId, outcome: "ABORTED", authority: "HERMES_TARGET", consistency: "CONSISTENT" },
        () =>
          h.cp.db.run(
            `UPDATE canonical_turns SET outcome_kind='ABORTED', resolution_authority='HERMES_TARGET'
              WHERE turn_request_id = ?`,
            [turnRequestId],
          ),
      ),
    ).toThrow(/CANONICAL_TURN_OUTCOME_WEAKENED/);
  });

  it("refuses to repoint a turn at another actor", () => {
    const h = makeHarness();
    const turnRequestId = settledTurn(h);

    expect(() =>
      h.cp.db.run(`UPDATE canonical_turns SET target_actor_id = 'someone-else' WHERE turn_request_id = ?`, [
        turnRequestId,
      ]),
    ).toThrow(/CANONICAL_TURN_IDENTITY_IMMUTABLE/);
  });

  it("refuses to edit or remove an observation", () => {
    // The outcome is computed from these. Editing one rewrites the testimony it was computed
    // from, which is the same defect one level down.
    const h = makeHarness();
    settledTurn(h);

    expect(() => h.cp.db.run(`UPDATE canonical_turn_observations SET observed_outcome = 'ABORTED'`)).toThrow(
      /CANONICAL_TURN_OBSERVATION_APPEND_ONLY/,
    );
    expect(() => h.cp.db.run(`DELETE FROM canonical_turn_observations`)).toThrow(
      /CANONICAL_TURN_OBSERVATION_APPEND_ONLY/,
    );
  });

  it("refuses to delete a settled turn", () => {
    const h = makeHarness();
    const turnRequestId = settledTurn(h);

    expect(() => h.cp.db.run(`DELETE FROM canonical_turns WHERE turn_request_id = ?`, [turnRequestId])).toThrow(
      /CANONICAL_TURN_NO_DELETE/,
    );
  });

  it("still lets the coordinator settle a turn that is in doubt", () => {
    // The other direction. A trigger that also blocked the legitimate settlement would make the
    // ledger append-only by making it useless.
    const h = makeHarness();
    expect(() => settledTurn(h)).not.toThrow();
  });

  it("refuses to delete a turn that is merely in doubt, which would clear the hold", () => {
    // The hold is releasable only by an observed outcome. Deleting the row releases it and
    // leaves nothing behind that says so.
    const h = makeHarness();
    const coordinator = new ConversationTurnCoordinator(h.cp.db, h.cp.clock, h.cp.audit);
    const claimed = coordinator.claim({
      targetActorId: target(h),
      prompt: "q",
      sources: [{ channel: "telegram", nonce: "n1", attempt: 1, payload: {} }],
    });
    if (!claimed.allowed) throw new Error("claim refused");

    expect(() =>
      h.cp.db.run(`DELETE FROM canonical_turns WHERE turn_request_id = ?`, [claimed.value.turnRequestId]),
    ).toThrow(/CANONICAL_TURN_NO_DELETE/);
  });
});

describe("the sources a turn consumed cannot be edited away", () => {
  it("refuses to delete a source", () => {
    const h = makeHarness();
    settledTurn(h);

    expect(() => h.cp.db.run(`DELETE FROM canonical_turn_sources`)).toThrow(
      /CANONICAL_TURN_SOURCE_IMMUTABLE/,
    );
  });

  it("refuses to repoint a source at another turn", () => {
    const h = makeHarness();
    settledTurn(h);

    expect(() =>
      h.cp.db.run(`UPDATE canonical_turn_sources SET source_nonce = 'n2'`),
    ).toThrow(/CANONICAL_TURN_SOURCE_IMMUTABLE/);
  });

  it("carries a real audit row, filled at insert rather than patched later", () => {
    // The column is a foreign key to `audit_events(event_id)` and NOT NULL, so it cannot be left
    // empty and filled in afterwards — which is what an append-only table that needs an UPDATE to
    // become complete actually is.
    const h = makeHarness();
    settledTurn(h);

    const link = h.cp.db.get<{ admission_audit_event_id: number }>(
      `SELECT admission_audit_event_id FROM canonical_turn_sources`,
    );
    expect(link?.admission_audit_event_id).toBeGreaterThan(0);
    expect(
      h.cp.db.get(`SELECT 1 FROM audit_events WHERE event_id = ?`, [link?.admission_audit_event_id]),
    ).toBeTruthy();
    expect(() =>
      h.cp.db.run(`UPDATE canonical_turn_sources SET admission_audit_event_id = 1`),
    ).toThrow(/CANONICAL_TURN_SOURCE_IMMUTABLE/);
  });
});

describe("a binding and its attestations are append-only", () => {
  it("refuses to edit an attestation's generation", () => {
    // The one that matters for admission: `claim()` reads the latest attestation, so an editable
    // one lets a stale generation be presented as current.
    const h = makeHarness();
    target(h);

    expect(() =>
      h.cp.db.run(`UPDATE actor_target_attestations SET binding_generation = 9`),
    ).toThrow(/ACTOR_TARGET_ATTESTATION_APPEND_ONLY/);
  });

  it("refuses to delete an attestation a settled turn cites", () => {
    const h = makeHarness();
    settledTurn(h);

    expect(() => h.cp.db.run(`DELETE FROM actor_target_attestations`)).toThrow(
      /ACTOR_TARGET_ATTESTATION_APPEND_ONLY/,
    );
  });

  it("refuses to repoint a binding at another conversation", () => {
    // The alias the four-table shape exists to refuse, arriving by edit rather than by insert.
    const h = makeHarness();
    target(h);

    expect(() =>
      h.cp.db.run(`UPDATE actor_target_bindings SET target_locator = 'somewhere-else'`),
    ).toThrow(/ACTOR_TARGET_BINDING_IMMUTABLE/);
  });

  it("refuses to delete a binding, which would free its locator for another actor", () => {
    const h = makeHarness();
    target(h);

    expect(() => h.cp.db.run(`DELETE FROM actor_target_bindings`)).toThrow(
      /ACTOR_TARGET_BINDING_IMMUTABLE/,
    );
  });
});

describe("an outcome may only be recorded under an authority that could have observed it", () => {
  const settledRow = (outcome: string, authority: string, auditId = 1) => `
    INSERT INTO canonical_turns
      (turn_request_id, target_actor_id, target_binding_id, target_attestation_id,
       executor_session_id, executor_session_incarnation, binding_generation,
       prompt_digest, claimed_at, claim_audit_event_id, lifecycle_state, outcome_kind, settled_at,
       resolution_authority, reason_code, evidence_digest)
    VALUES ('x','a','b','t','ses','inc',1,'p','${NOW}',${auditId},'SETTLED','${outcome}','${NOW}',
            '${authority}','OK','e')`;

  it("refuses COMPLETED under pre-dispatch authority", () => {
    // Measured before the CHECK existed: accepted. An authority that by definition saw nothing
    // run was recording a completion.
    const h = makeHarness();
    target(h);
    h.cp.db.run(`INSERT INTO audit_events (at, kind, evidence_json) VALUES (?, 'FIXTURE', '{}')`, [NOW]);

    expect(() => h.cp.db.run(settledRow("COMPLETED", "ACP_PRE_DISPATCH"))).toThrow();
  });

  it("refuses NEVER_ADMITTED under the target's authority", () => {
    const h = makeHarness();
    target(h);

    expect(() => h.cp.db.run(settledRow("NEVER_ADMITTED", "HERMES_TARGET"))).toThrow();
  });

  it("refuses COMPLETED under ACP's own observation, because watching is not proving", () => {
    // The authority argument, as a constraint. ACP seeing a reply come back is real evidence and
    // is recorded as an observation — but a turn marked COMPLETED is never re-run, so getting it
    // wrong loses the owner's message rather than duplicating it.
    const h = makeHarness();
    target(h);

    expect(() => h.cp.db.run(settledRow("COMPLETED", "ACP_OBSERVED_HERMES_REPLY"))).toThrow();
  });

  it("refuses ABORTED under ACP's own observation, because ACP cannot fence", () => {
    // ABORTED is what legalises attempt 2 and it requires a fence. ACP watching a reply is not
    // one, and neither is ACP killing a child.
    const h = makeHarness();
    target(h);

    expect(() => h.cp.db.run(settledRow("ABORTED", "ACP_OBSERVED_HERMES_REPLY"))).toThrow();
  });

  it("refuses a settlement with no observation behind it", () => {
    // Reproduced on the previous head: an ordinary UPDATE from IN_DOUBT/NULL to a syntactically
    // valid SETTLED row succeeded with zero observations, and the retry rule then read that
    // forged outcome and admitted attempt 2. The outcome-weakening trigger did not fire because
    // it only guards a row that was already settled.
    const h = makeHarness();
    const coordinator = new ConversationTurnCoordinator(h.cp.db, h.cp.clock, h.cp.audit);
    const claimed = coordinator.claim({
      targetActorId: target(h),
      prompt: "q",
      sources: [{ channel: "telegram", nonce: "n1", attempt: 1, payload: {} }],
    });
    if (!claimed.allowed) throw new Error("claim refused");

    for (const [outcome, authority] of [
      ["NEVER_ADMITTED", "ACP_PRE_DISPATCH"],
      ["ABORTED", "HERMES_TARGET"],
      ["COMPLETED", "HERMES_TARGET"],
    ] as const) {
      expect(() =>
        h.cp.db.run(
          `UPDATE canonical_turns
              SET lifecycle_state='SETTLED', outcome_kind=?, settled_at=?,
                  resolution_authority=?, reason_code='OK', evidence_digest='forged'
            WHERE turn_request_id = ?`,
          [outcome, NOW, authority, claimed.value.turnRequestId],
        ),
      ).toThrow(/CANONICAL_TURN_MATERIALIZATION_AUTHORITY_DENIED/);
    }
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_observations`)).toHaveLength(0);
  });

  it("refuses to lift a quarantine without going through the materializer", () => {
    // The only exit an operator had was a raw UPDATE that no trigger guarded, took no citation,
    // and left no audit row — so the sanctioned repair was an unaudited hand-edit.
    const h = makeHarness();
    const coordinator = new ConversationTurnCoordinator(h.cp.db, h.cp.clock, h.cp.audit);
    const claimed = coordinator.claim({
      targetActorId: target(h),
      prompt: "q",
      sources: [{ channel: "telegram", nonce: "n1", attempt: 1, payload: {} }],
    });
    if (!claimed.allowed) throw new Error("claim refused");
    coordinator.observe(claimed.value, {
      outcome: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      receiptId: "p1",
      evidenceDigest: "sha256:a",
      reasonCode: ReasonCode.OK,
    });
    coordinator.observe(claimed.value, {
      outcome: "COMPLETED",
      authority: "HERMES_TARGET",
      receiptId: "t1",
      evidenceDigest: "sha256:b",
      reasonCode: ReasonCode.OK,
    });

    // Forward, and refused for want of authority: an adjudication is a real transition, so what
    // stops this one is that nobody authorised it.
    expect(() =>
      h.cp.db.run(`UPDATE canonical_turns SET observation_consistency = 'ADJUDICATED'`),
    ).toThrow(/CANONICAL_TURN_MATERIALIZATION_AUTHORITY_DENIED/);
    // Backward, and refused twice over: erasing a disagreement is not a transition at all, so
    // even the materializer cannot do it.
    expect(() =>
      h.cp.db.run(`UPDATE canonical_turns SET observation_consistency = 'CONSISTENT'`),
    ).toThrow(/CANONICAL_TURN_CONSISTENCY_NOT_MONOTONE/);
  });

  it("refuses to rewrite the evidence or the terminal time of a settled turn", () => {
    // The outcome was frozen and its provenance was not, so the receipt digest a later gate
    // corroborates against could be swapped while the outcome stayed COMPLETED.
    const h = makeHarness();
    const turnRequestId = settledTurn(h);

    for (const column of ["evidence_digest", "reason_code", "settled_at"]) {
      expect(() =>
        h.cp.db.run(`UPDATE canonical_turns SET ${column} = 'tampered' WHERE turn_request_id = ?`, [
          turnRequestId,
        ]),
      ).toThrow();
    }
  });

  it("accepts each pairing an authority could actually testify to", () => {
    const h = makeHarness();
    target(h);
    h.cp.db.run(`INSERT INTO audit_events (at, kind, evidence_json) VALUES (?, 'FIXTURE', '{}')`, [NOW]);
    const accepted: readonly [string, string][] = [
      ["NEVER_ADMITTED", "ACP_PRE_DISPATCH"],
      ["COMPLETED", "HERMES_TARGET"],
      ["ABORTED", "HERMES_TARGET"],
      ["ABORTED", "OWNER_AFTER_TARGET_FENCE"],
    ];

    // Inserted directly rather than updated, because the authority trigger guards UPDATE — an
    // INSERT of a settled row is a different hole and is named in its own issue. What this pins
    // is only that the CHECK accepts these five pairings and refuses the others.
    for (const [outcome, authority] of accepted) {
      h.cp.db.run(settledRow(outcome, authority).replace("'x'", `'x_${outcome}_${authority}'`));
    }
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turns`)).toHaveLength(accepted.length);
  });
});
