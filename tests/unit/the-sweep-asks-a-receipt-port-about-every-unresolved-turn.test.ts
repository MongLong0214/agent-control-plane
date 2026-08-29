import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  ConversationTurnCoordinator,
  NEVER_FOUND_RECEIPT_PORT,
  type ReceiptLookupQuery,
  type ReceiptLookupResult,
  type ReceiptPort,
  type TurnPermit,
} from "../../src/conversation/turn-coordinator.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { openDb } from "../../src/db/database.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The active half of #639 contract 6 — and the shape a second review (Sol, on #691) found it had
 * to take.
 *
 * The schema and the coordinator's settlement logic already refuse to complete a turn without a
 * matching receipt — that much has stood since #665. What was still missing is anything that
 * *asks*: a turn nobody ever queries about stays `IN_DOUBT` forever even the instant Hermes
 * commits a receipt for it, and contract 6 without a harvester is vacuously true, exactly the
 * hole a blind review found on this issue. `reconcileUnresolved()` is the harvester; `#638` is
 * what makes a real port answer anything but `found: false`.
 *
 * Two rounds of review reshaped this file:
 *
 * 1. The first draft's fake port echoed the query's own actor/prompt back as the receipt's
 *    identity, so a "mismatch" case had to be constructed by calling a settlement method directly
 *    with a hand-built bad query — never through the sweep at all. Fixed by making
 *    `ReceiptLookupResult` carry the identity the receipt itself attests to, independent of the
 *    query, and making the sweep read only that.
 * 2. That fix still left the settlement method itself *public* and receipt-shaped: `{turnRequestId,
 *    targetActorId, promptDigest, bindingGeneration}` and `{outcome, receiptId, evidenceDigest,
 *    reasonCode}` are both ordinary data, and `unresolvedIdentities()` (also public) hands out
 *    everything the first object needs. Anyone holding the coordinator could read a turn's
 *    identity and fabricate a completion with no receipt lookup at all — a forgery the identity
 *    fix from round 1 did nothing to close, because a caller supplying *both* the query and the
 *    receipt satisfies any comparison between them.
 *
 * The fix for round 2 is structural rather than a check: the receipt never arrives as a public
 * argument. `ReceiptPort` is bound once, at construction, and the only method that can act on one
 * is `reconcileUnresolved()`, which performs the lookup itself. There is no public method left
 * that takes a receipt from a caller, so the forgery this file used to demonstrate through direct
 * calls is not a bug the tests below refute — it is a call that no longer type-checks.
 */
type Coordinator = {
  db: ReturnType<typeof openDb>;
  clock: ManualClock;
  coordinator: ConversationTurnCoordinator;
};

const NOW = "2026-08-29T00:00:00.000Z";

/** A private state directory per coordinator, because the loader refuses a world-readable one. */
const stateDir = (): string => {
  const root = join(tempDir("acp-639-reconciler-"), "state");
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o700);
  return root;
};

/**
 * A fresh database and its own coordinator, bound to `port` at construction — the only place a
 * `ReceiptPort` can ever be attached, and exactly why each test needing a different port needs
 * its own coordinator rather than sharing one from a harness.
 */
const withCoordinator = (port: ReceiptPort = NEVER_FOUND_RECEIPT_PORT): Coordinator => {
  const db = openDb(join(stateDir(), "state.sqlite"));
  const clock = new ManualClock(NOW);
  const coordinator = new ConversationTurnCoordinator(db, clock, new AuditLog(db, clock), port);
  return { db, clock, coordinator };
};

const target = (c: Coordinator, name: string, bindingGeneration = 1): string => {
  const actorId = `actor:${name}`;
  c.db.run(`INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'CEO', ?)`, [
    actorId,
    NOW,
  ]);
  c.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [`bind:${name}`, actorId, `locator:${name}`, `digest:${name}`, NOW],
  );
  c.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, attested_at)
     VALUES (?, ?, 'v1', ?, 'ses', 'inc', ?, ?)`,
    [`att:${name}`, `bind:${name}`, `attd:${name}`, bindingGeneration, NOW],
  );
  return actorId;
};

const claim = (c: Coordinator, actorId: string, nonce: string): TurnPermit => {
  const decision = c.coordinator.claim({
    targetActorId: actorId,
    prompt: "hello",
    sources: [{ channel: "telegram", nonce, attempt: 1, payload: {} }],
  });
  if (!decision.allowed) throw new Error(`claim refused: ${decision.reasonCode}`);
  return decision.value;
};

const stateOf = (c: Coordinator, turnRequestId: string) =>
  c.db.get<{ lifecycle_state: string; outcome_kind: string | null }>(
    `SELECT lifecycle_state, outcome_kind FROM canonical_turns WHERE turn_request_id = ?`,
    [turnRequestId],
  );

/**
 * A receipt found for a turn, stating its own identity rather than echoing the caller's.
 *
 * `overrides` is where a test injects a wrong actor, prompt or generation — the receipt's own
 * claim, which is exactly what the sweep must act on unchanged. There is no way to call this and
 * *not* state an identity, unlike the shape the first draft shipped with, where a caller who
 * forgot to override anything got the query's own values for free.
 */
const matchingReceipt = (
  permit: { turnRequestId: string; targetActorId: string; promptDigest: string },
  overrides: Partial<Extract<ReceiptLookupResult, { found: true }>> = {},
): ReceiptLookupResult => ({
  found: true,
  outcome: "COMPLETED",
  receiptId: `hermes:${permit.turnRequestId}`,
  evidenceDigest: `sha256:${permit.turnRequestId}`,
  reasonCode: ReasonCode.OK,
  turnRequestId: permit.turnRequestId,
  targetActorId: permit.targetActorId,
  promptDigest: permit.promptDigest,
  bindingGeneration: 1,
  ...overrides,
});

/**
 * The stand-in #638 will one day be a real implementation of.
 *
 * Records every query it is asked, so a test can assert on *which turns were actually queried* —
 * not only on how many settled. A candidate this port was never asked about and a candidate it
 * answered `found: false` for are both silent in the settlement counts; only the call list tells
 * them apart, and the sweep's whole claim to ask about *every* unresolved turn stands or falls on
 * that list matching the turns that were actually held.
 */
class FakeReceiptPort implements ReceiptPort {
  private readonly answers = new Map<string, ReceiptLookupResult>();
  readonly calls: ReceiptLookupQuery[] = [];

  answer(turnRequestId: string, result: ReceiptLookupResult): void {
    this.answers.set(turnRequestId, result);
  }

  lookup(query: ReceiptLookupQuery): ReceiptLookupResult {
    this.calls.push(query);
    return this.answers.get(query.turnRequestId) ?? { found: false };
  }
}

describe("ConversationTurnCoordinator.reconcileUnresolved", () => {
  it("settles a turn the fake port reports as receipted, and leaves the rest untouched", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorA = target(c, "a", 1);
    const actorB = target(c, "b", 1);
    const receipted = claim(c, actorA, "m1");
    const silent = claim(c, actorB, "m2");

    port.answer(receipted.turnRequestId, matchingReceipt({ ...receipted, targetActorId: actorA }));

    const result = await c.coordinator.reconcileUnresolved();

    expect(result).toEqual({ swept: 2, settled: 1, unresolved: 1 });
    expect(stateOf(c, receipted.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
    expect(stateOf(c, silent.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    // Every unresolved turn was asked about, not just the one that happened to settle — the whole
    // claim this describe block makes. Silence in the settlement count does not distinguish
    // "never asked" from "asked and refused", but the call list does.
    expect(port.calls.map((q) => q.turnRequestId).sort()).toEqual(
      [receipted.turnRequestId, silent.turnRequestId].sort(),
    );
  });

  it("leaves every unresolved turn exactly where it was when the port never finds anything — the state before #638 lands", async () => {
    const c = withCoordinator(NEVER_FOUND_RECEIPT_PORT);
    const actorId = target(c, "untouched", 1);
    const held = claim(c, actorId, "m1");

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1 });
    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  it("does not complete a turn on a receipt naming a different CEO generation, and keeps sweeping the rest", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "stale-gen", 1);
    const other = target(c, "other", 1);
    const held = claim(c, actorId, "m1");
    const alsoHeld = claim(c, other, "m2");

    // A receipt for the right turn id, but minted under a generation this turn was never claimed
    // under — the cross-generation completion contract 1 exists to refuse.
    port.answer(
      held.turnRequestId,
      matchingReceipt({ ...held, targetActorId: actorId }, { bindingGeneration: 2 }),
    );
    port.answer(alsoHeld.turnRequestId, matchingReceipt({ ...alsoHeld, targetActorId: other }));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 2, settled: 1, unresolved: 1 });
    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(stateOf(c, alsoHeld.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
  });

  it("does not complete a turn when the receipt attests to the wrong actor, even though the query it was asked under was correct", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "right-actor", 1);
    const impostor = target(c, "wrong-actor", 1);
    const held = claim(c, actorId, "m1");

    // The port is asked about `held` (actor "right-actor"), and answers with a receipt that
    // attests to a different actor entirely.
    port.answer(held.turnRequestId, matchingReceipt({ ...held, targetActorId: impostor }));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1 });
    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  /** Same defect class, the other content field. */
  it("does not complete a turn when the receipt attests to the wrong prompt", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "right-prompt", 1);
    const held = claim(c, actorId, "m1");

    port.answer(
      held.turnRequestId,
      matchingReceipt({ ...held, targetActorId: actorId }, { promptDigest: "sha256:not-what-was-asked" }),
    );

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1 });
    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  it("does not stop the sweep when one lookup throws", async () => {
    // The port is bound at construction, before either turn is claimed, so which turnRequestId
    // should throw is not known yet — captured in a variable the closure reads once claiming has
    // happened, rather than by building a second coordinator (which the materialization authority,
    // claimed once per database, would refuse).
    let brokenId = "";
    const port: ReceiptPort = {
      lookup: (query) => {
        if (query.turnRequestId === brokenId) throw new Error("network is down");
        return matchingReceipt({
          turnRequestId: query.turnRequestId,
          targetActorId: query.targetActorId,
          promptDigest: query.promptDigest,
        });
      },
    };
    const c = withCoordinator(port);
    const actorA = target(c, "throws", 1);
    const actorB = target(c, "after", 1);
    const broken = claim(c, actorA, "m1");
    brokenId = broken.turnRequestId;
    const fine = claim(c, actorB, "m2");

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 2, settled: 1, unresolved: 1 });
    expect(stateOf(c, broken.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(stateOf(c, fine.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
  });

  /**
   * A second review (Sol, on #691's own fix) found that removing the public
   * `reconcileWithReceipt` method proved the method was gone, not that the property it guards
   * held. `private readonly receiptPort` erases to a plain, writable, enumerable own property in
   * the compiled JS — TypeScript's `private` and `readonly` are both compile-time only — so
   * anything holding this coordinator could reassign it to a fake port and call
   * `reconcileUnresolved()` to forge a completion, one indirection past the door #691 closed.
   *
   * `#receiptPort` (a true private class field, matching `#materialization` above) closes it: the
   * assignment below still "succeeds" as an ordinary JS statement — there is nothing to make it
   * throw, since `receiptPort` is a different, unrelated string key from the actual `#receiptPort`
   * slot — but it creates an inert property the class never reads. The proof is behavioral, not
   * that the assignment failed: the forged port is never consulted, so nothing settles.
   */
  it("attack 1 — reassigning the coordinator's bound receipt port has no effect: the real field is not reachable by that name", async () => {
    const c = withCoordinator(NEVER_FOUND_RECEIPT_PORT);
    const actorId = target(c, "port-swap-attempt", 1);
    const held = claim(c, actorId, "m1");

    const forgedPort: ReceiptPort = {
      lookup: (query) => matchingReceipt({ ...query }),
    };
    // The attack: reassign what looks like the port field from outside the class.
    (c.coordinator as unknown as { receiptPort: ReceiptPort }).receiptPort = forgedPort;

    // #691's original finding: there is also no public method left that would take a receipt
    // directly, so this is not merely inert — there is nothing else to call it through either.
    expect(typeof (c.coordinator as unknown as { reconcileWithReceipt?: unknown }).reconcileWithReceipt).toBe(
      "undefined",
    );

    await c.coordinator.reconcileUnresolved();

    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  /**
   * The second half of the same finding: even with the field itself unreachable, the *object* it
   * was bound to is exported and shared. Every coordinator built with the default — which is every
   * one built today, since no real port exists until #638 — holds the exact same
   * `NEVER_FOUND_RECEIPT_PORT` reference. Overwriting its `lookup` method in place would change
   * what all of them answer, with no need to touch any coordinator at all. `Object.freeze` is what
   * makes that assignment throw instead of silently taking effect (this module runs in strict
   * mode, like every ES module).
   */
  it("attack 2 — tampering with the exported NEVER_FOUND_RECEIPT_PORT singleton throws, and its answer is unchanged", async () => {
    const attempt = () => {
      (NEVER_FOUND_RECEIPT_PORT as unknown as { lookup: ReceiptPort["lookup"] }).lookup = () =>
        matchingReceipt({ turnRequestId: "tr_anything", targetActorId: "actor:anything", promptDigest: "sha256:anything" });
    };
    expect(attempt).toThrow(TypeError);

    // Unchanged, and a coordinator relying on the default default still settles nothing.
    expect(await NEVER_FOUND_RECEIPT_PORT.lookup({
      turnRequestId: "x",
      targetActorId: "y",
      promptDigest: "z",
      bindingGeneration: 1,
    })).toEqual({ found: false });

    const c = withCoordinator(NEVER_FOUND_RECEIPT_PORT);
    const actorId = target(c, "singleton-tamper-attempt", 1);
    const held = claim(c, actorId, "m1");
    await c.coordinator.reconcileUnresolved();

    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  /**
   * Contract 1's fourth field, closing the gap a second review found in round 1's identity fix:
   * `targetActorId` and `promptDigest` were sourced from the receipt's own answer, but
   * `turnRequestId` was still taken from the query that sent the lookup. Two turns on the same
   * actor, claimed with the same prompt and generation (as both are here — nothing distinguishes
   * them but their id), made that invisible: a receipt attesting to the *first* turn would still
   * settle the *second*, because every field the sweep compared happened to agree anyway.
   */
  it("does not complete a turn when the receipt attests to a different turn id than the one asked about, even though actor, prompt and generation all agree", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "same-actor-twice", 1);

    const first = claim(c, actorId, "m1");
    port.answer(first.turnRequestId, matchingReceipt({ ...first, targetActorId: actorId }));
    await c.coordinator.reconcileUnresolved();
    expect(stateOf(c, first.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });

    // A second turn on the same actor is claimable now that the first is settled — same prompt
    // text ("hello"), same generation (1), so only the turn id differs from the first.
    const second = claim(c, actorId, "m2");
    port.answer(
      second.turnRequestId,
      matchingReceipt({ ...second, targetActorId: actorId }, {
        turnRequestId: first.turnRequestId,
        receiptId: "hermes:mixed-up",
      }),
    );

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1 });
    expect(stateOf(c, second.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });
});
