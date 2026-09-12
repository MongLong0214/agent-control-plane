import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { TelegramIngress, type TelegramUpdate } from "../../src/ingress/telegram.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Everything ACP knows about a Telegram update it learns from the update itself, and the only
 * thing authenticating it is a secret token echoed back — Telegram does not sign the body.
 *
 * So two groups of operands stand in front of everything else, and until #833 neither had a
 * witness: the constant-time secret comparison, and the shape check that refuses an update whose
 * sender or chat is missing or not a safe integer. An id that is not a safe integer is not a
 * cosmetic problem here: it becomes the actor and conversation identity the guard's allowlist is
 * matched against.
 */
const SECRET = "a-secret-token-of-some-length";

const ingressFor = (harness: ReturnType<typeof makeHarness>): TelegramIngress => {
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    telegram: { allowedActors: ["7"], allowedConversations: ["11"], recoverInFlight: true },
  });
  return new TelegramIngress(guard, { webhookSecret: SECRET });
};

/** A well-formed update, so each case below changes exactly one thing about it. */
const wellFormed = (): TelegramUpdate =>
  ({
    update_id: 1,
    message: { message_id: 5, text: "hello", from: { id: 7 }, chat: { id: 11 } },
  }) as unknown as TelegramUpdate;

const shapeDenied = (update: TelegramUpdate): void => {
  const harness = makeHarness();
  const result = ingressFor(harness).admit(update, SECRET);

  expect(result.allowed).toBe(false);
  if (result.allowed) return;
  expect(result.reasonCode).toBe(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED);
};

describe("a Telegram update states its sender and chat as safe integers", () => {
  it("admits a well-formed update from an allowlisted sender and chat", () => {
    // The control. Without it every refusal below passes against an ingress that refuses
    // everything, and the allowlist would be the only thing anyone could observe.
    const harness = makeHarness();

    const result = ingressFor(harness).admit(wellFormed(), SECRET);

    expect(result.allowed).toBe(true);
  });

  it("refuses a message id that is not a safe integer", () => {
    const update = wellFormed();
    // Past 2^53: JSON round-trips it, and it is the value the nonce is derived from.
    (update.message as { message_id: number }).message_id = 9_007_199_254_740_993;

    shapeDenied(update);
  });

  it("refuses a sender id that is not a safe integer", () => {
    const update = wellFormed();
    (update.message as { from: { id: unknown } }).from = { id: "7" };

    // The id becomes the actor the allowlist is matched against, and `"7"` would match the
    // allowlisted `"7"` by string. The refusal is what keeps identity numeric.
    shapeDenied(update);
  });

  it("refuses a chat id that is not a safe integer", () => {
    const update = wellFormed();
    (update.message as { chat: { id: unknown } }).chat = { id: 11.5 };

    shapeDenied(update);
  });

  it("refuses a secret of the wrong length without throwing", () => {
    // `timingSafeEqual` throws on mismatched lengths rather than returning false, so the length
    // comparison in front of it is what makes a wrong-length token a refusal instead of an
    // exception. The assertion is that this returns at all.
    const harness = makeHarness();

    const result = ingressFor(harness).admit(wellFormed(), `${SECRET}-longer`);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.INGRESS_SIGNATURE_INVALID);
  });

  it("refuses a secret of the right length whose bytes differ", () => {
    // Same length, one byte changed: only the constant-time comparison rejects this.
    const harness = makeHarness();
    const wrong = `${SECRET.slice(0, -1)}X`;
    expect(wrong.length).toBe(SECRET.length);

    const result = ingressFor(harness).admit(wellFormed(), wrong);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.INGRESS_SIGNATURE_INVALID);
  });
});
