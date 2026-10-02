import { execFileSync } from "node:child_process";
import { createConnection, type Socket } from "node:net";
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
 * relay itself still never opens a second connection.
 *
 * The secret never reaches argv, the environment, stdout, stderr or any file: `stdout` carries
 * only bytes that came off the socket after the handshake, and the `stderr` vocabulary is closed
 * to `attach: <stage> <reasonCode>` with the code copied from the daemon's own public envelope.
 *
 * The adopted CEO's relay (`runAdoptedCeoAttachRelay`, #1037) is the same byte pipe with no claim
 * and no handshake in front of it, because its socket authenticates the connection itself.
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
  /** False when the caller already asked the reattach socket for this attach. Defaults to true. */
  initialReattach?: boolean;
  /** Bounds on waiting for a restarted daemon; see `ReattachPolicy`. */
  reattach?: Partial<ReattachPolicy>;
  claimTimeoutMs?: number;
}

/**
 * How long a relay that lost its daemon waits for it, and how often it asks.
 *
 * It waits only while nobody answers on the reattach socket — a daemon that is down or still
 * starting. Any answer ends the wait: admitted, it carries on; refused, it exits. `maxWaitMs`
 * bounds the whole wait, and each attempt is bounded by `attemptTimeoutMs`.
 */
export interface ReattachPolicy {
  maxWaitMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  attemptTimeoutMs: number;
}

export const DEFAULT_REATTACH_POLICY: ReattachPolicy = {
  maxWaitMs: 5 * 60_000,
  initialDelayMs: 250,
  maxDelayMs: 5_000,
  attemptTimeoutMs: 35_000,
};

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

type ClaimOutcome =
  | { kind: "receipt"; sessionId: string; sessionSecret: string }
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
      const value = response.value as { sessionId?: unknown; sessionSecret?: unknown } | undefined;
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
      finish({ kind: "receipt", sessionId: value.sessionId, sessionSecret: value.sessionSecret });
    });
    socket.once("error", () => finish({ kind: "unavailable" }));
    socket.once("close", () => finish({ kind: "unavailable" }));
  });

type ReattachOutcome =
  | { kind: "admitted"; socket: Socket }
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
 * `{ok:true}` hands back the connected socket, paused, for the byte pipe. `CTO_REATTACH_UNBOUND`, a
 * socket that is not there (an older daemon) or one that never answers sends the caller to the
 * claim. Any other refusal is the daemon's answer about this process and ends the attach.
 */
const attemptReattach = (socketPath: string, timeoutMs: number): Promise<ReattachOutcome> =>
  new Promise<ReattachOutcome>((resolveReattach) => {
    const socket = createConnection(socketPath);
    let received = Buffer.alloc(0);
    let settled = false;
    const timer: NodeJS.Timeout = setTimeout(() => finish({ kind: "unavailable" }), timeoutMs);
    timer.unref();
    const finish = (outcome: ReattachOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", answer);
      if (outcome.kind === "admitted") socket.pause();
      else socket.destroy();
      resolveReattach(outcome);
    };
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
      const reply = (parsed ?? {}) as { ok?: unknown; reasonCode?: unknown };
      if (reply.ok === true) {
        // The daemon writes nothing after its acknowledgement until the client speaks; anything
        // already here belongs to the pipe, not to this reader.
        const rest = received.subarray(boundary + 1);
        if (rest.length > 0) socket.unshift(rest);
        return finish({ kind: "admitted", socket });
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
  const reattached = await reattachFirst(options.reattachSocketPath, DEFAULT_CLAIM_TIMEOUT_MS, options.reattach, io);
  if (typeof reattached === "number") return reattached;
  const mcpToken = resolveMcpToken();
  if (mcpToken === null) {
    io.stderr.write("attach: mcp token unavailable\n");
    return ATTACH_EXIT.UNAVAILABLE;
  }
  // A door that did not answer is not one to come back through; one that answered "unbound" is.
  return runAttachRelay({
    ...options,
    reattachSocketPath: reattached === "unbound" ? options.reattachSocketPath : undefined,
    initialReattach: false,
    mcpToken,
  }, io);
};

/**
 * Asks the reattach socket when there is one. Resolves to the relay's exit code when the reattach
 * decided the attach — admitted and relayed, or refused — and otherwise to why the caller should
 * claim: `unbound` (the door answered that this process holds no binding) or `unavailable` (there
 * is no door, or it did not answer). Only a door that answered is one the relay may later come back
 * through: a deployment without one keeps the byte pipe that exits with its connection.
 */
const reattachFirst = async (
  reattachSocketPath: string | undefined,
  timeoutMs: number,
  policy: Partial<ReattachPolicy> | undefined,
  io: AttachRelayIo,
): Promise<number | "unbound" | "unavailable"> => {
  if (reattachSocketPath === undefined) return "unavailable";
  const reattached = await attemptReattach(reattachSocketPath, timeoutMs);
  if (reattached.kind === "admitted") {
    return relayWithReattach(reattached.socket, NO_HANDSHAKE, true, reattachSocketPath, policy, io);
  }
  if (reattached.kind === "refused") {
    io.stderr.write(`attach: reattach refused ${reattached.reasonCode}\n`);
    return ATTACH_EXIT.HANDSHAKE_REFUSED;
  }
  if (reattached.kind === "malformed") {
    io.stderr.write("attach: reattach reply malformed\n");
    return ATTACH_EXIT.PROTOCOL;
  }
  return reattached.kind;
};

export const runAttachRelay = async (
  options: AttachRelayOptions,
  io: AttachRelayIo,
): Promise<number> => {
  // Nothing of Claude Code's moves until the handshake newline is on the wire.
  io.stdin.pause();

  // The caller may have asked the door already; then `reattachSocketPath` is set only if it answered.
  const reattached = options.initialReattach === false
    ? (options.reattachSocketPath === undefined ? "unavailable" : "unbound")
    : await reattachFirst(
      options.reattachSocketPath,
      options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS,
      options.reattach,
      io,
    );
  // Unbound, or no reattach socket to ask: the claim decides, as it always has.
  if (typeof reattached === "number") return reattached;
  const door = reattached === "unbound" ? options.reattachSocketPath : undefined;

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
  // With a reattach socket to come back through, losing this connection is not the end of the
  // attach; the secret above is presented on this one connection and never again.
  return door === undefined
    ? pipeStdioToSocket(first, io, connection)
    : relayWithReattach(first, connection, false, door, options.reattach, io);
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
 *   - **It comes back only by reattach.** The secret a claim returned was presented on the first
 *     connection and is never presented again; the reattach admits on the process tree, so a
 *     reconnect proves what a first connection does and reuses nothing. It never claims: a refusal
 *     — this process holds no binding, the binding was revoked, the ancestry does not match — ends
 *     the relay rather than falling back to a claim, and a new generation stays an operator's or a
 *     fresh spawn's decision.
 *   - **It waits only for a daemon that is not answering**, with doubling delays and a bound on
 *     the whole wait (`ReattachPolicy`), and then exits.
 *   - **It restores what the connection held.** A daemon serves a new connection from scratch, so
 *     the relay replays the client's own `initialize` and `notifications/initialized` — the
 *     client's exact lines, so `clientInfo` is still the client's — and swallows their answers, then
 *     repeats the last `role_wake_endpoint_register` call the client made, so the wake path comes
 *     back with the tools.
 *
 * Seeing those three messages is the only reason this relay reads JSON-RPC at all; every line is
 * still forwarded exactly as it arrived.
 */
const relayWithReattach = (
  first: Socket,
  connection: { handshake(socket: Socket): void },
  firstAdmitted: boolean,
  reattachSocketPath: string,
  policyOverrides: Partial<ReattachPolicy> | undefined,
  io: AttachRelayIo,
): Promise<number> =>
  new Promise<number>((resolveRelay) => {
    const policy: ReattachPolicy = { ...DEFAULT_REATTACH_POLICY, ...policyOverrides };
    let daemon: Socket | null = null;
    let live = false;
    let done = false;
    // Whether the daemon has accepted this relay: known at once for a reattach, and after the
    // first line that is not a refusal for a claim's handshake.
    let accepted = firstAdmitted;
    let stdinEnded = false;
    let stdoutFailed = false;
    let clientInitialize: { id: unknown; line: string } | null = null;
    let clientInitialized: string | null = null;
    let wakeArguments: unknown = undefined;
    let internalIds = 0;
    const inFlight = new Map<string, unknown>();
    const internal = new Map<string, (message: RelayedMessage | null) => void>();

    const toClient = (line: string): void => {
      if (stdoutFailed) return;
      io.stdout.write(`${line}\n`);
    };
    const undelivered = (id: unknown, message: string): void => {
      toClient(JSON.stringify({ jsonrpc: "2.0", id, error: { code: RELAY_REATTACHING_ERROR, message } }));
    };

    let resolved = false;
    const resolveOnce = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolveRelay(code);
    };
    const end = (code: number): void => {
      if (done) return;
      done = true;
      live = false;
      daemon?.destroy();
      io.stdin.removeListener("data", fromClient);
      io.stdin.pause();
      // Resolved only once stdout has flushed, for the reason `pipeStdioToSocket` gives.
      if (stdoutFailed) return resolveOnce(code);
      if (io.stdout.writableFinished) return resolveOnce(code);
      io.stdout.once("finish", () => resolveOnce(code));
      if (!io.stdout.writableEnded) io.stdout.end();
    };
    const protocolFailure = (stage: string): void => {
      io.stderr.write(`attach: ${stage} malformed\n`);
      end(ATTACH_EXIT.PROTOCOL);
    };

    /** What a restarted daemon will need replayed, read off the client's own messages. */
    const remember = (message: RelayedMessage, line: string): void => {
      if (message.method === "initialize") {
        if (message.id !== undefined) clientInitialize = { id: message.id, line };
        return;
      }
      if (message.method === "notifications/initialized") {
        clientInitialized = line;
        return;
      }
      if (message.method !== "tools/call") return;
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      if (params?.name === "role_wake_endpoint_register") wakeArguments = params.arguments;
    };

    const fromClient = lineSplitter((line) => {
      const message = parseRelayed(line);
      if (message !== null) remember(message, line);
      const id = message === null ? undefined : requestIdOf(message);
      if (live) {
        if (id !== undefined) inFlight.set(idKey(id), id);
        daemon?.write(`${line}\n`);
        return;
      }
      if (id !== undefined) undelivered(id, "agent-control-plane is reattaching; this request was not sent");
    }, () => protocolFailure("client line"));

    const lost = (socket: Socket): void => {
      if (daemon !== socket) return;
      daemon = null;
      live = false;
      if (done) return;
      if (stdinEnded) return end(ATTACH_EXIT.OK);
      if (!accepted) return end(ATTACH_EXIT.STREAM_CLOSED);
      for (const id of inFlight.values()) {
        undelivered(id, "the agent-control-plane connection closed before this request was answered; its outcome is unknown");
      }
      inFlight.clear();
      for (const waiter of internal.values()) waiter(null);
      internal.clear();
      void reattachLoop();
    };

    const attachDaemon = (socket: Socket): void => {
      daemon = socket;
      socket.on(
        "data",
        lineSplitter((line) => {
          if (!accepted) {
            // A claim's handshake is answered by a refusal line or by nothing at all.
            const reply = classifyFirstLine(line);
            if (reply.kind === "malformed") return protocolFailure("handshake reply");
            if (reply.kind === "refusal") {
              io.stderr.write(`attach: handshake refused ${reply.reasonCode}\n`);
              return end(ATTACH_EXIT.HANDSHAKE_REFUSED);
            }
            accepted = true;
          }
          const message = parseRelayed(line);
          const id = message === null ? undefined : responseIdOf(message);
          if (id !== undefined) {
            const waiter = internal.get(idKey(id));
            if (waiter !== undefined) {
              internal.delete(idKey(id));
              return waiter(message);
            }
            inFlight.delete(idKey(id));
          }
          toClient(line);
        }, () => protocolFailure("daemon line")),
      );
      socket.once("error", () => undefined);
      socket.once("close", () => lost(socket));
      socket.resume();
    };

    /** One relay-originated request on `socket`; null when the socket closes or nothing answers. */
    const ask = (socket: Socket, id: unknown, line: string): Promise<RelayedMessage | null> =>
      new Promise((resolveAsk) => {
        const timer = setTimeout(() => {
          internal.delete(idKey(id));
          resolveAsk(null);
        }, policy.attemptTimeoutMs);
        internal.set(idKey(id), (message) => {
          clearTimeout(timer);
          resolveAsk(message);
        });
        socket.write(`${line}\n`);
      });

    /** Restores a fresh connection to where the lost one was; false when it closes meanwhile. */
    const restore = async (socket: Socket): Promise<boolean> => {
      attachDaemon(socket);
      const initialize = clientInitialize;
      if (initialize !== null) {
        if ((await ask(socket, initialize.id, initialize.line)) === null) return false;
        if (clientInitialized !== null) socket.write(`${clientInitialized}\n`);
      }
      if (wakeArguments !== undefined) {
        internalIds += 1;
        const id = `acp-relay-rewake-${internalIds}`;
        const answer = await ask(socket, id, JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "role_wake_endpoint_register", arguments: wakeArguments },
        }));
        if (answer === null) return false;
        const body = (answer.result as { structuredContent?: { ok?: unknown; reasonCode?: unknown } } | undefined)
          ?.structuredContent;
        if (body?.ok !== true) {
          io.stderr.write(`attach: wake re-registration refused ${String(body?.reasonCode ?? "UNKNOWN")}\n`);
        }
      }
      return daemon === socket;
    };

    const pause = (ms: number): Promise<void> => new Promise((resolvePause) => setTimeout(resolvePause, ms));

    const reattachLoop = async (): Promise<void> => {
      const started = Date.now();
      let delay = policy.initialDelayMs;
      for (;;) {
        if (done) return;
        const outcome = await attemptReattach(reattachSocketPath, policy.attemptTimeoutMs);
        if (done) {
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
          if (await restore(outcome.socket)) {
            live = true;
            return;
          }
          if (done) return;
        }
        if (Date.now() - started + delay > policy.maxWaitMs) {
          io.stderr.write("attach: daemon did not return\n");
          return end(ATTACH_EXIT.UNAVAILABLE);
        }
        await pause(delay);
        delay = Math.min(delay * 2, policy.maxDelayMs);
      }
    };

    io.stdin.once("end", () => {
      stdinEnded = true;
      if (live) daemon?.end();
      else if (!accepted) daemon?.end();
      else end(ATTACH_EXIT.OK);
    });
    io.stdin.once("error", () => end(ATTACH_EXIT.STREAM_CLOSED));
    io.stdout.once("error", () => {
      stdoutFailed = true;
      if (done) resolveOnce(ATTACH_EXIT.STREAM_CLOSED);
      else end(ATTACH_EXIT.STREAM_CLOSED);
    });

    const begin = (): void => {
      connection.handshake(first);
      attachDaemon(first);
      live = true;
      io.stdin.on("data", fromClient);
      io.stdin.resume();
    };
    if (first.pending) {
      first.once("connect", begin);
      first.once("error", () => {
        if (daemon !== null) return;
        io.stderr.write("attach: mcp socket unavailable\n");
        end(ATTACH_EXIT.UNAVAILABLE);
      });
    } else {
      begin();
    }
  });
