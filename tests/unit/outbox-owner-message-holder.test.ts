import { afterAll, describe, expect, it } from "vitest";

import { InMemoryBuzzTransport, BuzzAdapter } from "../../src/buzz/buzz-adapter.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { SessionLifecycle } from "../../src/domain/types.ts";
import { HOLDER_CLAIMED_KINDS, MessageKind, RETARGETABLE_KINDS } from "../../src/outbox/envelope.ts";
import { Outbox } from "../../src/outbox/outbox.ts";
import type { HolderIdentity } from "../../src/outbox/outbox.ts";
import { cleanupTempDirs, makeCore, makeRepo, seedActor, seedRun } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `#760` Q1 — an owner's message addressed to a role lives in the durable outbox, and only the
 * exact runtime currently holding that role may take it.
 *
 * The Hermes receipt route this replaces could not be built: `ReceiptLookupQuery` is structurally a
 * Hermes target-bind tuple, and the CTO's MCP socket peer has no attestation and no way to acquire
 * one. The outbox already carries every durable fact the lifecycle needs — `role_key`,
 * `binding_generation`, `target_session_id` on the row, and `assignments.session_incarnation` to
 * join against — so nothing here adds a column.
 *
 * Every row below is written against a way a *plausible* implementation still looks green:
 * excluding the kind from the sweep by writing a literal that drifts; returning the payload from
 * the read rather than from the row the update moved; checking the binding but not the incarnation;
 * and leaving a `SENT` row untouched on failover because the generic sweep never looks at `SENT`.
 */
const seededCore = () => {
  const core = makeCore();
  const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
  return { core, seeded };
};

/** The incarnation `seedRun` writes onto the assignment it creates. */
const SEEDED_INCARNATION = "inc-1";

const holderOf = (seeded: ReturnType<typeof seedRun>): HolderIdentity => ({
  roleKey: seeded.roleKey,
  bindingGeneration: seeded.generation,
  targetSessionId: seeded.sessionId,
  sessionIncarnation: SEEDED_INCARNATION,
});

const enqueueOwnerMessage = (
  core: ReturnType<typeof makeCore>,
  seeded: ReturnType<typeof seedRun>,
  text = "an owner's words",
  key = `owner:${crypto.randomUUID()}`,
) =>
  core.outbox.enqueue({
    idempotencyKey: key,
    roleKey: seeded.roleKey,
    bindingGeneration: seeded.generation,
    targetSessionId: seeded.sessionId,
    runId: seeded.runId,
    kind: MessageKind.OWNER_MESSAGE,
    payload: { text },
  });

describe("an owner-message is taken by its exact holder, and by nothing else", () => {
  /**
   * The kind must never reach the generic sweep, because `BuzzAdapter.deliverPending` drains that
   * sweep and transmits whatever it returns to the target session's Buzz address. A row that
   * leaked into it would have the owner's own words sent over a channel that never authenticated
   * the holder.
   *
   * Entered through the adapter as well as the sweep, because those are different failures: the
   * sweep returning the row is a claim bug, and the adapter transmitting it is the disclosure. A
   * row that only checked `claimDeliverable` would stay green if some other path started draining.
   */
  it("is invisible to the generic delivery sweep and to the Buzz adapter that drains it", async () => {
    const { core, seeded } = seededCore();
    const owner = enqueueOwnerMessage(core, seeded, "not for the wire");
    expect(owner.allowed).toBe(true);

    // A retargetable kind on the same binding, so the row proves the sweep is *working* and the
    // exclusion is what removes the owner-message — not an empty queue or a broken predicate.
    const dispatch = core.outbox.enqueue({
      idempotencyKey: `dispatch:${crypto.randomUUID()}`,
      roleKey: seeded.roleKey,
      bindingGeneration: seeded.generation,
      targetSessionId: seeded.sessionId,
      runId: seeded.runId,
      kind: MessageKind.RUN_DISPATCH,
      payload: { runId: seeded.runId },
    });
    expect(dispatch.allowed).toBe(true);
    if (!owner.allowed || !dispatch.allowed) return;

    const swept = core.outbox.claimDeliverable(50);
    expect(swept.map((m) => m.messageId)).toEqual([dispatch.value.messageId]);
    expect(swept.some((m) => m.kind === MessageKind.OWNER_MESSAGE)).toBe(false);

    // The owner-message is still exactly where it was: excluded, not consumed or fenced.
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("PENDING");

    const transport = new InMemoryBuzzTransport();
    const adapter = new BuzzAdapter(
      core.db,
      core.clock,
      core.audit,
      core.sessions,
      core.bindings,
      core.outbox,
      transport,
    );
    // The address has to be real, and this is the row's positive control rather than setup
    // decoration. With no `buzz_actor_id` the adapter refuses *every* message for want of a
    // recipient, `transport.sent` stays empty, and "the owner-message was not transmitted" would
    // be true of a run that transmitted nothing at all — green while covering nothing.
    expect((await adapter.connect(seeded.sessionId, "shared-channel")).allowed).toBe(true);
    core.db.run(`UPDATE sessions SET buzz_actor_id = ? WHERE session_id = ?`, [
      "actor:target",
      seeded.sessionId,
    ]);
    // A second deliverable, because the direct sweep above already took the first one IN_FLIGHT.
    const overTheWire = core.outbox.enqueue({
      idempotencyKey: `dispatch:${crypto.randomUUID()}`,
      roleKey: seeded.roleKey,
      bindingGeneration: seeded.generation,
      targetSessionId: seeded.sessionId,
      runId: seeded.runId,
      kind: MessageKind.RUN_DISPATCH,
      payload: { runId: seeded.runId },
    });
    expect(overTheWire.allowed).toBe(true);
    if (!overTheWire.allowed) return;

    const sentOut = await adapter.deliverPending(50);
    // The control: the adapter really did transmit on this run, so the absence below is the
    // exclusion working and not the transport being idle.
    expect(sentOut.delivered).toEqual([overTheWire.value.messageId]);
    expect(transport.sent).toHaveLength(1);
    expect(JSON.stringify(transport.sent)).not.toContain("not for the wire");
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("PENDING");

    // The two sets say opposite things about a kind, so an entry in both would be incoherent.
    for (const kind of HOLDER_CLAIMED_KINDS) expect(RETARGETABLE_KINDS.has(kind)).toBe(false);
  });

  /**
   * `PENDING -> SENT` happens before the payload is returned, so a second claim finds nothing to
   * hand over. The unresolved report is what a successor reconciles from, and it carries no
   * payload — which is the state a crash between claim and acknowledgement leaves behind.
   */
  it("hands the payload over once, then reports the row as unresolved without it", () => {
    const { core, seeded } = seededCore();
    const owner = enqueueOwnerMessage(core, seeded, "say this exactly once");
    expect(owner.allowed).toBe(true);
    if (!owner.allowed) return;
    const holder = holderOf(seeded);

    const first = core.outbox.claimForHolder(holder);
    expect(first.claimed.map((m) => m.messageId)).toEqual([owner.value.messageId]);
    expect(first.claimed[0]?.payload).toEqual({ text: "say this exactly once" });
    expect(first.unresolved).toEqual([]);
    // Moved before the payload came back, not after the caller did something with it.
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("SENT");

    // The crash: the holder was handed the message and never acknowledged it. A second claim —
    // the same holder reconnecting, or a successor — must not be handed it again.
    const second = core.outbox.claimForHolder(holder);
    expect(second.claimed).toEqual([]);
    expect(second.unresolved.map((m) => m.messageId)).toEqual([owner.value.messageId]);
    // The whole serialized report, so a payload smuggled into any field is caught rather than
    // only a payload on the field this row thought to name.
    expect(JSON.stringify(second.unresolved)).not.toContain("say this exactly once");
    expect(second.unresolved[0]).not.toHaveProperty("payload");
    expect(second.unresolved[0]?.payloadDigest).toBe(owner.value.payloadDigest);
  });

  /**
   * The binding is not the identity. A respawn keeps the session id and the generation while
   * becoming a different runtime, so a predicate that checked only the three columns already on
   * the outbox row would let the new runtime settle the old one's message.
   *
   * The last row here is the one the *replay* path gets wrong on its own. The claim, complete and
   * reject writes all assert a live holder — an `ACTIVE` assignment joined to a session that is
   * `READY` or `DRAINING`. The replay read-back is the only place that predicate was written out a
   * second time, and the second copy stopped at `assignments`; a `STOPPED` session keeps its
   * `ACTIVE` assignment row, so that copy answers "same holder" for a runtime that is gone and
   * hands it a settled-successfully verdict.
   */
  it("refuses a claim, a completion and a rejection from a mismatched incarnation", () => {
    const { core, seeded } = seededCore();
    const owner = enqueueOwnerMessage(core, seeded, "for this runtime only");
    expect(owner.allowed).toBe(true);
    if (!owner.allowed) return;
    const holder = holderOf(seeded);
    // Same role key, same generation, same session id — only the incarnation differs.
    const impostor: HolderIdentity = { ...holder, sessionIncarnation: "inc-2" };

    expect(core.outbox.claimForHolder(impostor).claimed).toEqual([]);
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("PENDING");

    const taken = core.outbox.claimForHolder(holder);
    expect(taken.claimed).toHaveLength(1);

    const stolen = core.outbox.completeForHolder(owner.value.messageId, impostor);
    expect(stolen.allowed).toBe(false);
    expect(stolen.reasonCode).toBe(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED);
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("SENT");

    const stolenReject = core.outbox.rejectForHolder(owner.value.messageId, impostor);
    expect(stolenReject.allowed).toBe(false);
    expect(stolenReject.reasonCode).toBe(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED);
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("SENT");

    // The real holder still can, and a retry of its own acknowledgement is idempotent rather than
    // an error: the answer can be lost on the way back, and retrying is the right behaviour.
    const done = core.outbox.completeForHolder(owner.value.messageId, holder);
    expect(done.allowed).toBe(true);
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("ACKED");
    const again = core.outbox.completeForHolder(owner.value.messageId, holder);
    expect(again.allowed).toBe(true);
    expect(again.reasonCode).toBe(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED);

    // ACKED is terminal in the other direction too — a rejection cannot rewrite it.
    const late = core.outbox.rejectForHolder(owner.value.messageId, holder);
    expect(late.allowed).toBe(false);
    expect(late.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("ACKED");

    // The holder does not change for this last row. The identical call that was just answered
    // `OUTBOX_DUPLICATE_SUPPRESSED` two assertions above is made again with the same tuple, and
    // the only thing different about the world is that its runtime is gone. That `again` above is
    // this row's positive control: the refusal below cannot be the tuple being wrong, because the
    // same tuple was accepted while the session was live.
    expect(
      core.sessions.transition(seeded.sessionId, SessionLifecycle.STOPPED, "restart").allowed,
    ).toBe(true);
    // And the assignment really is still ACTIVE, so what refuses below is the lifecycle join and
    // not the assignment having quietly disappeared underneath the predicate. Without this the row
    // would pass against an implementation that never looked at `sessions` at all.
    expect(
      core.db.get<{ status: string }>(
        `SELECT status FROM assignments
          WHERE role_key = ? AND binding_generation = ? AND session_id = ?
            AND session_incarnation = ?`,
        [
          holder.roleKey,
          holder.bindingGeneration,
          holder.targetSessionId,
          holder.sessionIncarnation,
        ],
      )?.status,
    ).toBe("ACTIVE");

    const afterStop = core.outbox.completeForHolder(owner.value.messageId, holder);
    expect(afterStop.allowed).toBe(false);
    expect(afterStop.reasonCode).toBe(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED);
    const rejectAfterStop = core.outbox.rejectForHolder(owner.value.messageId, holder);
    expect(rejectAfterStop.allowed).toBe(false);
    expect(rejectAfterStop.reasonCode).toBe(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED);
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("ACKED");
  });

  /**
   * Failover. A `PENDING` owner-message is rejected rather than rebound, and — the part no other
   * kind does — a `SENT` one is rejected too.
   *
   * `retargetOrReject` historically looked only at `PENDING`/`IN_FLIGHT`, because for an outward
   * delivery `SENT` means the transport succeeded and a later ACK is legitimate. For an
   * owner-message `SENT` means the previous holder was handed the payload and never came back, so
   * leaving it would strand it in a state nothing sweeps, and retargeting it would replay an
   * owner's words into a runtime they were never addressed to.
   */
  it("rejects both pending and already-handed-over owner-messages on failover, and retargets neither", () => {
    const { core, seeded } = seededCore();
    // Oldest first: a claim takes exactly one message and takes the oldest, so the one that is to
    // be handed over is enqueued first and the clock is advanced to make that order unambiguous.
    const handedOver = enqueueOwnerMessage(core, seeded, "taken and unacknowledged");
    core.clock.advance(1_000);
    const stillPending = enqueueOwnerMessage(core, seeded, "never taken");
    const dispatch = core.outbox.enqueue({
      idempotencyKey: `dispatch:${crypto.randomUUID()}`,
      roleKey: seeded.roleKey,
      bindingGeneration: seeded.generation,
      targetSessionId: seeded.sessionId,
      runId: seeded.runId,
      kind: MessageKind.RUN_DISPATCH,
      payload: { runId: seeded.runId },
    });
    expect(stillPending.allowed && handedOver.allowed && dispatch.allowed).toBe(true);
    if (!stillPending.allowed || !handedOver.allowed || !dispatch.allowed) return;

    const claimed = core.outbox.claimForHolder(holderOf(seeded));
    expect(claimed.claimed.map((m) => m.messageId)).toContain(handedOver.value.messageId);
    expect(core.outbox.get(handedOver.value.messageId)?.status).toBe("SENT");

    const successor = core.sessions.create({ provider: "claude", model: "successor-cto" });
    expect(
      core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "failover").allowed,
    ).toBe(true);

    const moved = core.outbox.retargetOrReject(
      seeded.roleKey,
      seeded.generation,
      seeded.generation + 1,
      successor.sessionId,
    );

    // The role-level dispatch moves; neither owner-message does.
    expect(moved.retargeted).toEqual([dispatch.value.messageId]);
    expect(moved.rejected).toContain(stillPending.value.messageId);
    expect(moved.rejected).toContain(handedOver.value.messageId);

    for (const id of [stillPending.value.messageId, handedOver.value.messageId]) {
      const row = core.outbox.get(id);
      expect(row?.status).toBe("REJECTED");
      // Never rebound: the successor must not be able to find them under its own generation.
      expect(row?.bindingGeneration).toBe(seeded.generation);
      expect(row?.targetSessionId).toBe(seeded.sessionId);
    }

    // And the successor is handed nothing — not the payload, and not a replay of the unresolved
    // row, because a rejected message is terminal.
    const successorClaim = core.outbox.claimForHolder({
      roleKey: seeded.roleKey,
      bindingGeneration: seeded.generation + 1,
      targetSessionId: successor.sessionId,
      sessionIncarnation: SEEDED_INCARNATION,
    });
    expect(successorClaim.claimed).toEqual([]);
    expect(successorClaim.unresolved).toEqual([]);
  });

  /**
   * An unknown outcome stops the queue; it is not reported *beside* a fresh payload.
   *
   * The second message is enqueued after the first hand-over, so exactly one row is claimable at
   * every call here and the batch size plays no part — the only question is whether an unsettled
   * predecessor stops the next payload moving. That isolation is the point: a row that asserted
   * only "the SENT one is not served twice" is green against an implementation that reports the
   * unresolved row *and* hands out the next payload in the same result, which is the state where
   * a successor is given a second message to lose exactly the way it lost the first.
   *
   * Blocking is asserted twice, because "the second call is empty" is also true of an
   * implementation that simply drained everything on the first call.
   */
  it("hands out no further payload while an earlier hand-over is unsettled", () => {
    const { core, seeded } = seededCore();
    const holder = holderOf(seeded);
    const first = enqueueOwnerMessage(core, seeded, "the first words");
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    const takeFirst = core.outbox.claimForHolder(holder);
    expect(takeFirst.claimed.map((m) => m.messageId)).toEqual([first.value.messageId]);

    // The holder was handed it and died before acknowledging. The owner speaks again meanwhile.
    core.clock.advance(1_000);
    const second = enqueueOwnerMessage(core, seeded, "the second words");
    expect(second.allowed).toBe(true);
    if (!second.allowed) return;

    const blocked = core.outbox.claimForHolder(holder);
    expect(blocked.claimed).toEqual([]);
    expect(blocked.unresolved.map((m) => m.messageId)).toEqual([first.value.messageId]);
    // Metadata only: neither payload may appear anywhere in what came back.
    expect(JSON.stringify(blocked)).not.toContain("the second words");
    expect(JSON.stringify(blocked)).not.toContain("the first words");
    // There *is* work queued, and the holder is told so without being handed it.
    expect(blocked.hasMore).toBe(true);
    expect(core.outbox.get(second.value.messageId)?.status).toBe("PENDING");

    // Still blocked on the next wake — the block is the unsettled row, not a spent batch.
    const stillBlocked = core.outbox.claimForHolder(holder);
    expect(stillBlocked.claimed).toEqual([]);
    expect(stillBlocked.unresolved.map((m) => m.messageId)).toEqual([first.value.messageId]);
    expect(core.outbox.get(second.value.messageId)?.status).toBe("PENDING");

    // Settling the unknown outcome is what releases it, and the payload then arrives exactly once.
    expect(core.outbox.completeForHolder(first.value.messageId, holder).allowed).toBe(true);
    const released = core.outbox.claimForHolder(holder);
    expect(released.claimed.map((m) => m.messageId)).toEqual([second.value.messageId]);
    expect(released.claimed[0]?.payload).toEqual({ text: "the second words" });
    expect(released.unresolved).toEqual([]);
  });

  /**
   * One message per call, oldest first — the batch size is not the caller's to choose.
   *
   * A caller-supplied `limit` is a caller-supplied blast radius: every row it names moves to
   * `SENT` before the caller has done anything with any of them, so a holder that asked for
   * twenty-five and then died lost twenty-five owner-messages to the unknown-outcome path
   * instead of one. `hasMore` plus another wake is how the rest is drained, and it is asserted
   * against the actual remaining count rather than as a constant `true`.
   */
  it("claims exactly the oldest one message per call and reports the rest through hasMore", () => {
    const { core, seeded } = seededCore();
    const holder = holderOf(seeded);
    const words = ["first", "second", "third"];
    const queued = words.map((text) => {
      const message = enqueueOwnerMessage(core, seeded, text);
      core.clock.advance(1_000);
      expect(message.allowed).toBe(true);
      return message;
    });
    if (!queued.every((m) => m.allowed)) return;
    const ids = queued.map((m) => (m.allowed ? m.value.messageId : ""));

    const taken: string[] = [];
    const more: boolean[] = [];
    for (let wake = 0; wake < words.length; wake += 1) {
      const claim = core.outbox.claimForHolder(holder);
      expect(claim.claimed).toHaveLength(1);
      // Nothing beyond the one claimed row was disturbed: the others are still queued.
      expect(JSON.stringify(claim)).not.toContain(words[wake + 1] ?? " ");
      taken.push(claim.claimed[0]?.messageId ?? "");
      more.push(claim.hasMore);
      expect(core.outbox.completeForHolder(taken[wake] ?? "", holder).allowed).toBe(true);
    }

    // Oldest first, one per wake, and `hasMore` false only on the wake that emptied the queue.
    expect(taken).toEqual(ids);
    expect(more).toEqual([true, true, false]);

    const drained = core.outbox.claimForHolder(holder);
    expect(drained.claimed).toEqual([]);
    expect(drained.unresolved).toEqual([]);
    expect(drained.hasMore).toBe(false);
  });

  /**
   * The compare-and-set must carry the identity it asserts, not stand next to a check of it.
   *
   * The candidate read and the write are two statements, and between them a row can stop being
   * this caller's. This row produces that interleaving at the database seam — the read returns a
   * row belonging to a *different* holder — and asserts the write refuses it.
   *
   * The substituted row is not exotic. `session_incarnation` is unique only within a session, so
   * two runtimes routinely carry the same incarnation string; a predicate correlated on the
   * *row's* own `role_key`/`target_session_id` therefore resolves the row's own assignment and
   * checks it against the *caller's* incarnation string, which matches. The caller is then handed
   * another holder's owner-message. Binding the write to the caller's tuple is what closes it.
   */
  it("refuses a candidate the compare-and-set cannot re-assert as the caller's own", () => {
    const { core, seeded } = seededCore();
    const holder = holderOf(seeded);

    // A second live holder in the same deployment, carrying the same incarnation string.
    const otherSession = core.sessions.create({
      provider: "claude",
      model: "another-runtime",
      incarnation: SEEDED_INCARNATION,
    });
    expect(
      core.sessions.transition(otherSession.sessionId, SessionLifecycle.READY, "seed").allowed,
    ).toBe(true);
    const otherRoleKey = `WORKER:${seeded.projectId}`;
    const otherActor = seedActor(core.db, "WORKER", otherSession.sessionId, SEEDED_INCARNATION);
    core.db.run(
      `INSERT INTO assignments (assignment_id, role_key, role, project_id, actor_id,
                                session_id, session_incarnation, binding_generation, mode, status,
                                created_at)
       VALUES (?, ?, 'WORKER', ?, ?, ?, ?, 1, 'PREFERRED', 'ACTIVE', ?)`,
      [
        "asg_other_holder",
        otherRoleKey,
        seeded.projectId,
        otherActor,
        otherSession.sessionId,
        SEEDED_INCARNATION,
        core.clock.nowIso(),
      ],
    );

    const theirs = core.outbox.enqueue({
      idempotencyKey: `owner:${crypto.randomUUID()}`,
      roleKey: otherRoleKey,
      bindingGeneration: 1,
      targetSessionId: otherSession.sessionId,
      runId: null,
      kind: MessageKind.OWNER_MESSAGE,
      payload: { text: "addressed to the other holder" },
    });
    const mine = enqueueOwnerMessage(core, seeded, "addressed to me");
    expect(theirs.allowed && mine.allowed).toBe(true);
    if (!theirs.allowed || !mine.allowed) return;

    const foreignRow = core.db.get<Record<string, unknown>>(
      `SELECT * FROM outbox WHERE message_id = ?`,
      [theirs.value.messageId],
    );
    expect(foreignRow).toBeDefined();

    // The seam: the candidate read hands back a row that is no longer the caller's, exactly as a
    // concurrent retarget between the two statements would. Only the candidate read is
    // substituted — the write, and every other statement, runs against the real database.
    let substitute = true;
    let substitutions = 0;
    const isCandidateRead = (sql: string): boolean =>
      sql.includes("'PENDING'") &&
      sql.includes(MessageKind.OWNER_MESSAGE) &&
      sql.includes("ORDER BY") &&
      !sql.includes("COUNT(");
    const racingDb = new Proxy(core.db, {
      get(target, prop): unknown {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (prop !== "all" && prop !== "get") return bound;
        return (sql: string, params?: unknown[]): unknown => {
          if (substitute && isCandidateRead(sql)) {
            substitutions += 1;
            return prop === "all" ? [foreignRow] : foreignRow;
          }
          return bound(sql, params);
        };
      },
    });
    const racing = new Outbox(racingDb, core.clock, core.audit);

    const raced = racing.claimForHolder(holder);
    // The seam actually fired. Without this the row would go quietly vacuous the moment the
    // candidate read changed shape, and assert nothing at all.
    expect(substitutions).toBeGreaterThan(0);
    expect(raced.claimed).toEqual([]);
    expect(JSON.stringify(raced)).not.toContain("addressed to the other holder");
    // The other holder's message was neither handed over nor moved.
    expect(core.outbox.get(theirs.value.messageId)?.status).toBe("PENDING");

    // Positive control: the same proxied outbox, reading truthfully, does claim the caller's own
    // message — so the refusal above is the identity binding and not a broken harness.
    substitute = false;
    const honest = racing.claimForHolder(holder);
    expect(honest.claimed.map((m) => m.messageId)).toEqual([mine.value.messageId]);
  });

  /**
   * A handed-over owner-message whose target is gone must be fenced, not stranded.
   *
   * `SessionRegistry` fences `PENDING`/`IN_FLIGHT` rows when a session stops, and `SENT` is
   * deliberately outside that sweep because for an outward delivery `SENT` means the transport
   * succeeded. For an owner-message it means the previous holder was handed the payload and never
   * came back — so after a restart the row is not claimable by the new holder (wrong incarnation),
   * not fenced by either sweep, and never settled. It sits in the queue forever.
   *
   * The already-`SENT` dispatch is the collateral control: the new clause must reach holder-claimed
   * kinds and nothing else, or it would fence deliveries that actually succeeded.
   */
  it("fences a handed-over owner-message whose target is gone, and leaves other kinds alone", () => {
    const { core, seeded } = seededCore();
    const owner = enqueueOwnerMessage(core, seeded, "handed over, never answered");
    const dispatch = core.outbox.enqueue({
      idempotencyKey: `dispatch:${crypto.randomUUID()}`,
      roleKey: seeded.roleKey,
      bindingGeneration: seeded.generation,
      targetSessionId: seeded.sessionId,
      runId: seeded.runId,
      kind: MessageKind.RUN_DISPATCH,
      payload: { runId: seeded.runId },
    });
    expect(owner.allowed && dispatch.allowed).toBe(true);
    if (!owner.allowed || !dispatch.allowed) return;

    expect(core.outbox.claimForHolder(holderOf(seeded)).claimed).toHaveLength(1);
    const swept = core.outbox.claimDeliverable(50);
    expect(swept.map((m) => m.messageId)).toEqual([dispatch.value.messageId]);
    expect(
      core.outbox.markSent(dispatch.value.messageId, swept[0]?.claimToken ?? "").allowed,
    ).toBe(true);
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("SENT");
    expect(core.outbox.get(dispatch.value.messageId)?.status).toBe("SENT");

    // The runtime is gone. The registry's own fence runs here and reaches neither row, which is
    // the stranding: after this the owner-message is SENT against a target that cannot answer.
    expect(
      core.sessions.transition(seeded.sessionId, SessionLifecycle.STOPPED, "restart").allowed,
    ).toBe(true);
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("SENT");

    const fenced = core.outbox.fenceUndeliverable();
    expect(fenced).toBe(1);
    const settled = core.outbox.get(owner.value.messageId);
    expect(settled?.status).toBe("REJECTED");
    // The successful outward delivery is untouched: its ACK may still legitimately arrive.
    expect(core.outbox.get(dispatch.value.messageId)?.status).toBe("SENT");
  });
});
