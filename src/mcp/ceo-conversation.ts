import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  CEO_CONVERSATION_BUDGET_MS,
  CEO_REPLY_TIMEOUT_MS,
  assertOuterOutlastsInner,
} from "../contracts/ceo-turn-budget.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { McpPeerAuthenticator } from "./shared.ts";

/**
 * How long the daemon will hold a Telegram turn open waiting for the CEO to answer.
 *
 * The long-poll loop is single-threaded per update, so this is the ceiling on how long one
 * ordinary message can stall the next one. A CEO that is genuinely thinking for longer than
 * this is not a state the chat should hide: the owner gets a timeout they can retry, rather
 * than silence.
 *
 * It is no longer written down here. This deadline contains the runtime's own reply timeout,
 * and as two independent constants they were ordered backwards — 60s out, 120s in — so the
 * daemon gave up while the runtime was still waiting. See `contracts/ceo-turn-budget.ts`, which
 * also records why neither number is yet sized against a measured turn.
 */
export const DEFAULT_CEO_CONVERSATION_BUDGET_MS = CEO_CONVERSATION_BUDGET_MS;

/**
 * A Telegram message is capped at 4096 characters, so a longer completion cannot be delivered
 * as one reply anyway. Asking for more would spend the CEO's quota producing text this seam
 * would then have to truncate.
 */
export const DEFAULT_CEO_CONVERSATION_MAX_TOKENS = 1024;

export interface CeoConversationOptions {
  budgetMs?: number;
  maxTokens?: number;
  /**
   * The deadline the peer runtime applies to its own reply source, when it is not the default.
   *
   * The port cannot observe it — the runtime is a separate process — so a caller that shortens
   * one side has to say so, or the check below is comparing against a number the peer stopped
   * using.
   */
  peerReplyTimeoutMs?: number;
}

/**
 * The daemon's side of §6.1 `DIRECT`: ordinary conversation reaches whoever currently holds
 * the CEO socket, and their answer comes back as text.
 *
 * This is deliberately not a port onto the Hermes tool surface. MCP sampling runs
 * server→client, which is the direction the CEO socket already has — the peer is the client —
 * so no new transport, port or credential appears, and the only thing that can cross is a
 * completion. An owner decision cannot arrive this way: it is minted by the ingress that
 * authenticated the update (CP-HI-07), never asserted by the role holder that read it.
 *
 * **A connection is not standing authority.** An inbound tool call re-authenticates on every
 * request — secret, incarnation, lifecycle, and the binding generation the socket was admitted
 * under. Sampling travels the other way and would otherwise skip all of it, so a former CEO
 * whose socket has not finished closing would keep receiving the owner's conversation after the
 * role moved. `ask` therefore runs the same authenticator before it speaks, and drops a peer
 * that no longer answers for it.
 */
interface LivePeer {
  server: McpServer;
  authenticate: McpPeerAuthenticator;
}


/**
 * Whether a turn reached the CEO, as a fact the boundary produces rather than one the caller
 * names.
 *
 * A refusal that happened **before** `createMessage` is positive evidence that nothing ran: no
 * process was spawned, no row was written, the CEO never heard the message. A refusal after it
 * is not — a timeout, a socket close, a rejection and a kill attempt all leave a child that may
 * still be appending, and the CEO's verdict on #651 names those explicitly as *not* evidence.
 *
 * The distinction is a type rather than a reason code because a reason code is a label the
 * caller attaches. Adding a new refusal and reusing an existing code would silently move it to
 * the wrong side; this way the person adding one has to choose, and the choice is what the
 * settle path reads.
 *
 *     NEVER_REACHED   nothing was asked of the CEO. Safe to settle as never admitted.
 *     REACHED         the request was sent. What happened after it is not observable here.
 */
export type CeoTurnContact = "NEVER_REACHED" | "REACHED";

/**
 * An answer, or a refusal that carries which side of the boundary it fell on.
 *
 * `contact` is deliberately not derivable from `reasonCode`: the point is that the executor
 * boundary states it, so a later reader is not inferring non-execution from an error string.
 */
export type CeoTurnOutcome =
  | { readonly contact: "REACHED"; readonly answered: Decision<string> }
  | { readonly contact: "NEVER_REACHED"; readonly answered: Decision<string> };

export class CeoConversationPort {
  #live: LivePeer | null = null;
  /**
   * Whether a turn is already open on the CEO's canonical session.
   *
   * Nothing downstream enforces this. The runtime fires its reply command with `void` and keeps
   * no queue, so two overlapping turns both reach `hermes chat --resume <same id>` and
   * interleave in a transcript the CEO then carries forward as context. That cannot be unwound
   * and the CEO cannot tell it happened.
   *
   * Today the property holds anyway, because `TelegramLongPoller.pollOnce` awaits each update in
   * turn — the stack frame is the mutex. #630 removes that await, so the invariant is made
   * explicit here first, while it is still true, rather than after it stops being true.
   */
  #inFlight = false;
  /**
   * Set at the one place the request crosses to the peer, and read by `attempt`.
   *
   * A flag rather than a return value because `ask`'s signature is used by callers that do not
   * care; what matters is that it is set *at* `createMessage` and nowhere else, so no refusal
   * can claim to have reached the CEO and no dispatch can claim not to have.
   */
  #reachedPeer = false;
  readonly #budgetMs: number;
  readonly #maxTokens: number;

  constructor(options: CeoConversationOptions = {}) {
    this.#budgetMs = options.budgetMs ?? DEFAULT_CEO_CONVERSATION_BUDGET_MS;
    this.#maxTokens = options.maxTokens ?? DEFAULT_CEO_CONVERSATION_MAX_TOKENS;
    // Checked here rather than only at the constants, because the defaults are the one case
    // that cannot go wrong — they are derived. An override is where the inversion comes back,
    // and a deployment that shortens the budget would otherwise fail as an unexplained timeout
    // on every turn.
    assertOuterOutlastsInner(this.#budgetMs, options.peerReplyTimeoutMs ?? CEO_REPLY_TIMEOUT_MS);
  }

  /**
   * Records the peer that may be asked, returning its own detach.
   *
   * A later connection replaces an earlier one. Both had to authenticate as the session
   * holding the active CEO binding, so this is a reconnect rather than a takeover — and
   * refusing the second would strand conversation on a socket whose peer has already gone
   * while the daemon has not yet observed the close. Detach is identity-checked so a late
   * close from the replaced connection cannot clear its successor.
   */
  attach(server: McpServer, authenticate: McpPeerAuthenticator): () => void {
    const peer: LivePeer = { server, authenticate };
    this.#live = peer;
    return () => {
      if (this.#live === peer) this.#live = null;
    };
  }

  connected(): boolean {
    return this.#live !== null;
  }

  /**
   * The turn, with the contact fact the settle path needs.
   *
   * `ask` stays as the narrow "give me an answer" call every existing caller uses; this is the
   * one a coordinator uses, because settling a claim requires knowing which side of the peer
   * call the outcome came from and `Decision` cannot carry that.
   */
  async attempt(text: string): Promise<CeoTurnOutcome> {
    const before = this.#reachedPeer;
    this.#reachedPeer = false;
    try {
      const answered = await this.ask(text);
      return this.#reachedPeer
        ? { contact: "REACHED", answered }
        : { contact: "NEVER_REACHED", answered };
    } finally {
      this.#reachedPeer = before;
    }
  }

  async ask(text: string): Promise<Decision<string>> {
    const peer = this.#live;
    if (!peer) {
      return deny(
        ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
        "no CEO peer is connected to answer ordinary conversation",
        {},
      );
    }

    if (this.#inFlight) {
      // Refused rather than queued. A queue here would hold the caller for the length of a turn,
      // which is the stall this port is being taken out of the poll loop to remove — and the
      // ordering a queue would impose is #631's to own, where the update is durable. Refusing
      // says the true thing now: this turn did not start.
      return deny(
        ReasonCode.CEO_CONVERSATION_BUSY,
        "a turn is already open on the CEO's canonical session",
        {},
      );
    }

    // The same check an inbound tool call makes, before anything is sent outbound. A socket
    // admitted under a superseded binding generation is a former CEO, and the owner's
    // conversation is not its to receive.
    const current = peer.authenticate();
    if (!current.allowed) {
      if (this.#live === peer) this.#live = null;
      return deny(
        ReasonCode.CEO_CONVERSATION_STALE,
        "the connected peer no longer holds the CEO role its socket was admitted under",
        { authenticator: current.reasonCode },
      );
    }

    const server = peer.server;
    if (!server.server.getClientCapabilities()?.sampling) {
      return deny(
        ReasonCode.CEO_CONVERSATION_UNSUPPORTED,
        "the connected CEO peer did not declare the sampling capability",
        {},
      );
    }

    let result: Awaited<ReturnType<McpServer["server"]["createMessage"]>>;
    // The boundary. Everything above refused without asking the CEO anything; everything below
    // has, whatever it returns.
    this.#reachedPeer = true;
    // Set here rather than at the top: everything above refuses without reaching the session, so
    // marking those as a turn would lock the CEO out on a failure that never touched it.
    this.#inFlight = true;
    try {
      result = await server.server.createMessage(
        {
          messages: [{ role: "user", content: { type: "text", text } }],
          maxTokens: this.#maxTokens,
        },
        { timeout: this.#budgetMs },
      );
    } catch (error) {
      // The peer's own message is not repeated into the chat: it is written by the CEO
      // runtime and may quote whatever it was handling when it failed.
      //
      // `createMessage` rejects with one of three distinct shapes, and folding them into one
      // reason code (#633) told the owner "did not answer in time" for two outcomes that are
      // not a timeout at all:
      //   - `McpError` with `ErrorCode.RequestTimeout`: this port's own budget expired. A real
      //     timeout — the peer may still be working, it just did not finish in time.
      //   - `McpError` with `ErrorCode.ConnectionClosed`, or a plain "Not connected" error: the
      //     transport closed or was already gone. Neither side finished the round trip.
      //   - Any other `McpError`: the peer received the turn and answered with a JSON-RPC
      //     error. It was reached; it is the one that failed.
      // Anything else is left unclassified rather than guessed into one of the three above.
      if (error instanceof McpError) {
        if (error.code === ErrorCode.RequestTimeout) {
          return deny(
            ReasonCode.CEO_CONVERSATION_TIMEOUT,
            "the CEO peer did not answer within the conversation budget",
            { budgetMs: this.#budgetMs },
          );
        }
        if (error.code === ErrorCode.ConnectionClosed) {
          return deny(
            ReasonCode.CEO_CONVERSATION_TRANSPORT_FAILED,
            "the connection to the CEO peer closed before it answered",
            { budgetMs: this.#budgetMs },
          );
        }
        return deny(
          ReasonCode.CEO_CONVERSATION_PEER_FAILED,
          "the CEO peer received the turn and returned an error instead of an answer",
          { budgetMs: this.#budgetMs, peerErrorCode: error.code },
        );
      }
      if (error instanceof Error && error.message === "Not connected") {
        return deny(
          ReasonCode.CEO_CONVERSATION_TRANSPORT_FAILED,
          "the connection to the CEO peer was not available when the turn was sent",
          { budgetMs: this.#budgetMs },
        );
      }
      return deny(
        ReasonCode.INTERNAL_ERROR,
        "the CEO peer turn failed in a way this port does not classify as a timeout, a transport failure, or a peer error",
        { budgetMs: this.#budgetMs, error: error instanceof Error ? error.name : "unknown" },
      );
    } finally {
      // Cleared on every exit, including the timeout. A turn that timed out is over as far as
      // this port is concerned — it has stopped waiting, and holding the flag would lock the
      // owner out of their CEO permanently after one slow turn.
      //
      // The runtime may still have work running behind it; that is #632's problem, and it is
      // not solved by refusing every later turn.
      this.#inFlight = false;
    }

    const content = result.content;
    if (!isTextContent(content)) {
      return deny(
        ReasonCode.CEO_CONVERSATION_NOT_TEXT,
        "the CEO peer answered with content this text-only route cannot deliver",
        { contentType: contentTypeOf(content) },
      );
    }
    return allow(ReasonCode.OK, content.text);
  }
}

const isTextContent = (content: unknown): content is { type: "text"; text: string } =>
  typeof content === "object" &&
  content !== null &&
  (content as { type?: unknown }).type === "text" &&
  typeof (content as { text?: unknown }).text === "string";

const contentTypeOf = (content: unknown): string => {
  if (typeof content !== "object" || content === null) return typeof content;
  const type = (content as { type?: unknown }).type;
  return typeof type === "string" ? type : "unknown";
};
