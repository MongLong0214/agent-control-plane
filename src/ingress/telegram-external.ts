import type { ControlPlane } from "../app/control-plane.ts";
import type { TurnPermit } from "../conversation/turn-coordinator.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { IngressGuard } from "./ingress-guard.ts";
import { TelegramIngress, type TelegramUpdate } from "./telegram.ts";
import {
  receiptIdentityForCurrentHermesCeo,
  type TelegramExternalConsumerConfig,
} from "./telegram-polling.ts";

/**
 * U4: Hermes is the only Telegram consumer, and ACP still decides which owner messages become
 * canonical turns.
 *
 * Hermes polls the bot. For an update from the bound owner chat it connects to this lane's socket
 * before running anything, and runs the turn only when the answer is `allowed`. By then ACP has
 * admitted the update, claimed a canonical turn for the Hermes CEO and committed its dispatch row,
 * so a turn Hermes runs always has a ledger entry, and the receipt Hermes records for it carries
 * the identity this lane returned.
 *
 * Nothing here is a new authority. The update passes `TelegramIngress.admit` (the shared secret in
 * constant time, the owner and chat allowlists, safe integer ids, the `INGRESS_ADMITTED` payload
 * digest); the turn passes `ConversationTurnCoordinator.claim` (attestation currency, a READY
 * session and its incarnation, the payload digest against admission); and the turn settles only
 * through the coordinator's sealed receipt port and its eight-field match. Every refusal before the
 * dispatch commits leaves the database as it was: admission and claim run in one `txDecision`, so
 * a refused claim takes the admission, and its spent nonce, back with it.
 *
 * The coordinator's claim is used rather than `IngressGuard.claimTurn`, which mints a turn id of
 * its own; the turn this lane claims has exactly one id, the coordinator's.
 */

/** The request schema Hermes sends. */
export const TELEGRAM_EXTERNAL_UPDATE_SCHEMA = "acp.telegram-external-update/v1";
/** The only binding this lane serves: the adopted Hermes CEO. */
export const TELEGRAM_EXTERNAL_BINDING = "acp-canonical-ceo";
/** The socket's file name inside the daemon's owner-only state directory. */
export const TELEGRAM_EXTERNAL_SOCKET_NAME = "telegram-update.ingress.sock";
/**
 * The whole framed request, terminator included. A Telegram text message is at most 4096 UTF-16
 * units, and a sender that escapes every non-ASCII character (Python's `json.dumps` default) spends
 * six bytes on each, so 64 KiB holds the longest message with room for the envelope around it.
 */
export const TELEGRAM_EXTERNAL_MAX_REQUEST_BYTES = 64 * 1024;
/** A4: how long a claim refused behind an in-doubt turn waits for one receipt sweep. */
export const TELEGRAM_EXTERNAL_RECONCILE_BUDGET_MS = 3_000;

/** The eight fields `canonical_turns` fixes for a turn, which Hermes echoes in its receipt. */
export interface TelegramExternalTurnIdentity {
  turnRequestId: string;
  targetActorId: string;
  promptDigest: string;
  bindingGeneration: number;
  targetBindingId: string;
  targetAttestationId: string;
  executorSessionId: string;
  executorSessionIncarnation: string;
}

export type TelegramExternalAnswer =
  | {
      allowed: true;
      replayed: boolean;
      turn: TelegramExternalTurnIdentity;
      source: { channel: "telegram"; nonce: string };
      /** From the target-bind receipt of the attestation the turn was claimed under. */
      targetBind: { requested_session_id: string; lineage_root_digest: string };
    }
  | { allowed: false; reasonCode: string; message: string };

interface TelegramExternalEnvelope {
  secret: string;
  update: TelegramUpdate;
}

const ENVELOPE_KEYS = ["binding", "schema", "secret", "update"] as const;
const UPDATE_KEYS = ["message", "update_id"] as const;
const REQUIRED_MESSAGE_KEYS = ["chat", "from", "message_id", "text"] as const;
/**
 * Every forward marker `TelegramIngress.isForwarded` reads, accepted as keys so a forwarded message
 * is refused for being forwarded rather than for an unknown key.
 */
const FORWARD_KEYS = [
  "forward_origin",
  "forward_from",
  "forward_from_chat",
  "forward_sender_name",
  "forward_date",
] as const;
const MESSAGE_KEYS = new Set<string>([...REQUIRED_MESSAGE_KEYS, ...FORWARD_KEYS]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

const malformed = (message: string): Decision<TelegramExternalEnvelope> =>
  deny(ReasonCode.INVALID_ARGUMENT, message);

/**
 * The envelope, closed at every level. Values are type-checked here and nowhere else beyond that:
 * whether the ids are safe integers, the text non-empty and the secret right is `admit`'s to decide,
 * once, the same way it decides it for the long-poll path.
 */
const parseEnvelope = (value: unknown): Decision<TelegramExternalEnvelope> => {
  if (!isRecord(value) || !hasExactly(value, ENVELOPE_KEYS)) {
    return malformed("the envelope must carry exactly schema, binding, secret and update");
  }
  if (value["schema"] !== TELEGRAM_EXTERNAL_UPDATE_SCHEMA) return malformed("unknown envelope schema");
  if (value["binding"] !== TELEGRAM_EXTERNAL_BINDING) return malformed("this lane serves only the acp-canonical-ceo binding");
  if (typeof value["secret"] !== "string") return malformed("the envelope carries no secret");
  const update = value["update"];
  if (!isRecord(update) || !hasExactly(update, UPDATE_KEYS) || typeof update["update_id"] !== "number") {
    return malformed("the update must carry exactly a numeric update_id and a message");
  }
  const message = update["message"];
  if (
    !isRecord(message) ||
    !Object.keys(message).every((key) => MESSAGE_KEYS.has(key)) ||
    !REQUIRED_MESSAGE_KEYS.every((key) => key in message)
  ) {
    return malformed("the message must carry message_id, from, chat and text, and nothing but forward markers besides");
  }
  const from = message["from"];
  const chat = message["chat"];
  if (
    typeof message["message_id"] !== "number" ||
    typeof message["text"] !== "string" ||
    !isRecord(from) || !hasExactly(from, ["id"]) || typeof from["id"] !== "number" ||
    !isRecord(chat) || !Object.keys(chat).every((key) => key === "id" || key === "type") ||
    typeof chat["id"] !== "number" ||
    (chat["type"] !== undefined && typeof chat["type"] !== "string")
  ) {
    return malformed("the message's ids, sender, chat or text have the wrong type");
  }
  const forwardMarkers = Object.fromEntries(FORWARD_KEYS.filter((key) => key in message).map((key) => [key, message[key]]));
  return allow(ReasonCode.OK, {
    secret: value["secret"],
    update: {
      update_id: update["update_id"],
      message: {
        message_id: message["message_id"],
        // Not part of this envelope. Nothing on the admission or claim path reads a message date.
        date: 0,
        text: message["text"],
        from: { id: from["id"] },
        chat: { id: chat["id"] },
        ...(forwardMarkers as Pick<NonNullable<TelegramUpdate["message"]>, (typeof FORWARD_KEYS)[number]>),
      },
    },
  });
};

const refusal = (decision: { reasonCode: string; message: string }): TelegramExternalAnswer => ({
  allowed: false,
  reasonCode: decision.reasonCode,
  message: decision.message,
});

interface ClaimedExternalTurn {
  permit: TurnPermit;
  answer: TelegramExternalAnswer & { allowed: true };
}

/**
 * One lane per daemon. The guard is this lane's own, with the external consumer's allowlists and no
 * in-flight recovery: an update this lane admitted either holds a canonical turn or was rolled back,
 * so there is no half-run handler for a redelivery to resume.
 */
export class TelegramExternalUpdateLane {
  readonly #cp: ControlPlane;
  readonly #ingress: TelegramIngress;
  readonly #reconcileBudgetMs: number;

  constructor(
    cp: ControlPlane,
    config: TelegramExternalConsumerConfig,
    options: { reconcileBudgetMs?: number } = {},
  ) {
    this.#cp = cp;
    const guard = new IngressGuard(cp.db, cp.clock, cp.audit, {
      telegram: {
        allowedActors: config.allowedOwnerIds,
        allowedConversations: config.allowedChatIds,
      },
    });
    this.#ingress = new TelegramIngress(guard, { webhookSecret: config.sharedSecret });
    this.#reconcileBudgetMs = options.reconcileBudgetMs ?? TELEGRAM_EXTERNAL_RECONCILE_BUDGET_MS;
  }

  /**
   * Answers one envelope through `respond`, once.
   *
   * For a new turn `respond` is the send `ConversationTurnCoordinator.dispatch` holds, so the
   * canonical turn and its dispatch row are committed before Hermes reads that it may run. Every
   * other answer is a refusal or a replay, and neither writes.
   */
  async handle(value: unknown, respond: (answer: TelegramExternalAnswer) => void): Promise<void> {
    const envelope = parseEnvelope(value);
    if (!envelope.allowed) return respond(refusal(envelope));

    let claimed = this.#claim(envelope.value);
    if (!claimed.allowed && claimed.reasonCode === ReasonCode.CONVERSATION_TURN_IN_DOUBT) {
      // A4. The CEO's previous turn is still in doubt, usually because its receipt has not been
      // swept yet. Ask the receipt port once, inside a bounded wait, and claim again once. The
      // rollback above left nothing behind, so the second claim starts from the same database.
      await this.#reconcileOnce();
      claimed = this.#claim(envelope.value);
    }
    if (!claimed.allowed) {
      if (claimed.reasonCode === ReasonCode.INGRESS_REPLAY_IGNORED) return respond(this.#replay(envelope.value));
      return respond(refusal(claimed));
    }
    const { permit, answer } = claimed.value;
    const dispatched = await this.#cp.conversation.dispatch(permit, () => respond(answer));
    if (!dispatched.allowed) respond(refusal(dispatched));
  }

  /** Admission and claim in one transaction: either both commit or neither leaves a row. */
  #claim(envelope: TelegramExternalEnvelope): Decision<ClaimedExternalTurn> {
    const { update } = envelope;
    return this.#cp.db.txDecision((): Decision<ClaimedExternalTurn> => {
      const admitted = this.#ingress.admit(update, envelope.secret);
      if (!admitted.allowed) return deny(admitted.reasonCode, admitted.message, admitted.evidence);
      // `admit` wraps a forward as untrusted data for an executor ACP drives. Here Hermes runs the
      // text it already holds, so the wrapper could not reach the executor, and a forward is refused
      // instead of being claimed as the owner's own words.
      if (admitted.value.forwarded) {
        return deny(
          ReasonCode.UNTRUSTED_CONTENT_IS_DATA,
          "forwarded Telegram content is not run as an owner turn",
          { updateId: update.update_id },
        );
      }
      const text = update.message!.text!;
      // Only the target half of this query is used; the turn id is the coordinator's to mint.
      const target = receiptIdentityForCurrentHermesCeo(this.#cp, { turnRequestId: "", promptDigest: digestOf(text) });
      if (!target) {
        return deny(
          ReasonCode.CONVERSATION_TARGET_UNVERIFIED,
          "no attested Hermes CEO target is bound, so no turn can be claimed for it",
          { updateId: update.update_id },
        );
      }
      const claimed = this.#cp.conversation.claim({
        targetActorId: target.targetActorId,
        prompt: text,
        sources: [{
          channel: "telegram",
          nonce: admitted.value.nonce,
          attempt: 1,
          payload: this.#ingress.admittedPayloadFor(update),
        }],
      });
      if (!claimed.allowed) return deny(claimed.reasonCode, claimed.message, claimed.evidence);
      const turn = this.#turn(claimed.value.turnRequestId);
      // `claim` picks the newest current attestation for the actor's target. The CEO resolver named
      // the one carrying the Hermes bind receipt; if they differ the receipt Hermes would sign
      // describes a different attestation than the turn, and that turn could never settle.
      if (
        !turn ||
        turn.targetActorId !== target.targetActorId ||
        turn.bindingGeneration !== target.bindingGeneration ||
        turn.targetBindingId !== target.targetBindingId ||
        turn.targetAttestationId !== target.targetAttestationId ||
        turn.executorSessionId !== target.executorSessionId ||
        turn.executorSessionIncarnation !== target.executorSessionIncarnation
      ) {
        return deny(
          ReasonCode.CONVERSATION_TARGET_UNVERIFIED,
          "the claimed turn does not name the CEO's attested Hermes target",
          { updateId: update.update_id },
        );
      }
      const answer = this.#answer(turn, admitted.value.nonce, false);
      if (!answer) {
        return deny(
          ReasonCode.CONVERSATION_TARGET_UNVERIFIED,
          "the CEO target's bind receipt is not readable",
          { updateId: update.update_id },
        );
      }
      return allow(ReasonCode.OK, { permit: claimed.value, answer });
    });
  }

  /**
   * The answer to an update this lane already claimed, read without writing.
   *
   * Reached only when `admit` refused the update as a replay, which it does after the secret, the
   * allowlists and the ids passed, so the caller here is the authenticated one. The update's own
   * admitted payload decides whether it is the same update: a different text or chat under a spent
   * update id is refused, never answered with the first one's turn.
   */
  #replay(envelope: TelegramExternalEnvelope): TelegramExternalAnswer {
    const { update } = envelope;
    if (this.#ingress.isForwarded(update)) {
      return refusal({
        reasonCode: ReasonCode.UNTRUSTED_CONTENT_IS_DATA,
        message: "forwarded Telegram content is not run as an owner turn",
      });
    }
    const nonce = this.#ingress.nonceFor(update);
    const source = this.#cp.db.get<{ turn_request_id: string; source_digest: string }>(
      `SELECT turn_request_id, source_digest FROM canonical_turn_sources
        WHERE source_channel = 'telegram' AND source_nonce = ? AND source_attempt = 1`,
      [nonce],
    );
    if (!source) {
      return refusal({
        reasonCode: ReasonCode.INGRESS_REPLAY_IGNORED,
        message: "this update was already admitted and holds no canonical turn",
      });
    }
    if (source.source_digest !== digestOf(this.#ingress.admittedPayloadFor(update))) {
      return refusal({
        reasonCode: ReasonCode.CONVERSATION_TURN_SOURCE_PAYLOAD_MISMATCH,
        message: "this update id was admitted with a different message",
      });
    }
    const turn = this.#turn(source.turn_request_id);
    const dispatched = this.#cp.db.get<{ turn_request_id: string }>(
      `SELECT turn_request_id FROM canonical_turn_dispatches WHERE turn_request_id = ?`,
      [source.turn_request_id],
    );
    if (!turn || !dispatched) {
      // A claim whose dispatch never committed: the process stopped between the two. Hermes was
      // never told it could run this turn, so it is not told now either.
      return refusal({
        reasonCode: ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN,
        message: "this update's turn was claimed and never dispatched",
      });
    }
    return this.#answer(turn, nonce, true) ?? refusal({
      reasonCode: ReasonCode.CONVERSATION_TARGET_UNVERIFIED,
      message: "the CEO target's bind receipt is not readable",
    });
  }

  #turn(turnRequestId: string): TelegramExternalTurnIdentity | null {
    const row = this.#cp.db.get<{
      turn_request_id: string;
      target_actor_id: string;
      prompt_digest: string;
      binding_generation: number;
      target_binding_id: string;
      target_attestation_id: string;
      executor_session_id: string;
      executor_session_incarnation: string;
    }>(
      `SELECT turn_request_id, target_actor_id, prompt_digest, binding_generation, target_binding_id,
              target_attestation_id, executor_session_id, executor_session_incarnation
         FROM canonical_turns WHERE turn_request_id = ?`,
      [turnRequestId],
    );
    return row
      ? {
          turnRequestId: row.turn_request_id,
          targetActorId: row.target_actor_id,
          promptDigest: row.prompt_digest,
          bindingGeneration: row.binding_generation,
          targetBindingId: row.target_binding_id,
          targetAttestationId: row.target_attestation_id,
          executorSessionId: row.executor_session_id,
          executorSessionIncarnation: row.executor_session_incarnation,
        }
      : null;
  }

  #answer(
    turn: TelegramExternalTurnIdentity,
    nonce: string,
    replayed: boolean,
  ): (TelegramExternalAnswer & { allowed: true }) | null {
    const bind = this.#cp.bindings.historicalHermesTargetBindReceipt({
      targetActorId: turn.targetActorId,
      bindingGeneration: turn.bindingGeneration,
      targetBindingId: turn.targetBindingId,
      targetAttestationId: turn.targetAttestationId,
      executorSessionId: turn.executorSessionId,
      executorSessionIncarnation: turn.executorSessionIncarnation,
    });
    if (!bind) return null;
    return {
      allowed: true,
      replayed,
      turn,
      source: { channel: "telegram", nonce },
      targetBind: { requested_session_id: bind.requested_session_id, lineage_root_digest: bind.lineage_root_digest },
    };
  }

  /**
   * One receipt sweep, raced against the lane's budget. The sweep's own budget only stops it from
   * starting new lookups, and one lookup may take the coordinator's full lookup timeout, so the
   * race is what bounds the wait. A sweep still running when the race ends finishes on its own,
   * exactly as an overlapping periodic sweep does.
   */
  async #reconcileOnce(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#cp.conversation.reconcileUnresolved(this.#reconcileBudgetMs).then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.#reconcileBudgetMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
