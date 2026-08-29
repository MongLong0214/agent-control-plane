import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { admitInbound, makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * What makes an authority truthful is *when* it can be reached, and that is now a row.
 *
 * The permit's signature covers the turn, the actor and the prompt digest. It does not cover the
 * outcome or the authority, so `ports.preDispatch.neverAdmitted` was a caller *saying* nothing ran
 * — reachable after a dispatch exactly as easily as before one. The retry rule then admits attempt
 * 2 while attempt 1 may still commit, which is the duplicate the whole ledger exists to prevent
 * (#662).
 *
 * Signing the outcome into the permit does not close it: the caller would hold a signature for
 * every outcome it might report and pick one. The phase is the checkable part, because the ledger
 * can watch the phase happen.
 *
 * The check is deliberately asymmetric, and the tests below are mostly about the half that is
 * *not* refused.
 */
type Harness = ReturnType<typeof makeHarness>;

const NOW = "2026-08-22T00:00:00.000Z";

const target = (h: Harness, name: string): string => {
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

const claim = (h: Harness, actorId: string, nonce: string, attempt = 1) => {
  // `claim()` now requires ingress to have admitted the (channel, nonce) a source names, with the
  // same payload it names (#666).
  admitInbound(h, { nonce, payload: {} });
  const decision = h.cp.conversation.claim({
    targetActorId: actorId,
    prompt: "hello",
    sources: [{ channel: "telegram", nonce, attempt, payload: {} }],
  });
  if (!decision.allowed) throw new Error(`claim refused: ${decision.reasonCode}`);
  return decision.value;
};

describe("a turn that was dispatched cannot be reported as never started", () => {
  it("refuses the claim that contradicts the ledger's own record", async () => {
    // The defect, stated as a sequence: dispatch, then say nothing ran, then retry. Before the
    // dispatch row existed every step was permitted and the owner's message went out twice.
    const h = makeHarness();
    const actorId = target(h, "dispatched");
    const permit = claim(h, actorId, "m1");

    expect((await h.cp.conversation.dispatch(permit, () => undefined)).allowed).toBe(true);

    const refused = h.cp.conversation.ports.preDispatch.neverAdmitted(permit, {
      receiptId: "pre-1",
      evidenceDigest: "sha256:pre",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_PHASE_MISMATCH);

    // Nothing was written, so the turn is still held and the retry is still refused.
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_observations`)).toEqual([]);
    const retry = h.cp.conversation.claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [{ channel: "telegram", nonce: "m1", attempt: 2, payload: {} }],
    });
    expect(retry.allowed).toBe(false);
  });

  it("still admits a pre-dispatch refusal when nothing was dispatched", async () => {
    // The case the port exists for, and the one that must keep working: a refusal that happened
    // before the peer was ever spoken to. It is the difference between a transient outage
    // releasing the conversation and wedging it (#651).
    const h = makeHarness();
    const actorId = target(h, "never");
    const permit = claim(h, actorId, "m1");

    expect(
      h.cp.conversation.ports.preDispatch.neverAdmitted(permit, {
        receiptId: "pre-1",
        evidenceDigest: "sha256:pre",
        reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
      }).allowed,
    ).toBe(true);
    expect(
      h.cp.conversation.claim({
        targetActorId: actorId,
        prompt: "hello",
        sources: [{ channel: "telegram", nonce: "m1", attempt: 2, payload: {} }],
      }).allowed,
    ).toBe(true);
  });

  it("admits a target receipt for a turn it has no dispatch row for", async () => {
    // The asymmetry, and the reason for it. A completion arriving with no dispatch row is either a
    // caller that skipped `markDispatching` or a genuine late receipt after a mistaken refusal.
    // Refusing it discards a true record to punish a bookkeeping mistake — which is exactly what
    // #662 named when it said the old first-settlement-wins rule lost the *true* one.
    const h = makeHarness();
    const actorId = target(h, "late");
    const permit = claim(h, actorId, "m1");

    const recorded = h.cp.conversation.ports.target.completed(permit, {
      receiptId: "target-1",
      evidenceDigest: "sha256:receipt",
      reasonCode: ReasonCode.OK,
    });
    expect(recorded.allowed).toBe(true);
    expect(
      h.cp.db.get<{ outcome_kind: string }>(`SELECT outcome_kind FROM canonical_turns`)?.outcome_kind,
    ).toBe("COMPLETED");
  });
});

describe("a dispatch is recorded once, by the coordinator, and cannot be taken back", () => {
  it("refuses a second dispatch of the same turn", async () => {
    // A second dispatch is the owner's message delivered twice — the thing counted, not the row.
    const h = makeHarness();
    const actorId = target(h, "twice");
    const permit = claim(h, actorId, "m1");

    expect((await h.cp.conversation.dispatch(permit, () => undefined)).allowed).toBe(true);
    const second = await h.cp.conversation.dispatch(permit, () => undefined);
    expect(second.allowed).toBe(false);
    if (!second.allowed) {
      expect(second.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_ALREADY_DISPATCHED);
    }
  });

  it("holds the turn when the send fails, whichever side of the target it failed on", async () => {
    // The cost of writing the row first, pinned so it is not rediscovered as a bug. A send that
    // failed *before* the target was reached leaves the same durable state as one that failed
    // after, because a thrown error does not say whether the peer received anything. The choice is
    // which way to be wrong, and a duplicate is unrecoverable where a held turn is not.
    const h = makeHarness();
    const actorId = target(h, "failed");
    const permit = claim(h, actorId, "m1");

    await expect(
      h.cp.conversation.dispatch(permit, () => {
        throw new Error("connection refused before the request left");
      }),
    ).rejects.toThrow(/connection refused/);

    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_dispatches`)).toHaveLength(1);
    const refused = h.cp.conversation.ports.preDispatch.neverAdmitted(permit, {
      receiptId: "pre-1",
      evidenceDigest: "sha256:pre",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });
    expect(refused.allowed).toBe(false);

    // And the exit, which is why the cost is acceptable: the operator door settles it ABORTED, and
    // asks for a fence precisely because the process that failed to send may still be alive.
    const resolved = h.cp.conversation.resolveInDoubt({
      targetActorId: actorId,
      turnRequestId: permit.turnRequestId,
      reasonCode: ReasonCode.OK,
      evidenceDigest: "sha256:operator-checked-the-transcript",
      fenceAsserted: true,
    });
    expect(resolved.allowed).toBe(true);
    expect(
      h.cp.conversation.claim({
        targetActorId: actorId,
        prompt: "hello",
        sources: [{ channel: "telegram", nonce: "m1", attempt: 2, payload: {} }],
      }).allowed,
    ).toBe(true);
  });

  it("refuses a permit this coordinator did not issue", async () => {
    const h = makeHarness();
    const actorId = target(h, "forged");
    const permit = claim(h, actorId, "m1");

    const refused = await h.cp.conversation.dispatch({ ...permit, issuance: "00".repeat(32) }, () => undefined);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_PERMIT_UNISSUED);
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_dispatches`)).toEqual([]);
  });

  it("refuses a turn that is already settled", async () => {
    const h = makeHarness();
    const actorId = target(h, "settled");
    const permit = claim(h, actorId, "m1");
    h.cp.conversation.ports.preDispatch.neverAdmitted(permit, {
      receiptId: "pre-1",
      evidenceDigest: "sha256:pre",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });

    const refused = await h.cp.conversation.dispatch(permit, () => undefined);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reasonCode).toBe(ReasonCode.CONFLICT);
  });

  it("refuses an ordinary handle, and cannot refuse a handle that registers the scalar", async () => {
    // The row decides which claims are admissible, so a caller that can write it directly can
    // decide that for itself — which is the self-certification this table exists to stop.
    //
    // The name of this test used to be "cannot be written or removed by anything but the
    // materializer", which is wider than the schema enforces, and a review said so. The authority
    // guard is a connection-local SQL function: a separate process with its own SQLite handle can
    // register a scalar of the same name returning 1 and forge a *first* dispatch row. What it
    // still cannot do is update, delete or replace one, because those three guards are
    // unconditional. That is the ceiling, and it is asserted here rather than described.
    const h = makeHarness();
    const actorId = target(h, "guarded");
    const permit = claim(h, actorId, "m1");
    expect((await h.cp.conversation.dispatch(permit, () => undefined)).allowed).toBe(true);

    expect(() =>
      h.cp.db.run(
        `INSERT INTO canonical_turn_dispatches (turn_request_id, dispatched_at, audit_event_id)
         VALUES ('forged', ?, (SELECT MIN(event_id) FROM audit_events))`,
        [NOW],
      ),
    ).toThrow(/CANONICAL_TURN_DISPATCH_AUTHORITY_DENIED/);
    expect(() => h.cp.db.run(`DELETE FROM canonical_turn_dispatches`)).toThrow(
      /CANONICAL_TURN_DISPATCH_IMMUTABLE/,
    );
    expect(() => h.cp.db.run(`UPDATE canonical_turn_dispatches SET dispatched_at = ?`, [NOW])).toThrow(
      /CANONICAL_TURN_DISPATCH_IMMUTABLE/,
    );

    const foreign = new Database(join(h.root, "state.sqlite"));
    try {
      foreign.function("acp_turn_materialization_authorized", (_turnRequestId: unknown) => 1);

      // `INSERT OR REPLACE` deletes the conflicting row first and so walks past the update and
      // delete guards. Refused, even for this handle.
      expect(() =>
        foreign
          .prepare(
            `INSERT OR REPLACE INTO canonical_turn_dispatches
               (turn_request_id, dispatched_at, audit_event_id)
             VALUES (?, ?, (SELECT MIN(event_id) FROM audit_events))`,
          )
          .run(permit.turnRequestId, NOW),
      ).toThrow(/CANONICAL_TURN_DISPATCH_NO_REPLACE/);

      // And the ceiling, asserted so it is a measured boundary rather than a claim: a first row for
      // an *undispatched* turn goes in. The authority trigger authenticates a function name on the
      // caller's own connection, and that handle can also DROP TRIGGER — so what these guards bind
      // is in-process writers and DML-only callers. #638's signed receipt is what closes it.
      const undispatched = claim(h, target(h, "second"), "m2");
      expect(() =>
        foreign
          .prepare(
            `INSERT INTO canonical_turn_dispatches (turn_request_id, dispatched_at, audit_event_id)
             VALUES (?, ?, (SELECT MIN(event_id) FROM audit_events))`,
          )
          .run(undispatched.turnRequestId, NOW),
      ).not.toThrow();
    } finally {
      foreign.close();
    }
  });
});
