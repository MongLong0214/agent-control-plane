import type { ControlPlane } from "../app/control-plane.ts";
import type { OwnerIdentity } from "../ceo/owner-authority.ts";
import type { ReceiptLookupQuery } from "../conversation/turn-coordinator.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { Role, roleKeyFor } from "../domain/types.ts";
import { IngressGuard, type TurnIdentity } from "./ingress-guard.ts";
import { TelegramIngress, type TelegramUpdate } from "./telegram.ts";

/**
 * U4: Hermes is the only Telegram consumer, and ACP still decides which owner messages become
 * canonical turns.
 *
 * Hermes polls the bot. For an update from the bound owner chat it connects to this lane's socket
 * before running anything, and runs the turn only when the answer is `allowed`. By then ACP has
 * admitted the update, claimed a canonical turn for the Hermes CEO and dispatched it, in one
 * committed transaction, so a turn Hermes runs always has a ledger entry, and the receipt Hermes
 * records for it carries the identity this lane returned.
 *
 * Nothing here is a new authority. The update passes `TelegramIngress.admit` (the shared secret in
 * constant time, the owner and chat allowlists, safe integer ids, the `INGRESS_ADMITTED` payload
 * digest); the turn passes `ConversationTurnCoordinator.claim` (attestation currency, a READY
 * session and its incarnation, the payload digest against admission); and the turn settles only
 * through the coordinator's sealed receipt port and its eight-field match. Every refusal leaves the
 * database as it was: admission, claim and dispatch run in one `txDecision`, so a refused claim or a
 * failed dispatch write takes the admission, and its spent nonce, back with it (R1062-01).
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

/**
 * The deployment facts the external-consumer lane runs on.
 *
 * Hermes polls the bot and is the only process that does. ACP holds no bot token and opens no
 * connection to Telegram; Hermes hands each owner update to ACP's local socket and runs the turn
 * only once ACP has claimed and dispatched it.
 */
export interface TelegramExternalConsumerConfig {
  consumer: "hermes";
  /** `ACP_TELEGRAM_OWNER_ID` / `ACP_TELEGRAM_ALLOWED_OWNER_IDS`, each declared in owner-identities. */
  allowedOwnerIds: readonly string[];
  /** `ACP_TELEGRAM_CHAT_ID` / `ACP_TELEGRAM_ALLOWED_CHAT_IDS`. */
  allowedChatIds: readonly string[];
  /** `ACP_TELEGRAM_EXTERNAL_SECRET`, the value Hermes presents with every update. */
  sharedSecret: string;
}

/**
 * Reads the external-consumer lane's configuration, or null when this deployment has no lane.
 *
 * The lane exists only when `ACP_TELEGRAM_EXTERNAL_CONSUMER=hermes` and `ACP_TELEGRAM_EXTERNAL_SECRET`
 * are both set. The secret is an optional Keychain item, so a deployment that has the flag and not
 * yet the secret starts without the lane rather than refusing. Once both are present, the owner and
 * chat allowlists are required: owners are positive numeric ids declared as `telegram:<id>` in
 * owner-identities, chats are numeric ids. No other `ACP_TELEGRAM_*` variable is read (#1444).
 */
export const configuredTelegramExternalConsumerConfig = (
  ownerIdentities: readonly OwnerIdentity[],
  environment: NodeJS.ProcessEnv = process.env,
): TelegramExternalConsumerConfig | null => {
  const consumer = configuredValue(environment, "ACP_TELEGRAM_EXTERNAL_CONSUMER");
  if (!consumer) return null;
  if (consumer !== "hermes") {
    fail(
      ReasonCode.DAEMON_STARTUP_FAILED,
      "ACP_TELEGRAM_EXTERNAL_CONSUMER names a consumer this build does not know; the only accepted value is hermes",
      { field: "ACP_TELEGRAM_EXTERNAL_CONSUMER" },
    );
  }
  const sharedSecret = configuredValue(environment, "ACP_TELEGRAM_EXTERNAL_SECRET");
  if (!sharedSecret) return null;
  const ownerValues = splitConfig(configuredValue(environment, "ACP_TELEGRAM_OWNER_ID", "ACP_TELEGRAM_ALLOWED_OWNER_IDS"));
  const chatValues = splitConfig(configuredValue(environment, "ACP_TELEGRAM_CHAT_ID", "ACP_TELEGRAM_ALLOWED_CHAT_IDS"));
  const missing: string[] = [];
  if (ownerValues.length === 0) missing.push("ACP_TELEGRAM_OWNER_ID or ACP_TELEGRAM_ALLOWED_OWNER_IDS");
  if (chatValues.length === 0) missing.push("ACP_TELEGRAM_CHAT_ID or ACP_TELEGRAM_ALLOWED_CHAT_IDS");
  if (missing.length > 0) {
    fail(
      ReasonCode.DAEMON_STARTUP_FAILED,
      `Telegram external consumer configuration is partial; missing ${missing.join(", ")}`,
      { missing },
    );
  }
  for (const owner of ownerValues) {
    if (!/^\d+$/u.test(owner) || !Number.isSafeInteger(Number(owner)) || Number(owner) <= 0) fail(
      ReasonCode.DAEMON_STARTUP_FAILED,
      `Telegram owner id is not a positive numeric id: ${owner}`,
      { field: "ACP_TELEGRAM_OWNER_ID", value: owner },
    );
  }
  for (const chat of chatValues) {
    if (!/^-?\d+$/u.test(chat) || !Number.isSafeInteger(Number(chat))) fail(
      ReasonCode.DAEMON_STARTUP_FAILED,
      `Telegram chat id is not numeric: ${chat}`,
      { field: "ACP_TELEGRAM_CHAT_ID", value: chat },
    );
  }
  const declaredOwners = new Set(
    ownerIdentities.filter((identity) => identity.channel === "telegram").map((identity) => identity.actor),
  );
  const undeclared = ownerValues.filter((owner) => !declaredOwners.has(owner));
  if (undeclared.length > 0) {
    fail(
      ReasonCode.DAEMON_STARTUP_FAILED,
      `Telegram owner id(s) are not declared in owner-identities: ${undeclared.join(", ")}`,
      { undeclared },
    );
  }
  return { consumer: "hermes", allowedOwnerIds: ownerValues, allowedChatIds: chatValues, sharedSecret };
};

const configuredValue = (environment: NodeJS.ProcessEnv, ...names: readonly string[]): string => names
  .map((name) => environment[name]?.trim() ?? "")
  .find((value) => value.length > 0) ?? "";

const splitConfig = (value: string): string[] =>
  value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);

/**
 * Builds a receipt lookup only from the verified target proof that was live while the claim is
 * admitted. A restart reads the immutable tuple from the claim; this callback never upgrades an
 * old claim to a new target.
 *
 * `canonicalTurnTarget` refuses whenever more than one actor holds a current attestation, and a
 * live deployment has the Hermes CEO beside several `PRIMARY_CTO` sessions, so that resolver names
 * nothing there. This one asks only for the CEO role's own Hermes target, which is the one the lane
 * claims for. It reads only the turn id and prompt digest from `identity`, so that is all it asks for.
 */
export const receiptIdentityForCurrentHermesCeo = (
  cp: ControlPlane,
  identity: Pick<TurnIdentity, "turnRequestId" | "promptDigest">,
): ReceiptLookupQuery | null => {
  const roleKey = roleKeyFor(Role.CEO);
  const binding = cp.bindings.active(roleKey);
  if (!binding || !cp.bindings.currentHermesTargetBindReceipt({
    roleKey,
    sessionId: binding.sessionId,
    sessionIncarnation: binding.sessionIncarnation,
  })) return null;

  const rows = cp.db.all<{
    actor_id: string;
    binding_generation: number;
    target_binding_id: string;
    target_attestation_id: string;
    executor_session_id: string;
    executor_session_incarnation: string;
  }>(
    `SELECT a.actor_id, a.binding_generation, b.target_binding_id, t.target_attestation_id,
            t.executor_session_id, t.executor_session_incarnation
       FROM assignments a
       JOIN conversational_actors c
         ON c.actor_id = a.actor_id
        AND c.current_session_id = a.session_id
        AND c.current_session_incarnation = a.session_incarnation
       JOIN sessions s
         ON s.session_id = a.session_id
        AND s.incarnation = a.session_incarnation
        AND s.lifecycle = 'READY'
       JOIN actor_target_bindings b
         ON b.target_actor_id = a.actor_id
        AND b.executor_kind = 'hermes'
       JOIN actor_target_attestations t
         ON t.target_binding_id = b.target_binding_id
        AND t.assignment_id = a.assignment_id
        AND t.executor_session_id = a.session_id
        AND t.executor_session_incarnation = a.session_incarnation
        AND t.binding_generation = a.binding_generation
        AND t.protocol_version = 'hermes.target-bind/v1'
        AND t.target_bind_receipt_json IS NOT NULL
        AND t.target_bind_executor_runtime_identity IS NOT NULL
      WHERE a.role_key = ?
        AND a.status = 'ACTIVE'
        AND a.assignment_id = ?
        AND a.binding_generation = ?
        AND a.session_id = ?
        AND a.session_incarnation = ?`,
    [
      roleKey,
      binding.assignmentId,
      binding.bindingGeneration,
      binding.sessionId,
      binding.sessionIncarnation,
    ],
  );
  if (rows.length !== 1) return null;
  const target = rows[0]!;
  return {
    turnRequestId: identity.turnRequestId,
    targetActorId: target.actor_id,
    promptDigest: identity.promptDigest,
    bindingGeneration: target.binding_generation,
    targetBindingId: target.target_binding_id,
    targetAttestationId: target.target_attestation_id,
    executorSessionId: target.executor_session_id,
    executorSessionIncarnation: target.executor_session_incarnation,
  };
};

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

/**
 * One lane per daemon. The guard is this lane's own, with the external consumer's allowlists and no
 * in-flight recovery: an update this lane admitted either holds a dispatched canonical turn or was
 * rolled back, so there is no half-run handler for a redelivery to resume.
 *
 * The guard's ordinary nonce expiry still runs here. It does not decide what this lane recognizes
 * as a replay — the canonical source does, and that never expires — and it keeps the ingress row an
 * unresolved canonical turn's settlement still needs (`IngressGuard.prune`), so expiry costs this
 * lane nothing (R1062-02).
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
   * For a new turn `respond` is the send `ConversationTurnCoordinator.dispatchOnCommit` holds, so it
   * runs only after the admission, the canonical turn and its dispatch row have committed together.
   * Every other answer is a refusal or a replay, and neither writes.
   */
  async handle(value: unknown, respond: (answer: TelegramExternalAnswer) => void): Promise<void> {
    const envelope = parseEnvelope(value);
    if (!envelope.allowed) return respond(refusal(envelope));

    let claimed = this.#claim(envelope.value, respond);
    if (!claimed.allowed && claimed.reasonCode === ReasonCode.CONVERSATION_TURN_IN_DOUBT) {
      // A4. The CEO's previous turn is still in doubt, usually because its receipt has not been
      // swept yet. Ask the receipt port once, inside a bounded wait, and claim again once. The
      // rollback above left nothing behind, so the second claim starts from the same database.
      await this.#reconcileOnce();
      claimed = this.#claim(envelope.value, respond);
    }
    if (!claimed.allowed) {
      if (claimed.reasonCode === ReasonCode.INGRESS_REPLAY_IGNORED) return respond(this.#replay(envelope.value));
      return respond(refusal(claimed));
    }
    // Allowed: `respond` already ran, from the commit of the transaction that dispatched the turn.
  }

  /**
   * Admission, claim and dispatch in one transaction: all three commit, and only then is the answer
   * sent, or none of them leaves a row and no answer is sent.
   */
  #claim(
    envelope: TelegramExternalEnvelope,
    respond: (answer: TelegramExternalAnswer) => void,
  ): Decision<TelegramExternalAnswer & { allowed: true }> {
    const { update } = envelope;
    return this.#cp.db.txDecision((): Decision<TelegramExternalAnswer & { allowed: true }> => {
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
      // R1062-02. `admit` recognizes a replay by its ingress row, and that row expires with the
      // nonce window; the canonical source this lane claimed under the same nonce does not. Past
      // the window `admit` would take a replay for a new update and the claim would collide with
      // the source. Reached only after `admit` checked the secret, the owner and the chat, and the
      // refusal rolls this admission back, so the replay answer below is read without a write.
      if (this.#canonicalSource(admitted.value.nonce)) {
        return deny(
          ReasonCode.INGRESS_REPLAY_IGNORED,
          "this update already holds a canonical turn",
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
      // The dispatch row joins this transaction and the answer waits for its commit (R1062-01): a
      // dispatch write that fails takes the admission and the claim back with it, and a crash
      // before the commit leaves nothing a restart has to recover.
      const dispatched = this.#cp.conversation.dispatchOnCommit(claimed.value, () => respond(answer));
      if (!dispatched.allowed) return deny(dispatched.reasonCode, dispatched.message, dispatched.evidence);
      return allow(ReasonCode.OK, answer);
    });
  }

  /** The canonical source this lane claims under `nonce`, which no ingress expiry removes. */
  #canonicalSource(nonce: string): { turn_request_id: string; source_digest: string } | undefined {
    return this.#cp.db.get<{ turn_request_id: string; source_digest: string }>(
      `SELECT turn_request_id, source_digest FROM canonical_turn_sources
        WHERE source_channel = 'telegram' AND source_nonce = ? AND source_attempt = 1`,
      [nonce],
    );
  }

  /**
   * The answer to an update this lane already claimed, read without writing.
   *
   * Reached only when the update was refused as a replay — by `admit` while its ingress row lives,
   * by `#claim` from the canonical source once that row has expired — and both refuse only after the
   * secret, the allowlists and the ids passed, so the caller here is the authenticated one. The
   * update's own admitted payload decides whether it is the same update: a different text or chat
   * under a spent update id is refused, never answered with the first one's turn.
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
    const source = this.#canonicalSource(nonce);
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
      // A claim with no dispatch. This lane commits the two together, so the turn is not one it
      // claimed — the long-poll lane claims under the same nonces. Hermes was never told it could
      // run this turn, so it is not told now either.
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
