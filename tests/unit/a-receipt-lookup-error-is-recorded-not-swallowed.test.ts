import { createServer, type Server } from "node:http";
import { type AddressInfo, type Socket, createServer as createNetServer } from "node:net";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CANONICAL_TURN_RECEIPT_LOOKUP_FAILED,
  RECEIPT_LOOKUP_DETAILS,
  RECEIPT_LOOKUP_HTTP_ERRORS,
  type ReceiptLookupQuery,
  receiptLookupCause,
} from "../../src/conversation/turn-coordinator.ts";
import { digestOf } from "../../src/core/digest.ts";
import { startTelegramExternalIngress, withConfiguredHermesGatewayReceipt } from "../../src/daemon/agentcpd.ts";
import { redact } from "../../src/db/audit.ts";
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
  gatewayNeverFound,
  gatewayPending,
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
        { turnRequestId: turn.turnRequestId, sourceNonce: "update:404", kind: "TIMEOUT", detail: "no-answer" },
      ]);
    } finally {
      fixture.cp.close();
    }
  });

  it("W5: a 404 naming canonical_binding_unknown is HTTP_STATUS/404:canonical_binding_unknown, not a not-found", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 405);
      answering(() => ({ kind: "json", status: 404, body: { error: "canonical_binding_unknown" } }));
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);

      expect(swept).toMatchObject({ swept: 1, settled: 0, failed: 0 });
      expect(lifecycle(fixture, turn.turnRequestId).lifecycle_state).toBe("IN_DOUBT");
      expect(lookupFailures(fixture).map((row) => row.evidence)).toEqual([{
        turnRequestId: turn.turnRequestId,
        sourceNonce: "update:405",
        kind: "HTTP_STATUS",
        detail: "404:canonical_binding_unknown",
      }]);
      const found = await inDoubtFinding(fixture);
      expect((found?.observedEvidence["oldest"] as Record<string, unknown>)["lookupError"])
        .toMatchObject({ kind: "HTTP_STATUS", detail: "404:canonical_binding_unknown" });
    } finally {
      fixture.cp.close();
    }
  });

  it("W17: a 409 canonical_receipt_unprovable is HTTP_STATUS/409:canonical_receipt_unprovable and the turn stays IN_DOUBT", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 417);
      // Hermes' answer for a receipt it cannot prove from preserved evidence: never a not-found.
      answering(() => ({ kind: "json", status: 409, body: { error: "canonical_receipt_unprovable" } }));
      expect(await fixture.cp.conversation.reconcileUnresolved(5_000)).toMatchObject({ swept: 1, settled: 0, failed: 0 });
      await fixture.cp.conversation.reconcileUnresolved(5_000);

      expect(lifecycle(fixture, turn.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
      expect(observationCount(fixture, turn.turnRequestId)).toBe(0);
      expect(lookupFailures(fixture)).toEqual([{
        reasonCode: "CONVERSATION_TURN_RECEIPT_LOOKUP_FAILED",
        actor: turn.targetActorId,
        evidence: {
          turnRequestId: turn.turnRequestId,
          sourceNonce: "update:417",
          kind: "HTTP_STATUS",
          detail: "409:canonical_receipt_unprovable",
        },
      }]);
      const found = await inDoubtFinding(fixture);
      expect((found?.observedEvidence["oldest"] as Record<string, unknown>)["lookupError"])
        .toMatchObject({ kind: "HTTP_STATUS", detail: "409:canonical_receipt_unprovable" });
    } finally {
      fixture.cp.close();
    }
  });

  it("W13: the production NEVER_FOUND and PENDING are plain not-found with an integer update_id, and SCHEMA/update_id-type with a string one (R1074-03)", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 413);
      for (const [name, answer] of [
        ["NEVER_FOUND", { kind: "json", body: gatewayNeverFound(413) }],
        ["PENDING", { kind: "json", body: gatewayPending(413, turn) }],
      ] as Array<[string, GatewayAnswer]>) {
        answering(() => answer);
        expect(await fixture.cp.conversation.reconcileUnresolved(5_000), name).toMatchObject({ swept: 1, settled: 0, failed: 0 });
        expect(lookupFailures(fixture), name).toEqual([]);
      }
      const found = await inDoubtFinding(fixture);
      expect(found?.observedEvidence["lookupErrors"]).toBeUndefined();
      expect((found?.observedEvidence["oldest"] as Record<string, unknown>)["lookupError"]).toBeUndefined();
      expect(found?.recommendedAction).not.toContain("lookup error");

      // The same answers with update_id as its decimal string are not read as answers at all.
      for (const answer of [
        { kind: "json", body: gatewayNeverFound(413, "string") },
        { kind: "json", body: gatewayPending(413, turn, "string") },
      ] as GatewayAnswer[]) {
        answering(() => answer);
        await fixture.cp.conversation.reconcileUnresolved(5_000);
      }
      expect(gateway.requests).toHaveLength(4);
      expect(lookupFailures(fixture).map((row) => row.evidence)).toEqual([
        { turnRequestId: turn.turnRequestId, sourceNonce: "update:413", kind: "SCHEMA", detail: "update_id-type" },
      ]);
      expect(lifecycle(fixture, turn.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
      expect(observationCount(fixture, turn.turnRequestId)).toBe(0);
    } finally {
      fixture.cp.close();
    }
  });

  it("W14: a production ABORTED receipt with no receiptId or evidenceDigest is a visible SCHEMA/receiptId and settles nothing", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 414);
      // The parser is unchanged: an ABORTED without its receipt id is not read as a receipt (a CEO
      // decision, separate from #1036). What changes is that the refusal is visible. The reason is
      // Hermes' own token, not an ACP reason code.
      const hermesReason = "RECEIPT_UNREADABLE";
      answering((updateId) => ({
        kind: "json",
        body: {
          ...gatewayReceipt(updateId, turn, { status: "ABORTED", reasonCode: hermesReason }),
          receiptId: null,
          evidenceDigest: null,
        },
      }));
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);

      expect(swept).toMatchObject({ swept: 1, settled: 0, failed: 0 });
      expect(lifecycle(fixture, turn.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
      expect(observationCount(fixture, turn.turnRequestId)).toBe(0);
      expect(lookupFailures(fixture).map((row) => row.evidence)).toEqual([
        { turnRequestId: turn.turnRequestId, sourceNonce: "update:414", kind: "SCHEMA", detail: "receiptId" },
      ]);
    } finally {
      fixture.cp.close();
    }
  });

  it("W6: one row per distinct cause per turn, however often it recurs, before or after a restart (R1074-01)", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 406);
      const stringId = (updateId: number): GatewayAnswer =>
        ({ kind: "json", body: { ...gatewayReceipt(updateId, turn), update_id: String(updateId) } });
      const status = (code: number) => (updateId: number): GatewayAnswer =>
        ({ kind: "json", status: code, body: gatewayReceipt(updateId, turn) });
      const causes = () => lookupFailures(fixture).map((row) => `${String(row.evidence["kind"])}/${String(row.evidence["detail"])}`);
      answering(stringId);
      for (let sweep = 0; sweep < 4; sweep += 1) await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(gateway.requests).toHaveLength(4);
      expect(causes()).toEqual(["SCHEMA/update_id-type"]);

      answering(status(500));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      // The same kind with a different detail is a different cause.
      answering(status(503));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(causes()).toEqual(["SCHEMA/update_id-type", "HTTP_STATUS/500", "HTTP_STATUS/503"]);

      // A cause that returns after others is not recorded again: it is not the latest, and still known.
      answering(stringId);
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      answering(status(500));
      await fixture.cp.conversation.reconcileUnresolved(5_000);

      // Nor after a restart, which keeps no memory of its own: the record set is the memory.
      fixture.cp.close();
      fixture.cp = fixture.open();
      for (const answer of [stringId, status(500), status(503)]) {
        answering(answer);
        await fixture.cp.conversation.reconcileUnresolved(5_000);
      }
      expect(causes()).toEqual(["SCHEMA/update_id-type", "HTTP_STATUS/500", "HTTP_STATUS/503"]);
      expect(lifecycle(fixture, turn.turnRequestId).lifecycle_state).toBe("IN_DOUBT");

      // Doctor names the most recently recorded cause.
      const found = await inDoubtFinding(fixture);
      expect((found?.observedEvidence["oldest"] as Record<string, unknown>)["lookupError"])
        .toMatchObject({ kind: "HTTP_STATUS", detail: "503" });
    } finally {
      fixture.cp.close();
    }
  });

  it("W15: no header or body text from the network reaches audit or doctor, and a cause that would redact is recorded once (R1074-02)", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 415);
      const secretLike = [`application/${GATEWAY_KEY}`, `application/sk-${"a".repeat(20)}`];
      for (const contentType of secretLike) {
        answering((updateId) => ({ kind: "json", body: gatewayReceipt(updateId, turn), contentType }));
        for (let sweep = 0; sweep < 3; sweep += 1) await fixture.cp.conversation.reconcileUnresolved(5_000);
      }
      answering((updateId) => ({ kind: "json", status: 503, body: { error: GATEWAY_KEY, at: updateId } }));
      for (let sweep = 0; sweep < 3; sweep += 1) await fixture.cp.conversation.reconcileUnresolved(5_000);

      expect(lookupFailures(fixture).map((row) => row.evidence)).toEqual([
        { turnRequestId: turn.turnRequestId, sourceNonce: "update:415", kind: "CONTENT_TYPE", detail: "other" },
        { turnRequestId: turn.turnRequestId, sourceNonce: "update:415", kind: "HTTP_STATUS", detail: "503:other" },
      ]);
      const finding = await inDoubtFinding(fixture);
      expect(finding?.observedEvidence["lookupErrors"]).toBeDefined();
      const leaked = (text: string) => text.includes(GATEWAY_KEY) || text.includes("sk-aaaa");
      expect({
        audit: leaked(JSON.stringify(fixture.cp.audit.byKind(CANONICAL_TURN_RECEIPT_LOOKUP_FAILED))),
        doctor: leaked(JSON.stringify(finding)),
      }).toEqual({ audit: false, doctor: false });
      expect(lifecycle(fixture, turn.turnRequestId).lifecycle_state).toBe("IN_DOUBT");
    } finally {
      fixture.cp.close();
    }
  });

  it("W16: every cause the vocabulary admits is stored exactly as written, so the comparison sees what was written", () => {
    const members = [
      ...Object.entries(RECEIPT_LOOKUP_DETAILS).flatMap(([kind, details]) => [...details].map((detail) => ({ kind, detail }))),
      ...Array.from({ length: 500 }, (_, index) => 100 + index).flatMap((code) =>
        ["", ...RECEIPT_LOOKUP_HTTP_ERRORS.map((token) => `:${token}`), ":other"]
          .map((suffix) => ({ kind: "HTTP_STATUS", detail: `${code}${suffix}` }))),
      { kind: "UNRECOGNIZED", detail: "other" },
    ];
    for (const member of members) {
      expect(receiptLookupCause(member), JSON.stringify(member)).toEqual(member);
      const evidence = { turnRequestId: "tr_x", sourceNonce: "update:1", ...member };
      expect(redact(evidence), JSON.stringify(member)).toEqual(evidence);
    }
    expect(members.length).toBeGreaterThan(3_000);
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
      // A one-key status is not the Gateway's answer, whatever the status.
      [{ status: "NEVER_FOUND" }, "missing-key:delivery"],
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
      // The production ABORTED carries no receipt id or evidence digest; read as before, and named.
      [{ ...gatewayReceipt(80, turn, { status: "ABORTED" }), receiptId: null, evidenceDigest: null }, "receiptId"],
      [{ ...gatewayReceipt(80, turn, { status: "ABORTED" }), update_id: "80", receiptId: null }, "update_id-type"],
      // A non-terminal answer names its update as the integer, exactly as a terminal one must (R1074-03).
      [gatewayNeverFound(80, "string"), "update_id-type"],
      [gatewayPending(80, turn, "string"), "update_id-type"],
      [gatewayNeverFound(81, "string"), "update_id-type"],
      [gatewayNeverFound(81), "update_id-mismatch"],
      [{ ...gatewayNeverFound(80), update_id: "8O" }, "update_id-type"],
      [{ ...gatewayNeverFound(80), update_id: 80.5 }, "update_id-type"],
      [{ ...gatewayNeverFound(80), update_id: null }, "update_id-type"],
      [{ ...gatewayNeverFound(80), message_id: 180 }, "never-found-field:message_id"],
      [{ ...gatewayNeverFound(80), turnRequestId: turn.turnRequestId }, "never-found-field:turnRequestId"],
      [{ ...gatewayNeverFound(80), receiptIdentity: { ...turn } }, "never-found-field:receiptIdentity"],
      [{ ...gatewayNeverFound(80), receiptId: "hermes-tg:obligation-80" }, "never-found-field:receiptId"],
      [{ ...gatewayNeverFound(80), evidenceDigest: digestOf("x") }, "never-found-field:evidenceDigest"],
      [{ ...gatewayNeverFound(80), reasonCode: "OK" }, "never-found-field:reasonCode"],
      [{ ...gatewayNeverFound(80), delivery: gatewayDelivery(80) }, "never-found-field:delivery"],
      [{ ...gatewayNeverFound(80), content: "" }, "never-found-field:content"],
      [gatewayPending(81, turn), "update_id-mismatch"],
      [{ ...gatewayPending(80, turn), message_id: "180" }, "message_id-type"],
      [{ ...gatewayPending(80, turn), message_id: 0 }, "message_id-range"],
      [{ ...gatewayPending(80, turn), receiptIdentity: null }, "identity-keys"],
      [{ ...gatewayPending(80, turn), receiptIdentity: { ...turn, promptDigest: "sha256:short" } }, "identity-field:promptDigest"],
      [{ ...gatewayPending(80, turn), turnRequestId: "tr_other" }, "turnRequestId-mismatch"],
      [{ ...gatewayPending(80, turn), receiptId: "hermes-tg:obligation-80" }, "pending-field:receiptId"],
      [{ ...gatewayPending(80, turn), evidenceDigest: digestOf("x") }, "pending-field:evidenceDigest"],
      [{ ...gatewayPending(80, turn), reasonCode: "OK" }, "pending-field:reasonCode"],
      [{ ...gatewayPending(80, turn), delivery: gatewayDelivery(80) }, "pending-field:delivery"],
      [{ ...gatewayPending(80, turn), content: "" }, "pending-field:content"],
    ];
    for (const [body, detail] of cases) {
      answering(() => ({ kind: "json", body }));
      await expect(ask(), detail).resolves.toEqual(schema(detail));
      // Every check the port names is one the coordinator will write as it is.
      expect(receiptLookupCause({ kind: "SCHEMA", detail }), detail).toEqual({ kind: "SCHEMA", detail });
    }
    // The control: the unaltered answer is a receipt.
    answering(() => ({ kind: "json", body: valid() }));
    await expect(ask()).resolves.toMatchObject({ found: true, outcome: "COMPLETED" });
  });

  it("W11: a transport, status, type, size or parse failure names its cause, and only NEVER_FOUND or PENDING does not", async () => {
    const status = (code: number, detail: string): unknown => ({ kind: "HTTP_STATUS", detail: `${code}${detail}` });
    const cases: Array<[string, GatewayAnswer, unknown]> = [
      ["500", { kind: "json", status: 500, body: valid() }, status(500, "")],
      ["401", { kind: "json", status: 401, body: {} }, status(401, "")],
      ["401 unauthorized", { kind: "json", status: 401, body: { error: "unauthorized" } }, status(401, ":unauthorized")],
      ["401 as text", { kind: "raw", status: 401, body: "Unauthorized", contentType: "text/plain" }, status(401, "")],
      // The production Gateway's error answers name their cause in `error`.
      ["404 binding unknown", { kind: "json", status: 404, body: { error: "canonical_binding_unknown" } }, status(404, ":canonical_binding_unknown")],
      ["400", { kind: "json", status: 400, body: { error: "canonical_invalid_request" } }, status(400, ":canonical_invalid_request")],
      ["409", { kind: "json", status: 409, body: { error: "canonical_event_uncertain" } }, status(409, ":canonical_event_uncertain")],
      ["409 unprovable", { kind: "json", status: 409, body: { error: "canonical_receipt_unprovable" } }, status(409, ":canonical_receipt_unprovable")],
      ["503", { kind: "json", status: 503, body: { error: "canonical_unavailable" } }, status(503, ":canonical_unavailable")],
      ["404 as html", { kind: "raw", status: 404, body: "<h1>no</h1>", contentType: "text/html" }, status(404, "")],
      // Only the known error tokens are carried; any other error, token-shaped or not, is `other`.
      ["unknown error token", { kind: "json", status: 503, body: { error: "canonical_something_new" } }, status(503, ":other")],
      ["error carrying the key", { kind: "json", status: 401, body: { error: GATEWAY_KEY } }, status(401, ":other")],
      ["error that is not a token", { kind: "json", status: 503, body: { error: "the gateway said: no" } }, status(503, ":other")],
      ["error that is not a string", { kind: "json", status: 503, body: { error: { code: "x" } } }, status(503, ":other")],
      ["error inherited, not named", { kind: "json", status: 503, body: { message: "canonical_unavailable" } }, status(503, "")],
      ["error body over 4KB", { kind: "json", status: 503, body: { error: "canonical_unavailable", pad: "x".repeat(5_000) } }, status(503, "")],
      ["error body not json", { kind: "raw", status: 503, body: "{\"error\":" }, status(503, "")],
      // A media type is named by category, never by its text.
      ["text/plain", { kind: "json", body: valid(), contentType: "text/plain" }, { kind: "CONTENT_TYPE", detail: "text" }],
      ["text/html", { kind: "json", body: valid(), contentType: "text/html; charset=utf-8" }, { kind: "CONTENT_TYPE", detail: "html" }],
      ["odd type", { kind: "json", body: valid(), contentType: "application/json(x)" }, { kind: "CONTENT_TYPE", detail: "other" }],
      ["key as a subtype", { kind: "json", body: valid(), contentType: `application/${GATEWAY_KEY}` }, { kind: "CONTENT_TYPE", detail: "other" }],
      ["no type", { kind: "json", body: valid(), contentType: "" }, { kind: "CONTENT_TYPE", detail: "missing" }],
      ["streamed over 4KB", { kind: "json", body: { ...valid(), content: "x".repeat(5_000) } }, { kind: "TOO_LARGE", detail: "body" }],
      ["not json", { kind: "raw", body: "{not json" }, { kind: "PARSE", detail: "invalid-json" }],
    ];
    for (const [name, answer, lookupError] of cases) {
      answering(() => answer);
      await expect(ask(), name).resolves.toEqual({ found: false, lookupError });
      expect(receiptLookupCause(lookupError as { kind: string; detail: string }), name).toEqual(lookupError);
    }

    // Answers that are not failures: Hermes holds no receipt, or holds one that is not terminal yet.
    const plain: Array<[string, GatewayAnswer]> = [
      ["NEVER_FOUND", { kind: "json", body: gatewayNeverFound(80) }],
      ["PENDING", { kind: "json", body: gatewayPending(80, turn) }],
      ["PENDING, no message id", { kind: "json", body: { ...gatewayPending(80, turn), message_id: null } }],
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

    // A peer that resets the connection, and one that does not speak HTTP: a code outside the
    // known set is `other`, never the parser's own text.
    for (const [name, reply, detail] of [
      ["reset", (socket: Socket) => socket.resetAndDestroy(), "ECONNRESET"],
      ["not http", (socket: Socket) => socket.end("NOT HTTP AT ALL\r\n\r\n"), "other"],
    ] as const) {
      const raw = createNetServer((socket) => socket.once("data", () => reply(socket)));
      await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
      try {
        await expect(ask((raw.address() as AddressInfo).port), name)
          .resolves.toEqual({ found: false, lookupError: { kind: "TRANSPORT", detail } });
      } finally {
        await new Promise<void>((resolve) => raw.close(() => resolve()));
      }
    }

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
    await expect(ask()).resolves.toEqual({ found: false, lookupError: { kind: "TIMEOUT", detail: "no-answer" } });
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
