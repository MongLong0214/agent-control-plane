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
   * #691's P1: reading a turn's identity from a public method and handing it back with a
   * fabricated receipt used to record a `HERMES_TARGET` completion with no target ever consulted.
   * That call no longer type-checks — there is no public method left that takes a receipt — so
   * this is the closest a test can come to reproducing the old attack: read everything the public
   * surface still exposes, then run the one production entry point as many times as the caller
   * likes, on the coordinator wired exactly as the daemon wires it today (`NEVER_FOUND_RECEIPT_PORT`).
   * Nothing the caller read can turn into a completion, because nothing the caller supplies ever
   * reaches the settlement logic — only what `this.receiptPort.lookup()` itself returns does.
   */
  it("cannot be forged: reading unresolvedIdentities and re-running the sweep never settles a turn the production port never receipted", async () => {
    const c = withCoordinator(NEVER_FOUND_RECEIPT_PORT);
    const actorId = target(c, "unforgeable", 1);
    const held = claim(c, actorId, "m1");

    // Everything a would-be forger could read.
    const exposed = c.coordinator.unresolvedIdentities();
    expect(exposed).toEqual([
      {
        turnRequestId: held.turnRequestId,
        targetActorId: actorId,
        promptDigest: held.promptDigest,
        bindingGeneration: 1,
        claimedAt: expect.any(String),
      },
    ]);

    // The method #691 found forgeable no longer exists to call.
    expect(typeof (c.coordinator as unknown as { reconcileWithReceipt?: unknown }).reconcileWithReceipt).toBe(
      "undefined",
    );

    // Running the one production entry point, repeatedly, settles nothing — the port bound at
    // construction is the only source of a receipt, and it was never asked to say anything but no.
    await c.coordinator.reconcileUnresolved();
    await c.coordinator.reconcileUnresolved();
    await c.coordinator.reconcileUnresolved();

    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });
});
