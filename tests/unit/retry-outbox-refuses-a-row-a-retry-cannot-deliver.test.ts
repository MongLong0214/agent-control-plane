import { afterAll, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { retryOutboxRefusal } from "../../src/doctor/repair.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1442 PR 2 step 4 — which outbox row `retry_outbox` can deliver is one exported test, `retryOutboxRefusal`,
 * so the watchdog's stall routing can ask the same question. `retryOutboxTarget` refuses with it, with the
 * same codes and reasons as before.
 */

const NOW = "2026-11-28T10:00:00.000Z";
const LATER = "2026-11-28T11:00:00.000Z";
const EARLIER = "2026-11-28T09:00:00.000Z";

describe("retryOutboxRefusal", () => {
  it("names each row a retry cannot deliver, with its code and reason, and passes a pushed row with a failed attempt", () => {
    const row = { kind: MessageKind.RUN_DISPATCH as string, status: "PENDING", attempts: 2, expires_at: LATER };
    expect(retryOutboxRefusal(row, NOW)).toBeNull();
    expect(retryOutboxRefusal({ ...row, kind: MessageKind.PEER_MESSAGE }, NOW)).toEqual({
      refusal: "HOLDER_CLAIMED",
      reason: "a PEER_MESSAGE is delivered by its holder's claim (role_owner_message_claim), and a retry cannot deliver it",
    });
    expect(retryOutboxRefusal({ ...row, expires_at: EARLIER }, NOW)).toEqual({
      refusal: "EXPIRED", reason: `it expired at ${EARLIER}, and an expired message is never resent`,
    });
    expect(retryOutboxRefusal({ ...row, expires_at: NOW }, NOW)?.refusal).toBe("EXPIRED");
    expect(retryOutboxRefusal({ ...row, status: "EXPIRED" }, NOW)?.refusal).toBe("EXPIRED");
    expect(retryOutboxRefusal({ ...row, status: "ACKED" }, NOW)).toEqual({ refusal: "NOT_PENDING", reason: "it is ACKED, not PENDING" });
    expect(retryOutboxRefusal({ ...row, attempts: 0 }, NOW)).toEqual({
      refusal: "NO_FAILED_ATTEMPT", reason: "no delivery attempt has failed; the delivery pass sends it",
    });
  });
});

describe("retryOutboxTarget refuses a stalled row a retry cannot deliver", () => {
  it("an unattempted RUN_DISPATCH and a holder-claimed PEER_MESSAGE, both past the delivery deadline, are refused by the same test", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    bindCeo(harness);
    const ctoRoleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const cto = harness.cp.sessions.create({ provider: "scripted", model: "cto" });
    expect(harness.cp.sessions.transition(cto.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
    const bound = harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: cto.sessionId, projectId });
    if (!bound.allowed) throw new Error(`CTO binding failed: ${bound.message}`);
    const to = { roleKey: ctoRoleKey, bindingGeneration: bound.value.bindingGeneration, targetSessionId: cto.sessionId, runId: null };
    const dispatch = harness.cp.outbox.enqueue({ ...to, idempotencyKey: "dispatch", kind: MessageKind.RUN_DISPATCH, payload: { note: "dispatch" } });
    if (!dispatch.allowed) throw new Error(`enqueue failed: ${dispatch.message}`);
    const nonce = "buzz-message:event-stalled";
    const admitted = { text: "please look at the queue", mention: "npub-cto" };
    harness.cp.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES ('buzz', ?, 'npub-ceo', ?, ?)`,
      [nonce, harness.clock.nowIso(), JSON.stringify(admitted)],
    );
    const peer = harness.cp.outbox.enqueue({
      ...to, idempotencyKey: `peer-message:${nonce}`, kind: MessageKind.PEER_MESSAGE,
      payload: { sourceChannel: "buzz", sourceNonce: nonce, sourcePayloadDigest: digestOf(admitted) },
    });
    if (!peer.allowed) throw new Error(`enqueue failed: ${peer.message}`);
    harness.clock.advance(11 * 60 * 1000);

    const stalled = (await harness.cp.watchdog.tick()).stalls.filter((stall) => stall.kind === "outbox").map((stall) => stall.id);
    expect(stalled).toEqual(expect.arrayContaining([dispatch.value.messageId, peer.value.messageId]));

    for (const [messageId, refusal] of [[dispatch.value.messageId, "NO_FAILED_ATTEMPT"], [peer.value.messageId, "HOLDER_CLAIMED"]] as const) {
      const refused = await harness.cp.repair.execute({ operationId: "retry_outbox", parameters: { messageId }, authorizedBy: "HERMES", dryRun: false });
      expect(refused.reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
      const rows = (refused.evidence as { preconditions: Array<{ evidence: { rows: Array<Record<string, unknown>> } }> }).preconditions[0]!.evidence.rows;
      const row = harness.cp.db.get<{ kind: string; status: string; attempts: number; expires_at: string }>(
        `SELECT kind, status, attempts, expires_at FROM outbox WHERE message_id = ?`, [messageId],
      )!;
      expect(rows).toEqual([expect.objectContaining({ messageId, refusal, ...retryOutboxRefusal(row, harness.clock.nowIso()) })]);
      expect(row).toMatchObject({ status: "PENDING", attempts: 0 });
    }
  });
});
