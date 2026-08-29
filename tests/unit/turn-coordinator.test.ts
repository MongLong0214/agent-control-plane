import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";

import {
  ConversationTurnCoordinator,
  type TurnMaterialization,
  type TurnPermit,
  type TurnReceipt,
  type TurnSource,
} from "../../src/conversation/turn-coordinator.ts";
import { isAcpError, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { admitInbound, makeHarness } from "../helpers/harness.ts";

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
 * Admits the message this source names through the real ingress path, then builds the source
 * that refers to it.
 *
 * `claim()` now requires ingress to have admitted the (channel, nonce) a source names, *with the
 * same payload* (#666) — so a fixture that only built the `TurnSource` object, or that admitted
 * one payload and named another, would be building exactly the substitution the fix refuses.
 * `admitInbound` is idempotent because a retry (`attempt > 1`) reuses the same nonce, and
 * re-admitting it is a no-op.
 */
const source = (h: Harness, nonce: string, attempt = 1): TurnSource => {
  const payload = { text: `message ${nonce}` };
  admitInbound(h, { nonce, payload });
  return { channel: "telegram", nonce, attempt, payload };
};

/** An actor with a verified, attested target — everything a turn needs before it can exist. */
const target = (h: Harness, name: string): string => {
  const actorId = `actor:${name}`;
  const sessionId = `runtime:${name}`;
  h.cp.db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
    [sessionId, NOW, NOW],
  );
  h.cp.db.run(
    `INSERT INTO conversational_actors
       (actor_id, kind, current_session_id, current_session_incarnation, created_at)
     VALUES (?, 'CEO', ?, 'inc-1', ?)`,
    [actorId, sessionId, NOW],
  );
  h.cp.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [`bind:${name}`, actorId, `sess-${name}`, `digest:${name}`, NOW],
  );
  // The active role binding the attestation's generation names, so `claim()`'s currency check
  // (#666) has a current generation to find rather than reading an attestation nothing backs.
  h.cp.db.run(
    `INSERT INTO assignments
       (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
        binding_generation, mode, status, created_at)
     VALUES (?, ?, 'CEO', ?, ?, 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
    [`asg:${name}`, `CEO:${name}`, actorId, sessionId, NOW],
  );
  h.cp.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
        attested_at)
     VALUES (?, ?, 'v1', ?, ?, 'inc-1', 1, ?, ?)`,
    [`att:${name}`, `bind:${name}`, `attd:${name}`, sessionId, `asg:${name}`, NOW],
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
const coordinatorOf = (h: Harness): ConversationTurnCoordinator => h.cp.conversation;

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
/**
 * Marks the turn dispatched, which every authority except `ACP_PRE_DISPATCH` now needs.
 *
 * A settlement says something about a phase, and #662 made the phase a row rather than the caller's
 * word: the target and owner-fence authorities report what happened to an execution, and a turn
 * that was never dispatched has none. The adapter below does this for the tests that predate the
 * rule, and the tests *about* the rule call it themselves.
 */
const dispatch = (coordinator: ConversationTurnCoordinator, permit: TurnPermit): void => {
  // Refusals are ignored on purpose. These tests are about what a settlement does, and a permit
  // that was never issued or a turn that is already settled has to reach the *settlement* to be
  // refused there — a throw here would move the assertion into the fixture.
  //
  // Not awaited: the row is written and committed synchronously before `dispatch` returns its
  // promise, and these tests only need it to exist. A test *about* the send holds the promise.
  //
  // The rejection is swallowed rather than left floating. `dispatch` is async, so a throw from the
  // marking half arrives as a rejected promise; unhandled, it surfaces later as an unattributed
  // failure in whichever test happens to be running — a review pointed that out.
  void coordinator.dispatch(permit, () => undefined).catch(() => undefined);
};

const settle = (
  coordinator: ConversationTurnCoordinator,
  permit: TurnPermit,
  outcome: {
    kind: "COMPLETED" | "NEVER_ADMITTED" | "ABORTED";
    authority: "ACP_PRE_DISPATCH" | "HERMES_TARGET" | "OWNER_AFTER_TARGET_FENCE";
    reasonCode: string;
    evidenceDigest?: string;
  },
) => {
  if (outcome.authority !== "ACP_PRE_DISPATCH") dispatch(coordinator, permit);
  return portFor(coordinator, outcome.kind, outcome.authority)(permit, {
    receiptId: `receipt-${(receiptCounter += 1)}`,
    evidenceDigest: outcome.evidenceDigest ?? "sha256:evidence",
    reasonCode: outcome.reasonCode,
  });
};

/**
 * The port an (outcome, authority) pair names, for tests written before the ports existed.
 *
 * Production never picks a port this way — a component is handed the one it is entitled to. Here
 * the pair is the test's subject, so the lookup is explicit and an unreachable pair throws rather
 * than silently settling under some other authority.
 */
const portFor = (
  coordinator: ConversationTurnCoordinator,
  kind: "COMPLETED" | "NEVER_ADMITTED" | "ABORTED",
  authority: "ACP_PRE_DISPATCH" | "HERMES_TARGET" | "OWNER_AFTER_TARGET_FENCE",
): ((permit: TurnPermit, receipt: TurnReceipt) => Decision<TurnMaterialization>) => {
  const { ports } = coordinator;
  if (kind === "NEVER_ADMITTED" && authority === "ACP_PRE_DISPATCH") return ports.preDispatch.neverAdmitted;
  if (kind === "COMPLETED" && authority === "HERMES_TARGET") return ports.target.completed;
  if (kind === "ABORTED" && authority === "HERMES_TARGET") return ports.target.aborted;
  if (kind === "ABORTED" && authority === "OWNER_AFTER_TARGET_FENCE") return ports.ownerFence.aborted;
  throw new Error(`no port reports ${kind} under ${authority}`);
};

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
      sources: [source(h, "m1")],
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
      sources: [source(h, "m1")],
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

    coordinatorOf(h).claim({ targetActorId: "actor:unbound", prompt: "x", sources: [source(h, "m1")] });

    expect(h.cp.db.all(`SELECT 1 FROM canonical_turns`)).toHaveLength(0);
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_sources`)).toHaveLength(0);
  });
});

describe("a source must name a message ingress actually admitted (#666)", () => {
  it("refuses a source naming a channel and nonce nothing ever admitted", () => {
    // `claim()` used to write whatever channel/nonce a caller supplied straight into
    // `canonical_turn_sources`, with nothing checking it against `inbound_messages`. A source
    // could then name a message nobody admitted, and the retry chain would reason about attempts
    // of a message with no admission record.
    const h = makeHarness();
    const actorId = target(h, "ceo");

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      // Built by hand rather than through the `source` fixture, which is exactly the point:
      // the fixture always admits the message it names, and a caller is not a fixture.
      sources: [{ channel: "telegram", nonce: "ghost", attempt: 1, payload: { text: "ghost" } }],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_SOURCE_UNADMITTED);
  });

  it("writes nothing when it refuses an unadmitted source", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");

    coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [{ channel: "telegram", nonce: "ghost", attempt: 1, payload: { text: "ghost" } }],
    });

    expect(h.cp.db.all(`SELECT 1 FROM canonical_turns`)).toHaveLength(0);
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_sources`)).toHaveLength(0);
  });

  it("admits a claim whose every source names a message ingress actually admitted", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1")],
    });

    expect(decision.allowed).toBe(true);
  });

  it("refuses a source whose payload is not the one ingress admitted for that nonce", () => {
    // The counterexample the existence-only check let through: ingress admits `{text:"A"}` for a
    // nonce, and a caller then claims with `{text:"B"}` for that same nonce. The `(channel,
    // nonce)` row exists either way, so a check that stops at existence cannot tell them apart —
    // and `canonical_turn_sources.source_digest` would then record B's digest as what that nonce
    // carried, permanently, in an append-only table. `claim()` has to read the digest
    // `INGRESS_ADMITTED` itself recorded, not trust the caller's payload for both "did this
    // happen" and "what happened".
    const h = makeHarness();
    const actorId = target(h, "ceo");
    admitInbound(h, { nonce: "m1", payload: { text: "A" } });

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [{ channel: "telegram", nonce: "m1", attempt: 1, payload: { text: "B" } }],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_SOURCE_PAYLOAD_MISMATCH);
  });

  it("writes nothing when it refuses a substituted payload", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");
    admitInbound(h, { nonce: "m1", payload: { text: "A" } });

    coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [{ channel: "telegram", nonce: "m1", attempt: 1, payload: { text: "B" } }],
    });

    expect(h.cp.db.all(`SELECT 1 FROM canonical_turns`)).toHaveLength(0);
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_sources`)).toHaveLength(0);
  });
});

describe("an attestation must name the actor's current generation (#666)", () => {
  /**
   * Brings a session to `READY` through `SessionRegistry.transition`, not a raw `UPDATE` of the
   * column — a review's fourth finding was that these fixtures built states production could not,
   * and the lifecycle column is exactly such a state (#666 round 3).
   */
  const readySession = (h: Harness, sessionId: string, incarnation: string): void => {
    h.cp.sessions.create({ provider: "claude", model: "opus", sessionId, incarnation });
    const ready = h.cp.sessions.transition(sessionId, SessionLifecycle.READY, "test");
    if (!ready.allowed) throw new Error(`session ${sessionId} did not reach READY: ${ready.reasonCode}`);
  };

  /** The actor id `BindingRegistry` gave a role_key, read rather than fabricated. */
  const actorOf = (h: Harness, roleKey: string): string => {
    const row = h.cp.db.get<{ actor_id: string }>(
      `SELECT actor_id FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
      [roleKey],
    );
    if (!row) throw new Error(`no active assignment for role key ${roleKey}`);
    return row.actor_id;
  };

  /** This actor's one lifetime target binding, read rather than fabricated. */
  const bindingOf = (h: Harness, actorId: string): string =>
    h.cp.db.get<{ target_binding_id: string }>(
      `SELECT target_binding_id FROM actor_target_bindings WHERE target_actor_id = ?`,
      [actorId],
    )!.target_binding_id;

  /**
   * The one thing nothing in production writes yet (the activation embargo's writer is a
   * separate gap, not this one) — so this stays a direct insert while everything around it now
   * goes through `BindingRegistry`/`SessionRegistry`.
   */
  const attest = (
    h: Harness,
    input: {
      id: string;
      targetBindingId: string;
      sessionId: string;
      incarnation: string;
      generation: number;
      assignmentId: string;
    },
  ): void => {
    h.cp.db.run(
      `INSERT INTO actor_target_attestations
         (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
          executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
          attested_at)
       VALUES (?, ?, 'v1', ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.targetBindingId,
        `digest:${input.id}`,
        input.sessionId,
        input.incarnation,
        input.generation,
        input.assignmentId,
        NOW,
      ],
    );
  };

  /**
   * An actor whose attestation is real but stale: a runtime once verified the target under
   * generation 1, the role then failed over to a new runtime under generation 2, and nothing
   * ever told `actor_target_attestations` — because nothing writes it in production yet either
   * (the activation embargo's writer is a separate gap, not this one). `claim()` used to pick
   * the most recent attestation by timestamp alone, which is this one: there is only one.
   *
   * Built through `revoke()` then `bind()` again — the actual sequence a real failover takes
   * (`BindingRegistry` has no method that rewrites a live assignment's generation in place), and
   * `bind()` reuses this actor because the verified target is the one it already owns.
   */
  const staleGenerationActor = (h: Harness): { actorId: string; targetBindingId: string } => {
    readySession(h, "sess-old", "inc-old");
    const bound = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-old",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-stale-gen", targetLocatorDigest: "digest:stale-gen" },
    });
    if (!bound.allowed) throw new Error(`bind refused: ${bound.reasonCode}`);
    const actorId = actorOf(h, bound.value.roleKey);
    const targetBindingId = bindingOf(h, actorId);
    attest(h, {
      id: "att:stale-gen",
      targetBindingId,
      sessionId: "sess-old",
      incarnation: "inc-old",
      generation: 1,
      assignmentId: bound.value.assignmentId,
    });

    // The role failed over: revoked, then bound again under a new runtime. The old attestation is
    // left exactly where it was, naming a generation the role has moved past.
    const revoked = h.cp.bindings.revoke(bound.value.roleKey, "test failover");
    if (!revoked.allowed) throw new Error(`revoke refused: ${revoked.reasonCode}`);
    readySession(h, "sess-new", "inc-new");
    const rebound = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-new",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-stale-gen", targetLocatorDigest: "digest:stale-gen" },
    });
    if (!rebound.allowed) throw new Error(`rebind refused: ${rebound.reasonCode}`);
    return { actorId, targetBindingId };
  };

  it("refuses a claim whose only attestation names a generation the role has moved past", () => {
    const h = makeHarness();
    const { actorId } = staleGenerationActor(h);

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TARGET_ATTESTATION_STALE);
  });

  it("writes nothing when it refuses a stale-generation attestation", () => {
    const h = makeHarness();
    const { actorId } = staleGenerationActor(h);

    coordinatorOf(h).claim({ targetActorId: actorId, prompt: "hello", sources: [source(h, "m1")] });

    expect(h.cp.db.all(`SELECT 1 FROM canonical_turns`)).toHaveLength(0);
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_sources`)).toHaveLength(0);
  });

  it("refuses on generation alone, with the session and incarnation identical throughout", () => {
    // A review's second finding: the test above changes generation *and* session/incarnation
    // together, so deleting the generation condition alone left that case still refused by the
    // session mismatch — the mutation row for it could not have killed anything. This isolates
    // the one thing under test: revoked and bound again under the *same* session, so nothing
    // about the runtime changes and only the generation the role is at moves.
    const h = makeHarness();
    readySession(h, "sess-fixed", "inc-fixed");
    const first = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-fixed",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-isolated", targetLocatorDigest: "digest:isolated" },
    });
    if (!first.allowed) throw new Error(`bind refused: ${first.reasonCode}`);
    const actorId = actorOf(h, first.value.roleKey);
    const targetBindingId = bindingOf(h, actorId);

    const revoked = h.cp.bindings.revoke(first.value.roleKey, "test regeneration");
    if (!revoked.allowed) throw new Error(`revoke refused: ${revoked.reasonCode}`);
    const second = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-fixed",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-isolated", targetLocatorDigest: "digest:isolated" },
    });
    if (!second.allowed) throw new Error(`rebind refused: ${second.reasonCode}`);
    expect(second.value.sessionId).toBe("sess-fixed");
    expect(second.value.bindingGeneration).toBe(first.value.bindingGeneration + 1);

    // The stale attestation names the exact same session and incarnation the role is *still* at —
    // only the generation it names is the one the role has moved past.
    attest(h, {
      id: "att:isolated",
      targetBindingId,
      sessionId: "sess-fixed",
      incarnation: "inc-fixed",
      generation: first.value.bindingGeneration,
      assignmentId: first.value.assignmentId,
    });

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TARGET_ATTESTATION_STALE);
  });

  it("refuses a stale attestation matched through a different role's generation, not its own", () => {
    // A review's first finding: the join found *any* ACTIVE assignment on the actor whose
    // generation matched, and generation is minted per role_key — so a generation number means
    // nothing without the role_key it belongs to. `bind()` can reuse one physical actor across
    // different roles for the same verified target (#657); this builds exactly that reuse and
    // shows a stale attestation for the actor's own (CEO) identity matched through an unrelated
    // WORKER assignment whose own generation counter happened to coincide.
    const h = makeHarness();
    readySession(h, "sess-ceo-1", "inc-1");
    const ceoBound = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-ceo-1",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-reuse", targetLocatorDigest: "digest:reuse" },
    });
    if (!ceoBound.allowed) throw new Error(`ceo bind refused: ${ceoBound.reasonCode}`);
    const actorId = actorOf(h, ceoBound.value.roleKey);
    const targetBindingId = bindingOf(h, actorId);

    // The CEO role replaces its runtime: `switchTo(REPLACED)` mints a fresh actor at generation 2
    // and revokes this actor's own CEO assignment — but never touches `actor_target_bindings`, so
    // this actor keeps the lifetime target it always owned.
    readySession(h, "sess-ceo-2", "inc-2");
    const replaced = h.cp.bindings.switchTo({
      role: Role.CEO,
      sessionId: "sess-ceo-2",
      reason: "test replace",
      conversation: "REPLACED",
    });
    expect(replaced.allowed).toBe(true);

    // The same physical actor is reused for an unrelated WORKER binding, for the same verified
    // target — the reuse this counterexample turns on.
    readySession(h, "sess-worker", "inc-w");
    const workerBound = h.cp.bindings.bind({
      role: Role.WORKER,
      sessionId: "sess-worker",
      taskId: "t1",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-reuse", targetLocatorDigest: "digest:reuse" },
    });
    if (!workerBound.allowed) throw new Error(`worker bind refused: ${workerBound.reasonCode}`);
    expect(actorOf(h, workerBound.value.roleKey)).toBe(actorId);

    // A stale attestation for this actor's original CEO identity, at generation 1 — the CEO role
    // has moved to generation 2, under a different actor entirely. It happens to equal the
    // WORKER binding's own, unrelated, generation 1, and it names the session this actor's live
    // pointer actually holds now (updated by the WORKER reuse) — so only the role scoping stands
    // between this and admission.
    attest(h, {
      id: "att:reuse",
      targetBindingId,
      sessionId: "sess-worker",
      incarnation: "inc-w",
      generation: workerBound.value.bindingGeneration,
      assignmentId: ceoBound.value.assignmentId,
    });

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TARGET_ATTESTATION_STALE);
  });

  it("refuses an unrelated role_key's generation reviving a retired one under the same role", () => {
    // A follow-up review's counterexample: `role = kind` is not `role_key`. `WORKER:task-A` and
    // `WORKER:task-B` are two different role_keys that share one `role`, and each counts its own
    // generation from 1 — so a fix that stopped at `role` cannot tell them apart. `bind()` reuses
    // the actor for the same verified target (#657); this shows a stale generation-1 attestation
    // for task-A's retired identity revived by task-B's own, unrelated, generation-1 counter,
    // through the same session task-A originally used.
    const h = makeHarness();
    readySession(h, "sess-shared", "inc-shared");
    const taskABound = h.cp.bindings.bind({
      role: Role.WORKER,
      sessionId: "sess-shared",
      taskId: "task-A",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-samerole", targetLocatorDigest: "digest:samerole" },
    });
    if (!taskABound.allowed) throw new Error(`task-A bind refused: ${taskABound.reasonCode}`);
    const actorId = actorOf(h, taskABound.value.roleKey);
    const targetBindingId = bindingOf(h, actorId);
    attest(h, {
      id: "att:same-role",
      targetBindingId,
      sessionId: "sess-shared",
      incarnation: "inc-shared",
      generation: taskABound.value.bindingGeneration,
      assignmentId: taskABound.value.assignmentId,
    });

    // task-A replaces its runtime: a fresh actor takes generation 2 under that role_key, and this
    // actor's task-A assignment is revoked.
    readySession(h, "sess-task-a-2", "inc-a2");
    const replaced = h.cp.bindings.switchTo({
      role: Role.WORKER,
      taskId: "task-A",
      sessionId: "sess-task-a-2",
      reason: "test replace",
      conversation: "REPLACED",
    });
    expect(replaced.allowed).toBe(true);

    // The same physical actor is reused for a *different* WORKER role_key, task-B — bound to the
    // same session task-A originally used, so the live pointer returns to exactly where the stale
    // attestation says it is. Only the role_key is different; the role, and now the session, are
    // identical to what the stale attestation names.
    const taskBBound = h.cp.bindings.bind({
      role: Role.WORKER,
      sessionId: "sess-shared",
      taskId: "task-B",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-samerole", targetLocatorDigest: "digest:samerole" },
    });
    if (!taskBBound.allowed) throw new Error(`task-B bind refused: ${taskBBound.reasonCode}`);
    expect(actorOf(h, taskBBound.value.roleKey)).toBe(actorId);
    expect(taskBBound.value.bindingGeneration).toBe(1);

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TARGET_ATTESTATION_STALE);
  });

  it("refuses an attestation whose claimed generation disagrees with the assignment it names", () => {
    // A third review's counterexample: `assignment_id` pins *which* assignment an attestation
    // speaks for; on its own it does not check what the attestation *says* about that
    // assignment. An attestation could cite a real, currently ACTIVE assignment_id while
    // claiming generation 1, when that very assignment's own row already reads 2 — the join
    // matched on identity alone, admitted the claim, and `canonical_turns` recorded generation 2
    // for a turn no attestation ever attested. `attestation_generation_matches_assignment`
    // refuses this shape at the source (write time); this test drops that trigger first, so it
    // proves the read-time join is independently sufficient for a row that reached the table by
    // any other path — not merely that the trigger caught it before the query had to.
    const h = makeHarness();
    readySession(h, "sess-mismatch-1", "inc-1");
    const first = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-mismatch-1",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-mismatch", targetLocatorDigest: "digest:mismatch" },
    });
    if (!first.allowed) throw new Error(`bind refused: ${first.reasonCode}`);
    const actorId = actorOf(h, first.value.roleKey);
    const targetBindingId = bindingOf(h, actorId);

    const revoked = h.cp.bindings.revoke(first.value.roleKey, "test regeneration");
    if (!revoked.allowed) throw new Error(`revoke refused: ${revoked.reasonCode}`);
    readySession(h, "sess-mismatch-2", "inc-2");
    const second = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-mismatch-2",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-mismatch", targetLocatorDigest: "digest:mismatch" },
    });
    if (!second.allowed) throw new Error(`rebind refused: ${second.reasonCode}`);
    expect(second.value.bindingGeneration).toBe(2);

    // The one row a trigger would refuse: a real, ACTIVE assignment_id, claiming a generation
    // that is not the one on that row. `Db.run` is DML-only by design (it cannot drop a
    // trigger), so this uses a second, unrestricted connection to the same file — the same
    // escape hatch `a-dispatch-is-a-fact.test.ts` names: "that handle can also DROP TRIGGER".
    const foreign = new Database(join(h.root, "state.sqlite"));
    try {
      foreign.exec(`DROP TRIGGER attestation_generation_matches_assignment`);
    } finally {
      foreign.close();
    }
    attest(h, {
      id: "att:mismatch",
      targetBindingId,
      sessionId: "sess-mismatch-2",
      incarnation: "inc-2",
      generation: 1,
      assignmentId: second.value.assignmentId,
    });

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TARGET_ATTESTATION_STALE);
  });

  it("refuses to record an attestation whose generation disagrees with the assignment it names", () => {
    // The write-time half: the trigger itself, reached the ordinary way rather than by dropping
    // it first.
    const h = makeHarness();
    readySession(h, "sess-write-1", "inc-1");
    const first = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-write-1",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-write", targetLocatorDigest: "digest:write" },
    });
    if (!first.allowed) throw new Error(`bind refused: ${first.reasonCode}`);
    const actorId = actorOf(h, first.value.roleKey);
    const targetBindingId = bindingOf(h, actorId);

    const revoked = h.cp.bindings.revoke(first.value.roleKey, "test regeneration");
    if (!revoked.allowed) throw new Error(`revoke refused: ${revoked.reasonCode}`);
    readySession(h, "sess-write-2", "inc-2");
    const second = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-write-2",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-write", targetLocatorDigest: "digest:write" },
    });
    if (!second.allowed) throw new Error(`rebind refused: ${second.reasonCode}`);
    expect(second.value.bindingGeneration).toBe(2);

    // A string match on the message is what let the omission through in the first place: the
    // trigger raised the sentinel, but with no `TRIGGER_CODES` entry the denial reached this
    // test as a raw SQLite error, and a substring match on that raw message would have passed
    // just as happily as it would on a typed one. Asserting `isAcpError` and the reason code is
    // what actually distinguishes a Decision-shaped refusal from a database exception no caller
    // asked for.
    let thrown: unknown;
    try {
      attest(h, {
        id: "att:write-mismatch",
        targetBindingId,
        sessionId: "sess-write-2",
        incarnation: "inc-2",
        generation: 1,
        assignmentId: second.value.assignmentId,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isAcpError(thrown)).toBe(true);
    if (isAcpError(thrown)) {
      expect(thrown.reasonCode).toBe(ReasonCode.ATTESTATION_GENERATION_MISMATCH);
    }
  });

  it("refuses an attestation whose assignment_id names a different actor's assignment entirely", () => {
    // The audit this round asked for: what else on the row is a copy of something authoritative
    // elsewhere, unchecked? `target_binding_id` implies an actor (via `actor_target_bindings`);
    // `assignment_id` implies one too (via `assignments.actor_id`), and nothing before this
    // asked whether they agree. The generation trigger above does not catch this shape — the
    // cited assignment's generation is exactly right, for its *own* actor — only
    // `asg.actor_id = ca.actor_id` in the query does. This constructs a real, ACTIVE, correctly
    // generationed assignment that simply belongs to someone else, and asks `claim()` to admit
    // through it anyway.
    const h = makeHarness();
    readySession(h, "sess-owner", "inc-owner");
    const owner = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-owner",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-owner", targetLocatorDigest: "digest:owner" },
    });
    if (!owner.allowed) throw new Error(`owner bind refused: ${owner.reasonCode}`);
    const ownerActorId = actorOf(h, owner.value.roleKey);
    const targetBindingId = bindingOf(h, ownerActorId);

    // A second, unrelated actor — a different verified target, so no reuse — with its own
    // real, ACTIVE assignment at its own real generation.
    readySession(h, "sess-stranger", "inc-stranger");
    const stranger = h.cp.bindings.bind({
      role: Role.WORKER,
      sessionId: "sess-stranger",
      taskId: "task-stranger",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-stranger", targetLocatorDigest: "digest:stranger" },
    });
    if (!stranger.allowed) throw new Error(`stranger bind refused: ${stranger.reasonCode}`);
    expect(actorOf(h, stranger.value.roleKey)).not.toBe(ownerActorId);

    // An attestation for the owner's binding, naming the owner's own live session (so every
    // other condition reads as current) but citing the stranger's assignment_id — generation
    // matches that assignment exactly, so only the actor identity is wrong.
    attest(h, {
      id: "att:stranger",
      targetBindingId,
      sessionId: "sess-owner",
      incarnation: "inc-owner",
      generation: stranger.value.bindingGeneration,
      assignmentId: stranger.value.assignmentId,
    });

    const decision = coordinatorOf(h).claim({
      targetActorId: ownerActorId,
      prompt: "hello",
      sources: [source(h, "m1")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TARGET_ATTESTATION_STALE);
  });

  it("refuses a retired actor's attestation even under its recorded generation", () => {
    // Retirement is terminal (`conversational_actors_retirement_terminal`); admitting a turn for
    // a retired actor would make superseded authority current again.
    const h = makeHarness();
    const actorId = target(h, "retiree");
    h.cp.db.run(
      `UPDATE conversational_actors SET retired_at = ?, retired_reason = 'test' WHERE actor_id = ?`,
      [NOW, actorId],
    );

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TARGET_ATTESTATION_STALE);
  });

  it("admits a claim under an attestation that still names the actor's current generation", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1")],
    });

    expect(decision.allowed).toBe(true);
  });

  /**
   * A role whose counterpart *survived* a failover (#493): only the runtime moved, so
   * `BindingRegistry.switchTo({ conversation: "SURVIVED" })` never rewrites `assignments` — the
   * same generation, the same binding row, the same `assignments.session_id` it was created with
   * (schema's own words: "The runtime at binding time, not the live one"). The live pointer moves
   * only on `conversational_actors.current_session_id`.
   *
   * A fresh attestation naming the new live session is exactly the current, honest state of this
   * actor — and `claim()` must admit it.
   */
  const survivedFailoverActor = (h: Harness): { actorId: string; targetBindingId: string } => {
    readySession(h, "sess-original", "inc-1");
    const bound = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-original",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-survived", targetLocatorDigest: "digest:survived" },
    });
    if (!bound.allowed) throw new Error(`bind refused: ${bound.reasonCode}`);
    const actorId = actorOf(h, bound.value.roleKey);
    const targetBindingId = bindingOf(h, actorId);

    // The failover: only the live pointer moves, to a new session and incarnation. `assignments`
    // is untouched by `switchTo(SURVIVED)` — same generation, same `session_id`.
    readySession(h, "sess-failover", "inc-2");
    const survived = h.cp.bindings.switchTo({
      role: Role.CEO,
      sessionId: "sess-failover",
      reason: "test survived failover",
      conversation: "SURVIVED",
    });
    if (!survived.allowed) throw new Error(`switchTo refused: ${survived.reasonCode}`);

    // A fresh attestation from the surviving runtime, naming its own live session and the
    // generation that never changed.
    attest(h, {
      id: "att:survived",
      targetBindingId,
      sessionId: "sess-failover",
      incarnation: "inc-2",
      generation: survived.value.bindingGeneration,
      assignmentId: survived.value.assignmentId,
    });
    return { actorId, targetBindingId };
  };

  it("admits a claim after a SURVIVED failover, under the live session and the generation that never changed", () => {
    const h = makeHarness();
    const { actorId } = survivedFailoverActor(h);

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1")],
    });

    expect(decision.allowed).toBe(true);
  });

  it("refuses an attestation whose named session is no longer usable, though still the live pointer", () => {
    // A review's third finding: "live" was checked as "still pointed at", not "still usable".
    // `SessionRegistry.transition` moves `sessions.lifecycle` to `ERROR` or `STOPPED` without ever
    // touching `conversational_actors.current_session_id` — #493 moved the live pointer off
    // `assignments` for exactly the SURVIVED case above, and nothing sweeps it when the session it
    // names stops being usable for a different reason.
    const h = makeHarness();
    readySession(h, "sess-errored", "inc-1");
    const bound = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: "sess-errored",
      verifiedTarget: { executorKind: "hermes", targetLocator: "loc-error", targetLocatorDigest: "digest:error" },
    });
    if (!bound.allowed) throw new Error(`bind refused: ${bound.reasonCode}`);
    const actorId = actorOf(h, bound.value.roleKey);
    const targetBindingId = bindingOf(h, actorId);
    attest(h, {
      id: "att:error",
      targetBindingId,
      sessionId: "sess-errored",
      incarnation: "inc-1",
      generation: bound.value.bindingGeneration,
      assignmentId: bound.value.assignmentId,
    });

    const errored = h.cp.sessions.transition("sess-errored", SessionLifecycle.ERROR, "test");
    expect(errored.allowed).toBe(true);

    const decision = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1")],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TARGET_ATTESTATION_STALE);
  });
});

describe("a claim takes the hold in the same transaction", () => {
  it("records the turn already in doubt, before anything has run", () => {
    // The ordering the design turns on. The hold exists before the peer is called, so a crash
    // during the call leaves a record that says "unknown" rather than leaving no record at all.
    const h = makeHarness();
    const actorId = target(h, "ceo");

    const permit = claimOf(h, actorId, [source(h, "m1")]);

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

    const permit = claimOf(h, actorId, [source(h, "m1"), source(h, "m2"), source(h, "m3")]);

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
      sources: [source(h, "m1", 0)],
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
    claimOf(h, actorId, [source(h, "m1")]);

    const second = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "another",
      sources: [source(h, "m2")],
    });

    expect(second.allowed).toBe(false);
    expect(second.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_IN_DOUBT);
  });

  it("leaves the first turn untouched when it refuses the second", () => {
    // The refused claim must not have consumed the incumbent's sources or moved its state. This
    // is the half a bare "it throws" assertion would not notice.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const first = claimOf(h, actorId, [source(h, "m1")]);

    coordinatorOf(h).claim({ targetActorId: actorId, prompt: "another", sources: [source(h, "m2")] });

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
    const first = claimOf(h, actorId, [source(h, "m1")]);

    settle(coordinatorOf(h), first, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });
    const second = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "another",
      sources: [source(h, "m2")],
    });

    expect(second.allowed).toBe(true);
  });

  it("holds one conversation without blocking another", () => {
    // The hold is per conversation. A single global lock would make two CTOs serialise against
    // each other for no reason, which is the scaling shape this design refuses.
    const h = makeHarness();
    const ceo = target(h, "ceo");
    const cto = target(h, "cto");
    claimOf(h, ceo, [source(h, "m1")]);

    const other = coordinatorOf(h).claim({
      targetActorId: cto,
      prompt: "unrelated",
      sources: [source(h, "m2")],
    });

    expect(other.allowed).toBe(true);
  });
});

describe("a retry is legal only when the previous attempt ended safely", () => {
  const settleFirst = (h: Harness, actorId: string, outcome: "NEVER_ADMITTED" | "ABORTED" | "COMPLETED") => {
    const first = claimOf(h, actorId, [source(h, "m1")]);
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
      sources: [source(h, "m1", 2)],
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
    claimOf(h, first, [source(h, "m1")]);

    const decision = coordinatorOf(h).claim({
      targetActorId: second,
      prompt: "hello",
      sources: [source(h, "m1", 2)],
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
      sources: [source(h, "m1", 3)],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_ATTEMPT_UNCHAINED);
  });

  it("records which turn a retry followed", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const first = claimOf(h, actorId, [source(h, "m1")]);
    settle(coordinatorOf(h), first, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });
    claimOf(h, actorId, [source(h, "m1", 2)]);

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
    const permit = claimOf(h, actorId, [source(h, "m1")]);

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

  it("refuses a settlement that cites nothing, in the coordinator and in the table", () => {
    // Measured on 74c37fa, the head that merged this ledger: all three fields were NOT NULL and
    // nothing said they could not be empty, so this exact call was accepted and stored blank. A
    // turn then read COMPLETED / HERMES_TARGET while citing no receipt, no evidence and no reason,
    // and the retry rule refuses to re-run the owner's message on the strength of it.
    //
    // `receipt_id` is the sharpest of the three: it is half of `(observing_authority, receipt_id)`,
    // so the first blank settlement an authority makes takes that slot and the next one is read as
    // a redelivery of it.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source(h, "m1")]);

    for (const receipt of [
      { receiptId: "", evidenceDigest: "sha256:x", reasonCode: ReasonCode.OK },
      { receiptId: "r", evidenceDigest: "", reasonCode: ReasonCode.OK },
      { receiptId: "r", evidenceDigest: "sha256:x", reasonCode: "" as ReasonCode },
      { receiptId: "  ", evidenceDigest: "sha256:x", reasonCode: ReasonCode.OK },
    ]) {
      const refused = h.cp.conversation.ports.target.completed(permit, receipt as TurnReceipt);
      expect(refused.allowed).toBe(false);
      if (!refused.allowed) {
        expect(refused.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_OBSERVATION_UNEVIDENCED);
      }
    }
    expect(h.cp.db.all(`SELECT 1 FROM canonical_turn_observations`)).toEqual([]);

    // And in the table, because the coordinator refusing is a rule a caller can be written around
    // — which is the premise the whole ledger is built on.
    //
    // Entered through the one path that actually reaches the CHECK. An ordinary `db.run` is
    // refused by the authority trigger first, so asserting on it passes with the CHECK deleted:
    // the falsifiability sweep reported this row SURVIVED until the insert came from a connection
    // that had already defeated that trigger.
    //
    // Which is also a finding worth keeping as a test. A foreign process that opens its own SQLite
    // API handle and registers a scalar named `acp_turn_materialization_authorized` returning 1
    // gets past the authority trigger, because SQLite resolves the function on the connection
    // executing the statement. That handle can also DROP TRIGGER, so this is the ceiling of what
    // the DB guards promise — they bind in-process writers and DML-only callers, not a process
    // holding an API handle. What must still hold at that ceiling is that the row it writes is at
    // least a row that carries evidence.
    const foreign = new Database(join(h.root, "state.sqlite"));
    try {
      foreign.function("acp_turn_materialization_authorized", (_turnRequestId: unknown) => 1);
      const insert = foreign.prepare(
        `INSERT INTO canonical_turn_observations
           (turn_request_id, observed_outcome, observing_authority, receipt_id, evidence_digest,
            reason_code, observed_at, audit_event_id)
         VALUES (?, 'COMPLETED', 'HERMES_TARGET', ?, ?, ?, ?, (SELECT MIN(event_id) FROM audit_events))`,
      );
      expect(() => insert.run(permit.turnRequestId, "", "", "", NOW)).toThrow(/CHECK constraint/);
      expect(() => insert.run(permit.turnRequestId, "r", "", "OK", NOW)).toThrow(/CHECK constraint/);
      expect(() => insert.run(permit.turnRequestId, "r", "sha256:x", "", NOW)).toThrow(/CHECK constraint/);
    } finally {
      foreign.close();
    }

    // The turn is untouched: a refused settlement must not be a partial one.
    const row = h.cp.db.get<{ lifecycle_state: string }>(
      `SELECT lifecycle_state FROM canonical_turns WHERE turn_request_id = ?`,
      [permit.turnRequestId],
    );
    expect(row?.lifecycle_state).toBe("IN_DOUBT");
  });

  it("lets a late target receipt beat an earlier mistaken refusal, and keeps both", () => {
    // The behaviour that replaced first-settlement-wins. A pre-dispatch refusal arriving before
    // the target's real receipt used to keep the false retry-safe answer and discard the true
    // one — worse than the overwrite it prevented, because an overwrite loses the first record
    // and this lost the correct one.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source(h, "m1")]);
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
    const permit = claimOf(h, actorId, [source(h, "m1")]);
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
    const permit = claimOf(h, actorId, [source(h, "m1")]);
    const twice = () =>
      coordinatorOf(h).ports.target.completed(permit, {
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
    const real = claimOf(h, actorId, [source(h, "m1")]);

    const decision = settleWith(h, { ...real, issuance: "00".repeat(32) });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_PERMIT_UNISSUED);
    expect(coordinatorOf(h).unresolved(actorId)).toHaveLength(1);
  });

  it("refuses a permit whose signature is absent entirely", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const real = claimOf(h, actorId, [source(h, "m1")]);

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
    const real = claimOf(h, ceo, [source(h, "m1")]);
    claimOf(h, cto, [source(h, "m2")]);

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
    claimOf(h, target(h, "ceo"), [source(h, "m1")]);

    expect(anotherCoordinator(h)).toThrow();
  });

  it("records the audit against the turn's own actor", () => {
    // Taken from the row rather than from the permit, so no future bug in permit handling can
    // steer who the audit says a settlement was about.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source(h, "m1")]);

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
    claimOf(h, actorId, [source(h, "m1")]);

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
    const permit = claimOf(h, actorId, [source(h, "m1")]);
    coordinatorOf(h).ports.acpObservedReply.sawCompletion(permit, {
      receiptId: "acp-1",
      evidenceDigest: "sha256:watched",
      reasonCode: ReasonCode.OK,
    });
    settle(coordinatorOf(h), permit, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });

    const retry = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1", 2)],
    });

    expect(retry.allowed).toBe(false);
    expect(retry.reasonCode).toBe(ReasonCode.CONVERSATION_TURN_ATTEMPT_UNSAFE);
  });

  it("raises the disagreement rather than reporting it as consistent", () => {
    // "ACP observed a reply" and "nothing was admitted" cannot both be true, so the honest
    // record is a disagreement — not a settlement that looks decided.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source(h, "m1")]);
    coordinatorOf(h).ports.acpObservedReply.sawCompletion(permit, {
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
    //
    // The target receipt is recorded without marking the turn dispatched, which is what a caller
    // that reached the target without telling the ledger looks like. With a dispatch row the
    // pre-dispatch claim below is refused outright (#662) and this disagreement cannot form —
    // correctly, and it would leave the dispute check with no case of its own.
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const permit = claimOf(h, actorId, [source(h, "m1")]);
    coordinatorOf(h).ports.target.aborted(permit, {
      receiptId: `receipt-${(receiptCounter += 1)}`,
      evidenceDigest: "sha256:fence",
      reasonCode: ReasonCode.OK,
    });
    settle(coordinatorOf(h), permit, {
      kind: "NEVER_ADMITTED",
      authority: "ACP_PRE_DISPATCH",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });

    const retry = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "hello",
      sources: [source(h, "m1", 2)],
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
    const permit = claimOf(h, actorId, [source(h, "m1")]);
    coordinatorOf(h).ports.acpObservedReply.sawCompletion(permit, {
      receiptId: "acp-1",
      evidenceDigest: "sha256:watched",
      reasonCode: ReasonCode.OK,
    });
    coordinatorOf(h).ports.target.completed(permit, {
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
    const permit = claimOf(h, actorId, [source(h, "m1")]);
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
    coordinatorOf(h).ports.acpObservedReply.sawCompletion(permit, {
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
    const permit = claimOf(h, actorId, [source(h, "m1")]);
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

    const next = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "a new question",
      sources: [source(h, "m2")],
    });

    expect(next.allowed).toBe(false);
    expect(next.reasonCode).toBe(ReasonCode.CONVERSATION_ACTOR_QUARANTINED);
  });

  it("names the disputed turn, so the refusal points somewhere", () => {
    const h = makeHarness();
    const actorId = target(h, "ceo");
    const disputed = contradict(h, actorId);

    const next = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "q",
      sources: [source(h, "m2")],
    });

    expect(next.evidence).toMatchObject({ contradicted: disputed.turnRequestId });
  });

  it("quarantines the disputed conversation and no other", () => {
    // Per actor, not global. A disagreement on one conversation stopping every other would be a
    // worse failure than the one it is protecting against.
    const h = makeHarness();
    contradict(h, target(h, "ceo"));
    const cto = target(h, "cto");

    expect(
      coordinatorOf(h).claim({ targetActorId: cto, prompt: "q", sources: [source(h, "m3")] }).allowed,
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
    claimOf(h, actorId, [source(h, "m1")]);

    h.clock.advance(60 * 60 * 1000);
    const next = coordinatorOf(h).claim({
      targetActorId: actorId,
      prompt: "later",
      sources: [source(h, "m2")],
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
    const permit = claimOf(h, actorId, [source(h, "m1")]);
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
    claimOf(h, actorId, [source(h, "m1")]);

    expect(coordinatorOf(h).unresolved(actorId).map((t) => t.claimedAt)).toEqual([h.clock.nowIso()]);
  });
});


const denialCode = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    return isAcpError(error) ? error.reasonCode : `unstructured:${String(error)}`;
  }
  return "not-denied";
};

/**
 * What the composition root reserving the capability actually buys.
 *
 * The issuer is a public method on a `Db`, so nothing stops code that already holds the database
 * from calling it — that is a property of the language, not of this design, and claiming
 * otherwise would be the check that does not hold its own subject. What *is* enforceable is the
 * order: the production root claims it while it is still constructing itself, so a later claimant
 * loses loudly instead of quietly becoming a second materializer.
 */
describe("the composition root owns the materializer", () => {
  it("has already claimed the authority by the time anything else can ask", () => {
    const h = makeHarness();
    expect(denialCode(() => h.cp.db.claimTurnMaterializationAuthority())).toBe(
      ReasonCode.COMPLETION_AUTHORITY_DENIED,
    );
  });

  it("hands the same coordinator to every caller rather than minting one per use", () => {
    const h = makeHarness();
    expect(h.cp.conversation).toBe(h.cp.conversation);
  });
});


/**
 * What the ports buy, stated as something that can fail.
 *
 * A caller used to pass `authority` as a field, so "the target committed this turn" was a string
 * anyone holding the coordinator could type and the ledger recorded a provenance nobody had
 * established. The ports derive it from which object the caller was handed. That is a wiring
 * property and no runtime test can prove a component was handed the right one — what *is*
 * checkable is that each port records only its own authority, and that the pairs the ports can
 * express are exactly the pairs the schema is willing to store. If those two sets ever drift, one
 * of them is enforcing something the other only names.
 */
describe("an authority is derived from the port, not supplied by the caller", () => {
  const pairsThePortsCanExpress = (h: Harness): string[] => {
    const { ports } = coordinatorOf(h);
    const actorId = target(h, "ports");
    const written: string[] = [];
    const record = (
      label: string,
      call: (permit: TurnPermit, receipt: TurnReceipt) => Decision<TurnMaterialization>,
    ): void => {
      const permit = claimOf(h, actorId, [source(h, label)]);
      const decision = call(permit, {
        receiptId: `receipt:${label}`,
        evidenceDigest: "sha256:e",
        reasonCode: ReasonCode.OK,
      });
      expect(decision.allowed).toBe(true);
      const row = h.cp.db.get<{ observed_outcome: string; observing_authority: string }>(
        `SELECT observed_outcome, observing_authority FROM canonical_turn_observations
          WHERE receipt_id = ?`,
        [`receipt:${label}`],
      )!;
      written.push(`${row.observed_outcome}/${row.observing_authority}`);
    };
    record("a", ports.preDispatch.neverAdmitted);
    record("b", ports.target.completed);
    record("c", ports.target.aborted);
    record("d", ports.ownerFence.aborted);
    record("e", ports.acpObservedReply.sawCompletion);
    return written.sort();
  };

  it("records exactly the pairs the schema permits, and no others", () => {
    const h = makeHarness();

    // The CHECK on canonical_turn_observations, written out. Kept here rather than read from the
    // schema on purpose: a test that derives its expectation from the thing under test agrees
    // with it by construction.
    expect(pairsThePortsCanExpress(h)).toEqual(
      [
        "ABORTED/HERMES_TARGET",
        "ABORTED/OWNER_AFTER_TARGET_FENCE",
        "COMPLETED/ACP_OBSERVED_HERMES_REPLY",
        "COMPLETED/HERMES_TARGET",
        "NEVER_ADMITTED/ACP_PRE_DISPATCH",
      ].sort(),
    );
  });

  it("refuses a pair no port can express, so the two agree by enforcement rather than by habit", () => {
    const h = makeHarness();
    const actorId = target(h, "unreachable");
    const permit = claimOf(h, actorId, [source(h, "u")]);

    expect(() =>
      h.cp.db.run(
        `INSERT INTO canonical_turn_observations
           (turn_request_id, observed_outcome, observing_authority, receipt_id, evidence_digest,
            reason_code, observed_at, audit_event_id)
         VALUES (?, 'NEVER_ADMITTED', 'HERMES_TARGET', 'r', 'sha256:e', 'OK', ?, 1)`,
        [permit.turnRequestId, "2026-08-22T00:00:00.000Z"],
      ),
    ).toThrow();
  });
});
