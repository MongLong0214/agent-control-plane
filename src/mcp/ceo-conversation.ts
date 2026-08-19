import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
 */
export const DEFAULT_CEO_CONVERSATION_BUDGET_MS = 60_000;

/**
 * A Telegram message is capped at 4096 characters, so a longer completion cannot be delivered
 * as one reply anyway. Asking for more would spend the CEO's quota producing text this seam
 * would then have to truncate.
 */
export const DEFAULT_CEO_CONVERSATION_MAX_TOKENS = 1024;

export interface CeoConversationOptions {
  budgetMs?: number;
  maxTokens?: number;
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
  readonly #budgetMs: number;
  readonly #maxTokens: number;

  constructor(options: CeoConversationOptions = {}) {
    this.#budgetMs = options.budgetMs ?? DEFAULT_CEO_CONVERSATION_BUDGET_MS;
    this.#maxTokens = options.maxTokens ?? DEFAULT_CEO_CONVERSATION_MAX_TOKENS;
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
      return deny(
        ReasonCode.CEO_CONVERSATION_TIMEOUT,
        "the CEO peer did not answer within the conversation budget",
        { budgetMs: this.#budgetMs, error: error instanceof Error ? error.name : "unknown" },
      );
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
