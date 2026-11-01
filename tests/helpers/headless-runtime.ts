import type { Clock } from "../../src/core/clock.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { SessionLaunchCredential } from "../../src/cto/cto-lifecycle.ts";
import type { ProvisionedSessionRuntime, SessionCredentialDelivery } from "../../src/runtime/provisioned-session-runtime.ts";
import type { SessionTurnRequest, SessionTurnResult } from "../../src/runtime/provider.ts";
import { claimLaunchedCredential } from "./mcp-socket.ts";
import type { SessionRegistry } from "../../src/session/session-registry.ts";
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
  /** #1336 — the socket gate a hand-over carries beside the credential, when the door stands in for one that does. */
  readonly token?: string;
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

/** An in-process launch channel for fixtures without sockets. */
export interface InProcessAttestation {
  launch: InProcessLaunchChannel;
}

/** A provider double whose work turns take the same credential that a real relay takes. */
export class HeadlessRuntimeDouble extends TestProductionAdapter {
  readonly turns: SessionTurnRequest[] = [];
  readonly credentials = new Map<string, TakenCredential>();
  /** False: the relay never takes its credential. */
  takeCredential = true;
  /** How many of the next work turns (no challenge) fail as a transient CLI failure would. */
  failNextWorkTurns = 0;
  /** Called for a work turn (no challenge) with what the relay took. */
  onWorkTurn: ((request: SessionTurnRequest, credential: TakenCredential | null) => Promise<void>) | null = null;
  #inProcess: InProcessAttestation | null = null;

  constructor(clock: Clock, provider = "claude") {
    super(clock, provider);
  }

  /** Manual socket fixtures act as this runtime without spending a model turn on readiness. */
  observeCredentialCustody(runtime: ProvisionedSessionRuntime, sessions: SessionRegistry, token: string): this {
    const adopt = runtime.adopt.bind(runtime);
    runtime.adopt = (sessionId, role, secret, epoch) => {
      const result = adopt(sessionId, role, secret, epoch);
      if (result.allowed && sessions.require(sessionId).provider === this.provider) {
        this.credentials.set(sessionId, {
          sessionId, sessionIncarnation: sessions.require(sessionId).incarnation, sessionSecret: secret, token,
        });
      }
      return result;
    };
    return this;
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
    if (request.relay && this.failNextWorkTurns > 0) {
      this.failNextWorkTurns -= 1;
      return failed("transient CLI failure");
    }
    if (request.relay) {
      const taken = this.takeCredential ? await this.#take(request) : null;
      if (taken) this.credentials.set(taken.sessionId, taken);
      if (this.onWorkTurn) await this.onWorkTurn(request, taken);
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
            token: this.#inProcess.launch.token ?? null,
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

}
