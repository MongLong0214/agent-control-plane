import { afterAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  ConversationTurnCoordinator,
  NEVER_FOUND_RECEIPT_PORT,
  RECEIPT_LOOKUP_TIMEOUT_MS,
  RECONCILE_SWEEP_BUDGET_MS,
  type ReceiptLookupQuery,
  type ReceiptLookupResult,
  type ReceiptPort,
  type TurnPermit,
} from "../../src/conversation/turn-coordinator.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { openDb } from "../../src/db/database.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The active half of #639 contract 6 — and the shape three rounds of review found it had to take.
 *
 * The schema and the coordinator's settlement logic already refuse to complete a turn without a
 * matching receipt — that much has stood since #665. What was still missing is anything that
 * *asks*: a turn nobody ever queries about stays `IN_DOUBT` forever even the instant Hermes
 * commits a receipt for it, and contract 6 without a harvester is vacuously true, exactly the
 * hole a blind review found on this issue. `reconcileUnresolved()` is the harvester; `#638` is
 * what makes a real port answer anything but `found: false`.
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
 *    receipt satisfies any comparison between them. Fixed structurally: the receipt never arrives
 *    as a public argument, `ReceiptPort` is bound once at construction (a true `#`-private field,
 *    since `private readonly` erases at compile time), and the exported default port is frozen so
 *    its `lookup` cannot be overwritten in place either.
 * Round 2's fixes made the sweep sound but exposed two things it was never asked to be — two
 * independent facts, stated adjacently and numbered because a fourth review found the first draft
 * let the second read as a footnote of the first:
 *
 * 3. Nothing to sweep: it sweeps `canonical_turns`, which nothing in production writes to
 *    (`claim()` has no caller in `src/`; the live Telegram path claims through `IngressGuard` into
 *    a different table) — so this sweep runs, and asks, over an empty set, until #683/#639's other
 *    half wires a production writer.
 * 4. Even with something to sweep, `COMPLETED` cannot be acted on: every settlement below only
 *    ever moves `canonical_turns`, and contract 6 also requires a reply-outbox insert in the same
 *    transaction, which nothing wired to this ledger can perform. So `#settleFromReceipt` refuses
 *    `COMPLETED` outright and unconditionally — not only while 3 holds, but independently of it.
 *    `ABORTED` carries no reply obligation and is what most tests below use to exercise the
 *    identity checks without that refusal masking them; the one test about `COMPLETED` itself says
 *    so explicitly.
 */
type Coordinator = {
  db: ReturnType<typeof openDb>;
  clock: ManualClock;
  audit: AuditLog;
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
  const audit = new AuditLog(db, clock);
  const coordinator = new ConversationTurnCoordinator(db, clock, audit, port);
  return { db, clock, audit, coordinator };
};

/**
 * #683/#666, likewise merged after this file's earlier rounds: `claim()` now refuses a source
 * whose `(channel, nonce)` names no row in `inbound_messages` — a caller-built `TurnSource` is no
 * longer enough on its own. Admits it through the real `IngressGuard.admit` path, the same
 * production entry point, rather than inserting the row by hand: a hand-inserted row would be
 * exactly the "test enters where production does not" shape this repository has shipped twice.
 */
const admitInbound = (c: Coordinator, nonce: string, payload: unknown): void => {
  const guard = new IngressGuard(c.db, c.clock, c.audit, {
    telegram: { allowedActors: ["owner"], allowedConversations: ["convo"] },
  });
  const admitted = guard.admit({ channel: "telegram", actor: "owner", conversation: "convo", nonce, payload });
  if (!admitted.allowed) throw new Error(`fixture could not admit telegram:${nonce}: ${admitted.reasonCode}`);
};

/**
 * #683/#666, merged into `origin/main` after this file's earlier rounds: `claim()`'s attestation
 * lookup now joins `actor_target_attestations → actor_target_bindings → conversational_actors →
 * assignments`, requiring a live session, the actor's current runtime incarnation, and an ACTIVE
 * assignment whose generation and session match the attestation — a currency check, not just an
 * existence one. This fixture was written before that landed and inserted only the binding and
 * attestation rows; it now also creates the session and assignment those rows are checked against.
 */
const target = (c: Coordinator, name: string, bindingGeneration = 1): string => {
  const actorId = `actor:${name}`;
  const sessionId = `runtime:${name}`;
  c.db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
    [sessionId, NOW, NOW],
  );
  c.db.run(
    `INSERT INTO conversational_actors
       (actor_id, kind, current_session_id, current_session_incarnation, created_at)
     VALUES (?, 'CEO', ?, 'inc-1', ?)`,
    [actorId, sessionId, NOW],
  );
  c.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [`bind:${name}`, actorId, `locator:${name}`, `digest:${name}`, NOW],
  );
  // The active role binding the attestation's generation names, so `claim()`'s currency check
  // has a current generation to find rather than reading an attestation nothing backs.
  c.db.run(
    `INSERT INTO assignments
       (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
        binding_generation, mode, status, created_at)
     VALUES (?, ?, 'CEO', ?, ?, 'inc-1', ?, 'PREFERRED', 'ACTIVE', ?)`,
    [`asg:${name}`, `CEO:${name}`, actorId, sessionId, bindingGeneration, NOW],
  );
  c.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
        attested_at)
     VALUES (?, ?, 'v1', ?, ?, 'inc-1', ?, ?, ?)`,
    [`att:${name}`, `bind:${name}`, `attd:${name}`, sessionId, bindingGeneration, `asg:${name}`, NOW],
  );
  return actorId;
};

const claim = (c: Coordinator, actorId: string, nonce: string): TurnPermit => {
  const payload = { text: `message ${nonce}` };
  admitInbound(c, nonce, payload);
  const decision = c.coordinator.claim({
    targetActorId: actorId,
    prompt: "hello",
    sources: [{ channel: "telegram", nonce, attempt: 1, payload }],
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
 * What `canonical_turns` actually stored for this turn at claim time — read back from the row
 * rather than re-derived from fixture naming conventions, so a test's idea of "the right binding /
 * attestation / runtime" can never silently drift from what the coordinator itself recorded.
 */
const rowIdentity = (
  c: Coordinator,
  turnRequestId: string,
): {
  targetBindingId: string;
  targetAttestationId: string;
  executorSessionId: string;
  executorSessionIncarnation: string;
} => {
  const row = c.db.get<{
    target_binding_id: string;
    target_attestation_id: string;
    executor_session_id: string;
    executor_session_incarnation: string;
  }>(
    `SELECT target_binding_id, target_attestation_id, executor_session_id, executor_session_incarnation
       FROM canonical_turns WHERE turn_request_id = ?`,
    [turnRequestId],
  )!;
  return {
    targetBindingId: row.target_binding_id,
    targetAttestationId: row.target_attestation_id,
    executorSessionId: row.executor_session_id,
    executorSessionIncarnation: row.executor_session_incarnation,
  };
};

/**
 * A receipt found for a turn, stating its own identity rather than echoing the caller's.
 *
 * `overrides` is where a test injects a wrong actor, prompt, generation, binding, attestation or
 * runtime — the receipt's own claim, which is exactly what the sweep must act on unchanged. There
 * is no way to call this and *not* state an identity, unlike the shape the first draft shipped
 * with, where a caller who forgot to override anything got the query's own values for free.
 *
 * All eight fields are required in `identity`, not defaulted — a fourth review found that
 * `bindingGeneration` alone does not fence a `SURVIVED` runtime failover (see the tests below), so
 * a helper that let a caller omit `targetBindingId`/`targetAttestationId`/`executorSessionId`/
 * `executorSessionIncarnation` would make it easy to write a new test that "matches" without ever
 * exercising those fields, the same gap the whole file exists to close.
 *
 * Defaults to `outcome: "ABORTED"`, not `"COMPLETED"` — a third review found that `#settleFromReceipt`
 * now refuses every `COMPLETED` unconditionally (contract 6's atomic reply-outbox insert has
 * nothing to write into yet), so a test using the default to prove an *identity* check would have
 * passed for the wrong reason: the completion refusal fires before any identity is even compared.
 * `ABORTED` carries no reply obligation and reaches those checks unaffected; the one test about
 * `COMPLETED` itself overrides this explicitly.
 */
const matchingReceipt = (
  identity: {
    turnRequestId: string;
    targetActorId: string;
    promptDigest: string;
    targetBindingId: string;
    targetAttestationId: string;
    executorSessionId: string;
    executorSessionIncarnation: string;
  },
  overrides: Partial<Extract<ReceiptLookupResult, { found: true }>> = {},
): ReceiptLookupResult => ({
  found: true,
  outcome: "ABORTED",
  receiptId: `hermes:${identity.turnRequestId}`,
  evidenceDigest: `sha256:${identity.turnRequestId}`,
  reasonCode: ReasonCode.OK,
  turnRequestId: identity.turnRequestId,
  targetActorId: identity.targetActorId,
  promptDigest: identity.promptDigest,
  bindingGeneration: 1,
  targetBindingId: identity.targetBindingId,
  targetAttestationId: identity.targetAttestationId,
  executorSessionId: identity.executorSessionId,
  executorSessionIncarnation: identity.executorSessionIncarnation,
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

    port.answer(
      receipted.turnRequestId,
      matchingReceipt({ ...receipted, ...rowIdentity(c, receipted.turnRequestId), targetActorId: actorA }),
    );

    const result = await c.coordinator.reconcileUnresolved();

    expect(result).toEqual({ swept: 2, settled: 1, unresolved: 1, failed: 0 });
    expect(stateOf(c, receipted.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "ABORTED" });
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

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  /**
   * A third review (Sol, on #691's own fix) found the atomicity gap contract 6 names explicitly:
   * a matched receipt must move `TURN_COMPLETED` and insert one reply-outbox item in the same
   * transaction, and nothing wired to `canonical_turns` performs the second half. Every field here
   * matches perfectly — actor, prompt, generation, turn id — precisely so this refusal cannot be
   * mistaken for any of the identity checks above; the only thing wrong with this receipt is that
   * this build cannot yet act on `COMPLETED` at all.
   */
  it("does not complete a turn even when every identity field matches, because the reply obligation cannot yet be discharged", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "perfect-match-completed", 1);
    const held = claim(c, actorId, "m1");

    port.answer(
      held.turnRequestId,
      matchingReceipt(
        { ...held, ...rowIdentity(c, held.turnRequestId), targetActorId: actorId },
        { outcome: "COMPLETED" },
      ),
    );

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
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
      matchingReceipt(
        { ...held, ...rowIdentity(c, held.turnRequestId), targetActorId: actorId },
        { bindingGeneration: 2 },
      ),
    );
    port.answer(
      alsoHeld.turnRequestId,
      matchingReceipt({ ...alsoHeld, ...rowIdentity(c, alsoHeld.turnRequestId), targetActorId: other }),
    );

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 2, settled: 1, unresolved: 1, failed: 0 });
    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(stateOf(c, alsoHeld.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "ABORTED" });
  });

  it("does not complete a turn when the receipt attests to the wrong actor, even though the query it was asked under was correct", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "right-actor", 1);
    const impostor = target(c, "wrong-actor", 1);
    const held = claim(c, actorId, "m1");

    // The port is asked about `held` (actor "right-actor"), and answers with a receipt that
    // attests to a different actor entirely.
    port.answer(
      held.turnRequestId,
      matchingReceipt({ ...held, ...rowIdentity(c, held.turnRequestId), targetActorId: impostor }),
    );

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
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
      matchingReceipt(
        { ...held, ...rowIdentity(c, held.turnRequestId), targetActorId: actorId },
        { promptDigest: "sha256:not-what-was-asked" },
      ),
    );

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
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
        return matchingReceipt(query);
      },
    };
    const c = withCoordinator(port);
    const actorA = target(c, "throws", 1);
    const actorB = target(c, "after", 1);
    const broken = claim(c, actorA, "m1");
    brokenId = broken.turnRequestId;
    const fine = claim(c, actorB, "m2");

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 2, settled: 1, unresolved: 1, failed: 1 });
    expect(stateOf(c, broken.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(stateOf(c, fine.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "ABORTED" });
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
        matchingReceipt({
          turnRequestId: "tr_anything",
          targetActorId: "actor:anything",
          promptDigest: "sha256:anything",
          targetBindingId: "bind:anything",
          targetAttestationId: "att:anything",
          executorSessionId: "runtime:anything",
          executorSessionIncarnation: "inc-1",
        });
    };
    expect(attempt).toThrow(TypeError);

    // Unchanged, and a coordinator relying on the default default still settles nothing.
    expect(await NEVER_FOUND_RECEIPT_PORT.lookup({
      turnRequestId: "x",
      targetActorId: "y",
      promptDigest: "z",
      bindingGeneration: 1,
      targetBindingId: "bind:x",
      targetAttestationId: "att:x",
      executorSessionId: "runtime:x",
      executorSessionIncarnation: "inc-1",
    }, new AbortController().signal)).toEqual({ found: false });

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
    port.answer(
      first.turnRequestId,
      matchingReceipt({ ...first, ...rowIdentity(c, first.turnRequestId), targetActorId: actorId }),
    );
    await c.coordinator.reconcileUnresolved();
    expect(stateOf(c, first.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "ABORTED" });

    // A second turn on the same actor is claimable now that the first is settled — same prompt
    // text ("hello"), same generation (1), same binding/attestation/runtime (same actor, never
    // failed over), so only the turn id differs from the first.
    const second = claim(c, actorId, "m2");
    port.answer(
      second.turnRequestId,
      matchingReceipt(
        { ...second, ...rowIdentity(c, second.turnRequestId), targetActorId: actorId },
        { turnRequestId: first.turnRequestId, receiptId: "hermes:mixed-up" },
      ),
    );

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
    expect(stateOf(c, second.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  /**
   * A fifth review found the ledger pins more than the four fields above: `canonical_turns` also
   * fixes `target_binding_id`, `target_attestation_id`, `executor_session_id` and
   * `executor_session_incarnation` at claim time, and none of the original four catch a receipt
   * that describes the wrong one of those.
   *
   * The counterexample is `BindingRegistry.switchTo`'s own `SURVIVED` failover: an actor's live
   * runtime moves to an entirely new session while `binding_generation` is deliberately left
   * unchanged ("the binding is not rewritten, which is why `binding_generation` cannot advance
   * here" — the `conversation === "SURVIVED"` branch). This test reproduces exactly that move —
   * a fresh session, `conversational_actors.current_session_id` repointed to it, no new binding,
   * attestation or assignment row — while the turn is still `IN_DOUBT`. The receipt that follows
   * then attests to turn, actor, prompt and generation exactly as claimed, and to the *new*
   * runtime — passing every one of the original four checks while describing an execution this
   * turn was never dispatched under.
   */
  it("does not complete a turn when the receipt attests to a different runtime than the one this turn was claimed under, after a SURVIVED failover keeps the generation unchanged", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "survived-failover", 1);
    const held = claim(c, actorId, "m1");
    const claimedIdentity = rowIdentity(c, held.turnRequestId);

    // `BindingRegistry.switchTo`'s `SURVIVED` branch, reproduced directly: a new session, the
    // actor's runtime pointer moved to it, binding_generation untouched.
    const failoverSessionId = "runtime:survived-failover-2";
    c.db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES (?, 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
      [failoverSessionId, NOW, NOW],
    );
    c.db.run(
      `UPDATE conversational_actors
          SET current_session_id = ?, current_session_incarnation = 'inc-1'
        WHERE actor_id = ?`,
      [failoverSessionId, actorId],
    );

    port.answer(
      held.turnRequestId,
      matchingReceipt({
        ...held,
        ...claimedIdentity,
        targetActorId: actorId,
        executorSessionId: failoverSessionId,
      }),
    );

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  /** Same defect class as the runtime check above: the receipt names the wrong target binding. */
  it("does not complete a turn when the receipt attests to the wrong target binding", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "right-binding", 1);
    const held = claim(c, actorId, "m1");

    port.answer(
      held.turnRequestId,
      matchingReceipt(
        { ...held, ...rowIdentity(c, held.turnRequestId), targetActorId: actorId },
        { targetBindingId: "bind:some-other-conversation" },
      ),
    );

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  /** Same defect class: the receipt names an attestation other than the one that verified this
   *  turn's target at claim time — a stale or replaced attestation is not evidence about this one. */
  it("does not complete a turn when the receipt attests to the wrong attestation", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "right-attestation", 1);
    const held = claim(c, actorId, "m1");

    port.answer(
      held.turnRequestId,
      matchingReceipt(
        { ...held, ...rowIdentity(c, held.turnRequestId), targetActorId: actorId },
        { targetAttestationId: "att:stale-or-replaced" },
      ),
    );

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
    expect(stateOf(c, held.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
  });

  /**
   * A sixth review: `ReceiptPort.lookup` may return a `Promise`, and the sweep used to await each
   * one with no bound at all. A port that never settles is not a misbehaving implementation of the
   * interface — a slow network call to a real receipt store is exactly this shape — so a hang
   * there used to hang this whole method on one turn, forever, with every remaining candidate in
   * the same pass never asked about at all. Uses fake timers rather than a real multi-second wait:
   * the port's promise genuinely never resolves or rejects on its own, and the timeout is what
   * must move the sweep past it.
   */
  it("treats a lookup that never settles as no evidence after its timeout, and keeps sweeping the rest", async () => {
    vi.useFakeTimers();
    try {
      // `swept` in the summary is `unresolvedIdentities().length`, computed before the loop even
      // starts — it would read 2 whether or not the sweep ever got past the first hang. What
      // actually proves the second candidate was reached is that its `lookup` was *called*, so
      // this counts calls rather than trusting the summary's shape.
      let calls = 0;
      const port: ReceiptPort = {
        // Never resolves, never rejects — the shape a slow-but-honest network call takes right up
        // until it eventually answers, and the shape a truly hung one takes forever.
        lookup: () => {
          calls += 1;
          return new Promise<ReceiptLookupResult>(() => {});
        },
      };
      const c = withCoordinator(port);
      const actorA = target(c, "hangs-forever", 1);
      const actorB = target(c, "after-the-hang", 1);
      const hung = claim(c, actorA, "m1");
      const fine = claim(c, actorB, "m2");

      const summaryPromise = c.coordinator.reconcileUnresolved();
      // Advances past both candidates' timeouts; `hung`'s lookup never settles regardless of how
      // far time advances, so if the timeout did not exist this `await` would hang instead of the
      // daemon it stands in for.
      await vi.advanceTimersByTimeAsync(RECEIPT_LOOKUP_TIMEOUT_MS * 2);
      const summary = await summaryPromise;

      expect(calls).toBe(2);
      expect(summary).toEqual({ swept: 2, settled: 0, unresolved: 2, failed: 2 });
      expect(stateOf(c, hung.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
      expect(stateOf(c, fine.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A seventh review: the first version of the timeout above only abandoned a slow lookup — the
   * underlying promise kept running, so a genuinely slow port left duplicate, uncancelled network
   * work behind on every timeout, and that work compounded across the overlapping sweeps a slow
   * port also causes. `signal.aborted` is what a real implementation (a `fetch` call, an RPC
   * client) would check to actually stop; this asserts the coordinator holds up its end by
   * flipping it, which is as far as a test *can* verify without a real network client to cancel.
   */
  it("aborts the signal it gave a lookup once that lookup's own timeout fires", async () => {
    vi.useFakeTimers();
    try {
      let seenSignal: AbortSignal | undefined;
      const port: ReceiptPort = {
        lookup: (_query, signal) => {
          seenSignal = signal;
          return new Promise<ReceiptLookupResult>(() => {});
        },
      };
      const c = withCoordinator(port);
      const actorId = target(c, "abort-on-timeout", 1);
      claim(c, actorId, "m1");

      const summaryPromise = c.coordinator.reconcileUnresolved();
      expect(seenSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(RECEIPT_LOOKUP_TIMEOUT_MS);
      await summaryPromise;

      expect(seenSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * An eighth review: a per-lookup timeout bounds one turn, not the sweep. Seven honestly slow
   * (not hung) lookups in one pass, each answering just under `RECEIPT_LOOKUP_TIMEOUT_MS`, add up
   * past the periodic interval — and `runPeriodic` has no in-flight guard (see
   * `capacity-sweep-budget.test.ts`), so the next sweep would start before this one returned.
   * `RECONCILE_SWEEP_BUDGET_MS` is the bound on the whole pass, mirroring how the capacity sweep
   * bounds itself (`Daemon.refreshCapacitySensors`'s own `Promise.race`): once it is spent, the
   * loop stops issuing new lookups and returns with whatever it has, leaving the rest for the
   * sweep after. This uses a port answering *immediately* but slowly enough, one candidate at a
   * time, to exceed the budget partway through — proving the bound is on elapsed wall-clock time
   * across the pass, not on any single lookup.
   */
  it("stops issuing new lookups once the whole pass exceeds its own budget, leaving the rest for the next sweep", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      // Each call must finish well *inside* `RECEIPT_LOOKUP_TIMEOUT_MS` (10s), or the per-lookup
      // timeout — not the sweep budget — is what ends up bounding it; five of these, each
      // answering honestly at 9s, still add up past `RECONCILE_SWEEP_BUDGET_MS` (45s) without any
      // single one ever being slow enough to time out on its own.
      const perCallDelayMs = 9_000;
      expect(perCallDelayMs).toBeLessThan(RECEIPT_LOOKUP_TIMEOUT_MS);
      const port: ReceiptPort = {
        lookup: async () => {
          calls += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, perCallDelayMs));
          return { found: false };
        },
      };
      const c = withCoordinator(port);
      const actorIds = ["one", "two", "three", "four", "five", "six"].map((name) =>
        target(c, `budget-${name}`, 1),
      );
      const held = actorIds.map((actorId, i) => claim(c, actorId, `m${i}`));

      const summaryPromise = c.coordinator.reconcileUnresolved();
      await vi.advanceTimersByTimeAsync(RECONCILE_SWEEP_BUDGET_MS * 2);
      const summary = await summaryPromise;

      // Five calls at 9s each land exactly on the 45s budget (5 * 9000 = 45000); the sixth is
      // checked against a budget already spent and is never started.
      expect(calls).toBe(5);
      expect(summary.swept).toBe(6);
      expect(summary.failed).toBe(0);
      for (const permit of held) {
        expect(stateOf(c, permit.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
