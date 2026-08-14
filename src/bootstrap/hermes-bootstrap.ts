import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";

import type { ControlPlane } from "../app/control-plane.ts";
import { acpError, type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import {
  assertPrivatePath,
  PRIVATE_FILE_MODE,
} from "../db/state-preflight.ts";

const BOOTSTRAP_SOCKET_NAME = "hermes.bootstrap.sock";
const DEFAULT_RUNTIME_TIMEOUT_MS = 30_000;
const BOOTSTRAP_LINE_LIMIT = 64 * 1024;
const PROOF_HEX_LENGTH = 64;
const NONCE_MIN_LENGTH = 16;

export interface HermesBootstrapRequest {
  command: readonly string[];
  model: string;
}

export interface HermesBootstrapResult {
  sessionId: string;
  sessionIncarnation: string;
  bindingGeneration: number;
  runtimePid: number | null;
}

export interface HermesBootstrapAuthorityOptions {
  stateDir: string;
  /** The normal listener is deliberately started after this door closes. */
  mcpSocketPath: string;
  /** A deployment credential, distinct from the operator and bootstrap credentials. */
  mcpToken: string;
  /** The daemon's single-instance fence, checked before and during authority constitution. */
  authorityHeld?: () => boolean;
  runtimeTimeoutMs?: number;
}

export interface HermesBootstrapAuthority {
  bootstrap(input: unknown): Promise<Decision<HermesBootstrapResult>>;
  close(): Promise<void>;
}

interface HermesBootstrapCredential extends HermesBootstrapResult {
  /** This value exists only inside the consumed runtime connection. */
  sessionSecret: string;
}

interface RuntimeProof {
  runtimeNonce: string;
  runtimeProof: string;
}

interface BootstrapDoor {
  socketPath: string;
  /** Read once by the daemon to construct the child environment; never persisted. */
  runtimeToken(): string;
  proofConsumed(): boolean; waitForProof(): Promise<Decision<HermesBootstrapCredential>>;
  close(): Promise<void>;
}

/**
 * The runtime-side proof helper. The bootstrap token is supplied to the launched process in
 * its private environment; only this derived proof crosses the bootstrap socket.
 */
export const hermesBootstrapProof = (token: string, runtimeNonce: string): string =>
  createHmac("sha256", token).update(runtimeNonce, "utf8").digest("hex");

/**
 * Constructs the one-time authority handoff for a clean Hermes installation.
 *
 * This is intentionally separate from the normal MCP listener. The normal listener never
 * receives a weaker authentication rule, and this object has no API that can replace an
 * existing CEO binding.
 */
export const createHermesBootstrapAuthority = (
  cp: ControlPlane,
  options: HermesBootstrapAuthorityOptions,
): HermesBootstrapAuthority => {
  const roleKey = roleKeyFor(Role.CEO);
  const timeoutMs = options.runtimeTimeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Hermes bootstrap runtime timeout must be a positive integer");
  }
  if (options.mcpToken.trim().length === 0) {
    throw new Error("Hermes bootstrap requires the configured MCP deployment credential");
  }

  let closed = false;
  let inFlight: Promise<Decision<HermesBootstrapResult>> | null = null;
  let activeCancel: (() => Promise<void>) | null = null;

  const bootstrap = (input: unknown): Promise<Decision<HermesBootstrapResult>> => {
    const parsed = parseBootstrapRequest(input);
    if (!parsed.allowed) return Promise.resolve(parsed);
    if (closed) {
      return Promise.resolve(deny(ReasonCode.CONFLICT, "Hermes bootstrap authority is closed", {}));
    }
    if (options.authorityHeld && !options.authorityHeld()) {
      return Promise.resolve(deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock is not held for Hermes bootstrap", {}));
    }
    if (inFlight) {
      return Promise.resolve(
        deny(ReasonCode.CONFLICT, "another Hermes bootstrap is already in progress", { roleKey }),
      );
    }

    const existing = cp.bindings.active(roleKey);
    if (existing) {
      return Promise.resolve(
        deny(
          ReasonCode.BINDING_ALREADY_ACTIVE,
          "CEO authority is already active; Hermes bootstrap cannot replace it",
          { roleKey, generation: existing.bindingGeneration },
        ),
      );
    }
    const history = cp.bindings.history(roleKey);
    if (history.length > 0) {
      return Promise.resolve(
        deny(
          ReasonCode.HERMES_BOOTSTRAP_ALREADY_INITIALIZED,
          "CEO authority has already been initialized; use continuity or handoff",
          { roleKey, generations: history.map((binding) => binding.bindingGeneration) },
        ),
      );
    }

    const operation = runBootstrap(parsed.value).finally(() => {
      inFlight = null;
      activeCancel = null;
    });
    inFlight = operation;
    return operation;
  };

  const runBootstrap = async (
    request: HermesBootstrapRequest,
  ): Promise<Decision<HermesBootstrapResult>> => {
    let door: BootstrapDoor | null = null;
    let child: ChildProcess | null = null;
    let succeeded = false;
    try {
      door = await openBootstrapDoor(options.stateDir, async (proof) => {
        if (options.authorityHeld && !options.authorityHeld()) {
          return deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock was lost during Hermes bootstrap", {});
        }
        if (!child || child.exitCode !== null) {
          return deny(
            ReasonCode.HERMES_BOOTSTRAP_RUNTIME_FAILED,
            "Hermes runtime exited before it could become ready",
            {},
          );
        }
        return constituteHermesAuthority(cp, roleKey, request, child, proof, options.authorityHeld);
      });
      activeCancel = door.close;
      if (options.authorityHeld && !options.authorityHeld()) {
        return deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock was lost before Hermes runtime launch", {});
      }
      child = spawnHermesRuntime(
        request.command,
        door.socketPath,
        door.runtimeToken(),
        options,
        options.stateDir,
      );

      const timeout = new Promise<Decision<HermesBootstrapCredential>>((resolveTimeout) => {
        const timer = setTimeout(() => {
          resolveTimeout(
            deny(
              ReasonCode.HERMES_BOOTSTRAP_RUNTIME_FAILED,
              "Hermes runtime did not complete its one-time bootstrap exchange",
              { timeoutMs },
            ),
          );
        }, timeoutMs);
        timer.unref();
      });
      const childFailure = childLifecycleFailure(child, door.proofConsumed);
      const proof = await Promise.race([door.waitForProof(), timeout, childFailure]);
      if (!proof.allowed) return rollbackFailedBootstrap(cp, roleKey, child, proof);

      succeeded = true;
      return allow(ReasonCode.OK, {
        sessionId: proof.value.sessionId,
        sessionIncarnation: proof.value.sessionIncarnation,
        bindingGeneration: proof.value.bindingGeneration,
        runtimePid: proof.value.runtimePid,
      });
    } catch (error) {
      return deny(ReasonCode.HERMES_BOOTSTRAP_RUNTIME_FAILED, "Hermes bootstrap failed", {
        error: safeError(error),
      });
    } finally {
      if (!succeeded) {
        await door?.close();
        stopChild(child);
      }
    }
  };

  return {
    bootstrap,
    close: async () => {
      closed = true;
      await activeCancel?.();
      await inFlight?.catch(() => undefined);
      activeCancel = null;
    },
  };
};

const parseBootstrapRequest = (input: unknown): Decision<HermesBootstrapRequest> => {
  if (!isPlainRecord(input)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "Hermes bootstrap parameters must be an object", {});
  }
  const rawCommand = input["command"];
  if (
    !Array.isArray(rawCommand) ||
    rawCommand.length === 0 ||
    !rawCommand.every(
      (part): part is string => typeof part === "string" && part.length > 0 && !part.includes("\u0000"),
    )
  ) {
    return deny(ReasonCode.INVALID_ARGUMENT, "Hermes bootstrap command must be a non-empty argv array", {});
  }
  const rawModel = input["model"];
  if (rawModel !== undefined && (typeof rawModel !== "string" || rawModel.trim().length === 0)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "Hermes bootstrap model must be a non-empty string", {});
  }
  return allow(ReasonCode.OK, {
    command: rawCommand,
    model: (rawModel as string | undefined)?.trim() || "hermes-runtime",
  });
};

const constituteHermesAuthority = async (
  cp: ControlPlane,
  roleKey: string,
  request: HermesBootstrapRequest,
  child: ChildProcess,
  _proof: RuntimeProof,
  authorityHeld?: () => boolean,
): Promise<Decision<HermesBootstrapCredential>> => {
  if (authorityHeld && !authorityHeld()) {
    return deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock was lost before CEO constitution", {});
  }
  // Recheck immediately before the binding transaction. A different in-process authority
  // must not turn a clean-install proof into a generation-2 or replacement CEO.
  if (cp.bindings.active(roleKey) || cp.bindings.history(roleKey).length > 0) {
    return deny(
      ReasonCode.HERMES_BOOTSTRAP_ALREADY_INITIALIZED,
      "CEO authority was initialized while Hermes bootstrap was completing",
      { roleKey },
    );
  }

  // The managed runtime root, not `process.cwd()`. Under launchd the daemon's cwd is
  // wherever the job happened to start, which is not a routing fact anyone chose — and the
  // workdir immutability trigger makes whatever lands here permanent, so a cwd recorded once
  // could never be corrected. P1-06 moved the CTO and continuity sites; this is the last one.
  const created = cp.sessions.create({
    provider: "hermes",
    model: request.model,
    osPid: child.pid ?? null,
    workdir: cp.config.runtimeRoot ?? join(dirname(cp.config.databasePath), "runtime"),
  });
  if (!created.sessionSecret) {
    return failSession(
      cp,
      created.sessionId,
      ReasonCode.SESSION_SECRET_STORAGE_UNAVAILABLE,
      "Hermes bootstrap cannot proceed without session secret storage",
    );
  }

  const ready = cp.sessions.transition(created.sessionId, SessionLifecycle.READY, "Hermes bootstrap runtime proof");
  if (!ready.allowed) {
    return failSession(cp, created.sessionId, ready.reasonCode, ready.message);
  }

  // Do not treat the lifecycle write as proof by itself. Verify the newly issued secret and
  // the immutable incarnation through the same registry path used by normal MCP.
  const verified = cp.sessions.verifySecret(created.sessionId, created.sessionSecret);
  if (
    !verified.allowed ||
    verified.value.lifecycle !== SessionLifecycle.READY ||
    verified.value.incarnation !== created.incarnation
  ) {
    return failSession(
      cp,
      created.sessionId,
      verified.allowed ? ReasonCode.SESSION_NOT_READY : verified.reasonCode,
      "Hermes bootstrap could not independently verify a READY session",
    );
  }

  const bound = cp.bindings.bind({ role: Role.CEO, roleKey, sessionId: created.sessionId });
  if (!bound.allowed) {
    return failSession(cp, created.sessionId, bound.reasonCode, bound.message);
  }
  if (bound.value.bindingGeneration !== 1) {
    // This is a defense-in-depth refusal. The precheck and the database transaction should
    // make it unreachable; retaining it makes a future generation mistake fail closed.
    void cp.bindings.revoke(roleKey, "Hermes bootstrap did not mint generation 1");
    return failSession(
      cp,
      created.sessionId,
      ReasonCode.HERMES_BOOTSTRAP_ALREADY_INITIALIZED,
      "Hermes bootstrap refused a non-generation-1 CEO binding",
    );
  }

  cp.audit.record({
    kind: "HERMES_BOOTSTRAPPED",
    sessionId: created.sessionId,
    roleKey,
    evidence: {
      generation: bound.value.bindingGeneration,
      model: request.model,
      pid: child.pid ?? null,
    },
  });

  return allow(ReasonCode.OK, {
    sessionId: created.sessionId,
    sessionIncarnation: created.incarnation,
    bindingGeneration: bound.value.bindingGeneration,
    runtimePid: child.pid ?? null,
    sessionSecret: created.sessionSecret,
  });
};

const failSession = (
  cp: ControlPlane,
  sessionId: string,
  reasonCode: ReasonCode,
  message: string,
): Decision<never> => {
  const session = cp.sessions.get(sessionId);
  if (session && session.lifecycle !== SessionLifecycle.STOPPED && session.lifecycle !== SessionLifecycle.ERROR) {
    cp.sessions.transition(sessionId, SessionLifecycle.ERROR, "Hermes bootstrap refused");
  }
  return deny(reasonCode, message, { sessionId });
};

const openBootstrapDoor = async (
  stateDir: string,
  onProof: (proof: RuntimeProof) => Promise<Decision<HermesBootstrapCredential>>,
): Promise<BootstrapDoor> => {
  assertPrivatePath(stateDir, "directory");
  const socketPath = join(stateDir, BOOTSTRAP_SOCKET_NAME);
  removeStaleBootstrapSocket(socketPath);

  let token: string | null = randomBytes(32).toString("base64url");
  let handedOff = false;
  let server: Server | null = null;
  let stopped = false;
  let resolved = false;
  let proofConsumed = false;
  const sockets = new Set<Socket>();
  let resolveProof!: (decision: Decision<HermesBootstrapCredential>) => void;
  const proof = new Promise<Decision<HermesBootstrapCredential>>((resolveDecision) => {
    resolveProof = resolveDecision;
  });

  const stopAccepting = (): void => {
    if (stopped) return;
    stopped = true;
    token = null;
    const active = server;
    server = null;
    if (active) {
      try {
        active.close();
      } catch {
        /* a server that never finished listening has nothing to close */
      }
    }
    if (existsSync(socketPath)) unlinkSync(socketPath);
  };

  const settle = (decision: Decision<HermesBootstrapCredential>): void => {
    if (resolved) return;
    resolved = true;
    resolveProof(decision);
  };

  const candidate = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    serveBootstrapProof(socket, () => token, () => { proofConsumed = true; }, onProof, (decision) => {
      settle(decision);
    }, stopAccepting);
  });
  server = candidate;
  try {
    await listenBootstrapSocket(candidate, socketPath);
  } catch (error) {
    stopAccepting();
    throw error;
  }

  return {
    socketPath,
    runtimeToken: () => {
      if (!token || handedOff) throw new Error("Hermes bootstrap token is no longer available");
      handedOff = true;
      return token;
    },
    proofConsumed: () => proofConsumed,
    waitForProof: () => proof,
    close: async () => {
      stopAccepting();
      for (const socket of sockets) socket.destroy();
      settle(deny(ReasonCode.CONFLICT, "Hermes bootstrap door was closed", { socketPath }));
    },
  };
};

const serveBootstrapProof = (
  socket: Socket,
  readToken: () => string | null,
  markProofConsumed: () => void,
  onProof: (proof: RuntimeProof) => Promise<Decision<HermesBootstrapCredential>>,
  settle: (decision: Decision<HermesBootstrapCredential>) => void,
  stopAccepting: () => void,
): void => {
  let buffer = Buffer.alloc(0);
  let settled = false;
  let responseDecision: Decision<HermesBootstrapCredential> | null = null;
  const timeout = setTimeout(
    () => finishWire(deny(ReasonCode.HERMES_BOOTSTRAP_PROOF_INVALID, "bootstrap proof timed out", {})),
    5_000,
  );
  timeout.unref();

  const finishWire = (decision: Decision<unknown>, settleOverall = false): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    socket.removeListener("data", receive);
    const body = decision.allowed
      ? {
          ok: true,
          reasonCode: decision.reasonCode,
          sessionId: (decision.value as HermesBootstrapCredential).sessionId,
          sessionIncarnation: (decision.value as HermesBootstrapCredential).sessionIncarnation,
          bindingGeneration: (decision.value as HermesBootstrapCredential).bindingGeneration,
          runtimePid: (decision.value as HermesBootstrapCredential).runtimePid,
          // This is the only write of the session secret outside SessionRegistry.create.
          sessionSecret: (decision.value as HermesBootstrapCredential).sessionSecret,
        }
      : {
          ok: false,
          reasonCode: decision.reasonCode,
          message: decision.message,
          evidence: decision.evidence,
    };
    if (settleOverall) {
      responseDecision = decision as Decision<HermesBootstrapCredential>;
      // `end` merely puts the credential into the kernel's socket buffer. Wait until the
      // runtime completes its side of this one-time exchange before exposing a successful
      // bootstrap result; otherwise a caller can observe success before the runtime has
      // consumed the secret it was given.
      socket.once("close", (hadError) => {
        const completed = responseDecision;
        if (!completed) return;
        settle(hadError
          ? deny(ReasonCode.HERMES_BOOTSTRAP_RUNTIME_FAILED, "runtime disconnected during bootstrap credential delivery", {})
          : completed);
      });
    }
    socket.end(`${JSON.stringify(body)}\n`);
  };

  const refuse = (reasonCode: typeof ReasonCode.HERMES_BOOTSTRAP_PROOF_INVALID, message: string): void =>
    finishWire(deny(reasonCode, message, {}));

  const receive = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > BOOTSTRAP_LINE_LIMIT) return refuse(ReasonCode.HERMES_BOOTSTRAP_PROOF_INVALID, "bootstrap proof is too large");
    const boundary = buffer.indexOf(0x0a);
    if (boundary === -1) return;
    if (buffer.subarray(boundary + 1).length > 0) {
      return refuse(ReasonCode.HERMES_BOOTSTRAP_PROOF_INVALID, "bootstrap socket accepts one proof per connection");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, boundary).toString("utf8")) as unknown;
    } catch {
      return refuse(ReasonCode.HERMES_BOOTSTRAP_PROOF_INVALID, "bootstrap proof is not JSON");
    }
    const proof = parseRuntimeProof(parsed);
    const token = readToken();
    if (!proof || !token || !proofMatches(token, proof)) {
      return refuse(ReasonCode.HERMES_BOOTSTRAP_PROOF_INVALID, "runtime possession proof was refused");
    }
    markProofConsumed();

    // Consume the opaque token and close the listening path before constituting authority.
    // The connected socket remains available for the one response below.
    stopAccepting();
    void onProof(proof)
      .then((decision) => finishWire(decision, true))
      .catch(() => finishWire(deny(ReasonCode.HERMES_BOOTSTRAP_RUNTIME_FAILED, "runtime proof handling failed", {}), true));
  };
  socket.on("data", receive);
  socket.once("error", () => {
    if (responseDecision) {
      settle(deny(ReasonCode.HERMES_BOOTSTRAP_RUNTIME_FAILED, "runtime disconnected during bootstrap credential delivery", {}));
      return;
    }
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      socket.removeListener("data", receive);
      settle(deny(ReasonCode.HERMES_BOOTSTRAP_RUNTIME_FAILED, "runtime disconnected during bootstrap", {}));
    }
  });
};

const parseRuntimeProof = (value: unknown): RuntimeProof | null => {
  if (!isPlainRecord(value)) return null;
  const runtimeNonce = value["runtimeNonce"];
  const runtimeProof = value["runtimeProof"];
  if (
    typeof runtimeNonce !== "string" ||
    runtimeNonce.length < NONCE_MIN_LENGTH ||
    runtimeNonce.length > 256 ||
    typeof runtimeProof !== "string" ||
    runtimeProof.length !== PROOF_HEX_LENGTH ||
    !/^[a-f0-9]+$/.test(runtimeProof)
  ) return null;
  return { runtimeNonce, runtimeProof };
};

const proofMatches = (token: string, proof: RuntimeProof): boolean => {
  const expected = Buffer.from(hermesBootstrapProof(token, proof.runtimeNonce), "hex");
  const actual = Buffer.from(proof.runtimeProof, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const spawnHermesRuntime = (
  command: readonly string[],
  socketPath: string,
  token: string,
  options: HermesBootstrapAuthorityOptions,
  stateDir: string,
): ChildProcess => {
  // The token is never a command-line argument. It is available only in the child process's
  // private environment, while the session secret is sent later over the consumed socket.
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? stateDir,
    ...(process.env["USER"] ? { USER: process.env["USER"] } : {}),
    ...(process.env["LOGNAME"] ? { LOGNAME: process.env["LOGNAME"] } : {}),
    TMPDIR: process.env["TMPDIR"] ?? stateDir,
    LANG: process.env["LANG"] ?? "C.UTF-8",
    LC_ALL: process.env["LC_ALL"] ?? "C",
    ACP_HERMES_BOOTSTRAP_SOCKET: socketPath,
    ACP_HERMES_BOOTSTRAP_TOKEN: token,
    ACP_HERMES_MCP_SOCKET: options.mcpSocketPath,
    ACP_MCP_TOKEN: options.mcpToken,
  };
  const child = spawn(command[0]!, command.slice(1), {
    // The daemon's state root, not `process.cwd()`. Under launchd the cwd is wherever the job
    // happened to start — often `/`, sometimes a checkout nobody chose — and it becomes the
    // CEO runtime's working directory for the life of the process. Recording the managed
    // workdir while spawning into an arbitrary one describes a placement that never happened.
    cwd: stateDir,
    env: environment,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return child;
};

const childLifecycleFailure = (
  child: ChildProcess,
  proofConsumed: () => boolean,
): Promise<Decision<HermesBootstrapCredential>> =>
  new Promise((resolveFailure) => {
    child.once("error", (error) => {
      if (proofConsumed()) return;
      resolveFailure(
        deny(ReasonCode.HERMES_BOOTSTRAP_RUNTIME_FAILED, "could not launch the Hermes runtime", {
          error: safeError(error),
        }),
      );
    });
    child.once("exit", (code, signal) => {
      if (proofConsumed()) return;
      resolveFailure(
        deny(ReasonCode.HERMES_BOOTSTRAP_RUNTIME_FAILED, "Hermes runtime exited before bootstrap proof", {
          code,
          signal,
        }),
      );
    });
  });

const stopChild = (child: ChildProcess | null): void => {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* the child may have exited between the check and the signal */
  }
};

/** A failed response completion must not leave the newly minted CEO binding live. */
const rollbackFailedBootstrap = <T>(
  cp: ControlPlane,
  roleKey: string,
  child: ChildProcess | null,
  failure: Decision<T>,
): Decision<T> => {
  if (!child?.pid) return failure;
  const binding = cp.bindings.active(roleKey);
  const session = binding ? cp.sessions.get(binding.sessionId) : null;
  // Bootstrap prechecks make an active CEO from another process impossible here. Keep
  // this tuple check nevertheless so a future concurrency change cannot revoke it.
  if (!binding || !session || session.osPid !== child.pid) return failure;
  const revoked = cp.bindings.revoke(roleKey, "Hermes bootstrap credential delivery failed");
  if (revoked.allowed && session.lifecycle === SessionLifecycle.READY) {
    cp.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "Hermes bootstrap credential delivery failed");
  }
  return failure;
};

const listenBootstrapSocket = (server: Server, socketPath: string): Promise<void> =>
  new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.removeListener("error", onError);
      try {
        chmodSync(socketPath, PRIVATE_FILE_MODE);
        assertOwnerOnlySocket(socketPath);
        resolveListen();
      } catch (error) {
        try { server.close(); } catch { /* the listener may already be closed */ }
        rejectListen(error);
      }
    });
  });

const removeStaleBootstrapSocket = (socketPath: string): void => {
  try {
    lstatSync(socketPath);
  } catch {
    return;
  }
  assertOwnerOnlySocket(socketPath);
  unlinkSync(socketPath);
};

const assertOwnerOnlySocket = (socketPath: string): void => {
  let stat: Stats;
  try {
    stat = lstatSync(socketPath);
  } catch (error) {
    throw acpError(
      ReasonCode.STATE_PATH_INSECURE,
      `could not inspect Hermes bootstrap socket: ${safeError(error)}`,
      { path: socketPath },
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isSocket() || (stat.mode & 0o777) !== PRIVATE_FILE_MODE || uid === null || stat.uid !== uid) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "refusing an insecure Hermes bootstrap socket path", {
      path: socketPath,
      mode: stat.mode & 0o777,
      ownerUid: stat.uid,
      currentUid: uid,
    });
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const safeError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]/g, " ").slice(0, 300);
