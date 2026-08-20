import { timingSafeEqual } from "node:crypto";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { OwnerApprovalReceipt } from "../ceo/owner-authority.ts";
import {
  asUntrustedData,
  ownerApprovalPayload,
  type IngressGuard,
  type IngressRequest,
  type OwnerApprovalIngress,
} from "./ingress-guard.ts";

/** The subset of a Telegram update the control plane needs. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    from?: { id: number; username?: string };
    chat?: { id: number };
    /** Telegram's Bot API carries the replied-to message as a nested object. */
    reply_to_message?: { message_id: number };
    /** Accepted as a test/adapter compatibility shape; Telegram normally uses the nested form. */
    reply_to_message_id?: number;
    forward_origin?: { type: string };
    forward_from?: { id: number };
    /** Pre-`forward_origin` markers. Still delivered; see isForwarded. */
    forward_from_chat?: { id: number };
    forward_sender_name?: string;
    forward_date?: number;
  };
}

export interface TelegramIngressOptions {
  /** Secret token Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`. */
  webhookSecret: string;
}

export interface AdmittedTelegramMessage {
  text: string;
  actor: string;
  chatId: string;
  /** True when the text originated elsewhere and must be handled as data (§27.4). */
  forwarded: boolean;
  nonce: string;
}

/** The operation envelope that Telegram is allowed to turn into an owner receipt. */
export type TelegramOwnerApproval = OwnerApprovalIngress;

/**
 * PRD §27.1.
 *
 * Four checks stand between Telegram and the control plane: the sender must be the
 * allowlisted owner, the chat must be allowlisted, the update must be authentic, and the
 * update id must not have been seen before. Forwarded content is additionally wrapped as
 * untrusted data, because it is text a third party wrote (§27.4, CP-S51).
 */
/**
 * Compares a presented secret without leaking where it first differs.
 *
 * The length check is deliberately outside `timingSafeEqual`, which throws on a length
 * mismatch rather than returning false — length is not the secret here, its bytes are.
 */
const secretMatches = (presented: string | null, expected: string): boolean => {
  if (presented === null) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

export class TelegramIngress {
  constructor(
    private readonly guard: IngressGuard,
    private readonly options: TelegramIngressOptions,
  ) {
    if (options.webhookSecret.trim().length === 0) {
      throw new Error("Telegram ingress requires a non-empty webhook secret");
    }
  }

  admit(
    update: TelegramUpdate,
    presentedSecret: string | null,
  ): Decision<AdmittedTelegramMessage> {
    const request = this.authenticatedRequest(
      update,
      presentedSecret,
      this.messagePayload(update),
    );
    if (!request.allowed) return request as Decision<AdmittedTelegramMessage>;

    const admitted = this.guard.admit(request.value);
    if (!admitted.allowed) return admitted as Decision<AdmittedTelegramMessage>;

    const message = update.message!;
    const text = message.text!;
    const from = message.from!;
    const chat = message.chat!;
    const forwarded = this.isForwarded(update);
    const result = allow(ReasonCode.UNTRUSTED_CONTENT_IS_DATA, {
      text: forwarded ? asUntrustedData("telegram-forward", text) : text,
      actor: String(from.id),
      chatId: String(chat.id),
      forwarded,
      nonce: `update:${update.update_id}`,
    });
    if (admitted.evidence["recovered"] !== true) {
      this.recordResult(this.nonceFor(update), {
        kind: "TELEGRAM_WORKFLOW",
        phase: "ADMITTED",
      });
    }
    return result;
  }

  /**
   * Mints an owner receipt from this Telegram update. The raw message is never accepted as
   * authority: the guard admits the canonical operation payload, and forwarded messages are
   * refused before they can be interpreted as an approval command.
   */
  admitOwnerApproval(
    update: TelegramUpdate,
    presentedSecret: string | null,
    input: TelegramOwnerApproval,
  ): Decision<OwnerApprovalReceipt> {
    if (this.isForwarded(update)) {
      return deny(
        ReasonCode.UNTRUSTED_CONTENT_IS_DATA,
        "forwarded Telegram content cannot carry owner authority",
        { updateId: update.update_id },
      );
    }

    const request = this.authenticatedRequest(
      update,
      presentedSecret,
      ownerApprovalPayload(input),
    );
    if (!request.allowed) {
      return request as Decision<OwnerApprovalReceipt>;
    }
    const admitted = this.guard.admitOwnerApproval(request.value, input);
    if (!admitted.allowed) return admitted as Decision<OwnerApprovalReceipt>;
    if (admitted.evidence["recovered"] !== true) {
      this.recordResult(this.nonceFor(update), {
        kind: "TELEGRAM_WORKFLOW",
        phase: "ADMITTED",
      });
    }
    return allow(ReasonCode.OK, admitted.value, admitted.evidence);
  }

  /** Telegram forwards are data even when their text happens to look like a command. */
  isForwarded(update: TelegramUpdate): boolean {
    const message = update.message;
    if (!message) return false;
    // Every marker Bot API has used, not only the current one. `forward_origin` replaced the
    // older fields, but Telegram still sends those to clients that have not migrated, and a
    // message carrying only them read as authored here — so a forwarded `/managed …` was
    // parsed as a live owner command and created a run.
    //
    // Failing toward "forwarded" is the safe direction: a forward misread as authored carries
    // someone else's text into owner authority, while an authored message misread as forwarded
    // is refused and can be resent.
    return Boolean(
      message.forward_origin ??
        message.forward_from ??
        message.forward_from_chat ??
        message.forward_sender_name ??
        message.forward_date,
    );
  }

  /** The durable replay key used by the guard and downstream idempotency surfaces. */
  nonceFor(update: TelegramUpdate): string {
    return `update:${update.update_id}`;
  }

  private authenticatedRequest(
    update: TelegramUpdate,
    presentedSecret: string | null,
    payload: unknown,
  ): Decision<IngressRequest> {
    const message = update.message;
    if (!Number.isSafeInteger(update.update_id)) {
      return deny(ReasonCode.INVALID_ARGUMENT, "update id is not a safe integer", {
        updateId: update.update_id,
      });
    }
    if (!message?.text) {
      return deny(ReasonCode.INVALID_ARGUMENT, "update carries no text message", {
        updateId: update.update_id,
      });
    }
    if (
      !Number.isSafeInteger(message.message_id) ||
      !message.from ||
      !Number.isSafeInteger(message.from.id) ||
      !message.chat ||
      !Number.isSafeInteger(message.chat.id)
    ) {
      return deny(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED, "update has no sender or chat", {
        updateId: update.update_id,
      });
    }

    // Telegram authenticates a webhook by echoing a secret token rather than signing the
    // body. Long-poll callers pass the deployment secret only after the Bot API transport
    // itself authenticated with the bot token; the same parser therefore remains fail-closed
    // for both modes.
    // Constant-time, like every other credential comparison in this subsystem
    // (`IngressGuard.admit` uses timingSafeEqual on its HMAC). A single-value equality check
    // is a narrow exposure, but the repository's rule is that no credential comparison
    // short-circuits on the first differing byte, and this was the one exception.
    if (!secretMatches(presentedSecret, this.options.webhookSecret)) {
      return deny(ReasonCode.INGRESS_SIGNATURE_INVALID, "webhook secret token mismatch", {
        updateId: update.update_id,
      });
    }

    return allow(ReasonCode.OK, {
      channel: "telegram",
      actor: String(message.from.id),
      conversation: String(message.chat.id),
      nonce: this.nonceFor(update),
      payload,
    });
  }

  private messagePayload(update: TelegramUpdate): Record<string, unknown> {
    const message = update.message;
    return {
      text: message?.text ?? null,
      messageId: message?.message_id ?? null,
    };
  }

  /** Idempotency key for anything this message causes downstream. */
  idempotencyKeyFor(message: AdmittedTelegramMessage, operation: string): string {
    return `telegram:${operation}:${digestOf({ nonce: message.nonce, actor: message.actor })}`;
  }

  /** Stores the correlated response beside the consumed update nonce. */
  recordResult(nonce: string, result: unknown): void {
    this.guard.recordResult("telegram", nonce, result);
  }

  /**
   * Takes the right to run this update's handler, once. See `IngressGuard.claimTurn`.
   *
   * Named on this class rather than reached through `guard` by callers, so the channel string
   * is supplied here alongside `nonceFor` and cannot be passed inconsistently.
   */
  claimTurn(nonce: string): Decision<void> {
    return this.guard.claimTurn("telegram", nonce);
  }

  /** Conditional durable transition for Telegram's PENDING → APPLIED reply protocol. */
  recordResultIf(
    nonce: string,
    result: unknown,
    expected: "AVAILABLE" | "PENDING",
  ): Decision<void> {
    return this.guard.recordResultIf("telegram", nonce, result, expected);
  }
}
