import { afterAll, describe, expect, it } from "vitest";

import { InMemoryBuzzTransport, BuzzAdapter } from "../../src/buzz/buzz-adapter.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
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

const enqueueDispatch = (
  core: ReturnType<typeof makeCore>,
  seeded: ReturnType<typeof seedRun>,
) =>
  core.outbox.enqueue({
    idempotencyKey: `dispatch:${crypto.randomUUID()}`,
    roleKey: seeded.roleKey,
    bindingGeneration: seeded.generation,
    targetSessionId: seeded.sessionId,
    runId: seeded.runId,
    kind: MessageKind.RUN_DISPATCH,
    payload: { runId: seeded.runId },
  });

/**
 * The admitted ingress row an owner-message row is holding open, exactly as `admitBuzzMessage`
 * writes it: one durable copy of the envelope, and a turn claim whose `turnRequestId` **is** the
 * outbox message id.
 *
 * That identity is the whole reason the settlement can be found from the outbox side without
 * trusting the row's own payload — which matters because one of the transitions that must settle
 * is the refusal of a row whose pointer no longer resolves.
 */
const seedIngressClaim = (
  core: ReturnType<typeof makeCore>,
  messageId: string,
  nonce: string,
): void => {
  core.db.run(
    `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json, turn_claim_json)
     VALUES ('buzz', ?, 'npub-owner', ?, ?, ?)`,
    [
      nonce,
      core.clock.nowIso(),
      JSON.stringify({ text: "the owner's words" }),
      JSON.stringify({
        turnRequestId: messageId,
        sessionDigest: "session-digest",
        promptDigest: "prompt-digest",
        bindingDigest: "binding-digest",
      }),
    ],
  );
};

const turnClaim = (
  core: ReturnType<typeof makeCore>,
  nonce: string,
): { repliedAt?: unknown; noReplyAt?: unknown; settledAt?: unknown } =>
  JSON.parse(
    core.db.get<{ turn_claim_json: string }>(
      `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
      [nonce],
    )!.turn_claim_json,
  ) as { repliedAt?: unknown; noReplyAt?: unknown; settledAt?: unknown };

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
   * Failover splits the two states, and the split is the whole rule.
   *
   * A `PENDING` owner-message was never handed to anybody, so nothing observable has happened to
   * it and the successor may safely have it — the owner addressed a *role*, and the role still
   * exists. A `SENT` one was handed over and never acknowledged: its outcome is unknown, so
   * retargeting it would replay an owner's words into a runtime they were never addressed to.
   * That one is rejected, and — because rejecting it is a terminal transition out of `SENT` — its
   * source ingress claim is settled in the same transaction.
   *
   * `retargetOrReject` historically looked only at `PENDING`/`IN_FLIGHT`, because for an outward
   * delivery `SENT` means the transport succeeded and a later ACK is legitimate; the `SENT` arm
   * here is the asymmetry only holder-claimed kinds get.
   */
  it("retargets a pending owner-message on failover and rejects the already-handed-over one", () => {
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

    // The role-level dispatch moves, and so does the untouched owner-message. The handed-over one
    // does not, and is the only one of the three that ends terminal.
    expect(moved.retargeted).toContain(dispatch.value.messageId);
    expect(moved.retargeted).toContain(stillPending.value.messageId);
    expect(moved.rejected).toEqual([handedOver.value.messageId]);

    const movedOnward = core.outbox.get(stillPending.value.messageId);
    expect(movedOnward?.status).toBe("PENDING");
    expect(movedOnward?.bindingGeneration).toBe(seeded.generation + 1);
    expect(movedOnward?.targetSessionId).toBe(successor.sessionId);

    const burned = core.outbox.get(handedOver.value.messageId);
    expect(burned?.status).toBe("REJECTED");
    // Never rebound: the successor must not be able to find the handed-over one at all.
    expect(burned?.bindingGeneration).toBe(seeded.generation);
    expect(burned?.targetSessionId).toBe(seeded.sessionId);

    // The runtime it was addressed to before the switch keeps nothing: not the retargeted row,
    // which is somebody else's now, and not the burned one, which is terminal.
    const previousHolder = core.outbox.claimForHolder(holderOf(seeded));
    expect(previousHolder.claimed).toEqual([]);
    expect(previousHolder.unresolved).toEqual([]);
    expect(JSON.stringify(previousHolder)).not.toContain("taken and unacknowledged");
    expect(JSON.stringify(previousHolder)).not.toContain("never taken");

    // That the *successor* can then claim the retargeted row is measured through
    // `BindingRegistry.switchTo` below, not here: `retargetOrReject` moves the outbox columns and
    // the successor's `ACTIVE` assignment — the row `exactHolderTarget` joins against — is created
    // by the binding switch. Asserting a claim here would only measure the absence of that
    // assignment.
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

  /**
   * A queued owner-message has no expiry, and "no expiry" has to hold at every query that reads
   * `expires_at` — not only at the sweep.
   *
   * Excluding the kind from `expireOverdue` alone produces a *subtler* strand than the one it
   * removes: the row keeps `status = 'PENDING'`, so nothing sweeps it and nothing reports it, while
   * the two `expires_at > ?` conditions inside `claimForHolder` mean no holder can ever be handed
   * it. A state that looks healthy and delivers nothing is worse than one that is visibly expired,
   * so the claim is exercised here rather than only the status.
   *
   * The `RUN_DISPATCH` is the positive control: the sweep really did run on this call, so the
   * owner-message surviving it is the exclusion working and not an expiry that never fired.
   */
  it("never expires a queued owner-message, and still hands it over after its nominal TTL", () => {
    const { core, seeded } = seededCore();
    const owner = enqueueOwnerMessage(core, seeded, "still queued an hour later");
    const dispatch = enqueueDispatch(core, seeded);
    expect(owner.allowed && dispatch.allowed).toBe(true);
    if (!owner.allowed || !dispatch.allowed) return;

    // Well past the 30-minute default TTL both rows were stamped with at enqueue.
    core.clock.advance(31 * 60 * 1000);
    expect(core.outbox.expireOverdue()).toBe(1);
    expect(core.outbox.get(dispatch.value.messageId)?.status).toBe("EXPIRED");
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("PENDING");

    // And the claim path agrees with the sweep. Both of its `expires_at` conditions are exercised:
    // the candidate select by the hand-over, and the queued count by `hasMore`.
    const taken = core.outbox.claimForHolder(holderOf(seeded));
    expect(taken.claimed.map((m) => m.messageId)).toEqual([owner.value.messageId]);
    expect(taken.claimed[0]?.payload).toEqual({ text: "still queued an hour later" });
    expect(taken.hasMore).toBe(false);
  });

  /**
   * The queued count is the other expiry-gated read, and `hasMore` is the only thing that reports
   * it. A row that only claimed one message would leave that query untested.
   */
  it("reports a long-queued owner-message through hasMore while another is unsettled", () => {
    const { core, seeded } = seededCore();
    const first = enqueueOwnerMessage(core, seeded, "the first words");
    core.clock.advance(1_000);
    const second = enqueueOwnerMessage(core, seeded, "the second words");
    expect(first.allowed && second.allowed).toBe(true);
    if (!first.allowed || !second.allowed) return;

    expect(core.outbox.claimForHolder(holderOf(seeded)).claimed).toHaveLength(1);
    core.clock.advance(31 * 60 * 1000);
    const blocked = core.outbox.claimForHolder(holderOf(seeded));
    expect(blocked.unresolved.map((m) => m.messageId)).toEqual([first.value.messageId]);
    // The second is still queued and still counted, an hour after it was enqueued.
    expect(blocked.hasMore).toBe(true);
    expect(core.outbox.get(second.value.messageId)?.status).toBe("PENDING");
  });

  /**
   * A takeover moves a queued owner-message to the successor through the production path, and the
   * successor is handed it exactly once.
   *
   * Entered at `BindingRegistry.switchTo` rather than at `retargetOrReject`, because the successor's
   * `ACTIVE` assignment — the thing `exactHolderTarget` joins against — is created by the switch and
   * not by the outbox. A row that called `retargetOrReject` directly would move the columns and
   * never establish that anybody can claim the result.
   */
  it("hands a queued owner-message to the successor exactly once after a takeover", () => {
    const { core, seeded } = seededCore();
    const owner = enqueueOwnerMessage(core, seeded, "for whoever holds the role");
    expect(owner.allowed).toBe(true);
    if (!owner.allowed) return;

    const successor = core.sessions.create({ provider: "claude", model: "successor-cto" });
    expect(
      core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "failover").allowed,
    ).toBe(true);
    const switched = core.bindings.switchTo({
      role: Role.PRIMARY_CTO,
      projectId: seeded.projectId,
      sessionId: successor.sessionId,
      reason: "the previous holder was replaced",
      conversation: "REPLACED",
      takeover: true,
    });
    expect(switched.allowed).toBe(true);
    if (!switched.allowed) return;

    const row = core.outbox.get(owner.value.messageId);
    expect(row?.status).toBe("PENDING");
    expect(row?.bindingGeneration).toBe(switched.value.bindingGeneration);
    expect(row?.targetSessionId).toBe(successor.sessionId);

    // Retargeted is not the same as exposed: the generic transport must still never see it.
    expect(
      core.outbox.claimDeliverable(50).some((m) => m.kind === MessageKind.OWNER_MESSAGE),
    ).toBe(false);

    const successorHolder: HolderIdentity = {
      roleKey: seeded.roleKey,
      bindingGeneration: switched.value.bindingGeneration,
      targetSessionId: successor.sessionId,
      sessionIncarnation: core.sessions.require(successor.sessionId).incarnation,
    };
    const first = core.outbox.claimForHolder(successorHolder);
    expect(first.claimed.map((m) => m.messageId)).toEqual([owner.value.messageId]);
    expect(first.claimed[0]?.payload).toEqual({ text: "for whoever holds the role" });

    // Exactly once: the second wake reports it unsettled rather than handing the words again.
    const second = core.outbox.claimForHolder(successorHolder);
    expect(second.claimed).toEqual([]);
    expect(second.unresolved.map((m) => m.messageId)).toEqual([owner.value.messageId]);
    expect(JSON.stringify(second)).not.toContain("for whoever holds the role");

    // And the runtime it was addressed to before the switch is handed nothing.
    expect(core.outbox.claimForHolder(holderOf(seeded)).claimed).toEqual([]);
  });

  /**
   * A session stopping must not terminally reject a *queued* owner-message.
   *
   * `SessionRegistry.fenceUndeliveredMessages` rejects every `PENDING`/`IN_FLIGHT` row addressed to
   * the stopping session, by direct SQL and kind-agnostically. For an outward delivery that is
   * right — the recipient is gone and the message was addressed to it. An owner-message is
   * addressed to a *role*, so the queued one is still safely movable and belongs to whoever takes
   * the role next; rejecting it there is a terminal transition with no settlement, and the ingress
   * claim it was holding open is stranded.
   *
   * The `RUN_DISPATCH` is the control: the fence still runs and still reaches everything else.
   */
  it("leaves a queued owner-message alone when its session stops, and still retargets it", () => {
    const { core, seeded } = seededCore();
    const owner = enqueueOwnerMessage(core, seeded, "queued when the runtime died");
    const dispatch = enqueueDispatch(core, seeded);
    expect(owner.allowed && dispatch.allowed).toBe(true);
    if (!owner.allowed || !dispatch.allowed) return;

    expect(
      core.sessions.transition(seeded.sessionId, SessionLifecycle.STOPPED, "restart").allowed,
    ).toBe(true);
    expect(core.outbox.get(dispatch.value.messageId)?.status).toBe("REJECTED");
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("PENDING");

    // The generic fence agrees: a queued holder-claimed row is not its business either.
    core.outbox.fenceUndeliverable();
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("PENDING");

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
    expect(moved.retargeted).toContain(owner.value.messageId);
    expect(core.outbox.get(owner.value.messageId)?.targetSessionId).toBe(successor.sessionId);
  });

  /**
   * Fencing a handed-over owner-message settles the ingress claim it was holding open, in the same
   * transaction as the outbox transition.
   *
   * Without it the claim carries no `repliedAt`, no `noReplyAt` and no `settledAt`, which makes the
   * row permanently exempt from `IngressGuard.prune` — the `(buzz, nonce)` slot is never freed and
   * `doctor` reports the turn outstanding forever, while the outbox row that was holding it open is
   * terminal and gone.
   */
  it("settles the ingress claim in the same transaction as it fences a handed-over owner-message", () => {
    const { core, seeded } = seededCore();
    const owner = enqueueOwnerMessage(core, seeded, "handed over, never answered");
    expect(owner.allowed).toBe(true);
    if (!owner.allowed) return;
    const nonce = "buzz-message:evt-fenced";
    seedIngressClaim(core, owner.value.messageId, nonce);

    expect(core.outbox.claimForHolder(holderOf(seeded)).claimed).toHaveLength(1);
    // The claim is outstanding while the row is unresolved: that is what holds `prune` off it.
    expect(turnClaim(core, nonce).noReplyAt).toBeUndefined();

    expect(
      core.sessions.transition(seeded.sessionId, SessionLifecycle.STOPPED, "restart").allowed,
    ).toBe(true);
    expect(core.outbox.fenceUndeliverable()).toBe(1);
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("REJECTED");

    const claim = turnClaim(core, nonce);
    expect(claim.noReplyAt).toEqual(expect.any(String));
    // Never `repliedAt`: nothing handed a reply to any transport.
    expect(claim.repliedAt).toBeUndefined();
  });

  /**
   * The revoke shape of `retargetOrReject` — `fromGeneration === toGeneration`, which is what
   * `BindingRegistry.revoke` passes — must terminally reject and settle here, and must not report
   * the row as retargeted.
   *
   * `revoke` runs its own direct `UPDATE outbox SET status = 'REJECTED'` over every id this
   * returns as `retargeted`, because for a revoked role there is nothing to retarget onto. That
   * write knows nothing about ingress claims, so an owner-message reaching it would be settled
   * behind this method's back. The id not being in `retargeted` is what makes the bypass
   * unreachable rather than merely unused.
   */
  it("rejects and settles a queued owner-message on a revoke, and never reports it retargeted", () => {
    const { core, seeded } = seededCore();
    const owner = enqueueOwnerMessage(core, seeded, "the role is going away");
    expect(owner.allowed).toBe(true);
    if (!owner.allowed) return;
    const nonce = "buzz-message:evt-revoked";
    seedIngressClaim(core, owner.value.messageId, nonce);

    const revoked = core.outbox.retargetOrReject(
      seeded.roleKey,
      seeded.generation,
      seeded.generation,
      seeded.sessionId,
    );
    expect(revoked.retargeted).not.toContain(owner.value.messageId);
    expect(revoked.rejected).toContain(owner.value.messageId);
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("REJECTED");
    expect(turnClaim(core, nonce).noReplyAt).toEqual(expect.any(String));
  });

  /**
   * The coupling is all-or-nothing in both directions: a settlement the ingress side refuses rolls
   * the outbox transition back rather than committing half of it.
   *
   * A claim already carrying `settledAt` is the one state `completeNoReplyAndResolveTurn` refuses —
   * it must never write a no-reply over a terminal fact something else recorded. The row asserts
   * the outbox row is still exactly where it was, which is the difference between "refused" and
   * "committed the half that succeeded".
   */
  it("rolls the outbox transition back when the ingress settlement refuses", () => {
    const { core, seeded } = seededCore();
    const holder = holderOf(seeded);
    const spoiled = enqueueOwnerMessage(core, seeded, "its claim is already terminal");
    expect(spoiled.allowed).toBe(true);
    if (!spoiled.allowed) return;
    const spoiledNonce = "buzz-message:evt-spoiled";
    seedIngressClaim(core, spoiled.value.messageId, spoiledNonce);
    expect(core.outbox.claimForHolder(holder).claimed).toHaveLength(1);

    core.db.run(
      `UPDATE inbound_messages SET turn_claim_json = json_set(turn_claim_json, '$.settledAt', ?)
        WHERE channel = 'buzz' AND nonce = ?`,
      [core.clock.nowIso(), spoiledNonce],
    );

    const completed = core.outbox.completeForHolder(spoiled.value.messageId, holder);
    expect(completed.allowed).toBe(false);
    expect(completed.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
    expect(core.outbox.get(spoiled.value.messageId)?.status).toBe("SENT");

    const rejected = core.outbox.rejectForHolder(spoiled.value.messageId, holder);
    expect(rejected.allowed).toBe(false);
    expect(rejected.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
    expect(core.outbox.get(spoiled.value.messageId)?.status).toBe("SENT");

    // The positive control, and what makes the two refusals above mean "the settlement refused"
    // rather than "this holder cannot settle anything": the identical calls on a message whose
    // claim is in its ordinary state move both ledgers together.
    core.clock.advance(1_000);
    const healthy = enqueueOwnerMessage(core, seeded, "its claim is ordinary");
    expect(healthy.allowed).toBe(true);
    if (!healthy.allowed) return;
    const healthyNonce = "buzz-message:evt-healthy";
    seedIngressClaim(core, healthy.value.messageId, healthyNonce);
    // The spoiled row is still SENT and still blocks the queue, so it is settled out of the way
    // through the path that does not touch its claim.
    core.db.run(`UPDATE outbox SET status = 'EXPIRED' WHERE message_id = ?`, [
      spoiled.value.messageId,
    ]);
    expect(core.outbox.claimForHolder(holder).claimed.map((m) => m.messageId)).toEqual([
      healthy.value.messageId,
    ]);
    expect(core.outbox.completeForHolder(healthy.value.messageId, holder).allowed).toBe(true);
    expect(core.outbox.get(healthy.value.messageId)?.status).toBe("ACKED");
    expect(turnClaim(core, healthyNonce).noReplyAt).toEqual(expect.any(String));
  });

  /**
   * A connection-bound settle names a `messageId` and nothing else, so the write has to re-assert
   * *whose* message that id is — and it must do so from the caller's own tuple, not from the row's.
   *
   * The two holders here share an incarnation string, which is ordinary: `session_incarnation` is
   * unique only within a session. With the caller tuple absent from the `WHERE` clause the
   * `EXISTS` correlates on the row's own `role_key`/`binding_generation`/`target_session_id`,
   * resolves *the row's* assignment, and checks it against the caller's incarnation — which
   * matches. A live `PRIMARY_CTO` holder then ACKs a `WORKER`'s owner-message on a different
   * session, and nothing about the call looked wrong.
   *
   * Unlike the racing-candidate row above, nothing is substituted here: the id is simply supplied
   * by the caller, which is exactly what the connection-bound tools accept.
   */
  it("refuses a complete or reject naming another holder's message, and changes no terminal state", () => {
    const { core, seeded } = seededCore();
    const mine = holderOf(seeded);

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
    const theirs: HolderIdentity = {
      roleKey: otherRoleKey,
      bindingGeneration: 1,
      targetSessionId: otherSession.sessionId,
      sessionIncarnation: SEEDED_INCARNATION,
    };

    const message = core.outbox.enqueue({
      idempotencyKey: `owner:${crypto.randomUUID()}`,
      roleKey: otherRoleKey,
      bindingGeneration: 1,
      targetSessionId: otherSession.sessionId,
      runId: null,
      kind: MessageKind.OWNER_MESSAGE,
      payload: { text: "addressed to the other holder" },
    });
    expect(message.allowed).toBe(true);
    if (!message.allowed) return;
    expect(core.outbox.claimForHolder(theirs).claimed).toHaveLength(1);
    expect(core.outbox.get(message.value.messageId)?.status).toBe("SENT");

    // The whole of the attack: a live holder of a different role, on a different session, naming
    // an id it was never given. Both tuples are real and both runtimes are live.
    const stolenAck = core.outbox.completeForHolder(message.value.messageId, mine);
    expect(stolenAck.allowed).toBe(false);
    expect(stolenAck.reasonCode).toBe(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED);
    expect(core.outbox.get(message.value.messageId)?.status).toBe("SENT");

    const stolenReject = core.outbox.rejectForHolder(message.value.messageId, mine);
    expect(stolenReject.allowed).toBe(false);
    expect(stolenReject.reasonCode).toBe(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED);
    expect(core.outbox.get(message.value.messageId)?.status).toBe("SENT");

    // The positive control: the holder it *is* addressed to settles the same id, so the refusals
    // above are the caller tuple and not a row that nothing could have moved.
    expect(core.outbox.completeForHolder(message.value.messageId, theirs).allowed).toBe(true);
    expect(core.outbox.get(message.value.messageId)?.status).toBe("ACKED");
  });

  /**
   * The generic ACK route takes a caller-supplied `messageId` and scopes it by no kind at all, so a
   * caller presenting its own perfectly valid role/session/generation tuple could drive an
   * owner-message straight to `ACKED` — terminal, and past the only place the ingress settlement
   * happens.
   *
   * Fail closed: holder-claimed kinds are settled over their holder's own connection or not at all.
   * The `RUN_DISPATCH` is the control — the route still works for everything it is for.
   */
  it("refuses to acknowledge a holder-claimed message through the generic ack route", () => {
    const { core, seeded } = seededCore();
    const owner = enqueueOwnerMessage(core, seeded, "not yours to acknowledge");
    const dispatch = enqueueDispatch(core, seeded);
    expect(owner.allowed && dispatch.allowed).toBe(true);
    if (!owner.allowed || !dispatch.allowed) return;

    expect(core.outbox.claimForHolder(holderOf(seeded)).claimed).toHaveLength(1);
    const swept = core.outbox.claimDeliverable(50);
    expect(
      core.outbox.markSent(dispatch.value.messageId, swept[0]?.claimToken ?? "").allowed,
    ).toBe(true);

    const stolen = core.outbox.acknowledge(
      owner.value.messageId,
      seeded.sessionId,
      seeded.generation,
    );
    expect(stolen.allowed).toBe(false);
    expect(core.outbox.get(owner.value.messageId)?.status).toBe("SENT");

    // The control: the same caller, the same tuple, an outward delivery — accepted.
    expect(
      core.outbox.acknowledge(dispatch.value.messageId, seeded.sessionId, seeded.generation)
        .allowed,
    ).toBe(true);
    expect(core.outbox.get(dispatch.value.messageId)?.status).toBe("ACKED");
  });
});
