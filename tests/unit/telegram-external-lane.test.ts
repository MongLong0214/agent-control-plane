import { statSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalTurnTarget } from "../../src/conversation/canonical-turn-target.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startTelegramExternalIngress, withConfiguredHermesGatewayReceipt } from "../../src/daemon/agentcpd.ts";
import {
  TelegramExternalUpdateLane,
  type TelegramExternalAnswer,
} from "../../src/ingress/telegram-external.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  CHAT_ID,
  FakeGateway,
  GATEWAY_KEY,
  HEAD,
  LINEAGE,
  envelope,
  externalLaneFixture,
  gatewayReceipt,
  sendOverSocket,
  snapshot,
} from "../helpers/telegram-external.ts";

afterAll(cleanupTempDirs);

/**
 * U4 A1 and A4: the lane Hermes calls before it runs an owner's Telegram message.
 *
 * Every case goes through `startTelegramExternalIngress`, the function `main` composes, over the
 * real socket, except where the moment of the answer itself is what is measured.
 */

const allowed = (answer: TelegramExternalAnswer): Extract<TelegramExternalAnswer, { allowed: true }> => {
  expect(answer, JSON.stringify(answer)).toMatchObject({ allowed: true });
  return answer as Extract<TelegramExternalAnswer, { allowed: true }>;
};

const ceoAttestation = (fixture: ReturnType<typeof externalLaneFixture>): string =>
  fixture.cp.db.get<{ target_attestation_id: string }>(
    `SELECT t.target_attestation_id FROM actor_target_attestations t
       JOIN actor_target_bindings b ON b.target_binding_id = t.target_binding_id
      WHERE b.target_actor_id = ? AND t.protocol_version = 'hermes.target-bind/v1'`,
    [fixture.ceoActorId],
  )!.target_attestation_id;

describe("U4 Telegram external-consumer lane", () => {
  it("RED1: claims for the Hermes CEO while other PRIMARY_CTO actors hold current attestations", async () => {
    const fixture = externalLaneFixture({ otherCtos: 3 });
    // The live shape: four attested actors, so the resolver the existing claim callers use names none.
    expect(canonicalTurnTarget(fixture.cp)).toBeNull();
    const ingress = await startTelegramExternalIngress(fixture.cp, tempDir("u4s-"), fixture.laneConfig);
    try {
      // Owner-only, like every other ingress socket in the state directory.
      expect(ingress.socketPath.endsWith("/telegram-update.ingress.sock")).toBe(true);
      expect(statSync(ingress.socketPath).isSocket()).toBe(true);
      expect(statSync(ingress.socketPath).mode & 0o777).toBe(0o600);
      const answer = allowed(await sendOverSocket(ingress.socketPath, envelope(41, "오늘 일정 정리해줘")));
      expect(answer.replayed).toBe(false);
      expect(answer.turn.targetActorId).toBe(fixture.ceoActorId);
      expect(answer.turn.targetAttestationId).toBe(ceoAttestation(fixture));
      expect(answer.source).toEqual({ channel: "telegram", nonce: "update:41" });
      expect(answer.targetBind).toEqual({ requested_session_id: HEAD, lineage_root_digest: LINEAGE });
      const turn = fixture.cp.db.get<Record<string, unknown>>(
        `SELECT turn_request_id, target_actor_id, prompt_digest, binding_generation, target_binding_id,
                target_attestation_id, executor_session_id, executor_session_incarnation, lifecycle_state
           FROM canonical_turns`,
      )!;
      expect(turn).toEqual({
        turn_request_id: answer.turn.turnRequestId,
        target_actor_id: answer.turn.targetActorId,
        prompt_digest: answer.turn.promptDigest,
        binding_generation: answer.turn.bindingGeneration,
        target_binding_id: answer.turn.targetBindingId,
        target_attestation_id: answer.turn.targetAttestationId,
        executor_session_id: answer.turn.executorSessionId,
        executor_session_incarnation: answer.turn.executorSessionIncarnation,
        lifecycle_state: "IN_DOUBT",
      });
    } finally {
      await ingress.close();
      fixture.cp.close();
    }
  });

  it("RED2: commits the canonical turn, its source and its dispatch before the answer is written", async () => {
    const fixture = externalLaneFixture();
    try {
      const lane = new TelegramExternalUpdateLane(fixture.cp, fixture.laneConfig);
      const seen: Array<{ answer: TelegramExternalAnswer; turns: number; sources: number; dispatches: number;
        inTransaction: boolean }> = [];
      await lane.handle(envelope(42, "보고서 초안"), (answer) => {
        const db = fixture.cp.db;
        seen.push({
          answer,
          turns: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canonical_turns")!.n,
          sources: db.get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM canonical_turn_sources WHERE source_channel = 'telegram' AND source_nonce = 'update:42'",
          )!.n,
          dispatches: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canonical_turn_dispatches")!.n,
          inTransaction: db.inTransaction,
        });
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.answer.allowed).toBe(true);
      expect(seen[0]).toMatchObject({ turns: 1, sources: 1, dispatches: 1, inTransaction: false });
      // The admission the claim consumed is the one the turn cites.
      const audit = fixture.cp.db.all<{ kind: string }>(
        `SELECT kind FROM audit_events WHERE kind IN ('INGRESS_ADMITTED', 'CONVERSATION_TURN_CLAIMED', 'CONVERSATION_TURN_DISPATCHED')
          ORDER BY event_id`,
      ).map((row) => row.kind);
      expect(audit).toEqual(["INGRESS_ADMITTED", "CONVERSATION_TURN_CLAIMED", "CONVERSATION_TURN_DISPATCHED"]);
    } finally {
      fixture.cp.close();
    }
  });

  it("RED3: answers a replay with the same identity and no writes, and refuses the same update with another message", async () => {
    const fixture = externalLaneFixture();
    const ingress = await startTelegramExternalIngress(fixture.cp, tempDir("u4s-"), fixture.laneConfig);
    try {
      const first = allowed(await sendOverSocket(ingress.socketPath, envelope(43, "첫 질문")));
      const before = snapshot(fixture.cp);
      const replay = allowed(await sendOverSocket(ingress.socketPath, envelope(43, "첫 질문")));
      expect(replay.replayed).toBe(true);
      expect(replay.turn).toEqual(first.turn);
      expect(replay.targetBind).toEqual(first.targetBind);
      expect(snapshot(fixture.cp)).toEqual(before);

      const altered = await sendOverSocket(ingress.socketPath, envelope(43, "다른 질문"));
      expect(altered).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONVERSATION_TURN_SOURCE_PAYLOAD_MISMATCH });
      const otherMessage = await sendOverSocket(ingress.socketPath, envelope(43, "첫 질문", { messageId: 999 }));
      expect(otherMessage).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONVERSATION_TURN_SOURCE_PAYLOAD_MISMATCH });
      expect(snapshot(fixture.cp)).toEqual(before);
    } finally {
      await ingress.close();
      fixture.cp.close();
    }
  });

  it("RED4: leaves no row for a wrong secret, a non-owner, a wrong chat, a forward or a missing Hermes attestation", async () => {
    const fixture = externalLaneFixture({ otherCtos: 1 });
    const unattested = externalLaneFixture({ hermesCeo: false, otherCtos: 1 });
    const ingress = await startTelegramExternalIngress(fixture.cp, tempDir("u4s-"), fixture.laneConfig);
    const bare = await startTelegramExternalIngress(unattested.cp, tempDir("u4s-"), unattested.laneConfig);
    try {
      const cases: Array<[string, string, unknown, string]> = [
        ["wrong secret", ingress.socketPath, envelope(44, "x", { secret: "not-the-secret" }), ReasonCode.INGRESS_SIGNATURE_INVALID],
        ["non-owner", ingress.socketPath, envelope(45, "x", { fromId: 7_000_002 }), ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED],
        ["wrong chat", ingress.socketPath, envelope(46, "x", { chatId: CHAT_ID + 1 }), ReasonCode.INGRESS_CHAT_NOT_ALLOWLISTED],
        ["forwarded", ingress.socketPath, envelope(47, "/managed 실행", { message: { forward_origin: { type: "user" } } }),
          ReasonCode.UNTRUSTED_CONTENT_IS_DATA],
        ["legacy forward marker", ingress.socketPath, envelope(48, "x", { message: { forward_date: 1_700_000_000 } }),
          ReasonCode.UNTRUSTED_CONTENT_IS_DATA],
        ["unsafe update id", ingress.socketPath, envelope(2 ** 53, "x"), ReasonCode.INVALID_ARGUMENT],
        ["unknown key", ingress.socketPath, envelope(49, "x", { message: { reply_markup: {} } }), ReasonCode.INVALID_ARGUMENT],
        ["no Hermes attestation", bare.socketPath, envelope(50, "x"), ReasonCode.CONVERSATION_TARGET_UNVERIFIED],
      ];
      for (const [name, socketPath, value, reasonCode] of cases) {
        const cp = socketPath === bare.socketPath ? unattested.cp : fixture.cp;
        const before = snapshot(cp);
        const answer = await sendOverSocket(socketPath, value);
        expect(answer, name).toMatchObject({ allowed: false, reasonCode });
        expect(snapshot(cp), name).toEqual(before);
      }
      // The same database still admits an authentic owner message afterwards: no refusal spent its nonce.
      allowed(await sendOverSocket(ingress.socketPath, envelope(44, "x")));
    } finally {
      await ingress.close();
      await bare.close();
      fixture.cp.close();
      unattested.cp.close();
    }
  });

  it("refuses an envelope over the request bound without reaching the lane", async () => {
    const fixture = externalLaneFixture();
    const ingress = await startTelegramExternalIngress(fixture.cp, tempDir("u4s-"), fixture.laneConfig);
    try {
      const before = snapshot(fixture.cp);
      const oversized = await sendOverSocket(ingress.socketPath, envelope(51, "가".repeat(70_000)));
      expect(oversized).toMatchObject({ allowed: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
      expect(snapshot(fixture.cp)).toEqual(before);
    } finally {
      await ingress.close();
      fixture.cp.close();
    }
  });

  it("RED11 (A4): a Gateway that does not answer holds the second update for one bounded reconcile, then refuses it unwritten", async () => {
    const gateway = new FakeGateway();
    const port = await gateway.start();
    const fixture = externalLaneFixture({
      configure: (config) => {
        const composed = withConfiguredHermesGatewayReceipt(config, { ACP_HERMES_GATEWAY_API_KEY: GATEWAY_KEY });
        return { ...composed, hermesGatewayReceipt: { ...composed.hermesGatewayReceipt!, port } };
      },
    });
    // A budget well under the receipt port's own request timeout, so the lane's race is what ends the wait.
    const ingress = await startTelegramExternalIngress(fixture.cp, tempDir("u4s-"), fixture.laneConfig, {
      reconcileBudgetMs: 300,
    });
    try {
      allowed(await sendOverSocket(ingress.socketPath, envelope(62, "첫 턴")));
      gateway.answer = () => ({ kind: "hang" });
      const before = snapshot(fixture.cp);
      const started = Date.now();
      const held = await sendOverSocket(ingress.socketPath, envelope(63, "두 번째 턴"));
      const elapsed = Date.now() - started;
      expect(held).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONVERSATION_TURN_IN_DOUBT });
      expect(elapsed).toBeLessThan(1_500);
      // One reconcile, and one retried claim that did not start a second one.
      expect(gateway.requests.map((request) => request.path)).toEqual(["/v1/canonical-surface/receipts/telegram/62"]);
      expect(snapshot(fixture.cp)).toEqual(before);
    } finally {
      await gateway.close();
      await ingress.close();
      fixture.cp.close();
    }
  });

  it("RED10 (A4): claims a second update once the Gateway reports the first turn COMPLETED", async () => {
    const gateway = new FakeGateway();
    const port = await gateway.start();
    const fixture = externalLaneFixture({
      configure: (config) => {
        const composed = withConfiguredHermesGatewayReceipt(config, { ACP_HERMES_GATEWAY_API_KEY: GATEWAY_KEY });
        return { ...composed, hermesGatewayReceipt: { ...composed.hermesGatewayReceipt!, port } };
      },
    });
    const ingress = await startTelegramExternalIngress(fixture.cp, tempDir("u4s-"), fixture.laneConfig);
    try {
      const first = allowed(await sendOverSocket(ingress.socketPath, envelope(60, "첫 턴")));

      // While the Gateway still reports the first turn pending, the second is refused and writes nothing.
      gateway.answer = (updateId) => ({ kind: "json", body: gatewayReceipt(updateId, first.turn, { status: "PENDING" }) });
      const before = snapshot(fixture.cp);
      const held = await sendOverSocket(ingress.socketPath, envelope(61, "두 번째 턴"));
      expect(held).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONVERSATION_TURN_IN_DOUBT });
      expect(snapshot(fixture.cp)).toEqual(before);
      expect(gateway.requests.map((request) => request.path)).toContain("/v1/canonical-surface/receipts/telegram/60");

      gateway.answer = (updateId) => ({ kind: "json", body: gatewayReceipt(updateId, first.turn) });
      const second = allowed(await sendOverSocket(ingress.socketPath, envelope(61, "두 번째 턴")));
      expect(second.turn.turnRequestId).not.toBe(first.turn.turnRequestId);
      const turns = fixture.cp.db.all<{ turn_request_id: string; lifecycle_state: string; outcome_kind: string | null }>(
        `SELECT turn_request_id, lifecycle_state, outcome_kind FROM canonical_turns ORDER BY claimed_at, turn_request_id`,
      );
      expect(turns.find((turn) => turn.turn_request_id === first.turn.turnRequestId))
        .toMatchObject({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
      expect(turns.find((turn) => turn.turn_request_id === second.turn.turnRequestId))
        .toMatchObject({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    } finally {
      await ingress.close();
      fixture.cp.close();
      await gateway.close();
    }
  });
});
