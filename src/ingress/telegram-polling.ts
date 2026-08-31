import type { ControlPlane } from "../app/control-plane.ts";
import type { OwnerIdentity } from "../ceo/owner-authority.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { Role, RunState, roleKeyFor } from "../domain/types.ts";
import { createHermesMcpPort } from "../mcp/hermes-server.ts";
import { IngressGuard } from "./ingress-guard.ts";
import {
  type TelegramReply,
  type TelegramDirectInput,
  TelegramHermesRouter,
  type TelegramOwnerGateSignal,
  type TelegramOwnerPromptRecord,
  type TelegramOwnerPromptRequest,
  type TelegramInterruptPoint,
  type TelegramRouteOutcome,
  type TelegramStoredState,
  type TelegramStoredResponse,
  type TelegramStoredDeliveryFailure,
  type TelegramDeliveryStatus,
} from "./telegram-router.ts";
import { TelegramIngress, type TelegramUpdate } from "./telegram.ts";

export interface TelegramLongPollConfig {
  botToken: string;
  allowedOwnerIds: readonly string[];
  allowedChatIds: readonly string[];
  /** Required deployment gate shared with the parser; long-polling has no public webhook. */
  webhookSecret: string;
  pollTimeoutSeconds?: number;
  retryDelayMs?: number;
  defaultProjectId?: string | null;
  apiBaseUrl?: string;
  /**
   * Operator-asserted redelivery retention (ms) for a transport this repository cannot measure
   * on its own — the escape hatch for `apiBaseUrl` pointed anywhere but the official endpoint.
   *
   * Found missing by review (#682, round 8's third pass): refusing to construct `IngressGuard`
   * for an unmeasured transport (the round-8 fix, kept — see `TelegramBotApi.redeliveryRetentionMs`)
   * is the right default, but it leaves an operator who *does* know their self-hosted server's
   * actual redelivery window with no production way to say so — the safety property was enforced
   * by making the feature permanently unreachable for a deployment this repository supports,
   * which is a much bigger operational change than "the floor tracks the transport". This is read
   * and validated the same way every other `ACP_TELEGRAM_*` setting is (see
   * `configuredTelegramLongPollConfig`), and it is still subject to the same #673 check as a
   * transport-derived retention: an explicit `nonceTtlMs` shorter than this must still be refused
   * — an operator can assert what their transport does, not that a too-short nonce window is
   * safe anyway.
   */
  transportRetentionMs?: number;
}

export interface TelegramGetUpdatesOptions {
  offset?: number;
  timeoutSeconds: number;
  signal?: AbortSignal;
}

export interface TelegramSentMessage {
  messageId: number;
}

/** Small API seam used by both the real Bot API adapter and fake-transport tests. */
export interface TelegramBotTransport {
  getUpdates(options: TelegramGetUpdatesOptions): Promise<readonly TelegramUpdate[]>;
  sendMessage(input: {
    chatId: string;
    text: string;
    replyToMessageId?: number;
    correlationId: string;
  }): Promise<TelegramSentMessage | void>;
  /**
   * How long, in milliseconds, this transport may still redeliver an update whose receipt was
   * never confirmed. `IngressGuard`'s nonce-retention floor (#673) has to be bound to this fact,
   * not to a number picked from the channel's name alone (#682, round 8) — every transport now
   * has to state it. `null` means this transport's redelivery behavior has not been measured and
   * must not be assumed; `IngressGuard` refuses to construct a policy it cannot bound in that
   * case rather than silently reuse a figure that described a different server.
   */
  readonly redeliveryRetentionMs: number | null;
}

export type TelegramDeliveryFailure =
  | {
    kind: "PERMANENT_REJECTION";
    statusCode: number;
    description: string | null;
    migrateToChatId: string | null;
    retryAfterSeconds: null;
  }
  | {
    kind: "RETRYABLE";
    statusCode: number;
    description: string | null;
    migrateToChatId: null;
    retryAfterSeconds: number | null;
  }
  | {
    kind: "GLOBAL_REJECTION";
    statusCode: number;
    description: string | null;
    migrateToChatId: null;
    retryAfterSeconds: null;
  }
  | {
    kind: "UNKNOWN";
    statusCode: null;
    description: null;
    migrateToChatId: null;
    retryAfterSeconds: null;
  };

type TelegramDeliveryPolicy = {
  readonly reply: "RELEASE" | "SETTLE";
  readonly batch: "ADVANCE" | "HOLD_OFFSET" | "STOP";
};

/**
 * The failure classification and its ordered-batch consequence are one policy. Keeping them in
 * one table prevents a durable reply state from claiming one outcome while the poll loop does
 * another. An ambiguous send is terminal for that reply and stops the loop before another message.
 */
const TELEGRAM_DELIVERY_POLICY = {
  PERMANENT_REJECTION: { reply: "SETTLE", batch: "ADVANCE" },
  RETRYABLE: { reply: "RELEASE", batch: "HOLD_OFFSET" },
  GLOBAL_REJECTION: { reply: "RELEASE", batch: "HOLD_OFFSET" },
  UNKNOWN: { reply: "SETTLE", batch: "STOP" },
} as const satisfies Record<TelegramDeliveryFailure["kind"], TelegramDeliveryPolicy>;

/** Carries the delivery and batch-scope facts the Bot API adapter actually observed. */
export class TelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly failure: TelegramDeliveryFailure,
  ) {
    super(message);
    this.name = "TelegramDeliveryError";
  }
}

const unknownDeliveryFailure = (): TelegramDeliveryFailure => ({
  kind: "UNKNOWN",
  statusCode: null,
  description: null,
  migrateToChatId: null,
  retryAfterSeconds: null,
});

const nonTelegramHttpFailure = (statusCode: number): TelegramDeliveryFailure => ({
  kind: "GLOBAL_REJECTION",
  statusCode,
  description: null,
  migrateToChatId: null,
  retryAfterSeconds: null,
});

const telegramStatusCode = (httpStatus: number, payload: unknown): number => {
  const telegramCode = isRecord(payload) ? payload["error_code"] : undefined;
  return Number.isSafeInteger(telegramCode) && Number(telegramCode) > 0
    ? Number(telegramCode)
    : httpStatus;
};

const telegramRetryAfterSeconds = (payload: unknown): number | null => {
  if (!isRecord(payload) || !isRecord(payload["parameters"])) return null;
  const retryAfter = payload["parameters"]["retry_after"];
  return Number.isSafeInteger(retryAfter) && Number(retryAfter) > 0
    ? Number(retryAfter)
    : null;
};

const telegramDescription = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;
  const description = payload["description"];
  return typeof description === "string" && description.trim().length > 0 ? description : null;
};

/** Only this envelope proves Telegram, rather than a proxy or WAF, rejected the request. */
const isTelegramApiError = (payload: unknown): payload is Record<string, unknown> =>
  isRecord(payload)
  && payload["ok"] === false
  && telegramDescription(payload) !== null
  && Number.isSafeInteger(payload["error_code"])
  && Number(payload["error_code"]) > 0;

const telegramMigrateToChatId = (payload: unknown): string | null => {
  if (!isRecord(payload) || !isRecord(payload["parameters"])) return null;
  const migrateToChatId = payload["parameters"]["migrate_to_chat_id"];
  return Number.isSafeInteger(migrateToChatId) ? String(migrateToChatId) : null;
};

/**
 * Telegram exposes no structured error-scope field. Treat a 4xx as request-local only when its
 * description affirmatively identifies the unchanged request or destination as the problem.
 * Unrecognised descriptions deliberately return false so a shared fault cannot consume a reply.
 */
const isTelegramRequestLocalRejection = (payload: unknown): boolean => {
  const description = telegramDescription(payload);
  return telegramMigrateToChatId(payload) !== null
    || description === "Bad Request: reply message not found"
    || description === "Forbidden: bot was blocked by the user";
};

const rejectedDeliveryFailure = (
  statusCode: number,
  payload: unknown,
): TelegramDeliveryFailure => {
  // A retry instruction is shared service state, not evidence that this request is unusable.
  if (statusCode === 429) {
    return {
      kind: "RETRYABLE",
      statusCode,
      description: telegramDescription(payload),
      migrateToChatId: null,
      retryAfterSeconds: telegramRetryAfterSeconds(payload),
    };
  }

  // Status alone cannot establish scope: the self-hosted Bot API uses 421 for a token-range
  // configuration fault. Terminalize only descriptions that identify this request or destination.
  if (statusCode >= 400 && statusCode < 500 && isTelegramRequestLocalRejection(payload)) {
    return {
      kind: "PERMANENT_REJECTION",
      statusCode,
      description: telegramDescription(payload),
      migrateToChatId: telegramMigrateToChatId(payload),
      retryAfterSeconds: null,
    };
  }

  // An otherwise unlisted 5xx is server-side and may recover without changing this message.
  if (statusCode >= 500 && statusCode < 600) {
    return {
      kind: "RETRYABLE",
      statusCode,
      description: telegramDescription(payload),
      migrateToChatId: null,
      retryAfterSeconds: null,
    };
  }

  // No scope evidence means the failure may affect every request. Holding the ordered offset is
  // recoverable; terminalizing an unrecognised shared fault would silently lose the reply.
  return {
    kind: "GLOBAL_REJECTION",
    statusCode,
    description: telegramDescription(payload),
    migrateToChatId: null,
    retryAfterSeconds: null,
  };
};

export interface TelegramLongPollListener {
  service: TelegramLongPollService;
  close(): Promise<void>;
}

export type TelegramLongPollRuntimeStatus =
  | { running: true; stopReason: null; recoveryNonce: null }
  | {
    running: false;
    stopReason: "NOT_STARTED" | "UNKNOWN_DELIVERY" | "CLOSED";
    recoveryNonce: string | null;
  };

export interface TelegramLongPollStartOptions {
  transport?: TelegramBotTransport;
  onError?: (error: unknown) => void;
  onDirect?: (input: TelegramDirectInput) => string | Promise<string>;
  onCeoApproved?: (runId: string) => void | Promise<unknown>;
  /** Production starts polling immediately; tests can drive one poll cycle deterministically. */
  start?: boolean;
  /** Fault-injection seam used to prove restart recovery at each workflow boundary. */
  onInterrupt?: (point: TelegramInterruptPoint, update: TelegramUpdate, runId?: string) => void | Promise<void>;
  /** Durable owner-gate notifications to consume before polling for inbound updates. */
  ownerGateSignals?: () => readonly TelegramOwnerGateSignal[];
  /** Reports the live poll-loop state; durable reply state alone cannot say whether this process stopped. */
  onRuntimeStatus?: (status: TelegramLongPollRuntimeStatus) => void;
}

export type TelegramOwnerPromptDeliveryStatus = "PENDING" | "APPLIED" | "RETRYABLE";

export interface TelegramOwnerPromptReservation {
  key: string;
  runId: string;
  item: string;
  chatId: string;
  candidateSnapshotDigest: string;
  correlationId: string;
}

export interface TelegramOwnerPromptDelivery {
  status: TelegramOwnerPromptDeliveryStatus;
  /** False means another attempt already owns or completed this reservation. */
  acquired: boolean;
  record: TelegramOwnerPromptRecord | null;
}

type TelegramTrackedTurnResult =
  | { ok: true; outcome: TelegramRouteOutcome }
  | { ok: false; error: unknown };

interface TelegramTrackedTurn {
  settled: Promise<void>;
  result: TelegramTrackedTurnResult | null;
}

type TelegramLongPollRouteProgress =
  | { status: "COMPLETED"; outcome: TelegramRouteOutcome }
  | {
    status: "CEO_TURN_PENDING";
    outcome: Promise<TelegramRouteOutcome>;
    deliveryStarted: Promise<void>;
  };

type TelegramUpdateState =
  | { status: "RUNNING" }
  | { status: "RETRYABLE"; retryAt: number }
  | { status: "SETTLED" };

type TelegramUpdateReservation =
  | { reserved: true }
  | { reserved: false; retryInMs?: number };

export type TelegramPollRoute =
  | { status: "COMPLETED"; outcome: TelegramRouteOutcome }
  | { status: "CEO_TURN_PENDING"; outcome: Promise<TelegramRouteOutcome> };

export interface TelegramSettledPollCycle {
  outcomes: TelegramRouteOutcome[];
  nextOffset?: number;
}

/**
 * The honest boundary returned by `pollOnce`: ordinary routes are complete, while a CEO turn is
 * named as pending. `settled()` observes this cycle's completed outcomes and the cursor after they
 * finish; `nextOffsetAtReturn` is only the cursor snapshot taken when polling itself returned.
 */
export interface TelegramPollCycle {
  routes: TelegramPollRoute[];
  nextOffsetAtReturn?: number;
  settled(): Promise<TelegramSettledPollCycle>;
}

/** Durable reservation port for owner prompts; production wires this to the CP database. */
export interface TelegramOwnerPromptStore {
  reserve(input: TelegramOwnerPromptReservation): Decision<TelegramOwnerPromptDelivery>;
  complete(input: { reservation: TelegramOwnerPromptReservation; record: TelegramOwnerPromptRecord }): Decision<void>;
  release(input: TelegramOwnerPromptReservation): Decision<void>;
}

/**
 * Reads the owner-provided Telegram deployment facts. Telegram is optional at the deployment
 * boundary, but once any Telegram variable is present every required fact must be supplied:
 * there is no anonymous bot mode, no empty chat allowlist, and no implicit owner identity.
 */
export const configuredTelegramLongPollConfig = (
  ownerIdentities: readonly OwnerIdentity[],
  environment: NodeJS.ProcessEnv = process.env,
): TelegramLongPollConfig | null => {
  const botToken = configuredValue(environment, "ACP_TELEGRAM_BOT_TOKEN");
  const ownerRaw = configuredValue(environment, "ACP_TELEGRAM_OWNER_ID", "ACP_TELEGRAM_ALLOWED_OWNER_IDS");
  const chatRaw = configuredValue(environment, "ACP_TELEGRAM_CHAT_ID", "ACP_TELEGRAM_ALLOWED_CHAT_IDS");
  const webhookSecret = configuredValue(environment, "ACP_TELEGRAM_WEBHOOK_SECRET");
  const configuredVariables = TELEGRAM_ENVIRONMENT_VARIABLES.filter((name) =>
    configuredValue(environment, name).length > 0,
  );
  if (configuredVariables.length === 0) return null;

  const missing: string[] = [];
  if (!botToken) missing.push("ACP_TELEGRAM_BOT_TOKEN");
  if (!ownerRaw) missing.push("ACP_TELEGRAM_OWNER_ID or ACP_TELEGRAM_ALLOWED_OWNER_IDS");
  if (!chatRaw) missing.push("ACP_TELEGRAM_CHAT_ID or ACP_TELEGRAM_ALLOWED_CHAT_IDS");
  if (!webhookSecret) missing.push("ACP_TELEGRAM_WEBHOOK_SECRET");
  if (missing.length > 0) {
    fail(
      ReasonCode.DAEMON_STARTUP_FAILED,
      `Telegram ingress configuration is partial; missing ${missing.join(", ")}`,
      { configuredVariables, missing },
    );
  }

  const ownerValues = splitConfig(ownerRaw);
  for (const owner of ownerValues) {
    if (!isPositiveTelegramId(owner)) fail(
      ReasonCode.DAEMON_STARTUP_FAILED,
      `Telegram owner id is not a positive numeric id: ${owner}`,
      { field: "ACP_TELEGRAM_OWNER_ID", value: owner },
    );
  }

  const chatValues = splitConfig(chatRaw);
  for (const chat of chatValues) {
    if (!isTelegramId(chat)) fail(
      ReasonCode.DAEMON_STARTUP_FAILED,
      `Telegram chat id is not numeric: ${chat}`,
      { field: "ACP_TELEGRAM_CHAT_ID", value: chat },
    );
  }

  const declaredOwners = new Set(
    ownerIdentities
      .filter((identity) => identity.channel === "telegram")
      .map((identity) => identity.actor),
  );
  const undeclared = ownerValues.filter((owner) => !declaredOwners.has(owner));
  if (undeclared.length > 0) {
    fail(
      ReasonCode.DAEMON_STARTUP_FAILED,
      `Telegram owner id(s) are not declared in owner-identities: ${undeclared.join(", ")}`,
      { undeclared },
    );
  }

  const pollTimeoutSeconds = parseBoundedInteger(
    environment["ACP_TELEGRAM_POLL_TIMEOUT_SECONDS"],
    1,
    50,
    50,
  );
  const retryDelayMs = parseBoundedInteger(
    environment["ACP_TELEGRAM_RETRY_DELAY_MS"],
    100,
    300_000,
    5_000,
  );
  const defaultProjectId = environment["ACP_TELEGRAM_DEFAULT_PROJECT_ID"]?.trim() || null;
  const apiBaseUrl = environment["ACP_TELEGRAM_API_BASE_URL"]?.trim() || undefined;
  // 1 minute to 30 days: below the floor a "retention" is not what that word means for a
  // redelivery queue, and above it is far past anything #673's own measurement considered —
  // both ends exist to catch a typo (seconds where milliseconds were meant, or the reverse)
  // rather than to second-guess an operator's real number.
  const transportRetentionMs = parseOptionalBoundedInteger(
    environment["ACP_TELEGRAM_TRANSPORT_RETENTION_MS"],
    60_000,
    30 * 24 * 60 * 60 * 1000,
  );

  return {
    botToken,
    allowedOwnerIds: ownerValues,
    allowedChatIds: chatValues,
    webhookSecret,
    pollTimeoutSeconds,
    retryDelayMs,
    defaultProjectId,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(transportRetentionMs !== undefined ? { transportRetentionMs } : {}),
  };
};

/** The endpoint #673's ~24h `getUpdates` retention figure was actually measured against. */
const OFFICIAL_TELEGRAM_API_BASE_URL = "https://api.telegram.org";

/** Real outbound Telegram Bot API transport. The token never appears in an error message. */
export class TelegramBotApi implements TelegramBotTransport {
  private readonly baseUrl: string;
  /**
   * 24h only when this instance talks to the official endpoint that figure was measured
   * against. `ACP_TELEGRAM_API_BASE_URL` can point this same class at a self-hosted Bot API
   * server or any other endpoint, whose queue retention nobody here has measured — reusing the
   * official number for it would be #673's original mistake in a new place (#682, round 8), so
   * this reports unknown instead.
   */
  readonly redeliveryRetentionMs: number | null;

  constructor(
    private readonly botToken: string,
    options: { apiBaseUrl?: string; fetcher?: typeof fetch } = {},
  ) {
    if (botToken.trim().length === 0) throw new Error("Telegram Bot API requires a non-empty bot token");
    this.baseUrl = (options.apiBaseUrl ?? OFFICIAL_TELEGRAM_API_BASE_URL).replace(/\/$/u, "");
    this.redeliveryRetentionMs = this.baseUrl === OFFICIAL_TELEGRAM_API_BASE_URL
      ? 24 * 60 * 60 * 1000
      : null;
    this.fetcher = options.fetcher ?? fetch;
  }

  private readonly fetcher: typeof fetch;

  async getUpdates(options: TelegramGetUpdatesOptions): Promise<readonly TelegramUpdate[]> {
    const timeoutSeconds = options.timeoutSeconds;
    const body = {
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
      ...(options.offset === undefined ? {} : { offset: options.offset }),
    };
    const response = await this.call("getUpdates", body, options.signal, (timeoutSeconds + 10) * 1000);
    if (!Array.isArray(response)) throw new Error("Telegram getUpdates returned a non-array result");
    return response.map((update, index) => parseTelegramUpdate(update, index));
  }

  async sendMessage(input: {
    chatId: string;
    text: string;
    replyToMessageId?: number;
    correlationId: string;
  }): Promise<TelegramSentMessage> {
    const result = await this.call("sendMessage", {
      chat_id: input.chatId,
      text: input.text,
      ...(input.replyToMessageId === undefined ? {} : { reply_to_message_id: input.replyToMessageId }),
      allow_sending_without_reply: true,
    });
    if (!result || typeof result !== "object" || !Number.isSafeInteger((result as { message_id?: unknown }).message_id)) {
      throw new TelegramDeliveryError("Telegram Bot API sendMessage returned no message id", unknownDeliveryFailure());
    }
    return { messageId: (result as { message_id: number }).message_id };
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    try {
      const response = await this.fetcher(`${this.baseUrl}/bot${this.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let parsed: unknown = null;
      try {
        parsed = await response.json() as unknown;
      } catch (error) {
        if (response.ok) throw error;
      }
      if (!response.ok) {
        if (!isTelegramApiError(parsed)) {
          throw new TelegramDeliveryError(
            `Telegram Bot API ${method} received a non-Telegram HTTP ${response.status} response`,
            nonTelegramHttpFailure(response.status),
          );
        }
        throw new TelegramDeliveryError(
          `Telegram Bot API ${method} returned HTTP ${response.status}`,
          rejectedDeliveryFailure(telegramStatusCode(response.status, parsed), parsed),
        );
      }
      if (!parsed || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok !== true) {
        if (!isTelegramApiError(parsed)) {
          throw new TelegramDeliveryError(
            `Telegram Bot API ${method} returned an invalid success response`,
            unknownDeliveryFailure(),
          );
        }
        throw new TelegramDeliveryError(
          `Telegram Bot API ${method} refused the request`,
          rejectedDeliveryFailure(telegramStatusCode(response.status, parsed), parsed),
        );
      }
      return (parsed as { result?: unknown }).result;
    } catch (error) {
      if (error instanceof TelegramDeliveryError) throw error;
      if (controller.signal.aborted && !signal?.aborted) {
        throw new TelegramDeliveryError(`Telegram Bot API ${method} timed out`, unknownDeliveryFailure());
      }
      throw new TelegramDeliveryError(
        error instanceof Error ? error.message : `Telegram Bot API ${method} failed`,
        unknownDeliveryFailure(),
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export class TelegramLongPollService {
  #running = false;
  #closed = false;
  #loopPromise: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #terminalDeliveryError: TelegramDeliveryError | null = null;
  #terminalDeliveryNonce: string | null = null;
  #offset: number | undefined;
  readonly #pendingTurns = new Set<TelegramTrackedTurn>();
  readonly #turnFailures: unknown[] = [];
  readonly #updateStates = new Map<number, TelegramUpdateState>();
  readonly #updateOrder: number[] = [];

  constructor(
    private readonly transport: TelegramBotTransport,
    private readonly router: TelegramHermesRouter,
    private readonly webhookSecret: string,
    private readonly options: {
      pollTimeoutSeconds?: number;
      retryDelayMs?: number;
      allowedChatIds?: readonly string[];
      nowIso?: () => string;
      onError?: (error: unknown) => void;
      onInterrupt?: (point: TelegramInterruptPoint, update: TelegramUpdate, runId?: string) => void | Promise<void>;
      ownerGateSignals?: () => readonly TelegramOwnerGateSignal[];
      ownerPromptStore?: TelegramOwnerPromptStore;
      onRuntimeStatus?: (status: TelegramLongPollRuntimeStatus) => void;
    } = {},
  ) {
    if (webhookSecret.trim().length === 0) {
      throw new Error("Telegram long-poll requires a non-empty webhook secret");
    }
  }

  get offset(): number | undefined {
    return this.#offset;
  }

  /**
   * Waits for every route already handed to the listener and rejects with any fault it recorded.
   *
   * CEO turns leave `pollOnce` in #630, so a caller cannot use that poll promise as evidence that
   * a turn finished. Faults are retained until this method observes them; the rejection is
   * not inferred from an empty outcome list, which would make "nothing failed" indistinguishable
   * from "the test never looked".
   */
  async pendingTurnsSettled(): Promise<void> {
    while (this.#pendingTurns.size > 0) {
      await Promise.all([...this.#pendingTurns].map((turn) => turn.settled));
    }
    const failures = this.#turnFailures.splice(0);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `${failures.length} Telegram turns failed`);
    }
  }

  /**
   * Send and durably record a gate prompt. The router samples the candidate before this call
   * reaches Telegram; the returned Telegram message id is then the only reply provenance the
   * owner-decision path accepts.
   */
  async sendOwnerPrompt(input: TelegramOwnerPromptRequest): Promise<Decision<TelegramOwnerPromptRecord>> {
    const items = uniquePromptItems(input.items);
    if (items.length !== 1) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "Telegram owner prompt delivery requires exactly one gate item",
        { runId: input.runId, itemCount: items.length },
      );
    }
    const delivered = await this.sendOwnerPromptIfNeeded({ ...input, items });
    if (!delivered.allowed) return delivered as Decision<TelegramOwnerPromptRecord>;
    if (!delivered.value.record) {
      return deny(
        ReasonCode.RESOURCE_COLLISION,
        "Telegram owner prompt delivery is already reserved and cannot be replayed",
        { runId: input.runId, status: delivered.value.status },
      );
    }
    return allow(delivered.reasonCode, delivered.value.record, delivered.evidence);
  }

  /**
   * The daemon uses this form so an already-PENDING reservation is a successful no-op rather
   * than an error. A PENDING reservation is deliberately never retried: Telegram may already
   * have accepted the earlier prompt, exactly like the reply protocol below.
   */
  async sendOwnerPromptIfNeeded(
    input: TelegramOwnerPromptRequest,
  ): Promise<Decision<TelegramOwnerPromptDelivery>> {
    if (this.options.allowedChatIds && !this.options.allowedChatIds.includes(input.chatId)) {
      return deny(
        ReasonCode.INGRESS_CHAT_NOT_ALLOWLISTED,
        "Telegram owner prompt chat is not on the configured allowlist",
        { chatId: input.chatId },
      );
    }
    const prepared = this.router.prepareOwnerPrompt(input);
    if (!prepared.allowed) return prepared;

    const items = uniquePromptItems(input.items);
    if (items.length !== 1) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "Telegram owner prompt delivery requires exactly one gate item",
        { runId: input.runId, itemCount: items.length },
      );
    }
    const item = items[0]!;
    const reservation: TelegramOwnerPromptReservation = {
      key: ownerPromptReservationKey({
        runId: prepared.value.runId,
        item,
        chatId: prepared.value.chatId,
        candidateSnapshotDigest: prepared.value.candidateSnapshotDigest,
      }),
      runId: prepared.value.runId,
      item,
      chatId: prepared.value.chatId,
      candidateSnapshotDigest: prepared.value.candidateSnapshotDigest,
      correlationId: prepared.value.correlationId,
    };
    const reserved = this.options.ownerPromptStore?.reserve(reservation) ?? allow(ReasonCode.OK, {
      status: "PENDING",
      acquired: true,
      record: null,
    });
    if (!reserved.allowed) return reserved;
    if (!reserved.value.acquired) return allow(reserved.reasonCode, reserved.value, reserved.evidence);

    let sent: TelegramSentMessage | void;
    try {
      sent = await this.transport.sendMessage({
        chatId: prepared.value.chatId,
        text: prepared.value.text,
        correlationId: prepared.value.correlationId,
      });
    } catch (error) {
      if (error instanceof TelegramDeliveryError && error.failure.kind !== "UNKNOWN") {
        const released = this.options.ownerPromptStore?.release(reservation);
        if (released && !released.allowed) throw new Error(`${released.reasonCode}: ${released.message}`);
      }
      throw error;
    }
    const messageId = sent && typeof sent === "object" && Number.isSafeInteger(sent.messageId)
      ? sent.messageId
      : null;
    if (messageId === null || messageId <= 0) {
      return deny(
        ReasonCode.INTERNAL_ERROR,
        "Telegram did not return the accepted owner-prompt message id",
        { correlationId: prepared.value.correlationId },
      );
    }
    const record: TelegramOwnerPromptRecord = {
      runId: prepared.value.runId,
      chatId: prepared.value.chatId,
      candidateSnapshotDigest: prepared.value.candidateSnapshotDigest,
      correlationId: prepared.value.correlationId,
      messageId,
      createdAt: this.options.nowIso?.() ?? new Date().toISOString(),
    };
    const persisted = this.options.ownerPromptStore
      ? this.options.ownerPromptStore.complete({ reservation, record })
      : this.router.recordPreparedOwnerPrompt(record);
    if (!persisted.allowed) return persisted as Decision<TelegramOwnerPromptDelivery>;
    return allow(ReasonCode.OK, {
      status: "APPLIED",
      acquired: true,
      record,
    }, persisted.evidence);
  }

  async pollOnce(): Promise<TelegramPollCycle> {
    if (this.#terminalDeliveryError) throw this.#terminalDeliveryError;

    // Receive first. Owner-gate prompts are outbound and incidental to this loop; the inbound
    // batch is the owner's only way to reach the daemon. Delivering prompts first meant one
    // undeliverable prompt — a denied `sendOwnerPromptIfNeeded`, a Telegram 5xx — threw past
    // `getUpdates` and stopped every inbound command, including the reply that would have
    // resolved the run whose prompt could not be sent.
    const updates = await this.transport.getUpdates({
      ...(this.#offset === undefined ? {} : { offset: this.#offset }),
      timeoutSeconds: this.options.pollTimeoutSeconds ?? 50,
      signal: this.#controller?.signal,
    });
    const routes: TelegramPollRoute[] = [];
    let retryInMs: number | undefined;
    for (const update of updates) {
      if (this.#offset !== undefined && update.update_id < this.#offset) continue;
      const reservation = this.reserveUpdate(update.update_id);
      if (!reservation.reserved) {
        if (reservation.retryInMs !== undefined) {
          retryInMs = Math.min(retryInMs ?? reservation.retryInMs, reservation.retryInMs);
        }
        continue;
      }

      try {
        const progress = await this.routeUpdate(update);
        if (progress.status === "COMPLETED") {
          this.completeUpdate(update.update_id);
          routes.push(progress);
          continue;
        }

        const route = progress.outcome.then(
          (outcome) => {
            this.completeUpdate(update.update_id);
            return outcome;
          },
          (error: unknown) => {
            this.retryUpdate(update.update_id, error);
            throw error;
          },
        );
        routes.push({ status: "CEO_TURN_PENDING", outcome: route });
        const turn = this.trackTurn(route);
        // A CEO call that is still pending may detach, but once it reaches Telegram the ordered
        // batch waits for that external result. A slow terminal rejection must stop the batch
        // before the next update can be parked and consumed by the unresolved-turn policy.
        const deliveryStarted = await Promise.race([
          progress.deliveryStarted.then(() => true),
          delay(0).then(() => false),
        ]);
        if (deliveryStarted) await turn.settled;
        if (this.#terminalDeliveryError) break;
      } catch (error) {
        // Non-CEO routes remain inside pollOnce, so their rejection still reaches loop()'s
        // reporter and retry delay exactly as it did before the CEO turn was detached.
        this.retryUpdate(update.update_id, error);
        throw error;
      }
    }

    // A pending CEO turn has been accepted into a tracked task before incidental outbound prompts
    // run. Managed routes and owner decisions still finish here; only the CEO call leaves the poll.
    if (!this.#terminalDeliveryError) await this.deliverOwnerGatePrompts();
    if (routes.length === 0 && updates.length > 0) {
      if (retryInMs !== undefined) {
        // A detached CEO failure no longer reaches loop()'s catch. Its update-local deadline is the
        // replacement observer: keep the held offset, but do not ask Telegram for this update in
        // a hot loop or schedule its route again before the configured backoff expires.
        await delay(retryInMs);
      } else if (this.#pendingTurns.size > 0) {
        // Holding the offset makes Telegram return the running update immediately. A bounded pause
        // prevents a hot loop without waiting for the CEO turn itself; a newly arrived update is
        // delayed by at most 100ms before the next getUpdates call can schedule it.
        await delay(Math.min(this.options.retryDelayMs ?? 5_000, 100));
      }
    }
    return {
      routes,
      ...(this.#offset === undefined ? {} : { nextOffsetAtReturn: this.#offset }),
      settled: async () => {
        const outcomes = await Promise.all(routes.map((route) => route.outcome));
        return {
          outcomes,
          ...(this.#offset === undefined ? {} : { nextOffset: this.#offset }),
        };
      },
    };
  }

  start(): void {
    if (this.#running) return;
    if (this.#closed) throw new Error("Telegram long-poll listener is closed");
    if (this.#terminalDeliveryError) throw this.#terminalDeliveryError;
    this.#running = true;
    this.options.onRuntimeStatus?.({ running: true, stopReason: null, recoveryNonce: null });
    this.#loopPromise = this.loop();
  }

  /** Resumes only the stop whose durable UNKNOWN reply the operator actually acknowledged. */
  async resumeAfterAcknowledgement(nonce: string): Promise<boolean> {
    if (this.#closed || this.#terminalDeliveryNonce !== nonce) return false;
    // Keep the terminal marker set until the old loop has observed it and exited. Clearing it
    // earlier can let that loop continue while start() creates a second poller over the same
    // offset and controller.
    await this.#loopPromise;
    if (this.#closed || this.#terminalDeliveryNonce !== nonce) return false;
    this.#terminalDeliveryError = null;
    this.#terminalDeliveryNonce = null;
    this.start();
    return true;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#running = false;
    this.#controller?.abort();
    await this.#loopPromise;
    await this.pendingTurnsSettled();
    this.#loopPromise = null;
    this.#controller = null;
    this.options.onRuntimeStatus?.({ running: false, stopReason: "CLOSED", recoveryNonce: null });
  }

  private async loop(): Promise<void> {
    while (this.#running) {
      this.#controller = new AbortController();
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.#running) {
          if (!this.#controller.signal.aborted) this.options.onError?.(error);
          break;
        }
        this.options.onError?.(error);
        await delay(deliveryRetryDelayMs(error, this.options.retryDelayMs ?? 5_000));
      } finally {
        this.#controller = null;
      }
    }
  }

  private trackTurn(route: Promise<TelegramRouteOutcome>): TelegramTrackedTurn {
    const turn: TelegramTrackedTurn = { settled: Promise.resolve(), result: null };
    turn.settled = route.then(
      (outcome) => {
        turn.result = { ok: true, outcome };
      },
      (error: unknown) => {
        turn.result = { ok: false, error };
        if (this.options.onError) {
          try {
            this.options.onError(error);
          } catch (reportingError) {
            this.#turnFailures.push(new AggregateError(
              [error, reportingError],
              "Telegram turn and its error reporter both failed",
            ));
          }
        } else {
          this.#turnFailures.push(error);
        }
      },
    ).finally(() => {
      this.#pendingTurns.delete(turn);
    });
    this.#pendingTurns.add(turn);
    return turn;
  }

  private async routeUpdate(update: TelegramUpdate): Promise<TelegramLongPollRouteProgress> {
    const progress = await this.router.routeUntilCeoTurn(update, this.webhookSecret);
    if (progress.status === "COMPLETED") {
      return { status: "COMPLETED", outcome: await this.deliverRouteOutcome(update, progress.outcome) };
    }
    let markDeliveryStarted!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
    return {
      status: "CEO_TURN_PENDING",
      deliveryStarted,
      outcome: progress.outcome.then((outcome) => {
        markDeliveryStarted();
        return this.deliverRouteOutcome(update, outcome);
      }),
    };
  }

  private async deliverRouteOutcome(
    update: TelegramUpdate,
    outcome: TelegramRouteOutcome,
  ): Promise<TelegramRouteOutcome> {
    if (!outcome.reply) {
      // A fresh claimed turn whose handler produced no reply is complete, and no later reply
      // lifecycle step can resolve it. Replayed outcomes also carry reply: null when an earlier
      // send remains PENDING; resolveNoReplyOutcome deliberately leaves those untouched (#682).
      this.router.resolveNoReplyOutcome(outcome);
      return outcome;
    }

    // Reserve before the external call. A reservation left PENDING after an ambiguous return is
    // never replayed. A verified request-local rejection is terminal; intermediary responses,
    // shared/global rejections and 429/5xx release the reservation and keep the update retryable.
    this.router.reserveResponse(outcome);
    await this.options.onInterrupt?.("after-reply-reserve", update, outcome.runId);
    try {
      await this.transport.sendMessage(outcome.reply);
      await this.options.onInterrupt?.("after-reply-send", update, outcome.runId);
      this.router.completeResponse(outcome);
    } catch (error) {
      if (!(error instanceof TelegramDeliveryError)) throw error;
      const policy = TELEGRAM_DELIVERY_POLICY[error.failure.kind];
      if (policy.reply === "RELEASE") {
        this.router.releaseResponse(outcome);
        throw error;
      }
      if (error.failure.kind === "PERMANENT_REJECTION") {
        this.router.abandonResponse(outcome, error.failure);
      } else {
        if (error.failure.kind !== "UNKNOWN") throw error;
        this.router.recordUnknownResponse(outcome, error.failure);
        if (policy.batch === "STOP") {
          this.#terminalDeliveryError = error;
          this.#terminalDeliveryNonce = outcome.nonce;
          this.#running = false;
          this.options.onRuntimeStatus?.({
            running: false,
            stopReason: "UNKNOWN_DELIVERY",
            recoveryNonce: outcome.nonce,
          });
          throw error;
        }
      }
    }
    return outcome;
  }

  /**
   * One update id has one live task. A repeated getUpdates response while its offset is held
   * cannot fork the route; a failed task becomes retryable and is the only state admitted again.
   */
  private reserveUpdate(updateId: number): TelegramUpdateReservation {
    if (!Number.isSafeInteger(updateId)) return { reserved: true };
    const state = this.#updateStates.get(updateId);
    if (state?.status === "RUNNING" || state?.status === "SETTLED") return { reserved: false };
    if (state?.status === "RETRYABLE") {
      const retryInMs = state.retryAt - Date.now();
      if (retryInMs > 0) return { reserved: false, retryInMs };
    }
    this.#updateStates.set(updateId, { status: "RUNNING" });
    if (state === undefined) {
      this.#updateOrder.push(updateId);
      this.#updateOrder.sort((left, right) => left - right);
    }
    return { reserved: true };
  }

  private retryUpdate(updateId: number, error?: unknown): void {
    if (Number.isSafeInteger(updateId)) {
      this.#updateStates.set(updateId, {
        status: "RETRYABLE",
        retryAt: Date.now() + deliveryRetryDelayMs(error, this.options.retryDelayMs ?? 5_000),
      });
    }
  }

  private completeUpdate(updateId: number): void {
    if (!Number.isSafeInteger(updateId)) return;
    this.#updateStates.set(updateId, { status: "SETTLED" });

    // Telegram confirms every id below offset. A later task may finish first, but it cannot move
    // the offset past an earlier turn that is still running or failed. #631 can make this queue
    // durable; #630 does not open the process-death loss window while that work is pending.
    while (this.#updateOrder.length > 0) {
      const next = this.#updateOrder[0]!;
      if (this.#updateStates.get(next)?.status !== "SETTLED") break;
      this.#updateOrder.shift();
      this.#updateStates.delete(next);
      this.#offset = Math.max(this.#offset ?? 0, next + 1);
    }
  }

  /**
   * Sends any owner-gate prompts that are still owed.
   *
   * A failure here is reported and never thrown. One prompt that cannot be delivered must not
   * cost the other prompts their turn, and must not cost the listener its inbound batch — the
   * prompt is a notification, while inbound is the owner's control path. The outbox keeps the
   * signal, so an undelivered prompt is retried on the next poll rather than lost.
   */
  private async deliverOwnerGatePrompts(): Promise<void> {
    const signals = this.options.ownerGateSignals?.() ?? [];
    // Every allowlisted chat, not only the first. A prompt record is keyed by chat and reply
    // message id, so a prompt sent to chat A cannot be resolved by a reply in chat B — that
    // reply is refused OWNER_AUTHORITY_NOT_DELEGABLE. With only allowedChatIds[0] prompted,
    // an owner reading in their second allowlisted chat had no way to answer at all.
    //
    // The correlation id already digests chatId, so per-chat prompts were anticipated here;
    // the index was the shortcut. Sending to each chat gives every one a record its own reply
    // can resolve.
    const chatIds = this.options.allowedChatIds ?? [];
    if (chatIds.length === 0) return;

    for (const signal of signals) {
      for (const item of uniquePromptItems(signal.items)) {
        for (const chatId of chatIds) {
          try {
            const delivered = await this.sendOwnerPromptIfNeeded({
              runId: signal.runId,
              items: [item],
              chatId,
              correlationId: `telegram:owner-gate:${signal.signalId}:${digestOf({ item, chatId })}`,
            });
            if (!delivered.allowed) {
              this.options.onError?.(
                new Error(`owner gate prompt not delivered: ${delivered.reasonCode}: ${delivered.message}`),
              );
            }
          } catch (error) {
            // One unreachable chat must not stop the others: the owner may be reading in any
            // of them, and losing every prompt because one failed is the outcome this whole
            // path exists to avoid.
            this.options.onError?.(error);
          }
        }
      }
    }
  }
}

/** Starts the production Telegram route after the daemon has acquired its single-instance lock. */
export const startTelegramLongPollListener = async (
  cp: ControlPlane,
  config: TelegramLongPollConfig,
  options: TelegramLongPollStartOptions = {},
): Promise<TelegramLongPollListener> => {
  validateLongPollConfig(config);
  // Chosen before the guard, not after (#682, round 8): the guard's retention floor has to be
  // derived from the transport that will actually run this channel, and it cannot derive from a
  // transport nobody has picked yet.
  const transport = options.transport ?? new TelegramBotApi(config.botToken, {
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
  });
  const guard = new IngressGuard(cp.db, cp.clock, cp.audit, {
    telegram: {
      allowedActors: config.allowedOwnerIds,
      allowedConversations: config.allowedChatIds,
      recoverInFlight: true,
      // The transport's own report wins when it has one (the official endpoint, or a fake that
      // declares its own value); `config.transportRetentionMs` — `ACP_TELEGRAM_TRANSPORT_RETENTION_MS`
      // — fills the gap only when the transport itself reports unknown (#682, round 8's third
      // pass: the escape hatch for an operator who knows their self-hosted server's real window).
      transportRetentionMs: transport.redeliveryRetentionMs ?? config.transportRetentionMs ?? null,
    },
  });
  const ingress = new TelegramIngress(guard, { webhookSecret: config.webhookSecret });
  const hermes = createHermesMcpPort(cp, { onCeoApproved: options.onCeoApproved });
  const router = new TelegramHermesRouter({
    ingress,
    hermes,
    // Contract 1's fourth field, read from the live binding at claim time rather than captured
    // once here: a generation that advances while this listener is up (a handoff, a rebind) has
    // to reach the next turn's claim, and a value closed over at construction never would.
    //
    // Supplied at all because it was not. `TelegramRouterOptions.bindingGeneration` was optional
    // with a `() => null` default and no composition root — not this one, not the disposable-realm
    // driver, not a test — ever passed it, so every claim ACP has ever written stored
    // `digestOf({ bindingGeneration: null })`. The digest meant to say which CEO asked the turn
    // was the same constant whether a CEO was bound at generation 1 or none was bound at all,
    // which is the one distinction it exists to draw. The option is now required, so the next
    // composition root cannot repeat this silently.
    bindingGeneration: () => cp.bindings.active(roleKeyFor(Role.CEO))?.bindingGeneration ?? null,
    currentCandidateSnapshotDigest: (runId) => cp.runs.currentCandidate(runId),
    resolveOwnerPrompt: (input) => storedOwnerPrompt(cp, input.chatId, input.messageId, input.runId),
    recordOwnerPrompt: (record) => recordOwnerPrompt(cp, record),
    defaultProjectId: config.defaultProjectId,
    ...(options.onDirect ? { directHandler: options.onDirect } : {}),
    ownerDecision: (request) => cp.ceo.recordOwnerDecision({
      runId: request.runId,
      item: request.item,
      approved: request.approved,
      note: request.note,
      receipt: request.receipt,
    }),
    getStoredState: (nonce) => storedState(cp, nonce),
    getStoredResponse: (nonce) => storedResponse(cp, nonce),
    ...(options.onInterrupt ? { onInterrupt: options.onInterrupt } : {}),
  });
  const service = new TelegramLongPollService(transport, router, config.webhookSecret, {
    pollTimeoutSeconds: config.pollTimeoutSeconds,
    retryDelayMs: config.retryDelayMs,
    allowedChatIds: config.allowedChatIds,
    nowIso: () => cp.clock.nowIso(),
    onError: options.onError,
    ownerGateSignals: options.ownerGateSignals ?? (() => ownerGateSignalsFromOutbox(cp)),
    ownerPromptStore: createOwnerPromptStore(cp),
    onRuntimeStatus: options.onRuntimeStatus,
    ...(options.onInterrupt ? { onInterrupt: options.onInterrupt } : {}),
  });
  if (options.start !== false) service.start();
  return { service, close: () => service.close() };
};

/**
 * The CEO notification is the durable signal already emitted with a production-ready packet.
 * It is consumed only once the run is actually AWAITING_HUMAN; the Telegram service then
 * samples the run's current candidate while reserving each item-specific prompt.
 */
const ownerGateSignalsFromOutbox = (cp: ControlPlane): readonly TelegramOwnerGateSignal[] => {
  const signals: TelegramOwnerGateSignal[] = [];
  for (const run of cp.runs.list({ state: RunState.AWAITING_HUMAN })) {
    for (const message of cp.outbox.listByRun(run.runId)) {
      if (message.kind !== "CEO_NOTIFICATION") continue;
      if (!isRecord(message.payload) || message.payload["notification"] !== "READY_FOR_CEO_REVIEW") continue;
      const humanGate = message.payload["humanGate"];
      if (
        !isRecord(humanGate) ||
        humanGate["required"] !== true ||
        humanGate["satisfied"] === true ||
        !Array.isArray(humanGate["items"])
      ) continue;
      const items = humanGate["items"].filter((item): item is string => typeof item === "string");
      const candidateSnapshotDigest = message.payload["candidateSnapshotDigest"];
      if (items.length === 0 || typeof candidateSnapshotDigest !== "string") continue;
      signals.push({
        signalId: message.messageId,
        runId: run.runId,
        candidateSnapshotDigest,
        items,
      });
    }
  }
  return signals;
};

const OWNER_PROMPT_RESERVATION_CHANNEL = "telegram-owner-prompt";

interface StoredOwnerPromptReservation {
  kind: "TELEGRAM_OWNER_PROMPT";
  status: TelegramOwnerPromptDeliveryStatus;
  key: string;
  runId: string;
  item: string;
  chatId: string;
  candidateSnapshotDigest: string;
  correlationId: string;
  messageId?: number;
}

const createOwnerPromptStore = (cp: ControlPlane): TelegramOwnerPromptStore => ({
  reserve: (input) => {
    try {
      return cp.db.tx(() => {
        const current = cp.db.get<{ result_json: string | null }>(
          `SELECT result_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
          [OWNER_PROMPT_RESERVATION_CHANNEL, input.key],
        );
        if (current) {
          const stored = parseOwnerPromptReservation(current.result_json);
          if (!stored || !sameOwnerPromptReservation(stored, input)) {
            return deny(
              ReasonCode.RESOURCE_COLLISION,
              "Telegram owner prompt reservation is bound to different gate data",
              { key: input.key },
            );
          }
          const record = stored.status === "APPLIED" && stored.messageId
            ? storedOwnerPrompt(cp, input.chatId, stored.messageId, input.runId)
            : null;
          if (stored.status === "RETRYABLE") {
            const reset: StoredOwnerPromptReservation = { ...stored, status: "PENDING" };
            cp.db.run(
              `UPDATE inbound_messages SET result_json = ?
                WHERE channel = ? AND nonce = ? AND result_json = ?`,
              [JSON.stringify(reset), OWNER_PROMPT_RESERVATION_CHANNEL, input.key, current.result_json],
            );
            return allow(ReasonCode.OK, { status: "PENDING", acquired: true, record: null });
          }
          return allow(ReasonCode.INGRESS_REPLAY_IGNORED, {
            status: stored.status,
            acquired: false,
            record,
          });
        }

        const reservation: StoredOwnerPromptReservation = {
          kind: "TELEGRAM_OWNER_PROMPT",
          status: "PENDING",
          key: input.key,
          runId: input.runId,
          item: input.item,
          chatId: input.chatId,
          candidateSnapshotDigest: input.candidateSnapshotDigest,
          correlationId: input.correlationId,
        };
        cp.db.run(
          `INSERT INTO inbound_messages (channel, nonce, actor, received_at, result_json)
           VALUES (?, ?, ?, ?, ?)`,
          [
            OWNER_PROMPT_RESERVATION_CHANNEL,
            input.key,
            input.chatId,
            cp.clock.nowIso(),
            JSON.stringify(reservation),
          ],
        );
        return allow(ReasonCode.OK, { status: "PENDING", acquired: true, record: null });
      });
    } catch (error) {
      return deny(
        ReasonCode.INTERNAL_ERROR,
        "could not reserve the Telegram owner prompt",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  },

  complete: ({ reservation, record }) => {
    try {
      return cp.db.tx(() => {
        const current = cp.db.get<{ result_json: string | null }>(
          `SELECT result_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
          [OWNER_PROMPT_RESERVATION_CHANNEL, reservation.key],
        );
        const stored = parseOwnerPromptReservation(current?.result_json ?? null);
        if (!stored || !sameOwnerPromptReservation(stored, reservation) || stored.status !== "PENDING") {
          return deny(
            ReasonCode.RESOURCE_COLLISION,
            "Telegram owner prompt reservation is no longer PENDING",
            { key: reservation.key, status: stored?.status ?? null },
          );
        }
        const persisted = insertOwnerPromptInTransaction(cp, record);
        if (!persisted.allowed) return persisted;
        const applied: StoredOwnerPromptReservation = {
          ...stored,
          status: "APPLIED",
          messageId: record.messageId,
        };
        const updated = cp.db.run(
          `UPDATE inbound_messages SET result_json = ?
            WHERE channel = ? AND nonce = ? AND result_json = ?`,
          [JSON.stringify(applied), OWNER_PROMPT_RESERVATION_CHANNEL, reservation.key, current!.result_json],
        );
        return updated.changes === 1
          ? allow(ReasonCode.OK, undefined)
          : deny(ReasonCode.RESOURCE_COLLISION, "Telegram owner prompt completion raced another writer", { key: reservation.key });
      });
    } catch (error) {
      return deny(
        ReasonCode.INTERNAL_ERROR,
        "could not durably record the Telegram owner prompt",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  },

  release: (input) => {
    try {
      return cp.db.tx(() => {
        const current = cp.db.get<{ result_json: string | null }>(
          `SELECT result_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
          [OWNER_PROMPT_RESERVATION_CHANNEL, input.key],
        );
        const stored = parseOwnerPromptReservation(current?.result_json ?? null);
        if (!stored || !sameOwnerPromptReservation(stored, input)) {
          return deny(ReasonCode.NOT_FOUND, "Telegram owner prompt reservation is missing", { key: input.key });
        }
        if (stored.status !== "PENDING") return allow(ReasonCode.INGRESS_REPLAY_IGNORED, undefined);
        const released: StoredOwnerPromptReservation = { ...stored, status: "RETRYABLE" };
        const updated = cp.db.run(
          `UPDATE inbound_messages SET result_json = ?
            WHERE channel = ? AND nonce = ? AND result_json = ?`,
          [JSON.stringify(released), OWNER_PROMPT_RESERVATION_CHANNEL, input.key, current!.result_json],
        );
        return updated.changes === 1
          ? allow(ReasonCode.OK, undefined)
          : deny(ReasonCode.RESOURCE_COLLISION, "Telegram owner prompt release raced another writer", { key: input.key });
      });
    } catch (error) {
      return deny(
        ReasonCode.INTERNAL_ERROR,
        "could not release the Telegram owner prompt reservation",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  },
});

const recordOwnerPrompt = (cp: ControlPlane, record: TelegramOwnerPromptRecord): Decision<void> => {
  try {
    return cp.db.tx(() => insertOwnerPromptInTransaction(cp, record));
  } catch (error) {
    return deny(
      ReasonCode.INTERNAL_ERROR,
      "could not durably record the Telegram owner prompt",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
};

const insertOwnerPromptInTransaction = (
  cp: ControlPlane,
  record: TelegramOwnerPromptRecord,
): Decision<void> => {
  const existing = cp.db.get<{
    correlation_id: string;
    run_id: string;
    candidate_snapshot_digest: string;
    created_at: string;
  }>(
    `SELECT correlation_id, run_id, candidate_snapshot_digest, created_at
       FROM telegram_owner_prompts WHERE chat_id = ? AND message_id = ?`,
    [record.chatId, record.messageId],
  );
  if (existing) {
    const same = existing.correlation_id === record.correlationId &&
      existing.run_id === record.runId &&
      existing.candidate_snapshot_digest === record.candidateSnapshotDigest &&
      existing.created_at === record.createdAt;
    return same
      ? allow(ReasonCode.INGRESS_REPLAY_IGNORED, undefined)
      : deny(
          ReasonCode.RESOURCE_COLLISION,
          "Telegram prompt message id is already bound to a different candidate",
          { chatId: record.chatId, messageId: record.messageId },
        );
  }
  cp.db.run(
    `INSERT INTO telegram_owner_prompts
       (chat_id, message_id, correlation_id, run_id, candidate_snapshot_digest, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      record.chatId,
      record.messageId,
      record.correlationId,
      record.runId,
      record.candidateSnapshotDigest,
      record.createdAt,
    ],
  );
  return allow(ReasonCode.OK, undefined);
};

const storedOwnerPrompt = (
  cp: ControlPlane,
  chatId: string,
  messageId: number,
  runId: string,
): TelegramOwnerPromptRecord | null => {
  const row = cp.db.get<{
    chat_id: string;
    message_id: number;
    correlation_id: string;
    run_id: string;
    candidate_snapshot_digest: string;
    created_at: string;
  }>(
    `SELECT chat_id, message_id, correlation_id, run_id, candidate_snapshot_digest, created_at
       FROM telegram_owner_prompts WHERE chat_id = ? AND message_id = ?`,
    [chatId, messageId],
  );
  if (
    !row ||
    row.run_id !== runId ||
    row.chat_id !== chatId ||
    row.message_id !== messageId ||
    typeof row.correlation_id !== "string" ||
    typeof row.candidate_snapshot_digest !== "string" ||
    typeof row.created_at !== "string"
  ) {
    return null;
  }
  return {
    runId: row.run_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    candidateSnapshotDigest: row.candidate_snapshot_digest,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
  };
};

const uniquePromptItems = (items: readonly string[]): string[] =>
  [...new Set(items.map((item) => item.trim()).filter(Boolean))];

const ownerPromptReservationKey = (input: {
  runId: string;
  item: string;
  chatId: string;
  candidateSnapshotDigest: string;
}): string => `prompt:${digestOf(input)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseOwnerPromptReservation = (resultJson: string | null): StoredOwnerPromptReservation | null => {
  if (!resultJson) return null;
  try {
    const value = JSON.parse(resultJson) as unknown;
    if (!isRecord(value)) return null;
    const status = value["status"];
    const rawMessageId = value["messageId"];
    const messageId =
      rawMessageId === undefined
        ? undefined
        : typeof rawMessageId === "number" && Number.isSafeInteger(rawMessageId) && rawMessageId > 0
          ? rawMessageId
          : null;
    if (
      value["kind"] !== "TELEGRAM_OWNER_PROMPT" ||
      (status !== "PENDING" && status !== "APPLIED" && status !== "RETRYABLE") ||
      typeof value["key"] !== "string" ||
      typeof value["runId"] !== "string" ||
      typeof value["item"] !== "string" ||
      typeof value["chatId"] !== "string" ||
      typeof value["candidateSnapshotDigest"] !== "string" ||
      typeof value["correlationId"] !== "string" ||
      messageId === null
    ) return null;
    return {
      kind: "TELEGRAM_OWNER_PROMPT",
      status,
      key: value["key"],
      runId: value["runId"],
      item: value["item"],
      chatId: value["chatId"],
      candidateSnapshotDigest: value["candidateSnapshotDigest"],
      correlationId: value["correlationId"],
      ...(messageId === undefined ? {} : { messageId }),
    };
  } catch {
    return null;
  }
};

const sameOwnerPromptReservation = (
  stored: StoredOwnerPromptReservation,
  input: TelegramOwnerPromptReservation,
): boolean =>
  stored.key === input.key &&
  stored.runId === input.runId &&
  stored.item === input.item &&
  stored.chatId === input.chatId &&
  stored.candidateSnapshotDigest === input.candidateSnapshotDigest &&
  stored.correlationId === input.correlationId;

const validateLongPollConfig = (config: TelegramLongPollConfig): void => {
  if (!config.botToken?.trim()) throw new Error("Telegram long-poll requires a non-empty bot token");
  if (!config.webhookSecret?.trim()) throw new Error("Telegram long-poll requires a non-empty webhook secret");
  if (config.allowedOwnerIds.length === 0) throw new Error("Telegram long-poll requires an owner allowlist");
  if (config.allowedChatIds.length === 0) throw new Error("Telegram long-poll requires a chat allowlist");
  if (config.allowedOwnerIds.some((id) => !isPositiveTelegramId(id))) {
    throw new Error("Telegram long-poll owner allowlist contains a non-numeric id");
  }
  if (config.allowedChatIds.some((id) => !isTelegramId(id))) {
    throw new Error("Telegram long-poll chat allowlist contains a non-numeric id");
  }
  const timeout = config.pollTimeoutSeconds ?? 50;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 50) {
    throw new Error("Telegram long-poll timeout must be an integer from 1 to 50 seconds");
  }
};

const storedState = (cp: ControlPlane, nonce: string): TelegramStoredState | null => {
  const row = cp.db.get<{ result_json: string | null }>(
    `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
    [nonce],
  );
  if (!row?.result_json) return null;
  try {
    const value = JSON.parse(row.result_json) as unknown;
    if (!value || typeof value !== "object") return null;
    const candidate = value as {
      kind?: unknown;
      phase?: unknown;
      runId?: unknown;
      reply?: unknown;
      sent?: unknown;
      deliveryStatus?: unknown;
      unknownDeliveryAttempts?: unknown;
      deliveryFailure?: unknown;
    };
    if (
      candidate.kind !== "TELEGRAM_WORKFLOW" ||
      !["ADMITTED", "CREATED", "DISPATCHED", "REPLIED"].includes(String(candidate.phase))
    ) return null;
    if (candidate.runId !== undefined && typeof candidate.runId !== "string") return null;
    if (candidate.sent !== undefined && typeof candidate.sent !== "boolean") return null;
    if (
      candidate.deliveryStatus !== undefined &&
      ![
        "PENDING",
        "RETRYABLE",
        "UNKNOWN_RETRYABLE",
        "APPLIED",
        "UNANSWERABLE",
        "UNRESOLVED",
      ].includes(String(candidate.deliveryStatus))
    ) return null;
    if (
      candidate.unknownDeliveryAttempts !== undefined
      && (!Number.isSafeInteger(candidate.unknownDeliveryAttempts) || Number(candidate.unknownDeliveryAttempts) < 0)
    ) return null;
    if (candidate.reply === undefined) {
      return {
        kind: "TELEGRAM_WORKFLOW",
        phase: candidate.phase as TelegramStoredState["phase"],
        ...(candidate.runId ? { runId: candidate.runId } : {}),
      };
    }
    if (
      typeof candidate.reply !== "object"
      || candidate.reply === null
      || (candidate.sent === undefined && candidate.deliveryStatus === undefined)
    ) return null;
    const reply = candidate.reply as Partial<TelegramReply>;
    if (
      typeof reply.chatId !== "string" ||
      typeof reply.text !== "string" ||
      typeof reply.replyToMessageId !== "number" ||
      typeof reply.correlationId !== "string"
    ) return null;
    let deliveryFailure: TelegramStoredDeliveryFailure | undefined;
    if (candidate.deliveryFailure !== undefined) {
      if (!isRecord(candidate.deliveryFailure)) return null;
      const failure = candidate.deliveryFailure;
      if (
        (failure["kind"] !== "PERMANENT_REJECTION" && failure["kind"] !== "UNKNOWN")
        || (failure["statusCode"] !== null && !Number.isSafeInteger(failure["statusCode"]))
        || (failure["description"] !== null && typeof failure["description"] !== "string")
        || (failure["migrateToChatId"] !== null && typeof failure["migrateToChatId"] !== "string")
      ) return null;
      deliveryFailure = {
        kind: failure["kind"],
        statusCode: failure["statusCode"] as number | null,
        description: failure["description"] as string | null,
        migrateToChatId: failure["migrateToChatId"] as string | null,
      };
    }
    return {
      kind: "TELEGRAM_WORKFLOW",
      phase: candidate.phase as TelegramStoredState["phase"],
      ...(candidate.runId ? { runId: candidate.runId } : {}),
      reply: reply as TelegramReply,
      ...(candidate.sent === undefined ? {} : { sent: candidate.sent }),
      deliveryStatus: (candidate.deliveryStatus ?? (candidate.sent ? "APPLIED" : "PENDING")) as TelegramDeliveryStatus,
      ...(candidate.unknownDeliveryAttempts === undefined
        ? {}
        : { unknownDeliveryAttempts: Number(candidate.unknownDeliveryAttempts) }),
      ...(deliveryFailure ? { deliveryFailure } : {}),
    };
  } catch {
    return null;
  }
};

const storedResponse = (cp: ControlPlane, nonce: string): TelegramStoredResponse | null => {
  const state = storedState(cp, nonce);
  return state?.reply && state.sent !== undefined
    ? {
        reply: state.reply,
        sent: state.sent,
        deliveryStatus: state.deliveryStatus ?? (state.sent ? "APPLIED" : "PENDING"),
      }
    : null;
};

const parseTelegramUpdate = (value: unknown, index: number): TelegramUpdate => {
  if (!value || typeof value !== "object") {
    throw new Error(`Telegram getUpdates returned an invalid update at index ${index}`);
  }
  const updateId = (value as { update_id?: unknown }).update_id;
  if (!Number.isSafeInteger(updateId)) {
    throw new Error(`Telegram getUpdates returned an invalid update id at index ${index}`);
  }
  return value as TelegramUpdate;
};

const TELEGRAM_ENVIRONMENT_VARIABLES = [
  "ACP_TELEGRAM_BOT_TOKEN",
  "ACP_TELEGRAM_OWNER_ID",
  "ACP_TELEGRAM_ALLOWED_OWNER_IDS",
  "ACP_TELEGRAM_CHAT_ID",
  "ACP_TELEGRAM_ALLOWED_CHAT_IDS",
  "ACP_TELEGRAM_WEBHOOK_SECRET",
  "ACP_TELEGRAM_POLL_TIMEOUT_SECONDS",
  "ACP_TELEGRAM_RETRY_DELAY_MS",
  "ACP_TELEGRAM_DEFAULT_PROJECT_ID",
  "ACP_TELEGRAM_API_BASE_URL",
  "ACP_TELEGRAM_TRANSPORT_RETENTION_MS",
] as const;

const configuredValue = (
  environment: NodeJS.ProcessEnv,
  ...names: readonly string[]
): string => names
  .map((name) => environment[name]?.trim() ?? "")
  .find((value) => value.length > 0) ?? "";

const splitConfig = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const isTelegramId = (value: string): boolean => {
  const numeric = Number(value);
  return /^-?\d+$/u.test(value) && Number.isSafeInteger(numeric);
};

const isPositiveTelegramId = (value: string): boolean => {
  const numeric = Number(value);
  return /^\d+$/u.test(value) && numeric > 0 && Number.isSafeInteger(numeric);
};

const parseBoundedInteger = (
  value: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number => {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Telegram configuration integer must be between ${minimum} and ${maximum}`);
  }
  return parsed;
};

/**
 * `parseBoundedInteger`, but absence means "not asserted" rather than a numeric default —
 * `ACP_TELEGRAM_TRANSPORT_RETENTION_MS` has no safe fallback to assume for an operator who has
 * not said anything, unlike the timeouts above.
 */
const parseOptionalBoundedInteger = (
  value: string | undefined,
  minimum: number,
  maximum: number,
): number | undefined => {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Telegram configuration integer must be between ${minimum} and ${maximum}`);
  }
  return parsed;
};

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

const deliveryRetryDelayMs = (error: unknown, fallbackMs: number): number => {
  if (
    error instanceof TelegramDeliveryError
    && error.failure.kind === "RETRYABLE"
    && error.failure.retryAfterSeconds !== null
  ) {
    return Math.max(
      fallbackMs,
      Math.min(error.failure.retryAfterSeconds * 1_000, 2_147_483_647),
    );
  }
  return fallbackMs;
};
