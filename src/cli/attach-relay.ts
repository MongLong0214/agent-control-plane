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
 *     value `registerEndpoint` pins (`src/mcp/role-conversation.ts`, `C0_QUALIFIED_CLIENT`) is
 *     the real process's, not one this relay could compose.
 *   - **No retry, no reconnect, no backoff.** The credential is the session's own secret, whose
 *     hash is durable, so the daemon cannot tell a pre-restart plaintext from a post-restart one.
 *     "A credential taken before the ACP restart may not be reused" is enforced *here*: the
 *     process holds it only in memory, writes it exactly once, and exits when either side closes.
 *     A reconnect path would be that reuse, which is why its absence is load-bearing rather than
 *     an omission.
 *
 * The secret never reaches argv, the environment, stdout, stderr or any file: `stdout` carries
 * only bytes that came off the socket after the handshake, and the `stderr` vocabulary is closed
 * to `attach: <stage> <reasonCode>` with the code copied from the daemon's own public envelope.
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
  ownerApprovalNonce: string;
}

export interface AttachRelayOptions {
  claimSocketPath: string;
  mcpSocketPath: string;
  /** Resolved by the caller. Written to the handshake line and nowhere else. */
  mcpToken: string;
  claim: AttachRelayClaim;
  claimTimeoutMs?: number;
}

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
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
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
}

/**
 * The `agentctl attach canonical-cto` entry.
 *
 * It exists so the CLI can start a relay without naming the deployment token — the caller passes
 * socket paths and claim selectors, and the credential is acquired here and goes straight into
 * `runAttachRelay`, which still takes it explicitly so a test can drive the relay with a synthetic
 * one.
 */
export const runAttachRelayCommand = (
  options: AttachRelayCommandOptions,
  io: AttachRelayIo,
): Promise<number> => {
  const mcpToken = resolveMcpToken();
  if (mcpToken === null) {
    io.stderr.write("attach: mcp token unavailable\n");
    return Promise.resolve(ATTACH_EXIT.UNAVAILABLE);
  }
  return runAttachRelay({ ...options, mcpToken }, io);
};

export const runAttachRelay = async (
  options: AttachRelayOptions,
  io: AttachRelayIo,
): Promise<number> => {
  // Nothing of Claude Code's moves until the handshake newline is on the wire.
  io.stdin.pause();

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

  return new Promise<number>((resolveRelay) => {
    const socket: Socket = createConnection(options.mcpSocketPath);
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
    socket.once("connect", () => {
      connected = true;
      // One write, one string, one reference. The order is the whole correctness argument: this
      // newline is what makes the client's first message the *second* line on this socket.
      socket.write(
        `${JSON.stringify({
          token: options.mcpToken,
          sessionId: claimed.sessionId,
          sessionSecret: claimed.sessionSecret,
        })}\n`,
      );
      socket.on("data", peek);
      io.stdin.pipe(socket);
    });
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
};
