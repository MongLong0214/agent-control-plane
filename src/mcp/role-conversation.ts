import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve as resolvePath } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Role, RoleBinding } from "../domain/types.ts";
import type { AuthenticatedMcpPeer, McpPeerAuthenticator } from "./shared.ts";

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
  /**
   * Credential-only: it re-answers "is this connection's session still live and still permitted to
   * hold a bound socket", and nothing about any role. A binding-scoped authenticator would make
   * every slot on the connection depend on whichever binding socket admission happened to pick, so
   * an event in one project would silently drop the session's other projects.
   */
  authenticate: McpPeerAuthenticator;
  /** The binding this slot was opened for — the target it may receive mail for. */
  binding: RoleBinding;
  /**
   * The peer's own wake endpoint, or `null` until this connection registers one.
   *
   * **On the slot, and nowhere else.** A row in a table would outlive the connection whose
   * existence is the only thing that makes the endpoint real, and then a second authority would
   * answer "is this role wakeable" after the answer had become no. Here availability dies with
   * `attach`'s detach by construction, rather than by a cleanup somebody has to remember to run.
   */
  endpoint: string | null;
}

/**
 * The one question attach and deliver both ask: is this connection still *the* holder of the
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

const isTextContent = (content: unknown): content is { type: "text"; text: string } =>
  typeof content === "object" &&
  content !== null &&
  (content as { type?: unknown }).type === "text" &&
  typeof (content as { text?: unknown }).text === "string";

/** How long the daemon waits for the peer to take a delivery before it calls the peer gone. */
export const DEFAULT_ROLE_DELIVERY_TIMEOUT_MS = 30_000;

/**
 * How long a wake may take. Much shorter than a delivery, and for a different reason: a delivery
 * waits for an agent to answer, a wake waits for a local kernel to accept one line on a socket
 * that is already bound. A wake that has not landed in this window is a wake to something that is
 * not listening, and the durable ingress row is still there for the holder to find.
 */
export const DEFAULT_ROLE_WAKE_TIMEOUT_MS = 2_000;

/**
 * The whole of what a wake says.
 *
 * A constant, opaque, and carrying **no payload** — no sender, no event id, no instruction, not
 * even a count. That is what lets the wake be unauthorized: whoever is on the other end of the
 * endpoint learns only "look at your durable ingress", which is a thing they may already do at any
 * time. Authorization is not here; it is in the connection-bound claim, which a wrong recipient
 * cannot pass. Widen this to carry so much as a nonce and the endpoint becomes a disclosure
 * channel that the socket's file mode is the only thing defending.
 */
export const ROLE_WAKE_TOKEN = "ACP-ROLE-WAKE";

/**
 * The exact bytes of a wake: one newline-delimited JSON frame carrying the token as its content.
 *
 * The frame shape is **part of the version-pinned contract**, not an implementation detail this
 * module may simplify. C0 qualified this transport by writing exactly this envelope — `type`,
 * `message.role`, `message.content` — and a runtime that accepts it accepts it because that is the
 * shape it parses, not because something arrived on the socket. Sending the bare token instead
 * would be a different protocol that happens to reach the same file, and the qualification would
 * say nothing about it.
 *
 * `content` is still the constant opaque token and nothing else, which is the property that
 * matters for what a wake discloses; the envelope around it carries no sender and no event.
 */
export const ROLE_WAKE_FRAME = `${JSON.stringify({
  type: "user",
  message: { role: "user", content: ROLE_WAKE_TOKEN },
})}\n`;

/** The fixed failure shapes a wake may report. A local path is never one of them. */
type WakeFailure = { shape: "timeout" | "connection-refused" | "connection-closed" | "unclassified" };

/**
 * Which endpoint check refused, as a closed set of categories.
 *
 * **The evidence on a refused endpoint may not contain the path, the directory, or any fragment of
 * either.** A `Decision`'s evidence is not a local debug string: it is persisted into audit rows
 * and handed back to callers, so a denial carrying `endpoint` publishes a private local path to
 * every reader of a failed registration — and `wake` re-runs this validation, so an endpoint that
 * was replaced after registration leaks it again on a path nobody is looking at. That is the same
 * disclosure the wake's connect-error classification already refuses to make, on the denial side
 * rather than the catch side.
 *
 * These are categories rather than a single opaque "refused" because an operator still has to know
 * *which* condition failed to act on it — a mode problem on the state directory and a client that
 * bound a regular file need different responses. The category names the check; the caller already
 * knows which path it asked about, and nobody else needs to.
 */
type EndpointCheck =
  | "not-normalized"
  | "not-under-expected-directory"
  | "directory-is-symlink"
  | "directory-not-a-directory"
  | "directory-owner-mismatch"
  | "directory-not-owner-only"
  | "endpoint-is-symlink"
  | "endpoint-not-a-socket"
  | "endpoint-owner-mismatch"
  | "endpoint-not-inspectable"
  | "owner-unknown-on-this-platform";

/**
 * The client build C0 qualified this transport on.
 *
 * This route is a **version-pinned local runtime contract**, not a supported public interface and
 * not an external-events API. Nothing outside this deployment may rely on it, and it is expected
 * to need re-qualification when the local runtime moves: the endpoint is created by the client
 * process itself, and what a given build does with a unix socket it was asked to bind is a fact
 * about that build, established by measurement rather than by a published guarantee. So the pin is
 * exact rather than a floor — a newer client is *unqualified*, not *newer than qualified*, until
 * somebody measures it and moves this constant.
 */
export const C0_QUALIFIED_CLIENT = { name: "claude-code", version: "2.1.259" } as const;

/**
 * Owner-only, in the POSIX sense the 0700 state directory already means: no group bits, no other
 * bits. Read off `stat` rather than assumed from how the file was created, because the mode a
 * process gets when it binds a socket is its umask's business and umasks differ between machines.
 */
const isOwnerOnly = (mode: number): boolean => (mode & 0o077) === 0;

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
  /**
   * The one directory a wake endpoint may live directly beneath — the daemon's own 0700 state
   * directory, where `cto.mcp.sock` and `hermes.mcp.sock` already are.
   *
   * `null` when the composition did not configure one, and then no endpoint is ever accepted. A
   * deployment that forgets this line loses wakeability; it never gains a wake aimed somewhere
   * else.
   */
  readonly #endpointDir: string | null;
  readonly #wakeTimeoutMs: number;

  constructor(
    role: Role,
    bindings: RoleBindingSource,
    options: {
      timeoutMs?: number;
      maxTokens?: number;
      endpointDir?: string;
      wakeTimeoutMs?: number;
    } = {},
  ) {
    this.#role = role;
    this.#bindings = bindings;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_ROLE_DELIVERY_TIMEOUT_MS;
    this.#maxTokens = options.maxTokens ?? 1024;
    this.#endpointDir = options.endpointDir === undefined ? null : resolvePath(options.endpointDir);
    this.#wakeTimeoutMs = options.wakeTimeoutMs ?? DEFAULT_ROLE_WAKE_TIMEOUT_MS;
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
   * A later connection replaces an earlier one: both authenticated as the session holding this
   * role's active binding, so the second is a reconnect rather than a takeover, and refusing it
   * would strand delivery on a socket whose peer has already gone while the daemon has not yet
   * observed the close. Detach is identity-checked so a late close from the replaced connection
   * cannot clear its successor.
   */
  attach(server: McpServer, authenticate: McpPeerAuthenticator): () => void {
    /*
     * **The connection's slots come from the registry, keyed on who it authenticated as.**
     *
     * A session legitimately holds several bindings at once — an older `BOOTSTRAP_CTO` and the
     * `PRIMARY_CTO` of two different projects — and socket admission picks a single one to admit
     * the connection under. Neither that choice nor the assignment history is authority here: the
     * first would make whichever role admission happened to pick the only reachable one, and the
     * second names the session a conversation *was* on rather than the one it is on now.
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

    const owned: string[] = [];
    for (const binding of this.#bindings.currentCandidates()) {
      if (!this.#isCurrentHolder(binding, peer)) continue;
      this.#live.set(binding.roleKey, { server, authenticate, binding, endpoint: null });
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

  /** The endpoint this role's live peer registered, or `null`. Exported for the wake's own rows. */
  endpointFor(roleKey: string): string | null {
    return this.#live.get(roleKey)?.endpoint ?? null;
  }

  /**
   * Everything that has to be true of an endpoint path before the daemon will connect to it.
   *
   * The rejected first attempt at this seam asked `ps` for a pid's argv and treated the answer as
   * proof that the registering process owned the socket. It is not proof of anything: the pid and
   * the argv were both **caller-supplied**, and even a truthful pair says nothing about the path —
   * a different process can bind it while the named pid is still alive. So nothing below asks who
   * bound the socket. It asks only about the *filesystem*, which is the one thing here the daemon
   * can observe for itself:
   *
   *   - the path is exact and already normalized, so a pattern, a relative path, or a `..` that
   *     resolves elsewhere is refused rather than normalized into something acceptable;
   *   - its parent is exactly the configured directory — one level, not "beneath" in the
   *     prefix sense, which `/state/../../tmp/x` satisfies as a string;
   *   - that directory is a directory, owned by this process's uid, mode 0700, and not a symlink;
   *   - the endpoint itself is a socket, owned by this uid, and not a symlink.
   *
   * **The 0700 belongs to the parent, not to the socket file**, and getting that backwards would
   * have rejected every real endpoint. The client binds the socket itself, so its mode is whatever
   * that process's umask makes it — C0 measured 2.1.259 doing exactly this and chmod'ing only the
   * *directory* (`tests/feasibility/native-session-inbox/harness.ts`, which sets the socket
   * directory to 0700 and never touches the socket's own mode). Access is gated by the traversal
   * bit on the parent regardless of what the socket file says, so the parent is where the check
   * belongs and where it is sufficient.
   *
   * Together those say: only this uid could have created it, and only this uid can reach it. That
   * is emphatically **not** "the registering peer created it" — the two are different claims and
   * this one is weaker. It is enough because of what the wake carries, which is a constant token
   * and nothing else: an attacker who could win this race learns that some role was woken, which
   * they could learn by watching the socket exist. Everything a wrong recipient would actually
   * want is behind the connection-bound claim, and no amount of endpoint trickery passes that.
   */
  /**
   * The single construction site for an endpoint refusal — so there is exactly one place that
   * decides what a refused endpoint discloses, and adding a path to the evidence means editing
   * this signature rather than quietly widening one call site.
   */
  #endpointRefusal(check: EndpointCheck, message: string): Decision<string> {
    return deny(ReasonCode.ROLE_PEER_UNSUPPORTED, message, { role: this.#role, check });
  }

  #validateEndpointPath(endpoint: string): Decision<string> {
    const dir = this.#endpointDir;
    if (dir === null) {
      return deny(
        ReasonCode.ROLE_PEER_UNSUPPORTED,
        "this deployment configured no wake endpoint directory, so no endpoint can be registered",
        { role: this.#role },
      );
    }
    // Compared against its own normalization rather than merely normalized: `resolvePath` would
    // turn a relative path into an absolute one under the daemon's cwd, and a `..` chain into a
    // real path, and either would then satisfy the parent check below as the *rewritten* string
    // while the caller had asked for something else.
    //
    // It is honest to say this refuses nothing the parent check would not: `dir` is already
    // resolved, and `dirname` of any un-normalized spelling keeps the un-normalized prefix — a
    // trailing `..` segment, a `.`, a doubled slash and a relative path all produce a parent that
    // is a different string, so every one of them is refused one line down. Measured, not
    // reasoned: mutating this condition to `false` left the row green. It is kept as an explicit
    // statement of what an endpoint must be, not as a second guard, and the row below deliberately
    // does not claim to measure it — the same way `IngressGuard.claimTurn`'s WHERE clause is kept
    // and documented as a second statement of the fact its transaction already guarantees.
    if (endpoint !== resolvePath(endpoint)) {
      return this.#endpointRefusal(
        "not-normalized",
        "a wake endpoint must be an exact absolute normalized path",
      );
    }
    if (dirname(endpoint) !== dir) {
      return this.#endpointRefusal(
        "not-under-expected-directory",
        "a wake endpoint must sit directly in this deployment's owner-only state directory",
      );
    }
    const uid = process.getuid?.();
    if (uid === undefined) {
      return this.#endpointRefusal(
        "owner-unknown-on-this-platform",
        "this platform cannot answer who owns a path",
      );
    }
    try {
      // `lstat`, not `stat`, in both places. A symlink whose target satisfies every check is still
      // a name the holder can repoint after registration, and following it here would validate the
      // target while the daemon later connects to whatever the link says at that moment. `stat`
      // would silently make both of these checks about something other than the named path.
      // Each condition gets its own category rather than collapsing into one refusal: a state
      // directory someone has loosened and a state directory that is a symlink are different
      // operator problems, and the category is the only thing left to tell them apart once the
      // path itself is (correctly) not in the evidence.
      const dirStat = lstatSync(dir);
      if (dirStat.isSymbolicLink()) {
        return this.#endpointRefusal(
          "directory-is-symlink",
          "the configured wake endpoint directory is a symlink",
        );
      }
      if (!dirStat.isDirectory()) {
        return this.#endpointRefusal(
          "directory-not-a-directory",
          "the configured wake endpoint directory is not a directory",
        );
      }
      if (dirStat.uid !== uid) {
        return this.#endpointRefusal(
          "directory-owner-mismatch",
          "the configured wake endpoint directory is owned by another uid",
        );
      }
      if (!isOwnerOnly(dirStat.mode)) {
        return this.#endpointRefusal(
          "directory-not-owner-only",
          "the configured wake endpoint directory is reachable by group or other",
        );
      }
      const endpointStat = lstatSync(endpoint);
      // No mode check here on purpose — see the docstring. The socket is the client's own file,
      // created under the client's umask, and demanding owner-only bits on it would refuse a
      // correct 2.1.259 endpoint. The 0700 parent above is what makes it unreachable to others.
      if (endpointStat.isSymbolicLink()) {
        return this.#endpointRefusal("endpoint-is-symlink", "a wake endpoint must not be a symlink");
      }
      if (!endpointStat.isSocket()) {
        return this.#endpointRefusal("endpoint-not-a-socket", "a wake endpoint must be a socket");
      }
      if (endpointStat.uid !== uid) {
        return this.#endpointRefusal(
          "endpoint-owner-mismatch",
          "a wake endpoint must be owned by this process's uid",
        );
      }
    } catch {
      return this.#endpointRefusal(
        "endpoint-not-inspectable",
        "the wake endpoint could not be inspected",
      );
    }
    return allow(ReasonCode.OK, endpoint);
  }

  /**
   * Binds a wake endpoint to **this connection**, for every slot this connection is the peer of.
   *
   * No roleKey argument, deliberately. A caller that named one would be saying which role it is
   * registering for, and the whole of B0 is that the peer does not get to say that — the slots
   * come from the registry via `attach`, and this walks exactly them. So a connection can only
   * ever register an endpoint for roles it is already the current holder of, and there is no
   * argument in which to name somebody else's.
   *
   * The client build is pinned here because the endpoint is the client's own artefact: see
   * `C0_QUALIFIED_CLIENT`.
   */
  registerEndpoint(server: McpServer, endpoint: string): Decision<readonly string[]> {
    const owned = [...this.#live.entries()].filter(([, peer]) => peer.server === server);
    if (owned.length === 0) {
      return deny(
        ReasonCode.ROLE_PEER_ABSENT,
        "this connection is not the live peer of any binding of this role",
        { role: this.#role },
      );
    }
    const client = server.server.getClientVersion();
    if (client?.name !== C0_QUALIFIED_CLIENT.name || client.version !== C0_QUALIFIED_CLIENT.version) {
      return deny(
        ReasonCode.ROLE_PEER_UNSUPPORTED,
        "this client build is not the one this version-pinned local wake transport was qualified on",
        {
          role: this.#role,
          presented: client ? `${client.name}/${client.version}` : null,
          qualified: `${C0_QUALIFIED_CLIENT.name}/${C0_QUALIFIED_CLIENT.version}`,
        },
      );
    }
    const validated = this.#validateEndpointPath(endpoint);
    if (!validated.allowed) return validated as Decision<readonly string[]>;

    // Unique across live slots. Two connections naming one path would make a wake for either role
    // arrive at whichever process actually holds the bind, so the second one is refused rather
    // than quietly aliased onto the first.
    for (const [roleKey, peer] of this.#live) {
      if (peer.server !== server && peer.endpoint === validated.value) {
        return deny(
          ReasonCode.ROLE_PEER_UNSUPPORTED,
          "another live peer of this role already registered that wake endpoint",
          // Same rule as the validation refusals: the role key names the conflicting slot, which
          // an operator needs, while the path itself stays out of anything persisted or returned.
          { role: this.#role, heldBy: roleKey },
        );
      }
    }
    for (const [, peer] of owned) peer.endpoint = validated.value;
    return allow(ReasonCode.OK, owned.map(([roleKey]) => roleKey));
  }

  /**
   * Tells the current holder of `roleKey` that its durable ingress has something in it.
   *
   * Every question this asks is the same one `deliver` asks, in the same order and from the same
   * authorities — is there a peer, is it still the registry's current holder for this exact
   * runtime — because a wake to a former holder is the same mistake as a delivery to one, only
   * quieter. What it does *not* do is carry anything: see `ROLE_WAKE_TOKEN`.
   *
   * The path is re-validated immediately before connecting rather than trusted from registration
   * time. That does not close the race — the socket can be replaced between this `lstat` and this
   * `connect`, and no filesystem check available here can prevent it — and it is not asked to:
   * the constant token is what makes winning the race worth nothing.
   */
  async wake(roleKey: string): Promise<Decision<void>> {
    const peer = this.#live.get(roleKey);
    if (!peer) {
      return deny(ReasonCode.ROLE_PEER_ABSENT, "no session is currently attached for this role", {
        role: this.#role,
        roleKey,
      });
    }
    const identity = peer.authenticate();
    if (!identity.allowed || !this.#isCurrentHolder(peer.binding, identity.value)) {
      if (this.#live.get(roleKey) === peer) this.#live.delete(roleKey);
      return deny(
        ReasonCode.ROLE_PEER_STALE,
        "the attached peer no longer holds the role its socket was admitted under",
        { role: this.#role, roleKey, generation: peer.binding.bindingGeneration },
      );
    }
    if (peer.endpoint === null) {
      return deny(
        ReasonCode.ROLE_PEER_UNSUPPORTED,
        "the attached peer registered no wake endpoint on this connection",
        { role: this.#role, roleKey },
      );
    }
    const revalidated = this.#validateEndpointPath(peer.endpoint);
    if (!revalidated.allowed) return revalidated as Decision<void>;

    try {
      await new Promise<void>((resolveWake, rejectWake: (failure: WakeFailure) => void) => {
        const socket = connect(revalidated.value);
        const fail = (failure: WakeFailure): void => {
          socket.destroy();
          rejectWake(failure);
        };
        socket.setTimeout(this.#wakeTimeoutMs, () => fail({ shape: "timeout" }));
        // Classified, never forwarded. A Node connect error's `message` embeds the path it was
        // given — "connect ECONNREFUSED /run/state/cto.wake.sock" — and this decision's evidence
        // travels into audit rows and back to callers, so forwarding it would publish the private
        // endpoint path to every reader of a failed wake. `deliver` classifies for the same reason.
        socket.once("error", (error: NodeJS.ErrnoException) =>
          fail({
            shape:
              error.code === "ECONNREFUSED"
                ? "connection-refused"
                : error.code === "ECONNRESET" || error.code === "EPIPE"
                  ? "connection-closed"
                  : "unclassified",
          }),
        );
        socket.once("connect", () => {
          // `end` rather than `write` then leaving it open: the peer's read side sees EOF, so a
          // reader does not have to know the frame's length to know the wake is complete. This is
          // what C0 measured the runtime accepting.
          socket.end(ROLE_WAKE_FRAME, () => resolveWake());
        });
      });
    } catch (failure) {
      return deny(ReasonCode.ROLE_PEER_FAILED, "the peer's wake endpoint did not accept the wake", {
        role: this.#role,
        roleKey,
        shape: (failure as WakeFailure).shape,
      });
    }
    return allow(ReasonCode.OK, undefined);
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

    // The registry is asked again at send time, against this connection's own authenticated
    // identity: the holder can move between attach and delivery, and a message addressed to the
    // role is not the former holder's to receive.
    const identity = peer.authenticate();
    if (!identity.allowed || !this.#isCurrentHolder(peer.binding, identity.value)) {
      if (this.#live.get(roleKey) === peer) this.#live.delete(roleKey);
      return deny(
        ReasonCode.ROLE_PEER_STALE,
        "the attached peer no longer holds the role its socket was admitted under",
        { role: this.#role, roleKey, generation: peer.binding.bindingGeneration },
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
