import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { type Decision, allow, deny } from "../core/errors.ts";
import { getPeerCredentials, type PeerCredentials } from "../core/peercred.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { readOneJsonLineRequest } from "./local-socket-framing.ts";

/**
 * #760 round 6 — the CEO's ruling on the mint/claim separation: "a process may prove who it is,
 * but it cannot approve itself." Separate the *sockets*, not the credentials. This is the socket.
 *
 * `actor.claimCanonicalCto` used to be special-cased on the shared, bearer-token-authenticated
 * operator socket (`startOperatorSocket` in `agentcpd.ts`), authorizing itself past that token
 * with its own, additional kernel-credential check layered on top. That is exactly the shape the
 * ruling refuses: the claiming connection is not an owner/admin, and sitting on the owner/admin
 * socket at all — even behind an extra check — means a caller who somehow held that bearer token
 * could still self-authorize, which is precisely correction A's original defect wearing the
 * generic operator credential instead of a self-minted receipt.
 *
 * This listener never reads, never checks, and has no field for `ACP_OPERATOR_TOKEN` or any other
 * bearer secret. It authenticates the connecting process **exclusively** through the kernel's own
 * record of who opened the socket (`getPeerCredentials`), rejects a proxied identity
 * (`peerPid !== effectivePid`) and a mismatched effective uid before a single byte of the request
 * is read, and dispatches exactly one method — `actor.claimCanonicalCto` — denying every other
 * name, including its own bearer-authenticated sibling `owner.approveClaimCanonicalCto`, which
 * stays exactly where it was: on the operator socket, because that credential *is* the
 * pre-existing owner/admin boundary this method's mint half legitimately belongs to.
 *
 * `getPeerCredentials`/`PeerCredentials` are reachable from exactly this one file — see
 * `scripts/verify-peercred-is-unreachable.mjs`'s `ALLOWED_FILES`. The claim orchestration this
 * listener calls into (`src/daemon/canonical-self-claim-operator.ts`) no longer touches peer
 * credentials at all: it receives an already-authenticated `{ peerPid, uid }` tuple as a plain
 * parameter, the same way any other caller-independent fact reaches it.
 */

export const CANONICAL_SELF_CLAIM_METHOD = "actor.claimCanonicalCto";

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
 * read — "before any other effect". Everything past this point (the exact executable, version,
 * conversation transcript and working directory) is `CanonicalSelfClaim.claim()`'s job,
 * unchanged; this only answers "is this a trustworthy direct local peer at all".
 */
const authenticateClaimPeer = (socket: Socket): Decision<AuthenticatedClaimPeer> => {
  const credentials = derivePeerCredentialsFromSocket(socket);
  if (credentials === null) {
    return deny(
      ReasonCode.OPERATOR_UNAUTHENTICATED,
      "the connecting peer's kernel credentials could not be established",
      {},
    );
  }
  const direct = assertDirectPeer(credentials);
  if (!direct.allowed) return direct as Decision<AuthenticatedClaimPeer>;
  if (credentials.uid !== process.geteuid?.()) {
    return deny(
      ReasonCode.OPERATOR_UNAUTHENTICATED,
      "the connecting peer's effective uid does not match this daemon's own",
      { observedUid: credentials.uid },
    );
  }
  return allow(ReasonCode.OK, { peerPid: credentials.peerPid, uid: credentials.uid });
};

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

const serveCanonicalSelfClaimConnection = (
  socket: Socket,
  daemon: { lock: { held(): boolean } },
  handler: CanonicalSelfClaimHandler,
  requestTimeoutMs: number,
): void => {
  // Correction B, "before any other effect": authenticated at connection time, before the request
  // parser, the method check, or the lock check below ever run. A caller that is not a direct
  // local peer this daemon's own uid owns is refused here and never costs this connection a
  // request-timeout timer, since there is no request left to time out.
  const authenticated = authenticateClaimPeer(socket);
  if (!authenticated.allowed) {
    socket.end(`${JSON.stringify(authenticated)}\n`);
    return;
  }

  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  const finish = (decision: Decision<unknown>): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    frame.dispose();
    if (!socket.destroyed) socket.end(`${JSON.stringify(decision)}\n`);
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
      // Requirement 4 of the ruling — this listener rejects every generic operator/owner method,
      // including its own bearer-authenticated sibling `owner.approveClaimCanonicalCto`: exactly
      // one method name is recognized here, and nothing else, no matter what else the request
      // otherwise looks like.
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
 * Starts the dedicated, token-less canonical self-claim listener. One method, one socket, no
 * relation to `ACP_OPERATOR_TOKEN` — `agentctl claim canonical-cto` must reach the daemon through
 * this socket and this socket alone, and must neither read nor require that credential (round 6,
 * required part 2).
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
  const socketPath = join(stateDir, "agentcpd.claim-canonical-cto.sock");
  removeStaleSocket(socketPath);
  const server = createServer((socket) =>
    serveCanonicalSelfClaimConnection(socket, daemon, handler, requestTimeoutMs),
  );
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        chmodSync(socketPath, 0o600);
        resolveListen();
      });
    });
  } catch (err) {
    if (existsSync(socketPath)) unlinkSync(socketPath);
    throw err;
  }

  return {
    socketPath,
    close: async () => {
      await closeSocketServer(server);
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        /* closing the server already releases its socket; this is only cleanup */
      }
    },
  };
};
