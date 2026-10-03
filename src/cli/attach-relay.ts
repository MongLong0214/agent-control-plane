import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * The canonical CTO's attach relay: a claim client, then a byte pipe.
 *
 * Claude Code spawns this as a stdio MCP server, so it is a descendant of the canonical `claude`
 * process — which is the only thing that can pass the claim socket's kernel-peer and ancestry
 * checks (`src/daemon/canonical-self-claim-listener.ts`, `src/registry/canonical-self-claim.ts`).
 * It performs `actor.claimCanonicalCto` over that socket, keeps the receipt's `{sessionId,
 * sessionSecret}` in one local binding, connects to `cto.mcp.sock` and presents them as the
 * BOUND handshake line (`src/daemon/agentcpd.ts` `authenticateSocket` / `presentedCredential`).
 * Everything after that newline is Claude Code's own traffic, copied byte for byte in both
 * directions.
 *
 * Three properties this file exists to hold, none of which a JSON-RPC-aware relay could have:
 *
 *   - **The handshake is the first line, and nothing of the client's precedes it.** The daemon
 *     reads its first line as the credential. A single client byte ahead of that newline makes
 *     Claude Code's `initialize` the presented credential, and the socket is refused
 *     `MCP_PEER_UNAUTHENTICATED`. `io.stdin` is therefore paused until the handshake is written.
 *   - **`clientInfo` is the client's own.** There is no JSON-RPC code path here at all, so the
 *     value `registerEndpoint` checks for membership (`src/mcp/role-conversation.ts`,
 *     `WAKE_TRANSPORT_QUALIFIED_CLIENTS`) is the real process's, not one this relay could compose.
 *   - **No retry, no reconnect, no backoff.** The credential is the session's own secret, whose
 *     hash is durable, so the daemon cannot tell a pre-restart plaintext from a post-restart one.
 *     "A credential taken before the ACP restart may not be reused" is enforced *here*: the
 *     process holds it only in memory, writes it exactly once, and exits when either side closes.
 *     A reconnect path would be that reuse, which is why its absence is load-bearing rather than
 *     an omission.
 *
 * What changed with #1037 is what a *respawned* relay does. It no longer has to claim — and the
 * claim refuses a binding that is still ACTIVE — because it first asks the canonical CTO's reattach
 * socket, which admits on the process tree rather than on any credential: the connecting relay
 * descends from the very `claude` process the ACTIVE binding's runtime recorded, with the same
 * start, running the same conversation. There is nothing there to reuse, so reconnecting proves
 * exactly what a first connection does, and the reason for the rule above does not reach it. Only
 * when that socket answers that this process holds no binding does the relay claim, which is where
 * a restarted `claude` belongs: its start differs, and a new generation is what fences it. The
 * secret is still never presented on a second connection: a relay that loses its daemon comes back
 * only through that socket, and only to the binding and runtime its first admission named
 * (`relayWithReattach`).
 *
 * The secret never reaches argv, the environment, stdout, stderr or any file: `stdout` carries
 * only bytes that came off the socket after the handshake, and the `stderr` vocabulary is closed
 * to `attach: <stage> <reasonCode>` with the code copied from the daemon's own public envelope.
 *
 * The adopted CEO's relay (`runAdoptedCeoAttachRelay`, #1037) is the same byte pipe with no claim
 * and no handshake in front of it, because its socket authenticates the connection itself.
 *
 * The canonical CTO's relay is also the session's **wake proxy** (`openWakeProxy`). Claude Code
 * 2.1.283 holds a message from a sender that attests no permission mode for the owner's approval
 * when the receiving session bypasses permission prompts, and the daemon's wake is such a message,
 * so a wake written straight to the session's messaging socket no longer starts a turn. A
 * session delivers without holding what its own child processes send after the auth line
 * `{"type":"auth","token":…}` carrying `CLAUDE_CODE_MESSAGING_TOKEN`, and this relay is one: Claude
 * Code spawned it and put `CLAUDE_CODE_MESSAGING_SOCKET` and that token in its environment. So the
 * relay listens on a socket of its own beside the session's, points the session's wake registration
 * at it, and forwards to the session exactly one thing, the constant `WAKE_FRAME`, behind the auth
 * line. Without both variables nothing of this happens and the relay behaves as before.
 */

/**
 * The daemon's own per-line ceiling (`MAX_MCP_LINE_BYTES` in `src/daemon/agentcpd.ts`, and the
 * same value on the claim socket's framing). A first line longer than this is not a line either
 * side would have accepted, so the relay stops rather than buffering without bound.
 */
const MAX_LINE_BYTES = 1024 * 1024;

/**
 * Must name the same method `CANONICAL_SELF_CLAIM_METHOD` does in
 * `src/daemon/canonical-self-claim-listener.ts`. Not imported from there, for the reason
 * `src/cli/agentctl.ts` gives at its own copy: this is a client, never a composition root, and
 * that module's other exports are daemon-side socket and kernel-credential machinery.
 */
const CANONICAL_SELF_CLAIM_METHOD = "actor.claimCanonicalCto";

/** Injected so the unit test drives the relay with in-process streams; the CLI passes `process`. */
export interface AttachRelayIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

/** Exactly the selectors `agentctl claim canonical-cto` takes, so the two argvs stay compatible. */
export interface AttachRelayClaim {
  claimedSessionUuid: string;
  projectId: string;
  expectedBindingGeneration: number;
}

export interface AttachRelayOptions {
  claimSocketPath: string;
  mcpSocketPath: string;
  /** Resolved by the caller. Written to the handshake line and nowhere else. */
  mcpToken: string;
  claim: AttachRelayClaim;
  /**
   * The canonical CTO's reattach socket (#1037). Set, it is asked before any claim, and it is how
   * the relay comes back after the daemon's side of the connection closes: the relay outlives the
   * connection and reattaches instead of exiting (`relayWithReattach`).
   */
  reattachSocketPath?: string;
  /**
   * False when the caller already asked the reattach socket for this attach; the socket is still
   * the one the relay comes back through. Defaults to true.
   */
  initialReattach?: boolean;
  /** Bounds on waiting for a restarted daemon; see `ReattachPolicy`. */
  reattach?: Partial<ReattachPolicy>;
  claimTimeoutMs?: number;
  /**
   * The session's own messaging socket and token. Set, the relay opens its wake proxy; the CLI
   * entry reads both from the environment Claude Code gave it (`sessionMessagingFromEnv`).
   */
  messaging?: SessionMessaging;
}

/**
 * The receiving end of the session's cross-session messaging, as Claude Code hands it to a child:
 * `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`. The token is written to that
 * socket's auth line and nowhere else: not to stderr, not to the daemon, not to any file.
 */
export interface SessionMessaging {
  socketPath: string;
  token: string;
}

/**
 * How long a relay that lost its daemon waits for it, and how often it asks.
 *
 * It waits only while nobody answers on the reattach socket — a daemon that is down or still
 * starting — or while an admitted connection has not finished being restored. Any answer ends the
 * wait: admitted and restored, it carries on; refused, it exits. `maxWaitMs` is one absolute
 * deadline, taken when the connection is lost, over every admission and every restore of that
 * wait (review PR1051-R2); `attemptTimeoutMs` bounds each step inside it and never extends it.
 * `flushTimeoutMs` bounds how long an exiting relay waits for a client that stopped reading
 * (PR1051-R4).
 */
export interface ReattachPolicy {
  maxWaitMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  attemptTimeoutMs: number;
  flushTimeoutMs: number;
}

export const DEFAULT_REATTACH_POLICY: ReattachPolicy = {
  maxWaitMs: 5 * 60_000,
  initialDelayMs: 250,
  maxDelayMs: 5_000,
  attemptTimeoutMs: 35_000,
  flushTimeoutMs: 5_000,
};

/**
 * The most client requests the relay lets wait on the daemon at once. Past it the client's stdin is
 * paused until answers come back, so the in-flight table is bounded by this and not by how fast the
 * client writes (PR1051-R4).
 */
const MAX_PENDING_REQUESTS = 1_024;

/**
 * The JSON-RPC error a client receives for a request the relay could not carry: sent while the
 * relay was reattaching, or in flight when the daemon's side closed. In the implementation-defined
 * server-error range; the message says which of the two it was.
 */
export const RELAY_REATTACHING_ERROR = -32001;

export const ATTACH_EXIT = {
  OK: 0,
  USAGE: 2,
  CLAIM_REFUSED: 3,
  HANDSHAKE_REFUSED: 4,
  STREAM_CLOSED: 5,
  PROTOCOL: 6,
  UNAVAILABLE: 7,
} as const;

/**
 * Strictly greater than the claim listener's own 30 s request budget, for the reason
 * `DEFAULT_OPERATOR_CLIENT_TIMEOUT_MS` gives in `src/cli/agentctl.ts`: the daemon's typed refusal
 * should win the race, so the operator reads why the claim failed rather than that the client
 * gave up.
 */
const DEFAULT_CLAIM_TIMEOUT_MS = 180_000;

/**
 * The binding and runtime one admission named (PR1051-R1): the assignment and its generation, the
 * session and its incarnation. The reattach door's acknowledgement carries it, and so does a claim
 * receipt's `binding`. A relay keeps the one its first admission named and refuses a reconnect that
 * names any other, so coming back after a restart can never adopt a binding or session that
 * replaced its own. Must have the members `CanonicalCtoAdmittedTuple` has in
 * `src/daemon/canonical-self-claim-listener.ts`, which is not imported for the reason given above.
 */
interface AdmittedTuple {
  assignmentId: string;
  bindingGeneration: number;
  sessionId: string;
  sessionIncarnation: string;
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The tuple `value` names, or null when it names none completely. */
const parseAdmittedTuple = (value: unknown): AdmittedTuple | null => {
  if (typeof value !== "object") return null;
  if (value === null) return null;
  const named = value as Partial<Record<keyof AdmittedTuple, unknown>>;
  if (!nonEmptyString(named.assignmentId)) return null;
  if (!Number.isSafeInteger(named.bindingGeneration)) return null;
  if (!nonEmptyString(named.sessionId)) return null;
  if (!nonEmptyString(named.sessionIncarnation)) return null;
  return {
    assignmentId: named.assignmentId,
    bindingGeneration: named.bindingGeneration as number,
    sessionId: named.sessionId,
    sessionIncarnation: named.sessionIncarnation,
  };
};

const sameTuple = (left: AdmittedTuple, right: AdmittedTuple): boolean => {
  if (left.assignmentId !== right.assignmentId) return false;
  if (left.bindingGeneration !== right.bindingGeneration) return false;
  if (left.sessionId !== right.sessionId) return false;
  return left.sessionIncarnation === right.sessionIncarnation;
};

type ClaimOutcome =
  | { kind: "receipt"; sessionId: string; sessionSecret: string; tuple: AdmittedTuple | null }
  | { kind: "unavailable" }
  | { kind: "refused"; reasonCode: string }
  | { kind: "malformed" };

/**
 * One line out, one line back, on the token-less claim socket.
 *
 * Written here rather than through `agentctl`'s shared `exchangeOneLineRequest` because that
 * helper collapses a transport failure, a client-side timeout and a malformed body onto
 * synthesized `Decision` reason codes the claim listener also emits for real denials
 * (`DAEMON_LOCK_LOST`, `OPERATOR_REQUEST_TIMEOUT`, `INTERNAL_ERROR`). The relay has to tell those
 * apart — a server denial keeps its own reason code on `stderr`, a local failure must not borrow
 * one — so the outcome is discriminated at the source instead of guessed from the code.
 */
const performClaim = (
  socketPath: string,
  claim: AttachRelayClaim,
  timeoutMs: number,
): Promise<ClaimOutcome> =>
  new Promise<ClaimOutcome>((resolveClaim) => {
    const socket = createConnection(socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    const timer: NodeJS.Timeout = setTimeout(() => finish({ kind: "unavailable" }), timeoutMs);
    timer.unref();
    const finish = (outcome: ClaimOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveClaim(outcome);
    };
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ method: CANONICAL_SELF_CLAIM_METHOD, params: claim })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf(0x0a);
      if (boundary === -1) {
        if (received.length > MAX_LINE_BYTES) finish({ kind: "malformed" });
        return;
      }
      if (boundary > MAX_LINE_BYTES) return finish({ kind: "malformed" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(received.subarray(0, boundary).toString("utf8")) as unknown;
      } catch {
        return finish({ kind: "malformed" });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return finish({ kind: "malformed" });
      }
      const response = parsed as { allowed?: unknown; reasonCode?: unknown; value?: unknown };
      if (response.allowed !== true) {
        // A denial with no stable code is not a denial this relay can report, and inventing one
        // would put a reason code on stderr that no catalogue declares.
        return typeof response.reasonCode === "string" && response.reasonCode.length > 0
          ? finish({ kind: "refused", reasonCode: response.reasonCode })
          : finish({ kind: "malformed" });
      }
      const value = response.value as { sessionId?: unknown; sessionSecret?: unknown; binding?: unknown } | undefined;
      if (!value || typeof value !== "object") return finish({ kind: "malformed" });
      if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
        return finish({ kind: "malformed" });
      }
      // The creation response is the only time a runtime ever receives its session secret
      // (`src/session/session-registry.ts`). A receipt without one leaves nothing to present on
      // the BOUND handshake, so it is a protocol failure rather than something to work around.
      if (typeof value.sessionSecret !== "string" || value.sessionSecret.length === 0) {
        return finish({ kind: "malformed" });
      }
      finish({
        kind: "receipt",
        sessionId: value.sessionId,
        sessionSecret: value.sessionSecret,
        tuple: parseAdmittedTuple(value.binding),
      });
    });
    socket.once("error", () => finish({ kind: "unavailable" }));
    socket.once("close", () => finish({ kind: "unavailable" }));
  });

type ReattachOutcome =
  | { kind: "admitted"; socket: Socket; tuple: AdmittedTuple | null }
  | { kind: "unbound" }
  | { kind: "unavailable" }
  | { kind: "refused"; reasonCode: string }
  | { kind: "malformed" };

/**
 * The daemon's one "this process holds no binding" answer on the reattach socket
 * (`ReasonCode.CTO_REATTACH_UNBOUND`). Copied rather than imported for the reason the method names
 * above are: this is a client.
 */
const CTO_REATTACH_UNBOUND = "CTO_REATTACH_UNBOUND";

/**
 * Asks the reattach socket, and reads its one answer line before a byte of the client's is sent.
 *
 * `{ok:true}` hands back the connected socket, paused, for the byte pipe, with the tuple the
 * acknowledgement named (null when it named none). `CTO_REATTACH_UNBOUND`, a socket that is not
 * there (an older daemon) or one that never answers sends the caller to the claim. Any other
 * refusal is the daemon's answer about this process and ends the attach. An aborted attempt
 * destroys its socket and answers `unavailable`, so nothing it opened outlives it.
 */
const attemptReattach = (socketPath: string, timeoutMs: number, signal?: AbortSignal): Promise<ReattachOutcome> =>
  new Promise<ReattachOutcome>((resolveReattach) => {
    const socket = createConnection(socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    const timer: NodeJS.Timeout = setTimeout(() => finish({ kind: "unavailable" }), timeoutMs);
    timer.unref();
    const abandon = (): void => finish({ kind: "unavailable" });
    const finish = (outcome: ReattachOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abandon);
      socket.removeListener("data", answer);
      if (outcome.kind === "admitted") socket.pause();
      else socket.destroy();
      resolveReattach(outcome);
    };
    if (signal?.aborted === true) return abandon();
    signal?.addEventListener("abort", abandon, { once: true });
    const answer = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf(0x0a);
      if (boundary === -1) {
        if (received.length > MAX_LINE_BYTES) finish({ kind: "malformed" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(received.subarray(0, boundary).toString("utf8")) as unknown;
      } catch {
        return finish({ kind: "malformed" });
      }
      const reply = (parsed ?? {}) as { ok?: unknown; reasonCode?: unknown; admitted?: unknown };
      if (reply.ok === true) {
        // The daemon writes nothing after its acknowledgement until the client speaks; anything
        // already here belongs to the pipe, not to this reader.
        const rest = received.subarray(boundary + 1);
        if (rest.length > 0) socket.unshift(rest);
        return finish({ kind: "admitted", socket, tuple: parseAdmittedTuple(reply.admitted) });
      }
      if (typeof reply.reasonCode !== "string") return finish({ kind: "malformed" });
      if (reply.reasonCode === CTO_REATTACH_UNBOUND) return finish({ kind: "unbound" });
      finish({ kind: "refused", reasonCode: reply.reasonCode });
    };
    socket.on("data", answer);
    socket.once("error", () => finish({ kind: "unavailable" }));
    socket.once("close", () => finish({ kind: "unavailable" }));
  });

type HandshakeReply =
  | { kind: "refusal"; reasonCode: string }
  | { kind: "malformed" }
  | { kind: "traffic" };

/**
 * Classifies the daemon's *first* line, which is the answer to this relay's own handshake and
 * nothing of the client's.
 *
 * On success the daemon writes no acknowledgement at all, so the first line is already the
 * client's JSON-RPC. On refusal it writes `{"ok":false,"reasonCode":…}` and ends the socket. The
 * two are told apart by `ok === false` with no `jsonrpc` member; anything else is traffic and is
 * forwarded unread. This is the only inspection the relay ever performs, and it stops after the
 * first line.
 */
const classifyFirstLine = (line: string): HandshakeReply => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { kind: "traffic" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "traffic" };
  if ("jsonrpc" in parsed) return { kind: "traffic" };
  const body = parsed as { ok?: unknown; reasonCode?: unknown };
  if (body.ok !== false) return { kind: "traffic" };
  return typeof body.reasonCode === "string" && body.reasonCode.length > 0
    ? { kind: "refusal", reasonCode: body.reasonCode }
    : { kind: "malformed" };
};

/**
 * The deployment token, read from the same Keychain item the launchd launcher reads
 * (`deploy/install-launchd.sh`), with `execFileSync` and no shell.
 *
 * **Module-private on purpose, and that is the boundary, not the file name.** It used to live in
 * `src/cli/agentctl.ts`, in the same module scope as `createOperatorClient` and `dispatch` — one
 * identifier away from every operator code path in the CLI. Nothing there called it, but nothing
 * structural stopped the next line from doing so. Here it is reachable only from
 * `runAttachRelayCommand` below, and it is not exported, so no operator path in any module can
 * name it. `tests/unit/operator-socket.test.ts` asserts both halves: that the operator client
 * cannot acquire a credential by any route, and that this function is not exported.
 *
 * It is deliberately not a selector and not production configuration: a command line is
 * world-readable through `ps`, and the MCP server entry the owner writes for the canonical session
 * sets no environment at all, so `ps -E` on the relay shows no ACP secret either. `ACP_MCP_TOKEN`
 * in the environment is honoured only so a test can hand a spawned relay a synthetic token — the
 * same boundary the Keychain has for a same-uid reader.
 *
 * Written with `??` rather than `&&` deliberately: `scripts/verify-refusal-operands-are-watched.mjs`
 * counts every `&&`/`||` operand in this file and asks for a witness or a stated reason for each,
 * and a nullish default carries neither an unwatched decision nor a debt.
 */
const resolveMcpToken = (): string | null => {
  const fromEnv = process.env["ACP_MCP_TOKEN"] ?? "";
  if (fromEnv.length > 0) return fromEnv;
  const service = process.env["ACP_KEYCHAIN_SERVICE"] ?? "com.agentcontrolplane.agentcpd";
  try {
    const found = execFileSync(
      "security",
      ["find-generic-password", "-w", "-s", service, "-a", "ACP_MCP_TOKEN"],
      // stderr is discarded rather than inherited: this command's failure prose is not something
      // to put on the stderr of a process whose stderr is Claude Code's MCP server log.
      //
      // Bounded: `security` can wait on a keychain the user has not unlocked, and this runs inside
      // an MCP server's startup where a wait is indistinguishable from a hang (#859). The catch
      // below already reads a failure as "no token", which is the fail-closed direction.
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 },
    ).replace(/\n+$/, "");
    return found.length > 0 ? found : null;
  } catch {
    return null;
  }
};

/**
 * The session's messaging socket and token, from the environment Claude Code spawned this relay
 * with, or undefined unless both are there: an older Claude Code, or a client that is not Claude
 * Code, leaves the relay as it was before the wake proxy existed. `??` for the reason
 * `resolveMcpToken` gives.
 */
const sessionMessagingFromEnv = (): SessionMessaging | undefined => {
  const socketPath = process.env["CLAUDE_CODE_MESSAGING_SOCKET"] ?? "";
  const token = process.env["CLAUDE_CODE_MESSAGING_TOKEN"] ?? "";
  if (socketPath.length === 0) return undefined;
  if (token.length === 0) return undefined;
  return { socketPath, token };
};

/**
 * The one thing the wake proxy forwards: `ROLE_WAKE_FRAME` in `src/mcp/role-conversation.ts`, byte
 * for byte. Copied rather than imported for the reason the method names above are: this is a
 * client, and that module is the daemon's. `tests/process/relay-wake-proxy.test.ts` holds the two
 * equal.
 */
const WAKE_FRAME = `${JSON.stringify({ type: "user", message: { role: "user", content: "ACP-ROLE-WAKE" } })}\n`;
const WAKE_FRAME_BYTES = Buffer.from(WAKE_FRAME, "utf8");

/**
 * How long the proxy waits for a sender to finish its frame, and for the session's socket to take
 * the forward: the daemon's own wake budget (`DEFAULT_ROLE_WAKE_TIMEOUT_MS`), since the daemon has
 * stopped waiting by then.
 */
const WAKE_PROXY_TIMEOUT_MS = 2_000;

/** A wake is one short connection; past this many at once the proxy closes new ones on arrival. */
const WAKE_PROXY_MAX_CONNECTIONS = 8;

/** The wake proxy once it is listening: the path the daemon is told to wake, and its teardown. */
interface WakeProxy {
  path: string;
  close(): void;
}

/** The session's messaging socket as one look found it: why it may not be woken, or which file it is. */
type WakeTarget = { refusal: string } | { refusal: null; identity: string };

/**
 * Whether the wake proxy may forward to the session's messaging socket, and which file that is.
 *
 * The checks the daemon makes of a wake endpoint (`#validateEndpointPath` in
 * `src/mcp/role-conversation.ts`), in its order and by its names, made of the socket the proxy
 * forwards to (review PR1057-R1): an exact normalized path; a parent that is a real directory, not
 * a symlink, owned by this uid and reachable by no one else; and the path itself `lstat`ed, never
 * followed — not a symlink, a socket, owned by this uid. With the proxy registered, the daemon
 * checks the proxy and never this socket, so these are the only checks the socket the token goes
 * to gets. The daemon's state-directory check needs no copy: the proxy sits in this socket's
 * directory, and the daemon accepts the proxy only there.
 *
 * Copied rather than imported for the reason `WAKE_FRAME` is. `identity` is the file's device and
 * inode, which tell one socket from another put at the same name.
 */
const inspectWakeTarget = (socketPath: string): WakeTarget => {
  if (socketPath !== resolvePath(socketPath)) return { refusal: "not-normalized" };
  const uid = process.getuid?.();
  if (uid === undefined) return { refusal: "owner-unknown-on-this-platform" };
  try {
    const dir = lstatSync(dirname(socketPath));
    if (dir.isSymbolicLink()) return { refusal: "directory-is-symlink" };
    if (!dir.isDirectory()) return { refusal: "directory-not-a-directory" };
    if (dir.uid !== uid) return { refusal: "directory-owner-mismatch" };
    if ((dir.mode & 0o077) !== 0) return { refusal: "directory-not-owner-only" };
  } catch {
    return { refusal: "directory-not-inspectable" };
  }
  try {
    const target = lstatSync(socketPath);
    if (target.isSymbolicLink()) return { refusal: "endpoint-is-symlink" };
    if (!target.isSocket()) return { refusal: "endpoint-not-a-socket" };
    if (target.uid !== uid) return { refusal: "endpoint-owner-mismatch" };
    return { refusal: null, identity: `${target.dev}:${target.ino}` };
  } catch {
    return { refusal: "endpoint-not-inspectable" };
  }
};

/** A connect error as the daemon's wake classifies one; a Node error message names the path. */
const wakeFailureShape = (error: NodeJS.ErrnoException): string => {
  if (error.code === "ECONNREFUSED") return "connection-refused";
  if (error.code === "ECONNRESET") return "connection-closed";
  if (error.code === "EPIPE") return "connection-closed";
  return "unclassified";
};

/**
 * Opens the wake proxy beside the session's messaging socket, or answers null and says why.
 *
 * **Beside it, rather than in a `wake-proxy/` directory of its own.** The daemon takes a wake
 * endpoint only directly in its state directory (`dirname(endpoint) !== dir` is a refusal), and
 * the session's own socket can register only when it sits there, so the proxy passes the daemon's
 * checks exactly when the session's socket would, with none of them loosened. The name is random,
 * and `listen` refuses a path that already exists. A relay killed before it closes leaves its
 * path behind; nothing sweeps it.
 *
 * **It forwards one constant and nothing else.** A connection is read for at most `WAKE_FRAME`'s
 * length, and is forwarded only if every byte it carried, up to its end, equals `WAKE_FRAME`. A
 * byte that differs, a byte past the frame, a frame with another field, a second line, or a sender
 * that does not end within the bound: the connection is destroyed and nothing reaches the session.
 * That is the whole of what makes the proxy safe. The session delivers what its own child sends
 * without asking the owner, so a proxy that carried any other byte would be a way to type into the
 * session on the owner's behalf.
 *
 * **The forward goes to the environment's socket**, never to a path a caller named, as the auth
 * line and then the frame on one connection that then ends — the order Claude Code documents.
 *
 * **Only while that socket passes the daemon's checks** (`inspectWakeTarget`, review PR1057-R1).
 * The daemon checks the endpoint it is given, and that is the proxy, so the socket the token goes
 * to is checked here: before the proxy opens, then before each forward connects, and once more
 * after the connect and before the auth line is written, when it must still be the file it was
 * before the connect. A socket that fails is sent nothing, reported as `attach: wake forward
 * refused <check>`, and checked afresh at the next wake. No `lstat` sees what `connect` resolved:
 * a name moved elsewhere just for the connect and moved back before the second look passes both.
 * The owner-only directory leaves that move to this uid, which can read this process's environment
 * anyway.
 *
 * **It answers the sender nothing**, as the session's own socket answers the daemon nothing: the
 * daemon's wake counts as delivered once its frame is written and reads no reply, so its
 * classification of a wake is what it was. A forward that fails after that shows only here, as
 * `attach: wake forward failed <shape>`, with no path and no token.
 */
const openWakeProxy = (messaging: SessionMessaging, stderr: Writable): Promise<WakeProxy | null> => {
  const opening = inspectWakeTarget(messaging.socketPath);
  if (opening.refusal !== null) {
    stderr.write(`attach: wake proxy not opened ${opening.refusal}\n`);
    return Promise.resolve(null);
  }
  const path = join(dirname(messaging.socketPath), `acp-wake-proxy-${randomBytes(8).toString("hex")}.sock`);
  const connections = new Set<Socket>();

  const forward = (): void => {
    const before = inspectWakeTarget(messaging.socketPath);
    if (before.refusal !== null) {
      stderr.write(`attach: wake forward refused ${before.refusal}\n`);
      return;
    }
    const out = createConnection(messaging.socketPath);
    let written = false;
    let reported = false;
    const report = (line: string): void => {
      out.destroy();
      if (written) return;
      if (reported) return;
      reported = true;
      stderr.write(line);
    };
    const failed = (shape: string): void => report(`attach: wake forward failed ${shape}\n`);
    out.setTimeout(WAKE_PROXY_TIMEOUT_MS, () => failed("timeout"));
    out.once("error", (error: NodeJS.ErrnoException) => failed(wakeFailureShape(error)));
    out.once("connect", () => {
      // The token is written only to the file that passed before the connect, and passes still.
      const after = inspectWakeTarget(messaging.socketPath);
      if (after.refusal !== null) return report(`attach: wake forward refused ${after.refusal}\n`);
      if (after.identity !== before.identity) return report("attach: wake forward refused endpoint-replaced\n");
      // One write: the auth line is the connection's first line, and the frame is its second.
      out.end(`${JSON.stringify({ type: "auth", token: messaging.token })}\n${WAKE_FRAME}`, () => {
        written = true;
      });
    });
  };

  const server: Server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    let held = Buffer.alloc(0);
    let decided = false;
    const drop = (): void => {
      if (decided) return;
      decided = true;
      socket.destroy();
      stderr.write("attach: wake proxy dropped a connection that was not a wake\n");
    };
    socket.setTimeout(WAKE_PROXY_TIMEOUT_MS, drop);
    socket.on("data", (chunk: Buffer) => {
      if (decided) return;
      held = Buffer.concat([held, chunk]);
      if (held.length > WAKE_FRAME_BYTES.length) return drop();
      // Refused at the first byte that differs, rather than read to the bound and compared then.
      if (!WAKE_FRAME_BYTES.subarray(0, held.length).equals(held)) drop();
    });
    socket.once("end", () => {
      if (decided) return;
      if (!held.equals(WAKE_FRAME_BYTES)) return drop();
      decided = true;
      socket.destroy();
      forward();
    });
    socket.on("error", () => {
      decided = true;
      socket.destroy();
    });
  });
  server.maxConnections = WAKE_PROXY_MAX_CONNECTIONS;

  return new Promise<WakeProxy | null>((resolveProxy) => {
    const notListening = (): void => {
      stderr.write("attach: wake proxy not opened listen-failed\n");
      resolveProxy(null);
    };
    server.once("error", notListening);
    server.listen(path, () => {
      server.removeListener("error", notListening);
      server.on("error", () => undefined);
      // The relay's stdio is what keeps it alive; the proxy never does on its own.
      server.unref();
      resolveProxy({
        path,
        close: () => {
          for (const socket of connections) socket.destroy();
          // Closing a listening unix socket removes its path.
          server.close();
        },
      });
    });
  });
};

/** Everything the CLI knows about an attach. Deliberately no token field: see `resolveMcpToken`. */
export interface AttachRelayCommandOptions {
  claimSocketPath: string;
  mcpSocketPath: string;
  claim: AttachRelayClaim;
  reattachSocketPath?: string;
  reattach?: Partial<ReattachPolicy>;
}

/**
 * The `agentctl attach canonical-cto` entry.
 *
 * It exists so the CLI can start a relay without naming the deployment token — the caller passes
 * socket paths and claim selectors, and the credential is acquired here and goes straight into
 * `runAttachRelay`, which still takes it explicitly so a test can drive the relay with a synthetic
 * one.
 */
export const runAttachRelayCommand = async (
  options: AttachRelayCommandOptions,
  io: AttachRelayIo,
): Promise<number> => {
  // The reattach is tokenless, so it is asked before the deployment credential is: a live
  // claimant whose Keychain is locked or unreadable still reaches its own tools (review
  // PR1046-R2). Resolving the token first was dropped rather than kept: it made the one door that
  // needs no credential unreachable without one. The token is acquired only for the fallback,
  // which presents it on `cto.mcp.sock`.
  io.stdin.pause();
  // Read before either path, so a reattached relay and a claimed one both open the wake proxy.
  const messaging = sessionMessagingFromEnv();
  const reattached = await reattachFirst(
    options.reattachSocketPath,
    DEFAULT_CLAIM_TIMEOUT_MS,
    options.reattach,
    messaging,
    io,
  );
  if (reattached !== CLAIM) return reattached;
  const mcpToken = resolveMcpToken();
  if (mcpToken === null) {
    io.stderr.write("attach: mcp token unavailable\n");
    return ATTACH_EXIT.UNAVAILABLE;
  }
  // The configured door is kept whatever it answered just now (review PR1051-R5): a door that did
  // not answer may belong to a daemon that opened its claim socket and has not yet opened this one.
  return runAttachRelay({ ...options, initialReattach: false, mcpToken, messaging }, io);
};

/** `reattachFirst`'s answer when the reattach did not decide the attach and the claim must. */
const CLAIM = "claim";

/**
 * Asks the reattach socket when there is one. Resolves to the relay's exit code when the reattach
 * decided the attach — admitted and relayed, or refused — and otherwise to `CLAIM`: the door
 * answered that this process holds no binding, or there is no door, or it did not answer.
 *
 * An acknowledgement that names no binding tuple (a daemon older than PR1051) leaves nothing to
 * compare a reconnect against, so that attach keeps the byte pipe that exits with its connection.
 */
const reattachFirst = async (
  reattachSocketPath: string | undefined,
  timeoutMs: number,
  policy: Partial<ReattachPolicy> | undefined,
  messaging: SessionMessaging | undefined,
  io: AttachRelayIo,
): Promise<number | typeof CLAIM> => {
  if (reattachSocketPath === undefined) return CLAIM;
  const reattached = await attemptReattach(reattachSocketPath, timeoutMs);
  if (reattached.kind === "admitted") {
    if (reattached.tuple === null) return pipeStdioToSocket(reattached.socket, io, NO_HANDSHAKE);
    return relayWithReattach(
      reattached.socket,
      NO_HANDSHAKE,
      true,
      reattached.tuple,
      reattachSocketPath,
      policy,
      messaging,
      io,
    );
  }
  if (reattached.kind === "refused") {
    io.stderr.write(`attach: reattach refused ${reattached.reasonCode}\n`);
    return ATTACH_EXIT.HANDSHAKE_REFUSED;
  }
  if (reattached.kind === "malformed") {
    io.stderr.write("attach: reattach reply malformed\n");
    return ATTACH_EXIT.PROTOCOL;
  }
  return CLAIM;
};

export const runAttachRelay = async (
  options: AttachRelayOptions,
  io: AttachRelayIo,
): Promise<number> => {
  // Nothing of Claude Code's moves until the handshake newline is on the wire.
  io.stdin.pause();

  // Unbound, or no reattach socket that answered: the claim decides, as it always has.
  if (options.initialReattach !== false) {
    const reattached = await reattachFirst(
      options.reattachSocketPath,
      options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS,
      options.reattach,
      options.messaging,
      io,
    );
    if (reattached !== CLAIM) return reattached;
  }

  const claimed = await performClaim(
    options.claimSocketPath,
    options.claim,
    options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS,
  );
  if (claimed.kind === "unavailable") {
    io.stderr.write("attach: claim socket unavailable\n");
    return ATTACH_EXIT.UNAVAILABLE;
  }
  if (claimed.kind === "refused") {
    io.stderr.write(`attach: claim refused ${claimed.reasonCode}\n`);
    return ATTACH_EXIT.CLAIM_REFUSED;
  }
  if (claimed.kind === "malformed") {
    io.stderr.write("attach: claim receipt malformed\n");
    return ATTACH_EXIT.PROTOCOL;
  }

  const connection = {
    handshake: (socket: Socket) => {
      // One write, one string, one reference. The order is the whole correctness argument: this
      // newline is what makes the client's first message the *second* line on this socket.
      socket.write(
        `${JSON.stringify({
          token: options.mcpToken,
          sessionId: claimed.sessionId,
          sessionSecret: claimed.sessionSecret,
        })}\n`,
      );
    },
  };
  const first = createConnection(options.mcpSocketPath);
  // With a reattach socket configured, losing this connection is not the end of the attach,
  // whether or not that socket answered at start (PR1051-R5); the secret above is presented on
  // this one connection and never again. A receipt naming no binding leaves nothing to compare a
  // reconnect against, so that attach keeps the byte pipe.
  const door = options.reattachSocketPath;
  if (door === undefined) return pipeStdioToSocket(first, io, connection);
  if (claimed.tuple === null) return pipeStdioToSocket(first, io, connection);
  return relayWithReattach(first, connection, false, claimed.tuple, door, options.reattach, options.messaging, io);
};

/**
 * The adopted CEO's relay (#1037): no claim, no token, no handshake.
 *
 * The adopted CEO tool socket authenticates the connection itself — the kernel's peer, which is
 * this process, descending from the adopted Gateway that spawned it — so there is nothing for this
 * relay to obtain first and nothing for it to present. The first byte on the socket is the
 * client's own. A refusal is the daemon's one `{ok:false,reasonCode}` line, read here exactly as a
 * handshake refusal is above.
 *
 * It still never reconnects, but for a different reason than the CTO relay: there is no
 * credential to reuse. A respawn is simply a new connection, admitted or refused on the same facts
 * as the first one, and Hermes is what respawns it.
 */
export const runAdoptedCeoAttachRelay = (
  options: { toolSocketPath: string },
  io: AttachRelayIo,
): Promise<number> => {
  // The client's bytes wait until the socket is connected, so none is lost to a closed pipe.
  io.stdin.pause();
  return pipeStdioToSocket(createConnection(options.toolSocketPath), io, { handshake: () => undefined });
};

/**
 * The byte pipe every relay shares: once `socket` is connected — now, or when it connects — let
 * `handshake` write first, then carry stdin to the socket and the socket to stdout, inspecting only
 * the daemon's first line for a refusal.
 */
const pipeStdioToSocket = (
  socket: Socket,
  io: AttachRelayIo,
  connection: { handshake(socket: Socket): void },
): Promise<number> =>
  new Promise<number>((resolveRelay) => {
    let settled = false;
    let resolved = false;
    let connected = false;
    let stdinEnded = false;
    let stdoutFailed = false;
    let peeked = Buffer.alloc(0);
    const settle = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolveRelay(code);
    };
    /**
     * Resolving is the last thing that happens, and it may not happen until stdout has flushed.
     *
     * The CLI turns this promise's value into `process.exit`, and stdout is a **pipe** under Claude
     * Code, not a TTY. `process.exit` keeps only what the kernel has already accepted and discards
     * whatever is still in Node's userspace write buffer — measured on this host at 34 470 of
     * 100 006 bytes lost — so resolving while a write is outstanding truncates the daemon's own MCP
     * stream and hands Claude Code a JSON-RPC line that stops mid-token. `writableEnded` is not the
     * condition to wait on: `socket.pipe` has usually already called `end` by this point, and the
     * bytes are still queued. `writableFinished` / the `finish` event is the one that means flushed.
     *
     * `stdin` is unpiped and paused first, so this wait is never a wait on the *other* direction:
     * the socket is destroyed, and leaving the client's stdin flowing into it would trade a
     * truncation for a hang, which is not a repair.
     */
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      io.stdin.unpipe(socket);
      io.stdin.pause();
      if (stdoutFailed || io.stdout.writableFinished) return settle(code);
      io.stdout.once("finish", () => settle(code));
      if (!io.stdout.writableEnded) io.stdout.end();
    };
    const protocolFailure = (): void => {
      io.stderr.write("attach: handshake reply malformed\n");
      finish(ATTACH_EXIT.PROTOCOL);
    };
    const peek = (chunk: Buffer): void => {
      peeked = Buffer.concat([peeked, chunk]);
      const boundary = peeked.indexOf(0x0a);
      if (boundary === -1) {
        if (peeked.length > MAX_LINE_BYTES) protocolFailure();
        return;
      }
      if (boundary > MAX_LINE_BYTES) return protocolFailure();
      const reply = classifyFirstLine(peeked.subarray(0, boundary).toString("utf8"));
      if (reply.kind === "malformed") return protocolFailure();
      if (reply.kind === "refusal") {
        // The reason code, and only the reason code. It never reaches stdout, which is Claude
        // Code's MCP input and admits nothing that is not JSON-RPC.
        io.stderr.write(`attach: handshake refused ${reply.reasonCode}\n`);
        return finish(ATTACH_EXIT.HANDSHAKE_REFUSED);
      }
      // Past this point the relay never inspects another byte in either direction.
      socket.removeListener("data", peek);
      io.stdout.write(peeked);
      socket.pipe(io.stdout);
    };

    io.stdin.once("end", () => {
      stdinEnded = true;
    });
    io.stdin.once("error", () => finish(ATTACH_EXIT.STREAM_CLOSED));
    io.stdout.once("error", () => {
      // A stdout that errors will never emit `finish`, so the flush above has to stop waiting on
      // it. This is the reader having gone away — there is nothing left to deliver to.
      stdoutFailed = true;
      if (settled) settle(ATTACH_EXIT.STREAM_CLOSED);
      else finish(ATTACH_EXIT.STREAM_CLOSED);
    });
    const onConnected = (): void => {
      connected = true;
      // Whatever the handshake writes is on the wire before the client's first byte, because
      // stdin is piped only after it returns.
      connection.handshake(socket);
      socket.on("data", peek);
      // A socket the reattach reader paused stays paused under a new `data` listener; one that
      // was never paused is already flowing and this changes nothing.
      socket.resume();
      io.stdin.pipe(socket);
    };
    if (socket.pending) socket.once("connect", onConnected);
    else onConnected();
    socket.once("error", () => {
      if (!connected) {
        io.stderr.write("attach: mcp socket unavailable\n");
        finish(ATTACH_EXIT.UNAVAILABLE);
        return;
      }
      finish(ATTACH_EXIT.STREAM_CLOSED);
    });
    // EOF and ECONNRESET are the same event to this relay, and a daemon restart produces one of
    // them. There is deliberately no branch here that opens a second connection.
    socket.once("close", () => finish(stdinEnded ? ATTACH_EXIT.OK : ATTACH_EXIT.STREAM_CLOSED));
  });

const NO_HANDSHAKE = { handshake: (): void => undefined };

/** One JSON-RPC message as the relay needs to see it: whether it is a request, and its id. */
interface RelayedMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const parseRelayed = (line: string): RelayedMessage | null => {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object") return null;
  if (value === null) return null;
  if (Array.isArray(value)) return null;
  return value as RelayedMessage;
};

/** A request's id, or undefined for a notification or a response. */
const requestIdOf = (message: RelayedMessage): unknown => {
  if (typeof message.method !== "string") return undefined;
  return message.id;
};

/** A response's id, or undefined for anything that is not a response. */
const responseIdOf = (message: RelayedMessage): unknown => {
  if (message.method !== undefined) return undefined;
  return message.id;
};

const idKey = (id: unknown): string => JSON.stringify(id) ?? "undefined";

/** Splits a byte stream into lines; anything left unterminated past the line bound is refused. */
const lineSplitter = (onLine: (line: string) => void, onOverflow: () => void): ((chunk: Buffer) => void) => {
  let held = Buffer.alloc(0);
  return (chunk) => {
    held = Buffer.concat([held, chunk]);
    for (let boundary = held.indexOf(0x0a); boundary !== -1; boundary = held.indexOf(0x0a)) {
      const line = held.subarray(0, boundary).toString("utf8");
      held = held.subarray(boundary + 1);
      onLine(line);
    }
    if (held.length > MAX_LINE_BYTES) onOverflow();
  };
};

/** A client request in flight: the id the client gave it, and the relay's number for it or null. */
interface InFlightRequest {
  client: unknown;
  upstream: number | null;
}

/** A request of the client's as it arrived: the line, byte for byte, and what it parsed to. */
interface ClientRequest {
  message: RelayedMessage;
  line: string;
}

/** One daemon connection, and everything that belongs to it and to no other (review PR1051-R2). */
interface Link {
  socket: Socket;
  /** Known at once for a reattach; for a claim's handshake, after the first line that is not a refusal. */
  accepted: boolean;
  closed: boolean;
  /**
   * The client's requests written on this link and not yet answered, keyed by the id the relay sent
   * each under: `client` is the id the client gave it, `upstream` the relay's number for it, or
   * null when it left under the client's own id because no proxy was listening (review PR1057-R3).
   */
  inFlight: Map<string, InFlightRequest>;
  /** The relay's own requests on this link, each answered by this link and by no other. */
  waiters: Map<string, (message: RelayedMessage | null) => void>;
  /** Replayable requests written on this link, remembered only once the daemon answers them with success. */
  initializes: Map<string, ClientRequest>;
  wakeRegistrations: Map<string, unknown>;
  /** Whether the relay has registered its wake proxy on this link of its own accord. */
  proxyOffered: boolean;
}

const WAKE_REGISTER_TOOL = "role_wake_endpoint_register";

const succeeded = (message: RelayedMessage): boolean => {
  if (message.error !== undefined) return false;
  return message.result !== undefined;
};

const wakeRegistered = (message: RelayedMessage): boolean =>
  (message.result as { structuredContent?: { ok?: unknown } } | undefined)?.structuredContent?.ok === true;

/** The reason code a refused wake registration carries, for stderr; never anything else of the answer. */
const wakeRefusalReason = (message: RelayedMessage): string => {
  const body = (message.result as { structuredContent?: { reasonCode?: unknown } } | undefined)?.structuredContent;
  return String(body?.reasonCode ?? "UNKNOWN");
};

/**
 * The canonical CTO's relay when it has a reattach socket to come back through (#1037).
 *
 * The byte pipe above exits when the daemon's side closes, and that was the whole of a daemon
 * restart for a canonical CTO: the relay died, Claude Code does not respawn a dead stdio MCP
 * server, and the binding stayed ACTIVE with no tools and no wake path until someone restarted the
 * session. This relay outlives the connection instead:
 *
 *   - **The client's stdio is never closed for it.** A request that arrives while the relay is
 *     reattaching is answered at once with `RELAY_REATTACHING_ERROR`, and a request that was in
 *     flight when the daemon's side closed is answered with the same code and an "outcome unknown"
 *     message. Holding requests until the daemon returns was rejected rather than bounded: nothing
 *     is held for later, so nothing is buffered without bound.
 *   - **It comes back only by reattach, and only to what it left.** The secret a claim returned was
 *     presented on the first connection and is never presented again; the reattach admits on the
 *     process tree, so a reconnect proves what a first connection does and reuses nothing. It never
 *     claims: a refusal — this process holds no binding, the binding was revoked, the ancestry does
 *     not match — ends the relay rather than falling back to a claim. An admission that names a
 *     binding or runtime other than `initial`, the one the first admission named, ends it too
 *     (review PR1051-R1): a reconnect never adopts a binding that replaced its own.
 *   - **One wait at a time, one connection at a time** (PR1051-R2). Every socket is a `Link` that
 *     owns its waiters and its in-flight requests, and only the current link's lines reach anything.
 *     An attempt the relay gives up on is destroyed, so a late answer on it satisfies nothing; a
 *     link lost while it is being restored is retried by the wait already running, never by a
 *     second one. One absolute deadline, `maxWaitMs` from the loss, governs every admission,
 *     restore and pause of the wait.
 *   - **It restores only what a daemon confirmed** (PR1051-R3). Replay state is taken from the
 *     daemon's answers rather than from the client's requests: taken from the requests, one the
 *     client was told was not sent ran on return, and a refused registration replaced the accepted
 *     endpoint. A daemon serves a new connection
 *     from scratch, so the relay replays the client's own `initialize` — kept once a daemon
 *     answered it with a result — and `notifications/initialized` — kept once written on a live
 *     connection — and swallows their answers, then repeats the last
 *     `role_wake_endpoint_register` call a daemon answered `ok:true`. A request the client was
 *     told was not sent, and a registration the daemon refused, change none of it.
 *   - **It holds nothing without bound** (PR1051-R4). The client's stdin pauses while stdout or the
 *     daemon's socket is not accepting writes, or while `MAX_PENDING_REQUESTS` requests are
 *     unanswered; the daemon's socket pauses while stdout is not accepting writes; and the exit
 *     waits for stdout to flush for at most `flushTimeoutMs`.
 *   - **A connection that closes without a refusal is not a refusal** (PR1051-R5). A claim's
 *     connection that closes before the daemon's first line is a daemon that went away, and the
 *     relay reattaches as it would after any other loss; only a refusal line ends the attach.
 *   - **Its wake proxy is what the daemon wakes** (`openWakeProxy`), when the session's messaging
 *     socket and token were in the environment. The client's `role_wake_endpoint_register` whose
 *     `endpoint` is exactly that socket — the session registering itself — leaves with the proxy's
 *     path instead, and that is the registration replayed. A registration of any other path is
 *     forwarded as it arrived rather than refused: the daemon decides which endpoints it accepts,
 *     and the proxy's forward target is the environment's socket whatever is registered. Once per admission —
 *     after the client's `notifications/initialized`, and in each restore — the relay registers
 *     the proxy itself unless the client registered another endpoint, so a wake reaches a session
 *     whose model never called the tool. The daemon wakes on every registration it accepts, so
 *     that registration is also the first wake through the proxy.
 *   - **Once its proxy listens, the client's requests leave under ids of the relay's** (review
 *     PR1057-R2). The relay's own requests — the restore's replays and the proxy's registration,
 *     which goes out on a live link alongside the client's traffic — share the connection with the
 *     client's, and an id the client may also use is one whose answer the relay would take, handing
 *     the relay's answer to the client as the client's. So each client request is sent under the
 *     next number the relay counts, and its answer goes back under the client's own id; the relay's
 *     own requests carry strings, which no number equals. A client's `notifications/cancelled` is
 *     sent naming the number its request went under, and not sent at all when it names no request
 *     in flight, since the id it names may be one of the relay's. An answer to no request in flight
 *     — the late answer to a request of the relay's it stopped waiting for — is dropped, never
 *     passed to the client.
 *   - **Until then nothing is renamed** (review PR1057-R3). With no proxy listening — no messaging
 *     in the environment, a socket the proxy may not forward to, or the proxy not yet open — the
 *     relay sends no request of its own on a live link, so there is nothing to keep apart: every
 *     line in either direction passes exactly as it arrived, a cancel included, and a restore
 *     replays the client's `initialize` as the client sent it, all as before the proxy existed. A
 *     request that left under the client's own id before the proxy opened is answered and cancelled
 *     under that id, and the numbers and strings the relay counts afterwards skip every id such a
 *     request still has in flight. Keyed on the proxy listening rather than on the messaging
 *     variables being present: a complete environment whose socket the proxy may not forward to
 *     opens no proxy, and renaming there would change the client's bytes with no proxy to protect.
 *
 * Seeing those messages, and renaming request ids once the proxy listens, is the only reason this
 * relay reads JSON-RPC at all. Once it listens, a client request leaves with its id renamed, but for
 * that one registration with nothing else changed, and an answer returns with the client's id
 * restored; every other line is forwarded exactly as it arrived.
 */
const relayWithReattach = (
  first: Socket,
  connection: { handshake(socket: Socket): void },
  firstAdmitted: boolean,
  initial: AdmittedTuple,
  reattachSocketPath: string,
  policyOverrides: Partial<ReattachPolicy> | undefined,
  messaging: SessionMessaging | undefined,
  io: AttachRelayIo,
): Promise<number> =>
  new Promise<number>((resolveRelay) => {
    const policy: ReattachPolicy = { ...DEFAULT_REATTACH_POLICY, ...policyOverrides };
    let phase: "connecting" | "live" | "reattaching" | "done" = "connecting";
    /** The one link the relay serves or is restoring. Every other socket it opened is destroyed. */
    let current: Link | null = null;
    /** The wait in progress: aborting it ends its admission, its restore and its pause at once. */
    let waiting: { abort: AbortController; deadline: NodeJS.Timeout } | null = null;
    let stdinEnded = false;
    let stdoutFailed = false;
    let stdoutBlocked = false;
    let daemonBlocked = false;
    /**
     * The client's `initialize` a daemon answered with a result: replayed under an id of the relay's
     * own while a proxy listens, and as the client sent it while none does.
     */
    let clientInitialize: ClientRequest | null = null;
    let clientInitialized: string | null = null;
    let wakeArguments: unknown = undefined;
    /** Counts the relay's own requests, whose ids are strings. */
    let internalIds = 0;
    /** Counts the client's requests, which leave under these numbers rather than their own ids once a proxy listens. */
    let upstreamIds = 0;
    /** Listening, or null: no messaging in the environment, a directory it may not use, or not yet open. */
    let proxy: WakeProxy | null = null;
    /** Ends the relay's own requests on a live link when the relay ends. */
    const live = new AbortController();

    let resolved = false;
    const resolveOnce = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolveRelay(code);
    };

    /** Pauses whichever side is producing faster than the other consumes. */
    const flow = (): void => {
      if (phase === "done") return;
      const link = current;
      if (phase === "live") {
        if (stdoutBlocked) link?.socket.pause();
        else link?.socket.resume();
      }
      // Nothing of the client's moves before the handshake is on the wire.
      if (phase === "connecting") return;
      if (stdoutBlocked) {
        io.stdin.pause();
        return;
      }
      if (daemonBlocked) {
        io.stdin.pause();
        return;
      }
      if ((link?.inFlight.size ?? 0) >= MAX_PENDING_REQUESTS) {
        io.stdin.pause();
        return;
      }
      io.stdin.resume();
    };

    const toClient = (line: string): void => {
      if (stdoutFailed) return;
      if (io.stdout.write(`${line}\n`)) return;
      if (stdoutBlocked) return;
      stdoutBlocked = true;
      io.stdout.once("drain", () => {
        stdoutBlocked = false;
        flow();
      });
      flow();
    };
    const undelivered = (id: unknown, message: string): void => {
      toClient(JSON.stringify({ jsonrpc: "2.0", id, error: { code: RELAY_REATTACHING_ERROR, message } }));
    };

    const end = (code: number): void => {
      if (phase === "done") return;
      phase = "done";
      if (waiting !== null) {
        clearTimeout(waiting.deadline);
        waiting.abort.abort();
        waiting = null;
      }
      live.abort();
      // The proxy goes with the relay, so the daemon is never left an endpoint nobody forwards from.
      proxy?.close();
      proxy = null;
      current?.socket.destroy();
      current = null;
      first.destroy();
      io.stdin.removeListener("data", onClientData);
      io.stdin.pause();
      // Resolved once stdout has flushed, for the reason `pipeStdioToSocket` gives, but no later
      // than `flushTimeoutMs`: a client that stopped reading would otherwise hold the exit forever.
      if (stdoutFailed) return resolveOnce(code);
      if (io.stdout.writableFinished) return resolveOnce(code);
      const unflushed = setTimeout(() => resolveOnce(code), policy.flushTimeoutMs);
      io.stdout.once("finish", () => {
        clearTimeout(unflushed);
        resolveOnce(code);
      });
      if (!io.stdout.writableEnded) io.stdout.end();
    };
    const protocolFailure = (stage: string): void => {
      io.stderr.write(`attach: ${stage} malformed\n`);
      end(ATTACH_EXIT.PROTOCOL);
    };

    /** Notes a request written on `link` that a restarted daemon would be restored with, if it succeeds. */
    const noteReplayable = (link: Link, key: string, message: RelayedMessage, line: string): void => {
      if (message.method === "initialize") {
        link.initializes.set(key, { message, line });
        return;
      }
      if (message.method !== "tools/call") return;
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      if (params?.name === WAKE_REGISTER_TOOL) link.wakeRegistrations.set(key, params.arguments);
    };

    /** Keeps a replayable request now that the daemon answered it, and only if it succeeded. */
    const settleReplayable = (link: Link, key: string, message: RelayedMessage): void => {
      const initialize = link.initializes.get(key);
      if (initialize !== undefined) {
        link.initializes.delete(key);
        if (succeeded(message)) clientInitialize = initialize;
      }
      if (!link.wakeRegistrations.has(key)) return;
      const registered = link.wakeRegistrations.get(key);
      link.wakeRegistrations.delete(key);
      if (wakeRegistered(message)) wakeArguments = registered;
    };

    const send = (link: Link, line: string): void => {
      if (link.socket.write(`${line}\n`)) return;
      if (daemonBlocked) return;
      daemonBlocked = true;
      link.socket.once("drain", () => {
        if (current !== link) return;
        daemonBlocked = false;
        flow();
      });
    };

    /**
     * The relay's next number for a client request on `link`, past any id a request sent under the
     * client's own id before the proxy opened still has in flight there (review PR1057-R3).
     */
    const nextUpstreamId = (link: Link): number => {
      do {
        upstreamIds += 1;
      } while (link.inFlight.has(idKey(upstreamIds)));
      return upstreamIds;
    };

    /** An id for one of the relay's own requests on `link`, past any id in flight there, as `nextUpstreamId`. */
    const nextInternalId = (link: Link, prefix: string): string => {
      let id: string;
      do {
        internalIds += 1;
        id = `${prefix}-${internalIds}`;
      } while (link.inFlight.has(idKey(id)));
      return id;
    };

    /**
     * The client's registration of the session's own messaging socket, pointed at the proxy; null
     * for every other message, which leaves unchanged but for its id. Only an `endpoint` exactly equal to the
     * environment's socket is rewritten, so the client cannot steer the proxy, and the proxy's
     * forward target is never a path any message names.
     */
    const pointAtProxy = (message: RelayedMessage): RelayedMessage | null => {
      const opened = proxy;
      if (opened === null) return null;
      if (messaging === undefined) return null;
      if (message.method !== "tools/call") return null;
      const params = message.params as { name?: unknown; arguments?: unknown } | null | undefined;
      if (params?.name !== WAKE_REGISTER_TOOL) return null;
      const registration = params.arguments as { endpoint?: unknown } | null | undefined;
      if (registration?.endpoint !== messaging.socketPath) return null;
      return { ...message, params: { ...params, arguments: { ...registration, endpoint: opened.path } } };
    };

    /**
     * The client's cancel of one of its requests, naming the number that request was sent under, or
     * as it arrived when that request left under the client's own id; null when no request of the
     * client's with the id it names is in flight on `link`. Passed on as it arrived, a cancel names an
     * id in the daemon's space, where it may be one of the relay's own.
     */
    const cancelUpstream = (link: Link, message: RelayedMessage, line: string): string | null => {
      const params = message.params as { requestId?: unknown } | null | undefined;
      if (typeof params !== "object" || params === null) return null;
      const named = idKey(params.requestId);
      let found: InFlightRequest | undefined;
      for (const request of link.inFlight.values()) {
        if (idKey(request.client) === named) found = request;
      }
      if (found === undefined) return null;
      if (found.upstream === null) return line;
      return JSON.stringify({ ...message, params: { ...params, requestId: found.upstream } });
    };

    const fromClient = lineSplitter((line) => {
      const message = parseRelayed(line);
      const id = message === null ? undefined : requestIdOf(message);
      const link = current;
      if (phase !== "live" || link === null) {
        // Answered at once and remembered nowhere: a request reported as not sent is never sent later.
        if (id !== undefined) undelivered(id, "agent-control-plane is reattaching; this request was not sent");
        return;
      }
      if (proxy === null) {
        // No proxy, so no request of the relay's own on this link: the line leaves exactly as it
        // arrived, under the client's own id, as before the proxy existed (review PR1057-R3).
        if (id !== undefined) {
          const key = idKey(id);
          link.inFlight.set(key, { client: id, upstream: null });
          noteReplayable(link, key, message as RelayedMessage, line);
        } else if (message?.method === "notifications/initialized") {
          clientInitialized = line;
        }
        send(link, line);
        return;
      }
      if (id !== undefined) {
        // Sent under the relay's next number, never under the client's own id (review PR1057-R2).
        const upstream = nextUpstreamId(link);
        const key = idKey(upstream);
        link.inFlight.set(key, { client: id, upstream });
        const outbound = pointAtProxy(message as RelayedMessage) ?? (message as RelayedMessage);
        noteReplayable(link, key, outbound, line);
        send(link, JSON.stringify({ ...outbound, id: upstream }));
        return;
      }
      if (message?.method === "notifications/cancelled") {
        const cancel = cancelUpstream(link, message, line);
        if (cancel !== null) send(link, cancel);
        return;
      }
      if (message?.method === "notifications/initialized") {
        clientInitialized = line;
        send(link, line);
        // The client is initialized: the earliest point the daemon accepts a wake registration.
        offerProxy();
        return;
      }
      send(link, line);
    }, () => protocolFailure("client line"));
    // Paused between chunks rather than inside one: a chunk is bounded by stdin's own high-water
    // mark, so what one chunk can add to stdout is bounded as well.
    const onClientData = (chunk: Buffer): void => {
      fromClient(chunk);
      flow();
    };

    const fromDaemon = (link: Link, line: string): void => {
      // An abandoned socket speaks to nobody: not to the client, and not to another link's waiters.
      if (current !== link) return;
      if (!link.accepted) {
        // A claim's handshake is answered by a refusal line or by nothing at all.
        const reply = classifyFirstLine(line);
        if (reply.kind === "malformed") return protocolFailure("handshake reply");
        if (reply.kind === "refusal") {
          io.stderr.write(`attach: handshake refused ${reply.reasonCode}\n`);
          return end(ATTACH_EXIT.HANDSHAKE_REFUSED);
        }
        link.accepted = true;
      }
      const message = parseRelayed(line);
      const id = message === null ? undefined : responseIdOf(message);
      if (id !== undefined) {
        const key = idKey(id);
        const waiter = link.waiters.get(key);
        if (waiter !== undefined) return waiter(message);
        const request = link.inFlight.get(key);
        if (request !== undefined) {
          link.inFlight.delete(key);
          settleReplayable(link, key, message as RelayedMessage);
          // Sent under the client's own id, it is answered under it, and the line passes as it arrived.
          if (request.upstream !== null) return toClient(JSON.stringify({ ...message, id: request.client }));
        } else if (proxy !== null && id !== null) {
          // An answer to no request in flight, such as the late answer to one of the relay's own it
          // stopped waiting for. The client would take it for the answer to whichever of its requests
          // carries that id. An error answering no id at all is the daemon's to report, and passes.
          // With no proxy the relay has no request of its own on a live link, and it passes as before.
          io.stderr.write("attach: dropped an answer to no request in flight\n");
          return;
        }
      }
      toClient(line);
    };

    const lost = (link: Link): void => {
      link.closed = true;
      for (const waiter of [...link.waiters.values()]) waiter(null);
      if (current !== link) return;
      current = null;
      daemonBlocked = false;
      if (phase === "done") return;
      const unanswered = [...link.inFlight.values()];
      link.inFlight.clear();
      for (const { client } of unanswered) {
        undelivered(client, "the agent-control-plane connection closed before this request was answered; its outcome is unknown");
      }
      // A link lost while it was being restored is noticed by that restore, through its waiters,
      // and the wait already running carries on; no second wait starts.
      if (phase === "reattaching") return flow();
      if (stdinEnded) return end(ATTACH_EXIT.OK);
      // A claim's connection that closed before its first line, with no refusal, went away like any
      // other; only a refusal line ends the attach.
      void reattach();
    };

    const open = (socket: Socket, accepted: boolean): Link => {
      const link: Link = {
        socket,
        accepted,
        closed: false,
        inFlight: new Map(),
        waiters: new Map(),
        initializes: new Map(),
        wakeRegistrations: new Map(),
        proxyOffered: false,
      };
      current = link;
      daemonBlocked = false;
      const split = lineSplitter((line) => fromDaemon(link, line), () => {
        if (current === link) protocolFailure("daemon line");
      });
      socket.on("data", (chunk: Buffer) => {
        split(chunk);
        flow();
      });
      socket.on("error", () => undefined);
      socket.once("close", () => lost(link));
      socket.resume();
      return link;
    };

    const abandon = (link: Link): void => {
      if (current === link) current = null;
      link.socket.destroy();
    };

    /** One relay-originated request on `link`; null when it closes, nothing answers in time, or the wait ends. */
    const ask = (link: Link, id: unknown, line: string, deadlineAt: number, signal: AbortSignal): Promise<RelayedMessage | null> =>
      new Promise((resolveAsk) => {
        if (link.closed) return resolveAsk(null);
        if (signal.aborted) return resolveAsk(null);
        const key = idKey(id);
        let answered = false;
        const answer = (message: RelayedMessage | null): void => {
          if (answered) return;
          answered = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", giveUp);
          link.waiters.delete(key);
          resolveAsk(message);
        };
        const giveUp = (): void => answer(null);
        const timer = setTimeout(giveUp, Math.max(0, Math.min(policy.attemptTimeoutMs, deadlineAt - Date.now())));
        signal.addEventListener("abort", giveUp, { once: true });
        link.waiters.set(key, answer);
        link.socket.write(`${line}\n`);
      });

    const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
      new Promise((resolveSleep) => {
        const wake = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", wake);
          resolveSleep();
        };
        const timer = setTimeout(wake, ms);
        signal.addEventListener("abort", wake, { once: true });
      });

    /**
     * A registration of the session's own messaging socket that a daemon accepted before the proxy
     * was listening. The proxy supersedes it: it is the same session, reached the way that is not
     * held. Any other registration is the client's choice and is left alone.
     */
    const supersededByProxy = (registration: unknown): boolean => {
      if (proxy === null) return false;
      if (messaging === undefined) return false;
      return (registration as { endpoint?: unknown } | null | undefined)?.endpoint === messaging.socketPath;
    };

    /**
     * Registers the wake proxy on `link`, once per link, when nothing else is registered: a proxy
     * is listening, the client has initialized — the daemon refuses a registration from a
     * connection that declared no build — and the accepted registration, if any, is the session's
     * own socket. False only when `link` closed or the wait ended before an answer; a refusal is
     * reported and is not a loss.
     *
     * Kept for replay, like the client's own, only once a daemon answered it `ok:true`, and only if
     * no other registration of the client's was accepted meanwhile.
     */
    const registerProxy = async (link: Link, deadlineAt: number, signal: AbortSignal): Promise<boolean> => {
      const opened = proxy;
      if (opened === null) return true;
      if (link.proxyOffered) return true;
      if (wakeArguments !== undefined && !supersededByProxy(wakeArguments)) return true;
      if (clientInitialize === null) return true;
      if (clientInitialized === null) return true;
      link.proxyOffered = true;
      const id = nextInternalId(link, "acp-relay-wake-proxy");
      const registration = { endpoint: opened.path };
      const answer = await ask(link, id, JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: WAKE_REGISTER_TOOL, arguments: registration },
      }), deadlineAt, signal);
      if (answer === null) return false;
      if (!wakeRegistered(answer)) {
        io.stderr.write(`attach: wake proxy registration refused ${wakeRefusalReason(answer)}\n`);
        return true;
      }
      if (wakeArguments === undefined || supersededByProxy(wakeArguments)) wakeArguments = registration;
      return true;
    };

    /** `registerProxy` on the live link, bounded by one attempt; a link lost meanwhile is restore's. */
    const offerProxy = (): void => {
      const link = current;
      if (phase !== "live") return;
      if (link === null) return;
      void registerProxy(link, Date.now() + policy.attemptTimeoutMs, live.signal);
    };

    /** Restores a fresh link to where the lost one was; false when it closes or the wait ends meanwhile. */
    const restore = async (link: Link, deadlineAt: number, signal: AbortSignal): Promise<boolean> => {
      const initialize = clientInitialize;
      if (initialize !== null) {
        // With no proxy, as the client sent it and under its id, as before the proxy (review PR1057-R3).
        const id = proxy === null ? initialize.message.id : nextInternalId(link, "acp-relay-reinitialize");
        const line = proxy === null ? initialize.line : JSON.stringify({ ...initialize.message, id });
        if ((await ask(link, id, line, deadlineAt, signal)) === null) return false;
        if (clientInitialized !== null) link.socket.write(`${clientInitialized}\n`);
      }
      if (wakeArguments !== undefined && !supersededByProxy(wakeArguments)) {
        const id = nextInternalId(link, "acp-relay-rewake");
        const answer = await ask(link, id, JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: WAKE_REGISTER_TOOL, arguments: wakeArguments },
        }), deadlineAt, signal);
        if (answer === null) return false;
        if (!wakeRegistered(answer)) {
          io.stderr.write(`attach: wake re-registration refused ${wakeRefusalReason(answer)}\n`);
        }
      } else if (!(await registerProxy(link, deadlineAt, signal))) {
        return false;
      }
      return current === link;
    };

    /** The one wait for a daemon that went away. */
    const reattach = async (): Promise<void> => {
      if (waiting !== null) return;
      phase = "reattaching";
      const abort = new AbortController();
      const deadlineAt = Date.now() + policy.maxWaitMs;
      const expire = (): void => {
        if (phase !== "reattaching") return;
        io.stderr.write("attach: daemon did not return\n");
        end(ATTACH_EXIT.UNAVAILABLE);
      };
      const wait = { abort, deadline: setTimeout(expire, policy.maxWaitMs) };
      waiting = wait;
      flow();
      const left = (): number => deadlineAt - Date.now();
      let delay = policy.initialDelayMs;
      for (;;) {
        if (phase !== "reattaching") return;
        if (left() <= 0) return expire();
        const outcome = await attemptReattach(reattachSocketPath, Math.min(policy.attemptTimeoutMs, left()), abort.signal);
        if (phase !== "reattaching") {
          if (outcome.kind === "admitted") outcome.socket.destroy();
          return;
        }
        if (outcome.kind === "refused") {
          io.stderr.write(`attach: reattach refused ${outcome.reasonCode}\n`);
          return end(ATTACH_EXIT.HANDSHAKE_REFUSED);
        }
        if (outcome.kind === "malformed") return protocolFailure("reattach reply");
        if (outcome.kind === "unbound") {
          io.stderr.write(`attach: reattach refused ${CTO_REATTACH_UNBOUND}\n`);
          return end(ATTACH_EXIT.HANDSHAKE_REFUSED);
        }
        if (outcome.kind === "admitted") {
          // An acknowledgement that names nothing cannot be compared, so it is refused rather than
          // admitted unchecked.
          if (outcome.tuple === null) {
            outcome.socket.destroy();
            return protocolFailure("reattach reply");
          }
          if (!sameTuple(outcome.tuple, initial)) {
            outcome.socket.destroy();
            // The relay found the mismatch itself, so it writes its own stage message rather than a
            // daemon reason code it was not sent.
            io.stderr.write("attach: reattach admitted another binding\n");
            return end(ATTACH_EXIT.HANDSHAKE_REFUSED);
          }
          const link = open(outcome.socket, true);
          if (await restore(link, deadlineAt, abort.signal)) {
            clearTimeout(wait.deadline);
            waiting = null;
            phase = "live";
            flow();
            return;
          }
          if (phase !== "reattaching") return;
          abandon(link);
        }
        if (left() <= 0) return expire();
        await sleep(Math.min(delay, left()), abort.signal);
        delay = Math.min(delay * 2, policy.maxDelayMs);
      }
    };

    io.stdin.once("end", () => {
      stdinEnded = true;
      const link = current;
      // Live, the daemon's side is let finish what it owes the client; its close then ends the relay.
      if (phase === "live" && link !== null) {
        link.socket.end();
        return;
      }
      end(ATTACH_EXIT.OK);
    });
    io.stdin.once("error", () => end(ATTACH_EXIT.STREAM_CLOSED));
    io.stdout.once("error", () => {
      stdoutFailed = true;
      if (phase === "done") resolveOnce(ATTACH_EXIT.STREAM_CLOSED);
      else end(ATTACH_EXIT.STREAM_CLOSED);
    });

    const begin = (): void => {
      if (phase !== "connecting") return;
      connection.handshake(first);
      open(first, firstAdmitted);
      phase = "live";
      io.stdin.on("data", onClientData);
      flow();
      // Opened once the admission is in, and kept across every reattach, since its path is what
      // the daemon is given; it closes only with the relay.
      if (messaging === undefined) return;
      void openWakeProxy(messaging, io.stderr).then((opened) => {
        if (opened === null) return;
        if (phase === "done") return opened.close();
        proxy = opened;
        offerProxy();
      });
    };
    if (first.pending) {
      first.once("connect", begin);
      first.once("error", () => {
        if (phase !== "connecting") return;
        io.stderr.write("attach: mcp socket unavailable\n");
        end(ATTACH_EXIT.UNAVAILABLE);
      });
    } else {
      begin();
    }
  });
