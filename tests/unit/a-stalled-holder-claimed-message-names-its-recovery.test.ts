import { afterAll, describe, expect, it } from "vitest";

import { AgentOwnedWaits } from "../../src/ceo/agent-owned-waits.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { type Harness, bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * A PEER_MESSAGE is holder-claimed: the receiving CTO takes it with role_owner_message_claim, and the
 * delivery pass never pushes it. So a stalled one is recovered by that claim (after a reconnect, if the
 * relay is gone), never by retry_outbox; and retry_outbox, given a target, resets only that target's rows
 * and refuses, with the reason, a target a retry cannot deliver.
 */

const PUSHED_RECOVERY = "retry the delivery (repair_execute retry_outbox, HERMES authority); a delivery timeout does not fail the run";

const waitsOf = (harness: Harness): AgentOwnedWaits =>
  new AgentOwnedWaits({
    db: harness.cp.db,
    clock: harness.cp.clock,
    audit: harness.cp.audit,
    runs: harness.cp.runs,
    bindings: harness.cp.bindings,
    outbox: harness.cp.outbox,
    artifacts: harness.cp.artifacts,
    gate: harness.cp.ceo,
  });

/**
 * A CEO, and a READY PRIMARY_CTO for the fixture project with one PEER_MESSAGE queued to it; with
 * `olderPushed`, a pushed ESCALATION_REPLY queued to the same CTO a minute before it.
 */
const ctoWithPeerMessage = async (options: { olderPushed?: boolean } = {}) => {
  const harness = makeHarness();
  const { projectId } = await registerFixtureProject(harness);
  const ceoSessionId = bindCeo(harness);
  const ctoRoleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const cto = harness.cp.sessions.create({ provider: "scripted", model: "cto" });
  expect(harness.cp.sessions.transition(cto.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  const bound = harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: cto.sessionId, projectId });
  if (!bound.allowed) throw new Error(`CTO binding failed: ${bound.message}`);
  let olderPushedId: string | null = null;
  if (options.olderPushed === true) {
    const older = harness.cp.outbox.enqueue({
      idempotencyKey: "older-pushed", roleKey: ctoRoleKey, bindingGeneration: bound.value.bindingGeneration,
      targetSessionId: cto.sessionId, runId: null, kind: MessageKind.ESCALATION_REPLY, payload: { note: "pushed" },
    });
    if (!older.allowed) throw new Error(`enqueue failed: ${older.message}`);
    olderPushedId = older.value.messageId;
    harness.clock.advance(60 * 1000);
  }
  const nonce = "buzz-message:event-stalled";
  const admitted = { text: "please look at the queue", mention: "npub-cto" };
  harness.cp.db.run(
    `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES ('buzz', ?, 'npub-ceo', ?, ?)`,
    [nonce, harness.clock.nowIso(), JSON.stringify(admitted)],
  );
  const queued = harness.cp.outbox.enqueue({
    idempotencyKey: `peer-message:${nonce}`,
    roleKey: ctoRoleKey,
    bindingGeneration: bound.value.bindingGeneration,
    targetSessionId: cto.sessionId,
    runId: null,
    kind: MessageKind.PEER_MESSAGE,
    payload: { sourceChannel: "buzz", sourceNonce: nonce, sourcePayloadDigest: digestOf(admitted) },
  });
  if (!queued.allowed) throw new Error(`enqueue failed: ${queued.message}`);
  return {
    harness, ceoSessionId, ctoRoleKey, cto, generation: bound.value.bindingGeneration, peerMessageId: queued.value.messageId, olderPushedId,
  };
};

const criticalFor = (harness: Harness, resource: string): Record<string, unknown> | undefined =>
  harness.cp.db.all<{ payload_json: string }>(
    `SELECT payload_json FROM outbox WHERE kind = 'CEO_NOTIFICATION'
       AND json_extract(payload_json, '$.notification') = 'CRITICAL_SYSTEM_FAILURE'
       AND json_extract(payload_json, '$.resource') = ?`,
    [resource],
  ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)[0];

describe("a stalled holder-claimed message names its real recovery", () => {
  it("a stalled PEER_MESSAGE tells the CEO the receiving session must claim it, or reconnect, naming that session; not retry_outbox", async () => {
    const { harness, ctoRoleKey, cto, generation, peerMessageId } = await ctoWithPeerMessage();
    harness.clock.advance(11 * 60 * 1000);
    const tick = await harness.cp.watchdog.tick();
    expect(tick.stalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "outbox", id: peerMessageId, messageKind: MessageKind.PEER_MESSAGE }),
    ]));
    waitsOf(harness).routeWatchdogStalls(tick.stalls);

    const notice = criticalFor(harness, peerMessageId);
    expect(notice).toMatchObject({
      stall: "outbox", owner: { role: ctoRoleKey, sessionId: cto.sessionId, generation },
      deliveryTimeout: true, productFailure: false,
    });
    const recovery = String(notice!["recoveryAction"]);
    expect(recovery).toContain("role_owner_message_claim");
    expect(recovery).toContain("reconnects");
    expect(recovery).toContain(`session ${cto.sessionId} at binding generation ${generation} of ${ctoRoleKey}`);
    expect(recovery).toContain("which is live (READY, the role's current binding)");
    expect(recovery).not.toContain("retry_outbox");
    // A role whose stalled messages are all holder-claimed keeps exactly this text.
    expect(recovery).toBe(
      "the receiving session claims it (role_owner_message_claim); if its relay or attachment is gone, it reconnects " +
      "and then claims it. A PEER_MESSAGE is delivered only by its holder's claim, never by the delivery pass, so a " +
      "delivery retry cannot deliver it; a delivery timeout does not fail the run. It is addressed to session " +
      `${cto.sessionId} at binding generation ${generation} of ${ctoRoleKey}, which is live (READY, the role's current binding)`,
    );
  });

  it("one role's mixed stall names, in its one notice, the retry for the pushed message and the claim for the holder-claimed one", async () => {
    const { harness, ctoRoleKey, cto, generation, peerMessageId, olderPushedId } = await ctoWithPeerMessage({ olderPushed: true });
    harness.clock.advance(11 * 60 * 1000);
    waitsOf(harness).routeWatchdogStalls((await harness.cp.watchdog.tick()).stalls);

    const notices = harness.cp.db.all<{ payload_json: string }>(
      `SELECT payload_json FROM outbox WHERE kind = 'CEO_NOTIFICATION'
         AND json_extract(payload_json, '$.notification') = 'CRITICAL_SYSTEM_FAILURE'
         AND json_extract(payload_json, '$.stall') = 'outbox' AND json_extract(payload_json, '$.owner.role') = ?`,
      [ctoRoleKey],
    ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      resource: olderPushedId, owner: { role: ctoRoleKey, sessionId: cto.sessionId, generation },
      blocker: expect.stringContaining(`2 messages PENDING past the delivery deadline to ${ctoRoleKey}`),
    });
    const recovery = String(notices[0]!["recoveryAction"]);
    expect(recovery).toContain(`pushed messages 1 (${olderPushedId}): ${PUSHED_RECOVERY}`);
    expect(recovery).toContain(`Holder-claimed messages 1 (${peerMessageId}): the receiving session claims it (role_owner_message_claim)`);
    expect(recovery).toContain(`session ${cto.sessionId} at binding generation ${generation} of ${ctoRoleKey}`);
  });

  it("names a receiving session that is no longer live as not live", async () => {
    const { harness, cto, peerMessageId } = await ctoWithPeerMessage();
    harness.cp.db.run(`UPDATE sessions SET lifecycle = 'STOPPED' WHERE session_id = ?`, [cto.sessionId]);
    harness.clock.advance(11 * 60 * 1000);
    waitsOf(harness).routeWatchdogStalls((await harness.cp.watchdog.tick()).stalls);

    const recovery = String(criticalFor(harness, peerMessageId)?.["recoveryAction"]);
    expect(recovery).toContain(`session ${cto.sessionId}`);
    expect(recovery).toContain("which is not live (session STOPPED");
    expect(recovery).not.toContain("retry_outbox");
  });

  it("a pushed kind's stall keeps its retry_outbox recovery, unchanged", async () => {
    const { harness, ceoSessionId } = await ctoWithPeerMessage();
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const dispatch = harness.cp.outbox.enqueue({
      idempotencyKey: "pushed-kind", roleKey: ceo.roleKey, bindingGeneration: ceo.bindingGeneration,
      targetSessionId: ceoSessionId, runId: null, kind: MessageKind.ESCALATION_REPLY, payload: { note: "pushed" },
    });
    if (!dispatch.allowed) throw new Error(`enqueue failed: ${dispatch.message}`);
    harness.clock.advance(11 * 60 * 1000);
    waitsOf(harness).routeWatchdogStalls((await harness.cp.watchdog.tick()).stalls);

    expect(criticalFor(harness, dispatch.value.messageId)).toMatchObject({
      stall: "outbox", owner: { role: ceo.roleKey, sessionId: null, generation: null }, recoveryAction: PUSHED_RECOVERY,
    });
  });
});

describe("retry_outbox resets only its target's rows", () => {
  /** The peer message, plus pushed rows a failed delivery left with attempts: one per role, and one about to expire. */
  const withFailedRows = async () => {
    const fixture = await ctoWithPeerMessage();
    const { harness, ctoRoleKey, cto, generation } = fixture;
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const pushed = (key: string, to: { roleKey: string; generation: number; sessionId: string }, ttlMs?: number): string => {
      const queued = harness.cp.outbox.enqueue({
        idempotencyKey: key, roleKey: to.roleKey, bindingGeneration: to.generation, targetSessionId: to.sessionId,
        runId: null, kind: MessageKind.ESCALATION_REPLY, payload: { key }, ...(ttlMs !== undefined ? { ttlMs } : {}),
      });
      if (!queued.allowed) throw new Error(`enqueue failed: ${queued.message}`);
      harness.cp.db.run(`UPDATE outbox SET attempts = 2, last_error = 'transport down' WHERE message_id = ?`, [queued.value.messageId]);
      return queued.value.messageId;
    };
    const ceoTarget = { roleKey: ceo.roleKey, generation: ceo.bindingGeneration, sessionId: ceo.sessionId };
    const ctoTarget = { roleKey: ctoRoleKey, generation, sessionId: cto.sessionId };
    const ceoRow = pushed("to-ceo", ceoTarget);
    const ctoRow = pushed("to-cto", ctoTarget);
    const expiring = pushed("to-ceo-expiring", ceoTarget, 60_000);
    harness.clock.advance(2 * 60 * 1000);
    return { ...fixture, ceoRow, ctoRow, expiring };
  };
  const attemptsOf = (harness: Harness, messageId: string): number =>
    harness.cp.db.get<{ attempts: number }>(`SELECT attempts FROM outbox WHERE message_id = ?`, [messageId])!.attempts;
  const retry = (harness: Harness, parameters: Record<string, string>, dryRun: boolean) =>
    harness.cp.repair.execute({ operationId: "retry_outbox", parameters, authorizedBy: "HERMES", dryRun });
  const targetEvidence = (decision: { evidence?: unknown }) =>
    (decision.evidence as { preconditions: Array<{ evidence: { rows: Array<Record<string, unknown>> } }> }).preconditions[0]!.evidence;

  it("a messageId resets that row only; another role's PENDING row is untouched, and the dry run lists only the target", async () => {
    const { harness, ceoRow, ctoRow } = await withFailedRows();
    const dry = await retry(harness, { messageId: ctoRow }, true);
    expect(dry.allowed).toBe(true);
    if (!dry.allowed) return;
    expect(dry.value.changes).toBe(1);
    const recorded = harness.cp.audit.byKind("REPAIR_DRY_RUN").at(-1)!.evidence["target"] as { rows: Array<{ messageId: string }> };
    expect(recorded.rows.map((message) => message.messageId)).toEqual([ctoRow]);

    const done = await retry(harness, { messageId: ctoRow }, false);
    expect(done.allowed && done.value.changes).toBe(1);
    expect(attemptsOf(harness, ctoRow)).toBe(0);
    expect(attemptsOf(harness, ceoRow)).toBe(2);
  });

  it("a roleKey resets that role's retryable rows only, and lists its holder-claimed row as refused", async () => {
    const { harness, ctoRoleKey, ceoRow, ctoRow, peerMessageId } = await withFailedRows();
    const done = await retry(harness, { roleKey: ctoRoleKey }, false);
    expect(done.allowed && done.value.changes).toBe(1);
    const recorded = harness.cp.audit.byKind("REPAIR_EXECUTED").at(-1)!.evidence["target"] as { rows: Array<Record<string, unknown>> };
    expect(recorded.rows.map((message) => [message["messageId"], message["refusal"] ?? null]).sort()).toEqual(
      [[ctoRow, null], [peerMessageId, "HOLDER_CLAIMED"]].sort(),
    );
    expect(attemptsOf(harness, ctoRow)).toBe(0);
    expect(attemptsOf(harness, ceoRow)).toBe(2);
  });

  it("a targeted holder-claimed message is refused: its holder's claim delivers it, and a retry cannot", async () => {
    const { harness, peerMessageId, ctoRow } = await withFailedRows();
    const refused = await retry(harness, { messageId: peerMessageId }, false);
    expect(refused.reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
    expect(targetEvidence(refused).rows).toEqual([expect.objectContaining({
      messageId: peerMessageId, kind: MessageKind.PEER_MESSAGE, refusal: "HOLDER_CLAIMED",
      reason: "a PEER_MESSAGE is delivered by its holder's claim (role_owner_message_claim), and a retry cannot deliver it",
    })]);
    expect(attemptsOf(harness, ctoRow)).toBe(2);
    expect(harness.cp.outbox.get(peerMessageId)?.status).toBe("PENDING");
  });

  it("an expired target is refused as expired, naming its expiry, and is not resent", async () => {
    const { harness, expiring, ceoRow } = await withFailedRows();
    const expiresAt = harness.cp.db.get<{ expires_at: string }>(`SELECT expires_at FROM outbox WHERE message_id = ?`, [expiring])!.expires_at;
    const refused = await retry(harness, { messageId: expiring }, true);
    expect(refused.reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
    expect(targetEvidence(refused).rows).toEqual([expect.objectContaining({
      messageId: expiring, refusal: "EXPIRED", expiresAt, reason: `it expired at ${expiresAt}, and an expired message is never resent`,
    })]);
    expect(attemptsOf(harness, expiring)).toBe(2);
    expect(attemptsOf(harness, ceoRow)).toBe(2);
  });

  it("a roleKey lists the role's expired row as EXPIRED with its expiry, and resets nothing", async () => {
    const { harness, ctoRoleKey, cto, generation, peerMessageId } = await ctoWithPeerMessage();
    const task = harness.cp.outbox.enqueue({
      idempotencyKey: "short-lived-task", roleKey: ctoRoleKey, bindingGeneration: generation, targetSessionId: cto.sessionId,
      runId: null, kind: MessageKind.TASK_ASSIGN, payload: { note: "short-lived" }, ttlMs: 60_000,
    });
    if (!task.allowed) throw new Error(`enqueue failed: ${task.message}`);
    harness.clock.advance(2 * 60 * 1000);
    harness.cp.outbox.expireOverdue();
    expect(harness.cp.outbox.get(task.value.messageId)?.status).toBe("EXPIRED");
    const expiresAt = task.value.expiresAt;

    const refused = await retry(harness, { roleKey: ctoRoleKey }, true);
    expect(refused.reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
    const evidence = targetEvidence(refused) as { found: boolean; rows: Array<Record<string, unknown>> };
    expect(evidence.found).toBe(true);
    expect(evidence.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        messageId: task.value.messageId, status: "EXPIRED", refusal: "EXPIRED", expiresAt,
        reason: `it expired at ${expiresAt}, and an expired message is never resent`,
      }),
      expect.objectContaining({ messageId: peerMessageId, refusal: "HOLDER_CLAIMED" }),
    ]));
    expect(harness.cp.outbox.get(task.value.messageId)?.status).toBe("EXPIRED");
  });

  it("a roleKey selects the role's undelivered rows only: its EXPIRED and PENDING rows, never a delivered one", async () => {
    const { harness } = await ctoWithPeerMessage();
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const toCeo = (key: string, ttlMs?: number): string => {
      const queued = harness.cp.outbox.enqueue({
        idempotencyKey: key, roleKey: ceo.roleKey, bindingGeneration: ceo.bindingGeneration, targetSessionId: ceo.sessionId,
        runId: null, kind: MessageKind.TASK_ASSIGN, payload: { key }, ...(ttlMs !== undefined ? { ttlMs } : {}),
      });
      if (!queued.allowed) throw new Error(`enqueue failed: ${queued.message}`);
      return queued.value.messageId;
    };
    const acked = toCeo("delivered");
    expect(harness.cp.outbox.acknowledge(acked, ceo.sessionId, ceo.bindingGeneration).allowed).toBe(true);
    const expired = toCeo("short-lived", 60_000);
    const pending = toCeo("failed-once");
    harness.cp.db.run(`UPDATE outbox SET attempts = 1, last_error = 'transport down' WHERE message_id = ?`, [pending]);
    harness.clock.advance(2 * 60 * 1000);
    harness.cp.outbox.expireOverdue();
    expect([acked, expired, pending].map((id) => harness.cp.outbox.get(id)?.status)).toEqual(["ACKED", "EXPIRED", "PENDING"]);

    const dry = await retry(harness, { roleKey: ceo.roleKey }, true);
    expect(dry.allowed).toBe(true);
    if (!dry.allowed) return;
    const evidence = dry.value.preconditionsChecked[0]!.evidence as { rows: Array<Record<string, unknown>>; eligibleMessageIds: string[] };
    expect(evidence.rows.map((row) => [row["messageId"], row["refusal"] ?? null]).sort()).toEqual(
      [[expired, "EXPIRED"], [pending, null]].sort(),
    );
    expect(evidence.eligibleMessageIds).toEqual([pending]);
    // A message id still selects its row whatever its status: a delivered one is reported, not hidden.
    const delivered = await retry(harness, { messageId: acked }, true);
    expect(targetEvidence(delivered).rows).toEqual([expect.objectContaining({ messageId: acked, refusal: "NOT_PENDING" })]);
  });

  it("with no target it resets every role's retryable rows, as before", async () => {
    const { harness, ceoRow, ctoRow, expiring } = await withFailedRows();
    const done = await retry(harness, {}, false);
    expect(done.allowed && done.value.changes).toBe(2);
    expect(harness.cp.audit.byKind("REPAIR_EXECUTED").at(-1)!.evidence["target"]).toEqual({
      pending: expect.arrayContaining([
        expect.objectContaining({ messageId: ceoRow }), expect.objectContaining({ messageId: ctoRow }),
        expect.objectContaining({ messageId: expiring }),
      ]),
      eligibleMessageIds: expect.arrayContaining([ceoRow, ctoRow]),
    });
    expect([attemptsOf(harness, ceoRow), attemptsOf(harness, ctoRow), attemptsOf(harness, expiring)]).toEqual([0, 0, 2]);
  });
});
