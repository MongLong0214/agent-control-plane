import { type IncomingMessage, request } from "node:http";

import { type TelegramDeliveryReport, telegramChatIdOf } from "../conversation/owner-reply-outbox.ts";
import {
  RECEIPT_LOOKUP_HTTP_ERRORS,
  RECEIPT_LOOKUP_TRANSPORT_CODES,
  type ReceiptLookupError,
  type ReceiptLookupQuery,
  type ReceiptLookupResult,
  type ReceiptPort,
} from "../conversation/turn-coordinator.ts";
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
 * Those are not one event (#1036). A plain `found: false` is the Gateway saying, in its own v1
 * shape, that it has no terminal receipt yet: `NEVER_FOUND` for an update it holds nothing for, or
 * `PENDING` for an admitted turn still running. Every other `found: false` carries a `lookupError`
 * naming why the answer could not be read, down to the first schema check that refused it, so a
 * receipt the Gateway holds but this build cannot read is visible instead of looking like one that
 * does not exist. A 404 is not a not-found: the production Gateway answers an unknown update with
 * `NEVER_FOUND` and keeps 404 for a binding it does not know. The terminal parser is exactly as
 * strict as before; only the reason for a refusal is new.
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
const lookupFailed = (kind: ReceiptLookupError["kind"], detail: string): ReceiptLookupResult =>
  ({ found: false, lookupError: { kind, detail } });
const schemaError = (check: string): ReceiptLookupResult => lookupFailed("SCHEMA", check);

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
const RECEIPT_KEY_SET: ReadonlySet<string> = new Set(RECEIPT_KEYS);
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
    chatId: telegramChatIdOf(delivery["chat_id"]),
    replyToMessageId: positiveId(delivery["reply_to_message_id"]),
    messageIds,
  };
};

interface AttestedIdentity {
  turnRequestId: string;
  targetActorId: string;
  promptDigest: string;
  bindingGeneration: number;
  targetBindingId: string;
  targetAttestationId: string;
  executorSessionId: string;
  executorSessionIncarnation: string;
}

/** The eight-field identity a receipt attests to, or the first check it fails. */
const attestedIdentity = (identity: unknown): AttestedIdentity | string => {
  if (!isRecord(identity) || !sameKeys(identity, IDENTITY_KEYS)) return "identity-keys";
  const turnRequestId = identity["turnRequestId"];
  if (!boundedText(turnRequestId)) return "identity-field:turnRequestId";
  const targetActorId = identity["targetActorId"];
  if (!boundedText(targetActorId)) return "identity-field:targetActorId";
  const promptDigest = identity["promptDigest"];
  if (!isDigest(promptDigest)) return "identity-field:promptDigest";
  const bindingGeneration = identity["bindingGeneration"];
  if (typeof bindingGeneration !== "number" || !Number.isSafeInteger(bindingGeneration) || bindingGeneration < 1) {
    return "identity-field:bindingGeneration";
  }
  const targetBindingId = identity["targetBindingId"];
  if (!boundedText(targetBindingId)) return "identity-field:targetBindingId";
  const targetAttestationId = identity["targetAttestationId"];
  if (!boundedText(targetAttestationId)) return "identity-field:targetAttestationId";
  const executorSessionId = identity["executorSessionId"];
  if (!boundedText(executorSessionId)) return "identity-field:executorSessionId";
  const executorSessionIncarnation = identity["executorSessionIncarnation"];
  if (!boundedText(executorSessionIncarnation)) return "identity-field:executorSessionIncarnation";
  return {
    turnRequestId, targetActorId, promptDigest, bindingGeneration,
    targetBindingId, targetAttestationId, executorSessionId, executorSessionIncarnation,
  };
};

/**
 * Whether the answer names the update this turn consumed, as the integer it is, whatever its status
 * (R1074-03). A string is not read as one, not even its decimal form: the parser is not relaxed for
 * any answer, and the Gateway writes the integer since its serialization correction.
 */
const updateIdFailure = (value: unknown, updateId: number): string | null => {
  if (value === updateId) return null;
  return typeof value === "number" && Number.isSafeInteger(value) ? "update_id-mismatch" : "update_id-type";
};

const messageIdFailure = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return "message_id-type";
  return value < 1 ? "message_id-range" : null;
};

/**
 * The fields a `NEVER_FOUND` answer leaves empty: it names an update and nothing else, so its
 * `turnRequestId` and `receiptIdentity` must be null. A `PENDING` answer, by contrast, must name the
 * turn and carry its full eight-field identity (Hermes' production contract for both, #1036).
 */
const NEVER_FOUND_EMPTY = [
  "message_id", "turnRequestId", "receiptIdentity", "receiptId", "evidenceDigest", "reasonCode", "delivery",
] as const;
/** The fields a `PENDING` answer leaves empty: everything a terminal receipt adds to the turn. */
const PENDING_EMPTY = ["receiptId", "evidenceDigest", "reasonCode", "delivery"] as const;

/**
 * The production Gateway's two non-terminal answers, as a plain not-found when they have exactly its
 * shape: `NEVER_FOUND` names the update and nothing else, and `PENDING` names the update, the turn
 * and its eight-field identity and nothing a terminal receipt adds. Anything else in either is named.
 */
const nonTerminal = (
  rest: Record<string, unknown>,
  content: unknown,
  status: "NEVER_FOUND" | "PENDING",
  source: TelegramTurnSource,
): ReceiptLookupResult => {
  const updateId = updateIdFailure(rest["update_id"], source.updateId);
  if (updateId !== null) return schemaError(updateId);
  if (status === "NEVER_FOUND") {
    if (content !== undefined) return schemaError("never-found-field:content");
    const filled = NEVER_FOUND_EMPTY.find((key) => rest[key] !== null);
    return filled === undefined ? NOT_FOUND : schemaError(`never-found-field:${filled}`);
  }
  // The message the turn answers, when the Gateway names it.
  const messageId = rest["message_id"] === null ? null : messageIdFailure(rest["message_id"]);
  if (messageId !== null) return schemaError(messageId);
  const identity = attestedIdentity(rest["receiptIdentity"]);
  if (typeof identity === "string") return schemaError(identity);
  if (rest["turnRequestId"] !== identity.turnRequestId) return schemaError("turnRequestId-mismatch");
  if (content !== undefined) return schemaError("pending-field:content");
  const filled = PENDING_EMPTY.find((key) => rest[key] !== null);
  return filled === undefined ? NOT_FOUND : schemaError(`pending-field:${filled}`);
};

/**
 * A terminal answer for exactly this update; a plain not-found for the Gateway's own answer that
 * there is no terminal receipt yet; otherwise the first check that refused it. Every key is named:
 * an answer carrying a key this build does not know is not a receipt this build can read, and
 * reading it as one would be guessing at what the extra field meant.
 *
 * The terminal checks and their order are the ones this function has always made; each refusal now
 * names itself instead of reading as "no receipt". A named check is a fixed token, or a key from
 * this file's own lists: nothing from the answer itself is echoed.
 */
const terminalReceipt = (body: unknown, source: TelegramTurnSource): ReceiptLookupResult => {
  if (!isRecord(body)) return schemaError("not-object");
  const { content, ...rest } = body;
  if (Object.keys(rest).some((key) => !RECEIPT_KEY_SET.has(key))) return schemaError("unknown-keys");
  const missing = RECEIPT_KEYS.find((key) => !Object.hasOwn(rest, key));
  if (missing !== undefined) return schemaError(`missing-key:${missing}`);
  if (content !== undefined && typeof content !== "string") return schemaError("content");
  if (rest["schema"] !== HERMES_GATEWAY_TURN_RECEIPT_SCHEMA) return schemaError("schema-name");
  const status = rest["status"];
  // Not terminal yet, or never started: the Gateway has nothing to settle, which is not a failure.
  if (status === "NEVER_FOUND" || status === "PENDING") return nonTerminal(rest, content, status, source);
  // The answer has to be about the update this turn consumed. The message id is not compared: the
  // eight identity fields below already name the turn, and the update id names its source.
  const updateId = updateIdFailure(rest["update_id"], source.updateId);
  if (updateId !== null) return schemaError(updateId);
  const messageId = messageIdFailure(rest["message_id"]);
  if (messageId !== null) return schemaError(messageId);
  if (status !== "COMPLETED" && status !== "ABORTED") return schemaError("status");

  const identity = attestedIdentity(rest["receiptIdentity"]);
  if (typeof identity === "string") return schemaError(identity);
  // The top-level turn id is the Gateway's index into its store; the identity is what it attests.
  // Two different answers in one body are no answer.
  if (rest["turnRequestId"] !== identity.turnRequestId) return schemaError("turnRequestId-mismatch");

  const receiptId = rest["receiptId"];
  if (!boundedText(receiptId) || !receiptId.startsWith("hermes-tg:") || receiptId.length === "hermes-tg:".length) {
    return schemaError("receiptId");
  }
  if (!isDigest(rest["evidenceDigest"])) return schemaError("evidenceDigest");
  if (!boundedText(rest["reasonCode"], 128)) return schemaError("reasonCode");
  const delivery = rest["delivery"];
  if (delivery !== null && (!isRecord(delivery) || !sameKeys(delivery, DELIVERY_KEYS))) return schemaError("delivery-keys");
  // An aborted turn sent no reply. One that says it both aborted and delivered says two things,
  // and settling it ABORTED would permit a re-run of a turn the owner was already answered for.
  if (status === "ABORTED" && delivery !== null) return schemaError("aborted-with-delivery");

  return {
    found: true,
    outcome: status,
    receiptId,
    evidenceDigest: rest["evidenceDigest"],
    reasonCode: rest["reasonCode"],
    ...identity,
    ...(status === "COMPLETED" ? { delivery: delivery === null ? null : deliveryReport(delivery) } : {}),
  };
};

/** What one request to the Gateway came back with, before the body is read as a receipt. */
type GatewayReply =
  | { readonly kind: "BODY"; readonly body: unknown }
  | { readonly kind: "ANSWERED"; readonly result: ReceiptLookupResult };

/** Why the request itself failed: an abort is the caller giving up, anything else the connection. */
const requestFailure = (err: unknown): ReceiptLookupResult => {
  const { name, code } = (err ?? {}) as { name?: unknown; code?: unknown };
  if (name === "AbortError") return lookupFailed("TIMEOUT", "aborted");
  // A known connection error code (`ECONNREFUSED`); any other is `other`.
  return lookupFailed("TRANSPORT", typeof code === "string" && RECEIPT_LOOKUP_TRANSPORT_CODES.includes(code) ? code : "other");
};

/** A JSON body of at most `MAX_BYTES`, or why it could not be read. */
type BodyRead =
  | { readonly kind: "JSON"; readonly body: unknown }
  | { readonly kind: "FAILED"; readonly result: ReceiptLookupResult };

/**
 * Reads a response's JSON body. `done` can be called more than once (an error that follows a
 * refusal); only the first call counts, because every caller settles a promise with it.
 */
const readJson = (res: IncomingMessage, done: (read: BodyRead) => void): void => {
  const failed = (result: ReceiptLookupResult): void => {
    done({ kind: "FAILED", result });
    res.destroy();
  };
  if (Number(res.headers["content-length"] ?? 0) > MAX_BYTES) return failed(lookupFailed("TOO_LARGE", "content-length"));
  const chunks: Buffer[] = [];
  let size = 0;
  res.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BYTES) failed(lookupFailed("TOO_LARGE", "body"));
    else chunks.push(chunk);
  });
  res.on("end", () => {
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      return done({ kind: "FAILED", result: lookupFailed("PARSE", "invalid-json") });
    }
    done({ kind: "JSON", body });
  });
  res.on("error", (err) => done({ kind: "FAILED", result: requestFailure(err) }));
  res.on("aborted", () => done({ kind: "FAILED", result: lookupFailed("TRANSPORT", "response-aborted") }));
};

/**
 * A failed status, with the Gateway's error token when its JSON error answer names one it is known
 * to use (`404:canonical_binding_unknown`), `<status>:other` when it names any other, and the status
 * alone when there is no readable `error`. The answer's own text is never carried.
 */
const statusDetail = (status: number, read: BodyRead): string => {
  if (read.kind !== "JSON" || !isRecord(read.body) || !Object.hasOwn(read.body, "error")) return String(status);
  const error = read.body["error"];
  return `${status}:${typeof error === "string" && RECEIPT_LOOKUP_HTTP_ERRORS.includes(error) ? error : "other"}`;
};

/** The response's media type, or the category a refusal names for it: never the header's text. */
const mediaTypeOf = (header: string | undefined): "application/json" | "missing" | "html" | "text" | "other" => {
  const media = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (media === "application/json") return media;
  if (media === "") return "missing";
  if (media === "text/html") return "html";
  return media.startsWith("text/") ? "text" : "other";
};

const getReceipt = (
  options: { apiKey: string; port: number },
  updateId: number,
  signal: AbortSignal,
): Promise<GatewayReply> =>
  new Promise<GatewayReply>((resolve) => {
    // The first outcome is the answer: a promise settles once, so the error a `destroy()` raises
    // after a refusal cannot replace the refusal's cause.
    const fail = (result: ReceiptLookupResult): void => resolve({ kind: "ANSWERED", result });
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
      const refuse = (result: ReceiptLookupResult): void => {
        fail(result);
        res.destroy();
      };
      const status = res.statusCode ?? 0;
      const media = mediaTypeOf(res.headers["content-type"]);
      // Every status but 200 is a failure, a 404 included: the Gateway answers an update it holds
      // nothing for with NEVER_FOUND, and a 404 names a binding it does not know.
      if (status !== 200) {
        if (media !== "application/json") return refuse(lookupFailed("HTTP_STATUS", String(status)));
        return readJson(res, (read) => fail(lookupFailed("HTTP_STATUS", statusDetail(status, read))));
      }
      if (media !== "application/json") return refuse(lookupFailed("CONTENT_TYPE", media));
      readJson(res, (read) => (read.kind === "JSON" ? resolve({ kind: "BODY", body: read.body }) : fail(read.result)));
    });
    const timer = setTimeout(() => {
      fail(lookupFailed("TIMEOUT", "no-answer"));
      req.destroy();
    }, TIMEOUT_MS);
    req.on("error", (err) => fail(requestFailure(err)));
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
    // A turn with no single Telegram update source has no Gateway receipt to ask for. An already
    // aborted signal needs no check of its own: `request` refuses it with the same AbortError.
    const source = this.#sourceOf(query.turnRequestId);
    if (!source) return NOT_FOUND;
    // Every failure the request can meet is an answer above. Anything that still throws here is
    // not one of them, and reaches the coordinator as a failed lookup, which it counts.
    const reply = await getReceipt({ apiKey: this.#apiKey, port: this.#port }, source.updateId, signal);
    return reply.kind === "BODY" ? terminalReceipt(reply.body, source) : reply.result;
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
