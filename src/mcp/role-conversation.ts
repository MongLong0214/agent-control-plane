import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Role, RoleBinding } from "../domain/types.ts";
import type { McpPeerAuthenticator } from "./shared.ts";

/**
 * The daemon's destination for a message addressed to a **role** (`#760` Part B / B2).
 *
 * The CEO already had one: `hermes.mcp.sock`'s handler ends with `ceoConversation.attach`, so
 * whoever currently holds the CEO binding is reachable without spawning anything. `cto.mcp.sock`
 * is served by the same `startMcpSocket`, under the same role authentication, and had no
 * equivalent — a message addressed to the CTO had no destination inside the daemon at all, and a
 * person stood in for it. Measured 2026-09-04: CEO messages reached this repository's CTO session
 * only because that session polled the relay by hand, and when the polling stopped the owner
 * carried messages between the two roles.
 *
 * **The address is the role, not the session** (B0). A session holding a role is replaced
 * routinely — that is normal operation, not an incident — so nothing here keys on a session id,
 * and the sender's address string does not change when the holder does.
 *
 * **Absence is not failure.** No peer means the role is between holders; the caller is told so
 * and the event stays where it was. This port never spawns a substitute and never polls; a
 * durable queue in front of it is `#750`'s `inbound_messages`, and the reconnecting peer drains
 * it. Refusing here is what lets that queue stay the single truth.
 *
 * This is deliberately narrower than `CeoConversationPort`. That port carries a Telegram turn's
 * budget, its one-at-a-time rule and its `REACHED`/`NEVER_REACHED` contact fact, all of which
 * belong to the owner-conversation route. Delivery of an addressed message needs one thing from
 * the peer: that it took it.
 */
interface LivePeer {
  server: McpServer;
  authenticate: McpPeerAuthenticator;
  /** The binding this connection was admitted under — the target it may receive mail for. */
  binding: RoleBinding;
}

/**
 * The one question attach and deliver both ask: is this connection still *the* holder of the
 * role it claims? Answered from the registry, never from anything the peer said about itself.
 */
export interface RoleBindingSource {
  active(roleKey: string): RoleBinding | null;
}

const isTextContent = (content: unknown): content is { type: "text"; text: string } =>
  typeof content === "object" &&
  content !== null &&
  (content as { type?: unknown }).type === "text" &&
  typeof (content as { text?: unknown }).text === "string";

/** How long the daemon waits for the peer to take a delivery before it calls the peer gone. */
export const DEFAULT_ROLE_DELIVERY_TIMEOUT_MS = 30_000;

export class RoleConversationPort {
  /**
   * One peer per **roleKey**, not one per socket.
   *
   * `cto.mcp.sock` admits `PRIMARY_CTO` and `BOOTSTRAP_CTO`, and `PRIMARY_CTO` is scoped per
   * project — so a single slot would let the last connection to authenticate become the peer for
   * everyone. A bootstrap CTO, or the primary CTO of another project, would then receive mail
   * addressed to this project's canonical CTO. Keying by `roleKey` is what makes delivery
   * addressed rather than merely last-writer.
   */
  readonly #live = new Map<string, LivePeer>();
  readonly #role: Role;
  readonly #bindings: RoleBindingSource;
  readonly #timeoutMs: number;
  readonly #maxTokens: number;

  constructor(
    role: Role,
    bindings: RoleBindingSource,
    options: { timeoutMs?: number; maxTokens?: number } = {},
  ) {
    this.#role = role;
    this.#bindings = bindings;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_ROLE_DELIVERY_TIMEOUT_MS;
    this.#maxTokens = options.maxTokens ?? 1024;
  }

  get role(): Role {
    return this.#role;
  }

  /**
   * Whether `binding` is, right now, the exact holder this port may deliver to.
   *
   * Three separate questions, because each one alone lets a wrong target through: the role has
   * to be the one this port serves (a `BOOTSTRAP_CTO` is not the canonical CTO), the registry's
   * current holder has to be this same assignment (another project's key answers for its own
   * key, never for this one), and the generation has to still be current (a superseded holder is
   * a former one). None of it is taken from the peer's own claim.
   */
  #isCurrentHolder(binding: RoleBinding): boolean {
    if (binding.role !== this.#role) return false;
    const current = this.#bindings.active(binding.roleKey);
    if (!current) return false;
    return (
      current.assignmentId === binding.assignmentId &&
      current.bindingGeneration === binding.bindingGeneration &&
      current.role === this.#role
    );
  }

  /**
   * Records the peer that may be delivered to, returning its own detach.
   *
   * A later connection replaces an earlier one: both authenticated as the session holding this
   * role's active binding, so the second is a reconnect rather than a takeover, and refusing it
   * would strand delivery on a socket whose peer has already gone while the daemon has not yet
   * observed the close. Detach is identity-checked so a late close from the replaced connection
   * cannot clear its successor.
   */
  attach(
    bindings: readonly RoleBinding[],
    server: McpServer,
    authenticate: McpPeerAuthenticator,
  ): () => void {
    /*
     * **All of the connection's bindings, not one of them.**
     *
     * A session legitimately holds several at once — an older `BOOTSTRAP_CTO` and the
     * `PRIMARY_CTO` of two different projects — and socket admission picks a single one to admit
     * the connection under. Attaching only that one leaves the rest with no destination for as
     * long as the session lives: whichever binding admission happened to choose first is the only
     * role that can be reached, and reconnecting repeats the same choice. So the credential
     * authenticates the *session*, and the slots are enumerated here, from the registry.
     *
     * Each candidate is filtered before it becomes a peer. Attaching first and checking at
     * delivery would already have displaced the real holder, and the displacement is the defect —
     * the canonical CTO would stop receiving mail the moment a bootstrap peer connected. A
     * `BOOTSTRAP_CTO` binding is not a candidate for a `PRIMARY_CTO` slot, and nothing the caller
     * says about itself is consulted.
     */
    const owned: string[] = [];
    for (const binding of bindings) {
      if (!this.#isCurrentHolder(binding)) continue;
      this.#live.set(binding.roleKey, { server, authenticate, binding });
      owned.push(binding.roleKey);
    }
    return () => {
      // Identity-checked per slot: a late close from a replaced connection must not clear its
      // successor, and a connection releases only the slots it is still the peer of.
      for (const roleKey of owned) {
        if (this.#live.get(roleKey)?.server === server) this.#live.delete(roleKey);
      }
    };
  }

  connected(roleKey: string): boolean {
    return this.#live.has(roleKey);
  }

  /**
   * Hands `text` to whoever currently holds the role, and answers whether they took it.
   *
   * The acknowledgement is the peer's own reply, because `accepted` without it is the fault this
   * whole issue is about: a relay that took the bytes is not a reader that saw them (B5).
   */
  async deliver(roleKey: string, text: string): Promise<Decision<string>> {
    const peer = this.#live.get(roleKey);
    if (!peer) {
      return deny(
        ReasonCode.ROLE_PEER_ABSENT,
        "no session is currently attached for this role, so the message was not delivered",
        { role: this.#role, roleKey },
      );
    }

    // The registry is asked again at send time: the holder can move between attach and
    // delivery, and a message addressed to the role is not the former holder's to receive.
    if (!this.#isCurrentHolder(peer.binding)) {
      if (this.#live.get(roleKey) === peer) this.#live.delete(roleKey);
      return deny(
        ReasonCode.ROLE_PEER_STALE,
        "the attached peer no longer holds the role its socket was admitted under",
        { role: this.#role, roleKey, generation: peer.binding.bindingGeneration },
      );
    }

    // The same check an inbound tool call makes, before anything is sent outbound. A socket
    // admitted under a superseded binding generation belongs to a former holder, and a message
    // addressed to the role is not theirs to receive.
    const current = peer.authenticate();
    if (!current.allowed) {
      if (this.#live.get(roleKey) === peer) this.#live.delete(roleKey);
      return deny(
        ReasonCode.ROLE_PEER_STALE,
        "the attached peer no longer holds the role its socket was admitted under",
        { role: this.#role, roleKey, authenticator: current.reasonCode },
      );
    }

    if (!peer.server.server.getClientCapabilities()?.sampling) {
      return deny(
        ReasonCode.ROLE_PEER_UNSUPPORTED,
        "the attached peer did not declare the sampling capability delivery travels on",
        { role: this.#role, roleKey },
      );
    }

    let result: Awaited<ReturnType<McpServer["server"]["createMessage"]>>;
    try {
      result = await peer.server.server.createMessage(
        { messages: [{ role: "user", content: { type: "text", text } }], maxTokens: this.#maxTokens },
        { timeout: this.#timeoutMs },
      );
    } catch (error) {
      // Left as one code on purpose: every branch here means the delivery is unacknowledged, and
      // B5 makes an unacknowledged delivery a debt that is redelivered rather than a state the
      // caller distinguishes. The shape is kept in the evidence for the operator.
      const shape =
        error instanceof McpError
          ? error.code === ErrorCode.RequestTimeout
            ? "timeout"
            : error.code === ErrorCode.ConnectionClosed
              ? "connection-closed"
              : "peer-error"
          : error instanceof Error && error.message === "Not connected"
            ? "not-connected"
            : "unclassified";
      return deny(
        ReasonCode.ROLE_PEER_FAILED,
        "the attached peer did not acknowledge the delivery",
        { role: this.#role, roleKey, timeoutMs: this.#timeoutMs, shape },
      );
    }

    const content = result.content;
    if (!isTextContent(content)) {
      return deny(
        ReasonCode.ROLE_PEER_FAILED,
        "the attached peer acknowledged with content this text-only route cannot read",
        { role: this.#role, roleKey, shape: "not-text" },
      );
    }
    return allow(ReasonCode.OK, content.text);
  }
}
