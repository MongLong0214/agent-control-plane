import { afterAll, describe, expect, it, vi } from "vitest";

import { IngressGuard, type TurnIdentity } from "../../src/ingress/ingress-guard.ts";
import { TelegramIngress, type TelegramUpdate } from "../../src/ingress/telegram.ts";
import {
  TelegramHermesRouter,
  type TelegramRouteOutcome,
} from "../../src/ingress/telegram-router.ts";
import {
  TelegramLongPollService,
  type TelegramBotTransport,
  type TelegramGetUpdatesOptions,
} from "../../src/ingress/telegram-polling.ts";
import { createHermesMcpPort } from "../../src/mcp/hermes-server.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const SECRET = "no-reply-webhook-secret";

/**
 * #672 — a claimed turn whose handler returns no reply is never resolved.
 *
 * `reserveResponse` / `completeResponse` / `releaseResponse` all begin `if (!outcome.reply)
 * return`, and `pollOnce` only calls any of them inside `if (outcome.reply)`. Nothing in that
 * chain ever calls `resolveTurn` when a claimed turn's outcome carries no reply, so the claim is
 * outstanding forever: `admit` refuses the nonce as `INGRESS_TURN_OUTCOME_UNKNOWN` and `prune`
 * exempts the row on purpose (that exemption is correct — see ingress-turn-claim.test.ts — the
 * defect is that nothing ever clears it for a turn that is, in fact, done).
 */
const identity = (turnRequestId = "turn-1"): TurnIdentity => ({
  turnRequestId,
  sessionDigest: "session-digest",
  promptDigest: "prompt-digest",
  bindingDigest: "binding-digest",
});

/** Builds a real guard + ingress + router, wired the same way `startTelegramLongPollListener` does. */
const buildRouter = (harness: ReturnType<typeof makeHarness>) => {
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    telegram: { allowedActors: ["owner"], allowedConversations: ["chat"], recoverInFlight: true },
  });
  const ingress = new TelegramIngress(guard, { webhookSecret: SECRET });
  const hermes = createHermesMcpPort(harness.cp);
  const router = new TelegramHermesRouter({
    ingress,
    hermes,
    currentCandidateSnapshotDigest: () => null,
  });
  return { guard, ingress, router };
};

const telegramUpdate = (updateId: number): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: 1,
    date: 1_700_000_000,
    text: "hi",
    from: { id: 424242, username: "owner" },
    chat: { id: 999 },
  },
});

class FakeTransport implements TelegramBotTransport {
  constructor(private updates: TelegramUpdate[]) {}
  async getUpdates(_options: TelegramGetUpdatesOptions): Promise<readonly TelegramUpdate[]> {
    const batch = this.updates;
    this.updates = [];
    return batch;
  }
  async sendMessage(): Promise<{ messageId: number }> {
    throw new Error("no reply was expected to be sent in this scenario");
  }
}

describe("#672 a claimed turn whose handler produces no reply", () => {
  it("is resolved by pollOnce even though the route call returned no reply", async () => {
    const harness = makeHarness();
    const { guard, router } = buildRouter(harness);
    const nonce = "update:1";

    // Set up exactly the state `route()` would have left behind up to the claim: admitted and
    // claimed. What is under test is what happens *after* a handler decides not to reply, so
    // `route()` itself is stubbed to return that outcome directly rather than reproducing a real
    // no-reply DIRECT handler — nothing in the current classifier can produce one, which is part
    // of why this bug is latent rather than yet observed in production.
    expect(
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce, payload: { text: "hi" } })
        .allowed,
    ).toBe(true);
    expect(guard.claimTurn("telegram", nonce, identity()).allowed).toBe(true);

    const noReplyOutcome: TelegramRouteOutcome = {
      updateId: 1,
      nonce,
      correlationId: "no-reply-correlation",
      admitted: true,
      replayed: false,
      classification: "DIRECT",
      input: null,
      reply: null,
      reasonCode: ReasonCode.OK,
    };
    vi.spyOn(router, "route").mockResolvedValueOnce(noReplyOutcome);

    const service = new TelegramLongPollService(new FakeTransport([telegramUpdate(1)]), router, SECRET, {
      allowedChatIds: ["chat"],
    });

    await service.pollOnce();

    // The claim must reach a terminal state — the same one `resolveTurn` produces for a reply
    // that was actually sent — so a later redelivery of this nonce is an ordinary replay, and the
    // owner is not left with a message the daemon will refuse forever with no way to clear it.
    expect(guard.unresolvedTurns("telegram", "session-digest")).toEqual([]);
    const redelivered = guard.admit({
      channel: "telegram",
      actor: "owner",
      conversation: "chat",
      nonce,
      payload: { text: "hi" },
    });
    expect(redelivered.allowed).toBe(false);
    expect(redelivered.reasonCode).toBe(ReasonCode.INGRESS_REPLAY_IGNORED);
  });
});
