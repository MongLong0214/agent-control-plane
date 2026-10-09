import type { Clock } from "../../src/core/clock.ts";
import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { SessionLaunchCredential } from "../../src/cto/cto-lifecycle.ts";
import type { SessionCredentialDelivery } from "../../src/runtime/provisioned-session-runtime.ts";
import type { SessionTurnRequest, SessionTurnResult } from "../../src/runtime/provider.ts";
import type { AttestingPeer } from "../../src/session/session-attestations.ts";
import { callMcpToolOverSocket, claimLaunchedCredential } from "./mcp-socket.ts";
import { TestProductionAdapter } from "./production-adapter.ts";

/** A credential a test runtime took from the launch channel, as the real relay would hold it. */
export interface TakenCredential {
  sessionId: string;
  sessionIncarnation: string;
  sessionSecret: string;
  /** The socket gate, present when the credential came over a real launch socket. */
  token: string | null;
}

/** An in-process stand-in for the daemon's take-once launch channel, with the relay's `take`. */
export interface InProcessLaunchChannel extends SessionCredentialDelivery {
  take(externalSessionId: string): SessionLaunchCredential | null;
  /** How many credentials were offered, for rows that count deliveries. */
  readonly offered: number;
}

export const inProcessLaunchChannel = (): InProcessLaunchChannel => {
  const pending = new Map<string, SessionLaunchCredential>();
  let offered = 0;
  return {
    get offered() {
      return offered;
    },
    prepare: async () => allow(ReasonCode.OK, undefined),
    provision: async (credential) => {
      if (pending.has(credential.externalSessionId)) {
        return deny(ReasonCode.CONFLICT, "a launch credential is already pending for this external session", {});
      }
      offered += 1;
      pending.set(credential.externalSessionId, credential);
      return allow(ReasonCode.OK, undefined);
    },
    withdraw: (externalSessionId) => pending.delete(externalSessionId),
    take: (externalSessionId) => {
      const credential = pending.get(externalSessionId) ?? null;
      pending.delete(externalSessionId);
      return credential;
    },
  };
};

/** How the in-process mode presents an attestation: the same registry the `session_attest` tool calls. */
export interface InProcessAttestation {
  launch: InProcessLaunchChannel;
  attest(peer: AttestingPeer, nonce: string): Decision<void>;
}

const ATTESTATION_NONCE = /nonce set to "([^"]+)"/;

/**
 * #246 C1b — a Claude double that runs a provisioned session's turns the way the real runtime
 * does, minus the model: per turn it takes the session's credential from the launch channel (the
 * relay's job), and when the prompt carries a readiness challenge it presents it through
 * `session_attest` over the CTO MCP socket with that credential (the model's job). With
 * `inProcess`, a fixture that runs no sockets gets the same two steps against an in-process
 * channel and the attestation registry itself.
 *
 * The provider side is still the scripted double's: a session it does not know, or whose next
 * health was set UNAVAILABLE, fails its turn. What it took is kept in `credentials`, by control-plane
 * session id, so a row can act as that session over the socket exactly as its runtime would.
 */
export class HeadlessRuntimeDouble extends TestProductionAdapter {
  readonly turns: SessionTurnRequest[] = [];
  readonly credentials = new Map<string, TakenCredential>();
  /** False: the relay never takes its credential. */
  takeCredential = true;
  /** False: the model never calls `session_attest`. */
  presentAttestation = true;
  /** True: the relay presents the credential it held before this turn, not the one it just took. */
  presentStaleCredential = false;
  /** Called for a work turn (no challenge) with what the relay took. */
  onWorkTurn: ((request: SessionTurnRequest, credential: TakenCredential | null) => Promise<void>) | null = null;
  #inProcess: InProcessAttestation | null = null;

  constructor(clock: Clock, provider = "claude") {
    super(clock, provider);
  }

  useInProcess(attestation: InProcessAttestation): this {
    this.#inProcess = attestation;
    return this;
  }

  async runSessionTurn(request: SessionTurnRequest): Promise<SessionTurnResult> {
    this.turns.push(request);
    const failed = (error: string): SessionTurnResult => ({
      ok: false,
      text: "",
      exitCode: 1,
      error,
      providerSessionId: request.handle.externalSessionId,
      durationMs: 1,
    });
    if ((await this.probeSession(request.handle)) !== "HEALTHY") return failed("No conversation found");
    if (request.relay) {
      const taken = this.takeCredential ? await this.#take(request) : null;
      const previous = taken ? this.credentials.get(taken.sessionId) ?? null : null;
      if (taken) this.credentials.set(taken.sessionId, taken);
      const credential = this.presentStaleCredential && previous ? previous : taken;
      const nonce = ATTESTATION_NONCE.exec(request.prompt)?.[1] ?? null;
      if (nonce !== null) {
        if (credential && this.presentAttestation) await this.#attest(request, credential, nonce);
      } else if (this.onWorkTurn) {
        await this.onWorkTurn(request, credential);
      }
    }
    return {
      ok: true,
      text: "ATTESTED",
      exitCode: 0,
      error: null,
      providerSessionId: request.handle.externalSessionId,
      durationMs: 1,
    };
  }

  async #take(request: SessionTurnRequest): Promise<TakenCredential | null> {
    const externalSessionId = request.handle.externalSessionId;
    if (this.#inProcess) {
      const taken = this.#inProcess.launch.take(externalSessionId);
      return taken
        ? {
            sessionId: taken.sessionId,
            sessionIncarnation: taken.sessionIncarnation,
            sessionSecret: taken.sessionSecret,
            token: null,
          }
        : null;
    }
    try {
      const taken = await claimLaunchedCredential(request.relay!.launchSocketPath, externalSessionId);
      return {
        sessionId: taken.sessionId,
        sessionIncarnation: taken.sessionIncarnation ?? "",
        sessionSecret: taken.sessionSecret,
        token: taken.token ?? null,
      };
    } catch {
      return null;
    }
  }

  async #attest(request: SessionTurnRequest, credential: TakenCredential, nonce: string): Promise<void> {
    if (this.#inProcess) {
      this.#inProcess.attest(
        { sessionId: credential.sessionId, sessionIncarnation: credential.sessionIncarnation, sessionSecret: credential.sessionSecret },
        nonce,
      );
      return;
    }
    await callMcpToolOverSocket(
      request.relay!.mcpSocketPath,
      { token: credential.token ?? "", sessionId: credential.sessionId, sessionSecret: credential.sessionSecret },
      "session_attest",
      { nonce },
    ).catch(() => undefined);
  }
}
