import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { asUntrustedData, type IngressGuard } from "./ingress-guard.ts";

/** The subset of a Telegram update the control plane needs. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    from?: { id: number; username?: string };
    chat?: { id: number };
    forward_origin?: { type: string };
    forward_from?: { id: number };
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

/**
 * PRD §27.1.
 *
 * Four checks stand between Telegram and the control plane: the sender must be the
 * allowlisted owner, the chat must be allowlisted, the update must be authentic, and the
 * update id must not have been seen before. Forwarded content is additionally wrapped as
 * untrusted data, because it is text a third party wrote (§27.4, CP-S51).
 */
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
    const message = update.message;
    if (!message?.text) {
      return deny(ReasonCode.INVALID_ARGUMENT, "update carries no text message", {
        updateId: update.update_id,
      });
    }
    if (!message.from?.id || !message.chat?.id) {
      return deny(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED, "update has no sender or chat", {
        updateId: update.update_id,
      });
    }

    // Telegram authenticates the webhook by echoing a secret token rather than signing
    // the body, so that token is what the guard verifies.
    if (presentedSecret !== this.options.webhookSecret) {
      return deny(ReasonCode.INGRESS_SIGNATURE_INVALID, "webhook secret token mismatch", {
        updateId: update.update_id,
      });
    }

    const admitted = this.guard.admit({
      channel: "telegram",
      actor: String(message.from.id),
      conversation: String(message.chat.id),
      nonce: `update:${update.update_id}`,
      payload: { text: message.text, messageId: message.message_id },
    });
    if (!admitted.allowed) return admitted as Decision<AdmittedTelegramMessage>;

    const forwarded = Boolean(message.forward_origin ?? message.forward_from);
    return allow(ReasonCode.UNTRUSTED_CONTENT_IS_DATA, {
      text: forwarded ? asUntrustedData("telegram-forward", message.text) : message.text,
      actor: String(message.from.id),
      chatId: String(message.chat.id),
      forwarded,
      nonce: `update:${update.update_id}`,
    });
  }

  /** Idempotency key for anything this message causes downstream. */
  idempotencyKeyFor(message: AdmittedTelegramMessage, operation: string): string {
    return `telegram:${operation}:${digestOf({ nonce: message.nonce, actor: message.actor })}`;
  }
}
