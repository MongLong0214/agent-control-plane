import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve as resolvePath } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Role, RoleBinding } from "../domain/types.ts";
import type { HolderIdentity, UnresolvedOwnerMessage } from "../outbox/outbox.ts";
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
 * belong to the owner-conversation route.
 *
 * **Nothing is pushed at the peer.** The daemon used to hand the text over `sampling/createMessage`
 * and treat the peer's reply as the acknowledgement; that made the message's only durable home the
 * in-flight request, so a peer that died mid-turn lost it and a peer that was absent never got it.
 * The message now lives in the outbox, the peer is sent one constant contentless wake, and the peer
 * comes and takes it over this same authenticated connection. The wake is the only thing this port
 * sends; everything that carries the owner's words is a *pull* the holder authorizes by being the
 * holder.
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
  /**
   * Which registration of this connection this peer's endpoint belongs to.
   *
   * A counter, and its only job is to tell successive registrations apart. An endpoint string
   * cannot: a holder that rebinds the same pathname and registers again produces two registrations
   * that compare equal, and a wake still in flight from the first then writes its outcome into the
   * second's memory. Both reviewers reproduced that in both directions -- a late success erasing a
   * newer registration's refusal, and a late failure poisoning a newer registration that worked.
   *
   * Bumped wherever `endpoint` is assigned, and read by `wake` before it connects and again when
   * its delivery completes: a completion whose registration is no longer the current one changes
   * nothing.
   */
  registration: number;
  /**
   * The wake this registration was sent and that the endpoint refused, or `null` while nothing has
   * contradicted it.
   *
   * A socket path stays a socket after its listener is gone, so every check `wake` makes before it
   * connects can pass while the connect itself is refused: the holder is reported wakeable and no
   * wake arrives. The daemon already learns that the moment a wake fails, and this is where that
   * fact is kept so the report can use it.
   *
   * **Scoped to the registration in force**, and held that way by the two writes rather than by
   * anything stored here: `registerEndpoint` clears it, and a delivery writes it only while the
   * registration it began under is still the current one (`registration`). So a non-null value here
   * always describes the registration the holder is on -- a refusal cannot outlive the fact it
   * describes, which is the rule the scan's own docstring states about refusals in general.
   *
   * The identity is deliberately not repeated in this record. It was, and then the reader compared
   * it as well; with the writes already scoped, that comparison could not be false, and a check
   * nothing can falsify answers "is this guarded?" with a yes it has not earned. Two rows that
   * should have died against it survived, which is how it was found.
   */
  wakeFailure: { readonly shape: WakeFailure["shape"] } | null;
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

/**
 * What one owner-message hand-over gives its holder.
 *
 * `claimed` is the only thing here that carries the owner's words, and `unresolved` deliberately
 * cannot: it is `Outbox`'s own payload-free projection, so "never the payload twice" is a property
 * of the type rather than of this port remembering not to fill one in.
 */
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
  } | null;
  unresolved: readonly UnresolvedOwnerMessage[];
  /**
   * Queued messages this holder is addressed by and is not handed, because their admission proof
   * is no longer current (#1044) — a peer message from a CEO generation that has since rotated.
   * Metadata only. Nothing was written for them; `reject` by id is what retires one.
   */
  withheld: readonly UnresolvedOwnerMessage[];
  hasMore: boolean;
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
}

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
 * The client builds this transport was qualified on — a **set**, and every member of it exact.
 *
 * This route is a **version-pinned local runtime contract**, not a supported public interface and
 * not an external-events API. Nothing outside this deployment may rely on it, and it is expected
 * to need re-qualification when the local runtime moves: the endpoint is created by the client
 * process itself, and what a given build does with a unix socket it was asked to bind is a fact
 * about that build, established by measurement rather than by a published guarantee. So each
 * member is exact rather than a floor — a newer client is *unqualified*, not *newer than
 * qualified*, until somebody measures it and adds it here. Membership is equality on
 * `{name, version}` and nothing looser: no range, no prefix, no semver ordering, and no
 * environment variable that admits a build nobody measured.
 *
 * A set rather than one build because a deployment runs several builds at once. Measured on
 * 2026-09-27: four live clients on three builds, one of whose images the updater had already
 * deleted from disk, and none of them the single build this constant then named. One entitlement
 * could express at most one of them, so every other binding could hold its role and never register
 * a wake endpoint — its messages stored, waiting for a registration that could not come. The set
 * changes how many builds may be qualified, not what qualifies one.
 *
 * "Somebody measures it" names a file per member. `evidence/u6-wake-transport-qualification/`
 * holds one reading per build — the command, the resolved image and its digest, the host, the
 * exact `ROLE_WAKE_FRAME` bytes, and both arms of both invocation shapes — and
 * `tests/feasibility/wake-transport-qualification.test.ts` refuses to let this list and that
 * directory disagree: every member needs a reading, every reading must be a member, and a member
 * whose reading's verdict is not `qualified` fails rather than warns. The C0 pin had no such file:
 * its harness deleted its temp root on exit, so the constant carried a conclusion whose reading no
 * longer existed, and a conclusion nobody can re-read is indistinguishable from one nobody took.
 *
 * Two members, two readings, each taken on 2026-10-01 by `pnpm qualify:wake-transport` with
 * `ACP_CLAUDE_BINARY` pointed at the versioned image, and each carrying the witness its own run
 * minted for every arm (#1012). Each reading names its own image digest, the head it was taken at
 * and which source it read, so no member stands on another's measurement: a build is here because
 * its own reading says `qualified`. Being installed on the same host is not a reading, and an
 * installed build without one is refused like any other.
 *
 * 2.1.282 was a member on a 2026-09-28 reading that carried no witness. That build is no longer
 * installed here, so its reading could not be taken again and it left the set with the reading.
 *
 * Some sessions the set can never admit, because no reading of what they run can be taken. The
 * updater removes superseded images from `~/.local/share/claude/versions/`, and it has removed one
 * a process was still executing: that process keeps running on its open inode, `lsof` still names
 * the path, and nothing can spawn the file again. Measured on 2026-09-28: a live session on
 * 2.1.278, whose image that directory no longer holds. A binding held by such a session is reported
 * like any other holder outside the set and stays unwakeable for as long as the session runs; of
 * the two repairs the daemon's finding offers, only restarting it onto a member is open. A fresh
 * download of the same version is not a way round that: membership is equality on
 * `{name, version}`, so qualifying the download would admit the running session on a reading of a
 * different file, one nobody can show is the image that session executes.
 *
 * Raw captures and logs sit under the git-ignored `evidence/local/`, in a directory named for the
 * build each qualification measured, so qualifying one member does not overwrite the captures
 * another member's reading points at; re-qualifying the same build still does, and the paths
 * resolve only in the checkout that took the reading. All three readings name those scoped paths:
 * the 2.1.268 reading was re-taken rather than carried forward, and no longer rests on its
 * 2026-09-11T08:55:21.640Z run. The three previously recorded historical losses remain
 * unrecoverable. The captures behind the receipt produced at 2026-09-08T23:01:02.003Z were
 * overwritten by the 2026-09-09T14:48:17.913Z run, those in turn by the 2026-09-11T08:55:21.640Z
 * run, and that run's own captures sat at unscoped paths that no reading names any more. No
 * superseded capture is recoverable.
 *
 * The readings behind these values cover an **interactive** start, which the C0 one did not. That
 * matters because `isInteractiveClaudeInvocation` (src/registry/canonical-self-claim.ts) refuses
 * `-p`, `--print`, `--output-format` and `--input-format`: the process that may hold the canonical
 * claim is exactly the shape a headless-only qualification never observed.
 */
export const WAKE_TRANSPORT_QUALIFIED_CLIENTS = [
  { name: "claude-code", version: "2.1.268" },
  { name: "claude-code", version: "2.1.283" },
] as const;

/** One `{name, version}` pair, as an MCP client declares itself and as a reading records it. */
export interface WakeTransportClient {
  readonly name: string;
  readonly version: string;
}

/**
 * Whether `client` is a member of the qualified set — exact equality on both fields, and nothing
 * else.
 *
 * The one membership test. Registration refuses on it and the daemon's unwakeable-binding finding
 * reports on it, so the two cannot come to disagree about which builds may receive a wake: a
 * finding computed from a second copy of this rule would describe a refusal the port does not make.
 *
 * `members` is a parameter so the exactness can be exercised against a set of several builds
 * without editing this module's; every production caller takes the default.
 */
export const isWakeTransportQualified = (
  client: WakeTransportClient | undefined,
  members: readonly WakeTransportClient[] = WAKE_TRANSPORT_QUALIFIED_CLIENTS,
): boolean =>
  client !== undefined && members.some((member) => member.name === client.name && member.version === client.version);

/**
 * The qualified set as it is reported: `name/version` strings and nothing more.
 *
 * Refusal evidence and the daemon's finding both carry this. Neither carries a reading's image
 * path — see `EndpointCheck` for why a persisted `Decision` or a report must not name a local
 * path — and the member list is the answer an operator needs anyway: which builds would have been
 * admitted.
 */
export const wakeTransportQualifiedLabels = (): string[] =>
  WAKE_TRANSPORT_QUALIFIED_CLIENTS.map(({ name, version }) => `${name}/${version}`);

/**
 * Why a connected holder cannot be woken. One value per repair, because the remedies differ and a
 * report that could not tell them apart would have to offer all of them.
 *
 * `no-registered-endpoint` and `registered-endpoint-not-usable` are kept apart for that reason: the
 * first holder has never given the daemon anywhere to knock, and the second gave one that no longer
 * passes the checks `wake` makes before it connects — a socket that has gone, or a state directory
 * whose ownership or mode has changed under it.
 *
 * `registered-endpoint-refused-the-wake` is the state those checks cannot see: the path is still
 * there and still a socket this uid owns, and the connect is refused anyway because the process
 * that bound it is gone. Reproduced by both reviewers, who found `wake` answering ROLE_PEER_FAILED
 * for a holder this scan called wakeable. It is a report of a delivery that **failed**, never of a
 * delivery that would fail: nothing here dials a socket to find out, so a registration that has not
 * been used since it was made is reported usable because nothing has contradicted it yet.
 */
export type UnwakeableCause =
  | "build-outside-the-qualified-set"
  | "no-declared-build"
  | "no-registered-endpoint"
  | "registered-endpoint-not-usable"
  | "registered-endpoint-refused-the-wake";

/**
 * A binding that is active, whose holder is connected, and which still cannot receive a wake.
 */
export interface UnwakeableHolder {
  readonly roleKey: string;
  readonly role: Role;
  /**
   * `name/version` exactly as the connection declared it, or `null` when it declared none. Never a
   * path. `null` is the value `registerEndpoint`'s refusal evidence gives the same peer, so the
   * report and the refusal describe it the same way.
   */
  readonly presented: string | null;
  /** Which of the four states this holder is in. Never a path, for the same reason. */
  readonly cause: UnwakeableCause;
}

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
  /**
   * The durable owner-message ledger, or `null` when the composition wired none.
   *
   * `null` fails closed: the tools exist on the connection and refuse, rather than being absent in
   * a way a caller cannot tell from a role it does not hold. A deployment that forgets this line
   * loses the ability to take owner messages; it never gains the ability to take somebody else's.
   */
  readonly #ownerMessages: OwnerMessageLedger | null;
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
      endpointDir?: string;
      wakeTimeoutMs?: number;
      ownerMessages?: OwnerMessageLedger;
    } = {},
  ) {
    this.#role = role;
    this.#bindings = bindings;
    this.#ownerMessages = options.ownerMessages ?? null;
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
   * An ordinary current holder replaces its earlier connection: the daemon may not yet have
   * observed that socket closing. A scoped attachment acquires only an empty, approved role.
   * Admission clears stale occupancy; holder and endpoint lookups only judge it.
   */
  attach(server: McpServer, authenticate: McpPeerAuthenticator, scopeRoleKey?: string): () => void {
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
      if (scopeRoleKey !== undefined && binding.roleKey !== scopeRoleKey) continue;
      this.#clearStalePeer(binding.roleKey);
      if (scopeRoleKey !== undefined && this.#live.has(binding.roleKey)) continue;
      this.#live.set(binding.roleKey, {
        server,
        authenticate,
        binding,
        endpoint: null,
        registration: 0,
        wakeFailure: null,
      });
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

  #clearStalePeer(roleKey: string): void {
    if (!this.currentHolderConnected(roleKey)) this.#live.delete(roleKey);
  }

  /** Pure eligibility lookup; admission owns stale-slot cleanup. connected() is a stored snapshot. */
  currentHolderConnected(roleKey: string): boolean {
    const peer = this.#live.get(roleKey);
    return peer !== undefined && this.#holderFor(peer.server, roleKey).allowed;
  }

  /** The endpoint this role's live peer registered, or `null`. Exported for the wake's own rows. */
  endpointFor(roleKey: string): string | null {
    if (!this.currentHolderConnected(roleKey)) return null;
    return this.#live.get(roleKey)?.endpoint ?? null;
  }

  /**
   * Every binding whose holder is connected and cannot be woken, and why.
   *
   * These are the bindings that read ACTIVE, have a live peer, and still receive no wake: an
   * addressed message is stored and waits for a delivery that will not happen. Nothing about that
   * is loud on its own — the symptom is only that wakes never arrive — so the daemon reports what
   * this returns.
   *
   * **Unwakeable is unwakeable, whatever the reason**, and this scan used to return early on
   * `isWakeTransportQualified`, which made a qualified build the one state it never reported. A
   * holder on a qualified build that has registered no endpoint is exactly as unreachable as one
   * outside the set: `wake` refuses it with ROLE_PEER_UNSUPPORTED for want of an endpoint, and
   * `endpointFor` answers `null`. That is the case this whole slice exists to make visible, and it
   * was the one case the report was silent about. The scan's own reasoning about a holder that
   * declared no build — "skipping it made the one case in which the report has no build name to go
   * on the one case it said nothing about" — is the same argument, and the code now follows it in
   * both places.
   *
   * The five causes are distinguished because the repairs are different, and a report that only
   * said "cannot be woken" would have to offer every repair to every holder.
   *
   * The endpoint is **revalidated here**, by the same `#validateEndpointPath` `wake` calls before
   * it connects, so a registration that has since stopped being usable is reported rather than
   * counted as a wakeable holder. It is a filesystem answer and it is taken now: a holder reported
   * usable can become unusable a moment later, and the converse. What this says is what was true
   * when it was asked, which is the same standing every other line of this scan has.
   *
   * Asked of the live connection at the moment of the question rather than recorded when a
   * registration was refused: a peer that never tries to register is just as unwakeable, and a
   * refusal remembered past the connection that earned it would outlive the fact it describes.
   *
   * One thing *is* remembered, and it is bounded by that same rule: a wake this registration was
   * sent and that the endpoint refused (`LivePeer.wakeFailure`). Every check above is a filesystem
   * answer, and a socket path outlives the process that bound it, so a holder whose listener has
   * gone passes all of them and takes no wake — both reviewers reproduced exactly that, with `wake`
   * answering ROLE_PEER_FAILED while this scan called the holder wakeable. The alternative was for
   * this scan to dial every holder's socket, which would put a side-effecting probe of a peer's
   * messaging socket on a path that runs on every doctor refresh; the daemon already learns the
   * fact when a wake it was sending fails, so nothing new is probed. What that buys is narrower
   * than what a probe would claim, and the difference is the honest part: this reports a delivery
   * that **failed**, not one that would fail. A registration nothing has tried is reported usable.
   *
   * A connection that has declared no build is reported, with `presented: null`, not skipped.
   * `registerEndpoint` asks the same predicate, which is false for no build, so that holder is
   * refused exactly as one outside the set is. The SDK records the build only when an `initialize`
   * carrying `clientInfo` parses, and its schema requires `clientInfo`, so "declared none" and
   * "has not completed `initialize`" are one state here. A report taken in the moment between a
   * peer attaching and its `initialize` names that peer too. For that moment the report is true:
   * the peer could not have registered.
   */
  unwakeableHolders(): UnwakeableHolder[] {
    const holders: UnwakeableHolder[] = [];
    for (const [roleKey, peer] of this.#live) {
      if (!this.currentHolderConnected(roleKey)) continue;
      const client = peer.server.server.getClientVersion();
      const presented = client ? `${client.name}/${client.version}` : null;
      const cause = this.#unwakeableCause(client, peer);
      if (cause === null) continue;
      holders.push({ roleKey, role: this.#role, presented, cause });
    }
    return holders;
  }

  /**
   * Why this connection cannot be woken, or `null` for one that can.
   *
   * Ordered as `wake` itself fails: the build, then an endpoint at all, then whether that endpoint
   * still passes the filesystem checks, then whether the last wake this registration was sent
   * actually landed. Each answer is the first thing a wake would stop at, so the cause names the
   * step that would refuse rather than the last one that could.
   *
   * The remembered failure is read, not filtered: what is kept there is already the current
   * registration's, because `registerEndpoint` clears it and `wake` writes it only while the
   * registration its delivery began under is still in force. Filtering here as well was a second
   * copy of that rule which no input could make false.
   */
  #unwakeableCause(client: WakeTransportClient | undefined, peer: LivePeer): UnwakeableCause | null {
    if (!isWakeTransportQualified(client)) {
      return client ? "build-outside-the-qualified-set" : "no-declared-build";
    }
    const endpoint = peer.endpoint;
    if (endpoint === null) return "no-registered-endpoint";
    if (!this.#validateEndpointPath(endpoint).allowed) return "registered-endpoint-not-usable";
    return peer.wakeFailure !== null ? "registered-endpoint-refused-the-wake" : null;
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
   * that process's umask makes it — C0 measured this and the U6 re-qualification measured it again
   * on the pinned build, both chmod'ing only the *directory* and never the socket's own mode
   * (`tests/feasibility/wake-transport-qualification/harness.ts`). Access is gated by the traversal
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
        "a wake endpoint must sit directly in this deployment's owner-only state directory; " +
          `start the client with --messaging-socket-path pointing to a socket directly inside ${dir}`,
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
      // correct endpoint from the qualified build. The 0700 parent is what makes it unreachable.
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
   * The client build is checked here because the endpoint is the client's own artefact: see
   * `WAKE_TRANSPORT_QUALIFIED_CLIENTS`. Membership is exact, and a build outside the set is
   * refused however close its version is to a member's.
   */
  async registerEndpoint(server: McpServer, endpoint: string): Promise<Decision<readonly string[]>> {
    const owned = [...this.#live.entries()].filter(([, peer]) => peer.server === server);
    if (owned.length === 0) {
      return deny(
        ReasonCode.ROLE_PEER_ABSENT,
        "this connection is not the live peer of any binding of this role",
        { role: this.#role },
      );
    }
    for (const [, peer] of owned) {
      const identity = peer.authenticate();
      if (!identity.allowed || !this.#isCurrentHolder(peer.binding, identity.value)) {
        return deny(ReasonCode.ROLE_PEER_STALE, "the registering peer no longer holds its role");
      }
    }
    const client = server.server.getClientVersion();
    if (!isWakeTransportQualified(client)) {
      return deny(
        ReasonCode.ROLE_PEER_UNSUPPORTED,
        "this client build is not one this version-pinned local wake transport was qualified on",
        {
          role: this.#role,
          presented: client ? `${client.name}/${client.version}` : null,
          // The whole set, as `name/version` labels: which builds would have been admitted. No
          // reading's image path, for the reason `EndpointCheck` gives.
          qualified: wakeTransportQualifiedLabels(),
        },
      );
    }
    const validated = this.#validateEndpointPath(endpoint);
    if (!validated.allowed) return validated as Decision<readonly string[]>;

    // Unique across live slots. Two connections naming one path would make a wake for either role
    // arrive at whichever process actually holds the bind, so the second one is refused rather
    // than quietly aliased onto the first.
    for (const [roleKey, peer] of this.#live) {
      if (peer.server !== server && peer.endpoint === validated.value && this.currentHolderConnected(roleKey)) {
        return deny(
          ReasonCode.ROLE_PEER_UNSUPPORTED,
          "another live peer of this role already registered that wake endpoint",
          // Same rule as the validation refusals: the role key names the conflicting slot, which
          // an operator needs, while the path itself stays out of anything persisted or returned.
          { role: this.#role, heldBy: roleKey },
        );
      }
    }
    for (const [, peer] of owned) {
      peer.endpoint = validated.value;
      // A new registration, and a new identity for it. The endpoint string is not one: a holder
      // that rebinds the same pathname registers again under a value that compares equal, and a
      // wake still in flight from the previous registration would then complete into this one's
      // memory. Every delivery carries the number it began under and writes nothing if it is no
      // longer this one.
      peer.registration += 1;
      // A registration is a new fact about where to knock, so whatever the previous one failed to
      // deliver says nothing about this one. A refusal carried across a registration would outlive
      // the fact it describes: a holder that rebound and registered again would be reported
      // unwakeable on the strength of a delivery to the process before it.
      //
      // Cleared before the wake below, which is what decides whether *this* registration has a
      // failure of its own, and the clearing is observable only between the two. A row observes it
      // there, from the listener the wake is delivered to:
      // `a-registration-forgets-the-refusal-it-inherited`.
      //
      // What the memory describes once this method returns is the newest registration's delivery,
      // which is this one unless the holder registered again while this wake was in flight -- a
      // completion that outlived its own registration writes nothing (`wake`).
      peer.wakeFailure = null;
    }
    const registered = owned.map(([roleKey]) => roleKey);

    // §3 — one constant wake per registered slot, unconditionally, and this is what makes the
    // whole path pollerless. A message admitted while nobody was attached is durable and PENDING,
    // and the wake that would have nudged its holder was refused for want of an endpoint; without
    // this line the only thing that would ever move it is another owner message. Sending it
    // unconditionally — rather than only when something is known to be queued — means this port
    // never has to ask the ledger a question, and an empty queue costs one refused connect.
    //
    // The outcome is deliberately discarded. Registration succeeded on the strength of the checks
    // above; a wake that does not land says nothing about whether the endpoint is registered, and
    // folding it into this decision would make a correct registration look refused.
    for (const roleKey of registered) await this.wake(roleKey);
    return allow(ReasonCode.OK, registered);
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

    // Read before the connect and compared after it. What this delivery is about is the
    // registration in force when it began; by the time it completes the holder may have registered
    // again, and a completion that wrote into the current registration's memory would be reporting
    // the previous endpoint's delivery as this one's. Both directions of that were reproduced.
    const registration = peer.registration;
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
      // Remembered against the registration it was sent under, so the scan can report a holder
      // whose registration is valid on the filesystem and still takes no wake -- the one unwakeable
      // state no check made before connecting can see. Not a probe: this is a delivery that was
      // going to happen anyway, and what is kept is its outcome.
      //
      // Only while that registration is still the one in force. A failure from a registration the
      // holder has already replaced says nothing about where it now asks to be knocked on, and
      // writing it here would report a working registration as refused. The decision below is
      // returned either way: the wake this caller sent did fail, whatever has happened since.
      if (peer.registration === registration) {
        peer.wakeFailure = { shape: (failure as WakeFailure).shape };
      }
      return deny(ReasonCode.ROLE_PEER_FAILED, "the peer's wake endpoint did not accept the wake", {
        role: this.#role,
        roleKey,
        shape: (failure as WakeFailure).shape,
      });
    }
    // A wake that landed is the contradiction of an earlier one that did not, so the memory goes --
    // and only the memory of the registration this delivery belonged to. A success completing after
    // the holder registered again used to clear unconditionally, which erased the newer
    // registration's own refusal and reported a holder nothing can wake as wakeable.
    if (peer.registration === registration) peer.wakeFailure = null;
    return allow(ReasonCode.OK, undefined);
  }

}
