import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, makeCore } from "../helpers/fixtures.ts";
import { admitInbound, makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The v22 ledger's value is entirely in what the database refuses.
 *
 * The shape it replaces named "one outstanding turn per conversation" and enforced nothing of
 * the kind: the unique index was on the source message, the target column held a digest of the
 * wrong conversation, and two in-doubt rows for one target were accepted. Every one of those was
 * a property stated in a comment and absent from the schema.
 *
 * So these tests are counterexamples rather than examples. Each one writes the thing that must
 * not be writable and requires SQLite to say no — because a constraint nobody has tried to
 * violate is indistinguishable from one that is not there.
 */
type Harness = ReturnType<typeof makeHarness>;

const NOW = "2026-08-21T00:00:00.000Z";

const actor = (h: Harness, id: string): string => {
  h.cp.db.run(
    `INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'CEO', ?)`,
    [id, NOW],
  );
  return id;
};

const binding = (h: Harness, id: string, actorId: string, locator: string): string => {
  h.cp.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [id, actorId, locator, `digest:${locator}`, NOW],
  );
  return id;
};

/**
 * An attestation, plus the runtime session and active role assignment `claim()`'s currency check
 * (#666) reads to decide the attestation still names the actor's current generation.
 */
const attestation = (h: Harness, id: string, bindingId: string): string => {
  const owner = h.cp.db.get<{ target_actor_id: string }>(
    `SELECT target_actor_id FROM actor_target_bindings WHERE target_binding_id = ?`,
    [bindingId],
  );
  const actorId = owner!.target_actor_id;
  const sessionId = `ses:${id}`;
  h.cp.db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
    [sessionId, NOW, NOW],
  );
  h.cp.db.run(
    `UPDATE conversational_actors SET current_session_id = ?, current_session_incarnation = 'inc-1'
      WHERE actor_id = ?`,
    [sessionId, actorId],
  );
  h.cp.db.run(
    `INSERT INTO assignments
       (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
        binding_generation, mode, status, created_at)
     VALUES (?, ?, 'CEO', ?, ?, 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
    [`asg:${id}`, `CEO:${id}`, actorId, sessionId, NOW],
  );
  h.cp.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, attested_at)
     VALUES (?, ?, 'v1', ?, ?, 'inc-1', 1, ?)`,
    [id, bindingId, `att:${id}`, sessionId, NOW],
  );
  return id;
};

/**
 * A real audit row, and its real id.
 *
 * `claim_audit_event_id` is a foreign key to `audit_events(event_id)` now, so a fixture cannot
 * invent one. That is the point of the change it came from: the shape this replaces stored a
 * minted `ev_<uuid>` string that identified no row, and a fixture could satisfy it with anything.
 */
const auditEvent = (h: Harness, kind = "FIXTURE"): number => {
  h.cp.db.run(
    `INSERT INTO audit_events (at, kind, evidence_json) VALUES (?, ?, '{}')`,
    [NOW, kind],
  );
  return Number(
    (h.cp.db.get<{ event_id: number }>(`SELECT MAX(event_id) AS event_id FROM audit_events`) ?? {
      event_id: 0,
    }).event_id,
  );
};

const inDoubtTurn = (
  h: Harness,
  turnId: string,
  actorId: string,
  bindingId: string,
  attestationId: string,
): void => {
  h.cp.db.run(
    `INSERT INTO canonical_turns
       (turn_request_id, target_actor_id, target_binding_id, target_attestation_id,
        executor_session_id, executor_session_incarnation, binding_generation,
        prompt_digest, claimed_at, claim_audit_event_id, lifecycle_state)
     VALUES (?, ?, ?, ?, 'ses-1', 'inc-1', 1, 'prompt', ?, ?, 'IN_DOUBT')`,
    [turnId, actorId, bindingId, attestationId, NOW, auditEvent(h)],
  );
};

/**
 * Settles a turn the way production does, through the coordinator the composition root owns.
 *
 * A plain `UPDATE` no longer settles anything — that was the hole where an ordinary statement
 * produced a settled row with zero observations behind it. Raising the marker needs a capability
 * that the composition root now claims while it is still constructing itself, so the fixture
 * cannot claim it and does not try: it settles the way production does, through the coordinator
 * the root owns. The turn it settles is a real one, which is the point — a hand-built settled row
 * is exactly what the capability exists to refuse.
 */
const settleThroughCoordinator = (h: Harness, actorId: string, nonce: string, outcome: "COMPLETED" | "NEVER_ADMITTED"): string => {
  // `claim()` now requires ingress to have admitted the (channel, nonce) a source names, with the
  // same payload it names (#666).
  admitInbound(h, { nonce, payload: {} });
  const claimed = h.cp.conversation.claim({
    targetActorId: actorId,
    prompt: nonce,
    sources: [{ channel: "telegram", nonce, attempt: 1, payload: {} }],
  });
  if (!claimed.allowed) throw new Error(`claim refused: ${claimed.reasonCode}`);
  const receipt = { receiptId: `receipt:${nonce}`, evidenceDigest: "sha256:e", reasonCode: "OK" };
  const observed =
    outcome === "COMPLETED"
      ? h.cp.conversation.ports.target.completed(claimed.value, receipt)
      : h.cp.conversation.ports.preDispatch.neverAdmitted(claimed.value, receipt);
  if (!observed.allowed) throw new Error(`observe refused: ${observed.reasonCode}`);
  return claimed.value.turnRequestId;
};

/** A fully-populated target for an actor, which every turn needs before it can exist. */
const target = (h: Harness, suffix: string) => {
  const a = actor(h, `actor:${suffix}`);
  const b = binding(h, `bind:${suffix}`, a, `root:${suffix}`);
  const t = attestation(h, `att:${suffix}`, b);
  return { actorId: a, bindingId: b, attestationId: t };
};

describe("one target per actor, one actor per target", () => {
  it("refuses a second target for an actor that already has one", () => {
    // The alias in the other direction from a re-bootstrap: an actor pointed at two transcripts
    // partitions turns it cannot actually serialise.
    const h = makeHarness();
    const a = actor(h, "actor:one");
    binding(h, "bind:a", a, "root:a");

    expect(() => binding(h, "bind:b", a, "root:b")).toThrow();
  });

  it("refuses a second actor for a target that already has one", () => {
    // The re-bootstrap alias itself. `bind()` mints a fresh actor every time, so without this a
    // recovery produces two owners of one transcript and their holds never collide.
    const h = makeHarness();
    binding(h, "bind:a", actor(h, "actor:a"), "root:shared");

    expect(() => binding(h, "bind:b", actor(h, "actor:b"), "root:shared")).toThrow();
  });

  it("holds across retirement, not only while active", () => {
    // A lifetime bijection rather than an active-only one. If retiring an actor freed its
    // target, the alias would come back through exactly the path that motivated the constraint.
    const h = makeHarness();
    const a = actor(h, "actor:retired");
    binding(h, "bind:retired", a, "root:x");
    h.cp.db.run(
      `UPDATE conversational_actors SET retired_at = ?, retired_reason = 'test' WHERE actor_id = ?`,
      [NOW, a],
    );

    expect(() => binding(h, "bind:new", actor(h, "actor:fresh"), "root:x")).toThrow();
  });
});

describe("a turn cannot cite a target it does not belong to", () => {
  it("refuses a binding that belongs to another actor", () => {
    const h = makeHarness();
    const mine = target(h, "mine");
    const theirs = target(h, "theirs");

    expect(() =>
      inDoubtTurn(h, "turn:1", mine.actorId, theirs.bindingId, theirs.attestationId),
    ).toThrow();
  });

  it("refuses an attestation from another binding", () => {
    // The composite FK's second half. An attestation is evidence *for a binding*; accepting one
    // from elsewhere would let a turn carry proof of something it is not doing.
    const h = makeHarness();
    const mine = target(h, "mine2");
    const theirs = target(h, "theirs2");

    expect(() =>
      inDoubtTurn(h, "turn:2", mine.actorId, mine.bindingId, theirs.attestationId),
    ).toThrow();
  });

  it("refuses a turn with no attestation at all", () => {
    // This is what keeps admission closed before the target protocol exists. There is no way to
    // write a turn without evidence, so the embargo is a property of the schema rather than a
    // rule someone follows.
    const h = makeHarness();
    const t = target(h, "unattested");

    expect(() =>
      h.cp.db.run(
        `INSERT INTO canonical_turns
           (turn_request_id, target_actor_id, target_binding_id, target_attestation_id,
            executor_session_id, executor_session_incarnation, binding_generation,
            prompt_digest, claimed_at, claim_audit_event_id, lifecycle_state)
         VALUES ('turn:3', ?, ?, NULL, 'ses-1', 'inc-1', 1, 'prompt', ?, ?, 'IN_DOUBT')`,
        [t.actorId, t.bindingId, NOW, auditEvent(h)],
      ),
    ).toThrow();
  });
});

describe("one unresolved turn per actor", () => {
  it("refuses a second in-doubt turn on the same actor", () => {
    // The property the table is named for, and the one its predecessor did not hold.
    const h = makeHarness();
    const t = target(h, "busy");
    inDoubtTurn(h, "turn:first", t.actorId, t.bindingId, t.attestationId);

    expect(() => inDoubtTurn(h, "turn:second", t.actorId, t.bindingId, t.attestationId)).toThrow();
  });

  it("allows a new one once the first is settled", () => {
    // A partial index rather than a plain one: settled turns accumulate and must not block the
    // conversation forever, which would be the lock-out this design rejects elsewhere.
    const h = makeHarness();
    const t = target(h, "freed");
    settleThroughCoordinator(h, t.actorId, "done", "COMPLETED");

    expect(() => inDoubtTurn(h, "turn:next", t.actorId, t.bindingId, t.attestationId)).not.toThrow();
  });

  it("does not constrain different actors", () => {
    const h = makeHarness();
    const one = target(h, "a1");
    const two = target(h, "a2");
    inDoubtTurn(h, "turn:a1", one.actorId, one.bindingId, one.attestationId);

    expect(() => inDoubtTurn(h, "turn:a2", two.actorId, two.bindingId, two.attestationId)).not.toThrow();
  });
});

describe("a settlement carries what settled it", () => {
  it("refuses an outcome with no authority, reason or evidence", () => {
    // A verdict with nothing behind it is the failure this whole design is about. The CHECK
    // makes "settled" and "we know why" the same statement.
    // On a bare core rather than the harness, because the composition root claims the
    // materialization authority as it constructs itself and a test cannot take it back. Here the
    // test *is* the composition root, so it holds the capability the way production's owner does.
    const core = makeCore();
    const h = { cp: core } as unknown as Harness;
    const authority = core.db.claimTurnMaterializationAuthority();
    const t = target(h, "halfsettled");
    inDoubtTurn(h, "turn:half", t.actorId, t.bindingId, t.attestationId);

    // Held under the materializer's marker, because that is where the CHECK now stands: an
    // unauthorised writer is stopped earlier and by a different rule, which would make this test
    // pass without exercising the constraint it is named for.
    expect(() =>
      h.cp.db.materializeTurn(
        authority,
        { turnRequestId: "turn:half" },
        () =>
          h.cp.db.run(
            `UPDATE canonical_turns
                SET lifecycle_state='SETTLED', outcome_kind='COMPLETED',
                    resolution_authority='HERMES_TARGET'
              WHERE turn_request_id='turn:half'`,
          ),
      ),
    ).toThrow();
  });

  it("refuses an in-doubt turn that carries an outcome", () => {
    // The other direction. A row that says it knows nothing and records an outcome is one of
    // those two things lying, and which one is not recoverable later.
    const h = makeHarness();
    const t = target(h, "doubtful");

    expect(() =>
      h.cp.db.run(
        `INSERT INTO canonical_turns
           (turn_request_id, target_actor_id, target_binding_id, target_attestation_id,
            executor_session_id, executor_session_incarnation, binding_generation,
            prompt_digest, claimed_at, claim_audit_event_id, lifecycle_state, outcome_kind)
         VALUES ('turn:contradiction', ?, ?, ?, 'ses-1', 'inc-1', 1, 'p', ?, ?, 'IN_DOUBT', 'COMPLETED')`,
        [t.actorId, t.bindingId, t.attestationId, NOW, auditEvent(h)],
      ),
    ).toThrow();
  });

  it("has no vocabulary for abandoning a turn", () => {
    // Deliberate. Abandoning without a target fence is not a safe settlement — the stale child
    // may still be writing — so there is no outcome that spells it. An owner break-glass after a
    // real fence is ABORTED with OWNER_AFTER_TARGET_FENCE, which says what actually happened.
    const h = makeHarness();
    const kinds = h.cp.db
      .all<{ outcome_kind: string }>(`SELECT outcome_kind FROM turn_outcome_kinds`)
      .map((row) => row.outcome_kind)
      .sort();

    expect(kinds).toEqual(["ABORTED", "COMPLETED", "NEVER_ADMITTED"]);
  });
});

describe("which messages a turn consumed", () => {
  const source = (
    h: Harness,
    turnId: string,
    nonce: string,
    attempt: number,
    ordinal: number,
    predecessor: string | null,
  ): void => {
    h.cp.db.run(
      `INSERT INTO canonical_turn_sources
         (turn_request_id, source_channel, source_nonce, source_attempt, batch_ordinal,
          source_digest, predecessor_turn_request_id, admission_audit_event_id)
       VALUES (?, 'telegram', ?, ?, ?, ?, ?, ?)`,
      [turnId, nonce, attempt, ordinal, `d:${nonce}`, predecessor, auditEvent(h)],
    );
  };

  it("takes several messages into one turn, in order", () => {
    // Three consecutive owner messages are one turn, not three. Their ids and their order are
    // kept, because the answer has to be able to say what it consumed.
    const h = makeHarness();
    const t = target(h, "batch");
    inDoubtTurn(h, "turn:batch", t.actorId, t.bindingId, t.attestationId);

    source(h, "turn:batch", "update:1", 1, 0, null);
    source(h, "turn:batch", "update:2", 1, 1, null);
    source(h, "turn:batch", "update:3", 1, 2, null);

    const rows = h.cp.db.all<{ source_nonce: string }>(
      `SELECT source_nonce FROM canonical_turn_sources WHERE turn_request_id='turn:batch'
        ORDER BY batch_ordinal`,
    );
    expect(rows.map((r) => r.source_nonce)).toEqual(["update:1", "update:2", "update:3"]);
  });

  it("refuses two messages at the same position in a batch", () => {
    const h = makeHarness();
    const t = target(h, "collide");
    inDoubtTurn(h, "turn:collide", t.actorId, t.bindingId, t.attestationId);
    source(h, "turn:collide", "update:1", 1, 0, null);

    expect(() => source(h, "turn:collide", "update:2", 1, 0, null)).toThrow();
  });

  it("refuses the same message twice in one turn", () => {
    const h = makeHarness();
    const t = target(h, "dup");
    inDoubtTurn(h, "turn:dup", t.actorId, t.bindingId, t.attestationId);
    source(h, "turn:dup", "update:1", 1, 0, null);

    expect(() => source(h, "turn:dup", "update:1", 1, 1, null)).toThrow();
  });

  it("allows a second attempt at a message, which the old schema forbade", () => {
    // The defect this replaces: a global unique on (channel, nonce) meant a second attempt could
    // not get a row at all, so every adjudicated re-run collided with the index. Attempts are
    // numbered instead.
    const h = makeHarness();
    const t = target(h, "retry");
    const first = settleThroughCoordinator(h, t.actorId, "update:9", "NEVER_ADMITTED");
    inDoubtTurn(h, "turn:try2", t.actorId, t.bindingId, t.attestationId);

    expect(() => source(h, "turn:try2", "update:9", 2, 0, first)).not.toThrow();
  });

  it("refuses a first attempt that names a predecessor", () => {
    const h = makeHarness();
    const t = target(h, "firstpred");
    inDoubtTurn(h, "turn:fp", t.actorId, t.bindingId, t.attestationId);

    expect(() => source(h, "turn:fp", "update:x", 1, 0, "turn:fp")).toThrow();
  });

  it("refuses a later attempt with no predecessor", () => {
    // Without this an admission could number itself attempt 2 and skip the check that attempt 1
    // ended safely — the chain would exist in the column and mean nothing.
    const h = makeHarness();
    const t = target(h, "nopred");
    inDoubtTurn(h, "turn:np", t.actorId, t.bindingId, t.attestationId);

    expect(() => source(h, "turn:np", "update:y", 2, 0, null)).toThrow();
  });
});

describe("the migration refuses to guess", () => {
  it("rebuilds when the old table is empty", async () => {
    // Production is empty, so this is the path it takes. The check is that it takes it at all —
    // a rebuild that silently skipped would leave the old shape and its missing constraints.
    const h = makeHarness();

    const tables = h.cp.db
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`)
      .map((row) => row.name);

    expect(tables).toContain("canonical_turns");
    expect(tables).toContain("actor_target_bindings");
    expect(tables).toContain("actor_target_attestations");
    expect(tables).toContain("canonical_turn_sources");
  });

  it("has no column that could hold a guess", () => {
    // The old table's `target_conversation_digest` held a digest of the *source* conversation
    // under a name that promised the target. Deriving actor and target from it would have put a
    // guess where the schema promises a proof, so the column does not survive.
    const h = makeHarness();
    const columns = h.cp.db
      .all<{ name: string }>(`PRAGMA table_info(canonical_turns)`)
      .map((row) => row.name);

    expect(columns).not.toContain("target_conversation_digest");
    expect(columns).toContain("target_actor_id");
    expect(columns).toContain("target_binding_id");
  });
});
