import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { isReasonCode, ReasonCode, type ReasonCode as ReasonCodeValue } from "../core/reason-codes.ts";
import { ExecutionMode, RunKind } from "../domain/types.ts";
import type { ExecutionMode as ExecutionModeValue, RunPriority, RunRow } from "../domain/types.ts";
import { OWNER_DECISION_OPERATION } from "../ceo/production-gate.ts";
import type { OwnerApprovalReceipt } from "../ceo/owner-authority.ts";
import { respond, type AuthenticatedMcpPeer, type ToolResult } from "../mcp/shared.ts";
import type { HermesMcpPort } from "../mcp/hermes-server.ts";
import type { TaskContract } from "../run/run-engine.ts";
import type {
  AdmittedTelegramMessage,
  TelegramOwnerApproval,
  TelegramIngress,
  TelegramUpdate,
} from "./telegram.ts";
import type { UnresolvedTurn } from "./ingress-guard.ts";

export interface TelegramDirectInput {
  kind: "DIRECT";
  text: string;
  actor: string;
  chatId: string;
  updateId: number;
  messageId: number;
  nonce: string;
  correlationId: string;
  forwarded: boolean;
  /**
   * The owner explicitly asked, via `/again`, to run this turn even though this conversation may
   * still have an unresolved one (#641). Absent (not `false`) for every ordinary DIRECT message —
   * the field only exists on the path where the choice was actually offered and taken.
   */
  overridesUnresolved?: true;
}

export interface TelegramManagedInput extends Omit<TelegramDirectInput, "kind"> {
  kind: "MANAGED";
  projectId: string;
  executionMode: ExecutionModeValue;
  contract: TaskContract;
}

/** The typed Hermes input produced after Telegram admission and command classification. */
export type TelegramHermesInput = TelegramDirectInput | TelegramManagedInput;

export interface TelegramOwnerDecisionRequest {
  runId: string;
  item: string;
  approved: boolean;
  note: string;
  receipt: OwnerApprovalReceipt;
}

/** The gate context used to compose the owner-facing Telegram prompt. */
export interface TelegramOwnerPromptRequest {
  runId: string;
  items: readonly string[];
  chatId: string;
  correlationId?: string;
}

/** The prompt text and candidate digest sampled at the moment the prompt is prepared. */
export interface TelegramOwnerPromptDraft {
  runId: string;
  chatId: string;
  candidateSnapshotDigest: string;
  correlationId: string;
  text: string;
}

/** Durable identity of the exact Telegram message whose candidate the owner was shown. */
export interface TelegramOwnerPromptRecord {
  runId: string;
  chatId: string;
  candidateSnapshotDigest: string;
  correlationId: string;
  messageId: number;
  createdAt: string;
}

/**
 * The durable CEO notification that tells Telegram a run is waiting for an owner.
 * `signalId` is the outbox identity; the candidate is re-sampled when the prompt is
 * prepared so a later candidate gets its own prompt reservation.
 */
export interface TelegramOwnerGateSignal {
  signalId: string;
  runId: string;
  candidateSnapshotDigest: string;
  items: readonly string[];
}

export interface TelegramReply {
  chatId: string;
  text: string;
  replyToMessageId: number;
  correlationId: string;
}

export interface TelegramStoredResponse {
  reply: TelegramReply;
  sent: boolean;
  /** Durable delivery protocol: PENDING is a reserved, possibly accepted send. */
  deliveryStatus: TelegramDeliveryStatus;
}

export type TelegramDeliveryStatus = "PENDING" | "RETRYABLE" | "APPLIED";

export type TelegramWorkflowPhase = "ADMITTED" | "CREATED" | "DISPATCHED" | "REPLIED";

export interface TelegramStoredState {
  kind: "TELEGRAM_WORKFLOW";
  phase: TelegramWorkflowPhase;
  runId?: string;
  reply?: TelegramReply;
  sent?: boolean;
  deliveryStatus?: TelegramDeliveryStatus;
}

export type TelegramInterruptPoint =
  | "after-admission"
  | "after-hermes-create"
  | "after-dispatch"
  | "after-reply-send";

/** Test and recovery probes use a typed interruption so normal routing errors remain replies. */
export class TelegramInterruption extends Error {
  constructor(readonly point: TelegramInterruptPoint) {
    super(`telegram workflow interrupted at ${point}`);
    this.name = "TelegramInterruption";
  }
}

export interface TelegramRouteOutcome {
  updateId: number;
  nonce: string;
  correlationId: string;
  admitted: boolean;
  replayed: boolean;
  classification: "DIRECT" | "MANAGED" | "OWNER_DECISION" | null;
  input: TelegramHermesInput | null;
  reply: TelegramReply | null;
  reasonCode: ReasonCodeValue;
  runId?: string;
}

export interface TelegramRouterOptions {
  ingress: TelegramIngress;
  /** The sealed Hermes surface; the router never receives the ControlPlane. */
  hermes: HermesMcpPort;
  /** Samples the frozen candidate only while preparing an owner-facing gate prompt. */
  currentCandidateSnapshotDigest: (runId: string) => string | null;
  /** Resolves a reply's Telegram message reference to the prompt that showed its candidate. */
  resolveOwnerPrompt?: (input: {
    chatId: string;
    messageId: number;
    runId: string;
  }) => TelegramOwnerPromptRecord | null;
  /** Persists a prompt after Telegram returns its accepted outbound message id. */
  recordOwnerPrompt?: (record: TelegramOwnerPromptRecord) => Decision<void>;
  /** The CEO gate accepts only the receipt minted by TelegramIngress. */
  ownerDecision?: (
    request: TelegramOwnerDecisionRequest,
  ) => Decision<void> | Promise<Decision<void>>;
  /** A deployment may choose one project for the shorthand `/managed <request>` form. */
  defaultProjectId?: string | null;
  /** DIRECT is deliberately a narrow callback, not a mutation capability. */
  directHandler?: (input: TelegramDirectInput) => string | Promise<string>;
  /** Lets a restarted poller retry a response that was prepared but not sent. */
  getStoredResponse?: (nonce: string) => TelegramStoredResponse | null;
  /** Durable workflow state used to resume a Telegram update after a process crash. */
  getStoredState?: (nonce: string) => TelegramStoredState | null;
  /**
   * The CEO binding generation a turn is being run under, read at claim time.
   *
   * Optional, and its absence is recorded as absence rather than as a generation. A default of
   * zero would put a number in the digest that no binding ever had, and a later receipt would
   * be compared against it and disagree for a reason nobody could find.
   */
  bindingGeneration?: () => number | null;
  /** Fault-injection seam for proving each durable checkpoint is restartable. */
  onInterrupt?: (point: TelegramInterruptPoint, update: TelegramUpdate, runId?: string) => void | Promise<void>;
}

interface ParsedManagedCommand {
  projectId: string | null;
  request: string;
  executionMode: ExecutionModeValue;
}

interface ParsedOwnerDecision {
  runId: string;
  item: string;
  approved: boolean;
  note: string;
}

/**
 * Converts an admitted Telegram message to one of the two Hermes logical inputs. A forwarded
 * update is classified before command parsing and therefore cannot promote its text to a
 * managed operation.
 */
export const classifyTelegramMessage = (
  message: AdmittedTelegramMessage,
  update: TelegramUpdate,
  defaultProjectId: string | null = null,
): Decision<TelegramHermesInput> => {
  const telegramMessage = update.message;
  if (!telegramMessage) {
    return deny(ReasonCode.INVALID_ARGUMENT, "update carries no Telegram message", {
      updateId: update.update_id,
    });
  }

  const base = {
    actor: message.actor,
    chatId: message.chatId,
    updateId: update.update_id,
    messageId: telegramMessage.message_id,
    nonce: message.nonce,
    correlationId: correlationIdFor(update),
    forwarded: message.forwarded,
  };

  // This check is intentionally before parseTelegramCommand. The wrapper is retained in the
  // input text, but a forwarded `/managed` string remains DIRECT data.
  if (message.forwarded) return allow(ReasonCode.UNTRUSTED_CONTENT_IS_DATA, { kind: "DIRECT", text: message.text, ...base });

  const command = parseTelegramCommand(message.text);
  if (command?.name === "direct") {
    if (command.args.length === 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "/direct requires a message", {
        updateId: update.update_id,
      });
    }
    return allow(ReasonCode.OK, { kind: "DIRECT", text: command.args, ...base });
  }

  if (command?.name === "again") {
    // The owner's explicit escape from a parked resend (#641): they were told an earlier turn
    // in this conversation is unresolved and chose to run this one anyway, aware the first may
    // still land. `/direct` and `/again` are otherwise identical parses; only the router's
    // unresolved-turn check treats the second differently, and only this flag tells it to.
    if (command.args.length === 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "/again requires a message", {
        updateId: update.update_id,
      });
    }
    return allow(ReasonCode.OK, { kind: "DIRECT", text: command.args, overridesUnresolved: true, ...base });
  }

  if (command?.name !== "managed") {
    // §6.1: ordinary conversation is DIRECT by default.
    return allow(ReasonCode.OK, { kind: "DIRECT", text: message.text, ...base });
  }

  const parsed = parseManagedCommand(command.args, defaultProjectId);
  if (!parsed.allowed) return parsed as Decision<TelegramHermesInput>;
  const projectId = parsed.value.projectId;
  if (!projectId) {
    return deny(
      ReasonCode.INVALID_ARGUMENT,
      "managed Telegram requests require a project id; use /managed <projectId> <request>",
      { updateId: update.update_id },
    );
  }

  const contract: TaskContract = {
    goal: parsed.value.request,
    why: "owner-requested managed work received through the authenticated Telegram ingress",
    scope: [],
    nonGoals: [],
    acceptance: ["Primary CTO receives and processes the managed request"],
    priority: "NORMAL" satisfies RunPriority,
    humanGate: [],
    references: [base.correlationId],
  };
  return allow(ReasonCode.OK, {
    kind: "MANAGED",
    text: parsed.value.request,
    projectId,
    executionMode: parsed.value.executionMode,
    contract,
    ...base,
  });
};

/** Parses `/approve` and `/reject` without ever granting authority by itself. */
export const parseTelegramOwnerDecision = (text: string): ParsedOwnerDecision | null => {
  const command = parseTelegramCommand(text);
  if (!command || (command.name !== "approve" && command.name !== "reject")) return null;
  const body = command.args.trim();
  const firstSpace = body.search(/\s/);
  if (firstSpace <= 0) return null;
  const runId = body.slice(0, firstSpace).trim();
  let decisionBody = body.slice(firstSpace).trim();
  if (!runId || !decisionBody) return null;

  let note = "";
  const noteMarker = /\s+--note(?:\s+|$)/i.exec(decisionBody);
  if (noteMarker && noteMarker.index >= 0) {
    note = decisionBody.slice(noteMarker.index + noteMarker[0].length).trim();
    decisionBody = decisionBody.slice(0, noteMarker.index).trim();
  }
  if (!decisionBody) return null;
  return {
    runId,
    item: decisionBody,
    approved: command.name === "approve",
    note,
  };
};

export const correlationIdFor = (update: TelegramUpdate): string =>
  `telegram:${update.update_id}:${update.message?.message_id ?? "update"}`;

/**
 * Routes authenticated updates through the sealed Hermes surface. The router is transport
 * agnostic: TelegramLongPollService owns send/offset mechanics, while this class owns
 * admission, classification, receipts, and downstream idempotency.
 */
export class TelegramHermesRouter {
  private readonly ingress: TelegramIngress;
  private readonly bindingGeneration: () => number | null;
  private readonly hermes: HermesMcpPort;
  private readonly currentCandidateSnapshotDigest: TelegramRouterOptions["currentCandidateSnapshotDigest"];
  private readonly resolveOwnerPrompt: NonNullable<TelegramRouterOptions["resolveOwnerPrompt"]>;
  private readonly recordOwnerPrompt: NonNullable<TelegramRouterOptions["recordOwnerPrompt"]>;
  private readonly ownerDecision: TelegramRouterOptions["ownerDecision"];
  private readonly defaultProjectId: string | null;
  private readonly directHandler: NonNullable<TelegramRouterOptions["directHandler"]>;
  private readonly getStoredResponse: NonNullable<TelegramRouterOptions["getStoredResponse"]>;
  private readonly getStoredState: NonNullable<TelegramRouterOptions["getStoredState"]>;
  private readonly onInterrupt: TelegramRouterOptions["onInterrupt"];

  constructor(options: TelegramRouterOptions) {
    this.ingress = options.ingress;
    this.hermes = options.hermes;
    this.currentCandidateSnapshotDigest = options.currentCandidateSnapshotDigest;
    this.resolveOwnerPrompt = options.resolveOwnerPrompt ?? (() => null);
    this.recordOwnerPrompt = options.recordOwnerPrompt ?? (() => deny(
      ReasonCode.INTERNAL_ERROR,
      "Telegram owner prompt persistence is not configured",
    ));
    this.ownerDecision = options.ownerDecision;
    this.defaultProjectId = options.defaultProjectId ?? null;
    this.directHandler = options.directHandler ?? defaultDirectHandler;
    this.bindingGeneration = options.bindingGeneration ?? (() => null);
    this.getStoredResponse = options.getStoredResponse ?? (() => null);
    this.getStoredState = options.getStoredState ?? ((nonce) => {
      const stored = this.getStoredResponse(nonce);
      return stored
        ? {
            kind: "TELEGRAM_WORKFLOW",
            phase: "REPLIED",
            reply: stored.reply,
            sent: stored.sent,
            deliveryStatus: stored.deliveryStatus,
          }
        : null;
    });
    this.onInterrupt = options.onInterrupt;
  }

  /**
   * Prepare the only owner prompt from which a Telegram approval may later derive authority.
   * The candidate is sampled here, when the prompt is composed, never while its reply is
   * being processed.
   */
  prepareOwnerPrompt(input: TelegramOwnerPromptRequest): Decision<TelegramOwnerPromptDraft> {
    const items = [...new Set(input.items.map((item) => item.trim()).filter(Boolean))];
    if (!input.runId.trim() || !input.chatId.trim() || items.length === 0) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "Telegram owner prompts require a run, chat, and at least one gate item",
        { runId: input.runId, chatId: input.chatId, itemCount: items.length },
      );
    }
    const candidateSnapshotDigest = this.currentCandidateSnapshotDigest(input.runId);
    if (!candidateSnapshotDigest) {
      return deny(
        ReasonCode.EVIDENCE_STALE,
        "cannot prompt the Telegram owner without a current candidate",
        { runId: input.runId },
      );
    }
    const correlationId = input.correlationId?.trim() || `telegram:owner-prompt:${digestOf({
      runId: input.runId,
      chatId: input.chatId,
      candidateSnapshotDigest,
      items,
    })}`;
    const itemText = items.map((item) => `- ${item}`).join("\n");
    return allow(ReasonCode.OK, {
      runId: input.runId,
      chatId: input.chatId,
      candidateSnapshotDigest,
      correlationId,
      text: [
        "OWNER DECISION REQUIRED",
        `run: ${input.runId}`,
        `candidate: ${candidateSnapshotDigest}`,
        "items:",
        itemText,
        `Reply to this message with /approve ${input.runId} <item> (or /reject).`,
      ].join("\n"),
    });
  }

  /** Persist the message id returned by Telegram together with the prompt-time digest. */
  recordPreparedOwnerPrompt(record: TelegramOwnerPromptRecord): Decision<void> {
    return this.recordOwnerPrompt(record);
  }

  async route(update: TelegramUpdate, presentedSecret: string | null): Promise<TelegramRouteOutcome> {
    const stored = this.getStoredState(this.ingress.nonceFor(update));
    if (stored?.reply && this.deliveryStatus(stored) === "PENDING") {
      // A PENDING reservation means an earlier process may already have reached Telegram.
      // It is deliberately not retried: an ambiguous external result is safer as a single
      // possibly-lost response than as a duplicate owner-facing message.
      return this.storedResponseOutcome(update, stored, false);
    }
    if (stored?.reply && this.deliveryStatus(stored) === "RETRYABLE") {
      return this.storedResponseOutcome(update, stored, true);
    }

    const parsedOwner = update.message && !this.ingress.isForwarded(update)
      ? parseTelegramOwnerDecision(update.message.text ?? "")
      : null;

    if (parsedOwner) {
      const prompt = this.promptForReply(update, parsedOwner.runId);
      if (!prompt) return this.unresolvableOwnerDecision(update, presentedSecret, parsedOwner);
      const idempotencyKey = ownerDecisionIdempotencyKey(update, parsedOwner);
      const approval: TelegramOwnerApproval = {
        runId: parsedOwner.runId,
        candidateSnapshotDigest: prompt.candidateSnapshotDigest,
        operation: OWNER_DECISION_OPERATION,
        parameters: {
          item: parsedOwner.item,
          approved: parsedOwner.approved,
          note: parsedOwner.note,
        },
        idempotencyKey,
        approved: parsedOwner.approved,
      };
      const admitted = this.ingress.admitOwnerApproval(update, presentedSecret, approval);
      if (!admitted.allowed) {
        return this.deniedOrReplay(update, admitted.reasonCode, admitted.message, admitted.evidence);
      }
      await this.interrupt("after-admission", update);

      let decision: Decision<void>;
      try {
        decision = this.ownerDecision
          ? await this.ownerDecision({ ...parsedOwner, receipt: admitted.value })
          : deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, "Telegram owner decisions are not wired to a CEO gate");
      } catch (error) {
        decision = deny(
          ReasonCode.INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
      const reply = this.replyFor(
        update,
        decision.allowed
          ? `OWNER DECISION recorded: ${parsedOwner.approved ? "APPROVED" : "REJECTED"}\nrun: ${parsedOwner.runId}\nitem: ${parsedOwner.item}`
          : this.failureText("OWNER DECISION refused", decision),
      );
      return {
        updateId: update.update_id,
        nonce: this.ingress.nonceFor(update),
        correlationId: correlationIdFor(update),
        admitted: true,
        replayed: false,
        classification: "OWNER_DECISION",
        input: null,
        reply,
        reasonCode: decision.reasonCode,
      };
    }

    const admitted = this.ingress.admit(update, presentedSecret);
    if (!admitted.allowed) {
      return this.deniedOrReplay(update, admitted.reasonCode, admitted.message, admitted.evidence);
    }
    await this.interrupt("after-admission", update);

    const classified = classifyTelegramMessage(admitted.value, update, this.defaultProjectId);
    if (!classified.allowed) {
      return this.outcomeWithReply(
        update,
        true,
        false,
        null,
        this.replyFor(update, this.failureText("Telegram request refused", classified)),
        classified.reasonCode,
      );
    }

    try {
      if (classified.value.kind === "DIRECT") {
        // Claimed before it runs, because this handler is no longer a formatter.
        //
        // In production it reaches the CEO, whose reply command resumes the owner's own
        // conversation — so running it twice appends the same exchange twice to a transcript
        // that is then carried forward as context. The ingress recovery path re-admits an
        // update whose result was never recorded, which is correct for a handler that only
        // produced a reply and wrong for one that writes somewhere durable.
        //
        // A failed claim means another poller holds it, or a previous attempt was cut off
        // before recording an outcome. Neither is a case to run it again.
        // Fixed here rather than inside the guard: the identity says what *this* turn is, and
        // only the router knows the text and the binding it is running under. The guard's job is
        // to store it atomically with the claim, not to invent it.
        const identity = this.ingress.turnIdentityFor(update, classified.value.text, this.bindingGeneration());

        // The claim above stops the *same* message from starting a second CEO turn. It cannot
        // stop a resend: a different nonce, a fresh turn id, honestly claimable on its own (#641).
        // So before claiming, ask whether this conversation already has a turn nobody has
        // recorded an outcome for. A refusal here would be safe against the duplicate and wrong
        // in the other direction — the owner locked out of a conversation whose earlier turn may
        // never resolve (#672 has no operator door for that yet) — so an unresolved turn parks
        // the message instead of claiming or dropping it, and tells the owner exactly how to get
        // unstuck, unless they already made that choice via `/again`.
        const unresolved = this.ingress.unresolvedTurns(identity.sessionDigest);
        if (unresolved.length > 0 && !classified.value.overridesUnresolved) {
          // #695: every unresolved row is counted, and up to MAX_NAMED_UNRESOLVED_TURNS are
          // named individually, not only the oldest. A second one accumulates whenever an
          // overriding claim itself goes unresolved (A crashes, `/again` claims B, B also
          // crashes) — the owner has to be told what is actually outstanding, not just the one
          // this router used to bother reading. Bounded rather than exhaustive (see
          // `unresolvedTurnsParkText`'s docstring): these rows are never pruned, so the list can
          // grow without bound, and naming all of them risks the exact opposite failure — a
          // reply so long it cannot be sent, or one truncated in a way that drops the
          // instructions telling the owner `/again` exists at all.
          return this.outcomeWithReply(
            update,
            true,
            false,
            classified.value,
            this.replyFor(
              update,
              [
                unresolvedTurnsParkText(unresolved),
                "ACP does not know whether any of those reached the CEO, so this one was not run — nothing was appended twice.",
                "Reply with /again <your message> to run this one anyway, knowing the earlier turn(s) may still land too.",
              ].join("\n"),
            ),
            ReasonCode.INGRESS_TURN_UNRESOLVED_CONVERSATION,
          );
        }

        // Reached without an unresolved turn, or with one or more the owner deliberately
        // overrode via `/again`. When it's the latter, the choice is recorded on the claim
        // itself — not only in this reply — so a later reader does not have to trust that it was
        // made honestly. Every outstanding nonce is captured, not only the oldest (#695): a
        // `/again` shown N unresolved turns and recording only one would silently override the
        // rest, the same defect this issue closes in a new place.
        const overriddenUnresolvedNonces = unresolved.length > 0 ? unresolved.map((turn) => turn.nonce) : undefined;
        const claimed = this.ingress.claimTurn(
          this.ingress.nonceFor(update),
          overriddenUnresolvedNonces ? { ...identity, overriddenUnresolvedNonces } : identity,
        );
        if (!claimed.allowed) {
          return this.outcomeWithReply(
            update,
            true,
            false,
            null,
            this.replyFor(update, this.failureText("Telegram request not run", claimed)),
            claimed.reasonCode,
          );
        }
        const directText = await this.directHandler(classified.value);
        return this.outcomeWithReply(
          update,
          true,
          false,
          classified.value,
          // Not "acknowledged by Hermes". The default directHandler is a pure function that
          // formats a string; nothing is dispatched and Hermes never sees the message. Naming
          // an actor that did not receive it tells the owner a request is in motion when it is
          // not — the reply was the only thing that looked like progress.
          //
          // A deployment may inject a directHandler that does reach somewhere, so the prefix
          // states only what the router itself knows: the message arrived and created no run.
          // Anything about who handled it belongs to the handler's own text.
          this.replyFor(update, `DIRECT received; no run created\n${directText}`),
          ReasonCode.OK,
        );
      }
      return await this.routeManaged(update, admitted.value, classified.value);
    } catch (error) {
      if (error instanceof TelegramInterruption) throw error;
      return this.outcomeWithReply(
        update,
        true,
        false,
        classified.value,
        this.replyFor(update, this.failureText("Telegram routing failed", deny(
          ReasonCode.INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
        ))),
        ReasonCode.INTERNAL_ERROR,
      );
    }
  }

  /** Reserve a response before the external Telegram send. */
  reserveResponse(outcome: TelegramRouteOutcome): void {
    if (!outcome.reply || !outcome.admitted) return;
    const prior = this.getStoredState(outcome.nonce);
    const runId = outcome.runId ?? prior?.runId;
    const reserved = this.ingress.recordResultIf(outcome.nonce, {
      kind: "TELEGRAM_WORKFLOW",
      phase: runId ? "DISPATCHED" : "REPLIED",
      ...(runId ? { runId } : {}),
      reply: outcome.reply,
      sent: false,
      deliveryStatus: "PENDING",
    } satisfies TelegramStoredState, "AVAILABLE");
    if (!reserved.allowed) throw new Error(`${reserved.reasonCode}: ${reserved.message}`);
  }

  /** Complete a reserved response exactly once after Telegram accepts it. */
  completeResponse(outcome: TelegramRouteOutcome): void {
    if (!outcome.reply || !outcome.admitted) return;
    const prior = this.getStoredState(outcome.nonce);
    if (this.deliveryStatus(prior) === "APPLIED") return;
    if (this.deliveryStatus(prior) !== "PENDING") {
      throw new Error(`Telegram response completion requires a PENDING reservation (${outcome.nonce})`);
    }
    // Two lifecycles, one transaction. The turn's is not this message's reply — and until they were
    // separated (#646) the write below erased the claim — but they end on the same fact, so they
    // have to commit on the same fact: a review found the window where the process commits APPLIED,
    // crashes, and on restart returns early without ever resolving the turn, holding the nonce with
    // a turn that finished.
    const completed = this.ingress.completeReplyAndResolveTurn(outcome.nonce, {
      kind: "TELEGRAM_WORKFLOW",
      phase: "REPLIED",
      ...(outcome.runId ?? prior?.runId ? { runId: outcome.runId ?? prior?.runId } : {}),
      reply: outcome.reply,
      sent: true,
      deliveryStatus: "APPLIED",
    } satisfies TelegramStoredState);
    if (!completed.allowed) throw new Error(`${completed.reasonCode}: ${completed.message}`);
  }

  /** Release only a reservation whose transport proved that no message was accepted. */
  releaseResponse(outcome: TelegramRouteOutcome): void {
    if (!outcome.reply || !outcome.admitted) return;
    const prior = this.getStoredState(outcome.nonce);
    if (this.deliveryStatus(prior) !== "PENDING") return;
    const runId = outcome.runId ?? prior?.runId;
    const released = this.ingress.recordResultIf(outcome.nonce, {
      kind: "TELEGRAM_WORKFLOW",
      phase: runId ? "DISPATCHED" : "REPLIED",
      ...(runId ? { runId } : {}),
      reply: outcome.reply,
      sent: false,
      deliveryStatus: "RETRYABLE",
    } satisfies TelegramStoredState, "PENDING");
    if (!released.allowed) throw new Error(`${released.reasonCode}: ${released.message}`);
  }

  /** Compatibility wrapper for callers that used the old boolean response API. */
  recordResponse(outcome: TelegramRouteOutcome, sent: boolean): void {
    if (sent) this.completeResponse(outcome);
    else this.reserveResponse(outcome);
  }

  private async routeManaged(
    update: TelegramUpdate,
    admitted: AdmittedTelegramMessage,
    input: TelegramManagedInput,
  ): Promise<TelegramRouteOutcome> {
    const peer: AuthenticatedMcpPeer = { actor: `telegram:${admitted.actor}` };
    const stored = this.getStoredState(admitted.nonce);
    let runId = stored?.runId;
    if (!runId || stored?.phase === "ADMITTED") {
      const createKey = this.ingress.idempotencyKeyFor(admitted, "hermes-run-create");
      const created = await this.hermesMutation<RunRow>(peer, createKey, () => this.hermes.createRun({
        projectId: input.projectId,
        kind: RunKind.STANDARD_WORK,
        executionMode: input.executionMode,
        contract: input.contract,
        repositories: [],
      }));
      if (!created.allowed) {
        return this.outcomeWithReply(
          update,
          true,
          false,
          input,
          this.replyFor(update, this.failureText("MANAGED run creation refused", created)),
          created.reasonCode,
        );
      }

      runId = created.value.runId;
      await this.interrupt("after-hermes-create", update, runId);
      this.ingress.recordResult(admitted.nonce, {
        kind: "TELEGRAM_WORKFLOW",
        phase: "CREATED",
        runId,
      } satisfies TelegramStoredState);
    }

    if (!runId) {
      return this.outcomeWithReply(
        update,
        true,
        false,
        input,
        this.replyFor(update, "MANAGED run recovery refused: no durable run id"),
        ReasonCode.INTERNAL_ERROR,
      );
    }

    if (stored?.phase !== "DISPATCHED") {
      const dispatchKey = this.ingress.idempotencyKeyFor(admitted, "hermes-run-dispatch");
      const dispatched = await this.hermesMutation<RunRow>(peer, dispatchKey, () => this.hermes.dispatchRun(runId!));
      if (!dispatched.allowed) {
        return this.outcomeWithReply(
          update,
          true,
          false,
          input,
          this.replyFor(update, `${this.failureText("MANAGED run dispatch refused", dispatched)}\nrun: ${runId}`),
          dispatched.reasonCode,
          runId,
        );
      }

      await this.interrupt("after-dispatch", update, runId);
      this.ingress.recordResult(admitted.nonce, {
        kind: "TELEGRAM_WORKFLOW",
        phase: "DISPATCHED",
        runId,
      } satisfies TelegramStoredState);
    }

    return this.outcomeWithReply(
      update,
      true,
      false,
      input,
      this.replyFor(update, `MANAGED run dispatched to the Primary CTO\nrun: ${runId}`),
      ReasonCode.OK,
      runId,
    );
  }

  private async hermesMutation<T>(
    peer: AuthenticatedMcpPeer,
    idempotencyKey: string,
    operation: () => Decision<T> | Promise<Decision<T>>,
  ): Promise<Decision<T>> {
    const wire = await this.hermes.mutation.execute(peer, idempotencyKey, async () =>
      respond(await operation()),
    );
    return decisionFromToolResult<T>(wire);
  }

  private async interrupt(point: TelegramInterruptPoint, update: TelegramUpdate, runId?: string): Promise<void> {
    await this.onInterrupt?.(point, update, runId);
  }

  private promptForReply(update: TelegramUpdate, runId: string): TelegramOwnerPromptRecord | null {
    const message = update.message;
    const chatId = message?.chat?.id;
    const messageId = replyToMessageIdFor(update);
    if (!Number.isSafeInteger(chatId) || messageId === null) return null;
    const prompt = this.resolveOwnerPrompt({ chatId: String(chatId), messageId, runId });
    if (!prompt || prompt.chatId !== String(chatId) || prompt.messageId !== messageId || prompt.runId !== runId) {
      return null;
    }
    return prompt;
  }

  private async unresolvableOwnerDecision(
    update: TelegramUpdate,
    presentedSecret: string | null,
    parsedOwner: ParsedOwnerDecision,
  ): Promise<TelegramRouteOutcome> {
    // Authenticate and durably admit the message so an authenticated owner gets a refusal and
    // the update remains replay-safe. No owner receipt is minted on this path.
    const admitted = this.ingress.admit(update, presentedSecret);
    if (!admitted.allowed) return this.deniedOrReplay(update, admitted.reasonCode, admitted.message, admitted.evidence);
    await this.interrupt("after-admission", update);
    const refusal = deny(
      ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
      "Telegram owner reply does not identify a recorded gate prompt; no shown candidate can be approved",
      { runId: parsedOwner.runId, replyToMessageId: replyToMessageIdFor(update) },
    );
    return {
      updateId: update.update_id,
      nonce: this.ingress.nonceFor(update),
      correlationId: correlationIdFor(update),
      admitted: true,
      replayed: false,
      classification: "OWNER_DECISION",
      input: null,
      reply: this.replyFor(update, this.failureText("OWNER DECISION refused", refusal)),
      reasonCode: refusal.reasonCode,
    };
  }

  private storedResponseOutcome(
    update: TelegramUpdate,
    stored: TelegramStoredState,
    includeReply: boolean,
  ): TelegramRouteOutcome {
    return {
      updateId: update.update_id,
      nonce: this.ingress.nonceFor(update),
      correlationId: correlationIdFor(update),
      admitted: true,
      replayed: true,
      classification: null,
      input: null,
      reply: includeReply ? stored.reply ?? null : null,
      reasonCode: ReasonCode.INGRESS_REPLAY_IGNORED,
      ...(stored.runId ? { runId: stored.runId } : {}),
    };
  }

  private deliveryStatus(stored: TelegramStoredState | null): TelegramDeliveryStatus | null {
    if (!stored?.reply) return null;
    if (stored.deliveryStatus) return stored.deliveryStatus;
    // Rows written by the previous release had only `sent`. Treat an unfinished row as an
    // ambiguous reservation and fail closed rather than replaying a possibly delivered reply.
    return stored.sent === true ? "APPLIED" : "PENDING";
  }

  private deniedOrReplay(
    update: TelegramUpdate,
    reasonCode: ReasonCodeValue,
    _message: string,
    _evidence: Record<string, unknown>,
  ): TelegramRouteOutcome {
    const replayed = reasonCode === ReasonCode.INGRESS_REPLAY_IGNORED;
    if (replayed) {
      const stored = this.getStoredState(this.ingress.nonceFor(update));
      if (stored?.reply && this.deliveryStatus(stored) === "RETRYABLE") {
        return this.storedResponseOutcome(update, stored, true);
      }
    }
    // Do not disclose allowlist/authentication failures to an untrusted Telegram sender.
    return {
      updateId: update.update_id,
      nonce: this.ingress.nonceFor(update),
      correlationId: correlationIdFor(update),
      admitted: false,
      replayed,
      classification: null,
      input: null,
      reply: null,
      reasonCode,
    };
  }

  private outcomeWithReply(
    update: TelegramUpdate,
    admitted: boolean,
    replayed: boolean,
    input: TelegramHermesInput | null,
    reply: TelegramReply | null,
    reasonCode: ReasonCodeValue,
    runId?: string,
  ): TelegramRouteOutcome {
    return {
      updateId: update.update_id,
      nonce: this.ingress.nonceFor(update),
      correlationId: correlationIdFor(update),
      admitted,
      replayed,
      classification: input?.kind ?? null,
      input,
      reply,
      reasonCode,
      ...(runId ? { runId } : {}),
    };
  }

  private replyFor(update: TelegramUpdate, text: string): TelegramReply {
    const message = update.message;
    return {
      chatId: String(message?.chat?.id ?? ""),
      text: `${truncateTelegramText(text)}\ncorrelation: ${correlationIdFor(update)}`,
      replyToMessageId: message?.message_id ?? 0,
      correlationId: correlationIdFor(update),
    };
  }

  private failureText<T>(prefix: string, decision: Decision<T>): string {
    return decision.allowed
      ? prefix
      : `${prefix} (${decision.reasonCode}): ${decision.message}`;
  }
}

const defaultDirectHandler = (input: TelegramDirectInput): string =>
  input.forwarded
    ? "forwarded content was retained as untrusted data; no command was executed"
    : "no managed operation was requested";

const parseTelegramCommand = (
  text: string,
): { name: string; args: string } | null => {
  const match = /^\/([^\s@]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: match[2]?.trim() ?? "" };
};

const parseManagedCommand = (
  args: string,
  defaultProjectId: string | null,
): Decision<ParsedManagedCommand> => {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  let projectId = defaultProjectId;
  let executionMode: ExecutionModeValue = ExecutionMode.STANDARD;
  const requestTokens: string[] = [];
  let explicitProject = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--project" || token === "-p") {
      const next = tokens[index + 1];
      if (!next) return deny(ReasonCode.INVALID_ARGUMENT, "--project requires a value");
      projectId = next;
      explicitProject = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--project=")) {
      projectId = token.slice("--project=".length);
      explicitProject = true;
      continue;
    }
    if (token.startsWith("project=")) {
      projectId = token.slice("project=".length);
      explicitProject = true;
      continue;
    }
    if (token === "--mode") {
      const next = tokens[index + 1];
      if (!next) return deny(ReasonCode.INVALID_ARGUMENT, "--mode requires SIMPLE, STANDARD, or GUARDED");
      const parsedMode = parseExecutionMode(next);
      if (!parsedMode) return deny(ReasonCode.INVALID_ARGUMENT, "--mode must be SIMPLE, STANDARD, or GUARDED");
      executionMode = parsedMode;
      index += 1;
      continue;
    }
    if (token.startsWith("--mode=")) {
      const parsedMode = parseExecutionMode(token.slice("--mode=".length));
      if (!parsedMode) return deny(ReasonCode.INVALID_ARGUMENT, "--mode must be SIMPLE, STANDARD, or GUARDED");
      executionMode = parsedMode;
      continue;
    }
    requestTokens.push(token);
  }

  if (!projectId && requestTokens.length > 0 && !explicitProject) {
    projectId = requestTokens.shift() ?? null;
  }
  const request = requestTokens.join(" ").trim();
  if (!request) return deny(ReasonCode.INVALID_ARGUMENT, "/managed requires a request");
  return allow(ReasonCode.OK, { projectId: projectId?.trim() || null, request, executionMode });
};

const parseExecutionMode = (value: string): ExecutionModeValue | null => {
  const normalized = value.toUpperCase();
  return normalized === ExecutionMode.SIMPLE ||
    normalized === ExecutionMode.STANDARD ||
    normalized === ExecutionMode.GUARDED
    ? normalized
    : null;
};

const ownerDecisionIdempotencyKey = (
  update: TelegramUpdate,
  input: ParsedOwnerDecision,
): string => `telegram:owner-decision:${digestOf({
  updateId: update.update_id,
  actor: update.message?.from?.id ?? null,
  runId: input.runId,
  item: input.item,
  approved: input.approved,
  note: input.note,
})}`;

const decisionFromToolResult = <T>(result: ToolResult): Decision<T> => {
  const body = result.structuredContent ?? parseToolContent(result);
  if (!body || typeof body !== "object") {
    return deny(ReasonCode.INTERNAL_ERROR, "Hermes returned an invalid response");
  }
  const value = body as Record<string, unknown>;
  const reasonCode = typeof value["reasonCode"] === "string" && isReasonCode(value["reasonCode"])
    ? value["reasonCode"]
    : ReasonCode.INTERNAL_ERROR;
  if (value["ok"] === true) {
    return allow(reasonCode, value["value"] as T, asEvidence(value["evidence"]));
  }
  return deny(
    reasonCode,
    typeof value["message"] === "string" ? value["message"] : "Hermes mutation was refused",
    asEvidence(value["evidence"]),
  );
};

const parseToolContent = (result: ToolResult): Record<string, unknown> | null => {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const asEvidence = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const truncateTelegramText = (text: string): string =>
  text.length <= 3900 ? text : `${text.slice(0, 3880)}\n[response truncated]`;

/**
 * How many unresolved turns the park reply names individually before summarizing the rest.
 *
 * #695 named every unresolved row so a second one could no longer accumulate silently, but
 * `unresolvedTurns` rows are deliberately never pruned (a claim needs a person, not a timer —
 * see `IngressGuard.prune`), so a conversation that keeps crashing and keeps getting `/again`'d
 * grows this list without bound. Measured directly: 146 unresolved rows already produces a
 * 4,099-character joined line, past Telegram's 4,096-character `sendMessage` limit on its own,
 * before `truncateTelegramText` even runs.
 *
 * `truncateTelegramText` *does* keep the literal send from failing — it hard-caps every reply
 * at 3,900 characters — but a blind slice from the front is the wrong tool for this specific
 * text: it cuts wherever 3,880 characters lands, which is inside the timestamp list itself, and
 * carries away the two lines after it — the ones telling the owner `/again` exists at all. A
 * reply that is technically under the wire limit but says nothing actionable is the same defect
 * (#695's own gap: a fact the owner needs, dropped from what reaches them) with the length check
 * satisfied. Naming a fixed, small number and summarizing the rest keeps the reply informative
 * and bounded on its own terms, without depending on where a generic truncator happens to cut.
 */
const MAX_NAMED_UNRESOLVED_TURNS = 10;

/** The park reply's summary of what is unresolved — every row is counted, only some are named. */
const unresolvedTurnsParkText = (unresolved: readonly UnresolvedTurn[]): string => {
  if (unresolved.length === 1) {
    return `DIRECT parked: an earlier message in this conversation is still unresolved (received ${unresolved[0]!.receivedAt}).`;
  }
  const shown = unresolved.slice(0, MAX_NAMED_UNRESOLVED_TURNS);
  const remaining = unresolved.length - shown.length;
  const timestamps = shown.map((turn) => turn.receivedAt).join(", ");
  const tail = remaining > 0 ? `, and ${remaining} more` : "";
  return `DIRECT parked: ${unresolved.length} earlier messages in this conversation are still unresolved (received ${timestamps}${tail}).`;
};

const replyToMessageIdFor = (update: TelegramUpdate): number | null => {
  const message = update.message;
  const nested = message?.reply_to_message?.message_id;
  const direct = message?.reply_to_message_id;
  const candidate = nested ?? direct;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
};
