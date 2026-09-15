import { afterAll, describe, expect, it } from "vitest";

import { allow, deny, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { TelegramIngress, type TelegramUpdate } from "../../src/ingress/telegram.ts";
import { TelegramHermesRouter } from "../../src/ingress/telegram-router.ts";
import { createHermesMcpPort } from "../../src/mcp/hermes-server.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

/**
 * #858, the router's half of the missing writer.
 *
 * `canonical_turns` has exactly one writer — `ConversationTurnCoordinator.claim()` — and no
 * production caller, so the canonical ledger stayed empty while `inbound_messages.turn_claim_json`
 * held the real turn. Four adjudication surfaces and a 60s reconcile sweep therefore passed over
 * an empty row set: not two ledgers with different counts, two ledgers holding different turns.
 *
 * The bridge is a narrow port rather than the coordinator itself, because the router is sealed
 * away from the ControlPlane by design. This measures the router end: after it claims a DIRECT
 * message, it hands that exact nonce and prompt over. The coordinator end is a closure assembled
 * in `telegram-polling`, where `cp` is in scope.
 *
 * Why the port and not `canonical_turns` directly: the coordinator refuses a turn whose actor has
 * no verified target, and this fixture binds no Hermes CEO. Asserting on the row would measure the
 * fixture's binding rather than the router's behaviour — and would have passed for a router that
 * never called anything, since the row is absent either way.
 */
const SECRET = "telegram-secret";

afterAll(() => {
  cleanupTempDirs();
});

const buildRouter = (
  harness: ReturnType<typeof makeHarness>,
  materializeTurn?: (input: { channel: string; nonce: string; prompt: string; payload: unknown }) => Decision<void>,
) => {
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    telegram: { allowedActors: ["424242"], allowedConversations: ["999"], recoverInFlight: true },
  });
  const ingress = new TelegramIngress(guard, { webhookSecret: SECRET });
  const router = new TelegramHermesRouter({
    ingress,
    hermes: createHermesMcpPort(harness.cp),
    currentCandidateSnapshotDigest: () => null,
    bindingGeneration: () => null,
    ...(materializeTurn ? { materializeTurn } : {}),
  });
  return { guard, ingress, router };
};

const update = (updateId: number, text: string): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: 1,
    date: 1_700_000_000,
    text,
    from: { id: 424242, username: "owner" },
    chat: { id: 999 },
  },
});

describe("#858 the router hands a claimed turn to the canonical ledger", () => {
  it("hands over the nonce and prompt it just claimed", async () => {
    const harness = makeHarness();
    const handed: Array<{ channel: string; nonce: string; prompt: string }> = [];
    const { ingress, router } = buildRouter(harness, ({ channel, nonce, prompt }) => {
      handed.push({ channel, nonce, prompt });
      return allow(ReasonCode.OK, undefined);
    });

    const inbound = update(8581, "이 문장은 canonical 원장의 증인이다.");
    await router.route(inbound, SECRET);

    expect(handed, "the router claimed a DIRECT turn and told the canonical ledger nothing").toHaveLength(1);
    expect(handed[0]?.channel).toBe("telegram");
    expect(handed[0]?.prompt).toBe("이 문장은 canonical 원장의 증인이다.");
    // The nonce has to be the one the ingress claimed, not a fresh one: a bridge that invents an
    // identifier writes a canonical turn nobody can match back to the message it answered.
    expect(handed[0]?.nonce, "the handed nonce is not the one the ingress claimed").toBe(
      ingress.nonceFor(inbound),
    );
  });

  it("does not let a refusing ledger change what the owner is told", async () => {
    // The refusal path is today's state — canonical empty, ingress claimed — so it must not turn
    // into a reply. A bridge that surfaced its own failure would tell the owner about a ledger
    // they cannot act on, and would make this change able to do harm where it can currently only
    // fail to help.
    const harness = makeHarness();
    const refusing = buildRouter(harness, () =>
      deny(ReasonCode.CONVERSATION_TARGET_UNVERIFIED, "no verified target", {}));
    const silent = buildRouter(makeHarness());

    const refusedOutcome = await refusing.router.route(update(8582, "hi"), SECRET);
    const silentOutcome = await silent.router.route(update(8582, "hi"), SECRET);

    expect(refusedOutcome.reasonCode).toBe(silentOutcome.reasonCode);
    expect(refusedOutcome.classification).toBe(silentOutcome.classification);
    expect(refusedOutcome.reply?.text).toBe(silentOutcome.reply?.text);
  });
});
