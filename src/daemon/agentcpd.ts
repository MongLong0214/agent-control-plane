#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { ControlPlane, defaultConfig, type ControlPlaneConfig } from "../app/control-plane.ts";
import { COLLECTOR_TIMEOUT_MS } from "../capacity/usage-collectors.ts";
import {
  DEFAULT_RUNTIME_TIMEOUT_MS as HERMES_RUNTIME_TIMEOUT_MS,
  createHermesBootstrapAuthority,
  type HermesBootstrapAuthority,
} from "../bootstrap/hermes-bootstrap.ts";
import { BuzzAdapter, BuzzCliTransport } from "../buzz/buzz-adapter.ts";
import type { OwnerIdentity } from "../ceo/owner-authority.ts";
import { type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  BuzzActorIngress,
  IngressGuard,
  isTransportRetentionUnknown,
  type IngressPolicy,
} from "../ingress/ingress-guard.ts";
import {
  BuzzMessageIngress,
  deliverBuzzMessageToCeo,
  type BuzzMessageIngressInput,
  type BuzzMessageTurnPort,
  type CeoTurnDelivery,
} from "../ingress/buzz-message.ts";
import {
  configuredTelegramLongPollConfig,
  startTelegramLongPollListener,
  type TelegramBotTransport,
  type TelegramLongPollStartOptions,
  type TelegramLongPollListener,
} from "../ingress/telegram-polling.ts";
import type { TelegramDirectAnswer } from "../ingress/telegram-router.ts";
import { Role, SessionLifecycle, roleKeyFor, type RoleBinding } from "../domain/types.ts";
import type { SessionLaunchCredential } from "../cto/cto-lifecycle.ts";
import { createCtoMcpPort, createCtoServer } from "../mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../mcp/hermes-server.ts";
import { CeoConversationPort } from "../mcp/ceo-conversation.ts";
import type { AuthenticatedMcpPeer, McpPeerAuthenticator } from "../mcp/shared.ts";
import type { AuthenticatedOperatorPeer, Daemon } from "./daemon.ts";

const MAX_MCP_LINE_BYTES = 1024 * 1024;
const DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS = 5_000;
/**
 * The handshake budget covers reaching an authenticated request and nothing after it. Execution
 * gets its own, larger one because the two answer different questions: a peer that has not
 * identified itself in five seconds is not going to, while `doctor.run` probes every capacity
 * sensor and measured about six seconds on the deployment host.
 *
 * Running one deadline over both is how a healthy daemon came to answer `OPERATOR_UNAUTHENTICATED`
 * to an operator whose token was correct and whose peer had already been admitted (#609).
 */
export const DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How many collectors a doctor pass may wait on, one after another. `CapacityMonitor.refresh`
 * loops the adapters sequentially, so the pass costs the sum and not the maximum.
 */
const PROVIDER_BUDGET_SLOTS = 3;

/**
 * Per-method budgets, because one number cannot be right for both `daemon.status` (2ms measured)
 * and `doctor.run`.
 *
 * A flat 30s was chosen against a healthy day — measured 7.4s with three healthy providers — and
 * would have refused the very method it was raised for as soon as two providers went slow, which
 * is #609 again in a different dress. So the doctor's budget is derived from the collector budget
 * rather than picked, and grows when that grows.
 *
 * `bootstrap.hermes` gets more than the runtime budget it waits on, for the same reason the
 * client budget exceeds the server's: two equal deadlines racing is how one healthy daemon
 * reported two different reason codes for one failure.
 */
export const OPERATOR_METHOD_BUDGET_MS: Readonly<Record<string, number>> = {
  "doctor.run": PROVIDER_BUDGET_SLOTS * COLLECTOR_TIMEOUT_MS + DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS,
  "bootstrap.hermes": HERMES_RUNTIME_TIMEOUT_MS + DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS,
};

/**
 * `configured` scales the whole table rather than replacing one entry. A socket configured with a
 * smaller budget shrinks every method in proportion, which keeps the ratios — the reason
 * `doctor.run` is wider than `daemon.status` does not change because a test wants both faster —
 * and keeps the table reachable from a test at all. An absolute table that ignored the option
 * would have made these budgets unconfigurable and unmeasurable, which is the same thing.
 */
export const operatorMethodBudgetMs = (method: string, configured: number): number => {
  const stated = OPERATOR_METHOD_BUDGET_MS[method];
  if (stated === undefined) return configured;
  const scale = configured / DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS;
  return Math.max(1, Math.round(stated * scale));
};

/** The widest server-side budget any method may take; the client has to outlast it. */
export const MAX_OPERATOR_METHOD_BUDGET_MS = Math.max(
  DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS,
  ...Object.values(OPERATOR_METHOD_BUDGET_MS),
);
// A normal handoff package remains deliverable for thirty minutes. Do not make its recipient's
// one-time bootstrap proof expire sooner than the package it must acknowledge.
const SESSION_LAUNCH_TTL_MS = 30 * 60_000;

export interface LocalMcpListeners {
  socketPaths: readonly string[];
  /** §6.1 DIRECT — the daemon's handle on whoever currently holds the CEO socket. */
  ceoConversation: CeoConversationPort;
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
  /** Lets a test shorten the conversation budget without waiting out the production one. */
  ceoConversation?: CeoConversationPort;
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

/** A daemon-owned local hop from the authenticated Buzz relay to the CEO conversation port. */
export interface LocalBuzzMessageIngress {
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
  /** Execution budget for an authenticated method, distinct from the handshake budget. */
  requestTimeoutMs?: number;
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
  const ceoConversation = options.ceoConversation ?? new CeoConversationPort();
  const hermes = await startMcpSocket(
    hermesPath,
    token,
    cp,
    [Role.CEO],
    handshakeTimeoutMs,
    (auth) => {
      const server = createHermesServer(hermesPort, auth);
      // The authenticator travels with the connection, not just the server. Reaching this line
      // proves the peer held the CEO binding at handshake; `ask` re-runs `auth` so a socket
      // that outlives its binding cannot keep receiving the owner.
      server.server.onclose = ceoConversation.attach(server, auth);
      return server;
    },
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
    ceoConversation,
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
    throw new Error("Buzz channel identity ingress requires a non-empty signing secret");
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
 * §6.1 DIRECT for the Buzz surface: an owner's message becomes one turn for the session that
 * currently holds the CEO binding, and the CEO's answer goes back to the relay that sent it.
 *
 * **Its own socket, beside `buzz-actor.ingress.sock` rather than on it.** The three reasons are
 * not stylistic:
 *
 *   - The binding socket's protocol has no method field. It reads one envelope per connection
 *     and dispatches it to `bindActor` by field presence alone, and its answer is a
 *     `Decision<SessionRecord>` with no payload. Multiplexing a second request type onto it
 *     would mean inventing a discriminator on a wire that has none, and a malformed envelope of
 *     either kind could then be parsed as the other.
 *   - `BuzzActorIngress.bindActor` is the only production writer of `sessions.buzz_actor_id`
 *     and requires the local session secret to prove possession. Nothing on the message path
 *     needs that authority, and separate sockets mean it cannot reach it even by accident: the
 *     parse boundary and the authority boundary are the same boundary.
 *   - Their dependencies differ. The binding listener needs only the ingress policy; this one
 *     is meaningless without the CEO conversation port, which `main` builds later, from the
 *     MCP listeners.
 *
 * A client that connects to the wrong one is refused, never silently served: a message envelope
 * on the binding socket has no `sessionId`/`sessionSecret` and is refused as incomplete (that is
 * exactly what #627's base measurement observed), and a binding envelope here has no
 * `text`/`eventId` and is refused the same way. Neither crosses.
 */
export const startBuzzMessageIngressListener = async (
  cp: ControlPlane,
  stateDir: string,
  policy: IngressPolicy,
  options: { ceoConversation: CeoConversationPort; ownerActors: readonly string[] },
): Promise<LocalBuzzMessageIngress> => {
  if (!policy.secret || policy.secret.trim().length === 0) {
    throw new Error("Buzz message ingress requires a non-empty signing secret");
  }

  const guard = new IngressGuard(cp.db, cp.clock, cp.audit, { buzz: policy });
  // `policy.allowedActors` is the relay credential's list and admits every ACTIVE Buzz actor;
  // `ownerActors` is who may speak to the CEO as the owner. Passing the first for the second is
  // the defect this argument exists to make impossible to write by accident.
  const ingress = new BuzzMessageIngress(guard, options.ownerActors);
  const port: BuzzMessageTurnPort = {
    deliverToCeo: (text) => deliverAsCeoTurn(options.ceoConversation, text),
    // Read at claim time, from the binding registry rather than from the peer: the fence is
    // "which CEO generation was this turn claimed under", and the peer cannot be its own
    // authority for that. Telegram's production composition still passes none (#639's seam is
    // unwired there), so this is the first path that records a real generation on a claim.
    bindingGeneration: () => cp.bindings.active(roleKeyFor(Role.CEO))?.bindingGeneration ?? null,
  };
  const socketPath = join(stateDir, "buzz-message.ingress.sock");
  removeStaleSocket(socketPath);
  const server = createServer((socket) => serveBuzzMessageTurn(socket, ingress, port));

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
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("operator request timeout must be a positive integer");
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
  const server = createServer((socket) =>
    serveOperatorRequest(socket, daemon, binding, handshakeTimeoutMs, requestTimeoutMs, options),
  );
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

/**
 * The listener a parked daemon serves. It is the operator socket with the Hermes bootstrap
 * extension withheld: `bootstrap.hermes` constitutes CEO (`hermes-bootstrap.ts`), which is not
 * something a daemon that has not passed its startup doctor may hand out. Every other
 * restriction is the daemon's — `BOOTSTRAP_OPERATOR_METHODS` decides what a parked daemon
 * answers, so the transport never becomes a second, divergent opinion about what is admitted.
 */
export const startBootstrapOperatorDoor = (
  daemon: Pick<Daemon, "handleOperatorRequest" | "lock">,
  stateDir: string,
  credential: LocalOperatorCredential,
  options: Omit<LocalOperatorSocketOptions, "bootstrapHermes"> = {},
): Promise<LocalOperatorListener> => startOperatorSocket(daemon, stateDir, credential, options);

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
  requestTimeoutMs: number,
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
  const beginRequest = (method: string): void => {
    if (timeout) clearTimeout(timeout);
    const budgetMs = operatorMethodBudgetMs(method, requestTimeoutMs);
    timeout = setTimeout(() => {
      // "did not answer", not "did not happen". The socket closes; the dispatched method keeps
      // running and its later `finish` is a no-op, so a mutation can still land after this
      // refusal. Calling it a failure would be a claim about the write, which this does not know.
      finish(
        deny(
          ReasonCode.OPERATOR_REQUEST_TIMEOUT,
          "operator method did not answer within its budget; it was not cancelled and may still complete",
          { method, budgetMs },
        ),
      );
    }, budgetMs);
    timeout.unref();
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
    // The handshake is over: this peer authenticated. Everything from here is a statement about
    // the method, so the deadline governing it has to be a different one under a different name.
    // Leaving the handshake timer armed made every method slower than five seconds report that
    // the operator had not authenticated, which they had.
    beginRequest(method ?? "<none>");
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
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz channel identity ingress message exceeds local transport limit"));
    }
    const boundary = buffer.indexOf(0x0a);
    if (boundary === -1) return;
    const line = buffer.subarray(0, boundary).toString("utf8");
    // This endpoint accepts exactly one relay envelope per connection. Ignoring a second
    // line would make its replay and ordering semantics impossible to reason about.
    if (buffer.subarray(boundary + 1).length > 0) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz channel identity ingress accepts one envelope per connection"));
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz channel identity ingress message is not JSON"));
    }
    const input = presentedBuzzActorBinding(value);
    if (!input) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz channel identity ingress message is incomplete"));
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

/**
 * One Buzz message per connection, answered on the same connection.
 *
 * The connection is held for the length of the CEO turn rather than acknowledged and forgotten,
 * because the relay is the thing that owns the Buzz thread: the answer has to go back where the
 * question came from (SSOT §126–127), and this is the only handle on that thread. A message that
 * never completes its first line inside the handshake budget is refused, so a peer that connects
 * and says nothing cannot hold a slot open.
 */
const serveBuzzMessageTurn = (
  socket: Socket,
  ingress: BuzzMessageIngress,
  port: BuzzMessageTurnPort,
): void => {
  let buffer = Buffer.alloc(0);
  let settled = false;
  const envelopeDeadline = setTimeout(() => {
    finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz message ingress received no complete envelope"));
  }, DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS);
  envelopeDeadline.unref();
  function finish(decision: Decision<unknown>): void {
    if (settled) return;
    settled = true;
    clearTimeout(envelopeDeadline);
    socket.removeListener("data", receive);
    endWithBuzzMessage(socket, decision);
  }
  const receive = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MCP_LINE_BYTES) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz message exceeds local transport limit"));
    }
    const boundary = buffer.indexOf(0x0a);
    if (boundary === -1) return;
    const line = buffer.subarray(0, boundary).toString("utf8");
    if (buffer.subarray(boundary + 1).length > 0) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz message ingress accepts one envelope per connection"));
    }
    // Stop reading before the turn starts. A second envelope arriving while the CEO is
    // answering would otherwise re-enter this handler on the same connection.
    socket.removeListener("data", receive);
    clearTimeout(envelopeDeadline);
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz message ingress message is not JSON"));
    }
    const input = presentedBuzzMessage(value);
    if (!input) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz message ingress message is incomplete"));
    }
    void deliverBuzzMessageToCeo(ingress, port, input).then(
      (decision) => finish(decision),
      (error: unknown) => finish(deny(
        ReasonCode.INTERNAL_ERROR,
        error instanceof Error ? error.message : String(error),
      )),
    );
  };
  socket.on("data", receive);
  socket.once("error", () => {
    settled = true;
    clearTimeout(envelopeDeadline);
    socket.removeListener("data", receive);
  });
};

/**
 * Like `endWithDecision`, except the value crosses.
 *
 * That function keeps values local because the things it answers with are credentials. Here the
 * value is the CEO's answer to the owner, and the relay cannot post it to the Buzz thread
 * without receiving it — a reply that stays inside the daemon is the silence this path exists
 * to end.
 */
const endWithBuzzMessage = (socket: Socket, decision: Decision<unknown>): void => {
  const answer = decision.allowed ? (decision.value as { answer?: unknown; answeredByCeo?: unknown }) : null;
  const body = decision.allowed
    ? {
        ok: true,
        reasonCode: decision.reasonCode,
        answer: typeof answer?.answer === "string" ? answer.answer : null,
        answeredByCeo: answer?.answeredByCeo === true,
        evidence: decision.evidence,
      }
    : {
        ok: false,
        reasonCode: decision.reasonCode,
        message: decision.message,
        evidence: decision.evidence,
      };
  if (!socket.destroyed) socket.end(`${JSON.stringify(body)}\n`);
};

const presentedBuzzMessage = (value: unknown): BuzzMessageIngressInput | null => {
  if (!value || typeof value !== "object") return null;
  const { actor, conversation, eventId, addressedTo, text, signature } = value as {
    actor?: unknown;
    conversation?: unknown;
    eventId?: unknown;
    addressedTo?: unknown;
    text?: unknown;
    signature?: unknown;
  };
  if (
    typeof actor !== "string" ||
    typeof conversation !== "string" ||
    typeof eventId !== "string" ||
    typeof addressedTo !== "string" ||
    typeof text !== "string" ||
    (signature !== undefined && signature !== null && typeof signature !== "string")
  ) {
    return null;
  }
  return { actor, conversation, eventId, addressedTo, text, signature: signature ?? null };
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

/** The channel-identity allowlist is deployment configuration, never a relay-supplied claim. */
/**
 * The deployment's Buzz ingress policy, read from the environment `agentcpd` runs under.
 *
 * Exported so `scripts/capture-buzz-live.ts` can prove the refusal is *this* policy's rather than
 * one the capture constructed (#243). A capture that builds its own allowlist shows that
 * `IngressGuard` enforces a list, which was never in doubt — it does not show that the deployment
 * would refuse the actor.
 */
export const configuredBuzzActorIngressPolicy = (): IngressPolicy | null => {
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
 * Which Buzz channel identities may speak to the CEO as the owner.
 *
 * Read from `owner-identities` (#245) rather than from `ACP_BUZZ_ALLOWED_ACTORS`, because the
 * two answer different questions. The environment allowlist is the relay credential's: it says
 * which channel identities may present an envelope at all, and every ACTIVE Buzz actor the
 * deployment talks to is on it. Owner authority is declared once, on the host, for every
 * channel — Telegram already refuses to start on an owner id missing from that file — and the
 * message path takes its owners from the same place.
 *
 * An empty result is not a permissive default: `main` leaves the message socket closed and says
 * so, which is the fail-closed half of the same separation.
 */
export const configuredBuzzMessageOwnerActors = (
  ownerIdentities: readonly OwnerIdentity[],
): string[] => [
  ...new Set(
    ownerIdentities
      .filter((identity) => identity.channel === "buzz")
      .map((identity) => identity.actor.trim())
      .filter((actor) => actor.length > 0),
  ),
];

/**
 * The daemon's Telegram composition root. Tests may replace only the external transport; the
 * guard, sealed Hermes port, CEO receipt callback, durable response reader and poll service are
 * still assembled by the same factory `main` uses.
 */
export type DaemonTelegramStartOptions = Omit<TelegramLongPollStartOptions, "onCeoApproved"> & {
  transport?: TelegramBotTransport;
};

type DaemonTelegramComposition = {
  finalizeApprovedRun(runId: string): void | Promise<unknown>;
  setTelegramIngressStatus?(status: {
    configured: boolean;
    running: boolean;
    disabledReason: string | null;
    recoveryNonce?: string | null;
  }): void;
  attachTelegramIngressController?(controller: TelegramLongPollListener["service"]): void;
  detachTelegramIngressController?(controller: TelegramLongPollListener["service"]): void;
};

export const startDaemonTelegramListener = async (
  cp: ControlPlane,
  config: Parameters<typeof startTelegramLongPollListener>[1],
  daemon: DaemonTelegramComposition,
  options: DaemonTelegramStartOptions = {},
): Promise<TelegramLongPollListener> => {
  const listener = await startTelegramLongPollListener(cp, config, {
    ...options,
    // The daemon attaches the recovery controller before the first poll can possibly stop.
    start: false,
    onCeoApproved: (runId) => daemon.finalizeApprovedRun(runId),
    onRuntimeStatus: (status) => {
      try {
        daemon.setTelegramIngressStatus?.({
          configured: true,
          running: status.running,
          disabledReason: status.running
            ? null
            : status.stopReason === "UNKNOWN_DELIVERY"
              ? `listener stopped after an UNKNOWN reply delivery for nonce '${status.recoveryNonce}'; acknowledge this exact nonce to resume`
              : status.stopReason === "NOT_STARTED"
                ? "listener has not been started"
                : "listener closed",
          recoveryNonce: status.recoveryNonce,
        });
      } catch (error) {
        // Health I/O is an observer of the loop. Report its failure without turning a running
        // listener into a half-started one that the composition root no longer has a handle on.
        options.onError?.(error);
      }
      options.onRuntimeStatus?.(status);
    },
  });
  daemon.attachTelegramIngressController?.(listener.service);
  if (options.start === false) {
    const status = { running: false, stopReason: "NOT_STARTED", recoveryNonce: null } as const;
    daemon.setTelegramIngressStatus?.({
      configured: true,
      running: false,
      disabledReason: "listener has not been started",
      recoveryNonce: null,
    });
    options.onRuntimeStatus?.(status);
  } else {
    listener.service.start();
  }
  return {
    service: listener.service,
    close: async () => {
      try {
        await listener.close();
      } finally {
        daemon.detachTelegramIngressController?.(listener.service);
      }
    },
  };
};

/**
 * `startDaemonTelegramListener`, but a transport whose redelivery retention `IngressGuard`
 * cannot bound (#682, round 8) is refused as `null` rather than thrown.
 *
 * A supported, deliberately-configured transport — most commonly a self-hosted Bot API server
 * behind `ACP_TELEGRAM_API_BASE_URL` — can have a retention nobody here has measured, and the
 * guard now refuses to build a nonce floor it cannot bound. That refusal must not take the rest
 * of the daemon down with it: this operator configured Telegram on purpose, and MCP listeners,
 * Buzz and the operator door still have to come up. Any other failure is still a real bug and is
 * rethrown unchanged, so `main`'s own startup teardown still runs for it exactly as before.
 *
 * A separate top-level function rather than a nested `try`/`catch` inline in `main`: a nested
 * `try` that reassigns an outer `let` and conditionally rethrows is a real TypeScript control-flow
 * analysis gap (confirmed with a minimal reproduction against this repo's compiler) — the outer
 * variable narrows to `never` at the enclosing `catch` even though the value is reachable there.
 * One `await` of a plain function does not exhibit it.
 */
const startDaemonTelegramListenerOrRefuse = async (
  cp: ControlPlane,
  config: Parameters<typeof startTelegramLongPollListener>[1],
  daemon: DaemonTelegramComposition,
  options: DaemonTelegramStartOptions,
): Promise<{ listener: TelegramLongPollListener | null; disabledReason: string | null }> => {
  try {
    const listener = await startDaemonTelegramListener(cp, config, daemon, options);
    process.stdout.write("Telegram ingress started\n");
    return { listener, disabledReason: null };
  } catch (error) {
    if (!isTransportRetentionUnknown(error)) throw error;
    // The reason travels with the outcome rather than being re-derived at the call site, so
    // `health.json` (via `Daemon.setTelegramIngressStatus`, #682 round 8's second follow-up)
    // says the same thing this stderr line does — a daemon that comes up healthy while a
    // configured feature silently never started is exactly the gap that review found.
    const disabledReason =
      `transport's redelivery retention is not known for channel '${error.channel}'`;
    process.stderr.write(
      `Telegram ingress refused: its ${disabledReason}, so a safe nonce floor cannot be ` +
        "established; continuing without Telegram ingress\n",
    );
    return { listener: null, disabledReason };
  }
};

/**
 * `directHandler` returns a string, so a refusal has to be readable rather than thrown: the
 * owner is a person waiting in a chat, and an exception here would surface as a dropped
 * message. The reason code travels with the sentence so a refusal in the transcript can still
 * be traced to the branch that produced it.
 *
 * The return carries `answered` beside the text, and that is the whole of #639's residual fix.
 * Both branches produce a sentence the owner must see — silence after a timeout is worse than an
 * apology — but only one of them is the CEO answering. A bare string could not tell the ingress
 * layer which, so the reply's acceptance by Telegram resolved the turn either way, and a
 * `CEO_CONVERSATION_TIMEOUT` apology was indistinguishable from an answer in the row. Delivering
 * it and counting it as answered are now two separate things.
 */
export const answerAsCeo = async (
  port: CeoConversationPort,
  text: string,
): Promise<TelegramDirectAnswer> => {
  const answered = await port.ask(text);
  if (answered.allowed) return { answered: true, text: answered.value };
  return {
    answered: false,
    reasonCode: answered.reasonCode,
    text: `${ceoUnavailableSentence(answered.reasonCode)} (${answered.reasonCode})`,
  };
};

/**
 * `answerAsCeo` with the contact boundary kept, which the Buzz path needs and Telegram's
 * `directHandler` signature cannot carry.
 *
 * Whether the request crossed to the CEO peer is not derivable from the reason code — that is
 * the whole of #652 — and it decides whether the ingress claim closes or stays outstanding. A
 * string return value throws that fact away, so this returns it beside the text.
 */
export const deliverAsCeoTurn = async (
  port: CeoConversationPort,
  text: string,
): Promise<CeoTurnDelivery> => {
  const outcome = await port.attempt(text);
  const reachedCeo = outcome.contact === "REACHED";
  if (outcome.answered.allowed) {
    return { answer: outcome.answered.value, reachedCeo, reasonCode: ReasonCode.OK };
  }
  return {
    answer: `${ceoUnavailableSentence(outcome.answered.reasonCode)} (${outcome.answered.reasonCode})`,
    reachedCeo,
    reasonCode: outcome.answered.reasonCode,
  };
};

/**
 * Exported for test: these sentences are the only thing the owner sees when the CEO route
 * refuses, and one of them used to assert something this seam cannot observe. A sentence with no
 * test is a sentence that drifts back.
 */
export const ceoUnavailableSentence = (reasonCode: string): string => {
  if (reasonCode === ReasonCode.CEO_CONVERSATION_UNAVAILABLE) {
    return "No CEO session is connected right now, so there is nobody to answer this. Commands and owner decisions still work.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_UNSUPPORTED) {
    return "The connected CEO session cannot hold a conversation over this route — it did not offer sampling at handshake.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_TIMEOUT) {
    // Three corrections have landed on this one sentence, and each was the same mistake in a
    // different place.
    //
    // It said "Nothing was lost; ask again". The first correction was that this seam cannot see
    // whether anything was lost — the reply command resumes the owner's own conversation, so the
    // CEO may already have written part of an answer into it (#633).
    //
    // The second is that "ask again" is not advice, it is a mechanism. A resent message is a new
    // update with a new nonce and a new turn id, so nothing in the duplicate protection treats
    // it as the same turn — and the transcript gets the exchange twice (#641). The sentence that
    // was meant to help the owner recover was the path by which the thing being prevented
    // happened.
    //
    // So it no longer invites it. What it must not do instead is promise the mechanism that
    // replaces it: an earlier draft said a later message "is held rather than run", and the gate
    // that would hold it does not exist yet (#641). That sentence would have been false in the
    // other direction — the same defect, pointed the other way — and a blind review caught it
    // before it shipped.
    //
    // So it says only what is true now and stays true after the gate lands: the turn is
    // unresolved rather than failed, and a resend is a second turn rather than a retry. Asking
    // again remains the owner's call; it is not something this sentence asks for on their
    // behalf, before anyone knows whether the first turn landed.
    return "The CEO session has not answered yet. Its turn is unresolved rather than abandoned — an answer may still be arriving in the conversation. Sending the same message again starts a second turn rather than retrying this one.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_TRANSPORT_FAILED) {
    // Not a timeout: the connection itself closed, or was already gone, rather than this
    // daemon's own clock running out. Same lesson as the sentence above — this seam cannot see
    // whether the turn reached the CEO before the connection dropped, so it does not claim
    // either way, and "ask again" is a new turn rather than advice to retry the old one.
    return "The connection to the CEO session dropped before it answered. Whether this message reached it is not known from here. Sending the same message again starts a new turn rather than retrying this one.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_PEER_FAILED) {
    // This one the seam can say more about than the two above: the turn did reach the CEO
    // session, and it answered with an error instead of a reply. The peer's own error text is
    // not repeated here — it is written by the CEO runtime and may quote whatever it was
    // handling when it failed (see the port's catch block).
    return "The CEO session received this message and its reply failed. Sending the same message again starts a new turn rather than retrying this one.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_BUSY) {
    // Not "send it again", and not a queue. The single-flight port refuses before this turn
    // reaches the canonical session; #631 may add durable ordering later, but #630 must tell the
    // owner only what exists now.
    return "The CEO is still working on the previous message. This one was not started.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_STALE) {
    // This used to fall through to the sentence below, which says the CEO answered. It did not:
    // `ask` refuses a superseded socket before speaking to it at all, and the existing port test
    // asserts the peer received nothing. The owner was being told about an answer that was never
    // requested, on the one occasion when the identity of who answers had just changed.
    return "The CEO role moved to a new session, and the one this route was holding is no longer it. Nothing was asked of either; send the message again.";
  }
  if (reasonCode === ReasonCode.INTERNAL_ERROR) {
    // The port's catch block reaches this only when a rejection is none of the three it
    // classifies (timeout, transport failure, peer error). Falling through to the sentence below
    // would tell the owner the CEO answered, which is exactly the unearned claim this issue
    // exists to remove — an unclassified failure is not an answer.
    return "This message to the CEO session failed in a way that was not recognized. Sending the same message again starts a new turn rather than retrying this one.";
  }
  return "The CEO session answered with something this route cannot deliver as a message.";
};

export interface AgentcpdMainOptions {
  /** Test-only composition override; production calls `main()` without options. */
  config?: ControlPlaneConfig;
  /** Test-only transport/lifecycle seam; production uses the real Bot API and stays alive. */
  telegramStartOptions?: DaemonTelegramStartOptions;
  /** Allows a composition test to inspect the lock-held composition before shutting down. */
  waitForShutdown?: (
    shutdown: (signal: string) => Promise<void>,
    context: AgentcpdMainContext,
  ) => Promise<void>;
}

export interface AgentcpdMainContext {
  cp: ControlPlane;
  daemon: Daemon;
  telegram: TelegramLongPollListener | null;
  /**
   * The live CEO conversation port, exposed for the same reason `telegram` is: a composition
   * test has to be able to stand a peer in front of the surface `main` actually wired, rather
   * than assert against one it built itself.
   */
  ceoConversation: CeoConversationPort | null;
}

/**
 * `agentcpd` — the single local runtime authority (PRD §33.1).
 *
 * Intended to run under a process supervisor (`launchd` on macOS). The daemon owns the
 * single-instance lock, restart reconciliation, the watchdog timer and Buzz delivery.
 */
export const main = async (options: AgentcpdMainOptions = {}): Promise<void> => {
  const config = options.config ?? defaultConfig();
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
  const telegramConfig = configuredTelegramLongPollConfig(config.ownerIdentities ?? []);
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

  let listeners: LocalMcpListeners | null = null;
  let buzzActorIngress: LocalBuzzActorIngress | null = null;
  let buzzMessageIngress: LocalBuzzMessageIngress | null = null;
  let operator: LocalOperatorListener | null = null;
  let hermesBootstrap: HermesBootstrapAuthority | null = null;
  let telegram: TelegramLongPollListener | null = null;
  let startCompleted = false;

  let shuttingDown: Promise<void> | null = null;
  const shutdown = async (signal: string): Promise<void> => {
    // A supervisor that sends SIGTERM twice, or SIGTERM then SIGINT, must not run this twice:
    // the listener handles have no closing guard, and Node rejects a second `server.close()`
    // with ERR_SERVER_NOT_RUNNING — which, through `void shutdown(...)`, is an unhandled
    // rejection during the one operation that most needs to finish.
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
    process.stdout.write(`\nshutting down on ${signal}\n`);
    await telegram?.close();
    await buzzMessageIngress?.close();
    await buzzActorIngress?.close();
    await operator?.close();
    await hermesBootstrap?.close();
    await listeners?.close();
    await sessionLaunch.close();
    await daemon.stop();
    // Before `start()` returns, the control plane is still unwinding it — `daemon.stop()` has
    // released the lock, which is what a supervisor is waiting for, and closing the database
    // out from under that unwind would only turn a clean stop into an error.
    if (startCompleted) cp.close();
    process.exit(0);
    })();
    return shuttingDown;
  };

  // Installed before `start()`, not after. A daemon that parks has not returned from `start()`,
  // and only `daemon.stop()` releases the single-instance lock. Without a handler here a
  // supervisor's SIGTERM is a default kill that leaves the lock file behind, and
  // `install-launchd.sh upgrade` and `rollback` both wait for that file to disappear before
  // they will touch the database — so a parked daemon would fail every deploy on the host this
  // whole change exists for.
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const started = await daemon.start({
    bootstrapDoor: () =>
      startBootstrapOperatorDoor(
        daemon,
        stateDir,
        { token: operatorToken, peerId: `cli:${operatorActor}`, actor: operatorActor },
        { mcpToken },
      ),
  });
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

  startCompleted = true;
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
      // The receiving half of #627. It opens with the binding half because both are the same
      // relay credential, and separately from it because they are different authorities — which
      // is why it needs a second fact the binding half does not: who the owner is. Without a
      // declared buzz owner the relay credential alone would carry owner authority, so the
      // socket stays closed and the operator is told which file to declare it in.
      const buzzMessageOwnerActors = configuredBuzzMessageOwnerActors(config.ownerIdentities ?? []);
      if (buzzMessageOwnerActors.length === 0) {
        process.stdout.write(
          "Buzz message ingress not started: no owner identity with channel \"buzz\" is declared in owner-identities\n",
        );
      } else {
        buzzMessageIngress = await startBuzzMessageIngressListener(cp, stateDir, buzzActorIngressPolicy, {
          ceoConversation: listeners.ceoConversation,
          ownerActors: buzzMessageOwnerActors,
        });
        process.stdout.write("Buzz message ingress started\n");
      }
    }
    if (telegramConfig) {
      const telegramStartOptions = options.telegramStartOptions ?? {};
      const ceoConversation = listeners.ceoConversation;
      const outcome = await startDaemonTelegramListenerOrRefuse(cp, telegramConfig, daemon, {
        // §6.1 — ordinary conversation goes to the CEO. A test that supplies its own handler
        // keeps it; production has none, which is how this route stayed unreachable.
        onDirect: (input) => answerAsCeo(ceoConversation, input.text),
        ...telegramStartOptions,
        onError: (error) => {
          process.stderr.write(`telegram ingress error: ${error instanceof Error ? error.message : String(error)}\n`);
          telegramStartOptions.onError?.(error);
        },
      });
      telegram = outcome.listener;
      if (!outcome.listener) {
        daemon.setTelegramIngressStatus({
          configured: true,
          running: false,
          disabledReason: outcome.disabledReason,
          recoveryNonce: null,
        });
      }
    } else {
      process.stderr.write("Telegram ingress not configured; continuing without Telegram ingress\n");
      daemon.setTelegramIngressStatus({ configured: false, running: false, disabledReason: null });
    }
  } catch (err) {
    await telegram?.close();
    // Both Buzz listeners, which this teardown used to walk past: a startup that failed after
    // one of them bound left its socket file behind for the next daemon to find.
    await buzzMessageIngress?.close();
    await buzzActorIngress?.close();
    await operator?.close();
    await hermesBootstrap?.close();
    await listeners?.close();
    await sessionLaunch.close();
    await daemon.stop();
    cp.close();
    throw err;
  }

  process.stdout.write(`${JSON.stringify({ started: started.value }, null, 2)}\n`);

  const context: AgentcpdMainContext = {
    cp,
    daemon,
    telegram,
    ceoConversation: listeners?.ceoConversation ?? null,
  };

  // Keep the process alive; work arrives through authenticated local MCP sockets or timers.
  if (options.waitForShutdown) {
    await options.waitForShutdown(shutdown, context);
  } else {
    setInterval(() => daemon.writeHealth(null), 30_000).unref();
    await new Promise<void>(() => undefined);
  }
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
