import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

export class CeoConversationPort {
  #live: LivePeer | null = null;
  /**
   * What is known about the last turn on the CEO's canonical conversation.
   *
   * Nothing downstream enforces one-at-a-time. The runtime fires its reply command with `void`
   * and keeps no queue, so two overlapping turns both reach `hermes chat --resume <same id>` and
   * interleave in a transcript the CEO then carries forward as context. That cannot be unwound,
   * and the CEO cannot tell it happened.
   *
   * "Conversation" rather than "session" throughout, because the two systems spell it
   * differently and the difference is load-bearing here: an ACP session is replaceable by
   * failover, while the transcript being protected survives that replacement. A terminology
   * check caught this on the version below and it is the right correction — what must not
   * interleave is the conversation, whichever session is currently serving it.
   *
   * This was a boolean, cleared in a `finally` on every exit including the timeout. A CEO review
   * of that version returned a blocking counterexample, and it is the whole reason this is three
   * states rather than two:
   *
   *     ask #1 hits the daemon's budget → returns TIMEOUT → finally clears the flag
   *     the reply command it spawned is still writing the canonical conversation
   *     ask #2 is admitted → same peer, same canonical conversation → the interleaving
   *
   * A measured turn is 3m15s and the inner deadline is 120s, so that is not a rare race — it is
   * what an ordinary long turn does. The flag was cleared on the caller giving up, which is a
   * fact about the caller, not about the turn.
   *
   * So a turn is only closed by a positively observed terminal answer. An ambiguous end — a
   * timeout, a transport rejection — leaves `OUTCOME_UNKNOWN`, and later turns are refused until
   * something says what happened. Nothing can say that yet (#638), which is why the escape is an
   * explicit one rather than a timer: the automatic path fails closed and the owner keeps a way
   * through (#641).
   */
  #turn: "IDLE" | "IN_FLIGHT" | "OUTCOME_UNKNOWN" = "IDLE";
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

  async ask(text: string): Promise<Decision<string>> {
    const peer = this.#live;
    if (!peer) {
      return deny(
        ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
        "no CEO peer is connected to answer ordinary conversation",
        {},
      );
    }

    if (this.#turn !== "IDLE") {
      // Refused rather than queued. A queue here would hold the caller for the length of a turn,
      // which is the stall this port is being taken out of the poll loop to remove — and the
      // ordering a queue would impose is #631's to own, where the update is durable. Refusing
      // says the true thing now: this turn did not start.
      //
      // The two non-idle states are reported apart because the reader's next move differs. A
      // turn in flight will end; a turn whose outcome is unknown will not, without someone
      // looking. Folding them together would put the second behind advice written for the first.
      return deny(
        this.#turn === "IN_FLIGHT"
          ? ReasonCode.CEO_CONVERSATION_BUSY
          : ReasonCode.CEO_CONVERSATION_OUTCOME_UNKNOWN,
        this.#turn === "IN_FLIGHT"
          ? "a turn is already open on the CEO's canonical conversation"
          : "the previous turn on this session ended without a known outcome",
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
    // Set here rather than at the top: everything above refuses without reaching the session, so
    // marking those as a turn would lock the CEO out on a failure that never touched it.
    this.#turn = "IN_FLIGHT";
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

      // Not cleared to IDLE. The caller has stopped waiting, which says nothing about whether
      // the reply command stopped writing — and the version this replaces cleared here, which
      // is precisely how a second turn reached the same canonical conversation while the first
      // was still writing to it.
      this.#turn = "OUTCOME_UNKNOWN";
      return deny(
        ReasonCode.CEO_CONVERSATION_TIMEOUT,
        "the CEO peer did not answer within the conversation budget",
        { budgetMs: this.#budgetMs, error: error instanceof Error ? error.name : "unknown" },
      );
    }

    // The turn is closed here and nowhere else: `createMessage` resolved, which is the peer
    // saying this turn produced an answer. Everything else — a timeout, a rejection, the caller
    // walking away — is the absence of that statement, not a weaker version of it.
    this.#turn = "IDLE";

    const content = result.content;
    if (!isTextContent(content)) {
      // Still IDLE. The peer answered and the turn is over; this route cannot *deliver* what it
      // answered, which is a fact about the transport, not about whether the conversation was
      // written.
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
