import { statSync } from "node:fs";

import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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
  crashImage,
  envelope,
  externalLaneFixture,
  gatewayNeverFound,
  gatewayPending,
  gatewayReceipt,
  replaceHermesCeo,
  sendOverSocket,
  snapshot,
} from "../helpers/telegram-external.ts";

afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
});

const DISPATCH_INSERT = /INSERT INTO canonical_turn_dispatches/;
const DAY_AND_AN_HOUR_MS = 25 * 60 * 60 * 1000;

/** Runs `observe` on the database handle at the instant the dispatch row is about to be written. */
const atDispatchWrite = (db: ExternalLaneFixtureDb, observe: () => void): void => {
  const run = db.run.bind(db);
  vi.spyOn(db, "run").mockImplementation((sql: string, params?: unknown[]) => {
    if (DISPATCH_INSERT.test(sql)) observe();
    return run(sql, params);
  });
};
type ExternalLaneFixtureDb = ReturnType<typeof externalLaneFixture>["cp"]["db"];

/** What a second connection, the way another process would, reads from the file right now. */
const committedView = (file: string, nonce: string): Record<string, number> => {
  const reader = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const count = (sql: string, params: unknown[] = []): number =>
      (reader.prepare(sql).get(...params) as { n: number }).n;
    return {
      inbound: count("SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?", [nonce]),
      admitted: count(
        `SELECT COUNT(*) AS n FROM audit_events
          WHERE kind = 'INGRESS_ADMITTED' AND json_extract(evidence_json, '$.nonce') = ?`,
        [nonce],
      ),
      turns: count("SELECT COUNT(*) AS n FROM canonical_turns"),
      sources: count("SELECT COUNT(*) AS n FROM canonical_turn_sources WHERE source_nonce = ?", [nonce]),
    };
  } finally {
    reader.close();
  }
};

/** Makes every dispatch insert fail until the returned function is called. */
const failDispatchWrites = (file: string): (() => void) => {
  const raw = new Database(file);
  try {
    raw.exec(`
      CREATE TRIGGER inject_dispatch_failure
      BEFORE INSERT ON canonical_turn_dispatches
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_DISPATCH_FAILURE');
      END;
    `);
  } finally {
    raw.close();
  }
  return () => {
    const again = new Database(file);
    try {
      again.exec("DROP TRIGGER inject_dispatch_failure");
    } finally {
      again.close();
    }
  };
};

const rowsFor = (db: ExternalLaneFixtureDb, nonce: string): Record<string, number> => ({
  inbound: db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?",
    [nonce],
  )!.n,
  sources: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canonical_turn_sources WHERE source_nonce = ?", [nonce])!.n,
  dispatches: db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM canonical_turn_dispatches d
       JOIN canonical_turn_sources s ON s.turn_request_id = d.turn_request_id
      WHERE s.source_nonce = ?`,
    [nonce],
  )!.n,
});

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

  it("RED2: admits, claims and dispatches in one transaction, and writes the answer only after it commits", async () => {
    const fixture = externalLaneFixture();
    try {
      const lane = new TelegramExternalUpdateLane(fixture.cp, fixture.laneConfig);
      // R1062-01. Counting committed rows when the answer goes out cannot tell one transaction from
      // two: both have committed by then. Another connection reading at the instant the dispatch
      // row is written can. With one transaction it sees nothing of this update yet.
      const atDispatch: Array<Record<string, number>> = [];
      atDispatchWrite(fixture.cp.db, () => atDispatch.push(committedView(fixture.cp.db.file, "update:42")));
      const seen: Array<{ answer: TelegramExternalAnswer; committed: Record<string, number>; dispatches: number;
        inTransaction: boolean }> = [];
      await lane.handle(envelope(42, "보고서 초안"), (answer) => {
        const db = fixture.cp.db;
        seen.push({
          answer,
          committed: committedView(db.file, "update:42"),
          dispatches: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canonical_turn_dispatches")!.n,
          inTransaction: db.inTransaction,
        });
      });
      expect(atDispatch).toEqual([{ inbound: 0, admitted: 0, turns: 0, sources: 0 }]);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.answer.allowed).toBe(true);
      expect(seen[0]).toMatchObject({
        committed: { inbound: 1, admitted: 1, turns: 1, sources: 1 },
        dispatches: 1,
        inTransaction: false,
      });
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

  it("R1062-01: a dispatch write that fails takes the admission and the claim back with it, and the same update is then claimed as new", async () => {
    const fixture = externalLaneFixture();
    const ingress = await startTelegramExternalIngress(fixture.cp, tempDir("u4s-"), fixture.laneConfig);
    try {
      const restore = failDispatchWrites(fixture.cp.db.file);
      const before = snapshot(fixture.cp);
      const failed = await sendOverSocket(ingress.socketPath, envelope(70, "디스패치 실패"));
      expect(failed).toMatchObject({ allowed: false });
      expect(JSON.stringify(failed)).toContain("INJECTED_DISPATCH_FAILURE");
      // Not one row of the admission, the claim or their audit survived: the nonce is not spent.
      expect(snapshot(fixture.cp)).toEqual(before);

      restore();
      const retried = allowed(await sendOverSocket(ingress.socketPath, envelope(70, "디스패치 실패")));
      expect(retried.replayed).toBe(false);
      expect(rowsFor(fixture.cp.db, "update:70")).toEqual({ inbound: 1, sources: 1, dispatches: 1 });
    } finally {
      await ingress.close();
      fixture.cp.close();
    }
  });

  it("R1062-01 restart: a process killed at the dispatch write leaves nothing behind, and one killed after the commit leaves the answer to replay", async () => {
    const fixture = externalLaneFixture();
    const opened: Array<{ close(): void }> = [fixture.cp];
    try {
      const lane = new TelegramExternalUpdateLane(fixture.cp, fixture.laneConfig);
      // Killed at the instant the dispatch row is written: the files as they are then.
      let atDispatch: string | null = null;
      atDispatchWrite(fixture.cp.db, () => {
        atDispatch ??= crashImage(fixture);
      });
      // Killed after the commit, before the answer reached Hermes.
      let afterCommit: string | null = null;
      let lost: TelegramExternalAnswer | null = null;
      await lane.handle(envelope(71, "재시작 경계"), (answer) => {
        afterCommit = crashImage(fixture);
        lost = answer;
      });
      const original = allowed(lost!);
      vi.restoreAllMocks();
      opened.shift()!.close();

      // Restarted from the first image, Hermes's identical retry is a first claim, not an unknown outcome.
      const early = fixture.open(atDispatch!);
      opened.push(early);
      expect(rowsFor(early.db, "update:71")).toEqual({ inbound: 0, sources: 0, dispatches: 0 });
      const earlyIngress = await startTelegramExternalIngress(early, tempDir("u4s-"), fixture.laneConfig);
      try {
        const fresh = allowed(await sendOverSocket(earlyIngress.socketPath, envelope(71, "재시작 경계")));
        expect(fresh.replayed).toBe(false);
        expect(rowsFor(early.db, "update:71")).toEqual({ inbound: 1, sources: 1, dispatches: 1 });
      } finally {
        await earlyIngress.close();
      }

      // Restarted from the second, the retry is answered with the turn the lost answer named.
      const late = fixture.open(afterCommit!);
      opened.push(late);
      expect(rowsFor(late.db, "update:71")).toEqual({ inbound: 1, sources: 1, dispatches: 1 });
      const lateIngress = await startTelegramExternalIngress(late, tempDir("u4s-"), fixture.laneConfig);
      try {
        const before = snapshot(late);
        const replay = allowed(await sendOverSocket(lateIngress.socketPath, envelope(71, "재시작 경계")));
        expect(replay.replayed).toBe(true);
        expect(replay.turn).toEqual(original.turn);
        expect(snapshot(late)).toEqual(before);
      } finally {
        await lateIngress.close();
      }
    } finally {
      for (const handle of opened) handle.close();
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
      gateway.answer = (updateId) => ({ kind: "json", body: gatewayPending(updateId, first.turn) });
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

  it("R1062-02: answers a replay from the canonical source after ordinary ingress expiry pruned its admission", async () => {
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
      const first = allowed(await sendOverSocket(ingress.socketPath, envelope(50, "첫 턴")));
      gateway.answer = (updateId) =>
        updateId === 50
          ? { kind: "json", body: gatewayReceipt(50, first.turn, { status: "ABORTED" }) }
          : { kind: "json", body: gatewayNeverFound(updateId) };
      fixture.clock.advance(DAY_AND_AN_HOUR_MS);
      // A4 settles update 50 ABORTED; the admission of 51 then prunes 50's expired, settled ingress row.
      const second = allowed(await sendOverSocket(ingress.socketPath, envelope(51, "두 번째 턴")));
      expect(rowsFor(fixture.cp.db, "update:50")).toEqual({ inbound: 0, sources: 1, dispatches: 1 });
      gateway.answer = (updateId) =>
        ({ kind: "json", body: gatewayReceipt(updateId, updateId === 51 ? second.turn : first.turn, { status: "ABORTED" }) });
      await fixture.cp.conversation.reconcileUnresolved(3_000);
      expect(fixture.cp.db.all<{ lifecycle_state: string }>("SELECT lifecycle_state FROM canonical_turns")
        .map((row) => row.lifecycle_state)).toEqual(["SETTLED", "SETTLED"]);

      const before = snapshot(fixture.cp);
      const replay = allowed(await sendOverSocket(ingress.socketPath, envelope(50, "첫 턴")));
      expect(replay.replayed).toBe(true);
      expect(replay.turn).toEqual(first.turn);
      expect(replay.targetBind).toEqual(first.targetBind);
      expect(snapshot(fixture.cp)).toEqual(before);

      // Recognized only for the authenticated owner, and only for the same message.
      const cases: Array<[string, unknown, string]> = [
        ["wrong secret", envelope(50, "첫 턴", { secret: "not-the-secret" }), ReasonCode.INGRESS_SIGNATURE_INVALID],
        ["non-owner", envelope(50, "첫 턴", { fromId: 7_000_002 }), ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED],
        ["other text", envelope(50, "다른 질문"), ReasonCode.CONVERSATION_TURN_SOURCE_PAYLOAD_MISMATCH],
        ["other message", envelope(50, "첫 턴", { messageId: 999 }), ReasonCode.CONVERSATION_TURN_SOURCE_PAYLOAD_MISMATCH],
      ];
      for (const [name, value, reasonCode] of cases) {
        expect(await sendOverSocket(ingress.socketPath, value), name).toMatchObject({ allowed: false, reasonCode });
        expect(snapshot(fixture.cp), name).toEqual(before);
      }
    } finally {
      await ingress.close();
      fixture.cp.close();
      await gateway.close();
    }
  });

  it("R1062-02: keeps the ingress payload an unresolved turn's settlement needs after the CEO is replaced and the window passes", async () => {
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
      const first = allowed(await sendOverSocket(ingress.socketPath, envelope(50, "첫 턴")));
      gateway.answer = (updateId) =>
        updateId === 50
          ? { kind: "json", body: gatewayPending(50, first.turn) }
          : { kind: "json", body: gatewayNeverFound(updateId) };
      const replacement = replaceHermesCeo(fixture.cp, 1);
      expect(replacement).not.toBe(first.turn.targetActorId);
      fixture.clock.advance(DAY_AND_AN_HOUR_MS);

      // The replacement CEO's first turn: its admission runs the ingress expiry over update 50.
      const second = allowed(await sendOverSocket(ingress.socketPath, envelope(51, "새 CEO에게")));
      expect(second.turn.targetActorId).toBe(replacement);

      // The first turn's terminal receipt arrives late, and settles it with the owner's reply owed.
      gateway.answer = (updateId) =>
        updateId === 50
          ? { kind: "json", body: gatewayReceipt(50, first.turn) }
          : { kind: "json", body: gatewayPending(updateId, second.turn) };
      await fixture.cp.conversation.reconcileUnresolved(3_000);
      expect(fixture.cp.db.get<Record<string, unknown>>(
        "SELECT lifecycle_state, outcome_kind FROM canonical_turns WHERE turn_request_id = ?",
        [first.turn.turnRequestId],
      )).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
      expect(fixture.cp.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = 'owner-reply' AND nonce = ?",
        [first.turn.turnRequestId],
      )!.n).toBe(1);
      expect(rowsFor(fixture.cp.db, "update:50")).toEqual({ inbound: 1, sources: 1, dispatches: 1 });

      // Settled, the row is ordinary again, and the next admission past the window expires it.
      fixture.clock.advance(DAY_AND_AN_HOUR_MS);
      gateway.answer = (updateId) => ({ kind: "json", body: gatewayReceipt(updateId, second.turn, { status: "ABORTED" }) });
      allowed(await sendOverSocket(ingress.socketPath, envelope(52, "세 번째 턴")));
      expect(rowsFor(fixture.cp.db, "update:50")).toEqual({ inbound: 0, sources: 1, dispatches: 1 });
    } finally {
      await ingress.close();
      fixture.cp.close();
      await gateway.close();
    }
  });
});
