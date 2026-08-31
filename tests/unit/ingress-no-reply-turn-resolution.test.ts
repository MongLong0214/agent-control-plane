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
 *
 * The first test below stubs `routeUntilCeoTurn()` because no path through it can produce `admitted: true,
 * replayed: false, reply: null` today — traced exhaustively, not just for DIRECT: `directHandler`
 * is typed `(input) => string | Promise<string>` (`telegram-router.ts`), so DIRECT always replies,
 * even to say a run was refused or parked; OWNER_DECISION always builds a reply via `replyFor`,
 * whether the decision is recorded, refused, or unresolvable; MANAGED (`routeManaged`) always
 * builds a reply for every one of its returns, including the create/dispatch-refused branches; and
 * the top-level catch-all also replies. The only two producers of a literal `reply: null` are
 * `deniedOrReplay` (forces `admitted: false`) and `storedResponseOutcome` (forces `replayed:
 * true`) — neither can carry `admitted: true, replayed: false`. So the state this fixture stubs is
 * not merely unobserved, it is unreachable through every current caller of `route()`, and that is
 * a fact about today's handler set, not about this test: the mechanism it exercises
 * (`resolveNoReplyOutcome` / `completeNoReplyAndResolveTurn`) is real and load-bearing the moment a
 * handler that can decline to reply exists, but this file cannot prove the branch is *reachable*
 * today, only that it behaves correctly if it is reached. Reviewed and confirmed unreachable again
 * at #682 (fourth review) rather than papered over by adjusting the stub.
 *
 * A blind review (#682) found the shape this fixture could not see: `route()` already produces
 * `reply: null` for a *replayed* admission — a claimed turn's PENDING reply reservation,
 * rediscovered after a restart — and that shape reaches `pollOnce`'s no-reply branch through
 * completely ordinary production traffic, no future handler required. The second test below pins
 * the guard that distinguishes the two (`outcome.replayed`), and
 * `tests/unit/telegram-ingress.test.ts`'s "#682: a claimed turn's PENDING reply survives a
 * redelivery" is the real-router reproduction: a genuine DIRECT claim, a genuine crash after send
 * and before completion, a genuine restart — the case this fixture could never manufacture.
 *
 * A second review of that same fix found a further collapse: the first test asserted on
 * `unresolvedTurns` and on a redelivery's reason code, both of which go through `repliedAt` OR
 * `noReplyAt` and so cannot tell the two apart — a version of this fix that wrote `repliedAt`
 * for a no-reply outcome (claiming the transport accepted a reply it never produced) would have
 * passed both assertions. The first test now also reads the stored `turn_claim_json` directly and
 * checks which field actually moved.
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
    // No CEO is bound in this fixture, and `null` is what that honestly is. The option carries
    // no default any more: the default was how every production claim came to store a constant
    // where contract 1's binding digest belongs.
    bindingGeneration: () => null,
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

/** The raw stored claim, so a test can check which terminal fact actually moved. */
const storedClaim = (harness: ReturnType<typeof makeHarness>, nonce: string): Record<string, unknown> => {
  const row = harness.cp.db.get<{ turn_claim_json: string | null }>(
    "SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?",
    [nonce],
  );
  return JSON.parse(row?.turn_claim_json ?? "{}") as Record<string, unknown>;
};

class FakeTransport implements TelegramBotTransport {
  // Not under test here — this suite builds its guard manually with a literal policy rather
  // than through `startTelegramLongPollListener`, so nothing reads this. Declared anyway to
  // satisfy `TelegramBotTransport`, honestly: this fake stands in for the real 24h endpoint.
  readonly redeliveryRetentionMs = 24 * 60 * 60 * 1000;
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
  it("a synthetic fresh no-reply outcome is resolved by pollOnce", async () => {
    const harness = makeHarness();
    const { guard, router } = buildRouter(harness);
    const nonce = "update:1";

    // Set up exactly the state `route()` would have left behind up to the claim: admitted and
    // claimed. What is under test is what happens *after* a handler decides not to reply, so
    // `routeUntilCeoTurn()` itself is stubbed to return that outcome directly rather than reproducing a real
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
    vi.spyOn(router, "routeUntilCeoTurn").mockResolvedValueOnce({
      status: "COMPLETED",
      outcome: noReplyOutcome,
    });

    const service = new TelegramLongPollService(new FakeTransport([telegramUpdate(1)]), router, SECRET, {
      allowedChatIds: ["chat"],
    });

    const cycle = await service.pollOnce();
    await cycle.settled();

    // The claim must reach a terminal state — the same *kind* of terminal state `resolveTurn`
    // produces for a reply that was actually sent, but not the *same field* (#682): this handler
    // never produced a reply, so the row must carry `noReplyAt`, and must not carry `repliedAt` —
    // that field means specifically that the transport accepted a reply, and nothing here sent
    // one. `unresolvedTurns` and a redelivery's reason code both close over either field, so
    // neither assertion below can tell a wrongly-written `repliedAt` apart from a correct
    // `noReplyAt`; only reading the row can.
    const claim = storedClaim(harness, nonce);
    expect(claim["noReplyAt"]).toBeTruthy();
    expect(claim["repliedAt"]).toBeUndefined();

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

  it("#682: leaves a replayed, ambiguous outcome untouched instead of reading it as a no-reply", async () => {
    // The two shapes `route()` reports as `reply: null` and why they must not share a path:
    //
    //   fresh, reply: null      the handler ran just now and chose not to reply — resolve it
    //   replayed, reply: null   `admit` saw this nonce before; a PENDING reply reservation was
    //                           deliberately not resent — the outcome is unknown, not absent
    //
    // Reserve a PENDING reply the same way the router does after a real send, so there is real
    // durable state to protect — then drive the exact outcome `route()` produces on restart for
    // a claimed turn whose reply is still PENDING (`replayed: true, reply: null`) and confirm
    // nothing overwrites it.
    const harness = makeHarness();
    const { guard, ingress, router } = buildRouter(harness);
    const nonce = "update:2";

    expect(
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce, payload: { text: "hi" } })
        .allowed,
    ).toBe(true);
    expect(guard.claimTurn("telegram", nonce, identity()).allowed).toBe(true);
    const reply = {
      chatId: "chat",
      text: "an answer that may or may not have reached Telegram",
      replyToMessageId: 1,
      correlationId: "no-reply-correlation",
    };
    expect(
      ingress.recordResultIf(
        nonce,
        { kind: "TELEGRAM_WORKFLOW", phase: "REPLIED", reply, sent: false, deliveryStatus: "PENDING" },
        "AVAILABLE",
      ).allowed,
    ).toBe(true);
    const pendingResultJson = () =>
      harness.cp.db.get<{ result_json: string | null }>(
        "SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?",
        [nonce],
      )?.result_json;
    const before = pendingResultJson();
    expect(before).toContain('"deliveryStatus":"PENDING"');

    const replayedOutcome: TelegramRouteOutcome = {
      updateId: 2,
      nonce,
      correlationId: "no-reply-correlation",
      admitted: true,
      replayed: true,
      classification: null,
      input: null,
      reply: null,
      reasonCode: ReasonCode.INGRESS_REPLAY_IGNORED,
    };

    router.resolveNoReplyOutcome(replayedOutcome);

    expect(pendingResultJson()).toBe(before);
    expect(guard.unresolvedTurns("telegram", "session-digest").map((turn) => turn.nonce)).toEqual([nonce]);
  });

  it("#682: never writes noReplyAt over a turn whose reply already resolved", async () => {
    // The guard `completeNoReplyAndResolveTurn` states in its own docstring: it must never move
    // a claim that already carries a terminal fact, most importantly a real `repliedAt`. This
    // drives that directly — resolve the turn through the ordinary reply path first, then call
    // the no-reply path on the same nonce, and confirm it is a no-op rather than a second write.
    const harness = makeHarness();
    const { guard, ingress } = buildRouter(harness);
    const nonce = "update:3";

    expect(
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce, payload: { text: "hi" } })
        .allowed,
    ).toBe(true);
    expect(guard.claimTurn("telegram", nonce, identity()).allowed).toBe(true);
    expect(
      ingress.recordResultIf(
        nonce,
        { kind: "TELEGRAM_WORKFLOW", phase: "REPLIED", reply: "answered", sent: false, deliveryStatus: "PENDING" },
        "AVAILABLE",
      ).allowed,
    ).toBe(true);
    expect(
      ingress.completeReplyAndResolveTurn(nonce, {
        kind: "TELEGRAM_WORKFLOW",
        phase: "REPLIED",
        reply: "answered",
        sent: true,
        deliveryStatus: "APPLIED",
      }).allowed,
    ).toBe(true);
    const resolved = storedClaim(harness, nonce);
    expect(resolved["repliedAt"]).toBeTruthy();
    expect(resolved["noReplyAt"]).toBeUndefined();

    expect(guard.completeNoReplyAndResolveTurn("telegram", nonce).allowed).toBe(true);

    const afterNoReplyCall = storedClaim(harness, nonce);
    expect(afterNoReplyCall["repliedAt"]).toBe(resolved["repliedAt"]);
    expect(afterNoReplyCall["noReplyAt"]).toBeUndefined();
  });

  it("#682: resolveTurn refuses rather than silently no-ops over a turn a no-reply resolution already closed", async () => {
    // The other order, found by a second review of the guard above: it covers reply-then-
    // no-reply, but `#resolveTurnHere` had no matching refusal for no-reply-then-reply — its
    // WHERE clause simply matched zero rows and the function still returned `allow(OK)`
    // regardless (found by a *third* review). A no-op reported as success is how a guard becomes
    // invisible: any caller trusting that return value would believe a reply was recorded when
    // nothing moved.
    //
    // `resolveTurn` directly, not through `completeReplyAndResolveTurn`: there is no production
    // caller of standalone `resolveTurn` today (confirmed by grep — only this test and
    // `TelegramIngress.resolveTurn`'s own wrapper reach it, and nothing calls that wrapper
    // either), so this is a disclosed unit-level check of `#resolveTurnHere`'s own defense, not a
    // production reproduction. The production path this same collision reaches —
    // `reserveResponse` → `recordResultIf` → `completeResponse` → `completeReplyAndResolveTurn`
    // — is covered below, driven from `reserveResponse`, the real first call `pollOnce` makes,
    // and is refused one step earlier by `#recordResultHere` before it would ever reach here.
    // `#resolveTurnHere`'s own check stays in place as the second, independent guard on the same
    // field — the one Sol's review said to fix regardless of whether the first reproduced — for
    // whichever future caller reaches it directly (`resolveTurn` is public, and #638's later
    // receipt-match reconciliation is a plausible one).
    const harness = makeHarness();
    const { guard } = buildRouter(harness);
    const nonce = "update:4";

    expect(
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce, payload: { text: "hi" } })
        .allowed,
    ).toBe(true);
    expect(guard.claimTurn("telegram", nonce, identity()).allowed).toBe(true);
    expect(guard.completeNoReplyAndResolveTurn("telegram", nonce).allowed).toBe(true);
    const resolved = storedClaim(harness, nonce);
    expect(resolved["noReplyAt"]).toBeTruthy();
    expect(resolved["repliedAt"]).toBeUndefined();

    const refused = guard.resolveTurn("telegram", nonce);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
    if (refused.allowed) throw new Error("expected resolveTurn to refuse the conflicting terminal fact");
    expect(refused.message).toBe("cannot record a reply for a turn already resolved as no-reply");

    const afterResolveTurnCall = storedClaim(harness, nonce);
    expect(afterResolveTurnCall["noReplyAt"]).toBe(resolved["noReplyAt"]);
    expect(afterResolveTurnCall["repliedAt"]).toBeUndefined();
  });

  it("#682: reserveResponse refuses a reply for a turn already resolved as no-reply", async () => {
    // Sol's counterexample, driven from the real production entry point: `pollOnce` calls
    // `reserveResponse` first, before ever sending to Telegram, and `reserveResponse`'s own
    // precondition (`recordResultIf`, expecting "AVAILABLE") reads only `result_json`'s delivery
    // status — the `TELEGRAM_NO_REPLY` marker has none, so it read as available. The reservation
    // landed, and a later `completeResponse` could move it all the way to `sent: true,
    // deliveryStatus: "APPLIED"` — one row then asserting both "no reply was produced"
    // (`noReplyAt`) and "the transport accepted a reply" (`result_json`), without ever going
    // through the `turn_claim_json` guards this file already had.
    //
    // Worse than the completion case alone: the reservation *by itself*, before any completion,
    // already reopens #672 — it overwrites the non-recoverable `TELEGRAM_NO_REPLY` marker with a
    // `sent: false` reservation, which `isRecoverableIngressResult` reads as recoverable. Refusing
    // the reservation outright — rather than allowing it and rolling the whole completion back
    // later — is the fix, and it is the only one of the two options that also protects this half.
    const harness = makeHarness();
    const { guard, router } = buildRouter(harness);
    const nonce = "update:5";

    expect(
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce, payload: { text: "hi" } })
        .allowed,
    ).toBe(true);
    expect(guard.claimTurn("telegram", nonce, identity()).allowed).toBe(true);
    expect(guard.completeNoReplyAndResolveTurn("telegram", nonce).allowed).toBe(true);
    const beforeResultJson = harness.cp.db.get<{ result_json: string | null }>(
      "SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?",
      [nonce],
    )?.result_json;
    expect(beforeResultJson).toBe('{"kind":"TELEGRAM_NO_REPLY"}');

    const lateReplyOutcome: TelegramRouteOutcome = {
      updateId: 5,
      nonce,
      correlationId: "late-reply-correlation",
      admitted: true,
      replayed: false,
      classification: "DIRECT",
      input: null,
      reply: {
        chatId: "chat",
        text: "a reply attempted after the turn was already resolved as no-reply",
        replyToMessageId: 1,
        correlationId: "late-reply-correlation",
      },
      reasonCode: ReasonCode.OK,
    };

    // The real first call: `pollOnce` invokes `reserveResponse` before ever calling
    // `transport.sendMessage`. If this throws, no Telegram send is attempted at all.
    expect(() => router.reserveResponse(lateReplyOutcome)).toThrow(/no-reply/i);

    // Refused before any write: the durable non-recoverable marker is exactly what it was, and
    // the claim still carries only `noReplyAt`.
    const afterResultJson = harness.cp.db.get<{ result_json: string | null }>(
      "SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?",
      [nonce],
    )?.result_json;
    expect(afterResultJson).toBe(beforeResultJson);
    const claim = storedClaim(harness, nonce);
    expect(claim["noReplyAt"]).toBeTruthy();
    expect(claim["repliedAt"]).toBeUndefined();
  });

  it("#682, fourth review: a reservation that lands after the router's snapshot survives the no-reply path", async () => {
    // A blind review of the fix above found the window it left open: `outcome.replayed` is a
    // snapshot `route()` took when it returned, and `completeNoReplyAndResolveTurn` only ever
    // read `turn_claim_json` — never `result_json` — before overwriting the latter outright. So a
    // second poller's `reserveResponse` (real production entry point, called before any Telegram
    // send) can land *between* that snapshot and this call reaching the database, and nothing
    // stopped the no-reply write from clobbering it.
    //
    // Reproduced as the interleaving itself, not as a description of it: the reservation is taken
    // first (`recordResultIf`, exactly what `reserveResponse` calls), and only then does the
    // no-reply path run on the very same nonce — the same order a stale `outcome.replayed`
    // snapshot would produce in production. Before the CAS fix, this call returned `allowed: true`
    // and overwrote the PENDING reservation with `TELEGRAM_NO_REPLY`, destroying the only durable
    // evidence that Telegram may already have accepted a reply.
    const harness = makeHarness();
    const { guard, ingress } = buildRouter(harness);
    const nonce = "update:6";

    expect(
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce, payload: { text: "hi" } })
        .allowed,
    ).toBe(true);
    expect(guard.claimTurn("telegram", nonce, identity()).allowed).toBe(true);

    // The other poller's reservation, committed first.
    const reply = {
      chatId: "chat",
      text: "a reply the transport may already have accepted",
      replyToMessageId: 1,
      correlationId: "race-correlation",
    };
    expect(
      ingress.recordResultIf(
        nonce,
        { kind: "TELEGRAM_WORKFLOW", phase: "REPLIED", reply, sent: false, deliveryStatus: "PENDING" },
        "AVAILABLE",
      ).allowed,
    ).toBe(true);
    const beforeResultJson = harness.cp.db.get<{ result_json: string | null }>(
      "SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?",
      [nonce],
    )?.result_json;
    expect(beforeResultJson).toContain('"deliveryStatus":"PENDING"');

    // The no-reply path, reached afterward on a snapshot that predates the reservation above.
    const result = guard.completeNoReplyAndResolveTurn("telegram", nonce);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);

    // The reservation must survive untouched, and the claim must not carry `noReplyAt` — a reply
    // may yet complete for this turn.
    const afterResultJson = harness.cp.db.get<{ result_json: string | null }>(
      "SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?",
      [nonce],
    )?.result_json;
    expect(afterResultJson).toBe(beforeResultJson);
    const claim = storedClaim(harness, nonce);
    expect(claim["noReplyAt"]).toBeUndefined();
  });
});
