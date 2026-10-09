import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReceiptLookupQuery } from "../../src/conversation/turn-coordinator.ts";
import { ownerReplyFor } from "../../src/conversation/owner-reply-outbox.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startTelegramExternalIngress, withConfiguredHermesGatewayReceipt } from "../../src/daemon/agentcpd.ts";
import type { TelegramExternalAnswer, TelegramExternalTurnIdentity } from "../../src/ingress/telegram-external.ts";
import { HermesGatewayReceiptPort } from "../../src/runtime/hermes-gateway-receipt-port.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  CHAT_ID,
  FakeGateway,
  GATEWAY_KEY,
  envelope,
  externalLaneFixture,
  gatewayNeverFound,
  gatewayPending,
  gatewayReceipt,
  sendOverSocket,
} from "../helpers/telegram-external.ts";

afterAll(cleanupTempDirs);

/**
 * U4 A2: the coordinator's receipt port for Telegram turns is the Hermes Gateway's own receipt
 * store, and nothing it answers settles a turn except a terminal receipt whose eight identity
 * fields match the turn ACP claimed.
 */

let gateway: FakeGateway;
let port: number;
beforeEach(async () => {
  gateway = new FakeGateway();
  port = await gateway.start();
});
afterEach(async () => {
  await gateway.close();
});

/** The daemon's own composition, pointed at the fake Gateway's ephemeral port. */
const daemonFixture = () =>
  externalLaneFixture({
    configure: (config) => {
      const composed = withConfiguredHermesGatewayReceipt(config, { ACP_HERMES_GATEWAY_API_KEY: GATEWAY_KEY });
      expect(composed.hermesGatewayReceipt).toEqual({ apiKey: GATEWAY_KEY });
      return { ...composed, hermesGatewayReceipt: { ...composed.hermesGatewayReceipt!, port } };
    },
  });

const claimOne = async (
  fixture: ReturnType<typeof externalLaneFixture>,
  updateId: number,
): Promise<TelegramExternalTurnIdentity> => {
  const ingress = await startTelegramExternalIngress(fixture.cp, tempDir("u4p-"), fixture.laneConfig);
  try {
    const answer: TelegramExternalAnswer = await sendOverSocket(ingress.socketPath, envelope(updateId, `질문 ${updateId}`));
    if (!answer.allowed) throw new Error(`the lane refused the fixture turn: ${JSON.stringify(answer)}`);
    return answer.turn;
  } finally {
    await ingress.close();
  }
};

const turnRow = (fixture: ReturnType<typeof externalLaneFixture>, turnRequestId: string) =>
  fixture.cp.db.get<{ lifecycle_state: string; outcome_kind: string | null; observation_consistency: string }>(
    `SELECT lifecycle_state, outcome_kind, observation_consistency FROM canonical_turns WHERE turn_request_id = ?`,
    [turnRequestId],
  )!;

const observations = (fixture: ReturnType<typeof externalLaneFixture>, turnRequestId: string) =>
  fixture.cp.db.all<{ observed_outcome: string; observing_authority: string; receipt_id: string }>(
    `SELECT observed_outcome, observing_authority, receipt_id FROM canonical_turn_observations
      WHERE turn_request_id = ? ORDER BY observation_id`,
    [turnRequestId],
  );

describe("U4 Hermes Gateway receipt port", () => {
  it("RED6: a daemon holding the Gateway key composes a port that asks the Gateway, and one without it stays dark", async () => {
    const bare = { databasePath: "/unused/state.sqlite", worktreeRoot: "/unused", capacityDir: "/unused", secretsDir: "/unused" };
    expect(withConfiguredHermesGatewayReceipt(bare, {}).hermesGatewayReceipt).toBeUndefined();
    expect(withConfiguredHermesGatewayReceipt(bare, { ACP_HERMES_GATEWAY_API_KEY: "has a space" }).hermesGatewayReceipt)
      .toBeUndefined();

    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 70);
      gateway.answer = (updateId) => ({ kind: "json", body: gatewayReceipt(updateId, turn) });
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(swept).toMatchObject({ swept: 1, settled: 1, failed: 0 });
      expect(gateway.requests).toEqual([
        { path: "/v1/canonical-surface/receipts/telegram/70", authorization: `Bearer ${GATEWAY_KEY}` },
      ]);
    } finally {
      fixture.cp.close();
    }
  });

  it("RED9: a COMPLETED receipt settles the turn COMPLETED and CONSISTENT and owes the owner one reply", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 71);
      // No delivery evidence, so the reply stays owed (A3 records it DELIVERED when there is some).
      gateway.answer = (updateId) => ({ kind: "json", body: gatewayReceipt(updateId, turn, { delivery: null }) });
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(turnRow(fixture, turn.turnRequestId)).toEqual({
        lifecycle_state: "SETTLED",
        outcome_kind: "COMPLETED",
        observation_consistency: "CONSISTENT",
      });
      expect(observations(fixture, turn.turnRequestId)).toEqual([
        { observed_outcome: "COMPLETED", observing_authority: "HERMES_TARGET", receipt_id: "hermes-tg:obligation-71" },
      ]);
      const reply = ownerReplyFor(fixture.cp.db, turn.turnRequestId);
      expect(reply).toMatchObject({
        turnRequestId: turn.turnRequestId,
        ledger: "CANONICAL_TURN",
        status: "PENDING",
        sources: [{ channel: "telegram", nonce: "update:71" }],
        address: { channel: "telegram", conversation: String(CHAT_ID), replyToMessageId: 171 },
        receipt: { authority: "HERMES_TARGET", receiptId: "hermes-tg:obligation-71" },
      });

      // The same receipt redelivered by the next sweep changes nothing.
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(swept.swept).toBe(0);
      expect(observations(fixture, turn.turnRequestId)).toHaveLength(1);
    } finally {
      fixture.cp.close();
    }
  });

  it("RED7: a receipt that differs from the turn in any one of its eight identity fields leaves it IN_DOUBT", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 72);
      const altered: Array<Partial<TelegramExternalTurnIdentity>> = [
        { turnRequestId: "tr_00000000000000000000000000000000" },
        { targetActorId: "actor:someone-else" },
        { promptDigest: digestOf("a different prompt") },
        { bindingGeneration: turn.bindingGeneration + 1 },
        { targetBindingId: "binding:someone-else" },
        { targetAttestationId: "attestation:someone-else" },
        { executorSessionId: "session:someone-else" },
        { executorSessionIncarnation: "incarnation:someone-else" },
      ];
      for (const identity of altered) {
        const field = Object.keys(identity)[0]!;
        const asked = gateway.requests.length;
        gateway.answer = (updateId) => ({ kind: "json", body: gatewayReceipt(updateId, turn, { identity }) });
        const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);
        expect(gateway.requests.length, field).toBe(asked + 1);
        expect(swept, field).toMatchObject({ swept: 1, settled: 0, failed: 0 });
        expect(turnRow(fixture, turn.turnRequestId).lifecycle_state, field).toBe("IN_DOUBT");
        expect(observations(fixture, turn.turnRequestId), field).toEqual([]);
        expect(ownerReplyFor(fixture.cp.db, turn.turnRequestId), field).toBeNull();
      }
      // The control: the unaltered receipt settles the same turn.
      gateway.answer = (updateId) => ({ kind: "json", body: gatewayReceipt(updateId, turn) });
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(turnRow(fixture, turn.turnRequestId).lifecycle_state).toBe("SETTLED");
    } finally {
      fixture.cp.close();
    }
  });

  it("RED8: PENDING, NEVER_FOUND, a timeout and every malformed answer are not found, and only the first two are not errors", async () => {
    const turn: TelegramExternalTurnIdentity = {
      turnRequestId: "tr_query",
      targetActorId: "actor:query",
      promptDigest: digestOf("query"),
      bindingGeneration: 3,
      targetBindingId: "binding:query",
      targetAttestationId: "attestation:query",
      executorSessionId: "session:query",
      executorSessionIncarnation: "incarnation:query",
    };
    const query: ReceiptLookupQuery = turn;
    const receiptPort = new HermesGatewayReceiptPort((id) => (id === turn.turnRequestId ? { updateId: 80 } : null), {
      apiKey: GATEWAY_KEY,
      port,
    });
    const ask = () => receiptPort.lookup(query, new AbortController().signal);
    const valid = gatewayReceipt(80, turn);
    const withoutKey = (key: string) => Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
    // #1036: a malformed or failed answer is still not found, and now says why.
    const failed = (kind: string, detail: string) => ({ found: false, lookupError: { kind, detail } });
    const answers: Array<[string, () => ReturnType<FakeGateway["answer"]>, unknown]> = [
      ["pending", () => ({ kind: "json", body: gatewayPending(80, turn) }), { found: false }],
      ["never found", () => ({ kind: "json", body: gatewayNeverFound(80) }), { found: false }],
      ["wrong schema", () => ({ kind: "json", body: { ...valid, schema: "hermes.gateway-turn-receipt/v2" } }), failed("SCHEMA", "schema-name")],
      ["another update", () => ({ kind: "json", body: gatewayReceipt(81, turn) }), failed("SCHEMA", "update_id-mismatch")],
      ["unknown key", () => ({ kind: "json", body: { ...valid, signature: "x" } }), failed("SCHEMA", "unknown-keys")],
      ["missing key", () => ({ kind: "json", body: withoutKey("delivery") }), failed("SCHEMA", "missing-key:delivery")],
      ["identity with an extra key", () => ({ kind: "json", body: { ...valid, receiptIdentity: { ...turn, extra: 1 } } }), failed("SCHEMA", "identity-keys")],
      ["two turn ids", () => ({ kind: "json", body: { ...valid, turnRequestId: "tr_other" } }), failed("SCHEMA", "turnRequestId-mismatch")],
      ["foreign receipt id", () => ({ kind: "json", body: gatewayReceipt(80, turn, { receiptId: "sha256:abc" }) }), failed("SCHEMA", "receiptId")],
      ["bad evidence digest", () => ({ kind: "json", body: { ...valid, evidenceDigest: "sha256:short" } }), failed("SCHEMA", "evidenceDigest")],
      ["unexpected status", () => ({ kind: "json", body: gatewayReceipt(80, turn, { status: "DONE" as "COMPLETED" }) }), failed("SCHEMA", "status")],
      ["not json", () => ({ kind: "raw", body: "{not json" }), failed("PARSE", "invalid-json")],
      ["wrong content type", () => ({ kind: "json", body: valid, contentType: "text/plain" }), failed("CONTENT_TYPE", "text")],
      ["server error", () => ({ kind: "json", status: 500, body: valid }), failed("HTTP_STATUS", "500")],
      ["over 4KB", () => ({ kind: "json", body: { ...valid, content: "x".repeat(5_000) } }), failed("TOO_LARGE", "body")],
    ];
    for (const [name, answer, expected] of answers) {
      gateway.answer = answer;
      await expect(ask(), name).resolves.toEqual(expected);
    }

    gateway.answer = () => ({ kind: "hang" });
    const started = Date.now();
    await expect(ask(), "timeout").resolves.toEqual(failed("TIMEOUT", "no-answer"));
    expect(Date.now() - started).toBeLessThan(3_000);

    const aborted = new AbortController();
    const pending = receiptPort.lookup(query, aborted.signal);
    aborted.abort();
    await expect(pending, "aborted").resolves.toEqual(failed("TIMEOUT", "aborted"));

    // A turn with no single Telegram update source is never asked about.
    const asked = gateway.requests.length;
    await expect(receiptPort.lookup({ ...query, turnRequestId: "tr_buzz" }, new AbortController().signal))
      .resolves.toEqual({ found: false });
    expect(gateway.requests.length).toBe(asked);

    // And the shape that is a receipt maps the Gateway's identity, not the query's.
    // The Gateway's reason code is carried as it was reported, whatever its vocabulary.
    gateway.answer = () => ({
      kind: "json",
      body: { ...gatewayReceipt(80, turn, { status: "ABORTED", reasonCode: ReasonCode.HERMES_AGENT_RUN_EXCEPTION }), content: "short" },
    });
    await expect(ask()).resolves.toEqual({
      found: true,
      outcome: "ABORTED",
      receiptId: "hermes-tg:obligation-80",
      evidenceDigest: valid["evidenceDigest"],
      reasonCode: ReasonCode.HERMES_AGENT_RUN_EXCEPTION,
      ...turn,
    });
  });

  it("RED8: a PENDING answer leaves a claimed turn IN_DOUBT with nothing recorded", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 73);
      gateway.answer = (updateId) => ({ kind: "json", body: gatewayPending(updateId, turn) });
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(swept).toMatchObject({ swept: 1, settled: 0, failed: 0 });
      expect(gateway.requests).toHaveLength(1);
      expect(turnRow(fixture, turn.turnRequestId).lifecycle_state).toBe("IN_DOUBT");
      expect(observations(fixture, turn.turnRequestId)).toEqual([]);
    } finally {
      fixture.cp.close();
    }
  });
});
