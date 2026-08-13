#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { ControlPlane, defaultConfig } from "../app/control-plane.ts";
import { BuzzAdapter, BuzzCliTransport } from "../buzz/buzz-adapter.ts";
import { type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  BuzzActorIngress,
  IngressGuard,
  type IngressPolicy,
} from "../ingress/ingress-guard.ts";
import { Role, SessionLifecycle, type RoleBinding } from "../domain/types.ts";
import { Daemon } from "./daemon.ts";
import { createCtoMcpPort, createCtoServer } from "../mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../mcp/hermes-server.ts";
import type { AuthenticatedMcpPeer, McpPeerAuthenticator } from "../mcp/shared.ts";

const MAX_MCP_LINE_BYTES = 1024 * 1024;
const DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS = 5_000;

export interface LocalMcpListeners {
  socketPaths: readonly string[];
  close(): Promise<void>;
}

/** Tests shorten the deadline without weakening the daemon's production default. */
export interface LocalMcpListenerOptions {
  handshakeTimeoutMs?: number;
}

/** A daemon-owned local hop from the authenticated Buzz relay to SessionRegistry. */
export interface LocalBuzzActorIngress {
  socketPath: string;
  close(): Promise<void>;
}

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
  const hermesPort = createHermesMcpPort(cp);
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
      (auth) => createCtoServer(ctoPort, auth),
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

const startMcpSocket = async (
  path: string,
  token: string,
  cp: ControlPlane,
  expectedRoles: readonly Role[],
  handshakeTimeoutMs: number,
  factory: (authenticate: McpPeerAuthenticator) => ReturnType<typeof createHermesServer>,
): Promise<Server> => {
  removeStaleSocket(path);
  const server = createServer((socket) => {
    void authenticateSocket(socket, token, handshakeTimeoutMs).then(async (accepted) => {
      if (!accepted) return;
      // One server per authenticated connection: the peer identity belongs to the
      // transport, so it can never be re-declared by a tool argument (§21, §27.3).
      const opening = authenticateSocketPeer(cp, accepted.credential, expectedRoles);
      if (!opening.allowed) {
        endWithDecision(socket, opening);
        return;
      }
      const mcp = factory(peerAuthenticator(cp, accepted.credential, opening.value));
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

interface BoundSocketPeer {
  binding: RoleBinding;
  sessionIncarnation: string;
}

/**
 * The socket name is an authority boundary, not just an API catalogue. Capturing the
 * exact binding here lets request authentication reject a connection after failover.
 */
const authenticateSocketPeer = (
  cp: ControlPlane,
  credential: PeerCredential,
  expectedRoles: readonly Role[],
): Decision<BoundSocketPeer> => {
  const session = cp.sessions.verifySecret(credential.sessionId, credential.sessionSecret);
  if (!session.allowed) return session as Decision<BoundSocketPeer>;
  if (session.value.lifecycle !== SessionLifecycle.READY) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "peer session is not READY", {
      sessionId: credential.sessionId,
      lifecycle: session.value.lifecycle,
    });
  }

  const candidate = cp.bindings
    .bySession(credential.sessionId)
    .find((binding) => binding.status === "ACTIVE" && expectedRoles.includes(binding.role));
  if (!candidate) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "session does not hold this socket's current role", {
      sessionId: credential.sessionId,
      expectedRoles,
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
    binding: authenticated.value,
    sessionIncarnation: session.value.incarnation,
  });
};

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
    if (session.value.lifecycle !== "READY") {
      return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, `peer session is ${session.value.lifecycle}, not READY`, {
        sessionId: credential.sessionId,
      });
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
    return allow(ReasonCode.OK, {
      actor: credential.sessionId,
      sessionId: credential.sessionId,
      sessionIncarnation: opening.sessionIncarnation,
    });
  };

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
  const cp = new ControlPlane(config);
  const mcpToken = process.env["ACP_MCP_TOKEN"];
  if (!mcpToken) throw new Error("ACP_MCP_TOKEN is required for authenticated local MCP sockets");

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
  });

  const daemon = new Daemon(cp, { stateDir, buzz });

  const started = await daemon.start();
  if (!started.allowed) {
    process.stderr.write(`${JSON.stringify(started, null, 2)}\n`);
    process.stderr.write(
      `backoff: ${JSON.stringify(daemon.crashLoopState())}\n`,
    );
    const backoffSeconds = daemon.crashLoopState().backoffSeconds;
    if (backoffSeconds > 0) await waitForBackoff(backoffSeconds);
    cp.close();
    process.exit(1);
  }

  let listeners: LocalMcpListeners | null = null;
  let buzzActorIngress: LocalBuzzActorIngress | null = null;
  try {
    listeners = await startLocalMcpListeners(cp, stateDir, mcpToken);
    if (buzzActorIngressPolicy) {
      buzzActorIngress = await startBuzzActorIngressListener(cp, stateDir, buzzActorIngressPolicy);
    }
  } catch (err) {
    await listeners?.close();
    await daemon.stop();
    cp.close();
    throw err;
  }

  process.stdout.write(`${JSON.stringify({ started: started.value }, null, 2)}\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nshutting down on ${signal}\n`);
    await buzzActorIngress?.close();
    await listeners?.close();
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
