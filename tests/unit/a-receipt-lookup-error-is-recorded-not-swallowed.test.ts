import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReceiptLookupQuery } from "../../src/conversation/turn-coordinator.ts";
import { CANONICAL_TURN_RECEIPT_LOOKUP_FAILED } from "../../src/conversation/turn-coordinator.ts";
import { digestOf } from "../../src/core/digest.ts";
import { startTelegramExternalIngress, withConfiguredHermesGatewayReceipt } from "../../src/daemon/agentcpd.ts";
import type { Finding } from "../../src/doctor/doctor.ts";
import type { TelegramExternalAnswer, TelegramExternalTurnIdentity } from "../../src/ingress/telegram-external.ts";
import { HermesGatewayReceiptPort } from "../../src/runtime/hermes-gateway-receipt-port.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  FakeGateway,
  GATEWAY_KEY,
  type GatewayAnswer,
  envelope,
  externalLaneFixture,
  gatewayDelivery,
  gatewayReceipt,
  sendOverSocket,
} from "../helpers/telegram-external.ts";

afterAll(cleanupTempDirs);

/**
 * #1036: a receipt the Gateway answered but ACP could not read is not the same event as a receipt
 * the Gateway does not have. The port names why it could not read the answer, the sweep writes that
 * reason once per turn per distinct cause, and the turn stays IN_DOUBT: a malformed receipt never
 * settles anything.
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

const daemonFixture = () =>
  externalLaneFixture({
    configure: (config) => {
      const composed = withConfiguredHermesGatewayReceipt(config, { ACP_HERMES_GATEWAY_API_KEY: GATEWAY_KEY });
      return { ...composed, hermesGatewayReceipt: { ...composed.hermesGatewayReceipt!, port } };
    },
  });
type Fixture = ReturnType<typeof daemonFixture>;

const claimOne = async (fixture: Fixture, updateId: number): Promise<TelegramExternalTurnIdentity> => {
  const ingress = await startTelegramExternalIngress(fixture.cp, tempDir("u4lk-"), fixture.laneConfig);
  try {
    const answer: TelegramExternalAnswer = await sendOverSocket(ingress.socketPath, envelope(updateId, `질문 ${updateId}`));
    if (!answer.allowed) throw new Error(`the lane refused the fixture turn: ${JSON.stringify(answer)}`);
    return answer.turn;
  } finally {
    await ingress.close();
  }
};

const lifecycle = (fixture: Fixture, turnRequestId: string): { lifecycle_state: string; outcome_kind: string | null } =>
  fixture.cp.db.get<{ lifecycle_state: string; outcome_kind: string | null }>(
    `SELECT lifecycle_state, outcome_kind FROM canonical_turns WHERE turn_request_id = ?`,
    [turnRequestId],
  )!;

const observationCount = (fixture: Fixture, turnRequestId: string): number =>
  fixture.cp.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM canonical_turn_observations WHERE turn_request_id = ?`,
    [turnRequestId],
  )!.n;

const lookupFailures = (fixture: Fixture) =>
  fixture.cp.audit.byKind("CANONICAL_TURN_RECEIPT_LOOKUP_FAILED").map((row) => ({
    reasonCode: row.reasonCode,
    actor: row.actor,
    evidence: row.evidence,
  }));

const inDoubtFinding = async (fixture: Fixture): Promise<Finding | undefined> =>
  (await fixture.cp.doctor.run("system")).findings.find((f) => f.code === "CANONICAL_TURN_IN_DOUBT");

const answering = (answer: (updateId: number) => GatewayAnswer): void => {
  gateway.answer = answer;
};

describe("#1036 a receipt lookup error is recorded, not swallowed", () => {
  it("W1: update_id as a string is SCHEMA/update_id-type, the turn stays IN_DOUBT, and doctor names it", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 401);
      answering((updateId) => ({ kind: "json", body: { ...gatewayReceipt(updateId, turn), update_id: String(updateId) } }));
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);

      expect(CANONICAL_TURN_RECEIPT_LOOKUP_FAILED).toBe("CANONICAL_TURN_RECEIPT_LOOKUP_FAILED");
      expect(swept).toMatchObject({ swept: 1, settled: 0, failed: 0 });
      expect(lifecycle(fixture, turn.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
      expect(observationCount(fixture, turn.turnRequestId)).toBe(0);
      expect(lookupFailures(fixture)).toEqual([{
        reasonCode: "CONVERSATION_TURN_RECEIPT_LOOKUP_FAILED",
        actor: turn.targetActorId,
        evidence: { turnRequestId: turn.turnRequestId, sourceNonce: "update:401", kind: "SCHEMA", detail: "update_id-type" },
      }]);

      const found = await inDoubtFinding(fixture);
      expect(found?.observedEvidence).toMatchObject({
        outstanding: 1,
        oldest: {
          turnRequestId: turn.turnRequestId,
          lookupError: { kind: "SCHEMA", detail: "update_id-type", at: fixture.clock.nowIso() },
        },
        lookupErrors: [
          { turnRequestId: turn.turnRequestId, kind: "SCHEMA", detail: "update_id-type", at: fixture.clock.nowIso() },
        ],
      });
      expect(found?.recommendedAction).toContain("A lookup error means the target's receipt could not be read");
    } finally {
      fixture.cp.close();
    }
  });

  it("W2: a COMPLETED receipt whose reasonCode is null is SCHEMA/reasonCode and settles nothing", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 402);
      answering((updateId) => ({ kind: "json", body: { ...gatewayReceipt(updateId, turn), reasonCode: null } }));
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);

      expect(swept).toMatchObject({ swept: 1, settled: 0, failed: 0 });
      expect(lifecycle(fixture, turn.turnRequestId).lifecycle_state).toBe("IN_DOUBT");
      expect(lookupFailures(fixture).map((row) => row.evidence)).toEqual([
        { turnRequestId: turn.turnRequestId, sourceNonce: "update:402", kind: "SCHEMA", detail: "reasonCode" },
      ]);
    } finally {
      fixture.cp.close();
    }
  });

  it("W3: a 500 is HTTP_STATUS/500", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 403);
      answering((updateId) => ({ kind: "json", status: 500, body: gatewayReceipt(updateId, turn) }));
      await fixture.cp.conversation.reconcileUnresolved(5_000);

      expect(lifecycle(fixture, turn.turnRequestId).lifecycle_state).toBe("IN_DOUBT");
      expect(lookupFailures(fixture).map((row) => row.evidence)).toEqual([
        { turnRequestId: turn.turnRequestId, sourceNonce: "update:403", kind: "HTTP_STATUS", detail: "500" },
      ]);
    } finally {
      fixture.cp.close();
    }
  });

  it("W4: a Gateway that never answers is TIMEOUT", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 404);
      answering(() => ({ kind: "hang" }));
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);

      expect(swept).toMatchObject({ swept: 1, settled: 0, failed: 0 });
      expect(lifecycle(fixture, turn.turnRequestId).lifecycle_state).toBe("IN_DOUBT");
      expect(lookupFailures(fixture).map((row) => row.evidence)).toEqual([
        { turnRequestId: turn.turnRequestId, sourceNonce: "update:404", kind: "TIMEOUT", detail: "no-answer-in-2000ms" },
      ]);
    } finally {
      fixture.cp.close();
    }
  });

  it("W5: a genuine 404 is a plain not-found and writes no lookup error", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 405);
      answering(() => ({ kind: "json", status: 404, body: {} }));
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);

      expect(swept).toMatchObject({ swept: 1, settled: 0, failed: 0 });
      expect(gateway.requests).toHaveLength(1);
      expect(lifecycle(fixture, turn.turnRequestId).lifecycle_state).toBe("IN_DOUBT");
      expect(lookupFailures(fixture)).toEqual([]);
      const found = await inDoubtFinding(fixture);
      expect(found?.observedEvidence["lookupErrors"]).toBeUndefined();
      expect((found?.observedEvidence["oldest"] as Record<string, unknown>)["lookupError"]).toBeUndefined();
      expect(found?.recommendedAction).not.toContain("lookup error");
    } finally {
      fixture.cp.close();
    }
  });

  it("W6: repeated sweeps with the same error write exactly one event, and a changed error one more", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 406);
      const stringId = (updateId: number): GatewayAnswer =>
        ({ kind: "json", body: { ...gatewayReceipt(updateId, turn), update_id: String(updateId) } });
      answering(stringId);
      for (let sweep = 0; sweep < 4; sweep += 1) await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(gateway.requests).toHaveLength(4);
      expect(lookupFailures(fixture).map((row) => row.evidence["detail"])).toEqual(["update_id-type"]);

      answering((updateId) => ({ kind: "json", status: 500, body: gatewayReceipt(updateId, turn) }));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(lookupFailures(fixture).map((row) => [row.evidence["kind"], row.evidence["detail"]])).toEqual([
        ["SCHEMA", "update_id-type"],
        ["HTTP_STATUS", "500"],
      ]);

      // The same kind with a different detail is a different cause.
      answering((updateId) => ({ kind: "json", status: 503, body: gatewayReceipt(updateId, turn) }));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      // And a cause that returns after another one is recorded again: the latest row is what is compared.
      answering(stringId);
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(lookupFailures(fixture).map((row) => `${String(row.evidence["kind"])}/${String(row.evidence["detail"])}`)).toEqual([
        "SCHEMA/update_id-type",
        "HTTP_STATUS/500",
        "HTTP_STATUS/503",
        "SCHEMA/update_id-type",
      ]);
      expect(lifecycle(fixture, turn.turnRequestId).lifecycle_state).toBe("IN_DOUBT");

      // Doctor reads the latest one.
      const found = await inDoubtFinding(fixture);
      expect((found?.observedEvidence["oldest"] as Record<string, unknown>)["lookupError"])
        .toMatchObject({ kind: "SCHEMA", detail: "update_id-type" });
    } finally {
      fixture.cp.close();
    }
  });

  it("W7: a valid receipt still settles COMPLETED exactly as before, after an error and with none of its own", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 407);
      answering((updateId) => ({ kind: "json", status: 500, body: gatewayReceipt(updateId, turn) }));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(lookupFailures(fixture)).toHaveLength(1);

      answering((updateId) => ({ kind: "json", body: gatewayReceipt(updateId, turn, { delivery: null }) }));
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(swept).toMatchObject({ swept: 1, settled: 1, failed: 0 });
      expect(lifecycle(fixture, turn.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
      expect(observationCount(fixture, turn.turnRequestId)).toBe(1);
      expect(lookupFailures(fixture)).toHaveLength(1);
      expect(await inDoubtFinding(fixture)).toBeUndefined();

      // A settled turn is never swept again, so a later error for its update writes nothing.
      answering((updateId) => ({ kind: "json", status: 500, body: gatewayReceipt(updateId, turn) }));
      expect((await fixture.cp.conversation.reconcileUnresolved(5_000)).swept).toBe(0);
      expect(lookupFailures(fixture)).toHaveLength(1);
    } finally {
      fixture.cp.close();
    }
  });

  it("W8: a turn that settled between the lookup and the write gets no lookup error", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 408);
      let release: (answer: GatewayAnswer) => void = () => undefined;
      answering(() => ({ kind: "deferred", answer: new Promise<GatewayAnswer>((resolve) => { release = resolve; }) }));
      const sweeping = fixture.cp.conversation.reconcileUnresolved(5_000);
      // While the first lookup waits at the Gateway, a second sweep reads a valid receipt and settles the turn.
      while (gateway.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      answering((updateId) => ({ kind: "json", body: gatewayReceipt(updateId, turn, { delivery: null }) }));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(lifecycle(fixture, turn.turnRequestId).lifecycle_state).toBe("SETTLED");
      release({ kind: "json", status: 500, body: {} });
      await sweeping;
      expect(lookupFailures(fixture)).toEqual([]);
    } finally {
      fixture.cp.close();
    }
  });
});

/** A loopback server answering one fixed raw response, for shapes the fake Gateway does not send. */
const rawServer = async (respond: Parameters<typeof createServer>[1]): Promise<{ port: number; close: () => Promise<void> }> => {
  const server: Server = createServer(respond);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

describe("#1036 the Gateway port names every cause", () => {
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
  const portOn = (on: number) =>
    new HermesGatewayReceiptPort((id) => (id === turn.turnRequestId ? { updateId: 80 } : null), { apiKey: GATEWAY_KEY, port: on });
  const ask = (on: number = port) => portOn(on).lookup(query, new AbortController().signal);
  const valid = (): Record<string, unknown> => gatewayReceipt(80, turn);
  const schema = (detail: string) => ({ found: false, lookupError: { kind: "SCHEMA", detail } });
  const withIdentity = (changes: Record<string, unknown>) => ({ ...valid(), receiptIdentity: { ...turn, ...changes } });

  it("W10: every schema check that refuses an answer is named by the first one that failed", async () => {
    const without = (key: string) => Object.fromEntries(Object.entries(valid()).filter(([name]) => name !== key));
    const cases: Array<[unknown, string]> = [
      [[valid()], "not-object"],
      // Only the Gateway's bare NEVER_FOUND is an answer; any other one-key status is not a receipt.
      [{ status: "COMPLETED" }, "missing-key:delivery"],
      [{ ...valid(), signature: "x" }, "unknown-keys"],
      [without("delivery"), "missing-key:delivery"],
      [{ ...valid(), content: 7 }, "content"],
      [{ ...valid(), schema: "hermes.gateway-turn-receipt/v2" }, "schema-name"],
      [{ ...valid(), update_id: "80" }, "update_id-type"],
      [{ ...valid(), update_id: 80.5 }, "update_id-type"],
      [{ ...valid(), update_id: 81 }, "update_id-mismatch"],
      [{ ...valid(), message_id: "180" }, "message_id-type"],
      [{ ...valid(), message_id: 1.5 }, "message_id-type"],
      [{ ...valid(), message_id: 0 }, "message_id-range"],
      [{ ...valid(), status: "DONE" }, "status"],
      [{ ...valid(), receiptIdentity: null }, "identity-keys"],
      [{ ...valid(), receiptIdentity: { ...turn, extra: 1 } }, "identity-keys"],
      [withIdentity({ turnRequestId: "" }), "identity-field:turnRequestId"],
      [withIdentity({ targetActorId: 7 }), "identity-field:targetActorId"],
      [withIdentity({ promptDigest: "sha256:short" }), "identity-field:promptDigest"],
      [withIdentity({ bindingGeneration: "3" }), "identity-field:bindingGeneration"],
      [withIdentity({ bindingGeneration: 0 }), "identity-field:bindingGeneration"],
      [withIdentity({ targetBindingId: "x\ny" }), "identity-field:targetBindingId"],
      [withIdentity({ targetAttestationId: null }), "identity-field:targetAttestationId"],
      [withIdentity({ executorSessionId: "x".repeat(513) }), "identity-field:executorSessionId"],
      [withIdentity({ executorSessionIncarnation: 1 }), "identity-field:executorSessionIncarnation"],
      [{ ...valid(), turnRequestId: "tr_other" }, "turnRequestId-mismatch"],
      [{ ...valid(), receiptId: "sha256:abc" }, "receiptId"],
      [{ ...valid(), receiptId: "hermes-tg:" }, "receiptId"],
      [{ ...valid(), evidenceDigest: "sha256:short" }, "evidenceDigest"],
      [{ ...valid(), reasonCode: null }, "reasonCode"],
      [{ ...valid(), reasonCode: "R".repeat(129) }, "reasonCode"],
      [{ ...valid(), delivery: { ...gatewayDelivery(80), extra: 1 } }, "delivery-keys"],
      [{ ...valid(), delivery: "delivered" }, "delivery-keys"],
      [{ ...gatewayReceipt(80, turn, { status: "ABORTED" }), delivery: gatewayDelivery(80) }, "aborted-with-delivery"],
    ];
    for (const [body, detail] of cases) {
      answering(() => ({ kind: "json", body }));
      await expect(ask(), detail).resolves.toEqual(schema(detail));
    }
    // The control: the unaltered answer is a receipt.
    answering(() => ({ kind: "json", body: valid() }));
    await expect(ask()).resolves.toMatchObject({ found: true, outcome: "COMPLETED" });
  });

  it("W11: a transport, status, type, size or parse failure names its cause, and only a 404 or NEVER_FOUND does not", async () => {
    const cases: Array<[string, GatewayAnswer, unknown]> = [
      ["500", { kind: "json", status: 500, body: valid() }, { kind: "HTTP_STATUS", detail: "500" }],
      ["401", { kind: "json", status: 401, body: {} }, { kind: "HTTP_STATUS", detail: "401" }],
      ["text/plain", { kind: "json", body: valid(), contentType: "text/plain" }, { kind: "CONTENT_TYPE", detail: "text/plain" }],
      ["odd type", { kind: "json", body: valid(), contentType: "application/json(x)" }, { kind: "CONTENT_TYPE", detail: "unrecognized" }],
      ["no type", { kind: "json", body: valid(), contentType: "" }, { kind: "CONTENT_TYPE", detail: "missing" }],
      ["streamed over 4KB", { kind: "json", body: { ...valid(), content: "x".repeat(5_000) } }, { kind: "TOO_LARGE", detail: "body" }],
      ["not json", { kind: "raw", body: "{not json" }, { kind: "PARSE", detail: "invalid-json" }],
    ];
    for (const [name, answer, lookupError] of cases) {
      answering(() => answer);
      await expect(ask(), name).resolves.toEqual({ found: false, lookupError });
    }

    // Answers that are not failures: Hermes holds no receipt, or holds one that is not terminal yet.
    const plain: Array<[string, GatewayAnswer]> = [
      ["404", { kind: "json", status: 404, body: {} }],
      ["bare NEVER_FOUND", { kind: "json", body: { status: "NEVER_FOUND" } }],
      ["receipt-shaped NEVER_FOUND", { kind: "json", body: gatewayReceipt(80, turn, { status: "NEVER_FOUND" }) }],
      ["PENDING", { kind: "json", body: gatewayReceipt(80, turn, { status: "PENDING" }) }],
    ];
    for (const [name, answer] of plain) {
      answering(() => answer);
      await expect(ask(), name).resolves.toEqual({ found: false });
    }

    // A declared length over the bound is refused before the body is read.
    const declared = await rawServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "5000" });
      res.end("x".repeat(5_000));
    });
    try {
      await expect(ask(declared.port)).resolves.toEqual({ found: false, lookupError: { kind: "TOO_LARGE", detail: "content-length" } });
    } finally {
      await declared.close();
    }

    // Nothing listening: the connection itself failed.
    const closed = await rawServer((_req, res) => res.end());
    const closedPort = closed.port;
    await closed.close();
    await expect(ask(closedPort)).resolves.toEqual({ found: false, lookupError: { kind: "TRANSPORT", detail: "ECONNREFUSED" } });

    // The connection dropped mid-answer.
    const dropped = await rawServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    try {
      await expect(ask(dropped.port)).resolves.toEqual({ found: false, lookupError: { kind: "TRANSPORT", detail: "response-aborted" } });
    } finally {
      await dropped.close();
    }

    answering(() => ({ kind: "hang" }));
    const started = Date.now();
    await expect(ask()).resolves.toEqual({ found: false, lookupError: { kind: "TIMEOUT", detail: "no-answer-in-2000ms" } });
    expect(Date.now() - started).toBeLessThan(3_000);

    const aborted = new AbortController();
    const pending = portOn(port).lookup(query, aborted.signal);
    aborted.abort();
    await expect(pending).resolves.toEqual({ found: false, lookupError: { kind: "TIMEOUT", detail: "aborted" } });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(portOn(port).lookup(query, preAborted.signal))
      .resolves.toEqual({ found: false, lookupError: { kind: "TIMEOUT", detail: "aborted" } });

    // A turn with no single Telegram update source has nothing to ask the Gateway about.
    const asked = gateway.requests.length;
    await expect(portOn(port).lookup({ ...query, turnRequestId: "tr_buzz" }, new AbortController().signal))
      .resolves.toEqual({ found: false });
    expect(gateway.requests.length).toBe(asked);
  });
});
