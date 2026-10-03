import { request } from "node:http";

import type { TelegramDeliveryReport } from "../conversation/owner-reply-outbox.ts";
import type { ReceiptLookupQuery, ReceiptLookupResult, ReceiptPort } from "../conversation/turn-coordinator.ts";
import { isDigest } from "../core/digest.ts";
import type { Db } from "../db/database.ts";

/**
 * The receipt a Telegram turn's Hermes Gateway records, read back for the coordinator's sweep (U4).
 *
 * Telegram turns run inside the Gateway process, so their receipts live there, not behind
 * `hermes acp`: `HermesReceiptPort`'s `operation: "status"` prompt is refused by the release line
 * for every `_meta.hermes` request. This port asks the Gateway's loopback API instead, with the key
 * the daemon already holds for the Gateway identity readback.
 *
 * It decides nothing. A terminal answer is handed to the coordinator with the identity the Gateway
 * attests to, and `#settleFromReceipt` compares all eight fields against the turn it claimed. A
 * pending, absent, malformed, oversized, slow or refused answer is `found: false`, which leaves the
 * turn in doubt, never evidence that it ran or did not.
 *
 * A `COMPLETED` receipt also says whether Hermes sent the reply in Telegram (A3). Its `delivery` is
 * read as reported and handed on, unverified: the owner-reply outbox compares it with the turn's
 * admitted chat and message and with the reply digest before it records anything.
 */

export interface HermesGatewayReceiptPortOptions {
  /** `ACP_HERMES_GATEWAY_API_KEY`, presented as a Bearer token. */
  apiKey: string;
  /** Ephemeral test listener only; production uses the Gateway's fixed port 8642. */
  port?: number;
}

/** Which Telegram update a turn answers, read from the turn's own source row. */
export interface TelegramTurnSource {
  updateId: number;
}

export type TelegramTurnSourceResolver = (turnRequestId: string) => TelegramTurnSource | null;

export const HERMES_GATEWAY_TURN_RECEIPT_SCHEMA = "hermes.gateway-turn-receipt/v1";
const PATH_PREFIX = "/v1/canonical-surface/receipts/telegram/";
const MAX_BYTES = 4_096;
/** Inside the coordinator's own lookup timeout, and inside the lane's 3 s reconcile budget. */
const TIMEOUT_MS = 2_000;
const NOT_FOUND: ReceiptLookupResult = Object.freeze({ found: false });

const RECEIPT_KEYS = [
  "delivery",
  "evidenceDigest",
  "message_id",
  "reasonCode",
  "receiptId",
  "receiptIdentity",
  "schema",
  "status",
  "turnRequestId",
  "update_id",
] as const;
const IDENTITY_KEYS = [
  "bindingGeneration",
  "executorSessionId",
  "executorSessionIncarnation",
  "promptDigest",
  "targetActorId",
  "targetAttestationId",
  "targetBindingId",
  "turnRequestId",
] as const;
/**
 * The `delivery.state` Hermes writes once the reply's Telegram send succeeded: the one value that
 * confirms a delivery (A3). Hermes' token, not ACP's, so it is named here and nowhere else.
 */
export const HERMES_DELIVERY_CONFIRMED_STATE = "delivered";
/**
 * Every key of a `COMPLETED` receipt's `delivery`, and nothing else (hermes.gateway-turn-receipt/v1,
 * as Hermes and ACP agreed it for #1036). Hermes' earlier `{obligation_id, state, content_digest}`
 * names no chat and no replied-to message, so nothing could be checked against the turn, and it is
 * not read as a receipt at all.
 */
const DELIVERY_KEYS = [
  "chat_id",
  "content_digest",
  "message_ids",
  "obligation_id",
  "reply_to_message_id",
  "state",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

const boundedText = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

const positiveId = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

/**
 * What the receipt says about the reply's Telegram delivery, each field kept only when it has the
 * type the contract gives it. A value of the wrong type is `null` rather than a refusal of the whole
 * receipt: the turn did complete, and the outbox records the delivery evidence as rejected instead.
 */
const deliveryReport = (delivery: Record<string, unknown>): TelegramDeliveryReport => {
  const ids = delivery["message_ids"];
  const messageIds = Array.isArray(ids) && ids.length > 0 && ids.every((id) => positiveId(id) !== null)
    ? (ids as number[]).slice()
    : null;
  const obligationId = delivery["obligation_id"];
  const contentDigest = delivery["content_digest"];
  return {
    confirmed: delivery["state"] === HERMES_DELIVERY_CONFIRMED_STATE,
    obligationId: boundedText(obligationId) ? obligationId : null,
    contentDigest: isDigest(contentDigest) ? contentDigest : null,
    chatId: positiveId(delivery["chat_id"]),
    replyToMessageId: positiveId(delivery["reply_to_message_id"]),
    messageIds,
  };
};

/**
 * A terminal answer for exactly this update, or null. Every key is named: an answer carrying a key
 * this build does not know is not a receipt this build can read, and reading it as one would be
 * guessing at what the extra field meant.
 */
const terminalReceipt = (body: unknown, source: TelegramTurnSource): ReceiptLookupResult => {
  if (!isRecord(body)) return NOT_FOUND;
  const { content, ...rest } = body;
  if (!sameKeys(rest, RECEIPT_KEYS) || (content !== undefined && typeof content !== "string")) return NOT_FOUND;
  if (rest["schema"] !== HERMES_GATEWAY_TURN_RECEIPT_SCHEMA) return NOT_FOUND;
  // The answer has to be about the update this turn consumed. The message id is not compared: the
  // eight identity fields below already name the turn, and the update id names its source.
  if (rest["update_id"] !== source.updateId) return NOT_FOUND;
  const messageId = rest["message_id"];
  if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId < 1) return NOT_FOUND;
  const status = rest["status"];
  if (status !== "COMPLETED" && status !== "ABORTED") return NOT_FOUND;

  const identity = rest["receiptIdentity"];
  if (!isRecord(identity) || !sameKeys(identity, IDENTITY_KEYS)) return NOT_FOUND;
  const generation = identity["bindingGeneration"];
  if (
    !boundedText(identity["turnRequestId"]) || !boundedText(identity["targetActorId"]) ||
    !isDigest(identity["promptDigest"]) ||
    typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 ||
    !boundedText(identity["targetBindingId"]) || !boundedText(identity["targetAttestationId"]) ||
    !boundedText(identity["executorSessionId"]) || !boundedText(identity["executorSessionIncarnation"])
  ) return NOT_FOUND;
  // The top-level turn id is the Gateway's index into its store; the identity is what it attests.
  // Two different answers in one body are no answer.
  if (rest["turnRequestId"] !== identity["turnRequestId"]) return NOT_FOUND;

  const receiptId = rest["receiptId"];
  if (!boundedText(receiptId) || !receiptId.startsWith("hermes-tg:") || receiptId.length === "hermes-tg:".length) {
    return NOT_FOUND;
  }
  if (!isDigest(rest["evidenceDigest"]) || !boundedText(rest["reasonCode"], 128)) return NOT_FOUND;
  const delivery = rest["delivery"];
  if (delivery !== null && (!isRecord(delivery) || !sameKeys(delivery, DELIVERY_KEYS))) return NOT_FOUND;
  // An aborted turn sent no reply. One that says it both aborted and delivered says two things,
  // and settling it ABORTED would permit a re-run of a turn the owner was already answered for.
  if (status === "ABORTED" && delivery !== null) return NOT_FOUND;

  return {
    found: true,
    outcome: status,
    receiptId,
    evidenceDigest: rest["evidenceDigest"],
    reasonCode: rest["reasonCode"],
    turnRequestId: identity["turnRequestId"],
    targetActorId: identity["targetActorId"],
    promptDigest: identity["promptDigest"],
    bindingGeneration: generation,
    targetBindingId: identity["targetBindingId"],
    targetAttestationId: identity["targetAttestationId"],
    executorSessionId: identity["executorSessionId"],
    executorSessionIncarnation: identity["executorSessionIncarnation"],
    ...(status === "COMPLETED" ? { delivery: delivery === null ? null : deliveryReport(delivery) } : {}),
  };
};

const getReceipt = (
  options: { apiKey: string; port: number },
  updateId: number,
  signal: AbortSignal,
): Promise<unknown> =>
  new Promise<unknown>((resolve, reject) => {
    const failure = (): Error => new Error("Gateway turn receipt unavailable");
    const req = request({
      hostname: "127.0.0.1",
      family: 4,
      port: options.port,
      path: `${PATH_PREFIX}${updateId}`,
      method: "GET",
      agent: false,
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal,
    }, (res) => {
      if (res.statusCode !== 200 ||
          (res.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json" ||
          Number(res.headers["content-length"] ?? 0) > MAX_BYTES) {
        reject(failure());
        res.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          reject(failure());
          res.destroy();
        } else chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch { reject(failure()); }
      });
      res.on("error", () => reject(failure()));
      res.on("aborted", () => reject(failure()));
    });
    const timer = setTimeout(() => {
      reject(failure());
      req.destroy();
    }, TIMEOUT_MS);
    req.on("error", () => reject(failure()));
    req.on("close", () => clearTimeout(timer));
    req.end();
  });

export class HermesGatewayReceiptPort implements ReceiptPort {
  /** Its `COMPLETED` receipts carry Hermes' Telegram delivery evidence (A3). */
  readonly reportsTelegramDelivery = true;
  readonly #apiKey: string;
  readonly #port: number;
  readonly #sourceOf: TelegramTurnSourceResolver;

  constructor(sourceOf: TelegramTurnSourceResolver, options: HermesGatewayReceiptPortOptions) {
    const port = options.port ?? 8642;
    if (typeof options.apiKey !== "string" || !/^[\x21-\x7e]+$/.test(options.apiKey)) {
      throw new Error("the Hermes Gateway receipt port needs a printable API key");
    }
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error("the Hermes Gateway receipt port needs a TCP port");
    }
    this.#apiKey = options.apiKey;
    this.#port = port;
    this.#sourceOf = sourceOf;
  }

  async lookup(query: ReceiptLookupQuery, signal: AbortSignal): Promise<ReceiptLookupResult> {
    const source = this.#sourceOf(query.turnRequestId);
    if (!source || signal.aborted) return NOT_FOUND;
    try {
      const body = await getReceipt({ apiKey: this.#apiKey, port: this.#port }, source.updateId, signal);
      return terminalReceipt(body, source);
    } catch {
      return NOT_FOUND;
    }
  }
}

const UPDATE_NONCE = /^update:(\d{1,16})$/;

/**
 * The one Telegram update a turn answers, from the turn's own sources. A turn with any other shape
 * (a batch, a Buzz message, a nonce that is not an update id) has no Gateway receipt to ask for,
 * and is left to whatever else can settle it.
 */
export const telegramTurnSource = (db: Db, turnRequestId: string): TelegramTurnSource | null => {
  const sources = db.all<{ source_channel: string; source_nonce: string }>(
    `SELECT source_channel, source_nonce FROM canonical_turn_sources
      WHERE turn_request_id = ?
      ORDER BY batch_ordinal ASC`,
    [turnRequestId],
  );
  if (sources.length !== 1) return null;
  const only = sources[0]!;
  if (only.source_channel !== "telegram") return null;
  const match = UPDATE_NONCE.exec(only.source_nonce);
  const updateId = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(updateId) ? { updateId } : null;
};
