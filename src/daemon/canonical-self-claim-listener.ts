import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { type Decision, allow, deny } from "../core/errors.ts";
import { getPeerCredentials, type PeerCredentials } from "../core/peercred.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { readOneJsonLineRequest } from "./local-socket-framing.ts";

/**
 * The mint/claim separation for `actor.claimCanonicalCto` (#760): a process may prove who it is,
 * but it cannot approve itself, so the *sockets* are separate, not merely the credentials. This
 * is the claim socket.
 *
 * `actor.claimCanonicalCto` does not sit on the shared, bearer-token-authenticated operator socket
 * (`startOperatorSocket` in `agentcpd.ts`), even behind an additional kernel-credential check
 * layered on top of that token: the claiming connection is not an owner/admin, and a caller who
 * somehow held the bearer token could otherwise self-authorize — the same defect wearing the
 * generic operator credential instead of a self-minted receipt.
 *
 * This listener never reads, never checks, and has no field for `ACP_OPERATOR_TOKEN` or any other
 * bearer secret. It authenticates the connecting process **exclusively** through the kernel's own
 * record of who opened the socket (`getPeerCredentials`), rejects a proxied identity
 * (`peerPid !== effectivePid`) and a mismatched effective uid before a single byte of the request
 * is read, and dispatches exactly one method — `actor.claimCanonicalCto` — denying every other
 * name, including every bearer-authenticated owner and operator method, which stay on the
 * operator socket because that credential is the pre-existing owner/admin boundary.
 *
 * The adopted CEO's tool socket (#1037) is the second door this file opens, with the same
 * kernel-peer check in front of it. It answers no method: once the peer is admitted, the socket
 * carries MCP for the adopted CEO, so the admission is the whole of its authentication and there is
 * no credential to issue, keep or replay.
 *
 * `getPeerCredentials`/`PeerCredentials` are reachable from exactly this one file — see
 * `scripts/verify-peercred-is-unreachable.mjs`'s `ALLOWED_FILES`. The claim orchestration this
 * listener calls into (`src/daemon/canonical-self-claim-operator.ts`) does not touch peer
 * credentials at all: it receives an already-authenticated `{ peerPid, uid }` tuple as a plain
 * parameter, the same way any other caller-independent fact reaches it.
 */

export const CANONICAL_SELF_CLAIM_METHOD = "actor.claimCanonicalCto";

/** The one filename this listener ever binds; exported so a caller can size a `stateDir` against it. */
export const CANONICAL_SELF_CLAIM_SOCKET_FILENAME = "agentcpd.claim-canonical-cto.sock";

/** The adopted CEO's tool socket (#1037), sized against `stateDir` the same way. */
export const ADOPTED_CEO_TOOL_SOCKET_FILENAME = "agentcpd.adopted-ceo-tools.sock";

/** The canonical CTO's reattach socket (#1037): MCP for a live claimant whose binding is ACTIVE. */
export const CANONICAL_CTO_TOOL_SOCKET_FILENAME = "agentcpd.canonical-cto-tools.sock";

/**
 * `sizeof(struct sockaddr_un.sun_path)` on Darwin is 104 bytes, and that array holds the path plus
 * its NUL terminator — the terminator is not optional and is not this code's to omit, so 103 is
 * the last usable byte for the path string itself (#760). A state directory long enough to push
 * the joined socket path past this limit makes `bind(2)` silently truncate at `sun_path`, so the
 * path this process asks for is never the path the kernel creates — `listen()`'s callback would
 * then do real, irreversible work (`chmodSync`) against a file that does not exist, and the
 * promise would never settle. Checked here, before `removeStaleSocket` and before `createServer`
 * ever run, so an overlong path is refused as a name it cannot use rather than accepted and left
 * to fail deeper in the call.
 */
export const MAX_SUN_PATH_BYTES = 103;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 1024 * 1024;

export interface CanonicalSelfClaimListener {
  socketPath: string;
  close(): Promise<void>;
}

export interface CanonicalSelfClaimListenerOptions {
  /** Execution budget for the one method this socket answers. */
  requestTimeoutMs?: number;
}

/** The one authenticated fact this listener hands its handler: who the kernel says is connected. */
export interface AuthenticatedClaimPeer {
  peerPid: number;
  uid: number;
}

export type CanonicalSelfClaimHandler = (
  peer: AuthenticatedClaimPeer,
  params: Record<string, unknown>,
) => Promise<Decision<unknown>>;

/**
 * Node exposes no public API for a socket's raw fd. `_handle.fd` is the field this repository's
 * own `tests/unit/g5-peercred.test.ts` already reads for exactly this reason.
 */
const rawFd = (socket: Socket): number | null => {
  const handle = (socket as unknown as { _handle: { fd: number } | null } | null)?._handle;
  return handle && typeof handle.fd === "number" ? handle.fd : null;
};

const derivePeerCredentialsFromSocket = (socket: Socket): PeerCredentials | null => {
  const fd = rawFd(socket);
  return fd === null ? null : getPeerCredentials(fd);
};

/**
 * This deployment expects a direct local connection from the exact claude process, not one
 * relayed through an entitlement-checked proxy: `peerPid` is who opened the socket, `effectivePid`
 * is who a proxy says is acting on their behalf, and the two differ exactly when a proxy sits in
 * between. Exported as its own pure function — no socket, no I/O — so the mismatch case is a
 * focused unit test rather than something only provable by constructing a real proxy.
 */
export const assertDirectPeer = (credentials: PeerCredentials): Decision<PeerCredentials> => {
  if (credentials.peerPid !== credentials.effectivePid) {
    return deny(
      ReasonCode.OPERATOR_UNAUTHENTICATED,
      "the connecting peer is not a direct connection; a proxied identity is not accepted",
      { peerPid: credentials.peerPid, effectivePid: credentials.effectivePid },
    );
  }
  return allow(ReasonCode.OK, credentials);
};

/**
 * The one identity check this listener performs itself, before a byte of the request is even
 * read — "before any other effect". Everything past this point is `CanonicalSelfClaim.claim()`'s
 * job, unchanged: the claude ancestor the walk finds by `argv[0]`'s basename, the session UUID in
 * its argv and the project that UUID's entry entitles, a working directory it can read, the
 * conversation transcript, and the pid/start-time recheck. It checks no executable or version —
 * the executing image is recorded there, never compared. This only answers "is this a
 * trustworthy direct local peer at all".
 */
const authenticateClaimPeer = (socket: Socket): Decision<AuthenticatedClaimPeer> =>
  authenticateClaimCredentials(derivePeerCredentialsFromSocket(socket), process.geteuid?.());

/**
 * The same three refusals, over values rather than over a socket — the shape `assertDirectPeer`
 * was already split out into, extended to its two neighbours.
 *
 * Both of those were untested until #843, and neither was reachable by a test: one needs kernel
 * credential derivation to fail, the other needs a peer at a different uid, and a unit test can
 * construct neither through a real `Socket`. `assertDirectPeer`'s own comment names that as the
 * reason it is a pure function; the argument applies unchanged to the refusals above and below it.
 *
 * `euid` is passed rather than read here so a test can state which uid the daemon is, instead of
 * asserting against whatever uid happens to be running the suite — an assertion that would pass
 * for the wrong reason on any machine where they coincide, which is every machine that runs it.
 */
export const authenticateClaimCredentials = (
  credentials: PeerCredentials | null,
  euid: number | undefined,
): Decision<AuthenticatedClaimPeer> => {
  if (credentials === null) {
    return deny(
      ReasonCode.OPERATOR_UNAUTHENTICATED,
      "the connecting peer's kernel credentials could not be established",
      {},
    );
  }
  const direct = assertDirectPeer(credentials);
  if (!direct.allowed) return direct as Decision<AuthenticatedClaimPeer>;
  if (credentials.uid !== euid) {
    return deny(
      ReasonCode.OPERATOR_UNAUTHENTICATED,
      "the connecting peer's effective uid does not match this daemon's own",
      { observedUid: credentials.uid },
    );
  }
  return allow(ReasonCode.OK, { peerPid: credentials.peerPid, uid: credentials.uid });
};

/**
 * The wire shape a caller may ever see. For a denial, only the stable `reasonCode` classifying
 * why — never the internal `message` prose or `evidence` object, either of which can carry a
 * session UUID, an absolute path, a peer identity, a transcript fact, or a raw
 * exception message: exactly what `authenticateClaimPeer`, the request parser, the method/lock
 * checks, the handler's own denial, the request-timeout, and the handler-exception catch would
 * otherwise put on this socket unfiltered. For an allow, the caller's own receipt `value` passes
 * through — that is the legitimate output of a successful claim, the thing the caller asked for —
 * but `evidence` is dropped there too, since nothing on the wire side ever reads it. This is the
 * one point every response on this socket passes through; the rich, internal `Decision` objects
 * built everywhere else in this file may still carry a message and evidence for local diagnostics,
 * since none of them reach `socket.end` directly.
 */
const publicClaimResponse = (decision: Decision<unknown>): { allowed: boolean; reasonCode: ReasonCode; value?: unknown } =>
  decision.allowed
    ? { allowed: true, reasonCode: decision.reasonCode, value: decision.value }
    : { allowed: false, reasonCode: decision.reasonCode };

const removeStaleSocket = (path: string): void => {
  if (!existsSync(path)) return;
  if (!lstatSync(path).isSocket()) {
    throw new Error(`refusing to replace non-socket canonical self-claim path: ${path}`);
  }
  unlinkSync(path);
};

const closeSocketServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, reject) => {
    server.close((err) => (err ? reject(err) : resolveClose()));
  });

/**
 * Cleanup for a handle this call already opened, after a fault this call caused — never the
 * caller's own failure to report, so it never rejects on its own account, and it never waits
 * indefinitely for a `close` that a fault-time handle has no particular reason to still deliver
 * promptly. `boundMs` is a ceiling on this cleanup attempt alone; the fault that triggered it is
 * reported by the caller once this settles, not by this function.
 */
const boundedClose = (server: Server, boundMs = 5_000): Promise<void> =>
  new Promise<void>((resolveClose) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolveClose();
    };
    const timer = setTimeout(finish, boundMs);
    timer.unref?.();
    try {
      server.close(() => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });

const serveCanonicalSelfClaimConnection = (
  socket: Socket,
  daemon: { lock: { held(): boolean } },
  handler: CanonicalSelfClaimHandler,
  requestTimeoutMs: number,
): void => {
  // Authenticated before any other effect: at connection time, before the request parser, the
  // method check, or the lock check below ever run. A caller that is not a direct local peer
  // this daemon's own uid owns is refused here and never costs this connection a request-timeout
  // timer, since there is no request left to time out.
  const authenticated = authenticateClaimPeer(socket);
  if (!authenticated.allowed) {
    // A peer already wrote its request before this denial is decided (`agentctl` writes on
    // `connect`, before any response can possibly have arrived). `.end()` alone only half-closes
    // this socket's own writes; those already-sent bytes sit unread on its receive buffer, and a
    // socket whose read side is never resumed — the one shape every other response path already
    // avoids, since `readOneJsonLineRequest` below actively consumes the request it parses —
    // leaves the connection object alive from this server's own accounting. `Server.close()` (the
    // daemon's own graceful-shutdown path) then waits on it forever. `.resume()` drains and
    // discards whatever the peer already sent or still sends; nothing here was ever going to read
    // it for its content.
    socket.resume();
    socket.end(`${JSON.stringify(publicClaimResponse(authenticated))}\n`);
    return;
  }

  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  const finish = (decision: Decision<unknown>): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    frame.dispose();
    if (!socket.destroyed) socket.end(`${JSON.stringify(publicClaimResponse(decision))}\n`);
  };
  const frame = readOneJsonLineRequest(
    socket,
    {
      tooLarge: "canonical self-claim request exceeds local transport limit",
      multipleRequests: "canonical self-claim socket accepts one request per connection",
      notJson: "canonical self-claim request is not JSON",
    },
    (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return finish(deny(ReasonCode.INVALID_ARGUMENT, "canonical self-claim request must be a JSON object", {}));
      }
      const method = (value as { method?: unknown }).method;
      // This listener recognizes exactly one method name and nothing else, no matter what else
      // the request otherwise looks like: every generic operator and owner method is refused
      // here and served only on the bearer-authenticated socket.
      if (method !== CANONICAL_SELF_CLAIM_METHOD) {
        return finish(
          deny(ReasonCode.OPERATOR_METHOD_NOT_ALLOWED, "this socket serves only actor.claimCanonicalCto", {
            method: typeof method === "string" ? method : null,
          }),
        );
      }
      if (!daemon.lock.held()) {
        return finish(deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock is not held for canonical self-claim", {}));
      }
      const rawParams = (value as { params?: unknown }).params ?? {};
      if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
        return finish(deny(ReasonCode.INVALID_ARGUMENT, "canonical self-claim parameters are invalid", {}));
      }
      void handler(authenticated.value, rawParams as Record<string, unknown>).then(finish).catch((error: unknown) => {
        finish(deny(ReasonCode.INTERNAL_ERROR, "canonical self-claim request failed", {
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    },
    (decision) => finish(decision),
    MAX_LINE_BYTES,
  );
  socket.once("error", () => {
    settled = true;
    if (timeout) clearTimeout(timeout);
    frame.dispose();
  });
  socket.once("close", () => {
    settled = true;
    if (timeout) clearTimeout(timeout);
    frame.dispose();
  });
  timeout = setTimeout(() => {
    finish(deny(ReasonCode.OPERATOR_REQUEST_TIMEOUT, "canonical self-claim request did not arrive within its budget", {}));
  }, requestTimeoutMs);
  timeout.unref();
};

/**
 * Starts the dedicated, token-less canonical self-claim listener (#760). One method, one socket,
 * no relation to `ACP_OPERATOR_TOKEN` — `agentctl claim canonical-cto` must reach the daemon
 * through this socket and this socket alone, and must neither read nor require that credential.
 */
export const startCanonicalSelfClaimListener = async (
  daemon: { lock: { held(): boolean } },
  stateDir: string,
  handler: CanonicalSelfClaimHandler,
  options: CanonicalSelfClaimListenerOptions = {},
): Promise<CanonicalSelfClaimListener> => {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("canonical self-claim request timeout must be a positive integer");
  }
  return listenPeerCredentialSocket(stateDir, CANONICAL_SELF_CLAIM_SOCKET_FILENAME, (socket) =>
    serveCanonicalSelfClaimConnection(socket, daemon, handler, requestTimeoutMs),
  );
};

/**
 * What the adopted CEO tool socket hands its caller: the kernel's peer, to decide on, and — only
 * once that decision admitted it — the connection itself, to serve.
 */
export type AdoptedCeoToolAdmit<T> = (peer: AuthenticatedClaimPeer) => Promise<Decision<T>>;
export type AdoptedCeoToolServe<T> = (admitted: T, socket: Socket) => void;

/** Only the reason code reaches the wire, in the `{ok:false}` shape the attach relay reads. */
const publicToolRefusal = (decision: Decision<unknown>): string =>
  `${JSON.stringify({ ok: false, reasonCode: decision.reasonCode })}\n`;

/**
 * The closed set of kernel-peer MCP doors. `acknowledge` is the one difference: the canonical CTO's
 * relay must know it was admitted before it hands over a byte of the client's, because a refusal
 * there sends it to the claim instead, with the client's `initialize` still unsent. The adopted
 * CEO's relay has nowhere else to go, so its first line is either a refusal or traffic.
 */
interface PeerAdmittedDoor {
  socketFilename: typeof ADOPTED_CEO_TOOL_SOCKET_FILENAME | typeof CANONICAL_CTO_TOOL_SOCKET_FILENAME;
  acknowledge: boolean;
}

const ADMITTED_LINE = `${JSON.stringify({ ok: true, reasonCode: ReasonCode.OK })}\n`;

/**
 * One connection on the adopted CEO tool socket: the kernel peer first, before a byte is read; then
 * the caller's admission, bounded by `admissionTimeoutMs`; then the socket, unread, to `serve`.
 *
 * Nothing is read from the peer before it is admitted, so the client's first MCP message waits in
 * the socket's own buffer and reaches whatever `serve` attaches. A refusal ends the connection with
 * one `{ok:false,reasonCode}` line and nothing else — no message, no evidence — for the reason
 * `publicClaimResponse` gives on the claim socket.
 */
const servePeerAdmittedConnection = <T>(
  socket: Socket,
  daemon: { lock: { held(): boolean } },
  admit: AdoptedCeoToolAdmit<T>,
  serve: AdoptedCeoToolServe<T>,
  admissionTimeoutMs: number,
  door: PeerAdmittedDoor,
): void => {
  let settled = false;
  const refuse = (decision: Decision<unknown>): void => {
    if (socket.destroyed) return;
    socket.resume();
    socket.end(publicToolRefusal(decision));
  };
  const authenticated = authenticateClaimPeer(socket);
  if (!authenticated.allowed) return refuse(authenticated);
  if (!daemon.lock.held()) {
    return refuse(deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock is not held for the adopted CEO tool socket", {}));
  }
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    refuse(deny(ReasonCode.OPERATOR_REQUEST_TIMEOUT, "adopted CEO admission did not finish within its budget", {}));
  }, admissionTimeoutMs);
  timer.unref();
  const abandon = (): void => {
    settled = true;
    clearTimeout(timer);
  };
  socket.once("error", abandon);
  socket.once("close", abandon);
  void admit(authenticated.value)
    .catch(() => deny<T>(ReasonCode.INTERNAL_ERROR, "adopted CEO admission failed", {}))
    .then((admitted) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!admitted.allowed) return refuse(admitted);
      if (socket.destroyed) return;
      if (door.acknowledge) socket.write(ADMITTED_LINE);
      serve(admitted.value, socket);
    });
};

/**
 * Starts the adopted CEO's tool socket (#1037). Token-less like the claim socket: its only
 * authority is the kernel's record of who connected and what `admit` decides about that peer.
 */
export const startAdoptedCeoToolListener = <T>(
  daemon: { lock: { held(): boolean } },
  stateDir: string,
  admit: AdoptedCeoToolAdmit<T>,
  serve: AdoptedCeoToolServe<T>,
  options: { admissionTimeoutMs?: number } = {},
): Promise<CanonicalSelfClaimListener> =>
  startPeerAdmittedListener(daemon, stateDir, admit, serve, options, {
    socketFilename: ADOPTED_CEO_TOOL_SOCKET_FILENAME,
    acknowledge: false,
  });

/**
 * Starts the canonical CTO's reattach socket (#1037): the same door, answering an admitted peer
 * with one `{ok:true}` line before MCP begins, so the relay knows not to claim.
 */
export const startCanonicalCtoToolListener = <T>(
  daemon: { lock: { held(): boolean } },
  stateDir: string,
  admit: AdoptedCeoToolAdmit<T>,
  serve: AdoptedCeoToolServe<T>,
  options: { admissionTimeoutMs?: number } = {},
): Promise<CanonicalSelfClaimListener> =>
  startPeerAdmittedListener(daemon, stateDir, admit, serve, options, {
    socketFilename: CANONICAL_CTO_TOOL_SOCKET_FILENAME,
    acknowledge: true,
  });

const startPeerAdmittedListener = async <T>(
  daemon: { lock: { held(): boolean } },
  stateDir: string,
  admit: AdoptedCeoToolAdmit<T>,
  serve: AdoptedCeoToolServe<T>,
  options: { admissionTimeoutMs?: number },
  door: PeerAdmittedDoor,
): Promise<CanonicalSelfClaimListener> => {
  const admissionTimeoutMs = options.admissionTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(admissionTimeoutMs)) {
    throw new Error("peer admission timeout must be a positive integer");
  }
  if (admissionTimeoutMs <= 0) throw new Error("peer admission timeout must be a positive integer");
  return listenPeerCredentialSocket(stateDir, door.socketFilename, (socket) =>
    servePeerAdmittedConnection(socket, daemon, admit, serve, admissionTimeoutMs, door),
  );
};

/** Binds one owner-only socket file in `stateDir` and hands every connection to `onConnection`. */
const listenPeerCredentialSocket = async (
  stateDir: string,
  socketFilename: string,
  onConnection: (socket: Socket) => void,
): Promise<CanonicalSelfClaimListener> => {
  const socketPath = join(stateDir, socketFilename);
  // Byte length, never `.length` (UTF-16 code units): a path can carry characters whose UTF-8
  // encoding is wider than one code unit, and `sun_path` is a byte buffer the kernel copies into,
  // not a character count. Checked before `removeStaleSocket` and before `createServer` — nothing
  // here has touched the filesystem or opened a handle yet, so a rejection at this line leaves
  // nothing to clean up.
  const socketPathBytes = Buffer.byteLength(socketPath, "utf8");
  if (socketPathBytes > MAX_SUN_PATH_BYTES) {
    throw new Error(
      `canonical self-claim socket path exceeds the platform AF_UNIX sun_path limit ` +
        `(${socketPathBytes} bytes, max ${MAX_SUN_PATH_BYTES}): ${socketPath}`,
    );
  }
  removeStaleSocket(socketPath);
  // Every accepted connection, so `close` can end them (review PR1046-R3). `server.close()` only
  // stops accepting and then waits for each open connection to end on its own, and a tool
  // connection ends when the Gateway or claude behind it does — so a daemon shutting down with a
  // live relay attached would wait forever before it reached its lock release.
  const connections = new Set<Socket>();
  let closing = false;
  const server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    onConnection(socket);
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        try {
          chmodSync(socketPath, 0o600);
        } catch (err) {
          // A throw inside this callback is not inside the promise executor's own call stack —
          // nothing here would otherwise catch it, and the promise above would never settle.
          // Bounded-close the handle this call already opened, then reject — so a callback fault
          // becomes a refusal, never a wait with no answer.
          void boundedClose(server).then(() => {
            reject(err instanceof Error ? err : new Error(String(err)));
          });
          return;
        }
        resolveListen();
      });
    });
  } catch (err) {
    if (existsSync(socketPath)) unlinkSync(socketPath);
    throw err;
  }

  // One close, however many callers ask: a second `server.close()` rejects as not running.
  let closed: Promise<void> | null = null;
  const closeOnce = async (): Promise<void> => {
    // Admission stops with the connections: an admission still resolving finds its socket
    // destroyed and serves nothing (`servePeerAdmittedConnection` checks before it serves).
    closing = true;
    const stopped = closeSocketServer(server);
    for (const socket of connections) socket.destroy();
    await stopped;
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {
      /* closing the server already releases its socket; this is only cleanup */
    }
  };
  return {
    socketPath,
    close: () => {
      closed ??= closeOnce();
      return closed;
    },
  };
};
