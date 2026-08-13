#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { ControlPlane, defaultConfig } from "../app/control-plane.ts";
import {
  createHermesBootstrapAuthority,
  type HermesBootstrapAuthority,
} from "../bootstrap/hermes-bootstrap.ts";
import { BuzzAdapter, BuzzCliTransport } from "../buzz/buzz-adapter.ts";
import { type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  BuzzActorIngress,
  IngressGuard,
  type IngressPolicy,
} from "../ingress/ingress-guard.ts";
import { Role, SessionLifecycle, roleKeyFor, type RoleBinding } from "../domain/types.ts";
import type { SessionLaunchCredential } from "../cto/cto-lifecycle.ts";
import { createCtoMcpPort, createCtoServer } from "../mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../mcp/hermes-server.ts";
import type { AuthenticatedMcpPeer, McpPeerAuthenticator } from "../mcp/shared.ts";
import type { AuthenticatedOperatorPeer, Daemon } from "./daemon.ts";

const MAX_MCP_LINE_BYTES = 1024 * 1024;
const DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS = 5_000;
// A normal handoff package remains deliverable for thirty minutes. Do not make its recipient's
// one-time bootstrap proof expire sooner than the package it must acknowledge.
const SESSION_LAUNCH_TTL_MS = 30 * 60_000;

export interface LocalMcpListeners {
  socketPaths: readonly string[];
  close(): Promise<void>;
}

/** Main's live listener composition: CEO CONFIRM is handed to the lock-held daemon. */
export const startDaemonMcpListeners = (
  cp: ControlPlane,
  stateDir: string,
  token: string,
  daemon: { finalizeApprovedRun(runId: string): void | Promise<unknown> },
): Promise<LocalMcpListeners> =>
  startLocalMcpListeners(cp, stateDir, token, {
    onCeoApproved: (runId) => daemon.finalizeApprovedRun(runId),
  });

/** Tests shorten the deadline without weakening the daemon's production default. */
export interface LocalMcpListenerOptions {
  handshakeTimeoutMs?: number;
  /** Internal daemon notification after a successful ordinary CEO confirmation. */
  onCeoApproved?: (runId: string) => void | Promise<unknown>;
}

/** A one-time, owner-only credential handoff for a runtime that was just constituted. */
export interface LocalSessionLaunchChannel {
  socketPath: string;
  prepare(): Promise<Decision<void>>;
  provision(input: SessionLaunchCredential): Promise<Decision<void>>;
  close(): Promise<void>;
}

/** A daemon-owned local hop from the authenticated Buzz relay to SessionRegistry. */
export interface LocalBuzzActorIngress {
  socketPath: string;
  close(): Promise<void>;
}

/** The authenticated local RPC endpoint used by `agentctl`. */
export interface LocalOperatorListener {
  socketPath: string;
  close(): Promise<void>;
}

/**
 * A dedicated operator credential is bound to one configured local peer before a socket
 * accepts a request. The actor is deliberately not read from the request body. The token is
 * provisioned separately from ACP_MCP_TOKEN; the latter is a deployment gate for MCP and has
 * no peer identity of its own.
 */
export interface LocalOperatorCredential {
  token: string;
  peerId: string;
  actor: string;
}

export interface LocalOperatorSocketOptions {
  handshakeTimeoutMs?: number;
  /** Used only to reject accidental reuse of the non-identifying MCP deployment token. */
  mcpToken?: string;
  /** The sole additional operator method: a fresh-install Hermes authority bootstrap. */
  bootstrapHermes?: (params: Record<string, unknown>) => Promise<Decision<unknown>>;
}

interface LiveOperatorBinding extends LocalOperatorCredential {
  incarnation: string;
  active: boolean;
}

interface PendingLaunchCredential {
  credential: SessionLaunchCredential;
  expiresAtMs: number;
}

/**
 * The provider-issued external session id is a high-entropy, recipient-scoped rendezvous
 * key. The channel lives on an owner-only socket, retains no credential durably, and deletes
 * an entry before replying, so a runtime can obtain its MCP proof exactly once.
 */
export const startSessionLaunchChannel = async (stateDir: string): Promise<LocalSessionLaunchChannel> => {
  const socketPath = join(stateDir, "cto.launch.sock");
  const pending = new Map<string, PendingLaunchCredential>();
  let server: Server | null = null;
  let opening: Promise<Decision<void>> | null = null;
  let closing: Promise<void> | null = null;
  let closed = false;

  const pruneExpired = (): void => {
    const now = Date.now();
    for (const [externalSessionId, launch] of pending) {
      if (launch.expiresAtMs <= now) pending.delete(externalSessionId);
    }
  };
  const prepare = async (): Promise<Decision<void>> => {
    if (closed) {
      return deny(ReasonCode.CONFLICT, "session launch channel is closed", { socketPath });
    }
    if (server) return allow(ReasonCode.OK, undefined);
    if (opening) return opening;

    opening = (async (): Promise<Decision<void>> => {
      let candidate: Server | null = null;
      try {
        // `main` creates the channel object before `Daemon.start` so queued-run resume can
        // use it, but this binding is deliberately delayed until `CtoLifecycle.spawn` runs
        // under the daemon lock. A losing daemon can therefore never unlink the winner's
        // live launch socket while it is merely attempting startup.
        removeStaleSocket(socketPath);
        candidate = createServer((socket) => serveSessionLaunchCredential(socket, pending));
        await listenSocket(candidate, socketPath);
        if (closed) {
          await closeSocketServer(candidate);
          return deny(ReasonCode.CONFLICT, "session launch channel closed while opening", { socketPath });
        }
        server = candidate;
        return allow(ReasonCode.OK, undefined);
      } catch (error) {
        if (candidate) {
          try {
            await closeSocketServer(candidate);
          } catch {
            /* an unsuccessful listen owns no server that needs further cleanup */
          }
        }
        return deny(ReasonCode.CONFLICT, "could not open the session launch channel", {
          socketPath,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        opening = null;
      }
    })();
    return opening;
  };

  return {
    socketPath,
    prepare,
    provision: async (credential) => {
      const prepared = await prepare();
      if (!prepared.allowed) return prepared;
      pruneExpired();
      if (pending.has(credential.externalSessionId)) {
        return deny(
          ReasonCode.CONFLICT,
          "a launch credential is already pending for this external session",
          { sessionId: credential.sessionId },
        );
      }
      pending.set(credential.externalSessionId, {
        credential,
        expiresAtMs: Date.now() + SESSION_LAUNCH_TTL_MS,
      });
      return allow(ReasonCode.OK, undefined);
    },
    close: async () => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        pending.clear();
        if (opening) await opening;
        const active = server;
        server = null;
        if (active) await closeSocketServer(active);
      })();
      return closing;
    },
  };
};

/**
 * PRD §27.3 — each role gets its own owner-only Unix socket and must present the
 * deployment token before its MCP server sees a byte. Keeping the endpoints separate
 * prevents a CTO client from discovering Hermes operations through a shared transport.
 */
export const startLocalMcpListeners = async (
  cp: ControlPlane,
  stateDir: string,
  token: string,
  options: LocalMcpListenerOptions = {},
): Promise<LocalMcpListeners> => {
  if (token.length === 0) throw new Error("ACP_MCP_TOKEN must be configured to expose MCP");
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS;
  if (!Number.isInteger(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
    throw new Error("MCP handshake timeout must be a positive integer");
  }

  const hermesPath = join(stateDir, "hermes.mcp.sock");
  const ctoPath = join(stateDir, "cto.mcp.sock");
  // Server handlers receive these function-only ports, never the composition root. The
  // transport still needs `cp` to authenticate a socket, but a tool cannot turn that into
  // raw database access or evidence-write authority (#352).
  const hermesPort = createHermesMcpPort(cp, { onCeoApproved: options.onCeoApproved });
  const ctoPort = createCtoMcpPort(cp);
  const hermes = await startMcpSocket(
    hermesPath,
    token,
    cp,
    [Role.CEO],
    handshakeTimeoutMs,
    (auth) => createHermesServer(hermesPort, auth),
  );
  let cto: Server;
  try {
    cto = await startMcpSocket(
      ctoPath,
      token,
      cp,
      [Role.PRIMARY_CTO, Role.BOOTSTRAP_CTO],
      handshakeTimeoutMs,
      (auth, opening) => createCtoServer(
        ctoPort,
        auth,
        opening.kind === "PENDING_HANDOFF_ACK" ? { pendingHandoffId: opening.handoffId } : undefined,
      ),
      true,
    );
  } catch (err) {
    await closeSocketServer(hermes);
    if (existsSync(hermesPath)) unlinkSync(hermesPath);
    throw err;
  }
  const servers = [hermes, cto];

  return {
    socketPaths: [hermesPath, ctoPath],
    close: async () => {
      await Promise.all(servers.map(closeSocketServer));
      for (const path of [hermesPath, ctoPath]) {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          /* closing the server already releases its socket; this is only cleanup */
        }
      }
    },
  };
};

/**
 * Hosts the only production writer for `sessions.buzz_actor_id`. The relay submits a
 * signed Buzz envelope over this owner-only socket; the handler verifies that envelope
 * before it lets SessionRegistry verify the runtime's separate session secret.
 */
export const startBuzzActorIngressListener = async (
  cp: ControlPlane,
  stateDir: string,
  policy: IngressPolicy,
): Promise<LocalBuzzActorIngress> => {
  if (!policy.secret || policy.secret.trim().length === 0) {
    throw new Error("Buzz actor ingress requires a non-empty signing secret");
  }

  const guard = new IngressGuard(cp.db, cp.clock, cp.audit, { buzz: policy });
  const ingress = new BuzzActorIngress(guard, cp.sessions);
  const socketPath = join(stateDir, "buzz-actor.ingress.sock");
  removeStaleSocket(socketPath);
  const server = createServer((socket) => serveBuzzActorBinding(socket, ingress));

  try {
    await listenSocket(server, socketPath);
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

/**
 * The operator surface is deliberately a one-request protocol rather than a general RPC
 * framework. A dedicated credential is bound to a configured peer and a live listener
 * incarnation before the daemon applies the per-method lock/authority checks. The MCP token
 * is never accepted here: it is shared deployment authentication, not operator identity.
 */
export const startOperatorSocket = async (
  daemon: Pick<Daemon, "handleOperatorRequest" | "lock">,
  stateDir: string,
  credential: LocalOperatorCredential,
  options: LocalOperatorSocketOptions = {},
): Promise<LocalOperatorListener> => {
  const token = credential.token.trim();
  const mcpToken = options.mcpToken?.trim() || process.env["ACP_MCP_TOKEN"]?.trim();
  if (token.length === 0) {
    throw new Error(
      "ACP_OPERATOR_TOKEN is required for the operator socket; ACP_MCP_TOKEN identifies no peer and cannot be reused",
    );
  }
  if (mcpToken && token === mcpToken) {
    throw new Error(
      "ACP_OPERATOR_TOKEN must be a dedicated credential distinct from ACP_MCP_TOKEN; the MCP token identifies no peer",
    );
  }
  if (credential.peerId.trim().length === 0 || credential.actor.trim().length === 0) {
    throw new Error("operator socket requires a server-configured peer id and actor");
  }
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS;
  if (!Number.isInteger(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
    throw new Error("operator handshake timeout must be a positive integer");
  }

  const binding: LiveOperatorBinding = {
    token,
    peerId: credential.peerId.trim(),
    actor: credential.actor.trim(),
    incarnation: randomUUID(),
    active: true,
  };
  const socketPath = join(stateDir, "agentcpd.operator.sock");
  removeStaleSocket(socketPath);
  const server = createServer((socket) => serveOperatorRequest(socket, daemon, binding, handshakeTimeoutMs, options));
  try {
    await listenSocket(server, socketPath);
  } catch (err) {
    if (existsSync(socketPath)) unlinkSync(socketPath);
    throw err;
  }

  return {
    socketPath,
    close: async () => {
      binding.active = false;
      await closeSocketServer(server);
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        /* closing the server already releases its socket; this is only cleanup */
      }
    },
  };
};

const startMcpSocket = async (
  path: string,
  token: string,
  cp: ControlPlane,
  expectedRoles: readonly Role[],
  handshakeTimeoutMs: number,
  factory: (authenticate: McpPeerAuthenticator, opening: BoundSocketPeer) => ReturnType<typeof createHermesServer>,
  permitPendingHandoffAck = false,
): Promise<Server> => {
  removeStaleSocket(path);
  const server = createServer((socket) => {
    void authenticateSocket(socket, token, handshakeTimeoutMs).then(async (accepted) => {
      if (!accepted) return;
      // One server per authenticated connection: the peer identity belongs to the
      // transport, so it can never be re-declared by a tool argument (§21, §27.3).
      const opening = authenticateSocketPeer(cp, accepted.credential, expectedRoles, permitPendingHandoffAck);
      if (!opening.allowed) {
        endWithDecision(socket, opening);
        return;
      }
      const mcp = factory(peerAuthenticator(cp, accepted.credential, opening.value), opening.value);
      try {
        await mcp.connect(accepted.transport);
      } catch (err) {
        socket.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });

  return listenSocket(server, path);
};

const listenSocket = (server: Server, path: string): Promise<Server> =>
  new Promise<Server>((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      chmodSync(path, 0o600);
      resolveServer(server);
    });
  });

const removeStaleSocket = (path: string): void => {
  if (!existsSync(path)) return;
  if (!lstatSync(path).isSocket()) {
    throw new Error(`refusing to replace non-socket MCP path: ${path}`);
  }
  unlinkSync(path);
};

const closeSocketServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, reject) => {
    server.close((err) => (err ? reject(err) : resolveClose()));
  });

/** A compact wire result for local authenticated ingress; secret-bearing values stay local. */
const endWithDecision = <T>(socket: Socket, decision: Decision<T>): void => {
  const body = decision.allowed
    ? { ok: true, reasonCode: decision.reasonCode, evidence: decision.evidence }
    : {
        ok: false,
        reasonCode: decision.reasonCode,
        message: decision.message,
        evidence: decision.evidence,
      };
  socket.end(`${JSON.stringify(body)}\n`);
};

const serveOperatorRequest = (
  socket: Socket,
  daemon: Pick<Daemon, "handleOperatorRequest" | "lock">,
  binding: LiveOperatorBinding,
  handshakeTimeoutMs: number,
  options: LocalOperatorSocketOptions,
): void => {
  let buffer = Buffer.alloc(0);
  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  const finish = (decision: Decision<unknown>): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    socket.removeListener("data", receive);
    if (!socket.destroyed) socket.end(`${JSON.stringify(decision)}\n`);
  };
  const receive = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MCP_LINE_BYTES) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "operator request exceeds local transport limit"));
    }
    const boundary = buffer.indexOf(0x0a);
    if (boundary === -1) return;
    if (buffer.subarray(boundary + 1).length > 0) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "operator socket accepts one request per connection"));
    }

    let value: unknown;
    try {
      value = JSON.parse(buffer.subarray(0, boundary).toString("utf8")) as unknown;
    } catch {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "operator request is not JSON"));
    }
    const peer = authenticateOperatorPeer(value, binding);
    if (!peer.allowed) return finish(peer);
    const method = operatorRequestMethod(value);
    if (method === "bootstrap.hermes") {
      if (!options.bootstrapHermes) {
        return finish(deny(ReasonCode.OPERATOR_METHOD_NOT_ALLOWED, "Hermes bootstrap is not enabled on this socket", {}));
      }
      if (!daemon.lock.held()) {
        return finish(deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock is not held for Hermes bootstrap", {}));
      }
      const params = operatorRequestParams(value);
      if (!params) return finish(deny(ReasonCode.INVALID_ARGUMENT, "Hermes bootstrap parameters are invalid", {}));
      void options.bootstrapHermes(params).then(finish).catch((error: unknown) => {
        finish(deny(ReasonCode.INTERNAL_ERROR, "Hermes bootstrap request failed", {
          error: error instanceof Error ? error.message : String(error),
        }));
      });
      return;
    }
    void daemon.handleOperatorRequest(value, peer.value).then(finish).catch((error: unknown) => {
      finish(deny(ReasonCode.INTERNAL_ERROR, "operator request failed", {
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  };
  socket.on("data", receive);
  socket.once("error", () => {
    if (timeout) clearTimeout(timeout);
    settled = true;
    socket.removeListener("data", receive);
  });
  socket.once("close", () => {
    if (timeout) clearTimeout(timeout);
    settled = true;
    socket.removeListener("data", receive);
  });
  timeout = setTimeout(() => {
    finish(deny(ReasonCode.OPERATOR_UNAUTHENTICATED, "operator handshake timed out"));
  }, handshakeTimeoutMs);
  timeout.unref();
};

const operatorRequestMethod = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const method = (value as { method?: unknown }).method;
  return typeof method === "string" ? method : null;
};

const operatorRequestParams = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const params = (value as { params?: unknown }).params ?? {};
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const prototype = Object.getPrototypeOf(params);
  return prototype === Object.prototype || prototype === null
    ? params as Record<string, unknown>
    : null;
};

/**
 * Operator authentication is a credential-to-peer lookup, not a bearer check. The request
 * can present a token, but it cannot select the peer id, actor, or incarnation returned here.
 * The daemon lock is checked again for every request, so this binding is live only while the
 * lock-held daemon that created it remains authoritative.
 */
const authenticateOperatorPeer = (
  value: unknown,
  binding: LiveOperatorBinding,
): Decision<AuthenticatedOperatorPeer> => {
  if (!localMcpTokenMatches(value, binding.token)) {
    return deny(ReasonCode.OPERATOR_UNAUTHENTICATED, "operator socket authentication failed");
  }
  if (!binding.active) {
    return deny(ReasonCode.OPERATOR_UNAUTHENTICATED, "operator peer binding is no longer live");
  }
  return allow(ReasonCode.OK, {
    channel: "cli",
    peerId: binding.peerId,
    actor: binding.actor,
    incarnation: binding.incarnation,
  });
};

/**
 * The launch channel is intentionally much smaller than MCP: it accepts one externally
 * constituted session id, returns that session's credential once, and closes.  It never
 * accepts a caller-supplied control-plane session id or writes any received value durably.
 */
const serveSessionLaunchCredential = (
  socket: Socket,
  pending: Map<string, PendingLaunchCredential>,
): void => {
  let buffer = Buffer.alloc(0);
  let settled = false;
  const finish = (body: Record<string, unknown>): void => {
    if (settled) return;
    settled = true;
    socket.removeListener("data", receive);
    socket.end(`${JSON.stringify(body)}\n`);
  };
  const refuse = (): void => finish({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
  const receive = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MCP_LINE_BYTES) return refuse();
    const boundary = buffer.indexOf(0x0a);
    if (boundary === -1) return;
    if (buffer.subarray(boundary + 1).length > 0) return refuse();
    let request: unknown;
    try {
      request = JSON.parse(buffer.subarray(0, boundary).toString("utf8")) as unknown;
    } catch {
      return refuse();
    }
    const externalSessionId = launchExternalSessionId(request);
    if (!externalSessionId) return refuse();
    const launch = pending.get(externalSessionId);
    if (!launch || launch.expiresAtMs <= Date.now()) {
      pending.delete(externalSessionId);
      return refuse();
    }

    // Consume before writing. If the peer disappears while receiving its response, retrying
    // this session is unsafe because the plaintext could already have crossed the socket.
    pending.delete(externalSessionId);
    finish({
      ok: true,
      sessionId: launch.credential.sessionId,
      sessionIncarnation: launch.credential.sessionIncarnation,
      sessionSecret: launch.credential.sessionSecret,
    });
  };
  socket.on("data", receive);
  socket.once("error", () => {
    if (!settled) {
      settled = true;
      socket.removeListener("data", receive);
    }
  });
};

const launchExternalSessionId = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const externalSessionId = (value as { externalSessionId?: unknown }).externalSessionId;
  return typeof externalSessionId === "string" && externalSessionId.length > 0
    ? externalSessionId
    : null;
};

const serveBuzzActorBinding = (socket: Socket, ingress: BuzzActorIngress): void => {
  let buffer = Buffer.alloc(0);
  let settled = false;
  const finish = (decision: Decision<unknown>): void => {
    if (settled) return;
    settled = true;
    socket.removeListener("data", receive);
    endWithDecision(socket, decision);
  };
  const receive = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MCP_LINE_BYTES) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz actor ingress message exceeds local transport limit"));
    }
    const boundary = buffer.indexOf(0x0a);
    if (boundary === -1) return;
    const line = buffer.subarray(0, boundary).toString("utf8");
    // This endpoint accepts exactly one relay envelope per connection. Ignoring a second
    // line would make its replay and ordering semantics impossible to reason about.
    if (buffer.subarray(boundary + 1).length > 0) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz actor ingress accepts one envelope per connection"));
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz actor ingress message is not JSON"));
    }
    const input = presentedBuzzActorBinding(value);
    if (!input) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz actor ingress message is incomplete"));
    }
    finish(ingress.bindActor(input));
  };
  socket.on("data", receive);
  socket.once("error", () => {
    settled = true;
    socket.removeListener("data", receive);
  });
};

const presentedBuzzActorBinding = (value: unknown): {
  actor: string;
  sessionId: string;
  sessionSecret: string;
  nonce: string;
  signature: string | null;
} | null => {
  if (!value || typeof value !== "object") return null;
  const { actor, sessionId, sessionSecret, nonce, signature } = value as {
    actor?: unknown;
    sessionId?: unknown;
    sessionSecret?: unknown;
    nonce?: unknown;
    signature?: unknown;
  };
  if (
    typeof actor !== "string" ||
    typeof sessionId !== "string" ||
    typeof sessionSecret !== "string" ||
    typeof nonce !== "string" ||
    (signature !== undefined && signature !== null && typeof signature !== "string")
  ) {
    return null;
  }
  return { actor, sessionId, sessionSecret, nonce, signature: signature ?? null };
};

interface AcceptedConnection {
  transport: SocketTransport;
  credential: PeerCredential;
}

interface ActiveBoundSocketPeer {
  kind: "BOUND";
  binding: RoleBinding;
  sessionIncarnation: string;
}

/** The sole unbound peer shape: a recipient of one current normal handoff. */
interface PendingHandoffSocketPeer {
  kind: "PENDING_HANDOFF_ACK";
  handoffId: string;
  sessionIncarnation: string;
  fromGeneration: number;
}

type BoundSocketPeer = ActiveBoundSocketPeer | PendingHandoffSocketPeer;

interface PendingNormalHandoff {
  handoffId: string;
  fromGeneration: number;
}

/**
 * The socket name is an authority boundary, not just an API catalogue. Capturing the
 * exact binding here lets request authentication reject a connection after failover.
 */
const authenticateSocketPeer = (
  cp: ControlPlane,
  credential: PeerCredential,
  expectedRoles: readonly Role[],
  permitPendingHandoffAck = false,
): Decision<BoundSocketPeer> => {
  const session = cp.sessions.verifySecret(credential.sessionId, credential.sessionSecret);
  if (!session.allowed) return session as Decision<BoundSocketPeer>;
  if (
    session.value.lifecycle !== SessionLifecycle.READY &&
    session.value.lifecycle !== SessionLifecycle.DRAINING
  ) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "peer session is not eligible for a local MCP socket", {
      sessionId: credential.sessionId,
      lifecycle: session.value.lifecycle,
    });
  }

  const candidate = cp.bindings
    .bySession(credential.sessionId)
    .find((binding) => binding.status === "ACTIVE" && expectedRoles.includes(binding.role));
  if (!candidate) {
    if (permitPendingHandoffAck && session.value.lifecycle === SessionLifecycle.READY) {
      const pending = currentPendingNormalHandoff(cp, credential.sessionId);
      if (pending.allowed) {
        return allow(ReasonCode.OK, {
          kind: "PENDING_HANDOFF_ACK",
          handoffId: pending.value.handoffId,
          fromGeneration: pending.value.fromGeneration,
          sessionIncarnation: session.value.incarnation,
        });
      }
    }
    return deny(ReasonCode.BINDING_GENERATION_STALE, "session does not hold this socket's current role", {
      sessionId: credential.sessionId,
      expectedRoles,
    });
  }
  if (!lifecyclePermitsBoundSocket(session.value.lifecycle, candidate.role)) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "peer session cannot use this socket in its lifecycle", {
      sessionId: credential.sessionId,
      lifecycle: session.value.lifecycle,
      role: candidate.role,
    });
  }
  const authenticated = cp.bindings.authenticateBoundSession({
    roleKey: candidate.roleKey,
    sessionId: credential.sessionId,
    sessionSecret: credential.sessionSecret,
    bindingGeneration: candidate.bindingGeneration,
  });
  if (!authenticated.allowed) return authenticated as Decision<BoundSocketPeer>;
  if (authenticated.value.sessionIncarnation !== session.value.incarnation) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "role binding belongs to a previous session incarnation", {
      roleKey: authenticated.value.roleKey,
      sessionId: credential.sessionId,
      bindingIncarnation: authenticated.value.sessionIncarnation,
      sessionIncarnation: session.value.incarnation,
    });
  }
  return allow(ReasonCode.OK, {
    kind: "BOUND",
    binding: authenticated.value,
    sessionIncarnation: session.value.incarnation,
  });
};

/**
 * Normal handoff recipients are intentionally unbound.  This predicate is their entire
 * authority: one PENDING HANDOFF row addressed to them, plus the still-current outgoing
 * PRIMARY_CTO generation that created it.  Bootstrap and recovery handoffs never qualify.
 */
const currentPendingNormalHandoff = (
  cp: ControlPlane,
  sessionId: string,
): Decision<PendingNormalHandoff> => {
  const rows = cp.db.all<{
    handoff_id: string;
    project_id: string;
    from_session_id: string | null;
    from_generation: number | null;
  }>(
    `SELECT handoff_id, project_id, from_session_id, from_generation
       FROM handoffs
      WHERE to_session_id = ? AND kind = 'HANDOFF' AND status = 'PENDING'
      ORDER BY created_at`,
    [sessionId],
  );
  if (rows.length !== 1) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "session has no unique pending normal handoff", {
      sessionId,
      pendingHandoffs: rows.length,
    });
  }
  const handoff = rows[0]!;
  if (handoff.from_session_id === null || handoff.from_generation === null) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "normal handoff has no outgoing binding fence", {
      handoffId: handoff.handoff_id,
    });
  }
  const outgoing = cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId: handoff.project_id }));
  if (
    !outgoing ||
    outgoing.sessionId !== handoff.from_session_id ||
    outgoing.bindingGeneration !== handoff.from_generation
  ) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "handoff outgoing binding is no longer current", {
      handoffId: handoff.handoff_id,
      expectedGeneration: handoff.from_generation,
      currentGeneration: outgoing?.bindingGeneration ?? null,
    });
  }
  return allow(ReasonCode.OK, {
    handoffId: handoff.handoff_id,
    fromGeneration: handoff.from_generation,
  });
};

/** A draining primary keeps only its already-fenced authority; no other draining role does. */
const lifecyclePermitsBoundSocket = (lifecycle: SessionLifecycle, role: Role): boolean =>
  lifecycle === SessionLifecycle.READY ||
  (lifecycle === SessionLifecycle.DRAINING && role === Role.PRIMARY_CTO);

const authenticateSocket = (
  socket: Socket,
  token: string,
  handshakeTimeoutMs: number,
): Promise<AcceptedConnection | null> =>
  new Promise((resolveTransport) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const finish = (transport: AcceptedConnection | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      socket.removeListener("data", receive);
      socket.removeListener("error", transportError);
      socket.removeListener("close", transportClosed);
      resolveTransport(transport);
    };
    const reject = (respond = true): void => {
      if (settled) return;
      if (respond && !socket.destroyed) {
        // The client receives the stable denial without ever reaching an MCP transport
        // or a tool handler. This makes the ordering observable to both callers and tests.
        endWithDecision(socket, deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "local MCP authentication failed"));
      } else {
        socket.destroy();
      }
      finish(null);
    };
    const transportError = (): void => reject(false);
    const transportClosed = (): void => reject(false);
    const receive = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_MCP_LINE_BYTES) return reject();
      const boundary = buffer.indexOf(0x0a);
      if (boundary === -1) return;
      const line = buffer.subarray(0, boundary).toString("utf8");
      const remainder = buffer.subarray(boundary + 1);
      let presented: unknown;
      try {
        presented = JSON.parse(line) as unknown;
      } catch {
        return reject();
      }
      if (!localMcpTokenMatches(presented, token)) return reject();
      const credential = presentedCredential(presented);
      if (!credential) return reject();
      socket.pause();
      finish({ transport: new SocketTransport(socket, remainder), credential });
    };
    socket.on("data", receive);
    socket.once("error", transportError);
    socket.once("close", transportClosed);
    timeout = setTimeout(() => reject(), handshakeTimeoutMs);
    timeout.unref();
  });

/**
 * The deployment token proves the caller may reach the socket at all; it says nothing
 * about *which* session is calling. The handshake therefore also carries the session's
 * own secret, and every request re-verifies it — a session that has been respawned or
 * stopped is no longer a peer even on a connection that authenticated earlier.
 */
const presentedCredential = (value: unknown): PeerCredential | null => {
  if (!value || typeof value !== "object") return null;
  const { sessionId, sessionSecret } = value as { sessionId?: unknown; sessionSecret?: unknown };
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof sessionSecret !== "string" || sessionSecret.length === 0) return null;
  return { sessionId, sessionSecret };
};

interface PeerCredential {
  sessionId: string;
  sessionSecret: string;
}

const peerAuthenticator =
  (cp: ControlPlane, credential: PeerCredential, opening: BoundSocketPeer): McpPeerAuthenticator =>
  () => {
    const session = cp.sessions.verifySecret(credential.sessionId, credential.sessionSecret);
    if (!session.allowed) return session as Decision<AuthenticatedMcpPeer>;
    if (session.value.incarnation !== opening.sessionIncarnation) {
      return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "session was respawned since this connection authenticated", {
        sessionId: credential.sessionId,
        handshake: opening.sessionIncarnation,
        current: session.value.incarnation,
      });
    }
    if (opening.kind === "PENDING_HANDOFF_ACK") {
      if (session.value.lifecycle !== SessionLifecycle.READY) {
        return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "pending handoff recipient is not READY", {
          sessionId: credential.sessionId,
          lifecycle: session.value.lifecycle,
        });
      }
      const pending = currentPendingNormalHandoff(cp, credential.sessionId);
      if (
        !pending.allowed ||
        pending.value.handoffId !== opening.handoffId ||
        pending.value.fromGeneration !== opening.fromGeneration
      ) {
        return deny(ReasonCode.BINDING_GENERATION_STALE, "pending handoff is no longer current for this socket", {
          sessionId: credential.sessionId,
          handoffId: opening.handoffId,
          expectedGeneration: opening.fromGeneration,
        });
      }
      return allow(ReasonCode.OK, authenticatedPeer(credential, opening.sessionIncarnation));
    }

    if (!lifecyclePermitsBoundSocket(session.value.lifecycle, opening.binding.role)) {
      return deny(
        ReasonCode.MCP_PEER_UNAUTHENTICATED,
        `peer session is ${session.value.lifecycle} and cannot retain this role's socket authority`,
        { sessionId: credential.sessionId, lifecycle: session.value.lifecycle, role: opening.binding.role },
      );
    }
    const bound = cp.bindings.authenticateBoundSession({
      roleKey: opening.binding.roleKey,
      sessionId: credential.sessionId,
      sessionSecret: credential.sessionSecret,
      bindingGeneration: opening.binding.bindingGeneration,
    });
    if (!bound.allowed) return bound as Decision<AuthenticatedMcpPeer>;
    if (bound.value.sessionIncarnation !== opening.sessionIncarnation) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "socket binding no longer matches this session incarnation", {
        roleKey: opening.binding.roleKey,
        sessionId: credential.sessionId,
        handshake: opening.sessionIncarnation,
        binding: bound.value.sessionIncarnation,
      });
    }
    return allow(ReasonCode.OK, authenticatedPeer(credential, opening.sessionIncarnation));
  };

/**
 * The plaintext is attached only to this in-process peer context. It never becomes a tool
 * argument or response; `handoff_ack` uses it to construct the lifecycle's authenticated
 * envelope, which verifies it again against SessionRegistry before switching generations.
 */
const authenticatedPeer = (
  credential: PeerCredential,
  sessionIncarnation: string,
): AuthenticatedMcpPeer & { sessionSecret: string } => ({
  actor: credential.sessionId,
  sessionId: credential.sessionId,
  sessionIncarnation,
  sessionSecret: credential.sessionSecret,
});

export const localMcpTokenMatches = (value: unknown, expected: string): boolean => {
  if (!value || typeof value !== "object" || !("token" in value)) return false;
  const presented = (value as { token: unknown }).token;
  if (typeof presented !== "string") return false;
  const actualBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #buffer: Buffer;
  #started = false;
  #closed = false;

  constructor(
    private readonly socket: Socket,
    initial: Buffer,
  ) {
    this.#buffer = initial;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("MCP socket transport already started");
    this.#started = true;
    this.socket.on("data", this.receive);
    this.socket.once("error", this.error);
    this.socket.once("close", this.closed);
    this.processBuffer();
    this.socket.resume();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.#closed) throw new Error("MCP socket transport is closed");
    await new Promise<void>((resolveWrite, reject) => {
      this.socket.write(`${JSON.stringify(message)}\n`, (err) => (err ? reject(err) : resolveWrite()));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.socket.end();
    this.closed();
  }

  private readonly receive = (chunk: Buffer): void => {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.processBuffer();
  };

  private processBuffer(): void {
    if (this.#buffer.length > MAX_MCP_LINE_BYTES) {
      this.error(new Error("MCP message exceeds local transport limit"));
      this.socket.destroy();
      return;
    }
    let boundary = this.#buffer.indexOf(0x0a);
    while (boundary !== -1) {
      const line = this.#buffer.subarray(0, boundary).toString("utf8");
      this.#buffer = this.#buffer.subarray(boundary + 1);
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object") throw new Error("MCP message is not an object");
        this.onmessage?.(parsed as JSONRPCMessage);
      } catch (err) {
        this.error(err instanceof Error ? err : new Error(String(err)));
        this.socket.destroy();
        return;
      }
      boundary = this.#buffer.indexOf(0x0a);
    }
  }

  private readonly error = (err: Error): void => {
    this.onerror?.(err);
  };

  private readonly closed = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  };
}

/** The actor allowlist is deployment configuration, never a relay-supplied claim. */
const configuredBuzzActorIngressPolicy = (): IngressPolicy | null => {
  const secret = process.env["ACP_BUZZ_INGRESS_SECRET"]?.trim() ?? "";
  const allowedActors = (process.env["ACP_BUZZ_ALLOWED_ACTORS"] ?? "")
    .split(",")
    .map((actor) => actor.trim())
    .filter((actor) => actor.length > 0);
  if (secret.length === 0 && allowedActors.length === 0) return null;
  if (secret.length === 0 || allowedActors.length === 0) {
    throw new Error(
      "ACP_BUZZ_INGRESS_SECRET and ACP_BUZZ_ALLOWED_ACTORS must be configured together",
    );
  }
  return { allowedActors, secret };
};

/**
 * `agentcpd` — the single local runtime authority (PRD §33.1).
 *
 * Intended to run under a process supervisor (`launchd` on macOS). The daemon owns the
 * single-instance lock, restart reconciliation, the watchdog timer and Buzz delivery.
 */
export const main = async (): Promise<void> => {
  const config = defaultConfig();
  const stateDir = dirname(config.databasePath);
  const buzzActorIngressPolicy = configuredBuzzActorIngressPolicy();
  if (process.env["BUZZ_PRIVATE_KEY"] && !buzzActorIngressPolicy) {
    throw new Error(
      "Buzz transport requires ACP_BUZZ_INGRESS_SECRET and ACP_BUZZ_ALLOWED_ACTORS for authenticated actor binding",
    );
  }
  const mcpToken = process.env["ACP_MCP_TOKEN"];
  if (!mcpToken) throw new Error("ACP_MCP_TOKEN is required for authenticated local MCP sockets");
  const operatorToken = process.env["ACP_OPERATOR_TOKEN"]?.trim();
  if (!operatorToken) {
    throw new Error(
      "ACP_OPERATOR_TOKEN is required for the operator socket; ACP_MCP_TOKEN identifies no peer and cannot be reused",
    );
  }
  if (operatorToken === mcpToken.trim()) {
    throw new Error(
      "ACP_OPERATOR_TOKEN must be a dedicated credential distinct from ACP_MCP_TOKEN; the MCP token identifies no peer",
    );
  }
  const operatorActor = process.env["ACP_OPERATOR_ACTOR"]?.trim() || process.env["USER"]?.trim() || "";
  if (!operatorActor) {
    throw new Error("ACP_OPERATOR_ACTOR or USER is required to establish the operator peer identity");
  }
  const cp = new ControlPlane(config);

  let sessionLaunch: LocalSessionLaunchChannel;
  try {
    sessionLaunch = await startSessionLaunchChannel(stateDir);
  } catch (err) {
    cp.close();
    throw err;
  }

  const buzz = new BuzzAdapter(
    cp.db,
    cp.clock,
    cp.audit,
    cp.sessions,
    cp.bindings,
    cp.outbox,
    new BuzzCliTransport(process.env["ACP_BUZZ_BINARY"] ?? "buzz", process.env["ACP_BUZZ_CHANNEL"] ?? null),
  );
  cp.cto.attach({
    buzz: {
      connect: (sessionId, purpose) => buzz.connect(sessionId, purpose),
      disconnect: (sessionId) => buzz.disconnect(sessionId),
    },
    readiness: { checkSession: (id) => cp.doctor.sessionReadiness(id) },
    sessionLaunch,
  });

  const daemon = cp.createDaemon({ stateDir, buzz });

  const started = await daemon.start();
  if (!started.allowed) {
    process.stderr.write(`${JSON.stringify(started, null, 2)}\n`);
    process.stderr.write(
      `backoff: ${JSON.stringify(daemon.crashLoopState())}\n`,
    );
    const backoffSeconds = daemon.crashLoopState().backoffSeconds;
    if (backoffSeconds > 0) await waitForBackoff(backoffSeconds);
    await sessionLaunch.close();
    cp.close();
    process.exit(1);
  }

  let listeners: LocalMcpListeners | null = null;
  let buzzActorIngress: LocalBuzzActorIngress | null = null;
  let operator: LocalOperatorListener | null = null;
  let hermesBootstrap: HermesBootstrapAuthority | null = null;
  try {
    hermesBootstrap = createHermesBootstrapAuthority(cp, {
      stateDir,
      mcpSocketPath: join(stateDir, "hermes.mcp.sock"),
      mcpToken,
      authorityHeld: () => daemon.lock.held(),
    });
    // The operator socket is opened first so the uninitialized-only bootstrap door can be
    // reached without exposing a normal Hermes listener that has no bound peer yet.
    operator = await startOperatorSocket(
      daemon,
      stateDir,
      {
        token: operatorToken,
        peerId: `cli:${operatorActor}`,
        actor: operatorActor,
      },
      {
        mcpToken,
        bootstrapHermes: (params) => hermesBootstrap!.bootstrap(params),
      },
    );
    listeners = await startDaemonMcpListeners(cp, stateDir, mcpToken, daemon);
    if (buzzActorIngressPolicy) {
      buzzActorIngress = await startBuzzActorIngressListener(cp, stateDir, buzzActorIngressPolicy);
    }
  } catch (err) {
    await operator?.close();
    await hermesBootstrap?.close();
    await listeners?.close();
    await sessionLaunch.close();
    await daemon.stop();
    cp.close();
    throw err;
  }

  process.stdout.write(`${JSON.stringify({ started: started.value }, null, 2)}\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nshutting down on ${signal}\n`);
    await buzzActorIngress?.close();
    await operator?.close();
    await hermesBootstrap?.close();
    await listeners?.close();
    await sessionLaunch.close();
    await daemon.stop();
    cp.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Keep the process alive; work arrives through authenticated local MCP sockets or timers.
  setInterval(() => daemon.writeHealth(null), 30_000).unref();
  await new Promise<void>(() => undefined);
};

const waitForBackoff = async (seconds: number): Promise<void> => {
  let remainingMs = seconds * 1000;
  while (remainingMs > 0) {
    const intervalMs = Math.min(60_000, remainingMs);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, intervalMs));
    remainingMs -= intervalMs;
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((err: unknown) => {
    const body = isAcpError(err)
      ? { reasonCode: err.reasonCode, message: err.message, evidence: err.evidence }
      : { message: (err as Error).message, stack: (err as Error).stack };
    process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
    process.exit(1);
  });
}
