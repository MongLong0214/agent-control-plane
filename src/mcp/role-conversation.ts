import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Role, RoleBinding } from "../domain/types.ts";
import type { PeerMessageRefusalNotice } from "../ingress/buzz-message.ts";
import type { HolderIdentity, UnresolvedOwnerMessage } from "../outbox/outbox.ts";
import type { AuthenticatedMcpPeer, McpPeerAuthenticator } from "./shared.ts";

/**
 * The daemon's destination for a message addressed to a **role** (`#760` Part B / B2).
 *
 * The CEO already had one: `hermes.mcp.sock`'s handler ends with `ceoConversation.attach`, so
 * whoever currently holds the CEO binding is reachable without spawning anything. `cto.mcp.sock`
 * is served by the same `startMcpSocket`, under the same role authentication, and had no
 * equivalent — a message addressed to the CTO had no destination inside the daemon at all, and a
 * person stood in for it.
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
 * belong to the owner-conversation route.
 *
 * **Nothing is pushed at the peer, and nothing knocks on it.** The daemon used to hand the text
 * over `sampling/createMessage`, and then to send the session a constant contentless frame so that
 * it would come and look. Neither is here: the message lives in the outbox and the holder takes it
 * over this same authenticated connection, which the holder authorizes by being the holder. A
 * frame written into a session's conversation is a prompt nobody typed, and the owner rejected it.
 */
interface LivePeer {
  server: McpServer;
  /**
   * Credential-only: it re-answers "is this connection's session still live and still permitted to
   * hold a bound socket", and nothing about any role. A binding-scoped authenticator would make
   * every slot on the connection depend on whichever binding socket admission happened to pick, so
   * an event in one project would silently drop the session's other projects.
   */
  authenticate: McpPeerAuthenticator;
  /** The binding this slot was opened for — the target it may receive mail for. */
  binding: RoleBinding;
}

/**
 * The one question attach and claim both ask: is this connection still *the* holder of the
 * role it claims? Answered from the registry, never from anything the peer said about itself.
 */
export interface RoleBindingSource {
  active(roleKey: string): RoleBinding | null;
  /**
   * Every ACTIVE binding of this port's role, as the registry currently holds it.
   *
   * Unfiltered on purpose. Filtering candidates by the connection's session here as well would
   * put the same rule in two places, and then removing either one changes nothing observable —
   * which is a guard that cannot be shown to work. The filtering belongs to `#isCurrentHolder`,
   * which is the single place a candidate becomes a peer.
   *
   * What this must not be is "the bindings this session was bound under". An assignment row keeps
   * the session it was created for, and a conversation that survives a failover moves to another
   * runtime without rewriting it, so the historical column is wrong in both directions: it lists
   * roles the session has lost and omits roles it has gained.
   */
  currentCandidates(): readonly RoleBinding[];
}

/**
 * What one owner-message hand-over gives its holder.
 *
 * `claimed` is the only thing here that carries the owner's words, and `unresolved` deliberately
 * cannot: it is `Outbox`'s own payload-free projection, so "never the payload twice" is a property
 * of the type rather than of this port remembering not to fill one in.
 */
/**
 * A claimed message's stored provenance. Each field is `null` when admission did not store it for
 * this message: unknown, never inferred.
 */
export interface OwnerMessageProvenance {
  /** The ingress channel the source row was admitted on. */
  channel: string;
  /** The Buzz room (`h` tag) from the stored signed payload's `conversation`. */
  room: string | null;
  /**
   * The signer's key as the digest-covered stored payload records it. Admission does not put the
   * signer in that payload today, so this is `null`: unknown, not unsigned.
   */
  senderKey: null;
  /**
   * The source row's `actor` column as stored. **Unverified**: the column is written by admission
   * from the authenticated envelope but is not covered by the payload digest the claim checks, and a
   * raw edit of it shows here. Never a basis for owner judgement, approval or authority.
   */
  storedActorUnverified: string | null;
  /** The original Buzz event id, from the source row's nonce. */
  eventId: string | null;
  /**
   * The event this one explicitly replied to, from the digest-covered source payload.
   * Unknown on legacy messages or when there was no reply tag; never inferred from text.
   */
  replyToEventId: string | null;
}

export interface OwnerMessageHandover {
  claimed: {
    messageId: string;
    /** The original text, re-read from the single durable copy and parsed as untrusted data. */
    text: string;
    sourceNonce: string;
    createdAt: string;
    /**
     * Who the message is from (#1038). `peer` is the CEO's Buzz mention: the holder may act on its
     * questions and work instructions, and it carries no owner authority — no owner gate, no
     * approval, and its completion settles its own turn and nothing the owner is owed.
     */
    principal: "owner" | "peer";
    /**
     * Where the claimed message came from, read only from what admission authenticated and stored
     * for this message's own source row, never from its text or tags and never from another
     * event. Informational: it changes no principal, approval or execution authority.
     */
    provenance: OwnerMessageProvenance;
  } | null;
  unresolved: readonly UnresolvedOwnerMessage[];
  /**
   * Queued messages this holder is addressed by and is not handed, because their admission proof
   * is no longer current (#1044) — a peer message from a CEO generation that has since rotated.
   * Metadata only. Nothing was written for them; `reject` by id is what retires one.
   */
  withheld: readonly UnresolvedOwnerMessage[];
  /**
   * The withheld owner messages that came from a verified Buzz mention whose gate does not hold at
   * claim time, each with the fixed reason `MENTION_NOT_ELIGIBLE`: the holder's identity for the
   * mention's role, the mention's original room or the subscriber's eligibility no longer agree.
   * Absent when there is none. Like every withheld row, nothing was written for them.
   */
  mentionWithheld?: readonly { readonly messageId: string; readonly reason: "MENTION_NOT_ELIGIBLE" }[];
  hasMore: boolean;
  /**
   * CEO peer messages ACP rejected while they were queued for this role — on a revoke, a takeover
   * by another runtime, a runtime move, or a canonical restart that did not carry them
   * (ACP-PEER-SUCCESSION-01, ACP-RESTART-04) — that no holder has reported yet, with the reason.
   * Shown to the role's current holder whether or not it is the restart's successor; the name is
   * the restart's, where the first of these came from. The daemon cannot sign Buzz in a canonical
   * room, so this is how the CEO gets told — the CTO says so in the thread, then reports it with
   * `reportRefusal`. Message id, source event id, signer and reason only; never the payload.
   * Absent when there is none.
   */
  refusedAtRestart?: readonly PeerMessageRefusalNotice[];
}

/**
 * The durable owner-message ledger, as the connection-bound tools reach it.
 *
 * Every method takes a `HolderIdentity` this port derived, never one a caller supplied — see
 * `#holderFor`. The implementations own the transactions: a claim re-verifies its source and
 * terminally rejects the row it just took if that source does not check out, and a settle closes
 * the outbox row and the matching ingress claim together or closes neither.
 */
export interface OwnerMessageLedger {
  claim(holder: HolderIdentity): Decision<OwnerMessageHandover>;
  complete(messageId: string, holder: HolderIdentity): Decision<void>;
  reject(messageId: string, holder: HolderIdentity): Decision<void>;
  /** The holder told the CEO about one `refusedAtRestart` notice (ACP-RESTART-04). */
  reportRefusal(messageId: string, holder: HolderIdentity): Decision<void>;
}

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
  /** Open connections for the live binding, in attachment order. Older bindings are discarded. */
  readonly #connections = new Map<string, Set<LivePeer>>();
  readonly #role: Role;
  readonly #bindings: RoleBindingSource;
  /**
   * The durable owner-message ledger, or `null` when the composition wired none.
   *
   * `null` fails closed: the tools exist on the connection and refuse, rather than being absent in
   * a way a caller cannot tell from a role it does not hold. A deployment that forgets this line
   * loses the ability to take owner messages; it never gains the ability to take somebody else's.
   */
  readonly #ownerMessages: OwnerMessageLedger | null;

  constructor(role: Role, bindings: RoleBindingSource, options: { ownerMessages?: OwnerMessageLedger } = {}) {
    this.#role = role;
    this.#bindings = bindings;
    this.#ownerMessages = options.ownerMessages ?? null;
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
  #isCurrentHolder(binding: RoleBinding, peer: AuthenticatedMcpPeer): boolean {
    if (binding.role !== this.#role) return false;
    const current = this.#bindings.active(binding.roleKey);
    if (!current) return false;
    return (
      current.assignmentId === binding.assignmentId &&
      current.bindingGeneration === binding.bindingGeneration &&
      current.role === this.#role &&
      // The runtime, not the assignment. Everything above can match while the conversation has
      // moved to a different session, and delivering on the strength of assignment identity alone
      // sends the role's mail to the runtime it used to live on.
      current.sessionId === peer.sessionId &&
      current.sessionIncarnation === peer.sessionIncarnation
    );
  }

  /**
   * Records the peer that may be delivered to, returning its own detach.
   *
   * The newest ordinary connection is current; earlier open connections of the same binding
   * remain available for fallback. A scoped attachment acquires only an empty, approved role.
   * Admission clears stale occupancy; holder and endpoint lookups only judge it.
   */
  attach(server: McpServer, authenticate: McpPeerAuthenticator, scopeRoleKey?: string): () => void {
    /*
     * **The connection's slots come from the registry, keyed on who it authenticated as.**
     *
     * A session legitimately holds several bindings at once — the `PRIMARY_CTO` of two different
     * projects — and socket admission picks a single one to admit the connection under. (A
     * `BOOTSTRAP_CTO` is never among them: it holds its session alone, and a session that once
     * held one takes no other role; #246.) Neither that choice nor the assignment history is
     * authority here: the first would make whichever role admission happened to pick the only
     * reachable one, and the second names the session a conversation *was* on rather than the one
     * it is on now.
     *
     * So the credential authenticates the session, the registry offers every current binding of
     * this role, and `#isCurrentHolder` — the one enforcement point — keeps the ones whose live
     * runtime is this authenticated session and incarnation. A `BOOTSTRAP_CTO` binding never
     * survives that check, and nothing the caller says about itself is consulted.
     */
    const identity = authenticate();
    if (!identity.allowed) return () => {};
    const peer = identity.value;
    if (!peer.sessionId || !peer.sessionIncarnation) return () => {};

    const owned = new Map<string, LivePeer>();
    for (const binding of this.#bindings.currentCandidates()) {
      if (!this.#isCurrentHolder(binding, peer)) continue;
      if (scopeRoleKey !== undefined && binding.roleKey !== scopeRoleKey) continue;
      // Judge scoped occupancy before cleanup: promotion of a retained predecessor must not
      // make an already-admitted attachment appear acquired without installing its connection.
      if (scopeRoleKey !== undefined && this.currentHolderConnected(binding.roleKey)) continue;
      this.#clearStalePeer(binding.roleKey);
      const previous = this.#live.get(binding.roleKey)?.binding;
      if (!previous || previous.assignmentId !== binding.assignmentId ||
          previous.bindingGeneration !== binding.bindingGeneration ||
          previous.sessionId !== binding.sessionId || previous.sessionIncarnation !== binding.sessionIncarnation) {
        this.#connections.set(binding.roleKey, new Set());
      }
      const connection: LivePeer = {
        server,
        authenticate,
        binding,
      };
      this.#connections.get(binding.roleKey)!.add(connection);
      this.#live.set(binding.roleKey, connection);
      owned.set(binding.roleKey, connection);
    }
    return () => {
      // Remove this exact connection even when it is not current, so a closed predecessor can
      // never be restored. A late close from a discarded binding cannot clear its successor.
      for (const [roleKey, connection] of owned) {
        const connections = this.#connections.get(roleKey);
        connections?.delete(connection);
        if (this.#live.get(roleKey) !== connection) continue;
        this.#clearStalePeer(roleKey);
      }
    };
  }

  connected(roleKey: string): boolean {
    return this.#live.has(roleKey);
  }

  #clearStalePeer(roleKey: string): void {
    const connections = this.#connections.get(roleKey);
    for (const peer of connections ?? []) {
      try {
        if (this.#eligibleConnection(peer)) continue;
      } catch {
        // A late close may outlive the authority's database. Such a connection cannot be
        // restored, and its failed lookup must not prevent other eligible peers surviving.
      }
      connections!.delete(peer);
    }
    const current = connections && [...connections].at(-1);
    if (current) this.#live.set(roleKey, current);
    else {
      this.#live.delete(roleKey);
      this.#connections.delete(roleKey);
    }
  }

  /** Eligibility belongs to each connection's credential, including while it is shadowed. */
  #eligibleConnection(peer: LivePeer): boolean {
    const identity = peer.authenticate();
    return identity.allowed && this.#isCurrentHolder(peer.binding, identity.value);
  }

  /** Pure eligibility lookup; admission owns stale-slot cleanup. connected() is a stored snapshot. */
  currentHolderConnected(roleKey: string): boolean {
    const peer = this.#live.get(roleKey);
    return peer !== undefined && this.#holderFor(peer.server, roleKey).allowed;
  }

  /**
   * The exact holder behind one authenticated connection — every field derived, none supplied.
   *
   * `roleKey` is a **lookup key and nothing more**. It selects a slot; it does not assert anything
   * about the caller, and there is deliberately no argument anywhere on this surface in which a
   * caller could name a session, an incarnation, an assignment, a generation, a pid, a version or
   * a digest. What the holder *is* comes from two places the caller does not control: the
   * connection's own authenticator, and the binding registry.
   *
   * The `peer.server === server` test is the connection-binding itself. Without it, a session that
   * legitimately holds one role could name a sibling slot on the same socket and settle another
   * runtime's messages — the lookup key would have become an address.
   */
  #holderFor(server: McpServer, roleKey: string): Decision<HolderIdentity> {
    const peer = this.#live.get(roleKey);
    if (!peer) {
      return deny(ReasonCode.ROLE_PEER_ABSENT, "no session is currently attached for this role", {
        role: this.#role,
        roleKey,
      });
    }
    if (peer.server !== server) {
      return deny(
        ReasonCode.ROLE_PEER_STALE,
        "this connection is not the live peer of the role it named",
        { role: this.#role, roleKey },
      );
    }
    const identity = peer.authenticate();
    if (!identity.allowed || !this.#isCurrentHolder(peer.binding, identity.value)) {
      return deny(
        ReasonCode.ROLE_PEER_STALE,
        "the attached peer no longer holds the role its socket was admitted under",
        { role: this.#role, roleKey, generation: peer.binding.bindingGeneration },
      );
    }
    // From the registry, not from `peer.binding`: the slot's binding is what admission recorded,
    // and `#isCurrentHolder` has just established that the registry agrees with it. Taking the
    // values from the authority that was consulted keeps a stale copy out of the write.
    const current = this.#bindings.active(roleKey);
    if (!current) {
      return deny(ReasonCode.ROLE_PEER_STALE, "this role has no active binding", {
        role: this.#role,
        roleKey,
      });
    }
    return allow(ReasonCode.OK, {
      roleKey,
      bindingGeneration: current.bindingGeneration,
      targetSessionId: current.sessionId,
      sessionIncarnation: identity.value.sessionIncarnation!,
    });
  }

  #ledger(): Decision<OwnerMessageLedger> {
    if (!this.#ownerMessages) {
      return deny(
        ReasonCode.ROLE_PEER_UNSUPPORTED,
        "this deployment wired no durable owner-message ledger for this role",
        { role: this.#role },
      );
    }
    return allow(ReasonCode.OK, this.#ownerMessages);
  }

  /** Takes at most one of this connection's own owner-messages. See `OwnerMessageLedger`. */
  claimOwnerMessage(server: McpServer, roleKey: string): Decision<OwnerMessageHandover> {
    const holder = this.#holderFor(server, roleKey);
    if (!holder.allowed) return holder as Decision<OwnerMessageHandover>;
    const ledger = this.#ledger();
    if (!ledger.allowed) return ledger as Decision<OwnerMessageHandover>;
    return ledger.value.claim(holder.value);
  }

  /** Records that this connection took and finished one of its own owner-messages. */
  completeOwnerMessage(server: McpServer, roleKey: string, messageId: string): Decision<void> {
    const holder = this.#holderFor(server, roleKey);
    if (!holder.allowed) return holder as Decision<void>;
    const ledger = this.#ledger();
    if (!ledger.allowed) return ledger as Decision<void>;
    return ledger.value.complete(messageId, holder.value);
  }

  /** Refuses one of this connection's own owner-messages, terminally. */
  rejectOwnerMessage(server: McpServer, roleKey: string, messageId: string): Decision<void> {
    const holder = this.#holderFor(server, roleKey);
    if (!holder.allowed) return holder as Decision<void>;
    const ledger = this.#ledger();
    if (!ledger.allowed) return ledger as Decision<void>;
    return ledger.value.reject(messageId, holder.value);
  }

  /**
   * This connection, the role's current holder, takes on telling the CEO about one rejected peer
   * message it was shown under `refusedAtRestart` (ACP-RESTART-04) — before it tells the CEO. Refused
   * when the daemon is already telling the CEO itself (acp-daemon-notice/v1, amendment 1: one channel
   * per notice); the holder then says nothing.
   */
  reportPeerMessageRefusal(server: McpServer, roleKey: string, messageId: string): Decision<void> {
    const holder = this.#holderFor(server, roleKey);
    if (!holder.allowed) return holder as Decision<void>;
    const ledger = this.#ledger();
    if (!ledger.allowed) return ledger as Decision<void>;
    return ledger.value.reportRefusal(messageId, holder.value);
  }
}
